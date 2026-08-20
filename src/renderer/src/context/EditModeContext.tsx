import { createContext, use, useCallback, useEffect, useMemo } from 'react'

import { useCreateEditMode } from '../hooks/useEditMode'
import { useAppDispatch, useAppSelector } from '../store'
import { clearSelection, toggleEditMode as toggleEditModeAction } from '../store/editMode'

type EditModeContextType = ReturnType<typeof useCreateEditMode>

const EditModeContext = createContext<EditModeContextType | null>(null)

interface EditModeProviderProps {
  children: React.ReactNode
  topicId: string
  scrollToGroup?: (askId: string) => void
  visibleGroupIds?: Set<string>
}

function HeavyEditModeProvider({ children, topicId, scrollToGroup, visibleGroupIds }: EditModeProviderProps) {
  const heavy = useCreateEditMode(topicId, scrollToGroup, visibleGroupIds)
  return (
    <EditModeContext value={heavy}>
      {children}
      {/* S3.5 marker: heavy subscription graph is active only while enabled */}
      <span data-testid="edit-heavy-active" style={{ display: 'none' }} />
    </EditModeContext>
  )
}

export function EditModeProvider({ children, topicId, scrollToGroup, visibleGroupIds }: EditModeProviderProps) {
  const isEnabled = useAppSelector((state) => state.editMode.enabled)
  const dispatch = useAppDispatch()
  const toggleEditMode = useCallback((enabled: boolean) => dispatch(toggleEditModeAction(enabled)), [dispatch])

  // S3.5: Clear selection on topic change even while disabled (light path). Heavy path also clears via its own effect — idempotent.
  useEffect(() => {
    dispatch(clearSelection())
  }, [dispatch, topicId])

  const handleClearSelection = useCallback(() => dispatch(clearSelection()), [dispatch])

  const lightValue = useMemo<EditModeContextType>(
    () => ({
      isEnabled: false,
      selectedGroupIds: [],
      selectedGroups: [],
      groups: [],
      hasClipboard: false,
      canUndo: false,
      canRedo: false,
      toggleEditMode,
      handleGroupClick: () => {},
      handleCopy: () => {},
      handleCut: () => {},
      handlePaste: async () => {},
      handleDelete: async () => {},
      handleMoveFocus: () => {},
      handleExtendSelection: () => {},
      handleClearSelection,
      handleUndo: async () => {},
      handleRedo: async () => {},
      clearSelection: handleClearSelection
    }),
    [toggleEditMode, handleClearSelection]
  )

  if (!isEnabled) {
    return (
      <EditModeContext value={lightValue}>
        {children}
        <span data-testid="edit-heavy-inactive" style={{ display: 'none' }} />
      </EditModeContext>
    )
  }

  return (
    <HeavyEditModeProvider topicId={topicId} scrollToGroup={scrollToGroup} visibleGroupIds={visibleGroupIds}>
      {children}
    </HeavyEditModeProvider>
  )
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
