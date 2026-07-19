/**
 * BackupManager Production-Path Integration Tests
 *
 * These tests exercise ACTUAL BackupManager public entry points:
 * - backup() / backupToLocalDir() for local archives
 * - backupToWebdav() for remote archives via backupInternal()
 * - handleStartupRestore() for startup restore
 *
 * with real filesystem, real archiver/StreamZip, and native better-sqlite3.
 * Only Electron path resolution, non-essential services (WindowService),
 * and remote clients (WebDAV, S3) are mocked. The chatDbService module
 * is intercepted to return a real ChatDbBackup backed by native SQLite.
 *
 * Covers:
 * - Archive produced by BackupManager.backup() contains Data/chat.db
 *   with expected committed rows and integrity_check=ok
 * - Archive excludes Data/chat.db-wal, Data/chat.db-shm, Data/chat.db.backup
 * - Output WriteStream failure rejects, staging cleaned up, mutex released
 * - backupToWebdav creates real archive via backupInternal, uploads via mock WebDAV
 * - WebDAV upload failure cleanup and mutex release
 * - handleStartupRestore marker/rename behavior
 * - ChatDbBackup.withMutex helper-level behavior (accurately labeled)
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Unmock real filesystem and OS modules for production-path tests.
// ---------------------------------------------------------------------------

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

// ---------------------------------------------------------------------------
// Hoisted mocks — available at module init time
// ---------------------------------------------------------------------------

const { mockGetPath, mockChatDbService, mockWebDavPutFileContents } = vi.hoisted(() => ({
  mockGetPath: vi.fn<(key: string) => string>((key: string) => {
    // Default values for module import time (before beforeEach sets per-test tempDir)
    if (key === 'userData') return '/tmp/bm-prod-default'
    if (key === 'temp') return '/tmp'
    return '/mock'
  }),
  mockChatDbService: {
    isInitialised: vi.fn(() => false),
    getBackup: vi.fn()
  },
  mockWebDavPutFileContents: vi.fn().mockResolvedValue(true)
}))

vi.mock('electron', () => {
  const mock = {
    app: {
      getPath: mockGetPath,
      getVersion: vi.fn(() => '1.0.0'),
      relaunch: vi.fn(),
      exit: vi.fn()
    }
  }
  return { __esModule: true, ...mock, default: mock }
})

// Mock @main/config to prevent side effects from getDataPath at import time
vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

// Mock chatDb index module — intercepts BackupManager's import of chatDbService.
// Only chatDbService is needed; ChatDbBackup/BetterSqlite3BackupAdapter are
// imported directly from '../backup' by the test and are NOT mocked.
vi.mock('../index', () => ({
  chatDbService: mockChatDbService
}))

// Mock WindowService — progress callbacks are no-ops in tests
vi.mock('../../WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn(() => null)
  }
}))

// Mock WebDav with working instance methods (putFileContents is controllable)
vi.mock('../../WebDav', () => ({
  default: vi.fn().mockImplementation(() => ({
    putFileContents: mockWebDavPutFileContents,
    getDirectoryContents: vi.fn().mockResolvedValue([]),
    checkConnection: vi.fn().mockResolvedValue(true),
    createDirectory: vi.fn().mockResolvedValue(true),
    deleteFile: vi.fn().mockResolvedValue(true),
    getFileContents: vi.fn().mockResolvedValue(Buffer.from(''))
  }))
}))

// Mock S3Storage — not exercised in these tests
vi.mock('../../S3Storage', () => ({
  default: vi.fn()
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import StreamZip from 'node-stream-zip'

import { BackupManager } from '../../BackupManager'
import { BetterSqlite3BackupAdapter, ChatDbBackup } from '../backup'
import { runMigrations } from '../migration'
import * as schema from '../schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'bm-prod-'))
}

function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}

function openTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackupManager Production-Path Integration', () => {
  let tempDir: string
  let sqlite: Database.Database

  beforeEach(() => {
    tempDir = makeTempDir()
    mockGetPath.mockImplementation((key: string): string => {
      if (key === 'userData') return tempDir
      if (key === 'temp') return realOs.tmpdir()
      return '/mock'
    })
    vi.clearAllMocks()

    // Reset WebDAV mock to clean state (clears any leftover mockRejectedValueOnce)
    mockWebDavPutFileContents.mockReset()
    mockWebDavPutFileContents.mockResolvedValue(true)

    // Create real SQLite database with test data in Data/chat.db
    const dataDir = realPath.join(tempDir, 'Data')
    realFs.mkdirSync(dataDir, { recursive: true })
    const chatDbPath = realPath.join(dataDir, 'chat.db')
    sqlite = openTestDb(chatDbPath)
    runMigrations(drizzle(sqlite, { schema }))
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`)
      .run('t1', 'Production Backup Test', new Date().toISOString())
    // NOTE: Do NOT wal_checkpoint(TRUNCATE) here — keep WAL populated so
    // chat.db-wal and chat.db-shm remain present on disk as non-empty files.
    // This ensures the archive-exclusion assertions are non-vacuous.

    // Wire mock chatDbService to real ChatDbBackup backed by test SQLite.
    // This allows BackupManager.backup() to create real snapshots via the
    // actual ChatDbBackup → BetterSqlite3BackupAdapter → better-sqlite3 path.
    const adapter = new BetterSqlite3BackupAdapter(() => sqlite)
    const chatDbBackup = new ChatDbBackup(adapter, dataDir)
    mockChatDbService.isInitialised.mockReturnValue(true)
    mockChatDbService.getBackup.mockReturnValue(chatDbBackup)
  })

  afterEach(() => {
    sqlite?.close()
    rmrf(tempDir)
  })

  // =========================================================================
  // 1. handleStartupRestore — real public static entry point
  // =========================================================================

  describe('handleStartupRestore', () => {
    it('should create marker inside Data.restore before renaming to Data', async () => {
      // Setup: empty Data directory and Data.restore with a real SQLite chat.db
      const dataDir = realPath.join(tempDir, 'Data')
      const dataRestoreDir = realPath.join(tempDir, 'Data.restore')
      realFs.mkdirSync(dataDir, { recursive: true })
      realFs.mkdirSync(dataRestoreDir, { recursive: true })

      const chatDbPath = realPath.join(dataRestoreDir, 'chat.db')
      const restoreSqlite = openTestDb(chatDbPath)
      runMigrations(drizzle(restoreSqlite, { schema }))
      restoreSqlite
        .prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`)
        .run('t1', 'Restore Test', new Date().toISOString())
      restoreSqlite.close()

      // Execute
      await BackupManager.handleStartupRestore()

      // Verify: Data.restore was consumed (renamed to Data)
      expect(realFs.existsSync(dataRestoreDir)).toBe(false)
      expect(realFs.existsSync(dataDir)).toBe(true)

      // Verify: Data/chat.db exists and is a valid SQLite database
      const restoredDbPath = realPath.join(dataDir, 'chat.db')
      expect(realFs.existsSync(restoredDbPath)).toBe(true)
      const restoredDb = new Database(restoredDbPath, { readonly: true })
      expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok')
      const topic = restoredDb.prepare('SELECT * FROM topics WHERE id = ?').get('t1') as Record<string, unknown>
      expect(topic.name).toBe('Restore Test')
      restoredDb.close()

      // Verify: Data/chat.db.restore marker exists (created BEFORE rename)
      const markerPath = realPath.join(dataDir, 'chat.db.restore')
      expect(realFs.existsSync(markerPath)).toBe(true)
      const markerContent = realFs.readFileSync(markerPath, 'utf-8')
      expect(() => new Date(markerContent)).not.toThrow()
      expect(new Date(markerContent).getTime()).not.toBeNaN()
    })

    it('should be a no-op when no .restore directories exist', async () => {
      const dataDir = realPath.join(tempDir, 'Data')
      realFs.mkdirSync(dataDir, { recursive: true })
      realFs.writeFileSync(realPath.join(dataDir, 'sentinel.txt'), 'hello')

      await BackupManager.handleStartupRestore()

      // Data directory is unchanged
      expect(realFs.existsSync(realPath.join(dataDir, 'sentinel.txt'))).toBe(true)
      expect(realFs.readFileSync(realPath.join(dataDir, 'sentinel.txt'), 'utf-8')).toBe('hello')
    })

    it('should propagate marker-write failure and NOT delete staged Data.restore', async () => {
      const dataDir = realPath.join(tempDir, 'Data')
      const dataRestoreDir = realPath.join(tempDir, 'Data.restore')
      realFs.mkdirSync(dataDir, { recursive: true })
      realFs.mkdirSync(dataRestoreDir, { recursive: true })

      const chatDbPath = realPath.join(dataRestoreDir, 'chat.db')
      const restoreSqlite = openTestDb(chatDbPath)
      runMigrations(drizzle(restoreSqlite, { schema }))
      restoreSqlite.close()

      // Make Data.restore read-only → marker write will fail with EACCES
      realFs.chmodSync(dataRestoreDir, 0o555)

      try {
        // handleStartupRestore should propagate the error
        await expect(BackupManager.handleStartupRestore()).rejects.toThrow(/Failed to create restore marker/)

        // Data.restore must NOT be deleted — retained for retry/diagnosis
        expect(realFs.existsSync(dataRestoreDir)).toBe(true)

        // Data must NOT have been replaced (marker write failed before rename)
        expect(realFs.existsSync(dataDir)).toBe(true)

        // chat.db.restore marker must NOT exist in Data
        expect(realFs.existsSync(realPath.join(dataDir, 'chat.db.restore'))).toBe(false)
      } finally {
        // Restore permissions so afterEach cleanup can delete the directory
        realFs.chmodSync(dataRestoreDir, 0o755)
      }
    })

    it('should restore Data without marker when Data.restore has no chat.db', async () => {
      const dataDir = realPath.join(tempDir, 'Data')
      const dataRestoreDir = realPath.join(tempDir, 'Data.restore')
      realFs.mkdirSync(dataDir, { recursive: true })
      realFs.mkdirSync(dataRestoreDir, { recursive: true })

      // No chat.db — just some other file
      realFs.writeFileSync(realPath.join(dataRestoreDir, 'notes.txt'), 'user data')

      await BackupManager.handleStartupRestore()

      // Data.restore was consumed
      expect(realFs.existsSync(dataRestoreDir)).toBe(false)

      // Data has the file from Data.restore
      expect(realFs.existsSync(realPath.join(dataDir, 'notes.txt'))).toBe(true)
      expect(realFs.readFileSync(realPath.join(dataDir, 'notes.txt'), 'utf-8')).toBe('user data')

      // No marker created (no chat.db in Data.restore)
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db.restore'))).toBe(false)
    })

    it('should handle IndexedDB + Data.restore together', async () => {
      // Setup: IndexedDB.restore, Local Storage.restore, and Data.restore
      const indexedDBRestore = realPath.join(tempDir, 'IndexedDB.restore')
      const lsRestore = realPath.join(tempDir, 'Local Storage.restore')
      const dataRestoreDir = realPath.join(tempDir, 'Data.restore')

      realFs.mkdirSync(indexedDBRestore, { recursive: true })
      realFs.writeFileSync(realPath.join(indexedDBRestore, 'idb-file'), 'idb data')

      realFs.mkdirSync(lsRestore, { recursive: true })
      realFs.writeFileSync(realPath.join(lsRestore, 'ls-file'), 'ls data')

      realFs.mkdirSync(dataRestoreDir, { recursive: true })
      const chatDbPath = realPath.join(dataRestoreDir, 'chat.db')
      const restoreSqlite = openTestDb(chatDbPath)
      runMigrations(drizzle(restoreSqlite, { schema }))
      restoreSqlite.close()

      await BackupManager.handleStartupRestore()

      // All .restore directories consumed
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(lsRestore)).toBe(false)
      expect(realFs.existsSync(dataRestoreDir)).toBe(false)

      // IndexedDB data restored
      expect(realFs.existsSync(realPath.join(tempDir, 'IndexedDB', 'idb-file'))).toBe(true)

      // Local Storage data restored
      expect(realFs.existsSync(realPath.join(tempDir, 'Local Storage', 'ls-file'))).toBe(true)

      // Data restored with marker
      const dataDir = realPath.join(tempDir, 'Data')
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db'))).toBe(true)
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db.restore'))).toBe(true)
    })
  })

  // =========================================================================
  // 2. BackupManager.backup() — public local entry point
  //    Invokes the ACTUAL backup() method which runs real staging,
  //    snapshot (via chatDbService.getBackup()), filtered copy, and archiving.
  // =========================================================================

  describe('BackupManager.backup() — public local entry point', () => {
    it('should produce archive with Data/chat.db containing committed rows, excluding WAL/SHM/transients', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'backups')
      realFs.mkdirSync(destDir, { recursive: true })

      // ---- Seed & verify transient files exist BEFORE backup ----
      const dataDir = realPath.join(tempDir, 'Data')

      // WAL/SHM should be present because beforeEach opened the DB in WAL
      // mode and did NOT checkpoint-truncate.
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db-wal'))).toBe(true)
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db-shm'))).toBe(true)

      // Seed chat.db.backup (transient snapshot staging artifact)
      realFs.writeFileSync(realPath.join(dataDir, 'chat.db.backup'), 'transient-snapshot-staging')
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db.backup'))).toBe(true)

      // Invoke the actual public entry point
      const archivePath = await bm.backup(null as any, 'test-backup.zip', destDir)

      // Verify archive file was created
      expect(realFs.existsSync(archivePath)).toBe(true)

      // Verify archive entries directly (before opening DB, which creates WAL/SHM)
      const zip = new StreamZip.async({ file: archivePath })
      const entries = Object.keys(await zip.entries())

      // Verify: Data/chat.db is present, WAL/SHM/transients are excluded, metadata.json present
      expect(entries).toContain('Data/chat.db')
      expect(entries).toContain('metadata.json')
      expect(entries).not.toContain('Data/chat.db-wal')
      expect(entries).not.toContain('Data/chat.db-shm')
      expect(entries).not.toContain('Data/chat.db.backup')

      // Extract and verify the database is valid with expected data
      const extractDir = realPath.join(tempDir, 'extracted')
      realFs.mkdirSync(extractDir, { recursive: true })
      await zip.extract(null, extractDir)
      await zip.close()

      const extractedDbPath = realPath.join(extractDir, 'Data', 'chat.db')
      expect(realFs.existsSync(extractedDbPath)).toBe(true)
      const extractedDb = new Database(extractedDbPath, { readonly: true })
      expect(extractedDb.pragma('integrity_check', { simple: true })).toBe('ok')
      const topic = extractedDb.prepare('SELECT * FROM topics WHERE id = ?').get('t1') as Record<string, unknown>
      expect(topic).toBeDefined()
      expect(topic.name).toBe('Production Backup Test')
      extractedDb.close()
    })

    it('should work via backupToLocalDir public entry point', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'local-backups')
      realFs.mkdirSync(destDir, { recursive: true })

      // ---- Seed & verify transient files exist BEFORE backup ----
      const dataDir = realPath.join(tempDir, 'Data')
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db-wal'))).toBe(true)
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db-shm'))).toBe(true)
      realFs.writeFileSync(realPath.join(dataDir, 'chat.db.backup'), 'transient-snapshot-staging')
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db.backup'))).toBe(true)

      // Invoke backupToLocalDir — a thin wrapper around backup()
      const archivePath = await bm.backupToLocalDir(null as any, 'local-backup.zip', {
        localBackupDir: destDir
      })

      expect(realFs.existsSync(archivePath)).toBe(true)

      // Verify archive contents via StreamZip entries
      const zip = new StreamZip.async({ file: archivePath })
      const entries = Object.keys(await zip.entries())
      expect(entries).toContain('Data/chat.db')
      expect(entries).toContain('metadata.json')
      expect(entries).not.toContain('Data/chat.db-wal')
      expect(entries).not.toContain('Data/chat.db-shm')
      expect(entries).not.toContain('Data/chat.db.backup')

      // Verify extracted chat.db integrity
      const extractDir = realPath.join(tempDir, 'local-extracted')
      realFs.mkdirSync(extractDir, { recursive: true })
      await zip.extract(null, extractDir)
      await zip.close()

      const extractedDb = new Database(realPath.join(extractDir, 'Data', 'chat.db'), { readonly: true })
      expect(extractedDb.pragma('integrity_check', { simple: true })).toBe('ok')
      const topic = extractedDb.prepare('SELECT * FROM topics WHERE id = ?').get('t1') as Record<string, unknown>
      expect(topic.name).toBe('Production Backup Test')
      extractedDb.close()
    })
  })

  // =========================================================================
  // 3. Output stream failure and mutex release via public entry point
  //    Uses a file-as-directory trick to force ENOTDIR on the archive
  //    write stream without reimplementing any archiving logic.
  // =========================================================================

  describe('BackupManager.backup() — output stream failure and mutex release', () => {
    it('should reject on write stream error, clean up staging, and allow subsequent backup', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'backups')
      realFs.mkdirSync(destDir, { recursive: true })

      // Create a FILE at the destination path (not a directory).
      // When backup() calls fs.createWriteStream(path.join(file, 'archive.zip')),
      // the stream will emit ENOTDIR because the parent is a file, not a directory.
      const fakeDestFile = realPath.join(tempDir, 'fake-dest')
      realFs.writeFileSync(fakeDestFile, '')

      // Record staging directory count before the failing backup
      const backupTempBase = realPath.join(realOs.tmpdir(), 'cherry-studio', 'backup')
      const countStagingDirs = (): number => {
        if (!realFs.existsSync(backupTempBase)) return 0
        return realFs.readdirSync(backupTempBase).filter((d) => d.startsWith('staging-')).length
      }
      const stagingBefore = countStagingDirs()

      // First backup should reject — output stream ENOTDIR error
      await expect(bm.backup(null as any, 'fail-backup.zip', fakeDestFile)).rejects.toThrow()

      // Verify staging directory was cleaned up (no new staging dirs left behind)
      expect(countStagingDirs()).toBe(stagingBefore)

      // Verify partial archive was not left behind
      expect(realFs.existsSync(realPath.join(fakeDestFile, 'fail-backup.zip'))).toBe(false)

      // Second backup to a VALID destination should succeed — proves mutex release.
      // If the mutex were stranded, this would hang forever.
      const archivePath = await bm.backup(null as any, 'success-backup.zip', destDir)
      expect(realFs.existsSync(archivePath)).toBe(true)

      // Verify the successful archive contains valid data
      const extractDir = realPath.join(tempDir, 'extracted-after-fail')
      realFs.mkdirSync(extractDir, { recursive: true })
      const zip = new StreamZip.async({ file: archivePath })
      await zip.extract(null, extractDir)
      await zip.close()

      const extractedDb = new Database(realPath.join(extractDir, 'Data', 'chat.db'), { readonly: true })
      expect(extractedDb.pragma('integrity_check', { simple: true })).toBe('ok')
      const topic = extractedDb.prepare('SELECT * FROM topics WHERE id = ?').get('t1') as Record<string, unknown>
      expect(topic.name).toBe('Production Backup Test')
      extractedDb.close()
    })
  })

  // =========================================================================
  // 4. backupToWebdav — public remote entry via backupInternal()
  //    backupInternal is private and only reachable through backupToWebdav()
  //    or backupToS3(). The WebDAV client is mocked only for upload;
  //    actual backupInternal archive creation runs with real filesystem,
  //    real archiver, and real snapshot via chatDbService.
  // =========================================================================

  describe('BackupManager.backupToWebdav() — public remote entry via backupInternal', () => {
    it('should create real archive via backupInternal and upload via WebDAV', async () => {
      // Capture the uploaded archive content from the mock WebDAV client
      let uploadedContent: Buffer | null = null
      let uploadedFilename: string | null = null

      mockWebDavPutFileContents.mockImplementation(async (filename: string, content: Buffer, _options?: any) => {
        uploadedFilename = filename
        uploadedContent = Buffer.from(content)
        return true
      })

      // ---- Seed & verify transient files exist BEFORE backup ----
      const dataDir = realPath.join(tempDir, 'Data')
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db-wal'))).toBe(true)
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db-shm'))).toBe(true)
      realFs.writeFileSync(realPath.join(dataDir, 'chat.db.backup'), 'transient-snapshot-staging')
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db.backup'))).toBe(true)

      const bm = new BackupManager()
      const webdavConfig = {
        webdavHost: 'https://test.example.com',
        webdavUser: 'user',
        webdavPass: 'pass',
        fileName: 'test-webdav-backup.zip',
        disableStream: true
      }

      await bm.backupToWebdav(null as any, webdavConfig as any)

      // Verify WebDAV upload was called
      expect(mockWebDavPutFileContents).toHaveBeenCalledTimes(1)
      expect(uploadedFilename).toBeTruthy()
      expect(uploadedContent).not.toBeNull()
      expect(uploadedContent!.length).toBeGreaterThan(0)

      // Verify archive entries directly (before opening DB, which creates WAL/SHM)
      const tempArchive = realPath.join(tempDir, 'webdav-captured.zip')
      realFs.writeFileSync(tempArchive, uploadedContent!)

      const zip = await new StreamZip.async({ file: tempArchive })
      const archiveEntries = Object.keys(await zip.entries())

      // Verify: Data/chat.db present, WAL/SHM/transients excluded, metadata.json present
      expect(archiveEntries).toContain('Data/chat.db')
      expect(archiveEntries).toContain('metadata.json')
      expect(archiveEntries).not.toContain('Data/chat.db-wal')
      expect(archiveEntries).not.toContain('Data/chat.db-shm')
      expect(archiveEntries).not.toContain('Data/chat.db.backup')

      // Extract and verify database integrity
      const extractDir = realPath.join(tempDir, 'webdav-extracted')
      realFs.mkdirSync(extractDir, { recursive: true })
      await zip.extract(null, extractDir)
      await zip.close()

      const extractedDbPath = realPath.join(extractDir, 'Data', 'chat.db')
      expect(realFs.existsSync(extractedDbPath)).toBe(true)
      const extractedDb = new Database(extractedDbPath, { readonly: true })
      expect(extractedDb.pragma('integrity_check', { simple: true })).toBe('ok')
      const topic = extractedDb.prepare('SELECT * FROM topics WHERE id = ?').get('t1') as Record<string, unknown>
      expect(topic).toBeDefined()
      expect(topic.name).toBe('Production Backup Test')
      extractedDb.close()

      // Local archive should be cleaned up by the finally block
      // (uniqueArchiveName generates a random suffix, so we can't check exact path,
      //  but the backup should have returned successfully)
    })

    it('should clean up and release mutex on WebDAV upload failure', async () => {
      // Make the WebDAV upload fail
      mockWebDavPutFileContents.mockRejectedValueOnce(new Error('WebDAV connection refused'))

      const bm = new BackupManager()
      const webdavConfig = {
        webdavHost: 'https://test.example.com',
        fileName: 'fail-webdav.zip',
        disableStream: true
      }

      // Should reject with the WebDAV error
      await expect(bm.backupToWebdav(null as any, webdavConfig as any)).rejects.toThrow('WebDAV connection refused')

      // Local archive file should be cleaned up by the finally block.
      // Verify mutex was released by doing another operation.
      mockWebDavPutFileContents.mockResolvedValue(true)

      // Subsequent backupToWebdav should succeed — proves mutex was released.
      // If the mutex were stranded, this would hang forever.
      const result = await bm.backupToWebdav(
        null as any,
        {
          ...webdavConfig,
          fileName: 'success-webdav.zip',
          disableStream: true
        } as any
      )
      expect(result).toBe(true)

      // Verify both calls happened (first failed, second succeeded)
      expect(mockWebDavPutFileContents).toHaveBeenCalledTimes(2)
    })
  })

  // =========================================================================
  // 5. ChatDbBackup.withMutex — helper-level test
  //    This tests the ChatDbBackup class directly, NOT through a public
  //    BackupManager entry point. Retained as a helper-level unit test.
  // =========================================================================

  describe('ChatDbBackup.withMutex (helper-level — not a public BackupManager entry point)', () => {
    it('should allow subsequent snapshot after a failed snapshot', async () => {
      // Create a real SQLite database separate from the beforeEach one
      const dbPath = realPath.join(tempDir, 'mutex-test-chat.db')
      const mutexSqlite = openTestDb(dbPath)
      runMigrations(drizzle(mutexSqlite, { schema }))
      mutexSqlite
        .prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`)
        .run('t1', 'Mutex Test', new Date().toISOString())

      const adapter = new BetterSqlite3BackupAdapter(() => mutexSqlite)
      const backup = new ChatDbBackup(adapter, tempDir)

      // First snapshot: should succeed
      const snap1 = realPath.join(tempDir, 'snap1.db')
      await backup.createSnapshot(snap1)
      expect(realFs.existsSync(snap1)).toBe(true)

      // Second snapshot with a failing adapter: should fail
      const failingAdapter = {
        createSnapshot: async () => {
          throw new Error('Simulated backup failure')
        },
        validateSnapshot: async () => 'ok' as const
      }
      const failingBackup = new ChatDbBackup(failingAdapter, tempDir)
      const snap2 = realPath.join(tempDir, 'snap2.db')
      await expect(failingBackup.createSnapshot(snap2)).rejects.toThrow('Simulated backup failure')

      // Third snapshot: must succeed (mutex was released after failure)
      const snap3 = realPath.join(tempDir, 'snap3.db')
      await backup.createSnapshot(snap3)
      expect(realFs.existsSync(snap3)).toBe(true)

      // Verify the third snapshot is valid
      const snapDb = new Database(snap3, { readonly: true })
      expect(snapDb.pragma('integrity_check', { simple: true })).toBe('ok')
      const topic = snapDb.prepare('SELECT * FROM topics WHERE id = ?').get('t1') as Record<string, unknown>
      expect(topic.name).toBe('Mutex Test')
      snapDb.close()

      mutexSqlite.close()
    })
  })
})
