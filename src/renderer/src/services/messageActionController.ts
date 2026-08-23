import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db/DbService'
import store from '@renderer/store'
import { mergeRequestAssistantSnapshot } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Model } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'

const logger = loggerService.withContext('MessageActionController')

export type ActionTarget = {
  topicId: string
  messageId: string
}

export type ResolvedMessageTarget = {
  topicId: string
  message: Message
}

export type ResolvedAssistant = {
  fresh: Assistant
  snapshot: Assistant
  explicitModel?: Model
}

export type ResolvedAnswerGroup = {
  targetMessage: Message
  groupIds: string[]
}

/**
 * Single renderer-local event-time resolution seam for regenerate,
 * edit/resend, and answer-switch. All reads are synchronous against the
 * current Redux projection; no subscription is created so components do not
 * re-render for state only needed at event time.
 *
 * Explicit target IDs are authoritative — resolution never falls back to the
 * active topic. Ambient Assistant settings are refreshed from the store at
 * event time while intentional per-message/explicit model overrides are
 * preserved in the returned snapshot (types encode this separation).
 */

export function resolveMessageEntity(target: ActionTarget): Message | null {
  const state = store.getState()
  const msg = state.messages.entities[target.messageId]
  if (!msg) {
    logger.silly(`[resolveMessageEntity] missing ${target.messageId}`)
    return null
  }
  if (msg.topicId !== target.topicId) {
    logger.silly(`[resolveMessageEntity] cross-topic ${target.messageId} ${msg.topicId}!=${target.topicId}`)
    return null
  }
  return msg
}

export function resolveAssistantSnapshot(params: {
  topicId: string
  assistantId: string
  explicitModel?: Model | null
}): ResolvedAssistant | null {
  const state = store.getState()
  const fresh = state.assistants.assistants.find((a) => a.id === params.assistantId)
  if (!fresh) {
    logger.silly(`[resolveAssistantSnapshot] missing assistant ${params.assistantId}`)
    return null
  }
  const explicitModel = params.explicitModel ?? undefined
  const origAssistant: Assistant = explicitModel ? { ...fresh, model: explicitModel } : fresh
  const snapshot = mergeRequestAssistantSnapshot(origAssistant, fresh, params.topicId)
  return { fresh, snapshot, explicitModel }
}

export function resolveAssistantSnapshotForMessage(message: Message, topicId: string): ResolvedAssistant | null {
  // Align with regenerateAssistantResponseThunk: modelId truthy indicates
  // intentional per-message override. Legacy partial fields where model is
  // missing but modelId exists keep the fresh assistant model (no explicit
  // override). If modelId is falsy, no override even if model is present.
  const explicitModel: Model | undefined = message.modelId ? message.model : undefined
  return resolveAssistantSnapshot({
    topicId,
    assistantId: message.assistantId,
    explicitModel
  })
}

export function resolveAnswerGroup(target: ActionTarget): ResolvedAnswerGroup | null {
  const state = store.getState()
  const msg = resolveMessageEntity(target)
  if (!msg) return null
  if (msg.role !== 'assistant' || !msg.askId) return null
  const askId = msg.askId
  const allIds = state.messages.messageIdsByTopic[target.topicId] || []
  const groupIds = allIds
    .map((id) => state.messages.entities[id])
    .filter((m): m is Message => !!m && m.role === 'assistant' && m.askId === askId)
    .map((m) => m.id)
  if (!groupIds.includes(target.messageId)) return null
  if (groupIds.length === 0) return null
  return { targetMessage: msg, groupIds }
}

/**
 * S6.2b R-05: authoritative answer-group READ.
 *
 * Resolves the complete answer group from Main SQLite via
 * `chatdb:fetch-answer-group`. Validates topic/anchor membership and
 * anchor role/askId in ONE Main transaction, then returns the authoritative
 * ordered messageIds (sort_order ASC, id ASC). No renderer fallback to
 * partial projection.
 *
 * Failure (missing topic/anchor, cross-topic, anchor without usable askId,
 * transport error, or echo mismatch) returns null so the caller makes
 * NO mutation and NO Redux partial update.
 */
export async function fetchAuthoritativeAnswerGroup(target: ActionTarget): Promise<ResolvedAnswerGroup | null> {
  try {
    const result = await dbService.fetchAnswerGroup(target.topicId, target.messageId)
    if (result.topicId !== target.topicId || result.anchorMessageId !== target.messageId) {
      logger.warn(
        `[fetchAuthoritativeAnswerGroup] echo mismatch ${target.topicId}/${target.messageId} vs ${result.topicId}/${result.anchorMessageId}`
      )
      return null
    }
    if (!result.messageIds.includes(target.messageId)) {
      logger.warn(`[fetchAuthoritativeAnswerGroup] anchor missing from returned group ${target.messageId}`)
      return null
    }
    // Preserve the existing ResolvedAnswerGroup shape for compatibility:
    // targetMessage is best-effort local; if the renderer window is partial
    // and the anchor is somehow missing locally, synthesize a minimal placeholder
    // so the authoritative group can still be used (Main already validated).
    let targetMessage = resolveMessageEntity(target)
    if (!targetMessage) {
      targetMessage = {
        id: target.messageId,
        topicId: target.topicId,
        askId: result.askId,
        role: 'assistant'
      } as unknown as Message
    }
    return { targetMessage, groupIds: result.messageIds }
  } catch (e) {
    logger.silly(`[fetchAuthoritativeAnswerGroup] failed ${target.topicId}/${target.messageId}`, e as Error)
    return null
  }
}

/**
 * High-level resolvers that combine the primitives above.
 * Return null on invalid/missing/cross-topic targets so callers preserve
 * current rejection/error behavior (no dispatch, no Redux mutation).
 */
export function resolveRegenerateForAssistant(
  target: ActionTarget
): { message: Message; assistant: ResolvedAssistant } | null {
  const msg = resolveMessageEntity(target)
  if (!msg) return null
  if (msg.role !== 'assistant') return null
  const assistant = resolveAssistantSnapshotForMessage(msg, target.topicId)
  if (!assistant) return null
  return { message: msg, assistant }
}

export function resolveResendForUser(target: ActionTarget): { message: Message; assistant: ResolvedAssistant } | null {
  const msg = resolveMessageEntity(target)
  if (!msg) return null
  if (msg.role !== 'user') return null
  const assistant = resolveAssistantSnapshot({
    topicId: target.topicId,
    assistantId: msg.assistantId,
    explicitModel: null
  })
  if (!assistant) return null
  return { message: msg, assistant }
}

export function resolveEditTarget(target: ActionTarget): Message | null {
  return resolveMessageEntity(target)
}

export const messageActionController = {
  resolveMessageEntity,
  resolveAssistantSnapshot,
  resolveAssistantSnapshotForMessage,
  resolveAnswerGroup,
  fetchAuthoritativeAnswerGroup,
  resolveRegenerateForAssistant,
  resolveResendForUser,
  resolveEditTarget
}
