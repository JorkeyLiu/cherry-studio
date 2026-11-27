import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const LONG_ID = 'a-very-long-model-identifier-that-must-not-push-the-popover-out-of-bounds-2025-01-01'

const mockProviders = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    apiKey: '',
    apiHost: '',
    models: [
      { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'default' },
      { id: 'gpt-4o', name: 'gpt-4o', provider: 'openai', group: 'default' }
    ]
  },
  {
    id: 'azure',
    name: 'Azure',
    type: 'azure',
    apiKey: '',
    apiHost: '',
    models: [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'azure', group: 'default' }]
  },
  {
    id: 'long-id-provider',
    name: 'LongId',
    type: 'openai',
    apiKey: '',
    apiHost: '',
    models: [{ id: LONG_ID, name: 'Long Model', provider: 'long-id-provider', group: 'default' }]
  },
  {
    id: 'empty-provider',
    name: 'EmptyProvider',
    type: 'openai',
    apiKey: '',
    apiHost: '',
    models: []
  }
]

const updateAssistantMock = vi.fn()

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, provider, size }: any) => (
    <div data-testid={`avatar-${model.id}`} data-provider-id={provider?.id} data-size={size} />
  )
}))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: mockProviders })
}))
vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ updateAssistant: updateAssistantMock })
}))
vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: (m: any) => `${m.provider}::${m.id}`
}))
vi.mock('@renderer/utils', () => ({
  getFancyProviderName: (p: any) => p.name
}))
vi.mock('@renderer/config/models', () => ({
  isEmbeddingModel: () => false,
  isRerankModel: () => false
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/pages/home/Inputbar/components/ToolPopover', () => ({
  default: ({ content, children }: any) => (
    <div>
      {children}
      {content}
    </div>
  )
}))
import MentionModelsButton from '../MentionModelsButton'

const assistantWith = (model: any = null) => ({ id: 'assistant-1', name: 'A', model }) as any

const renderButton = (model: any = null) => render(<MentionModelsButton assistant={assistantWith(model)} />)

