/**
 * PERF-C02 renderer heap calibration helper (measurement-only, E2E-only).
 *
 * This is a focused, pure deterministic helper for the bounded C-02 renderer-side
 * heap calibration artifact (tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts).
 *
 * - Sampling is actual renderer-process evidence only (performance.memory / Chromium
 *   memory API) — never a Node main-native heap proxy. If the renderer heap API
 *   is unavailable, the calibration fails closed with an explicit unsupported-environment
 *   result and emits no artifact.
 * - Canonical logical payload bytes reuse the exact phase4-logical-payload-v1 frame
 *   (src/main/services/chatDb/__tests__/logicalPayload.ts) for byte accounting; this
 *   module re-exports minimal wrappers so the spec can compute logical bytes without
 *   touching production runtime.
 * - Heap amplification is computed separately from logical bytes (heap delta / logical,
 *   heap used / logical) and reported as distinct L3 directional metrics.
 * - All synthetic profiles are labeled non-adoption, directional, synthetic.
 *
 * No runtime cache/window/eviction/TTL/LRU/admission/heap-capacity policy is
 * implemented here. No IPC/schema/preload/migration changes. No threshold or
 * policy selection (B-01/B-02/B-05). See LOCK-C01-001..006 and C-02 lock.
 */

import {
  aggregateLogicalPayload,
  canonicalizeLogicalPayload,
  createSyntheticTopic,
  type LogicalPayloadTopicInput
} from '../../../src/main/services/chatDb/__tests__/logicalPayload'

// ---------------------------------------------------------------------------
// Env gate — opt-in, inert to normal app/test behavior
// ---------------------------------------------------------------------------

export const PERF_C02_HEAP_ENV = 'C02_HEAP_CALIBRATION'

export const C02_BENCHMARK_ID = 'chatdb-c02-renderer-heap-e2e'
export const C02_BENCHMARK_NAME =
  'PERF-C02 renderer heap calibration (measurement-only, directional synthetic, Electron E2E)'

/** Numeric method code for schema-v1 scale map (performance.memory = 0). */
export const HEAP_METHOD_CODE: Record<string, number> = {
  'performance.memory': 0,
  unsupported: -1
}

/** One renderer heap sample — Chromium performance.memory shape. */
export interface RendererHeapSample {
  method: string
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

/** Deterministic synthetic profile for heap calibration. */
export interface C02HeapProfile {
  syntheticTopics: number
  syntheticMessagesPerTopic: number
  blockContentBytes: number
  segmentCountPerTopic: number
  applicabilityGeneration: number
}

/** Bounded default profile — small enough for disposable E2E profile, large enough for delta. */
export const DEFAULT_C02_HEAP_PROFILE: C02HeapProfile = {
  syntheticTopics: 2,
  syntheticMessagesPerTopic: 100,
  blockContentBytes: 2048,
  segmentCountPerTopic: 1,
  applicabilityGeneration: 0
}

/**
 * True when runner explicitly requested the calibration (non-empty trimmed env value).
 * Unset/empty = spec skipped (default-off, inert). Any non-empty value returns true
 * so an invalid value reaches the resolver which fails loud.
 */
export function c02HeapGateEnabled(): boolean {
  const raw = (process.env[PERF_C02_HEAP_ENV] ?? '').trim()
  return raw.length > 0
}

/**
 * Resolve the calibration profile from env. Throws on unsupported non-empty value
 * (fail-loud before any measurement). Empty/unset is handled by the spec's skip,
 * so this throws only when called with an explicit value that is not '1'/'true'.
 */
export function resolveC02HeapProfile(): C02HeapProfile {
  const raw = (process.env[PERF_C02_HEAP_ENV] ?? '').trim().toLowerCase()
  if (raw === '1' || raw === 'true') return DEFAULT_C02_HEAP_PROFILE
  throw new Error(
    `[PERF-C02] unsupported ${PERF_C02_HEAP_ENV}="${raw}" — expected "1" or "true" (unset/empty = spec skipped by default)`
  )
}

// ---------------------------------------------------------------------------
// Canonical logical payload accounting — wrappers over phase4-logical-payload-v1
// ---------------------------------------------------------------------------

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/**
 * Build a deterministic synthetic topic set matching the given profile.
 * Uses the canonical `createSyntheticTopic` helper so byte accounting is
 * identical to C-01 logical payload calibration.
 */
export function buildC02SyntheticTopics(profile: C02HeapProfile): LogicalPayloadTopicInput[] {
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < profile.syntheticTopics; t++) {
    topics.push(
      createSyntheticTopic({
        topicId: `c02-heap-topic-${pad(t, 2)}`,
        messageCount: profile.syntheticMessagesPerTopic,
        blockContentSize: profile.blockContentBytes,
        segmentCount: profile.segmentCountPerTopic,
        generation: profile.applicabilityGeneration
      })
    )
  }
  return topics
}

