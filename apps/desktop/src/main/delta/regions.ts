/** Official Delta Exchange API endpoints per region (verified against the live services). */
export type DeltaRegion = 'india' | 'global' | 'india_testnet' | 'global_testnet'

export interface RegionInfo {
  id: DeltaRegion
  label: string
  rest: string
  ws: string
  testnet: boolean
}

export const DELTA_REGIONS: Record<DeltaRegion, RegionInfo> = {
  india: { id: 'india', label: 'Delta Exchange India', rest: 'https://api.india.delta.exchange', ws: 'wss://socket.india.delta.exchange', testnet: false },
  global: { id: 'global', label: 'Delta Exchange Global', rest: 'https://api.delta.exchange', ws: 'wss://socket.delta.exchange', testnet: false },
  india_testnet: { id: 'india_testnet', label: 'Delta Exchange India (testnet)', rest: 'https://cdn-ind.testnet.deltaex.org', ws: 'wss://socket-ind.testnet.deltaex.org', testnet: true },
  global_testnet: { id: 'global_testnet', label: 'Delta Exchange Global (testnet)', rest: 'https://testnet-api.delta.exchange', ws: 'wss://testnet-socket.delta.exchange', testnet: true }
}

export const isRegion = (v: unknown): v is DeltaRegion => typeof v === 'string' && v in DELTA_REGIONS

/** Phase 1 stored the REST base URL; map it to a region. */
export function regionFromLegacyBaseUrl(url: string | undefined): DeltaRegion | null {
  return (Object.values(DELTA_REGIONS).find((r) => r.rest === url)?.id as DeltaRegion | undefined) ?? null
}
