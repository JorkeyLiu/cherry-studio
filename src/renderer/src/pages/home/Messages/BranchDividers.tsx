import { loggerService } from '@logger'
import { BranchRouteOptionRow } from '@renderer/pages/home/Messages/branchRouteOption'
import { requestTopicBranches } from '@renderer/pages/home/Messages/useBranchTree'
import { deleteBranchSubtree } from '@renderer/services/db/branchSubtree'
import { dbService } from '@renderer/services/db/DbService'
import type { TopicBranchWire } from '@renderer/services/db/types'
import { useAppDispatch } from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { Button, Popover } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('BranchDividers')

/**
 * Fork-divider placement and menu helpers for topic-internal branches.
 *
 * `displayMessages` arrive oldest→newest; the render loop iterates groups
 * newest→oldest (column-reverse). Dividers are full-width centered rows (no
 * left-side absolute content), so they never overlap TopicSegmentLine's
 * pointer region. A divider renders BEFORE its anchor group in DOM order
 * (visually directly below the anchor message).
 *
 * Two forms per the UI contract:
 * - Untaken fork (main route, or a fork in the viewed route no child was
 *   taken at): `── 此处有 x 条分支 ▾ ──`. The popup includes the current
 *   route plus the direct child branches at the anchor.
 * - Taken fork (the viewed route passes through `taken` at the anchor):
 *   `── <taken branch name> ▾ ──`. The popup switches among the
 *   original/parent route at that fork and the sibling branches, with the
 *   current one selected.
 *
 * Popup binding: reuse ONLY the top selector's visual primitives and popover
 * interaction (overlay container, option row styling/highlight, rename/delete
 * controls). The data is a FLAT peer set for the exact fork (parent/original
 * route plus branches sharing the same `parentBranchId + anchorMessageId`,
 * including current). There is NO cascader, descendant column, hover-to-child,
 * or nested navigation inside a divider popup. Multi-column cascading remains
 * exclusive to the top global branch selector.
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
 * The child branch taken by the viewed route at an anchor, if any: the
 * branch on the root-first `path` whose anchor is `anchorMessageId`.
 * Siblings considered are exactly the direct children at the anchor.
 */
export function takenChildAtAnchor(
  path: readonly TopicBranchWire[],
  anchorMessageId: string,
  childrenAtAnchor: readonly TopicBranchWire[]
): TopicBranchWire | undefined {
  const childIds = new Set(childrenAtAnchor.map((c) => c.id))
  return path.find((b) => b.anchorMessageId === anchorMessageId && childIds.has(b.id))
}

/**
 * Menu options for a fork: the parent/original route first, then the direct
 * child branches in (createdAt, id) order. `taken` (if any) is selected;
 * otherwise the current route (the menu opener context) is selected.
 * The parent option carries `parentBranchId` (null = main route).
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

interface ForkDividerProps {
  topicId: string
  anchorMessageId: string
  /** Taken branch at this anchor (undefined = untaken fork). */
  taken?: TopicBranchWire
  /** Direct child branches at this anchor (non-empty, flat peer set). */
  children: TopicBranchWire[]
  /** Parent route of the children at this fork (null = main route). */
  parentBranchId: string | null
  /** Label of the parent/original route at this fork (topic or parent branch name). */
  parentLabel: string
  /** Current active route (for delete-fallback convergence). */
  activeBranchId: string | null
  /** Label for the count form (e.g. localized "此处有 x 条分支"). Rendered by the caller via i18n. */
  countLabel: string
  onSelectRoute: (branchId: string | null, anchorMessageId: string) => void
}

/**
 * One fork divider at an anchor. Taken forks render the selected branch
 * name as the switcher; untaken forks render the branch-count form. The
 * popup is a flat peer list (parent/original + direct children) reusing the
 * top selector's visual primitives; it overlays content and never pushes
 * layout. Switching targets the shared anchor/current vicinity — never
 * bottom (the caller preserves the visual reference without touching sidebar
 * topic identity). Rename/delete controls are provided for non-main options.
 */
