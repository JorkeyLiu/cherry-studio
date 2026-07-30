import { loggerService } from '@logger'
import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import { dbService } from '@renderer/services/db'
import { isAgentSessionTopicId as isAgentTopicId } from '@renderer/services/db'
import { persistTopicMetadata } from '@renderer/services/db/topicMetadataPersist'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { safeDeleteFiles } from '@renderer/services/MessagesService'
import store from '@renderer/store'
import { updateTopic } from '@renderer/store/assistants'
import { setNewlyRenamedTopics, setRenamingTopics } from '@renderer/store/runtime'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, FileMetadata, Topic } from '@renderer/types'
import { isAgentSessionTopicId } from '@renderer/utils/agentSession'
import { findMainTextBlocks } from '@renderer/utils/messageUtils/find'
import { isFileBlock, isImageBlock } from '@renderer/utils/messageUtils/is'
import { truncateText } from '@renderer/utils/naming'
import dayjs from 'dayjs'
import { find, isEmpty } from 'lodash'
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'

import { useAssistant } from './useAssistant'
import { getStoreSetting } from './useSettings'

let _activeTopic: Topic
let _setActiveTopic: Dispatch<SetStateAction<Topic>>

const logger = loggerService.withContext('useTopic')

export function useActiveTopic(assistantId: string, topic?: Topic) {
  const { assistant } = useAssistant(assistantId)
  const [activeTopic, setActiveTopic] = useState(topic || _activeTopic || assistant?.topics[0])

  _activeTopic = activeTopic
  _setActiveTopic = setActiveTopic

  useEffect(() => {
    if (activeTopic) {
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

export async function getTopicById(topicId: string) {
  const assistants = store.getState().assistants.assistants
  const topics = assistants.map((assistant) => assistant.topics).flat()
  const topic = topics.find((topic) => topic.id === topicId)
  const messages = await TopicManager.getTopicMessages(topicId)
  return { ...topic, messages } as Topic
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

export const autoRenameTopic = async (assistant: Assistant, topicId: string) => {
  if (topicRenamingLocks.has(topicId)) {
    return
  }

  try {
    topicRenamingLocks.add(topicId)

    const topic = await getTopicById(topicId)
    const enableTopicNaming = getStoreSetting('enableTopicNaming')

    if (isEmpty(topic.messages)) {
      return
    }

    if (topic.isNameManuallyEdited) {
      return
    }

    const applyTopicName = async (name: string) => {
      const data = { ...topic, name } as Topic
      // Phase 5.2B: persist metadata to SQLite before Redux mutation (LOCK-528).
      // Agent-session topics bypass SQLite within persistTopicMetadata.
      await persistTopicMetadata(data)
      if (topic.id === _activeTopic.id) {
        _setActiveTopic(data)
      }
      store.dispatch(updateTopic({ assistantId: assistant.id, topic: data }))
    }

    const getFirstMessageName = () => {
      const message = topic.messages[0]
      const blocks = findMainTextBlocks(message)
      const text = blocks
        .map((block) => block.content)
        .join('\n\n')
        .trim()

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

    if (topic && topic.name === i18n.t('chat.default.topic.name') && topic.messages.length >= 2) {
      startTopicRenaming(topicId)
      try {
        const { text: summaryText, error } = await fetchMessagesSummary({ messages: topic.messages })
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

/**
 * LOCK-P5.3-2/3: Collect file/image metadata from Dexie message_blocks for
 * an agent topic's messages, then apply non-force FileManager cleanup.
 * Returns the collected files for callers that need them before deletion.
 */
async function collectAgentFileMetadata(
  topicRow: { messages?: Array<{ blocks?: string[] }> } | undefined
): Promise<FileMetadata[]> {
  if (!topicRow?.messages?.length) return []
  const blockIds = topicRow.messages.flatMap((m) => m.blocks ?? [])
  if (blockIds.length === 0) return []
  const blocks = await db.message_blocks.bulkGet(blockIds)
  const files: FileMetadata[] = []
  for (const block of blocks) {
    if (!block) continue
    if (isFileBlock(block)) {
      files.push(block.file)
    } else if (isImageBlock(block) && block.file) {
      files.push(block.file)
    }
  }
  return files
}

/**
 * LOCK-P5.3-2/3: Apply non-force FileManager cleanup for collected agent
 * file metadata. Each file's Dexie count is decremented; if it reaches 0
 * the physical file is also removed.
 */
async function cleanupAgentFiles(files: FileMetadata[]): Promise<void> {
  for (const file of files) {
    try {
      await FileManager.deleteFile(file.id)
    } catch (error) {
      logger.error(`Post-commit agent file cleanup failed for ${file.id}:`, error as Error)
    }
  }
}

export const TopicManager = {
  async getTopic(id: string) {
    if (!isAgentSessionTopicId(id))
      return store
        .getState()
        .assistants.assistants.flatMap((a) => a.topics)
        .find((t) => t.id === id)
    const topic = store
      .getState()
      .assistants.assistants.flatMap((a) => a.topics)
      .find((item) => item.id === id)
    return topic
  },

  async getAllTopics() {
    const ordinaryTopics = store.getState().assistants.assistants.flatMap((assistant) => assistant.topics)
    const agentTopics = await db.topics.toArray()
    return [...ordinaryTopics.filter((topic) => !isAgentSessionTopicId(topic.id)), ...agentTopics]
  },

  /**
   * 加载并返回指定话题的消息
   */
  async getTopicMessages(id: string) {
    const topic = await TopicManager.getTopic(id)
    if (!topic) return []

    await store.dispatch(loadTopicMessagesThunk(id))

    // 获取更新后的话题
    const updatedTopic = await TopicManager.getTopic(id)
    return updatedTopic?.messages || []
  },

  async removeTopic(id: string) {
    if (isAgentTopicId(id)) {
      // LOCK-P5.3-3: Agent permanent delete must collect file/image metadata,
      // then atomically delete blocks+topic from Dexie, and only THEN
      // apply non-force FileManager cleanup (LOCK-001: cleanup after commit).
      const topicRow = await db.topics.get(id)
      const agentFiles = await collectAgentFileMetadata(topicRow)

      // Atomic Dexie transaction: delete blocks + topic together
      await db.transaction('rw', db.message_blocks, db.topics, async () => {
        if (topicRow?.messages?.length) {
          const blockIds = topicRow.messages.flatMap((m) => m.blocks ?? [])
          if (blockIds.length > 0) {
            await db.message_blocks.bulkDelete(blockIds)
          }
        }
        await db.topics.delete(id)
      })

      // Post-commit file cleanup only (LOCK-001)
      if (agentFiles.length > 0) {
        await cleanupAgentFiles(agentFiles)
      }
      return
    }
    const cleanup = await dbService.hardDeleteTopic(id)
    await consumeFileCleanupResult(cleanup)
  },

  async clearTopicMessages(id: string): Promise<void> {
    // 暂存需要删除的文件信息
    const filesToDelete: FileMetadata[] = []

    try {
      if (isAgentTopicId(id)) {
        // LOCK-P5.3-2/LOCK-001: Agent clear must atomically clear
        // topic messages and message_blocks in a single Dexie transaction,
        // then perform non-force FileManager cleanup only after commit.
        const topicRow = await db.topics.get(id)
        const agentFiles = await collectAgentFileMetadata(topicRow)
        filesToDelete.push(...agentFiles)

        // Atomic Dexie transaction: clear blocks + topic messages together
        await db.transaction('rw', db.message_blocks, db.topics, async () => {
          if (topicRow?.messages?.length) {
            const blockIds = topicRow.messages.flatMap((m) => m.blocks ?? [])
            if (blockIds.length > 0) {
              await db.message_blocks.bulkDelete(blockIds)
            }
          }
          // Clear messages array on the topic row (preserving topic metadata)
          await db.topics.update(id, { messages: [] })
        })
      } else {
        const cleanup = await dbService.clearTopicWithSegments(id)
        await consumeFileCleanupResult(cleanup)
      }
    } catch (dbError) {
      logger.error(`Failed to clear database records for topic ${id}:`, dbError as Error)
      throw dbError
    }

    // Post-commit file cleanup (LOCK-001)
    if (filesToDelete.length > 0) {
      await safeDeleteFiles(filesToDelete)
    }
  },

  // Soft-delete: persist topic metadata in DB, keep messages/files intact
  async softRemoveTopic(topic: Topic) {
    if (isAgentTopicId(topic.id)) {
      const existing = await db.topics.get(topic.id)
      await db.topics.put({
        ...topic,
        messages: existing?.messages ?? topic.messages ?? [],
        deletedAt: new Date().toISOString()
      })
      return
    }
    await dbService.softDeleteTopic(topic.id, topic.name)
  },

  // Restore: clear deletedAt in DB
  async restoreTopic(id: string): Promise<Topic | undefined> {
    if (isAgentTopicId(id)) {
      // LOCK-003: Agent restore must work even when the topic was removed
      // from Redux. Load the trashed row directly from Dexie.
      let topic = store
        .getState()
        .assistants.assistants.flatMap((a) => a.topics)
        .find((t) => t.id === id)
      if (!topic) {
        // Redux-absent: load from Dexie trash row
        const dexieRow = await db.topics.get(id)
        if (dexieRow) {
          topic = {
            ...dexieRow,
            assistantId: (dexieRow as any).assistantId ?? '',
            messages: dexieRow.messages ?? []
          } as Topic
        }
      }
      if (topic) {
        await db.topics.update(id, { deletedAt: undefined })
        const restoredTopic = { ...topic }
        delete restoredTopic.deletedAt
        return restoredTopic
      }
      return undefined
    }
    const wire = await dbService.restoreTopic(id)
    if (wire === null) return undefined
    return wire as unknown as Topic
  },

  // Get all soft-deleted topics for a specific assistant (from DB)
  async getTrashTopics(assistantId: string): Promise<Topic[]> {
    const agentTopics = (await db.topics.toArray()).filter(
      (topic) => isAgentSessionTopicId(topic.id) && (topic as Topic).assistantId === assistantId
    )
    const all = [...(await dbService.listTrashTopics(assistantId)).items, ...agentTopics]
    return all
      .filter((t) => t.deletedAt && (t as Topic).assistantId === assistantId)
      .sort((a, b) => new Date(b.deletedAt!).getTime() - new Date(a.deletedAt!).getTime()) as Topic[]
  },

  // Get all soft-deleted topics (from DB), regardless of assistant
  async getAllTrashTopics(): Promise<Topic[]> {
    const all = (await db.topics.toArray()).filter((topic) => isAgentSessionTopicId(topic.id))
    return all
      .filter((t) => t.deletedAt)
      .sort((a, b) => new Date(b.deletedAt!).getTime() - new Date(a.deletedAt!).getTime()) as Topic[]
  },

  // Permanently delete AGENT-SESSION topics that have been in trash >= 5 days.
  // Phase 5.2B: the ordinary-chat expired purge is SQLite-owned (LOCK-521/523);
  // this retained Dexie purge must only ever touch agent-session rows.
  // Uses the existing removeTopic which clears messages+files
  async purgeExpiredTopics(): Promise<number> {
    const now = dayjs()
    const trashTopics = (await TopicManager.getAllTopics()).filter((t) => !!t.deletedAt && isAgentSessionTopicId(t.id))
    let count = 0
    for (const topic of trashTopics) {
      if (now.diff(dayjs(topic.deletedAt), 'day') >= 5) {
        await TopicManager.removeTopic(topic.id) // existing hard delete
        count++
      }
    }
    return count
  }
}
