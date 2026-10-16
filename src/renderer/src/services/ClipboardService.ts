import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { publishInsertMessageGroupsAck } from '@renderer/services/insertGroupsAck'
import type { AppDispatch, RootState } from '@renderer/store'
import { clearClipboard, setClipboard } from '@renderer/store/clipboard'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { removeManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import {
  deleteMessagesFromDB,
  executeDeleteMessagesWithDependents,
  executeStagedCutSourceDelete,
  isDeletePostCommitConvergenceError
} from '@renderer/store/thunk/messageThunk'
import { deleteSegmentsBySnapshots, syncSegmentsAfterMessageDeletion } from '@renderer/store/thunk/topicSegmentThunk'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import { pushUndoAction } from '@renderer/store/undoStack'
import type {
  ClipboardItem,
  ClipboardSegmentSnapshot,
  CutPasteUndoAction,
  DeleteUndoAction,
  GroupAnchor,
  PasteUndoAction,
  SegmentSnapshot,
  StagedCutSourceProjection
} from '@renderer/types/editMode'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { convergeTopicSegmentCatalog, mapSegmentWireToTopicSegment } from '@renderer/utils/topicSegmentCatalog'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import type { InsertMessageGroupIntent, MessageBlockEntry } from '@shared/chatDb'
import { t } from 'i18next'
import { v4 as uuidv4 } from 'uuid'

const logger = loggerService.withContext('ClipboardService')

/**
 * Find the first message after `positionIndex` whose ID is not in `excludedIds`.
 * Returns the message ID, or null if no such message exists.
 */
function findAnchorAfterPosition(messages: Message[], positionIndex: number, excludedIds: Set<string>): string | null {
  for (let i = positionIndex; i < messages.length; i++) {
    if (!excludedIds.has(messages[i].id)) {
      return messages[i].id
    }
  }
  return null
}

/**
 * Authority-complete clipboard payload for copy/cut under windowed loading.
 *
 * Resolves the selected stable group IDs (`selectedGroupIds`, the same values
 * the edit-mode UI passes as group `askId`s) in one Main group-scoped
 * authority read (`chatdb:fetch-clipboard-groups`, never published to Redux)
 * with the canonical grouping semantics (user keys own ID, assistants join by
 * askId with an orphan-askId fallback group, system keys own ID; any other
 * role forms no selectable group). Ordering and `positionIndex` come from
 * Main authority order (first-message `sort_order`), blocks come from the
 * response-local block set (so outside-loaded members are complete), and
 * segment inclusion comes from the authority-enriched segment catalog (a
 * segment is included only when ALL its authority message IDs are selected —
 * completeness is never inferred from loaded positions).
 *
 * Returns null when no selected group resolves or any authority read fails —
 * callers publish nothing on null (no partial clipboard).
 */
async function buildAuthorityClipboardPayload(
  topicId: string,
  selectedGroupIds: string[],
  branchId?: string | null
): Promise<{ items: ClipboardItem[]; segmentSnapshots: ClipboardSegmentSnapshot[] } | null> {
  // Stable group IDs only (dedupe defense-in-depth; same contract as the
  // semantic delete path).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return null
  }

  // Group-scoped authority read in the addressed route (null = main route);
  // never relies on or mutates Redux, never fetches the whole topic. A
  // selected ID absent from authority (deletion race, unknown id,
  // non-clipboard role, cross-topic id) is filtered by Main and resolves to
  // nothing here.
  let clipboard: Awaited<ReturnType<typeof dbService.fetchClipboardGroups>>
  try {
    clipboard = await dbService.fetchClipboardGroups({
      topicId,
      branchId: typeof branchId === 'string' && branchId.length > 0 ? branchId : null,
      groupIds: rootIds
    })
  } catch (error) {
    logger.error('[buildAuthorityClipboardPayload] Failed to fetch clipboard groups', error as Error)
    return null
  }

  if (clipboard.groups.length === 0 || clipboard.messages.length === 0) {
    for (const gid of rootIds) {
      if (!clipboard.groups.some((g) => g.groupId === gid)) {
        logger.warn(`[buildAuthorityClipboardPayload] Selected group ${gid} absent from authority; skipping`)
      }
    }
    return null
  }

  const messageById = new Map((clipboard.messages as unknown as Message[]).map((m) => [m.id, m]))
  const blocksByMessageId = new Map<string, MessageBlock[]>()
  for (const block of clipboard.blocks as unknown as MessageBlock[]) {
    const arr = blocksByMessageId.get(block.messageId)
    if (arr) {
      arr.push(block)
    } else {
      blocksByMessageId.set(block.messageId, [block])
    }
  }

  const items: ClipboardItem[] = []
  const allSelectedMessageIds: string[] = []

  // Main already returns groups in authority order; keep that order (paste
  // sorts by positionIndex, so document order is preserved regardless).
  for (const group of clipboard.groups) {
    const groupMessages: Message[] = []
    for (const mid of group.messageIds) {
      const msg = messageById.get(mid)
      if (msg) {
        groupMessages.push(msg)
      } else {
        logger.warn(`[buildAuthorityClipboardPayload] Message ${mid} of group ${group.groupId} absent; skipping`)
      }
    }
    if (groupMessages.length === 0) {
      continue
    }
    const clonedMessages: Message[] = structuredClone(groupMessages)
    const clonedBlocks: MessageBlock[] = []
    for (const msg of groupMessages) {
      allSelectedMessageIds.push(msg.id)
      for (const block of blocksByMessageId.get(msg.id) ?? []) {
        clonedBlocks.push(structuredClone(block))
      }
    }

    // Authority order/group position; the persisted wire shape is unchanged
    // (no clipboard format migration).
    items.push({
      originalAskId: group.groupId,
      messages: clonedMessages,
      blocks: clonedBlocks,
      positionIndex: group.positionIndex
    })
  }

  if (items.length === 0) {
    return null
  }

  // Authority-enriched segment catalog membership (caller-local read, never
  // published). A segment snapshot is captured only when every authority
  // member message is in the complete selected set.
  const segmentSnapshots: ClipboardSegmentSnapshot[] = []
  try {
    const wires = await dbService.listSegments(topicId)
    const selectedSet = new Set(allSelectedMessageIds)
    for (const wire of wires) {
      const memberIds = wire.messageIds ?? []
      if (memberIds.length > 0 && memberIds.every((id) => selectedSet.has(id))) {
        segmentSnapshots.push({
          originalSegmentId: wire.id,
          name: wire.name ?? '',
          color: wire.color || getSegmentColor(wire.id),
          originalMessageIds: [...memberIds]
        })
      }
    }
  } catch (error) {
    logger.error(
      '[buildAuthorityClipboardPayload] Failed to list authority segments; publishing nothing',
      error as Error
    )
    return null
  }

  return { items, segmentSnapshots }
}

