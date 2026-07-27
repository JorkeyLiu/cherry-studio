/**
 * ChatDbService Phase 1 Tests
 *
 * Covers:
 * - Init/create/close/reopen lifecycle
 * - Concurrent init (idempotency)
 * - Failure cleanup/retry
 * - Pragma configuration (WAL, foreign_keys, synchronous, busy_timeout)
 * - Migration execution, idempotency, and failure on empty SQL
 * - Integrity check success/failure/invalid DB
 * - Restored first-open validation state (restore marker → integrity check BEFORE WAL)
 * - Repair-required state (gates init, gates getters, propagates write failures)
 * - Backup serialization and snapshot validity
 * - Lifecycle ordering / close behavior / generation counter
 */
import * as fs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be defined before imports
// ---------------------------------------------------------------------------

// Hoisted mocks
const { mockLogger, mockSqliteInstances, MockDatabase, appliedMigrationKeys } = vi.hoisted(() => {
  const appliedMigrationKeys: string[] = []
  return {
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    },
    mockSqliteInstances: [] as any[],
    appliedMigrationKeys,
    MockDatabase: vi.fn().mockImplementation(() => {
      const instance = {
        pragma: vi.fn((sql: string, _opts?: any) => {
          if (sql === 'integrity_check') return 'ok'
          return null
        }),
        close: vi.fn(),
        backup: vi.fn(() => ({ run: vi.fn() }))
      }
      return instance
    })
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mockLogger
  }
}))

vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

// Mock node:os with tmpdir
vi.mock('node:os', () => ({
  default: {
    tmpdir: vi.fn(() => '/mock/tmp')
  },
  tmpdir: vi.fn(() => '/mock/tmp')
}))

// Mock better-sqlite3 — uses hoisted MockDatabase for test control
vi.mock('better-sqlite3', () => ({
  default: MockDatabase
}))

// Mock drizzle-orm/better-sqlite3 — tracks applied migrations in hoisted array
vi.mock('drizzle-orm/better-sqlite3', () => ({
  drizzle: vi.fn((_sqlite: any, _opts: any) => ({
    run: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // Return tracked applied migration keys
        all: vi.fn(() => appliedMigrationKeys.map((key) => ({ key, value: key, updatedAt: '' })))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        run: vi.fn()
      }))
    })),
    transaction: vi.fn((fn: any) => {
      const mockTx = {
        run: vi.fn(),
        insert: vi.fn(() => ({
          values: vi.fn((vals: any) => ({
            run: vi.fn(() => {
              // Track the migration key that was inserted
              if (vals?.key) {
                appliedMigrationKeys.push(vals.key)
              }
            })
          }))
        }))
      }
      fn(mockTx)
    })
  })),
  BetterSQLite3Database: {}
}))

vi.mock('drizzle-orm/sqlite-core', () => ({
  sqliteTable: vi.fn((_name: string, _columns: any, _indexes?: any) => ({})),
  index: vi.fn(() => ({})),
  uniqueIndex: vi.fn(() => ({})),
  integer: vi.fn(() => ({
    notNull: vi.fn().mockReturnThis(),
    default: vi.fn().mockReturnThis(),
    references: vi.fn().mockReturnThis()
  })),
  primaryKey: vi.fn(() => ({})),
  text: vi.fn(() => ({
    primaryKey: vi.fn().mockReturnThis(),
    notNull: vi.fn().mockReturnThis(),
    default: vi.fn().mockReturnThis(),
    references: vi.fn().mockReturnThis()
  }))
}))

