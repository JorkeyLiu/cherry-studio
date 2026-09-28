/**
 * insertMessagesThunk — S6.2c-2 primary anchor path regression
 *
 * Verifies:
 * - thunk sends stable afterMessageId, no insertIndex/sortOrder numeric index to Main
 * - calls insertMessagesAfterAnchor once with batch entries (user+assistant)
 * - fails closed: no Redux dispatch if Main fails
 * - consumes the authoritative response (canonical wire + placement +
 *   mutability delta) via one atomic apply action, never local splices
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
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'upsertManyBlocks', payload: p })),
    applyInserted: vi.fn((p: unknown) => ({ type: 'applyInsertedMessagesAfterAnchor', payload: p })),
    insertMessageAtIndex: vi.fn((p: unknown) => ({ type: 'insertMessageAtIndex', payload: p })),
    addMessage: vi.fn((p: unknown) => ({ type: 'addMessage', payload: p }))
  }
}))

function authoritativeResult() {
  return {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    topicId: 't-1',
    branchId: null,
    afterMessageId: 'm-anchor',
    insertedMessages: [
      { id: 'm-u', topicId: 't-1', role: 'user', blocks: ['b-u'] },
      { id: 'm-a', topicId: 't-1', role: 'assistant', blocks: ['b-a'] }
    ],
    insertedBlocks: [
      { id: 'b-u', messageId: 'm-u' },
      { id: 'b-a', messageId: 'm-a' }
    ],
    insertedMessageIds: ['m-u', 'm-a'],
    patchedMessageIds: [],
    beforeMessageId: 'm-anchor',
    nextMessageId: 'm-next',
    mutableMessageIds: ['m-u', 'm-a']
  }
}

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
    upsertManyBlocks: mocks.upsertManyBlocks
  }
})
vi.mock('@renderer/store/newMessage', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      applyInsertedMessagesAfterAnchor: mocks.applyInserted,
      insertMessageAtIndex: mocks.insertMessageAtIndex,
      addMessage: mocks.addMessage
    },
    selectLoadedMessagesForTopic: vi.fn(() => [
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
    mocks.insertMessagesAfterAnchor.mockResolvedValue(authoritativeResult())
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
    // No positional legacy path remains: the legacy thunk symbol is absent and
    // the primary path never passes a numeric insertIndex to Main.
    expect(src).not.toContain('insertMessagesThunkLegacy')
    expect(segment).not.toMatch(/saveMessageAndBlocksToDB\(topicId,\s*userMessage,\s*\[userBlock\],\s*insertIndex/)
    expect(segment).not.toMatch(/appendMessage\(topicId,\s*userMessage/)
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
    // Canonical blocks published via one batch action (no local stub guessing).
    expect(mocks.upsertManyBlocks).toHaveBeenCalledOnce()
    // Single atomic order + capability action with authoritative placement.
    expect(mocks.applyInserted).toHaveBeenCalledOnce()
    const payload = mocks.applyInserted.mock.calls[0][0] as {
      topicId: string
      insertedMessageIds: string[]
      beforeMessageId: string | null
      nextMessageId: string | null
      mutableMessageIds: string[]
    }
    expect(payload.topicId).toBe('t-1')
    expect(payload.insertedMessageIds).toEqual(['m-u', 'm-a'])
    expect(payload.beforeMessageId).toBe('m-anchor')
    expect(payload.nextMessageId).toBe('m-next')
    expect(payload.mutableMessageIds).toEqual(['m-u', 'm-a'])
    // No local splice guessing remains.
    expect(mocks.insertMessageAtIndex).not.toHaveBeenCalled()
    expect(mocks.addMessage).not.toHaveBeenCalled()
    // datasource dispatches updateTopicUpdatedAt exactly once; thunk must not dispatch it again
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')
    )
    const primaryThunk = src.slice(
      src.indexOf('export const insertMessagesThunk'),
      src.indexOf('export const branchMessagesToTopicThunk')
    )
    // Should not contain explicit updateTopicUpdatedAt dispatch in primary thunk
    expect(primaryThunk).not.toContain('updateTopicUpdatedAt')
    // Must not invent order/capability locally.
    expect(primaryThunk).not.toContain('insertMessageAtIndex')
    expect(primaryThunk).not.toMatch(/mutableMessageIdsByTopic/)
  })

  it('handles anchor outside projection without throwing (applies authority)', async () => {
    // Mock selectLoadedMessagesForTopic to return empty / not containing anchor
    const mod = await import('@renderer/store/newMessage')
    const selectMock = (mod as any).selectLoadedMessagesForTopic
    selectMock.mockReturnValue([{ id: 'different', role: 'user' } as any])

    const { insertMessagesThunk } = await import('../messageThunk')
    const thunk = insertMessagesThunk('t-1', 'm-anchor', 'assistant-1')
    await thunk(mocks.dispatch as any, (() => ({ messages: {}, messageBlocks: {} })) as any)
    expect(mocks.insertMessagesAfterAnchor).toHaveBeenCalledOnce()
    // Authoritative apply still dispatched (reducer owns the conservative fallback).
    expect(mocks.applyInserted).toHaveBeenCalledOnce()
    expect(mocks.dispatch).toHaveBeenCalled()
  })

  it('legacy positional thunk is removed (no positional DB write reachable)', async () => {
    const mod = await import('../messageThunk')
    expect((mod as any).insertMessagesThunkLegacy).toBeUndefined()
    // No positional DB write remains reachable: the legacy source block is gone.
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')
    expect(src).not.toContain('insertMessagesThunkLegacy')
  })
})
