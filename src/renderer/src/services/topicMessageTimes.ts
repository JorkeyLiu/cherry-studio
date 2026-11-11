/**
 * Runtime topic message-time ordering (renderer-local, never persisted).
 *
 * "By update time" positions a topic by the REAL INSTANT of its latest message
 * `createdAt`, computed by Main over every route of the topic (reference
 * prefix included). This module owns the only runtime piece that key needs:
 *
 * - a short-lived, explicitly sourced cache of the last observed instant per
 *   topic (`'topic-activity'` batch read from Main; never persisted, never
 *   derived from Redux/Dexie/the loaded projection),
 * - one boot baseline: at store rehydration readiness the enabled assistants'
 *   topics are read once, so the first message after a restart is compared
 *   against a real baseline instead of being absorbed as a "first
 *   observation". The baseline is also completed BEFORE a message mutation
 *   reaches Main: when this session never settled one it is read once (shared
 *   with the boot primer), and when it is settled but the written topic is
 *   newer than it (created, imported, restored, or a reference target) only
 *   that topic's missing key is read. A failed read fabricates nothing, never
 *   blocks the chat write, and is retried on the next pre-write preparation — a
 *   post-write read must never become the baseline,
 * - the bounded refresh at the existing message-mutation seam (one read of the
 *   notified topics per successful mutation, and only while the owning
 *   assistant still uses the policy — never per render/effect/streaming token),
 * - the existing Main→renderer history-reference invalidation event
 *   (`chatdb:history-reference-invalidated`): a source write whose prefix a
 *   reference target sees re-reads THAT target's key, including targets that
 *   were never opened — no extra IPC, no projection authority,
 * - the stale-response guard (a request sequence per topic taken when the
 *   request starts, so a late return can never overwrite a newer observation
 *   or reorder topics twice),
 * - the policy epoch: a later user ordering action ("by creation time" or a
 *   list the user just dragged) always wins over an activation whose read was
 *   still in flight; that activation never silently re-sorts the user's order,
 * - the comparison that decides whether anything moves at all: an UNCHANGED
 *   latest instant never reorders a topic, no matter how many other writes
 *   (middle inserts, edits, `updatedAt` writes, deletes of non-latest
 *   messages, block streaming) happened in between.
 *
 * The policy preference itself stays where it already lived: on the assistant
 * (`topicOrderMode`) next to the topic array it orders.
 */
import { loggerService } from '@logger'
import store from '@renderer/store'
import { updateAssistant, updateTopics } from '@renderer/store/assistants'
import type { Assistant, Topic } from '@renderer/types'
import {
  moveTopicToOrdinaryHead,
  placeTopicBySortKey,
  resolveTopicOrderMode,
  sortTopicsByMessageTimeDesc,
  topicSortKeyMs
} from '@renderer/utils/topicOrder'
import type { FetchTopicMessageTimesResponse, HistoryReferenceInvalidationEvent } from '@shared/chatDb'

const logger = loggerService.withContext('TopicMessageTimes')

/** Request chunk size; Main rejects batches above its own hard bound. */
const READ_CHUNK_SIZE = 500

/** Latest authoritative message instant per topic (UTC ISO-8601 or null). */
const latestMessageAtByTopic = new Map<string, string | null>()
/** Highest observation sequence already applied per topic (stale-response guard). */
const appliedSeqByTopic = new Map<string, number>()
/** Sequence taken when a read request STARTS, so a late result is provably older. */
let requestSeq = 0
/** Bumped by every user ordering-policy change; invalidates an in-flight activation. */
let orderEpoch = 0
/** True once the boot baseline (or an activation) established comparable keys. */
let baselineSettled = false
let baselinePromise: Promise<void> | null = null

/**
 * Drops every cached key (policy disabled, or a fresh activation re-reads) and
 * marks any in-flight activation stale, so a late return cannot override the
 * ordering action that just happened.
 */
export function resetTopicMessageTimes(): void {
  latestMessageAtByTopic.clear()
  appliedSeqByTopic.clear()
  orderEpoch += 1
  baselineSettled = false
  baselinePromise = null
}

function findTopic(topicId: string): { assistant: Assistant; topic: Topic } | null {
  const assistants = store.getState?.()?.assistants?.assistants ?? []
  for (const assistant of assistants) {
    const topic = assistant.topics?.find((entry) => entry.id === topicId)
    if (topic) return { assistant, topic }
  }
  return null
}

