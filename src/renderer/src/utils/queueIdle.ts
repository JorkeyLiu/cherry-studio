/**
 * Renderer-local private idle callback registry for request queue.
 *
 * Private/non-serialized — not part of queue public API.
 * Provides retention settlement hook without exposing public clear/dispose.
 * Renderer-local only; no IPC/persistence/StoreSync.
 */

const queueIdleCallbacks = new Set<(topicId: string) => void>()

export function registerQueueIdleCallback(cb: (topicId: string) => void): () => void {
  queueIdleCallbacks.add(cb)
  return () => queueIdleCallbacks.delete(cb)
}

export function notifyQueueIdle(topicId: string): void {
  for (const cb of [...queueIdleCallbacks]) {
    try {
      cb(topicId)
    } catch {}
  }
}

// Test-only helper — not a public API
export function __test_getQueueIdleCallbackCountForTests(): number {
  return queueIdleCallbacks.size
}
