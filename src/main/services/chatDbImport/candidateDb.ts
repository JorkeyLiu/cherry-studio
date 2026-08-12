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
 * Lifecycle audit hardening (LOCK-LIFE-1..4, accepted 4.4.1 blockers):
 * - LOCK-LIFE-1: the candidate ROOT and LEAF must be real directories — a
 *   symlinked root/leaf is rejected BEFORE any candidate DB open, and the
 *   leaf realpath must stay inside the owned candidates root, so a
 *   redirected path can never resolve to the live Data/chat.db.
 *   Initialization validates the ROOT itself before any mkdir runs through
 *   it, and orphan recovery validates the ROOT before readdir — a
 *   symlinked/redirected root fails closed and no external cleanup runs.
 *   Cleanup only removes a validated owned candidate leaf (or a symlink
 *   leaf itself), never the target of an external link.
 * - LOCK-LIFE-2: seal() fails closed while the deferred FTS projection is
 *   unrebuilt (state deferred/failed) — a candidate without its rebuilt
 *   projection never seals; such candidates remain discardable.
 * - LOCK-LIFE-3: a close() false/error is NEVER treated as ownership gone —
 *   in seal() it is a SEAL FAILURE (ownership/state retained), in
 *   initialization-failure cleanup and best-effort discard close the
 *   service reference is retained for retry/disposal instead of being
 *   abandoned. A candidate is never marked sealed over a failed close.
 * - LOCK-LIFE-4: initialize() is concurrency-safe and idempotent —
 *   concurrent callers share one in-flight promise (or are serialized onto
 *   it) and a failed init closes the partially-initialized service handle
 *   (no leaked handles). discard() serializes behind the in-flight
 *   initialize promise and a teardown flag cancels any concurrent init
 *   publication, so a service is never published after teardown. Fresh
 *   sessions get independent state.
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
import Database from 'better-sqlite3'

import { CandidateFtsProjection } from './ftsProjection'

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
  /**
   * Close the database connection. Returns `false` when the handle could
   * not be closed (close-busy / lease-held / close error) — the caller must
   * treat `false` exactly like a thrown close error (LOCK-LIFE-3). The real
   * ChatDbService satisfies this contract; fakes that close successfully
   * return `true`.
   */
  close(): boolean
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

/**
 * LOCK-LIFE-1 (accepted 4.4.1 audit blocker): verify the on-disk candidate
 * root and leaf are REAL directories and that the leaf's realpath stays
 * inside the owned candidates root, so no symlinked/redirected path can ever
 * open — or create — a database resolving to the live Data/chat.db.
 *
 * The lexical checks in {@link resolveOwnedCandidateDir} only defeat string
 * traversal; they cannot see filesystem redirects. This guard runs AFTER the
 * owned directory tree is created and BEFORE any candidate DB is opened by
 * the service factory (the DB is created/opened by service.init()).
 *
 * Fail closed: any lstat/realpath error, symlinked root/leaf, containment
 * violation, leaf rename, or live-path resolution THROWS a fixed-context
 * error. The caller routes the failure into the session error/discard
 * lifecycle — a candidate DB is never opened over an unverified path.
 *
 * @throws {Error} on any isolation violation (fixed context, no paths).
 */
