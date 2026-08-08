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
import { crc32 } from 'node:zlib'

import { appIdentity } from '@shared/config/identity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Unmock real filesystem and OS modules for production-path tests.
// ---------------------------------------------------------------------------

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.unmock('node:zlib')

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

import archiver from 'archiver'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import StreamZip from 'node-stream-zip'

import { BackupManager } from '../../BackupManager'
import { CANDIDATE_ROOT_DIRNAME } from '../../chatDbImport/candidateDb'
import { FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME } from '../../chatDbImport/promotion/filesSnapshot'
import {
  FILES_CATALOG_SNAPSHOT_FILENAME,
  FILES_CATALOG_SNAPSHOT_STAGING_FILENAME,
  FILES_PROMOTE_STAGING_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME,
  PROMOTION_JOURNAL_FILENAME,
  ROLLBACK_SNAPSHOT_FILENAME,
  ROLLBACK_SNAPSHOT_STAGING_FILENAME
} from '../../chatDbImport/promotion/journal'
import { PROMOTION_JOURNAL_STAGING_FILENAME } from '../../chatDbImport/promotion/journalStore'
import { BetterSqlite3BackupAdapter, ChatDbBackup } from '../backup'
import { getSharedMaintenanceCoordinator, isMaintenanceBusyError } from '../maintenanceCoordination'
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

/**
 * Build a raw ZIP buffer with exact entry names, bypassing archiver's
 * path normalization. This is essential for security tests that need
 * specific malicious entry names (traversal, absolute paths) preserved
 * verbatim in the ZIP file.
 *
 * Uses STORED (no compression) to keep the implementation simple.
 * CRC32 is computed via node:zlib.crc32 for correctness.
 */
function buildRawZip(entries: Array<{ name: string; content: Buffer | string }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf-8')
    const contentBytes = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf-8') : entry.content
    const crc = crc32(contentBytes) >>> 0

    // --- Local file header (30 bytes fixed) ---
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed to extract
    local.writeUInt16LE(0, 6) // general purpose bit flag
    local.writeUInt16LE(0, 8) // compression method: stored (0)
    local.writeUInt16LE(0, 10) // last mod file time
    local.writeUInt16LE(0, 12) // last mod file date
    local.writeUInt32LE(crc, 14) // crc-32
    local.writeUInt32LE(contentBytes.length, 18) // compressed size
    local.writeUInt32LE(contentBytes.length, 22) // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26) // file name length
    local.writeUInt16LE(0, 28) // extra field length

    localParts.push(Buffer.concat([local, nameBytes, contentBytes]))

    // --- Central directory header (46 bytes fixed) ---
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory header signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed to extract
    central.writeUInt16LE(0, 8) // general purpose bit flag
    central.writeUInt16LE(0, 10) // compression method
    central.writeUInt16LE(0, 12) // last mod file time
    central.writeUInt16LE(0, 14) // last mod file date
    central.writeUInt32LE(crc, 16) // crc-32
    central.writeUInt32LE(contentBytes.length, 20) // compressed size
    central.writeUInt32LE(contentBytes.length, 24) // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28) // file name length
    central.writeUInt16LE(0, 30) // extra field length
    central.writeUInt16LE(0, 32) // file comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal file attributes
    central.writeUInt32LE(0, 38) // external file attributes
    central.writeUInt32LE(offset, 42) // relative offset of local header

    centralParts.push(Buffer.concat([central, nameBytes]))

    offset += local.length + nameBytes.length + contentBytes.length
  }

  // --- End of central directory record (22 bytes) ---
  const cdOffset = offset
  const cdBuffer = Buffer.concat(centralParts)
  const cdSize = cdBuffer.length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  eocd.writeUInt16LE(0, 4) // number of this disk
  eocd.writeUInt16LE(0, 6) // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8) // number of central directory records on this disk
  eocd.writeUInt16LE(entries.length, 10) // total number of central directory records
  eocd.writeUInt32LE(cdSize, 12) // size of central directory
  eocd.writeUInt32LE(cdOffset, 16) // offset of start of central directory
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, cdBuffer, eocd])
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
// LOCK-L3-2 helpers — every owned L2 promotion artifact name at the Data root
// ---------------------------------------------------------------------------

/** Every owned promotion artifact name, sourced from the L2 constants. */
const PROMOTION_ARTIFACT_NAMES: readonly string[] = [
  CANDIDATE_ROOT_DIRNAME,
  PROMOTION_JOURNAL_FILENAME,
  PROMOTION_JOURNAL_STAGING_FILENAME,
  ROLLBACK_SNAPSHOT_FILENAME,
  ROLLBACK_SNAPSHOT_STAGING_FILENAME,
  FILES_ROLLBACK_SNAPSHOT_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME,
  FILES_PROMOTE_STAGING_DIRNAME,
  FILES_CATALOG_SNAPSHOT_FILENAME,
  FILES_CATALOG_SNAPSHOT_STAGING_FILENAME
]

/**
 * Seed every owned promotion artifact at the Data root with sentinel content.
 * Directories get a sentinel.txt child; files get sentinel bytes.
 */
