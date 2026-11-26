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

import { clearCachedContextClosure as clearClosureCache } from '../services/contextClosure'
import * as closureCache from '../services/contextClosure'
import {
  collectFreshTopicTargets,
  configureFreshChatBootstrapFinalizer,
  finalizeFreshChatBootstrap,
  markFreshBootstrapPendingIfFreshProfile,
  runFreshChatBootstrap
} from '../services/freshChatBootstrap'
import storeSyncService from '../services/StoreSyncService'
import assistants from './assistants'
import backup from './backup'
import clipboard from './clipboard'
import {
  AUTHORITY_HANDLED_ACTION_TYPES,
  getClosureTopicIds,
  isAuthorityHandled,
  isClosureReadOnly,
  isExemptContentMirrorAction
} from './closureOwnership'
import editMode from './editMode'
import inputToolsReducer from './inputTools'
import knowledge from './knowledge'
import llm from './llm'
import messageBlocksReducer from './messageBlock'
import migrate from './migrate'
import newMessagesReducer from './newMessage'
import { setNotesPath } from './note'
import note from './note'
import residentRegistryReducer, {
  JOINT_PUBLISH_COMPLETE,
  RETENTION_EVICT,
  SEGMENT_CATALOG_PUBLISH_COMPLETE,
  shouldDiscardJointPublish,
  shouldDiscardSegmentCatalogPublish
} from './residentRegistry'
import runtime from './runtime'
import settings from './settings'
import shortcuts from './shortcuts'
import tabs from './tabs'
import topicBranch, { topicBranchPersistTransform } from './topicBranch'
import topicSegment from './topicSegment'
import translate from './translate'
import undoStack from './undoStack'

const logger = loggerService.withContext('Store')

