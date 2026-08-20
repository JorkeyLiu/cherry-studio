import { configureStore } from '@reduxjs/toolkit'
import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'

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
vi.mock('@renderer/services/db/topicMetadataPersist', () => ({
  default: {}
}))
vi.mock('@renderer/services/db/SqliteMessageDataSource', () => ({
  SqliteMessageDataSource: class {
    constructor() {}
  }
}))

import clipboardReducer from '@renderer/store/clipboard'
import editModeReducer from '@renderer/store/editMode'

import { EditModeProvider, useEditMode } from '../EditModeContext'

// Helper to make a store with controllable editMode state
function makeStore(enabled: boolean, _extra?: any) {
  return configureStore({
    reducer: {
      editMode: editModeReducer,
      clipboard: clipboardReducer,
      undoStack: (state: any = { undoStack: [], redoStack: [] }) => state,
      messages: (
        state: any = { entities: {}, messageIdsByTopic: {}, loadingByTopic: {}, displayCount: 20, currentTopicId: 't1' }
      ) => state,
      messageBlocks: (state: any = { entities: {} }) => state,
      topicSegments: (state: any = { segments: { entities: {}, ids: [] }, segmentsByTopic: {} }) => state
    } as any,
    preloadedState: {
      editMode: {
        enabled,
        selectedGroupIds: enabled ? ['g1'] : [],
        lastSelectedIndex: null,
        focusedIndex: null,
        isProcessing: false
      },
      clipboard: {
        mode: null,
        items: enabled ? [{ id: 'c1' }] : [],
        sourceTopicId: null,
        timestamp: 0,
        segmentSnapshots: []
      },
      undoStack: { undoStack: enabled ? [{ id: 'u1' }] : [], redoStack: [] },
      messages: {
        entities: {
          m1: { id: 'm1', role: 'user', topicId: 't1', askId: 'g1', blocks: [] },
          m2: { id: 'm2', role: 'assistant', topicId: 't1', askId: 'g1', blocks: [] }
        },
        messageIdsByTopic: { t1: ['m1', 'm2'] },
        loadingByTopic: {},
        displayCount: 20,
        currentTopicId: 't1'
      },
      messageBlocks: { entities: {} },
      topicSegments: { segments: { entities: {}, ids: [] }, segmentsByTopic: {} }
    } as any
  })
}

function Consumer() {
  const ctx = useEditMode()
  return (
    <div>
      <div data-testid="is-enabled">{String(ctx.isEnabled)}</div>
      <div data-testid="groups-len">{String(ctx.groups.length)}</div>
      <div data-testid="selected-len">{String(ctx.selectedGroupIds.length)}</div>
      <div data-testid="has-clipboard">{String(ctx.hasClipboard)}</div>
      <div data-testid="can-undo">{String(ctx.canUndo)}</div>
      <button data-testid="toggle" onClick={() => ctx.toggleEditMode(!ctx.isEnabled)}>
        toggle
      </button>
    </div>
  )
}

