/**
 * PERF-STREAM-ATTR-002 renderer-attribution derivation helpers (pure, E2E-only).
 *
 * Measurement-only helper module for the production-build E2E slice
 * `perf-stream-render-attr.spec.ts` (docs/performance-workstreams.md §2.2
 * PERF-STREAMING). It holds ONLY the pure derivation logic that the slice's
 * per-sample correctness gates and metric aggregation rely on — profile
 * resolution, the steady-state cutoff, the next-DOM/monotonic Redux→DOM pairing
 * rule, and per-assistant renderer metric derivation. Everything here is free
 * of Playwright/Electron/IO dependencies so it can be unit-tested in the Node
 * `e2e-utils` lane (vitest.config.ts project `e2e-utils`) and imported from the
 * Electron-lane Playwright spec.
 *
 * Scope boundary (LOCK-STREAM-RENDER-002/006): this slice measures steady
 * renderer AMPLIFICATION only — per-assistant Redux block-content commits, DOM
 * `.markdown` parsed-content commits, the scheduling-inclusive Redux→next-DOM
 * commit interval (labeled an aggregate render/commit interval, NEVER "Markdown
 * parse CPU"), the accumulated content-size axis, long tasks, frame deltas, and
 * input-latency probes. Completion batch-tail attribution and all DB/Main/IPC
 * optimization are explicitly out of scope.
 *
 * The pairing rule (LOCK-STREAM-RENDER-006): because the smooth stream renders
 * continuously and the DOM scan is frame-drained, Redux↔DOM pairing is NOT 1:1.
 * Each steady Redux commit pairs with the EARLIEST DOM `.markdown` commit at-or-
 * after it (a next-DOM, monotonic rule). Multiple Redux commits may pair to the
 * same DOM commit; that is expected, documented, and never asserted away.
 */
export type RenderScaleProfileKind = 'n1' | 'n2' | 'n3'

/** One closed measurement profile — all fields are deterministic. */
export interface RenderScaleProfile {
  kind: RenderScaleProfileKind
  /** Distinct safe schema-v1 benchmark id (artifact file name). */
  benchmarkId: string
  benchmarkName: string
  /** Number of concurrently mentioned (streaming) models N. */
  mentionModelCount: number
  samplesPerProfile: number
  probeCountPerSample: number
  testTimeoutMs: number
}

/** One DOM `.markdown` content-commit point (page clock). */
export interface RenderSeriesPoint {
  t: number
  len: number
}

/** One Redux block-content commit point (page clock) with block status. */
export interface RenderReduxPoint {
  t: number
  len: number
  status: string
}

/** Opt-in env selecting the N=1/2/3 profile; unset = the spec is skipped (default-off). */
export const PERF_STREAM_RENDER_SCALE_ENV = 'PERF_STREAM_RENDER_SCALE'

/** Numeric profile identity recorded in the schema-v1 scale map (scale is numeric-only). */
export const PROFILE_CODE: Record<RenderScaleProfileKind, number> = { n1: 0, n2: 1, n3: 2 }

/** Sample count and probe count are fixed across profiles so the curve compares only N. */
const SAMPLES_PER_PROFILE = 3
const PROBE_COUNT_PER_SAMPLE = 6

/** The n1 profile (N=1 single-stream baseline). */
const N1_PROFILE: RenderScaleProfile = {
  kind: 'n1',
  benchmarkId: 'chatdb-stream-render-e2e-n1',
  benchmarkName:
    'PERF-STREAM-ATTR-002 N=1 steady renderer amplification baseline (production-build E2E, Electron lane)',
  mentionModelCount: 1,
  samplesPerProfile: SAMPLES_PER_PROFILE,
  probeCountPerSample: PROBE_COUNT_PER_SAMPLE,
  testTimeoutMs: 420000
}

/** Build the N=2 profile (two concurrent streams). */
function buildN2Profile(): RenderScaleProfile {
  return {
    kind: 'n2',
    benchmarkId: 'chatdb-stream-render-e2e-n2',
    benchmarkName:
      'PERF-STREAM-ATTR-002 N=2 concurrent stream renderer amplification (production-build E2E, Electron lane)',
    mentionModelCount: 2,
    samplesPerProfile: SAMPLES_PER_PROFILE,
    probeCountPerSample: PROBE_COUNT_PER_SAMPLE,
    testTimeoutMs: 480000
  }
}

/** Build the N=3 profile (three concurrent streams). */
function buildN3Profile(): RenderScaleProfile {
  return {
    kind: 'n3',
    benchmarkId: 'chatdb-stream-render-e2e-n3',
    benchmarkName:
      'PERF-STREAM-ATTR-002 N=3 concurrent stream renderer amplification (production-build E2E, Electron lane)',
    mentionModelCount: 3,
    samplesPerProfile: SAMPLES_PER_PROFILE,
    probeCountPerSample: PROBE_COUNT_PER_SAMPLE,
    testTimeoutMs: 600000
  }
}

