import { copyMessages, cutMessages, deleteSelectedMessages, pasteMessages } from '@renderer/services/ClipboardService'
import { executeRedo, executeUndo } from '@renderer/services/UndoService'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  clearSelection,
  setLastSelectedIndex,
  setSelectedGroupIds,
  toggleEditMode as toggleEditModeAction
} from '@renderer/store/editMode'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import i18n from 'i18next'
import { useCallback, useMemo, useRef } from 'react'

import { getGroupIndex, useMessageGroups } from './useMessageGroup'

export function useEditMode(topicId: string) {
  const dispatch = useAppDispatch()

  // State — precise selectors
  const isEnabled = useAppSelector((state) => state.editMode.enabled)
  const selectedGroupIds = useAppSelector((state) => state.editMode.selectedGroupIds)
  const lastSelectedIndex = useAppSelector((state) => state.editMode.lastSelectedIndex)
  const clipboard = useAppSelector((state) => state.clipboard)
  const undoStack = useAppSelector((state) => state.undoStack)
  const messages = useAppSelector((state) => selectMessagesForTopic(state, topicId))

  // 消息组
  const groups = useMessageGroups(messages)

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
      }
    },
    [dispatch, groups, selectedGroupIds, lastSelectedIndex, isEnabled]
  )

  // 复制
  const handleCopy = useCallback(() => {
    if (!isEnabled || selectedGroupIds.length === 0) return
    const count = copyMessages(dispatch, store.getState, topicId, selectedGroupIds)
    if (count > 0) {
      window.toast.success(i18n.t('chat.edit.copied', { count }))
    }
  }, [dispatch, isEnabled, topicId, selectedGroupIds])

  // 剪切
  const handleCut = useCallback(() => {
    if (!isEnabled || selectedGroupIds.length === 0) return
    const count = cutMessages(dispatch, store.getState, topicId, selectedGroupIds)
    if (count > 0) {
      window.toast.success(i18n.t('chat.edit.cut', { count }))
    }
  }, [dispatch, isEnabled, topicId, selectedGroupIds])

  // 粘贴
  const isProcessingRef = useRef(false)

  const handlePaste = useCallback(async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    try {
      if (!isEnabled) return
      if (clipboard.items.length === 0) {
        window.toast.info(i18n.t('chat.edit.clipboardEmpty'))
        return
      }
      if (selectedGroupIds.length === 0) {
        window.toast.warning(i18n.t('chat.edit.selectFirst'))
        return
      }

      // 粘贴到最后一条选中消息之后
      const lastSelectedAskId = selectedGroupIds[selectedGroupIds.length - 1]
      const count = await pasteMessages(dispatch, store.getState, topicId, lastSelectedAskId)
      if (count > 0) {
        window.toast.success(i18n.t('chat.edit.pasted', { count }))
      }
      dispatch(clearSelection())
    } finally {
      isProcessingRef.current = false
    }
  }, [dispatch, isEnabled, topicId, clipboard, selectedGroupIds])

  // 删除
  const handleDelete = useCallback(async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    try {
      if (!isEnabled || selectedGroupIds.length === 0) return
      const count = await deleteSelectedMessages(dispatch, store.getState, topicId, selectedGroupIds)
      if (count > 0) {
        window.toast.success(i18n.t('chat.edit.deleted', { count }))
      }
      dispatch(clearSelection())
    } finally {
      isProcessingRef.current = false
    }
  }, [dispatch, isEnabled, topicId, selectedGroupIds])

  // 撤销
  const handleUndo = useCallback(async () => {
    const action = await executeUndo(dispatch, store.getState)
    if (action) {
      window.toast.success(i18n.t('chat.edit.undone'))
    }
  }, [dispatch])

  // 重做
  const handleRedo = useCallback(async () => {
    const action = await executeRedo(dispatch, store.getState)
    if (action) {
      window.toast.success(i18n.t('chat.edit.redone'))
    }
  }, [dispatch])

  // stable clearSelection
  const stableClearSelection = useCallback(() => {
    dispatch(clearSelection())
  }, [dispatch])

  return {
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
    handleUndo,
    handleRedo,
    clearSelection: stableClearSelection
  }
}
