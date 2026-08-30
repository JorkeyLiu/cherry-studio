import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MathRuntime } from '../mathLoader'

const makeBlock = (id: string, content: string): MainTextMessageBlock => ({
  id,
  messageId: 'msg-1',
  type: MessageBlockType.MAIN_TEXT,
  status: MessageBlockStatus.SUCCESS,
  createdAt: new Date().toISOString(),
  content
})

const loggerErrorMock = vi.hoisted(() => vi.fn())
const loadMathRuntimeMock = vi.hoisted(() => vi.fn<() => Promise<MathRuntime>>())

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: loggerErrorMock,
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('../mathLoader', () => ({
  loadMathRuntime: loadMathRuntimeMock
}))

// Keep real react-markdown, but mock heavy components lightly to avoid side effects
vi.mock('../CodeBlock', () => ({
  __esModule: true,
  default: ({ children }: any) => <div data-testid="code-block">{children}</div>
}))
vi.mock('../Link', () => ({
  __esModule: true,
  default: (props: any) => <a {...props} />
}))
vi.mock('../Table', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>
}))
vi.mock('../MarkdownSvgRenderer', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/components/ImageViewer', () => ({
  __esModule: true,
  default: (props: any) => <img {...props} />
}))
vi.mock('@renderer/components/MarkdownShadowDOMRenderer', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>
}))

import Markdown from '../Markdown'

describe('Markdown realistic fallback (S7.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loggerErrorMock.mockClear()
    loadMathRuntimeMock.mockReset()
  })

  it('pending fallback renders ordinary Markdown and does not crash', async () => {
    let pendingResolve: (v: MathRuntime) => void
    const pending = new Promise<MathRuntime>((res) => {
      pendingResolve = res
    })
    loadMathRuntimeMock.mockReturnValue(pending)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { container } = render(<Markdown block={makeBlock('b1', 'Hello **bold** $a$')} />)

    // Real ReactMarkdown should render bold and fallback math as text, not blank
    expect(container.textContent).not.toBe('')
    expect(container.textContent).toContain('Hello')
    expect(container.textContent).toContain('$a$')
    // Should have rendered without math plugins (still ordinary)
    expect(loadMathRuntimeMock).toHaveBeenCalledTimes(1)
    expect(loggerErrorMock).not.toHaveBeenCalled()

    // Resolve pending to prove still works after
    await act(async () => {
      pendingResolve!({ remarkMath: vi.fn() as any, rehypeKatex: vi.fn() as any } as MathRuntime)
      await Promise.resolve()
      await Promise.resolve()
    })
    // After resolution, still contains content
    expect(container.textContent).toContain('Hello')
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(consoleLogSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
    consoleLogSpy.mockRestore()
  })

  it('failure fallback renders ordinary Markdown, logs via loggerService, no console, and malformed does not crash', async () => {
    loadMathRuntimeMock.mockRejectedValue(new Error('load failed'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { container: c1 } = render(<Markdown block={makeBlock('b1', 'Fallback $x^2$ content')} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(c1.textContent).not.toBe('')
    expect(c1.textContent).toContain('Fallback')
    expect(c1.textContent).toContain('$x^2$')
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to load math runtime', expect.any(Error))
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(consoleLogSpy).not.toHaveBeenCalled()
    expect(consoleWarnSpy).not.toHaveBeenCalled()

    // Malformed inputs should not crash, still fallback
    const { container: c2 } = render(<Markdown block={makeBlock('b2', '$unclosed')} />)
    expect(c2.textContent).not.toBe('')
    expect(() => screen.getByText(/unclosed/)).not.toThrow()

    const { container: c3 } = render(<Markdown block={makeBlock('b3', '$$unclosed display')} />)
    expect(c3.textContent).not.toBe('')
    expect(c3.textContent).toContain('unclosed')

    const { container: c4 } = render(<Markdown block={makeBlock('b4', 'Broken $a$ **bold** `code`')} />)
    expect(c4.textContent).not.toBe('')
    expect(c4.textContent).toContain('Broken')

    consoleErrorSpy.mockRestore()
    consoleLogSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })
})
