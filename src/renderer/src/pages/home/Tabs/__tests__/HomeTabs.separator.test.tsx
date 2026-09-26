import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const TABS_PATH = resolve(process.cwd(), 'src/renderer/src/pages/home/Tabs/index.tsx')

function readTabsSource() {
  return readFileSync(TABS_PATH, 'utf-8')
}

// Mocks for HomeTabs hooks
vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistants: () => ({ addAssistant: vi.fn() }),
  useAssistantDefaults: () => ({
    assistantDefaults: { name: 'Defaults', prompt: '', settings: {} } as any,
    updateAssistantDefaults: vi.fn()
  })
}))
vi.mock('@renderer/services/assistantDefaults', () => ({
  createAssistantFromDefaults: () => ({ id: 'new-id', topics: [{ id: 'topic-new-id', assistantId: 'new-id' }] })
}))
vi.mock('@renderer/components/Popups/AddAssistantPopup', () => ({
  default: { show: vi.fn() }
}))
vi.mock('@renderer/pages/home/Tabs/AssistantsTab', () => ({
  default: () => <div data-testid="assistants-tab" />
}))
vi.mock('@renderer/pages/home/Tabs/TopicsTab', () => ({
  default: () => <div data-testid="topics-tab" />
}))

import HomeTabs from '../index'

const mockAssistant = { id: 'a1', name: 'Assistant', topics: [{ id: 't1', name: 'Topic' }] } as any
const mockTopic = { id: 't1', name: 'Topic' } as any

describe('HomeTabs — single separator without duplicate panel border', () => {
  it('removes duplicate 0.5px panel border so handle provides the single separator', () => {
    const src = readTabsSource()
    expect(src).not.toContain('borderStyle')
    expect(src).not.toContain('borderRight')
    expect(src).not.toContain('borderLeft')
    expect(src).not.toContain('0.5px solid var(--color-border)')
    // Style should only contain tabsWidthStyle
    expect(src).toContain("'--tabs-width'")
    expect(src).toContain('tabsWidthStyle')
    expect(src).not.toMatch(/style=\{\{.*\.\.\.border/)
  })

  it('left position renders without borderRight', () => {
    const { container } = render(
      <HomeTabs
        activeAssistant={mockAssistant}
        activeTopic={mockTopic}
        setActiveAssistant={vi.fn()}
        setActiveTopic={vi.fn()}
        position="left"
      />
    )
    const root = container.firstChild as HTMLElement
    // Inline style should not contain border
    expect(root.style.borderRight).toBe('')
    expect(root.style.borderLeft).toBe('')
    // Tabs width var should be set
    expect(root.style.getPropertyValue('--tabs-width')).toContain('var(--assistants-width')
  })

  it('right position renders without borderLeft and preserves width var', () => {
    const { container } = render(
      <HomeTabs
        activeAssistant={mockAssistant}
        activeTopic={mockTopic}
        setActiveAssistant={vi.fn()}
        setActiveTopic={vi.fn()}
        position="right"
      />
    )
    const root = container.firstChild as HTMLElement
    expect(root.style.borderLeft).toBe('')
    expect(root.style.borderRight).toBe('')
    expect(root.style.getPropertyValue('--tabs-width')).toContain('var(--topic-list-width')
  })
})
