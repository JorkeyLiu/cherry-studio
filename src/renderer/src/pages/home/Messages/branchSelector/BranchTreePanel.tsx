import type { TopicBranchWire } from '@renderer/services/db/types'
import { Button, Input, Popconfirm, Tree } from 'antd'
import type { DataNode } from 'antd/es/tree'
import { Pencil, Trash2 } from 'lucide-react'
import type { Key, ReactNode } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { useBranchRenameInput } from '../branchRouteOption'
import {
  type BranchGeoNode,
  type BranchTreeGeometry,
  buildBranchTreeGeometry,
  planRevealScroll,
  planScrollIntoView
} from './branchTreeGeometry'
import {
  baseExpandedKeys,
  BRANCH_POPOVER_MIN_WIDTH,
  BRANCH_TREE_ROOT_ID,
  branchRowKey,
  branchRowTestId,
  type BranchTreeIndex,
  collapseAllExpandedKeys,
  pruneExpandedKeys
} from './branchTreeModel'

/**
 * The top selector's branch tree.
 *
 * Rows are a vertical AntD tree (no built-in connector lines, no virtual
 * list, no expand animation); the connectors are one SVG layer drawn from
 * measured row slots so neutral edges and the current route's continuous
 * root-to-current line never depend on a magic per-depth offset.
 *
 * Interaction contract:
 * - the chevron column is 16px wide inside a 30px row and owns a transparent
 *   28px-wide click target that ends where the name column starts; the chevron
 *   only expands/collapses and the row's name only switches route and closes;
 * - connector geometry is measured from the 16px visual column, never from the
 *   larger click target, and pivots on that column's centre; where a row draws
 *   an arrow, only the glyph's own box is cut out of the drawn line, so the
 *   arrow keeps its slot and its neutral tone, and green only marks the route;
 * - hover/focus never changes expansion, and several forks can stay expanded
 *   at once;
 * - opening expands the current route's ancestors and scrolls the current row
 *   into view minimally; expanding a node reveals its new first child while
 *   keeping the acted-on row on screen; "collapse all" keeps only that ancestor
 *   chain open (nothing on the main route, so the root folds too); a catalog
 *   refresh drops expansion keys whose branch is gone.
 * - non-root rows manage themselves in place: rename and delete are two direct
 *   icons revealed on hover or keyboard focus only, rename edits inline in the
 *   name column, delete confirms through a small popconfirm with a loading
 *   state, and neither of them switches the route.
 * - the panel is measured inside its layout pass, so the rows that are about to
 *   be painted and their connectors are committed in the same frame; a panel
 *   mounted but not yet laid out yields no boxes and commits nothing.
 * - width belongs to the open session: the panel starts at a readable minimum,
 *   only ever grows (to the right) up to the budget its owner planned at open
 *   time, and long names truncate in place beyond it.
 */
const ROW_HEIGHT = 30
const INDENT_SIZE = 20
/** Chevron column width: the visual anchor the connector geometry is measured from. */
const SLOT_WIDTH = 16
/** Side of the expansion arrow glyph, centred in its chevron column. */
const GLYPH_SIZE = 10
/**
 * Room kept on every side of that glyph. Connectors pivot on the column's
 * centre, i.e. straight behind the arrow, so the SVG layer subtracts exactly
 * this grown box from the line instead of moving the line off the centre.
 */
const GLYPH_CLEARANCE = 1.5
/** Gap between the chevron column and the name column. */
const SLOT_END_GAP = 6
/** Transparent click target around the chevron; its right edge meets the name. */
const HIT_WIDTH = 28
const LINK_TAIL = 6
const LINK_RADIUS = 4
const SCROLL_PADDING = 10

export interface BranchTreePanelProps {
  index: BranchTreeIndex
  topicName: string
  activeBranchId: string | null
  /**
   * The popover's settled open state (antd's `afterOpenChange`). The panel is
   * mounted before it is laid out, so measurement waits for this signal and
   * re-runs whenever it turns true.
   */
  visible: boolean
  onSelectRoute: (branchId: string | null) => void
  /** Inline rename of a non-root row: DB-first, then a catalog refresh. */
  onCommitRename: (branchId: string, nextName: string) => void | Promise<void>
  /** Subtree delete of a non-root row; the caller owns the route fallback. */
  onConfirmDelete: (branchId: string) => void | Promise<void>
  /** Row whose delete is in flight, so only that row's control shows a spinner. */
  deletingBranchId: string | null
  /**
   * Reports whether a row's delete confirmation is open. The confirmation lives
   * in the popup layer, so its own press reaches the surrounding popover as an
   * outside click; the owner uses this to keep the tree open across it.
   */
  onDeleteConfirmChange: (isOpen: boolean) => void
  /**
   * Widest the panel may become during this open, planned once by the owner
   * from the trigger and the window. The panel starts at its minimum and only
   * grows into this budget, so an expand never re-aligns or shifts it.
   */
  maxWidth: number
}

