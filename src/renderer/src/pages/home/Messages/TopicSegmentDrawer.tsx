import { useRouteScopedSegments } from '@renderer/hooks/useRouteScopedSegments'
import { useSettings } from '@renderer/hooks/useSettings'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import { Popover, type PopoverProps } from 'antd'
import { Layers } from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { COMPOSER_FLOATING_CONTROL_SIZE_PX } from './composerFloatingBand'
import { COMPOSER_OVERLAY_BOTTOM_GAP_PX } from './composerOverlayGeometry'
import { resolveTopicSegmentDrawerCanvasLeft } from './navRailGeometry'

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
  // reachable members/counts. A row is listed ONLY when the group's stable head
  // resolves inside the full current route history (`headerInRoute`): a
  // headless residual keeps its members naturally rendered in the rail but gets
  // no navigation entry. (`!== false` keeps legacy callers that predate the
  // authority overlay pass-through instead of blanking them.)
  // The navigation target is the stable head (`headerMessageId`), never the
  // first reachable member: head presence alone navigates even when the head
  // is not loaded (the unified path loads its window, settling on the fold
  // marker when the head is folded). The projected `firstMessageId` stays the
  // window complement only.
  const { segments, routeKey } = useRouteScopedSegments(topicId)
  const listedSegments = useMemo(() => segments.filter((segment) => segment.headerInRoute !== false), [segments])
  const { t } = useTranslation()

  // Live route key: a queued click whose row was rendered under a previous
  // route must not navigate the new route to an off-route head.
  const liveRouteKeyRef = useRef(routeKey)
  liveRouteKeyRef.current = routeKey

  const scrollToSegmentHead = useCallback((headerMessageId: string | null, itemRouteKey: string) => {
    if (!headerMessageId) return
    if (liveRouteKeyRef.current !== itemRouteKey) return
    void EventEmitter.emit(EVENT_NAMES.NAVIGATE_TO_MESSAGE, headerMessageId)
  }, [])

  // Rail alignment: while the navigation rail is mounted the anchor moves
  // left by the shared shift so the portaled trigger lands on the rail axis;
  // with navigation off the historical inset (and availability) is preserved.
  const { messageNavigation } = useSettings()
  const anchorLeft = resolveTopicSegmentDrawerCanvasLeft(messageNavigation)
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
  }, [listedSegments.length, anchorLeft])

  // anchorLeft above re-runs the measurement when the alignment toggles, so
  // the portaled trigger follows the anchor without a new subscription.

  const popoverContent = useMemo(() => {
    if (listedSegments.length === 0) return null

    return (
      <PopoverList>
        <PopoverTitle>{t('topicSegment.navigation.title')}</PopoverTitle>
        {listedSegments.map((segment) => {
          // Groups are listed by name: the row is a navigation target, not a
          // second naming surface. The authority count stays visible either
          // way. The click targets the stable head, never the first reachable
          // member, and carries the head id for testability.
          const label = segment.name
          const headId = segment.headerMessageId ?? segment.firstMessageId
          // Display count: the route-qualified TURN count from the projection
          // (user + same-askId answers = 1, folded and off-window included).
          // Never the catalog message count; unknown stays hidden.
          const turnCount = segment.turnCount
          return (
            <PopoverItem
              key={segment.id}
              data-testid="topic-segment-drawer-row"
              data-segment-folded="false"
              data-segment-header={segment.headerMessageId ?? ''}
              title={label}
              onClick={() => scrollToSegmentHead(headId, routeKey)}>
              <Dot $color={segment.color || getSegmentColor(segment.id)} />
              <SegmentName>{label}</SegmentName>
              {turnCount !== undefined ? <MessageCount>{turnCount}</MessageCount> : null}
            </PopoverItem>
          )
        })}
      </PopoverList>
    )
  }, [listedSegments, routeKey, scrollToSegmentHead, t])

  if (listedSegments.length === 0) return null

  return (
    <>
      <TriggerAnchor ref={anchorRef} $left={anchorLeft} aria-hidden="true" />
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
// the `bottom` gap comes from the shared composer floating control inset and
// the box is the control's own size, so the portaled (fixed) trigger paints
// exactly where the in-flow element used to sit; `left` is the shared rail
// alignment (`navRailGeometry`) while navigation is on and the historical
// inset with it off. It carries no paint and no hit area, and the same band
// is what the scroll content reserves as its tail clearance
// (`composerFloatingBand`). Vertical placement is untouched either way.
const TriggerAnchor = styled.span<{ $left: number }>`
  position: absolute;
  left: ${(props) => props.$left}px;
  bottom: ${COMPOSER_OVERLAY_BOTTOM_GAP_PX + 3}px;
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
