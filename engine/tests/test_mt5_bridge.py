import json
import os
import subprocess
import sys
import unittest

from tests import fake_mt5
from tradepilot_mt5.bridge import BridgeError, Mt5Bridge
from tradepilot_mt5.protocol import Server, load_mt5

CONNECT = {"login": "51234567", "password": fake_mt5.PASSWORD, "server": "Broker-Demo", "path": "C:\\MT5\\terminal64.exe"}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        fake_mt5.reset()
        self.b = Mt5Bridge(fake_mt5)

    def test_connect_logs_in_and_never_returns_the_password(self):
        out = self.b.connect(dict(CONNECT))
        self.assertEqual(out["account"]["login"], 51234567)
        self.assertEqual(out["account"]["currency"], "USD")
        self.assertTrue(out["terminal"]["connected"])
        self.assertNotIn(fake_mt5.PASSWORD, json.dumps(out))
        kw = fake_mt5.state["init_kwargs"]
        self.assertEqual((kw["login"], kw["server"], kw["path"]), (51234567, "Broker-Demo", "C:\\MT5\\terminal64.exe"))

    def test_connect_failure_reports_the_terminal_error_without_the_password(self):
        with self.assertRaises(BridgeError) as cm:
            self.b.connect({**CONNECT, "password": "wrong-password"})
        self.assertEqual(cm.exception.code, "connect_failed")
        self.assertIn("Authorization failed (-6)", cm.exception.message)
        self.assertNotIn("wrong-password", cm.exception.message + json.dumps(cm.exception.data))
        with self.assertRaises(BridgeError):
            self.b.connect({**CONNECT, "login": "not-a-number"})

    def test_calls_before_connecting_are_refused(self):
        for m in ("account", "symbols", "positions"):
            with self.assertRaises(BridgeError) as cm:
                getattr(self.b, m)({})
            self.assertEqual(cm.exception.code, "not_connected")

    def test_symbols_ticks_and_rates(self):
        self.b.connect(dict(CONNECT))
        syms = self.b.symbols({})
        self.assertEqual({s["name"] for s in syms}, {"EURUSD", "USDJPY"})
        self.assertEqual(syms[0]["volume_step"], 0.01)
        info = self.b.symbol_info({"symbol": "USDJPY"})
        self.assertEqual(info["digits"], 3)
        with self.assertRaises(BridgeError) as cm:
            self.b.symbol_info({"symbol": "NOPE"})
        self.assertEqual(cm.exception.code, "unknown_symbol")
        ticks = self.b.ticks({"symbols": ["EURUSD", "NOPE"]})
        self.assertEqual(ticks["EURUSD"]["ask"], 1.08512)
        self.assertIsNone(ticks["NOPE"])
        rates = self.b.rates({"symbol": "EURUSD", "timeframe": "1h", "count": 5})
        self.assertEqual(len(rates), 5)
        self.assertEqual(set(rates[0]), {"time", "open", "high", "low", "close", "tick_volume", "spread", "real_volume"})
        self.assertIsInstance(rates[0]["time"], int)
        self.assertEqual(rates[1]["time"] - rates[0]["time"], 3600)
        with self.assertRaises(BridgeError):
            self.b.rates({"symbol": "EURUSD", "timeframe": "2h"})

    def test_order_requests_use_the_package_constants_and_are_sent_once(self):
        self.b.connect(dict(CONNECT))
        res = self.b.order_send({"request": {"action": "deal", "symbol": "EURUSD", "type": "buy", "volume": 0.1, "price": 1.08512, "sl": 1.083, "tp": 1.089, "deviation": 10, "magic": 26091, "comment": "e" + "a" * 40, "filling": "ioc"}})
        self.assertEqual(res["retcode"], fake_mt5.TRADE_RETCODE_DONE)
        sent = fake_mt5.state["sent"]
        self.assertEqual(len(sent), 1)
        r = sent[0]
        self.assertEqual((r["action"], r["type"], r["type_filling"], r["type_time"]), (fake_mt5.TRADE_ACTION_DEAL, fake_mt5.ORDER_TYPE_BUY, fake_mt5.ORDER_FILLING_IOC, fake_mt5.ORDER_TIME_GTC))
        self.assertEqual(len(r["comment"]), 31, "MT5 comments are at most 31 characters")
        self.assertEqual(r["magic"], 26091)
        # closing by position ticket
        self.b.order_send({"request": {"action": "deal", "symbol": "EURUSD", "type": "sell", "volume": 0.1, "position": 77, "magic": 26091, "comment": "x", "filling": "ioc"}})
        self.assertEqual(fake_mt5.state["sent"][1]["position"], 77)

    def test_send_failure_is_an_error_not_a_result(self):
        self.b.connect(dict(CONNECT))
        fake_mt5.state["fail_send"] = (-10004, "No IPC connection")
        with self.assertRaises(BridgeError) as cm:
            self.b.order_send({"request": {"action": "deal", "symbol": "EURUSD", "type": "buy", "volume": 0.1, "filling": "ioc"}})
        self.assertEqual(cm.exception.code, "send_failed")
        self.assertIn("No IPC connection", cm.exception.message)
        with self.assertRaises(BridgeError):
            self.b.order_send({"request": {"action": "modify"}})

    def test_positions_and_history_filter_by_magic(self):
        self.b.connect(dict(CONNECT))
        fake_mt5.state["positions"] = [
            fake_mt5.TradePosition(1, 0, 0, 0, 26091, 1, 0.1, 1.085, 1.083, 1.089, 1.086, 0.0, 10.0, "EURUSD", "e1"),
            fake_mt5.TradePosition(2, 0, 0, 1, 0, 2, 1.0, 1.085, 0.0, 0.0, 1.086, 0.0, -10.0, "EURUSD", "manual"),
        ]
        self.assertEqual([p["ticket"] for p in self.b.positions({"symbol": "EURUSD", "magic": 26091})], [1])
        self.assertEqual(len(self.b.positions({"symbol": "EURUSD"})), 2)
        fake_mt5.state["history_deals"] = [fake_mt5.TradeDeal(9, 8, 0, 0, 1, 1, 26091, 1, 0.1, 1.09, -0.7, 0.0, 50.0, 0.0, "EURUSD", "x")]
        self.assertEqual(len(self.b.history_deals({"position": 1, "magic": 26091})), 1)
        self.assertEqual(len(self.b.history_deals({"fromServerSec": 1, "toServerSec": 2, "magic": 1})), 0)

    def test_constants_come_from_the_package(self):
        c = self.b.constants({})
        self.assertEqual(c["TRADE_RETCODE_DONE"], 10009)
        self.assertEqual(c["ACCOUNT_MARGIN_MODE_RETAIL_HEDGING"], 2)


