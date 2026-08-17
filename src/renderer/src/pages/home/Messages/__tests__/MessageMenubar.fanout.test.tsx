/**
 * LOCK-MENUBAR fan-out regression for MessageMenubar.
 *
 * The menubar must subscribe only to its own message's blocks via
 * `selectMessageBlocksByIds` + `shallowEqual`. When an unrelated streaming
 * block commits to the store, the owning menubar re-renders but every other
 * visible menubar must stay untouched.
 *
 * Additionally, when the owning menubar's own block status changes (e.g.
 * translation streaming → success), the menubar must re-render to reflect
 * the updated translation state.
 */
import { configureStore, createSlice } from '@reduxjs/toolkit'
import messageBlocksReducer, { updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import type { Assistant, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'

// ── Mocks (hoisted) ─────────────────────────────────────────────────────────

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/components/Icons', () => ({
  CopyIcon: () => <span>copy-icon</span>,
  DeleteIcon: () => <span>delete-icon</span>,
  EditIcon: () => <span>edit-icon</span>,
  RefreshIcon: () => <span>refresh-icon</span>
}))

vi.mock('@renderer/components/Popups/InspectMessagePopup', () => ({ default: { show: vi.fn() } }))
vi.mock('@renderer/components/Popups/ObsidianExportPopup', () => ({ default: { show: vi.fn() } }))
vi.mock('@renderer/components/Popups/SaveToKnowledgePopup', () => ({ default: { showForMessage: vi.fn() } }))
vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: { show: vi.fn() }
}))

vi.mock('@renderer/context/MessageEditingContext', () => ({
  useMessageEditing: () => ({ startEditing: vi.fn(), stopEditing: vi.fn(), editingMessageId: null })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ updateAssistantSettings: vi.fn() })
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => ({
    deleteMessageWithUndo: vi.fn(),
    resendMessage: vi.fn(),
    regenerateAssistantMessage: vi.fn(),
    getTranslationUpdater: vi.fn(),
    appendAssistantResponse: vi.fn(),
    removeMessageBlock: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useNotesSettings', () => ({
  useNotesSettings: () => ({ notesPath: '' })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useMessageStyle: () => ({ isBubbleStyle: false }),
  useEnableDeveloperMode: () => ({ enableDeveloperMode: false }),
  useSettings: () => ({ confirmDeleteMessage: false, confirmRegenerateMessage: false })
}))

vi.mock('@renderer/hooks/useTemporaryValue', () => ({
  useTemporaryValue: () => [false, vi.fn()]
}))

vi.mock('@renderer/hooks/useTranslate', () => ({
  default: () => ({ translateLanguages: [] })
}))

vi.mock('@renderer/services/AssistantService', () => ({
  DEFAULT_ASSISTANT_SETTINGS: { contextCount: 25, contextWindowAnchor: {} },
  getAssistantSettings: () => ({ contextCount: 25, contextWindowAnchor: {} }),
  getDefaultAssistant: () => ({ id: 'asst-1', settings: { contextCount: 25 } }),
  getDefaultTopic: () => ({ id: 'topic-1', assistantId: 'asst-1' })
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getMessageTitle: vi.fn().mockResolvedValue('title')
}))

vi.mock('@renderer/services/TranslateService', () => ({
  translateText: vi.fn()
}))

// Mock @renderer/store (for direct store.getState() calls in the component)
// but NOT @renderer/store/messageBlock — we need the real reducer and selectors.
vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      messages: { entities: {} },
      messageBlocks: { entities: {}, loadingState: 'idle', error: null }
    }),
    dispatch: vi.fn()
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  selectMessagesForTopic: vi.fn(() => [])
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  insertMessagesThunk: vi.fn(),
  removeBlocksThunk: vi.fn()
}))

vi.mock('@renderer/trace/pages/Component', () => ({
  TraceIcon: () => <span>trace-icon</span>
}))

vi.mock('@renderer/utils', () => ({
  classNames: (...args: any[]) =>
    args
      .flat()
      .filter((v) => typeof v === 'string' || (typeof v === 'object' && v))
      .map((v) =>
        typeof v === 'string'
          ? v
          : Object.keys(v)
              .filter((k) => v[k])
              .join(' ')
      )
      .join(' '),
  captureScrollableAsBlob: vi.fn(),
  captureScrollableAsDataURL: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  abortCompletion: vi.fn()
}))

vi.mock('@renderer/utils/copy', () => ({
  copyMessageAsPlainText: vi.fn()
}))

vi.mock('@renderer/utils/error', () => ({
  isAbortError: () => false
}))

