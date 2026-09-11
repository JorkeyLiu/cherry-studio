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
const { mockLogger, mockSqliteInstances, MockDatabase, appliedMigrationKeys, makeMockStatement } = vi.hoisted(() => {
  const appliedMigrationKeys: string[] = []

  /**
   * Migration 004 preflight fixture contract (LOCK-001/002/003):
   * `verifyFtsRowidParity` executes the parity/count/MATCH-smoke queries on
   * the RAW better-sqlite3 handle via `prepare(sql).get()`, so the mocked
   * handle must provide that capability exactly like a real Database. The
   * mocked database is EMPTY (the drizzle mock tracks migration keys only,
   * it never creates tables), so every parity count is zero and the smoke
   * MATCH finds no document — the preflight passes and migration 004
   * proceeds, mirroring a fresh production DB.
   */
  function makeMockStatement(sql: string): any {
    if (sql === MIGRATION_004_PARITY_FTS_OUTER_SQL) {
      return { get: vi.fn(() => ({ fts_without_normalized: 0, block_id_mismatch: 0, content_mismatch: 0 })) }
    }
    if (
      sql === MIGRATION_004_PARITY_NORMALIZED_COUNT_SQL ||
      sql === MIGRATION_004_PARITY_FTS_COUNT_SQL ||
      sql === MIGRATION_004_PARITY_CANONICAL_COUNT_SQL
    ) {
      return { get: vi.fn(() => ({ n: 0 })) }
    }
    if (sql === MIGRATION_004_FTS_SMOKE_SQL) {
      // Empty FTS index — the smoke MATCH matches no document (stmt.get() → undefined).
      return { get: vi.fn(() => undefined) }
    }
    return { get: vi.fn(() => undefined), all: vi.fn(() => []), run: vi.fn(() => ({ changes: 0 })) }
  }

  return {
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    },
    mockSqliteInstances: [] as any[],
    appliedMigrationKeys,
    makeMockStatement,
    MockDatabase: vi.fn().mockImplementation(() => {
      const instance = {
        pragma: vi.fn((sql: string, _opts?: any) => {
          if (sql === 'integrity_check') return 'ok'
          return null
        }),
        prepare: vi.fn((sql: string) => makeMockStatement(sql)),
        close: vi.fn(),
        backup: vi.fn(() => ({ run: vi.fn() })),
        function: vi.fn()
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
    openSync: vi.fn((_p: string, _flags: string) => 1),
    fsyncSync: vi.fn((_fd: number) => {}),
    closeSync: vi.fn((_fd: number) => {}),
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
  openSync: vi.fn((_p: string, _flags: string) => 1),
  fsyncSync: vi.fn((_fd: number) => {}),
  closeSync: vi.fn((_fd: number) => {}),
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
    rm: vi.fn(async () => {}),
    mkdtemp: vi.fn(async (prefix: string) => {
      const id = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`
      memfs[id] = memfs[id] || ''
      return id
    })
  }
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { resetDiagnosticCounters } from '@shared/diagnostics/sendTiming'

import { BetterSqlite3BackupAdapter, ChatDbBackup } from '../backup'
import { ChatDbService, chatDbService } from '../index'
import {
  acquirePromotionLease,
  createMaintenanceCoordinator,
  getSharedMaintenanceCoordinator,
  isMaintenanceBusyError,
  MaintenanceBusyError,
  type PromotionLeaseHandle
} from '../maintenanceCoordination'
import {
  MIGRATION_004_FTS_SMOKE_SQL,
  MIGRATION_004_PARITY_CANONICAL_COUNT_SQL,
  MIGRATION_004_PARITY_FTS_COUNT_SQL,
  MIGRATION_004_PARITY_FTS_OUTER_SQL,
  MIGRATION_004_PARITY_NORMALIZED_COUNT_SQL,
  MIGRATIONS,
  runMigrations
} from '../migration'

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
    resetDiagnosticCounters()
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
          prepare: vi.fn((sql: string) => makeMockStatement(sql)),
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

      const backup = new ChatDbBackup(mockAdapter)
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

      const backup = new ChatDbBackup(mockAdapter)

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

      const backup = new ChatDbBackup(mockAdapter)

      await expect(backup.createSnapshot('/mock/data/chat.db.backup')).rejects.toThrow('Backup API failed')
    })
  })

  describe('cleanupSnapshot', () => {
    it('should not throw if snapshot does not exist', async () => {
      const mockAdapter = {
        createSnapshot: vi.fn(async () => 1),
        validateSnapshot: vi.fn(async () => 'ok' as const)
      }

      const backup = new ChatDbBackup(mockAdapter)

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
  it('should have exactly twelve migrations (001 + 002 + 003 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 + 012)', () => {
    expect(MIGRATIONS).toHaveLength(12)
    expect(MIGRATIONS[0].key).toBe('001_initial_schema')
    expect(MIGRATIONS[1].key).toBe('002_corrective_schema')
    expect(MIGRATIONS[2].key).toBe('003_fts5_normalized_search')
    expect(MIGRATIONS[3].key).toBe('004_fts_rowid_identity')
    expect(MIGRATIONS[4].key).toBe('005_sync_metadata')
    expect(MIGRATIONS[5].key).toBe('006_sync_field_merge')
    expect(MIGRATIONS[6].key).toBe('007_sync_pairing_trust')
    expect(MIGRATIONS[7].key).toBe('008_sync_channel_reset')
    expect(MIGRATIONS[8].key).toBe('009_sync_membership_clock')
    expect(MIGRATIONS[9].key).toBe('010_sync_parent_order_frame')
    expect(MIGRATIONS[10].key).toBe('011_sync_parent_order_frame_parent_id_unbounded')
    expect(MIGRATIONS[11].key).toBe('012_sync_frame_high_water')
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

// ===========================================================================
// Promotion-owned live lifecycle (Phase 4.4.2, LOCK-4422)
// ===========================================================================

describe('ChatDbService promotion-owned live lifecycle (LOCK-4422)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSqliteInstances.length = 0
    appliedMigrationKeys.length = 0
    clearMemfs()
  })

  it('the same continuously held promotion lease authorizes internal close AND reopen', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    const promotion = acquirePromotionLease('import-session-1', coordinator)
    expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: 'import-session-1' })

    // Internal close: no nested lease acquisition — the promotion lease
    // stays the holder throughout (no release/reacquire, no second mutex).
    expect(svc.closeForPromotion(promotion)).toBe(true)
    expect(svc.isInitialised()).toBe(false)
    expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: 'import-session-1' })

    // Internal reopen under the SAME lease.
    await svc.reopenForPromotion(promotion)
    expect(svc.isInitialised()).toBe(true)
    expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: 'import-session-1' })

    // Only the owner's release frees the slot.
    expect(promotion.release()).toBe(true)
    expect(coordinator.currentHolder()).toBeNull()
    svc.close()
  })

  it('public init/close mutual exclusion is unchanged while promotion holds the lease', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    const promotion = acquirePromotionLease('import-session-1', coordinator)

    // Public close() must NOT bypass the promotion lease (close-busy).
    expect(svc.close()).toBe(false)
    expect(svc.isInitialised()).toBe(true)

    // Internal promotion-owned close works, then public init() is still
    // refused with a structured busy error while promotion holds the slot.
    expect(svc.closeForPromotion(promotion)).toBe(true)
    await expect(svc.init()).rejects.toSatisfy((e: unknown) => isMaintenanceBusyError(e))
    expect(svc.isInitialised()).toBe(false)

    promotion.release()
    // With the slot free, public init/close coordinate normally again.
    await svc.init()
    expect(svc.isInitialised()).toBe(true)
    expect(svc.close()).toBe(true)
    expect(coordinator.currentHolder()).toBeNull()
  })

  it('released (stale) promotion authorization cannot close the live DB', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    const promotion = acquirePromotionLease('import-session-1', coordinator)
    promotion.release()

    expect(() => svc.closeForPromotion(promotion)).toThrow(/promotion authorization invalid \(released\)/)
    // Refused BEFORE lifecycle mutation: the live DB stays open.
    expect(svc.isInitialised()).toBe(true)
    svc.close()
  })

  it('released (stale) promotion authorization cannot reopen the live DB', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    const promotion = acquirePromotionLease('import-session-1', coordinator)
    expect(svc.closeForPromotion(promotion)).toBe(true)
    promotion.release()

    await expect(svc.reopenForPromotion(promotion)).rejects.toThrow(/promotion authorization invalid \(released\)/)
    expect(svc.isInitialised()).toBe(false)
  })

  it('a forged handle is refused: an ownerId string alone is never authorization', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    // A REAL promotion lease is held by someone else…
    const genuine = acquirePromotionLease('import-session-1', coordinator)
    // …and a forged structural handle claims the same ownerId.
    const forged: PromotionLeaseHandle = {
      ownerId: 'import-session-1',
      isReleased: () => false,
      release: () => true
    }

    expect(() => svc.closeForPromotion(forged)).toThrow(/promotion authorization invalid \(unrecognized-handle\)/)
    await expect(svc.reopenForPromotion(forged)).rejects.toThrow(
      /promotion authorization invalid \(unrecognized-handle\)/
    )
    expect(svc.isInitialised()).toBe(true)

    genuine.release()
    svc.close()
  })

  it('authorization granted on a foreign coordinator is refused', async () => {
    const coordinator = createMaintenanceCoordinator()
    const foreign = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    const foreignPromotion = acquirePromotionLease('import-session-1', foreign)
    expect(() => svc.closeForPromotion(foreignPromotion)).toThrow(
      /promotion authorization invalid \(foreign-coordinator\)/
    )
    expect(svc.isInitialised()).toBe(true)

    foreignPromotion.release()
    svc.close()
  })

  it('uncoordinated (candidate) instances refuse promotion-owned lifecycle entirely', async () => {
    const coordinator = createMaintenanceCoordinator()
    const promotion = acquirePromotionLease('import-session-1', coordinator)

    const candidate = new ChatDbService('/mock/candidate')
    await candidate.init()

    expect(() => candidate.closeForPromotion(promotion)).toThrow(/not joined to a maintenance coordinator/)
    await expect(candidate.reopenForPromotion(promotion)).rejects.toThrow(/not joined to a maintenance coordinator/)
    expect(candidate.isInitialised()).toBe(true)

    candidate.close()
    promotion.release()
  })

  it('reopenForPromotion is idempotent while already open and refuses under the repair marker', async () => {
    const coordinator = createMaintenanceCoordinator()
    const svc = new ChatDbService('/mock/coord', coordinator)
    await svc.init()

    const promotion = acquirePromotionLease('import-session-1', coordinator)

    // Already open: fast path, no second sqlite handle constructed.
    const constructedBefore = MockDatabase.mock.calls.length
    await svc.reopenForPromotion(promotion)
    expect(MockDatabase.mock.calls.length).toBe(constructedBefore)

    // Repair marker gates reopen exactly like public init().
    expect(svc.closeForPromotion(promotion)).toBe(true)
    memfs['/mock/coord/chat.db.repair'] = 'marker'
    await expect(svc.reopenForPromotion(promotion)).rejects.toThrow(/repair-required/)
    delete memfs['/mock/coord/chat.db.repair']

    promotion.release()
  })

  // =========================================================================
  // Phase 4.4.3 — markRepairRequiredBeforeInit (LOCK-4437)
  // =========================================================================

  describe('markRepairRequiredBeforeInit (Phase 4.4.3)', () => {
    it('writes repair marker and blocks subsequent init', async () => {
      clearMemfs()
      const svc = new ChatDbService('/mock/phase443')

      // Precondition: no repair marker, init should succeed.
      expect(svc.isRepairRequired()).toBe(false)
      await svc.init()
      expect(svc.isInitialised()).toBe(true)
      svc.close()

      // Mark repair-required before init.
      svc.markRepairRequiredBeforeInit()
      expect(svc.isRepairRequired()).toBe(true)

      // Subsequent init refuses.
      await expect(svc.init()).rejects.toThrow(/repair-required/)
      expect(svc.isInitialised()).toBe(false)
    })

    it('is idempotent — no-op when marker already exists', () => {
      clearMemfs()
      const svc = new ChatDbService('/mock/phase443-idempotent')

      // First call writes the marker.
      svc.markRepairRequiredBeforeInit()
      expect(svc.isRepairRequired()).toBe(true)

      // Second call is a no-op (idempotent).
      svc.markRepairRequiredBeforeInit()
      expect(svc.isRepairRequired()).toBe(true)
    })

    it('refuses to write marker if service is already initialized', async () => {
      clearMemfs()
      const svc = new ChatDbService('/mock/phase443-refuse')
      await svc.init()

      // Cannot mark repair-required while DB is open.
      expect(() => svc.markRepairRequiredBeforeInit()).toThrow(
        /Cannot mark repair-required: ChatDbService is already initialized/
      )
      expect(svc.isRepairRequired()).toBe(false)

      svc.close()
    })

    it('creates parent directory if it does not exist', () => {
      clearMemfs()
      const svc = new ChatDbService('/mock/phase443-newdir')

      // Parent directory does not exist yet.
      expect(memfs['/mock/phase443-newdir']).toBeUndefined()

      svc.markRepairRequiredBeforeInit()

      // Marker written and parent directory created.
      expect(svc.isRepairRequired()).toBe(true)
      expect(memfs['/mock/phase443-newdir']).toBeDefined()
    })

    it('blocks getDatabase() and getSqlite() when repair marker exists', async () => {
      clearMemfs()
      const svc = new ChatDbService('/mock/phase443-blockers')
      await svc.init()
      svc.close()

      svc.markRepairRequiredBeforeInit()

      // Public getters refuse operation while repair is pending.
      expect(() => svc.getDatabase()).toThrow(/repair-required/)
      expect(() => svc.getSqlite()).toThrow(/repair-required/)
      expect(() => svc.getBackup()).toThrow(/repair-required/)

      // isInitialised returns false even though handles exist.
      expect(svc.isInitialised()).toBe(false)
    })

    it('maintenance coordination interaction — repair marker does not affect coordinator', async () => {
      clearMemfs()
      const coordinator = createMaintenanceCoordinator()
      const svc = new ChatDbService('/mock/phase443-coord', coordinator)

      // Init acquires its own lease on the coordinator.
      await svc.init()
      expect(svc.isInitialised()).toBe(true)

      // Close acquires its own lease.
      expect(svc.close()).toBe(true)

      // Mark repair-required — coordinator is unaffected.
      svc.markRepairRequiredBeforeInit()
      expect(svc.isRepairRequired()).toBe(true)

      // Init still refuses due to repair marker.
      expect(svc.isRepairRequired()).toBe(true)
      await expect(svc.init()).rejects.toThrow(/repair-required/)
    })

    it('marker write failure propagates (does not swallow)', () => {
      clearMemfs()
      const svc = new ChatDbService('/mock/phase443-fail')

      // Override writeFileSync to throw on the repair marker path.
      const originalWriteFileSync = (fs as any).writeFileSync
      ;(fs as any).writeFileSync = vi.fn((p: string, _data: string) => {
        if (p.includes('chat.db.repair')) {
          throw new Error('ENOSPC: no space left on device')
        }
        return originalWriteFileSync(p, _data)
      })

      expect(() => svc.markRepairRequiredBeforeInit()).toThrow(/Failed to write durable repair marker/)
      expect(svc.isRepairRequired()).toBe(false)

      // Restore.
      ;(fs as any).writeFileSync = originalWriteFileSync
    })

    it('marker does not allow arbitrary path — only dbDir is used', () => {
      clearMemfs()
      const svc = new ChatDbService('/mock/phase443-fixedpath')

      svc.markRepairRequiredBeforeInit()

      // Marker is always at dbDir/chat.db.repair — never at an arbitrary path.
      expect(memfs['/mock/phase443-fixedpath/chat.db.repair']).toBeDefined()
      expect(memfs['/arbitrary/path/chat.db.repair']).toBeUndefined()
    })
  })
})

// =========================================================================
// 12. Startup diagnostics (LOCK-001/002/003)
//
// Top-level describe: the singleton must be closed and the once-per-process
// diagnostic counters reset before every test, because init tests in earlier
// describes would otherwise consume the budgets and leave the singleton open.
// =========================================================================

describe('Startup diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSqliteInstances.length = 0
    appliedMigrationKeys.length = 0
    clearMemfs()
    resetSingletonState()
    resetDiagnosticCounters()
  })

  afterEach(() => {
    resetSingletonState()
  })

  it('emits one-time startup stage + metadata logs after successful init', async () => {
    await chatDbService.init()

    const infoText = mockLogger.info.mock.calls.map((call: any[]) => String(call[0] ?? '')).join('\n')
    expect(infoText).toContain('[diagnostics] chatdb.init.open')
    expect(infoText).toContain('[diagnostics] chatdb.init.pragma')
    expect(infoText).toContain('[diagnostics] chatdb.init.migrate')
    expect(infoText).toContain('[diagnostics] chatdb.startup.metadata')

    const metadataCall = mockLogger.info.mock.calls.find((call: any[]) =>
      String(call[0]).includes('chatdb.startup.metadata')
    )
    const data = metadataCall?.[1] as Record<string, unknown> | undefined
    expect(data).toBeDefined()
    expect(data!.success).toBe(true)
    // Failure-safe in this mocked env: missing stat → safe null, and the
    // mocked pragma returns null → safe unknown. Never throws.
    expect(data).toHaveProperty('dbSizeBucket')
    expect(data).toHaveProperty('walPresent', false)
    expect(data!.sqlite).toBeDefined()

    // Privacy: diagnostic logs never include the DB path or its directory
    // components (other non-diagnostic lifecycle logs may mention it).
    const diagText = mockLogger.info.mock.calls
      .map((call: any[]) => String(call[0] ?? ''))
      .filter((text: string) => text.includes('[diagnostics]'))
      .join('\n')
    expect(diagText).not.toContain('/mock/data')
    expect(diagText).not.toContain('chat.db')
    expect(JSON.stringify(data)).not.toContain('/mock')
  })

  it('emits stage timings only once per process lifetime (bounded, LOCK-003)', async () => {
    // Two full init cycles in one process → only the first emits.
    await chatDbService.init()
    chatDbService.close()
    vi.clearAllMocks()
    await chatDbService.init()

    const infoText = mockLogger.info.mock.calls.map((call: any[]) => String(call[0] ?? '')).join('\n')
    expect(infoText).not.toContain('[diagnostics] chatdb.startup.metadata')
    expect(infoText).not.toContain('[diagnostics] chatdb.init.open')
  })

  it('emits a bounded failure diagnostic when init fails without swallowing the error', async () => {
    MockDatabase.mockImplementationOnce(() => {
      throw new Error('Simulated DB open failure')
    })

    await expect(chatDbService.init()).rejects.toThrow('Simulated DB open failure')

    const infoText = mockLogger.info.mock.calls.map((call: any[]) => String(call[0] ?? '')).join('\n')
    expect(infoText).toContain('[diagnostics] chatdb.init.failed')
    const failedCall = mockLogger.info.mock.calls.find((call: any[]) => String(call[0]).includes('chatdb.init.failed'))
    const data = failedCall?.[1] as Record<string, unknown> | undefined
    expect(data).toBeDefined()
    expect(data!.success).toBe(false)
  })
})
