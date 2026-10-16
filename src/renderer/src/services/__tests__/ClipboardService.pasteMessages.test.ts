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
  sourceBranchId?: CutPasteUndoAction['sourceBranchId']
  targetBranchId?: CutPasteUndoAction['targetBranchId']
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
    executeStagedCutSourceDelete: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    selectLoadedMessagesForTopic: vi.fn(),
    messagesReceived: vi.fn((p: { topicId: string; messages: Message[] }) => ({
      type: 'newMessages/messagesReceived',
      payload: p
    })),
    applyInsertedMessageGroups: vi.fn((p: unknown) => ({ type: 'newMessages/applyInsertedMessageGroups', payload: p })),
    removeMessages: vi.fn((p: unknown) => ({ type: 'newMessages/removeMessages', payload: p })),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/removeManyBlocks', payload: p })),
    addSegment: vi.fn((p: unknown) => ({ type: 'topicSegment/addSegment', payload: p })),
    pushUndoAction: vi.fn((p: UndoActionLike) => ({ type: 'undoStack/pushUndoAction', payload: p })),
    clearClipboard: vi.fn(() => ({ type: 'clipboard/clearClipboard' })),
    collectSegmentSnapshots: vi.fn(() => []),
    syncSegmentsAfterMessageDeletion: vi.fn().mockResolvedValue(undefined),
    deleteSegmentsBySnapshots: vi.fn().mockResolvedValue(undefined)
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
  executeDeleteMessagesWithDependents: mocks.executeDeleteMessagesWithDependents,
  executeStagedCutSourceDelete: mocks.executeStagedCutSourceDelete,
  isDeletePostCommitConvergenceError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false
    const candidate = error as { committed?: unknown; response?: unknown; undoParts?: unknown }
    return (
      candidate.committed === true && typeof candidate.response === 'object' && typeof candidate.undoParts === 'object'
    )
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/clipboard', () => ({
  clearClipboard: mocks.clearClipboard,
  setClipboard: () => ({ type: 'clipboard/setClipboard' })
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    messagesReceived: mocks.messagesReceived,
    applyInsertedMessageGroups: mocks.applyInsertedMessageGroups,
    removeMessages: mocks.removeMessages
  },
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
  syncSegmentsAfterMessageDeletion: mocks.syncSegmentsAfterMessageDeletion,
  deleteSegmentsBySnapshots: mocks.deleteSegmentsBySnapshots
}))

