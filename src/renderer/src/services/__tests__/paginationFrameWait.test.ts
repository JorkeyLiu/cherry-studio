import {
  createMessageViewportState,
  messageViewportReducer,
  type MessageViewportState
} from '@renderer/pages/home/Messages/messageViewportReducer'
import {
  claimPaginationFetchLease,
  createPaginationFetchLease,
  isPaginationFetchLeaseFree,
  ownsPaginationFetchLease,
  releasePaginationFetchLease
} from '@renderer/services/paginationFetchLease'
import {
  awaitOrdinaryPageFrame,
  createPaginationFrameWait,
  isFrameOrderedPublicationOrigin
} from '@renderer/services/paginationFrameWait'
import { describe, expect, it, vi } from 'vitest'

/** Deterministic frame source: nothing runs until `flush()` is called. */
function createFrameHarness() {
  let nextHandle = 1
  const queued = new Map<number, () => void>()
  const cancelled: number[] = []
  const requested: number[] = []
  let lastCallback: (() => void) | null = null

  return {
    requestFrame: (callback: () => void): number | null => {
      const handle = nextHandle++
      requested.push(handle)
      lastCallback = callback
      queued.set(handle, callback)
      return handle
    },
    cancelFrame: (handle: number): void => {
      cancelled.push(handle)
      queued.delete(handle)
    },
    requested,
    cancelled,
    pending: (): number => queued.size,
    /** Run every queued frame callback once (like the next painted frame). */
    flush: (): void => {
      const callbacks = Array.from(queued.values())
      queued.clear()
      for (const callback of callbacks) callback()
    },
    /** A frame callback captured earlier, fired even after cancellation. */
    callLate: (): void => {
      lastCallback?.()
    }
  }
}

/** Deterministic document-visibility source with observable subscriptions. */
function createVisibilityHarness() {
  let hidden = false
  let listeners: Array<() => void> = []
  let subscriptions = 0
  let unsubscriptions = 0

  return {
    isHidden: () => hidden,
    subscribeHidden: (listener: () => void): (() => void) => {
      subscriptions += 1
      listeners.push(listener)
      return () => {
        unsubscriptions += 1
        listeners = listeners.filter((entry) => entry !== listener)
      }
    },
    get subscriptions() {
      return subscriptions
    },
    get unsubscriptions() {
      return unsubscriptions
    },
    get activeListeners() {
      return listeners.length
    },
    /** The document becomes hidden and every live subscriber is notified. */
    becomeHidden: (): void => {
      hidden = true
      for (const listener of [...listeners]) listener()
    },
    setHidden: (value: boolean): void => {
      hidden = value
    }
  }
}

interface Settlement<T> {
  settled: boolean
  value: T | null
  count: number
}

function track<T>(promise: Promise<T>): Settlement<T> {
  const settlement: Settlement<T> = { settled: false, value: null, count: 0 }
  void promise.then((value) => {
    settlement.settled = true
    settlement.value = value
    settlement.count += 1
  })
  return settlement
}

/** Let every pending promise callback run (no timer, no frame). */
const settleMicrotasks = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

function createGate() {
  const frames = createFrameHarness()
  const visibility = createVisibilityHarness()
  const gate = createPaginationFrameWait({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    isHidden: visibility.isHidden,
    subscribeHidden: visibility.subscribeHidden
  })
  return { gate, frames, visibility }
}

