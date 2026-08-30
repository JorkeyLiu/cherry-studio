import type * as XLSX from '@e965/xlsx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type XLSXModule = typeof XLSX

const mocks = vi.hoisted(() => {
  const utils = {
    aoa_to_sheet: vi.fn(() => ({})),
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn()
  }
  const write = vi.fn(() => new Uint8Array([9, 7, 5]))
  const fakeXlsxModule = { utils, write }
  return {
    fakeXlsxModule,
    utils,
    write,
    loadXLSX: vi.fn(() => Promise.resolve(fakeXlsxModule as unknown as XLSXModule)),
    selectFolder: vi.fn(),
    writeFile: vi.fn(),
    dayjsFormat: vi.fn(() => '2024-01-15_123456')
  }
})

vi.mock('../xlsxLoader', () => ({
  loadXLSX: mocks.loadXLSX
}))

vi.mock('dayjs', () => ({
  default: Object.assign(() => ({ format: mocks.dayjsFormat }), { format: mocks.dayjsFormat })
}))

// Ensure global window.api exists for exportExcel
const ensureWindowApi = () => {
  // @ts-ignore
  global.window = global.window || {}
  // @ts-ignore
  global.window.api = global.window.api || {}
  // @ts-ignore
  global.window.api.file = global.window.api.file || {}
  // @ts-ignore
  global.window.api.file.selectFolder = mocks.selectFolder
  // @ts-ignore
  global.window.api.file.write = mocks.writeFile
}

