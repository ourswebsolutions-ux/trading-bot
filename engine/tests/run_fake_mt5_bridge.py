"""Runs the real MT5 bridge protocol over stdin/stdout with the fake MetaTrader5 module (tests only)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import fake_mt5  # noqa: E402
from tradepilot_mt5.protocol import serve  # noqa: E402

if __name__ == "__main__":
    serve(fake_mt5)
