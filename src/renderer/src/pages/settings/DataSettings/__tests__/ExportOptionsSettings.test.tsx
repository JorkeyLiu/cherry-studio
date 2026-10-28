/**
 * Export options page — the single export settings surface.
 *
 * The export menu itself is always available (migration 228 retires the
 * per-format toggles), so this page only carries per-user defaults:
 * the shared default directory, the Markdown reasoning default, and the two
 * retained citation switches. `exportIncludeThinking` defaults to off.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const dispatch = vi.fn()
  const actions = {
    setExportPath: vi.fn((payload: string | null) => ({ type: 'settings/setExportPath', payload })),
    setExportIncludeThinking: vi.fn((payload: boolean) => ({ type: 'settings/setExportIncludeThinking', payload })),
    setExcludeCitationsInExport: vi.fn((payload: boolean) => ({
      type: 'settings/setExcludeCitationsInExport',
      payload
    })),
    setStandardizeCitationsInExport: vi.fn((payload: boolean) => ({
      type: 'settings/setStandardizeCitationsInExport',
      payload
    }))
  }
  return {
    dispatch,
    actions,
    state: {
      settings: {
        exportPath: null as string | null,
        exportIncludeThinking: false,
        excludeCitationsInExport: false,
        standardizeCitationsInExport: false
      }
    }
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' })
}))

vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/pages/settings', () => ({
  SettingContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingDivider: () => <hr />,
  SettingRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingRowTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingHelpText: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch
}))

vi.mock('@renderer/store/settings', () => mocks.actions)

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

import ExportOptionsSettings from '../ExportOptionsSettings'

const selectFolder = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.settings = {
    exportPath: null,
    exportIncludeThinking: false,
    excludeCitationsInExport: false,
    standardizeCitationsInExport: false
  }
  selectFolder.mockResolvedValue('/tmp/exports')
  Object.defineProperty(window, 'api', {
    value: { file: { selectFolder } },
    configurable: true
  })
})

afterEach(() => {
  cleanup()
})

const switches = () => screen.getAllByRole('switch')

describe('ExportOptionsSettings', () => {
  it('is the single export surface with the retained defaults and citation switches', () => {
    render(<ExportOptionsSettings />)

    expect(screen.getByText('settings.data.export_options.title')).toBeInTheDocument()
    expect(screen.getByText('settings.data.export_options.path')).toBeInTheDocument()
    expect(screen.getByText('settings.data.export_options.include_thinking.title')).toBeInTheDocument()
    expect(screen.getByText('settings.data.export_options.exclude_citations.title')).toBeInTheDocument()
    expect(screen.getByText('settings.data.export_options.standardize_citations.title')).toBeInTheDocument()
    // Path + include-thinking + the two retained citation switches: no
    // per-format export-menu toggles live here anymore.
    expect(switches()).toHaveLength(3)
  })

  it('defaults include-thinking to off and shows no default directory', () => {
    render(<ExportOptionsSettings />)

    expect(switches()[0]).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByPlaceholderText('settings.data.export_options.path_placeholder')).toHaveValue('')
    expect(document.querySelector('.anticon-delete')).toBeNull()
  })

  it('stores a selected folder as the shared default directory', async () => {
    render(<ExportOptionsSettings />)

    fireEvent.click(screen.getByText('settings.data.export_options.select'))
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(mocks.actions.setExportPath('/tmp/exports')))
    expect(selectFolder).toHaveBeenCalledTimes(1)
  })

  it('keeps the current directory untouched when the folder picker is canceled', async () => {
    selectFolder.mockResolvedValue(undefined)
    render(<ExportOptionsSettings />)

    fireEvent.click(screen.getByText('settings.data.export_options.select'))
    await vi.waitFor(() => expect(selectFolder).toHaveBeenCalled())
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('clears the configured directory back to the dialog behavior', () => {
    mocks.state.settings.exportPath = '/tmp/exports'
    render(<ExportOptionsSettings />)

    expect(screen.getByPlaceholderText('settings.data.export_options.path_placeholder')).toHaveValue('/tmp/exports')
    const clear = document.querySelector('.anticon-delete')
    expect(clear).not.toBeNull()
    fireEvent.click(clear as Element)
    expect(mocks.dispatch).toHaveBeenCalledWith(mocks.actions.setExportPath(null))
  })

  it('toggles the Markdown reasoning default', () => {
    render(<ExportOptionsSettings />)

    fireEvent.click(switches()[0])
    expect(mocks.dispatch).toHaveBeenCalledWith(mocks.actions.setExportIncludeThinking(true))
  })

  it('keeps both citation switches wired to their existing settings', () => {
    mocks.state.settings.excludeCitationsInExport = true
    mocks.state.settings.standardizeCitationsInExport = true
    render(<ExportOptionsSettings />)

    expect(switches()[1]).toHaveAttribute('aria-checked', 'true')
    expect(switches()[2]).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(switches()[1])
    expect(mocks.dispatch).toHaveBeenCalledWith(mocks.actions.setExcludeCitationsInExport(false))
    fireEvent.click(switches()[2])
    expect(mocks.dispatch).toHaveBeenCalledWith(mocks.actions.setStandardizeCitationsInExport(false))
  })
})
