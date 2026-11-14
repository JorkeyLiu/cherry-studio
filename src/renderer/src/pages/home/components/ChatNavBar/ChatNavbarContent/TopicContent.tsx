import { loggerService } from '@logger'
import {
  BranchBreadcrumb,
  type BranchCrumbSegment
} from '@renderer/pages/home/Messages/branchSelector/BranchBreadcrumb'
import {
  BRANCH_POPOVER_MAX_WIDTH,
  branchPopoverAlign,
  type BranchPopoverFit,
  buildBranchTreeIndex,
  planBranchPopoverFit
} from '@renderer/pages/home/Messages/branchSelector/branchTreeModel'
import { BranchTreePanel } from '@renderer/pages/home/Messages/branchSelector/BranchTreePanel'
import { useRouteViewport } from '@renderer/pages/home/Messages/routeViewportContext'
import { requestTopicBranches, useBranchTree } from '@renderer/pages/home/Messages/useBranchTree'
import { deleteBranchSubtree } from '@renderer/services/db/branchSubtree'
import { dbService } from '@renderer/services/db/DbService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant, Topic } from '@renderer/types'
import { Button, type GetRef, Popover, Tooltip } from 'antd'
import { GitBranch } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import SelectModelButton from '../../SelectModelButton'
import Tools from '../Tools'

type TopicContentProps = {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
}

const logger = loggerService.withContext('TopicContent')
/**
 * Fit used before the first open planned one: the anchored left edge and the
 * full ceiling. Module-level so it stays the same object, i.e. the align config
 * derived from it does not change identity on every render.
 */
const UNMEASURED_POPOVER_FIT: BranchPopoverFit = { leftShift: 0, maxWidth: BRANCH_POPOVER_MAX_WIDTH }

/**
 * The chat navbar's own row: model selector, the branch selector entry, the
 * branch path of the viewed route, and the right-hand tool group.
 *
 * - The branch entry is one icon button immediately left of the path, on the
 *   same 30px/8px-radius shape as the navbar's other tools, so the row reads
 *   model selector, branch entry, branch path, then the right-hand tools. It
 *   is the popover's only trigger; nothing else opens the tree.
 * - The breadcrumb is pure navigation: every segment — the current route
 *   included — switches through the same `requestTopRoute` entry point
 *   (clicking the current one only closes) and never opens the panel.
 * - The popover is a vertical branch tree, so several forks stay open at once
 *   and a route never has to be walked column by column. Opening expands the
 *   current route's ancestors and puts the current row on screen.
 * - The panel's width belongs to the open session. The entry anchors the
 *   panel's left edge, so the panel only grows rightwards; the open therefore
 *   reserves the room the panel may grow into from the window's right edge,
 *   puts the left edge there through the popover's align pass, and lets the
 *   panel grow up to the budget, where names truncate instead. That pass is
 *   the placement's own input, so its horizontal self-correction is turned off
 *   with it: neither a wide panel nor a wide row may flip or shift the panel
 *   off that edge — a narrow window moves the reserved left edge instead, so
 *   the panel still ends inside the margin.
 * - Row management belongs to the rows themselves: rename edits in place and
 *   delete confirms through a small popconfirm, both DB-first with the catalog
 *   refreshed after the write. The selector stays open across them.
 * - The state lives here because this row is the natural place both the path
 *   and the tool group are rendered from — no global store is involved.
 */
