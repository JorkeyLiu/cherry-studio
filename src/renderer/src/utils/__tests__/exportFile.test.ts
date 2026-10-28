/**
 * Shared file-export write path (`utils/exportFile`).
 *
 * Two behaviors, selected only by the configured default directory:
 *   - `settings.exportPath === null` → the native save dialog decides the
 *     location per export, and a cancellation is reported honestly (`false`).
 *   - `settings.exportPath` set → the renderer joins the path itself (no Node
 *     `path` in the renderer) and the Main-process file IPC writes directly.
 *
 * A real write failure is never swallowed: it stays an error for the caller's
 * own handling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { storeState } = vi.hoisted(() => ({
  storeState: { current: { settings: { exportPath: null as string | null } } }
}))

vi.mock('@renderer/store', () => ({
  default: { getState: () => storeState.current }
}))

import { joinExportPath, saveExportFile, saveExportImage } from '../exportFile'

const fileSave = vi.fn()
const fileWrite = vi.fn()
const fileSaveImage = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  storeState.current = { settings: { exportPath: null } }
  fileSave.mockResolvedValue('/tmp/chosen.md')
  fileWrite.mockResolvedValue(undefined)
  fileSaveImage.mockResolvedValue(true)
  Object.defineProperty(window, 'api', {
    value: { file: { save: fileSave, write: fileWrite, saveImage: fileSaveImage } },
    configurable: true
  })
})

describe('joinExportPath', () => {
  it('joins a directory and a file name with a single separator', () => {
    expect(joinExportPath('/tmp/exports', 'a.md')).toBe('/tmp/exports/a.md')
  })

  it('normalizes trailing separators on the directory (both separators, repeated)', () => {
    expect(joinExportPath('/tmp/exports/', 'a.md')).toBe('/tmp/exports/a.md')
    expect(joinExportPath('/tmp/exports///', 'a.md')).toBe('/tmp/exports/a.md')
    expect(joinExportPath('/tmp/exports\\', 'a.md')).toBe('/tmp/exports/a.md')
    // Only the join boundary is normalized; interior separators are left as the
    // platform reported them, so both styles reach the Main-process write.
    expect(joinExportPath('C:\\Users\\me\\exports\\', 'a.md')).toBe('C:\\Users\\me\\exports/a.md')
  })

  it('normalizes a leading separator on the file name', () => {
    expect(joinExportPath('/tmp/exports', '/a.md')).toBe('/tmp/exports/a.md')
    expect(joinExportPath('/tmp/exports/', '\\a.md')).toBe('/tmp/exports/a.md')
  })

  it('keeps a Windows-style directory readable for the Main-process write', () => {
    expect(joinExportPath('C:\\Users\\me\\exports', 'a.md')).toBe('C:\\Users\\me\\exports/a.md')
  })
})

describe('saveExportFile without a default directory (native dialog)', () => {
  it('routes through the native save dialog and reports the saved path as success', async () => {
    const saved = await saveExportFile('a.md', 'content')

    expect(saved).toBe(true)
    expect(fileSave).toHaveBeenCalledWith('a.md', 'content')
    expect(fileWrite).not.toHaveBeenCalled()
  })

  it('reports a falsy dialog result as not saved (never a silent success)', async () => {
    fileSave.mockResolvedValue(undefined)

    await expect(saveExportFile('a.md', 'content')).resolves.toBe(false)
    expect(fileWrite).not.toHaveBeenCalled()
  })

  it('propagates a write failure to the caller', async () => {
    fileSave.mockRejectedValue(new Error('User canceled the save dialog'))

    await expect(saveExportFile('a.md', 'content')).rejects.toThrow('User canceled the save dialog')
  })
})

describe('saveExportFile with a default directory (direct write)', () => {
  beforeEach(() => {
    storeState.current = { settings: { exportPath: '/tmp/exports' } }
  })

  it('writes into the configured directory without opening the dialog', async () => {
    const saved = await saveExportFile('a.md', 'content')

    expect(saved).toBe(true)
    expect(fileWrite).toHaveBeenCalledWith('/tmp/exports/a.md', 'content')
    expect(fileSave).not.toHaveBeenCalled()
  })

  it('joins a directory that already ends with a separator once', async () => {
    storeState.current = { settings: { exportPath: '/tmp/exports/' } }

    await saveExportFile('a.md', 'content')

    expect(fileWrite).toHaveBeenCalledWith('/tmp/exports/a.md', 'content')
  })

  it('propagates a direct-write failure instead of reporting success', async () => {
    fileWrite.mockRejectedValue(new Error('EACCES'))

    await expect(saveExportFile('a.md', 'content')).rejects.toThrow('EACCES')
    expect(fileSave).not.toHaveBeenCalled()
  })
})

describe('saveExportImage', () => {
  it('passes no default directory when none is configured (dialog behavior unchanged)', async () => {
    await expect(saveExportImage('name', 'data:image/png;base64,AAAA')).resolves.toBe(true)

    expect(fileSaveImage).toHaveBeenCalledWith('name', 'data:image/png;base64,AAAA', undefined)
  })

  it('passes the configured directory as the third argument', async () => {
    storeState.current = { settings: { exportPath: '/tmp/exports' } }

    await saveExportImage('name', 'data:image/png;base64,AAAA')

    expect(fileSaveImage).toHaveBeenCalledWith('name', 'data:image/png;base64,AAAA', '/tmp/exports')
  })

  it('returns a cancellation as not saved', async () => {
    fileSaveImage.mockResolvedValue(false)

    await expect(saveExportImage('name', 'data:image/png;base64,AAAA')).resolves.toBe(false)
  })
})
