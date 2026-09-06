/**
 * Relay host serialization for URL/readiness output (single shared helper).
 *
 * Brackets IPv6 literals (`[addr]`, RFC 2732/3986) so `https://host:port`
 * readiness lines and launcher endpoints stay valid URLs. IPv4 and hostname
 * (loopback) formatting is unchanged. Zone IDs (`%eth0`) are percent-encoded
 * as `%25eth0` per RFC 6874 inside the brackets. Raw unbracketed hosts are
 * still used only for `server.listen` binds.
 *
 * Must NOT import better-sqlite3 or relay server state: this module is safe
 * to import from both the relay child process and the E2E launcher process
 * (which must stay ABI-neutral).
 */
import { isIP } from 'node:net'

/**
 * Normalize a relay bind host to the raw form Node `server.listen()` expects.
 *
 * Removes exactly one outer bracket pair (`[::1]` -> `::1`) so URL-bracketed
 * IPv6 literals bind correctly. Raw IPv4/hostname loopback values
 * (`127.0.0.1`, `localhost`) and unbracketed IPs pass through unchanged.
 * Zone suffixes are NOT stripped here: callers reject them via the existing
 * wildcard/zone policy. Throws on malformed bracket forms (missing close,
 * trailing junk, empty, or nested brackets).
 */
export function normalizeRelayBindHost(host: string): string {
  const raw = host.trim()
  if (!raw.includes('[') && !raw.includes(']')) return raw
  if (!(raw.startsWith('[') && raw.endsWith(']'))) {
    throw new Error(`invalid --host '${raw.slice(0, 64)}' (malformed bracketed IPv6 literal; use raw addr or [addr])`)
  }
  const inner = raw.slice(1, -1)
  if (inner.length === 0 || inner.includes('[') || inner.includes(']')) {
    throw new Error(`invalid --host '${raw.slice(0, 64)}' (malformed bracketed IPv6 literal; use raw addr or [addr])`)
  }
  return inner
}

export function formatRelayHostForUrl(host: string): string {
  const raw = host.trim()
  let addr: string
  let zone: string
  let hadZoneMarker = false
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    if (close !== -1) {
      // Zone may sit inside (`[fe80::1%eth0]`) or trail outside (`[::]%eth0`).
      let inner = raw.slice(1, close)
      const pctIn = inner.indexOf('%')
      let innerZone = ''
      if (pctIn !== -1) {
        hadZoneMarker = true
        innerZone = inner.slice(pctIn + 1)
        inner = inner.slice(0, pctIn)
      }
      const trailing = raw.slice(close + 1)
      const outerZone = trailing.startsWith('%') ? trailing.slice(1) : ''
      if (trailing.startsWith('%')) hadZoneMarker = true
      addr = inner
      zone = innerZone || outerZone
    } else {
      const pct = raw.indexOf('%')
      hadZoneMarker = pct !== -1
      zone = pct !== -1 ? raw.slice(pct + 1) : ''
      addr = pct !== -1 ? raw.slice(0, pct) : raw
    }
  } else {
    const pct = raw.indexOf('%')
    hadZoneMarker = pct !== -1
    zone = pct !== -1 ? raw.slice(pct + 1) : ''
    addr = pct !== -1 ? raw.slice(0, pct) : raw
  }
  if (isIP(addr) === 6) {
    // Fail-closed on empty zone (`fe80::1%`): keep the raw zone marker out of
    // the URL rather than emitting a trailing bare `%`.
    const zoneSuffix = zone ? `%25${zone}` : hadZoneMarker ? '%25' : ''
    return `[${addr}${zoneSuffix}]`
  }
  return raw
}
