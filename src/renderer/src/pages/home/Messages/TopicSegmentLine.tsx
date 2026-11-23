import { loggerService } from '@logger'
import { ConfirmPopover, getConfirmPopoverStyleParts } from '@renderer/components/ConfirmPopover'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import { Button, Dropdown, Input, type InputRef, type MenuProps, Popover, type PopoverProps } from 'antd'
// The same design-token entry the shared popover standard uses: reading it here
// keeps the rename popover on one theme source instead of a second token path.
import antdTheme from 'antd/es/theme'
import { Pencil, Trash2 } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { styled } from 'styled-components'

import {
  INTERACTION_RAIL_LINE_WIDTH_PX,
  INTERACTION_RAIL_OUTSET_PX,
  InteractionRailHitTarget,
  InteractionRailLine
} from './GroupInteractionRail'
import {
  bubbleMinPx,
  genericBubbleCapPx,
  PAIRED_AXIS_FIXED_PX,
  PAIRED_GROUP_GAP_PX,
  resolvePairedWidths
} from './pairedGroupSizing'
import { usePairedReadingMin } from './pairedReadingMinContext'
import { INTERACTION_REGION_SEGMENT_HEADER } from './routeViewportContext'
import {
  SEGMENT_GROUP_HEADER_HEIGHT_PX,
  SEGMENT_GROUP_PILL_BAND_TOP_PX,
  SEGMENT_GROUP_PILL_HEIGHT_PX,
  SEGMENT_GROUP_PILL_LEFT_PX,
  SEGMENT_GROUP_PILL_MAX_W_PX,
  SEGMENT_GROUP_RAIL_TOP_PX,
  useSegmentGroupGeometry
} from './SegmentGroupPresentation'

const logger = loggerService.withContext('TopicSegmentLine')
/**
 * Group action surfaces (rename / dissolve) — ONE anchored popover family.
 *
 * They are antd overlays that paint into the body and paint NO mask or
 * backdrop: the rename is a `Popover`, and every confirmation is the app's
 * shared `ConfirmPopover` standard (an `antd` Popconfirm wrapper). A centered
 * modal would interrupt reading for a group-level edit and, worse, could not
 * follow the point the user acted on once the header row has scrolled out of
 * the scrollport.
 *
 * Anchor contract — ONE anchor kind, ONE pin (`GroupActionPin`), one popup
 * library, no second popup system:
 * - The header's own controls never open a menu-sourced popup: the group name
 *   and the hover pencil rename INLINE, inside the pill itself (one compact
 *   input replaces the name, focused with its name selected), and the header
 *   trash keeps its own BUTTON-anchored confirmation — the shared
 *   `ConfirmPopover` standard, uncontrolled and triggered by that button, with
 *   the library's default direction arrow.
 * - A group-menu action (rename / dissolve) opens its compact surface in the
 *   region the user already knows: ABOVE the WHOLE context menu it was chosen
 *   from, `8px` clear of it, with its left edge just right of the group's rail.
 *   The menu is a portal that unmounts with the click, so its whole box is read
 *   synchronously in the item handler, before that unmount; the group's
 *   right-click point is only the fallback when no menu box is reachable.
 *   The surface keeps its LEFT direction arrow, and that arrow points at the
 *   group RAIL: the pin is a `1px` point ON the rail line, and the placement
 *   family (`rightBottom` above the menu, `rightTop` below it) makes the
 *   library put the arrow on the surface's left edge, `16px` in from the
 *   anchored edge (its centre, measured). So the arrow always points at the
 *   rail — never at a menu row that no longer exists, and never at empty space
 *   beside the surface.
 *
 * The captured viewport point is rebased into the group's own positioned header
 * row, so the surface stays exactly where the user acted even while that row is
 * offscreen, and a transformed ancestor cannot displace it.
 */

/** Clearance between a menu-sourced surface and the WHOLE menu it belongs to. */
const GROUP_ACTION_MENU_GAP_PX = 8
/**
 * Distance from the pin to the surface's left edge. The pin is `1px` wide and
 * the surface is offset by `GROUP_ACTION_RAIL_GAP_PX - 1`, so the surface's left
 * edge lands `13px` right of the rail: exactly the room the arrow's own `12px`
 * body needs to sit between the rail and the surface.
 */
const GROUP_ACTION_RAIL_GAP_PX = 13
/**
 * Where the library actually paints the arrow's CENTRE, measured in from the
 * surface's anchored edge: the `right*` placements pin the `16px` arrow box
 * `8px` inside that edge, so its centre sits `8 + 16/2 = 16px` in. This is a
 * measurement of the rendered arrow (both sides were read at `16px`), not an
 * assumption, and it is what makes the boundary clamp below honest: the side
 * is chosen by where the arrow will REALLY point.
 */
const GROUP_ACTION_ARROW_INSET_PX = 16
/**
 * Upper bound of a compact surface's height. A side that cannot hold it is not
 * chosen, so the surface never opens into a region smaller than a compact
 * surface (the real height stays the popup library's business: nothing here
 * measures or fixes it).
 */
const GROUP_ACTION_SURFACE_RESERVE_PX = 140
/**
 * Preferred rename width: as wide as the user's own rectangle over the whole
 * group menu (one line of input reads as part of the menu, not as a detached
 * box). It sits INSIDE the shared compact-popup bounds
 * (`getConfirmPopoverStyleParts`), so a small window still clamps it.
 */
const GROUP_ACTION_PANEL_WIDTH_PX = 308
/**
 * Placement of a menu-sourced surface, per side. The `right*` family is what
 * keeps the arrow on the surface's LEFT edge
 * (`ant-popover-placement-right*` paints `.ant-popover-arrow` at `left: 0`,
 * `translateX(-100%)`, `rotate(-90deg)` — a left-pointing arrow sticking out of
 * the left edge), and the corner nearest the whole menu is the anchored one:
 * `rightBottom` above the menu, `rightTop` below it.
 */
const GROUP_ACTION_SURFACE_PLACEMENT_ABOVE = 'rightBottom' as const
const GROUP_ACTION_SURFACE_PLACEMENT_BELOW = 'rightTop' as const
/**
 * Direction arrow of a menu-sourced surface: centred on the anchored point.
 *
 * The library derives the `ant-popover-placement-*` class from the alignment
 * POINTS it ends up with, and that class is what paints the direction arrow on
 * an edge. `pointAtCenter` switches the built-in placement points to the
 * centre-right of the pin (`['bl','cr']` / `['tl','cr']`), so the anchored
 * corner stays the pin's own centre-right — the same geometry — while the
 * placement class (and therefore the left-pointing arrow) is kept. Passing
 * those points as a custom `align.points` instead would leave the library with
 * no matching placement, so no arrow is painted at all.
 */
const GROUP_ACTION_ARROW: PopoverProps['arrow'] = { pointAtCenter: true }
/**
 * Alignment of a menu-sourced surface.
 *
 * `offset` is the only thing added on top of the built-in `right*` placement:
 * the pin is `1px` wide, so the surface's left edge lands `13px` right of the
 * rail — the arrow's own body plus a hairline. The points are NOT overridden
 * (see `GROUP_ACTION_ARROW`), which keeps the surface's anchored corner at the
 * pin's centre-right: its `bottom` is the anchored edge above the menu (its
 * `top` the anchored edge below it), so the rectangle is decided by the
 * captured menu box alone and never jumps while the surface opens.
 * `adjustX: false` is load-bearing: the library's horizontal flip would move
 * the surface to the LEFT of the pin, and its arrow would then point right, at
 * nothing. `shiftX` still clamps the surface inside the viewport, and `shiftY`
 * is the last resort of a window too short for either side.
 */
const GROUP_ACTION_ALIGN_ABOVE: PopoverProps['align'] = {
  offset: [GROUP_ACTION_RAIL_GAP_PX - 1, 0],
  overflow: { adjustX: false, adjustY: false, shiftX: true, shiftY: true }
}
const GROUP_ACTION_ALIGN_BELOW: PopoverProps['align'] = {
  offset: [GROUP_ACTION_RAIL_GAP_PX - 1, 0],
  overflow: { adjustX: false, adjustY: false, shiftX: true, shiftY: true }
}

