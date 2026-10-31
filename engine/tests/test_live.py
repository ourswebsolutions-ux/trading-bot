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


# ---------- Phase 1: broker-neutral sizing ----------

def _reference_delta_intent(p):
    """Frozen copy of the whole-contract sizing and caps used before broker-neutral sizing
    (engine/tradepilot_engine/live.py at v1.0.0), applied to an entry the engine allows."""
    from tradepilot_engine.rules import sizing_base
    d, risk, account = p["definition"], p["risk"], p["account"]
    cv = float(p["instrument"]["contractValue"])
    mark = float(p["quote"]["mark"])
    levels = protective_levels(d, 1, mark, p["candles"], float(p["instrument"]["tickSize"]))
    sizing = d["risk"]["sizing"]
    equity = sizing_base(d["risk"], float(account["equity"]))
    if sizing["type"] == "percent_equity":
        qty = equity * sizing["value"] / 100 / mark
    elif sizing["type"] == "risk_percent":
        qty = equity * sizing["value"] / 100 / levels["stopDistance"]
    else:
        qty = float(sizing["value"])
    if not math.isfinite(qty) or qty <= 0:
        return {"blocked": ["position size computed as zero"]}
    contracts = int(math.floor(qty / cv + 1e-9))
    if contracts < 1:
        return {"blocked": [f"position size {qty:.6g} is below one contract ({cv})"]}
    notes = []
    unit_notional = cv * mark
    cap_order = int(math.floor(risk["maxOrderNotionalUsd"] / unit_notional + 1e-9))
    room = float(account["equity"]) * risk["maxExposurePct"] / 100 - float(account.get("openExposureUsd") or 0)
    cap_exposure = int(math.floor(room / unit_notional + 1e-9)) if room > 0 else 0
    allowed = min(contracts, cap_order, cap_exposure)
    if allowed < contracts:
        notes.append(f"size reduced from {contracts} to {allowed} contracts by {'order notional' if cap_order <= cap_exposure else 'exposure'} limit")
    if allowed < 1:
        return {"blocked": ["maximum order size or exposure limit leaves no room for one contract"]}
    return {"contracts": allowed, "notional": round(allowed * unit_notional, 2), "notes": notes}


def _actual(r):
    it = r["intent"]
    if it["action"] == "none":
        return {"blocked": r["blockedBy"]}
    return {"contracts": it["contracts"], "notional": it["notionalUsd"], "notes": it["notes"]}


