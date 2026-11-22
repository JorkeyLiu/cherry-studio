import { loggerService } from '@logger'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setTurnFoldsThunk } from '@renderer/store/thunk/turnFold'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import { Dropdown, type MenuProps } from 'antd'
import React, {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import styled, { css, keyframes } from 'styled-components'

import { FOLD_BROWSE_MOTION_MS, foldBrowseSpaceEasing, runFoldBrowseMotion } from './foldBrowseMotionDriver'
import {
  INTERACTION_RAIL_COLLAPSED_HEIGHT_PX,
  INTERACTION_RAIL_HIT_WIDTH_PX,
  INTERACTION_RAIL_LINE_WIDTH_PX,
  INTERACTION_RAIL_OUTSET_PX,
  InteractionRailHitTarget,
  InteractionRailLine
} from './GroupInteractionRail'
import {
  captureInteractionIntent,
  type DeferredLayoutGestureToken,
  INTERACTION_REGION_SEGMENT_HEADER,
  markInteractionLayoutDeferred,
  settleInteractionLayoutDeferred,
  useOptionalRouteViewportCommands
} from './routeViewportContext'
import { useSegmentGroupLayoutManager } from './SegmentGroupPresentation'

const logger = loggerService.withContext('FoldedSection')

/**
 * One folded block: a contiguous run of whole turns whose member rows all carry
 * the message-level fold marker.
 *
 * Presentation contract of this block:
 * - The block is ONE object. Collapsed it is a single summary target; expanded
 *   it is a browse view of its own turns (the fold state itself is unchanged —
 *   browsing never restores context participation).
 * - The block owns exactly ONE context menu. Its single header/rail region
 *   opens the same controlled menu in both states and CLAIMs the right-click
 *   gesture, so the message list's own context-menu host never opens a
 *   second, conflicting menu. In expanded browse the block's message bodies
 *   are not the block's chrome: they keep their ordinary message menu.
 * - The block is a first-class selection object in edit mode: a right-click
 *   selects the whole block when it is not already part of the current
 *   selection (the ordinary rule of the turn edge), and the selected block
 *   paints one clear outline (the same ring the selected turn range uses, same
 *   token, so a folded block and a normal range read as the same kind of
 *   thing). Collapsed, the summary row's own whitespace is a natural click
 *   target: it selects through the same plain / Ctrl(Meta)-toggle / Shift
 *   semantics as a turn cover, never expands, and never writes a fold change.
 *   The rail and the summary text stay a browse-only region in every state
 *   and mode (click or keyboard toggles the browse view, never the
 *   selection), and browsing never writes a fold change.
 */

// ==================== Single shell styles ====================

/**
 * The block's own outline for a FULLY selected block. Same ring geometry/token
 * as the selected turn range (`SelectionBlock`), so a selected folded block is
 * visually the same kind of object.
 */
const selectionRing = css`
   box-shadow: 0 0 0 1.5px var(--color-primary);
   border-radius: 10px;
 `

/**
 * A PARTIALLY selected block: some — not all — of its turns are in the
 * selection. It must never paint the full-selection ring (that would claim the
 * whole block is selected), so it gets a visibly weaker ring plus a stated
 * count, the only thing that can express "3 of 6 turns selected".
 */
const partialSelectionRing = css`
   box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--color-primary) 40%, transparent);
   border-radius: 10px;
 `

/**
 * Rail origin inside the fold header row. The fold track is pinned to this
 * offset in BOTH states, so the collapsed short line grows down from the
 * same point the expanded full line starts from, and the start never jumps
 * with the mode.
 */
export const FOLD_RAIL_ORIGIN_PX = 8
/**
 * Fold rail transverse baseline: the shared rail outset. `TopicSegmentLine`
 * paints its `GroupRail` at `-INTERACTION_RAIL_OUTSET_PX` relative to the body,
 * so the top-level fold rail sits at the same `-10px` and reads as the same
 * edge — never a second indent, never a body shift. The whole 2px line now
 * paints inside the ScrollContainer's own 10px left gutter.
 */
export const FOLD_RAIL_BASE_LEFT_PX = -INTERACTION_RAIL_OUTSET_PX

/**
 * Inward step for a fold nested INSIDE a group (double-line case). Derived
 * from the shared rail geometry so no magic offset scatters: hit (8px) +
 * line (2px) = 10px, i.e. baseline (-10px) + step (10px) = 0px. The nested
 * fold track then spans [0,2] beside the group track [-10,-8] with an 8px
 * clear gap — rails side by side, bodies untouched.
 */
export const FOLD_RAIL_NESTED_INSET_PX = INTERACTION_RAIL_HIT_WIDTH_PX + INTERACTION_RAIL_LINE_WIDTH_PX

/**
 * Clear gap between the VISIBLE fold line edge and the header text, shared by
 * both nest states. The text offset is always
 * `railLeft + INTERACTION_RAIL_LINE_WIDTH_PX + FOLD_HEADER_TEXT_GAP_PX`:
 * top-level -10 + 2 + 8 = 0 (at the body edge, 8px clear of the visible line),
 * nested 0 + 2 + 8 = 10 (8px clear of the nested line edge, never under the
 * 8px hit box). One named gap, no second gutter stacked on the old shell one.
 */
export const FOLD_HEADER_TEXT_GAP_PX = 8

/**
 * The block's ONE shell, shared by both states: one container, one content
 * container, one fixed title row, one rail track, one hit target, one
 * hover/focus state. Collapsed and expanded differ only in the title text, in
 * whether the carried runs show their bodies (decided above, via `hideBodies` —
 * the hosts, their chrome and their rail registrations stay mounted either
 * way), in the content container's height, and in the rail's length.
 *
 * It is a plain flow column, exactly like the run hosts it holds: the ONE
 * content container is its only flow child, and that container holds the title
 * row first (newest edge of the block) followed by the folded turns' own hosts.
 * The hosts are NOT children of the title row — a collapsed block must never
 * unmount a group's single header or interrupt its rail, so the runs it carries
 * keep their place in the flow and merely stop rendering bodies. Because the
 * title row lives INSIDE the animated content container, the block's browse
 * motion only ever changes space below the title row.
 *
 * No transverse indent lives here: `padding: 0` keeps carried bodies at the
 * exact x they have with no fold (fold/unfold before/after message left
 * identical). The only transverse offset is the absolute rail box plus the
 * title label's own local hit gap — bodies never move. `box-sizing` +
 * `min-width` keep the full-width stretch (selection ring included) from
 * growing `scrollWidth` once the old gutter is gone; the rail sticks out to
 * the same -10px gutter the group rail already uses, so no new overflow.
 */
const FoldShell = styled.div<{ $selected?: boolean; $partial?: boolean }>`
   position: relative;
   display: block;
   width: 100%;
   box-sizing: border-box;
   min-width: 0;
   padding: 0;
   margin: 4px 0;
   user-select: none;
   ${(props) => (props.$selected ? selectionRing : props.$partial ? partialSelectionRing : null)}
 `

/**
 * The ONE rail box, identical in both modes (collapsed/expanded share the
 * same node, only the track length differs): same 8px hit width, full shell
 * height, same header origin. Only its transverse `left` follows the nest
 * state — baseline (-10px, the shared outset) at top level, one inset
 * step inward (0px) when `scopeIds` says this fold sits inside a group, so
 * the double line reads as two rails side by side. Absolute positioning:
 * bodies never move. No flex centering: a centered short line would drift
 * with the shell's content height instead of growing from the header origin.
 */
const FoldRailBox = styled.div<{ $nested?: boolean }>`
   position: absolute;
   left: ${(props) => (props.$nested ? FOLD_RAIL_BASE_LEFT_PX + FOLD_RAIL_NESTED_INSET_PX : FOLD_RAIL_BASE_LEFT_PX)}px;
   top: 0;
   bottom: 0;
   width: ${INTERACTION_RAIL_HIT_WIDTH_PX}px;
   z-index: 5;
 `

/**
 * The ONE rail track. It starts at the shared header origin in both states;
 * collapsed it is the 20px short line growing down from that origin,
 * expanded it runs from the same origin to the content tail.
 */
const FoldRailTrack = styled.div<{ $expanded: boolean }>`
   position: absolute;
   left: 0;
   top: ${FOLD_RAIL_ORIGIN_PX}px;
   width: ${INTERACTION_RAIL_LINE_WIDTH_PX}px;
   ${(props) => (props.$expanded ? 'bottom: 0;' : `height: ${INTERACTION_RAIL_COLLAPSED_HEIGHT_PX}px;`)}
 `
/**
 * The ONE fixed title row, identical in both states: same font context, same
 * line height, same padding, same min-height, same label baseline.
 *
 * It is the FIRST flow child of the content container, i.e. a fixed part of
 * the animated box rather than a band laid out beside it. Two consequences,
 * both required by the browse motion: the collapsed container height already
 * includes this row (so no summary height ever enters or leaves the flow on
 * its own), and the row's box never depends on the animated height — the space
 * a browse motion opens or closes is strictly below it.
 *
 * Only the label text differs (folded count vs. expanded preview hint); the
 * rail origin above is measured against this row either way, so the rail start
 * never jumps with the mode.
 */
const FoldHeaderRow = styled.div`
   position: relative;
   display: flex;
   align-items: center;
   min-height: 32px;
   padding: 6px 0;
   user-select: none;
 `

/**
 * Edit-mode collapsed selection surface: the summary row's own natural click
 * area. A transparent absolute layer over the row's whitespace ONLY — the
 * rail hit target lives outside this row (shell-level, z-index 5) and the
 * summary label paints above this layer (z-index 1), so neither browse
 * affordance is ever swallowed. Rendered ONLY collapsed + edit mode:
 * expanded turns keep their own per-turn covers, and ordinary-mode blank
 * space stays inert (no expand, no select).
 *
 * Plain non-focusable descriptive layer (aria-hidden, no tabIndex/role, no
 * strings), mirroring EditTurnCover: the click carries ctrl/meta/shift to
 * the block's existing batch gesture, clicks never expand, and the batch
 * context menu keeps its own right-click path.
 */
const FoldSelectCover = styled.div`
   position: absolute;
   inset: 0;
   z-index: 0;
   background: transparent;
   cursor: pointer;
 `

/**
 * The ONE fold header text primitive, shared by the collapsed and the
 * expanded state: same font, same color, same class, same offset rule in both
 * modes — only the nest state moves it. No banner, no colored dot, no
 * left/right rules, no tooltip: the rail + text are ONE interactive region
 * that browses on click without any hover tag. Hovering either end lights
 * BOTH ends: `$active` is the region's single hover/focus state, the same
 * state that lights the shared rail line.
 *
 * The label carries the block's ONLY transverse text offset, measured from
 * the VISIBLE line edge: `railLeft + LINE_WIDTH + FOLD_HEADER_TEXT_GAP_PX`.
 * Top-level the rail sits at -10 so the text lands at 0 — at the body edge,
 * 8px clear of the visible line. Nested the rail steps to 0 so the text lands
 * at 10, 8px clear of the nested line edge and never under the 8px hit box. Local
 * to this label: the shell keeps `padding: 0` and carried bodies never move.
 */
const FoldSummaryLabel = styled.button<{ $active?: boolean; $nested?: boolean }>`
   /* Above the edit-mode selection surface: text clicks keep reaching the
   label's own browse toggle, never the layer beneath. */
   position: relative;
   z-index: 1;
   display: inline-flex;
   align-items: center;
   gap: 6px;
   padding: 2px 8px 2px ${(props) => (props.$nested ? FOLD_RAIL_BASE_LEFT_PX + FOLD_RAIL_NESTED_INSET_PX + INTERACTION_RAIL_LINE_WIDTH_PX + FOLD_HEADER_TEXT_GAP_PX : FOLD_RAIL_BASE_LEFT_PX + INTERACTION_RAIL_LINE_WIDTH_PX + FOLD_HEADER_TEXT_GAP_PX)}px;
   background: transparent;
   border: none;
   color: ${(props) => (props.$active ? 'var(--color-text-1)' : 'var(--color-text-2)')};
   font-size: 12px;
   cursor: pointer;
   outline: none;
   text-align: left;
   white-space: nowrap;
   transition: color 0.15s ease;

   &:focus-visible {
     outline: 2px solid var(--color-primary);
     outline-offset: 1px;
     border-radius: 6px;
   }

   @media (prefers-reduced-motion: reduce) {
     transition: none;
   }
 `

/**
 * The partial-selection count. It is the honest indicator for a block that is
 * only partly in the selection: the block states how many of its turns are
 * selected instead of pretending the whole block is selected.
 */
const PartialHint = styled.span`
   font-size: 11px;
   color: var(--color-text-2);
   padding: 1px 5px;
   border-radius: 4px;
   border: 1px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
   white-space: nowrap;
 `

// ==================== Browse view: ONE content container ====================

/**
 * Browse expand/collapse motion.
 *
 * The browse toggle (`isExpanded`) is local UI state: no fold write, no
 * persistence, no navigation. It changes what the block SHOWS, never which
 * nodes the block is made of.
 *
 * One node owns the browse geometry: `FoldContent`, the block's single content
 * container, keeps the fixed title row as its first child and the carried runs
 * below it. Collapsed its height is exactly its own content (title row plus the
 * chrome that stays), expanded it is exactly the browse view, so BOTH settled
 * states are plain `height: auto` — no measured height is stored and no `0px`
 * body box exists to become an endpoint. The motion animates THAT box's height
 * between two measured pixel values with `overflow: hidden`, so the growing or
 * closing space is the container's own box, and the title row — its first flow
 * child at an unmoving top edge — keeps its exact place for the whole gesture.
 * No summary band is inserted above or removed below the animated space, so
 * there is no ±summary-height jump to compensate.
 *
 * One time base, matching the old CSS space curve through the JS driver
 * (`foldBrowseMotionDriver`: `cubic-bezier(0.65, 0, 0.35, 1)` over 200ms): a
 * concrete pixel length (a percentage/`auto` height in an indefinite-height
 * box is not interpolable), a fresh driver per motion so a reversal starts
 * from the live values, settle from the driver's own completion promise
 * (never a WAAPI `finished` probe, never a timer), and
 * `prefers-reduced-motion` (or no frame clock, e.g. jsdom) settles in the
 * same pre-paint pass.
 *
 * Endpoints are live geometry, never a guessed summary height:
 * - opening: `from` is the container's live collapsed height (its mid-motion
 *   height on a reversal) and `to` is the natural expanded height, measured in
 *   the pre-paint measure pass while the new bodies are already mounted;
 * - closing: `from` is the container's live height (which still shows the
 *   browse bodies in the pre-commit pass) and `to` is the collapsed height the
 *   block itself had while it was collapsed — recorded while it was really
 *   collapsed, never derived from the title row alone, because the collapsed
 *   block also keeps whatever run chrome stays behind.
 *
 * Bodies are never unmounted mid-motion: the last expanded children stay
 * rendered, clipped by the closing container, until the settle. Only the
 * opening direction fades, and only the body region fades — the title row is
 * chrome and never fades.
 *
 * Every height the driver writes is settled synchronously through the
 * `settleLayout` command (the message list's keeper hold) in the same frame,
 * so the browser never paints an intermediate layout the keeper has not
 * already absorbed. No viewport intent is armed and no scroll compensation
 * is wired here: the keeper absorbs each committed step as layout
 * compensation, exactly like the ordinary observer loop — only synchronously.
 */
const BROWSE_OPEN_FADE_MS = 200
const BROWSE_OPEN_FADE_DELAY_MS = 0

/**
 * One shared motion window for the whole browse gesture: the JS-driven space
 * and the fade that joins the expansion run on the same time base instead of
 * serialising into "fade, then a dead gap, then a size step".
 */
const BROWSE_FADE_EASING = 'cubic-bezier(0.3, 0, 0.7, 1)'
/** Opacity the opening fade lands at: the settled browse dim, so the settle is seamless. */
const BROWSE_OPEN_FADE_TO = 0.95

const BROWSE_FADE_TO_VAR = '--browse-fade-to'
const BROWSE_FADE_DURATION_VAR = '--browse-fade-duration'
const BROWSE_FADE_DELAY_VAR = '--browse-fade-delay'

/** One fade keyframe pair PER DIRECTION, never one shared pair (see SegmentFoldTransition). */

const browseFadeExpand = keyframes`
  from {
    opacity: 0;
  }
  to {
    opacity: var(${BROWSE_FADE_TO_VAR});
  }
  /* Expand direction: own animation identity, see above. */
`

const browseFadeCollapse = keyframes`
  from {
    opacity: var(${BROWSE_FADE_TO_VAR});
  }
  to {
    opacity: 1;
  }
  /* Collapse direction: own animation identity, fading the browse dim out so the settle lands with no opacity step. */
`

type BrowseMotionPhase = 'expanding' | 'collapsing'

interface BrowseMotion {
  phase: BrowseMotionPhase
  from: number
  /** `null` is the measure pass: the new children render unclipped for one pre-paint pass. */
  to: number | null
}

interface BrowsePresentation {
  expanded: boolean
  motion: BrowseMotion | null
}

const isBrowseMotionAvailable = (): boolean => {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false
    // The driver owns the space through `requestAnimationFrame`: without
    // frames there is no interpolation, so the settled state must apply
    // immediately (jsdom, non-animating engines).
    if (typeof window.requestAnimationFrame !== 'function') return false
    // A missing matchMedia is "no recorded preference", not "reduced motion":
    // real Electron always provides it, and CSS still disables the fade.
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return false
    }
    return true
  } catch {
    return false
  }
}

