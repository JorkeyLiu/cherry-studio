import { useEffect, useRef } from 'react'

import { useEditMode } from './useEditMode'

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
 * 注册编辑模式的键盘快捷键
 * 当焦点在文本输入框时，所有快捷键让渡给浏览器原生处理。
 * - Ctrl+C / Cmd+C: 复制
 * - Ctrl+X / Cmd+X: 剪切
 * - Ctrl+V / Cmd+V: 粘贴
 * - Cmd+Backspace / Ctrl+Backspace: 删除
 * - Ctrl+Z / Cmd+Z: 撤销
 * - Ctrl+Shift+Z / Cmd+Shift+Z: 重做
 */
export function useClipboardKeyboard(topicId: string) {
  const editMode = useEditMode(topicId)
  const { isEnabled } = editMode

  // 用 ref 存储最新回调，避免 useEffect 因回调引用变化而重新注册 listener
  const callbacksRef = useRef({
    handleCopy: editMode.handleCopy,
    handleCut: editMode.handleCut,
    handlePaste: editMode.handlePaste,
    handleDelete: editMode.handleDelete,
    handleUndo: editMode.handleUndo,
    handleRedo: editMode.handleRedo
  })

  // 每次渲染更新 ref
  useEffect(() => {
    callbacksRef.current = {
      handleCopy: editMode.handleCopy,
      handleCut: editMode.handleCut,
      handlePaste: editMode.handlePaste,
      handleDelete: editMode.handleDelete,
      handleUndo: editMode.handleUndo,
      handleRedo: editMode.handleRedo
    }
  })

  useEffect(() => {
    if (!isEnabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      const cbs = callbacksRef.current

      // 统一守卫：焦点在文本输入框时，让浏览器原生处理所有快捷键
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
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEnabled])
}
