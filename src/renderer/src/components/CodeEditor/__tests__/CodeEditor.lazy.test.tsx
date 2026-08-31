import fs from 'node:fs'
import path from 'node:path'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodeEditorHandles, CodeEditorProps } from '../types'

// Mock antd minimal for fallback rendering
vi.mock('antd', () => ({
  Spin: ({ tip, children }: { tip?: string; children?: React.ReactNode }) => (
    <div data-testid="spin" aria-label={tip}>
      {tip}
      {children}
    </div>
  ),
  Alert: ({ message, description }: { message?: React.ReactNode; description?: React.ReactNode }) => (
    <div data-testid="code-editor-error-alert">
      <span>{message}</span>
      <span>{description}</span>
    </div>
  ),
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Space: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'common.error': 'Error',
        'common.retry': 'Retry'
      }
      return map[key] ?? key
    }
  })
}))

// Track impl evaluation
const implEval = vi.hoisted(() => ({ count: 0 }))

// Mock hooks and deps used by impl to avoid heavy codemirror side effects
vi.mock('@renderer/context/CodeStyleProvider', () => ({
  useCodeStyle: () => ({ activeCmTheme: 'materialLight-mock' })
}))
vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ fontSize: 14 })
}))
vi.mock('@uiw/react-codemirror', () => ({
  default: (props: { value?: string }) => <div data-testid="codemirror-mock">{props.value}</div>,
  Annotation: { define: () => ({ of: () => {} }) },
  EditorView: { lineWrapping: {} }
}))
vi.mock('fast-diff', () => ({ default: () => [] }))

// Provide lightweight mock for hooks used by impl
vi.mock('../hooks', () => ({
  useLanguageExtensions: () => [],
  useSaveKeymap: () => [],
  useBlurHandler: () => [],
  useHeightListener: () => [],
  useScrollToLine: () => vi.fn()
}))

