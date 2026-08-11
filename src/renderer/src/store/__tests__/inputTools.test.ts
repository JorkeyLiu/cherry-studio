import type { InputBarToolType } from '@renderer/types/chat'
import { describe, expect, it } from 'vitest'

import {
  default as inputToolsReducer,
  DEFAULT_TOOL_ORDER,
  selectToolOrder,
  setIsCollapsed,
  setToolOrder
} from '../inputTools'

describe('inputTools slice', () => {
  it('retains the ordinary Chat default tool order (attachment, thinking) and no Session-only tools', () => {
    expect(DEFAULT_TOOL_ORDER.visible).toContain('attachment')
    expect(DEFAULT_TOOL_ORDER.visible).toContain('thinking')
    expect(DEFAULT_TOOL_ORDER.visible).toContain('new_topic')

    // Phantom Agent Session tool types must not appear in the default order.
    for (const phantom of ['create_session', 'slash_commands', 'activity_directory', 'permission_mode']) {
      expect(DEFAULT_TOOL_ORDER.visible).not.toContain(phantom)
      expect(DEFAULT_TOOL_ORDER.hidden).not.toContain(phantom)
    }
  })

  it('does not default or register the retired inputbar tool keys', () => {
    for (const retired of ['clear_topic', 'new_context', 'toggle_expand']) {
      expect(DEFAULT_TOOL_ORDER.visible).not.toContain(retired)
      expect(DEFAULT_TOOL_ORDER.hidden).not.toContain(retired)
    }
  })

  it('starts collapsed with the Chat tool order', () => {
    const state = inputToolsReducer(undefined, { type: '@@INIT' })
    expect(state.isCollapsed).toBe(true)
    expect(state.toolOrder).toEqual(DEFAULT_TOOL_ORDER)
  })

  it('setIsCollapsed toggles the collapse state', () => {
    let state = inputToolsReducer(undefined, { type: '@@INIT' })
    state = inputToolsReducer(state, setIsCollapsed(false))
    expect(state.isCollapsed).toBe(false)
    state = inputToolsReducer(state, setIsCollapsed(true))
    expect(state.isCollapsed).toBe(true)
  })

  it('setToolOrder replaces the tool order', () => {
    let state = inputToolsReducer(undefined, { type: '@@INIT' })
    const next = {
      visible: ['new_topic', 'attachment'] as InputBarToolType[],
      hidden: [] as InputBarToolType[]
    }
    state = inputToolsReducer(state, setToolOrder({ toolOrder: next }))
    expect(state.toolOrder).toEqual(next)
    // isCollapsed is untouched by tool order changes
    expect(state.isCollapsed).toBe(true)
  })

  it('selectToolOrder returns the Chat tool order', () => {
    const state = inputToolsReducer(undefined, { type: '@@INIT' })
    expect(selectToolOrder({ inputTools: state })).toEqual(DEFAULT_TOOL_ORDER)
  })
})
