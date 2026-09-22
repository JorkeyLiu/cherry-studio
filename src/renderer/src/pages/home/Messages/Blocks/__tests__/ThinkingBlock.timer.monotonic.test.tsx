import type { ThinkingMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ThinkingBlock from '../ThinkingBlock'

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ fontSize: 14, thoughtAutoCollapse: false })
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, p?: any) => {
      if (k === 'chat.thinking') return `Thinking... ${p?.seconds}s`
      if (k === 'chat.deeply_thought') return `Thought for ${p?.seconds}s`
      return k
    }
  })
}))
vi.mock('antd', () => ({
  Collapse: ({ activeKey, onChange, items }: any) => (
    <div>
      {items.map((item: any) => (
        <div key={item.key}>
          <div onClick={() => onChange()}>{item.label}</div>
          {activeKey === item.key && <div>{item.children}</div>}
        </div>
      ))}
    </div>
  ),
  Tooltip: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/pages/home/Markdown/Markdown', () => ({
  __esModule: true,
  default: ({ block }: any) => <div>Markdown: {block.content}</div>
}))
vi.mock('@renderer/components/ThinkingEffect', () => ({
  __esModule: true,
  default: ({ thinkingTimeText }: any) => <div data-testid="thinking-time-text">{thinkingTimeText}</div>
}))

const mk = (overrides: Partial<ThinkingMessageBlock> = {}): ThinkingMessageBlock => ({
  id: 'tb1',
  messageId: 'm1',
  type: MessageBlockType.THINKING,
  status: MessageBlockStatus.STREAMING,
  createdAt: new Date().toISOString(),
  content: 'thinking content',
  thinking_millsec: 0,
  ...overrides
})

describe('ThinkingBlock timer monotonic formatting (root repair)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows 0.0 initially then natural tenths 0.1,0.2,... before 1s (no artificial 0.1 minimum)', async () => {
    render(<ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 0 })} />)
    const timeEl = screen.getByTestId('thinking-time-text')
    expect(timeEl.textContent).toContain('0.0s')
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(timeEl.textContent).toContain('0.1s')
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(timeEl.textContent).toContain('0.2s')
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(timeEl.textContent).toContain('0.3s')
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(timeEl.textContent).toContain('0.5s')
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(timeEl.textContent).toContain('0.9s')
    const parse = (s: string | null) => Number(s?.match(/(\d+\.\d)s/)?.[1] ?? '0')
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(parse(timeEl.textContent)).toBeCloseTo(1.0, 1)
  })

  it('derives live elapsed from wall-clock anchor and absorbs authoritative monotonically', async () => {
    // authoritative per-chunk value 350 ms should be shown synchronously even before liveTick catches up
    const { rerender } = render(
      <ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 350 })} />
    )
    // synchronous derived max(350, anchoredElapsed) => 350 => 0.4? 350/1000=0.35 -> toFixed 0.4
    expect(screen.getByTestId('thinking-time-text').textContent).not.toContain('0.0s')
    expect(screen.getByTestId('thinking-time-text').textContent).toMatch(/0\.[34]s/)

    // wall-clock tick still advances beyond authoritative
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    // anchored 350+200=550 => 0.6 or authoritative still 350 => 0.4? Actually anchoredElapsed 550 => 0.6 dominates
    // With fake timers advancing 200, anchored 350+200=550 => 0.6
    expect(screen.getByTestId('thinking-time-text').textContent).toMatch(/0\.[56]s/)

    // authoritative jumps to 800 should be reflected synchronously without waiting for effect
    await act(async () => {
      rerender(<ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 800 })} />)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('0.8s')
  })

  it('wall-clock catch-up after simulated delayed interval — interval trigger only, no prev+100 drift', async () => {
    let fakeNow = 5000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow)
    render(<ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 0 })} />)
    const timeEl = screen.getByTestId('thinking-time-text')
    expect(timeEl.textContent).toContain('0.0s')
    fakeNow += 100
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(timeEl.textContent).toContain('0.1s')
    // stall: wall-clock jumps 900ms but interval only fires once more
    fakeNow += 900
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    // elapsed = 1000ms => 1.0s, not 0.2s
    expect(timeEl.textContent).toContain('1.0s')
    expect(timeEl.textContent).not.toContain('0.2s')
    nowSpy.mockRestore()
  })

  it('rapid authoritative rerenders do not reset anchor or interval', async () => {
    const { rerender } = render(
      <ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 0 })} />
    )
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('0.3s')
    const parse = (s: string | null) => Number(s?.match(/(\d+\.\d)s/)?.[1] ?? '0')
    const before = parse(screen.getByTestId('thinking-time-text').textContent)
    await act(async () => {
      for (let i = 1; i <= 10; i++) {
        rerender(<ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: i * 10 })} />)
      }
    })
    const afterRapid = parse(screen.getByTestId('thinking-time-text').textContent)
    // rapid small authoritative updates (max 100) must not reset wall-clock anchor (300ms => 0.3s)
    expect(afterRapid).toBeGreaterThanOrEqual(before)
    expect(afterRapid).toBeGreaterThan(0.2)
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    const afterTick = parse(screen.getByTestId('thinking-time-text').textContent)
    expect(afterTick).toBeGreaterThan(afterRapid)
  })

  it('first SUCCESS render shows persisted blockThinkingTime synchronously and freezes', async () => {
    const { rerender } = render(
      <ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 0 })} />
    )
    await act(async () => {
      vi.advanceTimersByTime(350)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toMatch(/0\.[34]s/)

    await act(async () => {
      rerender(<ThinkingBlock block={mk({ status: MessageBlockStatus.SUCCESS, thinking_millsec: 4567 })} />)
    })
    const firstSuccess = screen.getByTestId('thinking-time-text').textContent
    expect(firstSuccess).toContain('Thought for')
    expect(firstSuccess).toContain('4.6s')
    expect(firstSuccess).not.toContain('0.1s')
    expect(firstSuccess).not.toMatch(/0\.[34]s/)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toBe(firstSuccess)
  })

  it('direct SUCCESS mount without prior STREAMING renders persisted time immediately and freezes', async () => {
    render(<ThinkingBlock block={mk({ status: MessageBlockStatus.SUCCESS, thinking_millsec: 1234 })} />)
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('Thought for')
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('1.2s')
    expect(screen.getByTestId('thinking-time-text').textContent).not.toContain('0.0s')
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('1.2s')
  })

  it('STREAMING re-entry/remount anchors safely with empty shell', async () => {
    const { rerender, unmount } = render(
      <ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 0, content: '' })} />
    )
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('0.0s')
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    // after 150ms, should be 0.1 or 0.2? 150 -> 0.15 -> 0.2 or 0.1 depending on rounding? 0.15 toFixed 0.2? Actually 150/1000=0.15 -> 0.1? toFixed rounds 0.15->0.1 or 0.2? JS 0.15 toFixed 1 => 0.1? Let's assert >=0.1 and <0.3
    const t = screen.getByTestId('thinking-time-text').textContent
    expect(t).toMatch(/0\.[12]s/)
    await act(async () => {
      rerender(<ThinkingBlock block={mk({ status: MessageBlockStatus.SUCCESS, thinking_millsec: 800 })} />)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('0.8s')
    // re-enter STREAMING
    await act(async () => {
      rerender(<ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 0 })} />)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('0.0s')
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('0.1s')
    unmount()
    // fresh remount empty STREAMING shell
    render(
      <ThinkingBlock
        block={mk({ id: 'tb99', content: '', status: MessageBlockStatus.STREAMING, thinking_millsec: 0 })}
      />
    )
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('0.0s')
  })
})
