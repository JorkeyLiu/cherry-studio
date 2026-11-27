import { loggerService } from '@logger'
import { throttle } from 'lodash'

import type { WriteBarrier } from './writeBarrier'

const logger = loggerService.withContext('StreamWriteScheduler')

/**
 * Per-call overrides for one scheduled block write. Absent fields fall back
 * to the execution-bound defaults captured at scheduler construction, so the
 * trailing write of a lodash throttle always carries this execution's context
 * — never a cross-execution mix.
 */
export interface ScheduledWriteContext {
  /** Immutable execution attempt; absent for ordinary writes (carrier omitted). */
  resendAttemptId?: string
  /** Execution barrier tracking the produced DB-write promise. */
  barrier?: WriteBarrier
  /**
   * Runtime Redux-mirror gate. Evaluated when the throttled write runs (not at
   * call time) so a mid-generation topic eviction stops mirroring without
   * stopping the DB patch. Absent = fall back to the scheduler default.
   */
  shouldMirrorToRedux?: () => boolean
  /**
   * Trustworthy topic ownership for scoped closure invalidation.
   * Absent = unknown ownership -> deliberate global fallback in middleware.
   */
  topicId?: string
  /**
   * Addressed route owner for the block-only DB write, paired with `topicId`.
   * The source execution pins its captured route here (never the active route).
   */
  branchId?: string | null
}

/** Resolved write target passed to the injected persistence callback. */
export interface ResolvedWriteTarget {
  resendAttemptId?: string
  topicId?: string
  branchId?: string | null
}

export interface StreamWriteSchedulerOptions {
  /** Maximum cadence/throttle window in ms (50ms, matching ordinary chat). */
  throttleMs: number
  /** Immutable execution attempt bound to every write of this execution. */
  resendAttemptId?: string
  /** Execution barrier; every produced DB-write promise is tracked here. */
  barrier?: WriteBarrier
  /** Trustworthy topic ownership bound to every write of this execution. */
  topicId?: string
  /** Captured execution route bound to every write (never re-resolved). */
  branchId?: string | null
  /** Default live-loaded gate for the Redux mirror. */
  isLoaded?: () => boolean
  /** Execution persistence: the block-only DB write channel. */
  performWrite: (id: string, update: any, target: ResolvedWriteTarget) => Promise<unknown> | unknown
  /** Redux mirror dispatch for one block update. */
  mirrorToRedux: (id: string, update: any, topicId?: string) => void
}

/**
 * Per-execution owner of streaming throttle + RAF tasks.
 *
 * Every generation (SSE response or channel stream) creates exactly one
 * instance bound to its immutable route/attempt and live loaded-gate. All
 * per-block throttle functions and `requestAnimationFrame` handles live and
 * die with this instance: two executions streaming the same block id can
 * never share a throttler or overwrite each other's trailing context, and
 * cancelling/flushing one execution cannot touch another's pending writes.
 *
 * Lifecycle: the owning execution flushes (never drops) via its BlockManager
 * `quiesceWrites` before the success-final persist, then `dispose()`s the
 * scheduler when the execution settles (normal, error, or abort). Dispose
 * cancels pending throttle timers and RAF handles, unregisters from the live
 * registry, and drops any later `schedule` call — in-flight barrier-tracked
 * DB promises still settle, but no new write is produced afterwards.
 *
 * Cross-execution cancellation (block deletion) is the only sanctioned global
 * operation: `cancelBlockEverywhere` fans a bare block id out to every live
 * scheduler. There is no shared throttler, no shared trailing context, no
 * persistent cache, and no TTL resurrection.
 */
/** Withheld per-block frame: RAF handle plus its Redux-mirror callback. */
interface PendingFrame {
  rafId: number
  mirror: () => void
}

export class StreamWriteScheduler {
  private readonly throttleMs: number
  private readonly resendAttemptId?: string
  private readonly barrier?: WriteBarrier
  private readonly topicId?: string
  private readonly branchId?: string | null
  private readonly isLoaded?: () => boolean
  private readonly performWrite: StreamWriteSchedulerOptions['performWrite']
  private readonly mirrorToRedux: StreamWriteSchedulerOptions['mirrorToRedux']
  private readonly throttlers = new Map<string, ReturnType<typeof throttle>>()
  /**
   * Pending per-block frame keyed by block id (mirror drained inline on terminal).
   * A single record keeps the withheld RAF handle and its Redux-mirror callback
   * in step: set together, replaced together, dropped together.
   */
  private readonly pendingFrames = new Map<string, PendingFrame>()
  private disposed = false

  constructor(options: StreamWriteSchedulerOptions) {
    this.throttleMs = options.throttleMs
    this.resendAttemptId = options.resendAttemptId
    this.barrier = options.barrier
    this.topicId = options.topicId
    this.branchId = options.branchId
    this.isLoaded = options.isLoaded
    this.performWrite = options.performWrite
    this.mirrorToRedux = options.mirrorToRedux
    liveSchedulers.add(this)
  }

  /** Whether `dispose()` has run; later `schedule` calls are dropped. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /** Number of blocks with a live throttler on this instance (diagnostic). */
  get pendingBlockCount(): number {
    return this.throttlers.size
  }