function findAssistant(assistantId: string): Assistant | null {
  const assistants = store.getState?.()?.assistants?.assistants ?? []
  return assistants.find((assistant) => assistant.id === assistantId) ?? null
}

/** Authoritative reader shape of the renderer database service capability. */
type TopicMessageTimeReader = (topicIds: string[]) => Promise<FetchTopicMessageTimesResponse>

let readerPromise: Promise<TopicMessageTimeReader> | null = null

/**
 * The data source is resolved lazily — once — so this module never forms a
 * static import cycle with the database service that reports writes here, and
 * concurrent refreshes share one module resolution instead of racing for it.
 */
function resolveReader(): Promise<TopicMessageTimeReader> {
  if (!readerPromise) {
    readerPromise = import('./db').then(
      ({ dbService }) =>
        (topicIds: string[]) =>
          dbService.fetchTopicMessageTimes(topicIds)
    )
    // A failed resolution must not poison later reads.
    readerPromise.catch(() => {
      readerPromise = null
    })
  }
  return readerPromise
}

/** Records a key only when this observation is not older than the applied one. */
function setKeyIfNewer(topicId: string, latestMessageAt: string | null, seq: number): boolean {
  if (seq < (appliedSeqByTopic.get(topicId) ?? 0)) return false
  appliedSeqByTopic.set(topicId, seq)
  latestMessageAtByTopic.set(topicId, latestMessageAt)
  return true
}

async function readChunked(topicIds: string[]): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(topicIds))
  const result = new Map<string, string | null>()
  if (ids.length === 0) return result
  const read = await resolveReader()
  for (let offset = 0; offset < ids.length; offset += READ_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + READ_CHUNK_SIZE)
    const response = await read(chunk)
    for (const entry of response.topics) {
      result.set(entry.topicId, entry.latestMessageAt)
    }
  }
  return result
}

/**
 * Reads Main's authoritative latest message instant per topic (chunked, every
 * requested topic answered independently of the loaded projection).
 */
export async function readTopicMessageTimes(topicIds: string[]): Promise<Map<string, string | null>> {
  return readChunked(topicIds)
}

/** Every assistant that persists "by update time" (the only lists we order). */
function enabledAssistants(): Assistant[] {
  const assistants = store.getState?.()?.assistants?.assistants ?? []
  return assistants.filter((assistant) => resolveTopicOrderMode(assistant.topicOrderMode) === 'updated')
}

/**
 * One baseline read per topic list at boot: every assistant that persisted
 * "by update time" gets real keys before any message-mutation notification is
 * compared, so the first message after a restart moves the topic instead of
 * being recorded as an uncomparable first observation.
 */
async function readEnabledBaseline(): Promise<void> {
  const ids: string[] = []
  for (const assistant of enabledAssistants()) {
    for (const topic of assistant.topics ?? []) ids.push(topic.id)
  }
  if (ids.length === 0) return
  const seq = ++requestSeq
  const times = await readChunked(ids)
  for (const [topicId, latestMessageAt] of times) setKeyIfNewer(topicId, latestMessageAt, seq)
}

/**
 * Awaits one baseline read and applies its outcome. A failure fabricates
 * nothing: the keys stay unknown and the next PRE-write read retries, so a
 * write issued after the failure can never be recorded as a "first observation".
 */
async function awaitBaseline(read: Promise<void>): Promise<boolean> {
  try {
    await read
    baselineSettled = true
    return true
  } catch (error) {
    if (baselinePromise === read) baselinePromise = null
    logger.error('Failed to establish the topic message-time baseline', error as Error)
    return false
  }
}

/**
 * Ensures a comparable baseline exists, starting the one-batch read over every
 * enabled assistant's topics when none is settled or in flight. Only the boot
 * primer, a policy activation and a PRE-write preparation may start a read.
 */
async function ensureBaseline(): Promise<boolean> {
  if (baselineSettled) return true
  if (!baselinePromise) baselinePromise = readEnabledBaseline()
  return awaitBaseline(baselinePromise)
}

/**
 * Joins a baseline read that is already settled or in flight and NEVER starts
 * one: a post-write observation must not establish a baseline after the write,
 * or the just-written maximum would become the comparison baseline.
 */
async function joinBaseline(): Promise<boolean> {
  if (baselineSettled) return true
  if (!baselinePromise) return false
  return awaitBaseline(baselinePromise)
}

