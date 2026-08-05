/**
 * Live Files rollback snapshot/restore/probe primitives
 * (LOCK-PROMO-3/4/6, LOCK-ART-1/2/3/4/6).
 *
 * Covers:
 * - prepare: populated / missing / empty (LOCK-ART-1) / large multi-file /
 *   one-retained replacement (POSIX ENOTEMPTY-safe) / symlink + subdir
 *   rejection (LOCK-ART-4) / permission preservation (LOCK-ART-6) /
 *   injected copy + publish failures with staging cleanup and old-retained
 *   preservation.
 * - manifest: strict validation incl. tamper, unsafe/nested rel, duplicate
 *   and case-fold duplicate rel rejection; determinism + privacy.
 * - probe: idempotent, tamper detection (parity/extra/corrupt/symlink),
 *   zero residue.
 * - restore: retained-snapshot restore that NEVER consumes the snapshot,
 *   empty-generation restore, live-absent restore, injected swap failures,
 *   tampered retained → fail-closed with live intact.
 * - computeLiveFilesReceipt: parity, empty, non-regular → null.
 *
 * Real filesystem + bounded fault injection. No mocks except DATA_PATH.
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

import { computeFilesReceipt, type FilesReceiptEntry } from '../artifactReceipts'
import {
  computeLiveFilesReceipt,
  encodeFilesSnapshotManifest,
  FILES_SNAPSHOT_MANIFEST_FILENAME,
  type FilesSnapshotManifestV1,
  isCanonicalFlatFilename,
  isSafeRelPath,
  prepareFilesRollbackSnapshot,
  probeRetainedFilesSnapshot,
  readAndValidateFilesSnapshotManifest,
  resolveFilesSnapshotManifestPath,
  resolveLiveFilesDir,
  restoreFilesRollbackSnapshot
} from '../filesSnapshot'
import { FILES_PROMOTE_STAGING_DIRNAME, FILES_ROLLBACK_SNAPSHOT_DIRNAME } from '../journal'

const { createHash } = require('node:crypto') as typeof NodeCrypto

function sha256HexOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-files-snap-'))
}

/** Write {name → content} files into the live Files dir. */
function writeLiveFiles(dataRoot: string, files: Record<string, Buffer | string>): void {
  const dir = resolveLiveFilesDir(dataRoot)
  realFs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    realFs.writeFileSync(realPath.join(dir, name), Buffer.isBuffer(content) ? content : Buffer.from(content))
  }
}

/** Map of live/retained dir entries (files only, content buffers). */
function readDirMap(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  if (!realFs.existsSync(dir)) return out
  for (const name of realFs.readdirSync(dir)) {
    const p = realPath.join(dir, name)
    const stat = realFs.lstatSync(p)
    if (stat.isFile()) out[name] = realFs.readFileSync(p)
  }
  return out
}

function entriesOf(files: Record<string, Buffer | string>): FilesReceiptEntry[] {
  return Object.entries(files).map(([name, content]) => {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
    return { name, size: buf.length, sha256: sha256HexOf(buf) }
  })
}

/** Retained dir paths. */
function retainedDir(dataRoot: string): string {
  return realPath.join(dataRoot, FILES_ROLLBACK_SNAPSHOT_DIRNAME)
}

function stagingDir(dataRoot: string): string {
  return realPath.join(dataRoot, 'Files.pre-import-backup.staging')
}

function swapStagingDir(dataRoot: string): string {
  return realPath.join(dataRoot, FILES_PROMOTE_STAGING_DIRNAME)
}

