/**
 * Application-layer ordinary-assistant integrity normalizer.
 *
 * Repairs persisted ordinary assistants whose live topic list is really empty
 * (`topics` is an array `[]` — never `undefined` loading state) by calling the
 * atomic Main `ensureAssistantTopics` capability (find-or-create in ONE SQLite
 * Tx) and merging the returned TopicWire list into the SAME still-present
 * store assistant by stable id.
 *
 * Boundaries:
 * - Only persisted ordinary `assistants[]` entries. Ephemeral request-local
 *   assistants and pure `assistantDefaults`/presets are never touched (they
 *   are not in the persisted list).
 * - Never reads chat contents, never fabricates messages, never touches the
 *   context-window anchor. Only nav-level topics are merged.
 * - Stale-result guards: a deleted assistant is never resurrected; an
 *   assistant that gained a topic while Main was in flight keeps it (no
 *   overwrite, no loss); per-topic stable-id dedup prevents duplicates.
 * - `undefined` (unloaded) topics never trigger a Main call — only a real
 *   `[]` does.
 */

import { loggerService } from '@logger'

import { getDefaultTopic } from './assistantDefaults'
import { topicWireToTopic } from './db/topicTrashLifecycle'
import { isImportProjectionReady } from './importProjectionReadiness'

const logger = loggerService.withContext('AssistantTopicIntegrity')

export interface IntegrityAssistantSnapshot {
  id: string
  topics?: unknown
}

export interface IntegrityStoreReader {
  findAssistant: (assistantId: string) => { id: string; topics?: unknown } | undefined
  listAssistants: () => IntegrityAssistantSnapshot[]
}

export interface EnsureAssistantTopicsFn {
  (
    assistantId: string,
    candidateTopicId: string,
    candidateName?: string | null
  ): Promise<{
    topics: Array<{
      id: string
      assistantId?: string | null
      name?: string | null
      pinned?: boolean | null
      prompt?: string | null
      isNameManuallyEdited?: boolean | null
      createdAt?: string | null
      updatedAt?: string | null
      deletedAt?: string | null
    }>
    created: boolean
  }>
}

export interface IntegrityDispatch {
  addTopic: (assistantId: string, topic: unknown) => void
}

export function isRealEmptyTopicList(topics: unknown): topics is [] {
  return Array.isArray(topics) && topics.length === 0
}

/**
 * True only when the boot gates have settled and this assistant snapshot is a
 * real empty ordinary assistant (array `[]`, valid id).
 */
export function isEmptyOrdinaryAssistantSnapshot(assistant: IntegrityAssistantSnapshot | undefined | null): boolean {
  if (!assistant || typeof assistant.id !== 'string' || assistant.id.length === 0) return false
  return isRealEmptyTopicList(assistant.topics)
}

/**
 * Ensure ONE empty ordinary assistant has its Main-authoritative topics.
 * Returns the Main topic wires (verbatim metadata) merged into Redux, or an
 * empty array when skipped (not eligible / stale / unloaded).
 *
 * Never throws a crash: Main failures propagate to the caller so the UI can
 * show the existing safe error + retry instead of a fake Redux topic.
 */
