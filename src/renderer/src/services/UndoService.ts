import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { publishInsertMessageGroupsAck } from '@renderer/services/insertGroupsAck'
import type { AppDispatch, RootState } from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { removeManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { requireMutableForActiveRoute } from '@renderer/store/routeAnswerGroup'
import {
  deleteMessagesFromDB,
  executeDeleteMessagesWithDependents,
  executeStagedCutSourceDelete,
  publishDeleteAuthorityCatalog
} from '@renderer/store/thunk/messageThunk'
import {
  deleteSegmentsBySnapshots,
  restoreSegmentsAfterUndo,
  restoreTargetSegments,
  syncSegmentsAfterMessageDeletion
} from '@renderer/store/thunk/topicSegmentThunk'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import { prepareRedo, prepareUndo } from '@renderer/store/undoStack'
import type {
  CutPasteUndoAction,
  DeleteUndoAction,
  GroupAnchor,
  PasteUndoAction,
  UndoAction
} from '@renderer/types/editMode'
import { MessageBlockType } from '@renderer/types/newMessage'
import { isSegmentCatalogConvergenceError } from '@renderer/utils/topicSegmentCatalog'
import type { InsertMessageGroup, InsertMessageGroupIntent, MessageBlockEntry } from '@shared/chatDb'

const logger = loggerService.withContext('UndoService')

/**
 * Committed-convergence marker: Main authority already committed but a
 * renderer post-commit projection step failed. History must stay advanced
 * (never roll back to re-insert already-restored IDs) and the failure must
 * surface truthfully via the committed log path. Covers both the typed
 * segment-catalog read failure and the existing typed delete post-commit
 * marker. Pre-commit rejections and actual Main segment upsert/replace
 * failures are never matched here and stay fail-closed (history rolls back).
 *
 * Local duck-typing (no import from messageThunk) so unit mocks of that
 * module stay intact: matches `committed === true` with both `response` and
 * `undoParts` objects, same shape as `isDeletePostCommitConvergenceError`.
 */
function isCommittedDeleteConvergenceError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { committed?: unknown; response?: unknown; undoParts?: unknown }
  return (
    candidate.committed === true && typeof candidate.response === 'object' && typeof candidate.undoParts === 'object'
  )
}

function isCommittedConvergenceError(error: unknown): boolean {
  return isSegmentCatalogConvergenceError(error) || isCommittedDeleteConvergenceError(error)
}

/**
 * Resolve the stable redo intent for paste/cut-paste.
 * New actions carry the original stable intent; legacy in-memory actions fall
 * back to the stable after-region anchor (before-message) or topic-tail.
 * Never a numeric index.
 */
function resolveRedoIntent(action: PasteUndoAction | CutPasteUndoAction): InsertMessageGroupIntent {
  if (action.targetInsertIntent) return action.targetInsertIntent
  if (action.targetAnchorMessageId) return { kind: 'before-message', messageId: action.targetAnchorMessageId }
  return { kind: 'topic-tail' }
}

/**
 * Build stable restore groups from authority snapshots.
 * anchorMessageId != null → before-message; null → topic-tail. No renderer
 * authority index is consulted.
 */
function buildRestoreGroups(groupAnchors: GroupAnchor[]): InsertMessageGroup[] {
  return groupAnchors.map((anchor) => {
    const entries: MessageBlockEntry[] = anchor.messages.map((message) => ({
      message: message as unknown as MessageBlockEntry['message'],
      blocks: anchor.blocks.filter((b) => b.messageId === message.id) as unknown as MessageBlockEntry['blocks']
    }))
    const intent: InsertMessageGroupIntent =
      anchor.anchorMessageId != null
        ? { kind: 'before-message', messageId: anchor.anchorMessageId }
        : { kind: 'topic-tail' }
    return { entries, intent }
  })
}

/**
 * Update file reference counts in DB
 */
async function updateFileReferenceCounts(
  deltas: Array<{ fileId: string; delta: number }>,
  increment: boolean
): Promise<void> {
  for (const { fileId, delta } of deltas) {
    const actualDelta = increment ? delta : -delta
    await dbService.updateFileCount(fileId, actualDelta, false)
  }
}

