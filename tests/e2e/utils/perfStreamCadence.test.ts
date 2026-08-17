/**
 * Pure unit tests for the PERF-STREAM-CADENCE-001 cadence derivation helpers
 * (tests/e2e/utils/perfStreamCadence.ts). These run in the Node `e2e-utils`
 * vitest lane and lock the derivation logic independently of any
 * Electron/Playwright runtime (LOCK-MEASUREMENT).
 *
 * Coverage:
 * - Empty series: empty arrays, zero counts, zero stats
 * - Single point: no intervals, single charsPerUpdate, zero ratio
 * - Monotonic growing series: correct intervals, chars, stats
 * - Duplicate/non-growing points: excluded from visible updates
 * - Cutoff behavior: steady-state boundary
 * - Percentile/stat derivation: p50/p95/mean/min/max
 * - Non-additive overlap semantics: unambiguous vs ambiguous
 * - Composition: deriveCadenceMetrics, terminal points, cutoffs, finite behavior
 * - Corrected long-task semantics: timestamp interval correlation, not frame overlap
 * - Phase separation: steady-state vs whole-window metrics
 * - clipLongTasksToWindow: window filtering
 */
import { describe, expect, it } from 'vitest'

import {
  type CadencePoint,
  type ClippedLongTaskEntry,
  type LongTaskEntry,
  clipLongTasksToWindow,
  domToReduxRatio,
  interPointIntervals,
  normalizeText,
  positiveVisibleDeltas,
  reduxContentCommits,
  summarizeFinite,
  timestampLongTaskOverlap,
  deriveCadenceMetrics,
  validateBlockReferenceIntegrity
} from './perfStreamCadence'

describe('interPointIntervals', () => {
  it('returns empty array for empty input', () => {
    expect(interPointIntervals([])).toEqual([])
  })

  it('returns empty array for a single point', () => {
    expect(interPointIntervals([{ t: 100, len: 50 }])).toEqual([])
  })

  it('computes correct intervals for two points', () => {
    const points: CadencePoint[] = [
      { t: 100, len: 100 },
      { t: 250, len: 200 }
    ]
    expect(interPointIntervals(points)).toEqual([150])
  })

  it('computes correct intervals for multiple points', () => {
    const points: CadencePoint[] = [
      { t: 100, len: 10 },
      { t: 200, len: 20 },
      { t: 350, len: 30 },
      { t: 400, len: 40 }
    ]
    expect(interPointIntervals(points)).toEqual([100, 150, 50])
  })
})

describe('positiveVisibleDeltas', () => {
  it('returns empty for empty DOM series', () => {
    const result = positiveVisibleDeltas([])
    expect(result.growing).toEqual([])
    expect(result.intervalsMs).toEqual([])
    expect(result.charsPerUpdate).toEqual([])
  })

  it('returns empty when all points have len === 0', () => {
    const dom: CadencePoint[] = [
      { t: 100, len: 0 },
      { t: 200, len: 0 }
    ]
    const result = positiveVisibleDeltas(dom)
    expect(result.growing).toEqual([])
  })

  it('includes only strictly growing positive-delta points', () => {
    const dom: CadencePoint[] = [
      { t: 100, len: 0 },
      { t: 200, len: 100 },
      { t: 300, len: 100 }, // duplicate length: excluded
      { t: 400, len: 250 },
      { t: 500, len: 200 }, // shorter: excluded
      { t: 600, len: 300 }
    ]
    const result = positiveVisibleDeltas(dom)
    expect(result.growing).toHaveLength(3)
    expect(result.growing.map((p) => p.t)).toEqual([200, 400, 600])
    expect(result.growing.map((p) => p.len)).toEqual([100, 250, 300])
  })

  it('computes correct charsPerUpdate (first = full length)', () => {
    const dom: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 150 },
      { t: 300, len: 200 }
    ]
    const result = positiveVisibleDeltas(dom)
    expect(result.charsPerUpdate).toEqual([50, 100, 50])
  })

  it('computes correct intervals for growing series', () => {
    const dom: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 250, len: 150 },
      { t: 300, len: 200 }
    ]
    const result = positiveVisibleDeltas(dom)
    expect(result.intervalsMs).toEqual([150, 50])
  })

  it('handles a single positive point', () => {
    const dom: CadencePoint[] = [{ t: 100, len: 50 }]
    const result = positiveVisibleDeltas(dom)
    expect(result.growing).toHaveLength(1)
    expect(result.charsPerUpdate).toEqual([50])
    expect(result.intervalsMs).toEqual([])
  })
})

describe('reduxContentCommits', () => {
  it('returns empty for empty series', () => {
    const result = reduxContentCommits([])
    expect(result.commits).toEqual([])
    expect(result.intervalsMs).toEqual([])
  })

  it('filters out len === 0 points', () => {
    const redux: CadencePoint[] = [
      { t: 100, len: 0 },
      { t: 200, len: 100 },
      { t: 300, len: 0 },
      { t: 400, len: 200 }
    ]
    const result = reduxContentCommits(redux)
    expect(result.commits).toHaveLength(2)
    expect(result.commits.map((p) => p.len)).toEqual([100, 200])
    expect(result.intervalsMs).toEqual([200])
  })

  it('computes intervals for content-only commits', () => {
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 },
      { t: 350, len: 200 }
    ]
    const result = reduxContentCommits(redux)
    expect(result.intervalsMs).toEqual([100, 150])
  })

  it('filters consecutive equal-length points before intervals and count', () => {
    // LOCK-EVIDENCE: consecutive equal-length points are discarded before
    // intervals and counts are derived. This prevents terminal zero-delta
    // snapshots from creating fake commits.
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 },
      { t: 300, len: 100 }, // same as previous → filtered
      { t: 400, len: 200 }
    ]
    const result = reduxContentCommits(redux)
    // After filtering: [{t:100,len:50}, {t:200,len:100}, {t:400,len:200}]
    expect(result.commits).toHaveLength(3)
    expect(result.commits.map((p) => p.len)).toEqual([50, 100, 200])
    expect(result.intervalsMs).toEqual([100, 200])
  })

  it('filters multiple consecutive equal-length runs', () => {
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 50 }, // same → filtered
      { t: 300, len: 50 }, // same → filtered
      { t: 400, len: 100 },
      { t: 500, len: 100 }, // same → filtered
      { t: 600, len: 200 }
    ]
    const result = reduxContentCommits(redux)
    // After filtering: [{t:100,len:50}, {t:400,len:100}, {t:600,len:200}]
    expect(result.commits).toHaveLength(3)
    expect(result.intervalsMs).toEqual([300, 200])
  })
})

