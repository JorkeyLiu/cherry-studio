/**
 * Focused tests for useContextWindowAnchor — the ONLY Inputbar persisted
 * anchor mutation surface: the TokenCount re-anchor interaction.
 *
 * Authority path (resolver): clicking TokenCount resolves
 * `chatdb:resolve-context-closure` (intent `reanchor-default`,
 * `detail: 'closure'`) in Main against full ordered turns. Fail-closed: the
 * new anchor becomes visible only when the complete/valid same-snapshot
 * closure is published in the same synchronous boundary BEFORE the anchor
 * persist, so the shared projection never renders a bounded-fallback
 * transitional count. Anchor-only/invalid/stale/unpublishable responses
 * never persist the new anchor alone (key removed on empty resolver);
 * transport failures preserve settings. No `buildContextTurns`, no
 * loaded-viewport authority decisions.
 */
import { getFreshValidatedClosure, resetAllClosureStateForTests } from '@renderer/services/contextClosure'
import { deriveContextInfoFromClosure } from '@renderer/services/contextInfoService'
import type { Assistant, AssistantSettings } from '@renderer/types'
import type { ContextWindowAnchor } from '@renderer/types'
import { renderHook, waitFor } from '@testing-library/react'
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
const resolverSuccess = (resolvedAnchorGroupKey: string | null) => {
  // Structurally valid single-turn closure (u2/a2) so the fail-closed publish
  // path accepts it; empty resolves to a null-anchor removal payload.
  if (resolvedAnchorGroupKey === null) {
    return {
      messages: [],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: TOPIC_ID,
        anchorGroupKey: null,
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        totalTurnCount: 0,
        selectedTurnCount: 0,
        boundaryMessageId: null
      },
      resolvedAnchorGroupKey: null,
      changed: true
    } as any
  }
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
      boundaryMessageId: null
    },
    resolvedAnchorGroupKey: u,
    changed: true
  } as any
}

