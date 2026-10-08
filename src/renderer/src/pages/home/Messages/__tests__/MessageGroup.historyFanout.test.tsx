/**
 * MessageGroup history-fanout isolation (real assembly).
 *
 * Covers the core acceptance shape "many rounds, multi-model answer history
 * -> one ordinary single-model send": one history round is 1 user + 3
 * assistant answers sharing one real askId, each SUCCESS with a distinct
 * model, rendered in both fold-selection states (selected first vs selected
 * middle). An ordinary append (new user + stub, zero chips, single provider
 * request at the E2E layer) must only render the new/previous-newest rows:
 * old history groups keep identical canonical entity refs, shift by a pure
 * non-zero viewport-index displacement, and see only the send-shaped
 * `updatedAt` topic bump, so their 3 history answers gain zero renders in
 * both fold states. A text-block membership change, a status/model change,
 * or a fold-selection change must refresh exactly its owner. A hidden
 * (display:none) non-selected member stays mounted and must never serve a
 * stale selection reference.
 *
 * Real MessageGroup + real MessageItem execute (production memo comparators
 * included); only leaf presenters (content/header/menubar/outline/editor)
 * are mocked and their call counts are the render evidence. No production
 * code is touched by this file.
 */
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  editMessage: vi.fn(),
  selectAnswerMessage: vi.fn(),
  selectUseful: vi.fn(),
  scrollIntoView: vi.fn(),
  setTimeoutTimer: vi.fn(),
  useChatContext: vi.fn().mockReturnValue({ isMultiSelectMode: false }),
  useSettings: vi.fn().mockReturnValue({
    fontSize: 14,
    showMessageOutline: false
  }),
  EventEmitter: {
    on: vi.fn(() => vi.fn()),
    off: vi.fn(),
    emit: vi.fn()
  },
  MessageEditingProvider: vi.fn(({ children }: { children: ReactNode }) => <>{children}</>),
  useMessageEditing: vi.fn().mockReturnValue({
    editingMessageId: null,
    startEditing: vi.fn(),
    stopEditing: vi.fn()
  }),
  MessageGroupMenuBar: vi.fn(() => <div className="group-menu-bar">menu</div>),
  HorizontalScrollContainer: vi.fn(({ children }: { children: ReactNode }) => <div>{children}</div>),
  MessageContent: vi.fn((_props: { message: Message }) => <div>content</div>),
  MessageEditor: vi.fn(() => <div>editor</div>),
  MessageErrorBoundary: vi.fn(({ children }: { children: ReactNode }) => <>{children}</>),
  MessageHeader: vi.fn(() => <div className="message-header">header</div>),
  MessageMenubar: vi.fn(() => <div className="message-menubar">menubar</div>),
  MessageOutline: vi.fn(() => null)
}))

const fakeGroupState = vi.hoisted(() => {
  const assistant = (id: string): Record<string, unknown> => ({
    id,
    topicId: 'topic-history',
    role: 'assistant',
    assistantId: 'asst-1',
    askId: 'hist-ask-0',
    blocks: []
  })
  const ids = ['hist-a0', 'hist-a1', 'hist-a2']
  return {
    current: {
      messages: {
        entities: Object.fromEntries(ids.map((id) => [id, assistant(id)])),
        messageIdsByTopic: { 'topic-history': ids },
        mutableMessageIdsByTopic: { 'topic-history': ids },
        mutableRouteByTopic: { 'topic-history': null }
      },
      topicBranch: { activeBranchIdByTopic: {} }
    }
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    })
  }
}))

vi.mock('@renderer/components/HorizontalScrollContainer', () => ({
  default: mocks.HorizontalScrollContainer
}))

