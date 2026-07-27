/**
 * Candidate database resource lifecycle for the ChatImport pipeline (Phase 4.2).
 *
 * Responsibilities:
 * - Own a per-import-session candidate SQLite directory that is fully
 *   independent from the live Data/chat.db and the live chatDbService
 *   singleton (LOCK-4202B). This module NEVER opens or mutates the live
 *   database.
 * - Lay candidates out under a dedicated Data subdirectory. Each session
 *   owns `<Data>/chat-import-candidates/candidate-<sessionId>/` and
 *   ChatDbService creates `chat.db` (+ isolated WAL/SHM sidecars) inside it
 *   (LOCK-4202A).
 * - Provide create/init, DB/path/writer handoff, close(seal), discard, a
 *   best-effort synchronous close for will-quit, and orphan recovery.
 *
 * Ownership / safety (LOCK-4213A):
 * - Ownership is explicit and deterministic: a session ID maps to exactly
 *   one owned directory under the owned prefix.
 * - close/seal is idempotent.
 * - discard() closes the handle BEFORE bounded-retry deletion so chat.db,
 *   its `-wal` and `-shm` sidecars are removable.
 * - Orphan recovery only touches directories under the owned candidate root
 *   whose names match the owned prefix and exceed the age policy.
 *
 * Phase boundary (LOCK-4213B):
 * - A sealed candidate remains on disk for Phase 4.3. This module does NOT
 *   rename, promote, relaunch, or run any source-vs-target verification.
 *
 * Patterns (LOCK-4213C):
 * - Logging goes through loggerService only; no console logging.
 * - Bounded EBUSY retry and crash-recovery mirror tempWorkspace, but the
 *   candidate root and its ownership are deliberately decoupled from the
 *   extracted source workspace ownership.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import { ChatDbService } from '@main/services/chatDb'

const logger = loggerService.withContext('chatDbImportCandidate')

// ---------------------------------------------------------------------------
// Constants — owned layout + retry/age policy
// ---------------------------------------------------------------------------

/** Dedicated subdirectory (under the Data root) that holds all candidates. */
export const CANDIDATE_ROOT_DIRNAME = 'chat-import-candidates'

/** Prefix for per-session candidate directories. Ownership marker. */
export const CANDIDATE_DIR_PREFIX = 'candidate-'

/** Candidate database filename created inside each session directory. */
export const CANDIDATE_DB_FILENAME = 'chat.db'

/** Live database filename — used only as an isolation sentinel guard. */
const LIVE_DB_FILENAME = 'chat.db'

/** Maximum EBUSY retry attempts for deletion. */
const MAX_RETRY_ATTEMPTS = 3

/** Delay between retry attempts in milliseconds. */
const RETRY_DELAY_MS = 1000

/** Age threshold for orphan detection (1 hour in ms). */
const ORPHAN_AGE_MS = 60 * 60 * 1000

/**
 * Strict allowlist for session IDs. Matches UUIDs and similar tokens while
 * rejecting anything that could enable path traversal (no dots, slashes,
 * separators, or `..`). Deterministic ownership requires a safe leaf name.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle state of a candidate resource. */
export type CandidateState = 'new' | 'initialized' | 'sealed' | 'discarded'

/**
 * Minimal surface required from the underlying DB service. ChatDbService
 * satisfies this. Injectable so tests can substitute a lightweight double
 * without coupling to migrations, while production always uses ChatDbService
 * (LOCK-4202A).
 */
export interface CandidateDbService {
  init(): Promise<void>
  close(): void
  getDatabase(): unknown
  getSqlite(): unknown
  getDbDir(): string
  getDbPath(): string
  isInitialised(): boolean
}

/** Factory that constructs a DB service bound to a specific directory. */
export type CandidateDbServiceFactory = (dbDir: string) => CandidateDbService

export interface CandidateDbOptions {
  /** Import session ID. Must match the strict allowlist. */
  sessionId: string
  /**
   * Data root under which the candidate root lives. Defaults to DATA_PATH.
   * Injectable for tests so no live Data path is touched.
   */
  dataRoot?: string
  /**
   * DB service factory. Defaults to ChatDbService. Injectable for tests.
   */
  chatDbServiceFactory?: CandidateDbServiceFactory
}

// ---------------------------------------------------------------------------
// Module-level ownership helpers
// ---------------------------------------------------------------------------

/** Resolve the owned candidate root directory under a Data root. */
export function getCandidateRoot(dataRoot: string = DATA_PATH): string {
  return path.join(dataRoot, CANDIDATE_ROOT_DIRNAME)
}

/**
 * Validate a session ID against the strict allowlist.
 * @throws {Error} if the ID is empty or contains unsafe characters.
 */