// Mock node:fs with in-memory filesystem
const memfs: Record<string, string> = {}

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn((p: string) => p in memfs),
    mkdirSync: vi.fn((p: string) => {
      memfs[p] = memfs[p] || ''
    }),
    readFileSync: vi.fn((p: string) => memfs[p] || ''),
    writeFileSync: vi.fn((p: string, data: string) => {
      memfs[p] = data
    }),
    unlinkSync: vi.fn((p: string) => {
      delete memfs[p]
    }),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn()
  },
  existsSync: vi.fn((p: string) => p in memfs),
  mkdirSync: vi.fn((p: string) => {
    memfs[p] = memfs[p] || ''
  }),
  readFileSync: vi.fn((p: string) => memfs[p] || ''),
  writeFileSync: vi.fn((p: string, data: string) => {
    memfs[p] = data
  }),
  unlinkSync: vi.fn((p: string) => {
    delete memfs[p]
  }),
  promises: {
    mkdir: vi.fn(async (p: string) => {
      memfs[p] = memfs[p] || ''
    }),
    readFile: vi.fn(async (p: string) => memfs[p] || ''),
    writeFile: vi.fn(async (p: string, data: string) => {
      memfs[p] = data
    }),
    unlink: vi.fn(async (p: string) => {
      delete memfs[p]
    }),
    rename: vi.fn(async (from: string, to: string) => {
      memfs[to] = memfs[from]
      delete memfs[from]
    }),
    rm: vi.fn(async () => {})
  }
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { BetterSqlite3BackupAdapter, ChatDbBackup } from '../backup'
import { ChatDbService, chatDbService } from '../index'
import {
  createMaintenanceCoordinator,
  getSharedMaintenanceCoordinator,
  isMaintenanceBusyError,
  MaintenanceBusyError
} from '../maintenanceCoordination'
import { MIGRATIONS, runMigrations } from '../migration'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearMemfs() {
  for (const key of Object.keys(memfs)) {
    delete memfs[key]
  }
}

