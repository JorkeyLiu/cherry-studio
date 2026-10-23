import { loggerService } from '@logger'
import { copyMessages, cutMessages, deleteSelectedMessages, pasteMessages } from '@renderer/services/ClipboardService'
import { executeRedo, executeUndo } from '@renderer/services/UndoService'

const logger = loggerService.withContext('useEditMode')
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  clearSelection,
  extendSelectionRange,
  finishProcessing,
  moveFocusSelection,
  setAnchorGroupId,
  setFocusedGroupId,
  setFocusedIndex,
  setLastSelectedIndex,
  setSelectedGroupIds,
  startProcessing,
  toggleEditMode as toggleEditModeAction
} from '@renderer/store/editMode'
import { requireEditSelectionMutable, selectIsEditSelectionMutable } from '@renderer/store/editSelection'
import { selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { EditSelectionBoundaryPageRequest } from '@renderer/types/editMode'
import type { Message } from '@renderer/types/newMessage'
import i18n from 'i18next'
import { useCallback, useEffect, useMemo } from 'react'

import { getGroupIndex, useMessageGroups } from './useMessageGroup'

export function useCreateEditMode(
  topicId: string,
  scrollToGroup?: (askId: string) => void,
  visibleGroupIds?: Set<string>,
  requestBoundaryPage?: EditSelectionBoundaryPageRequest
) {
  const dispatch = useAppDispatch()

  // State — precise selectors
  const isEnabled = useAppSelector((state) => state.editMode.enabled)
  const isProcessing = useAppSelector((state) => state.editMode.isProcessing)
  const selectedGroupIds = useAppSelector((state) => state.editMode.selectedGroupIds)
  const lastSelectedIndex = useAppSelector((state) => state.editMode.lastSelectedIndex)
  const anchorGroupId = useAppSelector((state) => state.editMode.anchorGroupId)
  const focusedGroupId = useAppSelector((state) => state.editMode.focusedGroupId)
  const focusedIndex = useAppSelector((state) => state.editMode.focusedIndex)
  const clipboard = useAppSelector((state) => state.clipboard)
  const undoStack = useAppSelector((state) => state.undoStack)
  // Bounded loaded projection: resident topic only. The `?? []` fallback is
  // memoized so the edit-group memo keeps a stable identity while non-resident
  // (`undefined` stays at the API boundary).
  const loadedMessages = useAppSelector((state) => selectLoadedMessagesForTopic(state, topicId))
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, topicId))
  const messages = useMemo(() => (loadedMessages ?? []) as Message[], [loadedMessages])

  // 消息组
  const allGroups = useMessageGroups(messages)
  // 使用已渲染的组（分页可见），若未传则使用全部
  const groups = useMemo(() => {
    if (!visibleGroupIds) return allGroups
    return allGroups.filter((g) => visibleGroupIds.has(g.askId))
  }, [allGroups, visibleGroupIds])

  // W3: 切换 topic 时清空选择
  useEffect(() => {
    dispatch(clearSelection())
  }, [topicId, dispatch])

  // BRANCH-12: route 切换清空选择 — 避免残留计数误导写门禁；
  // 能力 route 不匹配本身也会使写 fail-closed（双保险）。
  useEffect(() => {
    dispatch(clearSelection())
  }, [activeBranchId, dispatch])

  // BRANCH-12: 当前选集是否可写 — 每个选中组的全部 loaded 消息都
  // 在当前 route mutableMessageIds 中；未知/残留/不完整 fail-closed。
  // Copy 保持允许（authority 读取），不经此门禁。
  const isSelectionMutable = useAppSelector((state) => selectIsEditSelectionMutable(state, topicId))

  // 选中的消息组
  const selectedGroups = useMemo(() => {
    return groups.filter((g) => selectedGroupIds.includes(g.askId))
  }, [groups, selectedGroupIds])

  // Toggle 编辑模式
  const toggleEditMode = useCallback(
    (enabled: boolean) => {
      dispatch(toggleEditModeAction(enabled))
    },
    [dispatch]
  )

  // 点击选择消息组
  const handleGroupClick = useCallback(
    (askId: string, isCtrl: boolean, isShift: boolean) => {
      if (!isEnabled) return

      const groupIndex = getGroupIndex(groups, askId)
      if (groupIndex === -1) return

      const resolvedAnchorIndex = anchorGroupId ? getGroupIndex(groups, anchorGroupId) : -1
      if (isShift && (!anchorGroupId || resolvedAnchorIndex < 0)) return

      if (isShift && resolvedAnchorIndex !== -1) {
        // Shift 区域选
        const start = Math.min(resolvedAnchorIndex, groupIndex)
        const end = Math.max(resolvedAnchorIndex, groupIndex)
        const rangeAskIds = groups.slice(start, end + 1).map((g) => g.askId)

        if (isCtrl) {
          // Ctrl+Shift: 并集
          const newSelection = [...new Set([...selectedGroupIds, ...rangeAskIds])]
          dispatch(setSelectedGroupIds(newSelection))
        } else {
          // Shift only: 替换
          dispatch(setSelectedGroupIds(rangeAskIds))
        }
      } else if (isCtrl) {
        // Ctrl 点选：切换
        const index = selectedGroupIds.indexOf(askId)
        if (index >= 0) {
          dispatch(setSelectedGroupIds(selectedGroupIds.filter((id) => id !== askId)))
          if (anchorGroupId === askId) dispatch(setAnchorGroupId(null))
          if (focusedGroupId === askId) dispatch(setFocusedGroupId(null))
        } else {
          dispatch(setSelectedGroupIds([...selectedGroupIds, askId]))
        }
      } else {
        // 普通点击
        const isSelected = selectedGroupIds.includes(askId)
        if (isSelected && selectedGroupIds.length === 1) {
          // 点击唯一选中的 → 取消选中
          dispatch(clearSelection())
        } else {
          // 单选
          dispatch(setSelectedGroupIds([askId]))
        }
      }

      if (!isShift) {
        dispatch(setLastSelectedIndex(groupIndex))
        dispatch(setFocusedIndex(groupIndex))
        dispatch(setAnchorGroupId(askId))
        dispatch(setFocusedGroupId(askId))
      }
    },
    [dispatch, groups, selectedGroupIds, anchorGroupId, focusedGroupId, isEnabled]
  )

  // 复制
  const handleCopy = useCallback(() => {
    if (isProcessing) return
    if (!isEnabled || selectedGroupIds.length === 0) return
    dispatch(startProcessing())
    // Authority-complete clipboard read (caller-local whole-topic snapshot).
    // Fire-and-forget: copy is read-only apart from the clipboard publication
    // and reports expected snapshot failures as a zero count
    // (no success toast), matching the existing zero-selection semantics.
    // Unexpected rejections are logged via loggerService (never console).
    // The lock always releases in finally.
    void (async () => {
      try {
        const count = await copyMessages(dispatch, topicId, selectedGroupIds, activeBranchId)
        if (count > 0) {
          window.toast.success(i18n.t('chat.edit.copied', { count }))
        }
      } catch (error) {
        logger.error('[handleCopy] Unexpected copy failure', error as Error)
      } finally {
        dispatch(finishProcessing())
      }
    })()
  }, [dispatch, isEnabled, isProcessing, topicId, selectedGroupIds, activeBranchId])

  // 剪切
  const handleCut = useCallback(() => {
    if (isProcessing) return
    if (!isEnabled || selectedGroupIds.length === 0) return
    // BRANCH-12: 选集不可变时零 clipboard cut、零 Main mutation、零 Redux
    // 变化。Copy 保持允许；cut 的 clipboard 发布本身即写意图，故同样阻断。
    try {
      requireEditSelectionMutable(store.getState(), topicId, selectedGroupIds)
    } catch (error) {
      logger.warn('[handleCut] Selection is immutable through this route; cut refused', error as Error)
      return
    }
    dispatch(startProcessing())
    // Same authority-complete publication as copy (mode `cut`); the source
    // deletion itself happens at paste time. Failure semantics as handleCopy.
    void (async () => {
      try {
        const count = await cutMessages(dispatch, store.getState, topicId, selectedGroupIds, activeBranchId)
        if (count > 0) {
          window.toast.success(i18n.t('chat.edit.cut', { count }))
        }
      } catch (error) {
        logger.error('[handleCut] Unexpected cut failure', error as Error)
      } finally {
        dispatch(finishProcessing())
      }
    })()
  }, [dispatch, isEnabled, isProcessing, topicId, selectedGroupIds, activeBranchId])

  // 粘贴
  const handlePaste = useCallback(async () => {
    if (isProcessing) return
    if (!isEnabled) return
    dispatch(startProcessing())
    try {
      if (clipboard.items.length === 0) {
        window.toast.info(i18n.t('chat.edit.clipboardEmpty'))
        return
      }
      // Find the visually last selected group (highest position in topic)
      let lastSelectedAskId = ''
      if (selectedGroupIds.length > 0) {
        let maxIndex = -1
        for (const askId of selectedGroupIds) {
          const groupIndex = groups.findIndex((g) => g.askId === askId)
          if (groupIndex > maxIndex) {
            maxIndex = groupIndex
            lastSelectedAskId = askId
          }
        }
        if (!lastSelectedAskId) {
          lastSelectedAskId = selectedGroupIds[selectedGroupIds.length - 1]
        }
      }
      const count = await pasteMessages(dispatch, store.getState, topicId, lastSelectedAskId)
      if (count > 0) {
        window.toast.success(i18n.t('chat.edit.pasted', { count }))
      }
      dispatch(clearSelection())
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isEnabled, isProcessing, topicId, clipboard, selectedGroupIds, groups])

  // 删除
  const handleDelete = useCallback(async () => {
    if (isProcessing) return
    if (!isEnabled || selectedGroupIds.length === 0) return
    // BRANCH-12: 选集不可变时零 Main mutation、零 Redux 变化。
    // 含一个 non-owned 即整体阻断（require 内逐成员验证，不跳过）。
    try {
      requireEditSelectionMutable(store.getState(), topicId, selectedGroupIds)
    } catch (error) {
      logger.warn('[handleDelete] Selection is immutable through this route; delete refused', error as Error)
      return
    }
    dispatch(startProcessing())
    try {
      const count = await deleteSelectedMessages(dispatch, store.getState, topicId, selectedGroupIds)
      if (count > 0) {
        window.toast.success(i18n.t('chat.edit.deleted', { count }))
      }
      dispatch(clearSelection())
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isEnabled, isProcessing, topicId, selectedGroupIds])

  // 撤销
  const handleUndo = useCallback(async () => {
    if (isProcessing) return
    dispatch(startProcessing())
    try {
      const action = await executeUndo(dispatch, store.getState)
      if (action) {
        window.toast.success(i18n.t('chat.edit.undone'))
      }
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isProcessing])

  // 重做
  const handleRedo = useCallback(async () => {
    if (isProcessing) return
    dispatch(startProcessing())
    try {
      const action = await executeRedo(dispatch, store.getState)
      if (action) {
        window.toast.success(i18n.t('chat.edit.redone'))
      }
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isProcessing])

  // 移动焦点（单选光标）
  const handleMoveFocus = useCallback(
    (direction: 'up' | 'down') => {
      if (groups.length === 0) return
      const resolvedFocusIndex = focusedGroupId ? getGroupIndex(groups, focusedGroupId) : -1
      const currentIndex = resolvedFocusIndex >= 0 ? resolvedFocusIndex : (focusedIndex ?? lastSelectedIndex ?? -1)
      const maxIndex = groups.length - 1

      let newIndex: number
      if (direction === 'up') {
        // groups 按时间正序：索引越小越旧（视觉越靠上），Up 键向更早消息移动
        newIndex = Math.max(currentIndex - 1, 0)
      } else {
        // Down 键向更新消息移动（索引增大）
        newIndex = Math.min(currentIndex + 1, maxIndex)
      }

      if (newIndex === currentIndex) return

      const targetGroup = groups[newIndex]
      if (targetGroup) {
        dispatch(moveFocusSelection({ groupId: targetGroup.askId, index: newIndex }))
        scrollToGroup?.(targetGroup.askId)
      }
    },
    [dispatch, groups, lastSelectedIndex, focusedIndex, focusedGroupId, scrollToGroup]
  )

  // 扩展选区（Shift+箭头）
  const handleExtendSelection = useCallback(
    (direction: 'up' | 'down') => {
      if (groups.length === 0) return
      const resolvedAnchorIndex = anchorGroupId ? getGroupIndex(groups, anchorGroupId) : -1
      const resolvedFocusIndex = focusedGroupId ? getGroupIndex(groups, focusedGroupId) : -1
      if ((anchorGroupId && resolvedAnchorIndex < 0) || (focusedGroupId && resolvedFocusIndex < 0)) return
      const anchorIndex = resolvedAnchorIndex >= 0 ? resolvedAnchorIndex : (lastSelectedIndex ?? 0)
      const currentFocus = resolvedFocusIndex >= 0 ? resolvedFocusIndex : (focusedIndex ?? anchorIndex)

      let newFocus: number
      if (direction === 'up') {
        newFocus = Math.max(currentFocus - 1, 0)
      } else {
        newFocus = Math.min(currentFocus + 1, groups.length - 1)
      }

      if (newFocus === currentFocus) {
        // 端点已到已显示窗口边界：无法继续推进。把选择自身的编辑方向表达为
        // 一次有界窗口分页请求（方向本身即意图，不合成 scroll、不伪造用户
        // 手势），下一次真实按键重复再推进。分页结果不驱动任何后续选区写入，
        // 因此松开按键 / 反向 / 焦点转入输入框都不会事后篡改选区；按键自动
        // 重复期间的在途请求由分页通道的 single-flight 认领合并。
        if (!requestBoundaryPage) return
        try {
          void requestBoundaryPage(direction === 'up' ? 'older' : 'newer').catch(() => {})
        } catch {
          // fail-closed：分页是选区边界的增强能力，请求失败不得中断按键处理
        }
        return
      }

      // 从 anchor 到新焦点的范围
      const start = Math.min(anchorIndex, newFocus)
      const end = Math.max(anchorIndex, newFocus)
      const rangeAskIds = groups.slice(start, end + 1).map((g) => g.askId)

      // One atomic range step: a repeat key must not publish an intermediate
      // selection (old endpoint id with the new range) to context consumers —
      // the arrangement reads only ever observe one consistent step.
      dispatch(
        extendSelectionRange({
          rangeGroupIds: rangeAskIds,
          anchorGroupId: groups[anchorIndex]?.askId ?? null,
          focusedGroupId: groups[newFocus]?.askId ?? null,
          anchorIndex,
          focusedIndex: newFocus
        })
      )

      // 滚动到新扩展的边界
      const boundaryGroup = groups[newFocus]
      if (boundaryGroup) {
        scrollToGroup?.(boundaryGroup.askId)
      }
    },
    [
      dispatch,
      groups,
      anchorGroupId,
      lastSelectedIndex,
      focusedIndex,
      focusedGroupId,
      scrollToGroup,
      requestBoundaryPage
    ]
  )

  // 清除选区（不退出编辑模式）
  const handleClearSelection = useCallback(() => {
    dispatch(clearSelection())
  }, [dispatch])

  // stable clearSelection
  const stableClearSelection = useCallback(() => {
    dispatch(clearSelection())
  }, [dispatch])

  return useMemo(
    () => ({
      // State
      isEnabled,
      selectedGroupIds,
      selectedGroups,
      groups,
      hasClipboard: clipboard.items.length > 0,
      canUndo: undoStack.undoStack.length > 0,
      canRedo: undoStack.redoStack.length > 0,
      // BRANCH-12: 选集写能力 — Cut/Delete/segment 写操作 disabled 门禁；
      // Copy/Paste 意图不受此门禁限制（paste 源删除由 Main 最终校验）。
      isSelectionMutable,

      // Actions
      toggleEditMode,
      handleGroupClick,
      handleCopy,
      handleCut,
      handlePaste,
      handleDelete,
      handleMoveFocus,
      handleExtendSelection,
      handleClearSelection,
      handleUndo,
      handleRedo,
      clearSelection: stableClearSelection
    }),
    [
      isEnabled,
      selectedGroupIds,
      selectedGroups,
      groups,
      clipboard.items.length,
      undoStack.undoStack.length,
      undoStack.redoStack.length,
      isSelectionMutable,
      toggleEditMode,
      handleGroupClick,
      handleCopy,
      handleCut,
      handlePaste,
      handleDelete,
      handleMoveFocus,
      handleExtendSelection,
      handleClearSelection,
      handleUndo,
      handleRedo,
      stableClearSelection
    ]
  )
}
