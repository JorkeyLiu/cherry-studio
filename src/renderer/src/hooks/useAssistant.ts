import { loggerService } from '@logger'
import { type AssistantDefaults, getDefaultTopic } from '@renderer/services/assistantDefaults'
import { dbService } from '@renderer/services/db'
import { persistTopicMetadata } from '@renderer/services/db/topicMetadataPersist'
import {
  ensureOrdinaryTopicOwnership,
  resetOrdinaryAssistantTopics,
  restoreOrdinaryTopic,
  softDeleteOrdinaryTopic
} from '@renderer/services/db/topicTrashLifecycle'
import type { RootState } from '@renderer/store'
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
  updateAssistantDefaults,
  updateAssistants,
  updateAssistantSettings as _updateAssistantSettings,
  updateTopic,
  updateTopics
} from '@renderer/store/assistants'
import { setDefaultModel, setQuickModel, setTranslateModel } from '@renderer/store/llm'
import { activeBranchReset } from '@renderer/store/topicBranch'
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

  // Per-model independent memory: leave-saves, enter-restores.
  // - Leaving a model saves its explicit non-default active effort (none/low/medium/high/xhigh/auto/minimal etc.) into reasoning_effort_by_model[prevKey]; placeholder 'default' is never written by leave-save (target without history still restores 'default'; ThinkingButton explicit 'default' keeps its own write).
  // - Entering a model restores reasoning_effort_by_model[currKey] if present, else app default 'default'.
  // - Never gate/degrade by model capability (lazy request principle); keep qwenThinkMode/cache consistent.
  // - Avoid effect loops via settingsRef and dispatch only when map or effort actually changes.
  useEffect(() => {
    if (!model) return
    const settings = settingsRef.current
    if (!settings) return
    const rawEffort = settings.reasoning_effort as string | undefined
    const currentReasoningEffort = rawEffort ?? 'default'
    const currentModelKey = getModelReasoningEffortKey(model)
    const previousModelKey = previousModelKeyRef.current
    const isModelChanged = previousModelKey !== undefined && previousModelKey !== currentModelKey
    if (!isModelChanged) {
      previousModelKeyRef.current = currentModelKey
      return
    }
    const previousMap = settings.reasoning_effort_by_model ?? {}
    const nextByModel: Record<string, string> = { ...previousMap }
    let mapChanged = false
    if (previousModelKey && rawEffort && rawEffort !== 'default') {
      if (nextByModel[previousModelKey] !== rawEffort) {
        nextByModel[previousModelKey] = rawEffort as any
        mapChanged = true
      }
    }
    const targetEffort = currentModelKey && nextByModel[currentModelKey] ? nextByModel[currentModelKey] : 'default'
    const effortChanged = targetEffort !== currentReasoningEffort
    if (!effortChanged && !mapChanged) {
      previousModelKeyRef.current = currentModelKey
      return
    }
    updateAssistantSettings({
      reasoning_effort: targetEffort as any,
      reasoning_effort_by_model: nextByModel as any,
      reasoning_effort_cache: targetEffort as any,
      qwenThinkMode: targetEffort !== 'none' && targetEffort !== 'default'
    })
    previousModelKeyRef.current = currentModelKey
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
      // Trash keeps the branch catalog (restore resumes it) but resets the
      // active route to main.
      dispatch(activeBranchReset({ topicId: topic.id }))
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

/**
 * Message-presentation assistant configuration: every Assistant field
 * EXCEPT `topics`.
 *
 * History MessageItems must not subscribe to `assistant.topics` (or the
 * topic `updatedAt` that rides it): every ordinary send bumps exactly one
 * topic's `updatedAt` through `updateTopicUpdatedAt`, and the Immer nested
 * draft assign produces a new topic -> topics array -> assistant reference,
 * so the whole-assistant subscription in `useAssistant` invalidates EVERY
 * mounted history message on every send. This projection carries only the
 * configuration message presentation actually reads (name/avatar identity,
 * prompt, settings, model/defaultModel, custom parameters); it never
 * carries topic membership, so a topic-only store change cannot invalidate
 * it.
 *
 * Contract: consumers must never read `.topics` from this value (it is
 * absent by type). Sidebar/topic management keep using `useAssistant`,
 * whose full topic behavior is unchanged.
 */
export type MessageAssistantConfig = Omit<Assistant, 'topics'>

/** Shared stable empty topics for the honest Assistant-typed adapter below. */
const EMPTY_MESSAGE_ASSISTANT_TOPICS: Topic[] = []

/**
 * Adapter for Assistant-typed readers that never consume topics
 * (`getAssistantSettings`, mention-model append). It explicitly attaches the
 * shared empty array instead of casting, so the "no topics" contract stays
 * visible at every call site.
 */
export function withEmptyTopics(config: MessageAssistantConfig): Assistant {
  return { ...config, topics: EMPTY_MESSAGE_ASSISTANT_TOPICS }
}

/** Configuration field-identity equality, ignoring `topics` (absent by type). */
export function isMessageAssistantConfigEqual(
  a: MessageAssistantConfig | undefined,
  b: MessageAssistantConfig | undefined
): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  for (const key of keysA) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

function selectMessageAssistantConfig(state: RootState, id: string): MessageAssistantConfig | undefined {
  const found = state.assistants.assistants.find((assistant) => assistant.id === id)
  if (!found) return undefined
  const { topics: _ignoredTopics, ...config } = found
  return config
}

function selectMessageAssistantModel(state: RootState, id: string): Model | undefined {
  const found = state.assistants.assistants.find((assistant) => assistant.id === id)
  return found?.model ?? found?.defaultModel ?? state.llm.defaultModel
}

/**
 * Narrow assistant subscription for message presentation (MessageItem and
 * its header/menubar). Subscribes only to the per-assistant configuration
 * plus the global default-model fallback -- never to `topics`, never to
 * quick/translate models or provider churn.
 *
 * Deliberately NOT running the per-model reasoning-effort leave-save /
 * enter-restore effect from `useAssistant`: presentation must never write
 * settings. That ownership stays with the controllers (`useAssistant`
 * consumers such as Inputbar/ThinkingButton), which keep a single effect
 * instance instead of one per mounted message.
 */
export function useMessageAssistant(id: string) {
  const selectConfig = useMemo(() => (state: RootState) => selectMessageAssistantConfig(state, id), [id])
  const assistant = useAppSelector(selectConfig, isMessageAssistantConfigEqual)
  // Resolved-model subscription with the identical fallback chain
  // (assistant.model -> assistant.defaultModel -> global defaultModel):
  // selecting the resolved value (not each input) means a pinned assistant
  // model ignores global default-model churn, while the fallback follows it.
  const selectModelForId = useMemo(() => (state: RootState) => selectMessageAssistantModel(state, id), [id])
  const model = useAppSelector(selectModelForId)
  const dispatch = useAppDispatch()

  const assistantWithModel = useMemo(() => {
    if (!assistant) return undefined
    if (Object.is(assistant.model, model)) return assistant
    return { ...assistant, model }
  }, [assistant, model])

  return {
    assistant: assistantWithModel,
    model,
    setModel: useCallback(
      (nextModel: Model) => {
        if (id) dispatch(setModel({ assistantId: id, model: nextModel }))
      },
      [dispatch, id]
    ),
    updateAssistantSettings: useCallback(
      (settings: Partial<AssistantSettings>) => {
        if (id) dispatch(_updateAssistantSettings({ assistantId: id, settings }))
      },
      [dispatch, id]
    )
  }
}

/**
 * Dispatcher-only assistant-settings updater for consumers that already hold
 * the configuration (e.g. MessageMenubar receives it as a prop): stable
 * id-captured callback with no entity subscription of its own.
 */
export function useAssistantSettingsUpdater(id: string | undefined) {
  const dispatch = useAppDispatch()
  return useCallback(
    (settings: Partial<AssistantSettings>) => {
      if (id) dispatch(_updateAssistantSettings({ assistantId: id, settings }))
    },
    [dispatch, id]
  )
}

export function useAssistantDefaults() {
  const assistantDefaults = useAppSelector((state) => state.assistants.assistantDefaults)
  const dispatch = useAppDispatch()

  const updateAssistantDefaultsSettings = useCallback(
    (defaults: Partial<AssistantDefaults>) => dispatch(updateAssistantDefaults(defaults)),
    [dispatch]
  )

  return {
    assistantDefaults,
    updateAssistantDefaults: updateAssistantDefaultsSettings
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
