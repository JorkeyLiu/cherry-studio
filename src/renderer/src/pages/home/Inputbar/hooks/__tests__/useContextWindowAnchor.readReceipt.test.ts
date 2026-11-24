/**
 * Anchor resolve read receipts (route B witness handoff).
 *
 * The anchor re-anchor path issues its own closure read
 * (`dbService.resolveContextClosure`). On acceptance it must bind that exact
 * response object to the witness captured synchronously before the resolve
 * dispatch, so a later presentation handoff with the bound receipt retires
 * the matching retained terminal — and nothing else.
 */
import { getFreshValidatedClosure, resetAllClosureStateForTests } from '@renderer/services/contextClosure'
import { getClosureReadReceipt } from '@renderer/services/executionOverlayReadReceipt'
import {
  registerExecutionOverlay,
  resetExecutionOverlayForTests,
  routeKeyForExecutionOverlay,
  subscribeExecutionOverlay,
  tryHandoffAfterClosure
} from '@renderer/services/executionOverlayRegistry'
import type { Assistant, AssistantSettings } from '@renderer/types'
import type { ContextWindowAnchor } from '@renderer/types'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useContextWindowAnchor } from '../useContextWindowAnchor'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resolveContextClosure: vi.fn(),
    dispatch: vi.fn(),
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
    dispatch: (...args: unknown[]) => (mocks.dispatch as (...a: unknown[]) => unknown)(...args)
  }
}))

const assistantWith = (settings: Partial<AssistantSettings>): Assistant =>
  ({
    id: 'asst-1',
    settings
  }) as unknown as Assistant

const TOPIC_ID = 'topic-1'

const resolverSuccess = (resolvedAnchorGroupKey: string) => {
  const u = resolvedAnchorGroupKey
  const a = `a-${u}`
  const messages = [
    { id: u, role: 'user', topicId: TOPIC_ID, blocks: [] },
    { id: a, role: 'assistant', topicId: TOPIC_ID, askId: u, blocks: [] }
  ]
  return {
    messages,
    blocks: [],
    closure: {
      completeness: 'context-closure',
      topicId: TOPIC_ID,
      anchorGroupKey: u,
      firstMessageId: u,
      lastMessageId: a,
      returnedCount: messages.length,
      totalTurnCount: 1,
      selectedTurnCount: 1,
      foldedMessageIds: [],
      boundaryMessageId: null
    },
    resolvedAnchorGroupKey: u,
    changed: true
  } as any
}

describe('useContextWindowAnchor read receipt', () => {
  const updateAssistantSettings = vi.fn()

  beforeEach(() => {
    updateAssistantSettings.mockReset()
    mocks.resolveContextClosure.mockReset()
    mocks.dispatch.mockReset()
    mocks.getStateAssistants = []
    resetAllClosureStateForTests()
    resetExecutionOverlayForTests()
  })

  it('binds the accepted resolve response to its read witness; handoff retires the matching terminal', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    const routeKey = routeKeyForExecutionOverlay(TOPIC_ID, null)
    const unsubscribe = subscribeExecutionOverlay(routeKey, () => {})
    try {
      const handle = registerExecutionOverlay({
        topicId: TOPIC_ID,
        route: null,
        messageId: 'a-u2',
        snapshot: () => ({ blocks: [] })
      })
      handle.notifyDelta()
      handle.recordTerminalPersisted('success')
      handle.dispose()

      mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u2'))
      const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
      await result.current.onReanchor()

      const cached = getFreshValidatedClosure(TOPIC_ID, 'u2')
      expect(cached).not.toBeNull()
      // Same synchronous boundary carried the cache publication: the exact
      // cached object carries the read receipt.
      const receipt = getClosureReadReceipt(cached)
      expect(receipt).toBeDefined()
      expect(receipt?.routeKey).toBe(routeKey)
      expect(receipt?.terminals.map((t) => t.messageId)).toContain('a-u2')
      expect(tryHandoffAfterClosure(TOPIC_ID, null, { messages: [{ id: 'u2' }, { id: 'a-u2' }] }, receipt)).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('a resolver failure binds nothing and publishes nothing', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockRejectedValueOnce(new Error('IPC fail'))
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    await result.current.onReanchor()
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(getFreshValidatedClosure(TOPIC_ID, 'u2')).toBeNull()
    expect(getFreshValidatedClosure(TOPIC_ID, 'u1')).toBeNull()
  })
})
