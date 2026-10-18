import type { FileMetadata } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import React, { useCallback, useEffect, useReducer, useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toggleBold } from '../messageEditorFormatting'
import {
  estimateMessageEditorAutoHeight,
  getMessageEditorHeightBounds,
  MESSAGE_EDITOR_HEIGHT_MIN,
  resolveMessageEditorHeight
} from '../messageEditorHeight'

const mocks = vi.hoisted(() => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn(),
  onSave: vi.fn(),
  onResend: vi.fn(),
  sendKeyPressed: vi.fn(() => false),
  captureIntent: vi.fn(() => true),
  settings: { renderInputMessageAsMarkdown: true },
  citationTags: [] as unknown[],
  liveViewEnabled: false,
  liveView: null as {
    setSelection: (anchor: number, head: number) => void
    getSelection: () => { anchor: number; head: number }
    getDoc: () => string
    setScroll: (value: number) => void
    getScroll: () => number
  } | null,
  autoHeightCallback: null as null | ((height: number) => void),
  commandCalls: [] as { cmd: 'undo' | 'redo' }[]
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    deleteFile: mocks.deleteFile,
    deleteFiles: vi.fn().mockResolvedValue(undefined),
    uploadFile: mocks.uploadFile
  }
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    pasteLongTextAsFile: false,
    pasteLongTextThreshold: 1000,
    fontSize: 14,
    sendMessageShortcut: 'Enter',
    enableSpellCheck: false,
    renderInputMessageAsMarkdown: mocks.settings.renderInputMessageAsMarkdown
  })
}))

vi.mock('@renderer/store', () => ({
  useAppSelector: (selector: (state: unknown) => unknown) => selector({}),
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/messageBlock', () => ({
  selectFormattedCitationsByBlockId: () => mocks.citationTags
}))

vi.mock('@renderer/store/newMessage', () => ({
  selectLoadedMessagesForTopic: () => []
}))

vi.mock('@renderer/utils', () => ({
  classNames: (...values: unknown[]) => values.filter(Boolean).join(' ')
}))

vi.mock('@renderer/utils/input', () => ({
  getFilesFromDropEvent: vi.fn(),
  isSendMessageKeyPressed: mocks.sendKeyPressed
}))

vi.mock('@renderer/services/PasteService', () => ({
  default: {
    handlePaste: vi.fn(),
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    setLastFocusedComponent: vi.fn()
  }
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  findAllBlocks: (message: Message) => (message as Message & { initialBlocks?: MessageBlock[] }).initialBlocks ?? [],
  isAssistantInterruptedThinkingOnlyMessage: () => false
}))

vi.mock('@renderer/utils/messageUtils/create', () => ({
  createMainTextBlock: (messageId: string, content: string, overrides: Partial<MessageBlock> = {}) => ({
    id: 'generated-main-text',
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content,
    createdAt: '2026-07-30T00:00:00.000Z',
    status: MessageBlockStatus.SUCCESS,
    ...overrides
  })
}))

