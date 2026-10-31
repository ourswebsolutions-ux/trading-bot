"""Thin, side-effect-explicit wrapper around MetaQuotes' official ``MetaTrader5`` package.

Each method maps one JSON request to one MT5 call and returns plain JSON data. Business logic
(sizing, risk checks, retcode interpretation, reconciliation) lives in the desktop app, which is
tested against a fake. This process holds the MT5 login only in the terminal connection; it never
writes credentials or request parameters anywhere.

Times are returned exactly as MT5 reports them: broker *server* time in seconds. The desktop app
converts them to UTC with an offset estimated from live ticks.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional


class BridgeError(Exception):
    def __init__(self, code: str, message: str, data: Any = None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


TIMEFRAMES = {"1m": "TIMEFRAME_M1", "5m": "TIMEFRAME_M5", "15m": "TIMEFRAME_M15", "30m": "TIMEFRAME_M30", "1h": "TIMEFRAME_H1", "4h": "TIMEFRAME_H4", "1d": "TIMEFRAME_D1"}
# "sltp" changes the stop-loss / take-profit of an open position (by its ticket)
ACTIONS = {"deal": "TRADE_ACTION_DEAL", "remove": "TRADE_ACTION_REMOVE", "sltp": "TRADE_ACTION_SLTP"}
ORDER_TYPES = {"buy": "ORDER_TYPE_BUY", "sell": "ORDER_TYPE_SELL"}
FILLINGS = {"fok": "ORDER_FILLING_FOK", "ioc": "ORDER_FILLING_IOC", "return": "ORDER_FILLING_RETURN"}
MAX_BARS = 20_000


def _row(nt: Any) -> Dict[str, Any]:
    """namedtuple → dict with JSON-safe values."""
    out: Dict[str, Any] = {}
    for k, v in nt._asdict().items():
        if isinstance(v, float) and not math.isfinite(v):
            v = None
        elif hasattr(v, "_asdict"):
            v = _row(v)
        elif not isinstance(v, (int, float, str, bool, type(None))):
            v = str(v)
        out[k] = v
    return out


class Mt5Bridge:
    def __init__(self, mt5: Any):
        self.mt5 = mt5
        self.connected = False

    # ---------- helpers ----------
    def _const(self, name: str) -> int:
        value = getattr(self.mt5, name, None)
        if value is None:
            raise BridgeError("unsupported", f"This MetaTrader5 package has no {name}")
        return value

    def _fail(self, code: str, what: str) -> BridgeError:
        err = self.mt5.last_error() if hasattr(self.mt5, "last_error") else None
        detail = f"{err[1]} ({err[0]})" if isinstance(err, tuple) and len(err) >= 2 else "no details"
        return BridgeError(code, f"{what}: {detail}", {"lastError": list(err) if isinstance(err, tuple) else None})

    def _require(self) -> None:
        if not self.connected:
            raise BridgeError("not_connected", "Not connected to the MetaTrader 5 terminal. Connect first.")

    # ---------- session ----------
    def health(self, _: Dict[str, Any]) -> Dict[str, Any]:
        version = None
        try:
            version = getattr(self.mt5, "__version__", None)
        except Exception:  # pragma: no cover - defensive
            pass
        return {"package": "MetaTrader5", "packageVersion": version, "connected": self.connected}

    def connect(self, p: Dict[str, Any]) -> Dict[str, Any]:
        try:
            login = int(p.get("login"))
        except (TypeError, ValueError):
            raise BridgeError("invalid_request", "The MT5 login must be the account number.")
        server = str(p.get("server") or "").strip()
        password = p.get("password")
        if not server or not isinstance(password, str) or not password:
            raise BridgeError("invalid_request", "Server and password are required.")
        kwargs: Dict[str, Any] = {"login": login, "password": password, "server": server, "timeout": int(p.get("timeoutMs") or 60_000)}
        if p.get("path"):
            kwargs["path"] = str(p["path"])
        ok = self.mt5.initialize(**kwargs)
        password = None  # noqa: F841 - drop the reference as soon as it is used
        kwargs.pop("password", None)
        if not ok:
            self.connected = False
            raise self._fail("connect_failed", "Could not connect to the MetaTrader 5 terminal or log in")
        self.connected = True
        return {"account": self.account({}), "terminal": self.terminal({})}

    def shutdown(self, _: Dict[str, Any]) -> Dict[str, Any]:
        if self.connected:
            self.mt5.shutdown()
        self.connected = False
        return {"ok": True}

    def account(self, _: Dict[str, Any]) -> Dict[str, Any]:
        self._require()
        info = self.mt5.account_info()
        if info is None:
            raise self._fail("unavailable", "Account information is unavailable")
        return _row(info)

    def terminal(self, _: Dict[str, Any]) -> Dict[str, Any]:
        self._require()
        info = self.mt5.terminal_info()
        if info is None:
            raise self._fail("unavailable", "Terminal information is unavailable")
        return _row(info)

    # ---------- market data ----------
    def symbols(self, p: Dict[str, Any]) -> List[Dict[str, Any]]:
        self._require()
        group = p.get("group")
        rows = self.mt5.symbols_get(group=group) if group else self.mt5.symbols_get()
        if rows is None:
            raise self._fail("unavailable", "Symbol list is unavailable")
        return [_row(r) for r in rows]

    def symbol_info(self, p: Dict[str, Any]) -> Dict[str, Any]:
        self._require()
        symbol = str(p.get("symbol") or "")
        # tick value and quotes are only maintained for symbols in Market Watch
        if not self.mt5.symbol_select(symbol, True):
            raise self._fail("unknown_symbol", f"{symbol} is not available at this broker")
        info = self.mt5.symbol_info(symbol)
        if info is None:
            raise self._fail("unknown_symbol", f"{symbol} is not available at this broker")
        return _row(info)

    def ticks(self, p: Dict[str, Any]) -> Dict[str, Any]:
        self._require()
        out: Dict[str, Any] = {}
        for symbol in (p.get("symbols") or [])[:50]:
            symbol = str(symbol)
            self.mt5.symbol_select(symbol, True)
            t = self.mt5.symbol_info_tick(symbol)
            out[symbol] = _row(t) if t is not None else None
        return out

    def rates(self, p: Dict[str, Any]) -> List[Dict[str, Any]]:
        self._require()
        symbol = str(p.get("symbol") or "")
        tf = TIMEFRAMES.get(str(p.get("timeframe")))
        if not tf:
            raise BridgeError("invalid_request", f"Unsupported timeframe {p.get('timeframe')!r}")
        count = max(1, min(int(p.get("count") or 500), MAX_BARS))
        self.mt5.symbol_select(symbol, True)
        rates = self.mt5.copy_rates_from_pos(symbol, self._const(tf), 0, count)
        if rates is None:
            raise self._fail("unavailable", f"No price history for {symbol}")
        names = getattr(getattr(rates, "dtype", None), "names", None) or ("time", "open", "high", "low", "close", "tick_volume", "spread", "real_volume")
        rows = []
        for r in rates:
            row = {n: (r[n] if not hasattr(r, "_asdict") else getattr(r, n)) for n in names}
            rows.append({k: (int(v) if k in ("time", "tick_volume", "spread", "real_volume") else float(v)) for k, v in row.items()})
        return rows

    # ---------- trading ----------
    def _request(self, p: Dict[str, Any]) -> Dict[str, Any]:
        req = dict(p.get("request") or {})
        out: Dict[str, Any] = {}
        if req.get("action") not in ACTIONS:
            raise BridgeError("invalid_request", "Unsupported trade action")
        out["action"] = self._const(ACTIONS[req["action"]])
        for key in ("symbol", "comment"):
            if req.get(key) is not None:
                out[key] = str(req[key])[:31] if key == "comment" else str(req[key])
        for key in ("volume", "price", "sl", "tp"):
            if req.get(key) is not None:
                out[key] = float(req[key])
        for key in ("deviation", "magic", "position", "order"):
            if req.get(key) is not None:
                out[key] = int(req[key])
        if req.get("type") is not None:
            out["type"] = self._const(ORDER_TYPES[req["type"]])
        if req.get("filling") is not None:
            out["type_filling"] = self._const(FILLINGS[req["filling"]])
        if out["action"] == self._const("TRADE_ACTION_DEAL"):
            out["type_time"] = self._const("ORDER_TIME_GTC")
        return out

    def order_check(self, p: Dict[str, Any]) -> Dict[str, Any]:
        self._require()
        res = self.mt5.order_check(self._request(p))
        if res is None:
            raise self._fail("rejected", "Order check failed")
        return _row(res)

    def order_send(self, p: Dict[str, Any]) -> Dict[str, Any]:
        """Sends exactly once. Never retried here: an unclear outcome is resolved by the app's
        reconciliation (history by magic number and comment), not by sending again."""
        self._require()
        res = self.mt5.order_send(self._request(p))
        if res is None:
            raise self._fail("send_failed", "The terminal did not accept the order request")
        return _row(res)

    def positions(self, p: Dict[str, Any]) -> List[Dict[str, Any]]:
        self._require()
        if p.get("ticket") is not None:
            rows = self.mt5.positions_get(ticket=int(p["ticket"]))
        elif p.get("symbol"):
            rows = self.mt5.positions_get(symbol=str(p["symbol"]))
        else:
            rows = self.mt5.positions_get()
        rows = rows or ()
        magic = p.get("magic")
        return [_row(r) for r in rows if magic is None or getattr(r, "magic", None) == int(magic)]

    def orders(self, p: Dict[str, Any]) -> List[Dict[str, Any]]:
        self._require()
        rows = (self.mt5.orders_get(symbol=str(p["symbol"])) if p.get("symbol") else self.mt5.orders_get()) or ()
        magic = p.get("magic")
        return [_row(r) for r in rows if magic is None or getattr(r, "magic", None) == int(magic)]

    def _range(self, p: Dict[str, Any]):
        # history ranges are interpreted in terminal time; widen by two days and let the app filter
        start = datetime.fromtimestamp(max(0, float(p.get("fromServerSec") or 0)), tz=timezone.utc) - timedelta(days=2)
        end = datetime.fromtimestamp(float(p.get("toServerSec") or datetime.now(tz=timezone.utc).timestamp()), tz=timezone.utc) + timedelta(days=2)
        return start, end

    def history_orders(self, p: Dict[str, Any]) -> List[Dict[str, Any]]:
        self._require()
        if p.get("ticket") is not None:
            rows = self.mt5.history_orders_get(ticket=int(p["ticket"]))
        else:
            start, end = self._range(p)
            rows = self.mt5.history_orders_get(start, end)
        rows = rows or ()
        magic = p.get("magic")
        return [_row(r) for r in rows if magic is None or getattr(r, "magic", None) == int(magic)]

    def history_deals(self, p: Dict[str, Any]) -> List[Dict[str, Any]]:
        self._require()
        if p.get("ticket") is not None:
            rows = self.mt5.history_deals_get(ticket=int(p["ticket"]))
        elif p.get("position") is not None:
            rows = self.mt5.history_deals_get(position=int(p["position"]))
        else:
            start, end = self._range(p)
            rows = self.mt5.history_deals_get(start, end)
        rows = rows or ()
        magic = p.get("magic")
        return [_row(r) for r in rows if magic is None or getattr(r, "magic", None) == int(magic)]

    def constants(self, _: Dict[str, Any]) -> Dict[str, Optional[int]]:
        """Numeric values the app needs to interpret results (enums can differ between package builds)."""
        names = [
            "TRADE_RETCODE_DONE", "TRADE_RETCODE_DONE_PARTIAL", "TRADE_RETCODE_PLACED",
            "DEAL_ENTRY_IN", "DEAL_ENTRY_OUT", "DEAL_ENTRY_INOUT", "DEAL_ENTRY_OUT_BY", "DEAL_TYPE_BUY", "DEAL_TYPE_SELL",
            "POSITION_TYPE_BUY", "POSITION_TYPE_SELL", "ORDER_TYPE_BUY", "ORDER_TYPE_SELL",
            "ORDER_STATE_FILLED", "ORDER_STATE_PARTIAL", "ORDER_STATE_CANCELED", "ORDER_STATE_REJECTED", "ORDER_STATE_EXPIRED", "ORDER_STATE_STARTED", "ORDER_STATE_PLACED",
            "ACCOUNT_TRADE_MODE_DEMO", "ACCOUNT_TRADE_MODE_CONTEST", "ACCOUNT_TRADE_MODE_REAL",
            "ACCOUNT_MARGIN_MODE_RETAIL_NETTING", "ACCOUNT_MARGIN_MODE_EXCHANGE", "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING",
            "SYMBOL_TRADE_MODE_DISABLED", "SYMBOL_TRADE_MODE_LONGONLY", "SYMBOL_TRADE_MODE_SHORTONLY", "SYMBOL_TRADE_MODE_CLOSEONLY", "SYMBOL_TRADE_MODE_FULL",
            "SYMBOL_FILLING_FOK", "SYMBOL_FILLING_IOC",
        ]
        return {n: getattr(self.mt5, n, None) for n in names}
