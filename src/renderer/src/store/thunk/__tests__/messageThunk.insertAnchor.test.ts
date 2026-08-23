/**
 * insertMessagesThunk — S6.2c-2 primary anchor path regression
 *
 * Verifies:
 * - thunk sends stable afterMessageId, no insertIndex/sortOrder numeric index to Main
 * - calls insertMessagesAfterAnchor once with batch entries (user+assistant)
 * - fails closed: no Redux dispatch if Main fails
 * - dispatches updateTopicUpdatedAt exactly once via datasource (not double dispatch)
 * - handles anchor outside projection (no throw)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertMessagesAfterAnchor: vi.fn(),
    appendMessage: vi.fn(),
    dispatch: vi.fn(),
    upsertOneBlock: vi.fn((p: unknown) => ({ type: 'upsertOneBlock', payload: p })),
    insertMessageAtIndex: vi.fn((p: unknown) => ({ type: 'insertMessageAtIndex', payload: p })),
    addMessage: vi.fn((p: unknown) => ({ type: 'addMessage', payload: p }))
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    insertMessagesAfterAnchor: mocks.insertMessagesAfterAnchor,
    appendMessage: mocks.appendMessage
  }
}))
vi.mock('@renderer/store/assistants', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'updateTopicUpdatedAt', payload: p })) }
})
vi.mock('@renderer/store/messageBlock', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    upsertOneBlock: mocks.upsertOneBlock,
    upsertManyBlocks: vi.fn((p: any) => ({ type: 'upsertManyBlocks', payload: p }))
  }
})
vi.mock('@renderer/store/newMessage', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      insertMessageAtIndex: mocks.insertMessageAtIndex,
      addMessage: mocks.addMessage
    },
    selectMessagesForTopic: vi.fn(() => [
      { id: 'm-anchor', role: 'user' } as any,
      { id: 'm-next', role: 'assistant' } as any
    ])
  }
})
vi.mock('@renderer/utils', () => ({ uuid: vi.fn(() => `uuid-${Math.random().toString(36).slice(2)}`) }))
vi.mock('i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, t: (k: string) => k, default: actual.default }
})

describe('insertMessagesThunk — S6.2c-2 Main-authoritative anchor insert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.insertMessagesAfterAnchor.mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} })
  })

  it('sends stable afterMessageId to Main with batch entries, no numeric index', async () => {
    const { insertMessagesThunk } = await import('../messageThunk')
    const thunk = insertMessagesThunk('t-1', 'm-anchor', 'assistant-1')
    await thunk(
      mocks.dispatch as any,
      (() => ({
        messages: { entities: {}, ids: [] },
        messageBlocks: { entities: {} }
      })) as any
    )

    expect(mocks.insertMessagesAfterAnchor).toHaveBeenCalledOnce()
    const [topicId, afterId, entries] = mocks.insertMessagesAfterAnchor.mock.calls[0]
    expect(topicId).toBe('t-1')
    expect(afterId).toBe('m-anchor')
    expect(entries).toHaveLength(2)
    expect(entries[0].message.role).toBe('user')
    expect(entries[1].message.role).toBe('assistant')
    expect(entries[1].message.askId).toBe(entries[0].message.id)
    // No insertIndex supplied
    expect(entries[0].insertIndex).toBeUndefined()
    // Primary thunk source must not pass numeric insertIndex to Main
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')
    const start = src.indexOf('export const insertMessagesThunk')
    const segment = src.slice(start, start + 8000)
    // Must contain insertMessagesAfterAnchor call
    expect(segment).toContain('insertMessagesAfterAnchor')
    // Must not call saveMessageAndBlocksToDB with insertIndex in primary path (legacy path is separate)
    // Ensure primary path does not contain saveMessageAndBlocksToDB(topicId, userMessage, ..., insertIndex)
    const primaryPart = segment.slice(0, segment.indexOf('insertMessagesThunkLegacy'))
    expect(primaryPart).not.toMatch(/saveMessageAndBlocksToDB\(topicId,\s*userMessage,\s*\[userBlock\],\s*insertIndex/)
    expect(primaryPart).not.toMatch(/appendMessage\(topicId,\s*userMessage/)
  })

  it('dispatches Redux only after Main success (fail closed)', async () => {
    mocks.insertMessagesAfterAnchor.mockRejectedValue(new Error('NOT_FOUND'))
    const { insertMessagesThunk } = await import('../messageThunk')
    const thunk = insertMessagesThunk('t-1', 'm-anchor', 'assistant-1')
    await expect(thunk(mocks.dispatch as any, (() => ({})) as any)).rejects.toThrow()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('on success dispatches blocks and messages, exactly once per topic update via datasource', async () => {
    const { insertMessagesThunk } = await import('../messageThunk')
    const thunk = insertMessagesThunk('t-1', 'm-anchor', 'assistant-1')
    await thunk(
      mocks.dispatch as any,
      (() => ({
        messages: { entities: {}, ids: [] },
        messageBlocks: { entities: {} }
      })) as any
    )
    // Two blocks upserted
    expect(mocks.upsertOneBlock).toHaveBeenCalledTimes(2)
    // Two messages inserted (either insertMessageAtIndex or addMessage)
    const totalMsgDispatches = mocks.insertMessageAtIndex.mock.calls.length + mocks.addMessage.mock.calls.length
    expect(totalMsgDispatches).toBe(2)
    // datasource dispatches updateTopicUpdatedAt exactly once; thunk must not dispatch it again
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')
    )
    const primaryThunk = src.slice(
      src.indexOf('export const insertMessagesThunk'),
      src.indexOf('export const insertMessagesThunkLegacy')
    )
    // Should not contain explicit updateTopicUpdatedAt dispatch in primary thunk
    expect(primaryThunk).not.toContain('updateTopicUpdatedAt')
  })

  it('handles anchor outside projection without throwing (appends)', async () => {
    // Mock selectMessagesForTopic to return empty / not containing anchor
    const mod = await import('@renderer/store/newMessage')
    const selectMock = (mod as any).selectMessagesForTopic
    selectMock.mockReturnValue([{ id: 'different', role: 'user' } as any])

    const { insertMessagesThunk } = await import('../messageThunk')
    const thunk = insertMessagesThunk('t-1', 'm-anchor', 'assistant-1')
    await thunk(mocks.dispatch as any, (() => ({ messages: {}, messageBlocks: {} })) as any)
    expect(mocks.insertMessagesAfterAnchor).toHaveBeenCalledOnce()
    // Should have dispatched addMessage fallback
    expect(mocks.dispatch).toHaveBeenCalled()
  })

  it('legacy thunk still exists for compatibility and uses positional logic', async () => {
    const mod = await import('../messageThunk')
    expect(typeof mod.insertMessagesThunkLegacy).toBe('function')
    // Legacy source should contain findIndex and insertIndex
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')
    const legacyStart = src.indexOf('export const insertMessagesThunkLegacy')
    const legacySegment = src.slice(legacyStart, legacyStart + 4000)
    expect(legacySegment).toContain('findIndex')
    expect(legacySegment).toContain('insertIndex')
  })
})
