import type { FileMetadata } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    getSafePath: vi.fn((file: FileMetadata) => file.path),
    getFilePath: vi.fn((file: FileMetadata) => file.path),
    formatFileName: vi.fn((file: FileMetadata) => file.origin_name || file.name || '')
  }
}))

vi.mock('@renderer/utils', () => ({
  formatFileSize: vi.fn((size: number) => `${size}B`)
}))

vi.mock('antd', () => ({
  Flex: ({ children }: any) => <div>{children}</div>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Image: () => null,
  Tooltip: ({ children }: any) => <span>{children}</span>
}))

vi.mock('@renderer/components/Tags/CustomTag', () => ({
  __esModule: true,
  default: ({ children, onClose }: any) => (
    <div data-testid="custom-tag">
      {children}
      <button aria-label="remove" onClick={onClose} />
    </div>
  )
}))

vi.mock('@renderer/components/ConfirmDialog', () => ({
  __esModule: true,
  default: () => null
}))

// Capture the wiring into the shared media component without re-testing its
// player semantics (covered by MediaAttachmentPreview.test.tsx).
vi.mock('@renderer/components/MediaAttachmentPreview', () => ({
  __esModule: true,
  default: ({ file, src, onOpenWithDefaultApp, defaultAppDisabled }: any) => (
    <div data-testid="draft-media-preview" data-src={src ?? ''} data-disabled={defaultAppDisabled}>
      <span>{file.origin_name}</span>
      <button data-testid="draft-media-open" onClick={onOpenWithDefaultApp}>
        open
      </button>
    </div>
  )
}))

const { default: AttachmentPreview } = await import('../AttachmentPreview')

const audioFile: FileMetadata = {
  id: 'draft-audio-1',
  name: 'song.mp3',
  origin_name: 'song.mp3',
  path: '/draft/song.mp3',
  size: 512,
  ext: '.mp3',
  type: 'audio',
  count: 1,
  created_at: '2026-09-18T00:00:00.000Z'
}

const textFile: FileMetadata = {
  ...audioFile,
  id: 'draft-text-1',
  name: 'note.txt',
  origin_name: 'note.txt',
  path: '/draft/note.txt',
  ext: '.txt',
  type: 'text'
}

describe('AttachmentPreview media drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders pre-send audio through the shared media preview with an encoded src', () => {
    render(<AttachmentPreview files={[audioFile]} setFiles={vi.fn()} />)

    const preview = screen.getByTestId('draft-media-preview')
    expect(preview).toHaveAttribute('data-src', 'file:///draft/song.mp3')
    expect(preview).toHaveAttribute('data-disabled', 'false')
    expect(screen.queryByTestId('custom-tag')).not.toBeInTheDocument()
  })

  it('opens pre-send audio through the narrow registered-external request', () => {
    render(<AttachmentPreview files={[audioFile]} setFiles={vi.fn()} />)

    fireEvent.click(screen.getByTestId('draft-media-open'))
    expect(mockOpenWithDefaultApp).toHaveBeenCalledTimes(1)
    expect(mockOpenWithDefaultApp).toHaveBeenCalledWith({ kind: 'external', filePath: '/draft/song.mp3' })
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('disables the default-app action and never reaches IPC when the draft path is missing', () => {
    const missing = { ...audioFile, path: '' }
    render(<AttachmentPreview files={[missing]} setFiles={vi.fn()} />)

    const preview = screen.getByTestId('draft-media-preview')
    expect(preview).toHaveAttribute('data-src', '')
    expect(preview).toHaveAttribute('data-disabled', 'true')

    fireEvent.click(screen.getByTestId('draft-media-open'))
    expect(mockOpenWithDefaultApp).not.toHaveBeenCalled()
  })

  it('keeps non-media drafts on the existing tag path', () => {
    render(<AttachmentPreview files={[textFile]} setFiles={vi.fn()} />)

    expect(screen.queryByTestId('draft-media-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('custom-tag')).toBeInTheDocument()
  })

  it('removes a media draft through the row remove action', () => {
    const setFiles = vi.fn()
    render(<AttachmentPreview files={[audioFile]} setFiles={setFiles} />)

    fireEvent.click(screen.getByRole('button', { name: 'message.attachments.remove_attachment' }))
    expect(setFiles).toHaveBeenCalledWith([])
  })
})
