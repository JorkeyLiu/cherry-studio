/**
 * Focused tests for the bounded history estimation session.
 *
 * Observable-equivalence strategy (no timing claims, synthetic data only):
 * - The session's first-run scalar must equal the canonical
 *   `estimateHistoryTokens` over the same message set + snapshot.
 * - Repeat runs must not re-invoke the per-message estimator for unchanged
 *   entries (proven by call counts, not by wall-clock).
 * - Changed entries (message ref, any block ref in `message.blocks` order
 *   including missing refs, `includeMedia`) re-estimate fully; the scalar
 *   still matches the canonical result.
 */
import type { Assistant } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Deterministic tokenizer: 1 char ≈ 1 token (prompt + canonical text math).
vi.mock('tokenx', () => ({
  estimateTokenCount: (text: string) => text.length
}))

import { createHistoryTokenEstimateSession } from '../historyTokenEstimateSession'
import { estimateHistoryTokens, estimateMessageUsage } from '../TokenService'

/**
 * Delegating spy: runs the exact current token algorithm (so session scalars
 * stay comparable to the canonical result) while counting invocations to
 * prove stable entries are not re-tokenized.
 */
const delegatingSpy = () =>
  vi.fn((message: Message, options: { includeMedia?: boolean; snapshotBlocks?: SnapshotBlockMap }) =>
    estimateMessageUsage(message, options).then((usage) => usage.total_tokens)
  )

// ---------------------------------------------------------------------------
// Helpers (synthetic data only)
// ---------------------------------------------------------------------------

const makeAssistant = (prompt = 'system prompt'): Assistant =>
  ({ id: 'a1', prompt, settings: {} }) as unknown as Assistant

const textBlock = (id: string, content: string, messageId: string): MessageBlock =>
  ({ id, type: MessageBlockType.MAIN_TEXT, content, messageId }) as unknown as MessageBlock

const thinkBlock = (id: string, content: string, messageId: string): MessageBlock =>
  ({ id, type: MessageBlockType.THINKING, content, messageId }) as unknown as MessageBlock

const fileBlock = (id: string, messageId: string): MessageBlock =>
  ({
    id,
    type: MessageBlockType.FILE,
    messageId,
    file: { id: `file-${id}`, type: 'document' }
  }) as unknown as MessageBlock

const imageBlock = (id: string, messageId: string): MessageBlock =>
  ({ id, type: MessageBlockType.IMAGE, messageId }) as unknown as MessageBlock

const makeMsg = (id: string, blockIds: string[], role: Message['role'] = 'user'): Message =>
  ({
    id,
    role,
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-07-19T00:00:00.000Z',
    status: 'success',
    blocks: blockIds
  }) as unknown as Message