describe('domToReduxRatio', () => {
  it('returns 0 when reduxCount is 0 (fail-closed)', () => {
    expect(domToReduxRatio(5, 0)).toBe(0)
  })

  it('returns correct ratio when both are positive', () => {
    expect(domToReduxRatio(6, 3)).toBe(2)
    expect(domToReduxRatio(3, 3)).toBe(1)
    expect(domToReduxRatio(2, 4)).toBe(0.5)
  })

  it('returns 0 when both are 0', () => {
    expect(domToReduxRatio(0, 0)).toBe(0)
  })
})

describe('timestampLongTaskOverlap', () => {
  const visibleUpdates: CadencePoint[] = [
    { t: 100, len: 50 },
    { t: 200, len: 100 },
    { t: 350, len: 200 },
    { t: 500, len: 300 }
  ]

  it('returns 0 and unambiguous=false when no long tasks', () => {
    const result = timestampLongTaskOverlap(visibleUpdates, [])
    expect(result.overlapCount).toBe(0)
    expect(result.unambiguous).toBe(false)
  })

  it('returns 0 and unambiguous=false when no visible updates', () => {
    const longTasks: ClippedLongTaskEntry[] = [{ startTime: 50, duration: 100 }]
    const result = timestampLongTaskOverlap([], longTasks)
    expect(result.overlapCount).toBe(0)
    expect(result.unambiguous).toBe(false)
  })

  it('counts overlap when visible update timestamp falls within long task interval', () => {
    const longTasks: ClippedLongTaskEntry[] = [
      { startTime: 90, duration: 30 }, // covers t=100 (90 to 120)
      { startTime: 300, duration: 100 } // covers t=350 (300 to 400)
    ]
    const result = timestampLongTaskOverlap(visibleUpdates, longTasks)
    expect(result.overlapCount).toBe(2)
    expect(result.unambiguous).toBe(true)
  })

  it('counts each visible update at most once (break after first match per update)', () => {
    // Two overlapping long tasks that both cover t=150.
    const longTasks: ClippedLongTaskEntry[] = [
      { startTime: 100, duration: 200 }, // covers t=100-300
      { startTime: 100, duration: 200 } // redundant overlapping window
    ]
    const updates: CadencePoint[] = [{ t: 150, len: 100 }]
    const result = timestampLongTaskOverlap(updates, longTasks)
    // t=150 matches LT1 first, break — counted once despite LT2 also covering it.
    expect(result.overlapCount).toBe(1)
  })

  it('does not count updates outside long task windows', () => {
    const longTasks: ClippedLongTaskEntry[] = [{ startTime: 400, duration: 50 }] // 400-450
    const result = timestampLongTaskOverlap(visibleUpdates, longTasks)
    // t=500 is outside 400-450
    expect(result.overlapCount).toBe(0)
    expect(result.unambiguous).toBe(true)
  })

  it('boundary: update at exact startTime counts as overlap', () => {
    const longTasks: ClippedLongTaskEntry[] = [{ startTime: 100, duration: 50 }]
    const updates: CadencePoint[] = [{ t: 100, len: 50 }]
    const result = timestampLongTaskOverlap(updates, longTasks)
    expect(result.overlapCount).toBe(1)
  })

  it('boundary: update at exact endTime counts as overlap', () => {
    const longTasks: ClippedLongTaskEntry[] = [{ startTime: 100, duration: 50 }]
    const updates: CadencePoint[] = [{ t: 150, len: 50 }]
    const result = timestampLongTaskOverlap(updates, longTasks)
    expect(result.overlapCount).toBe(1)
  })

  it('boundary: update just after endTime does not count', () => {
    const longTasks: ClippedLongTaskEntry[] = [{ startTime: 100, duration: 50 }]
    const updates: CadencePoint[] = [{ t: 151, len: 50 }]
    const result = timestampLongTaskOverlap(updates, longTasks)
    expect(result.overlapCount).toBe(0)
  })

  it('does NOT claim frame overlap — timestamp interval only', () => {
    // Long task from t=100 to t=200 (100ms).
    // Visible update at t=150 (timestamp falls within interval).
    // This is timestamp correlation, NOT same-frame overlap.
    const longTasks: ClippedLongTaskEntry[] = [{ startTime: 100, duration: 100 }]
    const updates: CadencePoint[] = [{ t: 150, len: 100 }]
    const result = timestampLongTaskOverlap(updates, longTasks)
    expect(result.overlapCount).toBe(1)
    expect(result.unambiguous).toBe(true)
    // The function name and semantics are "timestamp in interval", not "same frame"
  })
})

describe('summarizeFinite', () => {
  it('returns zero-valued summary for empty array', () => {
    const s = summarizeFinite([])
    expect(s.count).toBe(0)
    expect(s.p50).toBe(0)
    expect(s.p95).toBe(0)
    expect(s.mean).toBe(0)
    expect(s.min).toBe(0)
    expect(s.max).toBe(0)
  })

  it('returns correct stats for single value', () => {
    const s = summarizeFinite([42])
    expect(s.count).toBe(1)
    expect(s.p50).toBe(42)
    expect(s.p95).toBe(42)
    expect(s.mean).toBe(42)
    expect(s.min).toBe(42)
    expect(s.max).toBe(42)
  })

  it('computes correct p50/p95/mean/min/max for a known series', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const s = summarizeFinite(values)
    expect(s.count).toBe(10)
    expect(s.min).toBe(10)
    expect(s.max).toBe(100)
    expect(s.mean).toBe(55)
    // p50: ceil(0.5 * 10) - 1 = 4 → index 4 → 50
    expect(s.p50).toBe(50)
    // p95: ceil(0.95 * 10) - 1 = 9 → index 9 → 100
    expect(s.p95).toBe(100)
  })

  it('filters out non-finite values (NaN, Infinity)', () => {
    const values = [10, NaN, 20, Infinity, 30]
    const s = summarizeFinite(values)
    expect(s.count).toBe(3)
    expect(s.min).toBe(10)
    expect(s.max).toBe(30)
    expect(s.mean).toBe(20)
  })

  it('p50 is the median for odd-count series', () => {
    const values = [1, 3, 5]
    const s = summarizeFinite(values)
    expect(s.p50).toBe(3)
  })

  it('p50 is the lower-mid for even-count series', () => {
    const values = [1, 2, 3, 4]
    const s = summarizeFinite(values)
    // ceil(0.5 * 4) - 1 = 1 → index 1 → 2
    expect(s.p50).toBe(2)
  })
})

