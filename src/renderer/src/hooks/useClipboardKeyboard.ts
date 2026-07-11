import { useEffect, useRef } from 'react'

import { useEditMode } from './useEditMode'

/**
 * 注册编辑模式的键盘快捷键
 * - Ctrl+C / Cmd+C: 复制
 * - Ctrl+X / Cmd+X: 剪切
 * - Ctrl+V / Cmd+V: 粘贴
 * - Cmd+Backspace / Ctrl+Backspace: 删除
 * - Ctrl+Z / Cmd+Z: 撤销
 * - Ctrl+Shift+Z / Cmd+Shift+Z: 重做
 * - Escape: 退出编辑模式
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
    handleRedo: editMode.handleRedo,
    toggleEditMode: editMode.toggleEditMode
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
      toggleEditMode: editMode.toggleEditMode
    }
  })

  useEffect(() => {
    if (!isEnabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      const cbs = callbacksRef.current

      // Ctrl+Z / Cmd+Z: 撤销
      if (isMod && e.key === 'z' && !e.shiftKey) {
        // 检查是否有 TipTap 编辑器聚焦
        const isEditorFocused = document.querySelector('.tiptap:focus, .ProseMirror:focus') !== null
        if (isEditorFocused) return // 让 TipTap 处理

        e.preventDefault()
        void cbs.handleUndo()
        return
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z: 重做
      if (isMod && e.key === 'z' && e.shiftKey) {
        const isEditorFocused = document.querySelector('.tiptap:focus, .ProseMirror:focus') !== null
        if (isEditorFocused) return

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

      // Escape: 退出编辑模式
      if (e.key === 'Escape') {
        e.preventDefault()
        cbs.toggleEditMode(false)
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEnabled])
}
