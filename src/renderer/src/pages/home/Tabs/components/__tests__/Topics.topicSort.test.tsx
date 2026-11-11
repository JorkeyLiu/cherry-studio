/**
 * Topics ordering menu wiring + bounded filtered drag (component level, real
 * Topics component with heavy IO children mocked).
 *
 * Covers:
 *  - the context submenu is labelled "sort by" ("排序方式") and exposes exactly
 *    the two orderings, with no icon of their own and no extra wording;
 *  - the ordering the list is actually kept in is shown by the selected entry:
 *    "by update time" while the continuous policy is on, and "by creation
 *    time" for every other mode (manual/legacy included), never by a separate
 *    "already enabled" label;
 *  - the parent title never takes the selected (primary) color because of a
 *    selected child (local scoped class), with its icon and the two labels
 *    unchanged;
 *  - "by creation time" applies the one-shot createdAt-desc order (pinned
 *    first) and returns the assistant to manual;
 *  - "by update time" delegates to the runtime ordering service (one
 *    authoritative read + the persisted policy) instead of sorting by
 *    Redux timestamps;
 *  - a failed async activation leaves the current order untouched;
 *  - manual drag writes the complete list back (search-hidden topics survive,
 *    no topic is lost) and never disables the continuous policy.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const testBed = vi.hoisted(() => ({
  topics: [] as any[],
  assistant: null as any,
  assistants: [] as any[],
  list: [] as any[],
  onUpdate: null as any,
  menuItems: [] as any[],
  menu: null as any,
  updateTopics: null as any,
  updateAssistant: null as any,
  enableUpdateTimeOrder: null as any,
  resetTopicMessageTimes: null as any
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
vi.mock('antd', async (importOriginal) => {
  const React = await import('react')
  const actual: any = await importOriginal()
  return {
    ...actual,
    Dropdown: (props: any) => {
      testBed.menu = props.menu
      testBed.menuItems = props.menu?.items ?? []
      return React.createElement(React.Fragment, null, props.children)
    },
    Tooltip: ({ children }: any) => children
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
  return { default: ({ assistant }: any) => React.createElement('span', null, assistant?.name ?? '') }
})

vi.mock('@renderer/components/DraggableList', async () => {
  const React = await import('react')
  return {
    DraggableVirtualList: (props: any) => {
      testBed.list = props.list
      testBed.onUpdate = props.onUpdate
      return React.createElement(
        'div',
        { 'data-testid': 'mock-topics-list' },
        props.header ? React.createElement('div', { 'data-testid': 'mock-topics-header' }, props.header) : null,
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
  const actual: any = await importOriginal()
  return {
    ...actual,
    TopicManagePanel: () => null
  }
})

vi.mock('../TopicTrashPanel', () => ({ TopicTrashPanel: () => null }))
vi.mock('../topicDeletionFlow', () => ({ deleteTopicFlow: vi.fn() }))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: testBed.assistant,
    addTopic: vi.fn(),
    removeTopic: vi.fn(),
    moveTopic: vi.fn(),
    updateTopic: vi.fn(),
    updateTopics: testBed.updateTopics,
    updateAssistant: testBed.updateAssistant
  }),
  useAssistants: () => ({ assistants: testBed.assistants })
}))

vi.mock('@renderer/hooks/useInPlaceEdit', () => ({
  useInPlaceEdit: () => ({ startEdit: vi.fn(), isEditing: false, inputProps: {} })
}))
vi.mock('@renderer/hooks/useNotesSettings', () => ({ useNotesSettings: () => ({ notesPath: '' }) }))
vi.mock('@renderer/hooks/useRuntime', () => ({ modelGenerating: vi.fn(async () => {}) }))
vi.mock('@renderer/hooks/useTopic', () => ({ finishTopicRenaming: vi.fn(), startTopicRenaming: vi.fn() }))
vi.mock('@renderer/services/ApiService', () => ({ fetchMessagesSummary: vi.fn() }))
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
vi.mock('@renderer/services/topicMessageTimes', () => ({
  enableUpdateTimeOrder: (...args: unknown[]) => testBed.enableUpdateTimeOrder(...args),
  resetTopicMessageTimes: (...args: unknown[]) => testBed.resetTopicMessageTimes(...args)
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
  exportTopicAsMarkdown: vi.fn(),
  exportTopicToNotes: vi.fn(),
  topicToMarkdown: vi.fn()
}))
vi.mock('@renderer/utils/messageUtils/snapshotBlocks', () => ({ createSnapshotBlockMap: vi.fn(() => new Map()) }))
vi.mock('@renderer/components/Popups/PromptPopup', () => ({ default: { show: vi.fn() } }))
vi.mock('@renderer/components/Popups/SaveToKnowledgePopup', () => ({ default: { showForTopic: vi.fn() } }))

import { Topics } from '../Topics'

function makeTopic(id: string, name: string, createdAt: string, updatedAt: string, pinned = false) {
  return { id, assistantId: 'a1', name, prompt: '', pinned, createdAt, updatedAt, messages: [] }
}

function seedTopics(topicOrderMode?: 'manual' | 'updated') {
  testBed.topics = [
    makeTopic('t-alpha', 'Project Alpha', '2026-01-01T00:00:00.000Z', '2026-03-05T00:00:00.000Z'),
    makeTopic('t-beta', 'Project Beta', '2026-01-02T00:00:00.000Z', '2026-01-20T00:00:00.000Z'),
    makeTopic('t-gamma', 'Gamma Draft', '2026-01-04T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    makeTopic('t-pin', 'Project Pinned', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', true)
  ]
  testBed.assistant = {
    id: 'a1',
    name: 'Assistant One',
    topics: testBed.topics,
    ...(topicOrderMode ? { topicOrderMode } : {})
  }
  testBed.assistants = [testBed.assistant]
  testBed.list = []
  testBed.onUpdate = null
  testBed.menuItems = []
  testBed.menu = null
  testBed.updateTopics = vi.fn()
  testBed.updateAssistant = vi.fn()
  testBed.enableUpdateTimeOrder = vi.fn(async () => true)
  testBed.resetTopicMessageTimes = vi.fn()
}

function renderTopics() {
  render(<Topics assistant={testBed.assistant} activeTopic={testBed.topics[0]} setActiveTopic={vi.fn()} />)
}

/** The context menu is built for the right-clicked topic only. */
function openMenu(topicId = 't-alpha') {
  const row = document.querySelector(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  if (!row) throw new Error(`topic row ${topicId} not rendered`)
  fireEvent.contextMenu(row)
}

function sortParent() {
  return testBed.menuItems.find((entry) => entry?.key === 'topic-sort')
}

function sortSubmenu() {
  return sortParent()?.children ?? []
}

function sortItem(key: string) {
  return sortSubmenu().find((entry) => entry?.key === key)
}

function reportedIds() {
  const firstCall = testBed.updateTopics.mock.calls[0]
  if (!firstCall) throw new Error('updateTopics was not called')
  return (firstCall[0] as any[]).map((topic) => topic.id)
}

describe('Topics ordering submenu', () => {
  it('is titled "sort by", keeps the parent sort icon and gives the two entries no icons', async () => {
    seedTopics()
    renderTopics()
    openMenu()

    await waitFor(() => expect(sortSubmenu()).toHaveLength(2))
    expect(sortParent().label).toBe('chat.topics.sort.title')
    expect(sortParent().icon).toBeTruthy()
    // The parent carries the local class that keeps its title in the normal
    // text color even while one of its entries is selected (rc-menu would
    // otherwise mark the parent as selected and paint it with the primary
    // color). The class is scoped to this submenu only.
    expect(sortParent().className).toBe('topic-sort-submenu')
    expect(sortItem('sort-created-at').label).toBe('chat.topics.sort.by_created_at')
    expect(sortItem('sort-updated-at').label).toBe('chat.topics.sort.by_updated_at')
    // No icon on either ordering entry.
    expect(sortItem('sort-created-at').icon).toBeFalsy()
    expect(sortItem('sort-updated-at').icon).toBeFalsy()
    // No extra "already enabled" wording: the label never changes.
    expect(sortItem('sort-updated-at').label).not.toContain('active')
  })

  it('keeps the same plain labels and no entry icons while creation time is selected', async () => {
    seedTopics()
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortSubmenu()).toHaveLength(2))
    expect(sortItem('sort-updated-at').label).toBe('chat.topics.sort.by_updated_at')
    expect(sortItem('sort-created-at').label).toBe('chat.topics.sort.by_created_at')
    expect(sortItem('sort-updated-at').label).not.toContain('active')
    expect(sortItem('sort-updated-at').icon).toBeFalsy()
    expect(sortItem('sort-created-at').icon).toBeFalsy()
  })

  it('keeps the same plain labels when the continuous policy is on', async () => {
    seedTopics('updated')
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortSubmenu()).toHaveLength(2))
    expect(sortItem('sort-updated-at').label).toBe('chat.topics.sort.by_updated_at')
    expect(sortItem('sort-created-at').label).toBe('chat.topics.sort.by_created_at')
    expect(sortItem('sort-updated-at').label).not.toContain('active')
  })

  it('selects the creation-time entry whenever the list is not kept in update order', async () => {
    // Legacy persisted assistant: no mode field at all.
    seedTopics()
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortSubmenu()).toHaveLength(2))
    expect(testBed.menu.selectable).toBe(true)
    expect(testBed.menu.selectedKeys).toEqual(['sort-created-at'])
    expect(sortParent().className).toBe('topic-sort-submenu')
  })

  it('selects the creation-time entry for an explicitly manual assistant', async () => {
    seedTopics('manual')
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortSubmenu()).toHaveLength(2))
    expect(testBed.menu.selectable).toBe(true)
    expect(testBed.menu.selectedKeys).toEqual(['sort-created-at'])
  })

  it('marks the update-time entry as selected while the policy is on', async () => {
    seedTopics('updated')
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortSubmenu()).toHaveLength(2))
    expect(testBed.menu.selectable).toBe(true)
    expect(testBed.menu.selectedKeys).toEqual(['sort-updated-at'])
  })
})

