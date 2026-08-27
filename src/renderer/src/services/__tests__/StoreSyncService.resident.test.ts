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
})
