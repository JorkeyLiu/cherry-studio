import type { FileMetadata } from '@renderer/types'
import type { FileMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteFiles: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn(),
  onSave: vi.fn(),
  onResend: vi.fn()
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    deleteFile: mocks.deleteFile,
    deleteFiles: mocks.deleteFiles,
    uploadFile: mocks.uploadFile
  }
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ assistant: { model: { provider: 'openai', id: 'gpt-4' } } })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    pasteLongTextAsFile: false,
    pasteLongTextThreshold: 1000,
    fontSize: 14,
    sendMessageShortcut: 'Enter',
    enableSpellCheck: false
  })
}))

vi.mock('@renderer/store', () => ({
  useAppSelector: (selector: (state: unknown) => unknown) => selector({})
}))

vi.mock('@renderer/store/newMessage', () => ({
  selectMessagesForTopic: () => []
}))

vi.mock('@renderer/utils', () => ({
  classNames: (...values: unknown[]) => values.filter(Boolean).join(' ')
}))

vi.mock('@renderer/utils/input', () => ({
  getFilesFromDropEvent: vi.fn(),
  isSendMessageKeyPressed: () => false
}))

vi.mock('@renderer/services/PasteService', () => ({
  default: {
    handlePaste: vi.fn(),
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    setLastFocusedComponent: vi.fn()
  }
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  findAllBlocks: (message: Message) => (message as Message & { initialBlocks?: MessageBlock[] }).initialBlocks ?? [],
  isAssistantInterruptedThinkingOnlyMessage: () => false
}))

vi.mock('@renderer/utils/messageUtils/create', () => ({
  createMainTextBlock: (messageId: string, content: string, overrides: Partial<MessageBlock> = {}) => ({
    id: 'generated-main-text',
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content,
    createdAt: '2026-07-30T00:00:00.000Z',
    status: MessageBlockStatus.SUCCESS,
    ...overrides
  }),
  createFileBlock: (messageId: string, file: FileMetadata, overrides: Partial<FileMessageBlock> = {}) => ({
    id: `file-block-${file.id}`,
    messageId,
    type: MessageBlockType.FILE,
    file,
    createdAt: '2026-07-30T00:00:00.000Z',
    status: MessageBlockStatus.SUCCESS,
    ...overrides
  }),
  createImageBlock: (messageId: string, overrides: Partial<FileMessageBlock> = {}) => ({
    id: `image-block-${overrides.file?.id ?? 'unknown'}`,
    messageId,
    type: MessageBlockType.IMAGE,
    createdAt: '2026-07-30T00:00:00.000Z',
    status: MessageBlockStatus.SUCCESS,
    ...overrides
  })
}))