vi.mock('@renderer/context/MessageEditingContext', () => ({
  MessageEditingProvider: mocks.MessageEditingProvider,
  useMessageEditing: () => mocks.useMessageEditing()
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useEditMode: () => ({
    isEnabled: false,
    selectedGroupIds: [],
    handleGroupClick: vi.fn()
  }),
  useOptionalEditMode: () => ({
    isEnabled: false,
    selectedGroupIds: [],
    handleGroupClick: vi.fn()
  }),
  EditModeProvider: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@renderer/utils', () => {
  const flattenClassNames = (value: unknown): string[] => {
    if (!value) return []
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(flattenClassNames)
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, boolean>)
        .filter(([, enabled]) => enabled)
        .map(([className]) => className)
    }
    return []
  }

  return {
    classNames: (value: unknown) => flattenClassNames(value).join(' '),
    cn: (...values: unknown[]) => flattenClassNames(values).join(' ')
  }
})

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: null,
    setModel: vi.fn()
  }),
  // Narrow presentation subscription the real MessageItem now uses: the
  // mocked null assistant keeps these tests on the parent-memo boundary
  // (real subscription isolation is proven in useMessageAssistant.test).
  useMessageAssistant: () => ({
    assistant: null,
    model: null,
    setModel: vi.fn(),
    updateAssistantSettings: vi.fn()
  }),
  useAssistantSettingsUpdater: () => vi.fn()
}))

vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => mocks.useChatContext()
}))

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    selectAnswer: mocks.selectAnswerMessage,
    selectUseful: mocks.selectUseful,
    regenerateAssistant: vi.fn(),
    resendUser: vi.fn(),
    editSave: vi.fn(),
    resendWithEdit: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useModel: () => null
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => mocks.useSettings()
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({
    setTimeoutTimer: mocks.setTimeoutTimer
  })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    LOCATE_MESSAGE: 'locate-message',
    EDIT_MESSAGE: 'edit-message'
  },
  EventEmitter: mocks.EventEmitter
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getMessageModelId: () => 'model-id'
}))

vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: () => 'model-uniq-id'
}))

vi.mock('@renderer/services/TokenService', () => ({
  estimateMessageUsage: vi.fn().mockResolvedValue(0)
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (selector: (state: unknown) => unknown) => selector(fakeGroupState.current)
}))

vi.mock('@renderer/store/thunk/messageGroupReorder', () => ({
  reorderMessageGroupThunk: vi.fn()
}))

vi.mock('@renderer/utils/dom', () => ({
  scrollIntoView: mocks.scrollIntoView
}))

vi.mock('@renderer/utils/messageUtils/is', () => ({
  isMessageProcessing: () => false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  }),
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  }
}))

vi.mock('../MessageContent', () => ({
  default: mocks.MessageContent
}))

vi.mock('../MessageEditor', () => ({
  default: mocks.MessageEditor
}))

vi.mock('../MessageErrorBoundary', () => ({
  default: mocks.MessageErrorBoundary
}))

vi.mock('../MessageGroupMenuBar', () => ({
  default: mocks.MessageGroupMenuBar
}))

vi.mock('../MessageHeader', () => ({
  default: mocks.MessageHeader
}))

vi.mock('../MessageMenubar', () => ({
  default: mocks.MessageMenubar
}))

vi.mock('../MessageOutline', () => ({
  default: mocks.MessageOutline
}))

const { default: MessageGroup } = await import('../MessageGroup')

type ProjectedMessage = Message & { index: number }

const HISTORY_MODELS = ['hist-model-a', 'hist-model-b', 'hist-model-c'] as const

const modelOf = (slot: number) => ({
  id: HISTORY_MODELS[slot % HISTORY_MODELS.length],
  provider: 'test-provider',
  name: `History Model ${slot}`
})

/** One history round: 1 user ask + 3 SUCCESS assistant answers, distinct models. */
const createHistoryAnswer = (slot: number, index: number, extra?: Partial<Message>): ProjectedMessage =>
  ({
    id: `hist-a${slot}`,
    askId: 'hist-ask-0',
    role: 'assistant',
    assistantId: 'asst-1',
    topicId: 'topic-history',
    createdAt: '2026-07-19T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    model: modelOf(slot),
    modelId: HISTORY_MODELS[slot % HISTORY_MODELS.length],
    blocks: [`hist-a${slot}-block-0`],
    foldSelected: slot === 0,
    ...extra,
    index
  }) as unknown as ProjectedMessage

const createHistoryTopic = (): Topic =>
  ({
    id: 'topic-history',
    assistantId: 'asst-1',
    name: 'history topic',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    messages: []
  }) as unknown as Topic

const renderCountFor = (id: string): number =>
  mocks.MessageContent.mock.calls.filter((call) => (call[0] as { message: Message }).message.id === id).length

