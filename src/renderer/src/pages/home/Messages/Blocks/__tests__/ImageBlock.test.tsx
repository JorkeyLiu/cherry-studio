import { configureStore } from '@reduxjs/toolkit'
import runtimeReducer, { setFilesPath } from '@renderer/store/runtime'
import type { FileMetadata } from '@renderer/types'
import type { ImageMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
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

// LOCK-IMG-RUNTIME: ImageBlock resolves its file URL from a NARROW
// runtime.filesPath subscription, not an imperative render-time store read.
// Delegate useAppSelector to the REAL react-redux useSelector so a real store
// dispatch re-renders the memoized block exactly like production (React.memo
// is bypassed by the store subscription, never by a manual rerender).
vi.mock('@renderer/store', async () => {
  const reactRedux = await import('react-redux')
  return {
    useAppSelector: reactRedux.useSelector
  }
})

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

const createTestStore = () =>
  configureStore({
    reducer: { runtime: runtimeReducer }
  })

let store: ReturnType<typeof createTestStore>

const renderImageBlock = (block: ImageMessageBlock) =>
  render(
    <Provider store={store}>
      <ImageBlock block={block} />
    </Provider>
  )

describe('ImageBlock attachment availability (LOCK-UI-1/2/4)', () => {
  beforeEach(() => {
    mockUseTranslation.mockReturnValue({
      t: (key: string) => key
    })
    vi.clearAllMocks()
    // Default runtime root for the healthy file-image tests; the reactive
    // filesPath test overrides it explicitly.
    store = createTestStore()
    store.dispatch(setFilesPath('/mock/files'))
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
    // The URL is resolved from the runtime.filesPath subscription, not from
    // FileManager.getFilePath.
    expect(FileManager.getFilePath).not.toHaveBeenCalled()
    expect(screen.queryByTestId('unavailable-image')).not.toBeInTheDocument()
    expect(container.innerHTML).toContain('file://')
  })

  it('keeps the healthy file-image behavior when the marker is false', () => {
    const block = createImageBlock({ l2AttachmentUnavailable: false, file: baseFile })

    renderImageBlock(block)

    expect(screen.getByTestId('image-viewer')).toBeInTheDocument()
    expect(FileManager.getFilePath).not.toHaveBeenCalled()
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

  it('uses block.url when no file metadata is present (url fallback preserved)', () => {
    const block = createImageBlock({
      file: undefined,
      url: 'https://example.com/generated.png'
    })

    const { container } = renderImageBlock(block)

    const viewer = screen.getByTestId('image-viewer')
    expect(viewer).toBeInTheDocument()
    expect(viewer).toHaveAttribute('data-src', 'https://example.com/generated.png')
    expect(FileManager.getFilePath).not.toHaveBeenCalled()
    expect(container.innerHTML).toContain('https://example.com/generated.png')
  })
})

describe('ImageBlock runtime.filesPath reactivity (LOCK-IMG-RUNTIME)', () => {
  beforeEach(() => {
    mockUseTranslation.mockReturnValue({
      t: (key: string) => key
    })
    vi.clearAllMocks()
    store = createTestStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders no file URL while filesPath is empty and re-renders after the runtime filesPath dispatch', () => {
    const block = createImageBlock({ file: baseFile })
    const { container } = renderImageBlock(block)

    // runtime.filesPath starts '' (RuntimeState initial state) and is
    // populated asynchronously by useAppInit. While empty the block must
    // never construct `file:///id.ext` from an empty root, and no viewer
    // mounts.
    expect(store.getState().runtime.filesPath).toBe('')
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('file://')
    expect(container.innerHTML).not.toContain('file-1.png')

    // useAppInit dispatches setFilesPath(info.filesPath) after app init.
    act(() => {
      store.dispatch(setFilesPath('/mock/files'))
    })

    // The narrow runtime.filesPath subscription re-renders the memoized block
    // with the runtime root — this is the bug fix (previously React.memo froze
    // the first render on the empty path).
    const viewer = screen.getByTestId('image-viewer')
    expect(viewer).toBeInTheDocument()
    expect(viewer).toHaveAttribute('data-src', 'file:///mock/files/file-1.png')
    expect(container.innerHTML).toContain('file://')
  })

  it('keeps the generated-image branch independent of filesPath', () => {
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

    // filesPath is still '' — generated images must render regardless.
    expect(store.getState().runtime.filesPath).toBe('')
    const viewer = screen.getByTestId('image-viewer')
    expect(viewer).toHaveAttribute('data-src', 'data:image/png;base64,AAAA')
    expect(container.innerHTML).not.toContain('file://')
  })
})