/**
 * Copy selected message groups to clipboard.
 *
 * Authority-complete under windowed loading: a selected group straddling the
 * loaded projection is copied with its complete ordered messages and blocks.
 * Read-only apart from the clipboard publication itself — Redux message and
 * block projections are never mutated. Returns the number of messages copied.
 */
export async function copyMessages(
  dispatch: AppDispatch,
  topicId: string,
  selectedGroupIds: string[],
  branchId?: string | null
): Promise<number> {
  const payload = await buildAuthorityClipboardPayload(topicId, selectedGroupIds, branchId)

  if (!payload || payload.items.length === 0) {
    return 0
  }

  const stagedBranchId = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
  dispatch(
    setClipboard({
      mode: 'copy',
      items: payload.items,
      sourceTopicId: topicId,
      sourceBranchId: stagedBranchId,
      segmentSnapshots: payload.segmentSnapshots
    })
  )

  const totalCount = payload.items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(
    `[copyMessages] Copied ${totalCount} messages from ${payload.items.length} groups, ${payload.segmentSnapshots.length} segment snapshots`
  )
  return totalCount
}

/**
 * Cut selected message groups to clipboard.
 *
 * Same authority-complete clipboard publication as copy (mode `cut`); the
 * source deletion itself happens at paste time through the single semantic
 * delete transaction there. Read-only apart from the clipboard publication —
 * Redux message and block projections are never mutated. Returns the number
 * of messages cut.
 *
 * Service-level depth gate (BRANCH-12): the cut entry itself requires the
 * selection writable through the active route before any authority clipboard
 * read or `cut` publication — direct callers outside `useEditMode` fail
 * closed the same way. Copy stays ungated (read-only authority read).
 * Gate failure publishes nothing and issues no Main mutation (existing
 * warn-and-zero semantics, no new copy).
 */