const TopicContent = ({ assistant, activeTopic }: TopicContentProps) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const viewport = useRouteViewport()
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, activeTopic.id))
  const branchTree = useBranchTree(activeTopic.id, activeBranchId)
  const [open, setOpen] = useState(false)
  /** Bumped per open so the tree always starts from the current route's ancestors. */
  const [openCount, setOpenCount] = useState(0)
  /**
   * The popover's settled visibility, reported by antd once the panel is
   * really on screen. The tree only measures from a laid-out panel, so this is
   * its "you may measure now" signal — never the mere mount of the content.
   */
  const [treeVisible, setTreeVisible] = useState(false)
  /** Row whose subtree delete is in flight, so only that row shows a spinner. */
  const [deletingId, setDeletingId] = useState<string | null>(null)
  /**
   * Whether a row's delete confirmation is open. It is a ref, not state: it
   * guards only the press that dismisses that confirmation and renders
   * nothing.
   */
  const deleteConfirmRef = useRef(false)
  const handleDeleteConfirmChange = useCallback((isOpen: boolean): void => {
    deleteConfirmRef.current = isOpen
  }, [])
  /**
   * The one closing path of the popover. The protection a row's delete
   * confirmation asked for belongs to the open session it was raised in, so
   * closing the selector retires it: it can never outlive its selector and
   * swallow a later press.
   */
  const closeSelector = useCallback((): void => {
    deleteConfirmRef.current = false
    setTreeVisible(false)
    setOpen(false)
  }, [])
  /**
   * Open-session fit of the panel: where its left edge starts and how far it
   * may grow. Planned just before the open (so the frame the panel first
   * appears in already has its final left edge) and re-planned on window
   * resize, which may re-constrain it; never re-planned by the panel's own
   * content.
   */
  const [popoverFit, setPopoverFit] = useState<BranchPopoverFit | null>(null)
  const entryRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<GetRef<typeof Popover>>(null)

  const planFit = useCallback((): void => {
    const rect = entryRef.current?.getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    setPopoverFit(
      planBranchPopoverFit({
        triggerLeft: rect?.left ?? 0,
        triggerWidth: rect?.width ?? 0,
        viewportWidth
      })
    )
  }, [])

  // A resize may re-constrain the open session.
  useLayoutEffect(() => {
    if (!open) return
    window.addEventListener('resize', planFit)
    return () => window.removeEventListener('resize', planFit)
  }, [open, planFit])

  // The planned left edge is an align input, so it only reaches the popup on
  // the trigger's own align pass — and the trigger does not ask for one when a
  // changed align meets one of its built-in placements. After a re-plan the
  // pass is therefore requested explicitly, so a shrunk window pulls the panel
  // back inside the margin instead of leaving it at the old offset.
  useLayoutEffect(() => {
    if (!open) return
    popoverRef.current?.forceAlign()
  }, [open, popoverFit])

  const panelFit: BranchPopoverFit = popoverFit ?? UNMEASURED_POPOVER_FIT
  const popoverAlign = useMemo(() => branchPopoverAlign(panelFit), [panelFit])

  const branches = branchTree.branches
  const path = branchTree.path
  const index = useMemo(() => buildBranchTreeIndex(branches), [branches])

  const topicName = activeTopic.name && activeTopic.name.length > 0 ? activeTopic.name : activeTopic.id
  const segments = useMemo<BranchCrumbSegment[]>(() => {
    const branchSegments = path.map((branch) => ({
      branchId: branch.id,
      label: branch.name && branch.name.length > 0 ? branch.name : branch.id
    }))
    return [{ branchId: null, label: topicName }, ...branchSegments]
  }, [path, topicName])
  const fullLabel = segments.map((segment) => segment.label).join(' / ')
  const switchRoute = (branchId: string | null): void => {
    closeSelector()
    if (branchId === activeBranchId) return
    // Single controller entry: freeze the outgoing DISPLAYED route's snapshot,
    // open the top transition session, then dispatch. The target window is
    // chosen from the NEW route's own saved anchor; a target with no snapshot
    // takes its deterministic route-local default (bottom) — never outgoing
    // geometry. The message list adopts this session (same epoch) for
    // fetch/position/reveal/commit — no second request, no second epoch.
    try {
      viewport.requestTopRoute(activeTopic.id, branchId)
    } catch {
      // fail-closed: the route switch proceeds; target falls back to its default
    }
  }

  /**
   * Inline rename commit, DB-first: the row keeps its place while the write is
   * in flight and the refreshed catalog then carries the stored name.
   */
  const commitRename = async (branchId: string, next: string): Promise<void> => {
    try {
      await dbService.renameBranch(activeTopic.id, branchId, next)
      requestTopicBranches(dispatch, activeTopic.id)
    } catch (error) {
      logger.error('[TopicContent] Failed to rename branch:', error as Error)
      window.toast.error(t('common.error'))
    }
  }

  /** Popconfirm delete commit: the subtree delete owns the route fallback. */
  const confirmDelete = async (branchId: string): Promise<void> => {
    setDeletingId(branchId)
    try {
      // The subtree delete owns the route fallback; never switch here.
      await deleteBranchSubtree(activeTopic.id, branchId, activeBranchId)
      requestTopicBranches(dispatch, activeTopic.id)
      window.toast.success(t('chat.topics.branch.deleted'))
    } catch (error) {
      logger.error('[TopicContent] Failed to delete branch:', error as Error)
      window.toast.error(t('common.error'))
    } finally {
      deleteConfirmRef.current = false
      setDeletingId(null)
    }
  }

  // Escape closes the popover. A row editor takes Escape for itself and stops
  // the event, so cancelling an edit never closes the whole selector.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      closeSelector()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeSelector])

  // A never-branched topic keeps the plain navbar: no path, no branch tool.
  const hasBranches = branches.length > 0

  const content = (
    <BranchTreePanel
      key={openCount}
      index={index}
      topicName={topicName}
      activeBranchId={activeBranchId}
      visible={treeVisible}
      deletingBranchId={deletingId}
      onDeleteConfirmChange={handleDeleteConfirmChange}
      onSelectRoute={switchRoute}
      onCommitRename={commitRename}
      onConfirmDelete={confirmDelete}
      maxWidth={panelFit.maxWidth}
    />
  )

  return (
    <div className="flex flex-1 items-center gap-2">
      {/* Model selector (retained) */}
      <SelectModelButton assistant={assistant} />

      {/* The branch selector trigger and breadcrumb in a segmented pill group */}
      {hasBranches ? (
        <BranchSegmentedGroup data-testid="branch-segmented-group">
          <Popover
            ref={popoverRef}
            content={content}
            trigger="click"
            // Anchored on the entry's left edge: content growth extends to the
            // right instead of pushing the panel away from the entry.
            placement="bottomLeft"
            arrow={false}
            // The popup's own align pass places it: it starts at the left edge
            // this open reserved, and its horizontal self-correction is off, so
            // a growing panel never flips or shifts away from that edge (the
            // anchor, and the entry's click point, never move).
            align={popoverAlign}
            styles={{ body: { padding: 0 } }}
            open={open}
            afterOpenChange={(next) => setTreeVisible(next)}
            onOpenChange={(next) => {
              if (next) {
                // Planned before the panel mounts, so the first frame it
                // appears in already carries its final left edge.
                planFit()
                setOpenCount((count) => count + 1)
                setOpen(true)
                return
              }
              // A row's delete confirmation reports itself through this flag.
              // It lives in its own popup layer, so the press that dismisses
              // it arrives here as an outside press as well: that one press
              // belongs to the confirmation and is spent on it. Closing the
              // selector through any other path retires the flag with it, so
              // it can never swallow a later press.
              if (deleteConfirmRef.current) {
                deleteConfirmRef.current = false
                return
              }
              closeSelector()
            }}
            destroyOnHidden>
            <Tooltip title={t('chat.topics.branch.tag')} mouseEnterDelay={0.8}>
              <BranchIconButton
                ref={entryRef}
                data-testid="branch-selector-entry"
                className="shrink-0"
                type="text"
                autoInsertSpace={false}
                aria-label={t('chat.topics.branch.tag')}
                aria-haspopup="dialog"
                aria-expanded={open}>
                <GitBranch size={16} />
              </BranchIconButton>
            </Tooltip>
          </Popover>

          <BranchBreadcrumb
            segments={segments}
            fullLabel={fullLabel}
            segmentTestId={(branchId) => `branch-crumb-${branchId ?? 'main'}`}
            onSelect={switchRoute}
          />
        </BranchSegmentedGroup>
      ) : null}

      {/* Edit / settings share one right-hand tool group. */}
      <div data-testid="navbar-tools-right" className="ml-auto flex shrink-0 items-center gap-2">
        <Tools />
      </div>
    </div>
  )
}

