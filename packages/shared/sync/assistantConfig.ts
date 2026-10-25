/**
 * Portable non-secret assistant configuration bridge (bounded unit).
 *
 * Authority: renderer persistence owns local non-secret Assistant &
 * assistantDefaults. Main holds a mirror only, never assistant authority.
 * Chat authority (SQLite chat) is untouched; topics/messages/chat projections,
 * tokens and runtime usage are never synchronized here.
 *
 * Identity: entity `assistant_config` with explicit
 * kind `assistant | defaults` + raw stable id (assistantId, or the
 * `defaults` singleton). Canonical storage key:
 * `assistant_config:<kind>:<id>`. Kind-qualified so the defaults singleton
 * can never collide with an assistant id (prefix alone is not trusted).
 *
 * Model selection is device-local, never portable: application settings and
 * provider connections do not sync, so a model/connection reference has no
 * cross-device meaning. `model`, `defaultModel` and the model-indexed
 * reasoning preferences (`settings.defaultModel`,
 * `settings.reasoning_effort_by_model`,
 * `settings.reasoning_effort_show_all_by_model`,
 * `settings.reasoning_effort_cache`) are therefore absent from this contract
 * and are never captured, published, merged or re-applied.
 */

export const ASSISTANT_CONFIG_ENTITY = 'assistant_config' as const
export const ASSISTANT_CONFIG_KIND_ASSISTANT = 'assistant' as const
export const ASSISTANT_CONFIG_KIND_DEFAULTS = 'defaults' as const
export const ASSISTANT_CONFIG_DEFAULTS_ID = 'defaults' as const
export const ASSISTANT_CONFIG_SCHEMA_VERSION = 1 as const
export type AssistantConfigKind = 'assistant' | 'defaults'

export interface AssistantContextAnchor {
  kind: 'active' | 'disabled'
  groupKey: string
}

/** Portable (synced) assistant settings. Model-indexed reasoning slots stay local. */
export interface AssistantConfigSettings {
  temperature?: number
  enableTemperature?: boolean
  topP?: number
  enableTopP?: boolean
  contextCount?: number | null
  maxTokens?: number
  enableMaxTokens?: boolean
  streamOutput?: boolean
  toolUseMode?: 'function' | 'prompt'
  maxToolCalls?: number
  enableMaxToolCalls?: boolean
  reasoning_effort?: string
  qwenThinkMode?: boolean
  customParameters?: Array<{ name: string; value: string | number | boolean | object | null; type: string }>
  contextWindowAnchor?: Record<string, AssistantContextAnchor>
}

export interface AssistantConfigPayload {
  schemaVersion: typeof ASSISTANT_CONFIG_SCHEMA_VERSION
  kind: AssistantConfigKind
  /** Raw stable id: assistantId, or 'defaults' singleton for defaults kind. */
  id: string
  name?: string
  prompt?: string
  type?: string
  emoji?: string
  description?: string
  tags?: string[]
  settings?: AssistantConfigSettings
  /** Reference-only ids; external knowledge bodies are never synced. */
  knowledgeBaseIds?: string[]
  enableUrlContext?: boolean
  enableGenerateImage?: boolean
  knowledgeRecognition?: 'off' | 'on'
  /** Explicit deletion tombstone. Absence in a snapshot never means deleted. */
  deleted?: boolean
}

export interface AssistantConfigDelta {
  kind: AssistantConfigKind
  id: string
  /** Stable idempotency key persisted with the local pending entry. */
  mutationId: string
  revision: number
  baseRevision?: number
  timestamp: number
  actorDeviceId?: string
  /** Changed allowlisted fields only (partial). Deleted uses tombstone flag. */
  fields: Partial<AssistantConfigPayload>
  deleted?: boolean
}

/** Portable top-level fields: the complete synced surface of this entity. */
export const ASSISTANT_CONFIG_TOP_LEVEL_FIELDS = [
  'name',
  'prompt',
  'type',
  'emoji',
  'description',
  'tags',
  'settings',
  'knowledgeBaseIds',
  'enableUrlContext',
  'enableGenerateImage',
  'knowledgeRecognition'
] as const

export type AssistantConfigTopLevelField = (typeof ASSISTANT_CONFIG_TOP_LEVEL_FIELDS)[number]

