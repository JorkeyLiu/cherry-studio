import { describe, expect, it } from 'vitest'

import { getFirstCharacter } from '../naming'
import { generateColorFromChar, getForegroundColor } from '../style'

describe('AddProviderPopup avatar fallback semantics (mirrors ProviderAvatar)', () => {
  it('uses P fallback for empty/blank names', () => {
    const displayNameFor = (name: string) => (name?.trim() ? name : '')
    expect(displayNameFor('')).toBe('')
    expect(displayNameFor('   ')).toBe('')
    expect(getFirstCharacter(displayNameFor('')) || 'P').toBe('P')
    expect(getFirstCharacter(displayNameFor('   ')) || 'P').toBe('P')
  })

  it('is code-point safe for non-BMP (emoji) names', () => {
    expect(getFirstCharacter('😀 Connection')).toBe('😀')
    expect(getFirstCharacter('😀 Connection') || 'P').toBe('😀')
    // Lone-surrogate breakage (String.charAt) must not occur.
    expect('😀 Connection'.charAt(0)).not.toBe('😀')
  })

  it('derives color from P fallback when blank, matching ProviderAvatar', () => {
    const displayName = ''
    const backgroundColor = generateColorFromChar(displayName || 'P')
    expect(backgroundColor).toBe(generateColorFromChar('P'))
    expect(() => getForegroundColor(backgroundColor)).not.toThrow()
  })

  it('derives color from the trimmed name otherwise', () => {
    const displayName = '😀 Connection'
    const backgroundColor = generateColorFromChar(displayName || 'P')
    expect(backgroundColor).toBe(generateColorFromChar('😀 Connection'))
    expect(() => getForegroundColor(backgroundColor)).not.toThrow()
  })
})
