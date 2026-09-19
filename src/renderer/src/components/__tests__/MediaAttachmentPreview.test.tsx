import type { FileMetadata } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key
  })
}))

vi.mock('antd', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    formatFileName: vi.fn((file: FileMetadata) => file.origin_name || file.name || '')
  }
}))

vi.mock('@renderer/utils', () => ({
  formatFileSize: vi.fn((size: number) => `${size}B`)
}))

const { default: MediaAttachmentPreview } = await import('../MediaAttachmentPreview')

const baseFile: FileMetadata = {
  id: 'media-1',
  name: 'song.mp3',
  origin_name: 'song.mp3',
  path: '/draft/song.mp3',
  size: 1024,
  ext: '.mp3',
  type: 'audio',
  count: 1,
  created_at: '2026-09-18T00:00:00.000Z'
}

const makeFile = (overrides: Partial<FileMetadata> = {}): FileMetadata => ({ ...baseFile, ...overrides })

describe('MediaAttachmentPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders an in-app audio player with controls, metadata preload and no autoplay', () => {
    const onOpen = vi.fn()
    render(<MediaAttachmentPreview file={makeFile()} src="file:///draft/song.mp3" onOpenWithDefaultApp={onOpen} />)

    const audio = screen.getByTestId('media-audio')
    expect(audio.tagName).toBe('AUDIO')
    expect(audio).toHaveAttribute('controls')
    expect(audio).toHaveAttribute('preload', 'metadata')
    expect(audio).not.toHaveAttribute('autoplay')
    expect(audio.getAttribute('src')).toBe('file:///draft/song.mp3')
    expect(screen.queryByTestId('media-video')).not.toBeInTheDocument()
    expect(screen.queryByTestId('media-fallback')).not.toBeInTheDocument()
  })

  it('renders an in-app video player with controls, metadata preload and no autoplay', () => {
    const onOpen = vi.fn()
    render(
      <MediaAttachmentPreview
        file={makeFile({ id: 'media-2', origin_name: 'clip.mp4', name: 'clip.mp4', ext: '.mp4', type: 'video' })}
        src="file:///draft/clip.mp4"
        onOpenWithDefaultApp={onOpen}
      />
    )

    const video = screen.getByTestId('media-video')
    expect(video.tagName).toBe('VIDEO')
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(video).not.toHaveAttribute('autoplay')
    expect(screen.queryByTestId('media-audio')).not.toBeInTheDocument()
  })

  it('keeps filename, format and size visible and exposes the explicit default-app action', () => {
    const onOpen = vi.fn()
    render(<MediaAttachmentPreview file={makeFile()} src="file:///draft/song.mp3" onOpenWithDefaultApp={onOpen} />)

    expect(screen.getByText('song.mp3')).toBeInTheDocument()
    expect(screen.getByText('.mp3')).toBeInTheDocument()
    const button = screen.getByTestId('media-open-default')
    expect(button).toHaveAccessibleName('message.attachments.open_with_default_app')
    expect(button).toHaveAttribute('title', 'message.attachments.open_with_default_app')

    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('falls back to the generic media card for formats the browser cannot decode', () => {
    const onOpen = vi.fn()
    render(
      <MediaAttachmentPreview
        file={makeFile({ origin_name: 'movie.mkv', name: 'movie.mkv', ext: '.mkv', type: 'video' })}
        src="file:///draft/movie.mkv"
        onOpenWithDefaultApp={onOpen}
      />
    )

    expect(screen.queryByTestId('media-audio')).not.toBeInTheDocument()
    expect(screen.queryByTestId('media-video')).not.toBeInTheDocument()
    expect(screen.getByTestId('media-fallback')).toBeInTheDocument()
    // Sending is not blocked: the default-app action stays available.
    expect(screen.getByTestId('media-open-default')).toBeEnabled()
  })

  it('never builds a file:// URL when the source is missing and disables the default-app action without identity', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <MediaAttachmentPreview file={makeFile()} src={null} onOpenWithDefaultApp={onOpen} defaultAppDisabled />
    )

    expect(screen.queryByTestId('media-audio')).not.toBeInTheDocument()
    expect(screen.queryByTestId('media-video')).not.toBeInTheDocument()
    expect(screen.getByTestId('media-fallback')).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('file://')
    expect(screen.getByTestId('media-open-default')).toBeDisabled()
    expect(onOpen).not.toHaveBeenCalled()
  })
})
