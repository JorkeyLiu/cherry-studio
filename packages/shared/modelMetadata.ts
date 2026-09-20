import * as z from 'zod'

/**
 * models.dev-backed optional model metadata registry — shared contracts.
 *
 * Product invariants (never relax without a product decision):
 * - This registry is enrichment only. It MUST NEVER gate model admission or
 *   basic requests: user-configured or provider-returned model ids remain
 *   requestable when the network/cache/schema/lookup fails or the id is
 *   mapped/unknown.
 * - Model facts are canonical/standard capabilities from `models.json`,
 *   independent of proxy endpoint restrictions. Model identity never uses the
 *   API URL, `group`, editable `name`, provider brand id, or `owned_by`:
 *   resolution is by canonical model id only (see the matching contract on
 *   `resolveCanonicalModel`).
 * - `models.json` publishes no provider-specific pricing or reasoning
 *   options. Provider-specific `reasoning_options` from `api.json` are kept
 *   as serving metadata under `providers[*].models` and never merged into
 *   canonical `models` facts.
 * - External absent optional fields mean unknown, not false. Required
 *   models.dev booleans normalize to supported/unsupported after validated
 *   parsing.
 * - External data must not be persisted into the existing `llm` Redux slice
 *   or overwrite user model objects. The snapshot below is renderer
 *   memory-only / Main cache-file-only.
 * - Connection (provider-settings) logos keep the separate provider-source
 *   list from `api.json`; model logos use the canonical lab (see below).
 *   Logo safety gates stay fail-closed.
 */

/** Canonical source tag carried on every snapshot. */
export const MODEL_METADATA_SOURCE = 'models.dev' as const

/** Upstream canonical model-facts endpoint owned by the Main ModelMetadataService. */
export const MODEL_METADATA_ENDPOINT = 'https://models.dev/models.json'

/**
 * Upstream provider-source list endpoint. Owned by the Main
 * ModelMetadataService for connection-logo attribution ONLY (normalized
 * `api` base URL + display name per source; no model facts). Model metadata
 * and model logos never read this endpoint.
 */
export const MODEL_METADATA_PROVIDER_SOURCES_ENDPOINT = 'https://models.dev/api.json'

/** Version of the Main on-disk cache envelope (v3 = canonical + provider serving reasoning options). */
export const MODEL_METADATA_CACHE_VERSION = 3

/** Background refresh cadence: no more than once per 24h. */
export const MODEL_METADATA_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Network timeout for a single upstream fetch. */
export const MODEL_METADATA_FETCH_TIMEOUT_MS = 15_000

/**
 * Maximum accepted upstream response size. The live canonical payload is
 * currently well under a megabyte; this leaves generous headroom while
 * bounding memory/disk abuse. Enforced in UTF-8 bytes, never JS string
 * length. Applies per endpoint fetch.
 */
export const MODEL_METADATA_MAX_BYTES = 10 * 1024 * 1024

/**
 * Proportional raw-normalization bounds inside the total byte cap. Live
 * canonical data is ~408 models; every bound below carries several times
 * headroom over that. On excess the offending entry is skipped and a wholly
 * disproportionate payload rejects the snapshot; requests are never blocked
 * either way because the registry never gates.
 */
export interface ModelMetadataNormalizationLimits {
  maxProviders: number
  maxTotalModels: number
  maxModelsPerProvider: number
  maxKeyLength: number
  maxStringLength: number
  maxModalities: number
  maxReasoningOptions: number
  maxEffortValues: number
  maxEffortValueLength: number
}

