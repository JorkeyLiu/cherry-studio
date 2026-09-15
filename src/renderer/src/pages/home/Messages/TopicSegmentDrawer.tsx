import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import { Popover } from 'antd'
import { Layers } from 'lucide-react'
import { memo, useCallback, useMemo } from 'react'
import styled from 'styled-components'

interface TopicSegmentDrawerProps {
  topicId: string
}

const TopicSegmentDrawer: React.FC<TopicSegmentDrawerProps> = ({ topicId }) => {
  const { orderedSegmentsForTopic } = useTopicSegments(topicId)

  // Always navigate to the segment's authoritative first message ID.
  // Window complement for targets outside the loaded projection happens in
  // the Messages unified navigate path; no window-local fallback here.
  const scrollToSegment = useCallback((firstMessageId: string | null) => {
    if (!firstMessageId) return
    void EventEmitter.emit(EVENT_NAMES.NAVIGATE_TO_MESSAGE, firstMessageId)
  }, [])

  const popoverContent = useMemo(() => {
    if (orderedSegmentsForTopic.length === 0) return null

    return (
      <PopoverList>
        {orderedSegmentsForTopic.map((segment) => (
          <PopoverItem key={segment.id} onClick={() => scrollToSegment(segment.firstMessageId)}>
            <Dot $color={segment.color || getSegmentColor(segment.id)} />
            <SegmentName>{segment.name}</SegmentName>
            <MessageCount>{segment.messageCount}</MessageCount>
          </PopoverItem>
        ))}
      </PopoverList>
    )
  }, [orderedSegmentsForTopic, scrollToSegment])

  if (orderedSegmentsForTopic.length === 0) return null

  return (
    <Popover
      content={popoverContent}
      trigger={['hover', 'click']}
      placement="topRight"
      arrow={false}
      mouseEnterDelay={0.3}
      overlayInnerStyle={{ padding: '4px 0' }}>
      <TriggerWrapper>
        <Layers size={18} />
      </TriggerWrapper>
    </Popover>
  )
}

const TriggerWrapper = styled.div`
  position: absolute;
  right: 8px;
  bottom: calc(100% + 8px);
  top: auto;
  z-index: 3;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: hsl(215, 32%, 48%);

  &:hover {
    opacity: 1;
  }

  body[theme-mode='dark'] & {
    color: hsl(215, 28%, 68%);
  }
`

const PopoverList = styled.div`
  max-height: 300px;
  overflow-y: auto;
  min-width: 160px;
`

const PopoverItem = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background-color 0.15s;

  &:hover {
    background-color: var(--color-background-soft);
  }
`

const Dot = styled.div<{ $color: string }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: ${(props) => props.$color};
  flex-shrink: 0;
`

const SegmentName = styled.span`
  font-size: 12px;
  color: var(--color-text-1);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
`

const MessageCount = styled.span`
  font-size: 11px;
  color: var(--color-text-3);
  flex-shrink: 0;
`

export default memo(TopicSegmentDrawer)
