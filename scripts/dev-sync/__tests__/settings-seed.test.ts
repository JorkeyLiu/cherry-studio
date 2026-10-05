import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildSeedRestoreDispatches,
  DEV_SYNC_SETTINGS_SEED_KIND,
  DEV_SYNC_SETTINGS_SEED_VERSION,
  loadSettingsSeed,
  parseSettingsSeedFile,
  projectSettingsSeed,
  seedFileForLabel,
  summarizeSeedForLog,
  writeSettingsSeedAtomic
} from '../settings-seed'

let owned: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dev-sync-seed-'))
  owned.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true })
  owned = []
})

const SECRET = 'sk-live-provider-secret-value'

function liveStateFixture(): Record<string, unknown> {
  return {
    settings: {
      theme: 'dark',
      fontSize: 15,
      language: 'zh-CN',
      customCss: '.x{}',
      contextWindowAnchor: { 'topic-1': { anchor: 'live-chat-ref' } }
    },
    llm: {
      providers: [
        {
          id: 'openai-custom',
          name: 'Custom',
          apiKey: SECRET,
          apiHost: 'https://api.example.com/v1',
          models: [{ id: 'gpt-x', name: 'GPT X' }],
          enabled: true
        }
      ],
      defaultModel: { id: 'gpt-x', name: 'GPT X' },
      quickModel: { id: 'gpt-x' },
      translateModel: null,
      quickAssistantId: 'assistant-ref-must-drop',
      settings: { ollama: { keepAliveTime: 60 } }
    },
    assistants: {
      assistantDefaults: {
        temperature: 0.7,
        prompt: 'Default prompt.',
        settings: { contextCount: 20, contextWindowAnchor: { 'topic-9': { groupKey: 'stale-anchor' } } },
        content: 'stale translate source text'
      },
      assistants: [
        {
          id: 'a1',
          name: 'Helper',
          prompt: 'Be helpful.',
          type: 'assistant',
          model: { id: 'gpt-x' },
          settings: {
            temperature: 0.5,
            contextCount: 10,
            contextWindowAnchor: { 'topic-1': { groupKey: 'stale-anchor' } }
          },
          content: 'stale translate source text',
          targetLanguage: 'zh-CN',
          topics: [{ id: 't1', name: 'old conversation' }],
          messages: [{ role: 'user', content: 'old content' }],
          knowledge_bases: [{ id: 'kb1', name: 'Secrets', path: '/home/user/docs' }],
          mcpServers: [{ id: 'mcp1', command: 'run', token: 'mcp-secret' }],
          assistantConfigSync: { pending: { x: 1 }, projectionVersions: { x: 2 } }
        }
      ],
      tagsOrder: ['work'],
      collapsedTags: { work: false }
    }
  }
}

describe('projectSettingsSeed', () => {
  it('retains ordinary settings/llm/assistant config but clears live chat refs', () => {
    const projected = projectSettingsSeed(liveStateFixture())
    expect(projected.settings.theme).toBe('dark')
    expect(projected.settings.customCss).toBe('.x{}')
    expect('contextWindowAnchor' in projected.settings).toBe(false)
    expect(projected.assistants.assistants).toHaveLength(1)
    const assistant = projected.assistants.assistants[0]
    expect(assistant.name).toBe('Helper')
    expect(assistant.prompt).toBe('Be helpful.')
    expect(assistant.topics).toEqual([])
  })

  it('drops stale nested anchors and translate source text but retains config', () => {
    const projected = projectSettingsSeed(liveStateFixture())
    const assistant = projected.assistants.assistants[0]
    // Stale translate source text is never seeded.
    expect('content' in assistant).toBe(false)
    expect(JSON.stringify(assistant)).not.toContain('stale translate source text')
    // Nested live refs are stripped; stable config is retained.
    const settings = assistant.settings as Record<string, unknown>
    expect('contextWindowAnchor' in settings).toBe(false)
    expect(settings.contextCount).toBe(10)
    expect(settings.temperature).toBe(0.5)
    // Config that stays: prompt + targetLanguage.
    expect(assistant.prompt).toBe('Be helpful.')
    expect(assistant.targetLanguage).toBe('zh-CN')
    // Default variant: same norm for assistantDefaults.
    const defaults = projected.assistants.assistantDefaults
    expect('content' in defaults).toBe(false)
    const defaultSettings = defaults.settings as Record<string, unknown>
    expect('contextWindowAnchor' in defaultSettings).toBe(false)
    expect(defaultSettings.contextCount).toBe(20)
    expect(defaults.prompt).toBe('Default prompt.')
  })

  it('never seeds content/credential carriers or sync device auth', () => {
    const projected = projectSettingsSeed(liveStateFixture())
    const text = JSON.stringify(projected)
    for (const banned of [
      '"messages"',
      '"knowledge_bases"',
      '"mcpServers"',
      '"content"',
      '"contextWindowAnchor"',
      '"deviceSecret"',
      '"channelId"',
      '"outbox"',
      '"assistantConfigSync"',
      '"token"'
    ]) {
      expect(text).not.toContain(banned)
    }
    // Topics are forced empty, never carried.
    expect(text).not.toContain('old conversation')
    expect(text).not.toContain('old content')
    expect(text).not.toContain('/home/user/docs')
    expect(text).not.toContain('mcp-secret')
  })

  it('retains user-defined providers locally (secrets stay in the owner-only file, never logged)', () => {
    const projected = projectSettingsSeed(liveStateFixture())
    expect(projected.llm.providers).toHaveLength(1)
    expect(projected.llm.providers[0].apiKey).toBe(SECRET)
    expect(projected.llm.defaultModel).toMatchObject({ id: 'gpt-x' })
    expect(projected.llm.quickModel).toMatchObject({ id: 'gpt-x' })
    expect('quickAssistantId' in projected.llm).toBe(false)
  })

  it('fails closed when a store slice is missing (never snapshots half-booted state)', () => {
    expect(() => projectSettingsSeed({})).toThrow(/slice missing/)
    expect(() => projectSettingsSeed({ settings: {}, llm: {} })).toThrow(/assistants slice missing/)
  })
})

