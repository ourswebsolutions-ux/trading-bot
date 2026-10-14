"""Technical indicators. Each returns a list aligned with the input (None until warmed up)."""

from __future__ import annotations

from typing import List, Optional, Sequence

Series = List[Optional[float]]


def sma(values: Sequence[float], period: int) -> Series:
    if period < 1:
        raise ValueError("period must be >= 1")
    out: Series = [None] * len(values)
    window = 0.0
    for i, v in enumerate(values):
        window += v
        if i >= period:
            window -= values[i - period]
        if i >= period - 1:
            out[i] = window / period
    return out


def ema(values: Sequence[float], period: int) -> Series:
    if period < 1:
        raise ValueError("period must be >= 1")
    out: Series = [None] * len(values)
    if len(values) < period:
        return out
    k = 2.0 / (period + 1)
    prev = sum(values[:period]) / period  # seed with the SMA of the first window
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values: Sequence[float], period: int = 14) -> Series:
    """Wilder's RSI."""
    if period < 1:
        raise ValueError("period must be >= 1")
    out: Series = [None] * len(values)
    if len(values) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        change = values[i] - values[i - 1]
        gains += max(change, 0.0)
        losses += max(-change, 0.0)
    avg_gain, avg_loss = gains / period, losses / period
    out[period] = _rsi_value(avg_gain, avg_loss)
    for i in range(period + 1, len(values)):
        change = values[i] - values[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
        out[i] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def rolling_max(values: Sequence[float], period: int) -> Series:
    return [None if i < period - 1 else max(values[i - period + 1 : i + 1]) for i in range(len(values))]


def rolling_min(values: Sequence[float], period: int) -> Series:
    return [None if i < period - 1 else min(values[i - period + 1 : i + 1]) for i in range(len(values))]
