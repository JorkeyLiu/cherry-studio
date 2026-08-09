import { loggerService } from '@logger'
import {
  isAutoEnableImageGenerationModel,
  isGenerateImageModel,
  isGenerateImageModels,
  isMandatoryWebSearchModel,
  isVisionModel,
  isVisionModels,
  isWebSearchModel
} from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useInputText } from '@renderer/hooks/useInputText'
import { useMessageOperations, useTopicLoading, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { useTimer } from '@renderer/hooks/useTimer'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import { getAssistantSettings, getDefaultTopic } from '@renderer/services/AssistantService'
import { CacheService } from '@renderer/services/CacheService'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import { buildContextTurns } from '@renderer/services/contextTurnService'
import {
  getTurnAnchorGroupKey,
  resolveDefaultAnchorIndex,
  resolveDefaultAnchorPersistence
} from '@renderer/services/contextWindowService'
import { ensureOrdinaryTopicOwnership } from '@renderer/services/db/topicTrashLifecycle'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { checkRateLimit, getUserMessage } from '@renderer/services/MessagesService'
import { spanManagerService } from '@renderer/services/SpanManagerService'
import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import WebSearchService from '@renderer/services/WebSearchService'
import { useAppDispatch } from '@renderer/store'
import { sendMessage as _sendMessage } from '@renderer/store/thunk/messageThunk'
import {
  type Assistant,
  type FileMetadata,
  type KnowledgeBase,
  type Model,
  type Topic,
  TopicType
} from '@renderer/types'
import type { MessageInputBaseParams } from '@renderer/types/newMessage'
import { delay } from '@renderer/utils'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import type { FC } from 'react'
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import TopicSegmentDrawer from '../Messages/TopicSegmentDrawer'
import { InputbarCore } from './components/InputbarCore'
import { usePromptTokenEstimate } from './hooks/usePromptTokenEstimate'
import InputbarTools from './InputbarTools'
import KnowledgeBaseInput from './KnowledgeBaseInput'
import MentionModelsInput from './MentionModelsInput'
import { getInputbarConfig } from './registry'
import TokenCount from './TokenCount'

const logger = loggerService.withContext('Inputbar')

const INPUTBAR_DRAFT_CACHE_KEY = 'inputbar-draft'
const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

const getMentionedModelsCacheKey = (assistantId: string) => `inputbar-mentioned-models-${assistantId}`

const getValidatedCachedModels = (assistantId: string): Model[] => {
  const cached = CacheService.get<Model[]>(getMentionedModelsCacheKey(assistantId))
  if (!Array.isArray(cached)) return []
  return cached.filter((model) => model?.id && model?.name)
}

interface Props {
  assistant: Assistant
  setActiveTopic: (topic: Topic) => void
  topic: Topic
}

type ProviderActionHandlers = {
  resizeTextArea: () => void
  addNewTopic: () => void
  clearTopic: () => void
  onNewContext: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
  toggleExpanded: (nextState?: boolean) => void
}

interface InputbarInnerProps extends Props {
  actionsRef: React.RefObject<ProviderActionHandlers>
}

const Inputbar: FC<Props> = ({ assistant: initialAssistant, setActiveTopic, topic }) => {
  const actionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    clearTopic: () => {},
    onNewContext: () => {},
    onTextChange: () => {},
    toggleExpanded: () => {}
  })

  const [initialMentionedModels] = useState(() => getValidatedCachedModels(initialAssistant.id))

  const initialState = useMemo(
    () => ({
      files: [] as FileMetadata[],
      mentionedModels: initialMentionedModels,
      selectedKnowledgeBases: initialAssistant.knowledge_bases ?? [],
      isExpanded: false,
      couldAddImageFile: false,
      extensions: [] as string[]
    }),
    [initialMentionedModels, initialAssistant.knowledge_bases]
  )

  return (
    <InputbarToolsProvider
      initialState={initialState}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        addNewTopic: () => actionsRef.current.addNewTopic(),
        clearTopic: () => actionsRef.current.clearTopic(),
        onNewContext: () => actionsRef.current.onNewContext(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        toggleExpanded: (next) => actionsRef.current.toggleExpanded(next)
      }}>
      <InputbarInner
        assistant={initialAssistant}
        setActiveTopic={setActiveTopic}
        topic={topic}
        actionsRef={actionsRef}
      />
    </InputbarToolsProvider>
  )
}

