import type { TopicSegment } from '@renderer/types/topicSegment'
import { findStableStartRunIndex, resolveGroupSlotHost } from '@renderer/utils/routeGroupPresentation'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import {
  Fragment,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef
} from 'react'
import styled from 'styled-components'

import { FoldedSection } from './FoldedSection'
import {
  GroupRailContinuation,
  GroupSlotContinuation,
  type SegmentGroupPresentation,
  useSegmentGroupLayoutManager
} from './SegmentGroupPresentation'

/**
 * Segment/group chrome host: the positioned wrapper that owns ONLY the
 * topic-segment chrome (the vertical rule + the segment label pill) as a
 * sibling of the interactive turn. It contains no message content, carries
 * no capture, no `inert`, and no cover, so the chrome is hit-testable on its
 * own layer in both modes while the turn subtree keeps its entire actual
 * content (including message toolbars) and all edit-selection semantics
 * untouched. `position: relative` adds no box offset — chrome anchoring and
 * the turn's own layout are unchanged.
 */
export const RunHost = styled.div`
  position: relative;
`

/**
 * One carrying run host, registered with the flow's single group layout
 * manager. Runs of the same topic-segment group may be physically separated
 * (a divider, a differing turn id, a viewport-partial membership) and may live
 * in different selection ranges, so the group's continuous rail cannot be a
 * per-group physical parent. Registration is what lets the group's presentation
 * owner measure ONE span across every mounted run: no per-run observer, no
 * per-run chrome, no viewport write.
 */
const SegmentRunHost: React.FC<{
  groupId?: string
  /**
   * This run hosts the group's ONE route-stable normal-flow slot: the in-flow
   * header row when the group's stable head resolves on this route, otherwise
   * the equal-height continuation row. It is also the group's measured
   * geometry anchor (the rail starts below the slot), so exactly one
   * registration per group carries it.
   */
  isHeader: boolean
  /** This run carries the group's authority last mounted member. */
  endsGroup: boolean
  scopeId?: string
  children: ReactNode
}> = ({ groupId, isHeader, endsGroup, scopeId, children }) => {
  const manager = useSegmentGroupLayoutManager()
  const elementRef = useRef<HTMLDivElement | null>(null)

  // Layout phase: runs register before the provider's own pre-paint pass, so
  // the group span is known on the very first commit.
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!manager || !groupId || !element) return
    return manager.registerRun(groupId, element, { isHeader, endsGroup })
  }, [manager, groupId, isHeader, endsGroup])

  return (
    <RunHost ref={elementRef} data-interaction-scope-id={scopeId}>
      {children}
    </RunHost>
  )
}

/**
 * Selected-group outline. Boundary dividers (fork / context) render as
 * siblings of (never inside) this block except when the divider lies
 * strictly between two selected turns of one continuous range — then the
 * single atomic outline naturally wraps the interior boundary as part of
 * the selected range. Leading/trailing boundaries stay outside.
 */
export const SelectionBlock = styled.div`
  display: flex;
  flex-direction: column-reverse;
  box-shadow: 0 0 0 1.5px var(--color-primary);
  border-radius: 10px;
`

/**
 * Presentation/interaction-layer Q&A turn container: one real DOM owner
 * around adjacent mounted message bodies sharing the same selection askId
 * with no boundary node between them (user singleton + consecutive
 * assistant group(s) of one contiguous mounted turn).
 *
 * - Exists independent of hover, in edit and non-edit modes alike, so
 *   toggling edit mode or moving the pointer never reparents/remounts
 *   children: same type + same stable key keep node identity.
 * - Directly owns the edit-mode hover outline (one continuous neutral
 *   ring via CSS `:hover`, no geometry measurement, no timers, no parent
 *   hover state), the edit-selection click capture (toggles the turn once),
 *   and the message-toolbar immediate hide (same edit-class commit, no
 *   transition, height reserved). Nested ordinary actions run unchanged
 *   behind the outer shield — no per-child edit branches.
 * - `column-reverse` mirrors the scroll container and SelectionBlock:
 *   render order is newest→oldest, so the reversed flex keeps the older
 *   user group visually above the newer assistant group(s).
 * - Adds no spacing: no margin/padding/gap, only the shared 10px radius
 *   so the hover ring tracks the same corners as the selected outline.
 *   The edit cover is absolutely positioned (out of flow), so edit-mode
 *   geometry matches normal mode exactly.
 * - Never contains a boundary node: dividers are siblings of turns, so
 *   turn click capture cannot swallow divider controls.
 */
export const EditTurnContainer = styled.div`
  display: flex;
  flex-direction: column-reverse;
  border-radius: 10px;
  &.edit-turn-interactive {
    position: relative;
    cursor: pointer;
  }
  &.edit-turn-interactive:hover {
    box-shadow: 0 0 0 1px var(--color-border);
  }
  &.edit-turn-selected {
    position: relative;
    cursor: pointer;
  }
  // Single owner for edit-mode message-toolbar hiding: the same commit
  // that adds the edit class hides the footer immediately (no
  // opacity/visibility transition, noninteractive) while reserving its
  // occupied height (visibility, not display:none). The multi-answer
  // group bar (.group-menu-bar) is intentionally unaffected.
  &.edit-turn-interactive,
  &.edit-turn-selected {
    .MessageFooter,
    .MessageFooter .menubar,
    .MessageFooter .message-action-button,
    .MessageFooter .message-footer-metadata {
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      transition: none !important;
    }
  }
`

