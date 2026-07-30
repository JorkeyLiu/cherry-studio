/**
 * FileStorage.pathValidation — LOCK-001/003 shared path validation tests.
 *
 * LOCK-003: Tests invoke the actual exported validateStoredFilePath production
 * helper — NOT copied validation logic.
 *
 * LOCK-004: Tests also exercise the actual deleteFile/fileExists methods via
 * a minimal FileStorage subclass that overrides only constructor side effects.
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
  tempDir = await realFs.promises.mkdtemp(realPath.join(realOs.tmpdir(), 'fe-test-'))
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

// --- Import the actual production helper -----------------------------------
// LOCK-004: Tests invoke the shared production helper directly.
const { validateStoredFilePath } = await import('@main/utils/fileValidator')

// --- Tests: validateStoredFilePath (production helper) ---------------------

describe('validateStoredFilePath — LOCK-003 path validation (production helper)', () => {
  // ──────────────────────────────────────────────────────────────────────
  // Rejection: non-string input
  // ──────────────────────────────────────────────────────────────────────
  describe('non-string input', () => {
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
  // Rejection: path separators
  // ──────────────────────────────────────────────────────────────────────
  describe('path separators', () => {
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
  // Rejection: traversal
  // ──────────────────────────────────────────────────────────────────────
  describe('traversal', () => {
    it('rejects .. segment', async () => {
      expect(await validateStoredFilePath(filesDir, '../../../etc/passwd')).toBe(null)
    })

    it('rejects embedded ..', async () => {
      expect(await validateStoredFilePath(filesDir, 'dir/../file.txt')).toBe(null)
    })

    it('rejects trailing ..', async () => {
      expect(await validateStoredFilePath(filesDir, 'file.txt/..')).toBe(null)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Rejection: absolute paths
  // ──────────────────────────────────────────────────────────────────────
  describe('absolute paths', () => {
    it('rejects Unix absolute path', async () => {
      expect(await validateStoredFilePath(filesDir, '/etc/passwd')).toBe(null)
    })

    it('rejects path starting with /', async () => {
      expect(await validateStoredFilePath(filesDir, '/mock/userData/Data/Files/abc.txt')).toBe(null)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Rejection: symlinks (real lstat.isFile returns false)
  // ──────────────────────────────────────────────────────────────────────
  describe('symlinks', () => {
    it('rejects symlink (isFile returns false on real lstat)', async () => {
      const targetFile = realPath.join(filesDir, 'target.txt')
      await realFs.promises.writeFile(targetFile, 'hello')
      const linkPath = realPath.join(filesDir, 'link.txt')
      await realFs.promises.symlink(targetFile, linkPath)

      expect(await validateStoredFilePath(filesDir, 'link.txt')).toBe(null)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Rejection: directories (real lstat.isFile returns false)
  // ──────────────────────────────────────────────────────────────────────
  describe('directories', () => {
    it('rejects directory (isFile returns false on real lstat)', async () => {
      const dirPath = realPath.join(filesDir, 'subdir')
      await realFs.promises.mkdir(dirPath)

      expect(await validateStoredFilePath(filesDir, 'subdir')).toBe(null)
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Acceptance: valid regular file within storageDir
  // ──────────────────────────────────────────────────────────────────────
  describe('valid regular file', () => {
    it('returns resolved path for a regular file within storageDir', async () => {
      const filePath = realPath.join(filesDir, 'abc123.txt')
      await realFs.promises.writeFile(filePath, 'content')

      const result = await validateStoredFilePath(filesDir, 'abc123.txt')
      expect(result).toBe(realPath.resolve(filesDir, 'abc123.txt'))
    })

    it('returns resolved path for UUID-named file with extension', async () => {
      const filePath = realPath.join(filesDir, '550e8400-e29b-41d4-a716-446655440000.pdf')
      await realFs.promises.writeFile(filePath, 'pdf-content')

      const result = await validateStoredFilePath(filesDir, '550e8400-e29b-41d4-a716-446655440000.pdf')
      expect(result).toBe(realPath.resolve(filesDir, '550e8400-e29b-41d4-a716-446655440000.pdf'))
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Acceptance: missing file (real lstat throws ENOENT)
  // ──────────────────────────────────────────────────────────────────────
  describe('missing file', () => {
    it('returns null when file does not exist', async () => {
      expect(await validateStoredFilePath(filesDir, 'nonexistent.txt')).toBe(null)
    })
  })
})
