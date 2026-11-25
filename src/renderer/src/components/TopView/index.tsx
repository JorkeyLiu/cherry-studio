// import { loggerService } from '@logger'
import { useAppInit } from '@renderer/hooks/useAppInit'
import { useShortcuts } from '@renderer/hooks/useShortcuts'
import { message, Modal } from 'antd'
import type { PropsWithChildren } from 'react'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { Box } from '../Layout'
import {
  getTopViewLayerCount,
  popTopViewLayer,
  registerTopViewPopHandler,
  reportTopViewLayerCount,
  subscribeTopViewLayerCount
} from './layers'
import { getToastUtilities, initMessageApi } from './toast'

let onPop = () => {}
let onShow = ({ element, id }: { element: React.FC | React.ReactNode; id: string }) => {
  void element
  id
}
let onHide = (id: string) => {
  id
}
let onHideAll = () => {}

interface Props {
  children?: React.ReactNode
}

type ElementItem = {
  id: string
  element: React.FC | React.ReactNode
}

// const logger = loggerService.withContext('TopView')

const TopViewContainer: React.FC<Props> = ({ children }) => {
  const [elements, setElements] = useState<ElementItem[]>([])
  const elementsRef = useRef<ElementItem[]>([])
  elementsRef.current = elements

  const [modal, modalContextHolder] = Modal.useModal()
  const [messageApi, messageContextHolder] = message.useMessage()
  const { shortcuts } = useShortcuts()
  const enableQuitFullScreen = shortcuts.find((item) => item.key === 'exit_fullscreen')?.enabled

  useAppInit()

  useEffect(() => {
    window.modal = modal
    initMessageApi(messageApi)
    window.toast = getToastUtilities()
  }, [messageApi, modal])

  onPop = () => {
    const views = [...elementsRef.current]
    views.pop()
    elementsRef.current = views
    setElements(elementsRef.current)
    // Publish synchronously: Escape routing must see the new depth before the
    // next render commits, and must stay correct if the container unmounts.
    reportTopViewLayerCount(elementsRef.current.length)
  }

  onShow = ({ element, id }: ElementItem) => {
    if (!elementsRef.current.find((el) => el.id === id)) {
      elementsRef.current = elementsRef.current.concat([{ element, id }])
      setElements(elementsRef.current)
      reportTopViewLayerCount(elementsRef.current.length)
    }
  }

  onHide = (id: string) => {
    elementsRef.current = elementsRef.current.filter((el) => el.id !== id)
    setElements(elementsRef.current)
    reportTopViewLayerCount(elementsRef.current.length)
  }

  onHideAll = () => {
    setElements([])
    elementsRef.current = []
    reportTopViewLayerCount(0)
  }

  // The layer seam is a module singleton, so the pop operation and the
  // published depth are (re)bound to this live container. Both read the module
  // slot lazily, so they stay correct after the container re-renders.
  useEffect(() => {
    registerTopViewPopHandler(() => onPop())
    reportTopViewLayerCount(elementsRef.current.length)
    return () => {
      registerTopViewPopHandler(() => undefined)
      reportTopViewLayerCount(0)
    }
  }, [])

  const FullScreenContainer: React.FC<PropsWithChildren> = useCallback(({ children }) => {
    return (
      <Box flex={1} position="absolute" w="100%" h="100%" className="topview-fullscreen-container">
        <Box position="absolute" w="100%" h="100%" onClick={onPop} />
        {children}
      </Box>
    )
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // logger.debug('keydown', e)
      if (!enableQuitFullScreen) return

      if (e.key === 'Escape' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        void window.api.setFullScreen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  })

  return (
    <>
      {children}
      {messageContextHolder}
      {modalContextHolder}
      {elements.map(({ element: Element, id }) => (
        <FullScreenContainer key={`TOPVIEW_${id}`}>
          {typeof Element === 'function' ? <Element /> : Element}
        </FullScreenContainer>
      ))}
    </>
  )
}

export const TopView = {
  show: (element: React.FC | React.ReactNode, id: string) => onShow({ element, id }),
  hide: (id: string) => onHide(id),
  clear: () => onHideAll(),
  pop: onPop,
  /** Number of elements currently layered above the app surface. */
  getLayerCount: getTopViewLayerCount,
  /** Subscribe to layer-count changes (fires immediately with the current count). */
  subscribeLayerCount: subscribeTopViewLayerCount,
  /** Close the topmost layered element. */
  popLayer: popTopViewLayer
}

export default TopViewContainer