/**
 * Stable content wrapper present in both modes. `display: contents`
 * contributes no box, so edit-mode geometry matches normal mode exactly.
 * Native `inert` in edit mode blocks focus/keyboard/interactions across
 * all descendants; the sibling cover receives pointer/hover/drag/
 * right-click instead of child controls.
 */
export const EditTurnContent = styled.div`
  display: contents;
`

/**
 * Edit-only absolute cover: receives pointer/hover/drag/right-click
 * rather than child controls (preventing pass-through, not only click).
 * Plain non-focusable descriptive layer (aria-hidden, no tabIndex/role,
 * no strings); clicks bubble to the turn capture for whole-turn selection
 * with existing ctrl/meta/shift semantics. Wheel/touch bubble to the
 * viewport ancestors; the batch context menu is preserved via the turn
 * context-menu handler (no blanket suppression).
 */
export const EditTurnCover = styled.div`
  position: absolute;
  inset: 0;
  z-index: 1;
  background: transparent;
`

export interface EditTurnProps {
  /** Selection-unit id shared by every visual group in this turn. */
  turnAskId: string
  isEditMode?: boolean
  /** Inside a selected outline: click still toggles, hover draws no ring. */
  isSelected?: boolean
  onTurnClick?: (askId: string, isCtrl: boolean, isShift: boolean) => void
  children: ReactNode
}

/**
 * The turn interaction owner. The inner content keeps its original
 * container/style/children in all modes (no per-child edit branches);
 * in edit mode it is natively inert while the sibling cover receives
 * pointer/hover/drag/right-click. Capture-phase click interception runs
 * once per gesture here for whole-turn selection with existing
 * ctrl/meta/shift semantics. Right-click auto-selects a non-selected turn
 * (replace) and preserves an existing selection, without suppressing the
 * ancestor batch context menu. Boundaries are siblings of turns, so
 * divider controls (branch switcher, context UI) never pass through this
 * capture.
 *
 * Edit-mode native text selection is suppressed HERE, scoped to this
 * turn's own subtree: a native `selectstart` inside the turn (inert
 * content or its cover) is canceled, and a primary-button `mousedown`
 * inside the turn cannot open a native range (the click capture still
 * performs whole-turn selection). The suppression is owned by the actual
 * turn node — added only in edit mode and removed on mode change or
 * unmount — so the message list keeps native selection everywhere else:
 * the RunHost's sibling segment chrome, its rename field, and ordinary
 * non-message controls keep native Cmd+A / drag selection with no
 * label-specific branch or whitelist.
 */
export const EditTurn = memo(
  ({ turnAskId, isEditMode = false, isSelected = false, onTurnClick, children }: EditTurnProps) => {
    const containerRef = useRef<HTMLDivElement | null>(null)

    // Native `selectstart` has no React prop: bind it directly to the real
    // turn node in edit mode only (no per-turn document/window listener).
    useEffect(() => {
      if (!isEditMode) return
      const el = containerRef.current
      if (!el) return
      const onSelectStart = (e: Event) => {
        e.preventDefault()
      }
      el.addEventListener('selectstart', onSelectStart)
      return () => el.removeEventListener('selectstart', onSelectStart)
    }, [isEditMode])

    const handleClickCapture = useCallback(
      (e: ReactMouseEvent) => {
        if (!isEditMode || !onTurnClick) return
        e.preventDefault()
        e.stopPropagation()
        if (!turnAskId) return
        onTurnClick(turnAskId, e.metaKey || e.ctrlKey, e.shiftKey)
      },
      [isEditMode, onTurnClick, turnAskId]
    )

    // Primary-button only: stop a native range from opening on Shift+click
    // or drag inside the turn (group selection flows through the click
    // capture). Right/middle button stay untouched so the batch context
    // menu is preserved.
    const handleMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      // Selection may reparent/remount this turn under SelectionBlock. Hand
      // focus to the stable message viewport so editable composer shortcuts
      // stop intercepting edit-mode clipboard keys after a turn click.
      e.currentTarget.closest<HTMLElement>('#messages')?.focus({ preventScroll: true })
    }, [])

    const handleContextMenu = useCallback(() => {
      if (!isEditMode || !onTurnClick) return
      if (!turnAskId) return
      // No preventDefault/stopPropagation: the ancestor batch menu must
      // still open; wheel/touch and viewport pointer-intent listeners keep
      // their bubbled events.
      if (!isSelected) {
        onTurnClick(turnAskId, false, false)
      }
    }, [isEditMode, isSelected, onTurnClick, turnAskId])

    const className = 'edit-turn' + (isEditMode ? (isSelected ? ' edit-turn-selected' : ' edit-turn-interactive') : '')

    return (
      <EditTurnContainer
        ref={containerRef}
        data-testid="edit-turn"
        data-turn-ask={turnAskId || undefined}
        className={className}
        onClickCapture={isEditMode ? handleClickCapture : undefined}
        onMouseDown={isEditMode ? handleMouseDown : undefined}
        onContextMenu={isEditMode ? handleContextMenu : undefined}>
        <EditTurnContent inert={isEditMode ? true : undefined}>{children}</EditTurnContent>
        {isEditMode && <EditTurnCover data-testid="edit-turn-cover" aria-hidden="true" />}
      </EditTurnContainer>
    )
  }
)

EditTurn.displayName = 'EditTurn'

