/**
 * Promotion journal store tests (Phase 4.4.1, LOCK-4411..LOCK-4417).
 *
 * Production-path style: unmock node:fs/os/path so the store runs against
 * the REAL filesystem in a temp Data root per test (candidateDb pattern).
 * Fault injection wraps the real node:fs/promises functions and FileHandles
 * so failure ordering and cleanup are observed against real syscalls.
 *
 * Coverage:
 * - Fixed owned path: journal + staging derive from fixed filenames under
 *   the provided controlled Data root; no API accepts a journal path.
 * - Write gate: only `snapshot-ready` is writable (LOCK-4417); invalid
 *   documents are rejected before any filesystem effect.
 * - Durable ordering: staging open → write → file fsync → close → atomic
 *   rename → parent directory fsync (darwin).
 * - Fault injection at every step: staging open/write, file sync, close,
 *   rename, parent dir open/sync — structured error codes, no lingering
 *   staging artifact, previously published journal untouched (LOCK-4411).
 * - Strict three-state read (LOCK-4414): only ENOENT is absent; codec
 *   rejection is invalid (never absent); any other I/O failure throws
 *   READ_IO_FAILED (never absent, never invalid).
 */

import * as realFs from 'node:fs'
import fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Unmock the globally-mocked node modules — we need real filesystem behavior.
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

// Mock @main/config so importing the store never touches a live Data path.
// Every call in these tests injects an explicit temp dataRoot.
vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

import { encodePromotionJournal, PROMOTION_JOURNAL_FILENAME, type PromotionJournalV1 } from '../journal'
import type { PromotionJournalCleanupIdentity } from '../journalStore'
import {
  advancePromotionJournalToCandidateInstalled,
  advancePromotionJournalToReplacementVerified,
  cleanupPromotionJournalAfterCandidateInstalled,
  cleanupPromotionJournalAfterReplacementVerified,
  cleanupPromotionJournalAfterSnapshotReady,
  getPromotionJournalPath,
  getPromotionJournalStagingPath,
  PROMOTION_JOURNAL_STAGING_FILENAME,
  PromotionJournalStoreError,
  readPromotionJournal,
  writeSnapshotReadyPromotionJournal
} from '../journalStore'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID: PromotionJournalV1 = {
  version: 1,
  sessionId: 'import-abc123-xyz',
  candidateId: 'candidate-import-abc123-xyz',
  phase: 'snapshot-ready'
}