/**
 * Restore groups with one atomic stable command.
 * Sends all Main-produced full restore groups in request order with
 * before-message/topic-tail intents (no numeric index). Main success
 * publishes the exact committed canonical wires plus capability; the shared
 * ack installs rows+capability atomically. Local projection stays bounded by
 * each group's pre-delete loaded intersection (`loadedMessageIds` decides
 * WHICH rows enter, Main decides capability): an empty intersection injects
 * nothing even for topic-tail, and non-tail runs with nonresident neighbors
 * inject nothing.
 */
async function restoreGroupsByStableAnchors(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  groupAnchors: GroupAnchor[],
  addressedRoute?: string | null
): Promise<void> {
  if (groupAnchors.length === 0) return
  const groups = buildRestoreGroups(groupAnchors)
  const route = typeof addressedRoute === 'undefined' ? selectActiveBranchId(getState(), topicId) : addressedRoute

  // DB-first: one atomic multi-group restore with FULL entries. Missing/
  // cross-topic anchors fail the whole transaction with no partial writes and
  // no Redux changes. Main publishes canonical wires+capability on success.
  let ack: Awaited<ReturnType<typeof dbService.insertMessageGroups>>
  try {
    ack = await dbService.insertMessageGroups(topicId, groups, route)
  } catch (error) {
    logger.error('[restoreGroupsByStableAnchors] Failed to restore groups to DB', error as Error)
    throw error
  }

  // Bounded visible subsets in authority order per group (caller-computed
  // WHICH; capability is Main-only from the ack).
  const visiblePerGroup = groupAnchors.map((anchor) => {
    const allowed = new Set(anchor.loadedMessageIds ?? [])
    return anchor.messages.filter((m) => allowed.has(m.id)).map((m) => m.id)
  })
  publishInsertMessageGroupsAck(dispatch, topicId, route, ack, visiblePerGroup)
}

/**
 * Execute undo operation based on the top action in undoStack.
 * Returns the undone action for toast display, or null if nothing to undo.
 */
export async function executeUndo(dispatch: AppDispatch, getState: () => RootState): Promise<UndoAction | null> {
  const state = getState()
  const { undoStack } = state.undoStack

  if (undoStack.length === 0) {
    logger.info('[undo] Stack is empty')
    return null
  }

  const action = undoStack[undoStack.length - 1]

  // Move from undo to redo stack
  dispatch(prepareUndo())

  try {
    switch (action.type) {
      case 'delete':
        await undoDelete(dispatch, getState, action)
        break
      case 'paste':
        await undoPaste(dispatch, getState, action)
        break
      case 'cut_paste':
        await undoCutPaste(dispatch, getState, action)
        break
      default: {
        const _exhaustive: never = action
        throw new Error(`[executeUndo] Unknown action type: ${(_exhaustive as any).type}`)
      }
    }
  } catch (error) {
    // Committed convergence: Main authority stands (messages restored or
    // copies deleted) but the segment catalog read failed. History stays
    // advanced — rolling back would retry the already-committed insert and
    // hit CONFLICT. Log the committed distinction truthfully and return the
    // action (authority success); never fabricate a catalog.
    if (isCommittedConvergenceError(error)) {
      logger.error(
        '[undo] Authority committed but segment convergence failed; history advanced, projection invalidated',
        error as Error
      )
      return action
    }
    logger.error('[undo] Failed:', error as Error)
    // Move back from redo to undo on failure
    dispatch(prepareRedo())
    return null
  }

  return action
}

/**
 * Execute redo operation.
 * Returns the redone action for toast display, or null if nothing to redo.
 */
export async function executeRedo(dispatch: AppDispatch, getState: () => RootState): Promise<UndoAction | null> {
  const state = getState()
  const { redoStack } = state.undoStack

  if (redoStack.length === 0) {
    return null
  }

  const action = redoStack[redoStack.length - 1]

  // Move from redo to undo stack
  dispatch(prepareRedo())

  try {
    switch (action.type) {
      case 'delete':
        await redoDelete(dispatch, getState, action)
        break
      case 'paste':
        await redoPaste(dispatch, getState, action)
        break
      case 'cut_paste':
        await redoCutPaste(dispatch, getState, action)
        break
      default: {
        const _exhaustive: never = action
        throw new Error(`[executeRedo] Unknown action type: ${(_exhaustive as any).type}`)
      }
    }
  } catch (error) {
    if (isCommittedConvergenceError(error)) {
      logger.error(
        '[redo] Authority committed but segment convergence failed; history advanced, projection invalidated',
        error as Error
      )
      return action
    }
    logger.error('[redo] Failed:', error as Error)
    // Move back from undo to redo on failure
    dispatch(prepareUndo())
    return null
  }

  return action
}

