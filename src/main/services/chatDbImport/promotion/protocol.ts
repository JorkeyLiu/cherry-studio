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
 * The canonical v1 promotion operation order for the chat.db-only protocol.
 * Pure contract — nothing here executes. Journal phases anchor to this
 * order:
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
 * The canonical v2 promotion operation order for the three-artifact
 * protocol (LOCK-PROMO-2/3/4/5). Journal phases anchor to this order:
 *
 * 1.  journal-candidates-ready      — persist v2 phase `candidates-ready`
 *                                     with the candidate aggregate receipts.
 * 2.  create-rollback-snapshot      — SQLite online backup of the OPEN live
 *                                     chat.db (LOCK-4403).
 * 3.  verify-rollback-snapshot      — full staging validation gate.
 * 4.  publish-rollback-snapshot     — atomic one-retained db snapshot.
 * 5.  create-files-snapshot         — recursive copy of the LIVE Files dir
 *                                     into the fixed staging dir with a
 *                                     verified manifest (LOCK-PROMO-3).
 * 6.  verify-files-snapshot         — manifest + per-file size/SHA-256
 *                                     re-verification of the staging copy.
 * 7.  publish-files-snapshot        — atomic staging → retained Files
 *                                     snapshot dir rename.
 * 8.  capture-catalog-snapshot      — renderer/Dexie read of the LIVE files
 *                                     catalog through the minimal boundary.
 * 9.  verify-catalog-snapshot       — canonical aggregate re-verified from
 *                                     the written snapshot bytes.
 * 10. publish-catalog-snapshot      — atomic durable write of the retained
 *                                     catalog snapshot file.
 * 11. journal-snapshots-ready       — persist v2 phase `snapshots-ready`
 *                                     with the old-generation receipts.
 * 12. close-live-db                 — live ChatDbService close.
 * 13. install-candidate-db          — atomic rename of the candidate chat.db
 *                                     to the live path.
 * 14. journal-db-installed          — persist v2 phase `db-installed`.
 * 15. install-candidate-files       — same-filesystem directory rename/swap
 *                                     of the candidate Files dir to live.
 * 16. journal-files-installed       — persist v2 phase `files-installed`.
 * 17. journal-catalog-pending       — persist v2 phase `catalog-pending`
 *                                     (ordinary UI blocked).
 * 18. apply-candidate-catalog       — single Dexie transaction replace-all
 *                                     via the renderer boundary.
 * 19. verify-catalog-applied        — Dexie facts re-queried and compared to
 *                                     the candidate catalog receipt.
 * 20. journal-catalog-applied       — persist v2 phase `catalog-applied`.
 * 21. reopen-live-db                — reopen the installed replacement.
 * 22. verify-replacement            — db + files parity + catalog transaction
 *                                     result (LOCK-PROMO-9).
 * 23. journal-replacement-verified  — persist v2 phase `replacement-verified`.
 * 24. cleanup-journal               — remove the journal (snapshots RETAINED).
 * 25. relaunch                      — restart the app.
 */
export const PROMOTION_OPERATION_ORDER_V2 = [
  'journal-candidates-ready',
  'create-rollback-snapshot',
  'verify-rollback-snapshot',
  'publish-rollback-snapshot',
  'create-files-snapshot',
  'verify-files-snapshot',
  'publish-files-snapshot',
  'capture-catalog-snapshot',
  'verify-catalog-snapshot',
  'publish-catalog-snapshot',
  'journal-snapshots-ready',
  'close-live-db',
  'install-candidate-db',
  'journal-db-installed',
  'install-candidate-files',
  'journal-files-installed',
  'journal-catalog-pending',
  'apply-candidate-catalog',
  'verify-catalog-applied',
  'journal-catalog-applied',
  'reopen-live-db',
  'verify-replacement',
  'journal-replacement-verified',
  'cleanup-journal',
  'relaunch'
] as const

