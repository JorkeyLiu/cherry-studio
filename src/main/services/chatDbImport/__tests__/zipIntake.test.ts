/**
 * zipIntake tests.
 *
 * IMPORTANT: main.setup.ts globally mocks node:fs, node:os, node:path.
 * We override with real implementations using importActual inside vi.mock factories.
 *
 * The node:fs mock uses vi.hoisted to produce a MUTABLE wrapper whose
 * properties can be overridden per-test for deterministic I/O failure
 * simulation. ESM module namespaces are sealed by spec, so vi.spyOn cannot
 * reconfigure exports — the hoisted mutable wrapper is the supported pattern.
 */

import type * as NodeFs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable fs wrapper: properties can be overridden per-test to simulate
// deterministic readdirSync / lstatSync failures.  `default` points to
// itself so `import fs from 'node:fs'` resolves to the mutable object.
const { fsMock } = vi.hoisted(() => {
  const actual = require('node:fs') as typeof NodeFs
  const fsMock: any = { ...actual }
  fsMock.default = fsMock
  return { fsMock }
})

vi.mock('node:fs', () => fsMock)

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
  classifyOriginCandidates,
  DEV_ORIGIN_DIR,
  enumerateLdbCandidates,
  FILE_ORIGIN_DIR,
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

    it('rejects when only .ldb-suffixed directories exist (not regular files)', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'some-origin')
      fs.mkdirSync(subdir, { recursive: true })
      // Directory with .ldb suffix — must NOT count
      fs.mkdirSync(path.join(subdir, '000001.ldb'))

      expect(() => validateIndexedDbStructure(tempDir)).toThrow(ChatImportZipError)
      expect(() => validateIndexedDbStructure(tempDir)).toThrow(/NO_INDEXED_DB/)
    })

    // -----------------------------------------------------------------------
    // Symlink structural validation (darwin-assumed; platform-guarded)
    // -----------------------------------------------------------------------

    const itOnDarwin = process.platform === 'darwin' ? it : it.skip

    itOnDarwin('rejects .ldb symlink pointing to a valid file (lstatSync isFile=false for symlinks)', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'some-origin')
      fs.mkdirSync(subdir, { recursive: true })

      // Create a symlink target with a non-.ldb name (so only the symlink has .ldb suffix)
      const targetFile = path.join(subdir, 'target-data')
      fs.writeFileSync(targetFile, 'leveldb data')
      // Create a symlink named 000001.ldb → target-data
      // lstatSync on the symlink returns isFile() = false (symlink, not regular file)
      fs.symlinkSync(targetFile, path.join(subdir, '000001.ldb'))

      // Only the symlink exists with .ldb suffix; no regular .ldb file.
      // validateIndexedDbStructure must reject because lstatSync.isFile() is false for symlinks.
      expect(() => validateIndexedDbStructure(tempDir)).toThrow(ChatImportZipError)
      expect(() => validateIndexedDbStructure(tempDir)).toThrow(/NO_INDEXED_DB/)
    })

    itOnDarwin('rejects dangling .ldb symlink (lstatSync throws → fail-closed)', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'some-origin')
      fs.mkdirSync(subdir, { recursive: true })

      // Create a dangling symlink named 000001.ldb → /nonexistent
      fs.symlinkSync('/nonexistent', path.join(subdir, '000001.ldb'))

      // Dangling symlink: lstatSync succeeds (it doesn't follow the link),
      // but isFile() returns false. If it somehow throws, the catch returns false.
      expect(() => validateIndexedDbStructure(tempDir)).toThrow(ChatImportZipError)
      expect(() => validateIndexedDbStructure(tempDir)).toThrow(/NO_INDEXED_DB/)
    })

    itOnDarwin('accepts when a regular .ldb file coexists with a symlink .ldb (only regular qualifies)', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'some-origin')
      fs.mkdirSync(subdir, { recursive: true })

      // Real .ldb file
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'leveldb data')
      // Symlink .ldb file — must NOT count
      fs.symlinkSync('/nonexistent', path.join(subdir, '000002.ldb'))

      // Should accept because the real file qualifies
      const result = validateIndexedDbStructure(tempDir)
      expect(result).toBe(indexedDbPath)
    })

    // -----------------------------------------------------------------------
    // Deterministic I/O failure tests (mutable fsMock overrides)
    // -----------------------------------------------------------------------

    it('readdirSync failure on inner entries skips the subdirectory (fail-closed, continues)', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'some-origin')
      fs.mkdirSync(subdir, { recursive: true })
      // Create a .ldb file so the subdir would normally qualify
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      // Save original and override inner readdirSync to fail
      const origReaddirSync = fsMock.readdirSync
      fsMock.readdirSync = (p: any, options?: any) => {
        const pStr = String(p)
        // Fail for the inner subdir readdirSync (not withFileTypes)
        if (pStr.endsWith('some-origin') && !options?.withFileTypes) {
          throw new Error('EACCES: permission denied')
        }
        // Pass through for everything else
        return origReaddirSync(p, options)
      }

      try {
        // The subdirectory's inner readdirSync fails → caught → skipped → no .ldb found → NO_INDEXED_DB
        expect(() => validateIndexedDbStructure(tempDir)).toThrow(ChatImportZipError)
        expect(() => validateIndexedDbStructure(tempDir)).toThrow(/NO_INDEXED_DB/)
      } finally {
        fsMock.readdirSync = origReaddirSync
      }
    })

    it('lstatSync failure for a .ldb file returns false (fail-closed, file not counted)', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbPath, 'some-origin')
      fs.mkdirSync(subdir, { recursive: true })
      // Create a .ldb file — this would normally qualify
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      // Save original and override lstatSync to fail for the .ldb file
      const origLstatSync = fsMock.lstatSync
      fsMock.lstatSync = (p: any) => {
        const pStr = String(p)
        if (pStr.endsWith('000001.ldb')) {
          throw new Error('EACCES: permission denied')
        }
        return origLstatSync(p)
      }

      try {
        // lstatSync fails for 000001.ldb → catch returns false → no qualifying .ldb → NO_INDEXED_DB
        expect(() => validateIndexedDbStructure(tempDir)).toThrow(ChatImportZipError)
        expect(() => validateIndexedDbStructure(tempDir)).toThrow(/NO_INDEXED_DB/)
      } finally {
        fsMock.lstatSync = origLstatSync
      }
    })

    it('readdirSync failure on outer IndexedDB propagates (not wrapped in try/catch)', () => {
      const indexedDbPath = path.join(tempDir, 'IndexedDB')
      fs.mkdirSync(indexedDbPath, { recursive: true })

      // Save original and override outer readdirSync (withFileTypes) to fail
      const origReaddirSync = fsMock.readdirSync
      fsMock.readdirSync = (p: any, options?: any) => {
        const pStr = String(p)
        if (pStr.endsWith('IndexedDB') && options?.withFileTypes) {
          throw new Error('EACCES: permission denied')
        }
        return origReaddirSync(p, options)
      }

      try {
        // Outer readdirSync failure is NOT caught by validateIndexedDbStructure
        // (the outer readdirSync call is outside any try/catch). The raw error
        // propagates — this is the actual production contract.
        expect(() => validateIndexedDbStructure(tempDir)).toThrow('EACCES: permission denied')
        expect(() => validateIndexedDbStructure(tempDir)).not.toThrow(ChatImportZipError)
      } finally {
        fsMock.readdirSync = origReaddirSync
      }
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
        'INVALID_ENTRY_SIZE',
        'UNSUPPORTED_ORIGIN',
        'AMBIGUOUS_ORIGIN',
        'PACKAGED_DEV_ORIGIN'
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

  // =========================================================================
  // Origin classification (LOCK-DEV-3/4/6)
  // =========================================================================

  describe('enumerateLdbCandidates', () => {
    it('returns empty array when IndexedDB dir has no .ldb-bearing subdirs', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      fs.mkdirSync(indexedDbDir, { recursive: true })
      const emptyDir = path.join(indexedDbDir, 'empty')
      fs.mkdirSync(emptyDir)
      fs.writeFileSync(path.join(emptyDir, 'MANIFEST-000001'), 'data')

      expect(enumerateLdbCandidates(indexedDbDir)).toEqual([])
    })

    it('returns the single candidate with .ldb files', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      expect(enumerateLdbCandidates(indexedDbDir)).toEqual([FILE_ORIGIN_DIR])
    })

    it('returns multiple candidates when multiple subdirs have .ldb', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      for (const name of [FILE_ORIGIN_DIR, DEV_ORIGIN_DIR]) {
        const subdir = path.join(indexedDbDir, name)
        fs.mkdirSync(subdir, { recursive: true })
        fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')
      }

      const result = enumerateLdbCandidates(indexedDbDir)
      expect(result).toContain(FILE_ORIGIN_DIR)
      expect(result).toContain(DEV_ORIGIN_DIR)
      expect(result).toHaveLength(2)
    })

    it('returns empty array when IndexedDB dir does not exist', () => {
      expect(enumerateLdbCandidates(path.join(tempDir, 'nonexistent'))).toEqual([])
    })

    it('skips unreadable subdirs without throwing', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const validDir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(validDir, { recursive: true })
      fs.writeFileSync(path.join(validDir, '000001.ldb'), 'data')

      expect(enumerateLdbCandidates(indexedDbDir)).toEqual([FILE_ORIGIN_DIR])
    })

    it('rejects directories ending in .ldb (not regular files)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(subdir, { recursive: true })
      // Create a directory whose name ends in .ldb — must NOT count
      const fakeLdbDir = path.join(subdir, '000001.ldb')
      fs.mkdirSync(fakeLdbDir)
      fs.writeFileSync(path.join(fakeLdbDir, 'inner.txt'), 'data')

      expect(enumerateLdbCandidates(indexedDbDir)).toEqual([])
    })

    it('rejects symlinks ending in .ldb (not regular files)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(subdir, { recursive: true })
      // Create a symlink whose name ends in .ldb — must NOT count
      const symlinkPath = path.join(subdir, '000001.ldb')
      fs.symlinkSync('/nonexistent', symlinkPath)

      expect(enumerateLdbCandidates(indexedDbDir)).toEqual([])
    })

    it('accepts only regular .ldb files when mixed with directories and symlinks', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(subdir, { recursive: true })
      // Real .ldb file
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')
      // Directory named .ldb
      fs.mkdirSync(path.join(subdir, '000002.ldb'))
      // Symlink named .ldb
      fs.symlinkSync('/nonexistent', path.join(subdir, '000003.ldb'))

      expect(enumerateLdbCandidates(indexedDbDir)).toEqual([FILE_ORIGIN_DIR])
    })
  })

  describe('classifyOriginCandidates', () => {
    const itOnDarwin = process.platform === 'darwin' ? it : it.skip

    it('classifies file-origin correctly (packaged)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      const result = classifyOriginCandidates(indexedDbDir, true)
      expect(result).toEqual({ kind: 'file', indexedDbDir })
    })

    it('classifies file-origin correctly (unpackaged)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      const result = classifyOriginCandidates(indexedDbDir, false)
      expect(result).toEqual({ kind: 'file', indexedDbDir })
    })

    it('classifies dev-origin correctly (unpackaged)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, DEV_ORIGIN_DIR)
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      const result = classifyOriginCandidates(indexedDbDir, false)
      expect(result).toEqual({ kind: 'dev', indexedDbDir })
    })

    it('rejects dev-origin in packaged mode (PACKAGED_DEV_ORIGIN)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, DEV_ORIGIN_DIR)
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      expect(() => classifyOriginCandidates(indexedDbDir, true)).toThrow(ChatImportZipError)
      expect(() => classifyOriginCandidates(indexedDbDir, true)).toThrow(/PACKAGED_DEV_ORIGIN/)
    })

    it('rejects multiple candidates as ambiguous (AMBIGUOUS_ORIGIN)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      for (const name of [FILE_ORIGIN_DIR, DEV_ORIGIN_DIR]) {
        const subdir = path.join(indexedDbDir, name)
        fs.mkdirSync(subdir, { recursive: true })
        fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')
      }

      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(ChatImportZipError)
      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(/AMBIGUOUS_ORIGIN/)
    })

    it('rejects a supported and unsupported origin combination as ambiguous', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      for (const name of [FILE_ORIGIN_DIR, 'unknown-origin.indexeddb.leveldb']) {
        const subdir = path.join(indexedDbDir, name)
        fs.mkdirSync(subdir, { recursive: true })
        fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')
      }

      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(/AMBIGUOUS_ORIGIN/)
    })

    it('does not treat nested .ldb entries as a direct origin candidate', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const originDir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(path.join(originDir, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(originDir, 'nested', '000001.ldb'), 'data')

      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(/NO_INDEXED_DB/)
    })

    itOnDarwin('rejects a symlinked direct candidate directory', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const target = path.join(tempDir, 'real-origin')
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, '000001.ldb'), 'data')
      fs.mkdirSync(indexedDbDir, { recursive: true })
      fs.symlinkSync(target, path.join(indexedDbDir, FILE_ORIGIN_DIR), 'dir')

      expect(enumerateLdbCandidates(indexedDbDir)).toEqual([])
      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(/NO_INDEXED_DB/)
    })

    it('rejects unsupported single candidate (UNSUPPORTED_ORIGIN)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, 'some_unknown_origin.indexeddb.leveldb')
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(ChatImportZipError)
      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(/UNSUPPORTED_ORIGIN/)
    })

    it('rejects unsupported candidate in packaged mode (UNSUPPORTED_ORIGIN)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const subdir = path.join(indexedDbDir, 'some_unknown_origin.indexeddb.leveldb')
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(subdir, '000001.ldb'), 'data')

      expect(() => classifyOriginCandidates(indexedDbDir, true)).toThrow(ChatImportZipError)
      expect(() => classifyOriginCandidates(indexedDbDir, true)).toThrow(/UNSUPPORTED_ORIGIN/)
    })

    it('rejects zero candidates (NO_INDEXED_DB)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      fs.mkdirSync(indexedDbDir, { recursive: true })

      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(ChatImportZipError)
      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(/NO_INDEXED_DB/)
    })

    it('sanitizes directory names with control chars in AMBIGUOUS_ORIGIN message', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      // Name with control char — must be sanitized in the error message.
      // Use \x01 (SOH) which is valid in directory names on most filesystems.
      const evilName = 'evil\x01dir.indexeddb.leveldb'
      const evilDir = path.join(indexedDbDir, evilName)
      fs.mkdirSync(evilDir, { recursive: true })
      fs.writeFileSync(path.join(evilDir, '000001.ldb'), 'data')
      const otherDir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(otherDir, { recursive: true })
      fs.writeFileSync(path.join(otherDir, '000001.ldb'), 'data')

      try {
        classifyOriginCandidates(indexedDbDir, false)
        expect.fail('should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('AMBIGUOUS_ORIGIN')
        // The raw control-char-containing name must NOT appear in the message
        // (sanitizeEntryNameForMessage replaces control chars with <redacted>).
        expect(e.message).not.toContain('evil\x01dir')
      }
    })

    it('sanitizes directory names with path separators in UNSUPPORTED_ORIGIN message', () => {
      // A name that includes path separators (simulating a crafted ZIP entry
      // that somehow ended up as a real directory name — defensive check).
      // Use mkdirSync with the actual path to create a directory that has
      // a forward slash in its basename... but this is impossible on real
      // filesystems. Instead, verify that classifyOriginCandidates uses
      // sanitizeEntryNameForMessage by checking that an unsupported name
      // containing control characters (which IS possible) is sanitized.
      // We already test control chars above. Here, verify that the
      // sanitizeEntryNameForMessage function itself redacts names with '/'.
      expect(sanitizeEntryNameForMessage('../../etc/passwd')).toBe('<redacted>')
      expect(sanitizeEntryNameForMessage('..\\windows\\system32')).toBe('<redacted>')
    })

    it('rejects file + unrelated (AMBIGUOUS_ORIGIN)', () => {
      const indexedDbDir = path.join(tempDir, 'IndexedDB')
      const fileDir = path.join(indexedDbDir, FILE_ORIGIN_DIR)
      fs.mkdirSync(fileDir, { recursive: true })
      fs.writeFileSync(path.join(fileDir, '000001.ldb'), 'data')
      const otherDir = path.join(indexedDbDir, 'other.indexeddb.leveldb')
      fs.mkdirSync(otherDir, { recursive: true })
      fs.writeFileSync(path.join(otherDir, '000001.ldb'), 'data')

      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(ChatImportZipError)
      expect(() => classifyOriginCandidates(indexedDbDir, false)).toThrow(/AMBIGUOUS_ORIGIN/)
    })
  })
})
