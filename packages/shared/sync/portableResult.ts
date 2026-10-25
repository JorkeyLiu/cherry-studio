/**
 * Portable persisted MESSAGE RESULT metadata (single source of truth).
 *
 * Why this module exists
 * ----------------------
 * The renderer's message/block DTOs carry assistant result metadata that is
 * visible business state (`usage` token counts, `metrics` durations, `mentions`
 * display identity, the `useful` multi-model choice, a historical model display
 * snapshot, block `thinking_millsec`, error classification/display, code
 * language and translation identity). Main persists every unknown DTO key as
 * overflow JSON in the `messages.extra` / `message_blocks.extra` columns, so
 * this state survived locally but never crossed the sync wire: capture picked
 * columns only and the receiver wrote `extra: null`.
 *
 * This module owns the ONE declared, sanitized portable result shape plus the
 * extra<->wire mapping so every route (incremental upsert/patch, stable
 * replace, baseline publish/apply, seed/receiver adoption, JSON topic import)
 * can never pick divergent fields.
 *
 * Declared wire container
 * -----------------------
 * Both entities carry exactly one declared wire field, `resultMeta`, converging
 * atomically as ONE clocked field (the same posture as `assistant_config`
 * `settings`): the container is always emitted as full portable state, so a
 * winning container replaces the portable subset exactly and `null` clears it.
 * Omitting it means "no intent" and preserves local state.
 *
 * What is portable (and what is deliberately NOT)
 * -----------------------------------------------
 * Message `resultMeta`: `usage`, `metrics`, `mentions`, `useful`, `model`.
 * Block `resultMeta`: `thinkingMs`, `error`, `language`, `translation`.
 * Block `error` is a SAFE STRUCTURED CLASSIFICATION only: `name`, `code` and
 * `i18nKey` are bounded known-safe identifier tokens, `status`/`statusCode`
 * are bounded integers. Freeform `error.message` is deliberately NOT portable
 * (it can embed a URL, API host, credential or device path): each device keeps
 * its own local raw error text untouched, and the peer renders the structured
 * classification instead. Stack, raw request/response payloads and provider
 * ids never cross either.
 *
 * Never portable, never transmitted, never revived:
 * - any app/provider connection binding: `provider`, `apiHost`, `apiKey`,
 *   `pricing`, credentials, `providerId`, raw provider metadata/responses;
 * - local absolute performance timestamps, `traceId`, removed-domain leftovers
 *   (`enabledMCPs`), `type: 'clear'`, UI-only fold/style keys;
 * - tool/citation block payloads (`rawMcpToolResponse`, `response`,
 *   `knowledge`, tool arguments) — those block types stay unsupported on wire;
 * - `citationReferences` / `knowledgeBaseIds`: their targets (citation blocks,
 *   local knowledge bases) are never synced, so portable ids would dangle;
 * - device-local paths/URLs/attachment internals (`file`, `url`, `filePath`,
 *   `l2AttachmentUnavailable`) — attachment identity stays `assetIds`.
 *
 * JSON-only module (shared by Main and the renderer contract layer).
 */

/** Wire container field name (identical for messages and blocks). */
export const RESULT_META_FIELD = 'resultMeta' as const

/** Portable raw JSON bound for the whole container (defense in depth). */
export const RESULT_META_MAX_JSON_BYTES = 8192

/** Bounds for individual portable values. */
const MAX_SHORT_STRING = 256
const MAX_ID_STRING = 256
const MAX_MENTIONS = 64

/**
 * Persisted `extra` key owned by each portable message field.
 * `model` is the historical display snapshot (never a connection binding).
 */
export const MESSAGE_RESULT_META_EXTRA_KEYS = {
  usage: 'usage',
  metrics: 'metrics',
  mentions: 'mentions',
  useful: 'useful',
  model: 'model'
} as const

/** Persisted `extra` keys owned by each portable block field. */
export const BLOCK_RESULT_META_EXTRA_KEYS = {
  thinkingMs: 'thinking_millsec',
  error: 'error',
  language: 'language',
  translation: ['sourceBlockId', 'sourceLanguage', 'targetLanguage'] as const
} as const

