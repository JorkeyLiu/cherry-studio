/**
 * Focused launcher-contract tests for the user-entrypoint relay launcher.
 *
 * Covers only the pre-spawn TLS gate: an explicitly supplied non-loopback
 * host without cert/key fails immediately (no child spawned, no DB created),
 * while default loopback, explicit loopback, and LAN HTTPS with cert/key
 * remain valid. Never spawns a relay child.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createOwnedTmpRoot, removeOwnedTmpRoot } from './run-ownership'
import {
  assertUserRelayHostTlsConfig,
  getUserRelayHandle,
  resolveUserRelayUrlHost,
  startUserEntrypointRelay
} from './sync-relay-user-entrypoint'
import { formatRelayHostForUrl } from '../../../scripts/sync-relay/relayHost'

const LAN_HOST = '192.168.1.10'
const DB_FILE = 'launcher-gate-invalid.db'

let ownedTmpRoot: string | null = null

afterEach(async () => {
  if (ownedTmpRoot) {
    const root = ownedTmpRoot
    ownedTmpRoot = null
    await removeOwnedTmpRoot(root, [])
  }
})

describe('sync-relay-user-entrypoint TLS gate', () => {
  it('rejects an explicit non-loopback host without cert/key', () => {
    expect(() => assertUserRelayHostTlsConfig(LAN_HOST, false, true)).toThrow(
      /non-loopback host requires certPath and keyPath/
    )
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

  it('launcher fails before spawn without creating a child/DB', async () => {
    ownedTmpRoot = createOwnedTmpRoot()
    const root = ownedTmpRoot
    const error = await startUserEntrypointRelay({
      ownedTmpRoot: root,
      token: 'launcher-gate-token',
      host: LAN_HOST,
      dbFileName: DB_FILE
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/non-loopback host requires certPath and keyPath/)
    expect(getUserRelayHandle(error)).toBeNull()
    for (const target of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`]) {
      expect(fs.existsSync(path.join(root, target))).toBe(false)
    }
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
