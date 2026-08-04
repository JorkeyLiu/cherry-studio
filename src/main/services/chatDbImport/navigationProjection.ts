/**
 * L2 navigation projection builder (LOCK-PROD-2/3/4/5/6).
 *
 * Consumes the source Local Storage `persist:cherry-studio` payload reported
 * by the import renderer and builds the versioned minimal navigation
 * projection that travels atomically with the candidate `chat.db`.
 *
 * Locked semantics:
 * - LOCK-PROD-2: Local Storage is authoritative ONLY for the minimal
 *   navigation projection: assistant id/name/emoji/order, and topic
 *   id/name/assistant ownership/createdAt/updatedAt/deletedAt/pinned/
 *   isNameManuallyEdited/order. Assistant behavior configuration (prompts,
 *   settings, models, knowledge bases, tools) is NEVER imported. The
 *   external assistant container owns grouping when the redundant inner
 *   topic.assistantId differs.
 * - LOCK-PROD-3: IndexedDB remains authoritative for topic existence,
 *   messages, blocks, deletedAt, segments, and files. LS-only topics are
 *   rejected/ignored (the real artifact has 0). LS metadata may enrich only
 *   matching IDB topic IDs. A deletedAt mismatch resolves to the IDB value.
 * - LOCK-PROD-4: IDB-only topics surface under one localized stable
 *   "Recovered conversations" shell assistant; their timestamps remain
 *   unknown/null and the renderer supplies a safe UI representation.
 * - LOCK-PROD-5: imported assistant IDs must not collide within the
 *   projection — duplicates/malformed metadata reject the import.
 * - LOCK-FP1: the real redux-persist wire is outer JSON whose persisted
 *   slice values (`assistants`, `_persist`, …) may be JSON strings
 *   (`createPersistoid` serializes each slice per key). Compatibility with
 *   an already-decoded object slice shape is retained ONLY through the
 *   strict {@link decodeSlice} helper; a malformed nested string fails safe
 *   to absent, never a partial parse.
 * - LOCK-FP2: IndexedDB owns recovered-topic existence/deletedAt. The
 *   recovered payload carries {id, deletedAt} (never inferred metadata);
 *   the renderer surfaces only active recovered topics and never
 *   resurrects deleted ones as active navigation.
 *
 * Pure module: no filesystem, no IPC, no Electron. Fully unit-testable.
 */

import type {
  ImportNavigationProjection,
  ProjectionAssistant,
  ProjectionRecoveredTopic,
  ProjectionTopic
} from '@shared/chatImport/types'
import { RECOVERED_SHELL_ASSISTANT_ID } from '@shared/chatImport/types'

import { ChatImportProjectionError } from './errors'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Versioned one-shot key stored in the candidate/live `migration_state`
 * table (LOCK-PROD-6). The value is the JSON-encoded projection.
 */
export const NAVIGATION_PROJECTION_STATE_KEY = 'import_navigation_projection_v1'

/** Current projection schema version. */
export const NAVIGATION_PROJECTION_VERSION = 1 as const

/** Maximum number of assistants accepted in a projection (sanity bound). */
const MAX_PROJECTION_ASSISTANTS = 10_000

/** Maximum number of topics accepted in a projection (sanity bound). */
const MAX_PROJECTION_TOPICS = 100_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** IndexedDB topic row facts used for the join (LOCK-PROD-3). */
export interface IdbTopicFact {
  readonly id: string
  /** IndexedDB-authoritative deletedAt (resolves any LS mismatch). */
  readonly deletedAt: string | null
}

/**
 * Result of {@link buildNavigationProjection}. Either the validated
 * projection or a structured rejection.
 */
