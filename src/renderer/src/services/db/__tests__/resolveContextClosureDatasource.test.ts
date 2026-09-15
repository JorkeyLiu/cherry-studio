import { describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'assistants/updateTopicUpdatedAt', payload: p }))
}))

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

describe('SqliteMessageDataSource — resolveContextClosure', () => {
  const resolverResponse = {
    messages: [{ id: 'u2' }, { id: 'u3' }],
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId: 't1',
      anchorGroupKey: 'u2',
      firstMessageId: 'u2',
      lastMessageId: 'u3',
      returnedCount: 2,
      totalTurnCount: 3,
      selectedTurnCount: 2,
      boundaryMessageId: 'u2'
    },
    resolvedAnchorGroupKey: 'u2',
    changed: true
  }

  it('calls api.resolveContextClosure with exact request and returns unwrapped response without dispatch', async () => {
    const api = {
      resolveContextClosure: vi.fn(async () => ({ ok: true, value: resolverResponse }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    const res = await ds.resolveContextClosure({ topicId: 't1', intent: 'establish', contextCount: 2 })
    expect(api.resolveContextClosure).toHaveBeenCalledOnce()
    expect(api.resolveContextClosure).toHaveBeenCalledWith({ topicId: 't1', intent: 'establish', contextCount: 2 })
    expect(res).toEqual(resolverResponse)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('throws ChatDbResultError on NOT_FOUND without dispatch', async () => {
    const api = {
      resolveContextClosure: vi.fn(async () => ({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'missing', retryable: false }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    await expect(
      ds.resolveContextClosure({ topicId: 't1', intent: 'establish', contextCount: 2 })
    ).rejects.toBeInstanceOf(ChatDbResultError)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('propagates transport rejection unchanged', async () => {
    const api = {
      resolveContextClosure: vi.fn(async () => {
        throw new Error('transport fail')
      })
    } as any
    const ds = new SqliteMessageDataSource(api)
    await expect(ds.resolveContextClosure({ topicId: 't1', intent: 'establish', contextCount: 2 })).rejects.toThrow(
      'transport fail'
    )
  })

  it('throws when bridge method is not exposed', async () => {
    const ds = new SqliteMessageDataSource({} as any)
    await expect(ds.resolveContextClosure({ topicId: 't1', intent: 'establish', contextCount: 2 })).rejects.toThrow(
      'ChatDb API unavailable: resolve-context-closure not exposed'
    )
  })
})
