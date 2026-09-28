import { useEditMode } from '@renderer/context/EditModeContext'
import { type MarkedKeyboardEvent, TOOL_POPOVER_ESCAPE_CONSUMED } from '@renderer/utils/toolPopoverEscape'
import { useEffect, useRef } from 'react'

/**
 * 检查当前焦点是否在文本输入元素上。
 * 当焦点在输入框时，系统原生的复制/粘贴/剪切不应被拦截。
 */
function isTextInputFocused(): boolean {
  const el = document.activeElement
  if (!el || !(el instanceof HTMLElement)) return false

  // contenteditable 元素
  if (el.isContentEditable) return true

  // TipTap / ProseMirror 编辑器
  if (el.classList.contains('ProseMirror') || el.classList.contains('tiptap')) return true

  if (el instanceof HTMLInputElement) {
    const type = el.type
    const textTypes = ['text', 'search', 'url', 'email', 'password', 'number']
    // 无 type 或 type 在文本类型列表中
    return !type || textTypes.includes(type)
  }

  if (el instanceof HTMLTextAreaElement) return true

  return false
}

/**
 * Capture-phase consumed marker contract lives in the dependency-free neutral
 * module `@renderer/utils/toolPopoverEscape` (imported above): the open
 * Inputbar ToolPopover sets it when handling an Escape keydown and this hook
 * reads it. Re-exported here so existing hook-path importers keep working.
 */
export { TOOL_POPOVER_ESCAPE_CONSUMED } from '@renderer/utils/toolPopoverEscape'

/**
 * 注册编辑模式的键盘快捷键
 * 当焦点在文本输入框时，除 Escape 外的所有快捷键让渡给浏览器原生处理。
 * Escape 始终是编辑模式命令（与工具栏关闭行为一致）：
 * - 选区非空：清空选区，保持编辑模式；
 * - 选区为空：退出编辑模式。
 * - Ctrl+C / Cmd+C: 复制
 * - Ctrl+X / Cmd+X: 剪切
 * - Ctrl+V / Cmd+V: 粘贴
 * - Cmd+Backspace / Ctrl+Backspace: 删除
 * - Ctrl+Z / Cmd+Z: 撤销
 * - Ctrl+Shift+Z / Cmd+Shift+Z: 重做
 */
export function useClipboardKeyboard() {
  const editMode = useEditMode()
  const { isEnabled } = editMode

  // 用 ref 存储最新回调，避免 useEffect 因回调引用变化而重新注册 listener
  const callbacksRef = useRef({
    handleCopy: editMode.handleCopy,
    handleCut: editMode.handleCut,
    handlePaste: editMode.handlePaste,
    handleDelete: editMode.handleDelete,
    handleUndo: editMode.handleUndo,
    handleRedo: editMode.handleRedo,
    handleMoveFocus: editMode.handleMoveFocus,
    handleExtendSelection: editMode.handleExtendSelection,
    handleClearSelection: editMode.handleClearSelection,
    toggleEditMode: editMode.toggleEditMode,
    selectedGroupIds: (editMode as { selectedGroupIds?: readonly string[] }).selectedGroupIds ?? []
  })

  // 每次渲染更新 ref
  useEffect(() => {
    callbacksRef.current = {
      handleCopy: editMode.handleCopy,
      handleCut: editMode.handleCut,
      handlePaste: editMode.handlePaste,
      handleDelete: editMode.handleDelete,
      handleUndo: editMode.handleUndo,
      handleRedo: editMode.handleRedo,
      handleMoveFocus: editMode.handleMoveFocus,
      handleExtendSelection: editMode.handleExtendSelection,
      handleClearSelection: editMode.handleClearSelection,
      toggleEditMode: editMode.toggleEditMode,
      selectedGroupIds: (editMode as { selectedGroupIds?: readonly string[] }).selectedGroupIds ?? []
    }
  })

  useEffect(() => {
    if (!isEnabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      const cbs = callbacksRef.current

      // Escape coheres with "toolbar close exits mode": a non-empty
      // selection is cleared (edit mode stays, toolbar remains visible at
      // zero); an already-empty selection exits edit mode, which clears
      // through the existing mode-exit semantics.
      // Escape stays an edit-mode command even while an editable element
      // (chat composer, contenteditable/ProseMirror/Tiptap) is focused, with
      // two higher-priority owners: an IME composition owns Escape first
      // (yield to the IME: no preventDefault, no edit-mode call), and an open
      // Inputbar ToolPopover dismissal owns it next (capture-phase consumed
      // marker set by ToolPopover; one Escape closes the popover only).
      if (e.key === 'Escape') {
        if (e.isComposing) return
        if ((e as MarkedKeyboardEvent)[TOOL_POPOVER_ESCAPE_CONSUMED]) return
        e.preventDefault()
        if ((cbs.selectedGroupIds?.length ?? 0) > 0) {
          cbs.handleClearSelection()
        } else if (typeof cbs.toggleEditMode === 'function') {
          cbs.toggleEditMode(false)
        } else {
          cbs.handleClearSelection()
        }
        return
      }

      // 统一守卫：焦点在文本输入框时，除 Escape 外的所有快捷键
      // 让浏览器原生处理（不 preventDefault，不触发消息动作）。
      if (isTextInputFocused()) return

      // Ctrl+Z / Cmd+Z: 撤销
      if (isMod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        void cbs.handleUndo()
        return
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z: 重做
      if (isMod && e.key === 'z' && e.shiftKey) {
        e.preventDefault()
        void cbs.handleRedo()
        return
      }

      // Ctrl+C / Cmd+C: 复制
      if (isMod && e.key === 'c' && !e.shiftKey) {
        e.preventDefault()
        cbs.handleCopy()
        return
      }

      // Ctrl+X / Cmd+X: 剪切
      if (isMod && e.key === 'x' && !e.shiftKey) {
        e.preventDefault()
        cbs.handleCut()
        return
      }

      // Ctrl+V / Cmd+V: 粘贴
      if (isMod && e.key === 'v' && !e.shiftKey) {
        e.preventDefault()
        void cbs.handlePaste()
        return
      }

      // Cmd+Backspace / Ctrl+Backspace: 删除
      if (isMod && e.key === 'Backspace') {
        e.preventDefault()
        void cbs.handleDelete()
        return
      }

      // ArrowDown: 向下移动焦点（更新的消息）
      if (e.key === 'ArrowDown' && !isMod && !e.shiftKey) {
        e.preventDefault()
        cbs.handleMoveFocus('down')
        return
      }

      // ArrowUp: 向上移动焦点（更早的消息）
      if (e.key === 'ArrowUp' && !isMod && !e.shiftKey) {
        e.preventDefault()
        cbs.handleMoveFocus('up')
        return
      }

      // Shift+ArrowDown: 向下扩展选区
      if (e.key === 'ArrowDown' && e.shiftKey && !isMod) {
        e.preventDefault()
        cbs.handleExtendSelection('down')
        return
      }

      // Shift+ArrowUp: 向上扩展选区
      if (e.key === 'ArrowUp' && e.shiftKey && !isMod) {
        e.preventDefault()
        cbs.handleExtendSelection('up')
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEnabled])
}
