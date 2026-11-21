import { useBranchRowActions } from '@renderer/pages/home/Messages/branchSelector/branchRowActions'
import { branchRowKey, buildForkScopeIndex } from '@renderer/pages/home/Messages/branchSelector/branchTreeModel'
import { BranchTreePanel } from '@renderer/pages/home/Messages/branchSelector/BranchTreePanel'
import type { TopicBranchWire } from '@renderer/services/db/types'
import type { Message } from '@renderer/types/newMessage'
import { Popover } from 'antd'
import { ChevronDown } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { BoundaryLabel, BoundaryPill, BoundaryPillButton, BoundaryRow, BoundaryRule } from './BoundaryPill'
import { forkMarkerLabel } from './forkPlacement'

/**
 * Fork-divider placement and menu helpers for topic-internal branches.
 *
 * `displayMessages` arrive oldest→newest; the render loop iterates groups
 * newest→oldest and the flow build reverses once into normal-flow DOM order. A
 * divider is a centered, rule-free flow row (no left-side absolute content), so
 * it never overlaps TopicSegmentLine's pointer region. A divider renders AFTER
 * its anchor group in DOM order (visually directly below the anchor message).
 *
 * The row shares the weak-boundary presentation used by the
 * history-reference divider (`BoundaryPill`): one compact neutral pill with no
 * left/right through-rules. The context-window boundary keeps its own strong
 * rule and is not part of this family. The row keeps the same box model, the
 * stable `dividerRowTestId` identity and the `data-divider-*` anchors, so the
 * captured divider offsets keep measuring the same row.
 *
 * Two forms per the UI contract:
 * - Untaken fork (main route, or a fork in the viewed route no child was
 *   taken at): the branch-count label followed by the chevron icon that marks
 *   the row as expandable. The popup includes the current route plus the
 *   direct child branches at the anchor.
 * - Taken fork (the viewed route passes through `taken` at the anchor): the
 *   taken branch name followed by the same chevron icon. The popup switches
 *   among the original/parent route at that fork and the sibling branches,
 *   with the current one selected.
 *
 * Popup binding: the same shared tree panel as the top selector (same rows,
 * current marker and copy/rename/delete handling; the fork entry hides the header),
 * scoped to the exact fork — the parent/original route as the display root
 * plus the branches sharing the same `parentBranchId + anchorMessageId`.
 * Unrelated anchors, ancestor chains above the parent and descendant branches
 * below the children never enter the scope. The popup overlays content and
 * never pushes in-flow layout.
 *
 * Closed and open states occupy the same layout height: the popup overlays
 * content via Popover and never pushes in-flow content.
 */

/** One route option inside a fork menu. `branchId` null = the parent/original route at the fork. */
export interface ForkRouteOption {
  branchId: string | null
  label: string
  selected: boolean
}

/** Anchor IDs in display order that have direct child branches on this route. */
export function findAnchorsWithChildren(
  displayMessages: readonly Message[],
  childrenByAnchor: Map<string, TopicBranchWire[]>
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of displayMessages) {
    const children = childrenByAnchor.get(m.id)
    if (children && children.length > 0 && !seen.has(m.id)) {
      seen.add(m.id)
      out.push(m.id)
    }
  }
  return out
}

/**
 * `takenChildAtAnchor` moved to `forkPlacement` so the outline's fork markers
 * and this divider resolve the same child from the same function. Re-exported
 * here to keep this module's existing surface intact.
 */
export { takenChildAtAnchor } from './forkPlacement'

/**
 * Option view of a fork scope: the parent/original route first, then the
 * direct child branches in (createdAt, id) order — the same set and order
 * `buildForkScopeIndex` renders as the scoped tree. `taken` (if any) is
 * selected; otherwise the parent/original route (the menu opener context) is
 * selected. The parent option carries `parentBranchId` (null = main route).
 */
