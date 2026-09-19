import * as z from 'zod'

/**
 * models.dev-backed optional model metadata registry — shared contracts.
 *
 * Product invariants (never relax without a product decision):
 * - This registry is enrichment only. It MUST NEVER gate model admission or
 *   basic requests: user-configured or provider-returned model ids remain
 *   requestable when the network/cache/schema/lookup fails or the id is
 *   mapped/unknown.
 * - Exact provider/model matching only: no fuzzy names, lowercasing, suffix
 *   stripping, aliases, or global first-match.
 * - External absent optional fields mean unknown, not false. Required
 *   models.dev booleans normalize to supported/unsupported after validated
 *   parsing.
 * - External data must not be persisted into the existing `llm` Redux slice
 *   or overwrite user model objects. The snapshot below is renderer
 *   memory-only / Main cache-file-only.
 */

/** Canonical source tag carried on every snapshot. */
export const MODEL_METADATA_SOURCE = 'models.dev' as const

/** Upstream endpoint owned by the Main ModelMetadataService. */
export const MODEL_METADATA_ENDPOINT = 'https://models.dev/api.json'

/** Version of the Main on-disk cache envelope. */
export const MODEL_METADATA_CACHE_VERSION = 1

/** Background refresh cadence: no more than once per 24h. */
export const MODEL_METADATA_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Network timeout for a single upstream fetch. */
export const MODEL_METADATA_FETCH_TIMEOUT_MS = 15_000

/**
 * Maximum accepted upstream response size. The live payload is currently
 * ~4.7MiB; this leaves generous headroom while bounding memory/disk abuse.
 * Enforced in UTF-8 bytes, never JS string length.
 */
export const MODEL_METADATA_MAX_BYTES = 10 * 1024 * 1024

/**
 * Proportional raw-normalization bounds inside the total byte cap. Live data
 * is ~220 providers / ~7842 models; every bound below carries several times
 * headroom over that. On excess the offending entry is skipped (or narrowed
 * by truncation) and a wholly disproportionate payload rejects the snapshot;
 * requests are never blocked either way because the registry never gates.
 */
export interface ModelMetadataNormalizationLimits {
  maxProviders: number
  maxModelsPerProvider: number
  maxTotalModels: number
  maxKeyLength: number
  maxStringLength: number
  maxModalities: number
  maxReasoningOptions: number
  maxEffortValues: number
  maxEffortValueLength: number
}

export const DEFAULT_NORMALIZATION_LIMITS: ModelMetadataNormalizationLimits = {
  maxProviders: 1000,
  maxModelsPerProvider: 2000,
  maxTotalModels: 20000,
  maxKeyLength: 256,
  maxStringLength: 1024,
  maxModalities: 32,
  maxReasoningOptions: 16,
  maxEffortValues: 32,
  maxEffortValueLength: 64
}

/**
 * Dictionary keys that must never be assigned through computed indexing:
 * `obj['__proto__'] = value` mutates the prototype instead of creating an
 * own property. Such keys are skipped during normalization and rejected at
 * lookup, so upstream data can never confuse provider/model dictionaries.
 */
const UNSAFE_METADATA_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export function isSafeMetadataKey(key: string): boolean {
  return !UNSAFE_METADATA_KEYS.has(key)
}

/** Relative cache file location under the existing userData Cache convention. */
export const MODEL_METADATA_CACHE_REL_PATH = 'model-metadata/models-dev.json'

export type ModelMetadataSource = typeof MODEL_METADATA_SOURCE

export interface ModelMetadataModalities {
  input: string[]
  output: string[]
}

export interface ModelMetadataReasoningControls {
  /** The model exposes an on/off (or auto) reasoning toggle. */
  toggle?: boolean
  /** Named effort levels, as published (e.g. low/medium/high/max). */
  effort?: string[]
  /** The model accepts a thinking-budget control. */
  budget?: boolean
}

export interface ModelMetadataLimits {
  context?: number
  output?: number
  input?: number
}

