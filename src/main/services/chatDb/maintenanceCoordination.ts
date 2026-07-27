/**
 * Chat DB maintenance coordination contract (Phase 4.4.0, LOCK-4402).
 *
 * Defines ONE shared coordination contract covering the five maintenance
 * operations that may not overlap on the live chat database:
 *
 *   backup | restore | promotion | init | close
 *
 * Phase 4.4.1 (LOCK-4416) adopts this contract at runtime: the outer
 * complete backup operations (`BackupManager`), restore staging/activation,
 * and the live `ChatDbService` singleton init/close all coordinate through
 * ONE shared coordinator instance (`getSharedMaintenanceCoordinator`).
 * `BackupManager`/`ChatDbBackup` keep their internal fine-grained mutexes
 * for serialisation; the shared coordinator adds cross-category mutual
 * exclusion. Candidate ChatDbService instances (import candidate DBs) are
 * NOT live maintenance and never join the shared coordinator. Promotion
 * exact-once is additionally enforced by the promotion protocol itself;
 * this contract only serializes maintenance operations (the promotion
 * lease seam below is consumed by later orchestration).
 *
 * Contract semantics:
 * - Single-holder lease: at most one maintenance operation holds the lease
 *   at any time. Every pair of the five operations conflicts (including two
 *   operations of the same kind).
 * - Acquisition is non-blocking and deterministic: it either grants a lease
 *   or reports the conflicting holder. Queueing/retry policy belongs to the
 *   adopting callers, not the contract.
 * - Release is owner-checked and idempotent: only the exact granted lease
 *   releases the slot; stale/duplicate releases are safely refused.
 *
 * Pure in-memory bookkeeping only — no filesystem, SQLite, Electron, or
 * timer usage. Main-only module; never exposed over IPC/preload/renderer.
 */

// ---------------------------------------------------------------------------
// Operations + conflict matrix
// ---------------------------------------------------------------------------

/** The five coordinated maintenance operations (LOCK-4402). */
export const MAINTENANCE_OPERATIONS = ['backup', 'restore', 'promotion', 'init', 'close'] as const

export type MaintenanceOperationKind = (typeof MAINTENANCE_OPERATIONS)[number]

/**
 * True when two maintenance operations may not run concurrently.
 * The matrix is total and symmetric: EVERY pair conflicts (LOCK-4402 —
 * promotion must be mutually exclusive with live backup, restore, other
 * promotions, and ChatDbService init/close; the same holds between the
 * remaining operations because they all touch the live chat.db files).
 */
export function maintenanceOperationsConflict(a: MaintenanceOperationKind, b: MaintenanceOperationKind): boolean {
  assertKnownOperation(a)
  assertKnownOperation(b)
  return true
}

