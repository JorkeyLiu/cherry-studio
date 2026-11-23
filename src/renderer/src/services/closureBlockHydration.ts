/**
 * Hydration-mode rule for an authoritative context-closure publication.
 *
 * Single owner of the decision "may this response's block bytes be written into
 * the live block store?" — shared by every closure publication site
 * (`useContextClosure`, `useContextWindowAnchor`) so the rule is not duplicated.
 *
 * Context: continuous same-block streaming deltas advance the content revision
 * (`contextClosure.contentGenerations`) WITHOUT advancing any structural
 * generation. The authoritative closure read remains authoritative for
 * STRUCTURE (roster/messages, counts, boundary, folded set, anchor) — Main
 * computes those from the roster/fold, never from block bodies — while the
 * response's block bodies may predate deltas mirrored after the fetch started.
 * Discarding the whole response on a content advance would therefore lose
 * authoritative structure and leave the projection authority-pending; publishing
 * its block bytes wholesale would let a stale body overwrite a newer live delta.
 *
 * So a content advance changes ONLY the hydration strategy:
 *
 * - `full`   — content revision unchanged since fetch start: publish the whole
 *              authoritative block snapshot (pre-existing behavior).
 * - `gap-fill` — content revision advanced: publish ONLY roster blocks that are
 *              currently absent from the live store (missing rows still render,
 *              no stale body ever overwrites a live one).
 *
 * Fail-closed: a block without a usable string id is never published under
 * `gap-fill` (its live identity cannot be proven). Structural staleness
 * (generation/global/deletion/anchor/route) is guarded by the caller BEFORE
 * this helper; this helper never claims structural freshness.
 */

export type ClosureHydrationMode = 'full' | 'gap-fill'

export function selectClosureBlocksForHydration<T>(
  blocks: readonly T[],
  hasLiveEntity: (id: string) => boolean,
  contentAdvanced: boolean
): { mode: ClosureHydrationMode; blocks: T[] } {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { mode: contentAdvanced ? 'gap-fill' : 'full', blocks: [] }
  }
  if (!contentAdvanced) return { mode: 'full', blocks: blocks.slice() }
  const publishable: T[] = []
  for (const block of blocks) {
    const id = (block as { id?: unknown } | null | undefined)?.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (hasLiveEntity(id)) continue
    publishable.push(block)
  }
  return { mode: 'gap-fill', blocks: publishable }
}
