/**
 * chatProjectionSubscription — hint-only directory reconcile + resident reload.
 *
 * Real Redux store, mocked Main directory read. Proves: a hint carrying 4
 * authoritative topics reconciles a stale Redux-1 nonempty list to the full
 * 4 (PROJ-10, stable-ID replace); the selected topic and message state stay
 * untouched when unaffected; the selected resident topic reloads through the
 * existing windowed thunk when named; stale in-flight reads discard; unknown
 * assistants and import-pending startups never write; authoritative empty
 * never calls find-or-create. Strict same-assistant binding (F1), coarse
 * baseline resident reconcile (F2), window-preserving around reload (F3),
 * branch-scope sibling/ancestor handling (F4), and pre-ready queue/flush
 * (F5) are covered by focused units below.
 */

import type * as ImportProjectionReadiness from '@renderer/services/importProjectionReadiness'
import store from '@renderer/store'
import { updateAssistants } from '@renderer/store/assistants'
import { newMessagesActions } from '@renderer/store/newMessage'
import { branchesReceived } from '@renderer/store/topicBranch'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListLive = vi.fn(async (_assistantId?: unknown): Promise<unknown> => undefined)
const mockEnsure = vi.fn(
  async (_assistantId?: unknown, _candidateTopicId?: unknown, _candidateName?: unknown): Promise<unknown> => undefined
)
const mockFetchWindow = vi.fn(async (_request?: unknown): Promise<unknown> => undefined)
const mockListSegments = vi.fn(async (_topicId?: unknown): Promise<unknown[]> => [])

vi.mock('@renderer/services/db', () => ({
  dbService: {
    listLiveAssistantTopics: (assistantId: string) => mockListLive(assistantId),
    ensureAssistantTopics: (assistantId: string, candidateTopicId: string, candidateName?: string | null) =>
      mockEnsure(assistantId, candidateTopicId, candidateName),
    fetchMessagesWindow: (request: unknown) => mockFetchWindow(request),
    listSegments: (topicId: string) => mockListSegments(topicId)
  }
}))

vi.mock('@renderer/services/importProjectionReadiness', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportProjectionReadiness>()
  return {
    ...actual,
    isImportProjectionReady: () => mockImportReady()
  }
})
const mockImportReady = vi.fn(() => true)

function wire(id: string, assistantId: string): Record<string, unknown> {
  const now = '2026-01-01T00:00:00.000Z'
  return { id, assistantId, name: `Name-${id}`, createdAt: now, updatedAt: now }
}

function topic(id: string, assistantId: string): Record<string, unknown> {
  const now = '2026-01-01T00:00:00.000Z'
  return { id, assistantId, name: `Name-${id}`, createdAt: now, updatedAt: now, messages: [] }
}

async function seedAssistant(assistantId: string, topicIds: string[]): Promise<void> {
  const state = store.getState()
  const base = state.assistants.assistants[0] as unknown as Record<string, unknown>
  const assistant = {
    ...(base as object),
    id: assistantId,
    topics: topicIds.map((id) => topic(id, assistantId))
  }
  store.dispatch(updateAssistants([assistant] as never))
}

function assistantTopics(assistantId: string): string[] {
  const a = (store.getState().assistants.assistants as Array<{ id: string; topics: Array<{ id: string }> }>).find(
    (x) => x.id === assistantId
  )
  return (a?.topics ?? []).map((t) => t.id)
}

function seedMessages(topicId: string, messageIds: string[]): void {
  store.dispatch(
    newMessagesActions.messagesReceived({
      topicId,
      messages: messageIds.map((id) => ({ id, topicId }) as never)
    } as never)
  )
  // messagesReceived sets currentTopicId; restore caller control below.
}

