import {
  decodeModelSlotForApply,
  decodeSyncModelDto,
  isValidRuntimeModel,
  isValidSyncModelDto,
  repairAssistantsSlice
} from '@renderer/utils/syncModelRef'
import { projectAssistantToConfig } from '@shared/sync/assistantConfig'
import { describe, expect, it } from 'vitest'

import reducer, { applyRemoteAssistantConfig, assistantsPersistTransform } from '../assistants'

function seedState(): any {
  return {
    assistantDefaults: { name: 'Defaults', prompt: '', settings: {} },
    assistants: [
      {
        id: 'a1',
        name: 'A',
        topics: [{ id: 't1', assistantId: 'a1', name: 'T', messages: [] }],
        model: {
          id: 'm-local',
          provider: 'p1',
          name: 'Local',
          group: 'g',
          capabilities: [{ type: 'function_calling', isUserSelected: true }],
          pricing: { input: '1' }
        },
        settings: { temperature: 0.7, defaultModel: { id: 'm-s', provider: 'p1', name: 'S', group: 'g' } }
      }
    ],
    tagsOrder: [],
    collapsedTags: {},
    presets: [],
    unifiedListOrder: [],
    assistantConfigSync: { pending: {}, projectionVersions: {} }
  }
}

const fromSync = (action: any): any => ({ ...action, meta: { fromSync: true } })

describe('sync ModelRef decode', () => {
  it('maps DTO ids to runtime identity with deterministic presentation fallback', () => {
    expect(isValidSyncModelDto({ connectionId: 'p1', modelId: 'm1' })).toBe(true)
    expect(isValidSyncModelDto({ connectionId: '', modelId: 'm1' })).toBe(false)
    expect(isValidSyncModelDto({ connectionId: 'p1', modelId: 'm1', evil: 1 })).toBe(false)
    expect(decodeSyncModelDto({ connectionId: 'p1', modelId: 'm1' })).toEqual({
      id: 'm1',
      provider: 'p1',
      name: 'm1',
      group: ''
    })
    expect(decodeSyncModelDto({ connectionId: 'p1', modelId: 'm1', displayName: 'Pretty', group: 'g' })).toEqual({
      id: 'm1',
      provider: 'p1',
      name: 'Pretty',
      group: 'g'
    })
    // Legal runtime Models are recognized and never depend on provider lists.
    expect(isValidRuntimeModel({ id: 'm1', provider: 'unknown-conn', name: 'N', group: '' })).toBe(true)
    expect(isValidRuntimeModel({ connectionId: 'p1', modelId: 'm1' })).toBe(false)
  })

  it('projector -> apply roundtrip decodes legal ids and preserves topics/routes', () => {
    const dto = projectAssistantToConfig({
      id: 'a1',
      name: 'Renamed',
      model: { provider: 'p1', id: 'm-remote', name: 'Remote', group: 'g2' },
      settings: { defaultModel: { provider: 'p1', id: 'm-remote-s', name: 'RS', group: '' } }
    } as never)
    expect(dto).not.toBeNull()
    let state = seedState()
    state = reducer(
      state,
      fromSync(applyRemoteAssistantConfig({ payload: dto as never, projectionRevision: 1 })) as never
    )
    const row = state.assistants[0]
    expect(row.topics.map((t: any) => t.id)).toEqual(['t1'])
    expect(row.name).toBe('Renamed')
    expect(row.model).toEqual({ id: 'm-remote', provider: 'p1', name: 'Remote', group: 'g2' })
    expect(row.settings.defaultModel).toEqual({ id: 'm-remote-s', provider: 'p1', name: 'RS', group: '' })
    expect(row.settings.temperature).toBe(0.7)
  })

  it('absent keys preserve, explicit null clears without truthy no-id objects', () => {
    let state = seedState()
    const before = state.assistants[0].model
    state = reducer(
      state,
      fromSync(
        applyRemoteAssistantConfig({
          payload: { schemaVersion: 1, kind: 'assistant', id: 'a1', name: 'N' } as never,
          projectionRevision: 2
        })
      ) as never
    )
    expect(state.assistants[0].model).toBe(before)
    state = reducer(
      state,
      fromSync(
        applyRemoteAssistantConfig({
          payload: { schemaVersion: 1, kind: 'assistant', id: 'a1', model: null } as never,
          projectionRevision: 3
        })
      ) as never
    )
    expect(state.assistants[0].model).toBeUndefined()
    expect(state.assistants[0].model).toBeFalsy()
  })

  it('same-identity local capability extras survive; different identity inherits nothing', () => {
    let state = seedState()
    // Same id/provider, new display: extras kept, display refreshed.
    state = reducer(
      state,
      fromSync(
        applyRemoteAssistantConfig({
          payload: {
            schemaVersion: 1,
            kind: 'assistant',
            id: 'a1',
            model: { connectionId: 'p1', modelId: 'm-local', displayName: 'NewName', group: 'g2' }
          } as never,
          projectionRevision: 4
        })
      ) as never
    )
    expect(state.assistants[0].model).toMatchObject({
      id: 'm-local',
      provider: 'p1',
      name: 'NewName',
      group: 'g2',
      capabilities: [{ type: 'function_calling', isUserSelected: true }],
      pricing: { input: '1' }
    })
    // Different identity: fresh base only, no inherited extras.
    state = reducer(
      state,
      fromSync(
        applyRemoteAssistantConfig({
          payload: {
            schemaVersion: 1,
            kind: 'assistant',
            id: 'a1',
            model: { connectionId: 'pX', modelId: 'm-other' }
          } as never,
          projectionRevision: 5
        })
      ) as never
    )
    expect(state.assistants[0].model).toEqual({ id: 'm-other', provider: 'pX', name: 'm-other', group: '' })
    expect(state.assistants[0].model.capabilities).toBeUndefined()
    // Unknown connection is still kept as identity (never silently dropped).
    expect(state.assistants[0].model.provider).toBe('pX')
    // Unknown malformed never overwrites.
    const kept = state.assistants[0].model
    state = reducer(
      state,
      fromSync(
        applyRemoteAssistantConfig({
          payload: { schemaVersion: 1, kind: 'assistant', id: 'a1', model: 'nope' } as never,
          projectionRevision: 6
        })
      ) as never
    )
    expect(state.assistants[0].model).toBe(kept)
    expect(decodeModelSlotForApply('nope', kept)).toEqual({ action: 'preserve' })
  })
})

