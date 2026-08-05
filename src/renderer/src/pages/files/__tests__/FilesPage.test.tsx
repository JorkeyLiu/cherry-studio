/**
 * FilesPage — nullable imported-row / file-browser boundary (LOCK-BROWSE-1/2/3).
 *
 * Renders FilesPage with a functional `db.files` mock so the component's real
 * Dexie query callbacks run against it, and a deps-reactive `useLiveQuery`
 * mock so tab switches re-query. Covers:
 * - typed tabs exclude rows with null / non-matching source type;
 * - the all tab includes imported rows (null type and source-string type);
 * - null created_at renders a neutral em dash — never "Invalid Date"/NaN;
 * - imported rows expose valid open-path and edit/delete actions.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks (hoisted values shared by factory + assertions) ------------------

const mocks = vi.hoisted(() => {
  const openPathMock = vi.fn()
  const t = vi.fn((key: string) => key)
  return { openPathMock, t }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

// Keep the i18n instance and heavy utils/store chains out of this focused
// render test: labels resolve to their keys and sizes to a plain string.
vi.mock('@renderer/i18n/label', () => ({
  getFileFieldLabel: (key: string) => key
}))

vi.mock('@renderer/utils', () => ({
  formatFileSize: (size: number) => `${size} B`
}))

// Functional `db.files` mock: the component's real query callbacks run against
// it, so inclusion/exclusion reflects the actual query expressions.
vi.mock('@renderer/databases', () => {
  const rows = [
    {
      id: 'f-doc',
      name: 'f-doc.txt',
      origin_name: 'doc.txt',
      path: '/mock/files/f-doc.txt',
      size: 100,
      ext: '.txt',
      type: 'document',
      created_at: '2024-01-01T00:00:00.000Z',
      count: 1
    },
    {
      id: 'f-img',
      name: 'f-img.png',
      origin_name: 'pic.png',
      path: '/mock/files/f-img.png',
      size: 200,
      ext: '.png',
      type: 'image',
      created_at: '2024-02-02T00:00:00.000Z',
      count: 1
    },
    {
      id: 'f-null',
      name: 'f-null.bin',
      origin_name: 'imported.bin',
      path: '/mock/files/f-null.bin',
      size: 300,
      ext: '.bin',
      type: null,
      created_at: null,
      count: 1
    },
    {
      id: 'f-mime',
      name: 'f-mime.png',
      origin_name: 'raw.png',
      path: '/mock/files/f-mime.png',
      size: 400,
      ext: '.png',
      type: 'image/png',
      created_at: '2024-03-03T00:00:00.000Z',
      count: 1
    }
  ]
  return {
    default: {
      files: {
        orderBy: vi.fn(() => ({ toArray: vi.fn(async () => [...rows]) })),
        where: vi.fn(() => ({
          equals: vi.fn((value: string) => ({
            sortBy: vi.fn(async () => rows.filter((r) => r.type === value))
          }))
        }))
      }
    }
  }
})

vi.mock('dexie-react-hooks', async () => {
  const React = await import('react')
  return {
    useLiveQuery: (callback: () => Promise<unknown>, deps?: unknown[]) => {
      const [result, setResult] = React.useState<unknown>(undefined)
      React.useEffect(() => {
        let active = true
        void callback().then((value) => {
          if (active) setResult(value)
        })
        return () => {
          active = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return result
    }
  }
})

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    formatFileName: (file: { origin_name: string }) => file.origin_name,
    getFilePath: (file: { id: string; ext: string }) => `/mock/files/${file.id}${file.ext}`,
    getFileUrl: (file: { name: string }) => `file:///mock/files/${file.name}`
  }
}))

vi.mock('@renderer/services/FileAction', () => ({
  sortFiles: (files: unknown[]) => files,
  tempFilesSort: (files: unknown[]) => files,
  handleDelete: vi.fn(),
  handleRename: vi.fn()
}))

vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  NavbarCenter: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({
    list,
    children
  }: {
    list: unknown[]
    children: (item: unknown, index: number) => ReactNode
  }) => <div>{list.map((item, index) => children(item, index))}</div>
}))

import FilesPage from '../FilesPage'

const originalApi = (window as unknown as { api?: unknown }).api

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = { file: { openPath: mocks.openPathMock } }
  // antd responsive observer (image preview) requires matchMedia in jsdom.
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
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

afterEach(() => {
  cleanup()
  ;(window as unknown as { api: unknown }).api = originalApi
})

describe('FilesPage — nullable imported rows (LOCK-BROWSE-1/2/3)', () => {
  it('typed tab (document, default) excludes null-type and source-string-type rows', async () => {
    render(<FilesPage />)
    expect(await screen.findByText('doc.txt')).toBeInTheDocument()
    expect(screen.queryByText('imported.bin')).not.toBeInTheDocument()
    expect(screen.queryByText('raw.png')).not.toBeInTheDocument()
    expect(screen.queryByText('pic.png')).not.toBeInTheDocument()
  })

  it('typed image tab includes only the exact image-type row', async () => {
    render(<FilesPage />)
    await screen.findByText('doc.txt')
    await act(async () => {
      fireEvent.click(screen.getByText('files.image'))
    })
    // Image view renders thumbnails (no name text): exactly the image row.
    await waitFor(() => {
      const imgs = document.querySelectorAll('img')
      expect(imgs.length).toBe(1)
      expect(imgs[0]?.getAttribute('src')).toBe('file:///mock/files/f-img.png')
    })
    // Non-matching rows (null type, source-string type, other typed) are excluded.
    expect(document.body.textContent).not.toContain('imported.bin')
    expect(document.body.textContent).not.toContain('raw.png')
    expect(document.body.textContent).not.toContain('doc.txt')
  })

  it('all tab includes imported rows with null type and source-string type', async () => {
    render(<FilesPage />)
    await screen.findByText('doc.txt')
    await act(async () => {
      fireEvent.click(screen.getByText('files.all'))
    })
    expect(await screen.findByText('imported.bin')).toBeInTheDocument()
    expect(screen.getByText('raw.png')).toBeInTheDocument()
    expect(screen.getByText('doc.txt')).toBeInTheDocument()
    expect(screen.getByText('pic.png')).toBeInTheDocument()
  })

  it('null created_at renders a neutral em dash — never Invalid Date', async () => {
    render(<FilesPage />)
    await screen.findByText('doc.txt')
    await act(async () => {
      fireEvent.click(screen.getByText('files.all'))
    })
    const name = await screen.findByText('imported.bin')
    // The imported row's extra line (FileInfo) carries the neutral em dash.
    const card = name.closest('div')?.parentElement?.parentElement?.parentElement
    const extraText = (card as HTMLElement | null)?.textContent ?? ''
    expect(extraText).toContain('—')
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument()
  })

  it('imported row name click opens the canonical path', async () => {
    render(<FilesPage />)
    await screen.findByText('doc.txt')
    await act(async () => {
      fireEvent.click(screen.getByText('files.all'))
    })
    await act(async () => {
      fireEvent.click(await screen.findByText('imported.bin'))
    })
    expect(mocks.openPathMock).toHaveBeenCalledWith('/mock/files/f-null.bin')
  })

  it('imported row renders edit and delete actions', async () => {
    render(<FilesPage />)
    await screen.findByText('doc.txt')
    await act(async () => {
      fireEvent.click(screen.getByText('files.all'))
    })
    const name = await screen.findByText('imported.bin')
    // FileItemCard > CardContent > Flex{FileName, FileInfo} | FileActions
    const card = name.closest('div')?.parentElement?.parentElement?.parentElement
    expect(card).not.toBeNull()
    const actions = within(card as HTMLElement).getAllByRole('button')
    expect(actions.length).toBe(2)
  })
})
