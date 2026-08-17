/**
 * PERF-STREAM-CADENCE-001 cadence derivation helpers (pure, E2E-only).
 *
 * Measurement-only helper module for the production-build E2E slice
 * `perf-stream-cadence.spec.ts`. It holds ONLY the pure derivation logic
 * that the slice's per-assistant cadence metrics and correctness gates
 * rely on — inter-visible-update intervals, positive chars-per-update,
 * Redux update count/ratio, timestamp-in-long-task-interval correlation,
 * phase-separation (steady-state primary cadence), and aggregate statistic
 * summaries. Everything here is free of Playwright/Electron/IO dependencies
 * so it can be unit-tested in the Node `e2e-utils` vitest lane and imported
 * from the Electron-lane Playwright spec.
 *
 * Scope boundary (LOCK-MEASUREMENT): this slice measures single-stream (N=1)
 * visible Markdown DOM update cadence and batch size only. It does NOT modify
 * production behavior, add React Profiler instrumentation, or introduce
 * concurrency (N=2/3).
 *
 * Semantic claims:
 * - DOM points are parsed Markdown visible commits at frame granularity,
 *   NOT React commit counts.
 * - Long-task relation is TIMESTAMP INTERVAL CORRELATION, NOT frame overlap
 *   or causation.
 * - We do NOT claim observation of component-local displayedContent.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parser-independent normalization: remove ALL whitespace characters,
 * preserving case and exact non-whitespace character order/content.
 * This is the canonical contract for comparing expected source text against
 * visible DOM textContent regardless of Markdown rendering whitespace
 * differences.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, '')
}

/** One observable timestamped point (shared by DOM and Redux series). */
export interface CadencePoint {
  /** Page-clock timestamp (performance.now()). */
  t: number
  /** Accumulated text length at this point. */
  len: number
}

/** One long-task entry from PerformanceObserver. */
export interface LongTaskEntry {
  startTime: number
  duration: number
}

/** Long task with clipped start/duration to a measurement window. */
export interface ClippedLongTaskEntry {
  /** Clamped startTime: max(original startTime, window start). */
  startTime: number
  /** Clamped duration: min(end, window end) - clamped start; >= 0. */
  duration: number
}

/** One frame-delta entry (consecutive rAF frame durations). */
export interface FrameDelta {
  /** Timestamp of the frame start (page clock). */
  t: number
  /** Duration of this frame (ms). */
  delta: number
}

/**
 * Derived cadence metrics for one sample.
 *
 * Unit convention: intervals are `ms`, chars-per-update are `chars`,
 * counts are `count` (dimensionless), ratios are dimensionless (no unit).
 */
export interface CadenceMetrics {
  // --- Visible DOM cadence (whole window) ---
  /** Intervals (ms) between consecutive positive visible DOM length deltas. */
  visibleIntervalsMs: number[]
  /** Positive chars gained per visible DOM update (positive deltas only, unit: chars). */
  charsPerUpdate: number[]
  /** Total number of visible DOM updates (points with len > 0 and strictly increasing). */
  visibleUpdateCount: number
  /** Final visible DOM textContent length from the terminal sampled DOM point. */
  finalVisibleLength: number

  // --- Visible DOM cadence (steady state only) ---
  /** Steady-state visible intervals (ms): from first content to first commit reaching final length. */
  steadyVisibleIntervalsMs: number[]
  /** Steady-state chars gained per visible DOM update (unit: chars). */
  steadyCharsPerUpdate: number[]
  /** Steady-state visible DOM update count. */
  steadyVisibleUpdateCount: number

  // --- Redux cadence (whole window) ---
  /** Intervals (ms) between consecutive Redux content commits (len > 0). */
  reduxIntervalsMs: number[]
  /** Total Redux content commit count (len > 0). */
  reduxUpdateCount: number

  // --- Redux cadence (steady state only) ---
  /** Steady-state Redux intervals (ms). */
  steadyReduxIntervalsMs: number[]
  /** Steady-state Redux content commit count. */
  steadyReduxUpdateCount: number

