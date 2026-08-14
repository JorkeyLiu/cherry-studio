/**
 * ClipboardService.pasteMessages — PERF-100 batch paste tests.
 *
 * The insertion phase of paste must use ONE `pasteMessagesToTopic` data-source
 * call (one Main transaction, one batch primitive) and ONE ordered
 * `messagesReceived` projection commit, with clipboard/undo/file/segment
 * semantics preserved:
 *   - exactly one data-source batch call on copy paste (no per-message
 *     appendMessage / insertMessageAtIndex loop)
 *   - one `messagesReceived` projection commit carrying the EXACT post-batch
 *     ordered list (pre-batch projection with regenerated message IDs spliced
 *     at the same clamped insertion index)
 *   - one `upsertManyBlocks` commit with every pasted block
 *   - DB-first: a failed batch never touches Redux
 *   - active-topic precondition fires BEFORE the DB batch: a non-active-topic
 *     paste makes zero DB calls and zero Redux commits
 *   - copy/cut semantics, file deltas, and undo payload shapes preserved
 *   - a regression case at a TRUE middle index
 */

import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

/** Structural view of the undo actions ClipboardService pushes (type-only). */
interface UndoActionLike {
  type: string
  targetTopicId: string
  targetInsertPositionIndex: number
  insertedMessageIds: string[]
  sourceTopicId?: string
  sourceGroupAnchors?: Array<{
    messages: Message[]
    blocks: MessageBlock[]
    positionIndex: number
    anchorMessageId: string | null
  }>
}

const { mocks } = vi.hoisted(() => ({
  mocks: {
    pasteMessagesToTopic: vi.fn(),
    upsertSegment: vi.fn(),
    updateFileCount: vi.fn(),
    deleteMessagesFromDB: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    selectMessagesForTopic: vi.fn(),
    messagesReceived: vi.fn((p: { topicId: string; messages: Message[] }) => ({
      type: 'newMessages/messagesReceived',
      payload: p
    })),
    removeMessages: vi.fn((p: unknown) => ({ type: 'newMessages/removeMessages', payload: p })),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/removeManyBlocks', payload: p })),
    addSegment: vi.fn((p: unknown) => ({ type: 'topicSegment/addSegment', payload: p })),
    pushUndoAction: vi.fn((p: UndoActionLike) => ({ type: 'undoStack/pushUndoAction', payload: p })),
    clearClipboard: vi.fn(() => ({ type: 'clipboard/clearClipboard' })),
    collectSegmentSnapshots: vi.fn(() => []),
    syncSegmentsAfterMessageDeletion: vi.fn().mockResolvedValue(undefined)
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
    pasteMessagesToTopic: mocks.pasteMessagesToTopic,
    upsertSegment: mocks.upsertSegment,
    updateFileCount: mocks.updateFileCount
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: mocks.deleteMessagesFromDB
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/clipboard', () => ({
  clearClipboard: mocks.clearClipboard,
  setClipboard: () => ({ type: 'clipboard/setClipboard' })
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: { messagesReceived: mocks.messagesReceived, removeMessages: mocks.removeMessages },
  selectMessagesForTopic: mocks.selectMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: mocks.upsertManyBlocks,
  removeManyBlocks: mocks.removeManyBlocks
}))

vi.mock('@renderer/store/undoStack', () => ({
  pushUndoAction: mocks.pushUndoAction
}))

vi.mock('@renderer/store/topicSegment', () => ({
  addSegment: mocks.addSegment
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  collectSegmentSnapshots: mocks.collectSegmentSnapshots,
  collectWholeSelectedSegmentsForClipboard: vi.fn(() => []),
  syncSegmentsAfterMessageDeletion: mocks.syncSegmentsAfterMessageDeletion
}))

vi.mock('@renderer/services/anchorService', () => ({
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

// ── Store mock ─────────────────────────────────────────────────────────────

interface StoreState {
  clipboard: {
    mode: 'copy' | 'cut' | null
    items: Array<{
      originalAskId: string
      messages: Message[]
      blocks: MessageBlock[]
      positionIndex: number
    }>
    sourceTopicId: string | null
    segmentSnapshots: Array<{
      originalSegmentId: string
      name: string
      color?: string
      originalMessageIds: string[]
    }>
  }
  messages: {
    entities: Record<string, Message>
    messageIdsByTopic: Record<string, string[]>
    currentTopicId: string | null
  }
  messageBlocks: {
    entities: Record<string, MessageBlock>
  }
}

let storeState: StoreState

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  },
  useAppDispatch: () => vi.fn()
}))

