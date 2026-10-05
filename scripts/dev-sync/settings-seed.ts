/**
 * Settings-seed ownership for `pnpm dev:sync`.
 *
 * RETENTION / EXCLUSION CONTRACT (fresh content, retained settings):
 *
 * RETAINED across runs (durable owner-only seed files
 * `local/dev-sync/settings-a.json` / `settings-b.json`, mode 0600):
 * - renderer `settings` slice: ordinary appearance/general/config values,
 *   captured whole EXCEPT the exclusions below. User secrets that live in
 *   settings (provider keys, tokens, local paths) stay local-only and are
 *   never logged — only counts/key-names appear in terminal output.
 * - renderer `llm` slice: user-defined `providers` (including their API keys,
 *   local-only), the `defaultModel` / `quickModel` / `translateModel` slots,
 *   and keep-alive `settings`. Missing providers are NEVER synthesized: an
 *   absent provider stays unconfigured (no fake fallback is ever written).
 * - renderer `assistants` slice: `assistantDefaults` plus config-only
 *   assistants (`id/name/prompt/type/emoji/description/model/defaultModel/
 *   settings/enableWebSearch/webSearchProviderId/enableUrlContext/
 *   enableGenerateImage/mcpMode/tags/enableMemory/targetLanguage/
 *   knowledgeRecognition`). Translate-ephemeral `content` is never seeded.
 *   Nested live refs (`settings.contextWindowAnchor`) are stripped from both
 *   assistants and `assistantDefaults`; stable config (`settings/contextCount`
 *   and the rest of `settings`) is retained. Assistant edits ride the app's
 *   own normal Redux actions, so the durable sync-bridge mirror is maintained
 *   by the app — the ledger itself is never copied.
 *
 * NEVER SEEDED (cleared every run for fresh content):
 * - assistant `topics` (forced `[]`), `messages` (dropped), `content`
 *   (translate source text, dropped), `knowledge_bases`
 *   content/credentials/paths (dropped entirely — not even id refs, so no
 *   content body, credential, or path can leak), `mcpServers` (dropped),
 *   `presets` (dropped), and the `assistantConfigSync` pending/projection
 *   ledger (reset to empty; deltas re-derive from normal actions).
 * - `settings.contextWindowAnchor` plus nested
 *   `assistant.settings.contextWindowAnchor` / `assistantDefaults`
 *   `settings.contextWindowAnchor` (live chat refs — always cleared; stable
 *   `settings`/`contextCount` itself is retained).
 * - `settings.language` is captured as a record but never restored: the
 *   fixture always boots the coherent zh-CN path (persisted storage +
 *   reload + Redux + preload) with visible Chinese readiness proof.
 * - Main-side sync device auth (device secret/code/channel/cursor/deviceId/
 *   outbox) never leaves Main and never enters a seed: only the loopback
 *   endpoint + enabled flag are configured by the runner each run. There is
 *   no shared access token anywhere in this fixture.
 * - Everything else (knowledge bodies, MCP servers, Dexie/notes/memory
 *   history, chat/deleted artifacts, browser LocalStorage dumps, raw
 *   SQLite/IndexedDB/profile dirs) is never read and never copied: capture
 *   reads ONLY live `window.store` state plus config APIs from the owned test
 *   profiles AFTER the exact `runtimeAppData` assertion, and projects through
 *   the allowlist below. Copying arbitrary unknown state is prohibited.
 *
 * SHAPE / SAFETY:
 * - Seeds are small (bounded count + byte caps), versioned, and validated.
 *   A malformed seed file fails closed with an explicit error that never
 *   echoes secret values; the existing seed is never silently overwritten.
 * - Writes are atomic (owner-only temp + rename) with mode 0600.
 * - `projectSettingsSeed` (capture path) sanitizes defensively; strict
 *   structural validation happens on load (`parseSettingsSeedFile`).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEV_SYNC_SETTINGS_SEED_A_FILE, DEV_SYNC_SETTINGS_SEED_B_FILE } from './constants'

export const DEV_SYNC_SETTINGS_SEED_KIND = 'dev-sync-settings-seed-v1'

export const DEV_SYNC_SETTINGS_SEED_VERSION = 1

/** Hard cap for a seed file: settings seeds are small config, never dumps. */
export const DEV_SYNC_SETTINGS_SEED_MAX_BYTES = 512 * 1024

