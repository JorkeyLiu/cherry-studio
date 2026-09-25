/**
 * ClipboardService.pasteMessages — stable insert-message-groups tests.
 *
 * The insertion phase of paste must use ONE `insertMessageGroups` data-source
 * call with a stable intent (never a loaded numeric index) and a bounded
 * local projection commit, with clipboard/undo/file/segment semantics
 * preserved:
 *   - exactly one stable batch call on copy paste (no numeric paste call,
 *     no per-message append loop)
 *   - after-group-tail intent for a selected target group; topic-tail for an
 *     explicit no-target paste; a supplied target absent from the loaded
 *     projection still travels to Main unchanged (no loaded-tail fallback)
 *   - bounded projection: an outside-loaded anchor injects no messages and
 *     never replaces the loaded list with an assumed whole topic
 *   - one `upsertManyBlocks` commit with every pasted block
 *   - DB-first: a failed batch never touches Redux
 *   - active-topic precondition fires BEFORE the DB batch
 *   - copy/cut semantics, file deltas, and undo payload shapes preserved
 */

import type { CutPasteUndoAction, GroupAnchor } from '@renderer/types/editMode'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

/**
 * Structural view of the undo actions ClipboardService pushes (type-only).
 * Mirrors the `paste` / `cut_paste` shapes: cut-only fields stay optional so
 * `paste` actions typecheck, while `cut_paste` tests narrow to the exact
 * `CutPasteUndoAction` via type guards below.
 */
