import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    sqliteSourceConstructCount: 0,
    ensureTopic: vi.fn(),
    softDeleteTopic: vi.fn(),
    restoreTopic: vi.fn(),
    listTrashTopics: vi.fn(),
    hardDeleteTopic: vi.fn(),
    purgeExpiredTopics: vi.fn(),
    emptyTrashTopics: vi.fn(),
    deleteFile: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: mocks.loggerError,
      warn: mocks.loggerWarn,
      info: vi.fn()
    })
  }
}))

vi.mock('../SqliteMessageDataSource', () => ({
  SqliteMessageDataSource: class {
    constructor() {
      mocks.sqliteSourceConstructCount += 1
    }
    ensureTopic = mocks.ensureTopic
    softDeleteTopic = mocks.softDeleteTopic
    restoreTopic = mocks.restoreTopic
    listTrashTopics = mocks.listTrashTopics
    hardDeleteTopic = mocks.hardDeleteTopic
    purgeExpiredTopics = mocks.purgeExpiredTopics
    emptyTrashTopics = mocks.emptyTrashTopics
  }
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    deleteFile: mocks.deleteFile
  }
}))

import {
  buildPurgeCutoffTimestamp,
  compareTrashTopicsForDisplay,
  consumeFileCleanupResult,
  emptyOrdinaryTrash,
  ensureOrdinaryTopicOwnership,
  hardDeleteOrdinaryTopic,
  listOrdinaryTrashTopics,
  purgeExpiredOrdinaryTopics,
  restoreOrdinaryTopic,
  softDeleteOrdinaryTopic,
  topicWireToTopic,
  TRASH_RETENTION_DAYS
} from '../topicTrashLifecycle'

// --- Fixtures -------------------------------------------------------------