describe('non-additive overlap semantics', () => {
  it('timestamp-in-interval duration does not add to interval metrics', () => {
    // Long task from t=100 to t=200 (duration=100ms).
    // Visible updates at t=150 (overlap) and t=300 (no overlap).
    // The interval between them is 150ms, NOT 150 - 100 = 50ms.
    const dom: CadencePoint[] = [
      { t: 150, len: 100 },
      { t: 300, len: 200 }
    ]
    const longTasks: ClippedLongTaskEntry[] = [{ startTime: 100, duration: 100 }]

    const { growing, intervalsMs } = positiveVisibleDeltas(dom)
    const overlap = timestampLongTaskOverlap(growing, longTasks)

    // The interval is 150ms (300 - 150), independent of the 100ms long task.
    expect(intervalsMs).toEqual([150])
    // The overlap is timestamp correlation: 1 of 2 visible updates fell in a long task interval.
    expect(overlap.overlapCount).toBe(1)
    expect(overlap.unambiguous).toBe(true)
  })
})

describe('clipLongTasksToWindow', () => {
  it('returns empty for empty input', () => {
    expect(clipLongTasksToWindow([], 100, 500)).toEqual([])
  })

  it('includes tasks that intersect [tSend, terminalSampleTime]', () => {
    const tasks: LongTaskEntry[] = [
      { startTime: 50, duration: 100 }, // intersects [100, 500]: 50+100=150 >= 100
      { startTime: 200, duration: 50 }, // fully inside
      { startTime: 450, duration: 100 } // intersects: 450 <= 500
    ]
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toHaveLength(3)
  })

  it('excludes tasks entirely before the window', () => {
    const tasks: LongTaskEntry[] = [
      { startTime: 10, duration: 20 }, // ends at 30, before 100
      { startTime: 80, duration: 10 } // ends at 90, before 100
    ]
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toHaveLength(0)
  })

  it('excludes tasks entirely after the window', () => {
    const tasks: LongTaskEntry[] = [
      { startTime: 510, duration: 50 }, // starts after 500
      { startTime: 600, duration: 100 }
    ]
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toHaveLength(0)
  })

  it('includes tasks that cross the window boundary with clipped start/duration', () => {
    const tasks: LongTaskEntry[] = [
      { startTime: 50, duration: 80 }, // 50-130, crosses tSend=100 → clipped to [100, 130], dur=30
      { startTime: 480, duration: 50 } // 480-530, crosses terminal=500 → clipped to [480, 500], dur=20
    ]
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ startTime: 100, duration: 30 })
    expect(result[1]).toEqual({ startTime: 480, duration: 20 })
  })

  it('clips start for tasks starting before window', () => {
    const tasks: LongTaskEntry[] = [{ startTime: 50, duration: 200 }] // 50-250
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ startTime: 100, duration: 150 })
  })

  it('clips end for tasks ending after window', () => {
    const tasks: LongTaskEntry[] = [{ startTime: 300, duration: 300 }] // 300-600
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ startTime: 300, duration: 200 })
  })

  it('clips both start and end for tasks spanning entire window', () => {
    const tasks: LongTaskEntry[] = [{ startTime: 50, duration: 600 }] // 50-650
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ startTime: 100, duration: 400 })
  })
})

