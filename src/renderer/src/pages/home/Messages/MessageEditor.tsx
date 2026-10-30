import { redo, undo } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { loggerService } from '@logger'
import { ActionIconButton } from '@renderer/components/Buttons'
import type { CodeEditorHandles } from '@renderer/components/CodeEditor'
import CodeEditor from '@renderer/components/CodeEditor'
import { captureEditorHistory } from '@renderer/components/CodeEditor/historySession'
import type { EditorHistoryDepths, EditorHistorySnapshot } from '@renderer/components/CodeEditor/types'
import CustomTag from '@renderer/components/Tags/CustomTag'
import { useSettings } from '@renderer/hooks/useSettings'
import FileManager from '@renderer/services/FileManager'
import PasteService from '@renderer/services/PasteService'
import { useAppSelector } from '@renderer/store'
import { selectFormattedCitationsByBlockId } from '@renderer/store/messageBlock'
import type { SendMessageShortcut } from '@renderer/store/settings'
import type { FileMetadata } from '@renderer/types'
import type { MainTextMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { classNames } from '@renderer/utils'
import { determineCitationSource, withCitationTags } from '@renderer/utils/citation'
import { getFilesFromDropEvent, isSendMessageKeyPressed } from '@renderer/utils/input'
import { createMainTextBlock } from '@renderer/utils/messageUtils/create'
import { findAllBlocks, isAssistantInterruptedThinkingOnlyMessage } from '@renderer/utils/messageUtils/find'
import { audioExts, documentExts, imageExts, textExts, videoExts } from '@shared/config/constant'
import { Input, Modal, Tooltip } from 'antd'
import {
  Bold,
  ChevronDown,
  ChevronUp,
  Code,
  Eye,
  Heading,
  Link,
  List,
  Maximize2,
  Minimize2,
  Pencil,
  Quote,
  Redo2,
  Replace,
  ReplaceAll,
  Save,
  Search,
  Send,
  Undo2,
  X
} from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { FileNameRender, getFileIcon } from '../Inputbar/AttachmentPreview'
import AttachmentButton from '../Inputbar/tools/components/AttachmentButton'
import Markdown from '../Markdown/Markdown'
import { releaseStagedAttachmentUploads, stageAttachmentUploads } from './MessageEditorAttachmentUpload'
import {
  buildDocumentChanges,
  type DocumentChange,
  type EditorSelection,
  findMatches,
  type FormatResult,
  insertLink,
  replaceAllOccurrences,
  replaceMatchAt,
  toggleBold,
  toggleBulletList,
  toggleCode,
  toggleHeading,
  toggleQuote
} from './messageEditorFormatting'
import {
  estimateMessageEditorAutoHeight,
  getMessageEditorHeightBounds,
  MESSAGE_EDITOR_HEIGHT_KEYBOARD_COARSE_STEP,
  MESSAGE_EDITOR_HEIGHT_KEYBOARD_STEP,
  MESSAGE_EDITOR_MEASURED_CHROME_PX,
  resolveMessageEditorHeight
} from './messageEditorHeight'
import { createMessageEditorResendExtensions } from './messageEditorResendShortcut'
import { createMessageEditorSaveExtensions } from './messageEditorSaveShortcut'
import {
  captureInteractionIntent,
  INTERACTION_REGION_CONTROLS,
  useOptionalRouteViewportCommands
} from './routeViewportContext'

interface Props {
  message: Message
  topicId: string
  onSave: (blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => void | Promise<void>
  onResend: (blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => void | Promise<void>
  onCancel: () => void
}

type AttachmentOwnershipState = 'staged' | 'inFlight' | 'committed' | 'removing'

const MAX_RELEASE_RETRIES = 3

interface OwnedAttachment {
  file: FileMetadata
  state: AttachmentOwnershipState
  operationId?: number
}

interface PersistenceOperation {
  id: number
  blockIds: Set<string>
  settled: boolean
}

const logger = loggerService.withContext('MessageBlockEditor')

const getInitialEditableBlocks = (message: Message) => {
  const allBlocks = findAllBlocks(message)

  if (
    !allBlocks.some((block) => block.type === MessageBlockType.MAIN_TEXT) &&
    isAssistantInterruptedThinkingOnlyMessage(message)
  ) {
    return [
      ...allBlocks,
      createMainTextBlock(message.id, '', {
        model: message.model,
        status: MessageBlockStatus.SUCCESS
      })
    ]
  }

  return allBlocks
}

type MainTextViewMode = 'source' | 'preview'

interface MainTextEditorProps {
  block: MainTextMessageBlock
  messageId: string
  role: Message['role']
  disabled: boolean
  fontSize: number
  spellcheck: boolean
  sendMessageShortcut: SendMessageShortcut
  renderInputMessageAsMarkdown: boolean
  onContentChange: (blockId: string, content: string) => void
  onPaste: (event: ClipboardEvent) => Promise<unknown>
  onResendKey: () => void
  onCancelKey: () => void
  onSaveKey: () => void
}

/**
 * CodeMirror Markdown source editor for one main-text block.
 *
 * Local UI state only (view mode, expansion, find bar, inline height,
 * native-history session): the draft itself stays owned by the parent
 * (`editedBlocks`), and undo/redo history is the single native CodeMirror
 * history — typing, toolbar formatting and find/replace all dispatch native
 * transactions on the live engine, and the toolbar undo/redo buttons invoke
 * the native `undo`/`redo` commands directly on the live view (no synthetic
 * key dispatch), so keyboard and toolbar history can never diverge. Preview
 * and expansion unmount the engine; the serializable history session is
 * captured before each unmount and restored as the next mount's initial
 * history (same document only), with the snapshotted cursor/scroll restored
 * on ready. Expansion mounts exactly one modal engine — never both.
 */
const MessageMainTextEditor: FC<MainTextEditorProps> = ({
  block,
  messageId,
  role,
  disabled,
  fontSize,
  spellcheck,
  sendMessageShortcut,
  renderInputMessageAsMarkdown,
  onContentChange,
  onPaste,
  onResendKey,
  onCancelKey,
  onSaveKey
}) => {
  const { t } = useTranslation()
  const routeViewport = useOptionalRouteViewportCommands()
  const [viewMode, setViewMode] = useState<MainTextViewMode>('source')
  const [expanded, setExpanded] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [findIndex, setFindIndex] = useState(0)

  const editorRef = useRef<CodeEditorHandles | null>(null)
  const mountedOnceRef = useRef(false)
  const pendingSelectionRef = useRef<{ anchor: number; head: number } | null>(null)
  const pendingScrollRef = useRef<number | null>(null)
  // Ephemeral native-history session for THIS editing session only (one
  // component instance = one session): captured from the live engine before
  // every engine unmount and restored on the next mount. Never persisted,
  // never shared across blocks or editor instances; dies with this component.
  const [historySnapshot, setHistorySnapshot] = useState<EditorHistorySnapshot | null>(null)
  // Live native undo/redo depths reported by the mounted engine; drive the
  // toolbar disabled states so they reflect the actual shared history.
  const [historyDepths, setHistoryDepths] = useState<EditorHistoryDepths>({ undo: 0, redo: 0 })
  const contentRef = useRef(block.content)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const isUser = role === 'user'

  // Latest-callback refs keep the engine callbacks (keydown/paste/change)
  // identity-stable across draft keystrokes, so CodeMirror is never
  // reconfigured while typing.
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange
  const onPasteRef = useRef(onPaste)
  onPasteRef.current = onPaste
  const onResendKeyRef = useRef(onResendKey)
  onResendKeyRef.current = onResendKey
  const onSaveKeyRef = useRef(onSaveKey)
  onSaveKeyRef.current = onSaveKey
  const onCancelKeyRef = useRef(onCancelKey)
  onCancelKeyRef.current = onCancelKey
  const sendMessageShortcutRef = useRef(sendMessageShortcut)
  sendMessageShortcutRef.current = sendMessageShortcut
  const isUserRef = useRef(isUser)
  isUserRef.current = isUser
  // Existing submission guard (save/resend in flight) read lazily by the
  // save/resend shortcuts, so the key handlers never depend on a stale render.
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled

  useEffect(() => {
    contentRef.current = block.content
  }, [block.content])

  const content = block.content
  const isPreview = viewMode === 'preview'

  const captureControlsIntent = useCallback(() => {
    try {
      const controller = routeViewport?.controller
      if (controller)
        captureInteractionIntent(controller, { kind: 'message', id: messageId }, INTERACTION_REGION_CONTROLS)
    } catch {}
  }, [routeViewport, messageId])

  const focusQuietly = useCallback(() => {
    try {
      editorRef.current?.focus?.({ preventScroll: true })
    } catch {}
  }, [])

  const readLiveSelection = useCallback((): EditorSelection | null => {
    try {
      const view = editorRef.current?.getView?.() ?? null
      if (!view) return null
      const sel = view.state.selection.main
      return { from: sel.from, to: sel.to }
    } catch {
      return null
    }
  }, [])

  const readLiveView = useCallback((): EditorView | null => {
    try {
      return editorRef.current?.getView?.() ?? null
    } catch {
      return null
    }
  }, [])

  /**
   * ONE canonical history: every toolbar/replace mutation goes
   * through the live CodeMirror engine as a single native transaction built
   * from the minimal fast-diff change set. The engine's `history()` extension
   * owns undo/redo, so Ctrl/Cmd-Z and the toolbar buttons can never diverge.
   * The parent draft updates exactly once via the engine `onChange`; the
   * no-engine fallback (preview mode, headless tests) writes the parent
   * directly and returns whether the engine owned the edit.
   */
  const dispatchNativeEdit = useCallback(
    (nextContent: string, anchor: number, head: number): boolean => {
      const view = readLiveView()
      if (!view) {
        contentRef.current = nextContent
        onContentChangeRef.current(block.id, nextContent)
        return false
      }
      const clamp = (pos: number): number => Math.max(0, Math.min(pos, nextContent.length))
      const selection = { anchor: clamp(anchor), head: clamp(head) }
      let changes: DocumentChange[]
      try {
        changes = buildDocumentChanges(view.state.doc.toString(), nextContent)
      } catch {
        changes = []
      }
      try {
        if (changes.length === 0) {
          view.dispatch({ selection })
        } else {
          view.dispatch({ changes, selection })
        }
      } catch {
        contentRef.current = nextContent
        onContentChangeRef.current(block.id, nextContent)
        return false
      }
      // Single write path: the engine onChange propagates the exact string
      // to the parent. Never call onContentChange here as well — that would
      // fork the draft and break native history coalescing.
      return true
    },
    [block.id, readLiveView]
  )

  const scrollSelectionIntoEditorView = useCallback((view: EditorView, pos: number) => {
    // Editor-local scroll only: adjusts the CodeMirror scroller, never the
    // outer message viewport (no snapshot writes, no outer scrolling).
    try {
      const coords = view.coordsAtPos(pos)
      if (!coords) return
      const scroller = view.scrollDOM
      const rect = scroller.getBoundingClientRect()
      if (rect.height <= 0) return
      const middle = (coords.top + coords.bottom) / 2 - (rect.top + rect.bottom) / 2
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      scroller.scrollTop = Math.max(0, Math.min(maxTop, scroller.scrollTop + middle))
    } catch {}
  }, [])

  const handleChange = useCallback(
    (next: string) => {
      // Sole draft write path: native typing and native transactions both
      // arrive here exactly once. No whole-doc replacement, no history
      // bookkeeping — the engine owns history.
      contentRef.current = next
      onContentChangeRef.current(block.id, next)
    },
    [block.id]
  )

  const handleEditorReady = useCallback(() => {
    const view = readLiveView()
    if (!mountedOnceRef.current) {
      // Single usable focus with preventScroll: the shared interaction hold
      // owns viewport geometry through the editor swap, so the editor must
      // never scroll the viewport itself. Cursor starts at the end with a
      // purely local end-scroll inside the editor scroller.
      mountedOnceRef.current = true
      if (view) {
        try {
          const end = view.state.doc.length
          view.dispatch({ selection: { anchor: end, head: end } })
        } catch {}
        try {
          view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight
        } catch {}
      }
    } else if (pendingSelectionRef.current && view) {
      const { anchor, head } = pendingSelectionRef.current
      try {
        const len = view.state.doc.length
        view.dispatch({
          selection: { anchor: Math.max(0, Math.min(anchor, len)), head: Math.max(0, Math.min(head, len)) }
        })
      } catch {}
      const pendingScroll = pendingScrollRef.current
      if (pendingScroll !== null) {
        try {
          view.scrollDOM.scrollTop = Math.max(0, pendingScroll)
        } catch {}
      }
    }
    pendingSelectionRef.current = null
    pendingScrollRef.current = null
    focusQuietly()
  }, [focusQuietly, readLiveView])

  const snapshotLivePosition = useCallback(() => {
    const view = readLiveView()
    if (!view) return
    try {
      const sel = view.state.selection.main
      pendingSelectionRef.current = { anchor: sel.anchor, head: sel.head }
    } catch {}
    try {
      pendingScrollRef.current = view.scrollDOM.scrollTop
    } catch {}
  }, [readLiveView])

  /**
   * Capture the live engine's native history BEFORE the engine unmounts.
   * Runs synchronously in the preview/expand/collapse handlers while the old
   * view is still alive; the next mount restores it (same document only).
   * A failed or field-less capture keeps the previous snapshot — never
   * clobbers it with null.
   */
  const snapshotHistory = useCallback(() => {
    try {
      const view = readLiveView()
      if (!view) return
      const snapshot = captureEditorHistory(view.state)
      if (snapshot) setHistorySnapshot(snapshot)
    } catch {}
  }, [readLiveView])

  const handleHistoryChange = useCallback((depths: EditorHistoryDepths) => {
    // Identity-stable subscriber for the engine depth reporter.
    setHistoryDepths(depths)
  }, [])

  const collapseExpanded = useCallback(() => {
    captureControlsIntent()
    snapshotLivePosition()
    snapshotHistory()
    setExpanded(false)
  }, [captureControlsIntent, snapshotHistory, snapshotLivePosition])

  const collapseExpandedRef = useRef(collapseExpanded)
  collapseExpandedRef.current = collapseExpanded

  const handleEditorKeyDown = useCallback((event: KeyboardEvent) => {
    // Expanded-modal Escape closes the expansion first and retains the
    // draft — for both roles. Everything below keeps the original inline
    // keyboard policy (assistant Escape is a no-op).
    if (event.key === 'Escape' && expandedRef.current) {
      event.preventDefault()
      collapseExpandedRef.current()
      return true
    }
    if (!isUserRef.current) {
      return false
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancelKeyRef.current()
      return true
    }
    // keep the same enter behavior as inputbar, never during IME composition
    if (event.key === 'Enter' && !event.isComposing) {
      if (
        isSendMessageKeyPressed(
          event as unknown as React.KeyboardEvent<HTMLTextAreaElement>,
          sendMessageShortcutRef.current
        )
      ) {
        event.preventDefault()
        onResendKeyRef.current()
        return true
      }
    }
    return false
  }, [])

  const handleEditorPaste = useCallback((event: ClipboardEvent) => {
    void onPasteRef.current(event)
  }, [])

  const handleEditorFocus = useCallback(() => {
    try {
      PasteService.setLastFocusedComponent('messageEditor')
    } catch {}
  }, [])

  const handleEditorContextMenu = useCallback((event: MouseEvent) => {
    // Preserve the original behavior: never trigger the global Electron menu.
    event.stopPropagation()
  }, [])

  // Cmd+Enter (macOS) / Ctrl+Enter (other platforms) runs the SAME action as
  // the existing resend button, and only where that action exists (user
  // messages). Assistant edits keep save/cancel and get no shortcut. Injected
  // as a high-precedence editor extension because the engine's own keymap owns
  // Enter/Mod-Enter at default precedence.
  const resendShortcutExtensions = useMemo(
    () =>
      createMessageEditorResendExtensions({
        role,
        isDisabled: () => disabledRef.current,
        onResend: () => onResendKeyRef.current()
      }),
    [role]
  )

  // Cmd+S / Ctrl+S runs the SAME action as the existing save button, for both
  // roles (both have save). Same mechanism and memoization as the resend
  // binding: the extension set stays identity-stable across draft keystrokes
  // (refs carry the latest callbacks), so the engine is never reconfigured
  // while typing.
  const saveShortcutExtensions = useMemo(
    () =>
      createMessageEditorSaveExtensions({
        isDisabled: () => disabledRef.current,
        onSave: () => onSaveKeyRef.current()
      }),
    []
  )
  const editorShortcutExtensions = useMemo(
    () => [...saveShortcutExtensions, ...resendShortcutExtensions],
    [saveShortcutExtensions, resendShortcutExtensions]
  )

  const applyToolbarOp = useCallback(
    (op: (content: string, selection: EditorSelection) => FormatResult) => {
      if (disabled || isPreview) return
      const current = contentRef.current
      const live = readLiveSelection()
      const selection = live ?? { from: 0, to: current.length }
      const next = op(current, selection)
      dispatchNativeEdit(next.content, next.anchor, next.head)
      focusQuietly()
    },
    [disabled, dispatchNativeEdit, focusQuietly, isPreview, readLiveSelection]
  )

  /**
   * Toolbar Undo/Redo run the SAME native history object as Ctrl/Cmd-Z via
   * the direct `undo`/`redo` commands on the live view. No synthetic key
   * dispatch, no alternate stack. The engine reports live depths after every
   * transaction, so the buttons enable/disable on the actual shared history.
   */
  const performUndo = useCallback(() => {
    if (disabled || isPreview) return
    const view = readLiveView()
    if (!view) return
    focusQuietly()
    try {
      undo(view)
    } catch {}
  }, [disabled, focusQuietly, isPreview, readLiveView])

  const performRedo = useCallback(() => {
    if (disabled || isPreview) return
    const view = readLiveView()
    if (!view) return
    focusQuietly()
    try {
      redo(view)
    } catch {}
  }, [disabled, focusQuietly, isPreview, readLiveView])

  const matches = useMemo(() => findMatches(content, findText), [content, findText])
  const activeMatchIndex = matches.length === 0 ? 0 : findIndex % matches.length

  const goToMatch = useCallback(
    (index: number) => {
      if (matches.length === 0 || !findText) return
      const safe = ((index % matches.length) + matches.length) % matches.length
      setFindIndex(safe)
      const view = readLiveView()
      if (!view || isPreview) return
      const at = matches[safe]
      try {
        view.dispatch({ selection: { anchor: at, head: at + findText.length } })
      } catch {}
      scrollSelectionIntoEditorView(view, at)
      focusQuietly()
    },
    [findText, focusQuietly, isPreview, matches, readLiveView, scrollSelectionIntoEditorView]
  )

  const handleReplaceCurrent = useCallback(() => {
    if (disabled || isPreview || matches.length === 0 || !findText) return
    const current = contentRef.current
    const next = replaceMatchAt(current, findText, replaceText, activeMatchIndex)
    dispatchNativeEdit(next.content, next.anchor, next.anchor)
    focusQuietly()
  }, [activeMatchIndex, disabled, dispatchNativeEdit, findText, focusQuietly, isPreview, matches.length, replaceText])

  const handleReplaceAll = useCallback(() => {
    if (disabled || isPreview || matches.length === 0 || !findText) return
    const current = contentRef.current
    const nextContent = replaceAllOccurrences(current, findText, replaceText)
    dispatchNativeEdit(nextContent, 0, 0)
    setFindIndex(0)
    focusQuietly()
  }, [disabled, dispatchNativeEdit, findText, focusQuietly, isPreview, matches.length, replaceText])

  const openExpanded = useCallback(() => {
    // Expansion is local UI state: arm the shared region hold synchronously
    // before the layout change, exactly like edit open/cancel. The modal
    // mounts a new engine, so the native history session is captured first.
    captureControlsIntent()
    snapshotLivePosition()
    snapshotHistory()
    setExpanded(true)
  }, [captureControlsIntent, snapshotHistory, snapshotLivePosition])

  // Draft preview reuses the current Markdown renderer with the same citation
  // handling as the persisted message view (MainTextBlock): the synthetic
  // block carries the live draft only as a render input — nothing is written
  // back to the message authority, the draft stays unnormalized, and the
  // preview mounts solely in preview mode so source keystrokes never pay the
  // parse cost. User drafts honor the plain-text display setting exactly like
  // the saved message view.
  const citationBlockId = block.citationReferences?.[0]?.citationBlockId
  const selectorCitations = useAppSelector((state) =>
    citationBlockId ? selectFormattedCitationsByBlockId(state, citationBlockId) : []
  )
  const processPreviewContent = useCallback(
    (rawText: string) => {
      if (!block.citationReferences?.length || !citationBlockId || selectorCitations.length === 0) {
        return rawText
      }
      const sourceType = determineCitationSource(block.citationReferences)
      return withCitationTags(rawText, selectorCitations, sourceType)
    },
    [block.citationReferences, citationBlockId, selectorCitations]
  )

  const previewBlock = useMemo<MainTextMessageBlock>(
    () => ({ ...block, content, status: MessageBlockStatus.SUCCESS }),
    [block, content]
  )

  const toggleViewMode = useCallback(() => {
    // Source/preview is ONE toggling control: the engine unmounts either
    // way, so the native history session plus the live cursor and the
    // editor-local scroll are snapshotted before every switch — the return
    // trip restores all three without touching the outer message viewport.
    // The raw draft itself is untouched: it stays owned by the parent.
    snapshotLivePosition()
    snapshotHistory()
    setViewMode((prev) => (prev === 'preview' ? 'source' : 'preview'))
  }, [snapshotHistory, snapshotLivePosition])

  const toggleFind = useCallback(() => {
    // Find/replace open/close changes layout: arm the shared viewport hold
    // synchronously before the mutation. Keystrokes inside the find inputs
    // must not re-arm (no hold resets per keystroke).
    captureControlsIntent()
    setFindOpen((prev) => !prev)
    setFindIndex(0)
  }, [captureControlsIntent])

  const formatDisabled = disabled || isPreview
  // Toolbar history buttons reflect the live native stack: they enable only
  // when the shared history actually has something to undo/redo.
  const undoDisabled = formatDisabled || historyDepths.undo === 0
  const redoDisabled = formatDisabled || historyDepths.redo === 0

  // Inline surface height: content-adaptive by default, session-manual on
  // explicit adjust — ONE sizing logic and bounds for both. `autoHeight` is
  // the raw measured engine content height + slack (clamped at USE time only,
  // so viewport resizes never rewrite it); `manualHeight` is the displayed
  // effective height committed by drag release / keyboard for THIS edit
  // session — later text edits never overwrite it, and close/save/cancel +
  // reopen starts adaptive again. No persistence by design: a stale saved
  // height must never pin a new session.
  const [manualHeight, setManualHeight] = useState<number | null>(null)
  const [autoHeight, setAutoHeight] = useState<number | null>(null)
  const [viewportHeight, setViewportHeight] = useState<number | undefined>(() =>
    typeof window !== 'undefined' ? window.innerHeight : undefined
  )
  const manualHeightRef = useRef<number | null>(null)
  const viewportHeightRef = useRef<number | undefined>(typeof window !== 'undefined' ? window.innerHeight : undefined)
  // Live drag value (intended, unclamped): committed to the session on
  // pointer-up / keyboard only — never per-pointermove, never on resize.
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const dragStateRef = useRef<{ startY: number; startHeight: number; pointerId: number } | null>(null)
  const liveHeightRef = useRef<number | null>(null)
  const detachWindowDragListenersRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => {
      setViewportHeight(window.innerHeight)
      viewportHeightRef.current = window.innerHeight
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    return () => {
      dragStateRef.current = null
      liveHeightRef.current = null
      try {
        detachWindowDragListenersRef.current?.()
      } catch {}
      detachWindowDragListenersRef.current = null
    }
  }, [])

  // First-paint estimate before the live engine reports its measured height:
  // physical-line based, clamped to the adaptive range — short drafts start
  // near the adaptive floor (never a large-height flash), long drafts start
  // at the maximum they will measure into.
  const estimatedAutoHeight = useMemo(
    () => estimateMessageEditorAutoHeight(content, viewportHeight),
    [content, viewportHeight]
  )

  const commitManualHeight = useCallback((intended: number) => {
    if (!Number.isFinite(intended) || intended <= 0) return
    // The session keeps the displayed effective height through the single
    // resolver — what the user sees is what the session keeps, including
    // releases outside the editor. No snapback, no separate manual clamp.
    const effective = resolveMessageEditorHeight(intended, viewportHeightRef.current)
    const rounded = Math.round(effective)
    manualHeightRef.current = rounded
    setManualHeight(rounded)
  }, [])

  /**
   * Adaptive measurement from the INLINE source engine only. Ignored while a
   * manual height owns this session, while the expanded modal engine reports
   * (modal width would mis-size the inline surface), and for invalid reports.
   * Converges without a feedback loop: engine content height depends on width
   * only, never on the surface height it sizes. Preview keeps the retained
   * session height — the auto source content remains the source-of-size.
   */
  const handleAutoContentHeight = useCallback((contentHeight: number) => {
    try {
      if (expandedRef.current) return
      if (manualHeightRef.current !== null) return
      if (!Number.isFinite(contentHeight) || contentHeight <= 0) return
      const next = contentHeight + MESSAGE_EDITOR_MEASURED_CHROME_PX
      setAutoHeight((prev) => (prev !== null && Math.abs(prev - next) < 1 ? prev : next))
    } catch {}
  }, [])

  const heightBounds = getMessageEditorHeightBounds(viewportHeight)
  // Displayed height through the SINGLE resolver: live drag renders the
  // current gesture height, otherwise the session manual height wins, else
  // the measured (or estimated pre-measure) adaptive height. Because every
  // path shares one floor and one maximum, starting a drag from an adaptive
  // short draft renders the actually displayed height with no jump, and a
  // click with no motion commits nothing (stays adaptive).
  const inlineHeight =
    dragHeight === null
      ? manualHeight !== null
        ? resolveMessageEditorHeight(manualHeight, viewportHeight)
        : resolveMessageEditorHeight(autoHeight ?? estimatedAutoHeight, viewportHeight)
      : resolveMessageEditorHeight(dragHeight, viewportHeight)

  const detachWindowDragListeners = useCallback(() => {
    const detach = detachWindowDragListenersRef.current
    detachWindowDragListenersRef.current = null
    try {
      detach?.()
    } catch {}
  }, [])

  const updateDragHeight = useCallback((pointerId: number, clientY: number) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== pointerId) return
    // Upward drag grows: the top edge moves away from the content.
    const next = drag.startHeight + drag.startY - clientY
    liveHeightRef.current = next
    setDragHeight(next)
  }, [])

  const finishDragHeight = useCallback(
    (pointerId: number, commit: boolean) => {
      const drag = dragStateRef.current
      if (!drag || drag.pointerId !== pointerId) return
      dragStateRef.current = null
      detachWindowDragListeners()
      const live = liveHeightRef.current
      liveHeightRef.current = null
      setDragHeight(null)
      // A truthful cancel (pointercancel) discards; every normal release path
      // commits the final displayed effective height with no snapback.
      // No viewport release here: the keeper's quiet validation adopts the
      // below-row handoff on the final committed height by itself. No re-arm
      // per move, no timers, no scroll writes here.
      if (commit && live !== null) commitManualHeight(live)
    },
    [commitManualHeight, detachWindowDragListeners]
  )

  const attachWindowDragListeners = useCallback(
    (pointerId: number) => {
      // Fallback for releases outside the handle when pointer capture is
      // unavailable or lost: the window still observes the same gesture by
      // pointer id. Added per gesture, removed when it ends — cleanup stays
      // contained to this gesture, with unmount as the only outer backstop.
      detachWindowDragListeners()
      if (typeof window === 'undefined') return
      const onMove = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return
        updateDragHeight(event.pointerId, event.clientY)
      }
      const onUp = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return
        finishDragHeight(event.pointerId, true)
      }
      const onCancel = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return
        finishDragHeight(event.pointerId, false)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      detachWindowDragListenersRef.current = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
      }
    },
    [detachWindowDragListeners, finishDragHeight, updateDragHeight]
  )

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Shared viewport hold FIRST, synchronously before any layout mutation:
      // the keeper holds the captured region BOTTOM every frame and hands off
      // to the stable row below after layout-quiet — the same discrete path
      // as expand/find/cancel, with no gesture-deferred settle. A continuous
      // drag simply re-renders heights per move; each frame compensates at the
      // same bottom baseline and the quiet handoff adopts the below row, so
      // later frames keep holding the same baseline without a pointerup
      // release. Resize is a local dimension update only: it never scrolls
      // the outer viewport and never writes snapshots. Fail-closed when a
      // genuine user session is live (no force begin).
      try {
        const controller = routeViewport?.controller
        if (controller) {
          captureInteractionIntent(controller, { kind: 'message', id: messageId }, INTERACTION_REGION_CONTROLS)
        }
      } catch {}
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {}
      dragStateRef.current = { startY: event.clientY, startHeight: inlineHeight, pointerId: event.pointerId }
      setDragHeight(inlineHeight)
      attachWindowDragListeners(event.pointerId)
    },
    [routeViewport, messageId, inlineHeight, attachWindowDragListeners]
  )

  const handleResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      updateDragHeight(event.pointerId, event.clientY)
    },
    [updateDragHeight]
  )

  const handleResizePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishDragHeight(event.pointerId, true)
    },
    [finishDragHeight]
  )

  const handleResizePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishDragHeight(event.pointerId, false)
    },
    [finishDragHeight]
  )

  const handleResizeLostPointerCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Capture revoked mid-gesture without an explicit end: the gesture is
      // over at the last live position, so settle it like a normal release.
      // After a real pointerup/pointercancel the drag is already null and
      // this is a no-op — cancel keeps its truthful discard semantics.
      const drag = dragStateRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      finishDragHeight(event.pointerId, true)
    },
    [finishDragHeight]
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const coarse = event.shiftKey ? MESSAGE_EDITOR_HEIGHT_KEYBOARD_COARSE_STEP : MESSAGE_EDITOR_HEIGHT_KEYBOARD_STEP
      let next: number | null = null
      if (event.key === 'ArrowUp') next = inlineHeight + coarse
      else if (event.key === 'ArrowDown') next = inlineHeight - coarse
      else if (event.key === 'Home') next = heightBounds.min
      else if (event.key === 'End') next = heightBounds.max
      else if (event.key === 'PageUp') next = inlineHeight + coarse * 4
      else if (event.key === 'PageDown') next = inlineHeight - coarse * 4
      if (next === null) return
      // Keyboard resizes change layout: hold first, synchronously. No outer
      // scroll default — the handle keeps focus and the viewport stays put.
      // The adjustment is session-only: it never persists and later text
      // edits never overwrite it.
      event.preventDefault()
      captureControlsIntent()
      commitManualHeight(next)
    },
    [captureControlsIntent, commitManualHeight, heightBounds.max, heightBounds.min, inlineHeight]
  )

  const renderSourceEditor = (reportContentHeight: boolean) => (
    // Independent expanded meaning: the inline engine (reportContentHeight
    // true) feeds the session-adaptive measurement; the expanded modal engine
    // (false, different width) never reports, so the inline footprint stays
    // put. Both engines use the same fixed-fill mount (expanded={false} with
    // height 100% through the bounded flex chain) — the modal body fills the
    // original bounded modal fixed height with internal CodeMirror scrolling
    // even for one-line text, never sizing to short natural content. No
    // viewport-specific compensator: the modal height is pure CSS.
    <div className="editing-message">
      <CodeEditor
        ref={editorRef}
        value={content}
        language="markdown"
        onChange={handleChange}
        // Inline engine only: feeds the session-adaptive measurement. The
        // expanded modal engine (different width) and preview (no engine)
        // never report, so the inline footprint stays put. Modal measurements
        // must not alter the inline auto state.
        onHeightChange={reportContentHeight ? handleAutoContentHeight : undefined}
        spellcheck={spellcheck}
        onEditorKeyDown={handleEditorKeyDown}
        onEditorPaste={handleEditorPaste}
        onEditorFocus={handleEditorFocus}
        onEditorContextMenu={handleEditorContextMenu}
        onEditorReady={handleEditorReady}
        historySnapshot={historySnapshot}
        onHistoryChange={handleHistoryChange}
        // Save shortcut (both roles) and resend shortcut (user messages only):
        // the same actions as the existing buttons, above the engine keymap so
        // the mod-key events actually reach them. Both inline and expanded
        // mounts share this exact extension set.
        extensions={editorShortcutExtensions}
        expanded={false}
        height="100%"
        minHeight="100%"
        editable={!disabled}
        fontSize={fontSize}
        style={{ height: '100%' }}
      />
    </div>
  )

  const renderToolbar = (inExpanded: boolean) => (
    // Toolbar grouping (markup, never forced positioning): the mode toggle
    // pins left, the scrollable tools group owns formatting + find + native
    // history (undo/redo left alongside search), and the end group owns ONLY
    // the expand/collapse control far-right. Narrow windows scroll the tools
    // group internally; the end group never shrinks away.
    <EditorToolbar>
      <ToolbarGroup>
        <Tooltip title={isPreview ? t('message.edit.show_source') : t('message.edit.show_preview')} mouseLeaveDelay={0}>
          <ActionIconButton
            data-testid="message-editor-mode-btn"
            data-mode={viewMode}
            aria-pressed={isPreview}
            active={isPreview}
            onClick={toggleViewMode}
            aria-label={isPreview ? t('message.edit.show_source') : t('message.edit.show_preview')}>
            {isPreview ? <Eye size={15} /> : <Pencil size={15} />}
          </ActionIconButton>
        </Tooltip>
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarToolsGroup data-testid="message-editor-tools-scroll">
        <Tooltip title={t('message.edit.heading')} mouseLeaveDelay={0}>
          <ActionIconButton
            disabled={formatDisabled}
            onClick={() => applyToolbarOp(toggleHeading)}
            aria-label={t('message.edit.heading')}>
            <Heading size={15} />
          </ActionIconButton>
        </Tooltip>
        <Tooltip title={t('message.edit.bold')} mouseLeaveDelay={0}>
          <ActionIconButton
            data-testid="message-editor-bold-btn"
            disabled={formatDisabled}
            onClick={() => applyToolbarOp(toggleBold)}
            aria-label={t('message.edit.bold')}>
            <Bold size={15} />
          </ActionIconButton>
        </Tooltip>
        <Tooltip title={t('message.edit.bullet_list')} mouseLeaveDelay={0}>
          <ActionIconButton
            disabled={formatDisabled}
            onClick={() => applyToolbarOp(toggleBulletList)}
            aria-label={t('message.edit.bullet_list')}>
            <List size={15} />
          </ActionIconButton>
        </Tooltip>
        <Tooltip title={t('message.edit.quote')} mouseLeaveDelay={0}>
          <ActionIconButton
            disabled={formatDisabled}
            onClick={() => applyToolbarOp(toggleQuote)}
            aria-label={t('message.edit.quote')}>
            <Quote size={15} />
          </ActionIconButton>
        </Tooltip>
        <Tooltip title={t('message.edit.code')} mouseLeaveDelay={0}>
          <ActionIconButton
            disabled={formatDisabled}
            onClick={() => applyToolbarOp(toggleCode)}
            aria-label={t('message.edit.code')}>
            <Code size={15} />
          </ActionIconButton>
        </Tooltip>
        <Tooltip title={t('message.edit.link')} mouseLeaveDelay={0}>
          <ActionIconButton
            data-testid="message-editor-link-btn"
            disabled={formatDisabled}
            onClick={() => applyToolbarOp((text, sel) => insertLink(text, sel))}
            aria-label={t('message.edit.link')}>
            <Link size={15} />
          </ActionIconButton>
        </Tooltip>
        <Tooltip title={t('message.edit.find_replace')} mouseLeaveDelay={0}>
          <ActionIconButton
            data-testid="message-editor-find-btn"
            active={findOpen}
            disabled={disabled}
            onClick={toggleFind}
            aria-label={t('message.edit.find_replace')}>
            <Search size={15} />
          </ActionIconButton>
        </Tooltip>
        <ToolbarSeparator data-testid="message-editor-history-separator" />
        <Tooltip title={t('message.edit.undo')} mouseLeaveDelay={0}>
          <ActionIconButton
            data-testid="message-editor-undo-btn"
            disabled={undoDisabled}
            onClick={performUndo}
            aria-label={t('message.edit.undo')}>
            <Undo2 size={15} />
          </ActionIconButton>
        </Tooltip>
        <Tooltip title={t('message.edit.redo')} mouseLeaveDelay={0}>
          <ActionIconButton
            data-testid="message-editor-redo-btn"
            disabled={redoDisabled}
            onClick={performRedo}
            aria-label={t('message.edit.redo')}>
            <Redo2 size={15} />
          </ActionIconButton>
        </Tooltip>
      </ToolbarToolsGroup>
      <ToolbarEndGroup>
        {inExpanded ? (
          <Tooltip title={t('message.edit.collapse')} mouseLeaveDelay={0}>
            <ActionIconButton
              data-testid="message-editor-collapse-btn"
              onClick={collapseExpanded}
              aria-label={t('message.edit.collapse')}>
              <Minimize2 size={15} />
            </ActionIconButton>
          </Tooltip>
        ) : (
          <Tooltip title={t('message.edit.expand')} mouseLeaveDelay={0}>
            <ActionIconButton
              data-testid="message-editor-expand-btn"
              onClick={openExpanded}
              aria-label={t('message.edit.expand')}>
              <Maximize2 size={15} />
            </ActionIconButton>
          </Tooltip>
        )}
      </ToolbarEndGroup>
    </EditorToolbar>
  )

  const renderFindBar = () => (
    <FindBar>
      <Input
        size="small"
        value={findText}
        onChange={(e) => {
          setFindText(e.target.value)
          setFindIndex(0)
        }}
        onPressEnter={() => goToMatch(activeMatchIndex + 1)}
        placeholder={t('message.edit.find_placeholder')}
        aria-label={t('message.edit.find_placeholder')}
        style={{ width: 150 }}
      />
      <FindCount>
        {matches.length === 0
          ? t('message.edit.no_results')
          : t('message.edit.find_count', { current: activeMatchIndex + 1, total: matches.length })}
      </FindCount>
      <Tooltip title={t('message.edit.find_previous')} mouseLeaveDelay={0}>
        <ActionIconButton
          disabled={matches.length === 0}
          onClick={() => goToMatch(activeMatchIndex - 1)}
          aria-label={t('message.edit.find_previous')}>
          <ChevronUp size={15} />
        </ActionIconButton>
      </Tooltip>
      <Tooltip title={t('message.edit.find_next')} mouseLeaveDelay={0}>
        <ActionIconButton
          disabled={matches.length === 0}
          onClick={() => goToMatch(activeMatchIndex + 1)}
          aria-label={t('message.edit.find_next')}>
          <ChevronDown size={15} />
        </ActionIconButton>
      </Tooltip>
      <Input
        size="small"
        value={replaceText}
        onChange={(e) => setReplaceText(e.target.value)}
        placeholder={t('message.edit.replace_placeholder')}
        aria-label={t('message.edit.replace_placeholder')}
        style={{ width: 150 }}
      />
      <Tooltip title={t('message.edit.replace')} mouseLeaveDelay={0}>
        <ActionIconButton
          disabled={formatDisabled || matches.length === 0}
          onClick={handleReplaceCurrent}
          aria-label={t('message.edit.replace')}>
          <Replace size={15} />
        </ActionIconButton>
      </Tooltip>
      <Tooltip title={t('message.edit.replace_all')} mouseLeaveDelay={0}>
        <ActionIconButton
          disabled={formatDisabled || matches.length === 0}
          onClick={handleReplaceAll}
          aria-label={t('message.edit.replace_all')}>
          <ReplaceAll size={15} />
        </ActionIconButton>
      </Tooltip>
    </FindBar>
  )

  const renderPreview = () => {
    // Same display semantics as the saved message view: user drafts honor the
    // plain-text setting, everything else renders through the current
    // Markdown renderer with citation post-processing. Read-only: the draft
    // itself is never normalized here.
    if (isUser && !renderInputMessageAsMarkdown) {
      return (
        <PreviewScroll>
          <p className="markdown" style={{ whiteSpace: 'pre-wrap' }}>
            {content}
          </p>
        </PreviewScroll>
      )
    }
    return (
      <PreviewScroll>
        <Markdown block={previewBlock} postProcess={processPreviewContent} />
      </PreviewScroll>
    )
  }

  const renderResizeHandle = () => (
    <ResizeHandle
      data-testid="message-editor-resize-handle"
      data-viewport-layout-control="message-editor-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('message.edit.resize_height')}
      aria-valuenow={Math.round(inlineHeight)}
      aria-valuemin={heightBounds.min}
      aria-valuemax={heightBounds.max}
      tabIndex={0}
      onPointerDown={handleResizePointerDown}
      onPointerMove={handleResizePointerMove}
      onPointerUp={handleResizePointerUp}
      onPointerCancel={handleResizePointerCancel}
      onLostPointerCapture={handleResizeLostPointerCapture}
      onKeyDown={handleResizeKeyDown}>
      <ResizeGrip aria-hidden="true" />
    </ResizeHandle>
  )

  return (
    <>
      {renderToolbar(false)}
      {/* Footprint hold: toolbar + find stay inline while expanded so the
          outer layout does not reflow when the engine ports to the modal.
          The modal duplicates these controls; the engine itself mounts once
          (inline placeholder replaces only the body at the current height). */}
      {findOpen && renderFindBar()}
      {expanded ? (
        <ExpandedPlaceholder
          data-testid="message-editor-expanded-placeholder"
          style={{ height: inlineHeight, minHeight: inlineHeight }}>
          {t('message.edit.expanded_hint')}
        </ExpandedPlaceholder>
      ) : (
        <InlineResizeContainer>
          {renderResizeHandle()}
          <ResizeSurface data-testid="message-editor-resize-surface" style={{ height: inlineHeight }}>
            {isPreview ? renderPreview() : renderSourceEditor(true)}
          </ResizeSurface>
        </InlineResizeContainer>
      )}
      {expanded && (
        <Modal
          open
          centered
          footer={null}
          closable={false}
          maskClosable={false}
          keyboard
          // No open/close motion: the default Ant zoom/fade reads as an extra
          // animation on expand and scrolls on trigger focus. Empty names are
          // the in-repo no-motion pattern (PrivacyPopup) and remain typed in
          // antd 5.27. Focus never returns to the hidden trigger (that native
          // focus relocates the outer viewport); the remounted live engine
          // re-focuses itself with preventScroll via the existing onReady.
          transitionName=""
          maskTransitionName=""
          focusTriggerAfterClose={false}
          width="min(980px, 94vw)"
          styles={{
            content: { overflow: 'hidden', maxHeight: '80vh', display: 'flex', flexDirection: 'column' },
            body: { padding: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
          }}
          onCancel={collapseExpanded}>
          <ExpandedRoot data-testid="message-editor-expanded">
            <ExpandedHeader>
              <ExpandedTitle>{t('message.edit.expanded_title')}</ExpandedTitle>
              <Tooltip title={t('message.edit.collapse')} mouseLeaveDelay={0}>
                <ActionIconButton onClick={collapseExpanded} aria-label={t('message.edit.collapse')}>
                  <X size={16} />
                </ActionIconButton>
              </Tooltip>
            </ExpandedHeader>
            {renderToolbar(true)}
            {findOpen && renderFindBar()}
            <ExpandedBody>{isPreview ? renderPreview() : renderSourceEditor(false)}</ExpandedBody>
            <ExpandedFooter>
              <Tooltip title={t('common.cancel')}>
                <ActionIconButton onClick={onCancelKey} disabled={disabled} aria-label={t('common.cancel')}>
                  <X size={16} />
                </ActionIconButton>
              </Tooltip>
              <Tooltip title={t('common.save')}>
                <ActionIconButton
                  className="message-editor-save-btn"
                  onClick={onSaveKey}
                  disabled={disabled}
                  aria-label={t('common.save')}>
                  <Save size={16} />
                </ActionIconButton>
              </Tooltip>
              {isUser && (
                <Tooltip title={t('chat.resend')}>
                  <ActionIconButton
                    className="primary-action message-editor-resend-btn"
                    onClick={onResendKey}
                    disabled={disabled}
                    aria-label={t('chat.resend')}>
                    <Send size={16} />
                  </ActionIconButton>
                </Tooltip>
              )}
            </ExpandedFooter>
          </ExpandedRoot>
        </Modal>
      )}
    </>
  )
}

