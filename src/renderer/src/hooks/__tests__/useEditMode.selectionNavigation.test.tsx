import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { setSelectedGroupIds, toggleEditMode } from '@renderer/store/editMode'
import { selectIsEditSelectionMutable } from '@renderer/store/editSelection'
import type * as NewMessageStore from '@renderer/store/newMessage'
import { newMessagesActions } from '@renderer/store/newMessage'
import { activeBranchSet } from '@renderer/store/topicBranch'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadedMessages, loggerMock, snapshotLoader } = vi.hoisted(() => ({
  loadedMessages: { current: [] as Message[] },
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() },
  snapshotLoader: { current: vi.fn<(topicId: string, branchId?: string | null) => Promise<unknown>>() }
}))

vi.mock('@logger', () => ({ loggerService: { withContext: () => loggerMock } }))
// Caller-local whole-route snapshot read: the hook must not fall back to the
// loaded projection when a Shift endpoint lies outside the rendered window.
vi.mock('@renderer/utils/topicSnapshot', () => ({
  loadWholeTopicSnapshot: (...args: unknown[]) => snapshotLoader.current(...(args as [string, string?]))
}))
vi.mock('@renderer/services/ClipboardService', () => ({
  copyMessages: vi.fn(),
  cutMessages: vi.fn(),
  deleteSelectedMessages: vi.fn(),
  pasteMessages: vi.fn()
}))
vi.mock('@renderer/services/UndoService', () => ({ executeRedo: vi.fn(), executeUndo: vi.fn() }))
vi.mock('@renderer/store/newMessage', async () => {
  const actual = await vi.importActual<typeof NewMessageStore>('@renderer/store/newMessage')
  return { ...actual, selectLoadedMessagesForTopic: () => loadedMessages.current }
})

const { useCreateEditMode } = await import('../useEditMode')
const topicId = 'selection-navigation-topic'
const groupIds = ['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4']

function makeMessages(): Message[] {
  return groupIds.flatMap((id, index) => [
    {
      id,
      topicId,
      role: 'user',
      assistantId: 'synthetic-assistant',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: UserMessageStatus.SUCCESS,
      blocks: []
    },
    {
      id: `assistant-${index}`,
      topicId,
      askId: id,
      role: 'assistant',
      assistantId: 'synthetic-assistant',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: AssistantMessageStatus.SUCCESS,
      blocks: []
    }
  ])
}

function makeStore() {
  return configureStore({ reducer: rootReducer })
}

const wrapperFor =
  (store: ReturnType<typeof makeStore>) =>
  ({ children }: { children: React.ReactNode }) =>
    createElement(Provider, { store, children } as never)
const readState = (store: ReturnType<typeof makeStore>) => store.getState().editMode

const olderMessages = (): Message[] =>
  ['older-0', 'older-1'].flatMap((id, index) => [
    {
      id,
      topicId,
      role: 'user' as const,
      assistantId: 'synthetic-assistant',
      createdAt: `2025-12-31T23:5${index}:00.000Z`,
      status: UserMessageStatus.SUCCESS,
      blocks: []
    },
    {
      id: `assistant-${id}`,
      topicId,
      askId: id,
      role: 'assistant' as const,
      assistantId: 'synthetic-assistant',
      createdAt: `2025-12-31T23:5${index}:01.000Z`,
      status: AssistantMessageStatus.SUCCESS,
      blocks: []
    }
  ])