interface UndoActionLike {
  type: string
  targetTopicId: string
  targetInsertPositionIndex: number
  targetInsertIntent?: { kind: string; messageId?: string }
  insertedMessageIds: string[]
  sourceTopicId?: string
  sourceRootIds?: CutPasteUndoAction['sourceRootIds']
  sourceGroupAnchors?: GroupAnchor[]
  sourceSegmentSnapshots?: TopicSegment[]
}

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertMessageGroups: vi.fn(),
    pasteMessagesToTopic: vi.fn(),
    upsertSegment: vi.fn(),
    updateFileCount: vi.fn(),
    deleteMessagesFromDB: vi.fn(),
    executeDeleteMessagesWithDependents: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    selectLoadedMessagesForTopic: vi.fn(),
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
    insertMessageGroups: mocks.insertMessageGroups,
    pasteMessagesToTopic: mocks.pasteMessagesToTopic,
    upsertSegment: mocks.upsertSegment,
    updateFileCount: mocks.updateFileCount
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: mocks.deleteMessagesFromDB,
  executeDeleteMessagesWithDependents: mocks.executeDeleteMessagesWithDependents
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
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
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
  topicBranch?: {
    branchesByTopic: Record<string, unknown[]>
    activeBranchIdByTopic: Record<string, string>
    routeGenerationByTopic: Record<string, number>
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

const createAssistantMessage = (id: string, askId: string): Message =>
  ({
    id,
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: [],
    askId
  }) as unknown as Message

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
  mocks.selectLoadedMessagesForTopic.mockImplementation((_state: unknown, topicId: string) => {
    const ids = state.messages.messageIdsByTopic[topicId] ?? []
    return ids.map((id) => state.messages.entities[id]).filter((m): m is Message => !!m)
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ClipboardService.pasteMessages (stable insert-message-groups)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = baseStoreState()
    mockTargetMessages(storeState)
    mocks.insertMessageGroups.mockResolvedValue(emptyCleanup)
  })

  it('copy paste uses ONE stable batch call and ONE ordered projection commit at a middle index', async () => {
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
    // ONE stable data-source call with after-group-tail intent; no numeric paste call.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith(
      'topic-1',
      [
        {
          entries: [
            {
              message: expect.objectContaining({ id: expect.any(String), topicId: 'topic-1' }),
              blocks: [expect.objectContaining({ messageId: expect.any(String), content: 'copied' })]
            }
          ],
          intent: { kind: 'after-group-tail', messageId: 'm1' }
        }
      ],
      null
    )
    expect(mocks.pasteMessagesToTopic).not.toHaveBeenCalled()
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
    // Undo payload carries the stable intent (authority) for redo.
    expect(mocks.pushUndoAction).toHaveBeenCalledTimes(1)
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('paste')
    expect(undoAction.targetTopicId).toBe('topic-1')
    expect(undoAction.targetInsertIntent).toEqual({ kind: 'after-group-tail', messageId: 'm1' })
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

  it('outside-loaded target still sends the stable ID to Main but injects no messages', async () => {
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'outside-id')

    // Stable ID travels unchanged even though it is absent from loaded.
    expect(mocks.insertMessageGroups).toHaveBeenCalledExactlyOnceWith(
      'topic-1',
      [
        {
          entries: [expect.objectContaining({ message: expect.objectContaining({ topicId: 'topic-1' }) })],
          intent: { kind: 'after-group-tail', messageId: 'outside-id' }
        }
      ],
      null
    )
    expect(mocks.pasteMessagesToTopic).not.toHaveBeenCalled()
    // Bounded projection: no outside-window injection, loaded list untouched.
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
    // Undo still records the stable intent for redo.
    expect(mocks.pushUndoAction).toHaveBeenCalledTimes(1)
    expect(mocks.pushUndoAction.mock.calls[0][0].targetInsertIntent).toEqual({
      kind: 'after-group-tail',
      messageId: 'outside-id'
    })
  })

  it('explicit no-target paste uses topic-tail and appends to loaded', async () => {
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', '')

    expect(mocks.insertMessageGroups).toHaveBeenCalledExactlyOnceWith(
      'topic-1',
      [
        {
          entries: [expect.objectContaining({ message: expect.objectContaining({ topicId: 'topic-1' }) })],
          intent: { kind: 'topic-tail' }
        }
      ],
      null
    )
    expect(mocks.pasteMessagesToTopic).not.toHaveBeenCalled()
    expect(mocks.messagesReceived).toHaveBeenCalledTimes(1)
    const receivedIds = mocks.messagesReceived.mock.calls[0][0].messages.map((m) => m.id)
    expect(receivedIds.slice(0, 4)).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(receivedIds).toHaveLength(5)
  })

  it('DB-first: a failed batch never dispatches a projection commit or undo', async () => {
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }
    mocks.insertMessageGroups.mockRejectedValue(new Error('SQLITE_CONSTRAINT'))

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'DB batch write failed'
    )
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })

  it('cut paste keeps the batch insertion AND the single semantic source deletion', async () => {
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
    const authorityAnchors = [
      {
        messages: [cutMsg],
        blocks: [cutBlock],
        positionIndex: 0,
        anchorMessageId: null,
        loadedMessageIds: ['cut-0']
      }
    ]
    const authoritySegments = [{ id: 'seg-src', topicId: 'topic-2', name: 'Src', messageIds: ['cut-0'] }]
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue({
      response: { deletedMessageIds: ['cut-0'] },
      undoParts: {
        groupAnchors: authorityAnchors,
        segmentSnapshots: authoritySegments,
        fileReferenceDeltas: []
      }
    })

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    // Insertion is the SAME single stable batch call (cut is not a different path).
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.pasteMessagesToTopic).not.toHaveBeenCalled()
    expect(mocks.messagesReceived).toHaveBeenCalledTimes(1)
    // Source deletion is ONE semantic transaction with stable MEMBER roots
    // (all complete clipboard member IDs, deduped authority order); Main
    // expands user dependents and handles orphan roots directly.
    expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      'topic-2',
      ['cut-0']
    )
    expect(mocks.deleteMessagesFromDB).not.toHaveBeenCalled()
    // The helper owns cleanup/convergence — the service issues no direct
    // projection or segment mutations for the source.
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    expect(mocks.removeMessages).not.toHaveBeenCalled()
    expect(mocks.removeManyBlocks).not.toHaveBeenCalled()
    expect(mocks.collectSegmentSnapshots).not.toHaveBeenCalled()
    expect(mocks.syncSegmentsAfterMessageDeletion).not.toHaveBeenCalled()
    expect(mocks.clearClipboard).toHaveBeenCalledTimes(1)
    // CutPasteUndoAction keeps its shape: source anchors/segments come from
    // the authority undo parts (full material, never loaded-derived), plus
    // the stable member roots needed by redo.
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceTopicId).toBe('topic-2')
    expect(undoAction.sourceGroupAnchors).toEqual(authorityAnchors)
    expect(undoAction.sourceSegmentSnapshots).toEqual(authoritySegments)
    expect(undoAction.sourceRootIds).toEqual(['cut-0'])
  })

  it('cut paste sends ALL complete member IDs as stable roots (multi-member group, deduped authority order)', async () => {
    // Group u1 = user u1 + assistants a1/a2; clipboard item carries the full
    // authority member set with originalAskId 'u1'.
    const u1 = createUserMessage({ id: 'u1', topicId: 'topic-2' })
    const a1 = createAssistantMessage('a1', 'u1')
    a1.topicId = 'topic-2'
    const a2 = createAssistantMessage('a2', 'u1')
    a2.topicId = 'topic-2'
    storeState.clipboard = {
      mode: 'cut',
      items: [
        {
          originalAskId: 'u1',
          messages: [u1, a1, a2],
          blocks: [],
          positionIndex: 0
        }
      ],
      sourceTopicId: 'topic-2',
      segmentSnapshots: []
    }
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue({
      response: { deletedMessageIds: ['u1', 'a1', 'a2'] },
      undoParts: {
        groupAnchors: [
          { messages: [u1, a1, a2], blocks: [], positionIndex: 0, anchorMessageId: null, loadedMessageIds: ['u1'] }
        ],
        segmentSnapshots: [],
        fileReferenceDeltas: []
      }
    })

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    // All member IDs — not only originalAskId — travel as stable roots.
    expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      'topic-2',
      ['u1', 'a1', 'a2']
    )
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceRootIds).toEqual(['u1', 'a1', 'a2'])
    expect(undoAction.sourceGroupAnchors).toHaveLength(1)
  })

  it('cut paste deletes an orphan-assistant group via all member roots (no user-root expansion)', async () => {
    // Orphan group: assistants a1/a2 share askId 'orphan-ask' with no user
    // message. originalAskId alone ('orphan-ask') belongs to no topic row;
    // only the member IDs are valid stable roots.
    const a1 = createAssistantMessage('a1', 'orphan-ask')
    a1.topicId = 'topic-2'
    const a2 = createAssistantMessage('a2', 'orphan-ask')
    a2.topicId = 'topic-2'
    storeState.clipboard = {
      mode: 'cut',
      items: [
        {
          originalAskId: 'orphan-ask',
          messages: [a1, a2],
          blocks: [],
          positionIndex: 0
        }
      ],
      sourceTopicId: 'topic-2',
      segmentSnapshots: []
    }
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue({
      response: { deletedMessageIds: ['a1', 'a2'] },
      undoParts: {
        groupAnchors: [
          { messages: [a1, a2], blocks: [], positionIndex: 0, anchorMessageId: null, loadedMessageIds: [] }
        ],
        segmentSnapshots: [],
        fileReferenceDeltas: []
      }
    })

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      'topic-2',
      ['a1', 'a2']
    )
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceRootIds).toEqual(['a1', 'a2'])
    const orphanAnchors = undoAction.sourceGroupAnchors
    expect(orphanAnchors).toBeDefined()
    expect(orphanAnchors?.[0]?.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('cut paste tolerates source-delete failure: insertion stands, clipboard clears, undo carries empty source anchors', async () => {
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-2' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [], 0)],
      sourceTopicId: 'topic-2',
      segmentSnapshots: []
    }
    storeState.messages.entities['cut-0'] = cutMsg
    storeState.messages.messageIdsByTopic['topic-2'] = ['cut-0']
    mocks.executeDeleteMessagesWithDependents.mockRejectedValue(new Error('SQLITE_FAILURE'))

    const { pasteMessages } = await import('../ClipboardService')
    const count = await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    // The successful insertion is preserved (existing swallow semantics).
    expect(count).toBe(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.messagesReceived).toHaveBeenCalledTimes(1)
    expect(mocks.clearClipboard).toHaveBeenCalledTimes(1)
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceGroupAnchors).toEqual([])
    expect(undoAction.sourceSegmentSnapshots).toEqual([])
    expect(undoAction.sourceRootIds).toEqual([])
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
    expect(mocks.insertMessageGroups).not.toHaveBeenCalled()
    expect(mocks.pasteMessagesToTopic).not.toHaveBeenCalled()
    expect(mocks.updateFileCount).not.toHaveBeenCalled()
    expect(mocks.upsertSegment).not.toHaveBeenCalled()
    expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
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

  it('non-contiguous same-answer group projects after the last loaded assistant (Main parity)', async () => {
    // Fully loaded projection: [user, a1, mid, a2] where a1/a2 share askId=user.
    const user = createUserMessage({ id: 'u0' })
    const a1 = createAssistantMessage('a1', user.id)
    const mid = createUserMessage({ id: 'mid' })
    const a2 = createAssistantMessage('a2', user.id)
    const loaded = [user, a1, mid, a2]
    storeState.messages.entities = Object.fromEntries(loaded.map((m) => [m.id, m]))
    storeState.messages.messageIdsByTopic = { 'topic-1': loaded.map((m) => m.id) }

    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    const count = await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', user.id)

    expect(count).toBe(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledExactlyOnceWith(
      'topic-1',
      [
        {
          entries: [expect.objectContaining({ message: expect.objectContaining({ topicId: 'topic-1' }) })],
          intent: { kind: 'after-group-tail', messageId: user.id }
        }
      ],
      null
    )
    expect(mocks.messagesReceived).toHaveBeenCalledTimes(1)
    const receivedIds = mocks.messagesReceived.mock.calls[0][0].messages.map((m) => m.id)
    // Local order matches Main intent: pasted row lands after a2, not after a1.
    expect(receivedIds.slice(0, 4)).toEqual([user.id, 'a1', mid.id, 'a2'])
    expect(receivedIds).toHaveLength(5)
    expect(receivedIds[4]).not.toBe(user.id)
    expect(receivedIds[4]).not.toBe('a1')
    expect(receivedIds[4]).not.toBe(mid.id)
    expect(receivedIds[4]).not.toBe('a2')
  })

  it('passes the active branch route to Main while keeping the stable intent', async () => {
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      segmentSnapshots: []
    }
    storeState.topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: { 'topic-1': 'branch-7' },
      routeGenerationByTopic: {}
    }

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    expect(mocks.insertMessageGroups).toHaveBeenCalledExactlyOnceWith(
      'topic-1',
      [
        {
          entries: [expect.objectContaining({ message: expect.objectContaining({ topicId: 'topic-1' }) })],
          intent: { kind: 'after-group-tail', messageId: 'm1' }
        }
      ],
      'branch-7'
    )
  })
})