/**
 * Container uniting the branch button and the breadcrumb into a single segmented pill.
 */
const BranchSegmentedGroup = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1 1 0;
  max-width: 100%;
`

/**
 * The branch tool: left segment of the branch pill group (26px tall, 8px left radius,
 * shared soft background and seam border with the breadcrumb plate). While the
 * panel is open it takes the active shape with the accent surface and light glyph.
 */
const BranchIconButton = styled(Button)`
  &&& {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    padding: 0 7px;
    border: 1px solid var(--color-border-soft);
    border-radius: 8px 0 0 8px;
    background: var(--color-background-soft);
    color: var(--color-icon);
    box-shadow: none;
    transition:
      background-color 0.2s ease-in-out,
      color 0.2s ease-in-out,
      border-color 0.2s ease-in-out;

    &:hover {
      background: var(--color-hover);
      color: var(--color-text-1);
    }

    &[aria-expanded='true'],
    &[aria-expanded='true']:hover {
      background: var(--color-primary);
      color: var(--color-icon-white);
      border-color: var(--color-primary);

      /* The glyph carries its own colour in the app's icon layer (the same
         override the edit-mode toggle relies on). */
      .lucide {
        color: var(--color-icon-white);
      }
    }

    &[aria-expanded='true']:hover {
      opacity: 0.85;
    }
  }
`

export default TopicContent