/** The group rail's painted line, in viewport px. */
interface RailSpan {
  /** The rail line's x: what the surface's left arrow points at. */
  x: number
  top: number
  bottom: number
}

/**
 * One captured group-menu anchor: a virtual pin ON the group rail.
 *
 * `x`/`y` are the pin in capture space (viewport px; rebased into the group
 * header row by the caller). `y` is the surface's ANCHORED edge — the whole
 * menu's top edge `8px` up for a surface above the menu, the menu's bottom edge
 * `8px` down for a surface below it — and `side` records which of the two it is:
 * that is what selects the placement family and therefore which corner of the
 * surface the arrow sits at.
 */
interface GroupMenuActionAnchor {
  x: number
  y: number
  side: 'above' | 'below'
}

/** The pin's parked position while no anchor is captured. */
const GROUP_MENU_PIN_PARKED: GroupMenuActionAnchor = { x: 0, y: 0, side: 'above' }

const safeRectOf = (element: HTMLElement | null): DOMRect | null => {
  if (!element) return null
  try {
    const rect = element.getBoundingClientRect()
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return null
    return rect
  } catch {
    return null
  }
}

/**
 * The rail's span, when the rail is mounted AND has been measured: a zero-height
 * rail (first render, a group with no mounted members) is not a line to point at
 * yet, and the surface falls back to the plain room/edge rule.
 */
const railSpanOf = (element: HTMLElement | null): RailSpan | null => {
  const rect = safeRectOf(element)
  if (!rect || rect.height < 1) return null
  return { x: Math.round(rect.left), top: rect.top, bottom: rect.bottom }
}

/** Where a surface on `side` paints its arrow, in viewport px. */
const arrowTargetOf = (menuTop: number, menuBottom: number, side: 'above' | 'below'): number =>
  side === 'above'
    ? menuTop - GROUP_ACTION_MENU_GAP_PX - GROUP_ACTION_ARROW_INSET_PX
    : menuBottom + GROUP_ACTION_MENU_GAP_PX + GROUP_ACTION_ARROW_INSET_PX

/**
 * Which side of the whole menu the surface opens on.
 *
 * The region above the menu is the one the user knows, so it wins whenever it
 * can hold a compact surface. Two constraints refine it:
 * - a viewport too short for the preferred side falls to the other one, and a
 *   viewport too short for both keeps the larger of the two;
 * - the arrow must point at the RAIL, never at empty space above or below the
 *   line. When the preferred side would point its arrow past the rail's span
 *   (a menu opened at the pill, where the rail only starts below it) and the
 *   other side both fits and points at the rail, the other side is used — that
 *   is the boundary clamp, and the arrow keeps a meaningful target either way.
 */
const menuSideFor = (menuTop: number, menuBottom: number, rail: RailSpan | null): 'above' | 'below' => {
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
  const aboveRoom = menuTop - GROUP_ACTION_MENU_GAP_PX
  const belowRoom = viewportHeight - menuBottom - GROUP_ACTION_MENU_GAP_PX
  const fits = (side: 'above' | 'below') =>
    (side === 'above' ? aboveRoom : belowRoom) >= GROUP_ACTION_SURFACE_RESERVE_PX
  let preferred: 'above' | 'below'
  if (fits('above')) preferred = 'above'
  else if (fits('below')) preferred = 'below'
  else preferred = aboveRoom >= belowRoom ? 'above' : 'below'
  if (!rail) return preferred
  const other = preferred === 'above' ? 'below' : 'above'
  const pointsAtRail = (side: 'above' | 'below') => {
    const target = arrowTargetOf(menuTop, menuBottom, side)
    return target >= rail.top && target <= rail.bottom
  }
  if (!pointsAtRail(preferred) && fits(other) && pointsAtRail(other)) return other
  return preferred
}

/**
 * The rc-menu click payload antd hands an item's `onClick`. Only the DOM event
 * is used; typed here so the handler needs no dependency on a portal library.
 */
interface GroupMenuClickInfo {
  domEvent?: { currentTarget?: EventTarget | null; target?: EventTarget | null } | null
}

/** The antd menu row element a click landed on, when one is reachable. */
const menuRowOf = (info?: GroupMenuClickInfo): HTMLElement | null => {
  const domEvent = info?.domEvent ?? null
  const currentTarget = domEvent?.currentTarget ?? null
  if (currentTarget && typeof (currentTarget as HTMLElement).closest === 'function') {
    const row = (currentTarget as HTMLElement).closest('.ant-dropdown-menu-item')
    if (row) return row as HTMLElement
    // A menu item root IS the row; keep it when the class is stripped (tests,
    // theme overrides) instead of dropping the only stable anchor available.
    return currentTarget as HTMLElement
  }
  const target = domEvent?.target ?? null
  if (target && typeof (target as HTMLElement).closest === 'function') {
    return ((target as HTMLElement).closest('.ant-dropdown-menu-item') as HTMLElement | null) ?? null
  }
  return null
}

/**
 * The menu LIST (`.ant-dropdown-menu`) that owns a clicked row: the whole
 * visible context-menu box the user chose from, not just the one row. The row
 * itself is kept as the fallback box when the class is stripped (tests, theme
 * overrides), so a click never loses its anchor.
 */
const menuBoxOf = (row: HTMLElement | null): HTMLElement | null => {
  if (!row) return null
  if (typeof row.closest !== 'function') return row
  return (row.closest('.ant-dropdown-menu') as HTMLElement | null) ?? row
}

/**
 * The whole viewport box of the context menu a click landed on: the group action
 * surfaces relate to the WHOLE menu, never to one row inside it.
 */
interface GroupMenuBox {
  top: number
  bottom: number
}

const menuBoxFor = (info: GroupMenuClickInfo | undefined): GroupMenuBox | null => {
  const rect = safeRectOf(menuBoxOf(menuRowOf(info)))
  if (!rect) return null
  return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) }
}

/**
 * Anchor a group-menu action ON the group rail, beside the WHOLE menu it was
 * chosen from.
 *
 * The surface keeps the region the user already knows — above the whole menu,
 * `8px` clear — but its arrow points at the rail instead of at a menu that has
 * vanished. `y` is the anchored edge of that surface and `x` is the rail's own
 * line (see `GroupMenuActionAnchor`), so the `1px` pin sits ON the rail and the
 * surface opens to its right with the arrow between them.
 *
 * The rail, not the menu, decides `x`: a group action is always an action on the
 * group's edge, so even an invocation whose menu box is gone keeps pointing at
 * the same line. `fallback` (the group's own right-click point) only supplies a
 * vertical gesture position when no whole-menu box is reachable.
 */
const actionAnchorAt = (
  box: GroupMenuBox | null,
  options: { rail: RailSpan | null; fallback: { x: number; y: number } | null }
): GroupMenuActionAnchor | null => {
  const menuTop = box ? box.top : (options.fallback?.y ?? null)
  const menuBottom = box ? box.bottom : (options.fallback?.y ?? null)
  if (menuTop === null || menuBottom === null) return null
  const x = options.rail?.x ?? options.fallback?.x ?? null
  if (x === null) return null
  const side = menuSideFor(menuTop, menuBottom, options.rail)
  const y = side === 'above' ? menuTop - GROUP_ACTION_MENU_GAP_PX : menuBottom + GROUP_ACTION_MENU_GAP_PX
  return { x, y, side }
}

/**
 * Placement of a captured anchor: the `right*` family, which is what paints the
 * arrow on the surface's LEFT edge, with the corner nearest the whole menu as
 * the anchored one. A parked anchor (nothing captured yet) keeps the
 * above-the-menu shape.
 */
const menuSurfaceOf = (anchor: GroupMenuActionAnchor) =>
  anchor.side === 'below'
    ? { placement: GROUP_ACTION_SURFACE_PLACEMENT_BELOW, align: GROUP_ACTION_ALIGN_BELOW }
    : { placement: GROUP_ACTION_SURFACE_PLACEMENT_ABOVE, align: GROUP_ACTION_ALIGN_ABOVE }

