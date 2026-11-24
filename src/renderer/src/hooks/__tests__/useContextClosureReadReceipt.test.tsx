/**
 * Closure read receipts (route B witness handoff) at the real
 * `useContextClosure` issuer.
 *
 * The hook captures a terminal-read witness synchronously at fetch start and
 * binds the exact accepted response object to it before cache publication.
 * A later handoff with that response's own receipt retires exactly the
 * executions whose terminal ack happened before the read — never terminals
 * acked mid-read, never failed/invalid reads, and a cache hit keeps its
 * original read's receipt instead of stealing the latest witness.
 */
import { bumpAndInvalidate, resetAllClosureStateForTests } from '@renderer/services/contextClosure'
import { getClosureReadReceipt } from '@renderer/services/executionOverlayReadReceipt'
import {
  getComposedOverlayBlocks,
  registerExecutionOverlay,
  resetExecutionOverlayForTests,
  routeKeyForExecutionOverlay,
  subscribeExecutionOverlay,
  tryHandoffAfterClosure
} from '@renderer/services/executionOverlayRegistry'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchClosureMock, dispatchMock, getStateMock, upsertManyBlocksMock, topicMessagesMap, messagesForTopicMap } =
  vi.hoisted(() => {
    const topicMessagesMap = new Map<string, unknown[]>()
    const messagesForTopicMap = new Map<string, unknown[]>()
    return {
      fetchClosureMock: vi.fn(),
      dispatchMock: vi.fn(),
      getStateMock: vi.fn(),
      upsertManyBlocksMock: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: blocks })),
      topicMessagesMap,
      messagesForTopicMap
    }
  })

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: (topicId: string) => topicMessagesMap.get(topicId) ?? []
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchContextClosure: fetchClosureMock
  }
}))

vi.mock('@renderer/services/topicDeletionInvalidation', () => ({
  captureDeletionGeneration: () => 0,
  isDeletionStale: () => false
}))

vi.mock('@renderer/store', async () => {
  const actual: any = await vi.importActual('@renderer/store')
  return {
    ...actual,
    default: {
      getState: getStateMock,
      dispatch: dispatchMock,
      subscribe: vi.fn()
    },
    useAppDispatch: () => dispatchMock
  }
})

vi.mock('@renderer/store/messageBlock', async () => {
  const actual: any = await vi.importActual('@renderer/store/messageBlock')
  return {
    ...actual,
    upsertManyBlocks: upsertManyBlocksMock
  }
})

vi.mock('@renderer/store/newMessage', async () => {
  const actual: any = await vi.importActual('@renderer/store/newMessage')
  return {
    ...actual,
    selectLoadedMessagesForTopic: (_state: unknown, topicId: string) => messagesForTopicMap.get(topicId) ?? []
  }
})

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: any) => ({
    contextCount: assistant?.settings?.contextCount ?? 25,
    contextWindowAnchor: assistant?.settings?.contextWindowAnchor ?? {}
  })
}))

const { useContextClosure } = await import('../useContextClosure')

const TOPIC = 't-receipt'
const ANCHOR = 'u1'

function block(id: string, content: string, messageId = 'a1'): any {
  return { id, messageId, type: 'main_text', content, status: 'streaming' }
}

function makeResp(topicId: string, anchor: string, ids: string[] = ['u1', 'a1']): FetchContextClosureResponse {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    blocks: [],
    ...(id.startsWith('a') ? { askId: ids[0] } : {})
  }))
  const userCount = ids.filter((id) => id.startsWith('u')).length || 1
  return {
    messages: messages as any,
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      totalTurnCount: userCount,
      selectedTurnCount: userCount,
      foldedMessageIds: [],
      boundaryMessageId: null
    }
  } as any
}

function makeAssistantState(anchorMap: Record<string, string>) {
  const anchorObj = Object.fromEntries(
    Object.entries(anchorMap).map(([topicId, groupKey]) => [topicId, { kind: 'active', groupKey }])
  )
  return {
    assistants: {
      assistants: [
        {
          id: 'asst-1',
          topics: Object.keys(anchorMap).map((id) => ({ id })),
          settings: { contextWindowAnchor: anchorObj }
        }
      ]
    },
    messages: { entities: {}, messageIdsByTopic: {} },
    messageBlocks: { entities: {} }
  }
}

