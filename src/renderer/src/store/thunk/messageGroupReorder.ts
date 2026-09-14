import { dbService } from '@renderer/services/db'

import type { AppDispatch, RootState } from '../index'
import { newMessagesActions } from '../newMessage'

/**
 * Answer-group authority reorder (renderer thin client).
 *
 * The renderer supplies ONLY the stable anchor + desired group order; Main
 * resolves the complete answer group and persists the authority slots
 * permutation atomically. Never reads loaded messages to construct a full
 * topic list — `orderedGroupIds[0]` is the anchor (the dnd-kit caller passes
 * the visible group order whose head is a stable group member).
 *
 * On success commits ONLY the loaded-projection intersection via the ids-only
 * `reorderLoadedMessageIdsForTopic` action: loaded slots belonging to the
 * authority group are replaced by the response order filtered to the loaded
 * set. Window-outside members are never injected. Slot-count mismatch fails
 * closed with zero dispatch. `updateTopicUpdatedAt` is dispatched exactly
 * once by the data source — never here.
 */
export const reorderMessageGroupThunk =
  (topicId: string, orderedGroupIds: string[]) => async (dispatch: AppDispatch, getState: () => RootState) => {
    if (!Array.isArray(orderedGroupIds) || orderedGroupIds.length === 0) {
      return
    }
    const anchorMessageId = orderedGroupIds[0]
    const response = await dbService.reorderAnswerGroup(topicId, anchorMessageId, orderedGroupIds)

    const state = getState()
    const loadedIds: string[] = state.messages.messageIdsByTopic[topicId] || []
    if (loadedIds.length === 0) {
      return
    }
    const loadedSet = new Set(loadedIds)
    const groupSet = new Set(response.orderedMessageIds)
    const filteredOrder = response.orderedMessageIds.filter((id) => loadedSet.has(id))
    let slotCount = 0
    for (const id of loadedIds) {
      if (groupSet.has(id)) slotCount += 1
    }
    if (slotCount !== filteredOrder.length) {
      return
    }
    for (const id of filteredOrder) {
      if (!groupSet.has(id) || state.messages.entities[id] === undefined) {
        return
      }
    }

    dispatch(
      newMessagesActions.reorderLoadedMessageIdsForTopic({
        topicId,
        orderedMessageIds: response.orderedMessageIds,
        groupMessageIds: response.orderedMessageIds
      })
    )
  }