/**
 * Invisible `1px` pin of one group-menu action surface, placed ON the group rail.
 *
 * The popup must stay beside the captured interaction point even when the
 * group's header row is scrolled out of the scrollport, so the pin is placed in
 * the group header row's own coordinate space from a viewport point captured at
 * click time. `absolute` inside that positioned row (rather than `fixed`) keeps
 * the placement immune to a transformed ancestor silently becoming the
 * containing block.
 *
 * The pin IS the rail's line: its `x` is the rail's own left edge and its `y`
 * is the surface's anchored edge (the whole menu's top edge `8px` up, or its
 * bottom edge `8px` down). The `right*` placement family puts the surface's
 * anchored corner at the pin's center-right, so the surface opens to the RIGHT
 * of the rail with its arrow on its own left edge — the arrow points at the
 * line, `16px` in from the corner nearest the menu, and never at a menu row that
 * no longer exists.
 *
 * The element is also the overlay's TRIGGER child, so it must be a real DOM node
 * that forwards its ref: the popup library measures this node to place the
 * surface, and a component that swallowed the ref would leave the surface at its
 * hidden pre-align position.
 */
const GroupActionPin: React.FC<
  {
    anchor: GroupMenuActionAnchor
    testId: string
    ref?: React.Ref<HTMLSpanElement>
  } & React.HTMLAttributes<HTMLSpanElement>
> = ({ anchor, testId, style, ref, ...rest }) => (
  <span
    {...rest}
    ref={ref}
    aria-hidden="true"
    data-testid={testId}
    data-anchor-side={anchor.side}
    style={{
      ...style,
      // `absolute` (not `fixed`): this pin lives inside the group's OWN
      // positioned header row, which is the containing block. `fixed` would
      // resolve against any transformed ancestor instead (a chat message
      // container uses `transform`/`will-change` for its own layout work), and
      // the pin would then land far from the captured interaction point.
      position: 'absolute',
      left: anchor.x,
      top: anchor.y,
      width: 1,
      height: 1,
      padding: 0,
      margin: 0,
      border: 0,
      opacity: 0,
      pointerEvents: 'none'
    }}
  />
)

/**
 * Compact rename surface: one-line input plus the app's own action wording.
 * Enter confirms, Escape cancels, the input takes focus on open, and an
 * unchanged or blank draft is dropped by the caller (no write).
 */
const SegmentRenameForm: React.FC<{
  initialName: string
  onConfirm: (draft: string) => void
  onCancel: () => void
}> = ({ initialName, onConfirm, onCancel }) => {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(initialName)
  const inputRef = useRef<InputRef>(null)
  const hasInteractedRef = useRef(false)

  const focusAndSelect = useCallback(() => {
    if (hasInteractedRef.current) return
    const input = inputRef.current
    if (!input) return
    input.focus({ cursor: 'all' })
    input.select()
  }, [])

  useLayoutEffect(() => {
    focusAndSelect()
  }, [focusAndSelect])

  useEffect(() => {
    focusAndSelect()
    const rafId = requestAnimationFrame(focusAndSelect)
    const timerId = setTimeout(focusAndSelect, 50)
    return () => {
      cancelAnimationFrame(rafId)
      clearTimeout(timerId)
    }
  }, [focusAndSelect])

  return (
    // Escape is owned by the surface, not by the input alone: the action
    // buttons are reachable before the next keystroke, and cancelling must
    // never write.
    <RenameSurface
      data-testid="topic-segment-rename-surface"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}>
      <Input
        ref={inputRef}
        autoFocus
        size="small"
        value={draft}
        onChange={(e) => {
          hasInteractedRef.current = true
          setDraft(e.target.value)
        }}
        onFocus={(e) => {
          if (!hasInteractedRef.current) {
            e.target.select()
          }
        }}
        onPressEnter={() => onConfirm(draft)}
        onKeyDown={() => {
          hasInteractedRef.current = true
        }}
        onMouseDown={() => {
          hasInteractedRef.current = true
        }}
        placeholder={t('topicSegment.create.namePlaceholder')}
        data-testid="topic-segment-rename-input"
      />
      <RenameActions>
        <Button size="small" onClick={onCancel} data-testid="topic-segment-rename-cancel">
          {t('common.cancel')}
        </Button>
        <Button size="small" type="primary" onClick={() => onConfirm(draft)} data-testid="topic-segment-rename-confirm">
          {t('common.confirm')}
        </Button>
      </RenameActions>
    </RenameSurface>
  )
}

interface TopicSegmentLineProps {
  // The one owning group of this mounted flow (presentation facts only).
  segment: TopicSegment
  // Main route-qualified entry for this group on the CURRENT route (same
  // source the drawer lists): the ONLY mutation-authority input. Absent
  // (unqualified/pending, or no reachable member) gates fail-closed to
  // read-only. Never a raw catalog owner compare. Read and navigation stay
  // available on every route (see canNavigateGroup); only mutation is gated.
  routeSegment?: RouteScopedSegment | null
  // The group's authority first message is inside the mounted window.
  isFirst: boolean
  // The group's authority last message is inside the mounted window.
  isLast: boolean
  // Legacy structural size (catalog message count). Kept for callers that
  // still pass it; the header badge no longer reads it.
  messageCount?: number
  // Display count for the header badge: the route-qualified TURN count from
  // the route projection (user + same-askId answers = 1, folded and
  // off-window members included). Kept separate from the authority entry so
  // a pending/null routeSegment never falls back to the catalog message
  // count — unknown stays hidden. Wired from the layout chrome's turnCount
  // (the display route entry); Messages passes the display entry through.
  turnCount?: number
}
/**
 * Topic-segment group boundary — the group's OWN presentation owner.
 *
 * This component is rendered exactly ONCE per mounted group, by the group's
 * elected header run (see messageEditSelectionLayout). It owns the group's
 * whole boundary as one entity, independent of how many turn runs carry the
 * group and of how the selection composition chunks them:
 *
 * - **One in-flow header row.** The header occupies a normally-flowed row
 *   (`32px`: the existing `24px` label pill + an `8px` gap) in BOTH presentation
 *   states, inside the stable run host that already survives fold/expand and
 *   edit mode. Adjacent groups therefore always have adjacent header rows —
 *   they can never overlap, and a collapsed group no longer stacks its label on
 *   a neighbouring group's seam.
 * - **One continuous rail.** The rail is ONE absolutely positioned overlay
 *   inside that header row, spanning from the header down to the group's last
 *   mounted run (measured by the shared group layout manager, which owns one
 *   ResizeObserver for every group in the flow). It covers the group's internal
 *   divider heights, so the group edge is a single unbroken line rather than a
 *   mark per run — and the same element is the single interaction surface.
 * - **One interaction surface and one menu.** The rail's transparent `8px`
 *   hit target collapses the group through the one shared DB-first fold write
 *   (`runFoldWrite`, which arms the group's `segment-header` region before the
 *   mutation); a right click anywhere on the group edge (rail or pill) opens the
 *   SAME group menu ANCHORED AT THE POINTER — the gesture is observed by the
 *   group's own trigger host (the header row), never below it, so the popup
 *   follows the cursor even when the header row itself has scrolled out of the
 *   scrollport. The same gesture is then claimed at that host, so the message
 *   list's own context-menu host never opens a second menu. A left click
 *   anywhere on the group's own edge dismisses that menu (one capture-phase
 *   handler on the same host) and still runs the edge's own action — the
 *   folded pill expands, the unfolded name opens its inline editor, the rail
 *   collapses.
 * - **One groupwide hover.** Hovering any part of the group edge — the header
 *   row or any point along the continuous rail — raises the whole line and the
 *   header's rename/dissolve actions together. There is no per-run hover mark.
 *
 * Presentation states (one entity, no separate collapse entity, no extra entry
 * point):
 * - Expanded (default): the name object opens the pill's INLINE rename editor
 *   (one compact input in place, focused with the name selected), the hover
 *   pencil opens the same editor, and the rail is the collapse target (its
 *   transparent hit area is the rule itself plus a few gutter pixels — the
 *   pill's clickable object is not widened).
 * - Folded (`segment.folded`): the rail keeps its place but fades out over the
 *   shared fold window (opacity on the SAME node, so the chrome never switches
 *   a frame before the content it belongs to); the header row stays in flow
 *   (it is the group's occupied row, not a body placeholder), the pill keeps
 *   the existing label shape/layout with a neutral tint, and the tint dot leaves
 *   the layout entirely (the folded label carries no colored and no neutral
 *   mark — the dotless folded label the group had before a neutral mark was
 *   tried). The WHOLE pill — folded word, count and its own background — is the
 *   group's ONE expand
 *   target (one dispatch, one tab stop while the route can write); hovering any
 *   part of it underlines the folded word. A read-only route keeps the plain
 *   label: no pointer, no underline, no expand write. Hover-only rename/dissolve
 *   actions are not offered while folded, but the group menu still offers them
 *   (both are anchored surfaces that never depend on the pill being mounted).
 *
 * Geometry contract: the header row is the group's ONLY flow contribution —
 * it is the same row height in both states and never grows with the body. A
 * collapsed group's bodies settle to zero height on their own (no tail slot, no
 * extra row, no horizontal label cascade), so folding removes exactly the body
 * height and leaves the header (and everything above it) stationary.
 *
 * Folding is presentation-only state: membership, identity, order and the
 * context-window origin are untouched — expanding restores participation.
 */
