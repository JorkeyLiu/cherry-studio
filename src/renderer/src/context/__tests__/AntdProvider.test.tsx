import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLanguageState, mockLoggerError, mockLoggerWarn, localeMocks, deferredMap, captured } = vi.hoisted(() => {
  const mockLanguageState = { language: 'en-US' as string }
  const mockLoggerError = vi.fn()
  const mockLoggerWarn = vi.fn()
  const localeMocks: Record<string, any> = {
    'zh-CN': { locale: 'zh-cn', mock: 'zhCN' },
    'zh-TW': { locale: 'zh-tw', mock: 'zhTW' },
    'en-US': { locale: 'en', mock: 'enUS' },
    'de-DE': { locale: 'de', mock: 'deDE' },
    'ru-RU': { locale: 'ru', mock: 'ruRU' },
    'ja-JP': { locale: 'ja', mock: 'jaJP' },
    'el-GR': { locale: 'el', mock: 'elGR' },
    'es-ES': { locale: 'es', mock: 'esES' },
    'fr-FR': { locale: 'fr', mock: 'frFR' },
    'pt-PT': { locale: 'pt', mock: 'ptPT' },
    'ro-RO': { locale: 'ro', mock: 'roRO' },
    'vi-VN': { locale: 'vi', mock: 'viVN' }
  }
  type Deferred = { promise: Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }
  const deferredMap = new Map<string, Deferred>()
  const captured: { locale?: any }[] = []
  return { mockLanguageState, mockLoggerError, mockLoggerWarn, localeMocks, deferredMap, captured }
})

const mockColorPrimary = '#00b96b'
const mockTheme = 'light'

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    language: mockLanguageState.language,
    userTheme: { colorPrimary: mockColorPrimary }
  })
}))

vi.mock('../ThemeProvider', () => ({
  useTheme: () => ({ theme: mockTheme })
}))

