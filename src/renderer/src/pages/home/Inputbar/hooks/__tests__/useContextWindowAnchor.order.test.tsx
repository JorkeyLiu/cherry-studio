/**
 * Order-sensitive TokenCount re-anchor regression (committed render sequence).
 *
 * Isolated real Redux store (tiny assistants reducer + real
 * closure-invalidation semantics) + React Testing Library lightweight harness
 * mirroring Chat's shared projection boundary (`resolveSharedContextInfo`).
 * Observes committed `current/max` across the async re-anchor: pending keeps
 * the old authoritative value, the first committed render with the new anchor
 * is the new authoritative current/max, and the bounded-viewport
 * characteristic fallback (1/1) never appears.
 *
 * Sensitivity: inserting an `await` (or throwing/reordering) between the
 * anchor persist and the closure-cache publication forces an extra committed
 * render with the new anchor but no cache → the harness records 1/1 and the
 * test fails. Anchor-only/invalid/unpublishable responses never make the new
 * anchor visible, so they also never produce 1/1.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { useMemo } from 'react'
import { Provider, useSelector } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { resolveContextClosure: vi.fn() }
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: {
    settings?: { contextCount?: number | null; contextWindowAnchor?: Record<string, any> }
  }) => ({
    contextCount: assistant.settings?.contextCount === undefined ? 25 : assistant.settings.contextCount,
    contextWindowAnchor: assistant.settings?.contextWindowAnchor ?? {}
  }),
  DEFAULT_ASSISTANT_SETTINGS: { contextCount: 25, contextWindowAnchor: {} }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    resolveContextClosure: (...args: unknown[]) => mocks.resolveContextClosure(...args)
  }
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    resolveContextClosure: (...args: unknown[]) => mocks.resolveContextClosure(...args)
  }
}))

// Isolated store: tiny assistants reducer (same observable semantics as the
// real slice for anchor reads/merges) + the real closure-invalidation rule
// (messageBlocks mutations bump/invalidate via explicit ownership).
vi.mock('@renderer/store', async () => {
  const { configureStore } = await import('@reduxjs/toolkit')
  const closureCache = await import('@renderer/services/contextClosure')
  const { getClosureTopicIds } = await import('@renderer/store/closureOwnership')
  const initial = { assistants: [] as any[] }
  function assistantsReducer(state = initial, action: any) {
    if (action?.type === 'ordertest/seed') {
      return { assistants: action.payload as any[] }
    }
    if (action?.type === 'assistants/updateAssistantSettings') {
      const { assistantId, settings } = action.payload as { assistantId: string; settings: Record<string, any> }
      return {
        assistants: state.assistants.map((a: any) =>
          a.id === assistantId ? { ...a, settings: { ...a.settings, ...settings } } : a
        )
      }
    }
    return state
  }
  const closureMiddleware: any =
    () =>
    (next: any) =>
    (action: any): unknown => {
      const result = next(action)
      try {
        const type = typeof action?.type === 'string' ? (action.type as string) : ''
        if (type.startsWith('messageBlocks/')) {
          if (type !== 'messageBlocks/setMessageBlocksLoading' && type !== 'messageBlocks/setMessageBlocksError') {
            const ids = getClosureTopicIds(action)
            if (ids === null) closureCache.bumpAndInvalidateAll()
            else for (const id of ids) closureCache.bumpAndInvalidate(id)
          }
        }
      } catch {
        // invalidation never breaks dispatch
      }
      return result
    }
  const testStore = configureStore({
    reducer: { assistants: assistantsReducer as any },
    middleware: (gdm: any) => gdm({ serializableCheck: false }).concat(closureMiddleware)
  })
  return { default: testStore, __esModule: true }
})

import {
  computeClosureFingerprint,
  getFreshValidatedClosure,
  resetAllClosureStateForTests,
  setCachedContextClosure
} from '@renderer/services/contextClosure'
import { resolveSharedContextInfo } from '@renderer/services/contextInfoService'
import store from '@renderer/store'
import type { Assistant } from '@renderer/types'

import { useContextWindowAnchor } from '../useContextWindowAnchor'

const ASSISTANT_ID = 'asst-order-reanchor-1'
const TOPIC_ID = 'topic-order-reanchor-1'

function assistantSeed(oldAnchor: string): Assistant {
  return {
    id: ASSISTANT_ID,
    settings: {
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: oldAnchor } }
    }
  } as unknown as Assistant
}

function turnMessages(topicId: string, from: number, to: number) {
  const messages: Array<Record<string, unknown>> = []
  for (let i = from; i <= to; i++) {
    const u = `u${i}`
    messages.push({ id: u, role: 'user', topicId, blocks: [] })
    messages.push({ id: `a${i}`, role: 'assistant', topicId, askId: u, blocks: [] })
  }
  return messages
}

function closureFor(topicId: string, anchor: string, totalTurns: number, selectedTurns: number) {
  const anchorIndex = totalTurns - selectedTurns + 1
  const messages = turnMessages(topicId, anchorIndex, totalTurns)
  const firstMessageId = messages[0].id as string
  const lastMessageId = messages[messages.length - 1].id as string
  if (firstMessageId !== anchor) throw new Error(`helper misuse: ${firstMessageId} !== ${anchor}`)
  return {
    messages,
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId,
      lastMessageId,
      returnedCount: messages.length,
      totalTurnCount: totalTurns,
      selectedTurnCount: selectedTurns,
      boundaryMessageId: selectedTurns === totalTurns ? null : firstMessageId
    },
    resolvedAnchorGroupKey: anchor,
    changed: true
  } as any
}

/** Cache stores the exact 3-key fetch shape (LOCK-001 rejects extra roots). */
function toCacheEntry(resolverPayload: any) {
  return { messages: resolverPayload.messages, blocks: resolverPayload.blocks, closure: resolverPayload.closure } as any
}