const TopicSegmentLine: React.FC<TopicSegmentLineProps> = ({ segment, routeSegment, isFirst, isLast, turnCount }) => {
  const { t } = useTranslation()
  const { updateSegmentName, deleteSegment } = useTopicSegments(segment.topicId)
  // Mutation authority comes ONLY from the Main route-qualified entry for this
  // group on the CURRENT route (same source the drawer lists). Absent
  // (unqualified/pending, or no reachable member) gates fail-closed to
  // read-only. Never a raw catalog owner compare. Read and navigation stay
  // available on every route (see canNavigateGroup); only mutation is gated.
  const canMutateGroup = routeSegment?.headerOwnedByRoute === true
  const headerId = routeSegment?.headerMessageId ?? segment.headerMessageId ?? segment.firstMessageId ?? null
  const canNavigateGroup = headerId !== null && headerId.length > 0
  // One shared compact-popup standard for every group action surface: bounds,
  // inner padding, type metrics and wrapping come from
  // `getConfirmPopoverStyleParts` (theme-token driven), never from a local
  // width/font copy. The rename popover only expresses its PREFERRED width
  // inside those bounds, and the menu dissolve is the shared `ConfirmPopover`.
  const { token } = antdTheme.useToken()
  const surfaceStyleParts = useMemo(() => getConfirmPopoverStyleParts(token), [token])

  // The group's measured extent: one subscription per group, fed by the flow's
  // single group layout manager (shared ResizeObserver, coalesced passes).
  const geometry = useSegmentGroupGeometry(segment.id)

  // Same-route in-place fold/expand geometry: the group HEADER ROW is the
  // visual anchor (the group body — never the header — is what enters or leaves
  // the flow), so the shared viewport owner holds that region stationary and
  // the content below absorbs the height delta. The hook is optional so
  const color = segment.color || getSegmentColor(segment.id)
  // Header badge: the route-qualified TURN count only. An explicit display
  // prop wins (the layout chrome's turnCount, carried from the display route
  // entry); otherwise the authority entry's own turnCount. A pending/null
  // routeSegment on this route never falls back to the catalog message count
  // — unknown stays hidden (existing `{x !== undefined &&}` badge behavior).
  const displayTurnCount = turnCount ?? routeSegment?.turnCount
  // One groupwide hover: the header row and the continuous rail are one
  // boundary, so hovering either raises both the line and the header actions.
  const [hovered, setHovered] = useState(false)
  // The full label always stays mounted — name (ellipsis, full name on
  // `title`), turn count and hover rename/dissolve actions — at every width.
  // Narrow columns clamp the pill to the measured free gap (floored at the
  // minimum usable label width, see the publish effect) instead of hiding
  // any control.
  const [menuOpen, setMenuOpen] = useState(false)
  // The group's rename and dissolve surfaces are compact ANCHORED popovers (no
  // mask), never centered modals, and both belong to the group-menu entrance:
  // the pill renames inline and the header trash keeps its own button-anchored
  // confirmation (the shared `ConfirmPopover` standard). Each captured anchor is
  // a `1px` point ON the group rail plus the side of the whole menu the surface
  // opens on (see `GroupMenuActionAnchor`), so the surface keeps its region above
  // the menu and its arrow points at the group edge even while the header row is
  // scrolled out of the scrollport.
  const [renameAnchor, setRenameAnchor] = useState<GroupMenuActionAnchor | null>(null)
  const [dissolveAnchor, setDissolveAnchor] = useState<GroupMenuActionAnchor | null>(null)
  // The group name's INLINE editor: the pill's own state, so opening it never
  // moves the row, never opens a surface and never touches the fold.
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(segment.name)
  const inlineInputRef = useRef<InputRef>(null)
  // Enter and blur both commit the inline draft; whichever lands first settles
  // the gesture, so one draft can never write twice.
  const inlineSettledRef = useRef(false)
  // Viewport point of the last group-edge gesture (right click), captured by the
  // group's own trigger host. It is the last-resort fallback for a menu action
  // whose whole-menu box is already gone.
  const pointerAnchorRef = useRef<{ x: number; y: number } | null>(null)
  // The group's own header row is the positioned containing block of the action
  // pins: an anchor captured in viewport coordinates is translated into this
  // row's space so no transformed ancestor can displace it.
  const headerRowRef = useRef<HTMLDivElement>(null)
  // The rail's painted line is the source of the action pins' x: the arrow must
  // point AT the group edge, so the pin is a point on that line.
  const railRef = useRef<HTMLDivElement>(null)
  // The pill's own box: the expanded header shares the first message's header
  // band, so that header indents by exactly this width (see `MessageHeader`).
  const pillRef = useRef<HTMLDivElement>(null)
  // A surface that is open keeps the hover action row revealed: the trigger must
  // not fade out from under the confirmation it just opened.
  const actionsVisible = hovered || renameAnchor !== null || dissolveAnchor !== null
  // Mounted-window facts are published as data attributes only: the group
  // identity row exists for EVERY mounted group (one header per group, no
  // duplicate and no state-dependent election), so the label pill itself is
  // always painted — the name is the group's identity, independent of which
  // members happen to be windowed in.
  const railHeight = geometry?.height ?? 0
  const railTop = geometry?.top ?? SEGMENT_GROUP_RAIL_TOP_PX

  // Paired group label+bubble layout — ONE shared budget, same-frame vars.
  // A is measured on the actual pair axis: pill attached edge
  // (hostLeft + PILL_LEFT, PILL_LEFT = -8) to the user bubble's right limit
  // (host right minus the 45px bubble margin and the 10px row inset, counted
  // once): A = hostWidth - PAIRED_AXIS_FIXED_PX (47).
  // Intrinsics are deliberate offscreen measures (same component, aria-hidden),
  // never the allocated-width feedback: full pill capped at 280 for Lp, first
  // grapheme + ellipsis + chrome for Lm, first text max-content for the bubble.
  // Both widths come from resolvePairedWidths in the same frame
  // (--seg-head-pill-w + --seg-head-pill-max-w carry the label, --paired-bubble-w
  // carries the bubble); no CSS separate-cap override may break the budget.
  // Assistant-first keeps its prior indent path and never pairs with a bubble.
  const { reportPairedMin } = usePairedReadingMin()
  useLayoutEffect(() => {
    const pill = pillRef.current
    if (!pill) return
    const host = pill.closest('[data-interaction-scope-id]')
    if (!(host instanceof HTMLElement)) return
    let observedBody: Element | null = null
    let observer: ResizeObserver | null = null
    const firstGraphemeOf = (name: string): string => {
      try {
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        const it = seg.segment(name)[Symbol.iterator]()
        const first = it.next()
        if (!first.done) return (first.value as { segment: string }).segment
      } catch {
        /* fall through */
      }
      return Array.from(name)[0] ?? ''
    }
    const measureOffscreen = (source: HTMLElement, mutate?: (clone: HTMLElement) => void): number => {
      const clone = source.cloneNode(true) as HTMLElement
      clone.setAttribute('aria-hidden', 'true')
      // cssText below replaces the inline style block, and the user's typography
      // lives on the SOURCE element as an inline `fontSize` (the message font
      // setting). Re-apply the live computed font so a non-default setting never
      // measures at the default size.
      const sourceStyle = getComputedStyle(source)
      clone.style.cssText =
        'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;' +
        'width:auto;max-width:none;height:auto;white-space:nowrap;flex:none;'
      clone.style.font = sourceStyle.font
      clone.style.fontSize = sourceStyle.fontSize
      clone.style.lineHeight = sourceStyle.lineHeight
      clone.style.letterSpacing = sourceStyle.letterSpacing
      if (mutate) mutate(clone)
      document.body.appendChild(clone)
      const w = Math.ceil(clone.getBoundingClientRect().width)
      clone.remove()
      return w
    }
    const publish = () => {
      const firstMsg = host.querySelector('[data-message-id]')
      const isUserFirst = firstMsg?.classList.contains('message-user') ?? false
      if (!isUserFirst) {
        const fallback = `${Math.ceil(pill.getBoundingClientRect().width)}px`
        if (host.style.getPropertyValue('--seg-head-pill-w') !== fallback) {
          host.style.setProperty('--seg-head-pill-w', fallback)
        }
        // A group that stops being user-first (renamed/reordered/folded, or an
        // assistant-first turn) must drop the paired contract entirely: a stale
        // --paired-bubble-w would keep squeezing a message that no longer shares
        // a budget with the pill.
        host.style.removeProperty('--seg-head-pill-max-w')
        host.style.removeProperty('--paired-bubble-w')
        host.style.removeProperty('--paired-gap-w')
        host.removeAttribute('data-paired-group')
        reportPairedMin(segment.id, null)
        return
      }
      const Lp = Math.min(SEGMENT_GROUP_PILL_MAX_W_PX, measureOffscreen(pill))
      const Lm = (() => {
        const w = measureOffscreen(pill, (clone) => {
          const nameEl = clone.querySelector('[data-testid="topic-segment-label"] span, span')
          void nameEl
          const nameSpan = clone.querySelectorAll('span')[1] ?? clone.querySelector('span')
          const g = firstGraphemeOf(segment.name || '')
          if (nameSpan) nameSpan.textContent = `${g}…`
        })
        return Math.min(Lp, Math.max(1, w))
      })()
      const body = firstMsg?.querySelector('.message-content-container') as HTMLElement | null
      const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const minFloor = bubbleMinPx(rootFont)
      const hostWidth = host.clientWidth || host.getBoundingClientRect().width
      // The generic long-bubble cap is `min(42rem, calc(100% - 91px), 80%)`, where
      // `100%` resolves against the rendered content parent of the bubble content
      // container (row padding/margins already applied), NOT against the row host.
      // Measure that containing box so the cap and the CSS cap are the same truth.
      const contentParent = body?.parentElement ?? null
      let contentColumn = hostWidth
      if (contentParent) {
        const parentStyle = getComputedStyle(contentParent)
        const padX =
          (Number.parseFloat(parentStyle.paddingLeft) || 0) + (Number.parseFloat(parentStyle.paddingRight) || 0)
        const measuredColumn = contentParent.clientWidth - padX
        // Only a laid-out box is a real containing block; otherwise keep the host
        // width instead of collapsing the cap to zero.
        if (measuredColumn > 0) contentColumn = measuredColumn
      }
      const cap = genericBubbleCapPx(contentColumn, rootFont)
      let intrinsic = cap
      if (body) {
        intrinsic = measureOffscreen(body, (clone) => {
          clone.style.width = 'max-content'
          clone.style.maxWidth = 'none'
          clone.style.flex = 'none'
        })
      }
      const Bp = Math.min(intrinsic, cap)
      const Bm = intrinsic <= minFloor ? Bp : Math.min(minFloor, Bp)
      const A = hostWidth - PAIRED_AXIS_FIXED_PX
      const r = resolvePairedWidths(A, Lp, Lm, Bp, Bm)
      const labelStr = `${Math.max(0, r.label).toFixed(2)}px`
      const bubbleStr = `${Math.max(0, r.bubble).toFixed(2)}px`
      if (host.style.getPropertyValue('--seg-head-pill-w') !== labelStr) {
        host.style.setProperty('--seg-head-pill-w', labelStr)
      }
      if (host.style.getPropertyValue('--seg-head-pill-max-w') !== labelStr) {
        host.style.setProperty('--seg-head-pill-max-w', labelStr)
      }
      if (host.style.getPropertyValue('--paired-bubble-w') !== bubbleStr) {
        host.style.setProperty('--paired-bubble-w', bubbleStr)
      }
      if (host.style.getPropertyValue('--paired-gap-w') !== `${PAIRED_GROUP_GAP_PX}px`) {
        host.style.setProperty('--paired-gap-w', `${PAIRED_GROUP_GAP_PX}px`)
      }
      host.setAttribute('data-paired-group', 'true')
      reportPairedMin(segment.id, r.minPair)
      const nextBody = body
      if (nextBody !== observedBody) {
        if (observedBody && observer) observer.unobserve(observedBody)
        observedBody = nextBody
        if (observedBody && observer) observer.observe(observedBody)
      }
    }
    publish()
    if (typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(publish)
    observer.observe(pill)
    observer.observe(host)
    if (observedBody) observer.observe(observedBody)
    return () => {
      observer?.disconnect()
      observedBody = null
      host.style.removeProperty('--seg-head-pill-w')
      host.style.removeProperty('--seg-head-pill-max-w')
      host.style.removeProperty('--paired-bubble-w')
      host.style.removeProperty('--paired-gap-w')
      host.removeAttribute('data-paired-group')
      reportPairedMin(segment.id, null)
    }
  }, [segment.id, segment.name, reportPairedMin])

  // Row navigation must never fire from group interactions: the header sits
  // inside the turn wrapper whose click capture selects the turn in edit
  // mode. Controls and the pill stop propagation; row navigation is a
  // drawer/nav concern, never a turn-click side effect.
  const stopRowNavigation = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
  }, [])

  // Viewport anchor -> header-row space: the pin is absolutely positioned
  // inside THIS group's own header row, so the captured viewport point is
  // rebased on that row. The captured side survives untouched (it is what
  // decides the placement family, not a coordinate), so only `x`/`y` are
  // row-relative. Without a row (first render, unit tests) the raw point is kept
  // and the surface still opens beside the rail where the user acted.
  const anchorInRowSpace = useCallback((anchor: GroupMenuActionAnchor | null): GroupMenuActionAnchor | null => {
    if (!anchor) return null
    const host = headerRowRef.current
    if (!host) return anchor
    const rect = host.getBoundingClientRect()
    return { ...anchor, x: Math.round(anchor.x - rect.left), y: Math.round(anchor.y - rect.top) }
  }, [])

  // The name pill and the hover pencil rename the group INLINE, in the pill
  // itself (no anchored surface): one compact input replaces the name object, so
  // the row never moves and no popup is involved. Both entrances write through
  // the same `saveSegmentName` the menu surface uses — trimmed, and a blank or
  // unchanged draft writes nothing.
  const saveSegmentName = useCallback(
    async (draft: string): Promise<boolean> => {
      // Owner-only write (fail-closed): a non-owner route never issues the
      // metadata mutation, even if a surface were forced open.
      if (!canMutateGroup) return false
      const trimmed = draft.trim()
      if (!trimmed || trimmed === segment.name) return false
      try {
        await updateSegmentName(segment.id, trimmed)
        return true
      } catch (error) {
        // Privacy-safe: the group name is user content, so only the failure is
        // logged, never the draft text.
        logger.error('Failed to rename segment', error instanceof Error ? error : { reason: String(error) })
        return false
      }
    },
    [canMutateGroup, segment.id, segment.name, updateSegmentName]
  )

  const startInlineRename = useCallback(() => {
    if (!canMutateGroup) return
    inlineSettledRef.current = false
    setEditName(segment.name)
    setIsEditing(true)
    // The menu surface is the other rename entrance; only one is ever open.
    setRenameAnchor(null)
    setDissolveAnchor(null)
  }, [canMutateGroup, segment.name])
  // Escape closes the inline editor and writes nothing (the draft is dropped).
  const handleInlineKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    inlineSettledRef.current = true
    setIsEditing(false)
  }, [])

  // Enter and blur both land here; whichever arrives first settles the gesture,
  // so one draft can never write twice.
  const commitInlineRename = useCallback(
    async (draft: string) => {
      if (inlineSettledRef.current) return
      inlineSettledRef.current = true
      const saved = await saveSegmentName(draft)
      if (!saved) setEditName(segment.name)
      setIsEditing(false)
    },
    [saveSegmentName, segment.name]
  )

  // Opening the editor selects the whole name, so a rename is one keystroke away
  // (the original inline editor only relied on `autoFocus`).
  useLayoutEffect(() => {
    if (!isEditing) return
    inlineInputRef.current?.focus({ cursor: 'all' })
    inlineInputRef.current?.select()
  }, [isEditing])

  // ONE anchor for both menu actions: the whole menu's box (read while the
  // click dispatches, before that portal unmounts) decides the side and the
  // anchored edge, while the group RAIL decides `x` — so the surface keeps its
  // region above the menu and its left arrow points at the group edge.
  const resolveMenuAnchor = useCallback(
    (box: GroupMenuBox | null) =>
      anchorInRowSpace(actionAnchorAt(box, { rail: railSpanOf(railRef.current), fallback: pointerAnchorRef.current })),
    [anchorInRowSpace]
  )

  const startRenameFromMenu = useCallback(
    (info?: GroupMenuClickInfo) => {
      if (!canMutateGroup) return
      const anchor = resolveMenuAnchor(menuBoxFor(info))
      if (!anchor) return
      // The pill's inline editor and the menu surface are one rename, never two.
      setIsEditing(false)
      setDissolveAnchor(null)
      setRenameAnchor(anchor)
    },
    [canMutateGroup, resolveMenuAnchor]
  )

  const cancelRename = useCallback(() => setRenameAnchor(null), [])

  // The menu surface's own commit: close first (that surface owns the draft),
  // then the SAME write path the pill's inline editor uses.
  const commitMenuRename = useCallback(
    async (draft: string) => {
      setRenameAnchor(null)
      await saveSegmentName(draft)
    },
    [saveSegmentName]
  )
  const handleDissolve = useCallback(async () => {
    if (!canMutateGroup) return
    await deleteSegment(segment.id)
  }, [canMutateGroup, deleteSegment, segment.id])

  // Fold/expand is a same-route in-place geometry change, so it goes through
  // the ONE shared viewport arbiter instead of any per-control scroll write:
  // - The gesture arms the shared interaction intent for this group's
  //   `segment-header` region BEFORE the mutation (the header row carries both
  //   the region annotation and the owning run's structural scope). The keeper
  //   then holds the HEADER ROW at its captured baseline, so the header and
  //   everything above it stay put while the height delta moves the content
  //   below. A rail click is already armed by the viewport's click boundary;
  //   re-arming from the same pre-mutation geometry is harmless (newer gesture
  //   wins). A menu action is a portaled click that never crosses that click
  //   boundary, so this explicit arming is the only reason the menu fold gets
  //   the identical hold semantics — same helper, same region, no compensator.
  // - The persisted fold state is DB-first (`setSegmentFolded` awaits the
  //   authority round-trip and only then converges Redux), so the rows land
  //   AFTER the click. Declaring the gesture's layout effect deferred keeps it
  //   armed through that gap without any optimistic UI write, timer or second
  //   scroll owner.
  // - Nothing here pins or pads the scroll position: at the newest edge the
  //   natural clamp wins and no artificial blank is introduced.
  const handleJumpToStart = useCallback(() => {
    // Stable head first: the drawer's navigation target verbatim, so a jump
    // from the group edge and a jump from the drawer are one behaviour. A
    // header-less group offers no navigation entry.
    const targetId = headerId ?? segment.firstMessageId
    if (typeof targetId !== 'string' || targetId.length === 0) return
    void EventEmitter.emit(EVENT_NAMES.NAVIGATE_TO_MESSAGE, targetId)
  }, [headerId, segment.firstMessageId])

  // Dissolve keeps the app's existing confusion-free confirmation content
  // (`topicSegment.dissolve.confirm`) and its own action wording, but renders it
  // through the shared `ConfirmPopover` standard: the same compact, anchored,
  // mask-less confirmation the app uses elsewhere, pinned to the rail anchor and
  // never a centered dialog. The hover trash button keeps its own BUTTON-anchored
  // `ConfirmPopover` (see the header actions below), so the destructive write is
  // never one click away from either entry point.
  const startDissolveFromMenu = useCallback(
    (info?: GroupMenuClickInfo) => {
      const anchor = resolveMenuAnchor(menuBoxFor(info))
      if (!anchor) return
      setIsEditing(false)
      setRenameAnchor(null)
      setDissolveAnchor(anchor)
    },
    [resolveMenuAnchor]
  )

  // One ordered group menu for the whole boundary: rename, collapse (expand
  // while folded), jump to the group's first message (the drawer's navigation
  // event, verbatim), dissolve. Rename and dissolve stay reachable while
  // folded: both are anchored surfaces with no dependency on the body (the
  // pill's inline editor is unreachable there, but the menu still offers
  // rename and dissolve), and the menu path pins the rail's line beside the
  // captured menu box instead of falling back to a (possibly offscreen) header
  // row. Fold/expand keeps its owner-only
  // availability: a read-only (inherited) group offers no
  // fold write at all, exactly like the rail hit target and the folded pill
  const menuItems = useMemo<MenuProps['items']>(() => {
    const items: NonNullable<MenuProps['items']> = []
    // Owner-only writes: a non-owner route may read and navigate the group but
    // never renames, dissolves or changes its membership.
    if (canMutateGroup) {
      items.push({ key: 'rename', label: t('topicSegment.rename'), onClick: startRenameFromMenu })
    }
    if (canNavigateGroup) {
      items.push({ key: 'jump-to-start', label: t('topicSegment.jumpToStart'), onClick: handleJumpToStart })
    }
    if (canMutateGroup) {
      items.push({
        key: 'dissolve',
        label: t('topicSegment.dissolveAction'),
        danger: true,
        onClick: startDissolveFromMenu
      })
    }
    return items
  }, [canMutateGroup, canNavigateGroup, handleJumpToStart, startDissolveFromMenu, startRenameFromMenu, t])

  // The message list wraps the whole flow in its own right-click host (a
  // `contextMenu` Dropdown on the scroll container), and this group's own
  // context-menu Dropdown observes the gesture on its trigger child — the
  // header row. Both facts decide where this handler may live:
  // - It must sit at the trigger HOST, never below it. antd/rc-trigger anchor a
  //   `contextMenu` popup at the pointer captured on that child; a handler on
  //   the pill or the rail that stopped the gesture before it reached the host
  //   would leave the trigger without a pointer, so the popup falls back to the
  //   header row's own geometry — offscreen whenever the header has scrolled
  //   away while the continuous rail is still visible, which paints the menu
  //   above the scrollport instead of at the click.
  // - It must claim the gesture HERE so it never reaches the ancestor host, or
  //   one right click would open a second, conflicting message menu.
  // Opening stays the trigger's job (`onOpenChange` writes the one controlled
  // open state), so the boundary keeps exactly one handler and one menu.
  const handleGroupContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // The gesture's viewport point is the MENU's own anchor (the user
    // right-clicked the rail), and it is the last-resort fallback for a menu
    // action whose whole-menu box is already gone. The action itself pins the
    // rail's line plus the captured whole-menu box (see `resolveMenuAnchor`).
    pointerAnchorRef.current = { x: e.clientX, y: e.clientY }
  }, [])

  // The rail's transparent hit surface opens NOTHING on a pointer click: a
  // left click on the group edge never opens the group menu (it only dismisses
  // an open one through the capture dismiss below). The header row stays the
  // menu's trigger host and keeps owning `contextmenu` (see
  // `handleGroupContextMenu`), so a right click on the rail still opens exactly
  // one menu, anchored at the pointer. The keyboard parity is the keyboard
  // right-click only (the context-menu key / Shift+F10); Enter and Space are
  // not menu gestures on this surface. Opening a whole group by folding is not
  // part of this boundary's interaction model, so the rail performs no fold
  // write either.
  const handleRailKeyDown = useCallback((e: React.KeyboardEvent) => {
    const isMenuKey = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')
    if (!isMenuKey) return
    e.preventDefault()
    e.stopPropagation()
    pointerAnchorRef.current = null
    setMenuOpen(true)
  }, [])
  // Dismissing the menu from the group's OWN edge is the one interaction the
  // popup library cannot do for us, for two independent reasons:
  // - rc-trigger treats its trigger child as part of the popup, so a click
  //   there is never an outside click and the popup stays open;
  // - the folded pill stops propagation (it is the group's one expand target),
  //   so the trigger's own click-to-hide handler never runs either.
  // The house mechanism for a controlled, trigger-owned menu is a CAPTURE-phase
  // dismiss on the trigger child (see MessageContextMenu): it runs outer-first,
  // before any inner stopPropagation, and neither prevents nor selects, so
  // every part of the edge (pill label, count, dot, background, rail) closes
  // the menu through ONE boundary handler while its own action still dispatches
  // exactly once. Clicks that land inside a group action surface — a
  // React-portal descendant of this row, whose real DOM lives elsewhere — do
  // not belong to the trigger, so they leave the state alone.
  const handleMenuDismissCapture = useCallback(
    (e: React.MouseEvent) => {
      if (!menuOpen) return
      const host = headerRowRef.current
      if (host && !host.contains(e.target as Node)) return
      setMenuOpen(false)
    },
    [menuOpen]
  )

  // Both menu actions derive their placement from the ONE captured anchor side:
  // the `right*` family keeps the arrow on the surface's left edge (pointing at
  // the rail), and the corner nearest the whole menu is the anchored one, so the
  // surface stays exactly `8px` clear of it.
  const renamePosition = menuSurfaceOf(renameAnchor ?? GROUP_MENU_PIN_PARKED)
  const dissolvePosition = menuSurfaceOf(dissolveAnchor ?? GROUP_MENU_PIN_PARKED)

  return (
    <Dropdown
      open={menuOpen}
      onOpenChange={setMenuOpen}
      menu={{ items: menuItems }}
      trigger={['contextMenu']}
      placement="bottomLeft"
      destroyOnHidden>
      <GroupHeaderRow
        ref={headerRowRef}
        data-testid="topic-segment-group"
        data-segment-id={segment.id}
        data-segment-folded="false"
        data-segment-first={isFirst ? 'true' : 'false'}
        data-segment-last={isLast ? 'true' : 'false'}
        data-segment-header={headerId ?? ''}
        data-segment-owner-branch={segment.ownerBranchId ?? ''}
        data-segment-can-mutate={canMutateGroup ? 'true' : 'false'}
        data-interaction-region={INTERACTION_REGION_SEGMENT_HEADER}
        onClickCapture={handleMenuDismissCapture}
        onContextMenu={handleGroupContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}>
        {/* 组头标签：唯一一个组头行，位于组首消息处 */}
        <TabContainer
          ref={pillRef}
          $color={color}
          $folded={false}
          $hovered={hovered}
          $expandable={false}
          data-testid="topic-segment-label"
          data-segment-folded="false">
          <TabContent>
            <ColorDot $color={color} $folded={false} />
            {isEditing ? (
              <TabInput
                ref={inlineInputRef}
                autoFocus
                size="small"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                onPressEnter={() => void commitInlineRename(editName)}
                onBlur={() => void commitInlineRename(editName)}
                onKeyDown={handleInlineKeyDown}
                onClick={stopRowNavigation}
                data-testid="topic-segment-rename-inline"
              />
            ) : (
              <TabName onClick={canMutateGroup ? startInlineRename : stopRowNavigation} title={segment.name}>
                {segment.name}
              </TabName>
            )}
            {displayTurnCount !== undefined && (
              <TabCount data-testid="topic-segment-count">
                {t('topicSegment.turns.count', { count: displayTurnCount })}
              </TabCount>
            )}
          </TabContent>
          <TabActions $hovered={actionsVisible} data-testid="topic-segment-actions">
            {canMutateGroup ? (
              <>
                <TabActionBtn
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    startInlineRename()
                  }}
                  title={t('topicSegment.rename')}
                  aria-label={t('topicSegment.rename')}>
                  <Pencil size={12} />
                </TabActionBtn>
                <ConfirmPopover
                  title={t('topicSegment.dissolve.confirm')}
                  okButtonProps={{ danger: true }}
                  onConfirm={handleDissolve}>
                  <TabActionBtn
                    type="button"
                    title={t('topicSegment.dissolveAction')}
                    aria-label={t('topicSegment.dissolveAction')}
                    onClick={stopRowNavigation}>
                    <Trash2 size={12} />
                  </TabActionBtn>
                </ConfirmPopover>
              </>
            ) : null}
          </TabActions>
        </TabContainer>

        {/* 组边界：唯一一条连续竖线 */}
        <GroupRail
          $height={railHeight}
          $top={railTop}
          data-testid="topic-segment-rail"
          data-segment-id={segment.id}
          data-segment-folded="false">
          <InteractionRailLine ref={railRef} $color={color} $active={hovered} data-testid="topic-segment-rule" />
          {/* 组边界命中面：竖线本身（4px）加上相邻 4px 沟槽，共 8px。左键/Enter/Space
              在这里不打开菜单（左键只经捕获认领关闭已开菜单）；右键不在这里认领，
              冒泡到组头行由它统一打开同一个菜单（箭头方向与锚点仍按竖线计算），
              键盘右键（菜单键/Shift+F10）同理。 */}
          <InteractionRailHitTarget
            type="button"
            onKeyDown={handleRailKeyDown}
            title={t('topicSegment.groupMenu')}
            aria-label={t('topicSegment.groupMenu')}
            aria-haspopup="menu"
            data-testid="topic-segment-rail-target"
          />
        </GroupRail>

        {/* 组菜单动作的两个紧凑锚定弹层：无遮罩、无居中模态，也不换用第二套弹层系统。
            弹层留在用户已经熟悉的区域——整个菜单上方、8px 间距；箭头留在弹层左缘，指向组边界
            竖线：锚点就是竖线上一个 1px 的点（`GroupActionPin`），`rightBottom`（菜单上方）/
            `rightTop`（菜单下方）把箭头画在左缘、距锚边 8px，所以箭头指的是那条线本身，而不是
            一个已经消失的菜单项，也不是弹层旁边的空白。菜单随点击卸载，整个菜单矩形在点击当刻
            同步读下并固定；上方空间不足、或箭头会落到竖线之外时改到菜单下方。组头滚出视口后
            弹层仍然贴在竖线上。 */}
        <Popover
          open={renameAnchor !== null}
          onOpenChange={(open) => {
            if (!open) setRenameAnchor(null)
          }}
          trigger={['click']}
          placement={renamePosition.placement}
          arrow={GROUP_ACTION_ARROW}
          align={renamePosition.align}
          classNames={surfaceStyleParts.classNames}
          styles={{
            root: { ...surfaceStyleParts.root, width: GROUP_ACTION_PANEL_WIDTH_PX },
            body: surfaceStyleParts.body
          }}
          destroyOnHidden
          content={
            <SegmentRenameForm initialName={segment.name} onConfirm={commitMenuRename} onCancel={cancelRename} />
          }>
          <GroupActionPin anchor={renameAnchor ?? GROUP_MENU_PIN_PARKED} testId="topic-segment-rename-anchor" />
        </Popover>
        <ConfirmPopover
          open={dissolveAnchor !== null}
          onOpenChange={(open) => {
            if (!open) setDissolveAnchor(null)
          }}
          title={t('topicSegment.dissolve.confirm')}
          okButtonProps={{ danger: true }}
          placement={dissolvePosition.placement}
          arrow={GROUP_ACTION_ARROW}
          align={dissolvePosition.align}
          destroyOnHidden
          onConfirm={handleDissolve}>
          <GroupActionPin anchor={dissolveAnchor ?? GROUP_MENU_PIN_PARKED} testId="topic-segment-dissolve-anchor" />
        </ConfirmPopover>
      </GroupHeaderRow>
    </Dropdown>
  )
}

