import { loggerService } from '@logger'
import TextEditPopup from '@renderer/components/Popups/TextEditPopup'
import { dbService } from '@renderer/services/db'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import dayjs from 'dayjs'

// 排序相关
export type SortField = 'created_at' | 'size' | 'name'
export type SortOrder = 'asc' | 'desc'

const logger = loggerService.withContext('FileAction')

export function tempFilesSort(files: FileMetadata[]): FileMetadata[] {
  return files.sort((a, b) => {
    const aIsTemp = a.origin_name.startsWith('temp_file')
    const bIsTemp = b.origin_name.startsWith('temp_file')
    if (aIsTemp && !bIsTemp) return 1
    if (!aIsTemp && bIsTemp) return -1
    return 0
  })
}

/**
 * Deterministic created-at sort key (LOCK-BROWSE-3). A null/absent source
 * timestamp maps to `Number.MIN_SAFE_INTEGER` — it never yields NaN and
 * always lands at one fixed end of either sort order. An unparseable stored
 * value degrades to the same fallback. No timestamp is invented.
 */
export function createdAtSortKey(file: FileMetadata): number {
  if (file.created_at === null || file.created_at === undefined) {
    return Number.MIN_SAFE_INTEGER
  }
  const unix = dayjs(file.created_at).unix()
  return Number.isNaN(unix) ? Number.MIN_SAFE_INTEGER : unix
}

export function sortFiles(files: FileMetadata[], sortField: SortField, sortOrder: SortOrder): FileMetadata[] {
  return [...files].sort((a, b) => {
    let comparison = 0
    switch (sortField) {
      case 'created_at':
        comparison = createdAtSortKey(a) - createdAtSortKey(b)
        break
      case 'size':
        comparison = a.size - b.size
        break
      case 'name':
        comparison = a.origin_name.localeCompare(b.origin_name)
        break
    }
    return sortOrder === 'asc' ? comparison : -comparison
  })
}

// 删除操作
export async function handleDelete(fileId: string, t: (key: string) => string) {
  const file = await FileManager.getFile(fileId)
  if (!file) return

  const relatedBlocks = await dbService.listBlocksByFile(fileId)

  try {
    if (relatedBlocks.length === 0) {
      // LOCK-002: No blocks reference this file — delete directly with
      // default non-force FileManager policy.
      await FileManager.deleteFile(fileId)
      logger.info(`Deleted file ${fileId} (no referencing blocks)`)
    } else {
      // Blocks reference this file — atomic delete via Main cleanup result.
      const blockIdsToDelete = relatedBlocks.map((b) => b.id as string)
      const cleanup = await dbService.deleteBlocks(blockIdsToDelete)
      await consumeFileCleanupResult(cleanup)
      // Physical file cleanup is handled exclusively by consumeFileCleanupResult
      // using non-force FileManager policy (LOCK-002, LOCK-003).
      logger.info(`Deleted ${blockIdsToDelete.length} blocks for file ${fileId}`)
    }
  } catch (err) {
    logger.error(`Error removing file blocks for ${fileId}:`, err as Error)
    window.modal.error({ content: t('files.delete.db_error'), centered: true })
  }
}

// 重命名操作
export async function handleRename(fileId: string) {
  const file = await FileManager.getFile(fileId)
  if (!file) return
  const newName = await TextEditPopup.show({ text: file.origin_name })
  if (newName) {
    void FileManager.updateFile({ ...file, origin_name: newName })
  }
}
