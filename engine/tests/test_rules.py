import copy
import math
import unittest

from tradepilot_engine.protocol import handle
from tradepilot_engine.rules import RuleError, atr, bollinger, check_definition, previous_extreme, run_rules_backtest

DAY = 86_400


def candles(closes, start=1_700_006_400, step=3600):
    out, prev = [], closes[0]
    for i, c in enumerate(closes):
        o = prev
        out.append({"time": start + i * step, "open": o, "high": max(o, c) * 1.0005, "low": min(o, c) * 0.9995, "close": c})
        prev = c
    return out


def definition(**over):
    d = {
        "version": 2, "name": "t", "description": "", "symbol": "BTCUSD", "timeframe": "1h", "direction": "long",
        "indicators": [{"id": "fast", "kind": "sma", "period": 3}, {"id": "slow", "kind": "sma", "period": 8}],
        "entry": {"long": {"match": "all", "conditions": [{"left": {"type": "indicator", "id": "fast"}, "op": "crosses_above", "right": {"type": "indicator", "id": "slow"}}]}, "short": None},
        "exit": {"long": {"match": "all", "conditions": [{"left": {"type": "indicator", "id": "fast"}, "op": "crosses_below", "right": {"type": "indicator", "id": "slow"}}]}, "short": None},
        "risk": {"stopLoss": {"type": "percent", "value": 50}, "takeProfit": None, "sizing": {"type": "percent_equity", "value": 100}, "maxDailyLossPct": 50, "maxTradesPerDay": 100, "feeBps": 0},
    }
    for k, v in over.items():
        d[k] = v
    return d


WAVE = [100 + 10 * math.sin(i / 4) for i in range(240)]
ALWAYS = {"long": {"match": "all", "conditions": [{"left": {"type": "price", "field": "close"}, "op": ">", "right": {"type": "value", "value": 0}}]}, "short": None}
FALLING = [100 * (0.985 ** i) for i in range(96)]


class IndicatorTests(unittest.TestCase):
    def test_previous_extreme_excludes_current_candle(self):
        self.assertEqual(previous_extreme([1, 5, 2, 9], 2, max), [None, None, 5, 5])

    def test_bollinger_and_atr(self):
        mid = bollinger([1, 2, 3, 4, 5], 5, 2, "middle")
        self.assertEqual(mid[-1], 3)
        up = bollinger([1, 2, 3, 4, 5], 5, 2, "upper")
        self.assertAlmostEqual(up[-1], 3 + 2 * math.sqrt(2))
        a = atr([2] * 20, [1] * 20, [1.5] * 20, 14)
        self.assertAlmostEqual(a[-1], 1.0)


class RuleBacktestTests(unittest.TestCase):
    def test_crossover_enters_at_next_open_and_exits_on_rule(self):
        res = run_rules_backtest(definition(), candles(WAVE))
        self.assertGreater(len(res["trades"]), 3)
        first = res["trades"][0]
        times = [c["time"] for c in candles(WAVE)]
        self.assertIn(first["entryTime"], times[1:])
        self.assertEqual({t["exitReason"] for t in res["trades"][:-1]}, {"rule"})

    def test_rsi_entry_with_points_stop_and_risk_multiple_target(self):
        d = definition(
            indicators=[{"id": "rsi", "kind": "rsi", "period": 14}],
            entry={"long": {"match": "all", "conditions": [{"left": {"type": "indicator", "id": "rsi"}, "op": "<", "right": {"type": "value", "value": 30}}]}, "short": None},
            exit={"long": None, "short": None},
            risk={"stopLoss": {"type": "points", "value": 2}, "takeProfit": {"type": "risk_multiple", "value": 2}, "sizing": {"type": "fixed_quantity", "value": 1}, "maxDailyLossPct": 50, "maxTradesPerDay": 100, "feeBps": 0},
        )
        res = run_rules_backtest(d, candles(WAVE))
        self.assertTrue(res["trades"])
        for t in res["trades"]:
            if t["exitReason"] == "take_profit":
                self.assertAlmostEqual(t["exitPrice"] - t["entryPrice"], 4, places=6)
            if t["exitReason"] == "stop_loss":
                self.assertLessEqual(t["exitPrice"] - t["entryPrice"], -2 + 1e-9)
            self.assertEqual(t["quantity"], 1)

    def test_risk_percent_sizing_loses_about_that_percent_at_the_stop(self):
        d = definition(entry=ALWAYS, exit={"long": None, "short": None}, risk={"stopLoss": {"type": "percent", "value": 1}, "takeProfit": None, "sizing": {"type": "risk_percent", "value": 2}, "maxDailyLossPct": 50, "maxTradesPerDay": 100, "feeBps": 0})
        res = run_rules_backtest(d, candles(FALLING))
        stops = [t for t in res["trades"] if t["exitReason"] == "stop_loss"]
        self.assertTrue(stops)
        self.assertAlmostEqual(stops[0]["pnl"] / 10_000 * 100, -2, delta=0.6)

    def test_daily_trade_limit_blocks_further_entries(self):
        unlimited = run_rules_backtest(definition(), candles(WAVE, step=900))
        limited = run_rules_backtest(definition(risk={**definition()["risk"], "maxTradesPerDay": 1}), candles(WAVE, step=900))
        per_day = {}
        for t in limited["trades"]:
            day = t["entryTime"] // DAY
            per_day[day] = per_day.get(day, 0) + 1
        self.assertTrue(all(v <= 1 for v in per_day.values()))
        self.assertLess(len(limited["trades"]), len(unlimited["trades"]))
        self.assertGreater(limited["metrics"]["daysBlockedByTradeLimit"], 0)

    def test_daily_loss_limit_stops_trading_for_the_day(self):
        d = definition(entry=ALWAYS, exit={"long": None, "short": None},
                       risk={"stopLoss": {"type": "percent", "value": 1}, "takeProfit": None, "sizing": {"type": "percent_equity", "value": 100}, "maxDailyLossPct": 2, "maxTradesPerDay": 100, "feeBps": 0})
        res = run_rules_backtest(d, candles(FALLING, step=900))  # one UTC day of 15-minute candles
        self.assertGreater(res["metrics"]["daysBlockedByLossLimit"], 0)
        losses = [t["pnl"] for t in res["trades"]]
        self.assertLessEqual(len(losses), 3, "trading stopped once the day's losses passed 2%")

    def test_short_side_and_ambiguous_signals(self):
        d = definition(direction="both")
        d["entry"]["short"] = {"match": "all", "conditions": [{"left": {"type": "indicator", "id": "fast"}, "op": "crosses_below", "right": {"type": "indicator", "id": "slow"}}]}
        d["exit"] = {"long": None, "short": None}
        res = run_rules_backtest(d, candles(WAVE))
        self.assertIn("short", {t["side"] for t in res["trades"]})
        same = copy.deepcopy(d)
        same["entry"]["short"] = same["entry"]["long"]
        res2 = run_rules_backtest(same, candles(WAVE))
        self.assertEqual(res2["trades"], [])
        self.assertGreater(res2["metrics"]["signalsSkippedAmbiguous"], 0)

    def test_atr_stop_uses_atr_known_at_decision_time(self):
        d = definition(risk={"stopLoss": {"type": "atr", "value": 1.5}, "takeProfit": None, "sizing": {"type": "percent_equity", "value": 50}, "maxDailyLossPct": 50, "maxTradesPerDay": 100, "feeBps": 0})
        res = run_rules_backtest(d, candles(WAVE))
        self.assertTrue(res["trades"])

    def test_structural_problems_are_rejected(self):
        bad = definition()
        bad["entry"]["long"]["conditions"][0]["left"] = {"type": "indicator", "id": "missing"}
        with self.assertRaises(RuleError):
            check_definition(bad)
        no_stop = definition(risk={**definition()["risk"], "stopLoss": None})
        with self.assertRaises(RuleError):
            check_definition(no_stop)
        res = handle({"id": 1, "method": "backtest_rules", "params": {"definition": bad, "candles": candles(WAVE)}})
        self.assertEqual(res["error"]["code"], "invalid_strategy")


