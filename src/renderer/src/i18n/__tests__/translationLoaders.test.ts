import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearTranslationCache,
  getTranslationLoader,
  loadTranslation,
  normalizeTranslationLanguage,
  SUPPORTED_TRANSLATION_LANGUAGES,
  translationCache,
  translationLoaders
} from '../translationLoaders'

describe('translationLoaders - S7.4 mapping and fallback', () => {
  beforeEach(() => {
    clearTranslationCache()
    vi.clearAllMocks()
  })

  it('exposes exactly 12 supported LanguageVarious keys', () => {
    expect(SUPPORTED_TRANSLATION_LANGUAGES).toHaveLength(12)
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
    expect([...SUPPORTED_TRANSLATION_LANGUAGES].sort()).toEqual(expected)
  })

  it('has a statically analyzable loader per language with exact literal import path', () => {
    const expectedLiteralMap: Record<string, string> = {
      'en-US': 'locales/en-us.json',
      'zh-CN': 'locales/zh-cn.json',
      'zh-TW': 'locales/zh-tw.json',
      'de-DE': 'translate/de-de.json',
      'el-GR': 'translate/el-gr.json',
      'es-ES': 'translate/es-es.json',
      'fr-FR': 'translate/fr-fr.json',
      'ja-JP': 'translate/ja-jp.json',
      'pt-PT': 'translate/pt-pt.json',
      'ro-RO': 'translate/ro-ro.json',
      'ru-RU': 'translate/ru-ru.json',
      'vi-VN': 'translate/vi-vn.json'
    }
    for (const lang of SUPPORTED_TRANSLATION_LANGUAGES) {
      const loader = translationLoaders[lang]
      expect(loader).toBeDefined()
      expect(typeof loader).toBe('function')
      const source = loader.toString()
      // Vite transforms import() to __vite_ssr_dynamic_import__ but literal path must survive
      expect(source).toMatch(/import|__vite_ssr_dynamic_import__/)
      const expected = expectedLiteralMap[lang]
      expect(source).toContain(expected)
      // Ensure no variable/template import: the literal file name appears as a quoted string
      expect(source).toMatch(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      // Each loader must be statically analyzable: contains its own file only, not another language
      for (const other of SUPPORTED_TRANSLATION_LANGUAGES) {
        if (other === lang) continue
        const otherFile = expectedLiteralMap[other]
        // disallow cross-contamination: zh-CN loader must not contain de-de.json
        expect(source).not.toContain(otherFile)
      }
    }
  })

  it('every supported language loader is distinct and English fallback uses en-US resolver', () => {
    const enLoader = translationLoaders['en-US']
    const sources = new Set<string>()
    for (const lang of SUPPORTED_TRANSLATION_LANGUAGES) {
      const src = translationLoaders[lang].toString()
      expect(sources.has(src)).toBe(false)
      sources.add(src)
    }
    expect(sources.size).toBe(12)
    expect(getTranslationLoader('xx-YY' as any).toString()).toBe(enLoader.toString())
    expect(getTranslationLoader('__proto__' as any).toString()).toBe(enLoader.toString())
  })

  it('normalize maps known languages identity and unknown to en-US fallback', () => {
    for (const lang of SUPPORTED_TRANSLATION_LANGUAGES) {
      expect(normalizeTranslationLanguage(lang)).toBe(lang)
    }
    expect(normalizeTranslationLanguage('xx-YY' as any)).toBe('en-US')
    expect(normalizeTranslationLanguage('' as any)).toBe('en-US')
    expect(normalizeTranslationLanguage('en-GB' as any)).toBe('en-US')
    expect(normalizeTranslationLanguage('en' as any)).toBe('en-US')
  })

  it('normalize falls back for inherited prototype-chain names (own-key safe)', () => {
    const inheritedNames = ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor', 'toLocaleString']
    for (const name of inheritedNames) {
      expect(normalizeTranslationLanguage(name as any)).toBe('en-US')
    }
    expect(normalizeTranslationLanguage('__proto__' as any)).toBe('en-US')
    expect(normalizeTranslationLanguage('constructor' as any)).toBe('en-US')
  })

  it('getTranslationLoader returns en-US loader for unknown and inherited language', () => {
    const enLoader = translationLoaders['en-US']
    expect(getTranslationLoader('unknown' as any)).toBe(enLoader)
    expect(getTranslationLoader('zh-CN')).toBe(translationLoaders['zh-CN'])
    expect(getTranslationLoader('en-US')).toBe(enLoader)
    expect(getTranslationLoader('toString' as any)).toBe(enLoader)
    expect(getTranslationLoader('__proto__' as any)).toBe(enLoader)
    expect(getTranslationLoader('constructor' as any)).toBe(enLoader)
  })

  it.each(SUPPORTED_TRANSLATION_LANGUAGES)('loader for %s resolves to a translation object', async (lang) => {
    const mod = await translationLoaders[lang]()
    const data = (mod as any).default ?? mod
    expect(data).toBeDefined()
    expect(typeof data).toBe('object')
    // translation files should contain at least one known key
    expect(Object.keys(data).length).toBeGreaterThan(0)
  })

  it('loadTranslation caches and returns same reference on second call', async () => {
    const first = await loadTranslation('en-US')
    const second = await loadTranslation('en-US')
    expect(second).toBe(first)
    expect(translationCache.get('en-US')).toBe(first)
  })

  it('loadTranslation fallback uses en-US for unknown language and caches en-US', async () => {
    const result = await loadTranslation('xx-YY' as any)
    const en = await loadTranslation('en-US')
    expect(result).toBe(en)
    expect(translationCache.get('en-US')).toBe(result)
  })

  it('loadTranslation fallback for inherited names uses en-US and does not pollute cache', async () => {
    const result = await loadTranslation('toString' as any)
    const en = await loadTranslation('en-US')
    expect(result).toBe(en)
    expect(translationCache.get('en-US')).toBe(result)
    expect(translationCache.has('toString' as any)).toBe(false)
    expect(translationCache.has('__proto__' as any)).toBe(false)
    const result2 = await loadTranslation('__proto__' as any)
    expect(result2).toBe(en)
  })

  it('clearTranslationCache empties cache', async () => {
    await loadTranslation('fr-FR')
    expect(translationCache.size).toBeGreaterThan(0)
    clearTranslationCache()
    expect(translationCache.size).toBe(0)
  })

  it('each language resolves distinct translation object', async () => {
    const en = await loadTranslation('en-US')
    const zh = await loadTranslation('zh-CN')
    const ja = await loadTranslation('ja-JP')
    expect(en).not.toBe(zh)
    expect(en).not.toBe(ja)
    expect(zh).not.toBe(ja)
  })

  it('all 12 production loaders prove distinct translation keys and no tautology', async () => {
    const seen = new Set<string>()
    for (const lang of SUPPORTED_TRANSLATION_LANGUAGES) {
      const mod = await translationLoaders[lang]()
      const data = (mod as any).default ?? mod
      // use a stable key count signature to ensure distinctness across locales (even if keys overlap, objects differ by content)
      const fingerprint = JSON.stringify(data).slice(0, 200)
      expect(seen.has(fingerprint)).toBe(false)
      seen.add(fingerprint)
    }
    expect(seen.size).toBe(12)
  })
})
