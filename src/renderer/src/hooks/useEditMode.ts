import { copyMessages, cutMessages, deleteSelectedMessages, pasteMessages } from '@renderer/services/ClipboardService'
import { executeRedo, executeUndo } from '@renderer/services/UndoService'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  clearSelection,
  finishProcessing,
  moveFocusSelection,
  setFocusedIndex,
  setLastSelectedIndex,
  setSelectedGroupIds,
  startProcessing,
  toggleEditMode as toggleEditModeAction
} from '@renderer/store/editMode'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import i18n from 'i18next'
import { useCallback, useEffect, useMemo } from 'react'

import { getGroupIndex, useMessageGroups } from './useMessageGroup'

export function useCreateEditMode(
  topicId: string,
  scrollToGroup?: (askId: string) => void,
  visibleGroupIds?: Set<string>
) {
  const dispatch = useAppDispatch()

  // State — precise selectors
  const isEnabled = useAppSelector((state) => state.editMode.enabled)
  const isProcessing = useAppSelector((state) => state.editMode.isProcessing)
  const selectedGroupIds = useAppSelector((state) => state.editMode.selectedGroupIds)
  const lastSelectedIndex = useAppSelector((state) => state.editMode.lastSelectedIndex)
  const focusedIndex = useAppSelector((state) => state.editMode.focusedIndex)
  const clipboard = useAppSelector((state) => state.clipboard)
  const undoStack = useAppSelector((state) => state.undoStack)
  const messages = useAppSelector((state) => selectMessagesForTopic(state, topicId))

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

      if (isShift && lastSelectedIndex !== null) {
        // Shift 区域选
        const start = Math.min(lastSelectedIndex, groupIndex)
        const end = Math.max(lastSelectedIndex, groupIndex)
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
      }
    },
    [dispatch, groups, selectedGroupIds, lastSelectedIndex, isEnabled]
  )

  // 复制
  const handleCopy = useCallback(() => {
    if (isProcessing) return
    if (!isEnabled || selectedGroupIds.length === 0) return
    dispatch(startProcessing())
    try {
      const count = copyMessages(dispatch, store.getState, topicId, selectedGroupIds)
      if (count > 0) {
        window.toast.success(i18n.t('chat.edit.copied', { count }))
      }
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isEnabled, isProcessing, topicId, selectedGroupIds])

  // 剪切
  const handleCut = useCallback(() => {
    if (isProcessing) return
    if (!isEnabled || selectedGroupIds.length === 0) return
    dispatch(startProcessing())
    try {
      const count = cutMessages(dispatch, store.getState, topicId, selectedGroupIds)
      if (count > 0) {
        window.toast.success(i18n.t('chat.edit.cut', { count }))
      }
    } finally {
      dispatch(finishProcessing())
    }
  }, [dispatch, isEnabled, isProcessing, topicId, selectedGroupIds])

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
      const currentIndex = focusedIndex ?? lastSelectedIndex ?? -1
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
    [dispatch, groups, lastSelectedIndex, focusedIndex, scrollToGroup]
  )

  // 扩展选区（Shift+箭头）
  const handleExtendSelection = useCallback(
    (direction: 'up' | 'down') => {
      if (groups.length === 0) return
      const anchorIndex = lastSelectedIndex ?? 0
      const currentFocus = focusedIndex ?? anchorIndex

      let newFocus: number
      if (direction === 'up') {
        newFocus = Math.max(currentFocus - 1, 0)
      } else {
        newFocus = Math.min(currentFocus + 1, groups.length - 1)
      }

      if (newFocus === currentFocus) return

      // 从 anchor 到新焦点的范围
      const start = Math.min(anchorIndex, newFocus)
      const end = Math.max(anchorIndex, newFocus)
      const rangeAskIds = groups.slice(start, end + 1).map((g) => g.askId)

      dispatch(setSelectedGroupIds(rangeAskIds))
      dispatch(setFocusedIndex(newFocus))

      // 滚动到新扩展的边界
      const boundaryGroup = groups[newFocus]
      if (boundaryGroup) {
        scrollToGroup?.(boundaryGroup.askId)
      }
    },
    [dispatch, groups, lastSelectedIndex, focusedIndex, scrollToGroup]
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