export interface ModelMetadataPricing {
  /** USD per million tokens, as published. */
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  inputAudio?: number
  outputAudio?: number
  contextOver200k?: number
  /** Tiered pricing exists upstream; exact tiers are intentionally not modeled. */
  hasTiers?: boolean
}

export interface NormalizedModelMetadata {
  /** Exact model id (the upstream record key). */
  id: string
  name?: string
  family?: string
  status?: string
  knowledgeCutoff?: string
  releaseDate?: string
  lastUpdated?: string
  modalities: ModelMetadataModalities
  /** Tri-state throughout: true/false known, undefined unknown. */
  attachment?: boolean
  toolCall?: boolean
  structuredOutput?: boolean
  temperature?: boolean
  reasoning?: boolean
  reasoningControls?: ModelMetadataReasoningControls
  limits?: ModelMetadataLimits
  pricing?: ModelMetadataPricing
}

export interface NormalizedProviderMetadata {
  /** Normalized upstream `api` base URL (empty when the source publishes none). */
  api: string
  name: string
  /** Models keyed by exact id — lookup is exact trimmed-id only. */
  models: Record<string, NormalizedModelMetadata>
}

export interface ModelMetadataSnapshot {
  source: ModelMetadataSource
  /** Epoch ms of the successful upstream fetch that produced this snapshot. */
  fetchedAt: number
  etag?: string
  /** Providers keyed by source provider id (e.g. `anthropic`, `openai`, `google`). */
  providers: Record<string, NormalizedProviderMetadata>
}

export type ModelMetadataRefreshReason =
  | 'http-error'
  | 'not-modified'
  | 'unexpected-content-type'
  | 'response-too-large'
  | 'invalid-json'
  | 'schema-mismatch'
  | 'network-error'
  | 'timeout'
  | 'fresh-cache'

export interface ModelMetadataRefreshResult {
  ok: boolean
  fetchedAt?: number
  notModified?: boolean
  reason?: ModelMetadataRefreshReason
}

/**
 * Reactive models.dev registry status shared across Main/preload/renderer.
 *
 * - `loading`: no snapshot yet and a read/fetch is still in progress.
 * - `ready`: a snapshot is available; a failed background refresh stays ready.
 * - `unavailable`: no snapshot and the read/fetch round completed with a
 *   failure. `reason` is always a sanitized `ModelMetadataRefreshReason`
 *   (status/reason only — never bodies or file paths).
 */
export type ModelMetadataStatusKind = 'loading' | 'ready' | 'unavailable'

export interface ModelMetadataStatus {
  kind: ModelMetadataStatusKind
  /** Stable last-known-good snapshot; null until the first success. */
  snapshot: ModelMetadataSnapshot | null
  /** Present only when `kind` is `unavailable`. */
  reason?: ModelMetadataRefreshReason
}

const MODEL_METADATA_FAILURE_REASONS: ReadonlySet<string> = new Set<string>([
  'http-error',
  'unexpected-content-type',
  'response-too-large',
  'invalid-json',
  'schema-mismatch',
  'network-error',
  'timeout'
])

/** Keep only sanitized failure reasons at the status boundary. */
export function asSafeMetadataFailureReason(reason: unknown): ModelMetadataRefreshReason | undefined {
  return typeof reason === 'string' && MODEL_METADATA_FAILURE_REASONS.has(reason)
    ? (reason as ModelMetadataRefreshReason)
    : undefined
}

/**
 * Pure status-machine helper: snapshot wins (ready, refresh failures
 * included), otherwise an in-flight round means loading, otherwise a
 * completed failure means unavailable with its safe reason.
 */
export function toModelMetadataStatus(args: {
  snapshot: ModelMetadataSnapshot | null
  inFlight: boolean
  failureReason?: ModelMetadataRefreshReason
}): ModelMetadataStatus {
  if (args.snapshot) return { kind: 'ready', snapshot: args.snapshot }
  if (args.inFlight) return { kind: 'loading', snapshot: null }
  const reason = asSafeMetadataFailureReason(args.failureReason)
  if (reason) return { kind: 'unavailable', snapshot: null, reason }
  return { kind: 'loading', snapshot: null }
}

