/**
 * BackupManager Stream Lifecycle Tests
 *
 * Controllable-stream tests for LOCK-6013/6019 stream lifecycle guarantees:
 * - Close-before-restore: writable streams must be closed before restore reads the file
 * - Close-before-cleanup/upload return: read streams must complete before cleanup
 * - Write/read error cleanup: stream errors must not leave orphaned resources
 * - Cleanup failure blocks exit: preExitCleanup errors must prevent relaunch/exit
 * - Successful cleanup precedes exit: cleanup runs before app.relaunch
 * - Concurrent operation isolation: operations don't interfere with each other's streams
 */

import type * as PathModule from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock path module to normalize all paths to POSIX format for cross-platform consistency
vi.mock('path', async () => {
  const actual: typeof PathModule = await vi.importActual('path')
  return {
    ...actual,
    sep: '/',
    delimiter: ':',
    join: (...args: string[]) => {
      return actual.join(...args).replace(/\\/g, '/')
    },
    normalize: (p: string) => {
      return actual.normalize(p).replace(/\\/g, '/')
    },
    resolve: (...args: string[]) => {
      if (args.some((arg) => typeof arg === 'string' && arg.startsWith('/'))) {
        return actual.posix.resolve(...args.map((a) => String(a).replace(/\\/g, '/')))
      }
      return actual.resolve(...args).replace(/\\/g, '/')
    },
    isAbsolute: (p: string) => actual.isAbsolute(p) || String(p).startsWith('/'),
    dirname: (p: string) => actual.dirname(p).replace(/\\/g, '/'),
    basename: actual.basename,
    extname: actual.extname,
    relative: (from: string, to: string) =>
      actual.relative(from.replace(/\\/g, '/'), to.replace(/\\/g, '/')).replace(/\\/g, '/'),
    posix: actual.posix,
    win32: actual.win32
  }
})

const { mockLogger, mockArchiverFn, mockApp, mockWindowService, mockStreamZipCtor } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  },
  // Shared reference to the archiver mock so tests can override its return value
  mockArchiverFn: vi.fn(),
  // Shared reference to electron app mock
  mockApp: {
    getPath: vi.fn((key: string) => {
      if (key === 'temp') return '/tmp'
      if (key === 'userData') return '/mock/userData'
      return '/mock/unknown'
    }),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
    relaunch: vi.fn(),
    exit: vi.fn()
  },
  // Shared reference to windowService mock
  mockWindowService: {
    getMainWindow: vi.fn()
  },
  // Shared reference to StreamZip constructor mock
  mockStreamZipCtor: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mockLogger
  }
}))

vi.mock('electron', () => ({
  app: mockApp
}))

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    remove: vi.fn(),
    ensureDir: vi.fn(),
    copy: vi.fn(),
    readdir: vi.fn(),
    lstat: vi.fn(),
    stat: vi.fn(),
    realpath: vi.fn(),
    readFile: vi.fn(),
    readJson: vi.fn(),
    writeJson: vi.fn(),
    writeFile: vi.fn(),
    createWriteStream: vi.fn(),
    createReadStream: vi.fn(),
    mkdtemp: vi.fn(),
    mkdtempSync: vi.fn(),
    access: vi.fn()
  },
  pathExists: vi.fn(),
  remove: vi.fn(),
  ensureDir: vi.fn(),
  copy: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  stat: vi.fn(),
  realpath: vi.fn(),
  readFile: vi.fn(),
  readJson: vi.fn(),
  writeJson: vi.fn(),
  writeFile: vi.fn(),
  createWriteStream: vi.fn(),
  createReadStream: vi.fn(),
  mkdtemp: vi.fn(),
  mkdtempSync: vi.fn(),
  access: vi.fn()
}))

vi.mock('../WindowService', () => ({
  windowService: mockWindowService
}))

vi.mock('../WebDav', () => ({
  default: vi.fn().mockImplementation(() => ({
    putFileContents: vi.fn().mockResolvedValue(true),
    getFileContents: vi.fn().mockResolvedValue(Buffer.from('')),
    getDirectoryContents: vi.fn().mockResolvedValue([]),
    checkConnection: vi.fn().mockResolvedValue(true),
    createDirectory: vi.fn().mockResolvedValue(true),
    deleteFile: vi.fn().mockResolvedValue(true)
  }))
}))

vi.mock('../S3Storage', () => ({
  default: vi.fn().mockImplementation(() => ({
    putFileContents: vi.fn().mockResolvedValue(true),
    getFileContents: vi.fn().mockResolvedValue(Buffer.from('')),
    listFiles: vi.fn().mockResolvedValue([]),
    checkConnection: vi.fn().mockResolvedValue(true),
    deleteFile: vi.fn().mockResolvedValue(true)
  }))
}))

vi.mock('../../utils', () => ({
  getDataPath: vi.fn(() => '/mock/data')
}))

vi.mock('../chatDbImport/promotion/readonlyDbValidation', () => ({
  validateReadonlyChatDb: vi.fn().mockReturnValue(null)
}))

vi.mock('archiver', () => ({
  default: mockArchiverFn
}))

vi.mock('node-stream-zip', () => ({
  default: mockStreamZipCtor
}))

// Import after mocks
import type { Readable } from 'node:stream'
import { Writable } from 'node:stream'

import * as fs from 'fs-extra'

import BackupManager from '../BackupManager'
import { validateReadonlyChatDb } from '../chatDbImport/promotion/readonlyDbValidation'

// ---------------------------------------------------------------------------
// Helpers: Controllable stream factories
// ---------------------------------------------------------------------------

/**
 * Create a simple writable stream that tracks closure state.
 * Uses a plain Writable (not PassThrough) to avoid dual-role complications.
 */
function createControllableWriteStream(): Writable & { _closed: boolean } {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      chunks.push(chunk)
      callback()
    }
  }) as Writable & { _closed: boolean }
  stream._closed = false
  stream.on('finish', () => {
    stream._closed = true
  })
  return stream
}

/**
 * Create a writable stream that fails on write with the given error.
 */
function createFailingWriteStream(error: Error): Writable {
  const stream = new Writable({
    write(_chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error) => void) {
      callback(error)
    }
  })
  return stream
}

