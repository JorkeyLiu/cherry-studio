/**
 * Two-char Chinese branch names: the shared tree panel renders labels in a
 * plain span (never an Antd Button), so no inter-char space is inserted.
 * Covers contract (7): local autoInsertSpace={false} on the ForkDivider main
 * button and the top selector entry button.
 */
import type { TopicBranchWire } from '@renderer/services/db/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ForkDivider } from '../BranchDividers'
import { buildForkScopeIndex } from '../branchSelector/branchTreeModel'
import { BranchTreePanel } from '../branchSelector/BranchTreePanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
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
const panelProps = {
  topicName: '主题',
  activeBranchId: null as string | null,
  visible: true,
  onSelectRoute: () => {},
  onCommitRename: () => {},
  onConfirmDelete: () => {},
  onCopyBranch: () => {},
  deletingBranchId: null as string | null,
  copyingBranchId: null as string | null,
  onDeleteConfirmChange: () => {},
  maxWidth: 420
}

const twoCharChild = (name: string): TopicBranchWire =>
  ({
    id: 'b1',
    topicId: 't1',
    parentBranchId: null,
    anchorMessageId: 'm1',
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }) as TopicBranchWire

describe('Shared tree panel two-char Chinese name', () => {
  it('renders the two-char label textContent unchanged (no spaced chars)', () => {
    render(<BranchTreePanel index={buildForkScopeIndex(null, [twoCharChild('分支')])} {...panelProps} />)
    const row = screen.getByTestId('branch-cascader-item-b1')
    // The panel renders labels in a plain span, never an Antd Button, so no
    // two-chinese auto-spacing can apply; textContent stays exactly two chars.
    expect(row.textContent).toBe('分支')
    expect(row.textContent).not.toContain(' ')
    expect(row.innerHTML).not.toMatch(/分\s+支/)
  })

  it('proves the single menu: no BranchRouteOptionRow remains in prod', async () => {
    const fs = await import('fs')
    for (const file of [
      'src/renderer/src/pages/home/Messages/branchRouteOption.tsx',
      'src/renderer/src/pages/home/Messages/BranchDividers.tsx'
    ]) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/BranchRouteOptionRow/)
    }
    // The hook the panel edits through still lives in the option module.
    const src = fs.readFileSync('src/renderer/src/pages/home/Messages/branchRouteOption.tsx', 'utf8')
    expect(src).toMatch(/useBranchRenameInput/)
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
