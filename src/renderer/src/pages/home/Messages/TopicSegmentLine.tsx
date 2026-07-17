import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { Input, Popconfirm } from 'antd'
import { Pencil, Trash2 } from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface TopicSegmentLineProps {
  segment: TopicSegment
  isFirst: boolean
  isLast: boolean
  messageCount?: number
}

const TopicSegmentLine: React.FC<TopicSegmentLineProps> = ({ segment, isFirst, isLast, messageCount }) => {
  const { t } = useTranslation()
  const { updateSegmentName, deleteSegment } = useTopicSegments(segment.topicId)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(segment.name)
  const color = segment.color || 'var(--color-primary)'

  const handleRename = useCallback(async () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== segment.name) {
      await updateSegmentName(segment.id, trimmed)
    }
    setIsEditing(false)
  }, [editName, segment, updateSegmentName])

  const handleDissolve = useCallback(async () => {
    await deleteSegment(segment.id)
  }, [segment.id, deleteSegment])

  const handleStartEdit = useCallback(() => {
    setEditName(segment.name)
    setIsEditing(true)
  }, [segment.name])

  return (
    <LineContainer $color={color} $isFirst={isFirst} $isLast={isLast}>
      {/* 竖线 */}
      <Line $isFirst={isFirst} $isLast={isLast} $color={color} />

      {/* 首条消息处渲染标签卡 */}
      {isFirst && (
        <TabContainer $color={color}>
          <TabContent>
            {isEditing ? (
              <TabInput
                size="small"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onPressEnter={handleRename}
                onBlur={handleRename}
                autoFocus
              />
            ) : (
              <TabName onClick={handleStartEdit} title={segment.name}>
                {segment.name}
              </TabName>
            )}
            {messageCount !== undefined && (
              <TabCount>{t('topicSegment.messages.count', { count: messageCount })}</TabCount>
            )}
          </TabContent>
          <TabActions>
            <TabActionBtn onClick={handleStartEdit} title={t('topicSegment.rename')}>
              <Pencil size={12} />
            </TabActionBtn>
            <Popconfirm
              title={t('topicSegment.dissolve.confirm')}
              onConfirm={handleDissolve}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}>
              <TabActionBtn title={t('topicSegment.dissolveAction')}>
                <Trash2 size={12} />
              </TabActionBtn>
            </Popconfirm>
          </TabActions>
        </TabContainer>
      )}
    </LineContainer>
  )
}

// ─── Styled Components ───

const LineContainer = styled.div<{
  $color: string
  $isFirst: boolean
  $isLast: boolean
}>`
  position: absolute;
  left: -12px;
  top: 0;
  bottom: 0;
  width: 3px;
  z-index: 1;
  pointer-events: none;
`

const Line = styled.div<{
  $isFirst: boolean
  $isLast: boolean
  $color: string
}>`
  position: absolute;
  left: 0;
  width: 3px;
  background-color: ${(props) => props.$color};
  top: ${(props) => (props.$isFirst ? '28px' : '0')};
  bottom: ${(props) => (props.$isLast ? '12px' : '0')};
  border-radius: ${(props) => {
    if (props.$isFirst && props.$isLast) return '3px'
    if (props.$isLast) return '0 0 3px 3px'
    return '0'
  }};
`

const TabContainer = styled.div<{ $color: string }>`
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px 0 6px;
  background: ${(props) => props.$color};
  border-radius: 4px 8px 8px 4px;
  pointer-events: auto;
  white-space: nowrap;
  max-width: 280px;
`

const TabContent = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
`

const TabName = styled.span`
  font-size: 12px;
  font-weight: 500;
  color: #fff;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }
`

const TabInput = styled(Input)`
  &.ant-input-sm {
    height: 18px;
    font-size: 12px;
    padding: 0 4px;
    width: 120px;
  }
`

const TabCount = styled.span`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  flex-shrink: 0;
`

const TabActions = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;

  ${TabContainer}:hover & {
    opacity: 1;
  }
`

const TabActionBtn = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  color: rgba(255, 255, 255, 0.8);
  transition: color 0.15s;

  &:hover {
    color: #fff;
  }
`

export default memo(TopicSegmentLine)
