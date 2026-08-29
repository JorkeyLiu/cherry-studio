/**
 * Renderer-local private idle callback registry for window read queue.
 *
 * Private/non-serialized — not part of windowReadQueue public API.
 * Provides retention settlement hook without exposing public clear/dispose.
 * Renderer-local only; no IPC/persistence/StoreSync.
 */

const windowReadIdleCallbacks = new Set<(topicId: string) => void>()

export function registerWindowReadQueueIdleCallback(cb: (topicId: string) => void): () => void {
  windowReadIdleCallbacks.add(cb)
  return () => windowReadIdleCallbacks.delete(cb)
}

export function notifyWindowReadIdle(topicId: string): void {
  for (const cb of [...windowReadIdleCallbacks]) {
    try {
      cb(topicId)
    } catch {}
  }
}

// Test-only helper — not a public API
export function __test_getWindowReadIdleCallbackCountForTests(): number {
  return windowReadIdleCallbacks.size
}
