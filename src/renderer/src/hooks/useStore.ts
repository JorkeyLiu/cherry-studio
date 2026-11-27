/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  setWorkspaceSidebarCollapsed,
  setWorkspaceSidebarVisible,
  setWorkspaceSidebarWidth,
  toggleWorkspaceSidebarCollapsed,
  toggleWorkspaceSidebarVisible
} from '@renderer/store/settings'

/**
 * Unified workspace sidebar state (the single left panel replacing the
 * former assistants + topics dual panels). Visibility is the single runtime
 * truth; `collapsed` and its setters are deprecated inert persist-compat
 * (no production reader).
 */
export function useWorkspaceSidebar() {
  const visible = useAppSelector((state) => state.settings.workspaceSidebarVisible)
  /** @deprecated collapse is fully hidden; inert persist-compat. */
  const collapsed = useAppSelector((state) => state.settings.workspaceSidebarCollapsed)
  const width = useAppSelector((state) => state.settings.workspaceSidebarWidth)
  const dispatch = useAppDispatch()

  return {
    visible,
    /** @deprecated collapse is fully hidden; inert persist-compat. */
    collapsed,
    width,
    setVisible: (show: boolean) => dispatch(setWorkspaceSidebarVisible(show)),
    toggleVisible: () => dispatch(toggleWorkspaceSidebarVisible()),
    /** @deprecated collapse is fully hidden; inert persist-compat. */
    setCollapsed: (collapse: boolean) => dispatch(setWorkspaceSidebarCollapsed(collapse)),
    /** @deprecated collapse is fully hidden; inert persist-compat. */
    toggleCollapsed: () => dispatch(toggleWorkspaceSidebarCollapsed()),
    setWidth: (nextWidth: number) => dispatch(setWorkspaceSidebarWidth(nextWidth))
  }
}

/**
 * @deprecated legacy alias: the dual panels are unified into the workspace
 * sidebar. Maps onto the unified visibility so existing callers keep working.
 */
export function useShowAssistants() {
  const { visible, setVisible, toggleVisible } = useWorkspaceSidebar()

  return {
    showAssistants: visible,
    setShowAssistants: setVisible,
    toggleShowAssistants: toggleVisible
  }
}

/**
 * @deprecated legacy alias: the dual panels are unified into the workspace
 * sidebar. Maps onto the unified visibility so existing callers keep working.
 */
export function useShowTopics() {
  const { visible, setVisible, toggleVisible } = useWorkspaceSidebar()

  return {
    showTopics: visible,
    setShowTopics: setVisible,
    toggleShowTopics: toggleVisible
  }
}

export function getStoreProviders() {
  return store.getState().llm.providers
}
