import { HolderOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import TranslateButton from '@renderer/components/TranslateButton'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import PasteService from '@renderer/services/PasteService'
import { useAppDispatch } from '@renderer/store'
import { setSearching } from '@renderer/store/runtime'
import type { FileMetadata } from '@renderer/types'
import { classNames } from '@renderer/utils'
import { formatQuotedText } from '@renderer/utils/formats'
import { isSendMessageKeyPressed } from '@renderer/utils/input'
import { IpcChannel } from '@shared/IpcChannel'
import { Divider } from 'antd'
import TextArea from 'antd/es/input/TextArea'
import type { TextAreaRef } from 'antd/lib/input/TextArea'
import { motion } from 'motion/react'
import type { CSSProperties, FC } from 'react'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { INPUTBAR_OUTER_SIDE_PAD_PX } from '../../Messages/navRailGeometry'
import AttachmentPreview from '../AttachmentPreview'
import {
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '../context/InputbarToolsProvider'
import { useFileDragDrop } from '../hooks/useFileDragDrop'
import { useInputbarIsland } from '../hooks/useInputbarIsland'
import { usePasteHandler } from '../hooks/usePasteHandler'
import { getInputbarConfig } from '../registry'
import SendMessageButton from '../SendMessageButton'
import StopGenerationButton from '../StopGenerationButton'
import type { InputbarScope } from '../types'
import InputbarSettings from './InputbarSettings'

const logger = loggerService.withContext('InputbarCore')

export interface InputbarCoreProps {
  scope: InputbarScope
  placeholder?: string

  text: string
  onTextChange: (text: string) => void
  textareaRef: React.RefObject<TextAreaRef | null>
  resizeTextArea: (force?: boolean) => void
  focusTextarea: () => void

  height: number | undefined
  onHeightChange: (height: number) => void

  supportedExts: string[]
  isLoading: boolean

  onPause?: () => void
  handleSendMessage: () => void

  // Toolbar sections
  leftToolbar?: React.ReactNode
  rightToolbar?: React.ReactNode
  // Independent model row rendered first inside the composer (current
  // model selector with model name); the toolbar keeps the 28px tool slots.
  modelRow?: React.ReactNode

  // Preview sections (attachments, mentions, etc.)
  topContent?: React.ReactNode

  // Pinned content that floats above the inputbar (uses absolute positioning)
  pinnedContent?: React.ReactNode

  // Overlay rendered inside InputBarContainer at top-right (absolute positioned)
  topRightOverlay?: React.ReactNode

  // Dual-mode Dynamic Island state (controlled when provided; defaults to expanded)
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

const CAPSULE_WIDTH_PX = 124
const CAPSULE_HOVER_WIDTH_PX = 136
const CAPSULE_HEIGHT_PX = 30
const ISLAND_TRANSITION = { duration: 0.18, ease: 'linear' } as const

const TextareaStyle: CSSProperties = {
  paddingLeft: 0,
  padding: '6px 15px 0px'
}

export const InputbarCore: FC<InputbarCoreProps> = ({
  scope,
  placeholder,
  text,
  onTextChange,
  textareaRef,
  resizeTextArea,
  focusTextarea,
  height,
  onHeightChange,
  supportedExts,
  isLoading,
  onPause,
  handleSendMessage,
  leftToolbar,
  rightToolbar,
  modelRow,
  topContent,
  pinnedContent,
  topRightOverlay,
  expanded,
  onExpandedChange
}) => {
  const config = useMemo(() => getInputbarConfig(scope), [scope])
  const { files } = useInputbarToolsState()
  const { setFiles } = useInputbarToolsDispatch()
  const { setExtensions } = useInputbarToolsInternalDispatch()
  const isEmpty = text.trim().length === 0
  const [inputFocus, setInputFocus] = useState(false)
  const { sendMessageShortcut, fontSize, pasteLongTextAsFile, pasteLongTextThreshold, enableSpellCheck } = useSettings()

  const { t } = useTranslation()
  const [isTranslating] = useState(false)

  const dispatch = useAppDispatch()
  const { searching } = useRuntime()
  const startDragY = useRef<number>(0)
  const startHeight = useRef<number>(0)
  const { setTimeoutTimer } = useTimer()
  const containerRef = useRef<HTMLDivElement>(null)
  const islandRef = useRef<HTMLDivElement>(null)
  const capsuleRef = useRef<HTMLDivElement>(null)
  const [containerWidthPx, setContainerWidthPx] = useState<number>(0)

  const { isExpanded, isExpandedRef, expandAndFocus, handleIslandBlurCapture } = useInputbarIsland({
    expanded,
    onExpandedChange,
    focusTextarea,
    resizeTextArea,
    islandRef,
    capsuleRef
  })

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const updateWidth = () => {
      const width = el.clientWidth
      if (Number.isFinite(width) && width > 0) {
        setContainerWidthPx((prev) => (prev === width ? prev : width))
      }
    }
    updateWidth()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(updateWidth)
      observer.observe(el)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', updateWidth)
    return () => window.removeEventListener('resize', updateWidth)
  }, [])

  const expandedWidthPx = useMemo(() => {
    if (containerWidthPx <= 0) return null
    const innerWidth = Math.max(0, containerWidthPx - INPUTBAR_OUTER_SIDE_PAD_PX * 2)
    if (innerWidth <= 0) return null
    // Centered narrowed width (~80% of available width), leaving room at
    // bottom-left for TopicSegmentDrawer even on compact windows.
    return Math.round(Math.max(Math.min(280, innerWidth), Math.min(innerWidth * 0.8, innerWidth - 72)))
  }, [containerWidthPx])

  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])

  const setText = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (value) => {
      const newText = typeof value === 'function' ? value(textRef.current) : value
      onTextChange(newText)
    },
    [onTextChange]
  )

  const { handlePaste } = usePasteHandler(text, setText, {
    supportedExts,
    setFiles,
    pasteLongTextAsFile,
    pasteLongTextThreshold,
    onResize: resizeTextArea,
    t
  })

  const { handleDragEnter, handleDragLeave, handleDragOver, handleDrop, isDragging } = useFileDragDrop({
    supportedExts,
    setFiles,
    onTextDropped: (droppedText) => setText((prev) => prev + droppedText),
    enabled: config.enableDragDrop,
    t
  })
  const noContent = isEmpty && files.length === 0
  const isSendDisabled = noContent || isLoading || searching

  useEffect(() => {
    setExtensions(supportedExts)
  }, [setExtensions, supportedExts])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Tab' && inputFocus) {
        event.preventDefault()
        const textArea = textareaRef.current?.resizableTextArea?.textArea
        if (!textArea) return
        const cursorPosition = textArea.selectionStart
        const selectionLength = textArea.selectionEnd - textArea.selectionStart
        const textValue = textArea.value
        let match = textValue.slice(cursorPosition + selectionLength).match(/\$\{[^}]+\}/)
        let startIndex: number
        if (!match) {
          match = textValue.match(/\$\{[^}]+\}/)
          startIndex = match?.index ?? -1
        } else {
          startIndex = cursorPosition + selectionLength + match.index!
        }
        if (startIndex !== -1) {
          const endIndex = startIndex + match![0].length
          textArea.setSelectionRange(startIndex, endIndex)
          return
        }
      }
      const isEnterPressed = event.key === 'Enter' && !event.nativeEvent.isComposing
      if (isEnterPressed) {
        if (isSendMessageKeyPressed(event, sendMessageShortcut) && !isSendDisabled) {
          handleSendMessage()
          event.preventDefault()
          return
        }
        if (event.shiftKey) return
      }
      if (event.key === 'Backspace' && text.length === 0 && files.length > 0) {
        setFiles((prev) => prev.slice(0, -1))
        event.preventDefault()
      }
    },
    [
      inputFocus,
      text.length,
      files.length,
      textareaRef,
      sendMessageShortcut,
      isSendDisabled,
      handleSendMessage,
      setFiles
    ]
  )

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value
      setText(newText)
    },
    [setText]
  )

  const onTranslated = useCallback(
    (translatedText: string) => {
      setText(translatedText)
      setTimeoutTimer('onTranslated', () => resizeTextArea(), 0)
    },
    [resizeTextArea, setText, setTimeoutTimer]
  )

  const appendTxtContentToInput = useCallback(
    async (file: FileMetadata, event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      try {
        const targetPath = file.path
        const content = await window.api.file.readExternal(targetPath, true)
        try {
          await navigator.clipboard.writeText(content)
        } catch (clipboardError) {
          logger.warn('Failed to copy txt attachment content to clipboard:', clipboardError as Error)
        }
        setText((prev) => {
          if (!prev) return content
          const needsSeparator = !prev.endsWith('\n')
          return needsSeparator ? `${prev}\n${content}` : prev + content
        })
        setFiles((prev) => prev.filter((currentFile) => currentFile.id !== file.id))
        setTimeoutTimer(
          'appendTxtAttachment',
          () => {
            const textArea = textareaRef.current?.resizableTextArea?.textArea
            if (textArea) {
              const end = textArea.value.length
              focusTextarea()
              textArea.setSelectionRange(end, end)
            }
            resizeTextArea(true)
          },
          0
        )
      } catch (error) {
        logger.warn('Failed to append txt attachment content:', error as Error)
        window.toast.error(t('chat.input.file_error'))
      }
    },
    [focusTextarea, resizeTextArea, setFiles, setText, setTimeoutTimer, t, textareaRef]
  )

  const handleFocus = useCallback(() => {
    setInputFocus(true)
    dispatch(setSearching(false))
    PasteService.setLastFocusedComponent('inputbar')
  }, [dispatch])

  const handleDragStart = useCallback(
    (event: React.MouseEvent) => {
      if (!config.enableDragDrop) return
      startDragY.current = event.clientY
      startHeight.current = textareaRef.current?.resizableTextArea?.textArea?.offsetHeight || 0
      const handleMouseMove = (e: MouseEvent) => {
        const deltaY = startDragY.current - e.clientY
        const newHeight = Math.max(40, Math.min(500, startHeight.current + deltaY))
        onHeightChange(newHeight)
      }
      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [config.enableDragDrop, onHeightChange, textareaRef]
  )

  const onQuote = useCallback(
    (quoted: string) => {
      const formatted = formatQuotedText(quoted)
      setText((prevText) => {
        const next = prevText ? `${prevText}\n${formatted}\n` : `${formatted}\n`
        setTimeoutTimer('onQuote', () => resizeTextArea(), 0)
        return next
      })
      expandAndFocus()
    },
    [expandAndFocus, resizeTextArea, setText, setTimeoutTimer]
  )

  useEffect(() => {
    const quoteListener = window.electron?.ipcRenderer.on(IpcChannel.App_QuoteToMain, (_, selectedText: string) =>
      onQuote(selectedText)
    )
    return () => {
      quoteListener?.()
    }
  }, [onQuote])

  useEffect(() => {
    const timerId = requestAnimationFrame(() => resizeTextArea())
    return () => cancelAnimationFrame(timerId)
  }, [resizeTextArea])

  useEffect(() => {
    const onFocus = () => {
      if (!isExpandedRef.current) return
      if (document.activeElement?.closest('.ant-modal')) return
      const lastFocusedComponent = PasteService.getLastFocusedComponent()
      if (!lastFocusedComponent || lastFocusedComponent === 'inputbar') focusTextarea()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [focusTextarea, isExpandedRef])

  useEffect(() => {
    PasteService.init()
    PasteService.registerHandler('inputbar', handlePaste)
    return () => {
      PasteService.unregisterHandler('inputbar')
    }
  }, [handlePaste])

  const rightSectionExtras = useMemo(() => {
    const extras: React.ReactNode[] = []
    extras.push(
      <TranslateButton
        key="translate"
        text={text}
        disabled={isSendDisabled}
        onTranslated={onTranslated}
        isLoading={isTranslating}
      />
    )
    // Mutually exclusive composer action at a single slot: idle renders send,
    // generation renders stop. The two never coexist.
    if (isLoading) {
      extras.push(<StopGenerationButton key="stop-generation" onStop={onPause} />)
    } else {
      extras.push(<SendMessageButton key="send-message" sendMessage={handleSendMessage} disabled={isSendDisabled} />)
    }
    return <>{extras}</>
  }, [text, onTranslated, isTranslating, handleSendMessage, isSendDisabled, isLoading, onPause])

  return (
    <div style={{ width: '100%' }}>
      <Container
        ref={containerRef}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={classNames('inputbar')}>
        {pinnedContent}
        <InputBarContainer
          ref={islandRef}
          id="inputbar"
          $collapsed={!isExpanded}
          onBlurCapture={handleIslandBlurCapture}
          initial={false}
          animate={{
            width: isExpanded ? (expandedWidthPx ?? '80%') : CAPSULE_WIDTH_PX,
            height: isExpanded ? 'auto' : CAPSULE_HEIGHT_PX
          }}
          whileHover={!isExpanded ? { width: CAPSULE_HOVER_WIDTH_PX } : undefined}
          whileTap={!isExpanded ? { scale: 0.96 } : undefined}
          transition={ISLAND_TRANSITION}
          className={classNames('inputbar-container', isDragging && 'file-dragging', !isExpanded && 'is-collapsed')}>
          <ExpandedContent
            $collapsed={!isExpanded}
            $widthPx={expandedWidthPx}
            aria-hidden={!isExpanded}
            initial={false}
            animate={{
              opacity: isExpanded ? 1 : 0
            }}
            transition={{
              duration: isExpanded ? 0.16 : 0.1,
              delay: isExpanded ? 0.03 : 0,
              ease: 'linear'
            }}>
            <DragHandle onMouseDown={handleDragStart}>
              <HolderOutlined style={{ fontSize: 12 }} />
            </DragHandle>
            {topRightOverlay}
            {modelRow && <ModelRow data-testid="inputbar-model-row">{modelRow}</ModelRow>}
            {files.length > 0 && (
              <AttachmentPreview files={files} setFiles={setFiles} onAttachmentContextMenu={appendTxtContentToInput} />
            )}
            {topContent}

            <Textarea
              ref={textareaRef}
              value={text}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              onPaste={(e) => handlePaste(e.nativeEvent)}
              onFocus={handleFocus}
              onBlur={() => setInputFocus(false)}
              placeholder={isTranslating ? t('chat.input.translating') : placeholder}
              variant="borderless"
              spellCheck={enableSpellCheck}
              rows={2}
              autoSize={height ? false : { minRows: 2, maxRows: 20 }}
              styles={{ textarea: TextareaStyle }}
              style={{ fontSize, height, minHeight: '30px' }}
              disabled={isTranslating || searching}
              onClick={() => {
                searching && dispatch(setSearching(false))
              }}
            />

            <BottomBar>
              <LeftSection>
                {leftToolbar}
                <Divider type="vertical" style={{ margin: '0 6px' }} />
                <InputbarSettings />
              </LeftSection>
              <RightSection>
                {rightToolbar}
                {rightSectionExtras}
              </RightSection>
            </BottomBar>
          </ExpandedContent>

          <CapsuleTrigger
            ref={capsuleRef}
            role="button"
            data-testid="inputbar-capsule"
            aria-label={t('chat.input.expand', { defaultValue: 'Expand input' })}
            aria-hidden={isExpanded}
            tabIndex={isExpanded ? -1 : 0}
            $visible={!isExpanded}
            onClick={() => {
              if (!isExpanded) expandAndFocus()
            }}
            initial={false}
            animate={{
              opacity: isExpanded ? 0 : 1
            }}
            transition={{
              duration: isExpanded ? 0.08 : 0.14,
              delay: isExpanded ? 0 : 0.04,
              ease: 'linear'
            }}>
            <CapsuleBar />
          </CapsuleTrigger>
        </InputBarContainer>
      </Container>
    </div>
  )
}

// Styled Components
const DragHandle = styled.div`
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  color: var(--color-icon);
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 1;
  &:hover {
    opacity: 1;
  }
  .anticon {
    transform: rotate(90deg);
    font-size: 14px;
  }
`

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  z-index: 2;
  pointer-events: none;
  // Single window-bottom gap: 12px between the composer outer box and the
  // canvas bottom edge (sides keep the nav-rail geometry constant). The
  // plane itself sits at bottom:0, so this padding is the only owner of the
  // gap, and the overlay measurement includes it exactly once. Never folded
  // into the floating-control band: gap is spacing, band is trigger strip.
  padding: 0 ${INPUTBAR_OUTER_SIDE_PAD_PX}px 12px ${INPUTBAR_OUTER_SIDE_PAD_PX}px;
`

const InputBarContainer = styled(motion.div)<{ $collapsed?: boolean }>`
  // Non-draggable content island: only the top titlebar bands drag; the
  // inputbar (model controls, tools) never does.
  -webkit-app-region: none;
  pointer-events: auto;
  margin: 0 auto;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 0.5px solid transparent;
  transition:
    background 0.18s linear,
    border-color 0.18s linear,
    border-radius 0.18s linear,
    padding-top 0.18s linear,
    backdrop-filter 0.18s linear;
  position: relative;
  // One plate, one radius: same token as the assistant-switcher panel, so
  // all four plate corners share one uniform arc; ModelRow/textarea/
  // BottomBar all live inside this plate, never floating on their own.
  border-radius: var(--list-item-border-radius);
  padding-top: ${(props) => (props.$collapsed ? '0' : '6px')};
  background: ${(props) =>
    props.$collapsed
      ? 'linear-gradient(180deg, rgba(34, 34, 36, 0.48) 0%, rgba(24, 24, 26, 0.44) 100%)'
      : 'linear-gradient(180deg, rgba(34, 34, 36, 0.72) 0%, rgba(24, 24, 26, 0.68) 100%)'};
  backdrop-filter: ${(props) => (props.$collapsed ? 'blur(18px) saturate(180%)' : 'blur(22px) saturate(180%)')};
  -webkit-backdrop-filter: ${(props) => (props.$collapsed ? 'blur(18px) saturate(180%)' : 'blur(22px) saturate(180%)')};
  ${(props) => (props.$collapsed ? 'border-radius: 9999px; cursor: pointer;' : '')}
  body[theme-mode='light'] & {
    background: ${(props) =>
      props.$collapsed
        ? 'linear-gradient(180deg, rgba(246, 246, 248, 0.66) 0%, rgba(232, 232, 236, 0.56) 100%)'
        : 'linear-gradient(180deg, rgba(250, 250, 252, 0.78) 0%, rgba(238, 238, 242, 0.72) 100%)'};
    backdrop-filter: ${(props) => (props.$collapsed ? 'blur(16px) saturate(160%)' : 'blur(22px) saturate(160%)')};
    -webkit-backdrop-filter: ${(props) => (props.$collapsed ? 'blur(16px) saturate(160%)' : 'blur(22px) saturate(160%)')};
  }
  // Unified directional 1px glass rim across both capsule and expanded composer
  // so the two states feel like one continuous piece of glass (no box-shadow).
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    pointer-events: none;
    z-index: 4;
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.16) 0%,
      rgba(255, 255, 255, 0.05) 48%,
      rgba(255, 255, 255, 0.015) 100%
    );
    -webkit-mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    mask-composite: exclude;
  }
  body[theme-mode='light'] &::after {
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.95) 0%,
      rgba(0, 0, 0, 0.05) 55%,
      rgba(0, 0, 0, 0.11) 100%
    );
  }
  &.file-dragging {
    border: 2px dashed #2ecc71;
    &::after {
      display: none;
    }
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: rgba(46, 204, 113, 0.03);
      border-radius: var(--list-item-border-radius);
      z-index: 5;
      pointer-events: none;
    }
  }
