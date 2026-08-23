import { loggerService } from '@logger'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { type ActionTarget, messageActionController } from '@renderer/services/messageActionController'
import { restartTrace } from '@renderer/services/SpanManagerService'
import store, { useAppDispatch } from '@renderer/store'
import {
  regenerateAssistantResponseThunk,
  resendMessageThunk,
  resendUserMessageWithEditThunk,
  selectAnswerMessageThunk
} from '@renderer/store/thunk/messageThunk'
import { updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { estimateMessageBlocksUsage } from '@renderer/utils/messageUtils/usage'
import { useCallback, useRef } from 'react'

const logger = loggerService.withContext('useMessageActionController')

/**
 * Renderer-local action controller hook. All methods accept explicit target
 * IDs and resolve the latest Redux state at event time via
 * messageActionController. Ambient Assistant settings are refreshed without
 * erasing per-message/explicit model overrides (see ResolvedAssistant).
 */
export function useMessageActionController() {
  const dispatch = useAppDispatch()
  const selectSeqRef = useRef(0)

  const regenerateAssistant = useCallback(
    async (target: ActionTarget) => {
      const resolved = messageActionController.resolveRegenerateForAssistant(target)
      if (!resolved) {
        logger.warn(`[regenerateAssistant] invalid target ${target.topicId}/${target.messageId}`)
        return
      }
      await restartTrace(resolved.message)
      if (resolved.message.role !== 'assistant') {
        logger.warn('regenerateAssistant should only be called for assistant messages.')
        return
      }
      await dispatch(regenerateAssistantResponseThunk(target.topicId, resolved.message, resolved.assistant.snapshot))
    },
    [dispatch]
  )

  const resendUser = useCallback(
    async (target: ActionTarget) => {
      const resolved = messageActionController.resolveResendForUser(target)
      if (!resolved) {
        logger.warn(`[resendUser] invalid target ${target.topicId}/${target.messageId}`)
        return
      }
      await restartTrace(resolved.message)
      await dispatch(resendMessageThunk(target.topicId, resolved.message, resolved.assistant.snapshot))
    },
    [dispatch]
  )

  const selectAnswer = useCallback(
    async (target: ActionTarget) => {
      selectSeqRef.current += 1
      const mySeq = selectSeqRef.current
      const resolved = await messageActionController.fetchAuthoritativeAnswerGroup(target)
      if (!resolved) {
        logger.warn(
          `[selectAnswer] invalid target or authoritative group unavailable ${target.topicId}/${target.messageId}`
        )
        return
      }
      if (mySeq !== selectSeqRef.current) {
        logger.warn(
          `[selectAnswer] stale selection discarded ${target.topicId}/${target.messageId} seq ${mySeq} vs ${selectSeqRef.current}`
        )
        return
      }
      await dispatch(selectAnswerMessageThunk(target.topicId, target.messageId, resolved.groupIds))
    },
    [dispatch]
  )

  const editSave = useCallback(
    async (
      target: ActionTarget,
      editedBlocks: MessageBlock[],
      onCommit?: (ids: readonly string[]) => void
    ): Promise<boolean> => {
      const latestMessage = messageActionController.resolveEditTarget(target)
      if (!latestMessage) {
        logger.error(`[editSave] Message not found: ${target.messageId}`)
        return false
      }
      const state = store.getState()
      const entities = state.messageBlocks.entities
      const originalBlocks = (latestMessage.blocks || [])
        .map((id) => entities[id])
        .filter((b): b is MessageBlock => !!b)
      const originalIds = new Set(originalBlocks.map((b) => b.id))
      const editedIds = new Set(editedBlocks.map((b) => b.id))
      const blockIdsToRemove = originalBlocks.filter((b) => !editedIds.has(b.id)).map((b) => b.id)
      const blocksToAdd = editedBlocks
        .filter((b) => !originalIds.has(b.id))
        .map((b) => ({ ...b, updatedAt: new Date().toISOString() }))
      const blocksToUpdate = editedBlocks
        .filter((b) => originalIds.has(b.id))
        .map((b) => ({ ...b, updatedAt: new Date().toISOString() }))
      const usage = await estimateMessageBlocksUsage(editedBlocks)
      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: target.messageId,
        updatedAt: new Date().toISOString(),
        blocks: editedBlocks.map((b) => b.id),
        ...(usage ? { usage } : {})
      }
      const allBlocksToPersist = [...blocksToAdd, ...blocksToUpdate]
      if (allBlocksToPersist.length > 0 || blockIdsToRemove.length > 0 || Object.keys(messageUpdates).length > 1) {
        const cleanup = await dispatch(
          updateMessageAndBlocksThunk(target.topicId, messageUpdates, allBlocksToPersist, blockIdsToRemove)
        )
        let postCommitError: unknown
        try {
          onCommit?.(editedBlocks.map((b) => b.id))
        } catch (e) {
          postCommitError = e
          logger.error('[editSave] Commit notification failed', e as Error)
        }
        try {
          await consumeFileCleanupResult(cleanup)
        } catch (e) {
          postCommitError ??= e
          logger.error('[editSave] Post-commit cleanup failed', e as Error)
        }
        if (postCommitError) throw postCommitError
      }
      return true
    },
    [dispatch]
  )

  const resendWithEdit = useCallback(
    async (
      target: ActionTarget,
      editedBlocks: MessageBlock[],
      onCommit?: (ids: readonly string[]) => void
    ): Promise<boolean> => {
      const latestMessage = messageActionController.resolveEditTarget(target)
      if (!latestMessage) {
        logger.error(`[resendWithEdit] Message not found: ${target.messageId}`)
        return false
      }
      const editOk = await editSave(target, editedBlocks, onCommit)
      if (!editOk) return false
      const resolvedAssistant = messageActionController.resolveAssistantSnapshot({
        topicId: target.topicId,
        assistantId: latestMessage.assistantId,
        explicitModel: null
      })
      if (!resolvedAssistant) {
        logger.error(`[resendWithEdit] assistant not found ${latestMessage.assistantId}`)
        return false
      }
      // Re-resolve latest after edit persistence to ensure thunk sees persisted usage
      const afterEditMessage = messageActionController.resolveEditTarget(target)
      if (!afterEditMessage) return false
      const mainText = editedBlocks.find((b) => b.type === MessageBlockType.MAIN_TEXT) as any
      await restartTrace(afterEditMessage, mainText?.content)
      await dispatch(resendUserMessageWithEditThunk(target.topicId, afterEditMessage, resolvedAssistant.snapshot))
      return true
    },
    [dispatch, editSave]
  )

  return {
    regenerateAssistant,
    resendUser,
    selectAnswer,
    editSave,
    resendWithEdit
  }
}
