/**
 * L2 navigation projection apply (LOCK-PROD-4/5/6).
 *
 * Renderer-side idempotent one-shot: after Redux rehydration, the renderer
 * reads the pending navigation projection from the live SQLite
 * `migration_state` (via Main IPC), replaces the pre-import navigation
 * (assistants + topics) with the imported projection, durably flushes
 * redux-persist, then acknowledges so the one-shot is cleared. A crash
 * before the ack leaves the row pending and the apply retries on next
 * startup (LOCK-PROD-6).
 *
 * Locked semantics:
 * - LOCK-PROD-2: imported assistants are shells — `prompt: ''`,
 *   `type: 'assistant'`, target defaults/fallbacks, empty messages/settings.
 *   Assistant behavior configuration is never imported.
 * - LOCK-PROD-4: IndexedDB-only topics surface under one localized stable
 *   "Recovered conversations" shell assistant with a localized deterministic
 *   placeholder topic name; timestamps stay unknown (safe UI representation).
 * - LOCK-PROD-5: replace-all — the pre-import Redux assistants/topics are
 *   replaced by the imported projection. No active-tab migration; startup
 *   chooses the first visible imported topic.
 * - LOCK-FP2: the recovered payload carries the IndexedDB-authoritative
 *   deletedAt per recovered topic. Only ACTIVE recovered topics surface as
 *   visible navigation under the shell; deleted recovered topics are never
 *   resurrected — the established product pattern excludes soft-deleted
 *   topics from Redux entirely (trash semantics are DB-backed by the
 *   imported SQLite/Dexie rows).
 */

import { loggerService } from '@logger'
import type { AnyAction } from '@reduxjs/toolkit'
import i18n from '@renderer/i18n'
import { updateAssistants } from '@renderer/store/assistants'
import type { Assistant, Topic } from '@renderer/types'
import type { ImportNavigationProjection, ProjectionRecoveredTopic, ProjectionTopic } from '@shared/chatImport/types'
import { RECOVERED_SHELL_ASSISTANT_ID } from '@shared/chatImport/types'

import { DEFAULT_ASSISTANT_SETTINGS } from './AssistantService'

/**
 * Lazy logger accessor.
 *
 * `store/index.ts` statically imports this module, which (via
 * `AssistantService`) statically imports the store back — an inherent module
 * cycle. redux-persist fires the post-rehydrate callback synchronously while
 * `store/index.ts` is still mid-evaluation, i.e. before this module's
 * top-level statements have run. A module-level `const logger` would be in
 * the temporal dead zone at that moment, so the logger is created on first
 * use instead (LOCK-PROD-6: the apply must never crash on boot).
 */
function getLogger(): ReturnType<typeof loggerService.withContext> {
  return loggerService.withContext('ImportProjection')
}

// ---------------------------------------------------------------------------
// Pure builders (exported for focused tests)
// ---------------------------------------------------------------------------

/**
 * Build the renderer Topic shape from a projection topic. Timestamps are
 * carried verbatim; null timestamps remain unknown (LOCK-PROD-4) and are
 * surfaced safely by the UI. Deleted topics carry their IDB-authoritative
 * deletedAt (LOCK-PROD-3) and are excluded from navigation by the caller.
 */
export function projectionTopicToTopic(projectionTopic: ProjectionTopic): Topic {
  const createdAt = projectionTopic.createdAt ?? ''
  const updatedAt = projectionTopic.updatedAt ?? ''
  return {
    id: projectionTopic.id,
    assistantId: projectionTopic.assistantId,
    // LOCK-PROD-12: empty source names get a localized placeholder here
    // (the Main-side projection leaves them empty; see navigationProjection).
    name: projectionTopic.name.length > 0 ? projectionTopic.name : i18n.t('import.cherrystudio.untitled_topic'),
    createdAt,
    updatedAt,
    ...(projectionTopic.deletedAt !== null ? { deletedAt: projectionTopic.deletedAt } : {}),
    ...(projectionTopic.pinned ? { pinned: true } : {}),
    ...(projectionTopic.isNameManuallyEdited ? { isNameManuallyEdited: true } : {}),
    messages: []
  }
}

/**
 * Build the imported assistant shells (LOCK-PROD-2/5). Each imported
 * assistant exposes only its navigation metadata; topics are ordered by the
 * source `order` and excluded when soft-deleted (those live in SQLite trash).
 */
export function buildImportedAssistants(projection: ImportNavigationProjection): Assistant[] {
  const topicsByAssistant = new Map<string, ProjectionTopic[]>()
  for (const topic of projection.topics) {
    if (topic.deletedAt !== null) continue
    const bucket = topicsByAssistant.get(topic.assistantId)
    if (bucket) {
      bucket.push(topic)
    } else {
      topicsByAssistant.set(topic.assistantId, [topic])
    }
  }

  return projection.assistants.map((assistant) => {
    const rawTopics = topicsByAssistant.get(assistant.id) ?? []
    // LOCK-PROD-2: source order within the assistant's topics list.
    rawTopics.sort((a, b) => a.order - b.order)
    const topics = rawTopics.map(projectionTopicToTopic)
    const shell: Assistant = {
      id: assistant.id,
      name: assistant.name,
      emoji: assistant.emoji ?? undefined,
      prompt: '',
      type: 'assistant',
      topics,
      messages: [],
      settings: DEFAULT_ASSISTANT_SETTINGS
    }
    return shell
  })
}

