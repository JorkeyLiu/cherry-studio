/**
 * Renderer boot readiness primitives + boot wiring tests (LOCK-001,
 * LOCK-003, LOCK-PROJECTION, LOCK-009).
 *
 * The ordinary chat tree must not mount until the one-shot L2 navigation
 * projection has safely settled (applied or verified no-pending) without an
 * API failure. The ReduxStoreReady notification (LOCK-003) is NOT coupled to
 * the projection: it fires immediately at rehydration via
 * `runReduxStoreBoot`, independently of projection outcome.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getImportProjectionReadinessState,
  isImportProjectionReady,
  resetImportProjectionReadiness,
  retryImportProjectionReadiness,
  runImportProjectionBoot,
  runReduxStoreBoot,
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

  it('settles ready when the apply reports applied=true', async () => {
    const result = await runImportProjectionBoot({ apply: async () => true })
    expect(result).toBe('ready')
    expect(isImportProjectionReady()).toBe(true)
  })

  it('settles ready when the apply verifies no-pending=false', async () => {
    const result = await runImportProjectionBoot({ apply: async () => false })
    expect(result).toBe('ready')
    expect(isImportProjectionReady()).toBe(true)
  })

  it('stays pending while the apply is deferred — the tree stays gated (LOCK-009)', async () => {
    let resolveApply!: (value: boolean) => void
    const applyPromise = new Promise<boolean>((resolve) => {
      resolveApply = resolve
    })
    const boot = runImportProjectionBoot({ apply: () => applyPromise })

    // Give the pending apply every chance to (incorrectly) settle — it must not.
    await Promise.resolve()
    await Promise.resolve()
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('pending')

    // Complete the flow so the boot promise settles cleanly.
    resolveApply(false)
    await boot
    expect(isImportProjectionReady()).toBe(true)
  })

  it('settles failed and keeps the tree gated on apply failure', async () => {
    const result = await runImportProjectionBoot({
      apply: async () => {
        throw new Error('Navigation projection read failed')
      }
    })
    expect(result).toBe('failed')
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('failed')
  })
})

describe('runReduxStoreBoot (LOCK-003 store boot seam)', () => {
  beforeEach(() => {
    resetImportProjectionReadiness()
  })

  it('notifies Main immediately — before and independently of the projection apply', async () => {
    const notifyMain = vi.fn()
    let resolveApply!: (value: boolean) => void
    const boot = runReduxStoreBoot({
      notifyMain,
      apply: () =>
        new Promise<boolean>((resolve) => {
          resolveApply = resolve
        })
    })

    // The notification fires synchronously at boot — before the apply settles.
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('pending')

    // A slow projection must not delay the notification (already sent) — and
    // the gate stays pending until the apply settles (LOCK-PROJECTION).
    await Promise.resolve()
    await Promise.resolve()
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(getImportProjectionReadinessState()).toBe('pending')

    resolveApply(false)
    await boot
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(true)
  })

  it('settles ready when the projection applies (true) — notification independent', async () => {
    const notifyMain = vi.fn()
    const result = await runReduxStoreBoot({ notifyMain, apply: async () => true })
    expect(result).toBe('ready')
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(true)
  })

  it('still notifies Main and settles failed on apply failure — the tree stays gated', async () => {
    const notifyMain = vi.fn()
    const result = await runReduxStoreBoot({
      notifyMain,
      apply: async () => {
        throw new Error('Navigation projection read failed')
      }
    })
    expect(result).toBe('failed')
    // LOCK-003: the notification is NOT gated on the projection outcome.
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('failed')
  })

  it('still runs the projection boot when the notification itself fails (side-channel)', async () => {
    const notifyMain = vi.fn(() => {
      throw new Error('ipc down')
    })
    const result = await runReduxStoreBoot({ notifyMain, apply: async () => true })
    // The projection settled — readiness stays ready; the notify failure is a
    // logged side-channel, never a re-gate.
    expect(result).toBe('ready')
    expect(isImportProjectionReady()).toBe(true)
    expect(getImportProjectionReadinessState()).toBe('ready')
  })
})

describe('retryImportProjectionReadiness (S7.2 renderer-local recovery)', () => {
  beforeEach(() => {
    resetImportProjectionReadiness()
  })

  it('is noop when state is pending or ready', async () => {
    expect(await retryImportProjectionReadiness()).toBe('noop')
    expect(getImportProjectionReadinessState()).toBe('pending')
    await runImportProjectionBoot({ apply: async () => true })
    expect(getImportProjectionReadinessState()).toBe('ready')
    expect(await retryImportProjectionReadiness()).toBe('noop')
    expect(getImportProjectionReadinessState()).toBe('ready')
  })

  it('transitions failed -> pending then ready on successful retry and notifies', async () => {
    let shouldFail = true
    const flakyApply = async () => {
      if (shouldFail) throw new Error('fail once')
      return true
    }
    await runImportProjectionBoot({ apply: flakyApply })
    expect(getImportProjectionReadinessState()).toBe('failed')
    const listener = vi.fn()
    const unsubscribe = subscribeImportProjectionReadiness(listener)
    try {
      shouldFail = false
      const result = await retryImportProjectionReadiness()
      expect(result).toBe('ready')
      expect(isImportProjectionReady()).toBe(true)
      // failed -> pending (1) then pending -> ready (1) = 2 notifications
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })

  it('failed -> pending -> failed on retry failure remains gated', async () => {
    await runImportProjectionBoot({
      apply: async () => {
        throw new Error('first fail')
      }
    })
    expect(getImportProjectionReadinessState()).toBe('failed')
    const result = await retryImportProjectionReadiness()
    expect(result).toBe('failed')
    expect(getImportProjectionReadinessState()).toBe('failed')
    expect(isImportProjectionReady()).toBe(false)
  })

  it('retry notifies pending before success so gate can show loading', async () => {
    const states: string[] = []
    const unsubscribe = subscribeImportProjectionReadiness(() => states.push(getImportProjectionReadinessState()))
    let resolveDeferred!: (v: boolean) => void
    const deferredApply = () =>
      new Promise<boolean>((resolve) => {
        resolveDeferred = resolve
      })
    // First boot fails with deferred apply captured as storedApply (rejected)
    // Use a flaky that fails once to capture deferred? Simpler: use deferred that rejects first then resolves
    let deferredShouldFail = true
    const flakyDeferred = async () => {
      if (deferredShouldFail) throw new Error('fail once')
      return deferredApply()
    }
    await runImportProjectionBoot({ apply: flakyDeferred })
    expect(getImportProjectionReadinessState()).toBe('failed')
    states.length = 0
    deferredShouldFail = false
    const retryPromise = retryImportProjectionReadiness()
    // Immediately after retry call, state should be pending (loading)
    expect(getImportProjectionReadinessState()).toBe('pending')
    expect(states).toContain('pending')
    resolveDeferred(true)
    await retryPromise
    expect(getImportProjectionReadinessState()).toBe('ready')
    unsubscribe()
  })
})