export const DEV_SYNC_SETTINGS_SEED_MAX_PROVIDERS = 200

export const DEV_SYNC_SETTINGS_SEED_MAX_ASSISTANTS = 500

export type DevSyncSeedLabel = 'A' | 'B'

/** settings.slice keys captured but never restored (fixture-owned or unsettable). */
export const SETTINGS_RESTORE_EXCLUDED_KEYS = ['language', 'contextWindowAnchor'] as const

/**
 * settings.slice keys with no corresponding store setter (deprecated/inert
 * persisted fields kept for historical data compatibility). Captured as a
 * record, never dispatched.
 */
export const SETTINGS_NO_SETTER_KEYS = [
  'assistantsTabSortType',
  'userId',
  'topicPosition',
  'showTopicTime',
  'pinTopicsToTop',
  'assistantIconType',
  'codePreview',
  'enableQuickAssistant',
  'clickTrayToShowQuickAssistant',
  'readClipboardAtStartup',
  'navbarPosition'
] as const

/**
 * Direct key -> `settings/<action>` mapping for restore. Every entry names an
 * existing exported setter whose payload IS the stored value (or a
 * partial-merge of it for `setCodeViewer`/`setSidebarIcons`). Keys absent
 * from the seed are skipped; unknown seed keys are never dispatched.
 */