/** Defensively parse a status crossing the IPC boundary. Null on mismatch. */
export function parseModelMetadataStatus(data: unknown): ModelMetadataStatus | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  const kind = record['kind']
  if (kind !== 'loading' && kind !== 'ready' && kind !== 'unavailable') return null
  const rawSnapshot = record['snapshot']
  const snapshot = rawSnapshot === null || rawSnapshot === undefined ? null : parseModelMetadataSnapshot(rawSnapshot)
  if (snapshot === null && rawSnapshot !== null && rawSnapshot !== undefined) return null
  if (kind === 'ready' && !snapshot) return null
  if (kind === 'unavailable') {
    const reason = asSafeMetadataFailureReason(record['reason'])
    if (!reason) return null
    return { kind, snapshot: null, reason }
  }
  return { kind, snapshot }
}

// ---------------------------------------------------------------------------
// Defensive zod validation
// ---------------------------------------------------------------------------

const ModalitiesSchema = z.looseObject({
  input: z.array(z.string()).default([]),
  output: z.array(z.string()).default([])
})

const ReasoningControlsSchema = z.looseObject({
  toggle: z.boolean().optional(),
  effort: z.array(z.string()).optional(),
  budget: z.boolean().optional()
})

const LimitsSchema = z.looseObject({
  context: z.number().optional(),
  output: z.number().optional(),
  input: z.number().optional()
})

const PricingSchema = z.looseObject({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  reasoning: z.number().optional(),
  inputAudio: z.number().optional(),
  outputAudio: z.number().optional(),
  contextOver200k: z.number().optional(),
  hasTiers: z.boolean().optional()
})

const NormalizedModelSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  family: z.string().optional(),
  status: z.string().optional(),
  knowledgeCutoff: z.string().optional(),
  releaseDate: z.string().optional(),
  lastUpdated: z.string().optional(),
  modalities: ModalitiesSchema.default({ input: [], output: [] }),
  attachment: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  temperature: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoningControls: ReasoningControlsSchema.optional(),
  limits: LimitsSchema.optional(),
  pricing: PricingSchema.optional()
})

const NormalizedProviderSchema = z.looseObject({
  api: z.string(),
  name: z.string(),
  models: z.record(z.string(), NormalizedModelSchema)
})

export const ModelMetadataSnapshotSchema = z.looseObject({
  source: z.literal(MODEL_METADATA_SOURCE),
  fetchedAt: z.number(),
  etag: z.string().optional(),
  providers: z.record(z.string(), NormalizedProviderSchema)
})

export const ModelMetadataCacheEnvelopeSchema = z.looseObject({
  version: z.literal(MODEL_METADATA_CACHE_VERSION),
  fetchedAt: z.number(),
  etag: z.string().optional(),
  snapshot: ModelMetadataSnapshotSchema
})

export type ModelMetadataCacheEnvelope = z.infer<typeof ModelMetadataCacheEnvelopeSchema>

/** Top-level raw endpoint shape: a record of source-id -> provider-ish. */
const RawProvidersSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// Normalization (raw endpoint -> bounded snapshot)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
}

/** Validated boolean parsing: non-boolean (including absent) stays unknown. */
function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asLowerStringArray(value: unknown, limits: ModelMetadataNormalizationLimits): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (out.length >= limits.maxModalities) break
    if (typeof entry === 'string' && entry.trim().length > 0 && entry.length <= limits.maxStringLength) {
      out.push(entry.trim().toLowerCase())
    }
  }
  return out
}

function normalizeReasoningControls(
  value: unknown,
  limits: ModelMetadataNormalizationLimits
): ModelMetadataReasoningControls | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const controls: ModelMetadataReasoningControls = {}
  let seen = 0
  for (const entry of value) {
    if (seen >= limits.maxReasoningOptions) break
    if (!isRecord(entry)) continue
    seen += 1
    const type = asString(entry['type'], limits.maxStringLength)
    if (type === 'toggle') {
      controls.toggle = true
    } else if (type === 'budget_tokens') {
      controls.budget = true
    } else if (type === 'effort') {
      const values = Array.isArray(entry['values']) ? entry['values'] : []
      const picked: string[] = []
      for (const v of values) {
        if (picked.length >= limits.maxEffortValues) break
        if (typeof v === 'string' && v.length > 0 && v.length <= limits.maxEffortValueLength) {
          picked.push(v)
        }
      }
      if (picked.length > 0) {
        controls.effort = [...(controls.effort ?? []), ...picked]
      }
    }
  }
  return controls.toggle !== undefined || controls.budget !== undefined || controls.effort !== undefined
    ? controls
    : undefined
}

