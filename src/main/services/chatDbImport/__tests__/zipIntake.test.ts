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

import { ChatImportZipError } from '../errors'
import {
  MAX_ENTRY_COUNT,
  MAX_SINGLE_ENTRY_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ZIP_SIZE_BYTES,
  sanitizeEntryNameForMessage,
  validateFileStat,
  validateIndexedDbStructure
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
        'NOT_A_FILE'
      ] as const
      for (const code of codes) {
        const error = new ChatImportZipError(code, 'test')
        expect(error.code).toBe(code)
      }
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
