import type { ThinkingMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, screen } from '@testing-library/react'
import { Activity, useState } from 'react'
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
  id: 'tb-activity',
  messageId: 'm1',
  type: MessageBlockType.THINKING,
  status: MessageBlockStatus.STREAMING,
  createdAt: new Date().toISOString(),
  content: 'thinking content',
  thinking_millsec: 0,
  ...overrides
})

const parse = (s: string | null) => Number(s?.match(/(\d+\.\d)s/)?.[1] ?? 'NaN')

// The Chat session workspace keeps Home mounted inside React Activity while a
// secondary route is active. Activity preserves component state/refs but
// unmounts hidden-subtree effects (the ticking interval) and re-runs them on
// return. ThinkingTimeSeconds keeps its wall-clock anchor in a retained ref,
// so the restarted interval resumes elapsed time instead of restarting
// visually. This test proves that continuity with the real component: no
// Redux/persistence change, no timer adjustment.
describe('ThinkingBlock inside Activity hidden boundary — timer does not restart visually', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('elapsed time continues across hide/show instead of resetting', async () => {
    const Harness = () => {
      const [hidden, setHidden] = useState(false)
      return (
        <>
          <button data-testid="activity-toggle" onClick={() => setHidden((h) => !h)} />
          <Activity mode={hidden ? 'hidden' : 'visible'}>
            <ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 0 })} />
          </Activity>
        </>
      )
    }
    render(<Harness />)
    const timeEl = screen.getByTestId('thinking-time-text')
    expect(timeEl.textContent).toContain('0.0s')

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    const beforeHide = parse(timeEl.textContent)
    expect(beforeHide).toBeGreaterThanOrEqual(0.4)

    // Hide: Home subtree effects (the tick interval) clean up while state is retained.
    await act(async () => {
      screen.getByTestId('activity-toggle').click()
    })
    expect(timeEl).not.toBeVisible()

    // Wall-clock passes while hidden (stream execution continues outside UI).
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    // Show: effects reactivate; the retained anchor resumes elapsed time —
    // the display must include the hidden wall-clock interval, not merely
    // avoid restarting near zero. A frozen timer would read ~beforeHide (+0.1s
    // tick); continuity requires ~beforeHide + 5.0s hidden + 0.1s tick.
    await act(async () => {
      screen.getByTestId('activity-toggle').click()
    })
    expect(timeEl).toBeVisible()
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    const afterShow = parse(timeEl.textContent)
    expect(afterShow).toBeGreaterThanOrEqual(beforeHide + 5.0)
    expect(afterShow).toBeGreaterThanOrEqual(5.4)
  })
})