// ── Helpers ────────────────────────────────────────────────────────────────

const createUserMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: `m-${overrides.id ?? 'x'}`,
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: overrides.blocks ?? [],
    askId: undefined,
    ...overrides
  }) as unknown as Message

const createFileBlock = (messageId: string, overrides: Partial<MessageBlock> = {}): MessageBlock =>
  ({
    id: `b-${overrides.id ?? 'f'}`,
    messageId,
    type: MessageBlockType.FILE,
    content: '',
    file: { id: `file-${overrides.id ?? '1'}`, name: 'test.pdf' },
    ...overrides
  }) as unknown as MessageBlock

const createTextBlock = (messageId: string, overrides: Partial<MessageBlock> = {}): MessageBlock =>
  ({
    id: `b-${overrides.id ?? 't'}`,
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content: 'hello',
    ...overrides
  }) as unknown as MessageBlock

/** Pre-batch target topic: 4 user messages m0..m3 (each its own group). */
function buildTargetTopic(): Message[] {
  return ['m0', 'm1', 'm2', 'm3'].map((id) => createUserMessage({ id }))
}

/** Clipboard with one item (one user message + one text block). */
function makeClipboardItem(message: Message, blocks: MessageBlock[], positionIndex: number) {
  return {
    originalAskId: message.id,
    messages: [message],
    blocks,
    positionIndex
  }
}

function baseStoreState(): StoreState {
  const target = buildTargetTopic()
  return {
    clipboard: { mode: 'copy', items: [], sourceTopicId: null, segmentSnapshots: [] },
    messages: {
      entities: Object.fromEntries(target.map((m) => [m.id, m])),
      messageIdsByTopic: { 'topic-1': target.map((m) => m.id) },
      currentTopicId: 'topic-1'
    },
    messageBlocks: { entities: {} }
  }
}

