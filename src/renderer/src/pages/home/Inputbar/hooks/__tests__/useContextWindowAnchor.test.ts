/**
 * Focused tests for useContextWindowAnchor — the ONLY Inputbar context-window
 * anchor mutation surface.
 *
 * Explicit-anchor semantics: `contextWindowAnchor[topicId]` holds only a
 * user-specified context start; a derived default is never persisted.
 * Mounting (startup) with empty/loading messages never writes an anchor —
 * there is deliberately no synchronization effect in the Inputbar. The only
 * mutation is reset (TokenCount click), which deletes the explicit anchor so
 * the existing default computation takes over.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Mock AssistantService: the real module pulls importProjection → the Redux
// store at module init (getDefaultAssistant → i18n), which breaks renderHook
// module evaluation. getAssistantSettings is pure; mock the minimum surface.
vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: { settings?: Record<string, unknown> } | undefined) => {
    const settings = assistant?.settings
    return {
      contextCount: typeof settings?.contextCount === 'number' ? settings.contextCount : 25,
      contextWindowAnchor: (settings?.contextWindowAnchor as Record<string, unknown> | undefined) ?? {}
    }
  }
}))

import { useContextWindowAnchor } from '../useContextWindowAnchor'

const TOPIC_ID = 'topic-a'
const OTHER_TOPIC_ID = 'topic-b'

function makeAssistant(settings: {
  contextWindowAnchor?: Record<string, { kind: 'active'; groupKey: string } | undefined>
}) {
  return {
    id: 'assistant-1',
    name: 'Test Assistant',
    settings
  } as any
}

describe('useContextWindowAnchor', () => {
  it('mounting with empty messages never mutates an explicit anchor', () => {
    // Startup/loading scenario: the assistant already carries a persisted
    // explicit anchor and the topic messages are empty/not yet loaded.
    const updateAssistantSettings = vi.fn()
    const assistant = makeAssistant({
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })

    renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, updateAssistantSettings))

    // No synchronization effect may create, replace, or delete the anchor.
    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('reset deletes the explicit anchor for the topic', () => {
    const updateAssistantSettings = vi.fn()
    const assistant = makeAssistant({
      contextWindowAnchor: {
        [TOPIC_ID]: { kind: 'active', groupKey: 'u1' },
        [OTHER_TOPIC_ID]: { kind: 'active', groupKey: 'u9' }
      }
    })

    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, updateAssistantSettings))
    act(() => {
      result.current.onResetAnchor()
    })

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    const payload = updateAssistantSettings.mock.calls[0][0] as { contextWindowAnchor: Record<string, unknown> }
    expect(payload.contextWindowAnchor[TOPIC_ID]).toBeUndefined()
    // Other topics' explicit anchors are untouched.
    expect(payload.contextWindowAnchor[OTHER_TOPIC_ID]).toEqual({ kind: 'active', groupKey: 'u9' })
  })

  it('reset with no explicit anchor for the topic is a no-op (no churn)', () => {
    const updateAssistantSettings = vi.fn()
    const assistant = makeAssistant({
      contextWindowAnchor: { [OTHER_TOPIC_ID]: { kind: 'active', groupKey: 'u9' } }
    })

    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, updateAssistantSettings))
    act(() => {
      result.current.onResetAnchor()
    })

    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('reset with no anchor map at all is a no-op (nothing to delete)', () => {
    const updateAssistantSettings = vi.fn()
    const assistant = makeAssistant({})

    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, updateAssistantSettings))
    act(() => {
      result.current.onResetAnchor()
    })

    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })
})
