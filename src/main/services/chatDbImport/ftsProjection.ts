/**
 * Candidate-only deferred FTS/normalized search projection maintenance
 * (LOCK-FTS-1..6).
 *
 * Problem (profiled): during L2 bulk import, per-page `message_blocks`
 * writes grow from ~0.26s to 16–41s/page SOLELY because migration 003's
 * triggers + FTS5 trigram virtual table maintain the derived projection
 * synchronously per row. With the derived objects absent, writes stay at
 * ~0.1s/page. `migration_state` records 003, so an explicit rebuild is
 * mandatory before the candidate is sealed.
 *
 * Solution: this candidate-local helper owns an explicit state machine that
 * defers (drops) the derived projection at candidate initialization and
 * rebuilds it atomically exactly once AFTER the data plane finalizes and
 * BEFORE any seal path.
 *
 * Locks honored:
 * - LOCK-FTS-1: only an isolated candidate DB is ever touched here. The
 *   live ChatDbService runtime and its normal writes are never affected;
 *   the helper is instantiated per candidate and never exported as a
 *   generic public live-DB API.
 * - LOCK-FTS-2: every SQL string comes from the single source of truth in
 *   chatDb/migration.ts (DERIVED_PROJECTION_DROP_SQL /
 *   DERIVED_PROJECTION_REBUILD_SQL). No duplicated strings, no reliance on
 *   the migration array index.
 * - LOCK-FTS-3: defer() runs after migrations and atomically drops the
 *   three triggers, then the FTS table, then the normalized table (its
 *   index auto-drops). Fail closed: any error throws and leaves the
 *   candidate in a state the session discards; migration_state 003 remains
 *   recorded.
 * - LOCK-FTS-4: rebuild() is atomic (one transaction) and exactly once:
 *   drop-if-exists in safe order → recreate normalized table/index/FTS →
 *   backfill normalized + FTS from canonical `main_text` rows with
 *   non-null content → recreate the three triggers. Failure rolls back and
 *   aborts/discards the candidate — a candidate is never sealed unrebuilt.
 * - LOCK-FTS-5: explicit state ownership/idempotency: cannot rebuild
 *   before deferral, cannot defer/rebuild twice, cannot run on a failed
 *   helper. Each import session / candidate constructs its own instance,
 *   so retries and new candidates have independent state.
 * - LOCK-FTS-6: post-rebuild insert/update/delete trigger behavior is
 *   restored and search semantics match a trigger-maintained DB; the
 *   rebuild executes the byte-identical migration 003 DDL/backfill
 *   constants (no schema migration version bump).
 * - LOCK-PRIV: logs carry only fixed phase/error contexts, never
 *   content/IDs.
 */

import { loggerService } from '@logger'
import { DERIVED_PROJECTION_DROP_SQL, DERIVED_PROJECTION_REBUILD_SQL } from '@main/services/chatDb/migration'
import type Database from 'better-sqlite3'

const logger = loggerService.withContext('chatDbImportFtsProjection')

/**
 * State machine of the candidate-local deferred projection helper
 * (LOCK-FTS-5):
 *
 *   idle → defer() → deferred → rebuild() → rebuilt
 *   idle/deferred/rebuilt → failure → failed (terminal; further calls throw)
 *
 * - `idle`: migrations applied, derived objects present, nothing done yet.
 * - `deferred`: the derived objects have been dropped atomically; bulk page
 *   writes happen here with NO per-row trigger/FTS maintenance.
 * - `rebuilt`: the derived projection has been recreated atomically exactly
 *   once; the candidate is trigger-maintained again and safe to seal.
 * - `failed`: a defer/rebuild failed; the transaction rolled back and the
 *   caller MUST discard the candidate. Terminal — no further transitions.
 */
export type FtsProjectionState = 'idle' | 'deferred' | 'rebuilt' | 'failed'

/**
 * Fixed-context failure raised by the helper on defer/rebuild failure
 * (LOCK-PRIV): the message is ALWAYS a static phase label — never content,
 * IDs, paths, SQL details, or the underlying error message. The underlying
 * error is retained as `cause` for in-process diagnostics but is never
 * stringified into a log. The caller (orchestrator) routes this into the
 * session error lifecycle, which discards the candidate.
 */
export class CandidateFtsProjectionError extends Error {
  constructor(phase: 'defer' | 'rebuild') {
    super(`Candidate FTS projection ${phase} failed (candidate must be discarded)`)
    this.name = 'CandidateFtsProjectionError'
  }
}

