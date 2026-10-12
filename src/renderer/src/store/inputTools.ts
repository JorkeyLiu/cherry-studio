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
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { InputBarToolType } from '@renderer/types/chat'

type ToolOrder = {
  visible: InputBarToolType[]
  hidden: InputBarToolType[]
}

export const DEFAULT_TOOL_ORDER: ToolOrder = {
  visible: ['new_topic', 'attachment', 'thinking', 'url_context', 'knowledge_base', 'generate_image', 'mention_models'],
  hidden: []
}

type InputToolsState = {
  toolOrder: ToolOrder
  isCollapsed: boolean
}

const initialState: InputToolsState = {
  toolOrder: DEFAULT_TOOL_ORDER,
  isCollapsed: true
}

const inputToolsSlice = createSlice({
  name: 'inputTools',
  initialState,
  reducers: {
    setToolOrder: (state, action: PayloadAction<{ toolOrder: ToolOrder }>) => {
      state.toolOrder = action.payload.toolOrder
    },
    setIsCollapsed: (state, action: PayloadAction<boolean>) => {
      state.isCollapsed = action.payload
    }
  }
})

export const { setToolOrder, setIsCollapsed } = inputToolsSlice.actions

// Selector to get tool order for the (single) ordinary Chat scope.
// Legacy persisted orders may still contain removed keys
// ('web_search', 'mcp_tools'); they are stripped here so old profiles never
// reintroduce removed backend capabilities via UI ordering.
export const selectToolOrder = (state: { inputTools: InputToolsState }): ToolOrder => {
  const stripLegacy = (list: InputBarToolType[]): InputBarToolType[] =>
    list.filter((t) => t !== ('web_search' as InputBarToolType) && t !== ('mcp_tools' as InputBarToolType))
  const toolOrder = state.inputTools.toolOrder
  if (!toolOrder) return DEFAULT_TOOL_ORDER
  return {
    visible: stripLegacy(toolOrder.visible ?? []),
    hidden: stripLegacy(toolOrder.hidden ?? [])
  }
}

export default inputToolsSlice.reducer
