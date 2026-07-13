import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const sourcePath = resolve(__dirname, '../CodeStyleProvider.tsx')
const source = readFileSync(sourcePath, 'utf-8')

describe('CodeStyleProvider lazy loading', () => {
  it('should NOT use static wildcard import of @uiw/codemirror-themes-all in source', () => {
    // Should NOT have: import * as cmThemes from '@uiw/codemirror-themes-all'
    expect(source).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+['"]@uiw\/codemirror-themes-all['"]/)
  })

  it('should export a static CM_THEME_NAMES array', () => {
    // Should have a static theme names list exported
    expect(source).toMatch(/export\s+const\s+CM_THEME_NAMES/)
  })

  it('should use dynamic import() for loading CodeMirror themes', () => {
    // Should contain a dynamic import for the theme module
    expect(source).toMatch(/import\(['"]@uiw\/codemirror-themes-all['"]\)/)
  })

  it('should have a cached loader function for CodeMirror themes', () => {
    // Should have a loadCmThemes function
    expect(source).toMatch(/async\s+function\s+loadCmThemes/)
    // Should have a module-level cache
    expect(source).toMatch(/cmThemesCache/)
  })

  it('should have all expected theme names in the static list', () => {
    // Extract CM_THEME_NAMES from source
    const match = source.match(/export\s+const\s+CM_THEME_NAMES:\s*string\[\]\s*=\s*\[([\s\S]*?)\]/)
    expect(match).toBeTruthy()

    const namesStr = match![1]
    const names = namesStr
      .match(/'([^']+)'/g)
      ?.map((s) => s.slice(1, -1))
      .filter(Boolean)

    expect(names).toBeTruthy()

    // Verify core themes are present
    const expectedThemes = [
      'abcdef',
      'dracula',
      'githubDark',
      'githubLight',
      'materialLight',
      'materialDark',
      'nord',
      'tokyoNight',
      'monokai',
      'solarizedDark',
      'solarizedLight',
      'vscodeDark',
      'vscodeLight'
    ]

    for (const theme of expectedThemes) {
      expect(names).toContain(theme)
    }

    // Should have a reasonable number of themes (35+)
    expect(names!.length).toBeGreaterThanOrEqual(35)
  })

  it('should use loadedCmThemes state for theme resolution', () => {
    // Should use state to hold the lazily loaded themes
    expect(source).toMatch(/loadedCmThemes/)
    // Should check if themes are NOT loaded before using built-in fallback
    expect(source).toMatch(/if\s*\(\s*!loadedCmThemes\s*\)/)
  })

  it('should trigger lazy loading via useEffect when codeEditor is enabled', () => {
    // Should have an effect that loads themes when codeEditor is enabled
    expect(source).toMatch(/codeEditor\.enabled\s*&&\s*!loadedCmThemes/)
    expect(source).toMatch(/loadCmThemes\(\)\.then\(setLoadedCmThemes\)/)
  })
})
