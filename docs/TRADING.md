# Automated trading (Phase 4)

## How it works

| Component | Responsibility |
|---|---|
| **Python engine** (`engine/tradepilot_engine/live.py`) | Decides. For each closed candle it evaluates the saved strategy rules, then applies every risk check (strategy trades/day and daily loss, account daily loss, open-position count, exposure, maximum order notional, contract sizing, emergency stop) and returns an intent such as "open long, 12 contracts, stop 98,250, target 102,400" or "blocked: account daily loss limit reached". It never sees API keys and cannot place orders. |
| **Desktop main process** (`apps/desktop/src/main/trading/`) | Executes. It re-checks the intent independently (emergency stop, live switch, size and notional caps, no existing position, one order per signal) and only then sends the order with the existing signed Delta Exchange client. Keys stay in the OS keychain. |
| **AI** | Only interprets strategy descriptions (Phase 3). AI output never reaches the engine or the order path; only saved, enabled, validated strategies are automated. |

- **When orders happen:** rules are evaluated when a candle closes; orders are market orders sent a few seconds after the close. Automation never acts on a candle that closed before it was started.
- **Protection:** live entries carry exchange-side **bracket stop-loss / take-profit** orders (`bracket_stop_loss_price`, `bracket_take_profit_price`, trigger: mark price), so they work even if TradePilot is closed. The engine also checks the stop/target on each candle as a backup. Paper positions are monitored every 5 seconds.
- **Duplicate prevention:** every entry's `client_order_id` is derived from (automation, candle, action) and stored with a unique constraint *before* the order is sent; a retry, a crash or a restart cannot send the same signal twice. Submissions are never auto-retried; if a request times out the order is looked up by `client_order_id` (`GET /v2/orders/client_order_id/{id}`) and either adopted or marked as never received after 60 s.
- **Order states shown:** pending, open, partially filled, filled, cancelled, rejected, unknown (being checked). Market orders that fill partially keep only the filled size; any remainder is cancelled.
- **Reconciliation** (every 15 s for live automations): the exchange position (`GET /v2/positions`) is the source of truth. A position closed on the exchange (bracket, manual, liquidation) is recorded from the actual fills with fees; a position that TradePilot did not open blocks new entries on that contract; size differences are corrected.
- **Paper mode** uses the same engine and risk checks with simulated fills at the live mark price (fee assumption from the strategy). Paper results are always labelled *Paper* and are never shown as exchange data.

## Before you can trade live

1. **Delta Exchange API key** (Delta Exchange → Account → API Keys):
   - Permissions: **Read Data** and **Trading**. Never enable withdrawals.
   - If you restrict the key to IP addresses, add the IP of the computer running TradePilot.
   - India production and testnet accounts use different keys and endpoints (Settings → Delta Exchange → Account region).
2. **Connection test** — Settings → Delta Exchange → Test connection must succeed (within the last 24 hours).
3. **Strategy** — built and **enabled** (it must pass validation). A strategy under automation cannot be edited, disabled or deleted until its automation is stopped.
4. **Account risk settings** — Trading → Automation → Account risk settings (max order notional, max exposure, max open positions, account daily loss limit, emergency-stop behaviour).
5. **Enable live trading** — Trading → Automation → Live trading → *Enable live trading…*: type `ENABLE LIVE TRADING` and your TradePilot password. Turning it off pauses all live automations (positions keep their exchange-side protection).
6. **Start** — *Start live* on the strategy row (with a final confirmation).

Only one live automation can trade a given contract, and an automation will not start on a contract where the exchange already shows an open position.

## Testnet (demo) validation

Delta Exchange India offers a testnet (REST `https://cdn-ind.testnet.deltaex.org`, WebSocket `wss://socket-ind.testnet.deltaex.org`; verified reachable, 16 live perpetuals on 2026-10-14). Create a testnet account and API key at testnet.delta.exchange, choose *Delta Exchange India (testnet)* in Settings, and either:

- run automations live against the testnet (the UI marks it *Testnet*), or
- run the scripted round trip (buys and closes 1 contract):

```bash
DELTA_REGION=india_testnet DELTA_API_KEY=… DELTA_API_SECRET=… TRADEPILOT_TESTNET_ORDER_TEST=1 npm run test:live
```

The Global testnet blocked access from the build machine's location (`ACCESS_RESTRICTED`).

## Emergency stop

Trading → Automation → **Emergency stop**: every automation stops and no new orders are sent until you clear it. Open positions are handled per the risk setting:

- **Close positions** — working orders (including bracket legs) are cancelled, then each position is closed with a reduce-only market order (3 attempts; you are alerted if any fails).
- **Keep positions** — only working entry orders are cancelled; positions keep their exchange-side stop-loss / take-profit.

## Alerts

Trading events (fills, rejections, positions closed, untracked positions, emergency stop, automation paused) appear under the bell icon and, when enabled:

- **Email** — Settings → SMTP Email → *Trading alerts by email* (+ optional alert recipient).
- **WhatsApp** — Settings → WhatsApp Business → *Trading alerts on WhatsApp*, an **approved template whose body has one variable** (for example `TradePilot alert: {{1}}`) and an alert recipient who is on the opt-in list. Business-initiated WhatsApp messages cannot be sent without an approved template.

## Known limitations

- Real order placement has been verified against the documented API and endpoint availability, and end-to-end with a scripted exchange in automated tests. It has **not** been run against a real or testnet account from this machine (no credentials). Run the testnet round trip above before trading real funds.
- A session runs the strategy version it was started with; newer versions are applied explicitly while flat (see [STRATEGIES.md](STRATEGIES.md)).
- Entries are market orders; slippage applies (paper fills simulate it with the *paper slippage* risk setting). Protective prices are computed from the mark price at decision time.
- Leverage and margin mode are whatever the account is set to on Delta Exchange; TradePilot limits notional exposure, not leverage.
- Live account equity uses the wallet balance of the contract's settlement asset (USD on India perpetuals).