export const ASSISTANT_CONFIG_SETTINGS_FIELDS = [
  'temperature',
  'enableTemperature',
  'topP',
  'enableTopP',
  'contextCount',
  'maxTokens',
  'enableMaxTokens',
  'streamOutput',
  'toolUseMode',
  'maxToolCalls',
  'enableMaxToolCalls',
  'reasoning_effort',
  'qwenThinkMode',
  'customParameters',
  'contextWindowAnchor'
] as const

/**
 * Device-local selection slots that live beside the portable surface and must
 * never be captured or published: a model/connection reference only resolves
 * on the device that owns that connection.
 */
export const ASSISTANT_CONFIG_LOCAL_ONLY_FIELDS = ['model', 'defaultModel'] as const

export const ASSISTANT_CONFIG_SETTINGS_LOCAL_ONLY_FIELDS = [
  'defaultModel',
  'reasoning_effort_by_model',
  'reasoning_effort_show_all_by_model',
  'reasoning_effort_cache'
] as const

/** Keys that must never appear as DTO keys (values are never scanned). */
const DENIED_CONFIG_KEYS = new Set([
  'topics',
  'messages',
  'messageblocks',
  'blocks',
  'token',
  'tokens',
  'usage',
  'metrics',
  'credential',
  'credentials',
  'password',
  'secret',
  'apikey',
  'api_key',
  'file_path',
  'filepath',
  'path'
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

function isValidUnicodeScalarString(s: string): boolean {
  let i = 0
  while (i < s.length) {
    const cp = s.codePointAt(i)!
    if (cp >= 0xd800 && cp <= 0xdfff) return false
    if (cp > 0x10ffff) return false
    i += cp > 0xffff ? 2 : 1
  }
  return true
}

export function canonicalAssistantConfigKey(kind: AssistantConfigKind, id: string): string {
  return `${ASSISTANT_CONFIG_ENTITY}:${kind}:${id}`
}

export function parseAssistantConfigKey(key: unknown): { kind: AssistantConfigKind; id: string } | null {
  if (typeof key !== 'string') return null
  const prefix = `${ASSISTANT_CONFIG_ENTITY}:`
  if (!key.startsWith(prefix)) return null
  const rest = key.slice(prefix.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const kind = rest.slice(0, sep)
  const id = rest.slice(sep + 1)
  if (kind !== 'assistant' && kind !== 'defaults') return null
  if (id.length === 0 || !isValidUnicodeScalarString(id)) return null
  if (kind === 'defaults' && id !== ASSISTANT_CONFIG_DEFAULTS_ID) return null
  return { kind, id }
}

export function validateAssistantConfigId(kind: AssistantConfigKind, id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return 'invalid id'
  if (!isValidUnicodeScalarString(id)) return 'invalid id unicode'
  if (id.includes(':')) return 'invalid id: must not contain colon'
  if (kind === 'defaults' && id !== ASSISTANT_CONFIG_DEFAULTS_ID) return 'defaults id must be "defaults"'
  if (kind === 'assistant' && id === ASSISTANT_CONFIG_DEFAULTS_ID)
    return 'assistant id collides with defaults singleton'
  return null
}

function validateAnchorMap(v: unknown): string | null {
  if (v === undefined) return null
  if (!isPlainObject(v)) return 'contextWindowAnchor must be object'
  for (const [topicId, anchor] of Object.entries(v)) {
    if (topicId.length === 0 || topicId.length > 256) return 'contextWindowAnchor topic id invalid'
    if (!isValidUnicodeScalarString(topicId)) return 'contextWindowAnchor topic id unicode'
    if (!isPlainObject(anchor)) return `contextWindowAnchor[${topicId}] must be object`
    const a = anchor
    const keys = Object.keys(a)
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('groupKey')) {
      return `contextWindowAnchor[${topicId}] must be exactly {kind,groupKey}`
    }
    if (a.kind !== 'active') return `contextWindowAnchor[${topicId}].kind invalid: only active allowed`
    if (typeof a.groupKey !== 'string' || a.groupKey.length === 0) {
      return `contextWindowAnchor[${topicId}].groupKey invalid`
    }
  }
  return null
}

function validateSettings(s: unknown): string | null {
  if (s === undefined) return null
  if (!isPlainObject(s)) return 'settings must be object'
  const o = s
  const allowed = new Set<string>(ASSISTANT_CONFIG_SETTINGS_FIELDS as unknown as string[])
  for (const k of Object.keys(o)) if (!allowed.has(k)) return `settings.${k} not allowlisted`
  if (o.temperature !== undefined && (typeof o.temperature !== 'number' || !Number.isFinite(o.temperature))) {
    return 'settings.temperature invalid'
  }
  if (o.enableTemperature !== undefined && typeof o.enableTemperature !== 'boolean') {
    return 'settings.enableTemperature invalid'
  }
  if (o.topP !== undefined && (typeof o.topP !== 'number' || !Number.isFinite(o.topP))) return 'settings.topP invalid'
  if (o.enableTopP !== undefined && typeof o.enableTopP !== 'boolean') return 'settings.enableTopP invalid'
  if (o.contextCount !== undefined && o.contextCount !== null) {
    if (typeof o.contextCount !== 'number' || !Number.isInteger(o.contextCount) || o.contextCount < 0) {
      return 'settings.contextCount invalid'
    }
  }
  if (o.maxTokens !== undefined && (typeof o.maxTokens !== 'number' || !Number.isInteger(o.maxTokens))) {
    return 'settings.maxTokens invalid'
  }
  if (o.enableMaxTokens !== undefined && typeof o.enableMaxTokens !== 'boolean') {
    return 'settings.enableMaxTokens invalid'
  }
  if (o.streamOutput !== undefined && typeof o.streamOutput !== 'boolean') return 'settings.streamOutput invalid'
  if (o.toolUseMode !== undefined && o.toolUseMode !== 'function' && o.toolUseMode !== 'prompt') {
    return 'settings.toolUseMode invalid'
  }
  if (o.maxToolCalls !== undefined && (typeof o.maxToolCalls !== 'number' || !Number.isInteger(o.maxToolCalls))) {
    return 'settings.maxToolCalls invalid'
  }
  if (o.enableMaxToolCalls !== undefined && typeof o.enableMaxToolCalls !== 'boolean') {
    return 'settings.enableMaxToolCalls invalid'
  }
  if (o.reasoning_effort !== undefined && typeof o.reasoning_effort !== 'string') {
    return 'settings.reasoning_effort invalid'
  }
  if (o.qwenThinkMode !== undefined && typeof o.qwenThinkMode !== 'boolean') return 'settings.qwenThinkMode invalid'
  if (o.customParameters !== undefined) {
    if (!Array.isArray(o.customParameters)) return 'settings.customParameters invalid'
    for (const e of o.customParameters as unknown[]) {
      if (!isPlainObject(e)) return 'settings.customParameters entry invalid'
      const en = e
      if (typeof en.name !== 'string' || en.name.length === 0) return 'settings.customParameters name invalid'
      // Structure-key guard for arbitrary JSON names: known credential/path keys are denied as pass-through.
      const lowerName = en.name.toLowerCase()
      if (
        DENIED_CONFIG_KEYS.has(lowerName) ||
        lowerName.includes('credential') ||
        lowerName.includes('secret') ||
        lowerName.includes('apikey') ||
        lowerName.includes('api_key') ||
        lowerName.includes('token') ||
        lowerName.includes('password') ||
        lowerName === 'file_path' ||
        lowerName === 'filepath' ||
        lowerName === 'path'
      ) {
        return `settings.customParameters name "${en.name}" denied (credential/path)`
      }
      if (en.type !== 'string' && en.type !== 'number' && en.type !== 'boolean' && en.type !== 'json') {
        return 'settings.customParameters type invalid'
      }
      const vv = en.value
      if (vv !== null && !['string', 'number', 'boolean'].includes(typeof vv) && !isPlainObject(vv)) {
        return 'settings.customParameters value invalid'
      }
    }
  }
  const anchorErr = validateAnchorMap(o.contextWindowAnchor)
  if (anchorErr) return anchorErr
  return null
}

/**
 * Strict DTO validation. Exact top-level keys only; denied keys fail closed.
 * Values are never scanned for literal substrings (user prompts may contain
 * any words) — only keys are allowlisted/denied.
 */
export function validateAssistantConfigPayload(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'payload must be object'
  const o = raw
  const allowed = new Set<string>(['schemaVersion', 'kind', 'id', ...ASSISTANT_CONFIG_TOP_LEVEL_FIELDS, 'deleted'])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) return `field ${k} not allowlisted`
    if (DENIED_CONFIG_KEYS.has(k.toLowerCase())) return `field ${k} denied`
  }
  if (o.schemaVersion !== ASSISTANT_CONFIG_SCHEMA_VERSION) return 'unsupported schemaVersion'
  if (o.kind !== 'assistant' && o.kind !== 'defaults') return 'invalid kind'
  const idErr = validateAssistantConfigId(o.kind as AssistantConfigKind, o.id)
  if (idErr) return idErr
  if (o.kind === 'defaults') {
    if ('name' in o || 'emoji' in o || 'type' in o) {
      // defaults DTO carries shared config fields; name/emoji/type stay
      // entity-local and are rejected here to keep kind semantics explicit.
      return 'defaults must not carry name/emoji/type'
    }
  }
  if (o.name !== undefined && typeof o.name !== 'string') return 'name invalid'
  if (o.prompt !== undefined && typeof o.prompt !== 'string') return 'prompt invalid'
  if (o.type !== undefined && typeof o.type !== 'string') return 'type invalid'
  if (o.emoji !== undefined && typeof o.emoji !== 'string') return 'emoji invalid'
  if (o.description !== undefined && typeof o.description !== 'string') return 'description invalid'
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags)) return 'tags invalid'
    for (const t of o.tags as unknown[]) if (typeof t !== 'string') return 'tags entry invalid'
  }
  const sErr = validateSettings(o.settings)
  if (sErr) return sErr
  if (o.knowledgeBaseIds !== undefined) {
    if (!Array.isArray(o.knowledgeBaseIds)) return 'knowledgeBaseIds invalid'
    for (const k of o.knowledgeBaseIds as unknown[]) {
      if (typeof k !== 'string' || k.length === 0) return 'knowledgeBaseIds entry invalid'
    }
  }
  if (o.enableUrlContext !== undefined && typeof o.enableUrlContext !== 'boolean') return 'enableUrlContext invalid'
  if (o.enableGenerateImage !== undefined && typeof o.enableGenerateImage !== 'boolean') {
    return 'enableGenerateImage invalid'
  }
  if (o.knowledgeRecognition !== undefined && o.knowledgeRecognition !== 'off' && o.knowledgeRecognition !== 'on') {
    return 'knowledgeRecognition invalid'
  }
  if (o.deleted !== undefined && typeof o.deleted !== 'boolean') return 'deleted invalid'
  return null
}