export const SETTINGS_RESTORE_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['showAssistants', 'settings/setShowAssistants'],
  ['showTopics', 'settings/setShowTopics'],
  ['sendMessageShortcut', 'settings/setSendMessageShortcut'],
  ['targetLanguage', 'settings/setTargetLanguage'],
  ['proxyMode', 'settings/setProxyMode'],
  ['proxyUrl', 'settings/setProxyUrl'],
  ['proxyBypassRules', 'settings/setProxyBypassRules'],
  ['userName', 'settings/setUserName'],
  ['showPrompt', 'settings/setShowPrompt'],
  ['showMessageDivider', 'settings/setShowMessageDivider'],
  ['launchOnBoot', 'settings/setLaunchOnBoot'],
  ['launchToTray', 'settings/setLaunchToTray'],
  ['trayOnClose', 'settings/setTrayOnClose'],
  ['tray', 'settings/setTray'],
  ['theme', 'settings/setTheme'],
  ['userTheme', 'settings/setUserTheme'],
  ['windowStyle', 'settings/setWindowStyle'],
  ['fontSize', 'settings/setFontSize'],
  ['pasteLongTextAsFile', 'settings/setPasteLongTextAsFile'],
  ['pasteLongTextThreshold', 'settings/setPasteLongTextThreshold'],
  ['clickAssistantToShowTopic', 'settings/setClickAssistantToShowTopic'],
  ['autoCheckUpdate', 'settings/setAutoCheckUpdate'],
  ['testPlan', 'settings/setTestPlan'],
  ['testChannel', 'settings/setTestChannel'],
  ['renderInputMessageAsMarkdown', 'settings/setRenderInputMessageAsMarkdown'],
  ['codeViewer', 'settings/setCodeViewer'],
  ['foldDisplayMode', 'settings/setFoldDisplayMode'],
  ['messageNavigation', 'settings/setMessageNavigation'],
  ['skipBackupFile', 'settings/setSkipBackupFile'],
  ['webdavHost', 'settings/setWebdavHost'],
  ['webdavUser', 'settings/setWebdavUser'],
  ['webdavPass', 'settings/setWebdavPass'],
  ['webdavPath', 'settings/setWebdavPath'],
  ['webdavAutoSync', 'settings/setWebdavAutoSync'],
  ['webdavSyncInterval', 'settings/setWebdavSyncInterval'],
  ['webdavMaxBackups', 'settings/setWebdavMaxBackups'],
  ['webdavSkipBackupFile', 'settings/setWebdavSkipBackupFile'],
  ['webdavDisableStream', 'settings/setWebdavDisableStream'],
  ['translateModelPrompt', 'settings/setTranslateModelPrompt'],
  ['showTranslateConfirm', 'settings/setShowTranslateConfirm'],
  ['enableTopicNaming', 'settings/setEnableTopicNaming'],
  ['customCss', 'settings/setCustomCss'],
  ['topicNamingPrompt', 'settings/setTopicNamingPrompt'],
  ['confirmDeleteMessage', 'settings/setConfirmDeleteMessage'],
  ['confirmRegenerateMessage', 'settings/setConfirmRegenerateMessage'],
  ['sidebarIcons', 'settings/setSidebarIcons'],
  ['notionDatabaseID', 'settings/setNotionDatabaseID'],
  ['notionApiKey', 'settings/setNotionApiKey'],
  ['notionPageNameKey', 'settings/setNotionPageNameKey'],
  ['markdownExportPath', 'settings/setmarkdownExportPath'],
  ['forceDollarMathInMarkdown', 'settings/setForceDollarMathInMarkdown'],
  ['useTopicNamingForMessageTitle', 'settings/setUseTopicNamingForMessageTitle'],
  ['showModelNameInMarkdown', 'settings/setShowModelNameInMarkdown'],
  ['showModelProviderInMarkdown', 'settings/setShowModelProviderInMarkdown'],
  ['thoughtAutoCollapse', 'settings/setThoughtAutoCollapse'],
  ['notionExportReasoning', 'settings/setNotionExportReasoning'],
  ['excludeCitationsInExport', 'settings/setExcludeCitationsInExport'],
  ['standardizeCitationsInExport', 'settings/setStandardizeCitationsInExport'],
  ['yuqueToken', 'settings/setYuqueToken'],
  ['yuqueUrl', 'settings/setYuqueUrl'],
  ['yuqueRepoId', 'settings/setYuqueRepoId'],
  ['joplinToken', 'settings/setJoplinToken'],
  ['joplinUrl', 'settings/setJoplinUrl'],
  ['joplinExportReasoning', 'settings/setJoplinExportReasoning'],
  ['defaultObsidianVault', 'settings/setDefaultObsidianVault'],
  ['defaultAgent', 'settings/setDefaultAgent'],
  ['siyuanApiUrl', 'settings/setSiyuanApiUrl'],
  ['siyuanToken', 'settings/setSiyuanToken'],
  ['siyuanBoxId', 'settings/setSiyuanBoxId'],
  ['siyuanRootPath', 'settings/setSiyuanRootPath'],
  ['agentssubscribeUrl', 'settings/setAgentssubscribeUrl'],
  ['privacyPolicyVersion', 'settings/setPrivacyPolicyVersion'],
  ['enableDataCollection', 'settings/setEnableDataCollection'],
  ['enableSpellCheck', 'settings/setEnableSpellCheck'],
  ['spellCheckLanguages', 'settings/setSpellCheckLanguages'],
  ['exportMenuOptions', 'settings/setExportMenuOptions'],
  ['injectContextTimestamp', 'settings/setInjectContextTimestamp'],
  ['disableHardwareAcceleration', 'settings/setDisableHardwareAcceleration'],
  ['useSystemTitleBar', 'settings/setUseSystemTitleBar'],
  ['notification', 'settings/setNotificationSettings'],
  ['localBackupDir', 'settings/setLocalBackupDir'],
  ['localBackupAutoSync', 'settings/setLocalBackupAutoSync'],
  ['localBackupSyncInterval', 'settings/setLocalBackupSyncInterval'],
  ['localBackupMaxBackups', 'settings/setLocalBackupMaxBackups'],
  ['localBackupSkipBackupFile', 'settings/setLocalBackupSkipBackupFile'],
  ['s3', 'settings/setS3'],
  ['enableDeveloperMode', 'settings/setEnableDeveloperMode'],
  ['showMessageOutline', 'settings/setShowMessageOutline'],
  ['assistantsWidth', 'settings/setAssistantsWidth'],
  ['topicListWidth', 'settings/setTopicListWidth']
]

/** Assistant fields retained as config; everything else is dropped. */
const ASSISTANT_CONFIG_KEYS = [
  'id',
  'name',
  'prompt',
  'type',
  'emoji',
  'description',
  'model',
  'defaultModel',
  'settings',
  'enableWebSearch',
  'webSearchProviderId',
  'enableUrlContext',
  'enableGenerateImage',
  'mcpMode',
  'tags',
  'enableMemory',
  'targetLanguage',
  'knowledgeRecognition'
] as const

export interface SettingsSeedFile {
  kind: string
  version: number
  label: DevSyncSeedLabel
  updatedAt: string
  settings: Record<string, unknown>
  llm: {
    providers: Array<Record<string, unknown>>
    defaultModel?: Record<string, unknown> | null
    quickModel?: Record<string, unknown> | null
    translateModel?: Record<string, unknown> | null
    settings?: Record<string, unknown>
  }
  assistants: {
    assistantDefaults: Record<string, unknown>
    assistants: Array<Record<string, unknown>>
    tagsOrder: string[]
    collapsedTags: Record<string, boolean>
  }
}

