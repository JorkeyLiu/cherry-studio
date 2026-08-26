/**
 * Phase 5 §5.10 — Pinned working-set / evictable-set / unlimited-context
 * calibration harness — measurement-only, directional, non-adopting.
 *
 * This is **measurement-only test/benchmark support** — no runtime cache
 * retention, eviction, TTL, LRU, admission, heap-capacity policy, window
 * size, channel, SQL, cursor, N/K, closure, or eviction value is selected
 * or adopted per program measurement-only governance. All numbers are
 * **synthetic calibration inputs** for directional evidence only, not
 * thresholds, baselines, or capacity policy. Phase 4/5 remain Open; S6
 * implementation remains Candidate/not authorized until separate
 * authorization per program governance.
 *
 * - Reuses the exact `phase4-logical-payload-v1` canonical frame
 *   (`logicalPayload.ts`) for deterministic logical-byte accounting.
 * - Models an explicit synthetic matrix with **pinned / evictable
 *   partitions** and an **unlimited-context enlargement variant**.
 * - Reports logical bytes where safely measurable; heap/amplification is
 *   measurability-gated (Node lane cannot produce renderer heap evidence
 *   without production/E2E coupling — see coverage limit).
 * - Fails closed on invalid/non-finite data (throws before metric emission).
 *
 * No IPC, preload, shared types, SQLite schema, context-window governance,
 * performance-measurement.md, or architecture.md changes.
 * All code lives under `src/main/services/chatDb/__tests__` (measurement-only).
 */

import {
  aggregateLogicalPayload,
  canonicalizeLogicalPayload,
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION,
  type LogicalPayloadTopicInput
} from '@shared/chatDb/logicalPayload'

import { createSyntheticTopic } from './logicalPayload'

// ---------------------------------------------------------------------------
// Synthetic matrix — directional, non-adopting calibration inputs
// ---------------------------------------------------------------------------

/**
 * Synthetic calibration inputs — directional only, not adopted policy.
 * No concrete payload/channel/SQL/cursor/N/K/window/closure/eviction value
 * is selected or adopted by this harness per program governance.
 */
export const PINNED_WORKING_SET_ACCOUNTING_VERSION = LOGICAL_PAYLOAD_ACCOUNTING_VERSION

export const PINNED_WORKING_SET_MATRIX_IDS = {
  pinned: 'synthetic-pinned-partition-v1',
  evictable: 'synthetic-evictable-partition-v1',
  combinedWorkingSet: 'synthetic-combined-working-set-v1',
  unlimitedContextEnlargement: 'synthetic-unlimited-context-enlargement-v1'
} as const

export interface PinnedWorkingSetPartitionConfig {
  label: string
  topics: number
  messagesPerTopic: number
  blockContentSize: number
  segmentCountPerTopic: number
  generation: number
  topicPrefix: string
}

/**
 * Pinned partition — models the pinned working set (active topic + topics
 * with pending/in-flight requests). Synthetic: 3 topics × 20 msgs × 1024 B,
 * 1 segment per topic. Directional only.
 */
export const PINNED_PARTITION_CONFIG: PinnedWorkingSetPartitionConfig = {
  label: PINNED_WORKING_SET_MATRIX_IDS.pinned,
  topics: 3,
  messagesPerTopic: 20,
  blockContentSize: 1024,
  segmentCountPerTopic: 1,
  generation: 0,
  topicPrefix: 'pws-pinned-topic'
}

/**
 * Evictable partition — models the strictly evictable set (inactive,
 * non-pinned resident projections). Synthetic: 5 topics × 20 msgs × 1024 B,
 * 0 segments per topic to exercise empty-segment marker path. Directional only.
 */
export const EVICTABLE_PARTITION_CONFIG: PinnedWorkingSetPartitionConfig = {
  label: PINNED_WORKING_SET_MATRIX_IDS.evictable,
  topics: 5,
  messagesPerTopic: 20,
  blockContentSize: 1024,
  segmentCountPerTopic: 0,
  generation: 0,
  topicPrefix: 'pws-evictable-topic'
}

