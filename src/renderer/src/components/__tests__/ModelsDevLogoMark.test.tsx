import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ModelsDevLogoMark } from '../Avatar/ModelsDevLogoMark'

// Real-style models.dev payload containing single quotes and parentheses:
// double-quoted `url("...")` inline masks survive them, while the old
// single-quoted styled `url('...')` injection broke and leaked the URL
// into the stylesheet.
const TRICKY_SRC =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d=\"M12 (2) C6.5 (2) 2 (6.5) 2 (12)'test'\" fill='black'/></svg>"

const MARKER = "M12 (2) C6.5 (2) 2 (6.5) 2 (12)'test'"

describe('ModelsDevLogoMark safe inline mask', () => {
  it('applies the exact double-quoted inline mask for single-quote/paren payloads', () => {
    const { container } = render(
      <ModelsDevLogoMark src={TRICKY_SRC} size={24} fallback={<span>fallback</span>} label="tricky logo" />
    )
    const mark = container.querySelector('[data-testid="models-dev-logo-mark"]') as HTMLElement | null
    expect(mark).not.toBeNull()
    const expected = `url("${TRICKY_SRC}")`
    expect(mark?.style.maskImage).toBe(expected)
    // jsdom drops `-webkit-mask-image` from serialized style/getPropertyValue
    // and only exposes the camelCase expando as `WebkitMaskImage` (capital W,
    // as React sets it); lowercase `webkitMaskImage` stays undefined. Assert
    // the capital-W key to prove the production inline dual-prefix mask
    // without touching production `WebkitMaskImage`.
    const webkitMask = (mark?.style as unknown as Record<string, string | undefined>).WebkitMaskImage
    expect(webkitMask).toBe(expected)
    expect(mark?.style.backgroundColor).toBe('var(--color-text-1)')
    // Accessible label is required and forwarded to the avatar circle.
    const circle = container.querySelector('[data-testid="models-dev-logo-avatar"]')
    expect(circle?.getAttribute('aria-label')).toBe('tricky logo')
  })

  it('never leaks the full SVG URL into style tags or generated classes', () => {
    const { container } = render(
      <ModelsDevLogoMark src={TRICKY_SRC} size={24} fallback={<span>fallback</span>} label="tricky logo" />
    )
    const mark = container.querySelector('[data-testid="models-dev-logo-mark"]') as HTMLElement | null
    expect(mark).not.toBeNull()
    // All styled-components style tags must not contain the payload marker.
    const styleText = [...document.querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n')
    expect(styleText).not.toContain(MARKER)
    expect(styleText).not.toContain(TRICKY_SRC)
    // The generated class itself carries no URL: class CSS lives in style
    // tags (asserted above); the element's class attribute is a short hash.
    for (const cls of Array.from(mark?.classList ?? [])) {
      expect(cls).not.toContain('data:image')
      expect(cls).not.toContain(MARKER)
    }
    // Inline style (the only URL carrier) is exactly the safe double-quoted form.
    expect(mark?.getAttribute('style')).toContain(`url("${TRICKY_SRC.slice(0, 32)}`)
  })
})