describe('by creation time', () => {
  it('reorders non-pinned topics newest-created first, pinned first, and exits update ordering', async () => {
    seedTopics('updated')
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortItem('sort-created-at')).toBeTruthy())

    sortItem('sort-created-at').onClick()

    expect(reportedIds()).toEqual(['t-pin', 't-gamma', 't-beta', 't-alpha'])
    expect(testBed.updateAssistant).toHaveBeenCalledTimes(1)
    expect(testBed.updateAssistant).toHaveBeenCalledWith({ topicOrderMode: 'manual' })
    // The discontinued policy drops its runtime keys.
    expect(testBed.resetTopicMessageTimes).toHaveBeenCalledTimes(1)
  })

  it('does not write a mode when the assistant is already manual (legacy persisted state)', async () => {
    seedTopics()
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortItem('sort-created-at')).toBeTruthy())

    sortItem('sort-created-at').onClick()

    expect(reportedIds()).toEqual(['t-pin', 't-gamma', 't-beta', 't-alpha'])
    expect(testBed.updateAssistant).not.toHaveBeenCalled()
  })
})

describe('by update time', () => {
  it('delegates to the authoritative runtime ordering service instead of Redux timestamps', async () => {
    seedTopics()
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortItem('sort-updated-at')).toBeTruthy())

    sortItem('sort-updated-at').onClick()

    // The component never derives an order from topic.updatedAt: the service
    // reads Main's authoritative latest message instant and writes the order.
    expect(testBed.updateTopics).not.toHaveBeenCalled()
    expect(testBed.updateAssistant).not.toHaveBeenCalled()
    expect(testBed.enableUpdateTimeOrder).toHaveBeenCalledWith('a1')
  })

  it('leaves the current order untouched when the activation fails', async () => {
    seedTopics()
    renderTopics()
    openMenu()
    await waitFor(() => expect(sortItem('sort-updated-at')).toBeTruthy())
    testBed.enableUpdateTimeOrder = vi.fn(async () => {
      throw new Error('main read failed')
    })

    await expect(Promise.resolve(sortItem('sort-updated-at').onClick())).resolves.toBeUndefined()

    expect(testBed.updateTopics).not.toHaveBeenCalled()
    expect(testBed.updateAssistant).not.toHaveBeenCalled()
    // The rendered list keeps its current order.
    expect(testBed.list.map((topic: any) => topic.id)).toEqual(['t-pin', 't-alpha', 't-beta', 't-gamma'])
  })
})

