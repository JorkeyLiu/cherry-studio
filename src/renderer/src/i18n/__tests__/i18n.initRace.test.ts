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

describe('i18n initial race fix — configured locale deterministically wins (S7.4 final audit)', () => {
  const mockTranslationData: Record<string, Record<string, unknown>> = {
    'en-US': { testKey: 'en-Value' },
    'de-DE': { testKey: 'de-Value' },
    'zh-CN': { testKey: 'zh-Value' },
    'fr-FR': { testKey: 'fr-Value' },
    'ja-JP': { testKey: 'ja-Value' }
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

  it('configured non-English becomes first effective after both loaders succeed, isInitialized stable, pending retains fallback', async () => {
    // isInitialized must be true before and during pending — no readiness regression
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect((i18n as any).isInitialized).toBe(true)

    localStorage.setItem('language', 'de-DE')
    expect(getLanguage()).toBe('de-DE')

    const dTrans = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', dTrans)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('de-DE', dDayjs)

    const p = (i18n as any).changeLanguage(getLanguage())

    // While pending, fallback remains effective; not blank, not pre-activated to de-DE synchronously
    expect(i18n.language).toBe('en-US')
    expect(i18n.t('testKey')).toBe('en-Value')
    expect(dayjs.locale()).toBe('en')
    expect((i18n as any).isInitialized).toBe(true)

    await act(async () => {
      dTrans.resolve(mockTranslationData['de-DE'])
      await dTrans.promise
      dDayjs.resolve()
      await dDayjs.promise
      await p
    })

    expect((i18n as any).isInitialized).toBe(true)
    expect(i18n.language).toBe('de-DE')
    expect(i18n.t('testKey')).toBe('de-Value')
    expect(dayjs.locale()).toBe('de')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('configured pending retains fallback and failure retains fallback with isInitialized true', async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect((i18n as any).isInitialized).toBe(true)
    localStorage.setItem('language', 'zh-CN')
    const dFail = createTranslationDeferred('zh-CN')
    translationDeferredMap.set('zh-CN', dFail)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('zh-CN', dDayjs)

    const p = (i18n as any).changeLanguage(getLanguage())

    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')
    expect((i18n as any).isInitialized).toBe(true)

    await act(async () => {
      dFail.reject(new Error('init translation chunk failed'))
      try {
        await dFail.promise
      } catch {}
      dDayjs.resolve()
      await dDayjs.promise
      await p
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')
    expect((i18n as any).isInitialized).toBe(true)
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to load i18n translation/),
      expect.any(Error),
      expect.objectContaining({ language: 'zh-CN' })
    )
    expect(translationCache.has('zh-CN' as any)).toBe(false)
  })

  it('implicit fallback request does not supersede configured when fallback resolves last', async () => {
    // Simulate old bug: internal fallback en-US setTimeout would fire after configured de-DE started,
    // making de-DE stale (requestId 1) and en-US current (2). Fix must ensure configured wins irrespective.
    // We simulate by starting fallback first then configured second, but resolving fallback last — configured must still win.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect((i18n as any).isInitialized).toBe(true)

    const dFallbackTrans = createTranslationDeferred('en-US')
    // clear cache for en-US to force deferred
    translationCache.delete('en-US' as any)
    if (i18n.hasResourceBundle('en-US', 'translation')) i18n.removeResourceBundle('en-US', 'translation')
    translationCache.delete('fr-FR' as any)
    if (i18n.hasResourceBundle('fr-FR', 'translation')) i18n.removeResourceBundle('fr-FR', 'translation')

    translationDeferredMap.set('en-US', dFallbackTrans)
    const dFallbackDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('en-US', dFallbackDayjs)

    const dConfiguredTrans = createTranslationDeferred('fr-FR')
    translationDeferredMap.set('fr-FR', dConfiguredTrans)
    const dConfiguredDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('fr-FR', dConfiguredDayjs)

    // Fallback en-US started as if internal init fallback, then configured fr-FR (as coordinated initial)
    const pFallback = (i18n as any).changeLanguage('en-US')
    const pConfigured = (i18n as any).changeLanguage('fr-FR')

    // While both pending, still previous (en-US fallback was previous successful? But we cleared, so remains en-US from beforeEach's last successful? Let's reset to en-US baseline first)
    // Our beforeEach left language en-US with bundle; after clearing, language still en-US but bundle removed - pending retains en-US
    expect((i18n as any).isInitialized).toBe(true)

    // Resolve configured first, fallback last
    await act(async () => {
      dConfiguredTrans.resolve(mockTranslationData['fr-FR'])
      await dConfiguredTrans.promise
      dConfiguredDayjs.resolve()
      await dConfiguredDayjs.promise
      await pConfigured
    })

    expect(i18n.language).toBe('fr-FR')
    expect(i18n.t('testKey')).toBe('fr-Value')
    expect(dayjs.locale()).toBe('fr')
    expect((i18n as any).isInitialized).toBe(true)

    await act(async () => {
      dFallbackTrans.resolve(mockTranslationData['en-US'])
      await dFallbackTrans.promise
      dFallbackDayjs.resolve()
      await dFallbackDayjs.promise
      await pFallback
      await new Promise((r) => setTimeout(r, 10))
    })

    // Fallback must not overwrite configured even though it resolved last (stale suppression + callback completion)
    expect(i18n.language).toBe('fr-FR')
    expect(i18n.t('testKey')).toBe('fr-Value')
    expect(dayjs.locale()).toBe('fr')
    expect((i18n as any).isInitialized).toBe(true)
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('serialization static evidence: changeLanguage is invoked only after init completes in source', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/i18n/index.ts'), 'utf-8')
    // Must contain serialized async init block with initPromise
    expect(source).toMatch(/const initPromise\s*=\s*i18n\.use\(initReactI18next\)\.init/)
    expect(source).toMatch(/void\s*\(async\s*\(\)\s*=>\s*\{[\s\S]*?await initPromise/)
    expect(source).toMatch(/await\s*\(i18n as any\)\.changeLanguage/)
    const block = source.match(/void\s*\(async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\)\(\)/m)?.[1] ?? ''
    const awaitInitIdx = block.indexOf('await initPromise')
    const changePos = block.indexOf('(i18n as any).changeLanguage')
    expect(awaitInitIdx).toBeGreaterThan(-1)
    expect(changePos).toBeGreaterThan(-1)
    expect(changePos).toBeGreaterThan(awaitInitIdx)
    // No lng/resources in init, must have initImmediate:false and fallbackLng
    const initArgs = source.match(/i18n\.use\(initReactI18next\)\.init\(\{([\s\S]*?)\}\)/m)?.[1] ?? ''
    expect(initArgs).not.toMatch(/lng\s*:/)
    expect(initArgs).not.toMatch(/resources\s*:/)
    expect(initArgs).toContain('fallbackLng')
    expect(initArgs).toMatch(/initImmediate\s*:\s*false/)
    // Wrapper is defined after init (eliminates competing wrapped request)
    const wrapperPos = source.indexOf('(i18n as any).changeLanguage = async')
    const initUsePos = source.indexOf('i18n.use(initReactI18next).init')
    expect(wrapperPos).toBeGreaterThan(-1)
    expect(initUsePos).toBeGreaterThan(-1)
    expect(initUsePos).toBeLessThan(wrapperPos)
  })
})