describe('useContextWindowAnchor', () => {
  const updateAssistantSettings = vi.fn()

  beforeEach(() => {
    updateAssistantSettings.mockReset()
    mocks.resolveContextClosure.mockReset()
    mocks.dispatch.mockReset()
    mocks.getStateAssistants = []
    resetAllClosureStateForTests()
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
      detail: 'closure'
    })
    await waitFor(() => expect(updateAssistantSettings).toHaveBeenCalledTimes(1))
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      contextWindowAnchor: expect.objectContaining({ [TOPIC_ID]: { kind: 'active', groupKey: 'u2' } })
    })
  })

  it('fail-closed: anchor-only resolver response never persists the new anchor alone', async () => {
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
      detail: 'closure'
    })
    // Fail-closed: no solo anchor persist, so the UI keeps the old
    // authoritative projection instead of a bounded-fallback frame.
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(getFreshValidatedClosure(TOPIC_ID, 'u2')).toBeNull()
    expect(getFreshValidatedClosure(TOPIC_ID, 'u1')).toBeNull()
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

  it('pre-publishes the validated closure atomically: no bounded-fallback transitional count', async () => {
    // Genuine 5-turn topic; the re-anchor target is the 4th turn (u4), so the
    // authoritative counts are current 2 / max 5. A bounded loaded viewport
    // holding only the newest turn would derive 1/1 — the exact transitional
    // error this regression guards against.
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    const authoritative = makeAuthoritativeClosure(TOPIC_ID, 'u4', 5, 2)
    let resolve!: (v: unknown) => void
    mocks.resolveContextClosure.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res
        })
    )
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    const pending = result.current.onReanchor()
    // While the resolver is in flight the new anchor has no closure yet and
    // the persisted anchor is still the old one: no transitional publish.
    expect(getFreshValidatedClosure(TOPIC_ID, 'u4')).toBeNull()
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    resolve(authoritative)
    await pending
    // Anchor and authoritative closure publish in the same tick.
    await waitFor(() => expect(updateAssistantSettings).toHaveBeenCalledTimes(1))
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      contextWindowAnchor: expect.objectContaining({ [TOPIC_ID]: { kind: 'active', groupKey: 'u4' } })
    })
    const fresh = getFreshValidatedClosure(TOPIC_ID, 'u4')
    expect(fresh).not.toBeNull()
    expect(fresh?.closure.selectedTurnCount).toBe(2)
    expect(fresh?.closure.totalTurnCount).toBe(5)
    // The shared projection derives authoritative counts directly — never the
    // bounded 1/1 fallback a truncated viewport would compute.
    const info = deriveContextInfoFromClosure(fresh as any)
    expect(info.contextCount).toEqual({ current: 2, max: 5 })
    expect(info.anchorGroupKey).toBe('u4')
    expect(info.boundaryMessageId).toBe('u4')
  })

  it('fail-closed: invalid closure never persists the new anchor alone', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    const authoritative = makeAuthoritativeClosure(TOPIC_ID, 'u4', 5, 2)
    // Tamper counts so validation fails (selected > total).
    const invalid = {
      ...authoritative,
      closure: { ...authoritative.closure, selectedTurnCount: 9, totalTurnCount: 5 }
    }
    mocks.resolveContextClosure.mockResolvedValueOnce(invalid)
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
    await result.current.onReanchor()
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(getFreshValidatedClosure(TOPIC_ID, 'u4')).toBeNull()
  })

  it('fail-closed: cache publication failure never persists the new anchor alone', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    mocks.getStateAssistants = [assistant]
    const authoritative = makeAuthoritativeClosure(TOPIC_ID, 'u4', 5, 2)
    mocks.resolveContextClosure.mockResolvedValueOnce(authoritative)
    // Force the cache write to throw: with anchor-last ordering the anchor
    // must stay invisible (no solo persist, no dispatched anchor).
    const { setCachedContextClosure } = await import('@renderer/services/contextClosure')
    void setCachedContextClosure
    const cacheModule = await import('@renderer/services/contextClosure')
    const spy = vi.spyOn(cacheModule, 'setCachedContextClosure').mockImplementationOnce(() => {
      throw new Error('cache write failed')
    })
    try {
      const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC_ID, [], updateAssistantSettings))
      await result.current.onReanchor()
      expect(updateAssistantSettings).not.toHaveBeenCalled()
      expect(getFreshValidatedClosure(TOPIC_ID, 'u4')).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('stale closure result publishes neither anchor nor cache', async () => {
    const assistant = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
    })
    const updated = assistantWith({
      contextCount: 2,
      contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u9' } }
    })
    mocks.getStateAssistants = [assistant]
    const authoritative = makeAuthoritativeClosure(TOPIC_ID, 'u4', 5, 2)
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
    resolve(authoritative)
    await p
    expect(updateAssistantSettings).not.toHaveBeenCalled()
    expect(getFreshValidatedClosure(TOPIC_ID, 'u4')).toBeNull()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
})

/**
 * Build a structurally valid resolver closure (detail 'closure') for a
 * synthetic topic: totalTurns turns (u1..uN with assistant replies), anchor
 * at u(totalTurns - selectedTurns + 1), anchor-to-end messages only.
 * The `anchor` param must equal the derived start (tests use u4 with 5/2).
 */
function makeAuthoritativeClosure(topicId: string, anchor: string, totalTurns: number, selectedTurns: number) {
  const anchorIndex = totalTurns - selectedTurns + 1
  const messages: Array<Record<string, unknown>> = []
  for (let i = anchorIndex; i <= totalTurns; i++) {
    const u = `u${i}`
    messages.push({ id: u, role: 'user', topicId, blocks: [] })
    messages.push({ id: `a${i}`, role: 'assistant', topicId, askId: u, blocks: [] })
  }
  const firstMessageId = messages[0]?.id as string
  // Fail fast on helper misuse: the derived anchor must match the request.
  if (firstMessageId !== anchor) {
    throw new Error(`makeAuthoritativeClosure: derived ${firstMessageId} !== expected ${anchor}`)
  }
  const lastMessageId = messages[messages.length - 1]?.id as string
  return {
    messages,
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: firstMessageId,
      firstMessageId,
      lastMessageId,
      returnedCount: messages.length,
      totalTurnCount: totalTurns,
      selectedTurnCount: selectedTurns,
      boundaryMessageId: selectedTurns === totalTurns ? null : firstMessageId
    },
    resolvedAnchorGroupKey: firstMessageId,
    changed: true
  } as any
}
