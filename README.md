# TradePilot

Desktop trading research and paper-trading terminal (Electron + React + TypeScript) with a Python strategy engine. **No subscription:** every feature is available without a plan or trial, and the app contacts no TradePilot server. **Phase 2** added real-time Delta Exchange market data and the provider integrations (Delta Exchange, OpenAI, Anthropic Claude, SMTP, WhatsApp Business). **Phase 3** adds the rule-based Strategy Builder, AI strategy interpretation (OpenAI or Claude) with clarification questions and confirmation before saving. **Phase 4** adds automated trading: a Python decision engine runs enabled strategies on live Delta Exchange data in paper or live mode, with account risk limits, duplicate-order prevention, exchange reconciliation and an emergency stop. Live orders stay off until you enable them after configuration and risk checks — see [docs/TRADING.md](docs/TRADING.md). **Phase 5** makes strategy creation prompt-first: write the strategy in plain language, answer the AI's questions, review TradePilot's own validation and explanation, confirm; changes are made the same way and saved as versions, with backtests (fees + slippage) and simulated paper trading — see [docs/STRATEGIES.md](docs/STRATEGIES.md). **XAUUSD Gold Scalper** (home page): short-term gold trading on MetaTrader 5 with automatic gold-symbol detection, an M15-trend / M1–M5-entry scalping strategy, scalping risk controls, demo/live modes, manual orders and backtests — see [docs/GOLD.md](docs/GOLD.md). **MetaTrader 5** (Windows only) can be used next to Delta Exchange: choose the active broker, with lots, pips, bid/ask spread and a separate live switch per broker. It is not yet verified against a real terminal — see [docs/MT5.md](docs/MT5.md).

```
apps/desktop    Electron app: main process (SQLite, auth, secrets, updater, engine bridge) + React renderer
apps/server     Former subscription server (no longer used by the desktop app; kept for reference)
packages/shared Shared helpers (SMTP, validation, password hashing)
engine          Python engine: indicators, strategy validation, deterministic backtester (stdio JSON-RPC)
docs            SERVER.md, RELEASING.md, INTEGRATIONS.md, TRADING.md (automation, API permissions, testnet, emergency stop)
```

## Download

Installers for Windows, Linux (AppImage, .deb) and macOS are on the [Releases page](https://github.com/ourswebsolutions-ux/trading-bot/releases); installation steps and known limitations are in each release's notes. Release builds are produced and tested by GitHub Actions — see [docs/RELEASING.md](docs/RELEASING.md).

## Requirements

- Node.js ≥ 22.13 (uses the built-in `node:sqlite`; no native modules to compile)
- Python ≥ 3.10 on the end user's machine (runs the engine; no third-party packages)
- Linux packaging: nothing extra. Windows/macOS packaging must run on those OSes (see docs/RELEASING.md).

## Local development

```bash
npm install
npm run dev        # opens the desktop app with hot reload
```

`npm run dev` works from VS Code's terminal (it strips `ELECTRON_RUN_AS_NODE`); Ctrl+C stops it. Don't run it with `sudo`. The first desktop launch asks you to create a password; for automated dev setups you may set `TRADEPILOT_DEV_INITIAL_PASSWORD` (development builds only, must pass the policy, must be changed at first sign-in). There is no built-in default password.

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript checks for shared, server, desktop (main + renderer) |
| `npm test` | Server tests (the unused former subscription server), desktop tests, Python engine tests |
| `npm run test:e2e` | Builds the desktop app and drives it through every section with Playwright (needs network + python3) |
| `npm run test:live` | Live integration tests against real providers. Delta public data always runs; credentialed checks run only when their env vars are set (see docs/INTEGRATIONS.md) |
| `npm run build` | Desktop bundle (`apps/desktop/out`) and the former server's bundle |
| `npm run package:desktop` | Installers for the current OS into `apps/desktop/release/<version>/` |

## Configuration

**Desktop build** — optional, at packaging time:

| Variable | Purpose |
|---|---|
| `TRADEPILOT_UPDATE_URL` | HTTPS base URL of the release feed (packaging time). Without it, builds have no update feed and say so. |

User API credentials (Delta Exchange, MetaTrader 5, OpenAI, Anthropic, SMTP, WhatsApp) are entered in **Settings → Connections**, encrypted with the OS keychain (Electron `safeStorage`) and never sent to the renderer or logs.

## How access works

- **No subscription or trial.** Every feature is available; nothing is checked against a server.
- **Local login** (password only) protects the app on this computer. Hash: scrypt (N=2¹⁵, r=8, p=1). Five free attempts, then lockouts of 30 s doubling to 15 min, persisted across restarts. Auto-lock on idle, OS lock or sleep. Forgotten password → "Reset" wipes local data only.

## Strategies (Phases 3 and 5)

- **Prompt first** (Strategies → New strategy from prompt): see [docs/STRATEGIES.md](docs/STRATEGIES.md) for the workflow, the checks TradePilot performs independently of the AI, versioning and limitations.
- **Advanced builder** (optional): instrument and timeframe, direction, indicators (SMA, EMA, RSI, ATR, previous-N highest high / lowest low, Bollinger bands) with parameters, buy / sell-short entry rules and optional exit rules (conditions joined by "all"/"any"; comparisons include crosses above/below), stop-loss (percent, price points or ATR multiple), take-profit (percent, points or multiple of the stop), position sizing (percent of equity, percent risked at the stop, or fixed quantity), allocated capital (optional), maximum daily loss (% and/or USD) and maximum trades per day.
- **Validation** runs live while editing and again before enabling: structure, parameter ranges, defined indicators, supported instruments (from your Delta Exchange region) and timeframes, risk limits, and contradictions (impossible ranges, exits identical to entries, identical long/short rules, a single trade's risk exceeding the daily loss limit). Invalid strategies can be saved as drafts but not enabled; editing an enabled strategy into an invalid state disables it (or is refused while an automation runs it). Enabling places no orders by itself.
- Strategies from Phases 1–2 are converted to rules automatically; their new daily limits are left unset (never invented), so they show "Needs attention" until reviewed.
- Backtests (Analytics) evaluate the same rules in the Python engine: decisions on candle close, fills at the next open, stops/targets intrabar, daily limits per UTC day, configurable fees and slippage.
