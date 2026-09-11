import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { isStableBlockStatus, isStableMessageStatus, isUnsupportedBlockForSync } from '@shared/sync'
import { asc, eq } from 'drizzle-orm'

import { chatDbService } from '../chatDb'
import * as schema from '../chatDb/schema'
import { syncService } from './SyncService'

const logger = loggerService.withContext('SyncChatDbHook')

function safeString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * Fail-closed database accessor (LOCK-PERSONAL-006): throws on infrastructure
 * failure so the outer hook catch records a durable capture failure. Never
 * returns a silent null on error — null is reserved for proven-absent rows.
 */
function requireDb() {
  return chatDbService.getDatabase()
}

function readTopicMetadata(extra: unknown): Record<string, unknown> {
  if (typeof extra !== 'string' || extra.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(extra)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const rec = parsed as Record<string, unknown>
  const out: Record<string, unknown> = {}
  // Carry exactly the syncable metadata keys; type validation stays in the
  // shared strict validator (fail-closed on enqueue). Malformed values are
  // still carried so validation rejects truthfully instead of silently
  // dropping them as converged.
  for (const k of ['pinned', 'prompt', 'isNameManuallyEdited'] as const) {
    if (Object.prototype.hasOwnProperty.call(rec, k)) {
      const v = rec[k]
      if (v !== undefined) out[k] = v
    }
  }
  return out
}

function enqueueTopicFull(topicId: string, ts: number): boolean {
  const db = requireDb()
  const row = db.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get()
  if (!row) {
    logger.warn(`[enqueueTopicFull] topic ${topicId} missing after mutation, skip`)
    return false
  }
  const payload: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    assistantId: row.assistantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    ...readTopicMetadata((row as { extra?: unknown }).extra)
  }
  const op = syncService.recordUpsert('topic', topicId, payload, ts)
  return !!op
}

function enqueueMessageFull(messageId: string, ts: number): boolean {
  const db = requireDb()
  const row = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
  if (!row) {
    logger.warn(`[enqueueMessageFull] message ${messageId} missing after mutation, skip`)
    return false
  }
  const payload: Record<string, unknown> = {
    id: row.id,
    topicId: row.topicId,
    role: row.role,
    content: row.content,
    status: row.status,
    askId: row.askId,
    model: row.model,
    modelId: row.modelId,
    assistantId: row.assistantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sortOrder: row.sortOrder
  }
  const op = syncService.recordUpsert('message', messageId, payload, ts)
  return !!op
}

function enqueueBlockFull(blockId: string, ts: number): boolean {
  const db = requireDb()
  const row = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, blockId)).get()
  if (!row) {
    logger.warn(`[enqueueBlockFull] block ${blockId} missing after mutation, skip`)
    return false
  }
  const payload: Record<string, unknown> = {
    id: row.id,
    messageId: row.messageId,
    type: row.type,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sortOrder: row.sortOrder
  }
  const op = syncService.recordUpsert('message_block', blockId, payload, ts)
  return !!op
}

/**
 * Fail-closed committed-row reads: return the row or null ONLY when the row
 * is proven absent. Any infrastructure failure throws so callers record a
 * durable capture failure instead of a silent no-op skip (LOCK-PERSONAL-006).
 */
function getMessageRow(messageId: string): any | null {
  const db = requireDb()
  return db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get() ?? null
}

function getBlockRow(blockId: string): any | null {
  const db = requireDb()
  return db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, blockId)).get() ?? null
}

/**
 * Stable-promotion descendant backfill for the post-commit fallback path
 * (LOCK-PERSONAL-004): capture every committed stable block of a
 * never-tracked message parent-first (baseTs + index offsets), skipping
 * transient rows and already-tracked/excluded blocks. Unsupported
 * structured/attachment-bearing rows skip without a partial shell and are
 * recorded as durable unsupported outcomes (never a silent skip, never a
 * retryable failure). Throws fail-closed on
 * infrastructure failure; returns false when a proven-present stable
 * descendant cannot be captured (caller records a durable failure).
 */