const appReducer = combineReducers({
  assistants,
  backup,
  llm,
  settings,
  runtime,
  shortcuts,
  knowledge,
  tabs,
  messages: newMessagesReducer,
  messageBlocks: messageBlocksReducer,
  inputTools: inputToolsReducer,
  translate,
  note,
  clipboard,
  editMode,
  undoStack,
  topicBranch,
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
 * - Inbound StoreSync `topicSegments/replaceSegmentsForTopic` with
 *   `meta.fromSync:true` is an authoritative complete catalog: when it is
 *   field-identical (empty-filtered, authority-ordered) to the receiving
 *   projection, the entire receive is a state-identity no-op (no generation
 *   bump, no resident/chatData clearing). When it differs it replaces the
 *   catalog, bumps the affected topic generation, and invalidates
 *   residentTopic/chatData — fromSync precedence overrides any joint
 *   follow-up flag for the differing case.
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

function isTopicSegmentFieldEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (a.id !== b.id || a.topicId !== b.topicId) return false
  if (a.name !== b.name || (a.color ?? null) !== (b.color ?? null)) return false
  if (a.sortOrder !== b.sortOrder || a.firstMessageId !== b.firstMessageId) return false
  if (a.lastMessageId !== b.lastMessageId || a.messageCount !== b.messageCount) return false
  const aIds = Array.isArray(a.messageIds) ? a.messageIds : []
  const bIds = Array.isArray(b.messageIds) ? b.messageIds : []
  if (aIds.length !== bIds.length) return false
  for (let i = 0; i < aIds.length; i++) {
    if (aIds[i] !== bIds[i]) return false
  }
  return true
}

/**
 * Complete-catalog equality: true when the incoming `replaceSegmentsForTopic`
 * segment catalog is field-identical (order-sensitive, authority fields +
 * membership) to the current projection for the topic. Order follows the stored
 * authority order; incoming is compared in the authority (sortOrder, id) order
 * the slice would store. Reused for both the local joint follow-up dedup and
 * the inbound StoreSync identical-receive no-op. Only the authoritative
 * replacement shape is compared here; add/update/remove are never treated as
 * complete catalogs.
 */
function areJointSegmentsIdentical(state: any, topicId: string, incoming: any[]): boolean {
  try {
    const ids: string[] = state?.topicSegments?.segmentsByTopic?.[topicId] ?? []
    const entities = state?.topicSegments?.segments?.entities ?? {}
    const current = ids.map((id) => entities[id]).filter(Boolean)
    const orderedIncoming = [...incoming].sort((x: any, y: any) => {
      const ax = typeof x?.sortOrder === 'number' && Number.isFinite(x.sortOrder) ? x.sortOrder : Infinity
      const bx = typeof y?.sortOrder === 'number' && Number.isFinite(y.sortOrder) ? y.sortOrder : Infinity
      if (ax !== bx) return ax - bx
      const ai = typeof x?.id === 'string' ? x.id : ''
      const bi = typeof y?.id === 'string' ? y.id : ''
      return ai < bi ? -1 : ai > bi ? 1 : 0
    })
    // Empty readbacks never store phantoms — both sides filter empties before comparing.
    // Mirrors topicSegment isEmptySegment (messageCount/messageIds/first/last).
    const isEmpty = (s: any) =>
      !s ||
      s.messageCount === 0 ||
      !Array.isArray(s.messageIds) ||
      s.messageIds.length === 0 ||
      s.firstMessageId === null ||
      s.lastMessageId === null
    const currentNonEmpty = current.filter((s) => !isEmpty(s))
    const incomingNonEmpty = orderedIncoming.filter((s) => !isEmpty(s))
    if (currentNonEmpty.length !== incomingNonEmpty.length) return false
    for (let i = 0; i < currentNonEmpty.length; i++) {
      if (!isTopicSegmentFieldEqual(currentNonEmpty[i], incomingNonEmpty[i])) return false
    }
    return true
  } catch {
    return false
  }
}

export const rootReducer: typeof appReducer = (state, action: any) => {
  if (action?.type === JOINT_PUBLISH_COMPLETE) {
    if (shouldDiscardJointPublish(state, action.payload)) {
      // Stale or missing registry entry — discard joint publication atomically.
      // The retained read-window boundary rides this same publication (written by
      // the resident-registry slice only after the generation guard passed), so a
      // discard leaves the projection state untouched.
      return state as any
    }
  }

  // Segment-only catalog publication: atomic authority install that preserves
  // the resident message window. Stale/evicted/switched/mismatched payloads
  // discard with no catalog install and no residency restore (fail closed).
  // Raw unpaired/fromSync structural actions below keep invalidating.
  if (action?.type === SEGMENT_CATALOG_PUBLISH_COMPLETE) {
    if (shouldDiscardSegmentCatalogPublish(state, action.payload)) {
      return state as any
    }
  }

  // Identical complete-catalog receive no-op (before any segment side effects,
  // generation bump, or resident/chatData clearing).
  // - Local paired joint follow-up (!fromSync + isJointFollowUp) identical to the
  //   just-published joint state must not commit a second local segment state.
  //   The follow-up still flows through the StoreSync middleware (which broadcasts
  //   after next), so other windows receive it as fromSync; only the originating
  //   window skips the local apply. Broadcast is never gated by this guard.
  // - Inbound StoreSync replacement (fromSync, with or without isJointFollowUp)
  //   identical to the receiving projection is a full state-identity no-op.
  // Only the authoritative `replaceSegmentsForTopic` shape is compared; local
  // standalone replaces (neither flag) still apply even when identical.
  if (action?.type === 'topicSegments/replaceSegmentsForTopic') {
    const isFromSync = !!action?.meta?.fromSync
    const isJointFollowUp = !!action?.meta?.isJointFollowUp
    const isDeletePairedFollowUp = !!action?.meta?.isDeletePairedFollowUp
    if (isFromSync || isJointFollowUp || isDeletePairedFollowUp) {
      const tid = action?.payload?.topicId
      const incoming = action?.payload?.segments
      if (typeof tid === 'string' && Array.isArray(incoming) && areJointSegmentsIdentical(state, tid, incoming)) {
        return state as any
      }
    }
  }

  // Retention eviction: atomically remove exclusive blocks with full cross-slice visibility
  // and clear window/closure side-effects in the same dispatch. This is the dedicated
  // retention generation path, distinct from deletion generation.
  if (action?.type === RETENTION_EVICT) {
    const topicId = action.payload as string
    // Capture prev block ownership before reducer clears messages
    const prevMessageIds: string[] = (state as any)?.messages?.messageIdsByTopic?.[topicId] ?? []
    const prevEntities = (state as any)?.messages?.entities ?? {}
    const prevBlockEntities = (state as any)?.messageBlocks?.entities ?? {}
    const nextStatePre = appReducer(state, action)

    // Best-effort closure-cache clear (Map outside Redux) — same dispatch
    // atomicity. The retained read-window boundary is cleared by the retention
    // action's own slice reducer, never from here.
    try {
      clearClosureCache(topicId)
    } catch {}

    // Exclusive blocks: remove only blocks whose messageId belongs to evicted topic and not shared elsewhere
    try {
      const nextMessageIdsByTopic = (nextStatePre as any)?.messages?.messageIdsByTopic ?? {}
      const nextEntities = (nextStatePre as any)?.messages?.entities ?? {}
      const nextBlockEntities = (nextStatePre as any)?.messageBlocks?.entities ?? {}

      // Build set of blockIds still referenced by surviving topics
      const otherTopicBlockIds = new Set<string>()
      const survivingMessageIds = new Set<string>()
      for (const [tid, mids] of Object.entries(nextMessageIdsByTopic as Record<string, string[]>)) {
        if (tid === topicId) continue
        for (const mid of mids) {
          survivingMessageIds.add(mid)
          const msg = nextEntities[mid] ?? prevEntities[mid]
          // Prefer nextEntities but fallback to prev for orphan detection
          const blocks = msg?.blocks as string[] | undefined
          if (Array.isArray(blocks)) {
            for (const bid of blocks) otherTopicBlockIds.add(bid)
          }
        }
      }
      // Orphan blocks for surviving topics (partial projection)
      for (const block of Object.values(nextBlockEntities as Record<string, any>)) {
        if (block && typeof block.messageId === 'string' && survivingMessageIds.has(block.messageId)) {
          otherTopicBlockIds.add(block.id)
        }
      }

      // Collect evicted blockIds
      const evictedBlockIds: string[] = []
      for (const mid of prevMessageIds) {
        const msg = prevEntities[mid]
        if (msg?.blocks) evictedBlockIds.push(...(msg.blocks as string[]))
      }
      // Orphan blocks whose messageId is in evicted messageIds
      const evictedSet = new Set(prevMessageIds)
      for (const block of Object.values(prevBlockEntities as Record<string, any>)) {
        if (block && typeof block.messageId === 'string' && evictedSet.has(block.messageId)) {
          evictedBlockIds.push(block.id)
        }
      }
      const exclusive = [...new Set(evictedBlockIds)].filter((bid) => !otherTopicBlockIds.has(bid))
      if (exclusive.length > 0) {
        const curEntities = (nextStatePre as any).messageBlocks.entities
        const curIds = (nextStatePre as any).messageBlocks.ids as string[]
        const newEntities = { ...curEntities }
        for (const bid of exclusive) delete newEntities[bid]
        const newIds = curIds.filter((id) => !exclusive.includes(id))
        return {
          ...nextStatePre,
          messageBlocks: {
            ...(nextStatePre as any).messageBlocks,
            entities: newEntities,
            ids: newIds
          }
        } as any
      }
    } catch {
      // best-effort exclusive removal
    }
    return nextStatePre as any
  }

  // Route rebase: atomically drop blocks exclusive to the old route in the
  // same dispatch (full cross-slice visibility). Messages slice already
  // removed old-exclusive message entities; here we remove blocks referenced
  // only by those removed messages and not by the new route or any other
  // topic, so stale blocks cannot leak via direct block-ID selectors and
  // block memory stays bounded. Stable-ID reuse preserved:
  // blocks referenced by the new route are never removed.
  // Tree clipboard projection commits belong to the same family: their
  // in-place removals must drop blocks exclusive to the removed rows in the
  // same dispatch, exactly like a route rebase or a window merge.
  if (
    action?.type === 'newMessages/rebaseRouteMessages' ||
    action?.type === 'newMessages/messagesWindowMerged' ||
    action?.type === 'newMessages/applyClipboardTreeProjection'
  ) {
    const topicId = (action.payload as { topicId?: string })?.topicId
    if (typeof topicId === 'string' && topicId.length > 0) {
      const prevMessageIds: string[] = (state as any)?.messages?.messageIdsByTopic?.[topicId] ?? []
      const prevEntities = (state as any)?.messages?.entities ?? {}
      const prevBlockEntities = (state as any)?.messageBlocks?.entities ?? {}
      const nextStatePre = appReducer(state, action)
      try {
        const nextIds: string[] = (nextStatePre as any)?.messages?.messageIdsByTopic?.[topicId] ?? []
        const nextSet = new Set(nextIds)
        const removedIds = prevMessageIds.filter((id) => !nextSet.has(id))
        if (removedIds.length === 0) return nextStatePre as any
        // Blocks still referenced by the new route or other topics survive.
        const liveBlockIds = new Set<string>()
        const nextEntities = (nextStatePre as any)?.messages?.entities ?? {}
        const nextIdsByTopic = (nextStatePre as any)?.messages?.messageIdsByTopic ?? {}
        for (const ids of Object.values(nextIdsByTopic as Record<string, string[]>)) {
          for (const mid of ids) {
            const msg = nextEntities[mid]
            if (Array.isArray(msg?.blocks)) for (const bid of msg.blocks as string[]) liveBlockIds.add(bid)
          }
        }
        for (const block of Object.values((nextStatePre as any)?.messageBlocks?.entities ?? {}) as Array<any>) {
          if (block && typeof block.messageId === 'string' && nextSet.has(block.messageId)) {
            liveBlockIds.add(block.id)
          }
        }
        const removedSet = new Set(removedIds)
        const candidates = new Set<string>()
        for (const mid of removedIds) {
          const msg = prevEntities[mid]
          if (msg && Array.isArray(msg.blocks)) for (const bid of msg.blocks as string[]) candidates.add(bid)
        }
        for (const block of Object.values(prevBlockEntities as Record<string, any>)) {
          if (block && typeof block.messageId === 'string' && removedSet.has(block.messageId)) {
            candidates.add(block.id)
          }
        }
        const exclusive = [...candidates].filter((bid) => !liveBlockIds.has(bid))
        if (exclusive.length === 0) return nextStatePre as any
        const curEntities = (nextStatePre as any).messageBlocks.entities
        const curIds = (nextStatePre as any).messageBlocks.ids as string[]
        const newEntities = { ...curEntities }
        for (const bid of exclusive) delete newEntities[bid]
        const newIds = curIds.filter((id) => !exclusive.includes(id))
        return {
          ...nextStatePre,
          messageBlocks: {
            ...(nextStatePre as any).messageBlocks,
            entities: newEntities,
            ids: newIds
          }
        } as any
      } catch {
        return nextStatePre as any
      }
    }
  }

  // Centralized unpaired segment invalidation — capture before
  // projection is mutated so remove/update can resolve topicId from prior state.
  let segmentAffected: string[] | null = null
  let shouldInvalidateSegments = false
  if (typeof action?.type === 'string' && action.type.startsWith('topicSegments/')) {
    const isFromSync = !!action?.meta?.fromSync
    const isJointFollowUp = !!action?.meta?.isJointFollowUp
    const isDeletePairedFollowUp = !!action?.meta?.isDeletePairedFollowUp
    const isLocalPairedReplaceFollowUp =
      !isFromSync &&
      (isJointFollowUp || isDeletePairedFollowUp) &&
      action.type === 'topicSegments/replaceSegmentsForTopic'
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
          applicabilityGeneration: nextGen,
          // Unpaired segment invalidation fences residency only: the retained
          // read-window boundary is not a segment fact and survives it.
          ...(prev?.windowCompleteness ? { windowCompleteness: prev.windowCompleteness } : {})
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

const persistedReducer = persistReducer<RootState>(
  {
    key: 'cherry-studio',
    storage,
    version: 230,
    transforms: [topicBranchPersistTransform],
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
 * R-06 closure freshness invalidation middleware (Task A: topic-scoped).
 * Genuine semantic mutations bump the per-topic closure generation and
 * invalidate cached closure entries. Full-route authoritative counts are
 * independent of the currently loaded viewport: pure latest/around/load-more
 * read publications never invalidate.
 *
 * - `newMessages/*` genuine mutations invalidate their payload topic only.
 *   Explicitly enumerated read-only projection publications never invalidate:
 *   `rebaseRouteMessages` / `messagesWindowMerged` / `messagesReceived`
 *   (Main window reads), lifecycle markers (`setCurrentTopicId`,
 *   `setTopicLoading` (generation busy), `registerWindowRead` /
 *   `completeWindowRead` / `clearWindowReads` (window-read busy),
 *   `setTopicFulfilled`, `setDisplayCount`), and
 *   capability maintenance (`mergeRouteMutability`, `pruneRouteMutability`,
 *   `invalidateRouteMutability`). Unknown `newMessages/*` types keep the safe
 *   default (invalidate).
 * - `messageBlocks/*` CONTENT mutations consume ONLY the explicit trustworthy
 *   topic ownership in `action.meta.closureTopicIds` (see `withClosureTopics`
 *   in store/closureOwnership.ts): one/many unique topics -> `bumpAndInvalidate`
 *   each; absent/invalid/explicit-unknown -> `bumpAndInvalidateAll` (deliberate
 *   global fallback). Ownership is never inferred from Redux entities or
 *   (`meta.closureReadOnly`, see `markClosureReadOnly`) — Main window block
 *   hydration and other read-only joint publications for the same topic —
 *   never invalidate structurally (read-only still advances no generation).
 *   Safe default: absent marker means mutate (invalidate).
 * - Trusted streaming content mirrors (`meta.closureContentMirror`, see
 *   `markClosureContentMirror` + `isExemptContentMirrorAction`) for exactly
 *   `messageBlocks/updateOneBlock` with content-only non-terminal patches
 *   are a closure-freshness no-op: the reducer already applied the patch
 *   (store/UI filter and token estimate stay real-time) but the middleware
 *   neither clears the structural cache nor emits the semantic signal, so
 *   continuous same-block text deltas never invalidate structure. Streaming
 *   bodies reach the UI context projection through the execution-owned
 *   overlay. New blocks/upserts/removes/type transitions/terminal
 *   status/unknown keys/unscoped actions fail closed to structural
 *   invalidation even with the marker. Cached `blocks` bytes are never
 *   authoritative fresh bodies.
 * - `messageBlocks/setMessageBlocksLoading|setMessageBlocksError` are not
 *   block-content mutations and never invalidate.
 * - `resident/jointPublishComplete`, `residentRegistry/*`, `retention/*` are
 *   read/projection lifecycle and never invalidate semantic context.
 * This gives same-length/outside-viewport mutations a generation signal
 * without a new IPC protocol. Generation check before cache publication
 * and before cache use ensures stale data is never claimed.
 */
const READONLY_NEW_MESSAGES_TYPES = new Set([
  'newMessages/rebaseRouteMessages',
  'newMessages/messagesWindowMerged',
  'newMessages/messagesReceived',
  'newMessages/setCurrentTopicId',
  'newMessages/setTopicLoading',
  'newMessages/registerWindowRead',
  'newMessages/completeWindowRead',
  'newMessages/clearWindowReads',
  'newMessages/setTopicFulfilled',
  'newMessages/setDisplayCount',
  'newMessages/mergeRouteMutability',
  'newMessages/pruneRouteMutability',
  'newMessages/invalidateRouteMutability'
])
export const closureInvalidationMiddleware: Middleware = () => (next) => (action: any) => {
  const result = next(action)
  try {
    const type = typeof action?.type === 'string' ? (action.type as string) : ''
    if (!type) return result
    // Trusted streaming content mirror: content-only existing-block patch.
    // No-op for closure freshness: the store update is already applied (the
    // reducer ran before the middleware), so UI/store subscribers still
    // observe the new text in real time — but structure is never invalidated,
    // no generation advances, and no signal is emitted (no refetch).
    // Central predicate owns the rule; unmarked/unknown still invalidates.
    if (isExemptContentMirrorAction(action)) return result
    // Explicit authoritative read-only hydration/publication never invalidates,
    // regardless of slice. Only read sites set this marker.
    if (isClosureReadOnly(action)) return result
    // Same-ack authority-handled projection convergence: the ack's consume
    // helper already bumped before this dispatch, so the middleware must not
    // infer a second invalidation. Renderer-internal marker only; family-gated
    // so a stray marker on any other type fails closed to inference below.
    // Unmarked actions keep today's fail-closed behavior.
    if (isAuthorityHandled(action) && AUTHORITY_HANDLED_ACTION_TYPES.has(type)) return result
    if (
      type === 'resident/jointPublishComplete' ||
      type === SEGMENT_CATALOG_PUBLISH_COMPLETE ||
      type.startsWith('residentRegistry/') ||
      type.startsWith('retention/')
    ) {
      return result
    }
    if (type.startsWith('newMessages/')) {
      if (READONLY_NEW_MESSAGES_TYPES.has(type)) return result
      const topicId = action.payload?.topicId as string | undefined
      if (typeof topicId === 'string' && topicId.length > 0) {
        closureCache.bumpAndInvalidate(topicId)
      }
    } else if (type.startsWith('messageBlocks/')) {
      if (type === 'messageBlocks/setMessageBlocksLoading' || type === 'messageBlocks/setMessageBlocksError') {
        // Loading/error markers are not block-content mutations: no invalidation.
      } else {
        const topicIds = getClosureTopicIds(action)
        if (topicIds === null) {
          // Unknown/unreliable ownership: deliberate global fallback.
          closureCache.bumpAndInvalidateAll()
        } else {
          for (const topicId of topicIds) {
            closureCache.bumpAndInvalidate(topicId)
          }
        }
      }
    }
  } catch {
    // invalidation is best-effort; never break dispatch
  }
  return result
}

// Fresh-chat bootstrap pending marker: set synchronously here at module
// evaluation when the persist compatibility key is absent — before
// redux-persist can write for this boot. Outside the Redux persist payload,
// so it survives ensure failure and renderer restart; cleared only by
// the boot finalizer. Lifecycle contract in `freshChatBootstrap`.
markFreshBootstrapPendingIfFreshProfile()

/**
 * Finalize a fresh-chat bootstrap after rehydration.
 *
 * With a pending marker, ensure every current initial topic create-only
 * (Main-side ensure never overwrites an existing binding, so partial ensures
 * and retries are safe), then clear the marker. A rejection retains the
 * marker for next-boot/retry. Without a marker, nothing is touched. Dynamic
 * import keeps the store free of a static cycle into the SQLite lifecycle
 * module.
 */
async function finalizeFreshChatBootstrapForBoot() {
  return finalizeFreshChatBootstrap({
    collectTargets: () => collectFreshTopicTargets(store.getState().assistants?.assistants ?? []),
    ensureTopic: async (target) => {
      const { ensureOrdinaryTopicOwnership } = await import('../services/db/topicTrashLifecycle')
      await ensureOrdinaryTopicOwnership(target.id, target.assistantId, target.name ?? null)
    }
  })
}

configureFreshChatBootstrapFinalizer(finalizeFreshChatBootstrapForBoot)

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
  // persistStore rehydration completes. Notify Main immediately: its startup
  // config reads consume config slices that rehydration already provides.
  void window.electron?.ipcRenderer?.invoke(IpcChannel.ReduxStoreReady)
  logger.info('Redux store rehydrated, notified main process')

  // Fresh-profile bootstrapping shares one readiness promise with the UI retry
  // surface. Start it only after the immediate Main notification; the ordinary
  // chat tree stays unmounted until this promise settles successfully.
  void runFreshChatBootstrap()
    .then(() => {
      // Baseline for the "by update time" policy (the default) and the one-time
      // default application for assistants that never chose an order: one batch
      // read of the enabled assistants' topics after rehydration, followed by
      // the single default sort of the undecided assistants' non-pinned topics.
      // After that, only a topic whose latest message instant really changed
      // moves. Dynamic import keeps the store free of a static cycle into the
      // ordering service (which reads the store).
      void import('../services/topicMessageTimes')
        .then(async (module) => {
          await module.primeTopicMessageTimesBaseline()
          await module.initializeTopicOrderDefaults()
        })
        .catch((error) => {
          // Recoverable by design: a failed baseline fabricates nothing, moves
          // nothing, and the next observation retries it (the read itself logs
          // its own failure). A failed default initialization leaves the
          // assistant undecided, so the next boot retries it. Only an
          // unexpected throw reaches this guard.
          logger.debug('Topic message-time baseline priming failed (next observation retries):', error as Error)
        })
    })
    .catch((error) => {
      logger.error('Fresh-chat bootstrap failed unexpectedly (retained for retry):', error as Error)
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
