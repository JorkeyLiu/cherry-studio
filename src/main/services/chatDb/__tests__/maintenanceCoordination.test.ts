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

import { describe, expect, it } from 'vitest'

import {
  createMaintenanceCoordinator,
  MAINTENANCE_OPERATIONS,
  type MaintenanceOperationKind,
  maintenanceOperationsConflict
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