describe('pagination frame wait (ordinary older page publication)', () => {
  it('does not settle before the frame and settles `frame` once it is painted', async () => {
    const { gate, frames } = createGate()
    const wait = gate.wait()
    const settlement = track(wait)

    await settleMicrotasks()
    expect(settlement.settled).toBe(false)
    expect(frames.pending()).toBe(1)
    expect(gate.pendingCount()).toBe(1)

    frames.flush()
    await expect(wait).resolves.toBe('frame')
    expect(settlement.settled).toBe(true)
    expect(gate.pendingCount()).toBe(0)
  })

  it('cancels the queued frame and settles `cancelled` when cancelled while waiting', async () => {
    const { gate, frames } = createGate()
    const wait = gate.wait()
    await settleMicrotasks()
    expect(frames.pending()).toBe(1)

    gate.cancelAll()
    await expect(wait).resolves.toBe('cancelled')
    expect(frames.cancelled).toEqual(frames.requested)
    expect(frames.pending()).toBe(0)
    expect(gate.pendingCount()).toBe(0)
  })

  it('an already-aborted attempt settles `cancelled` and never requests a frame', async () => {
    const { gate, frames } = createGate()
    const controller = new AbortController()
    controller.abort()

    await expect(gate.wait(controller.signal)).resolves.toBe('cancelled')
    expect(frames.requested).toEqual([])
  })

  it('an abort while waiting cancels the queued frame and settles `cancelled`', async () => {
    const { gate, frames } = createGate()
    const controller = new AbortController()
    const wait = gate.wait(controller.signal)
    await settleMicrotasks()

    controller.abort()
    await expect(wait).resolves.toBe('cancelled')
    expect(frames.cancelled).toHaveLength(1)
    expect(gate.pendingCount()).toBe(0)
  })

  it('a hidden document settles `hidden` with no frame and no visibility listener', async () => {
    const { gate, frames, visibility } = createGate()
    visibility.setHidden(true)

    await expect(gate.wait()).resolves.toBe('hidden')
    expect(frames.requested).toEqual([])
    expect(visibility.subscriptions).toBe(0)
  })

  it('becoming hidden while waiting settles `hidden`, cancels the frame and removes the listener', async () => {
    const { gate, frames, visibility } = createGate()
    const wait = gate.wait()
    await settleMicrotasks()
    expect(visibility.activeListeners).toBe(1)

    visibility.becomeHidden()
    await expect(wait).resolves.toBe('hidden')
    expect(frames.cancelled).toEqual(frames.requested)
    expect(visibility.unsubscriptions).toBe(1)
    expect(visibility.activeListeners).toBe(0)
    expect(gate.pendingCount()).toBe(0)
  })

  it('a frame callback that arrives after cancellation publishes nothing', async () => {
    const { gate, frames } = createGate()
    const wait = gate.wait()
    const settlement = track(wait)
    await settleMicrotasks()

    gate.cancelAll()
    await settleMicrotasks()
    expect(settlement.value).toBe('cancelled')

    // The frame was cancelled, but a callback already dispatched by the
    // compositor must still be a no-op: no second settlement, no `frame`.
    frames.callLate()
    await settleMicrotasks()
    expect(settlement.value).toBe('cancelled')
    expect(settlement.count).toBe(1)
  })

  it('fails closed when the environment has no frame source', async () => {
    const gate = createPaginationFrameWait({
      requestFrame: () => null,
      isHidden: () => false,
      subscribeHidden: () => () => {}
    })
    await expect(gate.wait()).resolves.toBe('cancelled')
    expect(gate.pendingCount()).toBe(0)
  })

  it('the default visibility dependency subscribes to `visibilitychange`, settles `hidden` and unsubscribes', async () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const gate = createPaginationFrameWait({ requestFrame: () => 1, cancelFrame: () => {} })
    try {
      const wait = gate.wait()
      await settleMicrotasks()
      expect(addListener.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1)
      expect(gate.pendingCount()).toBe(1)

      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      await expect(wait).resolves.toBe('hidden')
      expect(removeListener.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1)
      expect(gate.pendingCount()).toBe(0)
    } finally {
      visibility.mockRestore()
      addListener.mockRestore()
      removeListener.mockRestore()
    }
  })
})