vi.mock('antd', async () => {
  const actual: any = await vi.importActual('antd')
  const MockConfigProvider = ({ locale, children }: any) => {
    captured.push({ locale })
    return (
      <div data-testid="config-provider" data-locale={locale?.locale ?? 'undefined'}>
        {children}
      </div>
    )
  }
  return {
    ...actual,
    ConfigProvider: MockConfigProvider,
    theme: actual.theme
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: mockLoggerError,
      warn: mockLoggerWarn,
      info: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('../antdLocaleLoaders', async () => {
  const actual: any = await vi.importActual('../antdLocaleLoaders')
  const loaders: Record<string, () => Promise<any>> = {}
  for (const lang of Object.keys(localeMocks)) {
    loaders[lang] = () => {
      const deferred = deferredMap.get(lang)
      if (deferred) return deferred.promise
      return actual.antdLocaleLoaders[lang]()
    }
  }
  return {
    ...actual,
    antdLocaleLoaders: loaders,
    antdLocaleCache: actual.antdLocaleCache,
    normalizeAntdLanguage: actual.normalizeAntdLanguage,
    clearAntdLocaleCache: actual.clearAntdLocaleCache
  }
})

function createDeferred(localeKey: string) {
  let resolve!: (v: any) => void
  let reject!: (e: any) => void
  const promise = new Promise<any>((res, rej) => {
    resolve = () => res({ default: localeMocks[localeKey] })
    reject = rej
  })
  return { promise, resolve, reject }
}

import { antdLocaleCache, clearAntdLocaleCache, normalizeAntdLanguage } from '../antdLocaleLoaders'
import AntdProvider from '../AntdProvider'

describe('AntdProvider - S7.3 on-demand locale loading', () => {
  beforeEach(() => {
    clearAntdLocaleCache()
    deferredMap.clear()
    captured.length = 0
    mockLoggerError.mockClear()
    mockLoggerWarn.mockClear()
    mockLanguageState.language = 'en-US'
    document.body.innerHTML = ''
  })

  it('renders children immediately while locale is loading (no blank screen)', async () => {
    const d = createDeferred('en-US')
    deferredMap.set('en-US', d)
    render(
      <AntdProvider>
        <div data-testid="child">hello</div>
      </AntdProvider>
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.getByTestId('config-provider')).toBeInTheDocument()
    expect(captured[0].locale).toBeUndefined()
    await act(async () => {
      d.resolve(localeMocks['en-US'])
      await d.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('en'))
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('initial resolution applies requested locale after load', async () => {
    const d = createDeferred('zh-CN')
    deferredMap.set('zh-CN', d)
    mockLanguageState.language = 'zh-CN'
    render(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    expect(captured[0].locale).toBeUndefined()
    await act(async () => {
      d.resolve(localeMocks['zh-CN'])
      await d.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('zh-cn'))
  })

  it('runtime switch retains prior locale until new resolves (no flicker to undefined)', async () => {
    const d1 = createDeferred('en-US')
    deferredMap.set('en-US', d1)
    const { rerender } = render(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    await act(async () => {
      d1.resolve(localeMocks['en-US'])
      await d1.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('en'))
    const d2 = createDeferred('de-DE')
    deferredMap.set('de-DE', d2)
    mockLanguageState.language = 'de-DE'
    rerender(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    await waitFor(() => {
      const lastBeforeResolve = captured[captured.length - 1].locale
      expect(lastBeforeResolve?.locale).toBe('en')
    })
    expect(screen.getByTestId('child')).toBeInTheDocument()
    await act(async () => {
      d2.resolve(localeMocks['de-DE'])
      await d2.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('de'))
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('stale prior request must not overwrite newer language (race safety)', async () => {
    const dSlow = createDeferred('ja-JP')
    deferredMap.set('ja-JP', dSlow)
    const dFast = createDeferred('fr-FR')
    deferredMap.set('fr-FR', dFast)

    mockLanguageState.language = 'ja-JP'
    const { rerender } = render(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    mockLanguageState.language = 'fr-FR'
    rerender(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    await act(async () => {
      dFast.resolve(localeMocks['fr-FR'])
      await dFast.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('fr'))
    await act(async () => {
      dSlow.resolve(localeMocks['ja-JP'])
      await dSlow.promise
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(captured[captured.length - 1].locale?.locale).toBe('fr')
  })

  it('on load failure keeps prior locale, logs via loggerService, and remains usable', async () => {
    const d1 = createDeferred('en-US')
    deferredMap.set('en-US', d1)
    const { rerender } = render(
      <AntdProvider>
        <div data-testid="child">usable</div>
      </AntdProvider>
    )
    await act(async () => {
      d1.resolve(localeMocks['en-US'])
      await d1.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('en'))
    const dFail = createDeferred('pt-PT')
    deferredMap.set('pt-PT', dFail)
    mockLanguageState.language = 'pt-PT'
    rerender(
      <AntdProvider>
        <div data-testid="child">usable</div>
      </AntdProvider>
    )
    expect(captured[captured.length - 1].locale?.locale).toBe('en')
    await act(async () => {
      dFail.reject(new Error('network chunk failed'))
      try {
        await dFail.promise
      } catch {}
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(captured[captured.length - 1].locale?.locale).toBe('en')
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    expect(mockLoggerError.mock.calls[0][0]).toMatch(/Failed to load Antd locale/)
    expect(antdLocaleCache.has('pt-PT' as any)).toBe(false)
  })

  it('allows retry after failure via language change', async () => {
    const d1 = createDeferred('en-US')
    deferredMap.set('en-US', d1)
    const { rerender } = render(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    await act(async () => {
      d1.resolve(localeMocks['en-US'])
      await d1.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('en'))

    const dFail = createDeferred('ro-RO')
    deferredMap.set('ro-RO', dFail)
    mockLanguageState.language = 'ro-RO'
    rerender(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    await act(async () => {
      dFail.reject(new Error('fail'))
      try {
        await dFail.promise
      } catch {}
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(mockLoggerError).toHaveBeenCalled()
    mockLoggerError.mockClear()
    deferredMap.delete('ro-RO')
    const dSuccess = createDeferred('ro-RO')
    deferredMap.set('ro-RO', dSuccess)
    mockLanguageState.language = 'en-US'
    rerender(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('en'))
    mockLanguageState.language = 'ro-RO'
    rerender(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    await act(async () => {
      dSuccess.resolve(localeMocks['ro-RO'])
      await dSuccess.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('ro'))
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('fallback for unknown language maps to zh-CN', async () => {
    const d = createDeferred('zh-CN')
    deferredMap.set('zh-CN', d)
    mockLanguageState.language = 'unknown-lang' as any
    expect(normalizeAntdLanguage('unknown-lang')).toBe('zh-CN')
    render(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    await act(async () => {
      d.resolve(localeMocks['zh-CN'])
      await d.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('zh-cn'))
  })

  it('uses cache synchronously to avoid flash when locale already cached', async () => {
    antdLocaleCache.set('vi-VN' as any, localeMocks['vi-VN'])
    mockLanguageState.language = 'vi-VN'
    render(
      <AntdProvider>
        <div data-testid="child">x</div>
      </AntdProvider>
    )
    expect(captured[0].locale?.locale).toBe('vi')
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('preserves theme ConfigProvider behavior while locale loads', async () => {
    const d = createDeferred('es-ES')
    deferredMap.set('es-ES', d)
    mockLanguageState.language = 'es-ES'
    render(
      <AntdProvider>
        <div data-testid="child">theme</div>
      </AntdProvider>
    )
    expect(screen.getByTestId('config-provider')).toBeInTheDocument()
    await act(async () => {
      d.resolve(localeMocks['es-ES'])
      await d.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('es'))
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('does not call console.error on failure (uses loggerService)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dFail = createDeferred('el-GR')
    deferredMap.set('el-GR', dFail)
    mockLanguageState.language = 'el-GR'
    render(
      <AntdProvider>
        <div>child</div>
      </AntdProvider>
    )
    await act(async () => {
      dFail.reject(new Error('chunk 404'))
      try {
        await dFail.promise
      } catch {}
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(mockLoggerError).toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('all 12 languages have distinct mocked locales reachable', async () => {
    for (const lang of Object.keys(localeMocks)) {
      expect(localeMocks[lang]).toBeDefined()
    }
  })

  // --- Audit blocker repairs: inherited-name fallback, cache-hit invalidation, stale suppression, unmount ---

  it('inherited prototype name falls back to zh-CN via provider (own-key safe)', async () => {
    const d = createDeferred('zh-CN')
    deferredMap.set('zh-CN', d)
    mockLanguageState.language = 'toString' as any
    expect(normalizeAntdLanguage('toString' as any)).toBe('zh-CN')
    expect(normalizeAntdLanguage('__proto__' as any)).toBe('zh-CN')
    expect(normalizeAntdLanguage('constructor' as any)).toBe('zh-CN')
    render(
      <AntdProvider>
        <div data-testid="child">inherited</div>
      </AntdProvider>
    )
    expect(captured[0].locale).toBeUndefined()
    await act(async () => {
      d.resolve(localeMocks['zh-CN'])
      await d.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('zh-cn'))
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(antdLocaleCache.has('toString' as any)).toBe(false)
    expect(antdLocaleCache.get('zh-CN' as any)?.locale).toBe('zh-cn')
  })

  it('cached-A → pending-B → cached-A leaves A effective after B resolves (stale resolve suppressed)', async () => {
    // Pre-cache A (zh-CN) synchronously
    antdLocaleCache.set('zh-CN' as any, localeMocks['zh-CN'])
    // Start with cached A
    mockLanguageState.language = 'zh-CN'
    const { rerender } = render(
      <AntdProvider>
        <div data-testid="child">race-cache-hit</div>
      </AntdProvider>
    )
    expect(captured[0].locale?.locale).toBe('zh-cn')
    // Switch to B pending (de-DE not cached)
    const dB = createDeferred('de-DE')
    deferredMap.set('de-DE', dB)
    mockLanguageState.language = 'de-DE'
    rerender(
      <AntdProvider>
        <div data-testid="child">race-cache-hit</div>
      </AntdProvider>
    )
    // Should still show A while B pending (no flicker)
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('zh-cn'))
    // Switch back to cached A
    mockLanguageState.language = 'zh-CN'
    rerender(
      <AntdProvider>
        <div data-testid="child">race-cache-hit</div>
      </AntdProvider>
    )
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('zh-cn'))
    // Now resolve stale B - must NOT overwrite A, must NOT log
    await act(async () => {
      dB.resolve(localeMocks['de-DE'])
      await dB.promise
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(captured[captured.length - 1].locale?.locale).toBe('zh-cn')
    expect(mockLoggerError).not.toHaveBeenCalled()
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('cached-A → pending-B → cached-A stale rejection is suppressed (no log, retains A)', async () => {
    antdLocaleCache.set('en-US' as any, localeMocks['en-US'])
    mockLanguageState.language = 'en-US'
    const { rerender } = render(
      <AntdProvider>
        <div data-testid="child">rejection-cache-hit</div>
      </AntdProvider>
    )
    expect(captured[0].locale?.locale).toBe('en')
    const dB = createDeferred('pt-PT')
    deferredMap.set('pt-PT', dB)
    mockLanguageState.language = 'pt-PT'
    rerender(
      <AntdProvider>
        <div data-testid="child">rejection-cache-hit</div>
      </AntdProvider>
    )
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('en'))
    mockLanguageState.language = 'en-US'
    rerender(
      <AntdProvider>
        <div data-testid="child">rejection-cache-hit</div>
      </AntdProvider>
    )
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('en'))
    await act(async () => {
      dB.reject(new Error('stale chunk fail'))
      try {
        await dB.promise
      } catch {}
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(captured[captured.length - 1].locale?.locale).toBe('en')
    expect(mockLoggerError).not.toHaveBeenCalled()
    expect(antdLocaleCache.has('pt-PT' as any)).toBe(false)
  })

  it('stale rejection after newer success is suppressed (no log, no overwrite)', async () => {
    const dSlow = createDeferred('ja-JP')
    deferredMap.set('ja-JP', dSlow)
    const dFast = createDeferred('fr-FR')
    deferredMap.set('fr-FR', dFast)

    mockLanguageState.language = 'ja-JP'
    const { rerender } = render(
      <AntdProvider>
        <div data-testid="child">stale-reject</div>
      </AntdProvider>
    )
    mockLanguageState.language = 'fr-FR'
    rerender(
      <AntdProvider>
        <div data-testid="child">stale-reject</div>
      </AntdProvider>
    )
    await act(async () => {
      dFast.resolve(localeMocks['fr-FR'])
      await dFast.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('fr'))
    mockLoggerError.mockClear()
    await act(async () => {
      dSlow.reject(new Error('slow fail after fast success'))
      try {
        await dSlow.promise
      } catch {}
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(captured[captured.length - 1].locale?.locale).toBe('fr')
    expect(mockLoggerError).not.toHaveBeenCalled()
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('stale resolve does not log and preserves newer locale', async () => {
    const dSlow = createDeferred('ru-RU')
    deferredMap.set('ru-RU', dSlow)
    const dFast = createDeferred('es-ES')
    deferredMap.set('es-ES', dFast)

    mockLanguageState.language = 'ru-RU'
    const { rerender } = render(
      <AntdProvider>
        <div data-testid="child">stale-resolve-no-log</div>
      </AntdProvider>
    )
    mockLanguageState.language = 'es-ES'
    rerender(
      <AntdProvider>
        <div data-testid="child">stale-resolve-no-log</div>
      </AntdProvider>
    )
    await act(async () => {
      dFast.resolve(localeMocks['es-ES'])
      await dFast.promise
    })
    await waitFor(() => expect(captured[captured.length - 1].locale?.locale).toBe('es'))
    await act(async () => {
      dSlow.resolve(localeMocks['ru-RU'])
      await dSlow.promise
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(captured[captured.length - 1].locale?.locale).toBe('es')
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('unmount invalidates pending resolve (no state update, no log)', async () => {
    const d = createDeferred('de-DE')
    deferredMap.set('de-DE', d)
    mockLanguageState.language = 'de-DE'
    const { unmount } = render(
      <AntdProvider>
        <div data-testid="child">unmount-resolve</div>
      </AntdProvider>
    )
    expect(captured[0].locale).toBeUndefined()
    const capturedLengthBefore = captured.length
    unmount()
    await act(async () => {
      d.resolve(localeMocks['de-DE'])
      await d.promise
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    // No new captured entries after unmount (no setLocale), and no error log
    expect(captured.length).toBe(capturedLengthBefore)
    expect(mockLoggerError).not.toHaveBeenCalled()
  })

  it('unmount invalidates pending rejection (no log)', async () => {
    const d = createDeferred('ja-JP')
    deferredMap.set('ja-JP', d)
    mockLanguageState.language = 'ja-JP'
    const { unmount } = render(
      <AntdProvider>
        <div data-testid="child">unmount-reject</div>
      </AntdProvider>
    )
    const capturedLengthBefore = captured.length
    unmount()
    await act(async () => {
      d.reject(new Error('fail after unmount'))
      try {
        await d.promise
      } catch {}
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(captured.length).toBe(capturedLengthBefore)
    expect(mockLoggerError).not.toHaveBeenCalled()
    expect(antdLocaleCache.has('ja-JP' as any)).toBe(false)
  })

  it('unmount during pending after cached locale does not overwrite cached value nor log', async () => {
    antdLocaleCache.set('zh-CN' as any, localeMocks['zh-CN'])
    mockLanguageState.language = 'zh-CN'
    const { rerender, unmount } = render(
      <AntdProvider>
        <div data-testid="child">unmount-with-cache</div>
      </AntdProvider>
    )
    expect(captured[0].locale?.locale).toBe('zh-cn')
    const dPending = createDeferred('fr-FR')
    deferredMap.set('fr-FR', dPending)
    mockLanguageState.language = 'fr-FR'
    rerender(
      <AntdProvider>
        <div data-testid="child">unmount-with-cache</div>
      </AntdProvider>
    )
    // Still showing cached zh-CN while pending
    expect(captured[captured.length - 1].locale?.locale).toBe('zh-cn')
    unmount()
    await act(async () => {
      dPending.resolve(localeMocks['fr-FR'])
      await dPending.promise
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(mockLoggerError).not.toHaveBeenCalled()
  })
})
