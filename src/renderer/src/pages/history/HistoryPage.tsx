import { HStack } from '@renderer/components/Layout'
import {
  captureDeletionGeneration,
  getDeletionGeneration,
  isDeletionStale,
  subscribeDeletionGeneration
} from '@renderer/services/topicDeletionInvalidation'
import { useAppDispatch } from '@renderer/store'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type { InputRef } from 'antd'
import { Divider, Input } from 'antd'
import { last } from 'lodash'
import { ChevronLeft, CornerDownLeft, Search } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import SearchMessage from './components/SearchMessage'
import SearchResults from './components/SearchResults'
import TopicMessages from './components/TopicMessages'
import TopicsHistory from './components/TopicsHistory'

type Route = 'topics' | 'topic' | 'search' | 'message'

let _search = ''
let _stack: Route[] = ['topics']
let _topic: Topic | undefined
let _message: Message | undefined

const HistoryPage: FC = () => {
  const { t } = useTranslation()
  const [search, setSearch] = useState(_search)
  const [searchKeywords, setSearchKeywords] = useState(_search)
  const [stack, setStack] = useState<Route[]>(_stack)
  const [topic, setTopic] = useState<Topic | undefined>(_topic)
  const [message, setMessage] = useState<Message | undefined>(_message)
  const inputRef = useRef<InputRef>(null)
  const dispatch = useAppDispatch()

  _search = search
  _stack = stack
  _topic = topic
  _message = message

  const goBack = () => {
    const _stack = [...stack]
    const route = _stack.pop()
    setStack(_stack)
    route === 'search' && setSearch('')
    route === 'topic' && setTopic(undefined)
    route === 'message' && setMessage(undefined)
  }

  const onSearch = () => {
    setSearchKeywords(search)
    setStack(['topics', 'search'])
    setTopic(undefined)
  }

  // topic 不包含 messages，用到的时候才会获取
  const onTopicClick = (topic: Topic | null | undefined) => {
    if (!topic) {
      window.toast.error(t('history.error.topic_not_found'))
      return
    }
    setStack((prev) => [...prev, 'topic'])
    setTopic(topic)
  }

  const onMessageClick = (message: Message) => {
    void dispatch(loadTopicMessagesThunk(message.topicId))
    setStack(['topics', 'search', 'message'])
    setMessage(message)
  }

  // LOCK-004: invalidate selected History message when its topic is
  // permanently deleted. Uses per-topic generation subscription; soft-delete
  // never bumps so selection is preserved. Clears local message and route
  // without global Redux clearing. Current-state-safe: if deletion already
  // occurred before subscription (generation nonzero), synchronously clears
  // stale selection. The callback is idempotent.
  useEffect(() => {
    if (!message?.topicId) return
    const topicId = message.topicId
    const clear = () => {
      setMessage(undefined)
      _message = undefined
      setStack((prev) => prev.filter((r) => r !== 'message'))
      _stack = _stack.filter((r) => r !== 'message')
    }
    // Immediate check: already-deleted topic never renders
    if (getDeletionGeneration(topicId) !== 0) {
      clear()
      // Still subscribe for cleanup symmetry; immediate helper will invoke
      // again idempotently, which is safe.
      return subscribeDeletionGeneration(topicId, () => {
        if (getDeletionGeneration(topicId) !== 0) clear()
      })
    }
    const captured = captureDeletionGeneration(topicId)
    // Re-check captured vs current for deletion during request window
    if (isDeletionStale(topicId, captured)) {
      clear()
      return subscribeDeletionGeneration(topicId, () => {
        if (getDeletionGeneration(topicId) !== 0 || isDeletionStale(topicId, captured)) clear()
      })
    }
    const unsub = subscribeDeletionGeneration(topicId, () => {
      if (getDeletionGeneration(topicId) !== 0 || isDeletionStale(topicId, captured)) {
        clear()
      }
    })
    // Race around registration: deletion could occur between capture and subscribe
    if (getDeletionGeneration(topicId) !== 0 || isDeletionStale(topicId, captured)) {
      clear()
    }
    return unsub
  }, [message?.topicId])

  const isShow = (route: Route) => (last(stack) === route ? 'flex' : 'none')

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  return (
    <Container>
      <HStack style={{ padding: '0 12px', marginTop: 8 }}>
        <Input
          data-testid="history-search-input"
          prefix={
            stack.length > 1 ? (
              <SearchIcon className="back-icon" onClick={goBack}>
                <ChevronLeft size={16} />
              </SearchIcon>
            ) : (
              <SearchIcon>
                <Search size={15} />
              </SearchIcon>
            )
          }
          suffix={search.length ? <CornerDownLeft size={16} /> : null}
          ref={inputRef}
          placeholder={t('history.search.placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value.trimStart())}
          allowClear
          autoFocus
          spellCheck={false}
          style={{ paddingLeft: 0 }}
          variant="borderless"
          size="middle"
          onPressEnter={onSearch}
        />
      </HStack>
      <Divider style={{ margin: 0, marginTop: 4, borderBlockStartWidth: 0.5 }} />

      <TopicsHistory
        keywords={search}
        onClick={onTopicClick as any}
        onSearch={onSearch}
        style={{ display: isShow('topics') }}
      />
      <TopicMessages topic={topic} style={{ display: isShow('topic') }} />
      <SearchResults
        keywords={isShow('search') ? searchKeywords : ''}
        onMessageClick={onMessageClick}
        onTopicClick={onTopicClick}
        style={{ display: isShow('search') }}
      />
      <SearchMessage message={message} style={{ display: isShow('message') }} />
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
`

const SearchIcon = styled.div`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  background-color: var(--color-background-soft);
  margin-right: 2px;
  &.back-icon {
    cursor: pointer;
    transition: background-color 0.2s;
    &:hover {
      background-color: var(--color-background-mute);
    }
  }
`

export default HistoryPage
