/**
 * Shared sync endpoint validation — single source of truth for relay
 * endpoint policy.
 * - Only http/https schemes are accepted.
 * - Both http and https are accepted for loopback and non-loopback hosts.
 *   Plaintext HTTP to a non-loopback host is unencrypted: callers surface a
 *   visible non-blocking warning (see `isNonLoopbackHttpEndpoint`) instead
 *   of rejecting the endpoint. HTTPS uses ordinary default certificate
 *   verification; there is no bypass or auto-trust anywhere in this path.
 * - Loopback hosts for warning purposes: `localhost`, `127.0.0.1`, `::1`.
 * - Wildcard/unspecified hosts (`0.0.0.0`, `::` and equivalent all-zero /
 *   IPv4-mapped-unspecified / zone-suffixed forms) are never valid
 *   endpoints, matching the relay public-URL policy. Embedded URL
 *   credentials (`user:pass@host`) are never valid.
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

/**
 * True when `raw` parses as an `http://` URL whose host is not loopback.
 * Used by Sync Settings to show a visible non-blocking warning that the
 * endpoint is unencrypted. Never throws; unparseable input returns false
 * (validation itself reports the parse error via `validateSyncEndpointUrl`).
 */
function hasExplicitHttpAuthorityPrefix(trimmed: string, httpOnly: boolean): boolean {
  const m = httpOnly ? /^http:\/\//i.exec(trimmed) : /^https?:\/\//i.exec(trimmed)
  if (!m) return false
  const after = trimmed.slice(m[0].length)
  // Authority must be present: `http:///x` (empty host, path-only) and bare
  // `http://`/`https://` are malformed even though `new URL` normalizes the
  // former to a valid host.
  if (!after || after.startsWith('/') || after.startsWith('?') || after.startsWith('#')) return false
  return true
}

/**
 * Dependency-free wildcard/unspecified host detection, mirroring the relay
 * public-URL/host policy without a Node `net.isIP` import.
 * Covers `0.0.0.0`, `::` (bracketed or not), `*`, all-zero IPv6 expansions
 * (`0:0:0:0:0:0:0:0`, `0::`, `::0`, `0::0`, ...), IPv4-mapped unspecified
 * forms (`::ffff:0.0.0.0` and compressed/expanded/case variants,
 * `::ffff:0:0`), the deprecated IPv4-compatible unspecified form
 * (`::0.0.0.0`), and zone-suffixed representations (`::%eth0`,
 * `[::%eth0]`, `[::]%eth0`). Fail-closed: any all-zero or
 * mapped-unspecified literal is wildcard.
 */
function stripBracketsAndZone(hostname: string): string {
  let n = hostname.trim().toLowerCase()
  if (n.startsWith('[')) {
    const close = n.indexOf(']')
    if (close !== -1) {
      let inner = n.slice(1, close)
      const pctIn = inner.indexOf('%')
      if (pctIn !== -1) inner = inner.slice(0, pctIn)
      return inner
    }
  }
  if (n.startsWith('[') && n.endsWith(']')) n = n.slice(1, -1)
  const pct = n.indexOf('%')
  if (pct !== -1) n = n.slice(0, pct)
  if (n.endsWith(']')) {
    const open = n.indexOf('[')
    if (open !== -1) n = n.slice(open + 1, n.length - 1)
  }
  return n
}

function parseHextet(part: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(part)) return null
  return parseInt(part, 16)
}

function parseIpv4Tail(tail: string): [number, number] | null {
  const octets = tail.split('.')
  if (octets.length !== 4) return null
  const bytes: number[] = []
  for (const o of octets) {
    if (!/^[0-9]{1,3}$/.test(o)) return null
    const v = Number(o)
    if (!Number.isSafeInteger(v) || v < 0 || v > 255) return null
    bytes.push(v)
  }
  return [bytes[0] * 256 + bytes[1], bytes[2] * 256 + bytes[3]]
}

