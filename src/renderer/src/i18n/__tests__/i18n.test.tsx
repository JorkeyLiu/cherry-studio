import { act, render, screen, waitFor } from '@testing-library/react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearDayjsLocaleCache, dayjsLocaleCache, dayjsLocaleLoaders } from '../dayjsLocaleLoaders'
import i18n from '../index'
import { clearTranslationCache, translationCache, translationLoaders } from '../translationLoaders'

// Hoisted mocks for logger and deferred
const { mockLoggerError } = vi.hoisted(() => {
  return { mockLoggerError: vi.fn() }
})

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

const mockTranslationData: Record<string, Record<string, unknown>> = {
  'en-US': { testKey: 'en-Value', 'chat.default.name': 'Default Assistant' },
  'zh-CN': { testKey: 'zh-Value', 'chat.default.name': '默认助手' },
  'de-DE': { testKey: 'de-Value' },
  'ja-JP': { testKey: 'ja-Value' },
  'fr-FR': { testKey: 'fr-Value' },
  'ru-RU': { testKey: 'ru-Value' },
  'es-ES': { testKey: 'es-Value' },
  'pt-PT': { testKey: 'pt-Value' },
  'ro-RO': { testKey: 'ro-Value' },
  'vi-VN': { testKey: 'vi-Value' },
  'el-GR': { testKey: 'el-Value' },
  'zh-TW': { testKey: 'zh-TW-Value' }
}

type Deferred = { promise: Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }
const translationDeferredMap = new Map<string, Deferred>()
const dayjsDeferredMap = new Map<string, Deferred>()

// Store original loaders
const originalTranslationLoaders: Record<string, () => Promise<any>> = { ...translationLoaders }
const originalDayjsLoaders: Record<string, () => Promise<any>> = { ...dayjsLocaleLoaders }

function createTranslationDeferred(lang: string) {
  let resolve!: (v: any) => void
  let reject!: (e: any) => void
  const promise = new Promise<any>((res, rej) => {
    resolve = (val) => res({ default: val })
    reject = rej
  })
  return { promise, resolve: (data?: any) => resolve(data ?? mockTranslationData[lang] ?? { testKey: lang }), reject }
}

function createDayjsDeferred(_lang: string) {
  let resolve!: (v: any) => void
  let reject!: (e: any) => void
  const promise = new Promise<any>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve: () => resolve({}), reject }
}

function I18nConsumer({ testKey = 'testKey' }: { testKey?: string }) {
  const { t } = useTranslation()
  return <div data-testid="t-output">{t(testKey)}</div>
}

