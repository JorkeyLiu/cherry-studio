/**
 * Data Settings connection/export surface.
 *
 * Guards what the page still offers: the retained built-in sections in a
 * compact section rail beside the selected section's content (both visible at
 * once, no tab strip), the single export-options section, and the absence of
 * the removed third-party note-connection settings.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (key === 'settings.sync.title' ? (fallback ?? key) : key)
  })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' })
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
  useAppDispatch: () => vi.fn()
}))

vi.mock('../BasicDataSettings', () => ({ default: () => <div>basic-panel</div> }))
vi.mock('../SyncSettings', () => ({ default: () => <div>sync-panel</div> }))
vi.mock('../WebDavSettings', () => ({ default: () => <div>webdav-panel</div> }))
vi.mock('../S3Settings', () => ({ default: () => <div>s3-panel</div> }))
vi.mock('../ExportOptionsSettings', () => ({ default: () => <div>export-options-panel</div> }))
vi.mock('../LocalBackupSettings', () => ({ default: () => <div>local-backup-panel</div> }))

import DataSettings from '../DataSettings'

const REMOVED_CONNECTION_KEYS = ['notion', 'yuque', 'joplin', 'obsidian', 'siyuan']

const RETAINED_MENU_TITLES = [
  'settings.data.data.title',
  'settings.data.local.title',
  'settings.data.webdav.title',
  'settings.data.s3.title.label',
  'settings.data.export_options.title'
]

/** Section rail hooks → the panel that must be rendered when selected. */
const SECTION_CASES: Array<[testId: string, panelText: string]> = [
  ['data-section-data', 'basic-panel'],
  ['data-menu-sync', 'sync-panel'],
  ['data-section-local_backup', 'local-backup-panel'],
  ['data-section-webdav', 'webdav-panel'],
  ['data-section-s3', 's3-panel'],
  ['data-section-export_options', 'export-options-panel']
]

const readLocale = (name: string) => JSON.parse(fs.readFileSync(`src/renderer/src/i18n/locales/${name}.json`, 'utf-8'))

afterEach(() => {
  cleanup()
})

describe('DataSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps every retained section in the menu', () => {
    render(<DataSettings />)
    for (const title of RETAINED_MENU_TITLES) {
      expect(screen.getByText(title)).toBeInTheDocument()
    }
  })

  it('labels the data-sync section as Data Sync', () => {
    render(<DataSettings />)
    expect(screen.getByText('Data Sync')).toBeInTheDocument()
    expect(screen.queryByText('Synchronization')).toBeNull()
  })

  it('no longer offers external application import entry points', () => {
    render(<DataSettings />)
    expect(screen.queryByText('settings.data.import_settings.title')).toBeNull()
    expect(screen.queryByTestId('data-section-import_settings')).toBeNull()
    expect(screen.queryByText('settings.data.divider.import_settings')).toBeNull()
  })

  it('shows the section rail and the selected section content at the same time', () => {
    render(<DataSettings />)

    // A section rail (not a tab strip) beside the content area.
    const nav = screen.getByRole('navigation', { name: 'settings.data.title' })
    expect(nav).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)

    // All retained sections are reachable from the rail.
    for (const [testId] of SECTION_CASES) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }

    // Rail and content coexist: the default section renders next to the rail.
    expect(screen.getByText('basic-panel')).toBeInTheDocument()
    expect(screen.getByTestId('data-section-data').className).toContain('active')

    // The group dividers of the previous sidebar layout are restored.
    for (const divider of ['basic', 'cloud_storage', 'export_settings']) {
      expect(screen.getByText(`settings.data.divider.${divider}`)).toBeInTheDocument()
    }
  })

  it('opens each section on selection and marks only the selected rail item', () => {
    render(<DataSettings />)

    for (const [testId, panelText] of SECTION_CASES) {
      fireEvent.click(screen.getByTestId(testId))

      expect(screen.getByText(panelText)).toBeInTheDocument()
      expect(screen.getByTestId(testId).className).toContain('active')

      for (const [otherTestId] of SECTION_CASES) {
        if (otherTestId !== testId) {
          expect(screen.getByTestId(otherTestId).className).not.toContain('active')
        }
      }
    }
  })

  it('no longer offers third-party note connections as settings sections', () => {
    render(<DataSettings />)
    for (const brand of REMOVED_CONNECTION_KEYS) {
      expect(screen.queryByText(`settings.data.${brand}.title`)).toBeNull()
    }
    expect(screen.queryByText('settings.data.divider.third_party')).toBeNull()
    expect(screen.queryByText('settings.data.nutstore.title')).toBeNull()
  })

  it('replaces the two former export pages with one export-options section', () => {
    render(<DataSettings />)
    expect(screen.queryByText('settings.data.export_menu.title')).toBeNull()
    expect(screen.queryByText('settings.data.markdown_export.title')).toBeNull()
    expect(screen.getAllByText('settings.data.export_options.title')).toHaveLength(1)
  })
})

describe('DataSettings locales', () => {
  it('labels the shared sync section for every maintained locale', () => {
    expect(readLocale('zh-cn').settings.sync.title).toBe('数据同步')
    expect(readLocale('zh-tw').settings.sync.title).toBe('資料同步')
    expect(readLocale('en-us').settings.sync.title).toBe('Data Sync')
  })

  it('drops the Nutstore configuration namespace but keeps shared storage keys', () => {
    for (const locale of ['zh-cn', 'zh-tw', 'en-us']) {
      const settings = readLocale(locale).settings
      expect(settings.data.nutstore).toBeUndefined()
      expect(typeof settings.data.webdav.title).toBe('string')
      expect(typeof settings.data.s3.title.label).toBe('string')
      expect(typeof settings.data.local.title).toBe('string')
    }
  })

  it('carries the export-options labels in zh-cn', () => {
    const exportOptions = readLocale('zh-cn').settings.data.export_options
    expect(exportOptions.title).toBe('话题导出选项')
    expect(exportOptions.include_thinking.title).toBe('包含思考内容')
    expect(typeof exportOptions.path_placeholder).toBe('string')
  })
})
