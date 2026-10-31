"""JSON-lines RPC for the MetaTrader 5 bridge (same framing as the trading engine).

Request:  {"id": 1, "method": "connect", "params": {...}}
Response: {"id": 1, "result": ...}  or  {"id": 1, "error": {"code": "...", "message": "..."}}
Nothing but responses is written to stdout. Request parameters are never logged (they can
contain the account password).
"""

from __future__ import annotations

import json
import sys
from typing import Any, Callable, Dict

from .bridge import BridgeError, Mt5Bridge


def load_mt5():
    """The official package (Windows only). Returns None with the reason when unavailable."""
    try:
        import MetaTrader5 as mt5  # type: ignore

        return mt5, None
    except Exception as e:  # ImportError on non-Windows, or a broken install
        return None, f"The MetaTrader5 Python package is not available ({type(e).__name__}: {e}). It requires Windows."


class Server:
    def __init__(self, bridge: Mt5Bridge | None, unavailable: str | None = None):
        self.bridge = bridge
        self.unavailable = unavailable
        names = ["health", "connect", "shutdown", "account", "terminal", "symbols", "symbol_info", "ticks", "rates", "order_check", "order_send", "positions", "orders", "history_orders", "history_deals", "constants"]
        self.methods: Dict[str, Callable[[Dict[str, Any]], Any]] = {n: getattr(bridge, n) for n in names} if bridge else {}

    def handle(self, msg: Dict[str, Any]) -> Dict[str, Any]:
        rid = msg.get("id")
        method = msg.get("method")
        if self.bridge is None:
            if method == "health":
                return {"id": rid, "result": {"package": "MetaTrader5", "packageVersion": None, "connected": False, "unavailable": self.unavailable}}
            return {"id": rid, "error": {"code": "unavailable", "message": self.unavailable}}
        fn = self.methods.get(str(method))
        if fn is None:
            return {"id": rid, "error": {"code": "unknown_method", "message": f"Unknown method {method!r}"}}
        try:
            return {"id": rid, "result": fn(msg.get("params") or {})}
        except BridgeError as e:
            return {"id": rid, "error": {"code": e.code, "message": e.message, "data": e.data}}
        except Exception as e:  # unexpected: report the type only, never the parameters
            print(f"mt5 bridge: {method} failed with {type(e).__name__}", file=sys.stderr, flush=True)
            return {"id": rid, "error": {"code": "internal", "message": f"{type(e).__name__}: {e}"}}


def serve(mt5: Any = None) -> None:
    unavailable = None
    if mt5 is None:
        mt5, unavailable = load_mt5()
    server = Server(Mt5Bridge(mt5) if mt5 is not None else None, unavailable)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        sys.stdout.write(json.dumps(server.handle(msg)) + "\n")
        sys.stdout.flush()
    if server.bridge is not None:
        try:
            server.bridge.shutdown({})
        except Exception:
            pass
