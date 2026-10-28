import { loggerService } from '@logger'
import AddButton from '@renderer/components/AddButton'
import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import type { DraggableVirtualListRef } from '@renderer/components/DraggableList'
import { DraggableVirtualList } from '@renderer/components/DraggableList'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import SaveToKnowledgePopup from '@renderer/components/Popups/SaveToKnowledgePopup'
import { isMac } from '@renderer/config/constant'
import { useAssistant, useAssistants } from '@renderer/hooks/useAssistant'
import { useInPlaceEdit } from '@renderer/hooks/useInPlaceEdit'
import { useNotesSettings } from '@renderer/hooks/useNotesSettings'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { finishTopicRenaming, startTopicRenaming } from '@renderer/hooks/useTopic'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { dbService } from '@renderer/services/db'
import {
  emptyOrdinaryTrash,
  ensureOrdinaryTopicOwnership,
  hardDeleteOrdinaryTopic,
  purgeExpiredOrdinaryTopics,
  restoreOrdinaryTopic
} from '@renderer/services/db/topicTrashLifecycle'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { exportTopicDataToFile, importTopicDataFromFile } from '@renderer/services/topicDataJson'
import type { RootState } from '@renderer/store'
import store from '@renderer/store'
import { updateTopic as updateTopicAction } from '@renderer/store/assistants'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Assistant, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { classNames } from '@renderer/utils'
import { exportTopicAsMarkdown, exportTopicToNotes } from '@renderer/utils/export'
import { createSnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { reorderTopicsForPin, sortTopicsPinnedFirst } from '@renderer/utils/sort'
import type { MenuProps } from 'antd'
import { Dropdown, Tooltip } from 'antd'
import type { ItemType, MenuItemType } from 'antd/es/menu/interface'
import dayjs from 'dayjs'
import { findIndex } from 'lodash'
import {
  CheckSquare,
  FileDown,
  FolderOutput,
  ListTodo,
  NotebookPen,
  PinIcon,
  PinOffIcon,
  Save,
  Sparkles,
  Square,
  SquareArrowOutUpLeft,
  XIcon
} from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDispatch, useSelector } from 'react-redux'
import styled from 'styled-components'

import { deleteTopicFlow } from './topicDeletionFlow'

// Local book-search icon: exact official lucide `book-search` nodes.
// Installed lucide-react@0.525.0 has no BookSearch export (verified
// `typeof BookSearch === 'undefined'`), so this local SVG carries the
// requested shape without a dependency upgrade.
function BookSearchIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lucide lucide-book-search">
      <path d="M11 22H5.5a1 1 0 0 1 0-5h4.501" />
      <path d="m21 22-1.879-1.878" />
      <path d="M3 19.5v-15A2.5 2.5 0 0 1 5.5 2H18a1 1 0 0 1 1 1v8" />
      <circle cx="17" cy="18" r="3" />
    </svg>
  )
}
import { TopicManagePanel, useTopicManageMode } from './TopicManageMode'
import { TopicTrashPanel } from './TopicTrashPanel'

interface Props {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
}

// Manual Auto Rename projection guard (bounded same-name collision fix).
// Main returns the current wire unchanged on preimage mismatch (graceful
// no-op). A name-only `wire.name === summaryText` check is insufficient: an
// intervening manual rename to exactly `summaryText` no-ops atomically but
// still matches by name. The projection must therefore require the
// authoritative returned flag to equal the requested `false`; any other flag
// (true/null/undefined) means the automatic write did not win and the Redux
// projection — including a manual `true` flag — must be left untouched.
// Returns the projected Topic on authoritative success, otherwise null.
export function resolveManualAutoRenameProjection(
  wire: { name?: string | null; isNameManuallyEdited?: boolean | null },
  summaryText: string,
  latest: Topic
): Topic | null {
  if (wire.name !== summaryText) {
    return null
  }
  if (wire.isNameManuallyEdited !== false) {
    return null
  }
  return {
    ...latest,
    name: wire.name ?? summaryText,
    isNameManuallyEdited: wire.isNameManuallyEdited ?? false
  } as Topic
}