vi.mock('@renderer/utils/export', () => ({
  exportMarkdownToJoplin: vi.fn(),
  exportMarkdownToSiyuan: vi.fn(),
  exportMarkdownToYuque: vi.fn(),
  exportMessageAsMarkdown: vi.fn(),
  exportMessageToNotes: vi.fn(),
  exportMessageToNotion: vi.fn(),
  messageToMarkdown: vi.fn(() => ''),
  messageToPlainText: vi.fn(() => ''),
  topicToMarkdown: vi.fn(() => ''),
  topicToPlainText: vi.fn(() => '')
}))

vi.mock('@renderer/utils/markdown', () => ({
  removeTrailingDoubleSpaces: (s: string) => s
}))

// Mock find.ts to avoid direct store.getState() calls in render-phase memos.
vi.mock('@renderer/utils/messageUtils/find', () => ({
  findMainTextBlocks: () => [],
  findTranslationBlocks: () => [],
  findTranslationBlocksById: () => [],
  getMainTextContent: () => '',
  isAssistantInterruptedThinkingOnlyMessage: () => false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('./messageBranch', () => ({
  emitNewBranch: vi.fn()
}))

vi.mock('./MessageTokens', () => ({ default: () => null }))

// ── Import real MessageMenubar (after mocks) ─────────────────────────────────
const { AnchorGroupProvider } = await import('../anchorGroupContext')
const { default: MessageMenubar } = await import('../MessageMenubar')

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeTranslationBlock = (
  id: string,
  messageId: string,
  content: string,
  status: MessageBlockStatus
): MessageBlock =>
  ({
    id,
    messageId,
    type: MessageBlockType.TRANSLATION,
    status,
    createdAt: new Date().toISOString(),
    content
  }) as unknown as MessageBlock

const makeMainTextBlock = (id: string, messageId: string, content: string): MessageBlock =>
  ({
    id,
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    status: MessageBlockStatus.SUCCESS,
    createdAt: new Date().toISOString(),
    content
  }) as unknown as MessageBlock

const makeAssistantMessage = (id: string, blocks: string[]): Message =>
  ({
    id,
    topicId: 'topic-1',
    role: 'assistant',
    assistantId: 'asst-1',
    askId: `ask-${id}`,
    blocks,
    model: { provider: 'openai', id: 'gpt-4' },
    status: 'success',
    type: 'message'
  }) as unknown as Message

const makeAssistant = (): Assistant =>
  ({
    id: 'asst-1',
    settings: { contextCount: 25, contextWindowAnchor: {} }
  }) as unknown as Assistant

const topic = { id: 'topic-1' } as Topic
const emptyMessageContainerRef = { current: null } as unknown as React.RefObject<HTMLDivElement>

const createStore = () =>
  configureStore({
    reducer: {
      messageBlocks: messageBlocksReducer,
      // Minimal settings slice — the real useSelector reads state.settings.exportMenuOptions.
      settings: createSlice({
        name: 'settings',
        initialState: {
          exportMenuOptions: {
            image: false,
            markdown: false,
            markdown_reason: false,
            notion: false,
            yuque: false,
            joplin: false,
            obsidian: false,
            siyuan: false,
            docx: false,
            plain_text: false,
            notes: false
          }
        },
        reducers: {}
      }).reducer
    }
  })

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MessageMenubar fan-out (block subscription)', () => {
  it('does not re-render an unrelated menubar when a block updates', () => {
    const store = createStore()

    store.dispatch(
      upsertManyBlocks([
        makeMainTextBlock('block-a', 'msg-a', 'content a'),
        makeMainTextBlock('block-b', 'msg-b', 'content b')
      ])
    )

    const commits = { a: 0, b: 0 }
    const onRender: ProfilerOnRenderCallback = (id) => {
      if (id === 'a') commits.a++
      if (id === 'b') commits.b++
    }

    const msgA = makeAssistantMessage('msg-a', ['block-a'])
    const msgB = makeAssistantMessage('msg-b', ['block-b'])
    const assistant = makeAssistant()

    render(
      <Provider store={store}>
        <Profiler id="a" onRender={onRender}>
          <AnchorGroupProvider anchorGroupKey={null}>
            <MessageMenubar
              message={msgA}
              assistant={assistant}
              topic={topic}
              isLastMessage={false}
              isAssistantMessage={true}
              messageContainerRef={emptyMessageContainerRef}
              setModel={vi.fn()}
            />
          </AnchorGroupProvider>
        </Profiler>
        <Profiler id="b" onRender={onRender}>
          <AnchorGroupProvider anchorGroupKey={null}>
            <MessageMenubar
              message={msgB}
              assistant={assistant}
              topic={topic}
              isLastMessage={false}
              isAssistantMessage={true}
              messageContainerRef={emptyMessageContainerRef}
              setModel={vi.fn()}
            />
          </AnchorGroupProvider>
        </Profiler>
      </Provider>
    )

    // Record the mount render counts (React 19 may double-render on mount).
    const mountA = commits.a
    const mountB = commits.b

    // A block update for message A only (the streaming commit path).
    act(() => {
      store.dispatch(updateOneBlock({ id: 'block-a', changes: { content: 'A updated content' } }))
    })

    // Owning menubar A re-renders exactly once more…
    expect(commits.a).toBe(mountA + 1)
    // …but the unrelated menubar B does not re-render at all.
    expect(commits.b).toBe(mountB)
  })

  it('re-renders the owning menubar when its own translation block status changes', () => {
    const store = createStore()

    // Start with a translation block in STREAMING status.
    store.dispatch(
      upsertManyBlocks([makeTranslationBlock('tr-a', 'msg-a', 'translating…', MessageBlockStatus.STREAMING)])
    )

    const commits = { a: 0 }
    const onRender: ProfilerOnRenderCallback = (id) => {
      if (id === 'a') commits.a++
    }

    const msgA = makeAssistantMessage('msg-a', ['tr-a'])
    const assistant = makeAssistant()

    const { container } = render(
      <Provider store={store}>
        <Profiler id="a" onRender={onRender}>
          <AnchorGroupProvider anchorGroupKey={null}>
            <MessageMenubar
              message={msgA}
              assistant={assistant}
              topic={topic}
              isLastMessage={false}
              isAssistantMessage={true}
              messageContainerRef={emptyMessageContainerRef}
              setModel={vi.fn()}
            />
          </AnchorGroupProvider>
        </Profiler>
      </Provider>
    )

    const mountA = commits.a

    // ── Semantic assertion: STREAMING state shows stop/pause control ──
    // When the translation block is STREAMING, isTranslating is true and
    // the translate button renders CirclePause (stop/processing semantics),
    // not Languages (normal translate semantics).
    expect(container.querySelector('.lucide-circle-pause')).toBeTruthy()
    expect(container.querySelector('.lucide-languages')).toBeNull()

    // Translation completes — the block transitions from STREAMING to SUCCESS.
    act(() => {
      store.dispatch(updateOneBlock({ id: 'tr-a', changes: { status: MessageBlockStatus.SUCCESS, content: 'done' } }))
    })

    // ── Semantic assertion: SUCCESS state shows normal translate control ──
    // When the translation block is SUCCESS, isTranslating is false and
    // the translate button renders Languages (normal translate semantics),
    // not CirclePause (stop semantics).
    expect(container.querySelector('.lucide-languages')).toBeTruthy()
    expect(container.querySelector('.lucide-circle-pause')).toBeNull()

    // The owning menubar re-renders (at least once more) because its own
    // translation block changed. React 19 + react-redux 9 may fire a
    // reconcile render, so we assert the lower bound (strictly more) and an
    // upper bound (no runaway fanout).
    expect(commits.a).toBeGreaterThan(mountA)
    expect(commits.a).toBeLessThanOrEqual(mountA + 2)
  })

  it('does not re-render an unrelated menubar when a translation block completes', () => {
    const store = createStore()

    store.dispatch(
      upsertManyBlocks([
        makeTranslationBlock('tr-a', 'msg-a', 'translating…', MessageBlockStatus.STREAMING),
        makeMainTextBlock('block-b', 'msg-b', 'content b')
      ])
    )

    const commits = { a: 0, b: 0 }
    const onRender: ProfilerOnRenderCallback = (id) => {
      if (id === 'a') commits.a++
      if (id === 'b') commits.b++
    }

    const msgA = makeAssistantMessage('msg-a', ['tr-a'])
    const msgB = makeAssistantMessage('msg-b', ['block-b'])
    const assistant = makeAssistant()

    render(
      <Provider store={store}>
        <Profiler id="a" onRender={onRender}>
          <AnchorGroupProvider anchorGroupKey={null}>
            <MessageMenubar
              message={msgA}
              assistant={assistant}
              topic={topic}
              isLastMessage={false}
              isAssistantMessage={true}
              messageContainerRef={emptyMessageContainerRef}
              setModel={vi.fn()}
            />
          </AnchorGroupProvider>
        </Profiler>
        <Profiler id="b" onRender={onRender}>
          <AnchorGroupProvider anchorGroupKey={null}>
            <MessageMenubar
              message={msgB}
              assistant={assistant}
              topic={topic}
              isLastMessage={false}
              isAssistantMessage={true}
              messageContainerRef={emptyMessageContainerRef}
              setModel={vi.fn()}
            />
          </AnchorGroupProvider>
        </Profiler>
      </Provider>
    )

    const mountA = commits.a
    const mountB = commits.b

    // Translation for message A completes.
    act(() => {
      store.dispatch(updateOneBlock({ id: 'tr-a', changes: { status: MessageBlockStatus.SUCCESS, content: 'done' } }))
    })

    // Only menubar A re-renders (at least once more).
    expect(commits.a).toBeGreaterThan(mountA)
    expect(commits.a).toBeLessThanOrEqual(mountA + 2)
    // Menubar B stays untouched.
    expect(commits.b).toBe(mountB)
  })
})