export interface StoreDispatch {
  type: string
  payload?: unknown
}

export function seedFileForLabel(fixtureRoot: string, label: DevSyncSeedLabel): string {
  return join(fixtureRoot, label === 'A' ? DEV_SYNC_SETTINGS_SEED_A_FILE : DEV_SYNC_SETTINGS_SEED_B_FILE)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function mustBeJsonSerializable(value: unknown, what: string): void {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error('unserializable')
  } catch {
    throw new Error(`[dev-sync] refusing settings seed: ${what} is not JSON-serializable (field name only, no values)`)
  }
}

function isValidModelRef(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256
}

function sanitizeModelRef(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null
  return isValidModelRef(value) ? { ...value } : null
}

function sanitizeProviders(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  const out: Array<Record<string, unknown>> = []
  for (const entry of value.slice(0, DEV_SYNC_SETTINGS_SEED_MAX_PROVIDERS)) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
    const provider: Record<string, unknown> = { ...entry }
    // Models must be id-keyed refs; anything else is dropped, never faked.
    if (provider.models !== undefined) {
      provider.models = Array.isArray(provider.models)
        ? (provider.models as unknown[]).filter(isValidModelRef).map((m) => ({ ...m }))
        : []
    }
    out.push(provider)
  }
  return out
}

function sanitizeConfigAssistant(entry: unknown): Record<string, unknown> | null {
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0) return null
  const out: Record<string, unknown> = {}
  for (const key of ASSISTANT_CONFIG_KEYS) {
    const value = entry[key]
    if (value === undefined) continue
    if (key === 'model' || key === 'defaultModel') {
      const model = sanitizeModelRef(value)
      if (model) out[key] = model
      continue
    }
    if (key === 'settings') {
      // Live chat refs live nested here
      // (assistant.settings.contextWindowAnchor); strip only the anchor and
      // retain stable config such as settings/contextCount.
      if (!isPlainObject(value)) continue
      const { contextWindowAnchor: _dropped, ...rest } = value
      out[key] = { ...rest }
      continue
    }
    out[key] = value
  }
  // Fresh content, always: no topics/messages, no knowledge bodies, no MCP
  // servers. The ledger re-derives from normal actions after restore.
  out.topics = []
  return out
}

function sanitizeAssistantDefaults(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {}
  const out: Record<string, unknown> = { ...value }
  // Translate-ephemeral source text is never seeded (assistants + defaults).
  if ('content' in out) delete out.content
  const settings = out.settings
  if (isPlainObject(settings) && 'contextWindowAnchor' in settings) {
    const { contextWindowAnchor: _dropped, ...rest } = settings
    out.settings = { ...rest }
  }
  return out
}

/**
 * Project live store state into the allowlisted seed shape (capture path).
 * Sanitizes defensively: invalid leaves are dropped, never faked. Throws
 * only when the top-level slices are missing entirely (fail-closed: refuse
 * to snapshot a half-booted store).
 */
