import 'katex/dist/katex.min.css'

import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Markdown from '../Markdown'

/**
 * LOCK-004 streaming behavior tests for Markdown:
 *   - the final rendered Markdown receives the exact complete content with no
 *     truncation when the stream completes (even mid-drain)
 *   - expensive ReactMarkdown parse/render updates are bounded well below the
 *     animation-frame rate while streaming
 *   - block switches / resets flush immediately and exactly
 *   - the paused empty-block label is preserved
 */

// Recording ReactMarkdown mock: every rendered children value is captured so
// parse/update cadence and exact final content are observable.
const md = vi.hoisted(() => ({ children: [] as string[] }))

// Stable `t` like the real react-i18next hook (a new `t` every render would
// defeat MarkdownBody memoization and make cadence assertions meaningless).
const i18n = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: any) => {
    md.children.push(children)
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
  removeSvgEmptyLines: vi.fn((str: string) => str)
}))

vi.mock('@renderer/utils/markdown', () => ({
  processLatexBrackets: vi.fn((str: string) => str)
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

describe('Markdown streaming (LOCK-004)', () => {
  beforeEach(() => {
    md.children.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('renders the exact complete content at completion (no truncation)', () => {
    const finalContent = '# Final heading\n\nStreamed body with `code` and **bold** and the trailing tail.'
    const partial = '# Final heading\n\nStreamed body with `code` and **bold**'

    const { rerender } = render(<Markdown block={makeBlock('block-1', partial, MessageBlockStatus.STREAMING)} />)

    // Simulate streaming commits appending content, frames draining the queue.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(16 * 40)
    })

    // Completion flips the status; the remaining tail must flush exactly.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} />)
    })
    act(() => {
      vi.advanceTimersByTime(16 * 20)
    })

    expect(lastRendered()).toBe(finalContent)
  })

  it('flushes the exact final content when completion arrives before the stream drains', () => {
    const finalContent = 'alpha beta gamma delta epsilon zeta'
    const partial = 'alpha beta gamma'

    const { rerender } = render(<Markdown block={makeBlock('block-1', partial, MessageBlockStatus.STREAMING)} />)
    // Only a frame or two: the tail ("delta epsilon zeta") is still queued.
    act(() => {
      vi.advanceTimersByTime(16 * 2)
    })
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} />)
    })
    act(() => {
      vi.advanceTimersByTime(16 * 20)
    })

    expect(lastRendered()).toBe(finalContent)
  })

  it('bounds full Markdown parse/render updates below the frame rate while streaming', () => {
    const { rerender } = render(<Markdown block={makeBlock('block-1', 'start', MessageBlockStatus.STREAMING)} />)
    md.children.length = 0

    // ~12 commits with one frame between them (192ms), like a streaming burst.
    let content = 'start'
    for (let i = 0; i < 12; i++) {
      content += ` word${i}`
      act(() => {
        rerender(<Markdown block={makeBlock('block-1', content, MessageBlockStatus.STREAMING)} />)
      })
      act(() => {
        vi.advanceTimersByTime(16)
      })
    }
    // Let the trailing cadence flush settle.
    act(() => {
      vi.advanceTimersByTime(300)
    })

    // 12 frames happened; the parse cadence (50ms) must keep the full-text
    // parse count far below the frame count.
    expect(md.children.length).toBeGreaterThan(0)
    expect(md.children.length).toBeLessThan(6)
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

  it('does not render stale text after a content reset (regenerate)', () => {
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'old streamed answer part one', MessageBlockStatus.STREAMING)} />
    )
    act(() => {
      vi.advanceTimersByTime(16 * 3)
    })

    // Content reset: the new stream no longer extends the old one.
    // The reset must flush immediately so the new content is visible before
    // any timers or status transitions can mask a stale reset.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'brand new answer', MessageBlockStatus.STREAMING)} />)
    })
    expect(lastRendered()).toBe('brand new answer')

    act(() => {
      vi.advanceTimersByTime(16 * 40)
    })
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'brand new answer tail', MessageBlockStatus.SUCCESS)} />)
    })
    act(() => {
      vi.advanceTimersByTime(16 * 20)
    })

    expect(lastRendered()).toBe('brand new answer tail')
  })

  it('renders the paused label for an empty paused block', () => {
    render(<Markdown block={makeBlock('block-1', '', MessageBlockStatus.PAUSED)} />)
    expect(screen.getByTestId('markdown-children')).toHaveTextContent('message.chat.completion.paused')
  })

  it('does not fire a parse commit within the first 50ms cadence window', () => {
    const { rerender } = render(<Markdown block={makeBlock('block-1', 'start', MessageBlockStatus.STREAMING)} />)
    const countAtMount = md.children.length

    // Stream a delta; the cadence effect should schedule a trailing timer, not
    // an immediate parse commit, because elapsed < 50ms.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'start delta', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(40)
    })

    // No parse commit should have fired inside the 50ms cadence window.
    expect(md.children.length).toBe(countAtMount)

    // After the full 50ms cadence window, the trailing timer fires and a
    // parse commit is scheduled. Let enough time pass for both the cadence
    // timer to fire and the smooth stream to fully drain, then verify the
    // rendered text matches the latest streamed content.
    act(() => {
      vi.advanceTimersByTime(20)
    })
    // Allow transition flush.
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(md.children.length).toBeGreaterThan(countAtMount)

    // Advance further so the smooth stream fully drains remaining queued text.
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(lastRendered()).toBe('start delta')
  })

  it('preserves paused content and prevents stale timer overwrite, then resumes correctly', () => {
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'streaming content', MessageBlockStatus.STREAMING)} />
    )
    md.children.length = 0

    // Stream within the <50ms cadence window so the trailing timer is pending
    // but has not yet fired.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'streaming content extra', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(30)
    })

    // Pause the stream. This sets isStreamDone=true, which causes the cadence
    // effect to flush block.content as the authoritative final text and arms
    // the completion guard against stale trailing timers.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'streaming content extra', MessageBlockStatus.PAUSED)} />)
    })
    act(() => {
      vi.advanceTimersByTime(0)
    })

    // The paused content must be the latest block content, not stale
    // mid-stream text from the smooth stream queue.
    const pausedContent = lastRendered()
    expect(pausedContent).toBe('streaming content extra')

    // Fire any surviving trailing timers — the completion guard must refuse
    // to overwrite the paused content with stale text.
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(lastRendered()).toBe('streaming content extra')

    // Resume streaming with appended content. The delta is computed from the
    // previous block content and fed into the smooth stream.
    act(() => {
      rerender(
        <Markdown block={makeBlock('block-1', 'streaming content extra resumed', MessageBlockStatus.STREAMING)} />
      )
    })

    // Let the cadence timer fire and transition flush so the new content is
    // committed to the parsed content state.
    act(() => {
      vi.advanceTimersByTime(60)
    })
    act(() => {
      vi.advanceTimersByTime(0)
    })

    // Complete the resumed stream and flush final content.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'streaming content extra resumed', MessageBlockStatus.SUCCESS)} />)
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })

    // The final rendered text must be the resumed content, not the earlier
    // paused content overwritten by a stale timer.
    expect(lastRendered()).toBe('streaming content extra resumed')
  })

  it('flushes exact final content when stream completes during a cadence window', () => {
    const { rerender } = render(<Markdown block={makeBlock('block-1', 'partial', MessageBlockStatus.STREAMING)} />)

    // Stream more content, then immediately complete — within <50ms of the
    // last content change. The trailing cadence timer is still pending.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'partial extended tail', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(30)
    })

    // Completion: the urgent final flush must render exact final content.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'partial extended tail', MessageBlockStatus.SUCCESS)} />)
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(lastRendered()).toBe('partial extended tail')

    // Fire any surviving trailing timers after completion — the guard must
    // refuse to overwrite the final content.
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(lastRendered()).toBe('partial extended tail')
  })
})
