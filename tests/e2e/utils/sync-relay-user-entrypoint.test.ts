/**
 * Focused launcher-contract tests for the user-entrypoint relay launcher.
 *
 * Covers the transport gate: both plain HTTP and native HTTPS are explicit
 * supported transports, so an explicitly supplied non-loopback host without
 * cert/key is accepted (plain HTTP, unencrypted — the client warns), while
 * default loopback, explicit loopback, and LAN with cert/key remain valid.
 * Never spawns a relay child.
 */
import { describe, expect, it } from 'vitest'

import { assertUserRelayHostTlsConfig, resolveUserRelayUrlHost } from './sync-relay-user-entrypoint'
import { formatRelayHostForUrl } from '../../../scripts/sync-relay/relayHost'

const LAN_HOST = '192.168.1.10'

describe('sync-relay-user-entrypoint transport gate', () => {
  it('accepts an explicit non-loopback host without cert/key (plain HTTP transport)', () => {
    expect(() => assertUserRelayHostTlsConfig(LAN_HOST, false, true)).not.toThrow()
  })

  it('preserves default loopback without cert/key', () => {
    expect(() => assertUserRelayHostTlsConfig('127.0.0.1', false, false)).not.toThrow()
  })

  it('preserves explicit loopback without cert/key', () => {
    expect(() => assertUserRelayHostTlsConfig('127.0.0.1', false, true)).not.toThrow()
    expect(() => assertUserRelayHostTlsConfig('localhost', false, true)).not.toThrow()
  })

  it('preserves LAN HTTPS with cert/key', () => {
    expect(() => assertUserRelayHostTlsConfig(LAN_HOST, true, true)).not.toThrow()
  })
})

describe('sync-relay-user-entrypoint localhost readiness contract', () => {
  function buildReadyRe(scheme: 'http' | 'https', advertisedHostRaw: string): RegExp {
    const urlHost = formatRelayHostForUrl(advertisedHostRaw)
    const escapedHost = urlHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\[sync-relay\\] listening on ${scheme}://${escapedHost}:(\\d+)`)
  }

  it('canonicalizes explicit localhost loopback to 127.0.0.1 for readiness/endpoint', () => {
    expect(resolveUserRelayUrlHost('localhost')).toBe('127.0.0.1')
    expect(resolveUserRelayUrlHost('127.0.0.1')).toBe('127.0.0.1')
    expect(formatRelayHostForUrl(resolveUserRelayUrlHost('localhost'))).toBe('127.0.0.1')
  })

  it('explicit localhost readiness matches the production 127.0.0.1 line', () => {
    const readyRe = buildReadyRe('http', resolveUserRelayUrlHost('localhost'))
    const productionLine = '[sync-relay] listening on http://127.0.0.1:4123'
    const match = readyRe.exec(productionLine)
    expect(match?.[1]).toBe('4123')
    expect(readyRe.exec('[sync-relay] listening on http://localhost:4123')).toBeNull()
    expect(`http://${formatRelayHostForUrl(resolveUserRelayUrlHost('localhost'))}:4123`).toBe('http://127.0.0.1:4123')
  })

  it('preserves explicit 127.0.0.1, LAN HTTPS, and IPv6 URL formatting', () => {
    expect(resolveUserRelayUrlHost('127.0.0.1')).toBe('127.0.0.1')
    expect(resolveUserRelayUrlHost(LAN_HOST)).toBe(LAN_HOST)
    expect(formatRelayHostForUrl(resolveUserRelayUrlHost(LAN_HOST))).toBe(LAN_HOST)
    expect(
      buildReadyRe('https', resolveUserRelayUrlHost(LAN_HOST)).exec(
        `[sync-relay] listening on https://${LAN_HOST}:4124`
      )?.[1]
    ).toBe('4124')
    expect(formatRelayHostForUrl(resolveUserRelayUrlHost('::1'))).toBe('[::1]')
  })
})
