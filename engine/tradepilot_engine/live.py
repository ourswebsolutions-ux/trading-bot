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
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from . import indicators as ind
from .backtest import _candles
from .rules import ATR_PERIOD_FOR_STOPS, EXTENSION_EMA, Evaluator, RuleError, atr, bar_seconds, check_definition, daily_loss_reached, filter_block, market_block, needs_market_filters, sizing_base

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


def protective_levels(definition: Dict[str, Any], side: int, entry_price: float, candles: List[Dict[str, Any]], tick: float, pip_size: Optional[float] = None) -> Dict[str, Optional[float]]:
    """Stop-loss / take-profit prices for a position, from the strategy's risk rules."""
    risk = definition["risk"]
    stop = risk["stopLoss"]
    if stop["type"] in ("pips",) or (risk.get("takeProfit") or {}).get("type") == "pips":
        if not _num(pip_size) or pip_size <= 0:
            raise LiveError("pip size is unknown for this symbol; pips stops need a MetaTrader 5 forex symbol")
    if stop["type"] == "percent":
        dist = entry_price * stop["value"] / 100
    elif stop["type"] == "points":
        dist = float(stop["value"])
    elif stop["type"] == "pips":
        dist = float(stop["value"]) * float(pip_size)
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
        tdist = entry_price * tp["value"] / 100 if tp["type"] == "percent" else float(tp["value"]) if tp["type"] == "points" else float(tp["value"]) * float(pip_size) if tp["type"] == "pips" else dist * tp["value"]
        take_price = round_to_tick(entry_price + side * tdist, tick, "nearest")
    return {"stopPrice": stop_price, "takePrice": take_price, "stopDistance": dist}


def sizing_spec(inst: Dict[str, Any]) -> Dict[str, Any]:
    """Broker-neutral volume spec (mirrors apps/desktop/src/shared/sizing.ts).

    Without explicit fields the instrument is a Delta perpetual: whole contracts, each 1.0 price
    move worth `contractValue`. Other venues pass valuePerPoint / volumeStep / volumeMin / volumeMax
    (e.g. fractional lots)."""
    vpp = inst.get("valuePerPoint")
    if _num(vpp) and vpp > 0:
        step = inst.get("volumeStep") if _num(inst.get("volumeStep")) and inst["volumeStep"] > 0 else 1.0
        return {
            "valuePerPoint": float(vpp),
            "unitsPerVolume": float(inst["unitsPerVolume"]) if _num(inst.get("unitsPerVolume")) and inst["unitsPerVolume"] > 0 else float(vpp),
            "volumeStep": float(step),
            "volumeMin": float(inst["volumeMin"]) if _num(inst.get("volumeMin")) and inst["volumeMin"] > 0 else float(step),
            "volumeMax": float(inst["volumeMax"]) if _num(inst.get("volumeMax")) and inst["volumeMax"] > 0 else None,
            "volumeUnit": str(inst.get("volumeUnit") or "units"),
        }
    cv = float(inst.get("contractValue") or 0)
    return {"valuePerPoint": cv, "unitsPerVolume": cv, "volumeStep": 1.0, "volumeMin": 1.0, "volumeMax": None, "volumeUnit": "contracts"}


def _step_decimals(step: float) -> int:
    if step >= 1 and float(step).is_integer():
        return 0
    text = repr(float(step))
    if "e-" in text:
        return int(text.split("e-")[1])
    return min(10, len(text.split(".")[1]) if "." in text else 0)


def round_volume_down(volume: float, step: float):
    """Floors a volume to the step; whole steps stay ints (Delta contracts)."""
    if not math.isfinite(volume) or volume <= 0:
        return 0
    steps = math.floor(volume / step + 1e-9)
    if step == 1:
        return int(steps)
    return round(steps * step, _step_decimals(step))


def _is_delta_contracts(spec: Dict[str, Any]) -> bool:
    return spec["volumeStep"] == 1 and spec["volumeMin"] == 1 and spec["volumeUnit"] == "contracts"


def _size_volume(definition, side, price, stop_dist, equity, spec) -> (float, str):
    sizing = definition["risk"]["sizing"]
    equity = sizing_base(definition["risk"], equity)
    # same operation order as the original whole-contract sizing, so Delta results are bit-identical
    if sizing["type"] == "percent_equity":
        qty = equity * sizing["value"] / 100 / price
        per_volume = spec["valuePerPoint"]
    elif sizing["type"] == "risk_percent":
        qty = equity * sizing["value"] / 100 / stop_dist
        per_volume = spec["valuePerPoint"]
    else:
        qty = float(sizing["value"])
        per_volume = spec["unitsPerVolume"]
    if not math.isfinite(qty) or qty <= 0:
        return 0, "position size computed as zero"
    raw = qty / per_volume
    volume = round_volume_down(raw, spec["volumeStep"])
    if volume < spec["volumeMin"] - 1e-9:
        if _is_delta_contracts(spec):
            return 0, f"position size {qty:.6g} is below one contract ({per_volume})"
        return 0, f"position size {raw:.6g} {spec['volumeUnit']} is below the minimum of {spec['volumeMin']:g} {spec['volumeUnit']}"
    return volume, ""