/** Closed set of portable message result keys. */
export const MESSAGE_RESULT_META_KEYS = ['usage', 'metrics', 'mentions', 'useful', 'model'] as const
/** Closed set of portable block result keys. */
export const BLOCK_RESULT_META_KEYS = ['thinkingMs', 'error', 'language', 'translation'] as const

export type MessageResultMetaKey = (typeof MESSAGE_RESULT_META_KEYS)[number]
export type BlockResultMetaKey = (typeof BLOCK_RESULT_META_KEYS)[number]
export type ResultMetaEntityKind = 'message' | 'message_block'

/** Closed nested key sets (recursively whitelisted; unknown keys are dropped). */
const USAGE_KEYS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'thoughts_tokens',
  'cost',
  'prompt_tokens_details',
  'completion_tokens_details'
] as const
const USAGE_DETAIL_KEYS = ['cached_tokens', 'audio_tokens', 'reasoning_tokens'] as const
const METRICS_KEYS = [
  'completion_tokens',
  'time_completion_millsec',
  'time_first_token_millsec',
  'time_thinking_millsec'
] as const
const MODEL_IDENTITY_KEYS = ['id', 'name', 'group'] as const
const ERROR_KEYS = ['name', 'code', 'status', 'statusCode', 'i18nKey'] as const
const TRANSLATION_KEYS = ['sourceBlockId', 'sourceLanguage', 'targetLanguage'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function isValidUnicodeScalarString(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

/** Bounded, scalar-safe display string (no control characters). */
function isDisplayString(value: unknown, max: number): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > max) return false
  if (!isValidUnicodeScalarString(value)) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isCountNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isDurationNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Error identifier bounds (name/code/i18nKey). */
const MAX_ERROR_TOKEN = 128
const MAX_ERROR_TOKEN_SEGMENTS = 4
const MAX_ERROR_TOKEN_SEGMENT = 48
/**
 * Identifier segment: a letter followed by letters/digits/`_`, or a plain
 * numeric code. Deliberately excludes `:` `/` `\\` `@` `%` whitespace, `-`, `+`
 * and `=`, so URL, host, path, query, "Bearer …"/base64url credential and
 * freeform text shapes can never ride a structured error token.
 */
const SAFE_ERROR_TOKEN_SEGMENT = /^[A-Za-z][A-Za-z0-9_]*$/
const SAFE_ERROR_NUMERIC_SEGMENT = /^[0-9]{1,9}$/

/**
 * Bounded, known-safe structured error identifier token: at most 4 identifier
 * segments joined by `.` (so `AI_APICallError`, `E_PROVIDER_UNAVAILABLE`,
 * `429` and `error.network.timeout` are legal). This is a structural boundary,
 * not heuristic redaction: a value that is not an identifier shape is dropped
 * at capture and refused on receive, and freeform error text (which is what can
 * embed a URL/host/path/credential) is never in the portable schema at all.
 */
function isSafeErrorToken(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_ERROR_TOKEN) return false
  if (!isValidUnicodeScalarString(value)) return false
  const segments = value.split('.')
  if (segments.length > MAX_ERROR_TOKEN_SEGMENTS) return false
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_ERROR_TOKEN_SEGMENT) return false
    if (!SAFE_ERROR_TOKEN_SEGMENT.test(segment) && !SAFE_ERROR_NUMERIC_SEGMENT.test(segment)) return false
  }
  return true
}

/** Bounded HTTP-ish status classification. */
function isErrorStatusNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000
}

/** UTF-8 byte length without Node/Electron APIs (JSON-only module). */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

function jsonByteLength(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value) ?? '')
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

// ---------------------------------------------------------------------------
// Sanitizing extraction (local -> wire)
// ---------------------------------------------------------------------------

export interface ResultMetaExtraction {
  /** Portable container, or null when nothing portable is present. */
  meta: Record<string, unknown> | null
  /** Local keys/entries present but dropped because they are not portable. */
  dropped: string[]
}

