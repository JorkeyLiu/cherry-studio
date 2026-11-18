import { bumpAndInvalidate } from '@renderer/services/contextClosure'
import { dbService } from '@renderer/services/db'

import type { AppDispatch, RootState } from '../index'
import { newMessagesActions } from '../newMessage'

/**
 * Turn-level fold/unfold (renderer thin client).
 *
 * The renderer supplies ONLY stable turn (group) ids — each is the turn's user
 * message id. It never enumerates the rows it happens to have loaded, so a turn
 * whose members lie outside the loaded window is folded/unfolded with the same
 * authority as a resident one. Main resolves every selected turn's complete
 * membership, verifies the selection against the route and its fork boundary,
 * and writes the fold flags atomically; a rejected selection writes nothing.
 *
 * Commit discipline:
 * - Only the loaded intersection is patched: every id of
 *   `response.affectedMessageIds` that is currently loaded has its `folded`
 *   flag set to the response state (an absent key is the unfolded state — the
 *   store never carries `folded: false`). Window-outside members are NOT
 *   injected; the next window read projects them.
 * - `bumpAndInvalidate` runs after the patch, because fold changes context
 *   participation without changing membership or ordering.
 * - This thunk is intentionally silent on the UI: it never toasts and never
 *   clears the selection. A failure throws, so the caller reports the failure
 *   for the operation the user actually asked for and keeps the selection.
 */
export const setTurnFoldsThunk =
  (topicId: string, selectedGroupIds: string[], folded: boolean, branchId?: string | null) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const uniqueGroupIds = [...new Set(selectedGroupIds)].filter((id) => id !== '')
    if (!topicId || uniqueGroupIds.length === 0) return

    const response = await dbService.setTurnFolds(topicId, uniqueGroupIds, folded, branchId)

    // The authority state wins over the requested one: an all-or-nothing write
    // never leaves the projection half-applied.
    const projectionFold = response.folded ? true : null
    const state = getState()
    const loadedIds: string[] = state.messages.messageIdsByTopic[topicId] || []
    if (loadedIds.length > 0) {
      const loaded = new Set(loadedIds)
      for (const messageId of response.affectedMessageIds) {
        if (!loaded.has(messageId)) continue
        if (state.messages.entities[messageId] === undefined) continue
        dispatch(newMessagesActions.updateMessage({ topicId, messageId, updates: { folded: projectionFold } }))
      }
    }

    bumpAndInvalidate(topicId, branchId)
  }
