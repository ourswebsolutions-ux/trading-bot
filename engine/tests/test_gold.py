"""XAUUSD support in the engine: MACD, entry filters, broker lot rules, per-lot commission, analysis."""

import copy
import math
import unittest

from tradepilot_engine import indicators as ind
from tradepilot_engine.analysis import AnalysisError, candle_pattern, market_analysis
from tradepilot_engine.live import evaluate_session
from tradepilot_engine.rules import RuleError, check_definition, filter_block, in_session, run_rules_backtest

T0 = 1_780_000_000 - (1_780_000_000 % 86400)  # midnight UTC


def bars(n=600, step=3600, spread=0.3):
    out, p = [], 2600.0
    for i in range(n):
        d = math.sin(i / 25) * 1.5 + math.sin(i / 5) * 1.2 + 0.2
        o, c = p, p + d
        out.append({"time": T0 + i * step, "open": o, "high": max(o, c) + 1.5, "low": min(o, c) - 1.5, "close": c, "spread": spread})
        p = c
    return out


GOLD = {
    "version": 2, "venue": "mt5", "name": "gold", "description": "", "symbol": "XAUUSD", "timeframe": "1h", "direction": "both",
    "indicators": [
        {"id": "ema_20", "kind": "ema", "period": 20}, {"id": "ema_50", "kind": "ema", "period": 50},
        {"id": "macd", "kind": "macd_line", "period": 12, "slow": 26, "signal": 9}, {"id": "sig", "kind": "macd_signal", "period": 12, "slow": 26, "signal": 9},
    ],
    "entry": {
        "long": {"match": "all", "conditions": [{"left": {"type": "indicator", "id": "ema_20"}, "op": ">", "right": {"type": "indicator", "id": "ema_50"}}, {"left": {"type": "indicator", "id": "macd"}, "op": "crosses_above", "right": {"type": "indicator", "id": "sig"}}]},
        "short": {"match": "all", "conditions": [{"left": {"type": "indicator", "id": "ema_20"}, "op": "<", "right": {"type": "indicator", "id": "ema_50"}}, {"left": {"type": "indicator", "id": "macd"}, "op": "crosses_below", "right": {"type": "indicator", "id": "sig"}}]},
    },
    "exit": {"long": None, "short": None},
    "risk": {"stopLoss": {"type": "atr", "value": 1.5}, "takeProfit": {"type": "risk_multiple", "value": 2}, "sizing": {"type": "risk_percent", "value": 0.5}, "maxDailyLossPct": 2, "maxTradesPerDay": 10, "feeBps": 0},
}
MT5 = {"point_value": 1.0, "units_per_lot": 100.0}


class MacdTests(unittest.TestCase):
    def test_macd_matches_ema_definition(self):
        closes = [100 + math.sin(i / 3) * 5 + i * 0.1 for i in range(120)]
        line, sig, hist = ind.macd(closes, 12, 26, 9)
        e12, e26 = ind.ema(closes, 12), ind.ema(closes, 26)
        self.assertIsNone(line[24])
        self.assertAlmostEqual(line[60], e12[60] - e26[60], places=12)
        first = next(i for i, v in enumerate(line) if v is not None)
        self.assertIsNone(sig[first + 7])
        self.assertAlmostEqual(sig[first + 8], sum(line[first : first + 9]) / 9, places=12)
        self.assertAlmostEqual(hist[90], line[90] - sig[90], places=12)

    def test_macd_parameters_are_validated(self):
        d = copy.deepcopy(GOLD)
        d["indicators"][2]["slow"] = 10  # not above the fast period
        with self.assertRaises(RuleError):
            check_definition(d)


