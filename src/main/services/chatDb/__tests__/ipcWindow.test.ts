import { validateChatDbRequest } from '@shared/chatDb'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import { IpcChannel } from '@shared/IpcChannel'

describe('IPC window contract — validation and channel', () => {
  it('IpcChannel has ChatDb_FetchMessagesWindow', () => {
    expect(IpcChannel.ChatDb_FetchMessagesWindow).toBe('chatdb:fetch-messages-window')
  })

  it('validateChatDbRequest rejects unknown field via shared validator', () => {
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages-window', {
        kind: 'latest',
        topicId: 't1',
        limit: 10,
        extra: 1
      } as any)
    ).toThrow()
  })

  it('validateChatDbRequest rejects malformed kind', () => {
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'bad', topicId: 't1', limit: 10 } as any)
    ).toThrow()
  })

  it('validateChatDbRequest enforces bounded counts via shared validator (no defaults)', () => {
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1' } as any)
    ).toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages-window', {
        kind: 'around',
        topicId: 't1',
        anchorMessageId: 'm1',
        before: 0,
        after: 10
      } as any)
    ).toThrow()
  })

  it('ipc contract registry includes window channel', async () => {
    const { chatDbContracts } = await import('@shared/chatDb')
    expect(chatDbContracts).toHaveProperty('chatdb:fetch-messages-window')
  })
})
