/**
 * OrphanCleanupService — startup orphan cleanup with durable retry semantics.
 *
 * LOCK-003: Startup orphan cleanup retries count<=0 rows; physical failure
 *   leaves row for next startup and does not report success.
 * LOCK-004: Missing physical file remains successful cleanup (FileStorage
 *   returns void for !exists).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => {
  const fileStore = new Map<string, any>()

  return {
    mocks: {
      fileStore,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      apiDelete: vi.fn()
    }
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mocks.logger
  }
}))

vi.mock('@renderer/databases', () => {
  const db = {
    files: {
      get: vi.fn(async (id: string) => mocks.fileStore.get(id) ?? undefined),
      where: vi.fn(() => ({
        belowOrEqual: vi.fn(() => ({
          toArray: vi.fn(async () => {
            return Array.from(mocks.fileStore.values()).filter((f: any) => f.count <= 0)
          })
        }))
      })),
      delete: vi.fn(async (id: string) => {
        mocks.fileStore.delete(id)
      })
    }
  }
  return { default: db, db }
})

vi.stubGlobal('window', {
  api: {
    file: {
      delete: mocks.apiDelete
    }
  }
})

// --- Helpers --------------------------------------------------------------

function makeFile(overrides: Partial<any> = {}) {
  return {
    id: 'orphan-1',
    origin_name: 'orphan.txt',
    name: 'orphan-1.txt',
    path: '/mock/files/orphan-1.txt',
    size: 1024,
    ext: '.txt',
    type: 'text',
    created_at: '2025-01-01T00:00:00Z',
    count: 0,
    ...overrides
  }
}

// --- Tests ----------------------------------------------------------------

describe('cleanupOrphanFiles — LOCK-003/004', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.fileStore.clear()
  })

  it('no-ops when no orphan files exist', async () => {
    const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
    await cleanupOrphanFiles()

    expect(mocks.apiDelete).not.toHaveBeenCalled()
    expect(mocks.logger.info).not.toHaveBeenCalled()
  })

  it('physically deletes and removes Dexie row for each orphan (success)', async () => {
    const file1 = makeFile({ id: 'orphan-a', count: 0 })
    const file2 = makeFile({ id: 'orphan-b', count: -1 })
    mocks.fileStore.set(file1.id, file1)
    mocks.fileStore.set(file2.id, file2)
    mocks.apiDelete.mockResolvedValue(undefined)

    const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
    await cleanupOrphanFiles()

    // Both physically deleted
    expect(mocks.apiDelete).toHaveBeenCalledTimes(2)
    expect(mocks.apiDelete).toHaveBeenCalledWith('orphan-a.txt')
    expect(mocks.apiDelete).toHaveBeenCalledWith('orphan-b.txt')
    // Both Dexie rows removed
    expect(mocks.fileStore.has('orphan-a')).toBe(false)
    expect(mocks.fileStore.has('orphan-b')).toBe(false)
  })

  it('preserves row on physical failure and continues to next file (LOCK-003)', async () => {
    const file1 = makeFile({ id: 'fail-1', count: 0 })
    const file2 = makeFile({ id: 'ok-2', count: 0 })
    mocks.fileStore.set(file1.id, file1)
    mocks.fileStore.set(file2.id, file2)

    // First file fails, second succeeds
    mocks.apiDelete.mockRejectedValueOnce(new Error('EPERM: operation not permitted')).mockResolvedValueOnce(undefined)

    const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
    await cleanupOrphanFiles()

    // Both attempted
    expect(mocks.apiDelete).toHaveBeenCalledTimes(2)

    // Failed file's row preserved
    const failedRow = mocks.fileStore.get('fail-1')
    expect(failedRow).toBeDefined()
    expect(failedRow.count).toBe(0)

    // Successful file's row removed
    expect(mocks.fileStore.has('ok-2')).toBe(false)

    // Error logged
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Physical delete failed for fail-1'),
      expect.any(Error)
    )
  })

  it('preserves row on physical failure for all orphans (LOCK-003)', async () => {
    const file = makeFile({ id: 'all-fail', count: 0 })
    mocks.fileStore.set(file.id, file)
    mocks.apiDelete.mockRejectedValue(new Error('EBUSY'))

    const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
    await cleanupOrphanFiles()

    // Row preserved (OrphanCleanupService preserves original count)
    expect(mocks.fileStore.has('all-fail')).toBe(true)
    expect(mocks.fileStore.get('all-fail').count).toBe(0)
  })

  it('treats missing physical file as success — removes Dexie row (LOCK-004)', async () => {
    const file = makeFile({ id: 'missing-file', count: 0 })
    mocks.fileStore.set(file.id, file)
    // FileStorage.deleteFile returns void for !exists — no throw
    mocks.apiDelete.mockResolvedValue(undefined)

    const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
    await cleanupOrphanFiles()

    expect(mocks.apiDelete).toHaveBeenCalledWith('missing-file.txt')
    // Row removed (missing file = success)
    expect(mocks.fileStore.has('missing-file')).toBe(false)
  })

  it('partial success: removes successful rows, preserves failed rows', async () => {
    const files = [
      makeFile({ id: 'f1', count: 0 }),
      makeFile({ id: 'f2', count: -1 }),
      makeFile({ id: 'f3', count: 0 })
    ]
    files.forEach((f) => mocks.fileStore.set(f.id, f))

    // f1 succeeds, f2 fails, f3 succeeds
    mocks.apiDelete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockResolvedValueOnce(undefined)

    const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
    await cleanupOrphanFiles()

    expect(mocks.fileStore.has('f1')).toBe(false) // removed
    expect(mocks.fileStore.has('f2')).toBe(true) // preserved
    expect(mocks.fileStore.get('f2').count).toBe(-1) // OrphanCleanupService preserves original count; FileManager sets count=0
    expect(mocks.fileStore.has('f3')).toBe(false) // removed
  })

  it('reports cleaned count in info log', async () => {
    const file = makeFile({ id: 'ok', count: 0 })
    mocks.fileStore.set(file.id, file)
    mocks.apiDelete.mockResolvedValue(undefined)

    const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
    await cleanupOrphanFiles()

    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('Found 1 orphan files'))
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('Cleaned up 1/1 orphan files'))
  })

  it('reports partial success count in info log', async () => {
    const files = [makeFile({ id: 'ok1', count: 0 }), makeFile({ id: 'fail1', count: 0 })]
    files.forEach((f) => mocks.fileStore.set(f.id, f))

    mocks.apiDelete.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('EPERM'))

    const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
    await cleanupOrphanFiles()

    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('Cleaned up 1/2 orphan files'))
  })
})
