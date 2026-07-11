/**
 * Service for cleaning up orphan files with zero or negative reference counts.
 * Should be called during application startup.
 */
import { loggerService } from '@logger'
import db from '@renderer/databases'

const logger = loggerService.withContext('OrphanCleanupService')

/**
 * Clean up orphan files with reference count <= 0.
 * These are files that are no longer referenced by any message blocks.
 * Call this function during application startup.
 */
export async function cleanupOrphanFiles(): Promise<void> {
  try {
    const orphanFiles = await db.files.where('count').belowOrEqual(0).toArray()
    if (orphanFiles.length === 0) return

    logger.info(`[cleanupOrphanFiles] Found ${orphanFiles.length} orphan files`)

    for (const file of orphanFiles) {
      try {
        await window.api.file.delete(file.id + file.ext)
      } catch (error) {
        // Physical file may already not exist, ignore error
      }
      await db.files.delete(file.id)
    }

    logger.info(`[cleanupOrphanFiles] Cleaned up ${orphanFiles.length} orphan files`)
  } catch (error) {
    logger.error('[cleanupOrphanFiles] Failed:', error as Error)
  }
}

export default cleanupOrphanFiles