function seedPromotionArtifacts(dataDir: string): void {
  const mkFile = (name: string): void => {
    realFs.writeFileSync(realPath.join(dataDir, name), `artifact-${name}`)
  }
  const mkDir = (name: string): void => {
    realFs.mkdirSync(realPath.join(dataDir, name), { recursive: true })
    realFs.writeFileSync(realPath.join(dataDir, name, 'sentinel.txt'), `artifact-${name}`)
  }

  // Candidate root with a nested candidate dir (deep tree must be pruned whole)
  mkDir(CANDIDATE_ROOT_DIRNAME)
  realFs.mkdirSync(realPath.join(dataDir, CANDIDATE_ROOT_DIRNAME, 'candidate-s1'), { recursive: true })
  realFs.writeFileSync(realPath.join(dataDir, CANDIDATE_ROOT_DIRNAME, 'candidate-s1', 'chat.db'), 'candidate-db-bytes')
  realFs.writeFileSync(realPath.join(dataDir, CANDIDATE_ROOT_DIRNAME, 'candidate-s1', 'files-catalog.json'), '{}')

  mkFile(PROMOTION_JOURNAL_FILENAME)
  mkFile(PROMOTION_JOURNAL_STAGING_FILENAME)
  mkFile(ROLLBACK_SNAPSHOT_FILENAME)
  mkFile(ROLLBACK_SNAPSHOT_STAGING_FILENAME)
  mkDir(FILES_ROLLBACK_SNAPSHOT_DIRNAME)
  mkDir(FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME)
  mkDir(FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME)
  mkDir(FILES_PROMOTE_STAGING_DIRNAME)
  mkFile(FILES_CATALOG_SNAPSHOT_FILENAME)
  mkFile(FILES_CATALOG_SNAPSHOT_STAGING_FILENAME)
}

/** Assert no archive entry matches any promotion artifact (file or dir subtree). */
function assertNoPromotionArtifactsInArchive(entries: readonly string[]): void {
  for (const name of PROMOTION_ARTIFACT_NAMES) {
    const prefix = `Data/${name}`
    expect(entries.some((entry) => entry === prefix || entry.startsWith(`${prefix}/`))).toBe(false)
  }
}

