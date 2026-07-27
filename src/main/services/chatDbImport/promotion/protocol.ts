/**
 * Promotion protocol — pure state/ordering/boundary decisions (Phase 4.4.0).
 *
 * Defines the LOCK-4401 promotion lifecycle as pure data + pure decision
 * functions consumed by the import orchestrator:
 *
 *   verified-candidate → promoting → promoted | promotion-failed
 *
 * - Only `verified-candidate` may enter `promoting`, atomically and
 *   exact-once (the orchestrator's claim token proves exact-once).
 * - Cancel is allowed only BEFORE `promoting`; a promoting candidate must
 *   never be discarded by ordinary disposal; both result states are
 *   terminal.
 * - `promoting` means candidate ownership is frozen for the promotion
 *   executor — it does NOT mean any file has been installed. Phase 4.4.0
 *   performs no live/candidate/snapshot filesystem operations (LOCK-4405).
 *
 * This module performs no I/O and holds no state: every function is a pure
 * total mapping over the import state union. Main-only; never exposed over
 * IPC/preload/renderer.
 */

// ---------------------------------------------------------------------------
// State inputs
// ---------------------------------------------------------------------------

/**
 * The full import state union the boundary decisions are total over.
 * Structurally identical to `ImportState` in ../index.ts (the orchestrator
 * type extends the Phase 4.3 union with the three promotion states below);
 * duplicated here as the protocol's own input domain so the pure layer has
 * no import cycle with the orchestrator.
 */
export type PromotionBoundaryState =
  | 'intake'
  | 'discovering'
  | 'reading'
  | 'candidate-ready'
  | 'verifying'
  | 'verified-candidate'
  | 'verification-failed'
  | 'cancelled'
  | 'error'
  | 'promoting'
  | 'promoted'
  | 'promotion-failed'

/** The unique state allowed to enter `promoting` (LOCK-4401). */
export const PROMOTION_ENTRY_STATE = 'verified-candidate' as const

/** Terminal promotion result states (LOCK-4401). */
export const PROMOTION_RESULT_STATES = ['promoted', 'promotion-failed'] as const

export type PromotionResultState = (typeof PROMOTION_RESULT_STATES)[number]

/**
 * States in which candidate ownership belongs to the promotion protocol:
 * once `promoting` is entered, the candidate (and any persisted recovery
 * assets) may only be released by the promotion executor / startup
 * recovery — never by ordinary import disposal (LOCK-4401).
 */
const PROMOTION_OWNED_STATES: ReadonlySet<PromotionBoundaryState> = new Set([
  'promoting',
  'promoted',
  'promotion-failed'
])

/** Terminal states for cancel purposes: import terminals + promotion results. */
const CANCEL_TERMINAL_STATES: ReadonlySet<PromotionBoundaryState> = new Set([
  'cancelled',
  'error',
  'verification-failed',
  'promoted',
  'promotion-failed'
])

// ---------------------------------------------------------------------------
// Pure guards + boundary decisions
// ---------------------------------------------------------------------------

/** True when the state may atomically enter `promoting` (LOCK-4401). */
export function canEnterPromoting(state: PromotionBoundaryState): boolean {
  return state === PROMOTION_ENTRY_STATE
}

/** True when the state is a terminal promotion result (LOCK-4401). */
export function isPromotionResultState(state: PromotionBoundaryState): state is PromotionResultState {
  return (PROMOTION_RESULT_STATES as readonly string[]).includes(state)
}

/**
 * Cancel decision at the promotion boundary (LOCK-4401):
 * - 'allow'             — cancel proceeds (any pre-promoting, non-terminal state)
 * - 'reject-promoting'  — cancel arrived after `promoting` was entered; it is
 *                         refused and MUST cause no state change or cleanup
 * - 'ignore-terminal'   — terminal state; cancel is a no-op
 */
export type PromotionCancelDecision = 'allow' | 'reject-promoting' | 'ignore-terminal'

export function decidePromotionCancel(state: PromotionBoundaryState): PromotionCancelDecision {
  if (state === 'promoting') return 'reject-promoting'
  if (CANCEL_TERMINAL_STATES.has(state)) return 'ignore-terminal'
  return 'allow'
}

