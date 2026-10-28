import { loggerService } from '@logger'
import { useSettings } from '@renderer/hooks/useSettings'
import { ConfigProvider } from 'antd'
import type { FC, PropsWithChildren } from 'react'
import { useEffect, useRef, useState } from 'react'

import type { AntdLocale } from './antdLocaleLoaders'
import { antdLocaleCache, antdLocaleLoaders, normalizeAntdLanguage } from './antdLocaleLoaders'
import { createAntdThemeConfig } from './antdThemeConfig'
import { useTheme } from './ThemeProvider'

const logger = loggerService.withContext('AntdProvider')

const AntdProvider: FC<PropsWithChildren> = ({ children }) => {
  const {
    language,
    userTheme: { colorPrimary }
  } = useSettings()
  const { theme: _theme } = useTheme()
  const [locale, setLocale] = useState<AntdLocale | undefined>(() => {
    const normalized = normalizeAntdLanguage(language as string)
    return antdLocaleCache.get(normalized)
  })
  const requestIdRef = useRef(0)

  useEffect(() => {
    const normalized = normalizeAntdLanguage(language as string)
    const requestId = ++requestIdRef.current
    const cached = antdLocaleCache.get(normalized)
    if (cached) {
      setLocale(cached)
      return () => {
        if (requestIdRef.current === requestId) {
          requestIdRef.current++
        }
      }
    }
    const loader = antdLocaleLoaders[normalized]
    loader()
      .then((mod) => {
        const loaded = (mod as { default: AntdLocale }).default ?? (mod as unknown as AntdLocale)
        antdLocaleCache.set(normalized, loaded)
        if (requestIdRef.current !== requestId) {
          return
        }
        setLocale(loaded)
      })
      .catch((error) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        logger.error('Failed to load Antd locale', error as Error, { language: normalized })
      })
    return () => {
      if (requestIdRef.current === requestId) {
        requestIdRef.current++
      }
    }
  }, [language])

  return (
    <ConfigProvider locale={locale} theme={createAntdThemeConfig({ themeMode: _theme, colorPrimary })}>
      {children}
    </ConfigProvider>
  )
}

export default AntdProvider
