# MetaTrader 5 support

> The XAUUSD Gold Scalper (the home page) is built on this integration — see [GOLD.md](GOLD.md).

TradePilot can use a MetaTrader 5 broker account next to Delta Exchange. It works through MetaQuotes' official [`MetaTrader5`](https://pypi.org/project/MetaTrader5/) Python package, which drives a locally installed, running MT5 terminal.

> **Status: implemented and tested against scripted test doubles only.** Development happened on Linux, where the MetaTrader5 package and terminal cannot run. Nothing in this document has been checked against a real terminal or a real broker yet. Run the [Windows demo-account verification](#windows-demo-account-verification) before relying on it, and never start with a real-money account.

## Requirements

- **Windows 10/11 x64.** The MetaTrader5 package is published only for Windows (`win_amd64` wheels). On Linux and macOS the app shows "MetaTrader 5 needs Windows". Delta Exchange keeps working there.
- **The MT5 terminal**, installed from your broker or from MetaQuotes, and logged in at least once.
- **"Algo Trading" switched on** in the terminal, with expert trading allowed for the account. This is needed for live orders only.
- **A broker that accepts you.** TradePilot does not choose or recommend brokers. Check with the broker that it accepts residents of your country, and that the account type you open is permitted for you.
- **Python** (developer builds only). Windows installers bundle the bridge (`tradepilot-mt5-bridge.exe`). A source checkout needs `pip install -r engine/requirements-mt5.txt` in the Python set under Settings → General.

## Setup

1. **Connect the account.** In Settings → Connections → **MetaTrader 5**, enter:
   - the trade server, exactly as the terminal's login dialog shows it (e.g. `Broker-Demo`);
   - the login (your account number);
   - the password.

   Two optional fields:
   - the path to `terminal64.exe`, if the terminal is not in its default location;
   - the maximum price deviation in points (the default is 20, which is 2 pips on 5-digit pairs).
2. **Test the connection.** Choose **Test connection**. TradePilot starts the bridge, logs in and loads the symbols. It reports:
   - the account type: demo, contest or **real money**;
   - whether Algo Trading is allowed;
   - the broker's server time offset.
3. **Switch the active broker.** In Settings → General, set **Active broker** to MetaTrader 5. Prices, charts, the account view and new strategies then use MT5. Strategies created for Delta keep trading on Delta.
4. **Choose a default instrument** in the MetaTrader 5 settings section. Use the broker's exact symbol name (`EURUSD`, `EURUSD.m`, `XAUUSD#`…).

**Where the password is kept.** It is encrypted with the OS keychain (Electron `safeStorage`), like every other credential. It reaches the bridge process only inside the `connect` message on its standard input. It is never logged, and it is never sent to the renderer or included in an error message.

## How it works

| Area | Behaviour |
|---|---|
| Bridge | `engine/tradepilot_mt5`, a separate process that speaks JSON lines (the same pattern as the trading engine). It translates readable names (`"buy"`, `"ioc"`, `"1h"`) into the package's constants and returns plain JSON. Timeouts and crashes are reported as errors, never as successes. |
| Server time | MT5 reports bar, tick and deal times in the broker's server time. TradePilot learns the UTC offset (whole quarter hours) only once ticks are *moving*: two ticks seconds apart whose clock advances in step with real time. When the offset is unknown, the connection test and automation sample ticks for a few seconds themselves. The offset is remembered per trade server across restarts. Automation refuses to evaluate candles until the offset is known. |
| Prices | The terminal is polled every second for bid/ask. The mid price is shown; bid and ask are shown next to it. |
| Market closed | When there have been no ticks for more than 3 minutes during the forex weekend (Fri 21:00 – Sun 21:00 UTC), or for more than 30 minutes at any time, the quote is labelled **Market closed**. Automation then skips the candle quietly, with the decision "market closed". A lost terminal or bridge connection is reported as an automation error, never as a closed market. |
| Candles | The bar still forming is dropped, times are converted to UTC, and each candle carries the spread in price units. |
| Symbols | Every symbol the broker does not mark as disabled is listed, with the broker's own names. Close-only, long-only and short-only symbols are listed, but orders the broker would refuse are blocked before sending. |
| Pip size | 10 points on 3/5-digit symbols, otherwise 1 point. |
| Lot sizing | Value per point = `trade_tick_value / trade_tick_size`, in the account currency. Volumes are rounded **down** to `volume_step`. An order below `volume_min` is refused, and orders are capped at `volume_max`. Fixed-quantity sizing means lots. |
| Strategies | A strategy records its broker (`venue: "mt5"`; older strategies have no venue and mean Delta). MT5 adds **pips** for stop-loss and take-profit. The AI receives the broker's symbol list and MT5-specific instructions (pips, lots, account currency). |
| Backtests | The bid/ask spread comes from the candle data: buys fill at the ask, and sells and stops at the bid. P&L is valued in the account currency per lot. Fees are a separate commission assumption (default 0). |
| Paper trading | Buys fill at the ask and sells at the bid. Stops are checked on the side that would close the position. |
| Risk limits | The account risk settings apply per order (amounts are in the MT5 account currency). The same is true of exposure, open positions and the account daily loss limit. |

### Live execution

Live orders are **off by default** and enabled **per broker**. Enabling MT5 never enables Delta, and the reverse is also true. To enable MT5 live trading, all of these checks must pass:

- the computer runs Windows with the MT5 terminal;
- a successful connection test within the last 24 hours;
- Algo Trading is allowed;
- the risk settings are saved;
- no emergency stop is active;
- the account has been identified.

You then type `ENABLE LIVE TRADING` and your TradePilot password. On a **contest or real-money account** you also type the account number. A strategy can be started live only on its own broker, while that broker is the active one.

**Placing an order:**
- **Order type:** a market deal with the stop-loss and take-profit set on the position at the broker.
- **Order fields:** `magic = 260901`. The comment is the TradePilot client order ID (31 characters or fewer), which is used to find the order again.
- **Filling:** the first filling mode the symbol allows, in the order IOC, then FOK, then RETURN.
- **Checks before sending:** the symbol's trade mode; volume step, minimum and maximum; and the broker's minimum stop distance (`trade_stops_level`).
- **Sending:** each order is sent once and never retried automatically.
- **Outcomes:**
  - **Definite rejection:** a retcode such as invalid volume, no money or market closed. It is reported as a rejection with the reason.
  - **Unclear outcome:** a timeout, a lost bridge, an unrecognised retcode, or retcodes 10011, 10012 or 10031. TradePilot marks the order "unknown" and resolves it by looking it up in the order history by its client ID; if the broker has no record of it after 60 s, it is marked as not placed. Re-sending could duplicate the trade.
  - **Accepted but not executed:** a result without a deal ticket (for example 10008 PLACED on exchange-execution symbols) is not counted as a fill. The order is resolved from the history the same way.

**Closing positions:**
- Positions are closed **by position ticket**.
- **Hedging accounts:** TradePilot counts only its own positions (by magic number).
- **Netting accounts:** it counts every position on the symbol. It never closes more than the volume it opened, and size corrections can only shrink a position.

**Reconciliation:**
- Closing deals ("OUT" deals) are read from the history by **position ticket**, so a close by SL/TP, by hand in the terminal or by the broker is found whatever magic number the closing deal carries.
- Commission, fee and swap are counted as costs.
- A stop-out at the broker is recorded as `stop_loss_on_exchange`.

**Emergency stop:** this closes TradePilot's MT5 positions by ticket. Choose "keep positions" instead to leave them with their broker-side SL/TP.

## Windows demo-account verification

Do this on a Windows PC before trusting MT5 with anything else. Every step uses a **demo** account.

Run every command from the **repository root** in PowerShell unless a step says otherwise.

1. **Prepare the terminal.** Install the MT5 terminal. Open a demo account (File → Open an Account) with a broker that accepts you. Log in, and turn on **Algo Trading** in the toolbar. Note whether the account is *hedging* or *netting* (the connection test also reports it); if you can, open one demo account of each kind.
2. **Check out the repository** with Node 24 and 64-bit Python 3.12 from python.org (not the Microsoft Store stub), then run:
   ```powershell
   npm ci
   python -m pip install -r engine/requirements-mt5.txt
   ```
3. **Check the package loads:**
   ```
   python -c "import MetaTrader5 as m; print(m.__version__)"
   ```
   If this fails, the pinned version (`5.0.6231`) may be unavailable for your Python; try the latest `MetaTrader5` and note the version.
4. **Run the live test suite** in the same terminal window (PowerShell):
   ```powershell
   $env:MT5_LOGIN="<demo login>"; $env:MT5_PASSWORD="<demo password>"; $env:MT5_SERVER="<server>"
   # optional: $env:MT5_SYMBOL="EURUSD.m"   (default: your broker's detected gold symbol)
   # optional: $env:MT5_TERMINAL_PATH="C:\Program Files\<Broker> MetaTrader 5\terminal64.exe"
   # optional: $env:MT5_PYTHON="C:\Path\To\python.exe"   (the Python with MetaTrader5 installed)
   cd apps/desktop
   node --import tsx --test --test-reporter=spec test-live/mt5.test.ts
   cd ../..
   ```
   Run it on a weekday, when the market is open. The suite:
   - refuses a non-demo account;
   - checks login, account, symbols and lot specs;
   - checks live bid/ask and server-time learning;
   - checks that the newest candle is closed and in UTC.
5. **Run the demo order round trip:**
   ```powershell
   $env:TRADEPILOT_MT5_ORDER_TEST="1"
   cd apps/desktop
   node --import tsx --test --test-reporter=spec test-live/mt5.test.ts
   cd ../..
   Remove-Item Env:TRADEPILOT_MT5_ORDER_TEST
   ```
   It opens the minimum volume with an SL/TP well beyond the spread and the broker’s minimum stop distance, finds the order again by its client ID, closes it by ticket, and reads the closing deal. Check in the terminal that a position appeared and closed, with magic 260901 and the `e…` comment.
6. **Build and install the app** (from the repository root):
   ```powershell
   python -m pip install -r engine/requirements-build.txt
   node scripts/build-engine.mjs python --mt5
   npm run build -w @tradepilot/desktop
   cd apps/desktop
   $env:TRADEPILOT_REQUIRE_BUNDLED_ENGINE="1"
   npx electron-builder --config electron-builder.config.cjs --win --x64 --publish never
   cd ../..
   ```
   The engine build ends with `bundled MT5 bridge OK … (MetaTrader5 <version>)`: that health check confirms the bundled bridge loads the package. Install `apps/desktop/release/<version>/TradePilot-Setup-<version>.exe`. The installer is unsigned, so Windows SmartScreen asks for confirmation (More info → Run anyway).
7. **Check the installed app:**
   - Settings → MetaTrader 5: enter the demo account, then **Test connection**. Expect: demo account, Algo Trading allowed, and the symbol count.
   - Settings → General → Active broker: **MetaTrader 5**.
   - **Gold Scalper** (home page) and **Dashboard:** XAUUSD price, bid/ask, account panel. The prices must match the terminal's. Then follow the scalper's own demo steps in [GOLD.md](GOLD.md#demo-testing).
   - **Trading → MT5 account:** balance, equity and positions must match the terminal.
8. **Save risk settings that allow the minimum lot** (Trading → Automation → Account risk settings, amounts in the account currency). 0.01 lot of XAUUSD is about 1 ounce (roughly 2,600+ USD of notional); 0.01 lot of EURUSD is about 1,100 USD. The default *Max order size* of 1,000 blocks both; set it to at least 5,000 for gold. *Max total exposure* must also cover it: with a 10,000 USD demo balance, 0.01 lot of gold is about 26% of equity.
9. **Run a paper strategy.** Create a strategy by prompt, for example: "Buy EURUSD on the 5-minute chart when close crosses above EMA 20, 10 pip stop, 20 pip target, 0.01 lots, max 3 trades, 2% daily loss". Save, enable and start it **paper**. After a few candles, check:
   - entries at the ask and exits at the bid;
   - sizes in lots;
   - the decision log;
   - "Market closed" over the weekend.
10. **Run a live strategy on the demo account.**
    - Enable live trading for MT5 (all checks must be green), then start the same strategy **live**.
    - Check each order in the terminal: lots, SL/TP, magic 260901, comment `e…`.
    - Move the SL close to the price in the terminal and let it stop out. TradePilot must record `stop_loss_on_exchange` with commission and swap.
    - On the next position, close it **by hand** in the terminal. TradePilot must record `closed_on_exchange` from the closing deal, not "no closing fills were found".
    - Test the emergency stop with an open position: the position must close by ticket.
    - On a *netting* demo account, also open a manual position on another symbol and check that TradePilot never closes more than its own volume.
11. **Check recovery.**
    - Quit and restart TradePilot with a live position open. It must not open a second one.
    - Close the terminal while running. TradePilot must report a bridge or terminal error in the activity log, not "market closed", and must not report a fill.
    - Change the trade server in Settings → MetaTrader 5 to another broker's demo, test the connection, and check the reported server time is that broker's.
12. **Record** the MetaTrader5 package version, terminal build, broker, account margin mode (netting or hedging) and any failure. Report them before any real-money use.

## Known limitations

- **No real terminal yet.** Nothing has been verified against a real terminal or broker. Retcode handling, filling-mode selection, history lookups by comment, and time conversion all follow the MetaTrader5 documentation and are exercised only with fakes.
- **Weekend and session times are approximate.** The forex weekend is fixed at Fri 21:00 to Sun 21:00 UTC. Holiday closures and per-symbol session breaks show as "Market closed" only after 30 minutes without ticks.
- **The server time offset needs a moving market.** On a fresh install, or after changing the trade server, MT5 automation waits until it has seen moving ticks (it samples for a few seconds by itself). Backtests before that point assume UTC and log a note.
- **Risk limits are sized for Delta.** *Max total exposure* is capped at 500% of equity, which is conservative for leveraged forex accounts. Amounts are in the account currency, and the defaults (1,000 max order size) block even 0.01 lot of most pairs until you raise them.
- **Untested execution modes.** Exchange-execution symbols (10008 PLACED) and partial fills cannot be produced on a typical forex demo; they are covered by tests only.
- **Exit classification.** A close within 0.2% of the stop or target is labelled `stop_loss_on_exchange` / `take_profit_on_exchange`. On forex this is about 20 pips, so a manual close near the stop can be labelled as a stop-out. P&L is unaffected.
- **Currencies.** P&L and risk amounts are in the MT5 account currency, but some screens label money with "$". Paper equity is a single figure shared with Delta paper trading.
- **Manual paper trading** (Trading → Manual paper trading) uses quantity in base-currency units, not lots.
- **Partial fills and pending orders.** A partial fill (retcode 10010) is recorded as partially filled for the executed volume, and the session tracks only that volume. Pending orders are not used.
- **Mixed-broker overview.** Only the active broker's prices are shown. Sessions on the other broker show no unrealized P&L until you switch.
- **Windows only.** On Linux and macOS the app compiles and runs, but MT5 reports "needs Windows".