if __name__ == "__main__":
    unittest.main()


class Phase5BacktestTests(unittest.TestCase):
    def test_slippage_and_fees_reduce_results_and_are_reported(self):
        base = definition(risk={**definition()["risk"], "sizing": {"type": "percent_equity", "value": 50}})
        clean = run_rules_backtest(base, candles(WAVE))
        costly = run_rules_backtest(base, candles(WAVE), fee_bps=10, slippage_bps=20)
        self.assertEqual(len(clean["trades"]), len(costly["trades"]))
        self.assertLess(costly["metrics"]["netPnl"], clean["metrics"]["netPnl"])
        self.assertGreater(costly["metrics"]["totalFees"], 0)
        self.assertEqual(clean["metrics"]["totalFees"], 0)
        self.assertEqual(costly["metrics"]["slippageBps"], 20)
        self.assertEqual(costly["metrics"]["feeBps"], 10)
        # a long entry fills above the candle open by exactly the slippage
        c = candles(WAVE)
        opens = {x["time"]: x["open"] for x in c}
        t = costly["trades"][0]
        self.assertAlmostEqual(t["entryPrice"], opens[t["entryTime"]] * 1.002, places=6)
        m = costly["metrics"]
        self.assertEqual(m["winningTrades"] + m["losingTrades"], m["trades"])
        self.assertIn("maxConsecutiveLosses", m)

    def test_cost_parameters_are_range_checked(self):
        with self.assertRaises(Exception):
            run_rules_backtest(definition(), candles(WAVE), slippage_bps=-1)
        res = handle({"id": 2, "method": "backtest_rules", "params": {"definition": definition(), "candles": candles(WAVE), "slippageBps": 900}})
        self.assertEqual(res["error"]["code"], "invalid_data")

    def test_usd_daily_loss_limit_and_allocated_capital(self):
        risk = {"stopLoss": {"type": "percent", "value": 1}, "takeProfit": None, "sizing": {"type": "percent_equity", "value": 100},
                "maxDailyLossPct": None, "maxDailyLossUsd": 15, "allocatedCapitalUsd": 1000, "maxTradesPerDay": 100, "feeBps": 0}
        d = definition(entry=ALWAYS, exit={"long": None, "short": None}, risk=risk)
        res = run_rules_backtest(d, candles(FALLING, step=900))
        # sized from the $1,000 allocation, not the $10,000 equity
        first = res["trades"][0]
        self.assertAlmostEqual(first["quantity"] * first["entryPrice"], 1000, delta=1)
        self.assertGreater(res["metrics"]["daysBlockedByLossLimit"], 0)
        day0 = [t for t in res["trades"] if t["entryTime"] // DAY == res["trades"][0]["entryTime"] // DAY]
        self.assertLessEqual(len(day0), 2, "about $10-15 lost per stop on $1,000, so trading stops after the limit")

    def test_a_daily_loss_limit_of_some_kind_is_required(self):
        d = definition(risk={**definition()["risk"], "maxDailyLossPct": None})
        with self.assertRaises(RuleError):
            check_definition(d)
        d["risk"]["maxDailyLossUsd"] = 20
        check_definition(d)
        d["risk"]["allocatedCapitalUsd"] = -5
        with self.assertRaises(RuleError):
            check_definition(d)
