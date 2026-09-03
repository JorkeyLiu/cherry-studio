import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { eq } from 'drizzle-orm'

import { chatDbService } from '../chatDb'
import * as schema from '../chatDb/schema'
import { syncService } from './SyncService'

const logger = loggerService.withContext('SyncChatDbHook')

function safeString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function getDb() {
  try {
    return chatDbService.getDatabase()
  } catch {
    return null
  }
}

function enqueueTopicFull(topicId: string, ts: number): boolean {
  const db = getDb()
  if (!db) return false
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
    deletedAt: row.deletedAt
  }
  const op = syncService.recordUpsert('topic', topicId, payload, ts)
  return !!op
}

function enqueueMessageFull(messageId: string, ts: number): boolean {
  const db = getDb()
  if (!db) return false
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
  const db = getDb()
  if (!db) return false
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

function getMessageRow(messageId: string): any | null {
  const db = getDb()
  if (!db) return null
  try {
    return db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get() ?? null
  } catch {
    return null
  }
}

function getBlockRow(blockId: string): any | null {
  const db = getDb()
  if (!db) return null
  try {
    return db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, blockId)).get() ?? null
  } catch {
    return null
  }
}

/** Delete happened iff the row is gone post-commit; a surviving row means foreign/no-op. */
function rowStillExists(entityType: 'message' | 'message_block', id: string): boolean {
  return entityType === 'message' ? !!getMessageRow(id) : !!getBlockRow(id)
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
 * Capture actual changed entities only. Missing/foreign/no-op targets must not
 * emit destructive or stale remote operations:
 * - Upsert paths re-read the committed row; a missing row means no-op -> skip.
 * - Update/delete paths additionally verify ownership and post-state: a row
 *   that survives a delete, or a row whose parent identity disagrees with the
 *   request topic, proves a foreign/no-op -> skip, never a remote mutation.
 * - EnsureTopic emits only for newly tracked topics (clock/outbox miss);
 *   existing-topic ensure is a create-only no-op -> skip.
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
  try {
    const cfg = syncService.getConfig()
    if (!cfg.enabled) return
  } catch {
    return
  }

  const ts = Date.now()
  try {
    switch (channel) {
      case IpcChannel.ChatDb_EnsureTopic: {
        const topicId = safeString(request?.topicId)
        if (!topicId) return
        // Create-only path: an already-tracked topic means this ensure was a
        // no-op (assistantId/name are set only on creation) -> skip so
        // existing-topic ensures never emit stale snapshots.
        if (syncService.isTrackedEntity('topic', topicId)) {
          logger.info(`[handleChatDbSuccessForSync] EnsureTopic ${topicId} already tracked, skip (no-op)`)
          break
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
        if (!enqueueMessageFull(msgId, ts)) {
          syncService.recordCaptureFailure(channel, new Error(`appendMessage message ${msgId} not found after commit`))
        }
        for (let i = 0; i < blocks.length; i++) {
          const bid = safeString((blocks[i] as any).id)
          if (!bid) continue
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
        if (!enqueueMessageFull(msgId, ts)) {
          logger.info(`[handleChatDbSuccessForSync] UpdateMessage ${msgId} not found, skip capture`)
          return
        }
        break
      }
      case IpcChannel.ChatDb_UpdateMessageAndBlocks: {
        const topicId = safeString(request?.topicId)
        const msgUpdates = (request?.messageUpdates as Record<string, unknown>) ?? {}
        const msgId = safeString((msgUpdates as any).id)
        if (msgId) {
          const mrow = getMessageRow(msgId)
          if (!mrow) {
            logger.info(`[handleChatDbSuccessForSync] UpdateMessageAndBlocks message ${msgId} missing, skip`)
          } else if (topicId && mrow.topicId !== topicId) {
            logger.info(`[handleChatDbSuccessForSync] UpdateMessageAndBlocks message ${msgId} foreign topic, skip`)
          } else if (messagePatchHasMutableKeys(msgUpdates)) {
            if (!enqueueMessageFull(msgId, ts)) {
              logger.info(`[handleChatDbSuccessForSync] UpdateMessageAndBlocks message ${msgId} missing, skip`)
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
          if (!enqueueBlockFull(bid, ts)) {
            logger.info(`[handleChatDbSuccessForSync] block ${bid} missing after UpdateMessageAndBlocks, skip`)
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
          if (!enqueueBlockFull(bid, ts)) {
            logger.info(`[handleChatDbSuccessForSync] UpdateBlocks block ${bid} missing, skip`)
          }
        }
        break
      }
      case IpcChannel.ChatDb_UpdateSingleBlock: {
        const bid = safeString(request?.blockId)
        if (!bid) return
        if (!enqueueBlockFull(bid, ts)) {
          logger.info(`[handleChatDbSuccessForSync] UpdateSingleBlock ${bid} missing, skip`)
          return
        }
        break
      }
      case IpcChannel.ChatDb_BulkAddBlocks: {
        const blocks = (request?.blocks as Record<string, unknown>[]) ?? []
        for (let i = 0; i < blocks.length; i++) {
          const bid = safeString((blocks[i] as any).id)
          if (!bid) continue
          if (!enqueueBlockFull(bid, ts + i)) {
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
      case IpcChannel.ChatDb_ReorderMessages: {
        const topicId = safeString(request?.topicId)
        const messageIds = (request?.messageIds as string[]) ?? []
        if (!topicId || messageIds.length === 0) return
        // Enqueue full message snapshots with updated sortOrder for each id.
        // Foreign ids (parent topic mismatch) are no-ops locally -> skip.
        for (const mid of messageIds) {
          if (typeof mid !== 'string' || mid.length === 0) continue
          const mrow = getMessageRow(mid)
          if (!mrow) {
            logger.info(`[handleChatDbSuccessForSync] reorder message ${mid} missing, skip`)
            continue
          }
          if (mrow.topicId !== topicId) {
            logger.info(`[handleChatDbSuccessForSync] reorder message ${mid} foreign topic, skip`)
            continue
          }
          if (!enqueueMessageFull(mid, ts)) {
            logger.info(`[handleChatDbSuccessForSync] reorder message ${mid} missing, skip`)
          }
        }
        break
      }
      case IpcChannel.ChatDb_ResetMessagesForResend:
      case IpcChannel.ChatDb_DeleteMessagesWithSegments:
      case IpcChannel.ChatDb_PasteMessagesToTopic:
      case IpcChannel.ChatDb_CloneMessagesToTopic:
      case IpcChannel.ChatDb_BranchMessagesToTopic:
      case IpcChannel.ChatDb_InsertMessagesAfterAnchor:
      case IpcChannel.ChatDb_SelectAnswerMessage:
        // Compound/multi-message mutations: not in supported sync scope for
        // MVP. Explicitly skipped (narrow scope) to avoid partial capture.
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
    try {
      syncService.recordCaptureFailure(channel, e)
    } catch {}
  }
}
