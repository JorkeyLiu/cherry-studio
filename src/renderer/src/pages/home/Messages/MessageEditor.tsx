import { loggerService } from '@logger'
import { ActionIconButton } from '@renderer/components/Buttons'
import CustomTag from '@renderer/components/Tags/CustomTag'
import TranslateButton from '@renderer/components/TranslateButton'
import { isGenerateImageModel, isVisionModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useSettings } from '@renderer/hooks/useSettings'
import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import FileManager from '@renderer/services/FileManager'
import PasteService from '@renderer/services/PasteService'
import { useAppSelector } from '@renderer/store'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { FileMetadata } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { classNames } from '@renderer/utils'
import { getFilesFromDropEvent, isSendMessageKeyPressed } from '@renderer/utils/input'
import { createMainTextBlock } from '@renderer/utils/messageUtils/create'
import { findAllBlocks, isAssistantInterruptedThinkingOnlyMessage } from '@renderer/utils/messageUtils/find'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import { Tooltip } from 'antd'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import TextArea from 'antd/es/input/TextArea'
import { Save, Send, X } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { FileNameRender, getFileIcon } from '../Inputbar/AttachmentPreview'
import AttachmentButton from '../Inputbar/tools/components/AttachmentButton'
import { releaseStagedAttachmentUploads, stageAttachmentUploads } from './MessageEditorAttachmentUpload'

