"""Rule-based strategies (definition version 2) and their backtester.

Mirrors apps/desktop/src/shared/strategyRules.ts. The desktop app validates definitions
fully before they can be enabled; this module re-checks structure so a malformed request
can never be evaluated.

Execution model (no look-ahead): conditions are evaluated on a candle's close and the
resulting order is simulated at the next candle's open. Stops/targets are checked intrabar
(stop first when both are touched). Daily limits use UTC days.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from . import indicators as ind
from .backtest import BacktestError, _candles, _metrics

ATR_PERIOD_FOR_STOPS = 14

INDICATOR_PERIODS = {
    "sma": (2, 400), "ema": (2, 400), "rsi": (2, 100), "atr": (2, 100),
    "highest_high": (2, 400), "lowest_low": (2, 400),
    "bb_upper": (5, 200), "bb_middle": (5, 200), "bb_lower": (5, 200),
}
COMPARATORS = {">", "<", ">=", "<=", "crosses_above", "crosses_below"}
PRICE_FIELDS = {"open", "high", "low", "close"}


class RuleError(ValueError):
    pass


Series = List[Optional[float]]


def atr(highs: Sequence[float], lows: Sequence[float], closes: Sequence[float], period: int) -> Series:
    """Wilder's average true range."""
    n = len(closes)
    out: Series = [None] * n
    if n <= period:
        return out
    trs = [highs[0] - lows[0]] + [max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])) for i in range(1, n)]
    prev = sum(trs[1 : period + 1]) / period
    out[period] = prev
    for i in range(period + 1, n):
        prev = (prev * (period - 1) + trs[i]) / period
        out[i] = prev
    return out


def bollinger(values: Sequence[float], period: int, k: float, band: str) -> Series:
    out: Series = [None] * len(values)
    for i in range(period - 1, len(values)):
        window = values[i - period + 1 : i + 1]
        mean = sum(window) / period
        if band == "middle":
            out[i] = mean
            continue
        sd = math.sqrt(sum((x - mean) ** 2 for x in window) / period)
        out[i] = mean + k * sd if band == "upper" else mean - k * sd
    return out


def previous_extreme(values: Sequence[float], period: int, fn) -> Series:
    """Extreme of the previous `period` candles, excluding the current one (so close > it is a breakout)."""
    return [None if i < period else fn(values[i - period : i]) for i in range(len(values))]