const rowsFor = (modelId: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="mention-model-${modelId}"]`))

/**
 * Returns the row's name line for `name`, failing with a diagnostic instead of
 * returning undefined so callers can use the element without assertions.
 */
const nameLineOf = (row: HTMLElement, name: string): HTMLElement => {
  const nameLine = Array.from(row.querySelectorAll<HTMLElement>('div')).find((el) => el.textContent === name)
  if (!nameLine) {
    throw new Error(`expected a "${name}" name line inside row "${row.dataset.testid ?? '<unknown>'}"`)
  }
  return nameLine
}

describe('MentionModelsButton single-model selector', () => {
  describe('provider group headings', () => {
    it('renders one heading per non-empty provider, in provider order', () => {
      renderButton()
      const headings = [
        screen.getByTestId('mention-provider-group-openai'),
        screen.getByTestId('mention-provider-group-azure'),
        screen.getByTestId('mention-provider-group-long-id-provider')
      ]
      expect(headings.map((el) => el.textContent)).toEqual(['OpenAI', 'Azure', 'LongId'])
    })

    it('never renders a heading for a provider without selectable models', () => {
      renderButton()
      expect(screen.queryByTestId('mention-provider-group-empty-provider')).toBeNull()
      expect(screen.queryByText('EmptyProvider')).toBeNull()
    })

    it('headings are not selectable rows', () => {
      updateAssistantMock.mockClear()
      renderButton()
      const heading = screen.getByTestId('mention-provider-group-openai')

      expect(heading.hasAttribute('data-selected')).toBe(false)
      expect(heading.getAttribute('data-testid')).not.toMatch(/^mention-model-/)
      // headings are inert: no click handler and no pointer interaction
      expect(heading.getAttribute('role')).toBeNull()
      expect(getComputedStyle(heading).pointerEvents).toBe('none')

      fireEvent.click(heading)
      expect(updateAssistantMock).not.toHaveBeenCalled()
    })
  })

  describe('two-line rows', () => {
    it('renders the model name first and the muted monospace model ID second', () => {
      renderButton()
      const row = screen.getByTestId('mention-model-gpt-4o-2024-08-06')
      const nameLine = nameLineOf(row, 'GPT-4o')
      const idLine = row.querySelector('[title="gpt-4o-2024-08-06"]') as HTMLElement

      expect(nameLine.textContent).toBe('GPT-4o')
      expect(idLine).toBeTruthy()
      expect(idLine.textContent).toBe('gpt-4o-2024-08-06')
      // name line comes first in document order
      expect(nameLine.compareDocumentPosition(idLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // muted + monospace presentation with truncation
      expect(idLine.className).toContain('font-mono')
      expect(idLine.className).toContain('text-[12px]')
      expect(idLine.className).toContain('text-[var(--color-text-3)]')
      expect(idLine.className).toContain('truncate')
    })

    it('always renders the ID line for this two-line surface, even when name equals id', () => {
      renderButton()
      const openaiRow = rowsFor('gpt-4o')[0]
      expect(nameLineOf(openaiRow, 'gpt-4o').textContent).toBe('gpt-4o')

      const idLine = openaiRow.querySelector('[title="gpt-4o"]') as HTMLElement
      expect(idLine).not.toBeNull()
      expect(idLine.textContent).toBe('gpt-4o')
    })

    it('keeps the full model ID available as a tooltip and truncates long IDs', () => {
      renderButton()
      const idLine = screen.getByTitle(LONG_ID)
      expect(idLine.textContent).toBe(LONG_ID)
      expect(idLine.className).toContain('truncate')
      expect(idLine.className).toContain('min-w-0')
      // the flex column hosting the two lines must be allowed to shrink so a long
      // ID cannot push the popover out of bounds
      expect(idLine.parentElement?.className).toContain('min-w-0')
    })

    it('drops the provider prefix from rows (the group heading carries the provider)', () => {
      renderButton()
      const row = screen.getByTestId('mention-model-gpt-4o-2024-08-06')
      expect(row.textContent).not.toContain('|')
      expect(row.textContent).not.toContain('OpenAI')
    })

    it('drops capability/modality tags from rows but keeps avatars', () => {
      renderButton()
      expect(document.querySelector('[data-testid="tags"]')).toBeNull()
      const avatar = screen.getByTestId('avatar-gpt-4o-2024-08-06')
      expect(avatar.getAttribute('data-provider-id')).toBe('openai')
    })

    it('renders no clear action anywhere in the single-select surface', () => {
      renderButton({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'default' })
      expect(screen.queryByTestId('mention-clear-all')).toBeNull()
      expect(screen.queryByText('settings.input.clear.all')).toBeNull()
      const list = screen.getByTestId('mention-model-list')
      expect(list.textContent).not.toContain('settings.input.clear.all')
      expect(list.textContent).not.toContain('settings.input.clear.models')
    })
  })

  describe('single current-model selection', () => {
    it('marks only the row matching the current model {id, provider}', () => {
      renderButton({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'default' })
      const [openaiRow, azureRow] = rowsFor('gpt-4o')

      expect(openaiRow.getAttribute('data-provider-id')).toBe('openai')
      expect(azureRow.getAttribute('data-provider-id')).toBe('azure')
      expect(openaiRow.getAttribute('data-selected')).toBe('true')
      expect(azureRow.getAttribute('data-selected')).toBe('false')
      expect(openaiRow.textContent).toContain('✓')
      expect(azureRow.textContent).not.toContain('✓')
    })

    it('retains same-name different-ID models as distinct rows', () => {
      renderButton()
      // openai 'gpt-4o' (name == id) and 'gpt-4o-2024-08-06' (name 'GPT-4o') coexist
      expect(rowsFor('gpt-4o')).toHaveLength(2)
      expect(screen.getByTestId('mention-model-gpt-4o-2024-08-06')).toBeInTheDocument()
      expect(screen.getAllByText('GPT-4o').length).toBeGreaterThanOrEqual(2)
    })

    it('persists the clicked model as the single current model', async () => {
      const user = userEvent.setup()
      updateAssistantMock.mockClear()
      renderButton()

      await user.click(rowsFor('gpt-4o')[1])

      expect(updateAssistantMock).toHaveBeenCalledTimes(1)
      expect(updateAssistantMock).toHaveBeenCalledWith({
        model: { id: 'gpt-4o', name: 'GPT-4o', provider: 'azure', group: 'default' }
      })
    })

    describe('compact trigger', () => {
      it('shows the current model name with avatar and chevron, not the @ icon', () => {
        renderButton({ id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'default' })
        const trigger = within(screen.getByTestId('mention-models-button'))
        expect(trigger.getByText('GPT-4o')).toBeInTheDocument()
        expect(trigger.getByTestId('avatar-gpt-4o-2024-08-06')).toBeInTheDocument()
        expect(trigger.queryByText('@')).toBeNull()
        expect(screen.queryByText('@')).toBeNull()
      })

      it('truncates the trigger name line for long model names', () => {
        renderButton({ id: 'gpt-4o', name: 'gpt-4o', provider: 'openai', group: 'default' })
        const trigger = within(screen.getByTestId('mention-models-button'))
        const nameLine = trigger.getByText('gpt-4o')
        expect(nameLine.className).toContain('truncate')
      })

      it('carries no duplicate tooltip repeating the visible model name', () => {
        renderButton({ id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'default' })
        const button = screen.getByTestId('mention-models-button')
        // the name is already visible text; neither an antd Tooltip nor a
        // native title may repeat it on hover
        expect(button.getAttribute('title')).toBeNull()
        expect(button.getAttribute('aria-label')).toBe('assistants.presets.edit.model.select.title')
      })

      it('shows the select placeholder with no avatar when no model is set', () => {
        renderButton()
        const trigger = within(screen.getByTestId('mention-models-button'))
        expect(trigger.getByText('assistants.presets.edit.model.select.title')).toBeInTheDocument()
        expect(trigger.queryByTestId(/^avatar-/)).toBeNull()
      })
    })

    it('selecting another row replaces the current model instead of accumulating', async () => {
      const user = userEvent.setup()
      updateAssistantMock.mockClear()
      renderButton({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'default' })

      await user.click(screen.getByTestId('mention-model-gpt-4o-2024-08-06'))

      expect(updateAssistantMock).toHaveBeenCalledTimes(1)
      expect(updateAssistantMock).toHaveBeenCalledWith({
        model: { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'default' }
      })
    })
  })
})