export function validateAssistantConfigDelta(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'delta must be object'
  const o = raw
  const allowed = new Set([
    'kind',
    'id',
    'mutationId',
    'revision',
    'baseRevision',
    'timestamp',
    'actorDeviceId',
    'fields',
    'deleted'
  ])
  for (const k of Object.keys(o)) if (!allowed.has(k)) return `delta field ${k} not allowlisted`
  if (o.kind !== 'assistant' && o.kind !== 'defaults') return 'invalid kind'
  const idErr = validateAssistantConfigId(o.kind as AssistantConfigKind, o.id)
  if (idErr) return idErr
  if (typeof o.mutationId !== 'string' || o.mutationId.length === 0 || o.mutationId.length > 256) {
    return 'invalid mutationId'
  }
  if (o.mutationId.includes(':')) return 'invalid mutationId: colon'
  if (typeof o.revision !== 'number' || !Number.isSafeInteger(o.revision) || o.revision < 0) {
    return 'invalid revision'
  }
  if (o.baseRevision !== undefined && (typeof o.baseRevision !== 'number' || !Number.isSafeInteger(o.baseRevision))) {
    return 'invalid baseRevision'
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) return 'invalid timestamp'
  if (o.actorDeviceId !== undefined && typeof o.actorDeviceId !== 'string') return 'invalid actorDeviceId'
  if (o.deleted !== undefined && typeof o.deleted !== 'boolean') return 'deleted invalid'
  if (!isPlainObject(o.fields)) return 'fields must be object'
  const fields = o.fields
  for (const k of Object.keys(fields)) {
    if (!(ASSISTANT_CONFIG_TOP_LEVEL_FIELDS as readonly string[]).includes(k)) return `delta field ${k} not allowlisted`
    if (DENIED_CONFIG_KEYS.has(k.toLowerCase())) return `delta field ${k} denied`
  }
  // Reuse payload shape checks for the partial fields by merging kind/id/schema.
  const probe: Record<string, unknown> = {
    schemaVersion: ASSISTANT_CONFIG_SCHEMA_VERSION,
    kind: o.kind,
    id: o.id,
    ...fields
  }
  if (o.kind === 'defaults') {
    delete probe.name
    delete probe.emoji
    delete probe.type
    if ('name' in fields || 'emoji' in fields || 'type' in fields) return 'defaults must not carry name/emoji/type'
  }
  return validateAssistantConfigPayload(probe)
}