export function projectSettingsSeed(raw: unknown): Omit<SettingsSeedFile, 'kind' | 'version' | 'label' | 'updatedAt'> {
  if (!isPlainObject(raw)) {
    throw new Error('[dev-sync] refusing settings snapshot: live store state is not an object')
  }
  const { settings, llm, assistants } = raw
  if (!isPlainObject(settings)) throw new Error('[dev-sync] refusing settings snapshot: settings slice missing')
  if (!isPlainObject(llm)) throw new Error('[dev-sync] refusing settings snapshot: llm slice missing')
  if (!isPlainObject(assistants)) throw new Error('[dev-sync] refusing settings snapshot: assistants slice missing')

  const settingsOut: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    // Live chat refs never enter a seed.
    if (key === 'contextWindowAnchor') continue
    if (value === undefined || typeof value === 'function') continue
    settingsOut[key] = value
  }

  const llmOut: SettingsSeedFile['llm'] = {
    providers: sanitizeProviders(llm.providers)
  }
  const defaultModel = sanitizeModelRef(llm.defaultModel)
  const quickModel = sanitizeModelRef(llm.quickModel)
  const translateModel = sanitizeModelRef(llm.translateModel)
  if (defaultModel) llmOut.defaultModel = defaultModel
  if (quickModel) llmOut.quickModel = quickModel
  if (translateModel) llmOut.translateModel = translateModel
  if (isPlainObject(llm.settings)) llmOut.settings = { ...llm.settings }

  const rawAssistants = Array.isArray(assistants.assistants)
    ? assistants.assistants.slice(0, DEV_SYNC_SETTINGS_SEED_MAX_ASSISTANTS)
    : []
  const assistantsOut: SettingsSeedFile['assistants'] = {
    assistantDefaults: sanitizeAssistantDefaults(assistants.assistantDefaults),
    assistants: rawAssistants.map(sanitizeConfigAssistant).filter((a): a is Record<string, unknown> => a !== null),
    tagsOrder: Array.isArray(assistants.tagsOrder)
      ? (assistants.tagsOrder as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 500)
      : [],
    collapsedTags: isPlainObject(assistants.collapsedTags)
      ? Object.fromEntries(
          Object.entries(assistants.collapsedTags)
            .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
            .slice(0, 500)
        )
      : {}
  }

  const projected = { settings: settingsOut, llm: llmOut, assistants: assistantsOut }
  mustBeJsonSerializable(projected, 'projected seed')
  const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8')
  if (bytes > DEV_SYNC_SETTINGS_SEED_MAX_BYTES) {
    throw new Error(
      '[dev-sync] refusing settings snapshot: projected seed exceeds the size bound (counts only, no values)'
    )
  }
  return projected
}

/** Strict fail-closed validation of a parsed seed file (restore path). */
export function parseSettingsSeedFile(parsed: unknown, label: DevSyncSeedLabel): SettingsSeedFile {
  const fail = (what: string): never => {
    // Field/shape only — never echo values (provider secrets may be inside).
    throw new Error(`[dev-sync] refusing settings seed for profile ${label}: ${what}`)
  }
  if (!isPlainObject(parsed)) fail('top-level is not an object')
  const seed = parsed as Record<string, unknown>
  if (seed.kind !== DEV_SYNC_SETTINGS_SEED_KIND) fail(`unknown kind (${String(seed.kind).slice(0, 64)})`)
  if (seed.version !== DEV_SYNC_SETTINGS_SEED_VERSION) fail(`unknown version (${String(seed.version).slice(0, 16)})`)
  if (seed.label !== label) fail('label mismatch (refusing to cross-apply profile seeds)')
  if (typeof seed.updatedAt !== 'string') fail('updatedAt must be an ISO string')
  if (!isPlainObject(seed.settings)) fail('settings must be an object')
  if ('contextWindowAnchor' in (seed.settings as Record<string, unknown>)) fail('settings carries live chat refs')
  const settings = seed.settings as Record<string, unknown>

  if (!isPlainObject(seed.llm)) fail('llm must be an object')
  const llm = seed.llm as Record<string, unknown>
  if (!Array.isArray(llm.providers) || llm.providers.length > DEV_SYNC_SETTINGS_SEED_MAX_PROVIDERS) {
    fail('llm.providers must be an array within the count bound')
  }
  for (const provider of llm.providers as unknown[]) {
    if (!isPlainObject(provider) || typeof provider.id !== 'string' || provider.id.length === 0) {
      fail('llm.providers entries must be objects with a string id')
    }
  }
  for (const key of ['defaultModel', 'quickModel', 'translateModel'] as const) {
    const value = llm[key]
    if (value !== undefined && value !== null && !isValidModelRef(value))
      fail(`llm.${key} must be a model ref or absent`)
  }
  if (llm.settings !== undefined && !isPlainObject(llm.settings)) fail('llm.settings must be an object when present')

  if (!isPlainObject(seed.assistants)) fail('assistants must be an object')
  const assistants = seed.assistants as Record<string, unknown>
  if (!isPlainObject(assistants.assistantDefaults)) fail('assistants.assistantDefaults must be an object')
  const assistantDefaults = assistants.assistantDefaults as Record<string, unknown>
  if ('content' in assistantDefaults) fail('assistants.assistantDefaults must not carry content')
  if (isPlainObject(assistantDefaults.settings) && 'contextWindowAnchor' in assistantDefaults.settings) {
    fail('assistants.assistantDefaults must not carry live chat refs')
  }
  if (
    !Array.isArray(assistants.assistants) ||
    (assistants.assistants as unknown[]).length > DEV_SYNC_SETTINGS_SEED_MAX_ASSISTANTS
  ) {
    fail('assistants.assistants must be an array within the count bound')
  }
  for (const rawEntry of assistants.assistants as unknown[]) {
    if (isPlainObject(rawEntry) && typeof rawEntry.id === 'string') {
      const entry: Record<string, unknown> = rawEntry
      // Content/credential carriers must never be seeded.
      for (const banned of ['messages', 'knowledge_bases', 'mcpServers', 'content'] as const) {
        if (banned in entry) fail(`assistants entries must not carry ${banned}`)
      }
      if (isPlainObject(entry.settings) && 'contextWindowAnchor' in entry.settings) {
        fail('assistants entries must not carry live chat refs')
      }
      if (Array.isArray(entry.topics) && (entry.topics as unknown[]).length > 0) {
        fail('assistants entries must not carry topics')
      }
    } else {
      fail('assistants entries must be objects with a string id')
    }
  }
  if (
    !Array.isArray(assistants.tagsOrder) ||
    !(assistants.tagsOrder as unknown[]).every((t) => typeof t === 'string')
  ) {
    fail('assistants.tagsOrder must be a string array')
  }
  if (
    !isPlainObject(assistants.collapsedTags) ||
    !Object.values(assistants.collapsedTags).every((v) => typeof v === 'boolean')
  ) {
    fail('assistants.collapsedTags must be a string->boolean map')
  }

  const file: SettingsSeedFile = {
    kind: seed.kind as string,
    version: seed.version as number,
    label,
    updatedAt: seed.updatedAt as string,
    settings,
    llm: {
      providers: llm.providers as Array<Record<string, unknown>>,
      ...(llm.defaultModel != null ? { defaultModel: llm.defaultModel as Record<string, unknown> } : {}),
      ...(llm.quickModel != null ? { quickModel: llm.quickModel as Record<string, unknown> } : {}),
      ...(llm.translateModel != null ? { translateModel: llm.translateModel as Record<string, unknown> } : {})
    },
    assistants: {
      assistantDefaults: assistants.assistantDefaults as Record<string, unknown>,
      assistants: assistants.assistants as Array<Record<string, unknown>>,
      tagsOrder: assistants.tagsOrder as string[],
      collapsedTags: assistants.collapsedTags as Record<string, boolean>
    }
  }
  if (isPlainObject(llm.settings)) file.llm.settings = llm.settings
  mustBeJsonSerializable(file, 'seed file')
  return file
}

