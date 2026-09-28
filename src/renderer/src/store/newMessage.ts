/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { loggerService } from '@logger'
import type { EntityState, PayloadAction } from '@reduxjs/toolkit'
import { createEntityAdapter, createSlice } from '@reduxjs/toolkit'
import { diffRouteRebase } from '@renderer/pages/home/Messages/messageWindow'
// Separate type-only imports from value imports
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'

import { publishResidentComplete, retentionEvict } from './residentRegistry'

const logger = loggerService.withContext('newMessage')

// 1. Create the Adapter
const messagesAdapter = createEntityAdapter<Message>()

// 2. Define the State Interface
export interface MessagesState extends EntityState<Message, string> {
  messageIdsByTopic: Record<string, string[]> // Map: topicId -> ordered message IDs
  currentTopicId: string | null
  loadingByTopic: Record<string, boolean>
  fulfilledByTopic: Record<string, boolean>
  displayCount: number
  /**
   * Main-authoritative per-route mutation capability for the current loaded
   * projection (runtime only, never persisted — this slice is blacklisted).
   * `mutableMessageIdsByTopic[topicId]` is valid ONLY for
   * `mutableRouteByTopic[topicId]`; route switches replace atomically and
   * never reuse the previous route's set. Absent/route-mismatched entries
   * are fail-closed (no mutation).
   */
  mutableMessageIdsByTopic: Record<string, string[]>
  mutableRouteByTopic: Record<string, string | null>
}

// 3. Define the Initial State
const initialState: MessagesState = messagesAdapter.getInitialState({
  messageIdsByTopic: {},
  currentTopicId: null,
  loadingByTopic: {},
  fulfilledByTopic: {},
  displayCount: 10,
  mutableMessageIdsByTopic: {},
  mutableRouteByTopic: {}
})

// Payload for receiving messages (used by loadTopicMessagesThunk)
interface MessagesReceivedPayload {
  topicId: string
  messages: Message[]
}

/** Payload for atomic route-window rebase with capability. */
export interface RebaseRouteMessagesPayload {
  topicId: string
  messages: Message[]
  /** Requested route key (null = main). Absent clears capability fail-closed. */
  route?: string | null
  /** Main-authoritative mutable IDs for THIS window. Absent clears. */
  mutableMessageIds?: string[]
}

/** Payload for merging an older/newer window capability into the resident set. */
export interface MergeRouteMutabilityPayload {
  topicId: string
  route: string | null
  mutableMessageIds: string[]
}

/**
 * Payload for atomic pagination window merge (older/newer/navigation).
 * Single-commit install of the merged resident order plus the merged
 * Main-authoritative capability — never a `messagesReceived` (which clears
 * capability) followed by a separate capability merge.
 */
export interface MessagesWindowMergedPayload {
  topicId: string
  messages: Message[]
  /** Active route key at fetch start (null = main). */
  route: string | null
  /**
   * Main-authoritative mutable IDs for THIS response window (precise subset
   * of the response window messages). Same-route merges union with the
   * existing resident set; an empty array therefore retains existing
   * resident capability (it contributes nothing). Route mismatch adopts
   * only this response's set. Always trimmed to the merged resident.
   */
  mutableMessageIds: string[]
}

// Payload for setting topic loading state
interface SetTopicLoadingPayload {
  topicId: string
  loading: boolean
}

// Payload for setting topic loading state
interface SetTopicFulfilledPayload {
  topicId: string
  fulfilled: boolean
}

// Payload for upserting a block reference
interface UpsertBlockReferencePayload {
  messageId: string
  blockId: string
  status?: MessageBlockStatus
  blockType?: MessageBlockType
}

// Payload for removing a single message
interface RemoveMessagePayload {
  topicId: string
  messageId: string
}

// Payload for removing messages by askId
interface RemoveMessagesByAskIdPayload {
  topicId: string
  askId: string
}

// Payload for removing multiple messages by ID
interface RemoveMessagesPayload {
  topicId: string
  messageIds: string[]
}

/**
 * PERF-100: one plural foldSelected commit for one logical answer-tab
 * selection. Commits every patch of one logical selection in ONE reducer
 * action via the adapter's `updateMany` (single store notification) while
 * preserving message order/IDs. Purpose-bounded: no blockInstruction
 * handling, no topic-list mutation.
 */
interface UpdateManyMessagesPayload {
  topicId: string
  updates: Array<{ messageId: string; updates: Partial<Message> }>
}

// Payload for inserting a message at a specific index
interface InsertMessageAtIndexPayload {
  topicId: string
  message: Message
  index: number
}

