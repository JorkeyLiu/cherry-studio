import { act } from '@testing-library/react'
import dayjs from 'dayjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearDayjsLocaleCache, dayjsLocaleCache, dayjsLocaleLoaders } from '../dayjsLocaleLoaders'
import i18n from '../index'
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

describe('i18n callback stale completion + Day.js stale logging (S7.4 blocker)', () => {
  const mockTranslationData: Record<string, Record<string, unknown>> = {
    'en-US': { testKey: 'en-Value' },
    'de-DE': { testKey: 'de-Value' },
    'ja-JP': { testKey: 'ja-Value' },
    'fr-FR': { testKey: 'fr-Value' },
    'zh-CN': { testKey: 'zh-Value' }
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
    translationCache.set('en-US' as any, mockTranslationData['en-US'])
    if (!i18n.hasResourceBundle('en-US', 'translation')) {
      i18n.addResourceBundle('en-US', 'translation', mockTranslationData['en-US'], true, true)
    }
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
  })

  it('stale callback-bearing changeLanguage request still invokes its callback (prevents i18next init hang)', async () => {
    const dSlow = createTranslationDeferred('ja-JP')
    translationDeferredMap.set('ja-JP', dSlow)
    const dSlowDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('ja-JP', dSlowDayjs)
    const dFast = createTranslationDeferred('fr-FR')
    translationDeferredMap.set('fr-FR', dFast)
    const dFastDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('fr-FR', dFastDayjs)

    const slowCb = vi.fn()
    const fastCb = vi.fn()

    const pSlow = (i18n as any).changeLanguage('ja-JP', slowCb)
    const pFast = (i18n as any).changeLanguage('fr-FR', fastCb)

    await act(async () => {
      dFast.resolve(mockTranslationData['fr-FR'])
      await dFast.promise
      dFastDayjs.resolve()
      await dFastDayjs.promise
      await pFast
    })

    expect(fastCb).toHaveBeenCalledTimes(1)
    expect(fastCb.mock.calls[0][0] == null).toBe(true)
    expect(typeof fastCb.mock.calls[0][1]).toBe('function')
    expect(i18n.language).toBe('fr-FR')

    await act(async () => {
      dSlow.resolve(mockTranslationData['ja-JP'])
      await dSlow.promise
      dSlowDayjs.resolve()
      await dSlowDayjs.promise
      await pSlow
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(slowCb).toHaveBeenCalledTimes(1)
    expect(slowCb.mock.calls[0][0] == null).toBe(true)
    expect(typeof slowCb.mock.calls[0][1]).toBe('function')
    await expect(pSlow).resolves.toBeDefined()
    expect(i18n.language).toBe('fr-FR')
    expect(dayjs.locale()).toBe('fr')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('stale translation failure callback completes without log and does not activate stale locale', async () => {
    const dSlow = createTranslationDeferred('ja-JP')
    translationDeferredMap.set('ja-JP', dSlow)
    const dSlowDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('ja-JP', dSlowDayjs)
    const dFast = createTranslationDeferred('fr-FR')
    translationDeferredMap.set('fr-FR', dFast)
    const dFastDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('fr-FR', dFastDayjs)

    const slowCb = vi.fn()
    const fastCb = vi.fn()

    const pSlow = (i18n as any).changeLanguage('ja-JP', slowCb)
    const pFast = (i18n as any).changeLanguage('fr-FR', fastCb)

    await act(async () => {
      dFast.resolve(mockTranslationData['fr-FR'])
      await dFast.promise
      dFastDayjs.resolve()
      await dFastDayjs.promise
      await pFast
    })
    expect(i18n.language).toBe('fr-FR')
    mockLoggerError.mockClear()

    await act(async () => {
      dSlow.reject(new Error('slow network fail after superseded'))
      try {
        await dSlow.promise
      } catch {}
      dSlowDayjs.resolve()
      await dSlowDayjs.promise
      await pSlow
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(slowCb).toHaveBeenCalledTimes(1)
    expect(slowCb.mock.calls[0][0] == null).toBe(true)
    expect(i18n.language).toBe('fr-FR')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('current Day.js rejection logs; stale Day.js rejection does not log (both via combined atomic path)', async () => {
    const dTransCur = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', dTransCur)
    const dDayjsCur = createDayjsDeferred()
    dayjsDeferredMap.set('de-DE', dDayjsCur)
    const curCb = vi.fn()
    const pCur = (i18n as any).changeLanguage('de-DE', curCb)

    await act(async () => {
      dTransCur.resolve(mockTranslationData['de-DE'])
      await dTransCur.promise
      dDayjsCur.reject(new Error('dayjs current chunk failed'))
      try {
        await dDayjsCur.promise
      } catch {}
      await pCur
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(curCb).toHaveBeenCalledTimes(1)
    expect(curCb.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    expect(mockLoggerError.mock.calls[0][0]).toMatch(/Failed to load Day\.js locale/)
    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')

    mockLoggerError.mockClear()

    const dSlowTrans = createTranslationDeferred('ja-JP')
    translationDeferredMap.set('ja-JP', dSlowTrans)
    const dSlowDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('ja-JP', dSlowDayjs)
    const dFastTrans = createTranslationDeferred('fr-FR')
    translationDeferredMap.set('fr-FR', dFastTrans)
    const dFastDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('fr-FR', dFastDayjs)

    const slowCb = vi.fn()
    const fastCb = vi.fn()
    const pSlow = (i18n as any).changeLanguage('ja-JP', slowCb)
    const pFast = (i18n as any).changeLanguage('fr-FR', fastCb)

    await act(async () => {
      dFastTrans.resolve(mockTranslationData['fr-FR'])
      await dFastTrans.promise
      dFastDayjs.resolve()
      await dFastDayjs.promise
      await pFast
    })
    expect(i18n.language).toBe('fr-FR')
    expect(fastCb).toHaveBeenCalled()
    mockLoggerError.mockClear()

    await act(async () => {
      dSlowTrans.resolve(mockTranslationData['ja-JP'])
      await dSlowTrans.promise
      dSlowDayjs.reject(new Error('dayjs stale fail'))
      try {
        await dSlowDayjs.promise
      } catch {}
      await pSlow
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(slowCb).toHaveBeenCalledTimes(1)
    expect(slowCb.mock.calls[0][0] == null).toBe(true)
    expect(i18n.language).toBe('fr-FR')
    expect(dayjs.locale()).toBe('fr')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('current translation failure logs and invokes callback with error; stale does not log', async () => {
    const dFail = createTranslationDeferred('zh-CN')
    translationDeferredMap.set('zh-CN', dFail)
    const cb = vi.fn()
    const p = (i18n as any).changeLanguage('zh-CN', cb)

    await act(async () => {
      dFail.reject(new Error('chunk 404 current'))
      try {
        await dFail.promise
      } catch {}
      await p
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    expect(mockLoggerError.mock.calls[0][0]).toMatch(/Failed to load i18n translation/)
  })

  it('same-language cached activation still invokes callback (no hang) while atomic Day.js + translation stay consistent', async () => {
    translationCache.set('de-DE' as any, mockTranslationData['de-DE'])
    i18n.addResourceBundle('de-DE', 'translation', mockTranslationData['de-DE'], true, true)
    dayjsLocaleCache.add('de-DE' as any)
    await i18n.changeLanguage('de-DE')
    expect(i18n.language).toBe('de-DE')

    const cb = vi.fn()
    const result = await (i18n as any).changeLanguage('de-DE', cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0] == null).toBe(true)
    expect(typeof cb.mock.calls[0][1]).toBe('function')
    expect(result).toBeDefined()
    expect(i18n.language).toBe('de-DE')
  })

  it('initial init readiness: i18n remains initialized and language not pre-activated synchronously (atomic init proof)', async () => {
    expect((i18n as any).isInitialized).toBe(true)
    const d = createTranslationDeferred('zh-CN')
    translationDeferredMap.set('zh-CN', d)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('zh-CN', dDayjs)
    const beforeLang = i18n.language
    const cb = vi.fn()
    const p = (i18n as any).changeLanguage('zh-CN', cb)
    expect(i18n.language).toBe(beforeLang)
    expect(cb).not.toHaveBeenCalled()
    await act(async () => {
      d.resolve(mockTranslationData['zh-CN'])
      await d.promise
      dDayjs.resolve()
      await dDayjs.promise
      await p
    })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0] == null).toBe(true)
    expect(i18n.language).toBe('zh-CN')
  })
})