export const BranchTreePanel = ({
  index,
  topicName,
  activeBranchId,
  visible,
  onSelectRoute,
  onCommitRename,
  onConfirmDelete,
  deletingBranchId,
  onDeleteConfirmChange,
  maxWidth
}: BranchTreePanelProps) => {
  const { t } = useTranslation()
  // The glyph cut-outs are one mask on the connector layer, so the id must be
  // per mounted panel (two windows can show the selector at once) and usable
  // verbatim inside a `url(#…)` reference.
  const maskSeed = useId()
  const glyphMaskId = `branch-glyph-clear-${maskSeed.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const activeKey = branchRowKey(activeBranchId)
  const ancestors = useMemo(() => index.ancestorsOf(activeBranchId), [index, activeBranchId])
  const [expandedKeys, setExpandedKeys] = useState<string[]>(() => baseExpandedKeys(ancestors))
  /** Expanded node whose first child should be revealed on the next frame. */
  const [revealKey, setRevealKey] = useState<string | null>(null)

  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState<BranchTreeGeometry | null>(null)
  /**
   * Width the panel has already reached during this open. It only ever grows,
   * so collapsing a fork or renaming a row can never pull the panel back in
   * while the user is looking at it; the owner remounts the panel per open, so
   * the next open starts from the content again.
   */
  const [settledWidth, setSettledWidth] = useState(0)

  const existingKeys = useMemo(() => new Set(index.orderedKeys), [index])
  // A catalog refresh (rename keeps ids, delete removes them) must not leave
  // expansion keys of rows that no longer exist.
  useEffect(() => {
    setExpandedKeys((previous) => {
      const next = pruneExpandedKeys(previous, existingKeys)
      return next.length === previous.length ? previous : next
    })
  }, [existingKeys])

  const labelOf = useCallback(
    (key: string): string => {
      if (key === BRANCH_TREE_ROOT_ID) return topicName
      const node = index.byId.get(key)
      if (!node) return key
      return node.name && node.name.length > 0 ? node.name : node.id
    },
    [index, topicName]
  )

  /* ---------------- in-place row editing ---------------- */
  /**
   * The row whose name is being edited, plus a ref mirror: the editor closes
   * synchronously on commit, and the blur that can follow it must never write
   * a second time.
   */
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renamingKeyRef = useRef<string | null>(null)
  const draftRef = useRef('')

  const startRename = useCallback(
    (key: string): void => {
      const next = labelOf(key)
      renamingKeyRef.current = key
      draftRef.current = next
      setRenamingKey(key)
      setDraft(next)
    },
    [labelOf]
  )

  const changeDraft = useCallback((value: string): void => {
    draftRef.current = value
    setDraft(value)
  }, [])

  const cancelRename = useCallback((): void => {
    renamingKeyRef.current = null
    draftRef.current = ''
    setRenamingKey(null)
    setDraft('')
  }, [])

  const commitRename = useCallback((): void => {
    const key = renamingKeyRef.current
    if (key === null) return
    // Consume the editor before it unmounts, so a trailing blur is a no-op.
    renamingKeyRef.current = null
    const next = draftRef.current.trim()
    draftRef.current = ''
    setRenamingKey(null)
    setDraft('')
    // An empty draft has nothing to persist: the row keeps its stored name.
    if (next.length === 0) return
    void onCommitRename(key, next)
  }, [onCommitRename])

  const renameInput = useBranchRenameInput({
    renaming: renamingKey !== null,
    onCommitRename: commitRename,
    onCancelRename: cancelRename
  })
  const treeData = useMemo(() => {
    const build = (key: string): DataNode => {
      const children =
        key === BRANCH_TREE_ROOT_ID ? (index.childrenOf.get(key) ?? []) : (index.childrenOf.get(key) ?? [])
      return {
        key,
        title: labelOf(key),
        isLeaf: children.length === 0,
        children: children.map((child: TopicBranchWire) => build(child.id))
      }
    }
    return [build(BRANCH_TREE_ROOT_ID)]
  }, [index, labelOf])

  /* ---------------- measured geometry ---------------- */
  const measureNodes = useCallback((): BranchGeoNode[] => {
    const content = contentRef.current
    if (!content) return []
    const box = content.getBoundingClientRect()
    // The popover content exists before it is laid out, and a zero-size box
    // (hidden or mid-mount) yields every row at the same origin — that would
    // draw the connectors at x=0/y=0. Nothing may be committed from it; the
    // settled-open signal and the resize observers bring the real measurement.
    if (box.width <= 0.5 || box.height <= 0.5) return []
    const nodes: BranchGeoNode[] = []
    for (const rowEl of Array.from(content.querySelectorAll<HTMLElement>('.ant-tree-treenode'))) {
      const row = rowEl.querySelector<HTMLElement>('[data-branch-id]')
      const id = row?.dataset.branchId
      if (!row || !id || !index.depthOf.has(id)) continue
      const rowRect = rowEl.getBoundingClientRect()
      if (rowRect.width <= 0.5 || rowRect.height <= 0.5) continue
      const switcherRect = rowEl.querySelector<HTMLElement>('.ant-tree-switcher')?.getBoundingClientRect() ?? null
      const titleRect =
        rowEl.querySelector<HTMLElement>('.ant-tree-node-content-wrapper')?.getBoundingClientRect() ?? null
      // An unmeasured (or absent) chevron column still owns its nominal width,
      // so leaves and real columns keep the same alignment.
      const slot = switcherRect && switcherRect.width > 0.5 ? switcherRect : null
      // The column's right edge is where the name gap starts, so a row without
      // a measured column derives it from the title box minus that gap.
      const slotRight = (slot ? slot.right : (titleRect?.left ?? rowRect.left) - SLOT_END_GAP) - box.left
      const slotWidth = slot ? slot.width : SLOT_WIDTH
      nodes.push({
        id,
        parentId: index.parentKeyOf.get(id) ?? null,
        depth: index.depthOf.get(id) ?? 0,
        centerY: rowRect.top + rowRect.height / 2 - box.top,
        pivotX: slotRight - slotWidth / 2,
        slotLeft: slotRight - slotWidth,
        slotRight,
        // A row draws an arrow exactly when its catalog node has children, so
        // the measured tree — not the rendered one — decides where a glyph
        // must be kept clear: a collapsed fork still shows its arrow.
        expandable: (index.childrenOf.get(id)?.length ?? 0) > 0
      })
    }
    return nodes
  }, [index])

  useLayoutEffect(() => {
    let settleFrame = 0

    const run = (): void => {
      // Width: latch the panel's own reach so this open only ever grows.
      const panel = panelRef.current
      const panelWidth = panel ? panel.getBoundingClientRect().width : 0
      if (panelWidth > 0.5) {
        setSettledWidth((previous) => Math.min(maxWidth, Math.max(previous, Math.round(panelWidth))))
      }

      const nodes = measureNodes()
      if (nodes.length === 0) return
      const next = buildBranchTreeGeometry(nodes, index.chainTo(activeBranchId), {
        radius: LINK_RADIUS,
        tail: LINK_TAIL,
        glyphSize: GLYPH_SIZE,
        glyphClearance: GLYPH_CLEARANCE
      })
      // Equal signature means nothing moved: skip the state write so the
      // resize observers cannot oscillate with this effect.
      setGeometry((previous) => (previous && previous.signature === next.signature ? previous : next))
    }

    // Measured and committed inside the layout pass, i.e. before the browser
    // paints: the connectors of the rows that are about to appear are drawn in
    // the very same frame as those rows. A panel that is mounted but not yet
    // laid out yields no nodes, so an unmeasured pass still commits nothing.
    run()

    // One settle frame covers what can only be known after the first layout
    // of an expand/collapse: the new row order and settled font metrics.
    const settle = (): void => {
      cancelAnimationFrame(settleFrame)
      settleFrame = requestAnimationFrame(run)
    }

    const content = contentRef.current
    const panel = panelRef.current
    settle()
    // Resize callbacks run after layout and before paint, so the frame in which
    // the popover gains a real box is also the frame its connectors exist — no
    // frame of rows without lines.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(run) : null
    for (const element of [content, panel]) {
      if (observer && element) observer.observe(element)
    }
    window.addEventListener('resize', run)
    return () => {
      cancelAnimationFrame(settleFrame)
      observer?.disconnect()
      window.removeEventListener('resize', run)
    }
  }, [measureNodes, index, activeBranchId, expandedKeys, visible, maxWidth])

  /* ---------------- scrolling ---------------- */
  /** Row edges in the scroll content's coordinate space. */
  const rowEdges = useCallback((key: string): { top: number; bottom: number } | null => {
    const content = contentRef.current
    if (!content) return null
    const row = Array.from(content.querySelectorAll<HTMLElement>('[data-branch-id]')).find(
      (candidate) => candidate.dataset.branchId === key
    )
    if (!row) return null
    const origin = content.getBoundingClientRect().top
    const rect = row.getBoundingClientRect()
    return { top: rect.top - origin, bottom: rect.bottom - origin }
  }, [])

  // Open, settle and every route change put the current row on screen, minimally.
  // `visible` belongs to the dependencies: the panel mounts before the popover
  // has laid it out, so the first pass has no row edges at all — the settled
  // open signal is what turns "unmeasured" into "scroll to the current row".
  useLayoutEffect(() => {
    const box = scrollerRef.current
    const edges = rowEdges(activeKey)
    if (!box || !edges) return
    box.scrollTop = planScrollIntoView({
      scrollTop: box.scrollTop,
      clientHeight: box.clientHeight,
      rowTop: edges.top,
      rowBottom: edges.bottom,
      padding: SCROLL_PADDING
    })
  }, [activeKey, expandedKeys, rowEdges, visible])

  // Expanding reveals the new first child while keeping the acted-on row on screen.
  useLayoutEffect(() => {
    if (!revealKey) return
    const box = scrollerRef.current
    const anchor = rowEdges(revealKey)
    const firstChild = rowEdges(index.childrenOf.get(revealKey)?.[0]?.id ?? '')
    setRevealKey(null)
    if (!box || !anchor || !firstChild) return
    box.scrollTop = planRevealScroll({
      scrollTop: box.scrollTop,
      clientHeight: box.clientHeight,
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
      revealTop: firstChild.top,
      revealBottom: firstChild.bottom,
      padding: SCROLL_PADDING
    })
  }, [revealKey, rowEdges, index])

  const handleExpand = useCallback(
    (keys: readonly Key[], info: { expanded: boolean; node: { key: Key } }) => {
      const next = keys.map(String)
      setExpandedKeys(next)
      if (!info.expanded) return
      const key = String(info.node.key)
      if ((index.childrenOf.get(key) ?? []).length > 0) setRevealKey(key)
    },
    [index]
  )

  // "Collapse all" folds everything except the current route's ancestor chain —
  // exactly the chain this panel opens with. On the main route that chain is
  // empty, so the root row folds as well. It never switches route.
  const collapseAll = useCallback(() => {
    setExpandedKeys(collapseAllExpandedKeys(ancestors))
  }, [ancestors])

  const branchCount = Math.max(0, index.orderedKeys.length - 1)

  const titleRender = useCallback(
    (node: DataNode): ReactNode => {
      const key = String(node.key)
      const isRoot = key === BRANCH_TREE_ROOT_ID
      const branchId = isRoot ? null : key
      const isCurrent = key === activeKey
      const childCount = (index.childrenOf.get(key) ?? []).length
      const label = labelOf(key)
      const isEditing = renamingKey === key
      return (
        <Row
          data-branch-id={key}
          className={isCurrent ? 'is-current' : undefined}
          data-current={isCurrent ? 'true' : undefined}>
          {isEditing ? (
            <RowInput
              data-testid="branch-selector-rename-input"
              size="small"
              value={draft}
              aria-label={t('chat.topics.branch.rename')}
              autoFocus
              onChange={(event) => changeDraft(event.target.value)}
              onPressEnter={commitRename}
              onKeyDown={renameInput.onKeyDown}
              onBlur={renameInput.onBlur}
              // The tree selects a row on title click: editing never switches route.
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            />
          ) : (
            <Name data-testid={branchRowTestId(branchId)} title={label}>
              {label}
            </Name>
          )}
          {childCount > 0 ? (
            <Count title={t('chat.topics.branch.children_here', { count: childCount })}>{childCount}</Count>
          ) : null}
          {isCurrent ? <CurrentBadge>{t('chat.topics.branch.current')}</CurrentBadge> : null}
          {isRoot ? null : (
            <RowActions>
              {isEditing ? null : (
                <>
                  <RowIconButton
                    type="text"
                    data-testid={`branch-rename-btn-${key}`}
                    aria-label={t('chat.topics.branch.rename')}
                    onClick={(event) => {
                      event.stopPropagation()
                      startRename(key)
                    }}
                    onMouseDown={(event) => event.stopPropagation()}>
                    <Pencil size={13} />
                  </RowIconButton>
                  <Popconfirm
                    title={t('chat.topics.branch.delete_confirm')}
                    // Confirmation wording is the app's own, in the current
                    // locale, like every other destructive confirmation: the
                    // generic control never falls back to a popup library's
                    // default language.
                    okText={t('common.confirm')}
                    cancelText={t('common.cancel')}
                    okButtonProps={{ danger: true }}
                    onOpenChange={onDeleteConfirmChange}
                    onConfirm={() => onConfirmDelete(key)}>
                    <RowIconButton
                      type="text"
                      danger
                      data-testid={`branch-delete-btn-${key}`}
                      aria-label={t('chat.topics.branch.delete')}
                      loading={deletingBranchId === key}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}>
                      <Trash2 size={13} />
                    </RowIconButton>
                  </Popconfirm>
                </>
              )}
            </RowActions>
          )}
        </Row>
      )
    },
    [
      activeKey,
      changeDraft,
      commitRename,
      deletingBranchId,
      draft,
      index,
      labelOf,
      onConfirmDelete,
      onDeleteConfirmChange,
      renameInput,
      renamingKey,
      startRename,
      t
    ]
  )

  return (
    <Panel
      ref={panelRef}
      data-testid="branch-selector-popover"
      // The panel follows its own content, but never wider than the budget the
      // owner planned at open time, and never narrower than what it has already
      // reached in this open: growth is one-way and always to the right.
      style={{ minWidth: Math.min(maxWidth, Math.max(BRANCH_POPOVER_MIN_WIDTH, settledWidth)), maxWidth }}>
      <Header>
        <HeaderTitle>{t('chat.topics.branch.tag')}</HeaderTitle>
        {branchCount > 0 ? (
          <HeaderCount title={t('chat.topics.branch.children_here', { count: branchCount })}>{branchCount}</HeaderCount>
        ) : null}
        <HeaderSpacer />
        <CollapseButton type="button" data-testid="branch-collapse-all" onClick={collapseAll}>
          {t('chat.topics.branch.collapse_all')}
        </CollapseButton>
      </Header>
      <Scroller ref={scrollerRef} data-testid="branch-tree-scroll">
        <Content ref={contentRef}>
          <Edges aria-hidden="true" width="100%" height="100%">
            {/*
             * Only the piece of line that runs behind an arrow is removed: a
             * hole the size of each arrow glyph, so the connector geometry
             * stays exactly where it was measured, nothing is painted behind
             * the arrow, and a leaf row (no arrow) gets no hole at all.
             */}
            <defs>
              <mask id={glyphMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
                <rect x="0" y="0" width="100%" height="100%" fill="#fff" />
                {geometry?.glyphCuts.map((cut, position) => (
                  <rect
                    key={`glyph-cut-${position}`}
                    x={cut.x}
                    y={cut.y}
                    width={cut.width}
                    height={cut.height}
                    fill="#000"
                  />
                ))}
              </mask>
            </defs>
            <g mask={`url(#${glyphMaskId})`}>
              {geometry ? geometry.grey.map((d, position) => <path key={`edge-${position}`} d={d} />) : null}
              {geometry?.active ? <path className="edge-active" d={geometry.active} /> : null}
            </g>
            {/* The endpoint dot only lands on a row whose arrow column is empty:
                an arrow row (root, or any fork) marks currency with its green
                name and badge instead, so the dot never sits on a chevron. */}
            {geometry?.endDot ? (
              <circle className="edge-dot" cx={geometry.endDot.x} cy={geometry.endDot.y} r={2.2} />
            ) : null}
          </Edges>
          <Tree
            className="branch-tree"
            blockNode
            motion={false}
            showLine={false}
            virtual={false}
            treeData={treeData}
            expandedKeys={expandedKeys}
            switcherIcon={renderSwitcherIcon}
            onExpand={handleExpand}
            onSelect={(_keys, info) => {
              if (!info.selected) return
              // Row controls live in the popup layer; a press on one of them
              // bubbles back through the React tree and must never navigate.
              const target = info.nativeEvent?.target
              if (target instanceof Node && !(contentRef.current?.contains(target) === true)) return
              const key = String(info.node.key)
              onSelectRoute(key === BRANCH_TREE_ROOT_ID ? null : key)
            }}
            titleRender={titleRender}
          />
        </Content>
      </Scroller>
    </Panel>
  )
}