function mockTargetMessages(state: StoreState): void {
  mocks.selectMessagesForTopic.mockImplementation((_state: unknown, topicId: string) => {
    const ids = state.messages.messageIdsByTopic[topicId] ?? []
    return ids.map((id) => state.messages.entities[id]).filter((m): m is Message => !!m)
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ClipboardService.pasteMessages (PERF-100 batch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = baseStoreState()
    mockTargetMessages(storeState)
    mocks.pasteMessagesToTopic.mockResolvedValue(emptyCleanup)
  })

  it('copy paste uses ONE data-source batch call and ONE ordered projection commit at a middle index', async () => {
    const copied = createUserMessage({ id: 'c0' })
    const copiedBlock = createTextBlock(copied.id, { id: 'cb0', content: 'copied' })
    const pastedMessage = { ...copied }
    pastedMessage.blocks = ['cb0']
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(pastedMessage, [copiedBlock], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()
    const count = await pasteMessages(dispatch, () => storeState as any, 'topic-1', 'm1')

    expect(count).toBe(1)
    // ONE data-source call, no per-message appendMessage loop.
    expect(mocks.pasteMessagesToTopic).toHaveBeenCalledExactlyOnceWith(
      'topic-1',
      [
        {
          message: expect.objectContaining({ id: expect.any(String), topicId: 'topic-1' }),
          blocks: [expect.objectContaining({ messageId: expect.any(String), content: 'copied' })]
        }
      ],
      2
    )
    // ONE projection commit; the regenerated ID lands exactly between m1 and m2.
    expect(mocks.messagesReceived).toHaveBeenCalledTimes(1)
    const receivedPayload = mocks.messagesReceived.mock.calls[0][0]
    expect(receivedPayload.topicId).toBe('topic-1')
    const receivedIds = receivedPayload.messages.map((m) => m.id)
    expect(receivedIds).toHaveLength(5)
    expect(receivedIds[0]).toBe('m0')
    expect(receivedIds[1]).toBe('m1')
    expect(receivedIds[2]).not.toBe('m0')
    expect(receivedIds[2]).not.toBe('m1')
    expect(receivedIds[2]).not.toBe('m2')
    expect(receivedIds[2]).not.toBe('m3')
    expect(receivedIds[3]).toBe('m2')
    expect(receivedIds[4]).toBe('m3')
    // ONE block commit carrying the pasted block.
    expect(mocks.upsertManyBlocks).toHaveBeenCalledTimes(1)
    // Undo payload keeps the exact insertion position.
    expect(mocks.pushUndoAction).toHaveBeenCalledTimes(1)
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('paste')
    expect(undoAction.targetTopicId).toBe('topic-1')
    expect(undoAction.targetInsertPositionIndex).toBe(2)
    expect(undoAction.insertedMessageIds).toHaveLength(1)
  })

  it('regression: middle-index batch keeps every original message order and block order (true middle)', async () => {
    const copied = createUserMessage({ id: 'c0' })
    const blockA = createTextBlock(copied.id, { id: 'ba' })
    const blockB = createTextBlock(copied.id, { id: 'bb' })
    const pastedMessage = { ...copied }
    pastedMessage.blocks = ['ba', 'bb']
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(pastedMessage, [blockA, blockB], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    const receivedPayload = mocks.messagesReceived.mock.calls[0][0]
    // All four original ids keep their relative order.
    const originalIds = receivedPayload.messages.filter((m) => ['m0', 'm1', 'm2', 'm3'].includes(m.id)).map((m) => m.id)
    expect(originalIds).toEqual(['m0', 'm1', 'm2', 'm3'])
    // The pasted message carries its blocks in order (block IDs are
    // regenerated by the paste, but both blocks carry over in order).
    const pasted = receivedPayload.messages.find((m) => !['m0', 'm1', 'm2', 'm3'].includes(m.id))
    expect(pasted?.blocks).toHaveLength(2)
    expect(pasted?.blocks![0]).not.toBe(pasted?.blocks![1])
  })

  it('DB-first: a failed batch never dispatches a projection commit or undo', async () => {
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }
    mocks.pasteMessagesToTopic.mockRejectedValue(new Error('SQLITE_CONSTRAINT'))

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'DB batch write failed'
    )
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })

  it('cut paste keeps the batch insertion AND the batched source deletion semantics', async () => {
    // Source topic 'topic-2' holds the cut group; target topic 'topic-1' the paste point.
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-2' })
    const cutBlock = createTextBlock(cutMsg.id, { id: 'cutb' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [cutBlock], 0)],
      sourceTopicId: 'topic-2',
      segmentSnapshots: []
    }
    storeState.messages.entities['cut-0'] = cutMsg
    storeState.messages.messageIdsByTopic['topic-2'] = ['cut-0']
    storeState.messageBlocks.entities['cutb'] = cutBlock
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    // Insertion is the SAME single batch call (cut is not a different path).
    expect(mocks.pasteMessagesToTopic).toHaveBeenCalledTimes(1)
    expect(mocks.messagesReceived).toHaveBeenCalledTimes(1)
    // Source deletion happens once with the cut ids; cleanup consumed once.
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-2', ['cut-0'])
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(emptyCleanup)
    expect(mocks.removeMessages).toHaveBeenCalledExactlyOnceWith({
      topicId: 'topic-2',
      messageIds: ['cut-0']
    })
    expect(mocks.clearClipboard).toHaveBeenCalledTimes(1)
    // CutPasteUndoAction keeps its shape: the real per-group anchor builder
    // captured the cut source group before deletion.
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceTopicId).toBe('topic-2')
    expect(undoAction.sourceGroupAnchors).toHaveLength(1)
    const anchors = undoAction.sourceGroupAnchors ?? []
    expect(anchors[0].messages[0].id).toBe('cut-0')
    expect(anchors[0].anchorMessageId).toBeNull()
  })

  it('file blocks produce per-file count deltas (copy semantics preserved)', async () => {
    const copied = createUserMessage({ id: 'c0' })
    const fileBlock = createFileBlock(copied.id, { id: 'fb0' })
    const pastedMessage = { ...copied }
    pastedMessage.blocks = ['fb0']
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(pastedMessage, [fileBlock], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    expect(mocks.updateFileCount).toHaveBeenCalledExactlyOnceWith('file-fb0', 1, false)
  })

  it('rejects non-active-topic paste BEFORE any DB call or Redux commit (active-topic precondition)', async () => {
    storeState.messages.currentTopicId = 'topic-other'
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'cannot project paste into non-active topic'
    )
    // Precondition fires BEFORE persistence: zero DB calls.
    expect(mocks.pasteMessagesToTopic).not.toHaveBeenCalled()
    expect(mocks.updateFileCount).not.toHaveBeenCalled()
    expect(mocks.upsertSegment).not.toHaveBeenCalled()
    expect(mocks.deleteMessagesFromDB).not.toHaveBeenCalled()
    // ...and zero Redux commits.
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    expect(mocks.removeManyBlocks).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
    expect(mocks.removeMessages).not.toHaveBeenCalled()
    expect(mocks.addSegment).not.toHaveBeenCalled()
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
  })
})