describe('frame-ordered publication origin', () => {
  it('only the ordinary user edge in the older direction opts in', () => {
    expect(isFrameOrderedPublicationOrigin('ordinary-user-edge', 'older')).toBe(true)
    expect(isFrameOrderedPublicationOrigin('ordinary-user-edge', 'newer')).toBe(false)
    expect(isFrameOrderedPublicationOrigin('shared', 'older')).toBe(false)
    expect(isFrameOrderedPublicationOrigin('shared', 'newer')).toBe(false)
  })

  it('shared callers keep the synchronous path with no frame requested', async () => {
    const { gate, frames } = createGate()
    for (const [origin, direction] of [
      ['shared', 'older'],
      ['shared', 'newer'],
      ['ordinary-user-edge', 'newer']
    ] as const) {
      await expect(awaitOrdinaryPageFrame({ origin, direction, gate, stillApplicable: () => true })).resolves.toEqual({
        step: 'not-required'
      })
    }
    expect(frames.requested).toEqual([])
  })

  it('continues to the precommit only after the frame and a successful re-proof', async () => {
    const { gate, frames } = createGate()
    const stillApplicable = vi.fn(() => true)
    const step = awaitOrdinaryPageFrame({
      origin: 'ordinary-user-edge',
      direction: 'older',
      gate,
      stillApplicable
    })
    const settlement = track(step)
    await settleMicrotasks()
    expect(settlement.settled).toBe(false)
    expect(stillApplicable).not.toHaveBeenCalled()

    frames.flush()
    await expect(step).resolves.toEqual({ step: 'frame' })
    expect(stillApplicable).toHaveBeenCalledTimes(1)
  })

  it('abandons when the attempt is superseded during the wait', async () => {
    const { gate, frames } = createGate()
    let stillApplicable = true
    const step = awaitOrdinaryPageFrame({
      origin: 'ordinary-user-edge',
      direction: 'older',
      gate,
      stillApplicable: () => stillApplicable
    })
    await settleMicrotasks()
    stillApplicable = false
    frames.flush()
    await expect(step).resolves.toEqual({ step: 'abandon', reason: 'superseded' })
  })

  it('abandons on hidden and on cancellation', async () => {
    const hiddenCase = createGate()
    hiddenCase.visibility.setHidden(true)
    await expect(
      awaitOrdinaryPageFrame({
        origin: 'ordinary-user-edge',
        direction: 'older',
        gate: hiddenCase.gate,
        stillApplicable: () => true
      })
    ).resolves.toEqual({ step: 'abandon', reason: 'hidden' })

    const cancelledCase = createGate()
    const stillApplicable = vi.fn(() => true)
    const step = awaitOrdinaryPageFrame({
      origin: 'ordinary-user-edge',
      direction: 'older',
      gate: cancelledCase.gate,
      stillApplicable
    })
    await settleMicrotasks()
    cancelledCase.gate.cancelAll()
    await expect(step).resolves.toEqual({ step: 'abandon', reason: 'cancelled' })
    expect(stillApplicable).not.toHaveBeenCalled()
  })
})