const wrapperClassesFor = (container: HTMLElement, id: string): string =>
  container.querySelector(`#message-${id}`)?.className ?? ''

/**
 * Baseline DOM trait (production, unchanged): the outer MessageWrapper
 * (MessageGroup) and the inner MessageContainer (MessageItem) both carry
 * `id="message-<id>"`, so an `#message-<id>` selector double-hits each
 * answer (3 answers -> 6 hits). Only the inner host carries
 * `data-message-id`, so mounted-answer counts use that attribute and never
 * the `#message-*` id selector. `selected` lives on the outer wrapper, so
 * selection assertions keep reading the wrapper via `wrapperClassesFor`.
 */
const assistantHostCount = (container: HTMLElement): number =>
  container.querySelectorAll('[data-message-id="hist-a0"],[data-message-id="hist-a1"],[data-message-id="hist-a2"]')
    .length

describe('MessageGroup history fanout (real assembly)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ordinary append (same entities, non-zero index shift, pure updatedAt bump) adds zero renders to the 3 history answers', () => {
    // History group sits mid-window: indices 8/7/6, all non-zero, newest is elsewhere.
    const h0 = createHistoryAnswer(0, 8)
    const h1 = createHistoryAnswer(1, 7, { foldSelected: false })
    const h2 = createHistoryAnswer(2, 6, { foldSelected: false })
    const topic = createHistoryTopic()
    const registerMessageElement = vi.fn()
    const onGroupClick = vi.fn()

    const { rerender } = render(
      <MessageGroup
        messages={[h0, h1, h2]}
        topic={topic}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    expect(renderCountFor('hist-a0')).toBe(1)
    expect(renderCountFor('hist-a1')).toBe(1)
    expect(renderCountFor('hist-a2')).toBe(1)

    // Ordinary single-model send appended one user + one stub AFTER this
    // group: same canonical refs, fresh array identity, every member shifted
    // by a pure non-zero displacement (8/7/6 -> 10/9/8), topic replaced with
    // only updatedAt moved (the per-send updateTopicUpdatedAt shape).
    rerender(
      <MessageGroup
        messages={[
          { ...h0, index: 10 },
          { ...h1, index: 9 },
          { ...h2, index: 8 }
        ]}
        topic={{ ...topic, updatedAt: '2026-07-19T00:00:01.000Z' }}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    expect(renderCountFor('hist-a0')).toBe(1)
    expect(renderCountFor('hist-a1')).toBe(1)
    expect(renderCountFor('hist-a2')).toBe(1)
  })

  it('same append isolation holds when the middle answer is fold-selected (folded render state)', () => {
    const h0 = createHistoryAnswer(0, 8, { foldSelected: false })
    const h1 = createHistoryAnswer(1, 7, { foldSelected: true })
    const h2 = createHistoryAnswer(2, 6, { foldSelected: false })
    const topic = createHistoryTopic()
    const registerMessageElement = vi.fn()
    const onGroupClick = vi.fn()

    const { container, rerender } = render(
      <MessageGroup
        messages={[h0, h1, h2]}
        topic={topic}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    // Fold layout: only the selected wrapper carries `selected`; hidden
    // siblings stay mounted (no display:none assertion on layout, only that
    // every inner answer host exists exactly once — counted via
    // `data-message-id` because the duplicate-`id` baseline double-hits
    // `#message-*` selectors).
    expect(wrapperClassesFor(container, 'hist-a1')).toContain('selected')
    expect(wrapperClassesFor(container, 'hist-a0')).not.toContain('selected')
    expect(assistantHostCount(container)).toBe(3)

    rerender(
      <MessageGroup
        messages={[
          { ...h0, index: 10 },
          { ...h1, index: 9 },
          { ...h2, index: 8 }
        ]}
        topic={{ ...topic, updatedAt: '2026-07-19T00:00:01.000Z' }}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    expect(renderCountFor('hist-a0')).toBe(1)
    expect(renderCountFor('hist-a1')).toBe(1)
    expect(renderCountFor('hist-a2')).toBe(1)
    // Selection reference is not stale: the same middle answer stays selected.
    expect(wrapperClassesFor(container, 'hist-a1')).toContain('selected')
    expect(wrapperClassesFor(container, 'hist-a2')).not.toContain('selected')
  })

  it('previous-newest hand-off still refreshes: a 0-boundary member re-renders exactly once', () => {
    // Tail history group that owned the newest marker (indices 2/1/0).
    const h0 = createHistoryAnswer(0, 2)
    const h1 = createHistoryAnswer(1, 1, { foldSelected: false })
    const h2 = createHistoryAnswer(2, 0, { foldSelected: false })
    const topic = createHistoryTopic()

    const { rerender } = render(<MessageGroup messages={[h0, h1, h2]} topic={topic} />)

    // Append hands the newest marker to the new stub: every member leaves 0.
    rerender(
      <MessageGroup
        messages={[
          { ...h0, index: 4 },
          { ...h1, index: 3 },
          { ...h2, index: 2 }
        ]}
        topic={{ ...topic, updatedAt: '2026-07-19T00:00:01.000Z' }}
      />
    )
    expect(renderCountFor('hist-a0')).toBe(1)
    expect(renderCountFor('hist-a1')).toBe(1)
    // Only the member crossing the 0-boundary (isLastMessage hand-off) refreshes.
    expect(renderCountFor('hist-a2')).toBe(2)
  })

  it('updating one history answer text block refreshes only its owner', () => {
    const h0 = createHistoryAnswer(0, 8)
    const h1 = createHistoryAnswer(1, 7, { foldSelected: false })
    const h2 = createHistoryAnswer(2, 6, { foldSelected: false })
    const topic = createHistoryTopic()

    const { rerender } = render(<MessageGroup messages={[h0, h1, h2]} topic={topic} />)

    // Owning-block edit: block id membership changes for h1 only (the React
    // selector owning-block path), entity identity for siblings untouched.
    const h1Edited = { ...h1, blocks: ['hist-a1-block-1'] } as unknown as ProjectedMessage
    rerender(<MessageGroup messages={[h0, h1Edited, h2]} topic={topic} />)
    expect(renderCountFor('hist-a0')).toBe(1)
    expect(renderCountFor('hist-a1')).toBe(2)
    expect(renderCountFor('hist-a2')).toBe(1)
  })

  it('status / model / fold-selection changes refresh exactly their owner', () => {
    const h0 = createHistoryAnswer(0, 8)
    const h1 = createHistoryAnswer(1, 7, { foldSelected: false })
    const h2 = createHistoryAnswer(2, 6, { foldSelected: false })
    const topic = createHistoryTopic()

    const { rerender } = render(<MessageGroup messages={[h0, h1, h2]} topic={topic} />)

    const h1Failed = { ...h1, status: AssistantMessageStatus.ERROR } as unknown as ProjectedMessage
    rerender(<MessageGroup messages={[h0, h1Failed, h2]} topic={topic} />)
    expect(renderCountFor('hist-a0')).toBe(1)
    expect(renderCountFor('hist-a1')).toBe(2)
    expect(renderCountFor('hist-a2')).toBe(1)

    const h2Remodeled = {
      ...h2,
      model: { id: 'hist-model-z', provider: 'test-provider', name: 'History Model Z' },
      modelId: 'hist-model-z'
    } as unknown as ProjectedMessage
    rerender(<MessageGroup messages={[h0, h1Failed, h2Remodeled]} topic={topic} />)
    expect(renderCountFor('hist-a0')).toBe(1)
    expect(renderCountFor('hist-a1')).toBe(2)
    expect(renderCountFor('hist-a2')).toBe(2)

    const h2Selected = { ...h2Remodeled, foldSelected: true } as unknown as ProjectedMessage
    const h0Deselected = { ...h0, foldSelected: false } as unknown as ProjectedMessage
    const beforeH2 = renderCountFor('hist-a2')
    const beforeH0 = renderCountFor('hist-a0')
    rerender(<MessageGroup messages={[h0Deselected, h1Failed, h2Selected]} topic={topic} />)
    // Fold-selection flip refreshes exactly the two members whose selection
    // changed; the untouched middle answer stays put.
    expect(renderCountFor('hist-a0')).toBe(beforeH0 + 1)
    expect(renderCountFor('hist-a1')).toBe(2)
    expect(renderCountFor('hist-a2')).toBe(beforeH2 + 1)
  })
})