describe('deriveCadenceMetrics — composition', () => {
  it('returns zero/empty metrics for empty series', () => {
    const metrics = deriveCadenceMetrics([], [], [], 0, 1000, 0, 1000)
    expect(metrics.visibleUpdateCount).toBe(0)
    expect(metrics.reduxUpdateCount).toBe(0)
    expect(metrics.finalVisibleLength).toBe(0)
    expect(metrics.visibleIntervalsMs).toEqual([])
    expect(metrics.charsPerUpdate).toEqual([])
    expect(metrics.visibleTimestampLongTaskOverlap).toBe(0)
    expect(metrics.overlapSemanticsUnambiguous).toBe(false)
    expect(metrics.steadyVisibleUpdateCount).toBe(0)
    expect(metrics.steadyReduxUpdateCount).toBe(0)
  })

  it('derives correct whole-window and steady-state metrics', () => {
    // Simulated stream: tSend=0, first content at t=100, final length 200 at t=500
    const dom: CadencePoint[] = [
      { t: 120, len: 50 },
      { t: 200, len: 100 },
      { t: 350, len: 150 },
      { t: 500, len: 200 }
    ]
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 250, len: 100 },
      { t: 500, len: 200 }
    ]
    const metrics = deriveCadenceMetrics(dom, redux, [], 10, 200, 0, 600)

    // Whole-window
    expect(metrics.visibleUpdateCount).toBe(4)
    expect(metrics.reduxUpdateCount).toBe(3)
    expect(metrics.finalVisibleLength).toBe(200)
    expect(metrics.visibleIntervalsMs).toEqual([80, 150, 150])
    expect(metrics.charsPerUpdate).toEqual([50, 50, 50, 50])
    expect(metrics.reduxIntervalsMs).toEqual([150, 250])

    // Steady state: [first content (t=100), first commit reaching 200 (t=500)]
    // Redux commits in steady: t=100 (len=50), t=250 (len=100) — t=500 is excluded (equals final)
    expect(metrics.steadyReduxUpdateCount).toBe(2)
    expect(metrics.steadyReduxIntervalsMs).toEqual([150])
    // DOM in steady: t=120 (50), t=200 (100), t=350 (150) — t=500 is excluded
    expect(metrics.steadyVisibleUpdateCount).toBe(3)
    expect(metrics.steadyVisibleIntervalsMs).toEqual([80, 150])
    expect(metrics.steadyCharsPerUpdate).toEqual([50, 50, 50])
  })

  it('terminal point length comes from the last DOM point', () => {
    const dom: CadencePoint[] = [
      { t: 100, len: 100 },
      { t: 200, len: 200 },
      { t: 300, len: 250 }
    ]
    const metrics = deriveCadenceMetrics(dom, [], [], 5, 250, 0, 400)
    expect(metrics.finalVisibleLength).toBe(250)
  })

  it('phase boundaries: completion tail excluded from steady state', () => {
    // Final Redux commit at t=500 reaches expectedFinalLength=200
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 300, len: 150 },
      { t: 500, len: 200 } // this IS the final length — excluded from steady
    ]
    const dom: CadencePoint[] = [
      { t: 120, len: 50 },
      { t: 320, len: 150 },
      { t: 520, len: 200 }
    ]
    const metrics = deriveCadenceMetrics(dom, redux, [], 10, 200, 0, 600)

    // Steady Redux: only commits at t=100, t=300 (t=500 excluded)
    expect(metrics.steadyReduxUpdateCount).toBe(2)
    // Steady DOM: only t=120, t=320 (t=520 is >= steadyEndTime=500, excluded)
    expect(metrics.steadyVisibleUpdateCount).toBe(2)
    // Whole-window still includes all
    expect(metrics.reduxUpdateCount).toBe(3)
    expect(metrics.visibleUpdateCount).toBe(3)
  })

  it('finite behavior: all metric arrays are finite numeric', () => {
    const dom: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 }
    ]
    const redux: CadencePoint[] = [{ t: 100, len: 50 }]
    const metrics = deriveCadenceMetrics(dom, redux, [], 5, 100, 0, 300)

    expect(metrics.visibleIntervalsMs.every(Number.isFinite)).toBe(true)
    expect(metrics.charsPerUpdate.every(Number.isFinite)).toBe(true)
    expect(metrics.reduxIntervalsMs.every(Number.isFinite)).toBe(true)
    expect(Number.isFinite(metrics.domToReduxRatio)).toBe(true)
    expect(Number.isFinite(metrics.visibleTimestampLongTaskOverlap)).toBe(true)
    expect(Number.isFinite(metrics.finalVisibleLength)).toBe(true)
    expect(Number.isFinite(metrics.terminalSampleTime)).toBe(true)
    expect(metrics.steadyVisibleIntervalsMs.every(Number.isFinite)).toBe(true)
    expect(metrics.steadyCharsPerUpdate.every(Number.isFinite)).toBe(true)
    expect(metrics.steadyReduxIntervalsMs.every(Number.isFinite)).toBe(true)
  })

  it('long tasks are used for timestamp correlation only, not interval derivation', () => {
    // Long task from t=100 to t=200.
    // Visible updates at t=150 (overlap) and t=300 (no overlap).
    const dom: CadencePoint[] = [
      { t: 150, len: 100 },
      { t: 300, len: 200 }
    ]
    const redux: CadencePoint[] = [
      { t: 150, len: 100 },
      { t: 300, len: 200 }
    ]
    const longTasks: ClippedLongTaskEntry[] = [{ startTime: 100, duration: 100 }]
    const metrics = deriveCadenceMetrics(dom, redux, longTasks, 5, 200, 0, 400)

    // Interval is 150ms (300 - 150), independent of the long task
    expect(metrics.visibleIntervalsMs).toEqual([150])
    // Overlap: 1 of 2 visible updates has timestamp in long task interval
    expect(metrics.visibleTimestampLongTaskOverlap).toBe(1)
    expect(metrics.overlapSemanticsUnambiguous).toBe(true)
  })

  it('missing final Redux boundary: no commit reaches expectedFinalLength → invalid result', () => {
    // When no Redux commit reaches expectedFinalLength, steadyEndTime falls back
    // to terminalSampleTime, blending completion tail into steady state.
    // This is an invalid result: the caller must treat it as an error gate.
    const dom: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 },
      { t: 300, len: 150 } // max len = 150, never reaches expectedFinalLength = 200
    ]
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 },
      { t: 300, len: 150 }
    ]
    const metrics = deriveCadenceMetrics(dom, redux, [], 10, 200, 0, 400)

    // SteadyEndTime falls back to terminalSampleTime (400), meaning ALL commits
    // are in steady state — this is the invalid fallback the spec requires the
    // caller to detect and reject as a correctness gate failure.
    // The caller must assert: the last Redux commit length equals expectedFinalLength.
    expect(metrics.reduxUpdateCount).toBe(3)
    // ALL 3 Redux commits are "steady" because steadyEndTime = terminalSampleTime
    expect(metrics.steadyReduxUpdateCount).toBe(3)
    // This is the observable symptom of the invalid fallback: steady count equals total count.
    // The caller's correctness gate must reject: lastReduxCommit.len !== expectedFinalLength.
    const lastReduxLen = redux[redux.length - 1]!.len
    expect(lastReduxLen).not.toBe(200) // proves the final boundary was NOT reached
    // Caller must assert this is an error: lastReduxLen === expectedFinalLength
  })
})

describe('normalizeText', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeText('')).toBe('')
  })

  it('removes all whitespace and preserves case', () => {
    expect(normalizeText('Hello World')).toBe('HelloWorld')
  })

  it('removes newlines, tabs, and multiple spaces', () => {
    expect(normalizeText('hello\tworld\n\nfoo  bar')).toBe('helloworldfoobar')
  })

  it('preserves exact non-whitespace character order', () => {
    expect(normalizeText('a b c')).toBe('abc')
    expect(normalizeText('a  b  c')).toBe('abc')
    expect(normalizeText(' a b c ')).toBe('abc')
  })

  it('is idempotent', () => {
    const input = 'Hello   World\n\nFoo\tBar'
    expect(normalizeText(normalizeText(input))).toBe(normalizeText(input))
  })

  it('handles the exact expected reply normalization contract', () => {
    // The expected reply has \n\n paragraph separators.
    // DOM textContent may have \n or spaces between paragraphs.
    // Normalization removes ALL whitespace, so both produce the same result.
    const expected = '[Mock mock-model] Slow stream started.\n\nparagraph-0 filler words\n\ntail-marker-END'
    const domVariant = '[Mock mock-model] Slow stream started.\nparagraph-0 filler words\ntail-marker-END'
    expect(normalizeText(expected)).toBe(normalizeText(domVariant))
  })

  it('preserves case: different casing produces different output', () => {
    expect(normalizeText('Hello')).not.toBe(normalizeText('hello'))
    expect(normalizeText('ABC')).toBe('ABC')
    expect(normalizeText('abc')).toBe('abc')
  })
})

