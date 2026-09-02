import { describe, expect, it } from 'vitest'

import { epochComparable, validateStartupRecords } from './startupStage'

describe('startupStage e2e utils', () => {
  it('validates empty disabled state', () => {
    expect(
      validateStartupRecords({ enabled: false, records: [], overflowed: false, epochAnchorMs: 0, perfAnchorMs: 0 })
    ).toEqual([])
  })
  it('rejects disabled with records', () => {
    const problems = validateStartupRecords({
      enabled: false,
      records: [{ stage: 'main.restore' as any, status: 'ok', durationMs: 1, epochMs: Date.now(), elapsedMs: 1 }],
      overflowed: false,
      epochAnchorMs: 0,
      perfAnchorMs: 0
    })
    expect(problems.some((p) => p.includes('disabled'))).toBe(true)
  })
  it('rejects duplicate stage', () => {
    const now = Date.now()
    const state = {
      enabled: true,
      records: [
        { stage: 'renderer.bootstrap' as any, status: 'ok' as const, durationMs: 1, epochMs: now, elapsedMs: 1 },
        { stage: 'renderer.bootstrap' as any, status: 'ok' as const, durationMs: 2, epochMs: now, elapsedMs: 2 }
      ],
      overflowed: false,
      epochAnchorMs: now,
      perfAnchorMs: performance.now()
    }
    expect(validateStartupRecords(state).some((p) => p.includes('duplicate'))).toBe(true)
  })
  it('epochComparable within 60s', () => {
    const now = Date.now()
    const a = { enabled: true, records: [], overflowed: false, epochAnchorMs: now, perfAnchorMs: 0 }
    const b = { enabled: true, records: [], overflowed: false, epochAnchorMs: now + 10_000, perfAnchorMs: 0 }
    expect(epochComparable(a as any, b as any)).toBe(true)
    const c = { ...b, epochAnchorMs: now + 61_000 }
    expect(epochComparable(a as any, c as any)).toBe(false)
  })
})
