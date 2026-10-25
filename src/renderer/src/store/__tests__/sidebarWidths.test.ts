/**
 * Home sidebar minimum width (renderer): both sidebars share one canonical
 * 220px floor (SIDEBAR_MIN_WIDTH). Narrower saved widths heal up, larger
 * saved widths and the shared default/max are preserved.
 */
import { describe, expect, it } from 'vitest'

import settingsReducer, {
  initialState,
  normalizeSidebarWidth,
  setAssistantsWidth,
  setTopicListWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
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

  it('clamps resize dispatches through both reducers', () => {
    expect(settingsReducer(initialState, setTopicListWidth(180)).topicListWidth).toBe(220)
    expect(settingsReducer(initialState, setTopicListWidth(350)).topicListWidth).toBe(350)
    expect(settingsReducer(initialState, setAssistantsWidth(150)).assistantsWidth).toBe(220)
    expect(settingsReducer(initialState, setAssistantsWidth(350)).assistantsWidth).toBe(350)
  })
})