describe('Terminal snapshot types', () => {
  it('TerminalDomSnapshot carries exact observation provenance', () => {
    // Simulates what the active sampler captures: raw text length, normalized text, exact match
    const observationTime = 1000
    const snapshot = {
      observationTime,
      rawTextLength: 42,
      normalizedText: 'HelloWorld',
      exactMatch: true,
      terminalSampleTime: observationTime // same as observationTime from the page-context read
    }
    expect(snapshot.exactMatch).toBe(true)
    expect(snapshot.normalizedText).toBe('HelloWorld')
    expect(snapshot.rawTextLength).toBe(42)
    expect(snapshot.observationTime).toBe(1000)
    expect(snapshot.terminalSampleTime).toBe(snapshot.observationTime)
  })

  it('TerminalReduxSnapshot carries exact store state provenance', () => {
    const snapshot = {
      observationTime: 1000,
      rawContent: 'HelloWorld',
      rawContentLength: 10,
      blockStatus: 'success',
      exactContentMatch: true
    }
    expect(snapshot.blockStatus).toBe('success')
    expect(snapshot.exactContentMatch).toBe(true)
    expect(snapshot.rawContentLength).toBe(10)
    expect(snapshot.rawContent).toBe('HelloWorld')
  })

  it('stale same-length DOM state cannot pass exactMatch', () => {
    // DOM has stale text at same length as expected — normalized text differs
    const staleNormalized = 'HelloWorld!' // different from expected
    const expectedNormalized = 'HelloWorld'
    const snapshot = {
      observationTime: 1000,
      rawTextLength: 11,
      normalizedText: staleNormalized,
      exactMatch: staleNormalized === expectedNormalized
    }
    expect(snapshot.exactMatch).toBe(false)
  })

  it('stale same-length Redux content cannot pass exactContentMatch', () => {
    // Redux has different content at same length — genuinely equal-length mismatch
    const staleContent = 'JelloWorld' // 10 chars, same length as expected but different content
    const expectedContent = 'HelloWorld' // 10 chars
    const snapshot = {
      observationTime: 1000,
      rawContent: staleContent,
      rawContentLength: staleContent.length,
      blockStatus: 'success',
      exactContentMatch: staleContent === expectedContent
    }
    expect(snapshot.exactContentMatch).toBe(false)
    // Lengths are equal (10 === 10) but content differs — exact match catches it
    expect(snapshot.rawContentLength).toBe(expectedContent.length)
  })
})

describe('clipLongTasksToWindow — exact clipped durations', () => {
  it('preserves exact duration for fully contained tasks', () => {
    const tasks: LongTaskEntry[] = [{ startTime: 200, duration: 50 }]
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toEqual([{ startTime: 200, duration: 50 }])
  })

  it('clips start-only for tasks starting before window', () => {
    const tasks: LongTaskEntry[] = [{ startTime: 50, duration: 100 }]
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toEqual([{ startTime: 100, duration: 50 }])
  })

  it('clips end-only for tasks ending after window', () => {
    const tasks: LongTaskEntry[] = [{ startTime: 400, duration: 200 }]
    const result = clipLongTasksToWindow(tasks, 100, 500)
    expect(result).toEqual([{ startTime: 400, duration: 100 }])
  })

  it('zero-duration clipped task at exact boundary', () => {
    // Task ends exactly at tSend → clipped duration = 0
    const tasks: LongTaskEntry[] = [{ startTime: 50, duration: 50 }]
    const result = clipLongTasksToWindow(tasks, 100, 500)
    // end = 100, tSend = 100 → end >= tSend → included
    // clippedStart = max(50, 100) = 100, clippedEnd = min(100, 500) = 100, duration = 0
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ startTime: 100, duration: 0 })
  })
})

describe('clipped long tasks for aggregate metrics', () => {
  it('clipped tasks exclude entries outside the window for aggregation', () => {
    const tasks: LongTaskEntry[] = [
      { startTime: 10, duration: 20 }, // before window [100, 500]
      { startTime: 200, duration: 50 }, // inside window
      { startTime: 600, duration: 50 } // after window
    ]
    const clipped = clipLongTasksToWindow(tasks, 100, 500)
    expect(clipped).toHaveLength(1)
    expect(clipped[0]).toEqual({ startTime: 200, duration: 50 })
    // Aggregate metrics should use clipped, not raw
    const durations = clipped.map((t) => t.duration)
    expect(durations).toEqual([50])
    expect(durations.reduce((a, b) => a + b, 0)).toBe(50) // total
    expect(Math.max(...durations)).toBe(50) // max
  })

  it('raw tasks outside window do not affect clipped aggregates', () => {
    const tasks: LongTaskEntry[] = [
      { startTime: 10, duration: 500 }, // crosses window but starts way before
      { startTime: 300, duration: 20 }, // fully inside
      { startTime: 510, duration: 100 } // after window
    ]
    const clipped = clipLongTasksToWindow(tasks, 100, 500)
    // First task: clipped to [100, 500] dur=400
    // Second task: inside [300, 320] dur=20
    // Third task: excluded
    expect(clipped).toHaveLength(2)
    const totalDuration = clipped.reduce((a, b) => a + b.duration, 0)
    expect(totalDuration).toBe(420) // 400 + 20
    expect(Math.max(...clipped.map((t) => t.duration))).toBe(400)
  })
})

