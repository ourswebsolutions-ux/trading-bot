import { app } from 'electron'

/**
 * Build-time configuration (electron-vite injects MAIN_VITE_* from .env / CI env).
 * Development builds may override via TRADEPILOT_* environment variables; packaged
 * builds ignore those so end users cannot redirect the app to another server.
 */
export interface DesktopConfig {
  apiBaseUrl: string
  entitlementPublicKey: string
  configurationError: string | null
}

export function loadDesktopConfig(): DesktopConfig {
  const dev = !app.isPackaged
  const apiBaseUrl = ((dev && process.env.TRADEPILOT_API_URL) || import.meta.env.MAIN_VITE_API_BASE_URL || '').replace(/\/+$/, '')
  const entitlementPublicKey = (dev && process.env.TRADEPILOT_ENTITLEMENT_PUBLIC_KEY) || import.meta.env.MAIN_VITE_ENTITLEMENT_PUBLIC_KEY || ''
  let configurationError: string | null = null
  if (!apiBaseUrl) configurationError = 'This build has no subscription server configured (MAIN_VITE_API_BASE_URL).'
  else if (!dev && !apiBaseUrl.startsWith('https://')) configurationError = 'The subscription server must use HTTPS in release builds.'
  else if (!entitlementPublicKey) configurationError = 'This build has no entitlement public key configured (MAIN_VITE_ENTITLEMENT_PUBLIC_KEY).'
  return { apiBaseUrl, entitlementPublicKey, configurationError }
}
