import Scrollbar from '@renderer/components/Scrollbar'
import type { FC, KeyboardEvent } from 'react'
import React from 'react'
import styled from 'styled-components'

export interface MessageOutlineEntry {
  id: string
  text: string
}

interface MessageOutlineProps {
  entries: MessageOutlineEntry[]
  onNavigate: (id: string) => void
}

/**
 * Restored original MessageOutline presentation (styles verbatim from
 * f2b83d806c). Only the data input / locate target changed: heading entries
 * derived from assistant markdown became caller-supplied ordered USER-message
 * summary entries with stable IDs, and the DOM heading scroll became
 * onNavigate(id). Single-level list, so indicator/text levels are constant 1.
 */
const MessageOutline: FC<MessageOutlineProps> = ({ entries, onNavigate }) => {
  if (!entries.length) return null

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onNavigate(id)
    }
  }

  return (
    <MessageOutlineContainer data-testid="conversation-navigation">
      <MessageOutlineBody $count={entries.length}>
        {entries.map((entry) => (
          <MessageOutlineItem
            key={entry.id}
            onClick={() => onNavigate(entry.id)}
            onKeyDown={(event) => handleKeyDown(event, entry.id)}
            tabIndex={0}
            role="button"
            aria-label={entry.text}
            data-testid={`conversation-nav-item-${entry.id}`}
            data-message-id={entry.id}
            title={entry.text}>
            <MessageOutlineItemDot $level={1} />
            <MessageOutlineItemText $level={1} $miniLevel={1}>
              {entry.text}
            </MessageOutlineItemText>
          </MessageOutlineItem>
        ))}
      </MessageOutlineBody>
    </MessageOutlineContainer>
  )
}

const MessageOutlineContainer = styled.div`
  position: absolute;
  inset: 63px 0 36px 10px;
  z-index: 999;
  pointer-events: none;
  user-select: none;
  & ~ .message-content-container {
    padding-left: 46px !important;
  }
  & ~ .MessageFooter {
    margin-left: 46px !important;
  }
`

const MessageOutlineItemDot = styled.div<{ $level: number }>`
  width: ${({ $level }) => 16 - $level * 2}px;
  height: 4px;
  background: var(--color-border);
  border-radius: 2px;
  margin-right: 4px;
  flex-shrink: 0;
  transition: background 0.2s ease;
`

const MessageOutlineItemText = styled.div<{ $level: number; $miniLevel: number }>`
  overflow: hidden;
  color: var(--color-text-3);
  opacity: 0;
  display: none;
  transition: opacity 0.2s ease;
  padding: 2px 8px;
  padding-left: ${({ $level, $miniLevel }) => ($level - $miniLevel) * 8}px;
  font-size: ${({ $level }) => 16 - $level}px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const MessageOutlineItem = styled.div`
  height: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex-shrink: 0;
  &:hover {
    ${MessageOutlineItemText} {
      color: var(--color-text-2);
    }
    ${MessageOutlineItemDot} {
      background: var(--color-text-3);
    }
  }
`

const MessageOutlineBody = styled(Scrollbar)<{ $count: number }>`
  max-width: 50%;
  max-height: min(100%, 70vh);
  position: sticky;
  top: max(calc(50% - ${({ $count }) => ($count * 24) / 2 + 10}px), 20px);
  bottom: 0;
  overflow-x: hidden;
  overflow-y: hidden;
  display: inline-flex;
  flex-direction: column;
  padding: 10px 0 10px 10px;
  gap: 4px;
  border-radius: 10px;
  pointer-events: auto;
  &:hover {
    padding: 10px 10px 10px 10px;
    overflow-y: auto;
    background: var(--color-background);
    box-shadow: 0 0 10px 0 rgba(128, 128, 128, 0.2);
    ${MessageOutlineItemText} {
      opacity: 1;
      display: block;
    }
  }
`

export default React.memo(MessageOutline)
