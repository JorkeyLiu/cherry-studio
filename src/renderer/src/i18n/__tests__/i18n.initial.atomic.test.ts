import { act } from '@testing-library/react'
import dayjs from 'dayjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearDayjsLocaleCache, dayjsLocaleLoaders } from '../dayjsLocaleLoaders'
import i18n, { getLanguage } from '../index'
import { clearTranslationCache, translationCache, translationLoaders } from '../translationLoaders'

const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }))
vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: mockLoggerError,
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      silly: vi.fn()
    })
  }
}))

describe('i18n initial atomic activation (S7.4)', () => {
  const mockTranslationData: Record<string, Record<string, unknown>> = {
    'en-US': { testKey: 'en-Value', 'chat.default.name': 'Default Assistant' },
    'de-DE': { testKey: 'de-Value' },
    'zh-CN': { testKey: 'zh-Value' },
    'ja-JP': { testKey: 'ja-Value' },
    'fr-FR': { testKey: 'fr-Value' }
  }

  type Deferred<T = any> = { promise: Promise<T>; resolve: (v?: any) => void; reject: (e: any) => void }
  const translationDeferredMap = new Map<string, Deferred>()
  const dayjsDeferredMap = new Map<string, Deferred>()

  const originalTranslationLoaders: Record<string, () => Promise<any>> = { ...translationLoaders }
  const originalDayjsLoaders: Record<string, () => Promise<any>> = { ...dayjsLocaleLoaders }

  function createTranslationDeferred(lang: string): Deferred {
    let resolve!: (v: any) => void
    let reject!: (e: any) => void
    const promise = new Promise<any>((res, rej) => {
      resolve = (val) => res({ default: val })
      reject = rej
    })
    return { promise, resolve: (data?: any) => resolve(data ?? mockTranslationData[lang] ?? { testKey: lang }), reject }
  }
  function createDayjsDeferred(): Deferred {
    let resolve!: (v: any) => void
    let reject!: (e: any) => void
    const promise = new Promise<any>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve: () => resolve({}), reject }
  }

  beforeEach(async () => {
    mockLoggerError.mockClear()
    clearTranslationCache()
    clearDayjsLocaleCache()
    translationDeferredMap.clear()
    dayjsDeferredMap.clear()
    dayjs.locale('en')
    // patch loaders to deferred-aware
    for (const lang of Object.keys(originalTranslationLoaders)) {
      // @ts-ignore
      translationLoaders[lang as any] = () => {
        const d = translationDeferredMap.get(lang)
        if (d) return d.promise
        return Promise.resolve({ default: mockTranslationData[lang] ?? { testKey: lang } })
      }
    }
    for (const lang of Object.keys(originalDayjsLoaders)) {
      // @ts-ignore
      dayjsLocaleLoaders[lang as any] = () => {
        const d = dayjsDeferredMap.get(lang)
        if (d) return d.promise.then(() => originalDayjsLoaders[lang]())
        return originalDayjsLoaders[lang]()
      }
    }
    // reset i18n to deterministic en-US baseline
    for (const lng of Object.keys(mockTranslationData)) {
      if (i18n.hasResourceBundle(lng, 'translation')) i18n.removeResourceBundle(lng, 'translation')
    }
    translationCache.set('en-US' as any, mockTranslationData['en-US'])
    i18n.addResourceBundle('en-US', 'translation', mockTranslationData['en-US'], true, true)
    await i18n.changeLanguage('en-US')
    dayjs.locale('en')
    localStorage.removeItem('language')
  })

  afterEach(() => {
    for (const lang of Object.keys(originalTranslationLoaders)) {
      // @ts-ignore
      translationLoaders[lang as any] = originalTranslationLoaders[lang]
    }
    for (const lang of Object.keys(originalDayjsLoaders)) {
      // @ts-ignore
      dayjsLocaleLoaders[lang as any] = originalDayjsLoaders[lang]
    }
    clearTranslationCache()
    clearDayjsLocaleCache()
    translationDeferredMap.clear()
    dayjsDeferredMap.clear()
    localStorage.removeItem('language')
  })

  it('proves no native pre-activation: init does not synchronously set configured non-English language', async () => {
    // This test proves the fix: i18n.init no longer contains lng: getLanguage() / resources: {}
    // Observable proof: after resetting to en-US, a pending coordinated load for configured lang retains en-US
    localStorage.setItem('language', 'de-DE')
    const configured = getLanguage()
    expect(configured).toBe('de-DE')
    // Simulate initial coordinated load as the sole activation path (fire-and-forget wrapper)
    const dTrans = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', dTrans)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('de-DE', dDayjs)

    const promise = i18n.changeLanguage(configured)

    // While pending, must retain last successful (en-US) — no native pre-activation
    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')
    expect(i18n.t('testKey')).toBe('en-Value')

    await act(async () => {
      dTrans.resolve(mockTranslationData['de-DE'])
      await dTrans.promise
      dDayjs.resolve()
      await dDayjs.promise
      await promise
    })

    expect(i18n.language).toBe('de-DE')
    expect(i18n.t('testKey')).toBe('de-Value')
    expect(dayjs.locale()).toBe('de')
  })

  it('initial configured translation pending/failure retains default combined state and logs', async () => {
    localStorage.setItem('language', 'zh-CN')
    const configured = getLanguage()
    expect(configured).toBe('zh-CN')
    const dFail = createTranslationDeferred('zh-CN')
    translationDeferredMap.set('zh-CN', dFail)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('zh-CN', dDayjs)

    const promise = i18n.changeLanguage(configured)
    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')

    await act(async () => {
      dFail.reject(new Error('initial translation chunk failed'))
      try {
        await dFail.promise
      } catch {}
      dDayjs.resolve()
      await dDayjs.promise
      await promise
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to load i18n translation/),
      expect.any(Error),
      expect.objectContaining({ language: 'zh-CN' })
    )
    expect(translationCache.has('zh-CN' as any)).toBe(false)
  })

  it('initial configured Day.js failure retains default atomically and logs (translation success does not commit)', async () => {
    localStorage.setItem('language', 'ja-JP')
    const configured = getLanguage()
    expect(configured).toBe('ja-JP')
    const dTrans = createTranslationDeferred('ja-JP')
    translationDeferredMap.set('ja-JP', dTrans)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('ja-JP', dDayjs)

    const promise = i18n.changeLanguage(configured)
    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')

    await act(async () => {
      dTrans.resolve(mockTranslationData['ja-JP'])
      await dTrans.promise
      dDayjs.reject(new Error('initial dayjs chunk failed'))
      try {
        await dDayjs.promise
      } catch {}
      await promise
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(i18n.language).toBe('en-US')
    expect(i18n.t('testKey')).not.toBe('ja-Value')
    expect(dayjs.locale()).toBe('en')
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to load Day\.js locale/),
      expect.any(Error),
      expect.objectContaining({ language: 'ja-JP' })
    )
    expect(i18n.hasResourceBundle('ja-JP', 'translation')).toBe(false)
  })

  it('initial configured success activates both translation and Day.js', async () => {
    localStorage.setItem('language', 'fr-FR')
    const configured = getLanguage()
    expect(configured).toBe('fr-FR')
    const dTrans = createTranslationDeferred('fr-FR')
    translationDeferredMap.set('fr-FR', dTrans)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('fr-FR', dDayjs)

    const promise = i18n.changeLanguage(configured)
    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')

    await act(async () => {
      dTrans.resolve(mockTranslationData['fr-FR'])
      await dTrans.promise
      dDayjs.resolve()
      await dDayjs.promise
      await promise
    })

    expect(i18n.language).toBe('fr-FR')
    expect(i18n.t('testKey')).toBe('fr-Value')
    expect(dayjs.locale()).toBe('fr')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('initial fallback semantics preserved: unknown configured language falls back to en-US without pollution', async () => {
    localStorage.setItem('language', 'xx-YY')
    const configured = getLanguage()
    expect(configured).toBe('xx-YY')
    const dEn = createTranslationDeferred('en-US')
    translationDeferredMap.set('en-US', dEn)

    const promise = i18n.changeLanguage(configured)
    // While pending, still en-US (fallback) not xx-YY
    expect(i18n.language).toBe('en-US')

    await act(async () => {
      dEn.resolve(mockTranslationData['en-US'])
      await dEn.promise
      await promise
    })

    expect(i18n.language).toBe('en-US')
    expect(i18n.t('testKey')).toBe('en-Value')
    expect(translationCache.has('en-US' as any)).toBe(true)
    expect(translationCache.has('xx-YY' as any)).toBe(false)
  })

  it('source no longer pre-activates via i18n.init lng/resources (static evidence)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/i18n/index.ts'), 'utf-8')
    const initMatch = source.match(/i18n\.use\(initReactI18next\)\.init\(\{([\s\S]*?)\}\)/m)
    const initBlock = initMatch ? initMatch[1] : ''
    // Must not contain synchronous activation via lng or truthy resources inside init
    expect(initBlock).not.toMatch(/lng\s*:/)
    expect(initBlock).not.toMatch(/resources\s*:/)
    // Must still contain fallbackLng and deterministic elimination/serialization
    expect(source).toContain('fallbackLng')
    expect(initBlock).toMatch(/initImmediate\s*:\s*false/)
    // Init must be before wrapper (eliminates competing wrapped request) or serialized after init
    const wrapperIdx = source.indexOf('(i18n as any).changeLanguage = async')
    const initIdx = source.indexOf('i18n.use(initReactI18next).init')
    expect(wrapperIdx).toBeGreaterThan(-1)
    expect(initIdx).toBeGreaterThan(-1)
    expect(initIdx).toBeLessThan(wrapperIdx)
    // Coordinated initial must await initPromise before changeLanguage
    expect(source).toMatch(/const initPromise\s*=\s*i18n\.use\(initReactI18next\)\.init/)
    expect(source).toMatch(/await initPromise/)
    expect(source).toMatch(/await\s*\(i18n as any\)\.changeLanguage/)
    const asyncBlock = source.match(/void\s*\(async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\)\(\)/m)
    const block = asyncBlock ? asyncBlock[1] : ''
    const awaitInitIdx = block.indexOf('await initPromise')
    const changeIdx = block.indexOf('(i18n as any).changeLanguage')
    expect(awaitInitIdx).toBeGreaterThan(-1)
    expect(changeIdx).toBeGreaterThan(-1)
    expect(changeIdx).toBeGreaterThan(awaitInitIdx)
  })
})