export const ForkDivider = ({
  topicId,
  anchorMessageId,
  taken,
  children,
  parentBranchId,
  parentLabel,
  activeBranchId,
  countLabel,
  onSelectRoute
}: ForkDividerProps) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const takenName = taken && taken.name && taken.name.length > 0 ? taken.name : (taken?.id ?? '')
  const ordered = [...children].sort(
    (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
  )
  const byId = new Map(ordered.map((b) => [b.id, b]))
  const takenId = taken?.id ?? null
  // Flat peer set: parent/original route option + direct children. The
  // selected route is the taken child if any, else the parent/original.
  const options: { branchId: string | null; label: string; selected: boolean }[] = [
    { branchId: parentBranchId, label: parentLabel, selected: takenId === null },
    ...ordered.map((c) => ({
      branchId: c.id as string | null,
      label: c.name && c.name.length > 0 ? c.name : c.id,
      selected: c.id === takenId
    }))
  ]

  const commitRename = async (branchId: string): Promise<void> => {
    const next = draft.trim()
    if (next.length === 0) {
      setRenamingId(null)
      return
    }
    try {
      await dbService.renameBranch(topicId, branchId, next)
      requestTopicBranches(dispatch, topicId)
      setRenamingId(null)
    } catch (error) {
      logger.error('[ForkDivider] Failed to rename branch:', error as Error)
      window.toast.error(t('common.error'))
      setRenamingId(null)
    }
  }

  const confirmDelete = async (branchId: string): Promise<void> => {
    setDeletingId(branchId)
    try {
      await deleteBranchSubtree(topicId, branchId, activeBranchId)
      requestTopicBranches(dispatch, topicId)
      window.toast.success(t('chat.topics.branch.deleted'))
      setOpen(false)
    } catch (error) {
      logger.error('[ForkDivider] Failed to delete branch:', error as Error)
      window.toast.error(t('common.error'))
    } finally {
      setDeletingId(null)
    }
  }

  const content = (
    <div data-testid={`branch-fork-list-${anchorMessageId}`} style={{ minWidth: 200, maxWidth: 300 }}>
      {options.map((opt) => {
        const isBranch = opt.branchId !== null
        const renaming = isBranch && renamingId === opt.branchId
        return (
          <BranchRouteOptionRow
            key={opt.branchId ?? '__parent'}
            branchId={opt.branchId}
            label={opt.label}
            selected={opt.selected}
            testIdPrefix="branch-fork"
            anchorMessageId={anchorMessageId}
            renaming={renaming}
            draft={draft}
            onDraftChange={setDraft}
            onCommitRename={() => void commitRename(opt.branchId as string)}
            onStartRename={() => {
              const node = opt.branchId !== null ? byId.get(opt.branchId) : undefined
              setDraft(node?.name ?? '')
              setRenamingId(opt.branchId)
            }}
            onConfirmDelete={() => void confirmDelete(opt.branchId as string)}
            deleting={deletingId === opt.branchId}
            renameLabel={t('chat.topics.branch.rename')}
            deleteLabel={t('chat.topics.branch.delete')}
            deleteConfirmTitle={t('chat.topics.branch.delete_confirm')}
            onSelect={() => {
              if ((opt.branchId ?? null) === (takenId ?? parentBranchId) && opt.selected) {
                setOpen(false)
                return
              }
              setOpen(false)
              onSelectRoute(opt.branchId, anchorMessageId)
            }}
          />
        )
      })}
    </div>
  )

  return (
    <ForkDividerRow data-testid={`branch-fork-divider-${anchorMessageId}`}>
      <ForkDividerLine />
      <Popover
        content={content}
        trigger="click"
        placement="bottom"
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) setRenamingId(null)
        }}
        destroyOnHidden>
        <ForkDividerNameButton
          data-testid={taken ? `branch-fork-selected-${anchorMessageId}` : `branch-fork-toggle-${anchorMessageId}`}
          type="text"
          size="small"
          aria-expanded={open}
          aria-label={t(open ? 'chat.topics.branch.collapse' : 'chat.topics.branch.expand')}>
          {taken ? takenName : countLabel} ▾
        </ForkDividerNameButton>
      </Popover>
      <ForkDividerLine />
    </ForkDividerRow>
  )
}

const ForkDividerRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 4px 0;
  min-height: 36px;
`

const ForkDividerLine = styled.div`
  flex: 1;
  height: 1px;
  background: var(--color-border);
`

const ForkDividerNameButton = styled(Button)`
  font-size: 12px;
  color: var(--color-text-2);
  white-space: nowrap;
  height: auto;
  padding: 0 8px;
`
