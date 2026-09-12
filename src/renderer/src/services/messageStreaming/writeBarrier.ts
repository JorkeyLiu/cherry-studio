/**
 * Per-execution DB-write barrier for one assistant-response execution
 * (SYNC-DATA-055 issuer slice, F2 finalization quiescence).
 *
 * Tracks persistence promises produced by the execution's BlockManager path
 * (immediate `saveUpdatedBlockToDB` / `saveUpdatesToDB` calls plus throttled
 * trailing flushes). `quiesce()` resolves only after every tracked write
 * settles, so the success-final message write — and therefore the Main
 * stable_replace issuer, which re-verifies DB post-state in the same
 * transaction — can never observe a partially flushed streaming state.
 *
 * Deliberately tracks DB-write promises only: the throttled path's
 * `requestAnimationFrame` callbacks schedule Redux dispatches, never SQLite
 * writes, and awaiting a frame risks deadlock in occluded windows where RAF
 * never fires. Termination: tracked saves never spawn further saves, and
 * throttler flushes happen once before the drain loop, so the loop ends when
 * the last in-flight write settles (a hung write hangs like any inline
 * await — no silent skip).
 */
export class WriteBarrier {
  private readonly pending = new Set<Promise<unknown>>()

  /** Register a persistence promise; returns it unchanged for awaiting. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    const done = (): void => {
      this.pending.delete(promise)
    }
    promise.then(done, done)
    return promise
  }

  /** Number of currently unsettled tracked writes (diagnostic/test use). */
  get pendingCount(): number {
    return this.pending.size
  }

  /** Resolve after every tracked write settles (never rejects). */
  async quiesce(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }
}
