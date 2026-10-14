"""Deterministic live decision engine (Phase 4).

Given a saved, user-approved strategy definition, the most recent CLOSED candles and the
current session/account state, decide what (if anything) to do on this candle. The engine
never talks to the exchange and never sees credentials: the desktop app executes the
returned intent after its own independent checks.

Every decision is re-validated here: strategy structure, risk settings, daily limits,
account limits, exposure, contract sizing. Nothing in a strategy definition or an AI
response can bypass these checks.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from .backtest import _candles
from .rules import ATR_PERIOD_FOR_STOPS, Evaluator, RuleError, atr, check_definition, daily_loss_reached, sizing_base

RISK_KEYS = ("maxExposurePct", "maxOpenPositions", "accountMaxDailyLossPct", "maxOrderNotionalUsd")


class LiveError(ValueError):
    pass


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def check_risk(risk: Dict[str, Any]) -> None:
    if not isinstance(risk, dict) or not risk.get("configured"):
        raise LiveError("account risk settings are not configured")
    for k in RISK_KEYS:
        if not _num(risk.get(k)) or risk[k] <= 0:
            raise LiveError(f"risk setting {k} must be a positive number")
    if risk["maxExposurePct"] > 1000:
        raise LiveError("maxExposurePct is out of range")


def round_to_tick(price: float, tick: float, mode: str = "nearest") -> float:
    if not tick or tick <= 0:
        return price
    steps = price / tick
    steps = math.floor(steps + 1e-9) if mode == "down" else math.ceil(steps - 1e-9) if mode == "up" else round(steps)
    decimals = max(0, -int(math.floor(math.log10(tick)))) if tick < 1 else 0
    return round(steps * tick, decimals + 2)


def protective_levels(definition: Dict[str, Any], side: int, entry_price: float, candles: List[Dict[str, Any]], tick: float) -> Dict[str, Optional[float]]:
    """Stop-loss / take-profit prices for a position, from the strategy's risk rules."""
    risk = definition["risk"]
    stop = risk["stopLoss"]
    if stop["type"] == "percent":
        dist = entry_price * stop["value"] / 100
    elif stop["type"] == "points":
        dist = float(stop["value"])
    else:
        c = _candles(candles)
        a = atr(c["high"], c["low"], c["close"], ATR_PERIOD_FOR_STOPS)[-1]
        if a is None:
            raise LiveError("not enough candles to compute ATR for the stop-loss")
        dist = a * stop["value"]
    if dist <= 0 or (side == 1 and dist >= entry_price):
        raise LiveError("stop-loss distance is invalid for this price")
    # round protective prices away from entry for the stop (never tighter than configured)
    stop_price = round_to_tick(entry_price - side * dist, tick, "down" if side == 1 else "up")
    take_price = None
    tp = risk.get("takeProfit")
    if tp:
        tdist = entry_price * tp["value"] / 100 if tp["type"] == "percent" else float(tp["value"]) if tp["type"] == "points" else dist * tp["value"]
        take_price = round_to_tick(entry_price + side * tdist, tick, "nearest")
    return {"stopPrice": stop_price, "takePrice": take_price, "stopDistance": dist}


def _size_contracts(definition, side, price, stop_dist, equity, contract_value) -> (int, str):
    sizing = definition["risk"]["sizing"]
    equity = sizing_base(definition["risk"], equity)
    if sizing["type"] == "percent_equity":
        qty = equity * sizing["value"] / 100 / price
    elif sizing["type"] == "risk_percent":
        qty = equity * sizing["value"] / 100 / stop_dist
    else:
        qty = float(sizing["value"])
    if not math.isfinite(qty) or qty <= 0:
        return 0, "position size computed as zero"
    contracts = int(math.floor(qty / contract_value + 1e-9))
    if contracts < 1:
        return 0, f"position size {qty:.6g} is below one contract ({contract_value})"
    return contracts, ""


