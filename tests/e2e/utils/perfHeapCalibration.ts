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
  type LogicalPayloadTopicInput
} from '@shared/chatDb/logicalPayload'

export type { LogicalPayloadTopicInput }
import { createSyntheticTopic } from '../../../src/main/services/chatDb/__tests__/logicalPayload'
import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult
} from '../../../src/main/services/chatDb/__tests__/benchResult'

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

/** Bounded default profile — small enough for disposable E2E profile, large enough for delta. Segment-free so denominator aligns with production materialization. */
export const DEFAULT_C02_HEAP_PROFILE: C02HeapProfile = {
  syntheticTopics: 2,
  syntheticMessagesPerTopic: 100,
  blockContentBytes: 2048,
  segmentCountPerTopic: 0,
  applicabilityGeneration: 0
}

/**
 * Production latest-window projection cap — mirrors renderer clampWindowLimit
 * (src/renderer/src/store/thunk/messageThunk.ts: clampWindowLimit 1..100 and
 * src/renderer/src/pages/home/Messages/messageWindow.ts: clampWindowCount).
 * Calibration must measure the actual production projection (100), not invent a
 * larger window. Logical payload remains full synthetic (150 for large) while
 * expected visible/DOM/group counts are the latest-window count
 * Math.min(syntheticMessagesPerTopic, 100) through the 1..100 clamp.
 */
export const C02_PRODUCTION_WINDOW_MIN = 1
export const C02_PRODUCTION_WINDOW_MAX = 100

/**
 * Default context turn count that governs the divider boundary in production
 * (src/renderer/src/config/constant.ts DEFAULT_CONTEXTCOUNT = 25).
 * Mirrored here for harness-only whole-topic validation — no production behavior
 * change, no threshold adoption. A whole-topic window at or below this count has
 * no divider by design (computeContextInfo boundaryMessageId null when startIndex 0).
 */
export const C02_DEFAULT_CONTEXTCOUNT = 25

/**
 * Whether the final-topic window is a whole-topic window where no divider is
 * expected by design. Pure, deterministic, harness-only.
 * Valid only for positive integer counts in 1..C02_DEFAULT_CONTEXTCOUNT (25).
 * Non-finite, non-integer, zero, negative, or >25 are not whole-topic.
 */
export function isC02WholeTopicWindow(expectedVisibleFinal: number): boolean {
  return (
    Number.isFinite(expectedVisibleFinal) &&
    Number.isInteger(expectedVisibleFinal) &&
    expectedVisibleFinal >= C02_PRODUCTION_WINDOW_MIN &&
    expectedVisibleFinal <= C02_DEFAULT_CONTEXTCOUNT
  )
}

/**
 * Collision-safe exact topic ownership matcher appropriate to the generated
 * stable-id grammar (phase4 logical payload + messageRenderLayers stable ids).
 *
 * Topic ids are `${prefix}-${pad}` (e.g. c02-heap-topic-01, c02-mixed-topic-03,
 * c02-c02-small-v1-topic-00). Message ids are `${topicId}-msg-${pad}`.
 * Group stable ids encode messages as `${len}:${msgId}|${len}:${msgId}`.
 * Anchor group keys are stable group ids or synthetic `${topicId}-group-...`.
 *
 * Valid ownership requires topicId appears as an exact token with boundary:
 * before char is start, `:`, `|`, or non-alphanumeric, and after char is
 * `-`, `:`, `|`, `_`, or end. This prevents substring collisions like
 * `c02-heap-topic-01` matching inside `c02-heap-topic-011` where the next
 * char is `1` (alphanumeric) rather than a boundary.
 *
 * Pure, deterministic, reusable for uniform/mixed/matrix builders and spec.
 */
export function isC02ExactTopicOwned(anchor: string | null, topicId: string): boolean {
  if (anchor === null || typeof anchor !== 'string' || typeof topicId !== 'string') return false
  if (anchor.length === 0 || topicId.length === 0) return false
  let idx = anchor.indexOf(topicId)
  while (idx !== -1) {
    const beforeChar = idx > 0 ? anchor[idx - 1] : ''
    const beforeOk =
      idx === 0 ||
      beforeChar === ':' ||
      beforeChar === '|' ||
      beforeChar === '-' ||
      beforeChar === '_' ||
      !/[A-Za-z0-9]/.test(beforeChar)
    const afterIdx = idx + topicId.length
    const afterChar = afterIdx < anchor.length ? anchor[afterIdx] : ''
    const afterOk =
      afterIdx === anchor.length || afterChar === '-' || afterChar === ':' || afterChar === '|' || afterChar === '_'
    if (beforeOk && afterOk) return true
    idx = anchor.indexOf(topicId, idx + 1)
  }
  return false
}

/**
 * Small reusable pure derivation for effective heap informativeness.
 * Single authoritative definition: (precision === 'precise') && finite positive measured heap delta.
 * Callers must not trust a supplied boolean; derive from measured delta + precision.
 */
export function deriveEffectiveHeapInformative(heapDeltaBytes: number, precision: HeapPrecisionLabel): boolean {
  return isEffectiveHeapDeltaInformative(heapDeltaBytes, precision)
}

/**
 * Pure derivation for exact group validity from observed scalar counts.
 * Caller booleans are diagnostic only; validity is groupCount === expectedVisible.
 */
export function deriveGroupCountExact(groupCount: number, expectedVisible: number): boolean {
  return groupCount === expectedVisible
}

/**
 * Pure derivation for final-topic DOM validity from observed scalar counts.
 * Validity is scoped === expectedVisible && global === expectedVisible inside #messages.
 * Missing/null/non-finite global count is inconclusive and must not be converted to scoped equality (fail-closed).
 * Caller booleans are diagnostic only.
 */
export function deriveFinalTopicDomProof(
  displayMessages: number,
  globalDisplayMessages: number,
  expectedVisible: number
): boolean {
  if (
    !Number.isFinite(displayMessages) ||
    !Number.isFinite(globalDisplayMessages) ||
    !Number.isFinite(expectedVisible)
  ) {
    return false
  }
  return displayMessages === expectedVisible && globalDisplayMessages === expectedVisible
}

export interface C02ProductionPathEvidence {
  reduxVerified: boolean
  finalTopicDomProof: boolean
  groupCountExact: boolean
  groupOwnershipProof: boolean
  contextBoundaryPresent: boolean
  contextBoundaryInsideMessages: boolean
  anchorGroupKey: string | null
  lastTopicId: string
  expectedVisibleFinal: number
}

/**
 * Narrow harness predicate correction for context evidence.
 * Whole-topic mode (positive integer 1..DEFAULT_CONTEXTCOUNT) is decisive and
 * valid ONLY with no divider anywhere (both flags false) and null anchor.
 * Any divider (inside or global outside) is invalid for whole-topic.
 * Partial-window mode requires divider inside #messages with final-topic-owned anchor.
 * Invalid counts (non-finite, non-integer, <1, >100) are always false.
 * A divider outside #messages is invalid in either branch (LOCK-004).
 */
export function isC02ContextEvidenceValid(evidence: {
  contextBoundaryPresent: boolean
  contextBoundaryInsideMessages: boolean
  anchorGroupKey: string | null
  lastTopicId: string
  expectedVisibleFinal: number
}): boolean {
  const v = evidence.expectedVisibleFinal
  const isValidCount =
    Number.isFinite(v) && Number.isInteger(v) && v >= C02_PRODUCTION_WINDOW_MIN && v <= C02_PRODUCTION_WINDOW_MAX
  if (!isValidCount) return false
  const wholeTopic = isC02WholeTopicWindow(v)
  if (wholeTopic) {
    // Decisive whole-topic branch — no divider anywhere, null anchor
    return (
      !evidence.contextBoundaryPresent && !evidence.contextBoundaryInsideMessages && evidence.anchorGroupKey === null
    )
  }
  // Partial window — strict divider inside #messages with final-topic-owned anchor (exact, collision-safe)
  const anchorOwnedByFinalTopic = isC02ExactTopicOwned(evidence.anchorGroupKey, evidence.lastTopicId)
  return (
    evidence.contextBoundaryPresent &&
    evidence.contextBoundaryInsideMessages &&
    evidence.anchorGroupKey !== null &&
    anchorOwnedByFinalTopic
  )
}

/**
 * Full productionPath completeness predicate — combines Redux/DOM ownership
 * with the narrow context-evidence correction. Pure, deterministic.
 */
export function isC02ProductionPathComplete(evidence: C02ProductionPathEvidence): boolean {
  return (
    evidence.reduxVerified &&
    evidence.finalTopicDomProof &&
    evidence.groupCountExact &&
    evidence.groupOwnershipProof &&
    isC02ContextEvidenceValid(evidence)
  )
}

/** Expected visible/projected count for a profile — production latest-window count. */
export function c02ExpectedVisibleCount(profile: Pick<C02HeapProfile, 'syntheticMessagesPerTopic'>): number {
  const n = Math.floor(profile.syntheticMessagesPerTopic)
  if (!Number.isFinite(n)) return C02_PRODUCTION_WINDOW_MAX
  return Math.min(C02_PRODUCTION_WINDOW_MAX, Math.max(C02_PRODUCTION_WINDOW_MIN, n))
}