vi.mock('@renderer/components/Buttons', () => ({
  ActionIconButton: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

vi.mock('@renderer/components/Tags/CustomTag', () => ({
  default: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('../../Inputbar/AttachmentPreview', () => ({
  FileNameRender: ({ file }: { file: FileMetadata }) => <span>{file.name}</span>,
  getFileIcon: () => null
}))

vi.mock('../../Inputbar/tools/components/AttachmentButton', () => ({
  default: () => <button type="button" aria-label="attach" />
}))

vi.mock('../routeViewportContext', () => ({
  // The editor row consumes the stable command surface (never the versioned
  // projection): the mock mirrors the production hook it is replacing.
  useOptionalRouteViewportCommands: () => ({ controller: {} }),
  captureInteractionIntent: (...args: unknown[]) => {
    void args
    return mocks.captureIntent()
  },
  INTERACTION_REGION_CONTROLS: 'message-controls'
}))

vi.mock('antd', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Modal: ({
    open,
    children,
    transitionName,
    maskTransitionName,
    focusTriggerAfterClose
  }: {
    open?: boolean
    children?: ReactNode
    transitionName?: string
    maskTransitionName?: string
    focusTriggerAfterClose?: boolean
  }) =>
    open ? (
      <div
        data-testid="mock-antd-modal"
        data-transition-name={transitionName ?? 'unset'}
        data-mask-transition-name={maskTransitionName ?? 'unset'}
        data-focus-trigger-after-close={String(focusTriggerAfterClose ?? 'unset')}>
        {children}
      </div>
    ) : null,
  Input: ({ onPressEnter, ...props }: { onPressEnter?: (e: unknown) => void } & Record<string, unknown>) => (
    <input {...props} />
  )
}))

// Direct `@codemirror/commands` mock: `undo`/`redo` delegate to the mock
// engine's own minimal history (per-view done/undone doc stacks seeded from
// the `historySnapshot` prop, serialized back through the REAL
// `captureEditorHistory`). This exercises the production wiring — direct
// command calls, depth-driven disabled states, snapshot capture/restore —
// without claiming real CodeMirror semantics (those are owned by the pure
// `historySession` state test and E2E).
vi.mock('@codemirror/commands', () => ({
  historyField: { __mockHistoryField: true },
  undo: (view: { __mockUndo?: () => boolean }) => {
    mocks.commandCalls.push({ cmd: 'undo' })
    try {
      return view?.__mockUndo?.() ?? false
    } catch {
      return false
    }
  },
  redo: (view: { __mockRedo?: () => boolean }) => {
    mocks.commandCalls.push({ cmd: 'redo' })
    try {
      return view?.__mockRedo?.() ?? false
    } catch {
      return false
    }
  },
  undoDepth: (state: { __mockUndoDepth?: () => number }) => {
    try {
      return state?.__mockUndoDepth?.() ?? 0
    } catch {
      return 0
    }
  },
  redoDepth: (state: { __mockRedoDepth?: () => number }) => {
    try {
      return state?.__mockRedoDepth?.() ?? 0
    } catch {
      return 0
    }
  }
}))
vi.mock('@renderer/components/CodeEditor', () => ({
  // CodeMirror bridge mock: textarea carries input events, .cm-content
  // carries the DOM contract marker. `mocks.liveViewEnabled` switches the
  // mock from the headless fallback (getView null, whole-document parent
  // writes) to a minimal live engine: string doc + selection +
  // editor-local scroll, minimal-change dispatch with onChange propagation,
  // a per-mount done/undone doc history behind the mocked
  // `@codemirror/commands` interface, and `historySnapshot` seeding that
  // mimics the production `initialState` restore on remount. The fake state
  // implements `field`/`toJSON` so the REAL `captureEditorHistory` serializes
  // the mock stacks — the snapshot capture/restore wiring is genuinely
  // exercised; only the history semantics themselves are mock-owned.
  default: function MockCodeEditor({
    ref,
    value,
    onChange,
    onHeightChange,
    onEditorKeyDown,
    onEditorReady,
    onHistoryChange,
    historySnapshot,
    editable
  }: {
    ref?: React.RefObject<{
      save?: () => void
      getContent?: () => string
      focus?: () => void
      getView?: () => unknown
    } | null>
    value?: string
    onChange?: (value: string) => void
    onHeightChange?: (height: number) => void
    onEditorKeyDown?: (event: KeyboardEvent) => boolean
    onEditorReady?: () => void
    onHistoryChange?: (depths: { undo: number; redo: number }) => void
    historySnapshot?: { json?: { history?: { done?: string[]; undone?: string[] } } } | null
    editable?: boolean
  }) {
    // Adaptive-measurement contract: the mock exposes the production
    // onHeightChange subscription so tests drive it explicitly via
    // `mocks.autoHeightCallback`. The expanded modal engine mounts with
    // onHeightChange undefined (production never measures there).
    mocks.autoHeightCallback = onHeightChange ?? null
    const initial = value ?? ''
    const docRef = useRef(initial)
    const selRef = useRef({ anchor: initial.length, head: initial.length })
    const scrollRef = useRef(0)
    const doneRef = useRef<string[]>([])
    const undoneRef = useRef<string[]>([])
    const [, force] = useReducer((count: number) => count + 1, 0)

    // Session restore on (re)mount: seed the mock stacks from the snapshot
    // the production code captured from the previous engine, exactly like the
    // production `initialState` restore seeds the new engine's history.
    const seededRef = useRef(false)
    if (!seededRef.current) {
      seededRef.current = true
      const history = historySnapshot?.json?.history
      if (history) {
        doneRef.current = [...(history.done ?? [])]
        undoneRef.current = [...(history.undone ?? [])]
      }
    }

    const reportDepths = useCallback(() => {
      try {
        onHistoryChange?.({ undo: doneRef.current.length, redo: undoneRef.current.length })
      } catch {}
    }, [onHistoryChange])

    // External sync mirrors the real engine diff sync: the mock doc follows
    // parent-driven changes, while engine-owned dispatches flow out through
    // onChange exactly once.
    const lastValueRef = useRef(value)
    if (lastValueRef.current !== value) {
      lastValueRef.current = value
      if ((value ?? '') !== docRef.current) {
        docRef.current = value ?? ''
      }
    }

    const applyUndo = useCallback(() => {
      if (doneRef.current.length === 0) return false
      undoneRef.current.push(docRef.current)
      docRef.current = doneRef.current.pop() as string
      try {
        onChange?.(docRef.current)
      } catch {}
      reportDepths()
      force()
      return true
    }, [onChange, reportDepths])

    const applyRedo = useCallback(() => {
      if (undoneRef.current.length === 0) return false
      doneRef.current.push(docRef.current)
      docRef.current = undoneRef.current.pop() as string
      try {
        onChange?.(docRef.current)
      } catch {}
      reportDepths()
      force()
      return true
    }, [onChange, reportDepths])

    const getFakeView = useCallback(() => {
      if (!mocks.liveViewEnabled) return null
      return {
        state: {
          get doc() {
            return { length: docRef.current.length, toString: () => docRef.current }
          },
          get selection() {
            const { anchor, head } = selRef.current
            return {
              main: { anchor, head, from: Math.min(anchor, head), to: Math.max(anchor, head) }
            }
          },
          // Satisfies the REAL captureEditorHistory: the mock history field
          // is present, and toJSON serializes the mock stacks.
          field: (fieldValue: unknown) =>
            (fieldValue as { __mockHistoryField?: boolean } | null)?.__mockHistoryField
              ? { __mockStacks: true }
              : undefined,
          toJSON: () => ({
            doc: docRef.current,
            selection: { anchor: selRef.current.anchor, head: selRef.current.head },
            history: { done: [...doneRef.current], undone: [...undoneRef.current] }
          }),
          __mockUndoDepth: () => doneRef.current.length,
          __mockRedoDepth: () => undoneRef.current.length
        },
        __mockUndo: applyUndo,
        __mockRedo: applyRedo,
        scrollDOM: {
          get scrollTop() {
            return scrollRef.current
          },
          set scrollTop(next: number) {
            scrollRef.current = next
          },
          scrollHeight: 1000,
          clientHeight: 200,
          getBoundingClientRect: () => ({ top: 0, bottom: 200, height: 200, left: 0, right: 0, width: 0 })
        },
        coordsAtPos: () => null,
        dispatch: (transaction: {
          changes?: { from: number; to: number; insert?: string }[] | { from: number; to: number; insert?: string }
          selection?: { anchor: number; head: number }
        }) => {
          if (transaction.changes) {
            const list = Array.isArray(transaction.changes) ? transaction.changes : [transaction.changes]
            const ordered = [...list].sort((a, b) => b.from - a.from)
            const prevDoc = docRef.current
            let doc = prevDoc
            for (const change of ordered) {
              doc = doc.slice(0, change.from) + (change.insert ?? '') + doc.slice(change.to)
            }
            doneRef.current.push(prevDoc)
            undoneRef.current = []
            docRef.current = doc
            try {
              onChange?.(doc)
            } catch {}
            reportDepths()
          }
          if (transaction.selection) {
            selRef.current = { anchor: transaction.selection.anchor, head: transaction.selection.head }
          }
          force()
        }
      }
    }, [applyRedo, applyUndo, onChange, reportDepths])

    useEffect(() => {
      if (ref) {
        ref.current = {
          save: () => {},
          getContent: () => (mocks.liveViewEnabled ? docRef.current : (value ?? '')),
          focus: () => {},
          getView: getFakeView
        }
      }
    })

    useEffect(() => {
      if (mocks.liveViewEnabled) {
        mocks.liveView = {
          setSelection: (anchor: number, head: number) => {
            selRef.current = { anchor, head }
            force()
          },
          getSelection: () => ({ ...selRef.current }),
          getDoc: () => docRef.current,
          setScroll: (next: number) => {
            scrollRef.current = next
          },
          getScroll: () => scrollRef.current
        }
      } else {
        mocks.liveView = null
      }
    })

    useEffect(() => {
      // Mount report mirrors the production onCreateEditor depth sync, so
      // restored sessions re-enable the toolbar on remount.
      reportDepths()
      onEditorReady?.()
    }, [onEditorReady, reportDepths])

    return (
      <div>
        <div className="cm-content" contentEditable={true} />
        {mocks.liveViewEnabled && <div data-testid="mock-cm-doc">{docRef.current}</div>}
        <textarea
          aria-label="message-editor-source"
          value={value ?? ''}
          disabled={editable === false}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={(e) => {
            if (onEditorKeyDown?.(e.nativeEvent as unknown as KeyboardEvent)) e.preventDefault()
          }}
        />
      </div>
    )
  }
}))

vi.mock('../../Markdown/Markdown', () => ({
  default: function MockMarkdown({
    block,
    postProcess
  }: {
    block: { content: string }
    postProcess?: (text: string) => string
  }) {
    const content = postProcess ? postProcess(block.content) : block.content
    return (
      <div className="markdown" data-testid="mock-markdown" data-has-postprocess={postProcess ? 'true' : 'false'}>
        {content}
      </div>
    )
  }
}))

vi.mock('@renderer/config/models', () => ({
  isGenerateImageModel: () => false,
  isVisionModel: () => false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const { default: MessageEditor } = await import('../MessageEditor')

const RAW_MARKDOWN = [
  '# Long draft',
  '',
  'Lead with a [link](https://example.com/x) and raw <span>syntax</span>.',
  '',
  'Unclosed <div> stays literal, trailing spaces: x  ',
  'next $a^2 + b^2 = c^2$ end.',
  '',
  '```ts',
  '// code-probe',
  '```'
].join('\n')

const mainTextBlock: MessageBlock = {
  id: 'main-text',
  messageId: 'message-1',
  type: MessageBlockType.MAIN_TEXT,
  content: RAW_MARKDOWN,
  createdAt: '2026-07-30T00:00:00.000Z',
  status: MessageBlockStatus.SUCCESS
}

const makeMessage = (role: 'user' | 'assistant' = 'user', blocks?: MessageBlock[]) =>
  ({
    id: 'message-1',
    topicId: 'topic-1',
    role,
    assistantId: 'assistant-1',
    blocks: [(blocks ?? [{ ...mainTextBlock }])[0].id],
    initialBlocks: blocks ?? [{ ...mainTextBlock }],
    status: 'success',
    createdAt: '2026-07-30T00:00:00.000Z'
  }) as unknown as Message

const renderEditor = (role: 'user' | 'assistant' = 'user', onCancel = vi.fn()) =>
  render(
    <MessageEditor
      message={makeMessage(role)}
      topicId="topic-1"
      onSave={mocks.onSave}
      onResend={mocks.onResend}
      onCancel={onCancel}
    />
  )

const renderEditorWithContent = (content: string, role: 'user' | 'assistant' = 'user') => {
  const block: MessageBlock = { ...mainTextBlock, content }
  return render(
    <MessageEditor
      message={makeMessage(role, [block])}
      topicId="topic-1"
      onSave={mocks.onSave}
      onResend={mocks.onResend}
      onCancel={vi.fn()}
    />
  )
}

/** Drive the production adaptive-measurement subscription like the live engine would. */
const fireAutoHeight = (height: number) => {
  act(() => {
    mocks.autoHeightCallback?.(height)
  })
}

/** Expected first-paint adaptive surface height for the given draft. */
const expectedAdaptive = (content: string) => `${estimateMessageEditorAutoHeight(content, window.innerHeight)}px`

beforeEach(() => {
  mocks.deleteFile.mockClear()
  mocks.uploadFile.mockReset().mockResolvedValue({ id: 'uploaded-file' })
  mocks.onSave.mockReset().mockResolvedValue(undefined)
  mocks.onResend.mockReset().mockResolvedValue(undefined)
  mocks.sendKeyPressed.mockReset().mockReturnValue(false)
  mocks.captureIntent.mockClear()
  mocks.settings.renderInputMessageAsMarkdown = true
  mocks.citationTags = []
  mocks.liveViewEnabled = false
  mocks.liveView = null
  mocks.commandCalls = []
  mocks.autoHeightCallback = null
  localStorage.clear()
})

describe('MessageEditor CodeMirror upgrade', () => {
  it('renders the source surface with the exact raw content and stable controls', () => {
    renderEditor()
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(RAW_MARKDOWN)
    expect(document.querySelector('.message-editor-area .editing-message .cm-content')).not.toBeNull()
    const modeBtn = screen.getByTestId('message-editor-mode-btn')
    expect(modeBtn).toHaveAttribute('data-mode', 'source')
    expect(modeBtn).toHaveAttribute('aria-pressed', 'false')
    expect(modeBtn).toHaveAttribute('aria-label', 'message.edit.show_preview')
    expect(screen.queryByTestId('message-editor-source-btn')).toBeNull()
    expect(screen.queryByTestId('message-editor-preview-btn')).toBeNull()
    expect(screen.getByTestId('message-editor-resize-handle')).toBeInTheDocument()
    expect(screen.getByTestId('message-editor-history-separator')).toBeInTheDocument()
    expect(screen.getByTestId('message-editor-expand-btn')).toBeInTheDocument()
    expect(screen.getByTestId('message-editor-resize-surface')).toBeInTheDocument()
    expect(screen.getByTestId('message-editor-bold-btn')).toBeInTheDocument()
    expect(screen.getByTestId('message-editor-link-btn')).toBeInTheDocument()
    expect(screen.getByTestId('message-editor-undo-btn')).toBeInTheDocument()
    expect(screen.getByTestId('message-editor-redo-btn')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeInTheDocument()
  })

  it('save passes the exact raw Markdown without rewrites', async () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText('message-editor-source'), { target: { value: `${RAW_MARKDOWN}\nprobe` } })
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledTimes(1))
    const blocks = mocks.onSave.mock.calls[0][0] as MessageBlock[]
    const main = blocks.find((b) => b.type === MessageBlockType.MAIN_TEXT)
    expect(main?.content).toBe(`${RAW_MARKDOWN}\nprobe`)
  })

  it('bold toolbar formats the draft without a competing history write when no live engine owns it', async () => {
    renderEditor()
    await userEvent.click(screen.getByTestId('message-editor-bold-btn'))
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(`**${RAW_MARKDOWN}**`)
    // No live engine: the undo button stays disabled on the empty depth
    // report and invokes no native command — the draft is untouched by the
    // button itself.
    expect(screen.getByTestId('message-editor-undo-btn')).toBeDisabled()
    await userEvent.click(screen.getByTestId('message-editor-undo-btn'))
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(`**${RAW_MARKDOWN}**`)
    expect(mocks.commandCalls).toEqual([])
  })

  it('mode toggle renders Markdown with citation post-processing and returns with the draft intact', async () => {
    renderEditor()
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    const modeBtn = screen.getByTestId('message-editor-mode-btn')
    expect(modeBtn).toHaveAttribute('data-mode', 'preview')
    expect(modeBtn).toHaveAttribute('aria-pressed', 'true')
    const preview = screen.getByTestId('mock-markdown')
    expect(preview).toHaveAttribute('data-has-postprocess', 'true')
    expect(preview.textContent).toContain('# Long draft')
    expect(document.querySelector('.message-editor-area .editing-message .cm-content')).toBeNull()
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(screen.getByTestId('message-editor-mode-btn')).toHaveAttribute('data-mode', 'source')
    expect(document.querySelector('.message-editor-area .editing-message .cm-content')).not.toBeNull()
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(RAW_MARKDOWN)
  })

  it('user preview honors the plain-text display setting instead of the Markdown renderer', async () => {
    mocks.settings.renderInputMessageAsMarkdown = false
    renderEditor('user')
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(screen.queryByTestId('mock-markdown')).toBeNull()
    const plain = document.querySelector('.message-editor-area p.markdown')
    expect(plain).not.toBeNull()
    expect(plain?.textContent).toBe(RAW_MARKDOWN)
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(RAW_MARKDOWN)
  })

  it('assistant preview keeps the Markdown renderer when the plain-text setting is off', async () => {
    mocks.settings.renderInputMessageAsMarkdown = false
    renderEditor('assistant')
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(screen.getByTestId('mock-markdown')).toBeInTheDocument()
    expect(screen.getByTestId('mock-markdown').textContent).toContain('# Long draft')
  })

  it('assistant preview applies the same citation handling as the saved message view', async () => {
    mocks.citationTags = [{ number: 1, url: 'https://example.com', title: 'Example', content: 'cite content' }]
    const cited: MessageBlock = {
      ...mainTextBlock,
      content: 'Answer with citation [1] here',
      citationReferences: [{ citationBlockId: 'cite-1' }]
    } as MessageBlock
    render(
      <MessageEditor
        message={makeMessage('assistant', [cited])}
        topicId="topic-1"
        onSave={mocks.onSave}
        onResend={mocks.onResend}
        onCancel={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    const preview = screen.getByTestId('mock-markdown')
    expect(preview).toHaveAttribute('data-has-postprocess', 'true')
    // Citation post-processing rewrites the [1] marker (same utils as MainTextBlock).
    expect(preview.textContent).not.toBe('Answer with citation [1] here')
    expect(preview.textContent).toMatch(/cite/i)
    // Read-only rendering: the draft itself stays unnormalized.
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(screen.getByLabelText('message-editor-source')).toHaveValue('Answer with citation [1] here')
  })

  it('expansion opens the modal and Escape closes it retaining the draft', async () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText('message-editor-source'), { target: { value: 'expanded draft' } })
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    const modal = screen.getByTestId('message-editor-expanded')
    expect(modal).toBeInTheDocument()
    expect(modal.textContent).toContain('expanded draft')
    expect(modal.querySelector('.message-editor-save-btn')).not.toBeNull()

    fireEvent.keyDown(screen.getByLabelText('message-editor-source'), { key: 'Escape' })
    expect(screen.queryByTestId('message-editor-expanded')).toBeNull()
    expect(screen.getByLabelText('message-editor-source')).toHaveValue('expanded draft')
  })

  it('expanded save persists the shared draft', async () => {
    renderEditor()
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    const modal = screen.getByTestId('message-editor-expanded')
    const save = modal.querySelector('.message-editor-save-btn') as HTMLElement
    await userEvent.click(save)
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledTimes(1))
    const blocks = mocks.onSave.mock.calls[0][0] as MessageBlock[]
    expect(blocks.find((b) => b.type === MessageBlockType.MAIN_TEXT)?.content).toBe(RAW_MARKDOWN)
  })

  it('user Escape cancels while assistant Escape is a no-op', async () => {
    const onCancel = vi.fn()
    const userView = renderEditor('user', onCancel)
    fireEvent.keyDown(screen.getByLabelText('message-editor-source'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    userView.unmount()

    const assistantCancel = vi.fn()
    renderEditor('assistant', assistantCancel)
    fireEvent.keyDown(screen.getByLabelText('message-editor-source'), { key: 'Escape' })
    expect(assistantCancel).not.toHaveBeenCalled()
    expect(screen.getByLabelText('message-editor-source')).toBeInTheDocument()
  })

  it('user Enter resends on shortcut match but never during composition', async () => {
    mocks.sendKeyPressed.mockReturnValue(true)
    renderEditor()
    const source = screen.getByLabelText('message-editor-source')
    fireEvent.keyDown(source, { key: 'Enter' })
    await waitFor(() => expect(mocks.onResend).toHaveBeenCalledTimes(1))

    const composing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(composing, 'isComposing', { value: true })
    source.dispatchEvent(composing)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.onResend).toHaveBeenCalledTimes(1)
  })

  it('find toggle arms the shared viewport hold once, never per keystroke', async () => {
    renderEditor()
    expect(mocks.captureIntent).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('message-editor-find-btn'))
    expect(mocks.captureIntent).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('message.edit.find_placeholder'), { target: { value: 'draft' } })
    expect(screen.getByText(/message.edit.find_count/)).toBeInTheDocument()
    expect(mocks.captureIntent).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByTestId('message-editor-find-btn'))
    expect(mocks.captureIntent).toHaveBeenCalledTimes(2)
  })

  it('find and replace-all updates the draft with match counts', async () => {
    renderEditor()
    await userEvent.click(screen.getByTestId('message-editor-find-btn'))
    fireEvent.change(screen.getByLabelText('message.edit.find_placeholder'), { target: { value: 'draft' } })
    expect(screen.getByText(/message.edit.find_count/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('message.edit.replace_placeholder'), { target: { value: 'DRAFT' } })
    await userEvent.click(screen.getByRole('button', { name: 'message.edit.replace_all' }))
    const value = (screen.getByLabelText('message-editor-source') as HTMLTextAreaElement).value
    expect(value).not.toContain('draft')
    expect(value).toContain('DRAFT')
  })

  it('toolbar drops translation: no translate control, link between bold and find with undo/redo left near search and expand alone far-right', () => {
    renderEditor()
    expect(document.querySelector('.message-editor-area [aria-label="mock-translate"]')).toBeNull()
    const toolsScroll = screen.getByTestId('message-editor-tools-scroll')
    // Markup grouping (never forced positioning): undo/redo live inside the
    // left scrollable tools group alongside search; the end group owns ONLY
    // the expand control.
    expect(toolsScroll.contains(screen.getByTestId('message-editor-bold-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-link-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-find-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-history-separator'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-undo-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-redo-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-expand-btn'))).toBe(false)
    const expandBtn = screen.getByTestId('message-editor-expand-btn')
    // Tooltip mock renders a fragment, so the button's direct parent is the
    // end group itself (never the shared toolbar root).
    const endGroup = expandBtn.parentElement ?? null
    expect(endGroup).not.toBeNull()
    expect(endGroup?.querySelector('[data-testid="message-editor-undo-btn"]')).toBeNull()
    expect(endGroup?.querySelector('[data-testid="message-editor-redo-btn"]')).toBeNull()
    expect(endGroup?.querySelector('[data-testid="message-editor-expand-btn"]')).not.toBeNull()
    const ordered = [
      screen.getByTestId('message-editor-mode-btn'),
      screen.getByTestId('message-editor-bold-btn'),
      screen.getByTestId('message-editor-link-btn'),
      screen.getByTestId('message-editor-find-btn'),
      screen.getByTestId('message-editor-history-separator'),
      screen.getByTestId('message-editor-undo-btn'),
      screen.getByTestId('message-editor-redo-btn'),
      screen.getByTestId('message-editor-expand-btn')
    ]
    for (let i = 0; i + 1 < ordered.length; i++) {
      expect(ordered[i].compareDocumentPosition(ordered[i + 1])).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    }
    // Disabled history buttons keep native disabled semantics on the empty stack.
    expect(screen.getByTestId('message-editor-undo-btn')).toBeDisabled()
    expect(screen.getByTestId('message-editor-redo-btn')).toBeDisabled()
  })

  it('edited draft survives a preview/source mode session with a fresh fallback history', async () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText('message-editor-source'), { target: { value: 'edited draft text' } })
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(document.querySelector('.message-editor-area .editing-message .cm-content')).toBeNull()
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    await waitFor(() => expect(screen.getByLabelText('message-editor-source')).toHaveValue('edited draft text'))
    // Headless fallback owns no engine history: no stale session is offered.
    expect(screen.getByTestId('message-editor-undo-btn')).toBeDisabled()
  })

  it('cancel from the action bar does not write the staged draft', async () => {
    const onCancel = vi.fn()
    renderEditor('assistant', onCancel)
    fireEvent.change(screen.getByLabelText('message-editor-source'), { target: { value: 'staged probe' } })
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(mocks.onSave).not.toHaveBeenCalled()
  })
})

describe('MessageEditor native engine transactions (live view)', () => {
  beforeEach(() => {
    mocks.liveViewEnabled = true
  })

  it('toolbar bold dispatches a selection-aware native transaction with one exact parent write', async () => {
    renderEditor()
    expect(mocks.liveView).not.toBeNull()
    act(() => {
      mocks.liveView?.setSelection(0, 4)
    })
    await userEvent.click(screen.getByTestId('message-editor-bold-btn'))
    const expected = toggleBold(RAW_MARKDOWN, { from: 0, to: 4 })
    // Engine doc and parent draft agree on the exact formatted string.
    expect(mocks.liveView?.getDoc()).toBe(expected.content)
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(expected.content)
    expect(screen.getByTestId('mock-cm-doc').textContent).toBe(expected.content)
    // Selection follows the format result inside the live engine.
    expect(mocks.liveView?.getSelection()).toEqual({ anchor: expected.anchor, head: expected.head })
  })

  it('toolbar undo/redo invoke the direct native commands and share one history with matching disabled states', async () => {
    renderEditor()
    // Fresh session: nothing to undo or redo yet.
    expect(screen.getByTestId('message-editor-undo-btn')).toBeDisabled()
    expect(screen.getByTestId('message-editor-redo-btn')).toBeDisabled()
    act(() => {
      mocks.liveView?.setSelection(0, 4)
    })
    await userEvent.click(screen.getByTestId('message-editor-bold-btn'))
    const formatted = (screen.getByLabelText('message-editor-source') as HTMLTextAreaElement).value
    expect(formatted).not.toBe(RAW_MARKDOWN)
    // The native transaction enabled undo but not redo.
    expect(screen.getByTestId('message-editor-undo-btn')).toBeEnabled()
    expect(screen.getByTestId('message-editor-redo-btn')).toBeDisabled()

    // Toolbar undo invokes the direct native command (no synthetic keys) and
    // reverts the format through the shared mock history.
    await userEvent.click(screen.getByTestId('message-editor-undo-btn'))
    expect(mocks.commandCalls).toEqual([{ cmd: 'undo' }])
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(RAW_MARKDOWN)
    expect(screen.getByTestId('message-editor-undo-btn')).toBeDisabled()
    expect(screen.getByTestId('message-editor-redo-btn')).toBeEnabled()

    await userEvent.click(screen.getByTestId('message-editor-redo-btn'))
    expect(mocks.commandCalls).toEqual([{ cmd: 'undo' }, { cmd: 'redo' }])
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(formatted)
    expect(screen.getByTestId('message-editor-undo-btn')).toBeEnabled()
    expect(screen.getByTestId('message-editor-redo-btn')).toBeDisabled()
  })

  it('mode toggle snapshots and restores the live cursor plus editor-local scroll', async () => {
    renderEditor()
    act(() => {
      mocks.liveView?.setSelection(3, 9)
      mocks.liveView?.setScroll(42)
    })
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(document.querySelector('.message-editor-area .editing-message .cm-content')).toBeNull()
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    await waitFor(() => expect(mocks.liveView?.getSelection()).toEqual({ anchor: 3, head: 9 }))
    expect(mocks.liveView?.getScroll()).toBe(42)
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(RAW_MARKDOWN)
  })

  it('native history session survives preview/source and expand/collapse remounts', async () => {
    // Mock-world mirror of the E2E native-history flow: selection bold, then
    // preview->source and expand->collapse, then toolbar undo/redo through
    // the restored session. The mock engine owns the history semantics, but
    // the snapshot capture/restore wiring (real helper) and the direct
    // command path are genuinely exercised.
    renderEditor()
    act(() => {
      mocks.liveView?.setSelection(0, 4)
    })
    await userEvent.click(screen.getByTestId('message-editor-bold-btn'))
    const expected = toggleBold(RAW_MARKDOWN, { from: 0, to: 4 })
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(expected.content)
    expect(screen.getByTestId('message-editor-undo-btn')).toBeEnabled()

    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(document.querySelector('.message-editor-area .editing-message .cm-content')).toBeNull()
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    await waitFor(() => expect(mocks.liveView?.getDoc()).toBe(expected.content))
    // History survived preview->source: undo is still offered.
    expect(screen.getByTestId('message-editor-undo-btn')).toBeEnabled()

    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    const modal = screen.getByTestId('message-editor-expanded')
    expect(modal).toBeInTheDocument()
    expect(modal.textContent).toContain(expected.content.slice(0, 24))
    await userEvent.click(screen.getByTestId('message-editor-collapse-btn'))
    await waitFor(() => expect(screen.queryByTestId('message-editor-expanded')).toBeNull())
    await waitFor(() => expect(mocks.liveView?.getDoc()).toBe(expected.content))
    // History survived expand->collapse: undo is still offered.
    expect(screen.getByTestId('message-editor-undo-btn')).toBeEnabled()

    await userEvent.click(screen.getByTestId('message-editor-undo-btn'))
    expect(mocks.commandCalls).toEqual([{ cmd: 'undo' }])
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(RAW_MARKDOWN)
    expect(screen.getByTestId('message-editor-redo-btn')).toBeEnabled()

    await userEvent.click(screen.getByTestId('message-editor-redo-btn'))
    expect(mocks.commandCalls).toEqual([{ cmd: 'undo' }, { cmd: 'redo' }])
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(expected.content)
  })

  it('edited draft owns the remount when the parent changed with no engine mounted', async () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText('message-editor-source'), { target: { value: 'edited while testing' } })
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    // The edited text — not a stale snapshot doc — owns the remount.
    await waitFor(() => expect(screen.getByLabelText('message-editor-source')).toHaveValue('edited while testing'))
  })
})

describe('MessageEditor outer grip, disabled treatment and switch wording contracts', () => {
  const readSource = async (): Promise<string> => {
    const fs = await import('node:fs')
    return fs.readFileSync('src/renderer/src/pages/home/Messages/MessageEditor.tsx', 'utf-8')
  }

  const styledBlock = (source: string, anchor: string): string => {
    const at = source.indexOf(anchor)
    expect(at, `${anchor} must exist in MessageEditor.tsx`).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('\n`\n', at)
    expect(end, `${anchor} styled block must terminate`).toBeGreaterThan(at)
    return source.slice(at, end)
  }

  const readLocaleEdit = async (name: string): Promise<Record<string, string>> => {
    const fs = await import('node:fs')
    const raw = fs.readFileSync(`src/renderer/src/i18n/locales/${name}.json`, 'utf-8')
    const parsed = JSON.parse(raw) as { message: { edit: Record<string, string> } }
    return parsed.message.edit
  }

  it('resize grip is an absolute out-of-flow top-edge hit target (no inner row)', async () => {
    // jsdom has no flex geometry: assert the CSS contract the E2E outer-grip
    // geometry owns (absolute, full-width, top-aligned, row-resize).
    const css = styledBlock(await readSource(), 'const ResizeHandle = styled.div`')
    expect(css).toMatch(/position:\s*absolute/)
    expect(css).toMatch(/top:\s*0/)
    expect(css).toMatch(/left:\s*0/)
    expect(css).toMatch(/right:\s*0/)
    expect(css).toMatch(/cursor:\s*row-resize/)
    // Out of flow means no reserved in-flow flex row.
    expect(css).not.toMatch(/flex-shrink:\s*0/)
  })

  it('grip renders inside the bordered outer frame ahead of the resize surface', () => {
    renderEditor()
    const container = screen.getByTestId('message-editor-container')
    const handle = screen.getByTestId('message-editor-resize-handle')
    const surface = screen.getByTestId('message-editor-resize-surface')
    expect(container.contains(handle)).toBe(true)
    expect(container.contains(surface)).toBe(true)
    expect(handle.compareDocumentPosition(surface)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('disabled toolbar buttons dim with an explicit opacity baseline and inheriting icon', async () => {
    const css = styledBlock(await readSource(), 'const EditorToolbar = styled.div`')
    expect(css).toMatch(/button:disabled/)
    expect(css).toMatch(/opacity:\s*0\.4/)
    expect(css).toMatch(/color:\s*inherit/)
  })

  it('narrow toolbar keeps expand pinned while the format group absorbs overflow', async () => {
    // No whole-toolbar scroll, no media query, no container framework: the
    // outer toolbar is width-bounded with hidden overflow, the formatting
    // tools group is the only horizontally scrollable segment, and the end
    // group never shrinks (margin-left auto keeps it far-right).
    const source = await readSource()
    const toolbar = styledBlock(source, 'const EditorToolbar = styled.div`')
    expect(toolbar).toMatch(/width:\s*100%/)
    expect(toolbar).toMatch(/min-width:\s*0/)
    expect(toolbar).toMatch(/overflow:\s*hidden/)
    expect(toolbar).not.toMatch(/overflow-x:\s*auto/)
    expect(toolbar).not.toMatch(/@media/)
    const tools = styledBlock(source, 'const ToolbarToolsGroup = styled(ToolbarGroup)`')
    expect(tools).toMatch(/flex:\s*1 1 auto/)
    expect(tools).toMatch(/min-width:\s*0/)
    expect(tools).toMatch(/overflow-x:\s*auto/)
    const end = styledBlock(source, 'const ToolbarEndGroup = styled.div`')
    expect(end).toMatch(/flex-shrink:\s*0/)
    expect(end).toMatch(/margin-left:\s*auto/)
  })

  it('toolbar order keeps find after link with undo/redo left in the tools group and expand last', () => {
    renderEditor()
    const toolsScroll = screen.getByTestId('message-editor-tools-scroll')
    expect(toolsScroll).toBeInTheDocument()
    // Formatting buttons (bold/link/find) plus native history (undo/redo)
    // live inside the scrollable tools group; mode/expand stay outside it
    // and pinned. The right end group owns ONLY expand.
    expect(toolsScroll.contains(screen.getByTestId('message-editor-bold-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-link-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-find-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-history-separator'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-undo-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-redo-btn'))).toBe(true)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-expand-btn'))).toBe(false)
    expect(toolsScroll.contains(screen.getByTestId('message-editor-mode-btn'))).toBe(false)
    const expandBtn = screen.getByTestId('message-editor-expand-btn')
    // Tooltip mock renders a fragment, so the button's direct parent is the
    // end group itself (never the shared toolbar root).
    const endGroup = expandBtn.parentElement ?? null
    expect(endGroup?.querySelector('[data-testid="message-editor-undo-btn"]')).toBeNull()
    expect(endGroup?.querySelector('[data-testid="message-editor-redo-btn"]')).toBeNull()
    expect(endGroup?.querySelector('[data-testid="message-editor-expand-btn"]')).not.toBeNull()
    const ordered = [
      screen.getByTestId('message-editor-mode-btn'),
      screen.getByTestId('message-editor-bold-btn'),
      screen.getByTestId('message-editor-link-btn'),
      screen.getByTestId('message-editor-find-btn'),
      screen.getByTestId('message-editor-history-separator'),
      screen.getByTestId('message-editor-undo-btn'),
      screen.getByTestId('message-editor-redo-btn'),
      screen.getByTestId('message-editor-expand-btn')
    ]
    for (let i = 0; i + 1 < ordered.length; i++) {
      expect(ordered[i].compareDocumentPosition(ordered[i + 1])).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    }
  })

  it('mode switch label uses edit wording with no source naming (locale values)', async () => {
    const en = await readLocaleEdit('en-us')
    const zhCn = await readLocaleEdit('zh-cn')
    const zhTw = await readLocaleEdit('zh-tw')
    expect(en['show_source']).toBe('Show edit')
    expect(zhCn['show_source']).toBe('切换到编辑')
    expect(zhTw['show_source']).toBe('切換到編輯')
    expect(en['show_source']).not.toMatch(/source/i)
    expect(zhCn['show_source']).not.toContain('源码')
    expect(zhTw['show_source']).not.toContain('原始碼')
  })

  it('inline and expanded editing wrappers bound the single CodeMirror scroll plane', async () => {
    // The indefinite-% regression: the @uiw outer node must be flex-sized in
    // both surfaces so .cm-scroller gets a bounded height and really scrolls.
    const source = await readSource()
    const inlineBody = styledBlock(source, 'const EditorBody = styled.div`')
    expect(inlineBody).toMatch(/& > \.code-editor/)
    expect(inlineBody).toMatch(/overflow:\s*auto/)
    const expandedBody = styledBlock(source, 'const ExpandedBody = styled.div`')
    expect(expandedBody).toMatch(/& > \.code-editor/)
    expect(expandedBody).toMatch(/flex:\s*1/)
    expect(expandedBody).toMatch(/min-height:\s*0/)
  })
})

describe('MessageEditor inline resize handle', () => {
  const surfaceHeight = () => screen.getByTestId('message-editor-resize-surface').style.height
  const storedKeys = () => {
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) out.push(key)
    }
    return out
  }

  // jsdom ships no PointerEvent constructor, so testing-library drops
  // pointerId/clientY init props. Build the events explicitly: production
  // reads clientY/pointerId off the native event, which real browsers always
  // provide for pointer events.
  const dispatchPointer = (
    target: HTMLElement | Window,
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
    init: { pointerId?: number; clientY?: number }
  ) => {
    const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
    Object.assign(event, init)
    fireEvent(target, event)
  }

  it('exposes an accessible top-edge handle and mounts adaptive with no persistence', () => {
    renderEditor()
    const handle = screen.getByTestId('message-editor-resize-handle')
    expect(handle).toHaveAttribute('role', 'separator')
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal')
    expect(handle).toHaveAttribute('tabindex', '0')
    // Trusted layout-control marker: the same-arbiter LAYOUTCONTROL identity.
    expect(handle).toHaveAttribute('data-viewport-layout-control', 'message-editor-resize')
    // First paint is the content-adaptive estimate for the long draft — never
    // a persisted height, never a large flash default.
    expect(surfaceHeight()).toBe(expectedAdaptive(RAW_MARKDOWN))
    // Mounting only measures: nothing is written to storage, ever.
    expect(storedKeys()).toEqual([])
  })

  it('renders a short draft at the single one-line floor (no large empty area)', () => {
    renderEditorWithContent('hi')
    expect(surfaceHeight()).toBe(`${MESSAGE_EDITOR_HEIGHT_MIN}px`)
  })

  it('renders a very long draft clamped at the 52vh maximum', () => {
    const long = Array.from({ length: 80 }, (_, i) => `body line ${i}`).join('\n')
    renderEditorWithContent(long)
    expect(surfaceHeight()).toBe(`${getMessageEditorHeightBounds(window.innerHeight).max}px`)
  })

  it('keyboard resize captures the existing hold then commits a session-only height', () => {
    renderEditor()
    const bounds = getMessageEditorHeightBounds(window.innerHeight)
    const handle = screen.getByTestId('message-editor-resize-handle')
    const from = estimateMessageEditorAutoHeight(RAW_MARKDOWN, window.innerHeight)

    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(mocks.captureIntent).toHaveBeenCalledTimes(1)
    expect(surfaceHeight()).toBe(`${from + 8}px`)
    expect(storedKeys()).toEqual([])

    fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true })
    expect(surfaceHeight()).toBe(`${from + 8 - 48}px`)

    fireEvent.keyDown(handle, { key: 'End' })
    expect(surfaceHeight()).toBe(`${bounds.max}px`)

    fireEvent.keyDown(handle, { key: 'Home' })
    expect(surfaceHeight()).toBe(`${bounds.min}px`)
  })

  it('pointer drag captures the existing hold then resizes exactly, committing only on release', () => {
    renderEditor()
    const from = estimateMessageEditorAutoHeight(RAW_MARKDOWN, window.innerHeight)
    const handle = screen.getByTestId('message-editor-resize-handle')

    dispatchPointer(handle, 'pointerdown', { pointerId: 7, clientY: 200 })
    expect(mocks.captureIntent).toHaveBeenCalledTimes(1)
    dispatchPointer(handle, 'pointermove', { pointerId: 7, clientY: 150 })
    // Upward drag grows; nothing is persisted mid-drag.
    expect(surfaceHeight()).toBe(`${from + 50}px`)
    expect(storedKeys()).toEqual([])

    dispatchPointer(handle, 'pointerup', { pointerId: 7, clientY: 150 })
    expect(storedKeys()).toEqual([])
    expect(surfaceHeight()).toBe(`${from + 50}px`)
  })

  it('pointer release outside the handle (window fallback, no capture) still commits with no snapback', () => {
    renderEditor()
    const from = estimateMessageEditorAutoHeight(RAW_MARKDOWN, window.innerHeight)
    const handle = screen.getByTestId('message-editor-resize-handle')

    dispatchPointer(handle, 'pointerdown', { pointerId: 11, clientY: 200 })
    dispatchPointer(handle, 'pointermove', { pointerId: 11, clientY: 160 })
    expect(surfaceHeight()).toBe(`${from + 40}px`)
    // Release below/outside the editor: the event targets the window, never
    // the handle — the gesture fallback must still commit the final height.
    dispatchPointer(window, 'pointerup', { pointerId: 11, clientY: 120 })
    expect(surfaceHeight()).toBe(`${from + 40}px`)
    expect(storedKeys()).toEqual([])
  })

  it('capture loss mid-gesture settles at the final displayed height', () => {
    renderEditor()
    const from = estimateMessageEditorAutoHeight(RAW_MARKDOWN, window.innerHeight)
    const handle = screen.getByTestId('message-editor-resize-handle')

    dispatchPointer(handle, 'pointerdown', { pointerId: 13, clientY: 200 })
    dispatchPointer(handle, 'pointermove', { pointerId: 13, clientY: 170 })
    expect(surfaceHeight()).toBe(`${from + 30}px`)
    dispatchPointer(handle, 'lostpointercapture', { pointerId: 13 })
    // No snapback: the session keeps the last live height.
    expect(surfaceHeight()).toBe(`${from + 30}px`)
  })

  it('pointer cancel discards the drag without committing (truthful cancel)', () => {
    renderEditor()
    const from = estimateMessageEditorAutoHeight(RAW_MARKDOWN, window.innerHeight)
    const handle = screen.getByTestId('message-editor-resize-handle')

    dispatchPointer(handle, 'pointerdown', { pointerId: 9, clientY: 200 })
    dispatchPointer(handle, 'pointermove', { pointerId: 9, clientY: 100 })
    dispatchPointer(window, 'pointercancel', { pointerId: 9 })
    expect(storedKeys()).toEqual([])
    expect(surfaceHeight()).toBe(`${from}px`)
  })

  it('a no-move click never pins a manual height (stays adaptive)', () => {
    renderEditor()
    const handle = screen.getByTestId('message-editor-resize-handle')
    dispatchPointer(handle, 'pointerdown', { pointerId: 17, clientY: 200 })
    dispatchPointer(handle, 'pointerup', { pointerId: 17, clientY: 200 })
    expect(surfaceHeight()).toBe(expectedAdaptive(RAW_MARKDOWN))
  })

  it('drag from an adaptive short draft starts at the displayed height with no jump', () => {
    // Regression for the split-floor jump: an adaptive short draft sits far
    // below any historical manual minimum, so pointerdown plus the first
    // small movement must render continuously from the displayed height —
    // never jump to a taller manual floor.
    renderEditorWithContent('hi')
    const floor = getMessageEditorHeightBounds(window.innerHeight).min
    expect(surfaceHeight()).toBe(`${floor}px`)
    const handle = screen.getByTestId('message-editor-resize-handle')

    // Pointer down alone renders the same displayed height (no jump).
    dispatchPointer(handle, 'pointerdown', { pointerId: 21, clientY: 200 })
    expect(surfaceHeight()).toBe(`${floor}px`)

    // The first small movement changes continuously from the displayed height.
    dispatchPointer(handle, 'pointermove', { pointerId: 21, clientY: 180 })
    expect(surfaceHeight()).toBe(`${floor + 20}px`)

    // Release commits the displayed final effective height — far below any
    // historical manual floor, with nothing persisted.
    dispatchPointer(handle, 'pointerup', { pointerId: 21, clientY: 180 })
    expect(surfaceHeight()).toBe(`${floor + 20}px`)
    expect(Number.parseFloat(surfaceHeight())).toBeLessThan(floor + 100)
    expect(storedKeys()).toEqual([])
  })

  it('drag downward from an adaptive short draft clamps at the same one-line floor', () => {
    // Both drag directions share the single lower bound: shrinking past the
    // floor holds at the floor instead of jumping or collapsing.
    renderEditorWithContent('hi')
    const floor = getMessageEditorHeightBounds(window.innerHeight).min
    const handle = screen.getByTestId('message-editor-resize-handle')

    dispatchPointer(handle, 'pointerdown', { pointerId: 23, clientY: 200 })
    dispatchPointer(handle, 'pointermove', { pointerId: 23, clientY: 260 })
    expect(surfaceHeight()).toBe(`${floor}px`)
    dispatchPointer(handle, 'pointerup', { pointerId: 23, clientY: 260 })
    expect(surfaceHeight()).toBe(`${floor}px`)
  })

  it('manual session height survives text edits; reopen resets to adaptive', () => {
    const first = renderEditor()
    const handle = screen.getByTestId('message-editor-resize-handle')
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    const manual = screen.getByTestId('message-editor-resize-surface').style.height
    expect(manual).not.toBe(expectedAdaptive(RAW_MARKDOWN))
    // Later text edits never overwrite the session choice.
    fireEvent.change(screen.getByLabelText('message-editor-source'), { target: { value: `${RAW_MARKDOWN}\nmore` } })
    expect(screen.getByTestId('message-editor-resize-surface').style.height).toBe(manual)
    first.unmount()
    // Reopen starts adaptive again — the closed session leaves nothing behind.
    renderEditor()
    expect(screen.getByTestId('message-editor-resize-surface').style.height).toBe(expectedAdaptive(RAW_MARKDOWN))
    expect(storedKeys()).toEqual([])
  })

  it('measured content height grows and shrinks the surface within the single bounds', () => {
    renderEditorWithContent('hi')
    expect(surfaceHeight()).toBe(`${MESSAGE_EDITOR_HEIGHT_MIN}px`)
    // Engine reports natural content height (wrapped text at current width):
    // the surface follows with slack, both directions, through one resolver.
    fireAutoHeight(200)
    expect(surfaceHeight()).toBe('204px')
    fireAutoHeight(60)
    expect(surfaceHeight()).toBe('64px')
    fireAutoHeight(30)
    expect(surfaceHeight()).toBe(`${MESSAGE_EDITOR_HEIGHT_MIN}px`)
    fireAutoHeight(5000)
    expect(surfaceHeight()).toBe(`${resolveMessageEditorHeight(5000, window.innerHeight)}px`)
  })

  it('measurements are ignored once a manual height owns the session', () => {
    renderEditorWithContent('hi')
    const handle = screen.getByTestId('message-editor-resize-handle')
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    const manual = surfaceHeight()
    fireAutoHeight(400)
    expect(surfaceHeight()).toBe(manual)
  })

  it('respects small-window clamps with no persistence involved', () => {
    const previous = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true })
    try {
      renderEditor()
      const bounds = getMessageEditorHeightBounds(300)
      // Long-draft estimate clamps to the small-window maximum.
      expect(surfaceHeight()).toBe(`${bounds.max}px`)
      expect(storedKeys()).toEqual([])
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: previous, configurable: true })
    }
  })
})

