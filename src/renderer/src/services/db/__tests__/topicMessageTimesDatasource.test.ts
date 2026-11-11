/**
 * SqliteMessageDataSource — batched topic message-time read and the message
 * write seam that feeds the runtime topic ordering.
 *
 * Two independent claims:
 *  1. The read is a thin, exact bridge call: `{ topicIds }` in, Main's value
 *     out, no Redux dispatch, no ordering side effect.
 *  2. A successful *message* mutation reports the write to the runtime
 *     ordering service exactly once; a block-only (streaming) write never does.
 */
import { describe, expect, it, vi } from 'vitest'

const { mockDispatch, mockNoteTopicMessageWrite, mockPrepareTopicMessageWrite } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockNoteTopicMessageWrite: vi.fn(),
  mockPrepareTopicMessageWrite: vi.fn(async () => {})
}))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'assistants/updateTopicUpdatedAt', payload: p }))
}))
vi.mock('@renderer/services/topicMessageTimes', () => ({
  noteTopicMessageWrite: mockNoteTopicMessageWrite,
  prepareTopicMessageWrite: mockPrepareTopicMessageWrite
}))

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

function messageTimeValue(topics: Array<{ topicId: string; latestMessageAt: string | null }>) {
  return {
    topics,
    messageTimes: {
      completeness: 'topic-activity' as const,
      requestedTopicCount: topics.length,
      returnedTopicCount: topics.length
    }
  }
}

describe('SqliteMessageDataSource — topic message-time read', () => {
  it('maps the exact request and returns the value without dispatch or ordering side effect', async () => {
    const api = {
      fetchTopicMessageTimes: vi.fn(async () => ({
        ok: true,
        value: messageTimeValue([{ topicId: 't1', latestMessageAt: '2026-09-01T00:00:00.000Z' }])
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    mockNoteTopicMessageWrite.mockClear()

    const res = await ds.fetchTopicMessageTimes(['t1', 't1', 't2'])

    expect(api.fetchTopicMessageTimes).toHaveBeenCalledOnce()
    expect(api.fetchTopicMessageTimes).toHaveBeenCalledWith({ topicIds: ['t1', 't1', 't2'] })
    expect(res.topics).toEqual([{ topicId: 't1', latestMessageAt: '2026-09-01T00:00:00.000Z' }])
    expect(res.messageTimes.returnedTopicCount).toBe(1)
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(mockNoteTopicMessageWrite).not.toHaveBeenCalled()
  })

  it('throws ChatDbResultError on a failure result and propagates transport rejection', async () => {
    const failingApi = {
      fetchTopicMessageTimes: vi.fn(async () => ({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: 'db busy', retryable: false }
      }))
    } as any
    await expect(new SqliteMessageDataSource(failingApi).fetchTopicMessageTimes(['t1'])).rejects.toBeInstanceOf(
      ChatDbResultError
    )

    const transportApi = {
      fetchTopicMessageTimes: vi.fn(async () => {
        throw new Error('transport fail')
      })
    } as any
    await expect(new SqliteMessageDataSource(transportApi).fetchTopicMessageTimes(['t1'])).rejects.toThrow(
      'transport fail'
    )
  })

  it('throws when the bridge method is not exposed', async () => {
    await expect(new SqliteMessageDataSource({} as any).fetchTopicMessageTimes(['t1'])).rejects.toThrow(
      'ChatDb API unavailable: topic message-time read not exposed'
    )
  })
})

describe('SqliteMessageDataSource — message write seam', () => {
  it('prepares the ordering baseline BEFORE the Main mutation and reports the write after it', async () => {
    const events: string[] = []
    let releaseBaseline: () => void = () => {}
    const pendingBaseline = new Promise<void>((resolve) => {
      releaseBaseline = resolve
    })
    mockPrepareTopicMessageWrite.mockImplementationOnce(async () => {
      events.push('prepare:start')
      await pendingBaseline
      events.push('prepare:done')
    })
    const api = {
      appendMessage: vi.fn(async () => {
        events.push('main-append')
        return { ok: true, value: { messageId: 'm1' } }
      })
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    mockNoteTopicMessageWrite.mockClear()
    mockNoteTopicMessageWrite.mockImplementationOnce(() => {
      events.push('note')
    })

    const write = ds.appendMessage('t1', { id: 'm1' } as any, [])

    // The mutation command must NOT reach Main before the pre-write baseline
    // resolves; only the preparation is in flight.
    await Promise.resolve()
    expect(api.appendMessage).not.toHaveBeenCalled()
    expect(events).toEqual(['prepare:start'])

    releaseBaseline()
    await write

    expect(events).toEqual(['prepare:start', 'prepare:done', 'main-append', 'note'])
    expect(api.appendMessage).toHaveBeenCalledOnce()
    expect(mockNoteTopicMessageWrite).toHaveBeenCalledOnce()
    expect(mockNoteTopicMessageWrite).toHaveBeenCalledWith('t1')
  })

  it('reports a successful message append to the runtime ordering exactly once', async () => {
    const api = {
      appendMessage: vi.fn(async () => ({ ok: true, value: { messageId: 'm1' } }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    mockNoteTopicMessageWrite.mockClear()
    mockPrepareTopicMessageWrite.mockClear()

    await ds.appendMessage('t1', { id: 'm1' } as any, [])

    // The existing Redux timestamp bookkeeping is untouched...
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'assistants/updateTopicUpdatedAt',
      payload: { topicId: 't1' }
    })
    // ...and the ordering service is told about the write, once, after the
    // pre-write preparation for the same topic.
    expect(mockPrepareTopicMessageWrite).toHaveBeenCalledOnce()
    expect(mockPrepareTopicMessageWrite).toHaveBeenCalledWith('t1')
    expect(mockNoteTopicMessageWrite).toHaveBeenCalledOnce()
    expect(mockNoteTopicMessageWrite).toHaveBeenCalledWith('t1')
  })

  it('reports nothing when the mutation fails', async () => {
    const api = {
      appendMessage: vi.fn(async () => ({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: 'db busy', retryable: false }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    mockNoteTopicMessageWrite.mockClear()
    mockPrepareTopicMessageWrite.mockClear()

    await expect(ds.appendMessage('t1', { id: 'm1' } as any, [])).rejects.toBeInstanceOf(ChatDbResultError)
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(mockNoteTopicMessageWrite).not.toHaveBeenCalled()
  })

  it('never reports a block-only (streaming) write', async () => {
    const api = {
      updateSingleBlock: vi.fn(async () => ({ ok: true, value: null }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    mockNoteTopicMessageWrite.mockClear()
    mockPrepareTopicMessageWrite.mockClear()

    await ds.updateSingleBlock('b1', { content: 'streamed chunk' } as any, undefined, undefined, {
      topicId: 't1',
      branchId: null
    })

    expect(mockDispatch).not.toHaveBeenCalled()
    expect(mockNoteTopicMessageWrite).not.toHaveBeenCalled()
    // Streaming blocks are not a message write: no pre-write baseline read.
    expect(mockPrepareTopicMessageWrite).not.toHaveBeenCalled()
  })
})
