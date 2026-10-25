/**
 * Config-producer dispatch sequence preserves live complete topics.
 *
 * Regression lock for the sync visibility selection failure: the captured
 * E2E writer trace showed the ONLY topics-replacing dispatch in the failure
 * window was `assistants/updateTopics` (authoritative Main directory
 * replace). Config producers observed in the same window —
 * `updateAssistantSettings`, `applyRemoteAssistantConfig` (topics-free DTO),
 * `enqueueAssistantConfigDelta`/`ackAssistantConfigDelta` — never changed
 * catalog counts. This test replays that producer sequence against the real
 * slice reducer and proves the live directory survives it; only a complete
 * `updateTopics` directory may replace, and a complete directory preserves
 * owned rows.
 */

import { describe, expect, it } from 'vitest'

import reducer, {
  ackAssistantConfigDelta,
  applyRemoteAssistantConfig,
  type AssistantsState,
  enqueueAssistantConfigDelta,
  updateAssistantSettings,
  updateTopics
} from '../assistants'

function topic(id: string, assistantId: string): Record<string, unknown> {
  return {
    id,
    assistantId,
    name: id,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messages: []
  }
}

function seed(): AssistantsState {
  return {
    assistantDefaults: {} as never,
    assistants: [
      {
        id: 'a1',
        name: 'A',
        topics: [topic('t-local', 'a1'), topic('t-default', 'a1')],
        settings: { temperature: 0.7 }
      }
    ] as never,
    tagsOrder: [],
    collapsedTags: {},
    presets: [],
    unifiedListOrder: [],
    assistantConfigSync: { pending: {}, projectionVersions: {} }
  }
}

function topicIds(state: AssistantsState): string[] {
  const list = (state.assistants[0] as unknown as { topics: Array<{ id: string }> }).topics ?? []
  return list.map((t) => t.id)
}

describe('assistant config producers preserve live topics', () => {
  it('captured E2E producer sequence cannot drop the live directory', () => {
    let state = seed()
    // 1. Local settings edit (streaming-adjacent producer).
    state = reducer(state, updateAssistantSettings({ assistantId: 'a1', settings: { temperature: 0.9 } }))
    expect(topicIds(state)).toEqual(['t-local', 't-default'])
    // 2. Remote projection apply with a topics-free validated DTO.
    const remoteDto = { schemaVersion: 1, kind: 'assistant', id: 'a1', name: 'Renamed' }
    const remoteAction = {
      ...applyRemoteAssistantConfig({ payload: remoteDto as never, projectionRevision: 1 }),
      meta: { fromSync: true }
    }
    state = reducer(state, remoteAction as never)
    expect(topicIds(state)).toEqual(['t-local', 't-default'])
    expect((state.assistants[0] as unknown as { name: string }).name).toBe('Renamed')
    // 3. Durable-pending ledger enqueue + strict ack (never a catalog write).
    state = reducer(
      state,
      enqueueAssistantConfigDelta({
        key: 'assistant_config:assistant:a1',
        delta: { kind: 'assistant', id: 'a1', mutationId: 'm1', revision: 1, timestamp: 1, fields: {} }
      }) as never
    )
    expect(topicIds(state)).toEqual(['t-local', 't-default'])
    state = reducer(state, ackAssistantConfigDelta({ key: 'assistant_config:assistant:a1', mutationId: 'm1' }))
    expect(topicIds(state)).toEqual(['t-local', 't-default'])
    // 4. Authoritative complete directory replace preserves owned rows.
    state = reducer(
      state,
      updateTopics({ assistantId: 'a1', topics: [topic('t-local', 'a1'), topic('t-default', 'a1')] as never })
    )
    expect(topicIds(state)).toEqual(['t-local', 't-default'])
  })
})

describe('assistant config remote apply keeps device-local model selection', () => {
  it('applies portable fields while local model slots and model-indexed settings survive', () => {
    const localModel = { id: 'local-model-a', provider: 'conn-a', name: 'Local A', group: 'g' }
    const localDefault = { id: 'local-model-b', provider: 'conn-a', name: 'Local B', group: 'g' }
    const localSettingsDefault = { id: 'local-model-c', provider: 'conn-a', name: 'Local C', group: 'g' }
    let state: AssistantsState = {
      assistantDefaults: {} as never,
      assistants: [
        {
          id: 'a1',
          name: 'A',
          prompt: 'old',
          topics: [topic('t-local', 'a1')],
          model: localModel,
          defaultModel: localDefault,
          settings: {
            temperature: 0.7,
            reasoning_effort: 'high',
            reasoning_effort_by_model: { 'conn-a:local-model-a': 'high' },
            reasoning_effort_show_all_by_model: { 'conn-a:local-model-a': true },
            reasoning_effort_cache: 'high',
            defaultModel: localSettingsDefault,
            contextWindowAnchor: { t1: { kind: 'active', groupKey: 'g1' } }
          }
        }
      ] as never,
      tagsOrder: [],
      collapsedTags: {},
      presets: [],
      unifiedListOrder: [],
      assistantConfigSync: { pending: {}, projectionVersions: {} }
    }
    // Portable-only remote projection (no model/defaultModel keys possible).
    state = reducer(state, {
      ...applyRemoteAssistantConfig({
        payload: {
          schemaVersion: 1,
          kind: 'assistant',
          id: 'a1',
          name: 'Renamed',
          prompt: 'new',
          settings: { temperature: 0.2, reasoning_effort: 'low' }
        } as never,
        projectionRevision: 1
      }),
      meta: { fromSync: true }
    } as never)
    const row = state.assistants[0] as unknown as Record<string, unknown>
    expect(row.name).toBe('Renamed')
    expect(row.prompt).toBe('new')
    // Local selection objects (and their metadata) are untouched.
    expect(row.model).toEqual(localModel)
    expect(row.defaultModel).toEqual(localDefault)
    const settings = row.settings as Record<string, unknown>
    expect(settings.temperature).toBe(0.2)
    expect(settings.reasoning_effort).toBe('low')
    expect(settings.defaultModel).toEqual(localSettingsDefault)
    expect(settings.reasoning_effort_by_model).toEqual({ 'conn-a:local-model-a': 'high' })
    expect(settings.reasoning_effort_show_all_by_model).toEqual({ 'conn-a:local-model-a': true })
    expect(settings.reasoning_effort_cache).toBe('high')
    expect(settings.contextWindowAnchor).toEqual({ t1: { kind: 'active', groupKey: 'g1' } })
    // Live topics still intact (no catalog write on this path).
    expect(topicIds(state)).toEqual(['t-local'])
  })
})
