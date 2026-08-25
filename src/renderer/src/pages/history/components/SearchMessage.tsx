import { HStack } from '@renderer/components/Layout'
import { MessageEditingProvider } from '@renderer/context/MessageEditingContext'
import { getTopicById } from '@renderer/hooks/useTopic'
import { default as MessageItem } from '@renderer/pages/home/Messages/Message'
import { locateToMessage } from '@renderer/services/MessagesService'
import NavigationService from '@renderer/services/NavigationService'
import {
  captureDeletionGeneration,
  getDeletionGeneration,
  isDeletionStale,
  subscribeDeletionGeneration
} from '@renderer/services/topicDeletionInvalidation'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { runAsyncFunction } from '@renderer/utils'
import { Button } from 'antd'
import { Forward } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props extends React.HTMLAttributes<HTMLDivElement> {
  message?: Message
}

const SearchMessage: FC<Props> = ({ message, ...props }) => {
  const navigate = NavigationService.navigate!
  const { t } = useTranslation()
  const [topic, setTopic] = useState<Topic | null>(null)
  const [deletionStale, setDeletionStale] = useState(false)

  useEffect(() => {
    void runAsyncFunction(async () => {
      if (message?.topicId) {
        // Fail-closed: if topic already deleted, do not set topic
        if (isDeletionStale(message.topicId, 0) || getDeletionGeneration(message.topicId) !== 0) {
          setTopic(null)
          return
        }
        const topic = await getTopicById(message.topicId)
        // Re-check after async fetch — topic may have been deleted during fetch
        if (!topic || isDeletionStale(message.topicId, 0) || getDeletionGeneration(message.topicId) !== 0) {
          setTopic(null)
          return
        }
        setTopic(topic)
      } else {
        setTopic(null)
      }
    })
  }, [message])

  // LOCK-004: invalidate selected message projection when its topic is
  // permanently deleted. Uses per-topic generation subscription; soft-delete
  // never bumps. Hides the view and prevents locate navigation.
  useEffect(() => {
    if (!message?.topicId) {
      setDeletionStale(false)
      return
    }
    const topicId = message.topicId
    const captured = captureDeletionGeneration(topicId)
    if (isDeletionStale(topicId, captured)) {
      setDeletionStale(true)
      setTopic(null)
      return
    }
    setDeletionStale(false)
    const unsub = subscribeDeletionGeneration(topicId, () => {
      if (isDeletionStale(topicId, captured)) {
        setDeletionStale(true)
        setTopic(null)
      }
    })
    return unsub
  }, [message?.topicId])

  if (!message || deletionStale) {
    return null
  }

  if (!topic) {
    return null
  }

  const handleLocate = () => {
    if (!message) return
    if (isDeletionStale(message.topicId, 0) || getDeletionGeneration(message.topicId) !== 0) {
      window.toast.error(t('history.error.message_not_found'))
      return
    }
    void locateToMessage(navigate, message)
  }

  return (
    <MessageEditingProvider>
      <MessagesContainer data-testid="search-message-view" {...props}>
        <ContainerWrapper>
          <MessageItem message={message} topic={topic} hideMenuBar={true} />
          <Button
            type="text"
            size="middle"
            data-testid="search-message-locate"
            style={{ color: 'var(--color-text-3)', position: 'absolute', right: 16, top: 16 }}
            onClick={handleLocate}
            icon={<Forward size={16} />}
          />
          <HStack mt="10px" justifyContent="center">
            <Button data-testid="search-message-locate-primary" onClick={handleLocate} icon={<Forward size={16} />}>
              {t('history.locate.message')}
            </Button>
          </HStack>
        </ContainerWrapper>
      </MessagesContainer>
    </MessageEditingProvider>
  )
}

const MessagesContainer = styled.div`
  width: 100%;
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  overflow-y: scroll;
`

const ContainerWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
  position: relative;
`

export default SearchMessage
