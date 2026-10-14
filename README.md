# TradePilot

Desktop trading research and paper-trading terminal (Electron + React + TypeScript) with a Python strategy engine and a subscription backend (Fastify + SQLite). **Phase 2** added real-time Delta Exchange market data and the provider integrations (Delta Exchange, OpenAI, Anthropic Claude, SMTP, WhatsApp Business). **Phase 3** adds the rule-based Strategy Builder, AI strategy interpretation (OpenAI or Claude) with clarification questions and confirmation before saving, and email-only subscription approval. **Phase 4** adds automated trading: a Python decision engine runs enabled strategies on live Delta Exchange data in paper or live mode, with account risk limits, duplicate-order prevention, exchange reconciliation and an emergency stop. Live orders stay off until you enable them after configuration and risk checks — see [docs/TRADING.md](docs/TRADING.md). **Phase 5** makes strategy creation prompt-first: write the strategy in plain language, answer the AI's questions, review TradePilot's own validation and explanation, confirm; changes are made the same way and saved as versions, with backtests (fees + slippage) and simulated paper trading — see [docs/STRATEGIES.md](docs/STRATEGIES.md).

```
apps/desktop    Electron app: main process (SQLite, auth, secrets, updater, engine bridge) + React renderer
apps/server     Subscription API + emailed payment review pages (single-use links; no admin dashboard)
packages/shared Wire contracts, validation, password hashing, entitlement signing (Ed25519)
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
npm run dev        # first run creates dev keys + .env files, starts the server, waits for it, then opens the desktop app
```

`npm run dev` prefixes output with `[server]` / `[desktop]`, and Ctrl+C stops both server and app (and everything they started). If port 8787 is taken — usually by a server left over from an earlier run, possibly started with `sudo` — it says so instead of starting; `PORT=8899 npm run dev` uses another port. It works from VS Code's terminal (it strips `ELECTRON_RUN_AS_NODE`). Don't run it with `sudo`.

To try the payment flow locally, set `ADMIN_NOTIFY_EMAIL`, `PAYMENT_INSTRUCTIONS` and SMTP in `apps/server/.env`, and create the administrator who confirms payments from the emailed links:

```bash
npm run admin:create -w @tradepilot/server -- --email you@example.com --name "Your Name"
```

Separate terminals still work: `npm run dev:server` and `npm run dev:desktop`. The first desktop launch asks you to create a password; for automated dev setups you may set `TRADEPILOT_DEV_INITIAL_PASSWORD` (development builds only, must pass the policy, must be changed at first sign-in). There is no built-in default password.

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript checks for shared, server, desktop (main + renderer) |
| `npm test` | Server tests, desktop tests (incl. desktop↔server over real HTTP), Python engine tests |
| `npm run test:e2e` | Builds the desktop app and drives it through every section with Playwright (needs network + python3) |
| `npm run test:live` | Live integration tests against real providers. Delta public data always runs; credentialed checks run only when their env vars are set (see docs/INTEGRATIONS.md) |
| `npm run build` | Server bundle (`apps/server/dist`) and desktop bundle (`apps/desktop/out`) |
| `npm run package:desktop` | Installers for the current OS into `apps/desktop/release/<version>/` |
| `npm start -w @tradepilot/server` | Run the built server (`node dist/server.js`) |
| `npm run db:migrate -w @tradepilot/server` / `db:backup` | Apply migrations / take an online backup |
| `npm run keys:generate -w @tradepilot/server -- --out <dir>` | Generate the production entitlement key pair |

## Configuration

**Server** — environment variables, documented in [`apps/server/.env.example`](apps/server/.env.example): `PUBLIC_BASE_URL` (HTTPS in production), `DATA_DIR`, `ENTITLEMENT_PRIVATE_KEY_FILE` (required in production), `ADMIN_NOTIFY_EMAIL`, `SMTP_HOST/PORT/SECURE/REQUIRE_TLS/USER/PASSWORD_FILE/FROM`, `TRUST_PROXY`, `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION`. Deployment details: [docs/SERVER.md](docs/SERVER.md).

**Desktop build** — read at build time from `apps/desktop/.env` or CI env ([`.env.example`](apps/desktop/.env.example)):

| Variable | Purpose |
|---|---|
| `MAIN_VITE_API_BASE_URL` | Subscription server origin. Packaged builds require `https://`. |
| `MAIN_VITE_ENTITLEMENT_PUBLIC_KEY` | Server's Ed25519 public key (base64 SPKI). Pinned in the app; status tokens signed by any other key are rejected. |
| `TRADEPILOT_UPDATE_URL` | HTTPS base URL of the release feed (packaging time). Without it, builds have no update feed and say so. |

User API credentials (Delta Exchange, OpenAI, Anthropic, SMTP, WhatsApp) are entered in **Settings → Connections**, encrypted with the OS keychain (Electron `safeStorage`) and never sent to the renderer or logs.

## How access works

- **Local login** (password only) protects the app on this computer. Hash: scrypt (N=2¹⁵, r=8, p=1). Five free attempts, then lockouts of 30 s doubling to 15 min, persisted across restarts. Auto-lock on idle, OS lock or sleep. Forgotten password → "Reset" wipes local data only.
- **Subscription authorization** is decided by the server. On first unlock the app registers the machine (salted SHA-256 of the OS machine ID); the 72-hour trial is created server-side once per machine, so reinstalling, deleting data or changing the clock does not reset it.
- The server returns an Ed25519-signed entitlement (default 12 h offline validity, never past the trial/plan end). The main process checks the signature, device, expiry and clock rollback before every paid action (create/edit strategies, backtests, paper orders). Subscription info, plans and payment history are always available.
- Payments are manual: the client submits a transaction ID + screenshot; the business address receives an email with single-use, expiring **Confirm Payment** and **Cancel Request** links. Each opens a confirmation page (opening changes nothing) where the decision is submitted with an administrator sign-in. Approval is transactional and idempotent; duplicate transaction IDs, a second pending request, replayed links and conflicting decisions are rejected. Details: [docs/SERVER.md](docs/SERVER.md#5-payment-approval-by-email-no-administrator-dashboard).

## Strategies (Phases 3 and 5)

- **Prompt first** (Strategies → New strategy from prompt): see [docs/STRATEGIES.md](docs/STRATEGIES.md) for the workflow, the checks TradePilot performs independently of the AI, versioning and limitations.
- **Advanced builder** (optional): instrument and timeframe, direction, indicators (SMA, EMA, RSI, ATR, previous-N highest high / lowest low, Bollinger bands) with parameters, buy / sell-short entry rules and optional exit rules (conditions joined by "all"/"any"; comparisons include crosses above/below), stop-loss (percent, price points or ATR multiple), take-profit (percent, points or multiple of the stop), position sizing (percent of equity, percent risked at the stop, or fixed quantity), allocated capital (optional), maximum daily loss (% and/or USD) and maximum trades per day.
- **Validation** runs live while editing and again before enabling: structure, parameter ranges, defined indicators, supported instruments (from your Delta Exchange region) and timeframes, risk limits, and contradictions (impossible ranges, exits identical to entries, identical long/short rules, a single trade's risk exceeding the daily loss limit). Invalid strategies can be saved as drafts but not enabled; editing an enabled strategy into an invalid state disables it (or is refused while an automation runs it). Enabling places no orders by itself.
- Strategies from Phases 1–2 are converted to rules automatically; their new daily limits are left unset (never invented), so they show "Needs attention" until reviewed.
- Backtests (Analytics) evaluate the same rules in the Python engine: decisions on candle close, fills at the next open, stops/targets intrabar, daily limits per UTC day, configurable fees and slippage.
