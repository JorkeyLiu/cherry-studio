/**
 * ClipboardService cut depth gate (BRANCH-12) + delete/copy gate matrix.
 *
 * The `cutMessages` service entry carries its own fail-closed gate (the same
 * `requireEditSelectionMutable` the `useEditMode` caller applies), so direct
 * callers outside `useEditMode` cannot publish a `cut` clipboard or reach any
 * authority read / Main mutation. Copy stays ungated (read-only authority
 * read). `deleteSelectedMessages` gates the same way with zero IPC calls.
 *
 * Uses the REAL `editSelection` gate logic (no mock): states below publish a
 * loaded projection plus the Main-authoritative route capability, exactly as
 * the production renderer does.
 */

import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchClipboardGroups: vi.fn(),
    listSegments: vi.fn(),
    setClipboard: vi.fn((p: unknown) => ({ type: 'clipboard/setClipboard', payload: p })),
    executeDeleteMessagesWithDependents: vi.fn(),
    pushUndoAction: vi.fn((p: unknown) => ({ type: 'undoStack/pushUndoAction', payload: p }))
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

vi.mock('i18next', () => ({
  t: (k: string) => k
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchClipboardGroups: mocks.fetchClipboardGroups,
    listSegments: mocks.listSegments
  }
}))

vi.mock('@renderer/store/clipboard', () => ({
  clearClipboard: vi.fn(() => ({ type: 'clipboard/clearClipboard' })),
  setClipboard: mocks.setClipboard
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  executeDeleteMessagesWithDependents: mocks.executeDeleteMessagesWithDependents
}))

vi.mock('@renderer/store/undoStack', () => ({
  pushUndoAction: mocks.pushUndoAction
}))

// ── Fixtures ───────────────────────────────────────────────────────────────
// Two selectable groups: u1 = user u1 + assistant a1, u2 = user u2 alone.

const userMsg = (id: string): Message => ({ id, topicId: 'topic-1', role: 'user' }) as unknown as Message

const assistantMsg = (id: string, askId: string): Message =>
  ({ id, topicId: 'topic-1', role: 'assistant', askId }) as unknown as Message

const ENTITIES: Record<string, Message> = {
  u1: userMsg('u1'),
  a1: assistantMsg('a1', 'u1'),
  u2: userMsg('u2')
}

const LOADED_IDS = ['u1', 'a1', 'u2']

interface GateStateOpts {
  loadedIds?: string[]
  mutableIds?: string[] | undefined
  mutableRoute?: string | null | undefined
  activeRoute?: string | null
  selection?: string[]
}

function gateState(opts: GateStateOpts = {}): unknown {
  const { loadedIds = LOADED_IDS, mutableRoute = null, activeRoute = null, selection = ['u1'] } = opts
  // Explicit `mutableIds: undefined` means "no capability published" (unknown);
  // an absent key means the fully-owned default.
  const mutableIds = 'mutableIds' in opts ? opts.mutableIds : ['u1', 'a1', 'u2']
  return {
    messages: {
      entities: ENTITIES,
      messageIdsByTopic: { 'topic-1': loadedIds },
      mutableMessageIdsByTopic: mutableIds === undefined ? {} : { 'topic-1': mutableIds },
      mutableRouteByTopic: mutableRoute === undefined ? {} : { 'topic-1': mutableRoute }
    },
    topicBranch: { activeBranchIdByTopic: activeRoute === null ? {} : { 'topic-1': activeRoute } },
    editMode: { selectedGroupIds: selection }
  }
}

