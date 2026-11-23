import 'katex/dist/katex.min.css'

import type { Citation } from '@renderer/types'
import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { withCitationTags } from '@renderer/utils/citation'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Markdown, { MARKDOWN_PARSE_CADENCE_MS } from '../Markdown'

/**
 * Markdown streaming behavior tests:
 *   - streaming content is parsed at most once per cadence window from the
 *     latest raw block content, with no animation-frame/grapheme queue
 *   - a short silence still delivers the tail (one pending trailing timer)
 *   - completion / error / pause flush the exact authoritative content
 *   - block switches / non-prefix rewrites / clears flush immediately
 *   - post-processing runs once per planned parse and the latest callback is
 *     used for the last content
 */

// Recording ReactMarkdown mock: every rendered children value is captured so
// parse/update cadence and exact final content are observable.
const md = vi.hoisted(() => ({
  children: [] as string[],
  commits: [] as Array<{ text: string; at: number }>
}))

// Stable `t` like the real react-i18next hook (a new `t` every render would
// defeat MarkdownBody memoization and make cadence assertions meaningless).
const i18n = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: any) => {
    md.children.push(children)
    md.commits.push({ text: children, at: performance.now() })
    return <div data-testid="markdown-children">{children}</div>
  }
}))

// Component mocks kept lightweight like the existing Markdown test.
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
  removeSvgEmptyLines: vi.fn((str: string) => str),
  cleanMarkdownContent: vi.fn((str: string) => str),
  encodeHTML: vi.fn((str: string) =>
    str.replace(/[&<>"']/g, (match) => {
      const entities: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
      }
      return entities[match]
    })
  )
}))

vi.mock('@renderer/utils/markdown', () => ({
  processLatexBrackets: vi.fn((str: string) => str),
  normalizeAttachedBlockMathClose: vi.fn((str: string) => str)
}))

const makeBlock = (id: string, content: string, status: MessageBlockStatus): MainTextMessageBlock => ({
  id,
  messageId: 'msg-1',
  type: MessageBlockType.MAIN_TEXT,
  status,
  createdAt: new Date().toISOString(),
  content
})

const lastRendered = () => md.children[md.children.length - 1]

