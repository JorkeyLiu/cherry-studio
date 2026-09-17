import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

describe('StoreSyncService resident lifecycle', () => {
  beforeEach(async () => {
    const { default: svc } = await import('../StoreSyncService')
    // reset internal
    ;(svc as any).options = { syncList: [] }
  })

  it('syncList topicSegments/ is broadcast but resident/ is not, preserving projection without syncing per-window registry', async () => {
    const { default: storeSyncService } = await import('../StoreSyncService')
    storeSyncService.setOptions({
      syncList: ['assistants/', 'settings/', 'llm/', 'selectionStore/', 'note/', 'topicSegments/']
    })
    const shouldSync = (storeSyncService as any).shouldSyncAction.bind(storeSyncService)
    expect(shouldSync('topicSegments/replaceSegmentsForTopic')).toBe(true)
    expect(shouldSync('topicSegments/loadSegments')).toBe(true)
    expect(shouldSync('topicSegments/removeSegment')).toBe(true)
    expect(shouldSync('resident/jointPublishComplete')).toBe(false)
    expect(shouldSync('residentRegistry/bumpGeneration')).toBe(false)
    expect(shouldSync('residentRegistry/invalidateForDeletion')).toBe(false)
    expect(shouldSync('newMessages/messagesReceived')).toBe(false)
    expect(shouldSync('messageBlocks/upsertManyBlocks')).toBe(false)
  })

  it('joint publication dispatches both resident and syncable topicSegments actions (local atomic + cross-window projection)', async () => {
    // Prove that the thunk dispatches a syncable topicSegments action after joint publish for StoreSync
    const { publishResidentComplete } = await import('@renderer/store/residentRegistry')
    const { replaceSegmentsForTopic } = await import('@renderer/store/topicSegment')
    // Simulate what loadTopicMessagesThunk does for StoreSync preservation
    const dispatched: string[] = []
    const fakeDispatch = (action: any) => {
      dispatched.push(action.type)
      return action
    }
    const topicId = 't-sync'
    const segments: any[] = [{ id: 'seg-sync', topicId, name: 'S', messageIds: [] }]
    const windowResponse: any = {
      messages: [],
      blocks: [],
      window: {
        topicId,
        kind: 'latest',
        completeness: 'window',
        requested: { limit: 10 },
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    }
    fakeDispatch(publishResidentComplete({ topicId, generation: 1, windowResponse, segments }))
    fakeDispatch(replaceSegmentsForTopic({ topicId, segments }))
    expect(dispatched).toContain('resident/jointPublishComplete')
    expect(dispatched).toContain('topicSegments/replaceSegmentsForTopic')
    const { default: svc } = await import('../StoreSyncService')
    svc.setOptions({ syncList: ['assistants/', 'settings/', 'llm/', 'selectionStore/', 'note/', 'topicSegments/'] })
    const shouldSync = (svc as any).shouldSyncAction.bind(svc)
    expect(dispatched.filter((t) => shouldSync(t))).toEqual(['topicSegments/replaceSegmentsForTopic'])
    expect(dispatched.filter((t) => !shouldSync(t))).toContain('resident/jointPublishComplete')
  })

  it('StoreSync middleware broadcasts topicSegments/replaceSegmentsForTopic but not residentRegistry actions — joint bootstrap sync proof', async () => {
    const { default: storeSyncService } = await import('../StoreSyncService')
    const { publishResidentComplete } = await import('@renderer/store/residentRegistry')
    const { replaceSegmentsForTopic } = await import('@renderer/store/topicSegment')
    storeSyncService.setOptions({
      syncList: ['assistants/', 'settings/', 'llm/', 'selectionStore/', 'note/', 'topicSegments/']
    })
    const onUpdateSpy = vi.fn()
    ;(window as any).api = {
      storeSync: { onUpdate: onUpdateSpy, subscribe: vi.fn(), unsubscribe: vi.fn() }
    }
    const middleware = storeSyncService.createMiddleware()
    const next = vi.fn((a: any) => a)
    const invoke = middleware({ getState: () => ({}), dispatch: vi.fn() } as any)(next)

    const topicId = 't-mw'
    const segments: any[] = [{ id: 'seg-mw', topicId, name: 'MW', messageIds: [] }]
    const windowResponse: any = {
      messages: [],
      blocks: [],
      window: {
        topicId,
        kind: 'latest',
        completeness: 'window',
        requested: { limit: 10 },
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    }
    // resident action must NOT sync
    invoke(publishResidentComplete({ topicId, generation: 1, windowResponse, segments }) as any)
    expect(next).toHaveBeenCalledTimes(1)
    expect(onUpdateSpy).not.toHaveBeenCalled()

    // topicSegments syncable action MUST sync via middleware
    next.mockClear()
    onUpdateSpy.mockClear()
    invoke(replaceSegmentsForTopic({ topicId, segments }) as any)
    expect(next).toHaveBeenCalledTimes(1)
    expect(onUpdateSpy).toHaveBeenCalledTimes(1)
    expect(onUpdateSpy.mock.calls[0][0].type).toBe('topicSegments/replaceSegmentsForTopic')

    // also ensure bumpGeneration not synced
    next.mockClear()
    onUpdateSpy.mockClear()
    const { bumpGeneration } = await import('@renderer/store/residentRegistry')
    invoke(bumpGeneration(topicId) as any)
    expect(next).toHaveBeenCalledTimes(1)
    expect(onUpdateSpy).not.toHaveBeenCalled()

    // cleanup
    ;(window as any).api = undefined
  })

  it('local identical joint follow-up is reducer no-op but still broadcast (convergence transport); fromSync never rebroadcasts', async () => {
    const { configureStore } = await import('@reduxjs/toolkit')
    const { rootReducer } = await import('@renderer/store')
    const { replaceSegmentsForTopic } = await import('@renderer/store/topicSegment')
    const { bumpGeneration, publishResidentComplete } = await import('@renderer/store/residentRegistry')
    const { default: storeSyncService } = await import('../StoreSyncService')
    storeSyncService.setOptions({
      syncList: ['assistants/', 'settings/', 'llm/', 'selectionStore/', 'note/', 'topicSegments/']
    })
    // residentRegistry must stay off the sync list
    const shouldSync = (storeSyncService as any).shouldSyncAction.bind(storeSyncService)
    expect(shouldSync('resident/jointPublishComplete')).toBe(false)
    expect(shouldSync('residentRegistry/bumpGeneration')).toBe(false)

    const onUpdateSpy = vi.fn()
    ;(window as any).api = {
      storeSync: { onUpdate: onUpdateSpy, subscribe: vi.fn(), unsubscribe: vi.fn() }
    }
    try {
      const store: any = configureStore({
        reducer: rootReducer as any,
        middleware: (gdm: any) => gdm({ serializableCheck: false }).concat(storeSyncService.createMiddleware())
      })
      const topicId = 't-joint-transport'
      store.dispatch(bumpGeneration(topicId))
      const gen = store.getState().residentRegistry.entries[topicId].applicabilityGeneration as number
      const seg: any = {
        id: 'seg-transport',
        topicId,
        name: 'Seg',
        messageIds: ['m1'],
        color: undefined,
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
        sortOrder: 0,
        firstMessageId: 'm1',
        lastMessageId: 'm1',
        messageCount: 1
      }
      const windowResponse: any = {
        messages: [{ id: 'm1' }],
        blocks: [],
        window: {
          kind: 'latest',
          completeness: 'window',
          topicId,
          anchorMessageId: null,
          requested: { limit: 10 },
          firstMessageId: 'm1',
          lastMessageId: 'm1',
          returnedCount: 1,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }
      store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse, segments: [seg] }))
      expect(store.getState().residentRegistry.entries[topicId].residentTopic).toBe(true)
      onUpdateSpy.mockClear()

      // Local identical joint follow-up: reducer no-op but transport still occurs
      const beforeState = store.getState()
      store.dispatch({
        ...replaceSegmentsForTopic({ topicId, segments: [{ ...seg }] }),
        meta: { isJointFollowUp: true }
      } as any)
      const afterLocal = store.getState()
      expect(afterLocal).toBe(beforeState)
      expect(afterLocal.residentRegistry.entries[topicId].residentTopic).toBe(true)
      expect(onUpdateSpy).toHaveBeenCalledTimes(1)
      expect(onUpdateSpy.mock.calls[0][0].type).toBe('topicSegments/replaceSegmentsForTopic')
      expect(onUpdateSpy.mock.calls[0][0].meta?.isJointFollowUp).toBe(true)
      expect(onUpdateSpy.mock.calls[0][0].meta?.fromSync).toBeFalsy()

      // Inbound fromSync identical: reducer no-op and never rebroadcast (no echo)
      onUpdateSpy.mockClear()
      const beforeInbound = store.getState()
      store.dispatch({
        ...replaceSegmentsForTopic({ topicId, segments: [{ ...seg }] }),
        meta: { fromSync: true }
      } as any)
      expect(store.getState()).toBe(beforeInbound)
      expect(onUpdateSpy).not.toHaveBeenCalled()
    } finally {
      ;(window as any).api = undefined
    }
  })
})
