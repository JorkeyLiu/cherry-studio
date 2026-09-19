import type { InputModalityFilter } from '@renderer/utils/inputModalities'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import TagFilterSection from '../TagFilterSection'

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

vi.mock('antd', () => ({
  Flex: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

function createSelection(
  overrides: Partial<Record<InputModalityFilter, boolean>> = {}
): Record<InputModalityFilter, boolean> {
  return { text: false, image: false, audio: false, video: false, pdf: false, ...overrides }
}

const allModalities: InputModalityFilter[] = ['text', 'image', 'audio', 'video', 'pdf']

describe('TagFilterSection (five input modalities)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('renders all five modalities in canonical order', () => {
      render(<TagFilterSection availableTags={allModalities} tagSelection={createSelection()} onToggleTag={vi.fn()} />)
      const buttons = screen.getAllByRole('button')
      expect(buttons.map((b) => b.textContent)).toEqual([
        'models.capabilities.modality_text',
        'models.capabilities.modality_image',
        'models.capabilities.modality_audio',
        'models.capabilities.modality_video',
        'models.capabilities.modality_pdf'
      ])
    })

    it('renders only the available subset', () => {
      render(
        <TagFilterSection availableTags={['text', 'image']} tagSelection={createSelection()} onToggleTag={vi.fn()} />
      )
      expect(screen.getByTestId('filter-tag-text')).toBeInTheDocument()
      expect(screen.getByTestId('filter-tag-image')).toBeInTheDocument()
      expect(screen.queryByTestId('filter-tag-audio')).not.toBeInTheDocument()
      expect(screen.queryByTestId('filter-tag-pdf')).not.toBeInTheDocument()
    })

    it('reflects selected state via data-selected + aria-pressed', () => {
      render(
        <TagFilterSection
          availableTags={['text']}
          tagSelection={createSelection({ text: true })}
          onToggleTag={vi.fn()}
        />
      )
      const textBtn = screen.getByTestId('filter-tag-text')
      expect(textBtn).toHaveAttribute('data-selected', 'true')
      expect(textBtn).toHaveAttribute('aria-pressed', 'true')
    })

    it('reflects unselected state with neutral tokens', () => {
      const { container } = render(
        <TagFilterSection
          availableTags={['text']}
          tagSelection={createSelection({ text: false })}
          onToggleTag={vi.fn()}
        />
      )
      const textBtn = screen.getByTestId('filter-tag-text')
      expect(textBtn).toHaveAttribute('data-selected', 'false')
      expect(textBtn).toHaveAttribute('aria-pressed', 'false')
      const styleTags = Array.from(document.head.querySelectorAll('style'))
        .map((el) => el.textContent ?? '')
        .join('\n')
      expect(styleTags).toContain('var(--color-text-3)')
      expect(styleTags).toContain('var(--color-border)')
      expect(container.innerHTML).not.toContain('ant-tooltip')
    })

    it('paints the selected chip in its modality hue over a light tint (never a pill)', () => {
      render(
        <TagFilterSection
          availableTags={['text', 'image']}
          tagSelection={createSelection({ text: true })}
          onToggleTag={vi.fn()}
        />
      )
      expect(screen.getByTestId('filter-tag-text')).toHaveAttribute('data-selected', 'true')
      expect(screen.getByTestId('filter-tag-image')).toHaveAttribute('data-selected', 'false')
      // Selected text chip uses the shared compact blue; image stays neutral.
      const styleTags = Array.from(document.head.querySelectorAll('style'))
        .map((el) => el.textContent ?? '')
        .join('\n')
      expect(styleTags).toContain('#1677ff')
      expect(styleTags).toContain('#00b96b')
      expect(styleTags).toContain('color-mix')
      // Square control, never a pill radius.
      expect(styleTags).not.toContain('999px')
    })

    it('should skip unknown tags', () => {
      render(
        <TagFilterSection
          availableTags={['unknown' as unknown as InputModalityFilter, 'text']}
          tagSelection={createSelection()}
          onToggleTag={vi.fn()}
        />
      )
      expect(screen.getByTestId('filter-tag-text')).toBeInTheDocument()
      expect(screen.getAllByRole('button')).toHaveLength(1)
    })

    it('never renders legacy capability tags', () => {
      const { container } = render(
        <TagFilterSection availableTags={allModalities} tagSelection={createSelection()} onToggleTag={vi.fn()} />
      )
      for (const legacy of ['vision', 'embedding', 'reasoning', 'function_calling', 'rerank', 'free']) {
        expect(container.textContent).not.toContain(`tag-${legacy}`)
      }
    })

    it('renders no antd tooltip', () => {
      const { container } = render(
        <TagFilterSection availableTags={allModalities} tagSelection={createSelection()} onToggleTag={vi.fn()} />
      )
      expect(container.querySelectorAll('.ant-tooltip').length).toBe(0)
      expect(document.body.querySelectorAll('.ant-tooltip').length).toBe(0)
    })
  })

  describe('functionality', () => {
    it('should call onToggleTag when a tag is clicked', () => {
      const handleToggle = vi.fn()
      render(
        <TagFilterSection availableTags={allModalities} tagSelection={createSelection()} onToggleTag={handleToggle} />
      )

      fireEvent.click(screen.getByTestId('filter-tag-image'))

      expect(handleToggle).toHaveBeenCalledTimes(1)
      expect(handleToggle).toHaveBeenCalledWith('image')
    })
  })
})