/**
 * Unlimited-context enlargement variant — same pinned identity shape but
 * models anchor-to-end closure enlargement (C-02 one-profile/GC-sensitive
 * limit is separate): 3 topics × 120 msgs × 4096 B. Directional only,
 * not an adopted window/closure bound. Demonstrates pinned working-set
 * growth under unlimited context without truncating to evictable caps.
 */
export const UNLIMITED_CONTEXT_CONFIG: PinnedWorkingSetPartitionConfig = {
  label: PINNED_WORKING_SET_MATRIX_IDS.unlimitedContextEnlargement,
  topics: 3,
  messagesPerTopic: 120,
  blockContentSize: 4096,
  segmentCountPerTopic: 0,
  generation: 0,
  topicPrefix: 'pws-unlimited-topic'
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export interface PartitionBuildResult {
  config: PinnedWorkingSetPartitionConfig
  topics: LogicalPayloadTopicInput[]
}

/**
 * Build a deterministic synthetic partition from a config.
 * Throws fail-closed on invalid/non-finite config values.
 */
export function buildPartition(config: PinnedWorkingSetPartitionConfig): PartitionBuildResult {
  validatePartitionConfig(config)
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < config.topics; t++) {
    topics.push(
      createSyntheticTopic({
        topicId: `${config.topicPrefix}-${pad(t, 2)}`,
        messageCount: config.messagesPerTopic,
        blockContentSize: config.blockContentSize,
        segmentCount: config.segmentCountPerTopic,
        generation: config.generation
      })
    )
  }
  // Fail-closed: every topic must canonicalize and byteLength must be finite positive
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i]
    const { byteLength, canonicalJson } = canonicalizeLogicalPayload(topic)
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
      throw new Error(`partition ${config.label}: topic[${i}] byteLength is non-finite/non-positive: ${byteLength}`)
    }
    if (typeof canonicalJson !== 'string' || canonicalJson.length === 0) {
      throw new Error(`partition ${config.label}: topic[${i}] canonicalJson is empty`)
    }
  }
  return { config, topics }
}

export function validatePartitionConfig(config: PinnedWorkingSetPartitionConfig): void {
  const { topics, messagesPerTopic, blockContentSize, segmentCountPerTopic, generation } = config
  const fields: Array<[string, number]> = [
    ['topics', topics],
    ['messagesPerTopic', messagesPerTopic],
    ['blockContentSize', blockContentSize],
    ['segmentCountPerTopic', segmentCountPerTopic],
    ['generation', generation]
  ]
  for (const [name, value] of fields) {
    if (!Number.isFinite(value)) {
      throw new Error(`partition config ${config.label}: ${name} must be finite, got ${String(value)}`)
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`partition config ${config.label}: ${name} must be a non-negative integer, got ${String(value)}`)
    }
  }
  if (topics === 0) {
    throw new Error(`partition config ${config.label}: topics must be >0`)
  }
  if (messagesPerTopic === 0) {
    throw new Error(`partition config ${config.label}: messagesPerTopic must be >0`)
  }
  if (blockContentSize === 0) {
    throw new Error(`partition config ${config.label}: blockContentSize must be >0`)
  }
  if (typeof config.topicPrefix !== 'string' || config.topicPrefix.length === 0) {
    throw new Error(`partition config ${config.label}: topicPrefix must be non-empty string`)
  }
  if (typeof config.label !== 'string' || config.label.length === 0) {
    throw new Error(`partition config label must be non-empty string`)
  }
}

// ---------------------------------------------------------------------------
// Accounting — pinned / evictable / combined / unlimited
// ---------------------------------------------------------------------------

export interface PartitionAccounting {
  label: string
  topicCount: number
  aggregateBytes: number
  perTopic: Array<{ topicId: string; byteLength: number }>
  isFinite: boolean
}

export interface PinnedWorkingSetAccounting {
  pinned: PartitionAccounting
  evictable: PartitionAccounting
  combined: PartitionAccounting
  unlimited: PartitionAccounting
  enlargementRatio: number // unlimited.aggregate / pinned.aggregate (0 when pinned is 0)
  combinedCheck: boolean // combined == pinned + evictable (exact sum verification)
}