// ==================== Undo Implementations ====================

/**
 * Undo delete = re-insert deleted messages and blocks
 */
async function undoDelete(dispatch: AppDispatch, getState: () => RootState, action: DeleteUndoAction): Promise<void> {
  const { targetTopicId, groupAnchors, fileReferenceDeltas = [], segmentSnapshots = [] } = action

  if (groupAnchors.length === 0) {
    logger.warn('[undoDelete] No group anchors to restore')
    return
  }

  // Restore file references
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, false)
  }

  // Restore groups with one atomic stable command (no numeric index)
  await restoreGroupsByStableAnchors(dispatch, getState, targetTopicId, groupAnchors)

  // Restore segment membership
  await restoreSegmentsAfterUndo(dispatch, getState, segmentSnapshots)

  const totalMessages = groupAnchors.reduce((sum, a) => sum + a.messages.length, 0)
  logger.info(`[undoDelete] Restored ${totalMessages} messages from ${groupAnchors.length} groups`)
}

/**
 * Undo paste = remove the pasted messages
 */
async function undoPaste(
  dispatch: AppDispatch,
  getState: () => RootState,
  action: PasteUndoAction | CutPasteUndoAction,
  addressedTargetRoute?: string | null
): Promise<void> {
  const { targetTopicId, insertedMessageIds = [], targetSegmentSnapshots = [] } = action

  if (insertedMessageIds.length === 0) {
    logger.warn('[undoPaste] No message IDs to remove')
    return
  }

  // Collect block IDs BEFORE any changes
  const stateBefore = getState()
  const blockIdsToRemove: string[] = []
  for (const msgId of insertedMessageIds) {
    const message = stateBefore.messages.entities[msgId]
    if (message?.blocks) {
      blockIdsToRemove.push(...message.blocks)
    }
  }

  // DB-first: delete from DB before dispatching to Redux (LOCK-001).
  // Branch-aware: ordinary paste uses the live active route; cut_paste callers
  // pass the staged target route explicitly (no silent live fallback for new
  // staged actions).
  const targetRoute =
    typeof addressedTargetRoute === 'undefined' ? selectActiveBranchId(getState(), targetTopicId) : addressedTargetRoute
  let cleanup
  try {
    cleanup = await deleteMessagesFromDB(targetTopicId, insertedMessageIds, targetRoute)
  } catch (error) {
    logger.error('[undoPaste] Failed to delete from DB', error as Error)
    throw error
  }

  // Consume file cleanup exactly once after commit
  await consumeFileCleanupResult(cleanup)

  // Remove messages from Redux only after DB delete succeeds
  dispatch(newMessagesActions.removeMessages({ topicId: targetTopicId, messageIds: insertedMessageIds }))

  // Remove blocks from Redux
  if (blockIdsToRemove.length > 0) {
    dispatch(withClosureTopics(removeManyBlocks(blockIdsToRemove), targetTopicId))
  }

  // Delete target segments that were created during paste BEFORE syncing,
  // so syncSegmentsAfterMessageDeletion won't find (and double-delete) them.
  // Typed catalog-read failures are projection-only (Main segment deletes
  // already committed): record and continue to the sync phase instead of
  // skipping required target cleanup. Main segment-write failures stay
  // fail-closed.
  let pendingConvergence: unknown = null
  if (targetSegmentSnapshots.length > 0) {
    try {
      await deleteSegmentsBySnapshots(dispatch, targetSegmentSnapshots, getState)
    } catch (error) {
      if (isSegmentCatalogConvergenceError(error)) {
        pendingConvergence = error
        logger.error(
          '[undoPaste] Target segment delete committed but catalog convergence failed; continuing cleanup',
          error as Error
        )
      } else {
        throw error
      }
    }
  }

  // Sync segments after message deletion (only non-target segments remain).
  // Cut_paste callers pass the staged target route explicitly so a live route
  // switch mid-cleanup cannot retarget the membership write; ordinary paste
  // omits the route and retains the existing live-route behavior.
  try {
    if (typeof addressedTargetRoute === 'undefined') {
      await syncSegmentsAfterMessageDeletion(dispatch, getState, targetTopicId, insertedMessageIds)
    } else {
      await syncSegmentsAfterMessageDeletion(dispatch, getState, targetTopicId, insertedMessageIds, targetRoute)
    }
  } catch (error) {
    if (isSegmentCatalogConvergenceError(error)) {
      pendingConvergence = pendingConvergence ?? error
      logger.error(
        '[undoPaste] Target cleanup committed but catalog convergence failed; authority stands',
        error as Error
      )
    } else {
      throw error
    }
  }

  if (pendingConvergence) throw pendingConvergence

  // LOCK-P5.3-1: No separate updateFileReferenceCounts here.
  // consumeFileCleanupResult above already handled physical file cleanup
  // via FileManager.deleteFile which decrements Dexie files.count. A second
  // dbService.updateFileCount would double-decrement the same references.

  logger.info(
    `[undoPaste] Removed ${insertedMessageIds.length} pasted messages, ${targetSegmentSnapshots.length} target segments`
  )
}

