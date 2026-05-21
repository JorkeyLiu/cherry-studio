import { loggerService } from '@logger'
import {
  getThinkModelType,
  isSupportedReasoningEffortModel,
  isSupportedThinkingTokenModel,
  MODEL_SUPPORTED_OPTIONS,
  MODEL_SUPPORTED_REASONING_EFFORT
} from '@renderer/config/models'
import { db } from '@renderer/databases'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addAssistant,
  addTopic,
  addTopicFromTrash,
  insertAssistant,
  removeAllTopics,
  removeAssistant,
  removeTopic,
  setModel,
  updateAssistant,
  updateAssistants,
  updateAssistantSettings as _updateAssistantSettings,
  updateDefaultAssistant,
  updateTopic,
  updateTopics
} from '@renderer/store/assistants'
import { setDefaultModel, setQuickModel, setTranslateModel } from '@renderer/store/llm'
import type { Assistant, AssistantSettings, Model, ThinkingOption, Topic } from '@renderer/types'
import { getModelReasoningEffortKey } from '@renderer/types'
import { uuid } from '@renderer/utils'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { TopicManager } from './useTopic'

export function useAssistants() {
  const { t } = useTranslation()
  const { assistants } = useAppSelector((state) => state.assistants)
  const dispatch = useAppDispatch()
  const logger = loggerService.withContext('useAssistants')

  return {
    assistants,
    updateAssistants: (assistants: Assistant[]) => dispatch(updateAssistants(assistants)),
    addAssistant: (assistant: Assistant) => dispatch(addAssistant(assistant)),
    insertAssistant: (index: number, assistant: Assistant) => dispatch(insertAssistant({ index, assistant })),
    copyAssistant: (assistant: Assistant): Assistant | undefined => {
      if (!assistant) {
        logger.error("assistant doesn't exists.")
        return
      }
      const index = assistants.findIndex((_assistant) => _assistant.id === assistant.id)
      const _assistant: Assistant = { ...assistant, id: uuid(), topics: [getDefaultTopic(assistant.id)] }
      if (index === -1) {
        logger.warn("Origin assistant's id not found. Fallback to addAssistant.")
        dispatch(addAssistant(_assistant))
      } else {
        // 插入到后面
        try {
          dispatch(insertAssistant({ index: index + 1, assistant: _assistant }))
        } catch (e) {
          logger.error('Failed to insert assistant', e as Error)
          window.toast.error(t('message.error.copy'))
        }
      }
      return _assistant
    },
    removeAssistant: (id: string) => {
      dispatch(removeAssistant({ id }))
      const assistant = assistants.find((a) => a.id === id)
      const topics = assistant?.topics || []
      topics.forEach(({ id }) => TopicManager.removeTopic(id))
    }
  }
}