interface Props {
  message: Message
  topicId: string
  onSave: (blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => void | Promise<void>
  onResend: (blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => void | Promise<void>
  onCancel: () => void
}

type AttachmentOwnershipState = 'staged' | 'inFlight' | 'committed' | 'removing'

const MAX_RELEASE_RETRIES = 3

interface OwnedAttachment {
  file: FileMetadata
  state: AttachmentOwnershipState
  operationId?: number
}

interface PersistenceOperation {
  id: number
  blockIds: Set<string>
  settled: boolean
}

const logger = loggerService.withContext('MessageBlockEditor')

const getInitialEditableBlocks = (message: Message) => {
  const allBlocks = findAllBlocks(message)

  if (
    !allBlocks.some((block) => block.type === MessageBlockType.MAIN_TEXT) &&
    isAssistantInterruptedThinkingOnlyMessage(message)
  ) {
    return [
      ...allBlocks,
      createMainTextBlock(message.id, '', {
        model: message.model,
        status: MessageBlockStatus.SUCCESS
      })
    ]
  }

  return allBlocks
}

const MessageBlockEditor: FC<Props> = ({ message, topicId, onSave, onResend, onCancel }) => {
  const [editedBlocks, setEditedBlocks] = useState<MessageBlock[]>(() => getInitialEditableBlocks(message))
  const [files, setFiles] = useState<FileMetadata[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [isFileDragging, setIsFileDragging] = useState(false)
  const editedBlocksRef = useRef(editedBlocks)
  const attachmentsRef = useRef(new Map<string, OwnedAttachment>())
  const persistenceOperationIdRef = useRef(0)
  const persistenceOperationsRef = useRef(new Map<number, PersistenceOperation>())
  const isProcessingRef = useRef(false)
  const isRemovingRef = useRef(false)
  const isMountedRef = useRef(true)
  const isCancelledRef = useRef(false)
  const releaseEditorOwnedAttachmentsRef = useRef<() => void>(() => {})
  const { assistant } = useAssistant(message.assistantId)
  const model = assistant.model || assistant.defaultModel
  const { pasteLongTextAsFile, pasteLongTextThreshold, fontSize, sendMessageShortcut, enableSpellCheck } = useSettings()
  const { t } = useTranslation()
  const textareaRef = useRef<TextAreaRef>(null)
  const isUserMessage = message.role === 'user'

  const topicMessages = useAppSelector((state) => selectMessagesForTopic(state, topicId))

  const noopQuickPanel = useMemo<ToolQuickPanelApi>(
    () => ({
      registerRootMenu: () => () => {},
      registerTrigger: () => () => {}
    }),
    []
  )

  const couldAddImageFile = useMemo(() => {
    const relatedAssistantMessages = topicMessages.filter((m) => m.askId === message.id && m.role === 'assistant')
    if (relatedAssistantMessages.length === 0) {
      // 无关联消息时fallback到助手模型
      return isVisionModel(model)
    }
    return relatedAssistantMessages.every((m) => {
      if (m.model) {
        return isVisionModel(m.model) || isGenerateImageModel(m.model)
      } else {
        // 若消息关联不存在的模型，视为其支持视觉
        return true
      }
    })
  }, [message.id, model, topicMessages])

  const couldAddTextFile = useMemo(() => {
    const relatedAssistantMessages = topicMessages.filter((m) => m.askId === message.id && m.role === 'assistant')
    if (relatedAssistantMessages.length === 0) {
      // 无关联消息时fallback到助手模型
      return isVisionModel(model) || (!isVisionModel(model) && !isGenerateImageModel(model))
    }
    return relatedAssistantMessages.every((m) => {
      if (m.model) {
        return isVisionModel(m.model) || (!isVisionModel(m.model) && !isGenerateImageModel(m.model))
      } else {
        // 若消息关联不存在的模型，视为其支持文本
        return true
      }
    })
  }, [message.id, model, topicMessages])

  const extensions = useMemo(() => {
    if (couldAddImageFile && couldAddTextFile) {
      return [...imageExts, ...documentExts, ...textExts]
    } else if (couldAddImageFile) {
      return [...imageExts]
    } else if (couldAddTextFile) {
      return [...documentExts, ...textExts]
    } else {
      return []
    }
  }, [couldAddImageFile, couldAddTextFile])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus({ cursor: 'end' })
      }
    }, 0)

    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    return () => {
      isMountedRef.current = false
      isCancelledRef.current = true
      releaseEditorOwnedAttachmentsRef.current()
    }
  }, [])

  // 仅在打开时执行一次
  useEffect(() => {
    if (textareaRef.current) {
      const realTextarea = textareaRef.current.resizableTextArea?.textArea
      if (realTextarea) {
        realTextarea.scrollTo({ top: realTextarea.scrollHeight })
      }
      textareaRef.current.focus({ cursor: 'end' })
    }
  }, [])

  const onPaste = useCallback(
    async (event: ClipboardEvent) => {
      return await PasteService.handlePaste(
        event,
        extensions,
        setFiles,
        undefined, // 不需要setText
        pasteLongTextAsFile,
        pasteLongTextThreshold,
        undefined, // 不需要text
        undefined, // 不需要 resizeTextArea
        t
      )
    },
    [extensions, pasteLongTextThreshold, t, pasteLongTextAsFile]
  )

  // 添加全局粘贴事件处理
  useEffect(() => {
    PasteService.registerHandler('messageEditor', onPaste)
    PasteService.setLastFocusedComponent('messageEditor')

    return () => {
      PasteService.unregisterHandler('messageEditor')
    }
  }, [onPaste])

  const handleTextChange = (blockId: string, content: string) => {
    const nextBlocks = editedBlocksRef.current.map((block) => (block.id === blockId ? { ...block, content } : block))
    setEditedBlocksSynchronously(nextBlocks)
  }

  const onTranslated = (translatedText: string) => {
    const mainTextBlock = editedBlocks.find((b) => b.type === MessageBlockType.MAIN_TEXT)
    if (mainTextBlock) {
      handleTextChange(mainTextBlock.id, translatedText)
    }
  }

  const setEditedBlocksSynchronously = (nextBlocks: MessageBlock[]) => {
    editedBlocksRef.current = nextBlocks
    setEditedBlocks(nextBlocks)
  }

  const releaseAttachments = (attachments: Map<string, OwnedAttachment>, attempt = 0) => {
    if (attachments.size === 0) return

    attachments.forEach((attachment, blockId) => {
      attachment.state = 'removing'
      attachment.operationId = undefined
      attachmentsRef.current.set(blockId, attachment)
    })

    const files = new Map([...attachments].map(([blockId, attachment]) => [blockId, attachment.file]))
    void releaseStagedAttachmentUploads(files)
      .then(() => {
        attachments.forEach((_attachment, blockId) => {
          const currentAttachment = attachmentsRef.current.get(blockId)
          if (currentAttachment?.state === 'removing') {
            attachmentsRef.current.delete(blockId)
          }
        })
      })
      .catch((error) => {
        logger.error('Failed to release message editor attachments:', error as Error)

        // After releaseStagedAttachmentUploads rejects, `files` retains only
        // entries whose FileManager.deleteFile failed — successful entries were
        // removed from the map inside releaseStagedAttachmentUploads.
        const failed = new Map<string, OwnedAttachment>()
        attachments.forEach((_attachment, blockId) => {
          const currentAttachment = attachmentsRef.current.get(blockId)
          if (!currentAttachment || currentAttachment.state !== 'removing') return

          if (files.has(blockId)) {
            // Deletion failed — restore to staged for retry (LOCK-001)
            currentAttachment.state = 'staged'
            failed.set(blockId, currentAttachment)
          } else {
            // Deletion succeeded — clean orphan from attachmentsRef.current
            attachmentsRef.current.delete(blockId)
          }
        })

        // Bounded retry (LOCK-002/LOCK-003)
        if (failed.size > 0 && attempt < MAX_RELEASE_RETRIES) {
          const delay = 500 * (attempt + 1)
          setTimeout(() => releaseAttachments(failed, attempt + 1), delay)
        } else if (failed.size > 0) {
          logger.error(
            `Attachment ownership retained after ${attempt + 1} release attempts for: [${[...failed.keys()].join(', ')}]`
          )
        }
      })
  }

  const releaseEditorOwnedAttachments = () => {
    const releasableAttachments = new Map(
      [...attachmentsRef.current].filter(([, attachment]) => attachment.state === 'staged')
    )
    releaseAttachments(releasableAttachments)
  }
  releaseEditorOwnedAttachmentsRef.current = releaseEditorOwnedAttachments

  const beginPersistence = (blocks: MessageBlock[]): PersistenceOperation => {
    const operation: PersistenceOperation = {
      id: ++persistenceOperationIdRef.current,
      blockIds: new Set(),
      settled: false
    }

    const blockIds = new Set(blocks.map((block) => block.id))
    attachmentsRef.current.forEach((attachment, blockId) => {
      if (attachment.state === 'staged' && blockIds.has(blockId)) {
        attachment.state = 'inFlight'
        attachment.operationId = operation.id
        operation.blockIds.add(blockId)
      }
    })

    persistenceOperationsRef.current.set(operation.id, operation)
    return operation
  }

  const commitPersistence = (operation: PersistenceOperation, blockIds: readonly string[]) => {
    if (operation.settled) return

    blockIds.forEach((blockId) => {
      if (!operation.blockIds.has(blockId)) return
      const attachment = attachmentsRef.current.get(blockId)
      if (attachment?.state === 'inFlight' && attachment.operationId === operation.id) {
        attachment.state = 'committed'
        attachment.operationId = undefined
      }
    })
  }

  const settlePersistence = (operation: PersistenceOperation) => {
    if (operation.settled) return
    operation.settled = true
    persistenceOperationsRef.current.delete(operation.id)

    const releasableAttachments = new Map<string, OwnedAttachment>()
    operation.blockIds.forEach((blockId) => {
      const attachment = attachmentsRef.current.get(blockId)
      if (!attachment || attachment.state !== 'inFlight' || attachment.operationId !== operation.id) return

      attachment.operationId = undefined
      if (isMountedRef.current && !isCancelledRef.current) {
        attachment.state = 'staged'
      } else {
        releasableAttachments.set(blockId, attachment)
      }
    })

    releaseAttachments(releasableAttachments)
  }

  // 处理文件删除
  const handleFileRemove = async (blockId: string) => {
    if (isProcessingRef.current || isRemovingRef.current) return

    const blockIndex = editedBlocksRef.current.findIndex((block) => block.id === blockId)
    if (blockIndex < 0) return

    const block = editedBlocksRef.current[blockIndex]
    const attachment = attachmentsRef.current.get(blockId)
    if (attachment?.state === 'inFlight' || attachment?.state === 'removing') return

    const nextBlocks = editedBlocksRef.current.filter((candidate) => candidate.id !== blockId)
    setEditedBlocksSynchronously(nextBlocks)
    isRemovingRef.current = true
    setIsRemoving(true)

    if (!attachment) {
      isRemovingRef.current = false
      setIsRemoving(false)
      return
    }

    if (attachment.state !== 'staged') {
      isRemovingRef.current = false
      setIsRemoving(false)
      return
    }

    const previousState = attachment.state
    attachment.state = 'removing'
    attachment.operationId = undefined

    try {
      await FileManager.deleteFile(attachment.file.id)
      if (attachmentsRef.current.get(blockId) === attachment) {
        attachmentsRef.current.delete(blockId)
      }
    } catch (error) {
      if (isMountedRef.current && !isCancelledRef.current) {
        // Mounted: restore retryable staged ownership + UI (LOCK-001)
        attachment.state = previousState
        const restoredBlocks = [...editedBlocksRef.current]
        restoredBlocks.splice(Math.min(blockIndex, restoredBlocks.length), 0, block)
        setEditedBlocksSynchronously(restoredBlocks)
        window.toast?.error(t('common.delete_failed'))
      } else {
        // After unmount: don't restore editor state; keep ownership, schedule bounded retry (LOCK-002)
        const retryRelease = (attempt: number) => {
          if (attempt >= MAX_RELEASE_RETRIES) {
            logger.error(
              `Attachment ownership retained after ${attempt} removal attempts for file: ${attachment.file.id}`
            )
            return
          }
          const currentAttachment = attachmentsRef.current.get(blockId)
          if (!currentAttachment || currentAttachment !== attachment) return
          if (currentAttachment.state !== 'removing') return

          const delay = 500 * (attempt + 1)
          setTimeout(() => {
            FileManager.deleteFile(attachment.file.id)
              .then(() => {
                if (attachmentsRef.current.get(blockId) === attachment) {
                  attachmentsRef.current.delete(blockId)
                }
              })
              .catch(() => {
                retryRelease(attempt + 1)
              })
          }, delay)
        }
        retryRelease(0)
      }
      logger.error('Failed to remove message editor attachment:', error as Error)
    } finally {
      isRemovingRef.current = false
      if (isMountedRef.current) setIsRemoving(false)
    }
  }

  // 处理拖拽上传
  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsFileDragging(false)

    const files = await getFilesFromDropEvent(e).catch((err) => {
      logger.error('[src/renderer/src/pages/home/Inputbar/Inputbar.tsx] handleDrop:', err)
      return null
    })
    if (files) {
      let supportedFiles = 0
      files.forEach((file) => {
        if (extensions.includes(file.ext.toLowerCase())) {
          setFiles((prevFiles) => [...prevFiles, file])
          supportedFiles++
        }
      })

      // 如果有文件，但都不支持
      if (files.length > 0 && supportedFiles === 0) {
        window.toast.info(t('chat.input.file_not_supported'))
      }
    }
  }

  // 处理编辑区块并上传文件
  const processEditedBlocks = async () => {
    const result = await stageAttachmentUploads(message.id, editedBlocksRef.current, files)

    if (isCancelledRef.current) {
      const cancelledUploads = new Map(
        result.stagedUploads.map(({ block, file }) => [block.id, { file, state: 'staged' as const }])
      )
      cancelledUploads.forEach((attachment, blockId) => attachmentsRef.current.set(blockId, attachment))
      releaseAttachments(cancelledUploads)
      throw new Error('Message editor attachment upload cancelled')
    }

    if (result.stagedUploads.length > 0) {
      result.stagedUploads.forEach(({ block, file }) => {
        attachmentsRef.current.set(block.id, { file, state: 'staged' })
      })
      setEditedBlocksSynchronously(result.blocks)
      const remainingFileIds = new Set(result.remainingFiles.map((file) => file.id))
      setFiles((pendingFiles) => pendingFiles.filter((file) => remainingFileIds.has(file.id)))
    }

    if (result.error) {
      logger.error('Failed to upload one or more message attachments:', result.error as Error)
      throw result.error
    }

    return result.blocks
  }

  const handleSave = async () => {
    if (isProcessingRef.current || isRemovingRef.current) return
    isProcessingRef.current = true
    setIsProcessing(true)
    try {
      const updatedBlocks = await processEditedBlocks()
      const operation = beginPersistence(updatedBlocks)
      try {
        await onSave(updatedBlocks, (blockIds) => commitPersistence(operation, blockIds))
      } finally {
        settlePersistence(operation)
      }
    } catch {
      // Persistence failed — keep editor open, reset processing state so user can retry
      isProcessingRef.current = false
      setIsProcessing(false)
    }
  }

  const handleResend = async () => {
    if (isProcessingRef.current || isRemovingRef.current) return
    isProcessingRef.current = true
    setIsProcessing(true)
    try {
      const updatedBlocks = await processEditedBlocks()
      const operation = beginPersistence(updatedBlocks)
      try {
        await onResend(updatedBlocks, (blockIds) => commitPersistence(operation, blockIds))
      } finally {
        settlePersistence(operation)
      }
    } catch {
      // Persistence failed — keep editor open, reset processing state so user can retry
      isProcessingRef.current = false
      setIsProcessing(false)
    }
  }

  const handleCancel = () => {
    if (isProcessingRef.current || isRemovingRef.current) return
    isCancelledRef.current = true
    releaseEditorOwnedAttachments()
    onCancel()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (message.role !== 'user' || isProcessingRef.current || isRemovingRef.current) {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      handleCancel()
      return
    }

    // keep the same enter behavior as inputbar
    const isEnterPressed = event.key === 'Enter' && !event.nativeEvent.isComposing
    if (isEnterPressed) {
      if (isSendMessageKeyPressed(event, sendMessageShortcut)) {
        void handleResend()
        return event.preventDefault()
      }
    }
  }

  return (
    <div className="message-editor-area">
      <EditorContainer
        className={classNames('message-editor', `message-editor-${message.role}`, isFileDragging && 'file-dragging')}
        onDragEnter={() => setIsFileDragging(true)}
        onDragOver={(e) => {
          e.preventDefault()
          setIsFileDragging(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setIsFileDragging(false)
          }
        }}
        onDrop={handleDrop}>
        <EditorSurface>
          <EditorBody>
            {editedBlocks
              .filter((block) => block.type === MessageBlockType.MAIN_TEXT)
              .map((block) => (
                <TextArea
                  className="editing-message"
                  key={block.id}
                  ref={textareaRef}
                  variant="borderless"
                  value={block.content}
                  onChange={(e) => {
                    handleTextChange(block.id, e.target.value)
                  }}
                  onKeyDown={handleKeyDown}
                  autoFocus
                  spellCheck={enableSpellCheck}
                  onPaste={(e) => onPaste(e.nativeEvent)}
                  onFocus={() => {
                    // 记录当前聚焦的组件
                    PasteService.setLastFocusedComponent('messageEditor')
                  }}
                  onContextMenu={(e) => {
                    // 阻止事件冒泡，避免触发全局的 Electron contextMenu
                    e.stopPropagation()
                  }}
                  autoSize={{ minRows: 2, maxRows: 15 }}
                  style={{
                    fontSize
                  }}>
                  <TranslateButton onTranslated={onTranslated} />
                </TextArea>
              ))}
            {(editedBlocks.some(
              (block) => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE
            ) ||
              files.length > 0) && (
              <FileBlocksContainer>
                {editedBlocks
                  .filter((block) => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE)
                  .map(
                    (block) =>
                      block.file && (
                        <CustomTag
                          key={block.id}
                          icon={getFileIcon(block.file.ext)}
                          color="#37a5aa"
                          closable
                          disabled={isProcessing || isRemoving}
                          onClose={() => handleFileRemove(block.id)}>
                          <FileNameRender file={block.file} />
                        </CustomTag>
                      )
                  )}

                {files.map((file) => (
                  <CustomTag
                    key={file.id}
                    icon={getFileIcon(file.ext)}
                    color="#37a5aa"
                    closable
                    onClose={() => setFiles((prevFiles) => prevFiles.filter((f) => f.id !== file.id))}>
                    <FileNameRender file={file} />
                  </CustomTag>
                ))}
              </FileBlocksContainer>
            )}
          </EditorBody>
          <ActionBar>
            <ActionBarLeft>
              {isUserMessage && (
                <AttachmentButton
                  quickPanel={noopQuickPanel}
                  files={files}
                  setFiles={setFiles}
                  couldAddImageFile={couldAddImageFile}
                  extensions={extensions}
                  disabled={isProcessing}
                />
              )}
            </ActionBarLeft>
            <ActionBarRight>
              <Tooltip title={t('common.cancel')}>
                <ActionIconButton
                  onClick={handleCancel}
                  disabled={isProcessing || isRemoving}
                  aria-label={t('common.cancel')}>
                  <X size={16} />
                </ActionIconButton>
              </Tooltip>
              <Tooltip title={t('common.save')}>
                <ActionIconButton
                  className="message-editor-save-btn"
                  onClick={handleSave}
                  disabled={isProcessing || isRemoving}
                  aria-label={t('common.save')}>
                  <Save size={16} />
                </ActionIconButton>
              </Tooltip>
              {message.role === 'user' && (
                <Tooltip title={t('chat.resend')}>
                  <ActionIconButton
                    className="primary-action message-editor-resend-btn"
                    onClick={handleResend}
                    disabled={isProcessing || isRemoving}
                    aria-label={t('chat.resend')}>
                    <Send size={16} />
                  </ActionIconButton>
                </Tooltip>
              )}
            </ActionBarRight>
          </ActionBar>
        </EditorSurface>
      </EditorContainer>
    </div>
  )
}

