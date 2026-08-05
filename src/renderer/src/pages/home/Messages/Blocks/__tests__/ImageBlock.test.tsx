import type { FileMetadata } from '@renderer/types'
import type { ImageMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies
const mockUseTranslation = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => mockUseTranslation()
}))

vi.mock('@ant-design/icons', () => ({
  PictureOutlined: () => <span data-testid="picture-icon" />
}))

vi.mock('antd', () => ({
  Skeleton: {
    Image: ({ active, style }: any) => <div data-testid="skeleton-image" data-active={active} style={style} />
  }
}))

vi.mock('@renderer/components/ImageViewer', () => ({
  __esModule: true,
  default: ({ src, style }: any) => <div data-testid="image-viewer" data-src={src} data-style={JSON.stringify(style)} />
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    getFilePath: vi.fn((file: FileMetadata) => `/mock/files/${file.id}${file.ext}`),
    formatFileName: vi.fn((file: FileMetadata) => file.origin_name || file.name || '')
  }
}))

const { default: ImageBlock } = await import('../ImageBlock')
const FileManager = (await import('@renderer/services/FileManager')).default

const baseFile: FileMetadata = {
  id: 'file-1',
  name: 'photo.png',
  origin_name: 'photo.png',
  path: '/abs/original/photo.png',
  size: 10,
  ext: '.png',
  type: 'image',
  count: 1,
  created_at: '2026-07-30T00:00:00.000Z'
}

const createImageBlock = (overrides: Partial<ImageMessageBlock> = {}): ImageMessageBlock => ({
  id: 'block-image-1',
  messageId: 'message-1',
  type: MessageBlockType.IMAGE,
  status: MessageBlockStatus.SUCCESS,
  createdAt: '2026-07-30T00:00:00.000Z',
  ...overrides
})

const renderImageBlock = (block: ImageMessageBlock) => render(<ImageBlock block={block} />)

describe('ImageBlock attachment availability (LOCK-UI-1/2/4)', () => {
  beforeEach(() => {
    mockUseTranslation.mockReturnValue({
      t: (key: string) => key
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the unavailable placeholder for a marked image and never builds a file URL or calls getFilePath', () => {
    const block = createImageBlock({
      l2AttachmentUnavailable: true,
      file: baseFile
    })

    const { container } = renderImageBlock(block)

    // Stable placeholder with retained filename/type and localized status
    const placeholder = screen.getByTestId('unavailable-image')
    expect(placeholder).toBeInTheDocument()
    // Accessible image semantics: named by status + filename, purely
    // presentational (no interaction — never focusable, never a button).
    expect(placeholder).toHaveAttribute('role', 'img')
    expect(placeholder).toHaveAttribute('aria-label', 'message.attachments.unavailable: photo.png')
    expect(placeholder).not.toHaveAttribute('tabindex')
    expect(placeholder).not.toHaveAttribute('role', 'button')
    expect(screen.getByText('photo.png')).toBeInTheDocument()
    expect(screen.getByText('.png')).toBeInTheDocument()
    expect(screen.getByText('message.attachments.unavailable')).toBeInTheDocument()

    // No ImageViewer/AntImage mount
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument()

    // No path building and no file:// URL anywhere
    expect(FileManager.getFilePath).not.toHaveBeenCalled()
    expect(container.innerHTML).not.toContain('file://')
  })

  it('renders the unavailable placeholder even when file metadata is partial (only a url)', () => {
    const block = createImageBlock({
      l2AttachmentUnavailable: true,
      url: 'https://example.com/missing.png'
    })

    const { container } = renderImageBlock(block)

    expect(screen.getByTestId('unavailable-image')).toBeInTheDocument()
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument()
    // No file metadata → the accessible name is the unavailable text alone.
    expect(screen.getByTestId('unavailable-image')).toHaveAttribute('role', 'img')
    expect(screen.getByTestId('unavailable-image')).toHaveAttribute('aria-label', 'message.attachments.unavailable')
    expect(screen.getByText('message.attachments.unavailable')).toBeInTheDocument()
    expect(FileManager.getFilePath).not.toHaveBeenCalled()
    expect(container.innerHTML).not.toContain('file://')
  })

  it('keeps the healthy file-image behavior when the marker is absent', () => {
    const block = createImageBlock({ file: baseFile })

    const { container } = renderImageBlock(block)

    const viewer = screen.getByTestId('image-viewer')
    expect(viewer).toBeInTheDocument()
    expect(viewer).toHaveAttribute('data-src', 'file:///mock/files/file-1.png')
    expect(FileManager.getFilePath).toHaveBeenCalledTimes(1)
    expect(FileManager.getFilePath).toHaveBeenCalledWith(baseFile)
    expect(screen.queryByTestId('unavailable-image')).not.toBeInTheDocument()
    expect(container.innerHTML).toContain('file://')
  })

  it('keeps the healthy file-image behavior when the marker is false', () => {
    const block = createImageBlock({ l2AttachmentUnavailable: false, file: baseFile })

    renderImageBlock(block)

    expect(screen.getByTestId('image-viewer')).toBeInTheDocument()
    expect(FileManager.getFilePath).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('unavailable-image')).not.toBeInTheDocument()
  })

  it('keeps generated image blocks unchanged (no getFilePath call)', () => {
    const block = createImageBlock({
      url: undefined,
      file: undefined,
      metadata: {
        generateImageResponse: {
          type: 'base64',
          images: ['data:image/png;base64,AAAA']
        }
      }
    })

    const { container } = renderImageBlock(block)

    const viewer = screen.getByTestId('image-viewer')
    expect(viewer).toBeInTheDocument()
    expect(viewer).toHaveAttribute('data-src', 'data:image/png;base64,AAAA')
    expect(FileManager.getFilePath).not.toHaveBeenCalled()
    expect(container.innerHTML).not.toContain('file://')
  })
})