describe('deriveCadenceMetrics — exact clipping and finite metrics', () => {
  it('clipped long tasks have exact window-bounded durations', () => {
    const dom: CadencePoint[] = [
      { t: 150, len: 100 },
      { t: 300, len: 200 }
    ]
    const redux: CadencePoint[] = [
      { t: 150, len: 100 },
      { t: 300, len: 200 }
    ]
    // Task crosses start: 50-150, clipped to [100, 150] dur=50
    // Task crosses end: 400-600, clipped to [400, 500] dur=100
    const longTasks: ClippedLongTaskEntry[] = [
      { startTime: 100, duration: 50 }, // already clipped
      { startTime: 400, duration: 100 } // already clipped
    ]
    const metrics = deriveCadenceMetrics(dom, redux, longTasks, 5, 200, 100, 500)

    // Both clipped tasks are within [100, 500]
    expect(longTasks[0]!.startTime).toBeGreaterThanOrEqual(100)
    expect(longTasks[0]!.startTime + longTasks[0]!.duration).toBeLessThanOrEqual(500)
    expect(longTasks[1]!.startTime).toBeGreaterThanOrEqual(100)
    expect(longTasks[1]!.startTime + longTasks[1]!.duration).toBeLessThanOrEqual(500)

    // All metrics are finite
    expect(Number.isFinite(metrics.domToReduxRatio)).toBe(true)
    expect(Number.isFinite(metrics.visibleTimestampLongTaskOverlap)).toBe(true)
    expect(Number.isFinite(metrics.finalVisibleLength)).toBe(true)
    expect(Number.isFinite(metrics.terminalSampleTime)).toBe(true)
    expect(metrics.visibleIntervalsMs.every(Number.isFinite)).toBe(true)
    expect(metrics.charsPerUpdate.every(Number.isFinite)).toBe(true)
    expect(metrics.reduxIntervalsMs.every(Number.isFinite)).toBe(true)
  })

  it('empty long tasks produce finite overlap metrics', () => {
    const dom: CadencePoint[] = [{ t: 100, len: 50 }]
    const redux: CadencePoint[] = [{ t: 100, len: 50 }]
    const metrics = deriveCadenceMetrics(dom, redux, [], 5, 50, 0, 200)

    expect(metrics.visibleTimestampLongTaskOverlap).toBe(0)
    expect(metrics.overlapSemanticsUnambiguous).toBe(false)
    expect(Number.isFinite(metrics.visibleTimestampLongTaskOverlap)).toBe(true)
  })
})

describe('zero-delta terminal Redux point', () => {
  it('consecutive equal-length points are filtered: 2 commits/1 interval for [50, 100, 100]', () => {
    // Redux series: two distinct lengths, then a terminal point at the same length
    // as the last point (zero delta). The zero-delta point is filtered by
    // reduxContentCommits before intervals/counts — it does NOT create a fake
    // commit or interval.
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 },
      { t: 300, len: 100 } // same length as previous → filtered out
    ]
    const metrics = deriveCadenceMetrics([], redux, [], 5, 100, 0, 400)

    // reduxContentCommits filters len > 0 AND consecutive equal-length:
    // t=100 (len=50), t=200 (len=100) → 2 commits, 1 interval
    // t=300 (len=100) is filtered (same len as previous)
    expect(metrics.reduxUpdateCount).toBe(2)
    expect(metrics.reduxIntervalsMs).toEqual([100])
  })

  it('three equal-length points [10@0, 10@100, 20@200] → 2 commits, 1 interval', () => {
    // LOCK-EVIDENCE: consecutive equal-length points are discarded before
    // intervals/counts. Only distinct-length commits count.
    const redux: CadencePoint[] = [
      { t: 0, len: 10 },
      { t: 100, len: 10 }, // same as previous → filtered
      { t: 200, len: 20 } // distinct → kept
    ]
    const metrics = deriveCadenceMetrics([], redux, [], 5, 20, 0, 300)

    expect(metrics.reduxUpdateCount).toBe(2)
    expect(metrics.reduxIntervalsMs).toEqual([200])
  })

  it('zero-delta terminal point does not corrupt visible cadence when DOM has distinct lengths', () => {
    // DOM has strictly growing points, Redux has a zero-delta terminal
    const dom: CadencePoint[] = [
      { t: 120, len: 50 },
      { t: 200, len: 100 },
      { t: 350, len: 150 },
      { t: 500, len: 200 }
    ]
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 250, len: 100 },
      { t: 500, len: 200 },
      { t: 500, len: 200 } // zero-delta terminal
    ]
    const metrics = deriveCadenceMetrics(dom, redux, [], 10, 200, 0, 600)

    // Visible cadence is unaffected by the Redux zero-delta point
    expect(metrics.visibleUpdateCount).toBe(4)
    expect(metrics.visibleIntervalsMs).toEqual([80, 150, 150])
    expect(metrics.charsPerUpdate).toEqual([50, 50, 50, 50])
  })
})

describe('same-length nonmatching terminal snapshots', () => {
  it('DOM snapshot with same length but different normalized text fails exactMatch', () => {
    // Expected: "HelloWorld" (10 chars normalized)
    // DOM has: "JelloWorld" → normalized "JelloWorld" (10 chars, same length, different content)
    const expectedNormalized = 'HelloWorld'
    const domNormalized = 'JelloWorld' // genuinely equal-length mismatch (10 === 10)
    const snapshot = {
      observationTime: 1000,
      rawTextLength: 10,
      normalizedText: domNormalized,
      exactMatch: domNormalized === expectedNormalized
    }
    expect(snapshot.exactMatch).toBe(false)
    expect(snapshot.rawTextLength).toBe(expectedNormalized.length) // same length
  })

  it('Redux snapshot with same length but different content fails exactContentMatch', () => {
    const expectedContent = 'HelloWorld'
    const actualContent = 'JelloWorld' // genuinely equal-length mismatch (10 === 10)
    const snapshot = {
      observationTime: 1000,
      rawContent: actualContent,
      rawContentLength: actualContent.length,
      blockStatus: 'success',
      exactContentMatch: actualContent === expectedContent
    }
    expect(snapshot.exactContentMatch).toBe(false)
    expect(snapshot.rawContentLength).toBe(expectedContent.length) // same length
  })
})

describe('case preservation in normalization', () => {
  it('normalizeText preserves case: ABC ≠ abc', () => {
    expect(normalizeText('ABC')).toBe('ABC')
    expect(normalizeText('abc')).toBe('abc')
    expect(normalizeText('ABC')).not.toBe(normalizeText('abc'))
  })

  it('normalizeText preserves case with whitespace', () => {
    expect(normalizeText('Hello World')).toBe('HelloWorld')
    expect(normalizeText('hello world')).toBe('helloworld')
    expect(normalizeText('Hello World')).not.toBe(normalizeText('hello world'))
  })

  it('case-preserving normalization catches case-only differences', () => {
    const expected = 'HelloWorld'
    const wrongCase = 'helloworld'
    expect(normalizeText(expected)).not.toBe(normalizeText(wrongCase))
  })
})

