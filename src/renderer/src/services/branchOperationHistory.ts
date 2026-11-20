import { dbService } from '@renderer/services/db/DbService'
import type { AppDispatch } from '@renderer/store'
import { recordUndoAction } from '@renderer/store/undoStack'
import type { BranchDeleteSnapshot, BranchHistoryRow, BranchMoveSnapshot, TopicBranchWire } from '@shared/chatDb'

/**
 * Renderer history recording for branch lifecycle operations.
 *
 * Branch create/rename/move/delete are Main authority writes; this module only
 * turns the snapshot Main returned with the committed operation into one
 * in-memory undo action. The snapshot is Main's own authority payload, replayed
 * back through the same Main entrypoint on undo/redo — the renderer never
 * reconstructs branch rows, owned messages, or topology itself.
 */

/**
 * Project a committed branch wire onto the replay row shape.
 *
 * `overflow` carries branch columns this build does not know about; a wire
 * never exposes them, and Main writes new branch rows with an empty extra map,
 * so the replayed row carries `{}` rather than guessing.
 */
export function branchRowFromWire(branch: TopicBranchWire): BranchHistoryRow {
  return {
    id: branch.id,
    parentBranchId: branch.parentBranchId,
    anchorMessageId: branch.anchorMessageId,
    name: branch.name,
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
    overflow: {}
  }
}

function nextBranchActionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Record one committed branch creation (undo removes the empty leaf). */
export function pushBranchCreateAction(dispatch: AppDispatch, topicId: string, branch: TopicBranchWire): void {
  recordUndoAction(dispatch, {
    id: nextBranchActionId('branch-create'),
    type: 'branch_create',
    timestamp: Date.now(),
    targetTopicId: topicId,
    branch: branchRowFromWire(branch)
  })
}

/** Record one committed branch rename with the names it moved between. */
export function pushBranchRenameAction(
  dispatch: AppDispatch,
  topicId: string,
  branchId: string,
  beforeName: string | null,
  afterName: string | null
): void {
  recordUndoAction(dispatch, {
    id: nextBranchActionId('branch-rename'),
    type: 'branch_rename',
    timestamp: Date.now(),
    targetTopicId: topicId,
    branchId,
    beforeName,
    afterName
  })
}

/** Record one committed move of whole turns into a new child branch. */
export function pushBranchMoveAction(dispatch: AppDispatch, topicId: string, snapshot: BranchMoveSnapshot): void {
  recordUndoAction(dispatch, {
    id: nextBranchActionId('branch-move'),
    type: 'branch_move',
    timestamp: Date.now(),
    targetTopicId: topicId,
    snapshot
  })
}

/** Record one committed subtree delete with its full authority snapshot. */
export function pushBranchDeleteAction(dispatch: AppDispatch, topicId: string, snapshot: BranchDeleteSnapshot): void {
  recordUndoAction(dispatch, {
    id: nextBranchActionId('branch-delete'),
    type: 'branch_delete',
    timestamp: Date.now(),
    targetTopicId: topicId,
    rootBranchId: snapshot.rootBranchId,
    snapshot
  })
}

/**
 * Rename one branch and record it in history.
 *
 * The rename command reports no before-state, so the caller passes the name the
 * surface was showing when the user started editing — the exact value the
 * rename moves away from. A no-op rename records nothing.
 */
export async function renameBranchWithHistory(
  dispatch: AppDispatch,
  topicId: string,
  branchId: string,
  beforeName: string | null,
  name: string
): Promise<void> {
  await dbService.renameBranch(topicId, branchId, name)
  if ((beforeName ?? null) === name) return
  pushBranchRenameAction(dispatch, topicId, branchId, beforeName ?? null, name)
}
