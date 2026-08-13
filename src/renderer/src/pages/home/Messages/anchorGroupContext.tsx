import type { ReactNode } from 'react'
import { createContext, use } from 'react'

/**
 * Messages-scoped projection of the single resolved context-window anchor.
 *
 * The provider value is the canonical `anchorGroupKey` produced by the parent
 * Messages `computeContextInfo` memo: the start turn's group key
 * for a non-empty context window, `null` otherwise. It carries a stable
 * `string | null` and is deliberately decoupled from persisted anchor
 * source state — the persisted anchor, first establishment, re-anchor, and
 * deletion transfer all resolve to this same projected key. UI consumers
 * never inspect the origin of the anchor.
 *
 * Consumed by MessageMenubar for the anchor-icon highlight. The semantic
 * resolved anchor is universal (it exists for every non-empty window regardless
 * of message role); the exactly-one *visible* highlighted button is a user-led
 * UI invariant because the anchor button renders only on user messages. The
 * hook is intentionally safe outside the provider (returns `null`), so isolated
 * renders and other windows never highlight an anchor spuriously.
 */
const AnchorGroupContext = createContext<string | null>(null)

export function AnchorGroupProvider({
  anchorGroupKey,
  children
}: {
  anchorGroupKey: string | null
  children: ReactNode
}) {
  return <AnchorGroupContext value={anchorGroupKey}>{children}</AnchorGroupContext>
}

export function useAnchorGroupKey(): string | null {
  return use(AnchorGroupContext)
}
