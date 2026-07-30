/**
 * FileStorage.deleteFile — LOCK-003 secure delete path validation tests.
 *
 * LOCK-003: Tests exercise the actual exported validateStoredFilePath production
 * helper — NOT copied validation logic. The deleteFile method delegates entirely
 * to validateStoredFilePath for security; if it returns null, deleteFile no-ops.
 *
 * Verifies: traversal, symlink, directory, non-string inputs are all rejected
 * by the shared validator (returning null), meaning deleteFile would no-op.
 * Missing valid file returns null (success for delete — nothing to delete).
 */

import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import type * as NodePath from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// --- Real modules for temp directory management ---------------------------
const realFs = (await vi.importActual('node:fs')) as typeof NodeFs
const realOs = (await vi.importActual('node:os')) as typeof NodeOs
const realPath = (await vi.importActual('node:path')) as typeof NodePath

// --- Bounded temp storage ------------------------------------------------
let tempDir: string
let filesDir: string

beforeAll(async () => {
  tempDir = await realFs.promises.mkdtemp(realPath.join(realOs.tmpdir(), 'fe-delete-test-'))
  filesDir = tempDir
})

afterEach(async () => {
  try {
    const entries = await realFs.promises.readdir(filesDir)
    for (const entry of entries) {
      const fullPath = realPath.join(filesDir, entry)
      const stat = await realFs.promises.lstat(fullPath)
      if (stat.isSymbolicLink()) {
        await realFs.promises.unlink(fullPath)
      } else if (stat.isDirectory()) {
        await realFs.promises.rm(fullPath, { recursive: true })
      } else {
        await realFs.promises.unlink(fullPath)
      }
    }
  } catch {}
})

afterAll(async () => {
  try {
    await realFs.promises.rm(tempDir, { recursive: true, force: true })
  } catch {}
})

// --- Mocks ----------------------------------------------------------------
// Override the main.setup.ts mocks with real implementations for fs/path
// so that validateStoredFilePath uses real filesystem operations.
vi.mock('node:fs', async () => {
  return await vi.importActual('node:fs')
})
vi.mock('node:path', async () => {
  return await vi.importActual('node:path')
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === 'userData') return filesDir
      if (key === 'temp') return filesDir + '/temp'
      return '/mock/unknown'
    }),
    getVersion: vi.fn(() => '1.0.0')
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  session: { defaultSession: { clearCache: vi.fn(), clearStorageData: vi.fn() } },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: vi.fn() }
}))

// --- Import actual production helper --------------------------------------
// LOCK-004: Tests invoke the shared production helper directly.
const { validateStoredFilePath } = await import('@main/utils/fileValidator')

// --- Tests ----------------------------------------------------------------

/**
 * LOCK-003: FileStorage.deleteFile delegates to validateStoredFilePath for
 * all path/security validation. If the validator returns null, deleteFile
 * returns void without any filesystem mutation. These tests verify that the
 * shared validator correctly rejects dangerous inputs that would previously
 * have been passed directly to fs.promises.unlink.
 *
 * For deleteFile callers, a null return from validateStoredFilePath means
 * "nothing to delete" (success), which is the correct behavior for:
 * - Missing files (no-op, no throw)
 * - Rejected inputs (no-op, no throw — prevents arbitrary path resolution)
 */