function toPartitionAccounting(label: string, topics: LogicalPayloadTopicInput[]): PartitionAccounting {
  const agg = aggregateLogicalPayload(topics)
  // Fail-closed: every per-topic byteLength must be finite positive
  for (const p of agg.perTopic) {
    if (!Number.isFinite(p.byteLength) || p.byteLength <= 0) {
      throw new Error(`accounting ${label}: topic ${p.topicId} byteLength is non-finite/non-positive: ${p.byteLength}`)
    }
  }
  if (!Number.isFinite(agg.aggregateBytes) || agg.aggregateBytes <= 0) {
    throw new Error(`accounting ${label}: aggregateBytes is non-finite/non-positive: ${agg.aggregateBytes}`)
  }
  return {
    label,
    topicCount: agg.topicCount,
    aggregateBytes: agg.aggregateBytes,
    perTopic: agg.perTopic.map((p) => ({ topicId: p.topicId, byteLength: p.byteLength })),
    isFinite: true
  }
}

/**
 * Compute deterministic accounting for the full synthetic matrix.
 * Fails closed on invalid/non-finite data.
 */
export function computePinnedWorkingSetAccounting(): PinnedWorkingSetAccounting {
  const pinnedBuilt = buildPartition(PINNED_PARTITION_CONFIG)
  const evictableBuilt = buildPartition(EVICTABLE_PARTITION_CONFIG)
  const unlimitedBuilt = buildPartition(UNLIMITED_CONTEXT_CONFIG)

  const pinned = toPartitionAccounting(PINNED_WORKING_SET_MATRIX_IDS.pinned, pinnedBuilt.topics)
  const evictable = toPartitionAccounting(PINNED_WORKING_SET_MATRIX_IDS.evictable, evictableBuilt.topics)
  const combinedTopics = [...pinnedBuilt.topics, ...evictableBuilt.topics]
  const combined = toPartitionAccounting(PINNED_WORKING_SET_MATRIX_IDS.combinedWorkingSet, combinedTopics)
  const unlimited = toPartitionAccounting(
    PINNED_WORKING_SET_MATRIX_IDS.unlimitedContextEnlargement,
    unlimitedBuilt.topics
  )

  // Deterministic sum check: combined must equal pinned + evictable (shared entities duplicated, so sum is exact)
  const expectedCombined = pinned.aggregateBytes + evictable.aggregateBytes
  const combinedCheck = combined.aggregateBytes === expectedCombined
  if (!combinedCheck) {
    // This is a correctness failure — the harness must fail closed rather than emit inconsistent accounting
    throw new Error(
      `pinned working-set accounting sum mismatch: pinned(${pinned.aggregateBytes}) + evictable(${evictable.aggregateBytes}) = ${expectedCombined} but combined is ${combined.aggregateBytes}`
    )
  }

  if (
    !Number.isFinite(unlimited.aggregateBytes) ||
    !Number.isFinite(pinned.aggregateBytes) ||
    pinned.aggregateBytes === 0
  ) {
    throw new Error('enlargement ratio requires finite positive pinned bytes')
  }
  const enlargementRatio = unlimited.aggregateBytes / pinned.aggregateBytes
  if (!Number.isFinite(enlargementRatio) || enlargementRatio <= 0) {
    throw new Error(`enlargement ratio is non-finite/non-positive: ${enlargementRatio}`)
  }

  return { pinned, evictable, combined, unlimited, enlargementRatio, combinedCheck }
}

// ---------------------------------------------------------------------------
// Heap / amplification — coverage limit in Node lane
// ---------------------------------------------------------------------------

export interface HeapCoverageLimit {
  measurable: boolean
  reason: string
}

/**
 * In the Node measurement lane, renderer heap amplification cannot be
 * measured without production/E2E coupling (renderer process
 * `performance.memory` with `--enable-precise-memory-info`). The harness
 * therefore reports logical bytes and the unlimited-context enlargement
 * ratio as directional evidence, and explicitly records this coverage
 * limit rather than substituting a Node heap proxy as a renderer claim.
 *
 * Callers that import this helper into an Electron E2E context may
 * sample `performance.memory` there; this Node helper never claims
 * heap measurability.
 */
export function heapAmplificationCoverageLimit(): HeapCoverageLimit {
  return {
    measurable: false,
    reason:
      'renderer heap amplification not safely measurable in Node lane without production/E2E coupling — logical bytes and enlargement ratio are reported; heap/amplification omitted rather than substituting a Node heap proxy (C-02 one-profile/GC-sensitive remains separate)'
  }
}

