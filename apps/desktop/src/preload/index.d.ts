import type { TradePilotBridge } from '../shared/ipc'

declare global {
  interface Window {
    tradepilot: TradePilotBridge
  }
}
export {}