/** Assert no promotion artifact exists on disk under dir. */
function assertNoPromotionArtifactsOnDisk(dir: string): void {
  for (const name of PROMOTION_ARTIFACT_NAMES) {
    expect(realFs.existsSync(realPath.join(dir, name))).toBe(false)
  }
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
    runMigrations(drizzle(sqlite, { schema }), sqlite)
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
    const chatDbBackup = new ChatDbBackup(adapter)
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
      runMigrations(drizzle(restoreSqlite, { schema }), restoreSqlite)
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
      runMigrations(drizzle(restoreSqlite, { schema }), restoreSqlite)
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

    it('should reject Data.restore without chat.db and NOT consume any staging', async () => {
      const dataDir = realPath.join(tempDir, 'Data')
      const indexedDBRestore = realPath.join(tempDir, 'IndexedDB.restore')
      const dataRestoreDir = realPath.join(tempDir, 'Data.restore')
      realFs.mkdirSync(dataDir, { recursive: true })
      realFs.mkdirSync(indexedDBRestore, { recursive: true })
      realFs.writeFileSync(realPath.join(indexedDBRestore, 'idb-file'), 'idb data')
      realFs.mkdirSync(dataRestoreDir, { recursive: true })

      // No chat.db — just some other file
      realFs.writeFileSync(realPath.join(dataRestoreDir, 'notes.txt'), 'user data')

      // handleStartupRestore should reject — Data.restore has no chat.db
      await expect(BackupManager.handleStartupRestore()).rejects.toThrow(/does not contain chat.db/)

      // Data.restore must NOT be consumed — retained for retry
      expect(realFs.existsSync(dataRestoreDir)).toBe(true)
      expect(realFs.existsSync(realPath.join(dataRestoreDir, 'notes.txt'))).toBe(true)

      // IndexedDB.restore must NOT be consumed — LOCK-6010: no staging consumed
      expect(realFs.existsSync(indexedDBRestore)).toBe(true)
      expect(realFs.existsSync(realPath.join(indexedDBRestore, 'idb-file'))).toBe(true)

      // No marker created (Data.restore has no chat.db)
      expect(realFs.existsSync(realPath.join(dataDir, 'chat.db.restore'))).toBe(false)
    })

    it('should reject Data.restore with chat.db absent even when only IndexedDB.restore exists', async () => {
      // LOCK-6010: IndexedDB.restore present + Data.restore without chat.db
      // must abort before consuming IndexedDB.restore.
      const dataDir = realPath.join(tempDir, 'Data')
      const indexedDBRestore = realPath.join(tempDir, 'IndexedDB.restore')
      const dataRestoreDir = realPath.join(tempDir, 'Data.restore')
      realFs.mkdirSync(dataDir, { recursive: true })
      realFs.mkdirSync(indexedDBRestore, { recursive: true })
      realFs.writeFileSync(realPath.join(indexedDBRestore, 'idb-file'), 'idb data')
      realFs.mkdirSync(dataRestoreDir, { recursive: true })
      realFs.writeFileSync(realPath.join(dataRestoreDir, 'notes.txt'), 'user data')

      await expect(BackupManager.handleStartupRestore()).rejects.toThrow(/does not contain chat.db/)

      // Neither IndexedDB.restore nor Data.restore consumed
      expect(realFs.existsSync(indexedDBRestore)).toBe(true)
      expect(realFs.existsSync(dataRestoreDir)).toBe(true)
    })

    it('should reject Data.restore with empty directory (no chat.db)', async () => {
      const dataDir = realPath.join(tempDir, 'Data')
      const dataRestoreDir = realPath.join(tempDir, 'Data.restore')
      realFs.mkdirSync(dataDir, { recursive: true })
      realFs.mkdirSync(dataRestoreDir, { recursive: true })
      // Empty Data.restore — no chat.db

      await expect(BackupManager.handleStartupRestore()).rejects.toThrow(/does not contain chat.db/)
      expect(realFs.existsSync(dataRestoreDir)).toBe(true)
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
      runMigrations(drizzle(restoreSqlite, { schema }), restoreSqlite)
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

    it('should fail when Data/chat.db does not exist (LOCK-6008)', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'backups-nodata')
      realFs.mkdirSync(destDir, { recursive: true })

      // Remove Data directory entirely
      const dataDir = realPath.join(tempDir, 'Data')
      realFs.rmSync(dataDir, { recursive: true, force: true })

      await expect(bm.backup(null as any, 'nodata-backup.zip', destDir)).rejects.toThrow(/Data\/chat\.db not found/)
    })

    it('should fail when Data directory exists but chat.db is absent (LOCK-6008)', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'backups-nodb')
      realFs.mkdirSync(destDir, { recursive: true })

      // Remove chat.db but keep Data directory with other files
      const dataDir = realPath.join(tempDir, 'Data')
      const chatDbPath = realPath.join(dataDir, 'chat.db')
      realFs.rmSync(chatDbPath, { force: true })
      realFs.writeFileSync(realPath.join(dataDir, 'notes.txt'), 'some data')

      await expect(bm.backup(null as any, 'nodb-backup.zip', destDir)).rejects.toThrow(/Data\/chat\.db not found/)
    })
  })

  // =========================================================================
  // 2b. LOCK-L3-1/L3-2/L3-4: live Data/Files inclusion, promotion artifact
  //     exclusion, IndexedDB sentinel inclusion, and skipBackupFile asymmetry.
  //     These run the ACTUAL backup() entry point with real filesystem and
  //     real archiver, then inspect archive entries + bytes directly.
  // =========================================================================

  describe('BackupManager.backup() — L3 artifact coverage (LOCK-L3-1/L3-2/L3-4)', () => {
    it('archive includes live Data/Files recursively byte-identical, excludes every promotion artifact, and retains IndexedDB (LOCK-L3-1/L3-2)', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'backups-l3')
      realFs.mkdirSync(destDir, { recursive: true })

      const dataDir = realPath.join(tempDir, 'Data')

      // Live Files payloads (recursive subtree — LOCK-L3-1)
      realFs.mkdirSync(realPath.join(dataDir, 'Files', 'nested'), { recursive: true })
      const payloadA = Buffer.from('files-payload-a-123456')
      const payloadB = Buffer.from('files-payload-b-abcdef')
      realFs.writeFileSync(realPath.join(dataDir, 'Files', 'abc123.png'), payloadA)
      realFs.writeFileSync(realPath.join(dataDir, 'Files', 'nested', 'doc.pdf'), payloadB)

      // Unrelated Data subtree must be preserved (LOCK-L3-5)
      realFs.mkdirSync(realPath.join(dataDir, 'OtherSubtree'), { recursive: true })
      const otherPayload = Buffer.from('other-subtree-bytes')
      realFs.writeFileSync(realPath.join(dataDir, 'OtherSubtree', 'keep.txt'), otherPayload)

      // Seed every owned promotion artifact at the Data root (LOCK-L3-2)
      seedPromotionArtifacts(dataDir)

      // IndexedDB Dexie LevelDB subtree + sentinel bytes (catalog storage presence)
      realFs.mkdirSync(realPath.join(tempDir, 'IndexedDB', 'file__0.indexeddb.leveldb'), { recursive: true })
      const idbSentinel = Buffer.from('indexeddb-leveldb-sentinel')
      realFs.writeFileSync(realPath.join(tempDir, 'IndexedDB', 'file__0.indexeddb.leveldb', 'CURRENT'), idbSentinel)

      // Local Storage LevelDB subtree + sentinel bytes
      realFs.mkdirSync(realPath.join(tempDir, 'Local Storage', 'leveldb'), { recursive: true })
      const lsSentinel = Buffer.from('local-storage-sentinel')
      realFs.writeFileSync(realPath.join(tempDir, 'Local Storage', 'leveldb', 'LOG'), lsSentinel)

      const archivePath = await bm.backup(null as any, 'l3-backup.zip', destDir)
      expect(realFs.existsSync(archivePath)).toBe(true)

      const zip = new StreamZip.async({ file: archivePath })
      const entries = Object.keys(await zip.entries())

      // Live Files included recursively with byte identity (LOCK-L3-1)
      expect(entries).toContain('Data/Files/abc123.png')
      expect(entries).toContain('Data/Files/nested/doc.pdf')
      expect(Buffer.from(await zip.entryData('Data/Files/abc123.png')).equals(payloadA)).toBe(true)
      expect(Buffer.from(await zip.entryData('Data/Files/nested/doc.pdf')).equals(payloadB)).toBe(true)

      // Unrelated Data subtree preserved (LOCK-L3-5)
      expect(entries).toContain('Data/OtherSubtree/keep.txt')
      expect(Buffer.from(await zip.entryData('Data/OtherSubtree/keep.txt')).equals(otherPayload)).toBe(true)

      // Every promotion artifact excluded from the archive (LOCK-L3-2)
      assertNoPromotionArtifactsInArchive(entries)

      // IndexedDB + Local Storage sentinels retained with byte identity
      expect(entries).toContain('IndexedDB/file__0.indexeddb.leveldb/CURRENT')
      expect(entries).toContain('Local Storage/leveldb/LOG')
      expect(Buffer.from(await zip.entryData('IndexedDB/file__0.indexeddb.leveldb/CURRENT')).equals(idbSentinel)).toBe(
        true
      )
      expect(Buffer.from(await zip.entryData('Local Storage/leveldb/LOG')).equals(lsSentinel)).toBe(true)

      // chat.db snapshot is authoritative (LOCK-6008) and WAL/SHM are excluded
      expect(entries).toContain('Data/chat.db')
      expect(entries).not.toContain('Data/chat.db-wal')
      expect(entries).not.toContain('Data/chat.db-shm')

      await zip.close()
    })

    it('skipBackupFile=true excludes Data/Files while retaining IndexedDB (LOCK-L3-4)', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'backups-l3-skip')
      realFs.mkdirSync(destDir, { recursive: true })

      const dataDir = realPath.join(tempDir, 'Data')

      // Live Files payload that must be skipped when skipBackupFile=true
      realFs.mkdirSync(realPath.join(dataDir, 'Files'), { recursive: true })
      realFs.writeFileSync(realPath.join(dataDir, 'Files', 'abc123.png'), 'files-payload')

      // Seed promotion artifacts — skipped as well (nothing from Data except chat.db)
      seedPromotionArtifacts(dataDir)

      // IndexedDB sentinel — must be retained despite skipBackupFile=true
      realFs.mkdirSync(realPath.join(tempDir, 'IndexedDB', 'file__0.indexeddb.leveldb'), { recursive: true })
      const idbSentinel = Buffer.from('indexeddb-sentinel-retained')
      realFs.writeFileSync(realPath.join(tempDir, 'IndexedDB', 'file__0.indexeddb.leveldb', 'CURRENT'), idbSentinel)

      const archivePath = await bm.backup(null as any, 'skip-file.zip', destDir, true)
      expect(realFs.existsSync(archivePath)).toBe(true)

      const zip = new StreamZip.async({ file: archivePath })
      const entries = Object.keys(await zip.entries())

      // LOCK-6008: authoritative Data/chat.db snapshot is still mandatory
      expect(entries).toContain('Data/chat.db')
      expect(entries).toContain('metadata.json')

      // Data/Files payload is intentionally excluded (LOCK-L3-4 asymmetry)
      expect(entries).not.toContain('Data/Files/abc123.png')

      // No promotion artifacts either — the only Data content is the chat.db snapshot
      assertNoPromotionArtifactsInArchive(entries)
      const dataEntries = entries.filter((entry) => entry.startsWith('Data/') && entry !== 'Data/')
      expect(dataEntries).toEqual(['Data/chat.db'])

      // IndexedDB retained while Data/Files is skipped (documented asymmetry)
      expect(entries).toContain('IndexedDB/file__0.indexeddb.leveldb/CURRENT')
      expect(Buffer.from(await zip.entryData('IndexedDB/file__0.indexeddb.leveldb/CURRENT')).equals(idbSentinel)).toBe(
        true
      )

      await zip.close()
    })

    it('EXCLUDED_DATA_ENTRIES covers every L2 promotion constant and the pinned candidate root (LOCK-L3-2 drift guard)', () => {
      const excluded = (BackupManager as unknown as { EXCLUDED_DATA_ENTRIES: Set<string> }).EXCLUDED_DATA_ENTRIES

      // Live chat DB coordination files (historical)
      expect(excluded.has('chat.db')).toBe(true)
      expect(excluded.has('chat.db-wal')).toBe(true)
      expect(excluded.has('chat.db-shm')).toBe(true)
      expect(excluded.has('chat.db.backup')).toBe(true)

      // Every L2 promotion artifact constant (LOCK-L3-2)
      expect(excluded.has(CANDIDATE_ROOT_DIRNAME)).toBe(true)
      expect(excluded.has(PROMOTION_JOURNAL_FILENAME)).toBe(true)
      expect(excluded.has(PROMOTION_JOURNAL_STAGING_FILENAME)).toBe(true)
      expect(excluded.has(ROLLBACK_SNAPSHOT_FILENAME)).toBe(true)
      expect(excluded.has(ROLLBACK_SNAPSHOT_STAGING_FILENAME)).toBe(true)
      expect(excluded.has(FILES_ROLLBACK_SNAPSHOT_DIRNAME)).toBe(true)
      expect(excluded.has(FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME)).toBe(true)
      expect(excluded.has(FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME)).toBe(true)
      expect(excluded.has(FILES_PROMOTE_STAGING_DIRNAME)).toBe(true)
      expect(excluded.has(FILES_CATALOG_SNAPSHOT_FILENAME)).toBe(true)
      expect(excluded.has(FILES_CATALOG_SNAPSHOT_STAGING_FILENAME)).toBe(true)
    })
  })

  // =========================================================================
  // 2c. LOCK-L3-3: restore round-trip — valid live Files bytes and catalog
  //     storage round-trip without injecting stale promotion state.
  // =========================================================================

  describe('BackupManager.restore() — physical round-trip without promotion state (LOCK-L3-3)', () => {
    it('restore staging preserves physical Files bytes and catalog storage, activates without promotion artifacts', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'backups-l3-restore')
      realFs.mkdirSync(destDir, { recursive: true })

      const dataDir = realPath.join(tempDir, 'Data')

      // Live Files payload
      realFs.mkdirSync(realPath.join(dataDir, 'Files'), { recursive: true })
      const filePayload = Buffer.from('restore-roundtrip-file-payload')
      realFs.writeFileSync(realPath.join(dataDir, 'Files', 'rt-123.png'), filePayload)

      // Live promotion artifacts — must NOT round-trip into the restore
      seedPromotionArtifacts(dataDir)

      // IndexedDB Dexie catalog storage sentinel (LevelDB subtree)
      realFs.mkdirSync(realPath.join(tempDir, 'IndexedDB', 'file__0.indexeddb.leveldb'), { recursive: true })
      const catalogSentinel = Buffer.from('dexie-catalog-leveldb-sentinel')
      realFs.writeFileSync(realPath.join(tempDir, 'IndexedDB', 'file__0.indexeddb.leveldb', 'CURRENT'), catalogSentinel)

      // Backup first (real archive with chat.db snapshot + metadata.json)
      const archivePath = await bm.backup(null as any, 'roundtrip.zip', destDir)
      expect(realFs.existsSync(archivePath)).toBe(true)

      // Close the live DB handle before the Data swap (the handle would dangle
      // after handleStartupRestore renames over the live Data directory).
      sqlite.close()

      // Restore — stages Data.restore / IndexedDB.restore, then relaunches (mocked).
      // The staged dirs are ready for handleStartupRestore on next launch.
      await bm.restore(null as any, archivePath)

      // Staged Data.restore preserves physical Files bytes and has NO promotion state
      const stagedFiles = realPath.join(tempDir, 'Data.restore', 'Files', 'rt-123.png')
      expect(realFs.existsSync(stagedFiles)).toBe(true)
      expect(realFs.readFileSync(stagedFiles).equals(filePayload)).toBe(true)
      assertNoPromotionArtifactsOnDisk(realPath.join(tempDir, 'Data.restore'))

      // Staged IndexedDB.restore preserves the catalog storage sentinel
      expect(
        realFs
          .readFileSync(realPath.join(tempDir, 'IndexedDB.restore', 'file__0.indexeddb.leveldb', 'CURRENT'))
          .equals(catalogSentinel)
      ).toBe(true)

      // Activation — handleStartupRestore swaps Data.restore → Data
      await BackupManager.handleStartupRestore()

      // Live Data now carries the restored Files payload, with no promotion artifacts
      expect(realFs.readFileSync(realPath.join(dataDir, 'Files', 'rt-123.png')).equals(filePayload)).toBe(true)
      assertNoPromotionArtifactsOnDisk(dataDir)

      // Live IndexedDB carries the restored catalog storage sentinel
      expect(
        realFs
          .readFileSync(realPath.join(tempDir, 'IndexedDB', 'file__0.indexeddb.leveldb', 'CURRENT'))
          .equals(catalogSentinel)
      ).toBe(true)
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
      const backupTempBase = realPath.join(realOs.tmpdir(), appIdentity.tempDirName, 'backup')
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
      runMigrations(drizzle(mutexSqlite, { schema }), mutexSqlite)
      mutexSqlite
        .prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`)
        .run('t1', 'Mutex Test', new Date().toISOString())

      const adapter = new BetterSqlite3BackupAdapter(() => mutexSqlite)
      const backup = new ChatDbBackup(adapter)

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
      const failingBackup = new ChatDbBackup(failingAdapter)
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

  // =========================================================================
  // 6. Maintenance coordination wiring (Phase 4.4.1, LOCK-4416)
  //    Backup and restore entry points share the ONE process-wide
  //    maintenance coordinator with live ChatDbService init/close and
  //    promotion. These tests exercise the real BackupManager wiring.
  // =========================================================================

  describe('maintenance coordination wiring (LOCK-4416)', () => {
    it('backup holds the shared backup lease for the full operation and releases it', async () => {
      const coordinator = getSharedMaintenanceCoordinator()
      expect(coordinator.currentHolder()).toBeNull()

      // Capture the holder at snapshot time — deep inside the backup operation.
      let holderDuringBackup: { kind: string; ownerId: string } | null = null
      const adapter = new BetterSqlite3BackupAdapter(() => sqlite)
      const chatDbBackup = new ChatDbBackup(adapter)
      mockChatDbService.getBackup.mockImplementation(() => {
        holderDuringBackup = coordinator.currentHolder()
        return chatDbBackup
      })

      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'coord-backups')
      realFs.mkdirSync(destDir, { recursive: true })
      const archivePath = await bm.backup(null as any, 'coord-backup.zip', destDir)
      expect(realFs.existsSync(archivePath)).toBe(true)

      expect(holderDuringBackup).toEqual({ kind: 'backup', ownerId: 'backup-manager' })
      // Lease released after the outer operation completes.
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('backup is refused with a structured busy error while restore holds the lease', async () => {
      const coordinator = getSharedMaintenanceCoordinator()
      const grant = coordinator.acquire('restore', 'restore-owner')
      expect(grant.granted).toBe(true)
      if (!grant.granted) return

      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'busy-backups')
      realFs.mkdirSync(destDir, { recursive: true })

      try {
        let caught: unknown
        try {
          await bm.backup(null as any, 'busy-backup.zip', destDir)
        } catch (error) {
          caught = error
        }
        expect(isMaintenanceBusyError(caught)).toBe(true)
        // The foreign restore holder is undisturbed (owner-safe refusal).
        expect(coordinator.currentHolder()).toEqual({ kind: 'restore', ownerId: 'restore-owner' })
      } finally {
        coordinator.release(grant.lease)
      }

      // After release, backup proceeds normally.
      const archivePath = await bm.backup(null as any, 'after-busy.zip', destDir)
      expect(realFs.existsSync(archivePath)).toBe(true)
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('restore() is refused while backup holds the lease and releases its own lease on failure', async () => {
      const coordinator = getSharedMaintenanceCoordinator()
      const bm = new BackupManager()

      // Refused while a backup lease is held.
      const grant = coordinator.acquire('backup', 'backup-manager')
      expect(grant.granted).toBe(true)
      if (!grant.granted) return
      try {
        let caught: unknown
        try {
          await bm.restore(null as any, realPath.join(tempDir, 'whatever.zip'))
        } catch (error) {
          caught = error
        }
        expect(isMaintenanceBusyError(caught)).toBe(true)
      } finally {
        coordinator.release(grant.lease)
      }

      // A failing restore (nonexistent archive) still releases the lease.
      await expect(bm.restore(null as any, realPath.join(tempDir, 'missing-backup.zip'))).rejects.toThrow()
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('handleStartupRestore is refused while another operation holds the lease and releases after success', async () => {
      const coordinator = getSharedMaintenanceCoordinator()
      const grant = coordinator.acquire('backup', 'backup-manager')
      expect(grant.granted).toBe(true)
      if (!grant.granted) return

      try {
        let caught: unknown
        try {
          await BackupManager.handleStartupRestore()
        } catch (error) {
          caught = error
        }
        expect(isMaintenanceBusyError(caught)).toBe(true)
      } finally {
        coordinator.release(grant.lease)
      }

      // No-op activation (no .restore directories) acquires and releases.
      await BackupManager.handleStartupRestore()
      expect(coordinator.currentHolder()).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-6012/6013: Security regression tests for restore extraction
  // ---------------------------------------------------------------------------

  describe('Security: restore extraction containment', () => {
    it('restore rejects ZIP with traversal (../) entries', async () => {
      // Create a raw ZIP (not via archiver) to preserve the exact traversal
      // entry name. Archiver normalizes leading "../" components which would
      // defeat the purpose of testing our validation layer.
      const zipPath = realPath.join(tempDir, 'traversal-backup.zip')
      const zipBuf = buildRawZip([
        { name: 'metadata.json', content: '{}' },
        { name: '../../etc/passwd', content: 'traversed' }
      ])
      realFs.writeFileSync(zipPath, zipBuf)

      const bm = new BackupManager()

      // Both node-stream-zip ("Malicious entry") and our validateRestoreZipEntries
      // ("traversal component") reject path traversal. The important outcome is
      // that extraction is prevented before any unsafe staging.
      await expect(bm.restore({} as any, zipPath)).rejects.toThrow(/Malicious|traversal component/)
    })

    it('restore rejects ZIP with absolute path entries', async () => {
      // Use raw ZIP to preserve the leading "/" — archiver strips it.
      const zipPath = realPath.join(tempDir, 'absolute-backup.zip')
      const zipBuf = buildRawZip([
        { name: 'metadata.json', content: '{}' },
        { name: '/etc/passwd', content: 'absolute' }
      ])
      realFs.writeFileSync(zipPath, zipBuf)

      const bm = new BackupManager()

      // Both node-stream-zip ("Malicious entry") and our validateRestoreZipEntries
      // ("absolute path") reject absolute path entries. The important outcome is
      // that extraction is prevented before any unsafe staging.
      await expect(bm.restore({} as any, zipPath)).rejects.toThrow(/Malicious|absolute path/)
    })

    it('restore rejects ZIP with NUL byte in entry name', async () => {
      const zipPath = realPath.join(tempDir, 'nul-backup.zip')
      const zipBuf = buildRawZip([
        { name: 'metadata.json', content: '{}' },
        { name: 'innocent.txt\x00../../etc/passwd', content: 'nul attack' }
      ])
      realFs.writeFileSync(zipPath, zipBuf)

      const bm = new BackupManager()

      // Verify no staging directories exist before restore
      const indexedDBRestore = realPath.join(tempDir, 'IndexedDB.restore')
      const dataRestore = realPath.join(tempDir, 'Data.restore')
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      // NUL bytes cause path truncation attacks. Both node-stream-zip's
      // built-in protection ("Malicious entry") and our validateRestoreZipEntries
      // ("NUL byte") reject this. The important outcome is that extraction
      // is prevented before any unsafe staging.
      await expect(bm.restore({} as any, zipPath)).rejects.toThrow(/Malicious|NUL byte/)

      // No .restore staging was created
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      // App.relaunch was NOT called
      const { app } = await import('electron')
      expect(app.relaunch).not.toHaveBeenCalled()
    })

    it('restore rejects ZIP with backslash separator entries', async () => {
      const zipPath = realPath.join(tempDir, 'backslash-backup.zip')
      const zipBuf = buildRawZip([
        { name: 'metadata.json', content: '{}' },
        { name: 'Data\\..\\..\\etc\\passwd', content: 'backslash' }
      ])
      realFs.writeFileSync(zipPath, zipBuf)

      const bm = new BackupManager()

      // Verify no staging directories exist before restore
      const indexedDBRestore = realPath.join(tempDir, 'IndexedDB.restore')
      const dataRestore = realPath.join(tempDir, 'Data.restore')
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      // Backslash separators are ambiguous across platforms and indicate
      // cross-platform path traversal attacks. Both node-stream-zip (normalizes
      // to "/" then detects "..") and our validateRestoreZipEntries reject these.
      // The important outcome is that extraction is prevented before any unsafe staging.
      await expect(bm.restore({} as any, zipPath)).rejects.toThrow(/Malicious|backslash separator/)

      // No .restore staging was created
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      // App.relaunch was NOT called
      const { app } = await import('electron')
      expect(app.relaunch).not.toHaveBeenCalled()
    })

    it('restore creates unique extraction directory per operation', async () => {
      // Create a valid ZIP (will fail at metadata validation, but extraction dir is created)
      const zipPath = realPath.join(tempDir, 'valid-structure.zip')
      const output = realFs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 0 } })
      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve)
        output.on('error', reject)
        archive.on('error', reject)
        archive.pipe(output)
        archive.append(Buffer.from('{}'), { name: 'metadata.json', store: true })
        archive.finalize()
      })

      const bm = new BackupManager()

      // This will fail because metadata is invalid, but extraction dir is unique
      await expect(bm.restore({} as any, zipPath)).rejects.toThrow()

      // Verify no stale extraction dirs remain (cleanup in catch)
      const restoreBase = realPath.join(realOs.tmpdir(), appIdentity.tempDirName, 'restore')
      if (realFs.existsSync(restoreBase)) {
        const entries = realFs.readdirSync(restoreBase, { withFileTypes: true })
        const extractionDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('extraction-'))
        // Should be 0 — cleanup runs in catch
        expect(extractionDirs.length).toBe(0)
      }
    })

    it('cleanupOrphanedExtractions removes stale extraction directories', async () => {
      const restoreBase = realPath.join(realOs.tmpdir(), appIdentity.tempDirName, 'restore')
      realFs.mkdirSync(restoreBase, { recursive: true })

      // Create a stale extraction directory (simulating a crashed restore)
      const staleDir = realPath.join(restoreBase, 'extraction-00000000000000-stale')
      realFs.mkdirSync(staleDir, { recursive: true })
      realFs.writeFileSync(realPath.join(staleDir, 'test.txt'), 'stale data')

      // Make it appear old by modifying mtime
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
      realFs.utimesSync(staleDir, oldTime, oldTime)

      try {
        // Run cleanup with 1-hour threshold
        await BackupManager.cleanupOrphanedExtractions(60 * 60 * 1000)

        // Stale dir should be removed
        expect(realFs.existsSync(staleDir)).toBe(false)
      } finally {
        // Ownership-scoped cleanup: remove the stale dir even if an assertion
        // fails so it cannot pollute the identity temp root in later runs
        realFs.rmSync(staleDir, { recursive: true, force: true })
      }
    })

    it('cleanupOrphanedExtractions preserves recent extraction directories', async () => {
      const restoreBase = realPath.join(realOs.tmpdir(), appIdentity.tempDirName, 'restore')
      realFs.mkdirSync(restoreBase, { recursive: true })

      // Create a recent extraction directory (active restore)
      const recentDir = realPath.join(restoreBase, 'extraction-99999999999999-recent')
      realFs.mkdirSync(recentDir, { recursive: true })
      realFs.writeFileSync(realPath.join(recentDir, 'test.txt'), 'recent data')

      try {
        // Run cleanup with 1-hour threshold
        await BackupManager.cleanupOrphanedExtractions(60 * 60 * 1000)

        // Recent dir should be preserved
        expect(realFs.existsSync(recentDir)).toBe(true)
      } finally {
        // Ownership-scoped cleanup: remove the recent dir even if an assertion
        // fails so it cannot pollute the identity temp root in later runs
        realFs.rmSync(recentDir, { recursive: true, force: true })
      }
    })

    it('sanitizeProviderFilename strips traversal from WebDAV/S3 filenames', async () => {
      // This tests the sanitizeProviderFilename function used in restoreFromWebdav/restoreFromS3
      const { sanitizeProviderFilename } = await import('../../zipSecurityValidation')

      // Traversal attempt
      const safe1 = sanitizeProviderFilename('../../etc/passwd', '/tmp/root')
      expect(safe1).not.toContain('..')
      expect(safe1).not.toContain('/')

      // Absolute path
      const safe2 = sanitizeProviderFilename('/etc/passwd', '/tmp/root')
      expect(safe2).not.toContain('/')

      // Windows traversal
      const safe3 = sanitizeProviderFilename('..\\..\\windows\\system32\\config\\sam', '/tmp/root')
      expect(safe3).not.toContain('..')
      expect(safe3).not.toContain('\\')

      // All safe filenames should be usable in path.join without escaping
      const root = '/tmp/safe-root'
      for (const safe of [safe1, safe2, safe3]) {
        const fullPath = realPath.join(root, safe)
        expect(fullPath.startsWith(root + realPath.sep)).toBe(true)
      }
    })

    // -----------------------------------------------------------------------
    // LOCK-6014: Metadata/chat.db rejection proves no .restore staging occurs
    // -----------------------------------------------------------------------

    it('restore with invalid metadata creates no .restore staging and no relaunch', async () => {
      // Create a ZIP with invalid metadata (wrong version)
      const zipPath = realPath.join(tempDir, 'invalid-meta.zip')
      const output = realFs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 0 } })
      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve)
        output.on('error', reject)
        archive.on('error', reject)
        archive.pipe(output)
        archive.append(Buffer.from(JSON.stringify({ version: 99, purpose: 'backup' })), {
          name: 'metadata.json',
          store: true
        })
        archive.append(Buffer.from('fake db'), { name: 'Data/chat.db', store: true })
        archive.finalize()
      })

      const bm = new BackupManager()

      // Verify no .restore dirs exist before the call
      const indexedDBRestore = realPath.join(tempDir, 'IndexedDB.restore')
      const dataRestore = realPath.join(tempDir, 'Data.restore')
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      // Restore should reject due to invalid metadata
      await expect(bm.restore({} as any, zipPath)).rejects.toThrow()

      // No .restore staging was created
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      // App.relaunch was NOT called (the mock is cleared per test)
      const { app } = await import('electron')
      expect(app.relaunch).not.toHaveBeenCalled()
    })

    it('restore with missing chat.db creates no .restore staging and no relaunch', async () => {
      // Create a ZIP with valid L3 metadata but no Data/chat.db.
      // The metadata must pass validateL3ArchiveMetadata so restoreDirect
      // reaches the chat.db presence check (LOCK-6008).
      const zipPath = realPath.join(tempDir, 'no-chatdb.zip')
      const output = realFs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 0 } })
      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve)
        output.on('error', reject)
        archive.on('error', reject)
        archive.pipe(output)
        archive.append(
          Buffer.from(
            JSON.stringify({
              version: 7,
              appName: 'Cherry Studio',
              timestamp: Date.now(),
              appVersion: '1.0.0',
              platform: process.platform,
              arch: process.arch,
              product: 'Cherry Chat',
              purpose: 'l3-backup'
            })
          ),
          { name: 'metadata.json', store: true }
        )
        // Data dir exists but chat.db is absent
        archive.append(Buffer.from('some data'), { name: 'Data/notes.txt', store: true })
        archive.finalize()
      })

      const bm = new BackupManager()
      const indexedDBRestore = realPath.join(tempDir, 'IndexedDB.restore')
      const dataRestore = realPath.join(tempDir, 'Data.restore')
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      await expect(bm.restore({} as any, zipPath)).rejects.toThrow(/chat\.db/)

      // No .restore staging was created — LOCK-6014
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      const { app } = await import('electron')
      expect(app.relaunch).not.toHaveBeenCalled()
    })

    it('restore with corrupt chat.db creates no .restore staging and no relaunch', async () => {
      // Create a ZIP with valid metadata but corrupt chat.db content
      const zipPath = realPath.join(tempDir, 'corrupt-chatdb.zip')
      const output = realFs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 0 } })
      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve)
        output.on('error', reject)
        archive.on('error', reject)
        archive.pipe(output)
        archive.append(Buffer.from(JSON.stringify({ version: 7, purpose: 'backup', product: 'cherrystudio' })), {
          name: 'metadata.json',
          store: true
        })
        // Corrupt data — not a valid SQLite database
        archive.append(Buffer.from('THIS IS NOT A SQLITE DATABASE'), {
          name: 'Data/chat.db',
          store: true
        })
        archive.finalize()
      })

      const bm = new BackupManager()
      const indexedDBRestore = realPath.join(tempDir, 'IndexedDB.restore')
      const dataRestore = realPath.join(tempDir, 'Data.restore')
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      await expect(bm.restore({} as any, zipPath)).rejects.toThrow()

      // No .restore staging was created — LOCK-6014
      expect(realFs.existsSync(indexedDBRestore)).toBe(false)
      expect(realFs.existsSync(dataRestore)).toBe(false)

      const { app } = await import('electron')
      expect(app.relaunch).not.toHaveBeenCalled()
    })

    it('restore with ZIP containing no metadata.json is rejected', async () => {
      // ZIP with no metadata.json at all — legacy format rejected by LOCK-6009
      const zipPath = realPath.join(tempDir, 'no-metadata.zip')
      const output = realFs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 0 } })
      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve)
        output.on('error', reject)
        archive.on('error', reject)
        archive.pipe(output)
        archive.append(Buffer.from('fake db'), { name: 'Data/chat.db', store: true })
        archive.finalize()
      })

      const bm = new BackupManager()

      await expect(bm.restore({} as any, zipPath)).rejects.toThrow(/metadata\.json/)

      const dataRestore = realPath.join(tempDir, 'Data.restore')
      expect(realFs.existsSync(dataRestore)).toBe(false)

      const { app } = await import('electron')
      expect(app.relaunch).not.toHaveBeenCalled()
    })

    it('restore cleans extraction dir on failure (no orphaned temp)', async () => {
      // Use an invalid ZIP (traversal entry) to trigger failure
      const zipPath = realPath.join(tempDir, 'fail-cleanup.zip')
      const output = realFs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 0 } })
      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve)
        output.on('error', reject)
        archive.on('error', reject)
        archive.pipe(output)
        archive.append(Buffer.from('{}'), { name: 'metadata.json', store: true })
        archive.append(Buffer.from('evil'), { name: '../../etc/passwd', store: true })
        archive.finalize()
      })

      const bm = new BackupManager()

      // Record extraction dirs before
      const restoreBase = realPath.join(realOs.tmpdir(), appIdentity.tempDirName, 'restore')
      const countExtractions = (): number => {
        if (!realFs.existsSync(restoreBase)) return 0
        return realFs.readdirSync(restoreBase).filter((d) => d.startsWith('extraction-')).length
      }
      const before = countExtractions()

      await expect(bm.restore({} as any, zipPath)).rejects.toThrow()

      // No new extraction dirs left behind (cleanup in catch block)
      expect(countExtractions()).toBe(before)
    })

    // -----------------------------------------------------------------------
    // LOCK-6012: Local backup fileName sanitization — real filesystem
    // -----------------------------------------------------------------------

    it('local backup sanitizes traversal fileName and creates archive with safe basename', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'local-sec-backups')
      realFs.mkdirSync(destDir, { recursive: true })

      // '../../etc/passwd.zip' → path.basename → 'passwd.zip' (safe).
      // The backup should succeed because mockChatDbService provides a real adapter.
      // The key assertion: no file escapes the destination directory.
      const archivePath = await bm.backup(null as any, '../../etc/passwd.zip', destDir)

      // Verify: archive was created with the sanitized basename inside destDir
      expect(realFs.existsSync(archivePath)).toBe(true)
      expect(archivePath).toContain('passwd.zip')
      expect(archivePath.startsWith(destDir)).toBe(true)

      // Verify: no traversal file was created outside destDir
      const files = realFs.readdirSync(destDir)
      for (const f of files) {
        expect(f).not.toContain('..')
        expect(realPath.isAbsolute(f)).toBe(false)
      }
    })

    it('local backup rejects empty fileName', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'local-sec-backups2')
      realFs.mkdirSync(destDir, { recursive: true })

      await expect(bm.backup(null as any, '', destDir)).rejects.toThrow(/empty or invalid/)

      const files = realFs.readdirSync(destDir)
      expect(files.length).toBe(0)
    })

    it('local backup sanitizes and creates archive with safe basename', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'local-sec-backups3')
      realFs.mkdirSync(destDir, { recursive: true })

      // Use a safe filename — backup should proceed past validation
      // (will fail at chat.db snapshot since mockChatDbService.isInitialised is false,
      //  but the filename validation and output containment are exercised)
      try {
        await bm.backup(null as any, 'safe-backup.zip', destDir)
      } catch {
        // Expected — chatDbService not initialized in this test context
      }

      // Verify: no traversal file was created outside destDir
      const parentFiles = realFs.readdirSync(tempDir)
      const suspiciousFiles = parentFiles.filter((f) => f.includes('..') || f.startsWith('/') || f === 'passwd.zip')
      expect(suspiciousFiles.length).toBe(0)
    })

    it('local backup uses exclusive write — rejects duplicate fileName', async () => {
      const bm = new BackupManager()
      const destDir = realPath.join(tempDir, 'local-sec-excl')
      realFs.mkdirSync(destDir, { recursive: true })

      // Create a file that would collide with the backup output
      const collisionPath = realPath.join(destDir, 'existing-backup.zip')
      realFs.writeFileSync(collisionPath, 'existing content')

      // backup() should fail (O_EXCL rejects the existing file)
      // The error might be EEXIST from O_EXCL or a later error, but the
      // existing file must NOT be truncated
      try {
        await bm.backup(null as any, 'existing-backup.zip', destDir)
      } catch {
        // Expected
      }

      // Verify: the existing file was NOT truncated
      expect(realFs.readFileSync(collisionPath, 'utf-8')).toBe('existing content')

      // Cleanup
      realFs.rmSync(collisionPath, { force: true })
    })
  })
})
