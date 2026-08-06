/**
 * FileManager.deleteFile — durable physical file deletion semantics.
 *
 * LOCK-001: count>1 → decrement only, never physically delete.
 * LOCK-002: count<=1 → physical delete first; success removes row;
 *           failure preserves row with count=0 and rethrows.
 * LOCK-004: Missing physical file is treated as success.
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
      apiDelete: vi.fn(),
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

// Narrow mocks for FileManager's heavyweight imports (LOCK-STAB). Real
// '@renderer/i18n' (~3.3MB locale init) and '@renderer/utils' are not used
// by deleteFile paths; mocking them avoids cold-import timeout in full runs.
// Matches FileManager.concurrency.test.ts pattern.
vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/utils', () => ({
  getFileDirectory: (filePath: string) => filePath
}))

vi.mock('@renderer/databases', () => {
  const db = {
    files: {
      get: vi.fn(async (id: string) => mocks.fileStore.get(id) ?? undefined),
      add: vi.fn(async (file: any) => {
        mocks.fileStore.set(file.id, file)
      }),
      update: vi.fn(async (id: string, changes: any) => {
        const existing = mocks.fileStore.get(id)
        if (existing) {
          mocks.fileStore.set(id, { ...existing, ...changes })
        }
      }),
      delete: vi.fn(async (id: string) => {
        mocks.fileStore.delete(id)
      }),
      toArray: vi.fn(async () => Array.from(mocks.fileStore.values()))
    }
  }
  return { default: db, db }
})

vi.stubGlobal('window', {
  api: {
    file: {
      delete: mocks.apiDelete,
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
    type: 'text',
    created_at: '2025-01-01T00:00:00Z',
    count: 1,
    ...overrides
  }
}

// --- Tests ----------------------------------------------------------------

describe('FileManager.deleteFile — LOCK-001/002/004', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.fileStore.clear()
  })

  describe('LOCK-001: count > 1 → decrement only', () => {
    it('decrements count and does not physically delete when count > 1', async () => {
      const file = makeFile({ count: 3 })
      mocks.fileStore.set(file.id, file)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile(file.id)

      // Count should be decremented
      expect(mocks.fileStore.get(file.id).count).toBe(2)
      // No physical delete attempted
      expect(mocks.apiDelete).not.toHaveBeenCalled()
    })

    it('decrements to 1 without physical delete', async () => {
      const file = makeFile({ count: 2 })
      mocks.fileStore.set(file.id, file)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile(file.id)

      expect(mocks.fileStore.get(file.id).count).toBe(1)
      expect(mocks.apiDelete).not.toHaveBeenCalled()
    })
  })

  describe('LOCK-002: count <= 1 → physical delete first', () => {
    it('physically deletes then removes Dexie row on success (count=1)', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile(file.id)

      // Physical delete called first
      expect(mocks.apiDelete).toHaveBeenCalledWith('file-abc.txt')
      // Dexie row removed
      expect(mocks.fileStore.has(file.id)).toBe(false)
    })

    it('physically deletes then removes Dexie row on success (count=0)', async () => {
      const file = makeFile({ count: 0 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile(file.id)

      expect(mocks.apiDelete).toHaveBeenCalledWith('file-abc.txt')
      expect(mocks.fileStore.has(file.id)).toBe(false)
    })

    it('preserves Dexie row with count=0 and rethrows on physical failure', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      const physicalError = new Error('EPERM: operation not permitted')
      mocks.apiDelete.mockRejectedValue(physicalError)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.deleteFile(file.id)).rejects.toThrow('EPERM: operation not permitted')

      // Row preserved with count=0
      const remaining = mocks.fileStore.get(file.id)
      expect(remaining).toBeDefined()
      expect(remaining.count).toBe(0)

      // Physical delete was attempted
      expect(mocks.apiDelete).toHaveBeenCalledWith('file-abc.txt')
    })

    it('preserves Dexie row with count=0 and rethrows even when starting count=0', async () => {
      const file = makeFile({ count: 0 })
      mocks.fileStore.set(file.id, file)
      const physicalError = new Error('EBUSY')
      mocks.apiDelete.mockRejectedValue(physicalError)

      const { default: FileManager } = await import('../FileManager')

      await expect(FileManager.deleteFile(file.id)).rejects.toThrow('EBUSY')

      const remaining = mocks.fileStore.get(file.id)
      expect(remaining).toBeDefined()
      expect(remaining.count).toBe(0)
    })

    it('succeeds when physical file is missing (LOCK-004)', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)
      // FileStorage.deleteFile returns void for !exists — no throw
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile(file.id)

      expect(mocks.apiDelete).toHaveBeenCalled()
      // Dexie row removed (missing file = success)
      expect(mocks.fileStore.has(file.id)).toBe(false)
    })
  })

  describe('retry after durable count=0', () => {
    it('subsequent retry succeeds after initial physical failure', async () => {
      const file = makeFile({ count: 1 })
      mocks.fileStore.set(file.id, file)

      const { default: FileManager } = await import('../FileManager')

      // First attempt: physical failure
      mocks.apiDelete.mockRejectedValueOnce(new Error('EPERM'))
      await expect(FileManager.deleteFile(file.id)).rejects.toThrow('EPERM')

      // Row preserved with count=0
      expect(mocks.fileStore.get(file.id).count).toBe(0)

      // Second attempt: physical success (e.g. permission resolved)
      mocks.apiDelete.mockResolvedValueOnce(undefined)
      await FileManager.deleteFile(file.id)

      // Dexie row removed
      expect(mocks.fileStore.has(file.id)).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('no-ops when file not found in Dexie', async () => {
      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile('nonexistent')

      expect(mocks.apiDelete).not.toHaveBeenCalled()
    })

    it('force=true with count>1 physically deletes and removes row', async () => {
      const file = makeFile({ count: 3 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockResolvedValue(undefined)

      const { default: FileManager } = await import('../FileManager')
      await FileManager.deleteFile(file.id, true)

      expect(mocks.apiDelete).toHaveBeenCalled()
      expect(mocks.fileStore.has(file.id)).toBe(false)
    })

    it('force=true with count>1 preserves row on physical failure', async () => {
      const file = makeFile({ count: 3 })
      mocks.fileStore.set(file.id, file)
      mocks.apiDelete.mockRejectedValue(new Error('EPERM'))

      const { default: FileManager } = await import('../FileManager')
      await expect(FileManager.deleteFile(file.id, true)).rejects.toThrow('EPERM')

      const remaining = mocks.fileStore.get(file.id)
      expect(remaining).toBeDefined()
      expect(remaining.count).toBe(0)
    })
  })
})