/** 10px chevron in a fixed-width slot; leaves keep an empty slot for alignment. */
const renderSwitcherIcon = (props: { isLeaf?: boolean; expanded?: boolean }) => {
  if (props.isLeaf) return null
  return (
    <svg
      className={props.expanded ? 'branch-twig is-open' : 'branch-twig'}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true">
      <path
        d="M3.4 2 6.4 5l-3 3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  /* The width follows the tree's own content, so short branch names stay
     narrow instead of leaving a fixed column of empty space. The open-session
     budget (inline min-width/max-width) is what bounds it: the panel starts at
     a readable minimum, grows only as far as this open has already reached, and
     is capped so long labels truncate in place instead of pushing the popover
     past the window edge. The row action area is part of every row's content,
     so hovering never re-flows the panel. */
  width: max-content;
  max-height: 440px;
  overflow: hidden;
  /* Tree scaffolding: fixed row height and a fixed-width chevron slot; the
     connectors come from the SVG layer, never from AntD's own lines. */
  .branch-tree.ant-tree {
    position: relative;
    z-index: 1;
    background: transparent;
    color: var(--color-text-1);
    font-size: 13px;
  }

  .branch-tree.ant-tree .ant-tree-treenode {
    width: 100%;
    height: ${ROW_HEIGHT}px;
    padding: 0;
    align-items: center;
  }

  .branch-tree.ant-tree .ant-tree-indent-unit {
    width: ${INDENT_SIZE}px;
  }

  /* Chevron column: 16px of the 30px row, so the connector geometry has the
     same visual anchor as the reference (a child column starts 20px in, the
     name column 6px after the chevron column). The 10px glyph never grows, and
     it is neutral: green only ever marks the current route's line. */
  .branch-tree.ant-tree .ant-tree-switcher {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: ${SLOT_WIDTH}px;
    min-width: ${SLOT_WIDTH}px;
    height: ${ROW_HEIGHT}px;
    margin-inline-end: ${SLOT_END_GAP}px;
    color: var(--color-text-3);
    /* No resting plate: nothing is painted behind the glyph; the line behind
       it is cut instead, so the arrow keeps its slot and its column. */
    background: transparent;
    border-radius: 4px;
  }

  /* The click target is its own transparent box: 28px wide, ending exactly
     where the name column begins (slot 16 + 6 gap) and reaching 6px to the
     left of the slot. It never overlaps the name or a neighbouring row, and
     the connector geometry is measured from the 16px column, not from it. */
  .branch-tree.ant-tree .ant-tree-switcher:not(.ant-tree-switcher-noop)::after {
    content: '';
    position: absolute;
    top: 1px;
    right: -${SLOT_END_GAP}px;
    width: ${HIT_WIDTH}px;
    height: ${HIT_WIDTH}px;
    border-radius: 6px;
    background: transparent;
  }

  /* Hover/focus is a small wash around the glyph, never a slab, and it is not
     what marks the current route. The wash is a pseudo-element so the 28px
     click target below is untouched by it. It is also the lower layer: an
     absolutely positioned box paints over in-flow content, so the wash is
     stacked below the glyph instead of in front of it. */
  .branch-tree.ant-tree .ant-tree-switcher::before {
    content: '';
    position: absolute;
    z-index: 0;
    left: 1px;
    top: 8px;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    background: transparent;
    transition: background-color 0.12s ease;
  }

  /* AntD's own hover plate is a full 30px square on the switcher; keep the wash
     inside the 14px box above (hence the higher-specificity selector) and keep
     it hover-only, so nothing marks the arrow at rest. */
  .branch-tree.ant-tree .ant-tree-treenode .ant-tree-switcher:not(.ant-tree-switcher-noop):hover::before {
    background: var(--color-hover);
  }

  .branch-tree.ant-tree .ant-tree-switcher:hover {
    color: var(--color-text-1);
    background: transparent;
  }

  /* Keyboard focus stays unmistakable without a permanent block. */
  .branch-tree.ant-tree .ant-tree-treenode .ant-tree-switcher:not(.ant-tree-switcher-noop):focus-visible::before {
    background: var(--color-hover);
    box-shadow: 0 0 0 1.5px var(--color-primary);
  }

  /* The glyph owns the layer above the wash: the arrow keeps its neutral tone
     and stays visible while the wash is showing, and the wash remains the
     small plate behind it rather than something painted over it. Geometry is
     untouched — the glyph keeps its 10px box and its chevron column. */
  .branch-tree .branch-twig {
    position: relative;
    z-index: 1;
    transition: transform 0.14s ease;
  }

  .branch-tree .branch-twig.is-open {
    transform: rotate(90deg);
  }

  .branch-tree.ant-tree .ant-tree-node-content-wrapper {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 28px;
    padding: 0 6px;
    border-radius: 7px;
    background: transparent;
    transition: background-color 0.12s ease;
  }

  .branch-tree.ant-tree .ant-tree-node-content-wrapper:hover {
    background: var(--color-hover);
  }

  .branch-tree.ant-tree .ant-tree-node-content-wrapper.ant-tree-node-selected {
    background: var(--color-primary-mute);
  }

  .branch-tree.ant-tree .ant-tree-node-content-wrapper .ant-tree-title {
    display: block;
    flex: 1 1 auto;
    min-width: 0;
  }
`

const Header = styled.div`
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 8px 12px;
  border-bottom: 1px solid var(--color-border-soft);
`

const HeaderTitle = styled.span`
  font-size: 12px;
  color: var(--color-text-2);
`

const HeaderCount = styled.span`
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--color-background-mute);
  color: var(--color-text-3);
  font-family: var(--code-font-family);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
`

const HeaderSpacer = styled.span`
  flex: 1;
`

const CollapseButton = styled.button`
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-2);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background: var(--color-hover);
    color: var(--color-text-1);
  }
