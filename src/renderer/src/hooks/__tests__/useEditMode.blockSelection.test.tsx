import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { setAnchorGroupId, setSelectedGroupIds, toggleEditMode } from '@renderer/store/editMode'
import type * as NewMessageStore from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A folded block is one selectable object made of whole turns. These tests drive
 * the REAL edit-mode hook against a REAL store and assert the resulting
 * selection state — ids, anchor, focus and last index — because the defect this
 * covers was exactly the missing bookkeeping: the block was selected through a
 * bare `setSelectedGroupIds`, so the anchor went stale and the next Shift
 * extended from the wrong turn.
 *
 * No callback is spied on as proof of wiring: the assertions are on
 * `store.getState().editMode`.
 */

const { loadedMessages, loggerMock, snapshotLoader } = vi.hoisted(() => ({
  loadedMessages: { current: [] as Message[] },
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() },
  snapshotLoader: { current: vi.fn<(topicId: string, branchId?: string | null) => Promise<unknown>>() }
}))

vi.mock('@logger', () => ({ loggerService: { withContext: () => loggerMock } }))
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

const topicId = 'block-selection-topic'
// Rendered window: turns 0..4. Two more turns exist only in the complete route
// snapshot, so a block endpoint can lie outside the rendered window.
const windowIds = ['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4']
const outsideIds = ['turn-5', 'turn-6']

function messagesFor(ids: string[]) {
  return ids.flatMap((id, index) => [
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
      id: `assistant-${id}-${index}`,
      topicId,
      askId: id,
      role: 'assistant',
      assistantId: 'synthetic-assistant',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: AssistantMessageStatus.SUCCESS,
      blocks: []
    }
  ]) as unknown as Message[]
}

const makeStore = () => configureStore({ reducer: rootReducer })
const wrapperFor =
  (store: ReturnType<typeof makeStore>) =>
  ({ children }: { children: React.ReactNode }) =>
    createElement(Provider, { store, children } as never)

const readState = (store: ReturnType<typeof makeStore>) => store.getState().editMode

const renderEditMode = () => {
  const store = makeStore()
  store.dispatch(toggleEditMode(true))
  const view = renderHook(() => useCreateEditMode(topicId), { wrapper: wrapperFor(store) })
  return { store, view }
}