describe('persisted DTO repair (read transform)', () => {
  it('leaves legal Models untouched by identity; repairs every approved DTO slot', () => {
    const legal = { id: 'm1', provider: 'p1', name: 'N', group: 'g', capabilities: [{ type: 'x' }] }
    const slice: any = {
      assistants: [
        {
          id: 'a1',
          model: legal,
          defaultModel: { connectionId: 'p1', modelId: 'm2' },
          settings: { temperature: 1, defaultModel: { connectionId: 'p1', modelId: 'm3', displayName: 'D3' } },
          topics: [{ id: 't1' }]
        },
        { id: 'a2', model: 'nope', settings: { temperature: 2 } }
      ],
      assistantDefaults: {
        name: 'D',
        model: { connectionId: 'p9', modelId: 'm9' },
        settings: { defaultModel: { connectionId: 'p9', modelId: 'm10', group: 'g10' } }
      }
    }
    const repaired: any = repairAssistantsSlice(slice)
    expect(repaired.assistants[0].model).toBe(legal)
    expect(repaired.assistants[0].defaultModel).toEqual({ id: 'm2', provider: 'p1', name: 'm2', group: '' })
    expect(repaired.assistants[0].settings.defaultModel).toEqual({ id: 'm3', provider: 'p1', name: 'D3', group: '' })
    expect(repaired.assistants[0].settings.temperature).toBe(1)
    expect(repaired.assistants[0].topics).toBe(slice.assistants[0].topics)
    expect(repaired.assistants[1].model).toBe('nope')
    expect(repaired.assistantDefaults.model).toEqual({ id: 'm9', provider: 'p9', name: 'm9', group: '' })
    expect(repaired.assistantDefaults.settings.defaultModel).toEqual({
      id: 'm10',
      provider: 'p9',
      name: 'm10',
      group: 'g10'
    })
  })

  it('passes through legacy shapes without throwing and keeps llm-adjacent content alone', () => {
    for (const input of [undefined, null, 42, 'x', [], {}, { assistants: 'nope' }, { assistantDefaults: 7 }]) {
      expect(() => repairAssistantsSlice(input)).not.toThrow()
    }
    expect(repairAssistantsSlice(undefined)).toBe(undefined)
    expect(repairAssistantsSlice(null)).toBe(null)
    const empty: any = { assistants: [], assistantDefaults: { name: 'D', settings: {} } }
    expect(repairAssistantsSlice(empty)).toBe(empty)
  })

  it('actual persist transform repairs a version-227 polluted payload on the 225 path', () => {
    // Stored root shape carrying a higher _persist.version (main bad-persist 227):
    // the assistants slice itself is still repaired via the outbound transform,
    // which runs regardless of the migrate version floor.
    const pollutedAssistants: any = {
      assistants: [{ id: 'a1', model: { connectionId: 'p1', modelId: 'm1' }, settings: {} }],
      assistantDefaults: { name: 'D', settings: { defaultModel: { connectionId: 'p1', modelId: 'm2' } } }
    }
    const out227 = (assistantsPersistTransform as any).out(pollutedAssistants, 'assistants', {
      assistants: pollutedAssistants
    })
    expect(out227.assistants[0].model).toEqual({ id: 'm1', provider: 'p1', name: 'm1', group: '' })
    expect(out227.assistantDefaults.settings.defaultModel).toEqual({ id: 'm2', provider: 'p1', name: 'm2', group: '' })
    const out225 = (assistantsPersistTransform as any).out(pollutedAssistants, 'assistants', {
      assistants: pollutedAssistants
    })
    expect(out225).toEqual(out227)
    // Inbound (redux -> storage) is identity; llm keys never enter this whitelist.
    expect((assistantsPersistTransform as any).in(pollutedAssistants, 'assistants', {})).toBe(pollutedAssistants)
  })
})
