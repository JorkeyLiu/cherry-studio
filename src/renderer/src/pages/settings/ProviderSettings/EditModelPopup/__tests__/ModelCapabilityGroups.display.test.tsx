import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ModelCapabilityGroups from '../ModelCapabilityGroups'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

vi.mock('antd', () => ({
  Flex: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

function entryWithAllKnown() {
  return {
    modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
    reasoning: true,
    toolCall: true,
    structuredOutput: false,
    temperature: true
  } as never
}

function entryWithAllSupported() {
  return {
    modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    temperature: true
  } as never
}

// CustomTag renders color/background via styled-components into document.head
// style tags (never into container.innerHTML), so color assertions must read
// the head stylesheet. Helpers below normalize case/whitespace and accept the
// exact rgb() equivalent when stylis/jsdom normalizes hex to rgb, without
// loosening semantics (full-token match only).
function getHeadStylesCompact(): string {
  return Array.from(document.head.querySelectorAll('style'))
    .map((el) => el.textContent ?? '')
    .join('\n')
    .toLowerCase()
    .replace(/\s+/g, '')
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16)
  ]
}

function containsHexColor(stylesCompact: string, hex: string): boolean {
  const token = hex.toLowerCase()
  // Trailing boundary: '#1677ff' must not match its own '#1677ff20' background.
  if (new RegExp(`${token}(?![0-9a-f])`).test(stylesCompact)) return true
  if (token.length === 7) {
    const [r, g, b] = hexToRgb(token)
    return stylesCompact.includes(`rgb(${r},${g},${b})`)
  }
  return false
}

function containsBackground20(stylesCompact: string, hex6: string): boolean {
  const token8 = `${hex6.toLowerCase()}20`
  if (stylesCompact.includes(token8)) return true
  const [r, g, b] = hexToRgb(hex6.toLowerCase())
  // 0x20/255 ~= 0.125: accept rgba() with 0.12* alpha or 12*% alpha.
  return new RegExp(`rgba\\(${r},${g},${b},(0\\.12\\d*|\\.12\\d*|12(\\.\\d+)?%)\\)`).test(stylesCompact)
}

describe('ModelCapabilityGroups display (unit 2)', () => {
  it('restores five input-modality colors with native titles and no antd tooltip', () => {
    const { container } = render(<ModelCapabilityGroups entry={entryWithAllKnown()} />)
    for (const modality of ['text', 'image', 'audio', 'video', 'pdf']) {
      const wrapper = screen.getByTestId(`cap-modality-${modality}`)
      expect(wrapper.getAttribute('title')).toContain(': ')
    }
    expect(container.querySelectorAll('.ant-tooltip').length).toBe(0)
    expect(document.body.querySelectorAll('.ant-tooltip').length).toBe(0)
    // Five-color detail capsules: Text blue, Image green, Audio purple,
    // Video magenta, PDF orange-red (hex only, never a CSS var). CustomTag
    // writes color/background to head style tags, so assert there.
    const modalityStyles = getHeadStylesCompact()
    for (const color of ['#1677ff', '#00b96b', '#722ed1', '#eb2f96', '#fa541c']) {
      expect(containsHexColor(modalityStyles, color)).toBe(true)
    }
    // Text blue foreground plus its legal `color + '20'` background.
    expect(containsHexColor(modalityStyles, '#1677ff')).toBe(true)
    expect(containsBackground20(modalityStyles, '#1677ff')).toBe(true)
    expect(container.innerHTML.toLowerCase()).not.toContain('var(--color-text-2)')
    // CustomTag background stays legal: no CSS var passed to `color + '20'`.
    expect(modalityStyles).not.toContain('var(--color-text-2)')
    expect(modalityStyles).not.toContain('var(--color-text-2)20')
  })

  it('keeps four features mutually distinct with temperature off warning orange', () => {
    // Structured-output renders inactive gray when unsupported, so its feature
    // color only reaches the head stylesheet while supported. Render the
    // all-supported entry first for the four-color assertion, then rerender
    // the known entry to keep the unsupported data-state DOM assertion.
    const { rerender } = render(<ModelCapabilityGroups entry={entryWithAllSupported()} />)
    rerender(<ModelCapabilityGroups entry={entryWithAllKnown()} />)
    const featureStyles = getHeadStylesCompact()
    // Reasoning indigo, tool orange, structured cyan, temperature magenta.
    for (const color of ['#5b6cff', '#d9730d', '#08979c', '#eb2f96']) {
      expect(containsHexColor(featureStyles, color)).toBe(true)
    }
    // Never warning orange, in any normalized syntax.
    expect(featureStyles).not.toContain('#faad14')
    expect(featureStyles).not.toContain('250,173,20')
    // Unsupported stays inactive gray.
    expect(screen.getByTestId('cap-feature-structured-output')).toHaveAttribute('data-state', 'unsupported')
  })
})
