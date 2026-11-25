/**
 * Fresh-chat bootstrap marker lifecycle tests.
 *
 * The durable pending marker (outside the Redux persist payload) is what lets
 * a failed fresh boot retry after a renderer restart: the ephemeral
 * persist-key snapshot alone would read "existing profile" on relaunch and
 * never ensure again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  collectFreshTopicTargets,
  configureFreshChatBootstrapFinalizer,
  finalizeFreshChatBootstrap,
  FRESH_CHAT_BOOTSTRAP_PENDING_KEY,
  getFreshChatBootstrapReadinessState,
  isFreshBootstrapPending,
  markFreshBootstrapPendingIfFreshProfile,
  PERSIST_COMPAT_KEY,
  readPersistedProfileExists,
  runFreshChatBootstrap
} from '../freshChatBootstrap'

beforeEach(() => {
  localStorage.removeItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY)
  localStorage.removeItem(PERSIST_COMPAT_KEY)
})

describe('marker set / skip', () => {
  it('fresh profile (persist absent) sets pending', () => {
    expect(readPersistedProfileExists()).toBe(false)
    expect(markFreshBootstrapPendingIfFreshProfile()).toBe(true)
    expect(isFreshBootstrapPending()).toBe(true)
  })

  it('marking is idempotent while pending', () => {
    expect(markFreshBootstrapPendingIfFreshProfile()).toBe(true)
    expect(markFreshBootstrapPendingIfFreshProfile()).toBe(true)
    expect(isFreshBootstrapPending()).toBe(true)
  })

  it('existing persist profile never marks', () => {
    localStorage.setItem(PERSIST_COMPAT_KEY, '{"_persist":{"version":225}}')
    expect(readPersistedProfileExists()).toBe(true)
    expect(markFreshBootstrapPendingIfFreshProfile()).toBe(false)
    expect(isFreshBootstrapPending()).toBe(false)
  })
})

describe('collectFreshTopicTargets', () => {
  it('collects well-formed topics and skips malformed entries', () => {
    const targets = collectFreshTopicTargets([
      { id: 'a-1', topics: [{ id: 't-1', name: 'Named' }, { id: '', name: 'Empty' }, null, { name: 'No id' }] },
      { id: '', topics: [{ id: 't-orphan' }] },
      { id: 'a-2' }
    ])
    expect(targets).toEqual([{ id: 't-1', assistantId: 'a-1', name: 'Named' }])
  })
})

describe('finalizeFreshChatBootstrap', () => {
  it('pending marker ensures every target then clears', async () => {
    markFreshBootstrapPendingIfFreshProfile()
    const ensured: string[] = []
    const result = await finalizeFreshChatBootstrap({
      collectTargets: () => [
        { id: 't-1', assistantId: 'a-1', name: 'T1' },
        { id: 't-2', assistantId: 'a-1', name: 'T2' }
      ],
      ensureTopic: async (target) => {
        ensured.push(target.id)
      }
    })
    expect(result).toBe('ensured')
    expect(ensured).toEqual(['t-1', 't-2'])
    expect(isFreshBootstrapPending()).toBe(false)
  })

  it('existing persist with no marker never ensures', async () => {
    localStorage.setItem(PERSIST_COMPAT_KEY, '{"_persist":{"version":225}}')
    const ensureTopic = vi.fn()
    const result = await finalizeFreshChatBootstrap({
      collectTargets: () => [{ id: 't-1', assistantId: 'a-1', name: 'T' }],
      ensureTopic
    })
    expect(result).toBe('not-pending')
    expect(ensureTopic).not.toHaveBeenCalled()
  })

  it('failed ensure retains the marker and propagates', async () => {
    markFreshBootstrapPendingIfFreshProfile()
    await expect(
      finalizeFreshChatBootstrap({
        collectTargets: () => [{ id: 't-1', assistantId: 'a-1', name: 'T' }],
        ensureTopic: async () => {
          throw new Error('ensureTopic IPC failed')
        }
      })
    ).rejects.toThrow('ensureTopic IPC failed')
    expect(isFreshBootstrapPending()).toBe(true)
  })

  it('partial ensure failure retains the marker (safe idempotent retry)', async () => {
    markFreshBootstrapPendingIfFreshProfile()
    const ensured: string[] = []
    let calls = 0
    const flaky = async (target: { id: string }) => {
      calls++
      ensured.push(target.id)
      if (calls === 1) throw new Error('first target ok, second fails')
    }
    // First attempt: single target fails -> marker retained.
    await expect(
      finalizeFreshChatBootstrap({
        collectTargets: () => [{ id: 't-1', assistantId: 'a-1' }],
        ensureTopic: flaky
      })
    ).rejects.toThrow()
    expect(isFreshBootstrapPending()).toBe(true)
    // Retry: create-only rerun succeeds (partial ensures are safe) -> cleared.
    const result = await finalizeFreshChatBootstrap({
      collectTargets: () => [{ id: 't-1', assistantId: 'a-1' }],
      ensureTopic: async (target) => {
        ensured.push(target.id)
      }
    })
    expect(result).toBe('ensured')
    expect(isFreshBootstrapPending()).toBe(false)
  })

  it('simulated relaunch (persist present + marker pending) retries the ensure', async () => {
    // First boot failed after marking: persist now exists, marker retained.
    localStorage.setItem(PERSIST_COMPAT_KEY, '{"_persist":{"version":225}}')
    localStorage.setItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY, 'pending')
    const ensureTopic = vi.fn()
    const result = await finalizeFreshChatBootstrap({
      collectTargets: () => [{ id: 't-relaunch', assistantId: 'default', name: 'Default Topic' }],
      ensureTopic
    })
    expect(result).toBe('ensured')
    expect(ensureTopic).toHaveBeenCalledExactlyOnceWith({
      id: 't-relaunch',
      assistantId: 'default',
      name: 'Default Topic'
    })
    expect(isFreshBootstrapPending()).toBe(false)
  })

  describe('fresh-chat bootstrap readiness', () => {
    it('existing profile is ready immediately without invoking the finalizer', async () => {
      const finalizer = vi.fn(async () => 'ensured' as const)
      configureFreshChatBootstrapFinalizer(finalizer)

      expect(getFreshChatBootstrapReadinessState()).toBe('ready')
      await expect(runFreshChatBootstrap()).resolves.toBe('not-pending')
      expect(finalizer).not.toHaveBeenCalled()
    })

    it('shares one pending promise and opens only after ensure clears the marker', async () => {
      markFreshBootstrapPendingIfFreshProfile()
      let resolveEnsure!: () => void
      const ensureTopic = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveEnsure = resolve
          })
      )
      configureFreshChatBootstrapFinalizer(() =>
        finalizeFreshChatBootstrap({
          collectTargets: () => [{ id: 't-1', assistantId: 'default', name: 'Topic' }],
          ensureTopic
        })
      )

      const first = runFreshChatBootstrap()
      const second = runFreshChatBootstrap()
      expect(second).toBe(first)
      expect(getFreshChatBootstrapReadinessState()).toBe('pending')

      await vi.waitFor(() => expect(ensureTopic).toHaveBeenCalledTimes(1))
      expect(isFreshBootstrapPending()).toBe(true)
      resolveEnsure()
      await expect(first).resolves.toBe('ensured')
      expect(isFreshBootstrapPending()).toBe(false)
      expect(getFreshChatBootstrapReadinessState()).toBe('ready')
    })

    it('failure retains the marker and retry succeeds without re-ensuring after readiness', async () => {
      markFreshBootstrapPendingIfFreshProfile()
      const ensureTopic = vi
        .fn()
        .mockRejectedValueOnce(new Error('ensureTopic IPC failed'))
        .mockResolvedValue(undefined)
      configureFreshChatBootstrapFinalizer(() =>
        finalizeFreshChatBootstrap({
          collectTargets: () => [{ id: 't-1', assistantId: 'default', name: 'Topic' }],
          ensureTopic
        })
      )

      await expect(runFreshChatBootstrap()).rejects.toThrow('ensureTopic IPC failed')
      expect(getFreshChatBootstrapReadinessState()).toBe('failed')
      expect(isFreshBootstrapPending()).toBe(true)

      await expect(runFreshChatBootstrap()).resolves.toBe('ensured')
      expect(ensureTopic).toHaveBeenCalledTimes(2)
      expect(getFreshChatBootstrapReadinessState()).toBe('ready')
      expect(isFreshBootstrapPending()).toBe(false)

      await expect(runFreshChatBootstrap()).resolves.toBe('not-pending')
      expect(ensureTopic).toHaveBeenCalledTimes(2)
    })
  })
})