/**
 * Validate that a numeric metric value is finite (fail-closed).
 */
export function assertFiniteMetricValue(id: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`metric ${id} is non-finite: ${String(value)}`)
  }
}

// ---------------------------------------------------------------------------
// Scale map — numeric-only, schema-v1 compliant (encodes partitions via
// existing benchmark.scale fields, no new top-level artifact fields)
// ---------------------------------------------------------------------------

export interface PinnedWorkingSetScaleMap {
  pinnedTopics: number
  pinnedMessagesPerTopic: number
  pinnedBlockContentBytes: number
  pinnedSegmentCountPerTopic: number
  evictableTopics: number
  evictableMessagesPerTopic: number
  evictableBlockContentBytes: number
  evictableSegmentCountPerTopic: number
  combinedTopics: number
  unlimitedTopics: number
  unlimitedMessagesPerTopic: number
  unlimitedBlockContentBytes: number
  accountingVersionCode: number
  heapMeasurableCode: number
}

export function buildPinnedWorkingSetScaleMap(): Record<string, number> {
  const heapMeasurable = heapAmplificationCoverageLimit().measurable ? 1 : 0
  const scale: Record<string, number> = {
    pinnedTopics: PINNED_PARTITION_CONFIG.topics,
    pinnedMessagesPerTopic: PINNED_PARTITION_CONFIG.messagesPerTopic,
    pinnedBlockContentBytes: PINNED_PARTITION_CONFIG.blockContentSize,
    pinnedSegmentCountPerTopic: PINNED_PARTITION_CONFIG.segmentCountPerTopic,
    evictableTopics: EVICTABLE_PARTITION_CONFIG.topics,
    evictableMessagesPerTopic: EVICTABLE_PARTITION_CONFIG.messagesPerTopic,
    evictableBlockContentBytes: EVICTABLE_PARTITION_CONFIG.blockContentSize,
    evictableSegmentCountPerTopic: EVICTABLE_PARTITION_CONFIG.segmentCountPerTopic,
    combinedTopics: PINNED_PARTITION_CONFIG.topics + EVICTABLE_PARTITION_CONFIG.topics,
    unlimitedTopics: UNLIMITED_CONTEXT_CONFIG.topics,
    unlimitedMessagesPerTopic: UNLIMITED_CONTEXT_CONFIG.messagesPerTopic,
    unlimitedBlockContentBytes: UNLIMITED_CONTEXT_CONFIG.blockContentSize,
    accountingVersionCode: 1,
    heapMeasurableCode: heapMeasurable
  }
  return scale
}

// ---------------------------------------------------------------------------
// Multi-profile matrix — shows relation across multiple deterministic profiles
// ---------------------------------------------------------------------------

export interface PinnedWorkingSetMatrixDefinition {
  id: string
  pinned: PinnedWorkingSetPartitionConfig
  evictable: PinnedWorkingSetPartitionConfig
  unlimited: PinnedWorkingSetPartitionConfig
}

export const PINNED_WORKING_SET_MATRICES: PinnedWorkingSetMatrixDefinition[] = [
  {
    id: 'matrix-standard-v1',
    pinned: PINNED_PARTITION_CONFIG,
    evictable: EVICTABLE_PARTITION_CONFIG,
    unlimited: UNLIMITED_CONTEXT_CONFIG
  },
  {
    id: 'matrix-small-v1',
    pinned: {
      label: 'synthetic-pinned-small-v1',
      topics: 2,
      messagesPerTopic: 10,
      blockContentSize: 512,
      segmentCountPerTopic: 0,
      generation: 0,
      topicPrefix: 'pws-small-pinned-topic'
    },
    evictable: {
      label: 'synthetic-evictable-small-v1',
      topics: 3,
      messagesPerTopic: 10,
      blockContentSize: 512,
      segmentCountPerTopic: 0,
      generation: 0,
      topicPrefix: 'pws-small-evictable-topic'
    },
    unlimited: {
      label: 'synthetic-unlimited-small-v1',
      topics: 2,
      messagesPerTopic: 60,
      blockContentSize: 2048,
      segmentCountPerTopic: 0,
      generation: 0,
      topicPrefix: 'pws-small-unlimited-topic'
    }
  },
  {
    id: 'matrix-large-v1',
    pinned: {
      label: 'synthetic-pinned-large-v1',
      topics: 4,
      messagesPerTopic: 40,
      blockContentSize: 2048,
      segmentCountPerTopic: 1,
      generation: 0,
      topicPrefix: 'pws-large-pinned-topic'
    },
    evictable: {
      label: 'synthetic-evictable-large-v1',
      topics: 6,
      messagesPerTopic: 40,
      blockContentSize: 2048,
      segmentCountPerTopic: 0,
      generation: 0,
      topicPrefix: 'pws-large-evictable-topic'
    },
    unlimited: {
      label: 'synthetic-unlimited-large-v1',
      topics: 4,
      messagesPerTopic: 200,
      blockContentSize: 8192,
      segmentCountPerTopic: 0,
      generation: 0,
      topicPrefix: 'pws-large-unlimited-topic'
    }
  }
]