export function useAssistant(id: string) {
  const assistant = useAppSelector((state) => state.assistants.assistants.find((a) => a.id === id) as Assistant)
  const dispatch = useAppDispatch()
  const { defaultModel } = useDefaultModel()

  const model = useMemo(() => assistant?.model ?? assistant?.defaultModel ?? defaultModel, [assistant, defaultModel])
  if (!model) {
    throw new Error(`Assistant model is not set for assistant with name: ${assistant?.name ?? 'unknown'}`)
  }

  const normalizedTopics = useMemo(
    () => (Array.isArray(assistant?.topics) ? assistant.topics : []),
    [assistant?.topics]
  )
  const assistantWithModel = useMemo(
    () => ({ ...assistant, model, topics: normalizedTopics }),
    [assistant, model, normalizedTopics]
  )

  const settingsRef = useRef(assistant?.settings)
  const previousModelKeyRef = useRef(getModelReasoningEffortKey(model))

  useEffect(() => {
    settingsRef.current = assistant?.settings
  }, [assistant?.settings])

  const updateAssistantSettings = useCallback(
    (settings: Partial<AssistantSettings>) => {
      assistant?.id && dispatch(_updateAssistantSettings({ assistantId: assistant.id, settings }))
    },
    [assistant?.id, dispatch]
  )

  // 当model变化时，同步reasoning effort为模型支持的合法值
  useEffect(() => {
    const settings = settingsRef.current
    if (settings) {
      const currentReasoningEffort = settings.reasoning_effort
      const currentModelKey = getModelReasoningEffortKey(model)
      const previousModelKey = previousModelKeyRef.current
      const reasoningEffortByModel = { ...settings.reasoning_effort_by_model }
      const isModelChanged = previousModelKey !== undefined && previousModelKey !== currentModelKey

      if (isModelChanged && previousModelKey && currentReasoningEffort) {
        reasoningEffortByModel[previousModelKey] = currentReasoningEffort
      }

      if (isSupportedThinkingTokenModel(model) || isSupportedReasoningEffortModel(model)) {
        const modelType = getThinkModelType(model)
        const supportedOptions = MODEL_SUPPORTED_OPTIONS[modelType]
        const modelCachedOption = currentModelKey ? reasoningEffortByModel[currentModelKey] : undefined

        if (modelCachedOption && supportedOptions.includes(modelCachedOption)) {
          if (
            modelCachedOption !== currentReasoningEffort ||
            reasoningEffortByModel[currentModelKey!] !== modelCachedOption
          ) {
            updateAssistantSettings({
              reasoning_effort: modelCachedOption,
              reasoning_effort_by_model: reasoningEffortByModel,
              qwenThinkMode: modelCachedOption !== 'none' && modelCachedOption !== 'default'
            })
          }
        } else if (isModelChanged || supportedOptions.every((option) => option !== currentReasoningEffort)) {
          const cache = settings.reasoning_effort_cache
          let fallbackOption: ThinkingOption

          // 选项不支持时，首先尝试恢复到上次使用的旧缓存值
          if (!isModelChanged && cache && supportedOptions.includes(cache)) {
            fallbackOption = cache
          } else {
            // 灵活回退到支持的值
            // 注意：这里假设可用的options不会为空
            const enableThinking = currentReasoningEffort !== undefined && currentReasoningEffort !== 'none'
            fallbackOption = enableThinking
              ? MODEL_SUPPORTED_REASONING_EFFORT[modelType][0]
              : MODEL_SUPPORTED_OPTIONS[modelType][0]
          }

          if (currentModelKey) {
            reasoningEffortByModel[currentModelKey] = fallbackOption
          }

          updateAssistantSettings({
            reasoning_effort: fallbackOption,
            reasoning_effort_by_model: reasoningEffortByModel,
            reasoning_effort_cache: fallbackOption,
            qwenThinkMode: fallbackOption !== 'none' && fallbackOption !== 'default'
          })
        } else {
          if (
            currentModelKey &&
            currentReasoningEffort &&
            reasoningEffortByModel[currentModelKey] !== currentReasoningEffort
          ) {
            reasoningEffortByModel[currentModelKey] = currentReasoningEffort
            updateAssistantSettings({
              reasoning_effort_by_model: reasoningEffortByModel,
              reasoning_effort_cache: currentReasoningEffort,
              qwenThinkMode: currentReasoningEffort !== 'none' && currentReasoningEffort !== 'default'
            })
          }
        }
      } else {
        // 切换到非思考模型时保留当前模型缓存，active值设为none以表达显式关闭
        const shouldUpdate =
          currentReasoningEffort !== 'none' ||
          (isModelChanged &&
            previousModelKey &&
            settings.reasoning_effort_by_model?.[previousModelKey] !== currentReasoningEffort) ||
          settings.reasoning_effort_cache !== currentReasoningEffort

        if (shouldUpdate) {
          updateAssistantSettings({
            reasoning_effort: 'none',
            reasoning_effort_by_model: reasoningEffortByModel,
            reasoning_effort_cache: currentReasoningEffort,
            qwenThinkMode: false
          })
        }
      }
      previousModelKeyRef.current = currentModelKey
    }
  }, [model, updateAssistantSettings])

  return {
    assistant: assistantWithModel,
    model,
    addTopic: (topic: Topic) => dispatch(addTopic({ assistantId: assistant.id, topic })),
    removeTopic: async (topic: Topic) => {
      await TopicManager.softRemoveTopic(topic)
      dispatch(removeTopic({ assistantId: assistant.id, topic }))
    },
    restoreTopic: async (topicId: string) => {
      const topic = (await TopicManager.getTopic(topicId)) as Topic | undefined
      if (topic) {
        await TopicManager.restoreTopic(topicId)
        const restoredTopic = { ...topic }
        delete restoredTopic.deletedAt
        dispatch(addTopicFromTrash({ assistantId: assistant.id, topic: restoredTopic }))
      }
    },
    moveTopic: (topic: Topic, toAssistant: Assistant) => {
      dispatch(addTopic({ assistantId: toAssistant.id, topic: { ...topic, assistantId: toAssistant.id } }))
      dispatch(removeTopic({ assistantId: assistant.id, topic }))
      // update topic messages in database
      void db.topics
        .where('id')
        .equals(topic.id)
        .modify((dbTopic) => {
          if (dbTopic.messages) {
            dbTopic.messages = dbTopic.messages.map((message) => ({
              ...message,
              assistantId: toAssistant.id
            }))
          }
        })
    },
    updateTopic: (topic: Topic) => dispatch(updateTopic({ assistantId: assistant.id, topic })),
    updateTopics: (topics: Topic[]) => dispatch(updateTopics({ assistantId: assistant.id, topics })),
    removeAllTopics: () => dispatch(removeAllTopics({ assistantId: assistant.id })),
    setModel: useCallback(
      (model: Model) => assistant && dispatch(setModel({ assistantId: assistant?.id, model })),
      [assistant, dispatch]
    ),
    updateAssistant: useCallback(
      (update: Partial<Omit<Assistant, 'id'>>) => dispatch(updateAssistant({ id, ...update })),
      [dispatch, id]
    ),
    updateAssistantSettings
  }
}

export function useDefaultAssistant() {
  const defaultAssistant = useAppSelector((state) => state.assistants.defaultAssistant)
  const dispatch = useAppDispatch()
  const memoizedTopics = useMemo(() => [getDefaultTopic(defaultAssistant.id)], [defaultAssistant.id])

  return {
    defaultAssistant: {
      ...defaultAssistant,
      topics: memoizedTopics
    },
    updateDefaultAssistant: (assistant: Assistant) => dispatch(updateDefaultAssistant({ assistant }))
  }
}

export function useDefaultModel() {
  const { defaultModel, quickModel, translateModel } = useAppSelector((state) => state.llm)
  const dispatch = useAppDispatch()

  return {
    defaultModel,
    quickModel,
    translateModel,
    setDefaultModel: (model: Model) => dispatch(setDefaultModel({ model })),
    setQuickModel: (model: Model) => dispatch(setQuickModel({ model })),
    setTranslateModel: (model: Model) => dispatch(setTranslateModel({ model }))
  }
}
