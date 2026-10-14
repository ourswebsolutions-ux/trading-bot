/**
 * electron-builder configuration.
 *
 * Update feed: GitHub Releases of ourswebsolutions-ux/trading-bot (public). electron-updater reads
 * latest.yml / latest-linux.yml / latest-mac.yml from the newest published (non-draft, non-prerelease)
 * release and verifies the SHA-512 of every download. To use another HTTPS host instead, set
 * TRADEPILOT_UPDATE_URL (generic provider).
 *
 * Trading engine: release builds bundle the PyInstaller executable from engine/dist/tradepilot-engine
 * (built by `node scripts/build-engine.mjs`), so users do not need Python. Set
 * TRADEPILOT_REQUIRE_BUNDLED_ENGINE=1 (CI does) to fail the build if it is missing.
 *
 * Code signing (optional; builds are unsigned without it):
 *   Windows: CSC_LINK / CSC_KEY_PASSWORD (or WIN_CSC_LINK) + TRADEPILOT_WIN_PUBLISHER (certificate subject CN).
 *   macOS:   CSC_LINK / CSC_KEY_PASSWORD (Developer ID Application) + APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID for notarization.
 * Unsigned macOS builds are ad-hoc signed; macOS refuses to auto-update them, so the app reports
 * "download the new version manually" instead of attempting it.
 */
const { existsSync } = require('node:fs')
const path = require('node:path')

const updateUrl = process.env.TRADEPILOT_UPDATE_URL
if (updateUrl && !/^https:\/\//.test(updateUrl) && process.env.TRADEPILOT_ALLOW_INSECURE_UPDATE_URL !== '1') {
  throw new Error('TRADEPILOT_UPDATE_URL must be https:// (set TRADEPILOT_ALLOW_INSECURE_UPDATE_URL=1 only for a local test feed)')
}

const bundledEngine = path.resolve(__dirname, '../../engine/dist/tradepilot-engine')
const hasBundledEngine = existsSync(bundledEngine)
if (!hasBundledEngine && process.env.TRADEPILOT_REQUIRE_BUNDLED_ENGINE === '1') {
  throw new Error(`Bundled engine missing at ${bundledEngine}. Run: node scripts/build-engine.mjs`)
}

const macSigned = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.axoraweb.tradepilot',
  productName: 'TradePilot',
  executableName: 'tradepilot',
  copyright: 'Copyright © AxoraWeb',
  directories: { output: 'release/${version}', buildResources: 'build' },
  files: ['out/**/*', 'package.json'],
  extraMetadata: { tradepilotBuild: { macSigned } },
  extraResources: [
    // Python sources: used only when the bundled executable is absent (developer packages)
    { from: '../../engine/tradepilot_engine', to: 'engine/tradepilot_engine', filter: ['**/*.py'] },
    { from: '../../engine/run_engine.py', to: 'engine/run_engine.py' },
    ...(hasBundledEngine ? [{ from: bundledEngine, to: 'engine/bin' }] : [])
  ],
  asar: true,
  publish: updateUrl
    ? [{ provider: 'generic', url: updateUrl, channel: 'latest' }]
    : [{ provider: 'github', owner: 'ourswebsolutions-ux', repo: 'trading-bot', releaseType: 'release' }],
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    executableName: 'tradepilot',
    icon: 'build/icon.png',
    desktop: { entry: { StartupWMClass: 'TradePilot' } },
    category: 'Finance',
    maintainer: 'AxoraWeb <ourswebsolutions@gmail.com>',
    synopsis: 'Desktop trading terminal with AI strategy prompting'
  },
  appImage: { artifactName: 'TradePilot-${version}-${arch}.${ext}' },
  deb: { packageName: 'tradepilot', artifactName: 'tradepilot_${version}_${arch}.${ext}', depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0'] },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    // electron-updater verifies the downloaded installer is signed by this publisher.
    ...(process.env.TRADEPILOT_WIN_PUBLISHER ? { signtoolOptions: { publisherName: [process.env.TRADEPILOT_WIN_PUBLISHER] } } : {})
  },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, artifactName: 'TradePilot-Setup-${version}.${ext}' },
  mac: {
    target: ['dmg', 'zip'],
    icon: 'build/icon.png',
    category: 'public.app-category.finance',
    hardenedRuntime: macSigned,
    // without a Developer ID certificate the app is ad-hoc signed (required to run on Apple silicon)
    ...(macSigned ? {} : { identity: '-' }),
    notarize: Boolean(process.env.APPLE_TEAM_ID),
    artifactName: 'TradePilot-${version}-${arch}.${ext}'
  },
  dmg: { artifactName: 'TradePilot-${version}-${arch}.${ext}' }
}
