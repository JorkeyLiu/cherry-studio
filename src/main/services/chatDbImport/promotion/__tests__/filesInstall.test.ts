/**
 * Candidate Files install primitive (LOCK-PROMO-4/6/9, LOCK-ART-3/4).
 *
 * Covers:
 * - Success: populated + empty candidate installs via same-filesystem
 *   directory rename/swap (no per-file live overwrite), aggregate receipt,
 *   no swap-staging residue.
 * - Candidate validation: invalid/traversal IDs, missing Files dir, invalid
 *   catalog, catalog↔payload parity failures, LOCK-ART-4 subdir/symlink/
 *   duplicate/case-fold rejections.
 * - Injected failures: live→swap rename, candidate→live rename (incl.
 *   candidate disappearance), EXDEV (never a copy fallback), parent-dir
 *   fsync, installed-parity, swap-staging remove.
 * - Pre/post-install classification (the candidate→live rename is the
 *   taxonomy boundary); live is NEVER a mixed directory after any caught
 *   failure.
 * - Stale swap-staging cleanup; receipt privacy (aggregate only).
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
import { installCandidateFiles, resolveCandidateCatalogPath, resolveCandidateFilesDir } from '../filesInstall'
import { resolveLiveFilesDir } from '../filesSnapshot'
import { FILES_PROMOTE_STAGING_DIRNAME } from '../journal'

const { createHash } = require('node:crypto') as typeof NodeCrypto

function sha256HexOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-files-install-'))
}

const CANDIDATE_ID = 'candidate-session-1'

/** Read dir entries (regular files only) → content buffers. */
function readDirMap(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  if (!realFs.existsSync(dir)) return out
  for (const name of realFs.readdirSync(dir)) {
    const p = realPath.join(dir, name)
    if (realFs.lstatSync(p).isFile()) out[name] = realFs.readFileSync(p)
  }
  return out
}

function swapStagingDir(dataRoot: string): string {
  return realPath.join(dataRoot, FILES_PROMOTE_STAGING_DIRNAME)
}

interface CatalogBuild {
  files: Record<string, string | Buffer>
  rows: Array<{
    id: string
    name: string
    origin_name: string
    path: string
    size: number
    sha256: string
    ext: string
    type: string | null
    created_at: string | null
    count: number
  }>
}

/** Build the candidate Files dir + files-catalog.json handoff. */
function buildCandidate(dataRoot: string, files: Record<string, string | Buffer>): CatalogBuild {
  const filesDir = resolveCandidateFilesDir(CANDIDATE_ID, dataRoot)
  realFs.mkdirSync(filesDir, { recursive: true })
  const rows: CatalogBuild['rows'] = []
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
    realFs.writeFileSync(realPath.join(filesDir, name), buf)
    const dot = name.lastIndexOf('.')
    const id = dot === -1 ? name : name.slice(0, dot)
    const ext = dot === -1 ? '' : name.slice(dot)
    rows.push({
      id,
      name,
      origin_name: `display-${name}`,
      path: `Files/${name}`,
      size: buf.length,
      sha256: sha256HexOf(buf),
      ext,
      type: 'image',
      created_at: '2020-01-01T00:00:00.000Z',
      count: 1
    })
  }
  writeCatalogHandoff(dataRoot, rows)
  return { files, rows }
}

/** Write the files-catalog.json handoff for the candidate. */
function writeCatalogHandoff(
  dataRoot: string,
  rows: CatalogBuild['rows'],
  overrides: { version?: number; degraded?: Record<string, number>; skipped?: Record<string, number> } = {}
): void {
  const catalog = {
    version: overrides.version ?? 1,
    sessionId: 'session-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    rows,
    referenced: { referencedFileIdCount: rows.length },
    degraded: overrides.degraded ?? {
      missingPayload: 0,
      missingCatalogRow: 0,
      metadataMismatch: 0,
      payloadReadFailure: 0,
      lostContent: 0,
      invalidTargetName: 0,
      duplicateCatalogRow: 0
    },
    skipped: overrides.skipped ?? { payloadWithoutCatalog: 0 }
  }
  realFs.mkdirSync(realPath.dirname(resolveCandidateCatalogPath(CANDIDATE_ID, dataRoot)), { recursive: true })
  realFs.writeFileSync(resolveCandidateCatalogPath(CANDIDATE_ID, dataRoot), JSON.stringify(catalog), 'utf8')
}

