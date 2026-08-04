/**
 * Renderer L2 navigation projection apply tests (LOCK-PROD-4/5/6).
 */
import type { ImportNavigationProjection } from '@shared/chatImport/types'
import { RECOVERED_SHELL_ASSISTANT_ID } from '@shared/chatImport/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyPendingImportProjection,
  buildImportedAssistants,
  buildRecoveredAssistant,
  projectionTopicToTopic
} from '../importProjection'

// The module graph reaches `@renderer/store` transitively (AssistantService
// imports it at module scope but only uses it inside functions). Mocking the
// store keeps these pure/apply tests hermetic: no real store evaluation, no
// redux-persist rehydrate side effects. The apply tests inject their own
// dispatch/flush via `applyPendingImportProjection`'s deps.
vi.mock('@renderer/store', () => ({
  default: {
    getState: vi.fn(() => ({ assistants: { assistants: [], defaultAssistant: {} }, llm: {} })),
    dispatch: vi.fn()
  }
}))

function makeProjection(): ImportNavigationProjection {
  return {
    version: 1,
    sourcePersistVersion: 215,
    assistants: [
      { id: 'a-1', name: 'Assistant One', emoji: '😀', order: 0 },
      { id: 'a-2', name: 'Assistant Two', emoji: null, order: 1 }
    ],
    topics: [
      {
        id: 't-1',
        assistantId: 'a-1',
        name: 'Topic A',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: null,
        pinned: true,
        isNameManuallyEdited: true,
        order: 0
      },
      {
        id: 't-2',
        assistantId: 'a-1',
        name: 'Topic B',
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        pinned: false,
        isNameManuallyEdited: false,
        order: 1
      },
      {
        id: 't-deleted',
        assistantId: 'a-2',
        name: 'Trashed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: '2026-02-01T00:00:00.000Z',
        pinned: false,
        isNameManuallyEdited: false,
        order: 0
      }
    ],
    // LOCK-FP2: recovered entries carry the IndexedDB-authoritative
    // deletedAt — one active, one deleted.
    recoveredTopicIds: [
      { id: 't-r1', deletedAt: null },
      { id: 't-r2', deletedAt: '2026-03-01T00:00:00.000Z' }
    ]
  }
}

