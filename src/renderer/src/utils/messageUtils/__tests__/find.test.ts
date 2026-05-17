import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { ERROR_I18N_KEY_STREAM_PAUSED } from '@renderer/types/error'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createBaseMessageBlock,
  createErrorBlock,
  createMainTextBlock,
  createMessage,
  createThinkingBlock
} from '../create'
import { isAssistantInterruptedThinkingOnlyMessage } from '../find'

const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: any) => mockStore.dispatch(action)
  }
}))

describe('Message Find Utils', () => {
  beforeEach(() => {
    mockStore = createMockStore()
  })

  describe('isAssistantInterruptedThinkingOnlyMessage', () => {
    it('matches paused assistant messages that only contain thinking blocks', () => {
      const messageId = 'assistant-paused-thinking'
      const thinkingBlock = createThinkingBlock(messageId, 'reasoning', { status: MessageBlockStatus.PAUSED })
      const message = {
        ...createMessage('assistant', 'topic-1', 'assistant-1', {
          id: messageId,
          blocks: [thinkingBlock.id]
        }),
        status: AssistantMessageStatus.PAUSED
      }

      mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(thinkingBlock))

      expect(isAssistantInterruptedThinkingOnlyMessage(message)).toBe(true)
    })

    it('matches manually interrupted thinking messages completed with a paused error block', () => {
      const messageId = 'assistant-success-thinking-paused-error'
      const thinkingBlock = createThinkingBlock(messageId, 'reasoning', { status: MessageBlockStatus.PAUSED })
      const errorBlock = createErrorBlock(
        messageId,
        { name: 'AbortError', message: 'aborted', stack: '', i18nKey: ERROR_I18N_KEY_STREAM_PAUSED },
        { status: MessageBlockStatus.SUCCESS }
      )
      const message = {
        ...createMessage('assistant', 'topic-1', 'assistant-1', {
          id: messageId,
          blocks: [thinkingBlock.id, errorBlock.id]
        }),
        status: AssistantMessageStatus.SUCCESS
      }

      mockStore.dispatch(messageBlocksSlice.actions.upsertManyBlocks([thinkingBlock, errorBlock]))

      expect(isAssistantInterruptedThinkingOnlyMessage(message)).toBe(true)
    })

    it('does not match assistant messages that already have a main text block', () => {
      const messageId = 'assistant-with-text'
      const textBlock = createMainTextBlock(messageId, '', { status: MessageBlockStatus.SUCCESS })
      const message = {
        ...createMessage('assistant', 'topic-1', 'assistant-1', {
          id: messageId,
          blocks: [textBlock.id]
        }),
        status: AssistantMessageStatus.PAUSED
      }

      mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(textBlock))

      expect(isAssistantInterruptedThinkingOnlyMessage(message)).toBe(false)
    })

    it('does not match paused tool-only assistant messages', () => {
      const messageId = 'assistant-tool-only'
      const toolBlock = {
        ...createBaseMessageBlock(messageId, MessageBlockType.TOOL, { status: MessageBlockStatus.SUCCESS }),
        toolId: 'tool-1'
      }
      const message = {
        ...createMessage('assistant', 'topic-1', 'assistant-1', {
          id: messageId,
          blocks: [toolBlock.id]
        }),
        status: AssistantMessageStatus.PAUSED
      }

      mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(toolBlock))

      expect(isAssistantInterruptedThinkingOnlyMessage(message)).toBe(false)
    })

    it('does not match interrupted messages that include tool blocks', () => {
      const messageId = 'assistant-thinking-tool-paused-error'
      const thinkingBlock = createThinkingBlock(messageId, 'reasoning', { status: MessageBlockStatus.PAUSED })
      const toolBlock = {
        ...createBaseMessageBlock(messageId, MessageBlockType.TOOL, { status: MessageBlockStatus.SUCCESS }),
        toolId: 'tool-1'
      }
      const errorBlock = createErrorBlock(
        messageId,
        { name: 'AbortError', message: 'aborted', stack: '', i18nKey: ERROR_I18N_KEY_STREAM_PAUSED },
        { status: MessageBlockStatus.SUCCESS }
      )
      const message = {
        ...createMessage('assistant', 'topic-1', 'assistant-1', {
          id: messageId,
          blocks: [thinkingBlock.id, toolBlock.id, errorBlock.id]
        }),
        status: AssistantMessageStatus.SUCCESS
      }

      mockStore.dispatch(messageBlocksSlice.actions.upsertManyBlocks([thinkingBlock, toolBlock, errorBlock]))

      expect(isAssistantInterruptedThinkingOnlyMessage(message)).toBe(false)
    })
  })
})