class ProtocolTests(unittest.TestCase):
    def test_unavailable_package_is_reported_on_every_call(self):
        mt5, why = load_mt5()
        if mt5 is None:
            self.assertIn("requires Windows", why)
        srv = Server(None, "The MetaTrader5 Python package is not available (ImportError). It requires Windows.")
        self.assertIn("unavailable", srv.handle({"id": 1, "method": "health"})["result"])
        self.assertEqual(srv.handle({"id": 2, "method": "connect", "params": {}})["error"]["code"], "unavailable")

    def test_unknown_methods_and_errors(self):
        fake_mt5.reset()
        srv = Server(Mt5Bridge(fake_mt5))
        self.assertEqual(srv.handle({"id": 1, "method": "nope"})["error"]["code"], "unknown_method")
        self.assertEqual(srv.handle({"id": 2, "method": "account"})["error"]["code"], "not_connected")

    def test_process_speaks_json_lines_and_keeps_stdout_clean(self):
        here = os.path.dirname(os.path.abspath(__file__))
        req = "\n".join(json.dumps(m) for m in [
            {"id": 1, "method": "health"},
            {"id": 2, "method": "connect", "params": CONNECT},
            {"id": 3, "method": "account"},
        ]) + "\n"
        out = subprocess.run([sys.executable, "-E", "-s", "-u", os.path.join(here, "run_fake_mt5_bridge.py")], input=req, capture_output=True, text=True, timeout=60)
        lines = [json.loads(l) for l in out.stdout.splitlines()]
        self.assertEqual([l["id"] for l in lines], [1, 2, 3])
        self.assertEqual(lines[2]["result"]["login"], 51234567)
        self.assertNotIn(fake_mt5.PASSWORD, out.stdout + out.stderr)