/** Canonical logical bytes for a single topic (phase4-logical-payload-v1). */
export function canonicalBytesForTopic(topic: LogicalPayloadTopicInput): number {
  return canonicalizeLogicalPayload(topic).byteLength
}

/** Aggregate canonical logical bytes for a set of topics. */
export function canonicalBytesForTopics(topics: LogicalPayloadTopicInput[]): number {
  return aggregateLogicalPayload(topics).aggregateBytes
}

/** Aggregate accounting (per-topic bytes + binding) for a set of topics. */
export function aggregateBytesForTopics(topics: LogicalPayloadTopicInput[]) {
  return aggregateLogicalPayload(topics)
}

// ---------------------------------------------------------------------------
// Heap amplification — separate from logical bytes
// ---------------------------------------------------------------------------

/** Heap amplification ratios — computed separately from canonical logical bytes. */
export interface HeapAmplification {
  /** heapDelta / logicalBytes (resident delta per logical byte, 0 when logicalBytes is 0). */
  deltaRatio: number
  /** heapUsedAfter / logicalBytes (absolute resident per logical byte). */
  absoluteRatio: number
  /** heapDelta in bytes (heapAfter - heapBefore, may be 0 or negative under GC). */
  heapDeltaBytes: number
}

/**
 * Compute heap amplification from a logical byte count and two renderer heap samples.
 * Returns finite ratios; logicalBytes must be >0 for meaningful amplification.
 */
export function computeHeapAmplification(
  heapBefore: RendererHeapSample,
  heapAfter: RendererHeapSample,
  logicalBytes: number
): HeapAmplification {
  const heapDeltaBytes = heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize
  if (!Number.isFinite(heapDeltaBytes) || !Number.isFinite(logicalBytes) || logicalBytes <= 0) {
    return { deltaRatio: 0, absoluteRatio: 0, heapDeltaBytes: Number.isFinite(heapDeltaBytes) ? heapDeltaBytes : 0 }
  }
  return {
    heapDeltaBytes,
    deltaRatio: heapDeltaBytes / logicalBytes,
    absoluteRatio: heapAfter.usedJSHeapSize / logicalBytes
  }
}

// ---------------------------------------------------------------------------
// Heap delta informativeness — zero/unavailable precision is inconclusive
// ---------------------------------------------------------------------------

/**
 * New acceptance lock: zero heap delta or unavailable precision is inconclusive
 * and must never be emitted as zero amplification evidence.
 *
 * This classification is evidence-informativeness only — never a global product
 * threshold or policy. `informative === false` means the delta cannot be used
 * to claim amplification 0; it must be reported as inconclusive.
 */
export interface HeapDeltaInformativeness {
  informative: boolean
  reason: string
}

/**
 * Classify whether a heap delta is informative. Zero delta is always
 * inconclusive (bucketed quantization, GC coalescing, or no growth reported).
 * Non-finite or negative deltas are treated as non-informative for the
 * directional amplification claim as well — they indicate GC/noise rather than
 * a stable resident growth signal.
 *
 * Precision is detected out-of-band (argv flag); this pure helper only checks
 * the delta value itself. Callers must combine with precision detection to mark
 * bucketed precision as inconclusive even when delta appears non-zero but
 * quantized. Prefer `classifyEffectiveHeapDeltaInformative` which encodes the
 * single authoritative definition `(precision === 'precise') && finite positive delta`.
 */