// ─── Styled Components ───

/**
 * The group's ONE header row: the only flow contribution of the chrome.
 * Expanded runs share the first message's content band with the pill, so the
 * row is zero-height and the label sits flush with that content's top
 * instead of owning an independent `32px` band — grouping adds no vertical
 * height of its own. A collapsed browse block hides the bodies, so the row
 * keeps its own `32px` (still the existing `24px` pill + an `8px` gap)
 * exactly as before. It is a positioned host so the continuous rail (and the
 * pill, which sits at the gutter) can paint from it, but it contributes no
 * padding/margin/min-height of its own. Its own band is not a hit surface
 * (`pointer-events: none`): only the pill and the rail's transparent hit
 * target are interactive, so the message column and the message list's own
 * click/right-click semantics stay untouched.
 */
const GroupHeaderRow = styled.div`
  position: relative;
  height: 0;
  // Collapsed browse view: bodies are hidden and no message band is available
  // to share, so the row keeps its own 32px — no other rule changes.
  [data-seg-bodies-hidden='true'] & {
    height: ${SEGMENT_GROUP_HEADER_HEIGHT_PX}px;
  }
  // Local content layer only: this header paints above the ordinary message
  // rows it labels (z1000, below antd portal overlays ~1030). It takes no
  // part in the nav contract — the Chat row's sibling order already keeps
  // all message content above the collapsed nav rail, and the expanded nav
  // panel covers this header. Geometric hit containment (this row
  // pointer-events:none, only pill + rail target auto) keeps group hover
  // tight to its own chrome.
  z-index: 1000;
  pointer-events: none;
  // Out-of-flow paint must not be clipped: the rail spans the group's rows
  // below this one, so no overflow/contain clipping may be introduced here.
  isolation: isolate;
`

