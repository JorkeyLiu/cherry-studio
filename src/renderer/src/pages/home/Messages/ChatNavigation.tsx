import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  HistoryOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined
} from '@ant-design/icons'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import type { RootState } from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { scrollIntoView } from '@renderer/utils/dom'
import type { IndexedMessage } from '@renderer/utils/messageUtils/filters'
import { Button, Drawer, Spin, Tooltip } from 'antd'
import type { FC } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'
import type { VirtuosoHandle } from 'react-virtuoso'
import styled from 'styled-components'

const ChatFlowHistory = lazy(() => import('./ChatFlowHistory'))

// Exclude some areas from the navigation
const EXCLUDED_SELECTORS = [
  '.MessageFooter',
  '.code-toolbar',
  '.ant-collapse-header',
  '.group-menu-bar',
  '.code-block',
  '.message-editor',
  '.table-wrapper'
]

// Gap between the navigation bar and the right element
const RIGHT_GAP = 16

interface ChatNavigationProps {
  containerId: string
  scrollToMessageById?: (messageId: string) => void
  /** Full message list for data-driven navigation (replaces DOM queries with Virtuoso) */
  messages?: Message[]
  /** Virtuoso ref for programmatic scrolling */
  virtuosoRef?: React.RefObject<VirtuosoHandle | null>
  /** Grouped messages for Virtuoso index computation */
  groupedMessages?: [string, IndexedMessage[]][]
}

