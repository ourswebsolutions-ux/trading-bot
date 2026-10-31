/**
 * Broker-neutral position sizing. An order's size is a "volume" in the venue's own unit
 * (Delta: whole contracts; other venues: fractional lots), described by a SizingSpec.
 * Pure functions shared by the main process and tests; the Python engine mirrors them
 * (engine/tradepilot_engine/live.py).
 */
import type { Instrument } from './ipc'

export interface SizingSpec {
  /** Account-currency value of a 1.0 price move for 1 unit of volume (Delta: the contract value). */
  valuePerPoint: number
  /** Underlying units per 1 unit of volume, for fixed-quantity sizing (Delta: the contract value). */
  unitsPerVolume: number
  volumeStep: number
  volumeMin: number
  /** Null when the venue sets no maximum. */
  volumeMax: number | null
  /** Shown in messages ("contracts", "lots"). */
  volumeUnit: string
}

/** Delta Exchange perpetuals: whole contracts of `contractValue` underlying units each. */
export function deltaSizingSpec(contractValue: number): SizingSpec {
  return { valuePerPoint: contractValue, unitsPerVolume: contractValue, volumeStep: 1, volumeMin: 1, volumeMax: null, volumeUnit: 'contracts' }
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * The instrument's sizing spec, or null when it cannot be traded automatically. Instruments
 * without broker-neutral fields are Delta contracts (backward compatible).
 */
export function sizingSpecOf(inst: Pick<Instrument, 'contractValue' | 'valuePerPoint' | 'unitsPerVolume' | 'volumeStep' | 'volumeMin' | 'volumeMax' | 'volumeUnit'>): SizingSpec | null {
  if (positive(inst.valuePerPoint)) {
    const step = positive(inst.volumeStep) ? inst.volumeStep : 1
    return {
      valuePerPoint: inst.valuePerPoint,
      unitsPerVolume: positive(inst.unitsPerVolume) ? inst.unitsPerVolume : inst.valuePerPoint,
      volumeStep: step,
      volumeMin: positive(inst.volumeMin) ? inst.volumeMin : step,
      volumeMax: positive(inst.volumeMax) ? inst.volumeMax : null,
      volumeUnit: inst.volumeUnit || 'units'
    }
  }
  return positive(inst.contractValue) ? deltaSizingSpec(inst.contractValue) : null
}

/** Decimal places of the step (0.01 → 2), so rounded volumes have no float noise. */
function stepDecimals(step: number): number {
  if (step >= 1 && Number.isInteger(step)) return 0
  const s = step.toString()
  const exp = /e-(\d+)$/.exec(s)
  if (exp) return Number(exp[1])
  return Math.min(10, (s.split('.')[1] ?? '').length)
}

/** Rounds a volume down to the step (never up: an order must not exceed what was sized). */
export function roundVolumeDown(volume: number, spec: Pick<SizingSpec, 'volumeStep'>): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0
  const steps = Math.floor(volume / spec.volumeStep + 1e-9)
  return Number((steps * spec.volumeStep).toFixed(stepDecimals(spec.volumeStep)))
}

/** True when the volume is a positive multiple of the step within the venue's min/max. */
export function isValidVolume(volume: number, spec: SizingSpec): boolean {
  if (!Number.isFinite(volume) || volume <= 0) return false
  if (volume < spec.volumeMin - 1e-9) return false
  if (spec.volumeMax !== null && volume > spec.volumeMax + 1e-9) return false
  const steps = volume / spec.volumeStep
  return Math.abs(steps - Math.round(steps)) < 1e-6
}

/** Equality for volumes that may carry float noise (0.1 + 0.2). */
export function sameVolume(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}
