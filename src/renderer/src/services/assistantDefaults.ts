import { DEFAULT_CONTEXTCOUNT, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from '@renderer/config/constant'
import i18n from '@renderer/i18n'
import type {
  Assistant,
  AssistantSettings,
  KnowledgeBase,
  McpMode,
  MCPServer,
  Model,
  Topic,
  WebSearchProvider
} from '@renderer/types'
import { v4 as uuid } from 'uuid'

/**
 * Cycle-free default assistant settings template.
 *
 * Extracted from AssistantService so capability-adjacent modules
 * (parameterBuilder) can read tool-call defaults without importing the
 * store/AssistantService chain (that edge created a deterministic
 * collection-time TDZ through store/assistants → SqliteMessageDataSource).
 * Single source of truth: AssistantService re-exports this object.
 */
export const DEFAULT_ASSISTANT_SETTINGS = {
  maxTokens: DEFAULT_MAX_TOKENS,
  enableMaxTokens: false,
  temperature: DEFAULT_TEMPERATURE,
  enableTemperature: false,
  topP: 1,
  enableTopP: false,
  contextCount: DEFAULT_CONTEXTCOUNT,
  streamOutput: true,
  defaultModel: undefined,
  customParameters: [],
  reasoning_effort: 'default',
  reasoning_effort_cache: undefined,
  reasoning_effort_show_all_by_model: {} as Record<string, boolean>,
  qwenThinkMode: undefined,
  // It would gracefully fallback to prompt if not supported by model.
  toolUseMode: 'function',
  maxToolCalls: 20,
  enableMaxToolCalls: true,
  contextWindowAnchor: {}
} as const satisfies AssistantSettings

/**
 * Pure configuration for creating new assistants and configuring ephemeral
 * requests. Deliberately NOT an Assistant entity: it carries no `id`, no
 * `topics`, no `messages`/chat authority, and must never be used as an
 * Assistant fallback. Persisted at `state.assistants.assistantDefaults`.
 */
export interface AssistantDefaults {
  name: string
  emoji?: string
  description?: string
  prompt: string
  type: string
  model?: Model
  defaultModel?: Model
  settings: AssistantSettings
  knowledge_bases?: KnowledgeBase[]
  enableWebSearch?: boolean
  webSearchProviderId?: WebSearchProvider['id']
  enableUrlContext?: boolean
  enableGenerateImage?: boolean
  mcpMode?: McpMode
  mcpServers?: MCPServer[]
  knowledgeRecognition?: 'off' | 'on'
  tags?: string[]
  enableMemory?: boolean
}

export function getDefaultTopic(assistantId: string): Topic {
  return {
    id: uuid(),
    assistantId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: i18n.t('chat.default.topic.name'),
    messages: [],
    isNameManuallyEdited: false
  }
}

/**
 * Creates fresh pure defaults (no identity, no topics). The name uses the
 * language/default configuration in effect when it is created; changing UI
 * language later never mutates stored defaults through this factory.
 */
export function createAssistantDefaults(overrides: Partial<AssistantDefaults> = {}): AssistantDefaults {
  return {
    name: i18n.t('chat.default.name'),
    emoji: '😀',
    prompt: '',
    type: 'assistant',
    ...overrides,
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, ...overrides.settings } as AssistantSettings
  }
}

/**
 * Migration-safe conversion of a legacy persisted `defaultAssistant` entity
 * into pure `AssistantDefaults`. Selects only allowed config fields, drops
 * entity fields (`id`, `topics`, `messages`, and translate-ephemeral
 * `content`/`targetLanguage`), and never touches `assistants[]`.
 * Malformed/missing input falls back to fresh defaults.
 */
export function toAssistantDefaults(source: unknown): AssistantDefaults {
  const fresh = createAssistantDefaults()
  if (!source || typeof source !== 'object') {
    return fresh
  }
  const legacy = source as Record<string, unknown>
  const pickString = (key: string, fallback: string): string => {
    const value = legacy[key]
    return typeof value === 'string' ? value : fallback
  }
  const settings =
    legacy.settings && typeof legacy.settings === 'object' ? (legacy.settings as AssistantSettings) : fresh.settings
  const next: AssistantDefaults = {
    ...fresh,
    name: pickString('name', fresh.name),
    prompt: pickString('prompt', fresh.prompt),
    type: pickString('type', fresh.type),
    settings
  }
  const optionalKeys = [
    'emoji',
    'description',
    'model',
    'defaultModel',
    'knowledge_bases',
    'enableWebSearch',
    'webSearchProviderId',
    'enableUrlContext',
    'enableGenerateImage',
    'mcpMode',
    'mcpServers',
    'knowledgeRecognition',
    'tags',
    'enableMemory'
  ] as const
  for (const key of optionalKeys) {
    const value = legacy[key]
    if (value !== undefined) {
      ;(next as unknown as Record<string, unknown>)[key] = value
    }
  }
  if (next.emoji !== undefined && typeof next.emoji !== 'string') {
    delete next.emoji
  }
  return next
}

/**
 * Creates an ordinary persisted Assistant entity from pure defaults: a new
 * id plus a fresh topic owned by that entity. No `preset.id === 'default'`
 * branching; the single generic creation path for new-assistant flows.
 */
export function createAssistantFromDefaults(
  defaults: AssistantDefaults,
  overrides: Partial<Assistant> = {}
): Assistant {
  const id = typeof overrides.id === 'string' && overrides.id.length > 0 ? overrides.id : uuid()
  const { ...rest } = overrides
  return {
    name: defaults.name,
    emoji: defaults.emoji,
    description: defaults.description,
    prompt: defaults.prompt,
    type: defaults.type,
    model: defaults.model,
    defaultModel: defaults.defaultModel,
    settings: { ...defaults.settings },
    knowledge_bases: defaults.knowledge_bases,
    enableWebSearch: defaults.enableWebSearch,
    webSearchProviderId: defaults.webSearchProviderId,
    enableUrlContext: defaults.enableUrlContext,
    enableGenerateImage: defaults.enableGenerateImage,
    mcpMode: defaults.mcpMode,
    mcpServers: defaults.mcpServers,
    knowledgeRecognition: defaults.knowledgeRecognition,
    tags: defaults.tags,
    enableMemory: defaults.enableMemory,
    ...rest,
    id,
    topics: [getDefaultTopic(id)],
    messages: []
  }
}

/**
 * Fresh-profile initial assistant. Retains the historical `default` id for
 * compatibility, but the result is an ordinary entity: no production branch
 * may special-case it after construction, and its initial topic is a normal
 * topic owned by that entity.
 */
export function createInitialAssistant(defaults: AssistantDefaults = createAssistantDefaults()): Assistant {
  return createAssistantFromDefaults(defaults, { id: 'default' })
}

/**
 * Non-persisted request-local Assistant for ephemeral summary/generate/check/
 * translation calls at broad existing `Assistant`-typed boundaries
 * (`buildProviderOptions`, `AiProviderConfig.assistant`). Never carries the
 * fixed `default` identity, never carries topics, and must never be persisted
 * or used as an Assistant fallback. Prefer narrowing the downstream API over
 * this fallback where reasonably possible.
 */
export function createEphemeralAssistant(init: Partial<Assistant> = {}): Assistant {
  const { settings, ...rest } = init
  return {
    name: '',
    prompt: '',
    type: 'assistant',
    ...rest,
    id: uuid(),
    topics: [],
    messages: [],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, ...settings } as AssistantSettings
  }
}