  /**
   * Schedule one throttled block write. The trailing invocation (lodash
   * semantics: latest call wins) resolves every context field against this
   * execution's bound defaults, so a trailing write always carries this
   * execution's attempt/barrier/route/mirror-gate.
   */
  schedule = (id: string, blockUpdate: any, ctx?: ScheduledWriteContext): void => {
    if (this.disposed) {
      return
    }
    this.getThrottler(id)(blockUpdate, ctx)
  }

  /**
   * Flush (never drop) one block's pending trailing write, preserving the
   * last state. No-op when nothing is pending.
   */
  flush = (id: string): void => {
    const throttler = this.throttlers.get(id)
    if (throttler) {
      throttler.flush()
    }
  }

  /** Flush every block id in scope (execution quiescence iterates its own set). */
  flushBlocks = (ids: Iterable<string>): void => {
    for (const id of ids) {
      this.flush(id)
    }
  }

  /** Cancel one block's pending throttle + RAF without running the trailing write. */
  cancel = (id: string): void => {
    const pending = this.pendingFrames.get(id)
    if (pending !== undefined) {
      cancelAnimationFrame(pending.rafId)
      this.pendingFrames.delete(id)
    }
    const throttler = this.throttlers.get(id)
    if (throttler) {
      throttler.cancel()
      this.throttlers.delete(id)
    }
  }
  /**
   * Run every pending Redux-mirror callback inline, in registration order.
   * DB writes are untouched and the barrier is never awaited here (a
   * withheld frame still mirrors synchronously; the live-loaded gate is
   * evaluated at drain time, same as at frame time). Terminal paths call
   * this after quiescence so the final projection publishes complete text
   * before the owner disposes (which cancels RAF).
   */
  drainMirrors = (): void => {
    if (this.disposed) {
      return
    }
    const pending = [...this.pendingFrames.entries()]
    this.pendingFrames.clear()
    for (const [id, frame] of pending) {
      cancelAnimationFrame(frame.rafId)
      try {
        frame.mirror()
      } catch (error) {
        logger.warn(`[drainMirrors] Mirror callback failed for block ${id}:`, error as Error)
      }
    }
  }
  /**
   * Release everything this execution owns: cancel all pending throttle
   * timers and RAF handles, unregister from the live registry, and refuse
   * later `schedule` calls. Must run only after the execution's quiescence
   * (flush) so no tail DB write or RAF mirror is lost on the normal path;
   * on abort/error teardown it additionally guarantees no stale trailing
   * write can land afterwards.
   */
  dispose = (): void => {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const [, frame] of this.pendingFrames) {
      cancelAnimationFrame(frame.rafId)
    }
    this.pendingFrames.clear()
    for (const [, throttler] of this.throttlers) {
      throttler.cancel()
    }
    this.throttlers.clear()
    liveSchedulers.delete(this)
  }

  private getThrottler = (id: string): ReturnType<typeof throttle> => {
    const existing = this.throttlers.get(id)
    if (existing) {
      return existing
    }
    // The trailing invocation reuses the LATEST call args (lodash semantics),
    // so each field falls back to this execution's bound default when the
    // call carries no override.
    const throttler = throttle(async (blockUpdate: any, ctx?: ScheduledWriteContext) => {
      if (this.disposed) {
        return
      }
      const resendAttemptId = ctx?.resendAttemptId ?? this.resendAttemptId
      const barrier = ctx?.barrier ?? this.barrier
      const shouldMirrorGate = ctx?.shouldMirrorToRedux ?? this.isLoaded
      const topicId = ctx?.topicId ?? this.topicId
      const branchId = ctx?.branchId !== undefined ? ctx.branchId : this.branchId

      const prev = this.pendingFrames.get(id)
      if (prev !== undefined) {
        cancelAnimationFrame(prev.rafId)
      }
      const mirror = (): void => {
        this.pendingFrames.delete(id)
        if (this.disposed) {
          return
        }
        let shouldMirror = true
        if (shouldMirrorGate) {
          try {
            shouldMirror = shouldMirrorGate()
          } catch {
            shouldMirror = false
          }
        }
        if (shouldMirror) {
          this.mirrorToRedux(id, blockUpdate, topicId)
        }
      }
      const rafId = requestAnimationFrame(mirror)
      if (prev !== undefined) {
        prev.rafId = rafId
        prev.mirror = mirror
      } else {
        this.pendingFrames.set(id, { rafId, mirror })
      }

      const write = this.performWrite(id, blockUpdate, { resendAttemptId, topicId, branchId })
      if (barrier && isThenable(write)) {
        await barrier.track(write)
      } else {
        await write
      }
    }, this.throttleMs)
    this.throttlers.set(id, throttler)
    return throttler
  }
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Live registry: every not-yet-disposed scheduler. Scoped to live instances
 * only — disposal unregisters, so nothing here can outlive its execution and
 * there is no persistent cache or TTL resurrection.
 */
const liveSchedulers = new Set<StreamWriteScheduler>()

/**
 * Cross-execution cancellation for block deletion: cancel one block's pending
 * throttle + RAF on every live scheduler. Used by the authoritative delete
 * paths only; streaming flush/cancel stay execution-scoped.
 */
export function cancelBlockEverywhere(id: string): void {
  for (const scheduler of [...liveSchedulers]) {
    try {
      scheduler.cancel(id)
    } catch (error) {
      logger.warn(`[cancelBlockEverywhere] Failed to cancel block ${id}:`, error as Error)
    }
  }
}

/** Test/diagnostic hook: how many schedulers are currently live. */
export function liveSchedulerCount(): number {
  return liveSchedulers.size
}