class FilterTests(unittest.TestCase):
    def test_session_window_including_overnight(self):
        self.assertTrue(in_session(T0 + 9 * 3600, {"start": "07:00", "end": "20:00"}))
        self.assertFalse(in_session(T0 + 21 * 3600, {"start": "07:00", "end": "20:00"}))
        self.assertTrue(in_session(T0 + 23 * 3600, {"start": "22:00", "end": "06:00"}))
        self.assertFalse(in_session(T0 + 12 * 3600, {"start": "22:00", "end": "06:00"}))

    def test_filter_reasons(self):
        f = {"maxSpread": 0.5, "session": {"start": "07:00", "end": "20:00"}}
        self.assertIsNone(filter_block(f, 0.3, T0 + 8 * 3600))
        self.assertIn("spread", filter_block(f, 0.8, T0 + 8 * 3600))
        self.assertIn("unknown", filter_block(f, None, T0 + 8 * 3600))
        self.assertIn("session", filter_block(f, 0.3, T0 + 3 * 3600))

    def test_invalid_filters_are_rejected(self):
        for bad in ({"maxSpread": 0}, {"session": {"start": "25:00", "end": "01:00"}}, {"session": {"start": "07:00", "end": "07:00"}}):
            d = dict(GOLD, filters=bad)
            with self.assertRaises(RuleError):
                check_definition(d)

    def test_live_evaluation_blocks_wide_spreads_and_closed_sessions(self):
        candles = bars(300)
        params = {
            "definition": dict(GOLD, filters={"maxSpread": 0.5}), "risk": {"configured": True, "maxExposurePct": 500, "maxOpenPositions": 2, "accountMaxDailyLossPct": 5, "maxOrderNotionalUsd": 1e6},
            "session": {"status": "running", "position": None, "dayTrades": 0, "dayRealizedPnl": 0, "dayStartEquity": 10_000, "lastSignalCandle": None},
            "account": {"equity": 10_000, "openExposureUsd": 0, "openPositions": 0, "dayStartEquity": 10_000, "dayRealizedPnl": 0},
            "instrument": {"valuePerPoint": 100, "unitsPerVolume": 1, "volumeStep": 0.01, "volumeMin": 0.01, "volumeMax": 100, "volumeUnit": "lots", "tickSize": 0.01},
        }
        # find a candle where the rules fire
        for end in range(100, 300):
            p = dict(params, candles=candles[:end], quote={"mark": candles[end - 1]["close"], "bid": candles[end - 1]["close"], "ask": candles[end - 1]["close"] + 0.25})
            r = evaluate_session(copy.deepcopy(p))
            if r["intent"]["action"].startswith("open_"):
                break
        else:
            self.fail("no signal in the test series")
        self.assertEqual(r["blockedBy"], [])
        wide = evaluate_session(dict(copy.deepcopy(p), quote={"mark": p["quote"]["mark"], "bid": p["quote"]["bid"], "ask": p["quote"]["bid"] + 0.9}))
        self.assertEqual(wide["intent"]["action"], "none")
        self.assertTrue(any("spread" in b for b in wide["blockedBy"]))
        night = copy.deepcopy(p)
        night["definition"]["filters"] = {"session": {"start": "07:00", "end": "08:00"}}
        night["now"] = T0 + 3 * 3600
        self.assertTrue(any("session" in b for b in evaluate_session(night)["blockedBy"]))


class LotRulesTests(unittest.TestCase):
    def test_sizes_follow_the_broker_lot_step_and_never_round_up(self):
        r = run_rules_backtest(GOLD, bars(), 10_000, **MT5, volume_step=0.01, volume_min=0.01, volume_max=100)
        self.assertGreater(r["metrics"]["trades"], 0)
        for t in r["trades"]:
            lots = t["quantity"] / 100
            self.assertAlmostEqual(lots, round(lots, 2), places=9)
        free = run_rules_backtest(GOLD, bars(), 10_000, **MT5)
        # unrounded sizes are never smaller than the rounded ones (rounding only goes down)
        for a, b in zip(r["trades"], free["trades"]):
            self.assertLessEqual(a["quantity"], b["quantity"] + 1e-9)

    def test_signals_below_the_minimum_lot_are_skipped(self):
        r = run_rules_backtest(GOLD, bars(), 100, **MT5, volume_step=0.01, volume_min=0.01)
        self.assertEqual(r["metrics"]["trades"], 0)
        self.assertGreater(r["metrics"]["signalsSkippedBelowMinVolume"], 0)

    def test_commission_per_lot_is_charged_per_side(self):
        d = copy.deepcopy(GOLD)
        d["risk"]["sizing"] = {"type": "fixed_quantity", "value": 0.1}
        free = run_rules_backtest(d, bars(), 10_000, **MT5)
        paid = run_rules_backtest(d, bars(), 10_000, **MT5, commission_per_lot=3.5)
        n = free["metrics"]["trades"]
        self.assertGreater(n, 0)
        self.assertAlmostEqual(paid["metrics"]["totalFees"] - free["metrics"]["totalFees"], n * 2 * 3.5 * 0.1, places=6)


