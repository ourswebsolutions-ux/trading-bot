# Subscription server — deployment

The server (`apps/server`) holds everything that must not live in the desktop app: trial and subscription state, payment evidence, SMTP credentials and the entitlement signing key. There are no administrator accounts.

## 1. Build and run

```bash
npm ci
npm run build -w @tradepilot/server          # → apps/server/dist/*.js (dependencies stay in node_modules)
NODE_ENV=production node apps/server/dist/server.js
```

Run it under a process manager (systemd, a container) as an unprivileged user that owns `DATA_DIR`. Node ≥ 22.13 is required (`node:sqlite`; Node 22 prints an "experimental" warning for it, which is expected).

Minimal systemd unit:

```ini
[Service]
User=tradepilot
WorkingDirectory=/opt/tradepilot/apps/server
EnvironmentFile=/etc/tradepilot/server.env       # chmod 600, owned by root
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/tradepilot
```

## 2. HTTPS and reverse proxy

Terminate TLS in front of the server (nginx, Caddy, a cloud load balancer) and forward to `HOST:PORT` (default `127.0.0.1:8787`). Then set:

- `PUBLIC_BASE_URL=https://billing.your-domain.example` — used in the emailed review links and for the origin check. Production refuses to start without `https://`.
- `TRUST_PROXY=true` so rate limits and audit IPs use the client address.
- Cookies become `__Host-` prefixed, `Secure`, `HttpOnly`, `SameSite=Strict` automatically when the base URL is HTTPS. HSTS is sent.

Limit request bodies at the proxy to ~6 MB (screenshots are capped at 5 MB server-side).

## 3. Secrets

| Secret | How to provide | Notes |
|---|---|---|
| Entitlement signing key | `npm run keys:generate -w @tradepilot/server -- --out /etc/tradepilot/keys`, then `ENTITLEMENT_PRIVATE_KEY_FILE=/etc/tradepilot/keys/entitlement-private.pem` | Copy the printed public key into the desktop build (`MAIN_VITE_ENTITLEMENT_PUBLIC_KEY`). Rotating the key requires shipping a desktop update first. |
| Review passphrase | `npm run review:passphrase -w @tradepilot/server -- --write /etc/tradepilot/review-passphrase.hash`, then `REVIEW_PASSPHRASE_HASH_FILE=` that path | Only the scrypt hash is stored; the passphrase is typed on the review page. |
| SMTP password (optional) | `SMTP_PASSWORD_FILE=/etc/tradepilot/smtp-password` (mode 600) | Only if you use server SMTP for client outcome emails. |

Never commit `.env`, key files or the data directory (all are in `.gitignore`). **If an email password was ever shared in plain text (chat, ticket, repository), rotate it at the provider before configuring production.** For Gmail/Google Workspace use an app password or a transactional email provider rather than the account password.

## 4. Server SMTP (optional)

