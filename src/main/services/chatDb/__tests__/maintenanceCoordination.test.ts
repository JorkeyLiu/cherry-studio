/**
 * Maintenance coordination contract tests (Phase 4.4.0, LOCK-4402).
 *
 * Proves:
 * - The contract covers exactly the five operations
 *   backup | restore | promotion | init | close.
 * - Every operation pair conflicts (total, symmetric matrix) — promotion is
 *   mutually exclusive with live backup, restore, other promotions, and
 *   ChatDbService init/close.
 * - Single-holder lease: deterministic non-blocking acquire, owner-checked
 *   idempotent release, stale-lease refusal.
 * - Pure in-memory contract: no wiring of existing mutexes in 4.4.0.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireMaintenanceLeaseOrThrow,
  acquirePromotionLease,
  createMaintenanceCoordinator,
  ERR_CHAT_DB_MAINTENANCE_BUSY,
  getSharedMaintenanceCoordinator,
  isMaintenanceBusyError,
  MAINTENANCE_OPERATIONS,
  MaintenanceBusyError,
  type MaintenanceOperationKind,
  maintenanceOperationsConflict,
  type PromotionLeaseHandle,
  resetSharedMaintenanceCoordinatorForTests,
  validatePromotionAuthorization,
  withMaintenanceLease
} from '../maintenanceCoordination'

describe('maintenance coordination contract (LOCK-4402)', () => {
  describe('operation coverage', () => {
    it('covers exactly the five maintenance operations', () => {
      expect(MAINTENANCE_OPERATIONS).toEqual(['backup', 'restore', 'promotion', 'init', 'close'])
    })
  })

  describe('conflict matrix', () => {
    it('every pair of operations conflicts (total and symmetric, including same-kind pairs)', () => {
      for (const a of MAINTENANCE_OPERATIONS) {
        for (const b of MAINTENANCE_OPERATIONS) {
          expect(maintenanceOperationsConflict(a, b)).toBe(true)
          expect(maintenanceOperationsConflict(b, a)).toBe(true)
        }
      }
    })

    it('rejects unknown operation kinds', () => {
      expect(() => maintenanceOperationsConflict('vacuum' as MaintenanceOperationKind, 'backup')).toThrow(
        /Unknown maintenance operation/
      )
    })
  })

  describe('single-holder lease', () => {
    it('grants a lease when free and reports the holder while held', () => {
      const coordinator = createMaintenanceCoordinator()
      expect(coordinator.currentHolder()).toBeNull()

      const result = coordinator.acquire('promotion', 'import-session-1')
      expect(result.granted).toBe(true)
      expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: 'import-session-1' })
    })

    it('refuses every other operation while promotion holds the lease (LOCK-4402)', () => {
      const coordinator = createMaintenanceCoordinator()
      const promotion = coordinator.acquire('promotion', 'import-session-1')
      expect(promotion.granted).toBe(true)

      for (const kind of MAINTENANCE_OPERATIONS) {
        const attempt = coordinator.acquire(kind, 'other-owner')
        expect(attempt.granted).toBe(false)
        if (!attempt.granted) {
          expect(attempt.conflictingKind).toBe('promotion')
          expect(attempt.conflictingOwnerId).toBe('import-session-1')
        }
      }
    })

    it('refuses promotion while any of the other four operations holds the lease', () => {
      for (const holderKind of ['backup', 'restore', 'init', 'close'] as const) {
        const coordinator = createMaintenanceCoordinator()
        const held = coordinator.acquire(holderKind, 'holder')
        expect(held.granted).toBe(true)

        const attempt = coordinator.acquire('promotion', 'import-session-1')
        expect(attempt.granted).toBe(false)
        if (!attempt.granted) {
          expect(attempt.conflictingKind).toBe(holderKind)
        }
      }
    })

    it('a second promotion is refused while one holds the lease (same-kind exclusion)', () => {
      const coordinator = createMaintenanceCoordinator()
      expect(coordinator.acquire('promotion', 'first').granted).toBe(true)
      expect(coordinator.acquire('promotion', 'second').granted).toBe(false)
    })

    it('release frees the slot for the next operation', () => {
      const coordinator = createMaintenanceCoordinator()
      const backup = coordinator.acquire('backup', 'backup-owner')
      expect(backup.granted).toBe(true)
      if (!backup.granted) return

      expect(coordinator.release(backup.lease)).toBe(true)
      expect(coordinator.currentHolder()).toBeNull()
      expect(coordinator.acquire('restore', 'restore-owner').granted).toBe(true)
    })

    it('release is owner-checked and idempotent: stale/duplicate releases are refused', () => {
      const coordinator = createMaintenanceCoordinator()
      const first = coordinator.acquire('init', 'owner-a')
      expect(first.granted).toBe(true)
      if (!first.granted) return

      expect(coordinator.release(first.lease)).toBe(true)
      // Duplicate release refused.
      expect(coordinator.release(first.lease)).toBe(false)

      // A stale lease cannot release a newer holder.
      const second = coordinator.acquire('close', 'owner-b')
      expect(second.granted).toBe(true)
      expect(coordinator.release(first.lease)).toBe(false)
      expect(coordinator.currentHolder()).toEqual({ kind: 'close', ownerId: 'owner-b' })
    })

    it('lease IDs are unique across grants (non-reusable ownership proof)', () => {
      const coordinator = createMaintenanceCoordinator()
      const a = coordinator.acquire('backup', 'o1')
      expect(a.granted).toBe(true)
      if (!a.granted) return
      coordinator.release(a.lease)
      const b = coordinator.acquire('backup', 'o1')
      expect(b.granted).toBe(true)
      if (!b.granted) return
      expect(b.lease.leaseId).not.toBe(a.lease.leaseId)
    })

    it('rejects unknown kinds and unsafe owner labels at acquisition', () => {
      const coordinator = createMaintenanceCoordinator()
      expect(() => coordinator.acquire('vacuum' as MaintenanceOperationKind, 'owner')).toThrow(
        /Unknown maintenance operation/
      )
      expect(() => coordinator.acquire('backup', '../etc')).toThrow(/ownerId/)
      expect(() => coordinator.acquire('backup', '')).toThrow(/ownerId/)
    })

    it('coordinator instances are independent (pure in-memory contract, nothing global)', () => {
      const first = createMaintenanceCoordinator()
      const second = createMaintenanceCoordinator()
      expect(first.acquire('promotion', 'a').granted).toBe(true)
      expect(second.acquire('backup', 'b').granted).toBe(true)
    })
  })
})

describe('maintenance coordination runtime (Phase 4.4.1, LOCK-4416)', () => {
  afterEach(() => {
    resetSharedMaintenanceCoordinatorForTests()
  })

  describe('structured busy error', () => {
    it('acquireMaintenanceLeaseOrThrow throws a classifiable MaintenanceBusyError with full context', () => {
      const coordinator = createMaintenanceCoordinator()
      coordinator.acquire('restore', 'restore-owner')

      let caught: unknown
      try {
        acquireMaintenanceLeaseOrThrow(coordinator, 'backup', 'backup-owner')
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(MaintenanceBusyError)
      expect(isMaintenanceBusyError(caught)).toBe(true)
      const busy = caught as MaintenanceBusyError
      expect(busy.code).toBe(ERR_CHAT_DB_MAINTENANCE_BUSY)
      expect(busy.name).toBe('MaintenanceBusyError')
      expect(busy.requestedKind).toBe('backup')
      expect(busy.requestedOwnerId).toBe('backup-owner')
      expect(busy.conflictingKind).toBe('restore')
      expect(busy.conflictingOwnerId).toBe('restore-owner')
      // Message stays classifiable by the existing IPC busy fallback.
      expect(busy.message.toLowerCase()).toContain('busy')
    })

    it('isMaintenanceBusyError refuses unrelated errors and accepts code-tagged errors', () => {
      expect(isMaintenanceBusyError(new Error('busy'))).toBe(false)
      expect(isMaintenanceBusyError(null)).toBe(false)
      const tagged = Object.assign(new Error('x'), { code: ERR_CHAT_DB_MAINTENANCE_BUSY })
      expect(isMaintenanceBusyError(tagged)).toBe(true)
    })
  })

  describe('shared runtime coordinator', () => {
    it('returns one stable process-wide instance', () => {
      const a = getSharedMaintenanceCoordinator()
      const b = getSharedMaintenanceCoordinator()
      expect(a).toBe(b)

      const grant = a.acquire('backup', 'o1')
      expect(grant.granted).toBe(true)
      expect(b.currentHolder()).toEqual({ kind: 'backup', ownerId: 'o1' })
    })
  })

  describe('withMaintenanceLease', () => {
    it('holds the lease during fn and releases on success', async () => {
      const coordinator = createMaintenanceCoordinator()
      await withMaintenanceLease(coordinator, 'backup', 'owner', async () => {
        expect(coordinator.currentHolder()).toEqual({ kind: 'backup', ownerId: 'owner' })
      })
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('releases the lease when fn throws (try/finally)', async () => {
      const coordinator = createMaintenanceCoordinator()
      await expect(
        withMaintenanceLease(coordinator, 'restore', 'owner', async () => {
          throw new Error('staging failed')
        })
      ).rejects.toThrow('staging failed')
      expect(coordinator.currentHolder()).toBeNull()
      expect(coordinator.acquire('backup', 'next').granted).toBe(true)
    })

    it('propagates MaintenanceBusyError without disturbing the current holder', async () => {
      const coordinator = createMaintenanceCoordinator()
      coordinator.acquire('promotion', 'import-1')
      await expect(withMaintenanceLease(coordinator, 'backup', 'owner', async () => 'never')).rejects.toSatisfy(
        (e: unknown) => isMaintenanceBusyError(e)
      )
      expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: 'import-1' })
    })
  })

  describe('promotion lease seam (no promotion-only mutex)', () => {
    it('grants an exclusive promotion lease on the shared coordinator by default', () => {
      const handle = acquirePromotionLease('import-session-1')
      const shared = getSharedMaintenanceCoordinator()
      expect(shared.currentHolder()).toEqual({ kind: 'promotion', ownerId: 'import-session-1' })

      // Every live category is refused while promotion holds the slot.
      for (const kind of MAINTENANCE_OPERATIONS) {
        expect(() => acquireMaintenanceLeaseOrThrow(shared, kind, 'other')).toThrow(MaintenanceBusyError)
      }

      expect(handle.release()).toBe(true)
      expect(shared.currentHolder()).toBeNull()
    })

    it('is busy-refused while another maintenance operation holds the lease', () => {
      const coordinator = createMaintenanceCoordinator()
      coordinator.acquire('backup', 'backup-owner')
      expect(() => acquirePromotionLease('import-session-1', coordinator)).toThrow(MaintenanceBusyError)
    })

    it('release is bounded: idempotent, and a stale handle cannot release a newer holder', () => {
      const coordinator = createMaintenanceCoordinator()
      const first = acquirePromotionLease('session-a', coordinator)
      expect(first.release()).toBe(true)
      expect(first.isReleased()).toBe(true)
      // Duplicate release refused.
      expect(first.release()).toBe(false)

      // A newer holder takes the slot; the stale handle cannot disturb it.
      const grant = coordinator.acquire('init', 'live')
      expect(grant.granted).toBe(true)
      expect(first.release()).toBe(false)
      expect(coordinator.currentHolder()).toEqual({ kind: 'init', ownerId: 'live' })
    })
  })

  describe('promotion authorization validation seam (Phase 4.4.2, LOCK-4422)', () => {
    it('authorizes the currently held promotion lease handle on its coordinator', () => {
      const coordinator = createMaintenanceCoordinator()
      const handle = acquirePromotionLease('import-session-1', coordinator)

      const verdict = validatePromotionAuthorization(handle, coordinator)
      expect(verdict).toEqual({ authorized: true, ownerId: 'import-session-1' })

      // Validation grants and releases nothing — the holder is undisturbed.
      expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: 'import-session-1' })
      handle.release()
    })

    it('defaults to the shared coordinator', () => {
      const handle = acquirePromotionLease('import-session-1')
      expect(validatePromotionAuthorization(handle).authorized).toBe(true)
      handle.release()
      expect(validatePromotionAuthorization(handle).authorized).toBe(false)
    })

    it('refuses a released (stale) handle with reason released', () => {
      const coordinator = createMaintenanceCoordinator()
      const handle = acquirePromotionLease('import-session-1', coordinator)
      handle.release()

      const verdict = validatePromotionAuthorization(handle, coordinator)
      expect(verdict).toEqual({ authorized: false, reason: 'released' })
    })

    it('refuses a forged structural handle: an ownerId alone is never authorization', () => {
      const coordinator = createMaintenanceCoordinator()
      const genuine = acquirePromotionLease('import-session-1', coordinator)

      // Structurally identical, same ownerId — but never minted by
      // acquirePromotionLease: no generic bypass.
      const forged: PromotionLeaseHandle = {
        ownerId: 'import-session-1',
        isReleased: () => false,
        release: () => true
      }
      const verdict = validatePromotionAuthorization(forged, coordinator)
      expect(verdict).toEqual({ authorized: false, reason: 'unrecognized-handle' })

      // The genuine holder is unaffected.
      expect(validatePromotionAuthorization(genuine, coordinator).authorized).toBe(true)
      genuine.release()
    })

    it('refuses a handle granted on a different coordinator with reason foreign-coordinator', () => {
      const granting = createMaintenanceCoordinator()
      const other = createMaintenanceCoordinator()
      const handle = acquirePromotionLease('import-session-1', granting)

      const verdict = validatePromotionAuthorization(handle, other)
      expect(verdict).toEqual({ authorized: false, reason: 'foreign-coordinator' })

      // Still authorized on its own coordinator.
      expect(validatePromotionAuthorization(handle, granting).authorized).toBe(true)
      handle.release()
    })

    it('a stale shared-coordinator handle cannot authorize against a fresh shared coordinator', () => {
      const handle = acquirePromotionLease('import-session-1')
      expect(validatePromotionAuthorization(handle).authorized).toBe(true)

      // The shared coordinator is replaced (test seam): the old grant is
      // foreign to the new instance and must not authorize anything on it.
      resetSharedMaintenanceCoordinatorForTests()
      const verdict = validatePromotionAuthorization(handle)
      expect(verdict).toEqual({ authorized: false, reason: 'foreign-coordinator' })
      handle.release()
    })
  })
})
