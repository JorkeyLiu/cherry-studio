import { loggerService } from '@logger'
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
  resolveRegenerateForAssistant,
  resolveResendForUser,
  resolveEditTarget
}