export function classifyHeapDeltaInformative(heapDeltaBytes: number): HeapDeltaInformativeness {
  if (!Number.isFinite(heapDeltaBytes)) {
    return { informative: false, reason: 'heapDelta is non-finite — unavailable precision, inconclusive' }
  }
  if (heapDeltaBytes === 0) {
    return {
      informative: false,
      reason:
        'heapDelta is 0 — bucketed quantization, GC/coalescing, or no reported growth; inconclusive, not amplification 0 evidence'
    }
  }
  if (heapDeltaBytes < 0) {
    return {
      informative: false,
      reason: `heapDelta is negative (${heapDeltaBytes}) — GC/reclamation noise; inconclusive for growth amplification`
    }
  }
  return {
    informative: true,
    reason: `heapDelta ${heapDeltaBytes} is finite positive — informative for directional amplification`
  }
}

/**
 * Authoritative effective informativeness for C-02.
 * Single definition: `(precision === 'precise') && finite positive delta`.
 * Use this ONE value for metric, gate, and ratio emission. Bucketed positive
 * deltas remain raw diagnostic `heap.delta` but are inconclusive and must NOT
 * be emitted as valid amplificationEvidence (deltaRatio/absoluteRatio are 0
 * when not effective). Zero, negative, non-finite, or bucketed deltas are
 * inconclusive in all machine-readable fields.
 */
export function classifyEffectiveHeapDeltaInformative(
  heapDeltaBytes: number,
  precision: HeapPrecisionLabel
): HeapDeltaInformativeness {
  const base = classifyHeapDeltaInformative(heapDeltaBytes)
  if (!base.informative) return base
  if (precision !== 'precise') {
    return {
      informative: false,
      reason: `heapDelta ${heapDeltaBytes} is finite positive but precision=${precision} (bucketed/unsupported) — quantized/inconclusive, not valid amplification evidence`
    }
  }
  return {
    informative: true,
    reason: `heapDelta ${heapDeltaBytes} is finite positive with precision=${precision} — effective informative for directional amplification`
  }
}

/**
 * Whether the delta is effectively informative (boolean shorthand).
 */
export function isEffectiveHeapDeltaInformative(heapDeltaBytes: number, precision: HeapPrecisionLabel): boolean {
  return Number.isFinite(heapDeltaBytes) && heapDeltaBytes > 0 && precision === 'precise'
}

/**
 * Precise memory info codes — numeric-only for schema-v1 scale map.
 * `precise` = Chromium --enable-precise-memory-info active (granular, informative).
 * `bucketed` = flag absent, Chromium buckets (quantized, zero delta inconclusive).
 * `unsupported` = performance.memory unavailable in this renderer.
 */
export const HEAP_PRECISION_CODE: Record<string, number> = {
  precise: 0,
  bucketed: 1,
  unsupported: -1
} as const

export type HeapPrecisionLabel = 'precise' | 'bucketed' | 'unsupported'

export function detectHeapPrecisionLabel(argv: string[], method: string): HeapPrecisionLabel {
  if (method === 'unsupported' || method !== RENDERER_HEAP_METHOD) return 'unsupported'
  const hasFlag = argv.some((a) => a.includes('enable-precise-memory-info'))
  return hasFlag ? 'precise' : 'bucketed'
}

// ---------------------------------------------------------------------------
// Validation — pure, deterministic
// ---------------------------------------------------------------------------