class AnalysisTests(unittest.TestCase):
    def test_trend_and_levels(self):
        up = [{"time": T0 + i * 3600, "open": 2000 + i, "high": 2001.5 + i, "low": 1999 + i, "close": 2000.8 + i} for i in range(260)]
        a = market_analysis({"candles": up})
        self.assertEqual(a["trend"], "up")
        self.assertTrue(a["enoughHistory"])
        a2 = market_analysis({"candles": bars(400)})
        if a2["support"] is not None:
            self.assertLess(a2["support"], a2["close"])
        if a2["resistance"] is not None:
            self.assertGreater(a2["resistance"], a2["close"])
        with self.assertRaises(AnalysisError):
            market_analysis({"candles": up[:20]})

    def test_candle_patterns(self):
        self.assertEqual(candle_pattern([10, 9.3], [10.2, 11.2], [9.3, 9.2], [9.4, 11.0]), "bullish_engulfing")
        self.assertEqual(candle_pattern([9.8], [10.25], [8.5], [10.2]), "hammer")
        self.assertEqual(candle_pattern([10], [10.5], [9.5], [10.02]), "doji")


def walk(n=3000, seed=7, step=300):
    """Seeded random walk with trending regimes (M5 gold-like candles)."""
    x = seed
    def rnd():
        nonlocal x
        x = (x * 1664525 + 1013904223) % 4294967296
        return x / 4294967296
    out, p, drift = [], 2600.0, 0.0
    for i in range(n):
        if i % 150 == 0:
            drift = (rnd() - 0.5) * 0.5
        o = p
        c = p + drift + (rnd() - 0.5) * 1.6
        out.append({"time": T0 + i * step, "open": o, "high": max(o, c) + rnd() * 0.6, "low": min(o, c) - rnd() * 0.6, "close": c, "spread": 0.3, "volume": 50 + int(rnd() * 100)})
        p = c
    return out


def scalp(**risk):
    d = copy.deepcopy(GOLD)
    d["timeframe"] = "5m"
    d["indicators"] += [{"id": "t20", "kind": "ema", "period": 20, "timeframe": "15m"}, {"id": "t50", "kind": "ema", "period": 50, "timeframe": "15m"}]
    for side, op in (("long", ">"), ("short", "<")):
        d["entry"][side]["conditions"].append({"left": {"type": "indicator", "id": "t20"}, "op": op, "right": {"type": "indicator", "id": "t50"}})
    d["risk"].update(risk)
    return d


class HigherTimeframeTests(unittest.TestCase):
    def test_m15_values_use_completed_m15_candles_only(self):
        from tradepilot_engine.rules import compute_indicator
        from tradepilot_engine.backtest import _candles
        c = _candles(walk(300))
        htf = compute_indicator({"id": "x", "kind": "sma", "period": 3, "timeframe": "15m"}, c)
        # M15 closes = close of every third M5 candle (the one ending at :15, :30, …)
        m15 = [c["close"][i] for i in range(2, 300, 3)]
        for i in range(300):
            done = (i + 1) // 3  # completed M15 candles at this M5 candle's close
            want = None if done < 3 else sum(m15[done - 3 : done]) / 3
            if want is None:
                self.assertIsNone(htf[i])
            else:
                self.assertAlmostEqual(htf[i], want, places=9)

    def test_higher_timeframe_must_be_a_multiple(self):
        d = scalp()
        d["indicators"][-1]["timeframe"] = "5m"
        with self.assertRaises(RuleError):
            check_definition(d)


