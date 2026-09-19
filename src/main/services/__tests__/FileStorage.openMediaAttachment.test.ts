/**
 * FileStorage.openMediaAttachment — narrow secure open for the in-app
 * audio/video preview's "open with default app" action.
 *
 * Stored branch: `id + ext` resolved inside storageDir through the shared
 * production `validateStoredFilePath` helper (absolute / traversal / symlink
 * / directory rejected; regular file required).
 *
 * External branch: only a realpath previously registered by this process via
 * `selectFile` / `getFile` is honored; unregistered paths are rejected and
 * can never form a generic arbitrary-path capability.
 *
 * A non-empty `shell.openPath` error string rejects so the renderer can
 * surface the existing preview error. The legacy generic `openPath` semantics
 * are covered as unchanged.
 */

import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import type * as NodePath from 'node:path'

import type { Mock } from 'vitest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Real modules for temp directory management ---------------------------
const realFs = (await vi.importActual('node:fs')) as typeof NodeFs
const realOs = (await vi.importActual('node:os')) as typeof NodeOs
const realPath = (await vi.importActual('node:path')) as typeof NodePath

// --- Bounded temp storage ------------------------------------------------
// Created synchronously at module top (before the FileStorage singleton is
// constructed on import) so the electron app.getPath mock always resolves to
// a real directory — never a mock placeholder.
const tempDir: string = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'media-open-test-'))
const filesDir: string = realPath.join(tempDir, 'Files')
const externalDir: string = realPath.join(tempDir, 'external')
realFs.mkdirSync(filesDir, { recursive: true })
realFs.mkdirSync(externalDir, { recursive: true })

afterEach(async () => {
  for (const dir of [filesDir, externalDir]) {
    try {
      const entries = await realFs.promises.readdir(dir)
      for (const entry of entries) {
        const fullPath = realPath.join(dir, entry)
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
  }
})

afterAll(async () => {
  try {
    await realFs.promises.rm(tempDir, { recursive: true, force: true })
  } catch {}
})

// --- Mocks ----------------------------------------------------------------
// Override the main.setup.ts fs/path mocks with real implementations so the
// production validation (lstat/realpath/stat) exercises the real filesystem.
vi.mock('node:fs', async () => {
  return await vi.importActual('node:fs')
})
vi.mock('node:path', async () => {
  return await vi.importActual('node:path')
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === 'userData') return tempDir
      if (key === 'temp') return realPath.join(tempDir, 'temp')
      return '/mock/unknown'
    }),
    getVersion: vi.fn(() => '1.0.0')
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
  session: { defaultSession: { clearCache: vi.fn(), clearStorageData: vi.fn() } },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: vi.fn() },
  net: { fetch: vi.fn() }
}))

const { fileStorage } = await import('@main/services/FileStorage')
const electron = await import('electron')
const mockOpenPath = (electron as unknown as { shell: { openPath: Mock } }).shell.openPath
const mockShowOpenDialog = (electron as unknown as { dialog: { showOpenDialog: Mock } }).dialog.showOpenDialog

const { isSupportedMediaAttachmentExt } = await import('@shared/mediaAttachment')

const event = {} as Electron.IpcMainInvokeEvent

const resetExternalRegistry = () => {
  const registry = (fileStorage as unknown as { externalMediaAllowedPaths: Set<string> }).externalMediaAllowedPaths
  registry.clear()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockOpenPath.mockResolvedValue('')
  resetExternalRegistry()
  // Point the singleton at the bounded temp storage for this suite.
  ;(fileStorage as unknown as { storageDir: string }).storageDir = filesDir
})

describe('FileStorage.openMediaAttachment — stored branch', () => {
  it('opens a managed file resolved inside storageDir by id + ext', async () => {
    await realFs.promises.writeFile(realPath.join(filesDir, 'uuid-1.mp3'), 'audio')
    await fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: 'uuid-1.mp3' })
    expect(mockOpenPath).toHaveBeenCalledTimes(1)
    expect(mockOpenPath).toHaveBeenCalledWith(realPath.resolve(filesDir, 'uuid-1.mp3'))
  })

  it('rejects traversal without touching shell', async () => {
    await expect(
      fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: '../secret.mp3' })
    ).rejects.toThrow()
    await expect(
      fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: 'sub/dir/a.mp3' })
    ).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('rejects absolute paths without touching shell', async () => {
    await expect(
      fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: '/etc/passwd' })
    ).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('rejects symlinks inside storageDir', async () => {
    const target = realPath.join(externalDir, 'target.mp3')
    await realFs.promises.writeFile(target, 'audio')
    await realFs.promises.symlink(target, realPath.join(filesDir, 'link.mp3'))
    await expect(
      fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: 'link.mp3' })
    ).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('rejects directories', async () => {
    await realFs.promises.mkdir(realPath.join(filesDir, 'adir'))
    await expect(fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: 'adir' })).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('rejects missing managed files instead of building a dangling path', async () => {
    await expect(
      fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: 'gone.mp3' })
    ).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('rejects malformed requests', async () => {
    await expect(fileStorage.openMediaAttachment(event, undefined as any)).rejects.toThrow()
    await expect(
      fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: '' } as any)
    ).rejects.toThrow()
    // A stored request smuggling a resolved path field is not a valid shape.
    await expect(
      fileStorage.openMediaAttachment(event, { kind: 'stored', filePath: '/etc/passwd' } as any)
    ).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('propagates a non-empty shell.openPath error string as a rejection', async () => {
    await realFs.promises.writeFile(realPath.join(filesDir, 'uuid-2.mp4'), 'video')
    mockOpenPath.mockResolvedValue('operation failed')
    await expect(
      fileStorage.openMediaAttachment(event, { kind: 'stored', storedFileName: 'uuid-2.mp4' })
    ).rejects.toThrow('operation failed')
  })
})

