/**
 * Generic Anthropic thinking-format learning (enabled <-> adaptive).
 *
 * Model-name orthogonal: no brand/family/version predicate participates here.
 * Prepare-params keeps emitting its legacy default shape (4.6/4.7 adaptive,
 * everything else enabled); this module only reacts to an explicit
 * thinking-type HTTP400 rejection, retries the same logical request once with
 * the alternate shape, and — only after that alternate request succeeds —
 * remembers the learned dialect for the exact connection endpoint + raw
 * serving model id. Subsequent requests then send the learned shape directly
 * instead of starting from a 400 every time.
 *
 * What is learned is the wire *format* (thinking.type enabled vs adaptive),
 * never capabilities or strength: the strength (reasoning_effort) is always
 * re-read from the current assistant settings per request, so changing
 * high -> low/auto never replays a stale one-off strength.
 *
 * Privacy: the persisted record holds ONLY opaque SHA-256 key digests mapped
 * to a dialect. Raw connection values (api key, URL/host, model id, headers)
 * enter the in-memory hash input and are never persisted or logged.
 */

import type { AssistantSettingCustomParameters, Provider, ReasoningEffortOption } from '@renderer/types'
import { APICallError } from 'ai'

export type AnthropicThinkingDialect = 'enabled' | 'adaptive'

export type AdaptiveEffort = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * How the current reasoning_effort encodes onto the adaptive dialect.
 * - `off`: default/none/minimal/unknown — never negotiated or reinterpreted.
 * - `auto`: adaptive without effort.
 * - `level`: adaptive with the native effort (one of low/medium/high/xhigh).
 * `minimal` has no native adaptive effort and stays `off` so the established
 * prepare-params handling is preserved instead of silently inferring strength.
 */
export type AdaptiveEffortPlan = { mode: 'off' } | { mode: 'auto' } | { mode: 'level'; effort: AdaptiveEffort }

export function toAdaptiveEffortPlan(reasoningEffort: ReasoningEffortOption | undefined): AdaptiveEffortPlan {
  switch (reasoningEffort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return { mode: 'level', effort: reasoningEffort }
    case 'auto':
      return { mode: 'auto' }
    default:
      return { mode: 'off' }
  }
}

/** Effort levels the reverse (adaptive -> enabled) retry may attempt. */
export function isNegotiableReasoningEffort(
  reasoningEffort: ReasoningEffortOption | undefined
): reasoningEffort is 'low' | 'medium' | 'high' | 'xhigh' | 'auto' {
  return (
    reasoningEffort === 'low' ||
    reasoningEffort === 'medium' ||
    reasoningEffort === 'high' ||
    reasoningEffort === 'xhigh' ||
    reasoningEffort === 'auto'
  )
}

// ---------------------------------------------------------------------------
// Learned-format record (renderer profile-local localStorage, fail-open)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'cherry-studio:anthropic-thinking-dialect:v1'
const SCHEMA_VERSION = 1
const MAX_ENTRIES = 128

/** Storage key holding ONLY opaque scope digests mapped to dialects. Exported for tests. */
export const THINKING_DIALECT_STORAGE_KEY = STORAGE_KEY

interface DialectRecord {
  version: number
  entries: Record<string, AnthropicThinkingDialect>
}

function isDialect(value: unknown): value is AnthropicThinkingDialect {
  return value === 'enabled' || value === 'adaptive'
}

function loadRecord(): DialectRecord {
  const empty: DialectRecord = { version: SCHEMA_VERSION, entries: {} }
  try {
    if (typeof localStorage === 'undefined') return empty
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as DialectRecord).version !== SCHEMA_VERSION ||
      typeof (parsed as DialectRecord).entries !== 'object' ||
      (parsed as DialectRecord).entries === null
    ) {
      // Schema mismatch: drop the whole record rather than misreading it.
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        // Fail open.
      }
      return empty
    }
    const entries: Record<string, AnthropicThinkingDialect> = {}
    for (const [key, value] of Object.entries((parsed as DialectRecord).entries)) {
      if (isDialect(value)) entries[key] = value
    }
    return { version: SCHEMA_VERSION, entries }
  } catch {
    return empty
  }
}

function saveRecord(record: DialectRecord): void {
  try {
    if (typeof localStorage === 'undefined') return
    const keys = Object.keys(record.entries)
    while (keys.length > MAX_ENTRIES) {
      const oldest = keys.shift()
      if (oldest === undefined) break
      delete record.entries[oldest]
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Fail open: a broken store must never break chat.
  }
}

/** Read the learned dialect for an opaque scope key (undefined = unknown). */
export function readLearnedDialect(scopeKeyHash: string): AnthropicThinkingDialect | undefined {
  const dialect = loadRecord().entries[scopeKeyHash]
  return isDialect(dialect) ? dialect : undefined
}

/** Persist a learned dialect. Only called after a successful alternate request. */
export function writeLearnedDialect(scopeKeyHash: string, dialect: AnthropicThinkingDialect): void {
  const record = loadRecord()
  if (record.entries[scopeKeyHash] === dialect) return
  record.entries[scopeKeyHash] = dialect
  saveRecord(record)
}

/** Drop a stale hint after a contradictory precise rejection. */
export function evictLearnedDialect(scopeKeyHash: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const record = loadRecord()
    if (!(scopeKeyHash in record.entries)) return
    delete record.entries[scopeKeyHash]
    saveRecord(record)
  } catch {
    // Fail open.
  }
}