const EditorContainer = styled.div`
  width: calc(100% - 46px);
  margin: 0 0 0 46px;
  transition: all 0.2s ease;

  .bubble:not(.multi-select-mode) .message-user & {
    width: min(760px, calc(100% - 45px));
    margin: 0 45px 0 auto;
  }

  .horizontal &,
  .grid &,
  .in-popover &,
  .multi-select-mode & {
    width: 100%;
    margin-left: 0;
    margin-right: 0;
  }
`

const EditorSurface = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border: 0.5px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-background);
  box-shadow: 0 0 0 1px transparent;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background-color 0.2s ease;

  .bubble:not(.multi-select-mode) .message-user & {
    background: var(--chat-background-user);
  }

  .message-editor.file-dragging & {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 18%, transparent);

    &::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      background: color-mix(in srgb, var(--color-primary) 7%, transparent);
    }
  }
`

const EditorBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px 8px;

  .editing-message {
    width: 100%;
    padding: 0;
    resize: none !important;
    overflow: auto;
    border-radius: 0;
    background: transparent;
    color: var(--color-text);
    font-family: inherit;
    box-sizing: border-box;

    &.ant-input {
      line-height: 1.6;
    }

    &:focus {
      box-shadow: none;
    }
  }
`

const FileBlocksContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  padding-top: 2px;
`

const ActionBar = styled.div`
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px;
  border-top: 0.5px solid var(--color-border-soft);
  background: color-mix(in srgb, var(--color-background) 78%, transparent);

  .bubble:not(.multi-select-mode) .message-user & {
    background: color-mix(in srgb, var(--chat-background-user) 82%, var(--color-background));
  }
`

const ActionBarLeft = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
`

const ActionBarRight = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;

  .primary-action {
    .lucide {
      color: var(--color-primary);
    }
  }
`

export default memo(MessageBlockEditor)