describe('useCreateEditMode Shift+arrow selection navigation', () => {
  beforeEach(() => (loadedMessages.current = makeMessages()))

  it('keeps the clicked turn as anchor while extending, contracting, and crossing it', () => {
    const store = makeStore()
    const { result, unmount } = renderHook(() => useCreateEditMode(topicId), { wrapper: wrapperFor(store) })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-2', false, false))
    expect(readState(store)).toMatchObject({ selectedGroupIds: ['turn-2'], lastSelectedIndex: 2, focusedIndex: 2 })

    act(() => result.current.handleExtendSelection('up'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-1', 'turn-2'],
      lastSelectedIndex: 2,
      focusedIndex: 1
    })
    act(() => result.current.handleExtendSelection('up'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-0', 'turn-1', 'turn-2'],
      lastSelectedIndex: 2,
      focusedIndex: 0
    })
    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-1', 'turn-2'],
      lastSelectedIndex: 2,
      focusedIndex: 1
    })
    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store)).toMatchObject({ selectedGroupIds: ['turn-2'], lastSelectedIndex: 2, focusedIndex: 2 })
    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-2', 'turn-3'],
      lastSelectedIndex: 2,
      focusedIndex: 3
    })
    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-2', 'turn-3', 'turn-4'],
      lastSelectedIndex: 2,
      focusedIndex: 4
    })
    act(() => result.current.handleExtendSelection('up'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-2', 'turn-3'],
      lastSelectedIndex: 2,
      focusedIndex: 3
    })
    unmount()
  })

  it('continues from stable anchor and endpoint after older loaded groups are prepended', () => {
    const store = makeStore()
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), { wrapper: wrapperFor(store) })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-3', false, false))
    act(() => result.current.handleExtendSelection('up'))
    expect(readState(store).selectedGroupIds).toEqual(['turn-2', 'turn-3'])

    loadedMessages.current = [...olderMessages(), ...loadedMessages.current]
    rerender()
    act(() => result.current.handleExtendSelection('up'))
    expect(readState(store).selectedGroupIds).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(readState(store)).toMatchObject({
      lastSelectedIndex: 5,
      focusedIndex: 3,
      anchorGroupId: 'turn-3',
      focusedGroupId: 'turn-1'
    })
    unmount()
  })

  it('advances one loaded turn per call and clamps at loaded-group edges', () => {
    const store = makeStore()
    const scrollToGroup = vi.fn()
    const { result, unmount } = renderHook(() => useCreateEditMode(topicId, scrollToGroup), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))

    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-1', 'turn-2'],
      lastSelectedIndex: 1,
      focusedIndex: 2
    })
    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-1', 'turn-2', 'turn-3'],
      lastSelectedIndex: 1,
      focusedIndex: 3
    })
    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-1', 'turn-2', 'turn-3', 'turn-4'],
      lastSelectedIndex: 1,
      focusedIndex: 4
    })
    expect(scrollToGroup).toHaveBeenLastCalledWith('turn-4')

    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-1', 'turn-2', 'turn-3', 'turn-4'],
      lastSelectedIndex: 1,
      focusedIndex: 4
    })
    expect(scrollToGroup).toHaveBeenCalledTimes(3)
    unmount()
  })
})
describe('useCreateEditMode Shift+arrow boundary paging', () => {
  beforeEach(() => (loadedMessages.current = makeMessages()))

  it('names a bounded older page at the displayed edge and resumes on the next repeat', () => {
    const store = makeStore()
    const requestBoundaryPage = vi.fn(() => Promise.resolve(true))
    // Displayed window (rendered groups) is narrower than the loaded projection:
    // the selection edge is the DISPLAYED edge, not a physical scroll position.
    let visible = new Set(['turn-1', 'turn-2', 'turn-3'])
    const { result, rerender, unmount } = renderHook(
      () => useCreateEditMode(topicId, undefined, visible, requestBoundaryPage),
      { wrapper: wrapperFor(store) }
    )
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-2', false, false))
    act(() => result.current.handleExtendSelection('up'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-1', 'turn-2'],
      anchorGroupId: 'turn-2',
      focusedGroupId: 'turn-1'
    })

    // Endpoint is already the oldest displayed group: the key cannot advance, so
    // the selection's own direction becomes ONE page request — no selection
    // change, no synthetic scroll, no focus movement.
    act(() => result.current.handleExtendSelection('up'))
    expect(requestBoundaryPage).toHaveBeenCalledTimes(1)
    expect(requestBoundaryPage).toHaveBeenLastCalledWith('older')
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-1', 'turn-2'],
      lastSelectedIndex: 1,
      focusedIndex: 0,
      anchorGroupId: 'turn-2',
      focusedGroupId: 'turn-1'
    })

    // Repeat keydown while that page is still in flight: merged, never a second
    // request, and never a selection change from stale indices.
    act(() => result.current.handleExtendSelection('up'))
    expect(requestBoundaryPage).toHaveBeenCalledTimes(2)
    expect(readState(store).selectedGroupIds).toEqual(['turn-1', 'turn-2'])

    // Committed page: the displayed window grew by the older page (same commit as
    // the loaded window), so the next genuine repeat continues from the stable
    // anchor/endpoint ids and crosses the previous display boundary.
    visible = new Set(['turn-0', 'turn-1', 'turn-2', 'turn-3'])
    rerender()
    act(() => result.current.handleExtendSelection('up'))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-0', 'turn-1', 'turn-2'],
      lastSelectedIndex: 2,
      focusedIndex: 0,
      anchorGroupId: 'turn-2',
      focusedGroupId: 'turn-0'
    })
    expect(requestBoundaryPage).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('names a bounded newer page at the opposite displayed edge', () => {
    const store = makeStore()
    const requestBoundaryPage = vi.fn(() => Promise.resolve(true))
    const visible = new Set(['turn-1', 'turn-2', 'turn-3'])
    const { result, unmount } = renderHook(() => useCreateEditMode(topicId, undefined, visible, requestBoundaryPage), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-2', false, false))
    act(() => result.current.handleExtendSelection('down'))
    expect(readState(store).selectedGroupIds).toEqual(['turn-2', 'turn-3'])
    act(() => result.current.handleExtendSelection('down'))
    expect(requestBoundaryPage).toHaveBeenCalledTimes(1)
    expect(requestBoundaryPage).toHaveBeenLastCalledWith('newer')
    expect(readState(store)).toMatchObject({ selectedGroupIds: ['turn-2', 'turn-3'], focusedGroupId: 'turn-3' })
    unmount()
  })

  it('never mutates the selection when a boundary page settles later', async () => {
    const store = makeStore()
    let settlePage: (started: boolean) => void = () => {}
    const requestBoundaryPage = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settlePage = resolve
        })
    )
    let visible = new Set(['turn-0', 'turn-1', 'turn-2'])
    const { result, rerender, unmount } = renderHook(
      () => useCreateEditMode(topicId, undefined, visible, requestBoundaryPage),
      { wrapper: wrapperFor(store) }
    )
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))
    act(() => result.current.handleExtendSelection('up'))
    expect(readState(store).selectedGroupIds).toEqual(['turn-0', 'turn-1'])
    act(() => result.current.handleExtendSelection('up'))
    expect(requestBoundaryPage).toHaveBeenCalledTimes(1)

    // The user reverses / releases before the page settles: the settled page must
    // not reach back into the selection.
    act(() => result.current.handleExtendSelection('down'))
    const afterReverse = readState(store)
    expect(afterReverse.selectedGroupIds).toEqual(['turn-1'])
    visible = new Set(['turn-0', 'turn-1', 'turn-2', 'turn-3'])
    rerender()
    await act(async () => {
      settlePage(true)
      await Promise.resolve()
    })
    expect(readState(store)).toEqual(afterReverse)
    unmount()
  })
})