describe('prepareFilesRollbackSnapshot', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = makeTempDir()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  it('snapshots a populated multi-file live Files dir (incl. a >4 MiB file) and cleans staging', () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 777, 0x7a)
    const files = { 'a.png': 'alpha', 'b.txt': 'bravo', 'big.bin': big }
    writeLiveFiles(dataRoot, files)

    const result = prepareFilesRollbackSnapshot({ dataRoot })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe('populated')
    expect(result.receipt).toEqual(computeFilesReceipt(entriesOf(files)))
    // Retained copy is byte-identical and manifest validates.
    const retained = readDirMap(retainedDir(dataRoot))
    expect(retained['a.png']?.toString()).toBe('alpha')
    expect(retained['big.bin']?.equals(big)).toBe(true)
    expect(realFs.existsSync(realPath.join(retainedDir(dataRoot), FILES_SNAPSHOT_MANIFEST_FILENAME))).toBe(true)
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
    // No staging residue.
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
  })

  it('snapshots a missing live Files dir as a valid EMPTY generation (LOCK-ART-1)', () => {
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe('empty')
    expect(result.receipt).toEqual(computeFilesReceipt([]))
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })

  it('snapshots an existing but empty live Files dir as empty', () => {
    realFs.mkdirSync(resolveLiveFilesDir(dataRoot), { recursive: true })
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe('empty')
  })

  it('REPLACES a previous retained snapshot (one-retained, ENOTEMPTY-safe)', () => {
    writeLiveFiles(dataRoot, { 'first.png': 'one' })
    const first = prepareFilesRollbackSnapshot({ dataRoot })
    expect(first.ok).toBe(true)

    // A NEW live generation: the previous payload is gone from live.
    const live = resolveLiveFilesDir(dataRoot)
    realFs.rmSync(realPath.join(live, 'first.png'))
    writeLiveFiles(dataRoot, { 'second.png': 'two', 'third.png': 'three' })
    const second = prepareFilesRollbackSnapshot({ dataRoot })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    // One-retained: only the newest generation exists at the retained name.
    const retained = readDirMap(retainedDir(dataRoot))
    expect(Object.keys(retained).sort()).toEqual(['manifest.json', 'second.png', 'third.png'])
    expect(realFs.existsSync(realPath.join(dataRoot, 'Files.pre-import-backup.old'))).toBe(false)
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })

  it('preserves the source permission bits on the retained copy (LOCK-ART-6)', () => {
    writeLiveFiles(dataRoot, { 'private.png': 'secret' })
    realFs.chmodSync(realPath.join(resolveLiveFilesDir(dataRoot), 'private.png'), 0o600)

    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(true)
    const mode = realFs.statSync(realPath.join(retainedDir(dataRoot), 'private.png')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('rejects a live Files SYMLINK entry (LOCK-ART-4)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    const live = resolveLiveFilesDir(dataRoot)
    try {
      realFs.symlinkSync(realPath.join(live, 'a.png'), realPath.join(live, 'link.png'))
    } catch {
      return // no symlink support — nothing to assert
    }
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_STAT_FAILED')
      expect(result.safeCode).toBe('NON_REGULAR_ENTRY')
      expect(result.oldRetainedPreserved).toBe(true)
    }
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
    // Live dir untouched by the snapshot primitive.
    expect(readDirMap(live)).toHaveProperty('a.png')
  })

  it('rejects a live Files SUBDIRECTORY entry (LOCK-ART-4)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    realFs.mkdirSync(realPath.join(resolveLiveFilesDir(dataRoot), 'sub'))
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SOURCE_STAT_FAILED')
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
  })

  it('rejects a plain FILE at the live Files path (NOT_A_DIRECTORY)', () => {
    realFs.writeFileSync(resolveLiveFilesDir(dataRoot), 'not-a-dir')
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_STAT_FAILED')
      expect(result.safeCode).toBe('NOT_A_DIRECTORY')
    }
  })

  it('rejects a SYMLINK at the live Files path itself', () => {
    realFs.mkdirSync(realPath.join(dataRoot, 'real-files'))
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'real-files'), resolveLiveFilesDir(dataRoot))
    } catch {
      return
    }
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.safeCode).toBe('NOT_A_DIRECTORY')
  })

  it('rejects a NON-CANONICAL live filename BEFORE any copy (audit F1)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    const live = resolveLiveFilesDir(dataRoot)
    realFs.writeFileSync(realPath.join(live, 'bad name.png'), 'x')
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_STAT_FAILED')
      expect(result.safeCode).toBe('NON_CANONICAL_FILENAME')
      expect(result.oldRetainedPreserved).toBe(true)
    }
    // Nothing was copied — no staging residue.
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
  })

  it('rejects a UNICODE live filename BEFORE any copy (audit F1)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    realFs.writeFileSync(realPath.join(resolveLiveFilesDir(dataRoot), 'caf\u00e9.png'), 'x')
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_STAT_FAILED')
      expect(result.safeCode).toBe('NON_CANONICAL_FILENAME')
    }
  })

  it('rejects traversal / separator live filenames via the readdir surface (audit F1)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    const live = resolveLiveFilesDir(dataRoot)
    const realReaddirSync = nodeFs.readdirSync
    const readdirSpy = vi.spyOn(nodeFs, 'readdirSync').mockImplementation(((dir) => {
      if (typeof dir === 'string' && dir === live) return ['a.png', '..evil']
      return realReaddirSync(dir)
    }) as typeof realFs.readdirSync)
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    readdirSpy.mockRestore()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.safeCode).toBe('NON_CANONICAL_FILENAME')
  })

  it('rejects a case-fold-colliding live filename set BEFORE any copy (audit F1)', () => {
    writeLiveFiles(dataRoot, { 'foo.png': 'aaa' })
    const live = resolveLiveFilesDir(dataRoot)
    // Case-sensitive filesystems can hold both names; on case-insensitive
    // volumes the second name cannot be created — simulate the collision at
    // the readdir surface (the manifest duplicate/case-fold gates would
    // otherwise reject the published snapshot AFTER the fact).
    const realReaddirSync = nodeFs.readdirSync
    const readdirSpy = vi.spyOn(nodeFs, 'readdirSync').mockImplementation(((dir) => {
      if (typeof dir === 'string' && dir === live) return ['foo.png', 'Foo.png']
      return realReaddirSync(dir)
    }) as typeof realFs.readdirSync)
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    readdirSpy.mockRestore()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_STAT_FAILED')
      expect(result.safeCode).toBe('CASE_FOLD_COLLISION')
      expect(result.oldRetainedPreserved).toBe(true)
    }
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
  })

  it('treats a BROKEN SYMLINK at the live Files path as tamper, NOT an empty generation (audit F2)', () => {
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'missing-target'), resolveLiveFilesDir(dataRoot))
    } catch {
      return
    }
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_STAT_FAILED')
      expect(result.safeCode).toBe('NOT_A_DIRECTORY')
      expect(result.oldRetainedPreserved).toBe(true)
    }
    // Never an empty snapshot, never a copy.
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
    expect(realFs.existsSync(retainedDir(dataRoot))).toBe(false)
  })

  it('replaces a BROKEN SYMLINK retained root via the one-retained publish path (audit F2)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'missing-target'), retainedDir(dataRoot))
    } catch {
      return
    }
    const result = prepareFilesRollbackSnapshot({ dataRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
    // The tampered (broken symlink) generation was moved aside and removed.
    expect(realFs.existsSync(realPath.join(dataRoot, 'Files.pre-import-backup.old'))).toBe(false)
  })

  it('fails with STAGING_COPY_FAILED on an injected copy failure, preserving the old retained', () => {
    // Pre-existing retained snapshot (sentinel bytes) that must survive.
    realFs.mkdirSync(retainedDir(dataRoot), { recursive: true })
    realFs.writeFileSync(realPath.join(retainedDir(dataRoot), 'sentinel'), 'keep-me')
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })

    const staging = stagingDir(dataRoot)
    const realOpenSync = nodeFs.openSync
    const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation(((
      filePath: realFs.PathLike,
      flags: realFs.OpenMode,
      mode?: realFs.Mode | null
    ) => {
      if (typeof filePath === 'string' && filePath.startsWith(staging + realPath.sep) && String(flags).includes('w')) {
        const error: NodeJS.ErrnoException = new Error('EIO: injected staging copy failure')
        error.code = 'EIO'
        throw error
      }
      return realOpenSync(filePath, flags, mode)
    }) as typeof realFs.openSync)

    const result = prepareFilesRollbackSnapshot({ dataRoot })
    openSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('STAGING_COPY_FAILED')
      expect(result.safeCode).toBe('EIO')
      expect(result.oldRetainedPreserved).toBe(true)
    }
    // Old retained untouched, staging cleaned, live untouched.
    expect(realFs.readFileSync(realPath.join(retainedDir(dataRoot), 'sentinel'), 'utf8')).toBe('keep-me')
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
    expect(readDirMap(resolveLiveFilesDir(dataRoot))).toHaveProperty('a.png')
  })

  it('fails with RETAINED_PUBLISH_FAILED on an injected publish rename failure, preserving the old retained', () => {
    realFs.mkdirSync(retainedDir(dataRoot), { recursive: true })
    realFs.writeFileSync(realPath.join(retainedDir(dataRoot), 'sentinel'), 'keep-me')
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })

    const realRenameSync = nodeFs.renameSync
    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
      src: realFs.PathLike,
      dest: realFs.PathLike
    ) => {
      if (typeof src === 'string' && src === stagingDir(dataRoot)) {
        const error: NodeJS.ErrnoException = new Error('EIO: injected publish rename failure')
        error.code = 'EIO'
        throw error
      }
      return realRenameSync(src, dest)
    }) as typeof realFs.renameSync)

    const result = prepareFilesRollbackSnapshot({ dataRoot })
    renameSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('RETAINED_PUBLISH_FAILED')
      expect(result.oldRetainedPreserved).toBe(true)
    }
    expect(realFs.readFileSync(realPath.join(retainedDir(dataRoot), 'sentinel'), 'utf8')).toBe('keep-me')
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
  })

  it('fails with RETAINED_PUBLISH_FAILED when the onBeforePublish hook throws (pre-rename)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    const result = prepareFilesRollbackSnapshot({
      dataRoot,
      onBeforePublish: () => {
        throw new Error('simulated crash before publish')
      }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('RETAINED_PUBLISH_FAILED')
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
    // Live untouched; no retained published.
    expect(realFs.existsSync(retainedDir(dataRoot))).toBe(false)
  })
})