/**
 * Payload for applying a Main-authoritative insert-after-anchor result.
 *
 * Single-commit install of canonical inserted messages at the durable
 * placement plus the same-route mutability delta — no frame ever contains
 * the new messages without their capability. Placement uses stable
 * neighbors: splice after `beforeMessageId` when resident, else before
 * `nextMessageId` when resident, else conservative append (no false exact
 * position claimed; the authoritative window converges on next fetch).
 * Route mismatch against the stored resident route is fail-closed (no
 * order and no capability change). Patched pre-existing rows are never
 * carried here (they keep durable positions).
 */
export interface ApplyInsertedMessagesAfterAnchorPayload {
  topicId: string
  /** Addressed route key (null = main). Must match the request route. */
  route: string | null
  /** Canonical post-write inserted messages (request/insert order). */
  messages: Message[]
  /** Post-insert effective predecessor of the inserted run (null at head). */
  beforeMessageId: string | null
  /** Post-insert effective successor of the inserted run (null at tail). */
  nextMessageId: string | null
  /** Stable IDs of truly inserted messages (insert order). */
  insertedMessageIds: string[]
  /** Main-authoritative mutability delta (subset of insertedMessageIds). */
  mutableMessageIds: string[]
}

/**
 * Answer-group authority reorder projection commit (ids-only).
 *
 * Permutes ONLY the existing loaded slots for a topic that belong to the
 * authority group: loaded IDs intersecting `groupMessageIds` are replaced in
 * loaded order by `orderedMessageIds` filtered to the loaded set. Never adds
 * or removes IDs/entities — window-outside members are never injected. The
 * caller must fail closed (zero dispatch) on slot-count mismatch.
 */
interface ReorderLoadedMessageIdsForTopicPayload {
  topicId: string
  orderedMessageIds: string[]
  groupMessageIds: string[]
}

