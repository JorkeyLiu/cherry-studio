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
import type { Middleware } from '@reduxjs/toolkit'
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { IpcChannel } from '@shared/IpcChannel'
import { useDispatch, useSelector, useStore } from 'react-redux'
import { FLUSH, PAUSE, PERSIST, persistReducer, persistStore, PURGE, REGISTER, REHYDRATE } from 'redux-persist'
import storage from 'redux-persist/lib/storage'

import { setLatestWindowCompleteness } from '../pages/home/Messages/messageWindow'
import * as closureCache from '../services/contextClosure'
import { applyPendingImportProjection } from '../services/importProjection'
import { runReduxStoreBoot } from '../services/importProjectionReadiness'
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
import residentRegistryReducer, { JOINT_PUBLISH_COMPLETE, shouldDiscardJointPublish } from './residentRegistry'
import runtime from './runtime'
import settings from './settings'
import shortcuts from './shortcuts'
import tabs from './tabs'
import topicSegment from './topicSegment'
import translate from './translate'
import undoStack from './undoStack'
import websearch from './websearch'

const logger = loggerService.withContext('Store')

const appReducer = combineReducers({
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
  topicSegments: topicSegment,
  residentRegistry: residentRegistryReducer
})

/**
 * Centralized resident lifecycle invalidation for unpaired segment
 * projection mutations. Distinguishes paired joint publication from standalone
 * changes and respects the local sync follow-up exemption.
 *
 * - Only `resident/jointPublishComplete` may establish or retain residency.
 * - Every unpaired structural segment change must advance generation and make
 *   residentTopic false atomically in the same dispatch.
 * - Inbound StoreSync actions carry `meta.fromSync:true`; they must
 *   invalidate the receiving window's resident claim — fromSync precedence
 *   overrides any joint follow-up flag.
 * - The ONLY local exemption is the exact paired
 *   `topicSegments/replaceSegmentsForTopic` with `meta.isJointFollowUp:true`
 *   and `meta.fromSync:false`, dispatched solely for StoreSync projection
 *   after a paired publish. All other structural action types carrying
 *   `isJointFollowUp` must still invalidate.
 * - Metadata-only `updateSegment` (no `messageIds` in changes) does not affect
 *   structural completeness and is exempt. All other segment membership/
 *   availability mutations are structural.
 */
export function getSegmentAffectedTopicIds(state: any, action: any): string[] | null {
  const type: string = action?.type ?? ''
  if (type === 'topicSegments/addSegment') {
    const tid = action.payload?.topicId
    return typeof tid === 'string' && tid.length > 0 ? [tid] : []
  }
  if (type === 'topicSegments/removeSegment') {
    const segId = action.payload
    if (typeof segId !== 'string') return []
    const seg = state?.topicSegments?.segments?.entities?.[segId]
    if (seg?.topicId) return [seg.topicId]
    return []
  }
  if (type === 'topicSegments/updateSegment') {
    const { id, changes } = action.payload ?? {}
    if (!changes || typeof changes !== 'object') return []
    // Metadata-only (name/color/updatedAt) does not affect membership/availability
    if (!('messageIds' in changes)) return []
    const seg = state?.topicSegments?.segments?.entities?.[id]
    if (seg?.topicId) return [seg.topicId]
    if (typeof changes?.topicId === 'string') return [changes.topicId]
    return []
  }
  if (type === 'topicSegments/loadSegments') {
    const segs = action.payload
    if (!Array.isArray(segs)) return []
    const set = new Set<string>()
    for (const s of segs) if (typeof s?.topicId === 'string') set.add(s.topicId)
    return [...set]
  }
  if (type === 'topicSegments/clearSegmentsForTopic') {
    const tid = action.payload
    return typeof tid === 'string' && tid.length > 0 ? [tid] : []
  }
  if (type === 'topicSegments/replaceSegmentsForTopic') {
    const tid = action.payload?.topicId
    return typeof tid === 'string' && tid.length > 0 ? [tid] : []
  }
  return null
}