/** Live pixel height of the box, or 0 when nothing is measurable. */
const readBrowseHeight = (element: HTMLElement | null): number => {
  if (!element) return 0
  try {
    const rect = element.getBoundingClientRect()
    return Number.isFinite(rect.height) && rect.height > 0 ? rect.height : 0
  } catch {
    return 0
  }
}

/**
 * The block's ONE content container, in every state and through every motion.
 *
 * `shell > content > (title row, body region)` is the whole visual tree, and it
 * is never replaced — so the title row, the hit target and the carried runs
 * keep their DOM nodes (and everything hanging off them: hover, focus, scroll
 * position, selection, media state) across the browse toggle.
 *
 * Geometry, and why the title row lives INSIDE this box:
 * - the collapsed height of the container already contains the title row, so
 *   there is no separate summary band in the flow and no `0px` body box that
 *   would have to stand in for it;
 * - a height motion on this box grows or closes space strictly BELOW the title
 *   row, so the title row's box — and a pointer resting on it — stays exactly
 *   where it was for the whole gesture. Nothing here ever depends on the
 *   animated height for the chrome above it.
 *
 * `padding: 0` and no transform: carried bodies keep the exact x they have with
 * no fold, before/after fold and before/after unfold identical. The only
 * transverse offsets in this file belong to the absolute rail and the title
 * label's own local gap.
 *
 * Clipping is armed only while a motion runs: a settled block stays unclipped,
 * so the group rails painting at -10px inside the carried runs are never cut
 * off at rest.
 */
