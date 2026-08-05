/**
 * Renderer-side read of the import-only `l2AttachmentUnavailable` block
 * overflow marker (LOCK-UI-1).
 *
 * The marker round-trips through the block wire adapters as a top-level
 * block property (`block.l2AttachmentUnavailable === true`). This predicate
 * is the single strict read used by rendered message blocks (ImageBlock /
 * MessageAttachments): only the exact boolean `true` marks a degraded
 * imported attachment. Absent or any non-`true` value keeps the current
 * behavior (LOCK-UI-1/4).
 *
 * Never a per-render existence lookup — the marker is the persisted source of
 * truth (LOCK-UI-4).
 */
export function isBlockAttachmentUnavailable(block: { l2AttachmentUnavailable?: boolean }): boolean {
  return block.l2AttachmentUnavailable === true
}