describe('useCreateEditMode Shift+arrow atomic range step', () => {
  beforeEach(() => (loadedMessages.current = makeMessages()))

  it('publishes each step as one consistent selection update and nothing on a clamped key', () => {
    const store = makeStore()
    const requestBoundaryPage = vi.fn(() => Promise.resolve(true))
    const visible = new Set(['turn-0', 'turn-1', 'turn-2'])
    const { result, unmount } = renderHook(() => useCreateEditMode(topicId, undefined, visible, requestBoundaryPage), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))

    // Every published snapshot carries range + stable ids together: no
    // subscriber may see a new range paired with the previous endpoint id.
    const snapshots: Array<{ range: string[]; anchor: string | null; focused: string | null }> = []
    const unsubscribe = store.subscribe(() => {
      const state = store.getState().editMode
      snapshots.push({
        range: [...state.selectedGroupIds],
        anchor: state.anchorGroupId ?? null,
        focused: state.focusedGroupId ?? null
      })
    })

    act(() => result.current.handleExtendSelection('up'))
    expect(snapshots).toEqual([{ range: ['turn-0', 'turn-1'], anchor: 'turn-1', focused: 'turn-0' }])

    // Edge key: the endpoint cannot advance, so it names one bounded page and
    // publishes no selection at all (the last valid endpoint is preserved).
    act(() => result.current.handleExtendSelection('up'))
    expect(requestBoundaryPage).toHaveBeenCalledTimes(1)
    expect(snapshots).toHaveLength(1)
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-0', 'turn-1'],
      anchorGroupId: 'turn-1',
      focusedGroupId: 'turn-0'
    })

    unsubscribe()
    unmount()
  })
})

