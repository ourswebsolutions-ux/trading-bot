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


def _live_order(_: Dict[str, Any]) -> Dict[str, Any]:
    raise RpcError("live_trading_disabled", "Live trading is disabled in this release.")


METHODS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "health": _health,
    "strategy_types": _strategy_types,
    "validate_strategy": _validate,
    "backtest": _backtest,
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