export function forkRouteOptions(
  parentLabel: string,
  parentBranchId: string | null,
  childrenAtAnchor: readonly TopicBranchWire[],
  takenChildId: string | null
): ForkRouteOption[] {
  const ordered = [...childrenAtAnchor].sort(
    (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
  )
  const options: ForkRouteOption[] = [{ branchId: parentBranchId, label: parentLabel, selected: takenChildId === null }]
  for (const child of ordered) {
    options.push({
      branchId: child.id,
      label: child.name && child.name.length > 0 ? child.name : child.id,
      selected: child.id === takenChildId
    })
  }
  return options
}

/** Stable divider identity: same fork = same anchor + same parent route. */
export const buildDividerKey = (anchorMessageId: string, parentBranchId: string | null): string =>
  `${anchorMessageId}::${parentBranchId ?? 'main'}`

/** Test id for a logical divider row (stable across routes). */
export const dividerRowTestId = (anchorMessageId: string, parentBranchId: string | null): string =>
  `branch-fork-divider-${anchorMessageId}-${parentBranchId ?? 'main'}`
/**
 * Cross-boundary decision for a fork divider: actual owner compares (topicId, branchId).
 * Untaken (no taken child) keeps the same owner on both sides: pill with no rule.
 * Taken (the viewed route passes through `taken`) owns a different branch on the
 * far side: both sides paint themed dashed rules. Pure, no DOM.
 */
export const isForkDividerCrossOwner = (
  topicId: string,
  parentBranchId: string | null,
  taken?: TopicBranchWire | null
): boolean => {
  if (!taken) return false
  try {
    if (typeof taken.topicId === 'string' && taken.topicId !== topicId) return true
  } catch {
    return true
  }
  return (taken.id ?? null) !== (parentBranchId ?? null)
}

/**
 * Divider switch context passed from the clicked divider row to Messages.
 * Carries the stable divider identity plus the synchronously captured pixel
 * offset of the clicked row relative to `#messages` top. Messages restores
 * the SAME logical divider row to the SAME offset after the target route
 * window commits (never the nearest-message heuristic as primary).
 */
export interface DividerSwitchInfo {
  anchorMessageId: string
  parentBranchId: string | null
  dividerKey: string
  /**
   * Placement of the clicked divider: `'head'` means the fork inherits
   * nothing, so there is no message at the boundary to align to.
   */
  placement: 'message' | 'head'
  /** Row top - container top at click time; null when unmeasurable. */
  dividerOffset: number | null
}

/** Capture a divider row's offset relative to a container (null-safe). */
export const captureDividerOffset = (dividerEl: HTMLElement | null, container: HTMLElement | null): number | null => {
  if (!dividerEl || !container) return null
  try {
    return dividerEl.getBoundingClientRect().top - container.getBoundingClientRect().top
  } catch {
    return null
  }
}

/**
 * Divider restore decision (pure): which anchor to align after the target
 * route commits. Priority: same logical divider row → shared message visual
 * anchor → fork message. A head fork boundary has no message, so it never
 * becomes a message target. Never bottom.
 */
export const decideDividerRestoreTarget = (input: {
  dividerKeyPresentInTarget: boolean
  sharedVisualMessageId: string | null
  /** Fork anchor message; null for a head boundary (no message exists there). */
  forkAnchorMessageId: string | null
}): { kind: 'divider-row' | 'shared-message' | 'fork-message'; targetId: string | null; dividerKey: string | null } => {
  if (input.dividerKeyPresentInTarget) {
    return { kind: 'divider-row', targetId: null, dividerKey: '__divider__' }
  }
  if (input.sharedVisualMessageId) {
    return { kind: 'shared-message', targetId: input.sharedVisualMessageId, dividerKey: null }
  }
  if (input.forkAnchorMessageId === null) {
    return { kind: 'divider-row', targetId: null, dividerKey: null }
  }
  return { kind: 'fork-message', targetId: input.forkAnchorMessageId, dividerKey: null }
}

interface ForkDividerProps {
  topicId: string
  anchorMessageId: string
  /** Taken branch at this anchor (undefined = untaken fork). */
  taken?: TopicBranchWire
  /** Direct child branches at this anchor (non-empty scope set, single anchor). */
  children: TopicBranchWire[]
  /** Parent route of the children at this fork (null = main route). */
  parentBranchId: string | null
  /** Label of the parent/original route at this fork (topic or parent branch name). */
  parentLabel: string
  /** Current active route (for delete-fallback convergence). */
  activeBranchId: string | null
  /** Placement resolved against the route's inheritance boundary (default: message). */
  placement?: 'message' | 'head'
  onSelectRoute: (branchId: string | null, anchorMessageId: string, info?: DividerSwitchInfo) => void
}

/**
 * One fork divider at an anchor. Taken forks render the selected branch
 * name as the switcher; untaken forks render the branch-count form. The
 * popup is the shared branch-route tree panel, scoped to this exact fork —
 * the parent/original route as the display root plus its direct children at
 * the anchor — with the same rows, current marker and copy/rename/delete
 * handling as the top selector, but without the header (tree only). It
 * overlays content and never pushes layout. Switching targets the shared anchor/current vicinity — never
 * bottom (the caller preserves the visual reference without touching sidebar
 * topic identity). The main/original route row carries no branch management;
 * when the parent/original route is itself a branch, that row allows the same
 * copy/rename/delete operations as any branch row.
 */
export const ForkDivider = ({
  topicId,
  anchorMessageId,
  taken,
  children,
  parentBranchId,
  parentLabel,
  activeBranchId,
  placement = 'message',
  onSelectRoute
}: ForkDividerProps) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  /** Bumped per open so the tree always starts from the fork scope's floor. */
  const [openCount, setOpenCount] = useState(0)
  /**
   * The popover's settled visibility, reported by antd once the panel is
   * really on screen. The tree only measures from a laid-out panel, so this
   * is its "you may measure now" signal — never the mere mount of the content.
   */
  const [treeVisible, setTreeVisible] = useState(false)
  // Derived scope, single source: the parent/original route plus its direct
  // children at this anchor — never another anchor, ancestor chain or
  // descendant. Derived during render; no effects, no second index.
  const scopeIndex = useMemo(() => buildForkScopeIndex(parentBranchId, children), [parentBranchId, children])
  /** Route the scope marks current: the taken child if any, else the parent/original. */
  const scopeCurrent = taken?.id ?? parentBranchId
  const resolveBeforeName = useCallback(
    (branchId: string): string | null => {
      if (branchId === parentBranchId) return parentLabel
      return children.find((child) => child.id === branchId)?.name ?? null
    },
    [children, parentBranchId, parentLabel]
  )
  const rowActions = useBranchRowActions({ topicId, activeBranchId, resolveBeforeName })
  // One shared two-state decision (branch name vs. children-here count) with
  // the outline's fork marker, so both surfaces name the same thing.
  const dividerLabel = forkMarkerLabel(taken, children, t)

  const handleSelectScopeRoute = (branchId: string | null): void => {
    // Selecting the already-current route only closes, never navigates.
    if ((branchId ?? null) === scopeCurrent) {
      setOpen(false)
      return
    }
    setOpen(false)
    const esc =
      typeof CSS !== 'undefined' && typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
        ? (CSS as unknown as { escape: (v: string) => string }).escape
        : (v: string) => v
    let dividerOffset: number | null = null
    try {
      const container = document.getElementById('messages')
      const key = buildDividerKey(anchorMessageId, parentBranchId)
      const row =
        (document.querySelector(`[data-divider-key="${esc(key)}"]`) as HTMLElement | null) ??
        (document.querySelector(
          `[data-testid="${esc(dividerRowTestId(anchorMessageId, parentBranchId))}"]`
        ) as HTMLElement | null)
      dividerOffset = captureDividerOffset(row, container)
    } catch {
      dividerOffset = null
    }
    onSelectRoute(branchId, anchorMessageId, {
      anchorMessageId,
      parentBranchId,
      dividerKey: buildDividerKey(anchorMessageId, parentBranchId),
      placement,
      dividerOffset
    })
  }

  // A successful delete dismisses this divider's popup (the refreshed catalog
  // re-resolves the divider itself); a failed one stays open on the error.
  const handleConfirmDelete = async (branchId: string): Promise<void> => {
    if (await rowActions.confirmDelete(branchId)) setOpen(false)
  }

  // Dismissing the delete confirmation reaches this popover as an outside
  // press, so the popup closes with it — the same path as any other outside
  // press. Only the top selector keeps its tree open across a confirmation.
  const handleDeleteConfirmChange = useCallback((): void => {
    // Intentionally no guard: the fork popup dismisses with outside presses.
  }, [])

  const content = (
    <div data-testid={`branch-fork-list-${anchorMessageId}`}>
      <BranchTreePanel
        key={openCount}
        index={scopeIndex}
        topicName={parentLabel}
        displayRootKey={branchRowKey(parentBranchId)}
        displayRootLabel={parentLabel}
        activeBranchId={scopeCurrent}
        visible={treeVisible}
        onSelectRoute={handleSelectScopeRoute}
        onCommitRename={rowActions.commitRename}
        onConfirmDelete={handleConfirmDelete}
        deletingBranchId={rowActions.deletingBranchId}
        onCopyBranch={rowActions.copyBranch}
        copyingBranchId={rowActions.copyingBranchId}
        onDeleteConfirmChange={handleDeleteConfirmChange}
        maxWidth={FORK_PANEL_MAX_WIDTH}
        minWidth={FORK_PANEL_MIN_WIDTH}
        showHeader={false}
      />
    </div>
  )

  const dividerKey = buildDividerKey(anchorMessageId, parentBranchId)
  const rowTestId = dividerRowTestId(anchorMessageId, parentBranchId)

  const crossOwner = isForkDividerCrossOwner(topicId, parentBranchId, taken ?? null)
  return (
    <ForkDividerRow
      data-testid={rowTestId}
      data-divider-key={dividerKey}
      data-divider-anchor={anchorMessageId}
      data-divider-parent={parentBranchId ?? 'main'}
      data-divider-placement={placement}
      data-divider-cross={crossOwner ? 'true' : 'false'}>
      {/* Legacy anchor-only id retained as an alias for existing queries. */}
      <span data-testid={`branch-fork-divider-${anchorMessageId}`} style={{ display: 'none' }} aria-hidden />
      {crossOwner ? <BoundaryRule data-boundary-rule="dash" aria-hidden /> : null}
      <Popover
        content={content}
        trigger="click"
        placement="bottom"
        open={open}
        afterOpenChange={(next) => setTreeVisible(next)}
        onOpenChange={(v) => {
          if (v) {
            // Remount the panel per open, so the tree always starts from the
            // fork scope's floor instead of a previous open's expansion.
            setOpenCount((count) => count + 1)
            setOpen(true)
            return
          }
          setTreeVisible(false)
          setOpen(false)
        }}
        destroyOnHidden>
        <ForkDividerNameButton
          data-testid={taken ? `branch-fork-selected-${anchorMessageId}` : `branch-fork-toggle-${anchorMessageId}`}
          type="text"
          size="small"
          autoInsertSpace={false}
          aria-expanded={open}
          aria-label={t(open ? 'chat.topics.branch.collapse' : 'chat.topics.branch.expand')}>
          <BoundaryPill data-boundary-pill="surface">
            <BoundaryLabel data-boundary-label>{dividerLabel}</BoundaryLabel>
            <ChevronDown size={14} aria-hidden />
          </BoundaryPill>
        </ForkDividerNameButton>
      </Popover>
      {crossOwner ? <BoundaryRule data-boundary-rule="dash" aria-hidden /> : null}
    </ForkDividerRow>
  )
}

/**
 * Fork scope panel width budget: the fork popup shows the shared tree without
 * the top selector's header, so it opens narrower (220) than the top entry's
 * 280 floor but keeps the same grow-only rule — content may widen it rightwards
 * up to 300, and longer names truncate in place with ellipsis.
 */
const FORK_PANEL_MIN_WIDTH = 220
const FORK_PANEL_MAX_WIDTH = 300

/** Flow row of a fork divider: shared weak-boundary row, same height as before. */
const ForkDividerRow = styled(BoundaryRow)`
  min-height: 36px;
`

/** The shared weak-boundary surface wrapped in its interactive shell. */
const ForkDividerNameButton = BoundaryPillButton