describe('CodeEditor - S7.8 lazy boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    implEval.count = 0
    vi.resetModules()
    cleanup()
  })

  afterEach(() => {
    cleanup()
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('source contract: wrapper contains literal React.lazy dynamic import and no eager @uiw/react-codemirror', () => {
    const filePath = path.resolve(process.cwd(), 'src/renderer/src/components/CodeEditor/index.tsx')
    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toMatch(/React\.lazy\(\(\)\s*=>\s*import\(['"]\.\/CodeEditorImpl['"]\)\)/)
    expect(content).not.toMatch(/from\s+['"]@uiw\/react-codemirror['"]/)
    expect(content).not.toMatch(/import\s+.*CodeMirror/)
    expect(content).toMatch(/Suspense/)
    expect(content).toMatch(/ErrorBoundary/)
    expect(content).toMatch(/code-editor-loading/)
    expect(content).toMatch(/code-editor-error/)
    expect(content).not.toMatch(/code-editor-retry/)
    expect(content).not.toMatch(/retryKey/)
    expect(content).not.toMatch(/resetErrorBoundary/)
    expect(content).toMatch(/CodeEditorShell/)
    // type exports preserved
    expect(content).toMatch(/export type.*CodeEditorProps/)
    expect(content).toMatch(/export type.*CodeEditorHandles/)
  })

  it('source contract: impl contains @uiw/react-codemirror and wrapper does not', () => {
    const wrapperPath = path.resolve(process.cwd(), 'src/renderer/src/components/CodeEditor/index.tsx')
    const implPath = path.resolve(process.cwd(), 'src/renderer/src/components/CodeEditor/CodeEditorImpl.tsx')
    const wrapper = fs.readFileSync(wrapperPath, 'utf-8')
    const impl = fs.readFileSync(implPath, 'utf-8')
    expect(wrapper).not.toMatch(/@uiw\/react-codemirror/)
    expect(impl).toMatch(/@uiw\/react-codemirror/)
  })

  it('rendering wrapper shows fallback while lazy pending and renders impl after resolve with props', async () => {
    let resolveImpl: () => void = () => {}
    let implReady = false
    const pendingPromise = new Promise<void>((res) => {
      resolveImpl = () => {
        implReady = true
        res()
      }
    })

    vi.doMock('../CodeEditorImpl', () => ({
      default: React.memo((props: CodeEditorProps) => {
        implEval.count++
        if (!implReady) throw pendingPromise
        return <div data-testid="impl-rendered">{props.value}</div>
      })
    }))

    const { default: CodeEditor } = await import('../index')

    render(<CodeEditor value="hello world" language="javascript" />)

    expect(screen.getByTestId('code-editor-loading')).toBeInTheDocument()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByTestId('impl-rendered')).not.toBeInTheDocument()
    expect(implEval.count).toBe(0)

    await act(async () => {
      resolveImpl()
      await pendingPromise
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(implEval.count).toBeGreaterThan(0))

    await waitFor(() => expect(screen.getByTestId('impl-rendered')).toBeInTheDocument())
    expect(screen.getByTestId('impl-rendered').textContent).toBe('hello world')
    expect(screen.queryByTestId('code-editor-loading')).not.toBeInTheDocument()
  })

  it('props and ref contract pass through after lazy resolve', async () => {
    const saveSpy = vi.fn()
    const scrollSpy = vi.fn()

    type MockImplProps = Pick<CodeEditorProps, 'value' | 'editable' | 'wrapped'> & {
      ref?: React.RefObject<CodeEditorHandles | null>
    }

    const MockImpl = ({ ref, ...props }: MockImplProps) => {
      const handles = {
        save: saveSpy,
        scrollToLine: scrollSpy,
        getContent: () => props.value
      } satisfies CodeEditorHandles
      React.useImperativeHandle(ref, () => handles)
      return (
        <div data-testid="impl-props">
          {props.value}-{String(props.editable)}-{String(props.wrapped)}
        </div>
      )
    }
    MockImpl.displayName = 'MockImpl'

    vi.doMock('../CodeEditorImpl', () => ({ default: MockImpl }))

    const { default: CodeEditor } = await import('../index')

    const refHolder: { current: React.RefObject<CodeEditorHandles | null> | null } = { current: null }
    const Harness = () => {
      const ref = React.useRef<CodeEditorHandles | null>(null)
      refHolder.current = ref
      return <CodeEditor ref={ref} value="test-val" language="python" editable={false} wrapped={false} />
    }

    render(<Harness />)

    await waitFor(() => expect(screen.getByTestId('impl-props')).toBeInTheDocument())
    expect(screen.getByTestId('impl-props').textContent).toBe('test-val-false-false')
    expect(refHolder.current?.current).toBeDefined()
    expect(typeof refHolder.current?.current?.save).toBe('function')
    expect(typeof refHolder.current?.current?.getContent).toBe('function')
    expect(typeof refHolder.current?.current?.scrollToLine).toBe('function')
    expect(refHolder.current?.current?.getContent?.()).toBe('test-val')
    refHolder.current?.current?.save?.()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    refHolder.current?.current?.scrollToLine?.(3)
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy).toHaveBeenCalledWith(3)
  })

  it('dynamic module rejection is contained in local error fallback without retry affordance', async () => {
    // Directly reject the wrapper's actual import('./CodeEditorImpl') path (outer module load failure)
    vi.doMock('../CodeEditorImpl', () => {
      throw new Error('chunk load failed')
    })

    const { default: CodeEditor } = await import('../index')

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <div>
        <span data-testid="sibling-dynamic">sibling</span>
        <CodeEditor value="x" language="js" />
      </div>
    )

    await waitFor(() => expect(screen.getByTestId('code-editor-error')).toBeInTheDocument())
    // localized generic error, no retry button
    expect(screen.getAllByText('Error').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByTestId('code-editor-retry')).not.toBeInTheDocument()
    expect(screen.queryByText('Retry')).not.toBeInTheDocument()
    // bounded: error is local, sibling content still renders
    expect(screen.getByTestId('sibling-dynamic')).toBeInTheDocument()

    spy.mockRestore()
  })

  it('render error is bounded locally in error fallback', async () => {
    const ThrowingImpl = () => {
      throw new Error('render failure')
    }

    vi.doMock('../CodeEditorImpl', () => ({ default: ThrowingImpl }))

    const { default: CodeEditor } = await import('../index')

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <div>
        <span data-testid="sibling">sibling</span>
        <CodeEditor value="y" language="js" />
      </div>
    )

    await waitFor(() => expect(screen.getByTestId('code-editor-error')).toBeInTheDocument())
    expect(screen.getByTestId('sibling')).toBeInTheDocument()
    expect(screen.queryByTestId('code-editor-retry')).not.toBeInTheDocument()

    spy.mockRestore()
  })

  it('loading shell respects expanded=false: preserves height/maxHeight', async () => {
    let resolveImpl: () => void = () => {}
    let implReady = false
    const pendingPromise = new Promise<void>((res) => {
      resolveImpl = () => {
        implReady = true
        res()
      }
    })

    vi.doMock('../CodeEditorImpl', () => ({
      default: React.memo((props: CodeEditorProps) => {
        if (!implReady) throw pendingPromise
        return <div data-testid="impl-layout">{props.value}</div>
      })
    }))

    const { default: CodeEditor } = await import('../index')

    const { unmount } = render(
      <CodeEditor
        value="layout-test"
        language="js"
        height="200px"
        minHeight="100px"
        maxHeight="300px"
        expanded={false}
        style={{ backgroundColor: 'rgb(255, 0, 0)' }}
        className="my-custom-class"
      />
    )

    const loadingShell = screen.getByTestId('code-editor-loading')
    expect(loadingShell).toBeInTheDocument()
    expect(loadingShell.style.height).toBe('200px')
    expect(loadingShell.style.minHeight).toBe('100px')
    expect(loadingShell.style.maxHeight).toBe('300px')
    expect(loadingShell.style.backgroundColor).toBe('rgb(255, 0, 0)')
    expect(loadingShell.className).toContain('code-editor')
    expect(loadingShell.className).toContain('my-custom-class')

    await act(async () => {
      resolveImpl()
      await pendingPromise
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByTestId('impl-layout')).toBeInTheDocument())

    unmount()
  })

  it('loading shell respects expanded=true: ignores height/maxHeight but preserves minHeight/style/className', async () => {
    let resolveExpanded: () => void = () => {}
    let implReadyExpanded = false
    const pendingExpanded = new Promise<void>((res) => {
      resolveExpanded = () => {
        implReadyExpanded = true
        res()
      }
    })

    vi.doMock('../CodeEditorImpl', () => ({
      default: React.memo((props: CodeEditorProps) => {
        if (!implReadyExpanded) throw pendingExpanded
        return <div data-testid="impl-layout-expanded">{props.value}</div>
      })
    }))

    const { default: CodeEditor } = await import('../index')

    const { unmount } = render(
      <CodeEditor
        value="layout-expanded"
        language="js"
        height="200px"
        minHeight="100px"
        maxHeight="300px"
        expanded={true}
        style={{ backgroundColor: 'rgb(0, 0, 255)' }}
        className="expanded-class"
      />
    )

    const loadingShell = screen.getByTestId('code-editor-loading')
    expect(loadingShell).toBeInTheDocument()
    expect(loadingShell.style.height).toBe('')
    expect(loadingShell.style.maxHeight).toBe('')
    expect(loadingShell.style.minHeight).toBe('100px')
    expect(loadingShell.style.backgroundColor).toBe('rgb(0, 0, 255)')
    expect(loadingShell.className).toContain('code-editor')
    expect(loadingShell.className).toContain('expanded-class')

    await act(async () => {
      resolveExpanded()
      await pendingExpanded
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByTestId('impl-layout-expanded')).toBeInTheDocument())
    unmount()
  })

  it('loading shell respects default expanded (undefined): ignores height/maxHeight', async () => {
    let resolveDefault: () => void = () => {}
    let implReadyDefault = false
    const pendingDefault = new Promise<void>((res) => {
      resolveDefault = () => {
        implReadyDefault = true
        res()
      }
    })

    vi.doMock('../CodeEditorImpl', () => ({
      default: React.memo((props: CodeEditorProps) => {
        if (!implReadyDefault) throw pendingDefault
        return <div data-testid="impl-layout-default">{props.value}</div>
      })
    }))

    const { default: CodeEditor } = await import('../index')

    const { unmount } = render(
      <CodeEditor
        value="layout-default"
        language="js"
        height="220px"
        minHeight="120px"
        maxHeight="320px"
        style={{ backgroundColor: 'rgb(255, 255, 0)' }}
        className="default-class"
      />
    )

    const loadingShell = screen.getByTestId('code-editor-loading')
    expect(loadingShell.style.height).toBe('')
    expect(loadingShell.style.maxHeight).toBe('')
    expect(loadingShell.style.minHeight).toBe('120px')
    expect(loadingShell.style.backgroundColor).toBe('rgb(255, 255, 0)')
    expect(loadingShell.className).toContain('default-class')

    await act(async () => {
      resolveDefault()
      await pendingDefault
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByTestId('impl-layout-default')).toBeInTheDocument())
    unmount()
  })

  it('error shell respects expanded=false: preserves height/maxHeight', async () => {
    vi.doMock('../CodeEditorImpl', () => ({
      default: () => {
        throw new Error('chunk fail for layout')
      }
    }))
    const { default: CodeEditor } = await import('../index')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(
      <CodeEditor
        value="error-layout"
        language="js"
        height="210px"
        minHeight="110px"
        maxHeight="310px"
        expanded={false}
        style={{ backgroundColor: 'rgb(0, 255, 0)' }}
        className="error-custom"
      />
    )
    await waitFor(() => expect(screen.getByTestId('code-editor-error')).toBeInTheDocument())
    const errorShell = screen.getByTestId('code-editor-error')
    expect(errorShell.style.height).toBe('210px')
    expect(errorShell.style.minHeight).toBe('110px')
    expect(errorShell.style.maxHeight).toBe('310px')
    expect(errorShell.style.backgroundColor).toBe('rgb(0, 255, 0)')
    expect(errorShell.className).toContain('code-editor')
    expect(errorShell.className).toContain('error-custom')
    spy.mockRestore()
    unmount()
  })

  it('error shell respects expanded=true: ignores height/maxHeight but preserves minHeight/style/className', async () => {
    vi.doMock('../CodeEditorImpl', () => ({
      default: () => {
        throw new Error('chunk fail for layout expanded')
      }
    }))
    const { default: CodeEditor } = await import('../index')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(
      <CodeEditor
        value="error-layout-expanded"
        language="js"
        height="210px"
        minHeight="110px"
        maxHeight="310px"
        expanded={true}
        style={{ backgroundColor: 'rgb(128, 0, 128)' }}
        className="error-expanded"
      />
    )
    await waitFor(() => expect(screen.getByTestId('code-editor-error')).toBeInTheDocument())
    const errorShell = screen.getByTestId('code-editor-error')
    expect(errorShell.style.height).toBe('')
    expect(errorShell.style.maxHeight).toBe('')
    expect(errorShell.style.minHeight).toBe('110px')
    expect(errorShell.style.backgroundColor).toBe('rgb(128, 0, 128)')
    expect(errorShell.className).toContain('code-editor')
    expect(errorShell.className).toContain('error-expanded')

    spy.mockRestore()
    unmount()
  })

  it('wrapper does not require consumer Suspense ancestor', async () => {
    const MockImpl = (props: CodeEditorProps) => <div data-testid="impl-no-suspense">{props.value}</div>
    vi.doMock('../CodeEditorImpl', () => ({ default: MockImpl }))
    const { default: CodeEditor } = await import('../index')
    expect(() =>
      render(
        <div>
          <CodeEditor value="no-suspense" language="text" />
        </div>
      )
    ).not.toThrow()
    await waitFor(() => expect(screen.getByTestId('impl-no-suspense')).toBeInTheDocument())
  })
})