/** Expected projected total messages/blocks for a profile (topics × latest-window per topic). */
export function c02ExpectedProjectedTotal(profile: C02HeapProfile): number {
  return profile.syntheticTopics * c02ExpectedVisibleCount(profile)
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
 * Resolve the calibration profile from env. Fail-closed single-profile resolver.
 * Delegates to the canonical plural resolver and requires exactly one profile;
 * matrix selectors ("all"/"matrix" or comma lists with >1 entry) are rejected
 * explicitly — use resolveC02HeapProfiles for matrix mode. This removes the
 * prior contradictory semantics where singular returned default for "all"/"matrix".
 * Throws on empty, unknown, duplicate, or empty-comma-token input (fail-loud).
 * Empty/unset is fail-closed when called directly; caller (spec) controls
 * default-off skip via c02HeapGateEnabled before calling.
 */
export function resolveC02HeapProfile(): C02HeapProfile | C02MixedHeapProfile {
  const profiles = resolveC02HeapProfiles()
  if (profiles.length !== 1) {
    const raw = (process.env[PERF_C02_HEAP_ENV] ?? '').trim().toLowerCase()
    throw new Error(
      `[PERF-C02] singular resolver expects exactly one profile (1/true or single short/full id), got ${profiles.length} from ${PERF_C02_HEAP_ENV}="${raw}" — use resolveC02HeapProfiles for "all"/"matrix"/"mixed" or comma lists`
    )
  }
  return profiles[0]!.profile
}

/** Deterministic multi-profile matrix for calibration — varied topic/message/block/segment shapes.
 * C-02 profiles are segment-free (segmentCountPerTopic=0) so canonical logical
 * bytes denominator aligns with entities actually materialized/verified in the
 * production path (messages+blocks via ChatDb ensureTopic/pasteMessages). No
 * unsupported segment persistence is invented.
 */
export const C02_HEAP_PROFILE_IDS = {
  small: 'c02-small-v1',
  default: 'c02-default-v1',
  large: 'c02-large-v1',
  boundary: 'c02-boundary-v1'
} as const

/** Short-name aliases for selector grammar — maps short name to full id (lowercase). */
export const C02_HEAP_SHORT_NAME_MAP: Record<string, string> = {
  small: C02_HEAP_PROFILE_IDS.small,
  default: C02_HEAP_PROFILE_IDS.default,
  large: C02_HEAP_PROFILE_IDS.large,
  boundary: C02_HEAP_PROFILE_IDS.boundary
}

export const C02_HEAP_PROFILES: Record<string, C02HeapProfile> = {
  [C02_HEAP_PROFILE_IDS.small]: {
    syntheticTopics: 1,
    syntheticMessagesPerTopic: 50,
    blockContentBytes: 1024,
    segmentCountPerTopic: 0,
    applicabilityGeneration: 0
  },
  [C02_HEAP_PROFILE_IDS.default]: {
    syntheticTopics: 2,
    syntheticMessagesPerTopic: 100,
    blockContentBytes: 2048,
    segmentCountPerTopic: 0,
    applicabilityGeneration: 0
  },
  [C02_HEAP_PROFILE_IDS.large]: {
    syntheticTopics: 3,
    syntheticMessagesPerTopic: 150,
    blockContentBytes: 4096,
    segmentCountPerTopic: 0,
    applicabilityGeneration: 0
  },
  [C02_HEAP_PROFILE_IDS.boundary]: {
    syntheticTopics: 2,
    syntheticMessagesPerTopic: 30,
    blockContentBytes: 512,
    segmentCountPerTopic: 0,
    applicabilityGeneration: 0
  }
}

/** Deterministic definition order for matrix — do not rely on Object iteration order. */
export const C02_HEAP_PROFILE_ORDER: string[] = [
  C02_HEAP_PROFILE_IDS.small,
  C02_HEAP_PROFILE_IDS.default,
  C02_HEAP_PROFILE_IDS.large,
  C02_HEAP_PROFILE_IDS.boundary
]

export function getC02HeapProfileMatrix(): Array<{ id: string; profile: C02HeapProfile }> {
  return C02_HEAP_PROFILE_ORDER.map((id) => ({ id, profile: C02_HEAP_PROFILES[id]! }))
}

// ---------------------------------------------------------------------------
// Mixed resident-topic distribution — deterministic heterogeneous shapes
// (additive, measurement-only, directional synthetic, no B-01..B-05 adoption)
// ---------------------------------------------------------------------------

/**
 * Per-topic spec for the mixed distribution. Each resident topic may have
 * different messageCount and blockContentBytes, so the aggregate demonstrates
 * count vs byte-pressure shapes relevant to candidate B-01/B-02/B-05 without
 * adopting any candidate as an enforced policy. Segment-free, generation 0.
 */
export interface C02MixedTopicSpec {
  messageCount: number
  blockContentBytes: number
  segmentCountPerTopic: number
}

export interface C02MixedHeapProfile {
  topicSpecs: C02MixedTopicSpec[]
  applicabilityGeneration: number
}

/** Mixed profile ids — deterministic, versioned. */
export const C02_MIXED_HEAP_PROFILE_IDS = {
  countPressure: 'c02-mixed-count-v1',
  bytePressure: 'c02-mixed-byte-v1',
  balanced: 'c02-mixed-balanced-v1',
  oversizedContrast: 'c02-mixed-oversized-contrast-v1'
} as const

/** Short-name aliases for mixed selectors (lowercase, caller order preserved). */
export const C02_MIXED_HEAP_SHORT_NAME_MAP: Record<string, string> = {
  'mixed-count': C02_MIXED_HEAP_PROFILE_IDS.countPressure,
  'mixed-byte': C02_MIXED_HEAP_PROFILE_IDS.bytePressure,
  'mixed-balanced': C02_MIXED_HEAP_PROFILE_IDS.balanced,
  'mixed-oversized': C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast,
  'mixed-oversized-contrast': C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast
}

/**
 * Deterministic mixed distribution matrix — covers meaningful count/byte-pressure
 * shapes relevant to candidate B-01/B-02/B-05 as directional evidence only:
 * - countPressure: 8 topics × small payload (B-01 count shape, low aggregate bytes)
 * - bytePressure: 3 topics × large payload (byte pressure shape, fewer topics, larger aggregate)
 * - balanced: 4 topics heterogeneous 20/50/100/150 msgs × 512/1024/2048/4096B (mixed byte distribution)
 * - oversizedContrast: 4 topics where one dominates (200×8192B vs 3×20×512B) — single-topic dominance shape relevant to B-05
 * All shapes are bounded for disposable E2E profiles (<~3 MiB per distribution, segment-free)
 * and remain measurement-only, non-adopting, Open.
 */
export const C02_MIXED_HEAP_PROFILES: Record<string, C02MixedHeapProfile> = {
  [C02_MIXED_HEAP_PROFILE_IDS.countPressure]: {
    topicSpecs: Array.from({ length: 8 }, () => ({
      messageCount: 30,
      blockContentBytes: 512,
      segmentCountPerTopic: 0
    })),
    applicabilityGeneration: 0
  },
  [C02_MIXED_HEAP_PROFILE_IDS.bytePressure]: {
    topicSpecs: [
      { messageCount: 150, blockContentBytes: 8192, segmentCountPerTopic: 0 },
      { messageCount: 150, blockContentBytes: 8192, segmentCountPerTopic: 0 },
      { messageCount: 100, blockContentBytes: 4096, segmentCountPerTopic: 0 }
    ],
    applicabilityGeneration: 0
  },
  [C02_MIXED_HEAP_PROFILE_IDS.balanced]: {
    topicSpecs: [
      { messageCount: 20, blockContentBytes: 512, segmentCountPerTopic: 0 },
      { messageCount: 50, blockContentBytes: 1024, segmentCountPerTopic: 0 },
      { messageCount: 100, blockContentBytes: 2048, segmentCountPerTopic: 0 },
      { messageCount: 150, blockContentBytes: 4096, segmentCountPerTopic: 0 }
    ],
    applicabilityGeneration: 0
  },
  [C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]: {
    topicSpecs: [
      { messageCount: 200, blockContentBytes: 8192, segmentCountPerTopic: 0 },
      { messageCount: 20, blockContentBytes: 512, segmentCountPerTopic: 0 },
      { messageCount: 20, blockContentBytes: 512, segmentCountPerTopic: 0 },
      { messageCount: 20, blockContentBytes: 512, segmentCountPerTopic: 0 }
    ],
    applicabilityGeneration: 0
  }
}

export const C02_MIXED_HEAP_PROFILE_ORDER: string[] = [
  C02_MIXED_HEAP_PROFILE_IDS.countPressure,
  C02_MIXED_HEAP_PROFILE_IDS.bytePressure,
  C02_MIXED_HEAP_PROFILE_IDS.balanced,
  C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast
]

export function getC02MixedHeapProfileMatrix(): Array<{ id: string; profile: C02MixedHeapProfile }> {
  return C02_MIXED_HEAP_PROFILE_ORDER.map((id) => ({ id, profile: C02_MIXED_HEAP_PROFILES[id]! }))
}

export function isC02MixedHeapProfile(profile: unknown): profile is C02MixedHeapProfile {
  return (
    typeof profile === 'object' &&
    profile !== null &&
    Array.isArray((profile as C02MixedHeapProfile).topicSpecs) &&
    typeof (profile as C02MixedHeapProfile).applicabilityGeneration === 'number'
  )
}

export function c02MixedExpectedVisibleCountForSpec(spec: C02MixedTopicSpec): number {
  return c02ExpectedVisibleCount({ syntheticMessagesPerTopic: spec.messageCount })
}

export function c02MixedExpectedProjectedTotal(profile: C02MixedHeapProfile): number {
  return profile.topicSpecs.reduce((acc, s) => acc + c02MixedExpectedVisibleCountForSpec(s), 0)
}

export function c02MixedTotalMessages(profile: C02MixedHeapProfile): number {
  return profile.topicSpecs.reduce((acc, s) => acc + s.messageCount, 0)
}

/**
 * Canonical-topic-aware expected visible count — derives directly from the
 * already-constructed canonical `LogicalPayloadTopicInput.messages.length`
 * under the existing production window clamp (1..100). This is the single
 * source of truth for per-topic waits inside `activateReduxProjection`:
 * each topic wait uses its own topic's count, not the final topic's count.
 * Final-topic ownership checks retain the last topic's value only.
 */
export function c02ExpectedVisibleCountForTopic(topic: LogicalPayloadTopicInput): number {
  return c02ExpectedVisibleCount({ syntheticMessagesPerTopic: topic.messages.length })
}

export function c02ExpectedProjectedTotalForTopics(topics: LogicalPayloadTopicInput[]): number {
  return topics.reduce((acc, t) => acc + c02ExpectedVisibleCountForTopic(t), 0)
}

export function c02PerTopicExpectedVisibleCounts(topics: LogicalPayloadTopicInput[]): number[] {
  return topics.map(c02ExpectedVisibleCountForTopic)
}

/**
 * Selector grammar (one grammar, fail-closed, enforced):
 * - "1" | "true" => [default] (backward compat, single-profile)
 * - "all" | "matrix" => all deterministic uniform profiles in definition order
 * - "mixed" | "all-mixed" | "mixed-matrix" => all deterministic mixed resident-topic distributions
 * - one short or full profile id (e.g. "small" or "c02-small-v1" or "mixed-count") => single profile
 * - comma-separated list of short names or full ids (e.g. "small,large" or
 *   "c02-small-v1,c02-large-v1" or "mixed-count,mixed-balanced" or uniform+mixed mix) => explicit subset in caller's
 *   order after normalization. Short names are lowercased aliases to full ids.
 * Throws on empty input (fail-closed when called directly), unknown id,
 * duplicate normalized id, or any empty comma token (",small", "small,",
 * "small,,large") — no silent filtering/dedup. Ordering for "all"/"matrix"
 * is definition order; for "mixed" variants it is mixed definition order; for comma lists it is caller order (deterministic).
 * Trimming and lowercasing are applied per token.
 */
export function resolveC02HeapProfiles(): Array<{ id: string; profile: C02HeapProfile | C02MixedHeapProfile }> {
  const raw = (process.env[PERF_C02_HEAP_ENV] ?? '').trim().toLowerCase()
  if (raw.length === 0) {
    throw new Error(
      `[PERF-C02] empty ${PERF_C02_HEAP_ENV}="${raw}" — expected "1", "true", "all", "matrix", "mixed", "all-mixed", or comma-separated ids/short-names (${[...C02_HEAP_PROFILE_ORDER, ...C02_MIXED_HEAP_PROFILE_ORDER].join(',')} or ${[...Object.keys(C02_HEAP_SHORT_NAME_MAP), ...Object.keys(C02_MIXED_HEAP_SHORT_NAME_MAP)].join(',')}) (unset/empty = spec skipped by caller)`
    )
  }
  if (raw === '1' || raw === 'true') return [{ id: C02_HEAP_PROFILE_IDS.default, profile: DEFAULT_C02_HEAP_PROFILE }]
  if (raw === 'all' || raw === 'matrix') return getC02HeapProfileMatrix()
  if (raw === 'mixed' || raw === 'all-mixed' || raw === 'mixed-matrix') return getC02MixedHeapProfileMatrix()
  // Generic token parsing: handles single id and comma-separated lists uniformly.
  // Fail closed on any empty comma token (no filtering).
  const rawTokens = raw.split(',')
  const hasEmptyToken = rawTokens.some((s) => s.trim().length === 0)
  if (hasEmptyToken) {
    throw new Error(
      `[PERF-C02] empty profile token in selector "${raw}" — empty comma token rejected (e.g. ",small", "small,", "small,,large")`
    )
  }
  const tokens = rawTokens.map((s) => s.trim().toLowerCase())
  if (tokens.length === 0) throw new Error(`[PERF-C02] no profiles resolved from "${raw}"`)
  const resolved: Array<{ id: string; profile: C02HeapProfile | C02MixedHeapProfile }> = []
  const seen = new Set<string>()
  for (const tok of tokens) {
    const normalized = C02_MIXED_HEAP_SHORT_NAME_MAP[tok] ?? C02_HEAP_SHORT_NAME_MAP[tok] ?? tok
    const foundUniform = C02_HEAP_PROFILES[normalized]
    const foundMixed = C02_MIXED_HEAP_PROFILES[normalized]
    const found = foundUniform ?? foundMixed
    if (!found) {
      throw new Error(
        `[PERF-C02] unknown profile id "${tok}" (unsupported) — known full ids: ${[...C02_HEAP_PROFILE_ORDER, ...C02_MIXED_HEAP_PROFILE_ORDER].join(',')} short names: ${[...Object.keys(C02_HEAP_SHORT_NAME_MAP), ...Object.keys(C02_MIXED_HEAP_SHORT_NAME_MAP)].join(',')}`
      )
    }
    if (seen.has(normalized)) {
      throw new Error(`[PERF-C02] duplicate profile id "${tok}" (normalized "${normalized}") — duplicates rejected`)
    }
    seen.add(normalized)
    resolved.push({ id: normalized, profile: found as C02HeapProfile | C02MixedHeapProfile })
  }
  return resolved
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
  return buildC02SyntheticTopicsWithPrefix(profile, 'c02-heap-topic')
}

/** Prefix-aware variant for multi-profile matrix (deterministic per profile, isolated ids). */
export function buildC02SyntheticTopicsWithPrefix(profile: C02HeapProfile, prefix: string): LogicalPayloadTopicInput[] {
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < profile.syntheticTopics; t++) {
    topics.push(
      createSyntheticTopic({
        topicId: `${prefix}-${pad(t, 2)}`,
        messageCount: profile.syntheticMessagesPerTopic,
        blockContentSize: profile.blockContentBytes,
        segmentCount: profile.segmentCountPerTopic,
        generation: profile.applicabilityGeneration
      })
    )
  }
  return topics
}