function catalogRowsToReceiptEntries(rows: CatalogBuild['rows']): FilesReceiptEntry[] {
  return rows.map((r) => ({ name: r.name, size: r.size, sha256: r.sha256 }))
}

describe('installCandidateFiles', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = makeTempDir()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Success paths
  // -------------------------------------------------------------------------

  it('installs a populated candidate by directory rename/swap and returns the aggregate receipt', () => {
    // Live old generation.
    writeLive(dataRoot, { 'old.png': 'old-content' })
    const candidate = buildCandidate(dataRoot, { 'a.png': 'aaa', 'b.png': 'bbbb' })

    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe('populated')
    expect(result.receipt).toEqual(computeFilesReceipt(catalogRowsToReceiptEntries(candidate.rows)))
    // Live now holds the candidate content exactly.
    expect(readDirMap(resolveLiveFilesDir(dataRoot))).toEqual({
      'a.png': Buffer.from('aaa'),
      'b.png': Buffer.from('bbbb')
    })
    // The candidate Files dir was RENAMED away (never copied per-file).
    expect(realFs.existsSync(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot))).toBe(false)
    // No swap-staging residue.
    expect(realFs.existsSync(swapStagingDir(dataRoot))).toBe(false)
  })

  it('installs an EMPTY candidate to an empty live Files dir (kind empty)', () => {
    const candidate = buildCandidate(dataRoot, {})
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe('empty')
    expect(result.receipt).toEqual(computeFilesReceipt([]))
    const live = resolveLiveFilesDir(dataRoot)
    expect(realFs.existsSync(live)).toBe(true)
    expect(realFs.readdirSync(live)).toEqual([])
    expect(candidate.rows.length).toBe(0)
  })

  it('cleans up a STALE swap-staging dir before the swap (ours to discard)', () => {
    buildCandidate(dataRoot, { 'a.png': 'aaa' })
    realFs.mkdirSync(swapStagingDir(dataRoot), { recursive: true })
    realFs.writeFileSync(realPath.join(swapStagingDir(dataRoot), 'stale'), 'junk')

    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })

    expect(result.ok).toBe(true)
    expect(realFs.existsSync(swapStagingDir(dataRoot))).toBe(false)
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['a.png']?.toString()).toBe('aaa')
  })

  // -------------------------------------------------------------------------
  // Candidate validation (pre-install)
  // -------------------------------------------------------------------------

  function expectPreInstallFailure(
    result: ReturnType<typeof installCandidateFiles>,
    code: string,
    safeCode?: string
  ): void {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.phase).toBe('pre-install')
    expect(result.code).toBe(code)
    if (safeCode !== undefined) expect(result.safeCode).toBe(safeCode)
  }

  it('rejects a candidate ID without the owned prefix', () => {
    const result = installCandidateFiles({ candidateId: 'session-1', dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_ID_INVALID', 'ID_ALLOWLIST_REJECTED')
  })

  it('rejects a traversal candidate ID', () => {
    const result = installCandidateFiles({ candidateId: '../evil', dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_ID_INVALID', 'ID_ALLOWLIST_REJECTED')
  })

  it('fails with CANDIDATE_FILES_MISSING when the candidate Files dir does not exist', () => {
    // Catalog handoff present, Files dir absent.
    writeCatalogHandoff(dataRoot, [])
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_FILES_MISSING', 'MISSING')
  })

  it('fails with CANDIDATE_FILES_MISSING for a SYMLINK candidate root (lstat, never followed — audit F2)', () => {
    const realDir = realPath.join(dataRoot, 'real-files')
    realFs.mkdirSync(realDir, { recursive: true })
    realFs.writeFileSync(realPath.join(realDir, 'a.png'), 'aaa')
    // Handoff points at the canonical candidate Files path; the path itself
    // is a symlink to a valid directory — it must NOT be accepted.
    writeCatalogHandoff(dataRoot, [
      {
        id: 'a',
        name: 'a.png',
        origin_name: 'a.png',
        path: 'Files/a.png',
        size: 3,
        sha256: sha256HexOf('aaa'),
        ext: '.png',
        type: 'image',
        created_at: null,
        count: 1
      }
    ])
    realFs.mkdirSync(realPath.dirname(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot)), { recursive: true })
    try {
      realFs.symlinkSync(realDir, resolveCandidateFilesDir(CANDIDATE_ID, dataRoot))
    } catch {
      return
    }
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_FILES_MISSING', 'NOT_A_DIRECTORY')
  })

  it('swaps a BROKEN SYMLINK at the live path to swap-staging during install (audit F2)', () => {
    buildCandidate(dataRoot, { 'a.png': 'aaa' })
    const live = resolveLiveFilesDir(dataRoot)
    try {
      realFs.symlinkSync(realPath.join(dataRoot, 'missing-target'), live)
    } catch {
      return
    }
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The candidate generation is live; the tampered symlink was swapped
    // away and removed with the old generation (never treated as absent).
    expect(readDirMap(live)['a.png']?.toString()).toBe('aaa')
    expect(realFs.existsSync(swapStagingDir(dataRoot))).toBe(false)
    // The broken symlink entry was moved aside (evidence) before removal.
    expect(realFs.existsSync(realPath.join(dataRoot, 'missing-target'))).toBe(false)
  })

  it('fails with CANDIDATE_CATALOG_INVALID when the handoff is unreadable', () => {
    realFs.mkdirSync(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot), { recursive: true })
    realFs.writeFileSync(resolveCandidateCatalogPath(CANDIDATE_ID, dataRoot), '{ garbage')
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_CATALOG_INVALID', 'CATALOG_UNREADABLE')
  })

  it('fails pre-install when the candidate payload is tampered vs its catalog', () => {
    buildCandidate(dataRoot, { 'a.png': 'aaa' })
    // Tamper the payload AFTER the catalog was written — same length so the
    // size gate passes and the hash gate fires.
    realFs.writeFileSync(realPath.join(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot), 'a.png'), 'zzz')
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_FILES_MISSING', 'CANDIDATE_PARITY_PAYLOAD_HASH_MISMATCH')
  })

  it('rejects a candidate Files SUBDIRECTORY (LOCK-ART-4)', () => {
    buildCandidate(dataRoot, { 'a.png': 'aaa' })
    realFs.mkdirSync(realPath.join(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot), 'sub'))
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_FILES_MISSING', 'CANDIDATE_PARITY_NON_REGULAR_ENTRY')
  })

  it('rejects a candidate Files SYMLINK (LOCK-ART-4)', () => {
    buildCandidate(dataRoot, { 'a.png': 'aaa' })
    const filesDir = resolveCandidateFilesDir(CANDIDATE_ID, dataRoot)
    try {
      realFs.symlinkSync(realPath.join(filesDir, 'a.png'), realPath.join(filesDir, 'link.png'))
    } catch {
      return
    }
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_FILES_MISSING', 'CANDIDATE_PARITY_NON_REGULAR_ENTRY')
  })

  it('rejects a case-fold-colliding candidate catalog (LOCK-ART-4)', () => {
    buildCandidate(dataRoot, { 'a.png': 'aaa' })
    // Rewrite the handoff with a case-fold-colliding second row.
    const extraRows: CatalogBuild['rows'] = [
      {
        id: 'a',
        name: 'a.png',
        origin_name: 'x',
        path: 'Files/a.png',
        size: 3,
        sha256: sha256HexOf('aaa'),
        ext: '.png',
        type: 'image',
        created_at: null,
        count: 1
      },
      {
        id: 'A',
        name: 'A.PNG',
        origin_name: 'x',
        path: 'Files/A.PNG',
        size: 3,
        sha256: sha256HexOf('aaa'),
        ext: '.PNG',
        type: 'image',
        created_at: null,
        count: 1
      }
    ]
    writeCatalogHandoff(dataRoot, extraRows)
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_FILES_MISSING', 'CATALOG_INVALID')
  })

  // -------------------------------------------------------------------------
  // Injected failures — swap phase
  // -------------------------------------------------------------------------

  it('fails pre-install with LIVE_SWAP_RENAME_FAILED on an injected live→swap failure — live intact', () => {
    writeLive(dataRoot, { 'old.png': 'old' })
    buildCandidate(dataRoot, { 'a.png': 'aaa' })

    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation((() => {
      const error: NodeJS.ErrnoException = new Error('EIO: injected live→swap failure')
      error.code = 'EIO'
      throw error
    }) as unknown as typeof realFs.renameSync)

    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    renameSpy.mockRestore()

    expectPreInstallFailure(result, 'LIVE_SWAP_RENAME_FAILED', 'EIO')
    // Live intact old; candidate intact; no swap residue.
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['old.png']?.toString()).toBe('old')
    expect(realFs.existsSync(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot))).toBe(true)
    expect(realFs.existsSync(swapStagingDir(dataRoot))).toBe(false)
  })

  it('fails pre-install with CANDIDATE_SWAP_RENAME_FAILED when the candidate disappears mid-swap', () => {
    writeLive(dataRoot, { 'old.png': 'old' })
    buildCandidate(dataRoot, { 'a.png': 'aaa' })

    const result = installCandidateFiles({
      candidateId: CANDIDATE_ID,
      dataRoot,
      onAfterLiveSwap: () => {
        // The candidate Files dir vanishes between the two renames.
        realFs.rmSync(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot), { recursive: true, force: true })
      }
    })

    expectPreInstallFailure(result, 'CANDIDATE_SWAP_RENAME_FAILED', 'ENOENT')
    // Live path absent (not mixed); the old generation is retained at
    // swap-staging; the retained snapshot is the rollback authority.
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)
    expect(readDirMap(swapStagingDir(dataRoot))['old.png']?.toString()).toBe('old')
  })

  it('fails pre-install with CANDIDATE_SWAP_CROSS_DEVICE on EXDEV and NEVER falls back to a copy (LOCK-4426)', () => {
    writeLive(dataRoot, { 'old.png': 'old' })
    buildCandidate(dataRoot, { 'a.png': 'aaa' })

    let call = 0
    const realRenameSync = nodeFs.renameSync
    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(((
      src: realFs.PathLike,
      dest: realFs.PathLike
    ) => {
      call += 1
      if (call === 2) {
        const error: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted')
        error.code = 'EXDEV'
        throw error
      }
      return realRenameSync(src, dest)
    }) as typeof realFs.renameSync)
    const copySpy = vi.spyOn(nodeFs, 'copyFileSync')

    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    renameSpy.mockRestore()
    copySpy.mockRestore()

    // The candidate → live rename did NOT happen → pre-install per the
    // module's documented taxonomy.
    expectPreInstallFailure(result, 'CANDIDATE_SWAP_CROSS_DEVICE', 'EXDEV')
    expect(copySpy).not.toHaveBeenCalled()
    expect(realFs.existsSync(resolveLiveFilesDir(dataRoot))).toBe(false)
    expect(readDirMap(swapStagingDir(dataRoot))['old.png']?.toString()).toBe('old')
    expect(realFs.existsSync(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot))).toBe(true)
  })

  it('fails post-install with PARENT_DIR_SYNC_FAILED after the rename — live holds the complete candidate', () => {
    writeLive(dataRoot, { 'old.png': 'old' })
    buildCandidate(dataRoot, { 'a.png': 'aaa' })

    const realOpenSync = nodeFs.openSync
    const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation(((
      filePath: realFs.PathLike,
      flags: realFs.OpenMode,
      mode?: realFs.Mode | null
    ) => {
      if (typeof filePath === 'string' && filePath === dataRoot) {
        const error: NodeJS.ErrnoException = new Error('EIO: injected parent fsync failure')
        error.code = 'EIO'
        throw error
      }
      return realOpenSync(filePath, flags, mode)
    }) as typeof realFs.openSync)

    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    openSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.phase).toBe('post-install')
      expect(result.code).toBe('PARENT_DIR_SYNC_FAILED')
      expect(result.safeCode).toBe('EIO')
    }
    // Complete new generation at the live path (no mixed directory).
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['a.png']?.toString()).toBe('aaa')
    expect(realFs.existsSync(resolveCandidateFilesDir(CANDIDATE_ID, dataRoot))).toBe(false)
  })

  it('fails post-install with INSTALLED_PARITY_FAILED when the installed live is tampered after the swap', () => {
    writeLive(dataRoot, { 'old.png': 'old' })
    buildCandidate(dataRoot, { 'a.png': 'aaa' })

    const result = installCandidateFiles({
      candidateId: CANDIDATE_ID,
      dataRoot,
      onAfterCandidateSwap: () => {
        realFs.writeFileSync(realPath.join(resolveLiveFilesDir(dataRoot), 'a.png'), 'TAMPERED')
      }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.phase).toBe('post-install')
      expect(result.code).toBe('INSTALLED_PARITY_FAILED')
    }
    // Whatever sits at the live path is retained (LOCK-4425 analog).
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['a.png']?.toString()).toBe('TAMPERED')
  })

  it('fails post-install with SWAP_STAGING_REMOVE_FAILED when the old generation cannot be removed', () => {
    writeLive(dataRoot, { 'old.png': 'old' })
    buildCandidate(dataRoot, { 'a.png': 'aaa' })

    let rmCalls = 0
    const realRmSync = nodeFs.rmSync
    const rmSpy = vi.spyOn(nodeFs, 'rmSync').mockImplementation(((
      target: realFs.PathLike,
      options?: realFs.RmOptions
    ) => {
      rmCalls += 1
      // First rmSync = stale-swap cleanup (pass); second = post-verify
      // removal of the superseded old generation (inject failure).
      if (rmCalls === 2) {
        const error: NodeJS.ErrnoException = new Error('EACCES: injected removal failure')
        error.code = 'EACCES'
        throw error
      }
      return realRmSync(target, options)
    }) as typeof realFs.rmSync)

    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    rmSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.phase).toBe('post-install')
      expect(result.code).toBe('SWAP_STAGING_REMOVE_FAILED')
    }
    // Live = complete new generation; old generation still retained at the
    // swap-staging path (recoverable, never a mixed live dir).
    expect(readDirMap(resolveLiveFilesDir(dataRoot))['a.png']?.toString()).toBe('aaa')
    expect(readDirMap(swapStagingDir(dataRoot))['old.png']?.toString()).toBe('old')
  })

  // -------------------------------------------------------------------------
  // Receipt privacy
  // -------------------------------------------------------------------------

  it('returns a privacy-clean aggregate receipt (no filenames or paths)', () => {
    buildCandidate(dataRoot, { 'private-attachment.png': 'aaa' })
    const result = installCandidateFiles({ candidateId: CANDIDATE_ID, dataRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const serialized = JSON.stringify(result.receipt)
    expect(serialized).not.toContain('private-attachment.png')
    expect(serialized).not.toContain(dataRoot)
  })
})

/** Write {name → content} files into the live Files dir. */
function writeLive(dataRoot: string, files: Record<string, Buffer | string>): void {
  const dir = resolveLiveFilesDir(dataRoot)
  realFs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    realFs.writeFileSync(realPath.join(dir, name), Buffer.isBuffer(content) ? content : Buffer.from(content))
  }
}
