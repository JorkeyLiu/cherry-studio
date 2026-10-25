import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/Avatar/AssistantAvatar', () => ({
  default: ({ assistant }: { assistant: { name: string } }) => <span>{assistant.name}</span>
}))

vi.mock('@renderer/hooks/useRuntime', () => ({
  modelGenerating: vi.fn(async () => {})
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  softDeleteOrdinaryTopic: vi.fn(async () => {})
}))

vi.mock('@renderer/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ')
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`)
  })
}))

import type { Assistant, Topic } from '@renderer/types'

import type { TopicManageModeState } from '../TopicManageMode'
import { TopicManagePanel } from '../TopicManageMode'

const topic = (id: string, overrides: Partial<Topic> = {}): Topic =>
  ({
    id,
    assistantId: 'assistant-1',
    name: `Topic ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    pinned: false,
    ...overrides
  }) as Topic

const assistantFixture = (topics: Topic[]): Assistant =>
  ({
    id: 'assistant-1',
    name: 'Assistant One',
    topics
  }) as Assistant

function makeManageState(
  overrides: Partial<TopicManageModeState> = {},
  spies: { setSelectedIds?: ReturnType<typeof vi.fn> } = {}
): TopicManageModeState {
  return {
    isManageMode: true,
    selectedIds: new Set<string>(),
    searchText: '',
    enterManageMode: vi.fn(),
    exitManageMode: vi.fn(),
    toggleSelectTopic: vi.fn(),
    setSelectedIds: spies.setSelectedIds ?? vi.fn(),
    setSearchText: vi.fn(),
    ...overrides
  }
}

function renderPanel(options: {
  assistant: Assistant
  assistants: Assistant[]
  selectedIds?: Set<string>
  searchText?: string
  filteredTopics?: Topic[]
  isManageMode?: boolean
}) {
  const { assistant, assistants } = options
  const activeTopic = assistant.topics[0] ?? topic('fallback')
  const setSelectedIds = vi.fn()
  const manageState = makeManageState(
    {
      selectedIds: options.selectedIds ?? new Set<string>(),
      searchText: options.searchText ?? '',
      isManageMode: options.isManageMode ?? true
    },
    { setSelectedIds }
  )
  const props = {
    assistant,
    assistants,
    activeTopic,
    setActiveTopic: vi.fn(),
    updateTopics: vi.fn(),
    moveTopic: vi.fn(),
    manageState,
    filteredTopics: options.filteredTopics ?? assistant.topics
  }
  const view = render(<TopicManagePanel {...props} />)
  return { ...view, manageState, props, setSelectedIds }
}

describe('TopicManagePanel toolbar (bounded sidebar repairs)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing outside manage mode (recycle bin keeps normal behavior there)', () => {
    const assistant = assistantFixture([topic('t1')])
    const { container } = renderPanel({ assistant, assistants: [assistant], isManageMode: false })
    expect(screen.queryByTestId('topic-manage-toolbar')).not.toBeInTheDocument()
    expect(container.firstChild).toBeNull()
  })

  it('occupies normal flex layout space (no absolute overlay, no magic clearance)', () => {
    const assistant = assistantFixture([topic('t1')])
    renderPanel({ assistant, assistants: [assistant] })
    const toolbar = screen.getByTestId('topic-manage-toolbar')
    expect(toolbar.className).toContain('shrink-0')
    expect(toolbar.className).not.toContain('absolute')
  })

  it('exposes no bottom search UI (single header search only)', () => {
    const assistant = assistantFixture([topic('t1')])
    const { container } = renderPanel({ assistant, assistants: [assistant] })
    const toolbar = screen.getByTestId('topic-manage-toolbar')
    expect(toolbar.querySelector('input')).toBeNull()
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
    expect(container.querySelector('svg.lucide-search')).toBeNull()
  })

  it('always shows the batch move control, disabled with no selection (two assistants)', () => {
    const assistant = assistantFixture([topic('t1')])
    const other = { ...assistantFixture([]), id: 'assistant-2', name: 'Assistant Two' }
    renderPanel({ assistant, assistants: [assistant, other] })
    const moveBtn = screen.getByTestId('topic-batch-move-btn')
    expect(moveBtn).toBeInTheDocument()
    expect(moveBtn).toBeDisabled()
  })

  it('keeps the batch move control visible but disabled in the single-assistant state', () => {
    const assistant = assistantFixture([topic('t1')])
    renderPanel({ assistant, assistants: [assistant], selectedIds: new Set(['t1']) })
    const moveBtn = screen.getByTestId('topic-batch-move-btn')
    expect(moveBtn).toBeInTheDocument()
    // No target assistants: disabled even with a selection.
    expect(moveBtn).toBeDisabled()
  })

  it('enables batch move with a selection and target assistants, using the FolderOutput icon', () => {
    const assistant = assistantFixture([topic('t1')])
    const other = { ...assistantFixture([]), id: 'assistant-2', name: 'Assistant Two' }
    const { container } = renderPanel({
      assistant,
      assistants: [assistant, other],
      selectedIds: new Set(['t1'])
    })
    expect(screen.getByTestId('topic-batch-move-btn')).toBeEnabled()
    expect(container.querySelector('svg.lucide-folder-output')).not.toBeNull()
  })

  it('select-all covers only filtered non-pinned topics (header filter preserved)', () => {
    const pinned = topic('p1', { name: 'Pinned Keep', pinned: true })
    const matchedA = topic('u1', { name: 'Alpha One' })
    const matchedB = topic('u2', { name: 'Alpha Two' })
    const unmatched = topic('u3', { name: 'Beta Other' })
    const assistant = assistantFixture([pinned, matchedA, matchedB, unmatched])
    const { container, setSelectedIds } = renderPanel({
      assistant,
      assistants: [assistant],
      searchText: 'alpha',
      filteredTopics: [matchedA, matchedB]
    })
    const toolbar = screen.getByTestId('topic-manage-toolbar')
    const selectAllBtn = toolbar.querySelectorAll('button')[0]
    fireEvent.click(selectAllBtn)
    expect(setSelectedIds).toHaveBeenCalledTimes(1)
    expect(setSelectedIds).toHaveBeenCalledWith(new Set(['u1', 'u2']))
    expect(container.querySelector('svg.lucide-folder-output')).not.toBeNull()
  })
})