class ScalpingControlsTests(unittest.TestCase):
    def run_bt(self, d, **kw):
        return run_rules_backtest(d, walk(), 10_000, **MT5, extra_metrics=True, **kw)

    def test_maximum_trade_duration(self):
        r = self.run_bt(scalp(maxTradeBars=3))
        self.assertGreater(r["metrics"]["timeExits"], 0)
        for t in r["trades"]:
            self.assertLessEqual(t["exitTime"] - t["entryTime"], 3 * 300)

    def test_cooldown_after_each_trade(self):
        r = self.run_bt(scalp(cooldownBars=6))
        times = [(t["entryTime"], t["exitTime"]) for t in r["trades"]]
        for (_, exit_t), (entry_t, _) in zip(times, times[1:]):
            self.assertGreaterEqual(entry_t - exit_t, 6 * 300)
        self.assertIn("signalsSkippedCooldown", r["metrics"])

    def test_losing_streak_stops_the_day(self):
        free = self.run_bt(scalp())
        capped = self.run_bt(scalp(maxConsecutiveLosses=1))
        self.assertLessEqual(capped["metrics"]["trades"], free["metrics"]["trades"])
        day_streaks = {}
        for t in capped["trades"]:
            day = int(t["entryTime"] // 86400)
            self.assertLess(day_streaks.get(day, 0), 1, "no entry after a loss on the same day")
            day_streaks[day] = day_streaks.get(day, 0) + (1 if t["pnl"] <= 0 else 0) if t["pnl"] <= 0 else 0

    def test_market_filters_and_events(self):
        d = scalp()
        d["filters"] = {"maxExtensionAtr": 0.2}
        r = self.run_bt(d)
        self.assertGreater(r["metrics"]["signalsSkippedMarket"], 0)
        d["filters"] = {"events": [{"start": "2026-05-27T00:00:00Z", "end": "2026-06-30T00:00:00Z", "label": "test window"}]}
        everything = run_rules_backtest(d, walk(), 10_000, **MT5)
        self.assertEqual(everything["metrics"]["trades"], 0)
        self.assertGreater(everything["metrics"]["signalsSkippedEvent"], 0)


class ScalpingLiveTests(unittest.TestCase):
    def params(self, d, end, **session):
        cs = walk(end)
        return {
            "definition": d, "candles": cs, "risk": {"configured": True, "maxExposurePct": 500, "maxOpenPositions": 2, "accountMaxDailyLossPct": 5, "maxOrderNotionalUsd": 1e6},
            "session": {"status": "running", "position": None, "dayTrades": 0, "dayRealizedPnl": 0, "dayStartEquity": 10_000, "lastSignalCandle": None, **session},
            "account": {"equity": 10_000, "openExposureUsd": 0, "openPositions": 0, "dayStartEquity": 10_000, "dayRealizedPnl": 0},
            "instrument": {"valuePerPoint": 100, "unitsPerVolume": 1, "volumeStep": 0.01, "volumeMin": 0.01, "volumeMax": 100, "volumeUnit": "lots", "tickSize": 0.01},
            "quote": {"mark": cs[-1]["close"], "bid": cs[-1]["close"], "ask": cs[-1]["close"] + 0.3},
        }

    def test_time_exit_streak_and_cooldown(self):
        d = scalp(maxTradeBars=4, maxConsecutiveLosses=2, cooldownBars=5)
        p = self.params(d, 600)
        last = p["candles"][-1]["time"]
        pos = {"side": "long", "contracts": 0.1, "entryPrice": 2600, "stopPrice": 1.0, "takePrice": 1e9, "entryTime": last - 3 * 300}
        held = evaluate_session(dict(p, session=dict(p["session"], position=pos)))
        self.assertEqual(held["intent"], {"action": "close", "reason": "max_duration", "contracts": 0.1})
        pos["entryTime"] = last - 1 * 300
        self.assertNotEqual(evaluate_session(dict(p, session=dict(p["session"], position=pos)))["intent"].get("reason"), "max_duration")
        # find a candle with an entry signal, then block it by the streak and by the cooldown
        for end in range(300, 3000, 7):
            q = self.params(d, end)
            if evaluate_session(copy.deepcopy(q))["intent"]["action"].startswith("open_"):
                break
        else:
            self.fail("no signal")
        streak = evaluate_session(dict(copy.deepcopy(q), session=dict(q["session"], consecutiveLosses=2)))
        self.assertTrue(any("in a row" in b for b in streak["blockedBy"]))
        recent = q["candles"][-1]["time"]
        cool = evaluate_session(dict(copy.deepcopy(q), session=dict(q["session"], lastExitTime=recent - 300)))
        self.assertTrue(any("cooling down" in b for b in cool["blockedBy"]))


if __name__ == "__main__":
    unittest.main()
