import { useEditMode } from '@renderer/context/EditModeContext'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { clearSelection, setSelectedGroupIds } from '@renderer/store/editMode'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { MenuProps } from 'antd'
import { Dropdown } from 'antd'
import { memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

interface EditModeContextMenuProps {
  children: React.ReactNode
  topicId: string
}

const EditModeContextMenu: React.FC<EditModeContextMenuProps> = ({ children, topicId }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const {
    isEnabled,
    selectedGroupIds,
    handleCopy,
    handleCut,
    handlePaste,
    handleDelete,
    handleUndo,
    handleRedo,
    hasClipboard,
    canUndo,
    canRedo,
    groups
  } = useEditMode()

  const { createSegment, getSegmentsForTopic, updateSegmentMessageIds, deleteSegment } = useTopicSegments(topicId)

  const allMessageIds = useAppSelector((state) => state.messages.messageIdsByTopic[topicId] || [])

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
  }, [getSelectedMessageIds, checkMessagesContinuous, getSegmentsForTopic, topicId, t, createSegment, dispatch])

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
        const segFirstIdx = allMessageIds.indexOf(seg.messageIds[0])
        const segLastIdx = allMessageIds.indexOf(seg.messageIds[seg.messageIds.length - 1])
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
    [mergeInfo, getSelectedMessageIds, updateSegmentMessageIds, dispatch, t]
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
    const msgIds = getSelectedMessageIds()
    if (msgIds.length === 0) return false
    if (!checkMessagesContinuous(msgIds)) return false
    const existingSegments = getSegmentsForTopic(topicId)
    const hasOverlap = msgIds.some((id) => existingSegments.some((seg) => seg.messageIds.includes(id)))
    if (hasOverlap) return false
    return true
  }, [getSelectedMessageIds, checkMessagesContinuous, getSegmentsForTopic, topicId])

  const handleRemoveFromSegment = useCallback(async () => {
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
  }, [removeFromSegmentInfo, deleteSegment, updateSegmentMessageIds, dispatch, t])

  const handleSelectAll = useCallback(() => {
    const allAskIds = groups.map((g) => g.askId)
    dispatch(setSelectedGroupIds(allAskIds))
  }, [dispatch, groups])

  const contextMenuItems: MenuProps['items'] = useMemo(() => {
    if (!isEnabled) return []

    return [
      {
        key: 'copy',
        label: t('editMode.contextMenu.copy'),
        onClick: handleCopy
      },
      {
        key: 'cut',
        label: t('editMode.contextMenu.cut'),
        onClick: handleCut
      },
      {
        key: 'paste',
        label: t('editMode.contextMenu.paste'),
        disabled: !hasClipboard,
        onClick: () => void handlePaste()
      },
      {
        key: 'delete',
        label: t('editMode.contextMenu.delete'),
        disabled: selectedGroupIds.length === 0,
        onClick: () => void handleDelete()
      },
      { type: 'divider' },
      {
        key: 'createSegment',
        label: t('topicSegment.createAction'),
        disabled: !canCreateSegment,
        onClick: handleCreateSegment
      },
      // 向上合并（选区合并到上方 segment）
      ...(mergeInfo?.upSegment
        ? [
            {
              key: 'mergeUp',
              label: t('topicSegment.mergeUp'),
              onClick: () => void handleMerge('up')
            }
          ]
        : []),
      // 向下合并（选区合并到下方 segment）
      ...(mergeInfo?.downSegment
        ? [
            {
              key: 'mergeDown',
              label: t('topicSegment.mergeDown'),
              onClick: () => void handleMerge('down')
            }
          ]
        : []),
      // 从消息组移除 / 解散消息组
      ...(removeFromSegmentInfo
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
    handlePaste,
    handleDelete,
    handleCreateSegment,
    handleMerge,
    handleRemoveFromSegment,
    handleSelectAll,
    handleUndo,
    handleRedo,
    hasClipboard,
    canUndo,
    canRedo,
    selectedGroupIds,
    mergeInfo,
    removeFromSegmentInfo,
    canCreateSegment
  ])

  if (!isEnabled) {
    return <>{children}</>
  }

  return (
    <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
      {children}
    </Dropdown>
  )
}

export default memo(EditModeContextMenu)
