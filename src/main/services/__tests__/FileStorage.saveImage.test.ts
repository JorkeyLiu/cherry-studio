/**
 * FileStorage.saveImage — PNG destination contract.
 *
 * Without a third argument the native save dialog decides the destination
 * (legacy behavior: `${name}.png` default path, png extension filter, cancel
 * returns `false` without writing).
 *
 * With a non-empty directory the PNG is written straight into that directory
 * without a dialog (the same direct-write experience Markdown export offers for
 * its configured directory), keeping the `.png` suffix and the existing
 * filename-safe contract. Invalid directories and failed writes reject
 * explicitly — there is no silent fallback to the working directory.
 */

import type * as NodeFs from 'node:fs'
import type * as NodePath from 'node:path'

import type { Mock } from 'vitest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Real modules for temp directory management ---------------------------
const realFs = (await vi.importActual('node:fs')) as typeof NodeFs
const realPath = (await vi.importActual('node:path')) as typeof NodePath

// Created at module top, before the FileStorage singleton is constructed, so
// the electron app.getPath mock always resolves to a real directory.
const tempDir: string = realFs.mkdtempSync(realPath.join(realFs.realpathSync('/tmp'), 'save-image-test-'))

afterAll(() => {
  try {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  } catch {}
})

// Fixture directories are recreated per test so each case starts empty.
const exportDir = realPath.join(tempDir, 'export')
const plainFile = realPath.join(tempDir, 'not-a-directory')

const resetDirs = (): void => {
  realFs.rmSync(exportDir, { recursive: true, force: true })
  realFs.mkdirSync(exportDir, { recursive: true })
  realFs.writeFileSync(plainFile, 'plain file')
}

resetDirs()

// main.setup.ts stubs node:fs / node:path; restore the real implementations so
// the saveImage contract is exercised against a real temp directory.
vi.mock('node:fs', async () => await vi.importActual('node:fs'))
vi.mock('node:path', async () => await vi.importActual('node:path'))
// The dialog branch translates the filter label via t(); no i18n instance is
// initialized in main-process tests, so keep the key as the label.
vi.mock('@main/utils/locales', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@main/utils/locales')
  return { ...actual, t: (key: string) => key }
})

// --- Mocks ----------------------------------------------------------------
// main.setup.ts registers the electron stub that main-process code resolves, so
// point it at real temp directories and add the save-dialog stub it lacks
// (registering a second electron mock here would not reach FileStorage).
const electron = await import('electron')
electron.app.getPath = vi.fn((key: string) =>
  realPath.join(tempDir, `app-${key}`)
) as unknown as typeof electron.app.getPath

const electronDialog = electron.dialog as unknown as { showSaveDialogSync: Mock }
const mockShowSaveDialogSync = vi.fn()
electronDialog.showSaveDialogSync = mockShowSaveDialogSync

const { fileStorage } = await import('@main/services/FileStorage')

const event = {} as Electron.IpcMainInvokeEvent

const PNG_BYTES = Buffer.from('save-image-fixture-bytes')
const dataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`

beforeEach(() => {
  vi.clearAllMocks()
  resetDirs()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('FileStorage.saveImage — legacy dialog path (no defaultDirectory)', () => {
  it('writes the dialog-chosen path and reports success', async () => {
    const chosenPath = realPath.join(exportDir, 'dialog-choice.png')
    mockShowSaveDialogSync.mockReturnValue(chosenPath)

    await expect(fileStorage.saveImage(event, 'topic-title', dataUrl)).resolves.toBe(true)

    expect(mockShowSaveDialogSync).toHaveBeenCalledTimes(1)
    const options = mockShowSaveDialogSync.mock.calls[0][0]
    expect(options.defaultPath).toBe('topic-title.png')
    expect(options.filters).toEqual([{ name: expect.any(String), extensions: ['png'] }])
    expect(realFs.readFileSync(chosenPath).equals(PNG_BYTES)).toBe(true)
  })

  it('returns false on dialog cancel without writing anything', async () => {
    mockShowSaveDialogSync.mockReturnValue(undefined)

    await expect(fileStorage.saveImage(event, 'topic-title', dataUrl)).resolves.toBe(false)
    expect(mockShowSaveDialogSync).toHaveBeenCalledTimes(1)
    expect(realFs.readdirSync(exportDir)).toEqual([])
  })

  it('treats a blank third argument as absent and keeps the dialog behavior', async () => {
    const chosenPath = realPath.join(exportDir, 'dialog-choice.png')
    mockShowSaveDialogSync.mockReturnValue(chosenPath)

    await expect(fileStorage.saveImage(event, 'topic-title', dataUrl, '   ')).resolves.toBe(true)

    expect(mockShowSaveDialogSync).toHaveBeenCalledTimes(1)
    expect(realFs.readFileSync(chosenPath).equals(PNG_BYTES)).toBe(true)
  })
})

describe('FileStorage.saveImage — direct write into a specified directory', () => {
  it('writes the PNG into that directory with the .png suffix and no dialog', async () => {
    await expect(fileStorage.saveImage(event, 'topic-title', dataUrl, exportDir)).resolves.toBe(true)

    expect(mockShowSaveDialogSync).not.toHaveBeenCalled()
    const written = realPath.join(exportDir, 'topic-title.png')
    expect(realFs.readdirSync(exportDir)).toEqual(['topic-title.png'])
    expect(realFs.readFileSync(written).equals(PNG_BYTES)).toBe(true)
  })

  it('accepts a raw base64 payload and keeps it inside the directory via the filename guard', async () => {
    await expect(
      fileStorage.saveImage(event, '../../escape/title', PNG_BYTES.toString('base64'), exportDir)
    ).resolves.toBe(true)

    expect(mockShowSaveDialogSync).not.toHaveBeenCalled()
    const entries = realFs.readdirSync(exportDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].endsWith('.png')).toBe(true)
    expect(entries[0].includes('/')).toBe(false)
    expect(realFs.readFileSync(realPath.join(exportDir, entries[0])).equals(PNG_BYTES)).toBe(true)
    expect(realFs.existsSync(realPath.join(tempDir, 'escape'))).toBe(false)
  })

  it('rejects a missing directory instead of falling back to the working directory', async () => {
    const missing = realPath.join(tempDir, 'missing-dir')

    await expect(fileStorage.saveImage(event, 'topic-title', dataUrl, missing)).rejects.toThrow()

    expect(mockShowSaveDialogSync).not.toHaveBeenCalled()
    expect(realFs.existsSync(missing)).toBe(false)
    expect(realFs.existsSync(realPath.join(process.cwd(), 'topic-title.png'))).toBe(false)
  })

  it('rejects a path that is not a directory', async () => {
    await expect(fileStorage.saveImage(event, 'topic-title', dataUrl, plainFile)).rejects.toThrow()
    expect(mockShowSaveDialogSync).not.toHaveBeenCalled()
    expect(realFs.readFileSync(plainFile, 'utf8')).toBe('plain file')
  })

  it('rejects a failed write instead of reporting success', async () => {
    // A directory that occupies the target file name makes the write fail.
    realFs.mkdirSync(realPath.join(exportDir, 'topic-title.png'))

    await expect(fileStorage.saveImage(event, 'topic-title', dataUrl, exportDir)).rejects.toThrow()
    expect(mockShowSaveDialogSync).not.toHaveBeenCalled()
    expect(realFs.existsSync(realPath.join(process.cwd(), 'topic-title.png'))).toBe(false)
  })
})
