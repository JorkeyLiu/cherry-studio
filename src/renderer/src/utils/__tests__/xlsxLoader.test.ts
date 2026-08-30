import type * as XLSX from '@e965/xlsx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type XLSXModule = typeof XLSX

function createLenientMock(fakeModule: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    ...(fakeModule as object),
    __esModule: true,
    default: fakeModule
  }
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return undefined
    },
    has() {
      return true
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) return Reflect.getOwnPropertyDescriptor(target, prop)
      return { configurable: true, enumerable: true, writable: true, value: undefined }
    },
    ownKeys(target) {
      return Reflect.ownKeys(target)
    }
  })
}

describe('xlsxLoader - S7.5 lazy @e965/xlsx', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('does not evaluate @e965/xlsx on loader import, only after loadXLSX', async () => {
    const fakeModule = {
      utils: {
        aoa_to_sheet: vi.fn(() => ({})),
        book_new: vi.fn(() => ({})),
        book_append_sheet: vi.fn()
      },
      write: vi.fn(() => new Uint8Array([1, 2, 3]))
    }
    let factoryCallCount = 0
    vi.doMock('@e965/xlsx', () => {
      factoryCallCount += 1
      return createLenientMock(fakeModule as unknown as Record<string, unknown>) as unknown as XLSXModule
    })

    const { loadXLSX } = await import('../xlsxLoader')
    expect(factoryCallCount).toBe(0)

    const mod = await loadXLSX()
    expect(factoryCallCount).toBe(1)
    expect((mod as unknown as typeof fakeModule).utils).toBe(fakeModule.utils)
  })

  it('exportExcel has no static runtime import - loader is the only boundary', async () => {
    const fakeModule = {
      utils: {
        aoa_to_sheet: vi.fn(() => ({})),
        book_new: vi.fn(() => ({})),
        book_append_sheet: vi.fn()
      },
      write: vi.fn(() => new Uint8Array([1, 2, 3]))
    }
    let factoryCallCount = 0
    vi.doMock('@e965/xlsx', () => {
      factoryCallCount += 1
      return createLenientMock(fakeModule as unknown as Record<string, unknown>) as unknown as XLSXModule
    })

    const exportMod = await import('../exportExcel')
    expect(factoryCallCount).toBe(0)

    exportMod.parseMarkdownTable('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(factoryCallCount).toBe(0)
  })

  it('loadXLSX resolves to module on success', async () => {
    const fakeModule = {
      utils: {
        aoa_to_sheet: vi.fn(() => ({})),
        book_new: vi.fn(() => ({})),
        book_append_sheet: vi.fn()
      },
      write: vi.fn(() => new Uint8Array([1, 2, 3]))
    }
    vi.doMock(
      '@e965/xlsx',
      () => createLenientMock(fakeModule as unknown as Record<string, unknown>) as unknown as XLSXModule
    )

    const { loadXLSX } = await import('../xlsxLoader')
    const mod = await loadXLSX()
    expect((mod as unknown as typeof fakeModule).utils).toBe(fakeModule.utils)
  })

  it('deduplicates concurrent loads - same promise and single import invocation', async () => {
    const fakeModule = {
      utils: { aoa_to_sheet: vi.fn(), book_new: vi.fn(), book_append_sheet: vi.fn() },
      write: vi.fn()
    }
    let factoryCallCount = 0
    vi.doMock('@e965/xlsx', () => {
      factoryCallCount += 1
      return createLenientMock(fakeModule as unknown as Record<string, unknown>) as unknown as XLSXModule
    })

    const { loadXLSX } = await import('../xlsxLoader')

    const p1 = loadXLSX()
    const p2 = loadXLSX()
    expect(p1).toBe(p2)

    const [m1, m2] = await Promise.all([p1, p2])
    expect(factoryCallCount).toBe(1)
    expect((m1 as unknown as typeof fakeModule).utils).toBe(fakeModule.utils)
    expect((m2 as unknown as typeof fakeModule).utils).toBe(fakeModule.utils)
    expect(m1).toBe(m2)

    const p3 = await loadXLSX()
    expect((p3 as unknown as typeof fakeModule).utils).toBe(fakeModule.utils)
    expect(factoryCallCount).toBe(1)
  })

  it('deduplicates subsequent success without new import', async () => {
    const fakeModule = { utils: {}, write: vi.fn() }
    let factoryCallCount = 0
    vi.doMock('@e965/xlsx', () => {
      factoryCallCount += 1
      return createLenientMock(fakeModule as unknown as Record<string, unknown>) as unknown as XLSXModule
    })

    const { loadXLSX } = await import('../xlsxLoader')

    const first = await loadXLSX()
    expect((first as unknown as typeof fakeModule).write).toBe(fakeModule.write)
    expect(factoryCallCount).toBe(1)

    const second = await loadXLSX()
    expect(second).toBe(first)
    expect(factoryCallCount).toBe(1)

    const third = await loadXLSX()
    expect(third).toBe(first)
    expect(factoryCallCount).toBe(1)
  })

  it('rejection does not poison cache - same loader instance retries and succeeds', async () => {
    const fakeModule = { utils: {}, write: vi.fn() }
    let attempt = 0
    vi.doMock('@e965/xlsx', () => {
      attempt += 1
      if (attempt === 1) throw new Error('chunk load failed')
      return createLenientMock(fakeModule as unknown as Record<string, unknown>) as unknown as XLSXModule
    })

    const { loadXLSX } = await import('../xlsxLoader')
    await expect(loadXLSX()).rejects.toThrow()
    expect(attempt).toBe(1)

    const mod = await loadXLSX()
    expect(attempt).toBe(2)
    expect((mod as unknown as typeof fakeModule).write).toBe(fakeModule.write)

    const again = await loadXLSX()
    expect(again).toBe(mod)
    expect(attempt).toBe(2)
  })

  it('concurrent rejection shares same rejected promise and same loader instance allows retry', async () => {
    const fakeModule = { utils: {}, write: vi.fn() }
    let attempts = 0
    vi.doMock('@e965/xlsx', () => {
      attempts += 1
      if (attempts === 1) throw new Error('network chunk error')
      return createLenientMock(fakeModule as unknown as Record<string, unknown>) as unknown as XLSXModule
    })

    const { loadXLSX } = await import('../xlsxLoader')

    const p1 = loadXLSX()
    const p2 = loadXLSX()
    expect(p1).toBe(p2)
    p2.catch(() => {})

    await expect(p1).rejects.toThrow()
    expect(attempts).toBe(1)

    const retry = await loadXLSX()
    expect(attempts).toBe(2)
    expect((retry as unknown as typeof fakeModule).write).toBe(fakeModule.write)

    const cached = await loadXLSX()
    expect(cached).toBe(retry)
    expect(attempts).toBe(2)
  })

  it('loader reset via module re-import allows fresh import', async () => {
    const fakeModule1 = { utils: {}, write: vi.fn(), tag: 1 }
    const fakeModule2 = { utils: {}, write: vi.fn(), tag: 2 }

    vi.doMock(
      '@e965/xlsx',
      () => createLenientMock(fakeModule1 as unknown as Record<string, unknown>) as unknown as XLSXModule
    )

    const { loadXLSX: loadA } = await import('../xlsxLoader')
    const first = await loadA()
    expect((first as unknown as typeof fakeModule1).tag).toBe(1)

    vi.resetModules()
    vi.doMock(
      '@e965/xlsx',
      () => createLenientMock(fakeModule2 as unknown as Record<string, unknown>) as unknown as XLSXModule
    )

    const { loadXLSX: loadB } = await import('../xlsxLoader')
    const second = await loadB()
    expect((second as unknown as typeof fakeModule2).tag).toBe(2)
    expect((second as unknown as typeof fakeModule1).tag).not.toBe((first as unknown as typeof fakeModule1).tag)
  })
})
