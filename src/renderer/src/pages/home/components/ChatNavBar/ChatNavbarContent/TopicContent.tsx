import { loggerService } from '@logger'
import { BranchRouteOptionRow } from '@renderer/pages/home/Messages/branchRouteOption'
import { useRouteViewport } from '@renderer/pages/home/Messages/routeViewportContext'
import { requestTopicBranches, useBranchTree } from '@renderer/pages/home/Messages/useBranchTree'
import { deleteBranchSubtree } from '@renderer/services/db/branchSubtree'
import { dbService } from '@renderer/services/db/DbService'
import type { TopicBranchWire } from '@renderer/services/db/types'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant, Topic } from '@renderer/types'
import { Button, Popover } from 'antd'
import { ChevronDown, ChevronRight, GitFork } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import SelectModelButton from '../../SelectModelButton'
import Tools from '../Tools'

type TopicContentProps = {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
}

const logger = loggerService.withContext('TopicContent')

const TopicContent = ({ assistant, activeTopic }: TopicContentProps) => {
  return (
    <div className="flex flex-1 items-center gap-2">
      {/* Model selector (retained) */}
      <SelectModelButton assistant={assistant} />

      {/* Unified branch selector (retained with its own path display) */}
      <BranchSelectorEntry activeTopic={activeTopic} />
      {/* Edit/Settings tools stay pinned at the far right */}
      <div data-testid="navbar-tools-right" className="ml-auto flex shrink-0 items-center">
        <Tools />
      </div>
    </div>
  )
}

interface BranchSelectorEntryProps {
  activeTopic: Topic
}

/**
 * Single unified top branch entry, visible in both the main route and
 * branch routes once the topic has branches (initial no-branch state hides
 * it entirely).
 *
 * - Displays the breadcrumb path: logical topic / level-1 branch / level-2
 *   branch … for the active route (topic name only on the main route).
 * - Cascader-like selector: hovering/focusing a route option reveals its
 *   descendants in the next column, to arbitrary depth. Selecting switches
 *   activeBranchId while the topic stays fixed.
 * - Default expansion shows only the columns needed to place the current
 *   branch in its current column (ancestors excluding the current node):
 *   current L1 with children opens col-0 only (L1 highlighted, no child
 *   column until hover/focus on L1); current L2 opens through the
 *   L2-containing column but not L2's children. Repeat close/open resets to
 *   this default (no collapse to first column, no child over-expansion).
 * - Selection highlight is background-only (no checkmark icons).
 * - Branch management is rename/delete only, for non-null branch nodes.
 */
interface CascaderOption {
  key: string
  branchId: string | null
  label: string
  selected: boolean
  hasChildren: boolean
}

/**
 * Tail-first breadcrumb overflow at whole-segment granularity: the box holds
 * one wrap span per segment in logical order, each carrying its own leading
 * " / " separator (except the first). While it overflows, leading wraps are
 * hidden front-to-back — the remainder always starts at a segment boundary,
 * never a mid-word cut. If even the lone last segment overflows, its head is
 * trimmed character-wise behind an in-text "…" (whole glyphs only, never a
 * sliced glyph). A static "…" marker shows whenever leading wraps are hidden
 * without a trimmed tail. Direct DOM only (no React state), so scroll/resize
 * sync never re-renders.
 */
