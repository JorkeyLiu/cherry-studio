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
  fetchTopicBranchesThunk,
  loadRouteMessagesThunk,
  publishDeleteAuthorityCatalog
} from '@renderer/store/thunk/messageThunk'
import {
  deleteSegmentsBySnapshots,
  restoreSegmentsAfterUndo,
  restoreTargetSegments,
  syncSegmentsAfterMessageDeletion
} from '@renderer/store/thunk/topicSegmentThunk'
import {
  activeBranchReset,
  activeBranchSet,
  selectActiveBranchId,
  selectTopicBranches
} from '@renderer/store/topicBranch'
import { beginHistoryReplay, commitRedoAction, commitUndoAction, endHistoryReplay } from '@renderer/store/undoStack'
import type {
  BranchUndoAction,
  CutPasteUndoAction,
  DeleteUndoAction,
  GroupAnchor,
  PasteUndoAction,
  UndoAction
} from '@renderer/types/editMode'
import { MessageBlockType } from '@renderer/types/newMessage'
import { isSegmentCatalogConvergenceError } from '@renderer/utils/topicSegmentCatalog'
import type {
  BranchOperationSnapshot,
  InheritanceBoundarySnapshot,
  InsertMessageGroup,
  InsertMessageGroupIntent,
  MessageBlockEntry
} from '@shared/chatDb'

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
 * Re-read the Main branch catalog after an undo/redo authority command that
 * can move an inheritance boundary or drop the fork rows of `topicId`.
 *
 * The catalog is a projection of a Main write that already committed, so a
 * failed re-read is projection-only: it must never turn a committed undo/redo
 * into a failed one. Only the topic the command actually addressed is re-read.
 */
