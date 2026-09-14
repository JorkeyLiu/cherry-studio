import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

const { handlers, mockHandle, mockRemoveHandler } = vi.hoisted(() => {
  const h = new Map<string, (...args: any[]) => any>()
  return {
    handlers: h,
    mockHandle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      h.set(channel, handler)
    }),
    mockRemoveHandler: vi.fn((channel: string) => {
      h.delete(channel)
    })
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockHandle,
    removeHandler: mockRemoveHandler
  }
}))

const { mockIsInitialised, mockGetDatabase, mockGetSqlite } = vi.hoisted(() => ({
  mockIsInitialised: vi.fn(() => false),
  mockGetDatabase: vi.fn(),
  mockGetSqlite: vi.fn()
}))

vi.mock('../index', () => ({
  chatDbService: {
    isInitialised: mockIsInitialised,
    getDatabase: mockGetDatabase,
    getSqlite: mockGetSqlite
  }
}))

const { mockIpcCleanTopic } = vi.hoisted(() => ({
  mockIpcCleanTopic: vi.fn()
}))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: mockIpcCleanTopic }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  }
}))

import { resetDiagnosticCounters } from '@shared/diagnostics/sendTiming'
import { IpcChannel } from '@shared/IpcChannel'

import { registerChatDbIpc } from '../ipc'

describe('ChatDb IPC — fetch-whole-topic-snapshot', () => {
  let disposer: () => void

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    mockIsInitialised.mockReturnValue(false)
    resetDiagnosticCounters()
  })

  afterEach(() => {
    if (disposer) disposer()
  })

  it('is registered', () => {
    disposer = registerChatDbIpc()
    expect(handlers.has(IpcChannel.ChatDb_FetchWholeTopicSnapshot)).toBe(true)
    expect(IpcChannel.ChatDb_FetchWholeTopicSnapshot).toBe('chatdb:fetch-whole-topic-snapshot')
  })

  it('rejects invalid request with VALIDATION_ERROR', async () => {
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_FetchWholeTopicSnapshot)!
    const result = await handler({}, {})
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects unknown request keys with VALIDATION_ERROR', async () => {
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_FetchWholeTopicSnapshot)!
    const result = await handler({}, { topicId: 't1', extra: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns UNAVAILABLE when DB is not initialised', async () => {
    mockIsInitialised.mockReturnValue(false)
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_FetchWholeTopicSnapshot)!
    const result = await handler({}, { topicId: 't1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('UNAVAILABLE')
  })
})