function sanitizeUsage(raw: unknown): { value: Record<string, unknown> | null; dropped: string[] } {
  if (!isPlainObject(raw)) return { value: null, dropped: ['usage'] }
  const dropped: string[] = []
  const out: Record<string, unknown> = {}
  for (const key of USAGE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (key === 'prompt_tokens_details' || key === 'completion_tokens_details') {
      if (!isPlainObject(value)) {
        dropped.push(`usage.${key}`)
        continue
      }
      const details: Record<string, unknown> = {}
      for (const detailKey of USAGE_DETAIL_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, detailKey)) continue
        const detailValue = value[detailKey]
        if (detailValue === undefined || detailValue === null) continue
        if (!isCountNumber(detailValue)) {
          dropped.push(`usage.${key}.${detailKey}`)
          continue
        }
        details[detailKey] = detailValue
      }
      if (Object.keys(details).length > 0) out[key] = details
      continue
    }
    if (key === 'cost') {
      if (!isDurationNumber(value)) {
        dropped.push('usage.cost')
        continue
      }
      out.cost = value
      continue
    }
    if (!isCountNumber(value)) {
      dropped.push(`usage.${key}`)
      continue
    }
    out[key] = value
  }
  if (Object.keys(out).length === 0) return { value: null, dropped: ['usage'] }
  return { value: out, dropped }
}

function sanitizeMetrics(raw: unknown): { value: Record<string, unknown> | null; dropped: string[] } {
  if (!isPlainObject(raw)) return { value: null, dropped: ['metrics'] }
  const dropped: string[] = []
  const out: Record<string, unknown> = {}
  for (const key of METRICS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (key === 'completion_tokens') {
      if (!isCountNumber(value)) {
        dropped.push(`metrics.${key}`)
        continue
      }
      out[key] = value
      continue
    }
    if (!isDurationNumber(value)) {
      dropped.push(`metrics.${key}`)
      continue
    }
    out[key] = value
  }
  if (Object.keys(out).length === 0) return { value: null, dropped: ['metrics'] }
  return { value: out, dropped }
}

/** Model display identity: id/name/group only — never a connection binding. */
function sanitizeModelIdentity(
  raw: unknown,
  prefix: string
): { value: Record<string, unknown> | null; dropped: string[] } {
  if (!isPlainObject(raw)) return { value: null, dropped: [prefix] }
  const dropped: string[] = []
  const id = raw.id
  if (!isDisplayString(id, MAX_ID_STRING) || id.includes('://') || id.includes('@')) {
    return { value: null, dropped: [prefix] }
  }
  const out: Record<string, unknown> = { id }
  for (const key of ['name', 'group'] as const) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (!isDisplayString(value, MAX_SHORT_STRING)) {
      dropped.push(`${prefix}.${key}`)
      continue
    }
    out[key] = value
  }
  // Non-portable connection/private keys are intentionally dropped.
  for (const key of Object.keys(raw)) {
    if (!(MODEL_IDENTITY_KEYS as readonly string[]).includes(key)) dropped.push(`${prefix}.${key}`)
  }
  return { value: out, dropped }
}

function sanitizeMentions(raw: unknown): { value: unknown[] | null; dropped: string[] } {
  if (!Array.isArray(raw)) return { value: null, dropped: ['mentions'] }
  const out: unknown[] = []
  const dropped: string[] = []
  for (const entry of raw.slice(0, MAX_MENTIONS)) {
    const sanitized = sanitizeModelIdentity(entry, 'mentions[]')
    dropped.push(...sanitized.dropped)
    if (sanitized.value === null) {
      dropped.push('mentions[]')
      continue
    }
    out.push(sanitized.value)
  }
  if (out.length === 0) return { value: null, dropped: ['mentions'] }
  return { value: out, dropped }
}