export const DEFAULT_NORMALIZATION_LIMITS: ModelMetadataNormalizationLimits = {
  maxProviders: 1000,
  maxTotalModels: 20000,
  maxModelsPerProvider: 2000,
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
 * lookup, so upstream data can never confuse the canonical dictionaries.
 */
const UNSAFE_METADATA_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export function isSafeMetadataKey(key: string): boolean {
  return !UNSAFE_METADATA_KEYS.has(key)
}

/** Relative cache file location under the existing userData Cache convention. */
export const MODEL_METADATA_CACHE_REL_PATH = 'model-metadata/models-dev-models.json'

export type ModelMetadataSource = typeof MODEL_METADATA_SOURCE

export interface ModelMetadataModalities {
  input: string[]
  output: string[]
}

export interface ModelMetadataLimits {
  context?: number
  output?: number
  input?: number
}

export interface NormalizedModelMetadata {
  /** Exact canonical model id (the upstream record key, e.g. `moonshotai/kimi-k3`). */
  id: string
  name?: string
  family?: string
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
  limits?: ModelMetadataLimits
}

export interface NormalizedProviderServingModel {
  /** Normalized effort values extracted from `reasoning_options` type `effort`; `max` is mapped to `xhigh`. */
  effort?: string[]
}

export interface NormalizedProviderSource {
  api: string
  name: string
  /** Provider-specific serving models, keyed by exact model id. Never merged into canonical `models`. */
  models?: Record<string, NormalizedProviderServingModel>
}

export interface ModelMetadataSnapshot {
  source: ModelMetadataSource
  /** Epoch ms of the successful upstream fetch that produced this snapshot. */
  fetchedAt: number
  etag?: string
  /** Canonical models keyed by exact canonical id (`lab/name`). */
  models: Record<string, NormalizedModelMetadata>
  /** Provider sources keyed by source id — connection logos only. */
  providers: Record<string, NormalizedProviderSource>
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

const LimitsSchema = z.looseObject({
  context: z.number().optional(),
  output: z.number().optional(),
  input: z.number().optional()
})

const NormalizedModelSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  family: z.string().optional(),
  knowledgeCutoff: z.string().optional(),
  releaseDate: z.string().optional(),
  lastUpdated: z.string().optional(),
  modalities: ModalitiesSchema.default({ input: [], output: [] }),
  attachment: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  temperature: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  limits: LimitsSchema.optional()
})

const NormalizedProviderServingModelSchema = z.looseObject({
  effort: z.array(z.string()).optional()
})

const NormalizedProviderSourceSchema = z.looseObject({
  api: z.string(),
  name: z.string(),
  models: z.record(z.string(), NormalizedProviderServingModelSchema).optional()
})

export const ModelMetadataSnapshotSchema = z.looseObject({
  source: z.literal(MODEL_METADATA_SOURCE),
  fetchedAt: z.number(),
  etag: z.string().optional(),
  models: z.record(z.string(), NormalizedModelSchema),
  providers: z.record(z.string(), NormalizedProviderSourceSchema)
})

export const ModelMetadataCacheEnvelopeSchema = z.looseObject({
  version: z.literal(MODEL_METADATA_CACHE_VERSION),
  fetchedAt: z.number(),
  etag: z.string().optional(),
  snapshot: ModelMetadataSnapshotSchema
})

export type ModelMetadataCacheEnvelope = z.infer<typeof ModelMetadataCacheEnvelopeSchema>

/** Top-level raw endpoint shape: a record of id -> model-ish / source-ish. */
const RawRecordSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// Normalization (raw endpoints -> bounded snapshot parts)
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

function normalizeCanonicalModel(
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
  const knowledgeCutoff = asString(raw['knowledge'], limits.maxStringLength)
  const releaseDate = asString(raw['release_date'], limits.maxStringLength)
  const lastUpdated = asString(raw['last_updated'], limits.maxStringLength)
  if (name !== undefined) model.name = name
  if (family !== undefined) model.family = family
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

  const modelLimits = normalizeLimits(raw['limit'])
  if (modelLimits !== undefined) model.limits = modelLimits

  return model
}

/**
 * Normalize a raw `https://models.dev/models.json` payload (flat canonical
 * id -> model map) into the bounded canonical models record. Returns null
 * when the top level is not a record or when no usable model remains;
 * individually malformed or over-long entries are skipped so one bad entry
 * never poisons the snapshot. `models.json` publishes no pricing or
 * reasoning options, so those fields are never filled here. Optional
 * `limits` override exists for tests.
 */
export function normalizeCanonicalModelsPayload(
  raw: unknown,
  limits: ModelMetadataNormalizationLimits = DEFAULT_NORMALIZATION_LIMITS
): Record<string, NormalizedModelMetadata> | null {
  const parsed = RawRecordSchema.safeParse(raw)
  if (!parsed.success) return null
  const models: Record<string, NormalizedModelMetadata> = {}
  let totalModels = 0
  for (const [key, modelRaw] of Object.entries(parsed.data)) {
    if (!isSafeMetadataKey(key) || key.length === 0 || key.length > limits.maxKeyLength) continue
    const normalized = normalizeCanonicalModel(key, modelRaw, limits)
    if (!normalized) continue
    models[key] = normalized
    totalModels += 1
    if (totalModels > limits.maxTotalModels) return null
  }
  if (Object.keys(models).length === 0) return null
  return models
}