export interface RawAssistantLike {
  id?: unknown
  name?: unknown
  prompt?: unknown
  type?: unknown
  emoji?: unknown
  description?: unknown
  tags?: unknown
  settings?: Record<string, unknown> | null
  knowledge_bases?: Array<{ id?: unknown }> | null
  enableUrlContext?: unknown
  enableGenerateImage?: unknown
  knowledgeRecognition?: unknown
}

function pickSettings(raw: Record<string, unknown> | null | undefined): AssistantConfigSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: AssistantConfigSettings = {}
  const num = (k: string): number | undefined =>
    typeof raw[k] === 'number' && Number.isFinite(raw[k]) ? raw[k] : undefined
  const bool = (k: string): boolean | undefined => (typeof raw[k] === 'boolean' ? raw[k] : undefined)
  const v = num('temperature')
  if (v !== undefined) out.temperature = v
  const et = bool('enableTemperature')
  if (et !== undefined) out.enableTemperature = et
  const tp = num('topP')
  if (tp !== undefined) out.topP = tp
  const etp = bool('enableTopP')
  if (etp !== undefined) out.enableTopP = etp
  const cc = raw['contextCount']
  if (cc === null) out.contextCount = null
  else if (typeof cc === 'number' && Number.isInteger(cc) && cc >= 0) out.contextCount = cc
  const mt = raw['maxTokens']
  if (typeof mt === 'number' && Number.isInteger(mt)) out.maxTokens = mt
  const emt = bool('enableMaxTokens')
  if (emt !== undefined) out.enableMaxTokens = emt
  const so = bool('streamOutput')
  if (so !== undefined) out.streamOutput = so
  if (raw['toolUseMode'] === 'function' || raw['toolUseMode'] === 'prompt') out.toolUseMode = raw['toolUseMode']
  const mtc = raw['maxToolCalls']
  if (typeof mtc === 'number' && Number.isInteger(mtc)) out.maxToolCalls = mtc
  const emtc = bool('enableMaxToolCalls')
  if (emtc !== undefined) out.enableMaxToolCalls = emtc
  if (typeof raw['reasoning_effort'] === 'string') out.reasoning_effort = raw['reasoning_effort']
  const qwen = bool('qwenThinkMode')
  if (qwen !== undefined) out.qwenThinkMode = qwen
  if (Array.isArray(raw['customParameters'])) {
    const arr: AssistantConfigSettings['customParameters'] = []
    for (const e of raw['customParameters'] as unknown[]) {
      if (e && typeof e === 'object') {
        const en = e as Record<string, unknown>
        if (typeof en.name === 'string' && typeof en.type === 'string') {
          arr.push({
            name: en.name,
            value: (en.value as string | number | boolean | object | null) ?? null,
            type: en.type
          })
        }
      }
    }
    out.customParameters = arr
  }
  if (raw['contextWindowAnchor'] && typeof raw['contextWindowAnchor'] === 'object') {
    const m: Record<string, AssistantContextAnchor> = {}
    for (const [k, val] of Object.entries(raw['contextWindowAnchor'] as Record<string, unknown>)) {
      if (val && typeof val === 'object') {
        const a = val as Record<string, unknown>
        if ((a.kind === 'active' || a.kind === 'disabled') && typeof a.groupKey === 'string') {
          m[k] = { kind: a.kind, groupKey: a.groupKey }
        }
      }
    }
    out.contextWindowAnchor = m
  }
  return out
}

