/**
 * Unified provider pane flow regression (real ModelList composed inside
 * ProviderSetting).
 *
 * Provider settings is one continuous vertical pane: the connection configuration
 * sections (API key, request host) come first, then the existing model list. The
 * pane itself owns the flow, so the model list toolbar is a block above the
 * group stack and the group stack spans the content width. When the pane was a
 * row flex container the toolbar and the group stack became row siblings: the
 * toolbar collapsed to its content width, every group was squeezed to ~160px and
 * each model row rendered only its icon/capability/action tail with the name and
 * id clipped out of view while the right half of the settings content area
 * stayed empty.
 *
 * These assertions are component-style (declared CSS + DOM relationship), not
 * rendered geometry: jsdom has no layout, so actual pixel geometry must still
 * be confirmed at runtime. Model row presentation (single-line name + monospaced
 * id + capability icons + actions) is covered by the existing ModelListItem
 * display tests and is not reimplemented here.
 */
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Selector of a rule block, with nested at-rule preludes (`@media … {`) stripped.
 */
const ruleSelector = (block: string): string => {
  let rest = block
  while (rest.startsWith('@')) {
    const braceIndex = rest.indexOf('{')
    if (braceIndex === -1) return ''
    rest = rest.slice(braceIndex + 1)
  }
  const braceIndex = rest.indexOf('{')
  return braceIndex === -1 ? '' : rest.slice(0, braceIndex).trim()
}

/**
 * Declared style blocks whose *subject* (the rightmost compound of the selector)
 * carries one of the element's own classes as a whole token.
 *
 * Matching the whole selector text is not enough: a generated stylesheet also
 * holds sibling tokens such as `.ant-flex-vertical`, descendant parts such as
 * `.ant-btn .anticon`, and the antd `css-dev-only-…` hash class that prefixes
 * every `:where(…)` rule, so plain substring matching credits an element with
 * declarations it never receives. Only the subject compound decides what the
 * element itself gets.
 */
const cssRulesFor = (el: Element | null): string => {
  if (!el) return ''
  // The antd style hash is not a component class: it appears inside `:where(…)`
  // on every generated rule.
  const ownClasses = Array.from(el.classList)
    .filter(Boolean)
    .filter((cls) => !cls.startsWith('css-dev-only-') && !cls.startsWith('css-hash-'))
  if (ownClasses.length === 0) return ''

  const ruleBlocks: string[] = []
  for (const styleEl of Array.from(document.querySelectorAll('style'))) {
    const sheet = styleEl.sheet
    if (sheet?.cssRules) {
      for (const rule of Array.from(sheet.cssRules)) {
        ruleBlocks.push(...rule.cssText.split('}').map((block) => `${block}}`))
      }
    } else if (styleEl.textContent) {
      ruleBlocks.push(...styleEl.textContent.split('}').map((block) => `${block}}`))
    }
  }

  // A class token ends at whitespace, end of selector, or a control character
  // boundary — never in the middle of a longer class name.
  const tokenPatterns = ownClasses.map((cls) => new RegExp(`\\.${escapeRegExp(cls)}(?=[\\s{:.>+~,)\\[\\]#]|$)`))

  return ruleBlocks
    .filter((block) => {
      const selector = ruleSelector(block)
      if (!selector) return false
      const compounds = selector.split(/[\s>+~,]+/).filter(Boolean)
      const subject = compounds[compounds.length - 1] ?? ''
      return tokenPatterns.some((pattern) => pattern.test(subject))
    })
    .join('\n')
}

vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))

vi.mock('@renderer/hooks/useProvider', () => {
  // Stable references: ModelList derives its groups inside an effect keyed on the
  // models array, so a fresh object/array per call would re-run that effect
  // forever. The stubbed provider deliberately has no models.
  const provider = {
    id: 'conn-1',
    name: 'Connection One',
    type: 'openai',
    apiKey: '',
    apiHost: 'https://api.example.com',
    enabled: true,
    models: []
  }
  const models = [
    { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'conn-1', group: 'chat' },
    { id: 'text-embedding-3-large', name: 'Embedding Large', provider: 'conn-1', group: 'embedding' }
  ]

  return {
    useProvider: () => ({ provider, models, removeModel: vi.fn(), updateProvider: vi.fn() })
  }
})

vi.mock('@renderer/components/VirtualList', () => ({
  // Row rendering is covered by the ModelListItem presentation tests; here the
  // group container itself is the structural subject.
  DynamicVirtualList: () => React.createElement('div', { 'data-testid': 'model-rows-stub' } as any)
}))

vi.mock('@renderer/services/HealthCheckService', () => ({ checkModelsHealth: vi.fn() }))

vi.mock('@renderer/components/CollapsibleSearchBar', () => ({
  default: () => React.createElement('input', { 'data-testid': 'model-search' } as any)
}))