describe('FileStorage.deleteFile — LOCK-003 secure path validation (via shared validator)', () => {
  // ──────────────────────────────────────────────────────────────────────
  // Rejection: non-string input (deleteFile would no-op)
  // ──────────────────────────────────────────────────────────────────────
  describe('non-string input — deleteFile no-ops', () => {
    it('rejects undefined', async () => {
      expect(await validateStoredFilePath(filesDir, undefined as any)).toBe(null)
    })

    it('rejects null', async () => {
      expect(await validateStoredFilePath(filesDir, null as any)).toBe(null)
    })

    it('rejects number', async () => {
      expect(await validateStoredFilePath(filesDir, 42 as any)).toBe(null)
    })

    it('rejects empty string', async () => {
      expect(await validateStoredFilePath(filesDir, '')).toBe(null)
    })

    it('rejects boolean', async () => {
      expect(await validateStoredFilePath(filesDir, true as any)).toBe(null)
    })

    it('rejects object', async () => {
      expect(await validateStoredFilePath(filesDir, {} as any)).toBe(null)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Rejection: path separators (deleteFile would no-op)
  // ──────────────────────────────────────────────────────────────────────
  describe('path separators — deleteFile no-ops', () => {
    it('rejects forward slash', async () => {
      expect(await validateStoredFilePath(filesDir, 'sub/dir/file.txt')).toBe(null)
    })

    it('rejects backslash', async () => {
      expect(await validateStoredFilePath(filesDir, 'sub\\dir\\file.txt')).toBe(null)
    })

    it('rejects trailing slash', async () => {
      expect(await validateStoredFilePath(filesDir, 'file.txt/')).toBe(null)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Rejection: traversal (deleteFile would no-op — blocks path traversal)
  // ──────────────────────────────────────────────────────────────────────
  describe('traversal — deleteFile no-ops', () => {
    it('rejects ../../../etc/passwd', async () => {
      expect(await validateStoredFilePath(filesDir, '../../../etc/passwd')).toBe(null)
    })

    it('rejects dir/../file.txt', async () => {
      expect(await validateStoredFilePath(filesDir, 'dir/../file.txt')).toBe(null)
    })

    it('rejects file.txt/..', async () => {
      expect(await validateStoredFilePath(filesDir, 'file.txt/..')).toBe(null)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Rejection: absolute paths (deleteFile would no-op)
  // ──────────────────────────────────────────────────────────────────────
  describe('absolute paths — deleteFile no-ops', () => {
    it('rejects /etc/passwd', async () => {
      expect(await validateStoredFilePath(filesDir, '/etc/passwd')).toBe(null)
    })

    it('rejects /mock/userData/Data/Files/abc.txt', async () => {
      expect(await validateStoredFilePath(filesDir, '/mock/userData/Data/Files/abc.txt')).toBe(null)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Rejection: symlinks (deleteFile would no-op — prevents symlink attacks)
  // ──────────────────────────────────────────────────────────────────────
  describe('symlinks — deleteFile no-ops', () => {
    it('rejects symlink — does not resolve to target', async () => {
      const targetFile = realPath.join(filesDir, 'target.txt')
      await realFs.promises.writeFile(targetFile, 'hello')
      const linkPath = realPath.join(filesDir, 'link.txt')
      await realFs.promises.symlink(targetFile, linkPath)

      expect(await validateStoredFilePath(filesDir, 'link.txt')).toBe(null)
      // Target file should still exist (deleteFile would not have touched it)
      await realFs.promises.access(targetFile)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Rejection: directories (deleteFile would no-op — prevents rm -rf)
  // ──────────────────────────────────────────────────────────────────────
  describe('directories — deleteFile no-ops', () => {
    it('rejects directory — does not resolve directory path', async () => {
      const dirPath = realPath.join(filesDir, 'subdir')
      await realFs.promises.mkdir(dirPath)

      expect(await validateStoredFilePath(filesDir, 'subdir')).toBe(null)
      // Directory should still exist
      const stat = await realFs.promises.stat(dirPath)
      expect(stat.isDirectory()).toBe(true)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Acceptance: valid regular file (deleteFile would proceed to unlink)
  // ──────────────────────────────────────────────────────────────────────
  describe('valid regular file — deleteFile would unlink', () => {
    it('returns resolved path for regular file', async () => {
      const filePath = realPath.join(filesDir, 'abc123.txt')
      await realFs.promises.writeFile(filePath, 'content')

      const result = await validateStoredFilePath(filesDir, 'abc123.txt')
      expect(result).toBe(realPath.resolve(filesDir, 'abc123.txt'))
    })

    it('returns resolved path for UUID-named file', async () => {
      const filePath = realPath.join(filesDir, '550e8400-e29b-41d4-a716-446655440000.pdf')
      await realFs.promises.writeFile(filePath, 'pdf-content')

      const result = await validateStoredFilePath(filesDir, '550e8400-e29b-41d4-a716-446655440000.pdf')
      expect(result).toBe(realPath.resolve(filesDir, '550e8400-e29b-41d4-a716-446655440000.pdf'))
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Acceptance: missing file is success for delete (null = nothing to delete)
  // ──────────────────────────────────────────────────────────────────────
  describe('missing file — success for delete', () => {
    it('returns null when file does not exist (no-op, no throw)', async () => {
      expect(await validateStoredFilePath(filesDir, 'nonexistent.txt')).toBe(null)
    })
  })
})