/**
 * The group's single continuous rail: one absolutely positioned overlay that
 * starts AT the pill's top (passing behind it) and runs to the group's last
 * mounted run (its length is measured by the shared group layout manager,
 * including the group's internal divider heights). One element, one hover
 * mark, one interaction surface — never one mark per run.
 */
const GroupRail = styled.div<{ $top: number; $height: number }>`
   position: absolute;
   // Rail base = the shared outset (ScrollContainer's own 10px left gutter):
   // the 2px line spans [-10,-8] and the 8px hit [-10,-2], both inside the
   // scrollport with overflow-x untouched and bodies unmoved.
   left: -${INTERACTION_RAIL_OUTSET_PX}px;
   top: ${(props) => props.$top}px;
   height: ${(props) => props.$height}px;
   width: ${INTERACTION_RAIL_LINE_WIDTH_PX}px;
  pointer-events: none;
  isolation: isolate;
`

const TabContainer = styled.div<{ $color: string; $folded: boolean; $hovered: boolean; $expandable: boolean }>`
 position: absolute;
 // Expanded: the pill sits at the rail's right edge, flush with the first
 // message's own content top (the message container's 10px top padding)
 // instead of owning a row. The pill's own left border joins the rail line
 // directly — no opaque chip crossing the line, no connector stem.
 // Grouping still adds no in-flow height; a user bubble header is absolutely
 // positioned and reserves nothing, so the pill's top always equals the
 // first message's content top and the chrome visually encompasses it.
 top: ${SEGMENT_GROUP_PILL_BAND_TOP_PX}px;
 left: ${SEGMENT_GROUP_PILL_LEFT_PX}px;
 z-index: 1;
 // Collapsed browse view: the row keeps its own 32px, so the pill sits at
 // the row top exactly as before.
 [data-seg-bodies-hidden='true'] & {
   top: 0;
 }
 display: flex;
 align-items: center;
 gap: 4px;
 height: ${SEGMENT_GROUP_PILL_HEIGHT_PX}px;
 padding: 0 8px 0 6px;
 background: ${(props) =>
   props.$folded ? 'var(--color-background-soft)' : `color-mix(in srgb, ${props.$color} 10%, var(--color-background))`};
 border: 1px solid
   ${(props) => (props.$folded ? 'var(--color-border)' : `color-mix(in srgb, ${props.$color} 22%, transparent)`)};
 border-radius: 2px 8px 8px 2px;
 pointer-events: auto;
 white-space: nowrap;
 // The label clamps to the run's own free geometry instead of shrinking the
 // bubble: --seg-head-pill-max-w is the measured gap between this attached
 // edge and the first message's body minus the pill gap (see the publish
 // effect), falling back to the absolute cap before it publishes. Past the
 // max the name truncates (ellipsis, full name on title); the clamp never
 // goes below the minimum usable label width, so the name, its count and
 // the hover rename/dissolve actions always stay mounted and reachable.
 max-width: min(${SEGMENT_GROUP_PILL_MAX_W_PX}px, var(--seg-head-pill-max-w, ${SEGMENT_GROUP_PILL_MAX_W_PX}px));
  isolation: isolate;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`