export async function cutMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[],
  branchId?: string | null
): Promise<number> {
  // Stable group IDs only (same contract as the authority payload builder).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return 0
  }

  // Depth gate binds to the exact requested set (never a stale store copy).
  try {
    const { requireEditSelectionMutable } = await import('@renderer/store/editSelection')
    requireEditSelectionMutable(getState(), topicId, rootIds)
  } catch (error) {
    logger.warn('[cutMessages] Selection is immutable through this route; cut refused', error as Error)
    return 0
  }

  const payload = await buildAuthorityClipboardPayload(topicId, rootIds, branchId)

  if (!payload || payload.items.length === 0) {
    return 0
  }

  // Staged-cut authority provenance: the addressed source route plus the
  // cut-time SOURCE projection eligibility are captured only after the cut
  // selection precheck above. The gate proves the selection writable through
  // the active loaded route, so the staged route must equal that active route
  // and the loaded ID list is the source eligibility snapshot. Paste addresses
  // the Main source delete with this staged route + eligibility without
  // rerequiring projection capability and without reading the (possibly
  // retargeted) live projection.
  const stagedBranchId = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
  let activeSourceRoute: string | null = null
  try {
    activeSourceRoute = selectActiveBranchId(getState(), topicId)
  } catch {
    activeSourceRoute = null
  }
  if (stagedBranchId !== activeSourceRoute) {
    logger.warn('[cutMessages] Staged source route differs from the active loaded route; cut refused')
    return 0
  }
  const sourceLoadedIds = [...(getState().messages.messageIdsByTopic?.[topicId] ?? [])]
  dispatch(
    setClipboard({
      mode: 'cut',
      items: payload.items,
      sourceTopicId: topicId,
      sourceBranchId: stagedBranchId,
      segmentSnapshots: payload.segmentSnapshots,
      sourceProjection: { sourceTopicId: topicId, sourceBranchId: stagedBranchId, loadedMessageIds: sourceLoadedIds }
    })
  )

  const totalCount = payload.items.reduce((sum, item) => sum + item.messages.length, 0)
  logger.info(
    `[cutMessages] Cut ${totalCount} messages from ${payload.items.length} groups, ${payload.segmentSnapshots.length} segment snapshots`
  )
  return totalCount
}

/**
 * Paste clipboard content into the target topic with a stable insertion intent.
 * Returns the number of messages pasted (actual successfully inserted count).
 *
 * Authority: the renderer derives exactly one stable intent from target
 * semantics (selected target group → after-group-tail with that stable ID;
 * explicit no-target → topic-tail) and sends it to Main in ONE
 * `insertMessageGroups` call. No loaded-projection search ever produces a DB
 * index. A supplied target ID absent from the loaded projection is still
 * sent to Main unchanged (no loaded-tail fallback for persistence).
 * Local projection stays bounded: messages are spliced into the loaded list
 * only when the anchor/group is loaded (at its loaded group tail) or for a
 * topic-tail append; an outside-loaded anchor injects nothing and never
 * replaces the loaded list with an assumed whole topic.
 */
/**
 * Best-effort transactional rollback for a cut-paste whose source delete
 * failed after the target insert committed. Removes the fresh copies through
 * the existing plain authority delete path (same addressed target route),
 * including target segments created for the paste. Throws when the rollback
 * itself cannot complete; callers retain the staged clipboard and push no
 * undo in both cases.
 */
async function rollbackPastedCutCopies(
  dispatch: AppDispatch,
  getState: () => RootState,
  targetTopicId: string,
  targetBranchId: string | null,
  insertedMessageIds: string[],
  insertedBlockIds: string[],
  targetSegmentSnapshots: TopicSegment[]
): Promise<void> {
  if (targetSegmentSnapshots.length > 0) {
    await deleteSegmentsBySnapshots(dispatch, targetSegmentSnapshots)
  }
  if (insertedMessageIds.length > 0) {
    const cleanup = await deleteMessagesFromDB(targetTopicId, insertedMessageIds, targetBranchId)
    await consumeFileCleanupResult(cleanup)
    dispatch(newMessagesActions.removeMessages({ topicId: targetTopicId, messageIds: insertedMessageIds }))
    if (insertedBlockIds.length > 0) {
      dispatch(withClosureTopics(removeManyBlocks(insertedBlockIds), targetTopicId))
    }
    await syncSegmentsAfterMessageDeletion(dispatch, getState, targetTopicId, insertedMessageIds, targetBranchId)
  }
}

