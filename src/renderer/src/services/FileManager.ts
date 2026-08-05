import { loggerService } from '@logger'
import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import type { FileMetadata } from '@renderer/types'
import { getFileDirectory } from '@renderer/utils'
import dayjs from 'dayjs'

import { fileLock } from './FileLock'

const logger = loggerService.withContext('FileManager')

class FileManager {
  static async selectFiles(options?: Electron.OpenDialogOptions): Promise<FileMetadata[] | null> {
    return await window.api.file.select(options)
  }

  /**
   * LOCK-001/002/003: Increment count or insert new row, serialized per file ID.
   * Re-reads the row inside the lock so a concurrent delete cannot stale the decision.
   * LOCK-002/003: Verifies physical file existence before committing. If the physical
   * stored file is missing (race with delete), addFile cannot recreate from metadata
   * alone (no original source data), so it throws to prevent committing stale references.
   */
  static async addFile(file: FileMetadata): Promise<FileMetadata> {
    return fileLock.run(file.id, async () => {
      const fileRecord = await db.files.get(file.id)

      // LOCK-002/003: Verify physical existence before any Dexie commit.
      const physicalExists = await window.api.file.exists(file.id + file.ext)

      if (fileRecord) {
        // LOCK-003: Existing row — verify physical before increment.
        if (!physicalExists) {
          throw new Error(
            `Physical file missing for existing row ${file.id}: cannot increment ` +
              'without physical existence (addFile has no source data to recreate)'
          )
        }
        await db.files.update(fileRecord.id, { ...fileRecord, count: fileRecord.count + 1 })
        return fileRecord
      }

      // New row — verify physical before insert.
      if (!physicalExists) {
        throw new Error(
          `Physical file missing for new row ${file.id}: cannot commit metadata ` +
            'without physical existence (addFile has no source data to recreate)'
        )
      }

      await db.files.add(file)

      return file
    })
  }

  static async addFiles(files: FileMetadata[]): Promise<FileMetadata[]> {
    return Promise.all(files.map((file) => this.addFile(file)))
  }

  static async readBinaryImage(file: FileMetadata): Promise<Buffer> {
    const fileData = await window.api.file.binaryImage(file.id + file.ext)
    return fileData.data
  }

  static async readBase64File(file: FileMetadata): Promise<string> {
    const fileData = await window.api.file.base64File(file.id + file.ext)
    return fileData.data
  }

  /**
   * LOCK-001/002/003: Upload + increment/insert, serialized per file ID.
   * Physical upload (window.api.file.upload) is outside the lock since it does not
   * depend on Dexie state. Once the upload returns an ID, the Dexie mutation is
   * serialized.
   *
   * LOCK-002: Before accepting any returned ID, inspects the original file.id
   * under its keyed lock. If an existing positive-count original row has missing
   * physical storage, FAILS immediately. Avoids lock cycles via phased/deferred
   * flow (original lock released before cleanup/commit).
   *
   * LOCK-001: Rejected different-ID upload cleanup acquires returned-ID fileLock
   * AFTER releasing original lock. Inside lock, re-reads Dexie row: if any
   * row/reference exists, does not physically delete; if absent, deletes only
   * the exact validated stored regular file.
   *
   * LOCK-001: Same-ID recreation re-runs strict file.exists immediately before
   * Dexie insert under the held ID lock; absence rejects with no row commit.
   *
   * LOCK-003: If the original ID has an existing positive-count row but the
   * physical file is missing, the method FAILS immediately. It does not attempt
   * re-upload or migration to preserve original row/reference identity.
   *
   * LOCK-004: When the original row is absent and recreation returns a new ID,
   * commit only after new-lock physical revalidation; no nested cross-key locks.
   */
  static async uploadFile(file: FileMetadata): Promise<FileMetadata> {
    logger.info(`Uploading file: ${JSON.stringify(file)}`)

    const uploadResult = await window.api.file.upload(file)
    logger.info('Uploaded file:', uploadResult)

    // LOCK-002: Pre-flight check — inspect original file.id under its keyed lock.
    // If the original has a positive-count row but missing physical storage,
    // fail and preserve identity. Do not commit a different returned ID.
    // Phased flow: acquire original lock, check, release — then handle cleanup/commit.
    let rejectedCleanupMetadata: FileMetadata | null = null
    let lockError: Error | null = null
    try {
      await fileLock.run(file.id, async () => {
        const originalRow = await db.files.get(file.id)
        if (originalRow && originalRow.count > 0) {
          const physicalExists = await window.api.file.exists(originalRow.id + originalRow.ext)
          if (!physicalExists) {
            // LOCK-001: If different returned ID, defer cleanup — original lock will
            // be released, then cleanup acquires returned-ID lock and re-reads Dexie.
            if (uploadResult.id !== file.id) {
              rejectedCleanupMetadata = uploadResult
            }
            throw new Error(
              `LOCK-002: Original file ${file.id} has positive count (${originalRow.count}) ` +
                'but physical storage is missing. Cannot accept returned ID — preserving original identity.'
            )
          }
        }
      })
    } catch (error) {
      lockError = error as Error
    }

    // LOCK-001: After original lock released, cleanup the returned-ID physical file
    // under its own lock. Re-read Dexie row: if any row/reference exists, do NOT
    // physically delete. If absent, delete only the exact validated stored file.
    if (rejectedCleanupMetadata) {
      await FileManager.cleanupRejectedReturnedId(rejectedCleanupMetadata)
    }

    // Re-throw the lock error after cleanup completes.
    if (lockError) {
      throw lockError
    }

    return FileManager.commitUploadResult(file, uploadResult)
  }