const MessageBlockEditor: FC<Props> = ({ message, onSave, onResend, onCancel }) => {
  const [editedBlocks, setEditedBlocks] = useState<MessageBlock[]>(() => getInitialEditableBlocks(message))
  const [files, setFiles] = useState<FileMetadata[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [isFileDragging, setIsFileDragging] = useState(false)
  const editedBlocksRef = useRef(editedBlocks)
  const attachmentsRef = useRef(new Map<string, OwnedAttachment>())
  const persistenceOperationIdRef = useRef(0)
  const persistenceOperationsRef = useRef(new Map<number, PersistenceOperation>())
  const isProcessingRef = useRef(false)
  const isRemovingRef = useRef(false)
  const isMountedRef = useRef(true)
  const isCancelledRef = useRef(false)
  const releaseEditorOwnedAttachmentsRef = useRef<() => void>(() => {})
  const {
    pasteLongTextAsFile,
    pasteLongTextThreshold,
    fontSize,
    sendMessageShortcut,
    enableSpellCheck,
    renderInputMessageAsMarkdown
  } = useSettings()
  const { t } = useTranslation()
  const isUserMessage = message.role === 'user'
  const routeViewport = useOptionalRouteViewportCommands()

  // Unit B: edit attachments are never gated by vision metadata. All ordinary
  // attachment kinds stay selectable; endpoint/adapter encodability is decided
  // at send time with explicit failures.
  const couldAddImageFile = useMemo(() => true, [])

  const extensions = useMemo(() => {
    return [...imageExts, ...audioExts, ...videoExts, ...documentExts, ...textExts]
  }, [])

  // Long-text-as-file conversion is a composer affordance for user-authored
  // messages. Assistant message bodies are the model's own source text, so
  // pasted text always lands as body content there and is never converted into
  // an attachment, even when the setting is enabled. Other clipboard
  // attachments keep flowing through the same handler for both roles.
  const effectivePasteLongTextAsFile = isUserMessage && pasteLongTextAsFile

  useEffect(() => {
    return () => {
      isMountedRef.current = false
      isCancelledRef.current = true
      releaseEditorOwnedAttachmentsRef.current()
    }
  }, [])

  const onPaste = useCallback(
    async (event: ClipboardEvent) => {
      return await PasteService.handlePaste(
        event,
        extensions,
        setFiles,
        undefined, // 不需要setText
        effectivePasteLongTextAsFile,
        pasteLongTextThreshold,
        undefined, // 不需要text
        undefined, // 不需要 resizeTextArea
        t
      )
    },
    [effectivePasteLongTextAsFile, extensions, pasteLongTextThreshold, t]
  )

  // 添加全局粘贴事件处理
  useEffect(() => {
    PasteService.registerHandler('messageEditor', onPaste)
    PasteService.setLastFocusedComponent('messageEditor')

    return () => {
      PasteService.unregisterHandler('messageEditor')
    }
  }, [onPaste])

  const handleTextChange = (blockId: string, content: string) => {
    const nextBlocks = editedBlocksRef.current.map((block) => (block.id === blockId ? { ...block, content } : block))
    setEditedBlocksSynchronously(nextBlocks)
  }

  const setEditedBlocksSynchronously = (nextBlocks: MessageBlock[]) => {
    editedBlocksRef.current = nextBlocks
    setEditedBlocks(nextBlocks)
  }

  const releaseAttachments = (attachments: Map<string, OwnedAttachment>, attempt = 0) => {
    if (attachments.size === 0) return

    attachments.forEach((attachment, blockId) => {
      attachment.state = 'removing'
      attachment.operationId = undefined
      attachmentsRef.current.set(blockId, attachment)
    })

    const files = new Map([...attachments].map(([blockId, attachment]) => [blockId, attachment.file]))
    void releaseStagedAttachmentUploads(files)
      .then(() => {
        attachments.forEach((_attachment, blockId) => {
          const currentAttachment = attachmentsRef.current.get(blockId)
          if (currentAttachment?.state === 'removing') {
            attachmentsRef.current.delete(blockId)
          }
        })
      })
      .catch((error) => {
        logger.error('Failed to release message editor attachments:', error as Error)

        // After releaseStagedAttachmentUploads rejects, `files` retains only
        // entries whose FileManager.deleteFile failed — successful entries were
        // removed from the map inside releaseStagedAttachmentUploads.
        const failed = new Map<string, OwnedAttachment>()
        attachments.forEach((_attachment, blockId) => {
          const currentAttachment = attachmentsRef.current.get(blockId)
          if (!currentAttachment || currentAttachment.state !== 'removing') return

          if (files.has(blockId)) {
            // Deletion failed — restore to staged for retry (LOCK-001)
            currentAttachment.state = 'staged'
            failed.set(blockId, currentAttachment)
          } else {
            // Deletion succeeded — clean orphan from attachmentsRef.current
            attachmentsRef.current.delete(blockId)
          }
        })

        // Bounded retry (LOCK-002/LOCK-003)
        if (failed.size > 0 && attempt < MAX_RELEASE_RETRIES) {
          const delay = 500 * (attempt + 1)
          setTimeout(() => releaseAttachments(failed, attempt + 1), delay)
        } else if (failed.size > 0) {
          logger.error(
            `Attachment ownership retained after ${attempt + 1} release attempts for: [${[...failed.keys()].join(', ')}]`
          )
        }
      })
  }

  const releaseEditorOwnedAttachments = () => {
    const releasableAttachments = new Map(
      [...attachmentsRef.current].filter(([, attachment]) => attachment.state === 'staged')
    )
    releaseAttachments(releasableAttachments)
  }
  releaseEditorOwnedAttachmentsRef.current = releaseEditorOwnedAttachments

  const beginPersistence = (blocks: MessageBlock[]): PersistenceOperation => {
    const operation: PersistenceOperation = {
      id: ++persistenceOperationIdRef.current,
      blockIds: new Set(),
      settled: false
    }

    const blockIds = new Set(blocks.map((block) => block.id))
    attachmentsRef.current.forEach((attachment, blockId) => {
      if (attachment.state === 'staged' && blockIds.has(blockId)) {
        attachment.state = 'inFlight'
        attachment.operationId = operation.id
        operation.blockIds.add(blockId)
      }
    })

    persistenceOperationsRef.current.set(operation.id, operation)
    return operation
  }

  const commitPersistence = (operation: PersistenceOperation, blockIds: readonly string[]) => {
    if (operation.settled) return

    blockIds.forEach((blockId) => {
      if (!operation.blockIds.has(blockId)) return
      const attachment = attachmentsRef.current.get(blockId)
      if (attachment?.state === 'inFlight' && attachment.operationId === operation.id) {
        attachment.state = 'committed'
        attachment.operationId = undefined
      }
    })
  }

  const settlePersistence = (operation: PersistenceOperation) => {
    if (operation.settled) return
    operation.settled = true
    persistenceOperationsRef.current.delete(operation.id)

    const releasableAttachments = new Map<string, OwnedAttachment>()
    operation.blockIds.forEach((blockId) => {
      const attachment = attachmentsRef.current.get(blockId)
      if (!attachment || attachment.state !== 'inFlight' || attachment.operationId !== operation.id) return

      attachment.operationId = undefined
      if (isMountedRef.current && !isCancelledRef.current) {
        attachment.state = 'staged'
      } else {
        releasableAttachments.set(blockId, attachment)
      }
    })

    releaseAttachments(releasableAttachments)
  }

  // 处理文件删除
  const handleFileRemove = async (blockId: string) => {
    if (isProcessingRef.current || isRemovingRef.current) return

    const blockIndex = editedBlocksRef.current.findIndex((block) => block.id === blockId)
    if (blockIndex < 0) return

    const block = editedBlocksRef.current[blockIndex]
    const attachment = attachmentsRef.current.get(blockId)
    if (attachment?.state === 'inFlight' || attachment?.state === 'removing') return

    const nextBlocks = editedBlocksRef.current.filter((candidate) => candidate.id !== blockId)
    setEditedBlocksSynchronously(nextBlocks)
    isRemovingRef.current = true
    setIsRemoving(true)

    if (!attachment) {
      isRemovingRef.current = false
      setIsRemoving(false)
      return
    }

    if (attachment.state !== 'staged') {
      isRemovingRef.current = false
      setIsRemoving(false)
      return
    }

    const previousState = attachment.state
    attachment.state = 'removing'
    attachment.operationId = undefined

    try {
      await FileManager.deleteFile(attachment.file.id)
      if (attachmentsRef.current.get(blockId) === attachment) {
        attachmentsRef.current.delete(blockId)
      }
    } catch (error) {
      if (isMountedRef.current && !isCancelledRef.current) {
        // Mounted: restore retryable staged ownership + UI (LOCK-001)
        attachment.state = previousState
        const restoredBlocks = [...editedBlocksRef.current]
        restoredBlocks.splice(Math.min(blockIndex, restoredBlocks.length), 0, block)
        setEditedBlocksSynchronously(restoredBlocks)
        window.toast?.error(t('common.delete_failed'))
      } else {
        // After unmount: don't restore editor state; keep ownership, schedule bounded retry (LOCK-002)
        const retryRelease = (attempt: number) => {
          if (attempt >= MAX_RELEASE_RETRIES) {
            logger.error(
              `Attachment ownership retained after ${attempt} removal attempts for file: ${attachment.file.id}`
            )
            return
          }
          const currentAttachment = attachmentsRef.current.get(blockId)
          if (!currentAttachment || currentAttachment !== attachment) return
          if (currentAttachment.state !== 'removing') return

          const delay = 500 * (attempt + 1)
          setTimeout(() => {
            FileManager.deleteFile(attachment.file.id)
              .then(() => {
                if (attachmentsRef.current.get(blockId) === attachment) {
                  attachmentsRef.current.delete(blockId)
                }
              })
              .catch(() => {
                retryRelease(attempt + 1)
              })
          }, delay)
        }
        retryRelease(0)
      }
      logger.error('Failed to remove message editor attachment:', error as Error)
    } finally {
      isRemovingRef.current = false
      if (isMountedRef.current) setIsRemoving(false)
    }
  }

  // 处理拖拽上传
  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsFileDragging(false)

    const files = await getFilesFromDropEvent(e).catch((err) => {
      logger.error('[src/renderer/src/pages/home/Inputbar/Inputbar.tsx] handleDrop:', err)
      return null
    })
    if (files) {
      let supportedFiles = 0
      files.forEach((file) => {
        if (extensions.includes(file.ext.toLowerCase())) {
          setFiles((prevFiles) => [...prevFiles, file])
          supportedFiles++
        }
      })

      // 如果有文件，但都不支持
      if (files.length > 0 && supportedFiles === 0) {
        window.toast.info(t('chat.input.file_not_supported'))
      }
    }
  }

  // 处理编辑区块并上传文件
  const processEditedBlocks = async () => {
    const result = await stageAttachmentUploads(message.id, editedBlocksRef.current, files)

    if (isCancelledRef.current) {
      const cancelledUploads = new Map(
        result.stagedUploads.map(({ block, file }) => [block.id, { file, state: 'staged' as const }])
      )
      cancelledUploads.forEach((attachment, blockId) => attachmentsRef.current.set(blockId, attachment))
      releaseAttachments(cancelledUploads)
      throw new Error('Message editor attachment upload cancelled')
    }

    if (result.stagedUploads.length > 0) {
      result.stagedUploads.forEach(({ block, file }) => {
        attachmentsRef.current.set(block.id, { file, state: 'staged' })
      })
      setEditedBlocksSynchronously(result.blocks)
      const remainingFileIds = new Set(result.remainingFiles.map((file) => file.id))
      setFiles((pendingFiles) => pendingFiles.filter((file) => remainingFileIds.has(file.id)))
    }

    if (result.error) {
      logger.error('Failed to upload one or more message attachments:', result.error as Error)
      throw result.error
    }

    return result.blocks
  }

  const handleSave = async () => {
    if (isProcessingRef.current || isRemovingRef.current) return
    isProcessingRef.current = true
    setIsProcessing(true)
    try {
      const updatedBlocks = await processEditedBlocks()
      const operation = beginPersistence(updatedBlocks)
      try {
        await onSave(updatedBlocks, (blockIds) => commitPersistence(operation, blockIds))
      } finally {
        settlePersistence(operation)
      }
    } catch {
      // Persistence failed — keep editor open, reset processing state so user can retry
      isProcessingRef.current = false
      setIsProcessing(false)
    }
  }

  const handleResend = async () => {
    if (isProcessingRef.current || isRemovingRef.current) return
    isProcessingRef.current = true
    setIsProcessing(true)
    try {
      const updatedBlocks = await processEditedBlocks()
      const operation = beginPersistence(updatedBlocks)
      try {
        await onResend(updatedBlocks, (blockIds) => commitPersistence(operation, blockIds))
      } finally {
        settlePersistence(operation)
      }
    } catch {
      // Persistence failed — keep editor open, reset processing state so user can retry
      isProcessingRef.current = false
      setIsProcessing(false)
    }
  }

  const handleCancel = () => {
    if (isProcessingRef.current || isRemovingRef.current) return
    // Esc-key cancel carries no click-boundary capture: arm the shared
    // region hold synchronously before the close (click cancels already
    // armed; re-arming is harmless).
    try {
      const controller = routeViewport?.controller
      if (controller)
        captureInteractionIntent(controller, { kind: 'message', id: message.id }, INTERACTION_REGION_CONTROLS)
    } catch {}
    isCancelledRef.current = true
    releaseEditorOwnedAttachments()
    onCancel()
  }

  const mainTextBlocks = editedBlocks.filter(
    (block): block is MainTextMessageBlock => block.type === MessageBlockType.MAIN_TEXT
  )
  const disabled = isProcessing || isRemoving

  return (
    <div className="message-editor-area">
      <EditorContainer
        className={classNames('message-editor', `message-editor-${message.role}`, isFileDragging && 'file-dragging')}
        onDragEnter={() => setIsFileDragging(true)}
        onDragOver={(e) => {
          e.preventDefault()
          setIsFileDragging(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setIsFileDragging(false)
          }
        }}
        onDrop={handleDrop}>
        <EditorSurface data-testid="message-editor-container">
          <EditorBody>
            {mainTextBlocks.map((block) => (
              <MessageMainTextEditor
                key={block.id}
                block={block}
                messageId={message.id}
                role={message.role}
                disabled={disabled}
                fontSize={fontSize}
                spellcheck={enableSpellCheck}
                sendMessageShortcut={sendMessageShortcut}
                renderInputMessageAsMarkdown={renderInputMessageAsMarkdown}
                onContentChange={handleTextChange}
                onPaste={onPaste}
                onResendKey={handleResend}
                onCancelKey={handleCancel}
                onSaveKey={handleSave}
              />
            ))}
            {(editedBlocks.some(
              (block) => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE
            ) ||
              files.length > 0) && (
              <FileBlocksContainer>
                {editedBlocks
                  .filter((block) => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE)
                  .map(
                    (block) =>
                      block.file && (
                        <CustomTag
                          key={block.id}
                          icon={getFileIcon(block.file.ext)}
                          color="#37a5aa"
                          closable
                          disabled={isProcessing || isRemoving}
                          onClose={() => handleFileRemove(block.id)}>
                          <FileNameRender file={block.file} />
                        </CustomTag>
                      )
                  )}

                {files.map((file) => (
                  <CustomTag
                    key={file.id}
                    icon={getFileIcon(file.ext)}
                    color="#37a5aa"
                    closable
                    onClose={() => setFiles((prevFiles) => prevFiles.filter((f) => f.id !== file.id))}>
                    <FileNameRender file={file} />
                  </CustomTag>
                ))}
              </FileBlocksContainer>
            )}
          </EditorBody>
          <ActionBar data-interaction-region="message-controls" data-viewport-baseline-edge="end">
            <ActionBarLeft>
              {isUserMessage && (
                <AttachmentButton
                  files={files}
                  setFiles={setFiles}
                  couldAddImageFile={couldAddImageFile}
                  extensions={extensions}
                  disabled={isProcessing}
                />
              )}
            </ActionBarLeft>
            <ActionBarRight>
              <Tooltip title={t('common.cancel')}>
                <ActionIconButton onClick={handleCancel} disabled={disabled} aria-label={t('common.cancel')}>
                  <X size={16} />
                </ActionIconButton>
              </Tooltip>
              <Tooltip title={t('common.save')}>
                <ActionIconButton
                  className="message-editor-save-btn"
                  onClick={handleSave}
                  disabled={disabled}
                  aria-label={t('common.save')}>
                  <Save size={16} />
                </ActionIconButton>
              </Tooltip>
              {message.role === 'user' && (
                <Tooltip title={t('chat.resend')}>
                  <ActionIconButton
                    className="primary-action message-editor-resend-btn"
                    onClick={handleResend}
                    disabled={disabled}
                    aria-label={t('chat.resend')}>
                    <Send size={16} />
                  </ActionIconButton>
                </Tooltip>
              )}
            </ActionBarRight>
          </ActionBar>
        </EditorSurface>
      </EditorContainer>
    </div>
  )
}