export function assertOwnedCandidateDirIsolation(
  candidateRoot: string,
  candidateDir: string,
  dataRoot: string,
  sessionId: string
): void {
  const expectedLeaf = `${CANDIDATE_DIR_PREFIX}${sessionId}`

  let rootStat: fs.Stats
  let dirStat: fs.Stats
  try {
    rootStat = fs.lstatSync(candidateRoot)
    dirStat = fs.lstatSync(candidateDir)
  } catch {
    throw new Error('Candidate isolation refused: candidate root/leaf is unreadable (fail closed, no DB open).')
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Candidate isolation refused: candidate root is not a real directory (symlink/redirect rejected).')
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('Candidate isolation refused: candidate leaf is not a real directory (symlink/redirect rejected).')
  }

  // Realpath containment: the leaf must resolve strictly INSIDE the owned
  // candidate root — never to the live Data root or any sibling location.
  let realRoot: string
  let realDir: string
  try {
    realRoot = fs.realpathSync(candidateRoot)
    realDir = fs.realpathSync(candidateDir)
  } catch {
    throw new Error('Candidate isolation refused: candidate root/leaf realpath unresolvable (fail closed, no DB open).')
  }
  if (path.basename(realDir) !== expectedLeaf) {
    throw new Error('Candidate isolation refused: candidate leaf renamed by filesystem redirect (rejected).')
  }
  if (realDir === realRoot || !realDir.startsWith(realRoot + path.sep)) {
    throw new Error('Candidate isolation refused: candidate leaf resolved outside the owned candidate root (rejected).')
  }

  // Isolation sentinel (realpath-aware): the candidate DB path must never
  // equal the live Data/chat.db — directly or through a redirect.
  const liveDbPath = path.resolve(path.join(dataRoot, LIVE_DB_FILENAME))
  let realLiveDb = liveDbPath
  try {
    realLiveDb = fs.realpathSync(liveDbPath)
  } catch {
    // Live DB absent — keep the lexical path for the equality guard.
  }
  if (path.join(realDir, CANDIDATE_DB_FILENAME) === realLiveDb) {
    throw new Error('Candidate isolation refused: candidate DB would resolve to the live Data/chat.db (rejected).')
  }
}

/**
 * LOCK-LIFE-1 (accepted 4.4.1 audit blocker): fail closed when the candidate
 * ROOT itself is not a real directory — a symlinked/redirected root must
 * never receive a created leaf, be readdir'd, or be removed through.
 *
 * ENOENT is NOT an error (the root simply does not exist yet — creation is
 * the caller's responsibility and the root is re-validated after creation).
 * A root that exists as a symlink, a regular file, or any non-directory is
 * rejected, as is a root whose realpath cannot be resolved.
 *
 * Used by initialization (BEFORE any mkdir runs through the root), by
 * discard/discardSync (BEFORE any removal runs through the root), and by
 * orphan recovery (BEFORE readdir).
 *
 * @throws {Error} on any isolation violation (fixed context, no paths).
 */
export function assertCandidateRootRealDir(candidateRoot: string): void {
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(candidateRoot)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return
    throw new Error('Candidate isolation refused: candidate root unreadable (fail closed).')
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Candidate isolation refused: candidate root is not a real directory (symlink/redirect rejected).')
  }
  try {
    fs.realpathSync(candidateRoot)
  } catch {
    throw new Error('Candidate isolation refused: candidate root realpath unresolvable (fail closed).')
  }
}

// ---------------------------------------------------------------------------
// Reseal — post-verification sealed-invariant restoration (LOCK-RS3)
// ---------------------------------------------------------------------------

/**
 * Reseal a sealed candidate DB whose sealed invariant was disturbed by a
 * READONLY reopen. The verifier's readonly open leaves empty WAL/SHM
 * residue (0-byte `-wal` + 32KiB empty `-shm`) that the install guard
 * (installCandidate, LOCK-RS1) must reject — so `verified-candidate` must
 * never be claimed over such residue.
 *
 * Deterministic recipe (inspector-proven): writable open →
 * `wal_checkpoint(TRUNCATE)` → close → verify BOTH sidecars absent. The
 * main DB bytes are unchanged (the residue WAL is empty). Plain writable
 * close and readonly checkpoint do NOT remove the residue.
 *
 * Fail closed (LOCK-RS3): every step is strict. A missing/non-file DB, a
 * busy or absent checkpoint result, an open/close error, or a sidecar
 * still present afterwards THROWS. This helper NEVER deletes sidecars —
 * no blind unlink. The caller must route a failure into the session
 * error/discard lifecycle; a failure must never be treated as a sealed
 * candidate.
 *
 * Idempotent: resealing an already-clean sealed candidate is a no-op
 * checkpoint and succeeds.
 *
 * @throws {Error} on any failure (fail closed, no partial seal state).
 */
