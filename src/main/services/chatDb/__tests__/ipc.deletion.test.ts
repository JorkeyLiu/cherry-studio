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

// Mock ChatDbService to return a controllable aggregate
const { mockAggregateHardDelete, mockAggregatePurge, mockAggregateEmpty, mockAggregateReset, mockIsInitialised } =
  vi.hoisted(() => ({
    mockAggregateHardDelete: vi.fn(() => ({
      ok: true as const,
      value: { affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: ['t-1'] }
    })),
    mockAggregatePurge: vi.fn(() => ({
      ok: true as const,
      value: { affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: ['t-p1', 't-p2'] }
    })),
    mockAggregateEmpty: vi.fn(() => ({
      ok: true as const,
      value: { affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: ['t-e1'] }
    })),
    mockAggregateReset: vi.fn(() => ({
      ok: true as const,
      value: {
        cleanup: { affectedFileIds: [], remainingReferenceCounts: {} },
        replacementTopic: { id: 't-new', name: 'new' },
        deletedTopicIds: ['t-old']
      }
    })),
    mockIsInitialised: vi.fn(() => true)
  }))

vi.mock('../ChatDbAggregateService', () => ({
  ChatDbAggregateService: vi.fn(function () {
    return {
      hardDeleteTopic: mockAggregateHardDelete,
      purgeExpiredTopics: mockAggregatePurge,
      emptyTrashTopics: mockAggregateEmpty,
      resetAssistantTopics: mockAggregateReset
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

describe('ChatDb deletion broadcast', () => {
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
  })

  afterEach(() => {
    if (disposer) disposer()
  })

  it('hardDelete broadcasts to all windows including sender (all-window delivery)', async () => {
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_HardDeleteTopic)!
    const event = { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent
    const result = await handler(event, { topicId: 't-1' })
    expect(result.ok).toBe(true)
    expect(mockWin2Send).toHaveBeenCalledWith(IpcChannel.ChatDb_TopicDeleted, { deletedTopicIds: ['t-1'] })
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_TopicDeleted, { deletedTopicIds: ['t-1'] })
  })

  it('purgeExpired broadcasts bulk ids', async () => {
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_PurgeExpiredTopics)!
    const event = { sender: { id: 99 } } as unknown as Electron.IpcMainInvokeEvent
    const result = await handler(event, { cutoffTimestamp: new Date().toISOString() })
    expect(result.ok).toBe(true)
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_TopicDeleted, { deletedTopicIds: ['t-p1', 't-p2'] })
    expect(mockWin2Send).toHaveBeenCalledWith(IpcChannel.ChatDb_TopicDeleted, { deletedTopicIds: ['t-p1', 't-p2'] })
  })

  it('emptyTrash broadcasts to all windows including sender', async () => {
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_EmptyTrashTopics)!
    const event = { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent
    const result = await handler(event, { assistantId: 'asst-x' })
    expect(result.ok).toBe(true)
    expect(mockWin2Send).toHaveBeenCalledWith(IpcChannel.ChatDb_TopicDeleted, { deletedTopicIds: ['t-e1'] })
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_TopicDeleted, { deletedTopicIds: ['t-e1'] })
  })

  it('resetAssistant broadcasts deleted ids excluding replacement to all windows including sender', async () => {
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_ResetAssistantTopics)!
    const event = { sender: { id: 2 } } as unknown as Electron.IpcMainInvokeEvent
    const result = await handler(event, { assistantId: 'a1', replacementTopicId: 't-new' })
    expect(result.ok).toBe(true)
    expect(mockWin1Send).toHaveBeenCalledWith(IpcChannel.ChatDb_TopicDeleted, { deletedTopicIds: ['t-old'] })
    expect(mockWin2Send).toHaveBeenCalledWith(IpcChannel.ChatDb_TopicDeleted, { deletedTopicIds: ['t-old'] })
  })

  it('does not broadcast on empty deletedTopicIds', async () => {
    mockAggregateHardDelete.mockReturnValueOnce({
      ok: true as const,
      value: { affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: [] }
    })
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_HardDeleteTopic)!
    const event = { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent
    const result = await handler(event, { topicId: 'nonexistent' })
    expect(result.ok).toBe(true)
    expect(mockWin1Send).not.toHaveBeenCalled()
    expect(mockWin2Send).not.toHaveBeenCalled()
  })

  it('does not broadcast on validation failure', async () => {
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_HardDeleteTopic)!
    const event = { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent
    const result = await handler(event, {} as unknown)
    expect(result.ok).toBe(false)
    expect(mockWin1Send).not.toHaveBeenCalled()
    expect(mockWin2Send).not.toHaveBeenCalled()
  })

  it('does not broadcast on aggregate failure', async () => {
    mockAggregateHardDelete.mockReturnValueOnce({
      ok: false as const,
      error: { code: 'STORAGE_ERROR', message: 'fail', retryable: false }
    } as unknown as ReturnType<typeof mockAggregateHardDelete>)
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_HardDeleteTopic)!
    const event = { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent
    const result = await handler(event, { topicId: 't-1' })
    expect(result.ok).toBe(false)
    expect(mockWin1Send).not.toHaveBeenCalled()
    expect(mockWin2Send).not.toHaveBeenCalled()
  })
})