describe('Markdown streaming cadence', () => {
  beforeEach(() => {
    md.children.length = 0
    md.commits.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders the exact complete content at completion (no truncation)', () => {
    const finalContent = '# Final heading\n\nStreamed body with `code` and **bold** and the trailing tail.'
    const partial = '# Final heading\n\nStreamed body with `code` and **bold**'

    const { rerender } = render(<Markdown block={makeBlock('block-1', partial, MessageBlockStatus.STREAMING)} />)

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS + 10)
    })

    // Completion flips the status; the remaining tail must flush exactly.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} />)
    })

    expect(lastRendered()).toBe(finalContent)

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })
    expect(lastRendered()).toBe(finalContent)
  })

  it.each([
    MessageBlockStatus.PENDING,
    MessageBlockStatus.PROCESSING,
    MessageBlockStatus.SUCCESS,
    MessageBlockStatus.ERROR,
    MessageBlockStatus.PAUSED
  ])('renders exact initial and updated content without scheduling frames for %s', (status) => {
    const requestAnimationFrameSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    const initialContent = `Initial content for ${status}`
    const updatedContent = `Updated content for ${status}`
    const { rerender } = render(<Markdown block={makeBlock('block-1', initialContent, status)} />)

    expect(lastRendered()).toBe(initialContent)

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled()

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', updatedContent, status)} />)
    })

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled()
    expect(lastRendered()).toBe(updatedContent)
  })

  it('does not use animation frames for streaming content; one cadence timer delivers the latest text', () => {
    const requestAnimationFrameSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const { rerender } = render(<Markdown block={makeBlock('block-1', 'start', MessageBlockStatus.STREAMING)} />)

    expect(lastRendered()).toBe('start')
    const timersAtMount = setTimeoutSpy.mock.calls.length

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'start delta', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS / 2)
    })
    expect(lastRendered()).toBe('start')

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS)
    })
    expect(lastRendered()).toBe('start delta')

    expect(setTimeoutSpy.mock.calls.length).toBe(timersAtMount + 1)
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled()
  })

  it('flushes the exact final content when completion arrives before the cadence window closes', () => {
    const finalContent = 'alpha beta gamma delta epsilon zeta'
    const partial = 'alpha beta gamma'

    const { rerender } = render(<Markdown block={makeBlock('block-1', partial, MessageBlockStatus.STREAMING)} />)
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS / 2)
    })
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} />)
    })

    expect(lastRendered()).toBe(finalContent)

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })
    expect(lastRendered()).toBe(finalContent)
  })

  it.each([MessageBlockStatus.ERROR, MessageBlockStatus.PAUSED])(
    'invalidates pending streaming work and renders exact final content for streaming to %s',
    (status) => {
      const finalContent = `Authoritative final content for ${status}`
      const streamedContent = `${finalContent} with queued stale tail`
      const { rerender } = render(
        <Markdown block={makeBlock('block-1', 'Initial stream', MessageBlockStatus.STREAMING)} />
      )

      act(() => {
        rerender(<Markdown block={makeBlock('block-1', streamedContent, MessageBlockStatus.STREAMING)} />)
      })
      act(() => {
        vi.advanceTimersByTime(16)
      })

      // Simulate a trailing timer that survives the status transition: the
      // generation guard must make it inert.
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
      act(() => {
        rerender(<Markdown block={makeBlock('block-1', finalContent, status)} />)
      })
      clearTimeoutSpy.mockRestore()

      expect(lastRendered()).toBe(finalContent)

      const commitCountAfterTransition = md.commits.length
      act(() => {
        vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
      })

      expect(md.commits.length).toBe(commitCountAfterTransition)
      expect(lastRendered()).toBe(finalContent)
    }
  )

  it('plans at most one full parse per cadence window under continuous chunks and delivers the tail on silence', () => {
    const requestAnimationFrameSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    const parseTimes: number[] = []
    const processText = (text: string) => {
      parseTimes.push(performance.now())
      return text
    }

    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'start', MessageBlockStatus.STREAMING)} postProcess={processText} />
    )
    parseTimes.length = 0
    md.commits.length = 0

    // ~12 commits with one frame between them (192ms), like a streaming burst.
    let content = 'start'
    for (let i = 0; i < 12; i++) {
      content += ` word${i}`
      act(() => {
        rerender(
          <Markdown block={makeBlock('block-1', content, MessageBlockStatus.STREAMING)} postProcess={processText} />
        )
      })
      act(() => {
        vi.advanceTimersByTime(16)
      })
    }
    // Let the trailing cadence flush settle (short silence after the last chunk).
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 4)
    })

    expect(parseTimes.length).toBeGreaterThan(0)
    for (let i = 1; i < parseTimes.length; i++) {
      expect(parseTimes[i] - parseTimes[i - 1]).toBeGreaterThanOrEqual(MARKDOWN_PARSE_CADENCE_MS)
    }
    expect(lastRendered()).toBe(content)

    // No permanent RAF/grapheme catching-up: the final text stays stable.
    const parseCount = parseTimes.length
    const commitCount = md.commits.length
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })
    expect(parseTimes.length).toBe(parseCount)
    expect(md.commits.length).toBe(commitCount)
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled()
  })

  it('flushes the new block content immediately and exactly on block switch', () => {
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'block one content', MessageBlockStatus.SUCCESS)} />
    )
    expect(lastRendered()).toBe('block one content')

    act(() => {
      rerender(<Markdown block={makeBlock('block-2', 'block two content', MessageBlockStatus.SUCCESS)} />)
    })
    expect(lastRendered()).toBe('block two content')
  })

  it('flushes a same-id non-prefix rewrite immediately and renders an empty reset immediately', () => {
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'old streamed answer part one', MessageBlockStatus.STREAMING)} />
    )
    act(() => {
      vi.advanceTimersByTime(16 * 3)
    })

    // Content reset: the new stream no longer extends the old one.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'brand new answer', MessageBlockStatus.STREAMING)} />)
    })
    expect(lastRendered()).toBe('brand new answer')

    act(() => {
      vi.advanceTimersByTime(16 * 40)
    })

    // Empty text is a non-prefix rewrite too: it must render immediately.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', '', MessageBlockStatus.STREAMING)} />)
    })
    expect(lastRendered()).toBe('')

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'fresh content', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS)
    })
    expect(lastRendered()).toBe('fresh content')

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'fresh content tail', MessageBlockStatus.SUCCESS)} />)
    })
    expect(lastRendered()).toBe('fresh content tail')
  })

  it('renders the paused label for an empty paused block', () => {
    render(<Markdown block={makeBlock('block-1', '', MessageBlockStatus.PAUSED)} />)
    expect(screen.getByTestId('markdown-children')).toHaveTextContent('message.chat.completion.paused')
  })

  it('does not plan a parse within the first cadence window after mount', () => {
    const parseTimes: number[] = []
    const processText = (text: string) => {
      parseTimes.push(performance.now())
      return text
    }
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'start', MessageBlockStatus.STREAMING)} postProcess={processText} />
    )
    parseTimes.length = 0
    const commitCountAtMount = md.commits.length

    act(() => {
      rerender(
        <Markdown block={makeBlock('block-1', 'start delta', MessageBlockStatus.STREAMING)} postProcess={processText} />
      )
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS - 10)
    })

    expect(parseTimes.length).toBe(0)
    expect(md.commits.length).toBe(commitCountAtMount)

    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(parseTimes.length).toBe(1)
    expect(lastRendered()).toBe('start delta')
  })

  it('does not clear streaming initial content before the first planned parse', () => {
    const initialContent = 'Already streamed content'
    const { rerender } = render(<Markdown block={makeBlock('block-1', initialContent, MessageBlockStatus.STREAMING)} />)
    expect(lastRendered()).toBe(initialContent)

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', `${initialContent} tail`, MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS - 10)
    })
    // No cleared/intermediate state: the initial content is still on screen
    // until the cadence boundary publishes the latest raw content.
    expect(lastRendered()).toBe(initialContent)

    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(lastRendered()).toBe(`${initialContent} tail`)
  })

  it('preserves paused content and prevents a stale timer from overwriting it, then resumes correctly', () => {
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'streaming content', MessageBlockStatus.STREAMING)} />
    )
    md.commits.length = 0

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'streaming content extra', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS / 2)
    })

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'streaming content extra', MessageBlockStatus.PAUSED)} />)
    })

    // The paused content must be the latest block content, not stale mid-stream text.
    expect(lastRendered()).toBe('streaming content extra')

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })
    expect(lastRendered()).toBe('streaming content extra')

    // Resume streaming with appended content.
    act(() => {
      rerender(
        <Markdown block={makeBlock('block-1', 'streaming content extra resumed', MessageBlockStatus.STREAMING)} />
      )
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS)
    })

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'streaming content extra resumed', MessageBlockStatus.SUCCESS)} />)
    })

    expect(lastRendered()).toBe('streaming content extra resumed')
  })

  it('flushes exact final content when stream completes during a cadence window', () => {
    const { rerender } = render(<Markdown block={makeBlock('block-1', 'partial', MessageBlockStatus.STREAMING)} />)

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'partial extended tail', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(30)
    })

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'partial extended tail', MessageBlockStatus.SUCCESS)} />)
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })

    expect(lastRendered()).toBe('partial extended tail')
  })

  it('runs postProcess only for planned parses, not per chunk or on a duplicate flush', () => {
    const processText = vi.fn((text: string) => text)
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'a', MessageBlockStatus.STREAMING)} postProcess={processText} />
    )
    // Initial parsed content is post-processed exactly once.
    expect(processText).toHaveBeenCalledTimes(1)

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'a b', MessageBlockStatus.STREAMING)} postProcess={processText} />)
    })
    act(() => {
      rerender(
        <Markdown block={makeBlock('block-1', 'a b c', MessageBlockStatus.STREAMING)} postProcess={processText} />
      )
    })
    expect(processText).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS)
    })
    expect(processText).toHaveBeenCalledTimes(2)
    expect(lastRendered()).toBe('a b c')

    act(() => {
      rerender(
        <Markdown block={makeBlock('block-1', 'a b c d', MessageBlockStatus.STREAMING)} postProcess={processText} />
      )
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS)
    })
    expect(processText).toHaveBeenCalledTimes(3)
    expect(lastRendered()).toBe('a b c d')

    // Completion with unchanged content must not re-process it.
    act(() => {
      rerender(
        <Markdown block={makeBlock('block-1', 'a b c d', MessageBlockStatus.SUCCESS)} postProcess={processText} />
      )
    })
    expect(processText).toHaveBeenCalledTimes(3)
    expect(lastRendered()).toBe('a b c d')
  })

  it('defers a streaming callback change to the cadence tail without restarting the pending timer', () => {
    const first = vi.fn((text: string) => `first|${text}`)
    const second = vi.fn((text: string) => `second|${text}`)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'alpha', MessageBlockStatus.STREAMING)} postProcess={first} />
    )
    expect(lastRendered()).toBe('first|alpha')
    const timersAtMount = setTimeoutSpy.mock.calls.length

    // Stay inside the cadence window: the window has not closed yet, so this
    // cannot take the "opportunity already open" path either.
    act(() => {
      vi.advanceTimersByTime(10)
    })

    // Same raw content, new callback identity: NOT an exact path while
    // streaming. It only marks pending reprocessing for the cadence tail.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'alpha', MessageBlockStatus.STREAMING)} postProcess={second} />)
    })
    expect(lastRendered()).toBe('first|alpha')
    expect(second).not.toHaveBeenCalled()

    // Callback churn must not restart (cancel + re-arm) the single timer.
    act(() => {
      rerender(
        <Markdown
          block={makeBlock('block-1', 'alpha', MessageBlockStatus.STREAMING)}
          postProcess={(text) => `third|${text}`}
        />
      )
    })
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(setTimeoutSpy.mock.calls.length).toBe(timersAtMount + 1)

    // After the cadence boundary the tail runs with the latest callback and the
    // whole authoritative raw text (never a processed prefix plus raw suffix).
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS)
    })
    expect(lastRendered()).toBe('third|alpha')
    expect(second).not.toHaveBeenCalled()
  })

  it('bounds parses when the caller rebuilds postProcess on every chunk', () => {
    const callbacks = Array.from({ length: 9 }, (_, i) => vi.fn((text: string) => `v${i}|${text}`))
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    let content = 'w0'
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', content, MessageBlockStatus.STREAMING)} postProcess={callbacks[0]} />
    )
    const commitsAtStart = md.commits.length
    const timersAtStart = setTimeoutSpy.mock.calls.length

    // 8 chunks, 10ms apart, each carrying a fresh callback identity: the
    // caller's per-chunk rebuild must not turn into one urgent parse per chunk.
    for (let i = 1; i <= 8; i++) {
      content += ` w${i}`
      const cb = callbacks[i]
      act(() => {
        rerender(<Markdown block={makeBlock('block-1', content, MessageBlockStatus.STREAMING)} postProcess={cb} />)
      })
      act(() => {
        vi.advanceTimersByTime(10)
      })
    }

    // At most one timer exists at a time across the whole churn window.
    expect(setTimeoutSpy.mock.calls.length - timersAtStart).toBeLessThanOrEqual(2)

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 2)
    })
    // ~80ms of chunks at a 50ms cadence: the parse count stays small.
    expect(md.commits.length - commitsAtStart).toBeLessThanOrEqual(4)
    // The last rendered text is the latest callback over the latest raw text.
    expect(lastRendered()).toBe(`v8|${content}`)
  })

  it('flushes a callback change immediately for non-streaming blocks', () => {
    const first = (text: string) => `first|${text}`
    const second = (text: string) => `second|${text}`
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'alpha', MessageBlockStatus.SUCCESS)} postProcess={first} />
    )
    expect(lastRendered()).toBe('first|alpha')

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'alpha', MessageBlockStatus.SUCCESS)} postProcess={second} />)
    })
    expect(lastRendered()).toBe('second|alpha')
  })

  it('applies real citation post-processing to streamed and final content', () => {
    const citations: Citation[] = [{ number: 1, url: 'https://example.com', title: 'Example' }]
    const postProcess = (text: string) => withCitationTags(text, citations)

    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'Answer [1]', MessageBlockStatus.STREAMING)} postProcess={postProcess} />
    )
    expect(lastRendered()).toContain("data-citation='")
    expect(lastRendered()).toContain('https://example.com')

    act(() => {
      rerender(
        <Markdown
          block={makeBlock('block-1', 'Answer [1] with more [1]', MessageBlockStatus.STREAMING)}
          postProcess={postProcess}
        />
      )
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS)
    })
    expect(lastRendered()).toContain('with more')
    expect(lastRendered()).toContain('https://example.com')

    const finalContent = 'Answer [1] with more [1] and the end'
    act(() => {
      rerender(
        <Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} postProcess={postProcess} />
      )
    })
    expect(lastRendered()).toBe(withCitationTags(finalContent, citations))
  })
})
