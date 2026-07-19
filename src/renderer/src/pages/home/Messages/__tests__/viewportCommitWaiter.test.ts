import { describe, expect, it, vi } from 'vitest'

import { createViewportCommitWaiter } from '../viewportCommitWaiter'

interface TestState {
  generation: number
  token: object | null
}

const waitForToken = (
  waiter: ReturnType<typeof createViewportCommitWaiter<TestState>>,
  state: TestState,
  token: object
) =>
  waiter.wait(state, (committedState) => {
    if (committedState.token === token) return true
    if (committedState.generation > state.generation) return false
    return null
  })

describe('viewportCommitWaiter', () => {
  it('does not run a token side effect before its begin state commits', async () => {
    const waiter = createViewportCommitWaiter<TestState>()
    const token = {}
    const sideEffect = vi.fn()
    const committed = waitForToken(waiter, { generation: 0, token: null }, token)

    void committed.then((isCurrent) => isCurrent && sideEffect())
    await Promise.resolve()
    expect(sideEffect).not.toHaveBeenCalled()

    waiter.notify({ generation: 1, token })
    await expect(committed).resolves.toBe(true)
    expect(sideEffect).toHaveBeenCalledOnce()
  })

  it('rejects a token replaced before its begin state commits', async () => {
    const waiter = createViewportCommitWaiter<TestState>()
    const committed = waitForToken(waiter, { generation: 0, token: null }, {})

    waiter.notify({ generation: 1, token: {} })

    await expect(committed).resolves.toBe(false)
  })

  it('rejects a token invalidated by reset', async () => {
    const waiter = createViewportCommitWaiter<TestState>()
    const committed = waitForToken(waiter, { generation: 2, token: null }, {})

    waiter.notify({ generation: 3, token: null })

    await expect(committed).resolves.toBe(false)
  })

  it('clears pending commits on unmount', async () => {
    const waiter = createViewportCommitWaiter<TestState>()
    const committed = waitForToken(waiter, { generation: 0, token: null }, {})

    waiter.cancelAll()

    await expect(committed).resolves.toBe(false)
  })

  it('accepts an already committed existing navigation token', async () => {
    const waiter = createViewportCommitWaiter<TestState>()
    const token = {}

    await expect(waitForToken(waiter, { generation: 1, token }, token)).resolves.toBe(true)
  })
})
