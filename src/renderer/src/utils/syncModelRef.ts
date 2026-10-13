import type { Model } from '@renderer/types'

/**
 * Sync ModelRef decode + persisted repair (pure, store/net-free).
 *
 * Wire DTO (shared/sync/assistantConfig `AssistantModelRef`):
 *   { connectionId, modelId, displayName?, group? }
 * Runtime Model:
 *   { id, provider, name, group, ...extras }
 *
 * Rules (user-authorized bugfix scope only):
 * - Only valid non-empty string ids are recognized. No provider-list,
 *   network metadata, model-name matching, or hidden global fallback.
 * - Already-legal runtime Models keep identity/extras untouched.
 * - Unknown malformed values are left untouched (never "cleaned").
 * - Presentation fallback is deterministic: name = displayName (non-blank)
 *   else modelId, group = group string else ''. No brand special-casing.
 * - Explicit null means clear to unconfigured (undefined at apply time);
 *   absent/undefined means preserve. Null never becomes a truthy no-id object.
 */

interface SyncModelDto {
  connectionId: string
  modelId: string
  displayName?: string
  group?: string
}

const DTO_KEYS = new Set(['connectionId', 'modelId', 'displayName', 'group'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isValidSyncModelDto(value: unknown): value is SyncModelDto {
  if (!isPlainObject(value)) return false
  for (const key of Object.keys(value)) {
    if (!DTO_KEYS.has(key)) return false
  }
  if (!isNonEmptyId(value.connectionId) || !isNonEmptyId(value.modelId)) return false
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return false
  if (value.group !== undefined && typeof value.group !== 'string') return false
  return true
}

/**
 * Already-legal runtime guard (mirrors effectiveModel serving identity only:
 * non-empty id + provider). Display/group are never required here.
 * Mixed DTO+runtime shapes fail closed as unknown (never guessed).
 */
export function isValidRuntimeModel(value: unknown): value is Model {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  if ('connectionId' in rec || 'modelId' in rec) return false
  return isNonEmptyId(rec.id) && isNonEmptyId(rec.provider)
}

export function decodeSyncModelDto(dto: SyncModelDto): Model {
  const displayName =
    typeof dto.displayName === 'string' && dto.displayName.trim().length > 0 ? dto.displayName : dto.modelId
  const group = typeof dto.group === 'string' ? dto.group : ''
  return {
    id: dto.modelId,
    provider: dto.connectionId,
    name: displayName,
    group
  } as Model
}

export type ModelSlotDecision = { action: 'preserve' } | { action: 'set'; value: Model | undefined }

/**
 * Decode one incoming model slot for the live apply path.
 * - undefined (absent) -> preserve existing.
 * - null (explicit clear) -> set undefined (unconfigured, falsy).
 * - valid DTO -> decode; same id/provider as local keeps local extras
 *   (capabilities/pricing/etc) with only id/provider/name/group refreshed.
 *   Different identity takes the fresh decoded base with no inherited extras.
 * - valid runtime Model -> same-identity keeps local extras with incoming
 *   base display; different identity takes incoming as-is.
 * - anything else (unknown malformed) -> preserve (never pollute, never clean).
 */
export function decodeModelSlotForApply(incoming: unknown, local: unknown): ModelSlotDecision {
  if (incoming === undefined) return { action: 'preserve' }
  if (incoming === null) return { action: 'set', value: undefined }
  if (isValidSyncModelDto(incoming)) {
    const base = decodeSyncModelDto(incoming)
    if (isValidRuntimeModel(local) && local.id === base.id && local.provider === base.provider) {
      if (local.name === base.name && local.group === base.group) return { action: 'preserve' }
      return {
        action: 'set',
        value: {
          ...(local as object),
          id: base.id,
          provider: base.provider,
          name: base.name,
          group: base.group
        } as Model
      }
    }
    return { action: 'set', value: base }
  }
  if (isValidRuntimeModel(incoming)) {
    const localValid = isValidRuntimeModel(local) ? local : null
    if (localValid && localValid.id === incoming.id && localValid.provider === incoming.provider) {
      const incomingName =
        typeof incoming.name === 'string' && incoming.name.length > 0 ? incoming.name : localValid.name
      const incomingGroup = typeof incoming.group === 'string' ? incoming.group : localValid.group
      if (localValid.name === incomingName && localValid.group === incomingGroup) return { action: 'preserve' }
      return {
        action: 'set',
        value: {
          ...(localValid as object),
          id: incoming.id,
          provider: incoming.provider,
          name: incomingName,
          group: incomingGroup
        } as Model
      }
    }
    return { action: 'set', value: incoming }
  }
  return { action: 'preserve' }
}

/** Persisted-read repair for one slot: valid DTO -> Model, else same reference. */
export function repairPersistedModelSlot(value: unknown): unknown {
  if (isValidSyncModelDto(value)) return decodeSyncModelDto(value)
  return value
}

function repairSettingsObject(settings: unknown, localForMerge?: never): { changed: boolean; value: unknown } {
  if (!isPlainObject(settings)) return { changed: false, value: settings }
  if (!('defaultModel' in settings)) return { changed: false, value: settings }
  localForMerge
  const before = settings.defaultModel
  const after = repairPersistedModelSlot(before)
  if (after === before) return { changed: false, value: settings }
  return { changed: true, value: { ...settings, defaultModel: after } }
}

/**
 * Repair one assistant/defaults record. Returns the same reference when
 * nothing changed (identity-preserving, copy-on-write). Never throws on
 * legacy shapes; non-records pass through.
 */
export function repairAssistantRecord(record: unknown): unknown {
  if (!isPlainObject(record)) return record
  let changed = false
  let next: Record<string, unknown> = record

  const setSlot = (key: string, before: unknown): void => {
    const after = repairPersistedModelSlot(before)
    if (after !== before) {
      if (!changed) {
        next = { ...record }
        changed = true
      }
      next[key] = after
    }
  }

  if ('model' in next) setSlot('model', next.model)
  if ('defaultModel' in next) setSlot('defaultModel', next.defaultModel)
  if ('settings' in next && isPlainObject(next.settings)) {
    const repaired = repairSettingsObject(next.settings)
    if (repaired.changed) {
      if (!changed) {
        next = { ...record }
        changed = true
      }
      next.settings = repaired.value
    }
  }
  return changed ? next : record
}

/**
 * Repair the persisted `assistants` slice (assistants[] + assistantDefaults).
 * Only recognizable valid DTO slots are decoded; legal Models, unknown
 * malformed values, tombstone topics, other settings, and llm state are
 * untouched. Missing slice/keys or non-records pass through without throwing.
 */
export function repairAssistantsSlice(slice: unknown): unknown {
  if (!isPlainObject(slice)) return slice
  let changed = false
  let next: Record<string, unknown> = slice

  if ('assistants' in next && Array.isArray(next.assistants)) {
    const list = next.assistants as unknown[]
    let listChanged = false
    const repairedList = list.map((item) => {
      const repaired = repairAssistantRecord(item)
      if (repaired !== item) listChanged = true
      return repaired
    })
    if (listChanged) {
      next = { ...next }
      next.assistants = repairedList
      changed = true
    }
  }

  if ('assistantDefaults' in next && isPlainObject(next.assistantDefaults)) {
    const repaired = repairAssistantRecord(next.assistantDefaults)
    if (repaired !== next.assistantDefaults) {
      if (!changed) next = { ...next }
      next.assistantDefaults = repaired
      changed = true
    }
  }

  return changed ? next : slice
}

/** redux -> storage: assistants carry runtime Models already; no encoding. */
export function assistantsInboundForPersist(state: unknown): unknown {
  return state
}

/** storage -> redux: repair recognizable DTO slots only. */
export function assistantsOutboundFromPersist(stored: unknown): unknown {
  return repairAssistantsSlice(stored)
}