export function computePinnedWorkingSetAccountingForMatrix(
  matrix: PinnedWorkingSetMatrixDefinition
): PinnedWorkingSetAccounting {
  const pinnedBuilt = buildPartition(matrix.pinned)
  const evictableBuilt = buildPartition(matrix.evictable)
  const unlimitedBuilt = buildPartition(matrix.unlimited)

  const pinned = toPartitionAccounting(matrix.pinned.label, pinnedBuilt.topics)
  const evictable = toPartitionAccounting(matrix.evictable.label, evictableBuilt.topics)
  const combinedTopics = [...pinnedBuilt.topics, ...evictableBuilt.topics]
  const combined = toPartitionAccounting(`${matrix.id}-combined`, combinedTopics)
  const unlimited = toPartitionAccounting(matrix.unlimited.label, unlimitedBuilt.topics)

  const expectedCombined = pinned.aggregateBytes + evictable.aggregateBytes
  const combinedCheck = combined.aggregateBytes === expectedCombined
  if (!combinedCheck) {
    throw new Error(
      `pinned working-set matrix ${matrix.id} sum mismatch: pinned(${pinned.aggregateBytes}) + evictable(${evictable.aggregateBytes}) = ${expectedCombined} but combined is ${combined.aggregateBytes}`
    )
  }
  if (
    !Number.isFinite(unlimited.aggregateBytes) ||
    !Number.isFinite(pinned.aggregateBytes) ||
    pinned.aggregateBytes === 0
  ) {
    throw new Error(`matrix ${matrix.id}: enlargement ratio requires finite positive pinned bytes`)
  }
  const enlargementRatio = unlimited.aggregateBytes / pinned.aggregateBytes
  if (!Number.isFinite(enlargementRatio) || enlargementRatio <= 0) {
    throw new Error(`matrix ${matrix.id}: enlargement ratio is non-finite/non-positive: ${enlargementRatio}`)
  }
  return { pinned, evictable, combined, unlimited, enlargementRatio, combinedCheck }
}

export function computeAllPinnedWorkingSetAccountings(): Array<{
  matrixId: string
  accounting: PinnedWorkingSetAccounting
}> {
  return PINNED_WORKING_SET_MATRICES.map((m) => ({
    matrixId: m.id,
    accounting: computePinnedWorkingSetAccountingForMatrix(m)
  }))
}

export function buildMultiMatrixScaleMap(): Record<string, number> {
  const base = buildPinnedWorkingSetScaleMap()
  const scale: Record<string, number> = { ...base }
  for (const m of PINNED_WORKING_SET_MATRICES) {
    const prefix = m.id.replace(/-/g, '_')
    scale[`${prefix}_pinnedTopics`] = m.pinned.topics
    scale[`${prefix}_evictableTopics`] = m.evictable.topics
    scale[`${prefix}_combinedTopics`] = m.pinned.topics + m.evictable.topics
    scale[`${prefix}_unlimitedTopics`] = m.unlimited.topics
    scale[`${prefix}_pinnedMessagesPerTopic`] = m.pinned.messagesPerTopic
    scale[`${prefix}_unlimitedMessagesPerTopic`] = m.unlimited.messagesPerTopic
  }
  scale['matrixCount'] = PINNED_WORKING_SET_MATRICES.length
  return scale
}
