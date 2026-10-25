import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import { dbService } from '@renderer/services/db'
import { persistAutomaticTopicName } from '@renderer/services/db/topicMetadataPersist'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import store from '@renderer/store'
import { updateTopic } from '@renderer/store/assistants'
import { setNewlyRenamedTopics, setRenamingTopics } from '@renderer/store/runtime'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { createSnapshotBlockMap, getMainTextSnapshotContent } from '@renderer/utils/messageUtils/snapshotBlocks'
import { truncateText } from '@renderer/utils/naming'
import { find, isEmpty } from 'lodash'
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react'

import { useAssistant } from './useAssistant'
import { getStoreSetting } from './useSettings'

let _activeTopic: Topic
let _setActiveTopic: Dispatch<SetStateAction<Topic>>

export function useActiveTopic(assistantId: string, topic?: Topic) {
  const { assistant } = useAssistant(assistantId)
  const [activeTopic, setActiveTopic] = useState(topic || _activeTopic || assistant?.topics[0])

  _activeTopic = activeTopic
  _setActiveTopic = setActiveTopic

  const prevActiveTopicIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!activeTopic) {
      prevActiveTopicIdRef.current = undefined
      return
    }
    // Selected-topic identity gate: only a real ID change loads. Effect
    // reattach (Activity hide/show) or an innocuous same-ID object update
    // (metadata sync) must not redispatch the cache-hit path, which would
    // bump the shared same-topic sequence and supersede the viewport's
    // correct in-flight around request. Initial mount (ref uninitialized)
    // and genuine A→B→A changes still dispatch. Explicit refresh owns its
    // own forceReload path elsewhere and never routes through this gate.
    if (prevActiveTopicIdRef.current === activeTopic.id) {
      return
    }
    // Actual topic switch (ID change — not a metadata refresh of the same
    // topic): restore the logical topic's previously active branch instead
    // of resetting to main. `activeBranchIdByTopic` is persisted; the
    // stored branch is kept as-is here and `loadTopicMessagesThunk`
    // resolves the active route at read time. Catalog refresh/deletion
    // (`branchesReceived`) invalidates stale IDs back to main, and the
    // same-profile relaunch rehydrates the valid selection the same way.
    // Sidebar remains logical-topic-only.
    prevActiveTopicIdRef.current = activeTopic.id
    void store.dispatch(loadTopicMessagesThunk(activeTopic.id))
    void EventEmitter.emit(EVENT_NAMES.CHANGE_TOPIC, activeTopic)
  }, [activeTopic])

  useEffect(() => {
    // activeTopic not in assistant.topics
    // 确保 assistant 和 assistant.topics 存在，避免在数据未完全加载时访问属性
    if (
      assistant &&
      assistant.topics &&
      Array.isArray(assistant.topics) &&
      assistant.topics.length > 0 &&
      !find(assistant.topics, { id: activeTopic?.id })
    ) {
      setActiveTopic(assistant.topics[0])
    }
  }, [activeTopic?.id, assistant])

  useEffect(() => {
    if (!assistant?.topics?.length || !activeTopic) {
      return
    }

    const latestTopic = assistant.topics.find((item) => item.id === activeTopic.id)
    if (latestTopic && latestTopic !== activeTopic) {
      setActiveTopic(latestTopic)
    }
  }, [assistant?.topics, activeTopic])

  return { activeTopic, setActiveTopic }
}

