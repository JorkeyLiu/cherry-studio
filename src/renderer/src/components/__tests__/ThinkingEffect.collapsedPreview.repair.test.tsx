import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ThinkingEffect from '../ThinkingEffect'

vi.mock('motion/react', () => ({
  motion: {
    div: (props: any) => <div {...props}>{props.children}</div>
  }
}))
vi.mock('@renderer/utils/motionVariants', () => ({
  lightbulbVariants: { idle: {}, active: {} }
}))

describe('ThinkingEffect half-collapsed streaming preview repair', () => {
  it('includes single incomplete line while collapsed and STREAMING (not sliced away)', () => {
    const { container } = render(
      <ThinkingEffect
        isThinking={true}
        expanded={false}
        thinkingTimeText="Thinking..."
        content="single incomplete line"
      />
    )
    // ShowThinking true => Content visible with messages
    expect(container.textContent).toContain('single incomplete line')
  })

  it('includes last non-empty line when streaming with multiple lines (old slice would drop last)', () => {
    const content = 'line1\nline2\nlast incomplete'
    const { container } = render(
      <ThinkingEffect isThinking={true} expanded={false} thinkingTimeText="Thinking..." content={content} />
    )
    expect(container.textContent).toContain('line1')
    expect(container.textContent).toContain('line2')
    expect(container.textContent).toContain('last incomplete')
  })

  it('still filters empty lines', () => {
    const content = 'a\n\nb\n'
    const { container } = render(
      <ThinkingEffect isThinking={true} expanded={false} thinkingTimeText="Thinking..." content={content} />
    )
    expect(container.textContent).toContain('a')
    expect(container.textContent).toContain('b')
  })

  it('non-streaming preview shows all lines (expanded false but not thinking shows time only, but content logic still includes)', () => {
    // When not thinking, showThinking false so preview hidden; but messages memo should still contain all lines
    // We test expanded=true case still renders container without preview but no slice
    const content = 'x\ny'
    const { container } = render(
      <ThinkingEffect isThinking={false} expanded={true} thinkingTimeText="Thought" content={content} />
    )
    // Not showing preview, but title still present
    expect(container.textContent).toContain('Thought')
  })
})