/**
 * Viewport navigation (e.g. the chat "back to bottom" control) only moves the
 * rendered window. The edit selection is authority-level state and must keep
 * showing in the edit UI afterwards: deriving the selected groups from the
 * narrowed rendered-window set made a still-present selection report as
 * `0 selected` the moment its turn left the window.
 */
describe('useCreateEditMode selection across rendered-window navigation', () => {
  beforeEach(() => (loadedMessages.current = makeMessages()))

  it('keeps the selected groups and their message count when the turn leaves the rendered window', () => {
    const store = makeStore()
    let visible = new Set(['turn-1', 'turn-2', 'turn-3'])
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId, undefined, visible), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-2', false, false))

    const countOf = () => result.current.selectedGroups.reduce((sum, g) => sum + g.messages.length, 0)
    expect(result.current.selectedGroups.map((g) => g.askId)).toEqual(['turn-2'])
    expect(countOf()).toBe(2)

    // Explicit bottom navigation: the rendered window moves away from the
    // selected turn while edit mode and the selection stay enabled.
    visible = new Set(['turn-3', 'turn-4'])
    rerender()
    expect(result.current.groups.map((g) => g.askId)).toEqual(['turn-3', 'turn-4'])
    expect(readState(store).selectedGroupIds).toEqual(['turn-2'])
    expect(result.current.selectedGroups.map((g) => g.askId)).toEqual(['turn-2'])
    expect(countOf()).toBe(2)
    unmount()
  })
})

// -----------------------------------------------------------------------------
// Cross-window Shift range
//
// Selecting a distant turn, navigating away (the rendered/loaded window moves),
// and Shift-clicking the newest turn must select the whole closed interval on
// the current route — including turns that were never loaded — instead of
// silently doing nothing or only covering the currently rendered window.
// -----------------------------------------------------------------------------
const routeGroupIds = ['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']

function sessionMessages(ids: string[]): Message[] {
  return ids.flatMap((id) => [
    {
      id,
      topicId,
      role: 'user' as const,
      assistantId: 'synthetic-assistant',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: UserMessageStatus.SUCCESS,
      blocks: []
    },
    {
      id: `answer-${id}`,
      topicId,
      askId: id,
      role: 'assistant' as const,
      assistantId: 'synthetic-assistant',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: AssistantMessageStatus.SUCCESS,
      blocks: []
    }
  ])
}

function wholeRouteSnapshot(ids: string[]) {
  return {
    messages: sessionMessages(ids),
    blocks: [],
    blocksById: new Map(),
    snapshot: {} as never
  }
}

const selectedIds = (store: ReturnType<typeof makeStore>) => readState(store).selectedGroupIds
const resolvedIds = (result: { current: { selectedGroups: Array<{ askId: string }> } }) =>
  result.current.selectedGroups.map((group) => group.askId)
const selectedMessageCount = (result: { current: { selectedGroups: Array<{ messages: Message[] }> } }) =>
  result.current.selectedGroups.reduce((sum, group) => sum + group.messages.length, 0)

