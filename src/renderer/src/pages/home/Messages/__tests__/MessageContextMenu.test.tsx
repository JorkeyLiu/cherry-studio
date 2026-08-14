import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  editMode: {
    isEnabled: false,
    selectedGroupIds: [] as string[],
    selectedGroups: [] as unknown[],
    groups: [] as unknown[],
    hasClipboard: false,
    canUndo: false,
    canRedo: false,
    toggleEditMode: vi.fn(),
    handleGroupClick: vi.fn(),
    handleCopy: vi.fn(),
    handleCut: vi.fn(),
    handlePaste: vi.fn(),
    handleDelete: vi.fn(),
    handleMoveFocus: vi.fn(),
    handleExtendSelection: vi.fn(),
    handleClearSelection: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    clearSelection: vi.fn()
  },
  dropdownProps: { current: null as unknown as { menu: { items: any[] }; onOpenChange: (open: boolean) => void } },
  getSegmentsForTopic: vi.fn(() => []),
  createSegment: vi.fn(),
  updateSegmentMessageIds: vi.fn(),
  deleteSegment: vi.fn(),
  clearSelectionAction: vi.fn(),
  setSelectedGroupIdsAction: vi.fn()
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useEditMode: () => mocks.editMode
}))

vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({
    createSegment: mocks.createSegment,
    getSegmentsForTopic: mocks.getSegmentsForTopic,
    updateSegmentMessageIds: mocks.updateSegmentMessageIds,
    deleteSegment: mocks.deleteSegment
  })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => []
}))

