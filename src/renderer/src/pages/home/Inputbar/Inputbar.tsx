import { loggerService } from '@logger'
import { isAutoEnableImageGenerationModel, isGenerateImageModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useInputText } from '@renderer/hooks/useInputText'
import { useMessageOperations, useTopicLoading } from '@renderer/hooks/useMessageOperations'
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
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { CacheService } from '@renderer/services/CacheService'
import type { computeContextInfo } from '@renderer/services/contextInfoService'
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
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { audioExts, documentExts, imageExts, textExts, videoExts } from '@shared/config/constant'
import type { FC } from 'react'
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import TopicSegmentDrawer from '../Messages/TopicSegmentDrawer'
import { InputbarCore } from './components/InputbarCore'
import { useContextWindowAnchor } from './hooks/useContextWindowAnchor'
import { usePromptTokenEstimate } from './hooks/usePromptTokenEstimate'
import { useSendInFlightGuard } from './hooks/useSendInFlightGuard'
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
  /** Shared context projection computed once at Chat level (Phase 2B).
   *  Inputbar consumes tokenEstimationMessages and contextCount from this result. */
  sharedContextInfo: ReturnType<typeof computeContextInfo>
}

type ProviderActionHandlers = {
  resizeTextArea: () => void
  addNewTopic: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
}

interface InputbarInnerProps extends Props {
  actionsRef: React.RefObject<ProviderActionHandlers>
}

const Inputbar: FC<Props> = ({ assistant: initialAssistant, setActiveTopic, topic, sharedContextInfo }) => {
  const actionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    onTextChange: () => {}
  })

  const [initialMentionedModels] = useState(() => getValidatedCachedModels(initialAssistant.id))

  const initialState = useMemo(
    () => ({
      files: [] as FileMetadata[],
      mentionedModels: initialMentionedModels,
      selectedKnowledgeBases: initialAssistant.knowledge_bases ?? [],
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
        onTextChange: (updater) => actionsRef.current.onTextChange(updater)
      }}>
      <InputbarInner
        assistant={initialAssistant}
        setActiveTopic={setActiveTopic}
        topic={topic}
        sharedContextInfo={sharedContextInfo}
        actionsRef={actionsRef}
      />
    </InputbarToolsProvider>
  )
}

const InputbarInner: FC<InputbarInnerProps> = ({
  assistant: initialAssistant,
  setActiveTopic,
  topic,
  sharedContextInfo,
  actionsRef
}) => {
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
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 500,
    minHeight: 30
  })

  const { assistant, addTopic, model, setModel, updateAssistant, updateAssistantSettings } = useAssistant(
    initialAssistant.id
  )
  const { sendMessageShortcut, enableQuickPanelTriggers } = useSettings()

  const { t } = useTranslation()
  const { pauseMessages } = useMessageOperations(topic)
  const loading = useTopicLoading(topic)

  // --- Token estimation (Inputbar-owned) ---

  // The selected context window is computed by the unified pipeline (single
  // anchor-to-end mode). A pending draft is NOT part of the turn list, so it is
  // excluded from the context counts; draft tokens are estimated
  // separately on top of tokenEstimationMessages.
  // Phase 2B: This is now the shared projection computed once at Chat level.
  const previewContextInfo = sharedContextInfo

  // Async, debounced, race-safe estimate: selected history + current draft
  // (text + attachments) combined into one scalar.
  const estimateTokenCount = usePromptTokenEstimate({
    assistant,
    tokenEstimationMessages: previewContextInfo.tokenEstimationMessages,
    text,
    files
  })

  // contextCount from computeContextInfo: selected context turns / total turns
  // in the post-clear segment. A pending draft is excluded from both.
  const contextCount = previewContextInfo.contextCount

  const dispatch = useAppDispatch()
  const { runSend } = useSendInFlightGuard()
  const { setTimeoutTimer } = useTimer()
  // isEditMode removed: inputbar should remain visible in edit mode

  // Unit B: ordinary chat is user-intent driven. Attachment selection (images,
  // audio, video, documents, text) is never gated by vision metadata; the
  // endpoint/adapter matrix decides encodability at send time with explicit
  // failures.

  const canAddImageFile = useMemo(() => true, [])

  const supportedExts = useMemo(() => {
    return [...imageExts, ...audioExts, ...videoExts, ...documentExts, ...textExts]
  }, [])

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

  const sendMessage = useCallback(() => {
    // In-flight guard: a repeated activation while the first send is still
    // awaiting/preparing (rate-limit read, upload, usage estimate) returns
    // false without creating a second user message/request. `runSend`
    // acquires before the rate-limit await and releases in a `finally` on
    // every path (rate-limit block, validation early return, error, and
    // after dispatch initiation); the dispatch below is fire-and-forget so
    // the guard never spans the assistant streaming lifecycle.
    return runSend(async () => {
      if (await checkRateLimit(assistant, topic.id)) {
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
    })
  }, [
    runSend,
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
    // The estimated input token display has no user setting and is
    // always enabled under the existing program gates (scope supports a token
    // count and an estimate exists).
    if (!config.showTokenCount || estimateTokenCount === undefined) {
      return undefined
    }

    return {
      estimateTokenCount,
      contextCount
    }
  }, [config.showTokenCount, contextCount, estimateTokenCount])

  // Context-window anchor control (stable anchor semantics): the persisted
  // `contextWindowAnchor[topicId]` is the stable topic context start. The
  // Inputbar never derives or persists a window position except through the
  // explicit TokenCount re-anchor interaction, and never synchronizes anchors
  // to message loading or message-list changes — a transient empty topic on
  // startup cannot mutate a persisted anchor. The only Inputbar mutation is
  // re-anchor (TokenCount click): move the anchor to the CURRENT default
  // window position (current topic turns + current `contextCount`).
  const { onReanchor } = useContextWindowAnchor(assistant, topic.id, updateAssistantSettings)

  const onPause = useCallback(async () => {
    await pauseMessages()
  }, [pauseMessages])

  const addNewTopic = useCallback(async () => {
    const newTopic = getDefaultTopic(assistant.id)

    try {
      // The ordinary topic must exist in SQLite with its
      // assistantId before any Redux exposure (persistence first).
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

    // A new topic starts empty and anchorless (empty topics have no anchor,
    // docs/context-window.md I-1). The persisted anchor is established exactly
    // once when the first user message makes the topic non-empty, at the
    // default window position — it is never derived dynamically per render.

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

  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      addNewTopic,
      onTextChange: setText
    }
  }, [resizeTextArea, addNewTopic, setText, actionsRef])

  useShortcut(
    'new_topic',
    () => {
      void addNewTopic()
      void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
      focusTextarea()
    },
    { preventDefault: true, enableOnFormTags: true }
  )

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
    // Unit B: no model-name web-search auto-close. Built-in search availability
    // follows the current provider's explicit search adapter at request time
    // (missing adapter fails explicitly there); the user's toggle is preserved.
    // Clear web search provider if disabled
    if (assistant.webSearchProviderId && !WebSearchService.isWebSearchEnabled(assistant.webSearchProviderId)) {
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
          onReanchor={onReanchor}
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
