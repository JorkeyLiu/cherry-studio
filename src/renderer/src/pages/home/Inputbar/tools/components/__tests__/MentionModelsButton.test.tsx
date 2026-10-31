import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
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

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, provider, size }: any) => (
    <div data-testid={`avatar-${model.id}`} data-provider-id={provider?.id} data-size={size} />
  )
}))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: mockProviders })
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
  default: ({ content }: any) => <div>{content}</div>
}))
vi.mock('antd', async () => {
  const actual = await vi.importActual<any>('antd')
  return { ...actual, Tooltip: ({ children }: any) => <div>{children}</div> }
})

import MentionModelsButton from '../MentionModelsButton'

const renderButton = (mentionedModels: any[] = [], setMentionedModels = vi.fn()) =>
  render(
    <MentionModelsButton
      mentionedModels={mentionedModels}
      setMentionedModels={setMentionedModels}
      files={[]}
      setText={vi.fn()}
    />
  )

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

describe('MentionModelsButton provider-grouped two-line rows', () => {
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
      const setMentionedModels = vi.fn()
      renderButton([], setMentionedModels)
      const heading = screen.getByTestId('mention-provider-group-openai')

      expect(heading.hasAttribute('data-selected')).toBe(false)
      expect(heading.getAttribute('data-testid')).not.toMatch(/^mention-model-/)
      // headings are inert: no click handler and no pointer interaction
      expect(heading.getAttribute('role')).toBeNull()
      expect(getComputedStyle(heading).pointerEvents).toBe('none')

      fireEvent.click(heading)
      expect(setMentionedModels).not.toHaveBeenCalled()
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

    it('does not render any clear action row inside the model list', () => {
      renderButton()
      const list = screen.getByTestId('mention-model-list')
      expect(list.querySelector('[data-testid="mention-clear-all"]')).toBeNull()
      // 列表内不存在承载“清除”文案的可选行（无占位行、无破坏性图标行）
      expect(list.textContent).not.toContain('settings.input.clear.all')
      expect(list.textContent).not.toContain('settings.input.clear.models')
    })

    it('renders no clear action at all while nothing is mentioned', () => {
      renderButton()
      expect(screen.queryByTestId('mention-clear-all')).toBeNull()
      expect(screen.queryByText('settings.input.clear.all')).toBeNull()
    })
  })

  describe('header clear action', () => {
    const SELECTED = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'default' }

    it('sits to the right of the popover title, outside the scrollable list', () => {
      renderButton([SELECTED])
      const clear = screen.getByTestId('mention-clear-all')
      const title = screen.getByText('assistants.presets.edit.model.select.title')
      const header = title.parentElement as HTMLElement
      const list = screen.getByTestId('mention-model-list')

      // 与标题同处一行（即弹层头部），并且位于标题右侧
      expect(header.contains(clear)).toBe(true)
      expect(title.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // 头部在可滚动列表之外，且排在列表之前
      expect(list.contains(clear)).toBe(false)
      expect(header.contains(list)).toBe(false)
      expect(header.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('is a keyboard-accessible native button with the localized short label and clear tooltip', () => {
      renderButton([SELECTED])
      const clear = screen.getByTestId('mention-clear-all')

      expect(clear.tagName).toBe('BUTTON')
      expect(clear.getAttribute('type')).toBe('button')
      expect(clear.textContent).toBe('settings.input.clear.all')
      // 提示语义复用既有的“清除@的所有模型”
      expect(clear.getAttribute('aria-label')).toBe('settings.input.clear.models')
      // 非阻塞式语义按钮：未使用 disabled/aria-hidden，参与 tab 焦点链
      expect(clear.hasAttribute('disabled')).toBe(false)
      expect(clear.getAttribute('tabindex')).not.toBe('-1')
    })

    it('clears only the mentioned models on click and keeps the popover usable', async () => {
      const user = userEvent.setup()
      const setMentionedModels = vi.fn()
      renderButton([SELECTED], setMentionedModels)

      await user.click(screen.getByTestId('mention-clear-all'))

      expect(setMentionedModels).toHaveBeenCalledTimes(1)
      expect(setMentionedModels).toHaveBeenCalledWith([])
      // 列表内容未被替换或关闭：provider 分组、模型行与“添加模型”入口仍在
      expect(screen.getByTestId('mention-provider-group-openai')).toBeInTheDocument()
      expect(screen.getByTestId('mention-model-gpt-4o-2024-08-06')).toBeInTheDocument()
      expect(screen.getByTestId('mention-add-model')).toBeInTheDocument()
    })

    it('can be activated from the keyboard', async () => {
      const user = userEvent.setup()
      const setMentionedModels = vi.fn()
      renderButton([SELECTED], setMentionedModels)

      await user.tab()
      expect(screen.getByTestId('mention-clear-all')).toHaveFocus()
      await user.keyboard('{Enter}')

      expect(setMentionedModels).toHaveBeenCalledWith([])
    })

    it('appears only while models are mentioned and keeps selection usable after clearing', async () => {
      const user = userEvent.setup()

      const Harness = () => {
        const [models, setModels] = useState<any[]>([])
        return (
          <MentionModelsButton mentionedModels={models} setMentionedModels={setModels} files={[]} setText={vi.fn()} />
        )
      }

      render(<Harness />)
      expect(screen.queryByTestId('mention-clear-all')).toBeNull()

      await user.click(screen.getByTestId('mention-model-gpt-4o-2024-08-06'))
      expect(screen.getByTestId('mention-clear-all')).toBeInTheDocument()
      expect(rowsFor('gpt-4o-2024-08-06')[0].getAttribute('data-selected')).toBe('true')

      await user.click(screen.getByTestId('mention-clear-all'))
      // 全部选中标记被移除，清空入口随之消失
      expect(rowsFor('gpt-4o-2024-08-06')[0].getAttribute('data-selected')).toBe('false')
      expect(document.body.textContent).not.toContain('✓')
      expect(screen.queryByTestId('mention-clear-all')).toBeNull()

      // 清空后仍可继续选择
      await user.click(rowsFor('gpt-4o')[0])
      expect(rowsFor('gpt-4o')[0].getAttribute('data-selected')).toBe('true')
      expect(screen.getByTestId('mention-clear-all')).toBeInTheDocument()
    })
  })

  describe('selection identity is the full {id, provider}', () => {
    it('marks only the row whose provider+id matches, not a same-name same-id model of another provider', () => {
      renderButton([{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'default' }])
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

    it('adds the clicked model of a different provider instead of toggling off the same id', async () => {
      const user = userEvent.setup()

      const Harness = () => {
        const [models, setModels] = useState<any[]>([
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'default' }
        ])
        return (
          <MentionModelsButton mentionedModels={models} setMentionedModels={setModels} files={[]} setText={vi.fn()} />
        )
      }

      render(<Harness />)
      const azureRow = rowsFor('gpt-4o')[1]
      expect(azureRow.getAttribute('data-provider-id')).toBe('azure')

      await user.click(azureRow)

      const rows = rowsFor('gpt-4o')
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.getAttribute('data-selected') === 'true')).toBe(true)
    })
  })
})
