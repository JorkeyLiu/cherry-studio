import { describe, expect, it } from 'vitest'

import {
  canonicalAssistantConfigKey,
  createAssistantConfigDelta,
  parseAssistantConfigKey,
  projectAssistantToConfig,
  validateAssistantConfigDelta,
  validateAssistantConfigPayload
} from '../assistantConfig'

describe('assistantConfig portable DTO', () => {
  it('projects exact allowlisted keys without topic/message/secret leakage', () => {
    const dto = projectAssistantToConfig({
      id: 'a1',
      name: 'Helper',
      prompt: 'You are helpful. token secret password credentials should stay literal-safe.',
      type: 'assistant',
      emoji: '😀',
      description: 'd',
      tags: ['t1'],
      model: { provider: 'p1', id: 'm1', name: 'M1', group: 'g' },
      settings: {
        temperature: 0.7,
        streamOutput: true,
        contextWindowAnchor: { t1: { kind: 'active', groupKey: 'g1' } }
      },
      knowledge_bases: [{ id: 'kb1' }],
      mcpServers: [{ id: 'srv1' }],
      enableWebSearch: true,
      topics: [{ id: 'must-drop' }],
      messages: [{ id: 'must-drop' }]
    } as unknown as Parameters<typeof projectAssistantToConfig>[0])
    expect(dto).not.toBeNull()
    expect(dto!.model).toEqual({ connectionId: 'p1', modelId: 'm1', displayName: 'M1', group: 'g' })
    expect(dto!.knowledgeBaseIds).toEqual(['kb1'])
    expect(dto!.mcpServerIds).toEqual(['srv1'])
    // Prompt literal words like "token/secret" must NOT invalidate the DTO.
    expect(validateAssistantConfigPayload(dto)).toBeNull()
    expect(JSON.stringify(dto)).not.toContain('must-drop')
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