/**
 * Minimal Chat-projection mirror: same inputs, same pure boundary
 * (`resolveSharedContextInfo`), same freshness gate. Records every committed
 * `current/max` so the test constrains render order, not just final state.
 */
function Probe({
  topicId,
  boundedMessages,
  committed
}: {
  topicId: string
  boundedMessages: any[]
  committed: string[]
}) {
  const assistant = useSelector((s: any) => (s.assistants.assistants as Assistant[]).find((a) => a.id === ASSISTANT_ID))
  const anchor = (assistant as any)?.settings?.contextWindowAnchor?.[topicId]?.groupKey ?? null
  const fingerprint = useMemo(() => computeClosureFingerprint(boundedMessages as any), [boundedMessages])
  const fresh = getFreshValidatedClosure(topicId, anchor, fingerprint)
  const info = resolveSharedContextInfo(boundedMessages as any, assistant, topicId, fresh as any)
  const text = `${info.contextCount.current}/${info.contextCount.max ?? 'null'}`
  committed.push(text)
  return <div data-testid="counts">{text}</div>
}

describe('useContextWindowAnchor committed order (real store harness)', () => {
  beforeEach(() => {
    mocks.resolveContextClosure.mockReset()
    resetAllClosureStateForTests()
    act(() => {
      ;(store as any).dispatch({ type: 'ordertest/seed', payload: [] })
    })
  })

  it('pending keeps old authoritative; new anchor first commits authoritative; never the bounded 1/1 fallback', async () => {
    act(() => {
      ;(store as any).dispatch({ type: 'ordertest/seed', payload: [assistantSeed('u1')] })
    })
    // Genuine 5-turn topic; old anchor u1 (5/5 authoritative). Cache holds
    // the exact 3-key shape (LOCK-001 rejects extra resolver roots).
    setCachedContextClosure(TOPIC_ID, toCacheEntry(closureFor(TOPIC_ID, 'u1', 5, 5)))

    // Bounded loaded viewport holds only the newest turn: with the new anchor
    // u4 but no cache, Chat's fallback would derive the characteristic 1/1.
    const boundedNewestOnly = turnMessages(TOPIC_ID, 5, 5)
    const committed: string[] = []
    const updateSettings = (settings: any) => {
      ;(store as any).dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId: ASSISTANT_ID, settings }
      })
    }

    // Resolver will return the authoritative new-anchor closure (u4, 2/5).
    const authoritative = closureFor(TOPIC_ID, 'u4', 5, 2)
    let resolve!: (v: unknown) => void
    mocks.resolveContextClosure.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res
        })
    )

    const staticAssistant = assistantSeed('u1')
    const { result } = renderHook(() => useContextWindowAnchor(staticAssistant, TOPIC_ID, [], updateSettings as any))

    render(
      <Provider store={store as any}>
        <Probe topicId={TOPIC_ID} boundedMessages={boundedNewestOnly as any} committed={committed} />
      </Provider>
    )

    // Initial committed render is the old authoritative projection (5/5).
    await waitFor(() => expect(screen.getByTestId('counts').textContent).toBe('5/5'))
    expect(committed[0]).toBe('5/5')
    expect(committed).not.toContain('1/1')

    // Start re-anchor; resolver pending → no new anchor, no new cache.
    let pending!: Promise<void>
    act(() => {
      pending = result.current.onReanchor()
    })
    await waitFor(() => expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('counts').textContent).toBe('5/5')
    expect(committed).not.toContain('1/1')

    // Resolve: blocks+cache+anchor publish in one synchronous boundary (no
    // await between), so the next committed render already carries cache.
    await act(async () => {
      resolve(authoritative)
      await pending
    })

    await waitFor(() => expect(screen.getByTestId('counts').textContent).toBe('2/5'))
    expect(screen.getByTestId('counts').textContent).toBe('2/5')
    expect(committed).not.toContain('1/1')
    expect(committed[0]).toBe('5/5')
    expect(committed[committed.length - 1]).toBe('2/5')
  })

  it('broken publish (anchor visible before cache) commits the 1/1 fallback — harness sensitivity proof', async () => {
    act(() => {
      ;(store as any).dispatch({ type: 'ordertest/seed', payload: [assistantSeed('u1')] })
    })
    setCachedContextClosure(TOPIC_ID, toCacheEntry(closureFor(TOPIC_ID, 'u1', 5, 5)))
    const boundedNewestOnly = turnMessages(TOPIC_ID, 5, 5)
    const committed: string[] = []

    render(
      <Provider store={store as any}>
        <Probe topicId={TOPIC_ID} boundedMessages={boundedNewestOnly as any} committed={committed} />
      </Provider>
    )
    await waitFor(() => expect(screen.getByTestId('counts').textContent).toBe('5/5'))

    // Simulate the bug: anchor dispatch becomes visible while the new cache
    // is still missing (an await/reorder between persist and cache).
    await act(async () => {
      ;(store as any).dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId: ASSISTANT_ID,
          settings: { contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u4' } } }
        }
      })
    })
    await waitFor(() => expect(screen.getByTestId('counts').textContent).toBe('1/1'))
    expect(committed).toContain('1/1')

    // Late cache arrival repairs to authoritative — but the jitter already happened.
    await act(async () => {
      setCachedContextClosure(TOPIC_ID, toCacheEntry(closureFor(TOPIC_ID, 'u4', 5, 2)))
      ;(store as any).dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId: ASSISTANT_ID,
          settings: { contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u4' } } }
        }
      })
    })
    await waitFor(() => expect(screen.getByTestId('counts').textContent).toBe('2/5'))
    expect(committed).toContain('1/1')
  })
})
