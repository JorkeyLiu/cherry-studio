import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { normalizeAttachedBlockMathClose } from '@renderer/utils/markdown'
import { render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { describe, expect, it, vi } from 'vitest'

import type { MathRuntime } from '../mathLoader'

const ATTACHED = '$$\n\\begin{aligned}\na &= 1 \\\\\nb &= 2\n\\end{aligned}$$\n\nFollow-up with **boldCheck** prose.'

// Exact mock-echo assistant shape: the opener shares its line with the
// `[Mock mock-model] You said: "` prefix, so it is inline prose —
// normalization must leave it byte-identical.
const WRAPPED = '[Mock mock-model] You said: "$$\n\\begin{aligned}\na&=1\n\\end{aligned}$$\n\nok **b7**"'

function parseMath(markdown: string) {
  return unified().use(remarkParse).use(remarkMath, { singleDollarTextMath: true }).parse(markdown)
}

function collectMathValues(tree: unknown): string[] {
  const values: string[] = []
  visit(tree as never, 'math', (node: unknown) => {
    values.push((node as { value?: string }).value ?? '')
  })
  return values
}

function hasStrongWith(tree: unknown, text: string): boolean {
  let found = false
  visit(tree as never, 'strong', (node: unknown) => {
    const kids = (node as { children?: Array<{ value?: string }> }).children ?? []
    if (kids.some((child) => child.value?.includes(text))) found = true
  })
  return found
}

describe('attached block-math close (screenshot regression)', () => {
  it('proves the mechanism: raw attached close parses as one math node swallowing the close and trailing prose', () => {
    // Same production remark-math 6 options the home Markdown uses
    // ({ singleDollarTextMath: true }); mdast-level only, no HTML bridge needed.
    const tree = parseMath(ATTACHED)
    const values = collectMathValues(tree)
    expect(values).toHaveLength(1)
    // The single math node value includes the closing $$ and the trailing paragraph,
    // so rehype-katex wraps it all in one red span.katex-error (#cc0000).
    expect(values[0]).toContain('\\end{aligned}$$')
    expect(values[0]).toContain('boldCheck')
    expect(hasStrongWith(tree, 'boldCheck')).toBe(false)
  })

  it('normalized attached close parses as bounded math plus an isolated strong paragraph', () => {
    const tree = parseMath(normalizeAttachedBlockMathClose(ATTACHED))
    const values = collectMathValues(tree)
    expect(values).toHaveLength(1)
    expect(values[0]).not.toContain('$$')
    expect(values[0]).not.toContain('boldCheck')
    expect(values[0]).toContain('\\end{aligned}')
    expect(hasStrongWith(tree, 'boldCheck')).toBe(true)
  })

  it('mock-prefixed inline $$ is left untouched and keeps strong prose outside math', () => {
    expect(normalizeAttachedBlockMathClose(WRAPPED)).toBe(WRAPPED)
    const tree = parseMath(WRAPPED)
    const values = collectMathValues(tree)
    expect(values.every((value) => !value.includes('b7'))).toBe(true)
    expect(hasStrongWith(tree, 'b7')).toBe(true)
  })

  it('indented code lines with $$ are preserved byte-identical', () => {
    const indented = '    $$\n    a\n    b$$\n\ntail **indentedB**'
    expect(normalizeAttachedBlockMathClose(indented)).toBe(indented)
    const tree = parseMath(indented)
    expect(hasStrongWith(tree, 'indentedB')).toBe(true)
  })

  it('home Markdown renders attached-close formula with trailing bold outside katex-error', async () => {
    vi.resetModules()

    vi.doMock('../mathLoader', () => ({
      loadMathRuntime: vi.fn(async () => ({
        remarkMath: remarkMath as unknown as MathRuntime['remarkMath'],
        rehypeKatex: rehypeKatex as unknown as MathRuntime['rehypeKatex']
      }))
    }))

    vi.doMock('@logger', () => ({
      loggerService: {
        withContext: () => ({
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn()
        })
      }
    }))

    vi.doMock('../CodeBlock', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../Link', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../Table', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../MarkdownSvgRenderer', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('@renderer/components/ImageViewer', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('@renderer/components/MarkdownShadowDOMRenderer', () => ({
      __esModule: true,
      default: () => null
    }))
    // NOTE: '@renderer/utils/markdown' is intentionally NOT mocked here so the
    // real normalizeAttachedBlockMathClose preprocessing runs in this test.
    vi.doMock('react-i18next', () => ({
      useTranslation: () => ({ t: (key: string) => key }),
      initReactI18next: { type: '3rdParty', init: vi.fn() }
    }))

    const { default: Markdown } = await import('../Markdown')

    const block: MainTextMessageBlock = {
      id: 'b-attached',
      messageId: 'msg-1',
      type: MessageBlockType.MAIN_TEXT,
      status: MessageBlockStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      content: ATTACHED
    }

    const { container } = render(createElement(Markdown, { block }))

    await waitFor(() => {
      expect(container.querySelector('.katex')).not.toBeNull()
    })

    const strong = container.querySelector('.markdown strong')
    expect(strong).not.toBeNull()
    expect(strong?.textContent).toBe('boldCheck')
    expect(strong?.closest('.katex-error')).toBeNull()
    // The whole message must not be swallowed into a single error span.
    const errors = [...container.querySelectorAll('.katex-error')]
    expect(errors.every((el) => !el.textContent?.includes('boldCheck'))).toBe(true)
  })

  it('home Markdown keeps already-bounded math and code/escape protection intact', async () => {
    vi.resetModules()

    vi.doMock('../mathLoader', () => ({
      loadMathRuntime: vi.fn(async () => ({
        remarkMath: remarkMath as unknown as MathRuntime['remarkMath'],
        rehypeKatex: rehypeKatex as unknown as MathRuntime['rehypeKatex']
      }))
    }))

    vi.doMock('@logger', () => ({
      loggerService: {
        withContext: () => ({
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn()
        })
      }
    }))

    vi.doMock('../CodeBlock', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../Link', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../Table', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../MarkdownSvgRenderer', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('@renderer/components/ImageViewer', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('@renderer/components/MarkdownShadowDOMRenderer', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('react-i18next', () => ({
      useTranslation: () => ({ t: (key: string) => key }),
      initReactI18next: { type: '3rdParty', init: vi.fn() }
    }))

    const { default: Markdown } = await import('../Markdown')

    // 1. Already-bounded valid math renders cleanly with trailing strong prose.
    const bounded: MainTextMessageBlock = {
      id: 'b-bounded',
      messageId: 'msg-1',
      type: MessageBlockType.MAIN_TEXT,
      status: MessageBlockStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      content: '$$\nx^2\n$$\n\ntrailing **okBounded**'
    }
    const r1 = render(createElement(Markdown, { block: bounded }))
    await waitFor(() => {
      expect(r1.container.querySelector('.katex')).not.toBeNull()
    })
    expect(r1.container.querySelector('.katex-error')).toBeNull()
    expect(r1.container.querySelector('.markdown strong')?.textContent).toBe('okBounded')
    r1.unmount()

    // 2. Math-looking text inside fenced code stays code, trailing prose stays prose.
    const coded: MainTextMessageBlock = {
      id: 'b-coded',
      messageId: 'msg-1',
      type: MessageBlockType.MAIN_TEXT,
      status: MessageBlockStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      content: '```\n\\end{aligned}$$\n```\n\ntail **okCode**'
    }
    const r2 = render(createElement(Markdown, { block: coded }))
    await waitFor(() => {
      expect(r2.container.querySelector('.markdown strong')?.textContent).toBe('okCode')
    })
    expect(r2.container.querySelector('.katex-error')).toBeNull()
    r2.unmount()

    // 3. Malformed-but-explicitly-closed formula still errors, confined to the formula.
    const malformed: MainTextMessageBlock = {
      id: 'b-malformed',
      messageId: 'msg-1',
      type: MessageBlockType.MAIN_TEXT,
      status: MessageBlockStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      content: '$$\n\\badcommand{oops}\n\\end{aligned}$$\n\ntrailing **okMalformed**'
    }
    const r3 = render(createElement(Markdown, { block: malformed }))
    await waitFor(() => {
      expect(r3.container.querySelector('.katex-error')).not.toBeNull()
    })
    const strongMalformed = r3.container.querySelector('.markdown strong')
    expect(strongMalformed?.textContent).toBe('okMalformed')
    expect(strongMalformed?.closest('.katex-error')).toBeNull()
    r3.unmount()
  })

  it('home Markdown keeps mock-prefixed echo prose intact with strong outside math', async () => {
    vi.resetModules()

    vi.doMock('../mathLoader', () => ({
      loadMathRuntime: vi.fn(async () => ({
        remarkMath: remarkMath as unknown as MathRuntime['remarkMath'],
        rehypeKatex: rehypeKatex as unknown as MathRuntime['rehypeKatex']
      }))
    }))

    vi.doMock('@logger', () => ({
      loggerService: {
        withContext: () => ({
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn()
        })
      }
    }))

    vi.doMock('../CodeBlock', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../Link', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../Table', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('../MarkdownSvgRenderer', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('@renderer/components/ImageViewer', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('@renderer/components/MarkdownShadowDOMRenderer', () => ({
      __esModule: true,
      default: () => null
    }))
    vi.doMock('react-i18next', () => ({
      useTranslation: () => ({ t: (key: string) => key }),
      initReactI18next: { type: '3rdParty', init: vi.fn() }
    }))

    const { default: Markdown } = await import('../Markdown')

    const block: MainTextMessageBlock = {
      id: 'b-wrapped',
      messageId: 'msg-1',
      type: MessageBlockType.MAIN_TEXT,
      status: MessageBlockStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      content: WRAPPED
    }

    const { container } = render(createElement(Markdown, { block }))

    await waitFor(() => {
      expect(container.querySelector('.markdown strong')?.textContent).toBe('b7')
    })
    const strong = container.querySelector('.markdown strong')
    expect(strong?.closest('.katex-error')).toBeNull()
    expect(strong?.closest('.katex')).toBeNull()
    const errors = [...container.querySelectorAll('.katex-error')]
    expect(errors.every((el) => !el.textContent?.includes('b7'))).toBe(true)
  })
})
