import { UserAvatar } from '@renderer/config/env'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import DefaultUserAvatar, { isDefaultUserAvatar } from '../DefaultUserAvatar'

/** CSS rules the component declares for the element's own classes. */
function ownRules(element: HTMLElement): string[] {
  const css = Array.from(document.querySelectorAll('style'))
    .map((node) => node.textContent ?? '')
    .join('\n')
    .replace(/\s+/g, '')
  return (css.match(/[^{}]+{[^}]*}/g) ?? []).filter((rule) =>
    Array.from(element.classList).some((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`\\.${escaped}(?![\\w-])`).test(rule)
    })
  )
}

describe('isDefaultUserAvatar', () => {
  it('treats missing values as the default identity', () => {
    expect(isDefaultUserAvatar(undefined)).toBe(true)
    expect(isDefaultUserAvatar(null)).toBe(true)
    expect(isDefaultUserAvatar('')).toBe(true)
  })

  it('treats the bundled default asset as the default identity', () => {
    expect(isDefaultUserAvatar(UserAvatar)).toBe(true)
  })

  it('keeps genuine custom avatars off the default path', () => {
    expect(isDefaultUserAvatar('https://avatar.example/me.png')).toBe(false)
    expect(isDefaultUserAvatar('data:image/png;base64,iVBORw0KGgo=')).toBe(false)
    expect(isDefaultUserAvatar('😀')).toBe(false)
  })

  it('does not mistake a custom green picture for the bundled default', () => {
    expect(isDefaultUserAvatar('data:image/png;base64,CUSTOM-GREEN-PIXELS')).toBe(false)
    expect(isDefaultUserAvatar('https://avatar.example/green.png')).toBe(false)
  })
})

describe('DefaultUserAvatar', () => {
  it('renders a neutral User outline with no image', () => {
    const { container } = render(<DefaultUserAvatar size={80} />)
    expect(screen.getByTestId('default-user-avatar')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    const rules = ownRules(screen.getByTestId('default-user-avatar'))
    expect(rules.some((rule) => rule.includes('background-soft'))).toBe(true)
    expect(rules.every((rule) => !rule.includes('--color-primary'))).toBe(true)
    expect(rules.every((rule) => !rule.includes('--color-green'))).toBe(true)
  })

  it('scales the glyph proportionally with size', () => {
    const { container } = render(<DefaultUserAvatar size={80} />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe(String(Math.round(80 * 0.55)))
  })

  it('is a static element without onClick and a button with onClick', () => {
    const { unmount } = render(<DefaultUserAvatar size={28} testId="static-default" />)
    expect(screen.getByTestId('static-default').tagName).toBe('DIV')
    unmount()
    render(<DefaultUserAvatar size={28} onClick={() => {}} testId="clickable-default" />)
    expect(screen.getByTestId('clickable-default').tagName).toBe('BUTTON')
  })
})
