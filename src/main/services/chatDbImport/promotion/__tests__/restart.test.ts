/**
 * Post-promotion restart strategy tests (LOCK-PROD-7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInProcessReloadGuard,
  getMainRendererWebContents,
  registerMainRendererWebContents,
  reloadMainRenderer,
  resetInProcessReloadGuardForTests,
  resetMainRendererWebContentsForTests,
  resolveRestartMode
} from '../restart'

describe('resolveRestartMode (LOCK-PROD-7)', () => {
  it('packaged app → relaunch (existing exact-once behavior preserved)', () => {
    expect(resolveRestartMode({ isPackaged: true })).toBe('relaunch')
  })

  it('non-packaged app (dev/E2E) → in-process renderer reload', () => {
    expect(resolveRestartMode({ isPackaged: false })).toBe('in-process-reload')
  })
})

describe('reloadMainRenderer (LOCK-PROD-7)', () => {
  beforeEach(() => {
    resetInProcessReloadGuardForTests()
    resetMainRendererWebContentsForTests()
  })

  it('reloads the main renderer exactly once', () => {
    const reload = vi.fn()
    const wc = { isDestroyed: () => false, reload }
    expect(reloadMainRenderer(wc, 'test-owner')).toEqual({ ok: true, reloaded: true })
    expect(reload).toHaveBeenCalledTimes(1)
    // Exact-once: a second call no-ops.
    expect(reloadMainRenderer(wc, 'test-owner')).toEqual({ ok: true, reloaded: false })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('missing/destroyed webContents is a bounded recoverable no-op', () => {
    expect(reloadMainRenderer(null, 'test-owner')).toEqual({ ok: true, reloaded: false })
    const destroyed = { isDestroyed: () => true, reload: vi.fn() }
    expect(reloadMainRenderer(destroyed, 'test-owner')).toEqual({ ok: true, reloaded: false })
    expect(destroyed.reload).not.toHaveBeenCalled()
  })

  it('module-registered webContents is used by the default flow', () => {
    const reload = vi.fn()
    registerMainRendererWebContents({ isDestroyed: () => false, reload })
    expect(getMainRendererWebContents()).not.toBeNull()
    expect(reloadMainRenderer(getMainRendererWebContents(), 'test-owner')).toEqual({ ok: true, reloaded: true })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('destroyed registered webContents is a bounded recoverable no-op', () => {
    const reload = vi.fn()
    registerMainRendererWebContents({ isDestroyed: () => true, reload })
    expect(reloadMainRenderer(getMainRendererWebContents(), 'test-owner')).toEqual({ ok: true, reloaded: false })
    expect(reload).not.toHaveBeenCalled()
  })

  it('a throwing reload() is a bounded recoverable no-op (never rejects)', () => {
    const reload = vi.fn(() => {
      throw new Error('reload exploded')
    })
    const wc = { isDestroyed: () => false, reload }
    expect(() => reloadMainRenderer(wc, 'test-owner')).not.toThrow()
    expect(reloadMainRenderer(wc, 'test-owner')).toEqual({ ok: true, reloaded: false })
    expect(reload).toHaveBeenCalledTimes(1)
    // The exact-once guard stays consumed even after a failed reload attempt.
    expect(reloadMainRenderer(wc, 'test-owner')).toEqual({ ok: true, reloaded: false })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('registering null clears the registered webContents (disposal lifecycle)', () => {
    registerMainRendererWebContents({ isDestroyed: () => false, reload: vi.fn() })
    expect(getMainRendererWebContents()).not.toBeNull()
    registerMainRendererWebContents(null)
    expect(getMainRendererWebContents()).toBeNull()
  })

  it('re-registration replaces the target (idempotent update)', () => {
    const firstReload = vi.fn()
    const secondReload = vi.fn()
    registerMainRendererWebContents({ isDestroyed: () => false, reload: firstReload })
    registerMainRendererWebContents({ isDestroyed: () => false, reload: secondReload })
    expect(reloadMainRenderer(getMainRendererWebContents(), 'test-owner')).toEqual({ ok: true, reloaded: true })
    expect(firstReload).not.toHaveBeenCalled()
    expect(secondReload).toHaveBeenCalledTimes(1)
  })
})

describe('per-recovery reload guards (LOCK-FR3)', () => {
  beforeEach(() => {
    resetInProcessReloadGuardForTests()
    resetMainRendererWebContentsForTests()
  })

  it('two independent guards each allow exactly one reload in the same process', () => {
    const reloadA = vi.fn()
    const reloadB = vi.fn()
    const wcA = { isDestroyed: () => false, reload: reloadA }
    const wcB = { isDestroyed: () => false, reload: reloadB }
    const guardA = createInProcessReloadGuard()
    const guardB = createInProcessReloadGuard()

    // First recovery: reload requested exactly once.
    expect(reloadMainRenderer(wcA, 'recovery-a', guardA)).toEqual({ ok: true, reloaded: true })
    expect(reloadA).toHaveBeenCalledTimes(1)
    // Duplicate/stale settlement from the SAME recovery cannot reload twice.
    expect(reloadMainRenderer(wcA, 'recovery-a', guardA)).toEqual({ ok: true, reloaded: false })
    expect(reloadA).toHaveBeenCalledTimes(1)

    // A later independent recovery in the same process gets its own guard
    // and may request its own reload.
    expect(reloadMainRenderer(wcB, 'recovery-b', guardB)).toEqual({ ok: true, reloaded: true })
    expect(reloadB).toHaveBeenCalledTimes(1)
    expect(reloadMainRenderer(wcB, 'recovery-b', guardB)).toEqual({ ok: true, reloaded: false })
    expect(reloadB).toHaveBeenCalledTimes(1)
  })

  it('a per-recovery guard is consumed even when the reload is a bounded no-op', () => {
    const guard = createInProcessReloadGuard()
    expect(reloadMainRenderer(null, 'recovery', guard)).toEqual({ ok: true, reloaded: false })
    // The no-op consumed the guard — a second settlement cannot retry.
    expect(reloadMainRenderer(null, 'recovery', guard)).toEqual({ ok: true, reloaded: false })
  })

  it('an explicit guard is independent of the module-level fallback guard', () => {
    const reload = vi.fn()
    const wc = { isDestroyed: () => false, reload }
    const guard = createInProcessReloadGuard()

    expect(reloadMainRenderer(wc, 'recovery', guard)).toEqual({ ok: true, reloaded: true })
    // Module-level fallback was not consumed by the per-recovery call.
    expect(reloadMainRenderer(wc, 'direct-caller')).toEqual({ ok: true, reloaded: true })
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
