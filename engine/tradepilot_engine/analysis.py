"""Market read-out for the dashboard: trend, momentum, volatility, support/resistance and the last
candle's shape, computed from closed candles only. Descriptive, not a prediction."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import indicators as ind
from .backtest import _candles
from .rules import atr, vwap


class AnalysisError(ValueError):
    pass


def _last(series: List[Optional[float]]) -> Optional[float]:
    return series[-1] if series and series[-1] is not None else None


def _round(v: Optional[float], digits: int = 6) -> Optional[float]:
    return None if v is None else round(v, digits)


def swing_levels(highs: List[float], lows: List[float], close: float, lookback: int = 120, wing: int = 2) -> Dict[str, Optional[float]]:
    """Nearest swing high above and swing low below the close (a bar higher/lower than `wing` bars
    on each side). Falls back to the 20-bar extremes when no swing point qualifies."""
    n = len(highs)
    start = max(wing, n - lookback)
    peaks = [highs[i] for i in range(start, n - wing) if all(highs[i] > highs[j] for j in range(i - wing, i + wing + 1) if j != i)]
    troughs = [lows[i] for i in range(start, n - wing) if all(lows[i] < lows[j] for j in range(i - wing, i + wing + 1) if j != i)]
    above = [p for p in peaks if p > close]
    below = [t for t in troughs if t < close]
    resistance = min(above) if above else (max(highs[-20:]) if max(highs[-20:]) > close else None)
    support = max(below) if below else (min(lows[-20:]) if min(lows[-20:]) < close else None)
    return {"support": support, "resistance": resistance}


def candle_pattern(o: List[float], h: List[float], l: List[float], c: List[float]) -> str:
    """Shape of the last closed candle (with the one before it for engulfing patterns)."""
    body = abs(c[-1] - o[-1])
    rng = h[-1] - l[-1]
    if rng <= 0:
        return "flat"
    upper, lower = h[-1] - max(o[-1], c[-1]), min(o[-1], c[-1]) - l[-1]
    if len(c) >= 2:
        pb_lo, pb_hi = min(o[-2], c[-2]), max(o[-2], c[-2])
        if c[-1] > o[-1] and c[-2] < o[-2] and min(o[-1], c[-1]) <= pb_lo and max(o[-1], c[-1]) >= pb_hi:
            return "bullish_engulfing"
        if c[-1] < o[-1] and c[-2] > o[-2] and min(o[-1], c[-1]) <= pb_lo and max(o[-1], c[-1]) >= pb_hi:
            return "bearish_engulfing"
    if body <= 0.1 * rng:
        return "doji"
    if lower >= 2 * body and upper <= 0.5 * body + 0.1 * rng:
        return "hammer"
    if upper >= 2 * body and lower <= 0.5 * body + 0.1 * rng:
        return "shooting_star"
    return "bullish" if c[-1] > o[-1] else "bearish"


def volatility_state(atr_series: List[Optional[float]], lookback: int = 100) -> Dict[str, Optional[float]]:
    """Current ATR compared with its own average: low / normal / high / extreme."""
    values = [v for v in atr_series[-lookback:] if v is not None]
    if len(values) < 10 or not values[-1]:
        return {"atrAverage": None, "atrRatio": None, "state": None}
    avg = sum(values) / len(values)
    ratio = values[-1] / avg if avg > 0 else None
    state = None if ratio is None else "extreme" if ratio > 2.5 else "high" if ratio > 1.5 else "low" if ratio < 0.7 else "normal"
    return {"atrAverage": avg, "atrRatio": ratio, "state": state}


def market_analysis(p: Dict[str, Any]) -> Dict[str, Any]:
    """`emas`: three EMA periods (fast, mid, slow); 20/50/200 by default, 9/20/50 for scalping."""
    raw = p.get("candles") or []
    if len(raw) < 50:
        raise AnalysisError("at least 50 closed candles are needed for an analysis")
    periods = p.get("emas") or [20, 50, 200]
    if not (isinstance(periods, list) and len(periods) == 3 and all(isinstance(x, int) and 2 <= x <= 400 for x in periods) and periods[0] < periods[1] < periods[2]):
        raise AnalysisError("emas must be three increasing periods")
    c = _candles(raw)
    close = c["close"][-1]
    e20, e50, e200 = (_last(ind.ema(c["close"], n)) for n in periods)
    rsi = _last(ind.rsi(c["close"], 14))
    line, sig, hist = ind.macd(c["close"], 12, 26, 9)
    atr_series = atr(c["high"], c["low"], c["close"], 14)
    a = _last(atr_series)
    vol = volatility_state(atr_series)
    prev_atr = atr_series[-2] if len(atr_series) > 1 else None
    if e200 is not None and e20 is not None and e50 is not None and close > e200 and e20 > e50 > e200:
        trend = "up"
    elif e200 is not None and e20 is not None and e50 is not None and close < e200 and e20 < e50 < e200:
        trend = "down"
    else:
        trend = "sideways"
    h = _last(hist)
    momentum = None if h is None else ("rising" if h > 0 else "falling" if h < 0 else "flat")
    levels = swing_levels(c["high"], c["low"], close)
    return {
        "time": c["time"][-1],
        "close": close,
        "trend": trend,
        "emaPeriods": periods,
        "emaFast": _round(e20), "emaMid": _round(e50), "emaSlow": _round(e200),
        "rsi": _round(rsi, 2),
        "macd": {"line": _round(_last(line)), "signal": _round(_last(sig)), "histogram": _round(h)},
        "momentum": momentum,
        "atr": _round(a),
        "atrAverage": _round(vol["atrAverage"]),
        "volatility": vol["state"],
        # range of the last candle in ATRs: a spike (news) shows here first
        "lastRangeAtr": _round((c["high"][-1] - c["low"][-1]) / prev_atr, 2) if prev_atr else None,
        "vwap": _round(_last(vwap(c))),
        "support": _round(levels["support"]),
        "resistance": _round(levels["resistance"]),
        "pattern": candle_pattern(c["open"], c["high"], c["low"], c["close"]),
        "enoughHistory": e200 is not None,
    }