def evaluate_session(p: Dict[str, Any]) -> Dict[str, Any]:
    """Decide on the latest closed candle. Returns an intent plus the reasons for any block."""
    d = p.get("definition") or {}
    try:
        check_definition(d)
    except RuleError as e:
        raise LiveError(f"strategy is not valid: {e}")
    risk = p.get("risk") or {}
    check_risk(risk)
    raw = p.get("candles") or []
    if len(raw) < 30:
        raise LiveError("at least 30 closed candles are required")
    c = _candles(raw)
    i = len(c["close"]) - 1
    candle_time = c["time"][i]
    session = p.get("session") or {}
    account = p.get("account") or {}
    inst = p.get("instrument") or {}
    contract_value = float(inst.get("contractValue") or 0)
    tick = float(inst.get("tickSize") or 0)
    if contract_value <= 0:
        raise LiveError("instrument contract value is unknown")
    mark = float((p.get("quote") or {}).get("mark") or c["close"][i])

    ev = Evaluator(d, c)
    direction = d.get("direction") or "long"
    signals = {
        "entryLong": direction in ("long", "both") and ev.group(d["entry"].get("long"), i),
        "entryShort": direction in ("short", "both") and ev.group(d["entry"].get("short"), i),
        "exitLong": ev.group(d["exit"].get("long"), i),
        "exitShort": ev.group(d["exit"].get("short"), i),
    }
    out: Dict[str, Any] = {"candleTime": candle_time, "signals": signals, "blockedBy": [], "intent": {"action": "none", "reason": "no signal"}}

    pos = session.get("position")
    if pos:
        side = 1 if pos["side"] == "long" else -1
        stop = pos.get("stopPrice")
        take = pos.get("takePrice")
        # backup protection: if the protective order did not trigger, close on the mark price
        if stop is not None and ((side == 1 and mark <= stop) or (side == -1 and mark >= stop)):
            out["intent"] = {"action": "close", "reason": "stop_loss", "contracts": pos["contracts"]}
        elif take is not None and ((side == 1 and mark >= take) or (side == -1 and mark <= take)):
            out["intent"] = {"action": "close", "reason": "take_profit", "contracts": pos["contracts"]}
        elif (side == 1 and signals["exitLong"]) or (side == -1 and signals["exitShort"]):
            out["intent"] = {"action": "close", "reason": "exit_rule", "contracts": pos["contracts"]}
        else:
            out["intent"] = {"action": "none", "reason": "holding position"}
        return out

    if session.get("lastSignalCandle") == candle_time:
        out["intent"] = {"action": "none", "reason": "signal on this candle already handled"}
        return out
    want_long, want_short = signals["entryLong"], signals["entryShort"]
    if want_long and want_short:
        out["intent"] = {"action": "none", "reason": "long and short entry signals at the same time; skipped"}
        return out
    if not (want_long or want_short):
        return out
    side = 1 if want_long else -1
    action = "open_long" if side == 1 else "open_short"

    blocked = out["blockedBy"]
    if p.get("emergency"):
        blocked.append("emergency stop is active")
    if session.get("status") != "running":
        blocked.append("automation is paused")
    if not session.get("entriesAllowed", True):
        blocked.append(session.get("entriesBlockedReason") or "entries are blocked")
    srisk = d["risk"]
    day_trades = int(session.get("dayTrades") or 0)
    if day_trades >= srisk["maxTradesPerDay"]:
        blocked.append(f"strategy reached {srisk['maxTradesPerDay']} trades today")
    day_start = float(session.get("dayStartEquity") or 0)
    day_pnl = float(session.get("dayRealizedPnl") or 0)
    loss_reason = daily_loss_reached(srisk, day_pnl, day_start)
    if loss_reason:
        blocked.append(loss_reason)
    acct_start = float(account.get("dayStartEquity") or 0)
    acct_pnl = float(account.get("dayRealizedPnl") or 0)
    if acct_start > 0 and acct_pnl <= -acct_start * risk["accountMaxDailyLossPct"] / 100:
        blocked.append(f"account daily loss limit ({risk['accountMaxDailyLossPct']}%) reached")
    if int(account.get("openPositions") or 0) >= risk["maxOpenPositions"]:
        blocked.append(f"maximum of {int(risk['maxOpenPositions'])} open positions reached")
    equity = float(account.get("equity") or 0)
    if equity <= 0:
        blocked.append("account equity is unknown or zero")
    if blocked:
        out["intent"] = {"action": "none", "reason": "blocked by risk controls"}
        return out

    try:
        levels = protective_levels(d, side, mark, raw, tick)
    except LiveError as e:
        blocked.append(str(e))
        out["intent"] = {"action": "none", "reason": "blocked by risk controls"}
        return out
    contracts, why = _size_contracts(d, side, mark, levels["stopDistance"], equity, contract_value)
    if contracts < 1:
        blocked.append(why)
        out["intent"] = {"action": "none", "reason": "blocked by risk controls"}
        return out
    notes: List[str] = []
    unit_notional = contract_value * mark
    # hard caps: shrink the order to fit; block it if not even one contract fits
    cap_order = int(math.floor(risk["maxOrderNotionalUsd"] / unit_notional + 1e-9))
    room = equity * risk["maxExposurePct"] / 100 - float(account.get("openExposureUsd") or 0)
    cap_exposure = int(math.floor(room / unit_notional + 1e-9)) if room > 0 else 0
    allowed = min(contracts, cap_order, cap_exposure)
    if allowed < contracts:
        notes.append(f"size reduced from {contracts} to {allowed} contracts by {'order notional' if cap_order <= cap_exposure else 'exposure'} limit")
    if allowed < 1:
        blocked.append("maximum order size or exposure limit leaves no room for one contract")
        out["intent"] = {"action": "none", "reason": "blocked by risk controls"}
        return out
    out["intent"] = {
        "action": action,
        "reason": "entry rules satisfied",
        "contracts": allowed,
        "estPrice": mark,
        "notionalUsd": round(allowed * unit_notional, 2),
        "stopPrice": levels["stopPrice"],
        "takePrice": levels["takePrice"],
        "notes": notes,
    }
    return out