/** Validate a renderer heap sample — returns problems (empty = valid). */
export function validateHeapSample(sample: RendererHeapSample | null): string[] {
  const problems: string[] = []
  if (sample === null) {
    problems.push('heap sample is null (renderer heap API unavailable — performance.memory not exposed)')
    return problems
  }
  if (typeof sample.method !== 'string' || sample.method.length === 0) {
    problems.push('heap sample method must be a non-empty string')
  }
  if (!Number.isFinite(sample.usedJSHeapSize) || sample.usedJSHeapSize < 0) {
    problems.push('heap sample usedJSHeapSize must be a finite non-negative number')
  }
  if (!Number.isFinite(sample.totalJSHeapSize) || sample.totalJSHeapSize < 0) {
    problems.push('heap sample totalJSHeapSize must be a finite non-negative number')
  }
  if (!Number.isFinite(sample.jsHeapSizeLimit) || sample.jsHeapSizeLimit < 0) {
    problems.push('heap sample jsHeapSizeLimit must be a finite non-negative number')
  }
  if (
    Number.isFinite(sample.usedJSHeapSize) &&
    Number.isFinite(sample.totalJSHeapSize) &&
    sample.usedJSHeapSize > sample.totalJSHeapSize
  ) {
    problems.push('heap sample usedJSHeapSize must not exceed totalJSHeapSize')
  }
  return problems
}

/** Validate logical byte count. */
export function validateLogicalBytes(logicalBytes: number): string[] {
  const problems: string[] = []
  if (!Number.isFinite(logicalBytes) || logicalBytes <= 0) {
    problems.push('logical bytes must be a finite positive number')
  }
  return problems
}

/** Validate synthetic topics — non-empty, each topic passes canonicalization. */
export function validateSyntheticTopics(topics: LogicalPayloadTopicInput[]): string[] {
  const problems: string[] = []
  if (!Array.isArray(topics) || topics.length === 0) {
    problems.push('synthetic topics must be a non-empty array')
    return problems
  }
  for (let i = 0; i < topics.length; i++) {
    try {
      canonicalizeLogicalPayload(topics[i]!)
    } catch (error) {
      problems.push(`topic[${i}] canonicalization failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Scale map — numeric-only, schema-v1 compliant
// ---------------------------------------------------------------------------

export interface C02ScaleMap {
  syntheticTopics: number
  syntheticMessagesPerTopic: number
  blockContentBytes: number
  segmentCountPerTopic: number
  syntheticMessagesTotal: number
  syntheticBlocksTotal: number
  applicabilityGeneration: number
  heapMethodCode: number
  heapPrecisionCode: number
}

/** Build numeric scale map for the artifact (deterministic, finite). */
export function buildC02ScaleMap(
  profile: C02HeapProfile,
  heapMethod: string,
  heapPrecisionLabel: HeapPrecisionLabel = 'unsupported'
): C02ScaleMap {
  const code = HEAP_METHOD_CODE[heapMethod] ?? HEAP_METHOD_CODE.unsupported!
  const precisionCode = HEAP_PRECISION_CODE[heapPrecisionLabel] ?? HEAP_PRECISION_CODE.unsupported!
  return {
    syntheticTopics: profile.syntheticTopics,
    syntheticMessagesPerTopic: profile.syntheticMessagesPerTopic,
    blockContentBytes: profile.blockContentBytes,
    segmentCountPerTopic: profile.segmentCountPerTopic,
    syntheticMessagesTotal: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
    syntheticBlocksTotal: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
    applicabilityGeneration: profile.applicabilityGeneration,
    heapMethodCode: code,
    heapPrecisionCode: precisionCode
  }
}

// ---------------------------------------------------------------------------
// Renderer-side sampling snippet description (for spec reference)
// ---------------------------------------------------------------------------

/**
 * Description of the renderer-side heap sample method the spec must use.
 * The spec samples via `page.evaluate` inside the renderer process:
 *   - `performance.memory` (Chromium, least invasive) when available
 *   - No Node `process.memoryUsage` proxy — that would be main-process, not renderer
 *   - `window.gc` is best-effort if exposed, never required
 *
 * This constant documents the method; the actual sampling lives in the spec's
 * `page.evaluate` closure so no production preload/IPC is added.
 */
export const RENDERER_HEAP_METHOD = 'performance.memory' as const
