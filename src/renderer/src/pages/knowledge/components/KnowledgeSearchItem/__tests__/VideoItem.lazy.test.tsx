import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const indexPath = resolve(__dirname, '../index.tsx')
const indexSource = readFileSync(indexPath, 'utf-8')

describe('KnowledgeSearchItem lazy loading of react-player', () => {
  it('should use React.lazy for VideoItem import', () => {
    expect(indexSource).toMatch(/const\s+VideoItem\s*=\s*React\.lazy\(\(\)\s*=>\s*import\(['"]\.\/VideoItem['"]\)\)/)
  })

  it('should NOT use a static import of VideoItem', () => {
    expect(indexSource).not.toMatch(/^import\s+VideoItem\s+from\s+['"]\.\/VideoItem['"]/m)
  })

  it('should wrap VideoItem with Suspense', () => {
    expect(indexSource).toMatch(/<Suspense[\s\S]*?>[\s\S]*?<VideoItem/)
  })

  it('should import Suspense from react', () => {
    expect(indexSource).toMatch(/import\s+React\s*,\s*\{\s*Suspense\s*\}\s+from\s+['"]react['"]/)
  })
})