function expandHead(head: string, slots: number): number[] | null {
  if (head === '') return new Array(slots).fill(0)
  if (head.includes('::')) {
    const parts = head.split('::')
    if (parts.length !== 2) return null
    const left = parts[0] === '' ? [] : parts[0].split(':')
    const right = parts[1] === '' ? [] : parts[1].split(':')
    const leftVals: number[] = []
    for (const p of left) {
      const v = parseHextet(p)
      if (v === null) return null
      leftVals.push(v)
    }
    const rightVals: number[] = []
    for (const p of right) {
      const v = parseHextet(p)
      if (v === null) return null
      rightVals.push(v)
    }
    if (leftVals.length + rightVals.length > slots) return null
    const zeros = new Array(slots - leftVals.length - rightVals.length).fill(0)
    return [...leftVals, ...zeros, ...rightVals]
  }
  const pieces = head.split(':')
  if (pieces.length !== slots) return null
  const vals: number[] = []
  for (const p of pieces) {
    const v = parseHextet(p)
    if (v === null) return null
    vals.push(v)
  }
  return vals
}

function expandIpv6Groups(addr: string): number[] | null {
  if (!addr.includes(':')) return null
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    if (lastColon === -1) return null
    const head = addr.slice(0, lastColon)
    const tail = addr.slice(lastColon + 1)
    const tailGroups = parseIpv4Tail(tail)
    if (!tailGroups) return null
    const headGroups = expandHead(head, 6)
    if (!headGroups) return null
    return [...headGroups, ...tailGroups]
  }
  return expandHead(addr, 8)
}

export function isWildcardEndpointHostname(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') return false
  const n = stripBracketsAndZone(hostname)
  if (n === '*' || n === '0.0.0.0' || n === '::') return true
  if (!n.includes(':')) return false
  const expanded = expandIpv6Groups(n)
  if (expanded) {
    if (expanded.every((g) => g === 0)) return true
    if (
      expanded[0] === 0 &&
      expanded[1] === 0 &&
      expanded[2] === 0 &&
      expanded[3] === 0 &&
      expanded[4] === 0 &&
      expanded[5] === 0xffff &&
      expanded[6] === 0 &&
      expanded[7] === 0
    ) {
      return true
    }
    return false
  }
  // Legacy all-zero heuristic fallback: a colon-bearing host using only
  // `:`/`0`/`.` characters is an all-zero representation.
  if (n.replace(/[:0.]/g, '') === '') return true
  // IPv4-mapped unspecified with an unparseable head is still wildcard when
  // it carries the ffff marker and an all-zero tail.
  if (n.includes('ffff')) {
    const tailZero = n.endsWith(':0.0.0.0') || n.endsWith(':0:0') || n.endsWith(':0000:0000') || n.endsWith(':0:0000')
    const headZero = n.startsWith('::ffff:') || n.startsWith('0:0:0:0:0:ffff:') || n.startsWith('0::ffff:')
    if (tailZero && headZero) return true
  }
  if (n === '::0.0.0.0') return true
  // Any other colon-bearing host that does not parse as IPv6 is ambiguous:
  // fail closed as wildcard so the validator rejects rather than accepts.
  return true
}

export function isNonLoopbackHttpEndpoint(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > 2048) return false
  if (!hasExplicitHttpAuthorityPrefix(trimmed, true)) return false
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return false
  }
  if (!url.hostname) return false
  if (url.username || url.password) return false
  if (isWildcardEndpointHostname(url.hostname)) return false
  return url.protocol === 'http:' && !isLoopbackHostname(url.hostname)
}

export function validateSyncEndpointUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return 'endpoint is required'
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'endpoint is required'
  if (trimmed.length > 2048) return 'endpoint too long'
  if (!hasExplicitHttpAuthorityPrefix(trimmed, false)) {
    return 'endpoint must be http or https'
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'endpoint must be a valid URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'endpoint must be http or https'
  }
  if (!url.hostname) {
    return 'endpoint must be a valid URL'
  }
  if (url.username || url.password) {
    return 'endpoint must not include credentials'
  }
  if (isWildcardEndpointHostname(url.hostname)) {
    return 'endpoint must not be a wildcard address'
  }
  return null
}