const wire = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  assistantId: 'a-1',
  name: `Topic ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  deletedAt: '2026-01-03T00:00:00.000Z',
  ...overrides
})

const page = (items: unknown[], nextCursor?: string) => ({
  items,
  ...(nextCursor !== undefined && { nextCursor }),
  hasMore: nextCursor !== undefined
})

// --- Tests ----------------------------------------------------------------

describe('topicTrashLifecycle (Phase 5.2B)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('module-load safety', () => {
    it('constructs the SQLite source lazily on first use, not at module evaluation', async () => {
      // This file statically imports the module above, so any eager
      // `new SqliteMessageDataSource()` at module evaluation would already
      // have run before this first test and incremented the counter.
      // Regression: the source must be constructed only on first use, which
      // breaks the store → assistants → AssistantService → topicTrashLifecycle
      // evaluation-time cycle.
      expect(mocks.sqliteSourceConstructCount).toBe(0)

      mocks.softDeleteTopic.mockResolvedValue(undefined)
      await softDeleteOrdinaryTopic('t-lazy', 'Named topic')

      // Constructed exactly once and reused (singleton-like).
      expect(mocks.sqliteSourceConstructCount).toBe(1)
      expect(mocks.softDeleteTopic).toHaveBeenCalledExactlyOnceWith('t-lazy', 'Named topic')
    })
  })

  describe('softDeleteOrdinaryTopic', () => {
    it('routes soft delete through SQLite only', async () => {
      mocks.softDeleteTopic.mockResolvedValue(undefined)

      await softDeleteOrdinaryTopic('t-1', 'Named topic')

      expect(mocks.softDeleteTopic).toHaveBeenCalledExactlyOnceWith('t-1', 'Named topic')
    })

    it('propagates SQLite failure with no fallback and no cleanup (LOCK-524)', async () => {
      const err = new Error('SQLITE_FAILURE')
      mocks.softDeleteTopic.mockRejectedValue(err)

      await expect(softDeleteOrdinaryTopic('t-1', 'Named topic')).rejects.toBe(err)
      // No fallback path: no other SQLite command, no file cleanup.
      expect(mocks.restoreTopic).not.toHaveBeenCalled()
      expect(mocks.hardDeleteTopic).not.toHaveBeenCalled()
      expect(mocks.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('restoreOrdinaryTopic', () => {
    it('is ONE atomic Main command returning the restored Topic without deletedAt (LOCK-532)', async () => {
      mocks.restoreTopic.mockResolvedValue(wire('t-2', { deletedAt: null }))

      const restored = await restoreOrdinaryTopic('t-2')

      expect(mocks.restoreTopic).toHaveBeenCalledExactlyOnceWith('t-2')
      // Never a list+restore sequence: no listing command is issued.
      expect(mocks.listTrashTopics).not.toHaveBeenCalled()
      expect(restored).toMatchObject({ id: 't-2', assistantId: 'a-1', name: 'Topic t-2' })
      expect(restored?.deletedAt).toBeUndefined()
    })

    it('returns undefined when Main restored no deleted row (stale UI cannot resurrect)', async () => {
      mocks.restoreTopic.mockResolvedValue(null)

      const restored = await restoreOrdinaryTopic('t-x')

      expect(mocks.restoreTopic).toHaveBeenCalledExactlyOnceWith('t-x')
      expect(restored).toBeUndefined()
    })

    it('propagates restore failure so callers skip Redux (LOCK-528)', async () => {
      const err = new Error('SQLITE_FAILURE')
      mocks.restoreTopic.mockRejectedValue(err)

      await expect(restoreOrdinaryTopic('t-1')).rejects.toBe(err)
    })
  })

  describe('ensureOrdinaryTopicOwnership (LOCK-533)', () => {
    it('creates the SQLite topic row with its assistantId', async () => {
      mocks.ensureTopic.mockResolvedValue(undefined)

      await ensureOrdinaryTopicOwnership('t-1', 'a-1', 'Named topic')

      expect(mocks.ensureTopic).toHaveBeenCalledExactlyOnceWith('t-1', 'a-1', 'Named topic')
    })

    it('propagates failure so callers do not expose the topic in Redux (LOCK-528)', async () => {
      const err = new Error('SQLITE_FAILURE')
      mocks.ensureTopic.mockRejectedValue(err)

      await expect(ensureOrdinaryTopicOwnership('t-1', 'a-1', 'Named topic')).rejects.toBe(err)
    })
  })

  describe('emptyOrdinaryTrash (LOCK-531)', () => {
    it('is ONE atomic Main command; consumes the single aggregate cleanup result', async () => {
      mocks.emptyTrashTopics.mockResolvedValue({
        affectedFileIds: ['f-0', 'f-1'],
        remainingReferenceCounts: { 'f-0': 0, 'f-1': 2 },
        deletedTopicIds: ['t-e1', 't-e2']
      })
      mocks.deleteFile.mockResolvedValue(undefined)

      await emptyOrdinaryTrash('a-1')

      expect(mocks.emptyTrashTopics).toHaveBeenCalledExactlyOnceWith('a-1')
      // Not implemented as list+loop.
      expect(mocks.listTrashTopics).not.toHaveBeenCalled()
      expect(mocks.hardDeleteTopic).not.toHaveBeenCalled()
      expect(mocks.purgeExpiredTopics).not.toHaveBeenCalled()
      // Aggregate cleanup: only zero-reference files are cleaned.
      expect(mocks.deleteFile).toHaveBeenCalledExactlyOnceWith('f-0')
    })

    it('performs NO cleanup when the transaction fails (LOCK-526)', async () => {
      const err = new Error('SQLITE_FAILURE')
      mocks.emptyTrashTopics.mockRejectedValue(err)

      await expect(emptyOrdinaryTrash('a-1')).rejects.toBe(err)
      expect(mocks.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('listOrdinaryTrashTopics', () => {
    it('drains all cursor pages sequentially and preserves SQLite order (LOCK-530)', async () => {
      mocks.listTrashTopics
        .mockResolvedValueOnce(page([wire('t-3'), wire('t-2')], 'c-1'))
        .mockResolvedValueOnce(page([wire('t-1')], 'c-2'))
        .mockResolvedValueOnce(page([wire('t-0')]))

      const topics = await listOrdinaryTrashTopics('a-1')

      expect(topics.map((t) => t.id)).toEqual(['t-3', 't-2', 't-1', 't-0'])
      expect(mocks.listTrashTopics).toHaveBeenCalledTimes(3)
      expect(mocks.listTrashTopics).toHaveBeenNthCalledWith(1, 'a-1', 100, undefined)
      expect(mocks.listTrashTopics).toHaveBeenNthCalledWith(2, 'a-1', 100, 'c-1')
      expect(mocks.listTrashTopics).toHaveBeenNthCalledWith(3, 'a-1', 100, 'c-2')
    })

    it('throws instead of exposing false completeness when hasMore has no cursor (LOCK-530)', async () => {
      mocks.listTrashTopics.mockResolvedValue({ items: [wire('t-1')], hasMore: true })

      await expect(listOrdinaryTrashTopics('a-1')).rejects.toThrow('more pages without a cursor')
    })

    it('propagates listing failure with no Dexie fallback (LOCK-524)', async () => {
      const err = new Error('SQLITE_FAILURE')
      mocks.listTrashTopics.mockRejectedValue(err)

      await expect(listOrdinaryTrashTopics('a-1')).rejects.toBe(err)
    })
  })

  describe('consumeFileCleanupResult', () => {
    it('cleans up only files with remaining count === 0 (LOCK-525)', async () => {
      mocks.deleteFile.mockResolvedValue(undefined)

      await consumeFileCleanupResult({
        affectedFileIds: ['f-0', 'f-1', 'f-2'],
        remainingReferenceCounts: { 'f-0': 0, 'f-1': 2, 'f-2': 0 }
      })

      expect(mocks.deleteFile).toHaveBeenCalledTimes(2)
      expect(mocks.deleteFile).toHaveBeenCalledWith('f-0')
      expect(mocks.deleteFile).toHaveBeenCalledWith('f-2')
      expect(mocks.deleteFile).not.toHaveBeenCalledWith('f-1')
    })

    it('never force-deletes: FileManager keeps its non-chat consumer policy', async () => {
      mocks.deleteFile.mockResolvedValue(undefined)

      await consumeFileCleanupResult({
        affectedFileIds: ['f-0'],
        remainingReferenceCounts: { 'f-0': 0 }
      })

      // No `force` flag: existing FileManager semantics decide the outcome.
      expect(mocks.deleteFile).toHaveBeenCalledExactlyOnceWith('f-0')
    })

    it('skips and warns on missing remaining count instead of guessing', async () => {
      await consumeFileCleanupResult({
        affectedFileIds: ['f-missing'],
        remainingReferenceCounts: {}
      })

      expect(mocks.deleteFile).not.toHaveBeenCalled()
      expect(mocks.loggerWarn).toHaveBeenCalledTimes(1)
    })

    it('treats cleanup failure as post-commit state: logged, never thrown (LOCK-527)', async () => {
      mocks.deleteFile.mockRejectedValueOnce(new Error('EPERM')).mockResolvedValueOnce(undefined)

      await expect(
        consumeFileCleanupResult({
          affectedFileIds: ['f-0', 'f-1'],
          remainingReferenceCounts: { 'f-0': 0, 'f-1': 0 }
        })
      ).resolves.toBeUndefined()

      // Every affectedFileId is still consumed after the failure.
      expect(mocks.deleteFile).toHaveBeenCalledTimes(2)
      expect(mocks.loggerError).toHaveBeenCalledTimes(1)
    })
  })

  describe('hardDeleteOrdinaryTopic', () => {
    it('awaits the committed SQLite mutation, then consumes cleanup (LOCK-525)', async () => {
      const order: string[] = []
      mocks.hardDeleteTopic.mockImplementation(async () => {
        order.push('sqlite')
        return { affectedFileIds: ['f-0'], remainingReferenceCounts: { 'f-0': 0 }, deletedTopicIds: ['t-1'] }
      })
      mocks.deleteFile.mockImplementation(async () => {
        order.push('cleanup')
      })

      await hardDeleteOrdinaryTopic('t-1')

      expect(mocks.hardDeleteTopic).toHaveBeenCalledExactlyOnceWith('t-1')
      expect(order).toEqual(['sqlite', 'cleanup'])
    })

    it('does not clean up when remaining count > 0', async () => {
      mocks.hardDeleteTopic.mockResolvedValue({
        affectedFileIds: ['f-0'],
        remainingReferenceCounts: { 'f-0': 3 },
        deletedTopicIds: ['t-1']
      })

      await hardDeleteOrdinaryTopic('t-1')

      expect(mocks.deleteFile).not.toHaveBeenCalled()
    })

    it('performs NO cleanup when the SQLite mutation fails (LOCK-526)', async () => {
      const err = new Error('SQLITE_FAILURE')
      mocks.hardDeleteTopic.mockRejectedValue(err)

      await expect(hardDeleteOrdinaryTopic('t-1')).rejects.toBe(err)
      expect(mocks.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('purgeExpiredOrdinaryTopics', () => {
    it('sends a renderer-generated strict ISO cutoff (LOCK-523) and consumes cleanup', async () => {
      const now = new Date('2026-07-28T12:00:00.000Z')
      mocks.purgeExpiredTopics.mockResolvedValue({
        affectedFileIds: ['f-0'],
        remainingReferenceCounts: { 'f-0': 0 },
        deletedTopicIds: ['t-purge-1', 't-purge-2']
      })
      mocks.deleteFile.mockResolvedValue(undefined)

      await purgeExpiredOrdinaryTopics(now)

      expect(mocks.purgeExpiredTopics).toHaveBeenCalledExactlyOnceWith('2026-07-23T12:00:00.000Z')
      expect(mocks.deleteFile).toHaveBeenCalledExactlyOnceWith('f-0')
    })

    it('performs NO cleanup when the purge mutation fails (LOCK-526)', async () => {
      const err = new Error('SQLITE_FAILURE')
      mocks.purgeExpiredTopics.mockRejectedValue(err)

      await expect(purgeExpiredOrdinaryTopics()).rejects.toBe(err)
      expect(mocks.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('buildPurgeCutoffTimestamp', () => {
    it('subtracts the retention window and formats strict ISO', () => {
      const now = new Date('2026-07-28T00:00:00.000Z')
      const cutoff = buildPurgeCutoffTimestamp(now)
      expect(cutoff).toBe('2026-07-23T00:00:00.000Z')
      expect(TRASH_RETENTION_DAYS).toBe(5)
      // Strict ISO 8601 with milliseconds and Z.
      expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })
  })

  describe('compareTrashTopicsForDisplay', () => {
    it('orders deletedAt DESC with id DESC tie-break (LOCK-523)', () => {
      const topics = [
        topicWireToTopic(wire('t-1', { deletedAt: '2026-01-02T00:00:00.000Z' })),
        topicWireToTopic(wire('t-3', { deletedAt: '2026-01-03T00:00:00.000Z' })),
        topicWireToTopic(wire('t-2', { deletedAt: '2026-01-03T00:00:00.000Z' })),
        topicWireToTopic(wire('t-0', { deletedAt: '2026-01-04T00:00:00.000Z' }))
      ]

      const sorted = [...topics].sort(compareTrashTopicsForDisplay)

      expect(sorted.map((t) => t.id)).toEqual(['t-0', 't-3', 't-2', 't-1'])
    })

    it('sorts topics without deletedAt last', () => {
      const withDate = topicWireToTopic(wire('t-1'))
      const withoutDate = topicWireToTopic(wire('t-2', { deletedAt: null }))

      expect([withoutDate, withDate].sort(compareTrashTopicsForDisplay).map((t) => t.id)).toEqual(['t-1', 't-2'])
    })
  })

  describe('topicWireToTopic', () => {
    it('maps wire fields to the renderer Topic shape without inventing fields', () => {
      const topic = topicWireToTopic({
        id: 't-1',
        assistantId: 'a-1',
        name: 'Name',
        pinned: true,
        prompt: 'p',
        isNameManuallyEdited: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: '2026-01-03T00:00:00.000Z'
      })

      expect(topic).toEqual({
        id: 't-1',
        assistantId: 'a-1',
        name: 'Name',
        pinned: true,
        prompt: 'p',
        isNameManuallyEdited: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: '2026-01-03T00:00:00.000Z',
        messages: []
      })
    })

    it('omits optional fields that are null/absent on the wire', () => {
      const topic = topicWireToTopic({ id: 't-1', assistantId: null, name: null })

      expect(topic).toEqual({
        id: 't-1',
        assistantId: '',
        name: '',
        createdAt: '',
        updatedAt: '',
        messages: []
      })
      expect('pinned' in topic).toBe(false)
      expect('deletedAt' in topic).toBe(false)
    })
  })
})
