import {
  captureTerminalReadWitness,
  routeKeyForExecutionOverlay,
  type TerminalReadWitness
} from '@renderer/services/executionOverlayRegistry'
import type { FetchContextClosureResponse } from '@shared/chatDb'

/**
 * Read receipt for one accepted closure response (NOT a data authority).
 *
 * Pairs the exact accepted `FetchContextClosureResponse` object with the
 * terminal-read witness captured synchronously when its read was issued.
 * Stored in a `WeakMap` keyed by the exact response object: read metadata
 * only (execution identities + terminal tokens), never body content, never a
 * retained history. A cache hit returns the same object it published, so it
 * keeps its original read's receipt; a cache entry predating receipts (or a
 * failed/invalid read, which is never bound) yields no receipt and its route
 * must retain (fail-closed).
 *
 * Sole owner of capture/attach/get. Read issuers (`useContextClosure` fetch,
 * `useContextWindowAnchor` resolve) capture before dispatch and bind after
 * acceptance; consumers (`useContextPresentation` handoff) only get.
 */
const receipts = new WeakMap<object, TerminalReadWitness>()

/**
 * Capture the witness synchronously at read-issue time (no await between
 * this call and the read dispatch), so terminals acked mid-read are excluded.
 */
export function captureClosureReadReceipt(topicId: string, route: string | null): TerminalReadWitness {
  return captureTerminalReadWitness(routeKeyForExecutionOverlay(topicId, route))
}

/** Bind the exact accepted response object to its read witness. Same object must flow to cache + accept. */
export function bindClosureReadReceipt(response: FetchContextClosureResponse, witness: TerminalReadWitness): void {
  receipts.set(response, witness)
}

/** Read-side witness for one exact accepted response, or undefined when never bound (retain). */
export function getClosureReadReceipt(
  response: FetchContextClosureResponse | null | undefined
): TerminalReadWitness | undefined {
  if (!response || typeof response !== 'object') return undefined
  return receipts.get(response)
}
