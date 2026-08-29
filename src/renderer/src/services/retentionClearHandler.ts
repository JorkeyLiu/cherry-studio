/**
 * Renderer-local retention clear handler registry.
 *
 * Private, non-serialized, renderer-local only.
 * Avoids static import cycle: topicDeletionInvalidation -> residentRetention -> store
 * and store -> residentRetention -> topicDeletionInvalidation -> store.
 *
 * The handler is set by residentRetention at startup and cleared on stop.
 * topicDeletionInvalidation calls it via clearRetentionForTopicIfAvailable without
 * statically importing residentRetention.
 */

let retentionClearHandler: ((topicId: string) => void) | null = null

export function setRetentionClearHandler(handler: ((topicId: string) => void) | null): void {
  retentionClearHandler = handler
}

export function clearRetentionForTopicIfAvailable(topicId: string): void {
  if (retentionClearHandler) {
    try {
      retentionClearHandler(topicId)
    } catch {}
  }
}
