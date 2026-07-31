/**
 * ImportMenuSettings focused renderer tests.
 *
 * Validates the Data Settings > Import entry renders correctly and
 * the Cherry Studio import button invokes the popup.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — use vi.hoisted so variables are available inside hoisted vi.mock
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string) => key)
  const cherryShow = vi.fn().mockResolvedValue({ success: true })
  const importShow = vi.fn().mockResolvedValue({ success: true })
  return { t, cherryShow, importShow }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' })
}))

vi.mock('@renderer/components/Popups/CherryStudioImportPopup', () => ({
  default: { show: mocks.cherryShow }
}))

vi.mock('@renderer/components/Popups/ImportPopup', () => ({
  default: { show: mocks.importShow }
}))

import ImportMenuSettings from '../ImportMenuSettings'

afterEach(() => {
  cleanup()
})

describe('ImportMenuSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('should render the import settings title', () => {
      render(<ImportMenuSettings />)
      expect(screen.getByText('settings.data.import_settings.title')).toBeInTheDocument()
    })

    it('should render Cherry Studio import row', () => {
      render(<ImportMenuSettings />)
      expect(screen.getByText('settings.data.import_settings.cherrystudio')).toBeInTheDocument()
    })

    it('should render Cherry Studio import button', () => {
      render(<ImportMenuSettings />)
      expect(screen.getByText('settings.data.import_settings.cherrystudio_button')).toBeInTheDocument()
    })

    it('should render ChatGPT import row', () => {
      render(<ImportMenuSettings />)
      expect(screen.getByText('settings.data.import_settings.chatgpt')).toBeInTheDocument()
    })

    it('should render ChatGPT import button', () => {
      render(<ImportMenuSettings />)
      expect(screen.getByText('settings.data.import_settings.button')).toBeInTheDocument()
    })

    it('should render both import buttons', () => {
      render(<ImportMenuSettings />)
      const buttons = screen.getAllByRole('button')
      expect(buttons.length).toBe(2)
    })
  })

  describe('interactions', () => {
    it('should call CherryStudioImportPopup.show when Cherry Studio button is clicked', async () => {
      render(<ImportMenuSettings />)
      const cherryButton = screen.getByText('settings.data.import_settings.cherrystudio_button')
      await act(async () => {
        fireEvent.click(cherryButton)
      })
      expect(mocks.cherryShow).toHaveBeenCalledTimes(1)
    })

    it('should call ImportPopup.show when ChatGPT button is clicked', async () => {
      render(<ImportMenuSettings />)
      const chatgptButton = screen.getByText('settings.data.import_settings.button')
      await act(async () => {
        fireEvent.click(chatgptButton)
      })
      expect(mocks.importShow).toHaveBeenCalledTimes(1)
    })

    it('should not call ImportPopup.show when Cherry Studio button is clicked', async () => {
      render(<ImportMenuSettings />)
      const cherryButton = screen.getByText('settings.data.import_settings.cherrystudio_button')
      await act(async () => {
        fireEvent.click(cherryButton)
      })
      expect(mocks.importShow).not.toHaveBeenCalled()
    })

    it('should not call CherryStudioImportPopup.show when ChatGPT button is clicked', async () => {
      render(<ImportMenuSettings />)
      const chatgptButton = screen.getByText('settings.data.import_settings.button')
      await act(async () => {
        fireEvent.click(chatgptButton)
      })
      expect(mocks.cherryShow).not.toHaveBeenCalled()
    })
  })

  describe('i18n keys', () => {
    it('should use correct i18n keys for Cherry Studio section', () => {
      render(<ImportMenuSettings />)
      expect(mocks.t).toHaveBeenCalledWith('settings.data.import_settings.title')
      expect(mocks.t).toHaveBeenCalledWith('settings.data.import_settings.cherrystudio')
      expect(mocks.t).toHaveBeenCalledWith('settings.data.import_settings.cherrystudio_button')
    })

    it('should use correct i18n keys for ChatGPT section', () => {
      render(<ImportMenuSettings />)
      expect(mocks.t).toHaveBeenCalledWith('settings.data.import_settings.chatgpt')
      expect(mocks.t).toHaveBeenCalledWith('settings.data.import_settings.button')
    })
  })
})
