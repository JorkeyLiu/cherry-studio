/**
 * Focused tests for useContextWindowAnchor — the ONLY Inputbar persisted
 * anchor mutation surface: the TokenCount re-anchor interaction.
 *
 * Semantics (docs/context-window.md §7):
 *   - Clicking TokenCount re-anchors the topic to the CURRENT default window
 *     position derived from the current topic turns + the current
 *     `contextCount`, and persists it as `contextWindowAnchor[topicId]`.
 *   - The interaction never leaves a non-empty initialized topic anchorless;
 *     an empty topic is a no-op (no dispatch).
 *   - Changing `contextCount` alone never moves an existing anchor — only the
 *     explicit click re-anchors.
 */
import type { ContextWindowAnchor } from '@renderer/types'
import type { Assistant, AssistantSettings } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useContextWindowAnchor } from '../useContextWindowAnchor'

// ── Mocks (hoisted) ────────────────────────────────────────────────────────

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: {
    settings?: {
      contextCount?: number | null
      contextWindowAnchor?: Record<string, ContextWindowAnchor>
    }
  }) => ({
    contextCount: assistant.settings?.contextCount === undefined ? 25 : assistant.settings.contextCount,
    contextWindowAnchor: assistant.settings?.contextWindowAnchor ?? {}
  }),
  DEFAULT_ASSISTANT_SETTINGS: { contextCount: 25, contextWindowAnchor: {} }
}))

// ── Fixtures ───────────────────────────────────────────────────────────────

const user = (id: string): Message => ({ id, role: 'user', topicId: 'topic-1' }) as unknown as Message

const assistantWith = (settings: Partial<AssistantSettings>): Assistant =>
  ({
    id: 'asst-1',
    settings
  }) as unknown as Assistant

const TOPIC_ID = 'topic-1'

describe('useContextWindowAnchor', () => {
  const updateAssistantSettings = vi.fn()

  beforeEach(() => {
    updateAssistantSettings.mockReset()
  })

  it('re-anchors to the current default window position and persists it', () => {
    // Turns u1/u2/u3 with contextCount=2 → default position is u2.
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    const topicMessages = [user('u1'), user('u2'), user('u3')]
    const { result } = renderHook(() =>
      useContextWindowAnchor(assistant, TOPIC_ID, topicMessages, updateAssistantSettings)
    )

    result.current.onReanchor()

    expect(updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u2' } }
    })
  })

  it('re-anchoring with null contextCount moves to the first turn (whole topic)', () => {
    const assistant = assistantWith({
      contextCount: null,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u3' } }
    })
    const topicMessages = [user('u1'), user('u2'), user('u3')]
    const { result } = renderHook(() =>
      useContextWindowAnchor(assistant, TOPIC_ID, topicMessages, updateAssistantSettings)
    )

    result.current.onReanchor()

    expect(updateAssistantSettings).toHaveBeenCalledWith({
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
  })

  it('does not dispatch when the anchor already sits at the default position', () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u2' } }
    })
    const topicMessages = [user('u1'), user('u2'), user('u3')]
    const { result } = renderHook(() =>
      useContextWindowAnchor(assistant, TOPIC_ID, topicMessages, updateAssistantSettings)
    )

    result.current.onReanchor()

    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('empty topic is a no-op (never creates an anchor)', () => {
    const assistant = assistantWith({ contextCount: 2, contextWindowAnchor: {} })
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))

    result.current.onReanchor()

    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('establishes an anchor from nothing on a non-empty topic', () => {
    const assistant = assistantWith({ contextCount: 1, contextWindowAnchor: {} })
    const topicMessages = [user('u1'), user('u2'), user('u3')]
    const { result } = renderHook(() =>
      useContextWindowAnchor(assistant, TOPIC_ID, topicMessages, updateAssistantSettings)
    )

    result.current.onReanchor()

    expect(updateAssistantSettings).toHaveBeenCalledWith({
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u3' } }
    })
  })
})