// ---------------------------------------------------------------------------
// Scope key (hashed in memory; only the digest is persisted)
// ---------------------------------------------------------------------------

/** SHA-256 hex (Web Crypto, renderer-native). Rejects when unavailable. */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('WebCrypto SHA-256 unavailable')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Normalize a configured host: trim, drop trailing slashes, lowercase scheme+host. */
export function normalizeHostUrl(value: string | undefined): string {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}${url.hash}`
  } catch {
    return trimmed
  }
}

export interface ThinkingScopeInput {
  provider: Pick<Provider, 'id' | 'type' | 'apiHost' | 'apiKey' | 'apiVersion' | 'extra_headers'> & {
    anthropicApiHost?: string
  }
  modelId: string
}

function canonicalScopeString(input: ThinkingScopeInput): string {
  const headers = input.provider.extra_headers ?? {}
  const sortedHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name.toLowerCase()}=${headers[name] ?? ''}`)
    .join('&')
  return [
    'anthropic-thinking-dialect',
    `v${SCHEMA_VERSION}`,
    `provider.id=${input.provider.id}`,
    `provider.type=${input.provider.type}`,
    `base=${normalizeHostUrl(input.provider.apiHost)}`,
    `anthropicBase=${normalizeHostUrl(input.provider.anthropicApiHost)}`,
    'endpoint=/v1/messages',
    `apiVersion=${input.provider.apiVersion ?? ''}`,
    `model=${input.modelId}`,
    // Secret/routing material below enters the in-memory hash input only;
    // the persisted record keeps the digest, never these raw values.
    `auth=${input.provider.apiKey ?? ''}`,
    `headers=${sortedHeaders}`
  ].join('\n')
}

/**
 * Opaque scope key for the (connection endpoint + raw serving model id)
 * scope. Key rotation, host changes, or header changes yield a different
 * digest, so each exact connection/model pair learns independently.
 */
export function buildThinkingScopeKey(input: ThinkingScopeInput): Promise<string> {
  return sha256Hex(canonicalScopeString(input))
}

// ---------------------------------------------------------------------------
// Explicit user-override opt-out (exact custom-parameter merge semantics)
// ---------------------------------------------------------------------------

const THINKING_CUSTOM_KEYS = new Set([
  'thinking',
  'effort',
  'output_config',
  'budget_tokens',
  'budgettokens',
  'task_budget',
  'taskbudget'
])

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function objectHasThinkingKey(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return Object.keys(value).some((key) => THINKING_CUSTOM_KEYS.has(key.toLowerCase()))
}

/**
 * True when the assistant's custom parameters explicitly control the thinking
 * wire shape (top-level thinking/effort/output_config/budget keys, which the
 * provider-options builder nests under the anthropic bucket, or the same keys
 * nested under an explicit `anthropic` bucket). User-controlled values always
 * win: the plugin must not transform, retry, or learn for such requests.
 * Any other custom field never opts out.
 */
