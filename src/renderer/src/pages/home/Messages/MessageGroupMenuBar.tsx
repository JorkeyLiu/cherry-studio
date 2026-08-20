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
}

// LOCK-105: the multi-model group menu bar always renders in fold/tag mode;
// the horizontal/vertical/grid layout selector and the grid settings popover
// are removed.
const MessageGroupMenuBar: FC<Props> = ({
  messages,
  selectMessageId,
  setSelectedMessage,
  onReorderMessages,
  topic
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
    // Event-time status: re-read each explicit ID from store before checking.
    // Do not subscribe the component; do not retry newly added IDs not in
    // the explicit rendered group.
    const explicitIds = messages.map((m) => m.id)
    for (const id of explicitIds) {
      const latest = store.getState().messages.entities[id] as Message | undefined
      if (!latest) continue
      if (latest.topicId !== topic.id) continue
      if (!isFailedMessage(latest) || isTransmittingMessage(latest)) continue
      try {
        await regenerateAssistant({ topicId: topic.id, messageId: id })
      } catch (e) {
        // swallow per-item errors to continue others
      }
    }
  }

  return (
    <GroupMenuBar className="group-menu-bar">
      <HStack style={{ alignItems: 'center', flex: 1, overflow: 'hidden' }}>
        <MessageGroupModelList
          messages={messages}
          selectMessageId={selectMessageId}
          setSelectedMessage={setSelectedMessage}
          onReorderMessages={onReorderMessages}
        />
      </HStack>
      {hasFailedMessages && (
        <Tooltip title={t('message.group.retry_failed')} mouseEnterDelay={0.6}>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
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
`

export default memo(MessageGroupMenuBar)
