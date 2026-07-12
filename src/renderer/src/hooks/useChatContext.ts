import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { RootState } from '@renderer/store'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import { setActiveTopic, setSelectedMessageIds, toggleMultiSelectMode } from '@renderer/store/runtime'
import type { Topic } from '@renderer/types'
import { useCallback, useEffect, useState } from 'react'
import { useDispatch, useSelector, useStore } from 'react-redux'

export const useChatContext = (activeTopic: Topic) => {
  const dispatch = useDispatch()
  const store = useStore<RootState>()

  const [messageRefs, setMessageRefs] = useState<Map<string, HTMLElement>>(new Map())

  const isMultiSelectMode = useSelector((state: RootState) => state.runtime.chat.isMultiSelectMode)
  const selectedMessageIds = useSelector((state: RootState) => state.runtime.chat.selectedMessageIds)

  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.CHANGE_TOPIC, () => {
      dispatch(toggleMultiSelectMode(false))
    })
    return () => unsubscribe()
  }, [dispatch])

  useEffect(() => {
    dispatch(setActiveTopic(activeTopic))
  }, [dispatch, activeTopic])

  const handleToggleMultiSelectMode = useCallback(
    (value: boolean) => {
      dispatch(toggleMultiSelectMode(value))
    },
    [dispatch]
  )

  const registerMessageElement = useCallback((id: string, element: HTMLElement | null) => {
    setMessageRefs((prev) => {
      const newRefs = new Map(prev)
      if (element) {
        newRefs.set(id, element)
      } else {
        newRefs.delete(id)
      }
      return newRefs
    })
  }, [])

  const locateMessage = useCallback(
    (messageId: string) => {
      const messageElement = messageRefs.get(messageId)
      if (messageElement) {
        // 检查消息是否可见
        const display = window.getComputedStyle(messageElement).display

        if (display === 'none') {
          // 如果消息隐藏，需要处理显示逻辑
          // 查找消息并设置为选中状态
          const state = store.getState()
          const messages = selectMessagesForTopic(state, activeTopic.id)
          const message = messages.find((m) => m.id === messageId)
          if (message) {
            // 这里需要实现设置消息为选中状态的逻辑
            // 可能需要调用其他函数或修改状态
          }
        }

        // 滚动到消息位置
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    [messageRefs, store, activeTopic.id]
  )

  const handleSelectMessage = useCallback(
    (messageId: string, selected: boolean) => {
      dispatch(
        setSelectedMessageIds(
          selected
            ? selectedMessageIds.includes(messageId)
              ? selectedMessageIds
              : [...selectedMessageIds, messageId]
            : selectedMessageIds.filter((id) => id !== messageId)
        )
      )
    },
    [dispatch, selectedMessageIds]
  )

  return {
    isMultiSelectMode,
    selectedMessageIds,
    toggleMultiSelectMode: handleToggleMultiSelectMode,
    handleSelectMessage,
    activeTopic,
    locateMessage,
    messageRefs,
    registerMessageElement
  }
}