// Header + manage-mode topic filter: case-insensitive, space-separated
// keywords (all must match). Shared by the ordinary list and multi-select so
// a single header search filters both without a dual bottom search UI.
export function filterTopicsBySearch<T extends { name: string }>(topics: T[], searchText: string): T[] {
  if (!searchText.trim()) {
    return topics
  }
  // Split by spaces and filter out empty strings
  const keywords = searchText
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 0)
  if (keywords.length === 0) {
    return topics
  }
  // All keywords must match (AND logic)
  return topics.filter((topic) => {
    const lowerName = topic.name.toLowerCase()
    return keywords.every((keyword) => lowerName.includes(keyword))
  })
}

// LOCK-002: topics always render on the right; topic time is always shown and
// pinned topics always sort/stay at the top.
export const Topics: React.FC<Props> = ({ assistant: _assistant, activeTopic, setActiveTopic }) => {
  const { t } = useTranslation()
  const { notesPath } = useNotesSettings()
  const { assistants } = useAssistants()
  const { assistant, addTopic, removeTopic, moveTopic, updateTopic, updateTopics } = useAssistant(_assistant.id)

  const logger = useMemo(() => loggerService.withContext('Topics'), [])

  const renamingTopics = useSelector((state: RootState) => state.runtime.chat.renamingTopics)
  const topicLoadingQuery = useSelector((state: RootState) => state.messages.loadingByTopic)
  const topicFulfilledQuery = useSelector((state: RootState) => state.messages.fulfilledByTopic)
  const newlyRenamedTopics = useSelector((state: RootState) => state.runtime.chat.newlyRenamedTopics)

  const borderRadius = 12

  const [deletingTopicId, setDeletingTopicId] = useState<string | null>(null)
  const deleteTimerRef = useRef<NodeJS.Timeout>(null)
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null)
  const [trashRefreshVersion, setTrashRefreshVersion] = useState(0)
  const listRef = useRef<DraggableVirtualListRef>(null)

  // 管理模式状态 (searchText is shared: header search filters both the
  // ordinary list and multi-select; no separate bottom search state)
  const manageState = useTopicManageMode()
  const { isManageMode, selectedIds, searchText, setSearchText, enterManageMode, exitManageMode, toggleSelectTopic } =
    manageState

  // Header search: replaces New Topic + search button with a focused input.
  // Live-filters on change (Enter not required); Escape/X closes + clears.
  const [isHeaderSearchOpen, setIsHeaderSearchOpen] = useState(false)
  const headerSearchInputRef = useRef<HTMLInputElement>(null)
  const openHeaderSearch = useCallback(() => {
    setIsHeaderSearchOpen(true)
  }, [])
  const closeHeaderSearch = useCallback(() => {
    setIsHeaderSearchOpen(false)
    setSearchText('')
  }, [setSearchText])

  useEffect(() => {
    if (isHeaderSearchOpen) {
      headerSearchInputRef.current?.focus()
    }
  }, [isHeaderSearchOpen])

  const { startEdit, isEditing, inputProps } = useInPlaceEdit({
    onSave: async (name: string) => {
      const topic = assistant.topics.find((t) => t.id === editingTopicId)
      if (topic && name !== topic.name) {
        const updatedTopic = { ...topic, name, isNameManuallyEdited: true }
        try {
          // Phase 5.2B: SQLite persists before Redux (LOCK-528). On failure the
          // optimistic edit is dropped and Redux is left unchanged.
          await updateTopic(updatedTopic)
          window.toast.success(t('common.saved'))
        } catch (error) {
          logger.error('Failed to persist topic rename', error as Error)
        }
      }
      setEditingTopicId(null)
    },
    onCancel: () => {
      setEditingTopicId(null)
    }
  })

  const isPending = useCallback((topicId: string) => topicLoadingQuery[topicId], [topicLoadingQuery])
  const isFulfilled = useCallback((topicId: string) => topicFulfilledQuery[topicId], [topicFulfilledQuery])
  const dispatch = useDispatch()
  const refreshTrashTopics = useCallback(() => {
    setTrashRefreshVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    dispatch(newMessagesActions.setTopicFulfilled({ topicId: activeTopic.id, fulfilled: false }))
  }, [activeTopic.id, dispatch, topicFulfilledQuery])

  // Purge expired trash topics on first mount
  useEffect(() => {
    // Phase 5.2B: ordinary-chat purge runs against SQLite with a renderer
    // generated strict ISO cutoff (LOCK-523).
    purgeExpiredOrdinaryTopics().catch((err) => logger.error('Failed to purge expired ordinary topics:', err))
  }, [logger])

  const isRenaming = useCallback(
    (topicId: string) => {
      return renamingTopics.includes(topicId)
    },
    [renamingTopics]
  )

  const isNewlyRenamed = useCallback(
    (topicId: string) => {
      return newlyRenamedTopics.includes(topicId)
    },
    [newlyRenamedTopics]
  )

  const handleDeleteClick = useCallback((topicId: string, e: React.MouseEvent) => {
    e.stopPropagation()

    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current)
    }

    setDeletingTopicId(topicId)

    deleteTimerRef.current = setTimeout(() => setDeletingTopicId(null), 2000)
  }, [])

  const handleRestoreTopic = useCallback(
    async (topicId: string) => {
      // LOCK-532: one atomic Main command returns the restored row; only
      // that returned row is exposed to Redux (never a stale snapshot).
      const restoredTopic = await restoreOrdinaryTopic(topicId)
      if (restoredTopic) {
        addTopic(restoredTopic)
      }
      refreshTrashTopics()
    },
    [addTopic, refreshTrashTopics]
  )

  const createPersistedReplacement = useCallback(async () => {
    const newTopic = getDefaultTopic(assistant.id)
    // LOCK-533: SQLite assistant ownership first.
    await ensureOrdinaryTopicOwnership(newTopic.id, assistant.id, newTopic.name)
    return newTopic
  }, [assistant.id])

  const handleConfirmDelete = useCallback(
    async (topic: Topic, e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        // Phase 5.2B: soft delete persists BEFORE the active-topic switch or
        // replacement exposure (LOCK-528). A failed delete leaves the UI as-is.
        await deleteTopicFlow({
          topic,
          topics: assistant.topics,
          activeTopicId: activeTopic.id,
          deps: {
            modelGenerating,
            removeTopic,
            addTopic,
            setActiveTopic,
            createPersistedReplacement
          }
        })
        refreshTrashTopics()
      } catch (error) {
        logger.error('Failed to delete topic', error as Error)
      } finally {
        setDeletingTopicId(null)
      }
    },
    [
      activeTopic.id,
      addTopic,
      assistant.topics,
      createPersistedReplacement,
      logger,
      removeTopic,
      setActiveTopic,
      refreshTrashTopics
    ]
  )

  const onPinTopic = useCallback(
    async (topic: Topic) => {
      const updatedTopic = { ...topic, pinned: !topic.pinned }

      // Phase 5.2B: persist metadata to SQLite before Redux mutation (LOCK-528).
      // On failure the optimistic pin is dropped and Redux is left unchanged.
      try {
        await updateTopic(updatedTopic)
      } catch (error) {
        logger.error('Failed to persist topic pin', error as Error)
        return
      }

      // LOCK-002: pinned topics always sort/stay at the top. Reorder uses the
      // already updated topic so the Redux state stays convergent with the pin.
      // The updated topic is excluded from the stale source groups, so it can
      // never appear twice in the reordered list.
      const reorderedTopics = reorderTopicsForPin(assistant.topics, updatedTopic)
      updateTopics(reorderedTopics)

      // 延迟滚动到话题位置（等待渲染完成）
      const newIndex = reorderedTopics.findIndex((t) => t.id === updatedTopic.id)
      setTimeout(() => {
        listRef.current?.scrollToIndex(newIndex, { align: 'auto' })
      }, 50)
    },
    [assistant.topics, logger, updateTopic, updateTopics]
  )

  const onDeleteTopic = useCallback(
    async (topic: Topic) => {
      try {
        // Phase 5.2B: soft delete persists BEFORE the active-topic switch
        // (LOCK-528). A failed delete leaves the UI as-is.
        await deleteTopicFlow({
          topic,
          topics: assistant.topics,
          activeTopicId: activeTopic?.id,
          deps: {
            modelGenerating,
            removeTopic,
            addTopic,
            setActiveTopic,
            createPersistedReplacement
          }
        })
        refreshTrashTopics()
      } catch (error) {
        logger.error('Failed to delete topic', error as Error)
      }
    },
    [
      addTopic,
      assistant.topics,
      createPersistedReplacement,
      logger,
      removeTopic,
      setActiveTopic,
      activeTopic,
      refreshTrashTopics
    ]
  )

  const onMoveTopic = useCallback(
    async (topic: Topic, toAssistant: Assistant) => {
      await modelGenerating()
      const index = findIndex(assistant.topics, (t) => t.id === topic.id)
      setActiveTopic(assistant.topics[index + 1 === assistant.topics.length ? 0 : index + 1])
      await moveTopic(topic, toAssistant)
    },
    [assistant.topics, moveTopic, setActiveTopic]
  )

  const onSwitchTopic = useCallback(
    async (topic: Topic) => {
      // await modelGenerating()
      setActiveTopic(topic)
    },
    [setActiveTopic]
  )

  // Standalone topic JSON import: Main creates the new topic under the
  // current assistant first; only the returned wire is projected to Redux
  // and selected. Cancellation returns null silently (no toast).
  const onImportTopicData = useCallback(async () => {
    try {
      const imported = await importTopicDataFromFile(assistant.id)
      if (imported) {
        addTopic(imported)
        setActiveTopic(imported)
      }
    } catch (error) {
      logger.error('Failed to import topic data', error as Error)
    }
  }, [assistant.id, addTopic, setActiveTopic, logger])

  const [_targetTopic, setTargetTopic] = useState<Topic | null>(null)
  const targetTopic = useDeferredValue(_targetTopic)
  const getTopicMenuItems = useMemo(() => {
    const topic = targetTopic
    if (!topic) return []

    const menus: MenuProps['items'] = [
      {
        label: t('chat.topics.auto_rename'),
        key: 'auto-rename',
        icon: <Sparkles size={14} />,
        disabled: isRenaming(topic.id),
        async onClick() {
          // Bounded naming authority: exact count + latest ≤5 + their blocks.
          // Never materializes the whole topic for manual auto-rename.
          // The authority preimage is captured before the summary await so a
          // delayed result never overwrites a later manual title/flag; Main
          // enforces it atomically (graceful no-op on mismatch/missing).
          const topicIdForRename = topic.id
          let namingContext: {
            topic: { id: string; name: string | null; isNameManuallyEdited: boolean | null }
            messageCount: number
            latestMessages: Message[]
            blocks: MessageBlock[]
          }
          try {
            namingContext = await dbService.fetchTopicNamingContext(topicIdForRename)
          } catch (err) {
            logger.error('Failed to load naming context for auto-rename', err as Error)
            return
          }
          if (namingContext.messageCount >= 2) {
            const expectedPreimage = {
              expectedName: namingContext.topic.name ?? null,
              expectedIsNameManuallyEdited: namingContext.topic.isNameManuallyEdited ?? null
            }
            startTopicRenaming(topicIdForRename)
            try {
              const { text: summaryText, error } = await fetchMessagesSummary({
                messages: namingContext.latestMessages,
                blocksById: createSnapshotBlockMap(namingContext.blocks)
              })
              if (summaryText) {
                let wire: { name?: string | null; isNameManuallyEdited?: boolean | null }
                try {
                  // Name + clear manual flag only; Main guards the preimage
                  // atomically. Missing topic throws NOT_FOUND → no-op.
                  wire = await dbService.updateTopicMetadata(
                    topicIdForRename,
                    summaryText,
                    undefined,
                    undefined,
                    false,
                    expectedPreimage
                  )
                } catch (err) {
                  logger.error('Failed to persist auto-renamed topic', err as Error)
                  return
                }
                // Projection only after authoritative success, built from the
                // latest Redux topic so only the intended fields change.
                const latest = store
                  .getState()
                  .assistants.assistants.flatMap((a) => a.topics)
                  .find((t) => t.id === topicIdForRename)
                if (!latest) {
                  return
                }
                // Authoritative flag guard: same-name collision (intervening
                // manual rename to exactly summaryText) no-ops atomically with
                // flag true — never clear the projection flag. Null/skip when
                // the returned flag is not the requested false.
                const data = resolveManualAutoRenameProjection(wire, summaryText, latest)
                if (!data) {
                  return
                }
                const ownerAssistantId =
                  store.getState().assistants.assistants.find((a) => a.topics?.some((t) => t.id === topicIdForRename))
                    ?.id ?? assistant.id
                store.dispatch(updateTopicAction({ assistantId: ownerAssistantId, topic: data }))
              } else if (error) {
                window.toast?.error(`${t('message.error.fetchTopicName')}: ${error}`)
              }
            } finally {
              finishTopicRenaming(topicIdForRename)
            }
          }
        }
      },
      {
        label: t('chat.topics.edit.title'),
        key: 'rename',
        icon: <EditIcon size={14} />,
        disabled: isRenaming(topic.id),
        async onClick() {
          const name = await PromptPopup.show({
            title: t('chat.topics.edit.title'),
            message: '',
            defaultValue: topic?.name || '',
            extraNode: (
              <div style={{ color: 'var(--color-text-3)', marginTop: 8 }}>{t('chat.topics.edit.title_tip')}</div>
            )
          })
          if (name && topic?.name !== name) {
            const updatedTopic = { ...topic, name, isNameManuallyEdited: true }
            try {
              // Phase 5.2B: SQLite persists before Redux (LOCK-528).
              await updateTopic(updatedTopic)
            } catch (err) {
              logger.error('Failed to persist renamed topic', err as Error)
            }
          }
        }
      },
      {
        label: topic.pinned ? t('chat.topics.unpin') : t('chat.topics.pin'),
        key: 'pin',
        icon: topic.pinned ? <PinOffIcon size={14} /> : <PinIcon size={14} />,
        onClick() {
          onPinTopic(topic)
        }
      },
      {
        label: t('chat.save.label'),
        key: 'save',
        icon: <Save size={14} />,
        children: [
          {
            label: t('notes.save'),
            key: 'notes',
            icon: <NotebookPen size={14} />,
            onClick: async () => {
              void exportTopicToNotes(topic, notesPath)
            }
          },
          {
            label: t('chat.save.topic.knowledge.title'),
            key: 'knowledge',
            onClick: async () => {
              try {
                const result = await SaveToKnowledgePopup.showForTopic(topic)
                if (result?.success) {
                  window.toast.success(t('chat.save.topic.knowledge.success', { count: result.savedCount }))
                }
              } catch {
                window.toast.error(t('chat.save.topic.knowledge.error.save_failed'))
              }
            }
          }
        ]
      },
      {
        label: t('chat.topics.export.title'),
        key: 'export',
        icon: <SquareArrowOutUpLeft size={14} />,
        children: [
          {
            label: t('chat.topics.export.image'),
            key: 'image',
            onClick: () => EventEmitter.emit(EVENT_NAMES.EXPORT_TOPIC_IMAGE, topic)
          },
          {
            label: t('chat.topics.export.md.label'),
            key: 'markdown',
            onClick: () => exportTopicAsMarkdown(topic)
          },
          // Standalone topic JSON data (whole logical topic incl. all
          // branches). The only JSON export the product offers — the file
          // format is the existing topic-data payload, unchanged.
          // No icon by request: this item renders as bare text.
          {
            label: t('chat.topics.export.json.label'),
            key: 'json',
            onClick: () => {
              void exportTopicDataToFile(topic)
            }
          }
        ].filter(Boolean) as ItemType<MenuItemType>[]
      }
    ]

    if (assistants.length > 1 && assistant.topics.length > 1) {
      menus.push({
        label: t('chat.topics.move_to'),
        key: 'move',
        icon: <FolderOutput size={14} />,
        popupClassName: 'move-to-submenu',
        children: assistants
          .filter((a) => a.id !== assistant.id)
          .map((a) => ({
            label: a.name,
            key: a.id,
            icon: <AssistantAvatar assistant={a} size={18} />,
            onClick: () => onMoveTopic(topic, a)
          }))
      })
    }

    if (assistant.topics.length > 1 && !topic.pinned) {
      menus.push({ type: 'divider' })
      menus.push({
        label: t('common.delete'),
        danger: true,
        key: 'delete',
        icon: <DeleteIcon size={14} className="lucide-custom" />,
        onClick: () => onDeleteTopic(topic)
      })
    }

    return menus
  }, [
    targetTopic,
    t,
    logger,
    isRenaming,
    assistants,
    notesPath,
    assistant,
    updateTopic,
    onPinTopic,
    onMoveTopic,
    onDeleteTopic
  ])

  // LOCK-002: pinned topics always sort to the top.
  const sortedTopics = useMemo(() => sortTopicsPinnedFirst(assistant.topics), [assistant.topics])

  // Filter topics based on header search text (ordinary list + manage mode).
  // Supports: case-insensitive, space-separated keywords (all must match).
  // Live-filtered via deferred value — Enter is not required.
  const deferredSearchText = useDeferredValue(searchText)
  const filteredTopics = useMemo(
    () => filterTopicsBySearch(sortedTopics, deferredSearchText),
    [sortedTopics, deferredSearchText]
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <DraggableVirtualList
        ref={listRef}
        className="topics-tab"
        list={filteredTopics}
        onUpdate={updateTopics}
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          height: 'auto',
          padding: '8px 0 10px 10px'
        }}
        itemContainerStyle={{ paddingBottom: '8px' }}
        header={
          <HeaderRow>
            {isHeaderSearchOpen ? (
              <HeaderSearchInputWrapper>
                <HeaderSearchInput
                  ref={headerSearchInputRef}
                  type="text"
                  placeholder={t('chat.topics.search.placeholder')}
                  aria-label={t('chat.topics.search.title')}
                  data-testid="topic-search-input"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      closeHeaderSearch()
                    }
                  }}
                />
              </HeaderSearchInputWrapper>
            ) : (
              <AddButton onClick={() => EventEmitter.emit(EVENT_NAMES.ADD_NEW_TOPIC)}>
                {t('chat.add.topic.title')}
              </AddButton>
            )}
            <HeaderIconGroup>
              {isHeaderSearchOpen ? (
                <Tooltip title={t('common.close')} mouseEnterDelay={0.5}>
                  <HeaderIconButton
                    role="button"
                    tabIndex={0}
                    aria-label={t('common.close')}
                    data-testid="topic-search-close"
                    onClick={closeHeaderSearch}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        closeHeaderSearch()
                      }
                    }}>
                    <XIcon size={14} />
                  </HeaderIconButton>
                </Tooltip>
              ) : (
                <Tooltip title={t('chat.topics.search.title')} mouseEnterDelay={0.5}>
                  <HeaderIconButton
                    role="button"
                    tabIndex={0}
                    aria-label={t('chat.topics.search.title')}
                    data-testid="topic-search-btn"
                    onClick={openHeaderSearch}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openHeaderSearch()
                      }
                    }}>
                    <BookSearchIcon size={14} />
                  </HeaderIconButton>
                </Tooltip>
              )}
              <Tooltip title={t('chat.topics.import.action')} mouseEnterDelay={0.5}>
                <HeaderIconButton
                  role="button"
                  tabIndex={0}
                  aria-label={t('chat.topics.import.action')}
                  data-testid="topic-import-btn"
                  onClick={() => void onImportTopicData()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void onImportTopicData()
                    }
                  }}>
                  <FileDown size={14} />
                </HeaderIconButton>
              </Tooltip>
              <Tooltip title={t('chat.topics.manage.title')} mouseEnterDelay={0.5}>
                <HeaderIconButton
                  role="button"
                  tabIndex={0}
                  aria-label={t('chat.topics.manage.title')}
                  data-testid="topic-manage-btn"
                  onClick={isManageMode ? exitManageMode : enterManageMode}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (isManageMode) {
                        exitManageMode()
                      } else {
                        enterManageMode()
                      }
                    }
                  }}
                  className={isManageMode ? 'active' : ''}>
                  <ListTodo size={14} />
                </HeaderIconButton>
              </Tooltip>
            </HeaderIconGroup>
          </HeaderRow>
        }
        disabled={isManageMode}>
        {(topic) => {
          const isActive = topic.id === activeTopic?.id
          const topicName = topic.name.replace('`', '')
          const topicPrompt = topic.prompt
          const fullTopicPrompt = t('common.prompt') + ': ' + topicPrompt
          const isSelected = selectedIds.has(topic.id)
          const canSelect = !topic.pinned

          const getTopicNameClassName = () => {
            if (isRenaming(topic.id)) return 'animation-shimmer'
            if (isNewlyRenamed(topic.id)) return 'animation-reveal'
            return ''
          }

          const handleItemClick = () => {
            if (isManageMode) {
              if (canSelect) {
                toggleSelectTopic(topic.id)
              }
            } else {
              void onSwitchTopic(topic)
            }
          }

          return (
            <Dropdown menu={{ items: getTopicMenuItems }} trigger={['contextMenu']} disabled={isManageMode}>
              <TopicListItem
                data-testid="topic-item"
                data-topic-id={topic.id}
                onContextMenu={() => setTargetTopic(topic)}
                className={classNames(
                  isActive && !isManageMode ? 'active' : '',
                  isManageMode && isSelected ? 'selected' : '',
                  isManageMode && !canSelect ? 'disabled' : ''
                )}
                onClick={editingTopicId === topic.id && isEditing ? undefined : handleItemClick}
                style={{
                  borderRadius,
                  cursor:
                    editingTopicId === topic.id && isEditing
                      ? 'default'
                      : isManageMode && !canSelect
                        ? 'not-allowed'
                        : 'pointer'
                }}>
                {isPending(topic.id) && !isActive && <PendingIndicator />}
                {isFulfilled(topic.id) && !isActive && <FulfilledIndicator />}
                <TopicNameContainer>
                  {isManageMode && (
                    <SelectIcon className={!canSelect ? 'disabled' : ''}>
                      {isSelected ? (
                        <CheckSquare size={16} color="var(--color-primary)" />
                      ) : (
                        <Square size={16} color="var(--color-text-3)" />
                      )}
                    </SelectIcon>
                  )}
                  {editingTopicId === topic.id && isEditing ? (
                    <TopicEditInput {...inputProps} onClick={(e) => e.stopPropagation()} />
                  ) : (
                    <TopicName
                      className={getTopicNameClassName()}
                      title={topicName}
                      onDoubleClick={
                        isManageMode
                          ? undefined
                          : () => {
                              setEditingTopicId(topic.id)
                              startEdit(topic.name)
                            }
                      }>
                      {topicName}
                    </TopicName>
                  )}
                  {!topic.pinned && (
                    <Tooltip
                      placement="bottom"
                      mouseEnterDelay={0.7}
                      mouseLeaveDelay={0}
                      title={
                        <div style={{ fontSize: '12px', opacity: 0.8, fontStyle: 'italic' }}>
                          {t('chat.topics.delete.shortcut', { key: isMac ? '⌘' : 'Ctrl' })}
                        </div>
                      }>
                      <MenuButton
                        data-testid="topic-delete-btn"
                        className="menu"
                        onClick={(e) => {
                          if (e.ctrlKey || e.metaKey) {
                            void handleConfirmDelete(topic, e)
                          } else if (deletingTopicId === topic.id) {
                            void handleConfirmDelete(topic, e)
                          } else {
                            handleDeleteClick(topic.id, e)
                          }
                        }}>
                        {deletingTopicId === topic.id ? (
                          <DeleteIcon size={14} color="var(--color-error)" style={{ pointerEvents: 'none' }} />
                        ) : (
                          <XIcon size={14} color="var(--color-text-3)" style={{ pointerEvents: 'none' }} />
                        )}
                      </MenuButton>
                    </Tooltip>
                  )}
                  {topic.pinned && (
                    <MenuButton className="pin">
                      <PinIcon size={14} color="var(--color-text-3)" />
                    </MenuButton>
                  )}
                </TopicNameContainer>
                {topicPrompt && (
                  <TopicPromptText className="prompt" title={fullTopicPrompt}>
                    {fullTopicPrompt}
                  </TopicPromptText>
                )}
                {/* LOCK-002: topic time is always shown */}
                <TopicTime className="time">{dayjs(topic.createdAt).format('YYYY/MM/DD HH:mm')}</TopicTime>
              </TopicListItem>
            </Dropdown>
          )
        }}
      </DraggableVirtualList>

      {/* 管理模式底部面板 */}
      <TopicManagePanel
        assistant={assistant}
        assistants={assistants}
        activeTopic={activeTopic}
        setActiveTopic={setActiveTopic}
        updateTopics={updateTopics}
        moveTopic={moveTopic}
        manageState={manageState}
        filteredTopics={filteredTopics}
        onTrashChanged={refreshTrashTopics}
      />

      {/* 回收站面板: hidden while management is active to prevent stacked
          border/occlusion with the normal-flow management toolbar. Normal
          recycle-bin behavior is unchanged outside management. */}
      {!isManageMode && (
        <TopicTrashPanel
          assistantId={assistant.id}
          refreshVersion={trashRefreshVersion}
          onRestore={handleRestoreTopic}
          onPermanentDelete={async (topicId) => {
            // Phase 5.2B: ordinary hard delete commits in SQLite first, then the
            // cleanup result is consumed (LOCK-525).
            await hardDeleteOrdinaryTopic(topicId)
            refreshTrashTopics()
          }}
          onEmptyTrash={async () => {
            try {
              // Phase 5.2B: ordinary trash is emptied in ONE atomic Main SQLite
              // transaction with one aggregate cleanup result (LOCK-531).
              await emptyOrdinaryTrash(assistant.id)
            } finally {
              // Reconcile the panel with the persisted state even when a
              // mutation failed part-way (LOCK-528).
              refreshTrashTopics()
            }
          }}
        />
      )}
    </div>
  )
}