export function resealSealedCandidate(dbPath: string): void {
  // Fail closed on a missing/non-file candidate BEFORE any writable open
  // (better-sqlite3 would otherwise CREATE the file).
  let isFile = false
  try {
    isFile = fs.statSync(dbPath).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    logger.error(`Candidate reseal refused: candidate DB is not a file: ${dbPath}`)
    throw new Error(`Candidate reseal refused: candidate DB is not a file: ${dbPath}`)
  }

  let checkpointResult: Array<{ busy?: number }> | null = null
  const sqlite = new Database(dbPath, { fileMustExist: true })
  try {
    checkpointResult = sqlite.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }>
  } catch (error) {
    logger.error(`Candidate reseal failed during wal_checkpoint(TRUNCATE) for ${dbPath}:`, error as Error)
    throw error
  } finally {
    sqlite.close()
  }

  // Fail closed on a busy/absent checkpoint: a busy result proves another
  // connection holds the WAL and the residue was NOT durably truncated.
  const row = checkpointResult?.[0]
  const busy = typeof row?.busy === 'number' ? row.busy : NaN
  if (row === undefined || Number.isNaN(busy) || busy !== 0) {
    logger.error(`Candidate reseal failed: wal_checkpoint(TRUNCATE) busy/absent for ${dbPath} (busy=${String(busy)})`)
    throw new Error(
      `Candidate reseal failed: wal_checkpoint(TRUNCATE) did not complete (busy=${String(busy)}). ` +
        'The sealed invariant is NOT restored — refusing to claim a sealed candidate.'
    )
  }

  // Sidecar-absence proof: the sealed invariant means NO -wal / -shm.
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(sidecar)) {
      logger.error(`Candidate reseal failed: sidecar still present after checkpoint: ${sidecar}`)
      throw new Error(
        `Candidate reseal failed: ${path.basename(sidecar)} still present after checkpoint. ` +
          'The sealed invariant is NOT restored — refusing to claim a sealed candidate.'
      )
    }
  }

  logger.info(`Resealed candidate database ${dbPath} (no WAL/SHM sidecars)`)
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
  private readonly candidateRoot: string
  private readonly candidateDir: string
  private readonly candidateDbPath: string
  private readonly factory: CandidateDbServiceFactory
  private service: CandidateDbService | null = null
  private state: CandidateState = 'new'

  /**
   * LOCK-LIFE-4 (accepted 4.4.1 audit blocker): single in-flight initialize
   * promise shared by concurrent callers. Set only while an initialize is
   * running and cleared in `finally`, so a settled failure leaves the
   * resource free for a fresh retry (per-session independence).
   */
  private initializePromise: Promise<void> | null = null

  /**
   * LOCK-LIFE-4 (accepted 4.4.1 audit blocker): set once discard/discardSync
   * begins. Any in-flight initialize that settles afterwards must close its
   * service handle and NEVER publish (set state/service) — teardown and
   * publication are mutually exclusive. Also refuses new initialize() calls
   * so a concurrent init can never start after disposal was requested.
   */
  private teardownRequested = false

  /**
   * Candidate-only deferred FTS/normalized search projection maintenance
   * (LOCK-FTS-3/4/5). One instance per candidate resource per import
   * session — session retries and new candidates get independent state.
   * Exposed for lifecycle wiring (the orchestrator calls
   * {@link deferFtsProjection} after init and {@link rebuildFtsProjection}
   * after the data plane finalizes) and for tests.
   */
  public readonly ftsProjection = new CandidateFtsProjection()

  constructor(options: CandidateDbOptions) {
    this.sessionId = options.sessionId
    this.dataRoot = options.dataRoot ?? DATA_PATH
    this.factory = options.chatDbServiceFactory ?? ((dbDir: string) => new ChatDbService(dbDir))

    const { candidateRoot, candidateDir } = resolveOwnedCandidateDir(this.sessionId, this.dataRoot)
    this.candidateRoot = candidateRoot
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
   * Concurrency-safe (LOCK-LIFE-4): concurrent callers share ONE in-flight
   * promise — the service factory runs exactly once per resource, and no
   * second service handle is created or leaked. A failed init closes the
   * partially-initialized service handle before rethrowing. When that
   * cleanup close succeeds the resource is free for a fresh retry; when the
   * cleanup close itself returns false/throws the handle is RETAINED
   * (LOCK-LIFE-3) and a retry fails closed rather than duplicating it.
   * Teardown cancels any in-flight init's publication (LOCK-LIFE-4).
   *
   * @throws {Error} if called after the candidate has been sealed/discarded.
   */
  async initialize(): Promise<void> {
    // LOCK-LIFE-4: once teardown was requested, no new init may start — a
    // concurrent init could otherwise publish a service after disposal.
    if (this.teardownRequested) {
      throw new Error('Cannot initialize a candidate after teardown was requested.')
    }
    if (this.state === 'initialized') {
      return
    }
    if (this.state === 'sealed') {
      throw new Error('Cannot initialize a sealed candidate.')
    }
    if (this.state === 'discarded') {
      throw new Error('Cannot initialize a discarded candidate.')
    }
    // LOCK-LIFE-4: a caller that arrives while an initialize is in flight
    // joins the SAME promise instead of starting a second service.
    if (this.initializePromise) {
      return this.initializePromise
    }
    const inFlight = this.doInitialize()
    this.initializePromise = inFlight
    try {
      await inFlight
    } finally {
      this.initializePromise = null
    }
  }

  private async doInitialize(): Promise<void> {
    // LOCK-LIFE-3: a handle retained from a prior failed init (cleanup close
    // returned false/threw) must never be abandoned NOR duplicated — retry
    // the close before creating a second handle; if it still cannot close,
    // fail closed so no second handle is created over an open one.
    if (this.service) {
      this.closeServiceBestEffort()
      if (this.service) {
        throw new Error(
          `Candidate initialize retry refused for session ${this.sessionId}: ` +
            'a prior close failure left an open handle that could not be released (fail closed).'
        )
      }
    }

    // LOCK-LIFE-1 (accepted 4.4.1 audit blocker): validate the candidate
    // ROOT itself BEFORE any mkdir runs through it — a symlinked/redirected
    // root must never receive a created leaf (which could resolve onto the
    // live Data/chat.db). ENOENT (root not yet created) is permitted; the
    // root is created and re-validated before the leaf is created.
    assertCandidateRootRealDir(this.candidateRoot)
    fs.mkdirSync(this.candidateRoot, { recursive: true })
    assertCandidateRootRealDir(this.candidateRoot)

    // Create the owned leaf, then verify the full root+leaf isolation
    // (realpath containment + live-DB sentinel) BEFORE any DB open.
    fs.mkdirSync(this.candidateDir, { recursive: true })
    assertOwnedCandidateDirIsolation(this.candidateRoot, this.candidateDir, this.dataRoot, this.sessionId)

    const service = this.factory(this.candidateDir)
    try {
      await service.init()
    } catch (error) {
      // LOCK-LIFE-3: never abandon a partially-initialized handle — if the
      // cleanup close returns false or throws, RETAIN the reference for
      // retry/disposal instead of dropping it.
      this.closeAfterFailedInit(service)
      throw error
    }

    // LOCK-LIFE-4: teardown (discard/discardSync) may have raced the
    // in-flight init — if it did, close the handle and NEVER publish a
    // service after teardown.
    if (this.teardownRequested) {
      this.closeAfterFailedInit(service)
      return
    }

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
   * LOCK-FTS-3: defer the derived search projection on this candidate —
   * atomically drop the three sync triggers, the FTS table, and the
   * normalized table (index auto-drops) so bulk import page writes pay
   * NO per-row trigger/FTS maintenance. Must be called immediately after
   * initialize() and before any page write. Fail closed: any error throws
   * and the candidate must be discarded. migration_state remains recorded;
   * the projection is rebuilt exactly once before seal (LOCK-FTS-4).
   */
  deferFtsProjection(): void {
    this.assertInitialized()
    this.ftsProjection.defer(this.getSqlite() as Database.Database)
  }

  /**
   * LOCK-FTS-4/5: rebuild the deferred projection on this candidate
   * atomically and exactly once — drop-if-exists in safe order, recreate
   * the normalized table/index/FTS, backfill from canonical main_text
   * content-not-null rows, recreate the three sync triggers. Must be called
   * AFTER the data plane finalizes and BEFORE any seal path. Fail closed:
   * any error rolls back and the candidate must be discarded — a candidate
   * is never sealed unrebuilt.
   */
  rebuildFtsProjection(): void {
    this.assertInitialized()
    this.ftsProjection.rebuild()
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
   *
   * Fail closed (LOCK-LIFE-2/3, accepted 4.4.1 audit blockers):
   * - A candidate whose deferred FTS projection is NOT rebuilt (state
   *   `deferred`/`failed`) can never seal — the caller routes the failure
   *   into the error/discard lifecycle (LOCK-FTS-4: never seal unrebuilt).
   * - A close() `false`/throw is a SEAL FAILURE: ownership and lifecycle
   *   state are retained (never marked sealed, never candidate-ready) so
   *   failure/discard handling can still act on the open resource.
   *
   * @throws {Error} when the FTS projection is unrebuilt or the close fails.
   */
  seal(): void {
    if (this.state === 'sealed' || this.state === 'discarded') return

    // LOCK-LIFE-2: seal succeeds ONLY when the deferred projection was
    // rebuilt (or was never deferred — the migrations leave it intact).
    const ftsState = this.ftsProjection.getState()
    if (ftsState === 'deferred' || ftsState === 'failed') {
      logger.error(
        `Candidate seal refused for session ${this.sessionId}: FTS projection not rebuilt (state: ${ftsState}).`
      )
      throw new Error(
        `Candidate seal refused: FTS projection is not rebuilt (state: ${ftsState}). ` +
          'Rebuild the deferred projection before sealing (LOCK-LIFE-2).'
      )
    }

    // LOCK-LIFE-3: close false/error fails the seal — never mark sealed.
    this.closeServiceStrict()
    this.state = 'sealed'
    logger.info(`Sealed candidate database for session ${this.sessionId}`)
  }

  /**
   * LOCK-LIFE-3: strict close for the seal path. A close() returning
   * `false` (close-busy / lease-held) or throwing is a seal failure — the
   * service handle and lifecycle state are retained so the caller can
   * discard. On success the handle is released.
   *
   * @throws {Error} when the close reports failure (fixed context).
   */
  private closeServiceStrict(): void {
    if (!this.service) return
    let closed = true
    try {
      closed = this.service.close()
    } catch (error) {
      logger.error(`Candidate seal failed: database close error for session ${this.sessionId}:`, error as Error)
      throw new Error(`Candidate seal failed: database close error for session ${this.sessionId}.`)
    }
    if (closed === false) {
      logger.error(`Candidate seal failed: database close returned false for session ${this.sessionId}`)
      throw new Error(`Candidate seal failed: database close returned false for session ${this.sessionId}.`)
    }
    this.service = null
  }

  /**
   * Best-effort close for the DISCARD path. Discard must never fail on a
   * close error (LOCK-LIFE-2/3): a deferred-but-unrebuilt candidate and a
   * failed-seal candidate both remain discardable, and the bounded-retry
   * directory removal tolerates a still-open handle.
   *
   * LOCK-LIFE-3 (accepted 4.4.1 audit blocker): a close() that returns
   * `false` or throws is NOT treated as ownership gone — the handle is
   * RETAINED so a later disposal can retry the close. Only a successful
   * close releases the reference.
   */
  private closeServiceBestEffort(): void {
    if (!this.service) return
    let closed = true
    try {
      closed = this.service.close()
    } catch (error) {
      closed = false
      logger.warn(`Candidate close (best-effort) reported an error for session ${this.sessionId}:`, error as Error)
    }
    if (closed === true) {
      this.service = null
    } else {
      logger.warn(
        `Candidate close (best-effort) reported failure for session ${this.sessionId}: handle retained for disposal.`
      )
    }
  }

  /**
   * LOCK-LIFE-3 (accepted 4.4.1 audit blocker): cleanup close after a failed
   * initialize (or a teardown-cancelled publication). A close() that returns
   * `false` or throws must never abandon the handle — the reference is
   * retained so the caller can retry the close or dispose. A successful
   * close releases the handle.
   */
  private closeAfterFailedInit(service: CandidateDbService): void {
    let closed = true
    try {
      closed = service.close()
    } catch (error) {
      closed = false
      logger.warn(`Candidate close after failed init reported an error for session ${this.sessionId}:`, error as Error)
    }
    if (closed === true) return
    this.service = service
    logger.warn(
      `Candidate close after failed init reported failure for session ${this.sessionId}: handle retained for disposal.`
    )
  }

  /**
   * Re-establish the sealed invariant after READONLY verification residue
   * (LOCK-RS3/RS4): writable open + deterministic `wal_checkpoint(TRUNCATE)`
   * + close, then prove BOTH sidecars absent — main DB bytes unchanged.
   *
   * Only valid from `sealed` state: a resealed candidate stays `sealed` on
   * success. Fail closed — any failure THROWS (never a blind unlink, never
   * a partial seal state) and the session must route it into the
   * error/discard lifecycle instead of claiming `verified-candidate`.
   */
  reseal(): void {
    if (this.state !== 'sealed') {
      throw new Error(`Candidate reseal refused: candidate is not sealed (state: ${this.state}).`)
    }
    resealSealedCandidate(this.candidateDbPath)
  }

  /**
   * Discard the candidate: close the handle first, then remove the entire
   * owned directory (chat.db + WAL/SHM sidecars) with bounded EBUSY retry.
   *
   * Idempotent: removing an already-removed directory is a no-op.
   *
   * LOCK-LIFE-2/3: discard NEVER requires the FTS projection to be rebuilt
   * and NEVER fails on a close error — deferred-but-unrebuilt candidates and
   * failed-seal candidates must remain discardable. A close() `false`/throw
   * retains the handle (ownership is not claimed gone while close failed).
   *
   * LOCK-LIFE-4 (accepted 4.4.1 audit blocker): teardown serializes behind
   * any in-flight initialize so a concurrent init can never remove or
   * publish a service after disposal. The teardown flag also cancels a
   * concurrent init's publication. A failed init is absorbed — cleanup still
   * proceeds and the resource ends discarded.
   *
   * LOCK-LIFE-1: removal never runs through an unvalidated candidate root —
   * a root replaced by a symlink after init fails closed before any removal.
   */
  async discard(): Promise<void> {
    this.teardownRequested = true
    if (this.initializePromise) {
      try {
        await this.initializePromise
      } catch {
        // init failed — discard proceeds to clean up whatever remains.
      }
    }

    // LOCK-LIFE-1: cleanup must never remove through an unvalidated root.
    assertCandidateRootRealDir(this.candidateRoot)

    this.closeServiceBestEffort()
    await removeDirWithRetryAsync(this.candidateDir)
    this.state = 'discarded'
    logger.info(`Discarded candidate database for session ${this.sessionId}`)
  }

  /**
   * Synchronous discard for the will-quit handler. Closes the handle then
   * removes the owned directory with bounded EBUSY retry (sync).
   *
   * LOCK-LIFE-4: a synchronous teardown cannot await an in-flight initialize,
   * so it sets the teardown flag — the in-flight init, when it settles,
   * closes its handle and never publishes a service after teardown.
   *
   * LOCK-LIFE-1: removal never runs through an unvalidated candidate root.
   */
  discardSync(): void {
    this.teardownRequested = true
    assertCandidateRootRealDir(this.candidateRoot)
    this.closeServiceBestEffort()
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
 * True when `value` is a candidate/session ID under the strict allowlist
 * (identical policy to the promotion journal ID allowlist, LOCK-4415).
 */
export function isValidCandidateId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/**
 * True when `value` is an opaque owned candidate directory ID as emitted by
 * the import session and recorded in the promotion journal
 * (`candidate-<sessionId>`): strict allowlist PLUS the owned prefix with a
 * non-empty remainder. The candidate ID contract is exactly one shape — the
 * ID IS the owned directory leaf name (LOCK-4415).
 */
export function isValidOwnedCandidateId(value: unknown): value is string {
  return (
    isValidCandidateId(value) && value.startsWith(CANDIDATE_DIR_PREFIX) && value.length > CANDIDATE_DIR_PREFIX.length
  )
}

/**
 * Map a validated opaque candidate ID to its owned directory leaf name.
 *
 * Contract (LOCK-4415, accepted 4.4.1 audit correction): the candidate ID
 * emitted by the import session (`InternalImportSession.candidateId`) and
 * carried by the promotion journal is `candidate-<sessionId>` — which is
 * byte-for-byte the owned directory leaf created by CandidateDbResource.
 * The mapping is therefore applied exactly once: strict validation, then
 * identity. The prefix is NEVER prepended again (double-prefixing would
 * "protect" a directory that does not exist and leave the real promoting
 * candidate exposed to age-based deletion).
 *
 * Pure name mapping — never builds an absolute path from caller input, so
 * an ID can never smuggle a path.
 *
 * @throws {Error} if the ID fails the strict allowlist or does not carry
 *   the owned `candidate-` prefix with a non-empty remainder.
 */
export function getOwnedCandidateDirName(candidateId: string): string {
  assertValidSessionId(candidateId)
  if (!candidateId.startsWith(CANDIDATE_DIR_PREFIX) || candidateId.length <= CANDIDATE_DIR_PREFIX.length) {
    throw new Error(
      `Invalid owned candidate ID: refused for path safety. ` +
        `Candidate IDs must be the exact owned directory leaf name ("${CANDIDATE_DIR_PREFIX}<sessionId>").`
    )
  }
  return candidateId
}

export interface RecoverOrphanedCandidatesOptions {
  /**
   * Candidate IDs (NOT paths) to protect from age-based cleanup. Every ID is
   * validated against the strict allowlist BEFORE any deletion occurs; an
   * invalid ID aborts the entire cleanup by throwing (an unvalidated ID must
   * never influence — or fail to influence — what gets deleted, LOCK-4415).
   * Protection is matched by owned directory leaf name equality only.
   */
  protectedCandidateIds?: readonly string[]
}

/**
 * Scan the owned candidate root for `candidate-*` directories older than the
 * age policy and remove them. Only touches directories under the owned root
 * whose names match the owned prefix (LOCK-4213A). Non-fatal: individual
 * removal failures are logged and skipped.
 *
 * Directories named by `options.protectedCandidateIds` are excluded from
 * age-based deletion regardless of mtime — a journal-referenced promoting
 * candidate is never an ordinary import leftover (LOCK-4401/4413).
 *
 * LOCK-LIFE-1 (accepted 4.4.1 audit blocker): the candidate ROOT itself is
 * validated (real directory, not a symlink, realpath resolvable) BEFORE any
 * readdir — a symlinked/redirected root fails closed and no external cleanup
 * runs. Per-entry cleanup only removes a validated owned candidate leaf
 * (lstat real directory matching the owned prefix) and never follows a
 * symlinked leaf or its target.
 *
 * @throws {Error} if any protected candidate ID fails the strict allowlist
 *   (thrown before any directory is inspected or removed), or if the
 *   candidate root fails isolation (fail closed, no external cleanup).
 */
export async function recoverOrphanedCandidates(
  dataRoot: string = DATA_PATH,
  options: RecoverOrphanedCandidatesOptions = {}
): Promise<void> {
  // Validate ALL protection input up front — before any filesystem access —
  // so an invalid ID can never partially protect or partially delete.
  const protectedLeafNames = new Set<string>()
  for (const id of options.protectedCandidateIds ?? []) {
    protectedLeafNames.add(getOwnedCandidateDirName(id))
  }

  const candidateRoot = getCandidateRoot(dataRoot)

  // LOCK-LIFE-1 (accepted 4.4.1 audit blocker): validate the candidate ROOT
  // itself BEFORE readdir. A symlinked/redirected root must fail closed so
  // cleanup never follows a link into an external location. ENOENT (no root
  // yet) is a no-op — there is nothing to recover.
  assertCandidateRootRealDir(candidateRoot)

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

    if (protectedLeafNames.has(entry)) {
      // Journal-protected candidate: never age-deleted (LOCK-4413).
      logger.info(`Preserving journal-protected candidate: ${entry}`)
      continue
    }

    const fullPath = path.join(candidateRoot, entry)
    try {
      // LOCK-LIFE-1: only REAL candidate directories are owned/removable.
      // lstat (not stat) so a symlinked `candidate-*` leaf is never treated
      // as an owned directory — the link (and its target) are left alone.
      const stat = await fs.promises.lstat(fullPath)
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

/**
 * Remove the EXACT owned candidate directory for a CONVERGED promotion
 * (LOCK-CLEAN-1..5). Called by the v2 recovery executor ONLY AFTER the
 * promotion journal has been durably cleaned — no recovery path can need
 * the candidate handoff (`files-catalog.json`) anymore, so a successful
 * import leaves no promoted candidate residue.
 *
 * Safety / ownership:
 * - LOCK-CLEAN-2: the candidateId is validated against the strict owned
 *   allowlist BEFORE any path resolution or deletion; a malicious/foreign
 *   ID fails closed (throws) and can never influence what gets deleted.
 * - Never broad-deletes: only the exact owned leaf directory named by the
 *   candidateId is a removal candidate; the candidate ROOT and unrelated
 *   sessions are never touched. A non-directory or symlink at the owned
 *   leaf is foreign residue and is LEFT ALONE (never removed).
 * - LOCK-LIFE-1: removal never runs through an unvalidated candidate root —
 *   a root replaced by a symlink after init fails closed before any removal.
 * - LOCK-CLEAN-3: whatever remains in the owned leaf (the
 *   `files-catalog.json` handoff, an empty `Files/` / `chat.db`, and the
 *   empty shell) is removed through the existing bounded EBUSY-retry
 *   primitive. Thrown errors and this helper's own logs carry no private
 *   paths — only the bounded candidate ID and fixed context.
 *
 * Idempotent (LOCK-CLEAN-2): an already-absent leaf is a clean state and
 * returns `true` — safe to call any number of times.
 *
 * @returns `true` when no candidate evidence remains (removed or already
 *   absent).
 * @throws {Error} on an invalid candidateId or when the owned leaf could
 *   not be removed (fixed context — no private paths/names).
 */
export async function removeConvergedCandidate(candidateId: string, dataRoot: string = DATA_PATH): Promise<boolean> {
  // LOCK-CLEAN-2: strict owned-ID validation BEFORE any filesystem access.
  const candidateDirName = getOwnedCandidateDirName(candidateId)

  const candidateRoot = getCandidateRoot(dataRoot)
  const candidateDir = path.join(candidateRoot, candidateDirName)

  // LOCK-LIFE-1: never remove through an unvalidated candidate root. ENOENT
  // root (no candidates yet) is permitted and is a clean state.
  assertCandidateRootRealDir(candidateRoot)

  // Idempotent: an absent owned leaf is already clean.
  let stat: fs.Stats | null = null
  try {
    stat = await fs.promises.lstat(candidateDir)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      logger.info(`Converged candidate already absent (candidateId=${candidateId})`)
      return true
    }
    logger.error(
      `Converged candidate removal refused: owned leaf unreadable (candidateId=${candidateId})`,
      error as Error
    )
    throw new Error('Converged candidate removal refused: owned candidate leaf is unreadable (fail closed).')
  }
  if (!stat.isDirectory()) {
    // LOCK-CLEAN-2: never broad-delete. A non-directory/symlink at the owned
    // leaf is foreign residue, not an owned candidate directory.
    logger.warn(`Converged candidate removal skipped: owned leaf is not a directory (candidateId=${candidateId})`)
    return true
  }

  try {
    await removeDirWithRetryAsync(candidateDir)
  } catch (error) {
    logger.error(`Failed to remove converged candidate directory (candidateId=${candidateId})`, error as Error)
    throw new Error('Converged candidate removal failed: owned candidate directory could not be removed.')
  }
  logger.info(`Removed converged candidate directory (candidateId=${candidateId})`)
  return true
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
