/**
 * Catalog rollback snapshot primitives (LOCK-PROMO-5, LOCK-ART-5).
 *
 * Covers:
 * - Wire validation: valid row/payload shapes, every bad-field rejection,
 *   duplicate-id rejection (byte-identical restore requires a PK set).
 * - buildCatalogSnapshotWire integrity determinism (order-independent).
 * - Durable write: atomic staging → rename, 0600 privacy mode, read-back
 *   confirmation, staging cleanup, old retained untouched pre-rename.
 * - Injected write/fsync/read-back failures → bounded codes.
 * - Read+validate: tamper (row field, integrity, dup ids) → null.
 * - Probe: missing / valid / corrupt / not-a-file.
 * - Privacy: the retained snapshot carries canonical rows but NO source
 *   absolute paths (LOCK-ART-5).
 * - catalogDigestHex agrees with computeCatalogReceipt.
 *
 * Real filesystem. No mocks except DATA_PATH.
 */

import type * as NodeCrypto from 'node:crypto'
import * as realFs from 'node:fs'
// Default export (mutable object) — spy target for bounded fault injection.
import nodeFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import {
  filesCatalogHashInput,
  type FilesCatalogSnapshotRow,
  type FilesCatalogSnapshotV1
} from '@shared/chatImport/types'

import { computeCatalogReceipt } from '../artifactReceipts'
import {
  buildCatalogSnapshotWire,
  catalogDigestHex,
  isValidCatalogSnapshotRow,
  isValidCatalogSnapshotWire,
  probeRetainedCatalogSnapshot,
  readAndValidateCatalogSnapshot,
  resolveCatalogSnapshotPath,
  resolveCatalogSnapshotStagingPath,
  writeCatalogSnapshotDurable
} from '../catalogSnapshot'
import { FILES_CATALOG_SNAPSHOT_FILENAME } from '../journal'

const { createHash } = require('node:crypto') as typeof NodeCrypto

function sha256HexOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-catalog-snap-'))
}

/**
 * One canonical row. `path` is the app's own absolute internal storage path
 * whose basename equals the canonical physical filename — the only path shape
 * the renderer restore boundary accepts (LOCK-BRIDGE-2: capture/restore
 * symmetry; foreign/source relative roots must never persist).
 */
function row(overrides: Partial<FilesCatalogSnapshotRow> = {}): FilesCatalogSnapshotRow {
  return {
    id: 'file-1',
    name: 'file-1.png',
    origin_name: 'hello.png',
    path: '/owned/Data/Files/file-1.png',
    size: 3,
    ext: '.png',
    type: 'image',
    created_at: '2020-01-01T00:00:00.000Z',
    count: 1,
    ...overrides
  }
}

