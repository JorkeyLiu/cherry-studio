/**
 * Chat DB maintenance coordination contract (Phase 4.4.0, LOCK-4402).
 *
 * Defines ONE shared coordination contract covering the five maintenance
 * operations that may not overlap on the live chat database:
 *
 *   backup | restore | promotion | init | close
 *
 * Today, `BackupManager` and `ChatDbBackup` each hold an independent async
 * mutex and `ChatDbService.init()/close()` rely on a generation counter.
 * LOCK-4402 forbids adding a third independent runtime mutex; instead this
 * module is the single contract those callers will adopt in a later
 * execution unit. Phase 4.4.0 does NOT wire any existing operation to it —
 * no runtime behavior changes here (LOCK-4405). Promotion exact-once is
 * additionally enforced by the promotion protocol itself; this contract
 * only serializes maintenance operations.
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
 * Single-holder maintenance coordinator (contract reference
 * implementation). Pure in-memory state; the later execution unit adopts
 * this in place of the independent mutexes — Phase 4.4.0 wires nothing.
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
