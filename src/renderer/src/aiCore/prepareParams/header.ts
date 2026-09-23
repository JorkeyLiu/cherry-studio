import { isClaude4SeriesModel, isClaude45ReasoningModel } from '@renderer/config/models'
import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Assistant, Model } from '@renderer/types'
import { isToolUseModeFunction } from '@renderer/utils/assistant'

// https://docs.claude.com/en/docs/build-with-claude/extended-thinking#interleaved-thinking
const INTERLEAVED_THINKING_HEADER = 'interleaved-thinking-2025-05-14'
// https://docs.claude.com/en/docs/build-with-claude/context-windows#1m-token-context-window
// const CONTEXT_100M_HEADER = 'context-1m-2025-08-07'

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

/**
 * Precise renderer-safe check for the official OpenCode Go endpoint.
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
 * but the params object keys are case-sensitive).
 */
export function hasHeader(headers: Record<string, string | undefined> | undefined, name: string): boolean {
  if (!headers) return false
  const target = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === target)
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
 * Build the one-shot session header for a ProviderSetting-style connectivity
 * check (`ApiService.checkApi`). Detection requests carry no real
 * topic/conversation, so the caller passes a synthetic per-check id (the
 * `abortId`/uuid for that single check). Only the check id is used — never
 * userId, provider name, or model name — keeping the value free of
 * user/model content. Strictly endpoint-gated by `isOpenCodeGoEndpoint`:
 * non-Go hosts yield no session header (explicit caller headers, if any,
 * are preserved as-is). An explicit caller header of the same name (any
 * case) wins without emitting a duplicate default.
 */
export function buildOpencodeCheckSessionHeaders(
  apiHost?: string,
  checkId?: string,
  explicitHeaders?: Record<string, string | undefined>
): Record<string, string> | undefined {
  if (hasHeader(explicitHeaders, OPENCODE_SESSION_HEADER)) {
    return explicitHeaders as Record<string, string>
  }
  const hasExplicit = !!explicitHeaders && Object.keys(explicitHeaders).length > 0
  if (!isOpenCodeGoEndpoint(apiHost)) {
    return hasExplicit ? (explicitHeaders as Record<string, string>) : undefined
  }
  const sessionHeader = buildOpencodeSessionHeader(checkId)
  if (!sessionHeader) {
    return hasExplicit ? (explicitHeaders as Record<string, string>) : undefined
  }
  if (!hasExplicit) {
    return sessionHeader
  }
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(explicitHeaders ?? {})) {
    if (value !== undefined) {
      cleaned[key] = value
    }
  }
  return { ...sessionHeader, ...cleaned }
}

export function addAnthropicHeaders(assistant: Assistant, model: Model): string[] {
  const anthropicHeaders: string[] = []
  const provider = getProviderByModel(model)
  if (!provider) {
    // Unconfigured model/provider: fail explicitly before any provider/API
    // invocation.
    throw new Error('Model provider is not configured')
  }
  if (isClaude45ReasoningModel(model) && isToolUseModeFunction(assistant)) {
    anthropicHeaders.push(INTERLEAVED_THINKING_HEADER)
  }
  if (isClaude4SeriesModel(model)) {
    // We may add it by user preference in assistant.settings instead of always adding it.
    // See #11540, #11397
    // anthropicHeaders.push(CONTEXT_100M_HEADER)
  }
  return anthropicHeaders
}