const EditorContainer = styled.div`
  width: calc(100% - 46px);
  margin: 0 0 0 46px;
  transition: all 0.2s ease;

  .bubble:not(.multi-select-mode) .message-user & {
    width: min(760px, calc(100% - 45px));
    margin: 0 45px 0 auto;
  }

  .horizontal &,
  .grid &,
  .in-popover &,
  .multi-select-mode & {
    width: 100%;
    margin-left: 0;
    margin-right: 0;
  }
`

const EditorSurface = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border: 0.5px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-background);
  box-shadow: 0 0 0 1px transparent;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background-color 0.2s ease;

  .bubble:not(.multi-select-mode) .message-user & {
    background: var(--chat-background-user);
  }

  .message-editor.file-dragging & {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 18%, transparent);

    &::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      background: color-mix(in srgb, var(--color-primary) 7%, transparent);
    }
  }
`

const EditorBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px 8px;

  .editing-message {
    width: 100%;
    height: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    color: var(--color-text);
    font-family: inherit;

    // @uiw/react-codemirror outer node (plain block, height auto): without a
    // bounded flex size it breaks the 100% chain between the sized wrapper
    // and the height:100% .cm-editor, so the scroller never overflows.
    // Flex sizing here closes that chain inside this local boundary only —
    // other shared CodeEditor consumers keep their exact previous sizing.
    & > .code-editor {
      flex: 1;
      min-height: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .cm-editor {
      flex: 1;
      min-height: 0;
      background: transparent;
      border-radius: 0;
      outline: none;
      overflow: hidden;
    }

    .cm-scroller {
      font-family: inherit;
      line-height: 1.6;
      overflow: auto;
    }

    .cm-content {
      caret-color: var(--color-text);
    }
  }
`

const EditorToolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 2px 4px;
  box-sizing: border-box;
  // Narrow-window availability: the outer toolbar never scrolls as a whole,
  // so the far-right expand/collapse stays pinned inside the chat column.
  // Horizontal pressure is absorbed by the tools group below (own overflow),
  // never by pushing the end group out of the frame. No media query, no
  // container framework — the same flex groups/padding at every width.
  overflow: hidden;
  flex-shrink: 0;

  // Explicit disabled treatment for history buttons (and any disabled tool):
  // dimmed text token PLUS an explicit 0.4 opacity baseline — the in-repo
  // disabled-opacity reference (TopicTrashPanel/TopicManageMode opacity-40,
  // EmojiIcon 0.4) — so disabled undo/redo read as substantially dim next to
  // the enabled icon, matching the global edit-mode floating toolbar
  // (EditModeActionBar: antd text buttons, native disabled, no hover tint
  // while disabled). Native + aria disabled behavior is unchanged (antd
  // Button owns it); the icon inherits the dim treatment, never primary.
  button:disabled,
  button[aria-disabled='true'] {
    color: var(--color-text-3);
    opacity: 0.4;
    background: transparent;
    cursor: not-allowed;
  }

  button:disabled:hover,
  button[aria-disabled='true']:hover,
  button:disabled:focus-visible,
  button[aria-disabled='true']:focus-visible {
    background: transparent;
    color: var(--color-text-3);
    opacity: 0.4;
  }

  button:disabled .lucide,
  button[aria-disabled='true'] .lucide {
    color: inherit;
  }