describe('exportTableToExcel - S7.5 lazy @e965/xlsx boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureWindowApi()
    // reset module mock to success by default
    mocks.loadXLSX.mockResolvedValue(mocks.fakeXlsxModule as unknown as XLSXModule)
    mocks.selectFolder.mockResolvedValue('/tmp')
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.utils.aoa_to_sheet.mockReturnValue({} as unknown as ReturnType<typeof mocks.utils.aoa_to_sheet>)
    mocks.utils.book_new.mockReturnValue({} as unknown as ReturnType<typeof mocks.utils.book_new>)
    mocks.write.mockReturnValue(new Uint8Array([9, 7, 5]))
  })

  it('does not trigger XLSX load when only parseMarkdownTable is used', async () => {
    const { parseMarkdownTable } = await import('../exportExcel')
    mocks.loadXLSX.mockClear()
    const data = parseMarkdownTable('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(data).toEqual([
      ['A', 'B'],
      ['1', '2']
    ])
    expect(mocks.loadXLSX).not.toHaveBeenCalled()
  })

  it('lazy trigger: loadXLSX only when export is invoked, not on module import', async () => {
    mocks.loadXLSX.mockClear()
    const { exportTableToExcel } = await import('../exportExcel')
    expect(mocks.loadXLSX).not.toHaveBeenCalled()
    mocks.selectFolder.mockResolvedValue('/tmp')
    await exportTableToExcel('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(mocks.loadXLSX).toHaveBeenCalledTimes(1)
  })

  it('returns false without loading XLSX when markdown has no valid table', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    mocks.loadXLSX.mockClear()
    const result = await exportTableToExcel('not a table')
    expect(result).toBe(false)
    expect(mocks.loadXLSX).not.toHaveBeenCalled()
    expect(mocks.selectFolder).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('returns false without writing when markdown is empty', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    const result = await exportTableToExcel('')
    expect(result).toBe(false)
    expect(mocks.loadXLSX).not.toHaveBeenCalled()
  })

  it('successful export creates workbook, selects folder, writes file with exact filename and bytes and !cols', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    const mockedBytes = new Uint8Array([9, 7, 5])
    mocks.write.mockReturnValue(mockedBytes)
    const markdown = '| Name | Age |\n|---|---|\n| Alice | 30 |'
    const result = await exportTableToExcel(markdown)

    expect(result).toBe(true)
    expect(mocks.loadXLSX).toHaveBeenCalledTimes(1)
    expect(mocks.utils.aoa_to_sheet).toHaveBeenCalledWith([
      ['Name', 'Age'],
      ['Alice', '30']
    ])
    expect(mocks.utils.book_new).toHaveBeenCalled()
    expect(mocks.utils.book_append_sheet).toHaveBeenCalled()
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), { type: 'array', bookType: 'xlsx' })
    expect(mocks.selectFolder).toHaveBeenCalledWith({ title: 'Select folder to save Excel file' })
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    const writtenPath = mocks.writeFile.mock.calls[0][0] as string
    expect(writtenPath).toBe('/tmp/table_2024-01-15_123456.xlsx')
    const writtenData = mocks.writeFile.mock.calls[0][1] as Uint8Array
    expect(writtenData).toBeInstanceOf(Uint8Array)
    expect(Array.from(writtenData)).toEqual(Array.from(mockedBytes))
    expect(mocks.dayjsFormat).toHaveBeenCalledWith('YYYY-MM-DD_HHmmss')

    // Worksheet !cols metadata: Name(4)/Alice(5) => max 5 => wch 10; Age(3)/30(2) => 10
    const appendedSheet = mocks.utils.book_append_sheet.mock.calls[0][1] as Record<string, unknown>
    expect(appendedSheet['!cols']).toEqual([{ wch: 10 }, { wch: 10 }])
  })

  it('handles folder-selection cancellation (null) without writing', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    mocks.selectFolder.mockResolvedValue(null)
    const result = await exportTableToExcel('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(result).toBe(false)
    expect(mocks.loadXLSX).toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('handles folder-selection cancellation (undefined/empty string) without writing', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    mocks.selectFolder.mockResolvedValue(undefined)
    let result = await exportTableToExcel('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(result).toBe(false)
    expect(mocks.writeFile).not.toHaveBeenCalled()

    mocks.selectFolder.mockResolvedValue('')
    result = await exportTableToExcel('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(result).toBe(false)
  })

  it('propagates file-write failure as thrown error with file path context', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    const writeError = new Error('disk full')
    mocks.writeFile.mockRejectedValue(writeError)
    mocks.selectFolder.mockResolvedValue('/tmp')

    await expect(exportTableToExcel('| A | B |\n|---|---|\n| 1 | 2 |')).rejects.toThrow(/Failed to write Excel file/)
    expect(mocks.writeFile).toHaveBeenCalled()
    // Validate exact path in error message includes fixed filename
    await expect(exportTableToExcel('| A | B |\n|---|---|\n| 1 | 2 |')).rejects.toThrow(
      '/tmp/table_2024-01-15_123456.xlsx'
    )
  })

  it('propagates XLSX load failure to caller (allows Table to show error toast)', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    const loadError = new Error('chunk load failed')
    mocks.loadXLSX.mockRejectedValue(loadError)

    await expect(exportTableToExcel('| A | B |\n|---|---|\n| 1 | 2 |')).rejects.toBe(loadError)
    expect(mocks.selectFolder).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('normalizes default-only module shape { default: fakeXlsxModule } via resolveXLSX', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    const defaultOnlyModule = {
      default: mocks.fakeXlsxModule
    } as unknown as XLSXModule
    mocks.loadXLSX.mockResolvedValueOnce(defaultOnlyModule)
    mocks.selectFolder.mockResolvedValue('/tmp')

    const result = await exportTableToExcel('| A | B |\n|---|---|\n| 1 | 2 |')

    expect(result).toBe(true)
    expect(mocks.loadXLSX).toHaveBeenCalledTimes(1)
    expect(mocks.utils.aoa_to_sheet).toHaveBeenCalledWith([
      ['A', 'B'],
      ['1', '2']
    ])
    expect(mocks.utils.book_new).toHaveBeenCalled()
    expect(mocks.utils.book_append_sheet).toHaveBeenCalled()
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), { type: 'array', bookType: 'xlsx' })
    expect(mocks.selectFolder).toHaveBeenCalledWith({ title: 'Select folder to save Excel file' })
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    expect(mocks.writeFile.mock.calls[0][0]).toBe('/tmp/table_2024-01-15_123456.xlsx')
  })

  it('concurrent export calls each invoke loadXLSX and both succeed (loader dedup verified separately in xlsxLoader tests)', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    let resolveLoad!: (v: typeof mocks.fakeXlsxModule) => void
    const deferred = new Promise<typeof mocks.fakeXlsxModule>((res) => {
      resolveLoad = res
    })
    mocks.loadXLSX.mockReturnValue(deferred as unknown as Promise<XLSXModule>)
    mocks.selectFolder.mockResolvedValue('/tmp')

    const markdown = '| A | B |\n|---|---|\n| 1 | 2 |'
    const p1 = exportTableToExcel(markdown)
    const p2 = exportTableToExcel(markdown)
    expect(mocks.loadXLSX).toHaveBeenCalledTimes(2)

    resolveLoad(mocks.fakeXlsxModule as unknown as typeof mocks.fakeXlsxModule)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(true)
    expect(r2).toBe(true)
  })

  it('writes correct column widths for varied header lengths and uses XLSX utils', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    mocks.selectFolder.mockResolvedValue('/chosen')
    const mockedBytes = new Uint8Array([1, 2, 3, 4, 5, 6])
    mocks.write.mockReturnValue(mockedBytes)
    const markdown = '| Short | VeryLongHeaderName |\n|---|---|\n| x | y |'
    await exportTableToExcel(markdown)
    const appendedSheet = mocks.utils.book_append_sheet.mock.calls[0][1] as Record<string, unknown>
    // Short(5)/x(1) => wch 10; VeryLongHeaderName(18)/y(1) => 18+2=20
    expect(appendedSheet['!cols']).toEqual([{ wch: 10 }, { wch: 20 }])
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), { type: 'array', bookType: 'xlsx' })
    const writtenData = mocks.writeFile.mock.calls[0][1] as Uint8Array
    expect(Array.from(writtenData)).toEqual(Array.from(mockedBytes))
    expect(mocks.writeFile.mock.calls[0][0]).toBe('/chosen/table_2024-01-15_123456.xlsx')
  })

  it('caps column widths at 50 and floors at 10', async () => {
    const { exportTableToExcel } = await import('../exportExcel')
    mocks.selectFolder.mockResolvedValue('/tmp')
    const longCell = 'a'.repeat(100)
    const markdown = `| ${longCell} | B |\n|---|---|\n| x | y |`
    await exportTableToExcel(markdown)
    const appendedSheet = mocks.utils.book_append_sheet.mock.calls[0][1] as Record<string, unknown>
    const cols = appendedSheet['!cols'] as { wch: number }[]
    expect(cols[0].wch).toBe(50)
    expect(cols[1].wch).toBe(10)
  })
})