/**
 * Projector: Assistant entity -> portable DTO. Drops topics/messages, every
 * non-allowlisted key, and all device-local model selection slots.
 */
export function projectAssistantToConfig(raw: RawAssistantLike): AssistantConfigPayload | null {
  if (!raw || typeof raw.id !== 'string') return null
  const idErr = validateAssistantConfigId('assistant', raw.id)
  if (idErr) return null
  const dto: AssistantConfigPayload = {
    schemaVersion: ASSISTANT_CONFIG_SCHEMA_VERSION,
    kind: 'assistant',
    id: raw.id
  }
  if (typeof raw.name === 'string') dto.name = raw.name
  if (typeof raw.prompt === 'string') dto.prompt = raw.prompt
  if (typeof raw.type === 'string') dto.type = raw.type
  if (typeof raw.emoji === 'string') dto.emoji = raw.emoji
  if (typeof raw.description === 'string') dto.description = raw.description
  if (Array.isArray(raw.tags)) dto.tags = (raw.tags as unknown[]).filter((t): t is string => typeof t === 'string')
  const settings = pickSettings((raw.settings as Record<string, unknown> | undefined) ?? undefined)
  if (settings !== undefined) dto.settings = settings
  if (Array.isArray(raw.knowledge_bases)) {
    dto.knowledgeBaseIds = raw.knowledge_bases
      .map((k) => (k && typeof k.id === 'string' ? k.id : null))
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
  }
  if (typeof raw.enableUrlContext === 'boolean') dto.enableUrlContext = raw.enableUrlContext
  if (typeof raw.enableGenerateImage === 'boolean') dto.enableGenerateImage = raw.enableGenerateImage
  if (raw.knowledgeRecognition === 'off' || raw.knowledgeRecognition === 'on') {
    dto.knowledgeRecognition = raw.knowledgeRecognition
  }
  return validateAssistantConfigPayload(dto) === null ? dto : null
}

