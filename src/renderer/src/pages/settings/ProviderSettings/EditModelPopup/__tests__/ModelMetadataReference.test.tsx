import { setModelMetadataSnapshotForTests } from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ModelMetadataReference, { formatLimitTokens, formatReferencePrice } from '../ModelMetadataReference'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const anthropicProvider = {
  id: 'a',
  type: 'anthropic',
  name: 'a',
  apiKey: '',
  apiHost: '',
  models: []
} as unknown as Provider

function makeModel(id: string): Model {
  return {
    id,
    provider: 'a',
    name: id,
    group: 'default',
    pricing: { input_per_million_tokens: 100, output_per_million_tokens: 200, currencySymbol: '$' }
  }
}

function installSnapshot(models: ModelMetadataSnapshot['providers']['string']['models']): void {
  const snapshot: ModelMetadataSnapshot = {
    source: 'models.dev',
    fetchedAt: 1_000_000,
    providers: {
      anthropic: { api: '', name: 'Anthropic', models }
    }
  }
  setModelMetadataSnapshotForTests(snapshot)
}

const FULL_ENTRY = {
  id: 'claude-full',
  modalities: { input: ['text'], output: ['text'] },
  family: 'claude',
  status: 'stable',
  knowledgeCutoff: '2025-01-01',
  releaseDate: '2025-02-01',
  limits: { context: 200000, input: 180000, output: 32000 },
  pricing: {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    reasoning: 1.5,
    inputAudio: 2,
    outputAudio: 6,
    contextOver200k: 6
  }
}

describe('ModelMetadataReference', () => {
  beforeEach(() => {
    setModelMetadataSnapshotForTests(null)
    vi.clearAllMocks()
  })

  it('shows the exact-match reference section with source label and formatted rows', () => {
    installSnapshot({ 'claude-full': FULL_ENTRY as never })
    render(<ModelMetadataReference model={makeModel('claude-full')} provider={anthropicProvider} />)

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
    // Limits use grouped formatting.
    expect(screen.getByTestId('ref-limit-context')).toHaveTextContent('200,000')
    expect(screen.getByTestId('ref-limit-input')).toHaveTextContent('180,000')
    expect(screen.getByTestId('ref-limit-output')).toHaveTextContent('32,000')
    expect(screen.getByTestId('ref-family')).toHaveTextContent('claude')
    expect(screen.getByTestId('ref-status')).toHaveTextContent('stable')
    expect(screen.getByTestId('ref-release-date')).toHaveTextContent('2025-02-01')
    expect(screen.getByTestId('ref-knowledge-cutoff')).toHaveTextContent('2025-01-01')
  })

  it('hides unavailable rows for partial metadata but keeps available pricing', () => {
    installSnapshot({
      'partial-1': {
        id: 'partial-1',
        modalities: { input: [], output: [] },
        pricing: { input: 1.25, output: 5 }
      } as never
    })
    render(<ModelMetadataReference model={makeModel('partial-1')} provider={anthropicProvider} />)

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-input')).toBeInTheDocument()
    expect(screen.getByTestId('ref-price-output')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-price-cache-read')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-limit-context')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-family')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-status')).not.toBeInTheDocument()
  })

  it('hides the whole section when no exact metadata exists', () => {
    installSnapshot({ 'claude-full': FULL_ENTRY as never })
    const { container } = render(
      <ModelMetadataReference model={makeModel('unknown-id')} provider={anthropicProvider} />
    )
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('hides the whole section when the entry has no displayable rows', () => {
    installSnapshot({
      empty: { id: 'empty', modalities: { input: [], output: [] } } as never
    })
    const { container } = render(<ModelMetadataReference model={makeModel('empty')} provider={anthropicProvider} />)
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('degrades gracefully on malformed field types without blocking', () => {
    installSnapshot({
      broken: {
        id: 'broken',
        modalities: { input: [], output: [] },
        pricing: { input: 'cheap', output: null, cacheRead: Number.NaN },
        limits: { context: 'big' },
        family: 42,
        status: '',
        releaseDate: null,
        knowledgeCutoff: '  '
      } as never
    })
    const { container } = render(<ModelMetadataReference model={makeModel('broken')} provider={anthropicProvider} />)
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('does not overwrite user pricing automatically; adoption only copies input/output on click', async () => {
    installSnapshot({ 'claude-full': FULL_ENTRY as never })
    const onAdopt = vi.fn()
    const user = userEvent.setup()
    render(
      <ModelMetadataReference
        model={makeModel('claude-full')}
        provider={anthropicProvider}
        onUseReferencePricing={onAdopt}
      />
    )

    // Explicit action exists only because normalized input+output prices exist.
    const button = screen.getByTestId('use-reference-pricing')
    expect(button).toBeInTheDocument()
    // No automatic overwrite before interaction.
    expect(onAdopt).not.toHaveBeenCalled()

    await user.click(button)
    // Only the two Model.pricing-representable fields are carried over.
    expect(onAdopt).toHaveBeenCalledTimes(1)
    expect(onAdopt).toHaveBeenCalledWith(3, 15)
  })

  it('offers no adoption action when normalized input/output prices are absent', () => {
    installSnapshot({
      'cache-only': {
        id: 'cache-only',
        modalities: { input: [], output: [] },
        pricing: { cacheRead: 0.1 },
        family: 'claude'
      } as never
    })
    render(
      <ModelMetadataReference
        model={makeModel('cache-only')}
        provider={anthropicProvider}
        onUseReferencePricing={vi.fn()}
      />
    )

    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.queryByTestId('use-reference-pricing')).not.toBeInTheDocument()
  })

  it('formats prices and limits deterministically', () => {
    expect(formatReferencePrice(3)).toBe('$3')
    expect(formatReferencePrice(0.3)).toBe('$0.3')
    expect(formatLimitTokens(200000)).toBe('200,000')
    expect(formatLimitTokens(32000)).toBe('32,000')
  })
})
