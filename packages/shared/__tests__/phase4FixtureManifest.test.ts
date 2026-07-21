/**
 * Tests for Phase 4.0-B fixture manifest validation, path safety,
 * and fixture metadata.
 *
 * Pure-function tests. No binary LevelDB artifacts or user-derived data.
 */
import { describe, expect, it } from 'vitest'

import {
  buildFixtureManifest,
  FIXTURE_IDS,
  type FixtureDonePayload,
  type FixtureManifest,
  isValidFixtureId,
  validateDestinationRoot,
  validateFixtureDonePayload,
  validateFixtureManifest,
  validateTempPath,
  validateVerifyDonePayload,
  validateVerifyPreflight
} from '../phase4FixtureManifest'

/* ── Helpers ── */

function validManifest(): FixtureManifest {
  return {
    fixtureId: 'v4',
    createdAt: '2024-01-15T10:00:00.000Z',
    logicalDexieVersion: 4,
    expectedNativeVersion: 40,
    observedNativeVersion: 40,
    originUrl: 'file:///tmp/test/phase4Spike.html',
    originClass: 'file',
    sourceRoot: '/tmp/phase4-spike-test-123/fixture-session',
    markers: {},
    localStorage: {},
    tables: ['files', 'topics', 'settings'],
    recordCounts: { files: 2, topics: 3, settings: 3 },
    limitations: ['Synthetic data only.'],
    files: [{ relativePath: 'IndexedDB/file__0.indexeddb.leveldb/000001.ldb', sizeBytes: 1024 }]
  }
}