/**
 * Undo cut_paste = restore source messages + remove pasted copies.
 *
 * Same-topic hazard: source restore anchors are authority-generated AFTER
 * the paste insertion, so an anchor may reference an inserted copy. Deleting
 * the copies first would make that anchor missing and lose the source.
 * Restoring the source FIRST keeps every inserted anchor present, so the
 * stable restore transaction succeeds; the copies are deleted afterwards.
 * Cross-topic anchors never reference target copies, so restore-first is
 * equally correct there (behavior preserved).
 *
 * Failure semantics (explicit, no data loss):
 * - pre-commit source restore failure (missing/cross-topic anchors, Main
 *   insert rejection, actual Main segment upsert/replace failure) → throw
 *   BEFORE touching paste copies; the copies remain and history does not
 *   advance (executeUndo moves the action back).
 * - committed catalog-read failure after a Main write (typed
 *   SegmentCatalogConvergenceError: source segments or target cleanup list
 *   failed) → continue all REQUIRED Main phases (source restore → target
 *   cleanup), then throw the typed marker so executeUndo keeps history
 *   advanced instead of retrying the committed insert into CONFLICT.
 * - paste-copy Main removal failure AFTER a successful source restore →
 *   throw and retain the duplicate (restored source + remaining copies)
 *   rather than losing the source. History likewise does not advance
 *   (generic operation failure, documented unresolved without a recovery
 *   subsystem).
 */
async function undoCutPaste(
  dispatch: AppDispatch,
  getState: () => RootState,
  action: CutPasteUndoAction
): Promise<void> {
  const { sourceTopicId, sourceGroupAnchors, sourceSegmentSnapshots = [] } = action
  // Staged-addressed provenance (new actions only). Legacy actions without
  // recorded routes retain the previous live-route behavior below.
  // The explicitly staged routes address the Main restores/deletes
  // independent of the current UI route: a branch switch after paste must not
  // refuse undo, and must never retarget writes to the live route.
  // Missing staged routes still fail closed before any write.
  const hasStagedRoutes = typeof action.sourceBranchId !== 'undefined' || typeof action.targetBranchId !== 'undefined'
  let stagedSourceRoute: string | null | undefined
  let stagedTargetRoute: string | null | undefined
  if (hasStagedRoutes) {
    if (typeof action.sourceBranchId === 'undefined' || typeof action.targetBranchId === 'undefined') {
      throw new Error('[undoCutPaste] Missing staged cut routes; refusing undo before any write')
    }
    stagedSourceRoute = action.sourceBranchId
    stagedTargetRoute = action.targetBranchId
  }

  if (sourceGroupAnchors.length === 0) {
    // Nothing was deleted at paste time (e.g. paste source-delete failure):
    // only the pasted copies need removal.
    await undoPaste(dispatch, getState, action, stagedTargetRoute)
    logger.warn('[undoCutPaste] No source group anchors to restore')
    return
  }

  // Phase 1: restore the deleted source messages using the stable restore
  // groups. Any throw leaves the pasted copies untouched (no data loss).
  const sourceFileDeltas: Array<{ fileId: string; delta: number }> = []
  for (const anchor of sourceGroupAnchors) {
    for (const block of anchor.blocks) {
      if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
        const file = (block as any).file
        if (file) {
          sourceFileDeltas.push({ fileId: file.id, delta: 1 })
        }
      }
    }
  }
  if (sourceFileDeltas.length > 0) {
    await updateFileReferenceCounts(sourceFileDeltas, true)
  }

  // Stable restore: one atomic command with before-message/topic-tail intents
  // (no numeric index). Throws on missing/cross-topic anchors with no partial
  // writes and no Redux changes — the copies below are then never touched.
  await restoreGroupsByStableAnchors(dispatch, getState, sourceTopicId, sourceGroupAnchors, stagedSourceRoute)

  // Restore source segment membership before removing the copies.
  // Staged cut_paste undo addresses the source route explicitly so the Main
  // owner guard sees member owner == addressed route even after a live route
  // switch; legacy actions (undefined) retain the live-route behavior.
  // Typed catalog-read failure is projection-only (source messages already
  // restored in Main): record and continue to REQUIRED target cleanup.
  // Actual Main upsert/replace failures stay fail-closed and abort.
  let pendingConvergence: unknown = null
  try {
    await restoreSegmentsAfterUndo(dispatch, getState, sourceSegmentSnapshots, stagedSourceRoute)
  } catch (error) {
    if (isSegmentCatalogConvergenceError(error)) {
      pendingConvergence = error
      logger.error(
        '[undoCutPaste] Source restored but segment catalog convergence failed; continuing to target cleanup',
        error as Error
      )
    } else {
      throw error
    }
  }

  const totalMessages = sourceGroupAnchors.reduce((sum, a) => sum + a.messages.length, 0)
  logger.info(`[undoCutPaste] Restored ${totalMessages} source messages to ${sourceTopicId}`)

  // Phase 2: remove the pasted copies from the target topic (plus the target
  // segments created at paste time). A Main-write throw here retains the
  // duplicate (restored source + remaining copies) rather than losing the
  // source. A typed catalog failure after committed cleanup is recorded and
  // rethrown so history stays advanced.
  try {
    await undoPaste(dispatch, getState, action, stagedTargetRoute)
  } catch (error) {
    if (isCommittedConvergenceError(error)) {
      pendingConvergence = pendingConvergence ?? error
    } else {
      throw error
    }
  }

  if (pendingConvergence) throw pendingConvergence
}