export async function pasteMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  targetTopicId: string,
  targetMessageId: string
): Promise<number> {
  const state = getState()
  const { items: rawItems, mode, sourceTopicId, segmentSnapshots: clipboardSegmentSnapshots } = state.clipboard
  const stagedSourceBranchId = (state.clipboard as { sourceBranchId?: string | null }).sourceBranchId
  const stagedSourceProjection = (state.clipboard as { sourceProjection?: unknown }).sourceProjection as
    | StagedCutSourceProjection
    | null
    | undefined

  if (rawItems.length === 0) {
    logger.warn('[pasteMessages] Clipboard is empty')
    return 0
  }

  // Staged-cut provenance fail-closed BEFORE any paste write: the explicitly
  // staged source route + cut-time source projection eligibility address the
  // Main source delete independent of the current UI route, so a same-topic
  // branch switch (source branch != live route) must not refuse before
  // insertion. Missing legacy provenance (undefined), invalid route shapes,
  // and missing/mismatched source eligibility all reject with zero writes.
  // Ordinary copy paste skips this gate. Main owner guards stay final for
  // the staged addressed route.
  if (mode === 'cut' && sourceTopicId) {
    if (typeof stagedSourceBranchId === 'undefined') {
      logger.error('[pasteMessages] Missing staged cut route; refusing paste before any write')
      throw new Error('[pasteMessages] Missing staged cut route provenance')
    }
    if (
      stagedSourceBranchId !== null &&
      !(typeof stagedSourceBranchId === 'string' && stagedSourceBranchId.length > 0)
    ) {
      logger.error('[pasteMessages] Invalid staged cut route; refusing paste before any write')
      throw new Error('[pasteMessages] Invalid staged cut route provenance')
    }
    if (typeof stagedSourceProjection === 'undefined' || stagedSourceProjection === null) {
      logger.error('[pasteMessages] Missing staged cut source projection; refusing paste before any write')
      throw new Error('[pasteMessages] Missing staged cut source projection provenance')
    }
    if (
      typeof stagedSourceProjection !== 'object' ||
      stagedSourceProjection.sourceTopicId !== sourceTopicId ||
      stagedSourceProjection.sourceBranchId !== stagedSourceBranchId ||
      !Array.isArray(stagedSourceProjection.loadedMessageIds)
    ) {
      logger.error('[pasteMessages] Mismatched staged cut source projection; refusing paste before any write')
      throw new Error('[pasteMessages] Mismatched staged cut source projection provenance')
    }
  }

  // Sort items by their original position to preserve document order
  const items = [...rawItems].sort((a, b) => a.positionIndex - b.positionIndex)

  // Pre-batch ordered target loaded projection (captured BEFORE any DB or
  // Redux mutation; used ONLY for the bounded local projection commit, never
  // as an authority index).
  const targetMessages = (selectLoadedMessagesForTopic(state, targetTopicId) ?? []) as Message[]

  // Stable insertion intent for Main (authority). Never derived from loaded
  // positions: the supplied stable target ID travels unchanged even when it
  // is absent from the loaded projection.
  const stableIntent: InsertMessageGroupIntent =
    typeof targetMessageId === 'string' && targetMessageId.length > 0
      ? { kind: 'after-group-tail', messageId: targetMessageId }
      : { kind: 'topic-tail' }

  // Track file reference deltas for undo
  const fileReferenceDeltas: Array<{ fileId: string; delta: number }> = []
  const insertedMessageIds: string[] = []
  const allInsertedMessages: Message[] = []
  const allInsertedBlocks: MessageBlock[] = []

  // Cut source restoration material arrives from the single semantic delete
  // below (authority undo parts) — never from loaded-projection derivation,
  // so a straddling selection keeps its outside-loaded members for undo.
  // No pre-paste loaded read is needed: stable restore intents stay correct
  // for same-topic cut-paste because undo/redo resolve by stable anchor, not
  // by numeric position.
  let sourceGroupAnchors: GroupAnchor[] = []
  let sourceSegmentSnapshots: SegmentSnapshot[] = []

  // ID mapping: original message ID → new message ID
  const idMapping = new Map<string, string>()

  // Ordered batch entries for the ONE `pasteMessagesToTopic` call.
  const entries: Array<{ message: Message; blocks: MessageBlock[] }> = []

  for (const item of items) {
    // First pass: generate new IDs for all messages in the group
    for (const originalMsg of item.messages) {
      idMapping.set(originalMsg.id, uuidv4())
    }

    // Second pass: create new messages and blocks with mapped IDs
    for (const originalMsg of item.messages) {
      const newMsgId = idMapping.get(originalMsg.id)!
      const clonedBlocksForMsg: MessageBlock[] = []

      // Create new block IDs and update references
      const newBlockIds: string[] = []
      for (const originalBlock of item.blocks) {
        if (originalBlock.messageId === originalMsg.id) {
          const newBlockId = uuidv4()
          const clonedBlock = {
            ...structuredClone(originalBlock),
            id: newBlockId,
            messageId: newMsgId
          }
          clonedBlocksForMsg.push(clonedBlock)
          newBlockIds.push(newBlockId)

          // Track file reference deltas
          if (clonedBlock.type === MessageBlockType.FILE || clonedBlock.type === MessageBlockType.IMAGE) {
            const file = (clonedBlock as FileMessageBlock | ImageMessageBlock).file
            if (file) {
              fileReferenceDeltas.push({ fileId: file.id, delta: 1 })
            }
          }
        }
      }

      // Create new message with updated IDs
      const newMessage: Message = {
        ...structuredClone(originalMsg),
        id: newMsgId,
        topicId: targetTopicId,
        blocks: newBlockIds
      }

      // Update askId for assistant messages
      if (newMessage.role === 'assistant' && originalMsg.askId) {
        const mappedAskId = idMapping.get(originalMsg.askId)
        if (mappedAskId) {
          newMessage.askId = mappedAskId
        } else {
          // Fallback: use the first message in this item as the group key
          const firstMsgInItem = item.messages[0]
          const mappedFirstId = idMapping.get(firstMsgInItem.id)
          newMessage.askId = mappedFirstId || newMsgId
        }
      }

      entries.push({ message: newMessage, blocks: clonedBlocksForMsg })
      allInsertedMessages.push(newMessage)
      allInsertedBlocks.push(...clonedBlocksForMsg)
      insertedMessageIds.push(newMsgId)
    }
  }

  // Addressed target route captured once for the whole paste (insert, segment
  // reconstruction, undo provenance, and cut-failure rollback share it).
  let targetBranchId: string | null = null
  try {
    const liveTarget = selectActiveBranchId(getState(), targetTopicId)
    targetBranchId = typeof liveTarget === 'string' && liveTarget.length > 0 ? liveTarget : null
  } catch {
    targetBranchId = null
  }

  // DB-first (LOCK-001): ONE atomic stable insertion BEFORE any Redux commit.
  // If the batch fails, Redux is never touched and nothing is projected.
  // Main success publishes the exact final committed canonical wires plus
  // capability; the shared ack below installs rows+capability atomically.
  let insertAck: Awaited<ReturnType<typeof dbService.insertMessageGroups>>
  try {
    insertAck = await dbService.insertMessageGroups(
      targetTopicId,
      [{ entries: entries as unknown as MessageBlockEntry[], intent: stableIntent }],
      targetBranchId
    )
  } catch (error) {
    logger.error('[pasteMessages] Failed to persist paste batch to DB', error as Error)
    throw new Error(`[pasteMessages] DB batch write failed for ${entries.length} entries`)
  }

  // Bounded local projection via the shared Main acknowledgment: the ack's
  // stable neighbors decide placement against the current resident order;
  // pasted new rows enter only when the anchor is resident or the run is the
  // canonical topic-tail, otherwise nothing is injected. Capability comes
  // from Main only — never inferred from the request.
  publishInsertMessageGroupsAck(dispatch, targetTopicId, targetBranchId, insertAck, [insertedMessageIds])

  // Increment file reference counts for pasted content
  if (fileReferenceDeltas.length > 0) {
    for (const { fileId, delta } of fileReferenceDeltas) {
      await dbService.updateFileCount(fileId, delta, false)
    }
  }

  // Reconstruct segments from clipboard snapshots.
  // Post-commit bookkeeping coherence: the target insert above already
  // committed in Main. A convergence/upsert failure below must still retain
  // a usable undo entry for the persisted copies (no untracked commit), and
  // in cut mode the source must remain un-deleted when the target stage did
  // not fully complete. No new recovery subsystem: natural stage handling
  // with the existing postcommit-convergence conventions.
  const targetSegmentSnapshots: TopicSegment[] = []
  let targetStageError: unknown = null
  if (clipboardSegmentSnapshots && clipboardSegmentSnapshots.length > 0) {
    try {
      for (const clipSnap of clipboardSegmentSnapshots) {
        // Map original message IDs to new message IDs
        const newMessageIds: string[] = []
        let allMapped = true
        for (const origId of clipSnap.originalMessageIds) {
          const mappedId = idMapping.get(origId)
          if (mappedId) {
            newMessageIds.push(mappedId)
          } else {
            allMapped = false
            break
          }
        }

        // Skip if mapping is incomplete (some original IDs were not part of the paste)
        if (!allMapped || newMessageIds.length === 0) {
          logger.warn(
            `[pasteMessages] Skipping segment "${clipSnap.name}" — incomplete ID mapping (${newMessageIds.length}/${clipSnap.originalMessageIds.length})`
          )
          continue
        }

        // Create new segment with new ID in target topic.
        // DB-first: collect the Main wire mapping; Redux convergence happens
        // once below via a single list+replace so shifted siblings converge.
        const newId = uuidv4()
        const wire = await dbService.upsertSegment(
          newId,
          targetTopicId,
          clipSnap.name,
          newMessageIds,
          clipSnap.color,
          targetBranchId
        )
        const newSegment = mapSegmentWireToTopicSegment(wire)
        if (wire.name == null) newSegment.name = clipSnap.name
        targetSegmentSnapshots.push(newSegment)
      }

      // Batch convergence through the ONE preserving catalog publication:
      // exactly one authority list + atomic install with the resident target
      // window preserved (no transient blank). Superseded reads discard
      // silently inside converge (no throw); a real list failure throws and is
      // captured below for coherent undo bookkeeping.
      if (targetSegmentSnapshots.length > 0) {
        await convergeTopicSegmentCatalog(dispatch, targetTopicId, getState)
      }

      logger.info(
        `[pasteMessages] Reconstructed ${targetSegmentSnapshots.length} segments from ${clipboardSegmentSnapshots.length} clipboard snapshots`
      )
    } catch (error) {
      // Target stage did not fully complete: retain the wire snapshots
      // collected so far for undo (copies + committed segments stay tracked),
      // skip the source delete below, still push undo, then surface
      // truthfully. Never silently corrupt on retry: the pushed undo removes
      // exactly these copies/segments.
      targetStageError = error
      logger.error(
        '[pasteMessages] Target segment stage failed after insert commit; preserving copies with undo, source remains',
        error as Error
      )
    }
  }

  // If cut mode: remove COMPLETE stable source members through the staged-cut
  // authority transaction (cut-specific, no projection capability rerequire).
  // Stable member roots only — ALL complete clipboard member message IDs
  // (deduped, authority order), never just `originalAskId`. Main expands user
  // dependents, validates every root owner == staged addressed route with
  // all-owned atomicity, and returns the full authority undo snapshot. The
  // helper owns file cleanup, loaded-intersection removal, authority segment
  // convergence, and anchor transfer. Multi-group cuts stay one transaction.
  // Insert-first safety is preserved (source untouched when insertion fails).
  // Pre-commit source deletion failure rolls back the fresh copies through
  // the existing plain authority delete path (same addressed target route),
  // the staged clipboard is retained for retry, no cut_paste undo is pushed,
  // and the failure propagates (never swallowed as success).
  // Post-commit convergence failure (Main COMMITTED, typed committed marker):
  // the movement already happened — pasted copies are PRESERVED (no rollback),
  // the authoritative undo parts from the marker are retained, real cut
  // clipboard/undo bookkeeping finalizes below, and the convergence error is
  // surfaced truthfully only after that bookkeeping.
  let sourceRootIds: string[] = []
  let pendingPostCommitError: unknown = null
  // A failed target segment stage gates the cut source delete: the source
  // remains un-deleted and the staged clipboard is retained for retry. The
  // undo pushed below still tracks the persisted copies.
  const targetStageComplete = targetStageError === null
  if (mode === 'cut' && sourceTopicId && targetStageComplete) {
    const stableRoots = [
      ...new Set(
        items.flatMap((item) => item.messages.map((m) => m.id)).filter((id) => typeof id === 'string' && id.length > 0)
      )
    ]

    if (stableRoots.length > 0) {
      try {
        const result = await executeStagedCutSourceDelete(dispatch, getState, {
          sourceTopicId,
          sourceBranchId: stagedSourceBranchId as string | null,
          rootIds: stableRoots,
          sourceProjection: stagedSourceProjection as StagedCutSourceProjection
        })
        sourceGroupAnchors = result.undoParts.groupAnchors
        sourceSegmentSnapshots = result.undoParts.segmentSnapshots
        sourceRootIds = [...stableRoots]
      } catch (error) {
        if (isDeletePostCommitConvergenceError(error)) {
          // Committed: source rows are gone in Main. Never roll back the
          // surviving pasted copies and never claim a fake cut failure.
          sourceGroupAnchors = error.undoParts.groupAnchors
          sourceSegmentSnapshots = error.undoParts.segmentSnapshots
          sourceRootIds = [...stableRoots]
          pendingPostCommitError = error
          logger.error(
            '[pasteMessages] Cut source deleted but renderer convergence failed; preserving pasted copies with usable undo',
            error as Error
          )
        } else {
          logger.error('[pasteMessages] Cut source delete failed; rolling back pasted copies', error as Error)
          try {
            await rollbackPastedCutCopies(
              dispatch,
              getState,
              targetTopicId,
              targetBranchId,
              insertedMessageIds,
              allInsertedBlocks.map((b) => b.id),
              targetSegmentSnapshots
            )
          } catch (rollbackError) {
            logger.error('[pasteMessages] Cut rollback failed; clipboard retained without undo', rollbackError as Error)
            throw new Error(
              `[pasteMessages] Cut source delete failed and rollback incomplete for ${insertedMessageIds.length} copies: ${(error as Error)?.message ?? String(error)}`
            )
          }
          throw new Error(
            `[pasteMessages] Cut source delete failed; pasted copies rolled back: ${(error as Error)?.message ?? String(error)}`
          )
        }
      }
    }

    // LOCK-P5.3-1: No separate updateFileCount for source blocks here.
    // consumeFileCleanupResult inside the helper already handled physical
    // file cleanup via FileManager.deleteFile which decrements Dexie
    // files.count.

    // Clipboard clears only when the cut movement fully completed (target
    // stage complete + source delete attempted). A failed target stage
    // retains the staged clipboard for retry; a pre-commit source failure
    // above already threw after rollback with the clipboard retained.
    if (targetStageComplete) {
      dispatch(clearClipboard())
    }
  } else if (mode === 'cut' && sourceTopicId && !targetStageComplete) {
    // Target stage failed before any source write: source remains un-deleted
    // by construction (no delete attempted above); clipboard retained.
    logger.warn('[pasteMessages] Target stage incomplete; cut source untouched, clipboard retained')
  }

  // Create undo action
  // Calculate anchor: first non-pasted message after the published inserted
  // run in current loaded order when projected; otherwise null (tail). The
  // stable redo authority is `stableIntent` (never the numeric index).
  const finalTargetMessages = (selectLoadedMessagesForTopic(getState(), targetTopicId) ?? []) as Message[]
  const insertedIdSet = new Set(insertedMessageIds)
  let anchorMessageId: string | null = null
  {
    let firstInsertedIdx = -1
    for (let i = 0; i < finalTargetMessages.length; i++) {
      if (insertedIdSet.has(finalTargetMessages[i].id)) {
        firstInsertedIdx = i
        break
      }
    }
    if (firstInsertedIdx !== -1) {
      anchorMessageId = findAnchorAfterPosition(finalTargetMessages, firstInsertedIdx, insertedIdSet)
    }
  }
  const legacyPositionIndex = targetMessages.length

  if (mode === 'cut' && sourceTopicId) {
    const undoAction: CutPasteUndoAction = {
      id: uuidv4(),
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: targetTopicId,
      insertedMessageIds,
      targetInsertPositionIndex: legacyPositionIndex,
      targetAnchorMessageId: anchorMessageId,
      targetInsertIntent: stableIntent,
      sourceTopicId,
      sourceBranchId: stagedSourceBranchId as string | null,
      targetBranchId,
      sourceRootIds,
      sourceProjection: stagedSourceProjection as StagedCutSourceProjection,
      sourceGroupAnchors,
      sourceSegmentSnapshots,
      targetSegmentSnapshots,
      pastedMessagesSnapshot: allInsertedMessages,
      pastedBlocksSnapshot: allInsertedBlocks,
      fileReferenceDeltas
    }
    dispatch(pushUndoAction(undoAction))
  } else {
    const undoAction: PasteUndoAction = {
      id: uuidv4(),
      type: 'paste',
      timestamp: Date.now(),
      targetTopicId: targetTopicId,
      insertedMessageIds,
      targetInsertPositionIndex: legacyPositionIndex,
      targetAnchorMessageId: anchorMessageId,
      targetInsertIntent: stableIntent,
      targetSegmentSnapshots,
      pastedMessagesSnapshot: allInsertedMessages,
      pastedBlocksSnapshot: allInsertedBlocks,
      fileReferenceDeltas
    }
    dispatch(pushUndoAction(undoAction))
  }

  // Committed convergence failure surfaces AFTER real cut bookkeeping above
  // (clipboard cleared, usable cut_paste undo pushed, copies preserved).
  if (pendingPostCommitError !== null) {
    throw new Error(
      `[pasteMessages] Cut source deleted; renderer convergence failed after commit (pasted copies preserved): ${(pendingPostCommitError as Error)?.message ?? String(pendingPostCommitError)}`
    )
  }

  // Target segment stage failed AFTER the insert commit: the undo above
  // already tracks the persisted copies (+ committed wire snapshots), the cut
  // source remains un-deleted, and the clipboard is retained. Surface
  // truthfully so retry/undo stays explicit (never swallowed as success).
  if (targetStageError !== null) {
    throw new Error(
      `[pasteMessages] Target segment convergence failed after insert commit (copies preserved with undo): ${(targetStageError as Error)?.message ?? String(targetStageError)}`
    )
  }

  logger.info(
    `[pasteMessages] Pasted ${insertedMessageIds.length} messages from ${items.length} groups with stable intent ${stableIntent.kind}`
  )
  return insertedMessageIds.length
}