describe('projectionTopicToTopic (LOCK-PROD-2/4)', () => {
  it('carries source metadata verbatim and null timestamps stay unknown', () => {
    const topic = projectionTopicToTopic({
      id: 't-2',
      assistantId: 'a-1',
      name: 'Topic B',
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      pinned: false,
      isNameManuallyEdited: false,
      order: 1
    })
    expect(topic).toEqual({
      id: 't-2',
      assistantId: 'a-1',
      name: 'Topic B',
      createdAt: '',
      updatedAt: '',
      messages: []
    })
  })

  it('carries deletedAt and pin/rename flags when present', () => {
    const topic = projectionTopicToTopic(makeProjection().topics[0])
    expect(topic.deletedAt).toBeUndefined()
    expect(topic.pinned).toBe(true)
    expect(topic.isNameManuallyEdited).toBe(true)

    const deleted = projectionTopicToTopic(makeProjection().topics[2])
    expect(deleted.deletedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('localizes an empty projection topic name (LOCK-PROD-12)', async () => {
    const { default: i18n } = await import('@renderer/i18n')
    const topic = projectionTopicToTopic({
      id: 't-x',
      assistantId: 'a-1',
      name: '',
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      pinned: false,
      isNameManuallyEdited: false,
      order: 0
    })
    expect(topic.name).toBe(i18n.t('import.cherrystudio.untitled_topic'))
  })
})

describe('buildImportedAssistants (LOCK-PROD-2/5)', () => {
  it('builds shell assistants with prompt/type defaults and ordered non-deleted topics', () => {
    const assistants = buildImportedAssistants(makeProjection())
    expect(assistants).toHaveLength(2)

    const one = assistants[0]
    expect(one.id).toBe('a-1')
    expect(one.name).toBe('Assistant One')
    expect(one.prompt).toBe('')
    expect(one.type).toBe('assistant')
    expect(one.messages).toEqual([])
    expect(one.settings).toBeDefined()
    // t-1 then t-2 (source order); t-deleted excluded from navigation.
    expect(one.topics.map((t) => t.id)).toEqual(['t-1', 't-2'])

    const two = assistants[1]
    expect(two.id).toBe('a-2')
    // The deleted topic is NOT exposed in navigation (LOCK-PROD-3 trash).
    expect(two.topics).toEqual([])
  })
})

describe('buildRecoveredAssistant (LOCK-PROD-4/FP2)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('surfaces only ACTIVE recovered topics as visible navigation (LOCK-FP2)', async () => {
    // i18n is imported by the module; load the real i18n in the renderer test env.
    const { default: i18n } = await import('@renderer/i18n')
    const assistant = buildRecoveredAssistant([
      { id: 't-r1', deletedAt: null },
      { id: 't-r2', deletedAt: '2026-03-01T00:00:00.000Z' },
      { id: 't-r3', deletedAt: null }
    ])
    expect(assistant.id).toBe(RECOVERED_SHELL_ASSISTANT_ID)
    expect(assistant.type).toBe('assistant')
    expect(assistant.prompt).toBe('')
    // Only the active recovered topics surface; the deleted one is excluded
    // from Redux (established pattern — DB-backed trash), never resurrected.
    expect(assistant.topics).toHaveLength(2)
    expect(assistant.topics.map((t) => t.id)).toEqual(['t-r1', 't-r3'])
    expect(assistant.topics.every((t) => t.deletedAt === undefined)).toBe(true)
    // Localized deterministic names — distinct per active entry, gap-free.
    expect(assistant.topics[0].name).toContain('1')
    expect(assistant.topics[1].name).toContain('2')
    // Timestamps are unknown (empty → safe UI representation).
    expect(assistant.topics[0].createdAt).toBe('')
    expect(assistant.topics[0].updatedAt).toBe('')
    // The shell assistant name is localized.
    expect(assistant.name).toBe(i18n.t('import.cherrystudio.recovered.assistant_name'))
  })

  it('surfaces every recovered topic when none are deleted', () => {
    const assistant = buildRecoveredAssistant([
      { id: 't-r1', deletedAt: null },
      { id: 't-r2', deletedAt: null }
    ])
    expect(assistant.topics.map((t) => t.id)).toEqual(['t-r1', 't-r2'])
    expect(assistant.topics[0].name).not.toBe(assistant.topics[1].name)
  })

  it('creates an empty shell when every recovered topic is deleted (LOCK-FP2 no-resurrect)', () => {
    const assistant = buildRecoveredAssistant([
      { id: 't-r1', deletedAt: '2026-03-01T00:00:00.000Z' },
      { id: 't-r2', deletedAt: '2026-03-02T00:00:00.000Z' }
    ])
    expect(assistant.id).toBe(RECOVERED_SHELL_ASSISTANT_ID)
    expect(assistant.topics).toEqual([])
  })
})