  // --- DOM-to-Redux ratio ---
  /** visibleUpdateCount / reduxUpdateCount (>1 means DOM updates more frequently). Dimensionless. */
  domToReduxRatio: number

  // --- Timestamp-in-long-task-interval correlation ---
  /** Total sampled frame-delta count during the measurement window. */
  frameCount: number
  /**
   * Number of visible DOM updates whose sampled timestamp falls within a
   * long-task interval [startTime, startTime + duration]. This is TIMESTAMP
   * INTERVAL CORRELATION, NOT frame overlap or causation.
   */
  visibleTimestampLongTaskOverlap: number
  /** Whether any overlap was observable (ambiguous when no long tasks exist). */
  overlapSemanticsUnambiguous: boolean

  // --- Phase boundaries (page-clock timestamps, ms) ---
  /** Terminal sample timestamp (last frame-drained DOM scan after completion). */
  terminalSampleTime: number
}

/** Summarized statistics for a numeric metric. */
export interface CadenceSummary {
  p50: number
  p95: number
  mean: number
  min: number
  max: number
  count: number
}

// ---------------------------------------------------------------------------
// Pure derivation functions
// ---------------------------------------------------------------------------

/**
 * Compute inter-point intervals (ms) for a strictly time-sorted point series.
 * Returns an empty array for fewer than 2 points.
 */
export function interPointIntervals(points: CadencePoint[]): number[] {
  const intervals: number[] = []
  for (let i = 1; i < points.length; i++) {
    intervals.push(points[i]!.t - points[i - 1]!.t)
  }
  return intervals
}

/**
 * Filter a DOM series to strictly growing (positive delta) points and compute
 * the positive chars-per-update and inter-update intervals.
 *
 * A "visible update" is a DOM point whose `len` is strictly greater than the
 * previous visible update's `len`. This excludes length-repeating frames (no
 * new visible content) and zero-length points.
 *
 * Returns the growing subset, inter-update intervals, and chars-per-update.
 */
export function positiveVisibleDeltas(dom: CadencePoint[]): {
  growing: CadencePoint[]
  intervalsMs: number[]
  charsPerUpdate: number[]
} {
  const growing: CadencePoint[] = []
  for (const pt of dom) {
    if (pt.len > 0 && (growing.length === 0 || pt.len > growing[growing.length - 1]!.len)) {
      growing.push(pt)
    }
  }
  const intervalsMs = interPointIntervals(growing)
  const charsPerUpdate: number[] = []
  for (let i = 0; i < growing.length; i++) {
    if (i === 0) {
      charsPerUpdate.push(growing[i]!.len)
    } else {
      charsPerUpdate.push(growing[i]!.len - growing[i - 1]!.len)
    }
  }
  return { growing, intervalsMs, charsPerUpdate }
}

/**
 * Filter a Redux series to content commits (len > 0), discard consecutive
 * equal-length points (same-length deduplication), and compute
 * inter-commit intervals and count.
 *
 * LOCK-EVIDENCE: consecutive equal-length points are discarded before
 * intervals and counts are derived. This prevents terminal zero-delta
 * snapshots from creating fake commits or inflating interval counts.
 * The deduplication is by (len) only — timestamps are not compared.
 */
export function reduxContentCommits(redux: CadencePoint[]): {
  commits: CadencePoint[]
  intervalsMs: number[]
} {
  const contentPoints = redux.filter((p) => p.len > 0)
  // Discard consecutive equal-length points before intervals/counts
  const commits: CadencePoint[] = []
  for (const pt of contentPoints) {
    if (commits.length === 0 || pt.len !== commits[commits.length - 1]!.len) {
      commits.push(pt)
    }
  }
  const intervalsMs = interPointIntervals(commits)
  return { commits, intervalsMs }
}

/**
 * Compute the DOM-to-Redux update ratio. Returns 0 when reduxCount is 0
 * (fail-closed: the gate should catch this separately).
 */
export function domToReduxRatio(visibleCount: number, reduxCount: number): number {
  if (reduxCount === 0) return 0
  return visibleCount / reduxCount
}

