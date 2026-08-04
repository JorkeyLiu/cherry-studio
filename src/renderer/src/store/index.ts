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
import { loggerService } from '@logger'
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { IpcChannel } from '@shared/IpcChannel'
import { useDispatch, useSelector, useStore } from 'react-redux'
import { FLUSH, PAUSE, PERSIST, persistReducer, persistStore, PURGE, REGISTER, REHYDRATE } from 'redux-persist'
import storage from 'redux-persist/lib/storage'

import { applyPendingImportProjection } from '../services/importProjection'
import storeSyncService from '../services/StoreSyncService'
import assistants from './assistants'
import backup from './backup'
import clipboard from './clipboard'
import copilot from './copilot'
import editMode from './editMode'
import inputToolsReducer from './inputTools'
import knowledge from './knowledge'
import llm from './llm'
import mcp from './mcp'
import memory from './memory'
import messageBlocksReducer from './messageBlock'
import migrate from './migrate'
import newMessagesReducer from './newMessage'
import { setNotesPath } from './note'
import note from './note'
import nutstore from './nutstore'
import ocr from './ocr'
import preprocess from './preprocess'
import runtime from './runtime'
import settings from './settings'
import shortcuts from './shortcuts'
import tabs from './tabs'
import topicSegment from './topicSegment'
import translate from './translate'
import undoStack from './undoStack'
import websearch from './websearch'

const logger = loggerService.withContext('Store')

const rootReducer = combineReducers({
  assistants,
  backup,
  nutstore,
  llm,
  settings,
  runtime,
  shortcuts,
  knowledge,
  websearch,
  mcp,
  memory,
  copilot,
  tabs,
  preprocess,
  messages: newMessagesReducer,
  messageBlocks: messageBlocksReducer,
  inputTools: inputToolsReducer,
  translate,
  ocr,
  note,
  clipboard,
  editMode,
  undoStack,
  topicSegments: topicSegment
})

const persistedReducer = persistReducer(
  {
    key: 'cherry-studio',
    storage,
    version: 215,
    blacklist: [
      'runtime',
      'messages',
      'messageBlocks',
      'tabs',
      'toolPermissions',
      'clipboard',
      'editMode',
      'undoStack',
      'topicSegments'
    ],
    migrate
  },
  rootReducer
)

/**
 * Configures the store sync service to synchronize specific state slices across all windows.
 * For detailed implementation, see @renderer/services/StoreSyncService.ts
 *
 * Usage:
 * - 'xxxx/' - Synchronizes the entire state slice
 * - 'xxxx/sliceName' - Synchronizes a specific slice within the state
 *
 * To listen for store changes in a window:
 * Call storeSyncService.subscribe() in the window's entryPoint.tsx
 */
storeSyncService.setOptions({
  syncList: ['assistants/', 'settings/', 'llm/', 'selectionStore/', 'note/', 'topicSegments/']
})

const store = configureStore({
  // @ts-ignore store type is unknown
  reducer: persistedReducer as typeof rootReducer,
  middleware: (getDefaultMiddleware) => {
    return getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER]
      }
    }).concat(storeSyncService.createMiddleware())
  },
  devTools: true
})

export type RootState = ReturnType<typeof rootReducer>
export type AppDispatch = typeof store.dispatch

export const persistor = persistStore(store, undefined, () => {
  // Initialize notes path after rehydration if empty
  const state = store.getState()
  if (!state.note.notesPath) {
    // Use setTimeout to ensure this runs after the store is fully initialized
    setTimeout(async () => {
      try {
        const info = await window.api.getAppInfo()
        store.dispatch(setNotesPath(info.notesPath))
        logger.info('Initialized notes path on startup:', info.notesPath)
      } catch (error) {
        logger.error('Failed to initialize notes path on startup:', error as Error)
      }
    }, 0)
  }

  // LOCK-PROD-6: apply the one-shot L2 navigation projection (idempotent).
  // Runs after Redux rehydration on every startup; a crash before the ack
  // leaves the row pending so the apply retries on the next startup. A
  // failure is logged and the pending row is retained for retry — never a
  // startup blocker. dispatch/flush are injected to keep the apply module
  // free of a static cycle back into this store module.
  void applyPendingImportProjection({ dispatch: store.dispatch, flush: handleSaveData }).catch((error) => {
    logger.error('Failed to apply pending import navigation projection (retained for retry):', error as Error)
  })

  // Notify main process that Redux store is ready
  void window.electron?.ipcRenderer?.invoke(IpcChannel.ReduxStoreReady)
  logger.info('Redux store ready, notified main process')
})

export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
export const useAppStore = useStore.withTypes<typeof store>()
window.store = store

export async function handleSaveData() {
  logger.info('Flushing redux persistor data')
  await persistor.flush()
  logger.info('Flushed redux persistor data')
}

export default store
