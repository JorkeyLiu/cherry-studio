import type { Assistant } from '@renderer/types'
import { cloneDeep } from 'lodash'
import { describe, expect, it } from 'vitest'

import { isPromptToolUse, isSupportedToolUse, isToolUseModeFunction } from '../assistant'

describe('assistant', () => {
  const assistant: Assistant = {
    id: 'assistant',
    name: 'assistant',
    prompt: '',
    topics: [],
    type: ''
  }

  describe('isToolUseModeFunction', () => {
    it('should detect function tool use mode', () => {
      const mockAssistant = cloneDeep(assistant)
      mockAssistant.settings = { toolUseMode: 'function' }
      expect(isToolUseModeFunction(mockAssistant)).toBe(true)
    })

    it('should detect non-function tool use mode', () => {
      const mockAssistant = cloneDeep(assistant)
      mockAssistant.settings = { toolUseMode: 'prompt' }
      expect(isToolUseModeFunction(mockAssistant)).toBe(false)
    })

    it('should handle undefined settings', () => {
      const mockAssistant = cloneDeep(assistant)
      expect(isToolUseModeFunction(mockAssistant)).toBe(false)
    })

    it('should handle undefined toolUseMode', () => {
      const mockAssistant = cloneDeep(assistant)
      mockAssistant.settings = {}
      expect(isToolUseModeFunction(mockAssistant)).toBe(false)
    })
  })

  describe('isSupportedToolUse (Unit B: user intent only, no model metadata veto)', () => {
    it('enables native tools for function mode regardless of model id', () => {
      const mockAssistant = cloneDeep(assistant)
      mockAssistant.settings = { toolUseMode: 'function' }
      mockAssistant.model = { id: 'plain-chat-model', name: 'Plain', provider: 'custom' } as any
      expect(isSupportedToolUse(mockAssistant)).toBe(true)
    })

    it('disables native tools for prompt mode', () => {
      const mockAssistant = cloneDeep(assistant)
      mockAssistant.settings = { toolUseMode: 'prompt' }
      mockAssistant.model = { id: 'gpt-4o', name: 'GPT', provider: 'openai' } as any
      expect(isSupportedToolUse(mockAssistant)).toBe(false)
    })

    it('keeps prompt mode strictly user-selected', () => {
      const mockAssistant = cloneDeep(assistant)
      mockAssistant.settings = { toolUseMode: 'function' }
      expect(isPromptToolUse(mockAssistant)).toBe(false)
      mockAssistant.settings = { toolUseMode: 'prompt' }
      expect(isPromptToolUse(mockAssistant)).toBe(true)
    })
  })
})
