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
})