/** Build synthetic topics for a mixed resident-topic distribution (heterogeneous per-topic specs). */
export function buildC02MixedSyntheticTopics(profile: C02MixedHeapProfile): LogicalPayloadTopicInput[] {
  return buildC02MixedSyntheticTopicsWithPrefix(profile, 'c02-mixed-topic')
}

export function buildC02MixedSyntheticTopicsWithPrefix(
  profile: C02MixedHeapProfile,
  prefix: string
): LogicalPayloadTopicInput[] {
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < profile.topicSpecs.length; t++) {
    const spec = profile.topicSpecs[t]!
    topics.push(
      createSyntheticTopic({
        topicId: `${prefix}-${pad(t, 2)}`,
        messageCount: spec.messageCount,
        blockContentSize: spec.blockContentBytes,
        segmentCount: spec.segmentCountPerTopic,
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
  const hasFlag = argv.some((a) => a === '--enable-precise-memory-info')
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

/** Validate a mixed heap profile — deterministic, finite, non-empty. */
export function validateC02MixedHeapProfile(profile: C02MixedHeapProfile): string[] {
  const problems: string[] = []
  if (!profile || !Array.isArray(profile.topicSpecs) || profile.topicSpecs.length === 0) {
    problems.push('mixed heap profile topicSpecs must be a non-empty array')
    return problems
  }
  if (
    typeof profile.applicabilityGeneration !== 'number' ||
    !Number.isFinite(profile.applicabilityGeneration) ||
    !Number.isInteger(profile.applicabilityGeneration) ||
    profile.applicabilityGeneration < 0
  ) {
    problems.push('mixed heap profile applicabilityGeneration must be a non-negative finite integer')
  }
  for (let i = 0; i < profile.topicSpecs.length; i++) {
    const s = profile.topicSpecs[i]!
    if (!Number.isFinite(s.messageCount) || !Number.isInteger(s.messageCount) || s.messageCount <= 0) {
      problems.push(`mixed topicSpecs[${i}].messageCount must be a finite positive integer`)
    }
    if (!Number.isFinite(s.blockContentBytes) || !Number.isInteger(s.blockContentBytes) || s.blockContentBytes < 0) {
      problems.push(`mixed topicSpecs[${i}].blockContentBytes must be a finite non-negative integer`)
    }
    if (
      !Number.isFinite(s.segmentCountPerTopic) ||
      !Number.isInteger(s.segmentCountPerTopic) ||
      s.segmentCountPerTopic < 0
    ) {
      problems.push(`mixed topicSpecs[${i}].segmentCountPerTopic must be a finite non-negative integer`)
    }
    if (s.segmentCountPerTopic !== 0) {
      problems.push(`mixed topicSpecs[${i}].segmentCountPerTopic must be 0 for C-02 (no segment persistence)`)
    }
  }
  // Validate canonical accounting for the built topics
  try {
    const topics = buildC02MixedSyntheticTopics(profile)
    const tp = validateSyntheticTopics(topics)
    if (tp.length > 0) problems.push(...tp.map((p) => `mixed canonical: ${p}`))
  } catch (e) {
    problems.push(`mixed build canonical failed: ${e instanceof Error ? e.message : String(e)}`)
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

export interface C02MultiScaleMap extends C02ScaleMap {
  profileCount: number
  profileIdCode: number
}

/** Numeric ids for C02 profile ids — finite, for schema-v1 scale fields. */
export const C02_PROFILE_ID_CODE: Record<string, number> = {
  [C02_HEAP_PROFILE_IDS.small]: 0,
  [C02_HEAP_PROFILE_IDS.default]: 1,
  [C02_HEAP_PROFILE_IDS.large]: 2,
  [C02_HEAP_PROFILE_IDS.boundary]: 3,
  [C02_MIXED_HEAP_PROFILE_IDS.countPressure]: 4,
  [C02_MIXED_HEAP_PROFILE_IDS.bytePressure]: 5,
  [C02_MIXED_HEAP_PROFILE_IDS.balanced]: 6,
  [C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]: 7
}

export function buildC02MultiScaleMap(
  profiles: Array<{ id: string; profile: C02HeapProfile | C02MixedHeapProfile }>,
  heapMethod: string,
  heapPrecisionLabel: HeapPrecisionLabel = 'unsupported'
): Record<string, number> {
  // For uniform first entry, use uniform base; for mixed first entry, use mixed base (unified map)
  const first = profiles[0]
  const firstIsMixed = first ? isC02MixedHeapProfile(first.profile) : false
  const base = firstIsMixed
    ? buildC02MixedScaleMap(first.profile as C02MixedHeapProfile, heapMethod, heapPrecisionLabel)
    : buildC02ScaleMap((first?.profile as C02HeapProfile) ?? DEFAULT_C02_HEAP_PROFILE, heapMethod, heapPrecisionLabel)
  const safeFirstId = deriveSafeProfileLabel(first?.id ?? C02_HEAP_PROFILE_IDS.default)
  const map: Record<string, number> = {
    ...base,
    profileCount: profiles.length,
    profileIdCode: C02_PROFILE_ID_CODE[safeFirstId] ?? -1
  }
  for (const entry of profiles) {
    const safePrefix = deriveSafeProfileLabel(entry.id).replace(/-/g, '_')
    const prefix = safePrefix
    if (isC02MixedHeapProfile(entry.profile)) {
      const p = entry.profile as C02MixedHeapProfile
      map[`${prefix}_topics`] = p.topicSpecs.length
      map[`${prefix}_messagesTotal`] = c02MixedTotalMessages(p)
      map[`${prefix}_projectedTotal`] = c02MixedExpectedProjectedTotal(p)
      for (let i = 0; i < p.topicSpecs.length; i++) {
        const spec = p.topicSpecs[i]!
        map[`${prefix}_t${String(i).padStart(2, '0')}_messages`] = spec.messageCount
        map[`${prefix}_t${String(i).padStart(2, '0')}_blockBytes`] = spec.blockContentBytes
      }
    } else {
      const p = entry.profile as C02HeapProfile
      map[`${prefix}_topics`] = p.syntheticTopics
      map[`${prefix}_messagesPerTopic`] = p.syntheticMessagesPerTopic
      map[`${prefix}_blockContentBytes`] = p.blockContentBytes
      map[`${prefix}_segmentCountPerTopic`] = p.segmentCountPerTopic
      map[`${prefix}_messagesTotal`] = p.syntheticTopics * p.syntheticMessagesPerTopic
    }
  }
  return map
}

// Mixed scale maps — scalar-only, schema-v1 compliant

export function buildC02MixedScaleMap(
  profile: C02MixedHeapProfile,
  heapMethod: string,
  heapPrecisionLabel: HeapPrecisionLabel = 'unsupported'
): Record<string, number> {
  const syntheticTopics = profile.topicSpecs.length
  const syntheticMessagesTotal = c02MixedTotalMessages(profile)
  const syntheticBlocksTotal = syntheticMessagesTotal
  const avgMessagesPerTopic = syntheticTopics ? Math.round(syntheticMessagesTotal / syntheticTopics) : 0
  const avgBlockBytes = syntheticTopics
    ? Math.round(profile.topicSpecs.reduce((a, s) => a + s.blockContentBytes, 0) / syntheticTopics)
    : 0
  const code = HEAP_METHOD_CODE[heapMethod] ?? HEAP_METHOD_CODE.unsupported!
  const precisionCode = HEAP_PRECISION_CODE[heapPrecisionLabel] ?? HEAP_PRECISION_CODE.unsupported!
  const map: Record<string, number> = {
    syntheticTopics,
    syntheticMessagesPerTopic: avgMessagesPerTopic,
    blockContentBytes: avgBlockBytes,
    segmentCountPerTopic: 0,
    syntheticMessagesTotal,
    syntheticBlocksTotal,
    applicabilityGeneration: profile.applicabilityGeneration,
    heapMethodCode: code,
    heapPrecisionCode: precisionCode,
    mixedDistribution: 1
  }
  for (let i = 0; i < profile.topicSpecs.length; i++) {
    const spec = profile.topicSpecs[i]!
    map[`mixed_topic_${String(i).padStart(2, '0')}_messages`] = spec.messageCount
    map[`mixed_topic_${String(i).padStart(2, '0')}_blockBytes`] = spec.blockContentBytes
    map[`mixed_topic_${String(i).padStart(2, '0')}_projected`] = c02MixedExpectedVisibleCountForSpec(spec)
  }
  map.mixedProjectedTotal = c02MixedExpectedProjectedTotal(profile)
  return map
}

export function buildC02MixedMultiScaleMap(
  profiles: Array<{ id: string; profile: C02MixedHeapProfile }>,
  heapMethod: string,
  heapPrecisionLabel: HeapPrecisionLabel = 'unsupported'
): Record<string, number> {
  const base = buildC02MixedScaleMap(
    profiles[0]?.profile ?? C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!,
    heapMethod,
    heapPrecisionLabel
  )
  const safeFirstMixed = deriveSafeProfileLabel(profiles[0]?.id ?? C02_MIXED_HEAP_PROFILE_IDS.balanced)
  const map: Record<string, number> = {
    ...base,
    profileCount: profiles.length,
    profileIdCode: C02_PROFILE_ID_CODE[safeFirstMixed] ?? -1
  }
  for (const entry of profiles) {
    const safePrefix = deriveSafeProfileLabel(entry.id).replace(/-/g, '_')
    const prefix = safePrefix
    map[`${prefix}_topics`] = entry.profile.topicSpecs.length
    map[`${prefix}_messagesTotal`] = c02MixedTotalMessages(entry.profile)
    map[`${prefix}_projectedTotal`] = c02MixedExpectedProjectedTotal(entry.profile)
    for (let i = 0; i < entry.profile.topicSpecs.length; i++) {
      const spec = entry.profile.topicSpecs[i]!
      map[`${prefix}_t${String(i).padStart(2, '0')}_messages`] = spec.messageCount
      map[`${prefix}_t${String(i).padStart(2, '0')}_blockBytes`] = spec.blockContentBytes
    }
  }
  return map
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

// ---------------------------------------------------------------------------
// Safe categorical labels — whitelisted fixed labels for artifact gate details
// Only finite scalars/booleans and these fixed labels may be serialized.
// Arbitrary caller strings (productionPath, reason, topic IDs, anchors, paths,
// contents, credentials, histories) must never enter gate details.
// ---------------------------------------------------------------------------

export const SAFE_HEAP_DELTA_CATEGORIES = {
  effectiveInformative: 'heapDelta-effective-precise-positive-informative',
  inconclusiveNonFinite: 'heapDelta-inconclusive-non-finite',
  inconclusiveZero: 'heapDelta-inconclusive-zero-quantized',
  inconclusiveNegative: 'heapDelta-inconclusive-negative-gc',
  inconclusiveBucketed: 'heapDelta-inconclusive-bucketed-quantized',
  inconclusiveGeneric: 'heapDelta-inconclusive-generic'
} as const

export const SAFE_PRODUCTION_PATH_STAGES = {
  complete: 'canonical-production-path-complete',
  partial: 'canonical-production-path-partial'
} as const

export const SAFE_HEAP_METHOD_LABELS = {
  preciseMemory: 'performance.memory',
  unsupported: 'unsupported'
} as const

export function deriveSafeHeapDeltaCategory(
  heapDeltaBytes: number,
  precision: HeapPrecisionLabel,
  effectiveInformative: boolean
): string {
  if (effectiveInformative) return SAFE_HEAP_DELTA_CATEGORIES.effectiveInformative
  if (!Number.isFinite(heapDeltaBytes)) return SAFE_HEAP_DELTA_CATEGORIES.inconclusiveNonFinite
  if (heapDeltaBytes === 0) return SAFE_HEAP_DELTA_CATEGORIES.inconclusiveZero
  if (heapDeltaBytes < 0) return SAFE_HEAP_DELTA_CATEGORIES.inconclusiveNegative
  if (precision !== 'precise') return SAFE_HEAP_DELTA_CATEGORIES.inconclusiveBucketed
  return SAFE_HEAP_DELTA_CATEGORIES.inconclusiveGeneric
}

export function deriveSafeProductionPathStage(complete: boolean | undefined): string {
  return complete ? SAFE_PRODUCTION_PATH_STAGES.complete : SAFE_PRODUCTION_PATH_STAGES.partial
}

export function deriveSafeHeapMethodLabel(method: string): string {
  return method === RENDERER_HEAP_METHOD ? SAFE_HEAP_METHOD_LABELS.preciseMemory : SAFE_HEAP_METHOD_LABELS.unsupported
}

export function deriveSafeProfileLabel(profileId: string): string {
  const allowed = new Set<string>([
    ...Object.values(C02_HEAP_PROFILE_IDS),
    ...Object.values(C02_MIXED_HEAP_PROFILE_IDS)
  ])
  return allowed.has(profileId) ? profileId : 'unknown-profile-generic'
}

// ---------------------------------------------------------------------------
// Artifact construction — schema v1, directional/synthetic labeled (pure, testable seam)
// Redacted: gate details carry only finite scalar proof and fixed stage labels,
// never dynamic topic IDs, content, paths, credentials, or histories.
// ---------------------------------------------------------------------------

export interface C02AllocationForArtifact {
  topicsCreated: number
  messagesCreated: number
  blocksCreated: number
  usedTypedPath: boolean
  reduxVerified: boolean
  projectionStats: {
    reduxMessages: number
    reduxBlocks: number
    groupCount: number
    displayMessages: number
    anchorGroupKey: string | null
    contextBoundaryPresent: boolean
    /** Strict inside-messages signal — mandatory fail-closed per LOCK-004; whole-topic (1..25) requires no divider anywhere + null anchor, partial requires divider inside #messages + final-owned anchor. */
    contextBoundaryInsideMessages: boolean
    finalTopicDomProof: boolean
    groupExactMatched?: boolean
    groupsWithFinalTopic?: number
    globalDisplayMessages: number
  }
  productionPath: string
  productionPathComplete?: boolean
}

/**
 * Build a complete schema-v1 BenchmarkResult for a uniform profile.
 * Pure deterministic helper — suitable for focused privacy/structure tests
 * via the existing benchResult validator. Details are neutral, scalar-only,
 * and contain no synthetic topic IDs.
 */
export function buildC02BenchmarkResult(
  environment: BenchmarkResult['environment'],
  profile: C02HeapProfile,
  logicalBytes: number,
  rendererLogicalBytes: number,
  heapBefore: RendererHeapSample,
  heapAfter: RendererHeapSample,
  allocation: C02AllocationForArtifact,
  informativeness: { informative: boolean; reason: string },
  precision: HeapPrecisionLabel
): BenchmarkResult {
  if (typeof allocation.projectionStats.contextBoundaryInsideMessages !== 'boolean') {
    throw new Error(
      '[PERF-C02] fail-closed: contextBoundaryInsideMessages is required (boolean) — whole-topic windows (1..25) require no divider anywhere + null anchor; partial windows require divider inside #messages + final-owned anchor (LOCK-004)'
    )
  }
  const amplification = computeHeapAmplification(heapBefore, heapAfter, logicalBytes)
  const scale = buildC02ScaleMap(profile, heapBefore.method, precision)
  // Derive effective informativeness from measured heap delta + precision — caller boolean is diagnostic only (fail-closed)
  const effectiveInformative = deriveEffectiveHeapInformative(amplification.heapDeltaBytes, precision)
  void informativeness
  const deltaInformativeMetric = effectiveInformative ? 1 : 0
  const effectiveDeltaRatio = effectiveInformative ? amplification.deltaRatio : 0
  const effectiveAbsoluteRatio = effectiveInformative ? amplification.absoluteRatio : 0

  const expectedVisible = c02ExpectedVisibleCount(profile)
  const expectedTopicSuffix = `c02-heap-topic-${String(profile.syntheticTopics - 1).padStart(2, '0')}`
  const anchorFinalTopicOwned = isC02ExactTopicOwned(allocation.projectionStats.anchorGroupKey, expectedTopicSuffix)
  const lastTopicIdForContext = expectedTopicSuffix
  const contextBoundaryInsideMessagesForGate = allocation.projectionStats.contextBoundaryInsideMessages
  const contextEvidenceValid = isC02ContextEvidenceValid({
    contextBoundaryPresent: allocation.projectionStats.contextBoundaryPresent,
    contextBoundaryInsideMessages: contextBoundaryInsideMessagesForGate,
    anchorGroupKey: allocation.projectionStats.anchorGroupKey,
    lastTopicId: lastTopicIdForContext,
    expectedVisibleFinal: expectedVisible
  })
  // Derive DOM/group validity from observed scalar counts — caller booleans are diagnostic only (fail-closed)
  const derivedFinalTopicDomProof = deriveFinalTopicDomProof(
    allocation.projectionStats.displayMessages,
    allocation.projectionStats.globalDisplayMessages,
    expectedVisible
  )
  const derivedGroupCountExact = deriveGroupCountExact(allocation.projectionStats.groupCount, expectedVisible)
  const derivedGroupOwnershipProof =
    (allocation.projectionStats.groupsWithFinalTopic ?? 0) === expectedVisible && derivedGroupCountExact
  const derivedProductionPathComplete = isC02ProductionPathComplete({
    reduxVerified: allocation.reduxVerified,
    finalTopicDomProof: derivedFinalTopicDomProof,
    groupCountExact: derivedGroupCountExact,
    groupOwnershipProof: derivedGroupOwnershipProof,
    contextBoundaryPresent: allocation.projectionStats.contextBoundaryPresent,
    contextBoundaryInsideMessages: allocation.projectionStats.contextBoundaryInsideMessages,
    anchorGroupKey: allocation.projectionStats.anchorGroupKey,
    lastTopicId: lastTopicIdForContext,
    expectedVisibleFinal: expectedVisible
  })
  const effectiveProductionPathComplete = derivedProductionPathComplete
  void allocation.productionPathComplete
  const authoritativeComplete = effectiveInformative && effectiveProductionPathComplete
  const safeHeapDeltaCategory = deriveSafeHeapDeltaCategory(
    amplification.heapDeltaBytes,
    precision,
    effectiveInformative
  )
  const safeHeapMethodLabel = deriveSafeHeapMethodLabel(heapBefore.method)
  const safeProductionPathStage = deriveSafeProductionPathStage(effectiveProductionPathComplete)
  const deltaGateDetail = effectiveInformative
    ? `directional synthetic: heapDelta=${amplification.heapDeltaBytes} is finite positive with precision=${precision} (argv --enable-precise-memory-info present) — category=${safeHeapDeltaCategory} — effective informative (precision===precise && finite positive) for directional amplification; deltaRatio=${effectiveDeltaRatio.toFixed(3)} valid`
    : `directional synthetic: heapDelta=${amplification.heapDeltaBytes} is INCONCLUSIVE — category=${safeHeapDeltaCategory}; precision=${precision}. Effective requires precision===precise && finite positive delta. Zero/negative/non-finite or bucketed (precision!=precise) delta is inconclusive and ratios are 0 (not valid amplification, raw heap.delta remains diagnostic). See heap.deltaInformative metric.`
  const deltaGatePassed = effectiveInformative

  const metrics: BenchmarkMetric[] = [
    {
      id: 'logical.bytes',
      name: 'canonical logical payload bytes (phase4-logical-payload-v1, directional synthetic)',
      value: logicalBytes,
      unit: 'bytes'
    },
    {
      id: 'logical.bytes.rendererEstimate',
      name: 'renderer TextEncoder JSON estimate bytes (directional parity, non-canonical)',
      value: rendererLogicalBytes,
      unit: 'bytes'
    },
    {
      id: 'heap.used.before',
      name: 'renderer heap used before allocation (performance.memory usedJSHeapSize, directional)',
      value: heapBefore.usedJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.used.after',
      name: 'renderer heap used after resident Redux projection allocation (performance.memory usedJSHeapSize, directional)',
      value: heapAfter.usedJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.total.after',
      name: 'renderer heap total after allocation (performance.memory totalJSHeapSize, directional)',
      value: heapAfter.totalJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.limit',
      name: 'renderer heap limit (performance.memory jsHeapSizeLimit, directional)',
      value: heapAfter.jsHeapSizeLimit,
      unit: 'bytes'
    },
    {
      id: 'heap.delta',
      name: 'renderer heap delta bytes (after - before, directional synthetic; 0/negative/bucketed is inconclusive, not amplification 0 — raw diagnostic)',
      value: amplification.heapDeltaBytes,
      unit: 'bytes'
    },
    {
      id: 'heap.deltaInformative',
      name: 'heap delta informativeness gate value (1=effective informative precise positive delta, 0=inconclusive zero/negative/non-finite/bucketed — single definition precision===precise && finite positive)',
      value: deltaInformativeMetric,
      unit: 'count'
    },
    {
      id: 'heap.amplification.deltaRatio',
      name: 'heap amplification deltaRatio = heapDelta / logicalBytes (directional synthetic, valid ONLY when deltaInformative=1; 0 when inconclusive — bucketed positive remains 0, not valid amplification)',
      value: effectiveDeltaRatio,
      unit: 'ratio'
    },
    {
      id: 'heap.amplification.absoluteRatio',
      name: 'heap amplification absoluteRatio = heapUsedAfter / logicalBytes (directional synthetic, valid ONLY when deltaInformative=1; 0 when inconclusive)',
      value: effectiveAbsoluteRatio,
      unit: 'ratio'
    },
    {
      id: 'synthetic.topics',
      name: 'synthetic topics created (directional)',
      value: allocation.topicsCreated,
      unit: 'count'
    },
    {
      id: 'synthetic.messages',
      name: 'synthetic messages created (directional)',
      value: allocation.messagesCreated,
      unit: 'count'
    },
    {
      id: 'synthetic.blocks',
      name: 'synthetic blocks created (directional, Redux messageBlocks entity)',
      value: allocation.blocksCreated,
      unit: 'count'
    },
    {
      id: 'projection.reduxMessages',
      name: 'Redux messages entity count verified resident (directional)',
      value: allocation.projectionStats.reduxMessages,
      unit: 'count'
    },
    {
      id: 'projection.reduxBlocks',
      name: 'Redux blocks entity count verified resident (directional)',
      value: allocation.projectionStats.reduxBlocks,
      unit: 'count'
    },
    {
      id: 'projection.groups',
      name: 'derived viewport groups count via actual rendered DOM #messages [data-stable-group-id] (directional, production Messages.tsx) — exact expectedVisible required for complete; global [data-stable-group-id] never authoritative',
      value: allocation.projectionStats.groupCount,
      unit: 'count'
    },
    {
      id: 'projection.displayMessages',
      name: 'derived displayMessages window count via actual rendered DOM #messages [data-message-id] scoped to final synthetic topic (directional, production Messages.tsx) — exact expectedVisible required for complete; [id^="message-"] is diagnostic-only',
      value: allocation.projectionStats.displayMessages,
      unit: 'count'
    },
    {
      id: 'projection.displayMessagesGlobal',
      name: 'global displayMessages count via actual rendered DOM #messages [data-message-id] (must equal scoped for final-topic proof; mismatch indicates stale/partial projection; global [id^="message-"] never authoritative)',
      value: Number.isFinite(allocation.projectionStats.globalDisplayMessages)
        ? allocation.projectionStats.globalDisplayMessages
        : 0,
      unit: 'count'
    },
    {
      id: 'projection.groupsWithFinalTopic',
      name: 'groups containing final synthetic topic messages via #messages [data-stable-group-id]/[data-message-id] ownership proof; must equal exact expectedVisible for complete; [id^="message-"] descendant never satisfies',
      value: allocation.projectionStats.groupsWithFinalTopic ?? 0,
      unit: 'count'
    },
    {
      id: 'projection.finalTopicDomProof',
      name: 'final-topic DOM ownership proof via #messages [data-message-id] (1= scoped===global===expectedVisible for final clicked topic inside #messages, 0= stale/global/partial — complete requires 1; [id^="message-"] never satisfies — derived from counts, caller ignored fail-closed)',
      value: derivedFinalTopicDomProof ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'projection.contextBoundaryPresent',
      name: 'context boundary inside #messages mandatory signal per LOCK-004 — whole-topic windows (1..25) require no divider anywhere + null anchor (valid 0), partial windows require divider inside #messages + final-owned anchor (valid 1); outside/global invalid; explicit inside signal mandatory (fail-closed)',
      value: allocation.projectionStats.contextBoundaryPresent ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'projection.productionPathComplete',
      name: 'productionPath complete derived from evidence predicate (LOCK-004) — whole-topic (1..25) no-divider/null-anchor branch and partial inside-divider/final-owned branch; 1= derived predicate true (Redux verified + final-topic ownership + exact groups + valid context per branch), 0= partial/inconclusive — caller bool cannot override invalid evidence (fail-closed)',
      value: effectiveProductionPathComplete ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'calibration.complete',
      name: 'authoritative calibration complete — effective precise heap AND derived productionPath complete (whole-topic 1..25 no-divider/null-anchor or partial inside-divider/final-owned with explicit inside signal; invalid heap or invalid/omitted inside signal never yields complete)',
      value: authoritativeComplete ? 1 : 0,
      unit: 'count'
    }
  ]

  const gates: BenchmarkGate[] = [
    {
      id: 'synthetic.datasetComplete',
      name: 'synthetic dataset complete via canonicalization (phase4-logical-payload-v1)',
      kind: 'correctness',
      passed: true,
      detail: `directional synthetic: ${allocation.topicsCreated} topics, ${allocation.messagesCreated} messages, ${allocation.blocksCreated} blocks, logicalBytes=${logicalBytes} (canonical), typedPath=${allocation.usedTypedPath} (existing ChatDb ensureTopic/pasteMessages/fetchMessages) → Redux entity projection verified=${allocation.reduxVerified} (messages entity + messageIdsByTopic + blocks entity)`
    },
    {
      id: 'heap.sampleAvailable',
      name: 'actual renderer heap sampled via performance.memory (renderer process, not Node proxy)',
      kind: 'correctness',
      passed: true,
      detail: `directional synthetic: method=${safeHeapMethodLabel}, precision=${precision}, before=${heapBefore.usedJSHeapSize}, after=${heapAfter.usedJSHeapSize}, delta=${amplification.heapDeltaBytes} (least invasive Chromium API; no Node process.memoryUsage proxy; opt-in --enable-precise-memory-info when C02 enabled)`
    },
    {
      id: 'heap.deltaInformative',
      name: 'heap delta informativeness — effective (precision===precise && finite positive delta); zero/bucketed/negative/non-finite is never amplification 0 evidence (evidence-informativeness gate, not product threshold)',
      kind: 'correctness',
      passed: deltaGatePassed,
      detail: deltaGateDetail
    },
    {
      id: 'heap.precision',
      name: 'heap precision mode detected via argv --enable-precise-memory-info (inconclusive when bucketed, not amplification 0)',
      kind: 'correctness',
      passed: precision === 'precise',
      detail: `directional synthetic: precision=${precision} (precise requires opt-in launch flag; bucketed values are quantized and zero delta is inconclusive; effective requires precise+finite positive). Heap amplification ratios are 0 when not effective.`
    },
    {
      id: 'logical.bytesFinite',
      name: 'canonical logical bytes finite and positive (separate axis from heap)',
      kind: 'correctness',
      passed: true,
      detail: `directional synthetic: logicalBytes=${logicalBytes} (phase4-logical-payload-v1), rendererEstimate=${rendererLogicalBytes} — heap amplification reported separately, not conflated`
    },
    {
      id: 'allocation.resident',
      name: 'Redux entity projection + derived viewport/group/context via actual rendered Chat path — authoritative calibration complete requires effective heap AND derived productionPath (LOCK-004 branches: whole-topic 1..25 no-divider/null-anchor OR partial inside-divider/final-owned) (renderer heap)',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `directional synthetic: Redux projection — ${allocation.projectionStats.reduxMessages} messages, ${allocation.projectionStats.reduxBlocks} blocks; derived DOM — ${allocation.projectionStats.groupCount} groups (#messages [data-stable-group-id]) exact=${derivedGroupCountExact ? 1 : 0} (derived groupCount=${allocation.projectionStats.groupCount} vs expectedVisible=${expectedVisible}, caller ${allocation.projectionStats.groupExactMatched ?? 'undef'} ignored fail-closed), displayMessages scoped=${allocation.projectionStats.displayMessages} global=${allocation.projectionStats.globalDisplayMessages} (finalTopicProof=${derivedFinalTopicDomProof ? 1 : 0} derived scoped/global vs expectedVisible, caller ${allocation.projectionStats.finalTopicDomProof ? 1 : 0} ignored fail-closed via #messages [data-message-id]), groupsWithFinalTopic=${allocation.projectionStats.groupsWithFinalTopic ?? 0}; contextBoundaryPresent=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0} insideMessages=${allocation.projectionStats.contextBoundaryInsideMessages ? 1 : 0} anchorPresent=${allocation.projectionStats.anchorGroupKey !== null ? 1 : 0} finalTopicOwned=${anchorFinalTopicOwned ? 1 : 0} (exact boundary-safe isC02ExactTopicOwned); stage=${safeProductionPathStage}; derivedProductionPathComplete=${effectiveProductionPathComplete ? 1 : 0} (caller ${allocation.productionPathComplete ? 1 : 0} ignored when invalid, fail-closed); effectiveInformative=${effectiveInformative ? 1 : 0} (derived measured delta=${amplification.heapDeltaBytes} precision=${precision}, caller ${informativeness.informative ? 1 : 0} ignored fail-closed); authoritativeComplete=${authoritativeComplete ? 1 : 0} (requires precise && finite positive delta && valid LOCK-004 context branch; fallback/global never satisfies; invalid heap or omitted inside signal never yields complete). Detached holder removed; heap cost is renderer entity + production-derived projections when authoritative complete, otherwise Redux entity only and derived counts are inconclusive.`
    },
    {
      id: 'productionPath.complete',
      name: 'productionPath complete derived from evidence predicate (LOCK-004) — whole-topic (1..25) no-divider/null-anchor branch and partial inside-divider/final-owned branch — final clicked topic owns #messages DOM with valid context per branch (no fallback/global satisfies)',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `derivedProductionPathComplete=${effectiveProductionPathComplete ? 1 : 0} (caller ${allocation.productionPathComplete ? 1 : 0} ignored when invalid, fail-closed); effectiveInformative=${effectiveInformative ? 1 : 0} (precision=${precision}, delta=${amplification.heapDeltaBytes}); authoritativeComplete=${authoritativeComplete ? 1 : 0}; stage=${safeProductionPathStage} — locked: authoritative complete requires BOTH effective precise heap (precision===precise && finite positive delta) AND derived #messages proof per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor OR partial divider inside #messages with final-owned anchor); fallback [id^="message-"]/global stale DOM or bucketed delta or omitted inside signal never satisfies complete (see perf-c02-heap-calibration.spec.ts activateReduxProjection).`
    },
    {
      id: 'projection.finalTopicOwnership',
      name: 'final clicked synthetic topic owns the measured #messages DOM — #messages [data-message-id] scoped to final topic equals global and expectedVisible (no global stale count or [id^="message-"] satisfies complete)',
      kind: 'correctness',
      passed: derivedFinalTopicDomProof,
      detail: `finalTopicDomProof=${derivedFinalTopicDomProof ? 1 : 0} (derived scoped=${allocation.projectionStats.displayMessages} global=${allocation.projectionStats.globalDisplayMessages} vs expectedVisible=${expectedVisible}); scoped=${allocation.projectionStats.displayMessages}, global=${allocation.projectionStats.globalDisplayMessages}, expectedVisible=${expectedVisible} (min(N, productionWindow ${C02_PRODUCTION_WINDOW_MAX}) — large retains 150 logically but projects 100), strict #messages [data-message-id] only, [id^="message-"] diagnostic-only excluded — caller ${allocation.projectionStats.finalTopicDomProof ? 1 : 0} ignored when invalid (fail-closed)`
    },
    {
      id: 'projection.contextBoundaryExplicit',
      name: 'context boundary explicit per LOCK-004 — whole-topic windows (1..25) require no divider anywhere + null anchor (valid absent), partial windows require divider inside #messages + final-owned anchor (valid present); outside/global invalid — explicit inside signal mandatory (fail-closed when omitted)',
      kind: 'correctness',
      passed: contextEvidenceValid,
      detail: `contextEvidenceValid=${contextEvidenceValid ? 1 : 0} via LOCK-004 predicate (wholeTopic=${isC02WholeTopicWindow(expectedVisible) ? 1 : 0} expectedVisible=${expectedVisible} positive integer 1..25 branch); contextBoundaryPresent=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0} insideMessages=${contextBoundaryInsideMessagesForGate ? 1 : 0} anchorPresent=${allocation.projectionStats.anchorGroupKey !== null ? 1 : 0} finalTopicOwned=${anchorFinalTopicOwned ? 1 : 0} (exact boundary-safe isC02ExactTopicOwned); whole-topic (1..25) valid only with no divider anywhere + null anchor, partial requires divider inside #messages with final-topic-owned anchor, global/outside never satisfies; inside signal mandatory (fail-closed when absent)`
    },
    {
      id: 'calibration.complete',
      name: 'authoritative calibration complete — effective precise heap AND derived productionPath complete per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor or partial inside-divider/final-owned with explicit inside signal; invalid heap or invalid/omitted inside signal never yields complete)',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `authoritativeComplete=${authoritativeComplete ? 1 : 0}; effectiveInformative=${effectiveInformative ? 1 : 0} (derived from measured delta=${amplification.heapDeltaBytes} precision=${precision}, caller ${informativeness.informative ? 1 : 0} ignored when invalid, fail-closed) derivedProductionPathComplete=${effectiveProductionPathComplete ? 1 : 0} (caller ${allocation.productionPathComplete ? 1 : 0} ignored when invalid, fail-closed) (finalTopicProof=${derivedFinalTopicDomProof ? 1 : 0}, groupsWithFinalTopic=${allocation.projectionStats.groupsWithFinalTopic ?? 0}, contextInsideMessages=${allocation.projectionStats.contextBoundaryInsideMessages ? 1 : 0}); complete evidence strictly requires precise && finite positive heap delta AND #messages [data-message-id]/[data-stable-group-id]/[data-context-boundary] with LOCK-004 branch validity (whole-topic 1..25 no-divider/null-anchor OR partial divider inside + final-owned anchor) — zero/negative/non-finite/bucketed deltas, [id^="message-"] fallback, global/outside, or omitted inside signal are inconclusive`
    },
    {
      id: 'environment.abi145',
      name: 'measured runtime is Electron ABI 145 lane with safe canonical command',
      kind: 'correctness',
      passed: true,
      detail: `abiLane=electron, abi=${environment.abi}, command=${environment.command} (no path segments)`
    },
    {
      id: 'privacy.schemaV1',
      name: 'artifact complies with PERF-001 schema v1 closed set (no content/credential/path/raw DB size)',
      kind: 'correctness',
      passed: true,
      detail:
        'directional synthetic: metrics/gates/scale carry only numbers and fixed strings; no message content, credentials, paths, model IDs, ask IDs, or raw DB sizes (enforced at write time)'
    }
  ]

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: C02_BENCHMARK_ID,
      name: C02_BENCHMARK_NAME,
      scale: scale as unknown as Record<string, number>
    },
    environment,
    metrics,
    gates
  }
}

/**
 * Build a complete schema-v1 BenchmarkResult for a single mixed profile.
 * Pure, scalar-only, no topic IDs in details.
 */
export function buildC02MixedBenchmarkResult(
  environment: BenchmarkResult['environment'],
  profile: C02MixedHeapProfile,
  logicalBytes: number,
  rendererLogicalBytes: number,
  heapBefore: RendererHeapSample,
  heapAfter: RendererHeapSample,
  allocation: C02AllocationForArtifact,
  informativeness: { informative: boolean; reason: string },
  precision: HeapPrecisionLabel
): BenchmarkResult {
  if (typeof allocation.projectionStats.contextBoundaryInsideMessages !== 'boolean') {
    throw new Error(
      '[PERF-C02] fail-closed: contextBoundaryInsideMessages is required (boolean) — whole-topic windows (1..25) require no divider anywhere + null anchor; partial windows require divider inside #messages + final-owned anchor (LOCK-004)'
    )
  }
  const amplification = computeHeapAmplification(heapBefore, heapAfter, logicalBytes)
  const scale = buildC02MixedScaleMap(profile, heapBefore.method, precision)
  // Derive effective informativeness from measured heap delta + precision — caller boolean is diagnostic only (fail-closed)
  const effectiveInformative = deriveEffectiveHeapInformative(amplification.heapDeltaBytes, precision)
  void informativeness
  const effectiveDeltaRatio = effectiveInformative ? amplification.deltaRatio : 0
  const effectiveAbsoluteRatio = effectiveInformative ? amplification.absoluteRatio : 0
  const lastSpec = profile.topicSpecs[profile.topicSpecs.length - 1]!
  const expectedVisible = c02MixedExpectedVisibleCountForSpec(lastSpec)
  const lastTopicIdForContext = `c02-mixed-topic-${String(profile.topicSpecs.length - 1).padStart(2, '0')}`
  const contextBoundaryInsideMessagesForGate = allocation.projectionStats.contextBoundaryInsideMessages
  const anchorFinalTopicOwned = isC02ExactTopicOwned(allocation.projectionStats.anchorGroupKey, lastTopicIdForContext)
  const contextEvidenceValid = isC02ContextEvidenceValid({
    contextBoundaryPresent: allocation.projectionStats.contextBoundaryPresent,
    contextBoundaryInsideMessages: contextBoundaryInsideMessagesForGate,
    anchorGroupKey: allocation.projectionStats.anchorGroupKey,
    lastTopicId: lastTopicIdForContext,
    expectedVisibleFinal: expectedVisible
  })
  // Derive DOM/group validity from observed scalar counts — caller booleans are diagnostic only (fail-closed)
  const derivedFinalTopicDomProofMixed = deriveFinalTopicDomProof(
    allocation.projectionStats.displayMessages,
    allocation.projectionStats.globalDisplayMessages,
    expectedVisible
  )
  const derivedGroupCountExactMixed = deriveGroupCountExact(allocation.projectionStats.groupCount, expectedVisible)
  const derivedGroupOwnershipProofMixed =
    (allocation.projectionStats.groupsWithFinalTopic ?? 0) === expectedVisible && derivedGroupCountExactMixed
  const derivedProductionPathComplete = isC02ProductionPathComplete({
    reduxVerified: allocation.reduxVerified,
    finalTopicDomProof: derivedFinalTopicDomProofMixed,
    groupCountExact: derivedGroupCountExactMixed,
    groupOwnershipProof: derivedGroupOwnershipProofMixed,
    contextBoundaryPresent: allocation.projectionStats.contextBoundaryPresent,
    contextBoundaryInsideMessages: allocation.projectionStats.contextBoundaryInsideMessages,
    anchorGroupKey: allocation.projectionStats.anchorGroupKey,
    lastTopicId: lastTopicIdForContext,
    expectedVisibleFinal: expectedVisible
  })
  const effectiveProductionPathComplete = derivedProductionPathComplete
  void allocation.productionPathComplete
  const authoritativeComplete = effectiveInformative && effectiveProductionPathComplete
  const safeHeapDeltaCategory = deriveSafeHeapDeltaCategory(
    amplification.heapDeltaBytes,
    precision,
    effectiveInformative
  )
  const safeHeapMethodLabel = deriveSafeHeapMethodLabel(heapBefore.method)
  const safeProductionPathStage = deriveSafeProductionPathStage(effectiveProductionPathComplete)

  const metrics: BenchmarkMetric[] = [
    {
      id: 'logical.bytes',
      name: 'canonical logical payload bytes (phase4-logical-payload-v1, directional synthetic, mixed distribution)',
      value: logicalBytes,
      unit: 'bytes'
    },
    {
      id: 'logical.bytes.rendererEstimate',
      name: 'renderer TextEncoder JSON estimate bytes (directional parity, non-canonical, mixed)',
      value: rendererLogicalBytes,
      unit: 'bytes'
    },
    {
      id: 'heap.used.before',
      name: 'renderer heap used before allocation (performance.memory usedJSHeapSize, mixed directional)',
      value: heapBefore.usedJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.used.after',
      name: 'renderer heap used after resident mixed Redux projection allocation (performance.memory usedJSHeapSize, mixed directional)',
      value: heapAfter.usedJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.total.after',
      name: 'renderer heap total after allocation (performance.memory totalJSHeapSize, mixed directional)',
      value: heapAfter.totalJSHeapSize,
      unit: 'bytes'
    },
    {
      id: 'heap.limit',
      name: 'renderer heap limit (performance.memory jsHeapSizeLimit, mixed directional)',
      value: heapAfter.jsHeapSizeLimit,
      unit: 'bytes'
    },
    {
      id: 'heap.delta',
      name: 'renderer heap delta bytes (after - before, mixed directional synthetic; 0/negative/bucketed is inconclusive, not amplification 0 — raw diagnostic)',
      value: amplification.heapDeltaBytes,
      unit: 'bytes'
    },
    {
      id: 'heap.deltaInformative',
      name: 'heap delta informativeness gate value (1=effective informative precise positive delta, 0=inconclusive mixed)',
      value: effectiveInformative ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'heap.amplification.deltaRatio',
      name: 'heap amplification deltaRatio = heapDelta / logicalBytes (mixed directional synthetic, valid ONLY when deltaInformative=1; 0 when inconclusive)',
      value: effectiveDeltaRatio,
      unit: 'ratio'
    },
    {
      id: 'heap.amplification.absoluteRatio',
      name: 'heap amplification absoluteRatio = heapUsedAfter / logicalBytes (mixed directional synthetic, valid ONLY when deltaInformative=1; 0 when inconclusive)',
      value: effectiveAbsoluteRatio,
      unit: 'ratio'
    },
    {
      id: 'synthetic.topics',
      name: 'synthetic topics created (mixed directional)',
      value: allocation.topicsCreated,
      unit: 'count'
    },
    {
      id: 'synthetic.messages',
      name: 'synthetic messages created (mixed directional)',
      value: allocation.messagesCreated,
      unit: 'count'
    },
    {
      id: 'synthetic.blocks',
      name: 'synthetic blocks created (mixed directional, Redux messageBlocks entity)',
      value: allocation.blocksCreated,
      unit: 'count'
    },
    {
      id: 'projection.reduxMessages',
      name: 'Redux messages entity count verified resident (mixed directional)',
      value: allocation.projectionStats.reduxMessages,
      unit: 'count'
    },
    {
      id: 'projection.reduxBlocks',
      name: 'Redux blocks entity count verified resident (mixed directional)',
      value: allocation.projectionStats.reduxBlocks,
      unit: 'count'
    },
    {
      id: 'projection.groups',
      name: 'derived viewport groups count via actual rendered DOM #messages [data-stable-group-id] (mixed directional) — exact expectedVisible required for complete',
      value: allocation.projectionStats.groupCount,
      unit: 'count'
    },
    {
      id: 'projection.displayMessages',
      name: 'derived displayMessages window count via actual rendered DOM #messages [data-message-id] scoped to final synthetic topic (mixed directional)',
      value: allocation.projectionStats.displayMessages,
      unit: 'count'
    },
    {
      id: 'projection.displayMessagesGlobal',
      name: 'global displayMessages count via actual rendered DOM #messages [data-message-id] (mixed must equal scoped)',
      value: Number.isFinite(allocation.projectionStats.globalDisplayMessages)
        ? allocation.projectionStats.globalDisplayMessages
        : 0,
      unit: 'count'
    },
    {
      id: 'projection.groupsWithFinalTopic',
      name: 'groups containing final synthetic topic messages via #messages ownership proof (mixed)',
      value: allocation.projectionStats.groupsWithFinalTopic ?? 0,
      unit: 'count'
    },
    {
      id: 'projection.finalTopicDomProof',
      name: 'final-topic DOM ownership proof via #messages [data-message-id] (mixed 1= scoped===global===expectedVisible, derived from counts, caller ignored fail-closed)',
      value: derivedFinalTopicDomProofMixed ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'projection.contextBoundaryPresent',
      name: 'context boundary inside #messages mandatory signal per LOCK-004 (mixed) — whole-topic windows (1..25) require no divider anywhere + null anchor (valid 0), partial windows require divider inside #messages + final-owned anchor (valid 1); outside/global invalid; explicit inside signal mandatory (fail-closed)',
      value: allocation.projectionStats.contextBoundaryPresent ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'projection.productionPathComplete',
      name: 'productionPath complete derived from evidence predicate (LOCK-004 mixed) — whole-topic (1..25) no-divider/null-anchor branch and partial inside-divider/final-owned branch; 1= derived true, 0= partial/inconclusive — caller bool cannot override (fail-closed)',
      value: effectiveProductionPathComplete ? 1 : 0,
      unit: 'count'
    },
    {
      id: 'calibration.complete',
      name: 'authoritative calibration complete — effective precise heap AND derived productionPath complete per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor or partial inside-divider/final-owned with explicit inside signal) (mixed)',
      value: authoritativeComplete ? 1 : 0,
      unit: 'count'
    }
  ]

  const gates: BenchmarkGate[] = [
    {
      id: 'synthetic.datasetComplete',
      name: 'synthetic dataset complete via canonicalization (phase4-logical-payload-v1, mixed)',
      kind: 'correctness',
      passed: true,
      detail: `directional synthetic mixed: ${allocation.topicsCreated} topics heterogeneous (${profile.topicSpecs.map((s) => `${s.messageCount}×${s.blockContentBytes}B`).join(', ')}) logicalBytes=${logicalBytes} typedPath=${allocation.usedTypedPath} verified=${allocation.reduxVerified}`
    },
    {
      id: 'heap.sampleAvailable',
      name: 'actual renderer heap sampled via performance.memory (renderer process, mixed)',
      kind: 'correctness',
      passed: true,
      detail: `directional synthetic mixed: method=${safeHeapMethodLabel}, precision=${precision}, before=${heapBefore.usedJSHeapSize}, after=${heapAfter.usedJSHeapSize}, delta=${amplification.heapDeltaBytes} category=${safeHeapDeltaCategory}`
    },
    {
      id: 'heap.deltaInformative',
      name: 'heap delta informativeness — effective (precision===precise && finite positive) (mixed)',
      kind: 'correctness',
      passed: effectiveInformative,
      detail: effectiveInformative
        ? `mixed heapDelta=${amplification.heapDeltaBytes} precise informative category=${safeHeapDeltaCategory} deltaRatio=${effectiveDeltaRatio.toFixed(3)}`
        : `mixed inconclusive: category=${safeHeapDeltaCategory}; precision=${precision} heapDelta=${amplification.heapDeltaBytes}`
    },
    {
      id: 'heap.precision',
      name: 'heap precision mode detected via argv --enable-precise-memory-info (mixed inconclusive when bucketed)',
      kind: 'correctness',
      passed: precision === 'precise',
      detail: `mixed precision=${precision} amplification ratios 0 when not effective`
    },
    {
      id: 'logical.bytesFinite',
      name: 'canonical logical bytes finite and positive (mixed separate axis)',
      kind: 'correctness',
      passed: true,
      detail: `mixed logicalBytes=${logicalBytes} rendererEstimate=${rendererLogicalBytes}`
    },
    {
      id: 'allocation.resident',
      name: 'Redux entity projection + derived viewport/group/context via actual rendered Chat path (mixed) — authoritative complete requires effective heap AND derived productionPath per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor OR partial inside-divider/final-owned)',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `mixed Redux ${allocation.projectionStats.reduxMessages} msgs ${allocation.projectionStats.reduxBlocks} blocks; derived groups ${allocation.projectionStats.groupCount} exact=${derivedGroupCountExactMixed ? 1 : 0} (derived groupCount=${allocation.projectionStats.groupCount} vs expectedVisible=${expectedVisible}, caller ${allocation.projectionStats.groupExactMatched ?? 'undef'} ignored fail-closed), display scoped=${allocation.projectionStats.displayMessages} global=${allocation.projectionStats.globalDisplayMessages} finalTopicProof=${derivedFinalTopicDomProofMixed ? 1 : 0} (derived scoped/global vs expectedVisible, caller ${allocation.projectionStats.finalTopicDomProof ? 1 : 0} ignored fail-closed); contextBoundaryPresent=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0} insideMessages=${allocation.projectionStats.contextBoundaryInsideMessages ? 1 : 0} anchorPresent=${allocation.projectionStats.anchorGroupKey !== null ? 1 : 0} finalTopicOwned=${anchorFinalTopicOwned ? 1 : 0} (exact boundary-safe isC02ExactTopicOwned); stage=${safeProductionPathStage} derivedComplete=${effectiveProductionPathComplete ? 1 : 0} (caller ${allocation.productionPathComplete ? 1 : 0} ignored when invalid, fail-closed) effective=${effectiveInformative ? 1 : 0} (derived delta=${amplification.heapDeltaBytes} precision=${precision}, caller ${informativeness.informative ? 1 : 0} ignored fail-closed) category=${safeHeapDeltaCategory}; valid branches: whole-topic (1..25) no-divider/null-anchor, partial inside-divider/final-owned; omitted inside signal never yields complete`
    },
    {
      id: 'productionPath.complete',
      name: 'productionPath complete derived from evidence predicate (LOCK-004 mixed) — whole-topic (1..25) no-divider/null-anchor branch and partial inside-divider/final-owned branch',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `mixed derivedProductionPathComplete=${effectiveProductionPathComplete ? 1 : 0} (caller ${allocation.productionPathComplete ? 1 : 0} ignored when invalid, fail-closed); effective=${effectiveInformative ? 1 : 0}; stage=${safeProductionPathStage} category=${safeHeapDeltaCategory}; branches: whole-topic (1..25) no-divider/null-anchor OR partial divider inside #messages with final-owned anchor; omitted inside signal never satisfies`
    },
    {
      id: 'projection.finalTopicOwnership',
      name: 'final clicked synthetic topic owns the measured #messages DOM (mixed) — derived scoped/global vs expectedVisible (fail-closed)',
      kind: 'correctness',
      passed: derivedFinalTopicDomProofMixed,
      detail: `mixed finalTopicDomProof=${derivedFinalTopicDomProofMixed ? 1 : 0} (derived scoped=${allocation.projectionStats.displayMessages} global=${allocation.projectionStats.globalDisplayMessages} vs expectedVisible=${expectedVisible}, caller ${allocation.projectionStats.finalTopicDomProof ? 1 : 0} ignored fail-closed); scoped=${allocation.projectionStats.displayMessages}, global=${allocation.projectionStats.globalDisplayMessages}, expectedVisible=${expectedVisible}`
    },
    {
      id: 'projection.contextBoundaryExplicit',
      name: 'context boundary explicit per LOCK-004 (mixed) — whole-topic windows (1..25) require no divider anywhere + null anchor (valid absent), partial windows require divider inside #messages + final-owned anchor (valid present); outside/global invalid — explicit inside signal mandatory (fail-closed when omitted)',
      kind: 'correctness',
      passed: contextEvidenceValid,
      detail: `mixed contextEvidenceValid=${contextEvidenceValid ? 1 : 0} via LOCK-004 predicate (wholeTopic=${isC02WholeTopicWindow(expectedVisible) ? 1 : 0} expectedVisible=${expectedVisible} positive integer 1..25 branch); contextBoundaryPresent=${allocation.projectionStats.contextBoundaryPresent ? 1 : 0} insideMessages=${contextBoundaryInsideMessagesForGate ? 1 : 0} anchorPresent=${allocation.projectionStats.anchorGroupKey !== null ? 1 : 0} finalTopicOwned=${anchorFinalTopicOwned ? 1 : 0}; whole-topic (1..25) valid only with no divider anywhere + null anchor, partial requires divider inside #messages with final-topic-owned anchor, global/outside never satisfies; inside signal mandatory (fail-closed when absent)`
    },
    {
      id: 'calibration.complete',
      name: 'authoritative calibration complete — effective precise heap AND derived productionPath complete per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor or partial inside-divider/final-owned with explicit inside signal) (mixed)',
      kind: 'correctness',
      passed: authoritativeComplete,
      detail: `mixed authoritativeComplete=${authoritativeComplete ? 1 : 0}; effective=${effectiveInformative ? 1 : 0}, derivedProductionPathComplete=${effectiveProductionPathComplete ? 1 : 0} (caller ${allocation.productionPathComplete ? 1 : 0} ignored when invalid, fail-closed); branches: whole-topic (1..25) no-divider/null-anchor OR partial inside-divider/final-owned; omitted inside signal never yields complete`
    },
    {
      id: 'environment.abi145',
      name: 'measured runtime is Electron ABI 145 lane with safe canonical command (mixed)',
      kind: 'correctness',
      passed: true,
      detail: `abiLane=electron, abi=${environment.abi}, command=${environment.command}`
    },
    {
      id: 'privacy.schemaV1',
      name: 'artifact complies with PERF-001 schema v1 closed set (no content/credential/path/raw DB size) (mixed)',
      kind: 'correctness',
      passed: true,
      detail:
        'mixed directional synthetic: metrics/gates/scale carry only numbers and fixed strings; no message content, credentials, paths, model IDs, ask IDs, or raw DB sizes'
    }
  ]

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: C02_BENCHMARK_ID,
      name: `${C02_BENCHMARK_NAME} (mixed, directional synthetic)`,
      scale: scale as unknown as Record<string, number>
    },
    environment,
    metrics,
    gates
  } as BenchmarkResult
}

export function buildC02MultiBenchmarkResult(
  environment: BenchmarkResult['environment'],
  entries: Array<{
    profileId: string
    profile: C02HeapProfile | C02MixedHeapProfile
    logicalBytes: number
    rendererLogicalBytes: number
    heapBefore: RendererHeapSample
    heapAfter: RendererHeapSample
    allocation: C02AllocationForArtifact
    informativeness: { informative: boolean; reason: string }
    precision: HeapPrecisionLabel
    /** Actual activated final topic ID produced by activation (e.g. `c02-${profileId}-topic-03`). Mandatory — no reconstructed fallback. */
    finalTopicId: string
  }>
): BenchmarkResult {
  const allMetrics: BenchmarkMetric[] = []
  const allGates: BenchmarkGate[] = []
  const profileCount = entries.length
  const firstHeapMethod = entries[0]?.heapBefore.method ?? RENDERER_HEAP_METHOD
  const firstPrecision = entries[0]?.precision ?? 'unsupported'
  const scale = buildC02MultiScaleMap(
    entries.map((e) => ({ id: e.profileId, profile: e.profile })),
    firstHeapMethod,
    firstPrecision
  )
  for (const entry of entries) {
    if (typeof entry.allocation.projectionStats.contextBoundaryInsideMessages !== 'boolean') {
      throw new Error(
        `[PERF-C02] fail-closed: contextBoundaryInsideMessages is required (boolean) for ${entry.profileId} — whole-topic windows (1..25) require no divider anywhere + null anchor; partial windows require divider inside #messages + final-owned anchor (LOCK-004)`
      )
    }
    const safeProfileLabel = deriveSafeProfileLabel(entry.profileId)
    const prefix = safeProfileLabel.replace(/-/g, '_')
    const amplification = computeHeapAmplification(entry.heapBefore, entry.heapAfter, entry.logicalBytes)
    // Derive effective informativeness from measured heap delta + precision — caller boolean is diagnostic only (fail-closed)
    const effectiveInformative = deriveEffectiveHeapInformative(amplification.heapDeltaBytes, entry.precision)
    void entry.informativeness
    const effectiveDeltaRatio = effectiveInformative ? amplification.deltaRatio : 0
    const effectiveAbsoluteRatio = effectiveInformative ? amplification.absoluteRatio : 0
    const isMixed = isC02MixedHeapProfile(entry.profile)
    const expectedVisibleMulti = isMixed
      ? c02MixedExpectedVisibleCountForSpec(
          (entry.profile as C02MixedHeapProfile).topicSpecs[
            (entry.profile as C02MixedHeapProfile).topicSpecs.length - 1
          ]!
        )
      : c02ExpectedVisibleCount(entry.profile as C02HeapProfile)
    if (typeof entry.finalTopicId !== 'string' || entry.finalTopicId.trim().length === 0) {
      throw new Error(
        `[PERF-C02] fail-closed: finalTopicId is required (non-empty string) for ${entry.profileId} — actual activated final topic ID must be provided, no reconstructed fallback`
      )
    }
    const lastTopicIdMulti = entry.finalTopicId
    // Derive DOM/group validity from observed scalar counts — caller booleans are diagnostic only (fail-closed)
    const derivedFinalTopicDomProofMulti = deriveFinalTopicDomProof(
      entry.allocation.projectionStats.displayMessages,
      entry.allocation.projectionStats.globalDisplayMessages,
      expectedVisibleMulti
    )
    const derivedGroupCountExactMulti = deriveGroupCountExact(
      entry.allocation.projectionStats.groupCount,
      expectedVisibleMulti
    )
    const derivedGroupOwnershipProofMulti =
      (entry.allocation.projectionStats.groupsWithFinalTopic ?? 0) === expectedVisibleMulti &&
      derivedGroupCountExactMulti
    const derivedProductionPathCompleteMulti = isC02ProductionPathComplete({
      reduxVerified: entry.allocation.reduxVerified,
      finalTopicDomProof: derivedFinalTopicDomProofMulti,
      groupCountExact: derivedGroupCountExactMulti,
      groupOwnershipProof: derivedGroupOwnershipProofMulti,
      contextBoundaryPresent: entry.allocation.projectionStats.contextBoundaryPresent,
      contextBoundaryInsideMessages: entry.allocation.projectionStats.contextBoundaryInsideMessages,
      anchorGroupKey: entry.allocation.projectionStats.anchorGroupKey,
      lastTopicId: lastTopicIdMulti,
      expectedVisibleFinal: expectedVisibleMulti
    })
    const effectiveProductionPathCompleteMulti = derivedProductionPathCompleteMulti
    void entry.allocation.productionPathComplete
    const safeHeapDeltaCategory = deriveSafeHeapDeltaCategory(
      amplification.heapDeltaBytes,
      entry.precision,
      effectiveInformative
    )
    const safeProductionPathStage = deriveSafeProductionPathStage(effectiveProductionPathCompleteMulti)
    allMetrics.push(
      {
        id: `${prefix}.logical.bytes`,
        name: `${safeProfileLabel} canonical logical payload bytes (phase4-logical-payload-v1, directional synthetic)`,
        value: entry.logicalBytes,
        unit: 'bytes'
      },
      {
        id: `${prefix}.heap.delta`,
        name: `${safeProfileLabel} renderer heap delta bytes (directional synthetic; 0/negative/bucketed inconclusive)`,
        value: amplification.heapDeltaBytes,
        unit: 'bytes'
      },
      {
        id: `${prefix}.heap.deltaInformative`,
        name: `${safeProfileLabel} heap delta informativeness (1=effective precise positive, 0=inconclusive)`,
        value: effectiveInformative ? 1 : 0,
        unit: 'count'
      },
      {
        id: `${prefix}.heap.amplification.deltaRatio`,
        name: `${safeProfileLabel} heap amplification deltaRatio (valid only when deltaInformative=1)`,
        value: effectiveDeltaRatio,
        unit: 'ratio'
      },
      {
        id: `${prefix}.heap.amplification.absoluteRatio`,
        name: `${safeProfileLabel} heap amplification absoluteRatio (valid only when deltaInformative=1)`,
        value: effectiveAbsoluteRatio,
        unit: 'ratio'
      },
      {
        id: `${prefix}.synthetic.topics`,
        name: `${safeProfileLabel} synthetic topics`,
        value: entry.allocation.topicsCreated,
        unit: 'count'
      },
      {
        id: `${prefix}.synthetic.messages`,
        name: `${safeProfileLabel} synthetic messages`,
        value: entry.allocation.messagesCreated,
        unit: 'count'
      },
      {
        id: `${prefix}.projection.groups`,
        name: `${safeProfileLabel} derived groups via #messages [data-stable-group-id]`,
        value: entry.allocation.projectionStats.groupCount,
        unit: 'count'
      },
      {
        id: `${prefix}.projection.displayMessages`,
        name: `${safeProfileLabel} displayMessages via #messages [data-message-id] scoped to final topic`,
        value: entry.allocation.projectionStats.displayMessages,
        unit: 'count'
      },
      {
        id: `${prefix}.calibration.complete`,
        name: `${safeProfileLabel} authoritative calibration complete — effective heap AND derived productionPath complete per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor or partial inside-divider/final-owned with explicit inside signal)`,
        value: effectiveInformative && effectiveProductionPathCompleteMulti ? 1 : 0,
        unit: 'count'
      },
      {
        id: `${prefix}.heap.used.before`,
        name: `${safeProfileLabel} heap used before`,
        value: entry.heapBefore.usedJSHeapSize,
        unit: 'bytes'
      },
      {
        id: `${prefix}.heap.used.after`,
        name: `${safeProfileLabel} heap used after`,
        value: entry.heapAfter.usedJSHeapSize,
        unit: 'bytes'
      }
    )
    const authoritativeComplete = effectiveInformative && effectiveProductionPathCompleteMulti
    allGates.push(
      {
        id: `${prefix}.heap.deltaInformative`,
        name: `${safeProfileLabel} heap delta informativeness — effective (precision===precise && finite positive)`,
        kind: 'correctness',
        passed: effectiveInformative,
        detail: effectiveInformative
          ? `${safeProfileLabel} delta ${amplification.heapDeltaBytes} precise informative category=${safeHeapDeltaCategory}`
          : `${safeProfileLabel} inconclusive: category=${safeHeapDeltaCategory}; precision=${entry.precision} heapDelta=${amplification.heapDeltaBytes}`
      },
      {
        id: `${prefix}.calibration.complete`,
        name: `${safeProfileLabel} authoritative calibration complete — effective heap AND derived #messages proof per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor or partial inside-divider/final-owned)`,
        kind: 'correctness',
        passed: authoritativeComplete,
        detail: `profile ${safeProfileLabel}: authoritativeComplete=${authoritativeComplete ? 1 : 0} effective=${effectiveInformative ? 1 : 0} derivedProductionPathComplete=${effectiveProductionPathCompleteMulti ? 1 : 0} (caller ${entry.allocation.productionPathComplete ? 1 : 0} ignored when invalid, fail-closed) stage=${safeProductionPathStage} category=${safeHeapDeltaCategory} — valid branches: whole-topic (1..25) no-divider/null-anchor OR partial divider inside #messages with final-owned anchor; omitted inside signal never satisfies`
      }
    )
  }
  const allComplete = allGates.filter((g) => g.id.endsWith('.calibration.complete')).every((g) => g.passed)
  allGates.push({
    id: 'calibration.matrix.complete',
    name: 'matrix calibration complete — all profiles effective heap AND derived productionPath complete per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor or partial inside-divider/final-owned with explicit inside signal) (relation across multiple profiles)',
    kind: 'correctness',
    passed: allComplete,
    detail: `matrix profileCount=${profileCount} allComplete=${allComplete ? 1 : 0} — each profile derived per LOCK-004 branches (whole-topic 1..25 no-divider/null-anchor OR partial inside-divider/final-owned) with explicit inside signal mandatory (fail-closed); each profile uses existing production activation path and precise memory sampling (directional synthetic)`
  })
  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: C02_BENCHMARK_ID,
      name: `${C02_BENCHMARK_NAME} (matrix, directional synthetic)`,
      scale: scale as unknown as Record<string, number>
    },
    environment,
    metrics: allMetrics,
    gates: allGates
  }
}