/** Selection-unit id of one visual group: user id, else its askId. */
export function deriveTurnAskId(messages: readonly { id: string; role?: string; askId?: string | null }[]): string {
  const first = messages[0]
  if (!first) return ''
  if (first.role === 'user') return first.id
  return first.askId || first.id
}

/**
 * Mounted message-flow sequence (render order newest→oldest, matching the
 * column-reverse scroll container where DOM-earlier means visually lower).
 *
 * - `turn`: one mounted message-body group (one visual MessageGroup). The
 *   body node carries liveness (`data-layer-kind` / `data-layer-run-id`),
 *   stable group identity, fold behavior, and branch route content. It
 *   never contains a divider.
 * - `boundary`: one independent divider row (fork or context) between
 *   message content. It carries stable divider identity + React key and
 *   the ordered rendered node. It carries no turn click/hover behavior,
 *   so divider controls stay outside turn selection capture.
 *
 * DOM vs visual order (column-reverse, newest→oldest render order):
 * - A fork boundary node renders DOM-immediately-before its anchor turn
 *   body, i.e. visually directly below the anchor message: the boundary
 *   between the anchor (visually above the line) and the newer content
 *   (visually below the line).
 * - A context boundary node renders DOM-immediately-after its anchor turn
 *   body (where the legacy inline divider sat: after the group div), i.e.
 *   visually directly above the anchor message on the older side. Its
 *   position preserves the legacy visual placement exactly; only the DOM
 *   ownership changes (sibling instead of descendant of the turn).
 */
export interface FlowBodyEntry {
  /** Stable entity-derived group key (unchanged by selection state). */
  groupKey: string
  /** Selection-unit askId shared across the turn's visual groups. */
  turnAskId: string
  /** Whether the containing edit segment is selected. */
  selected: boolean
  /** Owning segment's stable id (SelectionBlock identity when uniform). */
  segmentId: string
  /** Owning segment's liveness (SelectionBlock data-layer-kind when uniform). */
  segmentIsLive: boolean
  /** This group's own layer kind (liveness stays on the child). */
  kind: string
  /** This group's own layer run id (liveness stays on the child). */
  layerRunId: string
  /**
   * Owning topic-segment for this group, if any. Segment chrome is the
   * group/segment's own visual identity, not message-turn content, so it is
   * rendered by the run chrome host (sibling of the turn) rather than inside
   * the turn subtree.
   */
  segment?: TopicSegment
  /** This group's first message is the owning segment's authority first message. */
  segmentIsFirst?: boolean
  /** This group's last message is the owning segment's authority last message. */
  segmentIsLast?: boolean
  /** Whether every member in this turn body is folded (excluded from context). */
  isFolded?: boolean
  /** All message IDs in this turn body. */
  messageIds?: string[]
  /** The group wrapper (group div only — never a divider). */
  bodyNode: ReactNode
}

export interface FlowBoundaryEntry {
  /** Stable divider identity, also used as the React key. */
  boundaryKey: string
  /** Divider family (fork vs context vs history reference share the boundary node kind). */
  boundaryKind: 'fork' | 'context' | 'reference'
  /** The ordered rendered divider row(s) at this placement. */
  node: ReactNode
}

export type FlowNode = { kind: 'turn'; entry: FlowBodyEntry } | { kind: 'boundary'; entry: FlowBoundaryEntry }

/** Ordered composition after turn-run grouping (boundaries stay standalone). */
export type OrderedFlowItem =
  | { kind: 'turn-run'; run: FlowBodyEntry[] }
  | { kind: 'boundary'; entry: FlowBoundaryEntry }

/**
 * Topic-segment membership identity used for run grouping: the owning
 * segment id, or `null` when the group is unsegmented. Two adjacent
 * same-askId groups join only while this identity matches, so a run is
 * always segment-homogeneous (all members share one segment, or all are
 * unsegmented). `segmentIsFirst` / `segmentIsLast` are position flags
 * *within* one segment and never split a homogeneous run; only a real
 * membership transition does — unsegmented↔segmented, or segment↔other
 * segment.
 */
function runSegmentMembership(entry: FlowBodyEntry): string | null {
  return entry.segment ? entry.segment.id : null
}

/**
 * Group adjacent turn entries into contiguous EditTurn runs. A boundary
 * node always flushes/closes the current run: even identical askIds on
 * both sides of a divider yield distinct turn DOM containers; a turn
 * wrapper never spans a boundary.
 *
 * Adjacency also requires segment homogeneity: a segment-membership
 * transition (unsegmented↔segmented, or segment↔other segment) flushes the
 * run even for a shared askId. Normal whole-turn segmentation keeps one
 * askId's user + assistant groups inside one segment, so a normal turn
 * still yields a single run; the split only surfaces the partial-turn /
 * disjoint membership that import and the segment API can already produce,
 * guaranteeing every run owns exactly one segment's chrome (no label or
 * color bound is silently dropped). The run keeps its original
 * `turnAskId`, so selection identity and interaction semantics are
 * untouched, and `deriveTurnKey` stays the sole unique/stable run id.
 *
 * A viewport-partial turn wraps only its mounted members; non-consecutive
 * groups with the same askId (intervening content between them) form
 * separate runs — never one wrapper spanning the gap.
 */