// ==================== Redo Implementations ====================

/**
 * Redo delete = re-delete the messages again.
 *
 * Semantically-correct roots: the original stable root IDs (Main re-expands
 * user dependents and dedupes overlapping expansions to the same set).
 * Legacy actions without roots fall back to the expanded set, which Main
 * handles as unique roots. Converges from the authority response (exact
 * expanded IDs/blocks + full segment catalog) — no loaded-projection reads.
 *
 * Branch-aware: re-deletes in the topic's active route (null = main route).
 */
async function redoDelete(dispatch: AppDispatch, getState: () => RootState, action: DeleteUndoAction): Promise<void> {
  const { targetTopicId, insertedMessageIds = [], rootMessageIds } = action
  const roots = rootMessageIds && rootMessageIds.length > 0 ? rootMessageIds : insertedMessageIds

  if (roots.length === 0) {
    return
  }

  // BRANCH-12: redo re-deletes existing messages — fail closed with zero
  // IPC calls when any root is already non-owned through the active route.
  // The Main guard stays final for expanded dependents; undo (restore)
  // paths create new owned rows and stay Main-decided.
  {
    const preState = getState()
    for (const rootId of roots) requireMutableForActiveRoute(preState, targetTopicId, rootId)
  }

  // DB-first via the unified semantic command (LOCK-001)
  let response: Awaited<ReturnType<typeof dbService.deleteMessagesWithDependents>>
  try {
    response = await dbService.deleteMessagesWithDependents(
      targetTopicId,
      roots,
      selectActiveBranchId(getState(), targetTopicId)
    )
  } catch (error) {
    logger.error('[redoDelete] Failed to delete from DB', error as Error)
    throw error
  }

  // Consume file cleanup exactly once after commit
  await consumeFileCleanupResult(response)

  // ONE shared authoritative delete acknowledgment on the already-returned
  // complete catalog (no extra list): preserves the valid loaded projection
  // like the unified delete path instead of a bare replace that blanks.
  publishDeleteAuthorityCatalog(dispatch, targetTopicId, response as any)

  // LOCK-P5.3-1: No separate updateFileReferenceCounts here.
  // consumeFileCleanupResult above already handled physical file cleanup
  // via FileManager.deleteFile which decrements Dexie files.count.

  logger.info(`[redoDelete] Re-deleted ${response.deletedMessageIds.length} messages`)
}