const FoldContent = styled.div`
  position: relative;
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  padding: 0;
  margin: 0;
  height: auto;

  /* Armed motion: the block's growable space is this box, clipped to its own
     height. The height itself is owned by the JS driver (inline style, one
     write per frame, keeper-settled synchronously) — CSS never animates it,
     so no painted frame can outrun the keeper. */
  &[data-browse-motion='true'] {
    overflow: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    &[data-browse-phase] {
      animation: none;
    }
  }
`

/**
 * The block's ONE body region: the single node that carries the carried runs in
 * the collapsed, expanding, expanded and collapsing states alike — the wrapper
 * is never swapped, so its children keep their keys and their nodes through
 * every motion boundary.
 *
 * It dims only (`opacity` in the browse view, fading in on the opening
 * direction): no padding, margin, or transverse transform may ever live here —
 * carried bodies keep their no-fold x in both states.
 *
 * It also IS the "not chrome" region of the block: a gesture that starts inside
 * these bodies keeps the message list's own context menu instead of the block's.
 */
const FoldBody = styled.div`
  position: relative;
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  padding: 0;
  margin: 0;
  transform: none;
  opacity: 1;

  &[data-browse-view='expanded'] {
    opacity: ${BROWSE_OPEN_FADE_TO};
  }

  &[data-browse-phase='expanding'] {
    animation: ${browseFadeExpand} var(${BROWSE_FADE_DURATION_VAR}) ${BROWSE_FADE_EASING} var(${BROWSE_FADE_DELAY_VAR})
      both;
  }

  &[data-browse-phase='collapsing'] {
    animation: ${browseFadeCollapse} var(${BROWSE_FADE_DURATION_VAR}) ${BROWSE_FADE_EASING} var(${BROWSE_FADE_DELAY_VAR})
      both;
  }

  @media (prefers-reduced-motion: reduce) {
    &[data-browse-phase] {
      animation: none;
    }
  }
`

