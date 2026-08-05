/**
 * Promotion journal store v2 tests (LOCK-PROMO-2/6, LOCK-JRNL-2).
 *
 * Covers the three-artifact store surface that has no dedicated coverage:
 * - writeCandidatesReadyPromotionJournal — the ONLY initial v2 write gate
 *   (phase `candidates-ready`).
 * - advancePromotionJournalV2 — the strict-successor transition API over the
 *   full chain candidates-ready → snapshots-ready → db-installed →
 *   files-installed → catalog-pending → catalog-applied →
 *   replacement-verified, with every guard rejection class:
 *   absent/invalid/v1 prior, phase skip/regression/repeat, identity
 *   mismatch, candidate-receipt mutation, and old-receipt regression
 *   (null → value allowed exactly once at snapshots-ready; value → value /
 *   value → null rejected).
 * - cleanupPromotionJournalAtV2Phase — phase-bound v2 cleanup.
 * - Crash-point discipline: every transition persists AFTER its operation;
 *   a rejected or failed transition leaves the prior journal byte-identical
 *   (LOCK-4425 analog).
 *
 * Production-path style: unmock node:fs/os/path so the store runs against
 * the REAL filesystem in a temp Data root per test.
 */

import * as realFs from 'node:fs'
import fsp from 'node:fs/promises'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

// Every call injects an explicit temp dataRoot — never a live Data path.
vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

import {
  encodePromotionJournal,
  isV2SuccessorPhase,
  PROMOTION_JOURNAL_FILENAME,
  PROMOTION_JOURNAL_PHASES_V2,
  PROMOTION_JOURNAL_VERSION_V2,
  type PromotionJournalPhaseV2,
  type PromotionJournalV2
} from '../journal'
import {
  PROMOTION_JOURNAL_STAGING_FILENAME,
  type PromotionJournalCleanupIdentity,
  PromotionJournalStoreError,
  readPromotionJournal
} from '../journalStore'
import {
  advancePromotionJournalV2,
  cleanupPromotionJournalAtV2Phase,
  writeCandidatesReadyPromotionJournal
} from '../journalStore'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'import-s1'
const CANDIDATE_ID = 'candidate-import-s1'

const CANDIDATE_RECEIPTS = {
  db: { sha256: 'a'.repeat(64), size: 100 },
  files: { count: 2, totalBytes: 512, sha256: 'b'.repeat(64) },
  catalog: { count: 2, sha256: 'c'.repeat(64) }
}

const OLD_RECEIPTS = {
  db: { sha256: 'd'.repeat(64), size: 200 },
  files: { count: 1, totalBytes: 256, sha256: 'e'.repeat(64) },
  catalog: { count: 1, sha256: 'f'.repeat(64) }
}

function v2Doc(phase: PromotionJournalV2['phase'], overrides: Partial<PromotionJournalV2> = {}): PromotionJournalV2 {
  return {
    version: PROMOTION_JOURNAL_VERSION_V2,
    sessionId: SESSION_ID,
    candidateId: CANDIDATE_ID,
    phase,
    receipts: { candidate: CANDIDATE_RECEIPTS, old: { db: null, files: null, catalog: null } },
    ...overrides
  }
}

/** The snapshots-ready document with the old receipts filled in once. */
function snapshotsReadyDoc(): PromotionJournalV2 {
  return v2Doc('snapshots-ready', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
}

/** The full strict-successor chain (each next is the successor of prior). */
const CHAIN: ReadonlyArray<readonly [PromotionJournalPhaseV2, PromotionJournalPhaseV2]> = [
  ['candidates-ready', 'snapshots-ready'],
  ['snapshots-ready', 'db-installed'],
  ['db-installed', 'files-installed'],
  ['files-installed', 'catalog-pending'],
  ['catalog-pending', 'catalog-applied'],
  ['catalog-applied', 'replacement-verified']
]

const IDENTITY: PromotionJournalCleanupIdentity = { sessionId: SESSION_ID, candidateId: CANDIDATE_ID }

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeDataRoot(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'cherry-journal-store-v2-test-'))
}

function rmrf(dir: string): void {
  try {
    realFs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`injected ${code}`)
  error.code = code
  return error
}

async function expectStoreError(promise: Promise<unknown>, code: string): Promise<PromotionJournalStoreError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(PromotionJournalStoreError)
  expect((caught as PromotionJournalStoreError).code).toBe(code)
  return caught as PromotionJournalStoreError
}

