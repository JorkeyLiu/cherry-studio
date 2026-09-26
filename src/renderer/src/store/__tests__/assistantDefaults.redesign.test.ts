/**
 * Assistant-defaults redesign (persist version 225) focused tests.
 *
 * Product contract under test:
 * - The fresh-profile initial assistant is an ordinary persisted entity;
 *   no existing assistant receives special behavior by id/name/origin.
 * - `assistants.assistantDefaults` is pure configuration (no id/topics/
 *   messages) and is never usable as an Assistant fallback.
 * - Migration 225 converts legacy `defaultAssistant` into pure config,
 *   drops entity fields, and leaves `assistants[]` untouched.
 * - Language switch never renames/mutates assistants or topics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn(), debug: vi.fn() })
  }
}))

const { storeGetState } = vi.hoisted(() => ({ storeGetState: vi.fn() }))

vi.mock('@renderer/store', () => ({
  default: { getState: storeGetState, dispatch: vi.fn() }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  mergeRequestAssistantSnapshot: (orig: any) => orig
}))

import {
  createAssistantDefaults,
  createAssistantFromDefaults,
  createEphemeralAssistant,
  createInitialAssistant,
  toAssistantDefaults
} from '@renderer/services/assistantDefaults'
import { findAssistantById } from '@renderer/services/messageActionController'
import reducer, { updateAssistantDefaults } from '@renderer/store/assistants'
import migrate from '@renderer/store/migrate'

function makeLegacyAssistant() {
  return {
    id: 'default',
    name: 'Default Assistant',
    emoji: '😀',
    prompt: 'legacy-prompt',
    topics: [
      {
        id: 'legacy-topic-1',
        assistantId: 'default',
        name: 'Default Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [{ role: 'user', content: 'hi' }]
      }
    ],
    messages: [{ role: 'user', content: 'entity-message' }],
    content: 'ephemeral-content',
    type: 'assistant',
    settings: { temperature: 0.7, contextCount: 5, contextWindowAnchor: { 't-1': { kind: 'active', groupKey: 'g' } } },
    model: { id: 'm-1', provider: 'openai' }
  }
}

function makeOrdinaryAssistant(id: string) {
  return {
    id,
    name: `Assistant ${id}`,
    prompt: '',
    topics: [
      {
        id: `topic-${id}`,
        assistantId: id,
        name: 'Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: []
      }
    ],
    type: 'assistant',
    settings: { temperature: 1 }
  }
}

describe('migration 224 -> 225', () => {
  it('preserves config fields, drops id/topics/messages, leaves assistants[] deep-equal', async () => {
    const legacy = makeLegacyAssistant()
    const assistants = [makeOrdinaryAssistant('a-1'), makeOrdinaryAssistant('default')]
    const before = JSON.parse(JSON.stringify(assistants))
    const state = {
      assistants: { defaultAssistant: legacy, assistants },
      _persist: { version: 224, rehydrated: false }
    }
    const migrated: any = await migrate(state as any, 225)

    expect(migrated.assistants.defaultAssistant).toBeUndefined()
    const defaults = migrated.assistants.assistantDefaults
    expect(defaults).toBeDefined()
    expect(defaults.name).toBe('Default Assistant')
    expect(defaults.prompt).toBe('legacy-prompt')
    expect(defaults.emoji).toBe('😀')
    expect(defaults.model).toEqual({ id: 'm-1', provider: 'openai' })
    // Existing context/settings fields preserved verbatim.
    expect(defaults.settings.temperature).toBe(0.7)
    expect(defaults.settings.contextWindowAnchor).toEqual({ 't-1': { kind: 'active', groupKey: 'g' } })
    // Entity-only semantics dropped.
    expect(defaults).not.toHaveProperty('id')
    expect(defaults).not.toHaveProperty('topics')
    expect(defaults).not.toHaveProperty('messages')
    expect(defaults).not.toHaveProperty('content')
    // assistants[] byte/deep-equal unchanged (historical id='default' kept).
    expect(migrated.assistants.assistants).toEqual(before)
    expect(migrated.assistants.assistants.find((a: any) => a.id === 'default')?.name).toBe('Assistant default')
  })

  it('falls back safely for malformed/missing legacy values', async () => {
    for (const legacy of [undefined, null, 42, 'nope', [], {}]) {
      const state = {
        assistants: { defaultAssistant: legacy, assistants: [] },
        _persist: { version: 224, rehydrated: false }
      }
      const migrated: any = await migrate(state as any, 225)
      expect(migrated.assistants.defaultAssistant).toBeUndefined()
      expect(typeof migrated.assistants.assistantDefaults.name).toBe('string')
      expect(migrated.assistants.assistantDefaults).not.toHaveProperty('id')
      expect(migrated.assistants.assistantDefaults).not.toHaveProperty('topics')
      expect(migrated.assistants.assistantDefaults.settings).toBeDefined()
      expect(migrated.assistants.assistants).toEqual([])
    }
  })

  it('is idempotent for an already-migrated state', async () => {
    const fresh = createAssistantDefaults({ name: 'Custom' })
    const state = {
      assistants: { assistantDefaults: JSON.parse(JSON.stringify(fresh)), assistants: [makeOrdinaryAssistant('a-1')] },
      _persist: { version: 224, rehydrated: false }
    }
    const migrated: any = await migrate(state as any, 225)
    expect(migrated.assistants.assistantDefaults).toEqual(fresh)
    expect(migrated.assistants.assistants).toHaveLength(1)
  })
})

describe('fresh state', () => {
  it('initial assistant is ordinary; defaults carry no id/topics/messages', () => {
    const state: any = reducer(undefined, { type: '@@INIT' } as never)
    expect(state.defaultAssistant).toBeUndefined()
    expect(state.assistantDefaults).toBeDefined()
    expect(state.assistantDefaults).not.toHaveProperty('id')
    expect(state.assistantDefaults).not.toHaveProperty('topics')
    expect(state.assistantDefaults).not.toHaveProperty('messages')
    expect(state.assistants).toHaveLength(1)
    const [initial] = state.assistants
    // Historical compatibility id retained, but the entity is ordinary: a
    // normal topic owned by that entity, no template linkage.
    expect(initial.id).toBe('default')
    expect(initial.topics).toHaveLength(1)
    expect(initial.topics[0].assistantId).toBe(initial.id)
    expect(initial.topics[0].id).not.toBe('default')
  })
})

describe('pure defaults factories', () => {
  it('toAssistantDefaults selects config and drops entity fields', () => {
    const defaults = toAssistantDefaults(makeLegacyAssistant())
    expect(defaults.name).toBe('Default Assistant')
    expect(defaults.prompt).toBe('legacy-prompt')
    expect(defaults).not.toHaveProperty('id')
    expect(defaults).not.toHaveProperty('topics')
    expect(defaults).not.toHaveProperty('messages')
  })

  it('new assistant creation produces fresh entity/topic ids without fake-default branching', () => {
    const defaults = createAssistantDefaults({ name: 'Base', prompt: 'p' })
    const first = createAssistantFromDefaults(defaults)
    const second = createAssistantFromDefaults(defaults)
    for (const entity of [first, second]) {
      expect(entity.id).not.toBe('default')
      expect(entity.name).toBe('Base')
      expect(entity.topics).toHaveLength(1)
      expect(entity.topics[0].assistantId).toBe(entity.id)
    }
    expect(first.id).not.toBe(second.id)
    expect(first.topics[0].id).not.toBe(second.topics[0].id)
  })

  it('initial assistant keeps compatibility id with a normally owned topic', () => {
    const initial = createInitialAssistant(createAssistantDefaults())
    expect(initial.id).toBe('default')
    expect(initial.topics).toHaveLength(1)
    expect(initial.topics[0].assistantId).toBe('default')
  })

  it('ephemeral assistants carry fresh identity and no topics', () => {
    const first = createEphemeralAssistant({ prompt: 'a' })
    const second = createEphemeralAssistant({ prompt: 'b' })
    expect(first.id).not.toBe('default')
    expect(first.topics).toEqual([])
    expect(first.messages).toEqual([])
    expect(first.id).not.toBe(second.id)
  })
})

describe('settings updates affect defaults only', () => {
  it('updateAssistantDefaults merges config and never touches assistants[]', () => {
    const state: any = reducer(undefined, { type: '@@INIT' } as never)
    const beforeAssistants = JSON.parse(JSON.stringify(state.assistants))
    const next: any = reducer(state, updateAssistantDefaults({ name: 'Renamed', prompt: 'np' } as never))
    expect(next.assistantDefaults.name).toBe('Renamed')
    expect(next.assistantDefaults.prompt).toBe('np')
    expect(next.assistants).toEqual(beforeAssistants)
  })

  it('no legacy updateDefaultAssistant action exists', async () => {
    const actions = await import('@renderer/store/assistants')
    expect(actions).not.toHaveProperty('updateDefaultAssistant')
    expect(actions).toHaveProperty('updateAssistantDefaults')
  })
})

describe('language switch leaves assistant/topic data unchanged', () => {
  it('unknown actions (e.g. a language-only change) return state untouched', () => {
    const state: any = reducer(undefined, { type: '@@INIT' } as never)
    const snapshot = JSON.parse(JSON.stringify(state))
    // Language switch dispatches only settings/language actions; the
    // assistants slice has no language handler, so any unrelated action is
    // identity. There is no assistant/topic rename path anymore.
    const next: any = reducer(state, { type: 'settings/setLanguage', payload: 'zh-CN' } as never)
    expect(JSON.parse(JSON.stringify(next))).toEqual(snapshot)
  })
})

describe('missing assistant lookup does not return defaults', () => {
  beforeEach(() => {
    storeGetState.mockReset()
  })

  it('unknown ids stay fail-closed even with assistantDefaults present', () => {
    const state = {
      assistants: {
        assistants: [makeOrdinaryAssistant('a-1')],
        assistantDefaults: { name: 'Defaults', prompt: '', settings: {} }
      }
    }
    expect(findAssistantById(state as never, 'ghost')).toBeUndefined()
    expect(findAssistantById(state as never, 'assistantDefaults')).toBeUndefined()
    expect(findAssistantById(state as never, 'a-1')).toBe((state.assistants.assistants as any[])[0])
  })
})
