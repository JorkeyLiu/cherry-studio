import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enUs from '../../../../i18n/locales/en-us.json'
import zhCn from '../../../../i18n/locales/zh-cn.json'
import zhTw from '../../../../i18n/locales/zh-tw.json'
import { FoldedSection } from '../FoldedSection'
import { type RouteViewportCommands, RouteViewportCommandsContext } from '../routeViewportContext'
import { RouteViewportController } from '../routeViewportController'
import {
  SegmentGroupPresentationProvider,
  useSegmentGroupGeometry,
  useSegmentGroupLayoutManager
} from '../SegmentGroupPresentation'

/**
 * These tests exercise the block through its REAL collaborators:
 * - the real locale JSON files (so a `[to be translated]` placeholder or a raw
 *   key shows up as a failure instead of being hidden by a hand-written `t` map),
 * - the real `antd` Dropdown (so "exactly one menu" is a DOM fact, not a mock's
 *   recorded item list).
 *
 * Only the store boundary and the atomic turn-fold command are stubbed, because
 * those are the component's only inputs/outputs.
 */

const { setTurnFoldsMock, dispatchMock } = vi.hoisted(() => ({
  setTurnFoldsMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
  dispatchMock: vi.fn((action: unknown) => {
    if (typeof action === 'function') return (action as () => unknown)()
    return action
  })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (selector: (state: unknown) => unknown) => selector({ topicBranches: {} })
}))

// The thunk keeps its real shape (`(topicId, groupIds, folded, branchId) =>
// (dispatch) => Promise<void>`), so the component is exercised through the same
// call contract as production.
vi.mock('@renderer/store/thunk/turnFold', () => ({
  setTurnFoldsThunk: (topicId: string, groupIds: string[], folded: boolean, branchId?: string | null) => () =>
    setTurnFoldsMock(topicId, groupIds, folded, branchId)
}))

/**
 * Real translation lookups. i18next canonicalizes language tags (`zh-cn` becomes
 * `zh-CN`), so the resource bundle is keyed the canonical way.
 */
let i18nInstance: ReturnType<typeof i18next.createInstance> | null = null

function getI18n(lng: string) {
  if (!i18nInstance || i18nInstance.language !== lng) {
    i18nInstance = i18next.createInstance()
    void i18nInstance.init({
      lng,
      fallbackLng: 'en-US',
      resources: {
        'zh-CN': { translation: zhCn },
        'zh-TW': { translation: zhTw },
        'en-US': { translation: enUs }
      },
      interpolation: { escapeValue: false },
      initImmediate: false
    })
  }
  return i18nInstance
}

// The component reads `useTranslation().t`; keep everything else real. A module
// variable selects the active language per test so the same component is
// exercised in Chinese and in English.
let activeLanguage = 'zh-CN'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => getI18n(activeLanguage).t(key, options),
    i18n: { language: activeLanguage }
  })
}))

const renderSection = (
  props: Partial<React.ComponentProps<typeof FoldedSection>> = {},
  ancestorContextMenu?: () => void
) => {
  const section = (
    <FoldedSection
      isExpanded={false}
      onToggleExpand={vi.fn()}
      turnCount={3}
      groupIds={['u1', 'u2', 'u3']}
      topicId="t1"
      {...props}>
      <div data-testid="child-message">Child turn content</div>
    </FoldedSection>
  )

  return render(ancestorContextMenu ? <div onContextMenu={ancestorContextMenu}>{section}</div> : section)
}

const dropdownMenus = () => Array.from(document.querySelectorAll('.ant-dropdown-menu'))