describe('isValidCatalogSnapshotRow', () => {
  it('accepts a well-formed normalized row', () => {
    expect(isValidCatalogSnapshotRow(row())).toBe(true)
  })

  it('accepts nullable type/created_at', () => {
    expect(isValidCatalogSnapshotRow(row({ type: null, created_at: null }))).toBe(true)
  })

  it('rejects every malformed shape', () => {
    const cases: unknown[] = [
      null,
      42,
      'x',
      [],
      {},
      row({ id: '' }),
      row({ id: 5 as unknown as string }),
      row({ id: 'x'.repeat(257) }),
      row({ name: 5 as unknown as string }),
      row({ origin_name: 5 as unknown as string }),
      row({ path: 5 as unknown as string }),
      row({ size: -1 }),
      row({ size: 1.5 }),
      row({ size: Number.MAX_SAFE_INTEGER + 1 }),
      row({ size: '3' as unknown as number }),
      row({ ext: 5 as unknown as string }),
      row({ type: 5 as unknown as string | null }),
      row({ created_at: 5 as unknown as string | null }),
      row({ count: -1 }),
      row({ count: 1.5 }),
      row({ count: '1' as unknown as number })
    ]
    for (const value of cases) {
      expect(isValidCatalogSnapshotRow(value)).toBe(false)
    }
  })

  it('rejects NON-CANONICAL row names (audit F6 canonical flat shape)', () => {
    for (const name of [
      '',
      'a/b.png',
      'a\\b.png',
      '..evil',
      'a..b',
      '..',
      '.',
      'caf\u00e9.png',
      'name with space.png',
      'a\x00b',
      'x'.repeat(257)
    ]) {
      expect(isValidCatalogSnapshotRow(row({ name, path: `/owned/Data/Files/${name}` }))).toBe(false)
    }
  })

  it('rejects traversal / NUL / backslash paths and NUL origin_names (audit F6)', () => {
    expect(isValidCatalogSnapshotRow(row({ path: '/owned/Data/Files/../evil.png' }))).toBe(false)
    expect(isValidCatalogSnapshotRow(row({ path: 'a\x00b' }))).toBe(false)
    expect(isValidCatalogSnapshotRow(row({ path: 'a\\b' }))).toBe(false)
    expect(isValidCatalogSnapshotRow(row({ origin_name: 'a\x00b' }))).toBe(false)
  })

  it('rejects name !== id+ext rows (renderer restore contract — LOCK-BRIDGE-2)', () => {
    expect(isValidCatalogSnapshotRow(row({ id: 'file-1', name: 'not-the-canonical-name.png' }))).toBe(false)
  })

  it('accepts only restorable paths — absolute with basename === name (LOCK-BRIDGE-2)', () => {
    // Canonical absolute internal storage path: accepted.
    expect(isValidCatalogSnapshotRow(row({ path: '/owned/Data/Files/file-1.png' }))).toBe(true)
    // Prior-target absolute path with the matching basename: still accepted
    // (restore normalizes it to the current root).
    expect(isValidCatalogSnapshotRow(row({ path: '/old/profile/Data/Files/file-1.png' }))).toBe(true)
    // Foreign/source roots — relative, empty, URL, basename mismatch: rejected.
    expect(isValidCatalogSnapshotRow(row({ path: '' }))).toBe(false)
    expect(isValidCatalogSnapshotRow(row({ path: 'Files/file-1.png' }))).toBe(false)
    expect(isValidCatalogSnapshotRow(row({ path: 'file:///x/file-1.png' }))).toBe(false)
    expect(isValidCatalogSnapshotRow(row({ path: '/storage/abc123.png' }))).toBe(false)
  })
})

describe('isValidCatalogSnapshotWire', () => {
  function wire(rows: readonly FilesCatalogSnapshotRow[]): FilesCatalogSnapshotV1 {
    return buildCatalogSnapshotWire(rows)
  }

  it('accepts a valid payload and rejects wrong version / missing fields', () => {
    expect(isValidCatalogSnapshotWire(wire([row()]))).toBe(true)
    expect(isValidCatalogSnapshotWire({ ...wire([row()]), version: 2 })).toBe(false)
    expect(isValidCatalogSnapshotWire({ ...wire([row()]), capturedAt: 5 })).toBe(false)
    expect(isValidCatalogSnapshotWire({ ...wire([row()]), rows: 'nope' })).toBe(false)
    expect(isValidCatalogSnapshotWire({ ...wire([row()]), integrity: null })).toBe(false)
  })

  it('rejects a count/integrity mismatch', () => {
    const w = wire([row()])
    const tampered = { ...w, integrity: { count: w.integrity.count + 1, sha256: w.integrity.sha256 } }
    expect(isValidCatalogSnapshotWire(tampered)).toBe(false)
    const badHash = { ...w, integrity: { count: w.integrity.count, sha256: 'zz'.repeat(32) } }
    expect(isValidCatalogSnapshotWire(badHash)).toBe(false)
  })

  it('rejects duplicate row ids (LOCK-ART-5 byte-identical restore)', () => {
    const w = wire([row(), row({ name: 'file-1.jpg', path: '/owned/Data/Files/file-1.jpg', ext: '.jpg' })])
    expect(w.rows.length).toBe(2)
    expect(isValidCatalogSnapshotWire(w)).toBe(false)
  })

  it('accepts distinct ids even with identical names (names are not the PK)', () => {
    const w = wire([row(), row({ id: 'file-2', path: '/owned/Data/Files/file-2.png', name: 'file-2.png' })])
    expect(isValidCatalogSnapshotWire(w)).toBe(true)
  })

  it('rejects a count-consistent but WRONG sha256 digest pre-publish (audit F3)', () => {
    const w = wire([row()])
    const wrongDigest = { ...w, integrity: { count: w.integrity.count, sha256: sha256HexOf('wrong') } }
    // The format is valid (count matches, hex shape matches) but the digest
    // does not re-derive — the payload must be rejected BEFORE any publish.
    expect(isValidCatalogSnapshotWire(wrongDigest)).toBe(false)
  })
})

