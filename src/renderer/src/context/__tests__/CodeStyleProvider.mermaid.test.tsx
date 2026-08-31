import fs from 'node:fs'
import path from 'node:path'

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useMermaid: vi.fn(),
  useTheme: vi.fn(),
  useSettings: vi.fn(),
  shikiStreamService: {
    dispose: vi.fn(),
    highlightCodeChunk: vi.fn(),
    highlightStreamingCode: vi.fn(),
    cleanupTokenizers: vi.fn(),
    getShikiPreProperties: vi.fn()
  },
  shikiUtils: {
    getShiki: vi.fn(),
    getHighlighter: vi.fn(),
    getMarkdownIt: vi.fn(),
    loadLanguageIfNeeded: vi.fn(),
    loadThemeIfNeeded: vi.fn()
  }
}))

vi.mock('@renderer/hooks/useMermaid', () => ({
  useMermaid: mocks.useMermaid
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: mocks.useTheme
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: mocks.useSettings
}))

vi.mock('@renderer/services/ShikiStreamService', () => ({
  shikiStreamService: mocks.shikiStreamService
}))

vi.mock('@renderer/utils/shiki', () => ({
  getShiki: mocks.shikiUtils.getShiki,
  getHighlighter: mocks.shikiUtils.getHighlighter,
  getMarkdownIt: mocks.shikiUtils.getMarkdownIt,
  loadLanguageIfNeeded: mocks.shikiUtils.loadLanguageIfNeeded,
  loadThemeIfNeeded: mocks.shikiUtils.loadThemeIfNeeded
}))

vi.mock('@uiw/codemirror-themes-all', () => ({
  materialLight: 'materialLight-mock',
  dark: 'dark-mock'
}))

import { CodeStyleProvider, useCodeStyle } from '../CodeStyleProvider'

describe('CodeStyleProvider - S7.7 Mermaid on-demand boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useTheme.mockReturnValue({ theme: 'light' })
    mocks.useSettings.mockReturnValue({
      codeViewer: { themeLight: 'auto', themeDark: 'auto' }
    })
    mocks.shikiUtils.getShiki.mockResolvedValue({ bundledThemesInfo: [] })
    mocks.shikiUtils.getHighlighter.mockResolvedValue({ codeToHtml: async () => '' })
    mocks.shikiUtils.getMarkdownIt.mockResolvedValue(null)
    mocks.useMermaid.mockReturnValue({
      mermaid: null,
      isLoading: false,
      error: null,
      forceRenderKey: 0
    })
  })

  it('does not activate Mermaid on mount (no useMermaid call)', () => {
    render(
      <CodeStyleProvider>
        <div data-testid="child">hello</div>
      </CodeStyleProvider>
    )

    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(mocks.useMermaid).not.toHaveBeenCalled()
  })

  it('does not activate Mermaid after rerender', () => {
    const { rerender } = render(
      <CodeStyleProvider>
        <div data-testid="child">hello</div>
      </CodeStyleProvider>
    )

    expect(mocks.useMermaid).not.toHaveBeenCalled()

    rerender(
      <CodeStyleProvider>
        <div data-testid="child">hello again</div>
      </CodeStyleProvider>
    )

    expect(mocks.useMermaid).not.toHaveBeenCalled()
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('still provides Shiki context without Mermaid', () => {
    const Probe = () => {
      const ctx = useCodeStyle()
      return <div data-testid="probe">{ctx.themeNames.join(',')}</div>
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )

    expect(screen.getByTestId('probe')).toBeInTheDocument()
    expect(mocks.useMermaid).not.toHaveBeenCalled()
  })

  it('source contract: CodeStyleProvider.tsx does not import or call useMermaid / mermaid', () => {
    const filePath = path.resolve(process.cwd(), 'src/renderer/src/context/CodeStyleProvider.tsx')
    const content = fs.readFileSync(filePath, 'utf-8')

    expect(content).not.toMatch(/useMermaid/)
    expect(content).not.toMatch(/from\s+['"]@renderer\/hooks\/useMermaid['"]/)
    expect(content).not.toMatch(/import\(['"]mermaid['"]\)/)
  })
})