describe('manifest validation (readAndValidateFilesSnapshotManifest)', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = makeTempDir()
  })

  afterEach(() => {
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  function writeManifest(manifest: unknown): string {
    const p = realPath.join(dataRoot, FILES_SNAPSHOT_MANIFEST_FILENAME)
    realFs.writeFileSync(p, JSON.stringify(manifest))
    return p
  }

  function validManifest(): FilesSnapshotManifestV1 {
    const entries = [{ rel: 'a.png', size: 3, sha256: sha256HexOf('aaa') }]
    return {
      version: 1,
      capturedAt: '2020-01-01T00:00:00.000Z',
      kind: 'populated',
      entries,
      // The receipt digests the rel-mapped records (name = rel).
      integrity: computeFilesReceipt(entries.map((e) => ({ name: e.rel, size: e.size, sha256: e.sha256 })))
    }
  }

  it('round-trips a valid manifest', () => {
    const p = writeManifest(validManifest())
    const read = readAndValidateFilesSnapshotManifest(p)
    expect(read).not.toBeNull()
    if (!read) return
    expect(read.kind).toBe('populated')
    expect(read.entries[0].rel).toBe('a.png')
  })

  it('rejects tampered sizes and hashes', () => {
    const tamperedSize = { ...validManifest(), entries: [{ rel: 'a.png', size: 99, sha256: sha256HexOf('aaa') }] }
    expect(readAndValidateFilesSnapshotManifest(writeManifest(tamperedSize))).toBeNull()
    const tamperedHash = { ...validManifest(), entries: [{ rel: 'a.png', size: 3, sha256: sha256HexOf('zzz') }] }
    expect(readAndValidateFilesSnapshotManifest(writeManifest(tamperedHash))).toBeNull()
  })

  it('rejects an unsafe or NESTED rel (flat contract, LOCK-ART-4)', () => {
    for (const rel of ['../evil', 'a/b', 'a\\b', '\x00x', '']) {
      const m = { ...validManifest(), entries: [{ rel, size: 1, sha256: sha256HexOf('x') }] }
      expect(readAndValidateFilesSnapshotManifest(writeManifest(m))).toBeNull()
    }
  })

  it('rejects duplicate and case-fold duplicate rels (LOCK-ART-4)', () => {
    const dup = {
      ...validManifest(),
      entries: [
        { rel: 'a.png', size: 3, sha256: sha256HexOf('aaa') },
        { rel: 'a.png', size: 3, sha256: sha256HexOf('aaa') }
      ]
    }
    expect(readAndValidateFilesSnapshotManifest(writeManifest(dup))).toBeNull()

    const caseFold = {
      ...validManifest(),
      entries: [
        { rel: 'a.png', size: 3, sha256: sha256HexOf('aaa') },
        { rel: 'A.PNG', size: 3, sha256: sha256HexOf('aaa') }
      ]
    }
    expect(readAndValidateFilesSnapshotManifest(writeManifest(caseFold))).toBeNull()
  })

  it('rejects structural corruption (version/kind/empty-with-entries/integrity)', () => {
    expect(readAndValidateFilesSnapshotManifest(writeManifest({ ...validManifest(), version: 2 }))).toBeNull()
    expect(readAndValidateFilesSnapshotManifest(writeManifest({ ...validManifest(), kind: 'weird' }))).toBeNull()
    const emptyWithEntries = {
      ...validManifest(),
      kind: 'empty',
      entries: [{ rel: 'a.png', size: 3, sha256: sha256HexOf('aaa') }]
    }
    expect(readAndValidateFilesSnapshotManifest(writeManifest(emptyWithEntries))).toBeNull()
    const badIntegrity = {
      ...validManifest(),
      integrity: { count: 1, totalBytes: 3, sha256: sha256HexOf('zzz') }
    }
    expect(readAndValidateFilesSnapshotManifest(writeManifest(badIntegrity))).toBeNull()
  })

  it('returns null for a missing or malformed manifest', () => {
    expect(readAndValidateFilesSnapshotManifest(realPath.join(dataRoot, 'nope.json'))).toBeNull()
    realFs.writeFileSync(realPath.join(dataRoot, FILES_SNAPSHOT_MANIFEST_FILENAME), '{ bad json')
    expect(readAndValidateFilesSnapshotManifest(realPath.join(dataRoot, FILES_SNAPSHOT_MANIFEST_FILENAME))).toBeNull()
  })

  it('encodeFilesSnapshotManifest is deterministic and privacy-clean (no absolute paths)', () => {
    const a = encodeFilesSnapshotManifest(validManifest())
    const b = encodeFilesSnapshotManifest(validManifest())
    expect(a).toBe(b)
    expect(a).not.toContain(dataRoot)
    expect(a).not.toContain('/Users/')
  })
})

