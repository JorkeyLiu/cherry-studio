import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

/**
 * Focused tests for scripts/assert-build-identity-env.js — the packaging-side
 * fail-fast guard that rejects a PARTIAL build identity environment
 * (re-audit Finding A). The build-identity wrapper always sets
 * CHERRY_CHAT_BUILD_ID / CHERRY_CHAT_BUILD_VERSION together from one capture;
 * electron-vite (compile path) treats a partial env as absent and recomputes
 * both halves, but the electron-builder artifact-name macro and
 * apply-build-version would consume a raw partial env and produce a split
 * identity. This guard runs from the beforePack hook before electron-builder
 * evaluates the artifactName macro or writes any artifact.
 */

const BUILD_ID_ENV = 'CHERRY_CHAT_BUILD_ID'
const BUILD_VERSION_ENV = 'CHERRY_CHAT_BUILD_VERSION'

interface GuardModule {
  assertBuildIdentityEnv: () => void
  BUILD_ID_ENV: string
  BUILD_VERSION_ENV: string
}

async function loadGuard(): Promise<GuardModule> {
  return (await import('../assert-build-identity-env.js')) as unknown as GuardModule
}

describe('assert-build-identity-env packaging guard (VERSION-003 / Finding A)', () => {
  afterEach(() => {
    delete process.env[BUILD_ID_ENV]
    delete process.env[BUILD_VERSION_ENV]
  })

  it('fails clearly when only CHERRY_CHAT_BUILD_ID is present', async () => {
    process.env[BUILD_ID_ENV] = '20260807081637000-abcdef1'
    const guard = await loadGuard()
    expect(() => guard.assertBuildIdentityEnv()).toThrow(/split environment/)
    expect(() => guard.assertBuildIdentityEnv()).toThrow(BUILD_ID_ENV)
    expect(() => guard.assertBuildIdentityEnv()).toThrow(BUILD_VERSION_ENV)
  })

  it('fails clearly when only CHERRY_CHAT_BUILD_VERSION is present', async () => {
    process.env[BUILD_VERSION_ENV] = '20260807081637000'
    const guard = await loadGuard()
    expect(() => guard.assertBuildIdentityEnv()).toThrow(/split environment/)
    expect(() => guard.assertBuildIdentityEnv()).toThrow(BUILD_ID_ENV)
    expect(() => guard.assertBuildIdentityEnv()).toThrow(BUILD_VERSION_ENV)
  })

  it('fails on the exact-one-present split with an actionable message', async () => {
    process.env[BUILD_ID_ENV] = '20260807081637000-abcdef1'
    const guard = await loadGuard()
    expect(() => guard.assertBuildIdentityEnv()).toThrow(/split environment/)
    // The supported wrapper syntax is exactly: dotenv -- tsx scripts/build-identity.ts --spawn "..."
    expect(() => guard.assertBuildIdentityEnv()).toThrow('dotenv -- tsx scripts/build-identity.ts --spawn "')
  })

  it('passes when both halves are present (supported wrapper path)', async () => {
    process.env[BUILD_ID_ENV] = '20260807081637000-abcdef1'
    process.env[BUILD_VERSION_ENV] = '20260807081637000'
    const guard = await loadGuard()
    expect(() => guard.assertBuildIdentityEnv()).not.toThrow()
  })

  it('passes when neither half is present (preserve degraded path)', async () => {
    const guard = await loadGuard()
    expect(() => guard.assertBuildIdentityEnv()).not.toThrow()
  })

  it('treats empty-string halves as unset, matching compile-path truthiness', async () => {
    process.env[BUILD_ID_ENV] = ''
    process.env[BUILD_VERSION_ENV] = '20260807081637000'
    const guard = await loadGuard()
    expect(() => guard.assertBuildIdentityEnv()).toThrow(/split environment/)
  })

  it('is wired as the first step of the beforePack hook', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'before-pack.js'), 'utf8')
    const requireIdx = source.indexOf(`require('./assert-build-identity-env.js')`)
    const guardCall = source.indexOf('assertBuildIdentityEnv()')
    const applyCall = source.indexOf('applyBuildVersion(context)')
    expect(requireIdx, 'before-pack.js requires the guard module').toBeGreaterThan(-1)
    expect(guardCall, 'before-pack.js invokes the guard').toBeGreaterThan(-1)
    expect(guardCall, 'guard require precedes its invocation').toBeGreaterThan(requireIdx)
    expect(guardCall, 'guard runs before apply-build-version').toBeLessThan(applyCall)
  })
})
