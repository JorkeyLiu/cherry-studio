import { describe, expect, it } from 'vitest'

import migrate from '../migrate'

describe('store migrations', () => {
  describe('migration 207: StepFun Anthropic-compatible host backfill', () => {
    it('backfills anthropicApiHost for existing StepFun providers', async () => {
      const state = {
        llm: {
          providers: [
            {
              id: 'stepfun',
              apiHost: 'https://api.stepfun.com'
            }
          ]
        },
        _persist: { version: 206, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 207)

      expect(migrated.llm.providers[0].anthropicApiHost).toBe('https://api.stepfun.com')
    })

    it('preserves existing StepFun anthropicApiHost customizations', async () => {
      const state = {
        llm: {
          providers: [
            {
              id: 'stepfun',
              apiHost: 'https://api.stepfun.com',
              anthropicApiHost: 'https://custom.example.com'
            }
          ]
        },
        _persist: { version: 206, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 207)

      expect(migrated.llm.providers[0].anthropicApiHost).toBe('https://custom.example.com')
    })
  })

  describe('migration 213: Remove 100 = unlimited sentinel from contextCount', () => {
    const makeState = (
      assistants: Array<{ settings?: { contextCount?: number } }>,
      defaultAssistant?: { settings?: { contextCount?: number } }
    ) => ({
      assistants: {
        defaultAssistant: defaultAssistant ?? { settings: { contextCount: 5 } },
        assistants
      },
      _persist: { version: 212, rehydrated: false }
    })

    it('converts contextCount=100 to null for default assistant', async () => {
      const state = makeState([], { settings: { contextCount: 100 } })
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.defaultAssistant.settings.contextCount).toBeNull()
    })

    it('converts contextCount=100 to null for regular assistants', async () => {
      const state = makeState([{ settings: { contextCount: 100 } }, { settings: { contextCount: 100 } }])
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBeNull()
      expect(migrated.assistants.assistants[1].settings.contextCount).toBeNull()
    })

    it('preserves finite contextCount=5 unchanged', async () => {
      const state = makeState([{ settings: { contextCount: 5 } }])
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(5)
    })

    it('preserves finite contextCount=99 unchanged', async () => {
      const state = makeState([{ settings: { contextCount: 99 } }])
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(99)
    })

    it('preserves finite contextCount=1 unchanged', async () => {
      const state = makeState([{ settings: { contextCount: 1 } }])
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(1)
    })

    it('preserves contextCount=0 unchanged', async () => {
      const state = makeState([{ settings: { contextCount: 0 } }])
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(0)
    })

    it('handles assistant without settings gracefully', async () => {
      const state = makeState([{}])
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.assistants[0].settings).toBeUndefined()
    })

    it('handles assistant with settings but no contextCount gracefully', async () => {
      const state = makeState([{ settings: { temperature: 0.5 } as any }])
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBeUndefined()
    })

    it('converts mixed assistants correctly', async () => {
      const state = makeState(
        [
          { settings: { contextCount: 100 } },
          { settings: { contextCount: 5 } },
          { settings: { contextCount: 99 } },
          { settings: { contextCount: 0 } }
        ],
        { settings: { contextCount: 100 } }
      )
      const migrated: any = await migrate(state as any, 213)
      expect(migrated.assistants.defaultAssistant.settings.contextCount).toBeNull()
      expect(migrated.assistants.assistants[0].settings.contextCount).toBeNull()
      expect(migrated.assistants.assistants[1].settings.contextCount).toBe(5)
      expect(migrated.assistants.assistants[2].settings.contextCount).toBe(99)
      expect(migrated.assistants.assistants[3].settings.contextCount).toBe(0)
    })
  })

  describe('migration 115: backfill missing assistant settings with defaults', () => {
    it('backfills assistants with missing settings using contextCount 25 (new default)', async () => {
      const state = {
        assistants: {
          assistants: [{ id: 'a1' }, { id: 'a2', settings: { temperature: 0.5 } as any }]
        },
        _persist: { version: 114, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 115)

      // Assistant without settings gets the new default contextCount 25.
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(25)
      // Assistant with existing settings is not touched.
      expect(migrated.assistants.assistants[1].settings.contextCount).toBeUndefined()
    })
  })

  describe('migration 216: single anchor-to-end context window model', () => {
    const anchor = { kind: 'active', groupKey: 'u1' } as const
    const makeState = (
      assistants: Array<Record<string, any>>,
      defaultAssistant: Record<string, any> = { settings: { contextCount: 5 } }
    ) => ({
      assistants: {
        defaultAssistant,
        assistants
      },
      _persist: { version: 215, rehydrated: false }
    })

    it('retains legacy anchors for topics effectively fixed under old semantics', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            contextWindowMode: 'fixed',
            topicContextWindowMode: { topicA: 'fixed' },
            fixedWindowAnchor: { topicA: anchor }
          }
        }
      ])
      const migrated: any = await migrate(state as any, 216)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextWindowAnchor.topicA).toEqual(anchor)
    })

    it('drops legacy anchors for effectively sliding topics (global sliding)', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            contextWindowMode: 'sliding',
            topicContextWindowMode: { topicA: 'fixed' },
            fixedWindowAnchor: { topicA: anchor }
          }
        }
      ])
      const migrated: any = await migrate(state as any, 216)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextWindowAnchor.topicA).toBeUndefined()
    })

    it('drops legacy anchors when the topic override is sliding', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            contextWindowMode: 'fixed',
            topicContextWindowMode: { topicA: 'sliding' },
            fixedWindowAnchor: { topicA: anchor }
          }
        }
      ])
      const migrated: any = await migrate(state as any, 216)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextWindowAnchor.topicA).toBeUndefined()
    })

    it('handles mixed topics independently', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            contextWindowMode: 'fixed',
            topicContextWindowMode: { topicA: 'fixed', topicB: 'sliding', topicC: undefined },
            fixedWindowAnchor: { topicA: anchor, topicB: anchor, topicC: anchor }
          }
        }
      ])
      const migrated: any = await migrate(state as any, 216)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextWindowAnchor.topicA).toEqual(anchor)
      expect(settings.contextWindowAnchor.topicB).toBeUndefined()
      // topic override undefined + global fixed → effectively fixed
      expect(settings.contextWindowAnchor.topicC).toEqual(anchor)
    })

    it('removes obsolete contextWindowMode / topicContextWindowMode / fixedWindowAnchor', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            contextWindowMode: 'fixed',
            topicContextWindowMode: { topicA: 'fixed' },
            fixedWindowAnchor: { topicA: anchor }
          }
        }
      ])
      const migrated: any = await migrate(state as any, 216)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextWindowMode).toBeUndefined()
      expect(settings.topicContextWindowMode).toBeUndefined()
      expect(settings.fixedWindowAnchor).toBeUndefined()
      expect(settings.contextWindowAnchor.topicA).toEqual(anchor)
    })

    it('converts contextCount 0 → 1 for regular and default assistants', async () => {
      const state = makeState([{ settings: { contextCount: 0 } }, { settings: { contextCount: 3 } }], {
        settings: { contextCount: 0 }
      })
      const migrated: any = await migrate(state as any, 216)
      expect(migrated.assistants.defaultAssistant.settings.contextCount).toBe(1)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(1)
      expect(migrated.assistants.assistants[1].settings.contextCount).toBe(3)
    })

    it('preserves finite contextCount and null (unlimited) unchanged', async () => {
      const state = makeState([{ settings: { contextCount: 5 } }, { settings: { contextCount: null } }])
      const migrated: any = await migrate(state as any, 216)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(5)
      expect(migrated.assistants.assistants[1].settings.contextCount).toBeNull()
    })

    it('does not rewrite persisted contextCount 5 to the new default 25 (LOCK-CTX-12)', async () => {
      const state = makeState([{ settings: { contextCount: 5 } }], { settings: { contextCount: 5 } })
      const migrated: any = await migrate(state as any, 216)
      expect(migrated.assistants.defaultAssistant.settings.contextCount).toBe(5)
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(5)
    })

    it('handles assistants without settings gracefully', async () => {
      const state = makeState([{}])
      const migrated: any = await migrate(state as any, 216)
      expect(migrated.assistants.assistants[0].settings).toBeUndefined()
    })

    it('preserves an already-present contextWindowAnchor when no legacy data exists', async () => {
      const state = makeState([{ settings: { contextCount: 5, contextWindowAnchor: { topicA: anchor } } }])
      const migrated: any = await migrate(state as any, 216)
      expect(migrated.assistants.assistants[0].settings.contextWindowAnchor.topicA).toEqual(anchor)
    })

    it('migrates the default assistant settings too', async () => {
      const state = makeState([], {
        settings: {
          contextCount: 0,
          contextWindowMode: 'fixed',
          topicContextWindowMode: { topicA: 'fixed' },
          fixedWindowAnchor: { topicA: anchor }
        }
      })
      const migrated: any = await migrate(state as any, 216)
      const settings = migrated.assistants.defaultAssistant.settings
      expect(settings.contextCount).toBe(1)
      expect(settings.contextWindowAnchor.topicA).toEqual(anchor)
      expect(settings.contextWindowMode).toBeUndefined()
    })

    it('is idempotent: re-running 216 over an already-migrated state is stable (LOCK-FIX-5)', async () => {
      // Simulates redux-persist re-migrating a rehydrated (already-216) persisted
      // state: the second pass must reproduce the first pass exactly.
      const state = makeState([
        {
          settings: {
            contextCount: 0,
            contextWindowMode: 'fixed',
            topicContextWindowMode: { topicA: 'fixed', topicB: 'sliding' },
            fixedWindowAnchor: { topicA: anchor, topicB: anchor },
            contextWindowAnchor: { topicA: anchor }
          }
        },
        { settings: { contextCount: 5 } }
      ])

      const first: any = await migrate(structuredClone(state) as any, 216)
      const second: any = await migrate(structuredClone(first), 216)

      expect(second).toEqual(first)
      // Explicit spot checks on the stable result.
      const settings = second.assistants.assistants[0].settings
      expect(settings.contextCount).toBe(1)
      expect(settings.contextWindowAnchor.topicA).toEqual(anchor)
      expect(settings.contextWindowMode).toBeUndefined()
      expect(settings.topicContextWindowMode).toBeUndefined()
      expect(settings.fixedWindowAnchor).toBeUndefined()
    })
  })
})
