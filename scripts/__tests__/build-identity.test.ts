import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BUILD_ID_ENV,
  BUILD_VERSION_ENV,
  buildEnv,
  buildIdentity,
  formatUtcTimestamp,
  spawnBuildCommand,
  UNAVAILABLE_SHA_MARKER
} from '../build-identity'

const REPO_ROOT = process.cwd()

describe('buildIdentity — deterministic formatting (VERSION-003)', () => {
  it('is deterministic for injected inputs', () => {
    const input = { timestamp: new Date('2026-08-07T08:16:37Z'), sha: 'abcdef1', dirty: false }
    expect(buildIdentity(input)).toEqual(buildIdentity(input))
  })

  it('formats the injected UTC timestamp into the Build ID', () => {
    const identity = buildIdentity({ timestamp: new Date('2026-08-07T08:16:37Z'), sha: 'abcdef1', dirty: false })
    expect(identity.utcTimestamp).toBe('20260807081637000')
    expect(identity.buildId).toBe('20260807081637000-abcdef1')
    expect(identity.shortSha).toBe('abcdef1')
    expect(identity.shaUnavailable).toBe(false)
  })

  it('always renders UTC fields regardless of the local timezone', () => {
    const timestamp = new Date('2026-08-07T08:16:37Z')
    const identity = buildIdentity({ timestamp, sha: 'abcdef1' })
    expect(identity.utcTimestamp).toBe('20260807081637000')
    expect(formatUtcTimestamp(timestamp)).toBe('20260807081637000')
    // Cross-check: the UTC wall-clock of the instant is 08:16:37, not the local render.
    expect(timestamp.getUTCHours()).toBe(8)
    expect(identity.utcTimestamp).toMatch(/^2026080708/)
  })

  it('appends a dirty marker when dirty and omits it when clean', () => {
    const timestamp = new Date('2026-08-07T08:16:37Z')
    expect(buildIdentity({ timestamp, sha: 'abcdef1', dirty: true }).buildId).toBe('20260807081637000-abcdef1-dirty')
    expect(buildIdentity({ timestamp, sha: 'abcdef1', dirty: false }).buildId).toBe('20260807081637000-abcdef1')
  })

  it('normalizes a long SHA to the short form', () => {
    // Neutral 40-hex fixture — deliberately unrelated to any real commit in
    // this repository so the assertion stays migration-portable.
    const neutralLongSha = '0123456789abcdef0123456789abcdef01234567'
    const identity = buildIdentity({
      timestamp: new Date(0),
      sha: neutralLongSha
    })
    expect(identity.shortSha).toBe('0123456')
    expect(identity.buildId).toBe('19700101000000000-0123456')
  })

  it('distinguishes builds started within the same wall-clock second (ms component)', () => {
    const sameSecondA = buildIdentity({ timestamp: new Date('2026-08-07T08:16:37.000Z'), sha: 'abcdef1', dirty: false })
    const sameSecondB = buildIdentity({ timestamp: new Date('2026-08-07T08:16:37.123Z'), sha: 'abcdef1', dirty: false })
    expect(sameSecondA.utcTimestamp).toBe('20260807081637000')
    expect(sameSecondB.utcTimestamp).toBe('20260807081637123')
    expect(sameSecondA.buildId).not.toBe(sameSecondB.buildId)
    expect(sameSecondA.buildId).toBe('20260807081637000-abcdef1')
    expect(sameSecondB.buildId).toBe('20260807081637123-abcdef1')
  })

  it('produces filename-safe Build IDs for all SHA/dirty combinations', () => {
    const timestamp = new Date('2026-08-07T08:16:37Z')
    for (const sha of ['abcdef1', 'a1b2c3', null, undefined]) {
      for (const dirty of [true, false]) {
        const id = buildIdentity({ timestamp, sha, dirty }).buildId
        expect(id).toMatch(/^[A-Za-z0-9-]+$/)
      }
    }
  })

  it('degrades clearly when Git metadata is unavailable', () => {
    const identity = buildIdentity({ timestamp: new Date('2026-08-07T08:16:37Z'), sha: null, dirty: true })
    expect(identity.shaUnavailable).toBe(true)
    expect(identity.shortSha).toBe(UNAVAILABLE_SHA_MARKER)
    expect(identity.dirty).toBe(false)
    // Explicit degraded marker, no dirty claim, and never a fabricated hex SHA.
    expect(identity.buildId).toBe(`20260807081637000-${UNAVAILABLE_SHA_MARKER}`)
    expect(identity.buildId).not.toContain('dirty')
    expect(identity.buildId).not.toMatch(/-[0-9a-f]{7}$/)
  })

  it('produces a numeric macOS build version from the same UTC timestamp', () => {
    const identity = buildIdentity({ timestamp: new Date('2026-08-07T08:16:37Z'), sha: 'abcdef1', dirty: true })
    expect(identity.macBuildVersion).toBe('20260807081637000')
    expect(identity.macBuildVersion).toMatch(/^\d+$/)
    expect(identity.macBuildVersion).toBe(identity.utcTimestamp)
  })

  it('accepts epoch-millis and ISO-string timestamps', () => {
    expect(formatUtcTimestamp(Date.parse('2026-08-07T08:16:37Z'))).toBe('20260807081637000')
    expect(formatUtcTimestamp('2026-08-07T08:16:37Z')).toBe('20260807081637000')
    expect(formatUtcTimestamp(new Date('2026-08-07T08:16:37Z'))).toBe('20260807081637000')
  })
})

describe('build identity env bridge — one identity per build invocation (VERSION-003)', () => {
  it('exposes the same buildId and buildVersion to every consumer', () => {
    const identity = buildIdentity({ timestamp: new Date('2026-08-07T08:16:37Z'), sha: 'abcdef1', dirty: true })
    const env = buildEnv(identity)
    expect(env[BUILD_ID_ENV]).toBe('20260807081637000-abcdef1-dirty')
    expect(env[BUILD_VERSION_ENV]).toBe('20260807081637000')
  })

  it('spawns a child that observes the exact same build identity', () => {
    const identity = buildIdentity({ timestamp: new Date('2026-08-07T08:16:37Z'), sha: 'abcdef1', dirty: true })
    const probe = `node -e "console.log(process.env['${BUILD_ID_ENV}'] + '|' + process.env['${BUILD_VERSION_ENV}'])"`
    const { status, stdout } = spawnBuildCommand(probe, identity, false)
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('20260807081637000-abcdef1-dirty|20260807081637000')
  })
})

describe('root product version (VERSION-002)', () => {
  it('is exactly 0.1.0 in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.1.0')
  })
})