/**
 * Resolve the measurement profile from the runner env. Throws on an unsupported
 * non-empty value (fail-loud before any measurement); the empty/unset case is
 * handled by the spec's `test.skip` (default-off), so this throws defensively
 * only if called without an explicit profile.
 */
export function resolveRenderScaleProfile(): RenderScaleProfile {
  const raw = (process.env[PERF_STREAM_RENDER_SCALE_ENV] ?? '').trim().toLowerCase()
  switch (raw) {
    case 'n1':
      return N1_PROFILE
    case 'n2':
      return buildN2Profile()
    case 'n3':
      return buildN3Profile()
    default:
      throw new Error(
        `[PERF-STREAM-ATTR-002] unsupported ${PERF_STREAM_RENDER_SCALE_ENV}="${raw}" — expected "n1", "n2" or "n3" (unset/empty = spec skipped by default)`
      )
  }
}

/**
 * True when the runner explicitly requested a profile (a non-empty, trimmed
 * env value) — the spec's default-off skip decision (env-gate). Unset/empty
 * skips the measurement spec; ANY non-empty value (valid or invalid) returns
 * true so an invalid value is NOT skipped here but reaches
 * `resolveRenderScaleProfile`, which throws fail-loud before any measurement.
 */
export function renderScaleGateEnabled(): boolean {
  const raw = (process.env[PERF_STREAM_RENDER_SCALE_ENV] ?? '').trim()
  return raw.length > 0
}

/**
 * Steady-state cutoff for one assistant's stream (LOCK-STREAM-RENDER-002/006).
 *
 * The steady-state window is [first content commit, first content commit whose
 * length equals the exact final reply length) on the page clock — i.e. the
 * completion-tail boundary is the first commit that carries the COMPLETE reply
 * (the all-success/final flush). Content commits with `t < cutoffT` are
 * steady-state; interval metrics (Redux commit intervals, DOM commit intervals,
 * Redux→next-DOM intervals) are computed from steady commits ONLY so the final
 * completion-tail flush never inflates them. The content-SIZE axis counts every
 * commit (including the tail) because the accumulated-bytes measure is the
 * amplification amplifier regardless of steady/tail classification.
 */
export interface SteadyCutoff {
  /** Page-clock boundary; content commits with t < cutoffT are steady-state. */
  cutoffT: number
  /** Index in the Redux series of the completion-tail boundary commit (first reaching the exact final length). */
  tailIndex: number
}

export function steadyStateCutoff(reduxSeries: RenderReduxPoint[], finalLength: number): SteadyCutoff {
  const contentPoints = reduxSeries.filter((p) => p.len > 0)
  const tailIndexInContent = contentPoints.findIndex((p) => p.len === finalLength)
  if (tailIndexInContent === -1) {
    // Fail-closed: the series never reached the exact final length. Cut nothing
    // out and mark the tail at the end so the sizeReached gate reports it.
    const lastContent = contentPoints[contentPoints.length - 1]
    return { cutoffT: lastContent ? lastContent.t : -1, tailIndex: reduxSeries.length }
  }
  const boundaryPoint = contentPoints[tailIndexInContent]!
  // Map back to the raw series index (the first point with t === boundaryPoint.t).
  const tailIndex = reduxSeries.findIndex((p) => p.t === boundaryPoint.t)
  return { cutoffT: boundaryPoint.t, tailIndex }
}

/** A next-DOM pairing outcome for one assistant's steady Redux commits. */
export interface PairingResult {
  /** Earliest DOM commit index paired to each steady Redux commit (monotonic non-decreasing; -1 when uncovered). */
  domIndex: number[]
  /** Scheduling-inclusive DOM.t − Redux.t per steady Redux commit (>= 0; NaN when uncovered). */
  intervalMs: number[]
  /**
   * True when every steady Redux commit had a next DOM commit at-or-after it.
   *
   * Coverage is TIME-ORDER EXISTENCE of a next DOM commit, NOT content-matched
   * proof that every Redux increment produced a distinct DOM commit: two Redux
   * commits may land before the same next DOM commit and both be "covered".
   */
  covered: boolean
}

/**
 * Next-DOM / monotonic Redux→DOM pairing (LOCK-STREAM-RENDER-006).
 *
 * For each steady Redux content commit `r` (timestamp-ascending), pair the
 * EARLIEST DOM `.markdown` content commit with `t >= r.t`. The scan advances a
 * single DOM cursor monotonically, so the paired DOM indices are guaranteed
 * non-decreasing (the "monotonic next-DOM" property) and the interval is always
 * >= 0 (a DOM commit cannot render content before the store commits it on the
 * same page clock). Multiple steady Redux commits may pair to the SAME DOM
 * commit (smooth-stream, frame-drained scans) — this is the documented non-1:1
 * reality and is intentionally not asserted away. `covered` therefore means
 * "a next DOM commit existed in time order for every steady Redux commit", not
 * that each Redux increment produced its own distinct DOM commit. The interval
 * is an aggregate scheduling-inclusive render/commit interval (Redux dispatch +
 * React scheduling + Markdown parse + DOM commit), never a Markdown-parse-CPU
 * measure.
 */
