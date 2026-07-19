import * as fs from 'node:fs'
import * as path from 'node:path'

import { loggerService } from '@logger'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { migrationState } from './schema'

const logger = loggerService.withContext('ChatDbMigration')

// ---------------------------------------------------------------------------
// Migration definition — each entry maps a version key to its SQL file name.
// SQL files are expected in a `migrations/` subdirectory relative to this file.
// ---------------------------------------------------------------------------
export interface MigrationEntry {
  /** Unique version key stored in migration_state */
  key: string
  /** Filename inside the migrations/ directory */
  sqlFile: string
}

/**
 * Registry of all known migrations in execution order.
 * Add new entries here as migration SQL files are created.
 */
const MIGRATIONS: MigrationEntry[] = [
  // Example (not yet created):
  // { key: '001_initial', sqlFile: '001_initial.sql' },
]

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

/**
 * Run all pending migrations against the provided Drizzle database instance.
 *
 * - Reads `migration_state` to determine which keys have already been applied.
 * - Executes each unapplied migration's SQL inside a transaction.
 * - Records the key in `migration_state` after successful execution.
 */

export function runMigrations(db: BetterSQLite3Database<any>): void {
  // Ensure migration_state table exists (idempotent)
  db.run(/* sql */ `
    CREATE TABLE IF NOT EXISTS migration_state (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `)

  // Fetch already-applied migration keys
  const rows = db.select().from(migrationState).all()
  const applied = new Set(rows.map((r) => r.key))

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.key)) {
      continue
    }

    const sqlPath = path.join(MIGRATIONS_DIR, migration.sqlFile)

    if (!fs.existsSync(sqlPath)) {
      logger.warn(`Migration SQL file not found: ${sqlPath}, skipping`)
      continue
    }

    const sql = fs.readFileSync(sqlPath, 'utf-8')

    logger.info(`Applying migration: ${migration.key}`)

    // Execute migration + record in a single transaction
    db.transaction((tx) => {
      // Split on semicolons as a simple heuristic; handles most migration files.
      // Complex migrations with embedded semicolons in strings should be handled
      // by placing each statement on its own line and using drizzle-kit generate
      // output format in the future.
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      for (const stmt of statements) {
        tx.run(stmt)
      }

      tx.insert(migrationState)
        .values({
          key: migration.key,
          value: migration.sqlFile,
          updatedAt: new Date().toISOString()
        })
        .run()
    })

    logger.info(`Migration applied: ${migration.key}`)
  }
}