/**
 * Redo paste = re-insert the pasted messages with the stored stable intent.
 * No loaded numeric index is used for persistence; the stored original intent
 * (or a stable before-message/topic-tail fallback for legacy actions) drives
 * the single atomic Main command. Local projection stays bounded.
 */
async function redoPaste(dispatch: AppDispatch, getState: () => RootState, action: PasteUndoAction): Promise<void> {
  const {
    targetTopicId,
    pastedMessagesSnapshot = [],
    pastedBlocksSnapshot = [],
    fileReferenceDeltas = [],
    targetSegmentSnapshots = []
  } = action

  if (pastedMessagesSnapshot.length === 0) {
    logger.warn('[redoPaste] No pasted messages snapshot to restore')
    return
  }

  const intent = resolveRedoIntent(action)
  const entries: MessageBlockEntry[] = pastedMessagesSnapshot.map((message) => ({
    message: message as unknown as MessageBlockEntry['message'],
    blocks: pastedBlocksSnapshot.filter((b) => b.messageId === message.id) as unknown as MessageBlockEntry['blocks']
  }))

  // DB-first: one atomic stable re-insert before any Redux commit. Main
  // publishes canonical wires+capability; the shared ack installs them with
  // the stored stable placement (nonresident anchors inject nothing).
  const redoRoute = selectActiveBranchId(getState(), targetTopicId)
  let redoAck: Awaited<ReturnType<typeof dbService.insertMessageGroups>>
  try {
    redoAck = await dbService.insertMessageGroups(targetTopicId, [{ entries, intent }], redoRoute)
  } catch (error) {
    logger.error('[redoPaste] Failed to save to DB', error as Error)
    throw error
  }
  publishInsertMessageGroupsAck(dispatch, targetTopicId, redoRoute, redoAck, [redoAck.insertedMessageIds])

  // Re-increment file reference counts
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, true)
  }

  // Restore target segments that were created during original paste.
  // Typed catalog-read failure is projection-only (copies already committed):
  // rethrow so executeRedo keeps history advanced. Main upsert failures stay
  // fail-closed.
  if (targetSegmentSnapshots.length > 0) {
    try {
      await restoreTargetSegments(dispatch, targetSegmentSnapshots, undefined, getState)
    } catch (error) {
      if (isSegmentCatalogConvergenceError(error)) {
        logger.error('[redoPaste] Copies re-inserted but catalog convergence failed; authority stands', error as Error)
      }
      throw error
    }
  }

  logger.info(
    `[redoPaste] Re-inserted ${pastedMessagesSnapshot.length} pasted messages with stable intent ${intent.kind}, ${targetSegmentSnapshots.length} target segments`
  )
}

/**
 * Redo cut_paste = re-execute the cut+paste using snapshots.
 *
 * Source deletion uses the staged-cut authority helper with the stored stable
 * member roots, staged source route, and cut-time source eligibility (no
 * projection capability rerequire for complete outside-loaded source members
 * and no live-projection read). The helper owns Main segment catalog
 * convergence, authority anchor transfer, file cleanup, and
 * loaded-intersection projection. Legacy actions without staged routes retain
 * the previous guarded live-route helper. Fail-closed: missing `sourceRootIds`
 * or missing staged routes/projection for new actions throw before any DB
 * mutation.
 */