export function createAssistantConfigDelta(input: {
  kind: AssistantConfigKind
  id: string
  mutationId: string
  revision: number
  baseRevision?: number
  timestamp?: number
  actorDeviceId?: string
  fields: Partial<AssistantConfigPayload>
  deleted?: boolean
}): AssistantConfigDelta | null {
  const delta: AssistantConfigDelta = {
    kind: input.kind,
    id: input.id,
    mutationId: input.mutationId,
    revision: input.revision,
    timestamp: input.timestamp ?? Date.now(),
    fields: input.fields,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    ...(input.actorDeviceId !== undefined ? { actorDeviceId: input.actorDeviceId } : {}),
    ...(input.deleted !== undefined ? { deleted: input.deleted } : {})
  }
  return validateAssistantConfigDelta(delta) === null ? delta : null
}

const PORTABLE_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(ASSISTANT_CONFIG_TOP_LEVEL_FIELDS as unknown as string[])
const PORTABLE_SETTINGS_KEYS: ReadonlySet<string> = new Set(ASSISTANT_CONFIG_SETTINGS_FIELDS as unknown as string[])

/**
 * Capture-side boundary: reduce a local field patch/record to the portable
 * surface. Device-local model selection slots (and the model-indexed reasoning
 * preferences) are dropped here so a local row that legitimately owns them can
 * never leak into a delta, a mirror payload or a published baseline. The result
 * is not validated (callers keep strict validation); unknown keys are dropped
 * rather than forwarded.
 */
export function sanitizeAssistantConfigFields(fields: unknown): Record<string, unknown> {
  if (!isPlainObject(fields)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!PORTABLE_TOP_LEVEL_KEYS.has(k)) continue
    if (k === 'settings') {
      if (!isPlainObject(v)) {
        out.settings = v
        continue
      }
      const settings: Record<string, unknown> = {}
      for (const [sk, sv] of Object.entries(v)) {
        if (PORTABLE_SETTINGS_KEYS.has(sk)) settings[sk] = sv
      }
      // A settings object whose only content is device-local (model-indexed
      // reasoning slots / defaultModel) carries no portable intent at all.
      if (Object.keys(settings).length === 0 && Object.keys(v).length > 0) continue
      out.settings = settings
      continue
    }
    out[k] = v
  }
  return out
}

/** Structural equality for JSON-shaped portable values (order-insensitive keys). */
export function portableValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => portableValuesEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    return ak.every((k) => k in b && portableValuesEqual(a[k], b[k]))
  }
  return false
}

/**
 * Field-level diff for a local commit: only portable fields whose value
 * actually changed. A model-only local edit therefore yields `{}` (no sync
 * intent, no shared field clock advance) while a mixed edit yields just the
 * portable fields.
 */
export function diffPortableAssistantConfigFields(previous: unknown, incoming: unknown): Record<string, unknown> {
  const prev = sanitizeAssistantConfigFields(previous)
  const next = sanitizeAssistantConfigFields(incoming)
  const changed: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) {
    if (!portableValuesEqual(prev[k], v)) changed[k] = v
  }
  return changed
}
