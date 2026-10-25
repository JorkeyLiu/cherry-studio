import type { MessageBlock } from '@renderer/types/newMessage'

/**
 * Request-local block overlay for semantic resend/regenerate.
 *
 * Carries the Main-authoritative user blocks for exactly one request
 * conversion without injecting window-outside blocks into Redux. The overlay
 * is read-only, never dispatched, and never persisted — it only shadows the
 * Redux block lookup for IDs it contains.
 */
export type BlockOverlay = ReadonlyMap<string, MessageBlock>

export function buildBlockOverlay(blocks: MessageBlock[] | undefined | null): BlockOverlay {
  const map = new Map<string, MessageBlock>()
  if (!blocks) return map
  for (const block of blocks) {
    if (block && typeof block.id === 'string' && block.id.length > 0) {
      map.set(block.id, block)
    }
  }
  return map
}

export function resolveOverlayBlock(
  overlay: BlockOverlay | undefined | null,
  blockId: string
): MessageBlock | undefined {
  if (!overlay) return undefined
  return overlay.get(blockId)
}

/**
 * Merge a request-local authority overlay over a closure base (override wins).
 *
 * The base carries the caller-local Main closure blocks (anchor-to-end); the
 * override carries the fresh triggering user blocks (semantic resend/regenerate
 * authority snapshot). Same IDs resolve to the override so the triggering
 * content is fresh without injecting window-outside blocks into Redux. Pure,
 * readonly, never dispatched, never persisted.
 */
export function mergeBlockOverlays(
  base: BlockOverlay | undefined | null,
  override: BlockOverlay | undefined | null
): BlockOverlay {
  if (!override || override.size === 0) return base ?? new Map<string, MessageBlock>()
  if (!base || base.size === 0) return override
  const merged = new Map<string, MessageBlock>(base)
  for (const [id, block] of override) {
    merged.set(id, block)
  }
  return merged
}
