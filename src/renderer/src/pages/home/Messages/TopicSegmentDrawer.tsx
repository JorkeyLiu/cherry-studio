import { useRouteScopedSegments } from '@renderer/hooks/useRouteScopedSegments'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import { Popover, type PopoverProps } from 'antd'
import { Layers } from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { COMPOSER_FLOATING_CONTROL_INSET_PX, COMPOSER_FLOATING_CONTROL_SIZE_PX } from './composerFloatingBand'

interface TopicSegmentDrawerProps {
  topicId: string
}

/**
 * Floating layer contract for this drawer.
 *
 * The composer is a positioned stacking context (`Inputbar` Container, z 2),
 * so a trigger placed inside it can never paint above the message-flow segment
 * chrome (the group header sits at z 1000 inside `#messages`, whose scroll host
 * deliberately has no z-index of its own). The trigger and its popover are
 * therefore portaled to `document.body` and given their own explicit layers
 * above the group header while staying clear of antd's modal layer range
 * (1000 + container offsets). The conversation navigation body (z 999) and the
 * group header (z 1000) keep their existing relative order — this drawer only
 * sits above both.
 */
const DRAWER_TRIGGER_Z_INDEX = 1004
const DRAWER_POPOVER_Z_INDEX = 1005

/**
 * antd forwards this override to the tooltip layer at runtime, but its public
 * props type does not declare it; the wrapper below keeps the call typed.
 */
type PopoverWithZIndexProps = PopoverProps & { zIndex?: number }
const ZIndexPopover = Popover as unknown as React.FC<PopoverWithZIndexProps>

const TopicSegmentDrawer: React.FC<TopicSegmentDrawerProps> = ({ topicId }) => {
  // Route-scoped projection of the topic-wide catalog: only the active route's
  // reachable members/counts, with 0-intersection (other-route) segments hidden.
  // The projected `firstMessageId` is always reachable on the current route, so
  // the Messages unified navigate path only needs its window complement.
  const { segments, routeKey } = useRouteScopedSegments(topicId)
  const { t } = useTranslation()

  // Live route key: a queued click whose row was rendered under a previous
  // route must not navigate the new route to an off-route member.
  const liveRouteKeyRef = useRef(routeKey)
  liveRouteKeyRef.current = routeKey

  const scrollToSegment = useCallback((firstMessageId: string | null, itemRouteKey: string) => {
    if (!firstMessageId) return
    if (liveRouteKeyRef.current !== itemRouteKey) return
    void EventEmitter.emit(EVENT_NAMES.NAVIGATE_TO_MESSAGE, firstMessageId)
  }, [])

  // In-flow measurement anchor: the floating trigger is portaled out of the
  // composer's stacking context, so it is positioned from this anchor's live
  // rect (the same spot the trigger occupied before the portal).
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [triggerBox, setTriggerBox] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (segments.length === 0) {
      setTriggerBox(null)
      return
    }
    const anchor = anchorRef.current
    if (!anchor) return
    // The anchor IS the original trigger slot (same left/bottom gap and the
    // same 24×24 box), so the portaled trigger is placed on that rect as-is:
    // applying the gap a second time here would double the spacer and drift
    // the icon right/up by that gap.
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return
      setTriggerBox({ left: rect.left, top: rect.top })
    }
    update()
    const parent = anchor.parentElement
    let observer: ResizeObserver | null = null
    if (parent && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(update)
      observer.observe(parent)
    }
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [segments.length])

  const popoverContent = useMemo(() => {
    if (segments.length === 0) return null

    return (
      <PopoverList>
        <PopoverTitle>{t('topicSegment.navigation.title')}</PopoverTitle>
        {segments.map((segment) => {
          // Folded groups are listed by their presentation state, never by the
          // hidden group name: the row is a navigation target, not a second
          // naming surface. The authority count stays visible either way.
          const label = segment.folded ? t('topicSegment.folded') : segment.name
          return (
            <PopoverItem
              key={segment.id}
              $folded={segment.folded}
              data-testid="topic-segment-drawer-row"
              data-segment-folded={segment.folded ? 'true' : 'false'}
              title={segment.folded ? segment.name : label}
              onClick={() => scrollToSegment(segment.firstMessageId, routeKey)}>
              <Dot $folded={segment.folded} $color={segment.color || getSegmentColor(segment.id)} />
              <SegmentName $folded={segment.folded}>{label}</SegmentName>
              <MessageCount>{segment.messageCount}</MessageCount>
            </PopoverItem>
          )
        })}
      </PopoverList>
    )
  }, [segments, routeKey, scrollToSegment, t])

  if (segments.length === 0) return null

  return (
    <>
      <TriggerAnchor ref={anchorRef} aria-hidden="true" />
      {triggerBox &&
        createPortal(
          <ZIndexPopover
            content={popoverContent}
            trigger={['hover', 'click']}
            placement="topLeft"
            arrow={false}
            mouseEnterDelay={0.3}
            zIndex={DRAWER_POPOVER_Z_INDEX}
            overlayInnerStyle={{ padding: '4px 0' }}>
            <TriggerWrapper $left={triggerBox.left} $top={triggerBox.top} data-testid="topic-segment-drawer-trigger">
              <Layers size={18} />
            </TriggerWrapper>
          </ZIndexPopover>,
          document.body
        )}
    </>
  )
}

// Zero-paint, hit-transparent replica of the original in-flow trigger slot:
// the `left`/`bottom` gaps come from the shared composer floating control inset
// and the box is the control's own size, so the portaled (fixed) trigger paints
// exactly where the in-flow element used to sit. It carries no paint and no
// hit area, and the same band is what the scroll content reserves as its tail
// clearance (`composerFloatingBand`).
const TriggerAnchor = styled.span`
  position: absolute;
  left: ${COMPOSER_FLOATING_CONTROL_INSET_PX}px;
  bottom: calc(100% + ${COMPOSER_FLOATING_CONTROL_INSET_PX}px);
  top: auto;
  width: ${COMPOSER_FLOATING_CONTROL_SIZE_PX}px;
  height: ${COMPOSER_FLOATING_CONTROL_SIZE_PX}px;
  pointer-events: none;
`

const TriggerWrapper = styled.div<{ $left: number; $top: number }>`
  position: fixed;
  left: ${(props) => props.$left}px;
  top: ${(props) => props.$top}px;
  z-index: ${DRAWER_TRIGGER_Z_INDEX};
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: ${COMPOSER_FLOATING_CONTROL_SIZE_PX}px;
  height: ${COMPOSER_FLOATING_CONTROL_SIZE_PX}px;
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

const PopoverTitle = styled.div`
  padding: 4px 12px 6px;
  font-size: 11px;
  color: var(--color-text-3);
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 2px;
`

const PopoverItem = styled.div<{ $folded?: boolean }>`
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

const Dot = styled.div<{ $folded?: boolean; $color: string }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: ${(props) => (props.$folded ? 'var(--color-text-3)' : props.$color)};
  flex-shrink: 0;
`

const SegmentName = styled.span<{ $folded?: boolean }>`
  font-size: 12px;
  color: ${(props) => (props.$folded ? 'var(--color-text-3)' : 'var(--color-text-1)')};
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
