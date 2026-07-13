import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('EmojiPicker - deferred data loading', () => {
  it('should not statically import emoji data files in the public entry point', () => {
    // Read the actual index.tsx file content
    const indexPath = resolve(__dirname, '../EmojiPicker/index.tsx')
    const indexContent = readFileSync(indexPath, 'utf-8')

    // The index.tsx should NOT contain direct imports of emoji data JSON files
    expect(indexContent).not.toMatch(/import\s+data(DE|EN|ES|FR|JA|PT|RU|ZH|ZH_HANT)\s+from/)

    // The index.tsx should NOT import emoji-picker-element directly (side-effect import)
    expect(indexContent).not.toMatch(/import\s+['"]emoji-picker-element['"]/)

    // The index.tsx should NOT import i18n modules from emoji-picker-element
    expect(indexContent).not.toMatch(/import\s+.*from\s+['"]emoji-picker-element\/i18n/)

    // The index.tsx should use React.lazy for deferred loading
    expect(indexContent).toContain('React.lazy')
  })

  it('should use Suspense to wrap the lazy-loaded component', () => {
    const indexPath = resolve(__dirname, '../EmojiPicker/index.tsx')
    const indexContent = readFileSync(indexPath, 'utf-8')

    expect(indexContent).toContain('Suspense')
    expect(indexContent).toContain('fallback={null}')
  })

  it('should have all emoji data imports only in EmojiPickerInner', () => {
    const innerPath = resolve(__dirname, '../EmojiPicker/EmojiPickerInner.tsx')
    const innerContent = readFileSync(innerPath, 'utf-8')

    // The inner component should contain all 9 emoji data imports
    expect(innerContent).toMatch(/import\s+dataDE\s+from/)
    expect(innerContent).toMatch(/import\s+dataEN\s+from/)
    expect(innerContent).toMatch(/import\s+dataES\s+from/)
    expect(innerContent).toMatch(/import\s+dataFR\s+from/)
    expect(innerContent).toMatch(/import\s+dataJA\s+from/)
    expect(innerContent).toMatch(/import\s+dataPT\s+from/)
    expect(innerContent).toMatch(/import\s+dataRU\s+from/)
    expect(innerContent).toMatch(/import\s+dataZH\s+from/)
    expect(innerContent).toMatch(/import\s+dataZH_HANT\s+from/)

    // Should import emoji-picker-element side effect
    expect(innerContent).toContain("import 'emoji-picker-element'")
  })
})