async function redoCutPaste(
  dispatch: AppDispatch,
  getState: () => RootState,
  action: CutPasteUndoAction
): Promise<void> {
  const {
    targetTopicId,
    pastedMessagesSnapshot = [],
    pastedBlocksSnapshot = [],
    sourceTopicId,
    sourceGroupAnchors,
    fileReferenceDeltas = [],
    targetSegmentSnapshots = []
  } = action
  const hasStagedRoutes = typeof action.sourceBranchId !== 'undefined' || typeof action.targetBranchId !== 'undefined'
  let stagedSourceRoute: string | null | undefined
  let stagedTargetRoute: string | null | undefined
  if (hasStagedRoutes) {
    if (typeof action.sourceBranchId === 'undefined' || typeof action.targetBranchId === 'undefined') {
      throw new Error('[redoCutPaste] Missing staged cut routes; refusing redo before any write')
    }
    stagedSourceRoute = action.sourceBranchId
    stagedTargetRoute = action.targetBranchId
  }

  let pendingConvergence: unknown = null
  // Step 1: Re-delete the source via the staged (or legacy guarded) helper.
  if (sourceGroupAnchors.length > 0) {
    const roots = Array.isArray(action.sourceRootIds)
      ? [...new Set(action.sourceRootIds.filter((id) => typeof id === 'string' && id.length > 0))]
      : []
    if (roots.length === 0) {
      logger.error('[redoCutPaste] Missing sourceRootIds for legacy action; refusing plain delete')
      throw new Error('[redoCutPaste] Missing sourceRootIds; cannot safely re-delete source')
    }

    try {
      if (hasStagedRoutes) {
        if (typeof action.sourceProjection === 'undefined' || action.sourceProjection === null) {
          throw new Error('[redoCutPaste] Missing staged cut source projection; refusing redo before any write')
        }
        await executeStagedCutSourceDelete(dispatch, getState, {
          sourceTopicId,
          sourceBranchId: stagedSourceRoute as string | null,
          rootIds: roots,
          sourceProjection: action.sourceProjection
        })
      } else {
        await executeDeleteMessagesWithDependents(dispatch, getState, sourceTopicId, roots)
      }
    } catch (error) {
      // Committed convergence (typed delete post-commit or catalog read):
      // source rows are gone in Main — continue to REQUIRED target re-insert
      // and keep history advanced. Pre-commit failures stay fail-closed.
      if (isCommittedConvergenceError(error)) {
        logger.error(
          '[redoCutPaste] Source deleted but convergence failed; continuing to target re-insert',
          error as Error
        )
        pendingConvergence = error
      } else {
        logger.error('[redoCutPaste] Failed to delete source messages (semantic redo delete)', error as Error)
        throw error
      }
    }

    // LOCK-P5.3-1: No separate updateFileReferenceCounts / segment sync here.
    // The helper already consumed file cleanup, converged the authority
    // segment catalog, transferred anchors, and removed only the loaded
    // intersection.
  }

  // Step 2: Re-insert pasted messages to target topic with the stored stable
  // intent (DB-first, one atomic command, no numeric index).
  if (pastedMessagesSnapshot.length > 0) {
    const intent = resolveRedoIntent(action)
    const entries: MessageBlockEntry[] = pastedMessagesSnapshot.map((message) => ({
      message: message as unknown as MessageBlockEntry['message'],
      blocks: pastedBlocksSnapshot.filter((b) => b.messageId === message.id) as unknown as MessageBlockEntry['blocks']
    }))
    const targetRoute =
      typeof stagedTargetRoute === 'undefined' ? selectActiveBranchId(getState(), targetTopicId) : stagedTargetRoute

    let reinsertAck: Awaited<ReturnType<typeof dbService.insertMessageGroups>>
    try {
      reinsertAck = await dbService.insertMessageGroups(targetTopicId, [{ entries, intent }], targetRoute)
    } catch (error) {
      logger.error('[redoCutPaste] Failed to save pasted messages to DB', error as Error)
      throw error
    }
    publishInsertMessageGroupsAck(dispatch, targetTopicId, targetRoute, reinsertAck, [reinsertAck.insertedMessageIds])

    // Re-increment file reference counts for pasted blocks
    if (fileReferenceDeltas.length > 0) {
      await updateFileReferenceCounts(fileReferenceDeltas, true)
    }
  }

  // Step 3: Restore target segments that were created during original paste.
  // Staged cut_paste redo addresses the target route explicitly (legacy
  // undefined retains the live-route behavior). Typed catalog failure is
  // projection-only (all Main writes committed): record and rethrow so
  // history stays advanced.
  if (targetSegmentSnapshots.length > 0) {
    try {
      await restoreTargetSegments(dispatch, targetSegmentSnapshots, stagedTargetRoute, getState)
    } catch (error) {
      if (isSegmentCatalogConvergenceError(error)) {
        pendingConvergence = pendingConvergence ?? error
        logger.error(
          '[redoCutPaste] Target re-insert committed but catalog convergence failed; authority stands',
          error as Error
        )
      } else {
        throw error
      }
    }
  }

  if (pendingConvergence) throw pendingConvergence

  const sourceCount = sourceGroupAnchors.reduce((sum, a) => sum + a.messages.length, 0)
  logger.info(
    `[redoCutPaste] Re-executed cut+paste: ${sourceCount} source messages deleted, ${pastedMessagesSnapshot.length} messages re-inserted, ${targetSegmentSnapshots.length} target segments restored`
  )
}