export function hasExplicitThinkingCustomParams(
  customParameters: AssistantSettingCustomParameters[] | undefined
): boolean {
  if (!Array.isArray(customParameters)) return false
  for (const param of customParameters) {
    const name = param?.name?.trim().toLowerCase()
    if (!name) continue
    if (THINKING_CUSTOM_KEYS.has(name)) return true
    if (name === 'anthropic' && objectHasThinkingKey(parseJsonValue(param.value))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Narrow HTTP400 rejection matching (enabled <-> adaptive only)
// ---------------------------------------------------------------------------

export type ThinkingRejection = 'enabled-rejected' | 'adaptive-rejected'

function tryParseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return value
}

function extractErrorBody(error: unknown): { type?: unknown; message?: unknown } | undefined {
  const holder = error as { data?: unknown; responseBody?: unknown } | null
  for (const candidate of [holder?.data, holder?.responseBody]) {
    const parsed = tryParseJson(candidate) as { error?: unknown } | null
    if (typeof parsed !== 'object' || parsed === null) continue
    const body = (parsed as { error?: unknown }).error ?? parsed
    if (typeof body === 'object' && body !== null) return body as { type?: unknown; message?: unknown }
  }
  return undefined
}

// Subject-first clauses: the unsupported verdict must attach to the shape
// that was sent, in the same sentence. The recommendation half (adaptive +
// output_config/effort vs enabled + budget) disambiguates the direction, so
// an enabled-rejection message never classifies for a sent adaptive shape
// and vice versa. A bare `thinking` substring never matches.
const ENABLED_SUBJECT =
  /thinking.{0,40}['"]?enabled['"]?[^.]{0,80}not supported|thinking.{0,40}['"]?enabled['"]?[^.]{0,80}unsupported|thinking.{0,40}['"]?enabled['"]?[^.]{0,80}does not support/i
const ADAPTIVE_SUBJECT =
  /adaptive.{0,40}thinking[^.]{0,80}not supported|adaptive.{0,40}thinking[^.]{0,80}unsupported|adaptive.{0,40}thinking[^.]{0,80}does not support|adaptive[^.]{0,40}unsupported/i
const ADAPTIVE_RECOMMENDATION = /adaptive.{0,60}output_config|adaptive.{0,60}effort/i
const ENABLED_RECOMMENDATION = /enabled.{0,60}budget|budget.{0,60}enabled/i

function isEnabledRejectedMessage(message: string): boolean {
  // Precise clause: thinking.type 'enabled' unsupported + an explicit
  // adaptive/output_config.effort recommendation.
  return ENABLED_SUBJECT.test(message) && ADAPTIVE_RECOMMENDATION.test(message)
}

function isAdaptiveRejectedMessage(message: string): boolean {
  // Bare documented standard: `adaptive thinking is not supported on this
  // model` — explicit format reject without a recommendation clause.
  if (/adaptive thinking is not supported on this model/i.test(message)) return true
  // Explicit quoted subject: thinking.type 'adaptive' unsupported for this
  // model + an explicit enabled/budget recommendation. Gateway-prefixed
  // `Upstream request failed: ...` wrappers contain the same clause, so the
  // whole-text test covers them.
  const QUOTED_ADAPTIVE_SUBJECT =
    /thinking\.?type.{0,40}['"]?adaptive['"]?[^.]{0,80}(not supported|unsupported|does not support)/i
  if (QUOTED_ADAPTIVE_SUBJECT.test(message) && ENABLED_RECOMMENDATION.test(message)) return true
  // Precise clause: adaptive thinking unsupported (the message names the
  // model) + an explicit enabled/budget recommendation.
  return ADAPTIVE_SUBJECT.test(message) && ENABLED_RECOMMENDATION.test(message)
}

/**
 * Classify an HTTP400 failure as a thinking-format rejection, or null when it
 * must stay transparent. Requires ALL of: a cross-package APICallError with
 * statusCode 400, a parseable body with error.type === 'invalid_request_error',
 * the precise message clause for the shape that was actually sent, and
 * agreement between the rejected shape and the initial params mode.
 * Budget/validation/content/spend-limit, 401/429/5xx, network, and post-200
 * stream errors never classify.
 */
export function classifyThinkingRejection(
  error: unknown,
  sentThinkingType: 'enabled' | 'adaptive'
): ThinkingRejection | null {
  if (!APICallError.isInstance(error)) return null
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  if (statusCode !== 400) return null
  const body = extractErrorBody(error)
  if (!body || body.type !== 'invalid_request_error' || typeof body.message !== 'string') return null
  const fallbackMessage = (error as { message?: unknown } | null)?.message
  const text = typeof fallbackMessage === 'string' ? `${body.message} ${fallbackMessage}` : body.message
  if (sentThinkingType === 'enabled') {
    return isEnabledRejectedMessage(text) ? 'enabled-rejected' : null
  }
  return isAdaptiveRejectedMessage(text) ? 'adaptive-rejected' : null
}

// ---------------------------------------------------------------------------
// Shape conversions (no model-name input; no mutation)
// ---------------------------------------------------------------------------

export interface AnthropicThinkingBucket {
  thinking?: { type?: string; budgetTokens?: number; display?: string }
  effort?: unknown
  sendReasoning?: unknown
  [key: string]: unknown
}

/**
 * Convert an `enabled` bucket to `adaptive`. The strength comes from the
 * current reasoning_effort plan (never from the serialized budget); the
 * budget/sendReasoning workaround fields are dropped as appropriate, and all
 * other providerOptions fields are retained untouched.
 */
export function toAdaptiveBucket(
  original: AnthropicThinkingBucket,
  plan: Extract<AdaptiveEffortPlan, { mode: 'level' | 'auto' }>
): AnthropicThinkingBucket {
  const { thinking: _thinking, effort: _effort, sendReasoning: _sendReasoning, ...rest } = original
  const next: AnthropicThinkingBucket = { ...rest, thinking: { type: 'adaptive' } }
  if (plan.mode === 'level') next.effort = plan.effort
  return next
}

/**
 * Convert an `adaptive` bucket to `enabled` with an explicit budget. The
 * adaptive-only display/effort fields are dropped; every other field is
 * retained untouched (nothing model-specific is guessed, e.g. no
 * sendReasoning is invented). Returns null when no valid budget exists.
 */
export function toEnabledBucket(
  original: AnthropicThinkingBucket,
  budgetTokens: number | undefined
): AnthropicThinkingBucket | null {
  if (budgetTokens === undefined || !Number.isFinite(budgetTokens) || budgetTokens < 1024) return null
  const { thinking: _thinking, effort: _effort, ...rest } = original
  return { ...rest, thinking: { type: 'enabled', budgetTokens: Math.floor(budgetTokens) } }
}
