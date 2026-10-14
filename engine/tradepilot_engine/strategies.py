"""Strategy definitions, parameter validation and signal generation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from . import indicators

# type -> {param: (min, max, default)}
STRATEGY_TYPES: Dict[str, Dict[str, tuple]] = {
    "sma_cross": {"fast": (2, 200, 10), "slow": (3, 400, 30)},
    "ema_cross": {"fast": (2, 200, 12), "slow": (3, 400, 26)},
    "rsi_reversion": {"period": (2, 100, 14), "oversold": (5, 50, 30), "overbought": (50, 95, 70)},
    "breakout": {"lookback": (5, 200, 20)},
}

RISK_LIMITS = {
    "positionPct": (1, 100, 10),  # % of equity per position
    "stopLossPct": (0, 50, 2),  # 0 disables
    "takeProfitPct": (0, 200, 4),  # 0 disables
    "feeBps": (0, 100, 5),
}


class ValidationError(ValueError):
    def __init__(self, errors: Dict[str, str]):
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


@dataclass(frozen=True)
class StrategySpec:
    type: str
    params: Dict[str, float]
    risk: Dict[str, float]
    allow_short: bool


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def validate(spec: Dict[str, Any]) -> StrategySpec:
    errors: Dict[str, str] = {}
    stype = spec.get("type")
    if stype not in STRATEGY_TYPES:
        raise ValidationError({"type": f"unknown strategy type {stype!r}"})

    params: Dict[str, float] = {}
    raw_params = spec.get("params") or {}
    for name, (lo, hi, default) in STRATEGY_TYPES[stype].items():
        value = _num(raw_params.get(name, default))
        if value is None or not (lo <= value <= hi):
            errors[f"params.{name}"] = f"must be a number between {lo} and {hi}"
        else:
            params[name] = value

    risk: Dict[str, float] = {}
    raw_risk = spec.get("risk") or {}
    for name, (lo, hi, default) in RISK_LIMITS.items():
        value = _num(raw_risk.get(name, default))
        if value is None or not (lo <= value <= hi):
            errors[f"risk.{name}"] = f"must be a number between {lo} and {hi}"
        else:
            risk[name] = value

    if stype in ("sma_cross", "ema_cross") and "fast" in params and "slow" in params and params["fast"] >= params["slow"]:
        errors["params.fast"] = "fast period must be shorter than slow period"
    if stype == "rsi_reversion" and params.get("oversold", 0) >= params.get("overbought", 100):
        errors["params.oversold"] = "oversold must be below overbought"

    if errors:
        raise ValidationError(errors)
    return StrategySpec(type=stype, params=params, risk=risk, allow_short=bool(spec.get("allowShort", False)))


def signals(spec: StrategySpec, closes: List[float], highs: List[float], lows: List[float]) -> List[int]:
    """Target position per bar, decided on that bar's close: 1 long, -1 short, 0 flat, None = hold."""
    n = len(closes)
    out: List[int] = [0] * n
    p = spec.params
    if spec.type in ("sma_cross", "ema_cross"):
        fn = indicators.sma if spec.type == "sma_cross" else indicators.ema
        fast, slow = fn(closes, int(p["fast"])), fn(closes, int(p["slow"]))
        for i in range(n):
            if fast[i] is None or slow[i] is None:
                continue
            out[i] = 1 if fast[i] > slow[i] else (-1 if spec.allow_short else 0)
    elif spec.type == "rsi_reversion":
        r = indicators.rsi(closes, int(p["period"]))
        state = 0
        for i in range(n):
            if r[i] is not None:
                if r[i] < p["oversold"]:
                    state = 1
                elif r[i] > p["overbought"]:
                    state = -1 if spec.allow_short else 0
                elif state == 1 and r[i] >= 50:
                    state = 0
                elif state == -1 and r[i] <= 50:
                    state = 0
            out[i] = state
    elif spec.type == "breakout":
        look = int(p["lookback"])
        hi, lo = indicators.rolling_max(highs, look), indicators.rolling_min(lows, look)
        state = 0
        for i in range(1, n):
            prev_hi, prev_lo = hi[i - 1], lo[i - 1]
            if prev_hi is not None and closes[i] > prev_hi:
                state = 1
            elif prev_lo is not None and closes[i] < prev_lo:
                state = -1 if spec.allow_short else 0
            out[i] = state
    return out
