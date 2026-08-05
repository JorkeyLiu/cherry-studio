/**
 * FileAction.sortFiles — null created_at determinism (LOCK-BROWSE-3).
 *
 * Covers the file-browser sort boundary for catalog-imported rows whose
 * source `created_at` is null: the sort key must never be NaN and null rows
 * must land at one fixed end of either sort order. No timestamp is invented.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks (imports pulled by FileAction, kept out of the sort path) --------

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}))

vi.mock('@renderer/components/Popups/TextEditPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: { listBlocksByFile: vi.fn(), deleteBlocks: vi.fn() }
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: { getFile: vi.fn(), deleteFile: vi.fn() }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: vi.fn()
}))

import type { FileMetadata } from '@renderer/types'

import { createdAtSortKey, sortFiles } from '../FileAction'

function makeFile(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    id: 'f1',
    name: 'f1.txt',
    origin_name: 'notes.txt',
    path: '/files/f1.txt',
    size: 100,
    ext: '.txt',
    type: 'text',
    created_at: '2024-01-01T00:00:00.000Z',
    count: 1,
    ...overrides
  }
}

describe('createdAtSortKey (LOCK-BROWSE-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps null created_at to MIN_SAFE_INTEGER — never NaN', () => {
    const key = createdAtSortKey(makeFile({ created_at: null }))
    expect(key).toBe(Number.MIN_SAFE_INTEGER)
    expect(Number.isNaN(key)).toBe(false)
  })

  it('parses a valid ISO timestamp into a finite sort key', () => {
    const key = createdAtSortKey(makeFile({ created_at: '2024-06-15T12:30:00.000Z' }))
    expect(Number.isNaN(key)).toBe(false)
    expect(key).toBeGreaterThan(Number.MIN_SAFE_INTEGER)
  })

  it('degrades an unparseable stored value to the same fallback', () => {
    expect(createdAtSortKey(makeFile({ created_at: 'not-a-date' }))).toBe(Number.MIN_SAFE_INTEGER)
  })
})

describe('sortFiles — null created_at ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const newer = makeFile({
    id: 'b',
    name: 'b.txt',
    origin_name: 'b.txt',
    created_at: '2024-06-01T00:00:00.000Z',
    size: 300
  })
  const older = makeFile({
    id: 'c',
    name: 'c.txt',
    origin_name: 'c.txt',
    created_at: '2024-01-01T00:00:00.000Z',
    size: 200
  })
  const nullDate = makeFile({ id: 'a', name: 'a.txt', origin_name: 'a.txt', created_at: null, size: 100 })

  it('ascending order places null-date rows first, deterministically', () => {
    const sorted = sortFiles([newer, nullDate, older], 'created_at', 'asc')
    expect(sorted.map((f) => f.id)).toEqual(['a', 'c', 'b'])
  })

  it('descending order places null-date rows last, deterministically', () => {
    const sorted = sortFiles([newer, nullDate, older], 'created_at', 'desc')
    expect(sorted.map((f) => f.id)).toEqual(['b', 'c', 'a'])
  })

  it('all-null created_at rows keep a stable order (no NaN drift)', () => {
    const rows = [makeFile({ id: 'x', created_at: null }), makeFile({ id: 'y', created_at: null })]
    for (let i = 0; i < 5; i++) {
      const sorted = sortFiles([...rows].reverse(), 'created_at', 'desc')
      expect(sorted.map((f) => f.id)).toEqual(['y', 'x'])
    }
  })

  it('mixed null/valid rows never produce NaN orderings across repeated sorts', () => {
    const rows = [
      makeFile({ id: 'a', created_at: null }),
      makeFile({ id: 'b', created_at: '2024-05-05T00:00:00.000Z' }),
      makeFile({ id: 'c', created_at: '2023-01-01T00:00:00.000Z' }),
      makeFile({ id: 'd', created_at: null })
    ]
    for (let i = 0; i < 5; i++) {
      const asc = sortFiles(rows, 'created_at', 'asc')
      const desc = sortFiles(rows, 'created_at', 'desc')
      expect(asc.map((f) => f.id)).toEqual(['a', 'd', 'c', 'b'])
      expect(desc.map((f) => f.id)).toEqual(['b', 'c', 'a', 'd'])
    }
  })

  it('size and name sorts are unaffected by nullable created_at', () => {
    const rows = [newer, nullDate, older]
    expect(sortFiles(rows, 'size', 'desc').map((f) => f.id)).toEqual(['b', 'c', 'a'])
    expect(sortFiles(rows, 'name', 'asc').map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })
})