function normalizeLimits(value: unknown): ModelMetadataLimits | undefined {
  if (!isRecord(value)) return undefined
  const limits: ModelMetadataLimits = {}
  const context = asFiniteNumber(value['context'])
  const output = asFiniteNumber(value['output'])
  const input = asFiniteNumber(value['input'])
  if (context !== undefined) limits.context = context
  if (output !== undefined) limits.output = output
  if (input !== undefined) limits.input = input
  return Object.keys(limits).length > 0 ? limits : undefined
}

function normalizePricing(value: unknown): ModelMetadataPricing | undefined {
  if (!isRecord(value)) return undefined
  const pricing: ModelMetadataPricing = {}
  const input = asFiniteNumber(value['input'])
  const output = asFiniteNumber(value['output'])
  const cacheRead = asFiniteNumber(value['cache_read'])
  const cacheWrite = asFiniteNumber(value['cache_write'])
  const reasoning = asFiniteNumber(value['reasoning'])
  const inputAudio = asFiniteNumber(value['input_audio'])
  const outputAudio = asFiniteNumber(value['output_audio'])
  const contextOver200k = asFiniteNumber(value['context_over_200k'])
  if (input !== undefined) pricing.input = input
  if (output !== undefined) pricing.output = output
  if (cacheRead !== undefined) pricing.cacheRead = cacheRead
  if (cacheWrite !== undefined) pricing.cacheWrite = cacheWrite
  if (reasoning !== undefined) pricing.reasoning = reasoning
  if (inputAudio !== undefined) pricing.inputAudio = inputAudio
  if (outputAudio !== undefined) pricing.outputAudio = outputAudio
  if (contextOver200k !== undefined) pricing.contextOver200k = contextOver200k
  if (value['tiers'] !== undefined) pricing.hasTiers = true
  return Object.keys(pricing).length > 0 ? pricing : undefined
}

function normalizeModel(
  key: string,
  raw: unknown,
  limits: ModelMetadataNormalizationLimits
): NormalizedModelMetadata | null {
  if (!isRecord(raw)) return null
  const modalities = isRecord(raw['modalities'])
    ? {
        input: asLowerStringArray(raw['modalities']['input'], limits),
        output: asLowerStringArray(raw['modalities']['output'], limits)
      }
    : { input: [], output: [] }
  const model: NormalizedModelMetadata = { id: key, modalities }

  const name = asString(raw['name'], limits.maxStringLength)
  const family = asString(raw['family'], limits.maxStringLength)
  const status = asString(raw['status'], limits.maxStringLength)
  const knowledgeCutoff = asString(raw['knowledge'], limits.maxStringLength)
  const releaseDate = asString(raw['release_date'], limits.maxStringLength)
  const lastUpdated = asString(raw['last_updated'], limits.maxStringLength)
  if (name !== undefined) model.name = name
  if (family !== undefined) model.family = family
  if (status !== undefined) model.status = status
  if (knowledgeCutoff !== undefined) model.knowledgeCutoff = knowledgeCutoff
  if (releaseDate !== undefined) model.releaseDate = releaseDate
  if (lastUpdated !== undefined) model.lastUpdated = lastUpdated

  // Required upstream booleans normalize to supported/unsupported only after
  // validated boolean parsing; absent/non-boolean stays unknown (undefined).
  const attachment = asBool(raw['attachment'])
  const toolCall = asBool(raw['tool_call'])
  const structuredOutput = asBool(raw['structured_output'])
  const temperature = asBool(raw['temperature'])
  const reasoning = asBool(raw['reasoning'])
  if (attachment !== undefined) model.attachment = attachment
  if (toolCall !== undefined) model.toolCall = toolCall
  if (structuredOutput !== undefined) model.structuredOutput = structuredOutput
  if (temperature !== undefined) model.temperature = temperature
  if (reasoning !== undefined) model.reasoning = reasoning

  const reasoningControls = normalizeReasoningControls(raw['reasoning_options'], limits)
  if (reasoningControls !== undefined) model.reasoningControls = reasoningControls

  const modelLimits = normalizeLimits(raw['limit'])
  if (modelLimits !== undefined) model.limits = modelLimits

  const pricing = normalizePricing(raw['cost'])
  if (pricing !== undefined) model.pricing = pricing

  return model
}