// One text row for the pill: the name/word and the count share the SAME text
// baseline. Centering each item's own line box let the 12px name and the 11px
// count drift apart — each box centers independently, so the two sizes meet
// only when the inherited leading happens to yield the same offset — and the
// pair read as misaligned type instead of one label with a subordinate count.
// Baseline alignment keeps the 12/11 hierarchy and the 24px pill untouched.
// The explicit line-height is shared by the row's text so the baseline belongs
// to this component rather than to the inherited unitless body leading.
const TabContent = styled.div`
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  line-height: 16px;
`

/**
 * The group's tint mark: the SAME node in both presentation states, so folding
 * never replaces the chrome element (a replaced node could only ever be
 * committed already faded).
 *
 * Expanded it is the group's own segment color and keeps its `6px` box in the
 * content's row. Folded the group tint is out of context and the dot leaves the
 * LAYOUT (`display: none`, not `opacity: 0`, which would leave the `6px` box and
 * the content gap in place): the folded label carries no mark at all — the
 * dotless folded label the group had before a neutral mark was tried — so its
 * word starts at the pill's own inset (`6px` padding + the border) with no
 * folded-only padding rule.
 */
const ColorDot = styled.span<{ $color: string; $folded?: boolean }>`
  display: ${(props) => (props.$folded ? 'none' : 'inline-block')};
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${(props) => props.$color};
  flex-shrink: 0;
  // The mark holds no text, so its baseline would be its own bottom edge:
  // baseline alignment would drop it onto the shared text baseline, below the
  // row's optical middle. Keep it centered instead — box and color unchanged.
  align-self: center;
`

