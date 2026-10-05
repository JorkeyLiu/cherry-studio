import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildRelayServerArgs,
  formatRelayEndpointLine,
  needsRelayInstall,
  relayEndpointUrl,
  relayMirrorPlan,
  relayServerEntry
} from '../relay-runtime'

let owned: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dev-sync-relay-'))
  owned.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true })
  owned = []
})

describe('relayMirrorPlan', () => {
  it('mirrors only relay sources, shared contracts, and the deploy manifest/lock', () => {
    const plan = relayMirrorPlan('/repo', '/repo/local/dev-sync/relay-runtime')
    const froms = plan.map((p) => p.from)
    expect(froms).toEqual([
      join('/repo', 'scripts', 'sync-relay'),
      join('/repo', 'packages', 'shared'),
      join('/repo', 'deploy', 'sync-relay', 'package.json'),
      join('/repo', 'deploy', 'sync-relay', 'pnpm-lock.yaml')
    ])
    // Same relative layout so the relay relative imports keep working.
    expect(plan[0].to).toBe(join('/repo/local/dev-sync/relay-runtime', 'scripts', 'sync-relay'))
    expect(plan[1].to).toBe(join('/repo/local/dev-sync/relay-runtime', 'packages', 'shared'))
    // Never the root install, the Electron app, or a production profile.
    expect(froms.join('\n')).not.toMatch(/node_modules|Cherry/)
  })
})

describe('needsRelayInstall', () => {
  const current = { currentManifestHash: 'm1', currentLockHash: 'l1' }
  it('installs when the binding is missing or the manifest/lock drifted', () => {
    expect(
      needsRelayInstall({ bindingExists: false, installedManifestHash: 'm1', installedLockHash: 'l1', ...current })
    ).toBe(true)
    expect(
      needsRelayInstall({ bindingExists: true, installedManifestHash: 'm0', installedLockHash: 'l1', ...current })
    ).toBe(true)
    expect(
      needsRelayInstall({ bindingExists: true, installedManifestHash: 'm1', installedLockHash: null, ...current })
    ).toBe(true)
    expect(
      needsRelayInstall({ bindingExists: true, installedManifestHash: 'm1', installedLockHash: 'l1', ...current })
    ).toBe(false)
  })
})

describe('redacted relay output', () => {
  it('carries only the safe loopback endpoint: no shared token exists', () => {
    const line = formatRelayEndpointLine('127.0.0.1', 3039)
    expect(line).toContain('http://127.0.0.1:3039')
    expect(line).not.toMatch(/[0-9a-f]{32,}/)
    expect(line).not.toMatch(/token: persistent file/i)
    expect(line).toMatch(/no shared token/)
    expect(relayEndpointUrl('127.0.0.1', 3039)).toBe('http://127.0.0.1:3039')
  })

  it('builds relay argv without any secret material', () => {
    const args = buildRelayServerArgs('/data/relay.db', '127.0.0.1', 3039)
    expect(args).toEqual(['--host', '127.0.0.1', '--port', '3039', '--db', '/data/relay.db'])
    expect(args.join(' ')).not.toMatch(/token|bearer|secret/i)
  })

  it('resolves the mirrored entrypoint and fails when the mirror did not run', () => {
    const dir = makeDir()
    expect(() => relayServerEntry(dir)).toThrow(/mirror step did not run/)
    mkdirSync(join(dir, 'scripts', 'sync-relay'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'sync-relay', 'server.ts'), '// relay')
    expect(relayServerEntry(dir).endsWith(join('scripts', 'sync-relay', 'server.ts'))).toBe(true)
  })
})