function clipboardResponseFor(groupIds: string[]) {
  const messages: Message[] = []
  const groups: Array<{ groupId: string; messageIds: string[]; positionIndex: number }> = []
  if (groupIds.includes('u1')) {
    messages.push(ENTITIES.u1, ENTITIES.a1)
    groups.push({ groupId: 'u1', messageIds: ['u1', 'a1'], positionIndex: 0 })
  }
  if (groupIds.includes('u2')) {
    messages.push(ENTITIES.u2)
    groups.push({ groupId: 'u2', messageIds: ['u2'], positionIndex: 2 })
  }
  return {
    messages,
    blocks: [],
    groups,
    clipboard: {
      completeness: 'clipboard-groups' as const,
      topicId: 'topic-1',
      requestedCount: groupIds.length,
      returnedCount: groups.length,
      returnedMessageCount: messages.length,
      firstMessageId: messages.length > 0 ? messages[0].id : null,
      lastMessageId: messages.length > 0 ? messages[messages.length - 1].id : null
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ClipboardService.cutMessages service-level depth gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchClipboardGroups.mockImplementation(async (req: { groupIds: string[] }) =>
      clipboardResponseFor(req.groupIds)
    )
    mocks.listSegments.mockResolvedValue([])
  })

  it('fully owned selection publishes mode=cut with the requested branchId', async () => {
    const { cutMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()

    const count = await cutMessages(dispatch, () => gateState() as never, 'topic-1', ['u1'], 'b1')

    expect(count).toBe(2)
    expect(mocks.fetchClipboardGroups).toHaveBeenCalledExactlyOnceWith({
      topicId: 'topic-1',
      branchId: 'b1',
      groupIds: ['u1']
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const action = dispatch.mock.calls[0][0]
    expect(action.type).toBe('clipboard/setClipboard')
    expect(action.payload.mode).toBe('cut')
    expect(action.payload.sourceTopicId).toBe('topic-1')
  })

  it.each([
    ['immutable member', { mutableIds: ['u1', 'u2'], selection: ['u1'] } as GateStateOpts],
    ['mixed owned/non-owned selection', { mutableIds: ['u1', 'a1'], selection: ['u1', 'u2'] } as GateStateOpts]
  ])('fail-closed with zero reads/publication on %s', async (_label, override) => {
    const { cutMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()
    const getState = () => gateState(override) as never

    const count = await cutMessages(dispatch, getState, 'topic-1', override.selection!)

    expect(count).toBe(0)
    expect(mocks.fetchClipboardGroups).not.toHaveBeenCalled()
    expect(mocks.listSegments).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(mocks.setClipboard).not.toHaveBeenCalled()
  })

  it('fail-closed on unknown capability, ghost selection, and route mismatch', async () => {
    const { cutMessages } = await import('../ClipboardService')

    // Unknown capability (no mutable set published for the topic).
    expect(await cutMessages(vi.fn(), () => gateState({ mutableIds: undefined }) as never, 'topic-1', ['u1'])).toBe(0)
    // Ghost selection id absent from the loaded projection.
    expect(await cutMessages(vi.fn(), () => gateState() as never, 'topic-1', ['ghost'])).toBe(0)
    // Route-switch residue: capability belongs to another route.
    expect(await cutMessages(vi.fn(), () => gateState({ activeRoute: 'b1' }) as never, 'topic-1', ['u1'])).toBe(0)

    expect(mocks.fetchClipboardGroups).not.toHaveBeenCalled()
    expect(mocks.listSegments).not.toHaveBeenCalled()
    expect(mocks.setClipboard).not.toHaveBeenCalled()
  })

  it('empty selection performs no authority reads and publishes nothing', async () => {
    const { cutMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()

    expect(await cutMessages(dispatch, () => gateState() as never, 'topic-1', [])).toBe(0)
    expect(mocks.fetchClipboardGroups).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('ClipboardService copy stays ungated / delete gates with zero IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchClipboardGroups.mockImplementation(async (req: { groupIds: string[] }) =>
      clipboardResponseFor(req.groupIds)
    )
    mocks.listSegments.mockResolvedValue([])
  })

  it('copy still reads and publishes on an immutable selection', async () => {
    const { copyMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()

    // a1 non-owned through this route — cut would refuse, copy must still work.
    const count = await copyMessages(dispatch, 'topic-1', ['u1'])

    expect(count).toBe(2)
    expect(mocks.fetchClipboardGroups).toHaveBeenCalledExactlyOnceWith({
      topicId: 'topic-1',
      branchId: null,
      groupIds: ['u1']
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].payload.mode).toBe('copy')
  })

  it('deleteSelectedMessages is fail-closed with zero IPC on immutable/mixed/unknown selections', async () => {
    const { deleteSelectedMessages } = await import('../ClipboardService')

    expect(
      await deleteSelectedMessages(vi.fn(), () => gateState({ mutableIds: ['u1', 'u2'] }) as never, 'topic-1', ['u1'])
    ).toBe(0)
    expect(
      await deleteSelectedMessages(
        vi.fn(),
        () => gateState({ mutableIds: ['u1', 'a1'], selection: ['u1', 'u2'] }) as never,
        'topic-1',
        ['u1', 'u2']
      )
    ).toBe(0)
    expect(
      await deleteSelectedMessages(vi.fn(), () => gateState({ mutableIds: undefined }) as never, 'topic-1', ['u1'])
    ).toBe(0)
    expect(await deleteSelectedMessages(vi.fn(), () => gateState() as never, 'topic-1', ['ghost'])).toBe(0)

    expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })

  it('deleteSelectedMessages calls the semantic helper once on a fully owned selection', async () => {
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue({
      response: { deletedMessageIds: ['u1', 'a1'] },
      undoParts: { groupAnchors: [], segmentSnapshots: [], fileReferenceDeltas: [] }
    })
    const { deleteSelectedMessages } = await import('../ClipboardService')
    const dispatch = vi.fn() as never

    const count = await deleteSelectedMessages(dispatch, () => gateState() as never, 'topic-1', ['u1'])

    expect(count).toBe(2)
    expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(
      dispatch,
      expect.any(Function),
      'topic-1',
      ['u1']
    )
  })
})
