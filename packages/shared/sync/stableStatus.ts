/**
 * Authoritative stable-checkpoint predicates for personal multi-device sync.
 * JSON-only, no Node/Electron imports.
 *
 * Only stable user-visible checkpoints sync. Intermediate statuses
 * `streaming`, `pending`, `processing`, `searching` must not be enqueued.
 * Final statuses `success`, `error`, `paused` sync.
 *
 * Any other value (including null/undefined/unknown legacy values such as
 * `sent`) is treated as stable so pre-existing data keeps syncing; only the
 * four explicit intermediate statuses suppress capture.
 */

export const SYNC_TRANSIENT_STATUSES = ['streaming', 'pending', 'processing', 'searching'] as const

export const SYNC_STABLE_STATUSES = ['success', 'error', 'paused'] as const

export type SyncTransientStatus = (typeof SYNC_TRANSIENT_STATUSES)[number]
export type SyncStableStatus = (typeof SYNC_STABLE_STATUSES)[number]

const TRANSIENT_SET: ReadonlySet<string> = new Set<string>([...SYNC_TRANSIENT_STATUSES])

/** True when the committed row status is an intermediate (non-syncable) checkpoint. */
export function isTransientSyncStatus(status: unknown): boolean {
  return typeof status === 'string' && TRANSIENT_SET.has(status)
}

/** True when the committed row status is a stable user-visible checkpoint. */
export function isStableSyncStatus(status: unknown): boolean {
  return !isTransientSyncStatus(status)
}

/** Message stable checkpoint (committed `messages.status` value). */
export function isStableMessageStatus(status: unknown): boolean {
  return isStableSyncStatus(status)
}

/** Block stable checkpoint (committed `message_blocks.status` value). */
export function isStableBlockStatus(status: unknown): boolean {
  return isStableSyncStatus(status)
}

/**
 * Unsupported structured/attachment-bearing block gate (LOCK-PERSONAL-004).
 *
 * Only stable, fully representable checkpoints sync. A block whose canonical
 * content lives outside the sync allowlisted string columns (payloadFilter
 * BLOCK_ALLOW) must never emit a partial null-content shell. Ordinary text
 * blocks (string content, empty overflow) return false and keep syncing.
 *
 * Unsupported when any holds:
 * - `overflow.content` is present (canonical object content, e.g. tool blocks
 *   where the TEXT column is null and the object lives in overflow).
 * - `type` is attachment/structured (`tool`, `file`, `image`, `video`,
 *   `citation`) whose canonical payload is binary/structured, never the
 *   allowlisted string `content` alone.
 * - `overflow` carries attachment/structured canonical keys (`file`,
 *   `fileId`/`file_id`, `response`, `knowledge`, `memories`, `toolId`,
 *   `arguments`, `url`, or the import-only degraded marker
 *   `l2AttachmentUnavailable`).
 *
 * Pure JSON-only predicate; callers skip enqueue and record a durable
 * explicit unsupported capture outcome via the existing capture-error
 * mechanism (no new schema). No-op/foreign rows remain the caller's
 * non-error path and never reach this predicate.
 */
const UNSUPPORTED_SYNC_BLOCK_TYPES: ReadonlySet<string> = new Set(['tool', 'file', 'image', 'video', 'citation'])

const UNSUPPORTED_SYNC_BLOCK_OVERFLOW_KEYS: ReadonlyArray<string> = [
  'content',
  'file',
  'fileId',
  'file_id',
  'response',
  'knowledge',
  'memories',
  'toolId',
  'arguments',
  'url',
  'l2AttachmentUnavailable'
]

export function isUnsupportedBlockForSync(block: {
  type: string | null | undefined
  overflow?: Record<string, unknown> | null | undefined
}): boolean {
  const overflow = block?.overflow
  if (overflow && typeof overflow === 'object' && !Array.isArray(overflow)) {
    for (const k of UNSUPPORTED_SYNC_BLOCK_OVERFLOW_KEYS) {
      if (Object.prototype.hasOwnProperty.call(overflow, k)) return true
    }
  }
  const t = typeof block?.type === 'string' ? block.type.toLowerCase() : ''
  if (UNSUPPORTED_SYNC_BLOCK_TYPES.has(t)) return true
  return false
}
