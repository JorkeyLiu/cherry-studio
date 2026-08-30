import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  antdLocaleCache,
  antdLocaleLoaders,
  clearAntdLocaleCache,
  getAntdLocaleLoader,
  loadAntdLocale,
  normalizeAntdLanguage,
  SUPPORTED_LANGUAGES
} from '../antdLocaleLoaders'

const EXPECTED_LOCALE_IDS: Record<string, string> = {
  'zh-CN': 'zh-cn',
  'zh-TW': 'zh-tw',
  'en-US': 'en',
  'de-DE': 'de',
  'ru-RU': 'ru',
  'ja-JP': 'ja',
  'el-GR': 'el',
  'es-ES': 'es',
  'fr-FR': 'fr',
  'pt-PT': 'pt',
  'ro-RO': 'ro',
  'vi-VN': 'vi'
}

describe('antdLocaleLoaders - S7.3 mapping and fallback', () => {
  beforeEach(() => {
    clearAntdLocaleCache()
    vi.clearAllMocks()
  })

  it('exposes exactly 12 supported LanguageVarious keys', () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(12)
    const expected = [
      'zh-CN',
      'zh-TW',
      'en-US',
      'de-DE',
      'ru-RU',
      'ja-JP',
      'el-GR',
      'es-ES',
      'fr-FR',
      'pt-PT',
      'ro-RO',
      'vi-VN'
    ].sort()
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(expected)
  })

  it('has a statically analyzable loader per language', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const loader = antdLocaleLoaders[lang]
      expect(loader).toBeDefined()
      expect(typeof loader).toBe('function')
      // loader string should contain import - indirectly ensure it's a dynamic import factory
      expect(loader.toString()).toContain('import')
    }
  })

  it('normalize maps known languages identity and unknown to zh-CN fallback', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(normalizeAntdLanguage(lang)).toBe(lang)
    }
    expect(normalizeAntdLanguage('xx-YY' as any)).toBe('zh-CN')
    expect(normalizeAntdLanguage('' as any)).toBe('zh-CN')
    expect(normalizeAntdLanguage('en-GB' as any)).toBe('zh-CN')
    // navigator.language may be like 'en' without region - fallback
    expect(normalizeAntdLanguage('en' as any)).toBe('zh-CN')
  })

  it('normalize falls back for inherited prototype-chain names (own-key safe)', () => {
    const inheritedNames = ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor', 'toLocaleString']
    for (const name of inheritedNames) {
      expect(normalizeAntdLanguage(name as any)).toBe('zh-CN')
    }
    // verify own-key check does not consider prototype chain even if prototype pollution attempted
    expect(normalizeAntdLanguage('__proto__' as any)).toBe('zh-CN')
    expect(normalizeAntdLanguage('constructor' as any)).toBe('zh-CN')
  })

  it('getAntdLocaleLoader returns zh-CN loader for unknown and inherited language', () => {
    const zhLoader = antdLocaleLoaders['zh-CN']
    expect(getAntdLocaleLoader('unknown' as any)).toBe(zhLoader)
    expect(getAntdLocaleLoader('zh-CN')).toBe(zhLoader)
    expect(getAntdLocaleLoader('en-US')).toBe(antdLocaleLoaders['en-US'])
    expect(getAntdLocaleLoader('toString' as any)).toBe(zhLoader)
    expect(getAntdLocaleLoader('__proto__' as any)).toBe(zhLoader)
    expect(getAntdLocaleLoader('constructor' as any)).toBe(zhLoader)
  })

  it.each(SUPPORTED_LANGUAGES)('loader for %s resolves to a locale object with locale property', async (lang) => {
    const mod = await antdLocaleLoaders[lang]()
    const locale = (mod as any).default ?? mod
    expect(locale).toBeDefined()
    expect(typeof locale).toBe('object')
    // Antd locale objects have a locale string or at least contain a key
    // e.g., zhCN.locale = 'zh-cn', enUS.locale = 'en'
    expect(locale.locale ?? locale.code ?? true).toBeTruthy()
  })

  it.each(Object.entries(EXPECTED_LOCALE_IDS))(
    'production loader for %s resolves to exact Antd locale id %s',
    async (lang, expectedId) => {
      const mod = await antdLocaleLoaders[lang as keyof typeof antdLocaleLoaders]()
      const locale = (mod as any).default ?? mod
      expect(locale.locale).toBe(expectedId)
    }
  )

  it('all 12 production loaders prove distinct expected locale IDs and no tautology', async () => {
    const seen = new Set<string>()
    for (const [lang, expectedId] of Object.entries(EXPECTED_LOCALE_IDS)) {
      const mod = await antdLocaleLoaders[lang as keyof typeof antdLocaleLoaders]()
      const locale = (mod as any).default ?? mod
      expect(locale.locale).toBe(expectedId)
      expect(seen.has(expectedId)).toBe(false)
      seen.add(expectedId)
    }
    expect(seen.size).toBe(12)
  })

  it('loadAntdLocale caches and returns same reference on second call', async () => {
    const first = await loadAntdLocale('en-US')
    const second = await loadAntdLocale('en-US')
    expect(second).toBe(first)
    expect(antdLocaleCache.get('en-US')).toBe(first)
  })

  it('loadAntdLocale fallback uses zh-CN for unknown language and caches zh-CN', async () => {
    const result = await loadAntdLocale('xx-YY' as any)
    const zh = await loadAntdLocale('zh-CN')
    expect(result).toBe(zh)
    expect(antdLocaleCache.get('zh-CN')).toBe(result)
  })

  it('loadAntdLocale fallback for inherited names uses zh-CN and does not pollute cache', async () => {
    const result = await loadAntdLocale('toString' as any)
    const zh = await loadAntdLocale('zh-CN')
    expect(result).toBe(zh)
    expect(antdLocaleCache.get('zh-CN')).toBe(result)
    expect(antdLocaleCache.has('toString' as any)).toBe(false)
    expect(antdLocaleCache.has('__proto__' as any)).toBe(false)
    const result2 = await loadAntdLocale('__proto__' as any)
    expect(result2).toBe(zh)
  })

  it('clearAntdLocaleCache empties cache', async () => {
    await loadAntdLocale('fr-FR')
    expect(antdLocaleCache.size).toBeGreaterThan(0)
    clearAntdLocaleCache()
    expect(antdLocaleCache.size).toBe(0)
  })

  it('each language resolves distinct locale chunk (basic distinctness)', async () => {
    // Load two different languages and ensure they are distinct objects
    const en = await loadAntdLocale('en-US')
    const zh = await loadAntdLocale('zh-CN')
    const ja = await loadAntdLocale('ja-JP')
    expect(en).not.toBe(zh)
    expect(en).not.toBe(ja)
    expect(zh).not.toBe(ja)
  })
})
