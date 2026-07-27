import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Message } from '@renderer/types/newMessage'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { branchFromMessage, emitNewBranch, getBranchEndpoint } from '../messageBranch'

const makeMessages = (ids: string[]): Message[] => ids.map((id) => ({ id }) as Message)

describe('getBranchEndpoint', () => {
  it('uses the message id to locate a branch endpoint in the full chronological history', () => {
    const messages = makeMessages(['m0', 'm1', 'm2', 'm3', 'm4'])

    expect(getBranchEndpoint(messages, 'm2')).toBe(3)
    expect(getBranchEndpoint(messages, 'missing')).toBeNull()
  })

  it('rejects a numeric-index payload (regression: ad97fad63c emitter sent index instead of id)', () => {
    const messages = makeMessages([
      '8b7f6a4e-0d2c-4f1a-9e3b-111111111111',
      '8b7f6a4e-0d2c-4f1a-9e3b-222222222222',
      '8b7f6a4e-0d2c-4f1a-9e3b-333333333333'
    ])

    // Under the regression the emitter sent the message's numeric index.
    // An index payload must never resolve to an endpoint in the ID-based contract.
    expect(getBranchEndpoint(messages, 1 as unknown as string)).toBeNull()
    expect(getBranchEndpoint(messages, '1')).toBeNull()
  })
})

describe('emitNewBranch', () => {
  afterEach(() => {
    EventEmitter.clearListeners(EVENT_NAMES.NEW_BRANCH)
  })

  it('delivers the source message string ID to NEW_BRANCH listeners', async () => {
    const received: unknown[] = []
    EventEmitter.on(EVENT_NAMES.NEW_BRANCH, (payload) => {
      received.push(payload)
    })

    await emitNewBranch('8b7f6a4e-0d2c-4f1a-9e3b-222222222222')

    expect(received).toEqual(['8b7f6a4e-0d2c-4f1a-9e3b-222222222222'])
  })

  it('resolves only after async listeners settle, so callers can sequence follow-up work', async () => {
    let listenerDone = false
    EventEmitter.on(EVENT_NAMES.NEW_BRANCH, async () => {
      await Promise.resolve()
      listenerDone = true
    })

    await emitNewBranch('some-id')

    expect(listenerDone).toBe(true)
  })
})

describe('branchFromMessage', () => {
  const messages = makeMessages(['m0', 'm1', 'm2'])

  const makeCallbacks = (createBranch: (endpoint: number) => Promise<boolean>) => ({
    createBranch: vi.fn(createBranch),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    onMessageNotFound: vi.fn()
  })

  it('creates the branch at the resolved endpoint and reports success only after completion', async () => {
    let resolveCreate!: (value: boolean) => void
    const callbacks = makeCallbacks(() => new Promise<boolean>((resolve) => (resolveCreate = resolve)))

    const pending = branchFromMessage(messages, 'm1', callbacks)

    // The async branch operation has not completed yet — success must not be
    // reported (regression: premature success toast in the emitter).
    await Promise.resolve()
    expect(callbacks.createBranch).toHaveBeenCalledWith(2)
    expect(callbacks.onSuccess).not.toHaveBeenCalled()

    resolveCreate(true)
    await expect(pending).resolves.toBe(true)

    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1)
    expect(callbacks.onFailure).not.toHaveBeenCalled()
    expect(callbacks.onMessageNotFound).not.toHaveBeenCalled()
  })

  it('reports failure (never success) when branch creation resolves false', async () => {
    const callbacks = makeCallbacks(async () => false)

    await expect(branchFromMessage(messages, 'm2', callbacks)).resolves.toBe(false)

    expect(callbacks.onFailure).toHaveBeenCalledTimes(1)
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
  })

  it('does not attempt creation nor report success for an unresolvable message ID', async () => {
    const callbacks = makeCallbacks(async () => true)

    await expect(branchFromMessage(messages, 'not-a-message', callbacks)).resolves.toBe(false)

    expect(callbacks.onMessageNotFound).toHaveBeenCalledTimes(1)
    expect(callbacks.createBranch).not.toHaveBeenCalled()
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
  })

  it('routes a rejected createBranch promise through onFailure and never reports success', async () => {
    const callbacks = makeCallbacks(async () => {
      throw new Error('branch creation failed')
    })

    // The rejection must not escape branchFromMessage as an unhandled rejection.
    await expect(branchFromMessage(messages, 'm1', callbacks)).resolves.toBe(false)

    expect(callbacks.onFailure).toHaveBeenCalledTimes(1)
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
    expect(callbacks.onMessageNotFound).not.toHaveBeenCalled()
  })
})