function validPayload(): FixtureDonePayload {
  return {
    fixtureId: 'v11a',
    logicalDexieVersion: 11,
    observedNativeVersion: 110,
    markers: { 'phase4:marker': 'A' },
    localStorage: { 'phase4:marker': 'A' },
    tables: ['files', 'topics', 'settings', 'message_blocks'],
    recordCounts: { files: 1, topics: 1, settings: 2, message_blocks: 1 },
    limitations: ['Current-schema fixture.']
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * FIXTURE_IDS constant
 * ══════════════════════════════════════════════════════════════════════════ */

describe('FIXTURE_IDS', () => {
  it('contains exactly v4, v11a, v11b, v12', () => {
    expect([...FIXTURE_IDS]).toEqual(['v4', 'v11a', 'v11b', 'v12'])
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * isValidFixtureId
 * ══════════════════════════════════════════════════════════════════════════ */

describe('isValidFixtureId', () => {
  it.each(['v4', 'v11a', 'v11b', 'v12'])(`accepts %s`, (id) => {
    expect(isValidFixtureId(id)).toBe(true)
  })

  it.each(['V4', 'v11', 'v11A', 'v11B', 'V12', '', 'random', null, undefined, 42])('rejects %p', (id) => {
    expect(isValidFixtureId(id)).toBe(false)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * validateFixtureManifest
 * ══════════════════════════════════════════════════════════════════════════ */

describe('validateFixtureManifest', () => {
  it('accepts a valid v4 manifest', () => {
    expect(validateFixtureManifest(validManifest())).toEqual({ valid: true })
  })

  it('accepts a valid v11a manifest', () => {
    const m = {
      ...validManifest(),
      fixtureId: 'v11a',
      logicalDexieVersion: 11,
      expectedNativeVersion: 110,
      observedNativeVersion: 110
    }
    expect(validateFixtureManifest(m)).toEqual({ valid: true })
  })

  it('accepts a valid v12 manifest', () => {
    const m = {
      ...validManifest(),
      fixtureId: 'v12',
      logicalDexieVersion: 12,
      expectedNativeVersion: 120,
      observedNativeVersion: 120
    }
    expect(validateFixtureManifest(m)).toEqual({ valid: true })
  })

  it('accepts manifest with empty markers and localStorage', () => {
    const m = { ...validManifest(), markers: {}, localStorage: {} }
    expect(validateFixtureManifest(m)).toEqual({ valid: true })
  })

  it('accepts manifest with empty files array', () => {
    const m = { ...validManifest(), files: [] }
    expect(validateFixtureManifest(m)).toEqual({ valid: true })
  })

  // Rejection: non-object
  it('rejects null', () => {
    expect(validateFixtureManifest(null).valid).toBe(false)
  })

  it('rejects undefined', () => {
    expect(validateFixtureManifest(undefined).valid).toBe(false)
  })

  it('rejects a string', () => {
    expect(validateFixtureManifest('not-an-object').valid).toBe(false)
  })

  it('rejects an array', () => {
    expect(validateFixtureManifest([validManifest()]).valid).toBe(false)
  })

  // Rejection: missing/invalid fixtureId
  it('rejects missing fixtureId', () => {
    const { fixtureId: _, ...rest } = validManifest()
    expect(validateFixtureManifest(rest).valid).toBe(false)
  })

  it('rejects empty fixtureId', () => {
    expect(validateFixtureManifest({ ...validManifest(), fixtureId: '' }).valid).toBe(false)
  })

  it('rejects unknown fixtureId', () => {
    expect(validateFixtureManifest({ ...validManifest(), fixtureId: 'v99' }).valid).toBe(false)
  })

  // Rejection: missing/invalid createdAt
  it('rejects missing createdAt', () => {
    const { createdAt: _, ...rest } = validManifest()
    expect(validateFixtureManifest(rest).valid).toBe(false)
  })

  it('rejects invalid ISO timestamp', () => {
    expect(validateFixtureManifest({ ...validManifest(), createdAt: 'not-a-date' }).valid).toBe(false)
  })

  // Rejection: versions
  it('rejects missing logicalDexieVersion', () => {
    const { logicalDexieVersion: _, ...rest } = validManifest()
    expect(validateFixtureManifest(rest).valid).toBe(false)
  })

  it('rejects negative logicalDexieVersion', () => {
    expect(validateFixtureManifest({ ...validManifest(), logicalDexieVersion: -1 }).valid).toBe(false)
  })

  it('rejects zero observedNativeVersion', () => {
    expect(validateFixtureManifest({ ...validManifest(), observedNativeVersion: 0 }).valid).toBe(false)
  })

  // Rejection: origin
  it('rejects missing originUrl', () => {
    const { originUrl: _, ...rest } = validManifest()
    expect(validateFixtureManifest(rest).valid).toBe(false)
  })

  it('rejects non-file originClass', () => {
    expect(validateFixtureManifest({ ...validManifest(), originClass: 'https' }).valid).toBe(false)
  })

  // Rejection: tables
  it('rejects empty tables', () => {
    expect(validateFixtureManifest({ ...validManifest(), tables: [] }).valid).toBe(false)
  })

  it('rejects non-array tables', () => {
    expect(validateFixtureManifest({ ...validManifest(), tables: 'files' }).valid).toBe(false)
  })

  // Rejection: files entries
  it('rejects files entry missing relativePath', () => {
    expect(validateFixtureManifest({ ...validManifest(), files: [{ sizeBytes: 100 }] }).valid).toBe(false)
  })

  it('rejects files entry missing sizeBytes', () => {
    expect(validateFixtureManifest({ ...validManifest(), files: [{ relativePath: 'a.ldb' }] }).valid).toBe(false)
  })

  it('rejects files entry with negative sizeBytes', () => {
    expect(
      validateFixtureManifest({
        ...validManifest(),
        files: [{ relativePath: 'a.ldb', sizeBytes: -1 }]
      }).valid
    ).toBe(false)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * validateFixtureDonePayload
 * ══════════════════════════════════════════════════════════════════════════ */

describe('validateFixtureDonePayload', () => {
  it('accepts a valid payload', () => {
    expect(validateFixtureDonePayload(validPayload())).toEqual({ valid: true })
  })

  it('rejects null', () => {
    expect(validateFixtureDonePayload(null).valid).toBe(false)
  })

  it('rejects missing fixtureId', () => {
    const { fixtureId: _, ...rest } = validPayload()
    expect(validateFixtureDonePayload(rest).valid).toBe(false)
  })

  it('rejects unknown fixtureId in payload', () => {
    expect(validateFixtureDonePayload({ ...validPayload(), fixtureId: 'invalid' }).valid).toBe(false)
  })

  it('rejects missing tables', () => {
    const { tables: _, ...rest } = validPayload()
    expect(validateFixtureDonePayload(rest).valid).toBe(false)
  })

  it('rejects empty tables', () => {
    expect(validateFixtureDonePayload({ ...validPayload(), tables: [] }).valid).toBe(false)
  })

  it('rejects missing recordCounts', () => {
    const { recordCounts: _, ...rest } = validPayload()
    expect(validateFixtureDonePayload(rest).valid).toBe(false)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * validateTempPath
 * ══════════════════════════════════════════════════════════════════════════ */

describe('validateTempPath', () => {
  const tmpDir = '/tmp'

  it('accepts path under /tmp', () => {
    expect(validateTempPath('/tmp/phase4-spike-123/session', tmpDir)).toEqual({ valid: true })
  })

  it('accepts /tmp itself', () => {
    expect(validateTempPath('/tmp', tmpDir)).toEqual({ valid: true })
  })

  it('rejects path outside /tmp', () => {
    expect(validateTempPath('/home/user/data', tmpDir).valid).toBe(false)
  })

  it('rejects path that looks like /tmp but is not', () => {
    expect(validateTempPath('/tmp-evil/data', tmpDir).valid).toBe(false)
  })

  it('rejects absolute path to system directory', () => {
    expect(validateTempPath('/etc/passwd', tmpDir).valid).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validateTempPath('', tmpDir).valid).toBe(false)
  })

  it('rejects traversal that escapes /tmp', () => {
    expect(validateTempPath('/tmp/../../../etc/passwd', tmpDir).valid).toBe(false)
  })

  it('resolves traversal within /tmp', () => {
    // /tmp/../tmp/foo resolves to /tmp/foo which IS under /tmp
    expect(validateTempPath('/tmp/../tmp/foo', tmpDir)).toEqual({ valid: true })
  })

  it('rejects path to /var/tmp (different from /tmp)', () => {
    expect(validateTempPath('/var/tmp/data', tmpDir).valid).toBe(false)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * validateDestinationRoot
 * ══════════════════════════════════════════════════════════════════════════ */

describe('validateDestinationRoot', () => {
  const parent = '/tmp/phase4-fixtures-staging'

  it('accepts valid subdirectory', () => {
    expect(validateDestinationRoot('/tmp/phase4-fixtures-staging/v4', parent)).toEqual({ valid: true })
  })

  it('rejects destination equal to parent', () => {
    expect(validateDestinationRoot(parent, parent).valid).toBe(false)
  })

  it('rejects destination outside parent', () => {
    expect(validateDestinationRoot('/tmp/other/v4', parent).valid).toBe(false)
  })

  it('rejects destination with traversal escaping parent', () => {
    expect(validateDestinationRoot('/tmp/phase4-fixtures-staging/../../../etc', parent).valid).toBe(false)
  })

  it('rejects absolute system path', () => {
    expect(validateDestinationRoot('/etc/cron.d', parent).valid).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validateDestinationRoot('', parent).valid).toBe(false)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * buildFixtureManifest
 * ══════════════════════════════════════════════════════════════════════════ */

describe('buildFixtureManifest', () => {
  it('builds a valid manifest from payload + metadata', () => {
    const payload = validPayload()
    const sourceRoot = '/tmp/phase4-test/session'
    const originUrl = 'file:///tmp/phase4-test/phase4Spike.html'
    const files = [{ relativePath: 'IndexedDB/test.ldb', sizeBytes: 512 }]

    const manifest = buildFixtureManifest(payload, sourceRoot, originUrl, files)

    expect(manifest.fixtureId).toBe('v11a')
    expect(manifest.logicalDexieVersion).toBe(11)
    expect(manifest.expectedNativeVersion).toBe(110) // Dexie 4: native = logical * 10
    expect(manifest.observedNativeVersion).toBe(110)
    expect(manifest.originUrl).toBe(originUrl)
    expect(manifest.originClass).toBe('file')
    expect(manifest.sourceRoot).toBe(sourceRoot)
    expect(manifest.markers).toEqual({ 'phase4:marker': 'A' })
    expect(manifest.tables).toEqual(['files', 'topics', 'settings', 'message_blocks'])
    expect(manifest.files).toEqual(files)
    expect(manifest.limitations.length).toBeGreaterThan(0)
    // Should include the Dexie 4 native version note
    expect(manifest.limitations.some((l) => l.includes('Dexie 4'))).toBe(true)
  })

  it('sets createdAt to a valid ISO timestamp', () => {
    const manifest = buildFixtureManifest(validPayload(), '/tmp/test', 'file:///tmp/test.html', [])
    expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt)
  })

  it('produces a valid manifest per validateFixtureManifest', () => {
    const manifest = buildFixtureManifest(validPayload(), '/tmp/test', 'file:///tmp/test.html', [
      { relativePath: 'IndexedDB/test.ldb', sizeBytes: 100 }
    ])
    expect(validateFixtureManifest(manifest)).toEqual({ valid: true })
  })

  it('uses logicalDexieVersion * 10 as expectedNativeVersion (Dexie 4 multiplier)', () => {
    const payload4: FixtureDonePayload = {
      ...validPayload(),
      fixtureId: 'v4',
      logicalDexieVersion: 4,
      observedNativeVersion: 40
    }
    const manifest = buildFixtureManifest(payload4, '/tmp/test', 'file:///tmp/test.html', [])
    expect(manifest.expectedNativeVersion).toBe(40)
  })

  it('throws when observedNativeVersion does not match expected', () => {
    const badPayload: FixtureDonePayload = { ...validPayload(), observedNativeVersion: 11 }
    expect(() => buildFixtureManifest(badPayload, '/tmp/test', 'file:///tmp/test.html', [])).toThrow(
      /Native version mismatch/
    )
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Phase 4.0-C1 Validation Tests
 * ══════════════════════════════════════════════════════════════════════════ */

function validPreflight() {
  return {
    locationHref: 'file:///tmp/test/phase4Spike.html',
    locationOrigin: 'file://',
    nativeVersion: 40,
    expectedVersion: 40,
    cherryStudioFound: true
  }
}

function validVerifyPayload() {
  return {
    fixtureId: 'v4' as const,
    preflight: validPreflight(),
    productionOpenerStarted: true,
    productionOpenerCompleted: true,
    futureVersionRejected: false
  }
}

describe('validateVerifyPreflight', () => {
  it('accepts a valid preflight', () => {
    expect(validateVerifyPreflight(validPreflight())).toEqual({ valid: true })
  })

  it('rejects null', () => {
    expect(validateVerifyPreflight(null).valid).toBe(false)
  })

  it('rejects missing locationHref', () => {
    const { locationHref: _, ...rest } = validPreflight()
    expect(validateVerifyPreflight(rest).valid).toBe(false)
  })

  it('rejects missing cherryStudioFound', () => {
    const { cherryStudioFound: _, ...rest } = validPreflight()
    expect(validateVerifyPreflight(rest).valid).toBe(false)
  })

  it('rejects non-boolean cherryStudioFound', () => {
    expect(validateVerifyPreflight({ ...validPreflight(), cherryStudioFound: 'yes' }).valid).toBe(false)
  })
})

describe('validateVerifyDonePayload', () => {
  it('accepts a valid v4 payload', () => {
    expect(validateVerifyDonePayload(validVerifyPayload())).toEqual({ valid: true })
  })

  it('accepts a valid v12 rejected payload', () => {
    const payload = {
      ...validVerifyPayload(),
      fixtureId: 'v12' as const,
      productionOpenerStarted: false,
      productionOpenerCompleted: false,
      futureVersionRejected: true,
      preflight: { ...validPreflight(), nativeVersion: 120, expectedVersion: 120 }
    }
    expect(validateVerifyDonePayload(payload)).toEqual({ valid: true })
  })

  it('rejects null', () => {
    expect(validateVerifyDonePayload(null).valid).toBe(false)
  })

  it('rejects missing fixtureId', () => {
    const { fixtureId: _, ...rest } = validVerifyPayload()
    expect(validateVerifyDonePayload(rest).valid).toBe(false)
  })

  it('rejects unknown fixtureId', () => {
    expect(validateVerifyDonePayload({ ...validVerifyPayload(), fixtureId: 'v99' }).valid).toBe(false)
  })

  it('rejects missing productionOpenerStarted', () => {
    const { productionOpenerStarted: _, ...rest } = validVerifyPayload()
    expect(validateVerifyDonePayload(rest).valid).toBe(false)
  })

  it('rejects invalid preflight', () => {
    expect(validateVerifyDonePayload({ ...validVerifyPayload(), preflight: {} }).valid).toBe(false)
  })
})