function sanitizeError(raw: unknown): { value: Record<string, unknown> | null; dropped: string[] } {
  if (!isPlainObject(raw)) return { value: null, dropped: ['error'] }
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const key of ERROR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (key === 'status' || key === 'statusCode') {
      if (!isErrorStatusNumber(value)) {
        dropped.push(`error.${key}`)
        continue
      }
      out[key] = value
      continue
    }
    // A numeric provider code (e.g. 429) is still a bounded identifier.
    if (key === 'code' && isErrorStatusNumber(value)) {
      out[key] = value
      continue
    }
    if (!isSafeErrorToken(value)) {
      dropped.push(`error.${key}`)
      continue
    }
    out[key] = value
  }
  // Local/private error payloads (freeform message, stack, url, request and
  // response bodies/headers, providerId, raw cause/data) never cross the wire.
  // Unsafe values of portable keys are dropped rather than heuristic-redacted:
  // a redacted URL/credential is still an unreliable value to transmit.
  for (const key of Object.keys(raw)) {
    if (!(ERROR_KEYS as readonly string[]).includes(key)) dropped.push(`error.${key}`)
  }
  if (Object.keys(out).length === 0) return { value: null, dropped: [...dropped, 'error'] }
  return { value: out, dropped }
}

function sanitizeTranslation(record: Record<string, unknown>): {
  value: Record<string, unknown> | null
  dropped: string[]
} {
  const dropped: string[] = []
  const out: Record<string, unknown> = {}
  for (const key of TRANSLATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    const value = record[key]
    if (value === undefined || value === null) continue
    const max = key === 'sourceBlockId' ? MAX_ID_STRING : MAX_SHORT_STRING
    if (!isDisplayString(value, max)) {
      dropped.push(`translation.${key}`)
      continue
    }
    out[key] = value
  }
  if (Object.keys(out).length === 0) return { value: null, dropped: ['translation'] }
  return { value: out, dropped }
}

function decodeExtra(extra: unknown): Record<string, unknown> {
  if (typeof extra === 'string') {
    if (extra.length === 0) return {}
    try {
      const parsed: unknown = JSON.parse(extra)
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return isPlainObject(extra) ? extra : {}
}

function finish(meta: Record<string, unknown>, dropped: string[]): ResultMetaExtraction {
  if (Object.keys(meta).length === 0) return { meta: null, dropped }
  if (jsonByteLength(meta) > RESULT_META_MAX_JSON_BYTES) {
    return { meta: null, dropped: [...dropped, 'resultMeta.oversize'] }
  }
  return { meta, dropped }
}

/**
 * Extract the portable result container from persisted message overflow
 * (`messages.extra`). Unknown/private/oversized values are dropped, never
 * widened, never thrown: capture stays best-effort so a cosmetic field can
 * never block a chat write.
 */
export function extractMessageResultMeta(extra: unknown): ResultMetaExtraction {
  const record = decodeExtra(extra)
  const meta: Record<string, unknown> = {}
  const dropped: string[] = []
  const present = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined && record[key] !== null
  if (present('usage')) {
    const usage = sanitizeUsage(record.usage)
    dropped.push(...usage.dropped.filter((entry) => entry !== 'usage'))
    if (usage.value) meta.usage = usage.value
  }
  if (present('metrics')) {
    const metrics = sanitizeMetrics(record.metrics)
    dropped.push(...metrics.dropped.filter((entry) => entry !== 'metrics'))
    if (metrics.value) meta.metrics = metrics.value
  }
  if (present('mentions')) {
    const mentions = sanitizeMentions(record.mentions)
    dropped.push(...mentions.dropped)
    if (mentions.value) meta.mentions = mentions.value
  }
  if (present('useful')) {
    if (typeof record.useful === 'boolean') meta.useful = record.useful
    else dropped.push('useful')
  }
  if (present('model')) {
    const model = sanitizeModelIdentity(record.model, 'model')
    dropped.push(...model.dropped)
    if (model.value) meta.model = model.value
  }
  for (const key of Object.keys(record)) {
    if ((MESSAGE_RESULT_META_KEYS as readonly string[]).includes(key)) continue
    dropped.push(key)
  }
  return finish(meta, dropped)
}

/**
 * Extract the portable result container from persisted block overflow
 * (`message_blocks.extra`). Same best-effort posture as messages.
 */
export function extractBlockResultMeta(extra: unknown): ResultMetaExtraction {
  const record = decodeExtra(extra)
  const meta: Record<string, unknown> = {}
  const dropped: string[] = []
  if (Object.prototype.hasOwnProperty.call(record, 'thinking_millsec') && record.thinking_millsec !== undefined) {
    const value = record.thinking_millsec
    if (value !== null) {
      if (isDurationNumber(value)) meta.thinkingMs = value
      else dropped.push('thinking_millsec')
    }
  }
  if (Object.prototype.hasOwnProperty.call(record, 'error') && record.error !== undefined && record.error !== null) {
    const error = sanitizeError(record.error)
    dropped.push(...error.dropped)
    if (error.value) meta.error = error.value
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'language') &&
    record.language !== undefined &&
    record.language !== null
  ) {
    if (isDisplayString(record.language, MAX_SHORT_STRING)) meta.language = record.language
    else dropped.push('language')
  }
  const translation = sanitizeTranslation(record)
  dropped.push(...translation.dropped.filter((entry) => entry !== 'translation'))
  if (translation.value) meta.translation = translation.value
  const portedKeys = new Set<string>([
    'thinking_millsec',
    'error',
    'language',
    ...(BLOCK_RESULT_META_EXTRA_KEYS.translation as readonly string[])
  ])
  for (const key of Object.keys(record)) {
    if (portedKeys.has(key)) continue
    dropped.push(key)
  }
  return finish(meta, dropped)
}

export function extractResultMeta(kind: ResultMetaEntityKind, extra: unknown): ResultMetaExtraction {
  return kind === 'message' ? extractMessageResultMeta(extra) : extractBlockResultMeta(extra)
}

// ---------------------------------------------------------------------------
// Strict validation (wire -> DB). Returns an error string or null.
// ---------------------------------------------------------------------------

function validateNumberKeys(
  value: unknown,
  allowed: readonly string[],
  path: string,
  check: (entry: unknown) => boolean
): string | null {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return `${path} must be an object or null`
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return `${path} unknown key "${key}"`
    if (!check(value[key])) return `${path}.${key} invalid value`
  }
  return null
}

