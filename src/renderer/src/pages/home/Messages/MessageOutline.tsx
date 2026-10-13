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
 * MessageOutline presentation restored from f2b83d806c with an approved
 * compact size fix: text is a fixed 13px (was $level-derived 15px at
 * level 1) and the body is capped at max-width min(320px, calc(100% - 24px))
 * / max-height min(100%, 45vh, 420px) (was 50% / min(100%, 70vh)).
 * The body is vertically centered in the chat reading area by pure CSS flex
 * layout on the container (align-items center over the full reading height),
 * never by a per-count estimated top offset, JS measurement, ResizeObserver,
 * or transform. Row height (24px), gaps (body 4px, dot-text 8px), DOM,
 * positioning, hover expand, single-line ellipsis, trigger area and
 * navigation behavior stay unchanged. $level props stay because dot
 * size/padding still use them.
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
      <MessageOutlineBody>
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
  inset: 0 0 0 10px;
  z-index: 999;
  pointer-events: none;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: flex-start;
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
  font-size: 13px;
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

const MessageOutlineBody = styled(Scrollbar)`
  max-width: min(320px, calc(100% - 24px));
  max-height: min(100%, 45vh, 420px);
  align-self: center;
  flex: 0 1 auto;
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