function setKeyvSnapshot(topicId: string, route: string | null, messageId: string | null): void {
  const g = globalThis as unknown as { window?: unknown }
  const w = (g.window ?? {}) as Record<string, unknown>
  const store_map = ((w as { __keyvMap?: Map<string, unknown> }).__keyvMap ??= new Map<string, unknown>())
  const keyv = (w as { keyv?: unknown }).keyv as
    | { get?: (k: string) => unknown; set?: (k: string, v: unknown) => void }
    | undefined
  if (!keyv || typeof keyv.get !== 'function') {
    const map = store_map
    w.keyv = {
      get: (k: string) => map.get(k) ?? null,
      set: (k: string, v: unknown) => {
        map.set(k, v)
      },
      remove: (k: string) => {
        map.delete(k)
      },
      init: async () => {}
    }
    g.window = w as unknown as Window & typeof globalThis
  }
  const routeKey = `topic-${topicId}::${route ?? 'main'}`
  const storageKey = `scroll:${routeKey}`
  const kv = (g.window as Record<string, unknown>).keyv as { set: (k: string, v: unknown) => void }
  if (messageId) {
    kv.set(storageKey, { scrollTop: 100, anchorId: messageId, messageId, intraRowOffset: 0, isAtBottom: false })
  }
}

function clearKeyvSnapshot(topicId: string, route: string | null): void {
  try {
    const w = (globalThis as unknown as { window?: Record<string, unknown> }).window
    const keyv = w?.keyv as { remove?: (k: string) => void } | undefined
    const routeKey = `topic-${topicId}::${route ?? 'main'}`
    keyv?.remove?.(`scroll:${routeKey}`)
  } catch {
    // best-effort
  }
}

function latestWindowResponse(topicId: string, limit: number, ids: string[]): Record<string, unknown> {
  const messages = ids.map((id) => ({ id, topicId }))
  return {
    window: {
      kind: 'latest',
      topicId,
      completeness: 'window',
      requested: { limit },
      returnedCount: messages.length,
      hasMoreBefore: false,
      hasMoreAfter: false,
      firstMessageId: messages.length > 0 ? messages[0].id : null,
      lastMessageId: messages.length > 0 ? messages[messages.length - 1].id : null
    },
    messages,
    blocks: []
  }
}

function aroundWindowResponse(
  topicId: string,
  anchorMessageId: string,
  before: number,
  after: number,
  ids: string[]
): Record<string, unknown> {
  const messages = ids.map((id) => ({ id, topicId }))
  return {
    window: {
      kind: 'around',
      topicId,
      anchorMessageId,
      completeness: 'window',
      requested: { before, after },
      returnedCount: messages.length,
      hasMoreBefore: false,
      hasMoreAfter: false,
      firstMessageId: messages.length > 0 ? messages[0].id : null,
      lastMessageId: messages.length > 0 ? messages[messages.length - 1].id : null
    },
    messages,
    blocks: []
  }
}

