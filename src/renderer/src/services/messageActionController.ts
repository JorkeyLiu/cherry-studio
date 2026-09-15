import { loggerService } from '@logger'
import type { RootState } from '@renderer/store'
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

/**
 * Single unified assistant lookup: array id match first, then the
 * `defaultAssistant` fallback when its id matches. All controller resolvers
 * go through this seam so event-time lookup never diverges per call site.
 */
export function findAssistantById(state: RootState, assistantId: string): Assistant | undefined {
  const fromList = state.assistants.assistants.find((a) => a.id === assistantId)
  if (fromList) return fromList
  const fallback = state.assistants.defaultAssistant
  if (fallback && fallback.id === assistantId) return fallback
  return undefined
}

/**
 * Single unified event-time effective-model resolver.
 *
 * Priority mirrors the normal send/UI effective model (`useAssistant`):
 * explicit per-message model (regenerate/self-model path only) >
 * `assistant.model` > `assistant.defaultModel` > global `llm.defaultModel`.
 *
 * Audit note: `useAssistant` (`assistant?.model ?? assistant?.defaultModel ??
 * defaultModel`) is the canonical UI chain and the only existing helper that
 * covers `assistant.defaultModel`. `ApiService`/`parameterBuilder`/
 * `ConversationService`/`MessagesService` resolve `assistant.model ||
 * getDefaultModel()` and skip `assistant.defaultModel` — that narrower chain
 * is intentionally NOT copied here; the `useAssistant` chain wins so
 * event-time resend/regenerate never diverges from what the UI sends.
 */
export function resolveEffectiveModel(state: RootState, fresh: Assistant, explicitModel?: Model): Model | undefined {
  if (explicitModel) return explicitModel
  return fresh.model ?? fresh.defaultModel ?? state.llm?.defaultModel
}

export function resolveAssistantSnapshot(params: {
  topicId: string
  assistantId: string
  explicitModel?: Model | null
}): ResolvedAssistant | null {
  const state = store.getState()
  const fresh = findAssistantById(state, params.assistantId)
  if (!fresh) {
    logger.silly(`[resolveAssistantSnapshot] missing assistant ${params.assistantId}`)
    return null
  }
  const explicitModel = params.explicitModel ?? undefined
  // User resend passes explicitModel null so the global default fallback
  // applies; regenerate passes the per-message model only when its modelId is
  // truthy (see resolveAssistantSnapshotForMessage). The snapshot always
  // carries the resolved effective model when one exists; when all slots are
  // empty the snapshot stays model-less and the thunk fails closed.
  const effectiveModel = resolveEffectiveModel(state, fresh, explicitModel)
  const origAssistant: Assistant = effectiveModel ? { ...fresh, model: effectiveModel } : fresh
  const merged = mergeRequestAssistantSnapshot(origAssistant, fresh, params.topicId)
  const snapshot: Assistant = effectiveModel ? { ...merged, model: effectiveModel } : merged
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
  findAssistantById,
  resolveEffectiveModel,
  resolveAssistantSnapshot,
  resolveAssistantSnapshotForMessage,
  resolveRegenerateForAssistant,
  resolveResendForUser,
  resolveEditTarget
}