// ==================== Component ====================

/** Pointer/keyboard modifiers of one edit-selection gesture. */
export interface FoldedSectionSelectionModifiers {
  isCtrl: boolean
  isShift: boolean
}

export interface FoldedSectionProps {
  /** Number of whole turns represented by this block (summary badge). */
  turnCount: number
  /**
   * Stable turn (group) ids of every turn in the block — each is the turn's
   * user message id. The block addresses its turns by these ids only; the rows
   * it happens to have loaded never define what gets unfolded.
   */
  groupIds: string[]
  /**
   * The groups this block carries, in flow order (a group's elected header host
   * is the same-route interaction scope of that group). The block uses the first
   * one as its own viewport interaction anchor: unfold restores whole turns
   * BELOW these headers, so the header row is what must stay put.
   *
   * A non-empty `scopeIds` (after dropping blanks) ALSO means this fold sits
   * INSIDE a group: only the absolute fold rail steps inward then, so the
   * double line reads as two rails side by side. Bodies never move.
   * `rangeScopeIds` must NOT drive this: it lists only WHOLE groups inside
   * the block, so a partially folded group (still a double line) would leak
   * through as top-level.
   */
  scopeIds?: readonly string[]
  /**
   * Groups whose ENTIRE mounted extent is inside this block. While the block is
   * collapsed its summary row stands in for those groups' bodies, so it
   * registers as their measured range member: the group's ONE rail then spans
   * the summary plus every mounted host instead of collapsing to zero length.
   * Empty for a partially folded group, which keeps measuring from its runs.
   */
  rangeScopeIds?: readonly string[]
  /**
   * Every message id carried by this block (all members of the current
   * segment groups, in flow order). Rendered as the stable
   * `data-folded-message-ids` token list on the collapsed root so a
   * navigation companion can locate the block holding a member WITHOUT
   * activating it (querying/measuring never expands).
   */
  messageIds?: string[]
  /** Every turn of the block is selected in edit mode. */
  isSelected?: boolean
  /** Some — not all — turns of the block are selected in edit mode. */
  isPartiallySelected?: boolean
  /** How many of the block's turns are selected (partial-selection hint). */
  selectedTurnCount?: number
  topicId: string
  /** Browse view open (the fold state itself is unaffected). */
  isExpanded: boolean
  onToggleExpand: () => void
  isEditMode?: boolean
  /**
   * The block's own selection gesture. Called with the pointer modifiers so the
   * caller can apply the existing edit-selection semantics (replace / toggle /
   * range extend) to the whole block.
   */
  onSectionSelect?: (modifiers: FoldedSectionSelectionModifiers) => void
  /**
   * Whether the unfold (context-restore) write is permitted from here.
   * Rendered as `disabled` on the unfold menu item; Main remains the final
   * validator of the atomic turn-fold write. Defaults to true: no reliable
   * renderer-side foreign-owner capability exists yet.
   */
  isUnfoldAllowed?: boolean
  children: ReactNode
}