async function refreshBranchCatalogAfterAuthorityWrite(
  dispatch: AppDispatch,
  topicId: string,
  reason: string
): Promise<void> {
  try {
    await dispatch(fetchTopicBranchesThunk(topicId))
  } catch (error) {
    logger.warn(`[${reason}] Authority committed but branch catalog refresh failed`, error as Error)
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
  addressedRoute?: string | null,
  boundaryRestores?: InheritanceBoundarySnapshot[]
): Promise<void> {
  if (groupAnchors.length === 0) return
  const groups = buildRestoreGroups(groupAnchors)
  const route = typeof addressedRoute === 'undefined' ? selectActiveBranchId(getState(), topicId) : addressedRoute

  // DB-first: one atomic multi-group restore with FULL entries. Missing/
  // cross-topic anchors fail the whole transaction with no partial writes and
  // no Redux changes. Main publishes canonical wires+capability on success,
  // and reverts the recorded inheritance boundaries in that same transaction
  // (compare-and-set; a relation removed or moved since keeps its newer state).
  let ack: Awaited<ReturnType<typeof dbService.insertMessageGroups>>
  try {
    // Boundary restores ride only when this delete actually moved one, so an
    // ordinary restore keeps its exact three-argument Main command.
    ack =
      boundaryRestores && boundaryRestores.length > 0
        ? await dbService.insertMessageGroups(topicId, groups, route, boundaryRestores)
        : await dbService.insertMessageGroups(topicId, groups, route)
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
 * Outcome of one undo/redo attempt.
 *
 * `empty` means the addressed stack had nothing to replay: a no-op that is
 * neither a success toast nor a failure. `success` means Main authority
 * advanced and the history cursor moved. `failed` means the action is still on
 * its stack, ready to retry, and the caller must report an explicit error.
 */
export type UndoOutcome =
  | { status: 'empty' }
  | { status: 'success'; action: UndoAction }
  | { status: 'failed'; action: UndoAction; error: unknown }

/**
 * Serialize history replay across every caller (shortcut, toolbar, menu).
 *
 * Two attempts must never read the same stack cursor and replay the same
 * authority command twice, so all entrypoints funnel through this one chain. A
 * failing task never poisons the chain for the next caller.
 */
let historyReplayQueue: Promise<unknown> = Promise.resolve()

function enqueueHistoryReplay<T>(task: () => Promise<T>): Promise<T> {
  const run = historyReplayQueue.then(task, task)
  historyReplayQueue = run.catch(() => undefined)
  return run
}

/** The Main replay payload for one recorded branch action. */
function branchOperationSnapshot(action: BranchUndoAction): BranchOperationSnapshot {
  switch (action.type) {
    case 'branch_create':
      return { kind: 'create', branch: action.branch }
    case 'branch_rename':
      return { kind: 'rename', branchId: action.branchId, beforeName: action.beforeName, afterName: action.afterName }
    case 'branch_move':
      return action.snapshot
    case 'branch_delete':
      return action.snapshot
  }
}

/**
 * Re-read the addressed topic's branch catalog, fall back to the nearest
 * surviving ancestor when the replay removed the active route, and reload that
 * route's window.
 *
 * Everything here is projection of a Main write that already committed: no
 * step may turn a committed authority change into a failed history entry.
 */
async function convergeAfterBranchReplay(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  reason: string
): Promise<void> {
  const before = getState()
  const activeBefore = selectActiveBranchId(before, topicId)
  const beforeById = new Map(selectTopicBranches(before, topicId).map((branch) => [branch.id, branch]))
  await refreshBranchCatalogAfterAuthorityWrite(dispatch, topicId, reason)
  let route = activeBefore
  const surviving = new Set(selectTopicBranches(getState(), topicId).map((branch) => branch.id))
  if (activeBefore !== null && !surviving.has(activeBefore)) {
    // Walk up from the vanished active route to the nearest survivor (parent
    // first, else main — main always holds every anchor).
    let candidate = beforeById.get(activeBefore)?.parentBranchId ?? null
    while (candidate !== null && !surviving.has(candidate)) {
      candidate = beforeById.get(candidate)?.parentBranchId ?? null
    }
    route = candidate
    if (candidate === null) {
      dispatch(activeBranchReset({ topicId }))
    } else {
      dispatch(activeBranchSet({ topicId, branchId: candidate }))
    }
  }
  try {
    dispatch(newMessagesActions.invalidateRouteMutability({ topicId }))
  } catch {
    // best-effort invalidation; the route load below republishes capability
  }
  try {
    await dispatch(loadRouteMessagesThunk(topicId, route, { kind: 'latest' }))
  } catch (error) {
    logger.warn(`[${reason}] Branch authority committed but route reload failed`, error as Error)
  }
}

/**
 * Replay one recorded branch operation through Main authority, then converge
 * the renderer projection of the topic the operation belongs to.
 *
 * Main validates the snapshot against current state inside one transaction and
 * rejects with zero writes when reality moved on, so this never overwrites an
 * unrelated concurrent edit and never leaves a partial operation behind.
 */
async function replayBranchOperation(
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  direction: 'undo' | 'redo',
  snapshot: BranchOperationSnapshot,
  reason: string
): Promise<void> {
  await dbService.replayBranchOperation(topicId, direction, snapshot)
  await convergeAfterBranchReplay(dispatch, getState, topicId, reason)
}

async function applyUndoAction(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  switch (action.type) {
    case 'delete':
      await undoDelete(dispatch, getState, action)
      return
    case 'paste':
      await undoPaste(dispatch, getState, action)
      return
    case 'cut_paste':
      await undoCutPaste(dispatch, getState, action)
      return
    case 'branch_create':
    case 'branch_rename':
    case 'branch_move':
    case 'branch_delete':
      await replayBranchOperation(
        dispatch,
        getState,
        action.targetTopicId,
        'undo',
        branchOperationSnapshot(action),
        `undo:${action.type}`
      )
      return
    default: {
      const _exhaustive: never = action
      throw new Error(`[executeUndo] Unknown action type: ${(_exhaustive as any).type}`)
    }
  }
}

async function applyRedoAction(dispatch: AppDispatch, getState: () => RootState, action: UndoAction): Promise<void> {
  switch (action.type) {
    case 'delete':
      await redoDelete(dispatch, getState, action)
      return
    case 'paste':
      await redoPaste(dispatch, getState, action)
      return
    case 'cut_paste':
      await redoCutPaste(dispatch, getState, action)
      return
    case 'branch_create':
    case 'branch_rename':
    case 'branch_move':
    case 'branch_delete':
      await replayBranchOperation(
        dispatch,
        getState,
        action.targetTopicId,
        'redo',
        branchOperationSnapshot(action),
        `redo:${action.type}`
      )
      return
    default: {
      const _exhaustive: never = action
      throw new Error(`[executeRedo] Unknown action type: ${(_exhaustive as any).type}`)
    }
  }
}

/**
 * Execute the newest undo action.
 *
 * The cursor advances only after the authority mutation succeeded (or Main
 * committed and only projection convergence failed); a rejected operation keeps
 * its action on the stack so the user can retry, and reports `failed` instead of
 * silently doing nothing.
 */
async function runUndo(dispatch: AppDispatch, getState: () => RootState): Promise<UndoOutcome> {
  // Holding the history gate for the whole round-trip keeps a concurrent
  // operation's push from interleaving with this replay's cursor commit.
  beginHistoryReplay()
  try {
    const action = getState().undoStack.undoStack.at(-1)
    if (!action) {
      logger.info('[undo] Stack is empty')
      return { status: 'empty' }
    }
    try {
      await applyUndoAction(dispatch, getState, action)
    } catch (error) {
      if (isCommittedConvergenceError(error)) {
        // Main authority stands; history must advance so the already-committed
        // operation is never retried into a conflict.
        logger.error(
          '[undo] Authority committed but convergence failed; history advanced, projection invalidated',
          error as Error
        )
        dispatch(commitUndoAction(action.id))
        return { status: 'success', action }
      }
      logger.error('[undo] Failed; action retained for retry', error as Error)
      return { status: 'failed', action, error }
    }
    dispatch(commitUndoAction(action.id))
    return { status: 'success', action }
  } finally {
    endHistoryReplay(dispatch)
  }
}

/** Execute the newest redo action (same contract as `runUndo`). */
async function runRedo(dispatch: AppDispatch, getState: () => RootState): Promise<UndoOutcome> {
  beginHistoryReplay()
  try {
    const action = getState().undoStack.redoStack.at(-1)
    if (!action) {
      logger.info('[redo] Stack is empty')
      return { status: 'empty' }
    }
    try {
      await applyRedoAction(dispatch, getState, action)
    } catch (error) {
      if (isCommittedConvergenceError(error)) {
        logger.error(
          '[redo] Authority committed but convergence failed; history advanced, projection invalidated',
          error as Error
        )
        dispatch(commitRedoAction(action.id))
        return { status: 'success', action }
      }
      logger.error('[redo] Failed; action retained for retry', error as Error)
      return { status: 'failed', action, error }
    }
    dispatch(commitRedoAction(action.id))
    return { status: 'success', action }
  } finally {
    endHistoryReplay(dispatch)
  }
}

/** Undo the newest history action (serialized across all callers). */
export function executeUndo(dispatch: AppDispatch, getState: () => RootState): Promise<UndoOutcome> {
  return enqueueHistoryReplay(() => runUndo(dispatch, getState))
}

/** Redo the newest undone action (serialized across all callers). */
export function executeRedo(dispatch: AppDispatch, getState: () => RootState): Promise<UndoOutcome> {
  return enqueueHistoryReplay(() => runRedo(dispatch, getState))
}

// ==================== Undo Implementations ====================

/**
 * Undo delete = re-insert deleted messages and blocks
 */
async function undoDelete(dispatch: AppDispatch, getState: () => RootState, action: DeleteUndoAction): Promise<void> {
  const {
    targetTopicId,
    groupAnchors,
    fileReferenceDeltas = [],
    segmentSnapshots = [],
    boundarySnapshots = []
  } = action

  if (groupAnchors.length === 0) {
    logger.warn('[undoDelete] No group anchors to restore')
    return
  }

  // Restore file references
  if (fileReferenceDeltas.length > 0) {
    await updateFileReferenceCounts(fileReferenceDeltas, false)
  }

  // Restore groups with one atomic stable command (no numeric index). The
  // recorded boundary snapshots travel with it: messages and the branch
  // anchors / reference endpoints this delete moved are reverted in ONE Main
  // transaction, never by a separate renderer write. The route the delete
  // actually addressed is recorded on the action and drives the restore, so a
  // branch switch between delete and undo can never retarget the rows to
  // another owner; legacy actions without the fact fall back to the live route.
  await restoreGroupsByStableAnchors(
    dispatch,
    getState,
    targetTopicId,
    groupAnchors,
    action.deletedBranchId,
    boundarySnapshots
  )

  // Restore segment membership
  await restoreSegmentsAfterUndo(dispatch, getState, segmentSnapshots)

  // The restore replaced the authoritative messages in Main, and the branch
  // catalog is a projection of Main state (both the fork rows and the
  // inherited boundary Main re-derives from effective routes). Re-read the
  // addressed topic so the projection converges even when the delete recorded
  // no moved boundary: a missing former predecessor keeps the boundary id
  // without publishing a snapshot, yet Main still re-derives the head from the
  // restored message. Refresh is projection-only and never a second write.
  await refreshBranchCatalogAfterAuthorityWrite(dispatch, targetTopicId, 'undoDelete')

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

  // Route provenance: the caller's explicit staged route (cut_paste) wins; a
  // plain paste addresses the route it recorded at paste time; only a legacy
  // action without any recorded route falls back to the live active route.
  const recordedTargetBranchId = typeof action.targetBranchId === 'undefined' ? undefined : action.targetBranchId
  const pinnedRoute = typeof addressedTargetRoute === 'undefined' ? recordedTargetBranchId : addressedTargetRoute
  const targetRoute = typeof pinnedRoute === 'undefined' ? selectActiveBranchId(getState(), targetTopicId) : pinnedRoute
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

  // Removing the copies was a Main delete in this topic, and a Main delete
  // maintains inheritance boundaries / reference endpoints inside its own
  // transaction (this command reports none of them back). The branch catalog
  // is a Main projection, so re-read THIS topic instead of keeping pre-delete
  // anchors — the same post-commit convergence an ordinary delete performs.
  await refreshBranchCatalogAfterAuthorityWrite(dispatch, targetTopicId, 'undoPaste')

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
  // A pinned route (staged cut target, or the route the paste recorded) is
  // passed explicitly so a live route switch mid-cleanup cannot retarget the
  // membership write; a legacy action without any recorded route keeps the
  // previous live-route behavior.
  try {
    if (typeof pinnedRoute === 'undefined') {
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
  const { sourceTopicId, sourceGroupAnchors, sourceSegmentSnapshots = [], sourceBoundarySnapshots = [] } = action
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
  // The recorded source boundary snapshots ride the same transaction, so the
  // source topic's moved branch anchors / reference endpoints come back with
  // the source messages.
  await restoreGroupsByStableAnchors(
    dispatch,
    getState,
    sourceTopicId,
    sourceGroupAnchors,
    stagedSourceRoute,
    sourceBoundarySnapshots
  )

  // The source messages were restored in Main, so the source topic's catalog
  // is stale regardless of whether this cut recorded a moved boundary: Main
  // re-derives the inherited head from the restored message even when no
  // surviving predecessor lets it publish a boundary snapshot. Re-read the
  // source catalog (projection-only, never a second write).
  await refreshBranchCatalogAfterAuthorityWrite(dispatch, sourceTopicId, 'undoCutPaste')

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
  // IPC calls when any root is already non-owned through the ACTIVE route.
  // The Main guard stays final for expanded dependents; undo (restore)
  // paths create new owned rows and stay Main-decided.
  //
  // Recorded-route redo: a delete that recorded the route it addressed
  // re-deletes through that same route, so undo→redo→undo round-trips after a
  // branch switch instead of hitting the live-route owner guard. The live
  // precheck stays for the equal-route case and for legacy actions (no
  // recorded fact), which keep the previous live-route behavior exactly.
  const liveRoute = selectActiveBranchId(getState(), targetTopicId)
  const recordedRoute = typeof action.deletedBranchId === 'undefined' ? undefined : action.deletedBranchId
  const redoRoute = typeof recordedRoute === 'undefined' ? liveRoute : recordedRoute
  if (typeof recordedRoute === 'undefined' || recordedRoute === liveRoute) {
    const preState = getState()
    for (const rootId of roots) requireMutableForActiveRoute(preState, targetTopicId, rootId)
  }

  // DB-first via the unified semantic command (LOCK-001)
  let response: Awaited<ReturnType<typeof dbService.deleteMessagesWithDependents>>
  try {
    response = await dbService.deleteMessagesWithDependents(targetTopicId, roots, redoRoute)
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

  // Main maintained the inheritance boundaries / reference endpoints inside
  // that delete transaction (the unified delete command reports no boundary
  // payload), and the branch catalog is a Main projection: re-read the topic
  // this redo deleted from, exactly like the ordinary delete path, instead of
  // keeping anchors that point at the removed messages. A failed re-read is
  // projection-only and never turns a committed re-delete into a failure.
  await refreshBranchCatalogAfterAuthorityWrite(dispatch, targetTopicId, 'redoDelete')

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
  // Route provenance: redo writes back into the route the paste recorded, so a
  // branch switch between paste and redo never retargets the copies; a legacy
  // action without the fact keeps the live-route behavior.
  const recordedTargetRoute = typeof action.targetBranchId === 'undefined' ? undefined : action.targetBranchId
  const redoRoute =
    typeof recordedTargetRoute === 'undefined' ? selectActiveBranchId(getState(), targetTopicId) : recordedTargetRoute
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
      await restoreTargetSegments(dispatch, targetSegmentSnapshots, recordedTargetRoute, getState)
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
