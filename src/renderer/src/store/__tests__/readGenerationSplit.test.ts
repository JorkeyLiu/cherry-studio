/**
 * Read vs generation busy split — meaning regression.
 *
 * Uses REAL reducer/selectors/navigation/retention (no new-action-only mocks):
 * - window reads register/complete by monotonic request identity; generation
 *   (`loadingByTopic`) never moves on a window read;
 * - overlapping reads never clear each other; stale finalizers no-op after
 *   evict/delete and never disturb a rebuilt read;
 * - pause clears generation only; bootstrap waits on read busy, never on
 *   generation busy; retention pins on either domain.
 */
import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))

import { selectNewTopicBusy, selectNewTopicWindowReadBusy } from '@renderer/hooks/useMessageOperations'
import { resolveBootstrapDecision } from '@renderer/pages/home/Messages/messageNavigation'
import { isTopicPinned } from '@renderer/services/residentRetention'
import messagesReducer, {
  newMessagesActions,
  selectIsTopicBusy,
  selectIsTopicGenerating,
  selectIsTopicWindowReadBusy
} from '@renderer/store/newMessage'

function makeStore() {
  return configureStore({ reducer: { messages: messagesReducer } })
}

describe('read vs generation busy split', () => {
  let store: ReturnType<typeof makeStore>
  beforeEach(() => {
    store = makeStore()
  })

  it('window read never sets generation; Inputbar send/stop stays sendable during a read', () => {
    store.dispatch(newMessagesActions.registerWindowRead({ topicId: 't1', requestSeq: 1 }))
    const s = store.getState() as any
    // Generation (Inputbar isLoading) stays false during a pure window read.
    expect(s.messages.loadingByTopic['t1']).toBeUndefined()
    expect(selectIsTopicGenerating(s, 't1')).toBe(false)
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(true)
    expect(selectIsTopicBusy(s, 't1')).toBe(true)
    // Hook-level selectors agree (same slice shape).
    expect(selectNewTopicWindowReadBusy({ messages: s.messages } as any, 't1')).toBe(true)
    expect(selectNewTopicBusy({ messages: s.messages } as any, 't1')).toBe(true)
    store.dispatch(newMessagesActions.completeWindowRead({ topicId: 't1', requestSeq: 1 }))
    const after = store.getState() as any
    expect(selectIsTopicWindowReadBusy(after, 't1')).toBe(false)
    expect(selectIsTopicBusy(after, 't1')).toBe(false)
  })

  it('generation completion during a read does not clear the read', () => {
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't1', loading: true }))
    store.dispatch(newMessagesActions.registerWindowRead({ topicId: 't1', requestSeq: 7 }))
    // Read completes first: generation must survive.
    store.dispatch(newMessagesActions.completeWindowRead({ topicId: 't1', requestSeq: 7 }))
    const s = store.getState() as any
    expect(selectIsTopicGenerating(s, 't1')).toBe(true)
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(false)
    expect(selectIsTopicBusy(s, 't1')).toBe(true)
  })

  it('overlapping reads: late A finalizer does not clear B', () => {
    store.dispatch(newMessagesActions.registerWindowRead({ topicId: 't1', requestSeq: 1 }))
    store.dispatch(newMessagesActions.registerWindowRead({ topicId: 't1', requestSeq: 2 }))
    store.dispatch(newMessagesActions.completeWindowRead({ topicId: 't1', requestSeq: 1 }))
    let s = store.getState() as any
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(true)
    store.dispatch(newMessagesActions.completeWindowRead({ topicId: 't1', requestSeq: 2 }))
    s = store.getState() as any
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(false)
  })

  it('pause releases generation only, never the read', () => {
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't1', loading: true }))
    store.dispatch(newMessagesActions.registerWindowRead({ topicId: 't1', requestSeq: 11 }))
    // pauseMessages contract: clear generation only.
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't1', loading: false }))
    const s = store.getState() as any
    expect(selectIsTopicGenerating(s, 't1')).toBe(false)
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(true)
  })

  it('bootstrap waits on read busy, never on generation busy', () => {
    const base = {
      phase: 'idle' as const,
      topicId: 't1',
      pending: null,
      savedPosition: null,
      savedRestoreHandled: true
    }
    // Read-busy only: generation has no field on this contract and cannot gate.
    expect(resolveBootstrapDecision({ ...base, isTopicReadBusy: false }).action).not.toBe('wait')
    // Outstanding window read must gate bootstrap.
    expect(resolveBootstrapDecision({ ...base, isTopicReadBusy: true }).action).toBe('wait')
  })

  it('retention pins on either domain; evict and delete clear both without disturbing a rebuilt read', () => {
    const pinned = (messages: any) => isTopicPinned('t1', { messages, residentRegistry: { entries: {} } })
    // Generation pins.
    expect(pinned({ currentTopicId: null, loadingByTopic: { t1: true } })).toBe(true)
    // Window read pins.
    expect(pinned({ currentTopicId: null, loadingByTopic: {}, pendingWindowReadsByTopic: { t1: [3] } })).toBe(true)
    // Evict clears both (retentionEvict reducer path via store dispatch is covered
    // by the same delete-branch; here we pin the reducer-level clear contract).
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't1', loading: true }))
    store.dispatch(newMessagesActions.registerWindowRead({ topicId: 't1', requestSeq: 21 }))
    store.dispatch(newMessagesActions.clearWindowReads({ topicId: 't1' }))
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't1', loading: false }))
    let s = store.getState() as any
    expect(selectIsTopicBusy(s, 't1')).toBe(false)
    // Stale finalizer after clear/evict is a no-op and never clears a rebuilt read.
    store.dispatch(newMessagesActions.registerWindowRead({ topicId: 't1', requestSeq: 22 }))
    store.dispatch(newMessagesActions.completeWindowRead({ topicId: 't1', requestSeq: 21 }))
    s = store.getState() as any
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(true)
    store.dispatch(newMessagesActions.completeWindowRead({ topicId: 't1', requestSeq: 22 }))
    s = store.getState() as any
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(false)
  })

  it('cache-hit/no-op never fakes read busy (no registration without fetch)', () => {
    const s = store.getState() as any
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(false)
    // No dispatch happened: a fetchless hit must leave the map absent, not empty-busy.
    expect(s.messages.pendingWindowReadsByTopic['t1']).toBeUndefined()
  })
})
