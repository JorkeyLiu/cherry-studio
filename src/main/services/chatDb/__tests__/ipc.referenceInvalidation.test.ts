/**
 * History-reference invalidation fan-out (Main → renderer).
 *
 * Proves the IPC layer broadcasts `ChatDb_HistoryReferenceInvalidated` with the
 * aggregate `listReferenceTargets` result for every source-mutation lifecycle
 * path (rename, trash, restore, branch removal, hard delete), and never
 * broadcasts for unrelated channels, empty target sets, or failures. The
 * aggregate's transitive `listReferenceTargets` is covered separately in
 * crossTopicReference.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

const { handlers, mockHandle, mockRemoveHandler, mockGetAllWindows, mockWin1Send, mockWin2Send } = vi.hoisted(() => {
  const h = new Map<string, (...args: any[]) => any>()
  const send1 = vi.fn()
  const send2 = vi.fn()
  const getAll = vi.fn(() => [
    {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send: send1 }
    } as unknown as Electron.BrowserWindow,
    {
      isDestroyed: () => false,
      webContents: { id: 2, isDestroyed: () => false, send: send2 }
    } as unknown as Electron.BrowserWindow
  ])
  return {
    handlers: h,
    mockHandle: vi.fn((channel: string, handler: (...args: any[]) => any) => h.set(channel, handler)),
    mockRemoveHandler: vi.fn((channel: string) => h.delete(channel)),
    mockGetAllWindows: getAll,
    mockWin1Send: send1,
    mockWin2Send: send2
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: mockRemoveHandler },
  BrowserWindow: { getAllWindows: mockGetAllWindows }
}))

const {
  mockAggregateUpdateTopicMetadata,
  mockAggregateSoftDelete,
  mockAggregateRestore,
  mockAggregateDeleteBranch,
  mockAggregateHardDelete,
  mockAggregateEnsureTopic,
  mockAggregateListReferenceTargets,
  mockIsInitialised
} = vi.hoisted(() => ({
  mockAggregateUpdateTopicMetadata: vi.fn(() => ({ ok: true as const, value: null })),
  mockAggregateSoftDelete: vi.fn(() => ({ ok: true as const, value: null })),
  mockAggregateRestore: vi.fn(() => ({ ok: true as const, value: null })),
  mockAggregateDeleteBranch: vi.fn(() => ({
    ok: true as const,
    value: { deletedBranchIds: ['branch-1'], deletedMessageIds: [], deletedBlockIds: [] }
  })),
  mockAggregateHardDelete: vi.fn(() => ({
    ok: true as const,
    value: { affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: ['src-1'] }
  })),
  mockAggregateEnsureTopic: vi.fn(() => ({ ok: true as const, value: null })),
  mockAggregateListReferenceTargets: vi.fn(() => ({
    ok: true as const,
    value: { sourceTopicId: 'src-1', targetTopicIds: ['tgt-1', 'tgt-2'] }
  })),
  mockIsInitialised: vi.fn(() => true)
}))

vi.mock('../ChatDbAggregateService', () => ({
  ChatDbAggregateService: vi.fn(function () {
    return {
      updateTopicMetadata: mockAggregateUpdateTopicMetadata,
      softDeleteTopic: mockAggregateSoftDelete,
      restoreTopic: mockAggregateRestore,
      deleteBranch: mockAggregateDeleteBranch,
      hardDeleteTopic: mockAggregateHardDelete,
      ensureTopic: mockAggregateEnsureTopic,
      listReferenceTargets: mockAggregateListReferenceTargets
    }
  })
}))

vi.mock('../index', () => ({
  chatDbService: { isInitialised: mockIsInitialised, getDatabase: vi.fn(), getSqlite: vi.fn() }
}))

vi.mock('../../SpanCacheService', () => ({ spanCacheService: { cleanTopic: vi.fn() } }))
vi.mock('@logger', () => ({ loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))

import { IpcChannel } from '@shared/IpcChannel'

import { registerChatDbIpc } from '../ipc'

describe('ChatDb history-reference invalidation fan-out', () => {
  let disposer: () => void

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    mockGetAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { id: 1, isDestroyed: () => false, send: mockWin1Send }
      } as unknown as Electron.BrowserWindow,
      {
        isDestroyed: () => false,
        webContents: { id: 2, isDestroyed: () => false, send: mockWin2Send }
      } as unknown as Electron.BrowserWindow
    ])
    mockAggregateListReferenceTargets.mockReturnValue({
      ok: true as const,
      value: { sourceTopicId: 'src-1', targetTopicIds: ['tgt-1', 'tgt-2'] }
    })
  })

  afterEach(() => {
    if (disposer) disposer()
  })

  async function invoke(channel: string, request: unknown): Promise<any> {
    const handler = handlers.get(channel)!
    const event = { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent
    return handler(event, request)
  }

  const expectedPayload = { sourceTopicId: 'src-1', targetTopicIds: ['tgt-1', 'tgt-2'] }

  it('rename (update-topic-metadata) broadcasts the target ids to every window', async () => {
    disposer = registerChatDbIpc()
    const result = await invoke(IpcChannel.ChatDb_UpdateTopicMetadata, { topicId: 'src-1', name: 'Renamed' })
    expect(result.ok).toBe(true)
    expect(mockAggregateListReferenceTargets).toHaveBeenCalledWith('src-1')
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_HistoryReferenceInvalidated, expectedPayload)
    expect(mockWin2Send).toHaveBeenCalledWith(IpcChannel.ChatDb_HistoryReferenceInvalidated, expectedPayload)
  })

  it('trash (soft-delete-topic) broadcasts the target ids', async () => {
    disposer = registerChatDbIpc()
    const result = await invoke(IpcChannel.ChatDb_SoftDeleteTopic, { topicId: 'src-1' })
    expect(result.ok).toBe(true)
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_HistoryReferenceInvalidated, expectedPayload)
  })

  it('restore (restore-topic) broadcasts the target ids', async () => {
    disposer = registerChatDbIpc()
    const result = await invoke(IpcChannel.ChatDb_RestoreTopic, { topicId: 'src-1' })
    expect(result.ok).toBe(true)
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_HistoryReferenceInvalidated, expectedPayload)
  })

  it('branch removal (delete-branch) broadcasts the source topic targets', async () => {
    disposer = registerChatDbIpc()
    const result = await invoke(IpcChannel.ChatDb_DeleteBranch, { topicId: 'src-1', branchId: 'branch-1' })
    expect(result.ok).toBe(true)
    expect(mockAggregateListReferenceTargets).toHaveBeenCalledWith('src-1')
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_HistoryReferenceInvalidated, expectedPayload)
  })

  it('hard delete broadcasts the target ids for the deleted source', async () => {
    disposer = registerChatDbIpc()
    const result = await invoke(IpcChannel.ChatDb_HardDeleteTopic, { topicId: 'src-1' })
    expect(result.ok).toBe(true)
    expect(mockAggregateListReferenceTargets).toHaveBeenCalledWith('src-1')
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_HistoryReferenceInvalidated, expectedPayload)
  })

  it('does not broadcast when no target points at the source (no flood)', async () => {
    mockAggregateListReferenceTargets.mockReturnValue({
      ok: true as const,
      value: { sourceTopicId: 'src-1', targetTopicIds: [] }
    })
    disposer = registerChatDbIpc()
    const result = await invoke(IpcChannel.ChatDb_UpdateTopicMetadata, { topicId: 'src-1', name: 'Renamed' })
    expect(result.ok).toBe(true)
    expect(mockWin1Send).not.toHaveBeenCalled()
    expect(mockWin2Send).not.toHaveBeenCalled()
  })

  it('does not broadcast for an unrelated channel (ensure-topic)', async () => {
    disposer = registerChatDbIpc()
    const result = await invoke(IpcChannel.ChatDb_EnsureTopic, { topicId: 'src-1' })
    expect(result.ok).toBe(true)
    expect(mockAggregateListReferenceTargets).not.toHaveBeenCalled()
    expect(mockWin1Send).not.toHaveBeenCalled()
    expect(mockWin2Send).not.toHaveBeenCalled()
  })

  it('does not broadcast on a failed source mutation', async () => {
    mockAggregateSoftDelete.mockReturnValueOnce({
      ok: false as const,
      error: { code: 'STORAGE_ERROR', message: 'fail', retryable: false }
    } as unknown as ReturnType<typeof mockAggregateSoftDelete>)
    disposer = registerChatDbIpc()
    const result = await invoke(IpcChannel.ChatDb_SoftDeleteTopic, { topicId: 'src-1' })
    expect(result.ok).toBe(false)
    expect(mockWin1Send).not.toHaveBeenCalled()
    expect(mockWin2Send).not.toHaveBeenCalled()
  })
})
