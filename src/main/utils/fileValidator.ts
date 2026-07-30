/**
 * LOCK-003: Shared production stored-file path validator/resolver.
 * Used directly by both FileStorage.fileExists and FileStorage.deleteFile.
 *
 * Validates that the input is a plain basename (no separators, traversal,
 * absolute path, or dot segments), resolves within storageDir, and uses lstat
 * to confirm a regular file (rejects symlinks, directories).
 *
 * @param storageDir The root directory that stored files must resolve within.
 * @param storedFileName The candidate stored file name (id + ext).
 * @returns The resolved absolute path if valid and exists as a regular file,
 *   or null if validation fails or the file does not exist / is not a regular file.
 *   For deleteFile callers: null for a missing file after validation means "success"
 *   (nothing to delete). For fileExists callers: null means false.
 */
import * as fs from 'fs'
import * as path from 'path'

export async function validateStoredFilePath(storageDir: string, storedFileName: string): Promise<string | null> {
  // LOCK-003: Must be a non-empty string
  if (typeof storedFileName !== 'string' || storedFileName.length === 0) {
    return null
  }

  // LOCK-003: Reject path separators, traversal segments, and absolute paths
  if (
    storedFileName.includes('/') ||
    storedFileName.includes('\\') ||
    storedFileName.includes('..') ||
    path.isAbsolute(storedFileName)
  ) {
    return null
  }

  // LOCK-003: Resolve the candidate path within storageDir and verify containment
  const storageDirResolved = path.resolve(storageDir)
  const resolved = path.resolve(storageDir, storedFileName)
  if (!resolved.startsWith(storageDirResolved + path.sep)) {
    return null
  }

  // LOCK-003: Use lstat to reject symlinks and directories — must be a regular file
  try {
    const stat = await fs.promises.lstat(resolved)
    if (!stat.isFile()) {
      return null
    }
    return resolved
  } catch {
    return null
  }
}
