/**
 * Single shared cross-runtime connection header/session policy for MODEL
 * provider requests (chat, embedding, rerank, listing, file, image).
 *
 * This is the one policy location: generic header/session resolution plus Go
 * endpoint detection live here and nowhere else. Renderer and Main both
 * consume it; renderer `prepareParams/header.ts` re-exports this module so
 * the existing renderer API and tests keep passing unchanged.
 *
 * Contract (renderer-established, preserved verbatim):
 * - Endpoint-gated by `isOpenCodeGoEndpoint`: non-Go hosts (ordinary Zen,
 *   DeepSeek direct, any other OpenAI-compatible) never receive the header.
 * - Topic-scoped calls pass their existing stable topic identity (`topicId`);
 *   the same topicId always yields the identical value across retries.
 * - Genuinely topicless calls (blank/missing topicId) receive one
 *   request-local opaque identity generated here and held constant for that
 *   invocation (never a fake topic/persisted identity).
 * - Precedence (case-insensitive): explicit per-request headers win over
 *   provider `extra_headers`, and provider extra session wins over the
 *   automatic identity. Only defined values participate: an explicit or
 *   provider session value of `undefined` is absence, so the automatic
 *   identity still fills it (a defined empty string still counts as an
 *   explicit value and is preserved as-is). Unrelated headers are preserved
 *   as-is (undefined values dropped); credentials/abort behavior is untouched
 *   (headers only).
 *
 * Non-goals: no topic/global/session store, no model-specific mapping, no
 * transport interception, no body/dialect/endpoint mutation. API-server
 * callers with no trustworthy topic field use the topicless logical-request
 * identity (opaque, per invocation); they never synthesize a topic.
 *
 * Runtime-safe: string trim + URL parsing + `globalThis.crypto` only. No
 * Node/Electron/renderer imports, so Main, preload-adjacent, and renderer
 * bundles can all consume it.
 */

// Gateway routing/cache identity for OpenCode Go conversations.
// The Go gateway (`https://opencode.ai/zen/go/v1/*`) requires a stable
// per-conversation `x-opencode-session` on every request (400 MissingSessionID
// when absent). It is transport identity, not an OpenAI Responses body field.
// Scope is strictly endpoint-based: only requests actually targeting the
// official OpenCode Go endpoint carry it. Ordinary Zen
// (`https://opencode.ai/zen/v1/*`), DeepSeek direct, and any other
// OpenAI-compatible endpoint never receive it. No model brand/name
// branching — any model served behind the Go endpoint applies.
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

export type RequestHeaderMap = Record<string, string | undefined>

export interface ResolveOutboundRequestHeadersOptions {
  apiHost?: string
  topicId?: string
  explicitHeaders?: RequestHeaderMap
  providerExtraHeaders?: RequestHeaderMap
  generateId?: () => string
}

/**
 * Precise check for the official OpenCode Go endpoint.
 * - hostname must be exactly `opencode.ai` (no subdomains, no suffix spoof)
 * - protocol must be `https:` (production never matches insecure http)
 * - pathname must be `/zen/go` or start with `/zen/go/`
 * Case-insensitive host/path comparison; surrounding whitespace, trailing
 * slashes, query strings, and `#endpoint` fragments (existing apiHost formats
 * such as `.../responses#`) are ignored because URL parsing isolates the
 * pathname. Never use includes() matching here.
 */
export function isOpenCodeGoEndpoint(apiHost?: string): boolean {
  if (typeof apiHost !== 'string') return false
  const trimmed = apiHost.trim()
  if (!trimmed) return false
  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    return false
  }
  if (url.protocol.toLowerCase() !== 'https:') return false
  if (url.hostname.toLowerCase() !== 'opencode.ai') return false
  const pathname = url.pathname.toLowerCase()
  return pathname === '/zen/go' || pathname.startsWith('/zen/go/')
}

/**
 * Case-insensitive header presence check (HTTP headers are case-insensitive,
 * but the params object keys are case-sensitive). An `undefined` value counts
 * as absent (consistent with HTTP/fetch semantics: the final SDK transport
 * drops `undefined` entries, so presence-with-`undefined` must never block
 * the automatic identity).
 */
export function hasHeader(headers: RequestHeaderMap | undefined, name: string): boolean {
  if (!headers) return false
  const target = name.toLowerCase()
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === target && value !== undefined)
}