function syncCrumbTail(
  el: HTMLSpanElement | null,
  lead: HTMLSpanElement | null,
  showTail: boolean,
  fullText: string
): void {
  if (!el) return
  const kids = Array.from(el.children) as HTMLElement[]
  // Reset: restore wraps and the original tail text.
  kids.forEach((kid) => {
    kid.style.display = ''
    if (kid.dataset.origSeg !== undefined) {
      const textNode = Array.from(kid.childNodes).find((node) => node.nodeType === 3)
      if (textNode) textNode.textContent = kid.dataset.origSeg
      delete kid.dataset.origSeg
      const sep = kid.firstElementChild as HTMLElement | null
      if (sep) sep.style.display = ''
    }
  })
  el.style.textOverflow = 'ellipsis'
  el.scrollLeft = 0
  el.removeAttribute('aria-label')
  if (!showTail || el.scrollWidth <= el.clientWidth + 1) {
    if (lead) lead.style.display = 'none'
    return
  }
  let guard = kids.length + 1
  while (guard-- > 0) {
    if (el.scrollWidth <= el.clientWidth + 1) break
    const visible = (Array.from(el.children) as HTMLElement[]).filter((kid) => kid.style.display !== 'none')
    // The last segment is never hidden.
    if (visible.length <= 1) break
    visible[0].style.display = 'none'
  }
  const visible = (Array.from(el.children) as HTMLElement[]).filter((kid) => kid.style.display !== 'none')
  const hiddenCount = kids.length - visible.length
  const last = visible[visible.length - 1]
  let trimmed = false
  if (last && el.scrollWidth > el.clientWidth + 1) {
    // Lone overlong tail: trim its head behind an in-text "…", whole glyphs.
    const textNode = Array.from(last.childNodes).find((node) => node.nodeType === 3)
    if (textNode && textNode.textContent) {
      const orig = textNode.textContent
      last.dataset.origSeg = orig
      let chars = Array.from(orig)
      textNode.textContent = `…${chars.join('')}`
      while (chars.length > 1 && el.scrollWidth > el.clientWidth + 1) {
        chars = chars.slice(1)
        textNode.textContent = `…${chars.join('')}`
      }
      trimmed = true
      const sep = last.firstElementChild as HTMLElement | null
      if (sep) sep.style.display = 'none'
      el.setAttribute('aria-label', fullText)
    }
  }
  if (!trimmed && el.scrollWidth > el.clientWidth + 1) {
    // Last-resort residual (should not normally happen): scroll to the end.
    // Clip while scrolled: Chromium does not paint scrolled ellipsis text.
    el.style.textOverflow = 'clip'
    el.scrollLeft = el.scrollWidth
  }
  if (lead) lead.style.display = hiddenCount > 0 && !trimmed ? '' : 'none'
}

