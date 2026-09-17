import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k, i18n: { t: (k: string) => k } }) }
})

import AnthropicSettings from '../AnthropicSettings'

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as any).api = {
    anthropic_oauth: {
      hasCredentials: vi.fn().mockResolvedValue(false),
      startOAuthFlow: vi.fn(),
      completeOAuthWithCode: vi.fn(),
      cancelOAuthFlow: vi.fn(),
      clearCredentials: vi.fn()
    }
  }
  ;(window as any).toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
})

describe('AnthropicSettings (OAuth still renders/functions)', () => {
  it('renders the OAuth entry with start action', async () => {
    render(<AnthropicSettings />)
    expect(await screen.findByText('settings.provider.anthropic.description')).toBeInTheDocument()
    expect(screen.getByText('settings.provider.anthropic.start_auth')).toBeInTheDocument()
  })
})
