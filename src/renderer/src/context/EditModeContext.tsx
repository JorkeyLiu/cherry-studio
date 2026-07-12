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

export function useEditMode() {
  const context = use(EditModeContext)
  if (!context) {
    throw new Error('useEditMode must be used within an EditModeProvider')
  }
  return context
}