describe('parseSettingsSeedFile', () => {
  function validFile(label: 'A' | 'B' = 'A'): Record<string, unknown> {
    const projected = projectSettingsSeed(liveStateFixture())
    return {
      kind: DEV_SYNC_SETTINGS_SEED_KIND,
      version: DEV_SYNC_SETTINGS_SEED_VERSION,
      label,
      updatedAt: new Date().toISOString(),
      ...projected
    }
  }

  it('accepts a well-formed seed and rejects cross-profile application', () => {
    expect(parseSettingsSeedFile(validFile('A'), 'A').label).toBe('A')
    expect(() => parseSettingsSeedFile(validFile('B'), 'A')).toThrow(/label mismatch/)
  })

  it('fails closed on unknown kind/version without echoing secrets', () => {
    const badKind = { ...validFile(), kind: 'other' }
    expect(() => parseSettingsSeedFile(badKind, 'A')).toThrow(/unknown kind/)
    const badVersion = { ...validFile(), version: 99 }
    expect(() => parseSettingsSeedFile(badVersion, 'A')).toThrow(/unknown version/)
    try {
      parseSettingsSeedFile(badVersion, 'A')
      expect.unreachable()
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(SECRET)
    }
  })

  it('refuses seeds carrying topics/content/anchors/credentials', () => {
    const withTopics = validFile()
    ;((withTopics.assistants as Record<string, unknown>).assistants as Array<Record<string, unknown>>)[0].topics = [
      { id: 't9' }
    ]
    expect(() => parseSettingsSeedFile(withTopics, 'A')).toThrow(/must not carry topics/)
    const withAnchor = validFile()
    ;(withAnchor.settings as Record<string, unknown>).contextWindowAnchor = {}
    expect(() => parseSettingsSeedFile(withAnchor, 'A')).toThrow(/live chat refs/)
    const withMessages = validFile()
    ;((withMessages.assistants as Record<string, unknown>).assistants as Array<Record<string, unknown>>)[0].messages =
      []
    expect(() => parseSettingsSeedFile(withMessages, 'A')).toThrow(/must not carry messages/)
  })

  it('rejects unsanitized legacy seeds with nested anchors or translate text', () => {
    const withNestedAnchor = validFile()
    ;(
      (withNestedAnchor.assistants as Record<string, unknown>).assistants as Array<Record<string, unknown>>
    )[0].settings = { contextCount: 10, contextWindowAnchor: { 'topic-1': { groupKey: 'stale' } } }
    expect(() => parseSettingsSeedFile(withNestedAnchor, 'A')).toThrow(/live chat refs/)
    const withContent = validFile()
    ;((withContent.assistants as Record<string, unknown>).assistants as Array<Record<string, unknown>>)[0].content =
      'stale translate source text'
    expect(() => parseSettingsSeedFile(withContent, 'A')).toThrow(/must not carry content/)
    const withDefaultAnchor = validFile()
    ;(withDefaultAnchor.assistants as Record<string, unknown>).assistantDefaults = {
      prompt: 'Default prompt.',
      settings: { contextCount: 20, contextWindowAnchor: { 'topic-9': { groupKey: 'stale' } } }
    }
    expect(() => parseSettingsSeedFile(withDefaultAnchor, 'A')).toThrow(/live chat refs/)
    const withDefaultContent = validFile()
    ;(withDefaultContent.assistants as Record<string, unknown>).assistantDefaults = {
      prompt: 'Default prompt.',
      settings: { contextCount: 20 },
      content: 'stale translate source text'
    }
    expect(() => parseSettingsSeedFile(withDefaultContent, 'A')).toThrow(/must not carry content/)
  })
})

