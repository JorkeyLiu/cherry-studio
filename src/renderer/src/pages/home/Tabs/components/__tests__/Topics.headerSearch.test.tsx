/**
 * Bounded Topics sidebar repairs — header search, footer layout, icon contract.
 *
 * Covers, with heavy IO children mocked but the real Topics header/list wiring:
 *  - BookSearch button immediately left of import
 *  - open replaces New Topic + search button with a focused input + X close
 *    (import/manage stay accessible); live filtering without Enter; Escape/X
 *    close and clear the filter
 *  - filtering in the ordinary list and in multi-select, preserving batch
 *    selection of filtered non-pinned topics
 *  - normal-flow footer: no 70px overlay clearance; trash hidden while
 *    management is active, normal otherwise
 *  - icon/layout source contract (SquareArrowOutUpLeft export,
 *    FileDown import, FolderOutput move, no Download identifier)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const testBed = vi.hoisted(() => ({
  topics: [] as any[],
  assistant: null as any,
  assistants: [] as any[],
  list: [] as any[],
  style: {} as any,
  disabled: false,
  manageProps: null as any
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('react-redux', () => {
  const fakeState = {
    runtime: { chat: { renamingTopics: [], newlyRenamedTopics: [] } },
    messages: { loadingByTopic: {}, fulfilledByTopic: {} },
    settings: { exportMenuOptions: {} },
    assistants: { assistants: [] }
  }
  return {
    useSelector: (selector: (state: typeof fakeState) => unknown) => selector(fakeState),
    useDispatch: () => vi.fn()
  }
})

vi.mock('@renderer/components/AddButton', async () => {
  const React = await import('react')
  return {
    default: ({ children, onClick }: any) =>
      React.createElement('button', { 'data-testid': 'mock-add-btn', onClick }, children)
  }
})

vi.mock('@renderer/components/Avatar/AssistantAvatar', async () => {
  const React = await import('react')
  return {
    default: ({ assistant }: any) => React.createElement('span', null, assistant?.name ?? '')
  }
})

vi.mock('@renderer/components/DraggableList', async () => {
  const React = await import('react')
  return {
    DraggableVirtualList: (props: any) => {
      testBed.list = props.list
      testBed.style = props.style ?? {}
      testBed.disabled = props.disabled
      return React.createElement(
        'div',
        { 'data-testid': 'mock-topics-list' },
        React.createElement('div', { 'data-testid': 'mock-topics-header' }, props.header),
        ...(props.list ?? []).map((item: any, index: number) =>
          React.createElement(
            'div',
            { key: item.id, 'data-testid': 'mock-topic-row', 'data-topic-id': item.id },
            props.children(item, index)
          )
        )
      )
    }
  }
})

vi.mock('../TopicManageMode', async (importOriginal) => {
  const React = await import('react')
  const orig: any = await importOriginal()
  return {
    ...orig,
    TopicManagePanel: (props: any) => {
      testBed.manageProps = props
      if (!props.manageState?.isManageMode) return null
      return React.createElement('div', { 'data-testid': 'mock-manage-panel' })
    }
  }
})

vi.mock('../TopicTrashPanel', async () => {
  const React = await import('react')
  return {
    TopicTrashPanel: () => React.createElement('div', { 'data-testid': 'mock-trash-panel' })
  }
})

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: testBed.assistant,
    addTopic: vi.fn(),
    removeTopic: vi.fn(),
    moveTopic: vi.fn(),
    updateTopic: vi.fn(),
    updateTopics: vi.fn()
  }),
  useAssistants: () => ({ assistants: testBed.assistants })
}))

vi.mock('@renderer/hooks/useInPlaceEdit', () => ({
  useInPlaceEdit: () => ({ startEdit: vi.fn(), isEditing: false, inputProps: {} })
}))

vi.mock('@renderer/hooks/useNotesSettings', () => ({
  useNotesSettings: () => ({ notesPath: '' })
}))

vi.mock('@renderer/hooks/useRuntime', () => ({
  modelGenerating: vi.fn(async () => {})
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  finishTopicRenaming: vi.fn(),
  startTopicRenaming: vi.fn()
}))

vi.mock('@renderer/services/ApiService', () => ({
  fetchMessagesSummary: vi.fn()
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultTopic: (assistantId: string) => ({ id: 'new-topic', assistantId, name: 'New Topic' })
}))

vi.mock('@renderer/services/db', () => ({
  dbService: { fetchTopicNamingContext: vi.fn(), updateTopicMetadata: vi.fn() }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  emptyOrdinaryTrash: vi.fn(),
  ensureOrdinaryTopicOwnership: vi.fn(),
  hardDeleteOrdinaryTopic: vi.fn(),
  purgeExpiredOrdinaryTopics: vi.fn(async () => {}),
  restoreOrdinaryTopic: vi.fn()
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { ADD_NEW_TOPIC: 'ADD_NEW_TOPIC', EXPORT_TOPIC_IMAGE: 'EXPORT_TOPIC_IMAGE' },
  EventEmitter: { emit: vi.fn() }
}))

vi.mock('@renderer/services/topicDataJson', () => ({
  exportTopicDataToFile: vi.fn(),
  importTopicDataFromFile: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  default: { getState: () => ({ assistants: { assistants: [] } }), dispatch: vi.fn(), subscribe: vi.fn() }
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopic: (payload: unknown) => ({ type: 'assistants/updateTopic', payload })
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: { setTopicFulfilled: (payload: unknown) => ({ type: 'messages/setTopicFulfilled', payload }) }
}))

vi.mock('@renderer/utils', () => ({
  classNames: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  removeSpecialCharactersForFileName: (name: string) => name
}))

vi.mock('@renderer/utils/export', () => ({
  exportMarkdownToJoplin: vi.fn(),
  exportMarkdownToSiyuan: vi.fn(),
  exportMarkdownToYuque: vi.fn(),
  exportTopicAsMarkdown: vi.fn(),
  exportTopicToNotes: vi.fn(),
  exportTopicToNotion: vi.fn(),
  topicToMarkdown: vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/snapshotBlocks', () => ({
  createSnapshotBlockMap: vi.fn(() => new Map())
}))

vi.mock('@renderer/components/Popups/ObsidianExportPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/components/Popups/PromptPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/components/Popups/SaveToKnowledgePopup', () => ({
  default: { showForTopic: vi.fn() }
}))

vi.mock('./topicDeletionFlow', () => ({
  deleteTopicFlow: vi.fn()
}))

import { Topics } from '../Topics'

function seedTopics() {
  testBed.topics = [
    {
      id: 't-alpha',
      assistantId: 'assistant-1',
      name: 'Alpha Project',
      pinned: false,
      prompt: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages: []
    },
    {
      id: 't-beta',
      assistantId: 'assistant-1',
      name: 'Beta Notes',
      pinned: false,
      prompt: '',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messages: []
    },
    {
      id: 't-pinned',
      assistantId: 'assistant-1',
      name: 'Pinned Alpha',
      pinned: true,
      prompt: '',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      messages: []
    }
  ]
  testBed.assistant = { id: 'assistant-1', name: 'Assistant One', topics: testBed.topics }
  testBed.assistants = [testBed.assistant, { id: 'assistant-2', name: 'Assistant Two', topics: [] }]
  testBed.list = []
  testBed.style = {}
  testBed.manageProps = null
}

function renderTopics() {
  const setActiveTopic = vi.fn()
  render(<Topics assistant={testBed.assistant} activeTopic={testBed.topics[0]} setActiveTopic={setActiveTopic} />)
  return { setActiveTopic }
}

function headerEl() {
  return screen.getByTestId('mock-topics-header')
}

describe('Topics header search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedTopics()
  })

  it('places the Search button immediately left of import', () => {
    renderTopics()
    const header = headerEl()
    const searchBtn = screen.getByTestId('topic-search-btn')
    const importBtn = screen.getByTestId('topic-import-btn')
    expect(header.contains(searchBtn)).toBe(true)
    expect(header.contains(importBtn)).toBe(true)
    // Immediately left: import follows search with no topic header button between.
    expect(searchBtn.compareDocumentPosition(importBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(header.querySelector('svg.lucide-book-search')).not.toBeNull()
    expect(header.querySelector('svg.lucide-file-down')).not.toBeNull()
  })

  it('open replaces New Topic + search button with a focused input + X, keeps import/manage', () => {
    renderTopics()
    fireEvent.click(screen.getByTestId('topic-search-btn'))

    const input = screen.getByTestId('topic-search-input')
    expect(input).toBeInTheDocument()
    expect(document.activeElement).toBe(input)
    // New Topic and the search button are replaced…
    expect(screen.queryByTestId('mock-add-btn')).toBeNull()
    expect(screen.queryByTestId('topic-search-btn')).toBeNull()
    // …while import/manage stay accessible.
    expect(screen.getByTestId('topic-import-btn')).toBeInTheDocument()
    expect(screen.getByTestId('topic-manage-btn')).toBeInTheDocument()
    expect(screen.getByTestId('topic-search-close')).toBeInTheDocument()
  })

  it('live-filters without Enter; Escape and X close and clear the filter', async () => {
    renderTopics()
    fireEvent.click(screen.getByTestId('topic-search-btn'))
    const input = screen.getByTestId('topic-search-input')

    // No Enter pressed: typing alone filters (Alpha Project + Pinned Alpha).
    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => expect(testBed.list.map((t: any) => t.id).sort()).toEqual(['t-alpha', 't-pinned']))

    // Escape closes and clears.
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('topic-search-input')).toBeNull()
    expect(screen.getByTestId('topic-search-btn')).toBeInTheDocument()
    await waitFor(() => expect(testBed.list.map((t: any) => t.id).sort()).toEqual(['t-alpha', 't-beta', 't-pinned']))

    // X close also clears.
    fireEvent.click(screen.getByTestId('topic-search-btn'))
    const reopened = screen.getByTestId('topic-search-input')
    fireEvent.change(reopened, { target: { value: 'beta' } })
    await waitFor(() => expect(testBed.list.map((t: any) => t.id)).toEqual(['t-beta']))
    fireEvent.click(screen.getByTestId('topic-search-close'))
    expect(screen.queryByTestId('topic-search-input')).toBeNull()
    await waitFor(() => expect(testBed.list).toHaveLength(3))
  })

  it('filters in multi-select and preserves batch selection of filtered non-pinned topics', async () => {
    renderTopics()
    // Enter management first, then use the single header search: the filter
    // must apply to the multi-select list as well.
    fireEvent.click(screen.getByTestId('topic-manage-btn'))
    expect(screen.getByTestId('mock-manage-panel')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('topic-search-btn'))
    fireEvent.change(screen.getByTestId('topic-search-input'), { target: { value: 'alpha' } })
    await waitFor(() => expect(testBed.list).toHaveLength(2))
    await waitFor(() =>
      expect(testBed.manageProps.filteredTopics.map((t: any) => t.id).sort()).toEqual(['t-alpha', 't-pinned'])
    )

    // Selecting a filtered non-pinned row works in manage mode…
    fireEvent.click(document.querySelector('[data-testid="topic-item"][data-topic-id="t-alpha"]')!)
    await waitFor(() => expect(Array.from(testBed.manageProps.manageState.selectedIds)).toEqual(['t-alpha']))

    // …while a pinned row is not selectable.
    fireEvent.click(document.querySelector('[data-testid="topic-item"][data-topic-id="t-pinned"]')!)
    await waitFor(() => expect(Array.from(testBed.manageProps.manageState.selectedIds)).toEqual(['t-alpha']))
  })

  it('uses normal-flow footer spacing and hides trash only while managing', () => {
    renderTopics()
    // Ordinary list: no overlay clearance, trash visible.
    expect(testBed.style.paddingBottom).not.toBe(70)
    expect(screen.getByTestId('mock-trash-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-manage-panel')).toBeNull()

    fireEvent.click(screen.getByTestId('topic-manage-btn'))
    // Management: still no overlay clearance; trash hidden to avoid stacked
    // borders/occlusion; the list is non-draggable while managing.
    expect(testBed.style.paddingBottom).not.toBe(70)
    expect(testBed.disabled).toBe(true)
    expect(screen.queryByTestId('mock-trash-panel')).toBeNull()
    expect(screen.getByTestId('mock-manage-panel')).toBeInTheDocument()
  })
})

describe('Topics icon/layout source contract', () => {
  const topicsPath = join(process.cwd(), 'src/renderer/src/pages/home/Tabs/components/Topics.tsx')
  const managePath = join(process.cwd(), 'src/renderer/src/pages/home/Tabs/components/TopicManageMode.tsx')
  const topicsSource = readFileSync(topicsPath, 'utf8')
  const manageSource = readFileSync(managePath, 'utf8')

  it('uses the specified lucide icons and no removed ones', () => {
    for (const icon of ['SquareArrowOutUpLeft', 'FileDown', 'FolderOutput', 'BookSearchIcon', 'ListTodo']) {
      expect(topicsSource).toContain(icon)
    }
    expect(topicsSource).toContain('lucide-book-search')
    expect(topicsSource).not.toContain('FileSearch')
    expect(manageSource).toContain('FolderOutput')
    expect(topicsSource).not.toContain('TextSearch')
    expect(topicsSource).not.toContain('ListChecks')
    for (const removed of ['FileInput', 'FileOutput', 'FolderOpen']) {
      expect(topicsSource).not.toContain(removed)
      expect(manageSource).not.toContain(removed)
    }
  })

  it('has a single header search (no bottom search state) and no overlay footer', () => {
    expect(topicsSource).toContain('topic-search-btn')
    expect(topicsSource).toContain('topic-search-input')
    expect(topicsSource).toContain('topic-search-close')
    expect(topicsSource).toContain('!isManageMode')
    expect(topicsSource).not.toContain('isSearchMode')
    expect(topicsSource).not.toContain('isManageMode ? 70')
    expect(manageSource).not.toContain('isSearchMode')
    expect(manageSource).not.toContain('absolute bottom')
    expect(manageSource).toContain('topic-manage-toolbar')
    expect(manageSource).toContain('topic-batch-move-btn')
  })

  it('references no Download identifier (reported ReferenceError has no source here)', () => {
    expect(topicsSource).not.toContain('Download')
    expect(manageSource).not.toContain('Download')
  })
})
