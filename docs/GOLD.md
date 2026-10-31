# XAUUSD Gold Scalper

TradePilot's home page is the **Gold Scalper**: short-term trading of spot gold (XAUUSD) through your MetaTrader 5 broker. It brings together the live gold price, the scalper's signal, your account, your open trades and every control on one page. The other features remain available from the sidebar: Delta Exchange, the generic strategy builder, AI prompting and analytics.

> **Status:** implemented and tested on Linux, against a scripted MT5 terminal and the real Python engine. It has **not** been run against a real MetaTrader 5 terminal or broker yet; MT5 only runs on Windows. Follow [Demo testing](#demo-testing) on a demo account before trusting it. No strategy guarantees profits, and scalping in fast gold markets can lose money quickly.

## Install and start

These are developer commands, run from the repository root.

```powershell
npm ci
python -m pip install -r engine/requirements-mt5.txt   # Windows: MetaQuotes' MetaTrader5 package
npm run dev                                            # starts the app (and a local subscription server)
```

Windows installers (`TradePilot-Setup-<version>.exe`) bundle the trading engine and the MT5 bridge, so users need neither Python nor Node. For building them, see [RELEASING.md](RELEASING.md) and [MT5.md](MT5.md#windows-demo-account-verification).

**Dependencies.** No new npm or Python packages were added for gold. The MT5 bridge uses `MetaTrader5==5.0.6231` and `numpy`, from `engine/requirements-mt5.txt`, on Windows only.

## Connect MetaTrader 5

1. Install the MT5 terminal from your broker, log in once, and turn on **Algo Trading** in the toolbar. Use a **demo account** first. Check with your broker that it accepts clients from your country.
2. In TradePilot, open **Settings → MetaTrader 5**. Enter the trade server (exactly as in the terminal), the login number and the password, then choose **Test connection**. The password is encrypted with the operating system keychain.
3. Open **Gold Scalper**. Two things happen automatically:
   - **Symbol detection:** TradePilot finds your broker's gold symbol (`XAUUSD`, `XAUUSDm`, `XAUUSD.r`, `GOLD`, …) from the symbol list, using its currencies (XAU against USD), its name and its description. Gold quoted in other currencies, silver, futures and disabled symbols are never chosen. You can pick the symbol yourself in the settings.
   - **Broker specifications:** read from the terminal and used for every order. These are the contract size, the value of a price move per lot, the minimum/maximum lot and lot step, the minimum stop distance and the allowed filling modes.

**Disconnect** and **Connect** on the page close and reopen the terminal session. You cannot disconnect while the scalper is trading the account.

## The page

| Area | What it shows |
|---|---|
| Status | MT5 connection, account (DEMO / LIVE · real money), scalper state, automatic trading on/off, the gold symbol |
| Price | Live bid, ask and mid price; the spread, with a warning when it is above your maximum |
| Market direction | Trend on the trend timeframe (M15) and on the entry timeframe (M1/M5) from EMA 9/20/50; RSI, MACD momentum, the last candle's pattern, nearest support/resistance (swing points), VWAP when enabled |
| Signal | BUY / SELL / WAIT from the scalper's own rules on the last **closed** candle. When it would trade: the entry, stop-loss, take-profit and lots. When a filter or risk limit blocks it: why |
| Volatility | ATR(14), its recent average, the volatility state (low / normal / high / extreme) and the last candle's size in ATRs |
| Controls | Start / Stop Scalping, Auto Trading ON/OFF, Manual BUY / SELL, Close All Trades, Emergency Stop |
| Statistics | Balance, equity, today's P&L, win rate and number of trades, current and longest win/loss streaks. These come from your MT5 deal history (TradePilot's trades only); in paper mode, from the simulated trades |
| Chart | M1, M5 and M15 candles from your terminal |
| Open trades | Every gold position, marked Scalper / Manual / Not TradePilot, with Close and SL/TP buttons |
| Settings, Backtest, Activity | Below the trades |

## The scalping strategy

The scalper is an ordinary strategy named **XAUUSD Gold Scalper**, generated from the settings on the page. It is therefore validated, backtested and automated by the same engine as every other strategy, and appears on the Strategies page. A trade opens only when **all** of these are true on a closed entry candle:

1. **Trend (M15):** EMA 20 is above EMA 50 on **completed** M15 candles. A sell needs it below. The M15 values are built from the M1/M5 candles and change only when an M15 candle has closed, so there is no look-ahead.
2. **Momentum stack (entry timeframe):** EMA 9 > EMA 20 > EMA 50 (reversed for sells).
3. **Entry trigger**, depending on the entry style:
   - *pullback* (the default): the candle dipped to EMA 20 and closed back above EMA 9;
   - *breakout*: the close crossed above the previous 10 candles' high;
   - *momentum*: the MACD line crossed above its signal line.
4. **Confirmations** (each can be turned off):
   - RSI(14) between 50 and 70 (30–50 for sells): momentum, but not overbought;
   - MACD above its signal line;
   - the candle closes in the trade's direction;
   - optionally, the close is above the daily VWAP.
5. **Filters:**
   - the spread is not above your maximum;
   - the time is inside your trading session;
   - the price is not extended (more than *x* × ATR away from EMA 20 means you would be chasing);
   - no abnormal candle (a range above *y* × ATR, typical of news spikes);
   - no configured high-risk event window.

No single indicator opens a trade.

**Exits:**
- the stop-loss at ATR(14) × your multiple (placed at the broker with the order);
- the take-profit at your reward : risk multiple (also at the broker);
- EMA 9 crossing back below EMA 20;
- the **maximum trade duration**.

Decisions are made on closed candles; orders go out a few seconds after the close. Open positions are protected at the broker even if TradePilot is closed. The bot checks its exits on every new candle.

**VWAP.** Spot gold on MT5 has no traded volume, only *tick volume* (the number of price changes). TradePilot's VWAP uses tick volume, which is an approximation. It is therefore **off** by default.

## Risk management

Every value is on the page; the defaults are conservative for demo testing.

| Setting | Default | Effect |
|---|---|---|
| Risk per trade | 0.25% | Lots = equity × risk ÷ (stop distance × value per lot), **rounded down** to the broker's lot step. Refused below the minimum lot; never rounded up |
| Fixed lot size | 0.01 (off) | Alternative to risk sizing; refused if it is not a valid lot for the broker |
| Stop-loss | 1.2 × ATR | From volatility, never closer than the broker's minimum stop distance |
| Take-profit | 1.5 × risk | Must be at least the minimum reward : risk (1.2) |
| Maximum spread | $0.40 | No new trade above it |
| Maximum trades per day | 8 | Scalper and manual trades together |
| Maximum daily loss | 2% | No new trades for the rest of the UTC day |
| Maximum losses in a row | 3 | No new trades for the rest of the UTC day |
| Cooldown after a trade | 10 min | No new entry right after a trade |
| Maximum trade duration | 60 min | The position is closed at market |
| Extended-move filter | 1.5 × ATR | No entry far from EMA 20 |
| Spike filter | 3 × ATR | No entry after an abnormal candle |
| Trading session | 07:00–20:00 UTC | The London and New York hours; empty = whenever the market is open |
| High-risk events | none | Windows you enter yourself: no new entries |

**Account-wide limits** are set in **Trading → Account risk settings**:
- maximum open positions;
- maximum order size (account currency);
- maximum total exposure.

These apply to the scalper and manual trades alike. An order that would exceed the order-size or exposure cap is reduced to fit, in whole lot steps, and the reduction is shown. It is refused when not even the minimum lot fits. Risk is never increased automatically after losses. There is no martingale or grid.

Gold is large per lot: 0.01 lot is about 1 ounce, roughly $2,600 or more of exposure. The default *Max order size* (1,000) and *Max total exposure* (100%) are therefore below the value of the minimum lot on most accounts. Raise them deliberately, for example to a max order size of 5,000 and 300% exposure on a 10,000 demo account.

**News.** TradePilot has no economic-news feed, and it does not pretend to have one. Enter scheduled releases (US jobs report, CPI, FOMC, …) as high-risk events, in UTC. The spike filter, spread filter and volatility read-out are the automatic protection against unexpected moves.

## Controls and safety

- **Auto Trading ON/OFF.** This is TradePilot's permission to place orders on your MT5 account, for the scalper and for manual BUY/SELL. Turning it on needs:
  - typing `ENABLE LIVE TRADING`;
  - your TradePilot password;
  - on a real-money account, its account number as well.

  Off by default.
- **Start Scalping.** With Auto Trading off, the scalper runs in **paper mode**: real prices, simulated fills at bid/ask, no orders. With Auto Trading on, it trades the account.
- **Demo / Live mode** (settings). Demo mode only ever trades a demo account; Live mode only a real-money account, and switching to it needs confirmation. A running scalper remembers the account it started on. If the terminal is switched to another login, or from demo to real, it sends no further orders and pauses.
- **Manual BUY / SELL.** These need the same checks as the bot:
  - connection, account type, Auto Trading, Algo Trading;
  - the market is open, the spread, the risk sizing;
  - the broker's lot and stop rules;
  - the account limits.

  Each click is sent once; a repeated click or a lost answer never sends a second order. A result is only shown as filled when MT5 confirms it. An unclear result is looked up in the order history.
- **Close / Close All Trades.** Close All closes the scalper's and manual trades by ticket. Positions opened outside TradePilot are never touched by Close All; closing one individually needs an extra confirmation.
- **SL/TP.** Change the stop-loss or take-profit of TradePilot positions. Levels are checked against the current price and the broker's minimum distance.
- **Emergency Stop.** Stops all automation and blocks every new order, manual ones included. Open positions are closed at market or kept with their broker-side SL/TP, as set in the risk settings.

## Backtesting

**Backtest the scalper** runs the current settings on your broker's M1 or M5 candles:
- up to 5 days of M1 or 14 days of M5;
- each candle's real spread, your commission per lot and the slippage you choose;
- the broker's lot step and minimum.

**Execution model:**
- a signal on a candle's close fills at the next candle's open, which models the decision and order delay;
- stops and targets are checked against each candle's high and low; when both are touched, the stop counts;
- filters use only what was known at the decision.

**Reported:**
- net profit, win rate, profit factor, maximum drawdown;
- number of trades, average trade duration, average winning and losing trade, streaks;
- signals skipped by each filter.

Tick-level backtesting is not available. M1 bars with their spread are the finest data used, and fills inside a candle are approximations. Past results do not predict future results.

## Demo testing

On a Windows PC with the MT5 terminal and a **demo** account:

1. Connect MT5 as above. The Gold Scalper must show your gold symbol, a live bid/ask matching the terminal, a DEMO badge and your balance.
2. In **Trading → Account risk settings**, raise the max order size and exposure so 0.01 lot fits (see above), then save.
3. **Paper first.** Choose *Start Scalping* with Auto Trading OFF. Watch the signal, the decision log (Activity) and the simulated trades for a session.
4. **Backtest** a few days and read the numbers critically (profit factor, drawdown, number of trades), not only the win rate.
5. **Demo orders.** Turn Auto Trading ON and use *Manual BUY*. In the terminal, check that a position appears with:
   - a lot size that follows your risk, and SL/TP set;
   - magic number **260902** (manual);
   - comment `m…`.

   Then change its SL/TP from TradePilot, and close it with *Close*.
6. **Demo scalping.** Choose *Start Scalping* (it now trades the demo account). The scalper's orders carry magic **260901** and comment `e…`. Let it run; check:
   - stops and targets at the broker;
   - time exits;
   - the cooldown;
   - the daily limits;
   - Close All Trades and the Emergency Stop.
7. **Safety checks:**
   - switch the terminal to another account while the scalper runs: it must pause and send nothing;
   - close the terminal: errors must be reported, with no "market closed" and no fills;
   - restart TradePilot with a position open: no second position.
8. Also run the automated live checks from [MT5.md](MT5.md#windows-demo-account-verification). With `MT5_SYMBOL` unset, they use the detected gold symbol.

Only after weeks of demo results you are comfortable with should you consider Live mode, with small risk.

## Remaining limitations

- **Not yet verified on a real terminal.** Nothing has run against a real MT5 terminal or broker. See [MT5.md](MT5.md#known-limitations).
- **Approximate data.**
  - VWAP uses tick volume.
  - Support and resistance are recent swing points, not order-book levels.
  - M15 trend candles are built from M1/M5 candles aligned to UTC; H4/D1 alignment can differ from a broker's server-time candles.
- **News.** No news feed: high-risk events are manual.
- **Backtests** are candle-based (M1 finest), not tick-based.
- **Limits apply per closed candle.** The cooldown, the maximum trade duration and exits are checked on closed entry candles (every minute on M1). Stops and targets act immediately at the broker.
- **Slippage settings.** The MT5 *Max price deviation* (Settings → MetaTrader 5) is in points. For 2-digit gold quotes, 30–50 points ($0.30–$0.50) is a typical choice. Requotes are reported as rejections and never retried automatically.
- **Scope of the statistics.** They cover TradePilot's gold trades in the last 30 days of MT5 history.
