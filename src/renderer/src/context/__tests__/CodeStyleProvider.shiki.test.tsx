import fs from 'node:fs'
import path from 'node:path'

import { act, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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

describe('CodeStyleProvider - S7.8 Shiki theme-metadata demand activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useTheme.mockReturnValue({ theme: 'light' })
    mocks.useSettings.mockReturnValue({
      codeViewer: { themeLight: 'auto', themeDark: 'auto' }
    })
    mocks.shikiUtils.getShiki.mockResolvedValue({ bundledThemesInfo: [] })
    mocks.shikiUtils.getHighlighter.mockResolvedValue({ codeToHtml: async () => '' } as any)
    mocks.shikiUtils.getMarkdownIt.mockResolvedValue(null)
    mocks.shikiStreamService.highlightCodeChunk.mockResolvedValue({ lines: [], recall: 0 } as any)
    mocks.shikiStreamService.highlightStreamingCode.mockResolvedValue({ lines: [], recall: 0 } as any)
    mocks.shikiStreamService.getShikiPreProperties.mockResolvedValue({ class: 'shiki', style: '', tabindex: 0 } as any)
  })

  it('does not call getShiki on provider mount without code demand', async () => {
    render(
      <CodeStyleProvider>
        <div data-testid="child">hello</div>
      </CodeStyleProvider>
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
    // allow any microtasks to flush; getShiki should still not have been called
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.shikiUtils.getShiki).not.toHaveBeenCalled()
  })

  it('first explicit demand calls getShiki once and populates themeNames', async () => {
    const bundled = [
      { id: 'one-light', type: 'light' as const, displayName: 'One Light' },
      { id: 'github-dark', type: 'dark' as const, displayName: 'GitHub Dark' }
    ]
    mocks.shikiUtils.getShiki.mockResolvedValue({ bundledThemesInfo: bundled as any })

    const Probe = () => {
      const ctx = useCodeStyle()
      return (
        <div>
          <span data-testid="themes">{ctx.themeNames.join(',')}</span>
          <span data-testid="active">{ctx.activeShikiTheme}</span>
          <button onClick={() => void ctx.ensureShikiThemesLoaded()} data-testid="load">
            load
          </button>
        </div>
      )
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )
    expect(screen.getByTestId('themes').textContent).toBe('auto')
    expect(mocks.shikiUtils.getShiki).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByTestId('load').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('themes').textContent).toContain('github-dark'))
  })

  it('concurrent demand dedupes to single getShiki call', async () => {
    let resolveShiki!: (v: any) => void
    const pending = new Promise<any>((res) => {
      resolveShiki = res
    })
    mocks.shikiUtils.getShiki.mockReturnValue(pending)

    const Probe = () => {
      const ctx = useCodeStyle()
      return (
        <button
          onClick={() => {
            void ctx.ensureShikiThemesLoaded()
            void ctx.ensureShikiThemesLoaded()
            void ctx.ensureShikiThemesLoaded()
          }}
          data-testid="concurrent">
          concurrent
        </button>
      )
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )

    await act(async () => {
      screen.getByTestId('concurrent').click()
      await Promise.resolve()
    })

    expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveShiki({ bundledThemesInfo: [] })
      await Promise.resolve()
      await Promise.resolve()
    })

    // after resolve, further call should not re-trigger if already resolved
    // pending cleared, next demand after success should early-return due to populated state
  })

  it('highlight wrapper demand triggers metadata load once and dedupes concurrent highlight calls', async () => {
    let resolveShiki!: (v: any) => void
    const pending = new Promise<any>((res) => {
      resolveShiki = res
    })
    mocks.shikiUtils.getShiki.mockReturnValue(pending)
    mocks.shikiStreamService.highlightCodeChunk.mockResolvedValue({ lines: [], recall: 0 } as any)

    const Probe = () => {
      const ctx = useCodeStyle()
      return (
        <button
          onClick={() => {
            void ctx.highlightCodeChunk('code', 'javascript', 'caller-1')
            void ctx.highlightStreamingCode('full', 'python', 'caller-2')
            void ctx.getShikiPreProperties('typescript')
          }}
          data-testid="highlight">
          highlight
        </button>
      )
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )

    await act(async () => {
      screen.getByTestId('highlight').click()
      await Promise.resolve()
    })

    // All three wrappers share same ensure dedup => single getShiki
    expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveShiki({ bundledThemesInfo: [] })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('success populates selected custom theme after demand', async () => {
    const bundled = [
      { id: 'one-light', type: 'light' as const },
      { id: 'material-theme-darker', type: 'dark' as const },
      { id: 'github-dark', type: 'dark' as const }
    ]
    mocks.shikiUtils.getShiki.mockResolvedValue({ bundledThemesInfo: bundled as any })
    mocks.useSettings.mockReturnValue({
      codeViewer: { themeLight: 'github-dark', themeDark: 'github-dark' }
    })
    mocks.useTheme.mockReturnValue({ theme: 'light' })

    const Probe = () => {
      const ctx = useCodeStyle()
      return (
        <div>
          <span data-testid="active">{ctx.activeShikiTheme}</span>
          <span data-testid="isDark">{String(ctx.isShikiThemeDark)}</span>
          <button onClick={() => void ctx.ensureShikiThemesLoaded()} data-testid="load">
            load
          </button>
        </div>
      )
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )
    // before load, fallback to one-light because custom not in themeNames
    expect(screen.getByTestId('active').textContent).toBe('one-light')
    expect(screen.getByTestId('isDark').textContent).toBe('false')

    await act(async () => {
      screen.getByTestId('load').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('github-dark'))
    await waitFor(() => expect(screen.getByTestId('isDark').textContent).toBe('true'))
  })

  it('failure preserves fallback and subsequent demand retries', async () => {
    const bundled = [{ id: 'one-light', type: 'light' as const }]
    mocks.shikiUtils.getShiki
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce({ bundledThemesInfo: bundled as any })

    const Probe = () => {
      const ctx = useCodeStyle()
      return (
        <div>
          <span data-testid="themes">{ctx.themeNames.join(',')}</span>
          <button onClick={() => void ctx.ensureShikiThemesLoaded().catch(() => {})} data-testid="load">
            load
          </button>
        </div>
      )
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )

    await act(async () => {
      screen.getByTestId('load').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('themes').textContent).toBe('auto')
    // still fallback

    // retry
    await act(async () => {
      screen.getByTestId('load').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('themes').textContent).toContain('one-light'))
  })

  it('unmount does not update state after pending resolve', async () => {
    let resolveShiki!: (v: any) => void
    const pending = new Promise<any>((res) => {
      resolveShiki = res
    })
    mocks.shikiUtils.getShiki.mockReturnValue(pending)

    const Probe = () => {
      const ctx = useCodeStyle()
      return (
        <button onClick={() => void ctx.ensureShikiThemesLoaded()} data-testid="load">
          load
        </button>
      )
    }

    const { unmount } = render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )

    await act(async () => {
      screen.getByTestId('load').click()
      await Promise.resolve()
    })
    expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1)

    // unmount before resolve
    unmount()

    // resolve after unmount should not throw or cause state update on unmounted
    await act(async () => {
      resolveShiki({ bundledThemesInfo: [{ id: 'one-light', type: 'light' }] })
      await Promise.resolve()
      await Promise.resolve()
    })

    // No error thrown, and no React warning is expected (would surface as console.error)
    // We assert that mock was called once and after unmount no further calls
    expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1)
  })

  it('successful empty metadata stays ready and does not reload indefinitely', async () => {
    mocks.shikiUtils.getShiki.mockResolvedValue({ bundledThemesInfo: [] })

    const Probe = () => {
      const ctx = useCodeStyle()
      return (
        <div>
          <span data-testid="themes">{ctx.themeNames.join(',')}</span>
          <button onClick={() => void ctx.ensureShikiThemesLoaded()} data-testid="load">
            load
          </button>
        </div>
      )
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )

    await act(async () => {
      screen.getByTestId('load').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('themes').textContent).toBe('auto')

    // second demand should not trigger reload because empty success is still ready
    await act(async () => {
      screen.getByTestId('load').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1)
  })

  it('first highlight with persisted custom theme awaits metadata and ends with custom theme', async () => {
    let resolveShiki!: (v: any) => void
    const pending = new Promise<any>((res) => {
      resolveShiki = res
    })
    const bundled = [
      { id: 'github-dark', type: 'dark' as const, displayName: 'GitHub Dark' },
      { id: 'one-light', type: 'light' as const }
    ]
    mocks.shikiUtils.getShiki.mockReturnValue(pending)
    mocks.useSettings.mockReturnValue({
      codeViewer: { themeLight: 'github-dark', themeDark: 'github-dark' }
    })
    mocks.useTheme.mockReturnValue({ theme: 'light' })

    const Probe = () => {
      const ctx = useCodeStyle()
      const [resultTheme, setResultTheme] = useState<string>('')
      return (
        <div>
          <span data-testid="active">{ctx.activeShikiTheme}</span>
          <span data-testid="resultTheme">{resultTheme}</span>
          <button
            onClick={async () => {
              const res = await ctx.highlightCodeChunk('let x=1', 'javascript', 'caller-1')
              // capture theme passed to service via mock
              const calls = mocks.shikiStreamService.highlightCodeChunk.mock.calls
              if (calls.length > 0) setResultTheme(calls[calls.length - 1][2])
              void res
            }}
            data-testid="highlight">
            highlight
          </button>
        </div>
      )
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )

    // before metadata, active is fallback
    expect(screen.getByTestId('active').textContent).toBe('one-light')

    await act(async () => {
      screen.getByTestId('highlight').click()
      await Promise.resolve()
    })

    // while shiki metadata pending, service should not yet be called (awaited)
    expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1)
    expect(mocks.shikiStreamService.highlightCodeChunk).not.toHaveBeenCalled()

    await act(async () => {
      resolveShiki({ bundledThemesInfo: bundled as any })
      await Promise.resolve()
      await Promise.resolve()
      // allow highlight wrapper to continue after metadata
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(mocks.shikiStreamService.highlightCodeChunk).toHaveBeenCalledTimes(1))
    // service must have been called with custom theme, not fallback
    expect(mocks.shikiStreamService.highlightCodeChunk).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'github-dark',
      'caller-1'
    )
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('github-dark'))
  })

  it('default/auto highlight does not wait for metadata and uses deterministic fallback', async () => {
    let resolveShiki!: (v: any) => void
    const pending = new Promise<any>((res) => {
      resolveShiki = res
    })
    mocks.shikiUtils.getShiki.mockReturnValue(pending)
    // default auto settings (already set in beforeEach)
    const Probe = () => {
      const ctx = useCodeStyle()
      return (
        <button onClick={() => void ctx.highlightCodeChunk('code', 'js', 'caller-default')} data-testid="highlight">
          highlight
        </button>
      )
    }

    render(
      <CodeStyleProvider>
        <Probe />
      </CodeStyleProvider>
    )

    await act(async () => {
      screen.getByTestId('highlight').click()
      await Promise.resolve()
    })

    // getShiki should have been triggered (fire-and-forget) but service should still be called immediately with fallback
    expect(mocks.shikiUtils.getShiki).toHaveBeenCalledTimes(1)
    // For default/auto, highlight should proceed without awaiting metadata, so service is called even while pending
    await waitFor(() => expect(mocks.shikiStreamService.highlightCodeChunk).toHaveBeenCalledTimes(1))
    expect(mocks.shikiStreamService.highlightCodeChunk).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'one-light',
      'caller-default'
    )

    await act(async () => {
      resolveShiki({ bundledThemesInfo: [] })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('source contract: metadata status is independent of array length and no private cast', () => {
    const filePath = path.resolve(process.cwd(), 'src/renderer/src/context/CodeStyleProvider.tsx')
    const content = fs.readFileSync(filePath, 'utf-8')
    // must track status explicitly, not just length check
    expect(content).toMatch(/metadataStatus/)
    expect(content).toMatch(/ready|pending|failed/)
    // should not rely solely on length > 0 guard
    expect(content).not.toMatch(/if \(shikiThemesInfo\.length > 0\) return/)
    // must not cast shiki initializer promise privately is in shiki utils, but provider should not contain private cast
    expect(content).not.toMatch(/as unknown as.*promise/)
  })

  it('source contract: no unconditional getShiki on mount, has ensureShikiThemesLoaded', () => {
    const filePath = path.resolve(process.cwd(), 'src/renderer/src/context/CodeStyleProvider.tsx')
    const content = fs.readFileSync(filePath, 'utf-8')
    // must expose ensureShikiThemesLoaded
    expect(content).toMatch(/ensureShikiThemesLoaded/)
    // must not contain unconditional mount effect that calls getShiki directly
    // Old pattern was: useEffect(() => { void getShiki().then(
    // Ensure that pattern is gone
    expect(content).not.toMatch(/useEffect\(\(\)\s*=>\s*\{\s*void getShiki\(\)\.then/)
    // Should have dedicated demand API via context (ensureShikiThemesLoaded)
    expect(content).toMatch(/ensureShikiThemesLoaded.*useCallback/)
  })
})