`

const Scroller = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  max-height: 384px;
  overflow-y: auto;
  overflow-x: hidden;
  /* Room for the 6px the chevron hit target reaches left of its slot. */
  padding: 6px 6px 8px;
  overflow-x: hidden;
  scrollbar-width: thin;
`

const Content = styled.div`
  position: relative;
`

const Edges = styled.svg`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  z-index: 0;

  path {
    fill: none;
    stroke: var(--color-border);
    stroke-width: 1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .edge-active {
    stroke: var(--color-primary);
    stroke-width: 1.5;
  }

  .edge-dot {
    fill: var(--color-primary);
    stroke: none;
  }
`

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-right: 2px;
`

const Name = styled.span`
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-1);
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;

  ${Row}.is-current & {
    color: var(--color-primary);
    font-weight: 600;
  }
`

const Count = styled.span`
  flex: none;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--color-background-mute);
  color: var(--color-text-3);
  font-family: var(--code-font-family);
  font-size: 10px;
  line-height: 1;
  font-variant-numeric: tabular-nums;

  ${Row}.is-current & {
    background: var(--color-primary-mute);
    color: var(--color-primary);
  }
`

const CurrentBadge = styled.span`
  flex: none;
  padding: 3px 5px;
  border-radius: 4px;
  background: var(--color-primary);
  color: var(--color-white);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.02em;
`

const RowActions = styled.span`
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
`

/**
 * Row action control (rename / delete).
 *
 * The action area keeps its width at all times, so revealing it never shifts
 * the name column. The controls themselves stay invisible until the row is
 * hovered or holds keyboard focus: a pointer only reaches them through the row
 * that just revealed them, and Tab reveals them for a keyboard user.
 */
const RowIconButton = styled(Button)`
  opacity: 0;
  transition:
    opacity 0.12s ease,
    background-color 0.12s ease;

  /* The AntD text button must not win the 22px row-action size. */
  &&& {
    width: 22px;
    min-width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 5px;
    color: var(--color-text-3);
  }

  &&&:hover,
  &&&:focus-visible {
    color: var(--color-text-1);
  }


  .ant-tree-node-content-wrapper:hover &,
  .ant-tree-node-content-wrapper:focus-within &,
  &:focus-visible {
    opacity: 1;
  }
`

/** Inline rename editor: it takes the name column while the row is editing. */
const RowInput = styled(Input)`
  &&& {
    flex: 1 1 auto;
    min-width: 0;
    height: 22px;
    padding: 0 6px;
    border-radius: 5px;
    font-size: 13px;
  }
`
