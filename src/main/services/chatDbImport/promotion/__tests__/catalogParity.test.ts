/**
 * Files↔catalog parity verification (LOCK-PROMO-9, LOCK-ART-4).
 *
 * Covers:
 * - Exact match: receipt derivation + count parity for populated/empty dirs.
 * - LOCK-ART-4 rejections: symlink, subdirectory, non-regular entry,
 *   duplicate name, case-fold collision, unsafe catalog name.
 * - Parity failures: PAYLOAD_MISSING / SIZE / HASH / EXTRA / DIR_MISSING.
 * - Never-throws contract for every input shape (including I/O races).
 *
 * Real filesystem, no mocks except DATA_PATH.
 */

import type * as NodeCrypto from 'node:crypto'
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import { computeFilesReceipt } from '../artifactReceipts'
import { filesReceiptFromCatalogEntries, verifyFilesDirAgainstCatalog } from '../catalogParity'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-parity-'))
}

const { createHash } = require('node:crypto') as typeof NodeCrypto

function sha256HexOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

type Row = { name: string; size: number; sha256: string }

/** Write `files` ({name → content}) into `dir` and build catalog rows. */
function writeFiles(dir: string, files: Record<string, string | Buffer>): Row[] {
  realFs.mkdirSync(dir, { recursive: true })
  const rows: Row[] = []
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
    realFs.writeFileSync(realPath.join(dir, name), buf)
    rows.push({ name, size: buf.length, sha256: sha256HexOf(buf) })
  }
  return rows
}

