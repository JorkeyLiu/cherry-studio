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
}

// 3. Define the Initial State
const initialState: MessagesState = messagesAdapter.getInitialState({
  messageIdsByTopic: {},
  currentTopicId: null,
  loadingByTopic: {},
  fulfilledByTopic: {},
  displayCount: 10
})

// Payload for receiving messages (used by loadTopicMessagesThunk)
interface MessagesReceivedPayload {
  topicId: string
  messages: Message[]
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
