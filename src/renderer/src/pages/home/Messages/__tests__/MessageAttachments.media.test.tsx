import type { FileMetadata } from '@renderer/types'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@ant-design/icons', () => ({
  PaperClipOutlined: () => <span data-testid="paperclip-icon" />
}))

vi.mock('i18next', () => ({
  t: (key: string) => key
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

const mockPreview = vi.fn()
const mockOpenWithDefaultApp = vi.fn()
vi.mock('@renderer/hooks/useAttachment', () => ({
  useAttachment: () => ({ preview: mockPreview, openWithDefaultApp: mockOpenWithDefaultApp })
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    getSafePath: vi.fn((file: FileMetadata) => `/mock/files/${file.id}${file.ext}`),
    getFilePath: vi.fn((file: FileMetadata) => `/mock/files/${file.id}${file.ext}`),
    formatFileName: vi.fn((file: FileMetadata) => file.origin_name || file.name || '')
  }
}))

vi.mock('@renderer/utils', () => ({
  parseFileTypes: vi.fn((type: string) => type),
  formatFileName: vi.fn(),
  formatFileSize: vi.fn((size: number) => `${size}B`)
}))

vi.mock('../../Inputbar/AttachmentPreview', () => ({
  getFileIcon: () => <span data-testid="file-icon" />
}))

vi.mock('antd', () => ({
  Tooltip: ({ title, children }: any) => (
    <div data-testid="tooltip" title={title}>
      {children}
    </div>
  ),
  Upload: () => <div data-testid="upload" />,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>
}))

const { default: MessageAttachments } = await import('../MessageAttachments')
const FileManager = (await import('@renderer/services/FileManager')).default

const audioFile: FileMetadata = {
  id: 'audio-1',
  name: 'note.mp3',
  origin_name: 'note.mp3',
  path: '/abs/files/audio-1.mp3',
  size: 2048,
  ext: '.mp3',
  type: 'audio',
  count: 1,
  created_at: '2026-09-18T00:00:00.000Z'
}

const videoFile: FileMetadata = {
  ...audioFile,
  id: 'video-1',
  name: 'clip.mp4',
  origin_name: 'clip.mp4',
  path: '/abs/files/video-1.mp4',
  ext: '.mp4',
  type: 'video'
}

const createFileBlock = (file: FileMetadata, overrides: Partial<FileMessageBlock> = {}): FileMessageBlock => ({
  id: 'block-file-1',
  messageId: 'message-1',
  type: MessageBlockType.FILE,
  status: MessageBlockStatus.SUCCESS,
  createdAt: '2026-09-18T00:00:00.000Z',
  file,
  ...overrides
})

describe('MessageAttachments media preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('previews sent audio in-app with controls, no autoplay, and a narrow stored open request', () => {
    render(<MessageAttachments block={createFileBlock(audioFile)} />)

    const audio = screen.getByTestId('media-audio')
    expect(audio).toHaveAttribute('controls')
    expect(audio).toHaveAttribute('preload', 'metadata')
    expect(audio).not.toHaveAttribute('autoplay')
    expect(audio.getAttribute('src')).toBe('file:///mock/files/audio-1.mp3')
    expect(screen.queryByTestId('upload')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('media-open-default'))
    expect(mockOpenWithDefaultApp).toHaveBeenCalledTimes(1)
    expect(mockOpenWithDefaultApp).toHaveBeenCalledWith({ kind: 'stored', storedFileName: 'audio-1.mp3' })
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('previews sent video in-app without autoplay', () => {
    render(<MessageAttachments block={createFileBlock(videoFile)} />)

    const video = screen.getByTestId('media-video')
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(video).not.toHaveAttribute('autoplay')
    expect(video.getAttribute('src')).toBe('file:///mock/files/video-1.mp4')
  })

  it('renders the generic card for unplayable formats without blocking the default-app action', () => {
    const mkv = { ...videoFile, id: 'video-2', origin_name: 'movie.mkv', name: 'movie.mkv', ext: '.mkv' }
    const { container } = render(<MessageAttachments block={createFileBlock(mkv)} />)

    expect(screen.queryByTestId('media-video')).not.toBeInTheDocument()
    expect(screen.getByTestId('media-fallback')).toBeInTheDocument()
    expect(container.innerHTML).toContain('movie.mkv')

    fireEvent.click(screen.getByTestId('media-open-default'))
    expect(mockOpenWithDefaultApp).toHaveBeenCalledWith({ kind: 'stored', storedFileName: 'video-2.mkv' })
  })

  it('encodes source paths with spaces and # instead of naive file:// concatenation', () => {
    vi.mocked(FileManager.getSafePath).mockReturnValueOnce('/mock/my song #1.mp3')
    render(<MessageAttachments block={createFileBlock(audioFile)} />)

    expect(screen.getByTestId('media-audio').getAttribute('src')).toBe('file:///mock/my%20song%20%231.mp3')
  })

  it('keeps degraded audio attachments visible without a file:// URL or IPC', () => {
    const { container } = render(
      <MessageAttachments block={createFileBlock(audioFile, { l2AttachmentUnavailable: true })} />
    )

    expect(screen.getByTestId('unavailable-file')).toBeInTheDocument()
    expect(screen.queryByTestId('media-attachment')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('file://')
    expect(FileManager.getSafePath).not.toHaveBeenCalled()
    expect(mockOpenWithDefaultApp).not.toHaveBeenCalled()
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('renders nothing when the block has no file metadata', () => {
    const { container } = render(
      <MessageAttachments block={createFileBlock(audioFile, { file: undefined as unknown as FileMetadata })} />
    )

    expect(container.firstChild).toBeNull()
  })
})
