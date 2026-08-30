import { loggerService } from '@logger'
import { useSettings } from '@renderer/hooks/useSettings'
import { ConfigProvider, theme } from 'antd'
import type { FC, PropsWithChildren } from 'react'
import { useEffect, useRef, useState } from 'react'

import type { AntdLocale } from './antdLocaleLoaders'
import { antdLocaleCache, antdLocaleLoaders, normalizeAntdLanguage } from './antdLocaleLoaders'
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
    <ConfigProvider
      locale={locale}
      theme={{
        cssVar: true,
        hashed: false,
        algorithm: [_theme === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm],
        components: {
          Menu: {
            activeBarBorderWidth: 0,
            darkItemBg: 'transparent'
          },
          Button: {
            boxShadow: 'none',
            boxShadowSecondary: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
            primaryShadow: 'none',
            controlHeight: 30,
            paddingInline: 10
          },
          Input: {
            controlHeight: 30,
            colorBorder: 'var(--color-border)'
          },
          InputNumber: {
            controlHeight: 30,
            colorBorder: 'var(--color-border)'
          },
          Select: {
            controlHeight: 30,
            colorBorder: 'var(--color-border)'
          },
          Collapse: {
            headerBg: 'transparent'
          },
          Tooltip: {
            fontSize: 13
          },
          ColorPicker: {
            fontFamily: 'var(--code-font-family)'
          },
          Segmented: {
            itemActiveBg: 'var(--color-background-soft)',
            itemHoverBg: 'var(--color-background-soft)',
            trackBg: 'rgba(153,153,153,0.15)'
          },
          Switch: {
            colorTextQuaternary: 'rgba(153,153,153,0.20)',
            trackMinWidth: 40,
            handleSize: 19,
            trackMinWidthSM: 28,
            trackHeightSM: 17,
            handleSizeSM: 14,
            trackPadding: 1.5
          },
          Dropdown: {
            controlPaddingHorizontal: 8,
            borderRadiusLG: 10,
            borderRadiusSM: 8,
            paddingXS: 4
          },
          Popover: {
            borderRadiusLG: 10
          },
          Slider: {
            handleLineWidth: 1.5,
            handleSize: 15,
            handleSizeHover: 15,
            dotSize: 7,
            railSize: 5,
            colorBgElevated: '#ffffff'
          },
          Modal: {
            colorBgElevated: 'var(--modal-background)'
          },
          Divider: {
            colorSplit: 'rgba(128,128,128,0.15)'
          },
          Splitter: {
            splitBarDraggableSize: 0,
            splitBarSize: 0.5,
            splitTriggerSize: 10
          }
        },
        token: {
          colorPrimary: colorPrimary,
          fontFamily: 'var(--font-family)',
          colorBgMask: _theme === 'dark' ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.8)',
          motionDurationMid: '100ms'
        }
      }}>
      {children}
    </ConfigProvider>
  )
}

export default AntdProvider
