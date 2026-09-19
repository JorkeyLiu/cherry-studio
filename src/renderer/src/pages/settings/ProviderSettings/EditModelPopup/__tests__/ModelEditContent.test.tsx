import { setModelMetadataSnapshotForTests, setModelMetadataStatusForTests } from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ModelEditContent from '../ModelEditContent'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

// jsdom shims for Ant Design Modal (house pattern): matchMedia for responsive
// observer, single-arg getComputedStyle for scrollbar measurement.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}
{
  const originalGetComputedStyle = window.getComputedStyle.bind(window)
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: ((elt: Element) => originalGetComputedStyle(elt)) as typeof window.getComputedStyle
  })
}

const openaiProvider = {
  id: 'openai',
  type: 'openai',
  name: 'OpenAI',
  apiKey: '',
  apiHost: 'https://api.openai.com/v1',
  models: []
} as unknown as Provider

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'gpt-4o',
    provider: 'openai',
    name: 'GPT-4o',
    group: 'OpenAI',
    ...overrides
  }
}

function renderEditor(model: Model, onUpdateModel = vi.fn()) {
  const onOk = vi.fn()
  const onCancel = vi.fn()
  render(
    <ModelEditContent
      provider={openaiProvider}
      model={model}
      open
      onOk={onOk}
      onCancel={onCancel}
      onUpdateModel={onUpdateModel}
    />
  )
  return { onUpdateModel, onOk, onCancel }
}

function installEntry(modelId: string, entry: Record<string, unknown>) {
  // Canonical snapshot: the model id resolves through its unique basename to
  // the canonical `openai/<id>` entry.
  const canonicalId = `openai/${modelId}`
  setModelMetadataSnapshotForTests({
    source: 'models.dev',
    fetchedAt: 1,
    models: { [canonicalId]: { id: canonicalId, ...entry } as never },
    providers: {}
  })
}

const ALL_MODALITY_IDS = [
  'cap-modality-text',
  'cap-modality-image',
  'cap-modality-audio',
  'cap-modality-video',
  'cap-modality-pdf'
]

const ALL_FEATURE_IDS = [
  'cap-feature-reasoning',
  'cap-feature-tool-call',
  'cap-feature-structured-output',
  'cap-feature-temperature'
]

