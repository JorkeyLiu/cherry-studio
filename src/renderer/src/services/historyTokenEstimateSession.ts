import store from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import type { Assistant } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'

import { estimateTextTokens } from './LocalTokenEstimator'
import { estimateMessageUsage } from './TokenService'

/**
 * Bounded per-route history token estimation session for the UI token preview.
 *
 * Scope: only the explicit-snapshot UI path (`usePromptTokenEstimate` with a
 * caller-owned `SnapshotBlockMap` block snapshot, or the store-once fallback
 * captured below) routes through a session. Provider/request paths
 * (`estimateMessagesUsage`, `ConversationService`, usage backfills) never touch
 * it, and the legacy `estimateHistoryTokens` behavior without `snapshotBlocks`
 * is unchanged.
 *
 * What a session does:
 * - Keeps the per-message estimate promise/result ONLY for the exact message
 *   set of the latest accepted call (`reset` on route/anchor identity change,
 *   prune on every call). There is no global map and no cross-route reuse:
 *   the entry count is always bounded by the current selected set.
 * - Reuses an entry only when the message object reference AND every block
 *   entity reference in `message.blocks` order (including missing refs) AND
 *   `includeMedia` are all unchanged. Any reference change re-estimates the
 *   whole message with the exact current token algorithm — never by
 *   incrementally adding string tokenizers (tokenizers are not linear).
 * - Closes inputs synchronously per call: block references are captured
 *   before the first await (explicit map when provided, otherwise one
 *   synchronous store read), and each per-message estimate runs against a
 *   caller-local closed `SnapshotBlockMap` built from those captured refs —
 *   the mutable global map is never read late in async continuations.
 *   The system prompt is estimated fresh on every call, so a prompt change
 *   never invalidates stable history entries.
 * - Overlap-safe: a stale run's late rejection deletes a cache entry only
 *   when it is still the identical promise object (identity compare), so it
 *   can never remove a newer run's entry. Failed estimates are never cached;
 *   the next run retries.
 *
 * Evidence scope: reuse is proven by per-message estimator call counts in
 * `historyTokenEstimateSession.test.ts`, not by timing claims. Skipping
 * repeat tokenization of unchanged history reduces repeated estimator work;
 * it is not a measured latency improvement (no runtime cost proof exists).
 *
 * This session performs NO message filtering: callers pass the already
 * filtered `tokenEstimationMessages` (the shared `filterContextMessages`
 * pipeline stays the single filter authority). It also never reads viewport
 * size, pending state, or route identity to construct authority — the hook
 * owns identity reset, this session only holds entries.
 */

/** Per-message token estimator: resolves to that message's total tokens. */
export type EstimateHistoryMessageFn = (
  message: Message,
  options: { includeMedia?: boolean; snapshotBlocks?: SnapshotBlockMap }
) => Promise<number>

const defaultEstimateHistoryMessage: EstimateHistoryMessageFn = (message, options) =>
  estimateMessageUsage(message, options).then((usage) => usage.total_tokens)

export interface HistoryTokenEstimateOptions {
  includeMedia?: boolean
  /** Explicit caller-owned snapshot; omit for one synchronous store capture. */
  snapshotBlocks?: SnapshotBlockMap
}

interface HistoryTokenEntry {
  messageRef: Message
  blockRefs: readonly (MessageBlock | undefined)[]
  includeMedia: boolean
  promise: Promise<number>
}

const sameBlockRefs = (
  prev: readonly (MessageBlock | undefined)[],
  next: readonly (MessageBlock | undefined)[]
): boolean => prev.length === next.length && prev.every((block, index) => block === next[index])

/** One synchronous store read per message, captured before any await. */
const resolveStoreBlockRefs = (message: Message): (MessageBlock | undefined)[] => {
  if (!message || !Array.isArray(message.blocks)) {
    return []
  }
  const state = store.getState()
  return message.blocks.map((blockId) => messageBlocksSelectors.selectById(state, blockId) as MessageBlock | undefined)
}

export interface HistoryTokenEstimateSession {
  estimateHistory(assistant: Assistant, messages: Message[], options?: HistoryTokenEstimateOptions): Promise<number>
  /** Drop every cached entry (route/anchor identity change, unmount). */
  reset(): void
  /** Current entry count — always bounded by the latest accepted message set. */
  cacheSize(): number
}

export function createHistoryTokenEstimateSession(
  deps: { estimateMessage?: EstimateHistoryMessageFn } = {}
): HistoryTokenEstimateSession {
  const estimateMessage = deps.estimateMessage ?? defaultEstimateHistoryMessage
  const entries = new Map<string, HistoryTokenEntry>()

  const estimateHistory = async (
    assistant: Assistant,
    messages: Message[],
    options: HistoryTokenEstimateOptions = {}
  ): Promise<number> => {
    const includeMedia = options.includeMedia !== false
    const snapshotBlocks = options.snapshotBlocks
    const list = Array.isArray(messages) ? messages : []

    // 1. Synchronously capture every entry dependency and (re)use-or-start
    //    each per-message estimate. No await happens before every entry of
    //    this run is closed, so later store mutations cannot leak into it.
    const nextIds = new Set<string>()
    const pending: Promise<number>[] = []
    for (const message of list) {
      if (!message || typeof message.id !== 'string') {
        continue
      }
      nextIds.add(message.id)
      const blockRefs = snapshotBlocks
        ? (message.blocks ?? []).map((blockId) => snapshotBlocks.get(blockId))
        : resolveStoreBlockRefs(message)
      const prev = entries.get(message.id)
      if (
        prev &&
        prev.messageRef === message &&
        prev.includeMedia === includeMedia &&
        sameBlockRefs(prev.blockRefs, blockRefs)
      ) {
        pending.push(prev.promise)
        continue
      }
      // Changed or cold entry: full re-estimate with the exact current token
      // algorithm, closed over the captured refs (missing refs stay missing).
      const closedMap: SnapshotBlockMap = new Map()
      for (const block of blockRefs) {
        if (block && typeof block.id === 'string') {
          closedMap.set(block.id, block)
        }
      }
      const started = estimateMessage(message, { includeMedia, snapshotBlocks: closedMap })
      // Failure guard (identity compare): a stale run's late rejection must
      // never delete a newer run's entry. Failures are never cached, so the
      // next run retries; the rejection propagates so the hook keeps the
      // last valid scalar (existing failure semantics).
      const guarded: Promise<number> = started.catch((error: unknown) => {
        if (entries.get(message.id)?.promise === guarded) {
          entries.delete(message.id)
        }
        throw error
      })
      entries.set(message.id, { messageRef: message, blockRefs, includeMedia, promise: guarded })
      pending.push(guarded)
    }

    // 2. Prune entries outside the exact current selected set (bounded).
    for (const id of [...entries.keys()]) {
      if (!nextIds.has(id)) {
        entries.delete(id)
      }
    }

    // 3. Await the closed promises, then add the freshly estimated prompt.
    const totals = await Promise.all(pending)
    const historyTokens = totals.reduce((sum, tokens) => sum + tokens, 0)
    return historyTokens + estimateTextTokens(assistant.prompt || '')
  }

  const reset = (): void => {
    entries.clear()
  }

  const cacheSize = (): number => entries.size

  return { estimateHistory, reset, cacheSize }
}