describe('applyPendingImportProjection (LOCK-PROD-6)', () => {
  const dispatch = vi.fn()
  const flush = vi.fn()
  const getProjection = vi.fn()
  const ackProjection = vi.fn()

  beforeEach(() => {
    dispatch.mockClear()
    flush.mockReset().mockResolvedValue(undefined)
    getProjection.mockReset()
    ackProjection.mockReset().mockResolvedValue({ ok: true })
    const api = (window as unknown as { api?: Record<string, unknown> }).api ?? {}
    api.cherryImport = { getProjection, ackProjection }
    ;(window as unknown as { api: Record<string, unknown> }).api = api
  })

  afterEach(() => {
    const api = (window as unknown as { api?: Record<string, unknown> }).api
    if (api) delete api.cherryImport
  })

  it('is an idempotent no-op when no projection is pending (no dispatch, no flush, no ack)', async () => {
    getProjection.mockResolvedValue({ ok: true, projection: null })
    const applied = await applyPendingImportProjection({ dispatch, flush })
    expect(applied).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(ackProjection).not.toHaveBeenCalled()
  })

  it('dispatches replace-all, flushes durably, then acks — in that exact order', async () => {
    getProjection.mockResolvedValue({ ok: true, projection: makeProjection() })
    const applied = await applyPendingImportProjection({ dispatch, flush })
    expect(applied).toBe(true)

    // Replace-all: a-1, a-2 + the recovered shell (t-deleted excluded).
    expect(dispatch).toHaveBeenCalledTimes(1)
    const action = dispatch.mock.calls[0][0] as { type: string; payload: { id: string; topics: { id: string }[] }[] }
    expect(action.type).toBe('assistants/updateAssistants')
    expect(action.payload.map((a) => a.id)).toEqual(['a-1', 'a-2', RECOVERED_SHELL_ASSISTANT_ID])
    expect(action.payload[0].topics.map((t) => t.id)).toEqual(['t-1', 't-2'])

    // LOCK-FP2: the recovered shell carries ONLY the active recovered topic.
    const recovered = action.payload[2]
    expect(recovered.id).toBe(RECOVERED_SHELL_ASSISTANT_ID)
    expect(recovered.topics.map((t) => t.id)).toEqual(['t-r1'])

    // Ordering contract: dispatch → flush → ack.
    const order = [
      dispatch.mock.invocationCallOrder[0],
      flush.mock.invocationCallOrder[0],
      ackProjection.mock.invocationCallOrder[0]
    ]
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
  })

  it('never surfaces a deleted recovered topic as an active navigation topic (state shape, LOCK-FP2)', async () => {
    getProjection.mockResolvedValue({ ok: true, projection: makeProjection() })
    await applyPendingImportProjection({ dispatch, flush })

    const action = dispatch.mock.calls[0][0] as { type: string; payload: { id: string; topics: { id: string }[] }[] }
    const allTopicIds = action.payload.flatMap((a) => a.topics.map((t) => t.id))
    // The deleted recovered topic id appears NOWHERE in the Redux state —
    // it is not resurrected as active navigation (LOCK-FP2).
    expect(allTopicIds).not.toContain('t-r2')
    expect(allTopicIds).toContain('t-r1')
    // The deleted imported topic (t-deleted) is likewise absent.
    expect(allTopicIds).not.toContain('t-deleted')
  })

  it('does not add the recovered shell when every recovered topic is deleted (LOCK-FP2)', async () => {
    const projection: ImportNavigationProjection = {
      ...makeProjection(),
      recoveredTopicIds: [
        { id: 't-r1', deletedAt: '2026-03-01T00:00:00.000Z' },
        { id: 't-r2', deletedAt: '2026-03-02T00:00:00.000Z' }
      ]
    }
    getProjection.mockResolvedValue({ ok: true, projection })
    const applied = await applyPendingImportProjection({ dispatch, flush })
    expect(applied).toBe(true)

    const action = dispatch.mock.calls[0][0] as { type: string; payload: { id: string }[] }
    // Only the imported shells — an empty recovered shell is never created.
    expect(action.payload.map((a) => a.id)).toEqual(['a-1', 'a-2'])
    expect(action.payload.some((a) => a.id === RECOVERED_SHELL_ASSISTANT_ID)).toBe(false)
  })

  it('does not ack when the durable flush fails — the pending row is retained for retry', async () => {
    getProjection.mockResolvedValue({ ok: true, projection: makeProjection() })
    flush.mockRejectedValue(new Error('flush failed'))
    await expect(applyPendingImportProjection({ dispatch, flush })).rejects.toThrow('flush failed')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(ackProjection).not.toHaveBeenCalled()
  })

  it('does not dispatch or ack when the projection read fails', async () => {
    getProjection.mockResolvedValue({ ok: false, error: 'read failed' })
    const applied = await applyPendingImportProjection({ dispatch, flush })
    expect(applied).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(ackProjection).not.toHaveBeenCalled()
  })

  it('is a no-op when the cherryImport IPC bridge is unavailable', async () => {
    const api = (window as unknown as { api?: Record<string, unknown> }).api
    if (api) delete api.cherryImport
    const applied = await applyPendingImportProjection({ dispatch, flush })
    expect(applied).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(ackProjection).not.toHaveBeenCalled()
  })
})
