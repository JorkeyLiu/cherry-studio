import type { Model, Provider } from '@renderer/types'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ModelTagsWithLabel from '../ModelTagsWithLabel'

const mocks = vi.hoisted(() => ({ getSupportedInputModalitiesForDisplay: vi.fn() }))

vi.mock('@renderer/utils/inputModalities', () => ({
  getSupportedInputModalitiesForDisplay: mocks.getSupportedInputModalitiesForDisplay
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

function createModel(overrides: Partial<Model> = {}): Model {
  return { id: 'm1', provider: 'openai', name: 'M1', group: 'default', ...overrides }
}

const provider = { id: 'openai' } as Provider

const FORBIDDEN_MODALITY_COLORS = ['#1677ff', '#00b96b', '#722ed1', '#eb2f96', '#fa541c']

describe('ModelTagsWithLabel (models.dev input modalities)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSupportedInputModalitiesForDisplay.mockReturnValue([])
  })

  it('renders zero tags when the entry is unknown', () => {
    mocks.getSupportedInputModalitiesForDisplay.mockReturnValue([])
    const { container } = render(<ModelTagsWithLabel model={createModel()} />)
    expect(mocks.getSupportedInputModalitiesForDisplay).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1' }),
      undefined
    )
    for (const modality of ['text', 'image', 'audio', 'video', 'pdf']) {
      expect(screen.queryByTestId(`modality-tag-${modality}`)).not.toBeInTheDocument()
    }
    expect(container.textContent).toBe('')
  })

  it('renders only text and image for input=[text,image]', () => {
    mocks.getSupportedInputModalitiesForDisplay.mockReturnValue(['text', 'image'])
    render(<ModelTagsWithLabel model={createModel()} />)
    expect(screen.getByTestId('modality-tag-text')).toBeInTheDocument()
    expect(screen.getByTestId('modality-tag-image')).toBeInTheDocument()
    expect(screen.queryByTestId('modality-tag-audio')).not.toBeInTheDocument()
    expect(screen.queryByTestId('modality-tag-video')).not.toBeInTheDocument()
    expect(screen.queryByTestId('modality-tag-pdf')).not.toBeInTheDocument()
  })

  it('renders audio/video/pdf when explicitly supported', () => {
    mocks.getSupportedInputModalitiesForDisplay.mockReturnValue(['audio', 'video', 'pdf'])
    render(<ModelTagsWithLabel model={createModel()} />)
    expect(screen.getByTestId('modality-tag-audio')).toBeInTheDocument()
    expect(screen.getByTestId('modality-tag-video')).toBeInTheDocument()
    expect(screen.getByTestId('modality-tag-pdf')).toBeInTheDocument()
    expect(screen.queryByTestId('modality-tag-text')).not.toBeInTheDocument()
    expect(screen.queryByTestId('modality-tag-image')).not.toBeInTheDocument()
  })

  it('passes the explicit provider through and never renders legacy capability tags', () => {
    mocks.getSupportedInputModalitiesForDisplay.mockReturnValue(['text'])
    render(<ModelTagsWithLabel model={createModel()} provider={provider} />)
    expect(mocks.getSupportedInputModalitiesForDisplay).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1' }),
      provider
    )
    // Legacy vision/reasoning/tool/embedding/rerank/free/websearch tags are gone from this component.
    for (const legacy of [
      'tag-vision',
      'tag-reasoning',
      'tag-function_calling',
      'tag-embedding',
      'tag-rerank',
      'tag-free',
      'tag-web_search'
    ]) {
      expect(screen.queryByTestId(legacy)).not.toBeInTheDocument()
    }
    expect(screen.getByTestId('modality-tag-text')).toBeInTheDocument()
  })

  it('renders neutral outline boxes: transparent bg, 1px neutral border, 14px glyph, title + aria-label', () => {
    mocks.getSupportedInputModalitiesForDisplay.mockReturnValue(['text', 'image', 'audio', 'video', 'pdf'])
    const { container } = render(<ModelTagsWithLabel model={createModel()} provider={provider} />)

    // No CustomTag pill, no antd tooltip, no label text.
    expect(container.querySelectorAll('.ant-tooltip').length).toBe(0)
    const html = container.innerHTML
    expect(html).not.toContain('ant-tooltip')

    for (const modality of ['text', 'image', 'audio', 'video', 'pdf']) {
      const slot = screen.getByTestId(`modality-tag-${modality}`)
      // Single native title plus a matching aria-label; icon aria-hidden.
      expect(slot.getAttribute('title')).toBe(`models.capabilities.modality_${modality}`)
      expect(slot.getAttribute('aria-label')).toBe(`models.capabilities.modality_${modality}`)
      expect(slot.textContent).toBe('')
      // Fixed 20px slot with no inline background fill and no colorful inline color.
      const style = slot.getAttribute('style') ?? ''
      expect(style).not.toMatch(/background/i)
      for (const color of FORBIDDEN_MODALITY_COLORS) {
        expect(style.toLowerCase()).not.toContain(color)
      }
      const svg = slot.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg?.getAttribute('width')).toBe('14')
      expect(svg?.getAttribute('height')).toBe('14')
      expect(svg?.getAttribute('aria-hidden')).toBe('true')
    }

    // All five modalities share one neutral visual: same slot class.
    const slots = ['text', 'image', 'audio', 'video', 'pdf'].map((modality) =>
      screen.getByTestId(`modality-tag-${modality}`)
    )
    for (const slot of slots) {
      expect(slot.className).toBe(slots[0].className)
    }

    // Styled slot keeps the neutral contract on transparency:
    // 20px box, 4px radius, transparent background, theme-adaptive neutral tokens.
    const styleTags = Array.from(document.head.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
    expect(styleTags).toContain('20px')
    expect(styleTags).toContain('4px')
    expect(styleTags).toContain('transparent')
    expect(styleTags).toContain('var(--color-text-2)')
    expect(styleTags).toContain('var(--color-border)')
    expect(styleTags).toContain('var(--color-text-1)')
    for (const color of FORBIDDEN_MODALITY_COLORS) {
      expect(styleTags.toLowerCase()).not.toContain(color)
    }
  })

  it('exposes no showLabel prop and no ResizeObserver labeled path', async () => {
    const mod = await import('../ModelTagsWithLabel')
    const src = mod.default.toString()
    expect(src).not.toContain('ResizeObserver')
    // The component API carries no showLabel: icons only, never text.
    mocks.getSupportedInputModalitiesForDisplay.mockReturnValue(['text'])
    render(<ModelTagsWithLabel model={createModel()} provider={provider} />)
    expect(screen.getByTestId('modality-tag-text').textContent).toBe('')
  })

  it(' pdf uses FileText, distinct from text Type icon', async () => {
    mocks.getSupportedInputModalitiesForDisplay.mockReturnValue(['text', 'pdf'])
    render(<ModelTagsWithLabel model={createModel()} />)
    const textSvg = screen.getByTestId('modality-tag-text').querySelector('svg')?.outerHTML ?? ''
    const pdfSvg = screen.getByTestId('modality-tag-pdf').querySelector('svg')?.outerHTML ?? ''
    expect(textSvg.length).toBeGreaterThan(0)
    expect(pdfSvg.length).toBeGreaterThan(0)
    expect(pdfSvg).not.toBe(textSvg)
  })
})
