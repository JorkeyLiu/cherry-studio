/**
 * Centralized relay error sanitizer (Main sync internal shared).
 *
 * The relay is untrusted for error-body content: a non-2xx body may be JSON
 * or plain text and must never carry credential material into logs, thrown
 * error text, durable `lastError`, or an error `cause`. Plain text cannot
 * reliably identify an arbitrary secret, so raw bodies are never
 * persisted/recorded; only a fixed safe summary plus HTTP status, or a
 * strictly parsed allowlisted error code, leaves this module.
 *
 * Rules:
 * - Input is `unknown` (usually `res.text()` output) with an input length
 *   cap to bound parsing work.
 * - JSON objects/arrays are recursively cloned with secret-shaped keys
 *   removed (`deviceSecret` / `deviceAuth` / `secret` / `authorization` /
 *   `token` including case and separator variants). Arrays and nesting are
 *   handled structurally.
 * - Sanitized JSON output is capped; any value/array entry/key holding a
 *   64-hex credential substring (even wrapped in alphanumerics or nested in
 *   a longer hex run, with no word-boundary requirement) collapses the whole
 *   detail to the fixed summary; redaction of 64+ hex runs remains as
 *   defense in depth. Short hashes (<64 hex) never trigger.
 * - Non-JSON text never returns raw content: only a strictly allowlisted
 *   short error code is echoed, otherwise a fixed `request failed` summary.
 * - Useful relay codes (`pairing-required`, `requester-already-paired`,
 *   `invalid operation ...`, etc.) are preserved when they pass the strict
 *   allowlist so UI and tests keep their contract.
 * - `relayHttpError` builds the thrown `Error` with no `cause` carrying a
 *   raw body (cause is limited to the numeric status).
 */

const MAX_RELAY_ERROR_INPUT_CHARS = 8192
const MAX_RELAY_ERROR_OUTPUT_CHARS = 500
/** Fixed detail used when no strictly safe code can be extracted. */
const GENERIC_RELAY_DETAIL = 'request failed'

const SECRET_KEY_EXACT = new Set([
  'devicesecret',
  'deviceauth',
  'secret',
  'authorization',
  'token',
  'auth',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'authtoken'
])

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]+/g, '')
}

function isSecretKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false
  const normalized = normalizeSecretKey(key)
  if (SECRET_KEY_EXACT.has(normalized)) return true
  // Separator/case variants collapse into the exact set above; catch any
  // residual compound carrying credential semantics (e.g. `mySecretValue`,
  // `authTokenExtra`) without touching ordinary fields like `error`.
  if (normalized.includes('secret')) return true
  if (normalized.includes('token')) return true
  return false
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) continue
      out[key] = sanitizeJsonValue(entry)
    }
    return out
  }
  return value
}

/**
 * Credential-material detector, locked to the device-secret format
 * (32 random bytes rendered as 64 hex chars). Matches any 64-hex
 * substring anywhere in the input with no word-boundary requirement, so
 * `x<64hex>y` or a 64-hex run nested inside a longer hex/alphanumeric run
 * is still detected. Short hashes / error codes (<64 hex) never match.
 */
function containsCredentialText(text: string): boolean {
  return /[0-9a-fA-F]{64}/.test(text)
}

/** Recursively check JSON values, arrays, and keys for credential material. */
function containsCredentialMaterial(value: unknown): boolean {
  if (typeof value === 'string') return containsCredentialText(value)
  if (Array.isArray(value)) return value.some((entry) => containsCredentialMaterial(entry))
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (containsCredentialText(key)) return true
      if (containsCredentialMaterial(entry)) return true
    }
    return false
  }
  return false
}

/** Long hex runs are never legitimate in relay error text; redact defensively. */
function redactHexRuns(text: string): string {
  return text.replace(/[0-9a-fA-F]{64,}/g, '[redacted]')
}