function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `Invalid candidate session ID: refused for path safety. ` +
        `IDs must match ${SESSION_ID_PATTERN.toString()} (no separators, dots, or "..").`
    )
  }
}

/**
 * Compute and validate the owned candidate directory for a session.
 * Guarantees the resolved directory is strictly inside the candidate root
 * (defence-in-depth against traversal) and never equals the live DB dir.
 */
function resolveOwnedCandidateDir(
  sessionId: string,
  dataRoot: string
): { candidateRoot: string; candidateDir: string } {
  assertValidSessionId(sessionId)

  const candidateRoot = getCandidateRoot(dataRoot)
  const candidateDir = path.join(candidateRoot, `${CANDIDATE_DIR_PREFIX}${sessionId}`)

  // Defence-in-depth: ensure the resolved directory stays under the root.
  const resolvedRoot = path.resolve(candidateRoot)
  const resolvedDir = path.resolve(candidateDir)
  if (resolvedDir !== path.join(resolvedRoot, `${CANDIDATE_DIR_PREFIX}${sessionId}`)) {
    throw new Error('Candidate path escaped the owned candidate root (path traversal rejected).')
  }
  if (!resolvedDir.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Candidate path escaped the owned candidate root (path traversal rejected).')
  }

  // Isolation sentinel: the candidate DB must never resolve to the live DB.
  const liveDbPath = path.resolve(path.join(dataRoot, LIVE_DB_FILENAME))
  const candidateDbPath = path.resolve(path.join(candidateDir, CANDIDATE_DB_FILENAME))
  if (candidateDbPath === liveDbPath) {
    throw new Error('Refusing to use live Data/chat.db as a candidate database (isolation violation).')
  }

  return { candidateRoot, candidateDir }
}

// ---------------------------------------------------------------------------
// CandidateDbResource — one instance per import session
// ---------------------------------------------------------------------------

/**
 * Owns a single per-session candidate database directory and its lifecycle.
 * Construction validates ownership; no filesystem side effects occur until
 * initialize() is called.
 */
export class CandidateDbResource {
  readonly sessionId: string
  private readonly dataRoot: string
  private readonly candidateDir: string
  private readonly candidateDbPath: string
  private readonly factory: CandidateDbServiceFactory
  private service: CandidateDbService | null = null
  private state: CandidateState = 'new'

  constructor(options: CandidateDbOptions) {
    this.sessionId = options.sessionId
    this.dataRoot = options.dataRoot ?? DATA_PATH
    this.factory = options.chatDbServiceFactory ?? ((dbDir: string) => new ChatDbService(dbDir))

    const { candidateDir } = resolveOwnedCandidateDir(this.sessionId, this.dataRoot)
    this.candidateDir = candidateDir
    this.candidateDbPath = path.join(candidateDir, CANDIDATE_DB_FILENAME)
  }

  /** Current lifecycle state. */
  getState(): CandidateState {
    return this.state
  }

  /** Absolute path to this session's owned candidate directory. */
  getCandidateDir(): string {
    return this.candidateDir
  }

  /** Absolute path to the candidate chat.db (independent of the live DB). */
  getDbPath(): string {
    return this.candidateDbPath
  }

  /**
   * Create the owned directory and initialize the candidate database.
   *
   * Idempotent while initialized: a second call is a no-op. Refuses to run
   * after seal() or discard().
   *
   * @throws {Error} if called after the candidate has been sealed/discarded.
   */
  async initialize(): Promise<void> {
    if (this.state === 'initialized') {
      return
    }
    if (this.state === 'sealed') {
      throw new Error('Cannot initialize a sealed candidate.')
    }
    if (this.state === 'discarded') {
      throw new Error('Cannot initialize a discarded candidate.')
    }

    // Create the owned directory tree deterministically before opening.
    fs.mkdirSync(this.candidateDir, { recursive: true })

    const service = this.factory(this.candidateDir)
    await service.init()

    this.service = service
    this.state = 'initialized'
    logger.info(`Initialized candidate database for session ${this.sessionId} at ${this.candidateDbPath}`)
  }

  /**
   * Return the underlying DB service for writer handoff (Phase 4.3 consumer).
   * @throws {Error} if not initialized.
   */
  getService(): CandidateDbService {
    this.assertInitialized()
    return this.service as CandidateDbService
  }

  /**
   * Return the underlying Drizzle database handle.
   * @throws {Error} if not initialized.
   */
  getDatabase(): unknown {
    this.assertInitialized()
    return (this.service as CandidateDbService).getDatabase()
  }

  /**
   * Return the raw better-sqlite3 handle for the candidate database.
   * @throws {Error} if not initialized.
   */
  getSqlite(): unknown {
    this.assertInitialized()
    return (this.service as CandidateDbService).getSqlite()
  }

