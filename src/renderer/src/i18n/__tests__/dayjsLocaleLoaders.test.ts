import dayjs from 'dayjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearDayjsLocaleCache,
  dayjsLocaleCache,
  dayjsLocaleLoaders,
  getDayjsLocaleCode,
  getDayjsLocaleLoader,
  loadDayjsLocale,
  normalizeDayjsLanguage,
  SUPPORTED_DAYJS_LANGUAGES
} from '../dayjsLocaleLoaders'

describe('dayjsLocaleLoaders - S7.4 mapping and fallback', () => {
  beforeEach(() => {
    clearDayjsLocaleCache()
    vi.clearAllMocks()
    dayjs.locale('en')
  })

  it('exposes exactly 12 supported LanguageVarious keys', () => {
    expect(SUPPORTED_DAYJS_LANGUAGES).toHaveLength(12)
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
    expect([...SUPPORTED_DAYJS_LANGUAGES].sort()).toEqual(expected)
  })

  it('has a statically analyzable loader per language with exact literal import path', () => {
    const expectedLiteralMap: Record<string, string | null> = {
      'en-US': null,
      'zh-CN': 'dayjs/locale/zh-cn',
      'zh-TW': 'dayjs/locale/zh-tw',
      'de-DE': 'dayjs/locale/de',
      'el-GR': 'dayjs/locale/el',
      'es-ES': 'dayjs/locale/es',
      'fr-FR': 'dayjs/locale/fr',
      'ja-JP': 'dayjs/locale/ja',
      'pt-PT': 'dayjs/locale/pt',
      'ro-RO': 'dayjs/locale/ro',
      'ru-RU': 'dayjs/locale/ru',
      'vi-VN': 'dayjs/locale/vi'
    }
    for (const lang of SUPPORTED_DAYJS_LANGUAGES) {
      const loader = dayjsLocaleLoaders[lang]
      expect(loader).toBeDefined()
      expect(typeof loader).toBe('function')
      const source = loader.toString()
      const expected = expectedLiteralMap[lang]
      if (expected === null) {
        // en-US must be a synchronous Promise.resolve with no dynamic import
        expect(source).toContain('Promise')
        expect(source).not.toContain('dayjs/locale')
      } else {
        // Vite transforms import() to __vite_ssr_dynamic_import__ but literal path must survive
        expect(source).toMatch(/import|__vite_ssr_dynamic_import__/)
        expect(source).toContain(expected)
        // guard against generic/template or variable import: literal must appear quoted
        expect(source).toMatch(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        for (const other of SUPPORTED_DAYJS_LANGUAGES) {
          const otherPath = expectedLiteralMap[other]
          if (!otherPath || other === lang) continue
          expect(source).not.toContain(otherPath)
        }
      }
    }
  })

  it('every supported language loader is distinct and English fallback uses en-US resolver', async () => {
    const enLoader = dayjsLocaleLoaders['en-US']
    const sources = new Set<string>()
    for (const lang of SUPPORTED_DAYJS_LANGUAGES) {
      const src = dayjsLocaleLoaders[lang].toString()
      expect(sources.has(src)).toBe(false)
      sources.add(src)
    }
    expect(sources.size).toBe(12)
    // fallback for unknown must be en-US loader (no new path introduced)
    expect(getDayjsLocaleLoader('xx-YY' as any).toString()).toBe(enLoader.toString())
    expect(getDayjsLocaleLoader('__proto__' as any).toString()).toBe(enLoader.toString())
  })

  it('normalize maps known languages identity and unknown to en-US fallback', () => {
    for (const lang of SUPPORTED_DAYJS_LANGUAGES) {
      expect(normalizeDayjsLanguage(lang)).toBe(lang)
    }
    expect(normalizeDayjsLanguage('xx-YY' as any)).toBe('en-US')
    expect(normalizeDayjsLanguage('' as any)).toBe('en-US')
    expect(normalizeDayjsLanguage('en-GB' as any)).toBe('en-US')
    expect(normalizeDayjsLanguage('en' as any)).toBe('en-US')
  })

  it('normalize falls back for inherited prototype-chain names (own-key safe)', () => {
    const inheritedNames = ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor', 'toLocaleString']
    for (const name of inheritedNames) {
      expect(normalizeDayjsLanguage(name as any)).toBe('en-US')
    }
    expect(normalizeDayjsLanguage('__proto__' as any)).toBe('en-US')
    expect(normalizeDayjsLanguage('constructor' as any)).toBe('en-US')
  })

  it('getDayjsLocaleLoader returns en-US loader for unknown and inherited language', () => {
    const enLoader = dayjsLocaleLoaders['en-US']
    expect(getDayjsLocaleLoader('unknown' as any)).toBe(enLoader)
    expect(getDayjsLocaleLoader('zh-CN')).toBe(dayjsLocaleLoaders['zh-CN'])
    expect(getDayjsLocaleLoader('en-US')).toBe(enLoader)
    expect(getDayjsLocaleLoader('toString' as any)).toBe(enLoader)
    expect(getDayjsLocaleLoader('__proto__' as any)).toBe(enLoader)
  })

  it('getDayjsLocaleCode maps correctly and fallback to en', () => {
    expect(getDayjsLocaleCode('en-US')).toBe('en')
    expect(getDayjsLocaleCode('zh-CN')).toBe('zh-cn')
    expect(getDayjsLocaleCode('ja-JP')).toBe('ja')
    expect(getDayjsLocaleCode('unknown' as any)).toBe('en')
    expect(getDayjsLocaleCode('toString' as any)).toBe('en')
  })

  it.each(SUPPORTED_DAYJS_LANGUAGES)('loader for %s resolves and can be applied to dayjs', async (lang) => {
    await dayjsLocaleLoaders[lang]()
    const code = getDayjsLocaleCode(lang)
    dayjs.locale(code)
    expect(dayjs.locale()).toBe(code)
  })

  it('loadDayjsLocale caches and returns locale code', async () => {
    const code1 = await loadDayjsLocale('de-DE')
    expect(code1).toBe('de')
    expect(dayjsLocaleCache.has('de-DE' as any)).toBe(true)
    const code2 = await loadDayjsLocale('de-DE')
    expect(code2).toBe('de')
  })

  it('loadDayjsLocale fallback uses en-US for unknown and caches en-US', async () => {
    const result = await loadDayjsLocale('xx-YY' as any)
    expect(result).toBe('en')
    expect(dayjsLocaleCache.has('en-US' as any)).toBe(true)
  })

  it('loadDayjsLocale fallback for inherited names uses en-US and does not pollute cache', async () => {
    const result = await loadDayjsLocale('toString' as any)
    expect(result).toBe('en')
    expect(dayjsLocaleCache.has('en-US' as any)).toBe(true)
    expect(dayjsLocaleCache.has('toString' as any)).toBe(false)
    expect(dayjsLocaleCache.has('__proto__' as any)).toBe(false)
    const result2 = await loadDayjsLocale('__proto__' as any)
    expect(result2).toBe('en')
  })

  it('clearDayjsLocaleCache empties cache', async () => {
    await loadDayjsLocale('fr-FR')
    expect(dayjsLocaleCache.size).toBeGreaterThan(0)
    clearDayjsLocaleCache()
    expect(dayjsLocaleCache.size).toBe(0)
  })

  it('representative Day.js locale behavior: de-DE formats month in German', async () => {
    await loadDayjsLocale('de-DE')
    dayjs.locale('de')
    const formatted = dayjs('2024-01-15').format('MMMM')
    expect(formatted.toLowerCase()).toContain('januar')
    dayjs.locale('en')
    const enFormatted = dayjs('2024-01-15').format('MMMM')
    expect(enFormatted).toBe('January')
  })

  it('representative Day.js locale behavior: ja-JP loads and sets ja', async () => {
    await loadDayjsLocale('ja-JP')
    dayjs.locale('ja')
    expect(dayjs.locale()).toBe('ja')
    dayjs.locale('en')
  })

  it('representative Day.js locale behavior: zh-CN locale sets zh-cn', async () => {
    await loadDayjsLocale('zh-CN')
    dayjs.locale('zh-cn')
    expect(dayjs.locale()).toBe('zh-cn')
    dayjs.locale('en')
  })
})