describe('MessageEditor expanded modal correction', () => {
  it('opens with supported no-motion props and no trigger refocus', async () => {
    renderEditor()
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    const modal = screen.getByTestId('mock-antd-modal')
    expect(modal).toBeInTheDocument()
    expect(modal).toHaveAttribute('data-transition-name', '')
    expect(modal).toHaveAttribute('data-mask-transition-name', '')
    expect(modal).toHaveAttribute('data-focus-trigger-after-close', 'false')
  })

  it('inline placeholder keeps the current session height instead of resetting', async () => {
    renderEditor()
    const expected = estimateMessageEditorAutoHeight(RAW_MARKDOWN, window.innerHeight)
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    const placeholder = screen.getByTestId('message-editor-expanded-placeholder')
    expect(placeholder.style.height).toBe(`${expected}px`)
  })

  it('inline placeholder follows a manual session height and keeps the find bar mounted', async () => {
    renderEditor()
    const handle = screen.getByTestId('message-editor-resize-handle')
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    const manual = screen.getByTestId('message-editor-resize-surface').style.height
    const from = estimateMessageEditorAutoHeight(RAW_MARKDOWN, window.innerHeight)
    expect(manual).toBe(`${from + 16}px`)
    await userEvent.click(screen.getByTestId('message-editor-find-btn'))
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    const placeholder = screen.getByTestId('message-editor-expanded-placeholder')
    expect(placeholder.style.height).toBe(manual)
    // Find stays inline (footprint hold) and duplicates into the modal; the
    // engine itself still mounts once.
    expect(screen.getAllByLabelText('message.edit.find_placeholder').length).toBeGreaterThanOrEqual(2)
  })

  it('preview keeps the session height (auto source stays the source-of-size)', async () => {
    renderEditor()
    const before = screen.getByTestId('message-editor-resize-surface').style.height
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(screen.getByTestId('message-editor-mode-btn')).toHaveAttribute('data-mode', 'preview')
    expect(screen.getByTestId('message-editor-resize-surface').style.height).toBe(before)
    await userEvent.click(screen.getByTestId('message-editor-mode-btn'))
    expect(screen.getByTestId('message-editor-resize-surface').style.height).toBe(before)
  })

  it('expand/collapse retains the source draft and leaves cancel/save wiring unchanged', async () => {
    const onCancel = vi.fn()
    renderEditor('user', onCancel)
    fireEvent.change(screen.getByLabelText('message-editor-source'), { target: { value: 'modal draft pin' } })
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    expect(screen.getByTestId('message-editor-expanded')).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
    expect(mocks.onSave).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('message-editor-collapse-btn'))
    await waitFor(() => expect(screen.queryByTestId('message-editor-expanded')).toBeNull())
    expect(screen.getByLabelText('message-editor-source')).toHaveValue('modal draft pin')
    expect(onCancel).not.toHaveBeenCalled()
    const expected = estimateMessageEditorAutoHeight('modal draft pin', window.innerHeight)
    expect(screen.getByTestId('message-editor-resize-surface').style.height).toBe(`${expected}px`)
  })

  it('expanded modal keeps the fixed window height for a one-line draft (independent meaning, never adaptive)', async () => {
    // CSS contract: the modal root carries the original bounded fixed height
    // (min(72vh, calc(100vh - 120px))), the body flex-fills it with internal
    // scrolling — a one-line draft must NOT shrink the modal/body to its
    // short natural content. No viewport-specific compensator: pure CSS.
    const fs = await import('node:fs')
    const source = fs.readFileSync('src/renderer/src/pages/home/Messages/MessageEditor.tsx', 'utf-8')
    const blockOf = (anchor: string): string => {
      const at = source.indexOf(anchor)
      expect(at, `${anchor} must exist`).toBeGreaterThanOrEqual(0)
      const end = source.indexOf('\n`\n', at)
      expect(end, `${anchor} styled block must terminate`).toBeGreaterThan(at)
      return source.slice(at, end)
    }
    const root = blockOf('const ExpandedRoot = styled.div`')
    expect(root).toMatch(/height:\s*min\(72vh,\s*calc\(100vh - 120px\)\)/)
    expect(root).toMatch(/overflow:\s*hidden/)
    // Fixed window height must win over flex sizing: flex:none (never
    // flex:1, whose flex-basis overrides height inside the auto-height modal
    // body and shrinks short drafts to their natural size).
    expect(root).toMatch(/^\s*flex:\s*none\s*;/m)
    expect(root).not.toMatch(/^\s*flex:\s*1\s*;/m)
    const body = blockOf('const ExpandedBody = styled.div`')
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/& > \.code-editor/)
    expect(body).toMatch(/\.cm-scroller/)
    expect(body).toMatch(/overflow:\s*auto/)
    // The modal body carries no inlineHeight binding: only the inline
    // placeholder does.
    expect(body).not.toMatch(/inlineHeight/)
    // Preview fills the modal too with its own internal scroll.
    expect(body).toMatch(/\$\{PreviewScroll\}/)
    // Live behavior: a one-line draft expands without touching the inline
    // adaptive height, and the modal engine never reports measurements.
    renderEditorWithContent('hi')
    const inlineBefore = screen.getByTestId('message-editor-resize-surface').style.height
    expect(inlineBefore).toBe(`${MESSAGE_EDITOR_HEIGHT_MIN}px`)
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    expect(screen.getByTestId('message-editor-expanded')).toBeInTheDocument()
    expect(screen.getByTestId('message-editor-expanded-placeholder').style.height).toBe(inlineBefore)
    expect(mocks.autoHeightCallback).toBeNull()
  })

  it('modal measurements never alter the inline auto state (inline engine only)', async () => {
    renderEditorWithContent('hi')
    // Engine reports natural content height: the inline surface follows.
    fireAutoHeight(200)
    expect(screen.getByTestId('message-editor-resize-surface').style.height).toBe('204px')
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    // The modal engine mounts with onHeightChange undefined (production never
    // measures there): the inline auto state is untouched by modal width.
    expect(mocks.autoHeightCallback).toBeNull()
    await userEvent.click(screen.getByTestId('message-editor-collapse-btn'))
    await waitFor(() => expect(screen.queryByTestId('message-editor-expanded')).toBeNull())
    // Collapse returns the approved adaptive height (measurement kept).
    expect(screen.getByTestId('message-editor-resize-surface').style.height).toBe('204px')
  })

  it('collapse preserves the inline session height, text and history (live engine)', async () => {
    mocks.liveViewEnabled = true
    renderEditor()
    act(() => {
      mocks.liveView?.setSelection(0, 4)
    })
    await userEvent.click(screen.getByTestId('message-editor-bold-btn'))
    const formatted = (screen.getByLabelText('message-editor-source') as HTMLTextAreaElement).value
    expect(screen.getByTestId('message-editor-undo-btn')).toBeEnabled()
    const inlineBefore = screen.getByTestId('message-editor-resize-surface').style.height
    await userEvent.click(screen.getByTestId('message-editor-expand-btn'))
    expect(screen.getByTestId('message-editor-expanded')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('message-editor-collapse-btn'))
    await waitFor(() => expect(screen.queryByTestId('message-editor-expanded')).toBeNull())
    // Collapsed inline returns the approved height with text/history intact.
    expect(screen.getByTestId('message-editor-resize-surface').style.height).toBe(inlineBefore)
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(formatted)
    expect(screen.getByTestId('message-editor-undo-btn')).toBeEnabled()
    await userEvent.click(screen.getByTestId('message-editor-undo-btn'))
    expect(screen.getByLabelText('message-editor-source')).toHaveValue(RAW_MARKDOWN)
  })
})