/** Load + strictly validate a profile seed; null when no seed exists yet. */
export function loadSettingsSeed(fixtureRoot: string, label: DevSyncSeedLabel): SettingsSeedFile | null {
  const file = seedFileForLabel(fixtureRoot, label)
  if (!existsSync(file)) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`[dev-sync] refusing settings seed for profile ${label}: unreadable seed file`)
  }
  if (Buffer.byteLength(text, 'utf8') > DEV_SYNC_SETTINGS_SEED_MAX_BYTES * 2) {
    throw new Error(`[dev-sync] refusing settings seed for profile ${label}: file exceeds the size bound`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error(
      `[dev-sync] refusing settings seed for profile ${label}: malformed JSON (not parsed, not overwritten)`
    )
  }
  return parseSettingsSeedFile(parsed, label)
}

/**
 * Validate + atomically persist a projected snapshot (owner-only, 0600).
 * Never silently overwrites: validation runs BEFORE any write.
 */
export function writeSettingsSeedAtomic(
  fixtureRoot: string,
  label: DevSyncSeedLabel,
  projected: Omit<SettingsSeedFile, 'kind' | 'version' | 'label' | 'updatedAt'>
): { file: string; bytes: number } {
  const file: SettingsSeedFile = {
    kind: DEV_SYNC_SETTINGS_SEED_KIND,
    version: DEV_SYNC_SETTINGS_SEED_VERSION,
    label,
    updatedAt: new Date().toISOString(),
    ...projected
  }
  // Re-validate our own projection through the strict restore path so a
  // writer bug can never publish a seed the reader would accept blindly.
  parseSettingsSeedFile(file, label)
  const text = `${JSON.stringify(file, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > DEV_SYNC_SETTINGS_SEED_MAX_BYTES * 2) {
    throw new Error(
      `[dev-sync] refusing settings snapshot for profile ${label}: serialized seed exceeds the size bound`
    )
  }
  mkdirSync(fixtureRoot, { recursive: true })
  const target = seedFileForLabel(fixtureRoot, label)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
    renameSync(tmp, target)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Best effort temp cleanup.
    }
    throw new Error(`[dev-sync] failed to publish the settings seed for profile ${label}`)
  }
  try {
    chmodSync(target, 0o600)
  } catch {
    // Best effort: the atomic rename already published owner-only bytes.
  }
  return { file: target, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * Build the ordered store dispatches that restore a validated seed through
 * existing public reducer actions only (no new production IPC). Settings
 * fields without a setter and fixture-owned keys are skipped, never faked.
 */
export function buildSeedRestoreDispatches(seed: SettingsSeedFile): StoreDispatch[] {
  const dispatches: StoreDispatch[] = []
  const excluded = new Set<string>([...SETTINGS_RESTORE_EXCLUDED_KEYS, ...SETTINGS_NO_SETTER_KEYS])
  for (const [key, action] of SETTINGS_RESTORE_TABLE) {
    if (excluded.has(key)) continue
    if (!(key in seed.settings)) continue
    dispatches.push({ type: action, payload: seed.settings[key] })
  }
  // Split setters for nested settings objects.
  const openAI = seed.settings.openAI
  if (isPlainObject(openAI)) {
    if (openAI.summaryText !== undefined) {
      dispatches.push({ type: 'settings/setOpenAISummaryText', payload: openAI.summaryText })
    }
    if (openAI.verbosity !== undefined) {
      dispatches.push({ type: 'settings/setOpenAIVerbosity', payload: openAI.verbosity })
    }
    if (isPlainObject(openAI.streamOptions) && openAI.streamOptions.includeUsage !== undefined) {
      dispatches.push({
        type: 'settings/setOpenAIStreamOptionsIncludeUsage',
        payload: openAI.streamOptions.includeUsage
      })
    }
  }
  const apiServer = seed.settings.apiServer
  if (isPlainObject(apiServer)) {
    if (typeof apiServer.enabled === 'boolean') {
      dispatches.push({ type: 'settings/setApiServerEnabled', payload: apiServer.enabled })
    }
    if (typeof apiServer.port === 'number') {
      dispatches.push({ type: 'settings/setApiServerPort', payload: apiServer.port })
    }
    if (typeof apiServer.apiKey === 'string') {
      dispatches.push({ type: 'settings/setApiServerApiKey', payload: apiServer.apiKey })
    }
  }
  dispatches.push({ type: 'llm/updateProviders', payload: seed.llm.providers })
  if (seed.llm.defaultModel) dispatches.push({ type: 'llm/setDefaultModel', payload: { model: seed.llm.defaultModel } })
  if (seed.llm.quickModel) dispatches.push({ type: 'llm/setQuickModel', payload: { model: seed.llm.quickModel } })
  if (seed.llm.translateModel) {
    dispatches.push({ type: 'llm/setTranslateModel', payload: { model: seed.llm.translateModel } })
  }
  const keepAlive = seed.llm.settings
  if (isPlainObject(keepAlive)) {
    for (const [key, action] of [
      ['ollama', 'llm/setOllamaKeepAliveTime'],
      ['lmstudio', 'llm/setLMStudioKeepAliveTime'],
      ['gpustack', 'llm/setGPUStackKeepAliveTime']
    ] as const) {
      const group = keepAlive[key]
      if (isPlainObject(group) && typeof group.keepAliveTime === 'number') {
        dispatches.push({ type: action, payload: group.keepAliveTime })
      }
    }
  }
  dispatches.push({ type: 'assistants/updateAssistantDefaults', payload: seed.assistants.assistantDefaults })
  dispatches.push({ type: 'assistants/updateAssistants', payload: seed.assistants.assistants })
  return dispatches
}

/**
 * Redacted one-line summary for terminal logs: counts and key names only —
 * never provider secrets, prompts, or content.
 */
export function summarizeSeedForLog(
  seed: Pick<SettingsSeedFile, 'label' | 'settings' | 'llm' | 'assistants'>,
  what: string
): string {
  const providerCount = seed.llm.providers.length
  const assistantCount = seed.assistants.assistants.length
  const settingsKeys = Object.keys(seed.settings).length
  return (
    `[dev-sync] settings seed for profile ${seed.label} ${what}: ` +
    `${settingsKeys} settings keys, ${providerCount} providers, ${assistantCount} assistants`
  )
}