describe('buildCatalogSnapshotWire', () => {
  it('computes a deterministic order-independent receipt', () => {
    const a = row({ id: 'a', name: 'a.png', path: '/owned/Data/Files/a.png', size: 1 })
    const b = row({ id: 'b', name: 'b.png', path: '/owned/Data/Files/b.png', size: 2 })
    const forward = buildCatalogSnapshotWire([a, b])
    const reversed = buildCatalogSnapshotWire([b, a])
    expect(forward.integrity).toEqual(reversed.integrity)
    expect(forward.integrity.count).toBe(2)
    expect(forward.integrity.sha256).toBe(computeCatalogReceipt([a, b]).sha256)
    expect(forward.rows.length).toBe(2)
    expect(Object.isFrozen(forward.rows)).toBe(true)
  })
})

describe('writeCatalogSnapshotDurable', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('writes atomically with 0600 privacy, read-back-confirms, cleans staging', () => {
    const payload = buildCatalogSnapshotWire([row()])
    const result = writeCatalogSnapshotDurable(payload, tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshotPath).toBe(resolveCatalogSnapshotPath(tempDir))
    // 0600 privacy mode (LOCK-ART-6).
    const mode = realFs.statSync(resolveCatalogSnapshotPath(tempDir)).mode & 0o777
    expect(mode).toBe(0o600)
    // Read-back validates.
    expect(readAndValidateCatalogSnapshot(tempDir)).not.toBeNull()
    // Staging cleaned.
    expect(realFs.existsSync(resolveCatalogSnapshotStagingPath(tempDir))).toBe(false)
  })

  it('rejects an invalid payload without touching disk', () => {
    const before = realFs.readdirSync(tempDir)
    const invalid = {
      ...buildCatalogSnapshotWire([row()]),
      rows: [row(), row()]
    }
    const result = writeCatalogSnapshotDurable(invalid as FilesCatalogSnapshotV1, tempDir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PAYLOAD_INVALID')
    expect(realFs.readdirSync(tempDir)).toEqual(before)
  })

  it('rejects a count-consistent but WRONG digest BEFORE any publish — old retained untouched (audit F3)', () => {
    // Pre-existing retained snapshot that must survive the rejected publish.
    const oldSnapshot = buildCatalogSnapshotWire([
      row({ id: 'old', name: 'old.png', path: '/owned/Data/Files/old.png' })
    ])
    expect(writeCatalogSnapshotDurable(oldSnapshot, tempDir).ok).toBe(true)
    const retainedPath = resolveCatalogSnapshotPath(tempDir)
    const beforeBytes = realFs.readFileSync(retainedPath)

    const w = buildCatalogSnapshotWire([row()])
    const wrongDigest = { ...w, integrity: { count: w.integrity.count, sha256: sha256HexOf('wrong') } }
    const result = writeCatalogSnapshotDurable(wrongDigest as FilesCatalogSnapshotV1, tempDir)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PAYLOAD_INVALID')
    // Validate-before-publish: the old retained snapshot is byte-for-byte
    // untouched and staging is clean (the rename never happened).
    expect(realFs.readFileSync(retainedPath).equals(beforeBytes)).toBe(true)
    expect(realFs.existsSync(resolveCatalogSnapshotStagingPath(tempDir))).toBe(false)
  })

  it('fails with WRITE_FAILED on an injected staging write error and preserves the old retained snapshot', () => {
    // Pre-existing retained snapshot that must survive the failed replacement.
    const oldSnapshot = buildCatalogSnapshotWire([
      row({ id: 'old', name: 'old.png', path: '/owned/Data/Files/old.png' })
    ])
    const first = writeCatalogSnapshotDurable(oldSnapshot, tempDir)
    expect(first.ok).toBe(true)
    const retainedPath = resolveCatalogSnapshotPath(tempDir)
    const beforeBytes = realFs.readFileSync(retainedPath)

    const realOpenSync = nodeFs.openSync
    const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation(((
      filePath: realFs.PathLike,
      flags: realFs.OpenMode,
      mode?: realFs.Mode | null
    ) => {
      if (typeof filePath === 'string' && filePath === resolveCatalogSnapshotStagingPath(tempDir)) {
        const error: NodeJS.ErrnoException = new Error('EIO: injected staging write failure')
        error.code = 'EIO'
        throw error
      }
      return realOpenSync(filePath, flags, mode)
    }) as typeof realFs.openSync)

    const second = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    openSpy.mockRestore()

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('WRITE_FAILED')
    // Old retained snapshot byte-for-byte untouched; staging cleaned.
    expect(realFs.readFileSync(retainedPath).equals(beforeBytes)).toBe(true)
    expect(realFs.existsSync(resolveCatalogSnapshotStagingPath(tempDir))).toBe(false)
  })

  it('fails with DIRECTORY_SYNC_FAILED on an injected parent fsync error (post-rename)', () => {
    const realOpenSync = nodeFs.openSync
    const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation(((
      filePath: realFs.PathLike,
      flags: realFs.OpenMode,
      mode?: realFs.Mode | null
    ) => {
      // The parent-directory fsync is the ONLY openSync with the data root
      // path itself (staging/snapshot paths are distinct).
      if (typeof filePath === 'string' && filePath === tempDir) {
        const error: NodeJS.ErrnoException = new Error('EIO: injected directory fsync failure')
        error.code = 'EIO'
        throw error
      }
      return realOpenSync(filePath, flags, mode)
    }) as typeof realFs.openSync)

    const result = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    openSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('DIRECTORY_SYNC_FAILED')
    // The rename already happened — the new snapshot is retained.
    expect(realFs.existsSync(resolveCatalogSnapshotPath(tempDir))).toBe(true)
  })

  it('fails with READBACK_INVALID when the retained bytes are corrupted after the rename', () => {
    const realRenameSync = nodeFs.renameSync
    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
      src: realFs.PathLike,
      dest: realFs.PathLike
    ) => {
      realRenameSync(src, dest)
      // Corrupt the just-published snapshot so the read-back verification fails.
      realFs.writeFileSync(resolveCatalogSnapshotPath(tempDir), '{ corrupted')
    }) as typeof realFs.renameSync)

    const result = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    renameSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('READBACK_INVALID')
  })
})

