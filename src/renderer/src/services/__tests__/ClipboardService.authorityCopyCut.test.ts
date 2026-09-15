/**
 * ClipboardService copy/cut — authority-complete under windowed loading.
 *
 * A selected answer/message group may straddle the loaded projection. Copy
 * and cut must publish the complete authority group (ordered messages and
 * blocks from the caller-local whole-topic snapshot, never Redux), ordered by
 * authority topic order, with `positionIndex` populated from authority order
 * (wire shape unchanged — no clipboard format migration).
 *
 * Segments use the authority-enriched catalog (`listSegments`): a segment is
 * snapshotted only when ALL its authority message IDs are selected.
 * Snapshot/list failures publish nothing (no partial clipboard) and mutate no
 * loaded projection. Cut publishes only (mode `cut`); source deletion stays
 * at paste time through the semantic transaction.
 */

import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchWholeTopicSnapshot: vi.fn(),
    listSegments: vi.fn(),
    selectLoadedMessagesForTopic: vi.fn(),
    setClipboard: vi.fn((p: unknown) => ({ type: 'clipboard/setClipboard', payload: p })),
    clearClipboard: vi.fn(() => ({ type: 'clipboard/clearClipboard' })),
    executeDeleteMessagesWithDependents: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchWholeTopicSnapshot: mocks.fetchWholeTopicSnapshot,
    listSegments: mocks.listSegments
  }
}))

vi.mock('@renderer/store/clipboard', () => ({
  clearClipboard: mocks.clearClipboard,
  setClipboard: mocks.setClipboard
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    removeMessages: vi.fn((p: unknown) => ({ type: 'newMessages/removeMessages', payload: p }))
  },
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
  removeManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/removeManyBlocks', payload: p })),
  formatCitationsFromBlock: vi.fn(() => [])
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  executeDeleteMessagesWithDependents: mocks.executeDeleteMessagesWithDependents
}))

vi.mock('@renderer/store/topicSegment', () => ({
  addSegment: vi.fn((p: unknown) => ({ type: 'topicSegment/addSegment', payload: p }))
}))

vi.mock('@renderer/store/undoStack', () => ({
  pushUndoAction: vi.fn((p: unknown) => ({ type: 'undoStack/pushUndoAction', payload: p }))
}))

// ── Fixtures ───────────────────────────────────────────────────────────────
// Authority topic order: [u1, a1, a2, u2, s1, t1].
// Group u1 = user u1 + assistants a1/a2 (multi-assistant answer group).
// Loaded windowed projection: [a2, u2] — group u1 straddles it.

const makeMsg = (id: string, role: string, extra: Record<string, unknown> = {}): Message =>
  ({
    id,
    role,
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: [],
    ...extra
  }) as unknown as Message

const makeBlock = (id: string, messageId: string, type: MessageBlockType = MessageBlockType.MAIN_TEXT): MessageBlock =>
  ({
    id,
    messageId,
    type,
    content: `content-${id}`
  }) as unknown as MessageBlock

const u1 = makeMsg('u1', 'user', { blocks: ['bu1'] })
const a1 = makeMsg('a1', 'assistant', { askId: 'u1', blocks: ['ba1'] })
const a2 = makeMsg('a2', 'assistant', { askId: 'u1', blocks: ['ba2'] })
const u2 = makeMsg('u2', 'user', { blocks: ['bu2'] })
const s1 = makeMsg('s1', 'system', { blocks: ['bs1'] })
const t1 = makeMsg('t1', 'tool', { blocks: ['bt1'] })

const authorityMessages = [u1, a1, a2, u2, s1, t1]
const authorityBlocks = [
  makeBlock('bu1', 'u1'),
  makeBlock('ba1', 'a1'),
  makeBlock('ba2', 'a2'),
  makeBlock('bu2', 'u2'),
  makeBlock('bs1', 's1'),
  makeBlock('bt1', 't1')
]