vi.mock('@renderer/pages/settings/ProviderSettings/ModelList/HealthCheckPopup', () => ({
  default: { show: vi.fn() }
}))
vi.mock('@renderer/pages/settings/ProviderSettings/ModelList/AddModelPopup', () => ({
  default: { show: vi.fn() }
}))
vi.mock('@renderer/pages/settings/ProviderSettings/ModelList/ManageModelsPopup', () => ({
  default: { show: vi.fn() }
}))
// ModelAvatar resolves provider/model logo services that boot renderer stores;
// avatars are presentation detail, not the flow subject here.
vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => React.createElement('span', { 'data-testid': 'model-avatar-stub' } as any)
}))
vi.mock('@renderer/services/providerLogo', () => ({
  useCanonicalModelLogo: () => null,
  useModelProviderLogo: () => null
}))
vi.mock('@renderer/pages/settings/ProviderSettings/EditModelPopup/EditModelPopup', () => ({
  default: { show: vi.fn() }
}))

// The configuration sections are a sibling block in the same pane, not the
// subject here.
vi.mock('../ProviderConfigPane', () => ({
  default: ({ providerId }: any) => React.createElement('div', { 'data-testid': 'config-pane-stub' } as any, providerId)
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

import ProviderSetting from '../ProviderSetting'
const pane = () => screen.getByTestId('provider-content')

/** Ancestors of `el` up to (and including) `stopAt`. */
const ancestorsUntil = (el: Element | null, stopAt: Element): Element[] => {
  const chain: Element[] = []
  let current: Element | null = el
  while (current && current !== stopAt) {
    chain.push(current)
    current = current.parentElement
  }
  return chain
}

const toolbarOf = (paneEl: Element) =>
  Array.from(paneEl.children).find((child) => child.textContent?.includes('common.models')) as HTMLElement | undefined

describe('unified provider pane flow with the real model list', () => {
  beforeEach(() => {
    cleanup()
  })

  it('has no pane tabs: configuration sections and models are one continuous pane', () => {
    render(React.createElement(ProviderSetting, { providerId: 'conn-1' }))

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByTestId('provider-models-pane')).toBeNull()

    // Configuration sections and the model list live in the same pane, in order.
    const paneEl = pane()
    const configPane = screen.getByTestId('config-pane-stub')
    const toolbar = toolbarOf(paneEl)
    expect(configPane).toBeDefined()
    expect(toolbar).toBeDefined()
    expect(paneEl.contains(configPane)).toBe(true)
    expect(paneEl.contains(toolbar as HTMLElement)).toBe(true)
    expect(
      Array.from(paneEl.children).indexOf(configPane) < Array.from(paneEl.children).indexOf(toolbar as HTMLElement)
    ).toBe(true)
  })

  it('stacks the model list toolbar above the group stack and spans the full content width', () => {
    render(React.createElement(ProviderSetting, { providerId: 'conn-1' }))

    const paneEl = pane()

    // Real model list content is composed inside the pane.
    expect(paneEl.textContent).toContain('common.models')
    expect(paneEl.textContent).toContain('chat')
    expect(paneEl.textContent).toContain('embedding')
    expect(paneEl.querySelectorAll('[data-testid="model-rows-stub"]')).toHaveLength(2)

    // Declared flow contract of the pane itself.
    const paneRules = cssRulesFor(paneEl)
    expect(paneRules).not.toBe('')
    expect(paneRules).toMatch(/display:\s*flex/)
    expect(paneRules).toMatch(/flex-direction:\s*column/)
    expect(paneRules).not.toMatch(/flex-direction:\s*row/)
    expect(paneRules).toMatch(/flex:\s*1 1 0%|flex:\s*1/)
    expect(paneRules).toMatch(/min-width:\s*0/)
  })

  it('keeps the toolbar and the group stack as stacked pane-level blocks instead of row siblings of each other', () => {
    render(React.createElement(ProviderSetting, { providerId: 'conn-1' }))

    const paneEl = pane()
    const toolbar = toolbarOf(paneEl)
    expect(toolbar).toBeDefined()

    const firstGroupLabel = screen.getByText('chat')
    const rowsStub = screen.getAllByTestId('model-rows-stub')[0]
    const chain = ancestorsUntil(firstGroupLabel, paneEl)

    // The model list body is its own pane-level block, after the toolbar: a row
    // pane would put them side by side and squeeze the groups to content width.
    const modelListBlock = chain.find((el) => el.parentElement === paneEl)
    expect(modelListBlock).toBeDefined()
    expect(modelListBlock).not.toBe(toolbar)
    expect(toolbar?.contains(modelListBlock as Element)).toBe(false)
    const paneChildren = Array.from(paneEl.children)
    expect(paneChildren.indexOf(toolbar as HTMLElement)).toBeLessThan(paneChildren.indexOf(modelListBlock as Element))

    // No row-direction ancestor between the group stack and the pane.
    for (const el of chain) {
      expect(cssRulesFor(el)).not.toMatch(/flex-direction:\s*row/)
      expect((el as HTMLElement).style.flexDirection).not.toBe('row')
    }

    // The group stack is still the vertical stack it always was: a column-flex
    // container that owns both the group label and the group's rows.
    const columnStacks = chain.filter(
      (el) => /flex-direction:\s*column/.test(cssRulesFor(el)) || (el as HTMLElement).style.flexDirection === 'column'
    )
    expect(columnStacks.length).toBeGreaterThan(0)
    const groupStack = columnStacks[0]
    expect(groupStack.contains(firstGroupLabel)).toBe(true)
    expect(groupStack.contains(rowsStub)).toBe(true)
    expect(screen.getAllByTestId('model-rows-stub')).toHaveLength(2)
  })
})