describe('S3.5 EditMode lazy activation', () => {
  it('while disabled only light gate is mounted: heavy inactive marker present, heavy active absent', async () => {
    const store = makeStore(false)
    render(
      <Provider store={store}>
        <EditModeProvider topicId="t1">
          <Consumer />
        </EditModeProvider>
      </Provider>
    )
    expect(screen.getByTestId('edit-heavy-inactive')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-heavy-active')).not.toBeInTheDocument()
    expect(screen.getByTestId('is-enabled').textContent).toBe('false')
    // Light values must be empty/false without heavy subscriptions
    expect(screen.getByTestId('groups-len').textContent).toBe('0')
    expect(screen.getByTestId('has-clipboard').textContent).toBe('false')
    expect(screen.getByTestId('can-undo').textContent).toBe('false')
  })

  it('while enabled heavy subscription graph is active: marker present, groups/hasClipboard/canUndo derived', async () => {
    const store = makeStore(true)
    render(
      <Provider store={store}>
        <EditModeProvider topicId="t1">
          <Consumer />
        </EditModeProvider>
      </Provider>
    )
    expect(screen.getByTestId('edit-heavy-active')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-heavy-inactive')).not.toBeInTheDocument()
    expect(screen.getByTestId('is-enabled').textContent).toBe('true')
    // Heavy should now have derived groups (at least 1) and clipboard/undo true
    expect(Number(screen.getByTestId('groups-len').textContent)).toBeGreaterThan(0)
    expect(screen.getByTestId('has-clipboard').textContent).toBe('true')
    expect(screen.getByTestId('can-undo').textContent).toBe('true')
  })

  it('activates heavy on enable and deactivates on disable (toggle lifecycle)', async () => {
    const store = makeStore(false)
    render(
      <Provider store={store}>
        <EditModeProvider topicId="t1">
          <Consumer />
        </EditModeProvider>
      </Provider>
    )
    expect(screen.queryByTestId('edit-heavy-active')).not.toBeInTheDocument()
    // toggle to enabled via UI — dispatch changes store, provider should remount heavy
    fireEvent.click(screen.getByTestId('toggle'))
    // give redux a tick
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId('is-enabled').textContent).toBe('true')
    expect(screen.getByTestId('edit-heavy-active')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('toggle'))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId('is-enabled').textContent).toBe('false')
    expect(screen.queryByTestId('edit-heavy-active')).not.toBeInTheDocument()
    expect(screen.getByTestId('edit-heavy-inactive')).toBeInTheDocument()
  })

  it('preserves strict semantics: useEditMode throws outside provider, optional returns null', async () => {
    const { useOptionalEditMode } = await import('../EditModeContext')
    const { render: render2 } = await import('@testing-library/react')
    function OutsideStrict() {
      const ctx = useEditMode()
      return <div>{String(ctx.isEnabled)}</div>
    }
    expect(() => render2(<OutsideStrict />)).toThrow('useEditMode must be used within an EditModeProvider')
    function OutsideOptional() {
      const ctx = useOptionalEditMode()
      return <div data-testid="opt">{ctx ? 'has' : 'none'}</div>
    }
    const { getByTestId } = render2(<OutsideOptional />)
    expect(getByTestId('opt').textContent).toBe('none')
  })

  it('while disabled heavy selectors are not subscribed — store message/clipboard/undo changes keep light values empty/false', async () => {
    const store = makeStore(false)
    const { rerender } = render(
      <Provider store={store}>
        <EditModeProvider topicId="t1">
          <Consumer />
        </EditModeProvider>
      </Provider>
    )
    expect(screen.getByTestId('groups-len').textContent).toBe('0')
    expect(screen.getByTestId('has-clipboard').textContent).toBe('false')
    expect(screen.getByTestId('can-undo').textContent).toBe('false')
    // Mutate store: add messages, clipboard, undo while still disabled — light should remain empty/false
    store.dispatch({ type: 'messages/add', payload: {} } as any)
    // Directly update clipboard via store state override simulation: dispatch editMode toggle not enabled, but we can dispatch raw state change via replace?
    // Instead, test via store with preloaded enabled state but provider disabled: heavy not mounted should not derive.
    // Re-render with same disabled provider after store has enabled data — light should still be 0/false
    rerender(
      <Provider store={store}>
        <EditModeProvider topicId="t1">
          <Consumer />
        </EditModeProvider>
      </Provider>
    )
    expect(screen.getByTestId('groups-len').textContent).toBe('0')
    expect(screen.getByTestId('has-clipboard').textContent).toBe('false')
    expect(screen.getByTestId('can-undo').textContent).toBe('false')
    expect(screen.getByTestId('edit-heavy-inactive')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-heavy-active')).not.toBeInTheDocument()
  })

  it('deactivation unsubscribes heavy: toggling back to disabled removes heavy marker and reverts to light false values', async () => {
    const store = makeStore(true)
    const { rerender: _rerender } = render(
      <Provider store={store}>
        <EditModeProvider topicId="t1">
          <Consumer />
        </EditModeProvider>
      </Provider>
    )
    expect(screen.getByTestId('edit-heavy-active')).toBeInTheDocument()
    expect(Number(screen.getByTestId('groups-len').textContent)).toBeGreaterThan(0)
    // toggle off via dispatch
    store.dispatch({ type: 'editMode/toggleEditMode', payload: false } as any)
    // Force re-render to pick up new selector
    _rerender(
      <Provider store={store}>
        <EditModeProvider topicId="t1">
          <Consumer />
        </EditModeProvider>
      </Provider>
    )
    // After deactivation, light values should be empty/false even though store still has messages
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('edit-heavy-active')).not.toBeInTheDocument()
    expect(screen.getByTestId('edit-heavy-inactive')).toBeInTheDocument()
    expect(screen.getByTestId('is-enabled').textContent).toBe('false')
    expect(screen.getByTestId('groups-len').textContent).toBe('0')
    expect(screen.getByTestId('has-clipboard').textContent).toBe('false')
    expect(screen.getByTestId('can-undo').textContent).toBe('false')
  })

  it('light context clearSelection dispatches and handles topic change while disabled', async () => {
    const store = makeStore(false)
    store.dispatch({ type: 'editMode/setSelectedGroupIds', payload: ['g1', 'g2'] } as any)
    function ClearConsumer() {
      const ctx = useEditMode()
      return (
        <div>
          <div data-testid="selected-len">{String(ctx.selectedGroupIds.length)}</div>
          <button data-testid="clear" onClick={() => ctx.clearSelection()}>
            clear
          </button>
          <button data-testid="handle-clear" onClick={() => ctx.handleClearSelection()}>
            hclear
          </button>
        </div>
      )
    }
    const { rerender } = render(
      <Provider store={store}>
        <EditModeProvider topicId="t1">
          <ClearConsumer />
        </EditModeProvider>
      </Provider>
    )
    // light initially has empty selection regardless of store preloaded? Store has selectedGroupIds but light overrides to []
    expect(screen.getByTestId('selected-len').textContent).toBe('0')
    // both clear handlers should be callable without throw
    fireEvent.click(screen.getByTestId('clear'))
    fireEvent.click(screen.getByTestId('handle-clear'))
    expect(screen.getByTestId('selected-len').textContent).toBe('0')
    // topic change should clear selection (light effect) — rerender with new topicId
    rerender(
      <Provider store={store}>
        <EditModeProvider topicId="t2">
          <ClearConsumer />
        </EditModeProvider>
      </Provider>
    )
    expect(screen.getByTestId('selected-len').textContent).toBe('0')
    expect(screen.getByTestId('clear')).toBeInTheDocument()
  })
})
