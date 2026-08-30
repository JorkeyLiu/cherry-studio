import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../CodeBlock', () => ({ __esModule: true, default: () => null }))
vi.mock('../Link', () => ({ __esModule: true, default: () => null }))
vi.mock('../Table', () => ({ __esModule: true, default: () => null }))
vi.mock('../MarkdownSvgRenderer', () => ({ __esModule: true, default: () => null }))
vi.mock('@renderer/components/ImageViewer', () => ({ __esModule: true, default: () => null }))
vi.mock('@renderer/components/MarkdownShadowDOMRenderer', () => ({ __esModule: true, default: () => null }))

const makeBlock = (id: string, content: string): MainTextMessageBlock => ({
  id,
  messageId: 'msg-1',
  type: MessageBlockType.MAIN_TEXT,
  status: MessageBlockStatus.SUCCESS,
  createdAt: new Date().toISOString(),
  content
})

describe('Markdown caller-level lazy boundary (S7.6)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('importing Markdown and rendering ordinary Markdown does not evaluate any math factories', async () => {
    let cssCount = 0
    let copyCount = 0
    let mhchemCount = 0
    let remarkCount = 0
    let rehypeCount = 0

    vi.doMock('katex/dist/katex.min.css', () => {
      cssCount += 1
      return {}
    })
    vi.doMock('katex/dist/contrib/copy-tex', () => {
      copyCount += 1
      return {}
    })
    vi.doMock('katex/dist/contrib/mhchem', () => {
      mhchemCount += 1
      return {}
    })
    vi.doMock('remark-math', () => {
      remarkCount += 1
      return { __esModule: true, default: vi.fn(() => (tree: unknown) => tree) }
    })
    vi.doMock('rehype-katex', () => {
      rehypeCount += 1
      return { __esModule: true, default: vi.fn(() => (tree: unknown) => tree) }
    })

    const { default: Markdown } = await import('../Markdown')

    expect(cssCount).toBe(0)
    expect(copyCount).toBe(0)
    expect(mhchemCount).toBe(0)
    expect(remarkCount).toBe(0)
    expect(rehypeCount).toBe(0)

    render(<Markdown block={makeBlock('b1', 'Hello **bold** ordinary text no math')} />)

    await waitFor(() => expect(cssCount).toBe(0), { timeout: 200 })
    expect(copyCount).toBe(0)
    expect(mhchemCount).toBe(0)
    expect(remarkCount).toBe(0)
    expect(rehypeCount).toBe(0)
  })

  it('qualifying math evaluates all five factories via actual Markdown path', async () => {
    let cssCount = 0
    let copyCount = 0
    let mhchemCount = 0
    let remarkCount = 0
    let rehypeCount = 0
    const order: string[] = []

    vi.doMock('katex/dist/katex.min.css', () => {
      cssCount += 1
      order.push('css')
      return {}
    })
    vi.doMock('katex/dist/contrib/copy-tex', () => {
      copyCount += 1
      order.push('copy')
      return {}
    })
    vi.doMock('katex/dist/contrib/mhchem', () => {
      mhchemCount += 1
      order.push('mhchem')
      return {}
    })
    vi.doMock('remark-math', () => {
      remarkCount += 1
      order.push('remark')
      return { __esModule: true, default: vi.fn(() => (tree: unknown) => tree) }
    })
    vi.doMock('rehype-katex', () => {
      rehypeCount += 1
      order.push('rehype')
      return { __esModule: true, default: vi.fn(() => (tree: unknown) => tree) }
    })

    const { default: Markdown } = await import('../Markdown')

    render(<Markdown block={makeBlock('b1', 'Euler $e^{i\\pi}$ qualifies')} />)

    await waitFor(() => expect(cssCount).toBe(1))
    expect(copyCount).toBe(1)
    expect(mhchemCount).toBe(1)
    expect(remarkCount).toBe(1)
    expect(rehypeCount).toBe(1)
    expect(order).toEqual(['css', 'copy', 'mhchem', 'remark', 'rehype'])
  })

  it('fenced ```math qualifies via actual path, inline code does not', async () => {
    let remarkCount = 0
    vi.doMock('katex/dist/katex.min.css', () => ({}))
    vi.doMock('katex/dist/contrib/copy-tex', () => ({}))
    vi.doMock('katex/dist/contrib/mhchem', () => ({}))
    vi.doMock('remark-math', () => {
      remarkCount += 1
      return { __esModule: true, default: vi.fn(() => (tree: unknown) => tree) }
    })
    vi.doMock('rehype-katex', () => ({ __esModule: true, default: vi.fn(() => (tree: unknown) => tree) }))

    const { default: Markdown } = await import('../Markdown')
    render(<Markdown block={makeBlock('b1', '`$x$` inline code should not load')} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(remarkCount).toBe(0)

    vi.resetModules()
    let remarkCount2 = 0
    vi.doMock('katex/dist/katex.min.css', () => ({}))
    vi.doMock('katex/dist/contrib/copy-tex', () => ({}))
    vi.doMock('katex/dist/contrib/mhchem', () => ({}))
    vi.doMock('remark-math', () => {
      remarkCount2 += 1
      return { __esModule: true, default: vi.fn(() => (tree: unknown) => tree) }
    })
    vi.doMock('rehype-katex', () => ({ __esModule: true, default: vi.fn(() => (tree: unknown) => tree) }))
    const { default: Markdown2 } = await import('../Markdown')
    render(<Markdown2 block={makeBlock('b2', '```math\nx\n``` fenced math qualifies')} />)
    await waitFor(() => expect(remarkCount2).toBeGreaterThanOrEqual(1))
  })

  it('concurrent qualifying instances share single ordered evaluation of all five factories via actual mathLoader', async () => {
    const order: string[] = []
    let cssCount = 0
    let copyCount = 0
    let mhchemCount = 0
    let remarkCount = 0
    let rehypeCount = 0

    const createDeferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>((res) => {
        resolve = res
      })
      return { promise, resolve }
    }
    const cssDef = createDeferred()
    const copyDef = createDeferred()
    const mhchemDef = createDeferred()
    const remarkDef = createDeferred()
    const rehypeDef = createDeferred()

    const capture: { calls: Array<{ remarkPlugins: unknown[]; rehypePlugins: unknown[]; children: string }> } = {
      calls: []
    }
    const fakeRemarkMath = vi.fn(() => (tree: unknown) => tree)
    const fakeRehypeKatex = vi.fn(() => (tree: unknown) => tree)

    vi.doMock('katex/dist/katex.min.css', async () => {
      cssCount += 1
      order.push('css')
      await cssDef.promise
      return {}
    })
    vi.doMock('katex/dist/contrib/copy-tex', async () => {
      copyCount += 1
      order.push('copy')
      await copyDef.promise
      return {}
    })
    vi.doMock('katex/dist/contrib/mhchem', async () => {
      mhchemCount += 1
      order.push('mhchem')
      await mhchemDef.promise
      return {}
    })
    vi.doMock('remark-math', async () => {
      remarkCount += 1
      order.push('remark')
      await remarkDef.promise
      return { __esModule: true, default: fakeRemarkMath }
    })
    vi.doMock('rehype-katex', async () => {
      rehypeCount += 1
      order.push('rehype')
      await rehypeDef.promise
      return { __esModule: true, default: fakeRehypeKatex }
    })

    vi.doMock('react-markdown', () => ({
      __esModule: true,
      default: ({ children, remarkPlugins, rehypePlugins }: any) => {
        capture.calls.push({ remarkPlugins: remarkPlugins || [], rehypePlugins: rehypePlugins || [], children })
        const React = require('react')
        return React.createElement('div', { 'data-testid': 'markdown-children' }, children)
      }
    }))

    const { default: Markdown } = await import('../Markdown')

    render(
      <div>
        <Markdown block={makeBlock('b1', 'Euler $a$ concurrent one')} />
        <Markdown block={makeBlock('b2', 'Euler $b$ concurrent two')} />
      </div>
    )

    // Allow effects to run and loader to start (css factory should have been invoked, others pending)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(cssCount).toBe(1)
    // Copy may not yet have been invoked because css is still pending
    expect(copyCount).toBe(0)
    expect(mhchemCount).toBe(0)
    expect(remarkCount).toBe(0)
    expect(rehypeCount).toBe(0)

    // Resolve sequentially and verify ordered progression
    await act(async () => {
      cssDef.resolve()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(copyCount).toBe(1)
    expect(order).toEqual(['css', 'copy'])
    expect(mhchemCount).toBe(0)

    await act(async () => {
      copyDef.resolve()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(mhchemCount).toBe(1)
    expect(order).toEqual(['css', 'copy', 'mhchem'])

    await act(async () => {
      mhchemDef.resolve()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(remarkCount).toBe(1)
    expect(order).toEqual(['css', 'copy', 'mhchem', 'remark'])

    await act(async () => {
      remarkDef.resolve()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(rehypeCount).toBe(1)
    expect(order).toEqual(['css', 'copy', 'mhchem', 'remark', 'rehype'])

    await act(async () => {
      rehypeDef.resolve()
      await new Promise((r) => setTimeout(r, 30))
    })

    // After all resolved, each factory evaluated exactly once despite two concurrent callers
    expect(cssCount).toBe(1)
    expect(copyCount).toBe(1)
    expect(mhchemCount).toBe(1)
    expect(remarkCount).toBe(1)
    expect(rehypeCount).toBe(1)
    expect(order).toEqual(['css', 'copy', 'mhchem', 'remark', 'rehype'])

    // Both callers must have received math plugins after resolution
    await waitFor(() => {
      const withMath = capture.calls.filter((c) =>
        c.remarkPlugins.some((p: any) => Array.isArray(p) && p[0] === fakeRemarkMath)
      )
      expect(withMath.length).toBeGreaterThanOrEqual(2)
    })

    await waitFor(() => {
      const withRehype = capture.calls.filter((c) => c.rehypePlugins.includes(fakeRehypeKatex))
      expect(withRehype.length).toBeGreaterThanOrEqual(2)
    })

    const lastTwo = capture.calls.slice(-2)
    expect(lastTwo.every((c) => c.rehypePlugins.includes(fakeRehypeKatex))).toBe(true)
  })
})