`

const ToolbarGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;

  & + & {
    margin-left: 6px;
  }
`

// Scrollable formatting group (reuses ToolbarGroup flex/padding): the only
// toolbar segment allowed to overflow horizontally. It shrinks inside the
// outer toolbar (flex + min-width 0) and scrolls its own buttons, so the
// mode/history/end groups — including the far-right expand/collapse — stay
// pinned and reachable at narrow widths. Buttons never squeeze.
const ToolbarToolsGroup = styled(ToolbarGroup)`
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;

  & > * {
    flex-shrink: 0;
  }
`

const ToolbarEndGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  // Pinned end group: never shrinks, never scrolls away. margin-left auto
  // keeps it far-right at every width, including narrow windows where the
  // tools group above absorbs the overflow by scrolling internally.
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 6px;
`

const ToolbarSeparator = styled.div`
  width: 1px;
  align-self: stretch;
  margin: 6px 4px;
  background: var(--color-border-soft);
  flex-shrink: 0;
`

const FindBar = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 6px 4px;
  flex-wrap: wrap;
  flex-shrink: 0;
`

const FindCount = styled.span`
  font-size: 12px;
  color: var(--color-text-3);
  white-space: nowrap;
  user-select: none;
`

const InlineResizeContainer = styled.div`
  // The resize grip is absolutely positioned on the outermost bordered frame
  // top edge (out of flow): this wrapper reserves no inner row — its only
  // in-flow child is the resize surface.
  display: block;
  min-width: 0;
  min-height: 0;
`