/**
 * Covers the topics that entered an ENABLED assistant's list AFTER the baseline
 * settled (created, imported, restored, or a reference target): a settled
 * baseline describes the list it read, not future topics, so a topic with no
 * key would have its first real change recorded as a "first observation" and
 * swallowed. Reads ONLY the still-unkeyed ids — one bounded batch, none at all
 * in the steady state — and never re-primes a topic that already has a key, so
 * no existing position or manual order can move.
 */
async function primeMissingEnabledKeys(): Promise<void> {
  const missing: string[] = []
  for (const assistant of enabledAssistants()) {
    for (const topic of assistant.topics ?? []) {
      if (!latestMessageAtByTopic.has(topic.id)) missing.push(topic.id)
    }
  }
  if (missing.length === 0) return
  const seq = ++requestSeq
  try {
    const times = await readChunked(missing)
    for (const [topicId, latestMessageAt] of times) setKeyIfNewer(topicId, latestMessageAt, seq)
  } catch (error) {
    // No key is fabricated: the topic stays uncovered, that write's ordering is
    // reported as not applied, and the next pre-write preparation retries.
    logger.error('Failed to read the missing topic message times before a write', error as Error)
  }
}

/**
 * Pre-write ordering baseline, awaited BEFORE the mutation reaches Main.
 *
 * The post-write observation can only compare against a key that existed
 * BEFORE the write. Two situations leave a topic without one, and both are
 * covered here, before the write:
 *
 * 1. this session never established the baseline (boot primer not reached, its
 *    dynamic import failed, or its read failed) — the single enabled batch read
 *    is shared with the boot primer, never duplicated;
 * 2. the baseline is settled but the topic is newer than it (created, imported,
 *    restored, or a reference target) — only that topic's missing key is read.
 *
 * A topic with no Redux row yet (brand-new topic on its first send) and a
 * session with no "by update time" policy both resolve immediately, exactly as
 * before. A failed read never blocks or fails the chat write and never
 * fabricates a key; this write is reported as "ordering not applied" and the
 * next write retries the pre-write read.
 */
export async function prepareTopicMessageWrite(topicId: string): Promise<void> {
  try {
    if (!findTopic(topicId)) return
    if (enabledAssistants().length === 0) return
    const ready = await ensureBaseline()
    if (!ready) {
      logger.warn(
        'Topic ordering not applied for this write: no trusted baseline yet (the next write retries the pre-write read)'
      )
      return
    }
    await primeMissingEnabledKeys()
  } catch (error) {
    logger.warn('Topic ordering not applied for this write: baseline unavailable', error as Error)
  }
}

/** Boot entry point: establish the baseline for the persisted policy. */
export async function primeTopicMessageTimesBaseline(): Promise<boolean> {
  return ensureBaseline()
}

/**
 * True when the two lists differ in the RELATIVE ORDER of their shared topics
 * (a user reorder), as opposed to a topic being added or removed while a read
 * was in flight. Added/removed topics are never a reason to drop an activation.
 */
function isUserReorder(captured: Topic[], current: Topic[]): boolean {
  const currentIds = new Set(current.map((topic) => topic.id))
  const capturedIds = new Set(captured.map((topic) => topic.id))
  const before = captured.filter((topic) => currentIds.has(topic.id)).map((topic) => topic.id)
  const after = current.filter((topic) => capturedIds.has(topic.id)).map((topic) => topic.id)
  return before.join('\u0000') !== after.join('\u0000')
}

/**
 * Activates "by update time" for one assistant: one full authoritative read,
 * one full newest-first sort of the non-pinned topics (pinned group untouched),
 * the persisted policy, and the runtime key cache primed from the same read.
 *
 * The read sequence is taken when the request STARTS, so an observation that
 * completed while this read was in flight stays newer and is what the sort
 * uses. A user ordering action during the read wins: "by creation time"
 * (`orderEpoch` bump) discards this activation entirely, and a list the user
 * just dragged is never silently re-sorted — the policy is persisted and the
 * keys primed, but the dragged order is left exactly as the user placed it.
 */
