import type { ReactNode } from 'react'
import { createContext, use, useState } from 'react'

interface MessageEditingContextType {
  editingMessageId: string | null
  startEditing: (messageId: string) => void
  stopEditing: () => void
}

const MessageEditingContext = createContext<MessageEditingContextType | null>(null)

interface MessageEditingProviderProps {
  children: ReactNode
  /**
   * When this value changes, any active inline editor is closed. This is the
   * mode-toggle reset: MessageGroup passes its boolean edit-mode flag
   * (`isEditMode`) so entering/leaving edit mode never leaves an editor active
   * across the toggle (replaces the remount side effect removed by PERF-100).
   * Optional: consumers that never toggle edit mode (history previews, search
   * results) omit it.
   */
  resetToken?: boolean
}

export function MessageEditingProvider({ children, resetToken }: MessageEditingProviderProps) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [prevResetToken, setPrevResetToken] = useState(resetToken)

  // Adjust state during render (React's documented prop-derived reset): when
  // the reset token changes, drop any active editor synchronously so the
  // message subtree is never remounted to close it.
  if (prevResetToken !== resetToken) {
    setPrevResetToken(resetToken)
    setEditingMessageId(null)
  }

  const startEditing = (messageId: string) => {
    setEditingMessageId(messageId)
  }

  const stopEditing = () => {
    setEditingMessageId(null)
  }

  return (
    <MessageEditingContext value={{ editingMessageId, startEditing, stopEditing }}>{children}</MessageEditingContext>
  )
}

export function useMessageEditing() {
  const context = use(MessageEditingContext)
  if (!context) {
    throw new Error('useMessageEditing must be used within a MessageEditingProvider')
  }
  return context
}