// Top-edge resize grip on the OUTERMOST bordered inline editor frame:
// absolutely positioned full-width hit target on the frame top border (the
// nearest positioned ancestor is EditorSurface), never an internal flex row.
// Transparent until hover/keyboard focus — a subtle grip only, no reserved
// inner space and no decorative stripe. Dragging uses pointer capture
// (upward grows); the handle is keyboard-operable as a horizontal separator.
// The inset focus ring stays inside the surface overflow/radius so it is
// never clipped. Deliberately not the native bottom-right `resize` control.
const ResizeHandle = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 12px;
  z-index: 2;
  cursor: row-resize;
  touch-action: none;
  user-select: none;
  border-radius: 10px 10px 0 0;
  color: var(--color-text-3);
  opacity: 0;
  transition: opacity 0.15s ease, background-color 0.15s ease;

  &:hover,
  &:focus-visible {
    opacity: 1;
    background: color-mix(in srgb, var(--color-border-soft) 55%, transparent);
    outline: none;
  }

  &:focus-visible {
    box-shadow: inset 0 0 0 1.5px var(--color-primary);
  }
`

const ResizeGrip = styled.span`
  display: block;
  width: 56px;
  height: 3px;
  border-radius: 2px;
  background: currentColor;
`

const ResizeSurface = styled.div`
  // Single one-line floor mirrors the JS resolver (one rendered text line
  // plus normal padding/slack): short drafts render with only a small normal
  // pad below the text. The CSS maximum is the same 52vh backstop.
  min-height: 40px;
  max-height: 52vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;

  &:focus-within {
    outline: none;
  }
