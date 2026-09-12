/**
 * ChatDbAggregateService — implements the complete typed ChatDb command
 * surface (the `ChatDb_*` IPC channels map 1:1 onto its capabilities).
 *
 * Combines the five repositories (topics, messages, blocks,
 * topic_segments, file_references) into a single service that the IPC
 * handlers delegate to.
 *
 * Transaction strategy:
 * - Compound commands create repositories from tx inside root db.transaction().
 * - All repositories in a compound mutation are tx-bound (not root-bound).
 * - Existing nested repository transactions use Drizzle savepoints.
 * - All synchronous work stays within better-sqlite3 transactions; no await.
 * - No per-call SQLite→Dexie fallback.
 * - No implicit init. DB must be initialised before calling any command.
 *
 * SQLite (Data/chat.db) is authoritative for ordinary chat.
 * updateFileCount(s) stays in Dexie/FileManager; not called here.
 */

import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import type {
  AppendDiagnostics,
  EmptyTrashTopicsResponse,
  FetchAnswerGroupRequest,
  FetchAnswerGroupResponse,
  FetchContextClosureRequest,
  FetchContextClosureResponse,
  FetchMessagesWindowRequest,
  FetchMessagesWindowResponse,
  FileCleanupResult,
  FileReferenceWire,
  HardDeleteTopicResponse,
  JsonObject,
  PurgeExpiredTopicsResponse,
  ResetAssistantTopicsResponse,
  SegmentWire,
  StreamWriteDiagnostics,
  TopicWire
} from '@shared/chatDb'
import type { ChatDbResult } from '@shared/chatDb'
import type { SearchMessagesRequest, SearchMessagesResponse } from '@shared/chatDb'
import { elapsedMs, MAX_APPEND_DIAGNOSTIC_LOGS } from '@shared/diagnostics/sendTiming'
import { isStableBlockStatus, isStableMessageStatus, isUnsupportedBlockForSync } from '@shared/sync'
import type Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { logMainDiagnostic } from '../diagnostics'
import { isPhaseAttrMainEnabled, recordMainPhaseDuration } from '../phaseTimingDiagnostics'
import { spanCacheService } from '../SpanCacheService'
import { SyncFrameError, syncService, type SyncTxExecutor } from '../sync/SyncService'
import type { FileReferenceData, MessageBlockData, MessageData, TopicData } from './domain/types'
import { ChatDbConflictError, ChatDbNotFoundError, ChatDbValidationError, wrapResult } from './errors'
import type { ChatDbRepositories } from './repository/factory'
import { createRepositories } from './repository/factory'
import { SearchRepository } from './repository/SearchRepository'
import * as schema from './schema'
import { isStreamAttrMeasureEnabled, recordStreamAttrRecord } from './streamingMeasure'
import { computeTrashRetentionDecision, parseStrictCanonicalIsoMs } from './trashRetention'
import {
  blocksToWire,
  buildFileCleanupResult,
  collectAffectedFileIds,
  fileReferenceToWire,
  messagesToWire,
  projectFileReferences,
  reconstructMessageBlockRelations,
  segmentToWire,
  topicToWireFull,
  wireToBlock,
  wireToBlockPatch,
  wireToMessage,
  wireToMessagePatch
} from './wireAdapters'

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type FetchMessagesResult = { messages: JsonObject[]; blocks: JsonObject[] }
export type FetchMessagesWindowResult = FetchMessagesWindowResponse
export type FetchAnswerGroupResult = FetchAnswerGroupResponse
export type FetchContextClosureResult = FetchContextClosureResponse
export type GetRawTopicResult = { id: string; messages: JsonObject[] } | null

// ---------------------------------------------------------------------------
// ChatDbAggregateService
// ---------------------------------------------------------------------------

export class ChatDbAggregateService {
  constructor(
    private db: BetterSQLite3Database<typeof schema>,
    private sqlite?: Database.Database
  ) {}

  /**
   * Create repositories bound to the root database.
   * Only for read-only or single-statement commands.
   */
  private repos(): ChatDbRepositories {
    return createRepositories(this.db)
  }

  // =========================================================================
  // Transaction-bound sync capture (LOCK-PERSONAL-005/006/010)
  //
  // Supported stable mutations enqueue their sync intent INSIDE the same
  // aggregate Drizzle transaction via SyncService tx-bound helpers (no nested
  // BEGIN). A throw rolls back the enclosing mutation — a committed row
  // without durable outbox intent is impossible. Updates carry only
  // intentional changed allowlisted fields + identity/immutable relation
  // fields (never sortOrder); creates carry the full allowlisted set.
  // After a successful commit the caller wakes automation via notifyEnqueued.
  // =========================================================================

  // =========================================================================
  // Publisher-barrier quiescence gate (SYNC-DATA-026)
  //
  // While SyncService holds the publish barrier, every public aggregate
  // mutation fails here — inside wrapResult so callers observe a truthful
  // failure envelope — before any SQLite transaction opens. Chat rows and
  // outbox intent therefore cannot commit under the barrier (the enclosing
  // aggregate transaction never starts; tx-owned capture is never reached).
  // Remote pull/apply internal writes never enter the aggregate. Supported
  // tx-owned methods reach this gate through syncCtx(); all other mutating
  // methods call it explicitly at entry. Reads never call it.
  // =========================================================================