/** Seed the durable journal with the exact canonical bytes of `doc`. */
function seedJournal(doc: PromotionJournalV2, journalPath: string): void {
  realFs.writeFileSync(journalPath, encodePromotionJournal(doc), 'utf8')
}

function expectDurableState(doc: PromotionJournalV2, journalPath: string, stagingPath: string): void {
  expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(doc))
  expect(realFs.existsSync(stagingPath)).toBe(false)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promotion journal store v2 (LOCK-PROMO-2/6)', () => {
  let dataRoot: string
  let journalPath: string
  let stagingPath: string

  beforeEach(() => {
    dataRoot = makeDataRoot()
    journalPath = realPath.join(dataRoot, PROMOTION_JOURNAL_FILENAME)
    stagingPath = realPath.join(dataRoot, PROMOTION_JOURNAL_STAGING_FILENAME)
  })

  afterEach(() => {
    rmrf(dataRoot)
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Initial v2 write gate
  // -------------------------------------------------------------------------

  describe('writeCandidatesReadyPromotionJournal (LOCK-PROMO-2 initial write)', () => {
    it('publishes the exact canonical v2 bytes at the fixed path; no staging residue', async () => {
      const doc = v2Doc('candidates-ready')
      await writeCandidatesReadyPromotionJournal(doc, dataRoot)
      expectDurableState(doc, journalPath, stagingPath)
      expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'valid', journal: doc })
    })

    it.each(PROMOTION_JOURNAL_PHASES_V2.filter((phase) => phase !== 'candidates-ready'))(
      'refuses phase %s with PHASE_NOT_WRITABLE and no filesystem effect',
      async (phase) => {
        const doc = v2Doc(phase)
        await expectStoreError(writeCandidatesReadyPromotionJournal(doc, dataRoot), 'PHASE_NOT_WRITABLE')
        expect(realFs.existsSync(journalPath)).toBe(false)
        expect(realFs.existsSync(stagingPath)).toBe(false)
      }
    )

    it('refuses a v1 document with PHASE_NOT_WRITABLE', async () => {
      const v1 = { version: 1, sessionId: SESSION_ID, candidateId: CANDIDATE_ID, phase: 'snapshot-ready' }
      await expectStoreError(
        writeCandidatesReadyPromotionJournal(v1 as unknown as PromotionJournalV2, dataRoot),
        'PHASE_NOT_WRITABLE'
      )
      expect(realFs.existsSync(journalPath)).toBe(false)
    })

    it('refuses documents the strict codec rejects (malformed receipts) before any I/O', async () => {
      const doc = v2Doc('candidates-ready', {
        receipts: {
          candidate: { db: { sha256: 'not-a-hash', size: 1 }, files: null, catalog: null },
          old: { db: null, files: null, catalog: null }
        }
      })
      await expectStoreError(writeCandidatesReadyPromotionJournal(doc, dataRoot), 'JOURNAL_ENCODE_REJECTED')
      expect(realFs.existsSync(journalPath)).toBe(false)
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // isV2SuccessorPhase (pure ordering contract, LOCK-JRNL-2)
  // -------------------------------------------------------------------------

  describe('isV2SuccessorPhase', () => {
    it('is true exactly for consecutive ordered pairs', () => {
      for (const [prior, next] of CHAIN) {
        expect(isV2SuccessorPhase(prior, next)).toBe(true)
      }
    })

    it('is false for skips, regressions, repeats, and the terminal successor', () => {
      expect(isV2SuccessorPhase('candidates-ready', 'db-installed')).toBe(false)
      expect(isV2SuccessorPhase('candidates-ready', 'replacement-verified')).toBe(false)
      expect(isV2SuccessorPhase('db-installed', 'snapshots-ready')).toBe(false)
      expect(isV2SuccessorPhase('catalog-applied', 'catalog-pending')).toBe(false)
      expect(isV2SuccessorPhase('snapshots-ready', 'snapshots-ready')).toBe(false)
      expect(isV2SuccessorPhase('replacement-verified', 'candidates-ready')).toBe(false)
      // The terminal phase has no successor.
      expect(isV2SuccessorPhase('replacement-verified', 'candidates-ready')).toBe(false)
    })

    it('every strict transition in the chain is a subset of the ordered phase list', () => {
      for (const [prior, next] of CHAIN) {
        const priorIndex = PROMOTION_JOURNAL_PHASES_V2.indexOf(prior)
        const nextIndex = PROMOTION_JOURNAL_PHASES_V2.indexOf(next)
        expect(nextIndex).toBe(priorIndex + 1)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Full strict-successor chain (crash-point journal discipline)
  // -------------------------------------------------------------------------

  describe('advancePromotionJournalV2 — full chain', () => {
    it('walks the entire chain with exact canonical bytes at every step', async () => {
      const docs: Record<PromotionJournalV2['phase'], PromotionJournalV2> = {
        'candidates-ready': v2Doc('candidates-ready'),
        'snapshots-ready': snapshotsReadyDoc(),
        'db-installed': v2Doc('db-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'files-installed': v2Doc('files-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'catalog-pending': v2Doc('catalog-pending', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'catalog-applied': v2Doc('catalog-applied', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'replacement-verified': v2Doc('replacement-verified', {
          receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS }
        })
      }

      await writeCandidatesReadyPromotionJournal(docs['candidates-ready'], dataRoot)
      expectDurableState(docs['candidates-ready'], journalPath, stagingPath)

      for (const [prior, next] of CHAIN) {
        await advancePromotionJournalV2(docs[next], prior, dataRoot)
        expectDurableState(docs[next], journalPath, stagingPath)
        expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'valid', journal: docs[next] })
      }
    })

    it('advances with semantically equal receipts in reversed nested key order (LOCK-CLOSE-2)', async () => {
      const prior = v2Doc('candidates-ready')
      seedJournal(prior, journalPath)

      // Same document as snapshotsReadyDoc() but every nested receipt object
      // is rebuilt with reversed property insertion order.
      const reversed: PromotionJournalV2 = {
        version: PROMOTION_JOURNAL_VERSION_V2,
        sessionId: SESSION_ID,
        candidateId: CANDIDATE_ID,
        phase: 'snapshots-ready',
        receipts: {
          candidate: {
            catalog: { sha256: CANDIDATE_RECEIPTS.catalog.sha256, count: CANDIDATE_RECEIPTS.catalog.count },
            files: {
              sha256: CANDIDATE_RECEIPTS.files.sha256,
              totalBytes: CANDIDATE_RECEIPTS.files.totalBytes,
              count: CANDIDATE_RECEIPTS.files.count
            },
            db: { size: CANDIDATE_RECEIPTS.db.size, sha256: CANDIDATE_RECEIPTS.db.sha256 }
          },
          old: {
            catalog: { sha256: OLD_RECEIPTS.catalog.sha256, count: OLD_RECEIPTS.catalog.count },
            files: {
              sha256: OLD_RECEIPTS.files.sha256,
              totalBytes: OLD_RECEIPTS.files.totalBytes,
              count: OLD_RECEIPTS.files.count
            },
            db: { size: OLD_RECEIPTS.db.size, sha256: OLD_RECEIPTS.db.sha256 }
          }
        }
      }

      await advancePromotionJournalV2(reversed, 'candidates-ready', dataRoot)

      // The guard accepts (canonical equality) and the durable bytes are the
      // canonical writer-order bytes of the equivalent document.
      expectDurableState(snapshotsReadyDoc(), journalPath, stagingPath)
    })

    it('runs guard-read → staging-open → write → file-sync → close → rename → dir-sync', async () => {
      const prior = v2Doc('candidates-ready')
      const next = snapshotsReadyDoc()
      seedJournal(prior, journalPath)

      const events: string[] = []
      const realRead = fsp.readFile
      const realOpen = fsp.open
      const realRename = fsp.rename

      vi.spyOn(fsp, 'readFile').mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
        events.push('guard-read')
        return realRead.apply(fsp, args)
      })
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const target = String(args[0])
        const isDir = target === dataRoot
        const handle = await realOpen.apply(fsp, args)
        events.push(isDir ? 'dir-open' : `staging-open:${realPath.basename(target)}`)
        const realWriteFile = handle.writeFile.bind(handle)
        const realSync = handle.sync.bind(handle)
        const realClose = handle.close.bind(handle)
        handle.writeFile = async (...writeArgs: Parameters<typeof realWriteFile>) => {
          events.push('write')
          return realWriteFile(...writeArgs)
        }
        handle.sync = async () => {
          events.push(isDir ? 'dir-sync' : 'file-sync')
          return realSync()
        }
        handle.close = async () => {
          events.push(isDir ? 'dir-close' : 'file-close')
          return realClose()
        }
        return handle
      })
      vi.spyOn(fsp, 'rename').mockImplementation(async (...args: Parameters<typeof fsp.rename>) => {
        events.push('rename')
        return realRename.apply(fsp, args)
      })

      await advancePromotionJournalV2(next, 'candidates-ready', dataRoot)

      expect(events).toEqual([
        'guard-read',
        `staging-open:${PROMOTION_JOURNAL_STAGING_FILENAME}`,
        'write',
        'file-sync',
        'file-close',
        'rename',
        'dir-open',
        'dir-sync',
        'dir-close'
      ])
      expectDurableState(next, journalPath, stagingPath)
    })
  })

  // -------------------------------------------------------------------------
  // Guard rejections (all pre-mutation, LOCK-JRNL-2)
  // -------------------------------------------------------------------------

  describe('advancePromotionJournalV2 — guard rejections', () => {
    const next = v2Doc('db-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })

    it('absent journal → TRANSITION_JOURNAL_ABSENT; nothing created', async () => {
      await expectStoreError(advancePromotionJournalV2(next, 'snapshots-ready', dataRoot), 'TRANSITION_JOURNAL_ABSENT')
      expect(realFs.existsSync(journalPath)).toBe(false)
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })

    it('invalid journal → TRANSITION_JOURNAL_INVALID; invalid bytes preserved (LOCK-4425 analog)', async () => {
      realFs.writeFileSync(journalPath, 'not json {', 'utf8')
      await expectStoreError(advancePromotionJournalV2(next, 'snapshots-ready', dataRoot), 'TRANSITION_JOURNAL_INVALID')
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe('not json {')
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })

    it('v1 prior journal → TRANSITION_PHASE_MISMATCH (a v2 promotion never continues a v1 journal, LOCK-PROMO-10)', async () => {
      const v1 = { version: 1, sessionId: SESSION_ID, candidateId: CANDIDATE_ID, phase: 'snapshot-ready' }
      seedJournal(v1 as unknown as PromotionJournalV2, journalPath)
      await expectStoreError(advancePromotionJournalV2(next, 'snapshots-ready', dataRoot), 'TRANSITION_PHASE_MISMATCH')
      expectDurableState(v1 as unknown as PromotionJournalV2, journalPath, stagingPath)
    })

    it.each([
      [
        'phase skip',
        snapshotsReadyDoc(),
        'candidates-ready' as const,
        v2Doc('files-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'db-installed' as const
      ],
      [
        'phase regression',
        v2Doc('catalog-applied', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'catalog-applied' as const,
        v2Doc('catalog-pending', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'files-installed' as const
      ],
      [
        'phase repeat',
        v2Doc('db-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'snapshots-ready' as const,
        v2Doc('snapshots-ready', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } }),
        'candidates-ready' as const
      ]
    ] as const)(
      '%s → TRANSITION_PHASE_MISMATCH; prior journal preserved',
      async (_label, prior, _expectedPrior, attempted, priorForAttempt) => {
        seedJournal(prior, journalPath)
        // The attempted doc claims a prior phase the durable journal does not
        // match (skip/regression/repeat), so the guard rejects.
        const doc = attempted
        const asPrior = priorForAttempt
        await expectStoreError(advancePromotionJournalV2(doc, asPrior, dataRoot), 'TRANSITION_PHASE_MISMATCH')
        expectDurableState(prior, journalPath, stagingPath)
      }
    )

    it('expectedPrior not a strict predecessor → PHASE_NOT_WRITABLE before any journal read', async () => {
      const prior = snapshotsReadyDoc()
      seedJournal(prior, journalPath)
      const readSpy = vi.spyOn(fsp, 'readFile')
      const doc = v2Doc('db-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      await expectStoreError(advancePromotionJournalV2(doc, 'candidates-ready', dataRoot), 'PHASE_NOT_WRITABLE')
      expect(readSpy).not.toHaveBeenCalled()
      expectDurableState(prior, journalPath, stagingPath)
    })

    it('durable journal at a different phase than the expected strict predecessor → TRANSITION_PHASE_MISMATCH; journal preserved', async () => {
      // The durable journal is at catalog-pending, but the attempted doc
      // (db-installed) requires its strict predecessor snapshots-ready.
      const durable = v2Doc('catalog-pending', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      seedJournal(durable, journalPath)
      const doc = v2Doc('db-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      await expectStoreError(advancePromotionJournalV2(doc, 'snapshots-ready', dataRoot), 'TRANSITION_PHASE_MISMATCH')
      expectDurableState(durable, journalPath, stagingPath)
    })

    it.each([
      ['sessionId', { sessionId: 'import-other-session' }],
      ['candidateId', { candidateId: 'candidate-import-other' }]
    ] as const)('cross-%s → TRANSITION_IDENTITY_MISMATCH; journal preserved', async (_field, overrides) => {
      const prior = snapshotsReadyDoc()
      seedJournal(prior, journalPath)
      const doc = v2Doc('db-installed', {
        receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS },
        ...overrides
      })
      await expectStoreError(
        advancePromotionJournalV2(doc, 'snapshots-ready', dataRoot),
        'TRANSITION_IDENTITY_MISMATCH'
      )
      expectDurableState(prior, journalPath, stagingPath)
    })

    it('candidate receipt mutation → TRANSITION_IDENTITY_MISMATCH (immutable once written, LOCK-JRNL-2)', async () => {
      const prior = snapshotsReadyDoc()
      seedJournal(prior, journalPath)
      const tampered = v2Doc('db-installed', {
        receipts: {
          candidate: { db: { sha256: '9'.repeat(64), size: 100 }, files: null, catalog: null },
          old: OLD_RECEIPTS
        }
      })
      await expectStoreError(
        advancePromotionJournalV2(tampered, 'snapshots-ready', dataRoot),
        'TRANSITION_IDENTITY_MISMATCH'
      )
      expectDurableState(prior, journalPath, stagingPath)
    })

    it('old receipt regression value → null → TRANSITION_IDENTITY_MISMATCH (filled exactly once)', async () => {
      const prior = v2Doc('snapshots-ready', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      seedJournal(prior, journalPath)
      const regressed = v2Doc('db-installed', {
        receipts: { candidate: CANDIDATE_RECEIPTS, old: { db: null, files: null, catalog: null } }
      })
      await expectStoreError(
        advancePromotionJournalV2(regressed, 'snapshots-ready', dataRoot),
        'TRANSITION_IDENTITY_MISMATCH'
      )
      expectDurableState(prior, journalPath, stagingPath)
    })

    it('old receipt value → different value → TRANSITION_IDENTITY_MISMATCH', async () => {
      const prior = v2Doc('snapshots-ready', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      seedJournal(prior, journalPath)
      const diverged = v2Doc('db-installed', {
        receipts: {
          candidate: CANDIDATE_RECEIPTS,
          old: { ...OLD_RECEIPTS, db: { sha256: '7'.repeat(64), size: 999 } }
        }
      })
      await expectStoreError(
        advancePromotionJournalV2(diverged, 'snapshots-ready', dataRoot),
        'TRANSITION_IDENTITY_MISMATCH'
      )
      expectDurableState(prior, journalPath, stagingPath)
    })

    it('guard-read I/O failure → READ_IO_FAILED (never absent); no mutation', async () => {
      const prior = snapshotsReadyDoc()
      seedJournal(prior, journalPath)
      vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(errnoError('EACCES'))
      const doc = v2Doc('db-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      await expectStoreError(advancePromotionJournalV2(doc, 'snapshots-ready', dataRoot), 'READ_IO_FAILED')
      expectDurableState(prior, journalPath, stagingPath)
    })

    it('a rejected transition performs no staging or publish mutation (no fs.open/rename after guard)', async () => {
      const prior = snapshotsReadyDoc()
      seedJournal(prior, journalPath)
      const openSpy = vi.spyOn(fsp, 'open')
      const renameSpy = vi.spyOn(fsp, 'rename')
      const doc = v2Doc('db-installed', {
        receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS },
        sessionId: 'import-other-session'
      })
      await expectStoreError(
        advancePromotionJournalV2(doc, 'snapshots-ready', dataRoot),
        'TRANSITION_IDENTITY_MISMATCH'
      )
      expect(openSpy).not.toHaveBeenCalled()
      expect(renameSpy).not.toHaveBeenCalled()
      expectDurableState(prior, journalPath, stagingPath)
    })
  })

  // -------------------------------------------------------------------------
  // Durable-failure containment (LOCK-4411 analog): prior journal authoritative
  // -------------------------------------------------------------------------

  describe('advancePromotionJournalV2 — durable failure containment', () => {
    const prior = snapshotsReadyDoc()
    const next = v2Doc('db-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })

    /** Wrap fsp.open so the staging FileHandle method rejects once. */
    function injectStagingFault(method: 'writeFile' | 'sync' | 'close'): void {
      const realOpen = fsp.open
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const isDir = String(args[0]) === dataRoot
        const handle = await realOpen.apply(fsp, args)
        if (!isDir) {
          const original = handle[method].bind(handle)
          let injected = false
          ;(handle as unknown as Record<string, unknown>)[method] = async (...callArgs: unknown[]) => {
            if (!injected) {
              injected = true
              throw errnoError('EIO')
            }
            return (original as (...a: unknown[]) => Promise<unknown>)(...callArgs)
          }
        }
        return handle
      })
    }

    it.each([
      ['writeFile', 'STAGING_WRITE_FAILED'],
      ['sync', 'STAGING_SYNC_FAILED'],
      ['close', 'STAGING_CLOSE_FAILED']
    ] as const)('staging %s failure → %s; prior journal remains authoritative', async (_method, code) => {
      seedJournal(prior, journalPath)
      injectStagingFault(_method)
      await expectStoreError(advancePromotionJournalV2(next, 'snapshots-ready', dataRoot), code)
      expectDurableState(prior, journalPath, stagingPath)
    })

    it('publish rename failure → PUBLISH_RENAME_FAILED; prior journal authoritative', async () => {
      seedJournal(prior, journalPath)
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO'))
      await expectStoreError(advancePromotionJournalV2(next, 'snapshots-ready', dataRoot), 'PUBLISH_RENAME_FAILED')
      expectDurableState(prior, journalPath, stagingPath)
    })
  })

  // -------------------------------------------------------------------------
  // v2 cleanup (LOCK-PROMO-6: rollback completion cleans up at the v2 phase)
  // -------------------------------------------------------------------------

  describe('cleanupPromotionJournalAtV2Phase', () => {
    it('removes a valid v2 journal at the exact expected phase; snapshot/candidate never touched', async () => {
      const doc = v2Doc('catalog-applied', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      seedJournal(doc, journalPath)

      // Guard artifacts that must survive.
      const snapshotPath = realPath.join(dataRoot, 'chat.db.pre-import-backup')
      realFs.writeFileSync(snapshotPath, 'retained')

      const result = await cleanupPromotionJournalAtV2Phase('catalog-applied', IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
      expect(realFs.existsSync(journalPath)).toBe(false)
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.readFileSync(snapshotPath, 'utf8')).toBe('retained')
    })

    it('is idempotent on an already-absent journal', async () => {
      const result = await cleanupPromotionJournalAtV2Phase('candidates-ready', IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: false, reason: 'already-absent' })
    })

    it('rejects a phase mismatch with CLEANUP_PHASE_MISMATCH; journal preserved', async () => {
      const doc = v2Doc('snapshots-ready', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      seedJournal(doc, journalPath)
      await expectStoreError(
        cleanupPromotionJournalAtV2Phase('replacement-verified', IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )
      expectDurableState(doc, journalPath, stagingPath)
    })

    it('rejects a v1 journal with CLEANUP_PHASE_MISMATCH; journal preserved', async () => {
      const v1 = { version: 1, sessionId: SESSION_ID, candidateId: CANDIDATE_ID, phase: 'snapshot-ready' }
      seedJournal(v1 as unknown as PromotionJournalV2, journalPath)
      await expectStoreError(
        cleanupPromotionJournalAtV2Phase('snapshots-ready', IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )
      expectDurableState(v1 as unknown as PromotionJournalV2, journalPath, stagingPath)
    })

    it('rejects invalid bytes with CLEANUP_JOURNAL_INVALID; bytes preserved', async () => {
      realFs.writeFileSync(journalPath, 'not json {', 'utf8')
      await expectStoreError(
        cleanupPromotionJournalAtV2Phase('candidates-ready', IDENTITY, dataRoot),
        'CLEANUP_JOURNAL_INVALID'
      )
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe('not json {')
    })

    it('rejects an identity mismatch with CLEANUP_IDENTITY_MISMATCH; journal preserved', async () => {
      const doc = v2Doc('files-installed', { receipts: { candidate: CANDIDATE_RECEIPTS, old: OLD_RECEIPTS } })
      seedJournal(doc, journalPath)
      await expectStoreError(
        cleanupPromotionJournalAtV2Phase('files-installed', { ...IDENTITY, sessionId: 'import-other' }, dataRoot),
        'CLEANUP_IDENTITY_MISMATCH'
      )
      expectDurableState(doc, journalPath, stagingPath)
    })
  })
})