export function useTopic(assistant: Assistant, topicId?: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export function getTopic(assistant: Assistant, topicId: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

/**
 * 开始重命名指定话题
 */
export const startTopicRenaming = (topicId: string) => {
  const currentIds = store.getState().runtime.chat.renamingTopics
  if (!currentIds.includes(topicId)) {
    store.dispatch(setRenamingTopics([...currentIds, topicId]))
  }
}

/**
 * 完成重命名指定话题
 */
export const finishTopicRenaming = (topicId: string) => {
  const state = store.getState()

  // 1. 立即从 renamingTopics 移除
  const currentRenaming = state.runtime.chat.renamingTopics
  store.dispatch(setRenamingTopics(currentRenaming.filter((id) => id !== topicId)))

  // 2. 立即添加到 newlyRenamedTopics
  const currentNewlyRenamed = state.runtime.chat.newlyRenamedTopics
  store.dispatch(setNewlyRenamedTopics([...currentNewlyRenamed, topicId]))

  // 3. 延迟从 newlyRenamedTopics 移除
  setTimeout(() => {
    const current = store.getState().runtime.chat.newlyRenamedTopics
    store.dispatch(setNewlyRenamedTopics(current.filter((id) => id !== topicId)))
  }, 700)
}

const topicRenamingLocks = new Set<string>()

export const autoRenameTopic = async (assistant: Assistant, topicId: string, branchId?: string | null) => {
  if (topicRenamingLocks.has(topicId)) {
    return
  }

  try {
    topicRenamingLocks.add(topicId)

    // Bounded naming authority: exact count + first + latest ≤5 + their blocks.
    // Never loads the whole topic into Redux for naming. branchId is the
    // captured request route (never re-derived from latest active here).
    let namingContext: {
      topic: { id: string; name: string | null; isNameManuallyEdited: boolean | null }
      messageCount: number
      firstMessage: Message | null
      latestMessages: Message[]
      blocks: MessageBlock[]
    }
    try {
      namingContext = await dbService.fetchTopicNamingContext(topicId, branchId ?? null)
    } catch {
      // Missing topic / transport: graceful no-op, no metadata creation.
      return
    }
    const { topic: authorityTopic, messageCount, firstMessage, latestMessages, blocks } = namingContext

    if (messageCount === 0 || !firstMessage || isEmpty(latestMessages)) {
      return
    }

    // Real manual state from both authority and projection: either true blocks.
    const reduxTopicAtRead = store
      .getState()
      .assistants.assistants.flatMap((a) => a.topics)
      .find((t) => t.id === topicId)
    if (authorityTopic.isNameManuallyEdited || reduxTopicAtRead?.isNameManuallyEdited) {
      return
    }

    // Effective current name: authority wins when non-empty; a null/empty
    // authority (legacy/lazy Main row) falls back to the Redux projection so a
    // non-default inherited title is preserved. Never ensureTopic/create a row.
    const authorityName = authorityTopic.name
    const effectiveName =
      authorityName !== null && authorityName !== undefined && authorityName !== ''
        ? authorityName
        : (reduxTopicAtRead?.name ?? '')
    const defaultTopicName = i18n.t('chat.default.topic.name')
    const isDefaultEligible = effectiveName === defaultTopicName
    // Capture the Main-authoritative preimage for the atomic conditional
    // write after the summary await. Null preserves legacy null (matches
    // null/absent authority, never creates metadata).
    const expectedPreimage = {
      expectedName: authorityName ?? null,
      expectedIsNameManuallyEdited: authorityTopic.isNameManuallyEdited ?? null
    }
    const enableTopicNaming = getStoreSetting('enableTopicNaming')

    const applyTopicName = async (name: string) => {
      if (!name) {
        return false
      }
      let wire: { name?: string | null }
      try {
        // Atomic Main guard: stale preimage (intervening manual rename,
        // non-default change, flag flip) returns the current wire unchanged.
        // Missing topic throws NOT_FOUND → graceful no-op.
        wire = await persistAutomaticTopicName(topicId, name, expectedPreimage)
      } catch {
        return false
      }
      // Guarded no-op: Main kept the old name (changed preimage) or the topic
      // is gone → never touch the projection, never reintroduce the topic.
      if (wire.name !== name) {
        return false
      }
      // Projection update only after the authoritative change, built from the
      // latest Redux topic (never the stale pre-await snapshot) so only the
      // intended name changes and stale whole-topic flags are never reverted.
      const latest = store
        .getState()
        .assistants.assistants.flatMap((a) => a.topics)
        .find((t) => t.id === topicId)
      if (!latest) {
        return false
      }
      const data = { ...latest, name: wire.name ?? name } as Topic
      if (topicId === _activeTopic?.id) {
        _setActiveTopic(data)
      }
      store.dispatch(updateTopic({ assistantId: latest.assistantId ?? assistant.id, topic: data }))
      return true
    }

    const snapshotBlocksById = createSnapshotBlockMap(blocks)
    const getFirstMessageName = () => {
      const text = getMainTextSnapshotContent(firstMessage, snapshotBlocksById).trim()

      return truncateText(text)
    }

    if (!enableTopicNaming) {
      // Same default safeguard as the summary path: a non-default effective
      // title (including a Redux fallback over a null/empty authority) is
      // preserved; the atomic guard below still discards late races.
      if (!isDefaultEligible) {
        return
      }
      const topicName = getFirstMessageName()
      if (topicName) {
        try {
          startTopicRenaming(topicId)
          await applyTopicName(topicName)
        } finally {
          finishTopicRenaming(topicId)
        }
      }
      return
    }

    if (isDefaultEligible && messageCount >= 2) {
      startTopicRenaming(topicId)
      try {
        const { text: summaryText, error } = await fetchMessagesSummary({
          messages: latestMessages,
          blocksById: snapshotBlocksById
        })
        if (summaryText) {
          await applyTopicName(summaryText)
        } else {
          if (error) {
            window.toast?.error(`${i18n.t('message.error.fetchTopicName')}: ${error}`)
          }
          const fallbackName = getFirstMessageName()
          if (fallbackName) {
            await applyTopicName(fallbackName)
          }
        }
      } finally {
        finishTopicRenaming(topicId)
      }
    }
  } finally {
    topicRenamingLocks.delete(topicId)
  }
}

// Convert class to object with functions since class only has static methods
// 只有静态方法,没必要用class，可以export {}

export const TopicManager = {
  /**
   * Metadata-only topic lookup from the loaded Redux projection.
   * Never loads messages, blocks, windows, or snapshots.
   */
  async getTopic(id: string) {
    return store
      .getState()
      .assistants.assistants.flatMap((a) => a.topics)
      .find((t) => t.id === id)
  },

  async removeTopic(id: string) {
    const cleanup = await dbService.hardDeleteTopic(id)
    await consumeFileCleanupResult(cleanup)
  },

  // Soft-delete: persist topic metadata in DB, keep messages/files intact
  async softRemoveTopic(topic: Topic) {
    await dbService.softDeleteTopic(topic.id, topic.name)
  },

  // Restore: clear deletedAt in DB
  async restoreTopic(id: string): Promise<Topic | undefined> {
    const wire = await dbService.restoreTopic(id)
    if (wire === null) return undefined
    return wire as unknown as Topic
  }
}
