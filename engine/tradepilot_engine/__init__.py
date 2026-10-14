"""TradePilot trading engine (Phase 1 foundation).

Pure-Python, dependency-free. Provides indicators, strategy validation and a
deterministic bar-by-bar backtester. Live order routing is intentionally absent.
"""

__version__ = "0.1.0"

# Hard guard: Phase 1 never places real orders. Changing this flag alone does not
# enable live trading; there is no live execution code path in this package.
LIVE_TRADING_ENABLED = False