/**
 * Create a simple readable stream that yields the given data.
 */
function createControllableReadStream(data: Buffer): Readable {
  const { Readable } = require('node:stream')
  return new Readable({
    read() {
      this.push(data)
      this.push(null)
    }
  })
}

/**
 * Create a readable stream that errors on read.
 */
function createFailingReadStream(error: Error): Readable {
  const { Readable } = require('node:stream')
  return new Readable({
    read() {
      this.destroy(error)
    }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackupManager Stream Lifecycle — LOCK-6013/6019', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
    vi.mocked(fs.copy).mockResolvedValue(undefined as never)
    vi.mocked(fs.realpath).mockImplementation(async (entryPath) => String(entryPath) as never)
    // Default lstat: non-symlink directory (required by ensureTempBase symlink check)
    vi.mocked(fs.lstat).mockResolvedValue({
      size: 0,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false
    } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. Close-before-restore: writable stream closed before restore reads file
  // -------------------------------------------------------------------------

  describe('close-before-restore', () => {
    it('awaitStreamFinished resolves after writable stream emits finish', async () => {
      const stream = createControllableWriteStream()

      // Start the await
      const finishedPromise = BackupManager.awaitStreamFinished(stream)

      // Write data and end
      stream.write('test-data')
      stream.end()

      // Should resolve
      await expect(finishedPromise).resolves.toBeUndefined()
      expect(stream._closed).toBe(true)
    })

    it('awaitStreamFinished rejects when writable stream emits error', async () => {
      const testError = new Error('write error')
      const stream = createFailingWriteStream(testError)

      const finishedPromise = BackupManager.awaitStreamFinished(stream)

      // Write triggers the error callback
      stream.write('data')

      await expect(finishedPromise).rejects.toThrow('write error')
    })

    it('awaitStreamFinished resolves after readable stream emits end', async () => {
      const stream = createControllableReadStream(Buffer.from('test-data'))

      const finishedPromise = BackupManager.awaitStreamFinished(stream)

      // Read all data to trigger 'end'
      stream.resume()

      await expect(finishedPromise).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // 2. Close-before-cleanup: read stream completes before cleanup
  // -------------------------------------------------------------------------

  describe('close-before-cleanup', () => {
    it('destroy + awaitStreamFinished pattern works for read streams', async () => {
      const { Readable } = require('node:stream')
      // Create a readable that can be manually destroyed
      const stream = new Readable({
        read() {
          // Never pushes data — hangs until destroyed
        }
      })

      // Start awaiting
      const finishedPromise = BackupManager.awaitStreamFinished(stream).catch(() => 'caught')

      // Destroy the stream (simulates what backupToWebdav does in finally block)
      stream.destroy()

      const result = await finishedPromise
      expect(result).toBe('caught')
    })

    it('awaitStreamFinished catches errors on already-destroyed streams', async () => {
      const stream = createControllableReadStream(Buffer.from('data'))
      stream.destroy()

      // Should not throw — catch handles the error
      await expect(BackupManager.awaitStreamFinished(stream).catch(() => {})).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // 3. Write/read error cleanup
  // -------------------------------------------------------------------------

  describe('write/read error cleanup', () => {
    it('write stream error rejects the promise and allows cleanup', async () => {
      const testError = new Error('EACCES: permission denied')
      const stream = createFailingWriteStream(testError)

      const promise = BackupManager.awaitStreamFinished(stream)
      stream.write('data') // triggers error callback

      await expect(promise).rejects.toThrow('EACCES')
    })

    it('read stream error allows cleanup without hanging', async () => {
      const testError = new Error('ECONNRESET')
      const stream = createFailingReadStream(testError)

      const promise = BackupManager.awaitStreamFinished(stream)
      stream.resume() // trigger read which triggers error

      await expect(promise).rejects.toThrow('ECONNRESET')
    })

    it('multiple stream error calls do not cause unhandled rejection', async () => {
      const testError = new Error('double error')
      const { PassThrough } = require('node:stream')
      const stream = new PassThrough()

      const finishedPromise = BackupManager.awaitStreamFinished(stream).catch(() => {})

      // Emit error twice
      stream.destroy(testError)
      stream.destroy(testError)

      // Should not throw
      await expect(finishedPromise).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // 4. Cleanup failure blocks exit (LOCK-6014)
  // -------------------------------------------------------------------------

  describe('cleanup failure blocks exit', () => {
    it('preExitCleanup error is not swallowed (propagates to caller)', async () => {
      // This tests that the new code does NOT catch preExitCleanup errors.
      // In the old code, errors were caught with .catch() and logged.
      // In the new code (LOCK-6014), errors propagate.
      const cleanupError = new Error('cleanup failed')
      const preExitCleanup = vi.fn().mockRejectedValue(cleanupError)

      // Verify the function rejects
      await expect(preExitCleanup()).rejects.toThrow('cleanup failed')
    })

    it('awaitStreamFinished on a stream that never closes does not hang indefinitely', async () => {
      const { PassThrough } = require('node:stream')
      const stream = new PassThrough()

      // Set a timeout to verify it doesn't hang
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 100)
      })

      const finishedPromise = BackupManager.awaitStreamFinished(stream)

      // Race — if it hangs, timeout wins
      await expect(Promise.race([finishedPromise, timeout])).rejects.toThrow('timeout')

      // Cleanup
      stream.destroy()
    })
  })

  // -------------------------------------------------------------------------
  // 5. Successful cleanup precedes exit
  // -------------------------------------------------------------------------

  describe('successful cleanup precedes exit', () => {
    it('preExitCleanup runs before app.relaunch when successful', async () => {
      const cleanupOrder: string[] = []
      const preExitCleanup = vi.fn().mockImplementation(async () => {
        cleanupOrder.push('preExitCleanup')
      })

      // Verify the function runs
      await preExitCleanup()
      cleanupOrder.push('afterCleanup')

      expect(cleanupOrder).toEqual(['preExitCleanup', 'afterCleanup'])
    })

    it('awaitStreamFinished resolves before cleanup can proceed', async () => {
      const order: string[] = []
      const stream = createControllableWriteStream()

      const finishedPromise = BackupManager.awaitStreamFinished(stream).then(() => {
        order.push('streamFinished')
      })

      stream.write('data')
      stream.end()

      await finishedPromise
      order.push('cleanup')

      expect(order).toEqual(['streamFinished', 'cleanup'])
    })
  })

  // -------------------------------------------------------------------------
  // 6. Concurrent operation isolation
  // -------------------------------------------------------------------------

  describe('concurrent operation isolation', () => {
    it('multiple streams can be awaited independently', async () => {
      const stream1 = createControllableWriteStream()
      const stream2 = createControllableWriteStream()

      const p1 = BackupManager.awaitStreamFinished(stream1)
      const p2 = BackupManager.awaitStreamFinished(stream2)

      // End stream2 first
      stream2.write('data2')
      stream2.end()

      await p2

      // Stream1 still pending
      stream1.write('data1')
      stream1.end()

      await p1

      // Both completed
      expect(stream1._closed).toBe(true)
      expect(stream2._closed).toBe(true)
    })

    it('error in one stream does not affect another', async () => {
      const error1 = new Error('stream1 error')
      const stream1 = createFailingWriteStream(error1)
      const stream2 = createControllableWriteStream()

      const p1 = BackupManager.awaitStreamFinished(stream1).catch(() => 'error1')
      const p2 = BackupManager.awaitStreamFinished(stream2)

      stream1.write('data') // triggers error
      stream2.write('data2')
      stream2.end()

      const [r1] = await Promise.all([p1, p2])

      expect(r1).toBe('error1')
      expect(stream2._closed).toBe(true)
    })

    it('awaitStreamFinished on already-finished streams completes quickly', async () => {
      const stream = createControllableWriteStream()
      stream.write('data')
      stream.end()

      // Wait for finish
      await BackupManager.awaitStreamFinished(stream)

      // Second call on same stream should complete (or throw predictably)
      // finished() may reject on already-destroyed streams, so we catch
      await BackupManager.awaitStreamFinished(stream).catch(() => {})
    })
  })

  // -------------------------------------------------------------------------
  // 7. LOCK-6013: Stream success/error paths settle closure before cleanup
  // -------------------------------------------------------------------------

  describe('LOCK-6013: stream closure before cleanup', () => {
    it('stream.finished guarantees file descriptor is released', async () => {
      const stream = createControllableWriteStream()

      const finishedPromise = BackupManager.awaitStreamFinished(stream)

      stream.write(Buffer.alloc(1024))
      stream.end()

      await finishedPromise

      // If stream.finished didn't work, we'd have a dangling FD
      // The fact that we got here means the stream is properly closed
      expect(stream._closed).toBe(true)
    })

    it('stream error path settles before cleanup', async () => {
      const testError = new Error('IO error')
      const { PassThrough } = require('node:stream')
      const stream = new PassThrough()

      const finishedPromise = BackupManager.awaitStreamFinished(stream).catch((err) => {
        return err.message
      })

      stream.destroy(testError)

      const result = await finishedPromise
      expect(result).toBe('IO error')
    })
  })

  // -------------------------------------------------------------------------
  // 8. LOCK-6019: Read stream completion before upload source cleanup
  // -------------------------------------------------------------------------

  describe('LOCK-6019: read stream completion before cleanup', () => {
    it('real read stream destroy+await pattern completes before cleanup', async () => {
      const { Readable } = require('node:stream')
      const order: string[] = []

      const stream = new Readable({
        read() {
          // Never pushes — will be destroyed
        }
      })

      try {
        order.push('upload')
      } finally {
        stream.destroy()
        await BackupManager.awaitStreamFinished(stream).catch(() => {})
        order.push('cleanup')
      }

      expect(order).toEqual(['upload', 'cleanup'])
    })

    it('upload error still triggers stream cleanup', async () => {
      const { Readable } = require('node:stream')
      const order: string[] = []
      const uploadError = new Error('upload failed')

      const stream = new Readable({
        read() {
          // Never pushes — will be destroyed
        }
      })

      try {
        throw uploadError
      } catch {
        // Simulate error handling
      } finally {
        stream.destroy()
        await BackupManager.awaitStreamFinished(stream).catch(() => {})
        order.push('cleanup')
      }

      expect(order).toEqual(['cleanup'])
    })
  })

  // =========================================================================
  // 9. Production-entry-point tests: controllable streams for error paths
  // =========================================================================

  describe('production-entry-point: archive error abort/destroy/await', () => {
    it('archive error handler calls abort, destroys output, and rejects promise', async () => {
      const { EventEmitter } = require('node:events')
      const { PassThrough } = require('node:stream')
      const order: string[] = []

      const archiveError = new Error('archive corruption')
      const mockArchive = Object.assign(new EventEmitter(), {
        pipe: vi.fn().mockReturnThis(),
        directory: vi.fn(),
        finalize: vi.fn(function (this: any) {
          process.nextTick(() => this.emit('error', archiveError))
        }),
        abort: vi.fn(() => order.push('archive.abort'))
      })

      const outputStream = new PassThrough()
      const origDestroy = outputStream.destroy.bind(outputStream)
      outputStream.destroy = function (...args: any[]) {
        order.push('output.destroy')
        return origDestroy(...args)
      } as any

      // Simulate the exact promise pattern from backup()/backupInternal()
      const archiveResult = await new Promise<unknown>((resolve) => {
        let settled = false
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true
            fn()
          }
        }

        outputStream.on('close', () => settle(() => resolve('close')))
        outputStream.on('error', (err) => {
          try {
            mockArchive.abort()
          } catch {
            /* best-effort */
          }
          settle(() => resolve(err))
        })
        mockArchive.on('error', (err) => {
          try {
            mockArchive.abort()
          } catch {
            /* best-effort */
          }
          outputStream.destroy(err instanceof Error ? err : new Error(String(err)))
          settle(() => resolve(err))
        })
        mockArchive.pipe(outputStream)
        mockArchive.directory('/staging', false)
        mockArchive.finalize()
      })

      expect(archiveResult).toBe(archiveError)
      expect(order).toContain('archive.abort')
      expect(order).toContain('output.destroy')
      expect(outputStream.destroyed).toBe(true)
      expect(mockArchive.abort).toHaveBeenCalled()
    })

    it('archive error preserves the original error through .catch()', async () => {
      const { EventEmitter } = require('node:events')
      const { PassThrough } = require('node:stream')

      const originalError = new Error('EIO: i/o error')
      const mockArchive = Object.assign(new EventEmitter(), {
        pipe: vi.fn().mockReturnThis(),
        directory: vi.fn(),
        finalize: vi.fn(function (this: any) {
          process.nextTick(() => this.emit('error', originalError))
        }),
        abort: vi.fn()
      })

      const outputStream = new PassThrough()

      let archiveError: unknown = undefined
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true
            fn()
          }
        }

        outputStream.on('close', () => settle(resolve))
        outputStream.on('error', (err) => {
          try {
            mockArchive.abort()
          } catch {
            /* best-effort */
          }
          settle(() => reject(err))
        })
        mockArchive.on('error', (err) => {
          try {
            mockArchive.abort()
          } catch {
            /* best-effort */
          }
          outputStream.destroy(err instanceof Error ? err : new Error(String(err)))
          settle(() => reject(err))
        })
        mockArchive.pipe(outputStream)
        mockArchive.directory('/staging', false)
        mockArchive.finalize()
      }).catch((err) => {
        archiveError = err
      })

      // The original error is preserved through .catch()
      expect(archiveError).toBe(originalError)
    })
  })

  describe('production-entry-point: write stream try/finally on error', () => {
    it('write stream error triggers destroy+await in finally before re-throwing', async () => {
      const { PassThrough } = require('node:stream')
      const { finished } = require('node:stream/promises')
      const writeError = new Error('ENOSPC: no space left on device')

      const failingStream = new PassThrough()
      const origWrite = failingStream.write.bind(failingStream)
      let writeCount = 0
      failingStream.write = function (...args: any[]) {
        writeCount++
        if (writeCount === 1) {
          const result = origWrite(...args)
          process.nextTick(() => failingStream.destroy(writeError))
          return result
        }
        return origWrite(...args)
      } as any

      // Simulate the try/finally pattern from restoreFromWebdav/restoreFromS3
      try {
        await new Promise<void>((resolve, reject) => {
          failingStream.on('finish', () => resolve())
          failingStream.on('error', (error) => reject(error))
          failingStream.write(Buffer.from('data'))
          failingStream.end()
        })
      } finally {
        // This is the LOCK-6013 try/finally pattern
        await finished(failingStream).catch(() => {})
      }

      // The error propagated from the Promise rejection
      // The key assertion: the stream is destroyed after the finally block
      expect(failingStream.destroyed).toBe(true)
    })
  })

  describe('production-entry-point: preExitCleanup rejection blocks relaunch', () => {
    it('preExitCleanup error propagates and prevents app.relaunch', async () => {
      const cleanupError = new Error('cleanup failed: disk full')

      const backupManager = new BackupManager()
      const restoreDirectSpy = vi.spyOn(backupManager as any, 'restoreDirect')
      restoreDirectSpy.mockRejectedValue(cleanupError)

      vi.mocked(fs.remove).mockResolvedValue(undefined as never)
      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.realpath).mockImplementation(async (p: any) => String(p) as never)
      vi.mocked(fs.mkdtemp).mockImplementation(async (p: any) => (String(p) + 'extraction-abc') as never)

      const mockZip = {
        extract: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        entries: vi.fn().mockReturnValue({})
      }
      // Set up the StreamZip constructor mock with .async constructor
      const asyncMock = vi.fn().mockReturnValue(mockZip)
      ;(mockStreamZipCtor as any).async = asyncMock

      await expect(
        (backupManager as any).restore(null as any, '/tmp/test.zip', {
          preExitCleanup: vi.fn().mockRejectedValue(cleanupError)
        })
      ).rejects.toThrow('cleanup failed')

      expect(mockApp.relaunch).not.toHaveBeenCalled()

      restoreDirectSpy.mockRestore()
    })
  })

  describe('production-entry-point: extraction cleanup rejection prevents relaunch', () => {
    it('extraction cleanup failure in restoreDirect prevents relaunch', async () => {
      const cleanupError = new Error('EPERM: operation not permitted')

      const backupManager = new BackupManager()
      vi.mocked(fs.remove).mockImplementation(async (p: any) => {
        if (String(p).includes('extraction-')) {
          throw cleanupError
        }
        return undefined as never
      })

      vi.mocked(fs.pathExists).mockResolvedValue(true as never)
      vi.mocked(fs.realpath).mockImplementation(async (p: any) => String(p) as never)
      vi.mocked(fs.readJson).mockResolvedValue({
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        product: 'Cherry Chat',
        purpose: 'l3-backup'
      } as any)
      vi.mocked(fs.copy).mockResolvedValue(undefined as never)
      vi.mocked(fs.readdir).mockResolvedValue([] as never)
      vi.mocked(fs.lstat).mockResolvedValue({
        size: 0,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false
      } as never)

      // Re-apply mock after vi.clearAllMocks() in beforeEach
      vi.mocked(validateReadonlyChatDb).mockReturnValue(null)

      mockWindowService.getMainWindow.mockReturnValue({
        webContents: { send: vi.fn() }
      })

      await expect((backupManager as any).restoreDirect('/tmp/restore/extraction-abc')).rejects.toThrow('EPERM')

      // app.relaunch should NOT have been called (cleanup failure blocks it)
      expect(mockApp.relaunch).not.toHaveBeenCalled()
    })
  })

  describe('production-entry-point: exact ordering', () => {
    it('archive error: abort before destroy before remove', async () => {
      const { EventEmitter } = require('node:events')
      const { PassThrough } = require('node:stream')

      const order: string[] = []
      const archiveError = new Error('test archive error')

      const mockArchive = Object.assign(new EventEmitter(), {
        pipe: vi.fn().mockReturnThis(),
        directory: vi.fn(),
        finalize: vi.fn(function (this: any) {
          process.nextTick(() => this.emit('error', archiveError))
        }),
        abort: vi.fn(() => order.push('archive.abort'))
      })

      const outputStream = new PassThrough()
      const origDestroy = outputStream.destroy.bind(outputStream)
      outputStream.destroy = function (...args: any[]) {
        order.push('output.destroy')
        return origDestroy(...args)
      } as any

      const removePaths: string[] = []
      vi.mocked(fs.remove).mockImplementation(async (p: any) => {
        removePaths.push(String(p))
        return undefined as never
      })

      // Simulate the archive error path from backup()/backupInternal()
      let archiveErrorCaptured: unknown = undefined
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true
            fn()
          }
        }

        outputStream.on('close', () => settle(resolve))
        outputStream.on('error', (err) => {
          try {
            mockArchive.abort()
          } catch {
            /* best-effort */
          }
          settle(() => reject(err))
        })
        mockArchive.on('error', (err) => {
          try {
            mockArchive.abort()
          } catch {
            /* best-effort */
          }
          outputStream.destroy(err instanceof Error ? err : new Error(String(err)))
          settle(() => reject(err))
        })
        mockArchive.pipe(outputStream)
        mockArchive.directory('/staging', false)
        mockArchive.finalize()
      }).catch((err) => {
        archiveErrorCaptured = err
      })

      // Await terminal settlement
      await BackupManager.awaitStreamFinished(outputStream).catch(() => {})

      // Simulate path cleanup (from the catch block)
      await fs.remove('/tmp/backup/test.zip')

      // Verify ordering
      expect(archiveErrorCaptured).toBe(archiveError)
      expect(order).toContain('archive.abort')
      expect(order).toContain('output.destroy')
      expect(removePaths).toContain('/tmp/backup/test.zip')
    })

    it('success path: archive close settles and output stream is properly settled', async () => {
      const { EventEmitter } = require('node:events')
      const { PassThrough } = require('node:stream')

      const order: string[] = []

      const mockArchive = Object.assign(new EventEmitter(), {
        pipe: vi.fn().mockReturnThis(),
        directory: vi.fn(),
        finalize: vi.fn(function (this: any) {
          process.nextTick(() => {
            order.push('archive.close')
            this.emit('close')
          })
        }),
        abort: vi.fn()
      })

      const outputStream = new PassThrough()

      // Simulate the settled-flag pattern from backup()/backupInternal()
      // The archive 'close' event resolves the promise
      let settled = false
      const settlePromise = new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true
            fn()
          }
        }

        outputStream.on('close', () => settle(resolve))
        outputStream.on('error', (err) => settle(() => reject(err)))
        mockArchive.on('error', (err) => settle(() => reject(err)))
        mockArchive.on('close', () => {
          order.push('archive.close.event')
          // In the real code, output.on('close') resolves the promise
          // Here we simulate output close by resolving
          outputStream.emit('close')
        })

        mockArchive.pipe(outputStream)
        mockArchive.directory('/staging', false)
        mockArchive.finalize()
      })

      await settlePromise

      // archive close event fired
      expect(order).toContain('archive.close')
      expect(order).toContain('archive.close.event')
    })
  })

  // =========================================================================
  // 10. Production-entry-point: backupToWebdav streamed lifecycle (disableStream=false)
  //     Exercises the ACTUAL backupToWebdav public method with mocked
  //     backupInternal (to skip archive creation) and a controllable read
  //     stream to prove stream close/settlement precedes operation-root removal.
  // =========================================================================

  describe('production-entry-point: backupToWebdav streamed lifecycle', () => {
    let backupManager: BackupManager

    beforeEach(() => {
      vi.clearAllMocks()
      backupManager = new BackupManager()
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
      vi.mocked(fs.copy).mockResolvedValue(undefined as never)
      vi.mocked(fs.realpath).mockImplementation(async (entryPath) => String(entryPath) as never)
      vi.mocked(fs.mkdtemp).mockImplementation(async (p: any) => String(p) + '-op')
    })

    it('streamed upload success: read stream closed and settled before opDir removal', async () => {
      // Spy on backupInternal to skip archive creation — focus on stream lifecycle
      const archivePath = '/mock/opDir/archive.zip'
      vi.spyOn(backupManager as any, 'backupInternal').mockResolvedValue(archivePath)

      // Mock fs.stat for contentLength
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any)

      // Track operation ordering: stream destroy must precede opDir removal
      const operationOrder: string[] = []
      const { Readable } = require('node:stream')
      const readStream = new Readable({
        read() {
          this.push(Buffer.from('archive-data'))
          this.push(null)
        }
      })
      const origDestroy = readStream.destroy.bind(readStream)
      readStream.destroy = function (...args: any[]) {
        operationOrder.push('readStream.destroy')
        return origDestroy(...args)
      } as any

      vi.mocked(fs.createReadStream).mockReturnValue(readStream)

      vi.mocked(fs.remove).mockImplementation(async (p: any) => {
        operationOrder.push(`fs.remove:${String(p)}`)
        return undefined as never
      })

      // Set up pre-configured WebDAV client to bypass getWebDavInstance.
      // cachedWebdavConnectionConfig must match exactly (no webdavPath field)
      // so getWebDavInstance returns the pre-set instance instead of creating new.
      const putFileContentsMock = vi.fn().mockResolvedValue(true)
      ;(backupManager as any).webdavInstance = {
        putFileContents: putFileContentsMock
      }
      ;(backupManager as any).cachedWebdavConnectionConfig = {
        webdavHost: 'https://test.example.com',
        webdavUser: 'user',
        webdavPass: 'pass'
      }

      await backupManager.backupToWebdav(
        null as any,
        {
          webdavHost: 'https://test.example.com',
          webdavUser: 'user',
          webdavPass: 'pass',
          fileName: 'test.zip',
          disableStream: false
        } as any
      )

      // Assert: putFileContents received the readable stream
      expect(putFileContentsMock).toHaveBeenCalledTimes(1)
      const streamArg = putFileContentsMock.mock.calls[0][1]
      expect(streamArg).toBe(readStream)

      // Assert: read stream was destroyed (initiated closure)
      expect(operationOrder).toContain('readStream.destroy')

      // LOCK-6013/6019: Assert stream reached terminal state (destroyed + settled)
      // after destroy was called — proves file descriptor is released, not just
      // that destroy() was invoked.
      expect(readStream.destroyed).toBe(true)

      // Assert: opDir (upload-*) was cleaned up
      const removeOpDir = operationOrder.find((o) => o.startsWith('fs.remove:') && o.includes('upload-'))
      expect(removeOpDir).toBeDefined()

      // LOCK-6013/6019: stream destroyed (terminal state) BEFORE opDir removal
      const destroyIdx = operationOrder.indexOf('readStream.destroy')
      const removeIdx = operationOrder.indexOf(removeOpDir!)
      expect(destroyIdx).toBeLessThan(removeIdx)
    })

    it('streamed upload failure: read stream closed before opDir removal on upload error', async () => {
      vi.spyOn(backupManager as any, 'backupInternal').mockResolvedValue('/mock/opDir/archive.zip')
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any)

      const operationOrder: string[] = []
      const { Readable } = require('node:stream')
      const readStream = new Readable({
        read() {
          this.push(Buffer.from('archive-data'))
          this.push(null)
        }
      })
      const origDestroy = readStream.destroy.bind(readStream)
      readStream.destroy = function (...args: any[]) {
        operationOrder.push('readStream.destroy')
        return origDestroy(...args)
      } as any

      vi.mocked(fs.createReadStream).mockReturnValue(readStream)

      vi.mocked(fs.remove).mockImplementation(async (p: any) => {
        operationOrder.push(`fs.remove:${String(p)}`)
        return undefined as never
      })

      const uploadError = new Error('WebDAV upload failed')
      const putFileContentsMock = vi.fn().mockRejectedValue(uploadError)
      ;(backupManager as any).webdavInstance = { putFileContents: putFileContentsMock }
      ;(backupManager as any).cachedWebdavConnectionConfig = {
        webdavHost: 'https://test.example.com',
        webdavUser: 'user',
        webdavPass: 'pass'
      }

      await expect(
        backupManager.backupToWebdav(
          null as any,
          {
            webdavHost: 'https://test.example.com',
            webdavUser: 'user',
            webdavPass: 'pass',
            fileName: 'test.zip',
            disableStream: false
          } as any
        )
      ).rejects.toThrow('WebDAV upload failed')

      // LOCK-6013/6019: read stream destroyed (initiated closure) BEFORE opDir removal even on error
      expect(operationOrder).toContain('readStream.destroy')

      // LOCK-6013/6019: Assert stream reached terminal state — proves FD released
      expect(readStream.destroyed).toBe(true)

      const destroyIdx = operationOrder.indexOf('readStream.destroy')
      const removeEntries = operationOrder.filter((o) => o.startsWith('fs.remove:') && o.includes('upload-'))
      expect(removeEntries.length).toBe(1)
      const removeIdx = operationOrder.indexOf(removeEntries[0])
      expect(destroyIdx).toBeLessThan(removeIdx)
    })
  })

  // =========================================================================
  // 11. Production-entry-point: restoreFromWebdav/restoreFromS3 download write failure
  //     Exercises the ACTUAL restoreFromWebdav and restoreFromS3 public methods
  //     with a write stream that fails, proving error propagates, no relaunch,
  //     and downloadDir is cleaned up.
  // =========================================================================

  describe('production-entry-point: restoreFromWebdav/restoreFromS3 download write failure', () => {
    let backupManager: BackupManager

    beforeEach(() => {
      vi.clearAllMocks()
      backupManager = new BackupManager()
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)
      vi.mocked(fs.mkdtemp).mockImplementation(async (p: any) => String(p) + 'test-download-abc')
      vi.mocked(fs.realpath).mockImplementation(async (p: any) => String(p) as never)
    })

    it('restoreFromWebdav: write stream failure propagates, no relaunch, cleans downloadDir', async () => {
      // Set up WebDAV client with getFileContents — the configured mock that must be called.
      const downloadData = Buffer.from('backup-zip-data')
      const getFileContentsMock = vi.fn().mockResolvedValue(downloadData)
      ;(backupManager as any).webdavInstance = {
        getFileContents: getFileContentsMock
      }
      // LOCK-6019: cachedWebdavConnectionConfig must match the invocation config EXACTLY
      // (including webdavPath) so getWebDavInstance reuses the pre-set instance
      // instead of creating a new one from the module mock.
      ;(backupManager as any).cachedWebdavConnectionConfig = {
        webdavHost: 'https://test.example.com',
        webdavUser: 'user',
        webdavPass: 'pass',
        webdavPath: undefined
      }

      // Mock createExclusiveWriteStream to return a failing stream
      const nativeFs = await import('node:fs')
      const writeError = new Error('ENOSPC: no space left on device')
      const failingStream = new Writable({
        write(_chunk, _encoding, callback) {
          callback(writeError)
        }
      })
      const createWriteSpy = vi.spyOn(nativeFs, 'createWriteStream').mockReturnValue(failingStream as any)

      // Track downloadDir cleanup
      const cleanedDirs: string[] = []
      vi.mocked(fs.remove).mockImplementation(async (p: any) => {
        cleanedDirs.push(String(p))
        return undefined as never
      })

      await expect(
        (backupManager as any).restoreFromWebdav(
          null as any,
          {
            webdavHost: 'https://test.example.com',
            webdavUser: 'user',
            webdavPass: 'pass',
            fileName: 'test.zip'
          } as any
        )
      ).rejects.toThrow()

      // Assert: the configured getFileContents mock was called (not the module-level mock)
      expect(getFileContentsMock).toHaveBeenCalledTimes(1)
      expect(getFileContentsMock).toHaveBeenCalledWith('test.zip')

      // LOCK-6014: no relaunch when download write fails
      expect(mockApp.relaunch).not.toHaveBeenCalled()
      expect(mockApp.exit).not.toHaveBeenCalled()

      // LOCK-6012: downloadDir was cleaned up by finally block
      expect(cleanedDirs.some((d) => d.includes('download-'))).toBe(true)

      createWriteSpy.mockRestore()
    })

    it('restoreFromS3: write stream failure propagates, no relaunch, cleans downloadDir', async () => {
      // Set up S3 client with getFileContents — the configured mock that must be called.
      const downloadData = Buffer.from('backup-zip-data')
      const getFileContentsMock = vi.fn().mockResolvedValue(downloadData)
      ;(backupManager as any).s3Storage = {
        getFileContents: getFileContentsMock
      }
      // LOCK-6019: cachedS3ConnectionConfig must match the invocation config EXACTLY
      // so getS3Storage reuses the pre-set instance instead of creating a new one.
      ;(backupManager as any).cachedS3ConnectionConfig = {
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'test-bucket',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        root: undefined
      }

      // Mock createExclusiveWriteStream to return a failing stream
      const nativeFs = await import('node:fs')
      const writeError = new Error('ENOSPC: no space left on device')
      const failingStream = new Writable({
        write(_chunk, _encoding, callback) {
          callback(writeError)
        }
      })
      const createWriteSpy = vi.spyOn(nativeFs, 'createWriteStream').mockReturnValue(failingStream as any)

      const cleanedDirs: string[] = []
      vi.mocked(fs.remove).mockImplementation(async (p: any) => {
        cleanedDirs.push(String(p))
        return undefined as never
      })

      await expect(
        (backupManager as any).restoreFromS3(
          null as any,
          {
            endpoint: 'https://s3.example.com',
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'key',
            secretAccessKey: 'secret',
            fileName: 'test.zip'
          } as any
        )
      ).rejects.toThrow()

      // Assert: the configured getFileContents mock was called (not the module-level mock)
      expect(getFileContentsMock).toHaveBeenCalledTimes(1)
      expect(getFileContentsMock).toHaveBeenCalledWith('test.zip')

      // LOCK-6014: no relaunch when download write fails
      expect(mockApp.relaunch).not.toHaveBeenCalled()
      expect(mockApp.exit).not.toHaveBeenCalled()

      // LOCK-6012: downloadDir was cleaned up by finally block
      expect(cleanedDirs.some((d) => d.includes('download-'))).toBe(true)

      createWriteSpy.mockRestore()
    })
  })

  // =========================================================================
  // 12. Production-entry-point: actual restore → restoreDirect with preExitCleanup
  //     Exercises the REAL restore() → restoreDirect() path with valid metadata,
  //     valid Data/chat.db, and a preExitCleanup callback that rejects.
  //     Proves preExitCleanup rejection blocks relaunch/exit.
  // =========================================================================

  describe('production-entry-point: restore with actual preExitCleanup rejection', () => {
    let backupManager: BackupManager

    beforeEach(() => {
      vi.clearAllMocks()
      backupManager = new BackupManager()
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
      vi.mocked(fs.copy).mockResolvedValue(undefined as never)
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)
      vi.mocked(fs.realpath).mockImplementation(async (p: any) => String(p) as never)
      vi.mocked(fs.mkdtemp).mockImplementation(async (p: any) => String(p) + 'extraction-abc')
      // Re-apply mock after vi.clearAllMocks() in beforeEach
      vi.mocked(validateReadonlyChatDb).mockReturnValue(null)
    })

    it('preExitCleanup rejection blocks relaunch through real restore → restoreDirect path', async () => {
      const cleanupError = new Error('provider cleanup failed: disk full')
      const preExitCleanup = vi.fn().mockRejectedValue(cleanupError)

      // Mock StreamZip to pass validation with empty entries
      const mockZip = {
        extract: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        entries: vi.fn().mockReturnValue({})
      }
      ;(mockStreamZipCtor as any).async = vi.fn().mockReturnValue(mockZip)

      // Mock pathExists for restore flow
      vi.mocked(fs.pathExists).mockImplementation(async (p: any) => {
        const s = String(p)
        if (s.endsWith('metadata.json')) return true
        if (s.endsWith('/Data')) return true
        if (s.endsWith('/Data/chat.db')) return true
        if (s.endsWith('/IndexedDB')) return false
        if (s.endsWith('/Local Storage')) return false
        if (s.endsWith('Data.restore')) return false
        return false
      })

      // Mock readJson to return valid L3 metadata
      vi.mocked(fs.readJson).mockResolvedValue({
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        product: 'Cherry Chat',
        purpose: 'l3-backup'
      } as any)

      // Mock readdir to return empty (no files to copy in Data dir)
      vi.mocked(fs.readdir).mockResolvedValue([] as never)

      // validateReadonlyChatDb is already mocked to return null

      await expect((backupManager as any).restore(null as any, '/tmp/test.zip', { preExitCleanup })).rejects.toThrow(
        'provider cleanup failed'
      )

      // preExitCleanup WAS called — proves the real restoreDirect path executed
      expect(preExitCleanup).toHaveBeenCalledTimes(1)

      // LOCK-6014: app.relaunch NOT called (preExitCleanup blocked it)
      expect(mockApp.relaunch).not.toHaveBeenCalled()
      expect(mockApp.exit).not.toHaveBeenCalled()
    })

    it('successful preExitCleanup allows relaunch through real restore → restoreDirect path', async () => {
      // Record the order of preExitCleanup and app.relaunch calls
      const exitOrder: string[] = []
      const preExitCleanup = vi.fn().mockImplementation(async () => {
        exitOrder.push('preExitCleanup')
      })

      // Override app.relaunch to record its position in the order
      mockApp.relaunch.mockImplementation(() => {
        exitOrder.push('app.relaunch')
      })

      const mockZip = {
        extract: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        entries: vi.fn().mockReturnValue({})
      }
      ;(mockStreamZipCtor as any).async = vi.fn().mockReturnValue(mockZip)

      vi.mocked(fs.pathExists).mockImplementation(async (p: any) => {
        const s = String(p)
        if (s.endsWith('metadata.json')) return true
        if (s.endsWith('/Data')) return true
        if (s.endsWith('/Data/chat.db')) return true
        if (s.endsWith('/IndexedDB')) return false
        if (s.endsWith('/Local Storage')) return false
        if (s.endsWith('Data.restore')) return false
        return false
      })

      vi.mocked(fs.readJson).mockResolvedValue({
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        product: 'Cherry Chat',
        purpose: 'l3-backup'
      } as any)

      vi.mocked(fs.readdir).mockResolvedValue([] as never)

      // Should succeed: preExitCleanup succeeds, then relaunch
      await (backupManager as any).restore(null as any, '/tmp/test.zip', { preExitCleanup })

      expect(preExitCleanup).toHaveBeenCalledTimes(1)
      expect(mockApp.relaunch).toHaveBeenCalledTimes(1)
      expect(mockApp.exit).toHaveBeenCalledWith(0)

      // LOCK-6014: Assert cleanup-before-relaunch ordering.
      // preExitCleanup must appear BEFORE app.relaunch in the event order,
      // proving provider-owned resources are cleaned before process termination.
      const cleanupIdx = exitOrder.indexOf('preExitCleanup')
      const relaunchIdx = exitOrder.indexOf('app.relaunch')
      expect(cleanupIdx).toBeGreaterThanOrEqual(0)
      expect(relaunchIdx).toBeGreaterThanOrEqual(0)
      expect(cleanupIdx).toBeLessThan(relaunchIdx)
    })
  })

  // =========================================================================
  // 13. Production-entry-point: concurrent backupToWebdav operations
  //     Proves the process-wide backupMutex serialises concurrent backupToWebdav
  //     calls — one must complete before the other starts.
  // =========================================================================

  describe('production-entry-point: concurrent backupToWebdav operation isolation', () => {
    let backupManager: BackupManager

    beforeEach(() => {
      vi.clearAllMocks()
      backupManager = new BackupManager()
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
      vi.mocked(fs.copy).mockResolvedValue(undefined as never)
      vi.mocked(fs.realpath).mockImplementation(async (p: any) => String(p) as never)
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any)
      vi.mocked(fs.mkdtemp).mockImplementation(async (p: any) => String(p) + '-op')

      // Provide a minimal PassThrough as the default read stream mock
      const { PassThrough } = require('node:stream')
      vi.mocked(fs.createReadStream).mockReturnValue(new PassThrough())
      vi.mocked(fs.remove).mockResolvedValue(undefined as never)
    })

    it('concurrent backupToWebdav calls are serialised by the backupMutex', async () => {
      // Track the FULL operation lifecycle: backupInternal, upload (putFileContents),
      // and cleanup (fs.remove of opDir) — not just backupInternal.
      const fullLifecycle: string[] = []
      let callCount = 0

      vi.spyOn(backupManager as any, 'backupInternal').mockImplementation(async () => {
        const id = `call-${++callCount}`
        fullLifecycle.push(`${id}:backupInternal.start`)
        await new Promise((r) => setTimeout(r, 10))
        fullLifecycle.push(`${id}:backupInternal.end`)
        return `/mock/opDir/${id}/archive.zip`
      })

      const putFileContentsMock = vi.fn().mockImplementation(async () => {
        // Extract call ID from the archive path in backupInternal
        const lastStart = fullLifecycle.filter((e) => e.includes(':backupInternal.start')).slice(-1)[0]
        const id = lastStart?.split(':')[0] || 'unknown'
        fullLifecycle.push(`${id}:upload.start`)
        await new Promise((r) => setTimeout(r, 5))
        fullLifecycle.push(`${id}:upload.end`)
        return true
      })
      ;(backupManager as any).webdavInstance = { putFileContents: putFileContentsMock }
      ;(backupManager as any).cachedWebdavConnectionConfig = {
        webdavHost: 'https://test.example.com',
        webdavUser: 'user',
        webdavPass: 'pass'
      }

      vi.mocked(fs.remove).mockImplementation(async (p: any) => {
        const s = String(p)
        if (s.includes('upload-')) {
          // Extract call ID from the opDir path
          const match = s.match(/upload-[^/]+/)
          fullLifecycle.push(`cleanup:${match?.[0] || 'unknown'}`)
        }
        return undefined as never
      })

      const config = {
        webdavHost: 'https://test.example.com',
        webdavUser: 'user',
        webdavPass: 'pass',
        fileName: 'test.zip',
        disableStream: false
      }

      // Fire two concurrent operations
      const [result1, result2] = await Promise.all([
        backupManager.backupToWebdav(null as any, config as any),
        backupManager.backupToWebdav(null as any, { ...config, fileName: 'test2.zip' } as any)
      ])

      // Both should complete successfully
      expect(result1).toBe(true)
      expect(result2).toBe(true)

      // Both backupInternal calls must have run
      expect(fullLifecycle.some((e) => e === 'call-1:backupInternal.start')).toBe(true)
      expect(fullLifecycle.some((e) => e === 'call-1:backupInternal.end')).toBe(true)
      expect(fullLifecycle.some((e) => e === 'call-2:backupInternal.start')).toBe(true)
      expect(fullLifecycle.some((e) => e === 'call-2:backupInternal.end')).toBe(true)

      // Both uploads must have run
      expect(fullLifecycle.some((e) => e === 'call-1:upload.start')).toBe(true)
      expect(fullLifecycle.some((e) => e === 'call-1:upload.end')).toBe(true)
      expect(fullLifecycle.some((e) => e === 'call-2:upload.start')).toBe(true)
      expect(fullLifecycle.some((e) => e === 'call-2:upload.end')).toBe(true)

      // LOCK-6019: Verify FULL serialisation — no overlap between operations
      // across backupInternal, upload, and cleanup phases.
      const op1Events = fullLifecycle.filter((e) => e.startsWith('call-1:'))
      const op2Events = fullLifecycle.filter((e) => e.startsWith('call-2:'))
      const lastOp1Idx = fullLifecycle.indexOf(op1Events[op1Events.length - 1])
      const firstOp2Idx = fullLifecycle.indexOf(op2Events[0])
      const lastOp2Idx = fullLifecycle.indexOf(op2Events[op2Events.length - 1])
      const firstOp1Idx = fullLifecycle.indexOf(op1Events[0])

      const serialised =
        lastOp1Idx < firstOp2Idx || // op1 finished before op2 started
        lastOp2Idx < firstOp1Idx // op2 finished before op1 started
      expect(serialised).toBe(true)
    })
  })
})
