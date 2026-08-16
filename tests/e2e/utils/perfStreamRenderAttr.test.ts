/**
 * Pure unit tests for the PERF-STREAM-ATTR-002 renderer-attribution derivation
 * helpers (tests/e2e/utils/perfStreamRenderAttr.ts). These run in the Node
 * `e2e-utils` vitest lane and lock the nontrivial derivation logic — profile
 * resolution, the steady-state cutoff, the next-DOM/monotonic pairing rule, and
 * per-assistant metric aggregation — independently of any Electron/Playwright
 * runtime (LOCK-STREAM-RENDER-005/006).
 */
import { describe, expect, it } from 'vitest'

import {
  PERF_STREAM_RENDER_SCALE_ENV,
  PROFILE_CODE,
  deriveAssistantSample,
  pairNextDomToRedux,
  renderScaleGateEnabled,
  resolveRenderScaleProfile,
  steadyStateCutoff,
  type RenderReduxPoint,
  type RenderSeriesPoint
} from './perfStreamRenderAttr'

const ORIGINAL_ENV = process.env[PERF_STREAM_RENDER_SCALE_ENV]

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env[PERF_STREAM_RENDER_SCALE_ENV]
  if (value === undefined) delete process.env[PERF_STREAM_RENDER_SCALE_ENV]
  else process.env[PERF_STREAM_RENDER_SCALE_ENV] = value
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env[PERF_STREAM_RENDER_SCALE_ENV]
    else process.env[PERF_STREAM_RENDER_SCALE_ENV] = previous
  }
}

describe('resolveRenderScaleProfile', () => {
  it('resolves n1/n2/n3 to the correct benchmark ids, profile codes and model counts', () => {
    withEnv('n1', () => {
      const p = resolveRenderScaleProfile()
      expect(p.kind).toBe('n1')
      expect(p.benchmarkId).toBe('chatdb-stream-render-e2e-n1')
      expect(p.mentionModelCount).toBe(1)
      expect(PROFILE_CODE[p.kind]).toBe(0)
    })
    withEnv('N2', () => {
      const p = resolveRenderScaleProfile()
      expect(p.kind).toBe('n2')
      expect(p.benchmarkId).toBe('chatdb-stream-render-e2e-n2')
      expect(p.mentionModelCount).toBe(2)
      expect(PROFILE_CODE[p.kind]).toBe(1)
    })
    withEnv(' n3 ', () => {
      const p = resolveRenderScaleProfile()
      expect(p.kind).toBe('n3')
      expect(p.benchmarkId).toBe('chatdb-stream-render-e2e-n3')
      expect(p.mentionModelCount).toBe(3)
      expect(PROFILE_CODE[p.kind]).toBe(2)
    })
  })

  it('throws on an unsupported non-empty value', () => {
    withEnv('n4', () => expect(() => resolveRenderScaleProfile()).toThrow(/expected "n1", "n2" or "n3"/))
    withEnv('bogus', () => expect(() => resolveRenderScaleProfile()).toThrow(/unsupported/))
  })

  it('env-gate is true only for an explicit non-empty profile (unset/empty skips; invalid values are NOT skipped so they fail in the resolver)', () => {
    withEnv(undefined, () => expect(renderScaleGateEnabled()).toBe(false))
    withEnv('', () => expect(renderScaleGateEnabled()).toBe(false))
    withEnv('   ', () => expect(renderScaleGateEnabled()).toBe(false))
    withEnv('n2', () => expect(renderScaleGateEnabled()).toBe(true))
    withEnv('N1', () => expect(renderScaleGateEnabled()).toBe(true))
    // An explicit but unsupported value is still "requested": the gate must NOT
    // skip it — resolveRenderScaleProfile() throws fail-loud instead.
    withEnv('n9', () => expect(renderScaleGateEnabled()).toBe(true))
    withEnv('bogus', () => expect(renderScaleGateEnabled()).toBe(true))
  })
})