describe('useEditMode - whole-block (folded section) selection', () => {
  beforeEach(() => {
    loadedMessages.current = messagesFor(windowIds)
    loggerMock.warn.mockClear()
    loggerMock.error.mockClear()
    snapshotLoader.current = vi.fn(async () => ({
      topicId,
      branchId: null,
      messages: messagesFor([...windowIds, ...outsideIds])
    }))
  })

  it('plain click selects the whole block AND anchors/focuses on it', () => {
    const { store, view } = renderEditMode()

    act(() => {
      view.result.current.handleBlockSelect(['turn-1', 'turn-2'])
    })

    const state = readState(store)
    expect(state.selectedGroupIds).toEqual(['turn-1', 'turn-2'])
    // The bookkeeping the defect was missing.
    expect(state.anchorGroupId).toBe('turn-1')
    expect(state.focusedGroupId).toBe('turn-1')
    expect(state.lastSelectedIndex).toBe(1)
    expect(state.focusedIndex).toBe(1)
  })

  it('plain click on the block that IS the whole selection clears it', () => {
    const { store, view } = renderEditMode()

    act(() => {
      view.result.current.handleBlockSelect(['turn-1', 'turn-2'])
    })
    // A second gesture is its own event: the state above has landed.
    act(() => {
      view.result.current.handleBlockSelect(['turn-1', 'turn-2'])
    })

    expect(readState(store).selectedGroupIds).toEqual([])
  })

  it('Shift extends from the anchor the block selection itself set', () => {
    const { store, view } = renderEditMode()

    // Select a block first: this is what must arm the anchor.
    act(() => {
      view.result.current.handleBlockSelect(['turn-1', 'turn-2'])
    })
    expect(readState(store).anchorGroupId).toBe('turn-1')

    // Now Shift onto a later turn: the range starts at the block's anchor.
    act(() => {
      view.result.current.handleGroupClick('turn-4', false, true)
    })

    expect(readState(store).selectedGroupIds).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4'])
  })

  it('Shift onto a block carries every turn of the block, not just the nearest end', () => {
    const { store, view } = renderEditMode()

    act(() => {
      view.result.current.handleGroupClick('turn-0', false, false)
    })
    // Range target is the block [turn-2, turn-3]: reaching only turn-2 would drop
    // turn-3 from the selection.
    act(() => {
      view.result.current.handleBlockSelect(['turn-2', 'turn-3'], { isShift: true })
    })

    expect(readState(store).selectedGroupIds).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3'])
  })

  it('Ctrl+Shift UNIONS the range instead of replacing the selection', () => {
    const { store, view } = renderEditMode()

    act(() => {
      view.result.current.handleGroupClick('turn-0', false, false)
    })
    act(() => {
      view.result.current.handleBlockSelect(['turn-3', 'turn-4'], { isShift: true, isCtrl: true })
    })

    expect(readState(store).selectedGroupIds).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4'])
  })

  it('Ctrl toggles the whole block in and then out', () => {
    const { store, view } = renderEditMode()

    act(() => {
      view.result.current.handleGroupClick('turn-0', false, false)
    })
    act(() => {
      view.result.current.handleBlockSelect(['turn-2', 'turn-3'], { isCtrl: true })
    })
    expect(readState(store).selectedGroupIds).toEqual(['turn-0', 'turn-2', 'turn-3'])

    act(() => {
      view.result.current.handleBlockSelect(['turn-2', 'turn-3'], { isCtrl: true })
    })
    expect(readState(store).selectedGroupIds).toEqual(['turn-0'])
    // A Ctrl toggle re-arms the anchor on the block it acted on, which is exactly
    // what the single-turn Ctrl toggle does (it also dispatches the paired
    // index/id actions after removing), so the next Shift still has an anchor.
    expect(readState(store).anchorGroupId).toBe('turn-2')
  })

  it('Ctrl on a PARTIALLY selected block completes it instead of inverting it', () => {
    const { store, view } = renderEditMode()
    store.dispatch(setSelectedGroupIds(['turn-2']))

    act(() => {
      view.result.current.handleBlockSelect(['turn-2', 'turn-3'], { isCtrl: true })
    })

    expect(readState(store).selectedGroupIds).toEqual(['turn-2', 'turn-3'])
  })

  it('resolves a block endpoint outside the rendered window through the complete route', async () => {
    const { store, view } = renderEditMode()

    act(() => {
      view.result.current.handleGroupClick('turn-3', false, false)
    })
    // shift target lives outside the rendered window: only the complete route can
    // resolve the range, and the block must still arrive whole.
    await act(async () => {
      view.result.current.handleBlockSelect(['turn-5', 'turn-6'], { isShift: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(snapshotLoader.current).toHaveBeenCalled()
    expect(readState(store).selectedGroupIds).toEqual(['turn-3', 'turn-4', 'turn-5', 'turn-6'])
  })

  it('does not select anything outside edit mode', () => {
    const store = makeStore()
    store.dispatch(setAnchorGroupId('turn-1'))
    const view = renderHook(() => useCreateEditMode(topicId), { wrapper: wrapperFor(store) })

    act(() => {
      view.result.current.handleBlockSelect(['turn-1', 'turn-2'])
    })

    expect(readState(store).enabled).toBe(false)
    expect(readState(store).selectedGroupIds).toEqual([])
  })

  it('a later block gesture wins over an in-flight cross-window range request', async () => {
    const { store, view } = renderEditMode()
    let resolveSnapshot: ((value: unknown) => void) | null = null
    snapshotLoader.current = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )

    act(() => {
      view.result.current.handleGroupClick('turn-0', false, false)
    })
    // Start an off-window Shift range (it will resolve late) ...
    act(() => {
      view.result.current.handleBlockSelect(['turn-5'], { isShift: true })
    })
    // ... then a newer gesture settles the selection itself.
    act(() => {
      view.result.current.handleBlockSelect(['turn-2', 'turn-3'])
    })
    await act(async () => {
      resolveSnapshot?.({ topicId, branchId: null, messages: messagesFor([...windowIds, ...outsideIds]) })
      await Promise.resolve()
      await Promise.resolve()
    })

    // The stale range must not overwrite the newer intent.
    expect(readState(store).selectedGroupIds).toEqual(['turn-2', 'turn-3'])
  })

  it('keyboard activation uses the same path, so the anchor is armed identically', () => {
    const { store, view } = renderEditMode()

    // The block's keyboard handler forwards the same modifiers object the hook
    // receives (no pointer modifiers from a key gesture).
    act(() => {
      view.result.current.handleBlockSelect(['turn-2', 'turn-3'], { isCtrl: false, isShift: false })
    })

    expect(readState(store).anchorGroupId).toBe('turn-2')
    expect(readState(store).focusedGroupId).toBe('turn-2')
    expect(readState(store).lastSelectedIndex).toBe(2)
  })

  it('ignores an empty block', () => {
    const { store, view } = renderEditMode()
    act(() => {
      view.result.current.handleBlockSelect([])
    })
    expect(readState(store).selectedGroupIds).toEqual([])
    expect(readState(store).anchorGroupId).toBeNull()
  })
})
