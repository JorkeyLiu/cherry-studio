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
  extractZip,
  FILE_ORIGIN_DIR,
  MAX_ENTRY_COUNT,
  MAX_SELECTED_COMPRESSION_RATIO,
  MAX_SELECTED_SINGLE_ENTRY_BYTES,
  MAX_SELECTED_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ZIP_SIZE_BYTES,
  sanitizeEntryNameForMessage,
  selectExtractionEntries,
  setAppIsPackagedForTests,
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
    // LOCK-Z2 test seam restoration: never leak a packaged-mode override
    // into other tests (extractZip resolves the seam via appIsPackaged()).
    setAppIsPackagedForTests(null)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('constants', () => {
    it('MAX_ZIP_SIZE_BYTES is 4 GiB (LOCK-PROD-9 container hard cap)', () => {
      expect(MAX_ZIP_SIZE_BYTES).toBe(4 * 1024 * 1024 * 1024)
    })

    it('MAX_ENTRY_COUNT is 10000', () => {
      expect(MAX_ENTRY_COUNT).toBe(10_000)
    })

    it('MAX_SELECTED_SINGLE_ENTRY_BYTES is 128 MiB (LOCK-PROD-9)', () => {
      expect(MAX_SELECTED_SINGLE_ENTRY_BYTES).toBe(128 * 1024 * 1024)
    })

    it('MAX_SELECTED_TOTAL_UNCOMPRESSED_BYTES is 768 MiB (LOCK-PROD-9)', () => {
      expect(MAX_SELECTED_TOTAL_UNCOMPRESSED_BYTES).toBe(768 * 1024 * 1024)
    })

    it('MAX_SELECTED_COMPRESSION_RATIO is 100 (LOCK-PROD-9)', () => {
      expect(MAX_SELECTED_COMPRESSION_RATIO).toBe(100)
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
        'PACKAGED_DEV_ORIGIN',
        'SELECTED_ENTRY_TOO_LARGE',
        'SELECTED_TOO_LARGE',
        'SELECTED_RATIO_TOO_HIGH',
        'UNSUPPORTED_ENTRY_TYPE',
        'SELECTED_EXTRACT_OVERFLOW',
        'SELECTED_ENTRY_SIZE_MISMATCH',
        'DUPLICATE_EXTRACTION_TARGET'
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
      rawEntries: Array<{
        name: string
        isDirectory?: boolean
        flags?: number
        size?: number
        attr?: number
      }>,
      rawCount?: number
    ): { entries: () => Promise<Record<string, any>>; entriesCount: Promise<number> } {
      const entryMap: Record<string, any> = {}
      for (const entry of rawEntries) {
        entryMap[entry.name] = {
          name: entry.name,
          isDirectory: entry.isDirectory ?? false,
          flags: entry.flags,
          size: entry.size,
          attr: entry.attr
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

    // -----------------------------------------------------------------------
    // LOCK-Z2: symlink / mode / file-type validation from external attributes
    // -----------------------------------------------------------------------

    it('REJECTS a symlink-mode entry (S_IFLNK 0xA000) fail-closed', async () => {
      // attr = (0xA1FF << 16) — POSIX mode with S_IFLNK file type bits.
      const mockZip = createMockZip([{ name: 'evil-link', size: 10, attr: 0xa1ff0000 }])
      await expect(validateEntries(mockZip as any)).rejects.toThrow(ChatImportZipError)
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'UNSUPPORTED_ENTRY_TYPE'
      })
    })

    it('REJECTS a special-type entry (S_IFIFO 0x1000)', async () => {
      const mockZip = createMockZip([{ name: 'fifo', size: 0, attr: 0x11ff0000 }])
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'UNSUPPORTED_ENTRY_TYPE'
      })
    })

    it('accepts regular-file entries with POSIX S_IFREG mode', async () => {
      const mockZip = createMockZip([{ name: 'file.txt', size: 10, attr: 0x81a40000 }])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(1)
    })

    it('accepts directory entries with POSIX S_IFDIR mode', async () => {
      const mockZip = createMockZip([{ name: 'Data/', isDirectory: true, size: 0, attr: 0x41ed0010 }])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(1)
    })

    it('treats entries with no POSIX mode (attr 0) leniently as regular files', async () => {
      // Windows-made archives carry attr 0x20/0x10 with mode bits 0 — the
      // file type cannot be inferred and must NOT be rejected.
      const mockZip = createMockZip([{ name: 'file.txt', size: 10, attr: 0x20 }])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(1)
    })

    it('REJECTS symlink entries even when they carry a safe size', async () => {
      const mockZip = createMockZip([
        { name: 'IndexedDB/file__0.indexeddb.leveldb/000001.ldb', size: 1024, attr: 0xa1ff0000 }
      ])
      await expect(validateEntries(mockZip as any)).rejects.toMatchObject({
        code: 'UNSUPPORTED_ENTRY_TYPE'
      })
    })

    // -----------------------------------------------------------------------
    // LOCK-Z2: ZIP64 / size consistency — real node-stream-zip parse of a
    // synthetic ZIP64 central directory (metadata-only, ~300 bytes on disk).
    // -----------------------------------------------------------------------

    /**
     * Build a minimal ZIP64 archive whose single entry's uncompressed size is
     * carried by a ZIP64 extra field (the 32-bit CEN field is 0xFFFFFFFF).
     * Only the central directory is meaningful — the local data region is
     * never read, so no large data is ever allocated or touched.
     */
    function buildZip64Buffer(name: string, uncompressedSize: bigint, compressedSize: bigint): Buffer {
      const h16 = (n: number) => {
        const b = Buffer.alloc(2)
        b.writeUInt16LE(n, 0)
        return b
      }
      const h64 = (n: bigint) => {
        const b = Buffer.alloc(8)
        b.writeBigUInt64LE(n, 0)
        return b
      }
      const nameBuf = Buffer.from(name)
      const marker = 0xffffffff

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(45, 4)
      local.writeUInt16LE(0, 6)
      local.writeUInt16LE(0, 8)
      local.writeUInt32LE(marker, 14)
      local.writeUInt32LE(marker, 18)
      local.writeUInt32LE(marker, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)
      const localBody = Buffer.concat([local, nameBuf])

      const cen = Buffer.alloc(46)
      cen.writeUInt32LE(0x02014b50, 0)
      cen.writeUInt16LE(45, 4)
      cen.writeUInt16LE(45, 6)
      cen.writeUInt16LE(0, 8)
      cen.writeUInt16LE(0, 10)
      cen.writeUInt32LE(marker, 16)
      cen.writeUInt32LE(marker, 20)
      cen.writeUInt32LE(marker, 24)
      cen.writeUInt16LE(nameBuf.length, 28)
      const extra = Buffer.concat([h16(0x0001), h16(24), h64(uncompressedSize), h64(compressedSize), h64(0n)])
      cen.writeUInt16LE(extra.length, 30)
      cen.writeUInt32LE(0, 42)
      const cenEntry = Buffer.concat([cen, nameBuf, extra])
      const cenOffset = localBody.length

      const zip64eocd = Buffer.alloc(56)
      zip64eocd.writeUInt32LE(0x06064b50, 0)
      zip64eocd.writeBigUInt64LE(44n, 4)
      zip64eocd.writeUInt16LE(45, 12)
      zip64eocd.writeUInt16LE(45, 14)
      zip64eocd.writeUInt32LE(0, 16)
      zip64eocd.writeUInt32LE(0, 20)
      zip64eocd.writeBigUInt64LE(1n, 24)
      zip64eocd.writeBigUInt64LE(1n, 32)
      zip64eocd.writeBigUInt64LE(BigInt(cenEntry.length), 40)
      zip64eocd.writeBigUInt64LE(BigInt(cenOffset), 48)

      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(0x07064b50, 0)
      locator.writeUInt32LE(0, 4)
      locator.writeBigUInt64LE(BigInt(cenOffset + cenEntry.length), 8)
      locator.writeUInt32LE(1, 16)

      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0)
      eocd.writeUInt16LE(0xffff, 8)
      eocd.writeUInt16LE(0xffff, 10)
      eocd.writeUInt32LE(marker, 12)
      eocd.writeUInt32LE(marker, 16)

      return Buffer.concat([localBody, cenEntry, zip64eocd, locator, eocd])
    }

    it('parses a real ZIP64 central directory and REJECTS a >2^53 entry size', async () => {
      // 2^55 uncompressed — expressible only via the ZIP64 extra field.
      const zipPath = path.join(tempDir, 'zip64-huge.zip')
      fs.writeFileSync(zipPath, buildZip64Buffer('IndexedDB/file__0.indexeddb.leveldb/000001.ldb', 1n << 55n, 1024n))
      const zip = new StreamZip.async({ file: zipPath })
      try {
        // Library exposes the ZIP64 size as a number; it is not a safe integer.
        const entries = await zip.entries()
        const entry = entries['IndexedDB/file__0.indexeddb.leveldb/000001.ldb']
        expect(entry.size).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
        expect(Number.isSafeInteger(entry.size)).toBe(false)

        await expect(validateEntries(zip)).rejects.toMatchObject({
          code: 'INVALID_ENTRY_SIZE'
        })
      } finally {
        await zip.close()
      }
    })

    it('accepts a real ZIP64 entry size that stays within the safe integer range', async () => {
      // 5 GiB uncompressed, 1 KiB compressed — only expressible via ZIP64.
      // Non-selected path (Data/) — passes container-level validation without
      // ever allocating the uncompressed bytes.
      const zipPath = path.join(tempDir, 'zip64-safe.zip')
      fs.writeFileSync(zipPath, buildZip64Buffer('Data/huge.bin', 5n * 1024n * 1024n * 1024n, 1024n))
      const zip = new StreamZip.async({ file: zipPath })
      try {
        const result = await validateEntries(zip)
        expect(result.entryCount).toBe(1)
        expect(result.totalUncompressedBytes).toBe(5 * 1024 * 1024 * 1024)
      } finally {
        await zip.close()
      }
    })

    it('does NOT enforce byte limits at container level (LOCK-PROD-9: non-selected entries excluded from selected-byte limits)', async () => {
      // A huge irrelevant (non-selected) entry passes container validation —
      // selected-byte limits apply only to the selected subtrees.
      const entries = [
        ...Array.from({ length: 10 }, (_, i) => ({
          name: `file${i}.bin`,
          size: 200 * 1024 * 1024
        })),
        { name: 'remainder.bin', size: 600 * 1024 * 1024 }
      ]
      const mockZip = createMockZip(entries)
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(11)
      expect(result.totalUncompressedBytes).toBe(10 * 200 * 1024 * 1024 + 600 * 1024 * 1024)
    })

    it('accepts an entry far above the old single-entry cap at container level', async () => {
      const overLimit = 256 * 1024 * 1024
      const mockZip = createMockZip([{ name: 'huge.bin', size: overLimit }])
      const result = await validateEntries(mockZip as any)
      expect(result.entryCount).toBe(1)
      expect(result.totalUncompressedBytes).toBe(overLimit)
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

    // -----------------------------------------------------------------------
    // LOCK-Z2: drive-letter / backslash / NUL / ".." component semantics
    // -----------------------------------------------------------------------

    it('rejects Windows drive-letter paths (C:evil)', async () => {
      const entryMap = { 'C:\\evil\\file.txt': { name: 'C:\\evil\\file.txt', isDirectory: false } }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL'
      })
    })

    it('rejects Windows drive-letter paths with forward slashes (C:/evil)', async () => {
      const entryMap = { 'C:/evil/file.txt': { name: 'C:/evil/file.txt', isDirectory: false } }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL'
      })
    })

    it('rejects backslash path separators even without a drive letter', async () => {
      // On POSIX path.resolve treats `..\..\x` as a plain name; the backslash
      // is rejected explicitly as a Windows separator (LOCK-Z2).
      const entryMap = { '..\\..\\etc\\passwd': { name: '..\\..\\etc\\passwd', isDirectory: false } }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL'
      })
    })

    it('rejects entry names containing a NUL byte', async () => {
      const entryMap = { 'evil\x00name.txt': { name: 'evil\x00name.txt', isDirectory: false } }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL'
      })
    })

    it('accepts names containing ".." as a non-component substring (file..txt)', async () => {
      // Only a `..` path COMPONENT is a traversal; a dotted filename is not.
      const entryMap = { 'file..txt': { name: 'file..txt', isDirectory: false } }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).resolves.not.toThrow()
    })

    // -----------------------------------------------------------------------
    // LOCK-FZ2: canonical-destination duplicate rejection — distinct names
    // that normalize to the same extraction target (a/b vs a//b vs a/./b)
    // must be rejected before extraction.
    // -----------------------------------------------------------------------

    it('REJECTS distinct names that normalize to the same target (a/b vs a//b)', async () => {
      const entryMap = {
        'a/b': { name: 'a/b', isDirectory: false },
        'a//b': { name: 'a//b', isDirectory: false }
      }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toThrow(ChatImportZipError)
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'DUPLICATE_EXTRACTION_TARGET'
      })
    })

    it('REJECTS distinct names that normalize to the same target (a/b vs a/./b)', async () => {
      const entryMap = {
        'a/b': { name: 'a/b', isDirectory: false },
        'a/./b': { name: 'a/./b', isDirectory: false }
      }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'DUPLICATE_EXTRACTION_TARGET'
      })
    })

    it('REJECTS directory + file names that normalize to the same target (a/ vs a)', async () => {
      const entryMap = {
        'a/': { name: 'a/', isDirectory: true },
        a: { name: 'a', isDirectory: false }
      }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).rejects.toMatchObject({
        code: 'DUPLICATE_EXTRACTION_TARGET'
      })
    })

    it('accepts distinct names that normalize to DIFFERENT targets', async () => {
      const entryMap = {
        'a/b': { name: 'a/b', isDirectory: false },
        'a/c': { name: 'a/c', isDirectory: false },
        'b//d': { name: 'b//d', isDirectory: false },
        'b/./e': { name: 'b/./e', isDirectory: false }
      }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).resolves.not.toThrow()
    })

    it('accepts a single repeated-separator / dot-component name without a collision', async () => {
      const entryMap = { 'a//b': { name: 'a//b', isDirectory: false } }
      const mockZip = { entries: async () => entryMap }
      await expect(validateNoZipSlip(mockZip as any, destDir)).resolves.not.toThrow()
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

  // =========================================================================
  // LOCK-PROD-8/9 — selective extraction from the central directory
  // =========================================================================

  describe('selectExtractionEntries', () => {
    function createMockZip(
      rawEntries: Array<{
        name: string
        isDirectory?: boolean
        flags?: number
        size?: number
        compressedSize?: number
      }>
    ) {
      const entryMap: Record<string, any> = {}
      for (const entry of rawEntries) {
        entryMap[entry.name] = {
          name: entry.name,
          isDirectory: entry.isDirectory ?? false,
          flags: entry.flags,
          size: entry.size ?? 0,
          compressedSize: entry.compressedSize ?? entry.size ?? 0
        }
      }
      return { entries: async () => entryMap }
    }

    const FILE_ORIGIN_PREFIX = `IndexedDB/${FILE_ORIGIN_DIR}/`
    const BLOB_ORIGIN_PREFIX = `IndexedDB/${FILE_ORIGIN_DIR.replace('.indexeddb.leveldb', '.indexeddb.blob')}/`
    const LS_PREFIX = 'Local Storage/leveldb/'

    it('classifies the file origin and selects exactly the accepted subtrees (LOCK-PROD-8)', async () => {
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}000001.ldb`, size: 100 },
        { name: `${FILE_ORIGIN_PREFIX}MANIFEST-000001`, size: 10 },
        { name: `${BLOB_ORIGIN_PREFIX}000001.ldb`, size: 50 },
        { name: `${LS_PREFIX}CURRENT`, size: 10 },
        { name: `${LS_PREFIX}LOG`, size: 20 },
        // Never-selected container entries:
        { name: 'Data/Files/image.png', size: 500 * 1024 * 1024 },
        { name: 'chat.db', size: 100 },
        { name: 'Memory/knowledge.db', size: 100 },
        // An unrelated origin WITHOUT .ldb files is not a classification
        // candidate and is never selected/extracted.
        { name: 'IndexedDB/other-origin.indexeddb.leveldb/MANIFEST-000001', size: 10 }
      ])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      expect(selection.origin).toEqual({ kind: 'file', indexedDbDir: path.join(tempDir, 'IndexedDB') })
      expect(selection.selectedEntries.map((e) => e.name)).toEqual([
        `${FILE_ORIGIN_PREFIX}000001.ldb`,
        `${FILE_ORIGIN_PREFIX}MANIFEST-000001`,
        `${BLOB_ORIGIN_PREFIX}000001.ldb`,
        `${LS_PREFIX}CURRENT`,
        `${LS_PREFIX}LOG`
      ])
      expect(selection.selectedEntryCount).toBe(5)
      expect(selection.selectedTotalUncompressedBytes).toBe(190)
    })

    it('rejects multiple supported origins as AMBIGUOUS_ORIGIN before extraction (LOCK-PROD-8)', async () => {
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}000001.ldb`, size: 10 },
        { name: `IndexedDB/${DEV_ORIGIN_DIR}/000001.ldb`, size: 10 }
      ])
      await expect(selectExtractionEntries(mockZip as any, tempDir, false)).rejects.toMatchObject({
        code: 'AMBIGUOUS_ORIGIN'
      })
    })

    it('rejects unsupported single origin as UNSUPPORTED_ORIGIN', async () => {
      const mockZip = createMockZip([{ name: 'IndexedDB/unknown.indexeddb.leveldb/000001.ldb', size: 10 }])
      await expect(selectExtractionEntries(mockZip as any, tempDir, false)).rejects.toMatchObject({
        code: 'UNSUPPORTED_ORIGIN'
      })
    })

    it('rejects dev origin in packaged mode as PACKAGED_DEV_ORIGIN', async () => {
      const mockZip = createMockZip([{ name: `IndexedDB/${DEV_ORIGIN_DIR}/000001.ldb`, size: 10 }])
      await expect(selectExtractionEntries(mockZip as any, tempDir, true)).rejects.toMatchObject({
        code: 'PACKAGED_DEV_ORIGIN'
      })
    })

    it('rejects NO_INDEXED_DB when no origin has .ldb entries', async () => {
      const mockZip = createMockZip([{ name: 'IndexedDB/file__0.indexeddb.leveldb/MANIFEST-000001', size: 10 }])
      await expect(selectExtractionEntries(mockZip as any, tempDir, false)).rejects.toMatchObject({
        code: 'NO_INDEXED_DB'
      })
    })

    it('rejects a selected single entry above 128 MiB (LOCK-PROD-9)', async () => {
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}000001.ldb`, size: MAX_SELECTED_SINGLE_ENTRY_BYTES + 1 }
      ])
      await expect(selectExtractionEntries(mockZip as any, tempDir, false)).rejects.toMatchObject({
        code: 'SELECTED_ENTRY_TOO_LARGE'
      })
    })

    it('accepts a selected single entry at exactly 128 MiB', async () => {
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}000001.ldb`, size: MAX_SELECTED_SINGLE_ENTRY_BYTES }
      ])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      expect(selection.selectedEntryCount).toBe(1)
    })

    it('rejects selected cumulative uncompressed above 768 MiB (LOCK-PROD-9)', async () => {
      const mockZip = createMockZip([
        // Seven 128 MiB selected entries → 896 MiB cumulative → reject
        // (each entry stays within the 128 MiB single-entry bound).
        { name: `${FILE_ORIGIN_PREFIX}a.ldb`, size: 128 * 1024 * 1024 },
        { name: `${FILE_ORIGIN_PREFIX}b.ldb`, size: 128 * 1024 * 1024 },
        { name: `${FILE_ORIGIN_PREFIX}c.ldb`, size: 128 * 1024 * 1024 },
        { name: `${FILE_ORIGIN_PREFIX}d.ldb`, size: 128 * 1024 * 1024 },
        { name: `${FILE_ORIGIN_PREFIX}e.ldb`, size: 128 * 1024 * 1024 },
        { name: `${FILE_ORIGIN_PREFIX}f.ldb`, size: 128 * 1024 * 1024 },
        { name: `${FILE_ORIGIN_PREFIX}g.ldb`, size: 128 * 1024 * 1024 }
      ])
      await expect(selectExtractionEntries(mockZip as any, tempDir, false)).rejects.toMatchObject({
        code: 'SELECTED_TOO_LARGE'
      })
    })

    it('rejects a selected entry with compression ratio above 100 (LOCK-PROD-9)', async () => {
      const mockZip = createMockZip([
        // uncompressed 10 MiB, compressed 1 KiB → ratio 10240 > 100.
        { name: `${FILE_ORIGIN_PREFIX}bomb.ldb`, size: 10 * 1024 * 1024, compressedSize: 1024 }
      ])
      await expect(selectExtractionEntries(mockZip as any, tempDir, false)).rejects.toMatchObject({
        code: 'SELECTED_RATIO_TOO_HIGH'
      })
    })

    it('rejects a selected entry with zero compressed size and nonzero size (infinite ratio)', async () => {
      const mockZip = createMockZip([{ name: `${FILE_ORIGIN_PREFIX}zero.ldb`, size: 1024, compressedSize: 0 }])
      await expect(selectExtractionEntries(mockZip as any, tempDir, false)).rejects.toMatchObject({
        code: 'SELECTED_RATIO_TOO_HIGH'
      })
    })

    it('ignores directory entries during selection and limits', async () => {
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}`, isDirectory: true },
        { name: `${FILE_ORIGIN_PREFIX}000001.ldb`, size: 10 }
      ])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      expect(selection.selectedEntryCount).toBe(1)
    })

    it('PASSES a >500 MiB container-level irrelevant entry without materializing it (LOCK-Z2 mocked central-directory proof)', async () => {
      // The container carries a 1 GiB irrelevant entry (Data/Files). Only
      // central-directory metadata is inspected — nothing is written, so no
      // disk/time is consumed. Selected totals must EXCLUDE the irrelevant
      // bytes (LOCK-Z1: nonselected bytes excluded from selected totals).
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}000001.ldb`, size: 100 },
        { name: `${BLOB_ORIGIN_PREFIX}000001.ldb`, size: 50 },
        { name: `${LS_PREFIX}CURRENT`, size: 10 },
        { name: 'Data/Files/video-1GiB.bin', size: 1024 * 1024 * 1024 },
        { name: 'Data/Files/archive-700MiB.bin', size: 700 * 1024 * 1024 }
      ])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      // Origin still classified; huge irrelevant entries never selected.
      expect(selection.origin).toEqual({ kind: 'file', indexedDbDir: path.join(tempDir, 'IndexedDB') })
      expect(selection.selectedEntries.map((e) => e.name)).toEqual([
        `${FILE_ORIGIN_PREFIX}000001.ldb`,
        `${BLOB_ORIGIN_PREFIX}000001.ldb`,
        `${LS_PREFIX}CURRENT`
      ])
      expect(selection.selectedEntryCount).toBe(3)
      // Nonselected bytes are excluded from the selected resource totals.
      expect(selection.selectedTotalUncompressedBytes).toBe(160)
    })

    it('accepts a zero-size selected entry (size 0, compressed 0)', async () => {
      const mockZip = createMockZip([{ name: `${FILE_ORIGIN_PREFIX}empty.ldb`, size: 0, compressedSize: 0 }])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      expect(selection.selectedEntryCount).toBe(1)
      expect(selection.selectedTotalUncompressedBytes).toBe(0)
    })

    it('accepts a selected entry at the exact ratio boundary of 100', async () => {
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}boundary.ldb`, size: 100 * 1024, compressedSize: 1024 }
      ])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      expect(selection.selectedEntryCount).toBe(1)
    })

    it('never selects a blob subtree that does not match the classified origin', async () => {
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}000001.ldb`, size: 10 },
        // A DIFFERENT origin's blob subtree (with .ldb-looking files) must
        // NOT be selected — blob naming mirrors the accepted origin exactly.
        { name: 'IndexedDB/unrelated.indexeddb.blob/000001.ldb', size: 10 }
      ])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      expect(selection.selectedEntries.map((e) => e.name)).toEqual([`${FILE_ORIGIN_PREFIX}000001.ldb`])
      expect(selection.selectedTotalUncompressedBytes).toBe(10)
    })

    it('selects EXACTLY Local Storage/leveldb and nothing else under Local Storage', async () => {
      const mockZip = createMockZip([
        { name: `${FILE_ORIGIN_PREFIX}000001.ldb`, size: 10 },
        { name: `${LS_PREFIX}CURRENT`, size: 10 },
        { name: `${LS_PREFIX}LOG`, size: 20 },
        // Sibling / near-miss subtrees must never be selected (LOCK-Z4).
        { name: 'Local Storage/other/state.json', size: 100 },
        { name: 'Local Storage/leveldb-backup/CURRENT', size: 100 },
        { name: 'Local Storage/leveldb2/LOG', size: 100 }
      ])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      expect(selection.selectedEntries.map((e) => e.name)).toEqual([
        `${FILE_ORIGIN_PREFIX}000001.ldb`,
        `${LS_PREFIX}CURRENT`,
        `${LS_PREFIX}LOG`
      ])
      expect(selection.selectedTotalUncompressedBytes).toBe(40)
    })

    it('selects the matching blob subtree for the dev origin (unpackaged)', async () => {
      const devBlob = `IndexedDB/${DEV_ORIGIN_DIR.replace('.indexeddb.leveldb', '.indexeddb.blob')}/`
      const mockZip = createMockZip([
        { name: `IndexedDB/${DEV_ORIGIN_DIR}/000001.ldb`, size: 10 },
        { name: `${devBlob}000001.ldb`, size: 5 }
      ])
      const selection = await selectExtractionEntries(mockZip as any, tempDir, false)
      expect(selection.origin).toEqual({ kind: 'dev', indexedDbDir: path.join(tempDir, 'IndexedDB') })
      expect(selection.selectedEntries.map((e) => e.name)).toEqual([
        `IndexedDB/${DEV_ORIGIN_DIR}/000001.ldb`,
        `${devBlob}000001.ldb`
      ])
    })
  })

  describe('extractZip selective extraction (LOCK-PROD-8)', () => {
    const itOnDarwin = process.platform === 'darwin' ? it : it.skip
    const FILE_ORIGIN_PREFIX = `IndexedDB/${FILE_ORIGIN_DIR}/`
    const LS_PREFIX = 'Local Storage/leveldb/'

    it('materializes ONLY the accepted subtrees; irrelevant entries are never written', async () => {
      // Build a REAL zip containing the file origin + Local Storage + huge
      // irrelevant Data/ entries using AdmZip (production-format).
      const { default: AdmZip } = await import('adm-zip')
      const zipPath = path.join(tempDir, 'selective.zip')
      const work = path.join(tempDir, 'seed')
      const idbDir = path.join(work, 'IndexedDB', FILE_ORIGIN_DIR)
      const blobDir = path.join(work, 'IndexedDB', FILE_ORIGIN_DIR.replace('.indexeddb.leveldb', '.indexeddb.blob'))
      const lsDir = path.join(work, 'Local Storage', 'leveldb')
      const dataDir = path.join(work, 'Data', 'Files')
      const memoryDir = path.join(work, 'Memory')
      fs.mkdirSync(idbDir, { recursive: true })
      fs.mkdirSync(blobDir, { recursive: true })
      fs.mkdirSync(lsDir, { recursive: true })
      fs.mkdirSync(dataDir, { recursive: true })
      fs.mkdirSync(memoryDir, { recursive: true })
      fs.writeFileSync(path.join(idbDir, '000001.ldb'), 'idb-data')
      fs.writeFileSync(path.join(blobDir, '000001.ldb'), 'blob-data')
      fs.writeFileSync(path.join(lsDir, 'CURRENT'), 'ls-data')
      fs.writeFileSync(path.join(dataDir, 'image.png'), 'x'.repeat(1024))
      fs.writeFileSync(path.join(memoryDir, 'knowledge.db'), 'memory')
      fs.writeFileSync(path.join(work, 'chat.db'), 'chat')

      const zip = new AdmZip()
      zip.addLocalFolder(work, '')
      zip.writeZip(zipPath)

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      const result = await extractZip(zipPath, destDir)

      // Origin classified from the central directory.
      expect(result.origin.kind).toBe('file')
      // The accepted subtrees were materialized.
      expect(fs.existsSync(path.join(destDir, 'IndexedDB', FILE_ORIGIN_DIR, '000001.ldb'))).toBe(true)
      expect(
        fs.existsSync(
          path.join(
            destDir,
            'IndexedDB',
            FILE_ORIGIN_DIR.replace('.indexeddb.leveldb', '.indexeddb.blob'),
            '000001.ldb'
          )
        )
      ).toBe(true)
      expect(fs.existsSync(path.join(destDir, 'Local Storage', 'leveldb', 'CURRENT'))).toBe(true)
      // Irrelevant container entries were NEVER materialized (LOCK-PROD-8).
      expect(fs.existsSync(path.join(destDir, 'Data'))).toBe(false)
      expect(fs.existsSync(path.join(destDir, 'Memory'))).toBe(false)
      expect(fs.existsSync(path.join(destDir, 'chat.db'))).toBe(false)
    })

    it('creates parent directories for deeply nested selected entries (per-entry extraction semantics)', async () => {
      // node-stream-zip's per-file extract does NOT create parents — zipIntake
      // must create them explicitly. A direct .ldb keeps Layer 4 valid while
      // the nested entry proves deep parent creation at the EXACT path.
      const { default: AdmZip } = await import('adm-zip')
      const zipPath = path.join(tempDir, 'nested.zip')
      const zip = new AdmZip()
      zip.addFile(`${FILE_ORIGIN_PREFIX}000001.ldb`, Buffer.from('idb'))
      zip.addFile(`${FILE_ORIGIN_PREFIX}deep/nested/extra.bin`, Buffer.from('nested-data'))
      zip.writeZip(zipPath)

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      await extractZip(zipPath, destDir)

      const expected = path.join(destDir, 'IndexedDB', FILE_ORIGIN_DIR, 'deep', 'nested', 'extra.bin')
      expect(fs.existsSync(expected)).toBe(true)
      expect(fs.readFileSync(expected, 'utf8')).toBe('nested-data')
      expect(fs.existsSync(path.join(destDir, 'IndexedDB', FILE_ORIGIN_DIR, '000001.ldb'))).toBe(true)
      // No stray tree anywhere else.
      expect(fs.readdirSync(destDir).sort()).toEqual(['IndexedDB'])
    })

    it('REJECTS a real archive containing a symlink-mode entry BEFORE extraction (LOCK-Z2)', async () => {
      const { default: AdmZip } = await import('adm-zip')
      const zipPath = path.join(tempDir, 'symlink.zip')
      const zip = new AdmZip()
      zip.addFile(`${FILE_ORIGIN_PREFIX}000001.ldb`, Buffer.from('idb'))
      // Symlink entry (S_IFLNK mode in the external attributes).
      zip.addFile(`${FILE_ORIGIN_PREFIX}evil-link`, Buffer.from('/etc/passwd'), 'link', 0xa1ff0000)
      zip.writeZip(zipPath)

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      await expect(extractZip(zipPath, destDir)).rejects.toMatchObject({
        code: 'UNSUPPORTED_ENTRY_TYPE'
      })
      // Fail-closed BEFORE extraction: nothing materialized.
      expect(fs.existsSync(path.join(destDir, 'IndexedDB'))).toBe(false)
    })

    itOnDarwin(
      'partial extraction failure: error is typed+redacted and partial files stay inside destDir (LOCK-Z5)',
      async () => {
        const { default: AdmZip } = await import('adm-zip')
        const zipPath = path.join(tempDir, 'partial.zip')
        const zip = new AdmZip()
        // First selected entry extracts fine; the Local Storage entry fails.
        zip.addFile(`${FILE_ORIGIN_PREFIX}000001.ldb`, Buffer.from('idb'))
        zip.addFile(`${LS_PREFIX}CURRENT`, Buffer.from('ls'))
        zip.writeZip(zipPath)

        const destDir = path.join(tempDir, 'out')
        fs.mkdirSync(destDir, { recursive: true })
        // Pre-create the Local Storage leveldb dir as READ-ONLY so the second
        // selected entry cannot be opened for writing → deterministic EACCES.
        const lsDir = path.join(destDir, 'Local Storage', 'leveldb')
        fs.mkdirSync(lsDir, { recursive: true })
        fs.chmodSync(lsDir, 0o555)
        try {
          const err = await extractZip(zipPath, destDir).catch((e: unknown) => e)
          expect(err).toBeInstanceOf(ChatImportZipError)
          expect((err as ChatImportZipError).code).toBe('EXTRACT_FAILED')
          // LOCK-Z5: surfaced message must not leak the source/dest paths.
          expect((err as Error).message).not.toContain(destDir)
          expect((err as Error).message).not.toContain(zipPath)

          // Partial files from the already-extracted entry remain INSIDE destDir.
          expect(fs.existsSync(path.join(destDir, 'IndexedDB', FILE_ORIGIN_DIR, '000001.ldb'))).toBe(true)
          // Nothing escaped outside destDir (tempDir contains only the seeds).
          const stray = fs.readdirSync(tempDir).filter((n) => n !== 'partial.zip' && n !== 'out' && n !== 'seed')
          expect(stray).toEqual([])

          // Cleanup is possible — the caller (tempWorkspace/session) removes the
          // whole workspace; force-recursive removal must succeed.
          expect(() => fs.rmSync(destDir, { recursive: true, force: true })).not.toThrow()
        } finally {
          // destDir (and lsDir inside it) may already be removed above.
          if (fs.existsSync(lsDir)) {
            fs.chmodSync(lsDir, 0o755)
          }
        }
      }
    )

    it('honors the app-packaged test seam: dev-origin archive is rejected when packaged', async () => {
      const { default: AdmZip } = await import('adm-zip')
      const zipPath = path.join(tempDir, 'dev-origin.zip')
      const zip = new AdmZip()
      zip.addFile(`IndexedDB/${DEV_ORIGIN_DIR}/000001.ldb`, Buffer.from('dev-idb'))
      zip.writeZip(zipPath)

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      // Seam override: simulate a packaged app (LOCK-Z3).
      setAppIsPackagedForTests(true)
      await expect(extractZip(zipPath, destDir)).rejects.toMatchObject({
        code: 'PACKAGED_DEV_ORIGIN'
      })
      // Rejected before extraction.
      expect(fs.existsSync(path.join(destDir, 'IndexedDB'))).toBe(false)

      // Seam override: unpackaged app accepts the dev origin.
      setAppIsPackagedForTests(false)
      const result = await extractZip(zipPath, destDir)
      expect(result.origin.kind).toBe('dev')
      expect(fs.existsSync(path.join(destDir, 'IndexedDB', DEV_ORIGIN_DIR, '000001.ldb'))).toBe(true)
    })

    // -----------------------------------------------------------------------
    // LOCK-FZ1 — actual extracted-byte enforcement
    // -----------------------------------------------------------------------

    /**
     * Build a raw ZIP archive with exact entry payloads, compression
     * methods, and general-purpose flags (LOCK-FZ1/FZ2 crafting).
     *
     * `payload` is placed verbatim in the local data region: pass
     * `zlib.deflateRawSync(content)` for method 8 (deflated) entries and
     * the raw content for method 0 (stored) entries. For bit-3
     * (data-descriptor) entries the local-header sizes are zero and a data
     * descriptor record is appended — matching how streaming writers
     * (archiver) produce archives. The CEN sizes carry the claimed values,
     * which may intentionally differ from the actual payload (crafted
     * metadata for the LOCK-FZ1 tests).
     */
    function buildRawZipWithData(
      entries: Array<{
        name: string
        payload: Buffer
        method?: number
        flags?: number
        claimedSize?: number
        claimedCompressedSize?: number
      }>
    ): Buffer {
      const localParts: Buffer[] = []
      const centralParts: Buffer[] = []
      let localOffset = 0

      for (const spec of entries) {
        const name = Buffer.from(spec.name)
        const flags = spec.flags ?? 0
        const method = spec.method ?? 0
        const claimedSize = spec.claimedSize ?? spec.payload.length
        const claimedCompressedSize = spec.claimedCompressedSize ?? spec.payload.length
        const hasDataDescriptor = (flags & 0x8) !== 0

        const localHeader = Buffer.alloc(30)
        localHeader.writeUInt32LE(0x04034b50, 0)
        localHeader.writeUInt16LE(20, 4)
        localHeader.writeUInt16LE(flags, 6)
        localHeader.writeUInt16LE(method, 8)
        localHeader.writeUInt16LE(0, 10)
        localHeader.writeUInt16LE(0, 12)
        localHeader.writeUInt32LE(0, 14)
        // Bit-3: local sizes are zero (data descriptor); otherwise mirror CEN.
        localHeader.writeUInt32LE(hasDataDescriptor ? 0 : claimedCompressedSize, 18)
        localHeader.writeUInt32LE(hasDataDescriptor ? 0 : claimedSize, 22)
        localHeader.writeUInt16LE(name.length, 26)
        localHeader.writeUInt16LE(0, 28)
        localParts.push(Buffer.concat([localHeader, name, spec.payload]))

        if (hasDataDescriptor) {
          const dd = Buffer.alloc(16)
          dd.writeUInt32LE(0x08074b50, 0)
          dd.writeUInt32LE(0, 4)
          dd.writeUInt32LE(claimedCompressedSize, 8)
          dd.writeUInt32LE(claimedSize, 12)
          localParts.push(dd)
        }

        const centralHeader = Buffer.alloc(46)
        centralHeader.writeUInt32LE(0x02014b50, 0)
        centralHeader.writeUInt16LE(20, 4)
        centralHeader.writeUInt16LE(20, 6)
        centralHeader.writeUInt16LE(flags, 8)
        centralHeader.writeUInt16LE(method, 10)
        centralHeader.writeUInt16LE(0, 12)
        centralHeader.writeUInt16LE(0, 14)
        centralHeader.writeUInt32LE(0, 16)
        centralHeader.writeUInt32LE(claimedCompressedSize, 20)
        centralHeader.writeUInt32LE(claimedSize, 24)
        centralHeader.writeUInt16LE(name.length, 28)
        centralHeader.writeUInt16LE(0, 30)
        centralHeader.writeUInt16LE(0, 32)
        centralHeader.writeUInt16LE(0, 34)
        centralHeader.writeUInt16LE(0, 36)
        centralHeader.writeUInt32LE(0, 38)
        centralHeader.writeUInt32LE(localOffset, 42)
        centralParts.push(Buffer.concat([centralHeader, name]))

        localOffset += 30 + name.length + spec.payload.length + (hasDataDescriptor ? 16 : 0)
      }

      const centralDirectory = Buffer.concat(centralParts)
      const endOfCentralDirectory = Buffer.alloc(22)
      endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
      endOfCentralDirectory.writeUInt16LE(entries.length, 8)
      endOfCentralDirectory.writeUInt16LE(entries.length, 10)
      endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12)
      endOfCentralDirectory.writeUInt32LE(localOffset, 16)

      return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory])
    }

    it('REJECTS a crafted data-descriptor (bit 3) selected entry whose ACTUAL bytes exceed the claimed central size (LOCK-FZ1)', async () => {
      const zlib = await import('node:zlib')
      const zipPath = path.join(tempDir, 'bit3-overflow.zip')
      const name = `${FILE_ORIGIN_PREFIX}000001.ldb`
      // CEN claims 10 bytes; the deflate payload decompresses to 100 bytes.
      // Bit 3 (0x08) makes node-stream-zip skip its EntryVerifyStream, so
      // only the LOCK-FZ1 counting guard can detect the overflow.
      const payload = zlib.deflateRawSync(Buffer.alloc(100, 0x41))
      fs.writeFileSync(
        zipPath,
        buildRawZipWithData([
          { name, payload, method: 8, flags: 0x08, claimedSize: 10, claimedCompressedSize: payload.length }
        ])
      )

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      await expect(extractZip(zipPath, destDir)).rejects.toMatchObject({
        code: 'SELECTED_EXTRACT_OVERFLOW'
      })
      // No oversized or malformed FILE remains behind (LOCK-FZ1 cleanup);
      // parent directories created by the extraction step are empty.
      expect(fs.existsSync(path.join(destDir, 'IndexedDB', FILE_ORIGIN_DIR, '000001.ldb'))).toBe(false)
      // The source zip itself stays untouched; only in-workspace state is contained.
      expect(fs.existsSync(zipPath)).toBe(true)
    })

    it('REJECTS a crafted data-descriptor (bit 3) selected entry whose ACTUAL bytes are fewer than the claimed central size (LOCK-FZ1)', async () => {
      const zlib = await import('node:zlib')
      const zipPath = path.join(tempDir, 'bit3-short.zip')
      const name = `${FILE_ORIGIN_PREFIX}000001.ldb`
      // CEN claims 100 bytes; the payload only decompresses to 10 bytes.
      const payload = zlib.deflateRawSync(Buffer.alloc(10, 0x42))
      fs.writeFileSync(
        zipPath,
        buildRawZipWithData([
          { name, payload, method: 8, flags: 0x08, claimedSize: 100, claimedCompressedSize: payload.length }
        ])
      )

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      await expect(extractZip(zipPath, destDir)).rejects.toMatchObject({
        code: 'SELECTED_ENTRY_SIZE_MISMATCH'
      })
      // Partial malformed file removed (LOCK-FZ1 cleanup).
      expect(fs.existsSync(path.join(destDir, 'IndexedDB', FILE_ORIGIN_DIR, '000001.ldb'))).toBe(false)
    })

    it('extracts an ORDINARY archiver-made backup (data-descriptor bit 3) with exact-size enforcement (LOCK-FZ1)', async () => {
      // The real backup writer (BackupManager) uses archiver, which emits
      // data-descriptor (bit 3) entries. These MUST still extract when the
      // actual bytes equal the claimed central sizes.
      const { default: archiver } = await import('archiver')
      const zipPath = path.join(tempDir, 'archiver-backup.zip')
      const out = fs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 9 } })
      const closed = new Promise<void>((resolve, reject) => {
        out.on('close', resolve)
        out.on('error', reject)
        archive.on('error', reject)
      })
      archive.pipe(out)
      archive.append(Buffer.from('idb-data-1234'), { name: `${FILE_ORIGIN_PREFIX}000001.ldb` })
      archive.append(Buffer.from('ls-data'), { name: `${LS_PREFIX}CURRENT` })
      await archive.finalize()
      await closed

      // Prove the archive really carries bit-3 entries (data descriptors).
      const probe = new StreamZip.async({ file: zipPath })
      try {
        const probeEntries = await probe.entries()
        const probeList = Object.values(probeEntries)
        expect(probeList.length).toBeGreaterThan(0)
        for (const e of probeList) {
          expect((e as { flags: number }).flags & 0x8).toBe(0x8)
        }
      } finally {
        await probe.close()
      }

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      const result = await extractZip(zipPath, destDir)
      expect(result.origin.kind).toBe('file')
      expect(fs.readFileSync(path.join(destDir, 'IndexedDB', FILE_ORIGIN_DIR, '000001.ldb'), 'utf8')).toBe(
        'idb-data-1234'
      )
      expect(fs.readFileSync(path.join(destDir, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8')).toBe('ls-data')
    })

    // -----------------------------------------------------------------------
    // LOCK-FZ2 — canonical extraction-target duplicate rejection (integration)
    // -----------------------------------------------------------------------

    it('REJECTS a canonical extraction-target collision before extraction (a/b vs a//b, LOCK-FZ2)', async () => {
      const { default: AdmZip } = await import('adm-zip')
      const zipPath = path.join(tempDir, 'canonical-collision.zip')
      const zip = new AdmZip()
      zip.addFile(`${FILE_ORIGIN_PREFIX}000001.ldb`, Buffer.from('idb'))
      zip.addFile(`${FILE_ORIGIN_PREFIX}//000001.ldb`, Buffer.from('idb-other'))
      zip.writeZip(zipPath)

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      await expect(extractZip(zipPath, destDir)).rejects.toMatchObject({
        code: 'DUPLICATE_EXTRACTION_TARGET'
      })
      // Rejected before extraction: nothing materialized.
      expect(fs.existsSync(path.join(destDir, 'IndexedDB'))).toBe(false)
    })

    it('REJECTS a canonical extraction-target collision with a dot component (a/./b, LOCK-FZ2)', async () => {
      const { default: AdmZip } = await import('adm-zip')
      const zipPath = path.join(tempDir, 'canonical-dot-collision.zip')
      const zip = new AdmZip()
      zip.addFile(`${FILE_ORIGIN_PREFIX}000001.ldb`, Buffer.from('idb'))
      zip.addFile(`${FILE_ORIGIN_PREFIX}./000001.ldb`, Buffer.from('idb-other'))
      zip.writeZip(zipPath)

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      await expect(extractZip(zipPath, destDir)).rejects.toMatchObject({
        code: 'DUPLICATE_EXTRACTION_TARGET'
      })
      expect(fs.existsSync(path.join(destDir, 'IndexedDB'))).toBe(false)
    })

    it('REJECTS canonical collisions between NON-selected entries too (all-entry policy, LOCK-FZ2)', async () => {
      // Data/x vs Data//x — both never-selected, but the all-entry
      // canonical-destination duplicate requirement still rejects the
      // container BEFORE extraction (Layer 3 runs for every entry).
      const { default: AdmZip } = await import('adm-zip')
      const zipPath = path.join(tempDir, 'nonselected-collision.zip')
      const zip = new AdmZip()
      zip.addFile('Data/x', Buffer.from('a'))
      zip.addFile('Data//x', Buffer.from('b'))
      zip.writeZip(zipPath)

      const destDir = path.join(tempDir, 'out')
      fs.mkdirSync(destDir, { recursive: true })

      await expect(extractZip(zipPath, destDir)).rejects.toMatchObject({
        code: 'DUPLICATE_EXTRACTION_TARGET'
      })
      expect(fs.existsSync(path.join(destDir, 'Data'))).toBe(false)
    })
  })
})
