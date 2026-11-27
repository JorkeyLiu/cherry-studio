/**
 * Home sidebar minimum width (renderer): both sidebars share one canonical
 * 220px floor (SIDEBAR_MIN_WIDTH). Narrower saved widths heal up, larger
 * saved widths and the shared default/max are preserved.
 */
import { describe, expect, it } from 'vitest'

import settingsReducer, {
  initialState,
  normalizeSidebarWidth,
  normalizeWorkspaceSidebarWidth,
  resolveWorkspaceSidebarFromLegacy,
  setAssistantsWidth,
  setTopicListWidth,
  setWorkspaceSidebarCollapsed,
  setWorkspaceSidebarVisible,
  setWorkspaceSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  toggleWorkspaceSidebarCollapsed,
  toggleWorkspaceSidebarVisible,
  WORKSPACE_SIDEBAR_DEFAULT_WIDTH,
  WORKSPACE_SIDEBAR_RAIL_WIDTH
} from '../settings'

describe('sidebar width bounds', () => {
  it('pins the unified minimum to 220px', () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(220)
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(275)
    expect(SIDEBAR_MAX_WIDTH).toBe(600)
  })

  it('heals narrower saved widths up to the minimum (incl. old left values)', () => {
    expect(normalizeSidebarWidth(150)).toBe(220)
    expect(normalizeSidebarWidth(180)).toBe(220)
    expect(normalizeSidebarWidth(210)).toBe(220)
    expect(normalizeSidebarWidth(0)).toBe(220)
  })

  it('preserves larger widths and the shared maximum', () => {
    expect(normalizeSidebarWidth(275)).toBe(275)
    expect(normalizeSidebarWidth(350)).toBe(350)
    expect(normalizeSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('falls back to the default for non-numeric saved widths', () => {
    expect(normalizeSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(normalizeSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('unifies new installs on the workspace defaults (rail width is deprecated persist-compat only)', () => {
    expect(WORKSPACE_SIDEBAR_DEFAULT_WIDTH).toBe(300)
    // Deprecated inert export kept for persist compatibility: the narrow
    // rail is removed (collapse fully hides), no production rail branch
    // may read it. Value intentionally unasserted as a layout contract.
    expect(WORKSPACE_SIDEBAR_RAIL_WIDTH).toBe(64)
    expect(initialState.workspaceSidebarVisible).toBe(true)
    expect(initialState.workspaceSidebarCollapsed).toBe(false)
    expect(initialState.workspaceSidebarWidth).toBe(300)
  })

  it('normalizes the unified width with the shared 220–600 clamp', () => {
    expect(normalizeWorkspaceSidebarWidth(150)).toBe(220)
    expect(normalizeWorkspaceSidebarWidth(300)).toBe(300)
    expect(normalizeWorkspaceSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH)
    expect(normalizeWorkspaceSidebarWidth(undefined)).toBe(WORKSPACE_SIDEBAR_DEFAULT_WIDTH)
    expect(normalizeWorkspaceSidebarWidth(Number.NaN)).toBe(WORKSPACE_SIDEBAR_DEFAULT_WIDTH)
  })

  it('clamps workspace resize dispatches; visibility toggles, collapse reducers stay inert', () => {
    expect(settingsReducer(initialState, setWorkspaceSidebarWidth(180)).workspaceSidebarWidth).toBe(220)
    expect(settingsReducer(initialState, setWorkspaceSidebarWidth(350)).workspaceSidebarWidth).toBe(350)
    expect(settingsReducer(initialState, setWorkspaceSidebarVisible(false)).workspaceSidebarVisible).toBe(false)
    expect(settingsReducer(initialState, toggleWorkspaceSidebarVisible()).workspaceSidebarVisible).toBe(false)
    // Deprecated inert: reducers persist the field for compatibility but no
    // production branch reads it (visibility is the single runtime truth).
    expect(settingsReducer(initialState, setWorkspaceSidebarCollapsed(true)).workspaceSidebarCollapsed).toBe(true)
    expect(settingsReducer(initialState, toggleWorkspaceSidebarCollapsed()).workspaceSidebarCollapsed).toBe(true)
  })

  it('maps legacy persisted fields onto the unified workspace state', () => {
    expect(resolveWorkspaceSidebarFromLegacy({ showAssistants: false })).toEqual({
      visible: false,
      width: 300
    })
    expect(resolveWorkspaceSidebarFromLegacy({ showTopics: false, assistantsWidth: 350 })).toEqual({
      visible: false,
      width: 350
    })
    expect(resolveWorkspaceSidebarFromLegacy({ topicListWidth: 180 }).width).toBe(220)
    expect(resolveWorkspaceSidebarFromLegacy({})).toEqual({ visible: true, width: 300 })
  })

  it('clamps resize dispatches through both reducers', () => {
    expect(settingsReducer(initialState, setTopicListWidth(180)).topicListWidth).toBe(220)
    expect(settingsReducer(initialState, setTopicListWidth(350)).topicListWidth).toBe(350)
    expect(settingsReducer(initialState, setAssistantsWidth(150)).assistantsWidth).toBe(220)
    expect(settingsReducer(initialState, setAssistantsWidth(350)).assistantsWidth).toBe(350)
  })
})
