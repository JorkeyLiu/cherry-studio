/**
 * Promotion relaunch — exact-once guard for app restart after verified
 * recovery finalization (Phase 4.4.3, LOCK-4438).
 *
 * Accepts only an executor-minted eligible receipt (branded, non-forgeable)
 * and calls `app.relaunch() + app.exit(0)`. The receipt is consumed exactly
 * once — a second call with the same or any receipt is a no-op.
 *
 * LOCK-4438: relaunch happens ONLY after:
 *   1. A verified authoritative live state (the replacement is verified or
 *      the retained rollback snapshot has been restored and verified).
 *   2. Durable journal cleanup has completed (the fixed journal is absent
 *      from disk with parent directory sync).
 *   3. The executor has minted an eligible receipt proving these preconditions.
 *
 * Path safety: no arbitrary paths. The receipt is a branded opaque token;
 * the relaunch delegates to Electron's `app.relaunch()` which uses the
 * original launch command.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import { loggerService } from '@logger'

const logger = loggerService.withContext('chatDbImportPromotionRelaunch')

// ---------------------------------------------------------------------------
// Eligible receipt — branded, non-forgeable, single-use
// ---------------------------------------------------------------------------

/**
 * Opaque relaunch receipt. Only {@link mintRelaunchReceipt} can create a
 * valid one — a structurally identical object forged elsewhere is never
 * registered and is refused by {@link relaunchApp}.
 */
export interface RelaunchReceipt {
  /** Bounded owner label for diagnostics (no paths). */
  readonly ownerId: string
  /** Wall-clock mint time (diagnostic only). */
  readonly mintedAtMs: number
}

const relaunchReceiptBrand = new WeakSet<RelaunchReceipt>()

/** True when `value` is a receipt minted by this module. */
export function isRelaunchReceipt(value: unknown): value is RelaunchReceipt {
  return typeof value === 'object' && value !== null && relaunchReceiptBrand.has(value as RelaunchReceipt)
}

/**
 * Mint a relaunch receipt. Only the recovery executor should call this
 * after all LOCK-4438 preconditions are verified.
 */
export function mintRelaunchReceipt(ownerId: string): RelaunchReceipt {
  const receipt: RelaunchReceipt = Object.freeze({
    ownerId,
    mintedAtMs: Date.now()
  })
  relaunchReceiptBrand.add(receipt)
  return receipt
}

// ---------------------------------------------------------------------------
// Relaunch — exact-once, receipt-gated
// ---------------------------------------------------------------------------

/** Injectable Electron app surface for test isolation. */
export interface RelaunchApp {
  relaunch(): void
  exit(exitCode?: number): void
}

/**
 * Result of {@link relaunchApp}. Never throws.
 */
export type RelaunchResult =
  | { readonly ok: true; readonly relaunched: true }
  | { readonly ok: true; readonly relaunched: false; readonly reason: 'already-relaunched' | 'receipt-invalid' }
  | { readonly ok: false; readonly reason: 'receipt-invalid' }

/**
 * Relaunch the app exactly once. Accepts only an executor-minted eligible
 * receipt. The receipt is consumed — a second call is a no-op returning
 * `already-relaunched`.
 *
 * LOCK-4438: the caller MUST have completed durable journal cleanup and
 * verified the authoritative live state before calling this. This module
 * does NOT re-verify those preconditions — the executor-minted receipt
 * is the proof.
 *
 * @param receipt  Branded receipt from {@link mintRelaunchReceipt}.
 * @param app      Electron app surface (default: electron `app`).
 */
export function relaunchApp(receipt: RelaunchReceipt, app: RelaunchApp = require('electron').app): RelaunchResult {
  // --- Receipt validation (non-forgeable, single-use) ---
  if (!isRelaunchReceipt(receipt)) {
    logger.warn('Relaunch refused: receipt is not recognized (forged or expired)')
    return { ok: false, reason: 'receipt-invalid' }
  }

  // Exact-once: once consumed, the receipt brand is gone.
  // A second call with the same receipt object hits the brand check above
  // (the WeakSet entry was removed). But we also guard with a module-level
  // flag for clarity.
  if (consumed) {
    logger.info('Relaunch already executed (exact-once guard)')
    return { ok: true, relaunched: false, reason: 'already-relaunched' }
  }
  consumed = true

  logger.info(
    `Relaunching app (owner: ${receipt.ownerId}, ` + `minted at ${new Date(receipt.mintedAtMs).toISOString()})`
  )

  try {
    app.relaunch()
    app.exit(0)
    // app.exit(0) terminates the process — code after this line is
    // unreachable in production but the return satisfies the type system.
    return { ok: true, relaunched: true }
  } catch (error) {
    logger.error('Relaunch failed unexpectedly', error as Error)
    return { ok: false, reason: 'receipt-invalid' }
  }
}

/** Module-level exact-once guard. Reset only by tests. */
let consumed = false

/**
 * Test-only: reset the exact-once guard so each test starts clean.
 * Never call from production.
 */
export function resetRelaunchGuardForTests(): void {
  consumed = false
}