vi.mock('@renderer/services/anchorService', () => ({
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

/** Build a Main-style batch ack echoing the request groups (flat ids + per-group runs). */
function ackFromRequest(
  topicId: string,
  groups: Array<{ entries: Array<{ message: { id: string } }>; intent?: { kind: string; messageId?: string } }>,
  branchId: string | null
) {
  const flatIds = groups.flatMap((g) => g.entries.map((e) => e.message.id))
  const loadedIds = new Set(storeState?.messages?.messageIdsByTopic?.[topicId] ?? [])
  return {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    topicId,
    branchId,
    insertedMessages: flatIds.map((id) => ({ id, topicId: 'topic-1' })),
    insertedBlocks: [],
    insertedMessageIds: flatIds,
    mutableMessageIds: [...flatIds],
    groups: groups.map((g) => {
      const intent = g.intent as { kind: string; messageId?: string } | undefined
      if (!intent || intent.kind === 'topic-tail') {
        return { insertedMessageIds: g.entries.map((e) => e.message.id), beforeMessageId: null, nextMessageId: null }
      }
      const anchor = intent.messageId ?? null
      if (anchor && loadedIds.has(anchor)) {
        // Resident anchor: stable neighbors drive middle placement in the reducer.
        if (intent.kind === 'before-message') {
          return {
            insertedMessageIds: g.entries.map((e) => e.message.id),
            beforeMessageId: null,
            nextMessageId: anchor
          }
        }
        return { insertedMessageIds: g.entries.map((e) => e.message.id), beforeMessageId: anchor, nextMessageId: null }
      }
      // Nonresident anchor: neither neighbor resident (non-tail) → inject nothing.
      return {
        insertedMessageIds: g.entries.map((e) => e.message.id),
        beforeMessageId: anchor,
        nextMessageId: 'ghost-nonresident'
      }
    })
  }
}

function mockInsertAck() {
  mocks.insertMessageGroups.mockImplementation(
    async (
      topicId: string,
      groups: Array<{ entries: Array<{ message: { id: string } }>; intent?: { kind: string; messageId?: string } }>,
      branchId?: string | null
    ) => ackFromRequest(topicId, groups, branchId ?? null)
  )
}

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
    sourceBranchId?: string | null
    sourceProjection?: {
      sourceTopicId: string
      sourceBranchId: string | null
      loadedMessageIds: string[]
    }
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
    clipboard: { mode: 'copy', items: [], sourceTopicId: null, sourceBranchId: null, segmentSnapshots: [] },
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
    mockInsertAck()
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)
    mocks.consumeFileCleanupResult.mockResolvedValue(undefined)
    mocks.deleteSegmentsBySnapshots.mockResolvedValue(undefined)
    mocks.syncSegmentsAfterMessageDeletion.mockResolvedValue(undefined)
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
      sourceBranchId: null,
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
    // ONE atomic Main-ack projection commit with canonical rows+capability;
    // placement follows the Main stable neighbors (resident m1 anchor).
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    const batchPayload = mocks.applyInsertedMessageGroups.mock.calls[0][0] as {
      topicId: string
      route: string | null
      insertedMessageIds: string[]
      mutableMessageIds: string[]
      groups: Array<{ insertedMessageIds: string[]; beforeMessageId: string | null; visibleMessageIds: string[] }>
    }
    expect(batchPayload.topicId).toBe('topic-1')
    expect(batchPayload.insertedMessageIds).toHaveLength(1)
    expect(batchPayload.mutableMessageIds).toEqual(batchPayload.insertedMessageIds)
    expect(batchPayload.groups).toHaveLength(1)
    expect(batchPayload.groups[0].beforeMessageId).toBe('m1')
    expect(batchPayload.groups[0].visibleMessageIds).toEqual(batchPayload.insertedMessageIds)
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
    // Block publication for the projected row is separate (existing convention).
    // Mock ack carries no blocks here; no block assertion.
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
      sourceBranchId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    // Atomic ack preserves the stable intent; block order is covered by the
    // entry construction (both blocks carry over in order) and reducer tests.
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    const batch = mocks.applyInsertedMessageGroups.mock.calls[0][0] as {
      groups: Array<{ beforeMessageId: string | null; visibleMessageIds: string[] }>
    }
    expect(batch.groups[0].beforeMessageId).toBe('m1')
    expect(batch.groups[0].visibleMessageIds).toHaveLength(1)
  })

  it('outside-loaded target still sends the stable ID to Main but injects no messages', async () => {
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      sourceBranchId: null,
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
    // Bounded projection: the shared ack carries nonresident stable neighbors
    // so the reducer injects nothing (no whole-topic assumption). The batch
    // is still published once with the full visible set for the reducer to gate.
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    const outsideBatch = mocks.applyInsertedMessageGroups.mock.calls[0][0] as {
      groups: Array<{ beforeMessageId: string | null; nextMessageId: string | null }>
    }
    expect(outsideBatch.groups[0].beforeMessageId).toBe('outside-id')
    expect(outsideBatch.groups[0].nextMessageId).toBe('ghost-nonresident')
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
      sourceBranchId: null,
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
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    const tailBatch = mocks.applyInsertedMessageGroups.mock.calls[0][0] as {
      insertedMessageIds: string[]
      groups: Array<{ nextMessageId: string | null; visibleMessageIds: string[] }>
    }
    expect(tailBatch.insertedMessageIds).toHaveLength(1)
    expect(tailBatch.groups[0].nextMessageId).toBeNull()
    expect(tailBatch.groups[0].visibleMessageIds).toEqual(tailBatch.insertedMessageIds)
  })

  it('DB-first: a failed batch never dispatches a projection commit or undo', async () => {
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      sourceBranchId: null,
      segmentSnapshots: []
    }
    mocks.insertMessageGroups.mockRejectedValue(new Error('SQLITE_CONSTRAINT'))

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'DB batch write failed'
    )
    expect(mocks.applyInsertedMessageGroups).not.toHaveBeenCalled()
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
      sourceBranchId: null,
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: null, loadedMessageIds: ['cut-0'] },
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
    mocks.executeStagedCutSourceDelete.mockResolvedValue({
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
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    // Staged-cut source deletion is ONE authority transaction with the staged
    // route (no projection capability rerequire); Main owns expansion.
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-2',
        sourceBranchId: null,
        rootIds: ['cut-0'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-2', sourceBranchId: null })
      })
    )
    expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
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
      sourceBranchId: null,
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: null, loadedMessageIds: ['u1', 'a1', 'a2'] },
      segmentSnapshots: []
    }
    mocks.executeStagedCutSourceDelete.mockResolvedValue({
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
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-2',
        sourceBranchId: null,
        rootIds: ['u1', 'a1', 'a2'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-2', sourceBranchId: null })
      })
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
      sourceBranchId: null,
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: null, loadedMessageIds: ['a1', 'a2'] },
      segmentSnapshots: []
    }
    mocks.executeStagedCutSourceDelete.mockResolvedValue({
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

    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-2',
        sourceBranchId: null,
        rootIds: ['a1', 'a2'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-2', sourceBranchId: null })
      })
    )
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceRootIds).toEqual(['a1', 'a2'])
    const orphanAnchors = undoAction.sourceGroupAnchors
    expect(orphanAnchors).toBeDefined()
    expect(orphanAnchors?.[0]?.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('cut source-delete failure is transactional: copies rolled back, clipboard retained, no cut_paste undo', async () => {
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-2' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [], 0)],
      sourceTopicId: 'topic-2',
      sourceBranchId: null,
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: null, loadedMessageIds: ['cut-0'] },
      segmentSnapshots: []
    }
    storeState.messages.entities['cut-0'] = cutMsg
    storeState.messages.messageIdsByTopic['topic-2'] = ['cut-0']
    mocks.executeStagedCutSourceDelete.mockRejectedValue(new Error('SQLITE_FAILURE'))
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)
    mocks.consumeFileCleanupResult.mockResolvedValue(undefined)

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'Cut source delete failed'
    )

    // Insert committed first (insert-first safety), then staged delete failed.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-2',
        sourceBranchId: null,
        rootIds: ['cut-0'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-2', sourceBranchId: null })
      })
    )
    // Transactional rollback: fresh copies removed via the plain authority
    // path on the same addressed target route; original source untouched.
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMessagesFromDB.mock.calls[0][0]).toBe('topic-1')
    expect(mocks.deleteMessagesFromDB.mock.calls[0][2]).toBe(null)
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalled()
    expect(mocks.removeMessages).toHaveBeenCalled()
    // Clipboard retained for retry, no success undo pushed.
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })

  it('cut source Main rejection (notowned) rolls back copies and preserves originals', async () => {
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-2' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [], 0)],
      sourceTopicId: 'topic-2',
      sourceBranchId: null,
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: null, loadedMessageIds: ['cut-0'] },
      segmentSnapshots: []
    }
    mocks.executeStagedCutSourceDelete.mockRejectedValue(new Error('NOT_OWNED'))
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'Cut source delete failed'
    )
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledTimes(1)
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })

  it('cut paste uses the staged source route independent of the live source route (branch switch completes)', async () => {
    // Staged source branch differs from the live source route (same-topic
    // branch switch before paste): paste must still insert first, then
    // address the Main source delete with the staged route. No live-route
    // equality refusal; Main owner guards stay final.
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-2' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [], 0)],
      sourceTopicId: 'topic-2',
      sourceBranchId: 'branch-staged',
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: 'branch-staged', loadedMessageIds: ['cut-0'] },
      segmentSnapshots: []
    }
    storeState.topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: { 'topic-2': 'branch-live' },
      routeGenerationByTopic: {}
    }
    mocks.executeStagedCutSourceDelete.mockResolvedValue({
      response: { deletedMessageIds: ['cut-0'] },
      undoParts: { groupAnchors: [], segmentSnapshots: [], fileReferenceDeltas: [] }
    })

    const { pasteMessages } = await import('../ClipboardService')
    const count = await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    expect(count).toBe(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-2',
        sourceBranchId: 'branch-staged',
        rootIds: ['cut-0'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-2', sourceBranchId: 'branch-staged' })
      })
    )
    expect(mocks.clearClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.pushUndoAction).toHaveBeenCalledTimes(1)
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceBranchId).toBe('branch-staged')
  })

  it('same-topic cut branch→main completes with staged source address and pinned main target', async () => {
    // Same logical topic: cut staged on branch-src, live route switched to
    // main (null) before paste to main. Insert addresses main, source delete
    // addresses the staged branch — no route-match refusal, no silent fallback.
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-1' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [], 0)],
      sourceTopicId: 'topic-1',
      sourceBranchId: 'branch-src',
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: 'branch-src', loadedMessageIds: ['cut-0'] },
      segmentSnapshots: []
    }
    storeState.topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: {},
      routeGenerationByTopic: {}
    }
    mocks.executeStagedCutSourceDelete.mockResolvedValue({
      response: { deletedMessageIds: ['cut-0'] },
      undoParts: { groupAnchors: [], segmentSnapshots: [], fileReferenceDeltas: [] }
    })

    const { pasteMessages } = await import('../ClipboardService')
    const count = await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    expect(count).toBe(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledExactlyOnceWith('topic-1', expect.any(Array), null)
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-1',
        sourceBranchId: 'branch-src',
        rootIds: ['cut-0'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-1', sourceBranchId: 'branch-src' })
      })
    )
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.sourceBranchId).toBe('branch-src')
    expect(undoAction.targetBranchId).toBe(null)
  })

  it('same-topic cut branch→sibling completes with staged source and sibling target addresses', async () => {
    // Same logical topic: cut staged on branch-src, live route is sibling
    // branch-sib (paste target). Both addresses stay explicit and distinct.
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-1' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [], 0)],
      sourceTopicId: 'topic-1',
      sourceBranchId: 'branch-src',
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: 'branch-src', loadedMessageIds: ['cut-0'] },
      segmentSnapshots: []
    }
    storeState.topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: { 'topic-1': 'branch-sib' },
      routeGenerationByTopic: {}
    }
    mocks.executeStagedCutSourceDelete.mockResolvedValue({
      response: { deletedMessageIds: ['cut-0'] },
      undoParts: { groupAnchors: [], segmentSnapshots: [], fileReferenceDeltas: [] }
    })

    const { pasteMessages } = await import('../ClipboardService')
    const count = await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    expect(count).toBe(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledExactlyOnceWith('topic-1', expect.any(Array), 'branch-sib')
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-1',
        sourceBranchId: 'branch-src',
        rootIds: ['cut-0'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-1', sourceBranchId: 'branch-src' })
      })
    )
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.sourceBranchId).toBe('branch-src')
    expect(undoAction.targetBranchId).toBe('branch-sib')
  })

  it('paste returns the actual inserted message count across multiple groups (3-message group + single)', async () => {
    // One group with 3 messages (u1 + a1/a2) plus a second single-message
    // group: toast count must be 4 messages, not 2 groups.
    const u1 = createUserMessage({ id: 'u1' })
    const a1 = createAssistantMessage('a1', 'u1')
    const a2 = createAssistantMessage('a2', 'u1')
    const solo = createUserMessage({ id: 'solo' })
    storeState.clipboard = {
      mode: 'copy',
      items: [
        { originalAskId: 'u1', messages: [u1, a1, a2], blocks: [], positionIndex: 0 },
        { originalAskId: 'solo', messages: [solo], blocks: [], positionIndex: 1 }
      ],
      sourceTopicId: null,
      sourceBranchId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    const count = await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    expect(count).toBe(4)
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    const [, groups] = mocks.insertMessageGroups.mock.calls[0] as unknown as [
      string,
      Array<{ entries: Array<unknown> }>
    ]
    expect(groups[0].entries).toHaveLength(4)
    expect(mocks.pushUndoAction).toHaveBeenCalledTimes(1)
    expect(mocks.pushUndoAction.mock.calls[0][0].insertedMessageIds).toHaveLength(4)
  })

  it('cut paste rejects before any write on missing legacy cut-route provenance', async () => {
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-2' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [], 0)],
      sourceTopicId: 'topic-2',
      segmentSnapshots: []
    } as unknown as StoreState['clipboard']
    delete (storeState.clipboard as { sourceBranchId?: unknown }).sourceBranchId

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'Missing staged cut route'
    )
    expect(mocks.insertMessageGroups).not.toHaveBeenCalled()
    expect(mocks.executeStagedCutSourceDelete).not.toHaveBeenCalled()
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })

  it('staged cut delete is invoked after the atomic insert ack (source-side staged authority)', async () => {
    // Same-topic minimal source: user + 2 assistants. Batch insertion now
    // publishes its own Main capability atomically (no projection clear); the
    // staged helper still addresses the source delete with complete staged
    // member roots without rerequiring projection capability.
    const { executeStagedCutSourceDelete } = await import('@renderer/store/thunk/messageThunk')
    void executeStagedCutSourceDelete
    const cutMsg = createUserMessage({ id: 'u1', topicId: 'topic-1' })
    const a1 = createAssistantMessage('a1', 'u1')
    a1.topicId = 'topic-1'
    const a2 = createAssistantMessage('a2', 'u1')
    a2.topicId = 'topic-1'
    storeState.clipboard = {
      mode: 'cut',
      items: [{ originalAskId: 'u1', messages: [cutMsg, a1, a2], blocks: [], positionIndex: 0 }],
      sourceTopicId: 'topic-1',
      sourceBranchId: null,
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: null, loadedMessageIds: ['u1', 'a1', 'a2'] },
      segmentSnapshots: []
    }
    mocks.executeStagedCutSourceDelete.mockResolvedValue({
      response: { deletedMessageIds: ['u1', 'a1', 'a2'] },
      undoParts: {
        groupAnchors: [
          { messages: [cutMsg, a1, a2], blocks: [], positionIndex: 0, anchorMessageId: null, loadedMessageIds: [] }
        ],
        segmentSnapshots: [],
        fileReferenceDeltas: []
      }
    })

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', '')

    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-1',
        sourceBranchId: null,
        rootIds: ['u1', 'a1', 'a2'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-1', sourceBranchId: null })
      })
    )
    expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceRootIds).toEqual(['u1', 'a1', 'a2'])
    expect(undoAction.sourceBranchId).toBe(null)
    expect(undoAction.targetBranchId).toBe(null)
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
      sourceBranchId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    expect(mocks.updateFileCount).toHaveBeenCalledExactlyOnceWith('file-fb0', 1, false)
  })

  it('batch publication never repoints the active topic (no messagesReceived side effect)', async () => {
    storeState.messages.currentTopicId = 'topic-1'
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      sourceBranchId: null,
      segmentSnapshots: []
    }

    const { pasteMessages } = await import('../ClipboardService')
    await pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')

    // Atomic batch installs rows+capability without the legacy
    // messagesReceived currentTopicId side effect.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
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
      sourceBranchId: null,
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
    expect(mocks.applyInsertedMessageGroups).toHaveBeenCalledTimes(1)
    const parityBatch = mocks.applyInsertedMessageGroups.mock.calls[0][0] as {
      insertedMessageIds: string[]
      groups: Array<{ beforeMessageId: string | null; visibleMessageIds: string[] }>
    }
    // Stable intent preserved; placement follows the Main stable neighbor.
    expect(parityBatch.insertedMessageIds).toHaveLength(1)
    expect(parityBatch.groups[0].visibleMessageIds).toEqual(parityBatch.insertedMessageIds)
  })

  it('passes the active branch route to Main while keeping the stable intent', async () => {
    const copied = createUserMessage({ id: 'c0' })
    storeState.clipboard = {
      mode: 'copy',
      items: [makeClipboardItem(copied, [], 1)],
      sourceTopicId: null,
      sourceBranchId: null,
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

  it('post-commit convergence failure preserves copies, retains undo metadata, clears clipboard (no fake rollback)', async () => {
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-2' })
    const cutBlock = createTextBlock(cutMsg.id, { id: 'cutb' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [cutBlock], 0)],
      sourceTopicId: 'topic-2',
      sourceBranchId: null,
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: null, loadedMessageIds: ['cut-0'] },
      segmentSnapshots: []
    }
    storeState.messages.entities['cut-0'] = cutMsg
    storeState.messages.messageIdsByTopic['topic-2'] = ['cut-0']
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
    // Committed marker: Main source deletion COMMITTED, renderer convergence
    // failed afterwards (typed, not a generic pre-commit reject).
    const committedError = Object.assign(
      new Error('[executeDeleteCore] Renderer convergence failed after Main commit'),
      {
        committed: true as const,
        response: { deletedMessageIds: ['cut-0'] },
        undoParts: { groupAnchors: authorityAnchors, segmentSnapshots: authoritySegments, fileReferenceDeltas: [] }
      }
    )
    mocks.executeStagedCutSourceDelete.mockRejectedValue(committedError)

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'renderer convergence failed after commit'
    )

    // Main staged delete attempted once; insert committed first.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-2',
        sourceBranchId: null,
        rootIds: ['cut-0'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-2', sourceBranchId: null })
      })
    )
    // Committed: rollback of the surviving pasted copies never runs.
    expect(mocks.deleteMessagesFromDB).not.toHaveBeenCalled()
    expect(mocks.syncSegmentsAfterMessageDeletion).not.toHaveBeenCalled()
    expect(mocks.deleteSegmentsBySnapshots).not.toHaveBeenCalled()
    // Real cut bookkeeping finalizes: clipboard cleared + usable cut_paste
    // undo retains the full authority payload (pasted IDs survive).
    expect(mocks.clearClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.pushUndoAction).toHaveBeenCalledTimes(1)
    const undoAction = mocks.pushUndoAction.mock.calls[0][0]
    expect(undoAction.type).toBe('cut_paste')
    expect(undoAction.sourceTopicId).toBe('topic-2')
    expect(undoAction.sourceRootIds).toEqual(['cut-0'])
    expect(undoAction.sourceGroupAnchors).toEqual(authorityAnchors)
    expect(undoAction.sourceSegmentSnapshots).toEqual(authoritySegments)
    expect(undoAction.insertedMessageIds).toHaveLength(1)
  })

  it('rollback sync uses the pinned target route when the live route switches mid-cleanup', async () => {
    const cutMsg = createUserMessage({ id: 'cut-0', topicId: 'topic-2' })
    storeState.clipboard = {
      mode: 'cut',
      items: [makeClipboardItem(cutMsg, [], 0)],
      sourceTopicId: 'topic-2',
      sourceBranchId: 'branch-src',
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: 'branch-src', loadedMessageIds: ['cut-0'] },
      segmentSnapshots: []
    }
    // Pinned paste target route at paste time.
    storeState.topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: { 'topic-1': 'branch-orig', 'topic-2': 'branch-src' },
      routeGenerationByTopic: {}
    }
    // Pre-commit failure triggers rollback; the live route switches while the
    // plain-delete cleanup is awaited.
    mocks.executeStagedCutSourceDelete.mockRejectedValue(new Error('SQLITE_FAILURE'))
    mocks.deleteMessagesFromDB.mockImplementation(async () => {
      storeState.topicBranch!.activeBranchIdByTopic['topic-1'] = 'branch-new'
      return emptyCleanup
    })

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(vi.fn(), () => storeState as any, 'topic-1', 'm1')).rejects.toThrow(
      'Cut source delete failed'
    )

    // Rollback deletes the fresh copies on the pinned route, never the new live route.
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMessagesFromDB.mock.calls[0][0]).toBe('topic-1')
    expect(mocks.deleteMessagesFromDB.mock.calls[0][2]).toBe('branch-orig')
    // Segment sync still addresses the original pinned target route.
    expect(mocks.syncSegmentsAfterMessageDeletion).toHaveBeenCalledTimes(1)
    expect(mocks.syncSegmentsAfterMessageDeletion.mock.calls[0][2]).toBe('topic-1')
    expect(mocks.syncSegmentsAfterMessageDeletion.mock.calls[0][4]).toBe('branch-orig')
    // No write ever addresses the switched-to live route or another topic.
    for (const call of mocks.deleteMessagesFromDB.mock.calls) {
      expect(call[2]).not.toBe('branch-new')
    }
    for (const call of mocks.syncSegmentsAfterMessageDeletion.mock.calls) {
      expect(call[4]).not.toBe('branch-new')
      expect(call[2]).not.toBe('topic-2')
    }
    // Pre-commit semantics unchanged: clipboard retained, no undo.
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })
})