// 4. Create the Slice with Refactored Reducers
export const messagesSlice = createSlice({
  name: 'newMessages',
  initialState,
  reducers: {
    setCurrentTopicId(state, action: PayloadAction<string | null>) {
      state.currentTopicId = action.payload
      if (action.payload && !(action.payload in state.messageIdsByTopic)) {
        state.messageIdsByTopic[action.payload] = []
        state.loadingByTopic[action.payload] = false
      }
    },
    setTopicLoading(state, action: PayloadAction<SetTopicLoadingPayload>) {
      const { topicId, loading } = action.payload
      state.loadingByTopic[topicId] = loading
    },
    setTopicFulfilled(state, action: PayloadAction<SetTopicFulfilledPayload>) {
      const { topicId, fulfilled } = action.payload
      state.fulfilledByTopic[topicId] = fulfilled
    },
    setDisplayCount(state, action: PayloadAction<number>) {
      state.displayCount = action.payload
    },
    messagesReceived(state, action: PayloadAction<MessagesReceivedPayload>) {
      const { topicId, messages } = action.payload
      // @ts-ignore ts-2589 false positive
      messagesAdapter.upsertMany(state, messages)
      state.messageIdsByTopic[topicId] = messages.map((m) => m.id)
      state.currentTopicId = topicId
      // Legacy/full publish without capability: clear fail-closed so a stale
      // route set can never authorize mutation.
      delete state.mutableRouteByTopic[topicId]
      delete state.mutableMessageIdsByTopic[topicId]
    },
    /**
     * Conservative route-window rebase for same-topic branch switches.
     *
     * Production path for `diffRouteRebase` (messageWindow.ts): single-commit
     * atomic publish of the Main-authoritative target window. `nextIds` is
     * ALWAYS exactly the target window order — pre-window old IDs are never
     * retained (unprovable by the window protocol), old exclusive suffixes
     * leave in the same commit, entities of shared stable IDs are reused via
     * ID-keyed upsert. No blank/mixed frame. Never touches other topics, never
     * clears the whole store, never changes currentTopicId (only the route
     * changes). Empty target windows publish `[]` (atomic clear).
     */
    rebaseRouteMessages(state, action: PayloadAction<RebaseRouteMessagesPayload>) {
      const { topicId, messages } = action.payload
      const oldIds = state.messageIdsByTopic[topicId] ?? []
      // Production use of the conservative rebase diff: nextIds is the
      // authoritative target order (static import at module top).
      const plan = diffRouteRebase(oldIds, messages)
      // @ts-ignore ts-2589 false positive
      messagesAdapter.upsertMany(state, messages)
      state.messageIdsByTopic[topicId] = plan.nextIds
      // Natural entity cleanup: old-route-exclusive IDs leave the entity
      // dict in the same commit so a direct ID selector cannot leak a stale
      // message and memory stays bounded. Stable-ID reuse
      // is preserved: IDs in nextIds are never removed (upserted above).
      // Cross-topic safety: an ID still listed by another topic is kept.
      if (plan.removedIds.length > 0) {
        const nextSet = new Set(plan.nextIds)
        const stillListedElsewhere = new Set<string>()
        for (const [tid, ids] of Object.entries(state.messageIdsByTopic)) {
          if (tid === topicId) continue
          for (const id of ids as string[]) stillListedElsewhere.add(id)
        }
        const exclusive = plan.removedIds.filter((id) => !nextSet.has(id) && !stillListedElsewhere.has(id))
        if (exclusive.length > 0) {
          messagesAdapter.removeMany(state, exclusive)
        }
      }
      // Atomic capability publish for the target route: rebase replaces the
      // resident set; stale cross-route capability never survives a switch.
      // Removed IDs are pruned; absent capability clears fail-closed.
      const hasRoute = Object.prototype.hasOwnProperty.call(action.payload, 'route')
      const hasMutable = Object.prototype.hasOwnProperty.call(action.payload, 'mutableMessageIds')
      if (hasRoute || hasMutable) {
        const route = action.payload.route ?? null
        const incoming = Array.isArray(action.payload.mutableMessageIds)
          ? [...new Set(action.payload.mutableMessageIds.filter((id) => typeof id === 'string' && id.length > 0))]
          : []
        const nextSet = new Set(plan.nextIds)
        state.mutableRouteByTopic[topicId] = route
        state.mutableMessageIdsByTopic[topicId] = incoming.filter((id) => nextSet.has(id))
      } else {
        delete state.mutableRouteByTopic[topicId]
        delete state.mutableMessageIdsByTopic[topicId]
      }
    },
    /**
     * Atomic pagination window merge: installs the merged resident order
     * (older/newer/navigation union) and merges the response-window
     * capability in the SAME commit — no intermediate all-immutable frame.
     *
     * Capability semantics: each response's `mutableMessageIds` covers only
     * that response window's precise owned subset (Main authority, BRANCH-9).
     * Multi-page resident capability is the union of same-route window
     * capabilities, trimmed to the merged resident. Same-route unions (an
     * empty response therefore retains existing resident capability);
     * route mismatch adopts only this response's set (no cross-route leak).
     * IDs leaving the merged resident are pruned; old-exclusive entities
     * leave in the same commit (cross-topic-listed IDs kept).
     */
    messagesWindowMerged(state, action: PayloadAction<MessagesWindowMergedPayload>) {
      const { topicId, messages, route } = action.payload
      const rawMutable = Array.isArray(action.payload.mutableMessageIds) ? action.payload.mutableMessageIds : []
      const oldIds = state.messageIdsByTopic[topicId] ?? []
      // @ts-ignore ts-2589 false positive
      messagesAdapter.upsertMany(state, messages)
      const nextIds = messages.map((m) => m.id)
      state.messageIdsByTopic[topicId] = nextIds
      state.currentTopicId = topicId
      const nextSet = new Set(nextIds)
      if (oldIds.length > 0) {
        const removedIds = oldIds.filter((id) => !nextSet.has(id))
        if (removedIds.length > 0) {
          const stillListedElsewhere = new Set<string>()
          for (const [tid, ids] of Object.entries(state.messageIdsByTopic)) {
            if (tid === topicId) continue
            for (const id of ids as string[]) stillListedElsewhere.add(id)
          }
          const exclusive = removedIds.filter((id) => !nextSet.has(id) && !stillListedElsewhere.has(id))
          if (exclusive.length > 0) {
            messagesAdapter.removeMany(state, exclusive)
          }
        }
      }
      const incoming = [...new Set(rawMutable.filter((id) => typeof id === 'string' && id.length > 0))].filter((id) =>
        nextSet.has(id)
      )
      const hasStoredRoute = Object.prototype.hasOwnProperty.call(state.mutableRouteByTopic, topicId)
      const currentRoute = hasStoredRoute ? (state.mutableRouteByTopic[topicId] ?? null) : null
      const storedHasCapability = Object.prototype.hasOwnProperty.call(state.mutableMessageIdsByTopic, topicId)
      if (!hasStoredRoute && !storedHasCapability) {
        state.mutableRouteByTopic[topicId] = route
        state.mutableMessageIdsByTopic[topicId] = incoming
        return
      }
      if (currentRoute !== route) {
        state.mutableRouteByTopic[topicId] = route
        state.mutableMessageIdsByTopic[topicId] = incoming
        return
      }
      const resident = new Set((state.mutableMessageIdsByTopic[topicId] ?? []).filter((id) => nextSet.has(id)))
      for (const id of incoming) resident.add(id)
      state.mutableRouteByTopic[topicId] = route
      state.mutableMessageIdsByTopic[topicId] = [...resident]
    },
    /**
     * Merge an older/newer window capability into the resident set for the
     * SAME route (pagination). Same-route unions; route mismatch replaces
     * atomically to avoid cross-route reuse. Removed IDs are pruned by the
     * caller via `pruneRouteMutability` after entity cleanup.
     */
    mergeRouteMutability(state, action: PayloadAction<MergeRouteMutabilityPayload>) {
      const { topicId, route, mutableMessageIds } = action.payload
      const currentRoute = state.mutableRouteByTopic[topicId] ?? null
      const incoming = [...new Set(mutableMessageIds.filter((id) => typeof id === 'string' && id.length > 0))]
      if (currentRoute !== route) {
        state.mutableRouteByTopic[topicId] = route
        state.mutableMessageIdsByTopic[topicId] = incoming
        return
      }
      const resident = new Set(state.mutableMessageIdsByTopic[topicId] ?? [])
      for (const id of incoming) resident.add(id)
      state.mutableMessageIdsByTopic[topicId] = [...resident]
    },
    /**
     * Prune capability entries for IDs no longer resident (entity cleanup).
     * Keeps the mutability set bounded to the loaded projection.
     */
    pruneRouteMutability(state, action: PayloadAction<{ topicId: string; removedIds: string[] }>) {
      const { topicId, removedIds } = action.payload
      const current = state.mutableMessageIdsByTopic[topicId]
      if (!current || current.length === 0 || removedIds.length === 0) return
      const removed = new Set(removedIds)
      state.mutableMessageIdsByTopic[topicId] = current.filter((id) => !removed.has(id))
    },
    /**
     * Invalidate the resident capability for one topic (branch catalog
     * change for a non-active subtree, explicit reload path). Retains the
     * browsing window; the next window fetch republishes capability.
     */
    invalidateRouteMutability(state, action: PayloadAction<{ topicId: string }>) {
      delete state.mutableRouteByTopic[action.payload.topicId]
      delete state.mutableMessageIdsByTopic[action.payload.topicId]
    },
    addMessage(state, action: PayloadAction<{ topicId: string; message: Message }>) {
      const { topicId, message } = action.payload
      messagesAdapter.addOne(state, message)
      if (!state.messageIdsByTopic[topicId]) {
        state.messageIdsByTopic[topicId] = []
      }
      state.messageIdsByTopic[topicId].push(message.id)
      if (!(topicId in state.loadingByTopic)) {
        state.loadingByTopic[topicId] = false
      }
      if (!(topicId in state.fulfilledByTopic)) {
        state.fulfilledByTopic[topicId] = false
      }
    },
    insertMessageAtIndex(state, action: PayloadAction<InsertMessageAtIndexPayload>) {
      const { topicId, message, index } = action.payload

      if (!state.messageIdsByTopic[topicId]) {
        state.messageIdsByTopic[topicId] = []
      }

      // Guard: skip if message ID already exists in this topic's ID list
      if (state.messageIdsByTopic[topicId].includes(message.id)) {
        return
      }

      messagesAdapter.addOne(state, message)
      // Ensure index is within bounds
      const safeIndex = Math.max(0, Math.min(index, state.messageIdsByTopic[topicId].length))
      state.messageIdsByTopic[topicId].splice(safeIndex, 0, message.id)

      if (!(topicId in state.loadingByTopic)) {
        state.loadingByTopic[topicId] = false
      }
      if (!(topicId in state.fulfilledByTopic)) {
        state.fulfilledByTopic[topicId] = false
      }
    },
    /**
     * Apply a Main-authoritative insert-after-anchor result atomically.
     *
     * Order + capability commit in ONE reducer action: canonical inserted
     * entities are upserted, the resident order splices the inserted run at
     * the authoritative stable-neighbor position, and the same-route
     * mutability delta unions in the same commit. Route mismatch against the
     * stored resident route fails closed with zero change. Neither-neighbor-
     * resident falls back to conservative append (immediate visibility
     * without a false exact-position claim).
     */
    applyInsertedMessagesAfterAnchor(state, action: PayloadAction<ApplyInsertedMessagesAfterAnchorPayload>) {
      const { topicId, route, messages, beforeMessageId, nextMessageId, insertedMessageIds, mutableMessageIds } =
        action.payload
      if (!Array.isArray(insertedMessageIds) || insertedMessageIds.length === 0) return
      if (!Array.isArray(messages) || messages.length === 0) return
      // Fail-closed on stale/route-mismatched resident capability: a stored
      // route for another route must never authorize or order this insert.
      const hasStoredRoute = Object.prototype.hasOwnProperty.call(state.mutableRouteByTopic, topicId)
      if (hasStoredRoute && (state.mutableRouteByTopic[topicId] ?? null) !== route) return
      // Upsert canonical entities first (ID-keyed; order set below).
      // @ts-ignore ts-2589 false positive
      messagesAdapter.upsertMany(state, messages)
      const oldIds = state.messageIdsByTopic[topicId] ?? []
      const insertedSet = new Set(insertedMessageIds)
      const baseIds = oldIds.filter((id) => !insertedSet.has(id))
      let insertAt: number | null = null
      if (typeof beforeMessageId === 'string' && beforeMessageId.length > 0) {
        const beforeIdx = baseIds.indexOf(beforeMessageId)
        if (beforeIdx !== -1) insertAt = beforeIdx + 1
      }
      if (insertAt === null && typeof nextMessageId === 'string' && nextMessageId.length > 0) {
        const nextIdx = baseIds.indexOf(nextMessageId)
        if (nextIdx !== -1) insertAt = nextIdx
      }
      if (insertAt === null) {
        // Conservative loaded-projection fallback: neither authoritative
        // neighbor is resident, so append for immediate visibility without
        // claiming an exact durable position.
        insertAt = baseIds.length
      }
      const safeAt = Math.max(0, Math.min(insertAt, baseIds.length))
      state.messageIdsByTopic[topicId] = [...baseIds.slice(0, safeAt), ...insertedMessageIds, ...baseIds.slice(safeAt)]
      if (!(topicId in state.loadingByTopic)) {
        state.loadingByTopic[topicId] = false
      }
      if (!(topicId in state.fulfilledByTopic)) {
        state.fulfilledByTopic[topicId] = false
      }
      // Same-route capability delta, trimmed to the merged resident.
      const nextSet = new Set(state.messageIdsByTopic[topicId])
      const incoming = [...new Set((mutableMessageIds ?? []).filter((id) => typeof id === 'string' && id.length > 0))]
        .filter((id) => insertedSet.has(id))
        .filter((id) => nextSet.has(id))
      const storedHasCapability = Object.prototype.hasOwnProperty.call(state.mutableMessageIdsByTopic, topicId)
      if (!hasStoredRoute && !storedHasCapability) {
        state.mutableRouteByTopic[topicId] = route
        state.mutableMessageIdsByTopic[topicId] = incoming
        return
      }
      const resident = new Set((state.mutableMessageIdsByTopic[topicId] ?? []).filter((id) => nextSet.has(id)))
      for (const id of incoming) resident.add(id)
      state.mutableRouteByTopic[topicId] = route
      state.mutableMessageIdsByTopic[topicId] = [...resident]
    },
    updateMessage(
      state,
      action: PayloadAction<{
        topicId: string
        messageId: string
        updates: Partial<Message> & { blockInstruction?: { id: string; position?: number } }
      }>
    ) {
      const { messageId, updates } = action.payload
      const { blockInstruction, ...otherUpdates } = updates

      if (blockInstruction) {
        const messageToUpdate = state.entities[messageId]
        if (messageToUpdate) {
          const { id: blockIdToAdd, position } = blockInstruction
          const currentBlocks = [...(messageToUpdate.blocks || [])]
          if (!currentBlocks.includes(blockIdToAdd)) {
            if (typeof position === 'number' && position >= 0 && position <= currentBlocks.length) {
              currentBlocks.splice(position, 0, blockIdToAdd)
            } else {
              currentBlocks.push(blockIdToAdd)
            }
            messagesAdapter.updateOne(state, { id: messageId, changes: { ...otherUpdates, blocks: currentBlocks } })
          } else {
            if (Object.keys(otherUpdates).length > 0) {
              messagesAdapter.updateOne(state, { id: messageId, changes: otherUpdates })
            }
          }
        } else {
          logger.warn(`[updateMessage] Message ${messageId} not found in entities.`)
        }
      } else {
        messagesAdapter.updateOne(state, { id: messageId, changes: otherUpdates })
      }
    },
    /**
     * PERF-100: one plural foldSelected commit for one logical answer-tab
     * selection. The DB-first thunk calls this exactly once after the atomic
     * Main command succeeds — a single store notification commits every
     * patch (adapter `updateMany`, order/IDs preserved) instead of one
     * `updateMessage` dispatch per message.
     */
    updateManyMessages(state, action: PayloadAction<UpdateManyMessagesPayload>) {
      const { updates } = action.payload
      messagesAdapter.updateMany(
        state,
        updates
          .map(({ messageId, updates: changes }) => ({ id: messageId, changes }))
          .filter((entry) => state.entities[entry.id] !== undefined)
      )
    },
    /**
     * Answer-group authority reorder projection commit (ids-only).
     *
     * Permutes ONLY existing loaded slots: collects loaded positions whose ID
     * is in `groupMessageIds`, then writes `orderedMessageIds` filtered to the
     * loaded set into those positions in order. Fail-closed no-op unless the
     * loaded intersection count exactly matches the filtered order count and
     * every filtered ID is already loaded. Never adds/removes IDs or touches
     * entities — `foldSelected`/`useful` objects are preserved by identity.
     */
    reorderLoadedMessageIdsForTopic(state, action: PayloadAction<ReorderLoadedMessageIdsForTopicPayload>) {
      const { topicId, orderedMessageIds, groupMessageIds } = action.payload
      const loadedIds = state.messageIdsByTopic[topicId]
      if (!loadedIds || loadedIds.length === 0) return
      const groupSet = new Set(groupMessageIds)
      const loadedSet = new Set(loadedIds)
      const filteredOrder = orderedMessageIds.filter((id) => loadedSet.has(id))
      const slotIndexes: number[] = []
      for (let i = 0; i < loadedIds.length; i++) {
        if (groupSet.has(loadedIds[i])) slotIndexes.push(i)
      }
      if (slotIndexes.length !== filteredOrder.length) return
      for (const id of filteredOrder) {
        if (!groupSet.has(id)) return
        if (state.entities[id] === undefined) return
      }
      const next = [...loadedIds]
      for (let i = 0; i < slotIndexes.length; i++) {
        next[slotIndexes[i]] = filteredOrder[i]
      }
      state.messageIdsByTopic[topicId] = next
    },
    removeMessage(state, action: PayloadAction<RemoveMessagePayload>) {
      const { topicId, messageId } = action.payload
      const currentTopicIds = state.messageIdsByTopic[topicId]
      if (currentTopicIds) {
        state.messageIdsByTopic[topicId] = currentTopicIds.filter((id) => id !== messageId)
      }
      messagesAdapter.removeOne(state, messageId)
      const mutable = state.mutableMessageIdsByTopic[topicId]
      if (Array.isArray(mutable) && mutable.includes(messageId)) {
        state.mutableMessageIdsByTopic[topicId] = mutable.filter((id) => id !== messageId)
      }
    },
    removeMessagesByAskId(state, action: PayloadAction<RemoveMessagesByAskIdPayload>) {
      const { topicId, askId } = action.payload
      const currentTopicIds = state.messageIdsByTopic[topicId] || []
      const idsToRemove: string[] = []

      currentTopicIds.forEach((id) => {
        const message = state.entities[id]
        if (message && message.askId === askId) {
          idsToRemove.push(id)
        }
      })

      if (idsToRemove.length > 0) {
        messagesAdapter.removeMany(state, idsToRemove)
        state.messageIdsByTopic[topicId] = currentTopicIds.filter((id) => !idsToRemove.includes(id))
        const mutable = state.mutableMessageIdsByTopic[topicId]
        if (Array.isArray(mutable)) {
          const removed = new Set(idsToRemove)
          state.mutableMessageIdsByTopic[topicId] = mutable.filter((id) => !removed.has(id))
        }
      }
    },
    removeMessages(state, action: PayloadAction<RemoveMessagesPayload>) {
      const { topicId, messageIds } = action.payload
      const currentTopicIds = state.messageIdsByTopic[topicId]
      const idsToRemoveSet = new Set(messageIds)
      if (currentTopicIds) {
        state.messageIdsByTopic[topicId] = currentTopicIds.filter((id) => !idsToRemoveSet.has(id))
      }
      messagesAdapter.removeMany(state, messageIds)
      const mutable = state.mutableMessageIdsByTopic[topicId]
      if (Array.isArray(mutable)) {
        state.mutableMessageIdsByTopic[topicId] = mutable.filter((id) => !idsToRemoveSet.has(id))
      }
    },
    upsertBlockReference(state, action: PayloadAction<UpsertBlockReferencePayload>) {
      const { messageId, blockId, status, blockType } = action.payload

      const messageToUpdate = state.entities[messageId]
      if (!messageToUpdate) {
        logger.error(`[upsertBlockReference] Message ${messageId} not found.`)
        return
      }

      const changes: Partial<Message> = {}

      // Update Block ID
      const currentBlocks = messageToUpdate.blocks || []
      if (!currentBlocks.includes(blockId)) {
        if (blockType === MessageBlockType.THINKING) {
          changes.blocks = [blockId, ...currentBlocks]
        } else {
          changes.blocks = [...currentBlocks, blockId]
        }
      }

      // Update Message Status based on Block Status
      if (status) {
        if (
          (status === MessageBlockStatus.PROCESSING || status === MessageBlockStatus.STREAMING) &&
          messageToUpdate.status !== AssistantMessageStatus.PROCESSING &&
          messageToUpdate.status !== AssistantMessageStatus.SUCCESS &&
          messageToUpdate.status !== AssistantMessageStatus.ERROR
        ) {
          changes.status = AssistantMessageStatus.PROCESSING
        } else if (status === MessageBlockStatus.ERROR) {
          changes.status = AssistantMessageStatus.ERROR
        } else if (
          status === MessageBlockStatus.SUCCESS &&
          messageToUpdate.status === AssistantMessageStatus.PROCESSING
        ) {
          // Tentative success - may need refinement
          // changes.status = AssistantMessageStatus.SUCCESS
        }
      }

      // Apply updates if any changes were made
      if (Object.keys(changes).length > 0) {
        messagesAdapter.updateOne(state, { id: messageId, changes })
      }
    }
  },
  extraReducers: (builder) => {
    builder.addCase(publishResidentComplete, (state, action) => {
      const { topicId, windowResponse } = action.payload
      const messages = windowResponse.messages as unknown as Message[]
      // Root wrapper already validated generation; publish atomically
      // @ts-ignore adapter false positive
      messagesAdapter.upsertMany(state as any, messages as any)
      state.messageIdsByTopic[topicId] = messages.map((m) => m.id)
      state.currentTopicId = topicId
      // Publish Main-authoritative capability atomically with the resident
      // window. Route comes from the joint payload when present; absent
      // clears fail-closed. IDs are pruned to the resident window.
      const route = (action.payload as { route?: string | null }).route ?? null
      const raw = (windowResponse as unknown as { mutableMessageIds?: unknown }).mutableMessageIds
      const residentSet = new Set(messages.map((m) => m.id))
      if (Array.isArray(raw)) {
        const incoming = [...new Set(raw.filter((id) => typeof id === 'string' && id.length > 0))] as string[]
        state.mutableRouteByTopic[topicId] = route
        state.mutableMessageIdsByTopic[topicId] = incoming.filter((id) => residentSet.has(id))
      } else {
        delete state.mutableRouteByTopic[topicId]
        delete state.mutableMessageIdsByTopic[topicId]
      }
    })
    builder.addCase(retentionEvict, (state, action) => {
      const topicId = action.payload
      const messageIds = state.messageIdsByTopic[topicId]
      if (messageIds) {
        messagesAdapter.removeMany(state as any, [...messageIds] as any)
        delete state.messageIdsByTopic[topicId]
      }
      // Clear loading/fulfilled markers for evicted topic; active topic is pinned and never evicted
      if (state.loadingByTopic[topicId] !== undefined) delete state.loadingByTopic[topicId]
      if (state.fulfilledByTopic[topicId] !== undefined) delete state.fulfilledByTopic[topicId]
      if (state.currentTopicId === topicId) state.currentTopicId = null
      delete state.mutableRouteByTopic[topicId]
      delete state.mutableMessageIdsByTopic[topicId]
    })
  }
})