const BranchSelectorEntry = ({ activeTopic }: BranchSelectorEntryProps) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const viewport = useRouteViewport()
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, activeTopic.id))
  const branchTree = useBranchTree(activeTopic.id, activeBranchId)
  const [open, setOpen] = useState(false)
  // Explicit hover chain (null = default expansion: ancestors needed to show
  // the current node, excluding the current node itself). Hovering an option
  // in column C sets the chain to the path through that option, revealing
  // the next column; arbitrary depth.
  const [hoverPath, setHoverPath] = useState<(string | null)[] | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const branches = branchTree.branches
  const path = branchTree.path

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, TopicBranchWire[]>()
    for (const b of branches) {
      const key = b.parentBranchId ?? null
      const list = map.get(key) ?? []
      list.push(b)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
    }
    return map
  }, [branches])

  const byId = useMemo(() => new Map(branches.map((b) => [b.id, b])), [branches])

  const topicName = activeTopic.name && activeTopic.name.length > 0 ? activeTopic.name : activeTopic.id
  const branchNames = path.map((b) => (b.name && b.name.length > 0 ? b.name : b.id))
  const breadcrumb = path.length === 0 ? topicName : `${topicName} / ${branchNames.join(' / ')}`
  // Segments mirror the breadcrumb string exactly (separators carry their own
  // spans), so textContent/order stay identical while overflow can hide whole
  // leading segments. Rendered via array (no inter-element whitespace) to
  // keep the " / " separators exact.
  const breadcrumbSegments = path.length === 0 ? [topicName] : [topicName, ...branchNames]

  // Tail-first overflow: the breadcrumb keeps logical (root-first) order in a
  // single line; when it overflows, whole leading segments hide front-to-back
  // and the current branch stays visible. No direction or ordering tricks, so
  // text order and the popover navigation are untouched. A lone title keeps
  // the classic head-visible tail ellipsis. A static "…" prefix (sibling of
  // the scroll box, never overlaid) marks the hidden front.
  const crumbRef = useRef<HTMLSpanElement>(null)
  const leadRef = useRef<HTMLSpanElement>(null)
  const hasBranchPath = path.length > 0
  useEffect(() => {
    syncCrumbTail(crumbRef.current, leadRef.current, hasBranchPath, breadcrumb)
  }, [hasBranchPath, breadcrumb])
  useEffect(() => {
    const el = crumbRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const keepTailVisible = (): void => syncCrumbTail(crumbRef.current, leadRef.current, hasBranchPath, breadcrumb)
    const observer = new ResizeObserver(keepTailVisible)
    observer.observe(el)
    el.addEventListener('scroll', keepTailVisible, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', keepTailVisible)
    }
  }, [hasBranchPath, breadcrumb])

  // Default expansion: ancestors of the current node (excluding the current
  // node itself) — exactly the columns needed to place the current branch in
  // its current column, never its children.
  const defaultWalkIds = useMemo(() => path.slice(0, -1).map((b) => b.id), [path])
  // Walk the explicit hover chain, or the default expansion when untouched,
  // to build cascader columns: column 0 = main route + level-1 branches,
  // each further column = children of the hovered/default option above.
  const walkIds = hoverPath ?? defaultWalkIds
  const columns: { parentId: string | null; options: CascaderOption[] }[] = [
    {
      parentId: null,
      options: [
        { key: '__main', branchId: null, label: topicName, selected: activeBranchId === null, hasChildren: false },
        ...(childrenOf.get(null) ?? []).map(
          (b): CascaderOption => ({
            key: b.id,
            branchId: b.id,
            label: b.name && b.name.length > 0 ? b.name : b.id,
            selected: b.id === activeBranchId,
            hasChildren: (childrenOf.get(b.id) ?? []).length > 0
          })
        )
      ]
    }
  ]
  for (const id of walkIds) {
    if (id === null) continue
    const kids = childrenOf.get(id) ?? []
    if (kids.length === 0) break
    columns.push({
      parentId: id,
      options: kids.map(
        (b): CascaderOption => ({
          key: b.id,
          branchId: b.id,
          label: b.name && b.name.length > 0 ? b.name : b.id,
          selected: b.id === activeBranchId,
          hasChildren: (childrenOf.get(b.id) ?? []).length > 0
        })
      )
    })
  }

  // Hovering/focusing an option in column C continues the chain that
  // produced column C (walkIds[0..C)) through that option, revealing the
  // next column; leaves truncate the chain. Arbitrary depth.
  const hoverThrough = (colIdx: number, opt: CascaderOption): void => {
    const prefix = walkIds.slice(0, colIdx).filter((id): id is string => id !== null)
    if (opt.hasChildren && opt.branchId !== null) {
      setHoverPath([...prefix, opt.branchId])
    } else {
      setHoverPath(prefix)
    }
  }

  if (branches.length === 0) {
    return null
  }

  const switchRoute = (branchId: string | null): void => {
    if (branchId === activeBranchId) {
      setOpen(false)
      return
    }
    // Single controller entry: synchronously freeze the outgoing DISPLAYED
    // route's snapshot, open the top transition session, then dispatch. The
    // target window is chosen from the NEW route's own saved anchor
    // (`messageId` + `intraRowOffset`); a target with no snapshot takes its
    // deterministic route-local default (bottom); never outgoing geometry.
    // The message list adopts this session (same epoch) for fetch/position/
    // reveal/commit — no second request, no second epoch.
    try {
      viewport.requestTopRoute(activeTopic.id, branchId)
    } catch {
      // fail-closed: route switch proceeds; target falls back to its default
    }
    setOpen(false)
    setHoverPath(null)
  }

  const commitRename = async (branchId: string): Promise<void> => {
    const next = draft.trim()
    if (next.length === 0) {
      setRenamingId(null)
      return
    }
    try {
      await dbService.renameBranch(activeTopic.id, branchId, next)
      requestTopicBranches(dispatch, activeTopic.id)
      setRenamingId(null)
    } catch (error) {
      logger.error('[BranchSelectorEntry] Failed to rename branch:', error as Error)
      window.toast.error(t('common.error'))
      setRenamingId(null)
    }
  }

  // Escape leaves the editor without writing anything: the draft is dropped
  // and the next edit starts over from the branch's stored name.
  const cancelRename = (): void => {
    setRenamingId(null)
    setDraft('')
  }

  const confirmDelete = async (branchId: string): Promise<void> => {
    setDeletingId(branchId)
    try {
      const { fallbackBranchId } = await deleteBranchSubtree(activeTopic.id, branchId, activeBranchId)
      void fallbackBranchId
      requestTopicBranches(dispatch, activeTopic.id)
      window.toast.success(t('chat.topics.branch.deleted'))
    } catch (error) {
      logger.error('[BranchSelectorEntry] Failed to delete branch:', error as Error)
      window.toast.error(t('common.error'))
    } finally {
      setDeletingId(null)
    }
  }

  const content = (
    <div data-testid="branch-selector-popover" style={{ display: 'flex', maxWidth: 560 }}>
      {columns.map((col, colIdx) => (
        <div
          key={colIdx}
          data-testid={`branch-cascader-col-${colIdx}`}
          style={{
            minWidth: 160,
            maxWidth: 220,
            borderLeft: colIdx > 0 ? '1px solid var(--color-border)' : undefined
          }}>
          {col.options.map((opt) => {
            const isBranch = opt.branchId !== null
            const renaming = isBranch && renamingId === opt.branchId
            return (
              <BranchRouteOptionRow
                key={opt.key}
                branchId={opt.branchId}
                label={opt.label}
                selected={opt.selected}
                testIdPrefix="branch-cascader"
                renaming={renaming}
                draft={draft}
                onDraftChange={setDraft}
                onCommitRename={() => void commitRename(opt.branchId as string)}
                onCancelRename={cancelRename}
                onStartRename={() => {
                  const node = byId.get(opt.branchId as string)
                  setDraft(node?.name ?? '')
                  setRenamingId(opt.branchId)
                }}
                onConfirmDelete={() => void confirmDelete(opt.branchId as string)}
                deleting={deletingId === opt.branchId}
                renameLabel={t('chat.topics.branch.rename')}
                deleteLabel={t('chat.topics.branch.delete')}
                deleteConfirmTitle={t('chat.topics.branch.delete_confirm')}
                hasChildrenIndicator={opt.hasChildren}
                onSelect={() => switchRoute(opt.branchId)}
                onHover={() => hoverThrough(colIdx, opt)}
              />
            )
          })}
        </div>
      ))}
    </div>
  )

  return (
    <>
      {/* Separator */}
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
      <Popover
        content={content}
        trigger="click"
        placement="bottomLeft"
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          // Every open and every close resets to the default expansion so
          // repeat close/open preserves the same no-over-expansion behavior.
          setHoverPath(null)
          if (!v) {
            setRenamingId(null)
          }
        }}
        destroyOnHidden>
        <Button
          data-testid="branch-selector-entry"
          type="text"
          size="small"
          autoInsertSpace={false}
          icon={<GitFork size={14} />}
          // Cap against the toolbar budget (320px) and the live navbar column
          // (100cqw of the navbar scroll container): in a narrow window the
          // entry shrinks instead of overflowing the navbar, so the crumb's
          // own tail-first hiding stays user-visible and the tools stay pinned.
          // Plain % won't do: ancestors are content-sized in the scroll
          // context, so % never reflects the visible column width.
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            maxWidth: 'min(320px, 100cqw)',
            minWidth: 0,
            overflow: 'hidden'
          }}>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              flex: '1 1 auto',
              minWidth: 0,
              maxWidth: '100%',
              overflow: 'hidden',
              fontSize: 12
            }}>
            {/* Leading overflow marker: in normal flow (never overlaid), so no
              theme background matching is needed; shown only while scrolled. */}
            <span ref={leadRef} aria-hidden="true" style={{ display: 'none', flex: '0 0 auto', marginRight: 2 }}>
              …
            </span>
            <span
              ref={crumbRef}
              data-testid="branch-selector-breadcrumb"
              title={breadcrumb}
              style={{
                display: 'block',
                flex: '1 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>
              {breadcrumbSegments.map((segment, index) => (
                <span key={index}>
                  {index > 0 && <span>{' / '}</span>}
                  {segment}
                </span>
              ))}
            </span>
          </span>
          <ChevronDown size={13} className="shrink-0" />
        </Button>
      </Popover>
    </>
  )
}

export default TopicContent