function validateModelIdentity(value: unknown, path: string, opts?: { allowNull?: boolean }): string | null {
  if (value === null) return opts?.allowNull === true ? null : `${path} must be an object`
  if (!isPlainObject(value)) return `${path} must be an object`
  for (const key of Object.keys(value)) {
    if (!(MODEL_IDENTITY_KEYS as readonly string[]).includes(key)) return `${path} unknown key "${key}"`
  }
  const id = value.id
  if (!isDisplayString(id, MAX_ID_STRING) || id.includes('://') || id.includes('@')) return `${path}.id invalid`
  for (const key of ['name', 'group'] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (!isDisplayString(value[key], MAX_SHORT_STRING)) return `${path}.${key} invalid`
  }
  return null
}

function validateUsage(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) return `${path} must be an object or null`
  for (const key of Object.keys(value)) {
    if (!(USAGE_KEYS as readonly string[]).includes(key)) return `${path} unknown key "${key}"`
  }
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'thoughts_tokens'] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (!isCountNumber(value[key])) return `${path}.${key} invalid`
  }
  if (Object.prototype.hasOwnProperty.call(value, 'cost') && !isDurationNumber(value.cost)) {
    return `${path}.cost invalid`
  }
  for (const key of ['prompt_tokens_details', 'completion_tokens_details'] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const err = validateNumberKeys(value[key], USAGE_DETAIL_KEYS, `${path}.${key}`, isCountNumber)
    if (err) return err
  }
  return null
}

