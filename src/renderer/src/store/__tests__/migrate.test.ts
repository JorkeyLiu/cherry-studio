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
})
