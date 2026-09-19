import { loggerService } from '@logger'
import { getModelSupportedReasoningEffortOptions, isReasoningModel } from '@renderer/config/models'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { dbService } from '@renderer/services/db'
import { persistTopicMetadata } from '@renderer/services/db/topicMetadataPersist'
import {
  ensureOrdinaryTopicOwnership,
  resetOrdinaryAssistantTopics,
  restoreOrdinaryTopic,
  softDeleteOrdinaryTopic
} from '@renderer/services/db/topicTrashLifecycle'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addAssistant,
  addTopic,
  addTopicFromTrash,
  insertAssistant,
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
import type { Assistant, AssistantSettings, Model, Topic } from '@renderer/types'
import { getModelReasoningEffortKey } from '@renderer/types'
import { uuid } from '@renderer/utils'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { TopicManager } from './useTopic'

/**
 * Establish SQLite ownership for every ordinary topic of a new assistant
 * BEFORE the assistant (and its topics) is exposed in Redux (LOCK-533).
 */
async function ensureAssistantTopicsOwnership(assistant: Assistant): Promise<void> {
  for (const topic of assistant.topics ?? []) {
    await ensureOrdinaryTopicOwnership(topic.id, assistant.id, topic.name)
  }
}

export function useAssistants() {
  const { t } = useTranslation()
  const { assistants } = useAppSelector((state) => state.assistants)
  const dispatch = useAppDispatch()
  const logger = loggerService.withContext('useAssistants')

  return {
    assistants,
    updateAssistants: (assistants: Assistant[]) => dispatch(updateAssistants(assistants)),
    addAssistant: async (assistant: Assistant) => {
      // LOCK-533/528: SQLite topic ownership persists before Redux exposure.
      await ensureAssistantTopicsOwnership(assistant)
      dispatch(addAssistant(assistant))
    },
    insertAssistant: async (index: number, assistant: Assistant) => {
      // LOCK-533/528: SQLite topic ownership persists before Redux exposure.
      await ensureAssistantTopicsOwnership(assistant)
      dispatch(insertAssistant({ index, assistant }))
    },
    copyAssistant: async (assistant: Assistant): Promise<Assistant | undefined> => {
      if (!assistant) {
        logger.error("assistant doesn't exists.")
        return
      }
      const index = assistants.findIndex((_assistant) => _assistant.id === assistant.id)
      const newId = uuid()
      const _assistant: Assistant = { ...assistant, id: newId, topics: [getDefaultTopic(newId)] }
      // LOCK-533/528: SQLite topic ownership persists before Redux exposure.
      await ensureAssistantTopicsOwnership(_assistant)
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

  // Unit B: user-intent lazy execution. Model switches never coerce the active
  // reasoning effort to `none`/`default` because of reasoning metadata, and a
  // concrete user level is never rejected for not appearing in a model-name
  // derived list. Per-model memory restore on switch is preserved; fixed
  // reasoning (`default` only, no controllable params) keeps its protocol fact
  // without touching the active value.
  useEffect(() => {
    // Model may be explicitly unconfigured (undefined). Skip the model-driven
    // reasoning-effort sync — nothing to sync without a model.
    if (!model) return
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

      const supportedOptions = getModelSupportedReasoningEffortOptions(model)
      const isControllable = !!supportedOptions && supportedOptions.filter((option) => option !== 'default').length > 0
      if (isControllable && supportedOptions) {
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
        } else if (currentReasoningEffort) {
          // Keep the explicit user level even when it is absent from the
          // model-derived list (endpoint/adapter decides encodability at
          // request time). Only record per-model memory/cache bookkeeping.
          if (
            currentModelKey &&
            (reasoningEffortByModel[currentModelKey] !== currentReasoningEffort ||
              settings.reasoning_effort_cache !== currentReasoningEffort)
          ) {
            if (currentModelKey) {
              reasoningEffortByModel[currentModelKey] = currentReasoningEffort
            }
            updateAssistantSettings({
              reasoning_effort_by_model: reasoningEffortByModel,
              reasoning_effort_cache: currentReasoningEffort,
              qwenThinkMode: currentReasoningEffort !== 'none' && currentReasoningEffort !== 'default'
            })
          }
        }
      } else if (isReasoningModel(model)) {
        // Fixed reasoning (resolved `default` only): no strength menu. Keep
        // the active value untouched while preserving per-model memory.
        if (
          currentModelKey &&
          currentReasoningEffort &&
          reasoningEffortByModel[currentModelKey] !== currentReasoningEffort
        ) {
          reasoningEffortByModel[currentModelKey] = currentReasoningEffort
          updateAssistantSettings({
            reasoning_effort_by_model: reasoningEffortByModel,
            qwenThinkMode: false
          })
        }
      } else {
        // Non-reasoning metadata models: preserve the user's active level
        // (never coerce to `none`). Only keep per-model memory consistent.
        if (
          isModelChanged &&
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
      previousModelKeyRef.current = currentModelKey
    }
  }, [model, updateAssistantSettings])

  return {
    assistant: assistantWithModel,
    model,
    addTopic: (topic: Topic) => dispatch(addTopic({ assistantId: assistant.id, topic })),
    removeTopic: async (topic: Topic) => {
      // Phase 5.2B: ordinary-chat soft delete goes through SQLite (LOCK-521/524).
      // The mutation must succeed before the Redux mutation runs (LOCK-528).
      await softDeleteOrdinaryTopic(topic.id, topic.name)
      dispatch(removeTopic({ assistantId: assistant.id, topic }))
    },
    restoreTopic: async (topicId: string) => {
      // Ordinary restore is ONE atomic Main command that returns the
      // restored row (LOCK-532); Redux is updated only with that returned
      // row after the mutation succeeded (LOCK-528).
      const restoredTopic = await restoreOrdinaryTopic(topicId)
      if (restoredTopic) {
        dispatch(addTopicFromTrash({ assistantId: assistant.id, topic: restoredTopic }))
      }
    },
    moveTopic: async (topic: Topic, toAssistant: Assistant) => {
      await dbService.transferTopicOwnership(topic.id, toAssistant.id)
      dispatch(addTopic({ assistantId: toAssistant.id, topic: { ...topic, assistantId: toAssistant.id } }))
      dispatch(removeTopic({ assistantId: assistant.id, topic }))
    },
    updateTopic: async (topic: Topic) => {
      // Phase 5.2B: persist metadata to SQLite before Redux mutation.
      // SQLite must succeed first (LOCK-528); a failed call throws and leaves
      // Redux unchanged.
      await persistTopicMetadata(topic)
      dispatch(updateTopic({ assistantId: assistant.id, topic }))
    },
    updateTopics: (topics: Topic[]) => dispatch(updateTopics({ assistantId: assistant.id, topics })),
    removeAllTopics: async () => {
      const requestedReplacement = getDefaultTopic(assistant.id)
      const { replacementTopic } = await resetOrdinaryAssistantTopics(assistant.id, requestedReplacement.id)
      dispatch(updateTopics({ assistantId: assistant.id, topics: [replacementTopic] }))
    },
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