`

const ExpandedContent = styled(motion.div)<{ $collapsed?: boolean; $widthPx: number | null }>`
  width: ${(props) => (props.$widthPx ? `${props.$widthPx}px` : '100%')};
  flex-shrink: 0;
  pointer-events: ${(props) => (props.$collapsed ? 'none' : 'auto')};
  visibility: ${(props) => (props.$collapsed ? 'hidden' : 'visible')};
  transition: visibility 0s linear ${(props) => (props.$collapsed ? '0.15s' : '0s')};
`

const CapsuleBar = styled.span`
  display: block;
  width: 36px;
  height: 3.5px;
  border-radius: 9999px;
  background-color: rgba(255, 255, 255, 0.52);
  transition: width 0.2s ease, background-color 0.2s ease;
  body[theme-mode='light'] & {
    background-color: rgba(0, 0, 0, 0.36);
  }
`

const CapsuleTrigger = styled(motion.div)<{ $visible: boolean }>`
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: ${(props) => (props.$visible ? 'auto' : 'none')};
  cursor: pointer;
  outline: none;
  &:hover ${CapsuleBar}, &:focus-visible ${CapsuleBar} {
    width: 44px;
    background-color: rgba(255, 255, 255, 0.88);
  }
  body[theme-mode='light'] &:hover ${CapsuleBar}, body[theme-mode='light'] &:focus-visible ${CapsuleBar} {
    background-color: rgba(0, 0, 0, 0.68);
  }
