import * as fs from 'node:fs'
import * as path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from './migration'
import * as schema from './schema'

const logger = loggerService.withContext('ChatDbService')

const DB_FILENAME = 'chat.db'

// ---------------------------------------------------------------------------
// ChatDbService — singleton wrapper around better-sqlite3 + Drizzle ORM
// ---------------------------------------------------------------------------
class ChatDbService {
  private db: BetterSQLite3Database<typeof schema> | null = null
  private sqlite: Database.Database | null = null
  private initPromise: Promise<void> | null = null

  /**
   * Initialise the database connection.
   * Idempotent — concurrent calls share the same promise.
   */
  async init(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this.doInit()
    await this.initPromise
  }

  private async doInit(): Promise<void> {
    const dbDir = DATA_PATH
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    const dbPath = path.join(dbDir, DB_FILENAME)
    logger.info(`Opening database at ${dbPath}`)

    // Open raw better-sqlite3 connection
    this.sqlite = new Database(dbPath)

    // Pragmas for performance and correctness
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('foreign_keys = ON')
    this.sqlite.pragma('synchronous = NORMAL')

    // Wrap with Drizzle ORM
    this.db = drizzle(this.sqlite, { schema })

    // Run pending migrations
    runMigrations(this.db)

    logger.info('ChatDbService initialised')
  }

  /** Return the Drizzle database instance. Throws if not initialised. */
  getDatabase(): BetterSQLite3Database<typeof schema> {
    if (!this.db) {
      throw new Error('ChatDbService has not been initialised. Call init() first.')
    }
    return this.db
  }

  /** Return the raw better-sqlite3 instance. Throws if not initialised. */
  getSqlite(): Database.Database {
    if (!this.sqlite) {
      throw new Error('ChatDbService has not been initialised. Call init() first.')
    }
    return this.sqlite
  }

  /** Close the database connection. */
  close(): void {
    if (this.sqlite) {
      this.sqlite.close()
      this.sqlite = null
      this.db = null
      this.initPromise = null
      logger.info('ChatDbService closed')
    }
  }
}

/** Singleton instance */
export const chatDbService = new ChatDbService()