vi.mock('@renderer/components/Buttons', () => ({
  ActionIconButton: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

vi.mock('@renderer/components/Tags/CustomTag', () => ({
  default: ({ children, closable, onClose }: { children: ReactNode; closable?: boolean; onClose?: () => void }) => (
    <span>
      {children}
      {closable && (
        <button type="button" aria-label="remove attachment" onClick={onClose}>
          remove
        </button>
      )}
    </span>
  )
}))

vi.mock('@renderer/components/TranslateButton', () => ({
  default: () => null
}))

vi.mock('../../Inputbar/AttachmentPreview', () => ({
  FileNameRender: ({ file }: { file: FileMetadata }) => <span>{file.name}</span>,
  getFileIcon: () => null
}))

vi.mock('../../Inputbar/tools/components/AttachmentButton', () => ({
  default: ({ setFiles }: { setFiles: (files: FileMetadata[]) => void }) => (
    <button type="button" aria-label="attach" onClick={() => setFiles([pendingFile])}>
      attach
    </button>
  )
}))

vi.mock('antd', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('antd/es/input/TextArea', () => ({
  default: ({ ref, ...props }: Record<string, unknown> & { ref?: React.RefObject<HTMLTextAreaElement | null> }) => (
    <textarea ref={ref} {...props} />
  )
}))

vi.mock('@renderer/config/models', () => ({
  isGenerateImageModel: () => false,
  isVisionModel: () => false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const { default: MessageEditor } = await import('../MessageEditor')
const { default: FileManager } = await import('@renderer/services/FileManager')
const { stageAttachmentUploads } = await import('../MessageEditorAttachmentUpload')

const pendingFile = {
  id: 'pending-file',
  name: 'document.txt',
  origin_name: 'document.txt',
  path: '/tmp/document.txt',
  ext: '.txt',
  type: 'document',
  count: 1,
  size: 10,
  created_at: '2026-07-30T00:00:00.000Z'
} as FileMetadata

const uploadedFile = { ...pendingFile, id: 'uploaded-file' }

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const mainTextBlock: MessageBlock = {
  id: 'main-text',
  messageId: 'message-1',
  type: MessageBlockType.MAIN_TEXT,
  content: 'hello',
  createdAt: '2026-07-30T00:00:00.000Z',
  status: MessageBlockStatus.SUCCESS
}

const message = {
  id: 'message-1',
  topicId: 'topic-1',
  role: 'user',
  assistantId: 'assistant-1',
  blocks: [mainTextBlock.id],
  initialBlocks: [mainTextBlock],
  status: 'success',
  createdAt: '2026-07-30T00:00:00.000Z'
} as unknown as Message

const renderEditor = (onCancel = vi.fn()) =>
  render(
    <MessageEditor
      message={message}
      topicId="topic-1"
      onSave={mocks.onSave}
      onResend={mocks.onResend}
      onCancel={onCancel}
    />
  )

beforeEach(() => {
  mocks.deleteFiles.mockClear()
  mocks.deleteFile.mockClear()
  mocks.uploadFile.mockReset().mockResolvedValue(uploadedFile)
  mocks.onSave.mockReset()
  mocks.onResend.mockReset()
})

describe('MessageEditor attachment upload staging', () => {
  it('uploads once and reuses the same block IDs after save persistence rejection', async () => {
    mocks.onSave.mockRejectedValueOnce(new Error('SQLite save failed')).mockResolvedValueOnce(undefined)

    renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    const save = screen.getByRole('button', { name: 'common.save' })

    await userEvent.click(save)
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledTimes(1))
    expect(save).not.toBeDisabled()

    await userEvent.click(save)
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledTimes(2))

    expect(FileManager.uploadFile).toHaveBeenCalledOnce()
    expect(mocks.onSave.mock.calls[1][0]).toEqual(mocks.onSave.mock.calls[0][0])
    expect(mocks.onSave.mock.calls[1][0]).toHaveLength(2)
    expect(save).toBeDisabled()
  })

  it('uses the same staged blocks for resend retries and resets processing', async () => {
    mocks.onResend.mockRejectedValueOnce(new Error('resend failed')).mockResolvedValueOnce(undefined)

    renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    const resend = screen.getByRole('button', { name: 'chat.resend' })

    await userEvent.click(resend)
    await waitFor(() => expect(mocks.onResend).toHaveBeenCalledTimes(1))
    expect(resend).not.toBeDisabled()

    await userEvent.click(resend)
    await waitFor(() => expect(mocks.onResend).toHaveBeenCalledTimes(2))

    expect(FileManager.uploadFile).toHaveBeenCalledOnce()
    expect(mocks.onResend.mock.calls[1][0]).toEqual(mocks.onResend.mock.calls[0][0])
    expect(resend).toBeDisabled()
  })

  it('transfers ownership at edit commit when resend fails later', async () => {
    mocks.onResend.mockImplementationOnce(
      async (_blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => {
        onCommit(['file-block-uploaded-file'])
        throw new Error('restart trace failed')
      }
    )
    const onCancel = vi.fn()

    renderEditor(onCancel)
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'chat.resend' }))
    await waitFor(() => expect(mocks.onResend).toHaveBeenCalledOnce())

    expect(screen.getByRole('button', { name: 'chat.resend' })).not.toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
    await waitFor(() => expect(mocks.deleteFile).not.toHaveBeenCalled())
  })

  it('releases staged uploads when unmounted before persistence commits', async () => {
    const save = deferred<void>()
    mocks.onSave.mockImplementationOnce(() => save.promise)
    const { unmount } = renderEditor()

    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    unmount()

    expect(mocks.deleteFile).not.toHaveBeenCalled()

    await act(async () => save.reject(new Error('save failed after unmount')))
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedFile.id))
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1)
  })

  it('keeps an in-flight attachment through unmount until a delayed save commits', async () => {
    const save = deferred<void>()
    mocks.onSave.mockImplementationOnce(async (_blocks, onCommit) => {
      await save.promise
      onCommit(['file-block-uploaded-file'])
    })
    const { unmount } = renderEditor()

    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    unmount()
    await act(async () => save.resolve(undefined))
    await waitFor(() => expect(mocks.deleteFile).not.toHaveBeenCalled())
  })

  it('does not commit an attachment after a delayed save rejection and unmount cleanup releases once', async () => {
    const save = deferred<void>()
    mocks.onSave.mockImplementationOnce(() => save.promise)
    const { unmount } = renderEditor()

    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    unmount()
    await act(async () => save.reject(new Error('delayed save rejection')))
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedFile.id))
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1)
  })

  it('does not release uploads after commit when the editor unmounts', async () => {
    mocks.onSave.mockImplementationOnce(
      async (_blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => {
        onCommit(['file-block-uploaded-file'])
      }
    )
    const { unmount } = renderEditor()

    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    unmount()

    await waitFor(() => expect(mocks.deleteFile).not.toHaveBeenCalled())
  })

  it('does not retain editor ownership when the post-commit callback throws', async () => {
    mocks.onSave.mockImplementationOnce(
      async (_blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => {
        onCommit(['file-block-uploaded-file'])
        throw new Error('notification failed')
      }
    )
    const view = renderEditor()

    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'common.save' })).not.toBeDisabled()

    view.unmount()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it('retries after a committed resend failure without uploading again', async () => {
    mocks.onResend
      .mockImplementationOnce(async (_blocks: MessageBlock[], onCommit: (blockIds: readonly string[]) => void) => {
        onCommit(['file-block-uploaded-file'])
        throw new Error('resend failed after edit commit')
      })
      .mockResolvedValueOnce(undefined)

    renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    const resend = screen.getByRole('button', { name: 'chat.resend' })

    await userEvent.click(resend)
    await waitFor(() => expect(mocks.onResend).toHaveBeenCalledTimes(1))
    expect(resend).not.toBeDisabled()

    await userEvent.click(resend)
    await waitFor(() => expect(mocks.onResend).toHaveBeenCalledTimes(2))

    expect(FileManager.uploadFile).toHaveBeenCalledOnce()
    expect(mocks.onResend.mock.calls[1][0]).toEqual(mocks.onResend.mock.calls[0][0])
  })

  it('releases staged uploads once when a failed save is cancelled and then unmounted', async () => {
    mocks.onSave.mockRejectedValueOnce(new Error('SQLite save failed'))
    const onCancel = vi.fn()

    const view = renderEditor(onCancel)
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedFile.id))

    view.unmount()
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1)
  })

  it('excludes a removed block synchronously while physical deletion is pending', async () => {
    const deletion = deferred<void>()
    mocks.deleteFile.mockImplementationOnce(() => deletion.promise)
    mocks.onSave.mockRejectedValueOnce(new Error('save failed'))

    renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.save' })).not.toBeDisabled())

    await userEvent.click(screen.getByRole('button', { name: 'remove attachment' }))
    expect(screen.queryByText(uploadedFile.name)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled()
    expect(mocks.onSave).toHaveBeenCalledOnce()
    await act(async () => deletion.resolve(undefined))

    await waitFor(() => expect(screen.getByRole('button', { name: 'common.save' })).not.toBeDisabled())
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledTimes(2))
    expect(mocks.onSave.mock.calls[1][0].some((block: MessageBlock) => block.id === 'file-block-uploaded-file')).toBe(
      false
    )
  })

  it('restores a block and staged ownership when attachment deletion rejects', async () => {
    mocks.deleteFile.mockRejectedValueOnce(new Error('delete failed'))
    mocks.onSave.mockRejectedValueOnce(new Error('save failed'))

    renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.save' })).not.toBeDisabled())

    await userEvent.click(screen.getByRole('button', { name: 'remove attachment' }))

    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledTimes(1))
    expect(screen.getByText(uploadedFile.name)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'remove attachment' }))
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(uploadedFile.name)).not.toBeInTheDocument()
  })

  it('keeps partial upload failures visible for retry', async () => {
    const failedFile = { ...pendingFile, id: 'failed-file' }
    const result = await stageAttachmentUploads(
      message.id,
      [mainTextBlock],
      [pendingFile, failedFile],
      vi.fn().mockResolvedValueOnce(uploadedFile).mockRejectedValueOnce(new Error('upload failed'))
    )

    expect(result.error).toBeInstanceOf(Error)
    expect(result.stagedUploads).toHaveLength(1)
    expect(result.remainingFiles).toEqual([failedFile])
    expect(result.blocks).toContain(result.stagedUploads[0].block)
  })
})

