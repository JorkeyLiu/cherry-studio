import { describe, expect, it } from 'vitest'

import { isAtLeast } from '../versions'

describe('isAtLeast', () => {
  it('accepts equal and newer versions', () => {
    expect(isAtLeast('24.11.1', '24.11.1')).toBe(true)
    expect(isAtLeast('24.14.1', '24.11.1')).toBe(true)
    expect(isAtLeast('25.0.0', '24.11.1')).toBe(true)
  })

  it('rejects older versions', () => {
    expect(isAtLeast('24.10.0', '24.11.1')).toBe(false)
    expect(isAtLeast('22.0.0', '24.11.1')).toBe(false)
  })

  it('fail-closed on unparseable versions', () => {
    expect(isAtLeast('', '24.11.1')).toBe(false)
    expect(isAtLeast('garbage', '24.11.1')).toBe(false)
  })
})
