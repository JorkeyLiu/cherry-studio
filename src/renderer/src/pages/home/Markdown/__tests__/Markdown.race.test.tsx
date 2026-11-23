import 'katex/dist/katex.min.css'

import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Markdown, { MARKDOWN_PARSE_CADENCE_MS } from '../Markdown'

/**
 * Race regression tests for the Markdown streaming cadence.
 *
 * Cadence commits are scheduled as non-urgent transitions. If a transition
 * captured the text at SCHEDULE time, an older pending transition could commit
 * after an exact flush and overwrite it with stale text. The scheduler reads
 * the latest authoritative text at COMMIT time and every exact flush bumps a
 * generation token so stale timers are inert.
 *
 * Deterministic test seam: `scheduleParsedContentCommit` is stubbed to capture
 * every scheduled commit (setter + readLatest closure) WITHOUT executing it,
 * so a stale pending transition can be replayed after an exact flush and
 * proven unable to truncate it.
 */

// Recording ReactMarkdown mock: every rendered children value is captured so
// exact final content is observable.
const md = vi.hoisted(() => ({ children: [] as string[] }))

// Deferred-transition seam: scheduled commits are captured, not executed.
const deferred = vi.hoisted(() => ({
  scheduled: [] as Array<{ set: Dispatch<SetStateAction<string>>; read: () => string }>
}))

// Stable `t` like the real react-i18next hook.
const i18n = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: any) => {
    md.children.push(children)
    return <div data-testid="markdown-children">{children}</div>
  }
}))

// Component mocks kept lightweight like the existing streaming test.
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
  processLatexBrackets: vi.fn((str: string) => str),
  normalizeAttachedBlockMathClose: vi.fn((str: string) => str)
}))

