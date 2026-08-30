import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MathRuntime } from '../mathLoader'

const mdCapture = vi.hoisted(() => ({
  calls: [] as Array<{ remarkPlugins: unknown[]; rehypePlugins: unknown[]; children: string }>,
  childrenHistory: [] as string[]
}))

const i18n = vi.hoisted(() => ({ t: (key: string) => key }))

const fakeRemarkMath = vi.hoisted(() => vi.fn(() => {}))
const fakeRehypeKatex = vi.hoisted(() => vi.fn(() => {}))
const fakeRemarkGfm = vi.hoisted(() => vi.fn(() => {}))
const fakeRemarkAlert = vi.hoisted(() => vi.fn(() => {}))
const fakeRemarkCjk = vi.hoisted(() => vi.fn(() => {}))
const fakeRemarkDisable = vi.hoisted(() => vi.fn(() => 'disable-result'))
const fakeRehypeRaw = vi.hoisted(() => vi.fn(() => {}))
const fakeRehypeHeadingIds = vi.hoisted(() => vi.fn(() => {}))
const fakeRehypeScalableSvg = vi.hoisted(() => vi.fn(() => {}))

const loadMathRuntimeMock = vi.hoisted(() => vi.fn<() => Promise<MathRuntime>>())
const loggerErrorMock = vi.hoisted(() => vi.fn())

vi.mock('../mathLoader', () => ({
  loadMathRuntime: loadMathRuntimeMock
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: loggerErrorMock,
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('remark-gfm', () => ({ __esModule: true, default: fakeRemarkGfm }))
vi.mock('remark-github-blockquote-alert', () => ({ __esModule: true, default: fakeRemarkAlert }))
vi.mock('remark-cjk-friendly', () => ({ __esModule: true, default: fakeRemarkCjk }))
vi.mock('../plugins/remarkDisableConstructs', () => ({ __esModule: true, default: fakeRemarkDisable }))
vi.mock('rehype-raw', () => ({ __esModule: true, default: fakeRehypeRaw }))
vi.mock('../plugins/rehypeHeadingIds', () => ({ __esModule: true, default: fakeRehypeHeadingIds }))
vi.mock('../plugins/rehypeScalableSvg', () => ({ __esModule: true, default: fakeRehypeScalableSvg }))

vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children, remarkPlugins, rehypePlugins }: any) => {
    mdCapture.calls.push({ remarkPlugins: remarkPlugins || [], rehypePlugins: rehypePlugins || [], children })
    mdCapture.childrenHistory.push(children)
    return <div data-testid="markdown-children">{children}</div>
  }
}))

