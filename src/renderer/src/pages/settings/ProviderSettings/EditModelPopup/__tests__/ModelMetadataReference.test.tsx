import type { NormalizedModelMetadata } from '@shared/modelMetadata'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ModelMetadataReference, {
  formatLimitTokens,
  formatReasoningControls,
  formatReferencePrice,
  hasConcreteModelData
} from '../ModelMetadataReference'

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
  limits: { context: 200000, output: 32000 },
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 1.5 },
  effort: ['low', 'max']
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
    // Limits: context and output both render; input limit intentionally not restored.
    expect(screen.getByTestId('ref-limit-context')).toHaveTextContent('200,000')
    expect(screen.getByTestId('ref-limit-output')).toHaveTextContent('32,000')
    expect(screen.queryByTestId('ref-limit-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('ref-release-date')).toHaveTextContent('2025-02-01')
    expect(screen.getByTestId('ref-knowledge-cutoff')).toHaveTextContent('2025-01-01')
    // Pricing via effective.cost
    expect(screen.getByTestId('ref-price-input')).toHaveTextContent('$3')
    expect(screen.getByTestId('ref-price-output')).toHaveTextContent('$15')
    expect(screen.getByTestId('ref-price-cache-read')).toHaveTextContent('$0.3')
    expect(screen.getByTestId('ref-price-cache-write')).toHaveTextContent('$1.5')
    // Reasoning controls via effective.effort (normalized, max stays as provided here)
    expect(screen.getByTestId('ref-reasoning-controls')).toHaveTextContent('low, max')
    // Unrelated historical fields never render
    expect(screen.queryByTestId('ref-family')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-status')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-modalities-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-modalities-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-tiers')).not.toBeInTheDocument()
    // Four features never render as Model Data text rows: they only show in
    // the Model Features icon group above.
    expect(screen.queryByTestId('ref-reasoning-support')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-tool-call')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-structured-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-temperature')).not.toBeInTheDocument()
  })

  it('renders pricing and reasoning rows from cost/effort and hides missing subfields', () => {
    render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'partial-pricing',
          modalities: { input: ['text'], output: ['text'] },
          limits: { context: 200000 },
          cost: { input: 1.25, output: 5 },
          effort: ['low']
        })}
      />
    )

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-input')).toHaveTextContent('$1.25')
    expect(screen.getByTestId('ref-price-output')).toHaveTextContent('$5')
    expect(screen.queryByTestId('ref-price-cache-read')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-cache-write')).not.toBeInTheDocument()
    expect(screen.getByTestId('ref-reasoning-controls')).toHaveTextContent('low')
    expect(screen.getByTestId('ref-limit-context')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-limit-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-family')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-status')).not.toBeInTheDocument()
  })

  it('hides cost/reasoning/output rows when those fields are missing but keeps available rows', () => {
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
    expect(screen.queryByTestId('ref-limit-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-cache-read')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-cache-write')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-reasoning-controls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-release-date')).not.toBeInTheDocument()
    // Four features never render as Model Data text rows even when missing.
    expect(screen.queryByTestId('ref-reasoning-support')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-tool-call')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-structured-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-temperature')).not.toBeInTheDocument()
  })

  it('renders no pricing adoption action and no read-only note', () => {
    render(<ModelMetadataReference entry={FULL_ENTRY} />)

    expect(screen.queryByTestId('use-reference-pricing')).not.toBeInTheDocument()
    expect(screen.queryByText('models.reference.description')).not.toBeInTheDocument()
    expect(screen.queryByText('models.reference.use_pricing')).not.toBeInTheDocument()
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

  it('never shows Model Data from reasoning effort alone', () => {
    const { container } = render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'effort-only',
          reasoning: true,
          effort: ['low', 'max']
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
    // effort alone never counts either
    expect(
      hasConcreteModelData({
        id: 'x',
        effort: ['low'],
        modalities: { input: [], output: [] }
      } as never)
    ).toBe(false)
    expect(
      hasConcreteModelData({
        id: 'x',
        cost: { input: 1, output: 2 },
        modalities: { input: [], output: [] }
      } as never)
    ).toBe(true)
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
        limits: { output: 32000 },
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
    render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'broken',
          modalities: { input: [], output: [] },
          cost: { input: 'cheap', output: null, cacheRead: Number.NaN },
          effort: 'low',
          limits: { context: 'big', output: 20 },
          releaseDate: null,
          knowledgeCutoff: '  '
        })}
      />
    )
    // Only valid output limit survives malformed cohort
    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.getByTestId('ref-limit-output')).toHaveTextContent('20')
    expect(screen.queryByTestId('ref-limit-context')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-reasoning-controls')).not.toBeInTheDocument()
  })

  it('formats prices, limits and reasoning controls deterministically', () => {
    expect(formatReferencePrice(3)).toBe('$3')
    expect(formatReferencePrice(0.3)).toBe('$0.3')
    expect(formatLimitTokens(200000)).toBe('200,000')
    expect(formatLimitTokens(32000)).toBe('32,000')
    expect(formatReasoningControls(['low', 'max'])).toEqual({ text: 'low, max', known: true })
    expect(formatReasoningControls({ effort: ['low', 'max'] })).toEqual({ text: 'low, max', known: true })
    expect(formatReasoningControls([])).toEqual({ text: '', known: false })
    expect(formatReasoningControls(undefined)).toEqual({ text: '', known: false })
    expect(formatReasoningControls({})).toEqual({ text: '', known: false })
  })
})
