import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deltaSizingSpec, isValidVolume, roundVolumeDown, sameVolume, sizingSpecOf } from '../src/shared/sizing.js'

describe('broker-neutral sizing', () => {
  const lots = { valuePerPoint: 100_000, unitsPerVolume: 100_000, volumeStep: 0.01, volumeMin: 0.01, volumeMax: 50, volumeUnit: 'lots', contractValue: null }

  it('treats instruments without sizing fields as whole Delta contracts', () => {
    assert.deepEqual(sizingSpecOf({ contractValue: 0.001 }), deltaSizingSpec(0.001))
    assert.deepEqual(deltaSizingSpec(0.001), { valuePerPoint: 0.001, unitsPerVolume: 0.001, volumeStep: 1, volumeMin: 1, volumeMax: null, volumeUnit: 'contracts' })
    assert.equal(sizingSpecOf({ contractValue: null }), null, 'no size information: cannot be traded')
    assert.equal(sizingSpecOf({ contractValue: 0 }), null)
  })

  it('reads explicit fractional-lot specs and fills sensible defaults', () => {
    assert.deepEqual(sizingSpecOf(lots), { valuePerPoint: 100_000, unitsPerVolume: 100_000, volumeStep: 0.01, volumeMin: 0.01, volumeMax: 50, volumeUnit: 'lots' })
    assert.deepEqual(sizingSpecOf({ contractValue: null, valuePerPoint: 10, volumeStep: 0.1 }), { valuePerPoint: 10, unitsPerVolume: 10, volumeStep: 0.1, volumeMin: 0.1, volumeMax: null, volumeUnit: 'units' })
  })

  it('rounds down to the step without float noise', () => {
    assert.equal(roundVolumeDown(0.4545, { volumeStep: 0.01 }), 0.45)
    assert.equal(roundVolumeDown(0.07, { volumeStep: 0.01 }), 0.07)
    assert.equal(roundVolumeDown(0.1 + 0.2, { volumeStep: 0.1 }), 0.3)
    assert.equal(roundVolumeDown(49.999, { volumeStep: 1 }), 49)
    assert.equal(roundVolumeDown(2.9999999999, { volumeStep: 1 }), 3)
    assert.equal(roundVolumeDown(1.23456, { volumeStep: 0.001 }), 1.234)
    assert.equal(roundVolumeDown(3e-7, { volumeStep: 1e-7 }), 3e-7)
    assert.equal(roundVolumeDown(-1, { volumeStep: 0.01 }), 0)
    assert.equal(roundVolumeDown(Number.NaN, { volumeStep: 0.01 }), 0)
  })

  it('validates volumes against step, minimum and maximum', () => {
    const spec = sizingSpecOf(lots)!
    for (const ok of [0.01, 0.07, 0.3, 1, 50]) assert.equal(isValidVolume(ok, spec), true, String(ok))
    for (const bad of [0, -1, 0.005, 0.015, 50.01, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(isValidVolume(bad, spec), false, String(bad))
    const delta = deltaSizingSpec(0.001)
    for (const ok of [1, 2, 1_000_000]) assert.equal(isValidVolume(ok, delta), true)
    for (const bad of [0.5, 1.5, 0]) assert.equal(isValidVolume(bad, delta), false, 'Delta contracts must be whole')
  })

  it('compares volumes with float tolerance', () => {
    assert.equal(sameVolume(0.1 + 0.2, 0.3), true)
    assert.equal(sameVolume(0.3, 0.31), false)
    assert.equal(sameVolume(50, 50), true)
  })
})
