import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { RootState } from '@renderer/store'
import { setActiveTopic, setSelectedMessageIds, toggleMultiSelectMode } from '@renderer/store/runtime'
import type { Topic } from '@renderer/types'
import { useCallback, useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'

export const useChatContext = (activeTopic: Topic) => {
  const dispatch = useDispatch()

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
        // The message element is already registered; locating is purely
        // scrollIntoView. No loaded-projection read here (the prior
        // no-effect loaded lookup was dead code).
        // 滚动到消息位置
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    [messageRefs]
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
