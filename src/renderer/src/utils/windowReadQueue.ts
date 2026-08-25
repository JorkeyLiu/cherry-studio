import { loggerService } from '@logger'
import PQueue from 'p-queue'

const logger = loggerService.withContext('WindowReadQueue')

/**
 * Phase 5 bounded slice — same-topic paginated/message-slice read
 * serialization.
 *
 * One PQueue per topic with `concurrency: 1` guarantees that same-topic
 * window reads (`latest` bootstrap and `around` older/newer pagination) run
 * and complete in FIFO enqueue order. Distinct topics own independent queues,
 * so reads for different topics never block each other. The serializer ONLY
 * orders the underlying async read: request validation, stale-token discard,
 * and publication semantics stay entirely with the caller, and no identical
 * read is coalesced (every dispatched read is queued as its own task).
 *
 * Lifecycle: per-topic PQueues are reclaimed when idle via an identity-safe
 * check after each task settles: only if the Map still holds the same queue
 * object for that topic and `queue.pending === 0 && queue.size === 0` is the
 * entry removed. This naturally bounds the Map to topics with in-flight or
 * queued work. No public clear/dispose APIs are exposed: clearing a queue
 * out from under queued callers could strand their promises or permit
 * same-topic overlap.
 */
const windowReadQueues = new Map<string, PQueue>()

/** Structured observability fields emitted for every queued window read. */
export interface WindowReadQueueLogFields {
  topicId: string
  kind: 'latest' | 'around'
  /** Reads for this topic already running + waiting when the log fires (enqueue), or still waiting behind the running read (start). */
  queueDepth: number
  /** Milliseconds elapsed since the read was enqueued (0 for the enqueue event). */
  waitMs: number
}

const getQueue = (topicId: string): PQueue => {
  let queue = windowReadQueues.get(topicId)
  if (!queue) {
    queue = new PQueue({ concurrency: 1 })
    windowReadQueues.set(topicId, queue)
  }
  return queue
}

const tryReclaimIdleQueue = (topicId: string, queue: PQueue): void => {
  if (windowReadQueues.get(topicId) === queue && queue.pending === 0 && queue.size === 0) {
    windowReadQueues.delete(topicId)
  }
}

/** Total same-topic window reads currently queued (waiting) or in flight. */
export const getWindowReadQueueDepth = (topicId: string): number => {
  const queue = windowReadQueues.get(topicId)
  return queue ? queue.pending + queue.size : 0
}

/**
 * Execute one paginated/message-slice read for a topic under the per-topic
 * FIFO serializer.
 *
 * - Same-topic reads complete in enqueue order; different topics stay
 *   independent.
 * - A rejected read rethrows to the caller and never stalls later same-topic
 *   reads (p-queue advances the queue after a task settles).
 * - Queue depth and wait duration are emitted as structured log fields via
 *   `loggerService`:
 *   - on enqueue: `queueDepth` = reads already ahead (running + waiting),
 *     `waitMs: 0`
 *   - on start: `queueDepth` = reads still waiting behind, `waitMs` = actual
 *     wait elapsed
 */
export const runTopicWindowRead = async <T>(
  topicId: string,
  kind: 'latest' | 'around',
  read: () => Promise<T>
): Promise<T> => {
  const queue = getQueue(topicId)
  const enqueuedAt = Date.now()
  const queueDepthAtEnqueue = queue.pending + queue.size

  logger.silly('[runTopicWindowRead] window read queued', {
    topicId,
    kind,
    queueDepth: queueDepthAtEnqueue,
    waitMs: 0
  } satisfies WindowReadQueueLogFields)

  // p-queue v8 types `add` as `Promise<Awaited<T> | void>` (void only for a
  // cleared/closed queue); this serializer's queues are never closed while
  // reads are outstanding, so the result is always the read's resolution.
  // Queue depth during enqueue is deliberately captured BEFORE the read is
  // added so the reported depth reflects reads already ahead of this one.
  try {
    return (await queue.add(async () => {
      logger.silly('[runTopicWindowRead] window read started', {
        topicId,
        kind,
        queueDepth: queue.size,
        waitMs: Date.now() - enqueuedAt
      } satisfies WindowReadQueueLogFields)
      return read()
    })) as T
  } finally {
    tryReclaimIdleQueue(topicId, queue)
  }
}

// Test-only introspection helpers (not a cleanup API).
export const __test_hasWindowReadQueue = (topicId: string): boolean => windowReadQueues.has(topicId)
export const __test_getWindowReadQueueCount = (): number => windowReadQueues.size
export const __test_getWindowReadQueue = (topicId: string): PQueue | undefined => windowReadQueues.get(topicId)
