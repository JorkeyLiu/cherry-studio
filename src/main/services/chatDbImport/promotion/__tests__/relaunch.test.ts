/**
 * Promotion relaunch tests (Phase 4.4.3, LOCK-4438).
 *
 * Verifies the exact-once relaunch guard:
 * - Branded receipt is non-forgeable.
 * - app.relaunch() + app.exit(0) called exactly once.
 * - Second call with same receipt is a no-op (process-level guard).
 * - Unrecognized receipt is refused.
 * - Receipt is consumed after successful relaunch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isRelaunchReceipt, mintRelaunchReceipt, relaunchApp, resetRelaunchGuardForTests } from '../relaunch'

describe('promotion relaunch (LOCK-4438)', () => {
  let mockRelaunch: ReturnType<typeof vi.fn>
  let mockExit: ReturnType<typeof vi.fn>
  let mockApp: { relaunch: () => void; exit: (code?: number) => void }

  beforeEach(() => {
    vi.clearAllMocks()
    resetRelaunchGuardForTests()
    mockRelaunch = vi.fn()
    mockExit = vi.fn()
    mockApp = { relaunch: mockRelaunch, exit: mockExit }
  })

  describe('isRelaunchReceipt', () => {
    it('returns true for a receipt minted by mintRelaunchReceipt', () => {
      const receipt = mintRelaunchReceipt('test-owner')
      expect(isRelaunchReceipt(receipt)).toBe(true)
    })

    it('returns false for a forged object', () => {
      const forged = Object.freeze({ ownerId: 'test', mintedAtMs: Date.now() })
      expect(isRelaunchReceipt(forged)).toBe(false)
    })

    it('returns false for null/undefined/primitives', () => {
      expect(isRelaunchReceipt(null)).toBe(false)
      expect(isRelaunchReceipt(undefined)).toBe(false)
      expect(isRelaunchReceipt('string')).toBe(false)
      expect(isRelaunchReceipt(42)).toBe(false)
    })
  })

  describe('relaunchApp', () => {
    it('calls app.relaunch() and app.exit(0) on first call with valid receipt', () => {
      const receipt = mintRelaunchReceipt('recovery-executor')
      const result = relaunchApp(receipt, mockApp)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.relaunched).toBe(true)
      }
      expect(mockRelaunch).toHaveBeenCalledTimes(1)
      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('returns already-relaunched on second call with same receipt', () => {
      const receipt = mintRelaunchReceipt('recovery-executor')

      const first = relaunchApp(receipt, mockApp)
      expect(first.ok).toBe(true)
      if (first.ok) {
        expect(first.relaunched).toBe(true)
      }

      const second = relaunchApp(receipt, mockApp)
      expect(second.ok).toBe(true)
      if (second.ok && !second.relaunched) {
        expect(second.reason).toBe('already-relaunched')
      }

      // app.relaunch() and app.exit() called only once total
      expect(mockRelaunch).toHaveBeenCalledTimes(1)
      expect(mockExit).toHaveBeenCalledTimes(1)
    })

    it('returns already-relaunched on second call with different receipt (process-level guard)', () => {
      const receipt1 = mintRelaunchReceipt('owner-1')
      const receipt2 = mintRelaunchReceipt('owner-2')

      const first = relaunchApp(receipt1, mockApp)
      expect(first.ok).toBe(true)
      if (first.ok) {
        expect(first.relaunched).toBe(true)
      }

      // receipt2 is a different object but the process-level guard prevents relaunch
      const second = relaunchApp(receipt2, mockApp)
      expect(second.ok).toBe(true)
      if (second.ok && !second.relaunched) {
        expect(second.reason).toBe('already-relaunched')
      }

      expect(mockRelaunch).toHaveBeenCalledTimes(1)
      expect(mockExit).toHaveBeenCalledTimes(1)
    })

    it('refuses unrecognized (forged) receipt', () => {
      const forged = Object.freeze({ ownerId: 'test', mintedAtMs: Date.now() })
      const result = relaunchApp(forged as any, mockApp)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('receipt-invalid')
      }
      expect(mockRelaunch).not.toHaveBeenCalled()
      expect(mockExit).not.toHaveBeenCalled()
    })

    it('refuses null receipt', () => {
      const result = relaunchApp(null as any, mockApp)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('receipt-invalid')
      }
    })

    it('receipt is frozen after minting', () => {
      const receipt = mintRelaunchReceipt('test')
      expect(() => {
        ;(receipt as any).ownerId = 'tampered'
      }).toThrow()
    })

    it('resetRelaunchGuardForTests resets the exact-once guard', () => {
      const receipt = mintRelaunchReceipt('test')

      relaunchApp(receipt, mockApp)
      expect(mockRelaunch).toHaveBeenCalledTimes(1)

      resetRelaunchGuardForTests()

      // After reset, the same receipt object can trigger relaunch again
      // (the WeakSet brand check still passes because the receipt was minted by this module)
      relaunchApp(receipt, mockApp)
      expect(mockRelaunch).toHaveBeenCalledTimes(2)
    })

    it('forged receipt is refused even after guard reset', () => {
      resetRelaunchGuardForTests()

      const forged = Object.freeze({ ownerId: 'test', mintedAtMs: Date.now() })
      const result = relaunchApp(forged as any, mockApp)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('receipt-invalid')
      }
      expect(mockRelaunch).not.toHaveBeenCalled()
    })
  })
})