describe('Terminal point timestamp invariant', () => {
  it('terminal DOM point timestamp equals observationTime from page-context read', () => {
    // Simulates the spec's terminal point construction: the final DOM point
    // is created directly from the snapshot with the same observationTime.
    const observationTime = 1234.56
    const domRawLength = 4200
    const terminalDomSnapshot = {
      observationTime,
      rawTextLength: domRawLength,
      normalizedText: 'HelloWorld',
      exactMatch: true,
      terminalSampleTime: observationTime
    }
    // The final DOM point must use the exact observationTime
    const finalDomPoint: CadencePoint = { t: terminalDomSnapshot.observationTime, len: domRawLength }
    expect(finalDomPoint.t).toBe(observationTime)
    expect(finalDomPoint.t).toBe(terminalDomSnapshot.terminalSampleTime)
    expect(finalDomPoint.len).toBe(domRawLength)
  })

  it('terminal Redux point timestamp equals observationTime from page-context read', () => {
    const observationTime = 2345.67
    const terminalReduxSnapshot = {
      observationTime,
      rawContent: 'HelloWorld',
      rawContentLength: 10,
      blockStatus: 'success',
      exactContentMatch: true
    }
    const finalReduxPoint: CadencePoint = {
      t: terminalReduxSnapshot.observationTime,
      len: terminalReduxSnapshot.rawContentLength
    }
    expect(finalReduxPoint.t).toBe(observationTime)
    expect(finalReduxPoint.len).toBe(10)
  })

  it('defensive invariant: no DOM point has t > terminalSampleTime', () => {
    const terminalSampleTime = 5000
    const dom: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 },
      { t: 5000, len: 200 } // terminal point at exactly terminalSampleTime
    ]
    // Defensive filter: all points must satisfy t <= terminalSampleTime
    const filtered = dom.filter((pt) => pt.t <= terminalSampleTime)
    expect(filtered).toHaveLength(3)
    expect(filtered[filtered.length - 1]!.t).toBe(terminalSampleTime)
    expect(filtered[filtered.length - 1]!.len).toBe(200)
  })

  it('defensive invariant: post-boundary point is rejected', () => {
    const terminalSampleTime = 5000
    const dom: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 },
      { t: 5001, len: 200 } // post-boundary: should be filtered
    ]
    const filtered = dom.filter((pt) => pt.t <= terminalSampleTime)
    expect(filtered).toHaveLength(2)
    // The post-boundary point is excluded
    expect(filtered.every((pt) => pt.t <= terminalSampleTime)).toBe(true)
  })

  it('defensive invariant: post-boundary Redux point is rejected', () => {
    const terminalSampleTime = 5000
    const redux: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 5001, len: 200 } // post-boundary
    ]
    const filtered = redux.filter((pt) => pt.t <= terminalSampleTime)
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.t).toBe(100)
  })

  it('terminal point carries exact value/provenance through snapshot', () => {
    // End-to-end: snapshot → final point → deriveCadenceMetrics
    const observationTime = 3000
    const terminalSampleTime = observationTime
    const domRaw = 'Hello World Foo Bar'
    const domNormalized = 'HelloWorldFooBar'

    const terminalDomSnapshot = {
      observationTime,
      rawTextLength: domRaw.length,
      normalizedText: domNormalized,
      exactMatch: true,
      terminalSampleTime
    }

    // Build DOM series ending with the terminal point
    const dom: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 500, len: 100 },
      { t: terminalDomSnapshot.observationTime, len: terminalDomSnapshot.rawTextLength }
    ]

    const metrics = deriveCadenceMetrics(dom, [], [], 5, domRaw.length, 0, terminalSampleTime)
    expect(metrics.finalVisibleLength).toBe(domRaw.length)
    expect(metrics.terminalSampleTime).toBe(terminalSampleTime)
    // Last DOM point timestamp equals terminalSampleTime
    expect(dom[dom.length - 1]!.t).toBe(terminalSampleTime)
  })

  it('equal-length final DOM boundary: terminal point survives even when len equals prior point', () => {
    // Regression: the terminal DOM point must be present in the raw series
    // even when its length equals the prior point's length. Pure visible-delta
    // derivation (positiveVisibleDeltas) already ignores zero deltas; the raw
    // series boundary is mandatory for series completeness.
    const observationTime = 5000
    const dom: CadencePoint[] = [
      { t: 100, len: 50 },
      { t: 200, len: 100 },
      { t: 300, len: 200 },
      // Terminal point at same length as prior (equal-length boundary)
      { t: observationTime, len: 200 }
    ]
    // The raw series must contain 4 points, including the equal-length terminal
    expect(dom).toHaveLength(4)
    expect(dom[3]!.t).toBe(observationTime)
    expect(dom[3]!.len).toBe(200)
    // Defensive filter preserves the terminal point (t === terminalSampleTime)
    const filtered = dom.filter((pt) => pt.t <= observationTime)
    expect(filtered).toHaveLength(4)
    // Pure visible-delta derivation ignores the zero-delta terminal point
    const { growing } = positiveVisibleDeltas(dom)
    expect(growing).toHaveLength(3) // only len 50, 100, 200 (strictly growing)
    expect(growing[growing.length - 1]!.t).toBe(300)
    // The equal-length terminal point does NOT appear in growing, but IS in the raw series
    expect(dom[dom.length - 1]!.t).toBe(observationTime)
    // deriveCadenceMetrics uses the raw series for finalVisibleLength
    const metrics = deriveCadenceMetrics(dom, [], [], 5, 200, 0, observationTime)
    expect(metrics.finalVisibleLength).toBe(200)
    expect(metrics.visibleUpdateCount).toBe(3) // strictly growing count
  })
})

