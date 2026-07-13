import { useSettings } from '@renderer/hooks/useSettings'
import { ConfigProvider, theme } from 'antd'
import type { FC, PropsWithChildren } from 'react'
import { useEffect, useState } from 'react'

import { useTheme } from './ThemeProvider'

const antdLocaleMap: Record<string, () => Promise<any>> = {
  'de-DE': () => import('antd/locale/de_DE'),
  'el-GR': () => import('antd/locale/el_GR'),
  'en-US': () => import('antd/locale/en_US'),
  'es-ES': () => import('antd/locale/es_ES'),
  'fr-FR': () => import('antd/locale/fr_FR'),
  'ja-JP': () => import('antd/locale/ja_JP'),
  'pt-PT': () => import('antd/locale/pt_PT'),
  'ro-RO': () => import('antd/locale/ro_RO'),
  'ru-RU': () => import('antd/locale/ru_RU'),
  'vi-VN': () => import('antd/locale/vi_VN'),
  'zh-CN': () => import('antd/locale/zh_CN'),
  'zh-TW': () => import('antd/locale/zh_TW')
}

let cachedLocale: any = null
let cachedLang = ''

async function loadAntdLocale(lang: string) {
  if (lang === cachedLang && cachedLocale) return cachedLocale
  const loader = antdLocaleMap[lang] || antdLocaleMap['zh-CN']
  const mod = await loader()
  cachedLocale = mod.default || mod
  cachedLang = lang
  return cachedLocale
}

const AntdProvider: FC<PropsWithChildren> = ({ children }) => {
  const {
    language,
    userTheme: { colorPrimary }
  } = useSettings()
  const { theme: _theme } = useTheme()
  const [locale, setLocale] = useState<any>(null)

  useEffect(() => {
    let cancelled = false
    loadAntdLocale(language)
      .then((loc) => {
        if (!cancelled) setLocale(loc)
      })
      .catch(() => {
        // Handle chunk load failures gracefully — locale stays as null (default)
      })
    return () => {
      cancelled = true
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
