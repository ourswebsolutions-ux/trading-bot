/**
 * electron-builder configuration.
 *
 * Auto-update feed: set TRADEPILOT_UPDATE_URL to the HTTPS base URL where release
 * artifacts + latest*.yml are uploaded (generic provider), e.g. https://updates.example.com/tradepilot/.
 * Without it, packages are built WITHOUT an update feed and the app reports updates as "not configured".
 *
 * Code signing (required for trustworthy updates):
 *   Windows: CSC_LINK / CSC_KEY_PASSWORD (or WIN_CSC_LINK) + TRADEPILOT_WIN_PUBLISHER (certificate subject CN).
 *   macOS:   CSC_LINK / CSC_KEY_PASSWORD (Developer ID Application) + APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID for notarization.
 */
const updateUrl = process.env.TRADEPILOT_UPDATE_URL
if (updateUrl && !/^https:\/\//.test(updateUrl) && process.env.TRADEPILOT_ALLOW_INSECURE_UPDATE_URL !== '1') {
  throw new Error('TRADEPILOT_UPDATE_URL must be https:// (set TRADEPILOT_ALLOW_INSECURE_UPDATE_URL=1 only for a local test feed)')
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.axoraweb.tradepilot',
  productName: 'TradePilot',
  copyright: 'Copyright © AxoraWeb',
  directories: { output: 'release/${version}', buildResources: 'build' },
  files: ['out/**/*', 'package.json'],
  extraResources: [
    { from: '../../engine/tradepilot_engine', to: 'engine/tradepilot_engine', filter: ['**/*.py'] },
    { from: '../../engine/run_engine.py', to: 'engine/run_engine.py' }
  ],
  asar: true,
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl, channel: 'latest' }] : null,
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Finance',
    maintainer: 'AxoraWeb <support@axoraweb.example>'
  },
  win: {
    target: ['nsis'],
    // electron-updater verifies the downloaded installer is signed by this publisher.
    ...(process.env.TRADEPILOT_WIN_PUBLISHER ? { signtoolOptions: { publisherName: [process.env.TRADEPILOT_WIN_PUBLISHER] } } : {})
  },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.finance',
    hardenedRuntime: true,
    notarize: Boolean(process.env.APPLE_TEAM_ID)
  }
}