const TopicListItem = styled.div`
  padding: 7px 12px;
  border-radius: var(--list-item-border-radius);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  cursor: pointer;
  width: calc(100% - 20px);

  .menu {
    opacity: 0;
    color: var(--color-text-3);
  }

  &:hover {
    background-color: var(--color-list-item-hover);
    transition: background-color 0.1s;

    .menu {
      opacity: 1;
    }
  }

  &.active {
    background-color: var(--color-list-item);
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    .menu {
      opacity: 1;

      &:hover {
        color: var(--color-text-2);
      }
    }
  }

  &.selected {
    background-color: var(--color-primary-bg);
    box-shadow: inset 0 0 0 1px var(--color-primary);
  }

  &.disabled {
    opacity: 0.5;
  }
`

const TopicNameContainer = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  height: 20px;
`

const TopicName = styled.div`
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  position: relative;
  flex: 1;
  text-align: left;

  &.animation-reveal {
    -webkit-line-clamp: unset;
    -webkit-box-orient: unset;
  }
`

const TopicEditInput = styled.input`
  background: var(--color-background);
  border: none;
  color: var(--color-text-1);
  font-size: 13px;
  font-family: inherit;
  padding: 2px 6px;
  width: 100%;
  outline: none;
  padding: 0;
`

const PendingIndicator = styled.div.attrs({
  className: 'animation-pulse'
})`
  --pulse-size: 5px;
  width: 5px;
  height: 5px;
  position: absolute;
  left: 3px;
  top: 15px;
  border-radius: 50%;
  background-color: var(--color-status-warning);
