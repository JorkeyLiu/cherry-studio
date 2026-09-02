/**
 * Allowlisted payload serialization for sync operations.
 * Strips credentials, FTS, UI state, contextWindowAnchor, file_path binary etc.
 */

// Allowlisted topic fields — deletedAt included for soft-delete sync (hard delete uses op=delete)
const TOPIC_ALLOW = new Set(['id', 'name', 'createdAt', 'updatedAt', 'assistantId', 'deletedAt'])
// Message allowlist
const MESSAGE_ALLOW = new Set([
  'id',
  'topicId',
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt',
  'sortOrder'
])
// Block allowlist — never file_path, never binary, no extra file metadata
const BLOCK_ALLOW = new Set(['id', 'messageId', 'type', 'content', 'status', 'createdAt', 'updatedAt', 'sortOrder'])

// Denied substrings (defense-in-depth)
const DENIED_KEYS = new Set(['file_path', 'filePath', 'credentials', 'token', 'password', 'secret'])

export function filterTopicPayload(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (!TOPIC_ALLOW.has(k)) continue
    if (DENIED_KEYS.has(k)) continue
    const v = raw[k]
    if (v !== undefined) out[k] = v
  }
  // Strip any extra file_path that slipped via overflow
  delete (out as any).file_path
  delete (out as any).filePath
  return out
}

export function filterMessagePayload(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (!MESSAGE_ALLOW.has(k)) continue
    if (DENIED_KEYS.has(k)) continue
    const v = raw[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

export function filterBlockPayload(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (!BLOCK_ALLOW.has(k)) continue
    if (DENIED_KEYS.has(k)) continue
    const v = raw[k]
    if (v !== undefined) out[k] = v
  }
  // Never include binary content for image/file blocks beyond allowlist — extra is excluded
  return out
}

export function isPayloadSafe(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true
  const obj = payload as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase()
    if (
      lk.includes('credential') ||
      lk.includes('password') ||
      lk.includes('secret') ||
      lk === 'file_path' ||
      lk === 'filepath'
    ) {
      return false
    }
    // Recursively check nested objects shallowly
    const v = obj[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!isPayloadSafe(v)) return false
    }
  }
  return true
}

export function validateSyncPayloadAllowlist(op: {
  entityType: string
  payload?: Record<string, unknown>
}): string | null {
  if (!op.payload) return null
  if (!isPayloadSafe(op.payload)) return 'payload contains denied field'
  // Check FTS derived tables never synced
  if ('fts' in op.payload || 'fts_content' in op.payload) return 'fts field denied'
  if ('contextWindowAnchor' in op.payload) return 'contextWindowAnchor denied'
  // Ensure only allowlisted keys
  const allow = op.entityType === 'topic' ? TOPIC_ALLOW : op.entityType === 'message' ? MESSAGE_ALLOW : BLOCK_ALLOW
  for (const k of Object.keys(op.payload)) {
    if (!allow.has(k)) return `field ${k} not allowlisted for ${op.entityType}`
  }
  return null
}