/**
 * Delete selected message groups in edit mode.
 * Returns the number of messages deleted (authority-expanded count).
 *
 * Unified semantic path: stable selected group IDs are passed as root IDs
 * ONLY — Main expands user dependents, deletes atomically, and returns the
 * full authority undo snapshot. No loaded-projection cascade derivation, no
 * window-relative anchors, no loaded block/segment snapshots as undo source.
 * DB failure leaves Redux/anchors untouched and pushes no undo.
 */
export async function deleteSelectedMessages(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  selectedGroupIds: string[]
): Promise<number> {
  // Stable root IDs only (dedupe defense-in-depth; Main rejects duplicates).
  const rootIds = [...new Set(selectedGroupIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (rootIds.length === 0) {
    return 0
  }

  // BRANCH-12: the whole selection must be writable through the
  // active route — one non-owned member blocks the entire batch with zero IPC
  // calls (no skip-and-partial-write). Main stays final for expansion.
  // The gate binds to the requested root IDs (never a stale store copy).
  try {
    const { requireEditSelectionMutable } = await import('@renderer/store/editSelection')
    requireEditSelectionMutable(getState(), topicId, rootIds)
  } catch (error) {
    logger.warn('[deleteSelectedMessages] Selection is immutable through this route; delete refused', error as Error)
    return 0
  }

  // Unified semantic delete: DB-first, then one converged projection update
  // (cleanup consume, loaded-intersection removal, full segment replace,
  // authority-key anchor transfer) inside the helper.
  let result: Awaited<ReturnType<typeof executeDeleteMessagesWithDependents>>
  try {
    result = await executeDeleteMessagesWithDependents(dispatch, getState, topicId, rootIds)
  } catch (error) {
    logger.error('[deleteSelectedMessages] Failed to delete from DB', error as Error)
    return 0
  }

  // LOCK-P5.3-1: No separate updateFileCount here. consumeFileCleanupResult
  // inside the helper already handled physical file cleanup via
  // FileManager.deleteFile which decrements Dexie files.count. A second
  // dbService.updateFileCount would double-decrement the same references.

  // Undo from the authority snapshot (never loaded projection).
  const undoAction: DeleteUndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    rootMessageIds: rootIds,
    insertedMessageIds: result.response.deletedMessageIds,
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: result.undoParts.fileReferenceDeltas,
    groupAnchors: result.undoParts.groupAnchors,
    segmentSnapshots: result.undoParts.segmentSnapshots
  }

  dispatch(pushUndoAction(undoAction))

  logger.info(
    `[deleteSelectedMessages] Deleted ${result.response.deletedMessageIds.length} messages from ${rootIds.length} groups`
  )
  return result.response.deletedMessageIds.length
}

/**
 * Delete a single message with undo support.
 *
 * Unified semantic path: the message ID is passed as the single stable root
 * — Main resolves dependents (user + same-askId assistants, or single
 * non-user) and returns the authority undo snapshot. The menu confirm dialog
 * and trace cleanup stay at the Menu/hook layer; this function ends at the
 * semantic command. DB failure leaves Redux/anchors untouched and pushes no
 * undo.
 */
export async function deleteSingleMessage(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  message: Message
): Promise<void> {
  const state = getState()
  const msg = state.messages.entities[message.id]
  if (!msg) return

  // Unified semantic delete: DB-first, then one converged projection update
  // inside the helper (cleanup consume, loaded-intersection removal, full
  // segment replace, authority-key anchor transfer).
  let result: Awaited<ReturnType<typeof executeDeleteMessagesWithDependents>>
  try {
    result = await executeDeleteMessagesWithDependents(dispatch, getState, topicId, [message.id])
  } catch (error) {
    // Main validation/not-found failures are never silent: unified toast.
    logger.error('[deleteSingleMessage] Failed to delete from DB', error as Error)
    window.toast.error(t('common.delete_failed'))
    return
  }

  // LOCK-P5.3-1: No separate updateFileCount here. consumeFileCleanupResult
  // inside the helper already handled physical file cleanup via
  // FileManager.deleteFile which decrements Dexie files.count. A second
  // dbService.updateFileCount would double-decrement the same references.

  // Undo from the authority snapshot (never loaded projection).
  const undoAction: DeleteUndoAction = {
    id: uuidv4(),
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    rootMessageIds: [message.id],
    insertedMessageIds: result.response.deletedMessageIds,
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: result.undoParts.fileReferenceDeltas,
    groupAnchors: result.undoParts.groupAnchors,
    segmentSnapshots: result.undoParts.segmentSnapshots
  }

  dispatch(pushUndoAction(undoAction))

  logger.info(
    `[deleteSingleMessage] Deleted ${result.response.deletedMessageIds.length} messages from topic ${topicId}`
  )
}