describe('ModelEditContent', () => {
  beforeEach(() => {
    setModelMetadataSnapshotForTests(null)
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('shows only groups with data above the model data, in DOM order', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text', 'image'], output: ['text'] },
      limits: { context: 250000 }
    })
    renderEditor(makeModel())

    const capabilities = screen.getByTestId('model-capabilities')
    expect(capabilities).toBeInTheDocument()
    expect(screen.getByTestId('input-modalities-title')).toHaveTextContent('models.capabilities.input_modalities')
    expect(screen.getByTestId('input-modalities')).toBeInTheDocument()
    // No feature metadata: the whole Features group hides (title included).
    expect(screen.queryByTestId('model-features-title')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-features')).not.toBeInTheDocument()

    const reference = screen.getByTestId('models-dev-reference')
    expect(reference).toBeInTheDocument()
    // Groups render before model data in DOM order.
    expect(capabilities.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Some group has data: no empty-state line.
    expect(screen.queryByTestId('model-metadata-empty')).not.toBeInTheDocument()
  })

  it('hides all metadata groups with a loading empty-state when the entry is missing', () => {
    renderEditor(makeModel({ id: 'some-unknown-model', name: 'some-unknown-model' }))

    // Both capability groups hide entirely: no titles, no tags, no hints.
    expect(screen.queryByTestId('model-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('input-modalities-title')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-features-title')).not.toBeInTheDocument()
    for (const testId of [...ALL_MODALITY_IDS, ...ALL_FEATURE_IDS]) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument()
    }
    expect(document.body.querySelectorAll('[data-state="unknown"]')).toHaveLength(0)
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    // No snapshot and init pending: the single fetching line shows.
    expect(screen.getByTestId('model-metadata-empty')).toHaveTextContent('models.reference.loading')
  })

  it.each([
    ['loading', 'models.reference.loading', { kind: 'loading', snapshot: null } as const],
    [
      'unavailable',
      'models.reference.unavailable',
      { kind: 'unavailable', snapshot: null, reason: 'network-error' } as const
    ]
  ])('shows the %s empty-state when all three groups are empty', (_label, textKey, status) => {
    act(() => {
      setModelMetadataStatusForTests(status)
    })
    renderEditor(makeModel({ id: 'some-unknown-model', name: 'some-unknown-model' }))

    expect(screen.queryByTestId('model-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-metadata-empty')).toHaveTextContent(textKey)
  })

  it('shows the ready empty-state for an unknown model once a snapshot is cached', () => {
    // A cached snapshot means ready even when this model id is unknown.
    installEntry('other-model', {
      modalities: { input: ['text'], output: ['text'] },
      limits: { context: 200000 }
    })
    renderEditor(makeModel({ id: 'some-unknown-model', name: 'some-unknown-model' }))

    expect(screen.queryByTestId('model-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('models-dev-reference')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-metadata-empty')).toHaveTextContent('models.reference.no_data')
  })

  it('updates the open popup asynchronously when the registry resolves', () => {
    const { unmount } = render(
      <ModelEditContent
        provider={openaiProvider}
        model={makeModel()}
        open
        onOk={vi.fn()}
        onCancel={vi.fn()}
        onUpdateModel={vi.fn()}
      />
    )
    expect(screen.getByTestId('model-metadata-empty')).toHaveTextContent('models.reference.loading')

    act(() => {
      installEntry('gpt-4o', {
        modalities: { input: ['text', 'image'], output: ['text'] },
        limits: { context: 200000 }
      })
    })

    // The subscribed open popup re-renders without remounting.
    expect(screen.queryByTestId('model-metadata-empty')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-capabilities')).toBeInTheDocument()
    expect(screen.getByTestId('cap-modality-image')).toHaveAttribute('data-state', 'supported')
    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    unmount()
  })

  it('maps five input modalities from entry.modalities.input only', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text', 'image'], output: ['text'] },
      limits: { context: 200000 }
    })
    // User override and vision-like names must not leak into the modality group.
    renderEditor(makeModel({ capabilities: [{ type: 'vision', isUserSelected: false }] }))

    expect(screen.getByTestId('cap-modality-text')).toHaveAttribute('data-state', 'supported')
    expect(screen.getByTestId('cap-modality-image')).toHaveAttribute('data-state', 'supported')
    expect(screen.getByTestId('cap-modality-audio')).toHaveAttribute('data-state', 'unsupported')
    expect(screen.getByTestId('cap-modality-video')).toHaveAttribute('data-state', 'unsupported')
    expect(screen.getByTestId('cap-modality-pdf')).toHaveAttribute('data-state', 'unsupported')
    expect(screen.getByTestId('cap-modality-text').getAttribute('title')).toContain('models.reference.supported')
    expect(screen.getByTestId('cap-modality-audio').getAttribute('title')).toContain('models.reference.unsupported')
  })

  it('hides the modality group without tags when modalities are empty', () => {
    installEntry('empty-modal', {
      modalities: { input: [], output: [] },
      limits: { context: 200000 }
    })
    renderEditor(makeModel({ id: 'empty-modal', name: 'empty-modal' }))

    // Empty group hides its title and tags: no hint text replaces them.
    expect(screen.queryByTestId('input-modalities-title')).not.toBeInTheDocument()
    expect(screen.queryByTestId('input-modalities')).not.toBeInTheDocument()
    for (const testId of ALL_MODALITY_IDS) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument()
    }
    // Model Data still shows (context limit is concrete): no empty-state line.
    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.queryByTestId('model-metadata-empty')).not.toBeInTheDocument()
  })

  it('renders known features without hints while hiding unknown items', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text'], output: ['text'] },
      reasoning: true,
      toolCall: false,
      structuredOutput: undefined,
      temperature: false,
      limits: { context: 200000 }
    })
    renderEditor(makeModel())

    expect(screen.getByTestId('cap-feature-reasoning')).toHaveAttribute('data-state', 'supported')
    expect(screen.getByTestId('cap-feature-tool-call')).toHaveAttribute('data-state', 'unsupported')
    expect(screen.getByTestId('cap-feature-temperature')).toHaveAttribute('data-state', 'unsupported')
    // Unknown field renders no tag: unsupported stays, unknown disappears.
    expect(screen.queryByTestId('cap-feature-structured-output')).not.toBeInTheDocument()
    expect(screen.getByTestId('cap-feature-tool-call').getAttribute('title')).toContain('models.reference.unsupported')
    expect(screen.getByTestId('cap-feature-reasoning').getAttribute('title')).toContain('models.reference.supported')
    expect(document.body.querySelectorAll('[data-state="unknown"]')).toHaveLength(0)
  })

  it('keeps unsupported tags visible while unknown fields stay untagged', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text'], output: ['text'] },
      reasoning: undefined,
      toolCall: false,
      structuredOutput: undefined,
      temperature: true,
      limits: { context: 200000 }
    })
    renderEditor(makeModel())

    // Explicit false renders a gray unsupported tag; undefined renders nothing.
    expect(screen.getByTestId('cap-feature-tool-call')).toHaveAttribute('data-state', 'unsupported')
    expect(screen.getByTestId('cap-feature-temperature')).toHaveAttribute('data-state', 'supported')
    expect(screen.queryByTestId('cap-feature-reasoning')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cap-feature-structured-output')).not.toBeInTheDocument()
  })

  it('never renders dashed unknown styles or unknown data-states', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text'], output: ['text'] },
      reasoning: true,
      toolCall: undefined,
      structuredOutput: undefined,
      temperature: undefined,
      limits: { context: 200000 }
    })
    render(
      <ModelEditContent
        provider={openaiProvider}
        model={makeModel()}
        open
        onOk={vi.fn()}
        onCancel={vi.fn()}
        onUpdateModel={vi.fn()}
      />
    )

    expect(document.body.querySelectorAll('[data-state="unknown"]')).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain('dashed')
    // Only real tags carry data-state, and only supported/unsupported values.
    for (const el of Array.from(document.body.querySelectorAll('[data-state]'))) {
      expect(['supported', 'unsupported']).toContain(el.getAttribute('data-state'))
    }
  })

  it('keeps four features in the icon group without duplicating them in Model Data', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text'], output: ['text'] },
      reasoning: true,
      toolCall: false,
      structuredOutput: true,
      temperature: false,
      limits: { context: 200000 }
    })
    renderEditor(makeModel())

    // Upper Model Features icons keep known states from entry booleans only.
    expect(screen.getByTestId('cap-feature-reasoning')).toHaveAttribute('data-state', 'supported')
    expect(screen.getByTestId('cap-feature-tool-call')).toHaveAttribute('data-state', 'unsupported')
    expect(screen.getByTestId('cap-feature-structured-output')).toHaveAttribute('data-state', 'supported')
    expect(screen.getByTestId('cap-feature-temperature')).toHaveAttribute('data-state', 'unsupported')
    // Model Data shows context limit but never duplicates the four features.
    expect(screen.getByTestId('models-dev-reference')).toBeInTheDocument()
    expect(screen.getByTestId('ref-limit-context')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-reasoning-support')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-tool-call')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-structured-output')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-temperature')).not.toBeInTheDocument()
  })

  it('renders a single native title per tag with no antd tooltip duplicate', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: true,
      toolCall: false,
      structuredOutput: true,
      temperature: false,
      limits: { context: 200000 }
    })
    renderEditor(makeModel())

    // Every detail tag keeps exactly one native title on its wrapper.
    for (const testId of [...ALL_MODALITY_IDS, ...ALL_FEATURE_IDS]) {
      const wrapper = screen.getByTestId(testId)
      expect(wrapper.getAttribute('title')).toContain(': ')
    }
    // The inner CustomTag renders no antd Tooltip: no tooltip DOM anywhere.
    expect(document.body.querySelectorAll('.ant-tooltip').length).toBe(0)
  })

  it('renders no Form.Item help tooltips in Edit Model', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text'], output: ['text'] },
      limits: { context: 200000 }
    })
    renderEditor(makeModel())

    // The three Edit Model fields (id/name/group) carry no '?' help icon.
    expect(document.body.querySelectorAll('.ant-form-item-tooltip').length).toBe(0)
    expect(document.body.querySelectorAll('.anticon-question-circle').length).toBe(0)
  })

  it('removes legacy capability tags and never treats icons as clickable', async () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: true,
      toolCall: false,
      structuredOutput: true,
      temperature: false,
      limits: { context: 200000 }
    })
    const { onUpdateModel } = renderEditor(makeModel())
    const user = userEvent.setup()

    for (const key of ['models.type.vision', 'models.type.websearch', 'models.type.rerank', 'models.type.embedding']) {
      expect(screen.queryByText(key)).not.toBeInTheDocument()
    }
    expect(screen.queryByTestId('model-capabilities-title')).not.toBeInTheDocument()

    // Five-modality + four-feature labels render when their groups are known.
    for (const key of [
      'models.capabilities.modality_text',
      'models.capabilities.modality_image',
      'models.capabilities.modality_audio',
      'models.capabilities.modality_video',
      'models.capabilities.modality_pdf',
      'models.capabilities.feature_reasoning',
      'models.capabilities.feature_tool_call',
      'models.capabilities.feature_structured_output',
      'models.capabilities.feature_temperature'
    ]) {
      expect(screen.getByText(key)).toBeInTheDocument()
    }

    // Clicking icons never writes back: no update, no override.
    await user.click(screen.getByText('models.capabilities.modality_image'))
    await user.click(screen.getByText('models.capabilities.feature_reasoning'))
    expect(onUpdateModel).not.toHaveBeenCalled()
  })

  it('hides the features group when the entry has modalities but no feature metadata', () => {
    installEntry('gpt-4o', {
      modalities: { input: ['text', 'image'], output: ['text'] },
      limits: { context: 200000 }
    })
    renderEditor(makeModel())

    // Modalities fully known: five tags, no hint.
    for (const testId of ALL_MODALITY_IDS) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
    // Features fully unknown: no tags, no title, no hint.
    for (const testId of ALL_FEATURE_IDS) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument()
    }
    expect(screen.queryByTestId('model-features-title')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-features')).not.toBeInTheDocument()
  })

  it('removes the More Settings editing surface', () => {
    renderEditor(makeModel())

    expect(screen.queryByText('settings.moresetting.label')).not.toBeInTheDocument()
    // Incremental text output switch is gone.
    expect(document.body.querySelector('.ant-switch')).toBeNull()
    expect(screen.queryByText('settings.models.add.supported_text_delta.label')).not.toBeInTheDocument()
    // Manual price/currency editing is gone.
    expect(screen.queryByText('models.price.input')).not.toBeInTheDocument()
    expect(screen.queryByText('models.price.output')).not.toBeInTheDocument()
    expect(screen.queryByText('models.price.currency')).not.toBeInTheDocument()
    // Reference pricing adoption is gone.
    expect(screen.queryByTestId('use-reference-pricing')).not.toBeInTheDocument()
  })

  it('saves id/name/group from the footer while preserving hidden configuration', async () => {
    const stored = makeModel({
      capabilities: [{ type: 'vision', isUserSelected: true }],
      supported_text_delta: false,
      pricing: { input_per_million_tokens: 2.5, output_per_million_tokens: 10, currencySymbol: '€' },
      endpoint_type: 'openai' as Model['endpoint_type'],
      supported_endpoint_types: ['openai'] as Model['supported_endpoint_types']
    })
    const { onUpdateModel } = renderEditor(stored)
    const user = userEvent.setup()

    // Footer save (standard right-aligned footer, not the retired inline row).
    await user.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => expect(onUpdateModel).toHaveBeenCalledTimes(1))
    const saved = onUpdateModel.mock.calls[0][0] as Model
    expect(saved.id).toBe('gpt-4o')
    expect(saved.name).toBe('GPT-4o')
    expect(saved.group).toBe('OpenAI')
    // Hidden configuration is preserved exactly — never cleared or zeroed.
    expect(saved.capabilities).toEqual([{ type: 'vision', isUserSelected: true }])
    expect(saved.supported_text_delta).toBe(false)
    expect(saved.pricing).toEqual({
      input_per_million_tokens: 2.5,
      output_per_million_tokens: 10,
      currencySymbol: '€'
    })
    expect(saved.endpoint_type).toBe('openai')
    expect(saved.supported_endpoint_types).toEqual(['openai'])
  })

  it('submits edited name/group while still preserving hidden configuration', async () => {
    const stored = makeModel({
      capabilities: [{ type: 'reasoning', isUserSelected: false }],
      supported_text_delta: true,
      pricing: { input_per_million_tokens: 1, output_per_million_tokens: 2, currencySymbol: '$' }
    })
    const { onUpdateModel } = renderEditor(stored)
    const user = userEvent.setup()

    fireEvent.change(screen.getByPlaceholderText('settings.models.add.model_name.placeholder'), {
      target: { value: 'Renamed' }
    })
    await user.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => expect(onUpdateModel).toHaveBeenCalledTimes(1))
    const saved = onUpdateModel.mock.calls[0][0] as Model
    expect(saved.name).toBe('Renamed')
    expect(saved.capabilities).toEqual([{ type: 'reasoning', isUserSelected: false }])
    expect(saved.supported_text_delta).toBe(true)
    expect(saved.pricing).toEqual({
      input_per_million_tokens: 1,
      output_per_million_tokens: 2,
      currencySymbol: '$'
    })
  })
})
