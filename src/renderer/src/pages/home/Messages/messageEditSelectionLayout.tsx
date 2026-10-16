import type { TopicSegment } from '@renderer/types/topicSegment'
import { Fragment, memo, type MouseEvent as ReactMouseEvent, type ReactNode, useCallback } from 'react'
import styled from 'styled-components'

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
 */
export const EditTurn = memo(
  ({ turnAskId, isEditMode = false, isSelected = false, onTurnClick, children }: EditTurnProps) => {
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
        data-testid="edit-turn"
        data-turn-ask={turnAskId || undefined}
        className={className}
        onClickCapture={isEditMode ? handleClickCapture : undefined}
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
  /** The group wrapper (group div only — never a divider). */
  bodyNode: ReactNode
}

export interface FlowBoundaryEntry {
  /** Stable divider identity, also used as the React key. */
  boundaryKey: string
  /** Divider family (fork vs context share the boundary node kind). */
  boundaryKind: 'fork' | 'context'
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
 */
export function deriveSelectionRangeKey(runs: readonly FlowBodyEntry[][]): string {
  const flat = runs.flat()
  const segmentIds = [...new Set(flat.map((g) => g.segmentId))]
  if (segmentIds.length === 1 && segmentIds[0]) return segmentIds[0]
  const turnKeys = runs.map((run) => deriveTurnKey(run)).join('|')
  return `range:${segmentIds.join('+')}:${turnKeys.length}:${turnKeys}`
}

interface RenderEditFlowNodesOptions {
  /** Mounted message flow in newest→oldest render order. */
  nodes: FlowNode[]
  isEditMode: boolean
  onTurnClick?: (askId: string, isCtrl: boolean, isShift: boolean) => void
  /**
   * Renders the owning topic-segment chrome (vertical rule + label) for one
   * turn run. It is invoked at the run chrome host — a sibling of the
   * interactive turn, outside its `inert` content and its click-capture
   * cover — so segment controls stay independently hit-testable while turn
   * selection is unaffected. Omit to render no chrome (tests/probes).
   */
  renderSegmentChrome?: (chrome: RunSegmentChrome) => ReactNode
}

/** Resolved per-run segment chrome feeding the chrome renderer. */
export interface RunSegmentChrome {
  segment: TopicSegment
  isFirst: boolean
  isLast: boolean
  messageCount?: number
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
export function deriveRunSegmentChrome(run: readonly FlowBodyEntry[]): RunSegmentChrome | null {
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
  renderSegmentChrome
}: RenderEditFlowNodesOptions): ReactNode[] {
  const ordered = buildOrderedFlowItems(nodes)
  const out: ReactNode[] = []

  const renderTurnRun = (run: FlowBodyEntry[], isSelected: boolean) => {
    const chrome = renderSegmentChrome ? deriveRunSegmentChrome(run) : null
    return (
      <RunHost key={deriveTurnKey(run)}>
        {chrome && renderSegmentChrome ? renderSegmentChrome(chrome) : null}
        <EditTurn
          turnAskId={run[0]?.turnAskId ?? ''}
          isEditMode={isEditMode}
          isSelected={isSelected}
          onTurnClick={onTurnClick}>
          {run.map((g) => (
            <Fragment key={g.groupKey}>{g.bodyNode}</Fragment>
          ))}
        </EditTurn>
      </RunHost>
    )
  }

  let index = 0
  while (index < ordered.length) {
    const item = ordered[index]
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
    // Contiguous selected chunk: consume selected turn-runs and boundaries
    // until the next unselected turn-run (barrier) or the end.
    const chunk: OrderedFlowItem[] = []
    while (index < ordered.length) {
      const next = ordered[index]
      if (next.kind === 'turn-run' && !next.run[0]?.selected) break
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
        key={rangeKey}
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