function enqueueUntrackedStableBlocksForMessage(
  messageId: string,
  baseTs: number,
  excludeIds: ReadonlySet<string>,
  channel: string
): boolean {
  const db = requireDb()
  const rows = db
    .select()
    .from(schema.messageBlocks)
    .where(eq(schema.messageBlocks.messageId, messageId))
    .orderBy(asc(schema.messageBlocks.sortOrder), asc(schema.messageBlocks.id))
    .all()
  // Deterministic rescan (LOCK-PERSONAL-004): attempt EVERY committed stable
  // supported descendant; a single child failure must not abandon the rest.
  // Unsupported structured/attachment rows skip without a partial shell and
  // record a durable unsupported outcome (never a retryable failure).
  // Returns false when any supported descendant could not be captured
  // (caller records a durable failure); the next stable promotion rescans
  // the remainder.
  let offset = 0
  let failed = false
  for (const row of rows) {
    const bid = (row as { id?: unknown }).id
    if (typeof bid !== 'string' || bid.length === 0) continue
    if (excludeIds.has(bid)) continue
    if (!isStableBlockStatus((row as { status?: unknown }).status)) continue
    if (isUnsupportedBlockRow(row)) {
      recordUnsupportedBlock(channel, bid)
      continue
    }
    try {
      if (syncService.isTrackedEntity('message_block', bid)) continue
    } catch {
      failed = true
      continue
    }
    offset += 1
    const childTs = baseTs + offset
    try {
      if (!ensureBlockParentClosure(bid, childTs)) {
        failed = true
        continue
      }
      if (!enqueueBlockFull(bid, childTs)) {
        failed = true
        continue
      }
    } catch {
      failed = true
      continue
    }
  }
  return !failed
}

/** Delete happened iff the row is gone post-commit; a surviving row means foreign/no-op. */
function rowStillExists(entityType: 'message' | 'message_block', id: string): boolean {
  return entityType === 'message' ? !!getMessageRow(id) : !!getBlockRow(id)
}

/**
 * Stable-checkpoint gate (LOCK-PERSONAL-004): only stable user-visible
 * checkpoints sync. Committed row values decide — intermediate statuses
 * `streaming`, `pending`, `processing`, `searching` suppress capture as a
 * legitimate transient skip (no capture failure). Final statuses `success`,
 * `error`, `paused` (and null/unknown legacy values) are stable and capture.
 * Create paths (AppendMessage/BulkAddBlocks) are exempt — they are their own
 * stable creation path and always capture.
 */
function isStableMessageRow(row: { status?: unknown } | null | undefined): boolean {
  if (!row) return false
  return isStableMessageStatus((row as { status?: unknown }).status)
}

function isStableBlockRow(row: { status?: unknown } | null | undefined): boolean {
  if (!row) return false
  return isStableBlockStatus((row as { status?: unknown }).status)
}

/**
 * Unsupported structured/attachment-bearing block gate (LOCK-PERSONAL-004).
 * A committed block whose canonical content lives in `extra` overflow (or
 * whose type carries binary/structured canonical payload) is not fully
 * representable in the allowlisted sync payload and must never emit a
 * partial null-content shell. Ordinary text blocks return false. Missing/
 * foreign rows never reach this predicate (callers treat those as non-error
 * skips first).
 */
