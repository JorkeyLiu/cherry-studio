import { redoDepth, undoDepth } from '@codemirror/commands'
import { useCodeStyle } from '@renderer/context/CodeStyleProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import type { BasicSetupOptions } from '@uiw/react-codemirror'
import CodeMirror, { Annotation, EditorView } from '@uiw/react-codemirror'
import diff from 'fast-diff'
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { memo } from 'react'

import { toHistoryInitialState } from './historySession'
import { useBlurHandler, useHeightListener, useLanguageExtensions, useSaveKeymap, useScrollToLine } from './hooks'
import type { CodeEditorProps } from './types'

// 标记非用户编辑的变更
const External = Annotation.define<boolean>()

/**
 * A code editor component based on CodeMirror.
 * This is a wrapper of ReactCodeMirror.
 */
const CodeEditorImpl = ({
  ref,
  value,
  placeholder,
  language,
  onSave,
  onChange,
  onBlur,
  onHeightChange,
  onEditorKeyDown,
  onEditorPaste,
  onEditorFocus,
  onEditorContextMenu,
  onEditorReady,
  historySnapshot,
  onHistoryChange,
  spellcheck,
  height,
  maxHeight,
  minHeight,
  options,
  extensions,
  fontSize: customFontSize,
  style,
  className,
  editable = true,
  readOnly = false,
  expanded = true,
  wrapped = true
}: CodeEditorProps) => {
  const { fontSize: _fontSize } = useSettings()
  // LOCK-107: the message code-block editor path and its settings are removed.
  // The shared CodeEditor (used by notes, settings pages, MCP editors, etc.)
  // keeps the previous defaults for its basicSetup options.
  const enableKeymap = useMemo(() => options?.keymap ?? false, [options?.keymap])

  // 合并固定默认值和 options 的 basicSetup，options 优先
  const basicSetup = useMemo(() => {
    return {
      lineNumbers: false,
      highlightActiveLine: false,
      foldGutter: false,
      autocompletion: true,
      keymap: false,
      ...(options as BasicSetupOptions)
    }
  }, [options])

  const fontSize = useMemo(() => customFontSize ?? _fontSize - 1, [customFontSize, _fontSize])

  const { activeCmTheme } = useCodeStyle()
  const initialContent = useRef(options?.stream ? (value ?? '').trimEnd() : (value ?? ''))
  const editorViewRef = useRef<EditorView | null>(null)

  const langExtensions = useLanguageExtensions(language, options?.lint)

  const handleSave = useCallback(() => {
    const currentDoc = editorViewRef.current?.state.doc.toString() ?? ''
    onSave?.(currentDoc)
  }, [onSave])

  // Get current content from editor
  const getContent = useCallback(() => {
    return editorViewRef.current?.state.doc.toString() ?? ''
  }, [])

  // 流式响应过程中计算 changes 来更新 EditorView
  // 无法处理用户在流式响应过程中编辑代码的情况（应该也不必处理）
  useEffect(() => {
    if (!editorViewRef.current) return

    const newContent = options?.stream ? (value ?? '').trimEnd() : (value ?? '')
    const currentDoc = editorViewRef.current.state.doc.toString()

    const changes = prepareCodeChanges(currentDoc, newContent)

    if (changes && changes.length > 0) {
      editorViewRef.current.dispatch({
        changes,
        annotations: [External.of(true)]
      })
    }
  }, [options?.stream, value])

  const saveKeymapExtension = useSaveKeymap({ onSave, enabled: enableKeymap })
  const blurExtension = useBlurHandler({ onBlur })
  const heightListenerExtension = useHeightListener({ onHeightChange })

  // Native-history session: restore the owning component's snapshot (when
  // its document still matches this mount's document) as this engine's
  // initial history. Everything else (theme, keymaps, handlers) comes fresh
  // from the current props via the normal extension pipeline below.
  const historyInitialState = useMemo(
    () => toHistoryInitialState(historySnapshot ?? null, initialContent.current),
    [historySnapshot]
  )

  // Latest-callback ref: the reporter extension subscribes once per mount,
  // so the consumer callback must stay identity-stable on the caller side
  // and is always invoked through the ref (no stale closures).
  const onHistoryChangeRef = useRef(onHistoryChange)
  onHistoryChangeRef.current = onHistoryChange
  const historyDepthsRef = useRef({ undo: 0, redo: 0 })

  const reportHistoryDepths = useCallback((state: EditorView['state']) => {
    let undo = 0
    let redo = 0
    try {
      undo = undoDepth(state)
    } catch {}
    try {
      redo = redoDepth(state)
    } catch {}
    const prev = historyDepthsRef.current
    if (prev.undo === undo && prev.redo === redo) return
    historyDepthsRef.current = { undo, redo }
    try {
      onHistoryChangeRef.current?.({ undo, redo })
    } catch {}
  }, [])

  // Depth reporter: observe-only update listener, attached only when a
  // consumer subscribes. Every other consumer keeps the exact previous
  // extension set. Depths are reported only on actual change; the mount
  // report in onCreateEditor always fires (syncing restored histories).
  const historyReporterExtension = useMemo(() => {
    if (!onHistoryChange) return []
    return EditorView.updateListener.of((update) => {
      reportHistoryDepths(update.state)
    })
  }, [onHistoryChange, reportHistoryDepths])

  // Optional native behaviors: only active when the caller provides them.
  // Keeps every existing consumer on the exact previous extension set.
  const spellcheckExtension = useMemo(() => {
    if (spellcheck === undefined) return []
    return EditorView.contentAttributes.of({ spellcheck: spellcheck ? 'true' : 'false' })
  }, [spellcheck])

  const domHandlersExtension = useMemo(() => {
    if (!onEditorKeyDown && !onEditorPaste && !onEditorFocus && !onEditorContextMenu) return []
    return EditorView.domEventHandlers({
      ...(onEditorKeyDown
        ? {
            keydown: (event: KeyboardEvent) => {
              try {
                return onEditorKeyDown(event)
              } catch {
                return false
              }
            }
          }
        : {}),
      ...(onEditorPaste
        ? {
            paste: (event: ClipboardEvent) => {
              try {
                onEditorPaste(event)
              } catch {}
            }
          }
        : {}),
      ...(onEditorFocus
        ? {
            focus: () => {
              try {
                onEditorFocus()
              } catch {}
            }
          }
        : {}),
      ...(onEditorContextMenu
        ? {
            contextmenu: (event: MouseEvent) => {
              try {
                onEditorContextMenu(event)
              } catch {}
            }
          }
        : {})
    })
  }, [onEditorKeyDown, onEditorPaste, onEditorFocus, onEditorContextMenu])

  const customExtensions = useMemo(() => {
    return [
      ...(extensions ?? []),
      ...langExtensions,
      ...(wrapped ? [EditorView.lineWrapping] : []),
      spellcheckExtension,
      domHandlersExtension,
      saveKeymapExtension,
      blurExtension,
      heightListenerExtension,
      historyReporterExtension
    ].flat()
  }, [
    extensions,
    langExtensions,
    wrapped,
    spellcheckExtension,
    domHandlersExtension,
    saveKeymapExtension,
    blurExtension,
    heightListenerExtension,
    historyReporterExtension
  ])

  const scrollToLine = useScrollToLine(editorViewRef)

  const focusEditor = useCallback((options?: { preventScroll?: boolean }) => {
    const view = editorViewRef.current
    if (!view) return
    const preventScroll = options?.preventScroll ?? true
    try {
      view.contentDOM.focus({ preventScroll })
    } catch {
      try {
        view.focus()
      } catch {}
    }
  }, [])

  const getView = useCallback(() => editorViewRef.current, [])

  useImperativeHandle(
    ref,
    () => ({
      save: handleSave,
      scrollToLine,
      getContent,
      focus: focusEditor,
      getView
    }),
    [handleSave, scrollToLine, getContent, focusEditor, getView]
  )

  return (
    <CodeMirror
      // 维持一个稳定值，避免触发 CodeMirror 重置
      value={initialContent.current}
      placeholder={placeholder}
      width="100%"
      height={expanded ? undefined : height}
      maxHeight={expanded ? undefined : maxHeight}
      minHeight={minHeight}
      editable={editable}
      readOnly={readOnly}
      // @ts-ignore 强制使用，见 react-codemirror 的 Example.tsx
      theme={activeCmTheme}
      extensions={customExtensions}
      initialState={historyInitialState}
      onCreateEditor={(view: EditorView) => {
        editorViewRef.current = view
        onHeightChange?.(view.scrollDOM?.scrollHeight ?? 0)
        try {
          // Always sync depths on mount: a restored session remounts with a
          // non-empty history, a fresh mount with an empty one. Either way
          // the subscriber's disabled states reflect this exact engine.
          const undo = undoDepth(view.state)
          const redo = redoDepth(view.state)
          historyDepthsRef.current = { undo, redo }
          onHistoryChangeRef.current?.({ undo, redo })
        } catch {}
        try {
          onEditorReady?.()
        } catch {}
      }}
      onChange={(value, viewUpdate) => {
        if (onChange && viewUpdate.docChanged) onChange(value)
      }}
      basicSetup={{
        dropCursor: true,
        allowMultipleSelections: true,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        rectangularSelection: true,
        crosshairCursor: true,
        highlightActiveLineGutter: false,
        highlightSelectionMatches: true,
        closeBracketsKeymap: enableKeymap,
        searchKeymap: enableKeymap,
        foldKeymap: enableKeymap,
        completionKeymap: enableKeymap,
        lintKeymap: enableKeymap,
        ...basicSetup // override basicSetup
      }}
      style={{
        fontSize,
        marginTop: 0,
        borderRadius: 'inherit',
        ...style
      }}
      className={`code-editor ${className ?? ''}`}
    />
  )
}

CodeEditorImpl.displayName = 'CodeEditor'

/**
 * 使用 fast-diff 计算代码变更，再转换为 CodeMirror 的 changes。
 * 可以处理所有类型的变更，不过流式响应过程中多是插入操作。
 * @param oldCode 旧的代码内容
 * @param newCode 新的代码内容
 * @returns 用于 EditorView.dispatch 的 changes 数组
 */
function prepareCodeChanges(oldCode: string, newCode: string) {
  const diffResult = diff(oldCode, newCode)

  const changes: { from: number; to: number; insert: string }[] = []
  let offset = 0

  // operation: 1=插入, -1=删除, 0=相等
  for (const [operation, text] of diffResult) {
    if (operation === 1) {
      changes.push({
        from: offset,
        to: offset,
        insert: text
      })
    } else if (operation === -1) {
      changes.push({
        from: offset,
        to: offset + text.length,
        insert: ''
      })
      offset += text.length
    } else {
      offset += text.length
    }
  }

  return changes
}

export default memo(CodeEditorImpl)
export type { CodeEditorHandles, CodeEditorProps, EditorHistoryDepths, EditorHistorySnapshot } from './types'
