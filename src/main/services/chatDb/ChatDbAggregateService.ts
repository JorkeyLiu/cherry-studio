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
  FetchAnswerGroupRequest,
  FetchAnswerGroupResponse,
  FetchMessagesWindowRequest,
  FetchMessagesWindowResponse,
  FileCleanupResult,
  FileReferenceWire,
  JsonObject,
  SegmentWire,
  StreamWriteDiagnostics
} from '@shared/chatDb'
import type { ChatDbResult } from '@shared/chatDb'
import type { SearchMessagesRequest, SearchMessagesResponse } from '@shared/chatDb'
import { elapsedMs, MAX_APPEND_DIAGNOSTIC_LOGS } from '@shared/diagnostics/sendTiming'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { logMainDiagnostic } from '../diagnostics'
import { isPhaseAttrMainEnabled, recordMainPhaseDuration } from '../phaseTimingDiagnostics'
import { spanCacheService } from '../SpanCacheService'
import type { FileReferenceData, MessageBlockData, MessageData } from './domain/types'
import { ChatDbConflictError, ChatDbNotFoundError, ChatDbValidationError, wrapResult } from './errors'
import type { ChatDbRepositories } from './repository/factory'
import { createRepositories } from './repository/factory'
import { SearchRepository } from './repository/SearchRepository'
import type * as schema from './schema'
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
  // Command implementations
  // =========================================================================

  /**
   * Fetch all messages and blocks for a topic.
   * Returns consistent ordered message/block snapshot.
   * Rebuilds each message.blocks relationally.
   *
   * Topic priming: if the topic is absent, ensure/create it within
   * the same aggregate transaction and return empty arrays.
   */
  fetchMessages(topicId: string): ChatDbResult<FetchMessagesResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Absent topic → ensure it exists, return empty result
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          repos.topics.ensure(topicId)
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
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

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
        const newMessages: MessageData[] = []
        const newMessageIds = new Set<string>()
        const existingPlans: Array<{ id: string; patch: Record<string, unknown> }> = []
        const phase4Plans: Array<{ blocks: MessageBlockData[]; harvest: boolean }> = []
        const allAffectedFileIds: string[] = []

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

        const uniqueAffectedIds = [...new Set(allAffectedFileIds)].sort()
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })
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
   */
  ensureTopic(topicId: string, assistantId?: string, name?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const { topics } = this.repos()
      topics.ensure(topicId, assistantId, name)
      return null
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
        const txResult = this.db.transaction((tx) => {
          const repos = createRepositories(tx)

          // Ensure topic exists
          repos.topics.ensure(topicId)

          // Check if message already exists
          const existing = repos.messages.getById(messageData.id)

          if (existing.found) {
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

          // Upsert blocks (preserves existing order for existing blocks)
          if (blockDataList.length > 0) {
            repos.blocks.upsertMany(blockDataList)

            // Sync file references for file/image blocks
            this.syncFileReferences(repos, blockDataList)
          }
          return null
        })
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
   */
  updateMessage(topicId: string, messageId: string, updatesJson: JsonObject): ChatDbResult<null> {
    return wrapResult(() => {
      const patch = wireToMessagePatch(updatesJson)
      // Strip identity fields (defense in depth — contract already rejects)
      delete patch.id
      delete patch.topicId
      delete patch.sortOrder

      const { messages } = this.repos()
      messages.update(topicId, messageId, patch)
      return null
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

      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

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

        // Upsert blocks
        if (blockDataList.length > 0) {
          repos.blocks.upsertMany(blockDataList)

          // Sync file references
          this.syncFileReferences(repos, blockDataList)
        }
        return buildFileCleanupResult(repos, affectedFileIds)
      })
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

        return null
      })
    }, `selectAnswerMessage(${topicId})`)
  }

  /**
   * Delete a single message. Only deletes if owned by the specified topic.
   * Missing/foreign IDs: no-op.
   */
  deleteMessage(topicId: string, messageId: string): ChatDbResult<null> {
    return wrapResult(() => {
      const { messages } = this.repos()
      // Verify ownership before delete
      const existing = messages.getInTopic(messageId, topicId)
      if (!existing.found) return null // no-op for missing/foreign IDs
      messages.delete(messageId)
      return null
    }, `deleteMessage(${topicId}, ${messageId})`)
  }

  /**
   * Delete multiple messages. Only deletes messages owned by the specified topic.
   * Missing/foreign IDs: no-op.
   */
  deleteMessages(topicId: string, messageIds: string[]): ChatDbResult<null> {
    return wrapResult(() => {
      const { messages } = this.repos()
      // Filter to messages actually owned by this topic
      const ownedIds: string[] = []
      for (const id of messageIds) {
        const existing = messages.getInTopic(id, topicId)
        if (existing.found) ownedIds.push(id)
      }
      if (ownedIds.length > 0) {
        messages.deleteMany(ownedIds)
      }
      return null
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
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        repos.blocks.upsertMany(blockDataList)

        // Sync file references within the same transaction
        this.syncFileReferences(repos, blockDataList)
      })
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
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

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
      })
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

      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

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
      })

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
   */
  deleteBlocks(blockIds: string[]): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const affectedFileIds = collectAffectedFileIds(
          blockIds.flatMap((blockId) => repos.fileRefs.listByBlock(blockId))
        )
        // blocks.deleteMany handles order normalization within its own
        // savepoint transaction. FK cascade removes file_references.
        repos.blocks.deleteMany(blockIds)
        return buildFileCleanupResult(repos, affectedFileIds)
      })
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
   */
  reorderMessages(topicId: string, messageIds: string[]): ChatDbResult<null> {
    return wrapResult(() => {
      const { messages } = this.repos()
      messages.replaceOrder(topicId, messageIds)
      return null
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
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

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
        return topicToWireFull(updated.data)
      })
    }, `updateTopicMetadata(${topicId})`)
  }

  /**
   * Soft-delete a topic by setting deletedAt.
   * Missing topic: no-op (returns success).
   */
  softDeleteTopic(topicId: string, name?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      this.db.transaction((tx) => {
        const { topics } = createRepositories(tx)
        topics.softDelete(topicId, name)
      })
      return null
    }, `softDeleteTopic(${topicId})`)
  }

  /**
   * Atomically restore a soft-deleted topic and return the restored wire
   * entity (LOCK-532). Returns null when no soft-deleted row exists for the
   * ID at command time (missing topic, or topic not in trash) — in that
   * case NO mutation occurs. Callers must dispatch only the returned row,
   * never a separately listed snapshot.
   */
  restoreTopic(topicId: string): ChatDbResult<JsonObject | null> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

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
        return topicToWireFull(restored.data)
      })
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
  hardDeleteTopic(topicId: string): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      // LOCK-004: exact deleted topic IDs are collected inside the transaction.
      const deletedTopicIds: string[] = []
      const cleanup = this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Check topic exists
        const existing = repos.topics.getById(topicId)
        if (!existing.found) {
          return { affectedFileIds: [], remainingReferenceCounts: {} }
        }
        deletedTopicIds.push(topicId)

        // Collect affected file IDs before cascade deletion
        const messages = repos.messages.listByTopic(topicId)
        const messageIds = messages.map((m) => m.id)
        const refsBeforeDelete = repos.fileRefs.listByMessages(messageIds)
        const affectedFileIds = collectAffectedFileIds(refsBeforeDelete)

        // FK cascade: topic → messages → blocks → file_references
        // Also topic → topic_segments → topic_segment_messages
        repos.topics.hardDelete(topicId)

        // Compute remaining counts after cascade
        return buildFileCleanupResult(repos, affectedFileIds)
      })

      // LOCK-004: clean ordinary-chat traces after the DB commit, using the
      // exact deleted topic IDs. Cleanup failure is logged and non-fatal; it
      // never changes the returned committed result. A failed transaction
      // throws before this point, so post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      return cleanup
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
  purgeExpiredTopics(cutoffTimestamp: string): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
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

            // Collect affected file IDs before cascade
            const messages = repos.messages.listByTopic(topic.id)
            const messageIds = messages.map((m) => m.id)
            const refs = repos.fileRefs.listByMessages(messageIds)
            const ids = collectAffectedFileIds(refs)
            allAffectedFileIds.push(...ids)

            deletedTopicIds.push(topic.id)

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

      return cleanup
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
  emptyTrashTopics(assistantId: string): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
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
            // Collect affected file IDs before cascade
            const messages = repos.messages.listByTopic(topic.id)
            const messageIds = messages.map((m) => m.id)
            const refs = repos.fileRefs.listByMessages(messageIds)
            allAffectedFileIds.push(...collectAffectedFileIds(refs))

            deletedTopicIds.push(topic.id)

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

      return cleanup
    }, `emptyTrashTopics(${assistantId})`)
  }

  transferTopicOwnership(topicId: string, assistantId: string): ChatDbResult<null> {
    return wrapResult(() => {
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

  resetAssistantTopics(
    assistantId: string,
    replacementTopicId: string
  ): ChatDbResult<{ cleanup: FileCleanupResult; replacementTopic: JsonObject }> {
    return wrapResult(() => {
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
          replacementTopic: topicToWireFull(replacementTopic)
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

        return buildFileCleanupResult(repos, affectedFileIds)
      })
    }, `resetMessagesForResend(${topicId}, ${messages.length} msgs)`)
  }

  /**
   * Delete a batch of messages with segment membership cleanup in the
   * same transaction. Segment memberships are removed; empty segments
   * are deleted per existing repository semantics.
   *
   * Ownership enforcement: only messages owned by the request topic are
   * processed. Foreign/missing IDs are silently skipped (consistent with
   * deleteMessages semantics). File refs are collected from owned IDs
   * only, so foreign IDs never appear in the cleanup result.
   *
   * Returns file cleanup facts for blocks whose file_references cascade.
   *
   * Atomicity: one root SQLite transaction.
   */
  deleteMessagesWithSegments(topicId: string, messageIds: string[]): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Phase 1: Filter to owned messages BEFORE collecting refs
        const ownedIds: string[] = []
        for (const id of messageIds) {
          const existing = repos.messages.getInTopic(id, topicId)
          if (existing.found) ownedIds.push(id)
        }

        // Phase 2: Collect affected file IDs from owned messages only
        const refs = repos.fileRefs.listByMessages(ownedIds)
        const affectedFileIds = collectAffectedFileIds(refs)

        // Phase 3: Remove segment memberships for owned messages
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

        return buildFileCleanupResult(repos, affectedFileIds)
      })
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
