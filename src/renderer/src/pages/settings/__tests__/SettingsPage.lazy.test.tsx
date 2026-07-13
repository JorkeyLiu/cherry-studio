import fs from 'fs'
import path from 'path'
import { beforeAll, describe, expect, it } from 'vitest'

const settingsDir = path.resolve(__dirname, '..')

/**
 * Static verification tests for SettingsPage lazy loading.
 *
 * Instead of importing the actual modules (which have deep transitive
 * dependencies that hang in jsdom), we verify the source file structure
 * to ensure:
 * 1. All 14 sub-components are lazily imported via React.lazy()
 * 2. The Suspense wrapper is present around Routes
 * 3. The LoadingFallback component is defined
 */

describe('SettingsPage lazy loading (static verification)', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(settingsDir, 'SettingsPage.tsx'), 'utf-8')
  })

  it('imports React and Suspense from react', () => {
    expect(source).toContain("import React, { Suspense } from 'react'")
  })

  it('has 13 React.lazy() declarations for sub-components', () => {
    const lazyMatches = source.match(/React\.lazy\(\(\) => import\(/g)
    expect(lazyMatches).toHaveLength(13)
  })

  it('lazily imports ModelSettings', () => {
    expect(source).toContain("React.lazy(() => import('@renderer/pages/settings/ModelSettings/ModelSettings'))")
  })

  it('lazily imports AboutSettings', () => {
    expect(source).toContain("React.lazy(() => import('./AboutSettings'))")
  })

  it('lazily imports DataSettings', () => {
    expect(source).toContain("React.lazy(() => import('./DataSettings/DataSettings'))")
  })

  it('lazily imports DisplaySettings', () => {
    expect(source).toContain("React.lazy(() => import('./DisplaySettings/DisplaySettings'))")
  })

  it('lazily imports DocProcessSettings', () => {
    expect(source).toContain("React.lazy(() => import('./DocProcessSettings'))")
  })

  it('lazily imports GeneralSettings', () => {
    expect(source).toContain("React.lazy(() => import('./GeneralSettings'))")
  })

  it('lazily imports MCPSettings', () => {
    expect(source).toContain("React.lazy(() => import('./MCPSettings'))")
  })

  it('lazily imports MemorySettings', () => {
    expect(source).toContain("React.lazy(() => import('./MemorySettings'))")
  })

  it('lazily imports ProviderList from ProviderSettings', () => {
    expect(source).toContain("React.lazy(() => import('./ProviderSettings/ProviderList'))")
  })

  it('lazily imports QuickPhraseSettings', () => {
    expect(source).toContain("React.lazy(() => import('./QuickPhraseSettings'))")
  })

  it('lazily imports ShortcutSettings', () => {
    expect(source).toContain("React.lazy(() => import('./ShortcutSettings'))")
  })

  it('lazily imports ApiServerSettings from ToolSettings', () => {
    expect(source).toContain("React.lazy(() => import('./ToolSettings/ApiServerSettings/ApiServerSettings'))")
  })

  it('lazily imports WebSearchSettings', () => {
    expect(source).toContain("React.lazy(() => import('./WebSearchSettings'))")
  })

  it('has Suspense wrapper around Routes', () => {
    expect(source).toContain('<Suspense fallback={<LoadingFallback />}>')
    expect(source).toContain('<Routes>')
    expect(source).toContain('</Routes>')
    expect(source).toContain('</Suspense>')
  })

  it('has LoadingFallback component defined', () => {
    expect(source).toContain('const LoadingFallback: FC = () =>')
    expect(source).toContain('<Spin />')
  })

  it('has LoadingFallbackContainer styled component', () => {
    expect(source).toContain('const LoadingFallbackContainer = styled.div')
  })

  it('no static (non-lazy) imports of sub-components remain', () => {
    // These should NOT appear as static imports anymore
    const staticImports = [
      'import ModelSettings from',
      'import AboutSettings from',
      'import DataSettings from',
      'import DisplaySettings from',
      'import DocProcessSettings from',
      'import GeneralSettings from',
      'import MCPSettings from',
      'import MemorySettings from',
      'import QuickPhraseSettings from',
      'import ShortcutSettings from',
      'import WebSearchSettings from'
    ]
    for (const imp of staticImports) {
      expect(source).not.toContain(imp)
    }
  })

  it('no static named imports of ProviderList or ApiServerSettings', () => {
    expect(source).not.toContain('import { ProviderList } from')
    expect(source).not.toContain('import { ApiServerSettings } from')
  })

  it('uses antd Spin as fallback indicator', () => {
    expect(source).toContain("import { Divider as AntDivider, Spin } from 'antd'")
  })

  it('preserves all 13 Route elements', () => {
    expect(source).toContain('<Route path="provider" element={<ProviderList />} />')
    expect(source).toContain('<Route path="model" element={<ModelSettings />} />')
    expect(source).toContain('<Route path="websearch/*" element={<WebSearchSettings />} />')
    expect(source).toContain('<Route path="api-server" element={<ApiServerSettings />} />')
    expect(source).toContain('<Route path="docprocess" element={<DocProcessSettings />} />')
    expect(source).toContain('<Route path="quickphrase" element={<QuickPhraseSettings />} />')
    expect(source).toContain('<Route path="mcp/*" element={<MCPSettings />} />')
    expect(source).toContain('<Route path="memory" element={<MemorySettings />} />')
    expect(source).toContain('<Route path="general/*" element={<GeneralSettings />} />')
    expect(source).toContain('<Route path="display" element={<DisplaySettings />} />')
    expect(source).toContain('<Route path="shortcut" element={<ShortcutSettings />} />')
    expect(source).toContain('<Route path="data" element={<DataSettings />} />')
    expect(source).toContain('<Route path="about" element={<AboutSettings />} />')
  })
})
