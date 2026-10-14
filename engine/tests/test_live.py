import copy
import math
import unittest

from tradepilot_engine.live import LiveError, evaluate_session, protective_levels, round_to_tick
from tradepilot_engine.protocol import handle

START = 1_700_006_400


def candles(closes, step=3600):
    out, prev = [], closes[0]
    for i, c in enumerate(closes):
        out.append({"time": START + i * step, "open": prev, "high": max(prev, c) * 1.001, "low": min(prev, c) * 0.999, "close": c})
        prev = c
    return out


DEF = {
    "version": 2, "name": "rsi", "description": "", "symbol": "BTCUSD", "timeframe": "1h", "direction": "long",
    "indicators": [{"id": "rsi", "kind": "rsi", "period": 14}],
    "entry": {"long": {"match": "all", "conditions": [{"left": {"type": "indicator", "id": "rsi"}, "op": "<", "right": {"type": "value", "value": 30}}]}, "short": None},
    "exit": {"long": {"match": "all", "conditions": [{"left": {"type": "indicator", "id": "rsi"}, "op": ">", "right": {"type": "value", "value": 60}}]}, "short": None},
    "risk": {"stopLoss": {"type": "percent", "value": 2}, "takeProfit": {"type": "risk_multiple", "value": 2}, "sizing": {"type": "risk_percent", "value": 1}, "maxDailyLossPct": 3, "maxTradesPerDay": 2, "feeBps": 5},
}
RISK = {"configured": True, "maxExposurePct": 100, "maxOpenPositions": 2, "accountMaxDailyLossPct": 5, "maxOrderNotionalUsd": 100_000}
FALLING = [100 - i * 0.8 for i in range(60)]   # RSI deeply oversold on the last candle
RISING = [50 + i * 0.8 for i in range(60)]


def params(**over):
    p = {
        "definition": copy.deepcopy(DEF), "risk": dict(RISK), "candles": candles(FALLING),
        "session": {"status": "running", "position": None, "dayTrades": 0, "dayRealizedPnl": 0, "dayStartEquity": 10_000, "lastSignalCandle": None},
        "account": {"equity": 10_000, "openExposureUsd": 0, "openPositions": 0, "dayStartEquity": 10_000, "dayRealizedPnl": 0},
        "instrument": {"contractValue": 0.001, "tickSize": 0.5}, "quote": {"mark": FALLING[-1]}, "emergency": False,
    }
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(p.get(k), dict):
            p[k] = {**p[k], **v}
        else:
            p[k] = v
    return p