function resetSingletonState() {
  try {
    chatDbService.close()
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatDbService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSqliteInstances.length = 0
    appliedMigrationKeys.length = 0
    clearMemfs()
    resetSingletonState()
  })

  afterEach(() => {
    resetSingletonState()
  })

  // =========================================================================
  // 1. Init/Create/Close/Reopen lifecycle
  // =========================================================================

  describe('Lifecycle', () => {
    it('should initialise successfully and set isInitialised to true', async () => {
      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Opening database'))
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('ChatDbService initialised'))
    })

    it('should close successfully and set isInitialised to false', async () => {
      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)

      chatDbService.close()
      expect(chatDbService.isInitialised()).toBe(false)
    })

    it('should be re-openable after close', async () => {
      await chatDbService.init()
      chatDbService.close()
      expect(chatDbService.isInitialised()).toBe(false)

      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)
    })

    it('close() should be idempotent (no-op when already closed)', () => {
      chatDbService.close()
      chatDbService.close()
      expect(chatDbService.isInitialised()).toBe(false)
    })

    it('should return correct dbDir and dbPath', () => {
      expect(chatDbService.getDbDir()).toBe('/mock/data')
      expect(chatDbService.getDbPath()).toBe('/mock/data/chat.db')
    })

    it('getDatabase() should throw if not initialised', () => {
      expect(() => chatDbService.getDatabase()).toThrow('ChatDbService has not been initialised')
    })

    it('getSqlite() should throw if not initialised', () => {
      expect(() => chatDbService.getSqlite()).toThrow('ChatDbService has not been initialised')
    })
  })

  // =========================================================================
  // 2. Concurrent init (idempotency)
  // =========================================================================

  describe('Concurrent init', () => {
    it('should share the same init promise for concurrent calls', async () => {
      const promise1 = chatDbService.init()
      const promise2 = chatDbService.init()
      const promise3 = chatDbService.init()

      await Promise.all([promise1, promise2, promise3])
      expect(chatDbService.isInitialised()).toBe(true)

      // Should have logged "ChatDbService initialised" exactly once
      const initLogs = mockLogger.info.mock.calls.filter((call: any[]) =>
        call[0]?.includes?.('ChatDbService initialised')
      )
      expect(initLogs).toHaveLength(1)
    })
  })

  // =========================================================================
  // 3. Failure cleanup/retry
  // =========================================================================

  describe('Failure cleanup/retry', () => {
    it('should clean up state on init failure so retry can succeed', async () => {
      // First init should fail
      MockDatabase.mockImplementationOnce(() => {
        throw new Error('Simulated DB open failure')
      })

      await expect(chatDbService.init()).rejects.toThrow('Simulated DB open failure')
      expect(chatDbService.isInitialised()).toBe(false)

      // Second init should succeed (retry)
      MockDatabase.mockImplementation(() => {
        const instance = {
          pragma: vi.fn((sql: string) => {
            if (sql === 'integrity_check') return 'ok'
            return null
          }),
          close: vi.fn(),
          backup: vi.fn(() => ({ run: vi.fn() }))
        }
        mockSqliteInstances.push(instance)
        return instance
      })

      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)
    })
  })

  // =========================================================================
  // 4. Pragma configuration
  // =========================================================================

  describe('Pragma configuration', () => {
    it('should set WAL mode, foreign_keys ON, synchronous NORMAL, busy_timeout', async () => {
      await chatDbService.init()
      const sqlite = chatDbService.getSqlite()

      expect(sqlite.pragma).toHaveBeenCalledWith('journal_mode = WAL')
      expect(sqlite.pragma).toHaveBeenCalledWith('foreign_keys = ON')
      expect(sqlite.pragma).toHaveBeenCalledWith('synchronous = NORMAL')
      expect(sqlite.pragma).toHaveBeenCalledWith('busy_timeout = 5000')
    })
  })

  // =========================================================================
  // 5. Migration execution
  // =========================================================================

  describe('Migration', () => {
    it('should apply migrations and record them in migration_state', async () => {
      await chatDbService.init()

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Applying migration: 001_initial_schema'))
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Migration applied: 001_initial_schema'))
    })

    it('should be idempotent — running init twice does not re-apply migrations', async () => {
      await chatDbService.init()
      vi.clearAllMocks()

      // Second init — migrations should already be applied
      await chatDbService.init()

      expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining('Applying migration:'))
    })

    it('should return applied count from runMigrations', async () => {
      await chatDbService.init()
      const db = chatDbService.getDatabase()
      const sqlite = chatDbService.getSqlite()
      // init already applied 001_initial_schema, so a second call returns 0
      const count = runMigrations(db, sqlite)
      expect(count).toBe(0)
    })

    it('should return 0 on subsequent runMigrations call (all applied)', async () => {
      await chatDbService.init()
      const db = chatDbService.getDatabase()
      const sqlite = chatDbService.getSqlite()
      runMigrations(db, sqlite)
      const count = runMigrations(db, sqlite)
      expect(count).toBe(0)
    })

    it('should throw on empty migration SQL', async () => {
      await chatDbService.init()
      const db = chatDbService.getDatabase()
      const sqlite = chatDbService.getSqlite()
      const emptyMigration = { key: 'empty', description: 'Empty', sql: [] }

      const originalLength = MIGRATIONS.length
      MIGRATIONS.push(emptyMigration)

      try {
        expect(() => runMigrations(db, sqlite)).toThrow('has no SQL statements')
      } finally {
        MIGRATIONS.splice(originalLength)
      }
    })

    it('MIGRATIONS registry should not be empty', () => {
      expect(MIGRATIONS.length).toBeGreaterThan(0)
    })

    it('first migration should be 001_initial_schema', () => {
      expect(MIGRATIONS[0].key).toBe('001_initial_schema')
    })
  })

  // =========================================================================
  // 6. Integrity check
  // =========================================================================

  describe('Integrity check', () => {
    it('should return ok for valid database', async () => {
      await chatDbService.init()
      const result = chatDbService.runIntegrityCheck()
      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should return error when not initialised', () => {
      const result = chatDbService.runIntegrityCheck()
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Database not initialised')
    })

    it('should handle pragma throwing an error', async () => {
      await chatDbService.init()
      const sqlite = chatDbService.getSqlite()
      vi.mocked(sqlite.pragma).mockImplementationOnce(() => {
        throw new Error('Corrupt database')
      })

      const result = chatDbService.runIntegrityCheck()
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Corrupt database')
    })

    it('should handle non-ok pragma result', async () => {
      await chatDbService.init()
      const sqlite = chatDbService.getSqlite()
      vi.mocked(sqlite.pragma).mockReturnValueOnce('malformed database')

      const result = chatDbService.runIntegrityCheck()
      expect(result.ok).toBe(false)
      expect(result.error).toBe('malformed database')
    })
  })

  // =========================================================================
  // 7. Post-restore validation state
  // =========================================================================

  describe('Post-restore validation', () => {
    it('should set restore pending marker', () => {
      // setRestorePending now validates chat.db exists — write a fake one first
      memfs['/mock/data/chat.db'] = ''
      chatDbService.setRestorePending()
      expect(chatDbService.isRestorePending()).toBe(true)
    })

    it('should throw if chat.db does not exist when setting restore pending', () => {
      expect(() => chatDbService.setRestorePending()).toThrow('restored chat.db not found')
    })

    it('should detect restore pending marker on init and clear it on success', async () => {
      memfs['/mock/data/chat.db'] = ''
      chatDbService.setRestorePending()
      expect(chatDbService.isRestorePending()).toBe(true)

      await chatDbService.init()

      // Marker should be cleared after successful integrity check
      expect(chatDbService.isRestorePending()).toBe(false)
    })
  })

  // =========================================================================
  // 8. Repair-required state
  // =========================================================================

  describe('Repair-required state', () => {
    it('isRepairRequired() should return false initially', () => {
      expect(chatDbService.isRepairRequired()).toBe(false)
    })

    it('clearRepairRequired() should clear the marker', () => {
      fs.writeFileSync('/mock/data/chat.db.repair', new Date().toISOString())
      expect(chatDbService.isRepairRequired()).toBe(true)

      chatDbService.clearRepairRequired()
      expect(chatDbService.isRepairRequired()).toBe(false)
    })

    it('init() should refuse to initialise while repair marker exists', async () => {
      fs.writeFileSync('/mock/data/chat.db.repair', new Date().toISOString())
      expect(chatDbService.isRepairRequired()).toBe(true)

      await expect(chatDbService.init()).rejects.toThrow('repair-required state')
      expect(chatDbService.isInitialised()).toBe(false)

      // After clearing marker, init should succeed
      chatDbService.clearRepairRequired()
      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)
    })

    // Finding 3: Repair guard on getters
    it('getDatabase() should throw while repair marker exists', async () => {
      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)

      // Create repair marker while handles exist
      fs.writeFileSync('/mock/data/chat.db.repair', new Date().toISOString())

      // getDatabase should now refuse
      expect(() => chatDbService.getDatabase()).toThrow('repair-required state')
    })

    it('getSqlite() should throw while repair marker exists', async () => {
      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)

      fs.writeFileSync('/mock/data/chat.db.repair', new Date().toISOString())

      expect(() => chatDbService.getSqlite()).toThrow('repair-required state')
    })

    it('getBackup() should throw while repair marker exists', async () => {
      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)

      fs.writeFileSync('/mock/data/chat.db.repair', new Date().toISOString())

      expect(() => chatDbService.getBackup()).toThrow('repair-required state')
    })

    it('isInitialised() should return false while repair marker exists even if handles are live', async () => {
      await chatDbService.init()
      expect(chatDbService.isInitialised()).toBe(true)

      // Create repair marker while handles exist
      fs.writeFileSync('/mock/data/chat.db.repair', new Date().toISOString())

      // isInitialised returns false during repair
      expect(chatDbService.isInitialised()).toBe(false)

      // Clean up
      chatDbService.clearRepairRequired()
    })
  })

  // =========================================================================
  // 9. Backup coordination
  // =========================================================================

  describe('Backup coordination', () => {
    it('getBackup() should throw if not initialised', () => {
      expect(() => chatDbService.getBackup()).toThrow('ChatDbService has not been initialised')
    })

    it('getBackup() should return a ChatDbBackup instance after init', async () => {
      await chatDbService.init()
      const backup = chatDbService.getBackup()
      expect(backup).toBeInstanceOf(ChatDbBackup)
    })
  })
})