export const FoldedSection: React.FC<FoldedSectionProps> = memo(
  ({
    turnCount,
    groupIds,
    messageIds = [],
    topicId,
    scopeIds,
    rangeScopeIds,
    isExpanded,
    onToggleExpand,
    isSelected = false,
    isPartiallySelected = false,
    selectedTurnCount = 0,
    isEditMode = false,
    onSectionSelect,
    isUnfoldAllowed = true,
    children
  }) => {
    const { t } = useTranslation()
    const dispatch = useAppDispatch()
    const activeRoute = useAppSelector((state) => selectActiveBranchId(state, topicId))
    const viewportCommands = useOptionalRouteViewportCommands()
    const groupLayoutManager = useSegmentGroupLayoutManager()
    const [isUnfolding, setIsUnfolding] = useState(false)
    // ONE linked region for both states: hovering the rail or the text lights
    // BOTH (the shared line paints the fold active color, the header text
    // steps up to text-1). Hover and focus are independent states; the region
    // is their legal aggregation, so leaving the hover never erases a held
    // keyboard focus. The group rail keeps its own hover rules; this state
    // never leaves the fold.
    const [hoverActive, setHoverActive] = useState(false)
    const [focusActive, setFocusActive] = useState(false)
    const railActive = hoverActive || focusActive

    /**
     * Nest state: a non-empty `scopeIds` (blanks dropped) means this fold sits
     * INSIDE a group, so only the absolute fold rail steps inward (baseline
     * -10px -> 0px) and the double line reads as two rails side by side.
     * `rangeScopeIds` never drives this — it lists only WHOLE groups, so a
     * partially folded group would leak through as top-level. Bodies, shell
     * padding, header origin, and both rail lengths never follow this flag.
     */
    const isNested = useMemo(() => scopeIds?.some((id) => id !== '') ?? false, [scopeIds])

    /**
     * The fixed header row is the group's stand-in while the block hides whole
     * groups: register it as the measured range member of every group whose
     * mounted extent this block covers, so the group's ONE rail spans the
     * header and its hosts (measured, never a static height). Expanding the
     * browse view re-registers nothing: the block then shows the real bodies.
     * The ref sits on the ONE header node, so no DOM swap happens with the
     * mode — only the registration comes and goes.
     */
    const headerRef = useRef<HTMLDivElement | null>(null)
    const rangeKey = rangeScopeIds && rangeScopeIds.length > 0 ? rangeScopeIds.join('\u0000') : ''

    /**
     * Unfold (restore context participation) of the whole block.
     *
     * ONE atomic turn-level command: the block supplies its turns by stable
     * group id, Main resolves each turn's complete membership (including the
     * members this window does not hold) and writes every fold flag in one
     * transaction. Nothing is reported as a success unless the whole block was
     * actually unfolded, and the selection is never touched here.
     *
     * The rows land only after that authority round-trip, so the gesture's
     * layout effect is captured and DECLARED deferred on the existing viewport
     * owner before the dispatch: the same in-place keeper that holds the
     * group's header row then arbitrates the arriving bodies (an unchanged DOM
     * in the gap is not a no-effect click). No local scrolling, no second
     * scroll owner, and the business anchor is untouched — a refused capture
     * (no provider, bottom pin, foreign scope) only skips the hold.
     */
    const handleUnfold = useCallback(async () => {
      if (isUnfolding || !isUnfoldAllowed) return
      const uniqueGroupIds = [...new Set(groupIds)].filter((id) => id !== '')
      if (uniqueGroupIds.length === 0) return
      setIsUnfolding(true)
      const controller = viewportCommands?.controller ?? null
      const anchorScopeId = scopeIds?.find((id) => id !== '') ?? ''
      const scope = { kind: 'group' as const, id: anchorScopeId }
      let deferred: DeferredLayoutGestureToken | null = null
      if (controller && anchorScopeId !== '') {
        if (captureInteractionIntent(controller, scope, INTERACTION_REGION_SEGMENT_HEADER)) {
          deferred = markInteractionLayoutDeferred(controller, scope, INTERACTION_REGION_SEGMENT_HEADER)
        }
      }
      let applied = false
      try {
        await dispatch(setTurnFoldsThunk(topicId, uniqueGroupIds, false, activeRoute))
        applied = true
      } catch (error) {
        // Privacy-safe: the folded flag is stable identity, never content, so
        // only the failure itself is logged.
        logger.error('Failed to unfold the folded block', error instanceof Error ? error : { reason: String(error) })
        window.toast?.error?.(t('chat.unfold_failed'))
      } finally {
        // `failed` drops the gesture fail-closed (no adopt, no snapshot); a
        // stale token never touches a newer gesture.
        settleInteractionLayoutDeferred(controller, deferred, applied ? 'applied' : 'failed')
        setIsUnfolding(false)
      }
      if (applied) window.toast?.success?.(t('chat.unfolded_success'))
    }, [activeRoute, dispatch, groupIds, isUnfoldAllowed, isUnfolding, scopeIds, t, topicId, viewportCommands])

    const contextMenuItems = useMemo<MenuProps['items']>(() => {
      return [
        {
          key: 'toggle',
          label: isExpanded ? t('chat.collapse_view') : t('chat.expand_view'),
          onClick: onToggleExpand
        },
        {
          key: 'unfold',
          label: t('chat.unfold_selected_turns'),
          danger: true,
          disabled: isUnfolding || !isUnfoldAllowed,
          onClick: () => void handleUnfold()
        }
      ]
    }, [handleUnfold, isExpanded, isUnfoldAllowed, isUnfolding, onToggleExpand, t])

    // ONE controlled menu for the whole block: both of its own surfaces share
    // the same open state, so no gesture can ever paint two menus. Opening
    // itself stays the trigger's job (`trigger={['contextMenu']}` captures the
    // pointer and writes open through `onOpenChange`), so the popup anchors at
    // the click instead of falling back to the full-width block geometry.
    const [menuOpen, setMenuOpen] = useState(false)
    // Message bodies in browse view keep their ordinary message menu: a
    // right-click starting inside the body region is never claimed here and
    // keeps bubbling to the message list's own context-menu host.
    const bodyRef = useRef<HTMLDivElement | null>(null)
    // The ONE content container is the node the browse motion measures, clips
    // and animates. It is deliberately a different node from the body region
    // above — the title row sits between them and must stay chrome — and both
    // are stable elements, so a motion can never lose the node it started on.
    const contentRef = useRef<HTMLDivElement | null>(null)
    // Browse-view motion state. Derived in the render pass that observes the
    // `isExpanded` flip (same rule as the authority fold): the box still
    // shows the previous presentation there, so the exit height reads
    // honestly and a reversal continues from what is actually on screen.
    const [browsePresentation, setBrowsePresentation] = useState<BrowsePresentation>(() => ({
      expanded: isExpanded,
      motion: null
    }))
    const browseMotionAvailableRef = useRef<boolean>(isBrowseMotionAvailable())
    /**
     * The collapsed geometry of this block, recorded while it really IS
     * settled collapsed. It is the honest closing endpoint: the collapsed
     * container holds the title row AND whatever run chrome stays behind, so
     * neither the title row's height nor any stored constant can stand in for
     * it. `null` until the block has actually been seen collapsed (it mounted
     * already expanded): a closing motion then settles in the same commit
     * instead of inventing an endpoint.
     */
    const collapsedHeightRef = useRef<number | null>(null)
    // The last expanded bodies, kept so the closing motion can still carry
    // them. Updated only while expanded, so a collapse always retains the
    // bodies it is closing over; the settle then renders the collapsed
    // children (bodies are never unmounted mid-motion, only after it
    // completes). Retaining the React nodes keeps their types and keys, so the
    // host nodes underneath are preserved instead of recreated. Shell-level
    // selection (ring, cover) always reads live props, never this ref, so a
    // selection change during the 200ms close applies at the settle instead of
    // going stale inside the retained tree.
    const retainedExpandedChildrenRef = useRef<ReactNode | null>(null)
    useLayoutEffect(() => {
      if (isExpanded) retainedExpandedChildrenRef.current = children
    }, [isExpanded, children])

    // Record the collapsed geometry whenever the block is settled collapsed —
    // the mount pass included, so the ordinary open/close sequence always has
    // an exact endpoint.
    useLayoutEffect(() => {
      if (browsePresentation.motion !== null || browsePresentation.expanded) return
      const live = readBrowseHeight(contentRef.current)
      if (live > 0) collapsedHeightRef.current = live
    }, [browsePresentation])

    if (browsePresentation.expanded !== isExpanded) {
      const nextMotion: BrowseMotion | null = (() => {
        if (!browseMotionAvailableRef.current) return null
        // Pre-commit: the container still shows the previous presentation, so
        // this is exactly what the user sees right now — and on a reversal the
        // live mid-motion height, never a snap back to an endpoint.
        const live = readBrowseHeight(contentRef.current)
        if (isExpanded) {
          const settledCollapsed = browsePresentation.motion === null && !browsePresentation.expanded
          const from = live > 0 ? live : readBrowseHeight(headerRef.current)
          if (from <= 0) return null
          if (settledCollapsed && live > 0) collapsedHeightRef.current = live
          // `to` is measured in the pre-paint pass below, once the new bodies
          // are mounted.
          return { phase: 'expanding', from, to: null }
        }
        const collapsed = collapsedHeightRef.current
        if (live <= 0 || collapsed === null || collapsed <= 0) return null
        // Both endpoints are known here: the live height (the bodies are still
        // shown) and the recorded collapsed height.
        return { phase: 'collapsing', from: live, to: collapsed }
      })()
      setBrowsePresentation({ expanded: isExpanded, motion: nextMotion })
    }

    // Measure pass (opening only): the expanded container commits unclipped and
    // at its natural height for one pre-paint layout pass, so the opening `to`
    // is the real height of the newly mounted bodies plus the title row — never
    // a guessed length — and only then the clip arms. Committed before paint,
    // so nothing flashes between the two passes.
    useLayoutEffect(() => {
      const { motion } = browsePresentation
      if (motion === null || motion.to !== null) return
      const natural = readBrowseHeight(contentRef.current)
      if (natural <= 0) {
        setBrowsePresentation((previous) => ({ expanded: previous.expanded, motion: null }))
        return
      }
      setBrowsePresentation((previous) =>
        previous.motion !== null && previous.motion.to === null
          ? { ...previous, motion: { ...previous.motion, to: natural } }
          : previous
      )
    }, [browsePresentation])

    // Settle from the JS-owned space driver (container height) together with
    // the body fade. Every height write lands first and the keeper settles
    // synchronously in the same frame through the `settleLayout` command —
    // the browser never paints an intermediate layout the keeper has not
    // already absorbed (the native-hit-test gap the old CSS keyframes left
    // open between a height step and the async RO settlement). Completion
    // comes from the driver's own promise (the last frame wrote the exact
    // endpoint), never from `getAnimations().finished` and never from a
    // timer; the space and the same-window CSS body fade land together.
    // No state is written after unmount, and a superseded motion (the inverse
    // flip) cancels its driver — the old completion never lands, so no stale
    // state is forced. Without a provider the command is a no-op (standalone
    // surfaces keep working).
    useLayoutEffect(() => {
      const { expanded, motion } = browsePresentation
      if (motion === null || motion.to === null) return
      const element = contentRef.current
      const settle = () => setBrowsePresentation(() => ({ expanded, motion: null }))
      const settleLayout = (): void => {
        try {
          viewportCommands?.settleLayout?.('fold-browse')
        } catch {}
      }
      if (!isBrowseMotionAvailable() || !element) {
        settle()
        return
      }
      const driver = runFoldBrowseMotion(element, motion.from, motion.to, {
        durationMs: FOLD_BROWSE_MOTION_MS,
        easing: foldBrowseSpaceEasing,
        onSettledLayout: settleLayout
      })
      let cancelled = false
      void driver.finished.then(() => {
        if (!cancelled) settle()
      })
      return () => {
        cancelled = true
        driver.cancel()
      }
    }, [browsePresentation, viewportCommands])

    // Driver-owned inline height is a motion-only artifact: once settled, the
    // container returns to natural `height: auto` in the same pre-paint pass,
    // and the keeper settles that cleanup synchronously too — so the space
    // the motion opened or closed never lingers as an inline height, and no
    // painted frame shows the cleanup unabsorbed.
    useLayoutEffect(() => {
      if (browsePresentation.motion !== null) return
      const element = contentRef.current
      if (!element || element.style.height === '') return
      element.style.height = ''
      try {
        viewportCommands?.settleLayout?.('fold-browse')
      } catch {}
    }, [browsePresentation, viewportCommands])

    /**
     * The block claims its own right-click. Claiming (not only opening) is what
     * makes the menu exclusive: the message list wraps the whole flow in its own
     * context-menu host, and an unclaimed gesture would open that second menu on
     * top of the block's.
     *
     * The handler never opens the menu itself: the trigger observes the same
     * gesture on its child and captures the pointer (`alignPoint`), which is
     * what anchors the popup at the click and what gives the menu its default
     * (content-sized, not trigger-width-matched) width. A manual `setMenuOpen`
     * here would leave the trigger without a pointer, so the popup would fall
     * back to the block's own box — full chat width, wrong position, and no
     * library hide action.
     *
     * In edit mode a right-click on the block is also the block's selection
     * gesture, with the ordinary rule of the turn edge: select it only when it is
     * not already part of the current selection, so an existing (possibly
     * multi-turn) selection is preserved.
     */
    const handleShellContextMenu = useCallback(
      (e: React.MouseEvent) => {
        if (isExpanded && bodyRef.current?.contains(e.target as Node)) {
          // The carried bodies are not the block's chrome: they keep the list's
          // ordinary message menu. The trigger wrapper has already opened this
          // menu before this origin handler runs, so close it again in the same
          // gesture and leave the event unclaimed for the ancestor host.
          setMenuOpen(false)
          return
        }
        e.preventDefault()
        e.stopPropagation()
        if (isEditMode && !isSelected) onSectionSelect?.({ isCtrl: false, isShift: false })
      },
      [isEditMode, isExpanded, isSelected, onSectionSelect]
    )
    /**
     * Dismissing the menu from the block's OWN chrome is the one interaction
     * the popup library cannot do for us: the trigger child counts as part of
     * the popup, so a click there is never an outside click. This
     * capture-phase dismiss on the block root runs outer-first and closes
     * through the one controlled state. It neither prevents nor selects: the
     * toggle guards below swallow the same click, while every other surface
     * keeps its own behavior.
     */
    const handleMenuDismissCapture = useCallback(() => {
      if (!menuOpen) return
      setMenuOpen(false)
    }, [menuOpen])

    /**
     * Intent division for the collapsed summary row (edit mode only):
     * - the whitespace surface (FoldSelectCover) SELECTS through the block's
     *   existing batch gesture (plain / Ctrl(Meta)-toggle / Shift) and never
     *   expands;
     * - the rail and the summary text (handleActivate) ONLY toggle the browse
     *   view — never the selection — in every state and mode.
     * Neither path writes a fold change: browsing is not context
     * participation, and selecting is not an unfold.
     */
    const handleActivate = useCallback(() => {
      // A click that dismissed the open menu (see handleMenuDismissCapture)
      // must never toggle the fold: opening/closing the menu changes no
      // fold state.
      if (menuOpen) return
      onToggleExpand()
    }, [menuOpen, onToggleExpand])
    const handleActivateKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault()
          e.stopPropagation()
          setMenuOpen(true)
          return
        }
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        // The keyboard gesture only toggles the browse view, like the click.
        handleActivate()
      },
      [handleActivate]
    )

    /**
     * Edit-mode collapsed selection gesture: the summary row's own whitespace
     * selects the whole block through the existing batch gesture (the caller
     * applies plain / toggle / range-extend semantics with the pointer
     * modifiers). It never expands: the rail and the text keep the browse
     * toggle. Parity with the turn cover: a menu-dismissing click selects
     * nothing, the gesture is claimed (no ancestor double handling), and a
     * primary-button press opens no native range.
     */
    const handleSelectClick = useCallback(
      (e: React.MouseEvent) => {
        // A click that dismissed the open menu (see handleMenuDismissCapture)
        // must never select: opening/closing the menu changes no selection.
        if (menuOpen) return
        e.preventDefault()
        e.stopPropagation()
        onSectionSelect?.({ isCtrl: e.ctrlKey || e.metaKey, isShift: e.shiftKey })
      },
      [menuOpen, onSectionSelect]
    )
    const handleSelectMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      // Parity with the turn cover: hand focus to the stable message viewport
      // so editable composer shortcuts stop intercepting edit-mode keys.
      e.currentTarget.closest<HTMLElement>('#messages')?.focus({ preventScroll: true })
    }, [])

    // The menu keeps the library default width (the group menus use no
    // overlay sizing either): `trigger={['contextMenu']}` anchors at the
    // pointer (`alignPoint`), so the stretch that matched the full-width
    // trigger box never applies and no per-popup width wrapper is needed.

    // One shell, one content container, one fixed title row, one rail, one hit
    // area, one hover state — no center pill, no banner, no collapse button, no
    // white tooltip. The fold is a browsing container, not a decorated divider:
    // one rail at the shell's left edge plus a quiet title row stating what is
    // folded.
    const partialHint = isPartiallySelected
      ? t('chat.folded_partial_selection', { selected: selectedTurnCount, total: turnCount })
      : null

    // Browse presentation, derived once for the whole tree below. `armed` means
    // the measured pixel endpoints are known, i.e. the height animation is
    // really playing; the frame between a flip and its measure pass commits
    // unclipped at its natural height and is never painted.
    const motion = browsePresentation.motion
    const armed = motion !== null && motion.to !== null
    const browsePhase = motion !== null && armed ? motion.phase : null
    // Single visual phase for chrome, track, summary, selection-hit, scope
    // registration and body visibility. `isExpanded` is the browse intent
    // (semantic, flips immediately); the visual projection follows the motion
    // so a collapse keeps the expanded chrome while bodies are still on
    // screen and flips atomically with the hide at settle — never a first
    // frame of collapsed chrome over retained bodies. Measure pass (expanding
    // with to null) already renders the new bodies, so it reads as expanding.
    const visualPhase: 'collapsed' | 'expanding' | 'expanded' | 'collapsing' =
      motion !== null ? motion.phase : browsePresentation.expanded ? 'expanded' : 'collapsed'
    const visualExpanded = visualPhase !== 'collapsed'
    // The body region keeps the browse dim for as long as the carried bodies are
    // on screen: expanded, expanding and collapsing alike. Only the settled
    // collapsed block shows the plain body region again.
    const browseView = visualPhase === 'collapsed' ? 'collapsed' : 'expanded'
    // Range registration follows the VISUAL collapsed state (not the immediate
    // intent): while bodies are still on screen the block shows the real
    // bodies, so the header must not yet stand in as their measured member.
    useLayoutEffect(() => {
      const manager = groupLayoutManager
      const element = headerRef.current
      if (!manager || visualPhase !== 'collapsed' || rangeKey === '' || !element) return
      const ids = rangeKey.split('\u0000')
      const disposers = ids.map((id) => manager.registerRangeMember(id, element))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, [groupLayoutManager, visualPhase, rangeKey])
    // Closing keeps the last expanded bodies rendered (clipped away as the space
    // closes) until the settle; every other state renders the children the flow
    // just gave this block. Same element types and keys either way, so the runs
    // underneath are updated in place and never recreated.
    const bodies = motion?.phase === 'collapsing' ? (retainedExpandedChildrenRef.current ?? children) : children
    // Opening measure pass (expanding, to null): the new bodies are already
    // mounted but the fade is not armed yet. Opacity 0 is layout-neutral, so
    // the natural height read stays honest; the armed fade then starts from 0
    // in the same pre-paint commit — no extra frame, no delay.
    const isOpeningMeasure = motion !== null && motion.phase === 'expanding' && motion.to === null
    const bodyStyle: CSSProperties | undefined = isOpeningMeasure ? { opacity: 0 } : undefined
    // Fade-only inline vars (inherited by the body region): the space is
    // owned by the JS driver (inline height + synchronous keeper settlement),
    // never by CSS vars, so no style here can move layout on its own.
    const motionStyle = (
      armed && motion !== null
        ? {
            [BROWSE_FADE_TO_VAR]: String(BROWSE_OPEN_FADE_TO),
            [BROWSE_FADE_DURATION_VAR]: `${BROWSE_OPEN_FADE_MS}ms`,
            [BROWSE_FADE_DELAY_VAR]: `${BROWSE_OPEN_FADE_DELAY_MS}ms`
          }
        : undefined
    ) as CSSProperties | undefined

    // The two states share the ONE shell node and the ONE content container
    // below (the mode test id only names the state for existing queries — the
    // DOM nodes themselves are stable across the toggle). They differ only in
    // the title text, in whether the carried runs show their bodies, in the
    // container's height and in the rail's length.
    const block = (
      <FoldShell
        data-testid={visualExpanded ? 'folded-section-expanded' : 'folded-section-collapsed'}
        data-fold-shell="true"
        data-expanded={visualExpanded ? 'true' : 'false'}
        data-fold-nested={isNested ? 'true' : 'false'}
        className="folded-section-shell"
        // Expanded browse expresses selection per turn (see the carried
        // SelectionBlock runs): the shell never paints an aggregate outline
        // and never reports one, whether the block is fully or partially
        // selected. Collapsed keeps the whole-section feedback.
        data-folded-section-selected={isSelected && !visualExpanded ? 'true' : 'false'}
        data-folded-section-partial={isPartiallySelected && !visualExpanded ? 'true' : 'false'}
        data-fold-region-active={railActive ? 'true' : 'false'}
        data-folded-group-ids={groupIds.join(' ') || undefined}
        data-folded-message-ids={messageIds.length > 0 ? messageIds.join(' ') : undefined}
        onContextMenu={handleShellContextMenu}
        onClickCapture={handleMenuDismissCapture}
        $selected={isSelected && !visualExpanded}
        $partial={isPartiallySelected && !visualExpanded}>
        <FoldRailBox
          $nested={isNested}
          className="folded-section-railbox"
          data-testid="folded-section-railbox"
          data-fold-nested={isNested ? 'true' : 'false'}>
          <FoldRailTrack
            $expanded={visualExpanded}
            className="folded-section-railtrack"
            data-testid="folded-section-rail-track"
            data-expanded={visualExpanded ? 'true' : 'false'}>
            <InteractionRailLine
              $color="var(--color-border)"
              $active={railActive}
              $activeColor="var(--color-primary)"
              data-testid="folded-section-rail-line"
            />
          </FoldRailTrack>
          <InteractionRailHitTarget
            type="button"
            onClick={handleActivate}
            onKeyDown={handleActivateKeyDown}
            onMouseEnter={() => setHoverActive(true)}
            onMouseLeave={() => setHoverActive(false)}
            onFocus={() => setFocusActive(true)}
            onBlur={() => setFocusActive(false)}
            data-testid={visualExpanded ? 'folded-section-gutter-rail' : 'folded-section-expand-btn'}
            // The hit target spans the whole shell height in BOTH states. Its
            // top edge is the shell's top edge, so a pointer resting on the
            // rail never leaves the target because the browse space below it
            // opens or closes.
            aria-label={t('chat.folded_turns_summary', { count: turnCount })}
          />
        </FoldRailBox>

        <FoldContent
          ref={contentRef}
          className="folded-section-content"
          data-testid="folded-section-content"
          data-browse-motion={armed ? 'true' : undefined}
          data-browse-phase={browsePhase ?? undefined}
          data-browse-expanded={visualExpanded ? 'true' : 'false'}
          style={motionStyle}>
          <FoldHeaderRow ref={headerRef} className="folded-section-head" data-testid="folded-section-header">
            {/* Edit-mode collapsed selection surface: the row's own whitespace
               selects the block (plain / Ctrl(Meta) / Shift) without expanding.
               The rail and the label above keep the browse toggle. */}
            {isEditMode && visualPhase === 'collapsed' ? (
              <FoldSelectCover
                data-testid="folded-section-select-cover"
                aria-hidden="true"
                onClick={handleSelectClick}
                onMouseDown={handleSelectMouseDown}
              />
            ) : null}
            <FoldSummaryLabel
              type="button"
              $active={railActive}
              $nested={isNested}
              onClick={handleActivate}
              onKeyDown={handleActivateKeyDown}
              onMouseEnter={() => setHoverActive(true)}
              onMouseLeave={() => setHoverActive(false)}
              onFocus={() => setFocusActive(true)}
              onBlur={() => setFocusActive(false)}
              data-testid="folded-section-expand-label">
              <span>
                {visualExpanded
                  ? t('chat.folded_preview_hint', { count: turnCount })
                  : t('chat.folded_turns_summary', { count: turnCount })}
              </span>
              {/* Aggregate counts belong to the collapsed whole-section feedback
                   only: expanded browse already shows each turn's own outline. */}
              {!visualExpanded && partialHint ? (
                <PartialHint data-testid="folded-section-partial-hint">{partialHint}</PartialHint>
              ) : null}
            </FoldSummaryLabel>
          </FoldHeaderRow>
          {/* The turned-off bodies' hosts: group chrome and rail stay mounted,
              and the wrapper itself is the same node in every state. */}
          <FoldBody
            ref={bodyRef}
            className="folded-section-body"
            data-testid="folded-section-body"
            data-browse-view={browseView}
            data-browse-phase={browsePhase ?? undefined}
            style={bodyStyle}>
            {bodies}
          </FoldBody>
        </FoldContent>
      </FoldShell>
    )

    return (
      <Dropdown
        open={menuOpen}
        onOpenChange={setMenuOpen}
        menu={{ items: contextMenuItems }}
        trigger={['contextMenu']}
        placement="bottomLeft"
        destroyOnHidden>
        {block}
      </Dropdown>
    )
  }
)

FoldedSection.displayName = 'FoldedSection'