vi.mock('../CodeBlock', () => ({
  __esModule: true,
  default: ({ children }: any) => <div data-testid="code-block">{children}</div>
}))
vi.mock('../Link', () => ({
  __esModule: true,
  default: ({ children, ...props }: any) => (
    <a data-testid="link" {...props}>
      {children}
    </a>
  )
}))
vi.mock('../Table', () => ({
  __esModule: true,
  default: ({ children }: any) => <div data-testid="table">{children}</div>
}))
vi.mock('../MarkdownSvgRenderer', () => ({
  __esModule: true,
  default: ({ children }: any) => <div data-testid="svg-renderer">{children}</div>
}))
vi.mock('@renderer/components/ImageViewer', () => ({
  __esModule: true,
  default: (props: any) => <img data-testid="image-viewer" {...props} />
}))
vi.mock('@renderer/components/MarkdownShadowDOMRenderer', () => ({
  __esModule: true,
  default: ({ children }: any) => <div data-testid="shadow-dom">{children}</div>
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18n.t }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('@renderer/utils/formats', () => ({
  removeSvgEmptyLines: vi.fn((str: string) => str)
}))

vi.mock('@renderer/utils/markdown', () => ({
  processLatexBrackets: vi.fn((str: string) => str)
}))

import Markdown from '../Markdown'

const makeBlock = (
  id: string,
  content: string,
  status: MessageBlockStatus = MessageBlockStatus.SUCCESS
): MainTextMessageBlock => ({
  id,
  messageId: 'msg-1',
  type: MessageBlockType.MAIN_TEXT,
  status,
  createdAt: new Date().toISOString(),
  content
})

const lastCall = () => mdCapture.calls[mdCapture.calls.length - 1]

describe('Markdown math on-demand (S7.6)', () => {
  beforeEach(() => {
    mdCapture.calls.length = 0
    mdCapture.childrenHistory.length = 0
    vi.clearAllMocks()
    fakeRemarkMath.mockClear()
    fakeRehypeKatex.mockClear()
    loggerErrorMock.mockClear()
    loadMathRuntimeMock.mockReset()
    loadMathRuntimeMock.mockImplementation(
      () =>
        Promise.resolve({
          remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
          rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
        }) as Promise<MathRuntime>
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not load math runtime on ordinary Markdown', async () => {
    render(<Markdown block={makeBlock('b1', 'Hello **bold** world')} />)
    expect(loadMathRuntimeMock).not.toHaveBeenCalled()
    const c = lastCall()
    expect(
      c.remarkPlugins.some((p: any) => p === fakeRemarkMath || (Array.isArray(p) && p[0] === fakeRemarkMath))
    ).toBe(false)
    expect(c.rehypePlugins.includes(fakeRehypeKatex)).toBe(false)
    expect(screen.getByTestId('markdown-children')).toHaveTextContent('Hello')
  })

  it('loads on inline $...$', async () => {
    render(<Markdown block={makeBlock('b1', 'Euler $e^{i\\pi}$')} />)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)
    expect(lastCall().remarkPlugins.some((p: any) => Array.isArray(p) && p[0] === fakeRemarkMath)).toBe(false)
    await waitFor(() => {
      const c = lastCall()
      return c.remarkPlugins.some((p: any) => Array.isArray(p) && p[0] === fakeRemarkMath)
    })
    const c = lastCall()
    const remarkMathEntry = c.remarkPlugins.find((p: any) => Array.isArray(p) && p[0] === fakeRemarkMath) as any
    expect(remarkMathEntry).toBeDefined()
    expect(remarkMathEntry[1]).toEqual({ singleDollarTextMath: true })
    expect(c.rehypePlugins[c.rehypePlugins.length - 1]).toBe(fakeRehypeKatex)
    expect(screen.getByTestId('markdown-children')).toHaveTextContent('Euler')
  })

  it('loads on display $$...$$', async () => {
    render(<Markdown block={makeBlock('b1', 'Display $$x^2$$')} />)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
  })

  it('loads on bracket forms \\(...\\) and \\[...\\]', async () => {
    const { unmount } = render(<Markdown block={makeBlock('b1', 'Inline \\(a+b\\)')} />)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
    unmount()
    mdCapture.calls.length = 0
    loadMathRuntimeMock.mockClear()
    loadMathRuntimeMock.mockResolvedValue({
      remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
      rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
    } as MathRuntime)
    render(<Markdown block={makeBlock('b2', 'Display \\[x\\]')} />)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
  })

  it('does not load when math is inside fenced or inline code, but loads for fenced math', async () => {
    render(<Markdown block={makeBlock('b1', '```\n$x$\n```')} />)
    expect(loadMathRuntimeMock).not.toHaveBeenCalled()
    render(<Markdown block={makeBlock('b2', '`$x$`')} />)
    expect(loadMathRuntimeMock).not.toHaveBeenCalled()
    mdCapture.calls.length = 0
    loadMathRuntimeMock.mockClear()
    render(<Markdown block={makeBlock('b3', '```math\nx\n```')} />)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
  })

  it('renders safe fallback while pending and after failure without blank', async () => {
    let reject: (e: Error) => void
    const pending = new Promise<MathRuntime>((_, rej) => {
      reject = rej
    })
    loadMathRuntimeMock.mockReturnValue(pending)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    render(<Markdown block={makeBlock('b1', '$a$')} />)
    expect(screen.getByTestId('markdown-children').textContent).not.toBe('')
    expect(screen.getByTestId('markdown-children')).toHaveTextContent('$a$')
    expect(lastCall().remarkPlugins.some((p: any) => Array.isArray(p) && p[0] === fakeRemarkMath)).toBe(false)

    await act(async () => {
      reject!(new Error('load failed'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(lastCall().remarkPlugins.some((p: any) => Array.isArray(p) && p[0] === fakeRemarkMath)).toBe(false)
    expect(screen.getByTestId('markdown-children')).toHaveTextContent('$a$')
    expect(screen.getByTestId('markdown-children').textContent).not.toBe('')
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(consoleLogSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
    consoleLogSpy.mockRestore()
  })

  it('latest observer during shared pending activates runtime on resolution', async () => {
    let resolve: (v: MathRuntime) => void
    const sharedPending = new Promise<MathRuntime>((res) => {
      resolve = res
    })
    loadMathRuntimeMock.mockReturnValue(sharedPending)

    const { rerender } = render(<Markdown block={makeBlock('b1', '$a$')} />)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)
    rerender(<Markdown block={makeBlock('b1', '$b$ updated')} />)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(2)
    // Both calls share same promise instance
    expect(loadMathRuntimeMock.mock.results[0].value).toBe(loadMathRuntimeMock.mock.results[1].value)

    await act(async () => {
      resolve!({
        remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
        rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
      } as MathRuntime)
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
    expect(screen.getByTestId('markdown-children')).toHaveTextContent('$b$ updated')
  })

  it('math→non-math during pending does not activate plugins', async () => {
    let resolve: (v: MathRuntime) => void
    const pending = new Promise<MathRuntime>((res) => {
      resolve = res
    })
    loadMathRuntimeMock.mockReturnValue(pending)

    const { rerender } = render(<Markdown block={makeBlock('b1', '$a$')} />)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)
    rerender(<Markdown block={makeBlock('b1', 'ordinary text no math')} />)
    // Non-math render should not call load again
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolve!({
        remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
        rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
      } as MathRuntime)
      await Promise.resolve()
    })
    // The pending observer was cancelled (non-math), so no activation
    expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(false)

    // Later math on same blockId after non-math should reset budget and allow load
    loadMathRuntimeMock.mockResolvedValue({
      remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
      rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
    } as MathRuntime)
    rerender(<Markdown block={makeBlock('b1', '$c$')} />)
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
  })

  it('bounded retry: one failure fallback/log, one permitted retry, then suppressed until reset', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadMathRuntimeMock.mockRejectedValueOnce(new Error('first fail')).mockRejectedValueOnce(new Error('second fail'))

    const { rerender, unmount } = render(<Markdown block={makeBlock('b1', '$a$')} />)
    await waitFor(() => expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(loggerErrorMock).toHaveBeenCalledTimes(1))
    expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(false)

    // Permitted retry on next qualifying update same block
    rerender(<Markdown block={makeBlock('b1', '$a$ updated')} />)
    await waitFor(() => expect(loadMathRuntimeMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(loggerErrorMock).toHaveBeenCalledTimes(2))
    expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(false)

    // Further streaming updates same blockId should be suppressed
    rerender(<Markdown block={makeBlock('b1', '$a$ more')} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(2)
    expect(loggerErrorMock).toHaveBeenCalledTimes(2)

    rerender(<Markdown block={makeBlock('b1', '$a$ even more')} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(2)

    // Block change resets budget - retry allowed
    const beforeB2 = loadMathRuntimeMock.mock.calls.length
    loadMathRuntimeMock.mockResolvedValue({
      remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
      rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
    } as MathRuntime)
    rerender(<Markdown block={makeBlock('b2', '$a$')} />)
    await waitFor(() => expect(loadMathRuntimeMock.mock.calls.length).toBeGreaterThan(beforeB2))
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
    expect(loggerErrorMock).toHaveBeenCalledTimes(2)

    unmount()
    cleanup()
    mdCapture.calls.length = 0
    loadMathRuntimeMock.mockClear()
    loggerErrorMock.mockClear()
    loadMathRuntimeMock.mockRejectedValueOnce(new Error('fail')).mockRejectedValueOnce(new Error('fail2'))
    const { rerender: rer2 } = render(<Markdown block={makeBlock('b3', '$x$')} />)
    await waitFor(() => expect(loadMathRuntimeMock.mock.calls.length).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(loggerErrorMock).toHaveBeenCalledTimes(1))
    const beforeSecond = loadMathRuntimeMock.mock.calls.length
    rer2(<Markdown block={makeBlock('b3', '$x$2')} />)
    await waitFor(() => expect(loadMathRuntimeMock.mock.calls.length).toBeGreaterThan(beforeSecond))
    await waitFor(() => expect(loggerErrorMock).toHaveBeenCalledTimes(2))
    const afterSecond = loadMathRuntimeMock.mock.calls.length
    // third same block suppressed - no increase
    rer2(<Markdown block={makeBlock('b3', '$x$3')} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(loadMathRuntimeMock.mock.calls.length).toBe(afterSecond)
    // transition to non-math resets
    rer2(<Markdown block={makeBlock('b3', 'plain no math')} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(loadMathRuntimeMock.mock.calls.length).toBe(afterSecond)
    loadMathRuntimeMock.mockResolvedValue({
      remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
      rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
    } as MathRuntime)
    const beforeY = loadMathRuntimeMock.mock.calls.length
    rer2(<Markdown block={makeBlock('b3', '$y$')} />)
    await waitFor(() => expect(loadMathRuntimeMock.mock.calls.length).toBeGreaterThan(beforeY))
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
    consoleErrorSpy.mockRestore()
  })

  it('concurrent qualifying instances share the same mocked load promise (mock-level only — factory dedup is proven in Markdown.lazy.test)', async () => {
    // This test uses a mocked loadMathRuntime with an already-shared Promise.
    // It verifies component-level sharing of a mocked loader promise, not the
    // actual loader’s factory dedup; the actual five-factory dedup is proven
    // in Markdown.lazy.test via the real mathLoader with deferred factories.
    let resolve: (v: MathRuntime) => void
    const shared = new Promise<MathRuntime>((res) => {
      resolve = res
    })
    let callCount = 0
    loadMathRuntimeMock.mockImplementation(() => {
      callCount += 1
      return shared
    })

    render(
      <div>
        <Markdown block={makeBlock('b1', '$a$')} />
        <Markdown block={makeBlock('b2', '$b$')} />
      </div>
    )
    expect(callCount).toBe(2)
    // Both share same promise instance
    expect(loadMathRuntimeMock.mock.results[0].value).toBe(loadMathRuntimeMock.mock.results[1].value)

    await act(async () => {
      resolve!({
        remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
        rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
      } as MathRuntime)
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      const withMath = mdCapture.calls.filter((c) => c.rehypePlugins.includes(fakeRehypeKatex))
      expect(withMath.length).toBeGreaterThan(0)
    })
    expect(screen.getAllByTestId('markdown-children').length).toBe(2)
  })

  it('unmount before load resolves does not update incorrectly', async () => {
    let resolveLoad: (v: MathRuntime) => void
    const pending = new Promise<MathRuntime>((res) => {
      resolveLoad = res
    })
    loadMathRuntimeMock.mockReturnValue(pending)

    const { unmount } = render(<Markdown block={makeBlock('b1', '$a$')} />)
    unmount()
    await act(async () => {
      resolveLoad!({
        remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
        rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
      } as MathRuntime)
      await Promise.resolve()
    })
    loadMathRuntimeMock.mockResolvedValue({
      remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
      rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
    } as MathRuntime)
    render(<Markdown block={makeBlock('b2', '$b$')} />)
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
  })

  it('malformed math does not crash (renders fallback)', async () => {
    render(<Markdown block={makeBlock('b1', '$unclosed')} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('markdown-children')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-children').textContent).not.toBe('')
  })

  it('asserts complete remark plugin sequence and rehype sequences', async () => {
    // Without math and without allowed HTML - should be base plugins only
    render(<Markdown block={makeBlock('b1', 'plain text')} />)
    let c = lastCall()
    expect(c.remarkPlugins).toHaveLength(4)
    expect(c.remarkPlugins[0]).toEqual([fakeRemarkGfm, { singleTilde: false }])
    expect(c.remarkPlugins[1]).toEqual([fakeRemarkAlert])
    expect(c.remarkPlugins[2]).toBe(fakeRemarkCjk)
    expect(c.remarkPlugins[3]).toBe('disable-result')
    expect(c.rehypePlugins).toHaveLength(1)
    expect(c.rehypePlugins[0]).toEqual([fakeRehypeHeadingIds, { prefix: 'heading-b1' }])

    // With math, no allowed HTML
    mdCapture.calls.length = 0
    loadMathRuntimeMock.mockClear()
    loadMathRuntimeMock.mockResolvedValue({
      remarkMath: fakeRemarkMath as unknown as MathRuntime['remarkMath'],
      rehypeKatex: fakeRehypeKatex as unknown as MathRuntime['rehypeKatex']
    } as MathRuntime)
    render(<Markdown block={makeBlock('b2', '$a$')} />)
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
    c = lastCall()
    expect(c.remarkPlugins).toHaveLength(5)
    expect(c.remarkPlugins[4]).toEqual([fakeRemarkMath, { singleDollarTextMath: true }])
    expect(c.rehypePlugins).toHaveLength(2)
    expect(c.rehypePlugins[0]).toEqual([fakeRehypeHeadingIds, { prefix: 'heading-b2' }])
    expect(c.rehypePlugins[1]).toBe(fakeRehypeKatex)

    // With allowed raw HTML and math
    mdCapture.calls.length = 0
    render(<Markdown block={makeBlock('b3', '<div>hi</div> $a$')} />)
    await waitFor(() => expect(lastCall().rehypePlugins.includes(fakeRehypeKatex)).toBe(true))
    c = lastCall()
    expect(c.rehypePlugins).toHaveLength(4)
    expect(c.rehypePlugins[0]).toBe(fakeRehypeRaw)
    expect(c.rehypePlugins[1]).toBe(fakeRehypeScalableSvg)
    expect(c.rehypePlugins[2]).toEqual([fakeRehypeHeadingIds, { prefix: 'heading-b3' }])
    expect(c.rehypePlugins[3]).toBe(fakeRehypeKatex)

    // With allowed HTML but without math
    mdCapture.calls.length = 0
    render(<Markdown block={makeBlock('b4', '<span>hello</span> plain')} />)
    c = lastCall()
    expect(c.rehypePlugins).toHaveLength(3)
    expect(c.rehypePlugins[0]).toBe(fakeRehypeRaw)
    expect(c.rehypePlugins[1]).toBe(fakeRehypeScalableSvg)
    expect(c.rehypePlugins[2]).toEqual([fakeRehypeHeadingIds, { prefix: 'heading-b4' }])
  })
})
