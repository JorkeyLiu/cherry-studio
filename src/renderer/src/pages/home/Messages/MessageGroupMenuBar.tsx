import { ReloadOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import { useMessageActionController } from '@renderer/hooks/useMessageActionController'
import store from '@renderer/store'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { Button, Tooltip } from 'antd'
import type { FC } from 'react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import MessageGroupModelList from './MessageGroupModelList'

interface Props {
  messages: Message[]
  selectMessageId: string
  setSelectedMessage: (message: Message) => void
  onReorderMessages: (messages: Message[]) => void
  topic: Topic
  /** BRANCH-12: non-owned/incomplete groups disable selector/reorder/retry-all. */
  disabled?: boolean
  /**
   * Edit-mode forced hide: the bar keeps its DOM structure and occupied
   * height (no layout shift when toggling edit mode) while staying
   * invisible, noninteractive, and inaccessible. Ordinary capability
   * gating via `disabled` is untouched.
   */
  isEditMode?: boolean
}

// LOCK-105: the multi-model group menu bar always renders in fold/tag mode;
// the horizontal/vertical/grid layout selector and the grid settings popover
// are removed.
const MessageGroupMenuBar: FC<Props> = ({
  messages,
  selectMessageId,
  setSelectedMessage,
  onReorderMessages,
  topic,
  disabled = false,
  isEditMode = false
}) => {
  const { t } = useTranslation()
  const { regenerateAssistant } = useMessageActionController()

  const isFailedMessage = (m: Message) => {
    if (m.role !== 'assistant') return false
    const isError = (m.status || '').toLowerCase() === 'error'
    const content = getMainTextContent(m)
    const noContent = !content || content.trim().length === 0
    const noBlocks = !m.blocks || m.blocks.length === 0
    return isError || noContent || noBlocks
  }

  const isTransmittingMessage = (m: Message) => {
    if (m.role !== 'assistant') return false
    const status = m.status as AssistantMessageStatus
    return (
      status === AssistantMessageStatus.PROCESSING ||
      status === AssistantMessageStatus.PENDING ||
      status === AssistantMessageStatus.SEARCHING
    )
  }

  const hasFailedMessages = messages.some((m) => isFailedMessage(m) && !isTransmittingMessage(m))

  const handleRetryAll = async () => {
    // BRANCH-12: batch regeneration is whole-group-gated. A disabled
    // (non-owned/incomplete) bar never issues calls; a known non-owned loaded
    // member fails closed with zero calls. Window-outside members are
    // decided per item by the Main guard — the first failure stops the
    // batch (no partial-success claim, no atomicity claim).
    if (disabled) return
    // Event-time status: re-read each explicit ID from store before checking.
    // Do not subscribe the component; do not retry newly added IDs not in
    // the explicit rendered group.
    const explicitIds = messages.map((m) => m.id)
    try {
      const { requireLoadedAnswerMembersMutable } = await import('@renderer/store/routeAnswerGroup')
      const askId = messages.find(
        (m) => m.role === 'assistant' && typeof m.askId === 'string' && m.askId.length > 0
      )?.askId
      if (typeof askId === 'string' && askId.length > 0) {
        requireLoadedAnswerMembersMutable(store.getState(), topic.id, askId)
      }
    } catch {
      return
    }
    for (const id of explicitIds) {
      const latest = store.getState().messages.entities[id] as Message | undefined
      if (!latest) continue
      if (latest.topicId !== topic.id) continue
      if (!isFailedMessage(latest) || isTransmittingMessage(latest)) continue
      try {
        await regenerateAssistant({ topicId: topic.id, messageId: id })
      } catch (e) {
        // Stop at the first Main-guard/transport failure: later items stay
        // unattempted so a non-owned group never partially regenerates.
        void e
        break
      }
    }
  }

  // BRANCH-12: the whole bar is inert for non-owned/incomplete groups.
  const barDisabled = disabled

  return (
    <GroupMenuBar
      className={isEditMode ? 'group-menu-bar edit-mode-toolbar-hidden' : 'group-menu-bar'}
      aria-disabled={barDisabled}
      inert={isEditMode ? true : undefined}
      aria-hidden={isEditMode ? true : undefined}>
      <HStack style={{ alignItems: 'center', flex: 1, overflow: 'hidden' }}>
        <MessageGroupModelList
          messages={messages}
          selectMessageId={selectMessageId}
          setSelectedMessage={setSelectedMessage}
          onReorderMessages={onReorderMessages}
          disabled={barDisabled}
        />
      </HStack>
      {hasFailedMessages && !barDisabled && (
        <Tooltip title={t('message.group.retry_failed')} mouseEnterDelay={0.6}>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            data-testid="group-retry-all-btn"
            onClick={handleRetryAll}
            style={{ marginRight: 4 }}
          />
        </Tooltip>
      )}
    </GroupMenuBar>
  )
}

const GroupMenuBar = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 10px;
  margin: 8px 10px 16px;
  justify-content: space-between;
  overflow: hidden;
  border: 0.5px solid var(--color-border);
  height: 40px;
  user-select: none;
  // Edit-mode forced hide: keeps DOM structure and occupied height while
  // the bar stays invisible, noninteractive, and inaccessible.
  &.edit-mode-toolbar-hidden {
    visibility: hidden;
    pointer-events: none;
  }
`

export default memo(MessageGroupMenuBar)
