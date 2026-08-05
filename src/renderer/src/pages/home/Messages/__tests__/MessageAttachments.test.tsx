import type { FileMetadata } from '@renderer/types'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies
vi.mock('@ant-design/icons', () => ({
  PaperClipOutlined: () => <span data-testid="paperclip-icon" />
}))

vi.mock('i18next', () => ({
  t: (key: string) => key
}))

const mockPreview = vi.fn()
vi.mock('@renderer/hooks/useAttachment', () => ({
  useAttachment: () => ({ preview: mockPreview })
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    getSafePath: vi.fn((file: FileMetadata) => `/mock/files/${file.id}${file.ext}`),
    getFilePath: vi.fn((file: FileMetadata) => `/mock/files/${file.id}${file.ext}`),
    formatFileName: vi.fn((file: FileMetadata) => file.origin_name || file.name || '')
  }
}))

vi.mock('@renderer/utils', () => ({
  parseFileTypes: vi.fn((type: string) => type)
}))

vi.mock('antd', () => ({
  Tooltip: ({ title, children }: any) => (
    <div data-testid="tooltip" title={title}>
      {children}
    </div>
  ),
  Upload: ({ fileList, onPreview, disabled, listType }: any) => (
    <div data-testid="upload" data-disabled={disabled} data-list-type={listType}>
      {fileList.map((file: any) => (
        <div key={file.uid} data-testid="upload-item">
          <span data-testid="upload-name">{file.name}</span>
          <span data-testid="upload-type">{file.type}</span>
          <span data-testid="upload-url">{file.url ?? ''}</span>
          <button type="button" data-testid="upload-preview" onClick={() => onPreview?.(file)}>
            preview
          </button>
        </div>
      ))}
    </div>
  )
}))

const { default: MessageAttachments } = await import('../MessageAttachments')
const FileManager = (await import('@renderer/services/FileManager')).default

const baseFile: FileMetadata = {
  id: 'file-1',
  name: 'document.txt',
  origin_name: 'document.txt',
  path: '/abs/original/document.txt',
  size: 10,
  ext: '.txt',
  type: 'document',
  count: 1,
  created_at: '2026-07-30T00:00:00.000Z'
}

const createFileBlock = (overrides: Partial<FileMessageBlock> = {}): FileMessageBlock => ({
  id: 'block-file-1',
  messageId: 'message-1',
  type: MessageBlockType.FILE,
  status: MessageBlockStatus.SUCCESS,
  createdAt: '2026-07-30T00:00:00.000Z',
  file: baseFile,
  ...overrides
})

const renderAttachments = (block: FileMessageBlock) => render(<MessageAttachments block={block} />)

describe('MessageAttachments attachment availability (LOCK-UI-1/3/4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the unavailable file visible with icon/name/type but disables preview without a file:// URL', () => {
    const block = createFileBlock({ l2AttachmentUnavailable: true })

    const { container } = renderAttachments(block)

    const item = screen.getByTestId('unavailable-file')
    expect(item).toBeInTheDocument()
    // Non-interactive status row: no interaction semantics — aria-disabled is
    // removed (a plain non-focusable element claims no disabled widget state)
    // and the tooltip/title still carries the unavailable hint.
    expect(item).not.toHaveAttribute('aria-disabled')
    expect(item).toHaveAttribute('title', 'message.attachments.unavailable')
    expect(item).not.toHaveAttribute('tabindex')
    expect(item).not.toHaveAttribute('role', 'button')
    expect(screen.getByTestId('paperclip-icon')).toBeInTheDocument()
    expect(screen.getByText('document.txt')).toBeInTheDocument()
    expect(screen.getByText('.txt')).toBeInTheDocument()
    expect(screen.getByText('message.attachments.unavailable')).toBeInTheDocument()

    // No Upload mount, no file:// URL, no path building, no preview IPC
    expect(screen.queryByTestId('upload')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('file://')
    expect(FileManager.getSafePath).not.toHaveBeenCalled()
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('keeps the unavailable file visible when metadata is partial', () => {
    const partialFile = { ...baseFile, origin_name: '', name: 'report' } as FileMetadata
    const block = createFileBlock({ l2AttachmentUnavailable: true, file: partialFile })

    const { container } = renderAttachments(block)

    expect(screen.getByTestId('unavailable-file')).toBeInTheDocument()
    expect(screen.getByText('report')).toBeInTheDocument()
    expect(screen.getByText('.txt')).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('file://')
    expect(FileManager.getSafePath).not.toHaveBeenCalled()
  })

  it('keeps the healthy attachment behavior when the marker is absent (Upload + preview open)', async () => {
    const user = userEvent.setup()
    const block = createFileBlock()

    const { container } = renderAttachments(block)

    const upload = screen.getByTestId('upload')
    expect(upload).toBeInTheDocument()
    expect(screen.getByTestId('upload-url').textContent).toBe('file:///mock/files/file-1.txt')
    expect(screen.getByTestId('upload-name').textContent).toBe('document.txt')
    expect(FileManager.getSafePath).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('unavailable-file')).not.toBeInTheDocument()
    expect(container.innerHTML).toContain('file://')

    // Preview interaction still reaches the attachment preview hook
    await user.click(screen.getByTestId('upload-preview'))
    expect(mockPreview).toHaveBeenCalledTimes(1)
    expect(mockPreview).toHaveBeenCalledWith('/mock/files/file-1.txt', 'document.txt', 'document', '.txt')
  })

  it('keeps the healthy attachment behavior when the marker is false', () => {
    const block = createFileBlock({ l2AttachmentUnavailable: false })

    renderAttachments(block)

    expect(screen.getByTestId('upload')).toBeInTheDocument()
    expect(screen.getByTestId('upload-url').textContent).toBe('file:///mock/files/file-1.txt')
    expect(FileManager.getSafePath).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('unavailable-file')).not.toBeInTheDocument()
  })

  it('renders nothing when the block has no file metadata', () => {
    const block = createFileBlock({ file: undefined as unknown as FileMetadata })

    const { container } = renderAttachments(block)

    expect(container.firstChild).toBeNull()
  })
})