  /**
   * LOCK-001: Cleanup a returned-ID physical file after rejection of a different-ID
   * upload. Acquires the returned-ID's fileLock, re-reads the Dexie row inside the
   * lock, and only physically deletes if:
   * 1. No Dexie row exists for the returned ID (no reference), AND
   * 2. The physical file is a validated regular file within storageDir.
   *
   * This prevents deleting a physical file that has a live Dexie reference from a
   * concurrent addFile/commitUploadResult.
   */
  private static async cleanupRejectedReturnedId(metadata: FileMetadata): Promise<void> {
    await fileLock.run(metadata.id, async () => {
      // LOCK-001: Re-read Dexie row inside the returned-ID lock.
      // Any existing row — including durable count=0 cleanup-pending rows — is
      // treated as owned. Skip best-effort physical deletion regardless of count.
      const existingRow = await db.files.get(metadata.id)
      if (existingRow) {
        logger.info(
          `[cleanupRejectedReturnedId] Skipping delete for ${metadata.id}: ` +
            `existing row (count=${existingRow.count})`
        )
        return
      }

      // No live reference. Validate and delete the physical file (best-effort).
      try {
        await window.api.file.delete(metadata.id + metadata.ext)
      } catch {
        // Best-effort — orphan cleanup will handle stale physical files.
      }
    })
  }

  /**
   * LOCK-002/003/004: Commit an upload result under its lock key.
   * When recreation returns a different ID, returns a deferred signal so the
   * caller releases the old lock before acquiring the new one.
   */
  private static async commitUploadResult(file: FileMetadata, uploadResult: FileMetadata): Promise<FileMetadata> {
    const result = await fileLock.run(uploadResult.id, async () => {
      const fileRecord = await db.files.get(uploadResult.id)

      // LOCK-002/003: Verify physical existence before committing.
      const physicalExists = await window.api.file.exists(uploadResult.id + uploadResult.ext)

      if (fileRecord) {
        // LOCK-003: Existing row — if physical exists, increment.
        if (physicalExists) {
          await db.files.update(fileRecord.id, { ...fileRecord, count: fileRecord.count + 1 })
          return { status: 'done' as const, file: fileRecord }
        }

        // LOCK-003: Existing row with missing physical — FAIL immediately.
        // Do not re-upload or migrate; preserve original row/reference identity.
        throw new Error(
          `Physical file missing for existing row ${uploadResult.id}: ` +
            'cannot migrate to new ID while original row has positive count ' +
            '(preserve original reference identity per LOCK-003)'
        )
      }

      // No row — verify physical before insert.
      if (physicalExists) {
        await db.files.add(uploadResult)
        return { status: 'done' as const, file: uploadResult }
      }

      // Physical missing, no row — recreate from original input.
      logger.warn(`Physical file missing for new row ${uploadResult.id}, re-uploading`)
      const recreated = await window.api.file.upload(file)

      if (recreated.id === uploadResult.id) {
        // LOCK-001: Same ID — re-run strict file.exists immediately before Dexie insert
        // under the held ID lock. Absence rejects with no row commit.
        const physicalRecheck = await window.api.file.exists(recreated.id + recreated.ext)
        if (!physicalRecheck) {
          throw new Error(
            `LOCK-001: Physical file missing for recreated ID ${recreated.id} after re-upload: ` +
              'cannot commit metadata without physical existence (final revalidation failed)'
          )
        }
        // Physical file confirmed present; insert new row.
        await db.files.add(recreated)
        return { status: 'done' as const, file: recreated }
      }

      // LOCK-002: Different ID — return deferred. The old lock will be released
      // when this callback returns, then commitOrIncrementUnderLock acquires
      // the new ID's lock separately (no nested cross-key lock).
      return { status: 'deferred' as const, metadata: recreated }
    })

    if (result.status === 'deferred') {
      // Old lock released. Acquire new lock, revalidate physical, commit.
      return FileManager.commitOrIncrementUnderLock(result.metadata)
    }

    return result.file
  }

