/**
 * topicDeletionFlow — Phase 5.2B convergent topic deletion ordering.
 *
 * Shared by the Topics tab delete handlers so the destructive soft delete
 * always persists BEFORE any Redux/active-topic UI mutation (LOCK-528):
 *
 * 1. Wait for in-flight generation.
 * 2. If the topic is the last one, persist a replacement topic first
 *    (SQLite ownership + Dexie message-store row, LOCK-533) WITHOUT
 *    exposing it to Redux yet.
 * 3. Soft delete the topic. A failure here propagates and leaves the UI
 *    completely untouched — no active-topic switch, no replacement topic.
 * 4. Only after the delete succeeded: expose the replacement (if any) or
 *    switch the active topic to the neighbouring topic.
 */

import type { Topic } from '@renderer/types'

export interface TopicDeletionFlowDeps {
  /** Await in-flight generation before mutating topics. */
  modelGenerating: () => Promise<void>
  /** Soft delete. Must reject when persistence fails (LOCK-528). */
  removeTopic: (topic: Topic) => Promise<void>
  /** Expose an already-persisted topic to Redux. */
  addTopic: (topic: Topic) => void
  /** Switch the active topic in the UI. */
  setActiveTopic: (topic: Topic) => void
  /**
   * Persist a replacement topic (SQLite assistant ownership first, then the
   * Dexie message-store row) and return it. Must NOT touch Redux.
   */
  createPersistedReplacement: () => Promise<Topic>
}

export interface TopicDeletionFlowOptions {
  /** The topic to delete. */
  topic: Topic
  /** The assistant's current topic list (pre-delete snapshot). */
  topics: Topic[]
  /** The currently active topic ID, if any. */
  activeTopicId?: string
  deps: TopicDeletionFlowDeps
}

/**
 * Delete a topic with convergent persistence-before-UI ordering.
 *
 * @throws when the soft delete (or replacement persistence) fails; the
 *         caller must leave the UI unchanged in that case.
 */
export async function deleteTopicFlow({ topic, topics, activeTopicId, deps }: TopicDeletionFlowOptions): Promise<void> {
  await deps.modelGenerating()

  const isLastTopic = topics.length === 1
  // Persist the replacement BEFORE the destructive mutation so the later
  // Redux exposure cannot fail (LOCK-533). It stays invisible until the
  // soft delete has committed.
  const replacement = isLastTopic ? await deps.createPersistedReplacement() : null

  const index = topics.findIndex((t) => t.id === topic.id)
  const fallback = topics[index + 1 === topics.length ? index - 1 : index + 1]

  // LOCK-528: the soft delete must succeed before any UI mutation. A failed
  // delete propagates here and neither switches nor creates a UI topic.
  await deps.removeTopic(topic)

  if (replacement) {
    deps.addTopic(replacement)
    deps.setActiveTopic(replacement)
  } else if (topic.id === activeTopicId && fallback) {
    deps.setActiveTopic(fallback)
  }
}