// 5. Export Actions and Reducer
export const newMessagesActions = messagesSlice.actions
export default messagesSlice.reducer

// --- Selectors ---
import type { RootState } from './index' // Adjust path if necessary

// Base selector for the messages slice state
export const selectMessagesState = (state: RootState) => state.messages

// Selectors generated by createEntityAdapter
export const {
  selectAll: selectAllMessages, // Selects all messages as an array
  selectById: selectMessageById, // Selects a single message by ID
  selectIds: selectAllMessageIds, // Selects all message IDs as an array
  selectEntities: selectMessageEntities // Selects the entity dictionary { id: message }
} = messagesAdapter.getSelectors(selectMessagesState)

// Custom Selectors: explicit bounded loaded projection for a topic.
// Ordinary renderer Redux message data is a loaded projection of the
// resident topic window — never the whole topic. `undefined` means the topic
// is not a complete resident projection or has no loaded ID list; a resident
// topic with an explicit `[]` returns a defined empty projection.
export interface LoadedTopicMessageProjection {
  topicId: string
  messageIds: readonly string[]
  messages: readonly Message[]
  completeness: 'loaded-projection'
}

// Stable empty singleton for loaded message arrays. Loaded ID lists always
// return the stored `messageIdsByTopic[topicId]` reference, never a copy.
export const EMPTY_LOADED_MESSAGES: readonly Message[] = []

