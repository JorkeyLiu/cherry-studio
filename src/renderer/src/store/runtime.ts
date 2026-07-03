/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import { AppLogo, UserAvatar } from '@renderer/config/env'
import type { Topic, WebSearchStatus } from '@renderer/types'
import type { UpdateInfo } from 'builder-util-runtime'

export interface ChatState {
  isMultiSelectMode: boolean
  selectedMessageIds: string[]
  activeTopic: Topic | null
  /** topic ids that are currently being renamed */
  renamingTopics: string[]
  /** topic ids that are newly renamed */
  newlyRenamedTopics: string[]
}

export interface WebSearchState {
  activeSearches: Record<string, WebSearchStatus>
}

export interface UpdateState {
  info: UpdateInfo | null
  checking: boolean
  downloading: boolean
  downloaded: boolean
  downloadProgress: number
  available: boolean
  ignore: boolean
  /** Whether the update check was manually triggered by user clicking the button */
  manualCheck: boolean
}

export interface RuntimeState {
  avatar: string
  generating: boolean
  translating: boolean
  translateAbortKey?: string
  searching: boolean
  filesPath: string
  resourcesPath: string
  update: UpdateState
  export: ExportState
  chat: ChatState
  websearch: WebSearchState
  /** Query whether a task is processing or not. undefined and false share same semantics.  */
  loadingMap: Record<string, boolean>
  // Migrated from useApiServer, it's global state now
  /** Is the api server running */
  apiServerRunning: boolean
}

export interface ExportState {
  isExporting: boolean
}

const initialState: RuntimeState = {
  avatar: UserAvatar,
  generating: false,
  translating: false,
  searching: false,
  filesPath: '',
  resourcesPath: '',
  update: {
    info: null,
    checking: false,
    downloading: false,
    downloaded: false,
    downloadProgress: 0,
    available: false,
    ignore: false,
    manualCheck: false
  },
  export: {
    isExporting: false
  },
  chat: {
    isMultiSelectMode: false,
    selectedMessageIds: [],
    activeTopic: null,
    renamingTopics: [],
    newlyRenamedTopics: []
  },
  websearch: {
    activeSearches: {}
  },
  loadingMap: {},
  apiServerRunning: false
}

const runtimeSlice = createSlice({
  name: 'runtime',
  initialState,
  reducers: {
    setAvatar: (state, action: PayloadAction<string | null>) => {
      state.avatar = action.payload || AppLogo
    },
    setGenerating: (state, action: PayloadAction<boolean>) => {
      state.generating = action.payload
    },
    setTranslating: (state, action: PayloadAction<boolean>) => {
      state.translating = action.payload
    },
    setTranslateAbortKey: (state, action: PayloadAction<string>) => {
      state.translateAbortKey = action.payload
    },
    setSearching: (state, action: PayloadAction<boolean>) => {
      state.searching = action.payload
    },
    setFilesPath: (state, action: PayloadAction<string>) => {
      state.filesPath = action.payload
    },
    setResourcesPath: (state, action: PayloadAction<string>) => {
      state.resourcesPath = action.payload
    },
    setUpdateState: (state, action: PayloadAction<Partial<UpdateState>>) => {
      state.update = { ...state.update, ...action.payload }
    },
    setExportState: (state, action: PayloadAction<Partial<ExportState>>) => {
      state.export = { ...state.export, ...action.payload }
    },
    // Chat related actions
    toggleMultiSelectMode: (state, action: PayloadAction<boolean>) => {
      state.chat.isMultiSelectMode = action.payload
      if (!action.payload) {
        state.chat.selectedMessageIds = []
      }
    },
    setSelectedMessageIds: (state, action: PayloadAction<string[]>) => {
      state.chat.selectedMessageIds = action.payload
    },
    setActiveTopic: (state, action: PayloadAction<Topic>) => {
      // @ts-ignore ts2589 false positive
      state.chat.activeTopic = action.payload
    },
    setRenamingTopics: (state, action: PayloadAction<string[]>) => {
      state.chat.renamingTopics = action.payload
    },
    setNewlyRenamedTopics: (state, action: PayloadAction<string[]>) => {
      state.chat.newlyRenamedTopics = action.payload
    },
    // WebSearch related actions
    setActiveSearches: (state, action: PayloadAction<Record<string, WebSearchStatus>>) => {
      state.websearch.activeSearches = action.payload
    },
    setWebSearchStatus: (state, action: PayloadAction<{ requestId: string; status: WebSearchStatus }>) => {
      const { requestId, status } = action.payload
      if (status.phase === 'default') {
        delete state.websearch.activeSearches[requestId]
      }
      state.websearch.activeSearches[requestId] = status
    },
    startLoadingAction: (state, action: PayloadAction<{ id: string }>) => {
      const { id } = action.payload
      state.loadingMap[id] = true
    },
    finishLoadingAction: (state, action: PayloadAction<{ id: string }>) => {
      const { id } = action.payload
      delete state.loadingMap[id]
    },
    setApiServerRunningAction: (state, action: PayloadAction<boolean>) => {
      state.apiServerRunning = action.payload
    }
  }
})

export const {
  setAvatar,
  setGenerating,
  setTranslating,
  setTranslateAbortKey,
  setSearching,
  setFilesPath,
  setResourcesPath,
  setUpdateState,
  setExportState,
  // Chat related actions
  toggleMultiSelectMode,
  setSelectedMessageIds,
  setActiveTopic,
  setRenamingTopics,
  setNewlyRenamedTopics,
  startLoadingAction,
  finishLoadingAction,
  // WebSearch related actions
  setActiveSearches,
  setWebSearchStatus,
  setApiServerRunningAction
} = runtimeSlice.actions

export default runtimeSlice.reducer
