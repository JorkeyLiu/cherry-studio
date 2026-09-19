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
  id: 'claude-full',
  modalities: { input: ['text', 'image'], output: ['text'] },
  knowledgeCutoff: '2025-01-01',
  releaseDate: '2025-02-01',
  reasoning: true,
  toolCall: false,
  structuredOutput: true,
  temperature: false,
  reasoningControls: { toggle: true, budget: true, effort: ['low', 'max'] },
  limits: { context: 200000, input: 180000, output: 32000 },
  pricing: {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    reasoning: 1.5,
    inputAudio: 2,
    outputAudio: 6,
    contextOver200k: 6,
    hasTiers: true
  }
} as unknown as NormalizedModelMetadata

function entryOf(partial: Record<string, unknown>): NormalizedModelMetadata {
  return partial as unknown as NormalizedModelMetadata
}

describe('ModelMetadataReference', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the exact-match model-data section with source label and formatted rows', () => {
    render(<ModelMetadataReference entry={FULL_ENTRY} />)

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.getByTestId('ref-source')).toHaveTextContent('models.dev')
    // Pricing rows expose every normalized category present in the schema.
    expect(screen.getByTestId('ref-price-input')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-output')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-cache-read')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-cache-write')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-reasoning')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-input-audio')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-output-audio')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-context-over-200k')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-tiers')).toBeInTheDocument()
    // Only context limit survives; input/output limits are removed.
    expect(screen.getByTestId('ref-limit-context')).toHaveTextContent('200,000')
    expect(screen.queryByTestId('ref-limit-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-limit-output')).not.toBeInTheDocument()
    expect(screen.getByTestId('ref-release-date')).toHaveTextContent('2025-02-01')
    expect(screen.getByTestId('ref-knowledge-cutoff')).toHaveTextContent('2025-01-01')
    // Tiered pricing uses its own label, never the generic status label.
    expect(screen.getByText('models.reference.tiered_pricing')).toBeInTheDocument()
    expect(screen.queryByText('models.reference.status')).not.toBeInTheDocument()
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
    // Reasoning controls show raw effort values only: no toggle/budget/Supported wording.
    expect(screen.getByTestId('ref-reasoning-controls')).toHaveTextContent('low, max')
    expect(screen.getByTestId('ref-reasoning-controls')).not.toHaveTextContent('toggle')
    expect(screen.getByTestId('ref-reasoning-controls')).not.toHaveTextContent('budget')
    expect(screen.getByTestId('ref-reasoning-controls')).not.toHaveTextContent('models.reference.supported')
  })

  it('renders no pricing adoption action and no read-only note', () => {
    render(<ModelMetadataReference entry={FULL_ENTRY} />)

    expect(screen.queryByTestId('use-reference-pricing')).not.toBeInTheDocument()
    expect(screen.queryByText('models.reference.description')).not.toBeInTheDocument()
    expect(screen.queryByText('models.reference.use_pricing')).not.toBeInTheDocument()
  })

  it('hides unavailable rows for partial metadata but keeps available pricing', () => {
    render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'partial-1',
          modalities: { input: [], output: [] },
          pricing: { input: 1.25, output: 5 }
        })}
      />
    )

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-input')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-output')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-cache-read')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-limit-context')).not.toBeInTheDocument()
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
    // Missing effort hides the row entirely: no Not supported placeholder.
    expect(screen.queryByTestId('ref-reasoning-controls')).not.toBeInTheDocument()
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

  it('never shows Model Data from reasoning-controls alone', () => {
    const { container } = render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'effort-only',
          reasoning: true,
          reasoningControls: { toggle: true, budget: true, effort: [] }
        })}
      />
    )
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('hides reasoning controls for known reasoning without published effort', () => {
    render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'reason-only',
          modalities: { input: ['text'], output: ['text'] },
          reasoning: true,
          pricing: { input: 1, output: 2 }
        })}
      />
    )

    // The section still shows (pricing is concrete) but the effort row hides.
    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-reasoning-controls')).not.toBeInTheDocument()
  })

  it('hides reasoning controls when effort is empty, even with toggle/budget', () => {
    render(
      <ModelMetadataReference
        entry={entryOf({
          id: 'empty-effort',
          reasoning: true,
          reasoningControls: { toggle: true, budget: true, effort: [] },
          pricing: { input: 1, output: 2 }
        })}
      />
    )

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-reasoning-controls')).not.toBeInTheDocument()
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
        reasoningControls: { effort: ['low'] },
        modalities: { input: [], output: [] }
      } as never)
    ).toBe(false)
    expect(
      hasConcreteModelData({
        id: 'x',
        pricing: { input: 1, output: 2 },
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
          pricing: { input: 'cheap', output: null, cacheRead: Number.NaN },
          limits: { context: 'big', input: 10, output: 20 },
          releaseDate: null,
          knowledgeCutoff: '  '
        })}
      />
    )
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('formats prices and limits deterministically', () => {
    expect(formatReferencePrice(3)).toBe('$3')
    expect(formatReferencePrice(0.3)).toBe('$0.3')
    expect(formatLimitTokens(200000)).toBe('200,000')
    expect(formatLimitTokens(32000)).toBe('32,000')
  })

  it('formats reasoning controls from effort values only', () => {
    expect(formatReasoningControls({ toggle: true, budget: true, effort: ['low', 'max'] })).toEqual({
      text: 'low, max',
      known: true
    })
    // Empty/missing effort is unknown: the row hides, never a placeholder.
    expect(formatReasoningControls({ toggle: true, budget: true, effort: [] })).toEqual({ text: '', known: false })
    expect(formatReasoningControls(undefined)).toEqual({ text: '', known: false })
    expect(formatReasoningControls({})).toEqual({ text: '', known: false })
  })
})