  /**
   * Capture context acquired OUTSIDE the aggregate tx (deviceId setup is
   * idempotent). Fail-closed (LOCK-PERSONAL-006): when capture is enabled, an
   * infrastructure failure acquiring the context throws (rolls back the
   * enclosing mutation) instead of silently skipping capture (no silent loss).
   * Disabled capture returns null (no intent). Callers record a durable
   * visible capture failure outside the rolled-back tx before propagating.
   *
   * Publisher-barrier quiescence (SYNC-DATA-026) is enforced first: a held
   * barrier throws SyncPublishBarrierError before any transaction opens.
   */
  private syncCtx(channel = 'chatDb'): { deviceId: string; ts: number } | null {
    syncService.throwIfPublishBarrierHeld(channel)
    let enabled = false
    try {
      enabled = syncService.isCaptureEnabled()
    } catch (e) {
      // Cannot prove disabled: fail closed with a durable record, then throw.
      // A capture-error persistence failure (SyncCaptureError) preserves the
      // original message and propagates instead of being swallowed.
      try {
        syncService.recordCaptureFailure(channel, e)
      } catch (secondary) {
        throw secondary instanceof Error ? secondary : new Error(String(secondary))
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
    if (!enabled) return null
    try {
      // Fail closed (LOCK-PERSONAL-001/006): getDeviceId throws on any
      // infrastructure failure (except proven pre-005 compatibility), so an
      // enabled mutation cannot commit without durable device identity.
      return { deviceId: syncService.getDeviceId(), ts: Date.now() }
    } catch (e) {
      try {
        syncService.recordCaptureFailure(channel, e)
      } catch (secondary) {
        throw secondary instanceof Error ? secondary : new Error(String(secondary))
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** True for domain rejections that must never become capture failures. */
  private isDomainRejection(e: unknown): boolean {
    const name = e instanceof Error ? e.constructor.name : ''
    return (
      name === 'ChatDbConflictError' ||
      name === 'ChatDbNotFoundError' ||
      name === 'ChatDbValidationError' ||
      (e instanceof Error && /belongs to topic|cannot reparent|Duplicate block ID/.test(e.message))
    )
  }

  /**
   * Durable capture-failure record OUTSIDE a rolled-back aggregate tx
   * (LOCK-PERSONAL-006/009): the chat mutation is already rolled back (no
   * chat change committed); the sync_state failure write runs on the live
   * connection outside that tx so it survives. Never throws. Skips domain
   * rejections (foreign/no-op validation) which are not capture failures.
   */
  private recordSyncTxFailure(channel: string, ctx: { deviceId: string; ts: number } | null, e: unknown): void {
    if (!ctx) return
    if (this.isDomainRejection(e)) return
    // Outside the rolled-back tx so the record survives. A persistence
    // failure (SyncCaptureError, already carrying the original message) is
    // logged and propagated — never swallowed — while the caller still throws
    // so the rolled-back mutation never appears committed.
    try {
      syncService.recordCaptureFailure(channel, e)
    } catch (secondary) {
      const detail = secondary instanceof Error ? secondary.message : String(secondary)
      loggerService
        .withContext('ChatDbAggregate')
        .error(`[recordSyncTxFailure] ${channel} persistence failed: ${detail}`)
      throw secondary instanceof Error ? secondary : new Error(String(secondary))
    }
  }

  private syncTopicPayload(data: TopicData): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      id: data.id,
      name: data.name,
      assistantId: data.assistantId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      deletedAt: data.deletedAt
    }
    for (const k of ['pinned', 'prompt', 'isNameManuallyEdited'] as const) {
      if (Object.prototype.hasOwnProperty.call(data.overflow ?? {}, k)) {
        const v = data.overflow[k]
        if (v !== undefined) payload[k] = v
      }
    }
    return payload
  }

  private syncMessagePayloadFull(data: MessageData): Record<string, unknown> {
    return {
      id: data.id,
      topicId: data.topicId,
      role: data.role,
      content: data.content,
      status: data.status,
      askId: data.askId,
      model: data.model,
      modelId: data.modelId,
      assistantId: data.assistantId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      sortOrder: data.sortOrder
    }
  }

  private syncBlockPayloadFull(data: MessageBlockData): Record<string, unknown> {
    return {
      id: data.id,
      messageId: data.messageId,
      type: data.type,
      content: data.content,
      status: data.status,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      sortOrder: data.sortOrder
    }
  }

  /** Intentional message patch → sync field patch (allowlisted only, never identity/sortOrder). */
  private syncMessagePatchPayload(
    topicId: string,
    messageId: string,
    patch: Record<string, unknown>
  ): Record<string, unknown> | null {
    const allow = new Set([
      'role',
      'content',
      'status',
      'askId',
      'model',
      'modelId',
      'assistantId',
      'createdAt',
      'updatedAt'
    ])
    const out: Record<string, unknown> = { id: messageId, topicId }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'overflow' || k === 'id' || k === 'topicId' || k === 'sortOrder') continue
      if (!allow.has(k)) continue
      if (v !== undefined) out[k] = v
    }
    return Object.keys(out).length > 2 ? out : null
  }

  /** Intentional block patch → sync field patch (allowlisted only, never identity/sortOrder). */
  private syncBlockPatchPayload(
    messageId: string,
    blockId: string,
    patch: Record<string, unknown>
  ): Record<string, unknown> | null {
    const allow = new Set(['type', 'content', 'status', 'createdAt', 'updatedAt'])
    const out: Record<string, unknown> = { id: blockId, messageId }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'overflow' || k === 'id' || k === 'messageId' || k === 'sortOrder') continue
      if (!allow.has(k)) continue
      if (v !== undefined) out[k] = v
    }
    return Object.keys(out).length > 2 ? out : null
  }

  /**
   * Direct parent closure inside the aggregate tx (bounded to the direct
   * chain block→message→topic). Untracked but locally present parents are
   * captured first with strictly earlier timestamps. Throws fail-closed when
   * a required parent row is missing (rolls back the mutation).
   */
  private ensureTopicClosureInTx(tx: SyncTxExecutor, topicId: string, childTs: number, deviceId: string): void {
    if (syncService.isTrackedEntityInTx(tx, 'topic', topicId)) return
    const repos = createRepositories(tx as unknown as BetterSQLite3Database<typeof schema>)
    const found = repos.topics.getById(topicId)
    if (!found.found) throw new Error(`sync closure: topic ${topicId} missing in transaction`)
    syncService.enqueueUpsertInTx(
      tx,
      'topic',
      topicId,
      this.syncTopicPayload(found.data),
      Math.max(0, childTs - 2),
      deviceId
    )
  }

  private ensureMessageClosureInTx(tx: SyncTxExecutor, messageId: string, childTs: number, deviceId: string): void {
    const repos = createRepositories(tx as unknown as BetterSQLite3Database<typeof schema>)
    const mrow = repos.messages.getById(messageId)
    if (!mrow.found) throw new Error(`sync closure: message ${messageId} missing in transaction`)
    const topicId = mrow.data.topicId
    if (!topicId) throw new Error(`sync closure: message ${messageId} has no topic`)
    this.ensureTopicClosureInTx(tx, topicId, childTs, deviceId)
    if (syncService.isTrackedEntityInTx(tx, 'message', messageId)) return
    // Stable-checkpoint gate (LOCK-PERSONAL-004): a transient assistant
    // parent (streaming/pending/processing/searching) must never be emitted
    // through child closure. Fail closed — the enclosing mutation rolls back
    // with a durable capture failure and is deferred until the parent reaches
    // a stable checkpoint; the transient row itself is never synced and the
    // child emits nothing (no cursor poisoning: no outbox row is written).
    const full = repos.messages.getById(messageId)
    if (!full.found) throw new Error(`sync closure: message ${messageId} missing in transaction`)
    if (!isStableMessageStatus(full.data.status)) {
      throw new Error(`sync closure: parent message ${messageId} transient (${String(full.data.status)}), defer`)
    }
    // Closure emits a snapshot for field-clock sync only; it must never
    // fabricate a parent-membership clock for a pre-existing untracked parent.
    // Only a row inserted by the SAME current aggregate transaction with a real
    // creation operation may get membership (see appendMessage/bulkAddBlocks).
    syncService.enqueueUpsertInTx(
      tx,
      'message',
      messageId,
      this.syncMessagePayloadFull(full.data),
      Math.max(0, childTs - 1),
      deviceId
    )
  }

  private ensureBlockParentClosureInTx(tx: SyncTxExecutor, blockId: string, childTs: number, deviceId: string): void {
    const repos = createRepositories(tx as unknown as BetterSQLite3Database<typeof schema>)
    const brow = repos.blocks.getById(blockId)
    if (!brow.found) throw new Error(`sync closure: block ${blockId} missing in transaction`)
    this.ensureMessageClosureInTx(tx, brow.data.messageId, childTs, deviceId)
  }

  /**
   * Unsupported structured/attachment-bearing block gate (LOCK-PERSONAL-004).
   * A block whose canonical content lives in overflow (or whose type carries
   * binary/structured canonical payload) is not fully representable in the
   * allowlisted sync payload and must never emit a partial null-content
   * shell. Returns true when the block must be skipped for sync (caller
   * records a durable explicit unsupported outcome; no outbox row is
   * written). Ordinary text blocks return false and keep syncing.
   * No-op/foreign rows never reach this predicate (callers handle those as
   * non-errors first).
   */
  private isUnsupportedBlock(data: MessageBlockData): boolean {
    return isUnsupportedBlockForSync({ type: data.type, overflow: data.overflow })
  }

  /**
   * Durable explicit unsupported-block outcome after a successful chat commit
   * (LOCK-PERSONAL-004/006/009): the chat mutation stays committed; no
   * partial outbox row was written; the skip is recorded via the existing
   * capture-error mechanism (sync_state lastCaptureError + lastError) so it
   * cannot disappear silently. Never throws: a persistence failure is logged
   * (fail-closed observable) without rewriting the committed chat result.
   */
  private recordUnsupportedBlocksAfterCommit(channel: string, blockIds: ReadonlyArray<string>): void {
    if (blockIds.length === 0) return
    const ids = [...new Set(blockIds)].slice(0, 5).join(',')
    try {
      syncService.recordCaptureFailure(
        channel,
        new Error(`unsupported block(s) not representable for sync, skipped without partial payload: ${ids}`)
      )
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      loggerService
        .withContext('ChatDbAggregate')
        .error(`[unsupportedBlock] ${channel} capture-error persistence failed: ${detail}`)
    }
  }

  /**
   * Stable-promotion descendant backfill (LOCK-PERSONAL-004): when a transient
   * parent becomes stable, every committed stable block descendant that was
   * never tracked joins the same stable checkpoint. Parent (topic/message)
   * intent is already enqueued by the caller with an earlier timestamp, so
   * per-block +1 offsets preserve parent-before-child order. Only stable +
   * untracked + unexcluded + supported rows enqueue; transient rows never
   * emit; unsupported structured/attachment-bearing rows never emit a partial
   * shell (collected for a durable unsupported outcome). Entity-only rescan:
   * each backfilled row gets its entity upsert/field evidence only — never a
   * parentMembershipClock (009/SYNC-DATA-035: membership comes only from
   * child creation in the same tx or explicitly governed reparent;
   * pre-existing/closure/promotion rows stay unversioned, no backfill/guess).
   * A later single messageBlock try-refresh in the same tx therefore
   * invalidates with 0 op while the user mutation succeeds when any included
   * block lacks trustworthy membership. Throws fail-closed (rolls back the
   * promotion) on infrastructure failure. Returns true when at least one
   * descendant was captured.
   */
  private captureUntrackedStableBlocksInTx(
    tx: SyncTxExecutor,
    repos: ChatDbRepositories,
    messageId: string,
    baseTs: number,
    deviceId: string,
    excludeIds: ReadonlySet<string>,
    unsupportedIds?: string[]
  ): boolean {
    const siblings = repos.blocks.listByMessage(messageId)
    let captured = false
    let offset = 0
    for (const b of siblings) {
      if (excludeIds.has(b.id)) continue
      if (!isStableBlockStatus(b.status)) continue
      if (this.isUnsupportedBlock(b)) {
        unsupportedIds?.push(b.id)
        continue
      }
      if (syncService.isTrackedEntityInTx(tx, 'message_block', b.id)) continue
      // Intentionally no membership clock for promotion-rescanned siblings:
      // these are existing rows with no trustworthy creation source (append
      // while parent transient or legacy pre-sync). Fabricating a clock from
      // the promotion timestamp would be a guess (no real operationId).
      // They remain absent/unversioned per 009 semantics; only true first
      // creations via direct aggregate paths get a membership clock.
      syncService.enqueueUpsertInTx(
        tx,
        'message_block',
        b.id,
        this.syncBlockPayloadFull(b),
        Math.max(0, baseTs + offset + 1),
        deviceId
      )
      offset += 1
      captured = true
    }
    return captured
  }

  /**
   * Pre/post diff for full-object block writes: only actually changed
   * allowlisted fields become sync intent (never sortOrder, never identity).
   * Null (pre absent) means create — caller uses the full payload instead.
   */
  private diffBlockPayload(pre: MessageBlockData | null, post: MessageBlockData): Record<string, unknown> | null {
    if (!pre) return this.syncBlockPayloadFull(post)
    const out: Record<string, unknown> = { id: post.id, messageId: post.messageId }
    for (const k of ['type', 'content', 'status', 'createdAt', 'updatedAt'] as const) {
      const a = pre[k] ?? null
      const b = post[k] ?? null
      if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) out[k] = post[k]
    }
    return Object.keys(out).length > 2 ? out : null
  }

  /** Pre/post diff for full-object message writes (same patch-only rule). */
  private diffMessagePayload(pre: MessageData | null, post: MessageData): Record<string, unknown> | null {
    if (!pre) return this.syncMessagePayloadFull(post)
    const out: Record<string, unknown> = { id: post.id, topicId: post.topicId }
    for (const k of [
      'role',
      'content',
      'status',
      'askId',
      'model',
      'modelId',
      'assistantId',
      'createdAt',
      'updatedAt'
    ] as const) {
      const a = pre[k] ?? null
      const b = post[k] ?? null
      if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) out[k] = post[k]
    }
    return Object.keys(out).length > 2 ? out : null
  }

  /**
   * Stable-checkpoint gate for creation paths (LOCK-PERSONAL-004): user
   * messages and independently stable non-assistant creations capture;
   * assistant stubs capture only at stable success/error/paused checkpoints.
   * Transient assistant rows are legitimate skips (no failure, no outbox).
   */
  private shouldCaptureMessageCreate(data: MessageData): boolean {
    if (data.role !== 'assistant') return true
    return isStableMessageStatus(data.status)
  }

  // =========================================================================
  // Command implementations
  // =========================================================================

  /**
   * Fetch all messages and blocks for a topic.
   * Returns consistent ordered message/block snapshot.
   * Rebuilds each message.blocks relationally.
   *
   * Pure read (LOCK-PERSONAL-001/006): a missing topic returns empty
   * arrays without creating any topic row, so a read can never leave a
   * hidden local topic without sync intent. Explicit creation stays on
   * ensureTopic (transactional outbox); appendMessage ensures its parent.
   */
  fetchMessages(topicId: string): ChatDbResult<FetchMessagesResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Absent topic → pure read, no implicit mutation.
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          return { messages: [], blocks: [] }
        }

        const messageData = repos.messages.listByTopic(topicId)
        const messageIds = messageData.map((m) => m.id)
        const blockDataMap = repos.blocks.listByMessages(messageIds)

        // Flatten all blocks
        const allBlocks: MessageBlockData[] = []
        for (const id of messageIds) {
          const msgBlocks = blockDataMap.get(id) ?? []
          allBlocks.push(...msgBlocks)
        }

        // Convert to wire format
        const wireMessages = messagesToWire(messageData)
        const wireBlocks = blocksToWire(allBlocks)

        // Reconstruct relational message.blocks
        const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)

        return { messages: messagesWithBlocks, blocks: wireBlocks }
      })
    }, `fetchMessages(${topicId})`)
  }

  /**
   * Typed windowed read — R-02 latest / R-03 around (S6.1; group-corrected for viewport).
   *
   * Counting unit for viewport windows is complete rendered/message groups
   * (consecutive assistant messages sharing a non-empty askId form one group;
   * all other messages are singleton groups, matching renderer
   * getMessageGroupSemanticKey / createMessageViewportGroupModel).
   *
   * One authoritative SQLite transaction:
   * - Deterministic order: sort_order ASC, id ASC with id tie-break.
   * - Stable-ID anchoring for around reads; no tuple cursors.
   * - Complete groups returned (never split a consecutive same-askId assistant run).
   * - Window metadata declares intent, bounds, and hasMore flags; completeness is 'window'.
   * - Missing topic → ERR_NOT_FOUND; missing anchor → ERR_NOT_FOUND; empty topic → empty window success.
   * - hasMoreBefore/After derived from group boundaries, not raw message indexes.
   */
  fetchMessagesWindow(request: FetchMessagesWindowRequest): ChatDbResult<FetchMessagesWindowResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        const allMessages = repos.messages.listByTopic(request.topicId)
        const total = allMessages.length

        const computeGroups = (
          msgs: typeof allMessages
        ): Array<{ semanticKey: string; start: number; end: number }> => {
          if (msgs.length === 0) return []
          const groups: Array<{ semanticKey: string; start: number; end: number }> = []
          const keyFor = (m: (typeof msgs)[number]): string => {
            const askId = (m as unknown as { askId: string | null }).askId
            if (m.role === 'assistant' && typeof askId === 'string' && askId.length > 0) {
              return `assistant:${askId}`
            }
            return `message:${m.role ?? ''}:${m.id}`
          }
          let curKey = keyFor(msgs[0])
          let curStart = 0
          for (let i = 1; i < msgs.length; i++) {
            const k = keyFor(msgs[i])
            if (k === curKey) continue
            groups.push({ semanticKey: curKey, start: curStart, end: i - 1 })
            curKey = k
            curStart = i
          }
          groups.push({ semanticKey: curKey, start: curStart, end: msgs.length - 1 })
          return groups
        }

        let windowMessages: typeof allMessages
        let hasMoreBefore = false
        let hasMoreAfter = false
        let firstMessageId: string | null = null
        let lastMessageId: string | null = null

        if (request.kind === 'latest') {
          if (total === 0) {
            windowMessages = []
            hasMoreBefore = false
            hasMoreAfter = false
          } else {
            const groups = computeGroups(allMessages)
            const totalGroups = groups.length
            let startGroupIdx: number
            let endGroupIdx: number
            if (request.limit >= totalGroups) {
              startGroupIdx = 0
              endGroupIdx = totalGroups - 1
            } else {
              startGroupIdx = totalGroups - request.limit
              endGroupIdx = totalGroups - 1
            }
            const startMsgIdx = groups[startGroupIdx].start
            const endExclusive = groups[endGroupIdx].end + 1
            windowMessages = allMessages.slice(startMsgIdx, endExclusive)
            hasMoreBefore = startGroupIdx > 0
            hasMoreAfter = false
          }
          firstMessageId = windowMessages.length > 0 ? windowMessages[0].id : null
          lastMessageId = windowMessages.length > 0 ? windowMessages[windowMessages.length - 1].id : null
          const ids = windowMessages.map((m) => m.id)
          const blockDataMap = repos.blocks.listByMessages(ids)
          const allBlocks: MessageBlockData[] = []
          for (const id of ids) allBlocks.push(...(blockDataMap.get(id) ?? []))
          const wireMessages = messagesToWire(windowMessages)
          const wireBlocks = blocksToWire(allBlocks)
          const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
          return {
            messages: messagesWithBlocks,
            blocks: wireBlocks,
            window: {
              kind: 'latest',
              completeness: 'window' as const,
              topicId: request.topicId,
              anchorMessageId: null,
              requested: { limit: request.limit },
              firstMessageId,
              lastMessageId,
              returnedCount: windowMessages.length,
              hasMoreBefore,
              hasMoreAfter
            }
          }
        } else {
          // around — anchor plus N complete groups before and after the anchor's group
          const anchorIdx = allMessages.findIndex((m) => m.id === request.anchorMessageId)
          if (anchorIdx === -1) {
            throw new ChatDbNotFoundError(
              `Anchor message ${request.anchorMessageId} does not belong to topic ${request.topicId}`
            )
          }
          const groups = computeGroups(allMessages)
          let anchorGroupIdx = -1
          for (let gi = 0; gi < groups.length; gi++) {
            if (anchorIdx >= groups[gi].start && anchorIdx <= groups[gi].end) {
              anchorGroupIdx = gi
              break
            }
          }
          if (anchorGroupIdx === -1) {
            throw new ChatDbNotFoundError(
              `Anchor message ${request.anchorMessageId} does not belong to topic ${request.topicId}`
            )
          }
          const startGroupIdx = Math.max(0, anchorGroupIdx - request.before)
          const endGroupIdx = Math.min(groups.length - 1, anchorGroupIdx + request.after)
          const startMsgIdx = groups[startGroupIdx].start
          const endExclusive = groups[endGroupIdx].end + 1
          windowMessages = allMessages.slice(startMsgIdx, endExclusive)
          hasMoreBefore = startGroupIdx > 0
          hasMoreAfter = endGroupIdx < groups.length - 1
          firstMessageId = windowMessages.length > 0 ? windowMessages[0].id : null
          lastMessageId = windowMessages.length > 0 ? windowMessages[windowMessages.length - 1].id : null
          const ids = windowMessages.map((m) => m.id)
          const blockDataMap = repos.blocks.listByMessages(ids)
          const allBlocks: MessageBlockData[] = []
          for (const id of ids) allBlocks.push(...(blockDataMap.get(id) ?? []))
          const wireMessages = messagesToWire(windowMessages)
          const wireBlocks = blocksToWire(allBlocks)
          const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
          return {
            messages: messagesWithBlocks,
            blocks: wireBlocks,
            window: {
              kind: 'around',
              completeness: 'window' as const,
              topicId: request.topicId,
              anchorMessageId: request.anchorMessageId,
              requested: { before: request.before, after: request.after },
              firstMessageId,
              lastMessageId,
              returnedCount: windowMessages.length,
              hasMoreBefore,
              hasMoreAfter
            }
          }
        }
      })
    }, `fetchMessagesWindow(${request.topicId}, ${request.kind})`)
  }

  /**
   * S6.2b R-05: authoritative answer-group READ.
   *
   * One authoritative SQLite transaction:
   * - Validates topic exists, anchor belongs to topic, anchor role is
   *   assistant with non-empty askId — all fail as NOT_FOUND (no actionable group).
   * - Resolves complete group: all same-topic assistant messages with equal
   *   askId in deterministic sort_order ASC, id ASC.
   * - Returns completeness:'answer-group', echoes topicId/anchorMessageId,
   *   includes askId and ordered messageIds. No mutation, no size/cursor fields.
   */
  fetchAnswerGroup(request: FetchAnswerGroupRequest): ChatDbResult<FetchAnswerGroupResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        const anchor = repos.messages.getInTopic(request.anchorMessageId, request.topicId)
        if (!anchor.found) {
          throw new ChatDbNotFoundError(
            `Anchor message ${request.anchorMessageId} does not belong to topic ${request.topicId}`
          )
        }
        const askId = anchor.data.askId
        if (anchor.data.role !== 'assistant' || typeof askId !== 'string' || askId.length === 0) {
          throw new ChatDbNotFoundError(`Anchor message ${request.anchorMessageId} has no actionable answer group`)
        }
        const allMessages = repos.messages.listByTopic(request.topicId)
        const groupIds = allMessages.filter((m) => m.role === 'assistant' && m.askId === askId).map((m) => m.id)
        if (!groupIds.includes(request.anchorMessageId)) {
          throw new ChatDbNotFoundError(`Anchor message ${request.anchorMessageId} has no actionable answer group`)
        }
        if (groupIds.length === 0) {
          throw new ChatDbNotFoundError(`Anchor message ${request.anchorMessageId} has no actionable answer group`)
        }
        return {
          completeness: 'answer-group' as const,
          topicId: request.topicId,
          anchorMessageId: request.anchorMessageId,
          askId,
          messageIds: groupIds
        }
      })
    }, `fetchAnswerGroup(${request.topicId}, ${request.anchorMessageId})`)
  }

  /**
   * S6.3 R-06: authoritative context closure READ (anchorGroupKey through newest).
   *
   * One authoritative SQLite transaction:
   * - Validates topic exists; missing topic → NOT_FOUND.
   * - Builds context turns deterministically from authority order
   *   (sort_order ASC, id ASC) with renderer-equivalent semantics:
   *   user starts a turn keyed by user id; consecutive assistant messages
   *   with matching non-empty askId join; assistant without askId or with
   *   non-matching askId and system messages are singleton turns; nullable/
   *   unknown roles are ignored for turn construction (matches renderer
   *   buildContextTurns which only groups system/user/assistant).
   * - Resolves anchorGroupKey using context-turn semantics in deterministic
   *   authority order: first user message id match, otherwise assistant
   *   non-empty askId match, otherwise non-user message id match.
   *   Unresolved anchor → NOT_FOUND. Main never writes/repairs the anchor.
   * - Returns rows from the first message of the resolved turn through the
   *   newest row, ordered sort_order ASC, id ASC, with complete message/block
   *   relations. No viewport cap, no hasMore, completeness is 'context-closure'.
   */
  fetchContextClosure(request: FetchContextClosureRequest): ChatDbResult<FetchContextClosureResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        const allMessages = repos.messages.listByTopic(request.topicId)
        // Build context turns deterministically in authority order.
        type ContextTurn = { key: string; messages: MessageData[] }
        const turns: ContextTurn[] = []
        let currentTurnKey: string | null = null
        for (const msg of allMessages) {
          const role = msg.role
          const askId = (msg as unknown as { askId: string | null }).askId
          if (role === 'system') {
            currentTurnKey = msg.id
            turns.push({ key: currentTurnKey, messages: [msg] })
          } else if (role === 'user') {
            currentTurnKey = msg.id
            turns.push({ key: currentTurnKey, messages: [msg] })
          } else if (role === 'assistant') {
            if (askId && askId === currentTurnKey) {
              // Consecutive assistant with askId matching current turn → join
              turns[turns.length - 1].messages.push(msg)
            } else {
              if (askId) {
                currentTurnKey = askId
              } else {
                currentTurnKey = msg.id
              }
              turns.push({ key: currentTurnKey, messages: [msg] })
            }
          } else {
            // Nullable/unknown persisted role (null, '', 'tool', 'generic', etc.):
            // ignored for turn construction. Matches renderer buildContextTurns which
            // only groups system/user/assistant and silently drops other roles.
            // Policy is local and explicit: no turn, no currentTurnKey advance.
            // The raw message remains in authority-ordered closure slice but does
            // not affect context-turn semantics or anchor resolution.
            continue
          }
        }

        // Resolve anchorGroupKey using context-turn semantics in deterministic authority order.
        const anchorKey = request.anchorGroupKey
        let anchorTurnIdx = -1
        // 1. Prefer user message id match (canonical user-initiated turn)
        anchorTurnIdx = turns.findIndex((t) => t.messages.some((m) => m.role === 'user' && m.id === anchorKey))
        if (anchorTurnIdx === -1) {
          // 2. Fall back to assistant non-empty askId match (orphan or legacy askId anchor)
          anchorTurnIdx = turns.findIndex((t) =>
            t.messages.some((m) => m.role === 'assistant' && m.askId === anchorKey)
          )
        }
        if (anchorTurnIdx === -1) {
          // 3. Fall back to non-user message id match (orphan assistant own-id or standalone system)
          anchorTurnIdx = turns.findIndex((t) => t.messages.some((m) => m.role !== 'user' && m.id === anchorKey))
        }
        if (anchorTurnIdx === -1) {
          throw new ChatDbNotFoundError(`Anchor groupKey ${anchorKey} does not belong to topic ${request.topicId}`)
        }

        const anchorTurn = turns[anchorTurnIdx]
        const anchorStartId = anchorTurn.messages[0].id
        const anchorStartIdx = allMessages.findIndex((m) => m.id === anchorStartId)
        if (anchorStartIdx === -1) {
          throw new ChatDbNotFoundError(`Anchor groupKey ${anchorKey} does not belong to topic ${request.topicId}`)
        }

        const closureMessages = allMessages.slice(anchorStartIdx)
        const closureIds = closureMessages.map((m) => m.id)
        const blockMap = repos.blocks.listByMessages(closureIds)
        const allBlocks: MessageBlockData[] = []
        for (const id of closureIds) {
          allBlocks.push(...(blockMap.get(id) ?? []))
        }
        const wireMessages = messagesToWire(closureMessages)
        const wireBlocks = blocksToWire(allBlocks)
        const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)

        const firstMessageId = closureMessages.length > 0 ? closureMessages[0].id : null
        const lastMessageId = closureMessages.length > 0 ? closureMessages[closureMessages.length - 1].id : null
        // LOCK-001: derive authoritative counts and boundary from same complete turn set and resolved anchor
        const totalTurnCount = turns.length
        const selectedTurnCount = turns.length - anchorTurnIdx
        const boundaryMessageId = anchorTurnIdx > 0 ? turns[anchorTurnIdx].messages[0].id : null

        return {
          messages: messagesWithBlocks,
          blocks: wireBlocks,
          closure: {
            completeness: 'context-closure' as const,
            topicId: request.topicId,
            anchorGroupKey: request.anchorGroupKey,
            firstMessageId,
            lastMessageId,
            returnedCount: closureMessages.length,
            totalTurnCount,
            selectedTurnCount,
            boundaryMessageId
          }
        }
      })
    }, `fetchContextClosure(${request.topicId}, ${request.anchorGroupKey})`)
  }

  /**
   * S6.2c-2: Resolve anchor → group-tail insert index.
   *
   * One authoritative helper for Main:
   * - Ordered authority messages sort_order ASC, id ASC (via listByTopic).
   * - Validates anchor membership; advances past contiguous assistant messages
   *   with same non-empty ask_id as anchor when existing behavior requires
   *   group-tail insertion (anchor role assistant + askId).
   * - Returns resolved insertIndex (anchor-group tail + 1).
   * Factored for reuse + testability; no renderer state.
   */
  private resolveInsertIndexAfterAnchor(orderedMessages: MessageData[], anchor: MessageData): number {
    const anchorIdx = orderedMessages.findIndex((m) => m.id === anchor.id)
    if (anchorIdx === -1) {
      throw new ChatDbNotFoundError(`Anchor message ${anchor.id} does not belong to its topic`)
    }
    let tailIdx = anchorIdx
    const askId = (anchor as any).askId as string | undefined
    if (anchor.role === 'assistant' && typeof askId === 'string' && askId.length > 0) {
      for (let i = anchorIdx + 1; i < orderedMessages.length; i++) {
        const cur = orderedMessages[i]
        if (cur.role === 'assistant' && (cur as any).askId === askId) {
          tailIdx = i
        } else {
          break
        }
      }
    }
    return tailIdx + 1
  }

  /**
   * S6.2c-2: Main-authoritative insert after stable anchor.
   *
   * One atomic Main SQLite transaction:
   * - Validates topic exists, anchor belongs to topic.
   * - Resolves ordered authority messages and group-tail index atomically.
   * - Inserts supplied entries with existing dense-order repository logic
   *   (batch insertManyAt, existing IDs preserve position).
   * - Upserts blocks + syncs file references in original entry order.
   * - Fail closed: validation/read/write errors throw typed envelope, no partial publication.
   * - Returns FileCleanupResult (empty for pure inserts; prior refs harvested for existing IDs).
   */
  insertMessagesAfterAnchor(
    topicId: string,
    afterMessageId: string,
    entries: Array<{ message: JsonObject; blocks: JsonObject[] }>
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const ctx = this.syncCtx('insertMessagesAfterAnchor')
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      let result: FileCleanupResult
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Validate topic exists
          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }
          // Validate anchor membership
          const anchorRes = repos.messages.getInTopic(afterMessageId, topicId)
          if (!anchorRes.found) {
            throw new ChatDbNotFoundError(`Anchor message ${afterMessageId} does not belong to topic ${topicId}`)
          }
          const anchorData = anchorRes.data

          // Ordered authority snapshot + group-tail resolution (single transaction, no second read)
          const orderedMessages = repos.messages.listByTopic(topicId)
          const resolvedInsertIndex = this.resolveInsertIndexAfterAnchor(orderedMessages, anchorData)

          // Phase 1 — convert every entry, enforce block ownership, classify new vs existing
          // (DB-existence classification preserved exactly for chat writes).
          const newMessages: MessageData[] = []
          const newMessageIds = new Set<string>()
          const existingPlans: Array<{ id: string; patch: Record<string, unknown> }> = []
          const phase4Plans: Array<{ blocks: MessageBlockData[]; harvest: boolean }> = []
          const allAffectedFileIds: string[] = []
          // Pre-state snapshots for sync diffing (taken before any mutation in this tx).
          const preMessageRows = new Map<string, MessageData>()
          const preBlockRows = new Map<string, MessageBlockData>()
          if (ctx) {
            const seenMsg = new Set<string>()
            for (const entry of entries) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && mid.length > 0 && !seenMsg.has(mid)) {
                seenMsg.add(mid)
                const pre = repos.messages.getById(mid)
                if (pre.found) preMessageRows.set(mid, { ...pre.data, overflow: { ...pre.data.overflow } })
              }
              for (const b of entry.blocks) {
                const bid = (b as Record<string, unknown>).id as string
                if (typeof bid === 'string' && bid.length > 0 && !preBlockRows.has(bid)) {
                  const pre = repos.blocks.getById(bid)
                  if (pre.found) preBlockRows.set(bid, { ...pre.data, overflow: { ...pre.data.overflow } })
                }
              }
            }
          }

          for (const entry of entries) {
            const messageData = wireToMessage(entry.message)
            messageData.topicId = topicId
            const blockDataList = entry.blocks.map(wireToBlock)
            for (const block of blockDataList) {
              block.messageId = messageData.id
            }
            const patch = wireToMessagePatch(entry.message)
            delete patch.id
            delete patch.topicId
            delete patch.sortOrder

            const existing = repos.messages.getById(messageData.id)
            if (existing.found) {
              if (existing.data.topicId !== topicId) {
                throw new ChatDbConflictError(
                  `Message ${messageData.id} belongs to topic ${existing.data.topicId}, cannot insert into topic ${topicId}`
                )
              }
              existingPlans.push({ id: messageData.id, patch })
              phase4Plans.push({ blocks: blockDataList, harvest: true })
            } else if (newMessageIds.has(messageData.id)) {
              existingPlans.push({ id: messageData.id, patch })
              phase4Plans.push({ blocks: blockDataList, harvest: true })
            } else {
              newMessageIds.add(messageData.id)
              newMessages.push(messageData)
              phase4Plans.push({ blocks: blockDataList, harvest: false })
            }
          }

          // Phase 2 — batch-insert all new messages at resolved anchor group tail
          if (newMessages.length > 0) {
            repos.messages.insertManyAt(newMessages, resolvedInsertIndex)
          }

          // Phase 3 — metadata patches for existing rows / in-request duplicates
          for (const plan of existingPlans) {
            if (Object.keys(plan.patch).length > 0) {
              repos.messages.update(topicId, plan.id, plan.patch)
            }
          }

          // Phase 4 — harvest prior refs (existing entries only), then upsert blocks + sync file refs in ORIGINAL order
          for (const plan of phase4Plans) {
            if (plan.blocks.length === 0) continue
            if (plan.harvest) {
              for (const block of plan.blocks) {
                const priorRefs = repos.fileRefs.listByBlock(block.id)
                allAffectedFileIds.push(...collectAffectedFileIds(priorRefs))
              }
            }
            repos.blocks.upsertMany(plan.blocks)
            this.syncFileReferences(repos, plan.blocks)
          }

          // Transaction-bound sync intent (same atomic boundary). True-new
          // stable messages/blocks enqueue full-state upserts with membership;
          // existing rows enqueue allowlisted field diffs only with membership
          // preserved (never backfilled); transient/unsupported emit nothing.
          if (ctx) {
            let tsOffset = 0
            const nextTs = (): number => ctx.ts + tsOffset++
            // Distinct message order (first occurrence) for deterministic parent-first timestamps.
            const distinctMids: string[] = []
            const seenMids = new Set<string>()
            for (const entry of entries) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && !seenMids.has(mid)) {
                seenMids.add(mid)
                distinctMids.push(mid)
              }
            }
            let hasNewInclusion = false
            let hasDemotion = false
            for (const mid of distinctMids) {
              const postRow = repos.messages.getById(mid)
              if (!postRow.found) throw new Error(`insertMessagesAfterAnchor message ${mid} missing in transaction`)
              const pre = preMessageRows.get(mid) ?? null
              const isTrueCreate = !pre
              const postStable = isStableMessageStatus(postRow.data.status)
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) hasDemotion = true
              if ((isTrueCreate && postStable) || (pre && !preStable && postStable)) hasNewInclusion = true
              if (!postStable) continue
              if (isTrueCreate) {
                if (!this.shouldCaptureMessageCreate(postRow.data)) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, topicId, opTs, ctx.deviceId)
                const full = this.syncMessagePayloadFull(postRow.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message', mid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message', mid, postRow.data.topicId, opTs, opId)
                syncNotify = true
              } else {
                const diff = this.diffMessagePayload(pre, postRow.data)
                if (!diff) continue
                delete diff.sortOrder
                // Diff carries only allowlisted fields; empty diff means no op.
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, topicId, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message', mid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            // Distinct blocks in original entry order for parent-first timestamps.
            const distinctBids: string[] = []
            const seenBids = new Set<string>()
            for (const plan of phase4Plans) {
              for (const blk of plan.blocks) {
                if (!seenBids.has(blk.id)) {
                  seenBids.add(blk.id)
                  distinctBids.push(blk.id)
                }
              }
            }
            for (const bid of distinctBids) {
              const postBlk = repos.blocks.getById(bid)
              if (!postBlk.found) throw new Error(`insertMessagesAfterAnchor block ${bid} missing in transaction`)
              // Blocks under a transient parent never ride the wire: skip
              // without closure (closure would fail closed). The per-parent
              // frame decision below invalidates the transient parent.
              const parentMsg = repos.messages.getById(postBlk.data.messageId)
              if (!parentMsg.found || !isStableMessageStatus(parentMsg.data.status)) continue
              if (!isStableBlockStatus(postBlk.data.status)) continue
              if (this.isUnsupportedBlock(postBlk.data)) {
                unsupportedBlockIds.push(bid)
                continue
              }
              const pre = preBlockRows.get(bid) ?? null
              if (!pre) {
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                const full = this.syncBlockPayloadFull(postBlk.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message_block', bid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message_block', bid, postBlk.data.messageId, opTs, opId)
                syncNotify = true
              } else {
                if (postBlk.data.messageId !== pre.messageId) continue
                const diff = this.diffBlockPayload(pre, postBlk.data)
                if (!diff) continue
                delete diff.sortOrder
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message_block', bid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            // Local parent order frames — exactly one topicMessage attempt
            // when semantically required plus one per affected block parent
            // where required. Pure stable→stable content patches advance
            // nothing; inclusion/order changes use the existing try helpers
            // (missing/excluded invalidates with 0 op, malformed rolls back).
            if (hasDemotion) {
              syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
              for (const mid of distinctMids) {
                const pre = preMessageRows.get(mid)
                const postRow = repos.messages.getById(mid)
                const preStable = pre ? isStableMessageStatus(pre.status) : false
                const postStable = postRow.found ? isStableMessageStatus(postRow.data.status) : false
                if (pre && preStable && !postStable) {
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                }
              }
            } else if (hasNewInclusion) {
              if (syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
            // Per-parent block frames: newly included parents (even empty)
            // plus any true-create or inclusion-transition block change.
            const affectedParents = new Set<string>()
            for (const mid of distinctMids) affectedParents.add(mid)
            for (const bid of distinctBids) {
              const pre = preBlockRows.get(bid)
              const postBlk = repos.blocks.getById(bid)
              if (pre) affectedParents.add(pre.messageId)
              if (postBlk.found) affectedParents.add(postBlk.data.messageId)
            }
            for (const mid of affectedParents) {
              const postMsg = repos.messages.getById(mid)
              if (!postMsg.found) continue
              const postStable = isStableMessageStatus(postMsg.data.status)
              const pre = preMessageRows.get(mid) ?? null
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) continue // already invalidated above
              if (!postStable) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                continue
              }
              const isNewlyIncludedParent = (!pre && postStable) || (!!pre && !preStable && postStable)
              let needsBlockFrame = isNewlyIncludedParent
              if (!needsBlockFrame) {
                for (const bid of distinctBids) {
                  const bPre = preBlockRows.get(bid)
                  const bPost = repos.blocks.getById(bid)
                  if (!bPost.found) continue
                  // Scope to blocks currently under this parent.
                  if (bPost.data.messageId !== mid && (!bPre || bPre.messageId !== mid)) continue
                  if (!bPre) {
                    needsBlockFrame = true
                    break
                  }
                  // Only blocks that belong to this parent transitionally.
                  if (bPre.messageId !== mid && bPost.data.messageId !== mid) continue
                  const preIncluded = isStableBlockStatus(bPre.status) && !this.isUnsupportedBlock(bPre)
                  const postIncluded = isStableBlockStatus(bPost.data.status) && !this.isUnsupportedBlock(bPost.data)
                  if (bPre.messageId !== bPost.data.messageId) {
                    needsBlockFrame = true
                    break
                  }
                  if (preIncluded !== postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                  // Excluded true-create under this parent must invalidate.
                  if (!postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                }
                // A true-create message with no blocks still needs its empty frame.
                // Covered by isNewlyIncludedParent above.
              }
              if (!needsBlockFrame) continue
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, mid, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          } else {
            // Capture disabled: preserve existing truthful invalidation, no ops.
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
            {
              const affectedMids = new Set<string>()
              for (const plan of phase4Plans) {
                for (const blk of plan.blocks) {
                  affectedMids.add(blk.messageId)
                }
              }
              for (const mid of affectedMids) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
              }
            }
          }

          const uniqueAffectedIds = [...new Set(allAffectedFileIds)].sort()
          return buildFileCleanupResult(repos, uniqueAffectedIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('insertMessagesAfterAnchor', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('insertMessagesAfterAnchor', unsupportedBlockIds)
      return result
    }, `insertMessagesAfterAnchor(${topicId}, ${afterMessageId}, ${entries.length} entries)`)
  }

  /**
   * Get raw topic with ordered messages and relational block IDs.
   * Returns null if topic does not exist.
   */
  getRawTopic(topicId: string): ChatDbResult<GetRawTopicResult> {
    return wrapResult(() => {
      const { topics, messages: msgRepo, blocks } = this.repos()

      const topic = topics.getById(topicId)
      if (!topic.found) return null

      const messageData = msgRepo.listByTopic(topicId)
      const messageIds = messageData.map((m) => m.id)
      const blockDataMap = blocks.listByMessages(messageIds)

      const allBlocks: MessageBlockData[] = []
      for (const id of messageIds) {
        allBlocks.push(...(blockDataMap.get(id) ?? []))
      }

      const wireMessages = messagesToWire(messageData)
      const wireBlocks = blocksToWire(allBlocks)
      const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)

      return { id: topicId, messages: messagesWithBlocks }
    }, `getRawTopic(${topicId})`)
  }

  /**
   * Check if a topic exists. Real DB errors become failure, not false.
   */
  topicExists(topicId: string): ChatDbResult<boolean> {
    return wrapResult(() => {
      const { topics } = this.repos()
      return topics.exists(topicId)
    }, `topicExists(${topicId})`)
  }

  /**
   * Ensure a topic exists. Create-only: only sets assistantId on creation.
   * Does not overwrite existing topic's assistantId.
   * Sync intent (create-only full payload) commits atomically in the same tx.
   */
  ensureTopic(topicId: string, assistantId?: string, name?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const ctx = this.syncCtx('ensureTopic')
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          // Create-only gate (LOCK-PERSONAL-005): capture depends on actual
          // pre-mutation row existence, not trackedness. An existing row —
          // even untracked (pre-sync legacy data) — is a no-op: it emits no
          // fresh full snapshot so a stale ensure can never overwrite newer
          // remote field values. Only a row absent before this command is a
          // true creation and emits the create-union payload.
          const existedBefore = repos.topics.getById(topicId).found
          repos.topics.ensure(topicId, assistantId, name)
          if (ctx && !existedBefore) {
            const created = repos.topics.getById(topicId)
            if (!created.found) throw new Error(`ensureTopic ${topicId} missing after ensure`)
            syncService.enqueueUpsertInTx(
              tx as unknown as SyncTxExecutor,
              'topic',
              topicId,
              this.syncTopicPayload(created.data),
              ctx.ts,
              ctx.deviceId
            )
            notify = true
            // New trustworthy topic creation: persist empty topicMessage frame with dedicated truthful clock
            // and enqueue the matching order_frame op reusing that clock (SYNC-DATA-048, same tx).
            // Existing/pre-010 observations must not be backfilled — only when actually newly created/captured here.
            syncService.refreshTopicMessageFrameAndEnqueueInTx(tx as unknown as SyncTxExecutor, topicId, ctx.deviceId)
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('ensureTopic', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `ensureTopic(${topicId})`)
  }

  /**
   * Append a message with blocks to a topic.
   *
   * - Ensures topic exists.
   * - New message at valid insertIndex, else append at end.
   * - Existing message ID preserves current position.
   * - Full supplied blocks are upserted, ordered, and references synced.
   *
   * `diagnostics` is optional diagnostic-only correlation metadata
   * (LOCK-004); it never affects persistence semantics. When present, bounded
   * timing logs distinguish wire→domain conversion from the synchronous
   * SQLite transaction (LOCK-001/003).
   */
  appendMessage(
    topicId: string,
    messageJson: JsonObject,
    blocksJson: JsonObject[],
    insertIndex?: number,
    diagnostics?: AppendDiagnostics
  ): ChatDbResult<null> {
    const correlationId = diagnostics?.correlationId
    const ordinal = diagnostics?.ordinal
    const isDiagnosedAppend = typeof correlationId === 'string' && correlationId.length > 0
    const phasePath = isPhaseAttrMainEnabled() ? ('echo' as const) : undefined
    const t0 = performance.now()
    let convertDurationMs = 0
    let txDurationMs = 0
    let outcomeOk = false

    const result = wrapResult(() => {
      try {
        // Convert wire → domain
        const tConvert = performance.now()
        const messageData = wireToMessage(messageJson)
        messageData.topicId = topicId // Ensure consistency
        const blockDataList = blocksJson.map(wireToBlock)

        // Validate block ownership: all blocks must reference this message
        for (const block of blockDataList) {
          block.messageId = messageData.id // Enforce consistency
        }
        convertDurationMs = elapsedMs(tConvert)

        const tTx = performance.now()
        const syncCtx = this.syncCtx('appendMessage')
        let syncNotify = false
        const unsupportedBlockIds: string[] = []
        let txResult: null
        try {
          txResult = this.db.transaction((tx) => {
            const repos = createRepositories(tx)
            const stx = tx as unknown as SyncTxExecutor

            const trackedTopicBefore = syncCtx ? syncService.isTrackedEntityInTx(stx, 'topic', topicId) : true
            // Ensure topic exists
            repos.topics.ensure(topicId)

            // Check if message already exists
            const existing = repos.messages.getById(messageData.id)
            const messageExistedBefore = existing.found
            const messagePre = existing.found
              ? ({ ...existing.data, overflow: { ...existing.data.overflow } } as MessageData)
              : null

            if (existing.found) {
              // Authoritative ownership guard (sync F1): an existing message ID
              // owned by another topic must not be mutated and must not emit
              // sync capture. Reject before any message/block processing so the
              // transaction aborts with zero entity mutation; the IPC hook only
              // captures on success, so no outbox capture is emitted.
              if (existing.data.topicId !== topicId) {
                throw new ChatDbConflictError(
                  `Message ${messageData.id} belongs to topic ${existing.data.topicId}, cannot reparent to ${topicId}`
                )
              }
              // Existing ID: preserve current position (update metadata only)
              const patch = wireToMessagePatch(messageJson)
              delete patch.id
              delete patch.topicId
              delete patch.sortOrder
              if (Object.keys(patch).length > 0) {
                repos.messages.update(topicId, messageData.id, patch)
              }
            } else {
              // New message: insert at index or append
              if (insertIndex !== undefined) {
                repos.messages.insertAt(messageData, insertIndex)
              } else {
                repos.messages.append(messageData)
              }
            }

            // Pre-state snapshot for existing blocks (field-patch diffing).
            const preBlockRows = new Map<string, MessageBlockData>()
            if (syncCtx && blockDataList.length > 0) {
              for (const block of blockDataList) {
                const pre = repos.blocks.getById(block.id)
                if (pre.found) preBlockRows.set(block.id, { ...pre.data, overflow: { ...pre.data.overflow } })
              }
            }
            // Upsert blocks (preserves existing order for existing blocks)
            if (blockDataList.length > 0) {
              repos.blocks.upsertMany(blockDataList)

              // Sync file references for file/image blocks
              this.syncFileReferences(repos, blockDataList)
            }

            // Transaction-bound sync intent (same atomic boundary). Stable
            // checkpoint gate (LOCK-PERSONAL-004): transient assistant stubs
            // (pending/processing/searching/streaming) are legitimate skips —
            // no outbox, no failure. Unsupported structured/attachment blocks
            // skip without a partial null-content shell (durable unsupported
            // outcome recorded after commit). User messages and stable
            // creations capture; existing IDs emit intentional patches only
            // (LOCK-PERSONAL-005). A throw rolls back the whole append; the
            // outer catch records a durable capture failure outside the tx.
            if (syncCtx) {
              const mrow = repos.messages.getById(messageData.id)
              if (!mrow.found) throw new Error(`appendMessage message ${messageData.id} missing in transaction`)
              const messageStable = this.shouldCaptureMessageCreate(mrow.data)
              const postStableForFrameEarly = isStableMessageStatus(mrow.data.status)
              const preStableForFrameEarly =
                messageExistedBefore && messagePre ? isStableMessageStatus(messagePre.status) : false
              if (!messageStable) {
                if (preStableForFrameEarly && !postStableForFrameEarly) {
                  // Stable→transient overwrite exclusion (SYNC-DATA-048
                  // errata): transient status never rides the wire, so the
                  // frame has no member-exclusion authority — invalidate
                  // locally in the same tx with 0 frame op; the user
                  // overwrite still succeeds and the candidate stays
                  // truthful partial.
                  syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageData.id)
                }
                return null
              }
              if (!trackedTopicBefore) {
                const trow = repos.topics.getById(topicId)
                if (!trow.found) throw new Error(`appendMessage topic ${topicId} missing in transaction`)
                syncService.enqueueUpsertInTx(
                  stx,
                  'topic',
                  topicId,
                  this.syncTopicPayload(trow.data),
                  Math.max(0, syncCtx.ts - 2),
                  syncCtx.deviceId
                )
                syncNotify = true
              }
              if (!messageExistedBefore) {
                const opId = syncService.enqueueUpsertInTx(
                  stx,
                  'message',
                  messageData.id,
                  this.syncMessagePayloadFull(mrow.data),
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                syncService.setMembershipClockInTx(stx, 'message', messageData.id, mrow.data.topicId, syncCtx.ts, opId)
                syncNotify = true
              } else {
                const patchPayload = this.diffMessagePayload(messagePre, mrow.data)
                if (patchPayload) {
                  syncService.enqueueUpsertInTx(
                    stx,
                    'message',
                    messageData.id,
                    patchPayload,
                    syncCtx.ts,
                    syncCtx.deviceId
                  )
                  syncNotify = true
                }
              }
              for (let i = 0; i < blockDataList.length; i++) {
                const bid = blockDataList[i].id
                const brow = repos.blocks.getById(bid)
                if (!brow.found) throw new Error(`appendMessage block ${bid} missing in transaction`)
                if (!isStableBlockStatus(brow.data.status)) continue
                if (this.isUnsupportedBlock(brow.data)) {
                  unsupportedBlockIds.push(bid)
                  continue
                }
                const pre = preBlockRows.get(bid) ?? null
                if (!pre) {
                  this.ensureBlockParentClosureInTx(stx, bid, syncCtx.ts + i + 1, syncCtx.deviceId)
                  const opTs = syncCtx.ts + i + 1
                  const opId = syncService.enqueueUpsertInTx(
                    stx,
                    'message_block',
                    bid,
                    this.syncBlockPayloadFull(brow.data),
                    opTs,
                    syncCtx.deviceId
                  )
                  syncService.setMembershipClockInTx(stx, 'message_block', bid, brow.data.messageId, opTs, opId)
                  syncNotify = true
                } else {
                  if (brow.data.messageId !== pre.messageId) continue
                  const blockPatch = this.diffBlockPayload(pre, brow.data)
                  if (!blockPatch) continue
                  this.ensureBlockParentClosureInTx(stx, bid, syncCtx.ts + i + 1, syncCtx.deviceId)
                  syncService.enqueueUpsertInTx(
                    stx,
                    'message_block',
                    bid,
                    blockPatch,
                    syncCtx.ts + i + 1,
                    syncCtx.deviceId
                  )
                  syncNotify = true
                }
              }
              // Local parent order frame (010) — inventory-inclusion gated (task 1).
              // Refresh topicMessage only when message is newly included (true newly created stable message,
              // or actual pre/post excluded→included transition). Existing stable→stable content edits must
              // not advance topic frame and must not strictly require membership. New/included block changes
              // still update only messageBlock as appropriate.
              {
                const postStableForFrame = isStableMessageStatus(mrow.data.status)
                const preStableForFrame =
                  messageExistedBefore && messagePre ? isStableMessageStatus(messagePre.status) : false
                const isNewlyIncludedMsg =
                  (!messageExistedBefore && postStableForFrame) ||
                  (messageExistedBefore && !preStableForFrame && postStableForFrame)
                const isStableToStableMsg = messageExistedBefore && preStableForFrame && postStableForFrame
                if (isNewlyIncludedMsg) {
                  const topicRow = repos.topics.getById(topicId)
                  if (topicRow.found) {
                    if (!messageExistedBefore) {
                      if (syncService.refreshTopicMessageFrameAndEnqueueInTx(stx, topicId, syncCtx.deviceId)) {
                        syncNotify = true
                      }
                    } else {
                      if (
                        syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, syncCtx.deviceId) ===
                        'refreshed'
                      ) {
                        syncNotify = true
                      }
                    }
                  }
                  const parentMsg = repos.messages.getById(messageData.id)
                  if (parentMsg.found && isStableMessageStatus(parentMsg.data.status)) {
                    if (
                      syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageData.id, syncCtx.deviceId) ===
                      'refreshed'
                    ) {
                      syncNotify = true
                    }
                  } else if (parentMsg.found) {
                    syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageData.id)
                  }
                } else if (isStableToStableMsg) {
                  // Stable→stable: do NOT advance topic frame; handle messageBlock only for new/included block changes
                  let hasTrueCreateIncluded = false
                  let hasBlockInclusionTransition = false
                  for (const b of blockDataList) {
                    const pre = preBlockRows.get(b.id) ?? null
                    const postRow = repos.blocks.getById(b.id)
                    if (!postRow.found) continue
                    const postIncluded =
                      isStableBlockStatus(postRow.data.status) && !this.isUnsupportedBlock(postRow.data)
                    if (!pre) {
                      if (postIncluded) hasTrueCreateIncluded = true
                    } else {
                      const preIncluded = isStableBlockStatus(pre.status) && !this.isUnsupportedBlock(pre)
                      if (preIncluded !== postIncluded) hasBlockInclusionTransition = true
                    }
                  }
                  if (hasTrueCreateIncluded && !hasBlockInclusionTransition) {
                    const parentMsg = repos.messages.getById(messageData.id)
                    if (parentMsg.found && isStableMessageStatus(parentMsg.data.status)) {
                      if (
                        syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageData.id, syncCtx.deviceId) ===
                        'refreshed'
                      ) {
                        syncNotify = true
                      }
                    } else if (parentMsg.found) {
                      syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageData.id)
                    }
                  } else if (hasBlockInclusionTransition) {
                    if (
                      syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageData.id, syncCtx.deviceId) ===
                      'refreshed'
                    ) {
                      syncNotify = true
                    }
                  }
                } else if (messageExistedBefore && preStableForFrame && !postStableForFrame) {
                  // Stable→transient overwrite exclusion via appendMessage
                  // (SYNC-DATA-048 errata): transient status never rides the
                  // wire, so no frame op is minted — invalidate locally in
                  // the same tx; the overwrite still succeeds and the
                  // candidate stays truthful partial.
                  syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageData.id)
                }
              }
            }
            return null
          })
        } catch (e) {
          this.recordSyncTxFailure('appendMessage', syncCtx, e)
          throw e
        }
        if (syncNotify) syncService.notifyEnqueued()
        this.recordUnsupportedBlocksAfterCommit('appendMessage', unsupportedBlockIds)
        txDurationMs = elapsedMs(tTx)
        outcomeOk = true
        return txResult
      } catch (error) {
        outcomeOk = false
        throw error
      } finally {
        // LOCK-001/003/004: bounded timing logs fire on success AND failure
        // without swallowing or replacing the original error.
        if (isDiagnosedAppend) {
          logMainDiagnostic('main.append.convert', convertDurationMs, MAX_APPEND_DIAGNOSTIC_LOGS, {
            correlationId,
            ordinal,
            ok: outcomeOk
          })
          logMainDiagnostic('main.append.tx', txDurationMs, MAX_APPEND_DIAGNOSTIC_LOGS, {
            correlationId,
            ordinal,
            ok: outcomeOk
          })
          logMainDiagnostic('main.append.aggregate', elapsedMs(t0), MAX_APPEND_DIAGNOSTIC_LOGS, {
            correlationId,
            ordinal,
            ok: outcomeOk,
            blockCount: blocksJson.length
          })
        }
        if (phasePath && correlationId && ordinal === 1) {
          recordMainPhaseDuration(correlationId, phasePath, 'echo.mainAppend', elapsedMs(t0))
        }
      }
    }, `appendMessage(${topicId}, ${messageJson.id})`)
    return result
  }

  /**
   * Update a message by ID.
   * Missing target: no-op (returns success).
   * Identity/reparenting fields rejected at contract level.
   * Supported stable field patches enqueue sync intent atomically in the
   * same tx (field patch only; transient statuses skip capture, no failure).
   */
  updateMessage(topicId: string, messageId: string, updatesJson: JsonObject): ChatDbResult<null> {
    return wrapResult(() => {
      const patch = wireToMessagePatch(updatesJson)
      // Strip identity fields (defense in depth — contract already rejects)
      delete patch.id
      delete patch.topicId
      delete patch.sortOrder

      const ctx = this.syncCtx('updateMessage')
      // Empty patch (no mutable keys): no mutation intent; keep read-only.
      if (Object.keys(patch).filter((k) => k !== 'overflow').length === 0 && !patch.overflow) {
        const { messages } = this.repos()
        messages.update(topicId, messageId, patch)
        return null
      }
      let notify = false
      let result: null
      const unsupportedBlockIds: string[] = []
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          // Pre-state for the final-transition rule: only a transient→stable
          // promotion of a never-tracked row creates full initial state.
          // Pre-sync stable rows keep patch-only semantics (established).
          const preRow = ctx ? repos.messages.getInTopic(messageId, topicId) : null
          const preStable = preRow && preRow.found ? isStableMessageStatus(preRow.data.status) : true
          repos.messages.update(topicId, messageId, patch)
          if (ctx) {
            // Post-state proof inside the same tx: missing/foreign targets are
            // repository no-ops or throws — only capture when the owned row
            // survives with the requested topic. Frame inclusion transitions
            // are evaluated regardless of stable capture outcome.
            const row = repos.messages.getInTopic(messageId, topicId)
            if (!row.found) {
              // Message deleted/missing after patch: no frame maintenance (topic frame handled by delete path)
              return null
            }
            const postStable = isStableMessageStatus(row.data.status)
            // Inclusion transition handling (stable↔transient) with truthful membership gating.
            // Entity-first order (F2): the messageBlock frame decision runs
            // once per parent AFTER message/block entity upsert (entity-only
            // rescan, never membership backfill per 009), so a pre-existing
            // stable block lacking membership try-invalidates with 0 op while
            // the user mutation succeeds (candidate truthful partial).
            if (preStable && !postStable) {
              // Stable→transient exclusion (SYNC-DATA-048 errata): transient
              // status never rides the wire, so the frame has no
              // member-exclusion authority — invalidate locally in the same
              // tx with 0 frame op; the user edit still succeeds and the
              // candidate stays truthful partial. Invalidate messageBlock
              // because the parent is excluded.
              syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageId)
              return null
            }
            const isPromotion = !preStable && postStable
            if (!isPromotion) {
              if (preStable && postStable) {
                // Ordinary stable→stable content edits do not advance frames — skip frame maintenance
              } else {
                // Transient→transient: no frame
                return null
              }
            }
            if (!postStable) return null
            this.ensureTopicClosureInTx(stx, topicId, ctx.ts, ctx.deviceId)
            // Final-transition full state (LOCK-PERSONAL-004/005): a
            // never-tracked row promoted from a transient stub by this very
            // update creates its full initial state; all other cases stay
            // patch-only.
            const tracked = syncService.isTrackedEntityInTx(stx, 'message', messageId)
            if (!tracked && !preStable) {
              // Transient->stable promotion of a pre-existing row: emit field-clock
              // snapshot for sync, but never fabricate a parent-membership clock.
              // Only rows inserted by the SAME current transaction with a real
              // creation operation may get membership (appendMessage/bulkAddBlocks).
              syncService.enqueueUpsertInTx(
                stx,
                'message',
                messageId,
                this.syncMessagePayloadFull(row.data),
                ctx.ts,
                ctx.deviceId
              )
              notify = true
              // Promotion backfill: stable blocks committed with the transient
              // stub (appendMessage skips all intent while transient) join this
              // stable checkpoint parent-first. Fail closed on error.
              // Unsupported structured/attachment descendants skip without a
              // partial shell (durable outcome recorded after commit).
              if (
                this.captureUntrackedStableBlocksInTx(
                  stx,
                  repos,
                  messageId,
                  ctx.ts,
                  ctx.deviceId,
                  new Set<string>(),
                  unsupportedBlockIds
                )
              ) {
                notify = true
              }
            } else {
              const payload = this.syncMessagePatchPayload(
                topicId,
                messageId,
                patch as unknown as Record<string, unknown>
              )
              if (payload) {
                syncService.enqueueUpsertInTx(stx, 'message', messageId, payload, ctx.ts, ctx.deviceId)
                notify = true
              }
              // Deterministic rescan (LOCK-PERSONAL-004): every stable message
              // capture re-checks all committed stable descendants against
              // tracked/outbox state, even when the parent is already tracked.
              // A prior partial backfill (fallback child failure) can never be
              // silently abandoned — the next stable promotion retries the
              // remainder. Fail closed on infrastructure error.
              if (
                this.captureUntrackedStableBlocksInTx(
                  stx,
                  repos,
                  messageId,
                  ctx.ts,
                  ctx.deviceId,
                  new Set<string>(),
                  unsupportedBlockIds
                )
              ) {
                notify = true
              }
            }
            // Single per-parent frame decision AFTER all entity
            // work (F2): promotion mints at most one topic frame and one
            // messageBlock try-refresh; only complete trustworthy membership
            // yields exactly 1 op, otherwise truthful invalidate with 0 op
            // (promotion rescan is entity-only, never membership backfill).
            // Stable→stable edits mint nothing.
            if (isPromotion) {
              if (syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId) === 'refreshed') {
                notify = true
              }
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageId, ctx.deviceId) === 'refreshed') {
                notify = true
              }
            }
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('updateMessage', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('updateMessage', unsupportedBlockIds)
      return result
    }, `updateMessage(${topicId}, ${messageId})`)
  }

  /**
   * Atomic message patch + full block upserts + references/order.
   * Missing message: follows Dexie-compatible no-op without weakening FK.
   *
   * When blockIdsToDelete is provided:
   * - Each block ID is resolved through its parent message to verify
   *   topic ownership (LOCK-004). Blocks whose parent message does not
   *   belong to the requested topic are rejected atomically.
   * - File references are collected from owned blocks only before cascade.
   * - Returns FileCleanupResult for caller-side post-commit consumption.
   */
  updateMessageAndBlocks(
    topicId: string,
    messageUpdatesJson: JsonObject,
    blocksToUpdateJson: JsonObject[],
    blockIdsToDelete: string[] = []
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const messageId = messageUpdatesJson.id as string
      const messagePatch = wireToMessagePatch(messageUpdatesJson)
      delete messagePatch.id
      delete messagePatch.topicId
      delete messagePatch.sortOrder

      const blockDataList = blocksToUpdateJson.map(wireToBlock)
      const syncCtx = this.syncCtx('updateMessageAndBlocks')
      let syncNotify = false
      const unsupportedBlockIds: string[] = []

      let txResult: FileCleanupResult
      try {
        txResult = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Check message exists
          const existing = repos.messages.getInTopic(messageId, topicId)
          if (!existing.found) {
            // No-op: follow Dexie-compatible semantics — empty cleanup
            return { affectedFileIds: [], remainingReferenceCounts: {} }
          }

          // Phase 1: Resolve every block through its parent message and verify ownership.
          // Missing blocks follow delete no-op semantics. Existing blocks must belong
          // to the message being updated, not merely to the requested topic.
          let affectedFileIds: string[] = []
          const deletedPreIncluded = new Set<string>()
          if (blockIdsToDelete.length > 0) {
            const ownedBlockIds: string[] = []
            for (const blockId of blockIdsToDelete) {
              const block = repos.blocks.getById(blockId)
              if (!block.found) {
                // Missing block: skip (consistent with no-op semantics)
                continue
              }
              if (block.data.messageId !== messageId) {
                throw new ChatDbConflictError(
                  `Block ${blockId} belongs to message ${block.data.messageId}, cannot delete from message ${messageId}`
                )
              }
              // Resolve block → message → topic ownership
              const msg = repos.messages.getInTopic(block.data.messageId, topicId)
              if (!msg.found) {
                throw new ChatDbConflictError(
                  `Block ${blockId} belongs to message ${block.data.messageId} which is not in topic ${topicId}`
                )
              }
              ownedBlockIds.push(blockId)
            }

            // BEFORE deletion: capture each deletion candidate's actual pre-state inventory inclusion
            // (isStableBlockStatus && !isUnsupportedBlockForSync using parsed overflow fail-closed).
            // Only previously included deletions count as frame membership transitions.
            // Malformed overflow fails closed and rolls back.
            for (const bid of ownedBlockIds) {
              const raw = (tx as unknown as BetterSQLite3Database<typeof schema>)
                .select()
                .from(schema.messageBlocks)
                .where(eq(schema.messageBlocks.id, bid))
                .get() as unknown as
                | { id: string; status: string | null; type: string | null; extra: string | null }
                | undefined
              if (!raw) continue
              let overflow: Record<string, unknown> = {}
              if (raw.extra) {
                try {
                  const parsed = JSON.parse(raw.extra)
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new SyncFrameError(`malformed block extra JSON for ${bid}: not an object`)
                  }
                  overflow = parsed as Record<string, unknown>
                } catch (e) {
                  if (e instanceof SyncFrameError) throw e
                  throw new SyncFrameError(
                    `malformed block extra JSON for ${bid}: ${e instanceof Error ? e.message : String(e)}`
                  )
                }
              }
              const included =
                isStableBlockStatus(raw.status) && !isUnsupportedBlockForSync({ type: raw.type, overflow })
              if (included) deletedPreIncluded.add(bid)
            }

            // Collect affected file IDs from owned blocks only
            if (ownedBlockIds.length > 0) {
              const allRefs: FileReferenceData[] = []
              for (const blockId of ownedBlockIds) {
                const refs = repos.fileRefs.listByBlock(blockId)
                allRefs.push(...refs)
              }
              affectedFileIds = collectAffectedFileIds(allRefs)

              // Delete owned blocks (FK cascade removes file_references)
              repos.blocks.deleteMany(ownedBlockIds)
            }
          }

          // Apply message patch
          if (Object.keys(messagePatch).length > 0) {
            repos.messages.update(topicId, messageId, messagePatch)
          }

          // Upsert blocks (snapshot pre-state for field-patch diffing)
          const preBlockRows = new Map<string, MessageBlockData>()
          if (syncCtx && blockDataList.length > 0) {
            for (const block of blockDataList) {
              const pre = repos.blocks.getById(block.id)
              if (pre.found) preBlockRows.set(block.id, { ...pre.data, overflow: { ...pre.data.overflow } })
            }
          }
          if (blockDataList.length > 0) {
            repos.blocks.upsertMany(blockDataList)

            // Sync file references
            this.syncFileReferences(repos, blockDataList)
          }

          // Transaction-bound sync intent (same atomic boundary).
          if (syncCtx) {
            const deletedOwned: string[] = []
            // Re-resolve owned deletes post-state: surviving rows are no-ops.
            for (const blockId of blockIdsToDelete) {
              if (typeof blockId !== 'string' || blockId.length === 0) continue
              const gone = !repos.blocks.getById(blockId).found
              if (gone && syncService.isKnownEntityInTx(stx, 'message_block', blockId)) deletedOwned.push(blockId)
            }
            const mrow = repos.messages.getInTopic(messageId, topicId)
            if (mrow.found) {
              // Final-transition full state: only a transient→stable promotion
              // of a never-tracked message creates full state; pre-sync stable
              // rows keep patch/diff semantics.
              const messageTracked = syncService.isTrackedEntityInTx(stx, 'message', messageId)
              const preMessageStable = isStableMessageStatus(existing.data.status)
              const isPromotion = !messageTracked && !preMessageStable
              const msgPayload = isPromotion
                ? this.syncMessagePayloadFull(mrow.data)
                : this.diffMessagePayload(existing.data, mrow.data)
              if (msgPayload && isStableMessageStatus(mrow.data.status)) {
                this.ensureTopicClosureInTx(stx, topicId, syncCtx.ts, syncCtx.deviceId)
                // Promotion of pre-existing row must not fabricate membership;
                // only true inserts by same tx get membership (handled in
                // appendMessage/bulkAddBlocks). All promotion paths remain
                // unversioned for parent-membership.
                syncService.enqueueUpsertInTx(stx, 'message', messageId, msgPayload, syncCtx.ts, syncCtx.deviceId)
                syncNotify = true
                // Promotion backfill + deterministic rescan (LOCK-PERSONAL-004):
                // committed stable descendants created with the transient stub
                // (outside this request's block list) join the stable
                // checkpoint parent-first. Every stable message capture
                // rescans all stable descendants against tracked/outbox state,
                // even when the parent is already tracked, so a prior partial
                // backfill is retried instead of silently abandoned.
                // Fail closed on error.
                if (isStableMessageStatus(mrow.data.status)) {
                  const requestedIds = new Set(blockDataList.map((b) => b.id))
                  if (
                    this.captureUntrackedStableBlocksInTx(
                      stx,
                      repos,
                      messageId,
                      syncCtx.ts,
                      syncCtx.deviceId,
                      requestedIds,
                      unsupportedBlockIds
                    )
                  ) {
                    syncNotify = true
                  }
                }
              }
              for (const block of blockDataList) {
                const brow = repos.blocks.getById(block.id)
                if (!brow.found) continue
                if (brow.data.messageId !== messageId) continue
                if (!isStableBlockStatus(brow.data.status)) continue
                if (this.isUnsupportedBlock(brow.data)) {
                  unsupportedBlockIds.push(block.id)
                  continue
                }
                // Field patch via pre/post diff; only a row inserted by the SAME
                // current transaction (pre == null) may get parent-membership.
                // Transient->stable promotion of a pre-existing row remains
                // unversioned for membership (no fabrication).
                const pre = preBlockRows.get(block.id) ?? null
                const blockTracked = syncService.isTrackedEntityInTx(stx, 'message_block', block.id)
                const preBlockStable = pre ? isStableBlockStatus(pre.status) : true
                const isTrueCreate = !pre
                const isPromotion = !isTrueCreate && !blockTracked && !preBlockStable
                const patchPayload =
                  isTrueCreate || isPromotion
                    ? this.syncBlockPayloadFull(brow.data)
                    : this.diffBlockPayload(pre, brow.data)
                if (!patchPayload) continue
                this.ensureBlockParentClosureInTx(stx, block.id, syncCtx.ts, syncCtx.deviceId)
                const blkOpId = syncService.enqueueUpsertInTx(
                  stx,
                  'message_block',
                  block.id,
                  patchPayload,
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                if (isTrueCreate) {
                  syncService.setMembershipClockInTx(
                    stx,
                    'message_block',
                    block.id,
                    brow.data.messageId,
                    syncCtx.ts,
                    blkOpId
                  )
                }
                syncNotify = true
              }
            }
            for (const bid of deletedOwned) {
              syncService.enqueueDeleteInTx(stx, 'message_block', bid, syncCtx.ts, syncCtx.deviceId)
              syncNotify = true
            }
            // Local parent order frame (010) — single per-parent decision (F1):
            // all message/block entity upsert (true-create membership mint
            // plus entity-only promotion rescan, never membership backfill)
            // and delete/transition handling above complete first; then at most
            // one messageBlock tryRefresh+enqueue attempt per tx for this
            // parent. Exclusion (stable→transient parent) only invalidates
            // with 0 op and is never overridden by a tail refresh; a
            // non-stable parent never mints.
            if (syncCtx) {
              // Message inclusion transition (stable ↔ transient) handling for topicMessage and messageBlock
              const preMsgStable = isStableMessageStatus(existing.data.status)
              const mrowForFrame = repos.messages.getInTopic(messageId, topicId)
              const postMsgStable = mrowForFrame.found ? isStableMessageStatus(mrowForFrame.data.status) : false
              let messageTransitionHandled = false
              let promotionNeedsBlockFrame = false
              if (preMsgStable && !postMsgStable) {
                // Stable→transient exclusion (SYNC-DATA-048 errata): transient
                // status never rides the wire, so no frame op is minted —
                // invalidate the topic frame locally in the same tx;
                // invalidate messageBlock because the parent is excluded.
                syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageId)
                messageTransitionHandled = true
              } else if (!preMsgStable && postMsgStable) {
                // Transient→stable inclusion (SYNC-DATA-048 extension):
                // topic frame now; messageBlock defers to the single unified
                // decision below so promotion + true-create/inclusion share
                // exactly one attempt (message op precedes frame).
                if (
                  syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, syncCtx.deviceId) === 'refreshed'
                ) {
                  syncNotify = true
                }
                promotionNeedsBlockFrame = true
                messageTransitionHandled = true
              } else if (preMsgStable && postMsgStable) {
                // Stable→stable: ordinary content edits do not advance topic frame
              } else {
                // Transient→transient: no frame
                messageTransitionHandled = true
              }

              // Block inclusion transitions (stable && supported) — collected
              // here, minted once below. Pure included→included content edits
              // mint nothing. Deletion handling uses pre-state inclusion
              // captured before delete (fail-closed on malformed overflow).
              // Only previously included deletions count;
              // transient/unsupported deletes never mint.
              let hasBlockInclusionChange = false
              if (!messageTransitionHandled) {
                if (deletedPreIncluded.size > 0) {
                  hasBlockInclusionChange = true
                }
              } else if (promotionNeedsBlockFrame && deletedPreIncluded.size > 0) {
                // Promotion tx that also deletes previously included blocks:
                // covered by the single promotion frame below (final order).
                promotionNeedsBlockFrame = true
              }
              // Check block upserts for inclusion changes (existing blocks)
              let hasTrueCreateStrict = false
              for (const b of blockDataList) {
                const pre = preBlockRows.get(b.id) ?? null
                if (!pre) {
                  // True create: if post included, candidate for the single refresh below
                  const brow = repos.blocks.getById(b.id)
                  if (brow.found && isStableBlockStatus(brow.data.status) && !this.isUnsupportedBlock(brow.data)) {
                    hasTrueCreateStrict = true
                  }
                  continue
                }
                const preIncluded = isStableBlockStatus(pre.status) && !this.isUnsupportedBlock(pre)
                const postRow = repos.blocks.getById(b.id)
                const postIncluded = postRow.found
                  ? isStableBlockStatus(postRow.data.status) && !this.isUnsupportedBlock(postRow.data)
                  : false
                if (preIncluded !== postIncluded) {
                  hasBlockInclusionChange = true
                }
              }
              // Unified single messageBlock attempt: promotion, true-create,
              // or inclusion transition share exactly one tryRefresh+enqueue.
              // Exclusion paths (transient/unsupported present) invalidate
              // with 0 op via the try helper since transient/unsupported
              // never rides the wire and frames carry no exclusion authority.
              // Stable→transient parent exclusion above never reaches here.
              const needsBlockFrame = promotionNeedsBlockFrame || hasTrueCreateStrict || hasBlockInclusionChange
              if (needsBlockFrame && !messageTransitionHandled) {
                if (
                  syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageId, syncCtx.deviceId) ===
                  'refreshed'
                ) {
                  syncNotify = true
                }
              } else if (needsBlockFrame && promotionNeedsBlockFrame) {
                if (
                  syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageId, syncCtx.deviceId) ===
                  'refreshed'
                ) {
                  syncNotify = true
                }
              }
              // Ordinary included→included content edits: no frame advance (do nothing)
            }
          }
          return buildFileCleanupResult(repos, affectedFileIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('updateMessageAndBlocks', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('updateMessageAndBlocks', unsupportedBlockIds)
      return txResult
    }, `updateMessageAndBlocks(${topicId}, ${messageUpdatesJson.id})`)
  }

  /**
   * PERF-100: one logical multi-model answer-tab selection.
   *
   * ONE root better-sqlite3 transaction performs the WHOLE selection:
   * 1. Defense-in-depth uniqueness re-check (contract already rejects).
   * 2. Load and validate EVERY supplied message belongs to the topic —
   *    a missing or cross-topic ID throws a typed error and aborts the
   *    transaction (no partial write).
   * 3. Persist `foldSelected` for every supplied message: `true` for the
   *    selected message, `false` for every other supplied ID — exactly one
   *    selected message among the supplied group, atomically.
   *
   * Group coherence (which IDs form one answer group) is the caller's
   * responsibility: the renderer supplies the full answer-group set. This
   * aggregate intentionally does NOT invent askId/role coherence validation
   * (legacy data cannot reliably prove it) — topic ownership + unique set +
   * selected inclusion are the enforceable invariants.
   *
   * No timestamps/content/order changes: `foldSelected` is an existing
   * persisted UI overflow field and the only field touched.
   */
  selectAnswerMessage(topicId: string, selectedMessageId: string, messageIds: string[]): ChatDbResult<null> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('selectAnswerMessage')
      // Defense-in-depth (the shared contract already rejects duplicates and
      // missing selected). Fail early on programmer error before any write.
      const uniqueIds = new Set(messageIds)
      if (uniqueIds.size !== messageIds.length) {
        throw new ChatDbConflictError('Duplicate message IDs in the answer-group selection')
      }
      if (!messageIds.includes(selectedMessageId)) {
        throw new ChatDbConflictError(`Selected message ${selectedMessageId} is not in the supplied answer group`)
      }

      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Phase 1 — validate ownership of every supplied message BEFORE any
        // write. A missing or cross-topic ID aborts the whole transaction.
        for (const id of messageIds) {
          const existing = repos.messages.getInTopic(id, topicId)
          if (!existing.found) {
            throw new ChatDbNotFoundError(`Message ${id} does not belong to topic ${topicId}`)
          }
        }

        // Phase 2 — persist exactly one selected message atomically:
        // foldSelected=true for the selected, false for every other supplied
        // ID. The overflow delta merge preserves all other message fields.
        for (const id of messageIds) {
          repos.messages.update(topicId, id, { overflow: { foldSelected: id === selectedMessageId } })
        }

        // Unsupported structural path (010) — truthful invalidation inside same transaction, no clock mint
        // Local prerequisite only; even though foldSelected does not change order, we invalidate to avoid stale frame.
        syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'topicMessage', topicId)

        return null
      })
    }, `selectAnswerMessage(${topicId})`)
  }

  /**
   * Delete a single message. Only deletes if owned by the specified topic.
   * Missing/foreign IDs: no-op. Delete intent commits atomically in the
   * same tx (known entities only — unknown ids never emit remotely).
   */
  deleteMessage(topicId: string, messageId: string): ChatDbResult<null> {
    return wrapResult(() => {
      const ctx = this.syncCtx('deleteMessage')
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          // Verify ownership before delete
          const existing = repos.messages.getInTopic(messageId, topicId)
          if (!existing.found) return null // no-op for missing/foreign IDs
          const known = ctx ? syncService.isKnownEntityInTx(stx, 'message', messageId) : false
          repos.messages.delete(messageId)
          if (ctx && known) {
            syncService.enqueueDeleteInTx(stx, 'message', messageId, ctx.ts, ctx.deviceId)
            notify = true
          }
          // Local parent order frame (SYNC-DATA-048) — strict refresh plus
          // matching order_frame op reusing the winning frameClock (same tx).
          // Soft-deleted topic still requires its topicMessage frame; only absent/hard-deleted has no frame.
          if (ctx) {
            syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageId)
            const topicRow = repos.topics.getById(topicId)
            if (topicRow.found) {
              if (syncService.refreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId)) {
                notify = true
              }
            }
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteMessage', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `deleteMessage(${topicId}, ${messageId})`)
  }

  /**
   * Delete multiple messages. Only deletes messages owned by the specified topic.
   * Missing/foreign IDs: no-op. Delete intents commit atomically in the same tx.
   */
  deleteMessages(topicId: string, messageIds: string[]): ChatDbResult<null> {
    return wrapResult(() => {
      const ctx = this.syncCtx('deleteMessages')
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          // Filter to messages actually owned by this topic
          const ownedIds: string[] = []
          for (const id of messageIds) {
            const existing = repos.messages.getInTopic(id, topicId)
            if (existing.found) ownedIds.push(id)
          }
          const knownIds = ctx ? ownedIds.filter((id) => syncService.isKnownEntityInTx(stx, 'message', id)) : []
          if (ownedIds.length > 0) {
            repos.messages.deleteMany(ownedIds)
          }
          if (ctx) {
            for (const id of knownIds) {
              syncService.enqueueDeleteInTx(stx, 'message', id, ctx.ts, ctx.deviceId)
              notify = true
            }
          }
          // Local parent order frame (SYNC-DATA-048) — strict refresh plus
          // matching order_frame op reusing the winning frameClock (same tx).
          // Soft-deleted topic still requires its topicMessage frame; only absent/hard-deleted has no frame.
          if (ctx && ownedIds.length > 0) {
            for (const did of ownedIds) {
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', did)
            }
            const topicRow = repos.topics.getById(topicId)
            if (topicRow.found) {
              if (syncService.refreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId)) {
                notify = true
              }
            }
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteMessages', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `deleteMessages(${topicId}, ${messageIds.length} ids)`)
  }

  /**
   * Upsert blocks. Existing order preserved, new blocks append per input order.
   * No reparent. Reference sync for file/image blocks.
   *
   * Atomicity: block upsert + file-reference replacement in one root transaction.
   * All repositories are tx-bound.
   *
   * `diagnostics` is optional measurement-only correlation metadata
   * (LOCK-STREAM-ATTR-001, PERF-STREAM-ATTR-001); never affects persistence.
   */
  updateBlocks(blocksJson: JsonObject[], diagnostics?: StreamWriteDiagnostics): ChatDbResult<null> {
    const isMeasured = isStreamAttrMeasureEnabled() && typeof diagnostics?.correlationId === 'string'
    const t0 = performance.now()
    let convertDurationMs = 0
    let txDurationMs = 0
    let outcomeOk = false
    let blockCount = 0
    let existingBlocks = 0
    let newBlocks = 0
    let changedBlocks = 0
    let unchangedBlocks = 0

    const result = wrapResult(() => {
      const tConvert = performance.now()
      const blockDataList = blocksJson.map(wireToBlock)
      blockCount = blockDataList.length

      // LOCK-STREAM-ATTR-001/003: measurement-only changed-vs-unchanged batch
      // classification. Reads the current row content for each incoming block
      // OUTSIDE the timed transaction window, so the tx timing stays clean.
      // Zero semantic effect; records are closed-field and content-free.
      if (isMeasured && blockDataList.length > 0) {
        const priorRepo = this.repos().blocks
        for (const block of blockDataList) {
          const prior = priorRepo.getById(block.id)
          if (!prior.found) {
            newBlocks += 1
          } else {
            existingBlocks += 1
            if (prior.data.content === block.content) {
              unchangedBlocks += 1
            } else {
              changedBlocks += 1
            }
          }
        }
      }

      const tTx = performance.now()
      // LOCK-STREAM-ATTR-005: record main.convert BEFORE entering the
      // transaction window so it excludes transaction time (the convert is
      // wire->domain mapping done above); main.tx and existing semantics are
      // preserved.
      convertDurationMs = elapsedMs(tConvert)
      const syncCtx = this.syncCtx('updateBlocks')
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      try {
        this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          // Pre-state snapshot for field-patch diffing (same tx, pre-write).
          const preRows = new Map<string, MessageBlockData>()
          if (syncCtx) {
            for (const block of blockDataList) {
              const pre = repos.blocks.getById(block.id)
              if (pre.found) preRows.set(block.id, { ...pre.data, overflow: { ...pre.data.overflow } })
            }
          }
          repos.blocks.upsertMany(blockDataList)

          // Sync file references within the same transaction
          this.syncFileReferences(repos, blockDataList)

          // Transaction-bound sync intent: creates → full union payload;
          // existing → diff field patch at stable checkpoints only. Only a
          // transient→stable promotion of a never-tracked row creates full
          // state; pre-sync stable rows keep patch semantics. Unsupported
          // structured/attachment rows skip without a partial shell.
          if (syncCtx) {
            for (const block of blockDataList) {
              const post = repos.blocks.getById(block.id)
              if (!post.found) continue
              if (!isStableBlockStatus(post.data.status)) continue
              if (this.isUnsupportedBlock(post.data)) {
                unsupportedBlockIds.push(block.id)
                continue
              }
              const pre = preRows.get(block.id) ?? null
              const tracked = syncService.isTrackedEntityInTx(stx, 'message_block', block.id)
              const preStable = pre ? isStableBlockStatus(pre.status) : true
              if (!pre) {
                // True insertion by same tx: trustworthy creation -> membership
                this.ensureBlockParentClosureInTx(stx, block.id, syncCtx.ts, syncCtx.deviceId)
                const opId = syncService.enqueueUpsertInTx(
                  stx,
                  'message_block',
                  block.id,
                  this.syncBlockPayloadFull(post.data),
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                syncService.setMembershipClockInTx(
                  stx,
                  'message_block',
                  block.id,
                  post.data.messageId,
                  syncCtx.ts,
                  opId
                )
                syncNotify = true
                continue
              }
              if (!tracked && !preStable) {
                // Pre-existing transient->stable promotion: emit field snapshot
                // but never fabricate membership (no trustworthy creation op).
                this.ensureBlockParentClosureInTx(stx, block.id, syncCtx.ts, syncCtx.deviceId)
                syncService.enqueueUpsertInTx(
                  stx,
                  'message_block',
                  block.id,
                  this.syncBlockPayloadFull(post.data),
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                syncNotify = true
                continue
              }
              if (post.data.messageId !== pre.messageId) continue
              const patchPayload = this.diffBlockPayload(pre, post.data)
              if (!patchPayload) continue
              this.ensureBlockParentClosureInTx(stx, block.id, syncCtx.ts, syncCtx.deviceId)
              syncService.enqueueUpsertInTx(stx, 'message_block', block.id, patchPayload, syncCtx.ts, syncCtx.deviceId)
              syncNotify = true
            }
          }
          // Ordinary messageBlock inclusion paths issue exactly one frame
          // via the try helper (missing membership invalidates with 0 op
          // while the user mutation succeeds; malformed/MAX_SAFE rolls
          // back). Pure included→included content edits mint nothing.
          // Exclusion (stable→transient/supported→unsupported) never mints:
          // transient/unsupported never rides the wire and frames carry no
          // exclusion authority — invalidate only.
          if (syncCtx) {
            const affectedParentsStrict = new Set<string>()
            const affectedParentsHelper = new Set<string>()
            for (const b of blockDataList) {
              const pre = preRows.get(b.id) ?? null
              const postRow = repos.blocks.getById(b.id)
              if (!postRow.found) continue
              if (!pre) {
                if (isStableBlockStatus(postRow.data.status) && !this.isUnsupportedBlock(postRow.data)) {
                  affectedParentsStrict.add(postRow.data.messageId)
                }
              } else {
                const preIncluded = isStableBlockStatus(pre.status) && !this.isUnsupportedBlock(pre)
                const postIncluded = isStableBlockStatus(postRow.data.status) && !this.isUnsupportedBlock(postRow.data)
                if (preIncluded !== postIncluded) {
                  affectedParentsHelper.add(postRow.data.messageId)
                }
                // Ordinary included→included content edits do not advance — no frame change
              }
            }
            for (const pid of affectedParentsStrict) {
              if (affectedParentsHelper.has(pid)) continue // helper will handle (transition takes precedence)
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, pid, syncCtx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
            for (const pid of affectedParentsHelper) {
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, pid, syncCtx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('updateBlocks', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('updateBlocks', unsupportedBlockIds)
      txDurationMs = elapsedMs(tTx)
      outcomeOk = true
      return null
    }, `updateBlocks(${blocksJson.length} blocks)`)

    // LOCK-STREAM-ATTR-001/005: bounded measurement records fire on success
    // AND failure without swallowing or replacing the original result.
    if (isMeasured) {
      recordStreamAttrRecord({
        channel: 'chatdb:update-blocks',
        stage: 'main.aggregate',
        correlationId: diagnostics.correlationId,
        ordinal: diagnostics.ordinal,
        durationMs: elapsedMs(t0),
        ok: outcomeOk,
        blockCount,
        existingBlocks,
        newBlocks,
        changedBlocks,
        unchangedBlocks
      })
      recordStreamAttrRecord({
        channel: 'chatdb:update-blocks',
        stage: 'main.convert',
        correlationId: diagnostics.correlationId,
        ordinal: diagnostics.ordinal,
        durationMs: convertDurationMs,
        ok: outcomeOk,
        blockCount
      })
      recordStreamAttrRecord({
        channel: 'chatdb:update-blocks',
        stage: 'main.tx',
        correlationId: diagnostics.correlationId,
        ordinal: diagnostics.ordinal,
        durationMs: txDurationMs,
        ok: outcomeOk,
        blockCount
      })
    }
    return result
  }

  /**
   * Update a single block by ID.
   * Missing: no-op. Patch only. Merge existing full block before recomputing
   * reference projection.
   *
   * Atomicity: load/merge/update + file-reference delete/create in one root
   * transaction. All repositories are tx-bound.
   *
   * `diagnostics` is optional measurement-only correlation metadata
   * (LOCK-STREAM-ATTR-001, PERF-STREAM-ATTR-001) carried by the renderer to
   * pair this call's records with the renderer-side serialize/IPC records of
   * the same call. It never affects persistence semantics.
   */
  updateSingleBlock(
    blockId: string,
    updatesJson: JsonObject,
    diagnostics?: StreamWriteDiagnostics
  ): ChatDbResult<null> {
    const isMeasured = isStreamAttrMeasureEnabled() && typeof diagnostics?.correlationId === 'string'
    const t0 = performance.now()
    let convertDurationMs = 0
    let txDurationMs = 0
    let outcomeOk = false
    let contentLength: number | undefined
    let contentChanged: boolean | undefined

    const result = wrapResult(() => {
      const tConvert = performance.now()
      const patch = wireToBlockPatch(updatesJson)
      // Strip identity fields (defense in depth)
      delete patch.id
      delete patch.messageId
      delete patch.sortOrder

      const tTx = performance.now()
      // LOCK-STREAM-ATTR-005: record main.convert BEFORE entering the
      // transaction window so it excludes transaction time (the convert is
      // wire->domain patch mapping done above); main.tx and existing semantics
      // are preserved.
      convertDurationMs = elapsedMs(tConvert)
      const syncCtx = this.syncCtx('updateSingleBlock')
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      try {
        this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          const existing = repos.blocks.getById(blockId)
          if (!existing.found) return // no-op for missing

          // Apply patch to the existing block to get the merged result
          const merged: Record<string, unknown> = { ...existing.data }
          for (const [key, value] of Object.entries(patch)) {
            if (key !== 'overflow') {
              merged[key] = value
            }
          }
          // Merge overflow
          if (patch.overflow) {
            merged.overflow = { ...existing.data.overflow, ...patch.overflow }
          }

          // LOCK-STREAM-ATTR-001/003: measurement-only changed-content vs
          // unchanged-content classification. Values are already in hand (the
          // current row and the merged patch) — zero extra reads, zero semantic
          // effect. Only content-touching updates classify; absent content in
          // the patch leaves the count unset.
          if (isMeasured && Object.prototype.hasOwnProperty.call(patch, 'content')) {
            contentChanged = existing.data.content !== merged.content
            contentLength = typeof merged.content === 'string' ? merged.content.length : 0
          }

          // Apply the update
          repos.blocks.update(existing.data.messageId, blockId, patch)

          // Recompute file references from merged block (same tx)
          const mergedBlock = merged as unknown as MessageBlockData
          const newRefs = projectFileReferences(mergedBlock)
          const oldRefs = repos.fileRefs.listByBlock(blockId)

          // Replace stale references
          if (oldRefs.length > 0) {
            repos.fileRefs.deleteByBlock(blockId)
          }
          if (newRefs.length > 0) {
            repos.fileRefs.createMany(newRefs)
          }

          // Transaction-bound sync intent: only a transient→stable promotion
          // of a never-tracked block creates full state; otherwise intentional
          // patch keys. Transient skips, never a failure. Unsupported
          // structured/attachment rows skip without a partial shell.
          if (syncCtx) {
            const post = repos.blocks.getById(blockId)
            if (post.found && isStableBlockStatus(post.data.status)) {
              if (this.isUnsupportedBlock(post.data)) {
                unsupportedBlockIds.push(blockId)
              } else {
                this.ensureBlockParentClosureInTx(stx, blockId, syncCtx.ts, syncCtx.deviceId)
                const tracked = syncService.isTrackedEntityInTx(stx, 'message_block', blockId)
                const preStable = isStableBlockStatus(existing.data.status)
                if (!tracked && !preStable) {
                  // Pre-existing transient->stable promotion: field sync only,
                  // never fabricate membership (no trustworthy creation op).
                  syncService.enqueueUpsertInTx(
                    stx,
                    'message_block',
                    blockId,
                    this.syncBlockPayloadFull(post.data),
                    syncCtx.ts,
                    syncCtx.deviceId
                  )
                  syncNotify = true
                } else {
                  const payload = this.syncBlockPatchPayload(
                    post.data.messageId,
                    blockId,
                    patch as unknown as Record<string, unknown>
                  )
                  if (payload) {
                    syncService.enqueueUpsertInTx(stx, 'message_block', blockId, payload, syncCtx.ts, syncCtx.deviceId)
                    syncNotify = true
                  }
                }
              }
            }
          }
          // Ordinary messageBlock inclusion transition issues exactly one
          // frame via the try helper (missing membership invalidates with 0
          // op; exclusion invalidates since transient/unsupported never rides
          // the wire). Ordinary included→included content edits mint nothing.
          if (syncCtx) {
            const postRow2 = repos.blocks.getById(blockId)
            if (postRow2.found) {
              const preIncluded = isStableBlockStatus(existing.data.status) && !this.isUnsupportedBlock(existing.data)
              const postIncluded = isStableBlockStatus(postRow2.data.status) && !this.isUnsupportedBlock(postRow2.data)
              if (preIncluded !== postIncluded) {
                if (
                  syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(
                    stx,
                    postRow2.data.messageId,
                    syncCtx.deviceId
                  ) === 'refreshed'
                ) {
                  syncNotify = true
                }
              }
            } else {
              // block deleted via update? treat as invalidation
              const parentId = existing.data.messageId
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', parentId)
            }
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('updateSingleBlock', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('updateSingleBlock', unsupportedBlockIds)
      txDurationMs = elapsedMs(tTx)
      outcomeOk = true
      return null
    }, `updateSingleBlock(${blockId})`)

    // LOCK-STREAM-ATTR-001/005: bounded measurement records fire on success
    // AND failure without swallowing or replacing the original result.
    if (isMeasured) {
      recordStreamAttrRecord({
        channel: 'chatdb:update-single-block',
        stage: 'main.aggregate',
        correlationId: diagnostics.correlationId,
        ordinal: diagnostics.ordinal,
        durationMs: elapsedMs(t0),
        ok: outcomeOk,
        contentLength,
        changed: contentChanged
      })
      recordStreamAttrRecord({
        channel: 'chatdb:update-single-block',
        stage: 'main.convert',
        correlationId: diagnostics.correlationId,
        ordinal: diagnostics.ordinal,
        durationMs: convertDurationMs,
        ok: outcomeOk
      })
      recordStreamAttrRecord({
        channel: 'chatdb:update-single-block',
        stage: 'main.tx',
        correlationId: diagnostics.correlationId,
        ordinal: diagnostics.ordinal,
        durationMs: txDurationMs,
        ok: outcomeOk
      })
    }
    return result
  }

  /**
   * Bulk add blocks (insert-only). Duplicate ID aborts whole batch.
   * Appends in input order. Syncs file references.
   *
   * Atomicity: one root transaction with tx-bound repositories.
   * Duplicate IDs throw ChatDbConflictError (typed).
   */
  bulkAddBlocks(blocksJson: JsonObject[]): ChatDbResult<null> {
    return wrapResult(() => {
      const blockDataList = blocksJson.map(wireToBlock)
      const syncCtx = this.syncCtx('bulkAddBlocks')
      let syncNotify = false
      const unsupportedBlockIds: string[] = []

      try {
        this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Check for duplicate IDs in the batch
          const seenIds = new Set<string>()
          for (const block of blockDataList) {
            if (seenIds.has(block.id)) {
              throw new ChatDbConflictError(`Duplicate block ID in batch: ${block.id}`)
            }
            seenIds.add(block.id)
          }

          // Insert only (not upsert) — createMany will throw on existing IDs
          repos.blocks.createMany(blockDataList)

          // Sync file references
          this.syncFileReferences(repos, blockDataList)

          // Transaction-bound sync intent: stable creations only
          // (LOCK-PERSONAL-004) with per-block ordering offsets. Transient
          // blocks are legitimate skips; unsupported structured/attachment
          // blocks skip without a partial shell; their stable update later
          // records the same durable unsupported outcome with parent closure.
          if (syncCtx) {
            for (let i = 0; i < blockDataList.length; i++) {
              const bid = blockDataList[i].id
              const childTs = syncCtx.ts + i
              const brow = repos.blocks.getById(bid)
              if (!brow.found) throw new Error(`bulkAddBlocks block ${bid} missing in transaction`)
              if (!isStableBlockStatus(brow.data.status)) continue
              if (this.isUnsupportedBlock(brow.data)) {
                unsupportedBlockIds.push(bid)
                continue
              }
              this.ensureBlockParentClosureInTx(stx, bid, childTs, syncCtx.deviceId)
              const opId = syncService.enqueueUpsertInTx(
                stx,
                'message_block',
                bid,
                this.syncBlockPayloadFull(brow.data),
                childTs,
                syncCtx.deviceId
              )
              syncService.setMembershipClockInTx(stx, 'message_block', bid, brow.data.messageId, childTs, opId)
              syncNotify = true
            }
          }
          // Ordinary bulk stable-supported creates issue exactly one
          // messageBlock frame per affected stable parent via the try helper
          // (missing membership invalidates with 0 op while the user mutation
          // succeeds; malformed/MAX_SAFE rolls back).
          if (syncCtx) {
            const affectedParents = new Set<string>()
            for (const b of blockDataList) {
              const brow = repos.blocks.getById(b.id)
              if (brow.found && isStableBlockStatus(brow.data.status) && !this.isUnsupportedBlock(brow.data)) {
                affectedParents.add(brow.data.messageId)
              }
            }
            for (const pid of affectedParents) {
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, pid, syncCtx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('bulkAddBlocks', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('bulkAddBlocks', unsupportedBlockIds)

      return null
    }, `bulkAddBlocks(${blocksJson.length} blocks)`)
  }

  /**
   * Delete blocks by IDs. Missing: no-op.
   *
   * Atomicity: one root transaction. FK cascade handles file_references
   * cleanup (file_references.blockId → messageBlocks.id ON DELETE CASCADE).
   * No pre-transaction destructive reference deletes.
   * Normalize affected message block order via repository.
   * Known-entity deletes enqueue intent atomically in the same tx.
   */
  deleteBlocks(blockIds: string[]): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const syncCtx = this.syncCtx('deleteBlocks')
      let syncNotify = false
      let result: FileCleanupResult
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const knownIds = syncCtx
            ? blockIds.filter(
                (bid) =>
                  typeof bid === 'string' && bid.length > 0 && syncService.isKnownEntityInTx(stx, 'message_block', bid)
              )
            : []
          // Collect affected parent messageIds before deletion, but only when
          // the deleted row was previously inventory-included
          // (stable + supported). Transient/unsupported deletes never mint:
          // they only invalidate via the try helper's excluded check.
          const affectedParentIds = new Set<string>()
          for (const bid of blockIds) {
            const blk = repos.blocks.getById(bid)
            if (blk.found && isStableBlockStatus(blk.data.status) && !this.isUnsupportedBlock(blk.data)) {
              affectedParentIds.add(blk.data.messageId)
            }
          }
          const affectedFileIds = collectAffectedFileIds(
            blockIds.flatMap((blockId) => repos.fileRefs.listByBlock(blockId))
          )
          // blocks.deleteMany handles order normalization within its own
          // savepoint transaction. FK cascade removes file_references.
          repos.blocks.deleteMany(blockIds)
          if (syncCtx) {
            for (const bid of knownIds) {
              if (repos.blocks.getById(bid).found) continue // surviving row = no-op, never a remote delete
              syncService.enqueueDeleteInTx(stx, 'message_block', bid, syncCtx.ts, syncCtx.deviceId)
              syncNotify = true
            }
          }
          // Ordinary block deletes issue exactly one messageBlock frame per
          // surviving stable parent via the try helper (missing membership
          // invalidates with 0 op; malformed/MAX_SAFE rolls back). Deleted
          // parent or transient parent only invalidates.
          if (syncCtx && affectedParentIds.size > 0) {
            for (const pid of affectedParentIds) {
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, pid, syncCtx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          }
          return buildFileCleanupResult(repos, affectedFileIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteBlocks', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      return result
    }, `deleteBlocks(${blockIds.length} blocks)`)
  }

  // =========================================================================
  // Phase 5.1A: Segment commands
  // =========================================================================

  /**
   * List all segments for a topic with ordered messageIds.
   * Each segment's messageIds are reconstructed from topic_segment_messages sort_order.
   */
  listSegments(topicId: string): ChatDbResult<SegmentWire[]> {
    return wrapResult(() => {
      const repos = this.repos()
      const segments = repos.segments.listByTopic(topicId)
      return segments.map((seg) => {
        const messageIds = repos.segments.getMessageIds(seg.id)
        return segmentToWire(seg, messageIds)
      })
    }, `listSegments(${topicId})`)
  }

  /**
   * Atomically upsert a segment with metadata and ordered membership.
   * - Creates segment if absent, updates metadata if present.
   * - Replaces message membership atomically in one transaction.
   * - Empty membership deletes the segment per repository semantics.
   */
  upsertSegment(
    segmentId: string,
    topicId: string,
    name: string | null | undefined,
    messageIds: string[],
    color: string | null | undefined
  ): ChatDbResult<SegmentWire> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('upsertSegment')
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Ensure topic exists
        repos.topics.ensure(topicId)

        // Build segment data
        const overflow: Record<string, unknown> = {}
        if (color !== undefined && color !== null) {
          overflow.color = color
        }

        const existing = repos.segments.getById(segmentId)
        if (existing.found) {
          // Update metadata
          const patch: Record<string, unknown> = {}
          if (name !== undefined) patch.name = name
          if (color !== undefined) patch.overflow = overflow
          if (Object.keys(patch).length > 0) {
            repos.segments.updateMetadata(segmentId, patch as any)
          }
        } else {
          // Create new segment
          repos.segments.create({
            id: segmentId,
            topicId,
            name: name ?? null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sortOrder: 0,
            overflow
          })
        }

        // Replace membership atomically
        repos.segments.replaceMessageIds(segmentId, messageIds)

        // Read back the result
        const segment = repos.segments.getById(segmentId)
        if (!segment.found) {
          // Segment was deleted (empty membership) — return empty wire
          return {
            id: segmentId,
            topicId,
            name: name ?? null,
            messageIds: [],
            color: color ?? undefined,
            createdAt: null,
            updatedAt: null
          }
        }

        const finalMessageIds = repos.segments.getMessageIds(segmentId)
        return segmentToWire(segment.data, finalMessageIds)
      })
    }, `upsertSegment(${segmentId}, ${topicId})`)
  }

  /**
   * Update segment metadata (name, color). No membership change.
   * Missing segment: throws ChatDbNotFoundError → ERR_NOT_FOUND.
   * Returns the updated segment wire.
   */
  updateSegmentMetadata(
    segmentId: string,
    name: string | null | undefined,
    color: string | null | undefined
  ): ChatDbResult<SegmentWire> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('updateSegmentMetadata')
      const repos = this.repos()
      const existing = repos.segments.getById(segmentId)
      if (!existing.found) {
        throw new ChatDbNotFoundError(`Segment ${segmentId} does not exist`)
      }

      const patch: Record<string, unknown> = {}
      if (name !== undefined) patch.name = name
      if (color !== undefined) {
        patch.overflow = { ...existing.data.overflow, color }
      }
      if (Object.keys(patch).length > 0) {
        repos.segments.updateMetadata(segmentId, patch as any)
      }

      // Read back
      const updated = repos.segments.getById(segmentId)
      if (!updated.found) {
        // Defensive: segment was deleted between getById and updateMetadata
        // within the same operation. Should not happen in practice.
        throw new ChatDbNotFoundError(`Segment ${segmentId} was deleted during update`)
      }
      const messageIds = repos.segments.getMessageIds(segmentId)
      return segmentToWire(updated.data, messageIds)
    }, `updateSegmentMetadata(${segmentId})`)
  }

  /**
   * Delete a segment. Missing: no-op.
   */
  deleteSegment(segmentId: string): ChatDbResult<null> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('deleteSegment')
      const { segments } = this.repos()
      segments.delete(segmentId)
      return null
    }, `deleteSegment(${segmentId})`)
  }

  /**
   * Replace segment message IDs atomically.
   * Empty membership deletes the segment per repository semantics.
   * Returns the updated segment wire, or null if segment was deleted.
   */
  replaceSegmentMembership(segmentId: string, messageIds: string[]): ChatDbResult<SegmentWire | null> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('replaceSegmentMembership')
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        repos.segments.replaceMessageIds(segmentId, messageIds)

        const segment = repos.segments.getById(segmentId)
        if (!segment.found) return null

        const finalMessageIds = repos.segments.getMessageIds(segmentId)
        return segmentToWire(segment.data, finalMessageIds)
      })
    }, `replaceSegmentMembership(${segmentId})`)
  }

  // =========================================================================
  // Phase 5.1A: Message reorder
  // =========================================================================

  /**
   * Reorder all messages in a topic atomically.
   * Validates exact membership and dense order via repository.
   * Unsupported structural path (010): truthful invalidation inside same transaction — delete stale
   * topicMessage frame rather than leave stale valid-looking state. Do not mint clocks or outbox.
   */
  reorderMessages(topicId: string, messageIds: string[]): ChatDbResult<null> {
    return wrapResult(() => {
      const ctx = this.syncCtx('reorderMessages')
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          repos.messages.replaceOrder(topicId, messageIds)
          // Incremental order_frame issuance (SYNC-DATA-048): with complete
          // stored membership, mint/persist the winning frame and enqueue the
          // matching order_frame reusing that clock (same tx). With missing
          // membership, truthfully invalidate without any op and keep the
          // user reorder successful (existing tryRefreshOrInvalidate semantics).
          if (ctx) {
            const outcome = syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(
              tx as unknown as SyncTxExecutor,
              topicId,
              ctx.deviceId
            )
            if (outcome === 'refreshed') notify = true
          } else {
            syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'topicMessage', topicId)
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('reorderMessages', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `reorderMessages(${topicId})`)
  }

  // =========================================================================
  // Phase 5.1A: File reference queries (read-only)
  // =========================================================================

  /**
   * List file references by file ID. Read-only.
   */
  listFileRefsByFile(fileId: string): ChatDbResult<FileReferenceWire[]> {
    return wrapResult(() => {
      const { fileRefs } = this.repos()
      const refs = fileRefs.listByFile(fileId)
      return refs.map(fileReferenceToWire)
    }, `listFileRefsByFile(${fileId})`)
  }

  /**
   * Count file references by file ID. Read-only.
   */
  countFileRefsByFile(fileId: string): ChatDbResult<number> {
    return wrapResult(() => {
      const { fileRefs } = this.repos()
      return fileRefs.countByFile(fileId)
    }, `countFileRefsByFile(${fileId})`)
  }

  /**
   * List blocks associated with a file via file_references. Read-only.
   */
  listBlocksByFile(fileId: string): ChatDbResult<JsonObject[]> {
    return wrapResult(() => {
      const repos = this.repos()
      const blocks = repos.blocks.findByFileId(fileId)
      return blocksToWire(blocks)
    }, `listBlocksByFile(${fileId})`)
  }

  // =========================================================================
  // Phase 5.1B: Topic lifecycle
  // =========================================================================

  /**
   * Update topic metadata. Mutable fields: name (column), pinned/prompt/
   * isNameManuallyEdited (overflow). updatedAt is maintained consistently.
   * Identity fields (id, assistantId, createdAt, deletedAt, messages) are
   * NOT mutable through this path.
   *
   * Returns ERR_NOT_FOUND if topic does not exist.
   */
  updateTopicMetadata(
    topicId: string,
    name?: string | null,
    pinned?: boolean | null,
    prompt?: string | null,
    isNameManuallyEdited?: boolean | null
  ): ChatDbResult<JsonObject> {
    return wrapResult(() => {
      const ctx = this.syncCtx('updateTopicMetadata')
      let notify = false
      let result: JsonObject
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          const existing = repos.topics.getById(topicId)
          if (!existing.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }

          // Build patch from allowed fields
          const patch: Record<string, unknown> = {}
          if (name !== undefined) patch.name = name
          if (pinned !== undefined) patch.pinned = pinned
          if (prompt !== undefined) patch.prompt = prompt
          if (isNameManuallyEdited !== undefined) patch.isNameManuallyEdited = isNameManuallyEdited

          if (Object.keys(patch).length === 0) {
            // No-op: return current state
            return topicToWireFull(existing.data)
          }

          // Maintain updatedAt consistently
          patch.updatedAt = new Date().toISOString()

          // Split into columns vs overflow
          const domainPatch: Record<string, unknown> = {}
          const overflowDelta: Record<string, unknown> = {}

          if ('name' in patch || 'updatedAt' in patch) {
            if ('name' in patch) domainPatch.name = patch.name
            domainPatch.updatedAt = patch.updatedAt
          }
          if ('pinned' in patch) overflowDelta.pinned = patch.pinned
          if ('prompt' in patch) overflowDelta.prompt = patch.prompt
          if ('isNameManuallyEdited' in patch) overflowDelta.isNameManuallyEdited = patch.isNameManuallyEdited

          // Merge overflow into existing topic
          const mergedOverflow = { ...existing.data.overflow, ...overflowDelta }
          // Remove keys with OVERFLOW_REMOVE sentinel
          for (const [k, v] of Object.entries(overflowDelta)) {
            if (v === undefined) delete mergedOverflow[k]
          }

          repos.topics.updatePatch(topicId, {
            ...domainPatch,
            overflow: mergedOverflow
          } as any)

          // Read back
          const updated = repos.topics.getById(topicId)
          if (!updated.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} was deleted during update`)
          }
          // Transaction-bound sync intent: intentional patch keys only.
          if (ctx) {
            const payload: Record<string, unknown> = { id: topicId }
            for (const k of Object.keys(patch)) {
              if (
                k === 'name' ||
                k === 'pinned' ||
                k === 'prompt' ||
                k === 'isNameManuallyEdited' ||
                k === 'updatedAt'
              ) {
                const v = patch[k]
                if (v !== undefined) payload[k] = v
              }
            }
            syncService.enqueueUpsertInTx(stx, 'topic', topicId, payload, ctx.ts, ctx.deviceId)
            notify = true
          }
          return topicToWireFull(updated.data)
        })
      } catch (e) {
        this.recordSyncTxFailure('updateTopicMetadata', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `updateTopicMetadata(${topicId})`)
  }

  /**
   * Soft-delete a topic by setting deletedAt.
   * Missing topic: no-op (returns success). Intent commits atomically.
   */
  softDeleteTopic(topicId: string, name?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const ctx = this.syncCtx('softDeleteTopic')
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const before = repos.topics.getById(topicId)
          repos.topics.softDelete(topicId, name)
          if (ctx && before.found) {
            const after = repos.topics.getById(topicId)
            if (after.found && after.data.deletedAt != null) {
              const payload: Record<string, unknown> = { id: topicId, deletedAt: after.data.deletedAt }
              if (name !== undefined) payload.name = after.data.name
              syncService.enqueueUpsertInTx(stx, 'topic', topicId, payload, ctx.ts, ctx.deviceId)
              notify = true
            }
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('softDeleteTopic', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `softDeleteTopic(${topicId})`)
  }

  /**
   * Atomically restore a soft-deleted topic and return the restored wire
   * entity (LOCK-532). Returns null when no soft-deleted row exists for the
   * ID at command time (missing topic, or topic not in trash) — in that
   * case NO mutation occurs. Callers must dispatch only the returned row,
   * never a separately listed snapshot. Intent commits atomically.
   */
  restoreTopic(topicId: string): ChatDbResult<JsonObject | null> {
    return wrapResult(() => {
      const ctx = this.syncCtx('restoreTopic')
      let notify = false
      let result: JsonObject | null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          const existing = repos.topics.getById(topicId)
          if (!existing.found || existing.data.deletedAt == null) {
            // No deleted row was restored — explicit null, no mutation.
            return null
          }

          repos.topics.restore(topicId)

          const restored = repos.topics.getById(topicId)
          if (!restored.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} disappeared during restore`)
          }
          if (ctx) {
            // Explicit null deletedAt is intent to clear (payload-key semantics).
            syncService.enqueueUpsertInTx(stx, 'topic', topicId, { id: topicId, deletedAt: null }, ctx.ts, ctx.deviceId)
            notify = true
          }
          return topicToWireFull(restored.data)
        })
      } catch (e) {
        this.recordSyncTxFailure('restoreTopic', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `restoreTopic(${topicId})`)
  }

  /**
   * List soft-deleted topics with optional assistant filter.
   * DeletedAt descending with deterministic tie-break (id ascending).
   * Returns paginated result.
   */
  listTrashTopics(
    assistantId?: string,
    limit?: number,
    cursor?: string
  ): ChatDbResult<{ items: JsonObject[]; nextCursor?: string; hasMore: boolean }> {
    return wrapResult(() => {
      const { topics } = this.repos()
      const page = topics.listTrashPage(
        { limit: limit ?? 20, direction: 'desc', cursor },
        assistantId ? { assistantId } : undefined
      )
      return {
        items: page.items.map(topicToWireFull),
        // Omit nextCursor entirely on the last page: `undefined` is not a
        // valid JSON wire value and fails result envelope validation.
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
        hasMore: page.hasMore
      }
    }, `listTrashTopics()`)
  }

  /**
   * Hard-delete a topic with full FK cascade (messages → blocks →
   * file_references, segments → memberships). Returns file cleanup facts.
   *
   * Uses root transaction: collect affected file IDs before cascade,
   * then delete topic, then compute remaining counts.
   *
   * Missing topic: no-op with empty cleanup result.
   */
  hardDeleteTopic(topicId: string): ChatDbResult<HardDeleteTopicResponse> {
    return wrapResult(() => {
      // LOCK-004: exact deleted topic IDs are collected inside the transaction.
      const deletedTopicIds: string[] = []
      const ctx = this.syncCtx('hardDeleteTopic')
      let syncNotify = false
      let cleanup: { affectedFileIds: string[]; remainingReferenceCounts: Record<string, number> }
      try {
        cleanup = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Check topic exists
          const existing = repos.topics.getById(topicId)
          if (!existing.found) {
            return { affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: [] }
          }
          const known = ctx ? syncService.isKnownEntityInTx(stx, 'topic', topicId) : false
          deletedTopicIds.push(topicId)

          // Collect affected file IDs and descendant message IDs before cascade for frame invalidation
          const messages = repos.messages.listByTopic(topicId)
          const messageIds = messages.map((m) => m.id)
          const refsBeforeDelete = repos.fileRefs.listByMessages(messageIds)
          const affectedFileIds = collectAffectedFileIds(refsBeforeDelete)

          // Local parent order frame (010): atomically invalidate topicMessage frame plus every descendant messageBlock frame before cascade.
          // Collect descendant message IDs before cascade and invalidate frames inside same transaction, no clock mint.
          for (const mid of messageIds) {
            syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
          }
          syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)

          // FK cascade: topic → messages → blocks → file_references
          // Also topic → topic_segments → topic_segment_messages
          repos.topics.hardDelete(topicId)

          // Transaction-bound sync intent: hard-delete tombstone in the same
          // atomic boundary (known entities only — unknown ids never emit).
          if (ctx && known) {
            syncService.enqueueDeleteInTx(stx, 'topic', topicId, ctx.ts, ctx.deviceId)
            syncNotify = true
          }

          // Compute remaining counts after cascade
          return buildFileCleanupResult(repos, affectedFileIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('hardDeleteTopic', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()

      // LOCK-004: clean ordinary-chat traces after the DB commit, using the
      // exact deleted topic IDs. Cleanup failure is logged and non-fatal; it
      // never changes the returned committed result. A failed transaction
      // throws before this point, so post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      return { ...cleanup, deletedTopicIds: [...deletedTopicIds] }
    }, `hardDeleteTopic(${topicId})`)
  }

  /**
   * Purge all soft-deleted topics whose effective retention start is
   * strictly earlier than the cutoff. All eligible topics are purged
   * atomically in one transaction. Returns aggregated file cleanup facts
   * across all purged topics.
   *
   * Per LOCK-5113: the cutoff is generated by the caller. No Main timer.
   *
   * L2 imported-trash retention (LOCK-TRASH-6/7/10):
   * - The effective retention start is max(parsed original deletedAt,
   *   parsed valid `l2TrashRetentionStartedAt` marker) — a fresh importer
   *   baseline gives every L2-imported soft-deleted topic a five-day
   *   recovery window from that baseline, while preserving the source
   *   deletedAt.
   * - Missing markers / L3 legacy data use deletedAt exactly as before.
   * - An invalid marker falls back to deletedAt and is counted; exactly one
   *   count-only loggerService warning is emitted after a successful purge
   *   when the count is > 0 (LOCK-TRASH-7) — never on a failed transaction,
   *   never with IDs/marker values/paths/content.
   * - All keyset pages are drained even when retained rows dominate.
   * - Parsing is fail-safe (LOCK-TRASH-10): a malformed/non-object `extra`
   *   is an invalid-marker fallback (never an abort), an unparseable
   *   deletedAt retains the topic, and an invalid cutoff rejects with the
   *   existing typed validation semantics (ERR_VALIDATION).
   * - LOCK-TRASH-13: the cutoff must be a strict canonical UTC ISO timestamp
   *   with milliseconds (identical to the shared IPC contract); a parseable
   *   but non-canonical value also rejects as ERR_VALIDATION.
   * - LOCK-PRIV-TRASH: the cutoff value never appears in the validation
   *   message, the wrapResult context, or any log — fixed static text only.
   */
  purgeExpiredTopics(cutoffTimestamp: string): ChatDbResult<PurgeExpiredTopicsResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('purgeExpiredTopics')
      // LOCK-TRASH-10/13: the cutoff is caller-generated and shared-validated
      // at the IPC boundary; a fail-safe strict parse here rejects an invalid
      // cutoff with the existing typed validation semantics. LOCK-TRASH-13:
      // the cutoff must be a strict canonical UTC ISO timestamp with
      // milliseconds — identical to the shared IPC contract — so a parseable
      // but non-canonical value (missing `.sssZ`, date-only, offset timezone)
      // also rejects as ERR_VALIDATION. LOCK-PRIV-TRASH: fixed static message
      // and context — the cutoff value NEVER appears in the validation error,
      // the wrapResult context, or any log. Epoch-ms comparison only — never
      // lexical date comparison (LOCK-TRASH-5).
      const cutoffMs = parseStrictCanonicalIsoMs(cutoffTimestamp)
      if (cutoffMs === null) {
        throw new ChatDbValidationError(
          'Invalid purge cutoff: expected a strict canonical UTC ISO timestamp with milliseconds (YYYY-MM-DDTHH:mm:ss.sssZ).'
        )
      }

      // LOCK-TRASH-7: invalid-marker count accumulated transactionally and
      // emitted (exactly one count-only warning) only after a successful
      // purge. A failed transaction rolls back and emits no warning.
      let invalidMarkerCount = 0

      // LOCK-004: exact deleted topic IDs collected inside the transaction.
      const deletedTopicIds: string[] = []

      const cleanup = this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // List ALL deleted topics, paginating internally (LOCK-TRASH-7: the
        // drain continues past pages where retained rows dominate).
        const allAffectedFileIds: string[] = []
        let cursor: string | undefined
        let hasMore = true

        while (hasMore) {
          // LOCK-TRASH-10: narrow raw retention-page seam — id/deletedAt/extra
          // only, so malformed extra can never abort the purge.
          const page = repos.topics.listTrashRetentionPage({ limit: 100, direction: 'desc', cursor })

          for (const topic of page.items) {
            if (topic.deletedAt === null) continue

            const decision = computeTrashRetentionDecision(topic.deletedAt, topic.extra)
            // Unparseable deletedAt → retained (fail-safe, never hard-delete
            // a row whose age cannot be determined).
            if (decision === null) continue
            if (decision.invalidMarker) invalidMarkerCount += 1
            // Strictly earlier effective start required (LOCK-TRASH-6):
            // equal-to-cutoff rows are retained (matches the documented
            // `deletedAt < cutoff` semantics).
            if (decision.effectiveStartMs >= cutoffMs) continue

            // Collect affected file IDs and descendant frames before cascade
            const messages = repos.messages.listByTopic(topic.id)
            const messageIds = messages.map((m) => m.id)
            const refs = repos.fileRefs.listByMessages(messageIds)
            const ids = collectAffectedFileIds(refs)
            allAffectedFileIds.push(...ids)

            deletedTopicIds.push(topic.id)

            // Local frame invalidation (010): atomically invalidate topicMessage and every descendant messageBlock frame, no clock mint.
            // Sync-unaware hard-delete lifecycle path — no outbox.
            const stx = tx as unknown as SyncTxExecutor
            for (const mid of messageIds) {
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
            }
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', topic.id)

            // FK cascade: hard delete
            repos.topics.hardDelete(topic.id)
          }

          cursor = page.nextCursor
          hasMore = page.hasMore && page.items.length > 0
        }

        // Deduplicate affected file IDs and compute remaining counts
        const uniqueAffectedIds = [...new Set(allAffectedFileIds)]
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })

      // LOCK-004: clean ordinary-chat traces after the DB commit for the exact
      // purged topic IDs. Cleanup failure is logged and non-fatal; it never
      // changes the returned committed result. A failed transaction throws
      // before this point, so post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      // LOCK-TRASH-7: exactly one count-only warning after a successful
      // purge, only when invalid markers were observed. No IDs, marker
      // values, paths, or content.
      if (invalidMarkerCount > 0) {
        loggerService
          .withContext('ChatDbAggregate')
          .warn(
            `Trash purge: ${invalidMarkerCount} imported-topic retention marker(s) were invalid ` +
              'and fell back to deletedAt retention (LOCK-TRASH-7).'
          )
      }

      return { ...cleanup, deletedTopicIds: [...deletedTopicIds] }
    }, `purgeExpiredTopics()`)
  }

  /**
   * Empty an assistant's trash atomically (LOCK-531).
   *
   * ONE root SQLite transaction hard-deletes every topic of the assistant
   * that is still soft-deleted at transaction time (FK cascade: messages →
   * blocks → file_references, segments → memberships) and returns one
   * aggregate FileCleanupResult. Any mid-operation failure rolls back the
   * entire transaction — no partial commit.
   */
  emptyTrashTopics(assistantId: string): ChatDbResult<EmptyTrashTopicsResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('emptyTrashTopics')
      // LOCK-004: exact deleted topic IDs collected inside the transaction.
      const deletedTopicIds: string[] = []

      const cleanup = this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        const allAffectedFileIds: string[] = []
        let cursor: string | undefined
        let hasMore = true

        // Drain the assistant's trash pages inside the transaction. Deleting
        // listed rows is safe with keyset pagination: the next page is
        // selected relative to the cursor tuple, not to row offsets.
        while (hasMore) {
          const page = repos.topics.listTrashPage({ limit: 100, direction: 'desc', cursor }, { assistantId })

          for (const topic of page.items) {
            // Collect affected file IDs and descendant frames before cascade
            const messages = repos.messages.listByTopic(topic.id)
            const messageIds = messages.map((m) => m.id)
            const refs = repos.fileRefs.listByMessages(messageIds)
            allAffectedFileIds.push(...collectAffectedFileIds(refs))

            deletedTopicIds.push(topic.id)

            // Local frame invalidation (010): atomically invalidate topicMessage and every descendant messageBlock frame, no clock mint.
            const stx = tx as unknown as SyncTxExecutor
            for (const mid of messageIds) {
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
            }
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', topic.id)

            // FK cascade: hard delete
            repos.topics.hardDelete(topic.id)
          }

          cursor = page.nextCursor
          hasMore = page.hasMore && page.items.length > 0
        }

        // Deduplicate affected file IDs and compute remaining counts
        const uniqueAffectedIds = [...new Set(allAffectedFileIds)]
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })

      // LOCK-004: clean ordinary-chat traces after the DB commit for the exact
      // emptied topic IDs. Cleanup failure is logged and non-fatal; it never
      // changes the returned committed result. A failed transaction throws
      // before this point, so post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      return { ...cleanup, deletedTopicIds: [...deletedTopicIds] }
    }, `emptyTrashTopics(${assistantId})`)
  }

  transferTopicOwnership(topicId: string, assistantId: string): ChatDbResult<null> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('transferTopicOwnership')
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(topicId)
        if (!topic.found) throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        repos.topics.updatePatch(topicId, { assistantId } as any)
        for (const message of repos.messages.listByTopic(topicId)) {
          repos.messages.update(topicId, message.id, { assistantId } as any)
        }
      })
      return null
    }, `transferTopicOwnership(${topicId}, ${assistantId})`)
  }

  resetAssistantTopics(assistantId: string, replacementTopicId: string): ChatDbResult<ResetAssistantTopicsResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('resetAssistantTopics')
      // LOCK-004: exact hard-deleted topic IDs are collected inside the
      // transaction; the replacement topic is excluded from both deletion
      // and trace cleanup.
      const deletedTopicIds: string[] = []
      const result = this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const affectedFileIds: string[] = []
        let activeCursor: string | undefined
        let trashCursor: string | undefined
        let hasMoreActive = true
        let hasMoreTrash = true
        while (hasMoreActive || hasMoreTrash) {
          const activePage = hasMoreActive
            ? repos.topics.listPage({ limit: 100, direction: 'asc', cursor: activeCursor })
            : { items: [], nextCursor: undefined, hasMore: false }
          const trashPage = hasMoreTrash
            ? repos.topics.listTrashPage({ limit: 100, direction: 'asc', cursor: trashCursor })
            : { items: [], nextCursor: undefined, hasMore: false }
          for (const topic of [...activePage.items, ...trashPage.items]) {
            if (topic.assistantId !== assistantId || topic.id === replacementTopicId) continue
            const messageIds = repos.messages.listByTopic(topic.id).map((message) => message.id)
            affectedFileIds.push(...collectAffectedFileIds(repos.fileRefs.listByMessages(messageIds)))
            deletedTopicIds.push(topic.id)
            // Local frame invalidation (010): atomically invalidate topicMessage and every descendant messageBlock frame, no clock mint.
            const stx2 = tx as unknown as SyncTxExecutor
            for (const mid of messageIds) {
              syncService.invalidateParentFrameInTx(stx2, 'messageBlock', mid)
            }
            syncService.invalidateParentFrameInTx(stx2, 'topicMessage', topic.id)
            repos.topics.hardDelete(topic.id)
          }
          activeCursor = activePage.nextCursor
          trashCursor = trashPage.nextCursor
          hasMoreActive = activePage.hasMore && activePage.items.length > 0
          hasMoreTrash = trashPage.hasMore && trashPage.items.length > 0
        }
        const replacementTopic = repos.topics.ensure(replacementTopicId, assistantId)
        return {
          cleanup: buildFileCleanupResult(repos, [...new Set(affectedFileIds)]),
          replacementTopic: topicToWireFull(replacementTopic) as unknown as TopicWire,
          deletedTopicIds: [...deletedTopicIds]
        }
      })

      // LOCK-004: clean ordinary-chat traces after the DB commit for the exact
      // hard-deleted topic IDs (the replacement topic is excluded). Cleanup
      // failure is logged and non-fatal; it never changes the returned
      // committed result. A failed transaction throws before this point, so
      // post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      return result
    }, `resetAssistantTopics(${assistantId})`)
  }

  // =========================================================================
  // Phase 5.1B: Compound mutations
  // =========================================================================

  /**
   * Atomically ensure/create a target topic and insert ordered
   * messages+blocks. Each entry is a message with its blocks, appended
   * in array order. File references are synced for all file/image blocks.
   *
   * Rejects any existing message ID that is owned by a different topic.
   *
   * Linear batch semantics (LOCK-002): all NEW messages are converted and
   * classified first, then inserted in ONE `appendMany` batch with a single
   * final dense-order normalization per topic — never one per-message
   * full-topic normalization. Existing (same-topic) entries preserve their
   * position and only receive a metadata patch, exactly as before.
   *
   * Phase-4 block side effects (block upserts + file-reference syncs) run
   * in the ORIGINAL request entry order (audit F1): the new/existing
   * classification never reorders them into new-before-existing, so rare
   * cross-entry block-ID collisions keep the same last-writer as the legacy
   * per-entry loop.
   *
   * Atomicity: one root SQLite transaction (LOCK-001).
   */
  /**
   * S6.2c-1: Main-authoritative branch by stable message anchor.
   *
   * One atomic Main DB transaction:
   * - validates source topic exists
   * - ensures target (create-only, compat)
   * - validates anchor belongs to source
   * - loads source ordered by sort_order ASC, id ASC (listByTopic)
   * - selects prefix through anchor inclusive
   * - clones messages/blocks with fresh IDs preserving order/content/status/overflow/file refs
   * - remaps askId exactly as renderer branch behavior (to cloned parent when included, otherwise unset)
   * - inserts into target atomically using dense order semantics (appendMany)
   * - returns actual cloned wire messages/blocks for renderer projection, no hidden second read
   *
   * Missing/cross-topic anchor fails explicitly with no target partial writes (transaction rollback).
   * Empty prefix impossible because anchor inclusive.
   */
  branchMessagesToTopic(
    sourceTopicId: string,
    targetTopicId: string,
    anchorMessageId: string,
    assistantId?: string
  ): ChatDbResult<{ messages: JsonObject[]; blocks: JsonObject[] }> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('branchMessagesToTopic')
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Validate source exists
        const srcTopic = repos.topics.getById(sourceTopicId)
        if (!srcTopic.found) {
          throw new ChatDbNotFoundError(`Topic ${sourceTopicId} does not exist`)
        }

        // Ensure target (create-only)
        repos.topics.ensure(targetTopicId, assistantId)

        // Validate anchor belongs to source
        const anchor = repos.messages.getInTopic(anchorMessageId, sourceTopicId)
        if (!anchor.found) {
          throw new ChatDbNotFoundError(`Anchor message ${anchorMessageId} does not belong to topic ${sourceTopicId}`)
        }

        // Load source ordered deterministic
        const allMessages = repos.messages.listByTopic(sourceTopicId)
        const anchorIdx = allMessages.findIndex((m) => m.id === anchorMessageId)
        if (anchorIdx === -1) {
          throw new ChatDbNotFoundError(`Anchor message ${anchorMessageId} does not belong to topic ${sourceTopicId}`)
        }
        const prefixMessages = allMessages.slice(0, anchorIdx + 1)
        const prefixIds = prefixMessages.map((m) => m.id)
        const blockMap = repos.blocks.listByMessages(prefixIds)

        // Fresh ID generation preserving order
        const idMap = new Map<string, string>()
        for (const m of prefixMessages) {
          idMap.set(m.id, randomUUID())
        }

        const newMessages: MessageData[] = []
        const allNewBlocks: MessageBlockData[] = []

        for (const oldMsg of prefixMessages) {
          const newId = idMap.get(oldMsg.id)!
          let newAskId: string | null | undefined
          if (oldMsg.role === 'assistant' && oldMsg.askId) {
            const mapped = idMap.get(oldMsg.askId)
            if (mapped) newAskId = mapped
            else newAskId = null
          } else {
            newAskId = oldMsg.askId ?? null
            // For assistant messages whose askId was unset, keep null; for user messages, askId is null
            if (oldMsg.role === 'assistant' && newAskId === null && oldMsg.askId) {
              // already handled above (outside prefix) -> null
            }
            // For non-assistant, preserve original askId (usually null)
            // But if original had askId and is assistant case already handled
          }

          // Clone message data: shallow copy, replace id/topicId/askId, preserve overflow and all columns except sortOrder (appendMany reassigns)
          const cloned: MessageData = {
            ...oldMsg,
            id: newId,
            topicId: targetTopicId,
            askId: oldMsg.role === 'assistant' ? newAskId : (oldMsg.askId ?? null)
          }
          // Preserve overflow object reference safety: ensure overflow is cloned
          cloned.overflow = { ...oldMsg.overflow }
          newMessages.push(cloned)

          const oldBlocks = blockMap.get(oldMsg.id) ?? []
          // Preserve block order as stored (already sorted by sort_order ASC, id ASC via listByMessages ordering)
          for (const oldBlk of oldBlocks) {
            const newBlkId = randomUUID()
            const clonedBlk: MessageBlockData = {
              ...oldBlk,
              id: newBlkId,
              messageId: newId,
              overflow: { ...oldBlk.overflow }
            }
            allNewBlocks.push(clonedBlk)
          }
        }

        // Insert atomically using existing dense order semantics
        if (newMessages.length > 0) {
          repos.messages.appendMany(newMessages)
        }
        if (allNewBlocks.length > 0) {
          // Group by new message for deterministic upsert order (original prefix order preserved)
          repos.blocks.upsertMany(allNewBlocks)
          this.syncFileReferences(repos, allNewBlocks)
        }

        // Unsupported structural path (010) — truthful invalidation inside same transaction, no clock mint
        syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'topicMessage', targetTopicId)
        {
          const mids = new Set<string>()
          for (const blk of allNewBlocks) mids.add(blk.messageId)
          for (const mid of mids) {
            syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'messageBlock', mid)
          }
        }

        // Build wire response for renderer projection (no second read)
        const wireMessages = messagesToWire(newMessages)
        const wireBlocks = blocksToWire(allNewBlocks)
        const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
        return { messages: messagesWithBlocks, blocks: wireBlocks }
      })
    }, `branchMessagesToTopic(${sourceTopicId} -> ${targetTopicId}, anchor=${anchorMessageId})`)
  }

  cloneMessagesToTopic(
    targetTopicId: string,
    entries: Array<{ message: JsonObject; blocks: JsonObject[] }>,
    assistantId?: string
  ): ChatDbResult<null> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('cloneMessagesToTopic')
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Ensure target topic exists
        repos.topics.ensure(targetTopicId, assistantId)

        // Phase 1 — convert every entry, enforce block ownership, and
        // classify as new vs existing. Cross-topic ownership and duplicate
        // new IDs are resolved here, before any write, so the first invalid
        // entry aborts the whole transaction exactly as the per-entry loop
        // did (error precedence is unchanged).
        const newMessages: MessageData[] = []
        const newMessageIds = new Set<string>()
        const existingPlans: Array<{
          message: MessageData
          blocks: MessageBlockData[]
          patch: Record<string, unknown>
        }> = []
        // Phase-4 side-effect order (audit F1): every entry's blocks in the
        // ORIGINAL request order. Upserting blocks + syncing file references
        // in `[...newEntryPlans, ...existingPlans]` order would move all NEW
        // entries' block side effects before EXISTING entries', changing the
        // last-writer for rare cross-entry block-ID collisions vs the legacy
        // per-entry loop.
        const phase4Plans: Array<{ message: MessageData; blocks: MessageBlockData[] }> = []

        for (const entry of entries) {
          const messageData = wireToMessage(entry.message)
          messageData.topicId = targetTopicId
          const blockDataList = entry.blocks.map(wireToBlock)

          // Enforce block ownership
          for (const block of blockDataList) {
            block.messageId = messageData.id
          }

          const patch = wireToMessagePatch(entry.message)
          delete patch.id
          delete patch.topicId
          delete patch.sortOrder

          // Check if message already exists
          const existing = repos.messages.getById(messageData.id)

          if (existing.found) {
            // Reject cross-topic ownership: message must belong to target topic
            if (existing.data.topicId !== targetTopicId) {
              throw new ChatDbConflictError(
                `Message ${messageData.id} belongs to topic ${existing.data.topicId}, ` +
                  `cannot clone into topic ${targetTopicId}`
              )
            }
            // Same topic: preserve position, update metadata only
            existingPlans.push({ message: messageData, blocks: blockDataList, patch })
          } else if (newMessageIds.has(messageData.id)) {
            // Duplicate new ID within one request: the first occurrence is
            // inserted; later occurrences follow the established update path.
            existingPlans.push({ message: messageData, blocks: blockDataList, patch })
          } else {
            // New: append at end (batched)
            newMessageIds.add(messageData.id)
            newMessages.push(messageData)
          }
          // Phase 4 runs in original entry order regardless of the
          // new/existing split above (audit F1).
          phase4Plans.push({ message: messageData, blocks: blockDataList })
        }

        // Phase 2 — batch-insert all new messages (single linear normalize).
        if (newMessages.length > 0) {
          repos.messages.appendMany(newMessages)
        }

        // Phase 3 — metadata patches for existing rows and in-request
        // duplicates (applied after the batch insert so duplicate entries
        // patch the just-inserted row, matching the per-entry loop).
        for (const plan of existingPlans) {
          if (Object.keys(plan.patch).length > 0) {
            repos.messages.update(targetTopicId, plan.message.id, plan.patch)
          }
        }

        // Phase 4 — upsert blocks + sync file references for ALL entries in
        // ORIGINAL request order (audit F1: the new/existing classification
        // must not reorder block side effects, so rare cross-entry block-ID
        // collisions keep the legacy per-entry loop's last-writer).
        for (const plan of phase4Plans) {
          if (plan.blocks.length > 0) {
            repos.blocks.upsertMany(plan.blocks)
            this.syncFileReferences(repos, plan.blocks)
          }
        }

        // Unsupported structural path (010) — truthful invalidation inside same transaction, no clock mint
        syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'topicMessage', targetTopicId)
        {
          const mids = new Set<string>()
          for (const plan of phase4Plans) {
            for (const blk of plan.blocks) mids.add(blk.messageId)
          }
          for (const mid of mids) {
            syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'messageBlock', mid)
          }
        }
      })

      return null
    }, `cloneMessagesToTopic(${targetTopicId}, ${entries.length} entries)`)
  }

  /**
   * Atomically reset message state for resend and delete designated blocks.
   *
   * - Resolves every block ID through its parent message to verify topic ownership.
   * - Rejects any block ID whose parent message does not belong to request topic.
   * - Deletes owned blocks and resets each message's status, sortOrder, and clears model.
   * - Returns file cleanup facts for deleted blocks.
   *
   * Atomicity: one root SQLite transaction.
   */
  resetMessagesForResend(
    topicId: string,
    messages: Array<{ message: JsonObject; blocks: JsonObject[] }> | string[],
    blockIdsToDelete: string[]
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('resetMessagesForResend')
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Phase 1: Resolve every block through its parent message and verify ownership.
        // Reject any block whose parent message does not belong to request topic.
        const ownedBlockIds: string[] = []
        if (blockIdsToDelete.length > 0) {
          for (const blockId of blockIdsToDelete) {
            const block = repos.blocks.getById(blockId)
            if (!block.found) {
              throw new ChatDbConflictError(`Block ${blockId} does not exist`)
            }
            // Resolve block → message → topic ownership
            const msg = repos.messages.getInTopic(block.data.messageId, topicId)
            if (!msg.found) {
              throw new ChatDbConflictError(
                `Block ${blockId} belongs to message ${block.data.messageId} which is not in topic ${topicId}`
              )
            }
            ownedBlockIds.push(blockId)
          }
        }

        // Capture parent messageIds for frame invalidation before deletion (still present)
        const ownedBlockParentIds = new Set<string>()
        for (const bid of ownedBlockIds) {
          const blk = repos.blocks.getById(bid)
          if (blk.found) ownedBlockParentIds.add(blk.data.messageId)
        }

        // Phase 2: Collect affected file IDs from owned blocks only
        let affectedFileIds: string[] = []
        if (ownedBlockIds.length > 0) {
          const allRefs: FileReferenceData[] = []
          for (const blockId of ownedBlockIds) {
            const refs = repos.fileRefs.listByBlock(blockId)
            allRefs.push(...refs)
          }
          affectedFileIds = collectAffectedFileIds(allRefs)

          // Delete owned blocks (FK cascade removes file_references)
          repos.blocks.deleteMany(ownedBlockIds)
        }

        // Phase 3: Persist complete reset payloads, preserving existing identity.
        for (const item of messages) {
          const entry =
            typeof item === 'string' ? { message: { id: item, status: null, blocks: [] }, blocks: [] } : item
          const messageData = wireToMessage(entry.message)
          messageData.topicId = topicId
          const blockDataList = entry.blocks.map(wireToBlock)
          for (const block of blockDataList) block.messageId = messageData.id
          const existing = repos.messages.getInTopic(messageData.id, topicId)
          if (!existing.found) {
            repos.messages.append(messageData)
          } else {
            const patch = wireToMessagePatch(entry.message)
            delete patch.id
            delete patch.topicId
            delete patch.sortOrder
            repos.messages.update(topicId, messageData.id, patch)
          }
          if (blockDataList.length > 0) {
            repos.blocks.upsertMany(blockDataList)
            this.syncFileReferences(repos, blockDataList)
          }
        }

        // Phase 4: Normalize message orders after changes
        repos.messages.replaceOrder(
          topicId,
          repos.messages.listByTopic(topicId).map((m) => m.id)
        )

        // Unsupported structural path (010) — truthful invalidation inside same transaction, no clock mint
        syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'topicMessage', topicId)
        const resetMsgIds = new Set<string>(ownedBlockParentIds)
        for (const item of messages) {
          const mid = typeof item === 'string' ? item : ((item as { message: JsonObject }).message?.id as string)
          if (typeof mid === 'string' && mid.length > 0) resetMsgIds.add(mid)
        }
        for (const mid of resetMsgIds) {
          syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'messageBlock', mid)
        }

        return buildFileCleanupResult(repos, affectedFileIds)
      })
    }, `resetMessagesForResend(${topicId}, ${messages.length} msgs)`)
  }

  /**
   * Delete a batch of messages with segment membership cleanup in the
   * same transaction. Segment memberships are removed; empty segments
   * are deleted per existing repository semantics. Segment membership
   * changes stay local-only (no segment wire fields/ops).
   *
   * Ownership enforcement: only messages owned by the request topic are
   * processed. Foreign/missing IDs are silently skipped (consistent with
   * deleteMessages semantics). File refs are collected from owned IDs
   * only, so foreign IDs never appear in the cleanup result.
   *
   * Sync (SYNC-DATA-048): for each owned/known message actually deleted,
   * enqueue the existing message delete/tombstone intent with the same
   * semantics as deleteMessages; deleted messageBlock parent frames are
   * removed; the surviving topic attempts the existing topicMessage frame
   * refresh+enqueue via the try helper (complete membership: exactly one
   * updated winning frame + one matching order_frame op; missing/
   * unversioned membership: user mutation succeeds, frame invalidated,
   * zero frame op). Malformed/high-water/transactional errors roll back
   * rows, segment memberships, outbox/tombstones/frames together.
   *
   * Returns file cleanup facts for blocks whose file_references cascade.
   *
   * Atomicity: one root SQLite transaction.
   */
  deleteMessagesWithSegments(topicId: string, messageIds: string[]): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const ctx = this.syncCtx('deleteMessagesWithSegments')
      let notify = false
      let result: FileCleanupResult
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Phase 1: Filter to owned messages BEFORE collecting refs
          const ownedIds: string[] = []
          for (const id of messageIds) {
            const existing = repos.messages.getInTopic(id, topicId)
            if (existing.found) ownedIds.push(id)
          }
          const knownIds = ctx ? ownedIds.filter((id) => syncService.isKnownEntityInTx(stx, 'message', id)) : []

          // Phase 2: Collect affected file IDs from owned messages only
          const refs = repos.fileRefs.listByMessages(ownedIds)
          const affectedFileIds = collectAffectedFileIds(refs)

          // Phase 3: Remove segment memberships for owned messages (local-only)
          for (const seg of repos.segments.listByTopic(topicId)) {
            const segMsgIds = repos.segments.getMessageIds(seg.id)
            const toRemove = ownedIds.filter((id) => segMsgIds.includes(id))
            if (toRemove.length > 0) {
              repos.segments.removeMessages(seg.id, toRemove)
            }
          }

          // Phase 4: Delete owned messages (FK cascade: blocks → file_references)
          if (ownedIds.length > 0) {
            repos.messages.deleteMany(ownedIds)
          }
          if (ctx) {
            for (const id of knownIds) {
              syncService.enqueueDeleteInTx(stx, 'message', id, ctx.ts, ctx.deviceId)
              notify = true
            }
          }

          // Phase 5: Frames — deleted messageBlock parents removed as today;
          // surviving topic uses the existing try-helper fail-safe.
          if (ownedIds.length > 0) {
            for (const did of ownedIds) {
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', did)
            }
            if (ctx) {
              const topicRow = repos.topics.getById(topicId)
              if (topicRow.found) {
                if (syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId) === 'refreshed') {
                  notify = true
                }
              } else {
                syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
              }
            } else {
              syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
            }
          }

          return buildFileCleanupResult(repos, affectedFileIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteMessagesWithSegments', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `deleteMessagesWithSegments(${topicId}, ${messageIds.length} msgs)`)
  }

  /**
   * Atomically insert an ordered batch of messages+blocks at a specified
   * position, preserving dense sort order.
   *
   * Each entry is a message with its blocks. Entries are inserted at
   * insertIndex in array order. Existing messages preserve their position.
   *
   * For existing messages that already have blocks, harvests prior file
   * references before syncFileReferences to produce accurate cleanup facts.
   * Insert-only entries return no cleanup (empty arrays).
   *
   * Rejects any existing message ID that is owned by a different topic.
   *
   * Returns file cleanup facts: affectedFileIds (from prior refs on
   * existing blocks that were replaced) and remainingReferenceCounts.
   *
   * Linear batch semantics (PERF-100 / LOCK-002): all NEW messages are
   * converted and classified first, then inserted in ONE
   * `messages.insertManyAt` batch — one sibling shift-by-count plus at most
   * one dense-order repair per topic — never M per-message `insertAt` calls
   * (M sibling shifts + M full-topic normalizations). Existing (same-topic)
   * entries preserve their position and only receive a metadata patch, and
   * in-request duplicate new IDs resolve exactly as before (first occurrence
   * inserts, later occurrences take the update path), so error precedence
   * and last-writer behavior are unchanged.
   *
   * Phase-4 block side effects (block upserts + file-reference syncs, and
   * the prior-ref harvest for existing-message entries) run in the ORIGINAL
   * request entry order (audit F1): the new/existing classification never
   * reorders them, so rare cross-entry block-ID collisions keep the same
   * last-writer and harvest timing as the legacy per-entry loop.
   *
   * Atomicity: one root SQLite transaction.
   */
  pasteMessagesToTopic(
    topicId: string,
    entries: Array<{ message: JsonObject; blocks: JsonObject[] }>,
    insertIndex?: number
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('pasteMessagesToTopic')
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Ensure topic exists
        repos.topics.ensure(topicId)

        // Compute the starting insert position (append at end when absent)
        const resolvedInsertIndex = insertIndex !== undefined ? insertIndex : repos.messages.listByTopic(topicId).length

        // Phase 1 — convert every entry, enforce block ownership, and
        // classify as new vs existing. Cross-topic ownership and duplicate
        // new IDs are resolved here, before any write, so the first invalid
        // entry aborts the whole transaction exactly as the per-entry loop
        // did (error precedence is unchanged).
        const newMessages: MessageData[] = []
        const newMessageIds = new Set<string>()
        const existingPlans: Array<{ id: string; patch: Record<string, unknown> }> = []
        // Phase-4 side-effect order (audit F1): every entry's blocks in the
        // ORIGINAL request order. `harvest` is true only for entries whose
        // message already existed (or is an in-request duplicate — which the
        // legacy loop observed as "existing" by the time it reached them),
        // matching the legacy loop's prior-ref harvest timing exactly.
        const phase4Plans: Array<{ blocks: MessageBlockData[]; harvest: boolean }> = []
        const allAffectedFileIds: string[] = []

        for (const entry of entries) {
          const messageData = wireToMessage(entry.message)
          messageData.topicId = topicId
          const blockDataList = entry.blocks.map(wireToBlock)

          // Enforce block ownership
          for (const block of blockDataList) {
            block.messageId = messageData.id
          }

          const patch = wireToMessagePatch(entry.message)
          delete patch.id
          delete patch.topicId
          delete patch.sortOrder

          // Check if message already exists
          const existing = repos.messages.getById(messageData.id)

          if (existing.found) {
            // Reject cross-topic ownership
            if (existing.data.topicId !== topicId) {
              throw new ChatDbConflictError(
                `Message ${messageData.id} belongs to topic ${existing.data.topicId}, ` +
                  `cannot paste into topic ${topicId}`
              )
            }
            // Existing: preserve position, update metadata only
            existingPlans.push({ id: messageData.id, patch })
            phase4Plans.push({ blocks: blockDataList, harvest: true })
          } else if (newMessageIds.has(messageData.id)) {
            // Duplicate new ID within one request: the first occurrence is
            // inserted; later occurrences follow the established update path
            // (the legacy loop saw the just-inserted row and took the
            // existing branch, including its prior-ref harvest).
            existingPlans.push({ id: messageData.id, patch })
            phase4Plans.push({ blocks: blockDataList, harvest: true })
          } else {
            // New: batch-insert at the resolved index in array order
            newMessageIds.add(messageData.id)
            newMessages.push(messageData)
            phase4Plans.push({ blocks: blockDataList, harvest: false })
          }
        }

        // Phase 2 — batch-insert all new messages (ONE sibling shift-by-count
        // plus at most one dense-order repair; PERF-100).
        if (newMessages.length > 0) {
          repos.messages.insertManyAt(newMessages, resolvedInsertIndex)
        }

        // Phase 3 — metadata patches for existing rows and in-request
        // duplicates (applied after the batch insert so duplicate entries
        // patch the just-inserted row, matching the per-entry loop).
        for (const plan of existingPlans) {
          if (Object.keys(plan.patch).length > 0) {
            repos.messages.update(topicId, plan.id, plan.patch)
          }
        }

        // Phase 4 — harvest prior refs (existing-message entries only), then
        // upsert blocks + sync file references for ALL entries in ORIGINAL
        // request order (audit F1: the new/existing classification must not
        // reorder block side effects, so rare cross-entry block-ID collisions
        // keep the legacy per-entry loop's last-writer and harvest timing).
        for (const plan of phase4Plans) {
          if (plan.blocks.length === 0) continue
          if (plan.harvest) {
            for (const block of plan.blocks) {
              const priorRefs = repos.fileRefs.listByBlock(block.id)
              allAffectedFileIds.push(...collectAffectedFileIds(priorRefs))
            }
          }
          repos.blocks.upsertMany(plan.blocks)
          this.syncFileReferences(repos, plan.blocks)
        }

        // Unsupported structural path (010) — truthful invalidation inside same transaction, no clock mint
        syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'topicMessage', topicId)
        {
          const mids = new Set<string>()
          for (const plan of phase4Plans) {
            for (const blk of plan.blocks) mids.add(blk.messageId)
          }
          for (const mid of mids) {
            syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'messageBlock', mid)
          }
        }

        // Deduplicate affected IDs and compute remaining counts
        const uniqueAffectedIds = [...new Set(allAffectedFileIds)].sort()
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })
    }, `pasteMessagesToTopic(${topicId}, ${entries.length} entries)`)
  }

  // =========================================================================
  // Phase 5.1B-2: Search
  // =========================================================================

  /**
   * Search message blocks using FTS5 normalized projection with exact
   * regex filtering (LOCK-5125).
   *
   * Returns minimal JSON-safe result data (LOCK-5128).
   * Deleted topics are NOT filtered — matching existing behavior.
   */
  searchMessages(request: SearchMessagesRequest): ChatDbResult<SearchMessagesResponse> {
    return wrapResult(
      () => {
        if (!this.sqlite) {
          throw new Error('Search requires raw SQLite handle')
        }
        const searchRepo = new SearchRepository(this.sqlite)
        return searchRepo.search(request)
      },
      `searchMessages(${request.keywords.substring(0, 50)})`
    )
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /**
   * LOCK-004: clean ordinary-chat traces for permanently deleted topics AFTER
   * the DB transaction has committed. Uses the exact deleted topic IDs
   * collected inside the mutation. Each cleanup failure is caught, logged via
   * loggerService, and is non-fatal — it never changes the already-committed
   * result. A failed transaction never reaches this helper: the mutation
   * throws before post-commit cleanup, so this is only ever called after a
   * successful commit. Soft deletes must NOT call this helper.
   */
  private cleanDeletedTopicTraces(deletedTopicIds: string[]): void {
    for (const topicId of deletedTopicIds) {
      try {
        void spanCacheService.cleanTopic(topicId).catch((error: unknown) => {
          loggerService
            .withContext('ChatDbAggregate')
            .error(
              `Trace cleanup failed for permanently deleted topic ${topicId}:`,
              error instanceof Error ? error : new Error(String(error))
            )
        })
      } catch (error) {
        loggerService
          .withContext('ChatDbAggregate')
          .error(
            `Trace cleanup failed for permanently deleted topic ${topicId}:`,
            error instanceof Error ? error : new Error(String(error))
          )
      }
    }
  }

  /**
   * Sync file references for file/image blocks.
   * Replaces stale references for each block with deterministic snapshots.
   * Non-file blocks have zero references (old refs cleared).
   */
  private syncFileReferences(repos: ChatDbRepositories, blocks: MessageBlockData[]): void {
    for (const block of blocks) {
      const newRefs = projectFileReferences(block)
      const oldRefs = repos.fileRefs.listByBlock(block.id)

      // Clear old references for this block
      if (oldRefs.length > 0) {
        repos.fileRefs.deleteByBlock(block.id)
      }

      // Create new references
      if (newRefs.length > 0) {
        repos.fileRefs.createMany(newRefs)
      }
    }
  }
}