export function buildOrderedFlowItems(nodes: readonly FlowNode[]): OrderedFlowItem[] {
  const items: OrderedFlowItem[] = []
  let current: FlowBodyEntry[] = []
  const flush = () => {
    if (current.length > 0) {
      items.push({ kind: 'turn-run', run: current })
      current = []
    }
  }
  for (const node of nodes) {
    if (node.kind === 'boundary') {
      flush()
      items.push({ kind: 'boundary', entry: node.entry })
      continue
    }
    const entry = node.entry
    const last = current[current.length - 1]
    if (
      last &&
      last.turnAskId !== '' &&
      last.turnAskId === entry.turnAskId &&
      runSegmentMembership(last) === runSegmentMembership(entry)
    ) {
      current.push(entry)
    } else {
      flush()
      current = [entry]
    }
  }
  flush()
  return items
}

/** Stable turn key from member entity keys: unchanged by hover/edit toggle. */
export function deriveTurnKey(run: readonly FlowBodyEntry[]): string {
  const ask = run[0]?.turnAskId ?? ''
  return `turn:${ask.length}:${ask}:${run.map((g) => g.groupKey).join('+')}`
}

/**
 * Stable selection-range identity for one atomic outline. When every
 * selected run in the range shares the same owning segment id, that id is
 * reused (unique per segment, preserving the existing contract). Mixed
 * ranges (not expected from production's maximally merged segments, but
 * possible in tests) derive a collision-safe combination of member segment
 * ids + turn keys so the id stays unique and stable.
 *
 * `segmentId` is the identity of the selected SEGMENT, not of one rendered
 * outline: a folded block is composed as its own shell and therefore splits
 * one selected segment into several outline chunks that are siblings in the
 * same flow. Those siblings need `deriveSelectionChunkKey` — never this id —
 * as their React key. See that function for why.
 */
export function deriveSelectionRangeKey(runs: readonly FlowBodyEntry[][]): string {
  const flat = runs.flat()
  const segmentIds = [...new Set(flat.map((g) => g.segmentId))]
  if (segmentIds.length === 1 && segmentIds[0]) return segmentIds[0]
  const turnKeys = runs.map((run) => deriveTurnKey(run)).join('|')
  return `range:${segmentIds.join('+')}:${turnKeys.length}:${turnKeys}`
}

/**
 * React key of ONE rendered selection outline (one chunk of a selected
 * segment). The key is derived from the chunk's own turns only, because the
 * chunk — not the segment — is the React child: a selected segment reaching
 * across a folded block renders as more than one chunk, and siblings with the
 * same key make React's reconciler keep a single child per key in its match
 * map. The unmatched sibling is then never deleted, so it keeps its committed
 * edit-mode presentation (cover, selected class, rows) after the selection
 * ends and duplicates those rows in the display window on every following
 * range selection.
 *
 * Turn keys are entity-derived and unchanged by hover/mode/selection, so a
 * chunk keeps its key — and its host nodes — while its own turns stay the
 * same, and differs from every other chunk of the same segment because chunks
 * partition the range's runs. The `range:` namespace keeps the key disjoint
 * from the standalone run keys (`deriveTurnKey`) and block keys
 * (`folded-section:…`) in the same flow.
 */
export function deriveSelectionChunkKey(runs: readonly FlowBodyEntry[][]): string {
  return `range:${runs.map((run) => deriveTurnKey(run)).join('|')}`
}

export interface RenderEditFlowNodesOptions {
  /** Mounted message flow in newest→oldest render order. */
  nodes: FlowNode[]
  isEditMode: boolean
  onTurnClick?: (askId: string, isCtrl: boolean, isShift: boolean) => void
  /**
   * Renders the owning topic-segment group boundary, exactly ONCE per mounted
   * group. It is invoked inside the group's route-stable slot run host (the run
   * mounting the group's first member in effective-route order) — a sibling of
   * the interactive turn, outside its `inert` content and its click-capture
   * cover — so group controls stay independently hit-testable while turn
   * selection is unaffected. The payload is group-level presentation (never
   * per-run): the group owns one in-flow `32px` row (the header when its head
   * resolves on this route, the equal-height continuation otherwise), one
   * continuous rail overlay, one menu and one hover state no matter how many
   * runs carry it. Omit to render no chrome (tests/probes).
   */
  renderSegmentChrome?: (chrome: SegmentGroupChrome) => ReactNode
  topicId?: string
  expandedFoldSectionIds?: ReadonlySet<string>
  onToggleExpandFoldSection?: (sectionId: string) => void
  /**
   * Stable whole-turn selection IDs currently selected in edit mode. A folded
   * block reads it to know whether its own turns are part of the selection
   * (the block then paints the same outline a selected range paints).
   */
  selectedTurnAskIds?: ReadonlySet<string>
  /**
   * The folded block's own selection gesture. It only decides WHAT is selected
   * (the block's whole turns) — the caller applies the existing edit-selection
   * semantics, so the composition of ranges and boundaries is untouched.
   */
  onSelectFoldSection?: (askIds: string[], modifiers: { isCtrl: boolean; isShift: boolean }) => void
  /**
   * Per-block unfold-WRITE capability: true when every block member message is
   * mutable through the active route (Main remains the final validator of the
   * atomic turn-fold write). The check is per actual message id — never per
   * segment owner, since a group's head owner can differ from a member's
   * route. Omit to keep the default-true behavior (probes/fixtures without a
   * capability snapshot); browse expand is never gated by this.
   */
  isUnfoldAllowedForMessageIds?: (messageIds: readonly string[]) => boolean
  /**
   * Main route-qualified projection of the topic catalog for the CURRENT
   * route (same source the drawer lists), keyed by segment id. The chrome
   * resolves each group's mutation authority from its qualified entry
   * (`headerOwnedByRoute`) — never from a raw catalog owner compare. Absent
   * entries (unqualified/pending, or groups with no reachable member on this
   * route) gate fail-closed to read-only; the qualification fetch's own
   * refetch/invalidation recovers the owner verdict when it lands.
   */
  routeSegmentsById?: ReadonlyMap<string, RouteScopedSegment>
}