describe('settings seed files', () => {
  it('roundtrips through atomic owner-only writes; absent seed means fresh defaults', () => {
    const dir = makeDir()
    expect(loadSettingsSeed(dir, 'A')).toBeNull()
    const projected = projectSettingsSeed(liveStateFixture())
    const { file, bytes } = writeSettingsSeedAtomic(dir, 'A', projected)
    expect(file).toBe(seedFileForLabel(dir, 'A'))
    expect(bytes).toBeGreaterThan(0)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const loaded = loadSettingsSeed(dir, 'A')
    expect(loaded?.label).toBe('A')
    expect(loaded?.llm.providers).toHaveLength(1)
  })

  it('malformed seed files fail closed and are never silently overwritten', () => {
    const dir = makeDir()
    const target = seedFileForLabel(dir, 'B')
    writeFileSync(target, 'not-json{{{')
    expect(() => loadSettingsSeed(dir, 'B')).toThrow(/malformed JSON/)
    // The bad file is left exactly as found (fix manually, never auto-clobber).
    expect(readFileSync(target, 'utf8')).toBe('not-json{{{')
  })

  it('never publishes an invalid projection (validation runs before any write)', () => {
    const dir = makeDir()
    const projected = projectSettingsSeed(liveStateFixture())
    const poisoned = {
      ...projected,
      assistants: {
        ...projected.assistants,
        assistants: [{ id: 'a1', topics: [{ id: 't1' }], messages: [] }]
      }
    }
    expect(() => writeSettingsSeedAtomic(dir, 'A', poisoned)).toThrow(/must not carry/)
    expect(loadSettingsSeed(dir, 'A')).toBeNull()
  })
})

describe('buildSeedRestoreDispatches', () => {
  it('restores through existing public actions only; skips fixture-owned and unknown keys', () => {
    const dir = makeDir()
    const projected = projectSettingsSeed(liveStateFixture())
    writeSettingsSeedAtomic(dir, 'A', projected)
    const seed = loadSettingsSeed(dir, 'A')
    expect(seed).not.toBeNull()
    const dispatches = buildSeedRestoreDispatches(seed!)
    const types = dispatches.map((d) => d.type)
    expect(types).toContain('settings/setTheme')
    expect(types).toContain('llm/updateProviders')
    expect(types).toContain('llm/setDefaultModel')
    expect(types).toContain('assistants/updateAssistantDefaults')
    expect(types).toContain('assistants/updateAssistants')
    // Fixture-owned language/zh-CN path and live anchors are never dispatched.
    expect(types).not.toContain('settings/setLanguage')
    expect(types.join('\n')).not.toContain('contextWindowAnchor')
    // No sync/device/token actions: the runner configures endpoint+enabled.
    expect(types.join('\n')).not.toMatch(/sync|token|endpoint/i)
    // setDefaultModel carries the existing { model } payload shape.
    const setDefault = dispatches.find((d) => d.type === 'llm/setDefaultModel')
    expect(setDefault?.payload).toEqual({ model: { id: 'gpt-x', name: 'GPT X' } })
  })

  it('ignores arbitrary unknown state (allowlist only)', () => {
    const dir = makeDir()
    const projected = projectSettingsSeed(liveStateFixture())
    const withUnknown = {
      ...projected,
      settings: { ...projected.settings, evilKey: 'evil', language: 'en-US' }
    }
    writeSettingsSeedAtomic(dir, 'A', withUnknown)
    const seed = loadSettingsSeed(dir, 'A')
    const types = buildSeedRestoreDispatches(seed!).map((d) => d.type)
    expect(types.join('\n')).not.toContain('evilKey')
    expect(types).not.toContain('settings/setLanguage')
  })
})

describe('summarizeSeedForLog', () => {
  it('reports counts only, never secrets or content', () => {
    const projected = projectSettingsSeed(liveStateFixture())
    const summary = summarizeSeedForLog({ label: 'A', ...projected }, 'snapshot saved')
    expect(summary).toContain('profile A')
    expect(summary).toContain('1 providers')
    expect(summary).toContain('1 assistants')
    expect(summary).not.toContain(SECRET)
    expect(summary).not.toContain('Be helpful.')
  })
})
