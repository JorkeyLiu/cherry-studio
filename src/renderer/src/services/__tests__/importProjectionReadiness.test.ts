/**
 * Renderer boot readiness primitive + boot wiring tests (LOCK-001,
 * LOCK-PROJECTION, LOCK-009).
 *
 * The ordinary chat tree must not mount, and Main must not be notified via
 * ReduxStoreReady, until the one-shot L2 navigation projection has safely
 * settled (applied or verified no-pending) without an API failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getImportProjectionReadinessState,
  isImportProjectionReady,
  resetImportProjectionReadiness,
  runImportProjectionBoot,
  settleImportProjectionReadiness,
  subscribeImportProjectionReadiness
} from '../importProjectionReadiness'

describe('importProjectionReadiness primitive', () => {
  beforeEach(() => {
    resetImportProjectionReadiness()
  })

  it('starts pending — the ordinary tree is gated (not ready)', () => {
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('pending')
  })

  it('settles to ready and notifies subscribers exactly once per transition', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeImportProjectionReadiness(listener)

    settleImportProjectionReadiness('ready')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(true)
    expect(getImportProjectionReadinessState()).toBe('ready')

    // Idempotent: a second settle is a no-op.
    settleImportProjectionReadiness('ready')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('settles to failed — the tree stays gated and a late ready is rejected (LOCK-PROJECTION)', () => {
    settleImportProjectionReadiness('failed')
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('failed')
    // A late "ready" must never open a tree that was already failed.
    settleImportProjectionReadiness('ready')
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('failed')
  })

  it('unsubscribe stops future notifications', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeImportProjectionReadiness(listener)
    unsubscribe()
    settleImportProjectionReadiness('ready')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('runImportProjectionBoot (LOCK-PROJECTION wiring)', () => {
  beforeEach(() => {
    resetImportProjectionReadiness()
  })

  it('settles ready and notifies Main when the apply reports applied=true', async () => {
    const notifyMain = vi.fn()
    const result = await runImportProjectionBoot({ apply: async () => true, notifyMain })
    expect(result).toBe('ready')
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(true)
  })

  it('settles ready and notifies Main when the apply verifies no-pending=false', async () => {
    const notifyMain = vi.fn()
    const result = await runImportProjectionBoot({ apply: async () => false, notifyMain })
    expect(result).toBe('ready')
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(true)
  })

  it('does NOT notify Main before readiness settles (deferred apply — LOCK-009)', async () => {
    const notifyMain = vi.fn()
    let resolveApply!: (value: boolean) => void
    const applyPromise = new Promise<boolean>((resolve) => {
      resolveApply = resolve
    })
    const boot = runImportProjectionBoot({ apply: () => applyPromise, notifyMain })

    // Give the pending apply every chance to (incorrectly) settle — it must not.
    await Promise.resolve()
    await Promise.resolve()
    expect(notifyMain).not.toHaveBeenCalled()
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('pending')

    // Complete the flow so the boot promise settles cleanly.
    resolveApply(false)
    await boot
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(true)
  })

  it('settles failed, keeps the tree gated, and does NOT notify Main on apply failure', async () => {
    const notifyMain = vi.fn()
    const result = await runImportProjectionBoot({
      apply: async () => {
        throw new Error('Navigation projection read failed')
      },
      notifyMain
    })
    expect(result).toBe('failed')
    expect(notifyMain).not.toHaveBeenCalled()
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('failed')
  })

  it('still opens the tree when the Main notification itself fails (projection already settled)', async () => {
    const notifyMain = vi.fn(() => {
      throw new Error('ipc down')
    })
    const result = await runImportProjectionBoot({ apply: async () => true, notifyMain })
    // The projection settled — readiness stays ready; the notify failure is a
    // logged side-channel, never a re-gate.
    expect(result).toBe('ready')
    expect(isImportProjectionReady()).toBe(true)
    expect(getImportProjectionReadinessState()).toBe('ready')
  })
})
