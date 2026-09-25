import { loggerService } from '@logger'
import { BranchRouteOptionRow } from '@renderer/pages/home/Messages/branchRouteOption'
import { requestTopicBranches, useBranchTree } from '@renderer/pages/home/Messages/useBranchTree'
import { deleteBranchSubtree } from '@renderer/services/db/branchSubtree'
import { dbService } from '@renderer/services/db/DbService'
import type { TopicBranchWire } from '@renderer/services/db/types'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { activeBranchSet, selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant, Topic } from '@renderer/types'
import { Button, Popover } from 'antd'
import { ChevronDown, ChevronRight, GitFork } from 'lucide-react'
import { useMemo, useState } from 'react'
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

const BranchSelectorEntry = ({ activeTopic }: BranchSelectorEntryProps) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
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
  const breadcrumb =
    path.length === 0
      ? topicName
      : `${topicName} / ${path.map((b) => (b.name && b.name.length > 0 ? b.name : b.id)).join(' / ')}`

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
    dispatch(activeBranchSet({ topicId: activeTopic.id, branchId }))
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
      <ChevronRight className="h-4 w-4 text-gray-400" />
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
          icon={<GitFork size={14} />}
          style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 320 }}>
          <span
            data-testid="branch-selector-breadcrumb"
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
            {breadcrumb}
          </span>
          <ChevronDown size={13} />
        </Button>
      </Popover>
    </>
  )
}

export default TopicContent