describe('steadyStateCutoff', () => {
  const finalLength = 1000
  const redux: RenderReduxPoint[] = [
    { t: 100, len: 0, status: 'pending' },
    { t: 200, len: 250, status: 'pending' },
    { t: 350, len: 500, status: 'pending' },
    { t: 500, len: 750, status: 'pending' },
    { t: 650, len: 1000, status: 'pending' }, // completion-tail boundary: exact final length
    { t: 700, len: 1000, status: 'success' } // status-flip at the same length (excluded from steady)
  ]

  it('cuts the steady window at the first commit reaching the exact final length', () => {
    const cutoff = steadyStateCutoff(redux, finalLength)
    expect(cutoff.cutoffT).toBe(650)
    // The tail boundary is the first point at that timestamp in the RAW series.
    expect(redux[cutoff.tailIndex]).toEqual({ t: 650, len: 1000, status: 'pending' })
  })

  it('treats a series that never reaches the final length as fully non-steady (fail-closed)', () => {
    const truncated = redux.slice(0, 4)
    const cutoff = steadyStateCutoff(truncated, finalLength)
    // No steady content remains: cutoffT equals the last content commit's time so
    // no content commit is strictly before it.
    expect(cutoff.cutoffT).toBe(500)
    expect(cutoff.tailIndex).toBe(truncated.length)
  })

  it('is monotonic in the final length: a larger final length cuts earlier', () => {
    const c1 = steadyStateCutoff(redux, 1000)
    const c2 = steadyStateCutoff(redux, 10000)
    expect(c2.cutoffT).toBeGreaterThanOrEqual(c1.cutoffT)
  })
})

describe('pairNextDomToRedux', () => {
  const dom: RenderSeriesPoint[] = [
    { t: 220, len: 250 },
    { t: 360, len: 500 },
    { t: 520, len: 750 },
    { t: 680, len: 1000 }
  ]

  it('pairs each steady Redux commit to the earliest DOM commit at-or-after it', () => {
    const steady: RenderReduxPoint[] = [
      { t: 200, len: 250, status: 'pending' },
      { t: 350, len: 500, status: 'pending' },
      { t: 500, len: 750, status: 'pending' }
    ]
    const pairing = pairNextDomToRedux(steady, dom)
    expect(pairing.covered).toBe(true)
    expect(pairing.domIndex).toEqual([0, 1, 2])
    expect(pairing.intervalMs).toEqual([20, 10, 20])
  })

  it('allows non-1:1 pairing (multiple Redux commits to one DOM commit) — never asserts equality', () => {
    // Two Redux commits land between two DOM commits: both pair to the same next DOM commit.
    const steady: RenderReduxPoint[] = [
      { t: 300, len: 420, status: 'pending' },
      { t: 310, len: 470, status: 'pending' }
    ]
    const sparseDom: RenderSeriesPoint[] = [
      { t: 220, len: 250 },
      { t: 360, len: 500 } // the next commit at-or-after both Redux commits
    ]
    const pairing = pairNextDomToRedux(steady, sparseDom)
    expect(pairing.covered).toBe(true)
    expect(pairing.domIndex).toEqual([1, 1])
    expect(pairing.intervalMs[0]).toBe(60)
    expect(pairing.intervalMs[1]).toBe(50)
  })

  it('is monotonic and always non-negative (next-DOM cannot precede its Redux commit)', () => {
    const steady: RenderReduxPoint[] = [
      { t: 100, len: 100, status: 'pending' },
      { t: 500, len: 700, status: 'pending' }
    ]
    const pairing = pairNextDomToRedux(steady, dom)
    expect(pairing.domIndex[0]).toBeLessThanOrEqual(pairing.domIndex[1]!)
    expect(pairing.intervalMs.every((v) => Number.isFinite(v) && v >= 0)).toBe(true)
  })

  it('reports uncovered when a steady Redux commit has no next DOM commit', () => {
    // The only DOM commit is before the only Redux commit.
    const steady: RenderReduxPoint[] = [{ t: 900, len: 900, status: 'pending' }]
    const pairing = pairNextDomToRedux(steady, dom)
    expect(pairing.covered).toBe(false)
    expect(pairing.domIndex).toEqual([-1])
    expect(Number.isNaN(pairing.intervalMs[0])).toBe(true)
  })
})