  /**
   * Close (seal) the candidate database. The files remain on disk so the
   * sealed candidate is available for Phase 4.3 (LOCK-4213B).
   *
   * Idempotent (LOCK-4213A): safe to call any number of times and in any
   * post-init state. Synchronous — usable from will-quit.
   */
  seal(): void {
    if (this.service) {
      try {
        this.service.close()
      } catch (error) {
        // Preserve deterministic state; report but do not throw from seal.
        logger.error(`Error sealing candidate database for session ${this.sessionId}:`, error as Error)
      }
      this.service = null
    }
    if (this.state !== 'discarded') {
      this.state = 'sealed'
      logger.info(`Sealed candidate database for session ${this.sessionId}`)
    }
  }

  /**
   * Discard the candidate: close the handle first, then remove the entire
   * owned directory (chat.db + WAL/SHM sidecars) with bounded EBUSY retry.
   *
   * Idempotent: removing an already-removed directory is a no-op.
   */
  async discard(): Promise<void> {
    this.seal()
    await removeDirWithRetryAsync(this.candidateDir)
    this.state = 'discarded'
    logger.info(`Discarded candidate database for session ${this.sessionId}`)
  }

  /**
   * Synchronous discard for the will-quit handler. Closes the handle then
   * removes the owned directory with bounded EBUSY retry (sync).
   */
  discardSync(): void {
    this.seal()
    removeDirWithRetrySync(this.candidateDir)
    this.state = 'discarded'
    logger.info(`Discarded candidate database (sync) for session ${this.sessionId}`)
  }

  private assertInitialized(): void {
    if (this.state !== 'initialized' || !this.service) {
      throw new Error(`Candidate database for session ${this.sessionId} is not initialized (state: ${this.state}).`)
    }
  }
}

// ---------------------------------------------------------------------------
// Orphan recovery — bounded, prefix + age scoped (decoupled from tempWorkspace)
// ---------------------------------------------------------------------------

/**
 * Scan the owned candidate root for `candidate-*` directories older than the
 * age policy and remove them. Only touches directories under the owned root
 * whose names match the owned prefix (LOCK-4213A). Non-fatal: individual
 * removal failures are logged and skipped.
 */
export async function recoverOrphanedCandidates(dataRoot: string = DATA_PATH): Promise<void> {
  const candidateRoot = getCandidateRoot(dataRoot)

  let entries: string[]
  try {
    entries = await fs.promises.readdir(candidateRoot)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      // No candidate root yet — nothing to recover.
      return
    }
    logger.error('Failed to scan candidate root for orphaned candidates:', error as Error)
    return
  }

  const now = Date.now()
  let cleaned = 0

  for (const entry of entries) {
    if (!entry.startsWith(CANDIDATE_DIR_PREFIX)) continue

    const fullPath = path.join(candidateRoot, entry)
    try {
      const stat = await fs.promises.stat(fullPath)
      if (!stat.isDirectory()) continue

      const age = now - stat.mtimeMs
      if (age < ORPHAN_AGE_MS) continue

      logger.info(`Removing orphaned candidate: ${fullPath} (age: ${Math.round(age / 1000)}s)`)
      await removeDirWithRetryAsync(fullPath)
      cleaned++
    } catch (error) {
      logger.warn(`Skipping orphaned candidate ${fullPath}:`, error as Error)
    }
  }

  if (cleaned > 0) {
    logger.info(`Cleaned ${cleaned} orphaned candidate(s)`)
  }
}

// ---------------------------------------------------------------------------
// Internals — bounded EBUSY retry deletion (async + sync)
// ---------------------------------------------------------------------------

async function removeDirWithRetryAsync(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true })
      return
    } catch (error: any) {
      if (error?.code === 'EBUSY' && attempt < MAX_RETRY_ATTEMPTS) {
        logger.warn(`EBUSY removing ${dir}, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`)
        await delay(RETRY_DELAY_MS)
        continue
      }
      logger.error(`Failed to remove candidate directory ${dir} after ${attempt} attempts:`, error as Error)
      throw error
    }
  }
}

function removeDirWithRetrySync(dir: string): void {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch (error: any) {
      if (error?.code === 'EBUSY' && attempt < MAX_RETRY_ATTEMPTS) {
        logger.warn(
          `EBUSY removing ${dir} (sync), retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`
        )
        delaySync(RETRY_DELAY_MS)
        continue
      }
      logger.error(`Failed to remove candidate directory (sync) ${dir} after ${attempt} attempts:`, error as Error)
      throw error
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function delaySync(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Busy-wait — only used in the synchronous disposal path (will-quit).
  }
}
