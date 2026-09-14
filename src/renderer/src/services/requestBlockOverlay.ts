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