export async function ensureAssistantTopicsIntegrity(
  assistantId: string,
  deps: {
    reader: IntegrityStoreReader
    ensure: EnsureAssistantTopicsFn
    dispatchAddTopic: (assistantId: string, topic: unknown) => void
    candidateFactory?: (assistantId: string) => { id: string; name: string }
    importReady?: () => boolean
  }
): Promise<Array<{ id: string }>> {
  const importReady = deps.importReady ?? isImportProjectionReady
  if (!importReady()) return []
  const snapshot = deps.reader.findAssistant(assistantId)
  if (!isEmptyOrdinaryAssistantSnapshot(snapshot)) return []
  const candidate = deps.candidateFactory
    ? deps.candidateFactory(assistantId)
    : (() => {
        const t = getDefaultTopic(assistantId)
        return { id: t.id, name: t.name }
      })()
  let result: Awaited<ReturnType<EnsureAssistantTopicsFn>>
  try {
    result = await deps.ensure(assistantId, candidate.id, candidate.name ?? null)
  } catch (error) {
    // Candidate-id collision is fail-closed in Main without a write. A fresh
    // candidate retry is safe (uuid space) and keeps one SQL row.
    const message = error instanceof Error ? error.message : String(error)
    const isCollision = /owned by another assistant|soft-deleted|cannot be reused/i.test(message)
    if (!isCollision) throw error
    logger.warn(`ensureAssistantTopics candidate collision for ${assistantId}, retrying with fresh candidate`)
    const retryCandidate = deps.candidateFactory
      ? deps.candidateFactory(assistantId)
      : (() => {
          const t = getDefaultTopic(assistantId)
          return { id: t.id, name: t.name }
        })()
    result = await deps.ensure(assistantId, retryCandidate.id, retryCandidate.name ?? null)
  }
  // Stale guards against the CURRENT store (not the pre-call snapshot).
  const current = deps.reader.findAssistant(assistantId)
  if (!current) {
    logger.warn(`ensureAssistantTopics stale result ignored: assistant ${assistantId} deleted during repair`)
    return []
  }
  if (Array.isArray(current.topics) && current.topics.length > 0) {
    // A topic arrived while Main was in flight (user create / second window):
    // keep it. Merge only Main wires missing by stable id — never overwrite.
    const present = new Set(
      (current.topics as Array<{ id?: unknown }>).map((t) => (t && typeof t === 'object' ? String(t.id) : ''))
    )
    const merged: Array<{ id: string }> = []
    for (const wire of result.topics) {
      if (present.has(wire.id)) {
        merged.push({ id: wire.id })
        continue
      }
      deps.dispatchAddTopic(assistantId, topicWireToTopic(wire as never))
      merged.push({ id: wire.id })
    }
    return merged
  }
  if (!Array.isArray(current.topics)) {
    logger.warn(`ensureAssistantTopics stale result ignored: assistant ${assistantId} topics unloaded during repair`)
    return []
  }
  // Still really empty: merge every Main wire by stable id.
  const present = new Set<string>()
  const merged: Array<{ id: string }> = []
  for (const wire of result.topics) {
    if (present.has(wire.id)) continue
    present.add(wire.id)
    deps.dispatchAddTopic(assistantId, topicWireToTopic(wire as never))
    merged.push({ id: wire.id })
  }
  return merged
}

/**
 * Boot/runtime sweep: repair EVERY really-empty ordinary assistant.
 * Eligible only after the import projection gate is ready; `undefined`
 * (unloaded) lists never trigger Main calls.
 */
export async function ensureAllEmptyAssistantsTopics(deps: {
  reader: IntegrityStoreReader
  ensure: EnsureAssistantTopicsFn
  dispatchAddTopic: (assistantId: string, topic: unknown) => void
  candidateFactory?: (assistantId: string) => { id: string; name: string }
  importReady?: () => boolean
}): Promise<{ repaired: string[] }> {
  const importReady = deps.importReady ?? isImportProjectionReady
  if (!importReady()) return { repaired: [] }
  const repaired: string[] = []
  for (const assistant of deps.reader.listAssistants()) {
    if (!isEmptyOrdinaryAssistantSnapshot(assistant)) continue
    try {
      const merged = await ensureAssistantTopicsIntegrity(assistant.id, deps)
      if (merged.length > 0) repaired.push(assistant.id)
    } catch (error) {
      // One assistant's genuine SQL failure must not block the others; the
      // caller surfaces the safe error + retry. Log and continue.
      logger.error(`ensureAllEmptyAssistants failed for ${assistant.id}:`, error as Error)
    }
  }
  return { repaired }
}
