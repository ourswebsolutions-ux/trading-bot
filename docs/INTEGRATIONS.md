# Integrations and market data (Phase 2)

All provider calls run in the Electron **main process**; the renderer only receives results. Credentials are encrypted with the OS keychain (Electron `safeStorage`), shown only as masked hints (`••••3f9a`), and every log line and error message passes through a redactor. Network calls have timeouts; idempotent requests retry at most twice on network errors, HTTP 429 and 5xx (honouring `Retry-After` / Delta's `X-RATE-LIMIT-RESET`, capped at 10 s). Sends (WhatsApp messages, emails) are never retried automatically.

Each Settings section shows: masked credential fields, Save, **Test connection** (a real provider call) with step-by-step progress, the time of the last successful connection, the last check, and the provider's actual answer or an actionable error. Saving changed settings resets the status to "not tested".

## Delta Exchange

| Region | REST | WebSocket | Verified from the build machine (2026-10-14) |
|---|---|---|---|
| India | api.india.delta.exchange | socket.india.delta.exchange | ✅ 237 live perpetuals, streaming |
| Global | api.delta.exchange | socket.delta.exchange | ✅ 6 live perpetuals (USDT-quoted, e.g. BTCUSDT), streaming |
| India testnet | cdn-ind.testnet.deltaex.org | socket-ind.testnet.deltaex.org | ✅ 16 live perpetuals, streaming |
| Global testnet | testnet-api.delta.exchange | testnet-socket.delta.exchange | ⛔ `ACCESS_RESTRICTED` from this location — the app reports "region not supported from your location" |

- Instruments differ per region (India `BTCUSD`, Global `BTCUSDT`). TradePilot loads the region's live perpetual list first and refuses symbols that are not listed instead of showing empty data.
- **API key**: create it in Delta Exchange → API Keys with **Read Data** permission only (trading permission is not needed and not used). If you whitelist IPs, add your current IP.
- Signed requests: `api-key`, `timestamp`, `signature = hex(HMAC-SHA256(secret, method + timestamp + path + query + body))`, re-signed on every retry. `expired_signature` almost always means the computer clock is wrong.
- Read-only data shown when authorized: wallet balances, open positions (Dashboard → Exchange account) and order history (Trading → Exchange order history). The private-endpoint response mapping is covered by mocked tests; it has **not** been exercised against a real account yet (no credentials were available).

## Market data

- WebSocket channels: `v2/ticker` for watched instruments (Delta publishes ≈ every 5 s) and `candlestick_<tf>` for the chart on screen. Heartbeats are enabled; 20 s without traffic counts as a dead link. Reconnects back off 1 → 2 → 5 → 10 → 30 s and re-subscribe; candles are re-fetched after every reconnect to backfill the gap.
- REST polling (default every 10 s) covers anything the stream does not, and replaces the stream entirely if WebSockets are disabled or blocked.
- Duplicate or out-of-order ticks (same or older exchange timestamp) and repeated candle versions are ignored and counted.
- Every quote is labelled: **Live** (streamed, ≤ stale threshold, default 15 s), **Delayed** (REST data or a short stream gap), **Stale** (older), **Unavailable** (none). Paper orders are disabled unless the price is live or delayed. Exchange timestamps and local receive times are shown.
- Candle intervals with no exchange data are reported ("N intervals without data"), never filled in.

## OpenAI and Anthropic

- One provider interface (`src/main/ai/provider.ts`): list models, test, generate structured JSON. Usage (requests, input/output tokens, failures) is recorded per call; configurable **max output tokens**, **timeout**, **daily request limit** and **daily token budget** (UTC day) are enforced before a request leaves the app.
- OpenAI: `GET /v1/models` (test) and Chat Completions with a strict `json_schema` response format. Default model `gpt-5` — pick from the list the test loads for your key.
- Anthropic: official `@anthropic-ai/sdk`; Models API for the test, Messages API with `output_config.format` (JSON schema). Default `claude-opus-5-5`; for models that support it, requests opt into server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). A refusal is reported as such.
- Phase 3 groundwork: **Strategies → New strategy → Draft with AI** turns a description into a validated draft (type, parameters, risk) that fills the form for review. It is never saved or executed automatically, and AI code has no access to order functions.

## SMTP email

Host, port, implicit TLS or STARTTLS, "require TLS", username, password (keychain), sender, test recipient. **Test connection** connects and authenticates without sending; **Send test email** sends one message and shows the server's reply (e.g. `250 2.0.0 OK queued as …`). "Accepted" means queued by your server, not delivered to the inbox. The subscription server uses the same module (`packages/shared/src/smtp.ts`) for admin and customer notifications.

## WhatsApp Business (Cloud API)

- Settings: phone number ID, WhatsApp Business Account ID (optional; used to verify templates), permanent System User access token, Graph API version (default `v23.0`), test template name/language (default `hello_world` / `en_US`).
- **Test connection** reads the phone number (verified name, quality rating) and, with the WABA ID, lists templates and checks the configured one is approved.
- **Consent**: test messages can only be sent to numbers on the in-app opt-in list, added with an explicit confirmation that the person agreed to receive messages. Business-initiated messages use approved templates only.
- Meta error codes are mapped to explanations (expired token 190, permission 10/200, rate limits 4/80007/130429/131056, undeliverable 131026, not in allowed list 131030, 24-hour window 131047, template missing 132001, …). Delivery/read receipts require a webhook endpoint, which is not part of this release; the app reports "accepted by WhatsApp" with the message ID.

## Running the live integration tests

```bash
npm run test:live                           # public Delta data (India) + invalid-key checks against OpenAI, Anthropic, Meta
DELTA_REGION=global npm run test:live       # another region
DELTA_API_KEY=… DELTA_API_SECRET=… OPENAI_API_KEY=… ANTHROPIC_API_KEY=… \
SMTP_TEST_HOST=… SMTP_TEST_PORT=587 SMTP_TEST_USER=… SMTP_TEST_PASSWORD=… SMTP_TEST_FROM=… SMTP_TEST_TO=… \
WHATSAPP_PHONE_NUMBER_ID=… WHATSAPP_TOKEN=… WHATSAPP_WABA_ID=… npm run test:live
```

Credentialed tests are skipped (and reported as skipped) when their variables are missing.
