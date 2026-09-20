import type { FileMetadata, KnowledgeBase, Model } from '@renderer/types'
import React, { createContext, use, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Read-only state interface for Inputbar tools.
 * Components subscribing to this state will re-render on changes.
 */
export interface InputbarToolsState {
  /** Attached files */
  files: FileMetadata[]
  /** Models mentioned in the input */
  mentionedModels: Model[]
  /** Selected knowledge base items */
  selectedKnowledgeBases: KnowledgeBase[]

  /** Whether image files can be added (derived state) */
  couldAddImageFile: boolean
  /** Supported file extensions (derived state) */
  extensions: string[]
}

/**
 * Dispatch interface containing all action functions.
 * These functions have stable references and won't cause re-renders.
 */
export interface InputbarToolsDispatch {
  /** State setters */
  setFiles: React.Dispatch<React.SetStateAction<FileMetadata[]>>
  setMentionedModels: React.Dispatch<React.SetStateAction<Model[]>>
  setSelectedKnowledgeBases: React.Dispatch<React.SetStateAction<KnowledgeBase[]>>

  /** Parent component actions */
  resizeTextArea: () => void
  addNewTopic: () => void

  /** Text manipulation (avoids putting text state in Context) */
  onTextChange: (updater: string | ((prev: string) => string)) => void
}

const InputbarToolsStateContext = createContext<InputbarToolsState | undefined>(undefined)
const InputbarToolsDispatchContext = createContext<InputbarToolsDispatch | undefined>(undefined)

/**
 * Get Inputbar Tools state (read-only).
 * Components using this hook will re-render when state changes.
 */
export const useInputbarToolsState = (): InputbarToolsState => {
  const context = use(InputbarToolsStateContext)
  if (!context) {
    throw new Error('useInputbarToolsState must be used within InputbarToolsProvider')
  }
  return context
}

/**
 * Get Inputbar Tools dispatch functions (stable references).
 * Components using this hook won't re-render when state changes.
 */
export const useInputbarToolsDispatch = (): InputbarToolsDispatch => {
  const context = use(InputbarToolsDispatchContext)
  if (!context) {
    throw new Error('useInputbarToolsDispatch must be used within InputbarToolsProvider')
  }
  return context
}

/**
 * Combined type containing both state and dispatch.
 * Used for type inference in tool buttons.
 */
export type InputbarToolsContextValue = InputbarToolsState & InputbarToolsDispatch

/**
 * Get both state and dispatch (convenience hook).
 * Components using this hook will re-render when state changes.
 */
export const useInputbarTools = (): InputbarToolsContextValue => {
  const state = useInputbarToolsState()
  const dispatch = useInputbarToolsDispatch()
  return { ...state, ...dispatch }
}

interface InputbarToolsProviderProps {
  children: React.ReactNode
  initialState?: Partial<{
    files: FileMetadata[]
    mentionedModels: Model[]
    selectedKnowledgeBases: KnowledgeBase[]
    couldAddImageFile: boolean
    extensions: string[]
  }>
  actions: {
    resizeTextArea: () => void
    addNewTopic: () => void
    onTextChange: (updater: string | ((prev: string) => string)) => void
  }
}

export const InputbarToolsProvider: React.FC<InputbarToolsProviderProps> = ({ children, initialState, actions }) => {
  // Core state
  const [files, setFiles] = useState<FileMetadata[]>(initialState?.files || [])
  const [mentionedModels, setMentionedModels] = useState<Model[]>(initialState?.mentionedModels || [])
  const [selectedKnowledgeBases, setSelectedKnowledgeBases] = useState<KnowledgeBase[]>(
    initialState?.selectedKnowledgeBases || []
  )

  // Derived state (internal management)
  const [couldAddImageFile, setCouldAddImageFile] = useState(initialState?.couldAddImageFile || false)
  const [extensions, setExtensions] = useState<string[]>(initialState?.extensions || [])

  // Stabilize parent actions (prevent dispatch context updates from parent action reference changes)
  const actionsRef = useRef(actions)
  useEffect(() => {
    actionsRef.current = actions
  }, [actions])

  const stableActions = useMemo(
    () => ({
      resizeTextArea: () => actionsRef.current.resizeTextArea(),
      addNewTopic: () => actionsRef.current.addNewTopic(),
      onTextChange: (updater: string | ((prev: string) => string)) => actionsRef.current.onTextChange(updater)
    }),
    []
  )

  // State Context Value (updates when state changes)
  const stateValue = useMemo<InputbarToolsState>(
    () => ({
      files,
      mentionedModels,
      selectedKnowledgeBases,
      couldAddImageFile,
      extensions
    }),
    [files, mentionedModels, selectedKnowledgeBases, couldAddImageFile, extensions]
  )

  // Dispatch Context Value (stable references)
  const dispatchValue = useMemo<InputbarToolsDispatch>(
    () => ({
      // State setters (React guarantees stable references)
      setFiles,
      setMentionedModels,
      setSelectedKnowledgeBases,

      // Stable actions
      ...stableActions
    }),
    [stableActions]
  )

  // Internal Dispatch (contains setCouldAddImageFile and setExtensions)
  const internalDispatchValue = useMemo(
    () => ({
      setCouldAddImageFile,
      setExtensions
    }),
    []
  )

  return (
    <InputbarToolsStateContext value={stateValue}>
      <InputbarToolsDispatchContext value={dispatchValue}>
        <InputbarToolsInternalDispatchContext value={internalDispatchValue}>
          {children}
        </InputbarToolsInternalDispatchContext>
      </InputbarToolsDispatchContext>
    </InputbarToolsStateContext>
  )
}

/**
 * Internal dispatch interface for Inputbar component only.
 * Used to set derived state (couldAddImageFile, extensions).
 */
interface InputbarToolsInternalDispatch {
  setCouldAddImageFile: React.Dispatch<React.SetStateAction<boolean>>
  setExtensions: React.Dispatch<React.SetStateAction<string[]>>
}

const InputbarToolsInternalDispatchContext = createContext<InputbarToolsInternalDispatch | undefined>(undefined)

/**
 * Internal hook for Inputbar component only.
 * Used to set derived state (couldAddImageFile, extensions).
 */
export const useInputbarToolsInternalDispatch = (): InputbarToolsInternalDispatch => {
  const context = use(InputbarToolsInternalDispatchContext)
  if (!context) {
    throw new Error('useInputbarToolsInternalDispatch must be used within InputbarToolsProvider')
  }
  return context
}