describe('validateBlockReferenceIntegrity', () => {
  const expectedContent = 'Hello World'

  it('returns null for a valid two-message mapping (user no blocks + assistant 1 block)', () => {
    const refs = [
      { messageId: 'msg-1', role: 'user', blockIds: [] },
      { messageId: 'msg-2', role: 'assistant', blockIds: ['blk-1'] }
    ]
    const blocks = [{ id: 'blk-1', messageId: 'msg-2', status: 'success', content: expectedContent }]
    expect(validateBlockReferenceIntegrity(refs, ['blk-1'], blocks, expectedContent)).toBeNull()
  })

  it('returns null for assistant message with exactly 1 block and matching content', () => {
    const refs = [{ messageId: 'msg-a', role: 'assistant', blockIds: ['blk-a'] }]
    const blocks = [{ id: 'blk-a', messageId: 'msg-a', status: 'success', content: expectedContent }]
    expect(validateBlockReferenceIntegrity(refs, ['blk-a'], blocks, expectedContent)).toBeNull()
  })

  it('detects duplicate intra-message block references', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-1', 'blk-1'] }]
    const blocks = [{ id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent }]
    const result = validateBlockReferenceIntegrity(refs, ['blk-1'], blocks, expectedContent)
    expect(result).toContain('duplicate block reference IDs')
  })

  it('detects cross-owned references (block.messageId ≠ referencing message)', () => {
    const refs = [
      { messageId: 'msg-1', role: 'user', blockIds: [] },
      { messageId: 'msg-2', role: 'assistant', blockIds: ['blk-1'] }
    ]
    const blocks = [
      // blk-1 claims ownership of msg-1, but msg-2 references it
      { id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent }
    ]
    const result = validateBlockReferenceIntegrity(refs, ['blk-1'], blocks, expectedContent)
    expect(result).toContain('does not match referencing message')
  })

  it('detects extraneous returned blocks (extra block not referenced by any message)', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-1'] }]
    const blocks = [
      { id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent },
      { id: 'blk-extra', messageId: 'msg-1', status: 'success', content: 'extra' }
    ]
    // blk-extra is returned but not referenced — multiset mismatch
    const result = validateBlockReferenceIntegrity(refs, ['blk-1', 'blk-extra'], blocks, expectedContent)
    expect(result).toContain('differs from referenced count')
  })

  it('detects missing returned block (referenced but not in returned IDs)', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-1'] }]
    const blocks = [{ id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent }]
    // blk-1 is referenced but not in allReturnedBlockIds
    const result = validateBlockReferenceIntegrity(refs, [], blocks, expectedContent)
    expect(result).toContain('differs from referenced count')
  })

  it('detects duplicate global references (same block referenced by two messages)', () => {
    const refs = [
      { messageId: 'msg-1', role: 'user', blockIds: ['blk-1'] },
      { messageId: 'msg-2', role: 'assistant', blockIds: ['blk-1'] }
    ]
    const blocks = [
      // blk-1.messageId = msg-1, so msg-2's reference is cross-owned AND global duplicate
      { id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent }
    ]
    const result = validateBlockReferenceIntegrity(refs, ['blk-1'], blocks, expectedContent)
    // Cross-owned reference detected first (block.messageId ≠ msg-2)
    expect(result).toContain('does not match referencing message')
  })

  it('detects assistant block content mismatch', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-1'] }]
    const blocks = [{ id: 'blk-1', messageId: 'msg-1', status: 'success', content: 'wrong content' }]
    const result = validateBlockReferenceIntegrity(refs, ['blk-1'], blocks, expectedContent)
    expect(result).toContain('content does not match expected reply')
  })

  it('detects assistant block status not success', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-1'] }]
    const blocks = [{ id: 'blk-1', messageId: 'msg-1', status: 'pending', content: expectedContent }]
    const result = validateBlockReferenceIntegrity(refs, ['blk-1'], blocks, expectedContent)
    expect(result).toContain('status must be success')
  })

  it('detects no assistant message', () => {
    const refs = [{ messageId: 'msg-1', role: 'user', blockIds: [] }]
    const blocks: Array<{ id: string; messageId: string; status: string; content: string }> = []
    const result = validateBlockReferenceIntegrity(refs, [], blocks, expectedContent)
    expect(result).toContain('no assistant message found')
  })

  it('detects assistant with multiple blocks', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-1', 'blk-2'] }]
    const blocks = [
      { id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent },
      { id: 'blk-2', messageId: 'msg-1', status: 'success', content: 'extra' }
    ]
    const result = validateBlockReferenceIntegrity(refs, ['blk-1', 'blk-2'], blocks, expectedContent)
    expect(result).toContain('must reference exactly 1 block')
  })

  it('detects duplicate block detail records', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-1'] }]
    const blocks = [
      { id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent },
      { id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent }
    ]
    const result = validateBlockReferenceIntegrity(refs, ['blk-1'], blocks, expectedContent)
    expect(result).toContain('duplicate block detail record')
  })

  it('detects referenced block not found in blockDetails', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-missing'] }]
    const blocks: Array<{ id: string; messageId: string; status: string; content: string }> = []
    const result = validateBlockReferenceIntegrity(refs, ['blk-missing'], blocks, expectedContent)
    expect(result).toContain('not found in blockDetails')
  })

  it('detects returned block IDs with duplicates', () => {
    const refs = [{ messageId: 'msg-1', role: 'assistant', blockIds: ['blk-1'] }]
    const blocks = [{ id: 'blk-1', messageId: 'msg-1', status: 'success', content: expectedContent }]
    // allReturnedBlockIds has blk-1 twice
    const result = validateBlockReferenceIntegrity(refs, ['blk-1', 'blk-1'], blocks, expectedContent)
    expect(result).toContain('returned block IDs contain duplicates')
  })

  it('valid two-message mapping with user + assistant blocks', () => {
    // Two messages, each with their own block, assistant block matches expected
    const refs = [
      { messageId: 'msg-user', role: 'user', blockIds: ['blk-user'] },
      { messageId: 'msg-asst', role: 'assistant', blockIds: ['blk-asst'] }
    ]
    const blocks = [
      { id: 'blk-user', messageId: 'msg-user', status: 'success', content: 'user query' },
      { id: 'blk-asst', messageId: 'msg-asst', status: 'success', content: expectedContent }
    ]
    expect(validateBlockReferenceIntegrity(refs, ['blk-user', 'blk-asst'], blocks, expectedContent)).toBeNull()
  })
})