describe('filtered drag & drop', () => {
  it('writes the complete list back so searched-away topics are never dropped', async () => {
    seedTopics('updated')
    renderTopics()

    fireEvent.click(screen.getByTestId('topic-search-btn'))
    fireEvent.change(screen.getByTestId('topic-search-input'), { target: { value: 'project' } })
    await waitFor(() => expect(testBed.list.map((topic: any) => topic.id)).toEqual(['t-pin', 't-alpha', 't-beta']))

    // Drag the visible ordinary row t-beta above t-alpha; t-gamma stays hidden.
    testBed.onUpdate([testBed.list[0], testBed.list[2], testBed.list[1]])

    const written = testBed.updateTopics.mock.calls[0][0] as any[]
    expect(written).toHaveLength(testBed.topics.length)
    expect(new Set(written.map((topic) => topic.id))).toEqual(new Set(['t-alpha', 't-beta', 't-gamma', 't-pin']))
    // Visible order applied, hidden topic preserved, pinned still first.
    expect(written.map((topic) => topic.id)).toEqual(['t-pin', 't-beta', 't-alpha', 't-gamma'])
    // A manual drag never disables the continuous update ordering.
    expect(testBed.updateAssistant).not.toHaveBeenCalled()
  })

  it('keeps the whole list on an unfiltered drag too', async () => {
    seedTopics()
    renderTopics()
    await waitFor(() => expect(testBed.list).toHaveLength(4))

    const reordered = [testBed.list[0], testBed.list[2], testBed.list[1], testBed.list[3]]
    testBed.onUpdate(reordered)

    expect(reportedIds()).toEqual(['t-pin', 't-beta', 't-alpha', 't-gamma'])
  })
})
