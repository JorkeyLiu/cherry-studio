import type { Assistant } from '@renderer/types'

import type { BlockManager } from '../BlockManager'
import type { AssistantExecutionState } from '../executionState'
import { createBaseCallbacks } from './baseCallbacks'
import { createCitationCallbacks } from './citationCallbacks'
import { createImageCallbacks } from './imageCallbacks'
import { createTextCallbacks } from './textCallbacks'
import { createThinkingCallbacks } from './thinkingCallbacks'
import { createToolCallbacks } from './toolCallbacks'
import { createVideoCallbacks } from './videoCallbacks'

interface CallbacksDependencies {
  blockManager: BlockManager
  dispatch: any
  getState: any
  topicId: string
  assistantMsgId: string
  executionState?: AssistantExecutionState
  saveUpdatesToDB: any
  /**
   * Single-transaction final checkpoint for onComplete (Fix B): persists the
   * message final patch together with all final blocks via
   * `updateMessageAndBlocks`. Fail-loud (rejects on DB failure). Bound to the
   * execution's resend attempt by the caller; ordinary executions omit the
   * carrier inside the closure.
   */
  saveFinalUpdatesAtomically: (
    messageId: string,
    topicId: string,
    messageUpdates: any,
    blocksToUpdate: any[]
  ) => Promise<unknown>
  assistant: Assistant
}

export const createCallbacks = (deps: CallbacksDependencies) => {
  const {
    blockManager,
    dispatch,
    getState,
    topicId,
    assistantMsgId,
    saveUpdatesToDB,
    saveFinalUpdatesAtomically,
    assistant
  } = deps
  // Request-local execution state threads through every generation. When the
  // caller omits it (legacy/test harnesses), fall back to the BlockManager's
  // own state so no path returns to Redux-only.
  const executionState = deps.executionState ?? blockManager.executionState

  // 首先创建 thinkingCallbacks ，以便传递 getCurrentThinkingInfo 给 baseCallbacks
  const thinkingCallbacks = createThinkingCallbacks({
    blockManager,
    assistantMsgId
  })

  // 创建基础回调
  const baseCallbacks = createBaseCallbacks({
    blockManager,
    dispatch,
    getState,
    topicId,
    assistantMsgId,
    saveUpdatesToDB,
    saveFinalUpdatesAtomically,
    assistant,
    executionState,
    getCurrentThinkingInfo: thinkingCallbacks.getCurrentThinkingInfo
  })

  const toolCallbacks = createToolCallbacks({
    blockManager,
    assistantMsgId,
    dispatch,
    getState,
    executionState
  })

  const imageCallbacks = createImageCallbacks({
    blockManager,
    assistantMsgId
  })

  const citationCallbacks = createCitationCallbacks({
    blockManager,
    assistantMsgId,
    getState,
    executionState
  })

  const videoCallbacks = createVideoCallbacks({ blockManager, assistantMsgId })

  // 创建textCallbacks时传入citationCallbacks的getCitationBlockId方法
  const textCallbacks = createTextCallbacks({
    blockManager,
    getState,
    assistantMsgId,
    executionState,
    getCitationBlockId: citationCallbacks.getCitationBlockId,
    getCitationBlockIdFromTool: toolCallbacks.getCitationBlockId
  })

  // 组合所有回调
  return {
    ...baseCallbacks,
    ...textCallbacks,
    ...thinkingCallbacks,
    ...toolCallbacks,
    ...imageCallbacks,
    ...citationCallbacks,
    ...videoCallbacks,
    // 清理资源的方法
    cleanup: () => {
      // 清理由 messageThunk 中的节流函数管理，这里不需要特别处理
      // 如果需要，可以调用 blockManager 的相关清理方法
    }
  }
}
