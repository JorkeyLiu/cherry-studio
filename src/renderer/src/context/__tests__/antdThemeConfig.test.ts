import { ThemeMode } from '@renderer/types'
import { theme } from 'antd'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAntdThemeConfig, readAppliedThemeMode } from '../antdThemeConfig'

/**
 * Shared antd theme configuration contract.
 *
 * The live app and the detached topic-export root must render antd from one
 * configuration source: the same algorithm for the same effective theme, the
 * same tokens and the same component overrides. The builder itself must stay
 * pure — resolving, writing or listening for the global theme is the live
 * `ThemeProvider`'s job, never this function's.
 */

const colorPrimary = '#00b96b'

afterEach(() => {
  document.body.removeAttribute('theme-mode')
  document.documentElement.classList.remove('dark', 'light')
  vi.restoreAllMocks()
})

describe('createAntdThemeConfig', () => {
  it('selects the dark algorithm for the resolved dark theme', () => {
    const config = createAntdThemeConfig({ themeMode: ThemeMode.dark, colorPrimary })

    expect(config.algorithm).toEqual([theme.darkAlgorithm])
    expect(config.cssVar).toBe(true)
    expect(config.hashed).toBe(false)
  })

  it('selects the default (light) algorithm for the resolved light theme', () => {
    const config = createAntdThemeConfig({ themeMode: ThemeMode.light, colorPrimary })

    expect(config.algorithm).toEqual([theme.defaultAlgorithm])
  })

  it('carries the shared tokens and component overrides for both themes', () => {
    const dark = createAntdThemeConfig({ themeMode: ThemeMode.dark, colorPrimary })
    const light = createAntdThemeConfig({ themeMode: ThemeMode.light, colorPrimary })

    for (const config of [dark, light]) {
      expect(config.token?.colorPrimary).toBe(colorPrimary)
      expect(config.token?.fontFamily).toBe('var(--font-family)')
      // The exported thinking-block header must not rely on a light header bg.
      expect(config.components?.Collapse).toEqual({ headerBg: 'transparent' })
      expect(config.components?.Menu).toEqual({ activeBarBorderWidth: 0, darkItemBg: 'transparent' })
    }

    expect(dark.token?.colorBgMask).toBe('rgba(0,0,0,0.7)')
    expect(light.token?.colorBgMask).toBe('rgba(255,255,255,0.8)')
  })

  it('has no global theme side effects', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const matchMedia = vi.spyOn(window, 'matchMedia')

    createAntdThemeConfig({ themeMode: ThemeMode.dark, colorPrimary })

    expect(document.body.getAttribute('theme-mode')).toBeNull()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(setItem).not.toHaveBeenCalled()
    expect(matchMedia).not.toHaveBeenCalled()
  })
})

describe('readAppliedThemeMode', () => {
  it('reads the effective theme the live provider applied, including a system-resolved one', () => {
    // `ThemeProvider` publishes the resolved value (dark here, e.g. a `system`
    // setting resolved by the OS/main process) — the export must follow it.
    document.body.setAttribute('theme-mode', ThemeMode.dark)
    expect(readAppliedThemeMode()).toBe(ThemeMode.dark)
    expect(createAntdThemeConfig({ themeMode: readAppliedThemeMode(), colorPrimary }).algorithm).toEqual([
      theme.darkAlgorithm
    ])

    document.body.setAttribute('theme-mode', ThemeMode.light)
    expect(readAppliedThemeMode()).toBe(ThemeMode.light)
    expect(createAntdThemeConfig({ themeMode: readAppliedThemeMode(), colorPrimary }).algorithm).toEqual([
      theme.defaultAlgorithm
    ])
  })

  it('falls back to the applied document class, then to light', () => {
    document.documentElement.classList.add('dark')
    expect(readAppliedThemeMode()).toBe(ThemeMode.dark)

    document.documentElement.classList.remove('dark')
    expect(readAppliedThemeMode()).toBe(ThemeMode.light)
  })
})
