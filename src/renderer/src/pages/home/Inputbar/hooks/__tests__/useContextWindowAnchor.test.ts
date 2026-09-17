/**
 * Focused tests for useContextWindowAnchor — the ONLY Inputbar persisted
 * anchor mutation surface: the TokenCount re-anchor interaction.
 *
 * Authority path (resolver): clicking TokenCount resolves
 * `chatdb:resolve-context-closure` (intent `reanchor-default`) in Main against
 * full ordered turns. No `buildContextTurns`, no loaded-viewport authority
 * decisions. Only the non-stale returned anchor is persisted (key removed on
 * empty); transport failures preserve settings.
 */
import type { Assistant, AssistantSettings } from '@renderer/types'
import type { ContextWindowAnchor } from '@renderer/types'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useContextWindowAnchor } from '../useContextWindowAnchor'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resolveContextClosure: vi.fn(),
    getStateAssistants: [] as Assistant[]
  }
}))

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

vi.mock('@renderer/services/db', () => ({
  dbService: {
    resolveContextClosure: (...args: unknown[]) => mocks.resolveContextClosure(...args)
  }
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    resolveContextClosure: (...args: unknown[]) => mocks.resolveContextClosure(...args)
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({ assistants: { assistants: mocks.getStateAssistants } }),
    dispatch: vi.fn()
  }
}))

const assistantWith = (settings: Partial<AssistantSettings>): Assistant =>
  ({
    id: 'asst-1',
    settings
  }) as unknown as Assistant

const TOPIC_ID = 'topic-1'
const resolverSuccess = (resolvedAnchorGroupKey: string | null) =>
  ({
    messages: [],
    blocks: [],
    closure: {
      completeness: 'context-closure',
      topicId: TOPIC_ID,
      anchorGroupKey: resolvedAnchorGroupKey,
      firstMessageId: resolvedAnchorGroupKey ? 'm1' : null,
      lastMessageId: resolvedAnchorGroupKey ? 'm1' : null,
      returnedCount: resolvedAnchorGroupKey ? 1 : 0,
      totalTurnCount: resolvedAnchorGroupKey ? 1 : 0,
      selectedTurnCount: resolvedAnchorGroupKey ? 1 : 0,
      boundaryMessageId: null
    },
    resolvedAnchorGroupKey,
    changed: true
  }) as any

describe('useContextWindowAnchor', () => {
  const updateAssistantSettings = vi.fn()

  beforeEach(() => {
    updateAssistantSettings.mockReset()
    mocks.resolveContextClosure.mockReset()
    mocks.getStateAssistants = []
  })

  it('re-anchors via the authority resolver and persists the returned anchor', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u2'))
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    await result.current.onReanchor()
    expect(mocks.resolveContextClosure).toHaveBeenCalledWith({
      topicId: TOPIC_ID,
      intent: 'reanchor-default',
      contextCount: 2,
      currentAnchorGroupKey: 'u1',
      detail: 'anchor'
    })
    await waitFor(() => expect(updateAssistantSettings).toHaveBeenCalledTimes(1))
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      contextWindowAnchor: expect.objectContaining({ [TOPIC_ID]: { kind: 'active', groupKey: 'u2' } })
    })
  })

  it('persists a metadata-only anchor response with no messages/blocks/closure', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce({ resolvedAnchorGroupKey: 'u2', changed: true } as any)
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    await result.current.onReanchor()
    expect(mocks.resolveContextClosure).toHaveBeenCalledWith({
      topicId: TOPIC_ID,
      intent: 'reanchor-default',
      contextCount: 2,
      currentAnchorGroupKey: 'u1',
      detail: 'anchor'
    })
    await waitFor(() => expect(updateAssistantSettings).toHaveBeenCalledTimes(1))
  })

  it('does not dispatch when the resolver echoes the current anchor', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u2' } }
    })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u2'))
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    await result.current.onReanchor()
    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('removes the key when the resolver reports empty', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess(null))
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    await result.current.onReanchor()
    await waitFor(() => expect(updateAssistantSettings).toHaveBeenCalledTimes(1))
    const arg = updateAssistantSettings.mock.calls[0][0] as {
      contextWindowAnchor: Record<string, unknown>
    }
    expect(arg.contextWindowAnchor[TOPIC_ID]).toBeUndefined()
  })

  it('transport failure preserves settings', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockRejectedValueOnce(new Error('IPC fail'))
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    await result.current.onReanchor()
    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('stale result after concurrent change does not overwrite', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    const updated = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u9' } }
    })
    mocks.getStateAssistants = [assistant]
    let resolve!: (v: unknown) => void
    mocks.resolveContextClosure.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res
        })
    )
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    const p = result.current.onReanchor()
    mocks.getStateAssistants = [updated]
    resolve(resolverSuccess('u2'))
    await p
    expect(updateAssistantSettings).not.toHaveBeenCalled()
  })
})
