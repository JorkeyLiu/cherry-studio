import { loggerService } from '@logger'
import { renameBranchWithHistory } from '@renderer/services/branchOperationHistory'
import { copyBranchTree } from '@renderer/services/ClipboardService'
import { deleteBranchSubtree } from '@renderer/services/db/branchSubtree'
import { useAppDispatch } from '@renderer/store'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { requestTopicBranches } from '../useBranchTree'

const logger = loggerService.withContext('branchRowActions')

export interface BranchRowActionsOptions {
  topicId: string
  /** Selected route, for the subtree-delete route fallback. Never switched here. */
  activeBranchId: string | null
  /**
   * Stored name of a row, for the rename history entry. Entries resolve it from
   * the wires they own (the top selector from its catalog, a fork divider from
   * its scope plus its own parent label); null records no before-state.
   */
  resolveBeforeName: (branchId: string) => string | null
}

export interface BranchRowActions {
  /** Row whose subtree delete is in flight, so only that row shows a spinner. */
  deletingBranchId: string | null
  /** Row whose branch-tree copy is in flight, so only that row shows a spinner. */
  copyingBranchId: string | null
  /**
   * Inline rename commit, DB-first: the row keeps its place while the write is
   * in flight and the refreshed catalog then carries the stored name. Records
   * one history action (undo/redo swap the two names).
   */
  commitRename: (branchId: string, next: string) => Promise<void>
  /**
   * Popconfirm delete commit: the subtree delete owns the route fallback, so
   * callers never switch route around it. Resolves true after the catalog
   * refresh, false when the write failed (already toasted); entries own their
   * own open-state reaction (stay open vs. dismiss).
   */
  confirmDelete: (branchId: string) => Promise<boolean>
  /**
   * Branch-row copy, copy-only: the CLICKED row is the source (never the active
   * route). One copy runs at a time; the row owns the spinner while in flight.
   * Nothing here switches route or opens edit mode.
   */
  copyBranch: (branchId: string) => Promise<void>
}

/**
 * Shared row-action handling for both branch-route selectors (the top tree and
 * the fork-divider tree). The selectors share the same panel, the same row
 * controls and the same DB-first commit/refresh/toast semantics; only the
 * trigger, the displayed scope and the open-state reaction differ per entry.
 * Branch identity and parent relations passed to the services are always the
 * real catalog ids — scope filtering only changes which rows are displayed.
 */
export function useBranchRowActions({
  topicId,
  activeBranchId,
  resolveBeforeName
}: BranchRowActionsOptions): BranchRowActions {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const [deletingBranchId, setDeletingBranchId] = useState<string | null>(null)
  const [copyingBranchId, setCopyingBranchId] = useState<string | null>(null)

  const commitRename = useCallback(
    async (branchId: string, next: string): Promise<void> => {
      try {
        await renameBranchWithHistory(dispatch, topicId, branchId, resolveBeforeName(branchId), next)
        requestTopicBranches(dispatch, topicId)
      } catch (error) {
        logger.error('[branchRowActions] Failed to rename branch:', error as Error)
        window.toast.error(t('common.error'))
      }
    },
    [dispatch, resolveBeforeName, t, topicId]
  )

  const confirmDelete = useCallback(
    async (branchId: string): Promise<boolean> => {
      setDeletingBranchId(branchId)
      try {
        // The subtree delete owns the route fallback; never switch here.
        await deleteBranchSubtree(topicId, branchId, activeBranchId)
        requestTopicBranches(dispatch, topicId)
        window.toast.success(t('chat.topics.branch.deleted'))
        return true
      } catch (error) {
        logger.error('[branchRowActions] Failed to delete branch:', error as Error)
        window.toast.error(t('common.error'))
        return false
      } finally {
        setDeletingBranchId(null)
      }
    },
    [activeBranchId, dispatch, t, topicId]
  )

  const copyBranch = useCallback(
    async (branchId: string): Promise<void> => {
      if (copyingBranchId !== null) return
      setCopyingBranchId(branchId)
      try {
        const count = await copyBranchTree(dispatch, topicId, branchId)
        if (count > 0) {
          window.toast.success(t('chat.edit.copied', { count }))
        } else {
          // Nothing was published (Main refused or the branch owns no rows).
          window.toast.error(t('common.error'))
        }
      } catch (error) {
        logger.error('[branchRowActions] Failed to copy branch tree:', error as Error)
        window.toast.error(t('common.error'))
      } finally {
        setCopyingBranchId(null)
      }
    },
    [copyingBranchId, dispatch, t, topicId]
  )

  return { deletingBranchId, copyingBranchId, commitRename, confirmDelete, copyBranch }
}
