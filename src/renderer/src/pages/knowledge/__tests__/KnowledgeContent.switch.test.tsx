/**
 * KnowledgeContent — compact source switch transitions for the bounded dialog.
 *
 * The dialog replaces the wide tab strip with a compact segmented switch:
 * switching it swaps the visible source pane, per-source counts stay visible,
 * the temporarily hidden video source stays hidden, and the model header
 * (embedding model + settings entry) is preserved. Source panes themselves
 * are collaborators mocked at the module boundary.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string) => key)
  return { t }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('@renderer/hooks/useKnowledge', () => ({
  useKnowledge: () => ({
    base: { id: 'b1', name: 'Base One', model: { name: 'embed-mock' }, items: [] },
    urlItems: [{ id: 'u1' }],
    fileItems: [{ id: 'f1' }, { id: 'f2' }],
    directoryItems: [],
    noteItems: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
    sitemapItems: [],
    videoItems: []
  })
}))

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderName: () => 'MockProvider'
}))

vi.mock('../components/EditKnowledgeBasePopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('../components/KnowledgeSearchPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('../items/KnowledgeFiles', () => ({
  default: () => <div data-testid="src-files" />
}))

vi.mock('../items/KnowledgeNotes', () => ({
  default: () => <div data-testid="src-notes" />
}))

vi.mock('../items/KnowledgeDirectories', () => ({
  default: () => <div data-testid="src-directories" />
}))

vi.mock('../items/KnowledgeUrls', () => ({
  default: () => <div data-testid="src-urls" />
}))

vi.mock('../items/KnowledgeSitemaps', () => ({
  default: () => <div data-testid="src-sitemaps" />
}))

vi.mock('../items/KnowledgeVideos', () => ({
  default: () => <div data-testid="src-videos" />
}))

import KnowledgeContent from '../KnowledgeContent'

const selectedBase = { id: 'b1', name: 'Base One' } as Parameters<typeof KnowledgeContent>[0]['selectedBase']

const electronOn = vi.fn(() => vi.fn())

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { electron: unknown }).electron = { ipcRenderer: { on: electronOn } }
})

afterEach(() => {
  cleanup()
})

describe('KnowledgeContent — compact source switch', () => {
  it('shows the files pane by default with per-source counts', () => {
    render(<KnowledgeContent selectedBase={selectedBase} />)
    expect(screen.getByTestId('src-files')).toBeInTheDocument()
    expect(screen.queryByTestId('src-notes')).not.toBeInTheDocument()
    const switcher = screen.getByTestId('knowledge-source-switch')
    // files(2) notes(3) urls(1): counts ride on the switch labels.
    expect(switcher.textContent).toContain('2')
    expect(switcher.textContent).toContain('3')
    expect(switcher.textContent).toContain('1')
  })

  it('switching the source swaps the visible pane', () => {
    render(<KnowledgeContent selectedBase={selectedBase} />)
    fireEvent.click(screen.getByText('knowledge.notes'))
    expect(screen.getByTestId('src-notes')).toBeInTheDocument()
    expect(screen.queryByTestId('src-files')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('knowledge.urls'))
    expect(screen.getByTestId('src-urls')).toBeInTheDocument()
    expect(screen.queryByTestId('src-notes')).not.toBeInTheDocument()
  })

  it('keeps the not-yet-implemented video source hidden', () => {
    render(<KnowledgeContent selectedBase={selectedBase} />)
    expect(screen.queryByTestId('src-videos')).not.toBeInTheDocument()
    expect(screen.getByTestId('knowledge-source-switch').textContent).not.toContain('knowledge.videos')
  })

  it('preserves the embedding model header', () => {
    render(<KnowledgeContent selectedBase={selectedBase} />)
    expect(screen.getByText('models.embedding_model')).toBeInTheDocument()
    expect(screen.getByText('embed-mock')).toBeInTheDocument()
  })

  it('subscribes to directory indexing progress on mount', () => {
    render(<KnowledgeContent selectedBase={selectedBase} />)
    expect(electronOn).toHaveBeenCalledWith('directory-processing-percent', expect.any(Function))
  })
})
