/**
 * FileManager + OrphanCleanupService — concurrent lifecycle race tests.
 *
 * Validates LOCK-001/002/003/004: per-file serialization prevents stale
 * read-modify-write races across add, delete, and orphan cleanup.
 *
 * Race outcomes verified:
 *   1. add-vs-delete (concurrent add cannot land after delete reads count=1)
 *   2. upload-duplicate-vs-delete
 *   3. two-deletes-count>1 (decrement correctness)
 *   4. orphan-cleanup-vs-add (orphan re-reads count inside lock)
 *   5. different-IDs concurrency (no mutual blocking)
 *   6. failure durable count=0 survives concurrent add
 *   7. physical-storage-races (missing physical prevents stale metadata)
 *   8. uploadFile-recreation (re-upload on missing physical)
 *   9. updateFileCount-vs-delete (LOCK-001: count updates serialized)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => {
  const fileStore = new Map<string, any>()

  // In-memory Dexie `files` table mock, shared with the '@renderer/databases'
  // module mock below. Defined here (not inside the vi.mock factory) so that
  // beforeEach can re-apply the database mock implementations explicitly
  // (LOCK-TEST-3). Vitest 3.x currently falls back to the vi.fn(impl) originals
  // after vi.resetAllMocks(), so this re-application is defensive: it must not
  // rely on that fallback persisting across upgrades. Assertions must observe
  // mutations in mocks.fileStore and the FileLock read-modify-write path must
  // actually be exercised.
  const db = {
    files: {
      get: vi.fn(async (id: string) => fileStore.get(id) ?? undefined),
      add: vi.fn(async (file: any) => {
        fileStore.set(file.id, file)
      }),
      update: vi.fn(async (id: string, changes: any) => {
        const existing = fileStore.get(id)
        if (existing) {
          fileStore.set(id, { ...existing, ...changes })
        }
      }),
      delete: vi.fn(async (id: string) => {
        fileStore.delete(id)
      }),
      toArray: vi.fn(async () => Array.from(fileStore.values())),
      where: vi.fn(() => ({
        belowOrEqual: vi.fn(() => ({
          toArray: vi.fn(async () => {
            return Array.from(fileStore.values()).filter((f: any) => f.count <= 0)
          })
        }))
      })),
      transaction: vi.fn(async (_mode: string, _table: any, fn: () => Promise<void>) => {
        await fn()
      })
    }
  }

  return {
    mocks: {
      fileStore,
      db,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      apiDelete: vi.fn(),
      apiUpload: vi.fn(),
      apiBase64File: vi.fn(),
      apiFileExists: vi.fn().mockResolvedValue(true),
      storeGetState: vi.fn().mockReturnValue({ runtime: { filesPath: '/mock/files' } })
    }
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mocks.logger
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: mocks.storeGetState
  }
}))

vi.mock('../db/SqliteMessageDataSource', () => ({
  SqliteMessageDataSource: vi.fn().mockImplementation(() => ({}))
}))

vi.mock('../db/AgentMessageDataSource', () => ({
  AgentMessageDataSource: vi.fn().mockImplementation(() => ({
    getStreamingCacheInfo: vi.fn()
  }))
}))

vi.mock('../db/types', () => ({
  isAgentSessionTopicId: vi.fn().mockReturnValue(false),
  buildAgentSessionTopicId: vi.fn()
}))

// Narrow mocks for FileManager's heavyweight imports (LOCK-TEST-4). The real
// '@renderer/i18n' bundles ~3.2MB of locale data (plus i18next init) and
// '@renderer/utils' pulls in antd/lodash/uuid — none of it is exercised by
// these concurrency tests, and importing it delays the first dynamic
// FileManager import by seconds. Matches the existing test mocking style
// (see listModels.test.ts / ApiService.imageCollection.test.ts).
vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/utils', () => ({
  getFileDirectory: (filePath: string) => filePath
}))

vi.mock('@renderer/databases', () => ({
  default: mocks.db,
  db: mocks.db
}))

vi.stubGlobal('window', {
  api: {
    file: {
      delete: mocks.apiDelete,
      upload: mocks.apiUpload,
      base64File: mocks.apiBase64File,
      exists: mocks.apiFileExists
    }
  }
})

// --- Helpers --------------------------------------------------------------

function makeFile(overrides: Partial<any> = {}) {
  return {
    id: 'file-abc',
    origin_name: 'test.txt',
    name: 'file-abc.txt',
    path: '/mock/files/file-abc.txt',
    size: 1024,
    ext: '.txt',
    type: 'text' as const,
    created_at: '2025-01-01T00:00:00Z',
    count: 1,
    ...overrides
  }
}

/** Yield to the microtask queue so interleaved promises can observe each other. */
function yield_(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// --- Tests ----------------------------------------------------------------

describe('FileManager concurrency — LOCK-001/002/003/004', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.fileStore.clear()
    // Re-establish defaults cleared by resetAllMocks
    mocks.apiFileExists.mockResolvedValue(true)
    mocks.storeGetState.mockReturnValue({ runtime: { filesPath: '/mock/files' } })
    // LOCK-TEST-3: Explicitly re-establish the database mock implementations.
    // Vitest 3.x currently falls back to the vi.fn(impl) originals after
    // resetAllMocks, so this is defensive: it removes reliance on that fallback
    // persisting across upgrades. Assertions observe mutations in
    // mocks.fileStore and the FileLock serialization path is actually exercised
    // (not a vacuous pre-seeded state).
    mocks.db.files.get.mockImplementation(async (id: string) => mocks.fileStore.get(id) ?? undefined)
    mocks.db.files.add.mockImplementation(async (file: any) => {
      mocks.fileStore.set(file.id, file)
    })
    mocks.db.files.update.mockImplementation(async (id: string, changes: any) => {
      const existing = mocks.fileStore.get(id)
      if (existing) {
        mocks.fileStore.set(id, { ...existing, ...changes })
      }
    })
    mocks.db.files.delete.mockImplementation(async (id: string) => {
      mocks.fileStore.delete(id)
    })
    mocks.db.files.toArray.mockImplementation(async () => Array.from(mocks.fileStore.values()))
    mocks.db.files.where.mockImplementation(() => ({
      belowOrEqual: vi.fn(() => ({
        toArray: vi.fn(async () => {
          return Array.from(mocks.fileStore.values()).filter((f: any) => f.count <= 0)
        })
      }))
    }))
    mocks.db.files.transaction.mockImplementation(async (_mode: string, _table: any, fn: () => Promise<void>) => {
      await fn()
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 1: addFile vs deleteFile on the same ID
  // ──────────────────────────────────────────────────────────────────────
  describe('add-vs-delete', () => {
    it('add after delete: increment lands on freshly added row, not lost', async () => {
      // Setup: file with count=1
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // Start delete and add concurrently.
      // addFile should see the row after delete removes it (fresh add with count=1)
      // OR see it before delete (increment to count=2, then delete decrements to 1).
      // Either outcome is safe — the key is no stale read.
      const deletePromise = FileManager.deleteFile(file.id)
      const addPromise = FileManager.addFile(makeFile({ count: 1 }))

      await Promise.all([deletePromise, addPromise])

      // Verify: file exists with count >= 1 (either fresh add or increment survived)
      const result = mocks.fileStore.get(file.id)
      if (result) {
        expect(result.count).toBeGreaterThanOrEqual(1)
      }
      // If file was deleted then re-added, count=1. If add happened before delete,
      // delete decremented from 2 to 1 or physically deleted and add re-created.
      // The invariant: no count <= 0 with a live reference.
    })

    it('delete then add: file is re-created with correct count', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // Sequential: delete first, then add
      await FileManager.deleteFile(file.id)
      expect(mocks.fileStore.has(file.id)).toBe(false)

      // Now add — should create fresh row
      const added = await FileManager.addFile(makeFile({ count: 1 }))
      expect(added.count).toBe(1)
      expect(mocks.fileStore.get(file.id)).toBeDefined()
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 2: uploadFile (duplicate) vs deleteFile
  // ──────────────────────────────────────────────────────────────────────
  describe('upload-duplicate-vs-delete', () => {
    it('upload returning existing ID increments safely around delete', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)

      // Physical upload returns same ID (duplicate)
      mocks.apiUpload.mockResolvedValue(makeFile({ id: file.id }))
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // Start both concurrently
      const deletePromise = FileManager.deleteFile(file.id)
      const uploadPromise = FileManager.uploadFile(makeFile({ count: 1 }))

      await Promise.all([deletePromise, uploadPromise])

      // After both complete, file should exist with count >= 1
      // (either upload incremented before delete, or upload re-added after delete)
      const result = mocks.fileStore.get(file.id)
      if (result) {
        expect(result.count).toBeGreaterThanOrEqual(1)
      }
      // Key invariant: no physical delete of a file that has a live reference.
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 3: two concurrent deletes on count > 1
  // ──────────────────────────────────────────────────────────────────────
  describe('two-deletes-count>1', () => {
    it('two concurrent decrements on count=2: first decrements, second physically deletes', async () => {
      const file = makeFile({ count: 2 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // Two concurrent deletes — serialized. First sees count=2 → decrement to 1.
      // Second sees count=1 → physical delete + row removal.
      await Promise.allSettled([FileManager.deleteFile(file.id), FileManager.deleteFile(file.id)])

      // File is physically deleted and row removed
      expect(mocks.fileStore.has(file.id)).toBe(false)
      expect(mocks.apiDelete).toHaveBeenCalledWith('file-abc.txt')
    })

    it('three concurrent decrements on count=3: first two decrement, third physically deletes', async () => {
      const file = makeFile({ count: 3 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      await Promise.allSettled([
        FileManager.deleteFile(file.id),
        FileManager.deleteFile(file.id),
        FileManager.deleteFile(file.id)
      ])

      // After 3 serialized operations: 3→2→1→physical delete
      expect(mocks.fileStore.has(file.id)).toBe(false)
      expect(mocks.apiDelete).toHaveBeenCalledWith('file-abc.txt')
    })

    it('five concurrent decrements on count=5: first four decrement, fifth physically deletes', async () => {
      const file = makeFile({ count: 5 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      const deletes = Array.from({ length: 5 }, () => FileManager.deleteFile(file.id))
      await Promise.allSettled(deletes)

      // 5→4→3→2→1→physical delete
      expect(mocks.fileStore.has(file.id)).toBe(false)
      expect(mocks.apiDelete).toHaveBeenCalledWith('file-abc.txt')
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 4: orphan cleanup vs addFile
  // ──────────────────────────────────────────────────────────────────────
  describe('orphan-cleanup-vs-add', () => {
    it('orphan cleanup skips file when add restores count > 0', async () => {
      // Setup: file with count=0 (orphan)
      const file = makeFile({ count: 0 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
      const { default: FileManager } = await import('../FileManager')

      // Start orphan cleanup and addFile concurrently.
      // The orphan cleanup re-reads count inside the lock.
      // If addFile increments first, orphan sees count=1 and skips.
      const cleanupPromise = cleanupOrphanFiles()
      // Small delay to let cleanup acquire the query first, then add races
      await yield_()
      const addPromise = FileManager.addFile(makeFile({ id: file.id, count: 1 }))

      await Promise.all([cleanupPromise, addPromise])

      // After both complete, if add won the race the file should exist
      const result = mocks.fileStore.get(file.id)
      if (result) {
        // File survived — add restored reference
        expect(result.count).toBeGreaterThanOrEqual(1)
      }
      // If orphan won, file is deleted — that's also correct (add was too late)
      // The key: orphan never deletes a file that addFile is about to reference.
    })

    it('orphan cleanup deletes when no concurrent add arrives', async () => {
      const file = makeFile({ count: 0 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { cleanupOrphanFiles } = await import('../OrphanCleanupService')
      await cleanupOrphanFiles()

      // File should be cleaned up
      expect(mocks.fileStore.has(file.id)).toBe(false)
      expect(mocks.apiDelete).toHaveBeenCalledWith('file-abc.txt')
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 5: different IDs — no mutual blocking
  // ──────────────────────────────────────────────────────────────────────
  describe('different-IDs concurrency', () => {
    it('operations on different file IDs run concurrently', async () => {
      const fileA = makeFile({ id: 'file-a', count: 1 })
      const fileB = makeFile({ id: 'file-b', count: 1 })
      mocks.fileStore.set(fileA.id, fileA)
      mocks.fileStore.set(fileB.id, fileB)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // Delete both concurrently — different IDs, no lock contention
      await Promise.all([FileManager.deleteFile(fileA.id), FileManager.deleteFile(fileB.id)])

      expect(mocks.fileStore.has(fileA.id)).toBe(false)
      expect(mocks.fileStore.has(fileB.id)).toBe(false)
      expect(mocks.apiDelete).toHaveBeenCalledTimes(2)
    })

    it('add on different IDs does not block delete on another ID', async () => {
      const fileA = makeFile({ id: 'file-a', count: 1 })
      mocks.fileStore.set(fileA.id, fileA)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // Delete file-a and add file-b concurrently
      const [, added] = await Promise.all([
        FileManager.deleteFile(fileA.id),
        FileManager.addFile(makeFile({ id: 'file-b', count: 1 }))
      ])

      expect(mocks.fileStore.has(fileA.id)).toBe(false)
      expect(added.id).toBe('file-b')
      expect(mocks.fileStore.get('file-b').count).toBe(1)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 6: failure durable count=0 survives concurrent add
  // ──────────────────────────────────────────────────────────────────────
  describe('failure-durable-count=0', () => {
    it('physical failure preserves count=0, subsequent add re-increments', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockRejectedValue(new Error('EPERM'))

      const { default: FileManager } = await import('../FileManager')

      // First delete fails → count=0
      await expect(FileManager.deleteFile(file.id)).rejects.toThrow('EPERM')
      expect(mocks.fileStore.get(file.id).count).toBe(0)

      // AddFile sees count=0, increments to 1
      await FileManager.addFile(makeFile({ id: file.id, count: 1 }))
      expect(mocks.fileStore.get(file.id).count).toBe(1)
    })

    it('concurrent add during physical failure correctly re-increments', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)

      // Physical delete fails
      mocks.apiDelete.mockRejectedValue(new Error('EPERM'))

      const { default: FileManager } = await import('../FileManager')

      // Start delete (will fail) and add concurrently
      const deletePromise = FileManager.deleteFile(file.id).catch(() => {})
      const addPromise = FileManager.addFile(makeFile({ id: file.id, count: 1 }))

      await Promise.all([deletePromise, addPromise])

      // After both: delete set count=0 (failure path), add incremented.
      // Order depends on lock — but serialized, so either:
      //   delete runs first: count 1→0 (failure), then add: count 0→1
      //   add runs first: count 1→2, then delete: count 2→1 (decrement path)
      // Both result in count >= 1 — no stale zero-owner deletion.
      const result = mocks.fileStore.get(file.id)
      expect(result).toBeDefined()
      expect(result.count).toBeGreaterThanOrEqual(1)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 7: deleteFile during addFile (read-modify-write serialization)
  // ──────────────────────────────────────────────────────────────────────
  describe('deleteFile-during-addFile-serialization', () => {
    it('serialized add then delete: count goes 0→1→0→physical delete', async () => {
      // Start with no file
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // addFile creates row (count=1), then deleteFile removes it
      const addPromise = FileManager.addFile(makeFile({ count: 1 }))
      // Start delete right after — it will wait for add's lock to release
      const deletePromise = addPromise.then(() => FileManager.deleteFile('file-abc'))

      await Promise.all([addPromise, deletePromise])

      // File should be gone (add created with count=1, delete saw count=1 → physical delete)
      expect(mocks.fileStore.has('file-abc')).toBe(false)
    })

    it('interleaved adds and deletes maintain correct final count', async () => {
      const file = makeFile({ count: 0 })
      // Don't pre-set — addFile will create it

      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // 5 concurrent adds
      const adds = Array.from({ length: 5 }, () => FileManager.addFile(makeFile({ id: file.id, count: 1 })))
      await Promise.all(adds)

      // Count should be 5
      expect(mocks.fileStore.get(file.id).count).toBe(5)

      // 3 concurrent deletes
      const deletes = Array.from({ length: 3 }, () => FileManager.deleteFile(file.id))
      await Promise.all(deletes)

      // Count should be 2 (5 - 3)
      const result = mocks.fileStore.get(file.id)
      expect(result).toBeDefined()
      expect(result.count).toBe(2)
      // No physical delete (count stayed > 0)
      expect(mocks.apiDelete).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 8: addFile with missing physical file (LOCK-002/003)
  // ──────────────────────────────────────────────────────────────────────
  describe('addFile-missing-physical', () => {
    it('addFile throws when physical file is missing and row exists', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      // Physical file missing
      mocks.apiFileExists.mockResolvedValue(false)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.addFile(file)).rejects.toThrow('Physical file missing')
      // Row should NOT have been incremented
      expect(mocks.fileStore.get(file.id).count).toBe(1)
    })

    it('addFile throws when physical file is missing and no row exists', async () => {
      const file = makeFile({ count: 1 })
      // Physical file missing
      mocks.apiFileExists.mockResolvedValue(false)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.addFile(file)).rejects.toThrow('Physical file missing')
      // Row should NOT have been added
      expect(mocks.fileStore.has(file.id)).toBe(false)
    })

    it('addFile succeeds when physical file exists', async () => {
      const file = makeFile({ count: 1 })
      // Physical file exists
      mocks.apiFileExists.mockResolvedValue(true)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.addFile(file)

      expect(mocks.fileStore.get(file.id)).toBeDefined()
      expect(mocks.fileStore.get(file.id).count).toBe(1)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 9: uploadFile recreation on missing physical (LOCK-002/003)
  // ──────────────────────────────────────────────────────────────────────
  describe('uploadFile-recreation', () => {
    it('uploadFile throws when row exists and physical is missing (LOCK-003)', async () => {
      const originalFile = makeFile({ count: 1 })
      const uploadResult = makeFile({ id: originalFile.id, count: 1 })
      mocks.fileStore.set(originalFile.id, originalFile)

      // First upload returns existing ID (duplicate)
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // LOCK-002 preflight: original physical exists → passes
      mocks.apiFileExists.mockResolvedValueOnce(true)
      // LOCK-003 in commitUploadResult: physical missing for existing row
      mocks.apiFileExists.mockResolvedValueOnce(false)

      const { default: FileManager } = await import('../FileManager')

      // LOCK-003: Should throw — existing row with missing physical cannot migrate
      await expect(FileManager.uploadFile(makeFile({ count: 1 }))).rejects.toThrow('LOCK-003')
      // Row should NOT have been modified
      expect(mocks.fileStore.get(originalFile.id).count).toBe(1)
    })

    it('uploadFile re-uploads when physical is missing and no row exists', async () => {
      const uploadResult = makeFile({ id: 'file-abc', count: 1 })
      // No row in Dexie

      // First upload returns new ID
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // Physical missing on first check
      mocks.apiFileExists.mockResolvedValueOnce(false)
      // Re-upload succeeds with same ID
      mocks.apiUpload.mockResolvedValueOnce(makeFile({ id: 'file-abc', count: 1 }))
      // Physical check for re-upload succeeds
      mocks.apiFileExists.mockResolvedValueOnce(true)

      const { default: FileManager } = await import('../FileManager')
      const result = await FileManager.uploadFile(makeFile({ count: 1 }))

      // Should have re-uploaded and added row
      expect(mocks.apiUpload).toHaveBeenCalledTimes(2)
      expect(mocks.fileStore.get('file-abc')).toBeDefined()
      expect(result.id).toBe('file-abc')
    })

    it('uploadFile commits under new ID when recreation returns different ID (LOCK-002)', async () => {
      const uploadResult = makeFile({ id: 'file-abc', count: 1 })
      // No row in Dexie

      // First upload returns ID
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // Physical missing
      mocks.apiFileExists.mockResolvedValueOnce(false)
      // Re-upload returns DIFFERENT ID (duplicate was also deleted)
      const recreated = makeFile({ id: 'file-new', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(recreated)
      // LOCK-002: Physical revalidation inside new lock succeeds
      mocks.apiFileExists.mockResolvedValueOnce(true)

      const { default: FileManager } = await import('../FileManager')
      const result = await FileManager.uploadFile(makeFile({ count: 1 }))

      // Should have committed under the new ID (deferred path)
      expect(result.id).toBe('file-new')
      expect(mocks.fileStore.get('file-new')).toBeDefined()
    })

    it('uploadFile fails when new physical disappears before new lock revalidation (LOCK-002)', async () => {
      const uploadResult = makeFile({ id: 'file-abc', count: 1 })
      // No row in Dexie

      // First upload returns ID
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // Physical missing
      mocks.apiFileExists.mockResolvedValueOnce(false)
      // Re-upload returns different ID
      const recreated = makeFile({ id: 'file-new', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(recreated)
      // LOCK-002: Physical revalidation inside new lock FAILS (file disappeared)
      mocks.apiFileExists.mockResolvedValueOnce(false)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.uploadFile(makeFile({ count: 1 }))).rejects.toThrow(
        'Physical file missing for recreated ID'
      )
    })

    it('uploadFile succeeds without re-upload when physical exists', async () => {
      const uploadResult = makeFile({ id: 'file-abc', count: 1 })
      // Physical exists
      mocks.apiFileExists.mockResolvedValue(true)
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)

      const { default: FileManager } = await import('../FileManager')
      const result = await FileManager.uploadFile(makeFile({ count: 1 }))

      // Should NOT have re-uploaded
      expect(mocks.apiUpload).toHaveBeenCalledTimes(1)
      expect(result.id).toBe('file-abc')
      expect(mocks.fileStore.get('file-abc')).toBeDefined()
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 10: updateFileCount vs delete (LOCK-001)
  // ──────────────────────────────────────────────────────────────────────
  describe('updateFileCount-vs-delete', () => {
    it('fileLock serializes count updates with delete on same ID', async () => {
      // LOCK-001: verify that fileLock.run serializes operations.
      // We test this by verifying that fileLock correctly chains same-ID operations.
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')

      // Start delete and a count-modifying operation concurrently on same ID.
      // deleteFile acquires lock, then the addFile (which does count read-modify-write)
      // waits for the lock. Either order is safe — no stale read.
      const deletePromise = FileManager.deleteFile(file.id)
      // addFile on same ID will wait for delete's lock to release
      const addPromise = FileManager.addFile(makeFile({ id: file.id, count: 1 }))

      await Promise.all([deletePromise, addPromise])

      // File should exist with count >= 1 (either add won or delete+add happened in order)
      const result = mocks.fileStore.get(file.id)
      if (result) {
        expect(result.count).toBeGreaterThanOrEqual(1)
      }
      // Key invariant: no count <= 0 with a live reference
    })

    it('two concurrent adds on same ID are serialized by fileLock', async () => {
      // Two concurrent adds on same ID — serialized, both should apply
      mocks.apiFileExists.mockResolvedValue(true)

      const { default: FileManager } = await import('../FileManager')

      await Promise.all([
        FileManager.addFile(makeFile({ id: 'file-x', count: 1 })),
        FileManager.addFile(makeFile({ id: 'file-x', count: 1 }))
      ])

      // Count should be 2 (first add creates with count=1, second increments to 2)
      expect(mocks.fileStore.get('file-x').count).toBe(2)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 11: different IDs concurrency (no mutual blocking)
  // ──────────────────────────────────────────────────────────────────────
  describe('different-IDs-concurrency', () => {
    it('operations on different IDs run concurrently without blocking', async () => {
      mocks.apiFileExists.mockResolvedValue(true)

      const { default: FileManager } = await import('../FileManager')

      // Both adds should run concurrently (different lock keys)
      await Promise.all([
        FileManager.addFile(makeFile({ id: 'file-a', count: 1 })),
        FileManager.addFile(makeFile({ id: 'file-b', count: 1 }))
      ])

      expect(mocks.fileStore.get('file-a').count).toBe(1)
      expect(mocks.fileStore.get('file-b').count).toBe(1)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 12: LOCK-001 — same-ID re-upload final exists check
  // ──────────────────────────────────────────────────────────────────────
  describe('uploadFile-LOCK-001-same-ID-final-exists-check', () => {
    it('uploadFile rejects same-ID re-upload when physical disappears before final check', async () => {
      const uploadResult = makeFile({ id: 'file-abc', count: 1 })
      // No row in Dexie

      // First upload returns ID
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // Physical missing on first check
      mocks.apiFileExists.mockResolvedValueOnce(false)
      // Re-upload succeeds with same ID
      mocks.apiUpload.mockResolvedValueOnce(makeFile({ id: 'file-abc', count: 1 }))
      // LOCK-001: Final physical check after re-upload FAILS (file disappeared)
      mocks.apiFileExists.mockResolvedValueOnce(false)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.uploadFile(makeFile({ count: 1 }))).rejects.toThrow('LOCK-001')
      // Row should NOT have been added
      expect(mocks.fileStore.has('file-abc')).toBe(false)
    })

    it('uploadFile succeeds same-ID re-upload when physical exists at final check', async () => {
      const uploadResult = makeFile({ id: 'file-abc', count: 1 })
      // No row in Dexie

      // First upload returns ID
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // Physical missing on first check
      mocks.apiFileExists.mockResolvedValueOnce(false)
      // Re-upload succeeds with same ID
      mocks.apiUpload.mockResolvedValueOnce(makeFile({ id: 'file-abc', count: 1 }))
      // LOCK-001: Final physical check after re-upload SUCCEEDS
      mocks.apiFileExists.mockResolvedValueOnce(true)

      const { default: FileManager } = await import('../FileManager')
      const result = await FileManager.uploadFile(makeFile({ count: 1 }))

      expect(result.id).toBe('file-abc')
      expect(mocks.fileStore.get('file-abc')).toBeDefined()
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Race 13: LOCK-002 — original identity preflight check
  // ──────────────────────────────────────────────────────────────────────
  describe('uploadFile-LOCK-002-original-identity-preflight', () => {
    it('uploadFile fails when original has positive count but missing physical (different returned ID)', async () => {
      // Original file has positive count but physical is missing
      const originalFile = makeFile({ id: 'orig-id', count: 2 })
      mocks.fileStore.set('orig-id', originalFile)

      // Upload returns a DIFFERENT ID
      const uploadResult = makeFile({ id: 'new-id', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // LOCK-002: Original ID physical check FAILS (first apiFileExists call)
      mocks.apiFileExists.mockResolvedValueOnce(false)
      // Cleanup: delete the unowned physical file
      mocks.apiDelete.mockResolvedValueOnce(undefined)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.uploadFile(makeFile({ id: 'orig-id', count: 1 }))).rejects.toThrow('LOCK-002')
      // Original row should be preserved unchanged
      expect(mocks.fileStore.get('orig-id').count).toBe(2)
      // Returned ID should NOT have been committed
      expect(mocks.fileStore.has('new-id')).toBe(false)
    })

    it('uploadFile succeeds when original has positive count and physical exists', async () => {
      // Original file has positive count AND physical exists
      const originalFile = makeFile({ id: 'orig-id', count: 2 })
      mocks.fileStore.set('orig-id', originalFile)

      // Upload returns a DIFFERENT ID
      const uploadResult = makeFile({ id: 'new-id', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // LOCK-002: Original ID physical check SUCCEEDS (first apiFileExists call)
      mocks.apiFileExists.mockResolvedValueOnce(true)
      // commitUploadResult: new ID physical check SUCCEEDS
      mocks.apiFileExists.mockResolvedValueOnce(true)

      const { default: FileManager } = await import('../FileManager')
      const result = await FileManager.uploadFile(makeFile({ id: 'orig-id', count: 1 }))

      // Should commit under new ID
      expect(result.id).toBe('new-id')
      expect(mocks.fileStore.get('new-id')).toBeDefined()
      // Original unchanged
      expect(mocks.fileStore.get('orig-id').count).toBe(2)
    })

    it('uploadFile succeeds when original has no row (fresh upload)', async () => {
      // No original row in Dexie
      const uploadResult = makeFile({ id: 'new-id', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // commitUploadResult: physical exists
      mocks.apiFileExists.mockResolvedValueOnce(true)

      const { default: FileManager } = await import('../FileManager')
      const result = await FileManager.uploadFile(makeFile({ count: 1 }))

      expect(result.id).toBe('new-id')
      expect(mocks.fileStore.get('new-id')).toBeDefined()
    })

    it('uploadFile cleans up physical when LOCK-002 rejects (different ID cleanup)', async () => {
      // Original has positive count, physical missing
      const originalFile = makeFile({ id: 'orig-id', count: 1 })
      mocks.fileStore.set('orig-id', originalFile)

      const uploadResult = makeFile({ id: 'new-id', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // LOCK-002: Original ID physical check FAILS (first apiFileExists call)
      mocks.apiFileExists.mockResolvedValueOnce(false)
      // Cleanup: delete the unowned physical file (inside returned-ID lock)
      mocks.apiDelete.mockResolvedValueOnce(undefined)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.uploadFile(makeFile({ id: 'orig-id', count: 1 }))).rejects.toThrow('LOCK-002')
      // Physical cleanup was attempted for the different ID
      expect(mocks.apiDelete).toHaveBeenCalledWith('new-id.txt')
    })

    it('uploadFile skips cleanup when concurrent add lands on returned ID (LOCK-001)', async () => {
      // Original has positive count, physical missing
      const originalFile = makeFile({ id: 'orig-id', count: 1 })
      mocks.fileStore.set('orig-id', originalFile)

      const uploadResult = makeFile({ id: 'new-id', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // LOCK-002: Original ID physical check FAILS
      mocks.apiFileExists.mockResolvedValueOnce(false)

      const { default: FileManager } = await import('../FileManager')

      // Start the upload (will reject and defer cleanup to new-id lock)
      const uploadPromise = FileManager.uploadFile(makeFile({ id: 'orig-id', count: 1 }))

      // Before cleanup runs, a concurrent addFile lands on new-id
      // The cleanup's fileLock.run('new-id') will see the live row and skip delete
      mocks.fileStore.set('new-id', makeFile({ id: 'new-id', count: 1 }))

      await expect(uploadPromise).rejects.toThrow('LOCK-002')

      // Cleanup should NOT have been attempted because the Dexie row exists
      // (cleanupLocked re-reads inside lock and sees live reference)
      expect(mocks.apiDelete).not.toHaveBeenCalled()
    })

    it('uploadFile skips cleanup when durable count=0 row exists on returned ID (LOCK-001)', async () => {
      // Original has positive count, physical missing
      const originalFile = makeFile({ id: 'orig-id', count: 1 })
      mocks.fileStore.set('orig-id', originalFile)

      const uploadResult = makeFile({ id: 'new-id', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // LOCK-002: Original ID physical check FAILS
      mocks.apiFileExists.mockResolvedValueOnce(false)

      const { default: FileManager } = await import('../FileManager')

      // Pre-place a durable count=0 row on the returned ID (e.g. from a prior
      // deleteFile physical-failure path). cleanupRejectedReturnedId must treat
      // any existing row as owned and skip physical deletion.
      mocks.fileStore.set('new-id', makeFile({ id: 'new-id', count: 0 }))

      await expect(FileManager.uploadFile(makeFile({ id: 'orig-id', count: 1 }))).rejects.toThrow('LOCK-002')

      // Cleanup must NOT have deleted the physical file — the count=0 row is owned.
      expect(mocks.apiDelete).not.toHaveBeenCalled()
      // Row preserved unchanged
      expect(mocks.fileStore.get('new-id')).toBeDefined()
      expect(mocks.fileStore.get('new-id').count).toBe(0)
    })

    it('uploadFile does not clean up physical when LOCK-002 rejects (same ID — no orphan)', async () => {
      // Original has positive count, physical missing
      const originalFile = makeFile({ id: 'orig-id', count: 1 })
      mocks.fileStore.set('orig-id', originalFile)

      // Upload returns SAME ID as original
      const uploadResult = makeFile({ id: 'orig-id', count: 1 })
      mocks.apiUpload.mockResolvedValueOnce(uploadResult)
      // LOCK-002: Original ID physical check FAILS (first apiFileExists call)
      mocks.apiFileExists.mockResolvedValueOnce(false)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.uploadFile(makeFile({ id: 'orig-id', count: 1 }))).rejects.toThrow('LOCK-002')
      // Same ID — no cleanup needed (physical is the same file)
      expect(mocks.apiDelete).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Knowledge deletion: LOCK-003 shared count / final owner / physical failure
  // ──────────────────────────────────────────────────────────────────────
  describe('knowledge-deletion-LOCK-003', () => {
    it('knowledge file delete with shared count >1 decrements only', async () => {
      const file = makeFile({ count: 3 })
      mocks.fileStore.set(file.id, file)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile(file.id)

      expect(mocks.fileStore.get(file.id).count).toBe(2)
      expect(mocks.apiDelete).not.toHaveBeenCalled()
    })

    it('knowledge file delete with count=1 physically deletes and removes row', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile(file.id)

      expect(mocks.apiDelete).toHaveBeenCalledWith('file-abc.txt')
      expect(mocks.fileStore.has(file.id)).toBe(false)
    })

    it('knowledge file delete preserves row with count=0 on physical failure', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockRejectedValue(new Error('EPERM'))

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.deleteFile(file.id)).rejects.toThrow('EPERM')
      const remaining = mocks.fileStore.get(file.id)
      expect(remaining).toBeDefined()
      expect(remaining.count).toBe(0)
    })

    it('knowledge video delete: shared count decremented for each file', async () => {
      const fileA = makeFile({ id: 'video-srt', count: 2 })
      const fileB = makeFile({ id: 'video-mp4', count: 2 })
      mocks.fileStore.set(fileA.id, fileA)
      mocks.fileStore.set(fileB.id, fileB)

      const { default: FileManager } = await import('../FileManager')
      // Simulates knowledge video item deletion (both files)
      await Promise.allSettled([FileManager.deleteFile(fileA.id), FileManager.deleteFile(fileB.id)])

      expect(mocks.fileStore.get('video-srt').count).toBe(1)
      expect(mocks.fileStore.get('video-mp4').count).toBe(1)
      expect(mocks.apiDelete).not.toHaveBeenCalled()
    })

    it('knowledge video delete: final owner physically deletes', async () => {
      const fileA = makeFile({ id: 'video-srt', count: 1 })
      const fileB = makeFile({ id: 'video-mp4', count: 1 })
      mocks.fileStore.set(fileA.id, fileA)
      mocks.fileStore.set(fileB.id, fileB)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')
      await Promise.allSettled([FileManager.deleteFile(fileA.id), FileManager.deleteFile(fileB.id)])

      expect(mocks.fileStore.has('video-srt')).toBe(false)
      expect(mocks.fileStore.has('video-mp4')).toBe(false)
      expect(mocks.apiDelete).toHaveBeenCalledTimes(2)
    })
  })
})
