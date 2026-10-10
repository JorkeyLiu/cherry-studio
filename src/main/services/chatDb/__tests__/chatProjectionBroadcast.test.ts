import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetAllWindows, mockWin1Send, mockWin2Send } = vi.hoisted(() => {
  const send1 = vi.fn()
  const send2 = vi.fn()
  const getAll = vi.fn(() => [
    {
      isDestroyed: () => false,
      webContents: { id: 11, isDestroyed: () => false, send: send1 }
    } as unknown as Electron.BrowserWindow,
    {
      isDestroyed: () => false,
      webContents: { id: 22, isDestroyed: () => false, send: send2 }
    } as unknown as Electron.BrowserWindow
  ])
  return { mockGetAllWindows: getAll, mockWin1Send: send1, mockWin2Send: send2 }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mockGetAllWindows }
}))

vi.mock('@logger', () => ({ loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))

import { IpcChannel } from '@shared/IpcChannel'

import { broadcastChatProjectionInvalidation } from '../chatProjectionBroadcast'

describe('chatProjectionBroadcast origin exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { id: 11, isDestroyed: () => false, send: mockWin1Send }
      } as unknown as Electron.BrowserWindow,
      {
        isDestroyed: () => false,
        webContents: { id: 22, isDestroyed: () => false, send: mockWin2Send }
      } as unknown as Electron.BrowserWindow
    ])
  })

  it('broadcasts to every window without exclusion', () => {
    broadcastChatProjectionInvalidation({
      assistantIds: ['a-1'],
      topicIds: ['t-1'],
      branchIds: [],
      reason: 'sync-incremental'
    })
    expect(mockWin1Send).toHaveBeenCalledWith(
      IpcChannel.ChatDb_ChatProjectionInvalidated,
      expect.objectContaining({ assistantIds: ['a-1'] })
    )
    expect(mockWin2Send).toHaveBeenCalledWith(
      IpcChannel.ChatDb_ChatProjectionInvalidated,
      expect.objectContaining({ assistantIds: ['a-1'] })
    )
  })

  it('excludes the origin webContents while others still receive', () => {
    broadcastChatProjectionInvalidation(
      { assistantIds: ['a-1'], topicIds: ['t-1'], branchIds: [], reason: 'local-commit' },
      { excludeWebContentsId: 11 }
    )
    expect(mockWin1Send).not.toHaveBeenCalled()
    expect(mockWin2Send).toHaveBeenCalledWith(
      IpcChannel.ChatDb_ChatProjectionInvalidated,
      expect.objectContaining({ reason: 'local-commit' })
    )
  })

  it('failed/empty scopes never emit', () => {
    broadcastChatProjectionInvalidation({ assistantIds: [], topicIds: [], branchIds: [], reason: 'sync-baseline' })
    expect(mockWin1Send).not.toHaveBeenCalled()
    expect(mockWin2Send).not.toHaveBeenCalled()
  })
})