  /**
   * LOCK-002/004: Commit file metadata under its own lock key. Used when uploadFile
   * recreation returns a different ID than the original lock key. Acquires the
   * new ID's lock (safe — different key from the outer lock), revalidates physical
   * existence inside the new lock, then either increments an existing row or
   * inserts a new one.
   *
   * Avoids nested same-key deadlock: this is only called when recreated.id differs
   * from the outer lock key, and only after the outer lock is released.
   */
  private static async commitOrIncrementUnderLock(metadata: FileMetadata): Promise<FileMetadata> {
    return fileLock.run(metadata.id, async () => {
      // LOCK-002/004: Revalidate physical existence inside the new lock immediately
      // before Dexie mutation. If the physical file disappeared between the old
      // lock release and this lock acquisition, fail rather than commit stale metadata.
      const physicalExists = await window.api.file.exists(metadata.id + metadata.ext)
      if (!physicalExists) {
        throw new Error(
          `Physical file missing for recreated ID ${metadata.id} after lock reacquisition: ` +
            'cannot commit metadata without physical existence'
        )
      }

      const existing = await db.files.get(metadata.id)

      if (existing) {
        await db.files.update(metadata.id, { ...existing, count: existing.count + 1 })
        return existing
      }

      await db.files.add(metadata)
      return metadata
    })
  }

  static async uploadFiles(files: FileMetadata[]): Promise<FileMetadata[]> {
    return Promise.all(files.map((file) => this.uploadFile(file)))
  }

  static async getFile(id: string): Promise<FileMetadata | undefined> {
    const file = await db.files.get(id)

    if (file) {
      const filesPath = store.getState().runtime.filesPath
      file.path = filesPath + '/' + file.id + file.ext
    }

    return file
  }

  static getFilePath(file: FileMetadata) {
    const filesPath = store.getState().runtime.filesPath
    return filesPath + '/' + file.id + file.ext
  }

  /**
   * Delete a file by ID.
   *
   * LOCK-001/002: The entire read-count → decision → physical delete → Dexie
   *   mutation critical section is serialized per file ID.
   * LOCK-001: For count > 1 (and !force), decrement only — never physically delete.
   * LOCK-002: For count <= 1 (sole/zero owner), attempt physical delete first.
   *   Success → delete Dexie row.
   *   Failure → preserve row with count=0 and rethrow so callers observe the rejection.
   * LOCK-004: Missing physical file is treated as success (FileStorage returns void for !exists).
   */
  static async deleteFile(id: string, force: boolean = false): Promise<void> {
    return fileLock.run(id, async () => {
      const file = await this.getFile(id)

      logger.info('Deleting file:', file)

      if (!file) {
        return
      }

      // LOCK-001: shared count>1 → decrement only
      if (!force) {
        if (file.count > 1) {
          await db.files.update(id, { ...file, count: file.count - 1 })
          return
        }
      }

      // LOCK-002: sole/zero owner → physical delete first
      try {
        await window.api.file.delete(id + file.ext)
      } catch (error) {
        // Physical delete failed. Preserve row with count=0 for durable retry
        // (OrphanCleanupService retries count<=0 rows on next startup).
        logger.error('Failed to delete physical file:', error as Error)
        await db.files.update(id, { ...file, count: 0 })
        throw error
      }

      // Physical delete succeeded (or file was already absent — LOCK-004).
      // Now safe to remove the Dexie row.
      await db.files.delete(id)
    })
  }

  static async deleteFiles(files: FileMetadata[]): Promise<void> {
    if (!files || files.length === 0) return

    const results = await Promise.allSettled(files.map((file) => this.deleteFile(file.id)))

    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length > 0) {
      logger.warn(`File deletions completed with ${failed.length} files failed to delete:`, failed)
    }
  }

  static async allFiles(): Promise<FileMetadata[]> {
    return db.files.toArray()
  }

  static isDangerFile(file: FileMetadata) {
    return ['.sh', '.bat', '.cmd', '.ps1', '.vbs', 'reg'].includes(file.ext)
  }

  static getSafePath(file: FileMetadata) {
    // use the path from the file metadata instead
    // this function is used to get path for files which are not in the filestorage
    return this.isDangerFile(file) ? getFileDirectory(file.path) : file.path
  }

  static getFileUrl(file: FileMetadata) {
    const filesPath = store.getState().runtime.filesPath
    return 'file://' + filesPath + '/' + file.name
  }

  static async updateFile(file: FileMetadata) {
    if (!file.origin_name.includes(file.ext)) {
      file.origin_name = file.origin_name + file.ext
    }

    await db.files.update(file.id, file)
  }

  static formatFileName(file: FileMetadata) {
    if (!file || !file.origin_name) {
      return ''
    }

    // LOCK-BROWSE-3: catalog-imported rows may have a null source timestamp —
    // render the neutral name without an "Invalid Date" prefix.
    const date = file.created_at ? dayjs(file.created_at).format('YYYY-MM-DD') : ''
    const datePrefix = date ? `${date} ` : ''

    if (file.origin_name.includes('pasted_text')) {
      return datePrefix + i18n.t('message.attachments.pasted_text') + file.ext
    }

    if (file.origin_name.startsWith('temp_file') && file.origin_name.includes('image')) {
      return datePrefix + i18n.t('message.attachments.pasted_image') + file.ext
    }

    return file.origin_name
  }
}

export default FileManager