function normalizeReasoningEffortValues(
  value: unknown,
  limits: ModelMetadataNormalizationLimits
): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const eff: string[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (eff.length >= limits.maxReasoningOptions) break
    const type = asString(entry['type'], limits.maxStringLength)
    if (type !== 'effort') continue
    const rawValues = Array.isArray(entry['values']) ? entry['values'] : []
    for (const v of rawValues) {
      if (eff.length >= limits.maxEffortValues) break
      if (typeof v !== 'string' || v.length === 0 || v.length > limits.maxEffortValueLength) continue
      const lower = v.trim().toLowerCase()
      if (!lower) continue
      const mapped = lower === 'max' ? 'xhigh' : lower
      if (seen.has(mapped)) continue
      seen.add(mapped)
      eff.push(mapped)
    }
  }
  return eff.length > 0 ? eff : undefined
}

function normalizeProviderServingModel(
  raw: unknown,
  limits: ModelMetadataNormalizationLimits
): NormalizedProviderServingModel | null {
  if (!isRecord(raw)) return null
  const effort = normalizeReasoningEffortValues(raw['reasoning_options'], limits)
  if (!effort) return null
  return { effort }
}

/**
 * Normalize a raw `https://models.dev/api.json` payload into the provider-source
 * list with optional provider-specific serving metadata. Each source keeps
 * `api` + `name` for connection-logo attribution, and when the upstream
 * publishes `models` with `reasoning_options` type `effort`, those effort
 * values are kept under `providers[*].models` (with `max` mapped to `xhigh`).
 * Provider serving records are never merged into canonical `models`. Returns
 * null when the top level is not a record; an empty record is a usable
 * (if logo-poor) result, never a failure. Optional `limits` override exists
 * for tests.
 */
export function normalizeProviderSourcesPayload(
  raw: unknown,
  limits: ModelMetadataNormalizationLimits = DEFAULT_NORMALIZATION_LIMITS
): Record<string, NormalizedProviderSource> | null {
  const parsed = RawRecordSchema.safeParse(raw)
  if (!parsed.success) return null
  const providers: Record<string, NormalizedProviderSource> = {}
  for (const [sourceId, providerRaw] of Object.entries(parsed.data)) {
    if (!isSafeMetadataKey(sourceId) || sourceId.length === 0 || sourceId.length > limits.maxKeyLength) continue
    if (!isRecord(providerRaw)) continue
    if (Object.keys(providers).length >= limits.maxProviders) return null
    const source: NormalizedProviderSource = {
      api: asString(providerRaw['api'], limits.maxStringLength) ?? '',
      name: asString(providerRaw['name'], limits.maxStringLength) ?? sourceId
    }
    const modelsRaw = providerRaw['models']
    if (isRecord(modelsRaw)) {
      const models: Record<string, NormalizedProviderServingModel> = {}
      let count = 0
      for (const [modelKey, modelRaw] of Object.entries(modelsRaw)) {
        if (!isSafeMetadataKey(modelKey) || modelKey.length === 0 || modelKey.length > limits.maxKeyLength) continue
        if (count >= limits.maxModelsPerProvider) break
        const norm = normalizeProviderServingModel(modelRaw, limits)
        if (!norm) continue
        models[modelKey] = norm
        count += 1
      }
      if (Object.keys(models).length > 0) source.models = models
    }
    providers[sourceId] = source
  }
  return providers
}

/** Defensively parse a snapshot (IPC/cache boundary). Null on any mismatch. */
export function parseModelMetadataSnapshot(data: unknown): ModelMetadataSnapshot | null {
  const parsed = ModelMetadataSnapshotSchema.safeParse(data)
  return parsed.success ? { ...parsed.data, source: MODEL_METADATA_SOURCE } : null
}

