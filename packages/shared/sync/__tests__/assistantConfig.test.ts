import { describe, expect, it } from 'vitest'

import {
  canonicalAssistantConfigKey,
  createAssistantConfigDelta,
  diffPortableAssistantConfigFields,
  parseAssistantConfigKey,
  projectAssistantToConfig,
  sanitizeAssistantConfigFields,
  validateAssistantConfigDelta,
  validateAssistantConfigPayload
} from '../assistantConfig'

describe('assistantConfig portable DTO', () => {
  it('projects only portable keys: local model selection and removed capabilities never ride the wire', () => {
    const dto = projectAssistantToConfig({
      id: 'a1',
      name: 'Helper',
      prompt: 'You are helpful. token secret password credentials should stay literal-safe.',
      type: 'assistant',
      emoji: '😀',
      description: 'd',
      tags: ['t1'],
      model: { provider: 'p1', id: 'm1', name: 'M1', group: 'g' },
      defaultModel: { provider: 'p1', id: 'm2' },
      settings: {
        temperature: 0.7,
        streamOutput: true,
        reasoning_effort: 'high',
        reasoning_effort_cache: 'high',
        reasoning_effort_by_model: { 'p1:m1': 'high' },
        reasoning_effort_show_all_by_model: { 'p1:m1': true },
        defaultModel: { provider: 'p1', id: 'm3' },
        contextWindowAnchor: { t1: { kind: 'active', groupKey: 'g1' } }
      },
      knowledge_bases: [{ id: 'kb1' }],
      enableUrlContext: true,
      enableGenerateImage: true,
      knowledgeRecognition: 'on',
      topics: [{ id: 'must-drop' }],
      messages: [{ id: 'must-drop' }]
    } as unknown as Parameters<typeof projectAssistantToConfig>[0])
    expect(dto).not.toBeNull()
    expect(dto).not.toHaveProperty('model')
    expect(dto).not.toHaveProperty('defaultModel')
    expect(dto!.knowledgeBaseIds).toEqual(['kb1'])
    expect(dto!.enableUrlContext).toBe(true)
    expect(dto!.settings).toEqual({
      temperature: 0.7,
      streamOutput: true,
      reasoning_effort: 'high',
      contextWindowAnchor: { t1: { kind: 'active', groupKey: 'g1' } }
    })
    // Prompt literal words like "token/secret" must NOT invalidate the DTO.
    expect(validateAssistantConfigPayload(dto)).toBeNull()
    const wire = JSON.stringify(dto)
    expect(wire).not.toContain('must-drop')
    expect(wire).not.toContain('connectionId')
    expect(wire).not.toContain('reasoning_effort_by_model')
    expect(wire).not.toContain('reasoning_effort_cache')
  })

  it('rejects denied/exact-key violations and secret-shaped keys', () => {
    expect(validateAssistantConfigPayload({ schemaVersion: 1, kind: 'assistant', id: 'a', topics: [] })).toMatch(
      /not allowlisted/
    )
    expect(validateAssistantConfigPayload({ schemaVersion: 1, kind: 'assistant', id: 'a', credentials: {} })).toMatch(
      /not allowlisted/
    )
    expect(
      validateAssistantConfigPayload({ schemaVersion: 1, kind: 'assistant', id: 'a', settings: { evil: 1 } })
    ).toMatch(/not allowlisted/)
  })

  it('keeps anchors complete and rejects missing refs guessing', () => {
    expect(
      validateAssistantConfigPayload({
        schemaVersion: 1,
        kind: 'assistant',
        id: 'a',
        settings: { contextWindowAnchor: { t1: { kind: 'active' } } }
      })
    ).toMatch(/exactly/)
    expect(
      validateAssistantConfigPayload({
        schemaVersion: 1,
        kind: 'assistant',
        id: 'a',
        settings: { contextWindowAnchor: { t1: { kind: 'active', groupKey: 'g' } } }
      })
    ).toBeNull()
  })

  it('strictly rejects device-local model slots and removed capability fields (no accept-and-ignore)', () => {
    const base = { schemaVersion: 1, kind: 'assistant', id: 'a' }
    expect(validateAssistantConfigPayload({ ...base, model: { connectionId: 'p', modelId: 'm' } })).toMatch(
      /model not allowlisted/
    )
    expect(validateAssistantConfigPayload({ ...base, defaultModel: { connectionId: 'p', modelId: 'm' } })).toMatch(
      /defaultModel not allowlisted/
    )
    expect(
      validateAssistantConfigPayload({ ...base, settings: { defaultModel: { connectionId: 'p', modelId: 'm' } } })
    ).toMatch(/settings.defaultModel not allowlisted/)
    for (const key of ['reasoning_effort_by_model', 'reasoning_effort_show_all_by_model', 'reasoning_effort_cache']) {
      expect(validateAssistantConfigPayload({ ...base, settings: { [key]: {} } })).toMatch(
        new RegExp(`settings.${key} not allowlisted`)
      )
    }
    for (const key of ['mcpMode', 'mcpServerIds', 'enableWebSearch', 'webSearchProviderId', 'enableMemory']) {
      expect(validateAssistantConfigPayload({ ...base, [key]: 'x' })).toMatch(new RegExp(`${key} not allowlisted`))
    }
    // Generic (non model-indexed) reasoning effort stays portable.
    expect(validateAssistantConfigPayload({ ...base, settings: { reasoning_effort: 'high' } })).toBeNull()
  })

  it('sanitizes local records to the portable surface and diffs only real portable changes', () => {
    const local = {
      name: 'Helper',
      model: { provider: 'p1', id: 'm1', name: 'M1' },
      defaultModel: { provider: 'p1', id: 'm2' },
      settings: {
        temperature: 0.7,
        reasoning_effort: 'high',
        reasoning_effort_cache: 'high',
        reasoning_effort_by_model: { 'p1:m1': 'high' },
        defaultModel: { provider: 'p1', id: 'm3' }
      }
    }
    expect(sanitizeAssistantConfigFields(local)).toEqual({
      name: 'Helper',
      settings: { temperature: 0.7, reasoning_effort: 'high' }
    })
    // Model-only local edit: no portable change => no sync intent.
    expect(
      diffPortableAssistantConfigFields(local, {
        ...local,
        model: { provider: 'p1', id: 'm9' },
        settings: { ...local.settings, reasoning_effort_cache: 'low', defaultModel: { provider: 'p1', id: 'm9' } }
      })
    ).toEqual({})
    // Mixed edit: only the portable changed field is intent.
    expect(diffPortableAssistantConfigFields(local, { ...local, temperature: 0.2, prompt: 'p' })).toEqual({
      prompt: 'p'
    })
    expect(
      diffPortableAssistantConfigFields(local, { ...local, settings: { ...local.settings, temperature: 0.2 } })
    ).toEqual({ settings: { temperature: 0.2, reasoning_effort: 'high' } })
  })

  it('canonical kind-qualified identity never collides with defaults singleton', () => {
    expect(canonicalAssistantConfigKey('assistant', 'defaults-x')).toBe('assistant_config:assistant:defaults-x')
    expect(canonicalAssistantConfigKey('defaults', 'defaults')).toBe('assistant_config:defaults:defaults')
    expect(parseAssistantConfigKey('assistant_config:defaults:defaults')).toEqual({ kind: 'defaults', id: 'defaults' })
    expect(parseAssistantConfigKey('assistant_config:defaults:other')).toBeNull()
    expect(validateAssistantConfigPayload({ schemaVersion: 1, kind: 'assistant', id: 'defaults' })).toMatch(/collides/)
  })

  it('delta shape is idempotent-keyed and tombstone-explicit', () => {
    const d = createAssistantConfigDelta({
      kind: 'assistant',
      id: 'a1',
      mutationId: 'mut-1',
      revision: 3,
      fields: { name: 'n2' }
    })
    expect(d).not.toBeNull()
    expect(validateAssistantConfigDelta(d)).toBeNull()
    const tomb = createAssistantConfigDelta({
      kind: 'assistant',
      id: 'a1',
      mutationId: 'mut-2',
      revision: 4,
      fields: {},
      deleted: true
    })
    expect(validateAssistantConfigDelta(tomb)).toBeNull()
    // Absence alone is not a delete: empty-fields non-tombstone stays non-deleted.
    expect(d!.deleted).toBeUndefined()
  })
})
