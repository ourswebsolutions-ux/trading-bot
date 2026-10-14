import io
import json
import math
import unittest

from tradepilot_engine import LIVE_TRADING_ENABLED, indicators
from tradepilot_engine.backtest import BacktestError, run_backtest
from tradepilot_engine.protocol import handle, serve
from tradepilot_engine.strategies import ValidationError, validate


def make_candles(closes, start=1_700_000_000, step=3600):
    out, prev = [], closes[0]
    for i, c in enumerate(closes):
        o = prev
        out.append({"time": start + i * step, "open": o, "high": max(o, c) * 1.001, "low": min(o, c) * 0.999, "close": c})
        prev = c
    return out


class IndicatorTests(unittest.TestCase):
    def test_sma(self):
        self.assertEqual(indicators.sma([1, 2, 3, 4, 5], 3), [None, None, 2.0, 3.0, 4.0])

    def test_ema_seeds_with_sma(self):
        out = indicators.ema([1, 2, 3, 4, 5], 3)
        self.assertEqual(out[:2], [None, None])
        self.assertAlmostEqual(out[2], 2.0)
        self.assertAlmostEqual(out[3], 3.0)

    def test_rsi_bounds(self):
        up = indicators.rsi(list(range(1, 40)), 14)
        self.assertEqual(up[14], 100.0)
        mixed = indicators.rsi([10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10], 14)
        self.assertTrue(0 < mixed[-1] < 100)


class ValidationTests(unittest.TestCase):
    def test_defaults_fill_in(self):
        spec = validate({"type": "sma_cross"})
        self.assertEqual(spec.params, {"fast": 10.0, "slow": 30.0})
        self.assertEqual(spec.risk["positionPct"], 10.0)

    def test_rejects_bad_params(self):
        with self.assertRaises(ValidationError) as ctx:
            validate({"type": "sma_cross", "params": {"fast": 50, "slow": 20}})
        self.assertIn("params.fast", ctx.exception.errors)
        with self.assertRaises(ValidationError):
            validate({"type": "nope"})
        with self.assertRaises(ValidationError):
            validate({"type": "breakout", "risk": {"positionPct": 500}})
        with self.assertRaises(ValidationError):
            validate({"type": "breakout", "params": {"lookback": True}})


class BacktestTests(unittest.TestCase):
    def test_trend_following_profits_in_uptrend_and_has_no_lookahead(self):
        closes = [100 + i for i in range(120)]
        spec = validate({"type": "sma_cross", "params": {"fast": 5, "slow": 20}, "risk": {"positionPct": 100, "stopLossPct": 0, "takeProfitPct": 0, "feeBps": 0}})
        res = run_backtest(spec, make_candles(closes))
        self.assertGreater(res["metrics"]["totalReturnPct"], 0)
        first = res["trades"][0]
        # signal appears on bar 19's close; entry happens at bar 20's open
        self.assertEqual(first["entryTime"], 1_700_000_000 + 20 * 3600)
        self.assertEqual(len(res["equityCurve"]), 120)

    def test_stop_loss_exit_and_fees(self):
        closes = [100 + i * 0.5 for i in range(40)] + [80 + i * 0.1 for i in range(20)]
        spec = validate({"type": "sma_cross", "params": {"fast": 3, "slow": 10}, "risk": {"positionPct": 50, "stopLossPct": 2, "takeProfitPct": 0, "feeBps": 10}})
        res = run_backtest(spec, make_candles(closes))
        reasons = {t["exitReason"] for t in res["trades"]}
        self.assertIn("stop_loss", reasons)
        self.assertLess(res["metrics"]["finalEquity"], 10_000 * 1.2)
        self.assertGreaterEqual(res["metrics"]["maxDrawdownPct"], 0)

    def test_metrics_are_finite(self):
        closes = [100 + 10 * math.sin(i / 5) for i in range(200)]
        for stype in ("sma_cross", "ema_cross", "rsi_reversion", "breakout"):
            res = run_backtest(validate({"type": stype, "allowShort": True}), make_candles(closes))
            for key, value in res["metrics"].items():
                if value is not None:
                    self.assertTrue(math.isfinite(value), f"{stype}.{key}")

    def test_rejects_bad_data(self):
        spec = validate({"type": "sma_cross"})
        with self.assertRaises(BacktestError):
            run_backtest(spec, make_candles([100] * 10))
        bad = make_candles([100 + i for i in range(40)])
        bad[5]["high"] = 1
        with self.assertRaises(BacktestError):
            run_backtest(spec, bad)


class ProtocolTests(unittest.TestCase):
    def test_live_trading_is_disabled(self):
        self.assertFalse(LIVE_TRADING_ENABLED)
        res = handle({"id": 1, "method": "place_live_order", "params": {}})
        self.assertEqual(res["error"]["code"], "live_trading_disabled")

    def test_serve_round_trip(self):
        stdin = io.StringIO(
            json.dumps({"id": 1, "method": "health"}) + "\n" + "not json\n" + json.dumps({"id": 2, "method": "validate_strategy", "params": {"strategy": {"type": "breakout"}}}) + "\n"
        )
        stdout = io.StringIO()
        serve(stdin, stdout)
        lines = [json.loads(l) for l in stdout.getvalue().splitlines()]
        self.assertEqual(lines[0]["result"]["liveTradingEnabled"], False)
        self.assertEqual(lines[1]["error"]["code"], "parse_error")
        self.assertTrue(lines[2]["result"]["valid"])

    def test_backtest_errors_are_structured(self):
        res = handle({"id": 3, "method": "backtest", "params": {"strategy": {"type": "sma_cross", "params": {"fast": 40, "slow": 10}}, "candles": []}})
        self.assertEqual(res["error"]["code"], "invalid_strategy")
        self.assertIn("params.fast", res["error"]["data"])


if __name__ == "__main__":
    unittest.main()
