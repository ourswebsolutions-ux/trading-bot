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
    # MACD: period = fast EMA; "slow" and "signal" are extra parameters (defaults 26 and 9)
    "macd_line": (2, 100), "macd_signal": (2, 100), "macd_hist": (2, 100),
    # session VWAP (resets at 00:00 UTC); the period is not used
    "vwap": (1, 1),
}
TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400}
EXTENSION_EMA = 20
MACD_SLOW = (3, 200)
MACD_SIGNAL = (2, 50)
MACD_KINDS = ("macd_line", "macd_signal", "macd_hist")
COMPARATORS = {">", "<", ">=", "<=", "crosses_above", "crosses_below"}
STOP_TYPES = {"percent", "points", "atr", "pips"}
TARGET_TYPES = {"percent", "points", "risk_multiple", "pips"}


def uses_pips(d: Dict[str, Any]) -> bool:
    risk = d.get("risk") or {}
    return any(isinstance(risk.get(k), dict) and risk[k].get("type") == "pips" for k in ("stopLoss", "takeProfit"))
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


def vwap(c: Dict[str, List[float]]) -> Series:
    """Volume-weighted average of the typical price since 00:00 UTC; None while no volume is known."""
    out: Series = [None] * len(c["close"])
    day, pv, vol = None, 0.0, 0.0
    for i, t in enumerate(c["time"]):
        d = int(t // 86400)
        if d != day:
            day, pv, vol = d, 0.0, 0.0
        v = c["volume"][i] if "volume" in c else 0.0
        pv += (c["high"][i] + c["low"][i] + c["close"][i]) / 3 * v
        vol += v
        out[i] = pv / vol if vol > 0 else None
    return out


def higher_timeframe(spec: Dict[str, Any], c: Dict[str, List[float]]) -> Series:
    """An indicator on higher-timeframe candles built from the strategy's candles. Each candle sees
    the value of the last *completed* higher-timeframe candle only (no look-ahead): on M5 candles,
    an M15 EMA changes when an M15 candle has closed."""
    htf = TF_SECONDS[spec["timeframe"]]
    times = c["time"]
    n = len(times)
    base = bar_seconds(times)
    groups: List[Dict[str, Any]] = []
    for i, t in enumerate(times):
        start = t - (t % htf)
        if not groups or groups[-1]["start"] != start:
            groups.append({"start": start, "open": c["open"][i], "high": c["high"][i], "low": c["low"][i], "close": c["close"][i], "volume": c["volume"][i] if "volume" in c else 0.0, "first": t, "last": t})
        else:
            g = groups[-1]
            g["high"], g["low"], g["close"], g["last"] = max(g["high"], c["high"][i]), min(g["low"], c["low"][i]), c["close"][i], t
            g["volume"] += c["volume"][i] if "volume" in c else 0.0
    if groups and groups[0]["first"] != groups[0]["start"]:
        groups = groups[1:]  # the series started inside this candle: its open/high/low are unknown
    if groups and groups[-1]["last"] + base < groups[-1]["start"] + htf:
        groups = groups[:-1]  # still forming
    out: Series = [None] * n
    if not groups:
        return out
    hc = {k: [float(g[k]) for g in groups] for k in ("open", "high", "low", "close", "volume")}
    hc["time"] = [float(g["start"]) for g in groups]
    hc["spread"] = [0.0] * len(groups)
    sub = {k: v for k, v in spec.items() if k != "timeframe"}
    values = compute_indicator(sub, hc)
    j = -1
    for i in range(n):
        close_time = times[i] + base
        while j + 1 < len(groups) and groups[j + 1]["start"] + htf <= close_time:
            j += 1
        out[i] = values[j] if j >= 0 else None
    return out


def compute_indicator(spec: Dict[str, Any], c: Dict[str, List[float]]) -> Series:
    if spec.get("timeframe"):
        return higher_timeframe(spec, c)
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
    if kind in MACD_KINDS:
        line, sig, hist = ind.macd(c["close"], period, int(spec.get("slow") or 26), int(spec.get("signal") or 9))
        return {"macd_line": line, "macd_signal": sig, "macd_hist": hist}[kind]
    if kind == "vwap":
        return vwap(c)
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
        if kind in MACD_KINDS:
            slow, sig = spec.get("slow", 26), spec.get("signal", 9)
            if not _num(slow) or not MACD_SLOW[0] <= slow <= MACD_SLOW[1] or slow <= spec["period"]:
                raise RuleError(f"indicator {spec.get('id')!r}: MACD slow period must be above the fast period")
            if not _num(sig) or not MACD_SIGNAL[0] <= sig <= MACD_SIGNAL[1]:
                raise RuleError(f"indicator {spec.get('id')!r}: MACD signal period out of range")
        if spec.get("timeframe") is not None:
            htf, base = TF_SECONDS.get(spec["timeframe"]), TF_SECONDS.get(d.get("timeframe") or "")
            if htf is None or kind == "vwap" or (base is not None and (htf <= base or htf % base)):
                raise RuleError(f"indicator {spec.get('id')!r}: its timeframe must be a higher multiple of the strategy timeframe")
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
    if isinstance(risk.get("stopLoss"), dict) and risk["stopLoss"].get("type") not in STOP_TYPES:
        raise RuleError("risk.stopLoss: unsupported type")
    if isinstance(risk.get("takeProfit"), dict) and risk["takeProfit"].get("type") not in TARGET_TYPES:
        raise RuleError("risk.takeProfit: unsupported type")
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
    for key, lo, hi in (("maxConsecutiveLosses", 1, 50), ("cooldownBars", 0, 1000), ("maxTradeBars", 1, 100_000)):
        v = risk.get(key)
        if v is not None and (not _num(v) or v != int(v) or not lo <= v <= hi):
            raise RuleError(f"risk.{key} must be a whole number from {lo} to {hi}")
    check_filters(d.get("filters"))


def _minute_of_day(hhmm: Any) -> int:
    if not isinstance(hhmm, str) or len(hhmm) != 5 or hhmm[2] != ":" or not (hhmm[:2] + hhmm[3:]).isdigit():
        raise RuleError(f"invalid session time {hhmm!r} (use HH:MM, UTC)")
    h, m = int(hhmm[:2]), int(hhmm[3:])
    if h > 23 or m > 59:
        raise RuleError(f"invalid session time {hhmm!r} (use HH:MM, UTC)")
    return h * 60 + m


def check_filters(f: Any) -> None:
    """Optional entry filters: maximum spread (price units) and a UTC trading session."""
    if f is None:
        return
    if not isinstance(f, dict):
        raise RuleError("filters must be an object")
    if f.get("maxSpread") is not None and (not _num(f["maxSpread"]) or f["maxSpread"] <= 0):
        raise RuleError("filters.maxSpread must be a positive price distance")
    s = f.get("session")
    if s is not None:
        if not isinstance(s, dict):
            raise RuleError("filters.session must be an object")
        if _minute_of_day(s.get("start")) == _minute_of_day(s.get("end")):
            raise RuleError("filters.session start and end must differ")
    for key in ("maxExtensionAtr", "abnormalRangeAtr", "minAtr", "maxAtr"):
        if f.get(key) is not None and (not _num(f[key]) or f[key] <= 0):
            raise RuleError(f"filters.{key} must be a positive number")
    events = f.get("events")
    if events is not None:
        if not isinstance(events, list) or len(events) > 200:
            raise RuleError("filters.events must be a list (at most 200)")
        for e in events:
            if not isinstance(e, dict) or _iso_seconds(e.get("start")) >= _iso_seconds(e.get("end")):
                raise RuleError("each high-risk event needs a start before its end (UTC date and time)")


def _iso_seconds(value: Any) -> float:
    if not isinstance(value, str):
        raise RuleError(f"invalid date {value!r}")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise RuleError(f"invalid date {value!r}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def in_session(ts: float, session: Optional[Dict[str, Any]]) -> bool:
    """True when the UTC time falls in the session window (which may wrap past midnight)."""
    if not session:
        return True
    start, end = _minute_of_day(session["start"]), _minute_of_day(session["end"])
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    minute = dt.hour * 60 + dt.minute
    return start <= minute < end if start < end else minute >= start or minute < end


def filter_block(filters: Optional[Dict[str, Any]], spread: Optional[float], entry_ts: float) -> Optional[str]:
    """Why an entry is not allowed by the strategy's filters, or None."""
    if not filters:
        return None
    max_spread = filters.get("maxSpread")
    if max_spread is not None:
        if spread is None:
            return "the current spread is unknown"
        if spread > max_spread + 1e-12:
            return f"spread {spread:.5g} is above the maximum of {max_spread:g}"
    s = filters.get("session")
    if s and not in_session(entry_ts, s):
        return f"outside the trading session {s['start']}-{s['end']} UTC"
    for e in filters.get("events") or []:
        if _iso_seconds(e["start"]) <= entry_ts < _iso_seconds(e["end"]):
            return f"high-risk event window: {e.get('label') or 'configured event'}"
    return None


def market_block(filters: Optional[Dict[str, Any]], c: Dict[str, List[float]], i: int, atr_series: Series, ema_series: Optional[Series]) -> Optional[str]:
    """Conditions of the market itself that make an entry unwise: a move that is already extended,
    an abnormal candle (news spike), or volatility outside the configured band."""
    if not filters:
        return None
    a = atr_series[i]
    prev = atr_series[i - 1] if i > 0 else None
    ext = filters.get("maxExtensionAtr")
    if ext is not None and ema_series is not None:
        e = ema_series[i]
        if a is None or e is None:
            return "not enough history to measure how extended the price is"
        if abs(c["close"][i] - e) > ext * a:
            return f"price is extended: {abs(c['close'][i] - e) / a:.1f} x ATR from EMA {EXTENSION_EMA} (maximum {ext:g})"
    spike = filters.get("abnormalRangeAtr")
    if spike is not None and prev:
        rng = c["high"][i] - c["low"][i]
        if rng > spike * prev:
            return f"abnormal candle: range {rng / prev:.1f} x ATR (maximum {spike:g})"
    if a is not None:
        if filters.get("minAtr") is not None and a < filters["minAtr"]:
            return f"volatility too low: ATR {a:.4g} below {filters['minAtr']:g}"
        if filters.get("maxAtr") is not None and a > filters["maxAtr"]:
            return f"volatility too high: ATR {a:.4g} above {filters['maxAtr']:g}"
    return None


def needs_market_filters(filters: Optional[Dict[str, Any]]) -> bool:
    return bool(filters) and any(filters.get(k) is not None for k in ("maxExtensionAtr", "abnormalRangeAtr", "minAtr", "maxAtr"))


def bar_seconds(times: Sequence[float]) -> float:
    """The candle interval (smallest gap between consecutive candles; weekends do not count)."""
    gaps = [b - a for a, b in zip(times, times[1:]) if b > a]
    return float(min(gaps)) if gaps else 0.0


def floor_volume(volume: float, step: float) -> float:
    if not math.isfinite(volume) or volume <= 0:
        return 0.0
    steps = math.floor(volume / step + 1e-9)
    decimals = max(0, -int(math.floor(math.log10(step)))) if step < 1 else 0
    return round(steps * step, decimals + 2)


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
    point_value: float = 1.0,
    units_per_lot: Optional[float] = None,
    pip_size: Optional[float] = None,
    volume_step: Optional[float] = None,
    volume_min: Optional[float] = None,
    volume_max: Optional[float] = None,
    commission_per_lot: float = 0.0,
    extra_metrics: bool = False,
) -> Dict[str, Any]:
    """Simulated history. Every fill (entries, rule exits, stops and targets) is moved against
    the trade by `slippage_bps`; fees (`fee_bps`, default the strategy's assumption) are charged
    on both sides.

    Venue parameters (defaults reproduce Delta Exchange exactly):
      point_value    account-currency value of a 1.0 price move per unit of quantity (forex pairs
                     whose quote currency differs from the account currency, e.g. USDJPY on a USD account)
      units_per_lot  fixed-quantity sizing is in lots of this many units (MetaTrader 5)
      pip_size       price size of one pip, for "pips" stops and targets
      volume_step/min/max  broker lot rules (MT5): sizes are rounded down to the step like live
                     orders, capped at the maximum, and a signal below the minimum is skipped
      commission_per_lot   account-currency commission per lot and side (MT5 brokers charge per lot)
      extra_metrics  also report average trade duration and win/loss streaks
    Execution: a signal on a candle's close fills at the next candle's open (the decision and the
    order take time); slippage_bps models the further cost of fast markets and requotes.
    Candles may carry a "spread" (price units); buys then fill at the ask (bid + spread)."""
    check_definition(d)
    if not _num(point_value) or point_value <= 0:
        raise BacktestError("point value must be positive")
    if units_per_lot is not None and (not _num(units_per_lot) or units_per_lot <= 0):
        raise BacktestError("units per lot must be positive")
    if uses_pips(d) and (not _num(pip_size) or pip_size <= 0):
        raise BacktestError("pip size is unknown for this symbol; pips stops need a MetaTrader 5 symbol")
    if initial_equity <= 0:
        raise BacktestError("initial equity must be positive")
    if not _num(slippage_bps) or not 0 <= slippage_bps <= 500:
        raise BacktestError("slippage must be 0-500 basis points")
    if fee_bps is not None and (not _num(fee_bps) or not 0 <= fee_bps <= 100):
        raise BacktestError("fees must be 0-100 basis points")
    if volume_step is not None and (not _num(volume_step) or volume_step <= 0):
        raise BacktestError("volume step must be positive")
    if not _num(commission_per_lot) or commission_per_lot < 0:
        raise BacktestError("commission per lot must be zero or positive")
    c = _candles(raw_candles)
    n = len(c["close"])
    ev = Evaluator(d, c)
    risk = d["risk"]
    direction = d.get("direction") or "long"
    fee = float(risk.get("feeBps") or 0 if fee_bps is None else fee_bps) / 10_000.0
    slip = float(slippage_bps) / 10_000.0
    total_fees = 0.0

    pv = float(point_value)
    spreads = c["spread"]

    def fill(price: float, buying: bool, i: int) -> float:
        # bars are bid prices: buying pays the spread (0 for Delta candles)
        return (price + spreads[i]) * (1 + slip) if buying else price * (1 - slip)
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
    skipped_min_volume = 0
    filters = d.get("filters") or None
    skipped_filter = {"spread": 0, "session": 0, "event": 0, "market": 0, "cooldown": 0}
    step_sec = bar_seconds(c["time"]) if filters else 0.0
    use_market = needs_market_filters(filters)
    ema_ext = ind.ema(c["close"], EXTENSION_EMA) if use_market and filters.get("maxExtensionAtr") is not None else None
    max_bars = risk.get("maxTradeBars")
    cooldown = risk.get("cooldownBars")
    max_streak = risk.get("maxConsecutiveLosses")
    loss_streak = 0
    entry_index = -1
    last_exit_index: Optional[int] = None
    pending_reason = "rule"
    comm = float(commission_per_lot)
    lot_units = float(units_per_lot) if units_per_lot is not None else 1.0  # quantity per lot

    def close_position(i: int, price: float, reason: str) -> None:
        nonlocal cash, side, qty, entry_fee, stop_price, take_price, day_pnl, total_fees, loss_streak, last_exit_index
        price = fill(price, side == -1, i)
        exit_fee = qty * price * pv * fee + comm * qty / lot_units
        total_fees += exit_fee
        pnl = side * qty * (price - entry_price) * pv - entry_fee - exit_fee
        cash += side * qty * (price - entry_price) * pv - exit_fee
        day_pnl += pnl
        trades.append({
            "side": "long" if side == 1 else "short",
            "entryTime": entry_time, "entryPrice": round(entry_price, 8),
            "exitTime": c["time"][i], "exitPrice": round(price, 8),
            "quantity": round(qty, 8), "pnl": round(pnl, 2),
            "returnPct": round(100 * pnl / (qty * entry_price * pv), 3), "exitReason": reason,
        })
        side, qty, entry_fee, stop_price, take_price = 0, 0.0, 0.0, None, None
        loss_streak = loss_streak + 1 if pnl <= 0 else 0
        last_exit_index = i

    def stop_distance(i: int, price: float) -> Optional[float]:
        s = risk["stopLoss"]
        if s["type"] == "percent":
            return price * s["value"] / 100
        if s["type"] == "points":
            return float(s["value"])
        if s["type"] == "pips":
            return float(s["value"]) * float(pip_size)
        a = atr_series[i - 1] if i > 0 else None  # ATR known at the decision candle's close
        return None if a is None else a * s["value"]

    def open_position(i: int, direction_sign: int) -> None:
        nonlocal side, qty, entry_price, entry_time, entry_fee, cash, stop_price, take_price, day_trades, skipped_no_size, skipped_min_volume, total_fees, entry_index
        price = fill(c["open"][i], direction_sign == 1, i)
        dist = stop_distance(i, price)
        if dist is None or dist <= 0:
            skipped_no_size += 1
            return
        equity = sizing_base(risk, cash)
        sizing = risk["sizing"]
        if sizing["type"] == "percent_equity":
            q = equity * sizing["value"] / 100 / price / pv
        elif sizing["type"] == "risk_percent":
            q = equity * sizing["value"] / 100 / dist / pv
        else:
            q = float(sizing["value"]) * (units_per_lot if units_per_lot is not None else 1.0)
        if q <= 0 or not math.isfinite(q):
            skipped_no_size += 1
            return
        if volume_step is not None:
            # broker lot rules, as live orders: never rounded up, never above the maximum
            lots = floor_volume(q / lot_units, float(volume_step))
            if volume_max is not None and volume_max > 0:
                lots = min(lots, floor_volume(float(volume_max), float(volume_step)))
            if lots <= 0 or (volume_min is not None and lots < volume_min - 1e-9):
                skipped_min_volume += 1
                return
            q = lots * lot_units
        side, qty, entry_price, entry_time = direction_sign, q, price, c["time"][i]
        entry_index = i
        entry_fee = qty * price * pv * fee + comm * qty / lot_units
        total_fees += entry_fee
        cash -= entry_fee
        stop_price = price - side * dist
        tp = risk.get("takeProfit")
        if tp:
            tdist = price * tp["value"] / 100 if tp["type"] == "percent" else float(tp["value"]) if tp["type"] == "points" else float(tp["value"]) * float(pip_size) if tp["type"] == "pips" else dist * tp["value"]
            take_price = price + side * tdist
        else:
            take_price = None
        day_trades += 1

    for i in range(n):
        today = _utc_day(c["time"][i])
        if today != day:
            day, day_trades, day_pnl = today, 0, 0.0
            loss_streak = 0
            day_start_equity = cash + (side * qty * (c["open"][i] - entry_price) * pv if side else 0.0)

        # 1) act on the decision made at the previous close, at this candle's open
        if pending == "exit" and side:
            close_position(i, c["open"][i], pending_reason)
        elif pending in ("enter_long", "enter_short") and not side:
            limit_trades = day_trades >= risk["maxTradesPerDay"]
            limit_loss = daily_loss_reached(risk, day_pnl, day_start_equity) is not None
            if limit_trades:
                blocked_days["trades"].add(today)
            elif limit_loss:
                blocked_days["loss"].add(today)
            elif max_streak is not None and loss_streak >= max_streak:
                blocked_days.setdefault("streak", set()).add(today)
            else:
                open_position(i, 1 if pending == "enter_long" else -1)
        pending = None

        # 2) intrabar stop / target
        if side:
            hi, lo, op = c["high"][i], c["low"][i], c["open"][i]
            ask_adj = spreads[i]  # a short is closed by buying at the ask
            hit_stop = (lo <= stop_price) if side == 1 else (hi + ask_adj >= stop_price)
            hit_take = take_price is not None and ((hi >= take_price) if side == 1 else (lo + ask_adj <= take_price))
            # levels are on the side that closes the trade; fill() adds the spread to buys, so
            # a short's ask-level stop/target is passed as its bid equivalent
            if hit_stop:
                close_position(i, min(stop_price, op) if side == 1 else max(stop_price - ask_adj, op), "stop_loss")
            elif hit_take:
                close_position(i, max(take_price, op) if side == 1 else min(take_price - ask_adj, op), "take_profit")

        # 3) decide on this candle's close
        if i < n - 1:
            pending_reason = "rule"
            if side and max_bars is not None and i - entry_index + 1 >= max_bars:
                pending, pending_reason = "exit", "max_duration"
            elif side == 1 and ev.group(d["exit"].get("long"), i):
                pending = "exit"
            elif side == -1 and ev.group(d["exit"].get("short"), i):
                pending = "exit"
            elif not side and cooldown and last_exit_index is not None and i - last_exit_index < cooldown:
                if direction in ("long", "both") and ev.group(d["entry"].get("long"), i) or direction in ("short", "both") and ev.group(d["entry"].get("short"), i):
                    skipped_filter["cooldown"] += 1
            elif not side:
                want_long = direction in ("long", "both") and ev.group(d["entry"].get("long"), i)
                want_short = direction in ("short", "both") and ev.group(d["entry"].get("short"), i)
                if want_long and want_short:
                    skipped_ambiguous += 1
                elif want_long or want_short:
                    # filters use what is known at this close: its spread, and the next candle's start time
                    why = filter_block(filters, spreads[i], c["time"][i] + step_sec) if filters else None
                    market = market_block(filters, c, i, atr_series, ema_ext) if use_market and not why else None
                    if why:
                        skipped_filter["spread" if "spread" in why else "event" if why.startswith("high-risk") else "session"] += 1
                    elif market:
                        skipped_filter["market"] += 1
                    else:
                        pending = "enter_long" if want_long else "enter_short"

        if side:
            bars_in_market += 1
        curve.append([c["time"][i], round(cash + (side * qty * (c["close"][i] - entry_price) * pv if side else 0.0), 2)])

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
    # keys only for the options that were used, so results without them are unchanged
    if volume_step is not None:
        metrics["signalsSkippedBelowMinVolume"] = skipped_min_volume
    if filters:
        metrics["signalsSkippedSpread"] = skipped_filter["spread"]
        metrics["signalsSkippedSession"] = skipped_filter["session"]
        if filters.get("events"):
            metrics["signalsSkippedEvent"] = skipped_filter["event"]
        if use_market:
            metrics["signalsSkippedMarket"] = skipped_filter["market"]
    if cooldown:
        metrics["signalsSkippedCooldown"] = skipped_filter["cooldown"]
    if max_streak is not None:
        metrics["daysBlockedByLossStreak"] = len(blocked_days.get("streak", set()))
    if extra_metrics:
        durations = [t["exitTime"] - t["entryTime"] for t in trades]
        best = run = 0
        for t in trades:
            run = run + 1 if t["pnl"] > 0 else 0
            best = max(best, run)
        metrics["avgTradeDurationSec"] = round(sum(durations) / len(durations), 1) if durations else None
        metrics["maxConsecutiveWins"] = best
        metrics["timeExits"] = sum(1 for t in trades if t["exitReason"] == "max_duration")
    return {"metrics": metrics, "trades": trades, "equityCurve": curve}