`

const FulfilledIndicator = styled.div.attrs({
  className: 'animation-pulse'
})`
  --pulse-size: 5px;
  width: 5px;
  height: 5px;
  position: absolute;
  left: 3px;
  top: 15px;
  border-radius: 50%;
  background-color: var(--color-status-success);
`

const TopicPromptText = styled.div`
  color: var(--color-text-2);
  font-size: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  ~ .prompt-text {
    margin-top: 10px;
  }
`

const TopicTime = styled.div`
  color: var(--color-text-3);
  font-size: 11px;
`

const MenuButton = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  min-width: 20px;
  min-height: 20px;
  .anticon {
    font-size: 12px;
  }
`

// Reason: AddButton is 36px tall while the previous 32px search controls
// collapsed the header by 4px when search opened. Keep both modes at 36px.
const HeaderRow = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding-right: 10px;
  margin-bottom: 8px;
  margin-top: 2px;
  min-height: 36px;
  box-sizing: border-box;
`

const HeaderIconGroup = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0;
  flex: none;
  flex-shrink: 0;
  margin-left: 0;
  width: auto;
`

const HeaderIconButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 36px;
  min-width: 28px;
  min-height: 36px;
  flex: none;
  box-sizing: border-box;
  border-radius: var(--list-item-border-radius);
  cursor: pointer;
  color: var(--color-text-2);
  transition: all 0.2s;

  &:hover {
    background-color: var(--color-background-mute);
    color: var(--color-text-1);
  }

  &.active {
    color: var(--color-primary);

    &:hover {
      background-color: var(--color-background-mute);
    }
  }
`

const HeaderSearchInputWrapper = styled.div`
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  min-height: 36px;
  box-sizing: border-box;
`

const HeaderSearchInput = styled.input`
  height: 36px;
  min-width: 0;
  flex: 1;
  border: none;
  background: transparent;
  padding: 0 4px;
  font-size: 13px;
  line-height: 36px;
  color: var(--color-text-1);
  outline: none;
  box-sizing: border-box;

  &::placeholder {
    color: var(--color-text-3);
  }
`

const SelectIcon = styled.div`
  display: flex;
  align-items: center;
  margin-right: 4px;

  &.disabled {
    opacity: 0.5;
  }
`