describe('verifyFilesDirAgainstCatalog', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('passes an exact match and derives the canonical receipt', () => {
    const dir = realPath.join(tempDir, 'Files')
    const rows = writeFiles(dir, { 'a.png': 'aaa', 'b.png': 'bbbb', 'c.png': 'ccccc' })
    const result = verifyFilesDirAgainstCatalog(dir, rows)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBe(3)
    expect(result.receipt).toEqual(computeFilesReceipt(rows))
  })

  it('accepts a missing Files dir for a zero-row catalog (empty generation)', () => {
    const result = verifyFilesDirAgainstCatalog(realPath.join(tempDir, 'Files'), [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBe(0)
    expect(result.receipt).toEqual(computeFilesReceipt([]))
  })

  it('accepts an existing empty Files dir for a zero-row catalog', () => {
    const dir = realPath.join(tempDir, 'Files')
    realFs.mkdirSync(dir, { recursive: true })
    const result = verifyFilesDirAgainstCatalog(dir, [])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.count).toBe(0)
  })

  it('rejects a missing Files dir when rows exist', () => {
    const rows = writeFiles(realPath.join(tempDir, 'other'), { 'a.png': 'a' })
    const result = verifyFilesDirAgainstCatalog(realPath.join(tempDir, 'Files'), rows)
    expect(result).toEqual({ ok: false, code: 'FILES_DIR_MISSING' })
  })

  it('rejects a plain FILE at the Files dir path', () => {
    const rows = writeFiles(realPath.join(tempDir, 'src'), { 'a.png': 'a' })
    const filePath = realPath.join(tempDir, 'Files')
    realFs.writeFileSync(filePath, 'not-a-dir')
    expect(verifyFilesDirAgainstCatalog(filePath, rows)).toEqual({ ok: false, code: 'FILES_DIR_MISSING' })
  })

  it('rejects a SYMLINK at the Files dir path (lstat, never followed)', () => {
    const rows = writeFiles(realPath.join(tempDir, 'real'), { 'a.png': 'a' })
    const linkPath = realPath.join(tempDir, 'Files')
    try {
      realFs.symlinkSync(realPath.join(tempDir, 'real'), linkPath)
    } catch {
      return // filesystem without symlink support — nothing to assert
    }
    expect(verifyFilesDirAgainstCatalog(linkPath, rows)).toEqual({ ok: false, code: 'FILES_DIR_MISSING' })
  })

  it('rejects a BROKEN SYMLINK at the Files root as FILES_DIR_MISSING, never a verified EMPTY generation (audit F2)', () => {
    const linkPath = realPath.join(tempDir, 'Files')
    try {
      realFs.symlinkSync(realPath.join(tempDir, 'missing-target'), linkPath)
    } catch {
      return
    }
    // Zero-row catalog: a broken symlink must NOT certify an empty
    // generation (previously existsSync saw it as absent and ok:true).
    expect(verifyFilesDirAgainstCatalog(linkPath, [])).toEqual({ ok: false, code: 'FILES_DIR_MISSING' })
    // Rows present: still tamper, never 'missing' in a silent way.
    const rows: Row[] = [{ name: 'a.png', size: 1, sha256: sha256HexOf('a') }]
    expect(verifyFilesDirAgainstCatalog(linkPath, rows)).toEqual({ ok: false, code: 'FILES_DIR_MISSING' })
  })

  it('rejects PAYLOAD_MISSING when a catalog file is absent', () => {
    const dir = realPath.join(tempDir, 'Files')
    const rows = writeFiles(dir, { 'a.png': 'aaa' })
    rows.push({ name: 'b.png', size: 4, sha256: sha256HexOf('bbbb') })
    expect(verifyFilesDirAgainstCatalog(dir, rows)).toEqual({ ok: false, code: 'PAYLOAD_MISSING' })
  })

  it('rejects PAYLOAD_SIZE_MISMATCH when the on-disk size differs', () => {
    const dir = realPath.join(tempDir, 'Files')
    writeFiles(dir, { 'a.png': 'aa' })
    const rows: Row[] = [{ name: 'a.png', size: 99, sha256: sha256HexOf('aa') }]
    expect(verifyFilesDirAgainstCatalog(dir, rows)).toEqual({ ok: false, code: 'PAYLOAD_SIZE_MISMATCH' })
  })

  it('rejects PAYLOAD_HASH_MISMATCH when bytes differ at the same size', () => {
    const dir = realPath.join(tempDir, 'Files')
    writeFiles(dir, { 'a.png': 'aaa' })
    const rows: Row[] = [{ name: 'a.png', size: 3, sha256: sha256HexOf('zzz') }]
    expect(verifyFilesDirAgainstCatalog(dir, rows)).toEqual({ ok: false, code: 'PAYLOAD_HASH_MISMATCH' })
  })

  it('rejects EXTRA_PAYLOAD when an unexpected regular file exists', () => {
    const dir = realPath.join(tempDir, 'Files')
    const rows = writeFiles(dir, { 'a.png': 'aaa', 'extra.bin': 'xx' })
    const catalogRows = rows.filter((r) => r.name === 'a.png')
    expect(verifyFilesDirAgainstCatalog(dir, catalogRows)).toEqual({ ok: false, code: 'EXTRA_PAYLOAD' })
  })

  it('rejects a SUBDIRECTORY entry (LOCK-ART-4, never silently skipped)', () => {
    const dir = realPath.join(tempDir, 'Files')
    const rows = writeFiles(dir, { 'a.png': 'aaa' })
    realFs.mkdirSync(realPath.join(dir, 'sub'))
    // Exactly one catalog row and one on-disk FILE — a silent-skip bug would
    // pass here; the subdirectory must be rejected.
    expect(verifyFilesDirAgainstCatalog(dir, rows)).toEqual({ ok: false, code: 'NON_REGULAR_ENTRY' })
  })

  it('rejects a SYMLINK entry (LOCK-ART-4, never followed or skipped)', () => {
    const dir = realPath.join(tempDir, 'Files')
    const rows = writeFiles(dir, { 'a.png': 'aaa' })
    try {
      realFs.symlinkSync(realPath.join(dir, 'a.png'), realPath.join(dir, 'link.png'))
    } catch {
      return // filesystem without symlink support — nothing to assert
    }
    expect(verifyFilesDirAgainstCatalog(dir, rows)).toEqual({ ok: false, code: 'NON_REGULAR_ENTRY' })
  })

  it('rejects a broken symlink entry deterministically', () => {
    const dir = realPath.join(tempDir, 'Files')
    const rows = writeFiles(dir, { 'a.png': 'aaa' })
    try {
      realFs.symlinkSync(realPath.join(dir, 'does-not-exist'), realPath.join(dir, 'broken.png'))
    } catch {
      return
    }
    expect(verifyFilesDirAgainstCatalog(dir, rows)).toEqual({ ok: false, code: 'NON_REGULAR_ENTRY' })
  })

  it('rejects duplicate catalog names as CATALOG_INVALID', () => {
    const dir = realPath.join(tempDir, 'Files')
    writeFiles(dir, { 'a.png': 'aaa' })
    const rows: Row[] = [
      { name: 'a.png', size: 3, sha256: sha256HexOf('aaa') },
      { name: 'a.png', size: 3, sha256: sha256HexOf('aaa') }
    ]
    expect(verifyFilesDirAgainstCatalog(dir, rows)).toEqual({ ok: false, code: 'CATALOG_INVALID' })
  })

  it('rejects case-fold-colliding catalog names as CATALOG_INVALID (LOCK-ART-4)', () => {
    const dir = realPath.join(tempDir, 'Files')
    writeFiles(dir, { 'a.png': 'aaa' })
    const rows: Row[] = [
      { name: 'a.png', size: 3, sha256: sha256HexOf('aaa') },
      { name: 'A.PNG', size: 3, sha256: sha256HexOf('aaa') }
    ]
    expect(verifyFilesDirAgainstCatalog(dir, rows)).toEqual({ ok: false, code: 'CATALOG_INVALID' })
  })

  it('rejects traversal / separator / dot-dot catalog names', () => {
    const dir = realPath.join(tempDir, 'Files')
    writeFiles(dir, { 'a.png': 'aaa' })
    for (const bad of ['../evil', 'a/b', 'a\\b', 'a..b', '..']) {
      const result = verifyFilesDirAgainstCatalog(dir, [{ name: bad, size: 1, sha256: sha256HexOf('x') }])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('CATALOG_INVALID')
    }
  })

  it('never throws for any input shape (empty, missing, dangling paths)', () => {
    const dir = realPath.join(tempDir, 'Files')
    realFs.mkdirSync(dir, { recursive: true })
    const rows = writeFiles(dir, { 'a.png': 'a' })
    const inputs: Array<[string, Row[]]> = [
      [realPath.join(tempDir, 'missing-dir'), rows],
      [realPath.join(tempDir, 'missing-dir'), []],
      [dir, rows],
      [dir, []],
      [realPath.join(tempDir, 'not-created'), []]
    ]
    for (const [d, r] of inputs) {
      expect(() => verifyFilesDirAgainstCatalog(d, r)).not.toThrow()
    }
  })
})

describe('filesReceiptFromCatalogEntries', () => {
  it('derives the same receipt as computeFilesReceipt', () => {
    const entries: Row[] = [
      { name: 'z.png', size: 2, sha256: sha256HexOf('zz') },
      { name: 'a.png', size: 1, sha256: sha256HexOf('a') }
    ]
    expect(filesReceiptFromCatalogEntries(entries)).toEqual(computeFilesReceipt(entries))
  })
})