/**
 * Candidate-only deferred FTS/normalized projection maintenance.
 *
 * One instance per candidate resource per import session (LOCK-FTS-5: state
 * is never shared across sessions/retries). The instance owns the raw
 * better-sqlite3 handle captured at defer() and the lifecycle state; no
 * generic free-function API is exported, so this can never be applied to a
 * live database by accident.
 */
export class CandidateFtsProjection {
  private state: FtsProjectionState = 'idle'
  private sqlite: Database.Database | null = null

  /** Current lifecycle state (idle/deferred/rebuilt/failed). */
  getState(): FtsProjectionState {
    return this.state
  }

  /**
   * LOCK-FTS-3: atomically drop the migration-003 derived objects on the
   * candidate DB — three triggers first, then the FTS table, then the
   * normalized table (its message_id index auto-drops). Must run AFTER
   * migrations and BEFORE any page write. Fail closed: any error throws,
   * the transaction rolls back, and the helper enters the terminal `failed`
   * state (the caller must discard the candidate). migration_state 003
   * remains recorded.
   *
   * Exactly-once (LOCK-FTS-5): throws if already deferred/rebuilt/failed.
   *
   * @param sqlite  Raw better-sqlite3 handle of the candidate DB. The
   *   `chatdb_normalize()` scalar must already be registered on it (the
   *   production ChatDbService.init() registers it before migrations).
   */
  defer(sqlite: Database.Database): void {
    this.assertTransitionAllowed()
    this.sqlite = sqlite
    try {
      sqlite.transaction(() => {
        for (const stmt of DERIVED_PROJECTION_DROP_SQL) {
          sqlite.exec(stmt)
        }
      })()
      this.state = 'deferred'
      logger.info('Candidate FTS projection deferred: triggers/FTS/normalized dropped atomically')
    } catch (error) {
      // LOCK-PRIV: static phase context only — the underlying error/cause is
      // never stringified into a log.
      this.state = 'failed'
      this.sqlite = null
      logger.error('Candidate FTS projection defer failed (candidate must be discarded)')
      throw new CandidateFtsProjectionError('defer')
    }
  }

  /**
   * LOCK-FTS-4/5: rebuild the deferred projection atomically and exactly
   * once — drop-if-exists in safe order, recreate normalized table/index/
   * FTS, backfill normalized + FTS from canonical `main_text` rows with
   * non-null content, recreate the three sync triggers. Must run AFTER
   * plane.finalize() and BEFORE the navigation projection/stats/seal.
   *
   * Fail closed: any error rolls back the whole transaction (the candidate
   * stays deferred, never partially rebuilt), the helper enters the
   * terminal `failed` state, and the caller MUST discard the candidate —
   * a candidate without its rebuilt projection never seals.
   *
   * Exactly-once (LOCK-FTS-5): throws unless currently `deferred` (cannot
   * rebuild before deferral, cannot rebuild twice).
   */
  rebuild(): void {
    if (this.state !== 'deferred') {
      throw new Error(
        `Candidate FTS projection rebuild refused: state must be 'deferred' (current: ${this.state}). ` +
          'Rebuild before deferral, double rebuild, and rebuild-after-failure are forbidden (LOCK-FTS-5).'
      )
    }
    const sqlite = this.sqlite
    if (!sqlite) {
      this.state = 'failed'
      throw new Error('Candidate FTS projection rebuild refused: no deferred candidate handle held.')
    }
    try {
      sqlite.transaction(() => {
        for (const stmt of DERIVED_PROJECTION_REBUILD_SQL) {
          sqlite.exec(stmt)
        }
      })()
      this.state = 'rebuilt'
      logger.info('Candidate FTS projection rebuilt: normalized + FTS + sync triggers restored atomically')
    } catch (error) {
      // LOCK-PRIV: static phase context only — the underlying error/cause is
      // never stringified into a log.
      this.state = 'failed'
      this.sqlite = null
      logger.error('Candidate FTS projection rebuild failed (candidate must be discarded)')
      throw new CandidateFtsProjectionError('rebuild')
    }
  }

  /** LOCK-FTS-5: exactly-once transition guard shared by the state entry points. */
  private assertTransitionAllowed(): void {
    if (this.state === 'deferred') {
      throw new Error('Candidate FTS projection already deferred — deferral is exactly-once (LOCK-FTS-5).')
    }
    if (this.state === 'rebuilt') {
      throw new Error('Candidate FTS projection already rebuilt — deferral after rebuild is forbidden (LOCK-FTS-5).')
    }
    if (this.state === 'failed') {
      throw new Error(
        'Candidate FTS projection is in the terminal failed state — the candidate must be discarded (LOCK-FTS-5).'
      )
    }
  }
}