/**
 * Resolved per-run segment chrome base: the owning segment plus its position
 * flags inside this run.
 */
export interface RunSegmentChromeBase {
  segment: TopicSegment
  isFirst: boolean
  isLast: boolean
  messageCount?: number
}

// Group-level presentation payload handed to the group boundary renderer. It
// is resolved ABOVE the run/selection composition: one entry per mounted
// group, merged from every carrying run, so the chrome never depends on how
// the flow split the group or on which selection range wraps which run.
export interface SegmentGroupChrome extends SegmentGroupPresentation {
  // The group's authority membership size (header badge).
  messageCount: number
  // Display count for the header badge: the route-qualified TURN count from
  // the route projection (user + same-askId answers = 1, folded and
  // off-window members included). Optional so old callers without a route map
  // stay valid — and NEVER backfilled from messageCount: unknown stays
  // hidden instead of mislabeling messages as turns.
  turnCount?: number
  // Main route-qualified entry for this group on the current route (same
  // source the drawer lists). Null when the map was provided but the group
  // has no qualified entry (or no reachable member); undefined when the
  // caller provided no map at all (probes/fixtures). Both gate fail-closed.
  routeSegment?: RouteScopedSegment | null
}

/**
 * Resolve the segment chrome for one turn run from its member groups.
 * `buildOrderedFlowItems` enforces a segment-homogeneous run (every member
 * shares one segment, or every member is unsegmented), so this never has to
 * choose between segments: a run either yields its single owning segment's
 * chrome or none. The label anchors on the run member that is the owning
 * segment's authority first message, falling back to the first segmented
 * member when that anchor message lies outside the mounted window
 * (viewport-partial run); the rule spans the whole run, trimming its top on
 * the segment-first member and its bottom on the segment-last member —
 * matching the character of the per-group rule it replaces, aggregated to
 * the run that actually owns the content.
 */
export function deriveRunSegmentChrome(run: readonly FlowBodyEntry[]): RunSegmentChromeBase | null {
  let anchor: FlowBodyEntry | undefined
  for (const g of run) {
    if (g.segment && g.segmentIsFirst) {
      anchor = g
      break
    }
  }
  if (!anchor) anchor = run.find((g) => g.segment)
  if (!anchor?.segment) return null
  const isFirst = !!anchor.segmentIsFirst
  const isLast = run.some((g) => g.segmentIsLast)
  return {
    segment: anchor.segment,
    isFirst,
    isLast,
    messageCount: isFirst ? anchor.segment.messageCount : undefined
  }
}

/**
 * Compose the full message list from the explicit flow sequence.
 *
 * - Turn runs are computed over the flat mounted order with boundary
 *   flush, so one Q&A turn keeps a single EditTurn only while no divider
 *   intervenes — even same-askId groups split at a boundary. Liveness
 *   (`data-layer-kind` / `data-layer-run-id`) stays on each child body
 *   node, never on the turn.
 * - Selected contiguous ranges keep one atomic SelectionBlock outline.
 *   The range covers all selected turn runs plus every boundary node
 *   lying strictly between the first and last selected turn of the
 *   range (derived from sequence/range membership — no leading/interior
 *   divider hoisting). Boundaries at the leading/trailing edge of the
 *   range (before the first or after the last selected turn, or between
 *   selected and unselected content) compose outside the outline.
 * - Unselected runs render as bare turns whose hover ring is pure CSS —
 *   no hover state, no timers, no reparenting on hover.
 *
 * Resulting behavior:
 * - Selecting only the turn visually above the line excludes the line:
 *   the edge boundary renders outside (visually adjacent to) the outline.
 * - A continuous selection spanning both sides includes the interior
 *   boundary naturally inside the single unbroken outline — no split
 *   outlines, no duplicated IDs, no divider-specific visual hacks.
 */
