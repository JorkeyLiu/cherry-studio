import type { MainTextMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { MathRuntime } from '../mathLoader'

describe('mathLoader mhchem activation (S7.6)', () => {
  it('mhchem evaluated before rehype-katex shares same katex singleton proven by \\ce rendering', async () => {
    vi.resetModules()
    const { loadMathRuntime } = await import('../mathLoader')
    const runtime = await loadMathRuntime()
    expect(runtime.remarkMath).toBeDefined()
    expect(runtime.rehypeKatex).toBeDefined()

    const katex = (await import('katex')).default
    const output = katex.renderToString('\\ce{H2O}', { throwOnError: false })
    expect(output).toContain('katex')
    expect(output).toContain('katex-html')
    expect(output).not.toContain('katex-error')
    expect(output).toMatch(/H.*2.*O/)
  })

  it('fenced ```math block renders through real remark-math + rehype-katex to KaTeX display (S7.6)', async () => {
    vi.resetModules()

    vi.doMock('../mathLoader', () => ({
      loadMathRuntime: vi.fn(async () => {
        const remarkMathMod = await import('remark-math')
        const rehypeKatexMod = await import('rehype-katex')
        const remarkMath = (remarkMathMod as { default?: unknown }).default ?? (remarkMathMod as unknown)
        const rehypeKatex = (rehypeKatexMod as { default?: unknown }).default ?? (rehypeKatexMod as unknown)
        return {
          remarkMath: remarkMath as MathRuntime['remarkMath'],
          rehypeKatex: rehypeKatex as MathRuntime['rehypeKatex']
        }
      })
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
    vi.doMock('@renderer/utils/formats', () => ({
      removeSvgEmptyLines: (str: string) => str
    }))
    vi.doMock('@renderer/utils/markdown', () => ({
      processLatexBrackets: (str: string) => str
    }))
    vi.doMock('react-i18next', () => ({
      useTranslation: () => ({ t: (key: string) => key }),
      initReactI18next: { type: '3rdParty', init: vi.fn() }
    }))

    const { default: Markdown } = await import('../Markdown')

    const block: MainTextMessageBlock = {
      id: 'b1',
      messageId: 'msg-1',
      type: MessageBlockType.MAIN_TEXT,
      status: MessageBlockStatus.SUCCESS,
      createdAt: new Date().toISOString(),
      content: '```math\nx^2\n```'
    }

    const { container } = render(createElement(Markdown, { block }))

    await waitFor(() => {
      const display = container.querySelector('.katex-display')
      expect(display).not.toBeNull()
      expect(display).toBeInTheDocument()
    })

    const display = container.querySelector('.katex-display')
    expect(display).not.toBeNull()
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.innerHTML).toContain('katex')
    expect(container.textContent).not.toContain('```math')
    expect(display?.textContent).toContain('x')
  })
})