describe('useContextClosure read receipt', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    resetExecutionOverlayForTests()
    vi.clearAllMocks()
    topicMessagesMap.clear()
    messagesForTopicMap.clear()
    getStateMock.mockReturnValue(makeAssistantState({ [TOPIC]: ANCHOR }) as any)
    fetchClosureMock.mockReset()
    dispatchMock.mockReset()
  })

  it('excludes a terminal acked mid-read; the next read after the ack hands off', async () => {
    const routeKey = routeKeyForExecutionOverlay(TOPIC, null)
    const unsubscribe = subscribeExecutionOverlay(routeKey, () => {})
    try {
      const handle = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'terminal-body')] })
      })
      act(() => {
        handle.notifyDelta()
      })

      // The terminal ack lands while the first read is in flight — after the
      // hook captured its witness, before the response arrives.
      const first = makeResp(TOPIC, ANCHOR)
      fetchClosureMock.mockImplementationOnce(async () => {
        handle.recordTerminalPersisted('success')
        handle.dispose()
        return first
      })
      const second = makeResp(TOPIC, ANCHOR)
      fetchClosureMock.mockImplementationOnce(async () => second)

      const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
        initialProps: { t: TOPIC, a: ANCHOR }
      })
      await waitFor(() => expect(result.current.closure).toBe(first))

      // The first read started before the ack: its receipt is empty and can
      // never retire the terminal, even though the closure carries the member.
      const receipt1 = getClosureReadReceipt(result.current.closure)
      expect(receipt1).toBeDefined()
      expect(receipt1?.terminals).toEqual([])
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, receipt1)).toBe(false)
      expect((getComposedOverlayBlocks(routeKey, ['a1-block']).get('a1-block') as any)?.content).toBe('terminal-body')

      // A genuine invalidation drives a second read, issued after the ack.
      act(() => {
        bumpAndInvalidate(TOPIC)
      })
      await waitFor(() => expect(result.current.closure).toBe(second))
      const receipt2 = getClosureReadReceipt(result.current.closure)
      expect(receipt2?.terminals).toHaveLength(1)
      expect(receipt2?.terminals[0]).toMatchObject({ messageId: 'a1' })
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, receipt2)).toBe(true)
      expect(getComposedOverlayBlocks(routeKey, ['a1-block']).size).toBe(0)
      expect(fetchClosureMock).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })

  it('never binds invalid or failed reads; a cache hit keeps its original read receipt', async () => {
    const routeKey = routeKeyForExecutionOverlay(TOPIC, null)
    const unsubscribe = subscribeExecutionOverlay(routeKey, () => {})
    try {
      // Invalid authoritative response for the current identity: fail-closed,
      // and the invalid object itself is never bound.
      const invalid = makeResp(TOPIC, 'other-anchor')
      fetchClosureMock.mockResolvedValueOnce(invalid)
      const { result, unmount } = renderHook(({ t, a }) => useContextClosure(t, a), {
        initialProps: { t: TOPIC, a: ANCHOR }
      })
      await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(1))
      await act(async () => {})
      expect(result.current.closure).toBeNull()
      expect(getClosureReadReceipt(invalid)).toBeUndefined()

      // Accepted read binds its witness.
      const accepted = makeResp(TOPIC, ANCHOR)
      fetchClosureMock.mockResolvedValueOnce(accepted)
      const first = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'terminal-body')] })
      })
      first.notifyDelta()
      first.recordTerminalPersisted('success')
      const { result: result2, unmount: unmount2 } = renderHook(({ t, a }) => useContextClosure(t, a), {
        initialProps: { t: TOPIC, a: ANCHOR }
      })
      await waitFor(() => expect(result2.current.closure).toBe(accepted))
      const receipt = getClosureReadReceipt(result2.current.closure)
      expect(receipt?.terminals.map((t) => t.messageId)).toEqual(['a1'])

      // A newer terminal acks after the read; a remount hits the cache (no new
      // fetch) and keeps the ORIGINAL receipt — it must not steal the latest
      // witness, so the new terminal stays retained.
      const latest = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a2',
        snapshot: () => ({ blocks: [block('a2-block', 'new-terminal')] })
      })
      act(() => {
        latest.notifyDelta()
      })
      latest.recordTerminalPersisted('success')
      latest.dispose()
      unmount2()
      unmount()
      fetchClosureMock.mockClear()
      const { result: result3 } = renderHook(({ t, a }) => useContextClosure(t, a), {
        initialProps: { t: TOPIC, a: ANCHOR }
      })
      await waitFor(() => expect(result3.current.closure).toBe(accepted))
      expect(fetchClosureMock).not.toHaveBeenCalled()
      const cacheReceipt = getClosureReadReceipt(result3.current.closure)
      expect(cacheReceipt).toBe(receipt)
      expect(cacheReceipt?.terminals.map((t) => t.messageId)).toEqual(['a1'])
      // The first entry was already retired by its own receipt; the cached
      // receipt names only the first execution, so the new terminal stays
      // retained instead of being swept by a stolen latest witness.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }, { id: 'a2' }] }, receipt)).toBe(true)
      expect((getComposedOverlayBlocks(routeKey, ['a2-block']).get('a2-block') as any)?.content).toBe('new-terminal')
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a2' }] }, cacheReceipt)).toBe(false)
      expect((getComposedOverlayBlocks(routeKey, ['a2-block']).get('a2-block') as any)?.content).toBe('new-terminal')
      // Sanity: a fresh witnessed read retires the remainder.
      const { captureTerminalReadWitness } = await import('@renderer/services/executionOverlayRegistry')
      expect(
        tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a2' }] }, captureTerminalReadWitness(routeKey))
      ).toBe(true)
      expect(getComposedOverlayBlocks(routeKey, ['a2-block']).size).toBe(0)
    } finally {
      unsubscribe()
    }
  })
})