def compute_indicator(spec: Dict[str, Any], c: Dict[str, List[float]]) -> Series:
    kind, period = spec["kind"], int(spec["period"])
    if kind == "sma":
        return ind.sma(c["close"], period)
    if kind == "ema":
        return ind.ema(c["close"], period)
    if kind == "rsi":
        return ind.rsi(c["close"], period)
    if kind == "atr":
        return atr(c["high"], c["low"], c["close"], period)
    if kind == "highest_high":
        return previous_extreme(c["high"], period, max)
    if kind == "lowest_low":
        return previous_extreme(c["low"], period, min)
    if kind in ("bb_upper", "bb_middle", "bb_lower"):
        return bollinger(c["close"], period, float(spec.get("stdDev") or 2), kind[3:])
    raise RuleError(f"unsupported indicator {kind!r}")


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def check_definition(d: Dict[str, Any]) -> None:
    """Structural re-validation (the desktop performs the full semantic validation)."""
    if not isinstance(d, dict) or d.get("version") != 2:
        raise RuleError("unsupported strategy format")
    ids = set()
    for spec in d.get("indicators") or []:
        kind = spec.get("kind")
        if kind not in INDICATOR_PERIODS:
            raise RuleError(f"unsupported indicator {kind!r}")
        lo, hi = INDICATOR_PERIODS[kind]
        if not _num(spec.get("period")) or not lo <= spec["period"] <= hi:
            raise RuleError(f"indicator {spec.get('id')!r}: period out of range")
        ids.add(spec.get("id"))

    def check_operand(o: Dict[str, Any]) -> None:
        t = o.get("type")
        if t == "indicator" and o.get("id") in ids:
            return
        if t == "price" and o.get("field") in PRICE_FIELDS:
            return
        if t == "value" and _num(o.get("value")):
            return
        raise RuleError(f"invalid operand {o!r}")

    for section in ("entry", "exit"):
        for side in ("long", "short"):
            g = (d.get(section) or {}).get(side)
            if not g:
                continue
            if g.get("match") not in ("all", "any"):
                raise RuleError(f"{section}.{side}: invalid match")
            for cond in g.get("conditions") or []:
                if cond.get("op") not in COMPARATORS:
                    raise RuleError(f"{section}.{side}: invalid comparator")
                check_operand(cond.get("left") or {})
                check_operand(cond.get("right") or {})
    risk = d.get("risk") or {}
    for key in ("stopLoss", "sizing"):
        if not isinstance(risk.get(key), dict) or not _num(risk[key].get("value")) or risk[key]["value"] <= 0:
            raise RuleError(f"risk.{key} is required")
    if not _num(risk.get("maxTradesPerDay")) or risk["maxTradesPerDay"] <= 0:
        raise RuleError("risk.maxTradesPerDay is required")
    pct, usd = risk.get("maxDailyLossPct"), risk.get("maxDailyLossUsd")
    if pct is None and usd is None:
        raise RuleError("risk.maxDailyLossPct or risk.maxDailyLossUsd is required")
    for key, v in (("maxDailyLossPct", pct), ("maxDailyLossUsd", usd), ("allocatedCapitalUsd", risk.get("allocatedCapitalUsd"))):
        if v is not None and (not _num(v) or v <= 0):
            raise RuleError(f"risk.{key} must be a positive number")


def daily_loss_reached(risk: Dict[str, Any], day_pnl: float, day_start_equity: float) -> Optional[str]:
    """Reason text when realized P&L today has reached a daily loss limit, else None."""
    pct, usd = risk.get("maxDailyLossPct"), risk.get("maxDailyLossUsd")
    if _num(pct) and day_start_equity > 0 and day_pnl <= -day_start_equity * pct / 100:
        return f"strategy daily loss limit ({pct}%) reached"
    if _num(usd) and day_pnl <= -usd:
        return f"strategy daily loss limit (${usd:g}) reached"
    return None


def sizing_base(risk: Dict[str, Any], equity: float) -> float:
    """Capital that percent-based sizing applies to: the allocated capital, capped at equity."""
    cap = risk.get("allocatedCapitalUsd")
    return min(float(cap), equity) if _num(cap) and cap > 0 else equity


class Evaluator:
    def __init__(self, d: Dict[str, Any], c: Dict[str, List[float]]):
        self.c = c
        self.series = {spec["id"]: compute_indicator(spec, c) for spec in d.get("indicators") or []}

    def value(self, o: Dict[str, Any], i: int) -> Optional[float]:
        if i < 0:
            return None
        t = o["type"]
        if t == "value":
            return float(o["value"])
        if t == "price":
            return self.c[o["field"]][i]
        return self.series[o["id"]][i]

    def condition(self, cond: Dict[str, Any], i: int) -> bool:
        l, r = self.value(cond["left"], i), self.value(cond["right"], i)
        if l is None or r is None:
            return False
        op = cond["op"]
        if op == ">":
            return l > r
        if op == "<":
            return l < r
        if op == ">=":
            return l >= r
        if op == "<=":
            return l <= r
        pl, pr = self.value(cond["left"], i - 1), self.value(cond["right"], i - 1)
        if pl is None or pr is None:
            return False
        if op == "crosses_above":
            return pl <= pr and l > r
        return pl >= pr and l < r

    def group(self, g: Optional[Dict[str, Any]], i: int) -> bool:
        if not g or not g.get("conditions"):
            return False
        results = (self.condition(cond, i) for cond in g["conditions"])
        return all(results) if g["match"] == "all" else any(results)