/**
 * Compute timestamp-in-long-task-interval correlation.
 *
 * A "visible update" (DOM point) is correlated with a long task when its
 * sampled timestamp falls within [longTask.startTime,
 * longTask.startTime + longTask.duration]. This is TIMESTAMP INTERVAL
 * CORRELATION, NOT frame overlap or causation.
 *
 * Long tasks should be pre-clipped to the measurement window
 * [tSend, terminalSampleTime] via clipLongTasksToWindow before calling
 * this function. The clipped entries have start/duration clamped to the
 * window, so their intervals are the exact contribution to the window.
 *
 * The overlap semantics are "unambiguous" only when at least one long task
 * exists AND at least one visible update exists; otherwise the overlap count
 * is 0 but semantics are ambiguous (we cannot distinguish "no overlap" from
 * "nothing to overlap").
 */
export function timestampLongTaskOverlap(
  visibleUpdates: CadencePoint[],
  longTasks: ClippedLongTaskEntry[]
): { overlapCount: number; unambiguous: boolean } {
  const unambiguous = longTasks.length > 0 && visibleUpdates.length > 0
  if (!unambiguous) return { overlapCount: 0, unambiguous }
  let overlapCount = 0
  for (const pt of visibleUpdates) {
    for (const lt of longTasks) {
      if (pt.t >= lt.startTime && pt.t <= lt.startTime + lt.duration) {
        overlapCount++
        break // count each update at most once
      }
    }
  }
  return { overlapCount, unambiguous }
}

/**
 * Compute summary statistics for a finite numeric array.
 * Returns zero-valued summary when the array is empty.
 */
export function summarizeFinite(values: number[]): CadenceSummary {
  const finite = values.filter((v) => Number.isFinite(v))
  const sorted = [...finite].sort((a, b) => a - b)
  const count = sorted.length
  if (count === 0) {
    return { p50: 0, p95: 0, mean: 0, min: 0, max: 0, count: 0 }
  }
  const p50Idx = Math.ceil(0.5 * count) - 1
  const p95Idx = Math.ceil(0.95 * count) - 1
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    p50: sorted[Math.max(0, p50Idx)]!,
    p95: sorted[Math.max(0, p95Idx)]!,
    mean: sum / count,
    min: sorted[0]!,
    max: sorted[count - 1]!,
    count
  }
}

/**
 * Derive complete cadence metrics for one assistant's measured sample.
 * Pure and deterministic; throws nothing — structural violations surface
 * as zero/NaN fields that correctness gates assert against.
 *
 * Phase separation: steady state is defined as [first Redux content commit,
 * first Redux content commit whose length equals `expectedFinalLength`).
 * The completion tail (final flush) is EXCLUDED from steady-state interval
 * metrics. Whole-window metrics include all phases.
 *
 * Long tasks must be pre-clipped to the measurement window
 * [tSend, terminalSampleTime] via clipLongTasksToWindow before calling
 * this function. The clipped entries have exact window contribution.
 *
 * @param dom - Frame-drained DOM series (must include terminal sample after completion)
 * @param redux - Redux block-content series (deduped by len)
 * @param longTasks - Long tasks clipped to the measurement window
 * @param frameCount - Number of sampled frame deltas during the measurement window
 * @param expectedFinalLength - Expected final Redux content length (for phase boundary)
 * @param tSend - Page-clock send timestamp (for phase start)
 * @param terminalSampleTime - Page-clock terminal sample timestamp (for window bounds)
 */