// Race seam: capture scheduled parsed-content commits and defer them.
vi.mock('../parsedContentSchedule', () => ({
  __esModule: true,
  scheduleParsedContentCommit: vi.fn((set: Dispatch<SetStateAction<string>>, read: () => string) => {
    deferred.scheduled.push({ set, read })
  })
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

describe('Markdown streaming cadence races', () => {
  beforeEach(() => {
    md.children.length = 0
    deferred.scheduled.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('replays deferred cadence transitions after completion without truncating final content', () => {
    const finalContent = 'alpha beta gamma delta epsilon zeta'
    const partial = 'alpha beta gamma'

    const { rerender } = render(<Markdown block={makeBlock('block-1', partial, MessageBlockStatus.STREAMING)} />)
    // Nothing scheduled while the stream has not advanced.
    expect(deferred.scheduled.length).toBe(0)

    // Pre-advance the fake clock so the first cadence opportunity takes the
    // immediate (>= cadence window) path.
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 4)
    })

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.STREAMING)} />)
    })

    // A stale pending transition must actually have been scheduled while
    // streaming — otherwise this test proves nothing.
    expect(deferred.scheduled.length).toBeGreaterThan(0)

    // Completion: the exact flush renders the final content.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} />)
    })
    expect(lastRendered()).toBe(finalContent)

    // Replay every deferred cadence transition AFTER the exact flush. Each
    // functional updater reads the latest authoritative text at commit time,
    // so none may overwrite the exact final content.
    const pending = deferred.scheduled.splice(0)
    act(() => {
      for (const { set, read } of pending) {
        set(() => read())
      }
    })
    expect(lastRendered()).toBe(finalContent)
  })

  it('a trailing timer that fires after completion cannot overwrite the final content', () => {
    const finalContent = 'alpha beta gamma delta epsilon zeta'
    const partial = 'alpha beta gamma'

    const { rerender } = render(<Markdown block={makeBlock('block-1', partial, MessageBlockStatus.STREAMING)} />)

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', `${partial} delta`, MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS - 2)
    })
    // The trailing-timer path was actually taken.
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    setTimeoutSpy.mockRestore()

    // No parsed-content transition has been planned yet (the trailing timer
    // has not fired while streaming).
    expect(deferred.scheduled.length).toBe(0)

    // Stub clearTimeout so the completion render's cleanup cannot cancel the
    // pending trailing timer: the generation guard alone must keep it inert.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} />)
    })
    clearTimeoutSpy.mockRestore()

    expect(lastRendered()).toBe(finalContent)

    // Fire the surviving trailing timer(s) AFTER completion.
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })
    expect(deferred.scheduled.length).toBe(0)
    expect(lastRendered()).toBe(finalContent)
  })

  it('a surviving trailing timer cannot overwrite a same-id non-prefix rewrite', () => {
    const { rerender } = render(<Markdown block={makeBlock('block-1', 'alpha', MessageBlockStatus.STREAMING)} />)

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'alpha beta', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(16)
    })

    // The rewrite flushes exactly and bumps the generation. Let the old timer
    // survive to prove the generation guard, not cancellation, is enough.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'brand new answer', MessageBlockStatus.STREAMING)} />)
    })
    clearTimeoutSpy.mockRestore()

    expect(lastRendered()).toBe('brand new answer')

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })
    expect(deferred.scheduled.length).toBe(0)
    expect(lastRendered()).toBe('brand new answer')
  })

  it('a stale scheduled transition cannot overwrite the content of a switched block', () => {
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'block one alpha', MessageBlockStatus.STREAMING)} />
    )

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 4)
    })
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'block one alpha beta', MessageBlockStatus.STREAMING)} />)
    })
    expect(deferred.scheduled.length).toBeGreaterThan(0)

    act(() => {
      rerender(<Markdown block={makeBlock('block-2', 'block two content', MessageBlockStatus.SUCCESS)} />)
    })
    expect(lastRendered()).toBe('block two content')

    const pending = deferred.scheduled.splice(0)
    act(() => {
      for (const { set, read } of pending) {
        set(() => read())
      }
    })
    expect(lastRendered()).toBe('block two content')
  })

  it('unmount clears pending cadence work and schedules no further parse', () => {
    const processText = vi.fn((text: string) => text)
    const { rerender, unmount } = render(
      <Markdown block={makeBlock('block-1', 'a', MessageBlockStatus.STREAMING)} postProcess={processText} />
    )

    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'a b', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(10)
    })
    const callsBeforeUnmount = processText.mock.calls.length

    // Simulate a timer that survives cleanup: only the generation bump can
    // keep it inert after unmount.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    unmount()
    clearTimeoutSpy.mockRestore()

    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })

    expect(processText.mock.calls.length).toBe(callsBeforeUnmount)
    expect(deferred.scheduled.length).toBe(0)
  })

  it('a callback-change trailing reprocess cannot overwrite exact final content', () => {
    const cb1 = (text: string) => `v1|${text}`
    const cb2 = (text: string) => `v2|${text}`
    const cb3 = (text: string) => `v3|${text}`
    const { rerender } = render(
      <Markdown block={makeBlock('block-1', 'alpha', MessageBlockStatus.STREAMING)} postProcess={cb1} />
    )
    expect(lastRendered()).toBe('v1|alpha')

    // Open the cadence window so the next streaming advance plans immediately.
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 2)
    })

    // Streaming advance: a deferred commit is scheduled (still pending).
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'alpha beta', MessageBlockStatus.STREAMING)} postProcess={cb2} />)
    })
    expect(deferred.scheduled.length).toBe(1)

    // Callback-only change while streaming: no exact path, no second deferred
    // commit — it only marks trailing reprocessing.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'alpha beta', MessageBlockStatus.STREAMING)} postProcess={cb3} />)
    })
    expect(deferred.scheduled.length).toBe(1)

    // Completion with an unchanged raw text: exact flush, and because the last
    // published text came from cb2 it must be re-processed with cb3.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', 'alpha beta', MessageBlockStatus.SUCCESS)} postProcess={cb3} />)
    })
    clearTimeoutSpy.mockRestore()
    expect(lastRendered()).toBe('v3|alpha beta')

    // Replaying the pending deferred commit cannot roll the text back.
    const pending = deferred.scheduled.splice(0)
    act(() => {
      for (const { set, read } of pending) {
        set(() => read())
      }
    })
    expect(lastRendered()).toBe('v3|alpha beta')

    // A surviving cadence timer is generation-inert after the exact flush.
    act(() => {
      vi.advanceTimersByTime(MARKDOWN_PARSE_CADENCE_MS * 10)
    })
    expect(lastRendered()).toBe('v3|alpha beta')
    expect(deferred.scheduled.length).toBe(0)
  })
})
