import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { toggleEditMode } from '@renderer/store/editMode'
import type * as NewMessageStore from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadedMessages } = vi.hoisted(() => ({ loadedMessages: { current: [] as Message[] } }))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
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
