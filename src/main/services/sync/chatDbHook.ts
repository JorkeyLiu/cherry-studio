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

export function handleChatDbSuccessForSync(channel: string, request: any): void {
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
        if (!enqueueTopicFull(topicId, ts)) {
          // fallback to request-based payload if fetch failed but topic was ensured
          const payload: Record<string, unknown> = {
            id: topicId,
            name: safeString(request?.name) ?? null,
            assistantId: safeString(request?.assistantId) ?? null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
          const op = syncService.recordUpsert('topic', topicId, payload, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error('ensureTopic enqueue failed'))
        }
        break
      }
      case IpcChannel.ChatDb_AppendMessage: {
        const message = request?.message as Record<string, unknown> | undefined
        const blocks = (request?.blocks as Record<string, unknown>[]) ?? []
        const msgId = safeString((message as any)?.id)
        if (!msgId) return
        // Fetch committed full entities instead of replaying request objects
        if (!enqueueMessageFull(msgId, ts)) {
          syncService.recordCaptureFailure(channel, new Error(`appendMessage message ${msgId} not found after commit`))
        }
        for (const b of blocks) {
          const bid = safeString((b as any).id)
          if (!bid) continue
          if (!enqueueBlockFull(bid, ts)) {
            syncService.recordCaptureFailure(channel, new Error(`appendMessage block ${bid} not found after commit`))
          }
        }
        break
      }
      case IpcChannel.ChatDb_UpdateMessage: {
        const msgId = safeString(request?.messageId)
        if (!msgId) return
        if (!enqueueMessageFull(msgId, ts)) {
          // No-op/missing/foreign-target — do not enqueue partial request
          logger.info(`[handleChatDbSuccessForSync] UpdateMessage ${msgId} not found, skip capture`)
          return
        }
        break
      }
      case IpcChannel.ChatDb_UpdateMessageAndBlocks: {
        const msgUpdates = (request?.messageUpdates as Record<string, unknown>) ?? {}
        const msgId = safeString((msgUpdates as any).id)
        if (msgId) {
          if (!enqueueMessageFull(msgId, ts)) {
            logger.info(`[handleChatDbSuccessForSync] UpdateMessageAndBlocks message ${msgId} missing, skip`)
          }
        }
        const blocks = (request?.blocksToUpdate as Record<string, unknown>[]) ?? []
        for (const b of blocks) {
          const bid = safeString((b as any).id)
          if (!bid) continue
          if (!enqueueBlockFull(bid, ts)) {
            logger.info(`[handleChatDbSuccessForSync] block ${bid} missing after UpdateMessageAndBlocks, skip`)
          }
        }
        const deletes = (request?.blockIdsToDelete as string[]) ?? []
        for (const bid of deletes) {
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
        for (const b of blocks) {
          const bid = safeString((b as any).id)
          if (!bid) continue
          if (!enqueueBlockFull(bid, ts)) {
            syncService.recordCaptureFailure(channel, new Error(`bulkAddBlocks block ${bid} missing`))
          }
        }
        break
      }
      case IpcChannel.ChatDb_DeleteBlocks: {
        const ids = (request?.blockIds as string[]) ?? []
        for (const bid of ids) {
          if (typeof bid !== 'string' || bid.length === 0) continue
          const op = syncService.recordDelete('message_block', bid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`deleteBlocks ${bid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_DeleteMessage: {
        const mid = safeString(request?.messageId)
        if (mid) {
          const op = syncService.recordDelete('message', mid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`deleteMessage ${mid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_DeleteMessages: {
        const ids = (request?.messageIds as string[]) ?? []
        for (const mid of ids) {
          if (typeof mid !== 'string' || mid.length === 0) continue
          const op = syncService.recordDelete('message', mid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`deleteMessages ${mid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_UpdateTopicMetadata: {
        const tid = safeString(request?.topicId)
        if (!tid) return
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
          // If topic is now soft-deleted but fetch still returns row with deletedAt, we already handled
          // If fetch fails (hard?) then fallback to delete? But soft should have row
          syncService.recordCaptureFailure(channel, new Error(`softDeleteTopic ${tid} missing after commit`))
        }
        break
      }
      case IpcChannel.ChatDb_HardDeleteTopic: {
        const tid = safeString(request?.topicId)
        if (tid) {
          const op = syncService.recordDelete('topic', tid, ts)
          if (!op) syncService.recordCaptureFailure(channel, new Error(`hardDeleteTopic ${tid} failed`))
        }
        break
      }
      case IpcChannel.ChatDb_RestoreTopic: {
        const tid = safeString(request?.topicId)
        if (!tid) return
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
        // Enqueue full message snapshots with updated sortOrder for each id
        for (const mid of messageIds) {
          if (typeof mid !== 'string' || mid.length === 0) continue
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
        // Compound/multi-message mutations: enqueue each affected message/block if feasible
        // For MVP, we explicitly mark these as unsupported for sync to avoid partial capture
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