describe('isSafeRelPath', () => {
  it('accepts flat and nested safe paths', () => {
    expect(isSafeRelPath('a.png')).toBe(true)
    expect(isSafeRelPath('a/b/c.png')).toBe(true)
    expect(isSafeRelPath('a-b_c.d')).toBe(true)
  })

  it('rejects traversal, separators, NUL, and length abuse', () => {
    expect(isSafeRelPath('')).toBe(false)
    expect(isSafeRelPath('.')).toBe(false)
    expect(isSafeRelPath('..')).toBe(false)
    expect(isSafeRelPath('a/../b')).toBe(false)
    expect(isSafeRelPath('a\\b')).toBe(false)
    expect(isSafeRelPath('a\x00b')).toBe(false)
    expect(isSafeRelPath('x'.repeat(513))).toBe(false)
  })
})

describe('probeRetainedFilesSnapshot', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = makeTempDir()
  })

  afterEach(() => {
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  it('reports missing when nothing is retained', () => {
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'missing' })
  })

  it('reports present-verified and is idempotent with zero residue', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    const prep = prepareFilesRollbackSnapshot({ dataRoot })
    expect(prep.ok).toBe(true)
    const before = realFs.readdirSync(dataRoot).sort()
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
    expect(realFs.readdirSync(dataRoot).sort()).toEqual(before)
  })

  it('detects a tampered payload byte (ENTRY_PARITY_FAILED)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    const p = realPath.join(retainedDir(dataRoot), 'a.png')
    const bytes = realFs.readFileSync(p)
    bytes[0] = bytes[0] ^ 0xff
    realFs.writeFileSync(p, bytes)
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({
      status: 'present-unverified',
      detail: 'ENTRY_PARITY_FAILED'
    })
  })

  it('detects an EXTRA entry beyond the manifest', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    realFs.writeFileSync(realPath.join(retainedDir(dataRoot), 'extra.bin'), 'x')
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-unverified', detail: 'EXTRA_ENTRIES' })
  })

  it('detects a corrupted manifest (MANIFEST_INVALID)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    realFs.writeFileSync(resolveFilesSnapshotManifestPath(retainedDir(dataRoot)), '{ corrupted')
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-unverified', detail: 'MANIFEST_INVALID' })
  })

  it('detects a SYMLINK entry (ENTRY_NOT_REGULAR)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    const entry = realPath.join(retainedDir(dataRoot), 'a.png')
    const elsewhere = realPath.join(retainedDir(dataRoot), 'elsewhere.png')
    realFs.renameSync(entry, elsewhere)
    try {
      realFs.symlinkSync(elsewhere, entry)
    } catch {
      return
    }
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-unverified', detail: 'ENTRY_NOT_REGULAR' })
  })

  it('detects a SUBDIRECTORY entry (ENTRY_NOT_REGULAR)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    realFs.rmSync(realPath.join(retainedDir(dataRoot), 'a.png'))
    realFs.mkdirSync(realPath.join(retainedDir(dataRoot), 'a.png'))
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-unverified', detail: 'ENTRY_NOT_REGULAR' })
  })

  it('reports a BROKEN SYMLINK retained root as present-unverified, NOT missing (audit F2)', () => {
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'missing-target'), retainedDir(dataRoot))
    } catch {
      return
    }
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-unverified', detail: 'NOT_A_DIRECTORY' })
  })

  it('reports a WORKING SYMLINK retained root as present-unverified (lstat, never followed — audit F4)', () => {
    realFs.mkdirSync(realPath.join(dataRoot, 'elsewhere'))
    writeLiveFiles(dataRoot, { 'a.png': 'aaa' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    // Replace the retained root with a symlink to a valid-looking dir.
    const elsewhere = realPath.join(dataRoot, 'elsewhere')
    realFs.rmSync(retainedDir(dataRoot), { recursive: true, force: true })
    try {
      realFs.symlinkSync(elsewhere, retainedDir(dataRoot))
    } catch {
      return
    }
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-unverified', detail: 'NOT_A_DIRECTORY' })
  })
})