def _utc_day(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def run_rules_backtest(
    d: Dict[str, Any],
    raw_candles: List[Dict[str, Any]],
    initial_equity: float = 10_000.0,
    fee_bps: Optional[float] = None,
    slippage_bps: float = 0.0,
) -> Dict[str, Any]:
    """Simulated history. Every fill (entries, rule exits, stops and targets) is moved against
    the trade by `slippage_bps`; fees (`fee_bps`, default the strategy's assumption) are charged
    on both sides."""
    check_definition(d)
    if initial_equity <= 0:
        raise BacktestError("initial equity must be positive")
    if not _num(slippage_bps) or not 0 <= slippage_bps <= 500:
        raise BacktestError("slippage must be 0-500 basis points")
    if fee_bps is not None and (not _num(fee_bps) or not 0 <= fee_bps <= 100):
        raise BacktestError("fees must be 0-100 basis points")
    c = _candles(raw_candles)
    n = len(c["close"])
    ev = Evaluator(d, c)
    risk = d["risk"]
    direction = d.get("direction") or "long"
    fee = float(risk.get("feeBps") or 0 if fee_bps is None else fee_bps) / 10_000.0
    slip = float(slippage_bps) / 10_000.0
    total_fees = 0.0

    def fill(price: float, buying: bool) -> float:
        return price * (1 + slip) if buying else price * (1 - slip)
    atr_series = atr(c["high"], c["low"], c["close"], ATR_PERIOD_FOR_STOPS)

    cash = initial_equity
    side = 0
    qty = entry_price = entry_time = entry_fee = 0.0
    stop_price: Optional[float] = None
    take_price: Optional[float] = None
    trades: List[Dict[str, Any]] = []
    curve: List[List[float]] = []
    bars_in_market = 0
    pending: Optional[str] = None  # decided on the previous close: "enter_long" | "enter_short" | "exit"
    day = None
    day_start_equity = initial_equity
    day_trades = 0
    day_pnl = 0.0
    blocked_days = {"trades": set(), "loss": set()}
    skipped_ambiguous = 0
    skipped_no_size = 0

    def close_position(i: int, price: float, reason: str) -> None:
        nonlocal cash, side, qty, entry_fee, stop_price, take_price, day_pnl, total_fees
        price = fill(price, buying=side == -1)
        exit_fee = qty * price * fee
        total_fees += exit_fee
        pnl = side * qty * (price - entry_price) - entry_fee - exit_fee
        cash += side * qty * (price - entry_price) - exit_fee
        day_pnl += pnl
        trades.append({
            "side": "long" if side == 1 else "short",
            "entryTime": entry_time, "entryPrice": round(entry_price, 8),
            "exitTime": c["time"][i], "exitPrice": round(price, 8),
            "quantity": round(qty, 8), "pnl": round(pnl, 2),
            "returnPct": round(100 * pnl / (qty * entry_price), 3), "exitReason": reason,
        })
        side, qty, entry_fee, stop_price, take_price = 0, 0.0, 0.0, None, None

    def stop_distance(i: int, price: float) -> Optional[float]:
        s = risk["stopLoss"]
        if s["type"] == "percent":
            return price * s["value"] / 100
        if s["type"] == "points":
            return float(s["value"])
        a = atr_series[i - 1] if i > 0 else None  # ATR known at the decision candle's close
        return None if a is None else a * s["value"]

    def open_position(i: int, direction_sign: int) -> None:
        nonlocal side, qty, entry_price, entry_time, entry_fee, cash, stop_price, take_price, day_trades, skipped_no_size, total_fees
        price = fill(c["open"][i], buying=direction_sign == 1)
        dist = stop_distance(i, price)
        if dist is None or dist <= 0:
            skipped_no_size += 1
            return
        equity = sizing_base(risk, cash)
        sizing = risk["sizing"]
        if sizing["type"] == "percent_equity":
            q = equity * sizing["value"] / 100 / price
        elif sizing["type"] == "risk_percent":
            q = equity * sizing["value"] / 100 / dist
        else:
            q = float(sizing["value"])
        if q <= 0 or not math.isfinite(q):
            skipped_no_size += 1
            return
        side, qty, entry_price, entry_time = direction_sign, q, price, c["time"][i]
        entry_fee = qty * price * fee
        total_fees += entry_fee
        cash -= entry_fee
        stop_price = price - side * dist
        tp = risk.get("takeProfit")
        if tp:
            tdist = price * tp["value"] / 100 if tp["type"] == "percent" else float(tp["value"]) if tp["type"] == "points" else dist * tp["value"]
            take_price = price + side * tdist
        else:
            take_price = None
        day_trades += 1

    for i in range(n):
        today = _utc_day(c["time"][i])
        if today != day:
            day, day_trades, day_pnl = today, 0, 0.0
            day_start_equity = cash + (side * qty * (c["open"][i] - entry_price) if side else 0.0)

        # 1) act on the decision made at the previous close, at this candle's open
        if pending == "exit" and side:
            close_position(i, c["open"][i], "rule")
        elif pending in ("enter_long", "enter_short") and not side:
            limit_trades = day_trades >= risk["maxTradesPerDay"]
            limit_loss = daily_loss_reached(risk, day_pnl, day_start_equity) is not None
            if limit_trades:
                blocked_days["trades"].add(today)
            elif limit_loss:
                blocked_days["loss"].add(today)
            else:
                open_position(i, 1 if pending == "enter_long" else -1)
        pending = None

        # 2) intrabar stop / target
        if side:
            hi, lo, op = c["high"][i], c["low"][i], c["open"][i]
            hit_stop = (lo <= stop_price) if side == 1 else (hi >= stop_price)
            hit_take = take_price is not None and ((hi >= take_price) if side == 1 else (lo <= take_price))
            if hit_stop:
                close_position(i, min(stop_price, op) if side == 1 else max(stop_price, op), "stop_loss")
            elif hit_take:
                close_position(i, max(take_price, op) if side == 1 else min(take_price, op), "take_profit")

        # 3) decide on this candle's close
        if i < n - 1:
            if side == 1 and ev.group(d["exit"].get("long"), i):
                pending = "exit"
            elif side == -1 and ev.group(d["exit"].get("short"), i):
                pending = "exit"
            elif not side:
                want_long = direction in ("long", "both") and ev.group(d["entry"].get("long"), i)
                want_short = direction in ("short", "both") and ev.group(d["entry"].get("short"), i)
                if want_long and want_short:
                    skipped_ambiguous += 1
                elif want_long:
                    pending = "enter_long"
                elif want_short:
                    pending = "enter_short"

        if side:
            bars_in_market += 1
        curve.append([c["time"][i], round(cash + (side * qty * (c["close"][i] - entry_price) if side else 0.0), 2)])

    if side:
        close_position(n - 1, c["close"][n - 1], "end_of_data")
        curve[-1][1] = round(cash, 2)

    metrics = _metrics(curve, trades, initial_equity, c, bars_in_market)
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [t["pnl"] for t in trades if t["pnl"] <= 0]
    streak = worst = 0
    for t in trades:
        streak = streak + 1 if t["pnl"] <= 0 else 0
        worst = max(worst, streak)
    metrics.update({
        "netPnl": round(metrics["finalEquity"] - initial_equity, 2),
        "totalFees": round(total_fees, 2),
        "feeBps": round(fee * 10_000, 4),
        "slippageBps": float(slippage_bps),
        "winningTrades": len(wins),
        "losingTrades": len(losses),
        "avgWin": round(sum(wins) / len(wins), 2) if wins else None,
        "avgLoss": round(sum(losses) / len(losses), 2) if losses else None,
        "largestLoss": round(min(losses), 2) if losses else None,
        "maxConsecutiveLosses": worst,
        "daysBlockedByTradeLimit": len(blocked_days["trades"]),
        "daysBlockedByLossLimit": len(blocked_days["loss"]),
        "signalsSkippedAmbiguous": skipped_ambiguous,
        "signalsSkippedNoStop": skipped_no_size,
    })
    return {"metrics": metrics, "trades": trades, "equityCurve": curve}