export function pairNextDomToRedux(
  steadyRedux: Array<{ t: number; len: number }>,
  dom: RenderSeriesPoint[]
): PairingResult {
  const domIndex: number[] = []
  const intervalMs: number[] = []
  let covered = true
  let cursor = 0
  for (const r of steadyRedux) {
    while (cursor < dom.length && dom[cursor]!.t < r.t) cursor++
    if (cursor < dom.length) {
      domIndex.push(cursor)
      intervalMs.push(dom[cursor]!.t - r.t)
    } else {
      domIndex.push(-1)
      intervalMs.push(NaN)
      covered = false
    }
  }
  return { domIndex, intervalMs, covered }
}

/**
 * One assistant's derived renderer metrics for a single measured sample. All
 * first-content values are tSend-relative (send → first content commit). Commit
 * intervals and Redux→DOM intervals are steady-state (completion-tail excluded).
 * The accumulated-bytes axis counts every Redux content commit (tail included).
 */
export interface DerivedAssistant {
  messageId: string
  finalLength: number
  /** Send → Redux first content commit (ms, page clock, tSend-relative). */
  reduxFirstContentMs: number
  /** Send → Redux block status 'success' commit (ms, page clock, tSend-relative). */
  reduxCompletionMs: number
  /** Redux content commit intervals, steady-state (ms). */
  reduxCommitIntervalsMs: number[]
  /** Send → DOM `.markdown` first content commit (ms, page clock, tSend-relative). */
  domFirstContentMs: number
  /** DOM `.markdown` content commit intervals, steady-state (ms). */
  domCommitIntervalsMs: number[]
  /** Scheduling-inclusive Redux → next DOM commit intervals, steady-state (ms). */
  reduxToDomIntervalsMs: number[]
  /** Sum of all Redux content-commit lengths (content-size amplification axis; tail included). */
  accumulatedBytes: number
  /** Sum of steady-state Redux content-commit lengths (content-size axis, tail excluded). */
  steadyAccumulatedBytes: number
  /** True when the paired DOM indices were monotonic non-decreasing. */
  pairingMonotonic: boolean
  /** True when every steady Redux commit had a next DOM commit. */
  pairingCovered: boolean
  /** True when at least one Redux content commit was classified as completion-tail and excluded from steady metrics. */
  steadyTailExcluded: boolean
  /** True when the Redux series reached the exact final reply length (content-size gate). */
  reduxSizeReached: boolean
}

/** Convert a stream to tSend-relative content-commit arrays. */
function contentCommits(points: Array<{ t: number; len: number }>): Array<{ t: number; len: number }> {
  return points.filter((p) => p.len > 0)
}

/** Intervals between consecutive content commits (ms). */
function commitIntervals(points: Array<{ t: number; len: number }>): number[] {
  const intervals: number[] = []
  for (let i = 1; i < points.length; i++) {
    intervals.push(points[i]!.t - points[i - 1]!.t)
  }
  return intervals
}

/**
 * Derive a single assistant's renderer metrics from its recorded Redux + DOM
 * series. Pure and deterministic; used by both the spec's per-sample gate and
 * its metric aggregation. Throws nothing — structural violations surface as
 * `NaN` / empty fields that the correctness gates assert against.
 */
export function deriveAssistantSample(
  messageId: string,
  redux: RenderReduxPoint[],
  dom: RenderSeriesPoint[],
  finalLength: number,
  tSend: number
): DerivedAssistant {
  const reduxContent = contentCommits(redux)
  const domContent = contentCommits(dom)
  const cutoff = steadyStateCutoff(redux, finalLength)
  const steadyRedux = reduxContent.filter((p) => p.t < cutoff.cutoffT)
  const steadyDom = domContent.filter((p) => p.t < cutoff.cutoffT)

  const pairing = pairNextDomToRedux(steadyRedux, domContent)
  const pairingMonotonic = pairing.domIndex.every((idx, i) => idx === -1 || i === 0 || idx >= pairing.domIndex[i - 1]!)

  return {
    messageId,
    finalLength,
    reduxFirstContentMs: reduxContent.length > 0 ? reduxContent[0]!.t - tSend : NaN,
    reduxCompletionMs: (redux.find((p) => p.status === 'success')?.t ?? NaN) - tSend,
    reduxCommitIntervalsMs: commitIntervals(steadyRedux),
    domFirstContentMs: domContent.length > 0 ? domContent[0]!.t - tSend : NaN,
    domCommitIntervalsMs: commitIntervals(steadyDom),
    reduxToDomIntervalsMs: pairing.intervalMs.filter((v) => Number.isFinite(v)),
    accumulatedBytes: reduxContent.reduce((acc, p) => acc + p.len, 0),
    steadyAccumulatedBytes: steadyRedux.reduce((acc, p) => acc + p.len, 0),
    pairingMonotonic,
    pairingCovered: pairing.covered,
    steadyTailExcluded: reduxContent.length > steadyRedux.length,
    reduxSizeReached: reduxContent.some((p) => p.len === finalLength)
  }
}
