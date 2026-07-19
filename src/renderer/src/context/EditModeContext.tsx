import { createContext, use } from 'react'

import { useCreateEditMode } from '../hooks/useEditMode'

type EditModeContextType = ReturnType<typeof useCreateEditMode>

const EditModeContext = createContext<EditModeContextType | null>(null)

interface EditModeProviderProps {
  children: React.ReactNode
  topicId: string
  scrollToGroup?: (askId: string) => void
  visibleGroupIds?: Set<string>
}

export function EditModeProvider({ children, topicId, scrollToGroup, visibleGroupIds }: EditModeProviderProps) {
  const editMode = useCreateEditMode(topicId, scrollToGroup, visibleGroupIds)
  return <EditModeContext value={editMode}>{children}</EditModeContext>
}

/**
 * Strict hook — throws if no EditModeProvider is present.
 * Use in components that are always rendered inside the main chat view.
 */
export function useEditMode() {
  const context = use(EditModeContext)
  if (!context) {
    throw new Error('useEditMode must be used within an EditModeProvider')
  }
  return context
}

/**
 * Optional hook — returns null when no EditModeProvider is present.
 * Use in components that may render outside the main chat view
 * (e.g. history previews, search results).
 */
export function useOptionalEditMode() {
  return use(EditModeContext)
}
