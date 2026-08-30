import * as fs from 'node:fs'
import * as path from 'node:path'

import { clearDayjsLocaleCache, dayjsLocaleLoaders } from '@renderer/i18n/dayjsLocaleLoaders'
import { clearTranslationCache, translationCache, translationLoaders } from '@renderer/i18n/translationLoaders'
import { act } from '@testing-library/react'
import dayjs from 'dayjs'
import { describe, expect, it, vi } from 'vitest'

// Hoisted logger mock
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

describe('useAppInit i18n integration — coordinated Day.js ownership (S7.4)', () => {
  it('source file no longer imports or calls setDayjsLocale (divergence eliminated)', () => {
    const filePath = path.join(process.cwd(), 'src/renderer/src/hooks/useAppInit.ts')
    const source = fs.readFileSync(filePath, 'utf-8')
    // Must import i18n default only, not setDayjsLocale
    expect(source).toContain("import i18n from '@renderer/i18n'")
    expect(source).not.toMatch(/import\s+i18n,\s*\{\s*setDayjsLocale\s*\}/)
    expect(source).not.toContain('setDayjsLocale')
    // The language effect must be exactly void i18n.changeLanguage(currentLanguage) with no second call
    const langEffect = source.match(
      /useEffect\(\(\)\s*=>\s*\{\s*const currentLanguage[\s\S]*?void i18n\.changeLanguage\(currentLanguage\)[\s\S]*?\},\s*\[language\]\)/
    )
    expect(langEffect).not.toBeNull()
    expect(source).not.toMatch(/void i18n\.changeLanguage\(currentLanguage\)\s*\n\s*setDayjsLocale/)
  })

  it('coordinated path is sole owner: simulated useAppInit language switch via i18n.changeLanguage keeps Day.js atomic (no independent ahead activation)', async () => {
    const mockTranslationData: Record<string, Record<string, unknown>> = {
      'en-US': { testKey: 'en-Value' },
      'de-DE': { testKey: 'de-Value' }
    }

    const translationDeferredMap = new Map<
      string,
      { promise: Promise<any>; resolve: (v?: any) => void; reject: (e: any) => void }
    >()
    const dayjsDeferredMap = new Map<string, { promise: Promise<any>; resolve: () => void; reject: (e: any) => void }>()

    function createTranslationDeferred(lang: string) {
      let resolve!: (v: any) => void
      let reject!: (e: any) => void
      const promise = new Promise<any>((res, rej) => {
        resolve = (val) => res({ default: val })
        reject = rej
      })
      return {
        promise,
        resolve: (data?: any) => resolve(data ?? mockTranslationData[lang] ?? { testKey: lang }),
        reject
      }
    }
    function createDayjsDeferred() {
      let resolve!: (v: any) => void
      let reject!: (e: any) => void
      const promise = new Promise<any>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve: () => resolve({}), reject }
    }

    const i18n = (await import('@renderer/i18n')).default
    mockLoggerError.mockClear()
    clearTranslationCache()
    clearDayjsLocaleCache()
    translationDeferredMap.clear()
    dayjsDeferredMap.clear()
    dayjs.locale('en')
    const originalTranslationLoaders: Record<string, () => Promise<any>> = { ...translationLoaders }
    const originalDayjsLoaders: Record<string, () => Promise<any>> = { ...dayjsLocaleLoaders }
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

    // Simulate useAppInit effect: void i18n.changeLanguage(currentLanguage) only
    const dTrans = createTranslationDeferred('de-DE')
    translationDeferredMap.set('de-DE', dTrans)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('de-DE', dDayjs)

    const dayjsSpy = vi.spyOn(dayjs as any, 'locale')
    const promise = i18n.changeLanguage('de-DE')

    // While pending, Day.js must not have been switched ahead (no independent call)
    expect(dayjs.locale()).toBe('en')
    expect(dayjsSpy).not.toHaveBeenCalledWith('de')

    await act(async () => {
      dTrans.resolve(mockTranslationData['de-DE'])
      await dTrans.promise
      dDayjs.resolve()
      await dDayjs.promise
      await promise
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(i18n.language).toBe('de-DE')
    expect(dayjs.locale()).toBe('de')
    expect(dayjsSpy).toHaveBeenCalledWith('de')

    dayjsSpy.mockRestore()
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
  })

  it('simulated useAppInit path retains previous when Day.js fails (atomic)', async () => {
    const mockTranslationData: Record<string, Record<string, unknown>> = {
      'en-US': { testKey: 'en-Value' },
      'ja-JP': { testKey: 'ja-Value' }
    }

    const translationDeferredMap = new Map<
      string,
      { promise: Promise<any>; resolve: (v?: any) => void; reject: (e: any) => void }
    >()
    const dayjsDeferredMap = new Map<string, { promise: Promise<any>; resolve: () => void; reject: (e: any) => void }>()

    function createTranslationDeferred(lang: string) {
      let resolve!: (v: any) => void
      let reject!: (e: any) => void
      const promise = new Promise<any>((res, rej) => {
        resolve = (val) => res({ default: val })
        reject = rej
      })
      return {
        promise,
        resolve: (data?: any) => resolve(data ?? mockTranslationData[lang] ?? { testKey: lang }),
        reject
      }
    }
    function createDayjsDeferred() {
      let resolve!: (v: any) => void
      let reject!: (e: any) => void
      const promise = new Promise<any>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve: () => resolve({}), reject }
    }

    const i18n = (await import('@renderer/i18n')).default
    mockLoggerError.mockClear()
    clearTranslationCache()
    clearDayjsLocaleCache()
    translationDeferredMap.clear()
    dayjsDeferredMap.clear()
    dayjs.locale('en')
    const originalTranslationLoaders: Record<string, () => Promise<any>> = { ...translationLoaders }
    const originalDayjsLoaders: Record<string, () => Promise<any>> = { ...dayjsLocaleLoaders }
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

    const dTrans = createTranslationDeferred('ja-JP')
    translationDeferredMap.set('ja-JP', dTrans)
    const dDayjs = createDayjsDeferred()
    dayjsDeferredMap.set('ja-JP', dDayjs)

    const promise = i18n.changeLanguage('ja-JP')

    await act(async () => {
      dTrans.resolve(mockTranslationData['ja-JP'])
      await dTrans.promise
      dDayjs.reject(new Error('dayjs fail via useAppInit'))
      try {
        await dDayjs.promise
      } catch {}
      await promise
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(i18n.language).toBe('en-US')
    expect(dayjs.locale()).toBe('en')
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to load Day\.js locale/),
      expect.any(Error),
      expect.objectContaining({ language: 'ja-JP' })
    )

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
  })
})
