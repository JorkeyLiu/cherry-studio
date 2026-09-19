import type { NormalizedModelMetadata } from '@shared/modelMetadata'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ModelMetadataReference, { formatLimitTokens, hasConcreteModelData } from '../ModelMetadataReference'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const FULL_ENTRY = {
  id: 'moonshotai/kimi-k3',
  modalities: { input: ['text', 'image'], output: ['text'] },
  knowledgeCutoff: '2025-01-01',
  releaseDate: '2025-02-01',
  reasoning: true,
  toolCall: false,
  structuredOutput: true,
  temperature: false,
  limits: { context: 200000, input: 180000, output: 32000 }
} as unknown as NormalizedModelMetadata

function entryOf(partial: Record<string, unknown>): NormalizedModelMetadata {
  return partial as unknown as NormalizedModelMetadata
}

describe('ModelMetadataReference', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the canonical model-data section with source label and formatted rows', () => {
    render(<ModelMetadataReference entry={FULL_ENTRY} />)

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.getByTestId('ref-source')).toHaveTextContent('models.dev')
    // Only context limit survives; input/output limits are removed.
    expect(screen.getByTestId('ref-limit-context')).toHaveTextContent('200,000')
    expect(screen.queryByTestId('ref-limit-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-limit-output')).not.toBeInTheDocument()
    expect(screen.getByTestId('ref-release-date')).toHaveTextContent('2025-02-01')
    expect(screen.getByTestId('ref-knowledge-cutoff')).toHaveTextContent('2025-01-01')
    // Removed Model Data fields never render.
    expect(screen.queryByTestId('ref-family')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-status')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-modalities-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-modalities-output')).not.toBeInTheDocument()
    // Four features never render as Model Data text rows: they only show in
    // the Model Features icon group above.
    expect(screen.queryByTestId('ref-reasoning-support')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-tool-call')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-structured-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-temperature')).not.toBeInTheDocument()
  })

  it('never renders pricing or reasoning-option rows: canonical models.json does not publish them', () => {
    render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'moonshotai/kimi-k3',
          modalities: { input: ['text'], output: ['text'] },
          limits: { context: 200000 },
          // Proxy-shaped leftovers must never render as canonical facts.
          pricing: { input: 3, output: 15, cacheRead: 0.3, hasTiers: true },
          reasoningControls: { toggle: true, effort: ['low', 'max'] }
        })}
      />
    )

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-cache-read')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-tiers')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-reasoning-controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('ref-limit-context')).toBeInTheDocument()
  })

  it('renders no pricing adoption action and no read-only note', () => {
    render(<ModelMetadataReference entry={FULL_ENTRY} />)

    expect(screen.queryByTestId('use-reference-pricing')).not.toBeInTheDocument()
    expect(screen.queryByText('models.reference.description')).not.toBeInTheDocument()
    expect(screen.queryByText('models.reference.use_pricing')).not.toBeInTheDocument()
  })

  it('hides unavailable rows for partial metadata but keeps available rows', () => {
    render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'partial-1',
          modalities: { input: [], output: [] },
          limits: { context: 200000 }
        })}
      />
    )

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.getByTestId('ref-limit-context')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-release-date')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-family')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-status')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-limit-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-limit-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-modalities-input')).not.toBeInTheDocument()
    // Four features never render as Model Data text rows even when missing.
    expect(screen.queryByTestId('ref-reasoning-support')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-tool-call')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-structured-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-temperature')).not.toBeInTheDocument()
  })

  it('hides Model Data for a features-only entry because features show in the icon group', () => {
    const { container } = render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'features-only',
          reasoning: true,
          toolCall: false,
          structuredOutput: true,
          temperature: false
        })}
      />
    )
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('gates section visibility on concrete rows only', () => {
    expect(hasConcreteModelData(undefined)).toBe(false)
    expect(hasConcreteModelData({ id: 'x', modalities: { input: [], output: [] } } as never)).toBe(false)
    // features alone never count as concrete data
    expect(
      hasConcreteModelData({
        id: 'x',
        reasoning: true,
        toolCall: false,
        modalities: { input: [], output: [] }
      } as never)
    ).toBe(false)
    // proxy-shaped pricing/reasoning leftovers never count either
    expect(
      hasConcreteModelData({
        id: 'x',
        pricing: { input: 1, output: 2 },
        reasoningControls: { effort: ['low'] },
        modalities: { input: [], output: [] }
      } as never)
    ).toBe(false)
    expect(
      hasConcreteModelData({
        id: 'x',
        limits: { context: 200000 },
        modalities: { input: [], output: [] }
      } as never)
    ).toBe(true)
    expect(
      hasConcreteModelData({
        id: 'x',
        knowledgeCutoff: '2025-01-01',
        modalities: { input: [], output: [] }
      } as never)
    ).toBe(true)
  })

  it('hides the whole section when no entry exists', () => {
    const { container } = render(<ModelMetadataReference entry={undefined} />)
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('hides the whole section when the entry has no displayable rows', () => {
    const { container } = render(
      <ModelMetadataReference entry={entryOf({ id: 'empty', modalities: { input: [], output: [] } })} />
    )
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('degrades gracefully on malformed field types without blocking', () => {
    const { container } = render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'broken',
          modalities: { input: [], output: [] },
          limits: { context: 'big', input: 10, output: 20 },
          releaseDate: null,
          knowledgeCutoff: '  '
        })}
      />
    )
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('formats limits deterministically', () => {
    expect(formatLimitTokens(200000)).toBe('200,000')
    expect(formatLimitTokens(32000)).toBe('32,000')
  })
})