function isResidentLoadedTopic(state: RootState, topicId: string): boolean {
  const entries = (state as unknown as { residentRegistry?: { entries?: Record<string, { residentTopic?: boolean }> } })
    ?.residentRegistry?.entries
  return !!entries?.[topicId]?.residentTopic
}

interface LoadedProjectionCacheEntry {
  entityRefs: readonly (Message | undefined)[]
  messages: readonly Message[]
  projection: LoadedTopicMessageProjection
}

// Keyed by the stored ID array reference (stable across unrelated updates via
// Immer structural sharing). Distinct stores hold distinct array objects, so
// no cross-store leakage. Resident gating happens before lookup, so a cached
// entry is only reused for a currently resident topic.
const loadedProjectionCache = new WeakMap<readonly string[], LoadedProjectionCacheEntry>()

function getCachedLoadedProjection(
  topicId: string,
  ids: readonly string[],
  entities: Record<string, Message | undefined>
): LoadedTopicMessageProjection {
  const cached = loadedProjectionCache.get(ids)
  if (cached && cached.entityRefs.length === ids.length) {
    let stable = true
    for (let i = 0; i < ids.length; i++) {
      if (entities[ids[i]] !== cached.entityRefs[i]) {
        stable = false
        break
      }
    }
    if (stable) return cached.projection
  }
  const entityRefs = ids.map((id) => entities[id])
  const messages: readonly Message[] =
    entityRefs.length === 0 ? EMPTY_LOADED_MESSAGES : entityRefs.filter((m): m is Message => !!m)
  const projection: LoadedTopicMessageProjection = {
    topicId,
    messageIds: ids,
    messages,
    completeness: 'loaded-projection'
  }
  loadedProjectionCache.set(ids, { entityRefs, messages, projection })
  return projection
}