function parseBlockOverflow(extra: unknown): Record<string, unknown> {
  if (typeof extra !== 'string' || extra.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(extra)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return {}
}

function isUnsupportedBlockRow(row: unknown): boolean {
  const rec = row as { type?: unknown; extra?: unknown } | null | undefined
  if (!rec) return false
  const type = typeof rec.type === 'string' ? rec.type : null
  return isUnsupportedBlockForSync({ type, overflow: parseBlockOverflow(rec.extra) })
}

/**
 * Durable explicit unsupported-block outcome (LOCK-PERSONAL-004/006/009):
 * no partial outbox row is written; the skip is recorded via the existing
 * capture-error mechanism so it cannot disappear silently. Never throws:
 * a persistence failure is logged (fail-closed observable).
 */
function recordUnsupportedBlock(channel: string, blockId: string): void {
  try {
    syncService.recordCaptureFailure(
      channel,
      new Error(`unsupported block ${blockId} not representable for sync, skipped without partial payload`)
    )
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    logger.error(`[unsupportedBlock] ${channel} ${blockId} persistence failed: ${detail}`)
  }
}

function messagePatchHasMutableKeys(updates: unknown): boolean {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return false
  const rec = updates as Record<string, unknown>
  return Object.keys(rec).some((k) => k !== 'id' && k !== 'topicId' && k !== 'sortOrder')
}

function topicMetadataHasMutableKeys(request: any): boolean {
  return (
    request?.name !== undefined ||
    request?.pinned !== undefined ||
    request?.prompt !== undefined ||
    request?.isNameManuallyEdited !== undefined
  )
}

/**
 * Direct dependency closure for supported child edits that follow an
 * unsupported compound-created parent. Bounded to the direct chain only
 * (block→message→topic); never expands to compound siblings, segments,
 * answers, ordering, or attachments. Parent timestamps are ordered strictly
 * before the child timestamp so relay seq preserves parent-before-child.
 * Returns true when no closure is needed or it was captured; false when the
 * closure cannot be obtained safely (caller must skip the child and record
 * a durable capture failure so the cursor is never poisoned).
 */
function ensureTopicClosure(topicId: string | null | undefined, childTs: number): boolean {
  if (!topicId) return false
  try {
    if (syncService.isTrackedEntity('topic', topicId)) return true
  } catch {
    return false
  }
  const parentTs = Math.max(0, childTs - 2)
  return enqueueTopicFull(topicId, parentTs)
}

function ensureMessageClosure(messageId: string | null | undefined, childTs: number): boolean {
  if (!messageId) return false
  const mrow = getMessageRow(messageId)
  if (!mrow) return false
  try {
    const topicOk = (() => {
      const topicId = typeof mrow.topicId === 'string' ? mrow.topicId : null
      if (!topicId) return false
      if (syncService.isTrackedEntity('topic', topicId)) return true
      return enqueueTopicFull(topicId, Math.max(0, childTs - 2))
    })()
    if (!topicOk) return false
    if (syncService.isTrackedEntity('message', messageId)) return true
    // Stable-checkpoint gate (LOCK-PERSONAL-004): a transient assistant
    // parent must never be emitted through child closure. Return false so the
    // caller records a durable capture failure and skips the child — no
    // transient emission, no cursor poisoning (no outbox row is written).
    if (!isStableMessageRow(mrow)) {
      logger.info(`[ensureMessageClosure] parent message ${messageId} transient, defer closure`)
      return false
    }
    return enqueueMessageFull(messageId, Math.max(0, childTs - 1))
  } catch {
    return false
  }
}

function ensureBlockParentClosure(blockId: string, childTs: number): boolean {
  const brow = getBlockRow(blockId)
  if (!brow) return false
  const messageId = typeof brow.messageId === 'string' ? brow.messageId : null
  if (!messageId) return false
  return ensureMessageClosure(messageId, childTs)
}

function ensureMessageParentClosure(messageId: string, childTs: number): boolean {
  const mrow = getMessageRow(messageId)
  if (!mrow) return false
  const topicId = typeof mrow.topicId === 'string' ? mrow.topicId : null
  if (!topicId) return false
  return ensureTopicClosure(topicId, childTs)
}

/**
 * Capture actual changed entities only. Missing/foreign/no-op targets must not
 * emit destructive or stale remote operations:
 * - Upsert paths re-read the committed row; a missing row means no-op -> skip.
 * - Update/delete paths additionally verify ownership and post-state: a row
 *   that survives a delete, or a row whose parent identity disagrees with the
 *   request topic, proves a foreign/no-op -> skip, never a remote mutation.
 * - EnsureTopic is create-only: the aggregate TX path emits only for rows
 *   absent pre-mutation (true creation); this post-commit fallback emits
 *   only for untracked topics whose committed createdAt proves same-clock
 *   recent creation. Existing-topic ensures are no-ops -> skip, never a
 *   stale full snapshot.
 * - Empty UpdateTopicMetadata (no mutable keys) -> skip.
 * - Delete paths only enqueue when the post-state proves removal AND the
 *   entity was tracked locally. An unknown id (missing/foreign) is skipped,
 *   never a remote delete. Distinguishes soft-delete (upsert with deletedAt)
 *   from hard-delete (op=delete).
 *
 * Post-commit capture window (bounded, documented): the hook runs after the
 * ChatDb transaction commits. A crash between commit and outbox enqueue loses
 * the operation; enqueue failures are recorded durably via
 * recordCaptureFailure (sync_state lastCaptureError + lastError) and never
 * affect the ChatDb result envelope. Same-transaction capture was judged too
 * invasive for this pass; the residual crash window is an explicit remaining
 * limitation, not claimed atomicity.
 */
export function handleChatDbSuccessForSync(channel: string, request: any, result?: any): void {
  // Publisher-barrier quiescence (SYNC-DATA-026): the post-commit fallback
  // cannot roll back already-committed rows, so while the barrier is held it
  // refuses capture fail-closed — no outbox intent is written — and records
  // the missing intent durably instead of silently diverging. Aggregate-gated
  // local mutations never reach here under the barrier; only a bypass path
  // that committed behind the gate can. Follows the existing
  // recordCaptureFailure observability (LOCK-PERSONAL-009), never throws into
  // the ChatDb result envelope.
  if (syncService.isPublishBarrierHeld()) {
    logger.warn(`[handleChatDbSuccessForSync] ${channel} capture refused while publish barrier held`)
    try {
      syncService.recordCaptureFailure(channel, new Error('sync capture refused while publish barrier held'))
    } catch (secondary) {
      const detail = secondary instanceof Error ? secondary.message : String(secondary)
      logger.error(`[handleChatDbSuccessForSync] ${channel} capture-error persistence failed: ${detail}`)
      throw secondary instanceof Error ? secondary : new Error(String(secondary))
    }
    return
  }
  try {
    const cfg = syncService.getConfig()
    if (!cfg.enabled) return
  } catch (e) {
    // Fail closed (LOCK-PERSONAL-006): an infrastructure failure deciding
    // capture must not become a silent skip. Record durably, then return
    // without mutating sync intent (post-commit hook cannot roll back).
    // A capture-error persistence failure stays observable via scoped logging
    // plus rethrow (LOCK-PERSONAL-009) — never swallowed.
    try {
      syncService.recordCaptureFailure(channel, e)
    } catch (secondary) {
      const detail = secondary instanceof Error ? secondary.message : String(secondary)
      logger.error(`[handleChatDbSuccessForSync] ${channel} capture-error persistence failed: ${detail}`)
      throw secondary instanceof Error ? secondary : new Error(String(secondary))
    }
    return
  }

  const ts = Date.now()
  try {
    switch (channel) {
      case IpcChannel.ChatDb_EnsureTopic: {
        const topicId = safeString(request?.topicId)
        if (!topicId) return
        // Create-only path (LOCK-PERSONAL-005): an already-tracked topic
        // means this ensure was a no-op (assistantId/name are set only on
        // creation) -> skip so existing-topic ensures never emit stale
        // snapshots. NOTE: the aggregate TX path is authoritative for true
        // creates (it observes actual pre-mutation existence); this
        // post-commit fallback cannot observe pre-state, so for untracked
        // topics the committed createdAt is the only truthful creation
        // proof (ensure stamps createdAt=now only on creation, same clock):
        // a stale row proves a pre-existing no-op -> skip, never a snapshot.
        if (syncService.isTrackedEntity('topic', topicId)) {
          logger.info(`[handleChatDbSuccessForSync] EnsureTopic ${topicId} already tracked, skip (no-op)`)
          break
        }
        {
          const db = requireDb()
          const row = db.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get()
          if (!row) {
            syncService.recordCaptureFailure(channel, new Error(`ensureTopic ${topicId} not found after commit`))
            break
          }
          const createdMs = Date.parse((row as { createdAt?: unknown }).createdAt as string)
          // Bounded creation window: same-clock creation proof. Unparseable
          // timestamps fail closed (durable failure, no emit); stale rows are
          // proven pre-existing no-ops (silent skip, no emit).
          if (!Number.isFinite(createdMs)) {
            syncService.recordCaptureFailure(
              channel,
              new Error(`ensureTopic ${topicId} unparseable createdAt, cannot prove creation`)
            )
            break
          }
          if (ts - createdMs > 60_000 || createdMs - ts > 5_000) {
            logger.info(`[handleChatDbSuccessForSync] EnsureTopic ${topicId} pre-existing row, skip (no-op)`)
            break
          }
        }
        if (!enqueueTopicFull(topicId, ts)) {
          syncService.recordCaptureFailure(channel, new Error(`ensureTopic ${topicId} not found after commit`))
        }
        break
      }
      case IpcChannel.ChatDb_AppendMessage: {
        const topicId = safeString(request?.topicId)
        const message = request?.message as Record<string, unknown> | undefined
        const blocks = (request?.blocks as Record<string, unknown>[]) ?? []
        const msgId = safeString((message as any)?.id)
        if (!msgId) return
        // Stable checkpoint gate fallback (LOCK-PERSONAL-004): transient
        // assistant stubs are legitimate skips (no outbox, no failure).
        // Production TX-owned appends already gated atomically; this covers
        // direct hook callers whose rows bypassed the aggregate.
        {
          const committedForGate = getMessageRow(msgId)
          if (committedForGate) {
            const role = (committedForGate as { role?: unknown }).role
            if (role === 'assistant' && !isStableMessageRow(committedForGate)) {
              logger.info(`[handleChatDbSuccessForSync] AppendMessage ${msgId} transient assistant stub, skip`)
              return
            }
          } else if ((message as { role?: unknown })?.role === 'assistant') {
            const st = (message as { status?: unknown })?.status
            if (!isStableMessageStatus(st)) {
              logger.info(`[handleChatDbSuccessForSync] AppendMessage ${msgId} transient assistant stub, skip`)
              return
            }
          }
        }
        // Authoritative ownership guard mirror (sync F1): a committed row
        // owned by another topic proves a foreign append. Skip all capture
        // (message + blocks) so no sync mutation is emitted. The aggregate
        // itself rejects this case; this is defense-in-depth for any path
        // that still reports success with a foreign owner.
        if (topicId) {
          const committed = getMessageRow(msgId)
          if (committed && committed.topicId !== topicId) {
            logger.info(`[handleChatDbSuccessForSync] AppendMessage ${msgId} foreign topic, skip`)
            return
          }
        }
        // Fetch committed full entities instead of replaying request objects.
        // Message first, then blocks: listOutbox dependency priority keeps
        // this order on push so relay seq preserves parent-before-child.
        // Direct parent closure: a compound-created (untracked) topic must be
        // captured first so the new message is never an orphan remotely.
        if (topicId) {
          const committedForClosure = getMessageRow(msgId)
          const closureTopicId =
            committedForClosure && typeof committedForClosure.topicId === 'string'
              ? committedForClosure.topicId
              : topicId
          if (!ensureTopicClosure(closureTopicId, ts)) {
            syncService.recordCaptureFailure(
              channel,
              new Error(`appendMessage parent topic closure unavailable for message ${msgId}`)
            )
            return
          }
        }
        if (!enqueueMessageFull(msgId, ts)) {
          syncService.recordCaptureFailure(channel, new Error(`appendMessage message ${msgId} not found after commit`))
        }
        for (let i = 0; i < blocks.length; i++) {
          const bid = safeString((blocks[i] as any).id)
          if (!bid) continue
          // Stable gate per block (LOCK-PERSONAL-004): transient blocks are
          // legitimate skips; the stable update later creates full state.
          const browForGate = getBlockRow(bid)
          if (browForGate && !isStableBlockRow(browForGate)) {
            logger.info(`[handleChatDbSuccessForSync] AppendMessage block ${bid} transient status, skip`)
            continue
          }
          // Unsupported structured/attachment rows skip without a partial
          // null-content shell; the skip is durably recorded (never silent).
          if (browForGate && isUnsupportedBlockRow(browForGate)) {
            recordUnsupportedBlock(channel, bid)
            continue
          }
          // Bounded per-block timestamp offset preserves parent-before-child
          // even when outbox rows share the same base timestamp.
          if (!enqueueBlockFull(bid, ts + i + 1)) {
            syncService.recordCaptureFailure(channel, new Error(`appendMessage block ${bid} not found after commit`))
          }
        }
        break
      }
      case IpcChannel.ChatDb_UpdateMessage: {
        const msgId = safeString(request?.messageId)
        const topicId = safeString(request?.topicId)
        if (!msgId) return
        if (!messagePatchHasMutableKeys(request?.updates)) {
          logger.info(`[handleChatDbSuccessForSync] UpdateMessage ${msgId} empty patch, skip`)
          return
        }
        const row = getMessageRow(msgId)
        if (!row) {
          logger.info(`[handleChatDbSuccessForSync] UpdateMessage ${msgId} not found, skip capture`)
          return
        }
        if (topicId && row.topicId !== topicId) {
          logger.info(`[handleChatDbSuccessForSync] UpdateMessage ${msgId} foreign topic, skip`)
          return
        }
        // Stable checkpoint only: intermediate statuses are transient skips.
        if (!isStableMessageRow(row)) {
          logger.info(`[handleChatDbSuccessForSync] UpdateMessage ${msgId} transient status, skip`)
          return
        }
        // Promotion proof: a never-tracked message carries stable descendants
        // committed with its transient stub that must join this checkpoint.
        const trackedBeforeUpdate = syncService.isTrackedEntity('message', msgId)
        if (!ensureMessageParentClosure(msgId, ts)) {
          syncService.recordCaptureFailure(
            channel,
            new Error(`updateMessage parent topic closure unavailable for message ${msgId}`)
          )
          return
        }
        if (!enqueueMessageFull(msgId, ts)) {
          syncService.recordCaptureFailure(channel, new Error(`updateMessage message ${msgId} capture failed`))
          return
        }
        // Deterministic rescan (LOCK-PERSONAL-004): every stable promotion
        // re-checks all stable descendants even when the parent was already
        // tracked, so a prior partial backfill is retried, never abandoned.
        void trackedBeforeUpdate
        if (!enqueueUntrackedStableBlocksForMessage(msgId, ts, new Set<string>(), channel)) {
          syncService.recordCaptureFailure(
            channel,
            new Error(`updateMessage stable descendants unavailable for message ${msgId}`)
          )
          return
        }
        break
      }
      case IpcChannel.ChatDb_UpdateMessageAndBlocks: {
        const topicId = safeString(request?.topicId)
        const msgUpdates = (request?.messageUpdates as Record<string, unknown>) ?? {}
        const msgId = safeString((msgUpdates as any).id)
        const requestedBlockIds = new Set<string>()
        for (const b of (request?.blocksToUpdate as Record<string, unknown>[]) ?? []) {
          const bid = safeString((b as any).id)
          if (bid) requestedBlockIds.add(bid)
        }
        if (msgId) {
          const mrow = getMessageRow(msgId)
          if (!mrow) {
            logger.info(`[handleChatDbSuccessForSync] UpdateMessageAndBlocks message ${msgId} missing, skip`)
          } else if (topicId && mrow.topicId !== topicId) {
            logger.info(`[handleChatDbSuccessForSync] UpdateMessageAndBlocks message ${msgId} foreign topic, skip`)
          } else if (messagePatchHasMutableKeys(msgUpdates)) {
            if (!isStableMessageRow(mrow)) {
              logger.info(`[handleChatDbSuccessForSync] UpdateMessageAndBlocks message ${msgId} transient status, skip`)
            } else {
              const trackedBeforeUpdate = syncService.isTrackedEntity('message', msgId)
              if (!ensureMessageParentClosure(msgId, ts)) {
                syncService.recordCaptureFailure(
                  channel,
                  new Error(`updateMessageAndBlocks parent topic closure unavailable for message ${msgId}`)
                )
              } else if (!enqueueMessageFull(msgId, ts)) {
                syncService.recordCaptureFailure(
                  channel,
                  new Error(`updateMessageAndBlocks message ${msgId} capture failed`)
                )
              } else {
                // Deterministic rescan (LOCK-PERSONAL-004): see UpdateMessage.
                void trackedBeforeUpdate
                if (!enqueueUntrackedStableBlocksForMessage(msgId, ts, requestedBlockIds, channel)) {
                  syncService.recordCaptureFailure(
                    channel,
                    new Error(`updateMessageAndBlocks stable descendants unavailable for message ${msgId}`)
                  )
                }
              }
            }
          } else {
            logger.info(`[handleChatDbSuccessForSync] UpdateMessageAndBlocks message ${msgId} empty patch, skip`)
          }
        }
        const blocks = (request?.blocksToUpdate as Record<string, unknown>[]) ?? []
        for (const b of blocks) {
          const bid = safeString((b as any).id)
          if (!bid) continue
          const brow = getBlockRow(bid)
          if (!brow) {
            logger.info(`[handleChatDbSuccessForSync] block ${bid} missing after UpdateMessageAndBlocks, skip`)
            continue
          }
          // Ownership: block must belong to the updated message, whose topic
          // must match the request topic. Foreign blocks are no-ops locally.
          if (msgId && brow.messageId !== msgId) {
            logger.info(`[handleChatDbSuccessForSync] block ${bid} foreign message, skip`)
            continue
          }
          if (topicId && msgId) {
            const parent = getMessageRow(brow.messageId)
            if (parent && parent.topicId !== topicId) {
              logger.info(`[handleChatDbSuccessForSync] block ${bid} foreign topic, skip`)
              continue
            }
          }
          // Stable checkpoint only: intermediate block statuses are transient.
          if (!isStableBlockRow(brow)) {
            logger.info(`[handleChatDbSuccessForSync] block ${bid} transient status, skip`)
            continue
          }
          // Unsupported structured/attachment rows skip without a partial shell.
          if (isUnsupportedBlockRow(brow)) {
            recordUnsupportedBlock(channel, bid)
            continue
          }
          if (!ensureBlockParentClosure(bid, ts)) {
            syncService.recordCaptureFailure(
              channel,
              new Error(`updateMessageAndBlocks parent closure unavailable for block ${bid}`)
            )
            continue
          }
          if (!enqueueBlockFull(bid, ts)) {
            syncService.recordCaptureFailure(channel, new Error(`updateMessageAndBlocks block ${bid} capture failed`))
          }
        }
        const deletes = (request?.blockIdsToDelete as string[]) ?? []
        for (const bid of deletes) {
          if (typeof bid !== 'string' || bid.length === 0) continue
          // Post-state proof: a surviving row means the delete was a
          // missing/foreign no-op -> never a remote delete.
          if (rowStillExists('message_block', bid)) {
            logger.info(`[handleChatDbSuccessForSync] block delete ${bid} no-op (row survives), skip`)
            continue
          }
          if (!syncService.isKnownEntity('message_block', bid)) {
            logger.info(`[handleChatDbSuccessForSync] block delete ${bid} unknown locally, skip`)
            continue
          }
          const op = syncService.recordDelete('message_block', bid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`delete block ${bid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_UpdateBlocks: {
        const blocks = (request?.blocks as Record<string, unknown>[]) ?? []
        for (const b of blocks) {
          const bid = safeString((b as any).id)
          if (!bid) continue
          const brow = getBlockRow(bid)
          // Proven-absent target is a non-error no-op: return before any
          // parent closure so no false capture error is recorded.
          // Infrastructure read errors throw above and stay durable failures.
          if (!brow) {
            logger.info(`[handleChatDbSuccessForSync] UpdateBlocks block ${bid} missing, skip (no-op)`)
            continue
          }
          if (brow && !isStableBlockRow(brow)) {
            logger.info(`[handleChatDbSuccessForSync] UpdateBlocks block ${bid} transient status, skip`)
            continue
          }
          if (brow && isUnsupportedBlockRow(brow)) {
            recordUnsupportedBlock(channel, bid)
            continue
          }
          if (!ensureBlockParentClosure(bid, ts)) {
            syncService.recordCaptureFailure(channel, new Error(`updateBlocks parent closure unavailable for ${bid}`))
            continue
          }
          if (!enqueueBlockFull(bid, ts)) {
            // Missing row with no committed state is a no-op skip; a stable
            // row that cannot be captured is a durable failure.
            if (brow && isStableBlockRow(brow)) {
              syncService.recordCaptureFailure(channel, new Error(`updateBlocks block ${bid} capture failed`))
            } else {
              logger.info(`[handleChatDbSuccessForSync] UpdateBlocks block ${bid} missing, skip`)
            }
          }
        }
        break
      }
      case IpcChannel.ChatDb_UpdateSingleBlock: {
        const bid = safeString(request?.blockId)
        if (!bid) return
        const brow = getBlockRow(bid)
        // Proven-absent target is a non-error no-op (see UpdateBlocks).
        if (!brow) {
          logger.info(`[handleChatDbSuccessForSync] UpdateSingleBlock ${bid} missing, skip (no-op)`)
          return
        }
        if (brow && !isStableBlockRow(brow)) {
          logger.info(`[handleChatDbSuccessForSync] UpdateSingleBlock ${bid} transient status, skip`)
          return
        }
        if (brow && isUnsupportedBlockRow(brow)) {
          recordUnsupportedBlock(channel, bid)
          return
        }
        if (!ensureBlockParentClosure(bid, ts)) {
          syncService.recordCaptureFailure(
            channel,
            new Error(`updateSingleBlock parent closure unavailable for ${bid}`)
          )
          return
        }
        if (!enqueueBlockFull(bid, ts)) {
          if (brow && isStableBlockRow(brow)) {
            syncService.recordCaptureFailure(channel, new Error(`updateSingleBlock ${bid} capture failed`))
          } else {
            logger.info(`[handleChatDbSuccessForSync] UpdateSingleBlock ${bid} missing, skip`)
          }
          return
        }
        break
      }
      case IpcChannel.ChatDb_BulkAddBlocks: {
        const blocks = (request?.blocks as Record<string, unknown>[]) ?? []
        for (let i = 0; i < blocks.length; i++) {
          const bid = safeString((blocks[i] as any).id)
          if (!bid) continue
          const browGate = getBlockRow(bid)
          // Proven-absent target is a non-error no-op (see UpdateBlocks).
          if (!browGate) {
            logger.info(`[handleChatDbSuccessForSync] bulkAddBlocks ${bid} missing, skip (no-op)`)
            continue
          }
          if (browGate && !isStableBlockRow(browGate)) {
            logger.info(`[handleChatDbSuccessForSync] bulkAddBlocks ${bid} transient status, skip`)
            continue
          }
          if (browGate && isUnsupportedBlockRow(browGate)) {
            recordUnsupportedBlock(channel, bid)
            continue
          }
          const childTs = ts + i
          if (!ensureBlockParentClosure(bid, childTs)) {
            syncService.recordCaptureFailure(channel, new Error(`bulkAddBlocks parent closure unavailable for ${bid}`))
            continue
          }
          if (!enqueueBlockFull(bid, childTs)) {
            syncService.recordCaptureFailure(channel, new Error(`bulkAddBlocks block ${bid} missing`))
          }
        }
        break
      }
      case IpcChannel.ChatDb_DeleteBlocks: {
        const ids = (request?.blockIds as string[]) ?? []
        for (const bid of ids) {
          if (typeof bid !== 'string' || bid.length === 0) continue
          if (rowStillExists('message_block', bid)) {
            logger.info(`[handleChatDbSuccessForSync] deleteBlocks ${bid} no-op (row survives), skip`)
            continue
          }
          if (!syncService.isKnownEntity('message_block', bid)) {
            logger.info(`[handleChatDbSuccessForSync] deleteBlocks ${bid} unknown locally, skip`)
            continue
          }
          const op = syncService.recordDelete('message_block', bid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`deleteBlocks ${bid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_DeleteMessage: {
        const mid = safeString(request?.messageId)
        const topicId = safeString(request?.topicId)
        if (mid) {
          // Ownership pre-check on the request topic is impossible post-delete
          // (row gone), so post-state is the proof: surviving row = foreign
          // no-op. For a gone row, tracked-ness gates the emit.
          if (rowStillExists('message', mid)) {
            logger.info(`[handleChatDbSuccessForSync] deleteMessage ${mid} no-op (row survives), skip`)
            break
          }
          void topicId
          if (!syncService.isKnownEntity('message', mid)) {
            logger.info(`[handleChatDbSuccessForSync] deleteMessage ${mid} unknown locally, skip`)
            break
          }
          const op = syncService.recordDelete('message', mid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`deleteMessage ${mid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_DeleteMessages: {
        const ids = (request?.messageIds as string[]) ?? []
        for (const mid of ids) {
          if (typeof mid !== 'string' || mid.length === 0) continue
          if (rowStillExists('message', mid)) {
            logger.info(`[handleChatDbSuccessForSync] deleteMessages ${mid} no-op (row survives), skip`)
            continue
          }
          if (!syncService.isKnownEntity('message', mid)) {
            logger.info(`[handleChatDbSuccessForSync] deleteMessages ${mid} unknown locally, skip`)
            continue
          }
          const op = syncService.recordDelete('message', mid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`deleteMessages ${mid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_UpdateTopicMetadata: {
        const tid = safeString(request?.topicId)
        if (!tid) return
        if (!topicMetadataHasMutableKeys(request)) {
          logger.info(`[handleChatDbSuccessForSync] UpdateTopicMetadata ${tid} empty, skip`)
          return
        }
        if (!enqueueTopicFull(tid, ts)) {
          logger.info(`[handleChatDbSuccessForSync] UpdateTopicMetadata ${tid} missing, skip`)
          return
        }
        break
      }
      case IpcChannel.ChatDb_SoftDeleteTopic: {
        const tid = safeString(request?.topicId)
        if (!tid) return
        // Soft-delete is upsert with deletedAt, not hard delete
        if (!enqueueTopicFull(tid, ts)) {
          // Missing after a successful soft-delete should not happen; if the
          // topic is unknown locally, skip rather than emitting a stale delete.
          if (!syncService.isKnownEntity('topic', tid)) {
            logger.info(`[handleChatDbSuccessForSync] softDeleteTopic ${tid} unknown locally, skip`)
            return
          }
          syncService.recordCaptureFailure(channel, new Error(`softDeleteTopic ${tid} missing after commit`))
        }
        break
      }
      case IpcChannel.ChatDb_HardDeleteTopic: {
        const tid = safeString(request?.topicId)
        if (tid) {
          // Only emit when the result proves a row was actually deleted.
          // Missing-topic hard-delete is a no-op and must not emit.
          const resultRec = result as { value?: { deletedTopicIds?: unknown } } | undefined
          const deletedIds: unknown = resultRec?.value?.deletedTopicIds
          if (Array.isArray(deletedIds)) {
            if (!deletedIds.includes(tid)) {
              logger.info(`[handleChatDbSuccessForSync] hardDeleteTopic ${tid} no-op, skip`)
              break
            }
          } else if (!syncService.isKnownEntity('topic', tid)) {
            logger.info(`[handleChatDbSuccessForSync] hardDeleteTopic ${tid} unknown locally, skip`)
            break
          }
          const op = syncService.recordDelete('topic', tid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`hardDeleteTopic ${tid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_RestoreTopic: {
        const tid = safeString(request?.topicId)
        if (!tid) return
        // Restore returns null when nothing was restored (missing or not in
        // trash) — a no-op that must not emit a stale upsert.
        const restoredValue: unknown = (result as { value?: unknown } | undefined)?.value
        if (result !== undefined && restoredValue === null) {
          logger.info(`[handleChatDbSuccessForSync] RestoreTopic ${tid} no-op, skip`)
          return
        }
        if (!enqueueTopicFull(tid, ts)) {
          logger.info(`[handleChatDbSuccessForSync] RestoreTopic ${tid} missing, skip`)
          return
        }
        break
      }
      case IpcChannel.ChatDb_ReorderMessages:
      case IpcChannel.ChatDb_ResetMessagesForResend:
      case IpcChannel.ChatDb_DeleteMessagesWithSegments:
      case IpcChannel.ChatDb_PasteMessagesToTopic:
      case IpcChannel.ChatDb_CloneMessagesToTopic:
      case IpcChannel.ChatDb_BranchMessagesToTopic:
      case IpcChannel.ChatDb_InsertMessagesAfterAnchor:
      case IpcChannel.ChatDb_SelectAnswerMessage:
        // Compound/multi-message mutations + reorder: not in supported sync
        // scope. Reorder is unsupported until an atomic ordering semantic
        // exists — no per-message sortOrder snapshots are emitted.
        // Explicitly skipped (narrow scope) to avoid partial capture.
        logger.info(
          `[handleChatDbSuccessForSync] ${channel} is not in supported sync scope, skipping capture (explicit narrow)`
        )
        break
      default:
        // Unsupported mutation paths — explicitly not captured for MVP
        break
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn(`[handleChatDbSuccessForSync] ${channel} hook failed: ${msg}`)
    // A capture-error persistence failure (SyncCaptureError) is logged and
    // rethrown so it stays inspectable via logger + IPC warn (the ChatDb
    // commit itself is untouched); never silently swallowed (LOCK-PERSONAL-009).
    try {
      syncService.recordCaptureFailure(channel, e)
    } catch (secondary) {
      const detail = secondary instanceof Error ? secondary.message : String(secondary)
      logger.error(`[handleChatDbSuccessForSync] ${channel} capture-error persistence failed: ${detail}`)
      throw secondary instanceof Error ? secondary : new Error(String(secondary))
    }
  }
}