describe('readAndValidateCatalogSnapshot', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null for a missing snapshot', () => {
    expect(readAndValidateCatalogSnapshot(tempDir)).toBeNull()
  })

  it('round-trips a valid snapshot with frozen rows', () => {
    const payload = buildCatalogSnapshotWire([row()])
    const write = writeCatalogSnapshotDurable(payload, tempDir)
    expect(write.ok).toBe(true)
    const read = readAndValidateCatalogSnapshot(tempDir)
    expect(read).not.toBeNull()
    if (!read) return
    expect(read.integrity).toEqual(payload.integrity)
    expect(read.rows.length).toBe(1)
    expect(Object.isFrozen(read.rows)).toBe(true)
  })

  it('returns null on malformed JSON', () => {
    realFs.writeFileSync(resolveCatalogSnapshotPath(tempDir), 'not-json')
    expect(readAndValidateCatalogSnapshot(tempDir)).toBeNull()
  })

  it('returns null when a row field is tampered (digest mismatch)', () => {
    const write = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    expect(write.ok).toBe(true)
    const snapshotPath = resolveCatalogSnapshotPath(tempDir)
    const parsed = JSON.parse(realFs.readFileSync(snapshotPath, 'utf8')) as unknown as {
      rows: FilesCatalogSnapshotRow[]
      integrity: { count: number; sha256: string }
    }
    parsed.rows = [{ ...parsed.rows[0], name: 'file-1-CHANGED.png' }]
    realFs.writeFileSync(snapshotPath, JSON.stringify(parsed))
    expect(readAndValidateCatalogSnapshot(tempDir)).toBeNull()
  })

  it('returns null when the integrity block is tampered', () => {
    const write = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    expect(write.ok).toBe(true)
    const snapshotPath = resolveCatalogSnapshotPath(tempDir)
    const parsed = JSON.parse(realFs.readFileSync(snapshotPath, 'utf8')) as unknown as {
      rows: FilesCatalogSnapshotRow[]
      integrity: { count: number; sha256: string }
    }
    parsed.integrity = { count: parsed.integrity.count + 1, sha256: parsed.integrity.sha256 }
    realFs.writeFileSync(snapshotPath, JSON.stringify(parsed))
    expect(readAndValidateCatalogSnapshot(tempDir)).toBeNull()
  })

  it('returns null for duplicate ids', () => {
    const write = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    expect(write.ok).toBe(true)
    const snapshotPath = resolveCatalogSnapshotPath(tempDir)
    const parsed = JSON.parse(realFs.readFileSync(snapshotPath, 'utf8')) as unknown as {
      rows: FilesCatalogSnapshotRow[]
      integrity: { count: number; sha256: string }
    }
    parsed.rows = [
      parsed.rows[0],
      { ...parsed.rows[0], name: 'file-1.jpg', path: '/owned/Data/Files/file-1.jpg', ext: '.jpg' }
    ]
    realFs.writeFileSync(snapshotPath, JSON.stringify(parsed))
    expect(readAndValidateCatalogSnapshot(tempDir)).toBeNull()
  })

  it('contains NO source absolute paths (LOCK-ART-5 privacy)', () => {
    const payload = buildCatalogSnapshotWire([row({ origin_name: 'private-name.png' })])
    const write = writeCatalogSnapshotDurable(payload, tempDir)
    expect(write.ok).toBe(true)
    const raw = realFs.readFileSync(resolveCatalogSnapshotPath(tempDir), 'utf8')
    // The absolute data root never leaks into the retained artifact.
    expect(raw).not.toContain(tempDir)
    expect(raw).not.toContain('/Users/')
    // The stored `path` is the app's OWN canonical absolute storage path
    // (restorable by contract — LOCK-BRIDGE-2), never a source root.
    expect(JSON.parse(raw).rows[0].path).toBe('/owned/Data/Files/file-1.png')
  })
})

