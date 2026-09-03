/**
 * Shared sync endpoint validation — single source of truth for bearer-token
 * transport security.
 * - Only http/https schemes are accepted.
 * - Bearer tokens must never travel over non-loopback plaintext HTTP.
 * - Loopback HTTP remains allowed for local/reference testing:
 *   `localhost`, `127.0.0.1`, `::1`.
 * - All non-loopback endpoints must use https.
 * JSON-only, no Node/Electron imports.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().trim()
  if (LOOPBACK_HOSTS.has(normalized)) return true
  // URL may retain brackets for IPv6 loopback depending on runtime.
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return LOOPBACK_HOSTS.has(normalized.slice(1, -1))
  }
  return false
}

export function validateSyncEndpointUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return 'endpoint is required'
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'endpoint is required'
  if (trimmed.length > 2048) return 'endpoint too long'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'endpoint must be a valid URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'endpoint must be http or https'
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    return 'endpoint must use https for non-loopback hosts (http is allowed only for localhost/127.0.0.1/[::1])'
  }
  return null
}