`

const PreviewScroll = styled.div`
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 4px 2px;

  .markdown {
    font-size: inherit;
  }
`

const ExpandedPlaceholder = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--color-text-3);
  user-select: none;
`

const ExpandedRoot = styled.div`
  display: flex;
  flex-direction: column;
  // Fixed window height wins over flex sizing: the modal root is a flex item
  // of the auto-height antd body, where flex-basis (from flex:1) overrides
  // height and shrinks short content to its natural size. flex:none keeps the
  // original bounded height min(72vh, calc(100vh - 120px)) for every draft
  // length; the body below flex-fills it with internal scrolling.
  flex: none;
  height: min(72vh, calc(100vh - 120px));
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--color-text);
`

const ExpandedHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 0 8px;
  flex-shrink: 0;
`

const ExpandedTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  user-select: none;
`

const ExpandedBody = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 0.5px solid var(--color-border-soft);
  border-radius: 8px;
  padding: 8px;

  .editing-message {
    flex: 1;
    min-height: 0;
    height: 100%;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;

    // Same bounded-flex closure as the inline surface: the @uiw outer node
    // is a plain auto-height block, so without flex sizing the height:100%
    // .cm-editor resolves against an indefinite height, grows with content,
    // and the scroller never scrolls (content clipped by overflow:hidden
    // instead). Scoped to this modal body only — no shared consumer impact.
    & > .code-editor {
      flex: 1;
      min-height: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .cm-editor {
      flex: 1;
      min-height: 0;
      height: 100%;
      background: transparent;
      outline: none;
      overflow: hidden;
    }

    .cm-scroller {
      font-family: inherit;
      line-height: 1.6;
      overflow: auto;
    }

    .cm-content {
      caret-color: var(--color-text);
    }
  }

  ${PreviewScroll} {
    // Preview fills the modal too: flex-sized to the fixed modal body height
    // with its own internal scroll, never sized to short natural content.
    flex: 1;
    min-height: 0;
    height: auto;
  }
`

const ExpandedFooter = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding-top: 8px;
  flex-shrink: 0;

  .primary-action {
    .lucide {
      color: var(--color-primary);
    }
  }
`

const FileBlocksContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  padding-top: 2px;
`

const ActionBar = styled.div`
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px;
  border-top: 0.5px solid var(--color-border-soft);
  background: color-mix(in srgb, var(--color-background) 78%, transparent);

  .bubble:not(.multi-select-mode) .message-user & {
    background: color-mix(in srgb, var(--chat-background-user) 82%, var(--color-background));
  }
`

const ActionBarLeft = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
`

const ActionBarRight = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;

  .primary-action {
    .lucide {
      color: var(--color-primary);
    }
  }
`

export default memo(MessageBlockEditor)