const ChatNavigation: FC<ChatNavigationProps> = ({
  containerId,
  scrollToMessageById,
  messages = [],
  virtuosoRef,
  groupedMessages = []
}) => {
  const { t } = useTranslation()
  const [isVisible, setIsVisible] = useState(false)
  const timerKey = 'hide'
  const { setTimeoutTimer, clearTimeoutTimer } = useTimer()
  const [showChatHistory, setShowChatHistory] = useState(false)
  const [manuallyClosedUntil, setManuallyClosedUntil] = useState<number | null>(null)
  const currentTopicId = useSelector((state: RootState) => state.messages.currentTopicId)
  const lastMoveTime = useRef(0)
  const isHoveringNavigationRef = useRef(false)
  const isPointerInTriggerAreaRef = useRef(false)
  const stoppedAtBoundaryRef = useRef(false)
  const isProgrammaticScrollRef = useRef(false)
  const { topicPosition, showTopics } = useSettings()
  const showRightTopics = topicPosition === 'right' && showTopics

  // Data-driven: extract user message IDs from the full message list
  const userMessageIds = useMemo(() => {
    return messages.filter((m) => m.role === 'user' && m.type !== 'clear').map((m) => m.id)
  }, [messages])

  const clearHideTimer = useCallback(() => {
    clearTimeoutTimer(timerKey)
  }, [clearTimeoutTimer])

  const scheduleHide = useCallback(
    (delay: number) => {
      setTimeoutTimer(
        timerKey,
        () => {
          setIsVisible(false)
        },
        delay
      )
    },
    [setTimeoutTimer]
  )

  const showNavigation = useCallback(() => {
    if (manuallyClosedUntil && Date.now() < manuallyClosedUntil) {
      return
    }
    setIsVisible(true)
    clearHideTimer()
  }, [clearHideTimer, manuallyClosedUntil])

  // Handle mouse entering button area
  const handleNavigationMouseEnter = useCallback(() => {
    if (manuallyClosedUntil && Date.now() < manuallyClosedUntil) {
      return
    }
    isHoveringNavigationRef.current = true
    showNavigation()
  }, [manuallyClosedUntil, showNavigation])

  // Handle mouse leaving button area
  const handleNavigationMouseLeave = useCallback(() => {
    isHoveringNavigationRef.current = false
    scheduleHide(500)
  }, [scheduleHide])

  const handleChatHistoryClick = () => {
    setShowChatHistory(true)
    showNavigation()
  }

  const handleDrawerClose = () => {
    setShowChatHistory(false)
  }

  /**
   * Find the currently visible message ID by scanning rendered DOM elements.
   * With Virtuoso, only rendered items exist in the DOM, so this finds
   * the visible message among rendered items and returns its ID.
   * Only considers messages fully or mostly within the viewport (not overscan).
   */
  const findFirstVisibleMessageId = useCallback((): string | null => {
    const container = document.getElementById(containerId)
    if (!container) return null

    const containerRect = container.getBoundingClientRect()

    // Query rendered message elements (both user and assistant)
    const elements = container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')

    let closestId: string | null = null
    let minDistance = Infinity

    for (const el of elements) {
      const rect = el.getBoundingClientRect()
      if (rect.height === 0) continue

      // Only consider messages that are truly within the viewport (not overscan)
      // A message is "visible" if its center is within the container bounds
      const elementCenter = (rect.top + rect.bottom) / 2
      if (elementCenter < containerRect.top || elementCenter > containerRect.bottom) {
        continue
      }

      const distance = Math.abs(rect.top - containerRect.top)
      if (distance < minDistance) {
        minDistance = distance
        closestId = el.id.replace('message-', '')
      }
    }

    return closestId
  }, [containerId])

  /**
   * Find the index of a message ID in the userMessageIds array.
   * Returns -1 if not found.
   */
  const findUserMessageIndex = useCallback(
    (messageId: string): number => {
      return userMessageIds.indexOf(messageId)
    },
    [userMessageIds]
  )

  const scrollToTop = () => {
    if (virtuosoRef?.current && groupedMessages.length > 0) {
      // Use Virtuoso API to scroll to the very top
      virtuosoRef.current.scrollToIndex({ index: 0, align: 'start', behavior: 'smooth' })
    } else if (scrollToMessageById && userMessageIds.length > 0) {
      // Fallback: scroll to the first user message
      scrollToMessageById(userMessageIds[0])
    } else {
      const container = document.getElementById(containerId)
      container && container.scrollTo({ top: -container.scrollHeight, behavior: 'smooth' })
    }
  }

  const scrollToBottom = () => {
    if (virtuosoRef?.current && groupedMessages.length > 0) {
      // Use Virtuoso API to scroll to the very bottom
      virtuosoRef.current.scrollToIndex({ index: groupedMessages.length - 1, align: 'end', behavior: 'smooth' })
    } else if (scrollToMessageById && userMessageIds.length > 0) {
      // Fallback: scroll to the last user message
      scrollToMessageById(userMessageIds[userMessageIds.length - 1])
    } else {
      const container = document.getElementById(containerId)
      container && container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
    }
  }

  // 修改 handleCloseChatNavigation 函数
  const handleCloseChatNavigation = () => {
    setIsVisible(false)
    isHoveringNavigationRef.current = false
    isPointerInTriggerAreaRef.current = false
    clearHideTimer()
    // 设置手动关闭状态，1分钟内不响应鼠标靠近事件
    setManuallyClosedUntil(Date.now() + 60000) // 60000毫秒 = 1分钟
  }

  const handleScrollToTop = () => {
    showNavigation()

    if (!stoppedAtBoundaryRef.current) {
      const container = document.getElementById(containerId)
      const divider = container?.querySelector('[data-context-boundary]') as HTMLElement | null

      if (divider) {
        isProgrammaticScrollRef.current = true
        scrollIntoView(divider, { behavior: 'smooth', block: 'start', container: 'nearest' })
        stoppedAtBoundaryRef.current = true
        setTimeout(() => {
          isProgrammaticScrollRef.current = false
        }, 1000)
        return
      }
    }

    stoppedAtBoundaryRef.current = false
    scrollToTop()
  }

  const handleScrollToBottom = () => {
    showNavigation()
    scrollToBottom()
  }

  const handleNextMessage = () => {
    showNavigation()

    if (userMessageIds.length === 0) {
      return scrollToBottom()
    }

    const currentVisibleId = findFirstVisibleMessageId()
    if (!currentVisibleId) {
      // No visible message found, scroll to last user message (newest)
      return scrollToMessageById?.(userMessageIds[userMessageIds.length - 1])
    }

    const currentIndex = findUserMessageIndex(currentVisibleId)

    if (currentIndex === -1) {
      // Current visible message is not a user message; find the nearest newer user message
      const currentMsgIndex = messages.findIndex((m) => m.id === currentVisibleId)
      if (currentMsgIndex >= 0) {
        // Find the next user message (newer = higher index in messages)
        for (let i = currentMsgIndex + 1; i < messages.length; i++) {
          if (messages[i].role === 'user' && messages[i].type !== 'clear') {
            return scrollToMessageById?.(messages[i].id)
          }
        }
      }
      return
    }

    // Navigate to the next user message (newer = higher index in userMessageIds)
    // userMessageIds is ordered from oldest to newest
    // "Next" (下/ArrowDown) means going DOWN in the conversation (to newer messages)
    const targetIndex = currentIndex + 1
    if (targetIndex >= userMessageIds.length) {
      return
    }

    scrollToMessageById?.(userMessageIds[targetIndex])
  }

  const handlePrevMessage = () => {
    showNavigation()

    if (userMessageIds.length === 0) {
      return scrollToTop()
    }

    const currentVisibleId = findFirstVisibleMessageId()
    if (!currentVisibleId) {
      // No visible message found, scroll to first user message (oldest)
      return scrollToMessageById?.(userMessageIds[0])
    }

    const currentIndex = findUserMessageIndex(currentVisibleId)

    if (currentIndex === -1) {
      // Current visible message is not a user message; find the nearest older user message
      const currentMsgIndex = messages.findIndex((m) => m.id === currentVisibleId)
      if (currentMsgIndex >= 0) {
        // Find the previous user message (older = lower index in messages)
        for (let i = currentMsgIndex - 1; i >= 0; i--) {
          if (messages[i].role === 'user' && messages[i].type !== 'clear') {
            return scrollToMessageById?.(messages[i].id)
          }
        }
      }
      return
    }

    // Navigate to the previous user message (older = lower index in userMessageIds)
    // "Prev" (上/ArrowUp) means going UP in the conversation (to older messages)
    const targetIndex = currentIndex - 1
    if (targetIndex < 0) {
      return
    }

    scrollToMessageById?.(userMessageIds[targetIndex])
  }

  // Set up scroll event listener and mouse position tracking
  useEffect(() => {
    const container = document.getElementById(containerId)
    const messagesContainer = container?.closest('.messages-container') as HTMLElement

    if (!container) return

    // Handle scroll events on the container
    const handleScroll = () => {
      // Reset boundary stop state on user-initiated scroll
      if (!isProgrammaticScrollRef.current) {
        stoppedAtBoundaryRef.current = false
      }

      // Only show buttons when scrolling if cursor is in trigger area or hovering navigation
      if (isPointerInTriggerAreaRef.current || isHoveringNavigationRef.current) {
        showNavigation()
      }
    }

    // Throttled mouse move handler to improve performance
    const handleMouseMove = (e: MouseEvent) => {
      // 如果在手动关闭期间，不响应鼠标移动事件
      if (manuallyClosedUntil && Date.now() < manuallyClosedUntil) {
        return
      }

      // Throttle mouse move to every 50ms for performance
      const now = Date.now()
      if (now - lastMoveTime.current < 50) return
      lastMoveTime.current = now

      // Calculate if the mouse is in the trigger area
      const triggerWidth = 60 // Same as the width in styled component

      // Safe way to calculate position when using calc expressions
      let rightOffset = RIGHT_GAP // Default right offset
      if (showRightTopics) {
        // When topics are shown on right, we need to account for topic list width
        rightOffset += 275 // --topic-list-width
      }

      const rightPosition = window.innerWidth - rightOffset - triggerWidth
      const topPosition = window.innerHeight * 0.35 // 35% from top
      const height = window.innerHeight * 0.3 // 30% of window height

      const target = e.target as HTMLElement
      const isInExcludedArea = EXCLUDED_SELECTORS.some((selector) => target.closest(selector))

      const isInTriggerArea =
        !isInExcludedArea &&
        e.clientX > rightPosition &&
        e.clientX < rightPosition + triggerWidth + RIGHT_GAP &&
        e.clientY > topPosition &&
        e.clientY < topPosition + height
      // Update proximity state based on mouse position
      if (isInTriggerArea) {
        if (!isPointerInTriggerAreaRef.current) {
          isPointerInTriggerAreaRef.current = true
          showNavigation()
        }
      } else if (isPointerInTriggerAreaRef.current) {
        isPointerInTriggerAreaRef.current = false
        if (!isHoveringNavigationRef.current) {
          scheduleHide(500)
        }
      }
    }

    // Use passive: true for better scroll performance
    container.addEventListener('scroll', handleScroll, { passive: true })

    // Track pointer position globally so we still detect exits after leaving the chat area
    window.addEventListener('mousemove', handleMouseMove)
    const handleMessagesMouseLeave = () => {
      if (!isHoveringNavigationRef.current) {
        isPointerInTriggerAreaRef.current = false
        scheduleHide(500)
      }
    }
    messagesContainer?.addEventListener('mouseleave', handleMessagesMouseLeave)

    return () => {
      container.removeEventListener('scroll', handleScroll)
      window.removeEventListener('mousemove', handleMouseMove)
      messagesContainer?.removeEventListener('mouseleave', handleMessagesMouseLeave)
      clearHideTimer()
    }
  }, [containerId, showRightTopics, manuallyClosedUntil, scheduleHide, showNavigation, clearHideTimer])

  return (
    <>
      <NavigationContainer
        $isVisible={isVisible}
        onMouseEnter={handleNavigationMouseEnter}
        onMouseLeave={handleNavigationMouseLeave}>
        <ButtonGroup $isVisible={isVisible}>
          <Tooltip title={t('chat.navigation.close')} placement="left" mouseEnterDelay={0.5}>
            <NavigationButton
              type="text"
              icon={<CloseOutlined />}
              onClick={handleCloseChatNavigation}
              aria-label={t('chat.navigation.close')}
            />
          </Tooltip>
          <Divider />
          <Tooltip title={t('chat.navigation.top')} placement="left" mouseEnterDelay={0.5}>
            <NavigationButton
              type="text"
              icon={<VerticalAlignTopOutlined />}
              onClick={handleScrollToTop}
              aria-label={t('chat.navigation.top')}
            />
          </Tooltip>
          <Divider />
          <Tooltip title={t('chat.navigation.prev')} placement="left" mouseEnterDelay={0.5}>
            <NavigationButton
              type="text"
              icon={<ArrowUpOutlined />}
              onClick={handlePrevMessage}
              aria-label={t('chat.navigation.prev')}
            />
          </Tooltip>
          <Divider />
          <Tooltip title={t('chat.navigation.next')} placement="left" mouseEnterDelay={0.5}>
            <NavigationButton
              type="text"
              icon={<ArrowDownOutlined />}
              onClick={handleNextMessage}
              aria-label={t('chat.navigation.next')}
            />
          </Tooltip>
          <Divider />
          <Tooltip title={t('chat.navigation.bottom')} placement="left" mouseEnterDelay={0.5}>
            <NavigationButton
              type="text"
              icon={<VerticalAlignBottomOutlined />}
              onClick={handleScrollToBottom}
              aria-label={t('chat.navigation.bottom')}
            />
          </Tooltip>
          <Divider />
          <Tooltip title={t('chat.navigation.history')} placement="left" mouseEnterDelay={0.5}>
            <NavigationButton
              type="text"
              icon={<HistoryOutlined />}
              onClick={handleChatHistoryClick}
              aria-label={t('chat.navigation.history')}
            />
          </Tooltip>
        </ButtonGroup>
      </NavigationContainer>

      <Drawer
        title={t('chat.history.title')}
        placement="right"
        onClose={handleDrawerClose}
        open={showChatHistory}
        width={680}
        destroyOnHidden
        styles={{
          header: { border: 'none' },
          body: {
            padding: 0,
            height: 'calc(100% - 55px)'
          }
        }}>
        <Suspense
          fallback={
            <Spin
              size="large"
              style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}
            />
          }>
          <ChatFlowHistory conversationId={currentTopicId || undefined} />
        </Suspense>
      </Drawer>
    </>
  )
}