describe('FoldedSection', () => {
  beforeEach(() => {
    activeLanguage = 'zh-CN'
    setTurnFoldsMock.mockReset()
    setTurnFoldsMock.mockImplementation(async () => undefined)
    dispatchMock.mockClear()
    window.toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } as never
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('collapsed marker i18n', () => {
    it('renders the real Chinese rail text for 1 and 3 turns', () => {
      const one = renderSection({ turnCount: 1 })
      const collapsedOne = screen.getByTestId('folded-section-collapsed')
      expect(collapsedOne).toHaveTextContent('已折叠 1 轮对话')
      // The quiet marker carries no context badge, no banner, no colored dot.
      expect(collapsedOne).not.toHaveTextContent('不计入上下文')
      expect(collapsedOne.textContent).not.toContain('[to be translated]')
      expect(collapsedOne.textContent).not.toContain('folded_turns_summary')
      expect(screen.getByTestId('folded-section-expand-label')).toHaveTextContent('已折叠 1 轮对话')
      // No white tooltip anywhere: neither the rail hit target nor the label
      // carries a native title, and the old hover indicator is gone.
      expect(screen.getByTestId('folded-section-expand-btn')).not.toHaveAttribute('title')
      expect(screen.getByTestId('folded-section-expand-label')).not.toHaveAttribute('title')
      expect(document.querySelector('.rail-indicator')).toBeNull()
      one.unmount()

      renderSection({ turnCount: 3 })
      const collapsedThree = screen.getByTestId('folded-section-collapsed')
      expect(collapsedThree).toHaveTextContent('已折叠 3 轮对话')
      expect(collapsedThree).not.toHaveTextContent('已折叠 1 轮对话')
      expect(collapsedThree.textContent).not.toContain('[to be translated]')
    })

    it('renders the real English singular/plural resources and the real menu wording', async () => {
      activeLanguage = 'en-US'
      const one = renderSection({ turnCount: 1 })
      expect(screen.getByTestId('folded-section-collapsed')).toHaveTextContent('1 conversation folded')
      expect(screen.getByTestId('folded-section-expand-btn')).not.toHaveAttribute('title')
      one.unmount()

      renderSection({ turnCount: 3 })
      const collapsed = screen.getByTestId('folded-section-collapsed')
      expect(collapsed).toHaveTextContent('3 conversations folded')

      fireEvent.contextMenu(collapsed)
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      await waitFor(() => expect(dropdownMenus()[0]).toHaveTextContent('Unfold'))
      expect(dropdownMenus()[0].textContent).not.toContain('[to be translated]')
      expect(dropdownMenus()[0].textContent).not.toContain('unfold_selected_turns')
    })
  })

  describe('expanded header', () => {
    it('keeps the neutral header text and paints no status dot', () => {
      renderSection({ isExpanded: true, turnCount: 2 })
      expect(screen.getByTestId('folded-section-expanded')).toBeInTheDocument()
      expect(screen.getByTestId('child-message')).toBeInTheDocument()

      const hintLabel = screen.getByText(/以下 2 轮对话已折叠/)
      const hintRow = hintLabel.parentElement as HTMLElement
      // The removed status dot was a sibling of the label inside this row.
      expect(hintRow.children).toHaveLength(1)
      expect(hintRow.firstElementChild).toBe(hintLabel)
      expect(screen.getByTestId('folded-section-header')).toHaveTextContent('未计入上下文')
      // The header browse button is gone: only the gutter rail expands/collapses.
      expect(screen.queryByTestId('folded-section-collapse-btn')).not.toBeInTheDocument()
      // No white hover tooltip: the rail carries no native title and no indicator tag.
      expect(screen.getByTestId('folded-section-gutter-rail')).not.toHaveAttribute('title')
      expect(document.querySelector('.rail-indicator')).toBeNull()
      expect(screen.getByTestId('folded-section-rail-line')).toBeInTheDocument()
    })
  })

  describe('shared interaction rail', () => {
    it('uses the one shared line in both states with no private rail styling', async () => {
      const rail = await import('../GroupInteractionRail')
      expect(rail.INTERACTION_RAIL_LINE_WIDTH_PX).toBe(2)
      expect(rail.INTERACTION_RAIL_HIT_WIDTH_PX).toBe(8)
      expect(rail.INTERACTION_RAIL_COLLAPSED_HEIGHT_PX).toBe(20)
      expect(rail.InteractionRailLine).toBeDefined()
      expect(rail.InteractionRailHitTarget).toBeDefined()
      // The white tooltip + indicator live nowhere in the rendered block.
      renderSection({ turnCount: 2 })
      expect(screen.getByTestId('folded-section-expand-btn')).not.toHaveAttribute('title')
      expect(screen.getByTestId('folded-section-expand-label')).not.toHaveAttribute('title')
      expect(document.querySelector('.rail-indicator')).toBeNull()
    })

    it('renders the shared 2px line with an 8px hit target in the collapsed state', () => {
      renderSection({ turnCount: 2 })
      const line = screen.getByTestId('folded-section-rail-line')
      const hit = screen.getByTestId('folded-section-expand-btn')
      expect(line).toBeInTheDocument()
      expect(hit.tagName).toBe('BUTTON')
      expect(hit).not.toHaveAttribute('title')
    })

    it('renders the shared line with an 8px hit target in the expanded state', () => {
      renderSection({ isExpanded: true, turnCount: 2 })
      const line = screen.getByTestId('folded-section-rail-line')
      const hit = screen.getByTestId('folded-section-gutter-rail')
      expect(line).toBeInTheDocument()
      expect(hit.tagName).toBe('BUTTON')
      expect(hit).not.toHaveAttribute('title')
      expect(screen.queryByTestId('folded-section-collapse-btn')).not.toBeInTheDocument()
    })
  })

  describe('linked rail and text region', () => {
    it('lights the collapsed line and text together from either end', () => {
      renderSection({ turnCount: 2 })
      const region = screen.getByTestId('folded-section-collapsed')
      const railHit = screen.getByTestId('folded-section-expand-btn')
      const label = screen.getByTestId('folded-section-expand-label')
      expect(region).toHaveAttribute('data-fold-region-active', 'false')

      // Hovering the text lights the whole region (line brightens with it).
      fireEvent.mouseEnter(label)
      expect(region).toHaveAttribute('data-fold-region-active', 'true')
      fireEvent.mouseLeave(label)
      expect(region).toHaveAttribute('data-fold-region-active', 'false')

      // Hovering the short line lights the region the same way.
      fireEvent.mouseEnter(railHit)
      expect(region).toHaveAttribute('data-fold-region-active', 'true')
      fireEvent.mouseLeave(railHit)
      expect(region).toHaveAttribute('data-fold-region-active', 'false')
    })

    it('lights the expanded line and text together from either end', () => {
      renderSection({ isExpanded: true, turnCount: 2 })
      const region = screen.getByTestId('folded-section-expanded')
      const railHit = screen.getByTestId('folded-section-gutter-rail')
      const label = screen.getByTestId('folded-section-expand-label')
      expect(region).toHaveAttribute('data-fold-region-active', 'false')

      fireEvent.mouseEnter(label)
      expect(region).toHaveAttribute('data-fold-region-active', 'true')
      fireEvent.mouseLeave(label)
      expect(region).toHaveAttribute('data-fold-region-active', 'false')

      fireEvent.mouseEnter(railHit)
      expect(region).toHaveAttribute('data-fold-region-active', 'true')
      fireEvent.mouseLeave(railHit)
      expect(region).toHaveAttribute('data-fold-region-active', 'false')
    })
  })

  describe('selection in edit mode', () => {
    it('draws one visible outline on the selected collapsed block', () => {
      const unselected = renderSection({ turnCount: 2 })
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-folded-section-selected', 'false')
      unselected.unmount()

      renderSection({ turnCount: 2, isSelected: true })
      const collapsed = screen.getByTestId('folded-section-collapsed')
      expect(collapsed).toHaveAttribute('data-folded-section-selected', 'true')
      expect(collapsed).toHaveStyle({ boxShadow: '0 0 0 1.5px var(--color-primary)' })
    })

    it('shows a weaker outline and a stated count for a PARTIALLY selected block', () => {
      renderSection({ turnCount: 3, isPartiallySelected: true, selectedTurnCount: 1 })

      const collapsed = screen.getByTestId('folded-section-collapsed')
      // It must not impersonate a fully selected block.
      expect(collapsed).toHaveAttribute('data-folded-section-selected', 'false')
      expect(collapsed).toHaveAttribute('data-folded-section-partial', 'true')
      expect(collapsed).toHaveStyle({
        boxShadow: '0 0 0 1.5px color-mix(in srgb, var(--color-primary) 40%, transparent)'
      })
      // Real resource: "已选 1/3 轮", resolved through the real bundle.
      expect(screen.getByTestId('folded-section-partial-hint')).toHaveTextContent('已选 1/3 轮')
    })

    it('shows no partial hint when the whole block is selected', () => {
      renderSection({ turnCount: 3, isSelected: true, selectedTurnCount: 3 })
      expect(screen.queryByTestId('folded-section-partial-hint')).not.toBeInTheDocument()
    })

    it('expands on collapsed marker click in edit mode without selecting or writing', () => {
      const onToggleExpand = vi.fn()
      const onSectionSelect = vi.fn()
      renderSection({ onToggleExpand, onSectionSelect, isEditMode: true, turnCount: 4, groupIds: ['u1', 'u2'] })

      // Short line: browse only, never a selection and never a fold write.
      fireEvent.click(screen.getByTestId('folded-section-expand-btn'))
      expect(onToggleExpand).toHaveBeenCalledTimes(1)
      expect(onSectionSelect).not.toHaveBeenCalled()
      expect(setTurnFoldsMock).not.toHaveBeenCalled()

      // Label: the same browse-only activation.
      fireEvent.click(screen.getByTestId('folded-section-expand-label'))
      expect(onToggleExpand).toHaveBeenCalledTimes(2)
      expect(onSectionSelect).not.toHaveBeenCalled()
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
    })

    it('renders a whole-row selection surface only for the collapsed block in edit mode', () => {
      const editCollapsed = renderSection({ isEditMode: true, turnCount: 4, groupIds: ['u1', 'u2'] })
      expect(screen.getByTestId('folded-section-select-cover')).toBeInTheDocument()
      // The label keeps its own browse toggle above the surface.
      expect(screen.getByTestId('folded-section-header')).toContainElement(
        screen.getByTestId('folded-section-expand-label')
      )
      editCollapsed.unmount()

      // Ordinary mode: blank space stays inert (no expand, no select).
      const ordinary = renderSection({ turnCount: 4, groupIds: ['u1', 'u2'] })
      expect(screen.queryByTestId('folded-section-select-cover')).not.toBeInTheDocument()
      ordinary.unmount()

      // Expanded: the carried turns keep their own per-turn covers.
      const expanded = renderSection({ isExpanded: true, isEditMode: true, turnCount: 4 })
      expect(screen.queryByTestId('folded-section-select-cover')).not.toBeInTheDocument()
      expanded.unmount()
      // Geometry (a visible, non-zero-height surface) is a layout fact jsdom
      // cannot establish; the real-Electron observation measures it.
    })

    it('selects the whole block from the row surface without expanding or writing', () => {
      const onToggleExpand = vi.fn()
      const onSectionSelect = vi.fn()
      renderSection({ onToggleExpand, onSectionSelect, isEditMode: true, turnCount: 4, groupIds: ['u1', 'u2'] })

      fireEvent.click(screen.getByTestId('folded-section-select-cover'))
      expect(onSectionSelect).toHaveBeenCalledTimes(1)
      expect(onSectionSelect).toHaveBeenCalledWith({ isCtrl: false, isShift: false })
      expect(onToggleExpand).not.toHaveBeenCalled()
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
    })

    it('forwards the pointer modifiers to the existing batch gesture', () => {
      const onSectionSelect = vi.fn()
      renderSection({ onSectionSelect, isEditMode: true, turnCount: 4, groupIds: ['u1', 'u2'] })
      const cover = screen.getByTestId('folded-section-select-cover')

      fireEvent.click(cover, { ctrlKey: true })
      expect(onSectionSelect).toHaveBeenLastCalledWith({ isCtrl: true, isShift: false })
      fireEvent.click(cover, { metaKey: true })
      expect(onSectionSelect).toHaveBeenLastCalledWith({ isCtrl: true, isShift: false })
      fireEvent.click(cover, { shiftKey: true })
      expect(onSectionSelect).toHaveBeenLastCalledWith({ isCtrl: false, isShift: true })
      fireEvent.click(cover, { ctrlKey: true, shiftKey: true })
      expect(onSectionSelect).toHaveBeenLastCalledWith({ isCtrl: true, isShift: true })
      expect(onSectionSelect).toHaveBeenCalledTimes(4)
    })

    it('expands on collapsed marker keyboard activation without selecting', () => {
      const onToggleExpand = vi.fn()
      const onSectionSelect = vi.fn()
      renderSection({ onToggleExpand, onSectionSelect, isEditMode: true })

      fireEvent.keyDown(screen.getByTestId('folded-section-expand-label'), { key: 'Enter' })
      expect(onToggleExpand).toHaveBeenCalledTimes(1)
      expect(onSectionSelect).not.toHaveBeenCalled()
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
    })

    it('browses from the expanded rail and text in edit mode without selecting', () => {
      const onToggleExpand = vi.fn()
      const onSectionSelect = vi.fn()
      renderSection({ isExpanded: true, onToggleExpand, onSectionSelect, isEditMode: true })

      // Rail: closes the browse view, never a selection and never a write.
      fireEvent.click(screen.getByTestId('folded-section-gutter-rail'))
      expect(onToggleExpand).toHaveBeenCalledTimes(1)
      expect(onSectionSelect).not.toHaveBeenCalled()
      expect(setTurnFoldsMock).not.toHaveBeenCalled()

      // Header text: the same browse-only toggle as the rail.
      fireEvent.click(screen.getByTestId('folded-section-expand-label'))
      expect(onToggleExpand).toHaveBeenCalledTimes(2)
      expect(onSectionSelect).not.toHaveBeenCalled()
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
    })

    it('collapses from the expanded text keyboard activation without selecting', () => {
      const onToggleExpand = vi.fn()
      const onSectionSelect = vi.fn()
      renderSection({ isExpanded: true, onToggleExpand, onSectionSelect, isEditMode: true })

      fireEvent.keyDown(screen.getByTestId('folded-section-expand-label'), { key: 'Enter' })
      expect(onToggleExpand).toHaveBeenCalledTimes(1)
      expect(onSectionSelect).not.toHaveBeenCalled()

      fireEvent.keyDown(screen.getByTestId('folded-section-expand-label'), { key: ' ' })
      expect(onToggleExpand).toHaveBeenCalledTimes(2)
      expect(onSectionSelect).not.toHaveBeenCalled()
    })

    it('expands on click in the ordinary mode', () => {
      const onToggleExpand = vi.fn()
      const onSectionSelect = vi.fn()
      renderSection({ onToggleExpand, onSectionSelect, turnCount: 3 })

      fireEvent.click(screen.getByTestId('folded-section-expand-btn'))
      expect(onToggleExpand).toHaveBeenCalledTimes(1)
      expect(onSectionSelect).not.toHaveBeenCalled()
    })
  })

  /**
   * Query contract for the navigation companion: the collapsed root carries
   * stable token lists so a member message can be located WITHOUT activating
   * the marker (querying/measuring never expands, right-click never expands).
   */
  describe('collapsed marker contract for the navigation companion', () => {
    it('exposes stable member/group token lists on the collapsed root', () => {
      renderSection({ groupIds: ['u1', 'u2'], messageIds: ['m1', 'm2', 'm3'] })
      const collapsed = screen.getByTestId('folded-section-collapsed')
      expect(collapsed.getAttribute('data-folded-group-ids')).toBe('u1 u2')
      expect(collapsed.getAttribute('data-folded-message-ids')).toBe('m1 m2 m3')
      // Exact-token lookup a companion uses: `~=` matches one whitespace
      // separated token, never a substring of a longer id.
      expect(collapsed.matches('[data-folded-message-ids~="m2"]')).toBe(true)
      expect(collapsed.matches('[data-folded-message-ids~="m9"]')).toBe(false)
    })

    it('omits the member list when the block carries no message ids', () => {
      renderSection({})
      expect(screen.getByTestId('folded-section-collapsed').hasAttribute('data-folded-message-ids')).toBe(false)
    })

    it('disables the unfold write when unfolding is not allowed here', async () => {
      const onToggleExpand = vi.fn()
      renderSection({ isUnfoldAllowed: false, onToggleExpand })
      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      expect(dropdownMenus()[0]).toHaveTextContent('取消折叠')
      // A disabled antd item never fires: the atomic command stays untouched.
      expect(document.querySelector('.ant-dropdown-menu-item-disabled')).not.toBeNull()
      fireEvent.click(screen.getByText('取消折叠'))
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
      expect(window.toast.success).not.toHaveBeenCalled()
      // The disabled unfold item does not swallow the browse toggle either.
      fireEvent.click(screen.getByText('展开查看'))
      expect(onToggleExpand).toHaveBeenCalledTimes(1)
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
    })

    it('uses the library default menu width instead of a per-popup wrapper', async () => {
      renderSection({})
      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      // No compensating width wrapper: the trigger-owned menu anchors at the
      // pointer with the default content-sized width, exactly like the group
      // menus (the old `trigger={[]}` needed `max-content` to fight the
      // trigger-width stretch).
      expect(document.querySelector('[style*="max-content"]')).toBeNull()
    })
  })

  describe('the block owns exactly one context menu', () => {
    it('opens ONE real menu on right-click and claims the gesture', async () => {
      const ancestorContextMenu = vi.fn()
      renderSection({ turnCount: 3 }, ancestorContextMenu)

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))

      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      const menu = dropdownMenus()[0]
      expect(menu).toHaveTextContent('展开查看')
      expect(menu).toHaveTextContent('取消折叠')
      // The exclusive claim: the message list's own host never sees the gesture.
      expect(ancestorContextMenu).not.toHaveBeenCalled()
    })

    it('selects the block on right-click in edit mode only when it is not selected yet', async () => {
      const onSectionSelect = vi.fn()
      const ancestorContextMenu = vi.fn()
      const first = renderSection({ onSectionSelect, isEditMode: true }, ancestorContextMenu)

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      expect(onSectionSelect).toHaveBeenCalledTimes(1)
      expect(onSectionSelect).toHaveBeenCalledWith({ isCtrl: false, isShift: false })
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      first.unmount()
      // An existing selection (possibly a multi-turn range) is respected.
      onSectionSelect.mockClear()
      const second = renderSection({ onSectionSelect, isEditMode: true, isSelected: true }, ancestorContextMenu)
      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      expect(onSectionSelect).not.toHaveBeenCalled()
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      second.unmount()
      expect(ancestorContextMenu).not.toHaveBeenCalled()
    })

    it('leaves an ordinary message right-click inside the expanded block untouched', async () => {
      const ancestorContextMenu = vi.fn()
      renderSection({ isExpanded: true }, ancestorContextMenu)

      fireEvent.contextMenu(screen.getByTestId('child-message'))

      // The message bodies keep the list's own menu: nothing is opened by the block.
      await waitFor(() => expect(ancestorContextMenu).toHaveBeenCalledTimes(1))
      expect(dropdownMenus()).toHaveLength(0)
    })

    it('toggles the browse view from the menu without writing a fold flag', async () => {
      const onToggleExpand = vi.fn()
      renderSection({ onToggleExpand })

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      fireEvent.click(screen.getByText('展开查看'))

      expect(onToggleExpand).toHaveBeenCalledTimes(1)
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
    })
  })

  describe('trigger-owned menu lifecycle', () => {
    it('opens exactly one menu at the gesture and never toggles the fold', async () => {
      const onToggleExpand = vi.fn()
      const ancestorContextMenu = vi.fn()
      renderSection({ onToggleExpand }, ancestorContextMenu)

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'), { clientX: 120, clientY: 200 })

      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      // Opening the menu is not a fold write and never toggles the browse view.
      expect(onToggleExpand).not.toHaveBeenCalled()
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
      expect(ancestorContextMenu).not.toHaveBeenCalled()
    })

    it('keeps the menu open across timers without toggling the fold', async () => {
      const onToggleExpand = vi.fn()
      renderSection({ onToggleExpand })

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'), { clientX: 120, clientY: 200 })
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))

      // The source carries no timer: advancing time and flushing microtasks
      // must leave the menu open and the fold untouched.
      vi.useFakeTimers()
      try {
        await act(async () => {
          vi.advanceTimersByTime(10000)
        })
        await act(async () => {})
      } finally {
        vi.useRealTimers()
      }
      expect(dropdownMenus()).toHaveLength(1)
      expect(onToggleExpand).not.toHaveBeenCalled()
    })

    it('closes on outside mousedown without toggling the fold', async () => {
      const onToggleExpand = vi.fn()
      renderSection({ onToggleExpand })

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))

      fireEvent.mouseDown(document.body)
      await waitFor(() => expect(dropdownMenus()).toHaveLength(0))
      expect(onToggleExpand).not.toHaveBeenCalled()
    })

    it('dismisses on trigger click instead of toggling the fold', async () => {
      const onToggleExpand = vi.fn()
      renderSection({ onToggleExpand })

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))

      // The click lands on the trigger (part of the popup for the library),
      // so the capture dismiss closes it and the toggle guard swallows it.
      fireEvent.click(screen.getByTestId('folded-section-expand-label'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(0))
      expect(onToggleExpand).not.toHaveBeenCalled()

      // A later click with the menu closed expands again.
      fireEvent.click(screen.getByTestId('folded-section-expand-label'))
      expect(onToggleExpand).toHaveBeenCalledTimes(1)
    })

    it('closes on Escape without toggling the fold', async () => {
      const onToggleExpand = vi.fn()
      renderSection({ onToggleExpand })

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))

      fireEvent.keyDown(document.documentElement, { key: 'Escape', keyCode: 27 })
      await waitFor(() => expect(dropdownMenus()).toHaveLength(0))
      expect(onToggleExpand).not.toHaveBeenCalled()
    })

    it('opens from the keyboard menu key on the collapsed marker', async () => {
      const onToggleExpand = vi.fn()
      renderSection({ onToggleExpand })

      fireEvent.keyDown(screen.getByTestId('folded-section-expand-label'), { key: 'ContextMenu' })
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      expect(onToggleExpand).not.toHaveBeenCalled()
      expect(setTurnFoldsMock).not.toHaveBeenCalled()
    })

    it('opens one menu from expanded chrome but leaves body gestures alone', async () => {
      const ancestorContextMenu = vi.fn()
      const onToggleExpand = vi.fn()
      renderSection({ isExpanded: true, onToggleExpand }, ancestorContextMenu)

      fireEvent.contextMenu(screen.getByTestId('folded-section-gutter-rail'), { clientX: 40, clientY: 300 })
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      expect(ancestorContextMenu).not.toHaveBeenCalled()
      expect(onToggleExpand).not.toHaveBeenCalled()

      fireEvent.mouseDown(document.body)
      await waitFor(() => expect(dropdownMenus()).toHaveLength(0))

      fireEvent.contextMenu(screen.getByTestId('folded-section-header'), { clientX: 200, clientY: 320 })
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      expect(ancestorContextMenu).not.toHaveBeenCalled()
    })
  })

  describe('unfold write', () => {
    const openUnfold = async () => {
      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      fireEvent.click(screen.getByText('取消折叠'))
      await waitFor(() => expect(window.toast.success).toHaveBeenCalled())
    }

    it('unfolds the whole block with ONE atomic turn command carrying stable group ids', async () => {
      renderSection({ groupIds: ['u1', 'u2', 'u3'] })

      await openUnfold()

      // One command for the whole block — never one write per member row.
      expect(setTurnFoldsMock).toHaveBeenCalledTimes(1)
      expect(setTurnFoldsMock).toHaveBeenCalledWith('t1', ['u1', 'u2', 'u3'], false, null)
      expect(window.toast.error).not.toHaveBeenCalled()
    })

    it('de-duplicates the block turns so one turn is never sent twice', async () => {
      renderSection({ groupIds: ['u1', 'u1', 'u2'] })

      await openUnfold()

      expect(setTurnFoldsMock).toHaveBeenCalledTimes(1)
      expect(setTurnFoldsMock).toHaveBeenCalledWith('t1', ['u1', 'u2'], false, null)
    })

    it('reports a failure for the unfold and never a success when the command rejects', async () => {
      setTurnFoldsMock.mockRejectedValue(new Error('write rejected'))
      renderSection({ groupIds: ['u1', 'u2', 'u3'] })

      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      fireEvent.click(screen.getByText('取消折叠'))

      await waitFor(() => expect(window.toast.error).toHaveBeenCalledWith('取消折叠失败，请重试'))
      expect(window.toast.success).not.toHaveBeenCalled()
      // The atomic command is issued once: Main is all-or-nothing, so there is
      // no partial retry loop and no row-level fallback.
      expect(setTurnFoldsMock).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * The collapsed block IS the group's visible extent while whole turns are
   * folded, so its fixed header row must stand in for their bodies in the
   * group's measured span. These exercise the REAL manager/provider: a
   * group's run host registers itself exactly as a carrying run does, and
   * the only thing under test is whether the block's header joins that
   * measurement.
   */
  describe('fixed header measures the group span', () => {
    const stubRect = (element: HTMLElement, rect: { top: number; bottom: number }) => {
      Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () =>
          ({
            ...rect,
            x: 0,
            y: rect.top,
            left: 0,
            right: 100,
            width: 100,
            height: rect.bottom - rect.top,
            toJSON: () => ({})
          }) as DOMRectReadOnly
      })
    }

    /** A carrying run host of one group, registered exactly like the real flow. */
    const RunHostProbe = ({ groupId }: { groupId: string }) => {
      const manager = useSegmentGroupLayoutManager()
      const ref = useRef<HTMLDivElement | null>(null)
      useLayoutEffect(() => {
        const element = ref.current
        if (!manager || !element) return
        return manager.registerRun(groupId, element, { isHeader: true, endsGroup: true })
      }, [manager, groupId])
      return <div ref={ref} data-testid="probe-run-host" />
    }

    const GeometryProbe = ({ groupId }: { groupId: string }) => {
      const geometry = useSegmentGroupGeometry(groupId)
      return <div data-testid="probe-geometry">{geometry ? `${geometry.top}/${geometry.height}` : 'none'}</div>
    }

    const tree = (props: Partial<React.ComponentProps<typeof FoldedSection>>) => (
      <SegmentGroupPresentationProvider>
        <RunHostProbe groupId="seg-1" />
        <GeometryProbe groupId="seg-1" />
        <FoldedSection
          isExpanded={false}
          onToggleExpand={vi.fn()}
          turnCount={4}
          groupIds={['u2', 'u3', 'u4', 'u5']}
          scopeIds={['seg-1']}
          topicId="t1"
          {...props}>
          <div data-testid="child-message">Child turn content</div>
        </FoldedSection>
      </SegmentGroupPresentationProvider>
    )
    it('spans the fixed header when the whole group is inside the block', () => {
      const view = render(tree({ rangeScopeIds: ['seg-1'] }))

      // Ground truth of the observed defect: the group's run hosts keep their
      // place but contribute no body height, so only the header is measurable.
      stubRect(screen.getByTestId('probe-run-host'), { top: 341.55, bottom: 373.55 })
      stubRect(screen.getByTestId('folded-section-header'), { top: 309.55, bottom: 335.55 })
      view.rerender(tree({ rangeScopeIds: ['seg-1'] }))

      const [top, height] = screen.getByTestId('probe-geometry').textContent.split('/').map(Number)
      expect(top).toBeCloseTo(309.55 - 341.55, 2)
      expect(height).toBeCloseTo(373.55 - 309.55 - 12, 2)
      expect(height).toBeGreaterThan(0)
      view.unmount()
    })

    it('never claims the span of a group that still has runs outside the block', () => {
      const view = render(tree({ rangeScopeIds: [] }))

      stubRect(screen.getByTestId('probe-run-host'), { top: 341.55, bottom: 373.55 })
      stubRect(screen.getByTestId('folded-section-header'), { top: 309.55, bottom: 335.55 })
      view.rerender(tree({ rangeScopeIds: [] }))

      // Run-only rule, unchanged: the rail starts just below the header pill.
      expect(screen.getByTestId('probe-geometry').textContent).toBe('28/0')
      view.unmount()
    })

    it('drops the range member again when the browse view expands', () => {
      const collapsed = render(tree({ rangeScopeIds: ['seg-1'] }))
      stubRect(screen.getByTestId('probe-run-host'), { top: 341.55, bottom: 373.55 })
      stubRect(screen.getByTestId('folded-section-header'), { top: 309.55, bottom: 335.55 })
      collapsed.rerender(tree({ rangeScopeIds: ['seg-1'] }))
      expect(Number(screen.getByTestId('probe-geometry').textContent.split('/')[0])).toBeLessThan(0)

      collapsed.rerender(tree({ rangeScopeIds: ['seg-1'], isExpanded: true }))
      expect(screen.getByTestId('probe-geometry').textContent).toBe('28/0')
      collapsed.unmount()
    })
  })

  /**
   * The single-shell contract: one shell, one fixed header, one rail track,
   * one hit target and one hover state across the toggle. These prove DOM
   * identity (the SAME nodes rerendered, not a branch swap), shared origin
   * constants/classes, and the shared active-color rule — all without
   * claiming real pixels out of jsdom.
   */
  describe('single shell, single header, single rail', () => {
    const renderToggleable = (isExpanded: boolean) =>
      render(
        <FoldedSection
          isExpanded={isExpanded}
          onToggleExpand={vi.fn()}
          turnCount={3}
          groupIds={['u1', 'u2', 'u3']}
          topicId="t1">
          <div data-testid="child-message">Child turn content</div>
        </FoldedSection>
      )

    const rerenderToggleable = (view: ReturnType<typeof render>, isExpanded: boolean) =>
      view.rerender(
        <FoldedSection
          isExpanded={isExpanded}
          onToggleExpand={vi.fn()}
          turnCount={3}
          groupIds={['u1', 'u2', 'u3']}
          topicId="t1">
          <div data-testid="child-message">Child turn content</div>
        </FoldedSection>
      )

    const styleText = () =>
      Array.from(document.querySelectorAll('style'))
        .map((element) => (element.textContent ?? '').replace(/\s+/g, ''))
        .join('')

    it('keeps the SAME shell, header, track, line, hit and label nodes across the toggle', () => {
      const view = renderToggleable(false)
      const shellBefore = screen.getByTestId('folded-section-collapsed')
      const headerBefore = screen.getByTestId('folded-section-header')
      const trackBefore = screen.getByTestId('folded-section-rail-track')
      const lineBefore = screen.getByTestId('folded-section-rail-line')
      const hitBefore = screen.getByTestId('folded-section-expand-btn')
      const labelBefore = screen.getByTestId('folded-section-expand-label')

      rerenderToggleable(view, true)
      // One shell: the mode test id renames the state, the node is identical.
      expect(screen.getByTestId('folded-section-expanded')).toBe(shellBefore)
      expect(screen.getByTestId('folded-section-header')).toBe(headerBefore)
      expect(screen.getByTestId('folded-section-rail-track')).toBe(trackBefore)
      expect(screen.getByTestId('folded-section-rail-line')).toBe(lineBefore)
      expect(screen.getByTestId('folded-section-gutter-rail')).toBe(hitBefore)
      expect(screen.getByTestId('folded-section-expand-label')).toBe(labelBefore)
      view.unmount()
    })

    it('keeps one shell/header/track class and flips only the state attributes', () => {
      const view = renderToggleable(false)
      const trackBefore = screen.getByTestId('folded-section-rail-track')
      expect(screen.getByTestId('folded-section-collapsed')).toHaveClass('folded-section-shell')
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-fold-shell', 'true')
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-expanded', 'false')
      expect(screen.getByTestId('folded-section-header')).toHaveClass('folded-section-head')
      expect(trackBefore).toHaveClass('folded-section-railtrack')
      expect(trackBefore).toHaveAttribute('data-expanded', 'false')
      const collapsedTrackClass = trackBefore.className

      rerenderToggleable(view, true)

      const shellAfter = screen.getByTestId('folded-section-expanded')
      expect(shellAfter).toHaveClass('folded-section-shell')
      expect(shellAfter).toHaveAttribute('data-fold-shell', 'true')
      expect(shellAfter).toHaveAttribute('data-expanded', 'true')
      expect(screen.getByTestId('folded-section-header')).toHaveClass('folded-section-head')
      const trackAfter = screen.getByTestId('folded-section-rail-track')
      expect(trackAfter).toHaveClass('folded-section-railtrack')
      expect(trackAfter).toHaveAttribute('data-expanded', 'true')
      // Same role, different length styling: the track class changes with
      // the mode while the shared classes stay put.
      expect(trackAfter.className).not.toBe(collapsedTrackClass)
      view.unmount()
    })

    it('pins both rail lengths to one shared origin with shared stroke/hit constants', async () => {
      const rail = await import('../GroupInteractionRail')
      const fold = await import('../FoldedSection')
      expect(rail.INTERACTION_RAIL_LINE_WIDTH_PX).toBe(2)
      expect(rail.INTERACTION_RAIL_HIT_WIDTH_PX).toBe(8)
      expect(rail.INTERACTION_RAIL_COLLAPSED_HEIGHT_PX).toBe(20)
      expect(fold.FOLD_RAIL_ORIGIN_PX).toBe(8)
      const view = renderToggleable(false)
      const css = styleText()
      // One origin rule for both states, the short collapsed length, and the
      // shared 2px stroke off the same constants — stylesheet rules, not pixels.
      expect(css).toContain('top:8px')
      expect(css).toContain('height:20px')
      expect(css).toContain('width:2px')
      view.unmount()
    })

    it('lights the shared line with the fold active color while hovering either end', () => {
      const view = renderToggleable(false)
      // Hovering the text lights the region; the line rule paints the fold
      // active color instead of the group's brightness lift.
      fireEvent.mouseEnter(screen.getByTestId('folded-section-expand-label'))
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-fold-region-active', 'true')
      expect(styleText()).toContain('background-color:var(--color-primary)')
      fireEvent.mouseLeave(screen.getByTestId('folded-section-expand-label'))
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-fold-region-active', 'false')
      view.unmount()
    })
  })

  /**
   * Unfold restores whole turns, and the rows land only after the authority
   * round-trip. The gesture must therefore join the EXISTING viewport pipeline:
   * captured before the dispatch, declared deferred, settled with the outcome.
   * These run the real helpers against a real controller — no callback spy.
   */
  describe('unfold joins the shared viewport intent', () => {
    beforeEach(() => {
      ;(window as unknown as { keyv: unknown }).keyv = {
        get: () => undefined,
        set: () => undefined,
        remove: () => undefined
      }
      const CSSApi = (globalThis as unknown as { CSS?: { escape?: (v: string) => string } }).CSS
      if (!CSSApi?.escape) {
        vi.stubGlobal('CSS', { escape: (v: string) => v })
      }
    })

    const buildFlowDom = () => {
      const container = document.createElement('div')
      container.id = 'messages'
      const scope = document.createElement('div')
      scope.setAttribute('data-interaction-scope-id', 'seg-1')
      const region = document.createElement('div')
      region.setAttribute('data-interaction-region', 'segment-header')
      scope.appendChild(region)
      container.appendChild(scope)
      document.body.appendChild(container)
      return { container, region }
    }

    /** Drive the real controller to a stable, anchored state for topic t1. */
    const driveStableMessage = (controller: RouteViewportController) => {
      const { epoch } = controller.request({
        kind: 'top',
        topicId: 't1',
        targetRoute: null,
        saved: { scrollTop: -400, messageId: 'm1', intraRowOffset: 100, isAtBottom: false }
      })
      controller.appliedWindow(epoch)
      controller.firstPositioned(epoch, 'placed')
      controller.revealed(epoch)
      const out = controller.commitStable(epoch, {
        messageId: 'm1',
        intraRowOffset: 100,
        scrollTop: -400,
        isAtBottom: false
      })
      expect(out.committed).toBe(true)
    }

    const renderWithViewport = (controller: RouteViewportController) => {
      const commands = {
        controller,
        notifyChanged: vi.fn(),
        freezeDisplayed: vi.fn(() => false),
        readSnapshot: vi.fn(() => null),
        requestTopRoute: vi.fn(),
        registerCapturer: vi.fn()
      } as unknown as RouteViewportCommands
      return render(
        <RouteViewportCommandsContext value={commands}>
          <FoldedSection
            isExpanded={false}
            onToggleExpand={vi.fn()}
            turnCount={2}
            groupIds={['u2', 'u3']}
            scopeIds={['seg-1']}
            topicId="t1">
            <div data-testid="child-message">Child turn content</div>
          </FoldedSection>
        </RouteViewportCommandsContext>
      )
    }

    const deferred = () => {
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    const openUnfold = async () => {
      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      fireEvent.click(screen.getByText('取消折叠'))
    }

    it('arms the group header hold before dispatching and keeps it through the gap', async () => {
      const { container } = buildFlowDom()
      const controller = new RouteViewportController({ topicId: 't1', route: null })
      driveStableMessage(controller)
      const pending = deferred()
      setTurnFoldsMock.mockImplementation(() => pending.promise)
      renderWithViewport(controller)

      await openUnfold()
      // The authority round-trip is still in flight: the shared gesture is armed
      // on the block's own group scope + header region, and marked deferred.
      await act(async () => {})
      expect(controller.activeInteractionIntent).toMatchObject({
        scopeKind: 'group',
        scopeId: 'seg-1',
        region: 'segment-header',
        pendingLayoutMutation: true
      })
      const capturedOffset = controller.activeInteractionIntent?.offset
      expect(Number.isFinite(capturedOffset)).toBe(true)

      await act(async () => {
        pending.resolve()
        await pending.promise
      })
      // `applied` releases the deferred flag on the SAME gesture: the keeper
      // now holds the header row while the returned bodies land.
      expect(controller.activeInteractionIntent).toMatchObject({
        scopeKind: 'group',
        scopeId: 'seg-1',
        region: 'segment-header',
        pendingLayoutMutation: false,
        offset: capturedOffset
      })
      expect(window.toast.success).toHaveBeenCalled()
      container.remove()
    })

    it('drops the gesture fail-closed when the unfold command rejects', async () => {
      const { container } = buildFlowDom()
      const controller = new RouteViewportController({ topicId: 't1', route: null })
      driveStableMessage(controller)
      const pending = deferred()
      setTurnFoldsMock.mockImplementation(() => pending.promise)
      renderWithViewport(controller)

      await openUnfold()
      await act(async () => {})
      expect(controller.activeInteractionIntent?.pendingLayoutMutation).toBe(true)

      await act(async () => {
        pending.reject(new Error('write rejected'))
        await pending.promise.catch(() => undefined)
      })
      // `failed` clears the gesture: no stale hold, no snapshot, no adopt.
      expect(controller.activeInteractionIntent).toBeNull()
      expect(window.toast.error).toHaveBeenCalledWith('取消折叠失败，请重试')
      expect(window.toast.success).not.toHaveBeenCalled()
      container.remove()
    })

    it('still performs the unfold when no viewport owner is present', async () => {
      renderSection({ groupIds: ['u1'] })
      fireEvent.contextMenu(screen.getByTestId('folded-section-collapsed'))
      await waitFor(() => expect(dropdownMenus()).toHaveLength(1))
      fireEvent.click(screen.getByText('取消折叠'))

      await waitFor(() => expect(setTurnFoldsMock).toHaveBeenCalledTimes(1))
      expect(window.toast.error).not.toHaveBeenCalled()
    })
  })
  /**
   * No-indent geometry: the shell carries no transverse padding, carried
   * bodies keep their no-fold x, and only the absolute rail (plus the header
   * label's own local gap, measured from the VISIBLE line edge) follows the
   * nest state. Nest comes from `scopeIds` alone — `rangeScopeIds` lists only
   * whole groups, so a partially folded group would leak through as top-level.
   * Stylesheet/computed-style mechanism, no pixel snapshots.
   */
  describe('no-indent geometry with nested-only rail step', () => {
    it('names the visible-line-edge offset formula in constants', async () => {
      const rail = await import('../GroupInteractionRail')
      const fold = await import('../FoldedSection')
      expect(rail.INTERACTION_RAIL_LINE_WIDTH_PX).toBe(2)
      expect(rail.INTERACTION_RAIL_HIT_WIDTH_PX).toBe(8)
      expect(fold.FOLD_RAIL_ORIGIN_PX).toBe(8)
      expect(fold.FOLD_RAIL_BASE_LEFT_PX).toBe(-10)
      // The base IS the shared outset: the ScrollContainer's own 10px gutter.
      expect(rail.INTERACTION_RAIL_OUTSET_PX).toBe(10)
      expect(fold.FOLD_RAIL_BASE_LEFT_PX).toBe(-rail.INTERACTION_RAIL_OUTSET_PX)
      expect(fold.FOLD_RAIL_NESTED_INSET_PX).toBe(
        rail.INTERACTION_RAIL_HIT_WIDTH_PX + rail.INTERACTION_RAIL_LINE_WIDTH_PX
      )
      // Baseline + step lands the nested rail at the shell edge.
      expect(fold.FOLD_RAIL_BASE_LEFT_PX + fold.FOLD_RAIL_NESTED_INSET_PX).toBe(0)
      expect(fold.FOLD_HEADER_TEXT_GAP_PX).toBe(8)
      // Header text = railLeft + visible line width + gap: 0 top-level, 10 nested.
      expect(fold.FOLD_RAIL_BASE_LEFT_PX + rail.INTERACTION_RAIL_LINE_WIDTH_PX + fold.FOLD_HEADER_TEXT_GAP_PX).toBe(0)
      expect(
        fold.FOLD_RAIL_BASE_LEFT_PX +
          fold.FOLD_RAIL_NESTED_INSET_PX +
          rail.INTERACTION_RAIL_LINE_WIDTH_PX +
          fold.FOLD_HEADER_TEXT_GAP_PX
      ).toBe(10)
    })

    it('keeps the shell at zero padding in both states', () => {
      const collapsed = renderSection({ isExpanded: false })
      const shell = screen.getByTestId('folded-section-collapsed')
      expect(shell).toHaveAttribute('data-fold-nested', 'false')
      expect(shell).toHaveStyle({ paddingLeft: '0px' })
      collapsed.unmount()

      renderSection({ isExpanded: true })
      const expandedShell = screen.getByTestId('folded-section-expanded')
      expect(expandedShell).toHaveAttribute('data-fold-nested', 'false')
      expect(expandedShell).toHaveStyle({ paddingLeft: '0px' })
    })

    it('reads nested from scopeIds only, stepping just the rail and the label gap', () => {
      // No scope at all: top-level fold, rail on the shared outset, text 8px
      // clear of the visible line edge.
      const top = renderSection({})
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-fold-nested', 'false')
      expect(screen.getByTestId('folded-section-railbox')).toHaveStyle({ left: '-10px' })
      expect(screen.getByTestId('folded-section-expand-label')).toHaveStyle({ paddingLeft: '0px' })
      top.unmount()

      // Partial fold: scopeIds says inside a group while rangeScopeIds stays
      // empty — still nested, rail steps in, bodies untouched.
      const partial = renderSection({ scopeIds: ['seg-1'], rangeScopeIds: [] })
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-fold-nested', 'true')
      expect(screen.getByTestId('folded-section-railbox')).toHaveStyle({ left: '0px' })
      expect(screen.getByTestId('folded-section-expand-label')).toHaveStyle({ paddingLeft: '10px' })
      partial.unmount()

      // rangeScopeIds alone never nests: it lists only whole groups inside.
      const rangeOnly = renderSection({ rangeScopeIds: ['seg-1'] })
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-fold-nested', 'false')
      rangeOnly.unmount()

      // Blank scope ids never nest either.
      const blank = renderSection({ scopeIds: [''] })
      expect(screen.getByTestId('folded-section-collapsed')).toHaveAttribute('data-fold-nested', 'false')
      blank.unmount()
    })

    it('keeps the nested offsets and the shared origin identical in the expanded state', () => {
      renderSection({ isExpanded: true, scopeIds: ['seg-1'] })
      expect(screen.getByTestId('folded-section-expanded')).toHaveAttribute('data-fold-nested', 'true')
      expect(screen.getByTestId('folded-section-railbox')).toHaveStyle({ left: '0px' })
      expect(screen.getByTestId('folded-section-expand-label')).toHaveStyle({ paddingLeft: '10px' })
      expect(screen.getByTestId('folded-section-gutter-rail')).toBeInTheDocument()
      // The browse-view body wrapper adds no transverse shift of its own.
      const wrapper = screen.getByTestId('child-message').parentElement as HTMLElement
      expect(wrapper).toHaveStyle({ paddingLeft: '0px', marginLeft: '0px' })
    })
  })
  /**
   * Browse expand/collapse motion, on the block's ONE content container.
   *
   * The toggle changes what the block shows in the same synchronous commit AND
   * arms a measured height motion on one time base (the opening direction joins
   * a fade that lands at the body region's own dim). Settle comes from the
   * JS space driver's own completion promise (its last frame wrote the exact
   * endpoint and settled the keeper synchronously), never a timer and never a
   * WAAPI `finished` probe; reduced motion settles in the same pre-paint pass.
   *
   * Both endpoints are the CONTAINER's own geometry: the collapsed height it
   * really has while collapsed, and the natural expanded height measured while
   * the new bodies are mounted. The body region reports 0px in the stub below —
   * exactly like production, where bodies are hidden while collapsed — so any
   * regression that takes an endpoint from the hidden body box fails here.
   */
  describe('browse expand/collapse motion', () => {
    /** Title row only: the container's real height while no bodies show. */
    const COLLAPSED_CONTENT_HEIGHT = 44
    /** Title row plus the browse bodies. */
    const EXPANDED_CONTENT_HEIGHT = 284
    // Height an ARMED container reports: any positive value emulates the
    // container mid-motion for the reversal case.
    let armedHeight = 0
    // Controllable frame clock for the JS space driver. The component resolves
    // the driver's scheduler from the window rAF pair at motion time, so a
    // queued stub makes every height write — and the synchronous keeper
    // settlement after each write — deterministic without touching the keeper.
    let rafQueue: Map<number, (now: number) => void>
    let rafNextId: number
    let clockNow: number
    let prevRect: PropertyDescriptor | undefined
    let prevRaf: PropertyDescriptor | undefined
    let prevCancelRaf: PropertyDescriptor | undefined
    let prevMatchMedia: PropertyDescriptor | undefined
    let nowSpy: { mockRestore: () => void } | null

    const rectOf = (height: number) =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 100,
        bottom: height,
        width: 100,
        height,
        toJSON() {}
      }) as DOMRectReadOnly

    beforeEach(() => {
      armedHeight = 0
      rafQueue = new Map()
      rafNextId = 1
      clockNow = 1000
      prevRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value(this: HTMLElement) {
          // Only the content container is measured. It reports the height of the
          // presentation it currently shows, or its live mid-motion height while
          // a motion is armed.
          if (this.getAttribute('data-testid') === 'folded-section-content') {
            if (this.getAttribute('data-browse-motion') === 'true' && armedHeight > 0) return rectOf(armedHeight)
            return rectOf(
              this.getAttribute('data-browse-expanded') === 'true' ? EXPANDED_CONTENT_HEIGHT : COLLAPSED_CONTENT_HEIGHT
            )
          }
          // Everything else — the hidden bodies in particular — measures 0px.
          return rectOf(0)
        }
      })
      // The driver resolves its scheduler from the window rAF pair at motion
      // time: queue callbacks here so the test — never production timing —
      // decides when each frame (and its synchronous keeper settlement) runs.
      prevRaf = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame')
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: (callback: (now: number) => void): number => {
          const id = rafNextId++
          rafQueue.set(id, callback)
          return id
        }
      })
      prevCancelRaf = Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame')
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value: (id: number): void => {
          rafQueue.delete(id)
        }
      })
      // The driver's clock: advancing it past the 200ms window finishes the
      // motion exactly, without waiting on any real timer.
      nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clockNow)
      prevMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    })

    afterEach(() => {
      // jsdom defines getBoundingClientRect on a prototype above HTMLElement,
      // so there is no own descriptor to restore — the stub must be removed,
      // never left in place, or it leaks into every later describe and arms
      // a motion with fake geometry.
      if (prevRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', prevRect)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect
      if (prevRaf) Object.defineProperty(window, 'requestAnimationFrame', prevRaf)
      else delete (window as unknown as Record<string, unknown>).requestAnimationFrame
      if (prevCancelRaf) Object.defineProperty(window, 'cancelAnimationFrame', prevCancelRaf)
      else delete (window as unknown as Record<string, unknown>).cancelAnimationFrame
      nowSpy?.mockRestore()
      nowSpy = null
      if (prevMatchMedia) {
        Object.defineProperty(window, 'matchMedia', prevMatchMedia)
      } else {
        delete (window as unknown as Record<string, unknown>).matchMedia
      }
      prevRaf = undefined
      prevCancelRaf = undefined
      prevRect = undefined
      prevMatchMedia = undefined
    })

    /**
     * Run one queued frame generation at `clockNow + dtMs`, inside act. The
     * driver's write — and its synchronous keeper settlement — happen inside
     * the callback, so assertions right after this call see the settled layout.
     */
    function fireFrame(dtMs: number) {
      clockNow += dtMs
      const pending = [...rafQueue.values()]
      rafQueue.clear()
      act(() => {
        for (const callback of pending) callback(clockNow)
      })
    }

    /** Drive every armed frame to the exact endpoint and flush the settle. */
    async function settleMotion() {
      await act(async () => {
        for (let i = 0; i < 30; i++) {
          const pending = [...rafQueue.values()]
          rafQueue.clear()
          if (pending.length === 0) {
            await Promise.resolve()
            if (rafQueue.size === 0) break
            continue
          }
          clockNow += 16
          for (const callback of pending) callback(clockNow)
          await Promise.resolve()
        }
      })
    }

    /**
     * The flow's own shape: the run host stays mounted in both states and only
     * its bodies leave when the browse view closes.
     */
    const motionSection = (expanded: boolean, commands?: RouteViewportCommands) => {
      const section = (
        <FoldedSection
          isExpanded={expanded}
          onToggleExpand={vi.fn()}
          turnCount={3}
          groupIds={['u1', 'u2', 'u3']}
          topicId="t1">
          <div data-testid="run-host">{expanded ? <div data-testid="carried-body">Child turn content</div> : null}</div>
        </FoldedSection>
      )
      if (!commands) return section
      return <RouteViewportCommandsContext value={commands}>{section}</RouteViewportCommandsContext>
    }

    /** A commands value carrying only the layout settler: the keeper bridge. */
    const settleCommands = () =>
      ({
        settleLayout: vi.fn()
      }) as unknown as RouteViewportCommands

    const contentHost = (): HTMLElement => screen.getByTestId('folded-section-content')
    const phasedHost = (): HTMLElement | null => document.querySelector('[data-browse-phase]')

    it('mounts either settled state with no motion armed', () => {
      const collapsed = render(motionSection(false))
      expect(screen.getByTestId('folded-section-collapsed')).toBeInTheDocument()
      expect(phasedHost()).toBeNull()
      expect(contentHost().hasAttribute('data-browse-motion')).toBe(false)
      collapsed.unmount()

      render(motionSection(true))
      expect(screen.getByTestId('folded-section-expanded')).toBeInTheDocument()
      expect(phasedHost()).toBeNull()
      expect(screen.getByTestId('carried-body')).toBeInTheDocument()
    })

    it('expands from the live collapsed height to the measured expanded height', async () => {
      const view = render(motionSection(false))
      expect(phasedHost()).toBeNull()

      view.rerender(motionSection(true))

      const content = contentHost()
      // Armed: the container itself is the clipped, JS-driven box. The driver
      // writes the live collapsed height synchronously in the arming commit —
      // the first painted frame already shows the true `from`, and each frame
      // settles the keeper before it returns.
      expect(content.getAttribute('data-browse-phase')).toBe('expanding')
      expect(content.getAttribute('data-browse-motion')).toBe('true')
      expect(content.style.height).toBe(`${COLLAPSED_CONTENT_HEIGHT}px`)
      // One frame in: the space is mid-motion, never at an endpoint yet.
      fireFrame(50)
      const midHeight = Number.parseFloat(content.style.height)
      expect(Number.isFinite(midHeight)).toBe(true)
      expect(midHeight).toBeGreaterThan(COLLAPSED_CONTENT_HEIGHT)
      expect(midHeight).toBeLessThan(EXPANDED_CONTENT_HEIGHT)
      // Bodies are mounted for the whole motion.
      expect(screen.getByTestId('run-host')).toBeInTheDocument()
      expect(screen.getByTestId('carried-body')).toBeInTheDocument()
      // The fade rides the single body region only: the title row is chrome.
      expect(screen.getByTestId('folded-section-body')).toHaveAttribute('data-browse-phase', 'expanding')
      expect(screen.getByTestId('folded-section-header')).not.toHaveAttribute('data-browse-phase')

      await settleMotion()
      expect(phasedHost()).toBeNull()
      expect(screen.getByTestId('folded-section-expanded')).toBeInTheDocument()
      expect(screen.getByTestId('carried-body')).toBeInTheDocument()
      // Settled: the driver-owned inline height is cleared back to natural
      // `height: auto` — it never lingers as an inline style.
      expect(content.style.height).toBe('')
      view.unmount()
    })

    it('collapses from the live expanded height to the collapsed height it really had', async () => {
      const view = render(motionSection(false))
      view.rerender(motionSection(true))
      await settleMotion()
      expect(phasedHost()).toBeNull()
      const runHost = screen.getByTestId('run-host')

      view.rerender(motionSection(false))

      const content = contentHost()
      expect(content.getAttribute('data-browse-phase')).toBe('collapsing')
      // The driver writes the live expanded height synchronously in the arming
      // commit and lands on the recorded collapsed height it really had.
      expect(content.style.height).toBe(`${EXPANDED_CONTENT_HEIGHT}px`)
      // The bodies stay rendered (clipped away as the space closes) and the run
      // host keeps its node: nothing is unmounted mid-motion. The body region
      // fades the browse dim out (collapsing phase) so the settle lands at
      // opacity 1 with no step.
      expect(screen.getByTestId('carried-body')).toBeInTheDocument()
      expect(screen.getByTestId('run-host')).toBe(runHost)
      expect(screen.getByTestId('folded-section-body')).toHaveAttribute('data-browse-phase', 'collapsing')
      expect(screen.getByTestId('folded-section-body')).toHaveAttribute('data-browse-view', 'expanded')
      // Visual phase: chrome stays expanded while bodies are on screen.
      expect(screen.getByTestId('folded-section-expanded')).toBeInTheDocument()
      expect(screen.getByTestId('folded-section-rail-track')).toHaveAttribute('data-expanded', 'true')
      expect(screen.getByTestId('folded-section-gutter-rail')).toBeInTheDocument()

      await settleMotion()
      expect(phasedHost()).toBeNull()
      expect(screen.getByTestId('folded-section-collapsed')).toBeInTheDocument()
      // The cleanup clears the driver-owned inline height back to natural.
      expect(content.style.height).toBe('')
      // The settle drops the bodies, never the host.
      expect(screen.queryByTestId('carried-body')).not.toBeInTheDocument()
      expect(screen.getByTestId('run-host')).toBe(runHost)
      view.unmount()
    })

    it('projects one visual phase to chrome, track, summary, hit and scope member', async () => {
      const view = render(motionSection(false))
      view.rerender(motionSection(true))
      await settleMotion()
      // Settled expanded: long track, gutter hit, expanded summary intent.
      expect(screen.getByTestId('folded-section-expanded')).toBeInTheDocument()
      expect(screen.getByTestId('folded-section-rail-track')).toHaveAttribute('data-expanded', 'true')
      expect(screen.getByTestId('folded-section-gutter-rail')).toBeInTheDocument()
      expect(screen.getByTestId('folded-section-content')).toHaveAttribute('data-browse-expanded', 'true')
      expect(screen.getByTestId('folded-section-body')).toHaveAttribute('data-browse-view', 'expanded')

      view.rerender(motionSection(false))
      // Collapsing: bodies still on screen so chrome stays expanded — no
      // first frame of collapsed chrome over retained bodies.
      expect(screen.getByTestId('folded-section-expanded')).toBeInTheDocument()
      expect(screen.getByTestId('folded-section-rail-track')).toHaveAttribute('data-expanded', 'true')
      expect(screen.getByTestId('folded-section-gutter-rail')).toBeInTheDocument()
      expect(screen.getByTestId('folded-section-content')).toHaveAttribute('data-browse-expanded', 'true')
      expect(screen.getByTestId('folded-section-content')).toHaveAttribute('data-browse-phase', 'collapsing')
      expect(screen.getByTestId('carried-body')).toBeInTheDocument()

      await settleMotion()
      // Single settle flip: chrome, track, hit and body land together.
      expect(screen.getByTestId('folded-section-collapsed')).toBeInTheDocument()
      expect(screen.getByTestId('folded-section-rail-track')).toHaveAttribute('data-expanded', 'false')
      expect(screen.getByTestId('folded-section-expand-btn')).toBeInTheDocument()
      expect(screen.getByTestId('folded-section-content')).toHaveAttribute('data-browse-expanded', 'false')
      expect(screen.getByTestId('folded-section-body')).toHaveAttribute('data-browse-view', 'collapsed')
      expect(screen.queryByTestId('carried-body')).not.toBeInTheDocument()
      view.unmount()
    })

    it('keeps keyboard focus highlight when the hover leaves', () => {
      const view = render(motionSection(false))
      const shell = screen.getByTestId('folded-section-collapsed')
      const label = screen.getByTestId('folded-section-expand-label')
      fireEvent.focus(label)
      expect(shell).toHaveAttribute('data-fold-region-active', 'true')
      // Leaving the hover must not erase a held focus.
      fireEvent.mouseEnter(label)
      fireEvent.mouseLeave(label)
      expect(shell).toHaveAttribute('data-fold-region-active', 'true')
      fireEvent.blur(label)
      expect(shell).toHaveAttribute('data-fold-region-active', 'false')
      // Hover alone still lights the region without any focus.
      fireEvent.mouseEnter(label)
      expect(shell).toHaveAttribute('data-fold-region-active', 'true')
      fireEvent.mouseLeave(label)
      expect(shell).toHaveAttribute('data-fold-region-active', 'false')
      view.unmount()
    })

    it('shows the edit selection cover only for the settled collapsed block', async () => {
      const editSection = (expanded: boolean) => (
        <FoldedSection
          isExpanded={expanded}
          onToggleExpand={vi.fn()}
          turnCount={3}
          groupIds={['u1', 'u2', 'u3']}
          topicId="t1"
          isEditMode>
          <div data-testid="run-host">{expanded ? <div data-testid="carried-body">Child turn content</div> : null}</div>
        </FoldedSection>
      )
      const view = render(editSection(false))
      expect(screen.getByTestId('folded-section-select-cover')).toBeInTheDocument()
      view.rerender(editSection(true))
      await settleMotion()
      expect(screen.queryByTestId('folded-section-select-cover')).not.toBeInTheDocument()
      view.rerender(editSection(false))
      // Closing: cover stays hidden while the retained bodies are on screen.
      expect(screen.queryByTestId('folded-section-select-cover')).not.toBeInTheDocument()
      expect(screen.getByTestId('carried-body')).toBeInTheDocument()
      await settleMotion()
      expect(screen.getByTestId('folded-section-select-cover')).toBeInTheDocument()
      expect(screen.queryByTestId('carried-body')).not.toBeInTheDocument()
      view.unmount()
    })

    it('keeps ONE content container, title row, body region and run host through the whole gesture', async () => {
      const view = render(motionSection(false))
      const content = contentHost()
      const header = screen.getByTestId('folded-section-header')
      const body = screen.getByTestId('folded-section-body')
      const runHost = screen.getByTestId('run-host')

      view.rerender(motionSection(true))
      expect(contentHost()).toBe(content)
      expect(screen.getByTestId('folded-section-header')).toBe(header)
      expect(screen.getByTestId('folded-section-body')).toBe(body)
      expect(screen.getByTestId('run-host')).toBe(runHost)

      await settleMotion()
      expect(contentHost()).toBe(content)
      expect(screen.getByTestId('folded-section-body')).toBe(body)
      expect(screen.getByTestId('run-host')).toBe(runHost)

      view.rerender(motionSection(false))
      expect(contentHost()).toBe(content)
      expect(screen.getByTestId('folded-section-header')).toBe(header)
      expect(screen.getByTestId('folded-section-body')).toBe(body)
      expect(screen.getByTestId('run-host')).toBe(runHost)

      await settleMotion()
      expect(contentHost()).toBe(content)
      expect(screen.getByTestId('folded-section-header')).toBe(header)
      expect(screen.getByTestId('folded-section-body')).toBe(body)
      expect(screen.getByTestId('run-host')).toBe(runHost)
      view.unmount()
    })

    /**
     * The pointer guarantee is structural, not a re-entry workaround: the label
     * the pointer entered is the same node in the same place, and the animated
     * height can only add space BELOW the title row, so the pointer can never
     * fall out of its own hit box while the block opens or closes.
     */
    it('keeps the pointer highlight alive across the motion from a stable hit region', async () => {
      const view = render(motionSection(false))
      const shell = screen.getByTestId('folded-section-collapsed')
      const content = contentHost()
      const label = screen.getByTestId('folded-section-expand-label')

      fireEvent.mouseEnter(label)
      expect(shell).toHaveAttribute('data-fold-region-active', 'true')

      view.rerender(motionSection(true))
      // Same label node, same title row, same container: the pointer is still
      // over the element it entered.
      expect(screen.getByTestId('folded-section-expand-label')).toBe(label)
      expect(screen.getByTestId('folded-section-header')).toContainElement(label)
      expect(contentHost()).toBe(content)
      expect(shell).toHaveAttribute('data-fold-region-active', 'true')
      // The title row is a plain flow child of the animated container and the
      // container carries no summary-height padding, so the motion cannot move
      // the chrome relative to the container's top edge.
      expect(window.getComputedStyle(screen.getByTestId('folded-section-header')).position).not.toBe('absolute')
      expect(window.getComputedStyle(content).paddingTop).toBe('0px')

      await settleMotion()
      expect(shell).toHaveAttribute('data-fold-region-active', 'true')

      // Leaving the label is still the only way to clear the region.
      fireEvent.mouseLeave(label)
      expect(shell).toHaveAttribute('data-fold-region-active', 'false')
      view.unmount()
    })

    it('reverses from the live mid-motion height instead of an endpoint', async () => {
      const view = render(motionSection(false))
      view.rerender(motionSection(true))
      expect(contentHost()).toHaveAttribute('data-browse-phase', 'expanding')

      // The container is mid-motion when the inverse flip arrives. The read
      // lands on the live 120px box — never a snap back to an endpoint — and
      // the new driver writes it synchronously in the arming commit.
      armedHeight = 120
      view.rerender(motionSection(false))
      const content = contentHost()
      expect(content).toHaveAttribute('data-browse-phase', 'collapsing')
      expect(content.style.height).toBe('120px')

      // The superseded opening completion never forces a stale state: flush
      // the old promise without firing any frame and the block still shows
      // the collapsing space, held at the live height.
      await act(async () => {})
      expect(contentHost()).toHaveAttribute('data-browse-phase', 'collapsing')
      expect(contentHost().style.height).toBe('120px')

      // Only the second driver settles, into the collapsed block.
      await settleMotion()
      expect(phasedHost()).toBeNull()
      expect(screen.getByTestId('folded-section-collapsed')).toBeInTheDocument()
      expect(content.style.height).toBe('')
      view.unmount()
    })

    it('never takes an endpoint from the hidden body region', async () => {
      // Production layout: the body region measures 0px in every state.
      const view = render(motionSection(false))
      view.rerender(motionSection(true))
      const content = contentHost()
      expect(screen.getByTestId('folded-section-body').getBoundingClientRect().height).toBe(0)
      // The opening `from` is the container's own collapsed height — never the
      // 0px body box — written synchronously by the driver.
      expect(content.style.height).toBe(`${COLLAPSED_CONTENT_HEIGHT}px`)

      await settleMotion()
      view.rerender(motionSection(false))
      expect(screen.getByTestId('folded-section-body').getBoundingClientRect().height).toBe(0)
      // Same for the closing `from`: the live expanded container, not the body.
      expect(contentHost().style.height).toBe(`${EXPANDED_CONTENT_HEIGHT}px`)

      await settleMotion()
      expect(screen.getByTestId('folded-section-collapsed')).toBeInTheDocument()
      view.unmount()
    })
    it('settles each height write through the layout settler before the frame returns', () => {
      const commands = settleCommands()
      const settleLayout = commands.settleLayout as unknown as ReturnType<typeof vi.fn>
      const view = render(motionSection(false, commands))
      view.rerender(motionSection(true, commands))
      // The arming commit writes the `from` and settles it synchronously: no
      // frame has run yet, but the keeper already absorbed the first write.
      expect(settleLayout).toHaveBeenCalledWith('fold-browse')
      const callsAfterArm = settleLayout.mock.calls.length
      // Each frame settles exactly the layout its own write just produced —
      // the assertion after the call sees the already-settled layout.
      fireFrame(50)
      expect(settleLayout.mock.calls.length).toBeGreaterThan(callsAfterArm)
      expect(settleLayout).toHaveBeenLastCalledWith('fold-browse')
      view.unmount()
    })

    it('settles the final cleanup through the layout settler', async () => {
      const commands = settleCommands()
      const settleLayout = commands.settleLayout as unknown as ReturnType<typeof vi.fn>
      const view = render(motionSection(false, commands))
      view.rerender(motionSection(true, commands))
      const callsAfterArm = settleLayout.mock.calls.length
      expect(callsAfterArm).toBeGreaterThan(0)
      await settleMotion()
      expect(phasedHost()).toBeNull()
      // The inline-height cleanup back to natural settles too: no painted
      // frame shows the cleanup unabsorbed, and nothing lingers inline.
      expect(settleLayout.mock.calls.length).toBeGreaterThan(callsAfterArm)
      expect(contentHost().style.height).toBe('')
      view.unmount()
    })

    it('settles instantly under prefers-reduced-motion with no phase ever painted', () => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query })
      })
      const view = render(motionSection(false))
      view.rerender(motionSection(true))
      expect(phasedHost()).toBeNull()
      expect(screen.getByTestId('folded-section-expanded')).toBeInTheDocument()
      expect(screen.getByTestId('carried-body')).toBeInTheDocument()
      view.unmount()
    })

    it('settles a close in the same commit when no collapsed geometry was ever observed', () => {
      // Mounted already expanded: the block never saw its own collapsed height,
      // so it will not invent one — it closes instantly.
      const view = render(motionSection(true))
      expect(phasedHost()).toBeNull()
      view.rerender(motionSection(false))
      expect(phasedHost()).toBeNull()
      expect(screen.getByTestId('folded-section-collapsed')).toBeInTheDocument()
      expect(screen.queryByTestId('carried-body')).not.toBeInTheDocument()
      view.unmount()
    })

    it('settles instantly when nothing is measurable', () => {
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => rectOf(0)
      })
      const view = render(motionSection(false))
      view.rerender(motionSection(true))
      expect(phasedHost()).toBeNull()
      expect(screen.getByTestId('folded-section-expanded')).toBeInTheDocument()
      view.unmount()
    })
  })

  /**
   * The browse tree is ONE tree. These prove the structure the motion relies on:
   * the title row lives INSIDE the content container (so an animated height can
   * only add space below the chrome), the body region is a single wrapper in
   * every state, and the carried nodes keep their identity across the toggle.
   */
  describe('single content tree', () => {
    const section = (expanded: boolean) => (
      <FoldedSection
        isExpanded={expanded}
        onToggleExpand={vi.fn()}
        turnCount={3}
        groupIds={['u1', 'u2', 'u3']}
        topicId="t1">
        <div data-testid="child-message">Child turn content</div>
      </FoldedSection>
    )

    it('holds the title row and the body region inside the ONE content container', () => {
      const view = render(section(false))
      const shell = screen.getByTestId('folded-section-collapsed')
      const content = screen.getByTestId('folded-section-content')
      const header = screen.getByTestId('folded-section-header')
      const body = screen.getByTestId('folded-section-body')

      // The shell's only flow child is the content container; the rail box is
      // absolute and carries no height.
      expect(shell.lastElementChild).toBe(content)
      expect(content.children).toHaveLength(2)
      // The title row comes FIRST, i.e. the collapsed container height already
      // contains it: no summary band is added or removed beside the animated
      // space.
      expect(content.firstElementChild).toBe(header)
      expect(header.nextElementSibling).toBe(body)
      expect(body).toContainElement(screen.getByTestId('child-message'))
      // Bodies keep their no-fold x: the container adds no transverse inset.
      expect(content).toHaveStyle({ paddingTop: '0px', paddingLeft: '0px', marginLeft: '0px' })
      view.unmount()
    })

    it('keeps the same container, title row, body region and child node across the toggle', () => {
      const view = render(section(false))
      const shell = screen.getByTestId('folded-section-collapsed')
      const content = screen.getByTestId('folded-section-content')
      const header = screen.getByTestId('folded-section-header')
      const body = screen.getByTestId('folded-section-body')
      const child = screen.getByTestId('child-message')

      view.rerender(section(true))
      expect(screen.getByTestId('folded-section-expanded')).toBe(shell)
      expect(screen.getByTestId('folded-section-content')).toBe(content)
      expect(screen.getByTestId('folded-section-header')).toBe(header)
      expect(screen.getByTestId('folded-section-body')).toBe(body)
      expect(screen.getByTestId('child-message')).toBe(child)

      view.rerender(section(false))
      expect(screen.getByTestId('folded-section-collapsed')).toBe(shell)
      expect(screen.getByTestId('folded-section-content')).toBe(content)
      expect(screen.getByTestId('folded-section-header')).toBe(header)
      expect(screen.getByTestId('folded-section-body')).toBe(body)
      expect(screen.getByTestId('child-message')).toBe(child)
      view.unmount()
    })

    it('leaves the settled container and body region at natural height in both states', () => {
      const view = render(section(false))
      expect(screen.getByTestId('folded-section-content')).not.toHaveAttribute('data-browse-motion')
      expect(screen.getByTestId('folded-section-content').getAttribute('style')).toBeNull()
      expect(screen.getByTestId('folded-section-body')).toHaveAttribute('data-browse-view', 'collapsed')

      view.rerender(section(true))
      expect(screen.getByTestId('folded-section-content')).not.toHaveAttribute('data-browse-motion')
      // The dim belongs to the body region, not the title row.
      expect(screen.getByTestId('folded-section-body')).toHaveAttribute('data-browse-view', 'expanded')
      expect(screen.getByTestId('folded-section-body')).toHaveStyle({ opacity: '0.95' })
      expect(screen.getByTestId('folded-section-header')).not.toHaveStyle({ opacity: '0.95' })
      view.unmount()
    })
  })
})