const InputbarInner: FC<InputbarInnerProps> = ({ assistant: initialAssistant, setActiveTopic, topic, actionsRef }) => {
  const scope = topic.type ?? TopicType.Chat
  const config = getInputbarConfig(scope)

  const { files, mentionedModels, selectedKnowledgeBases } = useInputbarToolsState()
  const { setFiles, setMentionedModels, setSelectedKnowledgeBases } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const { text, setText } = useInputText({
    initialValue: CacheService.get<string>(INPUTBAR_DRAFT_CACHE_KEY) ?? '',
    onChange: (value) => CacheService.set(INPUTBAR_DRAFT_CACHE_KEY, value, DRAFT_CACHE_TTL)
  })
  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    isExpanded: textareaIsExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 500,
    minHeight: 30
  })

  const { assistant, addTopic, model, setModel, updateAssistant, updateAssistantSettings } = useAssistant(
    initialAssistant.id
  )
  const { sendMessageShortcut, showInputEstimatedTokens, enableQuickPanelTriggers } = useSettings()

  const { t } = useTranslation()
  const { pauseMessages } = useMessageOperations(topic)
  const topicMessages = useTopicMessages(topic.id)
  const loading = useTopicLoading(topic)

  // --- Token estimation (Inputbar-owned) ---

  // The selected context window is computed by the unified pipeline (single
  // anchor-to-end mode). A pending draft is NOT part of the turn list, so it is
  // excluded from the context counts (LOCK-CTX-5); draft tokens are estimated
  // separately on top of tokenEstimationMessages.
  const previewContextInfo = useMemo(
    () => computeContextInfo(topicMessages, assistant, topic.id),
    [topicMessages, assistant, topic.id]
  )

  // Async, debounced, race-safe estimate: selected history + current draft
  // (text + attachments) combined into one scalar (LOCK-001, LOCK-005, LOCK-009).
  const estimateTokenCount = usePromptTokenEstimate({
    assistant,
    tokenEstimationMessages: previewContextInfo.tokenEstimationMessages,
    text,
    files
  })

  // contextCount from computeContextInfo: selected context turns / total turns
  // in the post-clear segment. A pending draft is excluded from both (LOCK-CTX-5).
  const contextCount = previewContextInfo.contextCount

  const dispatch = useAppDispatch()
  const isVisionAssistant = useMemo(() => isVisionModel(model), [model])
  const isGenerateImageAssistant = useMemo(() => isGenerateImageModel(model), [model])
  const { setTimeoutTimer } = useTimer()
  // isEditMode removed: inputbar should remain visible in edit mode

  const isVisionSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isVisionModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isVisionAssistant),
    [mentionedModels, isVisionAssistant]
  )

  const isGenerateImageSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isGenerateImageModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isGenerateImageAssistant),
    [mentionedModels, isGenerateImageAssistant]
  )

  const canAddImageFile = useMemo(() => {
    return isVisionSupported || isGenerateImageSupported
  }, [isGenerateImageSupported, isVisionSupported])

  const canAddTextFile = useMemo(() => {
    return isVisionSupported || (!isVisionSupported && !isGenerateImageSupported)
  }, [isGenerateImageSupported, isVisionSupported])

  const supportedExts = useMemo(() => {
    if (canAddImageFile && canAddTextFile) {
      return [...imageExts, ...documentExts, ...textExts]
    }

    if (canAddImageFile) {
      return [...imageExts]
    }

    if (canAddTextFile) {
      return [...documentExts, ...textExts]
    }

    return []
  }, [canAddImageFile, canAddTextFile])

  useEffect(() => {
    setCouldAddImageFile(canAddImageFile)
  }, [canAddImageFile, setCouldAddImageFile])

  const onUnmount = useEffectEvent((id: string) => {
    CacheService.set(getMentionedModelsCacheKey(id), mentionedModels, DRAFT_CACHE_TTL)
  })

  useEffect(() => {
    return () => onUnmount(assistant.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.id])

  const placeholderText = enableQuickPanelTriggers
    ? t('chat.input.placeholder', { key: getSendMessageShortcutLabel(sendMessageShortcut) })
    : t('chat.input.placeholder_without_triggers', {
        key: getSendMessageShortcutLabel(sendMessageShortcut),
        defaultValue: t('chat.input.placeholder', {
          key: getSendMessageShortcutLabel(sendMessageShortcut)
        })
      })

  const sendMessage = useCallback(async () => {
    if (checkRateLimit(assistant)) {
      return
    }

    logger.info('Starting to send message')

    const parent = spanManagerService.startTrace(
      { topicId: topic.id, name: 'sendMessage', inputs: text },
      mentionedModels.length > 0 ? mentionedModels : assistant.model ? [assistant.model] : []
    )
    void EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: topic.id, traceId: parent?.spanContext().traceId })

    try {
      const uploadedFiles = await FileManager.uploadFiles(files)

      const baseUserMessage: MessageInputBaseParams = { assistant, topic, content: text }
      if (uploadedFiles) {
        baseUserMessage.files = uploadedFiles
      }
      if (mentionedModels.length) {
        baseUserMessage.mentions = mentionedModels
      }

      baseUserMessage.usage = await estimateUserPromptUsage(baseUserMessage)

      const { message, blocks } = getUserMessage(baseUserMessage)
      message.traceId = parent?.spanContext().traceId

      void dispatch(_sendMessage(message, blocks, assistant, topic.id))

      setText('')
      setFiles([])
      setTimeoutTimer('sendMessage_1', () => setText(''), 500)
      setTimeoutTimer('sendMessage_2', () => resizeTextArea(), 0)
      // Restore focus to textarea after sending to maintain IME state (fcitx5 issue)
      focusTextarea()
    } catch (error) {
      logger.warn('Failed to send message:', error as Error)
      parent?.recordException(error as Error)
    }
  }, [
    assistant,
    topic,
    text,
    mentionedModels,
    files,
    dispatch,
    setText,
    setFiles,
    setTimeoutTimer,
    resizeTextArea,
    focusTextarea
  ])

  const tokenCountProps = useMemo(() => {
    if (!config.showTokenCount || estimateTokenCount === undefined || !showInputEstimatedTokens) {
      return undefined
    }

    return {
      estimateTokenCount,
      contextCount
    }
  }, [config.showTokenCount, contextCount, estimateTokenCount, showInputEstimatedTokens])

  // Default-anchor persistence (LOCK-CTX-2, LOCK-CTX-4, LOCK-FIX-3).
  // When no valid anchor exists for the topic, derive the window start from the
  // assistant's default context count and persist it as the anchor — finite N
  // selects the most recent N turns, unlimited selects the first turn of the
  // post-clear segment. This keeps the derived start stable as the topic grows,
  // and ensures clearing a manual anchor restores the default window rather
  // than full history. The pure compute layer applies the identical fallback,
  // so full history is never transiently sent even before this write lands.
  // When the post-clear segment has zero turns there is nothing to anchor, so
  // any stale persisted anchor is removed (matching TokenCount reset behavior);
  // the pure decision helper returns 'delete' only when an anchor actually
  // exists, so this effect dispatches at most once and cannot loop.
  useEffect(() => {
    const settings = getAssistantSettings(assistant)
    const decision = resolveDefaultAnchorPersistence(
      buildContextTurns(topicMessages),
      settings.contextCount,
      settings.contextWindowAnchor?.[topic.id]
    )
    if (decision.type === 'none') {
      return
    }

    const anchors = { ...settings.contextWindowAnchor }
    if (decision.type === 'delete') {
      delete anchors[topic.id]
    } else {
      anchors[topic.id] = decision.anchor
    }
    updateAssistantSettings({ contextWindowAnchor: anchors })
  }, [topicMessages, assistant, topic.id, updateAssistantSettings])

  // TokenCount click (LOCK-CTX-3): recompute and persist the default start.
  // Finite N selects the most recent N turns; null (unlimited) selects the
  // first turn of the current post-clear context segment. An empty topic clears
  // any stale anchor (there is nothing to anchor).
  const onUpdateAnchor = useCallback(() => {
    const settings = getAssistantSettings(assistant)
    const turns = buildContextTurns(topicMessages)

    const anchors = { ...settings.contextWindowAnchor }
    if (turns.length === 0) {
      delete anchors[topic.id]
      updateAssistantSettings({ contextWindowAnchor: anchors })
      return
    }

    const derivedIndex = resolveDefaultAnchorIndex(turns, settings.contextCount)
    if (derivedIndex < 0) {
      return
    }
    const groupKey = getTurnAnchorGroupKey(turns[derivedIndex])
    if (!groupKey) {
      return
    }

    anchors[topic.id] = { kind: 'active', groupKey }
    updateAssistantSettings({ contextWindowAnchor: anchors })
  }, [assistant, topic.id, topicMessages, updateAssistantSettings])

  const onPause = useCallback(async () => {
    await pauseMessages()
  }, [pauseMessages])

  const clearTopic = useCallback(async () => {
    if (loading) {
      await onPause()
      await delay(1)
    }

    void EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES, topic)
    focusTextarea()
  }, [focusTextarea, loading, onPause, topic])

  const onNewContext = useCallback(() => {
    if (loading) {
      void onPause()
      return
    }
    void EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }, [loading, onPause])

  const addNewTopic = useCallback(async () => {
    const newTopic = getDefaultTopic(assistant.id)

    try {
      // LOCK-533: the ordinary topic must exist in SQLite with its
      // assistantId before any Redux exposure (LOCK-528: persistence first).
      await ensureOrdinaryTopicOwnership(newTopic.id, assistant.id, newTopic.name)
    } catch (error) {
      logger.error('Failed to establish SQLite ownership for new topic', error as Error)
      return
    }

    if (assistant.defaultModel) {
      setModel(assistant.defaultModel)
    }

    addTopic(newTopic)
    setActiveTopic(newTopic)

    // The new topic has no anchor yet; the default-anchor persistence effect
    // derives one from the assistant's default context count when the first
    // message arrives (LOCK-CTX-2).

    setTimeoutTimer('addNewTopic', () => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
  }, [addTopic, assistant, setActiveTopic, setModel, setTimeoutTimer])

  const handleRemoveModel = useCallback(
    (modelToRemove: Model) => {
      setMentionedModels(mentionedModels.filter((current) => current.id !== modelToRemove.id))
    },
    [mentionedModels, setMentionedModels]
  )

  const handleRemoveKnowledgeBase = useCallback(
    (knowledgeBase: KnowledgeBase) => {
      const nextKnowledgeBases = assistant.knowledge_bases?.filter((kb) => kb.id !== knowledgeBase.id)
      updateAssistant({ ...assistant, knowledge_bases: nextKnowledgeBases })
      setSelectedKnowledgeBases(nextKnowledgeBases ?? [])
    },
    [assistant, setSelectedKnowledgeBases, updateAssistant]
  )

  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !textareaIsExpanded
      setExpanded(target)
      focusTextarea()
    },
    [focusTextarea, setExpanded, textareaIsExpanded]
  )

  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      addNewTopic,
      clearTopic,
      onNewContext,
      onTextChange: setText,
      toggleExpanded: handleToggleExpanded
    }
  }, [resizeTextArea, addNewTopic, clearTopic, onNewContext, setText, handleToggleExpanded, actionsRef])

  useShortcut(
    'new_topic',
    () => {
      void addNewTopic()
      void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
      focusTextarea()
    },
    { preventDefault: true, enableOnFormTags: true }
  )

  useShortcut('clear_topic', clearTopic, {
    preventDefault: true,
    enableOnFormTags: true
  })

  useEffect(() => {
    const unsubscribes = [EventEmitter.on(EVENT_NAMES.ADD_NEW_TOPIC, addNewTopic)]

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [addNewTopic])

  useEffect(() => {
    if (!document.querySelector('.topview-fullscreen-container')) {
      focusTextarea()
    }
  }, [
    topic.id,
    assistant.mcpServers,
    assistant.knowledge_bases,
    assistant.enableWebSearch,
    assistant.webSearchProviderId,
    mentionedModels,
    focusTextarea
  ])

  // TODO: Just use assistant.knowledge_bases as selectedKnowledgeBases. context state is overdesigned.
  useEffect(() => {
    setSelectedKnowledgeBases(assistant.knowledge_bases ?? [])
  }, [assistant.knowledge_bases, setSelectedKnowledgeBases])

  useEffect(() => {
    // Disable web search if model doesn't support it
    if (!isWebSearchModel(model) && assistant.enableWebSearch) {
      updateAssistant({ ...assistant, enableWebSearch: false })
    }

    // Clear web search provider if disabled or model has mandatory search
    if (
      assistant.webSearchProviderId &&
      (!WebSearchService.isWebSearchEnabled(assistant.webSearchProviderId) || isMandatoryWebSearchModel(model))
    ) {
      updateAssistant({ ...assistant, webSearchProviderId: undefined })
    }

    // Auto-enable/disable image generation based on model capabilities
    if (isGenerateImageModel(model)) {
      if (isAutoEnableImageGenerationModel(model) && !assistant.enableGenerateImage) {
        updateAssistant({ ...assistant, enableGenerateImage: true })
      }
    } else if (assistant.enableGenerateImage) {
      updateAssistant({ ...assistant, enableGenerateImage: false })
    }
  }, [assistant, model, updateAssistant])

  // topContent: 所有顶部预览内容
  const topContent = (
    <>
      {selectedKnowledgeBases.length > 0 && (
        <KnowledgeBaseInput
          selectedKnowledgeBases={selectedKnowledgeBases}
          onRemoveKnowledgeBase={handleRemoveKnowledgeBase}
        />
      )}

      {mentionedModels.length > 0 && (
        <MentionModelsInput selectedModels={mentionedModels} onRemoveModel={handleRemoveModel} />
      )}
    </>
  )

  // leftToolbar: 左侧工具栏
  const leftToolbar = config.showTools ? <InputbarTools scope={scope} assistant={assistant} model={model} /> : null

  // rightToolbar: 右侧工具栏
  const rightToolbar = (
    <>
      {tokenCountProps && (
        <TokenCount
          estimateTokenCount={tokenCountProps.estimateTokenCount}
          contextCount={tokenCountProps.contextCount}
          onUpdateAnchor={onUpdateAnchor}
          onClick={onNewContext}
        />
      )}
    </>
  )

  return (
    <InputbarCore
      scope={scope}
      placeholder={placeholderText}
      text={text}
      onTextChange={setText}
      textareaRef={textareaRef}
      height={customHeight}
      onHeightChange={setCustomHeight}
      resizeTextArea={resizeTextArea}
      focusTextarea={focusTextarea}
      isLoading={loading}
      supportedExts={supportedExts}
      onPause={onPause}
      handleSendMessage={sendMessage}
      leftToolbar={leftToolbar}
      rightToolbar={rightToolbar}
      topContent={topContent}
      topRightOverlay={<TopicSegmentDrawer topicId={topic.id} />}
    />
  )
}

export default Inputbar
