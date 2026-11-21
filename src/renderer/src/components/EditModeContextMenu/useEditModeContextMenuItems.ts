import { loggerService } from '@logger'
import { useEditMode } from '@renderer/context/EditModeContext'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import type { TopicBranchWire } from '@renderer/services/db/types'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { clearSelection, setSelectedGroupIds } from '@renderer/store/editMode'
import { setTurnFoldsThunk } from '@renderer/store/thunk/turnFold'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { MenuProps } from 'antd'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

const menuLogger = loggerService.withContext('EditModeMoveToBranch')

/** Stable empty catalog: an unbranched/unknown topic never churns derived memos. */
const EMPTY_BRANCHES: readonly TopicBranchWire[] = []

/**
 * Horizontal offset (px) of the copy/cut/delete submenu popups.
 *
 * A submenu popup (`rightTop`: popup top-left ↔ title top-right) naturally
 * lands its outer edge on the title's right edge — about 5px inside the parent
 * panel's outer edge (4px dropdown-menu padding + hairline panel borders;
 * measured: parent panel 502..672, natural submenu 667..880). That natural
 * spot only overlaps the parent's padding, never a row, but it reads as a
 * notch. The offset moves the popup exactly past the parent's outer edge so
 * the two outer borders sit flush (0px): no overlap, no visible seam, and the
 * pointer travels straight from the parent item into the child panel without
 * crossing a dead zone. There is deliberately no extra gap — a 4px gap was
 * the visible seam in the user report. The align engine negates the x offset
 * when it flips to the other side near the viewport edge (@rc-component/trigger
 * `useAlign` right-to-left branch), so both directions stay flush with the same
 * constant and no absolute coordinates are involved.
 */
const SUBMENU_EDGE_OFFSET_PX = 5
const SUBMENU_OFFSET: [number, number] = [SUBMENU_EDGE_OFFSET_PX, 0]

/**
 * "Including child branches" relevance for the current edit selection.
 *
 * True when at least one selected turn carries, among its complete member ids,
 * the anchor message of a DIRECT child branch of the addressed route
 * (`parentBranchId === activeBranchId`). The complete branch catalog is the only
 * input, and it is a UI visibility hint: Main still decides the actual capture.
 * Every unknown fails closed to `false`:
 *
 * - the catalog of this topic was never received (loading/unknown);
 * - the catalog is incomplete/stale (a branch names a parent it does not hold);
 * - the resident projection belongs to another route (route mismatch);
 * - a selected turn cannot be resolved to its member ids.
 *
 * Child branches of ANCESTOR levels never qualify: their anchor is not a direct
 * child of the addressed route, so their subtree is out of the capture's scope.
 */
export function hasSelectedChildBranchAnchor(params: {
  branches: readonly TopicBranchWire[]
  activeBranchId: string | null
  catalogKnown: boolean
  /** The resident projection/capability was published for the addressed route. */
  projectionRouteAligned: boolean
  selectedGroupIds: readonly string[]
  selectedGroups: readonly { messages: readonly { id: string }[] }[]
}): boolean {
  if (!params.catalogKnown || !params.projectionRouteAligned) return false
  if (params.selectedGroupIds.length === 0) return false
  // A partially resolved selection cannot prove its member ids → fail closed.
  if (params.selectedGroups.length !== params.selectedGroupIds.length) return false

  const knownBranchIds = new Set(params.branches.map((branch) => branch.id))
  const anchorMessageIds = new Set<string>()
  for (const branch of params.branches) {
    const parentBranchId = branch.parentBranchId ?? null
    if (parentBranchId !== null && !knownBranchIds.has(parentBranchId)) return false
    if (parentBranchId === (params.activeBranchId ?? null)) anchorMessageIds.add(branch.anchorMessageId)
  }
  if (anchorMessageIds.size === 0) return false

  for (const group of params.selectedGroups) {
    if (group.messages.length === 0) return false
    for (const message of group.messages) {
      if (anchorMessageIds.has(message.id)) return true
    }
  }
  return false
}

/**
 * Edit-mode context menu items for the message list. Extracted from
 * EditModeContextMenu so the same behavior can be offered by the stable
 * MessageContextMenu host without switching wrapper component types.
 */
