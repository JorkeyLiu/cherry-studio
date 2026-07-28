/**
 * topicMetadataPersist — Phase 5.2B ordinary-chat metadata caller migration.
 *
 * Persists the four allowed topic metadata fields (name, pinned, prompt,
 * isNameManuallyEdited) to SQLite through SqliteMessageDataSource.updateTopicMetadata
 * BEFORE the Redux mutation is applied.
 *
 * Contract:
 * - LOCK-522: only name, pinned, prompt, isNameManuallyEdited may cross IPC;
 *   a missing topic (ERR_NOT_FOUND) propagates via ChatDbResultError.
 * - LOCK-524: no Dexie fallback, no client-side transaction chaining.
 * - LOCK-528: SQLite mutation must succeed before Redux mutation; on failure
 *   Redux is left unchanged and the error propagates to the caller.
 * - LOCK-521/529: agent-session topic IDs bypass SQLite entirely and preserve
 *   their existing backend + Redux rename behavior.
 */

import store from '@renderer/store'
import type { Topic } from '@renderer/types'
import { isAgentSessionTopicId } from '@renderer/utils/agentSession'

import { SqliteMessageDataSource } from './SqliteMessageDataSource'

const sqliteSource = new SqliteMessageDataSource()

/**
 * Diff the changed metadata fields between the current Redux topic and the next
 * topic. Returns only the four allowed fields that actually differ.
 */
function diffMetadata(
  prev: Topic | undefined,
  next: Topic
): {
  name?: string
  pinned?: boolean
  prompt?: string
  isNameManuallyEdited?: boolean
} {
  const changed: {
    name?: string
    pinned?: boolean
    prompt?: string
    isNameManuallyEdited?: boolean
  } = {}

  if (prev?.name !== next.name) {
    changed.name = next.name
  }
  if (prev?.pinned !== next.pinned) {
    changed.pinned = next.pinned
  }
  if (prev?.prompt !== next.prompt) {
    changed.prompt = next.prompt
  }
  if (prev?.isNameManuallyEdited !== next.isNameManuallyEdited) {
    changed.isNameManuallyEdited = next.isNameManuallyEdited
  }

  return changed
}

/**
 * Persist a topic metadata update to SQLite (ordinary-chat topics only).
 *
 * Agent-session topic IDs are bypassed: the function resolves without touching
 * SQLite so the caller's subsequent Redux mutation still runs unchanged.
 *
 * @throws {ChatDbResultError} on structured SQLite failure (e.g. ERR_NOT_FOUND).
 * @throws transport errors from the IPC bridge unchanged.
 */
export async function persistTopicMetadata(next: Topic): Promise<void> {
  // LOCK-521/529: agent-session lifecycle stays on its backend HTTP path.
  if (isAgentSessionTopicId(next.id)) {
    return
  }

  const state = store.getState()
  const prev = state.assistants.assistants.find((a) => a.id === next.assistantId)?.topics.find((t) => t.id === next.id)

  const changed = diffMetadata(prev, next)

  // Nothing in the allowed metadata set changed; nothing to persist, but we
  // must not silently drop an unexpected field either.
  if (Object.keys(changed).length === 0) {
    return
  }

  // LOCK-528: SQLite mutation must succeed before Redux mutation.
  await sqliteSource.updateTopicMetadata(
    next.id,
    changed.name,
    changed.pinned,
    changed.prompt,
    changed.isNameManuallyEdited
  )
}
