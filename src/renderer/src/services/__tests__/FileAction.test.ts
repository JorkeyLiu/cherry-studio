/**
 * FileAction.handleDelete — Phase 5.3 blocker fixes.
 *
 * LOCK-002: when relatedBlocks is empty, calls FileManager.deleteFile directly
 * with default non-force policy. When related blocks exist, uses only Main
 * cleanup result and no second delete.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getFile: vi.fn(),
    listBlocksByFile: vi.fn(),
    deleteBlocks: vi.fn(),
    deleteFile: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mocks.logger
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    listBlocksByFile: mocks.listBlocksByFile,
    deleteBlocks: mocks.deleteBlocks
  }
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    getFile: mocks.getFile,
    deleteFile: mocks.deleteFile
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/components/Popups/TextEditPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('dayjs', () => ({
  default: () => ({ unix: () => 0 })
}))

// Mock window.modal for error handling tests
vi.stubGlobal('modal', { error: vi.fn() })

// --- Helpers --------------------------------------------------------------

const cleanupWithFiles = {
  affectedFileIds: ['file-1'],
  remainingReferenceCounts: { 'file-1': 0 } as Record<string, number>
}

// --- Tests ----------------------------------------------------------------

describe('FileAction.handleDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('LOCK-002: zero-reference file deletion', () => {
    it('calls FileManager.deleteFile directly when no blocks reference the file', async () => {
      mocks.getFile.mockResolvedValue({ id: 'file-1', origin_name: 'test.txt', ext: '.txt' })
      mocks.listBlocksByFile.mockResolvedValue([])

      const { handleDelete } = await import('../FileAction')
      await handleDelete('file-1', (k: string) => k)

      // FileManager.deleteFile called directly with non-force policy (default)
      expect(mocks.deleteFile).toHaveBeenCalledExactlyOnceWith('file-1')
      // No DB block deletion attempted
      expect(mocks.deleteBlocks).not.toHaveBeenCalled()
      // No consumeFileCleanupResult (no Main cleanup needed)
      expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    })
  })

  describe('referenced file path: Main cleanup only', () => {
    it('uses atomic deleteBlocks + consumeFileCleanupResult when blocks exist', async () => {
      mocks.getFile.mockResolvedValue({ id: 'file-1', origin_name: 'test.txt', ext: '.txt' })
      mocks.listBlocksByFile.mockResolvedValue([
        { id: 'block-1', fileId: 'file-1' },
        { id: 'block-2', fileId: 'file-1' }
      ])
      mocks.deleteBlocks.mockResolvedValue(cleanupWithFiles)

      const { handleDelete } = await import('../FileAction')
      await handleDelete('file-1', (k: string) => k)

      // DB block deletion via atomic Main command
      expect(mocks.deleteBlocks).toHaveBeenCalledExactlyOnceWith(['block-1', 'block-2'])
      // consumeFileCleanupResult handles file cleanup exactly once
      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(cleanupWithFiles)
      // FileManager.deleteFile NOT called directly (no double cleanup)
      expect(mocks.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('does not call FileManager.deleteFile on DB error', async () => {
      mocks.getFile.mockResolvedValue({ id: 'file-1', origin_name: 'test.txt', ext: '.txt' })
      mocks.listBlocksByFile.mockResolvedValue([{ id: 'block-1' }])
      mocks.deleteBlocks.mockRejectedValue(new Error('DB_FAIL'))

      const { handleDelete } = await import('../FileAction')
      // Should not throw
      await handleDelete('file-1', (k: string) => k)

      expect(mocks.deleteFile).not.toHaveBeenCalled()
      expect(mocks.logger.error).toHaveBeenCalled()
    })

    it('does nothing when file is not found', async () => {
      mocks.getFile.mockResolvedValue(undefined)

      const { handleDelete } = await import('../FileAction')
      await handleDelete('nonexistent', (k: string) => k)

      expect(mocks.listBlocksByFile).not.toHaveBeenCalled()
      expect(mocks.deleteFile).not.toHaveBeenCalled()
    })
  })
})
