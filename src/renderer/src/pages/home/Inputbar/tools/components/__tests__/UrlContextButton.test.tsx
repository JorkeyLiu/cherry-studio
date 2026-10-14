/**
 * Render proof for the inputbar URL-context ("网页上下文") link button.
 *
 * The button shares the exact ComposerIconButton path with every other tool;
 * these tests pin that it renders (16px Link glyph, accessible label) and
 * toggles `enableUrlContext`. Visibility beyond rendering stays
 * model-gated in `urlContextTool` (Gemini/Anthropic + supporting provider)
 * and is unchanged by the composer unification.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const updateAssistant = vi.fn()
  const assistant = { id: 'a1', enableUrlContext: false }
  const setTimeoutTimer = vi.fn((_key: string, fn: () => void) => fn())
  return { updateAssistant, assistant, setTimeoutTimer }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ assistant: mocks.assistant, updateAssistant: mocks.updateAssistant })
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: mocks.setTimeoutTimer })
}))

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    Tooltip: ({ children, title }: any) => (
      <div data-testid="url-context-tooltip" data-title={typeof title === 'string' ? title : ''}>
        {children}
      </div>
    )
  }
})

import UrlContextButton from '../UrlContextbutton'

describe('UrlContextButton', () => {
  it('renders the context link with label, tooltip, and 16px glyph', () => {
    render(<UrlContextButton assistantId="a1" />)

    const button = screen.getByRole('button', { name: 'chat.input.url_context' })
    expect(button).toHaveAttribute('data-tone', 'default')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('url-context-tooltip')).toHaveAttribute('data-title', 'chat.input.url_context')

    const glyph = button.querySelector('svg.lucide')
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute('width')).toBe('16')
  })

  it('toggles enableUrlContext off->on on click', () => {
    render(<UrlContextButton assistantId="a1" />)

    fireEvent.click(screen.getByRole('button', { name: 'chat.input.url_context' }))
    expect(mocks.updateAssistant).toHaveBeenCalledWith({ ...mocks.assistant, enableUrlContext: true })
  })
})