interface NavigationContainerProps {
  $isVisible: boolean
}

const NavigationContainer = styled.div<NavigationContainerProps>`
  position: fixed;
  right: ${RIGHT_GAP}px;
  top: 50%;
  transform: translateY(-50%) translateX(${(props) => (props.$isVisible ? '0' : '32px')});
  z-index: 999;
  opacity: ${(props) => (props.$isVisible ? 1 : 0)};
  transition:
    transform 0.3s ease-in-out,
    opacity 0.3s ease-in-out;
  pointer-events: ${(props) => (props.$isVisible ? 'auto' : 'none')};
`

interface ButtonGroupProps {
  $isVisible: boolean
}

const ButtonGroup = styled.div<ButtonGroupProps>`
  display: flex;
  flex-direction: column;
  background: var(--bg-color);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  backdrop-filter: ${(props) => (props.$isVisible ? 'blur(8px)' : 'blur(0px)')};
  border: 1px solid var(--color-border);
  transition:
    backdrop-filter 0.25s ease-in-out,
    background 0.25s ease-in-out;
`

const NavigationButton = styled(Button)`
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0;
  border: none;
  color: var(--color-text);
  transition: all 0.2s ease-in-out;

  &:hover {
    background-color: var(--color-hover);
    color: var(--color-primary);
  }

  .anticon {
    font-size: 14px;
  }
`

const Divider = styled.div`
  height: 1px;
  background: var(--color-border);
  margin: 0;
`

export default ChatNavigation