export async function enableUpdateTimeOrder(assistantId: string): Promise<boolean> {
  const initial = findAssistant(assistantId)
  if (!initial) return false
  const startEpoch = orderEpoch
  const startSeq = ++requestSeq
  const capturedTopics = initial.topics
  let times: Map<string, string | null>
  try {
    times = await readChunked(capturedTopics.map((topic) => topic.id))
  } catch (error) {
    logger.error('Failed to read the authoritative topic message times', error as Error)
    return false
  }
  // A later "by creation time" (or policy teardown) happened while awaiting:
  // it is the user's newer decision, so this activation writes nothing at all.
  if (startEpoch !== orderEpoch) return false
  const current = findAssistant(assistantId)
  if (!current) return false

  // Keys primed from this snapshot, except for topics observed AFTER this
  // request started: those newer keys stay authoritative and are what the sort
  // uses. A topic that arrived during the read is kept (never dropped).
  const keyByTopic = new Map<string, string | null>()
  for (const topic of current.topics) {
    const applied = appliedSeqByTopic.get(topic.id) ?? 0
    if (applied > startSeq) {
      keyByTopic.set(topic.id, latestMessageAtByTopic.get(topic.id) ?? null)
      continue
    }
    keyByTopic.set(
      topic.id,
      times.has(topic.id) ? (times.get(topic.id) ?? null) : (latestMessageAtByTopic.get(topic.id) ?? null)
    )
  }
  for (const [topicId, latestMessageAt] of keyByTopic) setKeyIfNewer(topicId, latestMessageAt, startSeq)
  baselineSettled = true

  const keyOf = (topic: Topic) => topicSortKeyMs(keyByTopic.get(topic.id) ?? null, topic.createdAt)
  if (!isUserReorder(capturedTopics, current.topics)) {
    store.dispatch(
      updateTopics({ assistantId, topics: sortTopicsByMessageTimeDesc(current.topics, (topic) => keyOf(topic)) })
    )
  }
  // The policy preference lives on the assistant, next to the ordered array.
  store.dispatch(updateAssistant({ id: assistantId, topicOrderMode: 'updated' }))
  return true
}

/** True while the topic exists and its assistant still uses "by update time". */
export function isUpdateTimeOrderActive(topicId: string): boolean {
  const found = findTopic(topicId)
  return Boolean(found) && resolveTopicOrderMode(found?.assistant.topicOrderMode) === 'updated'
}

/**
 * Existing message-mutation seam: reports that one topic just received a
 * message write. The existing `updatedAt` bookkeeping is the caller's; this
 * only performs a bounded authoritative re-read while the policy is active.
 */
export function noteTopicMessageWrite(topicId: string): void {
  // Ordering bookkeeping must never break a persisted mutation: any failure
  // here only means the position is refreshed later by the next observation.
  try {
    if (!isUpdateTimeOrderActive(topicId)) return
  } catch {
    return
  }
  void observeTopicMessageTimes([topicId]).catch(() => {
    // A failed bounded refresh never reorders anything: the previous order and
    // the previous key stay authoritative until a successful observation.
  })
}

/**
 * Existing Main→renderer history-reference invalidation: a source topic
 * changed, so the live prefix of these targets may have changed too. Re-read
 * only the targets whose owning assistant still orders by update time —
 * including targets that are not open anywhere. An append after the captured
 * anchor leaves the prefix untouched, so the read returns the same key and
 * nothing moves.
 */
export function noteTopicReferenceInvalidation(targetTopicIds: string[]): void {
  const ids: string[] = []
  try {
    for (const topicId of new Set(targetTopicIds)) {
      if (typeof topicId !== 'string' || topicId.length === 0) continue
      if (isUpdateTimeOrderActive(topicId)) ids.push(topicId)
    }
  } catch {
    return
  }
  if (ids.length === 0) return
  void observeTopicMessageTimes(ids).catch(() => {})
}

/**
 * One bounded observation of the notified topics: it JOINS the boot/pre-write
 * baseline (it never starts one after a write), takes its sequence at request
 * start, and then applies per-topic moves.
 */
async function observeTopicMessageTimes(topicIds: string[]): Promise<void> {
  const ids = Array.from(new Set(topicIds))
  if (ids.length === 0) return
  const baselineReady = await joinBaseline()
  // Without a trusted baseline only topics that already carry a key can be
  // compared: reading an unknown topic now would record the just-written
  // maximum as a first observation and swallow the real change.
  const observable = baselineReady ? ids : ids.filter((topicId) => latestMessageAtByTopic.has(topicId))
  if (observable.length === 0) return
  const seq = ++requestSeq
  let times: Map<string, string | null>
  try {
    times = await readChunked(observable)
  } catch (error) {
    logger.error('Failed to read the authoritative topic message time', error as Error)
    return
  }
  for (const topicId of observable) applyObservation(topicId, times, seq)
}