describe('i18n - S7.4 on-demand translation and Day.js locale', () => {
  beforeEach(async () => {
    mockLoggerError.mockClear()
    clearTranslationCache()
    clearDayjsLocaleCache()
    translationDeferredMap.clear()
    dayjsDeferredMap.clear()
    dayjs.locale('en')
    // restore loaders to deferred-aware wrappers
    for (const lang of Object.keys(originalTranslationLoaders)) {
      // @ts-ignore
      translationLoaders[lang as any] = () => {
        const d = translationDeferredMap.get(lang)
        if (d) return d.promise
        // return mock data immediately if not deferred, via resolved promise
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
    // reset i18n state: remove bundles, set language to en-US with mock data
    // ensure en-US bundle exists so initial state deterministic
    for (const lng of Object.keys(mockTranslationData)) {
      if (i18n.hasResourceBundle(lng, 'translation')) {
        i18n.removeResourceBundle(lng, 'translation')
      }
    }
    translationCache.set('en-US' as any, mockTranslationData['en-US'])
    i18n.addResourceBundle('en-US', 'translation', mockTranslationData['en-US'], true, true)
    await i18n.changeLanguage('en-US')
    dayjs.locale('en')
    // clear again to test loading via deferred
    i18n.removeResourceBundle('en-US', 'translation')
    translationCache.delete('en-US' as any)
    dayjsLocaleCache.delete('en-US' as any)
    // Re-add en-US for baseline but via cache so next change can be deferred
    // Actually we want baseline en-US loaded synchronously for tests that need previous
    translationCache.set('en-US' as any, mockTranslationData['en-US'])
    i18n.addResourceBundle('en-US', 'translation', mockTranslationData['en-US'], true, true)
    await i18n.changeLanguage('en-US')
  })

  afterEach(() => {
    // restore original loaders
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

  it('renders children immediately while translation loading (no blank)', async () => {
    const d = createTranslationDeferred('en-US')
    translationDeferredMap.set('en-US', d)
    // remove cache so load will pending
    translationCache.delete('en-US' as any)
    i18n.removeResourceBundle('en-US', 'translation')
    // start change but not yet resolved
    const promise = i18n.changeLanguage('en-US')
    render(<I18nConsumer />)
    expect(screen.getByTestId('t-output')).toBeInTheDocument()
    // while pending, t should fallback to key or previous (en-US not yet loaded, so key)
    // but UI not blank - element exists
    await act(async () => {
      d.resolve(mockTranslationData['en-US'])
      await d.promise
      await promise
    })
    await waitFor(() => expect(i18n.language).toBe('en-US'))
    expect(screen.getByTestId('t-output')).toBeInTheDocument()
  })

  it('runtime switch retains prior locale until new resolves (no flicker)', async () => {
    // baseline en-US already loaded
    expect(i18n.language).toBe('en-US')
    expect(i18n.t('testKey')).toBe('en-Value')
    const dDe = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', dDe)
    const dDayjsDe = createDayjsDeferred('de-DE')
    dayjsDeferredMap.set('de-DE', dDayjsDe)
    const promise = i18n.changeLanguage('de-DE')
    // while pending, language should still be en-US and translation still en
    expect(i18n.language).toBe('en-US')
    expect(i18n.t('testKey')).toBe('en-Value')
    expect(dayjs.locale()).toBe('en')
    await act(async () => {
      dDe.resolve(mockTranslationData['de-DE'])
      await dDe.promise
      dDayjsDe.resolve()
      await dDayjsDe.promise
      await promise
    })
    await waitFor(() => expect(i18n.language).toBe('de-DE'))
    expect(i18n.t('testKey')).toBe('de-Value')
    expect(dayjs.locale()).toBe('de')
  })

  it('stale prior request must not overwrite newer language (race safety)', async () => {
    const dSlow = createTranslationDeferred('ja-JP')
    translationDeferredMap.set('ja-JP', dSlow)
    const dSlowDayjs = createDayjsDeferred('ja-JP')
    dayjsDeferredMap.set('ja-JP', dSlowDayjs)
    const dFast = createTranslationDeferred('fr-FR')
    translationDeferredMap.set('fr-FR', dFast)
    const dFastDayjs = createDayjsDeferred('fr-FR')
    dayjsDeferredMap.set('fr-FR', dFastDayjs)

    const pSlow = i18n.changeLanguage('ja-JP')
    const pFast = i18n.changeLanguage('fr-FR')

    await act(async () => {
      dFast.resolve(mockTranslationData['fr-FR'])
      await dFast.promise
      dFastDayjs.resolve()
      await dFastDayjs.promise
      await pFast
    })
    await waitFor(() => expect(i18n.language).toBe('fr-FR'))
    expect(i18n.t('testKey')).toBe('fr-Value')
    expect(dayjs.locale()).toBe('fr')

    await act(async () => {
      dSlow.resolve(mockTranslationData['ja-JP'])
      await dSlow.promise
      dSlowDayjs.resolve()
      await dSlowDayjs.promise
      try {
        await pSlow
      } catch {}
      await new Promise((r) => setTimeout(r, 10))
    })
    // stale slow should not overwrite fast
    expect(i18n.language).toBe('fr-FR')
    expect(i18n.t('testKey')).toBe('fr-Value')
    expect(dayjs.locale()).toBe('fr')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('on load failure keeps prior locale, logs via loggerService, remains usable', async () => {
    expect(i18n.language).toBe('en-US')
    const dFail = createTranslationDeferred('pt-PT')
    translationDeferredMap.set('pt-PT', dFail)
    const failDayjs = createDayjsDeferred('pt-PT')
    dayjsDeferredMap.set('pt-PT', failDayjs)

    const promise = i18n.changeLanguage('pt-PT')
    // still en before failure
    expect(i18n.language).toBe('en-US')
    await act(async () => {
      dFail.reject(new Error('network chunk failed'))
      try {
        await dFail.promise
      } catch {}
      failDayjs.resolve()
      await failDayjs.promise
      await promise
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(i18n.language).toBe('en-US')
    expect(i18n.t('testKey')).toBe('en-Value')
    expect(dayjs.locale()).toBe('en')
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    expect(mockLoggerError.mock.calls[0][0]).toMatch(/Failed to load i18n translation/)
    expect(translationCache.has('pt-PT' as any)).toBe(false)
    render(<I18nConsumer />)
    expect(screen.getByTestId('t-output')).toBeInTheDocument()
  })

  it('stale rejection after newer success is suppressed (no log)', async () => {
    const dSlow = createTranslationDeferred('ja-JP')
    translationDeferredMap.set('ja-JP', dSlow)
    const dSlowDayjs = createDayjsDeferred('ja-JP')
    dayjsDeferredMap.set('ja-JP', dSlowDayjs)
    const dFast = createTranslationDeferred('fr-FR')
    translationDeferredMap.set('fr-FR', dFast)
    const dFastDayjs = createDayjsDeferred('fr-FR')
    dayjsDeferredMap.set('fr-FR', dFastDayjs)

    const pSlow = i18n.changeLanguage('ja-JP')
    const pFast = i18n.changeLanguage('fr-FR')

    await act(async () => {
      dFast.resolve(mockTranslationData['fr-FR'])
      await dFast.promise
      dFastDayjs.resolve()
      await dFastDayjs.promise
      await pFast
    })
    await waitFor(() => expect(i18n.language).toBe('fr-FR'))
    mockLoggerError.mockClear()
    await act(async () => {
      dSlow.reject(new Error('slow fail after fast success'))
      try {
        await dSlow.promise
      } catch {}
      dSlowDayjs.resolve()
      await dSlowDayjs.promise
      try {
        await pSlow
      } catch {}
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(i18n.language).toBe('fr-FR')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('fallback for unknown language maps to en-US', async () => {
    const d = createTranslationDeferred('en-US')
    translationDeferredMap.set('en-US', d)
    // remove en-US cache to force load
    translationCache.delete('en-US' as any)
    i18n.removeResourceBundle('en-US', 'translation')
    const promise = i18n.changeLanguage('unknown-lang' as any)
    await act(async () => {
      d.resolve(mockTranslationData['en-US'])
      await d.promise
      await promise
    })
    await waitFor(() => expect(i18n.language).toBe('en-US'))
    expect(i18n.t('testKey')).toBe('en-Value')
    expect(translationCache.has('en-US' as any)).toBe(true)
    expect(translationCache.has('unknown-lang' as any)).toBe(false)
  })

  it('uses cache synchronously to avoid flash when already cached', async () => {
    // pre-cache de-DE
    translationCache.set('de-DE' as any, mockTranslationData['de-DE'])
    i18n.addResourceBundle('de-DE', 'translation', mockTranslationData['de-DE'], true, true)
    dayjsLocaleCache.add('de-DE' as any)
    await i18n.changeLanguage('de-DE')
    expect(i18n.language).toBe('de-DE')
    // now switch to cached language - should be synchronous (no pending)
    const before = i18n.language
    await i18n.changeLanguage('de-DE')
    expect(i18n.language).toBe(before)
  })

  it('does not call console.error on failure (uses loggerService)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dFail = createTranslationDeferred('el-GR')
    translationDeferredMap.set('el-GR', dFail)
    const p = i18n.changeLanguage('el-GR')
    await act(async () => {
      dFail.reject(new Error('chunk 404'))
      try {
        await dFail.promise
      } catch {}
      await p
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(mockLoggerError).toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('dayjs locale preserves previous until new resolves (no blank)', async () => {
    expect(dayjs.locale()).toBe('en')
    const dDayjs = createDayjsDeferred('de-DE')
    dayjsDeferredMap.set('de-DE', dDayjs)
    const dTrans = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', dTrans)
    const p = i18n.changeLanguage('de-DE')
    expect(dayjs.locale()).toBe('en')
    await act(async () => {
      dTrans.resolve(mockTranslationData['de-DE'])
      await dTrans.promise
      // dayjs still en until its deferred resolves
      expect(dayjs.locale()).toBe('en')
      dDayjs.resolve()
      await dDayjs.promise
      await p
    })
    await waitFor(() => expect(dayjs.locale()).toBe('de'))
  })

  it('unmount invalidates pending translation resolve (no state update, no log)', async () => {
    const d = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', d)
    const dDayjs = createDayjsDeferred('de-DE')
    dayjsDeferredMap.set('de-DE', dDayjs)
    // simulate component mount that triggers language change then unmount before resolve
    // we use bump to invalidate
    const p = i18n.changeLanguage('de-DE')
    // bump requestId to simulate unmount / newer request that invalidates
    const { __i18nTestUtils } = await import('../index')
    __i18nTestUtils.bumpTranslationRequestId()
    await act(async () => {
      d.resolve(mockTranslationData['de-DE'])
      await d.promise
      dDayjs.resolve()
      await dDayjs.promise
      try {
        await p
      } catch {}
      await new Promise((r) => setTimeout(r, 10))
    })
    // should remain en-US, not de-DE, and no error log
    expect(i18n.language).toBe('en-US')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('unmount invalidates pending dayjs rejection (no log)', async () => {
    const { setDayjsLocale, __i18nTestUtils } = await import('../index')
    const d = createDayjsDeferred('ja-JP')
    dayjsDeferredMap.set('ja-JP', d)
    // trigger setDayjsLocale which uses dayjsRequestId
    setDayjsLocale('ja-JP')
    __i18nTestUtils.bumpDayjsRequestId()
    await act(async () => {
      d.reject(new Error('fail after unmount'))
      try {
        await d.promise
      } catch {}
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(dayjs.locale()).toBe('en')
    expect(mockLoggerError).not.toHaveBeenCalled()
    expect(dayjsLocaleCache.has('ja-JP' as any)).toBe(false)
  })

  it('translation success + Day.js failure leaves both at previous successful locale and logs Day.js failure (atomic)', async () => {
    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')
    const { __i18nTestUtils } = await import('../index')
    expect(__i18nTestUtils.lastSuccessfulTranslationLanguage).toBe('en-US')
    // set lastSuccessfulDayjs to en-US via baseline change
    // de-DE translation will succeed, Day.js loader will reject
    const dTrans = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', dTrans)
    const dDayjs = createDayjsDeferred('de-DE')
    dayjsDeferredMap.set('de-DE', dDayjs)

    const promise = i18n.changeLanguage('de-DE')
    // while pending, both remain at previous
    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')

    await act(async () => {
      dTrans.resolve(mockTranslationData['de-DE'])
      await dTrans.promise
      dDayjs.reject(new Error('dayjs chunk failed'))
      try {
        await dDayjs.promise
      } catch {}
      await promise
      await new Promise((r) => setTimeout(r, 10))
    })

    // Atomic: translation must not advance, Day.js must not advance
    expect(i18n.language).toBe('en-US')
    expect(i18n.t('testKey')).toBe('en-Value')
    expect(dayjs.locale()).toBe('en')
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    expect(mockLoggerError.mock.calls[0][0]).toMatch(/Failed to load Day\.js locale/)
    expect(mockLoggerError.mock.calls[0][1]).toBeInstanceOf(Error)
    // translation bundle must not be activated even though loadTranslation cached data
    expect(i18n.hasResourceBundle('de-DE', 'translation')).toBe(false)
    expect(__i18nTestUtils.lastSuccessfulTranslationLanguage).toBe('en-US')
    expect(__i18nTestUtils.lastSuccessfulDayjsLanguage).toBe('en-US')
    expect(dayjsLocaleCache.has('de-DE' as any)).toBe(false)

    // Recovery: subsequent successful switch must still work
    mockLoggerError.mockClear()
    const dTrans2 = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', dTrans2)
    const dDayjs2 = createDayjsDeferred('de-DE')
    dayjsDeferredMap.set('de-DE', dDayjs2)
    const p2 = i18n.changeLanguage('de-DE')
    await act(async () => {
      dTrans2.resolve(mockTranslationData['de-DE'])
      await dTrans2.promise
      dDayjs2.resolve()
      await dDayjs2.promise
      await p2
    })
    await waitFor(() => expect(i18n.language).toBe('de-DE'))
    expect(i18n.t('testKey')).toBe('de-Value')
    expect(dayjs.locale()).toBe('de')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('Day.js loader failure for cached translation still preserves previous Day.js locale', async () => {
    // Pre-cache translation for fr-FR but not Day.js
    translationCache.set('fr-FR' as any, mockTranslationData['fr-FR'])
    i18n.addResourceBundle('fr-FR', 'translation', mockTranslationData['fr-FR'], true, true)
    // Ensure fr-FR Day.js not cached
    dayjsLocaleCache.delete('fr-FR' as any)
    // But we remove bundle to force load path through cache? Actually loadTranslation will return cached immediately
    // To force Day.js failure path, we need to delete cache and use deferred
    translationCache.delete('fr-FR' as any)
    i18n.removeResourceBundle('fr-FR', 'translation')
    const dTrans = createTranslationDeferred('fr-FR')
    translationDeferredMap.set('fr-FR', dTrans)
    const dDayjs = createDayjsDeferred('fr-FR')
    dayjsDeferredMap.set('fr-FR', dDayjs)
    const p = i18n.changeLanguage('fr-FR')
    await act(async () => {
      dTrans.resolve(mockTranslationData['fr-FR'])
      await dTrans.promise
      dDayjs.reject(new Error('dayjs fr failed'))
      try {
        await dDayjs.promise
      } catch {}
      await p
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to load Day\.js locale/),
      expect.any(Error),
      expect.objectContaining({ language: 'fr-FR' })
    )
  })
})
