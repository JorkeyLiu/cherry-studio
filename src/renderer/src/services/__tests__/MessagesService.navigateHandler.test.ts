/**
 * Tests for the NAVIGATE_TO_MESSAGE handler coordination logic.
 *
 * These tests call the production `handlePendingNavigateEvent` helper directly
 * (from messageNavigation.ts) with real getPendingNavigate / clearPendingNavigate
 * from MessagesService. There is NO duplicated decision logic — if production
 * matching degrades to topicId-only, the "same topic, different messageId" tests
 * will immediately fail.
 */
import type { MessageNavigationResult, PendingEventDeps } from '@renderer/pages/home/Messages/messageNavigation'
import {
  handlePendingNavigateEvent,
  isSamePendingNavigateTarget
} from '@renderer/pages/home/Messages/messageNavigation'
import { describe, expect, it, vi } from 'vitest'

import { __testSetPendingNavigate, clearPendingNavigate, getPendingNavigate } from '../MessagesService'

const resetPending = () => __testSetPendingNavigate(null)

/**
 * Creates dependency bag for handlePendingNavigateEvent using real pending
 * get/clear and a mock navigate that returns the given result.
 */
const createDeps = (navResult: MessageNavigationResult = 'success'): PendingEventDeps => ({
  getPending: getPendingNavigate,
  clearPending: vi.fn(clearPendingNavigate),
  navigate: vi.fn(async () => navResult),
  onDone: vi.fn()
})

