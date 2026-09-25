import { Button, Input, Popconfirm } from 'antd'
import { Pencil, Trash2 } from 'lucide-react'

/**
 * Shared visual primitive for branch route options (top global selector and
 * in-message fork divider popups).
 *
 * - Option row styling/highlight: selected uses `primary`, others `text`
 *   (highlighted background is sufficient — no checkmark icons).
 * - Rename/delete controls for non-main branch options.
 * - No data logic: the caller owns flat vs cascader structure. Dividers pass
 *   a flat peer set only; multi-column cascading stays in the top selector.
 */
export interface BranchRouteOptionRowProps {
  branchId: string | null
  label: string
  selected: boolean
  /** Test-id namespace: `top` renders branch-cascader-*, `fork` renders branch-fork-*. */
  testIdPrefix: 'branch-cascader' | 'branch-fork'
  anchorMessageId?: string
  renaming: boolean
  draft: string
  onDraftChange: (value: string) => void
  onCommitRename: () => void
  onStartRename: () => void
  onConfirmDelete: () => void
  deleting: boolean
  renameLabel: string
  deleteLabel: string
  deleteConfirmTitle: string
  hasChildrenIndicator?: boolean
  onSelect: () => void
  onHover?: () => void
}

export const BranchRouteOptionRow = (props: BranchRouteOptionRowProps) => {
  const {
    branchId,
    label,
    selected,
    testIdPrefix,
    anchorMessageId,
    renaming,
    draft,
    onDraftChange,
    onCommitRename,
    onStartRename,
    onConfirmDelete,
    deleting,
    renameLabel,
    deleteLabel,
    deleteConfirmTitle,
    hasChildrenIndicator,
    onSelect,
    onHover
  } = props
  const isBranch = branchId !== null
  const rowTestId =
    testIdPrefix === 'branch-cascader'
      ? `branch-cascader-row-${branchId ?? 'main'}`
      : anchorMessageId !== undefined
        ? `branch-fork-row-${anchorMessageId}-${branchId ?? 'parent'}`
        : `branch-fork-row-${branchId ?? 'parent'}`
  const itemTestId =
    testIdPrefix === 'branch-cascader'
      ? `branch-cascader-item-${branchId ?? 'main'}`
      : anchorMessageId !== undefined
        ? `branch-fork-item-${branchId ?? `parent-${anchorMessageId}`}`
        : `branch-fork-item-${branchId ?? 'parent'}`
  const renameTestId =
    testIdPrefix === 'branch-cascader' ? `branch-rename-btn-${branchId}` : `branch-fork-rename-btn-${branchId}`
  const deleteTestId =
    testIdPrefix === 'branch-cascader' ? `branch-delete-btn-${branchId}` : `branch-fork-delete-btn-${branchId}`
  const inputTestId = testIdPrefix === 'branch-cascader' ? 'branch-selector-rename-input' : 'branch-fork-rename-input'

  return (
    <div
      data-testid={rowTestId}
      style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 4px' }}
      onMouseEnter={onHover}
      onFocus={onHover}>
      {renaming ? (
        <Input
          data-testid={inputTestId}
          size="small"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onPressEnter={onCommitRename}
          onBlur={onCommitRename}
          autoFocus
        />
      ) : (
        <Button
          data-testid={itemTestId}
          type={selected ? 'primary' : 'text'}
          size="small"
          block
          style={{ display: 'flex', justifyContent: 'flex-start', textAlign: 'left', overflow: 'hidden' }}
          onClick={onSelect}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label}
            {hasChildrenIndicator ? ' ›' : ''}
          </span>
        </Button>
      )}
      {isBranch && !renaming && (
        <>
          <Button
            data-testid={renameTestId}
            type="text"
            size="small"
            icon={<Pencil size={13} />}
            aria-label={renameLabel}
            onClick={onStartRename}
            style={{ width: 26, minWidth: 26, padding: 0 }}
          />
          <Popconfirm title={deleteConfirmTitle} okButtonProps={{ danger: true }} onConfirm={onConfirmDelete}>
            <Button
              data-testid={deleteTestId}
              type="text"
              size="small"
              danger
              icon={<Trash2 size={13} />}
              loading={deleting}
              aria-label={deleteLabel}
              style={{ width: 26, minWidth: 26, padding: 0 }}
            />
          </Popconfirm>
        </>
      )}
    </div>
  )
}