/**
 * Build the localized "Recovered conversations" shell assistant for
 * IndexedDB-only topics (LOCK-PROD-4).
 *
 * LOCK-FP2: only ACTIVE recovered topics (deletedAt null) surface as visible
 * topics under the shell. Deleted recovered topics are NEVER resurrected as
 * active navigation: the established product pattern excludes soft-deleted
 * topics from Redux entirely (`removeTopic`/`updateTopics` remove them), and
 * trash semantics are DB-backed — the imported SQLite/Dexie rows carry the
 * authoritative deletedAt for the trash UI.
 *
 * Topic names are localized with deterministic disambiguation
 * (`Recovered conversation N`) and timestamps are unknown (empty → safe UI
 * representation, no claimed source time).
 */
export function buildRecoveredAssistant(recoveredTopics: readonly ProjectionRecoveredTopic[]): Assistant {
  // LOCK-FP2: filter to active recovered topics only. Deterministic order is
  // preserved from the payload; the localized placeholder re-indexes by the
  // active list so names are stable and gap-free.
  const activeTopics = recoveredTopics.filter((topic) => topic.deletedAt === null)
  const topics: Topic[] = activeTopics.map((topic, index) => ({
    id: topic.id,
    assistantId: RECOVERED_SHELL_ASSISTANT_ID,
    name: i18n.t('import.cherrystudio.recovered.topic_name', { index: index + 1 }),
    createdAt: '',
    updatedAt: '',
    messages: []
  }))
  const shell: Assistant = {
    id: RECOVERED_SHELL_ASSISTANT_ID,
    name: i18n.t('import.cherrystudio.recovered.assistant_name'),
    prompt: '',
    type: 'assistant',
    topics,
    messages: [],
    settings: DEFAULT_ASSISTANT_SETTINGS
  }
  return shell
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Dependencies injected by the store (post-rehydrate). Injected rather than
 * imported to keep this module free of a static cycle back into
 * `@renderer/store` and to make the ordering contract directly testable.
 */
export interface ImportProjectionApplyDeps {
  /** Redux dispatch — applies the replace-all assistants action (LOCK-PROD-5). */
  dispatch: (action: AnyAction) => unknown
  /** Durable redux-persist flush — MUST complete before the ack (LOCK-PROD-6). */
  flush: () => Promise<void>
}

/**
 * Apply the pending navigation projection (idempotent, one-shot).
 *
 * Ordering contract (LOCK-PROD-6): read projection → replace-all dispatch →
 * durable flush → ack. A crash or failure before the ack leaves the pending
 * row untouched so the next startup retries. The ack is NEVER sent when the
 * apply or flush fails.
 *
 * Returns `true` when a projection was applied and durably flushed; `false`
 * when none was pending. Throws when the apply/flush failed — the caller
 * should leave the pending row untouched so the next startup retries.
 */
export async function applyPendingImportProjection(deps: ImportProjectionApplyDeps): Promise<boolean> {
  const api = (window as { api?: { cherryImport?: { getProjection(): unknown; ackProjection(): unknown } } }).api
  if (!api?.cherryImport) {
    getLogger().warn('cherryImport IPC bridge unavailable — projection apply skipped')
    return false
  }

  const result = await api.cherryImport.getProjection()
  if (!result || typeof result !== 'object' || (result as { ok?: boolean }).ok !== true) {
    getLogger().warn('Navigation projection read failed — leaving pending row for next startup')
    return false
  }
  const projection = (result as { projection: ImportNavigationProjection | null }).projection
  if (!projection) {
    return false
  }

  // LOCK-PROD-5: replace-all — imported shells + recovered shell. The
  // recovered shell is added only when it has at least one ACTIVE recovered
  // topic (LOCK-FP2): a shell whose recovered topics are all deleted would be
  // empty in Redux — deleted recovered topics stay DB-backed trash, never
  // resurrected as visible navigation.
  const assistants = buildImportedAssistants(projection)
  if (projection.recoveredTopicIds.some((topic) => topic.deletedAt === null)) {
    assistants.push(buildRecoveredAssistant(projection.recoveredTopicIds))
  }

  deps.dispatch(updateAssistants(assistants))
  getLogger().info(
    `Navigation projection applied ` +
      `(assistants: ${assistants.length}, imported topics: ${projection.topics.length}, ` +
      `recovered: ${projection.recoveredTopicIds.length})`
  )

  // LOCK-PROD-6: durable redux-persist flush BEFORE the ack.
  await deps.flush()

  const ack = await api.cherryImport.ackProjection()
  if (!ack || (ack as { ok?: boolean }).ok !== true) {
    getLogger().warn('Navigation projection ack failed — pending row retained for next startup')
    return true
  }
  getLogger().info('Navigation projection acknowledged (one-shot cleared)')
  return true
}
