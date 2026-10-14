import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, EVENTS, type Channel, type EventName, type TradePilotBridge } from '../shared/ipc'

const allowedChannels = new Set<string>(CHANNELS)
const allowedEvents = new Set<string>(EVENTS)

/** The only surface the renderer gets: whitelisted invoke channels and push events. No Node, no raw ipcRenderer. */
const bridge: TradePilotBridge = {
  invoke(channel: Channel, ...args: unknown[]) {
    if (!allowedChannels.has(channel)) return Promise.resolve({ ok: false, error: { code: 'forbidden', message: 'Unknown channel' } })
    return ipcRenderer.invoke(channel, args[0])
  },
  on(event: EventName, listener: (payload: unknown) => void) {
    if (!allowedEvents.has(event)) return () => {}
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(`event:${event}`, wrapped)
    return () => ipcRenderer.removeListener(`event:${event}`, wrapped)
  }
} as TradePilotBridge

contextBridge.exposeInMainWorld('tradepilot', bridge)