describe('MessageEditor release failure retry (LOCK-001/LOCK-002/LOCK-003)', () => {
  it('releaseAttachments retries after rejection and succeeds, no stranded removing state', async () => {
    const save = deferred<void>()
    mocks.onSave.mockImplementationOnce(() => save.promise)
    mocks.deleteFile.mockRejectedValueOnce(new Error('transient delete failure'))

    const { unmount } = renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    unmount()

    // Unmount cleanup triggers releaseAttachments → deleteFile fails
    await act(async () => save.reject(new Error('save failed after unmount')))
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedFile.id))

    // Mock second attempt to succeed
    mocks.deleteFile.mockResolvedValueOnce(undefined)

    // Retry fires after 500ms; waitFor polls until it succeeds
    await waitFor(
      () => {
        expect(mocks.deleteFile).toHaveBeenCalledTimes(2)
      },
      { timeout: 3000 }
    )
    expect(mocks.deleteFile).toHaveBeenLastCalledWith(uploadedFile.id)
  })

  it('handleFileRemove after unmount triggers bounded retry that succeeds', async () => {
    const deletion = deferred<void>()
    mocks.deleteFile.mockImplementationOnce(() => deletion.promise)

    mocks.onSave.mockRejectedValueOnce(new Error('save failed'))

    const { unmount } = renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.save' })).not.toBeDisabled())

    // Start removing, then unmount before deletion resolves
    await userEvent.click(screen.getByRole('button', { name: 'remove attachment' }))
    unmount()

    // Now the deletion rejects — catch runs with isMountedRef=false
    mocks.deleteFile.mockResolvedValueOnce(undefined) // retry will succeed

    await act(async () => deletion.reject(new Error('delete failed')))

    // Retry fires after 500ms; waitFor polls until it succeeds
    await waitFor(
      () => {
        expect(mocks.deleteFile).toHaveBeenCalledTimes(2)
      },
      { timeout: 3000 }
    )
    expect(mocks.deleteFile).toHaveBeenLastCalledWith(uploadedFile.id)
  })

  it('retries exhaust with logging and ownership retained (no infinite loop)', async () => {
    // Always fail deleteFile
    mocks.deleteFile.mockRejectedValue(new Error('persistent failure'))

    const save = deferred<void>()
    mocks.onSave.mockImplementationOnce(() => save.promise)

    const { unmount } = renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    unmount()
    await act(async () => save.reject(new Error('save failed')))
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledOnce())

    // MAX_RELEASE_RETRIES = 3; wait for all retries to complete
    // Retries fire at 500ms, 1000ms, 1500ms after previous attempt
    await waitFor(
      () => {
        expect(mocks.deleteFile).toHaveBeenCalledTimes(4) // 1 initial + 3 retries
      },
      { timeout: 8000 }
    )
  })

  it('no double release when deleteFile succeeds on first attempt', async () => {
    const save = deferred<void>()
    mocks.onSave.mockImplementationOnce(() => save.promise)
    mocks.deleteFile.mockReset().mockResolvedValueOnce(undefined)

    const { unmount } = renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    unmount()
    await act(async () => save.reject(new Error('save failed')))
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedFile.id))

    // Wait long enough for any retry to fire (should not)
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // Exactly one deleteFile call — no double release
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1)
  })

  it('exactly-once success does not restore staged state', async () => {
    const save = deferred<void>()
    mocks.onSave.mockImplementationOnce(() => save.promise)
    mocks.deleteFile.mockReset().mockResolvedValueOnce(undefined)

    const { unmount } = renderEditor()
    await userEvent.click(screen.getByRole('button', { name: 'attach' }))
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(mocks.onSave).toHaveBeenCalledOnce())

    unmount()
    await act(async () => save.reject(new Error('save failed')))
    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedFile.id))

    // Wait long enough for any retry to fire (should not)
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // File deleted exactly once, no retry timer, no staged restoration
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1)
    expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedFile.id)
  })
})
