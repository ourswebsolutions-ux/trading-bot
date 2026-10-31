"""Entry point used by the desktop app: `python -E -s -u run_mt5_bridge.py` (or the bundled executable).

Speaks JSON lines over stdin/stdout. Requires Windows with the MT5 terminal installed and the
MetaTrader5 package (engine/requirements-mt5.txt); elsewhere every call reports why it is unavailable.
"""

from tradepilot_mt5.protocol import serve

if __name__ == "__main__":
    serve()
