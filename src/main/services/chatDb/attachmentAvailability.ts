/**
 * Import-only per-block attachment availability marker (LOCK-UI-1..6).
 *
 * Degraded imported image/file attachments (Phase 1 L2 attachment
 * compatibility) have NO durable Dexie catalog row and NO physical payload,
 * yet their message blocks + SQLite file_reference rows ARE imported (the
 * data plane derives file references from projected file/image blocks).
 *
 * To make degraded attachment availability deterministic across reloads
 * WITHOUT per-render filesystem IPC and WITHOUT creating fake payload/
 * catalog rows, the orchestrator persists an import-only marker into the
 * affected message blocks' overflow (the `extra` JSON column) BEFORE the
 * candidate is sealed (LOCK-UI-4). The renderer reads the marker through
 * the existing block wire path and shows an unavailable placeholder
 * instead of attempting a preview/open against a missing file.
 *
 * Locked contract:
 * - LOCK-UI-1: the marker is import-only block overflow metadata — a narrow
 *   namespaced top-level overflow key matching house style (the `l2`
 *   importer-owned prefix, exactly like `l2TrashRetentionStartedAt` on
 *   topics). NEVER `status = ERROR` and never a SQL schema column.
 * - The marker is a single boolean `true` at `overflow.l2AttachmentUnavailable`
 *   which round-trips through the block wire adapters as
 *   `block.l2AttachmentUnavailable === true` (JSON-wire-safe, narrowly
 *   local). A dedicated top-level key — rather than a nested metadata-bag
 *   key — guarantees LOCK-UI-6 digest equivalence: stripping the key
 *   restores the byte-exact original overflow for EVERY input (no
 *   created-bag-vs-absent asymmetry).
 * - LOCK-UI-3: setting the marker NEVER alters the original block/file
 *   metadata, columns, or file_reference rows — only the marker key is
 *   added; every other overflow key is preserved byte-for-byte.
 * - LOCK-UI-5/8: the marker value never carries source paths, filenames,
 *   content, or file IDs — it is a pure boolean.
 *
 * Main-only module (like trashRetention.ts). Never expose over IPC/preload/
 * renderer as an API — the renderer consumes the marker key through the
 * ordinary block wire contract.
 */

/**
 * Importer-owned namespaced marker key on the block overflow (LOCK-UI-1).
 * A present `true` means the referenced attachment is unavailable
 * (degraded) — display metadata stays intact.
 */
export const L2_ATTACHMENT_UNAVAILABLE_MARKER = 'l2AttachmentUnavailable'

/**
 * True when the block overflow already carries the unavailable marker with
 * the exact boolean `true` value. Any other value (absent, non-boolean,
 * `false`) is NOT marked — the marker contract is strict.
 */
export function isBlockAttachmentUnavailable(overflow: Record<string, unknown>): boolean {
  return overflow[L2_ATTACHMENT_UNAVAILABLE_MARKER] === true
}

/**
 * Return a NEW block overflow carrying the unavailable marker (LOCK-UI-3).
 *
 * - Idempotent: an already-marked overflow is returned unchanged (same
 *   reference).
 * - The input is never mutated; every original overflow key (file metadata,
 *   tool content, unknown JSON) is preserved byte-for-byte.
 * - A source block without the marker simply gains the boolean key — never
 *   a fake file, never a status change, never a schema column.
 */
export function markBlockAttachmentUnavailable(overflow: Record<string, unknown>): Record<string, unknown> {
  if (isBlockAttachmentUnavailable(overflow)) {
    return overflow
  }
  return { ...overflow, [L2_ATTACHMENT_UNAVAILABLE_MARKER]: true }
}

/**
 * Return a block overflow WITHOUT the unavailable marker (LOCK-UI-6 digest
 * semantics).
 *
 * The marker is applied AFTER the source verification manifest is built
 * (the degraded set exists only after attachment reconciliation), so it is
 * NOT source evidence. The shared entity digest framing uses this helper so
 * the manifest-side and candidate-side block digests stay comparable: the
 * marker is deterministically excluded from the record and overflow digests.
 *
 * - When the marker is absent the SAME object reference is returned (the
 *   digest computation never mutates, so existing digests are unchanged).
 * - When present, ONLY the marker key is removed — the restored overflow is
 *   byte-exact with the pre-marker overflow (LOCK-UI-6 determinism).
 */
export function stripBlockAttachmentUnavailableMarker(overflow: Record<string, unknown>): Record<string, unknown> {
  if (!(L2_ATTACHMENT_UNAVAILABLE_MARKER in overflow)) {
    return overflow
  }
  const next = { ...overflow }
  delete next[L2_ATTACHMENT_UNAVAILABLE_MARKER]
  return next
}