export function renderEditFlowNodes({
  nodes,
  isEditMode,
  onTurnClick,
  renderSegmentChrome,
  topicId,
  expandedFoldSectionIds,
  onToggleExpandFoldSection,
  selectedTurnAskIds,
  onSelectFoldSection,
  isUnfoldAllowedForMessageIds,
  routeSegmentsById
}: RenderEditFlowNodesOptions): ReactNode[] {
  const ordered = buildOrderedFlowItems(nodes)
  const out: ReactNode[] = []

  const isRunFolded = (run: FlowBodyEntry[]): boolean => {
    return run.length > 0 && run.every((e) => e.isFolded === true)
  }

  // Group-level chrome composition over the ordered flow, resolved ABOVE the
  // run/selection composition (so it never depends on selection chunking):
  // - ONE presentation owner per mounted group. A group is one entity even
  //   when several runs carry it (a divider between two of its turns, a
  //   differing turn id, a viewport-partial membership) and even when those
  //   runs land in different selection ranges, so its presentation (header
  //   row, continuous rail, menu, hover) is owned once and every carrying run
  //   host only registers itself with that owner for measurement. No run paints
  //   a chrome of its own.
  // - ONE route-stable normal-flow slot per group: the run mounting the
  //   group's presentation start — its FIRST member in effective-route order,
  //   the member every route that still reaches the group also reaches at the
  //   same place (see routeGroupPresentation). The slot is a route-structure
  //   boundary rendered where that message appears; it is never elected from
  //   mounted fragments, so pagination/window changes cannot migrate it, and
  //   crossing a fork INSIDE the group cannot move it either. WHAT the slot
  //   shows is the route qualification's decision: the real header row when the
  //   group's stable head resolves on this route, otherwise an equal-height
  //   continuation row (same size and position, no head identity invented).
  //   Only a window without the slot hosts no row at all: its visual-top
  //   carrying run keeps the rail-only continuation (geometry carrier, zero
  //   in-flow occupancy). Header identity never depends on the folded/expanded
  //   presentation: React reconciles the SAME header node across the fold (a
  //   replaced node could only be committed already faded) and the interaction
  //   scope rides that run.
  const baseByRun = new Map<readonly FlowBodyEntry[], RunSegmentChromeBase>()
  const chromeByRun = new Map<readonly FlowBodyEntry[], SegmentGroupChrome>()
  /**
   * How many mounted turn runs carry each group in the CURRENT window. A folded
   * block whose runs cover that count completely is the whole group's mounted
   * extent, so its collapsed summary row is the group's stand-in for
   * measurement (see FoldedSection `rangeScopeIds`). A partially folded group
   * keeps the count larger than the block and is measured from its runs alone.
   */
  const runCountBySegment = new Map<string, number>()
  /**
   * Rail-only continuation hosts: one per group whose route-stable slot is
   * outside the CURRENT window. The visual-top carrying run keeps the group's
   * continuous rail (geometry carrier, zero in-flow occupancy) but never slot
   * occupancy, menus or hover.
   */
  const continuationByRun = new Map<readonly FlowBodyEntry[], { segmentId: string; color: string }>()
  /**
   * Equal-height continuation slots: one per group whose route-stable slot is
   * mounted but whose stable head resolves on ANOTHER route (a route-truncated
   * residual). The slot run hosts the same `32px` row the header would occupy —
   * so switching between such routes leaves the row, and every shared row
   * around it, in place — but paints only the group's rail: no pill, no hit
   * target, no menu, no invented head identity, and the reachable members stay
   * rendered.
   */
  const slotContinuationByRun = new Map<readonly FlowBodyEntry[], { segmentId: string; color: string }>()
  if (renderSegmentChrome) {
    // A provided route map is the production path: group chrome resolves from
    // the route-stable presentation start only. An omitted map (probes and
    // fixtures without route qualification) keeps the legacy window-relative
    // host so non-route tests stay meaningful.
    const routeMapProvided = routeSegmentsById !== undefined
    const groupBySegment = new Map<string, SegmentGroupChrome>()
    const carryingRunsBySegment = new Map<string, FlowBodyEntry[][]>()
    const firstMemberRunBySegment = new Map<string, readonly FlowBodyEntry[]>()
    for (const item of ordered) {
      if (item.kind !== 'turn-run') continue
      const base = deriveRunSegmentChrome(item.run)
      if (!base) continue
      baseByRun.set(item.run, base)
      runCountBySegment.set(base.segment.id, (runCountBySegment.get(base.segment.id) ?? 0) + 1)
      const existing = groupBySegment.get(base.segment.id)
      if (existing) {
        existing.firstMounted = existing.firstMounted || base.isFirst
        existing.lastMounted = existing.lastMounted || base.isLast
      } else {
        groupBySegment.set(base.segment.id, {
          segment: base.segment,
          firstMounted: base.isFirst,
          lastMounted: base.isLast,
          messageCount: base.segment.messageCount,
          turnCount: routeSegmentsById?.get(base.segment.id)?.turnCount,
          routeSegment: routeSegmentsById?.get(base.segment.id)
        })
      }
      let carrying = carryingRunsBySegment.get(base.segment.id)
      if (!carrying) {
        carrying = []
        carryingRunsBySegment.set(base.segment.id, carrying)
      }
      carrying.push(item.run)
      if (base.isFirst) firstMemberRunBySegment.set(base.segment.id, item.run)
    }
    for (const [segmentId, group] of groupBySegment) {
      const carrying = carryingRunsBySegment.get(segmentId) ?? []
      if (!routeMapProvided) {
        const headerRun = firstMemberRunBySegment.get(segmentId) ?? carrying[carrying.length - 1]
        if (headerRun) chromeByRun.set(headerRun, group)
        continue
      }
      // Production: the map entry IS the route qualification for this group on
      // the CURRENT route (the same source the drawer lists). No entry means
      // pending or unreachable on this route: fail closed with NO temporary
      // header from catalog or mounted fragments — the new route's group
      // structure appears together with its message window in the same
      // accepted snapshot, never as a provisional header that a later
      // qualification would have to move.
      const routeSegment = group.routeSegment
      if (!routeSegment) continue
      // Fail-closed coverage: the entry must actually cover this window. A
      // stale route's entry (none of its members in any mounted run) hosts
      // nothing, so a stale qualification can never render a header here.
      const memberSet = new Set(routeSegment.memberIds)
      const coversWindow = carrying.some((run) =>
        run.some((entry) => entry.messageIds?.some((id) => memberSet.has(id)) === true)
      )
      if (!coversWindow) continue
      // The ONE route-stable slot host: the run mounting the group's
      // presentation start. Window/pagination changes never re-elect it.
      const slotIndex = findStableStartRunIndex(carrying, routeSegment.presentationStartMessageId)
      const color = group.segment.color ?? getSegmentColor(group.segment.id)
      switch (
        resolveGroupSlotHost({
          hasMountedMember: true,
          slotInWindow: slotIndex >= 0,
          headerInRoute: routeSegment.headerInRoute
        })
      ) {
        case 'header':
          chromeByRun.set(carrying[slotIndex], group)
          break
        case 'continuation':
          slotContinuationByRun.set(carrying[slotIndex], { segmentId, color })
          break
        case 'rail-only': {
          // Slot outside the mounted window: no row at all, never a temporary
          // one. The last carrying run in render order (the group's mounted
          // visual top — the same run the layout manager anchors headless
          // geometry to) carries the rail-only continuation.
          const carrier = carrying[carrying.length - 1]
          if (carrier) continuationByRun.set(carrier, { segmentId, color })
          break
        }
        default:
          break
      }
    }
  }

  /**
   * One carrying run of the flow.
   *
   * `hideBodies` is the ONLY thing a collapsed fold block removes: the run host
   * (its chrome, its group rail registration, its turn identity) stays exactly
   * as in the expanded state and only the message bodies disappear. A collapsed
   * block therefore never unmounts a group's single header row or interrupts
   * its rail — the fold is a body-visibility decision, not a chrome one.
   */
  const renderTurnRun = (run: FlowBodyEntry[], isSelected: boolean, hideBodies = false) => {
    const chrome = chromeByRun.get(run)
    const base = baseByRun.get(run)
    // The slot run is the group's structural scope owner for same-route
    // in-place geometry: it spans the slot row AND the turn bodies, so it
    // survives the fold (a collapsed run keeps its entries and loses only its
    // body content height) and re-resolves to the same owner after the
    // mutation. Only the slot run carries the identity — every other carrying
    // run must never compete for it (one stable scope per group). A rail-only
    // continuation carrier registers as a rail-geometry carrier only
    // (`isHeader` false): the rail without slot occupancy.
    const scopeId = chrome ? chrome.segment.id : undefined
    const continuation = chrome ? undefined : continuationByRun.get(run)
    const slotContinuation = chrome || continuation ? undefined : slotContinuationByRun.get(run)
    return (
      <SegmentRunHost
        key={deriveTurnKey(run)}
        groupId={base?.segment.id}
        isHeader={!!chrome || !!slotContinuation}
        endsGroup={base?.isLast === true}
        scopeId={scopeId}>
        {chrome && renderSegmentChrome ? renderSegmentChrome(chrome) : null}
        {slotContinuation ? (
          <GroupSlotContinuation groupId={slotContinuation.segmentId} color={slotContinuation.color} />
        ) : null}
        {continuation ? <GroupRailContinuation groupId={continuation.segmentId} color={continuation.color} /> : null}
        {hideBodies ? null : (
          <EditTurn
            turnAskId={run[0]?.turnAskId ?? ''}
            isEditMode={isEditMode}
            isSelected={isSelected}
            onTurnClick={onTurnClick}>
            {run.map((g) => (
              <Fragment key={g.groupKey}>{g.bodyNode}</Fragment>
            ))}
          </EditTurn>
        )}
      </SegmentRunHost>
    )
  }

  let index = 0
  while (index < ordered.length) {
    const item = ordered[index]
    if (item.kind === 'turn-run' && isRunFolded(item.run)) {
      const foldedRuns: FlowBodyEntry[][] = []
      const messageIds: string[] = []
      while (index < ordered.length) {
        const next = ordered[index]
        if (next.kind !== 'turn-run' || !isRunFolded(next.run)) break
        foldedRuns.push(next.run)
        for (const entry of next.run) {
          if (entry.messageIds) {
            messageIds.push(...entry.messageIds)
          }
        }
        index += 1
      }
      // Block identity = the FIRST folded turn it contains, never the joined
      // list of its turns: a block grows at its open end when pagination adds
      // turns, and a key that changes with the window would silently drop the
      // user's own "I opened this block" state.
      const sectionKey = `folded-section:${deriveTurnKey(foldedRuns[0])}`
      // A navigation reveal addresses a MEMBER message id, so it opens whichever
      // block currently contains that row — stable however the block grew.
      const isExpanded =
        (expandedFoldSectionIds?.has(sectionKey) ?? false) ||
        (expandedFoldSectionIds ? messageIds.some((id) => expandedFoldSectionIds.has(id)) : false)
      // The block's stable whole-turn selection identity: the same askIds the
      // turn click uses, in flow order, de-duplicated (one turn may be carried
      // by more than one visual group of this block).
      const turnAskIds = [...new Set(foldedRuns.map((run) => run[0]?.turnAskId ?? '').filter((id) => id !== ''))]
      const selectedTurnCount = turnAskIds.filter((id) => selectedTurnAskIds?.has(id) === true).length
      const isSelected = turnAskIds.length > 0 && selectedTurnCount === turnAskIds.length
      // A block can be PART of the selection (Shift/Ctrl reaching only some of its
      // turns). It must say so instead of impersonating a fully selected block.
      const isPartiallySelected = selectedTurnCount > 0 && !isSelected
      // The groups this block carries, in flow order. They are the block's
      // viewport interaction scopes (a group's stable header host is the
      // same-route layout owner) and the anchors for its measured extent.
      const scopeIds = [
        ...new Set(foldedRuns.map((run) => baseByRun.get(run)?.segment.id ?? '').filter((id) => id !== ''))
      ]
      const blockRunCount = new Map<string, number>()
      for (const run of foldedRuns) {
        const segmentId = baseByRun.get(run)?.segment.id
        if (!segmentId) continue
        blockRunCount.set(segmentId, (blockRunCount.get(segmentId) ?? 0) + 1)
      }
      // Groups whose ENTIRE mounted extent is inside this block: their collapsed
      // summary row is what the group shows, so the block registers it as the
      // group's measured range member (never a static height, never for a group
      // that still has runs of its own outside the block).
      const rangeScopeIds = scopeIds.filter((id) => blockRunCount.get(id) === runCountBySegment.get(id))
      // Unfold-write capability for this block: every member message must be
      // mutable through the active route (per actual message id — never per
      // segment owner). An omitted capability keeps the prop default (true,
      // for probes/fixtures); an empty block never unfolds. Main remains the
      // final validator of the atomic write.
      const isUnfoldAllowed =
        isUnfoldAllowedForMessageIds !== undefined && messageIds.length > 0
          ? isUnfoldAllowedForMessageIds(messageIds)
          : isUnfoldAllowedForMessageIds === undefined
      out.push(
        <FoldedSection
          key={sectionKey}
          turnCount={foldedRuns.length}
          groupIds={turnAskIds}
          messageIds={messageIds}
          topicId={topicId ?? ''}
          scopeIds={scopeIds}
          rangeScopeIds={rangeScopeIds}
          isExpanded={isExpanded}
          onToggleExpand={() => onToggleExpandFoldSection?.(sectionKey)}
          isSelected={isSelected}
          isPartiallySelected={isPartiallySelected}
          selectedTurnCount={selectedTurnCount}
          isEditMode={isEditMode}
          isUnfoldAllowed={isUnfoldAllowed}
          onSectionSelect={(modifiers) => onSelectFoldSection?.(turnAskIds, modifiers)}>
          {/* Every folded run keeps its host and its group chrome; only the
              bodies leave the flow while the block is collapsed. */}
          {foldedRuns.map((run) => renderTurnRun(run, run[0]?.selected ?? false, !isExpanded))}
        </FoldedSection>
      )
      continue
    }
    if (item.kind === 'turn-run' && !item.run[0]?.selected) {
      out.push(renderTurnRun(item.run, false))
      index += 1
      continue
    }
    if (item.kind === 'boundary') {
      // Standalone edge boundary: interior boundaries are consumed by the
      // selected-range branch below via sequence membership. A boundary
      // reached here has no selected range starting here (either the next
      // turn-run is unselected/missing, or the previous chunk already
      // closed), so it composes outside any outline.
      out.push(<Fragment key={item.entry.boundaryKey}>{item.entry.node}</Fragment>)
      index += 1
      continue
    }
    // Contiguous selected chunk: consume selected UNFOLDED turn-runs and
    // boundaries until the next barrier or the end. A barrier is an unselected
    // turn-run or a folded turn-run: a folded run keeps its own collapsed
    // shell (selected or not) instead of being absorbed into the outline, so
    // the loop lands on it and the folded branch above renders it.
    const chunk: OrderedFlowItem[] = []
    while (index < ordered.length) {
      const next = ordered[index]
      if (next.kind === 'turn-run' && (!next.run[0]?.selected || isRunFolded(next.run))) break
      chunk.push(next)
      index += 1
    }
    const firstSelected = chunk.findIndex((c) => c.kind === 'turn-run')
    let lastSelected = -1
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i].kind === 'turn-run') {
        lastSelected = i
        break
      }
    }
    if (firstSelected === -1 || lastSelected === -1) {
      for (const c of chunk) {
        if (c.kind === 'boundary') {
          out.push(<Fragment key={c.entry.boundaryKey}>{c.entry.node}</Fragment>)
        }
      }
      continue
    }
    // Leading edge boundaries stay outside.
    for (let i = 0; i < firstSelected; i++) {
      const c = chunk[i]
      if (c.kind === 'boundary') {
        out.push(<Fragment key={c.entry.boundaryKey}>{c.entry.node}</Fragment>)
      }
    }
    const inner = chunk.slice(firstSelected, lastSelected + 1)
    const selectedRuns = inner.filter((c) => c.kind === 'turn-run').map((c) => (c as { run: FlowBodyEntry[] }).run)
    const head = selectedRuns.flat()[0]
    const rangeKey = deriveSelectionRangeKey(selectedRuns)
    const blockKind = head?.segmentIsLive ? 'live' : 'history'
    const blockLayerRunId = head?.layerRunId ?? ''
    out.push(
      <SelectionBlock
        key={deriveSelectionChunkKey(selectedRuns)}
        data-layer-kind={blockKind}
        data-stable-segment-id={rangeKey}
        data-layer-run-id={blockLayerRunId}>
        {inner.map((c) => {
          if (c.kind === 'boundary') {
            return <Fragment key={c.entry.boundaryKey}>{c.entry.node}</Fragment>
          }
          return renderTurnRun(c.run, true)
        })}
      </SelectionBlock>
    )
    // Trailing edge boundaries stay outside.
    for (let i = lastSelected + 1; i < chunk.length; i++) {
      const c = chunk[i]
      if (c.kind === 'boundary') {
        out.push(<Fragment key={c.entry.boundaryKey}>{c.entry.node}</Fragment>)
      }
    }
  }
  return out
}
