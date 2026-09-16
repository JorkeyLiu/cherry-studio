import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

const { mockIsInitialised, mockGetDatabase, mockGetSqlite, handlers } = vi.hoisted(() => ({
  mockIsInitialised: vi.fn(),
  mockGetDatabase: vi.fn(),
  mockGetSqlite: vi.fn(),
  handlers: new Map<string, (...args: any[]) => any>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../index', () => ({
  chatDbService: {
    isInitialised: (...args: unknown[]) => mockIsInitialised(...args),
    getDatabase: (...args: unknown[]) => mockGetDatabase(...args),
    getSqlite: (...args: unknown[]) => mockGetSqlite(...args)
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }
}))

import { IpcChannel } from '@shared/IpcChannel'

import { registerChatDbIpc } from '../ipc'

describe('chatdb:resolve-context-closure IPC boundary', () => {
  let disposer: (() => void) | undefined

  beforeEach(() => {
    handlers.clear()
    mockIsInitialised.mockReset()
    mockGetDatabase.mockReset()
    mockGetSqlite.mockReset()
  })

  afterEach(() => {
    try {
      disposer?.()
    } catch {}
    disposer = undefined
    mockIsInitialised.mockReturnValue(false)
  })

  it('rejects malformed resolver requests at the boundary', async () => {
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_ResolveContextClosure)!
    expect(handler).toBeDefined()
    const missingIntent = await handler({}, { topicId: 't-1' } as any)
    expect(missingIntent.ok).toBe(false)
    expect(missingIntent.error.code).toBe('VALIDATION_ERROR')
    const badMove = await handler({}, { topicId: 't-1', intent: 'move' } as any)
    expect(badMove.ok).toBe(false)
    expect(badMove.error.code).toBe('VALIDATION_ERROR')
    const unknown = await handler({}, { topicId: 't-1', intent: 'establish', contextCount: 2, extra: 1 } as any)
    expect(unknown.ok).toBe(false)
    expect(unknown.error.code).toBe('VALIDATION_ERROR')
  })

  it('valid request reaches unavailable-database path', async () => {
    mockIsInitialised.mockReturnValue(false)
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_ResolveContextClosure)!
    const result = await handler({}, { topicId: 't-1', intent: 'establish', contextCount: 2 })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('UNAVAILABLE')
  })

  it('anchor establish validates boundary and returns exact two-key response with no hydration', async () => {
    const betterSqlite3Mod = await import('better-sqlite3')
    const Database: any = (betterSqlite3Mod as any).default ?? betterSqlite3Mod
    const { drizzle } = await import('drizzle-orm/better-sqlite3')
    const { runMigrations } = await import('../migration')
    const schema = await import('../schema')
    const { validateChatDbRequest, validateChatDbResult } = await import('@shared/chatDb')
    const { MessagesRepository } = await import('../repository/MessagesRepository')
    const { BlocksRepository } = await import('../repository/BlocksRepository')
    const tmpDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-ipc-resolve-anchor-'))
    const sqlite = new Database(realPath.join(tmpDir, 'test.db'))
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)
    const { ChatDbAggregateService: Agg } = await import('../ChatDbAggregateService')
    const agg = new Agg(db, sqlite)
    const topicId = 't-ipc-resolve-anchor'
    for (const id of ['u1', 'u2']) {
      agg.appendMessage(
        topicId,
        { id, topicId, role: 'user', content: id, status: 'success', createdAt: new Date().toISOString() } as any,
        [
          {
            id: `b-${id}`,
            messageId: id,
            type: 'main_text',
            content: 'b',
            status: 'success',
            createdAt: new Date().toISOString()
          } as any
        ]
      )
    }
    const request = { topicId, intent: 'establish', contextCount: 1, detail: 'anchor' } as const
    expect(() => validateChatDbRequest('chatdb:resolve-context-closure', request)).not.toThrow()
    const listSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic').mockImplementation(() => {
      throw new Error('listByTopic must not be called in anchor mode')
    })
    const blocksSpy = vi.spyOn(BlocksRepository.prototype, 'listByMessages').mockImplementation(() => {
      throw new Error('blocks must not be queried in anchor mode')
    })
    try {
      mockIsInitialised.mockReturnValue(true)
      mockGetDatabase.mockReturnValue(db as any)
      mockGetSqlite.mockReturnValue(sqlite)
      disposer = registerChatDbIpc()
      const handler = handlers.get(IpcChannel.ChatDb_ResolveContextClosure)!
      expect(handler).toBeDefined()
      const result = await handler({}, request)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(Object.keys(result.value).sort()).toEqual(['changed', 'resolvedAnchorGroupKey'])
        expect('messages' in (result.value as Record<string, unknown>)).toBe(false)
        expect('blocks' in (result.value as Record<string, unknown>)).toBe(false)
        expect('closure' in (result.value as Record<string, unknown>)).toBe(false)
        expect(result.value.resolvedAnchorGroupKey).toBe('u2')
        expect(result.value.changed).toBe(true)
        expect(() => validateChatDbResult('chatdb:resolve-context-closure', result)).not.toThrow()
      }
      expect(listSpy).not.toHaveBeenCalled()
      expect(blocksSpy).not.toHaveBeenCalled()
    } finally {
      listSpy.mockRestore()
      blocksSpy.mockRestore()
    }
    try {
      // One latest window through the same request/handler/result validation boundary.
      // Full window reads hydrate blocks; anchor mode above must not.
      const hydrateSpy = vi.spyOn(BlocksRepository.prototype, 'listByMessages')
      try {
        const windowRequest = { kind: 'latest', topicId, limit: 10 } as const
        expect(() => validateChatDbRequest('chatdb:fetch-messages-window', windowRequest)).not.toThrow()
        const windowHandler = handlers.get(IpcChannel.ChatDb_FetchMessagesWindow)!
        expect(windowHandler).toBeDefined()
        const windowResult = await windowHandler({}, windowRequest)
        expect(windowResult.ok).toBe(true)
        if (windowResult.ok) {
          expect(windowResult.value.window.kind).toBe('latest')
          expect(windowResult.value.window.completeness).toBe('window')
          expect(windowResult.value.window.topicId).toBe(topicId)
          expect(() => validateChatDbResult('chatdb:fetch-messages-window', windowResult)).not.toThrow()
        }
        expect(hydrateSpy).toHaveBeenCalled()
      } finally {
        hydrateSpy.mockRestore()
      }
    } finally {
      try {
        sqlite.close()
      } catch {}
      realFs.rmSync(tmpDir, { recursive: true, force: true })
      mockIsInitialised.mockReturnValue(false)
    }
  })

  it('initialized-db path validates a real resolver envelope', async () => {
    const betterSqlite3Mod = await import('better-sqlite3')
    const Database: any = (betterSqlite3Mod as any).default ?? betterSqlite3Mod
    const { drizzle } = await import('drizzle-orm/better-sqlite3')
    const { runMigrations } = await import('../migration')
    const schema = await import('../schema')
    const { validateChatDbResult } = await import('@shared/chatDb')
    const tmpDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-ipc-resolve-'))
    const sqlite = new Database(realPath.join(tmpDir, 'test.db'))
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)
    const { ChatDbAggregateService: Agg } = await import('../ChatDbAggregateService')
    const agg = new Agg(db, sqlite)
    const topicId = 't-ipc-resolve'
    agg.appendMessage(
      topicId,
      { id: 'u1', topicId, role: 'user', content: 'u1', status: 'success', createdAt: new Date().toISOString() } as any,
      [
        {
          id: 'b-u1',
          messageId: 'u1',
          type: 'main_text',
          content: 'b',
          status: 'success',
          createdAt: new Date().toISOString()
        } as any
      ]
    )
    mockIsInitialised.mockReturnValue(true)
    mockGetDatabase.mockReturnValue(db as any)
    mockGetSqlite.mockReturnValue(sqlite)
    disposer = registerChatDbIpc()
    const handler = handlers.get(IpcChannel.ChatDb_ResolveContextClosure)!
    const result = await handler({}, { topicId, intent: 'establish', contextCount: 1 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.resolvedAnchorGroupKey).toBe('u1')
      expect(result.value.closure.completeness).toBe('context-closure')
      expect(() => validateChatDbResult('chatdb:resolve-context-closure', result)).not.toThrow()
    }
    try {
      sqlite.close()
    } catch {}
    realFs.rmSync(tmpDir, { recursive: true, force: true })
    mockIsInitialised.mockReturnValue(false)
  })
})