def _ts(value: Any) -> Optional[float]:
    """Seconds since 1970 from a number or an ISO-8601 time (as the desktop stores them)."""
    if _num(value):
        return float(value)
    if isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()
    return None


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
    spec = sizing_spec(inst)
    tick = float(inst.get("tickSize") or 0)
    if spec["valuePerPoint"] <= 0:
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
    srisk0 = d.get("risk") or {}
    step = bar_seconds(c["time"])
    if pos:
        side = 1 if pos["side"] == "long" else -1
        stop = pos.get("stopPrice")
        take = pos.get("takePrice")
        max_bars = srisk0.get("maxTradeBars")
        entered = _ts(pos.get("entryTime"))
        if max_bars and entered is not None and step > 0 and (candle_time + step - entered) / step >= max_bars - 1e-9:
            out["intent"] = {"action": "close", "reason": "max_duration", "contracts": pos["contracts"]}
            return out
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
    max_streak = srisk.get("maxConsecutiveLosses")
    if max_streak is not None and int(session.get("consecutiveLosses") or 0) >= max_streak:
        blocked.append(f"{int(session.get('consecutiveLosses'))} losing trades in a row today (maximum {int(max_streak)})")
    cooldown = srisk.get("cooldownBars")
    last_exit = _ts(session.get("lastExitTime"))
    if cooldown and last_exit is not None and step > 0:
        waited = (candle_time + step - last_exit) / step
        if waited < cooldown:
            blocked.append(f"cooling down after the last trade ({cooldown - int(waited)} more candle{'s' if cooldown - int(waited) != 1 else ''})")
    filters = d.get("filters") or None
    if filters:
        q0 = p.get("quote") or {}
        spread = float(q0["ask"]) - float(q0["bid"]) if _num(q0.get("bid")) and _num(q0.get("ask")) else None
        entry_ts = float(p["now"]) if _num(p.get("now")) else candle_time + bar_seconds(c["time"])
        why = filter_block(filters, spread, entry_ts)
        if why:
            blocked.append(why)
        if needs_market_filters(filters):
            ema_ext = ind.ema(c["close"], EXTENSION_EMA) if filters.get("maxExtensionAtr") is not None else None
            market = market_block(filters, c, i, atr(c["high"], c["low"], c["close"], ATR_PERIOD_FOR_STOPS), ema_ext)
            if market:
                blocked.append(market)
    if blocked:
        out["intent"] = {"action": "none", "reason": "blocked by risk controls"}
        return out

    try:
        # where quoted (MT5), a buy fills at the ask and a sell at the bid: anchor stops there
        q = p.get("quote") or {}
        entry_ref = float(q["ask"] if side > 0 else q["bid"]) if _num(q.get("bid")) and _num(q.get("ask")) else mark
        levels = protective_levels(d, side, entry_ref, raw, tick, inst.get("pipSize"))
    except LiveError as e:
        blocked.append(str(e))
        out["intent"] = {"action": "none", "reason": "blocked by risk controls"}
        return out
    contracts, why = _size_volume(d, side, mark, levels["stopDistance"], equity, spec)
    if not contracts:
        blocked.append(why)
        out["intent"] = {"action": "none", "reason": "blocked by risk controls"}
        return out
    notes: List[str] = []
    unit = spec["volumeUnit"]
    step = spec["volumeStep"]
    unit_notional = spec["valuePerPoint"] * mark
    # hard caps: shrink the order to fit (in whole steps); block it if not even the minimum fits
    cap_order = round_volume_down(risk["maxOrderNotionalUsd"] / unit_notional, step)
    room = equity * risk["maxExposurePct"] / 100 - float(account.get("openExposureUsd") or 0)
    cap_exposure = round_volume_down(room / unit_notional, step) if room > 0 else 0
    caps = [(cap_order, "order notional"), (cap_exposure, "exposure")]
    if spec["volumeMax"] is not None:
        caps.append((round_volume_down(spec["volumeMax"], step), "venue maximum"))
    allowed = min([contracts] + [c for c, _ in caps])
    if allowed < contracts:
        limiter = min(caps, key=lambda c: c[0])[1]
        notes.append(f"size reduced from {contracts} to {allowed} {unit} by {limiter} limit")
    if allowed < spec["volumeMin"] - 1e-9 or not allowed:
        blocked.append("maximum order size or exposure limit leaves no room for one contract" if _is_delta_contracts(spec) else f"maximum order size or exposure limit leaves no room for the minimum of {spec['volumeMin']:g} {unit}")
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