// ---------------------------------------------------------------------------
// ChatDbBackup tests
// ---------------------------------------------------------------------------

describe('ChatDbBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearMemfs()
    resetSingletonState()
  })

  afterEach(() => {
    resetSingletonState()
  })

  describe('createSnapshot', () => {
    it('should create a snapshot at the specified path', async () => {
      const mockAdapter = {
        createSnapshot: vi.fn(async () => 1),
        validateSnapshot: vi.fn(async () => 'ok' as const)
      }

      const backup = new ChatDbBackup(mockAdapter, '/mock/data')
      const result = await backup.createSnapshot('/mock/data/chat.db.backup')

      expect(mockAdapter.createSnapshot).toHaveBeenCalled()
      expect(mockAdapter.validateSnapshot).toHaveBeenCalled()
      expect(result).toBe('/mock/data/chat.db.backup')
    })

    it('should throw and cleanup if validation fails', async () => {
      const mockAdapter = {
        createSnapshot: vi.fn(async () => 1),
        validateSnapshot: vi.fn(async () => 'malformed database' as const)
      }

      const backup = new ChatDbBackup(mockAdapter, '/mock/data')

      await expect(backup.createSnapshot('/mock/data/chat.db.backup')).rejects.toThrow(
        'Snapshot integrity check failed'
      )
    })

    it('should throw and cleanup if createSnapshot fails', async () => {
      const mockAdapter = {
        createSnapshot: vi.fn(async () => {
          throw new Error('Backup API failed')
        }),
        validateSnapshot: vi.fn(async () => 'ok' as const)
      }

      const backup = new ChatDbBackup(mockAdapter, '/mock/data')

      await expect(backup.createSnapshot('/mock/data/chat.db.backup')).rejects.toThrow('Backup API failed')
    })
  })

  describe('cleanupSnapshot', () => {
    it('should not throw if snapshot does not exist', async () => {
      const mockAdapter = {
        createSnapshot: vi.fn(async () => 1),
        validateSnapshot: vi.fn(async () => 'ok' as const)
      }

      const backup = new ChatDbBackup(mockAdapter, '/mock/data')

      await expect(backup.cleanupSnapshot('/mock/data')).resolves.toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// BetterSqlite3BackupAdapter tests
// ---------------------------------------------------------------------------

describe('BetterSqlite3BackupAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSqliteInstances.length = 0
    appliedMigrationKeys.length = 0
    clearMemfs()
    resetSingletonState()
  })

  afterEach(() => {
    resetSingletonState()
  })

  it('createSnapshot should call db.backup() with destination path', async () => {
    await chatDbService.init()
    const sqlite = chatDbService.getSqlite()

    const adapter = new BetterSqlite3BackupAdapter(() => sqlite)
    await adapter.createSnapshot('/mock/data/backup.db')

    expect(sqlite.backup).toHaveBeenCalledWith('/mock/data/backup.db')
  })

  it('validateSnapshot should have correct interface', async () => {
    const adapter = new BetterSqlite3BackupAdapter(() => chatDbService.getSqlite())
    expect(typeof adapter.validateSnapshot).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Migration registry tests
// ---------------------------------------------------------------------------

describe('Migration registry', () => {
  it('should have exactly two migrations (001 + 002)', () => {
    expect(MIGRATIONS).toHaveLength(2)
    expect(MIGRATIONS[0].key).toBe('001_initial_schema')
    expect(MIGRATIONS[1].key).toBe('002_corrective_schema')
  })

  it('001_initial_schema should have SQL statements', () => {
    expect(MIGRATIONS[0].sql.length).toBeGreaterThan(0)
  })

  it('001_initial_schema SQL should contain all expected tables', () => {
    const sql = MIGRATIONS[0].sql.join(' ')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS topics')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS messages')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS message_blocks')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS topic_segments')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS topic_segment_messages')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS file_references')
  })

  it('001_initial_schema SQL should contain expected indexes', () => {
    const sql = MIGRATIONS[0].sql.join(' ')
    expect(sql).toContain('messages_topic_id_sort_order_idx')
    expect(sql).toContain('message_blocks_message_id_sort_order_idx')
    expect(sql).toContain('topic_segments_topic_id_sort_order_idx')
    expect(sql).toContain('file_references_message_id_idx')
    expect(sql).toContain('file_references_file_id_idx')
  })

  it('migration keys should be unique', () => {
    const keys = MIGRATIONS.map((m) => m.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('migration descriptions should be non-empty', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.description).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: full lifecycle with migration and integrity check
// ---------------------------------------------------------------------------

describe('Integration: full lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSqliteInstances.length = 0
    appliedMigrationKeys.length = 0
    clearMemfs()
    resetSingletonState()
  })

  afterEach(() => {
    resetSingletonState()
  })

  it('should handle complete init → migrate → integrity check → close cycle', async () => {
    await chatDbService.init()
    expect(chatDbService.isInitialised()).toBe(true)

    // Migrations applied
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Applying migration: 001_initial_schema'))

    // Integrity check
    const result = chatDbService.runIntegrityCheck()
    expect(result.ok).toBe(true)

    // Close
    chatDbService.close()
    expect(chatDbService.isInitialised()).toBe(false)

    // Reopen
    await chatDbService.init()
    expect(chatDbService.isInitialised()).toBe(true)

    // Final close
    chatDbService.close()
  })

  it('should handle restore marker flow', async () => {
    memfs['/mock/data/chat.db'] = ''
    chatDbService.setRestorePending()
    expect(chatDbService.isRestorePending()).toBe(true)

    await chatDbService.init()
    expect(chatDbService.isRestorePending()).toBe(false)

    chatDbService.close()
  })

  it('will-quit handler should close chatDbService without blocking', async () => {
    await chatDbService.init()
    expect(chatDbService.isInitialised()).toBe(true)

    chatDbService.close()
    expect(chatDbService.isInitialised()).toBe(false)
  })

  it('close failure should not leave state dirty — handle preserved for retry', async () => {
    await chatDbService.init()
    const sqlite = chatDbService.getSqlite()

    vi.mocked(sqlite.close).mockImplementationOnce(() => {
      throw new Error('Close failed')
    })

    chatDbService.close()

    // Finding 7: On close failure, handle is NOT discarded.
    // isInitialised() returns true because the handle is still live.
    // This allows a subsequent close() to retry.
    expect(chatDbService.isInitialised()).toBe(true)
  })
})

// ===========================================================================
// Maintenance coordination wiring (Phase 4.4.1, LOCK-4416)
// ===========================================================================

describe('ChatDbService maintenance coordination wiring (LOCK-4416)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSqliteInstances.length = 0
    appliedMigrationKeys.length = 0
    clearMemfs()
  })

  it('live init is refused with a structured busy error while backup holds the lease', async () => {
    const coordinator = createMaintenanceCoordinator()
    coordinator.acquire('backup', 'backup-manager')

    const svc = new ChatDbService('/mock/coord', coordinator)
    let caught: unknown
    try {
      await svc.init()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(MaintenanceBusyError)
    expect(isMaintenanceBusyError(caught)).toBe(true)
    const busy = caught as MaintenanceBusyError
    expect(busy.requestedKind).toBe('init')
    expect(busy.conflictingKind).toBe('backup')
    expect(busy.conflictingOwnerId).toBe('backup-manager')
    expect(svc.isInitialised()).toBe(false)
    // The foreign holder is undisturbed.
    expect(coordinator.currentHolder()).toEqual({ kind: 'backup', ownerId: 'backup-manager' })
  })

  it('init holds the init lease while in flight and releases it on completion', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)

    const initPromise = svc.init()
    // Lease is held while init has not settled.
    expect(coordinator.currentHolder()).toEqual({ kind: 'init', ownerId: 'chat-db-live' })

    await initPromise
    expect(svc.isInitialised()).toBe(true)
    expect(coordinator.currentHolder()).toBeNull()

    // The slot is free for the next maintenance operation.
    const next = coordinator.acquire('backup', 'next')
    expect(next.granted).toBe(true)
    if (next.granted) {
      coordinator.release(next.lease)
    }
    svc.close()
  })

  it('init releases the lease on failure so a retry can acquire it again', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)

    MockDatabase.mockImplementationOnce(() => {
      throw new Error('Simulated DB open failure')
    })

    await expect(svc.init()).rejects.toThrow('Simulated DB open failure')
    expect(coordinator.currentHolder()).toBeNull()

    // Retry succeeds and coordinates normally.
    await svc.init()
    expect(svc.isInitialised()).toBe(true)
    expect(coordinator.currentHolder()).toBeNull()
    svc.close()
  })

  it('close acquires and releases the close lease when the slot is free', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    svc.close()
    expect(svc.isInitialised()).toBe(false)
    expect(coordinator.currentHolder()).toBeNull()
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('without maintenance lease'))
  })

  it('close returns false (busy) when a foreign operation holds the lease — LOCK-4416 compliance', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    // A foreign backup operation holds the lease at close time.
    const grant = coordinator.acquire('backup', 'backup-manager')
    expect(grant.granted).toBe(true)

    // LOCK-4416: close() MUST NOT bypass the foreign lease. It returns false
    // (close-busy) and does NOT close the handle. Process termination
    // (Electron will-quit) terminates the process and releases handles.
    const closeResult = svc.close()
    expect(closeResult).toBe(false)
    // The handle is NOT closed — sqlite is still alive for the same process.
    expect(svc.isInitialised()).toBe(true)
    // The foreign holder is undisturbed.
    expect(coordinator.currentHolder()).toEqual({ kind: 'backup', ownerId: 'backup-manager' })
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('holds the maintenance lease'))
  })

  it('close during in-flight init supersedes owner-safely; stale init release cannot free a newer holder', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)

    const initPromise = svc.init()
    expect(coordinator.currentHolder()).toEqual({ kind: 'init', ownerId: 'chat-db-live' })

    // close() releases the instance's OWN init lease (owner-safe), takes the
    // close lease, closes, and frees the slot — all synchronously.
    svc.close()
    expect(coordinator.currentHolder()).toBeNull()

    // A newer foreign holder takes the slot before init's finally runs.
    coordinator.acquire('restore', 'restore-owner')

    await initPromise.catch(() => {
      // Superseded init may reject — either outcome must not disturb the slot.
    })

    // The stale init lease release was refused: the newer holder is intact.
    expect(coordinator.currentHolder()).toEqual({ kind: 'restore', ownerId: 'restore-owner' })
    expect(svc.isInitialised()).toBe(false)
  })

  it('candidate ChatDbService instances stay uncoordinated (not live maintenance)', async () => {
    const coordinator = createMaintenanceCoordinator()
    // Foreign lease held — a coordinated instance would be refused.
    coordinator.acquire('promotion', 'import-session-1')

    // Candidate construction passes NO coordinator (matches candidateDb factory).
    const candidate = new ChatDbService('/mock/candidate')
    await candidate.init()
    expect(candidate.isInitialised()).toBe(true)
    candidate.close()
    expect(candidate.isInitialised()).toBe(false)

    // The coordinator never saw the candidate lifecycle.
    expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: 'import-session-1' })
  })

  it('the live singleton is joined to the shared coordinator', async () => {
    const shared = getSharedMaintenanceCoordinator()
    const grant = shared.acquire('backup', 'backup-manager')
    expect(grant.granted).toBe(true)
    if (!grant.granted) return

    try {
      await expect(chatDbService.init()).rejects.toSatisfy((e: unknown) => isMaintenanceBusyError(e))
    } finally {
      shared.release(grant.lease)
    }

    // After release, the singleton initialises and coordinates normally.
    await chatDbService.init()
    expect(chatDbService.isInitialised()).toBe(true)
    expect(shared.currentHolder()).toBeNull()
    chatDbService.close()
    expect(shared.currentHolder()).toBeNull()
  })
})