const snapOf = (blocks: MessageBlock[]): SnapshotBlockMap => new Map(blocks.map((block) => [block.id, block]))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createHistoryTokenEstimateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cold run matches the canonical estimate and caches per-message results', async () => {
    const blocks = [textBlock('b-u1', 'Hello', 'u1'), textBlock('b-a1', 'World!', 'a1')]
    const messages = [makeMsg('u1', ['b-u1']), makeMsg('a1', ['b-a1'], 'assistant')]
    const snapshot = snapOf(blocks)
    const assistant = makeAssistant()

    const estimateMessage = delegatingSpy()
    const session = createHistoryTokenEstimateSession({ estimateMessage })

    const first = await session.estimateHistory(assistant, messages, { snapshotBlocks: snapshot })
    const canonical = await estimateHistoryTokens(assistant, messages, { snapshotBlocks: snapshot })

    expect(first).toBe(canonical)
    expect(estimateMessage).toHaveBeenCalledTimes(2)
    expect(session.cacheSize()).toBe(2)

    // Identical rerun: no repeated per-message work, same scalar.
    const second = await session.estimateHistory(assistant, messages, { snapshotBlocks: snapshot })
    expect(second).toBe(first)
    expect(estimateMessage).toHaveBeenCalledTimes(2)
  })

  it('only the replaced message object is re-estimated', async () => {
    const blocks = [textBlock('b-u1', 'Hello', 'u1'), textBlock('b-a1', 'World!', 'a1')]
    const u1 = makeMsg('u1', ['b-u1'])
    const a1 = makeMsg('a1', ['b-a1'], 'assistant')
    const snapshot = snapOf(blocks)
    const assistant = makeAssistant()

    const estimateMessage = delegatingSpy()
    const session = createHistoryTokenEstimateSession({ estimateMessage })
    await session.estimateHistory(assistant, [u1, a1], { snapshotBlocks: snapshot })
    expect(estimateMessage).toHaveBeenCalledTimes(2)

    // Same content, new message object for a1: only a1 re-estimates.
    const a1Next = makeMsg('a1', ['b-a1'], 'assistant')
    const next = await session.estimateHistory(assistant, [u1, a1Next], { snapshotBlocks: snapshot })
    expect(estimateMessage).toHaveBeenCalledTimes(3)
    const canonical = await estimateHistoryTokens(assistant, [u1, a1Next], { snapshotBlocks: snapshot })
    expect(next).toBe(canonical)
  })

  it('a replaced block entity re-estimates the whole message (text + reasoning)', async () => {
    const text = textBlock('b-u1', 'Hello', 'u1')
    const think = thinkBlock('b-t1', 'because', 'u1')
    const u1 = makeMsg('u1', ['b-u1', 'b-t1'])
    const assistant = makeAssistant()

    const estimateMessage = delegatingSpy()
    const session = createHistoryTokenEstimateSession({ estimateMessage })
    const first = await session.estimateHistory(assistant, [u1], { snapshotBlocks: snapOf([text, think]) })
    expect(estimateMessage).toHaveBeenCalledTimes(1)

    // New reasoning block entity, same message ref: full re-estimate.
    const thinkNext = thinkBlock('b-t1', 'because-revised', 'u1')
    const second = await session.estimateHistory(assistant, [u1], {
      snapshotBlocks: snapOf([text, thinkNext])
    })
    expect(estimateMessage).toHaveBeenCalledTimes(2)
    const canonical = await estimateHistoryTokens(assistant, [u1], {
      snapshotBlocks: snapOf([text, thinkNext])
    })
    expect(second).toBe(canonical)
    expect(second).not.toBe(first)

    // Stable repeat: no further work.
    await session.estimateHistory(assistant, [u1], { snapshotBlocks: snapOf([text, thinkNext]) })
    expect(estimateMessage).toHaveBeenCalledTimes(2)
  })

  it('missing-to-present block refs re-estimate; file/image ref changes re-estimate', async () => {
    const text = textBlock('b-u1', 'Hello', 'u1')
    const file = fileBlock('b-f1', 'u1')
    const image = imageBlock('b-i1', 'u1')
    const u1 = makeMsg('u1', ['b-u1', 'b-f1', 'b-i1'])
    const assistant = makeAssistant()

    const estimateMessage = vi.fn(async () => 5)
    const session = createHistoryTokenEstimateSession({ estimateMessage })

    // b-f1 / b-i1 missing from the snapshot: estimated with missing refs.
    await session.estimateHistory(assistant, [u1], { snapshotBlocks: snapOf([text]) })
    expect(estimateMessage).toHaveBeenCalledTimes(1)

    // Now present: changed refs → re-estimate.
    await session.estimateHistory(assistant, [u1], { snapshotBlocks: snapOf([text, file, image]) })
    expect(estimateMessage).toHaveBeenCalledTimes(2)

    // New file entity, same message: re-estimate again.
    const fileNext = fileBlock('b-f1', 'u1')
    await session.estimateHistory(assistant, [u1], { snapshotBlocks: snapOf([text, fileNext, image]) })
    expect(estimateMessage).toHaveBeenCalledTimes(3)
  })

  it('includeMedia change invalidates cached results; repeat reuses', async () => {
    const blocks = [textBlock('b-u1', 'Hello', 'u1'), imageBlock('b-i1', 'u1')]
    const u1 = makeMsg('u1', ['b-u1', 'b-i1'])
    const assistant = makeAssistant()

    const seenFlags: (boolean | undefined)[] = []
    const estimateMessage = vi.fn(async (_message: Message, options: { includeMedia?: boolean }) => {
      seenFlags.push(options.includeMedia)
      return 4
    })
    const session = createHistoryTokenEstimateSession({ estimateMessage })

    await session.estimateHistory(assistant, [u1], { snapshotBlocks: snapOf(blocks) })
    expect(seenFlags).toEqual([true])

    await session.estimateHistory(assistant, [u1], {
      includeMedia: false,
      snapshotBlocks: snapOf(blocks)
    })
    expect(seenFlags).toEqual([true, false])

    // Same flag again: reused, no new estimation.
    await session.estimateHistory(assistant, [u1], {
      includeMedia: false,
      snapshotBlocks: snapOf(blocks)
    })
    expect(seenFlags).toEqual([true, false])
  })

  it('prompt change re-estimates only the prompt, never history', async () => {
    const blocks = [textBlock('b-u1', 'Hello', 'u1'), textBlock('b-a1', 'World!', 'a1')]
    const messages = [makeMsg('u1', ['b-u1']), makeMsg('a1', ['b-a1'], 'assistant')]
    const snapshot = snapOf(blocks)

    const estimateMessage = vi.fn(async () => 7)
    const session = createHistoryTokenEstimateSession({ estimateMessage })

    const first = await session.estimateHistory(makeAssistant('abc'), messages, {
      snapshotBlocks: snapshot
    })
    expect(estimateMessage).toHaveBeenCalledTimes(2)

    const second = await session.estimateHistory(makeAssistant('abcdef'), messages, {
      snapshotBlocks: snapshot
    })
    expect(estimateMessage).toHaveBeenCalledTimes(2)
    expect(second - first).toBe(3)
  })

  it('empty list estimates only the system prompt', async () => {
    const session = createHistoryTokenEstimateSession({ estimateMessage: vi.fn(async () => 99) })
    const total = await session.estimateHistory(makeAssistant('prompt!'), [], {
      snapshotBlocks: new Map()
    })
    expect(total).toBe('prompt!'.length)
    expect(session.cacheSize()).toBe(0)
  })

  it('removal prunes out-of-scope entries; reorder without ref change reuses', async () => {
    const blocks = [textBlock('b-1', 'one', 'm1'), textBlock('b-2', 'two', 'm2'), textBlock('b-3', 'x', 'm3')]
    const snapshot = snapOf(blocks)
    const assistant = makeAssistant()
    const m1 = makeMsg('m1', ['b-1'])
    const m2 = makeMsg('m2', ['b-2'])
    const m3 = makeMsg('m3', ['b-3'])

    const estimateMessage = delegatingSpy()
    const session = createHistoryTokenEstimateSession({ estimateMessage })
    await session.estimateHistory(assistant, [m1, m2, m3], { snapshotBlocks: snapshot })
    expect(session.cacheSize()).toBe(3)

    // Reorder only: same refs → no new work, same scalar.
    const reordered = await session.estimateHistory(assistant, [m3, m1, m2], {
      snapshotBlocks: snapshot
    })
    expect(estimateMessage).toHaveBeenCalledTimes(3)
    expect(session.cacheSize()).toBe(3)
    expect(reordered).toBe(await estimateHistoryTokens(assistant, [m3, m1, m2], { snapshotBlocks: snapshot }))

    // Removal: pruned to the exact current set.
    await session.estimateHistory(assistant, [m1, m3], { snapshotBlocks: snapshot })
    expect(session.cacheSize()).toBe(2)
    expect(estimateMessage).toHaveBeenCalledTimes(3)
  })

  it('overlapping runs: stale failure never deletes the newer entry', async () => {
    const text = textBlock('b-1', 'one', 'm1')
    const m1 = makeMsg('m1', ['b-1'])
    const assistant = makeAssistant()
    const snapshot = snapOf([text])

    const gate = deferred<number>()
    let calls = 0
    const estimateMessage = vi.fn(() => {
      calls += 1
      return calls === 1 ? gate.promise : Promise.resolve(20)
    })
    const session = createHistoryTokenEstimateSession({ estimateMessage })

    // Run A starts (pending). Run B replaces the message ref and resolves fast.
    const runA = session.estimateHistory(assistant, [m1], { snapshotBlocks: snapshot })
    const m1Next = makeMsg('m1', ['b-1'])
    const runB = session.estimateHistory(assistant, [m1Next], { snapshotBlocks: snapshot })
    await expect(runB).resolves.toBe(20 + (assistant.prompt ?? '').length)
    expect(session.cacheSize()).toBe(1)

    // A's stale promise rejects late: it must not delete B's accepted entry.
    gate.reject(new Error('stale'))
    await expect(runA).rejects.toThrow('stale')
    expect(session.cacheSize()).toBe(1)

    // Next run reuses B's entry — no retry needed, no new estimation.
    await session.estimateHistory(assistant, [m1Next], { snapshotBlocks: snapshot })
    expect(estimateMessage).toHaveBeenCalledTimes(2)
  })

  it('rejected estimates are never cached; the next run retries', async () => {
    const text = textBlock('b-1', 'one', 'm1')
    const m1 = makeMsg('m1', ['b-1'])
    const assistant = makeAssistant()
    const snapshot = snapOf([text])

    let calls = 0
    const estimateMessage = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('boom')
      }
      return 11
    })
    const session = createHistoryTokenEstimateSession({ estimateMessage })

    await expect(session.estimateHistory(assistant, [m1], { snapshotBlocks: snapshot })).rejects.toThrow('boom')
    expect(session.cacheSize()).toBe(0)

    await expect(session.estimateHistory(assistant, [m1], { snapshotBlocks: snapshot })).resolves.toBe(
      11 + (assistant.prompt ?? '').length
    )
    expect(estimateMessage).toHaveBeenCalledTimes(2)
  })

  it('reset drops every entry; reset sessions re-estimate from scratch', async () => {
    const blocks = [textBlock('b-1', 'one', 'm1')]
    const m1 = makeMsg('m1', ['b-1'])
    const assistant = makeAssistant()
    const snapshot = snapOf(blocks)

    const estimateMessage = vi.fn(async () => 2)
    const session = createHistoryTokenEstimateSession({ estimateMessage })
    await session.estimateHistory(assistant, [m1], { snapshotBlocks: snapshot })
    expect(session.cacheSize()).toBe(1)

    session.reset()
    expect(session.cacheSize()).toBe(0)
    await session.estimateHistory(assistant, [m1], { snapshotBlocks: snapshot })
    expect(estimateMessage).toHaveBeenCalledTimes(2)
  })

  describe('store-once fallback (no explicit snapshot)', () => {
    it('matches the legacy store-backed canonical result with a closed capture', async () => {
      const { combineReducers, configureStore } = await import('@reduxjs/toolkit')
      const { messageBlocksSlice } = await import('@renderer/store/messageBlock')
      const storeModule = (await import('@renderer/store')) as unknown as {
        default: { getState: () => unknown }
      }
      const mockStore = configureStore({
        reducer: combineReducers({ messageBlocks: messageBlocksSlice.reducer }),
        middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
      })
      mockStore.dispatch(
        messageBlocksSlice.actions.upsertOneBlock({
          id: 'block-m1',
          type: MessageBlockType.MAIN_TEXT,
          content: 'Hello',
          messageId: 'm1'
        } as never)
      )
      mockStore.dispatch(
        messageBlocksSlice.actions.upsertOneBlock({
          id: 'block-m2',
          type: MessageBlockType.MAIN_TEXT,
          content: 'World!',
          messageId: 'm2'
        } as never)
      )
      vi.spyOn(storeModule.default, 'getState').mockReturnValue(mockStore.getState())
      try {
        const assistant = makeAssistant()
        const messages = [makeMsg('m1', ['block-m1']), makeMsg('m2', ['block-m2'], 'assistant')]
        const session = createHistoryTokenEstimateSession()
        const viaSession = await session.estimateHistory(assistant, messages)
        const canonical = await estimateHistoryTokens(assistant, messages)
        expect(viaSession).toBe(canonical)
        expect(await session.estimateHistory(assistant, messages)).toBe(canonical)
      } finally {
        vi.restoreAllMocks()
      }
    })
  })
})
