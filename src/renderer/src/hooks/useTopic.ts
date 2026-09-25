import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import { dbService } from '@renderer/services/db'
import { persistTopicMetadata } from '@renderer/services/db/topicMetadataPersist'
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
    if (activeTopic) {
      // Actual topic switch (ID change — not a metadata refresh of the same
      // topic): restore the logical topic's previously active branch instead
      // of resetting to main. `activeBranchIdByTopic` is persisted; the
      // stored branch is kept as-is here and `loadTopicMessagesThunk`
      // resolves the active route at read time. Catalog refresh/deletion
      // (`branchesReceived`) invalidates stale IDs back to main, and the
      // same-profile relaunch rehydrates the valid selection the same way.
      // Sidebar remains logical-topic-only.
      if (prevActiveTopicIdRef.current !== activeTopic.id) {
        prevActiveTopicIdRef.current = activeTopic.id
      }
      void store.dispatch(loadTopicMessagesThunk(activeTopic.id))
      void EventEmitter.emit(EVENT_NAMES.CHANGE_TOPIC, activeTopic)
    }
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
    // Never loads the whole topic into Redux for naming.
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
      return
    }
    const { topic: authorityTopic, messageCount, firstMessage, latestMessages, blocks } = namingContext

    if (messageCount === 0 || !firstMessage || isEmpty(latestMessages)) {
      return
    }

    if (authorityTopic.isNameManuallyEdited) {
      return
    }

    // Base Topic for persistence comes from the loaded Redux projection (no
    // message load); authority naming metadata drives all rename gates.
    const reduxTopic = store
      .getState()
      .assistants.assistants.flatMap((a) => a.topics)
      .find((t) => t.id === topicId)
    const baseTopic = (reduxTopic ?? { id: topicId, name: authorityTopic.name }) as Topic
    // Default-eligible: effective current name is the default name, OR the
    // authority (Main) name is null/empty (legacy/lazy Main row). Authority
    // name stays primary with Redux fallback; never ensureTopic/create a row.
    const currentName = authorityTopic.name ?? reduxTopic?.name ?? ''
    const defaultTopicName = i18n.t('chat.default.topic.name')
    const isDefaultEligible =
      currentName === defaultTopicName || authorityTopic.name == null || authorityTopic.name === ''
    const enableTopicNaming = getStoreSetting('enableTopicNaming')

    const applyTopicName = async (name: string) => {
      const data = { ...baseTopic, name } as Topic
      // Phase 5.2B: persist metadata to SQLite before Redux mutation (LOCK-528).
      await persistTopicMetadata(data)
      if (topicId === _activeTopic?.id) {
        _setActiveTopic(data)
      }
      store.dispatch(updateTopic({ assistantId: assistant.id, topic: data }))
    }

    const snapshotBlocksById = createSnapshotBlockMap(blocks)
    const getFirstMessageName = () => {
      const text = getMainTextSnapshotContent(firstMessage, snapshotBlocksById).trim()

      return truncateText(text)
    }

    if (!enableTopicNaming) {
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