`

const Textarea = styled(TextArea)`
  // Single paint owner: the plate (InputBarContainer) owns the only solid
  // background. This textarea and its inner .ant-input stay transparent on
  // all states so no square inner layer intrudes on the plate arcs; text,
  // resize and selection behavior untouched.
  background-color: transparent;
  padding: 0;
  border-radius: 0;
  display: flex;
  resize: none !important;
  overflow: auto;
  width: 100%;
  box-sizing: border-box;
  transition: none !important;
  &.ant-input {
    line-height: 1.4;
    background-color: transparent;
  }
  &.ant-input:hover,
  &.ant-input:focus,
  &.ant-input:focus-within,
  textarea.ant-input:hover,
  textarea.ant-input:focus {
    background-color: transparent;
  }
  &::-webkit-scrollbar {
    width: 3px;
  }
`

const BottomBar = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  padding: 3px 8px;
  height: 34px;
  gap: 16px;
  position: relative;
  z-index: 2;
  flex-shrink: 0;
`

// Independent model row: the single-model selector owns this slim row at the
// composer top (icon + current model name + chevron), clear of the crowded
// 28px toolbar slots below the textarea.
const ModelRow = styled.div`
  // Single paint owner: transparent so the plate shows through; the plate
  // keeps the only solid background.
  background-color: transparent;
  display: flex;
  align-items: center;
  min-height: 30px;
  padding: 0 8px;
  flex-shrink: 0;
`

const LeftSection = styled.div`
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
`

const RightSection = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
`