describe('deriveAssistantSample', () => {
  const finalLength = 1000
  const tSend = 100
  const redux: RenderReduxPoint[] = [
    { t: 300, len: 250, status: 'pending' },
    { t: 450, len: 500, status: 'pending' },
    { t: 600, len: 750, status: 'pending' },
    { t: 750, len: 1000, status: 'pending' }, // completion-tail boundary
    { t: 760, len: 1000, status: 'success' }
  ]
  const dom: RenderSeriesPoint[] = [
    { t: 320, len: 250 },
    { t: 470, len: 500 },
    { t: 620, len: 750 },
    { t: 770, len: 1000 }
  ]

  it('derives send-relative first content, steady intervals, content-size and pairing flags', () => {
    const d = deriveAssistantSample('asst-1', redux, dom, finalLength, tSend)
    expect(d.messageId).toBe('asst-1')
    expect(d.finalLength).toBe(finalLength)
    // Redux first content is send-relative: 300 - 100 = 200.
    expect(d.reduxFirstContentMs).toBe(200)
    // Redux completion (success commit at t=760) is send-relative: 660.
    expect(d.reduxCompletionMs).toBe(660)
    // Steady content commits (t < 750): len 250/500/750 → intervals 150,150.
    expect(d.reduxCommitIntervalsMs).toEqual([150, 150])
    expect(d.domFirstContentMs).toBe(220)
    expect(d.domCommitIntervalsMs).toEqual([150, 150])
    // Redux→next-DOM: pair each steady Redux commit with next DOM at-or-after it.
    // Steady Redux: t=300(→DOM 320), t=450(→470), t=600(→620). Tail t=750 excluded.
    expect(d.reduxToDomIntervalsMs).toEqual([20, 20, 20])
    // Content-size amplification: all Redux content commits (tail included) =
    // 250+500+750+1000 (final content) + 1000 (the success status-flip re-commits
    // the same full length — a distinct (len,status) record) = 3500.
    expect(d.accumulatedBytes).toBe(3500)
    // Steady content-size: 250+500+750.
    expect(d.steadyAccumulatedBytes).toBe(1500)
    expect(d.pairingMonotonic).toBe(true)
    expect(d.pairingCovered).toBe(true)
    expect(d.steadyTailExcluded).toBe(true)
    expect(d.reduxSizeReached).toBe(true)
  })

  it('surfaces a missing DOM series as uncovered with NaN DOM first content (fail-closed)', () => {
    const d = deriveAssistantSample('asst-2', redux, [], finalLength, tSend)
    expect(Number.isNaN(d.domFirstContentMs)).toBe(true)
    expect(d.domCommitIntervalsMs).toEqual([])
    expect(d.reduxToDomIntervalsMs).toEqual([])
    expect(d.pairingCovered).toBe(false)
    expect(d.reduxSizeReached).toBe(true)
  })

  it('reports reduxSizeReached=false when the Redux series never reaches the exact final length', () => {
    const truncated = redux.slice(0, 3)
    const d = deriveAssistantSample('asst-3', truncated, dom, finalLength, tSend)
    expect(d.reduxSizeReached).toBe(false)
    expect(d.accumulatedBytes).toBe(1500)
  })
})

// Restore the env so the test file leaves no side effects.
describe('env hygiene', () => {
  it('restores the original PERF_STREAM_RENDER_SCALE value', () => {
    expect(process.env[PERF_STREAM_RENDER_SCALE_ENV]).toBe(ORIGINAL_ENV)
  })
})