const snapshotMeta = {
  completeness: 'whole-topic' as const,
  topicId: 'topic-1',
  firstMessageId: 'u1',
  lastMessageId: 't1',
  returnedCount: 6
}

const segFullWire = {
  id: 'seg-full',
  topicId: 'topic-1',
  name: 'Full',
  messageIds: ['u1', 'a1', 'a2'],
  color: 'red',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sortOrder: 0,
  firstMessageId: 'u1',
  lastMessageId: 'a2',
  messageCount: 3
}

const segPartWire = {
  id: 'seg-part',
  topicId: 'topic-1',
  name: 'Part',
  messageIds: ['a2', 'u2'],
  color: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sortOrder: 1,
  firstMessageId: 'a2',
  lastMessageId: 'u2',
  messageCount: 2
}

interface StoreState {
  messages: { entities: Record<string, Message>; messageIdsByTopic: Record<string, string[]> }
  messageBlocks: { entities: Record<string, MessageBlock> }
}

let storeState: StoreState

function baseStoreState(): StoreState {
  // Windowed loaded projection: only the tail [a2, u2]; u1/a1 are outside.
  // Loaded blocks likewise cover only loaded members.
  return {
    messages: {
      entities: { a2, u2 },
      messageIdsByTopic: { 'topic-1': ['a2', 'u2'] }
    },
    messageBlocks: {
      entities: Object.fromEntries(authorityBlocks.filter((b) => ['ba2', 'bu2'].includes(b.id)).map((b) => [b.id, b]))
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ClipboardService copy/cut authority-complete (straddling group)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = baseStoreState()
    mocks.fetchWholeTopicSnapshot.mockResolvedValue({
      messages: authorityMessages,
      blocks: authorityBlocks,
      snapshot: snapshotMeta
    })
    mocks.listSegments.mockResolvedValue([segFullWire, segPartWire])
    mocks.selectLoadedMessagesForTopic.mockImplementation((_state: unknown, topicId: string) => {
      const ids = storeState.messages.messageIdsByTopic[topicId] ?? []
      return ids.map((id) => storeState.messages.entities[id]).filter((m): m is Message => !!m)
    })
  })

  it('copy includes outside-loaded siblings + snapshot blocks in authority order while Redux is untouched', async () => {
    const { copyMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()
    const blocksBefore = { ...storeState.messageBlocks.entities }

    const count = await copyMessages(dispatch, 'topic-1', ['u1'])

    expect(count).toBe(3)
    expect(mocks.fetchWholeTopicSnapshot).toHaveBeenCalledExactlyOnceWith('topic-1')
    // Never reads the loaded projection for group/block resolution.
    expect(mocks.selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const action = dispatch.mock.calls[0][0]
    expect(action.type).toBe('clipboard/setClipboard')
    expect(action.payload.mode).toBe('copy')
    expect(action.payload.sourceTopicId).toBe('topic-1')

    // Complete authority group in authority order (u1 was outside-loaded).
    expect(action.payload.items).toHaveLength(1)
    const item = action.payload.items[0]
    expect(item.originalAskId).toBe('u1')
    expect(item.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'a2'])
    // Blocks from the snapshot map in per-message order — bu1/ba1 were absent from Redux.
    expect(item.blocks.map((b) => b.id)).toEqual(['bu1', 'ba1', 'ba2'])
    // Authority order position, wire shape unchanged.
    expect(item.positionIndex).toBe(0)
    expect(Object.keys(item)).toEqual(expect.arrayContaining(['originalAskId', 'messages', 'blocks', 'positionIndex']))

    // Authority segment catalog: seg-full (all members selected) included with
    // authority IDs; seg-part (u2 unselected) excluded.
    expect(action.payload.segmentSnapshots).toHaveLength(1)
    expect(action.payload.segmentSnapshots[0]).toEqual({
      originalSegmentId: 'seg-full',
      name: 'Full',
      color: 'red',
      originalMessageIds: ['u1', 'a1', 'a2']
    })

    // Read-only: loaded Redux blocks/entities unchanged, no projection commits.
    expect(storeState.messageBlocks.entities).toEqual(blocksBefore)
    expect(storeState.messages.messageIdsByTopic['topic-1']).toEqual(['a2', 'u2'])
  })

  it('copy orders multiple reverse-selected groups by authority order with authority positions', async () => {
    const { copyMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()

    const count = await copyMessages(dispatch, 'topic-1', ['u2', 'u1'])

    expect(count).toBe(4)
    const items = dispatch.mock.calls[0][0].payload.items
    expect(items.map((i) => i.originalAskId)).toEqual(['u1', 'u2'])
    expect(items.map((i) => i.positionIndex)).toEqual([0, 3])
    // Both segments fully selected now (u1-group + u2 covers seg-part too).
    const snaps = dispatch.mock.calls[0][0].payload.segmentSnapshots
    expect(snaps.map((s) => s.originalSegmentId).sort()).toEqual(['seg-full', 'seg-part'])
    const part = snaps.find((s) => s.originalSegmentId === 'seg-part')
    expect(part.originalMessageIds).toEqual(['a2', 'u2'])
    // Null wire color falls back to the deterministic segment color.
    expect(part.color).toBe(getSegmentColor('seg-part'))
  })

  it('cut publishes mode cut with the same completeness and performs no deletion', async () => {
    const { cutMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()

    const count = await cutMessages(dispatch, 'topic-1', ['u1'])

    expect(count).toBe(3)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const payload = dispatch.mock.calls[0][0].payload
    expect(dispatch.mock.calls[0][0].type).toBe('clipboard/setClipboard')
    expect(payload.mode).toBe('cut')
    expect(payload.items[0].messages.map((m) => m.id)).toEqual(['u1', 'a1', 'a2'])
    expect(payload.items[0].blocks.map((b) => b.id)).toEqual(['bu1', 'ba1', 'ba2'])
    expect(payload.segmentSnapshots).toHaveLength(1)
    // Cut itself deletes nothing — source deletion happens at paste time.
    expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
    expect(storeState.messages.messageIdsByTopic['topic-1']).toEqual(['a2', 'u2'])
  })

  it('canonical grouping: system keys own ID, ignored tool role forms no group', async () => {
    const { copyMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()

    const count = await copyMessages(dispatch, 'topic-1', ['s1', 't1'])

    expect(count).toBe(1)
    const items = dispatch.mock.calls[0][0].payload.items
    expect(items).toHaveLength(1)
    expect(items[0].originalAskId).toBe('s1')
    expect(items[0].messages.map((m) => m.id)).toEqual(['s1'])
    expect(items[0].positionIndex).toBe(4)
  })

  it('failure atomicity: snapshot failure publishes nothing', async () => {
    mocks.fetchWholeTopicSnapshot.mockRejectedValue(new Error('NOT_FOUND'))
    const { copyMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()

    const count = await copyMessages(dispatch, 'topic-1', ['u1'])

    expect(count).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
    expect(storeState.messages.messageIdsByTopic['topic-1']).toEqual(['a2', 'u2'])
  })

  it('failure atomicity: segment catalog failure publishes nothing (no partial clipboard)', async () => {
    mocks.listSegments.mockRejectedValue(new Error('SEG_LIST_FAIL'))
    const { copyMessages, cutMessages } = await import('../ClipboardService')

    expect(await copyMessages(vi.fn(), 'topic-1', ['u1'])).toBe(0)
    expect(await cutMessages(vi.fn(), 'topic-1', ['u1'])).toBe(0)
    expect(mocks.setClipboard).not.toHaveBeenCalled()
  })

  it('empty or unresolvable selection performs no authority reads and publishes nothing', async () => {
    const { copyMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()

    expect(await copyMessages(dispatch, 'topic-1', [])).toBe(0)
    expect(mocks.fetchWholeTopicSnapshot).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()

    expect(await copyMessages(dispatch, 'topic-1', ['missing-group'])).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
