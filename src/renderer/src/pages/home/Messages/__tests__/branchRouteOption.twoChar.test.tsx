/**
 * Two-char Chinese branch names: Antd Button must not insert inter-char space.
 * Covers contract (7): local autoInsertSpace={false} on BranchRouteOptionRow
 * (popup), ForkDivider main button, and the top selector entry button.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ForkDivider } from '../BranchDividers'
import { BranchRouteOptionRow } from '../branchRouteOption'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/pages/home/Messages/useBranchTree', () => ({
  requestTopicBranches: vi.fn()
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: { renameBranch: vi.fn() }
}))

vi.mock('@renderer/services/db/branchSubtree', () => ({
  deleteBranchSubtree: vi.fn()
}))

const baseProps = {
  branchId: 'b1' as string | null,
  label: '分支',
  selected: true,
  testIdPrefix: 'branch-fork' as const,
  anchorMessageId: 'm1',
  renaming: false,
  draft: '',
  onDraftChange: () => {},
  onCommitRename: () => {},
  onStartRename: () => {},
  onConfirmDelete: () => {},
  deleting: false,
  renameLabel: 'rename',
  deleteLabel: 'delete',
  deleteConfirmTitle: 'confirm',
  onSelect: () => {}
}

describe('BranchRouteOptionRow two-char Chinese name', () => {
  it('renders the selected two-char label textContent unchanged (no spaced chars)', () => {
    render(<BranchRouteOptionRow {...baseProps} />)
    const btn = screen.getByTestId('branch-fork-item-b1')
    // Antd may wrap label in a span; textContent must stay exactly two chars.
    expect(btn.textContent).toBe('分支')
    expect(btn.textContent).not.toContain(' ')
    // No two-chinese spacing behavior: Antd inserts a space char between two
    // CJK chars when autoInsertSpace is on; assert it did not happen.
    expect(btn.innerHTML).not.toMatch(/分\s+支/)
  })

  it('sets autoInsertSpace={false} on the option Button (source-level guard)', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync('src/renderer/src/pages/home/Messages/branchRouteOption.tsx', 'utf8')
    expect(src).toMatch(/autoInsertSpace=\{false\}/)
    // Local only: no global ConfigProvider autoInsertSpace=false.
    expect(src).not.toMatch(/ConfigProvider/)
  })
})

describe('ForkDivider main button two-char Chinese name (real Antd Button)', () => {
  it('renders the taken two-char branch name without inter-char spacing', () => {
    const taken = {
      id: 'b1',
      topicId: 't1',
      parentBranchId: null,
      anchorMessageId: 'm1',
      name: '分支',
      createdAt: null,
      updatedAt: null
    }
    render(
      <ForkDivider
        topicId="t1"
        anchorMessageId="m1"
        taken={taken}
        children={[taken]}
        parentBranchId={null}
        parentLabel="主题"
        activeBranchId="b1"
        countLabel="此处有 1 条分支"
        onSelectRoute={() => {}}
      />
    )
    const btn = screen.getByTestId('branch-fork-selected-m1')
    // Main button text is `<name> ▾`; the name itself must stay two adjacent chars.
    expect(btn.textContent).toContain('分支')
    expect(btn.textContent?.replace(' ▾', '')).toBe('分支')
    expect(btn.innerHTML).not.toMatch(/分\s+支/)
  })

  it('sets local autoInsertSpace={false} on the divider main button and top entry (no global ConfigProvider)', async () => {
    const fs = await import('fs')
    const dividers = fs.readFileSync('src/renderer/src/pages/home/Messages/BranchDividers.tsx', 'utf8')
    const btnSlice = dividers.slice(
      dividers.indexOf('<ForkDividerNameButton'),
      dividers.indexOf('<ForkDividerNameButton') + 600
    )
    expect(btnSlice).toMatch(/autoInsertSpace=\{false\}/)
    expect(dividers).not.toMatch(/ConfigProvider/)
    const topicContent = fs.readFileSync(
      'src/renderer/src/pages/home/components/ChatNavBar/ChatNavbarContent/TopicContent.tsx',
      'utf8'
    )
    const entryIdx = topicContent.indexOf('branch-selector-entry')
    expect(topicContent.slice(entryIdx - 400, entryIdx + 400)).toMatch(/autoInsertSpace=\{false\}/)
  })
})
