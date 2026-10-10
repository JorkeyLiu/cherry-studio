import type { FileMetadata } from '@renderer/types'
import type { VideoMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('react-player', () => ({
  default: ({ src, controls }: { src?: string; controls?: boolean }) => (
    // biome-ignore lint/a11y/useMediaCaption: test stub only, never shipped
    <video data-testid="message-video-player" src={src} controls={controls} />
  )
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    // Mirrors the real non-danger behavior (returns file.path as-is).
    getSafePath: vi.fn((file: FileMetadata) => file.path)
  }
}))

const { default: MessageVideo } = await import('../MessageVideo')
const FileManager = (await import('@renderer/services/FileManager')).default

type VideoBlockWithFile = VideoMessageBlock & { file?: FileMetadata | null }

const videoFile: FileMetadata = {
  id: 'vid-1',
  name: 'vid-1.mp4',
  origin_name: 'clip.mp4',
  path: '/mock/files/vid-1.mp4',
  size: 30,
  ext: '.mp4',
  type: 'video',
  count: 1,
  created_at: '2026-10-10T00:00:00.000Z'
}

const baseVideoBlock = (overrides: Partial<VideoBlockWithFile> = {}): VideoBlockWithFile => ({
  id: 'block-video-1',
  messageId: 'message-1',
  type: MessageBlockType.VIDEO,
  status: MessageBlockStatus.SUCCESS,
  createdAt: '2026-10-10T00:00:00.000Z',
  ...overrides
})

describe('MessageVideo synced file-backed rendering', () => {
  it('renders a file-DTO-backed independent VIDEO without metadata (no file://undefined)', () => {
    const { container } = render(
      <MessageVideo block={baseVideoBlock({ file: videoFile, filePath: '/mock/files/vid-1.mp4' })} />
    )

    const player = screen.getByTestId('message-video-player')
    expect(player.getAttribute('src')).toBe('file:///mock/files/vid-1.mp4')
    expect(player.getAttribute('src')).toContain('vid-1')
    expect(container.innerHTML).not.toContain('undefined')
    expect(FileManager.getSafePath).toHaveBeenCalled()
  })

  it('renders a filePath-only independent VIDEO without metadata', () => {
    const { container } = render(<MessageVideo block={baseVideoBlock({ filePath: '/mock/files/vid-2.mp4' })} />)

    expect(screen.getByTestId('message-video-player').getAttribute('src')).toBe('file:///mock/files/vid-2.mp4')
    expect(container.innerHTML).not.toContain('undefined')
  })

  it('preserves the legacy metadata.video.path source', () => {
    render(
      <MessageVideo
        block={baseVideoBlock({
          filePath: '/legacy/movie.mp4',
          metadata: { type: 'video', video: { path: '/legacy/movie.mp4' } }
        })}
      />
    )

    expect(screen.getByTestId('message-video-player').getAttribute('src')).toBe('file:///legacy/movie.mp4')
  })

  it('preserves a remote url without file:// wrapping', () => {
    render(<MessageVideo block={baseVideoBlock({ url: 'https://cdn.example/clip.mp4' })} />)

    expect(screen.getByTestId('message-video-player').getAttribute('src')).toBe('https://cdn.example/clip.mp4')
  })

  it('renders nothing (no false success) when the block carries no source at all', () => {
    const { container } = render(<MessageVideo block={baseVideoBlock()} />)

    expect(screen.queryByTestId('message-video-player')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('file://')
    expect(container.innerHTML).not.toContain('undefined')
  })

  it('reports a missing-file error instead of file://undefined when the local source is unusable', () => {
    const broken: FileMetadata = { ...videoFile, path: '' }
    const { container } = render(<MessageVideo block={baseVideoBlock({ file: broken })} />)

    expect(screen.queryByTestId('message-video-player')).not.toBeInTheDocument()
    expect(screen.getByText('message.video.error.local_file_missing')).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('file://undefined')
    expect(container.innerHTML).not.toContain('undefined')
  })

  it('encodes local paths with spaces and # instead of naive file:// concatenation', () => {
    render(<MessageVideo block={baseVideoBlock({ filePath: '/mock/my clip #1.mp4' })} />)

    expect(screen.getByTestId('message-video-player').getAttribute('src')).toBe('file:///mock/my%20clip%20%231.mp4')
  })
})
