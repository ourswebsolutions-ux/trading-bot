# Subscription server — deployment

The server (`apps/server`) holds everything that must not live in the desktop app: trial and subscription state, payment evidence, administrator accounts, SMTP credentials and the entitlement signing key.

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
| SMTP password | `SMTP_PASSWORD_FILE=/etc/tradepilot/smtp-password` (mode 600) | `SMTP_PASSWORD` also works but is visible in the process environment. |
| Admin passwords | `npm run admin:create -w @tradepilot/server -- --email … --name … --role superadmin` | Read from a hidden prompt (or `ADMIN_PASSWORD` for automation). Minimum 12 characters, scrypt-hashed. |

Never commit `.env`, key files or the data directory (all are in `.gitignore`). **If an email password was ever shared in plain text (chat, ticket, repository), rotate it at the provider before configuring production.** For Gmail/Google Workspace use an app password or a transactional email provider rather than the account password.

## 4. SMTP

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` (true for implicit TLS on 465, false for STARTTLS on 587), `SMTP_REQUIRE_TLS=true`, `SMTP_USER`, `SMTP_PASSWORD_FILE`, `SMTP_FROM`. TLS 1.2+ is enforced.

Use `npm run smtp:test -w @tradepilot/server -- you@example.com` to send a test message and see the SMTP server's actual reply. Every notification (payment request with review links, client approval/cancellation email) is recorded in the `notifications` table with its outcome — `sent`, `failed` (with the error) or `skipped` (SMTP not configured / no recipient). If SMTP is down when a request arrives, fix it and run `npm run review:resend` for that request.

## 5. Payment approval by email (no administrator dashboard)

There is no administrator web dashboard. Each payment request is approved or cancelled from the email sent to `ADMIN_NOTIFY_EMAIL`:

1. The client chooses Monthly ($20) or Lifetime ($500) and submits the transaction ID and screenshot in the app. The request is stored as **pending**; no access is granted.
2. The server emails the business address with the plan, amount, transaction ID, client reference and two links: **Confirm Payment** and **Cancel Request**.
3. A link opens a confirmation page that shows the request and the payment screenshot. **Opening a link changes nothing**, so email security scanners that prefetch links cannot approve anything.
4. The decision is submitted from that page. By default (`REVIEW_REQUIRE_ADMIN_LOGIN=true`) it also requires an administrator email and password, an additional authenticated step, so a forwarded or leaked email alone cannot approve a payment. Create administrators with `npm run admin:create -w @tradepilot/server -- --email … --name …` (min. 12-character password, scrypt-hashed, 5 failures lock the account for 15 minutes).
5. **Confirm Payment** activates the plan exactly once (monthly renewals extend from the current end date). **Cancel Request** records the reason and grants nothing. The client is notified in the app and, if they gave an address, by email, and may submit a new request after a cancellation.

Link security: each link carries a 256-bit random token (only its SHA-256 is stored), works **once** (the first submission atomically claims it; the confirm and cancel links of a request die together), expires after `REVIEW_LINK_TTL_HOURS` (default 72), and contains no credentials. Pages are `no-store`, `no-referrer` and CSRF-protected, decisions are rate-limited per IP, and every step is in the append-only audit log. Duplicate clicks, replays and conflicting decisions are refused; approval is idempotent at the database level as well.

Expired or lost links: `npm run review:resend -w @tradepilot/server -- <request id>` emails a fresh pair and invalidates the old one. Email delivery check: `npm run smtp:test -w @tradepilot/server -- [recipient]`.

Configuration that used to live in the dashboard is now environment-only: `ADMIN_NOTIFY_EMAIL`, `PAYMENT_INSTRUCTIONS` or `PAYMENT_INSTRUCTIONS_FILE` (shown to clients; payments are refused until it is set), `REVIEW_LINK_TTL_HOURS`, `REVIEW_REQUIRE_ADMIN_LOGIN`.

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
| `GET /v1/plans` | device token | Plans, prices (from the database), payment instructions, reference code |
| `GET/POST /v1/payment-requests` | device token | History / submit (multipart; 10/h per device) |
| `GET /v1/notifications` | device token | In-app approval/cancellation messages |
| `GET /v1/entitlement` | device token | `402` unless trial or subscription is active |
| `GET /review/:token` | single-use emailed token | Confirmation page (read-only) |
| `POST /review/:token` | token + CSRF + administrator sign-in | Confirm or cancel |
| `GET /healthz` | none | Liveness |