describe('FileStorage.openMediaAttachment — external branch', () => {
  it('opens a path registered by getFile (drag-drop) in this process', async () => {
    const externalFile = realPath.join(externalDir, 'song.mp3')
    await realFs.promises.writeFile(externalFile, 'audio')
    const meta = await fileStorage.getFile(event, externalFile)
    expect(meta).not.toBeNull()

    await fileStorage.openMediaAttachment(event, { kind: 'external', filePath: externalFile })
    expect(mockOpenPath).toHaveBeenCalledTimes(1)
    expect(mockOpenPath).toHaveBeenCalledWith(await realFs.promises.realpath(externalFile))
  })

  it('rejects an existing but never-registered external path', async () => {
    const externalFile = realPath.join(externalDir, 'stranger.mp3')
    await realFs.promises.writeFile(externalFile, 'audio')
    await expect(fileStorage.openMediaAttachment(event, { kind: 'external', filePath: externalFile })).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('rejects a registered path whose file disappeared afterwards', async () => {
    const externalFile = realPath.join(externalDir, 'temp.mp3')
    await realFs.promises.writeFile(externalFile, 'audio')
    await fileStorage.getFile(event, externalFile)
    await realFs.promises.unlink(externalFile)
    await expect(fileStorage.openMediaAttachment(event, { kind: 'external', filePath: externalFile })).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('propagates a non-empty shell.openPath error string as a rejection', async () => {
    const externalFile = realPath.join(externalDir, 'clip.mp4')
    await realFs.promises.writeFile(externalFile, 'video')
    await fileStorage.getFile(event, externalFile)
    mockOpenPath.mockResolvedValue('no app associated')
    await expect(fileStorage.openMediaAttachment(event, { kind: 'external', filePath: externalFile })).rejects.toThrow(
      'no app associated'
    )
  })
})

describe('FileStorage.openMediaAttachment — F1 external media allow-set', () => {
  it('does not register a non-media path returned by getFile', async () => {
    const externalFile = realPath.join(externalDir, 'notes.txt')
    await realFs.promises.writeFile(externalFile, 'text')
    expect(isSupportedMediaAttachmentExt(realPath.extname(externalFile))).toBe(false)

    const meta = await fileStorage.getFile(event, externalFile)
    expect(meta).not.toBeNull()

    const registry = (fileStorage as unknown as { externalMediaAllowedPaths: Set<string> }).externalMediaAllowedPaths
    expect(registry.size).toBe(0)

    await expect(fileStorage.openMediaAttachment(event, { kind: 'external', filePath: externalFile })).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('does not register a non-media path returned by selectFile', async () => {
    const externalFile = realPath.join(externalDir, 'report.pdf')
    await realFs.promises.writeFile(externalFile, 'pdf')
    expect(isSupportedMediaAttachmentExt(realPath.extname(externalFile))).toBe(false)
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: [externalFile] })

    const result = await fileStorage.selectFile(event)
    expect(result).not.toBeNull()
    expect(result?.[0]?.path).toBe(externalFile)

    const registry = (fileStorage as unknown as { externalMediaAllowedPaths: Set<string> }).externalMediaAllowedPaths
    expect(registry.size).toBe(0)

    await expect(fileStorage.openMediaAttachment(event, { kind: 'external', filePath: externalFile })).rejects.toThrow()
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('rejects a forged non-media external request even when the realpath was injected', async () => {
    const externalFile = realPath.join(externalDir, 'evil.txt')
    await realFs.promises.writeFile(externalFile, 'text')
    expect(isSupportedMediaAttachmentExt(realPath.extname(externalFile))).toBe(false)

    const real = await realFs.promises.realpath(externalFile)
    const registry = (fileStorage as unknown as { externalMediaAllowedPaths: Set<string> }).externalMediaAllowedPaths
    registry.add(real)

    await expect(fileStorage.openMediaAttachment(event, { kind: 'external', filePath: externalFile })).rejects.toThrow(
      /not supported/
    )
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  it('allows a supported media extension with uppercase letters', async () => {
    const externalFile = realPath.join(externalDir, 'SONG.MP3')
    await realFs.promises.writeFile(externalFile, 'audio')
    expect(isSupportedMediaAttachmentExt(realPath.extname(externalFile))).toBe(true)

    const meta = await fileStorage.getFile(event, externalFile)
    expect(meta).not.toBeNull()

    await fileStorage.openMediaAttachment(event, { kind: 'external', filePath: externalFile })
    expect(mockOpenPath).toHaveBeenCalledTimes(1)
    expect(mockOpenPath).toHaveBeenCalledWith(await realFs.promises.realpath(externalFile))
  })
})

describe('FileStorage.openPath — legacy semantics unchanged', () => {
  it('still resolves void on success and throws the error string on failure', async () => {
    await expect(fileStorage.openPath(event, '/mock/files/a.txt')).resolves.toBeUndefined()
    mockOpenPath.mockResolvedValue('failed')
    await expect(fileStorage.openPath(event, '/mock/files/a.txt')).rejects.toThrow('failed')
  })
})