/** Strict wire/DB validation for one portable message container. */
export function validateMessageResultMeta(value: unknown, path: string = RESULT_META_FIELD): string | null {
  if (value === null) return null
  if (!isPlainObject(value)) return `${path} must be an object or null`
  for (const key of Object.keys(value)) {
    if (!(MESSAGE_RESULT_META_KEYS as readonly string[]).includes(key)) return `${path} unknown key "${key}"`
  }
  const usageErr = validateUsage(value.usage, `${path}.usage`)
  if (usageErr) return usageErr
  if (Object.prototype.hasOwnProperty.call(value, 'metrics')) {
    const metricsErr = validateNumberKeys(value.metrics, METRICS_KEYS, `${path}.metrics`, isDurationNumber)
    if (metricsErr) return metricsErr
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mentions') && value.mentions !== null) {
    const mentions = value.mentions
    if (!Array.isArray(mentions)) return `${path}.mentions must be an array or null`
    if (mentions.length > MAX_MENTIONS) return `${path}.mentions too many entries`
    const seen = new Set<string>()
    for (let i = 0; i < mentions.length; i++) {
      // A mention is a display identity entry, never nullable: reject a
      // malformed/null entry with a structured error instead of dereferencing
      // it (the wire could otherwise carry `null` inside `mentions`).
      const entry: unknown = mentions[i]
      if (entry === null || entry === undefined) return `${path}.mentions[${i}] must be an object`
      const err = validateModelIdentity(entry, `${path}.mentions[${i}]`)
      if (err) return err
      const id = (entry as Record<string, unknown>).id as string
      if (seen.has(id)) return `${path}.mentions duplicate id`
      seen.add(id)
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'useful') &&
    value.useful !== null &&
    typeof value.useful !== 'boolean'
  ) {
    return `${path}.useful must be a boolean or null`
  }
  if (Object.prototype.hasOwnProperty.call(value, 'model')) {
    // `model` stays legitimately nullable (model really unknown) — only the
    // mentions array entry form is non-nullable.
    const err = validateModelIdentity(value.model, `${path}.model`, { allowNull: true })
    if (err) return err
  }
  if (jsonByteLength(value) > RESULT_META_MAX_JSON_BYTES) return `${path} exceeds size bound`
  return null
}

/** Strict wire/DB validation for one portable block container. */
export function validateBlockResultMeta(value: unknown, path: string = RESULT_META_FIELD): string | null {
  if (value === null) return null
  if (!isPlainObject(value)) return `${path} must be an object or null`
  for (const key of Object.keys(value)) {
    if (!(BLOCK_RESULT_META_KEYS as readonly string[]).includes(key)) return `${path} unknown key "${key}"`
  }
  if (Object.prototype.hasOwnProperty.call(value, 'thinkingMs')) {
    const thinkingMs = value.thinkingMs
    if (thinkingMs !== null && !isDurationNumber(thinkingMs)) return `${path}.thinkingMs invalid`
  }
  if (Object.prototype.hasOwnProperty.call(value, 'error') && value.error !== null) {
    const error = value.error
    if (!isPlainObject(error)) return `${path}.error must be an object or null`
    for (const key of Object.keys(error)) {
      if (!(ERROR_KEYS as readonly string[]).includes(key)) return `${path}.error unknown key "${key}"`
    }
    if (Object.keys(error).length === 0) return `${path}.error must not be empty`
    for (const key of ['name', 'i18nKey'] as const) {
      if (!Object.prototype.hasOwnProperty.call(error, key)) continue
      if (!isSafeErrorToken(error[key])) return `${path}.error.${key} invalid`
    }
    if (Object.prototype.hasOwnProperty.call(error, 'code')) {
      const code = error.code
      if (!isSafeErrorToken(code) && !isErrorStatusNumber(code)) return `${path}.error.code invalid`
    }
    for (const key of ['status', 'statusCode'] as const) {
      if (!Object.prototype.hasOwnProperty.call(error, key)) continue
      if (!isErrorStatusNumber(error[key])) return `${path}.error.${key} invalid`
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'language') &&
    value.language !== null &&
    !isDisplayString(value.language, MAX_SHORT_STRING)
  ) {
    return `${path}.language invalid`
  }
  if (Object.prototype.hasOwnProperty.call(value, 'translation') && value.translation !== null) {
    const translation = value.translation
    if (!isPlainObject(translation)) return `${path}.translation must be an object or null`
    if (Object.keys(translation).length === 0) return `${path}.translation must not be empty`
    for (const key of Object.keys(translation)) {
      if (!(TRANSLATION_KEYS as readonly string[]).includes(key)) {
        return `${path}.translation unknown key "${key}"`
      }
    }
    for (const key of TRANSLATION_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(translation, key)) continue
      const max = key === 'sourceBlockId' ? MAX_ID_STRING : MAX_SHORT_STRING
      if (!isDisplayString(translation[key], max)) return `${path}.translation.${key} invalid`
    }
  }
  if (jsonByteLength(value) > RESULT_META_MAX_JSON_BYTES) return `${path} exceeds size bound`
  return null
}