export function useEditModeContextMenuItems(topicId: string) {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const {
    isEnabled,
    selectedGroupIds,
    // Resolved selection (loaded projection + cross-window range view). Reused
    // instead of re-resolving group members locally.
    selectedGroups,
    handleCopy,
    handleCut,
    handleCopyWithChildren,
    handleCutWithChildren,
    handlePaste,
    handleDelete,
    handleDeleteWithChildren,
    handleUndo,
    handleRedo,
    hasClipboard,
    canUndo,
    canRedo,
    groups,
    // BRANCH-12: 选集不可变时 cut/delete/segment 写操作禁用；copy 允许.
    isSelectionMutable
  } = useEditMode()

  const { createSegment, getSegmentsForTopic, updateSegmentMessageIds, deleteSegment } = useTopicSegments(topicId)

  const allMessageIds = useAppSelector((state) => state.messages.messageIdsByTopic[topicId] || [])
  const activeRoute = useAppSelector((state) => selectActiveBranchId(state, topicId))
  const mutableIds = useAppSelector((state) => state.messages.mutableMessageIdsByTopic?.[topicId])
  const mutableRoute = useAppSelector((state) => state.messages.mutableRouteByTopic?.[topicId] ?? null)
  const catalogKnown = useAppSelector((state) =>
    Object.prototype.hasOwnProperty.call(state.topicBranch?.branchesByTopic ?? {}, topicId)
  )
  // Complete branch catalog of this logical topic. The stored array keeps its
  // identity, so an unbranched/unknown topic stays on EMPTY_BRANCHES.
  const branches = useAppSelector((state) => state.topicBranch?.branchesByTopic?.[topicId] ?? EMPTY_BRANCHES)

  const getSelectedMessageIds = useCallback((): string[] => {
    if (selectedGroupIds.length === 0) return []

    const messageIds: string[] = []
    for (const askId of selectedGroupIds) {
      const group = groups.find((g) => g.askId === askId)
      if (group) {
        for (const msg of group.messages) {
          messageIds.push(msg.id)
        }
      }
    }

    // 按 topic 中的时间顺序排序（Ctrl 点选时顺序可能乱序）
    return [...messageIds].sort((a, b) => allMessageIds.indexOf(a) - allMessageIds.indexOf(b))
  }, [selectedGroupIds, groups, allMessageIds])

  const checkMessagesContinuous = useCallback(
    (msgIds: string[]): boolean => {
      if (msgIds.length <= 1) return true

      const indices = msgIds.map((id) => allMessageIds.indexOf(id))

      // Check for invalid message IDs (not found in topic messages)
      const validIndices = indices.filter((i) => i !== -1)
      if (validIndices.length !== msgIds.length) {
        return false
      }

      validIndices.sort((a, b) => a - b)

      for (let i = 1; i < validIndices.length; i++) {
        if (validIndices[i] - validIndices[i - 1] !== 1) return false
      }
      return true
    },
    [allMessageIds]
  )

  const handleCreateSegment = useCallback(async () => {
    // BRANCH-12: 选集不可变时 segment 创建零调用（Main 最终校验为界）。
    if (!isSelectionMutable) return
    const msgIds = getSelectedMessageIds()
    if (msgIds.length === 0) {
      window.toast.warning(t('topicSegment.create.selectMessages'))
      return
    }

    if (!checkMessagesContinuous(msgIds)) {
      window.toast.warning(t('topicSegment.create.notContinuous'))
      return
    }

    const existingSegments = getSegmentsForTopic(topicId)
    const conflictingIds = msgIds.filter((id) => existingSegments.some((seg) => seg.messageIds.includes(id)))
    if (conflictingIds.length > 0) {
      window.toast?.warning?.(t('topicSegment.create.overlappingMessages'))
      return
    }

    await createSegment(topicId, t('topicSegment.create.defaultName'), msgIds)
    dispatch(clearSelection())
    window.toast.success(t('topicSegment.createAction'))
  }, [
    isSelectionMutable,
    getSelectedMessageIds,
    checkMessagesContinuous,
    getSegmentsForTopic,
    topicId,
    t,
    createSegment,
    dispatch
  ])

  const areAllSelectedFolded = useMemo(() => {
    if (selectedGroupIds.length === 0) return false
    let sawMemberRow = false
    for (const askId of selectedGroupIds) {
      const group = groups.find((g) => g.askId === askId)
      // A selected turn with no loaded member row cannot be proven folded, so
      // the action folds (never claims a state it cannot see).
      if (!group || group.messages.length === 0) return false
      for (const message of group.messages) {
        sawMemberRow = true
        if (message.folded !== true) return false
      }
    }
    return sawMemberRow
  }, [selectedGroupIds, groups])

  /**
   * Fold/unfold the selected turns.
   *
   * ONE atomic turn-level command carrying only stable turn (group) ids: Main
   * resolves every selected turn's complete membership (window-outside members
   * included) and writes the fold flags in one transaction, so a selection
   * whose turns are only partly loaded is never addressed by the rows the
   * renderer happens to have. A rejected write throws — the selection is then
   * KEPT and the error names the operation the user asked for (folding never
   * reports a failure to unfold).
   */
  const handleToggleFoldSelected = useCallback(async () => {
    if (!isSelectionMutable) return
    if (selectedGroupIds.length === 0) return
    const targetFolded = !areAllSelectedFolded
    try {
      await dispatch(setTurnFoldsThunk(topicId, selectedGroupIds, targetFolded, activeRoute))
    } catch (error) {
      menuLogger.error('[handleToggleFoldSelected] Failed to write the turn fold state', error as Error)
      window.toast?.error?.(targetFolded ? t('chat.fold_failed') : t('chat.unfold_failed'))
      return
    }
    dispatch(clearSelection())
    window.toast?.success?.(targetFolded ? t('chat.folded_success') : t('chat.unfolded_success'))
  }, [isSelectionMutable, selectedGroupIds, areAllSelectedFolded, topicId, activeRoute, dispatch, t])

  const getMergeDirections = useCallback(
    (msgIds: string[]): { upSegment?: TopicSegment; downSegment?: TopicSegment } | null => {
      if (msgIds.length === 0 || allMessageIds.length === 0) return null

      const selStart = allMessageIds.indexOf(msgIds[0])
      const selEnd = allMessageIds.indexOf(msgIds[msgIds.length - 1])
      if (selStart === -1 || selEnd === -1) return null

      const segments = getSegmentsForTopic(topicId)
      let upSegment: TopicSegment | undefined
      let downSegment: TopicSegment | undefined

      for (const seg of segments) {
        // Authority endpoints drive adjacency; loaded indexes only decide
        // whether the adjacency is currently actionable (resident).
        const firstId = seg.firstMessageId
        const lastId = seg.lastMessageId
        if (firstId === null || lastId === null) continue
        const segFirstIdx = allMessageIds.indexOf(firstId)
        const segLastIdx = allMessageIds.indexOf(lastId)
        if (segFirstIdx === -1 || segLastIdx === -1) continue

        // segment 在选区上方且相邻（segment 的最后一条消息紧邻选区第一条消息之前）
        if (segLastIdx + 1 === selStart) {
          upSegment = seg
        }
        // segment 在选区下方且相邻（选区最后一条消息紧邻 segment 第一条消息之前）
        if (selEnd + 1 === segFirstIdx) {
          downSegment = seg
        }
      }

      if (!upSegment && !downSegment) return null
      return { upSegment, downSegment }
    },
    [allMessageIds, getSegmentsForTopic, topicId]
  )

  const mergeInfo = useMemo(() => {
    const msgIds = getSelectedMessageIds()
    if (msgIds.length === 0) return null
    if (!checkMessagesContinuous(msgIds)) return null
    // 检查选中消息是否属于已有 segment
    const segments = getSegmentsForTopic(topicId)
    const hasConflict = msgIds.some((id) => segments.some((seg) => seg.messageIds.includes(id)))
    if (hasConflict) return null
    return getMergeDirections(msgIds)
  }, [getSelectedMessageIds, checkMessagesContinuous, getSegmentsForTopic, topicId, getMergeDirections])

  const handleMerge = useCallback(
    async (direction: 'up' | 'down') => {
      // BRANCH-12: 选集不可变时 segment 合并零调用。
      if (!isSelectionMutable) return
      const msgIds = getSelectedMessageIds()
      if (!mergeInfo) return

      const targetSegment = direction === 'up' ? mergeInfo.upSegment : mergeInfo.downSegment
      if (!targetSegment) return

      let newMessageIds: string[]
      if (direction === 'up') {
        // 向上合并：选区消息在 segment 下方，将选区消息追加到 segment 尾部
        newMessageIds = [...targetSegment.messageIds, ...msgIds]
      } else {
        // 向下合并：选区消息在 segment 上方，将选区消息插入到 segment 头部
        newMessageIds = [...msgIds, ...targetSegment.messageIds]
      }

      await updateSegmentMessageIds(targetSegment.id, newMessageIds)
      dispatch(clearSelection())
      window.toast?.success?.(t('topicSegment.merge.success'))
    },
    [isSelectionMutable, mergeInfo, getSelectedMessageIds, updateSegmentMessageIds, dispatch, t]
  )

  // ─── 从消息组移除 ───

  const removeFromSegmentInfo = useMemo(() => {
    const msgIds = getSelectedMessageIds()
    if (msgIds.length === 0) return null
    if (!checkMessagesContinuous(msgIds)) return null

    const segments = getSegmentsForTopic(topicId)
    for (const seg of segments) {
      const segMsgIds = seg.messageIds
      // 检查选区是否为 segment 的头部子集
      const isHead = msgIds.every((id, i) => segMsgIds[i] === id)
      // 检查选区是否为 segment 的尾部子集
      const isTail = msgIds.every((id, i) => segMsgIds[segMsgIds.length - msgIds.length + i] === id)

      if (isHead && isTail && msgIds.length === segMsgIds.length) {
        // 选区覆盖整个 segment → 解散
        return { type: 'dissolve' as const, segment: seg }
      }
      if (isHead) {
        return { type: 'head' as const, segment: seg, removeIds: msgIds }
      }
      if (isTail) {
        return { type: 'tail' as const, segment: seg, removeIds: msgIds }
      }
    }
    return null
  }, [getSelectedMessageIds, checkMessagesContinuous, getSegmentsForTopic, topicId])

  const canCreateSegment = useMemo(() => {
    // BRANCH-12: 选集不可变时 segment 创建禁用（与 cut/delete 同门禁）。
    if (!isSelectionMutable) return false
    const msgIds = getSelectedMessageIds()
    if (msgIds.length === 0) return false
    if (!checkMessagesContinuous(msgIds)) return false
    const existingSegments = getSegmentsForTopic(topicId)
    const hasOverlap = msgIds.some((id) => existingSegments.some((seg) => seg.messageIds.includes(id)))
    if (hasOverlap) return false
    return true
  }, [isSelectionMutable, getSelectedMessageIds, checkMessagesContinuous, getSegmentsForTopic, topicId])

  const canMoveToNewBranch = useMemo(() => {
    if (selectedGroupIds.length === 0 || !isSelectionMutable) return false
    if (!catalogKnown) return false
    if (!Array.isArray(mutableIds) || (mutableRoute ?? null) !== (activeRoute ?? null)) return false
    // Known-incomplete/orphan guard (renderer-visible): every selected group
    // root must itself be resident. Main's exact expected-match stays final.
    for (const gid of selectedGroupIds) {
      if (!allMessageIds.includes(gid)) return false
    }
    const msgIds = getSelectedMessageIds()
    if (msgIds.length === 0) return false
    if (!checkMessagesContinuous(msgIds)) return false
    const mutableSet = new Set(mutableIds)
    for (const id of msgIds) {
      if (!mutableSet.has(id)) return false
    }
    const firstIdx = allMessageIds.indexOf(msgIds[0])
    if (firstIdx <= 0) return false
    const precedingId = allMessageIds[firstIdx - 1]
    if (!mutableSet.has(precedingId)) return false
    const segments = getSegmentsForTopic(topicId)
    const movedSet = new Set(msgIds)
    for (const seg of segments) {
      if (!Array.isArray(seg.messageIds) || seg.messageIds.length === 0) continue
      let inside = 0
      for (const mid of seg.messageIds) {
        if (movedSet.has(mid)) inside++
      }
      if (inside > 0 && inside < seg.messageIds.length) return false
    }
    return true
  }, [
    selectedGroupIds,
    isSelectionMutable,
    catalogKnown,
    mutableIds,
    mutableRoute,
    activeRoute,
    getSelectedMessageIds,
    checkMessagesContinuous,
    allMessageIds,
    getSegmentsForTopic,
    topicId
  ])

  const handleMoveToNewBranch = useCallback(async () => {
    if (!canMoveToNewBranch) return
    try {
      const { moveSelectedTurnsToNewBranchThunk } = await import('@renderer/store/thunk/messageThunk')
      const defaultName = t('chat.topics.branch.default_name')
      const created = (await dispatch(
        moveSelectedTurnsToNewBranchThunk(topicId, activeRoute ?? null, selectedGroupIds, defaultName) as never
      )) as unknown as { branchId: string } | null
      if (!created) {
        window.toast.error(t('message.true_branch.error'))
        return
      }
      window.toast.success(t('chat.message.true_branch.created'))
    } catch (error) {
      menuLogger.error('[handleMoveToNewBranch] Failed to move turns to new branch', error as Error)
      window.toast.error(t('message.true_branch.error'))
    }
  }, [canMoveToNewBranch, dispatch, topicId, activeRoute, selectedGroupIds, t])

  const handleRemoveFromSegment = useCallback(async () => {
    // BRANCH-12: 选集不可变时 segment 移除/解散零调用。
    if (!isSelectionMutable) return
    if (!removeFromSegmentInfo) return
    const { type, segment } = removeFromSegmentInfo

    if (type === 'dissolve') {
      await deleteSegment(segment.id)
    } else {
      const removeIds = removeFromSegmentInfo.removeIds
      const newMessageIds = segment.messageIds.filter((id) => !removeIds.includes(id))
      if (newMessageIds.length === 0) {
        await deleteSegment(segment.id)
      } else {
        await updateSegmentMessageIds(segment.id, newMessageIds)
      }
    }
    dispatch(clearSelection())
    window.toast?.success?.(t('topicSegment.remove.success'))
  }, [isSelectionMutable, removeFromSegmentInfo, deleteSegment, updateSegmentMessageIds, dispatch, t])

  const handleSelectAll = useCallback(() => {
    const allAskIds = groups.map((g) => g.askId)
    dispatch(setSelectedGroupIds(allAskIds))
  }, [dispatch, groups])
  // "Including child branches" is a right-click option of the copy/cut actions,
  // and only while it is actually relevant to the selection.
  const treeCopyRelevant = useMemo(
    () =>
      hasSelectedChildBranchAnchor({
        branches,
        activeBranchId: activeRoute,
        catalogKnown,
        // The resident projection carries the route it was published for; a
        // mismatch means the selection may address another route → hide.
        projectionRouteAligned: (mutableRoute ?? null) === (activeRoute ?? null),
        selectedGroupIds,
        selectedGroups
      }),
    [branches, activeRoute, catalogKnown, mutableRoute, selectedGroupIds, selectedGroups]
  )
  // Cut keeps the existing selection-mutability gate: an inherited/non-writable
  // selection never gets a tree cut it could not execute (ordinary cut stays
  const treeCutRelevant = treeCopyRelevant && isSelectionMutable
  // Delete with children is offered on exactly the same relevance terms as the
  // tree cut: a child-branch anchor on the selection plus a writable selection.
  // The ordinary delete stays available with its usual disabled state.
  const treeDeleteRelevant = treeCopyRelevant && isSelectionMutable

  const items: MenuProps['items'] = useMemo(() => {
    if (!isEnabled) return []

    // Relevant tree capture turns the action into a submenu: the ordinary action
    // stays available, the "including child branches" variant is one level in.
    // The submenu title only expands (no `onClick`): it never performs the action
    // itself, and its popup sits flush with the parent panel edge (no overlap,
    // no seam) on either side.
    const copyItem = treeCopyRelevant
      ? {
          key: 'copy',
          label: t('editMode.contextMenu.copy'),
          popupOffset: SUBMENU_OFFSET,
          children: [
            { key: 'copyOrdinary', label: t('editMode.contextMenu.copy'), onClick: handleCopy },
            {
              key: 'copyWithChildren',
              label: t('chat.edit.copyTreeAction'),
              onClick: handleCopyWithChildren
            }
          ]
        }
      : {
          key: 'copy',
          label: t('editMode.contextMenu.copy'),
          onClick: handleCopy
        }

    const cutItem = treeCutRelevant
      ? {
          key: 'cut',
          label: t('editMode.contextMenu.cut'),
          popupOffset: SUBMENU_OFFSET,
          children: [
            {
              key: 'cutOrdinary',
              label: t('editMode.contextMenu.cut'),
              disabled: !isSelectionMutable,
              onClick: handleCut
            },
            {
              key: 'cutWithChildren',
              label: t('chat.edit.cutTreeAction'),
              onClick: handleCutWithChildren
            }
          ]
        }
      : {
          key: 'cut',
          label: t('editMode.contextMenu.cut'),
          // BRANCH-12: 选集不可变时剪切禁用（copy 保持允许）。
          disabled: !isSelectionMutable,
          onClick: handleCut
        }

    const deleteItem = treeDeleteRelevant
      ? {
          key: 'delete',
          label: t('editMode.contextMenu.delete'),
          popupOffset: SUBMENU_OFFSET,
          children: [
            {
              key: 'deleteOrdinary',
              label: t('editMode.contextMenu.delete'),
              disabled: selectedGroupIds.length === 0 || !isSelectionMutable,
              onClick: () => void handleDelete()
            },
            {
              key: 'deleteWithChildren',
              label: t('chat.edit.deleteTreeAction'),
              onClick: handleDeleteWithChildren
            }
          ]
        }
      : {
          key: 'delete',
          label: t('editMode.contextMenu.delete'),
          // BRANCH-12: 空选或选集不可变时删除禁用。
          disabled: selectedGroupIds.length === 0 || !isSelectionMutable,
          onClick: () => void handleDelete()
        }

    return [
      copyItem,
      cutItem,
      {
        key: 'paste',
        label: t('editMode.contextMenu.paste'),
        disabled: !hasClipboard,
        onClick: () => void handlePaste()
      },
      deleteItem,
      { type: 'divider' },
      {
        key: 'toggleFoldSelected',
        label: areAllSelectedFolded ? t('chat.unfold_selected_turns') : t('chat.fold_selected_turns'),
        disabled: selectedGroupIds.length === 0 || !isSelectionMutable,
        onClick: () => void handleToggleFoldSelected()
      },
      { type: 'divider' },
      {
        key: 'createSegment',
        label: t('topicSegment.createAction'),
        disabled: !canCreateSegment,
        onClick: handleCreateSegment
      },
      // 向上合并（选区合并到上方 segment）
      ...(mergeInfo?.upSegment && isSelectionMutable
        ? [
            {
              key: 'mergeUp',
              label: t('topicSegment.mergeUp'),
              onClick: () => void handleMerge('up')
            }
          ]
        : []),
      // 向下合并（选区合并到下方 segment）
      ...(mergeInfo?.downSegment && isSelectionMutable
        ? [
            {
              key: 'mergeDown',
              label: t('topicSegment.mergeDown'),
              onClick: () => void handleMerge('down')
            }
          ]
        : []),
      // 从消息组移除 / 解散消息组
      ...(removeFromSegmentInfo && isSelectionMutable
        ? [
            {
              key: 'removeFromSegment',
              label:
                removeFromSegmentInfo.type === 'dissolve'
                  ? t('topicSegment.dissolveAction')
                  : t('topicSegment.removeFromSegment'),
              onClick: () => void handleRemoveFromSegment()
            }
          ]
        : []),
      { type: 'divider' },
      {
        key: 'moveToNewBranch',
        label: t('editMode.contextMenu.moveToNewBranch'),
        disabled: !canMoveToNewBranch,
        onClick: () => void handleMoveToNewBranch()
      },
      { type: 'divider' },
      {
        key: 'selectAll',
        label: t('editMode.contextMenu.selectAll'),
        onClick: handleSelectAll
      },
      { type: 'divider' },
      {
        key: 'undo',
        label: t('editMode.contextMenu.undo'),
        disabled: !canUndo,
        onClick: () => void handleUndo()
      },
      {
        key: 'redo',
        label: t('editMode.contextMenu.redo'),
        disabled: !canRedo,
        onClick: () => void handleRedo()
      }
    ]
  }, [
    isEnabled,
    t,
    handleCopy,
    handleCut,
    handleCopyWithChildren,
    handleCutWithChildren,
    treeCopyRelevant,
    treeCutRelevant,
    treeDeleteRelevant,
    handlePaste,
    handleDelete,
    handleDeleteWithChildren,
    handleCreateSegment,
    handleMerge,
    handleRemoveFromSegment,
    handleMoveToNewBranch,
    handleSelectAll,
    handleUndo,
    handleRedo,
    hasClipboard,
    canUndo,
    canRedo,
    selectedGroupIds,
    isSelectionMutable,
    mergeInfo,
    removeFromSegmentInfo,
    canCreateSegment,
    canMoveToNewBranch,
    areAllSelectedFolded,
    handleToggleFoldSelected
  ])

  return { items, canMoveToNewBranch }
}