describe('probeRetainedCatalogSnapshot', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('reports missing when absent', () => {
    expect(probeRetainedCatalogSnapshot(tempDir)).toEqual({ status: 'missing' })
  })

  it('reports present-verified for a valid snapshot and is idempotent', () => {
    const write = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    expect(write.ok).toBe(true)
    expect(probeRetainedCatalogSnapshot(tempDir)).toEqual({ status: 'present-verified' })
    expect(probeRetainedCatalogSnapshot(tempDir)).toEqual({ status: 'present-verified' })
  })

  it('reports present-unverified SNAPSHOT_INVALID for corrupt bytes', () => {
    realFs.writeFileSync(resolveCatalogSnapshotPath(tempDir), 'garbage')
    expect(probeRetainedCatalogSnapshot(tempDir)).toEqual({ status: 'present-unverified', detail: 'SNAPSHOT_INVALID' })
  })

  it('reports present-unverified NOT_A_FILE for a directory at the path', () => {
    realFs.mkdirSync(resolveCatalogSnapshotPath(tempDir), { recursive: true })
    expect(probeRetainedCatalogSnapshot(tempDir)).toEqual({ status: 'present-unverified', detail: 'NOT_A_FILE' })
  })

  it('reports present-unverified NOT_A_FILE for a BROKEN SYMLINK, never missing (audit F2)', () => {
    try {
      realFs.symlinkSync(realPath.join(tempDir, 'missing-target'), resolveCatalogSnapshotPath(tempDir))
    } catch {
      return
    }
    expect(probeRetainedCatalogSnapshot(tempDir)).toEqual({ status: 'present-unverified', detail: 'NOT_A_FILE' })
  })

  it('reports present-unverified NOT_A_FILE for a WORKING SYMLINK (lstat, never followed — audit F4)', () => {
    const write = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    expect(write.ok).toBe(true)
    const snapshotPath = resolveCatalogSnapshotPath(tempDir)
    const elsewhere = realPath.join(tempDir, 'elsewhere.json')
    realFs.renameSync(snapshotPath, elsewhere)
    try {
      realFs.symlinkSync(elsewhere, snapshotPath)
    } catch {
      return
    }
    expect(probeRetainedCatalogSnapshot(tempDir)).toEqual({ status: 'present-unverified', detail: 'NOT_A_FILE' })
  })

  it('leaves zero residue across probes', () => {
    const write = writeCatalogSnapshotDurable(buildCatalogSnapshotWire([row()]), tempDir)
    expect(write.ok).toBe(true)
    const before = realFs.readdirSync(tempDir).sort()
    probeRetainedCatalogSnapshot(tempDir)
    probeRetainedCatalogSnapshot(tempDir)
    expect(realFs.readdirSync(tempDir).sort()).toEqual(before)
    expect(before).toContain(FILES_CATALOG_SNAPSHOT_FILENAME)
    expect(before).not.toContain(FILES_CATALOG_SNAPSHOT_FILENAME + '.staging')
  })
})

describe('catalogDigestHex', () => {
  it('agrees with computeCatalogReceipt and the shared hash input', () => {
    const rows = [
      row({ id: 'b', name: 'b.png', path: '/owned/Data/Files/b.png' }),
      row({ id: 'a', name: 'a.png', path: '/owned/Data/Files/a.png' })
    ]
    expect(catalogDigestHex(rows)).toBe(computeCatalogReceipt(rows).sha256)
    expect(catalogDigestHex(rows)).toBe(createHash('sha256').update(filesCatalogHashInput(rows)).digest('hex'))
  })
})
