import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const videoBlockPath = resolve(__dirname, '../VideoBlock.tsx')
const videoBlockSource = readFileSync(videoBlockPath, 'utf-8')

describe('VideoBlock lazy loading of react-player', () => {
  it('should use React.lazy for MessageVideo import', () => {
    expect(videoBlockSource).toMatch(/React\.lazy\(\(\)\s*=>\s*import\(['"]\.\.\/MessageVideo['"]\)\)/)
  })

  it('should NOT use a static import of MessageVideo', () => {
    expect(videoBlockSource).not.toMatch(/^import\s+MessageVideo\s+from\s+['"]\.\.\/MessageVideo['"]/m)
  })

  it('should wrap MessageVideo with Suspense', () => {
    expect(videoBlockSource).toMatch(/<Suspense[\s\S]*?>[\s\S]*?<MessageVideo/)
  })

  it('should import Suspense from react', () => {
    expect(videoBlockSource).toMatch(/import\s+React\s*,\s*\{\s*Suspense\s*\}\s+from\s+['"]react['"]/)
  })
})