export const rootReducer: typeof appReducer = (state, action: any) => {
  if (action?.type === JOINT_PUBLISH_COMPLETE) {
    if (shouldDiscardJointPublish(state, action.payload)) {
      // stale or missing registry entry — discard joint publication atomically
      return state as any
    }
    try {
      const windowResponse = action.payload?.windowResponse
      const topicId = action.payload?.topicId as string
      if (windowResponse?.window) {
        setLatestWindowCompleteness(topicId, {
          hasMoreBefore: !!windowResponse.window.hasMoreBefore,
          hasMoreAfter: !!windowResponse.window.hasMoreAfter
        })
      }
    } catch {
      // best-effort window completeness; never break dispatch
    }
  }

  // Centralized unpaired segment invalidation — capture before
  // projection is mutated so remove/update can resolve topicId from prior state.
  let segmentAffected: string[] | null = null
  let shouldInvalidateSegments = false
  if (typeof action?.type === 'string' && action.type.startsWith('topicSegments/')) {
    const isFromSync = !!action?.meta?.fromSync
    const isJointFollowUp = !!action?.meta?.isJointFollowUp
    const isLocalPairedReplaceFollowUp =
      !isFromSync && isJointFollowUp && action.type === 'topicSegments/replaceSegmentsForTopic'
    if (isLocalPairedReplaceFollowUp) {
      // exact exemption: only local paired replaceSegmentsForTopic follow-up
      segmentAffected = []
    } else {
      const ids = getSegmentAffectedTopicIds(state, action)
      if (ids !== null) {
        segmentAffected = ids
        shouldInvalidateSegments = ids.length > 0
      }
    }
  }

  const nextState = appReducer(state, action)

  if (shouldInvalidateSegments && segmentAffected && segmentAffected.length > 0) {
    try {
      const prevEntries = (nextState as any).residentRegistry?.entries ?? {}
      const newEntries: Record<string, any> = { ...prevEntries }
      for (const tid of segmentAffected) {
        const prev = prevEntries[tid]
        const nextGen = (prev?.applicabilityGeneration ?? 0) + 1
        newEntries[tid] = {
          chatData: false,
          segments: true,
          residentTopic: false,
          applicabilityGeneration: nextGen
        }
      }
      return {
        ...nextState,
        residentRegistry: {
          ...(nextState as any).residentRegistry,
          entries: newEntries
        }
      } as any
    } catch {
      // invalidation is best-effort; never break dispatch
    }
  }

  return nextState
}

const persistedReducer = persistReducer(
  {
    key: 'cherry-studio',
    storage,
    version: 220,
    blacklist: [
      'runtime',
      'messages',
      'messageBlocks',
      'tabs',
      'toolPermissions',
      'clipboard',
      'editMode',
      'undoStack',
      'topicSegments',
      'residentRegistry'
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

/**
 * R-06 closure freshness invalidation middleware.
 * Authoritative renderer publication/mutation paths for messages/blocks bump
 * the per-topic closure generation and invalidate cached closure entries.
 * Conservative: block-only changes invalidate all cached topics (full closure
 * includes blocks); message actions invalidate their topic only.
 * This gives same-length/outside-viewport mutations a generation signal
 * without a new IPC protocol. Generation check before cache publication
 * and before cache use ensures stale data is never claimed.
 */
const closureInvalidationMiddleware: Middleware = () => (next) => (action: any) => {
  const result = next(action)
  try {
    const type = typeof action?.type === 'string' ? (action.type as string) : ''
    if (type.startsWith('newMessages/')) {
      const topicId = action.payload?.topicId as string | undefined
      if (typeof topicId === 'string' && topicId.length > 0) {
        closureCache.bumpAndInvalidate(topicId)
      }
    } else if (type.startsWith('messageBlocks/')) {
      // Block mutations may affect any closure's block association — conservatively invalidate all
      closureCache.bumpAndInvalidateAll()
    }
  } catch {
    // invalidation is best-effort; never break dispatch
  }
  return result
}

const store = configureStore({
  // @ts-ignore store type is unknown
  reducer: persistedReducer as typeof rootReducer,
  middleware: (getDefaultMiddleware) => {
    return getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER]
      }
    })
      .concat(storeSyncService.createMiddleware())
      .concat(closureInvalidationMiddleware)
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

  // The rehydrated store is safely selectable the moment
  // persistStore rehydration completes — signal ReduxStoreReady IMMEDIATELY,
  // independently of the one-shot projection outcome. Main's startup config
  // reads consume config slices (settings/llm) which rehydration already
  // provides; the projection affects navigation/assistants and stays gated
  // by ImportProjectionReadiness below.
  // The ordinary chat tree remains gated on the
  // one-shot L2 navigation projection settlement. runReduxStoreBoot fires the
  // Main notification first, then runImportProjectionBoot settles readiness
  // ONLY when the apply returns applied (true) or verified no-pending
  // (false) without an API failure; on failure the pending row stays unacked
  // (next-startup retry) and the tree stays gated so no stale topic load can
  // run before the imported navigation is projected. dispatch/flush are
  // injected to keep the apply module free of a static cycle back into this
  // store module. The callback stays synchronous — the boot promise is
  // fire-and-forget (no promise is returned to redux-persist); .catch is a
  // defensive guard because runReduxStoreBoot never rejects.
  void runReduxStoreBoot({
    notifyMain: () => {
      // Notify Main right after rehydration — not gated on the
      // projection. ReduxStoreReady means "the rehydrated store is safely
      // selectable".
      void window.electron?.ipcRenderer?.invoke(IpcChannel.ReduxStoreReady)
      logger.info('Redux store rehydrated, notified main process')
    },
    apply: () => applyPendingImportProjection({ dispatch: store.dispatch, flush: handleSaveData })
  }).catch((error) => {
    logger.error('Import projection boot failed unexpectedly (retained for retry):', error as Error)
  })
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