/**
 * Candidate disposal decision (LOCK-4401):
 * - 'discard'  — ordinary disposal owns the candidate and discards it
 * - 'preserve' — promotion owns the candidate; disposal must leave the
 *                candidate files (and persisted recovery assets) on disk.
 *                Applies to `promoting` AND both result states: after the
 *                claim, artifact cleanup belongs exclusively to the
 *                promotion executor / deterministic startup recovery.
 */
export type CandidateDisposalDecision = 'discard' | 'preserve'

export function decideCandidateDisposal(state: PromotionBoundaryState): CandidateDisposalDecision {
  return PROMOTION_OWNED_STATES.has(state) ? 'preserve' : 'discard'
}

/**
 * will-quit decision (LOCK-4401 boundary, pure protocol only):
 * - 'dispose-ordinary'              — normal sync teardown (verifier close →
 *                                     candidate discardSync → reader destroy)
 * - 'preserve-promotion-artifacts'  — the promotion owns the candidate:
 *                                     close only non-promotion resources
 *                                     (reader/verifier/IPC); keep the
 *                                     candidate and persisted recovery assets
 *                                     on disk for deterministic startup
 *                                     recovery (LOCK-4406). Never treat a
 *                                     promoting candidate as an ordinary
 *                                     import leftover.
 */
export type WillQuitDecision = 'dispose-ordinary' | 'preserve-promotion-artifacts'

export function decideWillQuit(state: PromotionBoundaryState): WillQuitDecision {
  return PROMOTION_OWNED_STATES.has(state) ? 'preserve-promotion-artifacts' : 'dispose-ordinary'
}

// ---------------------------------------------------------------------------
// Operation ordering contract (LOCK-4403 ordering + crash-point anchors)
// ---------------------------------------------------------------------------

/**
 * The canonical promotion operation order for Phase 4.4.1+ executors. Pure
 * contract — nothing here executes. Journal phases anchor to this order:
 *
 * 1.  create-rollback-snapshot     — SQLite online backup to the fixed
 *                                    staging name while the live DB is OPEN;
 *                                    never copies WAL/SHM (LOCK-4403).
 * 2.  verify-rollback-snapshot     — snapshot integrity gate; the
 *                                    destructive window may not begin before
 *                                    this passes (LOCK-4403).
 * 3.  publish-rollback-snapshot    — atomic rename staging → fixed snapshot
 *                                    name (one-retained ordering).
 * 4.  journal-snapshot-ready       — persist phase `snapshot-ready`.
 * 5.  close-live-db                — live ChatDbService close.
 * 6.  install-candidate            — install candidate at the live path.
 * 7.  journal-candidate-installed  — persist phase `candidate-installed`.
 * 8.  reopen-live-db               — reopen the installed replacement.
 * 9.  verify-replacement           — integrity_check + foreign_key_check +
 *                                    application sample reads.
 * 10. journal-replacement-verified — persist phase `replacement-verified`.
 * 11. cleanup-journal              — remove the journal (snapshot is
 *                                    RETAINED, LOCK-4403).
 * 12. relaunch                     — restart the app.
 */
export const PROMOTION_OPERATION_ORDER = [
  'create-rollback-snapshot',
  'verify-rollback-snapshot',
  'publish-rollback-snapshot',
  'journal-snapshot-ready',
  'close-live-db',
  'install-candidate',
  'journal-candidate-installed',
  'reopen-live-db',
  'verify-replacement',
  'journal-replacement-verified',
  'cleanup-journal',
  'relaunch'
] as const

export type PromotionOperation = (typeof PROMOTION_OPERATION_ORDER)[number]

/**
 * The 12 crash points every recovery decision must cover (LOCK-4406).
 * Phase 4.4.0 covers them in the pure recovery matrix + unit tests only —
 * no real fault injection.
 */
export const PROMOTION_CRASH_POINTS = [
  'before-snapshot',
  'after-snapshot-before-live-close',
  'after-live-close-before-install',
  'after-install-before-reopen',
  'after-reopen-before-integrity',
  'integrity-check-failed',
  'foreign-key-check-failed',
  'sample-read-failed',
  'rollback-installation-interrupted',
  'after-replacement-verified-before-journal-cleanup',
  'before-relaunch',
  'will-quit-during-promotion'
] as const

export type PromotionCrashPoint = (typeof PROMOTION_CRASH_POINTS)[number]
