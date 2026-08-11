import * as fs from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parsePluginMetadata } from '../markdownParser'

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn()
  }
}))

describe('markdownParser', () => {
  const pluginContent = `---
name: bad-plugin
description: Use this agent when example: user: "hi"
tools: ["Read", "Grep"]
---

Body`

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.promises.stat).mockResolvedValue({ size: 42 } as fs.Stats)
    vi.mocked(fs.promises.readFile).mockResolvedValue(pluginContent)
  })

  it('recovers invalid plugin frontmatter and keeps metadata', async () => {
    const metadata = await parsePluginMetadata('/abs/plugin.md', 'plugins/plugin.md', 'plugins', 'agent')
    expect(metadata.name).toBe('bad-plugin')
    expect(metadata.description).toContain('example: user')
    expect(metadata.tools).toEqual(['Read', 'Grep'])
  })
})