const TabName = styled.span`
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-1);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }
`

/**
 * The pill's own inline rename field: the same compact one-line box the group
 * header always used, so opening the editor never grows the pill, moves the row
 * or opens a surface.
 */
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
  color: var(--color-text-3);
  flex-shrink: 0;
`

const TabActions = styled.div<{ $hovered: boolean }>`
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  // Revealed by the group's single hover state (header row or any point along
  // the continuous rail) and by keyboard focus inside the pill — never by a
  // per-run or per-mark hover.
  opacity: ${(props) => (props.$hovered ? 1 : 0)};
  transition: opacity 0.15s;

  ${TabContainer}:focus-within & {
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
  color: var(--color-text-3);
  transition: color 0.15s;

  &:hover {
    color: var(--color-text-1);
  }
`

/**
 * Compact rename surface: one line of input plus the app's own cancel/confirm
 * wording. Its bounds are the SHARED compact-popup standard
 * (`getConfirmPopoverStyleParts`), with a preferred width
 * (`GROUP_ACTION_PANEL_WIDTH_PX`) inside those bounds, so the body simply fills
 * it: no title band, no description, no mask, and one compact rectangle whatever
 * the source kind.
 */
const RenameSurface = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const RenameActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 6px;
`

export default memo(TopicSegmentLine)