class EvaluateTests(unittest.TestCase):
    def test_entry_signal_sizes_by_risk_and_sets_protective_prices(self):
        r = evaluate_session(params())
        it = r["intent"]
        self.assertEqual(it["action"], "open_long")
        mark = FALLING[-1]
        # risk 1% of 10k = 100 USD over a 2% stop distance
        expected = math.floor(100 / (mark * 0.02) / 0.001)
        self.assertEqual(it["contracts"], min(expected, math.floor(10_000 / (mark * 0.001))))
        self.assertLess(it["stopPrice"], mark)
        self.assertGreater(it["takePrice"], mark)
        self.assertEqual(r["candleTime"], START + 59 * 3600)

    def test_no_duplicate_execution_of_the_same_signal(self):
        first = evaluate_session(params())
        again = evaluate_session(params(session={"lastSignalCandle": first["candleTime"]}))
        self.assertEqual(again["intent"]["action"], "none")
        self.assertIn("already handled", again["intent"]["reason"])

    def test_risk_controls_block_entries(self):
        cases = {
            "emergency stop": params(emergency=True),
            "paused": params(session={"status": "paused"}),
            "trades today": params(session={"dayTrades": 2}),
            "strategy daily loss": params(session={"dayRealizedPnl": -300}),
            "account daily loss": params(account={"dayRealizedPnl": -500}),
            "open positions": params(account={"openPositions": 2}),
            "equity": params(account={"equity": 0}),
        }
        for name, p in cases.items():
            r = evaluate_session(p)
            self.assertEqual(r["intent"]["action"], "none", name)
            self.assertTrue(r["blockedBy"], name)

    def test_caps_reduce_size_and_block_below_one_contract(self):
        r = evaluate_session(params(risk={**RISK, "maxOrderNotionalUsd": 300}))
        it = r["intent"]
        self.assertEqual(it["action"], "open_long")
        self.assertLessEqual(it["notionalUsd"], 300)
        self.assertTrue(it["notes"])
        tiny = evaluate_session(params(risk={**RISK, "maxOrderNotionalUsd": 0.01}))
        self.assertEqual(tiny["intent"]["action"], "none")
        full = evaluate_session(params(account={"openExposureUsd": 10_000}))
        self.assertEqual(full["intent"]["action"], "none", "no exposure room left")
        small_account = evaluate_session(params(account={"equity": 0.01}))
        self.assertIn("below one contract", " ".join(small_account["blockedBy"]))

    def test_position_exits_on_rule_stop_and_target(self):
        pos = {"side": "long", "contracts": 5, "entryPrice": 60, "stopPrice": 55, "takePrice": 80}
        rule = evaluate_session(params(candles=candles(RISING), quote={"mark": RISING[-1] if RISING[-1] < 80 else 70}, session={"position": pos}))
        self.assertEqual(rule["intent"]["action"], "close")
        self.assertEqual(rule["intent"]["reason"], "exit_rule")
        stop = evaluate_session(params(quote={"mark": 54}, session={"position": pos}))
        self.assertEqual(stop["intent"]["reason"], "stop_loss")
        take = evaluate_session(params(quote={"mark": 81}, session={"position": pos}))
        self.assertEqual(take["intent"]["reason"], "take_profit")
        hold = evaluate_session(params(quote={"mark": 60}, session={"position": pos}))
        self.assertEqual(hold["intent"]["action"], "none")

    def test_rejects_unconfigured_risk_and_invalid_strategies(self):
        with self.assertRaises(LiveError):
            evaluate_session(params(risk={"configured": False}))
        bad = copy.deepcopy(DEF)
        bad["risk"]["stopLoss"] = None
        with self.assertRaises(LiveError):
            evaluate_session(params(definition=bad))
        res = handle({"id": 1, "method": "session_evaluate", "params": params(risk={"configured": False})})
        self.assertEqual(res["error"]["code"], "invalid_session")

    def test_protective_levels_and_tick_rounding(self):
        lv = protective_levels(DEF, 1, 100.0, candles(FALLING), 0.5)
        self.assertEqual(lv["stopPrice"], 98.0)
        self.assertEqual(lv["takePrice"], 104.0)
        short = protective_levels(DEF, -1, 100.3, candles(FALLING), 0.5)
        self.assertGreaterEqual(short["stopPrice"], 100.3 * 1.02)
        self.assertEqual(round_to_tick(123.26, 0.05, "down"), 123.25)


if __name__ == "__main__":
    unittest.main()


class Phase5LiveTests(unittest.TestCase):
    def test_allocated_capital_caps_the_sizing_base(self):
        d = copy.deepcopy(DEF)
        d["risk"]["allocatedCapitalUsd"] = 2_000
        full = evaluate_session(params())["intent"]["contracts"]
        alloc = evaluate_session(params(definition=d))["intent"]["contracts"]
        self.assertAlmostEqual(alloc / full, 0.2, delta=0.02)
        # allocation above equity never sizes beyond the real equity
        d["risk"]["allocatedCapitalUsd"] = 1_000_000
        self.assertEqual(evaluate_session(params(definition=d))["intent"]["contracts"], full)

    def test_usd_daily_loss_limit_blocks_entries(self):
        d = copy.deepcopy(DEF)
        d["risk"]["maxDailyLossPct"] = None
        d["risk"]["maxDailyLossUsd"] = 20
        r = evaluate_session(params(definition=d, session={"dayRealizedPnl": -20.5}))
        self.assertEqual(r["intent"]["action"], "none")
        self.assertTrue(any("$20" in b for b in r["blockedBy"]))
        ok = evaluate_session(params(definition=d, session={"dayRealizedPnl": -19}))
        self.assertEqual(ok["intent"]["action"], "open_long")