/**
 * Ordering changes only when the topic's latest message instant really
 * changed: forward moves go to the ordinary head, backward moves are placed by
 * the new instant, and an equal instant does nothing at all.
 */
function applyObservation(topicId: string, times: Map<string, string | null>, seq: number): void {
  // The topic no longer exists in Main (deleted between the write and the
  // read): drop its cached key and never move anything.
  if (!times.has(topicId)) {
    latestMessageAtByTopic.delete(topicId)
    return
  }
  // A newer observation for this topic already won: this late result is stale.
  if (seq <= (appliedSeqByTopic.get(topicId) ?? 0)) return

  const found = findTopic(topicId)
  if (!found) {
    latestMessageAtByTopic.delete(topicId)
    return
  }
  const { assistant, topic } = found
  // Policy disabled or assistant switched away while the read was in flight.
  if (resolveTopicOrderMode(assistant.topicOrderMode) !== 'updated') return

  const nextMessageAt = times.get(topicId) ?? null
  const previousKnown = latestMessageAtByTopic.get(topicId)
  const previousMessageAt = previousKnown ?? null
  latestMessageAtByTopic.set(topicId, nextMessageAt)
  appliedSeqByTopic.set(topicId, seq)

  // First ever observation: the key is recorded and nothing moves, because
  // there is no previous instant to compare a direction against.
  if (previousKnown === undefined) return
  if (previousMessageAt === nextMessageAt) return

  const previousMs = previousMessageAt === null ? null : Date.parse(previousMessageAt)
  const nextMs = nextMessageAt === null ? null : Date.parse(nextMessageAt)
  const advanced = previousMs !== null && nextMs !== null ? nextMs > previousMs : nextMs !== null

  const topics = assistant.topics
  const moved = advanced
    ? moveTopicToOrdinaryHead(topics, topicId)
    : placeTopicBySortKey(topics, topicId, topicSortKeyMs(nextMessageAt, topic.createdAt), (entry) =>
        topicSortKeyMs(latestMessageAtByTopic.get(entry.id) ?? null, entry.createdAt)
      )
  if (moved !== topics) {
    store.dispatch(updateTopics({ assistantId: assistant.id, topics: moved }))
  }
}

// ---------------------------------------------------------------------------
// Existing Main→renderer history-reference invalidation subscription
//
// Same lifecycle as the other renderer subscriptions: one window-level
// subscription installed at app bootstrap (not tied to a mounted list), so an
// assistant whose list is not currently rendered still converges.
// ---------------------------------------------------------------------------

type ReferenceInvalidationBridge = {
  chatDb?: { onHistoryReferenceInvalidated?: (callback: (event: unknown) => void) => () => void }
}

let unsubscribe: (() => void) | null = null

/** One stable disposer, so repeated subscribes return the same reference. */
function disposeInvalidationSubscription(): void {
  try {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  } catch {
    // best effort
  }
}

export function subscribeTopicMessageTimeInvalidation(): () => void {
  if (unsubscribe) return disposeInvalidationSubscription
  const api = (typeof window !== 'undefined' ? (window as unknown as { api?: unknown }).api : undefined) as
    | ReferenceInvalidationBridge
    | undefined
  const onInvalidated = api?.chatDb?.onHistoryReferenceInvalidated
  // The bridge is simply absent in environments without the preload surface (plain jsdom
  // tests); that is not a degraded state worth a warning, so tolerate it silently.
  if (typeof onInvalidated !== 'function') return () => {}
  try {
    unsubscribe = onInvalidated((event: unknown) => {
      try {
        const payload = event as HistoryReferenceInvalidationEvent | null
        if (!payload || !Array.isArray(payload.targetTopicIds)) return
        noteTopicReferenceInvalidation(payload.targetTopicIds)
      } catch (error) {
        logger.warn('Invalid HistoryReferenceInvalidationEvent payload, discarding', error as Error)
      }
    })
    logger.info('Subscribed to chatdb:history-reference-invalidated for topic ordering')
  } catch (error) {
    logger.warn('Failed to subscribe to history reference invalidation', error as Error)
    return () => {}
  }
  return disposeInvalidationSubscription
}

export function unsubscribeTopicMessageTimeInvalidationForTests(): void {
  disposeInvalidationSubscription()
}
