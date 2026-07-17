import { useSettings } from '@renderer/hooks/useSettings'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { scrollIntoView } from '@renderer/utils/dom'
import { memo, useCallback, useState } from 'react'
import styled from 'styled-components'

interface TopicSegmentNavigationProps {
  topicId: string
}

const TopicSegmentNavigation: React.FC<TopicSegmentNavigationProps> = ({ topicId }) => {
  const { segmentsForTopic } = useTopicSegments(topicId)
  const { messageNavigation } = useSettings()
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const rightOffset = messageNavigation === 'anchor' ? 40 : 13

  const scrollToSegment = useCallback((firstMessageId: string) => {
    const element = document.getElementById(`message-${firstMessageId}`)
    if (element) {
      scrollIntoView(element, { behavior: 'smooth', block: 'start', container: 'nearest' })
    }
  }, [])

  if (segmentsForTopic.length === 0) return null

  return (
    <NavigationContainer $right={rightOffset}>
      <NavigationList>
        {segmentsForTopic.map((segment) => (
          <NavigationItem
            key={segment.id}
            onMouseEnter={() => setHoveredId(segment.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => scrollToSegment(segment.messageIds[0])}>
            <Dot $color={segment.color || 'var(--color-primary)'} />
            {hoveredId === segment.id && <Label>{segment.name}</Label>}
          </NavigationItem>
        ))}
      </NavigationList>
    </NavigationContainer>
  )
}

const NavigationContainer = styled.div<{ $right: number }>`
  position: fixed;
  top: calc(50% - var(--status-bar-height) - 10px);
  right: ${(props) => props.$right}px;
  transform: translateY(-50%);
  z-index: 1;
  user-select: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
`

const NavigationList = styled.div`
  display: flex;
  flex-direction: column-reverse;
  gap: 6px;
`

const NavigationItem = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 2px 0;
  justify-content: flex-end;
  transition: opacity 0.15s;
  opacity: 0.6;

  &:hover {
    opacity: 1;
  }
`

const Dot = styled.div<{ $color: string }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: ${(props) => props.$color};
  flex-shrink: 0;
  transition: transform 0.15s;

  ${NavigationItem}:hover & {
    transform: scale(1.3);
  }
`

const Label = styled.span`
  font-size: 11px;
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
  text-align: right;
`

export default memo(TopicSegmentNavigation)
