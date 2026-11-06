import type { TopicBranchWire } from '@renderer/services/db/types'
import type { TFunction } from 'i18next'

/**
 * Pure facts for topic-internal forks.
 *
 * A fork is an inheritance relation between a parent route and its direct
 * child branches, so both WHERE it renders and WHAT it says are single facts
 * shared by every surface that draws it: the message stream's fork divider and
 * the message-outline rail must never disagree. Keeping the resolution in this
 * module (types plus the translator signature only) lets the outline data
 * controller reuse it without dragging in the message-flow rendering graph.
 */

/** One anchor's direct children, grouped by the route they fork from. */
export interface ForkChildGroup {
  /** Parent route of this fork's children (null = main route). */
  parentBranchId: string | null
  children: TopicBranchWire[]
}

/** Group one anchor's direct children by their parent route (null = main route). */
export function groupForkChildrenByParent(children: readonly TopicBranchWire[]): ForkChildGroup[] {
  const byParent = new Map<string | null, TopicBranchWire[]>()
  for (const c of children) {
    const key = c.parentBranchId ?? null
    const list = byParent.get(key) ?? []
    list.push(c)
    byParent.set(key, list)
  }
  const out: ForkChildGroup[] = []
  for (const [parentBranchId, list] of byParent) {
    list.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
    out.push({ parentBranchId, children: list })
  }
  // Deterministic group order: main-route forks first, then by first child.
  out.sort((a, b) => {
    if ((a.parentBranchId === null) !== (b.parentBranchId === null)) return a.parentBranchId === null ? -1 : 1
    const aid = a.children[0]?.id ?? ''
    const bid = b.children[0]?.id ?? ''
    return aid.localeCompare(bid)
  })
  return out
}

/**
 * The child branch taken by the viewed route at an anchor, if any: the
 * branch on the root-first `path` whose anchor is `anchorMessageId`.
 * Siblings considered are exactly the direct children at the anchor.
 */
export function takenChildAtAnchor(
  path: readonly TopicBranchWire[],
  anchorMessageId: string,
  childrenAtAnchor: readonly TopicBranchWire[]
): TopicBranchWire | undefined {
  const childIds = new Set(childrenAtAnchor.map((c) => c.id))
  return path.find((b) => b.anchorMessageId === anchorMessageId && childIds.has(b.id))
}

/** Display name of a branch: its name, or its stable id when unnamed. */
export const branchDisplayName = (branch: TopicBranchWire): string =>
  branch.name && branch.name.length > 0 ? branch.name : branch.id

/** Where one fork relation renders, and under which message. */
export interface ForkPlacement {
  /**
   * `'message'`: the fork renders under `boundaryMessageId`, the last
   * inherited message Main reports for the relation. `'head'`: the fork
   * inherits nothing, so it renders at the history head of its parent route —
   * a relation position, not a row.
   */
  placement: 'message' | 'head'
  /** Resident message the fork renders under (null for a head boundary). */
  boundaryMessageId: string | null
}

/**
 * Resolve the placement of ONE fork relation (one anchor's children on one
 * parent route) from the Main-authoritative inheritance boundary.
 *
 * `children` is a single group from `groupForkChildrenByParent`: every child of
 * a group shares the relation's boundary, so the first child carries it.
 *
 * - `'message'` boundary → the last inherited message, because the fork starts
 *   where the inherited history actually ends rather than on a fixed anchor row.
 * - `'head'` boundary → nothing is inherited, so there is no message to render
 *   under: the caller decides whether the head position is on its route.
 * - Unknown boundary (a wire captured before the fact existed) → the anchor row
 *   itself, exactly the pre-existing placement. Absence of the fact is never
 *   evidence of an empty prefix.
 */
export function resolveForkPlacement(children: readonly TopicBranchWire[], anchorMessageId: string): ForkPlacement {
  const boundary = children[0]?.inheritedBoundary
  if (boundary?.kind === 'head') return { placement: 'head', boundaryMessageId: null }
  return {
    placement: 'message',
    boundaryMessageId: boundary?.kind === 'message' ? boundary.messageId : anchorMessageId
  }
}

/**
 * The text one fork relation carries on the viewed route — the single
 * two-state decision behind BOTH surfaces that draw it (the message stream's
 * divider and the outline's fork marker):
 *
 * - the route travels a child of this fork → that branch's name;
 * - the route stays on the parent route → `chat.topics.branch.children_here`
 *   with the fork's direct child count, the branches the reader can switch to.
 *
 * The i18n key is referenced only here, so the two surfaces cannot drift into
 * one naming the branch while the other shows nothing.
 */
export function forkMarkerLabel(
  taken: TopicBranchWire | undefined,
  children: readonly TopicBranchWire[],
  t: TFunction
): string {
  return taken ? branchDisplayName(taken) : t('chat.topics.branch.children_here', { count: children.length })
}