describe('handlePendingNavigateEvent — production coordinator', () => {
  it('matching pending (same topicId AND messageId) → source pending, clears on success, calls onDone', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-42' })
    const deps = createDeps()

    const { result, source } = await handlePendingNavigateEvent('topic-A', 'msg-42', deps)

    expect(source).toBe('pending')
    expect(result).toBe('success')
    expect(deps.navigate).toHaveBeenCalledWith({
      kind: 'message',
      targetId: 'msg-42',
      source: 'pending'
    })
    expect(deps.onDone).toHaveBeenCalledOnce()
    expect(getPendingNavigate()).toBeNull()
  })

  it('same topic, different messageId → source event, pending preserved, onDone NOT called', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-42' })
    const deps = createDeps()

    const { source } = await handlePendingNavigateEvent('topic-A', 'msg-drawer-99', deps)

    expect(source).toBe('event')
    expect(deps.navigate).toHaveBeenCalledWith({
      kind: 'message',
      targetId: 'msg-drawer-99',
      source: 'event'
    })
    expect(deps.onDone).not.toHaveBeenCalled()
    expect(getPendingNavigate()).toEqual({ topicId: 'topic-A', messageId: 'msg-42' })
  })

  it('different topic, same messageId → source event, pending preserved', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-42' })
    const deps = createDeps()

    const { source } = await handlePendingNavigateEvent('topic-B', 'msg-42', deps)

    expect(source).toBe('event')
    expect(getPendingNavigate()).toEqual({ topicId: 'topic-A', messageId: 'msg-42' })
  })

  it('no pending → source event, no side effects', async () => {
    resetPending()
    const deps = createDeps()

    const { result, source } = await handlePendingNavigateEvent('topic-A', 'msg-42', deps)

    expect(source).toBe('event')
    expect(result).toBe('success')
    expect(deps.onDone).not.toHaveBeenCalled()
    expect(getPendingNavigate()).toBeNull()
  })

  it('cancelled navigation preserves pending and does NOT call onDone', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-42' })
    const deps = createDeps('cancelled')

    const { result, source } = await handlePendingNavigateEvent('topic-A', 'msg-42', deps)

    expect(source).toBe('pending')
    expect(result).toBe('cancelled')
    expect(deps.onDone).not.toHaveBeenCalled()
    // Pending is preserved after cancelled navigation
    expect(getPendingNavigate()).toEqual({ topicId: 'topic-A', messageId: 'msg-42' })
  })

  it('not-found result still clears pending and calls onDone (handler owns the identity)', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-42' })
    const deps = createDeps('not-found')

    const { result, source } = await handlePendingNavigateEvent('topic-A', 'msg-42', deps)

    expect(source).toBe('pending')
    expect(result).toBe('not-found')
    expect(deps.onDone).toHaveBeenCalledOnce()
    expect(getPendingNavigate()).toBeNull()
  })

  it('multiple same-topic events with different messageIds do not consume pending', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-target' })
    const deps = createDeps()

    // Simulate multiple drawer/anchor events on the same topic
    await handlePendingNavigateEvent('topic-A', 'msg-drawer-1', deps)
    await handlePendingNavigateEvent('topic-A', 'msg-anchor-2', deps)
    await handlePendingNavigateEvent('topic-A', 'msg-tokens-3', deps)

    // Pending is still preserved — none of these consumed it
    expect(getPendingNavigate()).toEqual({ topicId: 'topic-A', messageId: 'msg-target' })
    expect(deps.onDone).not.toHaveBeenCalled()

    // The correct matching event finally arrives
    const { source } = await handlePendingNavigateEvent('topic-A', 'msg-target', deps)
    expect(source).toBe('pending')
    expect(deps.onDone).toHaveBeenCalledOnce()
    expect(getPendingNavigate()).toBeNull()
  })

  it('new pending identity gets fresh ownership after old one was consumed', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-1' })
    const deps = createDeps()

    const first = await handlePendingNavigateEvent('topic-A', 'msg-1', deps)
    expect(first.source).toBe('pending')
    expect(getPendingNavigate()).toBeNull()

    // New pending arrives (e.g., user calls locateToMessage again)
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-2' })
    const second = await handlePendingNavigateEvent('topic-A', 'msg-2', deps)
    expect(second.source).toBe('pending')
    expect(getPendingNavigate()).toBeNull()
  })

  it('error topic isolation: pending for topic-A is invisible to topic-B handler', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-42' })
    const deps = createDeps()

    // topic-B handler receives same messageId — must not see topic-A's pending
    const resultB = await handlePendingNavigateEvent('topic-B', 'msg-42', deps)
    expect(resultB.source).toBe('event')
    expect(getPendingNavigate()).toEqual({ topicId: 'topic-A', messageId: 'msg-42' })

    // topic-A handler receives same messageId — this one matches
    const resultA = await handlePendingNavigateEvent('topic-A', 'msg-42', deps)
    expect(resultA.source).toBe('pending')
    expect(getPendingNavigate()).toBeNull()
  })

  it('navigate is called exactly once per event with the correct intent shape', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-42' })
    const deps = createDeps()

    await handlePendingNavigateEvent('topic-A', 'msg-42', deps)

    expect(deps.navigate).toHaveBeenCalledOnce()
    expect(deps.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message',
        targetId: 'msg-42'
      })
    )
  })

  it.each<[MessageNavigationResult, string]>([
    ['success', 'success'],
    ['not-found', 'not-found']
  ])(
    'pending replaced during navigate (%s) → clear returns false, no onDone, new pending preserved',
    async (navResult) => {
      resetPending()
      const oldPending = { topicId: 'topic-A', messageId: 'msg-old' }
      const newPending = { topicId: 'topic-A', messageId: 'msg-new' }
      __testSetPendingNavigate(oldPending)

      // navigate callback replaces the pending with a new identity mid-flight
      const deps: PendingEventDeps = {
        getPending: getPendingNavigate,
        clearPending: clearPendingNavigate,
        navigate: vi.fn(async (): Promise<MessageNavigationResult> => {
          // Simulate: while we awaited navigate, a new pending was set
          __testSetPendingNavigate(newPending)
          return navResult
        }),
        onDone: vi.fn()
      }

      const { result, source } = await handlePendingNavigateEvent('topic-A', 'msg-old', deps)

      expect(source).toBe('pending')
      expect(result).toBe(navResult)
      // clearPending tried to clear old identity but found new one → returned false
      expect(deps.onDone).not.toHaveBeenCalled()
      // New pending must remain intact for future handling
      expect(getPendingNavigate()).toEqual(newPending)
    }
  )

  it('pending cleared to null during navigate (success) → clear returns false, no onDone', async () => {
    resetPending()
    __testSetPendingNavigate({ topicId: 'topic-A', messageId: 'msg-42' })

    const deps: PendingEventDeps = {
      getPending: getPendingNavigate,
      clearPending: clearPendingNavigate,
      navigate: vi.fn(async (): Promise<MessageNavigationResult> => {
        // Pending was cleared externally (e.g., by another handler)
        __testSetPendingNavigate(null)
        return 'success'
      }),
      onDone: vi.fn()
    }

    const { result, source } = await handlePendingNavigateEvent('topic-A', 'msg-42', deps)

    expect(source).toBe('pending')
    expect(result).toBe('success')
    expect(deps.onDone).not.toHaveBeenCalled()
    expect(getPendingNavigate()).toBeNull()
  })

  describe('handlePendingNavigateEvent — exact in-flight ownership', () => {
    it('compares topic and message identity, never topic alone', () => {
      expect(
        isSamePendingNavigateTarget({ topicId: 'topic-A', messageId: 'm1' }, { topicId: 'topic-A', messageId: 'm1' })
      ).toBe(true)
      expect(
        isSamePendingNavigateTarget({ topicId: 'topic-A', messageId: 'm1' }, { topicId: 'topic-A', messageId: 'm2' })
      ).toBe(false)
      expect(
        isSamePendingNavigateTarget({ topicId: 'topic-A', messageId: 'm1' }, { topicId: 'topic-B', messageId: 'm1' })
      ).toBe(false)
    })

    it('joins an exact in-flight pending without navigating, clearing, or releasing its owner', async () => {
      resetPending()
      const pending = { topicId: 'topic-A', messageId: 'msg-42' }
      __testSetPendingNavigate(pending)
      const deps: PendingEventDeps = {
        ...createDeps(),
        isPendingInFlight: vi.fn(() => true),
        onStart: vi.fn(),
        onEnd: vi.fn()
      }

      await expect(handlePendingNavigateEvent('topic-A', 'msg-42', deps)).resolves.toEqual({
        result: 'cancelled',
        source: 'pending-in-flight'
      })
      expect(deps.isPendingInFlight).toHaveBeenCalledWith(pending)
      expect(deps.navigate).not.toHaveBeenCalled()
      expect(deps.clearPending).not.toHaveBeenCalled()
      expect(deps.onStart).not.toHaveBeenCalled()
      expect(deps.onDone).not.toHaveBeenCalled()
      expect(deps.onEnd).not.toHaveBeenCalled()
      expect(getPendingNavigate()).toEqual(pending)
    })

    it.each([
      ['same topic, different target', 'topic-A', 'msg-other'],
      ['different topic, same target id', 'topic-B', 'msg-42']
    ])('does not join %s and keeps the mounted event fallback', async (_label, topicId, messageId) => {
      resetPending()
      const pending = { topicId: 'topic-A', messageId: 'msg-42' }
      __testSetPendingNavigate(pending)
      const deps: PendingEventDeps = {
        ...createDeps(),
        isPendingInFlight: vi.fn((candidate) => isSamePendingNavigateTarget(candidate, pending)),
        onStart: vi.fn(),
        onEnd: vi.fn()
      }

      const outcome = await handlePendingNavigateEvent(topicId, messageId, deps)

      expect(outcome).toEqual({ result: 'success', source: 'event' })
      expect(deps.navigate).toHaveBeenCalledOnce()
      expect(deps.onStart).toHaveBeenCalledWith({ topicId, messageId })
      expect(deps.onEnd).toHaveBeenCalledWith(false, 'success')
      expect(getPendingNavigate()).toEqual(pending)
    })

    it('absent pending still uses the event fallback', async () => {
      resetPending()
      const deps: PendingEventDeps = {
        ...createDeps(),
        isPendingInFlight: vi.fn(() => true),
        onStart: vi.fn(),
        onEnd: vi.fn()
      }

      await expect(handlePendingNavigateEvent('topic-A', 'msg-42', deps)).resolves.toEqual({
        result: 'success',
        source: 'event'
      })
      expect(deps.isPendingInFlight).not.toHaveBeenCalled()
      expect(deps.navigate).toHaveBeenCalledOnce()
      expect(deps.onEnd).toHaveBeenCalledWith(false, 'success')
    })

    it.each(['cancelled', 'thrown'] as const)(
      '%s navigation releases its claim and preserves pending',
      async (failure) => {
        resetPending()
        const pending = { topicId: 'topic-A', messageId: 'msg-42' }
        __testSetPendingNavigate(pending)
        let owner: { topicId: string; messageId: string } | null = null
        const deps: PendingEventDeps = {
          getPending: getPendingNavigate,
          clearPending: vi.fn(clearPendingNavigate),
          navigate: vi.fn(async (): Promise<MessageNavigationResult> => {
            if (failure === 'thrown') throw new Error('navigation failed')
            return 'cancelled'
          }),
          onDone: vi.fn(),
          onStart: (target) => {
            owner = { ...target }
          },
          onEnd: vi.fn((_consumed, _result) => {
            owner = null
          })
        }

        if (failure === 'thrown') {
          await expect(handlePendingNavigateEvent('topic-A', 'msg-42', deps)).rejects.toThrow('navigation failed')
        } else {
          await expect(handlePendingNavigateEvent('topic-A', 'msg-42', deps)).resolves.toMatchObject({
            result: 'cancelled'
          })
        }
        expect(owner).toBeNull()
        expect(deps.onEnd).toHaveBeenCalledWith(false, failure === 'thrown' ? null : 'cancelled')
        expect(deps.clearPending).not.toHaveBeenCalled()
        expect(deps.onDone).not.toHaveBeenCalled()
        expect(getPendingNavigate()).toEqual(pending)
      }
    )

    it('a superseded completion cannot clear or release the newer target owner', async () => {
      resetPending()
      const firstTarget = { topicId: 'topic-A', messageId: 'msg-first' }
      const secondTarget = { topicId: 'topic-A', messageId: 'msg-second' }
      __testSetPendingNavigate(firstTarget)
      let resolveFirst: ((result: MessageNavigationResult) => void) | null = null
      let owner: typeof firstTarget | null = null
      let invocation = 0
      const deps: PendingEventDeps = {
        getPending: getPendingNavigate,
        clearPending: clearPendingNavigate,
        navigate: vi.fn(() => {
          invocation += 1
          if (invocation === 1) {
            return new Promise<MessageNavigationResult>((resolve) => {
              resolveFirst = resolve
            })
          }
          return Promise.resolve<MessageNavigationResult>('success')
        }),
        onDone: vi.fn(),
        isPendingInFlight: (candidate) => owner !== null && isSamePendingNavigateTarget(owner, candidate),
        onStart: (target) => {
          owner = { ...target }
        },
        onEnd: (_consumed, _result) => {
          // The controller-local release is identity-guarded: an older request
          // must not erase a newer owner when it settles late.
          if (owner?.messageId === firstTarget.messageId) owner = null
        }
      }

      const first = handlePendingNavigateEvent('topic-A', firstTarget.messageId, deps)
      __testSetPendingNavigate(secondTarget)
      await handlePendingNavigateEvent('topic-A', secondTarget.messageId, deps)
      expect(owner).toEqual(secondTarget)
      expect(getPendingNavigate()).toBeNull()

      await actResolution(resolveFirst)
      await expect(first).resolves.toMatchObject({ result: 'success', source: 'pending' })
      expect(owner).toEqual(secondTarget)
      expect(getPendingNavigate()).toBeNull()
      expect(deps.onDone).toHaveBeenCalledOnce()
    })
  })

  const actResolution = (resolve: ((result: MessageNavigationResult) => void) | null) => {
    resolve?.('success')
  }
})