vi.mock('@renderer/store/editMode', () => ({
  clearSelection: mocks.clearSelectionAction,
  setSelectedGroupIds: mocks.setSelectedGroupIdsAction
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// Capture the Dropdown props so tests can inspect the menu items and drive
// the onOpenChange contract without depending on antd internals.
vi.mock('antd', () => ({
  Dropdown: (props: {
    children: React.ReactNode
    menu?: { items?: Array<{ key?: string; type?: string; disabled?: boolean; label?: string; onClick?: () => void }> }
    onOpenChange?: (open: boolean) => void
  }) => {
    mocks.dropdownProps.current = {
      menu: { items: props.menu?.items ?? [] },
      onOpenChange: props.onOpenChange ?? (() => {})
    }
    return <div data-testid="dropdown-host">{props.children}</div>
  }
}))

const { default: MessageContextMenu } = await import('../MessageContextMenu')

const renderHost = (children: React.ReactNode) =>
  render(<MessageContextMenu topicId="t1">{children}</MessageContextMenu>)

const selectTextIn = (target: HTMLElement) => {
  const selection = window.getSelection()!
  selection.removeAllRanges()
  const range = document.createRange()
  range.selectNodeContents(target)
  selection.addRange(range)
}

const clearSelection = () => {
  window.getSelection()?.removeAllRanges()
}

describe('MessageContextMenu (stable host, PERF-100)', () => {
  beforeEach(() => {
    mocks.editMode.isEnabled = false
    mocks.editMode.selectedGroupIds = []
    mocks.editMode.groups = []
    mocks.editMode.hasClipboard = false
    mocks.editMode.canUndo = false
    mocks.editMode.canRedo = false
    vi.clearAllMocks()
    clearSelection()
  })

  describe('normal-mode selection menu behavior', () => {
    it('offers copy/quote when the context menu opens on a text selection', () => {
      renderHost(<p data-testid="target">hello selection</p>)

      selectTextIn(screen.getByTestId('target'))
      act(() => {
        mocks.dropdownProps.current.onOpenChange(true)
      })

      const items = mocks.dropdownProps.current.menu.items
      expect(items.map((item) => item.key)).toEqual(['copy', 'quote'])
      expect(items[0]?.label).toBe('common.copy')
      expect(items[1]?.label).toBe('chat.message.quote')
    })

    it('copies the selected text via the copy action', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      Object.assign(window, { toast: { success: vi.fn(), error: vi.fn() } })

      renderHost(<p data-testid="target">copy me</p>)

      selectTextIn(screen.getByTestId('target'))
      act(() => {
        mocks.dropdownProps.current.onOpenChange(true)
      })

      await act(async () => {
        mocks.dropdownProps.current.menu.items[0].onClick()
      })

      expect(writeText).toHaveBeenCalledWith('copy me')
    })

    it('extracts selection text without code viewer line numbers', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      Object.assign(window, { toast: { success: vi.fn(), error: vi.fn() } })

      renderHost(
        <div data-testid="target">
          <div className="line-number">1</div>
          <pre className="line">code line one</pre>
        </div>
      )

      selectTextIn(screen.getByTestId('target'))
      act(() => {
        mocks.dropdownProps.current.onOpenChange(true)
      })

      await act(async () => {
        mocks.dropdownProps.current.menu.items[0].onClick()
      })

      // Line numbers are stripped while code structure is preserved.
      expect(writeText).toHaveBeenCalledWith('code line one')
    })

    it('shows no items when the context menu opens without a selection', () => {
      renderHost(<p data-testid="target">no selection</p>)

      // No selection is active (rangeCount === 0).
      act(() => {
        mocks.dropdownProps.current.onOpenChange(true)
      })

      expect(mocks.dropdownProps.current.menu.items).toEqual([])
    })
  })

  describe('edit-mode menu behavior', () => {
    it('shows edit-mode operations when edit mode is enabled', () => {
      mocks.editMode.isEnabled = true
      mocks.editMode.selectedGroupIds = ['ask-1']
      mocks.editMode.groups = [{ askId: 'ask-1', messages: [{ id: 'm1' }] }]
      mocks.editMode.hasClipboard = true
      mocks.editMode.canUndo = true
      mocks.editMode.canRedo = true

      renderHost(<p data-testid="target">content</p>)

      const items = mocks.dropdownProps.current.menu.items
      const keys = items.filter((item) => item.type !== 'divider').map((item) => item.key)
      expect(keys).toEqual(['copy', 'cut', 'paste', 'delete', 'createSegment', 'selectAll', 'undo', 'redo'])

      const byKey = (key: string) => items.find((item) => item.key === key)!
      expect(byKey('paste').disabled).toBe(false)
      expect(byKey('delete').disabled).toBe(false)
      expect(byKey('createSegment').disabled).toBe(false)
      expect(byKey('undo').disabled).toBe(false)
      expect(byKey('redo').disabled).toBe(false)
    })

    it('disables paste/delete/undo/redo based on edit-mode state', () => {
      mocks.editMode.isEnabled = true
      mocks.editMode.selectedGroupIds = []
      mocks.editMode.hasClipboard = false
      mocks.editMode.canUndo = false
      mocks.editMode.canRedo = false

      renderHost(<p data-testid="target">content</p>)

      const items = mocks.dropdownProps.current.menu.items
      const byKey = (key: string) => items.find((item) => item.key === key)!
      expect(byKey('paste').disabled).toBe(true)
      expect(byKey('delete').disabled).toBe(true)
      expect(byKey('undo').disabled).toBe(true)
      expect(byKey('redo').disabled).toBe(true)
    })

    it('invokes edit-mode handlers from menu clicks', () => {
      mocks.editMode.isEnabled = true
      mocks.editMode.selectedGroupIds = ['ask-1']
      mocks.editMode.groups = [{ askId: 'ask-1', messages: [{ id: 'm1' }] }]

      renderHost(<p data-testid="target">content</p>)

      act(() => {
        mocks.dropdownProps.current.menu.items.find((item) => item.key === 'copy')!.onClick()
      })
      expect(mocks.editMode.handleCopy).toHaveBeenCalled()
    })

    it('does not capture text selection while edit mode is enabled', () => {
      mocks.editMode.isEnabled = true

      renderHost(<p data-testid="target">content</p>)

      selectTextIn(screen.getByTestId('target'))
      act(() => {
        mocks.dropdownProps.current.onOpenChange(true)
      })

      // Items stay on the edit-mode menu; the selection capture path is skipped.
      const keys = mocks.dropdownProps.current.menu.items
        .filter((item) => item.type !== 'divider')
        .map((item) => item.key)
      expect(keys).not.toEqual(['copy', 'quote'])
      expect(keys).toContain('cut')
    })
  })

  describe('DOM identity across an edit-mode flip', () => {
    const renderTree = () => (
      <MessageContextMenu topicId="t1">
        <div className="scroll-container" data-testid="scroll-container">
          <div id="message-m1">message content</div>
          <div id="message-m2">message content 2</div>
        </div>
      </MessageContextMenu>
    )

    it('keeps the same message DOM nodes when entering and leaving edit mode', () => {
      const { rerender } = render(renderTree())

      const scrollBefore = screen.getByTestId('scroll-container')
      const m1Before = document.getElementById('message-m1')!
      const m2Before = document.getElementById('message-m2')!

      // Enter edit mode.
      mocks.editMode.isEnabled = true
      rerender(renderTree())

      expect(screen.getByTestId('scroll-container')).toBe(scrollBefore)
      expect(document.getElementById('message-m1')).toBe(m1Before)
      expect(document.getElementById('message-m2')).toBe(m2Before)

      // Leave edit mode.
      mocks.editMode.isEnabled = false
      rerender(renderTree())

      expect(screen.getByTestId('scroll-container')).toBe(scrollBefore)
      expect(document.getElementById('message-m1')).toBe(m1Before)
      expect(document.getElementById('message-m2')).toBe(m2Before)
    })

    it('renders a single stable Dropdown host in both modes', () => {
      const { rerender } = render(renderTree())

      const hostBefore = screen.getByTestId('dropdown-host')

      mocks.editMode.isEnabled = true
      rerender(renderTree())

      expect(screen.getByTestId('dropdown-host')).toBe(hostBefore)
    })
  })
})