/**
 * Build the stable per-conversation session header from a topic id.
 * Stability contract: the same topicId must always yield the identical header
 * value across retries and continuations within the conversation. Blank or
 * missing topicId yields nothing (callers must not fabricate an identity for
 * translate/check/generate/listModels). Only the topic id is used — never
 * userId, messageId, or traceId — keeping the value minimal with no semantic
 * leakage. Renderer-safe: string trim only, no new dependencies or Node APIs.
 */
export function buildOpencodeSessionHeader(topicId?: string): Record<string, string> | undefined {
  if (typeof topicId !== 'string') return undefined
  const sessionId = topicId.trim()
  if (!sessionId) return undefined
  return { [OPENCODE_SESSION_HEADER]: sessionId }
}

/**
 * Generate one request-local opaque session identity for genuinely topicless
 * outbound-AI requests (translation/note/generate/check/listing, Main
 * embedding/rerank/file/API-server invocations).
 * Prefers `crypto.randomUUID`, falls back to a random suffix.
 * The value is opaque (no user/provider/model content), generated once at the
 * request boundary and held constant for that invocation/retries. Never a fake
 * topic id and never persisted.
 */
export function generateRequestSessionId(): string {
  try {
    const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      return cryptoObj.randomUUID()
    }
  } catch {
    // fall through to Math.random fallback below
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Case-insensitive header value read (HTTP headers are case-insensitive,
 * but the params object keys are case-sensitive). Returns undefined when
 * absent or when the value itself is undefined.
 */
export function getHeaderValue(headers: RequestHeaderMap | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value
    }
  }
  return undefined
}

/**
 * Single request-boundary policy for the outbound-AI session header.
 *
 * - Endpoint-gated by `isOpenCodeGoEndpoint`: non-Go hosts (ordinary Zen,
 *   DeepSeek direct, any other OpenAI-compatible) never receive the header.
 * - Topic-scoped calls pass their existing stable topic identity (`topicId`);
 *   the same topicId always yields the identical value across retries.
 * - Genuinely topicless calls (blank/missing topicId) receive one
 *   request-local opaque identity generated here and held constant for that
 *   invocation (never a fake topic/persisted identity).
 * - Precedence (case-insensitive): explicit per-request headers win over
 *   provider `extra_headers`, and provider extra session wins over the
 *   automatic identity. Only defined values participate: an explicit or
 *   provider session value of `undefined` is absence, so the automatic
 *   identity still fills it (a defined empty string still counts as an
 *   explicit value and is preserved as-is). Unrelated headers are preserved
 *   as-is (undefined values dropped); credentials/abort behavior is untouched
 *   (headers only).
 *
 * Returns the final per-request headers to send (`params.headers` /
 * transport `headers` option). When no injection applies, the explicit
 * headers are returned as-is (including undefined) so callers never fabricate
 * an empty headers object.
 */
export function resolveOutboundRequestHeaders(
  options: ResolveOutboundRequestHeadersOptions
): RequestHeaderMap | undefined {
  const { apiHost, topicId, explicitHeaders, providerExtraHeaders, generateId } = options
  // Explicit per-request session wins (any case) — no duplicate default.
  if (hasHeader(explicitHeaders, OPENCODE_SESSION_HEADER)) {
    return explicitHeaders
  }
  // Provider extra session wins over the automatic identity — the provider
  // value already flows via providerSettings/config headers, so no per-request
  // injection is needed.
  if (hasHeader(providerExtraHeaders, OPENCODE_SESSION_HEADER)) {
    return explicitHeaders
  }
  if (!isOpenCodeGoEndpoint(apiHost)) {
    return explicitHeaders
  }
  let sessionValue: string | undefined
  if (typeof topicId === 'string' && topicId.trim()) {
    sessionValue = topicId.trim()
  } else {
    try {
      const generated = (generateId ?? generateRequestSessionId)()
      sessionValue = typeof generated === 'string' ? generated.trim() : undefined
    } catch {
      sessionValue = undefined
    }
    if (!sessionValue) {
      return explicitHeaders
    }
  }
  const cleaned: Record<string, string> = {}
  if (explicitHeaders) {
    for (const [key, value] of Object.entries(explicitHeaders)) {
      if (value !== undefined) {
        cleaned[key] = value
      }
    }
  }
  return { [OPENCODE_SESSION_HEADER]: sessionValue, ...cleaned }
}