export type NavigationProjectionOutcome =
  | { readonly status: 'ok'; readonly projection: ImportNavigationProjection }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string }

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function optionalBoolean(value: unknown): boolean {
  return value === true
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Decode one redux-persist persisted slice value (LOCK-FP1).
 *
 * The real wire stores every persisted slice (`assistants`, `_persist`, …)
 * as a JSON string — `createPersistoid` serializes each key separately
 * before JSON-stringifying the outer root. An already-decoded object value
 * is retained for compatibility. Both accepted shapes are STRICT:
 * - string  → must parse to a plain object, else null (absent);
 * - object  → used directly;
 * - anything else (number, array, null, malformed JSON string) → null.
 *
 * A malformed nested string fails safe to `null` (the caller treats the
 * slice as absent) — never a partial or guessed parse.
 */
function decodeSlice(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value) as unknown
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Extract the redux-persist `_persist.version` from the persisted root
 * state, when present. Accepts the real nested-string wire and the
 * already-decoded object shape (LOCK-FP1). Diagnostic only — never gates
 * the projection.
 */
export function extractPersistVersion(root: unknown): number | null {
  if (!isPlainObject(root)) return null
  const persist = decodeSlice(root._persist)
  if (persist === null) return null
  return typeof persist.version === 'number' ? persist.version : null
}

/**
 * Extract the raw assistant list from the redux-persist root state.
 * The `assistants` reducer slice is stored under the `assistants` key and
 * itself holds the `assistants` array. Accepts the real nested-string wire
 * and the already-decoded object shape (LOCK-FP1). Returns [] when absent
 * or malformed (fail-safe).
 */
export function extractAssistantList(root: unknown): unknown[] {
  if (!isPlainObject(root)) return []
  const slice = decodeSlice(root.assistants)
  if (slice === null) return []
  const list = slice.assistants
  return Array.isArray(list) ? list : []
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the validated navigation projection from the raw source
 * `persist:cherry-studio` string and the IndexedDB topic facts.
 *
 * @param rawPersistedState  The raw localStorage string (may be null when
 *   the source has no projection data — the result then contains only
 *   recovered topics).
 * @param idbTopics          IndexedDB topic facts (id + authoritative
 *   deletedAt) from the imported candidate.
 * @param onInvalid          Optional diagnostic hook invoked (count-only,
 *   path-redacted) when individual source topics are dropped; never carries
 *   ids/names/content.
 */
export function buildNavigationProjection(
  rawPersistedState: string | null,
  idbTopics: readonly IdbTopicFact[],
  onInvalid?: (category: 'ls-topic-missing-in-idb' | 'assistant-malformed', count: number) => void
): NavigationProjectionOutcome {
  // IndexedDB facts (LOCK-PROD-3): authoritative existence + deletedAt.
  const idbById = new Map<string, IdbTopicFact>()
  for (const fact of idbTopics) {
    idbById.set(fact.id, fact)
  }

  let parsed: unknown = null
  if (rawPersistedState !== null && rawPersistedState.length > 0) {
    try {
      parsed = JSON.parse(rawPersistedState) as unknown
    } catch {
      // Malformed source JSON → treat as absent projection (LOCK-PROD-3:
      // IndexedDB stays authoritative). Recovered topics still surface.
      parsed = null
    }
  }

  const sourcePersistVersion = extractPersistVersion(parsed)
  const rawAssistants = extractAssistantList(parsed)

  // ---- LOCK-PROD-5: assistant id uniqueness / reserved id ----
  const seenAssistantIds = new Set<string>()
  const assistants: ProjectionAssistant[] = []
  let malformedAssistantCount = 0

  for (let order = 0; order < rawAssistants.length; order++) {
    const raw = rawAssistants[order]
    if (!isPlainObject(raw)) {
      malformedAssistantCount++
      continue
    }
    const id = raw.id
    if (!isNonEmptyString(id)) {
      malformedAssistantCount++
      continue
    }
    if (id === RECOVERED_SHELL_ASSISTANT_ID) {
      return {
        status: 'rejected',
        code: 'RESERVED_ASSISTANT_ID',
        message: `Source assistant id "${RECOVERED_SHELL_ASSISTANT_ID}" collides with the reserved recovered-conversations shell assistant.`
      }
    }
    if (seenAssistantIds.has(id)) {
      return {
        status: 'rejected',
        code: 'DUPLICATE_ASSISTANT_ID',
        message: `Source assistant id "${id}" appears more than once in the projection (LOCK-PROD-5).`
      }
    }
    seenAssistantIds.add(id)

    const name = optionalString(raw.name)
    const emoji = optionalString(raw.emoji)
    assistants.push({
      id,
      // Empty source names fall back to the source id (deterministic, never
      // a fabricated localized string — Main has no i18n; LOCK-PROD-2/12).
      name: name !== null && name.length > 0 ? name : id,
      emoji,
      order
    })

    if (assistants.length > MAX_PROJECTION_ASSISTANTS) {
      return {
        status: 'rejected',
        code: 'TOO_MANY_ASSISTANTS',
        message: `Projection exceeds the ${MAX_PROJECTION_ASSISTANTS} assistant bound.`
      }
    }
  }

  // Diagnostic hook reports the FINAL malformed count exactly once
  // (count-only, path-redacted — never ids/names/content).
  if (malformedAssistantCount > 0 && onInvalid) {
    onInvalid('assistant-malformed', malformedAssistantCount)
  }

  // ---- LOCK-PROD-2/3: topic metadata (enrich only IDB-matched topics) ----
  const topics: ProjectionTopic[] = []
  const topicIds = new Set<string>()
  let droppedLsTopics = 0

  for (const rawAssistant of rawAssistants) {
    if (!isPlainObject(rawAssistant)) continue
    const containerId = rawAssistant.id
    if (!isNonEmptyString(containerId) || !seenAssistantIds.has(containerId)) continue

    const rawTopics = rawAssistant.topics
    if (!Array.isArray(rawTopics)) continue

    for (let order = 0; order < rawTopics.length; order++) {
      const rawTopic = rawTopics[order]
      if (!isPlainObject(rawTopic)) continue
      const topicId = rawTopic.id
      if (!isNonEmptyString(topicId)) continue

      // LOCK-PROD-3: LS-only topics (absent from IndexedDB) are ignored.
      const idbFact = idbById.get(topicId)
      if (idbFact === undefined) {
        droppedLsTopics++
        continue
      }
      if (topicIds.has(topicId)) {
        // Duplicate topic metadata within the projection: first container wins.
        droppedLsTopics++
        continue
      }
      topicIds.add(topicId)

      const name = optionalString(rawTopic.name)
      topics.push({
        id: topicId,
        // LOCK-PROD-2: the external container owns grouping (the redundant
        // inner topic.assistantId is never consulted).
        assistantId: containerId,
        // LOCK-PROD-4/12: an empty source name stays empty — Main has no
        // i18n, so the renderer localizes the placeholder at apply time.
        name: name !== null && name.length > 0 ? name : '',
        createdAt: optionalString(rawTopic.createdAt),
        updatedAt: optionalString(rawTopic.updatedAt),
        // LOCK-PROD-3: deletedAt is resolved to the IndexedDB value — LS
        // metadata never overrides the authoritative deleted state.
        deletedAt: idbFact.deletedAt,
        pinned: optionalBoolean(rawTopic.pinned),
        isNameManuallyEdited: optionalBoolean(rawTopic.isNameManuallyEdited),
        order
      })

      if (topics.length > MAX_PROJECTION_TOPICS) {
        return {
          status: 'rejected',
          code: 'TOO_MANY_TOPICS',
          message: `Projection exceeds the ${MAX_PROJECTION_TOPICS} topic bound.`
        }
      }
    }
  }

  if (droppedLsTopics > 0 && onInvalid) {
    onInvalid('ls-topic-missing-in-idb', droppedLsTopics)
  }

  // ---- LOCK-PROD-4/FP2: IDB-only topics (recovered conversations) ----
  // IndexedDB owns existence and deletedAt: each recovered entry carries the
  // authoritative {id, deletedAt} — no metadata is inferred (LOCK-FP2).
  const recoveredTopicIds: ProjectionRecoveredTopic[] = []
  for (const fact of idbTopics) {
    if (!topicIds.has(fact.id)) {
      recoveredTopicIds.push({ id: fact.id, deletedAt: fact.deletedAt })
    }
  }

  const projection: ImportNavigationProjection = {
    version: NAVIGATION_PROJECTION_VERSION,
    sourcePersistVersion,
    assistants,
    topics,
    recoveredTopicIds
  }

  return { status: 'ok', projection }
}

// ---------------------------------------------------------------------------
// JSON encode/decode helpers (migration_state value boundary, LOCK-PROD-6)
// ---------------------------------------------------------------------------

/**
 * Encode a validated projection to its `migration_state` value string.
 * Throws on serialization failure (fail closed — never store a partial
 * payload that a later reader would misinterpret).
 */
export function encodeProjectionState(projection: ImportNavigationProjection): string {
  const encoded = JSON.stringify(projection)
  if (encoded === undefined) {
    throw new ChatImportProjectionError(
      'ENCODE_FAILED',
      'Navigation projection could not be serialized (unsupported value).'
    )
  }
  return encoded
}

/**
 * Decode and structurally validate a `migration_state` projection value.
 * Returns null when absent or malformed — a malformed pending payload is
 * treated as absent (idempotent no-op; the import session stays terminal).
 *
 * Strict by design (LOCK-PROD-6): every field the renderer relies on is
 * type-checked so a corrupt or hand-crafted row can never reach the apply
 * path. `JSON.parse` already guarantees finite numbers (JSON has no
 * NaN/Infinity), so `typeof` checks on numeric fields are sufficient.
 */
export function decodeProjectionState(value: string | null | undefined): ImportNavigationProjection | null {
  if (value === null || value === undefined || value.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (parsed.version !== NAVIGATION_PROJECTION_VERSION) return null
  if (!Array.isArray(parsed.assistants) || !Array.isArray(parsed.topics) || !Array.isArray(parsed.recoveredTopicIds)) {
    return null
  }
  if (parsed.sourcePersistVersion !== null && typeof parsed.sourcePersistVersion !== 'number') {
    return null
  }
  for (const assistant of parsed.assistants) {
    if (!isPlainObject(assistant)) return null
    if (
      !isNonEmptyString(assistant.id) ||
      typeof assistant.name !== 'string' ||
      !(assistant.emoji === null || typeof assistant.emoji === 'string') ||
      typeof assistant.order !== 'number'
    ) {
      return null
    }
  }
  for (const topic of parsed.topics) {
    if (!isPlainObject(topic)) return null
    if (
      !isNonEmptyString(topic.id) ||
      !isNonEmptyString(topic.assistantId) ||
      typeof topic.name !== 'string' ||
      !(topic.createdAt === null || typeof topic.createdAt === 'string') ||
      !(topic.updatedAt === null || typeof topic.updatedAt === 'string') ||
      !(topic.deletedAt === null || typeof topic.deletedAt === 'string') ||
      typeof topic.pinned !== 'boolean' ||
      typeof topic.isNameManuallyEdited !== 'boolean' ||
      typeof topic.order !== 'number'
    ) {
      return null
    }
  }
  for (const recoveredTopic of parsed.recoveredTopicIds) {
    // LOCK-FP2: every recovered entry must be {id, deletedAt} — a bare id
    // string (pre-fix wire) or a malformed record rejects the whole decode.
    if (!isPlainObject(recoveredTopic)) return null
    if (
      !isNonEmptyString(recoveredTopic.id) ||
      !(recoveredTopic.deletedAt === null || typeof recoveredTopic.deletedAt === 'string')
    ) {
      return null
    }
  }
  return parsed as unknown as ImportNavigationProjection
}
