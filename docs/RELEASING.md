# Releasing and automatic updates

## How it works

- **Building and publishing.** Installers are built, installed and tested by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)), then published to [GitHub Releases](https://github.com/ourswebsolutions-ux/trading-bot/releases).
- **Update source.** The same releases are the auto-update feed: **electron-updater** with the `github` provider reads `latest.yml`, `latest-linux.yml` and `latest-mac.yml` from the newest published (non-draft, non-prerelease) release.
- **When the app checks.** Installed apps check at launch and every 4 hours, and download in the background with progress shown in **Settings → Updates**.
- **When updates install.** An update installs in any of these cases:
  - the user clicks **Restart and install**
  - automatically, when the app is locked and the computer has been idle for 2 minutes (the user can turn this off)
  - at the latest, the next time the app quits
- **Failures.** Failed checks or downloads retry after 1, 5, 15 and 60 minutes, with a plain explanation (no release found, offline, failed integrity check, wrong signature).

**User data** lives in the OS user-data directory, which installers and updates never touch:

| Platform | Location |
|---|---|
| Linux | `~/.config/TradePilot` |
| Windows | `%APPDATA%\TradePilot` |
| macOS | `~/Library/Application Support/TradePilot` |

Before a schema migration, the app keeps a copy of the database there: `tradepilot.sqlite.pre-v<N>-<time>.bak`, newest three kept.

## Integrity

| Platform | Verification |
|---|---|
| All | Every update download is checked against the SHA-512 in the release's `latest*.yml` before installing. Corrupted or tampered files are discarded. |
| Windows | Add a code-signing certificate and set `TRADEPILOT_WIN_PUBLISHER`; electron-updater then also verifies that each update is signed by that publisher. Unsigned builds show a SmartScreen warning on first install. |
| macOS | macOS only installs updates for apps signed with an Apple Developer ID. **Unsigned builds** (the default without certificates) are ad-hoc signed so they run on Apple silicon. They do not try to auto-update; Settings → Updates says to download new versions from the Releases page. |
| Linux | The AppImage replaces itself; the `.deb` update is installed with `pkexec`/`sudo` (the user is asked for their password). |

## The release workflow

When a `vX.Y.Z` tag is pushed:

1. **CI.**
   - lint (type checking and Python syntax)
   - server, desktop and engine tests
   - production build
   - production dependency audit
2. **Package jobs.** One per platform: `ubuntu-22.04` (Linux x64), `windows-latest` (Windows x64), `macos-14` (macOS arm64) and `macos-15-intel` (macOS x64). Each one:
   - builds the self-contained trading engine with PyInstaller ([`scripts/build-engine.mjs`](../scripts/build-engine.mjs)), so users need no Python;
   - packages the installers;
   - **installs them on the clean runner** (`.deb` via apt, NSIS silently, `.dmg` mounted and copied; the AppImage is run directly);
   - runs [`apps/desktop/e2e/packaged.ts`](../apps/desktop/e2e/packaged.ts) against the installed app.

   The packaged test covers:
   - first launch and password setup on a clean profile
   - the bundled engine
   - honest subscription and update states
   - encrypted credential storage, with a clear error for an invalid AI key
   - live trading cannot be started
   - restart with persistence
3. **Publish.** Runs only if every job passed:
   - merges the macOS update metadata;
   - writes `SHA256SUMS.txt`;
   - creates a **draft** release with notes from `docs/release-notes/<tag>.md` and the checksums;
   - uploads every asset and checks the count;
   - only then publishes the release and marks it latest.

   An empty or missing installer fails the job; nothing is published.

`workflow_dispatch` (Actions → Release → Run workflow) builds and tests installers without publishing. They appear as workflow artifacts.

### Cutting a release

1. Update `version` in `apps/desktop/package.json`, using semver. Updates only move forward; downgrades are refused.
2. Write `docs/release-notes/vX.Y.Z.md`.
3. Run `npm run lint && npm test` locally, then commit and push to `main`.
4. Tag the release: `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag must match the version, or the workflow stops.
5. **Withdrawing a release.** Publish a newer version. Re-publishing an older one does nothing, because clients refuse downgrades.

## Repository configuration (optional)

Set these under Settings → Secrets and variables → Actions:

| Name | Kind | Effect |
|---|---|---|
| `TRADEPILOT_API_BASE_URL` | variable | `https://` URL of the subscription server ([SERVER.md](SERVER.md)). Without it the app reports "Server not configured", and trials and subscriptions are unavailable. |
| `TRADEPILOT_ENTITLEMENT_PUBLIC_KEY` | variable | The server's Ed25519 public key (base64 SPKI), from `npm run keys:generate -w @tradepilot/server`. |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | secrets | Windows Authenticode certificate (base64 `.pfx`) and password. |
| `TRADEPILOT_WIN_PUBLISHER` | variable | Exact certificate subject CN; updates from any other publisher are rejected. |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | secrets | Developer ID Application certificate (base64 `.p12`) and password. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | secrets | Notarization. |

The workflow uses only the built-in `GITHUB_TOKEN`. Never commit certificates, passwords or `.env` files.

## Building locally

```bash
python3 -m pip install -r engine/requirements-build.txt      # PyInstaller (a virtualenv is fine)
npm run build:engine                                          # engine/dist/tradepilot-engine
TRADEPILOT_REQUIRE_BUNDLED_ENGINE=1 npm run package:desktop   # apps/desktop/release/<version>/
npm run test:packaged -- "$PWD/apps/desktop/release/<version>/TradePilot-<version>-x86_64.AppImage"
```

Values in `apps/desktop/.env` are baked into local builds. Release builds take them only from the repository variables above.

## Update test (Linux)

[`apps/desktop/e2e/update.ts`](../apps/desktop/e2e/update.ts) tests the full update path against a local HTTP feed:

1. Installs 0.1.0 as an AppImage.
2. Lets it discover and download 0.1.1, then clicks **Restart and install**.
3. Checks that the installed file is now the exact 0.1.1 build.
4. Starts it with the same profile and password.

Insecure feed URLs are refused unless `TRADEPILOT_ALLOW_INSECURE_UPDATE_URL=1`, which exists only for this test.

```bash
cd apps/desktop && npx electron-vite build
for v in 0.1.0 0.1.1; do
  TRADEPILOT_UPDATE_URL=http://127.0.0.1:47321/ TRADEPILOT_ALLOW_INSECURE_UPDATE_URL=1 \
    npx electron-builder --config electron-builder.config.cjs --linux AppImage -c.extraMetadata.version=$v --publish never
done
cd ../.. && npx tsx apps/desktop/e2e/update.ts
```

Windows and macOS update installation have not been run end to end. Windows needs a second published release to update to. macOS needs a Developer ID–signed build.