describe('restoreFilesRollbackSnapshot', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = makeTempDir()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  it('restores the old generation after live mutation and NEVER consumes the snapshot (LOCK-ART-2)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha', 'b.png': 'bravo' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)

    // Mutate live: change a, delete b, add c.
    const live = resolveLiveFilesDir(dataRoot)
    realFs.writeFileSync(realPath.join(live, 'a.png'), 'MUTATED')
    realFs.rmSync(realPath.join(live, 'b.png'))
    realFs.writeFileSync(realPath.join(live, 'c.png'), 'new')

    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(true)

    const restored = readDirMap(live)
    expect(restored['a.png']?.toString()).toBe('alpha')
    expect(restored['b.png']?.toString()).toBe('bravo')
    expect(restored['c.png']).toBeUndefined()
    // The retained snapshot is still present and fully verified.
    expect(realFs.existsSync(retainedDir(dataRoot))).toBe(true)
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
    // No staging or swap-staging residue.
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
    expect(realFs.existsSync(swapStagingDir(dataRoot))).toBe(false)
  })

  it('restores an EMPTY old generation to EXACT ABSENCE of the live Files path (audit F5)', () => {
    // Live Files missing → empty snapshot.
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    // Now put junk at the live path that rollback must wipe deterministically.
    writeLiveFiles(dataRoot, { 'junk.bin': 'x' })

    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(true)
    // The live Files path is genuinely ABSENT — never a present-empty dir.
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)
    // No staging or swap-staging residue.
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
    expect(realFs.existsSync(swapStagingDir(dataRoot))).toBe(false)
    // Snapshot retained + verified (never consumed).
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })

  it('keeps an ABSENT live Files path absent when the old generation is empty (audit F5 absent-old)', () => {
    // Old generation had no Files dir at all → empty snapshot; live absent.
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)

    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(true)
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })

  it('removes an EXISTING NEW live Files dir when restoring an empty old generation (audit F5 existing-new)', () => {
    // Old generation had no Files dir → empty snapshot.
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    // A NEW candidate Files generation now exists at the live path.
    writeLiveFiles(dataRoot, { 'new.bin': 'candidate', 'other.txt': 'junk' })

    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(true)
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })

  it('is idempotent for an empty old generation: a retry reuses the retained snapshot and converges (audit F5)', () => {
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    writeLiveFiles(dataRoot, { 'junk.bin': 'x' })

    expect(restoreFilesRollbackSnapshot(dataRoot).ok).toBe(true)
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)
    // Retry: the retained snapshot is still present, so the retry converges.
    expect(restoreFilesRollbackSnapshot(dataRoot).ok).toBe(true)
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })

  it('leaves the EMPTY receipt exact after restoring an empty old generation (audit F5 receipt)', () => {
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    writeLiveFiles(dataRoot, { 'junk.bin': 'x' })

    expect(restoreFilesRollbackSnapshot(dataRoot).ok).toBe(true)
    // The empty receipt stays exact: count 0, totalBytes 0, empty sha256.
    expect(computeLiveFilesReceipt(dataRoot)).toEqual({ count: 0, totalBytes: 0, sha256: sha256HexOf('') })
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })

  it('restores a populated snapshot when the live dir is entirely absent', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    realFs.rmSync(resolveLiveFilesDir(dataRoot), { recursive: true, force: true })

    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(true)
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['a.png']?.toString()).toBe('alpha')
  })

  it('swaps a BROKEN SYMLINK live root away during restore — never treated as absent (audit F2)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    // Tamper: replace the live root with a broken symlink.
    const live = resolveLiveFilesDir(dataRoot)
    realFs.rmSync(live, { recursive: true, force: true })
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'missing-target'), live)
    } catch {
      return
    }
    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(true)
    expect(readDirMap(live)['a.png']?.toString()).toBe('alpha')
    // The tampered symlink was swapped away and removed; snapshot retained.
    expect(realFs.existsSync(swapStagingDir(dataRoot))).toBe(false)
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })

  it('rejects a SYMLINKED retained root during restore (lstat, never followed — audit F4)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    realFs.mkdirSync(realPath.join(dataRoot, 'fake-retained'))
    realFs.rmSync(retainedDir(dataRoot), { recursive: true, force: true })
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'fake-retained'), retainedDir(dataRoot))
    } catch {
      return
    }
    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('RETAINED_MANIFEST_FAILED')
    // Live untouched (never partially restored).
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['a.png']?.toString()).toBe('alpha')
  })

  it('is idempotent: a second restore leaves the same stable content', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    expect(restoreFilesRollbackSnapshot(dataRoot).ok).toBe(true)
    const first = readDirMap(resolveLiveFilesDir(dataRoot))
    expect(restoreFilesRollbackSnapshot(dataRoot).ok).toBe(true)
    const second = readDirMap(resolveLiveFilesDir(dataRoot))
    expect(first['a.png']?.equals(second['a.png'] ?? Buffer.alloc(0))).toBe(true)
  })

  it('fails with RETAINED_MANIFEST_FAILED when no snapshot is retained', () => {
    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('RETAINED_MANIFEST_FAILED')
  })

  it('fails when the retained manifest is corrupted', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    realFs.writeFileSync(resolveFilesSnapshotManifestPath(retainedDir(dataRoot)), '{ corrupted')
    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('RETAINED_MANIFEST_FAILED')
  })

  it('fails closed (live intact old) when a retained payload is tampered', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)
    const retainedBytes = readDirMap(retainedDir(dataRoot))
    // Tamper the retained copy only.
    const p = realPath.join(retainedDir(dataRoot), 'a.png')
    realFs.writeFileSync(p, 'TAMPERED-CONTENT')

    const result = restoreFilesRollbackSnapshot(dataRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STAGING_COPY_FAILED')
    // Live is the intact old generation — never a mixed directory.
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['a.png']?.toString()).toBe('alpha')
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
    // The retained snapshot keeps its (tampered) bytes — restore never mutates it.
    expect(realFs.readFileSync(p, 'utf8')).toBe('TAMPERED-CONTENT')
    expect(retainedBytes['a.png']?.toString()).toBe('alpha')
  })

  it('fails with SWAP_FAILED when the live→swap rename is injected to throw — live intact old', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)

    let first = true
    const realRenameSync = nodeFs.renameSync
    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
      src: realFs.PathLike,
      dest: realFs.PathLike
    ) => {
      if (first) {
        first = false
        const error: NodeJS.ErrnoException = new Error('EIO: injected live→swap failure')
        error.code = 'EIO'
        throw error
      }
      return realRenameSync(src, dest)
    }) as typeof realFs.renameSync)

    const result = restoreFilesRollbackSnapshot(dataRoot)
    renameSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SWAP_FAILED')
    // Live untouched; old retained untouched; staging cleaned.
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['a.png']?.toString()).toBe('alpha')
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
    expect(realFs.existsSync(stagingDir(dataRoot))).toBe(false)
  })

  it('fails with SWAP_FAILED when the staging→live rename is injected to throw — old generation retained at swap-staging', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    expect(prepareFilesRollbackSnapshot({ dataRoot }).ok).toBe(true)

    let call = 0
    const realRenameSync = nodeFs.renameSync
    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
      src: realFs.PathLike,
      dest: realFs.PathLike
    ) => {
      call += 1
      if (call === 2) {
        const error: NodeJS.ErrnoException = new Error('EIO: injected staging→live failure')
        error.code = 'EIO'
        throw error
      }
      return realRenameSync(src, dest)
    }) as typeof realFs.renameSync)

    const result = restoreFilesRollbackSnapshot(dataRoot)
    renameSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SWAP_FAILED')
    // Live path absent; the old generation is fully retained at swap-staging
    // (no mixed directory — live is either intact old or absent).
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)
    expect(readDirMap(swapStagingDir(dataRoot))['a.png']?.toString()).toBe('alpha')
    expect(probeRetainedFilesSnapshot(dataRoot)).toEqual({ status: 'present-verified' })
  })
})