function makeDataRoot(): string {
  return realFs.mkdtempSync(path.join(os.tmpdir(), 'cherry-journal-store-test-'))
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promotion journal store (LOCK-4411..4417)', () => {
  let dataRoot: string
  let journalPath: string
  let stagingPath: string

  beforeEach(() => {
    dataRoot = makeDataRoot()
    journalPath = path.join(dataRoot, PROMOTION_JOURNAL_FILENAME)
    stagingPath = path.join(dataRoot, PROMOTION_JOURNAL_STAGING_FILENAME)
  })

  afterEach(() => {
    rmrf(dataRoot)
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Fixed owned path — no caller-supplied journal paths
  // -------------------------------------------------------------------------

  describe('fixed owned path', () => {
    it('resolves the journal at the fixed filename directly under the data root', () => {
      expect(getPromotionJournalPath(dataRoot)).toBe(journalPath)
      expect(path.basename(getPromotionJournalPath(dataRoot))).toBe(PROMOTION_JOURNAL_FILENAME)
    })

    it('staging is a fixed-name sibling in the same directory (same filesystem rename)', () => {
      expect(getPromotionJournalStagingPath(dataRoot)).toBe(stagingPath)
      expect(path.dirname(stagingPath)).toBe(path.dirname(journalPath))
      expect(PROMOTION_JOURNAL_STAGING_FILENAME.startsWith(PROMOTION_JOURNAL_FILENAME)).toBe(true)
      expect(PROMOTION_JOURNAL_STAGING_FILENAME).not.toBe(PROMOTION_JOURNAL_FILENAME)
      for (const name of [PROMOTION_JOURNAL_STAGING_FILENAME]) {
        expect(name).not.toContain('/')
        expect(name).not.toContain('\\')
        expect(name).not.toContain('..')
      }
    })

    it('the leaf filename is always the fixed constant regardless of the provided root', () => {
      // The API accepts only a data root; a caller can never name the file.
      for (const root of [dataRoot, '/tmp/anything', '/a/b/c']) {
        expect(path.basename(getPromotionJournalPath(root))).toBe(PROMOTION_JOURNAL_FILENAME)
        expect(path.basename(getPromotionJournalStagingPath(root))).toBe(PROMOTION_JOURNAL_STAGING_FILENAME)
      }
    })

    it('rejects empty / non-string / NUL data roots with DATA_ROOT_REJECTED', async () => {
      expect(() => getPromotionJournalPath('')).toThrow(PromotionJournalStoreError)
      expect(() => getPromotionJournalPath('a\0b')).toThrow(PromotionJournalStoreError)
      await expectStoreError(readPromotionJournal(''), 'DATA_ROOT_REJECTED')
      await expectStoreError(writeSnapshotReadyPromotionJournal(VALID, ''), 'DATA_ROOT_REJECTED')
      await expectStoreError(
        writeSnapshotReadyPromotionJournal(VALID, undefined as unknown as string),
        // undefined falls back to the mocked DATA_PATH default — that is a
        // controlled root, so the write proceeds and fails on the missing
        // mock directory instead. Assert the staging-open failure category.
        'STAGING_WRITE_FAILED'
      )
    })
  })

  // -------------------------------------------------------------------------
  // Write — happy path
  // -------------------------------------------------------------------------

  describe('write (snapshot-ready)', () => {
    it('publishes the exact canonical codec bytes at the fixed path and leaves no staging', async () => {
      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)

      expect(realFs.existsSync(journalPath)).toBe(true)
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(VALID))
    })

    it('read-after-write returns the identical valid journal', async () => {
      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)
      const result = await readPromotionJournal(dataRoot)
      expect(result).toEqual({ status: 'valid', journal: VALID })
    })

    it('a second write atomically replaces the first', async () => {
      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)
      const second: PromotionJournalV1 = { ...VALID, sessionId: 'import-second-run' }
      await writeSnapshotReadyPromotionJournal(second, dataRoot)

      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(second))
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Write gate — maximum writable phase is snapshot-ready (LOCK-4417)
  // -------------------------------------------------------------------------

  describe('write gate (LOCK-4417)', () => {
    it.each(['candidate-installed', 'replacement-verified'] as const)(
      'refuses phase %s with PHASE_NOT_WRITABLE and no filesystem effect',
      async (phase) => {
        const doc: PromotionJournalV1 = { ...VALID, phase }
        await expectStoreError(writeSnapshotReadyPromotionJournal(doc, dataRoot), 'PHASE_NOT_WRITABLE')
        expect(realFs.existsSync(journalPath)).toBe(false)
        expect(realFs.existsSync(stagingPath)).toBe(false)
      }
    )

    it('refuses unknown phases with PHASE_NOT_WRITABLE', async () => {
      const doc = { ...VALID, phase: 'promoted' } as unknown as PromotionJournalV1
      await expectStoreError(writeSnapshotReadyPromotionJournal(doc, dataRoot), 'PHASE_NOT_WRITABLE')
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })

    it('refuses documents the strict codec rejects (path-shaped IDs) before any I/O', async () => {
      const doc = { ...VALID, sessionId: '../etc' } as PromotionJournalV1
      await expectStoreError(writeSnapshotReadyPromotionJournal(doc, dataRoot), 'JOURNAL_ENCODE_REJECTED')
      expect(realFs.existsSync(journalPath)).toBe(false)
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Durable ordering — temp/write/sync/close/rename/dir-sync
  // -------------------------------------------------------------------------

  describe('durable replacement ordering', () => {
    it('executes staging-open → write → file-sync → close → rename → dir-open → dir-sync → dir-close', async () => {
      const events: string[] = []
      const realOpen = fsp.open
      const realRename = fsp.rename

      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const target = String(args[0])
        const isDir = target === dataRoot
        const handle = await realOpen.apply(fsp, args)
        events.push(isDir ? 'dir-open' : `staging-open:${path.basename(target)}`)

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

      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)

      expect(events).toEqual([
        `staging-open:${PROMOTION_JOURNAL_STAGING_FILENAME}`,
        'write',
        'file-sync',
        'file-close',
        'rename',
        'dir-open',
        'dir-sync',
        'dir-close'
      ])
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(VALID))
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Fault injection — one fault per durability step (LOCK-4411)
  // -------------------------------------------------------------------------

  describe('fault injection', () => {
    /** Wrap fsp.open so a named FileHandle method rejects once for the staging file. */
    function injectHandleFault(method: 'writeFile' | 'sync' | 'close', forDir: boolean): void {
      const realOpen = fsp.open
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const isDir = String(args[0]) === dataRoot
        const handle = await realOpen.apply(fsp, args)
        if (isDir === forDir) {
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

    it('staging open failure → STAGING_WRITE_FAILED, nothing created', async () => {
      vi.spyOn(fsp, 'open').mockRejectedValueOnce(errnoError('EACCES'))
      const error = await expectStoreError(writeSnapshotReadyPromotionJournal(VALID, dataRoot), 'STAGING_WRITE_FAILED')
      expect((error.cause as NodeJS.ErrnoException).code).toBe('EACCES')
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.existsSync(journalPath)).toBe(false)
    })

    it('staging write failure → STAGING_WRITE_FAILED, staging cleaned, prior journal untouched', async () => {
      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)
      injectHandleFault('writeFile', false)

      const second: PromotionJournalV1 = { ...VALID, sessionId: 'import-second-run' }
      await expectStoreError(writeSnapshotReadyPromotionJournal(second, dataRoot), 'STAGING_WRITE_FAILED')

      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(VALID))
    })

    it('file fsync failure → STAGING_SYNC_FAILED, staging cleaned, prior journal untouched', async () => {
      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)
      injectHandleFault('sync', false)

      const second: PromotionJournalV1 = { ...VALID, sessionId: 'import-second-run' }
      await expectStoreError(writeSnapshotReadyPromotionJournal(second, dataRoot), 'STAGING_SYNC_FAILED')

      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(VALID))
    })

    it('staging close failure → STAGING_CLOSE_FAILED, staging cleaned', async () => {
      injectHandleFault('close', false)
      await expectStoreError(writeSnapshotReadyPromotionJournal(VALID, dataRoot), 'STAGING_CLOSE_FAILED')
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.existsSync(journalPath)).toBe(false)
    })

    it('publish rename failure → PUBLISH_RENAME_FAILED, staging cleaned, prior journal untouched', async () => {
      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO'))

      const second: PromotionJournalV1 = { ...VALID, sessionId: 'import-second-run' }
      await expectStoreError(writeSnapshotReadyPromotionJournal(second, dataRoot), 'PUBLISH_RENAME_FAILED')

      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(VALID))
    })

    it('parent dir fsync failure → PARENT_DIR_SYNC_FAILED; journal already published, no staging remains', async () => {
      injectHandleFault('sync', true)
      await expectStoreError(writeSnapshotReadyPromotionJournal(VALID, dataRoot), 'PARENT_DIR_SYNC_FAILED')

      // The rename already happened; the bytes are correct but the caller is
      // told durability of the publish is unproven. No staging artifact.
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(VALID))
    })

    it.each(['EINVAL', 'ENOTSUP', 'EPERM'] as const)(
      'parent dir fsync %s → PARENT_DIR_SYNC_UNSUPPORTED (categorization decision)',
      async (code) => {
        const realOpen = fsp.open
        vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
          const isDir = String(args[0]) === dataRoot
          const handle = await realOpen.apply(fsp, args)
          if (isDir) {
            handle.sync = async () => {
              throw errnoError(code)
            }
          }
          return handle
        })

        await expectStoreError(writeSnapshotReadyPromotionJournal(VALID, dataRoot), 'PARENT_DIR_SYNC_UNSUPPORTED')
        expect(realFs.existsSync(stagingPath)).toBe(false)
      }
    )

    it('parent dir open failure → PARENT_DIR_SYNC_FAILED', async () => {
      const realOpen = fsp.open
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        if (String(args[0]) === dataRoot) {
          throw errnoError('EIO')
        }
        return realOpen.apply(fsp, args)
      })

      await expectStoreError(writeSnapshotReadyPromotionJournal(VALID, dataRoot), 'PARENT_DIR_SYNC_FAILED')
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })

    it('cleanup failure never masks the primary error', async () => {
      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO'))
      vi.spyOn(fsp, 'unlink').mockRejectedValueOnce(errnoError('EACCES'))

      const second: PromotionJournalV1 = { ...VALID, sessionId: 'import-second-run' }
      await expectStoreError(writeSnapshotReadyPromotionJournal(second, dataRoot), 'PUBLISH_RENAME_FAILED')
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(VALID))
    })
  })

  // -------------------------------------------------------------------------
  // Read — strict three-state (LOCK-4414)
  // -------------------------------------------------------------------------

  describe('read three-state (LOCK-4414)', () => {
    it('absent ONLY when the fixed path does not exist (ENOENT)', async () => {
      expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'absent' })
    })

    it('invalid (never absent) for garbage bytes, empty files, and schema violations', async () => {
      realFs.writeFileSync(journalPath, 'not json {', 'utf8')
      expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'invalid', code: 'NOT_JSON' })

      realFs.writeFileSync(journalPath, '', 'utf8')
      expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'invalid', code: 'NOT_JSON' })

      realFs.writeFileSync(journalPath, JSON.stringify({ ...VALID, dbPath: '/tmp/evil' }), 'utf8')
      expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'invalid', code: 'UNEXPECTED_KEY' })

      realFs.writeFileSync(journalPath, JSON.stringify({ ...VALID, phase: 'promoted' }), 'utf8')
      expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'invalid', code: 'INVALID_PHASE' })
    })

    it('valid for every phase the codec accepts (store reads any phase; write gate is separate)', async () => {
      // The store must be able to READ candidate-installed/replacement-verified
      // journals written by later-phase owners — only WRITES are gated.
      for (const phase of ['snapshot-ready', 'candidate-installed', 'replacement-verified'] as const) {
        const doc: PromotionJournalV1 = { ...VALID, phase }
        realFs.writeFileSync(journalPath, encodePromotionJournal(doc), 'utf8')
        expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'valid', journal: doc })
      }
    })

    it('non-ENOENT read failure throws READ_IO_FAILED — never absent, never invalid', async () => {
      realFs.writeFileSync(journalPath, encodePromotionJournal(VALID), 'utf8')
      vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(errnoError('EACCES'))

      const error = await expectStoreError(readPromotionJournal(dataRoot), 'READ_IO_FAILED')
      expect((error.cause as NodeJS.ErrnoException).code).toBe('EACCES')
    })

    it('a directory squatting on the fixed path is an I/O failure, not absent', async () => {
      realFs.mkdirSync(journalPath)
      await expectStoreError(readPromotionJournal(dataRoot), 'READ_IO_FAILED')
    })
  })

  // -------------------------------------------------------------------------
  // Phase 4.4.2 — guarded phase transitions (LOCK-4423..LOCK-4425)
  // -------------------------------------------------------------------------

  describe('guarded phase transitions (LOCK-4423..4425)', () => {
    const INSTALLED: PromotionJournalV1 = { ...VALID, phase: 'candidate-installed' }
    const VERIFIED: PromotionJournalV1 = { ...VALID, phase: 'replacement-verified' }

    /** Publish a journal document directly (setup only — canonical bytes). */
    function seedJournal(doc: PromotionJournalV1): void {
      realFs.writeFileSync(journalPath, encodePromotionJournal(doc), 'utf8')
    }

    /** Assert the durable journal bytes and the absence of staging leftovers. */
    function expectDurableState(doc: PromotionJournalV1): void {
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(doc))
      expect(realFs.existsSync(stagingPath)).toBe(false)
    }

    /** Wrap fsp.open so a named FileHandle method rejects once (staging or dir). */
    function injectHandleFault(method: 'writeFile' | 'sync' | 'close', forDir: boolean): void {
      const realOpen = fsp.open
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const isDir = String(args[0]) === dataRoot
        const handle = await realOpen.apply(fsp, args)
        if (isDir === forDir) {
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

    // -- success ordering ----------------------------------------------------

    it('advances snapshot-ready → candidate-installed → replacement-verified with exact bytes', async () => {
      await writeSnapshotReadyPromotionJournal(VALID, dataRoot)
      expectDurableState(VALID)

      await advancePromotionJournalToCandidateInstalled(INSTALLED, dataRoot)
      expectDurableState(INSTALLED)
      expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'valid', journal: INSTALLED })

      await advancePromotionJournalToReplacementVerified(VERIFIED, dataRoot)
      expectDurableState(VERIFIED)
      expect(await readPromotionJournal(dataRoot)).toEqual({ status: 'valid', journal: VERIFIED })
    })

    it.each([
      ['candidate-installed', () => seedJournal(VALID), INSTALLED, advancePromotionJournalToCandidateInstalled],
      ['replacement-verified', () => seedJournal(INSTALLED), VERIFIED, advancePromotionJournalToReplacementVerified]
    ] as const)(
      'transition to %s runs guard-read → staging-open → write → file-sync → close → rename → dir-sync',
      async (_phase, seed, doc, api) => {
        seed()

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
          events.push(isDir ? 'dir-open' : `staging-open:${path.basename(target)}`)

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

        await api(doc, dataRoot)

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
        expectDurableState(doc)
      }
    )

    // -- API document gate (wrong phase handed to the API) ---------------------

    it.each([
      ['snapshot-ready', advancePromotionJournalToCandidateInstalled],
      ['replacement-verified', advancePromotionJournalToCandidateInstalled],
      ['snapshot-ready', advancePromotionJournalToReplacementVerified],
      ['candidate-installed', advancePromotionJournalToReplacementVerified]
    ] as const)(
      'a document with phase %s handed to the wrong transition API → PHASE_NOT_WRITABLE, no read/mutation',
      async (phase, api) => {
        seedJournal(VALID)
        const readSpy = vi.spyOn(fsp, 'readFile')
        const openSpy = vi.spyOn(fsp, 'open')

        const doc: PromotionJournalV1 = { ...VALID, phase }
        await expectStoreError(api(doc, dataRoot), 'PHASE_NOT_WRITABLE')

        expect(readSpy).not.toHaveBeenCalled()
        expect(openSpy).not.toHaveBeenCalled()
        expectDurableState(VALID)
      }
    )

    it('rejects empty data roots with DATA_ROOT_REJECTED before any effect', async () => {
      await expectStoreError(advancePromotionJournalToCandidateInstalled(INSTALLED, ''), 'DATA_ROOT_REJECTED')
      await expectStoreError(advancePromotionJournalToReplacementVerified(VERIFIED, ''), 'DATA_ROOT_REJECTED')
    })

    // -- guard rejection classes (all pre-mutation) ----------------------------

    it.each([
      ['candidate-installed', INSTALLED, advancePromotionJournalToCandidateInstalled],
      ['replacement-verified', VERIFIED, advancePromotionJournalToReplacementVerified]
    ] as const)('absent journal → TRANSITION_JOURNAL_ABSENT for %s; nothing created', async (_phase, doc, api) => {
      await expectStoreError(api(doc, dataRoot), 'TRANSITION_JOURNAL_ABSENT')
      expect(realFs.existsSync(journalPath)).toBe(false)
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })

    it.each([
      ['candidate-installed', INSTALLED, advancePromotionJournalToCandidateInstalled],
      ['replacement-verified', VERIFIED, advancePromotionJournalToReplacementVerified]
    ] as const)(
      'invalid journal → TRANSITION_JOURNAL_INVALID for %s; invalid bytes preserved (LOCK-4425)',
      async (_phase, doc, api) => {
        realFs.writeFileSync(journalPath, 'not json {', 'utf8')
        await expectStoreError(api(doc, dataRoot), 'TRANSITION_JOURNAL_INVALID')
        expect(realFs.readFileSync(journalPath, 'utf8')).toBe('not json {')
        expect(realFs.existsSync(stagingPath)).toBe(false)
      }
    )

    it.each([
      ['candidate-installed', INSTALLED, advancePromotionJournalToCandidateInstalled],
      ['replacement-verified', VERIFIED, advancePromotionJournalToReplacementVerified]
    ] as const)(
      'guard-read I/O failure → READ_IO_FAILED for %s (never absent); no mutation',
      async (_phase, doc, api) => {
        seedJournal(VALID)
        vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(errnoError('EACCES'))
        await expectStoreError(api(doc, dataRoot), 'READ_IO_FAILED')
        expectDurableState(VALID)
      }
    )

    it('phase skip snapshot-ready → replacement-verified → TRANSITION_PHASE_MISMATCH; journal preserved', async () => {
      seedJournal(VALID)
      await expectStoreError(
        advancePromotionJournalToReplacementVerified(VERIFIED, dataRoot),
        'TRANSITION_PHASE_MISMATCH'
      )
      expectDurableState(VALID)
    })

    it.each([
      ['candidate-installed', INSTALLED, advancePromotionJournalToCandidateInstalled],
      ['replacement-verified', VERIFIED, advancePromotionJournalToCandidateInstalled]
    ] as const)(
      'phase regression/repeat from %s to candidate-installed → TRANSITION_PHASE_MISMATCH; journal preserved',
      async (_priorPhase, prior, api) => {
        seedJournal(prior)
        await expectStoreError(api(INSTALLED, dataRoot), 'TRANSITION_PHASE_MISMATCH')
        expectDurableState(prior)
      }
    )

    it('repeat replacement-verified transition → TRANSITION_PHASE_MISMATCH; journal preserved', async () => {
      seedJournal(INSTALLED)
      await advancePromotionJournalToReplacementVerified(VERIFIED, dataRoot)
      await expectStoreError(
        advancePromotionJournalToReplacementVerified(VERIFIED, dataRoot),
        'TRANSITION_PHASE_MISMATCH'
      )
      expectDurableState(VERIFIED)
    })

    it.each([
      ['sessionId', { sessionId: 'import-other-session' }],
      ['candidateId', { candidateId: 'candidate-import-other' }]
    ] as const)(
      'cross-%s replacement → TRANSITION_IDENTITY_MISMATCH for both transitions; journal preserved',
      async (_field, overrides) => {
        seedJournal(VALID)
        await expectStoreError(
          advancePromotionJournalToCandidateInstalled({ ...INSTALLED, ...overrides }, dataRoot),
          'TRANSITION_IDENTITY_MISMATCH'
        )
        expectDurableState(VALID)

        seedJournal(INSTALLED)
        await expectStoreError(
          advancePromotionJournalToReplacementVerified({ ...VERIFIED, ...overrides }, dataRoot),
          'TRANSITION_IDENTITY_MISMATCH'
        )
        expectDurableState(INSTALLED)
      }
    )

    it('a rejected transition performs no staging or publish mutation (no fs.open/rename after guard)', async () => {
      seedJournal(VALID)
      const openSpy = vi.spyOn(fsp, 'open')
      const renameSpy = vi.spyOn(fsp, 'rename')

      await expectStoreError(
        advancePromotionJournalToReplacementVerified(VERIFIED, dataRoot),
        'TRANSITION_PHASE_MISMATCH'
      )
      await expectStoreError(
        advancePromotionJournalToCandidateInstalled({ ...INSTALLED, sessionId: 'import-other-session' }, dataRoot),
        'TRANSITION_IDENTITY_MISMATCH'
      )

      expect(openSpy).not.toHaveBeenCalled()
      expect(renameSpy).not.toHaveBeenCalled()
      expectDurableState(VALID)
    })

    // -- fault injection at every durability step for later phases -------------

    const transitionCases = [
      ['candidate-installed', VALID, INSTALLED, advancePromotionJournalToCandidateInstalled],
      ['replacement-verified', INSTALLED, VERIFIED, advancePromotionJournalToReplacementVerified]
    ] as const

    it.each(transitionCases)(
      '%s: staging write failure → STAGING_WRITE_FAILED; prior journal remains authoritative (LOCK-4425)',
      async (_phase, prior, doc, api) => {
        seedJournal(prior)
        injectHandleFault('writeFile', false)
        await expectStoreError(api(doc, dataRoot), 'STAGING_WRITE_FAILED')
        expectDurableState(prior)
      }
    )

    it.each(transitionCases)(
      '%s: staging fsync failure → STAGING_SYNC_FAILED; prior journal remains authoritative',
      async (_phase, prior, doc, api) => {
        seedJournal(prior)
        injectHandleFault('sync', false)
        await expectStoreError(api(doc, dataRoot), 'STAGING_SYNC_FAILED')
        expectDurableState(prior)
      }
    )

    it.each(transitionCases)(
      '%s: staging close failure → STAGING_CLOSE_FAILED; prior journal remains authoritative',
      async (_phase, prior, doc, api) => {
        seedJournal(prior)
        injectHandleFault('close', false)
        await expectStoreError(api(doc, dataRoot), 'STAGING_CLOSE_FAILED')
        expectDurableState(prior)
      }
    )

    it.each(transitionCases)(
      '%s: publish rename failure → PUBLISH_RENAME_FAILED; prior journal remains authoritative',
      async (_phase, prior, doc, api) => {
        seedJournal(prior)
        vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO'))
        await expectStoreError(api(doc, dataRoot), 'PUBLISH_RENAME_FAILED')
        expectDurableState(prior)
      }
    )

    it.each(transitionCases)(
      '%s: parent dir fsync failure → PARENT_DIR_SYNC_FAILED; new bytes published, durability unproven',
      async (_phase, _prior, doc, api) => {
        seedJournal(_prior)
        injectHandleFault('sync', true)
        await expectStoreError(api(doc, dataRoot), 'PARENT_DIR_SYNC_FAILED')
        // The rename already happened — the new phase is on disk, but the
        // caller was told the publish is not proven durable. No staging left.
        expectDurableState(doc)
      }
    )
  })
})

