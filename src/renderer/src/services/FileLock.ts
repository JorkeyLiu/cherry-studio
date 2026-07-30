/**
 * Per-file async mutex/coordinator keyed by file ID.
 *
 * LOCK-001: Different file IDs remain fully concurrent.
 * LOCK-002: Operations on the same file ID are serialized.
 *
 * Usage:
 *   await FileLock.run(fileId, async () => {
 *     // critical section — serialized per fileId
 *   })
 */
class FileLock {
  private queues = new Map<string, Promise<unknown>>()

  /**
   * Enqueue an async operation for the given file ID.
   * Returns a promise that resolves/rejects when the operation completes.
   * Different IDs execute concurrently; same IDs are strictly serialized.
   */
  async run<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(fileId) ?? Promise.resolve()

    const next = prev.then(
      () => fn(),
      () => fn()
    )

    // Store the chained promise (always resolves so the queue doesn't block forever).
    // We use a finally to remove the entry once it settles.
    const settled = next.then(
      () => {},
      () => {}
    )
    this.queues.set(fileId, settled)

    // Clean up the map entry once this operation settles.
    void settled.then(() => {
      if (this.queues.get(fileId) === settled) {
        this.queues.delete(fileId)
      }
    })

    return next
  }

  /**
   * Returns true if there is a pending operation for the given file ID.
   */
  isLocked(fileId: string): boolean {
    return this.queues.has(fileId)
  }

  /**
   * For testing: wait for all queued operations to settle.
   */
  async drain(): Promise<void> {
    const pending = Array.from(this.queues.values())
    await Promise.allSettled(pending)
  }
}

/** Singleton instance shared across FileManager and OrphanCleanupService. */
export const fileLock = new FileLock()

export default fileLock
