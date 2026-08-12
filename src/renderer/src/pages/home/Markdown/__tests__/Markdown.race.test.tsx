import 'katex/dist/katex.min.css'

import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Markdown from '../Markdown'

/**
 * LOCK-001 race regression test for Markdown streaming cadence.
 *
 * The cadence path schedules parsed-content commits as non-urgent transitions.
 * If a transition captures the text at SCHEDULE time, an older pending
 * transition can commit after the urgent final flush and overwrite the exact
 * final content with stale mid-stream text. The fixed schedule reads the
 * latest authoritative ref at COMMIT time.
 *
 * Deterministic test seam: `scheduleParsedContentCommit` is stubbed to capture
 * every scheduled commit (setter + readLatest closure) WITHOUT executing it,
 * so a stale pending transition can be replayed after completion and proven
 * unable to truncate the final content.
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
  processLatexBrackets: vi.fn((str: string) => str)
}))

// LOCK-001 race seam: capture scheduled parsed-content commits and defer them.
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

describe('Markdown streaming cadence race (LOCK-001)', () => {
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
    // immediate (>=150ms elapsed) path instead of the trailing-timer path —
    // mirroring the real app where performance.now() is wall-clock. The queue
    // is empty at mount, so no content is drained by this advance.
    act(() => {
      vi.advanceTimersByTime(200)
    })

    // Stream commits while still streaming: the cadence effect schedules
    // deferred parsed-content commits carrying mid-stream text (shorter than
    // the final content). Only a few frames elapse so the tail is still
    // draining — completion must arrive BEFORE the drain so the urgent final
    // flush is the flush under test (a fully drained stream would make the
    // ref-equal guard skip it).
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(16 * 2)
    })

    // A stale pending transition must actually have been scheduled while
    // streaming — otherwise this test proves nothing.
    expect(deferred.scheduled.length).toBeGreaterThan(0)

    // Completion: the urgent final flush renders the exact final content.
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} />)
    })
    act(() => {
      vi.advanceTimersByTime(16 * 20)
    })
    expect(lastRendered()).toBe(finalContent)

    // Replay every deferred cadence transition AFTER the urgent final flush.
    // Each functional updater reads the latest authoritative ref at commit
    // time, so none may overwrite the exact final content (LOCK-001).
    const pending = deferred.scheduled.splice(0)
    act(() => {
      for (const { set, read } of pending) {
        set(() => read())
      }
    })
    expect(lastRendered()).toBe(finalContent)
  })

  it('trailing timer that fires after completion cannot overwrite the authoritative ref/content', () => {
    const finalContent = 'alpha beta gamma delta epsilon zeta'
    const partial = 'alpha beta gamma'

    const { rerender } = render(<Markdown block={makeBlock('block-1', partial, MessageBlockStatus.STREAMING)} />)

    // Stream more content and let the smooth stream drain partially so a
    // TRAILING cadence timer is pending (elapsed < 150ms at the drain). The
    // setTimeout spy proves the trailing-timer path was actually taken —
    // otherwise this test would be vacuous.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', partial + ' delta', MessageBlockStatus.STREAMING)} />)
    })
    act(() => {
      vi.advanceTimersByTime(48)
    })
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    setTimeoutSpy.mockRestore()

    // No parsed-content transition has been scheduled yet (the trailing timer
    // has not fired while streaming).
    expect(deferred.scheduled.length).toBe(0)

    // Stub clearTimeout so the completion render's effect cleanup cannot
    // cancel the pending trailing timer — simulating the theoretical case the
    // completion guard defends against: a trailing timer firing AFTER the
    // stream completed.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    act(() => {
      rerender(<Markdown block={makeBlock('block-1', finalContent, MessageBlockStatus.SUCCESS)} />)
    })
    clearTimeoutSpy.mockRestore()

    // The urgent final flush rendered the exact final content.
    expect(lastRendered()).toBe(finalContent)

    // Fire the surviving trailing timer(s) AFTER completion. The guard must
    // refuse to write the stale trailing text into the authoritative ref and
    // refuse to schedule a parsed-content transition from it.
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(deferred.scheduled.length).toBe(0)
    expect(lastRendered()).toBe(finalContent)
  })
})
