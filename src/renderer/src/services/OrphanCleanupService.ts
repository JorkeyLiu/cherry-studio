/**
 * Service for cleaning up orphan files with zero or negative reference counts.
 * Should be called during application startup.
 *
 * LOCK-003: Startup orphan cleanup retries count<=0 rows; physical failure
 *   leaves row for next startup and does not report success.
 * LOCK-004: Missing physical file remains successful cleanup (FileStorage
 *   returns void for !exists).
 * LOCK-001/004: Each cleanup decision is serialized per file ID through
 *   fileLock, and the row/count is re-read inside the lock immediately
 *   before deletion to prevent stale zero-owner deletion.
 */
import { loggerService } from '@logger'
import db from '@renderer/databases'

import { fileLock } from './FileLock'

const logger = loggerService.withContext('OrphanCleanupService')

/**
 * Clean up orphan files with reference count <= 0.
 * These are files that are no longer referenced by any message blocks.
 * Call this function during application startup.
 *
 * LOCK-004: Each file's cleanup is serialized through fileLock and re-reads
 * the row inside the lock. If count became >0 between the initial query and
 * the lock acquisition, the cleanup is skipped.
 */
export async function cleanupOrphanFiles(): Promise<void> {
  try {
    const orphanFiles = await db.files.where('count').belowOrEqual(0).toArray()
    if (orphanFiles.length === 0) return

    logger.info(`[cleanupOrphanFiles] Found ${orphanFiles.length} orphan files`)

    let cleaned = 0
    for (const file of orphanFiles) {
      const result = await fileLock.run(file.id, async () => {
        // Re-read inside the lock — count may have changed since the initial query.
        const current = await db.files.get(file.id)
        if (!current) {
          // Already deleted by a concurrent operation (e.g. deleteFile).
          return 'skipped' as const
        }
        if (current.count > 0) {
          // A concurrent addFile/increment restored the reference — skip cleanup.
          logger.info(`[cleanupOrphanFiles] Skipping ${file.id}: count restored to ${current.count}`)
          return 'skipped' as const
        }

        try {
          await window.api.file.delete(current.id + current.ext)
        } catch (error) {
          // LOCK-003: Physical delete failed — preserve row for next startup retry.
          // LOCK-004: A missing file would NOT throw (FileStorage returns void for !exists),
          // so any throw here is a real failure (EPERM, EBUSY, etc.).
          logger.error(
            `[cleanupOrphanFiles] Physical delete failed for ${current.id}, will retry next startup:`,
            error as Error
          )
          return 'failed' as const
        }

        // Physical delete succeeded (or file was already absent) — safe to remove row.
        await db.files.delete(current.id)
        return 'cleaned' as const
      })

      if (result === 'cleaned') cleaned++
    }

    logger.info(`[cleanupOrphanFiles] Cleaned up ${cleaned}/${orphanFiles.length} orphan files`)
  } catch (error) {
    logger.error('[cleanupOrphanFiles] Failed:', error as Error)
  }
}

export default cleanupOrphanFiles
