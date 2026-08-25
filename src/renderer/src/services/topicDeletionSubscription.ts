/**
 * topicDeletionSubscription — renderer subscription for authoritative Main → renderer
 * deletion events (chatdb:topic-deleted).
 *
 * Subscribes via typed preload bridge (window.api.chatDb.onTopicDeleted) and
 * validates the event payload with the shared closed-set validator before
 * applying precise resident invalidation. No direct DB access, no StoreSync.
 *
 * Soft-delete never emits this event; failure never broadcasts.
 */

import { loggerService } from '@logger'
import { invalidateTopicsDeletion } from '@renderer/services/topicDeletionInvalidation'
import { validateTopicDeletionEvent } from '@shared/chatDb'

const logger = loggerService.withContext('TopicDeletionSubscription')

let unsubscribe: (() => void) | null = null

export function subscribeTopicDeletionEvents(): () => void {
  if (unsubscribe) return unsubscribe
  const api = (typeof window !== 'undefined' ? (window as unknown as { api?: unknown }).api : undefined) as
    | { chatDb?: { onTopicDeleted?: (cb: (e: unknown) => void) => () => void } }
    | undefined
  const onTopicDeleted = api?.chatDb?.onTopicDeleted
  if (typeof onTopicDeleted !== 'function') {
    logger.warn('Topic deletion event subscription unavailable: window.api.chatDb.onTopicDeleted not exposed')
    return () => {}
  }
  try {
    unsubscribe = onTopicDeleted((event: unknown) => {
      try {
        validateTopicDeletionEvent(event)
        const payload = event as { deletedTopicIds: string[] }
        if (!Array.isArray(payload.deletedTopicIds) || payload.deletedTopicIds.length === 0) return
        invalidateTopicsDeletion(payload.deletedTopicIds)
      } catch (error) {
        logger.warn('Invalid TopicDeletionEvent payload, discarding', error as Error)
      }
    })
    logger.info('Subscribed to chatdb:topic-deleted')
  } catch (error) {
    logger.warn('Failed to subscribe to topic deletion events', error as Error)
    return () => {}
  }
  return () => {
    try {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    } catch {
      // best effort
    }
  }
}

export function unsubscribeTopicDeletionEventsForTests(): void {
  if (unsubscribe) {
    try {
      unsubscribe()
    } catch {}
    unsubscribe = null
  }
}