/**
 * Defensively parse the Main on-disk cache envelope. Accepts the versioned
 * v3 envelope and (forward-compat) a bare v3 snapshot; null when neither
 * parses. v1 (api.json-shaped) and v2 (no serving models) caches are
 * rejected by the version literal — this is a Main cache format change, not
 * a Redux migration. v2 snapshots are accepted as bare snapshots for
 * forward compat via the loose provider schema (missing `models` stays
 * undefined).
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

// ---------------------------------------------------------------------------
// Provider-specific serving metadata (never merged into canonical)
// ---------------------------------------------------------------------------

/**
 * Resolve provider-specific serving effort values for a model id inside one
 * source. Exact trimmed model-id only (case-sensitive, no basename or
 * case-fold), zero model record -> undefined. Provider-specific records never
 * merge into canonical capabilities.
 */
export function resolveProviderServingEffort(
  sourceId: string | null | undefined,
  modelId: string | undefined | null,
  snapshot: ModelMetadataSnapshot | null | undefined
): string[] | undefined {
  if (!sourceId || !modelId || !snapshot) return undefined
  if (!isSafeMetadataKey(sourceId)) return undefined
  const key = modelId.trim()
  if (!key || !isSafeMetadataKey(key)) return undefined
  const providers = (snapshot as { providers?: unknown }).providers
  if (!providers || typeof providers !== 'object') return undefined
  const source = (providers as Record<string, unknown>)[sourceId]
  if (!source || typeof source !== 'object') return undefined
  const models = (source as { models?: unknown }).models
  if (!models || typeof models !== 'object') return undefined
  const entry = (models as Record<string, unknown>)[key]
  if (!entry || typeof entry !== 'object') return undefined
  const effort = (entry as { effort?: unknown }).effort
  if (!Array.isArray(effort) || effort.length === 0) return undefined
  return effort as string[]
}

// ---------------------------------------------------------------------------
// Canonical matching contract (model identity — no provider attribution)
// ---------------------------------------------------------------------------

/**
 * Canonical model resolution over the `models.json` snapshot.
 *
 * Matching contract (fail closed, in order):
 * - The query is normalized only by trimming. Empty or unsafe queries are
 *   unknown.
 * - Tier 1: exact case-sensitive full canonical model id match.
 * - Tier 2: exact case-sensitive basename (substring after the final `/`)
 *   match, only when exactly one canonical model carries that basename.
 * - Tier 3: case-folded full id or basename match, only when the folded key
 *   identifies exactly one canonical model and creates no ambiguity.
 *
 * Never: stripping route suffixes such as `:thinking`, inferring versions,
 * prefix/partial similarity matching, or selecting the first candidate.
 * Identity never uses the API URL, `group`, editable `name`, provider brand
 * id, or `owned_by` — the caller passes the model id only.
 */
export interface CanonicalModelResolution {
  entry: NormalizedModelMetadata
  /** Exact canonical id (the `models.json` record key). */
  canonicalId: string
  /** Lab prefix (substring before the first `/`) driving model-brand logos. */
  lab: string
}

interface CanonicalModelIndex {
  byId: ReadonlySet<string>
  basenameToIds: ReadonlyMap<string, readonly string[]>
  foldedToIds: ReadonlyMap<string, readonly string[]>
}

function basenameOf(canonicalId: string): string {
  const slash = canonicalId.lastIndexOf('/')
  return slash >= 0 ? canonicalId.slice(slash + 1) : canonicalId
}

function labOf(canonicalId: string): string {
  const slash = canonicalId.indexOf('/')
  return slash > 0 ? canonicalId.slice(0, slash) : ''
}

function buildCanonicalModelIndex(models: Record<string, NormalizedModelMetadata>): CanonicalModelIndex {
  const byId = new Set<string>()
  const basenameToIds = new Map<string, string[]>()
  const foldedToIds = new Map<string, string[]>()
  for (const canonicalId of Object.keys(models)) {
    byId.add(canonicalId)
    const basename = basenameOf(canonicalId)
    const bucket = basenameToIds.get(basename)
    if (bucket) bucket.push(canonicalId)
    else basenameToIds.set(basename, [canonicalId])
    const foldedId = canonicalId.toLowerCase()
    const foldedBucket = foldedToIds.get(foldedId)
    if (foldedBucket) {
      if (!foldedBucket.includes(canonicalId)) foldedBucket.push(canonicalId)
    } else {
      foldedToIds.set(foldedId, [canonicalId])
    }
    const foldedBasename = basename.toLowerCase()
    if (foldedBasename !== foldedId) {
      const foldedBaseBucket = foldedToIds.get(foldedBasename)
      if (foldedBaseBucket) {
        if (!foldedBaseBucket.includes(canonicalId)) foldedBaseBucket.push(canonicalId)
      } else {
        foldedToIds.set(foldedBasename, [canonicalId])
      }
    }
  }
  return { byId, basenameToIds, foldedToIds }
}