describe('chatProjectionSubscription', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockImportReady.mockReturnValue(true)
    mockListSegments.mockResolvedValue([])
    const { unsubscribeChatProjectionEventsForTests } = await import('@renderer/services/chatProjectionSubscription')
    unsubscribeChatProjectionEventsForTests()
    const state = store.getState()
    for (const tid of Object.keys(state.messages.messageIdsByTopic)) {
      const mids = state.messages.messageIdsByTopic[tid]
      if (mids?.length) store.dispatch(newMessagesActions.removeMessages({ topicId: tid, messageIds: mids }))
    }
  })

  it('reconciles a stale Redux-1 list to the full authoritative 4 without touching selection', async () => {
    await seedAssistant('a-proj-1', ['t-stale-1'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-stale-1'))
    mockListLive.mockResolvedValue({
      assistantId: 'a-proj-1',
      topics: [
        wire('t-live-1', 'a-proj-1'),
        wire('t-live-2', 'a-proj-1'),
        wire('t-live-3', 'a-proj-1'),
        wire('t-live-4', 'a-proj-1')
      ]
    })
    // Resident reload path has no anchor (no loaded, no snapshot) — latest fallback fails closed in test env.
    mockFetchWindow.mockRejectedValue(new Error('no window in test'))
    const { consumeChatProjectionHint } = await import('@renderer/services/chatProjectionSubscription')
    await consumeChatProjectionHint({
      assistantIds: ['a-proj-1'],
      topicIds: [],
      branchIds: [],
      reason: 'sync-baseline'
    })
    expect(mockListLive).toHaveBeenCalledWith('a-proj-1')
    expect(assistantTopics('a-proj-1')).toEqual(['t-live-1', 't-live-2', 't-live-3', 't-live-4'])
    // Selection untouched: no hijack-to-first, current topic marker preserved.
    expect(store.getState().messages.currentTopicId).toBe('t-stale-1')
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it('removes a remotely deleted topic from the full read without resurrection', async () => {
    await seedAssistant('a-proj-2', ['t-keep-1', 't-gone-1'])
    mockListLive.mockResolvedValue({ assistantId: 'a-proj-2', topics: [wire('t-keep-1', 'a-proj-2')] })
    mockFetchWindow.mockRejectedValue(new Error('no window in test'))
    const { consumeChatProjectionHint } = await import('@renderer/services/chatProjectionSubscription')
    await consumeChatProjectionHint({
      assistantIds: ['a-proj-2'],
      topicIds: ['t-gone-1'],
      branchIds: [],
      reason: 'sync-incremental'
    })
    expect(assistantTopics('a-proj-2')).toEqual(['t-keep-1'])
    expect(mockEnsure).not.toHaveBeenCalled()
  })

  it('skips unknown assistants and discards stale in-flight reads', async () => {
    await seedAssistant('a-proj-3', ['t-a-1'])
    // First read is slow and stale; the superseding read is fast and fresh.
    mockListLive.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { assistantId: 'a-proj-3', topics: [wire('t-stale-win', 'a-proj-3')] }
    })
    mockListLive.mockImplementationOnce(async () => {
      return { assistantId: 'a-proj-3', topics: [wire('t-fresh-win', 'a-proj-3')] }
    })
    const mod = await import('@renderer/services/chatProjectionSubscription')
    const first = mod.reconcileAssistantDirectory('a-proj-3')
    const second = mod.reconcileAssistantDirectory('a-proj-3')
    await Promise.all([first, second])
    // The stale first response discarded; the fresh second response won.
    expect(assistantTopics('a-proj-3')).toEqual(['t-fresh-win'])
    // Unknown assistant configs stay in their own domain: never read.
    await mod.consumeChatProjectionHint({
      assistantIds: ['a-unknown'],
      topicIds: [],
      branchIds: [],
      reason: 'sync-baseline'
    })
    expect(mockListLive).not.toHaveBeenCalledWith('a-unknown')
  })

  it('construction race: stale inflight directory never drops a locally added selected topic; bounded reread applies full authority', async () => {
    await seedAssistant('a-race', ['t-old'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-old'))
    // First read is slow and stale (pre-commit view); the reread sees the committed full directory.
    mockListLive.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { assistantId: 'a-race', topics: [wire('t-old', 'a-race')] }
    })
    mockListLive.mockImplementationOnce(async () => {
      return { assistantId: 'a-race', topics: [wire('t-old', 'a-race'), wire('t-new', 'a-race')] }
    })
    const mod = await import('@renderer/services/chatProjectionSubscription')
    const pending = mod.reconcileAssistantDirectory('a-race')
    // Local commit + store catalog change lands before the stale response returns
    // (persistence-first production order mirrored: Main already holds t-new per the second mock).
    await new Promise((resolve) => setTimeout(resolve, 5))
    const { addTopic } = await import('@renderer/store/assistants')
    const now = '2026-01-01T00:00:00.000Z'
    store.dispatch(
      addTopic({
        assistantId: 'a-race',
        topic: { id: 't-new', assistantId: 'a-race', name: 'New', createdAt: now, updatedAt: now, messages: [] }
      } as never)
    )
    store.dispatch(newMessagesActions.setCurrentTopicId('t-new'))
    const applied = await pending
    expect(applied).toBe(true)
    // The stale first response was discarded; the bounded reread applied exactly the full authority.
    expect(mockListLive).toHaveBeenCalledTimes(2)
    expect(assistantTopics('a-race').slice().sort()).toEqual(['t-new', 't-old'])
    expect(store.getState().messages.currentTopicId).toBe('t-new')
  })

  it('startup reconcile skips import-pending boots and really-empty lists', async () => {
    await seedAssistant('a-proj-4', ['t-b-1'])
    mockImportReady.mockReturnValueOnce(false)
    const { reconcileNonemptyAssistantDirectoriesAtStartup } = await import(
      '@renderer/services/chatProjectionSubscription'
    )
    const skipped = await reconcileNonemptyAssistantDirectoriesAtStartup()
    expect(skipped).toEqual({ repaired: [] })
    expect(mockListLive).not.toHaveBeenCalled()
    expect(assistantTopics('a-proj-4')).toEqual(['t-b-1'])
  })

  it('invalid hint payloads are discarded without a directory read', async () => {
    await seedAssistant('a-proj-5', ['t-c-1'])
    const { subscribeChatProjectionEvents } = await import('@renderer/services/chatProjectionSubscription')
    let trigger: (e: unknown) => void = () => {}
    ;(globalThis as unknown as { window: unknown }).window = globalThis as unknown as Window & typeof globalThis
    ;(globalThis as unknown as { api: unknown }).api = {
      chatDb: {
        onChatProjectionInvalidated: (cb: (e: unknown) => void) => {
          trigger = cb
          return () => {}
        }
      }
    }
    subscribeChatProjectionEvents()
    trigger({ assistantIds: [], topicIds: [], branchIds: [], reason: 'sync-incremental' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mockListLive).not.toHaveBeenCalled()
    expect(assistantTopics('a-proj-5')).toEqual(['t-c-1'])
    const { unsubscribeChatProjectionEventsForTests } = await import('@renderer/services/chatProjectionSubscription')
    unsubscribeChatProjectionEventsForTests()
  })

  it('F1: rejects a cross-assistant row as a whole without cross-linking', async () => {
    await seedAssistant('a-f1', ['t-f1-keep'])
    mockListLive.mockResolvedValue({
      assistantId: 'a-f1',
      topics: [wire('t-f1-keep', 'a-f1'), { ...wire('t-foreign', 'a-other'), assistantId: 'a-other' }]
    })
    const mod = await import('@renderer/services/chatProjectionSubscription')
    const applied = await mod.reconcileAssistantDirectory('a-f1')
    expect(applied).toBe(false)
    expect(assistantTopics('a-f1')).toEqual(['t-f1-keep'])
  })

  it('F1: rejects a malformed assistant binding (missing/null) rather than merging', async () => {
    await seedAssistant('a-f1b', ['t-f1b-keep'])
    const { assistantId: _omitAssistant, ...noAssistant } = wire('t-f1b-new', 'a-f1b')
    void _omitAssistant
    mockListLive.mockResolvedValueOnce({
      assistantId: 'a-f1b',
      topics: [{ ...(noAssistant as object), id: 't-f1b-new' }]
    })
    const mod = await import('@renderer/services/chatProjectionSubscription')
    expect(await mod.reconcileAssistantDirectory('a-f1b')).toBe(false)
    expect(assistantTopics('a-f1b')).toEqual(['t-f1b-keep'])
    mockListLive.mockResolvedValueOnce({
      assistantId: 'a-f1b',
      topics: [{ ...wire('t-f1b-new', 'a-f1b'), assistantId: null }]
    })
    expect(await mod.reconcileAssistantDirectory('a-f1b')).toBe(false)
    expect(assistantTopics('a-f1b')).toEqual(['t-f1b-keep'])
  })

  it('F2 current-topic reload: precise hint reloads the open resident route once', async () => {
    await seedAssistant('a-f2', ['t-f2-cur'])
    seedMessages('t-f2-cur', ['m-f2-1', 'm-f2-2'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-f2-cur'))
    mockListLive.mockResolvedValue({ assistantId: 'a-f2', topics: [wire('t-f2-cur', 'a-f2')] })
    mockFetchWindow.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string; limit?: number; anchorMessageId?: string; before?: number; after?: number }
      if (r.kind === 'around' && r.anchorMessageId) {
        return aroundWindowResponse('t-f2-cur', r.anchorMessageId, r.before ?? 5, r.after ?? 5, [
          'm-f2-1',
          'm-f2-2',
          'm-f2-3'
        ])
      }
      if (r.kind !== 'latest') throw new Error(`expected latest or around, got ${r.kind}`)
      return latestWindowResponse('t-f2-cur', r.limit ?? 10, ['m-f2-1', 'm-f2-2', 'm-f2-3'])
    })
    const { consumeChatProjectionHint } = await import('@renderer/services/chatProjectionSubscription')
    await consumeChatProjectionHint({
      assistantIds: ['a-f2'],
      topicIds: ['t-f2-cur'],
      branchIds: [],
      reason: 'sync-incremental'
    })
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    expect(store.getState().messages.currentTopicId).toBe('t-f2-cur')
  })

  it('F2 baseline coarse: empty topicIds still reconciles the open route when its assistant is named', async () => {
    await seedAssistant('a-f2c', ['t-f2c-cur'])
    seedMessages('t-f2c-cur', ['m-c-1'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-f2c-cur'))
    mockListLive.mockResolvedValue({ assistantId: 'a-f2c', topics: [wire('t-f2c-cur', 'a-f2c')] })
    mockFetchWindow.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string; limit?: number; anchorMessageId?: string; before?: number; after?: number }
      if (r.kind === 'around' && r.anchorMessageId) {
        return aroundWindowResponse('t-f2c-cur', r.anchorMessageId, r.before ?? 5, r.after ?? 5, ['m-c-1', 'm-c-2'])
      }
      return latestWindowResponse('t-f2c-cur', r.limit ?? 10, ['m-c-1', 'm-c-2'])
    })
    const { consumeChatProjectionHint } = await import('@renderer/services/chatProjectionSubscription')
    await consumeChatProjectionHint({
      assistantIds: ['a-f2c'],
      topicIds: [],
      branchIds: [],
      reason: 'sync-baseline'
    })
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    expect(store.getState().messages.currentTopicId).toBe('t-f2c-cur')
  })

  it('F3 open-route around preserve: snapshot anchor drives an around reload, not latest', async () => {
    await seedAssistant('a-f3', ['t-f3-cur'])
    seedMessages('t-f3-cur', ['m-old-1', 'm-old-2', 'm-old-3'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-f3-cur'))
    setKeyvSnapshot('t-f3-cur', null, 'm-old-1')
    mockListLive.mockResolvedValue({ assistantId: 'a-f3', topics: [wire('t-f3-cur', 'a-f3')] })
    const seen: Array<Record<string, unknown>> = []
    mockFetchWindow.mockImplementation(async (req: unknown) => {
      const r = req as Record<string, unknown>
      seen.push(r)
      if (r.kind !== 'around') throw new Error(`expected around, got ${String(r.kind)}`)
      if ((r as { anchorMessageId?: string }).anchorMessageId !== 'm-old-1') {
        throw new Error(
          `expected snapshot anchor m-old-1, got ${String((r as { anchorMessageId?: unknown }).anchorMessageId)}`
        )
      }
      return aroundWindowResponse('t-f3-cur', 'm-old-1', r.before as number, r.after as number, [
        'm-old-1',
        'm-old-2',
        'm-old-3'
      ])
    })
    const { consumeChatProjectionHint } = await import('@renderer/services/chatProjectionSubscription')
    await consumeChatProjectionHint({
      assistantIds: ['a-f3'],
      topicIds: ['t-f3-cur'],
      branchIds: [],
      reason: 'sync-incremental'
    })
    expect(seen.length).toBe(1)
    expect(seen[0].kind).toBe('around')
    // Route preserved: still the main route, still the same topic.
    expect(store.getState().messages.currentTopicId).toBe('t-f3-cur')
    clearKeyvSnapshot('t-f3-cur', null)
  })

  it('F4 branch scope: proven unrelated sibling skips, ancestor/root/unknown preserve-window reload', async () => {
    await seedAssistant('a-f4', ['t-f4-cur'])
    seedMessages('t-f4-cur', ['m-1'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-f4-cur'))
    store.dispatch(
      branchesReceived({
        topicId: 't-f4-cur',
        branches: [
          { id: 'b-1', topicId: 't-f4-cur', parentBranchId: null, anchorMessageId: 'm-1' } as never,
          { id: 'b-2', topicId: 't-f4-cur', parentBranchId: null, anchorMessageId: 'm-1' } as never,
          { id: 'b-1-1', topicId: 't-f4-cur', parentBranchId: 'b-1', anchorMessageId: 'm-1' } as never
        ]
      })
    )
    const mod = await import('@renderer/services/chatProjectionSubscription')
    const { isCurrentRouteAffectedByBranchHintForTests } = mod
    // Active b-1 vs hinted sibling b-2: proven unrelated → skip.
    expect(isCurrentRouteAffectedByBranchHintForTests('t-f4-cur', 'b-1', ['b-2'])).toBe(false)
    // Active descendant vs hinted ancestor: butterfly → affect.
    expect(isCurrentRouteAffectedByBranchHintForTests('t-f4-cur', 'b-1-1', ['b-1'])).toBe(true)
    // Root change (empty branchIds): affects every route.
    expect(isCurrentRouteAffectedByBranchHintForTests('t-f4-cur', 'b-1', [])).toBe(true)
    // Unknown branch: conservative invalidate.
    expect(isCurrentRouteAffectedByBranchHintForTests('t-f4-cur', 'b-1', ['b-unknown'])).toBe(true)
  })

  it('F5 startup hints: pre-ready hints queue and flush post-rehydrate', async () => {
    await seedAssistant('a-f5', ['t-f5-cur'])
    seedMessages('t-f5-cur', ['m-5-1'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-f5-cur'))
    mockListLive.mockResolvedValue({ assistantId: 'a-f5', topics: [wire('t-f5-cur', 'a-f5')] })
    mockFetchWindow.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string; limit?: number; anchorMessageId?: string; before?: number; after?: number }
      if (r.kind === 'around' && r.anchorMessageId) {
        return aroundWindowResponse('t-f5-cur', r.anchorMessageId, r.before ?? 5, r.after ?? 5, ['m-5-1'])
      }
      return latestWindowResponse('t-f5-cur', r.limit ?? 10, ['m-5-1'])
    })
    const mod = await import('@renderer/services/chatProjectionSubscription')
    // Pre-ready hint coalesces into transient sets without a directory read.
    await mod.consumeChatProjectionHint(
      { assistantIds: ['a-f5'], topicIds: ['t-f5-cur'], branchIds: [], reason: 'sync-baseline' },
      { importReady: () => false }
    )
    expect(mockListLive).not.toHaveBeenCalled()
    expect(mod.getPendingChatProjectionHintForTests()).toEqual({
      assistantIds: ['a-f5'],
      topicIds: ['t-f5-cur'],
      branchIds: []
    })
    // Startup sweep flushes the queued hint: full read + one resident refresh.
    const out = await mod.reconcileNonemptyAssistantDirectoriesAtStartup({ importReady: () => true })
    expect(out.repaired).toContain('a-f5')
    expect(mockListLive).toHaveBeenCalledWith('a-f5')
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    expect(mod.getPendingChatProjectionHintForTests()).toEqual({ assistantIds: [], topicIds: [], branchIds: [] })
  })

  it('PROJ busy defers resident reload but still reconciles directory, flushes once on settle', async () => {
    await seedAssistant('a-busy', ['t-busy-cur'])
    seedMessages('t-busy-cur', ['m-busy-1'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-busy-cur'))
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't-busy-cur', loading: true }))
    mockListLive.mockResolvedValue({ assistantId: 'a-busy', topics: [wire('t-busy-cur', 'a-busy')] })
    mockFetchWindow.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string; limit?: number; anchorMessageId?: string; before?: number; after?: number }
      if (r.kind === 'around' && r.anchorMessageId) {
        return aroundWindowResponse('t-busy-cur', r.anchorMessageId, r.before ?? 5, r.after ?? 5, ['m-busy-1'])
      }
      return latestWindowResponse('t-busy-cur', r.limit ?? 10, ['m-busy-1'])
    })
    const mod = await import('@renderer/services/chatProjectionSubscription')
    await mod.consumeChatProjectionHint({
      assistantIds: ['a-busy'],
      topicIds: ['t-busy-cur'],
      branchIds: [],
      reason: 'sync-incremental'
    })
    // Directory still reconciles while busy; resident forced reload does not run.
    expect(mockListLive).toHaveBeenCalledWith('a-busy')
    expect(mockFetchWindow).not.toHaveBeenCalled()
    expect(mod.getPendingResidentReloadForTests()?.topicId).toBe('t-busy-cur')
    expect(mod.isRequestActiveForTests('t-busy-cur')).toBe(true)
    // Two boomerangs while busy coalesce into one pending entry.
    await mod.consumeChatProjectionHint({
      assistantIds: ['a-busy'],
      topicIds: ['t-busy-cur'],
      branchIds: [],
      reason: 'local-commit'
    })
    expect(mockFetchWindow).not.toHaveBeenCalled()
    expect(mod.getPendingResidentReloadForTests()?.topicId).toBe('t-busy-cur')
    // Settle flushes exactly once for the same route.
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't-busy-cur', loading: false }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    expect(mod.getPendingResidentReloadForTests()).toBeNull()
  })

  it('PROJ route change while busy discards the older pending projection', async () => {
    await seedAssistant('a-route', ['t-old-cur', 't-new-cur'])
    seedMessages('t-old-cur', ['m-old-1'])
    seedMessages('t-new-cur', ['m-new-1'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-old-cur'))
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't-old-cur', loading: true }))
    mockListLive.mockResolvedValue({ assistantId: 'a-route', topics: [wire('t-old-cur', 'a-route')] })
    mockFetchWindow.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string; limit?: number }
      return latestWindowResponse('t-old-cur', r.limit ?? 10, ['m-old-1'])
    })
    const mod = await import('@renderer/services/chatProjectionSubscription')
    await mod.consumeChatProjectionHint({
      assistantIds: ['a-route'],
      topicIds: ['t-old-cur'],
      branchIds: [],
      reason: 'sync-incremental'
    })
    expect(mod.getPendingResidentReloadForTests()?.topicId).toBe('t-old-cur')
    // User moved on before settle: pending must not apply stale to the new route.
    store.dispatch(newMessagesActions.setCurrentTopicId('t-new-cur'))
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't-old-cur', loading: false }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mockFetchWindow).not.toHaveBeenCalled()
    expect(mod.getPendingResidentReloadForTests()).toBeNull()
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't-new-cur', loading: false }))
  })

  it('PROJ idle/unknown loading conservatively reloads immediately (no deferral)', async () => {
    await seedAssistant('a-idle', ['t-idle-cur'])
    seedMessages('t-idle-cur', ['m-idle-1'])
    store.dispatch(newMessagesActions.setCurrentTopicId('t-idle-cur'))
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't-idle-cur', loading: false }))
    mockListLive.mockResolvedValue({ assistantId: 'a-idle', topics: [wire('t-idle-cur', 'a-idle')] })
    mockFetchWindow.mockImplementation(async (req: unknown) => {
      const r = req as { kind: string; limit?: number; anchorMessageId?: string; before?: number; after?: number }
      if (r.kind === 'around' && r.anchorMessageId) {
        return aroundWindowResponse('t-idle-cur', r.anchorMessageId, r.before ?? 5, r.after ?? 5, ['m-idle-1'])
      }
      return latestWindowResponse('t-idle-cur', r.limit ?? 10, ['m-idle-1'])
    })
    const mod = await import('@renderer/services/chatProjectionSubscription')
    await mod.consumeChatProjectionHint({
      assistantIds: ['a-idle'],
      topicIds: ['t-idle-cur'],
      branchIds: [],
      reason: 'sync-incremental'
    })
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    expect(mod.getPendingResidentReloadForTests()).toBeNull()
  })
})
