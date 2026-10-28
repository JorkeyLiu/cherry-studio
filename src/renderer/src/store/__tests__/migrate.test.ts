import { SYSTEM_PROVIDERS_CONFIG } from '@renderer/store/migrations/history/systemProviders'
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

    it('does not rewrite persisted contextCount 5 to the new default 25', async () => {
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

    it('is idempotent: re-running 216 over an already-migrated state is stable', async () => {
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

  describe('migration 217: remove CherryIN/CherryAI platform state', () => {
    const platformModel = (provider: string, id = 'qwen') => ({ id, name: 'Qwen', provider, group: 'Qwen' })
    const openaiModel = { id: 'gpt-4', name: 'GPT-4', provider: 'openai' }

    const makeState = () => ({
      llm: {
        providers: [
          { id: 'cherryin', name: 'CherryIN', type: 'openai', apiKey: 'x', apiHost: '', models: [] },
          { id: 'cherryai', name: 'CherryAI', type: 'openai', apiKey: 'x', apiHost: '', models: [] },
          { id: 'openai', name: 'OpenAI', type: 'openai', apiKey: 'k', apiHost: '', models: [openaiModel] }
        ],
        defaultModel: platformModel('cherryai'),
        topicNamingModel: platformModel('cherryin'),
        quickModel: platformModel('cherryai'),
        translateModel: openaiModel,
        settings: {
          cherryIn: { accessToken: 'tok', refreshToken: 'refresh' },
          ollama: { keepAliveTime: 0 }
        }
      },
      assistants: {
        defaultAssistant: {
          model: platformModel('cherryai', 'qwen2'),
          defaultModel: openaiModel
        },
        assistants: [
          {
            id: 'a1',
            model: platformModel('cherryin'),
            defaultModel: platformModel('cherryai', 'qwen3')
          },
          {
            id: 'a2',
            model: openaiModel,
            defaultModel: openaiModel
          }
        ],
        presets: [
          {
            id: 'p1',
            model: platformModel('cherryai', 'qwen4'),
            defaultModel: platformModel('cherryin', 'qwen5')
          },
          {
            id: 'p2',
            model: openaiModel
          }
        ]
      },
      agents: {
        agents: [
          {
            id: 'g1',
            model: platformModel('cherryai', 'qwen6'),
            defaultModel: platformModel('cherryin', 'qwen7')
          }
        ]
      },
      _persist: { version: 216, rehydrated: false }
    })

    it('removes cherryin and cherryai providers while preserving other providers', async () => {
      const migrated: any = await migrate(makeState() as any, 217)
      expect(migrated.llm.providers.map((p: { id: string }) => p.id)).toEqual(['openai'])
    })

    it('deletes CherryIN credentials from llm.settings', async () => {
      const migrated: any = await migrate(makeState() as any, 217)
      expect(migrated.llm.settings.cherryIn).toBeUndefined()
      expect(migrated.llm.settings.ollama).toEqual({ keepAliveTime: 0 })
    })

    it('clears only global model slots whose provider is cherryin or cherryai', async () => {
      const migrated: any = await migrate(makeState() as any, 217)
      expect(migrated.llm.defaultModel).toBeUndefined()
      expect(migrated.llm.topicNamingModel).toBeUndefined()
      expect(migrated.llm.quickModel).toBeUndefined()
      // Non-platform translateModel is preserved
      expect(migrated.llm.translateModel).toEqual(openaiModel)
    })

    it('clears assistant model references owned by the platform and preserves others', async () => {
      const migrated: any = await migrate(makeState() as any, 217)
      // defaultAssistant.model is platform-owned -> cleared; defaultModel is openai -> preserved
      expect(migrated.assistants.defaultAssistant.model).toBeUndefined()
      expect(migrated.assistants.defaultAssistant.defaultModel).toEqual(openaiModel)
      // a1 both platform-owned -> cleared
      expect(migrated.assistants.assistants[0].model).toBeUndefined()
      expect(migrated.assistants.assistants[0].defaultModel).toBeUndefined()
      // a2 all openai -> preserved
      expect(migrated.assistants.assistants[1].model).toEqual(openaiModel)
      expect(migrated.assistants.assistants[1].defaultModel).toEqual(openaiModel)
    })

    it('clears legacy agent and preset model references owned by the platform', async () => {
      const migrated: any = await migrate(makeState() as any, 217)
      // presets: p1 platform-owned -> cleared, p2 openai -> preserved
      expect(migrated.assistants.presets[0].model).toBeUndefined()
      expect(migrated.assistants.presets[0].defaultModel).toBeUndefined()
      expect(migrated.assistants.presets[1].model).toEqual(openaiModel)
      // legacy agents: g1 platform-owned -> cleared
      expect(migrated.agents.agents[0].model).toBeUndefined()
      expect(migrated.agents.agents[0].defaultModel).toBeUndefined()
    })

    it('is a no-op for state without platform content', async () => {
      const state = {
        llm: {
          providers: [{ id: 'openai', name: 'OpenAI', type: 'openai', apiKey: 'k', apiHost: '', models: [] }],
          defaultModel: openaiModel,
          quickModel: openaiModel,
          translateModel: openaiModel,
          settings: { ollama: { keepAliveTime: 0 } }
        },
        assistants: {
          defaultAssistant: { model: openaiModel },
          assistants: [{ id: 'a1', model: openaiModel }]
        },
        _persist: { version: 216, rehydrated: false }
      }
      const migrated: any = await migrate(state as any, 217)
      expect(migrated.llm.providers).toHaveLength(1)
      expect(migrated.llm.defaultModel).toEqual(openaiModel)
      expect(migrated.llm.quickModel).toEqual(openaiModel)
      expect(migrated.llm.translateModel).toEqual(openaiModel)
      expect(migrated.assistants.assistants[0].model).toEqual(openaiModel)
    })

    describe('migration 217: scrub platform-owned persisted MCP branding', () => {
      const makeMCPState = (servers: unknown[]) => ({
        llm: { providers: [], settings: {} },
        assistants: { defaultAssistant: {}, assistants: [] },
        mcp: { servers },
        _persist: { version: 216, rehydrated: false }
      })

      it('removes provider: CherryAI and docs.cherry-ai.com reference while preserving other server data', async () => {
        const server = {
          id: 's1',
          name: '@cherry/mcp-auto-install',
          type: 'inMemory',
          command: 'npx',
          args: ['-y', '@mcpmarket/mcp-auto-install'],
          isActive: true,
          provider: 'CherryAI',
          reference: 'https://docs.cherry-ai.com/advanced-basic/mcp/auto-install',
          installSource: 'builtin',
          isTrusted: true
        }
        const migrated: any = await migrate(makeMCPState([server]) as any, 217)
        const out = migrated.mcp.servers[0]
        expect(out.provider).toBeUndefined()
        expect(out.reference).toBeUndefined()
        // All non-branding server data is preserved.
        expect(out.id).toBe('s1')
        expect(out.name).toBe('@cherry/mcp-auto-install')
        expect(out.type).toBe('inMemory')
        expect(out.command).toBe('npx')
        expect(out.args).toEqual(['-y', '@mcpmarket/mcp-auto-install'])
        expect(out.isActive).toBe(true)
        expect(out.installSource).toBe('builtin')
        expect(out.isTrusted).toBe(true)
      })

      it('preserves non-platform provider and reference values', async () => {
        const servers = [
          { id: 's1', name: 'flomo', provider: 'flomo', reference: 'https://flomoapp.com', isActive: false },
          { id: 's2', name: 'memory', provider: 'Nowledge', reference: 'https://mem.nowledge.co/', isActive: true }
        ]
        const migrated: any = await migrate(makeMCPState(servers) as any, 217)
        expect(migrated.mcp.servers).toEqual(servers)
      })

      it('removes only the platform-owned field when the other is not platform-owned', async () => {
        const providerOnly = {
          id: 's1',
          name: 'fetch',
          provider: 'CherryAI',
          reference: 'https://github.com/example',
          isActive: true
        }
        const referenceOnly = {
          id: 's2',
          name: 'custom',
          provider: 'ModelScope',
          reference: 'https://docs.cherry-ai.com/advanced-basic/mcp/auto-install',
          isActive: false
        }
        const migrated: any = await migrate(makeMCPState([providerOnly, referenceOnly]) as any, 217)
        expect(migrated.mcp.servers[0].provider).toBeUndefined()
        expect(migrated.mcp.servers[0].reference).toBe('https://github.com/example')
        expect(migrated.mcp.servers[1].provider).toBe('ModelScope')
        expect(migrated.mcp.servers[1].reference).toBeUndefined()
      })

      it('is a no-op for state without platform MCP branding', async () => {
        const servers = [
          { id: 's1', name: 'flomo', provider: 'flomo', reference: 'https://flomoapp.com', isActive: false }
        ]
        const migrated: any = await migrate(makeMCPState(servers) as any, 217)
        expect(migrated.mcp.servers).toEqual(servers)
      })

      it('is idempotent: re-running 217 over an already-migrated MCP state is stable', async () => {
        const server = {
          id: 's1',
          name: '@cherry/mcp-auto-install',
          type: 'inMemory',
          isActive: true,
          provider: 'CherryAI',
          reference: 'https://docs.cherry-ai.com/advanced-basic/mcp/auto-install',
          installSource: 'builtin',
          isTrusted: true
        }
        const first: any = await migrate(makeMCPState([server]) as any, 217)
        const second: any = await migrate(structuredClone(first), 217)
        expect(second.mcp.servers).toEqual(first.mcp.servers)
        expect(second.mcp.servers[0].provider).toBeUndefined()
        expect(second.mcp.servers[0].reference).toBeUndefined()
      })

      it('removes provider only when exactly CherryAI (case-sensitive)', async () => {
        const servers = [
          { id: 's1', name: 'x', provider: 'Cherryai', reference: 'https://other.example.com', isActive: false }
        ]
        const migrated: any = await migrate(makeMCPState(servers) as any, 217)
        expect(migrated.mcp.servers[0].provider).toBe('Cherryai')
        expect(migrated.mcp.servers[0].reference).toBe('https://other.example.com')
      })

      it('removes reference only when it points at the exact docs.cherry-ai.com hostname', async () => {
        const servers = [
          {
            id: 's1',
            name: 'lookalike',
            provider: 'ModelScope',
            reference: 'https://docs.cherry-ai.com.evil.example/x',
            isActive: false
          },
          { id: 's2', name: 'plain', provider: 'ModelScope', reference: 'docs.cherry-ai.com/plain', isActive: false }
        ]
        const migrated: any = await migrate(makeMCPState(servers) as any, 217)
        expect(migrated.mcp.servers[0].reference).toBe('https://docs.cherry-ai.com.evil.example/x')
        expect(migrated.mcp.servers[1].reference).toBe('docs.cherry-ai.com/plain')
      })
    })
  })

  describe('migration 218: quick-settings consolidation cleanup', () => {
    const makeState = (settings: Record<string, any> = {}) => ({
      settings,
      _persist: { version: 217, rehydrated: false }
    })

    const legacySettings = {
      messageFont: 'serif',
      showInputEstimatedTokens: true,
      autoTranslateWithSpace: true,
      mathEngine: 'MathJax',
      mathEnableSingleDollar: false,
      messageStyle: 'plain',
      codeExecution: { enabled: true, timeoutMinutes: 5 },
      codeEditor: { enabled: true },
      codeShowLineNumbers: false,
      codeCollapsible: false,
      codeWrappable: true,
      codeImageTools: true,
      codeFancyBlock: false,
      gridColumns: 4,
      gridPopoverTrigger: 'hover',
      multiModelMessageStyle: 'grid',
      messageNavigation: 'buttons',
      fontSize: 14,
      showPrompt: true
    }

    it('removes all obsolete preference fields', async () => {
      const migrated: any = await migrate(makeState({ ...legacySettings }) as any, 218)

      const settings = migrated.settings
      expect(settings.messageFont).toBeUndefined()
      expect(settings.showInputEstimatedTokens).toBeUndefined()
      expect(settings.autoTranslateWithSpace).toBeUndefined()
      expect(settings.mathEngine).toBeUndefined()
      expect(settings.mathEnableSingleDollar).toBeUndefined()
      expect(settings.messageStyle).toBeUndefined()
      expect(settings.codeExecution).toBeUndefined()
      expect(settings.codeEditor).toBeUndefined()
      expect(settings.codeShowLineNumbers).toBeUndefined()
      expect(settings.codeCollapsible).toBeUndefined()
      expect(settings.codeWrappable).toBeUndefined()
      expect(settings.codeImageTools).toBeUndefined()
      expect(settings.codeFancyBlock).toBeUndefined()
      expect(settings.gridColumns).toBeUndefined()
      expect(settings.gridPopoverTrigger).toBeUndefined()
      expect(settings.multiModelMessageStyle).toBeUndefined()
      // Unrelated settings are preserved
      expect(settings.fontSize).toBe(14)
      expect(settings.showPrompt).toBe(true)
    })

    it('maps legacy navigation buttons/anchor to true and none to false', async () => {
      const buttons: any = await migrate(makeState({ messageNavigation: 'buttons' }) as any, 218)
      expect(buttons.settings.messageNavigation).toBe(true)

      const anchor: any = await migrate(makeState({ messageNavigation: 'anchor' }) as any, 218)
      expect(anchor.settings.messageNavigation).toBe(true)

      const none: any = await migrate(makeState({ messageNavigation: 'none' }) as any, 218)
      expect(none.settings.messageNavigation).toBe(false)
    })

    it('defaults missing navigation to false', async () => {
      const migrated: any = await migrate(makeState({}) as any, 218)
      expect(migrated.settings.messageNavigation).toBe(false)
    })

    it('preserves an already-boolean navigation unchanged', async () => {
      const migrated: any = await migrate(makeState({ messageNavigation: true }) as any, 218)
      expect(migrated.settings.messageNavigation).toBe(true)
    })

    it('is a no-op for state without settings', async () => {
      const state = { _persist: { version: 217, rehydrated: false } }
      const migrated: any = await migrate(state as any, 218)
      expect(migrated.settings).toBeUndefined()
    })
  })

  describe('migration 219: contextWindowAnchor → contextStartOverride rename', () => {
    const anchor = { kind: 'active', groupKey: 'u1' } as const
    const override = { kind: 'active', groupKey: 'u7' } as const
    const makeState = (
      assistants: Array<Record<string, any>>,
      defaultAssistant: Record<string, any> = { settings: { contextCount: 5 } }
    ) => ({
      assistants: {
        defaultAssistant,
        assistants
      },
      _persist: { version: 218, rehydrated: false }
    })

    it('renames the legacy field for the default assistant and regular assistants', async () => {
      const state = makeState([{ settings: { contextCount: 5, contextWindowAnchor: { topicA: anchor } } }], {
        settings: { contextCount: 5, contextWindowAnchor: { topicA: anchor, topicB: override } }
      })
      const migrated: any = await migrate(state as any, 219)

      expect(migrated.assistants.defaultAssistant.settings.contextStartOverride).toEqual({
        topicA: anchor,
        topicB: override
      })
      expect(migrated.assistants.defaultAssistant.settings.contextWindowAnchor).toBeUndefined()
      expect(migrated.assistants.assistants[0].settings.contextStartOverride).toEqual({ topicA: anchor })
      expect(migrated.assistants.assistants[0].settings.contextWindowAnchor).toBeUndefined()
    })

    it('preserves the override map verbatim (no reshaping of entries)', async () => {
      const state = makeState([
        { settings: { contextCount: 5, contextWindowAnchor: { topicA: anchor, topicC: undefined } } }
      ])
      const migrated: any = await migrate(state as any, 219)
      const overrides = migrated.assistants.assistants[0].settings.contextStartOverride
      expect(overrides.topicA).toEqual(anchor)
      expect('topicC' in overrides).toBe(true)
      expect(overrides.topicC).toBeUndefined()
    })

    it('deletes the legacy key', async () => {
      const state = makeState([{ settings: { contextCount: 5, contextWindowAnchor: { topicA: anchor } } }])
      const migrated: any = await migrate(state as any, 219)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextWindowAnchor).toBeUndefined()
      expect(settings.contextStartOverride).toEqual({ topicA: anchor })
    })

    it('for both-fields states the target wins per topic and legacy fills missing topics', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            // legacy has topicA and topicB; target has topicB (newer) and topicC
            contextWindowAnchor: { topicA: anchor, topicB: anchor },
            contextStartOverride: { topicB: override, topicC: override }
          }
        }
      ])
      const migrated: any = await migrate(state as any, 219)
      const overrides = migrated.assistants.assistants[0].settings.contextStartOverride
      expect(overrides.topicA).toEqual(anchor) // filled from legacy (missing in target)
      expect(overrides.topicB).toEqual(override) // target wins per topic
      expect(overrides.topicC).toEqual(override) // target-only topic preserved
    })

    it('does not create a target field when neither legacy nor target state exists', async () => {
      const state = makeState([{ settings: { contextCount: 5 } }])
      const migrated: any = await migrate(state as any, 219)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextStartOverride).toBeUndefined()
      expect(settings.contextWindowAnchor).toBeUndefined()
    })

    it('handles assistants without settings gracefully', async () => {
      const state = makeState([{}])
      const migrated: any = await migrate(state as any, 219)
      expect(migrated.assistants.assistants[0].settings).toBeUndefined()
    })

    it('is idempotent: re-running 219 over an already-migrated state is stable', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            contextWindowAnchor: { topicA: anchor, topicB: anchor },
            contextStartOverride: { topicB: override }
          }
        }
      ])

      const first: any = await migrate(structuredClone(state) as any, 219)
      const second: any = await migrate(structuredClone(first), 219)

      expect(second).toEqual(first)
      const overrides = second.assistants.assistants[0].settings.contextStartOverride
      expect(overrides.topicA).toEqual(anchor)
      expect(overrides.topicB).toEqual(override)
      expect(second.assistants.assistants[0].settings.contextWindowAnchor).toBeUndefined()
    })

    it('migrates the default assistant settings too', async () => {
      const state = makeState([], {
        settings: { contextCount: 5, contextWindowAnchor: { topicA: anchor } }
      })
      const migrated: any = await migrate(state as any, 219)
      expect(migrated.assistants.defaultAssistant.settings.contextStartOverride).toEqual({ topicA: anchor })
      expect(migrated.assistants.defaultAssistant.settings.contextWindowAnchor).toBeUndefined()
    })

    it('215 → 219 chain: legacy fixedWindowAnchor flows through 216 into contextStartOverride', async () => {
      // The full historical chain: 216 converts fixedWindowAnchor →
      // contextWindowAnchor (effectively-fixed only), 217 removes platform
      // state, 218 cleans quick-settings fields, 219 renames to
      // contextStartOverride.
      const anchor216 = { kind: 'active', groupKey: 'u9' } as const
      const state = {
        assistants: {
          defaultAssistant: {
            settings: {
              contextCount: 0,
              contextWindowMode: 'fixed',
              topicContextWindowMode: { topicA: 'fixed' },
              fixedWindowAnchor: { topicA: anchor216 }
            }
          },
          assistants: [{ settings: { contextCount: 5 } }]
        },
        llm: { providers: [], settings: {} },
        settings: {},
        _persist: { version: 215, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 219)

      const defaultSettings = migrated.assistants.defaultAssistant.settings
      // 216: contextCount 0 → 1; effectively-fixed anchor retained.
      expect(defaultSettings.contextCount).toBe(1)
      expect(defaultSettings.fixedWindowAnchor).toBeUndefined()
      expect(defaultSettings.contextWindowMode).toBeUndefined()
      // 219: renamed to override terminology.
      expect(defaultSettings.contextWindowAnchor).toBeUndefined()
      expect(defaultSettings.contextStartOverride.topicA).toEqual(anchor216)
      // Regular assistant: 216 historically emits an EMPTY contextWindowAnchor
      // for every assistant with settings (its historical contract, kept
      // unchanged), which 219 preserves verbatim as an empty override map.
      expect(migrated.assistants.assistants[0].settings.contextStartOverride).toEqual({})
      expect(migrated.assistants.assistants[0].settings.contextWindowAnchor).toBeUndefined()
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(5)
      // 218: quick-settings cleanup ran on the settings slice.
      expect(migrated.settings.messageNavigation).toBe(false)
    })
  })

  describe('migration 220: contextStartOverride → contextWindowAnchor (stable anchor)', () => {
    const anchor = { kind: 'active', groupKey: 'u1' } as const
    const override = { kind: 'active', groupKey: 'u7' } as const
    const makeState = (
      assistants: Array<Record<string, any>>,
      defaultAssistant: Record<string, any> = { settings: { contextCount: 5 } }
    ) => ({
      assistants: {
        defaultAssistant,
        assistants
      },
      _persist: { version: 219, rehydrated: false }
    })

    it('renames the legacy field for the default assistant and regular assistants', async () => {
      const state = makeState([{ settings: { contextCount: 5, contextStartOverride: { topicA: anchor } } }], {
        settings: { contextCount: 5, contextStartOverride: { topicA: anchor, topicB: override } }
      })
      const migrated: any = await migrate(state as any, 220)

      expect(migrated.assistants.defaultAssistant.settings.contextWindowAnchor).toEqual({
        topicA: anchor,
        topicB: override
      })
      expect(migrated.assistants.defaultAssistant.settings.contextStartOverride).toBeUndefined()
      expect(migrated.assistants.assistants[0].settings.contextWindowAnchor).toEqual({ topicA: anchor })
      expect(migrated.assistants.assistants[0].settings.contextStartOverride).toBeUndefined()
    })

    it('preserves the anchor map verbatim (no reshaping of entries)', async () => {
      const state = makeState([
        { settings: { contextCount: 5, contextStartOverride: { topicA: anchor, topicC: undefined } } }
      ])
      const migrated: any = await migrate(state as any, 220)
      const anchors = migrated.assistants.assistants[0].settings.contextWindowAnchor
      expect(anchors.topicA).toEqual(anchor)
      expect('topicC' in anchors).toBe(true)
      expect(anchors.topicC).toBeUndefined()
    })

    it('deletes the legacy key', async () => {
      const state = makeState([{ settings: { contextCount: 5, contextStartOverride: { topicA: anchor } } }])
      const migrated: any = await migrate(state as any, 220)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextStartOverride).toBeUndefined()
      expect(settings.contextWindowAnchor).toEqual({ topicA: anchor })
    })

    it('for both-fields states the target wins per topic and legacy fills missing topics', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            // legacy has topicA and topicB; target has topicB (newer) and topicC
            contextStartOverride: { topicA: anchor, topicB: anchor },
            contextWindowAnchor: { topicB: override, topicC: override }
          }
        }
      ])
      const migrated: any = await migrate(state as any, 220)
      const anchors = migrated.assistants.assistants[0].settings.contextWindowAnchor
      expect(anchors.topicA).toEqual(anchor) // filled from legacy (missing in target)
      expect(anchors.topicB).toEqual(override) // target wins per topic
      expect(anchors.topicC).toEqual(override) // target-only topic preserved
    })

    it('does not create a target field when neither legacy nor target state exists', async () => {
      const state = makeState([{ settings: { contextCount: 5 } }])
      const migrated: any = await migrate(state as any, 220)
      const settings = migrated.assistants.assistants[0].settings
      expect(settings.contextWindowAnchor).toBeUndefined()
      expect(settings.contextStartOverride).toBeUndefined()
    })

    it('handles assistants without settings gracefully', async () => {
      const state = makeState([{}])
      const migrated: any = await migrate(state as any, 220)
      expect(migrated.assistants.assistants[0].settings).toBeUndefined()
    })

    it('is idempotent: re-running 220 over an already-migrated state is stable', async () => {
      const state = makeState([
        {
          settings: {
            contextCount: 5,
            contextStartOverride: { topicA: anchor, topicB: anchor },
            contextWindowAnchor: { topicB: override }
          }
        }
      ])

      const first: any = await migrate(structuredClone(state) as any, 220)
      const second: any = await migrate(structuredClone(first), 220)

      expect(second).toEqual(first)
      const anchors = second.assistants.assistants[0].settings.contextWindowAnchor
      expect(anchors.topicA).toEqual(anchor)
      expect(anchors.topicB).toEqual(override)
      expect(second.assistants.assistants[0].settings.contextStartOverride).toBeUndefined()
    })

    it('migrates the default assistant settings too', async () => {
      const state = makeState([], {
        settings: { contextCount: 5, contextStartOverride: { topicA: anchor } }
      })
      const migrated: any = await migrate(state as any, 220)
      expect(migrated.assistants.defaultAssistant.settings.contextWindowAnchor).toEqual({ topicA: anchor })
      expect(migrated.assistants.defaultAssistant.settings.contextStartOverride).toBeUndefined()
    })

    it('218 → 220 chain: 219 rename round-trips into the stable contextWindowAnchor field', async () => {
      // 219 historically renamed contextWindowAnchor → contextStartOverride;
      // 220 renames back. All anchor values survive the round trip unchanged.
      const anchor219 = { kind: 'active', groupKey: 'u5' } as const
      const state = {
        assistants: {
          defaultAssistant: { settings: { contextCount: 5, contextWindowAnchor: { topicA: anchor219 } } },
          assistants: [{ settings: { contextCount: 5, contextWindowAnchor: { topicA: anchor219 } } }]
        },
        _persist: { version: 218, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 220)

      expect(migrated.assistants.defaultAssistant.settings.contextWindowAnchor).toEqual({ topicA: anchor219 })
      expect(migrated.assistants.defaultAssistant.settings.contextStartOverride).toBeUndefined()
      expect(migrated.assistants.assistants[0].settings.contextWindowAnchor).toEqual({ topicA: anchor219 })
      expect(migrated.assistants.assistants[0].settings.contextStartOverride).toBeUndefined()
    })

    it('215 → 220 chain: legacy fixedWindowAnchor flows through 216/219/220 into contextWindowAnchor', async () => {
      // The full historical chain: 216 converts fixedWindowAnchor →
      // contextWindowAnchor (effectively-fixed only), 219 renames to
      // contextStartOverride, 220 renames back to contextWindowAnchor. Anchor
      // values are preserved end-to-end.
      const anchor216 = { kind: 'active', groupKey: 'u9' } as const
      const state = {
        assistants: {
          defaultAssistant: {
            settings: {
              contextCount: 0,
              contextWindowMode: 'fixed',
              topicContextWindowMode: { topicA: 'fixed' },
              fixedWindowAnchor: { topicA: anchor216 }
            }
          },
          assistants: [{ settings: { contextCount: 5 } }]
        },
        llm: { providers: [], settings: {} },
        settings: {},
        _persist: { version: 215, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 220)

      const defaultSettings = migrated.assistants.defaultAssistant.settings
      // 216: contextCount 0 → 1; effectively-fixed anchor retained.
      expect(defaultSettings.contextCount).toBe(1)
      expect(defaultSettings.fixedWindowAnchor).toBeUndefined()
      expect(defaultSettings.contextWindowMode).toBeUndefined()
      // 219 → 220: field evolution round-trips; the anchor value is preserved.
      expect(defaultSettings.contextStartOverride).toBeUndefined()
      expect(defaultSettings.contextWindowAnchor.topicA).toEqual(anchor216)
      // Regular assistant: 216 historically emits an EMPTY contextWindowAnchor
      // for every assistant with settings, which 219/220 preserve verbatim.
      expect(migrated.assistants.assistants[0].settings.contextWindowAnchor).toEqual({})
      expect(migrated.assistants.assistants[0].settings.contextStartOverride).toBeUndefined()
      expect(migrated.assistants.assistants[0].settings.contextCount).toBe(5)
      // 218: quick-settings cleanup ran on the settings slice.
      expect(migrated.settings.messageNavigation).toBe(false)
    })
  })

  describe('migration 221: custom-connection bootstrap conversion', () => {
    const sysOpenai = (overrides: Record<string, unknown> = {}) => ({
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      apiKey: '',
      apiHost: 'https://api.openai.com',
      models: [],
      isSystem: true,
      enabled: false,
      ...overrides
    })
    const unknownModel = (provider: string, id = 'my-renamed-unknown-1') => ({
      id,
      name: id,
      provider,
      group: provider
    })

    const makeState = (state: Record<string, unknown>) => ({
      llm: { providers: [], settings: {}, ...(state.llm as Record<string, unknown>) },
      assistants: {
        defaultAssistant: {},
        assistants: [],
        ...(state.assistants as Record<string, unknown>)
      },
      ...(state.memory ? { memory: state.memory } : {}),
      ...(state.agents ? { agents: state.agents } : {}),
      ...(state.websearch ? { websearch: state.websearch } : {}),
      ...(state.knowledge ? { knowledge: state.knowledge } : {}),
      _persist: { version: 220, rehydrated: false }
    })

    it('converts a configured compatible system provider to an ordinary user provider, preserving everything', async () => {
      const models = [unknownModel('openai')]
      const state = makeState({
        llm: {
          providers: [
            sysOpenai({ apiKey: 'sk-live', enabled: true, models }),
            // Unmistakably untouched stock copy: dropped.
            { ...SYSTEM_PROVIDERS_CONFIG.deepseek }
          ],
          defaultModel: unknownModel('openai')
        },
        assistants: {
          defaultAssistant: {},
          assistants: [{ id: 'a1', model: unknownModel('openai') }]
        }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers).toHaveLength(1)
      const kept = migrated.llm.providers[0]
      expect(kept.id).toBe('openai')
      expect(kept.isSystem).toBe(false)
      expect(kept.apiKey).toBe('sk-live')
      expect(kept.apiHost).toBe('https://api.openai.com')
      expect(kept.enabled).toBe(true)
      expect(kept.models).toEqual(models)
      // Live model references are never substituted or defaulted.
      expect(migrated.llm.defaultModel).toEqual(unknownModel('openai'))
      expect(migrated.assistants.assistants[0].model).toEqual(unknownModel('openai'))
    })

    it('drops no-key built-ins even when enabled, referenced, or modified, clearing orphaned refs', async () => {
      const state = makeState({
        llm: {
          providers: [
            // Enabled but keyless.
            sysOpenai({ id: 'anthropic', name: 'Anthropic', type: 'anthropic', enabled: true }),
            // Referenced by a live slot but keyless.
            sysOpenai({ id: 'gemini', name: 'Gemini', type: 'gemini' }),
            // Materially customized (custom host + user models) but keyless.
            sysOpenai({
              id: 'deepseek',
              name: 'DeepSeek',
              apiHost: 'https://proxy.example.com/v1',
              models: [unknownModel('deepseek')]
            })
          ],
          quickModel: unknownModel('gemini')
        },
        assistants: {
          defaultAssistant: {},
          assistants: [{ id: 'a1', model: unknownModel('deepseek') }]
        }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers).toEqual([])
      // Orphaned live references are cleared (never repointed).
      expect(migrated.llm.quickModel).toBeUndefined()
      expect(migrated.assistants.assistants[0].model).toBeUndefined()
    })

    it('treats whitespace-only keys as no-key and keeps effectively keyed built-ins', async () => {
      const state = makeState({
        llm: {
          providers: [
            sysOpenai({ id: 'openai', apiKey: '   ', enabled: true }),
            sysOpenai({ id: 'anthropic', name: 'Anthropic', type: 'anthropic', apiKey: 'sk-live' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers.map((p: { id: string }) => p.id)).toEqual(['anthropic'])
      expect(migrated.llm.providers[0].isSystem).toBe(false)
      expect(migrated.llm.providers[0].apiKey).toBe('sk-live')
    })

    it('preserves ordinary custom no-key connections (including local) verbatim', async () => {
      const localModels = [unknownModel('ollama')]
      const state = makeState({
        llm: {
          providers: [
            {
              id: 'ollama',
              name: 'Ollama',
              type: 'openai',
              apiKey: '',
              apiHost: 'http://localhost:11434/v1',
              models: localModels,
              isSystem: false,
              enabled: true
            },
            {
              id: 'my-remote',
              name: 'My Remote',
              type: 'openai',
              apiKey: '',
              apiHost: 'https://remote.example.com/v1',
              models: [],
              isSystem: false,
              enabled: false
            },
            // No-key built-in for contrast: dropped.
            sysOpenai({ id: 'openai', enabled: true })
          ],
          defaultModel: unknownModel('ollama')
        }
      })
      const migrated: any = await migrate(state as any, 221)

      const ids = migrated.llm.providers.map((p: { id: string }) => p.id).sort()
      expect(ids).toEqual(['my-remote', 'ollama'])
      const ollama = migrated.llm.providers.find((p: { id: string }) => p.id === 'ollama')
      expect(ollama).toMatchObject({
        apiKey: '',
        apiHost: 'http://localhost:11434/v1',
        isSystem: false,
        enabled: true
      })
      expect(ollama.models).toEqual(localModels)
      expect(migrated.llm.defaultModel).toEqual(unknownModel('ollama'))
    })

    it('drops only unmistakably untouched catalog copies and unreferenced legacy adapters without substitution', async () => {
      const openaiModel = unknownModel('openai')
      const state = makeState({
        llm: {
          providers: [
            sysOpenai({ apiKey: 'k', enabled: true, models: [openaiModel] }),
            // Unmistakably untouched stock copy: deep-equal to the built-in config.
            { ...SYSTEM_PROVIDERS_CONFIG.deepseek },
            {
              id: 'azure-openai',
              name: 'Azure OpenAI',
              type: 'azure-openai',
              apiKey: '',
              models: [],
              isSystem: true,
              enabled: false
            }
          ],
          defaultModel: openaiModel
        }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers.map((p: { id: string }) => p.id)).toEqual(['openai'])
      expect(migrated.llm.defaultModel).toEqual(openaiModel)
    })

    it('drops keyless customized compatible providers (custom host/headers are not a key)', async () => {
      const state = makeState({
        llm: {
          providers: [
            sysOpenai({
              apiHost: 'https://proxy.example.com/v1',
              apiVersion: '2024-01-01',
              extra_headers: { 'X-Custom': '1' },
              notes: 'my notes',
              rateLimit: 5
            }),
            // Unmistakably untouched stock copy for contrast: dropped.
            { ...SYSTEM_PROVIDERS_CONFIG.moonshot }
          ]
        }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers).toEqual([])
    })

    it('drops keyless built-ins referenced by websearch compression and knowledge base models, clearing refs', async () => {
      // Entries below are unmistakably untouched stock copies (no key,
      // disabled) — live references no longer keep them. This proves the
      // key gate applies to referenced providers too, and orphaned refs are
      // cleared instead of dangling.
      const embedding = unknownModel('silicon', 'emb-1')
      const rerank = unknownModel('zhipu', 're-1')
      const kbModel = unknownModel('dashscope', 'kb-1')
      const kbRerank = unknownModel('dashscope', 'kb-re-1')
      const state = makeState({
        llm: {
          providers: [
            { ...SYSTEM_PROVIDERS_CONFIG.silicon },
            { ...SYSTEM_PROVIDERS_CONFIG.zhipu },
            { ...SYSTEM_PROVIDERS_CONFIG.dashscope },
            { ...SYSTEM_PROVIDERS_CONFIG.deepseek }
          ]
        },
        websearch: {
          compressionConfig: { method: 'rag', embeddingModel: embedding, rerankModel: rerank }
        },
        knowledge: {
          bases: [{ id: 'b1', model: kbModel, rerankModel: kbRerank }]
        }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers).toEqual([])
      expect(migrated.websearch.compressionConfig.embeddingModel).toBeUndefined()
      expect(migrated.websearch.compressionConfig.rerankModel).toBeUndefined()
      expect(migrated.knowledge.bases[0].model).toBeUndefined()
      expect(migrated.knowledge.bases[0].rerankModel).toBeUndefined()
    })

    it('retains a referenced legacy adapter verbatim instead of orphaning the reference', async () => {
      const azureModel = { id: 'my-deploy', name: 'my-deploy', provider: 'azure-openai', group: 'azure' }
      const state = makeState({
        llm: {
          providers: [
            sysOpenai({ apiKey: 'k', enabled: true }),
            {
              id: 'azure-openai',
              name: 'Azure OpenAI',
              type: 'azure-openai',
              apiKey: 'azure-key',
              apiHost: 'https://my-azure.example.com',
              models: [azureModel],
              isSystem: true,
              enabled: true
            }
          ]
        },
        assistants: {
          defaultAssistant: {},
          assistants: [{ id: 'a1', model: azureModel }]
        }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers.map((p: { id: string }) => p.id).sort()).toEqual(['azure-openai', 'openai'])
      const azure = migrated.llm.providers.find((p: { id: string }) => p.id === 'azure-openai')
      expect(azure.apiKey).toBe('azure-key')
      expect(azure.apiHost).toBe('https://my-azure.example.com')
      expect(azure.models).toEqual([azureModel])
      expect(migrated.assistants.assistants[0].model).toEqual(azureModel)
    })

    it('drops a keyless referenced legacy adapter and clears the orphaned reference', async () => {
      const azureModel = { id: 'my-deploy', name: 'my-deploy', provider: 'azure-openai', group: 'azure' }
      const state = makeState({
        llm: {
          providers: [
            {
              id: 'azure-openai',
              name: 'Azure OpenAI',
              type: 'azure-openai',
              apiKey: '',
              apiHost: 'https://my-azure.example.com',
              models: [azureModel],
              isSystem: true,
              enabled: true
            }
          ]
        },
        assistants: {
          defaultAssistant: {},
          assistants: [{ id: 'a1', model: azureModel }]
        }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers).toEqual([])
      expect(migrated.assistants.assistants[0].model).toBeUndefined()
    })

    it('preserves ordinary custom providers and memory model references verbatim', async () => {
      const customModels = [unknownModel('my-gateway')]
      const state = makeState({
        llm: {
          providers: [
            {
              id: 'my-gateway',
              name: 'My Gateway',
              type: 'openai',
              apiKey: 'gw-key',
              apiHost: 'https://gw.example.com',
              models: customModels,
              isSystem: false,
              enabled: true
            }
          ]
        },
        memory: { memoryConfig: { llmModel: unknownModel('my-gateway'), embeddingModel: undefined } }
      })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers).toHaveLength(1)
      expect(migrated.llm.providers[0]).toMatchObject({
        id: 'my-gateway',
        apiKey: 'gw-key',
        apiHost: 'https://gw.example.com',
        isSystem: false,
        enabled: true
      })
      expect(migrated.llm.providers[0].models).toEqual(customModels)
      expect(migrated.memory.memoryConfig.llmModel).toEqual(unknownModel('my-gateway'))
    })

    it('never re-adds missing system providers and injects no default model', async () => {
      const state = makeState({ llm: { providers: [] } })
      const migrated: any = await migrate(state as any, 221)

      expect(migrated.llm.providers).toEqual([])
      expect(migrated.llm.defaultModel).toBeUndefined()
    })
  })

  describe('migration 222: active-protocol consolidation', () => {
    const approved = (overrides: Record<string, unknown> = {}) => ({
      id: 'custom-openai',
      name: 'Custom OpenAI',
      type: 'openai',
      apiKey: 'k',
      apiHost: 'https://proxy.example.com/v1',
      models: [],
      isSystem: false,
      enabled: true,
      ...overrides
    })
    const legacyEntry = (id: string, type: string, overrides: Record<string, unknown> = {}) => ({
      id,
      name: id,
      type,
      apiKey: `${id}-key`,
      apiHost: 'https://legacy.example.com',
      models: [{ id: `${id}-model`, name: `${id}-model`, provider: id, group: id }],
      isSystem: true,
      enabled: true,
      ...overrides
    })
    const refTo = (provider: string, id = `model-of-${provider}`) => ({
      id,
      name: id,
      provider,
      group: provider
    })

    const makeState = (state: Record<string, unknown>) => ({
      llm: {
        providers: [],
        settings: {},
        ...(state.llm as Record<string, unknown>)
      },
      assistants: {
        defaultAssistant: {},
        assistants: [],
        ...(state.assistants as Record<string, unknown>)
      },
      ...(state.memory ? { memory: state.memory } : {}),
      ...(state.agents ? { agents: state.agents } : {}),
      ...(state.websearch ? { websearch: state.websearch } : {}),
      ...(state.knowledge ? { knowledge: state.knowledge } : {}),
      ...(state.mcp ? { mcp: state.mcp } : {}),
      ...(state.settings ? { settings: state.settings } : {}),
      ...(state.copilot ? { copilot: state.copilot } : {}),
      _persist: { version: 221, rehydrated: false }
    })

    it('folds ollama/new-api/mistral to openai preserving ids, config, models, and refs', async () => {
      const ollamaModels = [refTo('ollama', 'llama3.1')]
      const newApiModels = [refTo('new-api', 'gpt-4')]
      const mistralModels = [refTo('mistral', 'mistral-large')]
      const state = makeState({
        llm: {
          providers: [
            legacyEntry('ollama', 'ollama', { apiHost: 'http://localhost:11434', models: ollamaModels }),
            legacyEntry('new-api', 'new-api', {
              apiHost: 'http://localhost:3000/v1',
              apiVersion: '2024-01-01',
              extra_headers: { 'X-Custom': '1' },
              notes: 'keep me',
              models: newApiModels
            }),
            legacyEntry('mistral', 'mistral', {
              apiHost: 'https://api.mistral.ai',
              apiKey: 'mistral-key',
              models: mistralModels
            })
          ],
          defaultModel: refTo('ollama', 'llama3.1'),
          quickModel: refTo('mistral', 'mistral-large')
        },
        assistants: {
          defaultAssistant: { model: refTo('new-api', 'gpt-4') },
          assistants: [{ id: 'a1', model: refTo('ollama', 'llama3.1') }]
        }
      })
      const migrated: any = await migrate(state as any, 222)

      expect(migrated.llm.providers).toHaveLength(3)
      for (const p of migrated.llm.providers) {
        expect(p.type).toBe('openai')
        expect(p.isSystem).toBe(false)
      }
      const byId = Object.fromEntries(migrated.llm.providers.map((p: any) => [p.id, p]))
      // Full config preserved; ids stable so every model.provider ref stays valid.
      expect(byId.ollama.apiKey).toBe('ollama-key')
      expect(byId.ollama.models).toEqual(ollamaModels)
      expect(byId['new-api'].apiVersion).toBe('2024-01-01')
      expect(byId['new-api'].extra_headers).toEqual({ 'X-Custom': '1' })
      expect(byId['new-api'].notes).toBe('keep me')
      expect(byId['new-api'].models).toEqual(newApiModels)
      expect(byId.mistral.apiKey).toBe('mistral-key')
      expect(byId.mistral.models).toEqual(mistralModels)
      // Folded ids are not removed, so live refs are untouched (never cleared, never repointed).
      expect(migrated.llm.defaultModel).toEqual(refTo('ollama', 'llama3.1'))
      expect(migrated.llm.quickModel).toEqual(refTo('mistral', 'mistral-large'))
      expect(migrated.assistants.defaultAssistant.model).toEqual(refTo('new-api', 'gpt-4'))
      expect(migrated.assistants.assistants[0].model).toEqual(refTo('ollama', 'llama3.1'))
    })

    it('normalizes bare Ollama hosts to OpenAI-compatible /v1 idempotently', async () => {
      const state = makeState({
        llm: {
          providers: [
            legacyEntry('ollama-bare', 'ollama', { apiHost: 'http://localhost:11434' }),
            legacyEntry('ollama-slash', 'ollama', { apiHost: 'http://localhost:11434/' }),
            legacyEntry('ollama-versioned', 'ollama', { apiHost: 'http://localhost:11434/v1' }),
            legacyEntry('ollama-path', 'ollama', { apiHost: 'https://proxy.example.com/openai' }),
            legacyEntry('ollama-sharp', 'ollama', { apiHost: 'https://proxy.example.com#' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 222)

      const byId = Object.fromEntries(migrated.llm.providers.map((p: any) => [p.id, p]))
      expect(byId['ollama-bare'].apiHost).toBe('http://localhost:11434/v1')
      expect(byId['ollama-slash'].apiHost).toBe('http://localhost:11434/v1')
      expect(byId['ollama-versioned'].apiHost).toBe('http://localhost:11434/v1')
      expect(byId['ollama-path'].apiHost).toBe('https://proxy.example.com/openai/v1')
      expect(byId['ollama-sharp'].apiHost).toBe('https://proxy.example.com')
    })

    it('strips Ollama-native /api|/chat suffixes only for folded ollama entries', async () => {
      const state = makeState({
        llm: {
          providers: [
            legacyEntry('ollama-api', 'ollama', { apiHost: 'http://localhost:11434/api' }),
            legacyEntry('ollama-api-slash', 'ollama', { apiHost: 'http://localhost:11434/api/' }),
            legacyEntry('ollama-chat', 'ollama', { apiHost: 'http://localhost:11434/chat' }),
            legacyEntry('ollama-versioned-slash', 'ollama', { apiHost: 'http://localhost:11434/v1/' }),
            legacyEntry('ollama-versioned-api', 'ollama', { apiHost: 'http://localhost:11434/v1/api' }),
            // Same suffixes on mistral/new-api custom paths are intentional and
            // must be preserved (generic /v1 append only, no stripping).
            legacyEntry('mistral-api', 'mistral', { apiHost: 'https://proxy.example.com/api' }),
            legacyEntry('new-api-chat', 'new-api', { apiHost: 'https://proxy.example.com/chat' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 222)

      const byId = Object.fromEntries(migrated.llm.providers.map((p: any) => [p.id, p]))
      expect(byId['ollama-api'].apiHost).toBe('http://localhost:11434/v1')
      expect(byId['ollama-api-slash'].apiHost).toBe('http://localhost:11434/v1')
      expect(byId['ollama-chat'].apiHost).toBe('http://localhost:11434/v1')
      expect(byId['ollama-versioned-slash'].apiHost).toBe('http://localhost:11434/v1')
      expect(byId['ollama-versioned-api'].apiHost).toBe('http://localhost:11434/v1')
      expect(byId['mistral-api'].apiHost).toBe('https://proxy.example.com/api/v1')
      expect(byId['new-api-chat'].apiHost).toBe('https://proxy.example.com/chat/v1')
    })

    it('normalizes empty/whitespace/root hosts to empty and keeps versioned query hosts intact', async () => {
      const state = makeState({
        llm: {
          providers: [
            legacyEntry('ollama-blank', 'ollama', { apiHost: '   ' }),
            legacyEntry('ollama-root', 'ollama', { apiHost: '/' }),
            legacyEntry('ollama-empty', 'ollama', { apiHost: '' }),
            legacyEntry('ollama-query-version', 'ollama', { apiHost: 'http://localhost:11434/v1?token=abc' }),
            legacyEntry('ollama-schemeless', 'ollama', { apiHost: 'localhost:11434' }),
            legacyEntry('new-api-blank', 'new-api', { apiHost: '  ' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 222)

      const byId = Object.fromEntries(migrated.llm.providers.map((p: any) => [p.id, p]))
      expect(byId['ollama-blank'].apiHost).toBe('')
      expect(byId['ollama-root'].apiHost).toBe('')
      expect(byId['ollama-empty'].apiHost).toBe('')
      // Version detected in the URL pathname: no /v1 appended, query preserved.
      expect(byId['ollama-query-version'].apiHost).toBe('http://localhost:11434/v1?token=abc')
      // Scheme-less but otherwise usable hosts still get the generic append.
      expect(byId['ollama-schemeless'].apiHost).toBe('localhost:11434/v1')
      expect(byId['new-api-blank'].apiHost).toBe('')
    })

    it('removes every retired and unknown type while keeping approved protocols verbatim', async () => {
      const state = makeState({
        llm: {
          providers: [
            approved({ id: 'keep-openai', type: 'openai' }),
            approved({ id: 'keep-response', type: 'openai-response' }),
            approved({ id: 'keep-anthropic', type: 'anthropic' }),
            approved({ id: 'keep-gemini', type: 'gemini' }),
            legacyEntry('azure-openai', 'azure-openai'),
            legacyEntry('vertexai', 'vertexai'),
            legacyEntry('vertex-claude', 'vertex-anthropic'),
            legacyEntry('aws-bedrock', 'aws-bedrock'),
            legacyEntry('gateway', 'gateway'),
            legacyEntry('mystery', 'some-future-protocol')
          ]
        }
      })
      const migrated: any = await migrate(state as any, 222)

      expect(migrated.llm.providers.map((p: any) => p.id).sort()).toEqual([
        'keep-anthropic',
        'keep-gemini',
        'keep-openai',
        'keep-response'
      ])
      // Approved entries pass through with every field verbatim.
      expect(migrated.llm.providers.find((p: any) => p.id === 'keep-openai')).toMatchObject({
        type: 'openai',
        isSystem: false,
        apiKey: 'k',
        apiHost: 'https://proxy.example.com/v1'
      })
    })

    it('clears every live reference family to removed providers to undefined without repointing', async () => {
      const azureModel = refTo('azure-openai', 'my-deploy')
      const vertexModel = refTo('vertexai', 'gemini-2.5-pro')
      const bedrockModel = refTo('aws-bedrock', 'claude-sonnet')
      const gatewayModel = refTo('gateway', 'openai/gpt-4')
      const keptModel = refTo('keep-openai', 'kept-1')
      const state = makeState({
        llm: {
          providers: [
            approved({ id: 'keep-openai', type: 'openai' }),
            legacyEntry('azure-openai', 'azure-openai'),
            legacyEntry('vertexai', 'vertexai'),
            legacyEntry('aws-bedrock', 'aws-bedrock'),
            legacyEntry('gateway', 'gateway')
          ],
          defaultModel: azureModel,
          topicNamingModel: vertexModel,
          quickModel: keptModel,
          translateModel: bedrockModel
        },
        assistants: {
          defaultAssistant: { model: gatewayModel, defaultModel: keptModel },
          assistants: [
            { id: 'a1', model: azureModel, defaultModel: vertexModel },
            { id: 'a2', model: keptModel, settings: { reasoning_effort: 'high' } }
          ],
          presets: [
            { id: 'p1', model: bedrockModel, defaultModel: gatewayModel },
            { id: 'p2', model: keptModel }
          ]
        },
        agents: {
          agents: [{ id: 'ag1', model: azureModel, defaultModel: keptModel }]
        },
        memory: {
          memoryConfig: { llmModel: vertexModel, embeddingModel: keptModel }
        },
        websearch: {
          compressionConfig: { method: 'rag', embeddingModel: bedrockModel, rerankModel: keptModel }
        },
        knowledge: {
          bases: [
            { id: 'b1', model: gatewayModel, rerankModel: keptModel },
            { id: 'b2', model: keptModel }
          ]
        }
      })
      const migrated: any = await migrate(state as any, 222)

      // Removed-provider slots become explicitly unconfigured.
      expect(migrated.llm.defaultModel).toBeUndefined()
      expect(migrated.llm.topicNamingModel).toBeUndefined()
      expect(migrated.llm.translateModel).toBeUndefined()
      expect(migrated.assistants.defaultAssistant.model).toBeUndefined()
      expect(migrated.assistants.assistants[0].model).toBeUndefined()
      expect(migrated.assistants.assistants[0].defaultModel).toBeUndefined()
      expect(migrated.assistants.presets[0].model).toBeUndefined()
      expect(migrated.assistants.presets[0].defaultModel).toBeUndefined()
      expect(migrated.agents.agents[0].model).toBeUndefined()
      expect(migrated.memory.memoryConfig.llmModel).toBeUndefined()
      expect(migrated.websearch.compressionConfig.embeddingModel).toBeUndefined()
      expect(migrated.knowledge.bases[0].model).toBeUndefined()
      // Kept-provider slots are never substituted or defaulted.
      expect(migrated.llm.quickModel).toEqual(keptModel)
      expect(migrated.assistants.defaultAssistant.defaultModel).toEqual(keptModel)
      expect(migrated.assistants.assistants[1].model).toEqual(keptModel)
      expect(migrated.assistants.presets[1].model).toEqual(keptModel)
      expect(migrated.agents.agents[0].defaultModel).toEqual(keptModel)
      expect(migrated.memory.memoryConfig.embeddingModel).toEqual(keptModel)
      expect(migrated.websearch.compressionConfig.rerankModel).toEqual(keptModel)
      expect(migrated.knowledge.bases[0].rerankModel).toEqual(keptModel)
      expect(migrated.knowledge.bases[1].model).toEqual(keptModel)
      // Reasoning-effort configuration is historical data, never a live ref: preserved.
      expect(migrated.assistants.assistants[1].settings.reasoning_effort).toBe('high')
    })

    it('preserves historical snapshot-like fields while clearing live refs', async () => {
      const azureModel = refTo('azure-openai', 'my-deploy')
      const state = makeState({
        llm: {
          providers: [approved({ id: 'keep-openai' }), legacyEntry('azure-openai', 'azure-openai')],
          defaultModel: azureModel
        },
        assistants: {
          defaultAssistant: {},
          assistants: [
            {
              id: 'a1',
              model: azureModel,
              // Historical per-topic anchor map and message snapshots are data, not live refs.
              settings: { contextWindowAnchor: { 'topic-1': { kind: 'active', groupKey: 'msg-1' } } },
              topics: [{ id: 'topic-1', messages: [{ id: 'msg-1', model: azureModel }] }]
            }
          ]
        }
      })
      const migrated: any = await migrate(state as any, 222)

      expect(migrated.llm.defaultModel).toBeUndefined()
      expect(migrated.assistants.assistants[0].model).toBeUndefined()
      expect(migrated.assistants.assistants[0].settings.contextWindowAnchor).toEqual({
        'topic-1': { kind: 'active', groupKey: 'msg-1' }
      })
      expect(migrated.assistants.assistants[0].topics[0].messages[0].model).toEqual(azureModel)
    })

    it('deletes vertex/bedrock settings and the persisted copilot slice, leaving other settings intact', async () => {
      const state = makeState({
        llm: {
          providers: [approved({ id: 'keep-openai' })],
          settings: {
            ollama: { keepAliveTime: 5 },
            vertexai: { projectId: 'p', location: 'l' },
            awsBedrock: { region: 'us-east-1' }
          }
        },
        settings: { theme: 'dark' },
        copilot: { defaultHeaders: { Authorization: 'Bearer stale' } }
      })
      const migrated: any = await migrate(state as any, 222)

      expect(migrated.llm.settings).toEqual({ ollama: { keepAliveTime: 5 } })
      expect(migrated.settings).toEqual({ theme: 'dark' })
      expect('copilot' in migrated).toBe(false)
    })

    it('leaves a fresh empty state unchanged and performs no storage side effects', async () => {
      const state = makeState({ llm: { providers: [], settings: {} } })
      const migrated: any = await migrate(state as any, 222)

      expect(migrated.llm.providers).toEqual([])
      expect(migrated.llm.settings).toEqual({})
      expect('copilot' in migrated).toBe(false)
      // No ImageStorage rows or unrelated slices are touched: nothing added, nothing renamed.
      expect(Object.keys(migrated).sort()).toEqual(Object.keys(state).sort())
    })

    it('writes requiresApiKey:false for folded raw ollama while preserving other apiOptions', async () => {
      const state = makeState({
        llm: {
          providers: [
            legacyEntry('ollama', 'ollama', {
              apiHost: 'http://localhost:11434',
              apiOptions: { isNotSupportStreamOptions: true }
            }),
            legacyEntry('new-api', 'new-api', {
              apiHost: 'http://localhost:3000/v1',
              apiOptions: { isNotSupportStreamOptions: true }
            }),
            legacyEntry('mistral', 'mistral', { apiHost: 'https://api.mistral.ai' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 222)

      const byId = Object.fromEntries(migrated.llm.providers.map((p: any) => [p.id, p]))
      expect(byId.ollama.type).toBe('openai')
      expect(byId.ollama.apiOptions).toMatchObject({
        isNotSupportStreamOptions: true,
        requiresApiKey: false
      })
      // new-api/mistral folds keep apiOptions verbatim (no requiresApiKey injected).
      expect(byId['new-api'].apiOptions).toEqual({ isNotSupportStreamOptions: true })
      expect(byId.mistral.apiOptions).toBeUndefined()
    })
  })

  describe('migration 223: local no-key backfill', () => {
    const approved = (overrides: Record<string, unknown> = {}) => ({
      id: 'custom-openai',
      name: 'Custom OpenAI',
      type: 'openai',
      apiKey: '',
      apiHost: 'https://proxy.example.com/v1',
      models: [],
      isSystem: false,
      enabled: true,
      ...overrides
    })
    const makeState223 = (state: Record<string, unknown>) => ({
      llm: { providers: [], settings: {}, ...(state.llm as Record<string, unknown>) },
      assistants: { defaultAssistant: {}, assistants: [], ...(state.assistants as Record<string, unknown>) },
      _persist: { version: 222, rehydrated: false }
    })

    it('backfills only conservative local legacy entries', async () => {
      const state = makeState223({
        llm: {
          providers: [
            approved({ id: 'ollama', apiHost: 'http://localhost:11434/v1', apiKey: '' }),
            approved({ id: 'lmstudio', apiHost: 'http://localhost:1234/v1', apiKey: '' }),
            approved({ id: 'gpustack', apiHost: '', apiKey: '' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 223)

      for (const p of migrated.llm.providers) {
        expect(p.apiOptions).toMatchObject({ requiresApiKey: false })
      }
    })

    it('leaves remote keyless custom endpoints requiring a key unless the user opts out', async () => {
      const state = makeState223({
        llm: {
          providers: [
            approved({ id: 'my-remote', apiHost: 'https://proxy.example.com/v1', apiKey: '' }),
            approved({
              id: 'ollama',
              apiHost: 'https://remote.example.com/v1',
              apiKey: ''
            }),
            approved({
              id: 'lmstudio',
              apiHost: 'http://localhost:1234/v1',
              apiKey: 'k',
              apiOptions: { requiresApiKey: true }
            }),
            approved({
              id: 'gpustack',
              apiHost: '',
              apiKey: '',
              apiOptions: { requiresApiKey: false }
            })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 223)

      const byId = Object.fromEntries(migrated.llm.providers.map((p: any) => [p.id, p.apiOptions?.requiresApiKey]))
      // Remote custom + remote-host legacy id + already-set entries stay untouched.
      expect(byId['my-remote']).toBeUndefined()
      expect(migrated.llm.providers.find((p: any) => p.id === 'ollama').apiOptions).toBeUndefined()
      expect(byId['lmstudio']).toBe(true)
      expect(byId['gpustack']).toBe(false)
    })

    it('rejects substring, suffix, query, and userinfo localhost lookalikes', async () => {
      const state = makeState223({
        llm: {
          providers: [
            approved({ id: 'ollama', apiHost: 'http://notlocalhost.example/v1', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'https://localhost.evil.example.com/v1', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'http://127.0.0.1.evil.com:11434/v1', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'https://proxy.example.com/v1?next=localhost', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'https://proxy.example.com/?host=127.0.0.1', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'http://user:localhost@proxy.example.com/v1', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'http://localhost:token@proxy.example.com/v1', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'http://proxy.example.com/localhost', apiKey: '' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 223)

      for (const p of migrated.llm.providers) {
        expect(p.apiOptions).toBeUndefined()
      }
    })

    it('accepts valid local variants, ports, and scheme-less forms', async () => {
      const state = makeState223({
        llm: {
          providers: [
            approved({ id: 'ollama', apiHost: 'http://LOCALHOST:11434/v1', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'http://127.0.0.1:8080', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'http://0.0.0.0:11434/v1', apiKey: '' }),
            approved({ id: 'ollama', apiHost: 'http://[::1]:11434/v1', apiKey: '' }),
            approved({ id: 'lmstudio', apiHost: 'localhost:1234', apiKey: '' }),
            approved({ id: 'lmstudio', apiHost: '127.0.0.1:1234/v1', apiKey: '' }),
            approved({ id: 'gpustack', apiHost: 'localhost', apiKey: '' }),
            approved({ id: 'gpustack', apiHost: '  http://localhost:11434/v1  ', apiKey: '' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 223)

      for (const p of migrated.llm.providers) {
        expect(p.apiOptions).toMatchObject({ requiresApiKey: false })
      }
    })
    it('preserves other apiOptions and historical snapshots', async () => {
      const snapshotModel = { id: 'm1', name: 'm1', provider: 'ollama', group: 'ollama' }
      const state = makeState223({
        llm: {
          providers: [
            approved({
              id: 'ollama',
              apiHost: 'http://127.0.0.1:11434/v1',
              apiKey: '',
              apiOptions: { isNotSupportStreamOptions: true }
            })
          ]
        },
        assistants: {
          defaultAssistant: {},
          assistants: [{ id: 'a1', topics: [{ id: 't1', messages: [{ id: 'm1', model: snapshotModel }] }] }]
        }
      })
      const migrated: any = await migrate(state as any, 223)

      expect(migrated.llm.providers[0].apiOptions).toMatchObject({
        isNotSupportStreamOptions: true,
        requiresApiKey: false
      })
      expect(migrated.assistants.assistants[0].topics[0].messages[0].model).toEqual(snapshotModel)
    })
  })

  describe('migration 224: serviceTier and local-thinking capability backfills', () => {
    const approved224 = (overrides: Record<string, unknown> = {}) => ({
      id: 'custom-openai',
      name: 'Custom OpenAI',
      type: 'openai',
      apiKey: '',
      apiHost: 'https://proxy.example.com/v1',
      models: [],
      isSystem: false,
      enabled: true,
      ...overrides
    })
    const makeState224 = (state: Record<string, unknown>) => ({
      llm: { providers: [], settings: {}, ...(state.llm as Record<string, unknown>) },
      assistants: { defaultAssistant: {}, assistants: [], ...(state.assistants as Record<string, unknown>) },
      _persist: { version: 223, rehydrated: false }
    })

    it('opts in serviceTier capability only when a tier is configured and the flag is unset', async () => {
      const state = makeState224({
        llm: {
          providers: [
            approved224({ id: 'openai', serviceTier: 'auto' }),
            approved224({ id: 'custom-a', serviceTier: 'flex' }),
            approved224({ id: 'no-tier' }),
            approved224({ id: 'null-tier', serviceTier: null }),
            approved224({ id: 'empty-tier', serviceTier: '' }),
            approved224({ id: 'blank-tier', serviceTier: '   ' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 224)

      const byId = Object.fromEntries(migrated.llm.providers.map((p: any) => [p.id, p]))
      expect(byId['openai'].apiOptions).toMatchObject({ isSupportServiceTier: true })
      expect(byId['custom-a'].apiOptions).toMatchObject({ isSupportServiceTier: true })
      // No brand id needed: custom ids opt in the same way.
      expect(byId['no-tier'].apiOptions).toBeUndefined()
      // Null (explicitly off) and empty/blank tiers are not genuinely configured: never backfilled.
      expect(byId['null-tier'].apiOptions?.isSupportServiceTier).toBeUndefined()
      expect(byId['empty-tier'].apiOptions?.isSupportServiceTier).toBeUndefined()
      expect(byId['blank-tier'].apiOptions?.isSupportServiceTier).toBeUndefined()
    })

    it('preserves explicit serviceTier flags and all other apiOptions', async () => {
      const state = makeState224({
        llm: {
          providers: [
            approved224({
              id: 'explicit-false',
              serviceTier: 'auto',
              apiOptions: { isSupportServiceTier: false, isNotSupportStreamOptions: true }
            }),
            approved224({
              id: 'explicit-true',
              serviceTier: 'auto',
              apiOptions: { isSupportServiceTier: true, requiresApiKey: false }
            })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 224)

      const byId = Object.fromEntries(migrated.llm.providers.map((p: any) => [p.id, p]))
      expect(byId['explicit-false'].apiOptions).toMatchObject({
        isSupportServiceTier: false,
        isNotSupportStreamOptions: true
      })
      expect(byId['explicit-true'].apiOptions).toMatchObject({
        isSupportServiceTier: true,
        requiresApiKey: false
      })
    })

    it('backfills local soft-switch only for conservative local legacy entries', async () => {
      const state = makeState224({
        llm: {
          providers: [
            approved224({ id: 'ollama', apiHost: 'http://localhost:11434/v1', apiKey: '' }),
            approved224({ id: 'lmstudio', apiHost: 'http://127.0.0.1:1234/v1', apiKey: '' }),
            approved224({ id: 'gpustack', apiHost: '', apiKey: '' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 224)

      for (const p of migrated.llm.providers) {
        expect(p.apiOptions).toMatchObject({ isNotSupportEnableThinking: true })
      }
    })

    it('preserves explicit thinking flags and avoids remote false positives', async () => {
      const state = makeState224({
        llm: {
          providers: [
            approved224({
              id: 'ollama',
              apiHost: 'http://localhost:11434/v1',
              apiKey: '',
              apiOptions: { isNotSupportEnableThinking: false }
            }),
            approved224({
              id: 'lmstudio',
              apiHost: 'http://127.0.0.1:1234/v1',
              apiKey: '',
              apiOptions: { isNotSupportEnableThinking: true }
            }),
            // Remote host with legacy id: untouched.
            approved224({ id: 'ollama', apiHost: 'https://remote.example.com/v1', apiKey: '' }),
            // Local host with non-legacy id: untouched.
            approved224({ id: 'my-remote', apiHost: 'http://localhost:11434/v1', apiKey: '' }),
            // Keyed local legacy entry: untouched.
            approved224({ id: 'ollama', apiHost: 'http://localhost:11434/v1', apiKey: 'k' }),
            // OAuth local legacy entry: untouched.
            approved224({ id: 'ollama', apiHost: 'http://localhost:11434/v1', apiKey: '', authType: 'oauth' }),
            // Non-openai protocol with legacy id: untouched.
            approved224({ id: 'ollama', type: 'anthropic', apiHost: 'http://localhost:11434/v1', apiKey: '' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 224)

      const byId = Object.fromEntries(
        migrated.llm.providers.map((p: any) => [p.id + '|' + p.apiHost + '|' + p.type, p])
      )
      const localFalse = migrated.llm.providers[0]
      const localTrue = migrated.llm.providers[1]
      expect(localFalse.apiOptions).toMatchObject({ isNotSupportEnableThinking: false })
      expect(localTrue.apiOptions).toMatchObject({ isNotSupportEnableThinking: true })
      for (const p of migrated.llm.providers.slice(2)) {
        expect(p.apiOptions?.isNotSupportEnableThinking).toBeUndefined()
      }
      expect(byId).toBeDefined()
    })

    it('combines both backfills, preserves other fields, and leaves snapshots untouched', async () => {
      const snapshotModel = { id: 'm1', name: 'm1', provider: 'ollama', group: 'ollama' }
      const before = approved224({
        id: 'ollama',
        name: 'Ollama',
        type: 'openai',
        apiKey: '',
        apiHost: 'http://127.0.0.1:11434/v1',
        serviceTier: 'auto',
        models: [snapshotModel],
        enabled: true,
        apiOptions: { isNotSupportStreamOptions: true }
      })
      const state = makeState224({
        llm: { providers: [before] },
        assistants: {
          defaultAssistant: {},
          assistants: [{ id: 'a1', topics: [{ id: 't1', messages: [{ id: 'm1', model: snapshotModel }] }] }]
        }
      })
      const migrated: any = await migrate(state as any, 224)

      const p = migrated.llm.providers[0]
      expect(p.apiOptions).toMatchObject({
        isSupportServiceTier: true,
        isNotSupportEnableThinking: true,
        isNotSupportStreamOptions: true
      })
      // Identity and connection fields untouched.
      expect(p.id).toBe('ollama')
      expect(p.type).toBe('openai')
      expect(p.apiHost).toBe('http://127.0.0.1:11434/v1')
      expect(p.apiKey).toBe('')
      expect(p.models).toEqual([snapshotModel])
      expect(migrated.assistants.assistants[0].topics[0].messages[0].model).toEqual(snapshotModel)
    })

    it('recovers options/plugin behavior from migrated flags', async () => {
      const { isSupportServiceTierProvider, isSupportEnableThinkingProvider } = await import('@renderer/utils/provider')
      const state = makeState224({
        llm: {
          providers: [
            approved224({ id: 'openai', serviceTier: 'auto' }),
            approved224({ id: 'ollama', apiHost: 'http://localhost:11434/v1', apiKey: '' })
          ]
        }
      })
      const migrated: any = await migrate(state as any, 224)

      const tiered = migrated.llm.providers.find((p: any) => p.id === 'openai')
      const local = migrated.llm.providers.find((p: any) => p.id === 'ollama')
      // Service-tier opt-in enables tiered requests; local soft-switch routes
      // Qwen thinking through the plugin path.
      expect(isSupportServiceTierProvider(tiered)).toBe(true)
      expect(isSupportEnableThinkingProvider(local)).toBe(false)
    })
  })

  describe('migration 226: strip removed MCP/websearch/memory without losing history', () => {
    it('drops removed slices/assistant fields/tool keys while keeping urlContext/knowledge/history', async () => {
      const state = {
        mcp: { servers: [{ id: 's1' }] },
        memory: { memoryConfig: {} },
        websearch: { providers: [{ id: 'tavily' }] },
        assistants: {
          assistants: [
            {
              id: 'a1',
              enableWebSearch: true,
              webSearchProviderId: 'tavily',
              mcpMode: 'manual',
              mcpServers: [{ id: 's1' }],
              enableMemory: true,
              enableUrlContext: true,
              knowledge_bases: [{ id: 'kb1' }]
            }
          ],
          assistantDefaults: {
            enableWebSearch: true,
            mcpMode: 'auto',
            enableMemory: true,
            enableUrlContext: true
          },
          defaultAssistant: {
            enableWebSearch: true,
            mcpServers: [],
            enableMemory: true
          }
        },
        inputTools: {
          toolOrder: {
            visible: ['new_topic', 'web_search', 'url_context', 'mcp_tools'],
            hidden: ['web_search']
          }
        },
        llm: { providers: [] },
        _persist: { version: 225, rehydrated: false }
      }

      const migrated: any = await migrate(state as any, 226)

      expect(migrated.mcp).toBeUndefined()
      expect(migrated.memory).toBeUndefined()
      expect(migrated.websearch).toBeUndefined()
      for (const a of migrated.assistants.assistants) {
        expect(a.enableWebSearch).toBeUndefined()
        expect(a.webSearchProviderId).toBeUndefined()
        expect(a.mcpMode).toBeUndefined()
        expect(a.mcpServers).toBeUndefined()
        expect(a.enableMemory).toBeUndefined()
        expect(a.enableUrlContext).toBe(true)
        expect(a.knowledge_bases).toEqual([{ id: 'kb1' }])
      }
      expect(migrated.assistants.assistantDefaults.enableUrlContext).toBe(true)
      expect(migrated.assistants.assistantDefaults.enableWebSearch).toBeUndefined()
      expect(migrated.inputTools.toolOrder.visible).toEqual(['new_topic', 'url_context'])
      expect(migrated.inputTools.toolOrder.hidden).toEqual([])
    })
  })

  describe('migration 227: terminal OCR slice scrub (full OCR removal)', () => {
    const makeState = () => ({
      ocr: {
        providers: [
          { id: 'tesseract', name: 'Tesseract', capabilities: { image: true }, config: {} },
          { id: 'system', name: 'System', capabilities: { image: true }, config: {} }
        ],
        imageProviderId: 'system'
      },
      mcp: { servers: [{ id: 's1' }] },
      memory: { memoryConfig: {} },
      websearch: { providers: [{ id: 'tavily' }] },
      preprocess: {
        providers: [{ id: 'mineru', name: 'MinerU', apiKey: '', apiHost: 'https://mineru.net' }],
        defaultProvider: 'mineru'
      },
      assistants: {
        assistants: [
          {
            id: 'a1',
            enableWebSearch: true,
            mcpServers: [{ id: 's1' }],
            enableMemory: true,
            enableUrlContext: true,
            knowledge_bases: [{ id: 'kb1' }]
          }
        ],
        assistantDefaults: { enableUrlContext: true, enableMemory: true }
      },
      knowledge: { bases: [{ id: 'kb1' }] },
      inputTools: {
        toolOrder: {
          visible: ['new_topic', 'web_search', 'url_context', 'mcp_tools'],
          hidden: []
        }
      },
      llm: { providers: [] },
      _persist: { version: 226, rehydrated: false }
    })

    it('deletes the ocr slice terminally', async () => {
      const migrated: any = await migrate(makeState() as any, 227)
      expect(migrated.ocr).toBeUndefined()
    })

    it('retains the 226 scrubs and keeps preprocess/urlContext/knowledge', async () => {
      const migrated: any = await migrate(makeState() as any, 227)
      expect(migrated.mcp).toBeUndefined()
      expect(migrated.memory).toBeUndefined()
      expect(migrated.websearch).toBeUndefined()
      expect(migrated.assistants.assistants[0].enableWebSearch).toBeUndefined()
      expect(migrated.assistants.assistants[0].mcpServers).toBeUndefined()
      expect(migrated.assistants.assistants[0].enableMemory).toBeUndefined()
      expect(migrated.assistants.assistants[0].enableUrlContext).toBe(true)
      expect(migrated.assistants.assistants[0].knowledge_bases).toEqual([{ id: 'kb1' }])
      expect(migrated.assistants.assistantDefaults.enableUrlContext).toBe(true)
      expect(migrated.preprocess.providers.map((p: { id: string }) => p.id)).toContain('mineru')
      expect(migrated.preprocess.defaultProvider).toBe('mineru')
      expect(migrated.knowledge.bases).toEqual([{ id: 'kb1' }])
      expect(migrated.inputTools.toolOrder.visible).toEqual(['new_topic', 'url_context'])
    })

    it('137 → 227 full chain: legacy ocr shape is rebuilt then cleared', async () => {
      const state = {
        translate: {},
        assistants: { assistants: [], assistantDefaults: { enableUrlContext: true } },
        llm: { providers: [], settings: {} },
        settings: {},
        inputTools: { toolOrder: { visible: ['url_context'], hidden: [] } },
        _persist: { version: 136, rehydrated: false }
      }
      const migrated: any = await migrate(state as any, 227)
      expect(migrated.ocr).toBeUndefined()
      expect(migrated.assistants.assistantDefaults.enableUrlContext).toBe(true)
    })

    it('is a no-op for state without an ocr slice', async () => {
      const state = {
        assistants: { assistants: [], assistantDefaults: {} },
        llm: { providers: [] },
        _persist: { version: 226, rehydrated: false }
      }
      const migrated: any = await migrate(state as any, 227)
      expect(migrated.ocr).toBeUndefined()
      expect(migrated.llm.providers).toEqual([])
    })
  })

  describe('migration 228: export options terminal state + note-app connection scrub', () => {
    const removedSettingsKeys = [
      'notionDatabaseID',
      'notionApiKey',
      'notionPageNameKey',
      'notionExportReasoning',
      'yuqueToken',
      'yuqueUrl',
      'yuqueRepoId',
      'joplinToken',
      'joplinUrl',
      'joplinExportReasoning',
      'defaultObsidianVault',
      'siyuanApiUrl',
      'siyuanToken',
      'siyuanBoxId',
      'siyuanRootPath'
    ]
    const retiredExportKeys = [
      'markdownExportPath',
      'forceDollarMathInMarkdown',
      'useTopicNamingForMessageTitle',
      'showModelNameInMarkdown',
      'showModelProviderInMarkdown'
    ]

    const makeState = () => ({
      settings: {
        notionDatabaseID: 'db-secret',
        notionApiKey: 'secret-notion',
        notionPageNameKey: 'Title',
        markdownExportPath: '/tmp/export',
        forceDollarMathInMarkdown: true,
        useTopicNamingForMessageTitle: true,
        showModelNameInMarkdown: true,
        showModelProviderInMarkdown: true,
        thoughtAutoCollapse: false,
        notionExportReasoning: true,
        excludeCitationsInExport: true,
        standardizeCitationsInExport: true,
        yuqueToken: 'secret-yuque',
        yuqueUrl: 'https://yuque.example/repo',
        yuqueRepoId: '4242',
        joplinToken: 'secret-joplin',
        joplinUrl: 'http://localhost:41184',
        joplinExportReasoning: true,
        defaultObsidianVault: '/Users/someone/Vault',
        defaultAgent: 'assistant-1',
        siyuanApiUrl: 'http://127.0.0.1:6806',
        siyuanToken: 'secret-siyuan',
        siyuanBoxId: 'box-1',
        siyuanRootPath: '/Notebook',
        localBackupDir: '/tmp/backup',
        s3: { endpoint: 'https://s3.example', bucket: 'chat' },
        exportMenuOptions: {
          image: false,
          markdown: true,
          markdown_reason: false,
          notion: false,
          yuque: true,
          joplin: true,
          obsidian: false,
          siyuan: true,
          docx: true,
          plain_text: false,
          notes: true
        },
        unknownFutureKey: { keep: 'me' }
      },
      llm: { providers: [{ id: 'openai', apiKey: 'provider-secret' }], settings: { mode: 'custom' } },
      assistants: { assistants: [{ id: 'assistant-1', name: 'A' }], assistantDefaults: { temperature: 0.7 } },
      topicBranches: { byId: { b1: { id: 'b1', topicId: 't1' } } },
      nutstore: {
        nutstoreToken: 'secret-nutstore-token',
        nutstorePath: '/cherry-chat',
        nutstoreAutoSync: true,
        nutstoreSyncInterval: 30,
        nutstoreSyncState: { lastSyncTime: 1, syncing: false, lastSyncError: null },
        nutstoreSkipBackupFile: false,
        nutstoreMaxBackups: 5
      },
      _persist: { version: 227, rehydrated: false }
    })

    it('carries the old Markdown directory over into the shared export directory', async () => {
      const migrated: any = await migrate(makeState() as any, 228)

      expect(migrated.settings.exportPath).toBe('/tmp/export')
      for (const key of retiredExportKeys) {
        expect(migrated.settings[key], key).toBeUndefined()
      }
      // The per-format menu toggles are gone together with their container: the
      // export menu is always available, so no flag may gate it anymore.
      expect(migrated.settings.exportMenuOptions).toBeUndefined()
    })

    it('writes exportIncludeThinking false explicitly, including when the field never existed', async () => {
      const migrated: any = await migrate(makeState() as any, 228)
      expect(migrated.settings.exportIncludeThinking).toBe(false)

      // A persisted slice is replaced wholesale on rehydrate, so a state without
      // the key must still receive the explicit default.
      const withoutKey = { settings: { thoughtAutoCollapse: false }, _persist: { version: 227 } }
      const migratedWithoutKey: any = await migrate(withoutKey as any, 228)
      expect(migratedWithoutKey.settings.exportIncludeThinking).toBe(false)
    })

    it('keeps an already-present export directory and tolerates missing/empty values', async () => {
      const already = {
        settings: { exportPath: '/already/set', markdownExportPath: '/tmp/export' },
        _persist: { version: 227 }
      }
      const migrated: any = await migrate(already as any, 228)
      expect(migrated.settings.exportPath).toBe('/already/set')

      for (const markdownExportPath of [undefined, '', null]) {
        const state = { settings: { markdownExportPath }, _persist: { version: 227 } }
        const result: any = await migrate(state as any, 228)
        expect(result.settings.exportPath).toBeNull()
      }
    })

    it('deletes only the retired settings and keeps everything else', async () => {
      const migrated: any = await migrate(makeState() as any, 228)

      for (const key of removedSettingsKeys) {
        expect(migrated.settings[key], key).toBeUndefined()
      }
      // Retained unrelated settings, defaults, and unknown keys pass through.
      expect(migrated.settings.thoughtAutoCollapse).toBe(false)
      expect(migrated.settings.excludeCitationsInExport).toBe(true)
      expect(migrated.settings.standardizeCitationsInExport).toBe(true)
      expect(migrated.settings.defaultAgent).toBe('assistant-1')
      expect(migrated.settings.localBackupDir).toBe('/tmp/backup')
      expect(migrated.settings.s3).toEqual({ endpoint: 'https://s3.example', bucket: 'chat' })
      expect(migrated.settings.unknownFutureKey).toEqual({ keep: 'me' })

      // Chat-adjacent authority slices are untouched.
      expect(migrated.llm).toEqual({
        providers: [{ id: 'openai', apiKey: 'provider-secret' }],
        settings: { mode: 'custom' }
      })
      expect(migrated.assistants).toEqual({
        assistants: [{ id: 'assistant-1', name: 'A' }],
        assistantDefaults: { temperature: 0.7 }
      })
      expect(migrated.topicBranches).toEqual({ byId: { b1: { id: 'b1', topicId: 't1' } } })
      // The retired Nutstore slice is dropped wholesale (token included).
      expect(migrated.nutstore).toBeUndefined()
    })

    it('is idempotent and creates nothing on a second pass', async () => {
      const once: any = await migrate(makeState() as any, 228)
      const twice: any = await migrate(once, 228)
      expect(twice).toEqual(once)
      expect(twice.settings.exportMenuOptions).toBeUndefined()
      expect(twice.settings.exportPath).toBe('/tmp/export')
    })

    it('tolerates missing, empty, and null settings/options without creating values', async () => {
      const noSettings: any = await migrate({ llm: { providers: [] }, _persist: { version: 227 } } as any, 228)
      expect(noSettings.settings).toBeUndefined()

      const emptySettings: any = await migrate({ settings: {}, _persist: { version: 227 } } as any, 228)
      expect(emptySettings.settings).toEqual({ exportPath: null, exportIncludeThinking: false })

      const nullSettings: any = await migrate({ settings: null, _persist: { version: 227 } } as any, 228)
      expect(nullSettings.settings).toBeNull()

      const nullOptions: any = await migrate(
        { settings: { exportMenuOptions: null, siyuanToken: 'secret' }, _persist: { version: 227 } } as any,
        228
      )
      expect(nullOptions.settings.exportMenuOptions).toBeUndefined()
      expect(nullOptions.settings.siyuanToken).toBeUndefined()

      // createMigrate short-circuits a null/undefined root state; 228 must not throw.
      const nullState: any = await migrate(null as any, 228)
      expect(nullState).toBeUndefined()
    })

    it('replays the historic export-menu default from 93 without sharing one mutable object', async () => {
      const historicKeys = ['docx', 'image', 'markdown', 'markdown_reason', 'plain_text']

      const at93: any = await migrate({ settings: {}, _persist: { version: 92 } } as any, 93)
      expect(Object.keys(at93.settings.exportMenuOptions).sort()).toEqual(historicKeys)
      for (const key of historicKeys) {
        expect(at93.settings.exportMenuOptions[key], key).toBe(true)
      }

      // Mutating one run's seeded object must not leak into the next run: the
      // removed slice no longer owns these literals.
      at93.settings.exportMenuOptions.image = false
      delete at93.settings.exportMenuOptions.docx

      const secondRun: any = await migrate({ settings: {}, _persist: { version: 92 } } as any, 93)
      expect(Object.keys(secondRun.settings.exportMenuOptions).sort()).toEqual(historicKeys)
      expect(secondRun.settings.exportMenuOptions.image).toBe(true)
    })

    it('backfills only the missing plain_text flag at 114', async () => {
      const missing = {
        settings: { exportMenuOptions: { image: true, markdown: true, markdown_reason: true, docx: true } },
        _persist: { version: 113 }
      }
      const filled: any = await migrate(missing as any, 114)
      expect(filled.settings.exportMenuOptions.plain_text).toBe(true)

      const explicit = {
        settings: {
          exportMenuOptions: { image: true, markdown: true, markdown_reason: true, docx: true, plain_text: false }
        },
        _persist: { version: 113 }
      }
      const kept: any = await migrate(explicit as any, 114)
      expect(kept.settings.exportMenuOptions.plain_text).toBe(false)
    })

    it('92 → 228 runs the whole chain and ends without the retired export surface', async () => {
      const state = {
        translate: {},
        assistants: { assistants: [], assistantDefaults: {} },
        llm: { providers: [], settings: {} },
        settings: {},
        inputTools: { toolOrder: { visible: [], hidden: [] } },
        _persist: { version: 92, rehydrated: false }
      }
      const migrated: any = await migrate(state as any, 228)

      expect(migrated.settings.exportMenuOptions).toBeUndefined()
      for (const key of retiredExportKeys) {
        expect(migrated.settings[key], key).toBeUndefined()
      }
      for (const key of removedSettingsKeys) {
        expect(migrated.settings[key], key).toBeUndefined()
      }
      expect(migrated.settings.exportIncludeThinking).toBe(false)
      expect(migrated.settings.exportPath === undefined || migrated.settings.exportPath === null).toBe(true)
    })
  })
})
