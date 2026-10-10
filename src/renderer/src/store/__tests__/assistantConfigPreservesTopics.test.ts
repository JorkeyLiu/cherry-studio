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