function assertKnownOperation(kind: MaintenanceOperationKind): void {
  if (!(MAINTENANCE_OPERATIONS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown maintenance operation kind: ${String(kind)}`)
  }
}

// ---------------------------------------------------------------------------
// Lease contract
// ---------------------------------------------------------------------------

/** A granted, single-holder maintenance lease. Opaque to holders. */
export interface MaintenanceLease {
  /** Coordinator-assigned unique lease ID (not a path, not user data). */
  readonly leaseId: string
  /** Operation kind this lease was granted for. */
  readonly kind: MaintenanceOperationKind
  /** Caller-supplied owner label for diagnostics (bounded, no paths). */
  readonly ownerId: string
}

/** Result of an acquisition attempt. */
export type MaintenanceAcquireResult =
  | { readonly granted: true; readonly lease: MaintenanceLease }
  | {
      readonly granted: false
      /** The operation currently holding the lease. */
      readonly conflictingKind: MaintenanceOperationKind
      /** Owner label of the current holder. */
      readonly conflictingOwnerId: string
    }

/**
 * Single-holder maintenance coordinator. Pure in-memory state; adopted at
 * runtime in Phase 4.4.1 via `getSharedMaintenanceCoordinator()`.
 */
export interface MaintenanceCoordinator {
  /** Attempt to acquire the exclusive maintenance lease. Non-blocking. */
  acquire(kind: MaintenanceOperationKind, ownerId: string): MaintenanceAcquireResult
  /**
   * Release a previously granted lease. Returns true when this exact lease
   * held the slot; false for stale, duplicate, or foreign leases (refused
   * without disturbing the current holder).
   */
  release(lease: MaintenanceLease): boolean
  /** The kind currently holding the lease, or null when free. */
  currentHolder(): { kind: MaintenanceOperationKind; ownerId: string } | null
}

/** Strict owner label allowlist — bounded, path-free diagnostics only. */
const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Create an independent coordinator instance (pure in-memory state). */
export function createMaintenanceCoordinator(): MaintenanceCoordinator {
  let holder: MaintenanceLease | null = null
  let leaseCounter = 0

  return {
    acquire(kind: MaintenanceOperationKind, ownerId: string): MaintenanceAcquireResult {
      assertKnownOperation(kind)
      if (!OWNER_ID_PATTERN.test(ownerId)) {
        throw new Error('Invalid maintenance ownerId: refused (bounded, path-free labels only).')
      }
      if (holder !== null && maintenanceOperationsConflict(holder.kind, kind)) {
        return { granted: false, conflictingKind: holder.kind, conflictingOwnerId: holder.ownerId }
      }
      leaseCounter += 1
      const lease: MaintenanceLease = Object.freeze({
        leaseId: `maintenance-lease-${leaseCounter}`,
        kind,
        ownerId
      })
      holder = lease
      return { granted: true, lease }
    },

    release(lease: MaintenanceLease): boolean {
      if (holder === null || holder.leaseId !== lease.leaseId) {
        return false
      }
      holder = null
      return true
    },

    currentHolder(): { kind: MaintenanceOperationKind; ownerId: string } | null {
      return holder === null ? null : { kind: holder.kind, ownerId: holder.ownerId }
    }
  }
}

// ---------------------------------------------------------------------------
// Structured busy error (Phase 4.4.1, LOCK-4416)
// ---------------------------------------------------------------------------

/** Stable, classifiable code for maintenance-lease contention. */
export const ERR_CHAT_DB_MAINTENANCE_BUSY = 'ERR_CHAT_DB_MAINTENANCE_BUSY'

/**
 * Thrown when a maintenance operation is refused because another operation
 * holds the shared lease. Structured and classifiable: carries the
 * requested/conflicting kinds and bounded owner labels (never paths).
 *
 * The message intentionally contains the word "busy" so the existing
 * chatDb IPC error mapper classifies it as ERR_BUSY (retryable) without
 * requiring changes to errors.ts.
 */
export class MaintenanceBusyError extends Error {
  readonly code = ERR_CHAT_DB_MAINTENANCE_BUSY
  readonly requestedKind: MaintenanceOperationKind
  readonly requestedOwnerId: string
  readonly conflictingKind: MaintenanceOperationKind
  readonly conflictingOwnerId: string

  constructor(
    requestedKind: MaintenanceOperationKind,
    requestedOwnerId: string,
    conflictingKind: MaintenanceOperationKind,
    conflictingOwnerId: string
  ) {
    super(
      `Chat DB maintenance is busy: '${requestedKind}' (owner '${requestedOwnerId}') refused because ` +
        `'${conflictingKind}' (owner '${conflictingOwnerId}') currently holds the maintenance lease.`
    )
    this.name = 'MaintenanceBusyError'
    this.requestedKind = requestedKind
    this.requestedOwnerId = requestedOwnerId
    this.conflictingKind = conflictingKind
    this.conflictingOwnerId = conflictingOwnerId
  }
}

/** Classify an unknown error as a maintenance busy refusal. */
export function isMaintenanceBusyError(error: unknown): error is MaintenanceBusyError {
  return (
    error instanceof MaintenanceBusyError ||
    (error instanceof Error && (error as { code?: unknown }).code === ERR_CHAT_DB_MAINTENANCE_BUSY)
  )
}

// ---------------------------------------------------------------------------
// Shared runtime coordinator (Phase 4.4.1, LOCK-4416)
// ---------------------------------------------------------------------------

let sharedCoordinator: MaintenanceCoordinator | null = null

/**
 * The single process-wide coordinator adopted by live maintenance callers:
 * BackupManager (backup + restore staging/activation), the live
 * ChatDbService singleton (init/close), and promotion orchestration (via
 * `acquirePromotionLease`). Candidate ChatDbService instances must NOT use
 * this coordinator — candidate init/close are not live maintenance.
 */
export function getSharedMaintenanceCoordinator(): MaintenanceCoordinator {
  if (sharedCoordinator === null) {
    sharedCoordinator = createMaintenanceCoordinator()
  }
  return sharedCoordinator
}

/**
 * Test-only: discard the shared coordinator so each test starts from a
 * free slot. Never call from production code.
 */
export function resetSharedMaintenanceCoordinatorForTests(): void {
  sharedCoordinator = null
}

// ---------------------------------------------------------------------------
// Lease helpers (owner-safe, try/finally friendly)
// ---------------------------------------------------------------------------

/**
 * Acquire a lease or throw a structured `MaintenanceBusyError`.
 * Non-blocking, like the underlying contract.
 */
export function acquireMaintenanceLeaseOrThrow(
  coordinator: MaintenanceCoordinator,
  kind: MaintenanceOperationKind,
  ownerId: string
): MaintenanceLease {
  const result = coordinator.acquire(kind, ownerId)
  if (!result.granted) {
    throw new MaintenanceBusyError(kind, ownerId, result.conflictingKind, result.conflictingOwnerId)
  }
  return result.lease
}

/**
 * Run `fn` while holding the maintenance lease for `kind`.
 * Throws `MaintenanceBusyError` when the slot is held; always releases the
 * exact granted lease in `finally` (owner-safe — a stale/foreign lease can
 * never release another holder because release is lease-ID checked).
 */
export async function withMaintenanceLease<T>(
  coordinator: MaintenanceCoordinator,
  kind: MaintenanceOperationKind,
  ownerId: string,
  fn: () => Promise<T>
): Promise<T> {
  const lease = acquireMaintenanceLeaseOrThrow(coordinator, kind, ownerId)
  try {
    return await fn()
  } finally {
    coordinator.release(lease)
  }
}

// ---------------------------------------------------------------------------
// Promotion lease seam (Phase 4.4.1, LOCK-4416 — no promotion-only mutex)
// ---------------------------------------------------------------------------

/**
 * Bounded handle over a granted promotion lease. Later promotion
 * orchestration acquires this seam instead of introducing its own mutex.
 * `release()` is idempotent and owner-safe: it releases only the exact
 * granted lease, exactly once, and can never disturb a newer holder.
 */
export interface PromotionLeaseHandle {
  /** Bounded owner label the lease was granted to. */
  readonly ownerId: string
  /** True once this handle released (or failed to release) its lease. */
  isReleased(): boolean
  /**
   * Release the promotion lease. Returns true on the first successful
   * release; false on duplicate calls or if the slot moved on.
   */
  release(): boolean
}

/**
 * Acquire the exclusive promotion lease on the shared coordinator.
 * Throws `MaintenanceBusyError` while backup, restore, live init/close,
 * or another promotion holds the slot. The live DB stays open and
 * authoritative during preparation (LOCK-4411) — holding this lease closes
 * nothing.
 */
export function acquirePromotionLease(
  ownerId: string,
  coordinator: MaintenanceCoordinator = getSharedMaintenanceCoordinator()
): PromotionLeaseHandle {
  const lease = acquireMaintenanceLeaseOrThrow(coordinator, 'promotion', ownerId)
  let released = false

  return {
    ownerId,
    isReleased(): boolean {
      return released
    },
    release(): boolean {
      if (released) {
        return false
      }
      released = true
      return coordinator.release(lease)
    }
  }
}