export function deriveCadenceMetrics(
  dom: CadencePoint[],
  redux: CadencePoint[],
  longTasks: ClippedLongTaskEntry[],
  frameCount: number,
  expectedFinalLength: number,
  tSend: number,
  terminalSampleTime: number
): CadenceMetrics {
  // --- Whole-window derivation ---
  const { growing, intervalsMs: visibleIntervalsMs, charsPerUpdate } = positiveVisibleDeltas(dom)
  const { commits: reduxCommits, intervalsMs: reduxIntervalsMs } = reduxContentCommits(redux)
  const ratio = domToReduxRatio(growing.length, reduxCommits.length)
  const { overlapCount, unambiguous } = timestampLongTaskOverlap(growing, longTasks)
  const finalVisibleLength = dom.length > 0 ? dom[dom.length - 1]!.len : 0

  // --- Phase boundary derivation ---
  // Steady state: [first Redux content commit, first commit reaching final length).
  // Startup: [tSend, first Redux content commit).
  // Completion: [first commit reaching final length, terminalSampleTime).
  const firstContentTime = reduxCommits.length > 0 ? reduxCommits[0]!.t : terminalSampleTime
  const steadyEndRedux = reduxCommits.find((c) => c.len >= expectedFinalLength)
  const steadyEndTime = steadyEndRedux ? steadyEndRedux.t : terminalSampleTime

  // Steady-state Redux
  const steadyReduxCommits = reduxCommits.filter((c) => c.t >= firstContentTime && c.t < steadyEndTime)
  const steadyReduxIntervalsMs = interPointIntervals(steadyReduxCommits)

  // Steady-state visible: DOM points in [firstContentTime, steadyEndTime)
  const steadyDomPoints = growing.filter((p) => p.t >= firstContentTime && p.t < steadyEndTime)
  const steadyVisibleIntervalsMs = interPointIntervals(steadyDomPoints)
  const steadyCharsPerUpdate: number[] = []
  for (let i = 0; i < steadyDomPoints.length; i++) {
    if (i === 0) {
      steadyCharsPerUpdate.push(steadyDomPoints[i]!.len)
    } else {
      steadyCharsPerUpdate.push(steadyDomPoints[i]!.len - steadyDomPoints[i - 1]!.len)
    }
  }

  return {
    // Whole-window
    visibleIntervalsMs,
    charsPerUpdate,
    visibleUpdateCount: growing.length,
    finalVisibleLength,
    reduxIntervalsMs,
    reduxUpdateCount: reduxCommits.length,
    domToReduxRatio: ratio,
    frameCount,
    visibleTimestampLongTaskOverlap: overlapCount,
    overlapSemanticsUnambiguous: unambiguous,
    terminalSampleTime,
    // Steady-state
    steadyVisibleIntervalsMs,
    steadyCharsPerUpdate,
    steadyVisibleUpdateCount: steadyDomPoints.length,
    steadyReduxIntervalsMs,
    steadyReduxUpdateCount: steadyReduxCommits.length
  }
}

/**
 * Clip long tasks to the measurement window [tSend, terminalSampleTime].
 * A long task is included if it intersects the window:
 *   startTime + duration >= tSend && startTime <= terminalSampleTime
 * Each included entry has its start clamped to max(startTime, tSend) and
 * its duration clamped to min(end, terminalSampleTime) - clampedStart.
 * The clipped set is used for overlap, total, max, and count.
 */
export function clipLongTasksToWindow(
  longTasks: LongTaskEntry[],
  tSend: number,
  terminalSampleTime: number
): ClippedLongTaskEntry[] {
  const result: ClippedLongTaskEntry[] = []
  for (const lt of longTasks) {
    const end = lt.startTime + lt.duration
    if (end < tSend || lt.startTime > terminalSampleTime) continue
    const clippedStart = Math.max(lt.startTime, tSend)
    const clippedEnd = Math.min(end, terminalSampleTime)
    result.push({ startTime: clippedStart, duration: clippedEnd - clippedStart })
  }
  return result
}

// ---------------------------------------------------------------------------
// Block reference integrity validation (pure, E2E-only)
// ---------------------------------------------------------------------------

/**
 * Block reference data for a single message (used by validateBlockReferenceIntegrity).
 */
export interface MessageBlockRef {
  messageId: string
  role: string
  blockIds: string[]
}

/**
 * Block detail for integrity validation (used by validateBlockReferenceIntegrity).
 */
export interface BlockIntegrityDetail {
  id: string
  messageId: string
  status: string
  content: string
}

