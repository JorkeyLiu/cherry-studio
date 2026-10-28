import { ThemeMode } from '@renderer/types'
import type { ThemeConfig } from 'antd'
import { theme } from 'antd'

/**
 * The single effective-theme accessor for trees mounted outside the live React
 * app (currently the detached topic-export root).
 *
 * It is the theme the app has *already* applied, so it carries the same
 * resolution the page is rendering: user choice, system preference and
 * main-process pushes are all resolved once by `ThemeProvider`, which publishes
 * the result on `body[theme-mode]` / the document class list. Reading it keeps
 * an offscreen root consistent with the page without a second provider that
 * would resolve, write or listen for theme on its own.
 */
export const readAppliedThemeMode = (): ThemeMode.dark | ThemeMode.light => {
  if (typeof document === 'undefined') return ThemeMode.light
  const applied = document.body?.getAttribute('theme-mode')
  if (applied === ThemeMode.dark) return ThemeMode.dark
  if (applied === ThemeMode.light) return ThemeMode.light
  return document.documentElement?.classList.contains('dark') ? ThemeMode.dark : ThemeMode.light
}

/**
 * Builds the shared antd theme configuration for an effective (`dark`/`light`,
 * never `system`) theme mode.
 *
 * Pure: it derives the config from the resolved mode plus the user's primary
 * color and touches no global state. Both the live app (`AntdProvider`) and the
 * detached export root call it, so the export renders with the app's actual
 * algorithm, tokens and component overrides instead of a second, drifting copy.
 * Anything that is not the resolved dark mode uses antd's default (light)
 * algorithm, matching the live provider.
 */
export const createAntdThemeConfig = ({
  themeMode,
  colorPrimary
}: {
  themeMode: ThemeMode
  colorPrimary: string
}): ThemeConfig => ({
  cssVar: true,
  hashed: false,
  algorithm: [themeMode === ThemeMode.dark ? theme.darkAlgorithm : theme.defaultAlgorithm],
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
    colorPrimary,
    fontFamily: 'var(--font-family)',
    colorBgMask: themeMode === ThemeMode.dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.8)',
    motionDurationMid: '100ms'
  }
})
