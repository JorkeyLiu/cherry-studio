import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const sourcePath = resolve(__dirname, '../AntdProvider.tsx')
const source = readFileSync(sourcePath, 'utf-8')

describe('AntdProvider lazy loading', () => {
  it('should NOT have static antd/locale imports', () => {
    // Should NOT have: import xxx from 'antd/locale/...'
    expect(source).not.toMatch(/import\s+\w+\s+from\s+['"]antd\/locale\//)
  })

  it('should have a locale map with dynamic import() for all 12 languages', () => {
    // Should define a locale map with string keys and dynamic import() values
    expect(source).toMatch(/const\s+antdLocaleMap/)

    const expectedLanguages = [
      'zh-CN',
      'zh-TW',
      'en-US',
      'de-DE',
      'ru-RU',
      'ja-JP',
      'el-GR',
      'es-ES',
      'fr-FR',
      'pt-PT',
      'ro-RO',
      'vi-VN'
    ]

    for (const lang of expectedLanguages) {
      expect(source).toContain(`'${lang}'`)
    }
  })

  it('should use dynamic import() for antd locale modules', () => {
    // Should contain dynamic import() calls for antd/locale
    expect(source).toMatch(/import\(['"]antd\/locale\//)
  })

  it('should have an async loadAntdLocale function with caching', () => {
    // Should have an async function to load locale
    expect(source).toMatch(/async\s+function\s+loadAntdLocale/)
    // Should have module-level cache variables
    expect(source).toMatch(/cachedLocale/)
    expect(source).toMatch(/cachedLang/)
  })

  it('should use useState and useEffect for async locale loading in the component', () => {
    // Should use useState to hold the loaded locale
    expect(source).toMatch(/useState/)
    // Should use useEffect to trigger async locale loading
    expect(source).toMatch(/useEffect/)
  })
})
