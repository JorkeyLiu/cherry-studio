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
import {
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
})
