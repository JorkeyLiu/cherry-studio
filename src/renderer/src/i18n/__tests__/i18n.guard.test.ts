import { describe, expect, it, vi } from 'vitest'

// Intentionally incomplete i18next mock — omit changeLanguage to reproduce
// the aggregate-test regression at `i18n.changeLanguage.bind`.
vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn().mockResolvedValue(undefined),
    t: (k: string) => k,
    language: 'en-US',
    addResourceBundle: vi.fn(),
    getResourceBundle: vi.fn(() => undefined),
    hasResourceBundle: vi.fn(() => false)
    // changeLanguage deliberately absent
  } as any,
  t: (k: string) => k
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn(),
      verbose: vi.fn()
    })
  }
}))

describe('i18n guard - incomplete i18next mock regression', () => {
  it('module evaluates without TypeError when changeLanguage is absent', async () => {
    const mod = await import('../index')
    expect(mod.default).toBeDefined()
    expect(typeof mod.default.changeLanguage).toBe('function')
  })

  it('changeLanguage preserves current state and avoids invoking undefined', async () => {
    const mod = await import('../index')
    const beforeLang = mod.default.language
    const result = await mod.default.changeLanguage('de-DE')
    expect(result).toBeDefined()
    // preserve state — language not mutated when original is absent
    expect(mod.default.language).toBe(beforeLang)
  })

  it('exposes test utils without throwing', async () => {
    const { __i18nTestUtils } = await import('../index')
    expect(__i18nTestUtils).toBeDefined()
    expect(typeof __i18nTestUtils.translationRequestId).toBe('number')
  })
})