export function selectLoadedMessageIdsForTopic(state: RootState, topicId: string): readonly string[] | undefined {
  if (!isResidentLoadedTopic(state, topicId)) return undefined
  const ids = state.messages.messageIdsByTopic[topicId]
  if (ids === undefined) return undefined
  return ids
}

export function selectLoadedMessagesForTopic(state: RootState, topicId: string): readonly Message[] | undefined {
  if (!isResidentLoadedTopic(state, topicId)) return undefined
  const ids = state.messages.messageIdsByTopic[topicId]
  if (ids === undefined) return undefined
  return getCachedLoadedProjection(topicId, ids, state.messages.entities as Record<string, Message | undefined>)
    .messages
}

export function selectLoadedTopicProjection(
  state: RootState,
  topicId: string
): LoadedTopicMessageProjection | undefined {
  if (!isResidentLoadedTopic(state, topicId)) return undefined
  const ids = state.messages.messageIdsByTopic[topicId]
  if (ids === undefined) return undefined
  return getCachedLoadedProjection(topicId, ids, state.messages.entities as Record<string, Message | undefined>)
}

/**
 * Main-authoritative mutable IDs for the current resident route of a topic.
 * Fail-closed: undefined when the topic is not resident, when no capability
 * was published, or when the stored route differs from the active route.
 * Callers must hide/disable mutation controls when undefined or when the
 * message ID is absent.
 */
export function selectMutableMessageIdsForTopic(
  state: RootState,
  topicId: string,
  activeRoute: string | null
): readonly string[] | undefined {
  if (!isResidentLoadedTopic(state, topicId)) return undefined
  const storedRoute = state.messages.mutableRouteByTopic[topicId] ?? null
  // Stored route must match the active route; null == main in both.
  if (storedRoute !== activeRoute) return undefined
  const ids = state.messages.mutableMessageIdsByTopic[topicId]
  if (!Array.isArray(ids)) return undefined
  return ids
}

/** Fail-closed per-message mutability for the active route. */
export function selectIsMessageMutable(
  state: RootState,
  topicId: string,
  messageId: string,
  activeRoute: string | null
): boolean {
  const mutable = selectMutableMessageIdsForTopic(state, topicId, activeRoute)
  if (!mutable) return false
  if (!mutable.includes(messageId)) return false
  // Resident-only: the message must be in the current loaded projection.
  const loaded = state.messages.messageIdsByTopic[topicId]
  if (!Array.isArray(loaded) || !loaded.includes(messageId)) return false
  return true
}