// -------------------------------------------------------------------------
// Phase 4.4.3 — Cleanup (LOCK-4435..LOCK-4438)
// -------------------------------------------------------------------------

describe('promotion journal cleanup (LOCK-4435..4438)', () => {
  let dataRoot: string
  let journalPath: string
  let stagingPath: string
  let retainedSnapshotPath: string

  const VALID_IDENTITY: PromotionJournalCleanupIdentity = {
    sessionId: VALID.sessionId,
    candidateId: VALID.candidateId
  }

  function seedJournal(doc: PromotionJournalV1): void {
    realFs.writeFileSync(journalPath, encodePromotionJournal(doc), 'utf8')
  }

  function expectJournalAbsent(): void {
    expect(realFs.existsSync(journalPath)).toBe(false)
  }

  function expectJournalPresent(doc: PromotionJournalV1): void {
    expect(realFs.existsSync(journalPath)).toBe(true)
    expect(realFs.readFileSync(journalPath, 'utf8')).toBe(encodePromotionJournal(doc))
  }

  function expectRetainedUntouched(): void {
    expect(realFs.existsSync(retainedSnapshotPath)).toBe(true)
  }

  beforeEach(() => {
    dataRoot = realFs.mkdtempSync(path.join(os.tmpdir(), 'cherry-journal-cleanup-test-'))
    journalPath = path.join(dataRoot, PROMOTION_JOURNAL_FILENAME)
    stagingPath = path.join(dataRoot, PROMOTION_JOURNAL_STAGING_FILENAME)
    retainedSnapshotPath = path.join(dataRoot, 'chat.db.pre-import-backup')
    // Seed a retained snapshot to verify it is never touched.
    realFs.writeFileSync(retainedSnapshotPath, 'retained-snapshot-sentinel')
  })

  afterEach(() => {
    try {
      realFs.rmSync(dataRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
    vi.restoreAllMocks()
  })

  // -- Success paths --------------------------------------------------------

  describe('replacement-verified cleanup', () => {
    it('removes a replacement-verified journal and syncs parent dir; snapshot retained', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'replacement-verified' }
      seedJournal(doc)

      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
      expectJournalAbsent()
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expectRetainedUntouched()
    })

    it('returns already-absent when no journal exists; idempotent', async () => {
      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: false, reason: 'already-absent' })
      expectJournalAbsent()
      expectRetainedUntouched()
    })
  })

  describe('snapshot-ready cleanup', () => {
    it('removes a snapshot-ready journal; snapshot retained', async () => {
      seedJournal(VALID)

      const result = await cleanupPromotionJournalAfterSnapshotReady(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
      expectJournalAbsent()
      expectRetainedUntouched()
    })

    it('returns already-absent when no journal exists', async () => {
      const result = await cleanupPromotionJournalAfterSnapshotReady(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: false, reason: 'already-absent' })
    })
  })

  // -- Staging cleanup behavior ---------------------------------------------

  describe('staging cleanup', () => {
    it('best-effort removes stale staging file without affecting success', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      realFs.writeFileSync(stagingPath, 'stale-staging')

      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
      expectJournalAbsent()
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })

    it('staging absence is not a failure', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      // No staging file exists.
      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
    })

    it('staging unlink failure does not mask the primary cleanup', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      realFs.writeFileSync(stagingPath, 'stale-staging')

      const realUnlink = fsp.unlink
      const unlinkSpy = vi.spyOn(fsp, 'unlink')
      let stagingUnlinkCallCount = 0
      unlinkSpy.mockImplementation(async (target: realFs.PathLike) => {
        if (String(target).endsWith(PROMOTION_JOURNAL_STAGING_FILENAME)) {
          stagingUnlinkCallCount++
          const err = new Error('injected staging unlink') as NodeJS.ErrnoException
          err.code = 'EIO'
          throw err
        }
        // Delegate other unlink calls (the journal) to the real implementation.
        return realUnlink.call(fsp, target)
      })

      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
      expectJournalAbsent()
      expect(stagingUnlinkCallCount).toBe(1)
      // Staging file still on disk (unlink failed), but cleanup succeeded.
      expect(realFs.existsSync(stagingPath)).toBe(true)
    })
  })

  // -- Guard rejections (all pre-mutation) -----------------------------------

  describe('guard rejections', () => {
    it('invalid journal → CLEANUP_JOURNAL_INVALID; invalid bytes preserved', async () => {
      realFs.writeFileSync(journalPath, 'not json {', 'utf8')
      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_JOURNAL_INVALID'
      )
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe('not json {')
      expectRetainedUntouched()
    })

    it('phase mismatch (snapshot-ready journal, replacement-verified cleanup) → CLEANUP_PHASE_MISMATCH', async () => {
      seedJournal(VALID) // snapshot-ready
      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )
      expectJournalPresent(VALID)
      expectRetainedUntouched()
    })

    it('phase mismatch (replacement-verified journal, snapshot-ready cleanup) → CLEANUP_PHASE_MISMATCH', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'replacement-verified' }
      seedJournal(doc)
      await expectStoreError(
        cleanupPromotionJournalAfterSnapshotReady(VALID_IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )
      expectJournalPresent(doc)
      expectRetainedUntouched()
    })

    it('identity mismatch (sessionId) → CLEANUP_IDENTITY_MISMATCH; journal preserved', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(
          { sessionId: 'import-other-session', candidateId: VALID.candidateId },
          dataRoot
        ),
        'CLEANUP_IDENTITY_MISMATCH'
      )
      expectJournalPresent({ ...VALID, phase: 'replacement-verified' })
      expectRetainedUntouched()
    })

    it('identity mismatch (candidateId) → CLEANUP_IDENTITY_MISMATCH; journal preserved', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(
          { sessionId: VALID.sessionId, candidateId: 'candidate-import-other' },
          dataRoot
        ),
        'CLEANUP_IDENTITY_MISMATCH'
      )
      expectJournalPresent({ ...VALID, phase: 'replacement-verified' })
      expectRetainedUntouched()
    })

    it('identity mismatch (both fields) → CLEANUP_IDENTITY_MISMATCH', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(
          { sessionId: 'import-other', candidateId: 'candidate-import-other' },
          dataRoot
        ),
        'CLEANUP_IDENTITY_MISMATCH'
      )
    })

    it('guard-read I/O failure → READ_IO_FAILED (propagated; never absent)', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(errnoError('EACCES'))
      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'READ_IO_FAILED'
      )
      expectJournalPresent({ ...VALID, phase: 'replacement-verified' })
      expectRetainedUntouched()
    })

    it('rejected guard performs no unlink or sync (no fs.open/rename after guard)', async () => {
      seedJournal(VALID) // snapshot-ready — wrong phase for replacement-verified cleanup
      const openSpy = vi.spyOn(fsp, 'open')
      const unlinkSpy = vi.spyOn(fsp, 'unlink')

      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )

      // Only the guard read touched fs; no unlink or dir-open for sync.
      expect(unlinkSpy).not.toHaveBeenCalled()
      expect(openSpy).not.toHaveBeenCalled()
      expectJournalPresent(VALID)
    })
  })

  // -- Exact path confinement ------------------------------------------------

  describe('exact path confinement', () => {
    it('cleanup only touches the fixed journal and staging paths; never the snapshot or candidate', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'replacement-verified' }
      seedJournal(doc)
      realFs.writeFileSync(stagingPath, 'stale-staging')

      // Create files that must NOT be touched.
      const snapshotPath = path.join(dataRoot, 'chat.db.pre-import-backup')
      const candidateDir = path.join(dataRoot, 'candidates', VALID.candidateId)
      const candidateDb = path.join(candidateDir, 'chat.db')
      realFs.mkdirSync(candidateDir, { recursive: true })
      realFs.writeFileSync(candidateDb, 'candidate-bytes')
      realFs.writeFileSync(snapshotPath, 'snapshot-bytes')

      await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)

      expectJournalAbsent()
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.readFileSync(snapshotPath, 'utf8')).toBe('snapshot-bytes')
      expect(realFs.readFileSync(candidateDb, 'utf8')).toBe('candidate-bytes')
    })

    it('cleanup never creates or modifies any file', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      const filesBefore = realFs.readdirSync(dataRoot).sort()

      await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)

      const filesAfter = realFs.readdirSync(dataRoot).sort()
      // Only the journal should be removed; nothing created.
      expect(filesAfter).toEqual(filesBefore.filter((f) => f !== PROMOTION_JOURNAL_FILENAME))
    })
  })

  // -- Unlink failure --------------------------------------------------------

  describe('unlink failure', () => {
    it('journal unlink EIO → CLEANUP_UNLINK_FAILED; journal preserved, no dir sync', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      const realUnlink = fsp.unlink
      const unlinkSpy = vi.spyOn(fsp, 'unlink')
      unlinkSpy.mockImplementation(async (target: realFs.PathLike) => {
        if (String(target).endsWith(PROMOTION_JOURNAL_FILENAME)) {
          throw errnoError('EIO')
        }
        return realUnlink.call(fsp, target)
      })

      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_UNLINK_FAILED'
      )
      expectJournalPresent({ ...VALID, phase: 'replacement-verified' })
      expectRetainedUntouched()
    })

    it('journal unlink EACCES → CLEANUP_UNLINK_FAILED with cause', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      const realUnlink = fsp.unlink
      const unlinkSpy = vi.spyOn(fsp, 'unlink')
      unlinkSpy.mockImplementation(async (target: realFs.PathLike) => {
        if (String(target).endsWith(PROMOTION_JOURNAL_FILENAME)) {
          throw errnoError('EACCES')
        }
        return realUnlink.call(fsp, target)
      })

      const error = await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_UNLINK_FAILED'
      )
      expect((error.cause as NodeJS.ErrnoException).code).toBe('EACCES')
    })

    it('journal unlink ENOENT after confirmed presence → proceeds to dir sync (concurrent removal)', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      const realUnlink = fsp.unlink
      const unlinkSpy = vi.spyOn(fsp, 'unlink')
      unlinkSpy.mockImplementation(async (target: realFs.PathLike) => {
        if (String(target).endsWith(PROMOTION_JOURNAL_FILENAME)) {
          // Simulate concurrent removal: guard read saw present, but unlink sees ENOENT.
          throw errnoError('ENOENT')
        }
        return realUnlink.call(fsp, target)
      })

      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      // ENOENT after guard confirmed presence is idempotent — goal achieved.
      expect(result).toEqual({ deleted: true })
      expectRetainedUntouched()
      // Note: the journal file may still exist on disk because the mock
      // prevented the real unlink. The important assertion is the return
      // value — the code path correctly treated ENOENT as idempotent.
    })
  })

  // -- Dir sync failure ------------------------------------------------------

  describe('dir sync failure', () => {
    it('parent dir fsync failure → CLEANUP_PARENT_DIR_SYNC_FAILED; journal already unlinked', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })

      const realOpen = fsp.open
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const isDir = String(args[0]) === dataRoot
        const handle = await realOpen.apply(fsp, args)
        if (isDir) {
          handle.sync = async () => {
            throw errnoError('EIO')
          }
        }
        return handle
      })

      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_PARENT_DIR_SYNC_FAILED'
      )
      // Journal was already unlinked before dir sync — unlink is not rolled back.
      expectJournalAbsent()
      expectRetainedUntouched()
    })

    it.each(['EINVAL', 'ENOTSUP', 'EPERM'] as const)(
      'parent dir fsync %s → CLEANUP_PARENT_DIR_SYNC_UNSUPPORTED',
      async (code) => {
        seedJournal({ ...VALID, phase: 'replacement-verified' })

        const realOpen = fsp.open
        vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
          const isDir = String(args[0]) === dataRoot
          const handle = await realOpen.apply(fsp, args)
          if (isDir) {
            handle.sync = async () => {
              throw errnoError(code)
            }
          }
          return handle
        })

        await expectStoreError(
          cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
          'CLEANUP_PARENT_DIR_SYNC_UNSUPPORTED'
        )
        expectJournalAbsent()
      }
    )

    it('parent dir open failure → CLEANUP_PARENT_DIR_SYNC_FAILED', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })

      const realOpen = fsp.open
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        if (String(args[0]) === dataRoot) {
          throw errnoError('EIO')
        }
        return realOpen.apply(fsp, args)
      })

      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_PARENT_DIR_SYNC_FAILED'
      )
      expectJournalAbsent()
    })
  })

  // -- Crash state: unlink-before-dir-sync -----------------------------------

  describe('crash state after unlink-before-dir-sync', () => {
    it('journal absent after failed dir sync → next cleanup call is idempotent (already-absent)', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })

      // First call: unlink succeeds, dir sync fails.
      const realOpen = fsp.open
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const isDir = String(args[0]) === dataRoot
        const handle = await realOpen.apply(fsp, args)
        if (isDir) {
          handle.sync = async () => {
            throw errnoError('EIO')
          }
        }
        return handle
      })

      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_PARENT_DIR_SYNC_FAILED'
      )
      // Journal is gone from disk (unlink happened before dir sync failure).
      expectJournalAbsent()

      // Second call: journal already absent → idempotent success.
      vi.restoreAllMocks()
      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: false, reason: 'already-absent' })
      expectJournalAbsent()
      expectRetainedUntouched()
    })
  })

  // -- Rollback-authorized cleanup contract -----------------------------------

  describe('rollback-authorized cleanup contract', () => {
    it('snapshot-ready cleanup accepts snapshot-ready phase with matching identity', async () => {
      seedJournal(VALID)
      const result = await cleanupPromotionJournalAfterSnapshotReady(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
      expectJournalAbsent()
      expectRetainedUntouched()
    })

    it('snapshot-ready cleanup rejects replacement-verified phase', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'replacement-verified' }
      seedJournal(doc)
      await expectStoreError(
        cleanupPromotionJournalAfterSnapshotReady(VALID_IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )
      expectJournalPresent(doc)
    })

    it('replacement-verified cleanup rejects candidate-installed phase', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'candidate-installed' }
      seedJournal(doc)
      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )
      expectJournalPresent(doc)
    })

    it('replacement-verified cleanup accepts replacement-verified phase', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'replacement-verified' }
      seedJournal(doc)
      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
    })

    it('both APIs are idempotent on already-absent journal', async () => {
      expect((await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)).deleted).toBe(false)
      expect((await cleanupPromotionJournalAfterSnapshotReady(VALID_IDENTITY, dataRoot)).deleted).toBe(false)
    })
  })

  // -- Data root rejection ---------------------------------------------------

  describe('data root rejection', () => {
    it('rejects empty data root with DATA_ROOT_REJECTED', async () => {
      await expectStoreError(cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, ''), 'DATA_ROOT_REJECTED')
      await expectStoreError(cleanupPromotionJournalAfterSnapshotReady(VALID_IDENTITY, ''), 'DATA_ROOT_REJECTED')
    })
  })

  // -- Durable ordering (unlink → dir-sync) -----------------------------------

  describe('durable cleanup ordering', () => {
    it('executes guard-read → unlink-journal → unlink-staging(best-effort) → dir-open → dir-sync → dir-close', async () => {
      seedJournal({ ...VALID, phase: 'replacement-verified' })
      realFs.writeFileSync(stagingPath, 'stale-staging')

      const events: string[] = []
      const realRead = fsp.readFile
      const realUnlink = fsp.unlink
      const realOpen = fsp.open

      vi.spyOn(fsp, 'readFile').mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
        events.push('guard-read')
        return realRead.apply(fsp, args)
      })
      vi.spyOn(fsp, 'unlink').mockImplementation(async (...args: Parameters<typeof fsp.unlink>) => {
        const target = String(args[0])
        if (target.endsWith(PROMOTION_JOURNAL_FILENAME)) {
          events.push('unlink-journal')
        } else if (target.endsWith(PROMOTION_JOURNAL_STAGING_FILENAME)) {
          events.push('unlink-staging')
        }
        return realUnlink.apply(fsp, args)
      })
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const target = String(args[0])
        const isDir = target === dataRoot
        const handle = await realOpen.apply(fsp, args)
        if (isDir) {
          events.push('dir-open')
          const realSync = handle.sync.bind(handle)
          handle.sync = async () => {
            events.push('dir-sync')
            return realSync()
          }
          const realClose = handle.close.bind(handle)
          handle.close = async () => {
            events.push('dir-close')
            return realClose()
          }
        }
        return handle
      })

      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })

      expect(events).toEqual(['guard-read', 'unlink-journal', 'unlink-staging', 'dir-open', 'dir-sync', 'dir-close'])
      expectJournalAbsent()
      expect(realFs.existsSync(stagingPath)).toBe(false)
    })

    it('absent journal: guard-read only, no unlink or dir-sync', async () => {
      const events: string[] = []
      const realRead = fsp.readFile
      vi.spyOn(fsp, 'readFile').mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
        events.push('guard-read')
        return realRead.apply(fsp, args)
      })
      const unlinkSpy = vi.spyOn(fsp, 'unlink')
      const openSpy = vi.spyOn(fsp, 'open')

      const result = await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: false, reason: 'already-absent' })

      expect(events).toEqual(['guard-read'])
      expect(unlinkSpy).not.toHaveBeenCalled()
      expect(openSpy).not.toHaveBeenCalled()
    })
  })

  // -- Snapshot byte retention -----------------------------------------------

  describe('snapshot byte retention', () => {
    it('retained snapshot bytes are identical before and after cleanup', async () => {
      const sentinel = Buffer.from('retained-snapshot-bytes-for-retention-check')
      realFs.writeFileSync(retainedSnapshotPath, sentinel)

      seedJournal({ ...VALID, phase: 'replacement-verified' })
      await cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot)

      expect(realFs.readFileSync(retainedSnapshotPath).equals(sentinel)).toBe(true)
    })

    it('retained snapshot is preserved even when cleanup fails (dir sync failure)', async () => {
      const sentinel = Buffer.from('retained-snapshot-survives-failure')
      realFs.writeFileSync(retainedSnapshotPath, sentinel)

      seedJournal({ ...VALID, phase: 'replacement-verified' })

      const realOpen = fsp.open
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        if (String(args[0]) === dataRoot) {
          const handle = await realOpen.apply(fsp, args)
          handle.sync = async () => {
            throw errnoError('EIO')
          }
          return handle
        }
        return realOpen.apply(fsp, args)
      })

      await expectStoreError(
        cleanupPromotionJournalAfterReplacementVerified(VALID_IDENTITY, dataRoot),
        'CLEANUP_PARENT_DIR_SYNC_FAILED'
      )
      expect(realFs.readFileSync(retainedSnapshotPath).equals(sentinel)).toBe(true)
    })
  })

  // -- candidate-installed cleanup (LOCK-4436) -----------------------------

  describe('candidate-installed cleanup (LOCK-4436)', () => {
    it('removes a candidate-installed journal and syncs parent dir; snapshot retained', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'candidate-installed' }
      seedJournal(doc)

      const result = await cleanupPromotionJournalAfterCandidateInstalled(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
      expectJournalAbsent()
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expectRetainedUntouched()
    })

    it('returns already-absent when no journal exists; idempotent', async () => {
      const result = await cleanupPromotionJournalAfterCandidateInstalled(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: false, reason: 'already-absent' })
      expectJournalAbsent()
      expectRetainedUntouched()
    })

    it('rejects snapshot-ready phase with CLEANUP_PHASE_MISMATCH', async () => {
      seedJournal(VALID) // snapshot-ready
      await expectStoreError(
        cleanupPromotionJournalAfterCandidateInstalled(VALID_IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )
      expectJournalPresent(VALID)
      expectRetainedUntouched()
    })

    it('rejects replacement-verified phase with CLEANUP_PHASE_MISMATCH', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'replacement-verified' }
      seedJournal(doc)
      await expectStoreError(
        cleanupPromotionJournalAfterCandidateInstalled(VALID_IDENTITY, dataRoot),
        'CLEANUP_PHASE_MISMATCH'
      )
      expectJournalPresent(doc)
      expectRetainedUntouched()
    })

    it('rejects identity mismatch (sessionId) with CLEANUP_IDENTITY_MISMATCH', async () => {
      seedJournal({ ...VALID, phase: 'candidate-installed' })
      await expectStoreError(
        cleanupPromotionJournalAfterCandidateInstalled(
          { sessionId: 'import-other-session', candidateId: VALID.candidateId },
          dataRoot
        ),
        'CLEANUP_IDENTITY_MISMATCH'
      )
      expectJournalPresent({ ...VALID, phase: 'candidate-installed' })
      expectRetainedUntouched()
    })

    it('rejects identity mismatch (candidateId) with CLEANUP_IDENTITY_MISMATCH', async () => {
      seedJournal({ ...VALID, phase: 'candidate-installed' })
      await expectStoreError(
        cleanupPromotionJournalAfterCandidateInstalled(
          { sessionId: VALID.sessionId, candidateId: 'candidate-import-other' },
          dataRoot
        ),
        'CLEANUP_IDENTITY_MISMATCH'
      )
      expectJournalPresent({ ...VALID, phase: 'candidate-installed' })
      expectRetainedUntouched()
    })

    it('accepts candidate-installed phase with matching identity', async () => {
      seedJournal({ ...VALID, phase: 'candidate-installed' })
      const result = await cleanupPromotionJournalAfterCandidateInstalled(VALID_IDENTITY, dataRoot)
      expect(result).toEqual({ deleted: true })
      expectJournalAbsent()
      expectRetainedUntouched()
    })

    it('candidate-installed cleanup only touches the fixed journal and staging paths', async () => {
      const doc: PromotionJournalV1 = { ...VALID, phase: 'candidate-installed' }
      seedJournal(doc)
      realFs.writeFileSync(stagingPath, 'stale-staging')

      // Create files that must NOT be touched.
      const snapshotPath = path.join(dataRoot, 'chat.db.pre-import-backup')
      const candidateDir = path.join(dataRoot, 'candidates', VALID.candidateId)
      const candidateDb = path.join(candidateDir, 'chat.db')
      realFs.mkdirSync(candidateDir, { recursive: true })
      realFs.writeFileSync(candidateDb, 'candidate-bytes')
      realFs.writeFileSync(snapshotPath, 'snapshot-bytes')

      await cleanupPromotionJournalAfterCandidateInstalled(VALID_IDENTITY, dataRoot)

      expectJournalAbsent()
      expect(realFs.existsSync(stagingPath)).toBe(false)
      expect(realFs.readFileSync(snapshotPath, 'utf8')).toBe('snapshot-bytes')
      expect(realFs.readFileSync(candidateDb, 'utf8')).toBe('candidate-bytes')
    })
  })
})