describe('computeLiveFilesReceipt', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = makeTempDir()
  })

  afterEach(() => {
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  it('matches the aggregate receipt of the live files', () => {
    const files = { 'a.png': 'alpha', 'b.png': 'bravo' }
    writeLiveFiles(dataRoot, files)
    expect(computeLiveFilesReceipt(dataRoot)).toEqual(computeFilesReceipt(entriesOf(files)))
  })

  it('returns an empty receipt for a missing live Files dir (LOCK-ART-1)', () => {
    expect(computeLiveFilesReceipt(dataRoot)).toEqual({ count: 0, totalBytes: 0, sha256: sha256HexOf('') })
  })

  it('returns null when a non-regular entry exists (LOCK-ART-4)', () => {
    writeLiveFiles(dataRoot, { 'a.png': 'alpha' })
    realFs.mkdirSync(realPath.join(resolveLiveFilesDir(dataRoot), 'sub'))
    expect(computeLiveFilesReceipt(dataRoot)).toBeNull()
  })

  it('returns null for a symlinked live root', () => {
    realFs.mkdirSync(realPath.join(dataRoot, 'real'))
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'real'), resolveLiveFilesDir(dataRoot))
    } catch {
      return
    }
    expect(computeLiveFilesReceipt(dataRoot)).toBeNull()
  })

  it('returns null (tamper) for a BROKEN SYMLINK live root, NEVER the empty receipt (audit F2)', () => {
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'missing-target'), resolveLiveFilesDir(dataRoot))
    } catch {
      return
    }
    // A broken symlink must never certify an empty generation (count 0).
    expect(computeLiveFilesReceipt(dataRoot)).toBeNull()
  })
})

describe('isCanonicalFlatFilename', () => {
  it('accepts canonical flat ASCII filenames (audit F1)', () => {
    for (const name of ['a.png', 'A.PNG', 'file-1.png', 'big.bin', 'a_b-c.d', 'noext']) {
      expect(isCanonicalFlatFilename(name)).toBe(true)
    }
  })

  it('rejects separators, traversal, Unicode, NUL, and over-length names (audit F1)', () => {
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
      expect(isCanonicalFlatFilename(name)).toBe(false)
    }
  })
})