export function validateResultMeta(
  kind: ResultMetaEntityKind,
  value: unknown,
  path: string = RESULT_META_FIELD
): string | null {
  return kind === 'message' ? validateMessageResultMeta(value, path) : validateBlockResultMeta(value, path)
}

// ---------------------------------------------------------------------------
// DB application (wire -> extra), preserving unrelated local-only keys
// ---------------------------------------------------------------------------

function applyMessageMeta(
  extra: Record<string, unknown>,
  meta: Record<string, unknown> | null
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...extra }
  const assign = (key: string, present: boolean, value: unknown): void => {
    if (present) next[key] = value
    else delete next[key]
  }
  const has = (key: string): boolean => meta !== null && Object.prototype.hasOwnProperty.call(meta, key)
  assign('usage', has('usage'), meta?.usage)
  assign('metrics', has('metrics'), meta?.metrics)
  assign('mentions', has('mentions'), meta?.mentions)
  assign('useful', has('useful'), meta?.useful)
  assign('model', has('model'), meta?.model)
  return next
}

function applyBlockMeta(extra: Record<string, unknown>, meta: Record<string, unknown> | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...extra }
  const has = (key: string): boolean => meta !== null && Object.prototype.hasOwnProperty.call(meta, key)
  if (has('thinkingMs')) next[BLOCK_RESULT_META_EXTRA_KEYS.thinkingMs] = meta?.thinkingMs
  else delete next[BLOCK_RESULT_META_EXTRA_KEYS.thinkingMs]
  if (has('error')) next[BLOCK_RESULT_META_EXTRA_KEYS.error] = meta?.error
  else delete next[BLOCK_RESULT_META_EXTRA_KEYS.error]
  if (has('language')) next[BLOCK_RESULT_META_EXTRA_KEYS.language] = meta?.language
  else delete next[BLOCK_RESULT_META_EXTRA_KEYS.language]
  const translation = has('translation') ? (meta?.translation as Record<string, unknown> | null) : null
  for (const key of BLOCK_RESULT_META_EXTRA_KEYS.translation) {
    if (translation && Object.prototype.hasOwnProperty.call(translation, key)) next[key] = translation[key]
    else delete next[key]
  }
  return next
}

/**
 * Merge a winning portable container into the local overflow object.
 * Atomic container semantics: every portable key becomes exactly what the
 * container declares; `null` removes all portable keys. Unrelated local-only
 * overflow keys (traceId, providerMetadata, tool payloads, …) are preserved
 * untouched.
 */
export function mergeResultMetaIntoExtra(
  kind: ResultMetaEntityKind,
  extra: unknown,
  meta: Record<string, unknown> | null
): Record<string, unknown> {
  const base = isPlainObject(extra) ? extra : decodeExtra(extra)
  return kind === 'message' ? applyMessageMeta(base, meta) : applyBlockMeta(base, meta)
}

/** Serialize overflow for the DB `extra` column (null when empty). */
export function encodeExtra(extra: Record<string, unknown> | null | undefined): string | null {
  if (!extra) return null
  return Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
}

/**
 * Local comparison value for the portable container of a persisted row, used
 * by field-clock contest/equality decisions so the container compares as one
 * value exactly as it converges.
 */
export function localResultMetaValue(kind: ResultMetaEntityKind, extra: unknown): Record<string, unknown> | null {
  return extractResultMeta(kind, extra).meta
}
