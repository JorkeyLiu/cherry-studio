/**
 * zipIntake tests.
 *
 * IMPORTANT: main.setup.ts globally mocks node:fs, node:os, node:path.
 * We override with real implementations using importActual inside vi.mock factories.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs')
  return { ...actual, default: actual }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os')
  return { ...actual, default: actual }
})

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path')
  return { ...actual, default: actual }
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import StreamZip from 'node-stream-zip'

import { ChatImportZipError } from '../errors'
import {
  MAX_ENTRY_COUNT,
  MAX_SINGLE_ENTRY_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ZIP_SIZE_BYTES,
  sanitizeEntryNameForMessage,
  validateEntries,
  validateFileStat,
  validateIndexedDbStructure,
  validateNoZipSlip
} from '../zipIntake'

describe('zipIntake', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipintake-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('constants', () => {
    it('MAX_ZIP_SIZE_BYTES is 500 MB', () => {
      expect(MAX_ZIP_SIZE_BYTES).toBe(500 * 1024 * 1024)
    })

    it('MAX_ENTRY_COUNT is 10000', () => {
      expect(MAX_ENTRY_COUNT).toBe(10_000)
    })

    it('MAX_SINGLE_ENTRY_BYTES is 200 MB', () => {
      expect(MAX_SINGLE_ENTRY_BYTES).toBe(200 * 1024 * 1024)
    })

    it('MAX_TOTAL_UNCOMPRESSED_BYTES is 2 GB', () => {
      expect(MAX_TOTAL_UNCOMPRESSED_BYTES).toBe(2 * 1024 * 1024 * 1024)
    })
  })

  describe('validateFileStat', () => {
    it('rejects non-existent file', async () => {
      await expect(validateFileStat('/nonexistent/path/file.zip')).rejects.toThrow(ChatImportZipError)
      await expect(validateFileStat('/nonexistent/path/file.zip')).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND'
      })
    })

    it('rejects a directory', async () => {
      await expect(validateFileStat(tempDir)).rejects.toThrow(ChatImportZipError)
      await expect(validateFileStat(tempDir)).rejects.toMatchObject({
        code: 'NOT_A_FILE'
      })
    })

    it('accepts a valid small file', async () => {
      const filePath = path.join(tempDir, 'small.zip')
      fs.writeFileSync(filePath, 'test')

      await expect(validateFileStat(filePath)).resolves.not.toThrow()
    })
  })

  describe('validateIndexedDbStructure', () => {
    it('rejects when IndexedDB directory is missing', () => {
      expect(() => validateIndexedDbStructure(tempDir)).toThrow(ChatImportZipError)
      expect(() => validateIndexedDbStructure(tempDir)).toThrow(/NO_INDEXED_DB/)
    })

    it('rejects when IndexedDB path is a file, not a directory', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      fs.writeFileSync(indexedDbPath, 'not a directory')

      expect(() => validateIndexedDbStructure(tempDir)).toThrow(ChatImportZipError)
    })

    it('rejects when IndexedDB has no subdirs with .ldb files', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'some-origin')
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, 'other-file.txt'), 'data')

      expect(() => validateIndexedDbStructure(tempDir)).toThrow(ChatImportZipError)
      expect(() => validateIndexedDbStructure(tempDir)).toThrow(/NO_INDEXED_DB/)
    })

    it('accepts when IndexedDB has a subdir with .ldb files', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'file__0.indexeddb.leveldb')
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'leveldb data')
      fs.writeFileSync(path.join(subdir, 'MANIFEST-000001'), 'manifest')

      const result = validateIndexedDbStructure(tempDir)
      expect(result).toBe(indexedDbPath)
    })

    it('accepts any subdir name with .ldb files (not hardcoded)', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'https___example.com_0.indexeddb.leveldb')
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      const result = validateIndexedDbStructure(tempDir)
      expect(result).toBe(indexedDbPath)
    })

    it('accepts when multiple subdirs exist and one has .ldb', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const emptyDir = path.join(indexedDbPath, 'empty-origin')
      fs.mkdirSync(emptyDir, { recursive: true })

      const validDir = path.join(indexedDbPath, 'valid-origin')
      fs.mkdirSync(validDir, { recursive: true })
      fs.writeFileSync(path.join(validDir, '000001.ldb'), 'data')

      const result = validateIndexedDbStructure(tempDir)
      expect(result).toBe(indexedDbPath)
    })
  })

  describe('ChatImportZipError', () => {
    it('carries a machine-readable code', () => {
      const error = new ChatImportZipError('TOO_LARGE', 'file too big')
      expect(error.code).toBe('TOO_LARGE')
      expect(error.name).toBe('ChatImportZipError')
    })

    it('sanitizes paths from messages', () => {
      const error = new ChatImportZipError('PATH_TRAVERSAL', 'entry resolves outside')
      expect(error.message).not.toContain('/')
      expect(error.message).toContain('PATH_TRAVERSAL')
    })

    it('supports all error codes', () => {
      const codes = [
        'ENCRYPTED',
        'TOO_LARGE',
        'TOO_MANY_ENTRIES',
        'SINGLE_ENTRY_TOO_LARGE',
        'TOTAL_UNCOMPRESSED_TOO_LARGE',
        'PATH_TRAVERSAL',
        'NO_INDEXED_DB',
        'EXTRACT_FAILED',
        'FILE_NOT_FOUND',
        'NOT_A_FILE',
        'DUPLICATE_ENTRIES',
        'INVALID_ENTRY_SIZE'
      ] as const
      for (const code of codes) {
        const error = new ChatImportZipError(code, 'test')
        expect(error.code).toBe(code)
      }
    })
  })

  describe('validateEntries (LOCK-6031)', () => {
    function buildRawZip(entryNames: string[]): Buffer {
      const localParts: Buffer[] = []
      const centralParts: Buffer[] = []
      let localOffset = 0

      for (const entryName of entryNames) {
        const name = Buffer.from(entryName)
        const localHeader = Buffer.alloc(30)
        localHeader.writeUInt32LE(0x04034b50, 0)
        localHeader.writeUInt16LE(20, 4)
        localHeader.writeUInt16LE(name.length, 26)
        localParts.push(Buffer.concat([localHeader, name]))

        const centralHeader = Buffer.alloc(46)
        centralHeader.writeUInt32LE(0x02014b50, 0)
        centralHeader.writeUInt16LE(20, 4)
        centralHeader.writeUInt16LE(20, 6)
        centralHeader.writeUInt16LE(name.length, 28)
        centralHeader.writeUInt32LE(localOffset, 42)
        centralParts.push(Buffer.concat([centralHeader, name]))

        localOffset += localHeader.length + name.length
      }

      const centralDirectory = Buffer.concat(centralParts)
      const endOfCentralDirectory = Buffer.alloc(22)
      endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
      endOfCentralDirectory.writeUInt16LE(entryNames.length, 8)
      endOfCentralDirectory.writeUInt16LE(entryNames.length, 10)
      endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12)
      endOfCentralDirectory.writeUInt32LE(localOffset, 16)

      return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory])
    }

    /**
     * Create a mock StreamZip async object with controlled entries.
     * Simulates node-stream-zip's entries() (name-keyed dedup map) and
     * entriesCount (raw central-directory count).
     */
    function createMockZip(
      rawEntries: Array<{ name: string; isDirectory?: boolean; flags?: number; size?: number }>,
      rawCount?: number
    ): { entries: () => Promise<Record<string, any>>; entriesCount: Promise<number> } {
      const entryMap: Record<string, any> = {}
      for (const entry of rawEntries) {
        entryMap[entry.name] = {
          name: entry.name,
          isDirectory: entry.isDirectory ?? false,
          flags: entry.flags,
          size: entry.size
        }
      }
      // Default: rawCount = number of items passed (no duplicates)
      return {
        entries: async () => entryMap,
        entriesCount: Promise.resolve(rawCount ?? rawEntries.length)
      }
    }

    it('accepts a ZIP with valid entries', async () => {
      const mockZip = createMockZip([
        { name: 'metadata.json', size: 100 },
        { name: 'Data/chat.db', size: 200 }
      ])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(2)
      expect(result.totalUncompressedBytes).toBe(300)
    })

    it('accepts empty ZIP', async () => {
      const mockZip = createMockZip([])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(0)
      expect(result.totalUncompressedBytes).toBe(0)
    })

    it('skips directory entries in size calculation', async () => {
      const mockZip = createMockZip([
        { name: 'Data/', isDirectory: true, size: 0 },
        { name: 'Data/file.txt', size: 50 }
      ])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(2)
      expect(result.totalUncompressedBytes).toBe(50)
    })

    it('REJECTS duplicate names parsed from raw central-directory entries', async () => {
      const zipPath = path.join(tempDir, 'duplicate-central-directory-names.zip')
      fs.writeFileSync(zipPath, buildRawZip(['duplicate.txt', 'unique.txt', 'duplicate.txt']))
      const zip = new StreamZip.async({ file: zipPath })

      try {
        const rawEntryCount = await zip.entriesCount
        const entries = await zip.entries()

        expect(rawEntryCount).toBe(3)
        expect(Object.keys(entries)).toEqual(['duplicate.txt', 'unique.txt'])
        expect(rawEntryCount).toBeGreaterThan(Object.keys(entries).length)
        await expect(validateEntries(zip)).rejects.toMatchObject({
          code: 'DUPLICATE_ENTRIES'
        })
      } finally {
        await zip.close()
      }
    })

    it('REJECTS >10k raw entries (no duplicates, raw count exceeds limit)', async () => {
      // 10,001 unique entries — raw count exceeds MAX_ENTRY_COUNT, no duplicates
      const entries = Array.from({ length: MAX_ENTRY_COUNT + 1 }, (_, i) => ({
        name: `file-${i}.txt`,
        size: 1
      }))
      const mockZip = createMockZip(entries)
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'TOO_MANY_ENTRIES'
      })
    })

    it('accepts ZIP at exact 10k entry boundary', async () => {
      const entries = Array.from({ length: MAX_ENTRY_COUNT }, (_, i) => ({
        name: `file-${i}.txt`,
        size: 1
      }))
      const mockZip = createMockZip(entries)
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(MAX_ENTRY_COUNT)
    })

    it('REJECTS entry with NaN size', async () => {
      const mockZip = createMockZip([{ name: 'bad.txt', size: Number.NaN }])
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'INVALID_ENTRY_SIZE'
      })
    })

    it('REJECTS entry with Infinity size', async () => {
      const mockZip = createMockZip([{ name: 'huge.txt', size: Number.POSITIVE_INFINITY }])
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'INVALID_ENTRY_SIZE'
      })
    })

    it('REJECTS entry with negative size', async () => {
      const mockZip = createMockZip([{ name: 'negative.txt', size: -1 }])
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'INVALID_ENTRY_SIZE'
      })
    })

    it('REJECTS entry with fractional size', async () => {
      const mockZip = createMockZip([{ name: 'fractional.txt', size: 1.5 }])
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'INVALID_ENTRY_SIZE'
      })
    })

    it('REJECTS total uncompressed size one byte over the 2 GiB limit', async () => {
      const entries = [
        ...Array.from({ length: 10 }, (_, i) => ({
          name: `file${i}.bin`,
          size: MAX_SINGLE_ENTRY_BYTES
        })),
        { name: 'remainder.bin', size: 48 * 1024 * 1024 + 1 }
      ]
      const mockZip = createMockZip(entries)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'TOTAL_UNCOMPRESSED_TOO_LARGE'
      })
    })

    it('accepts ZIP at exact 2 GiB total boundary', async () => {
      const entries = [
        ...Array.from({ length: 10 }, (_, i) => ({
          name: `file${i}.bin`,
          size: MAX_SINGLE_ENTRY_BYTES
        })),
        { name: 'remainder.bin', size: 48 * 1024 * 1024 }
      ]
      const mockZip = createMockZip(entries)
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(11)
      expect(result.totalUncompressedBytes).toBe(MAX_TOTAL_UNCOMPRESSED_BYTES)
    })

    it('REJECTS entry exceeding per-entry 200 MiB limit', async () => {
      const overLimit = MAX_SINGLE_ENTRY_BYTES + 1
      const mockZip = createMockZip([{ name: 'huge.bin', size: overLimit }])
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'SINGLE_ENTRY_TOO_LARGE'
      })
    })

    it('accepts entry at exact 200 MiB per-entry limit', async () => {
      const mockZip = createMockZip([{ name: 'max.bin', size: MAX_SINGLE_ENTRY_BYTES }])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(1)
      expect(result.totalUncompressedBytes).toBe(MAX_SINGLE_ENTRY_BYTES)
    })

    it('REJECTS encrypted entries', async () => {
      const mockZip = createMockZip([{ name: 'encrypted.txt', size: 10, flags: 1 }])
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'ENCRYPTED'
      })
    })

    it('duplicate check fires before count check when both apply', async () => {
      // 5 unique names, raw count 10,005 — both duplicate AND exceeds limit,
      // but duplicate check fires first (LOCK-6031 ordering).
      const entries = Array.from({ length: 5 }, (_, i) => ({
        name: `file-${i}.txt`,
        size: 1
      }))
      const mockZip = createMockZip(entries, MAX_ENTRY_COUNT + 5)
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'DUPLICATE_ENTRIES'
      })
    })

    it('treats entries without size as 0 bytes (no false rejections)', async () => {
      const mockZip = createMockZip([{ name: 'no-size.txt' }, { name: 'Data/file.txt', size: 10 }])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(2)
      expect(result.totalUncompressedBytes).toBe(10)
    })
  })

  describe('validateNoZipSlip', () => {
    const destDir = '/mock/dest'

    it('accepts valid relative paths', async () => {
      const entryMap = {
        'file.txt': { name: 'file.txt', isDirectory: false },
        'Data/sub/file.txt': { name: 'Data/sub/file.txt', isDirectory: false }
      }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).resolves.not.toThrow()
    })

    it('rejects absolute path entries', async () => {
      const entryMap = { '/etc/passwd': { name: '/etc/passwd', isDirectory: false } }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toThrow(ChatImportZipError)
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL'
      })
    })

    it('rejects entries with ".." components', async () => {
      const entryMap = { '../../etc/passwd': { name: '../../etc/passwd', isDirectory: false } }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toThrow(ChatImportZipError)
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL'
      })
    })
  })

  describe('sanitizeEntryNameForMessage', () => {
    it('preserves a simple basename (truncated to 40 chars)', () => {
      expect(sanitizeEntryNameForMessage('file.txt')).toBe('file.txt')
    })

    it('truncates long names to 40 chars with ellipsis', () => {
      const longName = 'a'.repeat(50)
      const result = sanitizeEntryNameForMessage(longName)
      expect(result).toBe('a'.repeat(40) + '…')
      expect(result.length).toBe(41) // 40 + ellipsis
    })

    it('replaces name with control chars with <redacted>', () => {
      expect(sanitizeEntryNameForMessage('file\x00name.txt')).toBe('<redacted>')
      expect(sanitizeEntryNameForMessage('file\x01name.txt')).toBe('<redacted>')
      expect(sanitizeEntryNameForMessage('file\x1fname.txt')).toBe('<redacted>')
      expect(sanitizeEntryNameForMessage('file\x7fname.txt')).toBe('<redacted>')
    })

    it('replaces name containing forward slash with <redacted>', () => {
      expect(sanitizeEntryNameForMessage('path/to/file.txt')).toBe('<redacted>')
    })

    it('replaces name containing backslash with <redacted>', () => {
      expect(sanitizeEntryNameForMessage('path\\to\\file.txt')).toBe('<redacted>')
    })

    it('returns <empty> for empty string', () => {
      expect(sanitizeEntryNameForMessage('')).toBe('<empty>')
    })

    it('handles name exactly at 40 chars', () => {
      const name = 'b'.repeat(40)
      expect(sanitizeEntryNameForMessage(name)).toBe(name)
    })

    it('handles name at 41 chars (triggers truncation)', () => {
      const name = 'c'.repeat(41)
      const result = sanitizeEntryNameForMessage(name)
      expect(result).toBe('c'.repeat(40) + '…')
    })

    it('preserves dots and dashes in name', () => {
      expect(sanitizeEntryNameForMessage('my-file_v2.tar.gz')).toBe('my-file_v2.tar.gz')
    })

    it('replaces null byte injection with <redacted>', () => {
      expect(sanitizeEntryNameForMessage('innocent.txt\x00../../etc/passwd')).toBe('<redacted>')
    })
  })
})