/**
 * Validate block reference integrity for a deterministic topic.
 * Returns null if valid, or an error string describing the first violation.
 *
 * Checks (in order):
 * 1. Each message's block reference IDs are unique (no intra-message duplicates)
 * 2. Every block detail ID is unique (no duplicate block records)
 * 3. Every referenced block ID resolves to exactly one block detail
 * 4. Each resolved block's messageId matches the referencing message's ID
 * 5. No duplicate global references across all messages
 * 6. Returned block IDs are unique (no extraneous block records)
 * 7. The multiset of returned block IDs equals the multiset of all referenced IDs
 * 8. Assistant message references exactly 1 block
 * 9. Assistant block status is 'success' and content exactly matches expected reply
 */
export function validateBlockReferenceIntegrity(
  messageBlockRefs: MessageBlockRef[],
  allReturnedBlockIds: string[],
  blockDetails: BlockIntegrityDetail[],
  expectedAssistantBlockContent: string
): string | null {
  // 1. Each message's block IDs are unique (no intra-message duplicates)
  for (const ref of messageBlockRefs) {
    if (new Set(ref.blockIds).size !== ref.blockIds.length) {
      return `message ${ref.messageId}: duplicate block reference IDs`
    }
  }

  // 2. Every block detail ID is unique (no duplicate block records)
  const detailMap = new Map<string, BlockIntegrityDetail>()
  for (const d of blockDetails) {
    if (detailMap.has(d.id)) {
      return `block ${d.id}: duplicate block detail record`
    }
    detailMap.set(d.id, d)
  }

  // 3. Every referenced block ID resolves to exactly one block detail
  // 4. Each resolved block's messageId matches the referencing message's ID
  for (const ref of messageBlockRefs) {
    for (const bid of ref.blockIds) {
      const detail = detailMap.get(bid)
      if (!detail) {
        return `message ${ref.messageId}: referenced block ${bid} not found in blockDetails`
      }
      if (detail.messageId !== ref.messageId) {
        return `block ${bid}: messageId ${detail.messageId} does not match referencing message ${ref.messageId}`
      }
    }
  }

  // 5. No duplicate global references across all messages
  const globalRefCounts = new Map<string, number>()
  for (const ref of messageBlockRefs) {
    for (const bid of ref.blockIds) {
      globalRefCounts.set(bid, (globalRefCounts.get(bid) ?? 0) + 1)
    }
  }
  for (const [bid, count] of globalRefCounts) {
    if (count !== 1) {
      return `block ${bid}: referenced ${count} times globally (expected 1)`
    }
  }

  // 6. Returned block IDs are unique
  if (new Set(allReturnedBlockIds).size !== allReturnedBlockIds.length) {
    return `returned block IDs contain duplicates`
  }

  // 7. Multiset equality: returned IDs multiset == referenced IDs multiset
  const returnedCounts = new Map<string, number>()
  for (const bid of allReturnedBlockIds) {
    returnedCounts.set(bid, (returnedCounts.get(bid) ?? 0) + 1)
  }
  if (returnedCounts.size !== globalRefCounts.size) {
    return `returned block count (${returnedCounts.size}) differs from referenced count (${globalRefCounts.size})`
  }
  for (const [bid, count] of globalRefCounts) {
    if (returnedCounts.get(bid) !== count) {
      return `block ${bid}: referenced ${count} times but returned ${returnedCounts.get(bid) ?? 0} times`
    }
  }

  // 8. Assistant message references exactly 1 block
  const assistantRef = messageBlockRefs.find((r) => r.role === 'assistant')
  if (!assistantRef) {
    return `no assistant message found`
  }
  if (assistantRef.blockIds.length !== 1) {
    return `assistant message must reference exactly 1 block, found ${assistantRef.blockIds.length}`
  }

  // 9. Assistant block status is 'success' and content exactly matches expected reply
  const assistantBlock = detailMap.get(assistantRef.blockIds[0]!)
  if (!assistantBlock) {
    return `assistant referenced block not found in blockDetails`
  }
  if (assistantBlock.status !== 'success') {
    return `assistant block status must be success, got ${assistantBlock.status}`
  }
  if (assistantBlock.content !== expectedAssistantBlockContent) {
    return `assistant block content does not match expected reply`
  }

  return null
}