describe('useCreateEditMode cross-window Shift range', () => {
  beforeEach(() => {
    loadedMessages.current = sessionMessages(routeGroupIds)
    loggerMock.warn.mockClear()
    snapshotLoader.current.mockReset()
  })

  it('selects the whole closed range, including turns that are no longer loaded', async () => {
    const store = makeStore()
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))
    expect(selectedIds(store)).toEqual(['turn-1'])

    // Navigation ("back to bottom") moves the rendered/loaded window to the
    // newest turns: the anchor turn is no longer part of either.
    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    rerender()
    expect(result.current.groups.map((group) => group.askId)).toEqual(['turn-4', 'turn-5'])

    snapshotLoader.current.mockResolvedValue(wholeRouteSnapshot(routeGroupIds))
    act(() => result.current.handleGroupClick('turn-5', false, true))

    await vi.waitFor(() => expect(selectedIds(store)).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']))
    // Whole-topic read is caller-local and route-scoped (main route = null).
    expect(snapshotLoader.current).toHaveBeenCalledWith(topicId, null)
    // Display view resolves the same closed range, so the toolbar count covers
    // turns the loaded projection does not have.
    expect(resolvedIds(result)).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5'])
    expect(selectedMessageCount(result)).toBe(10)
    // The stable anchor and the loaded focus indices are untouched by a Shift click.
    expect(readState(store)).toMatchObject({
      anchorGroupId: 'turn-1',
      lastSelectedIndex: 1,
      focusedIndex: 1,
      focusedGroupId: 'turn-1'
    })
    // The complete snapshot never becomes part of the ordinary Redux projection.
    expect(Object.keys(store.getState().messages.entities)).toHaveLength(0)
    expect(loggerMock.warn).not.toHaveBeenCalled()
    unmount()
  })

  it('resolves a backwards Shift click in authority order, not click order', async () => {
    const store = makeStore()
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-4', false, false))
    expect(selectedIds(store)).toEqual(['turn-4'])

    loadedMessages.current = sessionMessages(['turn-0', 'turn-1'])
    rerender()

    snapshotLoader.current.mockResolvedValue(wholeRouteSnapshot(routeGroupIds))
    act(() => result.current.handleGroupClick('turn-1', false, true))

    await vi.waitFor(() => expect(selectedIds(store)).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4']))
    expect(resolvedIds(result)).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4'])
    expect(selectedMessageCount(result)).toBe(8)
    unmount()
  })

  it('reads the snapshot for the active route only', async () => {
    const store = makeStore()
    act(() => void store.dispatch(activeBranchSet({ topicId, branchId: 'branch-a' })))
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))

    loadedMessages.current = sessionMessages(['turn-5'])
    rerender()

    snapshotLoader.current.mockResolvedValue(wholeRouteSnapshot(routeGroupIds))
    act(() => result.current.handleGroupClick('turn-5', false, true))

    await vi.waitFor(() => expect(selectedIds(store)).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']))
    expect(snapshotLoader.current).toHaveBeenCalledWith(topicId, 'branch-a')
    unmount()
  })

  it('keeps the previous selection when the anchor is missing from the route snapshot', async () => {
    const store = makeStore()
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))

    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    rerender()

    // The route no longer carries the anchor: never publish a guessed partial range.
    snapshotLoader.current.mockResolvedValue(wholeRouteSnapshot(['turn-4', 'turn-5']))
    act(() => result.current.handleGroupClick('turn-5', false, true))

    await vi.waitFor(() => expect(loggerMock.warn).toHaveBeenCalled())
    expect(selectedIds(store)).toEqual(['turn-1'])
    expect(readState(store)).toMatchObject({ anchorGroupId: 'turn-1', focusedGroupId: 'turn-1' })
    unmount()
  })

  it('keeps the previous selection when the whole-route read fails', async () => {
    const store = makeStore()
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))

    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    rerender()

    snapshotLoader.current.mockRejectedValue(new Error('snapshot unavailable'))
    act(() => result.current.handleGroupClick('turn-5', false, true))

    await vi.waitFor(() => expect(loggerMock.warn).toHaveBeenCalled())
    expect(selectedIds(store)).toEqual(['turn-1'])
    unmount()
  })

  it('does not let a late range result replace a newer ordinary selection', async () => {
    const store = makeStore()
    let settle: (value: unknown) => void = () => {}
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))

    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    rerender()

    snapshotLoader.current.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    act(() => result.current.handleGroupClick('turn-5', false, true))

    // The user changes their mind before the read settles.
    act(() => result.current.handleGroupClick('turn-4', false, false))
    expect(selectedIds(store)).toEqual(['turn-4'])

    await act(async () => {
      settle(wholeRouteSnapshot(routeGroupIds))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(selectedIds(store)).toEqual(['turn-4'])
    expect(resolvedIds(result)).toEqual(['turn-4'])
    unmount()
  })

  it('does not let a late range result survive leaving edit mode', async () => {
    const store = makeStore()
    let settle: (value: unknown) => void = () => {}
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))

    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    rerender()

    snapshotLoader.current.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    act(() => result.current.handleGroupClick('turn-5', false, true))

    act(() => void store.dispatch(toggleEditMode(false)))
    await act(async () => {
      settle(wholeRouteSnapshot(routeGroupIds))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(selectedIds(store)).toEqual([])
    expect(result.current.selectedGroups).toEqual([])
    unmount()
  })

  it('does not let a late range result survive a topic or route switch', async () => {
    const store = makeStore()
    let settleBranch: (value: unknown) => void = () => {}
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))

    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    rerender()

    snapshotLoader.current.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleBranch = resolve
        })
    )
    act(() => result.current.handleGroupClick('turn-5', false, true))
    act(() => void store.dispatch(activeBranchSet({ topicId, branchId: 'branch-b' })))
    expect(selectedIds(store)).toEqual([])

    await act(async () => {
      settleBranch(wholeRouteSnapshot(routeGroupIds))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(selectedIds(store)).toEqual([])
    unmount()
  })

  // ---- Selection intent vs a late range result ----
  //
  // A pending cross-window range may only land on the intent that issued it.
  // Comparing selection state is not enough: the user can clear the selection,
  // leave edit mode, or re-select the very same anchor, and the resulting state
  // is then indistinguishable from the request's baseline.

  it('drops a pending range result after the selection is cleared', async () => {
    const store = makeStore()
    let settlePending: (value: unknown) => void = () => {}
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))
    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    rerender()
    snapshotLoader.current.mockImplementation(
      () =>
        new Promise((resolve) => {
          settlePending = resolve
        })
    )
    act(() => result.current.handleGroupClick('turn-5', false, true))
    expect(snapshotLoader.current).toHaveBeenCalledTimes(1)

    act(() => result.current.handleClearSelection())
    expect(selectedIds(store)).toEqual([])

    await act(async () => {
      settlePending(wholeRouteSnapshot(routeGroupIds))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(selectedIds(store)).toEqual([])
    expect(resolvedIds(result)).toEqual([])
    unmount()
  })

  it('keeps only the newest of several pending ranges, in any completion order', async () => {
    const store = makeStore()
    const settlements: Array<(value: unknown) => void> = []
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))
    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    rerender()
    snapshotLoader.current.mockImplementation(
      () =>
        new Promise((resolve) => {
          settlements.push(resolve)
        })
    )
    // Two Shift clicks in quick succession, both crossing the rendered window.
    act(() => result.current.handleGroupClick('turn-5', false, true))
    act(() => result.current.handleGroupClick('turn-3', false, true))
    expect(snapshotLoader.current).toHaveBeenCalledTimes(2)

    // The newest request resolves first…
    await act(async () => {
      settlements[1](wholeRouteSnapshot(routeGroupIds))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(selectedIds(store)).toEqual(['turn-1', 'turn-2', 'turn-3'])

    // …and the older one lands late: it must change nothing.
    await act(async () => {
      settlements[0](wholeRouteSnapshot(routeGroupIds))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(selectedIds(store)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(resolvedIds(result)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    unmount()
  })

  it('drops a pending range after the user re-establishes an identical selection', async () => {
    const store = makeStore()
    let settlePending: (value: unknown) => void = () => {}
    // Everything stays loaded; only the RENDERED window moves, so the anchor is
    // clickable again after navigating back.
    let visible = new Set(['turn-0', 'turn-1', 'turn-2'])
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId, undefined, visible), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-1', false, false))
    const baseline = readState(store)
    expect(baseline).toMatchObject({ selectedGroupIds: ['turn-1'], anchorGroupId: 'turn-1' })

    // Navigate to the newest turns: the anchor is no longer rendered, so the
    // Shift click has to resolve the range from the complete route read.
    visible = new Set(['turn-4', 'turn-5'])
    rerender()
    snapshotLoader.current.mockImplementation(
      () =>
        new Promise((resolve) => {
          settlePending = resolve
        })
    )
    act(() => result.current.handleGroupClick('turn-5', false, true))
    expect(snapshotLoader.current).toHaveBeenCalledTimes(1)

    // Leave edit mode, come back, navigate back and select the same turn again:
    // the resulting selection and anchor are identical to the request's baseline.
    act(() => void store.dispatch(toggleEditMode(false)))
    act(() => void store.dispatch(toggleEditMode(true)))
    visible = new Set(['turn-0', 'turn-1', 'turn-2'])
    rerender()
    act(() => result.current.handleGroupClick('turn-1', false, false))
    const rebuilt = readState(store)
    expect(rebuilt.selectedGroupIds).toEqual(baseline.selectedGroupIds)
    expect(rebuilt.anchorGroupId).toBe(baseline.anchorGroupId)
    expect(rebuilt.selectedGroupIds).toEqual(['turn-1'])

    await act(async () => {
      settlePending(wholeRouteSnapshot(routeGroupIds))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(selectedIds(store)).toEqual(['turn-1'])
    expect(resolvedIds(result)).toEqual(['turn-1'])
    unmount()
  })

  it('keeps the write gate closed when the selection reaches turns outside the projection', () => {
    const loadedTurns = ['turn-2', 'turn-3', 'turn-4']
    loadedMessages.current = sessionMessages(loadedTurns)
    const store = makeStore()
    const { result, unmount } = renderHook(() => useCreateEditMode(topicId), { wrapper: wrapperFor(store) })
    // Main-issued capability for the active route, committed through the
    // production window action (loaded projection + mutable message ids).
    act(() => {
      store.dispatch(
        newMessagesActions.messagesWindowMerged({
          topicId,
          messages: sessionMessages(loadedTurns),
          route: null,
          mutableMessageIds: sessionMessages(loadedTurns).map((message) => message.id)
        })
      )
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-3', false, false))
    // Non-vacuous: a fully loaded, fully owned selection IS writable.
    expect(result.current.isSelectionMutable).toBe(true)
    expect(selectIsEditSelectionMutable(store.getState(), topicId, ['turn-3'])).toBe(true)

    // A cross-window range reaches turns the loaded projection does not have, so
    // their capability is unknown: the whole batch fails closed.
    act(() => void store.dispatch(setSelectedGroupIds(['turn-2', 'turn-3', 'turn-0'])))
    expect(result.current.isSelectionMutable).toBe(false)
    expect(selectIsEditSelectionMutable(store.getState(), topicId, ['turn-2', 'turn-3', 'turn-0'])).toBe(false)
    // The gate keys on the exact requested set, so the owned subset stays writable.
    expect(selectIsEditSelectionMutable(store.getState(), topicId, ['turn-2', 'turn-3'])).toBe(true)
    unmount()
  })
})

/**
 * Older-page paging ("load more" history) is a projection growth, not a
 * selection gesture: the merge action replaces the loaded ID list and re-derives
 * the bounded display window, and it never dispatches an edit-mode action. The
 * selection, its anchor/focus ids and the edit toolbar count must survive the
 * merge, and a later Shift click must still extend from the original anchor.
 */
describe('useCreateEditMode selection across an older page merge', () => {
  beforeEach(() => {
    loggerMock.warn.mockClear()
    snapshotLoader.current.mockReset()
  })

  it('keeps a single selection and its anchor when an older page is prepended and the display window moves', () => {
    loadedMessages.current = sessionMessages(['turn-2', 'turn-3', 'turn-4'])
    let visible = new Set(['turn-2', 'turn-3', 'turn-4'])
    const store = makeStore()
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId, undefined, visible), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-3', false, false))
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-3'],
      anchorGroupId: 'turn-3',
      focusedGroupId: 'turn-3'
    })

    // Older page merged: the loaded projection gains the page, the bounded
    // display window is re-derived (older edge grows, newest edge trimmed).
    loadedMessages.current = sessionMessages(['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4'])
    visible = new Set(['turn-0', 'turn-1', 'turn-2', 'turn-3'])
    rerender()

    // Nothing was cleared and nothing was re-pointed by the merge.
    expect(readState(store)).toMatchObject({
      selectedGroupIds: ['turn-3'],
      anchorGroupId: 'turn-3',
      focusedGroupId: 'turn-3',
      lastSelectedIndex: 1,
      focusedIndex: 1
    })
    expect(resolvedIds(result)).toEqual(['turn-3'])
    expect(selectedMessageCount(result)).toBe(2)

    // A Shift click still extends from the ORIGINAL anchor after the merge.
    act(() => result.current.handleGroupClick('turn-0', false, true))
    expect(selectedIds(store)).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3'])
    expect(resolvedIds(result)).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3'])
    expect(readState(store).anchorGroupId).toBe('turn-3')
    // Both endpoints were rendered, so no complete-route read was needed.
    expect(snapshotLoader.current).not.toHaveBeenCalled()
    unmount()
  })

  it('is untouched by the real window-merge commit, for one and for several selected turns', () => {
    loadedMessages.current = sessionMessages(['turn-2', 'turn-3', 'turn-4'])
    const visible = new Set(['turn-2', 'turn-3', 'turn-4'])
    const store = makeStore()
    const { result, unmount } = renderHook(() => useCreateEditMode(topicId, undefined, visible), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-2', false, false))
    act(() => result.current.handleGroupClick('turn-3', true, false))
    expect(selectedIds(store)).toEqual(['turn-2', 'turn-3'])

    const beforeMerge = readState(store)
    act(() => {
      store.dispatch(
        newMessagesActions.messagesWindowMerged({
          topicId,
          messages: sessionMessages(['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4']),
          route: null,
          mutableMessageIds: []
        })
      )
    })
    // The production pagination commit is selection-neutral.
    expect(readState(store)).toEqual(beforeMerge)
    expect(store.getState().messages.messageIdsByTopic[topicId]).toEqual(
      sessionMessages(['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4']).map((message) => message.id)
    )
    expect(resolvedIds(result)).toEqual(['turn-2', 'turn-3'])
    expect(selectedMessageCount(result)).toBe(4)
    unmount()
  })

  it('keeps a range selection and continues from the original anchor after the merge re-projects the window', async () => {
    // Start at the newest window with the older turns not loaded at all.
    loadedMessages.current = sessionMessages(['turn-4', 'turn-5'])
    let visible = new Set(['turn-4', 'turn-5'])
    const store = makeStore()
    const { result, rerender, unmount } = renderHook(() => useCreateEditMode(topicId, undefined, visible), {
      wrapper: wrapperFor(store)
    })
    act(() => void store.dispatch(toggleEditMode(true)))
    act(() => result.current.handleGroupClick('turn-4', false, false))
    act(() => result.current.handleGroupClick('turn-5', false, true))
    expect(selectedIds(store)).toEqual(['turn-4', 'turn-5'])
    expect(selectedMessageCount(result)).toBe(4)

    // Older page merged through the production commit, and the display window
    // followed the reading edge to the newly loaded older turns.
    act(() => {
      store.dispatch(
        newMessagesActions.messagesWindowMerged({
          topicId,
          messages: sessionMessages(routeGroupIds),
          route: null,
          mutableMessageIds: []
        })
      )
    })
    loadedMessages.current = sessionMessages(routeGroupIds)
    visible = new Set(['turn-0', 'turn-1', 'turn-2', 'turn-3'])
    rerender()

    expect(selectedIds(store)).toEqual(['turn-4', 'turn-5'])
    expect(readState(store).anchorGroupId).toBe('turn-4')
    expect(resolvedIds(result)).toEqual(['turn-4', 'turn-5'])
    expect(selectedMessageCount(result)).toBe(4)

    // The anchor is now outside the rendered window: the Shift click still
    // extends from it across the turns the merge brought in.
    snapshotLoader.current.mockResolvedValue(wholeRouteSnapshot(routeGroupIds))
    await act(async () => {
      result.current.handleGroupClick('turn-0', false, true)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(selectedIds(store)).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4'])
    expect(resolvedIds(result)).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4'])
    expect(selectedMessageCount(result)).toBe(10)
    expect(readState(store).anchorGroupId).toBe('turn-4')
    expect(snapshotLoader.current).toHaveBeenCalledWith(topicId, null)
    unmount()
  })
})
