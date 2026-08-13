/**
 * Focused tests for useContextStartOverride — the ONLY Inputbar persisted
 * context-start override mutation surface.
 *
 * Override semantics: `contextStartOverride[topicId]` holds only a
 * user-specified context start; a derived anchor is never persisted. Mounting
 * (startup) with empty/loading messages never writes an override — there is
 * deliberately no synchronization effect in the Inputbar. The only mutation is
 * reset (TokenCount click), which deletes the override so the existing default
 * computation takes over; the resolved anchor is recomputed by
 * `computeContextInfo`, never stored here.
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
      contextStartOverride: (settings?.contextStartOverride as Record<string, unknown> | undefined) ?? {}
    }
  }
}))

import { useContextStartOverride } from '../useContextStartOverride'

const TOPIC_ID = 'topic-a'
const OTHER_TOPIC_ID = 'topic-b'

function makeAssistant(settings: {
  contextStartOverride?: Record<string, { kind: 'active'; groupKey: string } | undefined>
}) {
  return {
    id: 'assistant-1',
    name: 'Test Assistant',
    settings
  } as any
}

describe('useContextStartOverride', () => {
  it('mounting with empty messages never mutates an override', () => {
    // Startup/loading scenario: the assistant already carries a persisted
    // override and the topic messages are empty/not yet loaded.
    const updateAssistantSettings = vi.fn()
    const assistant = makeAssistant({
      contextStartOverride: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })

    renderHook(() => useContextStartOverride(assistant, TOPIC_ID, updateAssistantSettings))

    // No synchronization effect may create, replace, or delete the override.
    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('reset deletes the override for the topic', () => {
    const updateAssistantSettings = vi.fn()
    const assistant = makeAssistant({
      contextStartOverride: {
        [TOPIC_ID]: { kind: 'active', groupKey: 'u1' },
        [OTHER_TOPIC_ID]: { kind: 'active', groupKey: 'u9' }
      }
    })

    const { result } = renderHook(() => useContextStartOverride(assistant, TOPIC_ID, updateAssistantSettings))
    act(() => {
      result.current.onResetOverride()
    })

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    const payload = updateAssistantSettings.mock.calls[0][0] as {
      contextStartOverride: Record<string, unknown>
    }
    expect(payload.contextStartOverride[TOPIC_ID]).toBeUndefined()
    // Other topics' overrides are untouched.
    expect(payload.contextStartOverride[OTHER_TOPIC_ID]).toEqual({ kind: 'active', groupKey: 'u9' })
  })

  it('reset with no override for the topic is a no-op (no churn)', () => {
    const updateAssistantSettings = vi.fn()
    const assistant = makeAssistant({
      contextStartOverride: { [OTHER_TOPIC_ID]: { kind: 'active', groupKey: 'u9' } }
    })

    const { result } = renderHook(() => useContextStartOverride(assistant, TOPIC_ID, updateAssistantSettings))
    act(() => {
      result.current.onResetOverride()
    })

    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('reset with no override map at all is a no-op (nothing to delete)', () => {
    const updateAssistantSettings = vi.fn()
    const assistant = makeAssistant({})

    const { result } = renderHook(() => useContextStartOverride(assistant, TOPIC_ID, updateAssistantSettings))
    act(() => {
      result.current.onResetOverride()
    })

    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })
})
