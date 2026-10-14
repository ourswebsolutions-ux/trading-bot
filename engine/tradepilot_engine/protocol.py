"""JSON-lines RPC over stdin/stdout used by the Electron main process.

Request:  {"id": 1, "method": "backtest", "params": {...}}
Response: {"id": 1, "result": {...}}  or  {"id": 1, "error": {"code": "...", "message": "...", "data": {...}}}
Nothing else is ever written to stdout; diagnostics go to stderr.
"""

from __future__ import annotations

import json
import platform
import sys
from typing import Any, Callable, Dict

from . import LIVE_TRADING_ENABLED, __version__
from .backtest import BacktestError, run_backtest
from .rules import RuleError, run_rules_backtest
from .live import LiveError, evaluate_session, protective_levels
from .strategies import RISK_LIMITS, STRATEGY_TYPES, ValidationError, validate


class RpcError(Exception):
    def __init__(self, code: str, message: str, data: Any = None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


def _health(_: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "engineVersion": __version__,
        "python": platform.python_version(),
        "liveTradingEnabled": LIVE_TRADING_ENABLED,
    }


def _strategy_types(_: Dict[str, Any]) -> Dict[str, Any]:
    fmt = lambda spec: {k: {"min": lo, "max": hi, "default": d} for k, (lo, hi, d) in spec.items()}
    return {"types": {t: fmt(p) for t, p in STRATEGY_TYPES.items()}, "risk": fmt(RISK_LIMITS)}


def _validate(params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        spec = validate(params.get("strategy") or {})
    except ValidationError as e:
        return {"valid": False, "errors": e.errors}
    return {"valid": True, "normalized": {"type": spec.type, "params": spec.params, "risk": spec.risk, "allowShort": spec.allow_short}}


def _backtest(params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        spec = validate(params.get("strategy") or {})
        return run_backtest(spec, params.get("candles") or [], float(params.get("initialEquity", 10_000)))
    except ValidationError as e:
        raise RpcError("invalid_strategy", str(e), e.errors)
    except BacktestError as e:
        raise RpcError("invalid_data", str(e))


def _backtest_rules(params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        fee = params.get("feeBps")
        return run_rules_backtest(
            params.get("definition") or {},
            params.get("candles") or [],
            float(params.get("initialEquity", 10_000)),
            fee_bps=None if fee is None else float(fee),
            slippage_bps=float(params.get("slippageBps") or 0),
        )
    except RuleError as e:
        raise RpcError("invalid_strategy", str(e))
    except BacktestError as e:
        raise RpcError("invalid_data", str(e))


def _session_evaluate(params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return evaluate_session(params)
    except (LiveError, RuleError) as e:
        raise RpcError("invalid_session", str(e))
    except BacktestError as e:
        raise RpcError("invalid_data", str(e))


def _protective_levels(params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        side = 1 if params.get("side") == "long" else -1
        return protective_levels(params["definition"], side, float(params["entryPrice"]), params.get("candles") or [], float(params.get("tickSize") or 0))
    except (LiveError, KeyError, ValueError) as e:
        raise RpcError("invalid_request", str(e))


def _live_order(_: Dict[str, Any]) -> Dict[str, Any]:
    raise RpcError("live_trading_disabled", "Live trading is disabled in this release.")


METHODS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "health": _health,
    "strategy_types": _strategy_types,
    "validate_strategy": _validate,
    "backtest": _backtest,
    "backtest_rules": _backtest_rules,
    "session_evaluate": _session_evaluate,
    "protective_levels": _protective_levels,
    "place_live_order": _live_order,
}


def handle(message: Dict[str, Any]) -> Dict[str, Any]:
    req_id = message.get("id")
    method = message.get("method")
    try:
        if method not in METHODS:
            raise RpcError("unknown_method", f"unknown method {method!r}")
        params = message.get("params") or {}
        if not isinstance(params, dict):
            raise RpcError("invalid_params", "params must be an object")
        return {"id": req_id, "result": METHODS[method](params)}
    except RpcError as e:
        return {"id": req_id, "error": {"code": e.code, "message": e.message, "data": e.data}}
    except Exception as e:  # never crash the loop on one bad request
        print(f"engine error in {method}: {e!r}", file=sys.stderr, flush=True)
        return {"id": req_id, "error": {"code": "internal", "message": "engine internal error"}}


def serve(stdin=sys.stdin, stdout=sys.stdout) -> None:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("request must be an object")
        except ValueError as e:
            response = {"id": None, "error": {"code": "parse_error", "message": str(e)}}
        else:
            response = handle(message)
        stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        stdout.flush()
