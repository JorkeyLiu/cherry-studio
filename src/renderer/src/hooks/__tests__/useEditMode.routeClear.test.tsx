/**
 * useCreateEditMode route/topic selection clearing (BRANCH-12 double insurance).
 *
 * The hook clears `selectedGroupIds` both when the topic changes (W3) and
 * when `activeBranchId` changes (B4), so route-switch residue can never
 * mislead the write gate — stale-route capability mismatch already fails
 * closed on top. This file renders the REAL hook against a real store and
 * asserts the clearing behavior.
 */
import { configureStore } from '@reduxjs/toolkit'
import clipboardReducer from '@renderer/store/clipboard'
import editModeReducer, { setSelectedGroupIds, toggleEditMode } from '@renderer/store/editMode'
import newMessagesReducer from '@renderer/store/newMessage'
import topicBranchReducer, { activeBranchSet } from '@renderer/store/topicBranch'
import undoStackReducer from '@renderer/store/undoStack'
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/ClipboardService', () => ({
  copyMessages: vi.fn(),
  cutMessages: vi.fn(),
  deleteSelectedMessages: vi.fn(),
  pasteMessages: vi.fn()
}))

vi.mock('@renderer/services/UndoService', () => ({
  executeUndo: vi.fn(),
  executeRedo: vi.fn()
}))

const { useCreateEditMode } = await import('../useEditMode')

function buildStore() {
  return configureStore({
    reducer: {
      editMode: editModeReducer,
      topicBranch: topicBranchReducer,
      clipboard: clipboardReducer,
      undoStack: undoStackReducer,
      messages: newMessagesReducer
    }
  })
}

type TestStore = ReturnType<typeof buildStore>

function probeSelection(store: TestStore): string[] {
  return (store.getState() as unknown as { editMode: { selectedGroupIds: string[] } }).editMode.selectedGroupIds
}

function Harness({ topicId }: { topicId: string }) {
  // Subscribe through the real hook so its topic/route effects run.
  useCreateEditMode(topicId)
  return null
}

describe('useCreateEditMode clears selection on route/topic switches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears selectedGroupIds when activeBranchId changes', () => {
    const store = buildStore()
    const view = render(
      <Provider store={store as never}>
        <Harness topicId="topic-1" />
      </Provider>
    )
    act(() => {
      store.dispatch(toggleEditMode(true))
      store.dispatch(setSelectedGroupIds(['u1', 'u2']))
    })
    expect(probeSelection(store)).toEqual(['u1', 'u2'])

    act(() => {
      store.dispatch(activeBranchSet({ topicId: 'topic-1', branchId: 'b1' }))
    })
    expect(probeSelection(store)).toEqual([])

    // A second selection clears again on the way back to main.
    act(() => {
      store.dispatch(setSelectedGroupIds(['u1']))
    })
    expect(probeSelection(store)).toEqual(['u1'])
    act(() => {
      store.dispatch(activeBranchSet({ topicId: 'topic-1', branchId: null }))
    })
    expect(probeSelection(store)).toEqual([])
    view.unmount()
  })

  it('clears selectedGroupIds when the topic changes', () => {
    const store = buildStore()
    const view = render(
      <Provider store={store as never}>
        <Harness topicId="topic-1" />
      </Provider>
    )
    act(() => {
      store.dispatch(toggleEditMode(true))
      store.dispatch(setSelectedGroupIds(['u1']))
    })
    expect(probeSelection(store)).toEqual(['u1'])

    view.rerender(
      <Provider store={store as never}>
        <Harness topicId="topic-2" />
      </Provider>
    )
    expect(probeSelection(store)).toEqual([])
    view.unmount()
  })
})