/**
 * Normalize a raw `https://models.dev/api.json` payload into the bounded
 * renderer-safe snapshot. Returns null when the top level is not a provider
 * record, when provider/total-model counts exceed their bounds, or when no
 * usable provider remains; individually malformed or over-long entries are
 * skipped (per-provider models truncate at their bound) so one bad entry
 * never poisons the snapshot. Optional `limits` override exists for tests.
 */
export function normalizeModelMetadataPayload(
  raw: unknown,
  fetchedAt: number,
  etag?: string,
  limits: ModelMetadataNormalizationLimits = DEFAULT_NORMALIZATION_LIMITS
): ModelMetadataSnapshot | null {
  const parsed = RawProvidersSchema.safeParse(raw)
  if (!parsed.success) return null
  const providers: Record<string, NormalizedProviderMetadata> = {}
  let totalModels = 0
  for (const [sourceId, providerRaw] of Object.entries(parsed.data)) {
    if (!isSafeMetadataKey(sourceId) || sourceId.length === 0 || sourceId.length > limits.maxKeyLength) continue
    if (!isRecord(providerRaw)) continue
    if (Object.keys(providers).length >= limits.maxProviders) return null
    const modelsRaw = providerRaw['models']
    if (!isRecord(modelsRaw)) continue
    const models: Record<string, NormalizedModelMetadata> = {}
    let kept = 0
    for (const [key, modelRaw] of Object.entries(modelsRaw)) {
      if (kept >= limits.maxModelsPerProvider) break
      if (!isSafeMetadataKey(key) || key.length === 0 || key.length > limits.maxKeyLength) continue
      const normalized = normalizeModel(key, modelRaw, limits)
      if (!normalized) continue
      models[key] = normalized
      kept += 1
      totalModels += 1
      if (totalModels > limits.maxTotalModels) return null
    }
    providers[sourceId] = {
      api: asString(providerRaw['api'], limits.maxStringLength) ?? '',
      name: asString(providerRaw['name'], limits.maxStringLength) ?? sourceId,
      models
    }
  }
  if (Object.keys(providers).length === 0) return null
  const snapshot: ModelMetadataSnapshot = { source: MODEL_METADATA_SOURCE, fetchedAt, providers }
  if (etag !== undefined) snapshot.etag = etag
  return snapshot
}

/** Defensively parse a snapshot (IPC/cache boundary). Null on any mismatch. */
export function parseModelMetadataSnapshot(data: unknown): ModelMetadataSnapshot | null {
  const parsed = ModelMetadataSnapshotSchema.safeParse(data)
  return parsed.success ? { ...parsed.data, source: MODEL_METADATA_SOURCE } : null
}

/**
 * Defensively parse the Main on-disk cache envelope. Accepts the versioned
 * envelope and (forward-compat) a bare snapshot; null when neither parses.
 */
export function parseModelMetadataCache(data: unknown): { snapshot: ModelMetadataSnapshot; etag?: string } | null {
  const envelope = ModelMetadataCacheEnvelopeSchema.safeParse(data)
  if (envelope.success) {
    return {
      snapshot: { ...envelope.data.snapshot, source: MODEL_METADATA_SOURCE },
      etag: envelope.data.etag ?? envelope.data.snapshot.etag
    }
  }
  const snapshot = parseModelMetadataSnapshot(data)
  return snapshot ? { snapshot, etag: snapshot.etag } : null
}
