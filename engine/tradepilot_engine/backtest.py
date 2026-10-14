"""Deterministic bar-by-bar backtester (paper only).

Rules, chosen to avoid look-ahead bias:
* Signals are computed on a bar's close and executed at the NEXT bar's open.
* Stops/targets are checked intrabar against high/low; if both are touched in the
  same bar the stop is assumed to fill first (conservative).
* Fees are charged in basis points on notional, on entry and exit.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

from .strategies import StrategySpec, signals


class BacktestError(ValueError):
    pass


def _candles(raw: List[Dict[str, Any]]) -> Dict[str, List[float]]:
    if not isinstance(raw, list) or len(raw) < 30:
        raise BacktestError("at least 30 candles are required")
    cols: Dict[str, List[float]] = {"time": [], "open": [], "high": [], "low": [], "close": []}
    last_time = -math.inf
    for i, c in enumerate(raw):
        try:
            t, o, h, l, cl = (float(c[k]) for k in ("time", "open", "high", "low", "close"))
        except (KeyError, TypeError, ValueError):
            raise BacktestError(f"candle {i} is malformed")
        if not (l <= min(o, cl) and h >= max(o, cl) and l > 0):
            raise BacktestError(f"candle {i} has inconsistent OHLC values")
        if t <= last_time:
            raise BacktestError("candles must be sorted by time without duplicates")
        last_time = t
        for k, v in zip(("time", "open", "high", "low", "close"), (t, o, h, l, cl)):
            cols[k].append(v)
    return cols


def run_backtest(spec: StrategySpec, raw_candles: List[Dict[str, Any]], initial_equity: float = 10_000.0) -> Dict[str, Any]:
    if initial_equity <= 0:
        raise BacktestError("initial equity must be positive")
    c = _candles(raw_candles)
    n = len(c["close"])
    target = signals(spec, c["close"], c["high"], c["low"])
    fee = spec.risk["feeBps"] / 10_000.0
    size_frac = spec.risk["positionPct"] / 100.0
    sl = spec.risk["stopLossPct"] / 100.0
    tp = spec.risk["takeProfitPct"] / 100.0

    cash = initial_equity
    side = 0  # 1 long, -1 short
    qty = entry_price = 0.0
    entry_time = 0.0
    entry_fee = 0.0
    trades: List[Dict[str, Any]] = []
    equity_curve: List[List[float]] = []
    bars_in_market = 0
    # After a stop/target exit, do not re-enter the same direction until the signal changes.
    blocked_side = 0

    def close_position(i: int, price: float, reason: str) -> None:
        nonlocal cash, side, qty, entry_fee
        exit_fee = qty * price * fee
        pnl = side * qty * (price - entry_price) - entry_fee - exit_fee
        cash += side * qty * (price - entry_price) - exit_fee
        trades.append({
            "side": "long" if side == 1 else "short",
            "entryTime": entry_time,
            "entryPrice": round(entry_price, 8),
            "exitTime": c["time"][i],
            "exitPrice": round(price, 8),
            "quantity": round(qty, 8),
            "pnl": round(pnl, 2),
            "returnPct": round(100 * pnl / (qty * entry_price), 3),
            "exitReason": reason,
        })
        side, qty, entry_fee = 0, 0.0, 0.0

    for i in range(n):
        # 1) execute the previous bar's decision at this bar's open
        if i > 0:
            want = target[i - 1]
            if blocked_side and want != blocked_side:
                blocked_side = 0
            if blocked_side and want == blocked_side:
                want = 0
            if want != side:
                price = c["open"][i]
                if side != 0:
                    close_position(i, price, "signal")
                if want != 0:
                    equity = cash
                    side = want
                    qty = equity * size_frac / price
                    entry_price, entry_time = price, c["time"][i]
                    entry_fee = qty * price * fee
                    cash -= entry_fee

        # 2) intrabar risk exits
        if side != 0:
            if side == 1:
                stop = entry_price * (1 - sl) if sl > 0 else None
                take = entry_price * (1 + tp) if tp > 0 else None
                hit_stop = stop is not None and c["low"][i] <= stop
                hit_take = take is not None and c["high"][i] >= take
            else:
                stop = entry_price * (1 + sl) if sl > 0 else None
                take = entry_price * (1 - tp) if tp > 0 else None
                hit_stop = stop is not None and c["high"][i] >= stop
                hit_take = take is not None and c["low"][i] <= take
            if hit_stop or hit_take:
                prev_side = side
                if hit_stop:
                    # gap through the stop fills at the open
                    fill = min(stop, c["open"][i]) if prev_side == 1 else max(stop, c["open"][i])
                    close_position(i, fill, "stop_loss")
                else:
                    fill = max(take, c["open"][i]) if prev_side == 1 else min(take, c["open"][i])
                    close_position(i, fill, "take_profit")
                blocked_side = prev_side

        if side != 0:
            bars_in_market += 1
        mark = cash + (side * qty * (c["close"][i] - entry_price) if side != 0 else 0.0)
        equity_curve.append([c["time"][i], round(mark, 2)])

    if side != 0:
        close_position(n - 1, c["close"][n - 1], "end_of_data")
        equity_curve[-1][1] = round(cash, 2)

    return {
        "metrics": _metrics(equity_curve, trades, initial_equity, c, bars_in_market),
        "trades": trades,
        "equityCurve": equity_curve,
        "signals": target,
    }


def _metrics(curve, trades, initial, c, bars_in_market) -> Dict[str, Any]:
    final = curve[-1][1]
    peak, max_dd = initial, 0.0
    returns: List[float] = []
    prev = initial
    for _, eq in curve:
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak if peak > 0 else 0.0)
        returns.append((eq - prev) / prev if prev > 0 else 0.0)
        prev = eq
    wins = [t for t in trades if t["pnl"] > 0]
    gross_win = sum(t["pnl"] for t in wins)
    gross_loss = -sum(t["pnl"] for t in trades if t["pnl"] < 0)
    n = len(curve)
    bar_seconds = (c["time"][-1] - c["time"][0]) / (n - 1) if n > 1 else 0
    bars_per_year = (365 * 86400 / bar_seconds) if bar_seconds > 0 else 0
    mean = sum(returns) / n
    var = sum((r - mean) ** 2 for r in returns) / (n - 1) if n > 1 else 0.0
    sharpe = (mean / math.sqrt(var)) * math.sqrt(bars_per_year) if var > 0 and bars_per_year > 0 else None
    return {
        "initialEquity": initial,
        "finalEquity": final,
        "totalReturnPct": round(100 * (final - initial) / initial, 3),
        "buyHoldReturnPct": round(100 * (c["close"][-1] - c["open"][0]) / c["open"][0], 3),
        "maxDrawdownPct": round(100 * max_dd, 3),
        "trades": len(trades),
        "winRatePct": round(100 * len(wins) / len(trades), 2) if trades else None,
        "profitFactor": round(gross_win / gross_loss, 3) if gross_loss > 0 else None,
        "avgTradePct": round(sum(t["returnPct"] for t in trades) / len(trades), 3) if trades else None,
        "sharpe": round(sharpe, 3) if sharpe is not None else None,
        "exposurePct": round(100 * bars_in_market / n, 2),
        "bars": n,
    }