/** Index cache: built once per snapshot object, never scanned per render. */
const canonicalIndexCache = new WeakMap<object, CanonicalModelIndex>()

export function getCanonicalModelIndex(snapshot: ModelMetadataSnapshot | null | undefined): CanonicalModelIndex | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const models = (snapshot as { models?: unknown }).models
  if (!models || typeof models !== 'object') return null
  const cached = canonicalIndexCache.get(snapshot)
  if (cached) return cached
  const built = buildCanonicalModelIndex(models as Record<string, NormalizedModelMetadata>)
  canonicalIndexCache.set(snapshot, built)
  return built
}

/**
 * Resolve a user/proxy model id to its canonical entry. Returns undefined
 * for unknown, ambiguous, or malformed queries. Never throws.
 */
export function resolveCanonicalModel(
  query: string | undefined | null,
  snapshot: ModelMetadataSnapshot | null | undefined
): CanonicalModelResolution | undefined {
  if (typeof query !== 'string') return undefined
  const key = query.trim()
  if (!key || !isSafeMetadataKey(key)) return undefined
  if (!snapshot || typeof snapshot !== 'object') return undefined
  const models = snapshot.models
  if (!models || typeof models !== 'object') return undefined

  // Tier 1: exact case-sensitive full canonical id.
  if (isSafeMetadataKey(key)) {
    const exact = (models as Record<string, unknown>)[key]
    if (exact && typeof exact === 'object') {
      return { entry: exact as NormalizedModelMetadata, canonicalId: key, lab: labOf(key) }
    }
  }

  const index = getCanonicalModelIndex(snapshot)
  if (!index) return undefined

  // Tier 2: exact case-sensitive basename, only when unique.
  const basename = basenameOf(key)
  if (basename && isSafeMetadataKey(basename)) {
    const candidates = index.basenameToIds.get(basename)
    if (candidates && candidates.length === 1) {
      const canonicalId = candidates[0]
      const entry = models[canonicalId]
      if (entry && typeof entry === 'object') {
        return { entry, canonicalId, lab: labOf(canonicalId) }
      }
    }
  }

  // Tier 3: case-folded full id or basename, only when unambiguous: the
  // folded full query and the folded basename each identify candidates and
  // their union must be exactly one canonical model.
  const folded = key.toLowerCase()
  if (!folded || !isSafeMetadataKey(folded)) return undefined
  const foldedBasename = basenameOf(key).toLowerCase()
  const foldedCandidates = new Set<string>([
    ...(index.foldedToIds.get(folded) ?? []),
    ...(foldedBasename !== folded ? (index.foldedToIds.get(foldedBasename) ?? []) : [])
  ])
  if (foldedCandidates.size === 1) {
    const canonicalId = [...foldedCandidates][0]
    if (!isSafeMetadataKey(canonicalId)) return undefined
    const entry = models[canonicalId]
    if (entry && typeof entry === 'object') {
      return { entry, canonicalId, lab: labOf(canonicalId) }
    }
  }
  return undefined
}

/**
 * Distinct canonical labs (id prefixes) in a snapshot, for the Main logo
 * admission gate alongside provider source ids. Unsafe entries are excluded;
 * the result never invents a logo key.
 */
export function getCanonicalLabs(snapshot: ModelMetadataSnapshot | null | undefined): string[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const models = snapshot.models
  if (!models || typeof models !== 'object') return []
  const labs = new Set<string>()
  for (const canonicalId of Object.keys(models)) {
    const lab = labOf(canonicalId)
    if (lab && isSafeMetadataKey(lab)) labs.add(lab)
  }
  return [...labs]
}