describe('abandon composition with the existing lease and viewport reducer', () => {
  const loadStart = (token: object): MessageViewportState =>
    messageViewportReducer(createMessageViewportState(), { type: 'load/start', direction: 'older', token })

  it('releases the lease, clears loading/token and lets a successor start', async () => {
    const token = {}
    const lease = createPaginationFetchLease()
    expect(claimPaginationFetchLease(lease, token)).toBe(true)
    let state = loadStart(token)
    expect(state.loading.older).toBe(true)

    const { gate } = createGate()
    const step = awaitOrdinaryPageFrame({
      origin: 'ordinary-user-edge',
      direction: 'older',
      gate,
      stillApplicable: () => state.loads.older.active && state.loads.older.token === token
    })
    await settleMicrotasks()
    gate.cancelAll()
    await expect(step).resolves.toEqual({ step: 'abandon', reason: 'cancelled' })

    // The attempt's terminal sequence (token-scoped release + load/cancel).
    expect(releasePaginationFetchLease(lease, token)).toBe(true)
    state = messageViewportReducer(state, { type: 'load/cancel', direction: 'older', token, topicGeneration: 0 })

    expect(isPaginationFetchLeaseFree(lease)).toBe(true)
    expect(state.loading.older).toBe(false)
    expect(state.loads.older.active).toBe(false)
    expect(state.loads.older.token).toBeNull()

    // Resource release is real: the next genuine edge event can claim and start.
    const successor = {}
    expect(claimPaginationFetchLease(lease, successor)).toBe(true)
    expect(ownsPaginationFetchLease(lease, token)).toBe(false)
    state = loadStart(successor)
    expect(state.loading.older).toBe(true)
    expect(state.loads.older.token).toBe(successor)
  })

  it('a cancelled attempt cannot publish even if its frame callback fires late', async () => {
    const token = {}
    const lease = createPaginationFetchLease()
    claimPaginationFetchLease(lease, token)
    let state = loadStart(token)
    const { gate, frames } = createGate()

    const step = awaitOrdinaryPageFrame({
      origin: 'ordinary-user-edge',
      direction: 'older',
      gate,
      stillApplicable: (): boolean =>
        state.loads.older.active && state.loads.older.token === token && state.topicGeneration === 0
    })
    await settleMicrotasks()

    // Cancel through the existing chain, then let the already-queued frame run.
    gate.cancelAll()
    releasePaginationFetchLease(lease, token)
    state = messageViewportReducer(state, { type: 'load/cancel', direction: 'older', token, topicGeneration: 0 })
    const afterCancel = state
    frames.callLate()

    await expect(step).resolves.toEqual({ step: 'abandon', reason: 'cancelled' })
    // A late commit for the cancelled token is rejected by the reducer itself.
    const committed = messageViewportReducer(afterCancel, {
      type: 'load/finish',
      direction: 'older',
      token,
      topicGeneration: 0,
      window: { oldestMessageId: 'm1', newestMessageId: 'm2', hasMoreOlder: false, hasMoreNewer: false } as never
    })
    expect(committed).toBe(afterCancel)
  })

  it('a hidden document abandons without holding the lease or loading state', async () => {
    const token = {}
    const lease = createPaginationFetchLease()
    claimPaginationFetchLease(lease, token)
    let state = loadStart(token)
    const { gate, visibility } = createGate()
    visibility.setHidden(true)

    const step = awaitOrdinaryPageFrame({
      origin: 'ordinary-user-edge',
      direction: 'older',
      gate,
      stillApplicable: () => true
    })
    await expect(step).resolves.toEqual({ step: 'abandon', reason: 'hidden' })

    releasePaginationFetchLease(lease, token)
    state = messageViewportReducer(state, { type: 'load/cancel', direction: 'older', token, topicGeneration: 0 })
    expect(isPaginationFetchLeaseFree(lease)).toBe(true)
    expect(state.loading.older).toBe(false)
  })
})

describe('frame wait cancellation is shared by every cancel entry', () => {
  it('cancelAll settles every queued wait exactly once and cancels each frame', async () => {
    const { gate, frames } = createGate()
    const waitA = gate.wait()
    const waitB = gate.wait()
    await settleMicrotasks()
    expect(gate.pendingCount()).toBe(2)

    gate.cancelAll()
    await expect(Promise.all([waitA, waitB])).resolves.toEqual(['cancelled', 'cancelled'])
    expect(frames.cancelled).toEqual(frames.requested)
    expect(gate.pendingCount()).toBe(0)

    // The gate is reusable for the next attempt after cancellation.
    const next = gate.wait()
    frames.flush()
    await expect(next).resolves.toBe('frame')
  })

  it('a cancelled attempt cannot be revived by a frame flush', async () => {
    const { gate, frames } = createGate()
    const wait = gate.wait()
    await settleMicrotasks()
    gate.cancelAll()
    await expect(wait).resolves.toBe('cancelled')
    // Nothing is queued: a flush cannot produce a `frame` for the old attempt.
    frames.flush()
    await settleMicrotasks()
    expect(gate.pendingCount()).toBe(0)
  })
})