The server does **not** need SMTP for payments: payment requests are emailed by the client's app through the client's own SMTP connection (Settings → SMTP Email in TradePilot). Server SMTP is optional and only used to email clients the approval/cancellation outcome (clients are always notified in the app). If you set it: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS=true`, `SMTP_USER`, `SMTP_PASSWORD_FILE`, `SMTP_FROM`; check with `npm run smtp:test -w @tradepilot/server -- you@example.com`.

## 5. Payment approval by email (no administrator dashboard or account)

Each payment request is approved or cancelled from an email to `ADMIN_NOTIFY_EMAIL` (default **ourswebsolutions@gmail.com**):

1. The client chooses Monthly ($20) or Lifetime ($500). The app shows the payment steps (amount, the client's payment reference, where to ask for payment details; `PAYMENT_INSTRUCTIONS(_FILE)` optionally adds account/wallet details). Before submitting, the client must have an email connection in **Settings → SMTP Email**; otherwise the app asks them to configure it.
2. The client submits the transaction ID, screenshot and their email address. The server stores the request as **pending** (no access is granted) and returns two single-use links: **Confirm Payment** and **Cancel Request**.
3. The app emails the business address **from the client's own SMTP account** with the client's email, plan, amount, transaction ID, client reference, the screenshot as an attachment, and both links. If that email cannot be sent, the app withdraws the request on the server, so nothing stays pending that you were not told about. The server sends nothing here.
4. Opening a link shows the request and the screenshot. **Opening changes nothing** (mail scanners that prefetch links cannot act).
5. The decision is submitted explicitly on that page (Confirm: tick "payment arrived"; Cancel: enter a reason for the client) **together with the review passphrase**. The client also holds the links (their app sent the email), so the passphrase is what stops a client from approving their own request.
6. **Confirm Payment** activates the plan exactly once (monthly renewals extend from the current end date). **Cancel Request** records the reason and grants nothing. The client is notified in the app (and by email if server SMTP is configured) and may submit a new request after a cancellation.

### Review passphrase (required)

```bash
npm run review:passphrase -w @tradepilot/server -- --write                                    # development: writes REVIEW_PASSPHRASE_HASH to apps/server/.env
npm run review:passphrase -w @tradepilot/server -- --write /etc/tradepilot/review-passphrase.hash   # production: hash file (mode 600)
node dist/review-passphrase.js --write /etc/tradepilot/review-passphrase.hash                      # same, on a server running the built bundle
```

Then set `REVIEW_PASSPHRASE_HASH_FILE=/etc/tradepilot/review-passphrase.hash` (or `REVIEW_PASSPHRASE_HASH='scrypt$…'`) and restart. Only an scrypt hash is stored (a plain passphrase in the variable is rejected at startup). Until it is set, the server refuses payment requests and the app shows these exact steps. To change it, run the command again and restart. Ten wrong passphrases within 15 minutes (from any address) lock all decisions for 15 minutes.

Link security: each link carries a 256-bit random token (only its SHA-256 is stored), works **once** (the first successful decision atomically claims it; the confirm and cancel links of a request die together), expires after `REVIEW_LINK_TTL_HOURS` (default 72) and contains no credentials. Pages are `no-store`, `no-referrer` and CSRF-protected, decisions are rate-limited per IP, and every step (including failed passphrases) is in the append-only audit log. Duplicate clicks, replays and conflicting decisions are refused; approval is idempotent at the database level.

Expired links: `npm run review:resend -w @tradepilot/server -- <request id>` prints a fresh pair (the old pair stops working).

### Server variables

| Variable | Status |
|---|---|
| `REVIEW_PASSPHRASE_HASH` or `REVIEW_PASSPHRASE_HASH_FILE` | **Set** (required for payments). |
| `ADMIN_NOTIFY_EMAIL` | Optional; defaults to ourswebsolutions@gmail.com. |
| `PUBLIC_BASE_URL` | **Set** to the server's public HTTPS origin; the links point there. |
| `ENTITLEMENT_PRIVATE_KEY_FILE` | **Set** in production (section 3). |
| `PAYMENT_INSTRUCTIONS` / `_FILE` | Optional extra payment details. |
| `SMTP_*` | Optional (client outcome emails only). Not needed for payment requests. |
| `REVIEW_REQUIRE_ADMIN_LOGIN` | **Remove**: obsolete (there are no administrator accounts); it is ignored. |

Databases from earlier versions keep their recorded decisions (migration 3); the old `admins` table is no longer used.

## 6. Data, migrations, backups

`DATA_DIR` contains `tradepilot.sqlite` (WAL mode), `evidence/` and `backups/`.

- Migrations run automatically at startup (`npm run db:migrate` runs them explicitly). Applied migrations are checksummed; editing one makes startup fail rather than silently diverge.
- Backups: `BACKUP_INTERVAL_HOURS` (default 24) writes `backups/backup-<timestamp>/` with a consistent `VACUUM INTO` copy of the database plus the evidence files, keeping `BACKUP_RETENTION` (default 14) sets. `npm run db:backup` takes one on demand. Copy backups off the machine (object storage, another host) — local backups do not survive disk loss.
- Restore: stop the server, replace `tradepilot.sqlite` and `evidence/` with a backup set, start the server.
- `audit_events` is append-only (enforced by triggers).

## 7. API surface (for reference)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/devices/register` | none (20/h/IP) | Register a machine fingerprint; creates the trial once; re-issues the device token |
| `GET /v1/status` | device token | Trial, subscription, access decision + signed entitlement |
| `GET /v1/plans` | device token | Plans, prices (from the database), optional payment details, reference code, whether payment requests can be emailed (and why not) |
| `GET/POST /v1/payment-requests` | device token | History / submit (multipart; 10/h per device); submit returns the review links for the app to email |
| `GET /v1/notifications` | device token | In-app approval/cancellation messages |
| `GET /v1/entitlement` | device token | `402` unless trial or subscription is active |
| `GET /review/:token` | single-use emailed token | Confirmation page (read-only) |
| `POST /review/:token` | single-use token + review passphrase + CSRF cookie from the page + origin check (10 per 15 min per IP) | Confirm or cancel |
| `DELETE /v1/payment-requests/:id` | device token (own pending request only) | Withdraw a request the app could not email |
| `GET /healthz` | none | Liveness |