class Phase1SizingTests(unittest.TestCase):
    def test_delta_sizing_is_identical_to_the_original_whole_contract_code(self):
        import random
        rng = random.Random(20261015)
        kinds = ["percent_equity", "risk_percent", "fixed_quantity"]
        checked = 0
        for i in range(3000):
            d = copy.deepcopy(DEF)
            kind = kinds[i % 3]
            d["risk"]["sizing"] = {"type": kind, "value": {"percent_equity": rng.uniform(0.1, 100), "risk_percent": rng.uniform(0.01, 3), "fixed_quantity": rng.uniform(0.0001, 5)}[kind]}
            d["risk"]["stopLoss"] = {"type": "percent", "value": rng.uniform(0.1, 10)}
            if rng.random() < 0.3:
                d["risk"]["allocatedCapitalUsd"] = rng.uniform(10, 50_000)
            cv = rng.choice([0.001, 0.01, 0.1, 1, 10, 0.0001, 0.003])
            equity = rng.uniform(50, 200_000)
            p = params(definition=d,
                       risk={**RISK, "maxOrderNotionalUsd": rng.uniform(5, 500_000), "maxExposurePct": rng.uniform(1, 500)},
                       account={"equity": equity, "openExposureUsd": rng.uniform(0, equity), "dayStartEquity": equity},
                       instrument={"contractValue": cv, "tickSize": 0.5})
            expected = _reference_delta_intent(p)
            legacy = evaluate_session(p)
            # the same instrument with the explicit broker-neutral Delta spec the desktop now sends
            explicit = evaluate_session(params(**{**p, "instrument": {"contractValue": cv, "tickSize": 0.5, "valuePerPoint": cv, "unitsPerVolume": cv, "volumeStep": 1, "volumeMin": 1, "volumeMax": None, "volumeUnit": "contracts"}}))
            self.assertEqual(_actual(legacy), expected, f"case {i}")
            self.assertEqual(_actual(explicit), expected, f"case {i} (explicit spec)")
            if "contracts" in expected:
                self.assertIs(type(legacy["intent"]["contracts"]), int, "Delta volumes stay whole ints")
                checked += 1
        self.assertGreater(checked, 500, "enough cases reached an order")

    def _forex(self, **inst):
        # EUR/USD-style lot on a USD account: 100,000 units per lot, so a 1.0 move is worth $100,000 per lot
        return {"contractValue": None, "tickSize": 0.00001, "valuePerPoint": 100_000, "unitsPerVolume": 100_000,
                "volumeStep": 0.01, "volumeMin": 0.01, "volumeMax": 50, "volumeUnit": "lots", **inst}

    def _fx_params(self, sizing, stop_pct=0.2, mark=1.1, **over):
        d = copy.deepcopy(DEF)
        d["risk"]["sizing"] = sizing
        d["risk"]["stopLoss"] = {"type": "percent", "value": stop_pct}
        closes = [mark * (1 + 0.0008 * (59 - i)) for i in range(60)]  # falls to the mark: RSI entry fires
        base = dict(definition=d, candles=candles(closes), quote={"mark": mark}, instrument=self._forex(),
                    risk={**RISK, "maxOrderNotionalUsd": 10_000_000, "maxExposurePct": 1000},
                    account={"equity": 10_000, "openExposureUsd": 0, "dayStartEquity": 10_000})
        base.update(over)
        return params(**base)

    def test_fractional_lots_by_risk_and_equity(self):
        # risk 1% of $10,000 = $100 over a 0.2% stop at 1.1 (0.0022) → 100 / (0.0022 × 100,000) = 0.4545 → 0.45 lots
        r = evaluate_session(self._fx_params({"type": "risk_percent", "value": 1}))
        self.assertEqual(r["intent"]["action"], "open_long")
        self.assertEqual(r["intent"]["contracts"], 0.45)
        self.assertAlmostEqual(r["intent"]["notionalUsd"], 0.45 * 100_000 * 1.1, places=2)
        # 50% of equity = $5,000 of EUR at 1.1 → 0.04545 lots → 0.04
        r2 = evaluate_session(self._fx_params({"type": "percent_equity", "value": 50}))
        self.assertEqual(r2["intent"]["contracts"], 0.04)
        # fixed quantity is in underlying units: 7,000 EUR = 0.07 lots, without float noise
        r3 = evaluate_session(self._fx_params({"type": "fixed_quantity", "value": 7_000}))
        self.assertEqual(r3["intent"]["contracts"], 0.07)
        self.assertEqual(repr(r3["intent"]["contracts"]), "0.07")

    def test_below_the_venue_minimum_is_blocked_with_a_clear_reason(self):
        r = evaluate_session(self._fx_params({"type": "fixed_quantity", "value": 500}))  # 0.005 lots
        self.assertEqual(r["intent"]["action"], "none")
        self.assertEqual(r["blockedBy"], ["position size 0.005 lots is below the minimum of 0.01 lots"])

    def test_caps_shrink_in_whole_steps_and_respect_the_venue_maximum(self):
        # order cap $20,000 at 1.1 → 0.1818 lots → 0.18
        r = evaluate_session(self._fx_params({"type": "risk_percent", "value": 1}, risk={**RISK, "maxOrderNotionalUsd": 20_000, "maxExposurePct": 1000}))
        self.assertEqual(r["intent"]["contracts"], 0.18)
        self.assertEqual(r["intent"]["notes"], ["size reduced from 0.45 to 0.18 lots by order notional limit"])
        # venue maximum 0.3 lots
        r2 = evaluate_session(self._fx_params({"type": "risk_percent", "value": 1}, instrument=self._forex(volumeMax=0.3)))
        self.assertEqual(r2["intent"]["contracts"], 0.3)
        self.assertEqual(r2["intent"]["notes"], ["size reduced from 0.45 to 0.3 lots by venue maximum limit"])
        # not even the minimum fits under the cap
        r3 = evaluate_session(self._fx_params({"type": "risk_percent", "value": 1}, risk={**RISK, "maxOrderNotionalUsd": 500, "maxExposurePct": 1000}))
        self.assertEqual(r3["blockedBy"], ["maximum order size or exposure limit leaves no room for the minimum of 0.01 lots"])

    def test_spec_helpers(self):
        from tradepilot_engine.live import round_volume_down, sizing_spec
        self.assertEqual(sizing_spec({"contractValue": 0.001})["volumeUnit"], "contracts")
        self.assertEqual(round_volume_down(2.9999999999, 1), 3, "within tolerance")
        self.assertEqual(round_volume_down(2.98, 1), 2)
        self.assertIs(type(round_volume_down(5.0, 1)), int)
        self.assertEqual(round_volume_down(0.3 * 3, 0.1), 0.9)
        self.assertEqual(round_volume_down(1.23456, 0.001), 1.234)
        self.assertEqual(round_volume_down(-1, 0.01), 0)


class Mt5LiveTests(unittest.TestCase):
    def test_pips_protective_levels_use_the_symbol_pip_size(self):
        d = copy.deepcopy(DEF)
        d["risk"]["stopLoss"] = {"type": "pips", "value": 20}
        d["risk"]["takeProfit"] = {"type": "pips", "value": 30}
        lv = protective_levels(d, 1, 1.10000, [], 0.00001, 0.0001)
        self.assertAlmostEqual(lv["stopPrice"], 1.09800, places=6)
        self.assertAlmostEqual(lv["takePrice"], 1.10300, places=6)
        short = protective_levels(d, -1, 150.000, [], 0.001, 0.01)
        self.assertAlmostEqual(short["stopPrice"], 150.200, places=6)
        with self.assertRaises(LiveError):
            protective_levels(d, 1, 1.1, [], 0.00001, None)

    def test_quoted_bid_ask_anchor_stops_at_the_fill_side(self):
        mark = FALLING[-1]
        with_quote = evaluate_session(params(quote={"mark": mark, "bid": mark - 0.5, "ask": mark + 0.5}))["intent"]
        mid_only = evaluate_session(params())["intent"]
        self.assertAlmostEqual(with_quote["stopPrice"], round_to_tick((mark + 0.5) * 0.98, 0.5, "down"), places=9)
        self.assertNotEqual(with_quote["stopPrice"], mid_only["stopPrice"], "a buy's stop is measured from the ask")