export type PromotionOperationV2 = (typeof PROMOTION_OPERATION_ORDER_V2)[number]

/**
 * The 12 crash points every v1 recovery decision must cover (LOCK-4406).
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

/**
 * The v2 crash points every three-artifact recovery decision must cover
 * (LOCK-PROMO-6). Each row anchors immediately BEFORE/AFTER a non-idempotent
 * operation, so recovery converges to all-new or all-old deterministically:
 *
 * 1.  before-candidates-ready              — nothing persisted.
 * 2.  after-candidates-ready-before-snapshots — candidates journaled, no
 *      snapshot work; live generation intact.
 * 3.  after-db-snapshot-before-files-snapshot — db snapshot retained.
 * 4.  after-files-snapshot-before-catalog-snapshot — db+files snapshots.
 * 5.  after-catalog-snapshot-before-snapshots-ready — all three snapshots
 *      retained, journal still candidates-ready.
 * 6.  after-snapshots-ready-before-live-close — destructive window armed.
 * 7.  after-live-close-before-db-install    — live DB closed, files intact.
 * 8.  after-db-install-before-db-installed  — live DB replaced, not journaled.
 * 9.  after-db-installed-before-files-install — DB installed + journaled.
 * 10. after-files-install-before-files-installed — Files swapped, not journaled.
 * 11. after-files-installed-before-catalog-pending — Files installed + journaled.
 * 12. after-catalog-pending-before-catalog-apply — catalog apply pending.
 * 13. after-catalog-apply-before-catalog-applied — transaction committed,
 *      not journaled.
 * 14. after-catalog-applied-before-reopen   — catalog applied + journaled.
 * 15. after-reopen-before-verify            — all installed, unverified.
 * 16. verify-db-failed                      — db verification rejected.
 * 17. verify-files-failed                   — files parity rejected.
 * 18. verify-catalog-failed                 — catalog facts rejected.
 * 19. after-replacement-verified-before-journal-cleanup.
 * 20. before-relaunch.
 * 21. will-quit-during-promotion (multi-phase).
 * 22. after-rollback-db-restore-before-files-restore — RECOVERY-TIME
 *      rollback-midway: the retained OLD db was restored but the crash hit
 *      before the OLD Files/catalog restore. Live DB = OLD (still
 *      SQLite-valid, but NOT the candidate receipt), live Files/catalog =
 *      NEW. Covered at files-installed / catalog-pending / catalog-applied /
 *      replacement-verified (LOCK-AMB-6).
 * 23. after-rollback-files-restore-before-catalog-restore — RECOVERY-TIME
 *      rollback-midway: OLD db AND OLD Files restored, crash before the OLD
 *      catalog restore. Live catalog = NEW. Covered at the same four late
 *      phases (LOCK-AMB-6).
 */
export const PROMOTION_CRASH_POINTS_V2 = [
  'before-candidates-ready',
  'after-candidates-ready-before-snapshots',
  'after-db-snapshot-before-files-snapshot',
  'after-files-snapshot-before-catalog-snapshot',
  'after-catalog-snapshot-before-snapshots-ready',
  'after-snapshots-ready-before-live-close',
  'after-live-close-before-db-install',
  'after-db-install-before-db-installed',
  'after-db-installed-before-files-install',
  'after-files-install-before-files-installed',
  'after-files-installed-before-catalog-pending',
  'after-catalog-pending-before-catalog-apply',
  'after-catalog-apply-before-catalog-applied',
  'after-catalog-applied-before-reopen',
  'after-reopen-before-verify',
  'verify-db-failed',
  'verify-files-failed',
  'verify-catalog-failed',
  'after-replacement-verified-before-journal-cleanup',
  'before-relaunch',
  'will-quit-during-promotion',
  'after-rollback-db-restore-before-files-restore',
  'after-rollback-files-restore-before-catalog-restore'
] as const

export type PromotionCrashPointV2 = (typeof PROMOTION_CRASH_POINTS_V2)[number]
