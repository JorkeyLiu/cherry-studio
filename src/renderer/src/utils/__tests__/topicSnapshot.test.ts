import { describe, expect, it, vi } from 'vitest'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))
vi.mock('@renderer/services/db', () => ({
  dbService: { fetchWholeTopicSnapshot: (...args: unknown[]) => mockFetch(...args) }
}))

import { loadConversationNavigationSnapshot, loadWholeTopicSnapshot } from '../topicSnapshot'

const navSnapshotMeta = {
  completeness: 'whole-topic' as const,
  topicId: 't1',
  firstMessageId: 'u1',
  lastMessageId: 'a1',
  returnedCount: 3,
  foldedMessageIds: ['u2'],
  projection: 'conversation-navigation' as const
}

describe('loadConversationNavigationSnapshot', () => {
  it('requests the narrow projection explicitly and returns narrow rows unchanged', async () => {
    mockFetch.mockReset().mockResolvedValue({
      messages: [
        { id: 'u1', role: 'user', blocks: ['b1', 'b2'] },
        { id: 'a1', role: 'assistant' },
        { id: 'u2', role: 'user', blocks: ['b3'], folded: true }
      ],
      blocks: [
        { id: 'b1', messageId: 'u1', type: 'main_text', content: 'hello' },
        { id: 'b2', messageId: 'u1', type: 'file', content: null, file: { type: 'image', ext: 'png' } },
        { id: 'b3', messageId: 'u2', type: 'main_text', content: 'later' }
      ],
      snapshot: navSnapshotMeta
    })

    const result = await loadConversationNavigationSnapshot('t1', 'br1')

    // The projection is the caller's explicit request; no renderer-side filter.
    expect(mockFetch).toHaveBeenCalledWith('t1', 'br1', 'conversation-navigation')
    expect(result.messages).toEqual([
      { id: 'u1', role: 'user', blocks: ['b1', 'b2'] },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user', blocks: ['b3'], folded: true }
    ])
    expect(result.snapshot).toEqual(navSnapshotMeta)
    // Block lookup is keyed by block id and keeps the narrowed fields only.
    expect(result.blocksById.get('b1')).toEqual({
      id: 'b1',
      messageId: 'u1',
      type: 'main_text',
      content: 'hello'
    })
    expect(result.blocksById.get('b2')).toEqual({
      id: 'b2',
      messageId: 'u1',
      type: 'file',
      content: null,
      file: { type: 'image', ext: 'png' }
    })
    expect([...result.blocksById.keys()]).toEqual(['b1', 'b2', 'b3'])
  })

  it('keeps the whole-route completeness of the returned skeleton (all roles, route order)', async () => {
    mockFetch.mockReset().mockResolvedValue({
      messages: [
        { id: 's0', role: 'system' },
        { id: 'u1', role: 'user', blocks: [] },
        { id: 'a1', role: 'assistant' }
      ],
      blocks: [],
      snapshot: { ...navSnapshotMeta, firstMessageId: 's0', returnedCount: 3 }
    })
    const result = await loadConversationNavigationSnapshot('t1', null)
    expect(mockFetch).toHaveBeenCalledWith('t1', null, 'conversation-navigation')
    expect(result.messages.map((m) => `${m.role}:${m.id}`)).toEqual(['system:s0', 'user:u1', 'assistant:a1'])
    expect(result.blocksById.size).toBe(0)
  })
})

describe('loadWholeTopicSnapshot', () => {
  it('still reads the full snapshot with no projection argument', async () => {
    mockFetch.mockReset().mockResolvedValue({
      messages: [{ id: 'm1', role: 'user', blocks: ['b1'] }],
      blocks: [{ id: 'b1', messageId: 'm1', type: 'file', content: null, file: { id: 'f1', path: '/x' } }],
      snapshot: {
        completeness: 'whole-topic',
        topicId: 't1',
        firstMessageId: 'm1',
        lastMessageId: 'm1',
        returnedCount: 1,
        foldedMessageIds: []
      }
    })
    const result = await loadWholeTopicSnapshot('t1', null)
    expect(mockFetch).toHaveBeenCalledWith('t1', null)
    expect(mockFetch.mock.calls[0]).toHaveLength(2)
    expect(result.messages).toHaveLength(1)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocksById.get('b1')).toEqual(result.blocks[0])
    expect(result.snapshot.completeness).toBe('whole-topic')
  })
})