/**
 * Strict allowlist for short relay error codes/messages. Accepts the relay's
 * kebab/space/colon/dot code vocabulary (`pairing-required`,
 * `requester-already-paired`, `invalid operation ...`) while rejecting
 * anything that could carry credential material (long hex runs, overlong or
 * strangely punctuated blobs).
 */
function isSafeRelayCode(text: string): boolean {
  if (text.length === 0 || text.length > 100) return false
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_.: /+;=]{0,99}$/.test(text)) return false
  if (containsCredentialText(text)) return false
  return true
}

function safeStatus(status: unknown): number | undefined {
  return typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined
}

/**
 * Safe relay error detail (no status prefix, capped). Never returns raw
 * plain-text bodies: JSON is structurally sanitized, plain text only echoes
 * a strictly allowlisted short code, otherwise the fixed generic summary.
 */
export function sanitizeRelayErrorBody(body: unknown, status?: unknown): string {
  const httpStatus = safeStatus(status)
  void httpStatus
  if (body === undefined || body === null) return GENERIC_RELAY_DETAIL
  if (typeof body === 'object') {
    try {
      const sanitized = sanitizeJsonValue(body)
      if (containsCredentialMaterial(sanitized)) return GENERIC_RELAY_DETAIL
      const json = redactHexRuns(JSON.stringify(sanitized)).slice(0, MAX_RELAY_ERROR_OUTPUT_CHARS)
      if (json.length === 0 || json === '{}' || json === '[]' || json === 'null') return GENERIC_RELAY_DETAIL
      return json
    } catch {
      return GENERIC_RELAY_DETAIL
    }
  }
  if (typeof body !== 'string') {
    try {
      const text = String(body)
      if (text.length === 0) return GENERIC_RELAY_DETAIL
      return sanitizeRelayErrorBody(text, status)
    } catch {
      return GENERIC_RELAY_DETAIL
    }
  }
  const input = body.length > MAX_RELAY_ERROR_INPUT_CHARS ? body.slice(0, MAX_RELAY_ERROR_INPUT_CHARS) : body
  if (input.trim().length === 0) return GENERIC_RELAY_DETAIL
  const trimmed = input.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object') {
      const sanitized = sanitizeJsonValue(parsed)
      if (containsCredentialMaterial(sanitized)) return GENERIC_RELAY_DETAIL
      const json = redactHexRuns(JSON.stringify(sanitized)).slice(0, MAX_RELAY_ERROR_OUTPUT_CHARS)
      if (json.length === 0 || json === '{}' || json === '[]' || json === 'null') return GENERIC_RELAY_DETAIL
      return json
    }
  } catch {
    // Not JSON: fall through to the strict plain-text allowlist below.
  }
  // Plain text: any credential-shaped substring anywhere (even wrapped in
  // alphanumerics or nested in a longer run) collapses to the fixed summary
  // before the allowlist is consulted, so the raw value never echoes.
  if (containsCredentialText(trimmed)) return GENERIC_RELAY_DETAIL
  if (isSafeRelayCode(trimmed.slice(0, 100))) {
    return trimmed.slice(0, 100)
  }
  return GENERIC_RELAY_DETAIL
}

/**
 * Build the thrown relay HTTP error. The message carries only
 * `${operation} failed ${status}: ${safeDetail}` (capped); `cause` carries
 * only the numeric status so no raw body can ride along.
 */
export function relayHttpError(operation: string, status: number, body: unknown): Error {
  const safeOp = /^[A-Za-z][A-Za-z0-9\-_ ]{0,40}$/.test(operation) ? operation : 'sync request'
  const safeStatusCode = Number.isSafeInteger(status) ? status : 0
  const detail = sanitizeRelayErrorBody(body, safeStatusCode)
  const err = new Error(`${safeOp} failed ${safeStatusCode}: ${detail}`.slice(0, MAX_RELAY_ERROR_OUTPUT_CHARS + 100))
  try {
    ;(err as { cause?: unknown }).cause = { status: safeStatusCode }
  } catch {}
  return err
}
