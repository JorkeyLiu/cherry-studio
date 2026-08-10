/**
 * LOCK-007: the assistant context menu must retain edit, duplicate, clear,
 * save-to-agent, sorting and delete, and must NOT contain the removed
 * icon-type, tag-management or list/tags view-switching items.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => ({}),
  default: {
    getState: () => ({})
  }
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: () => ({ id: 'default-assistant', name: 'Default Assistant' }),
  getDefaultModel: () => ({ id: 'default-model', name: 'Default', provider: 'openai' })
}))

vi.mock('@renderer/components/Popups/AddAssistantPopup', () => ({ default: { show: vi.fn() } }))

import { getMenuItems } from '../AssistantItem'

const t = (key: string) => key

const baseArgs = {
  assistant: { id: 'a1', name: 'Assistant', emoji: '🤖', tags: ['work'] } as any,
  t,
  addPreset: vi.fn(),
  copyAssistant: vi.fn(),
  onSwitch: vi.fn(),
  onDelete: vi.fn(),
  removeAllTopics: vi.fn(),
  sortByPinyinAsc: vi.fn(),
  sortByPinyinDesc: vi.fn()
}

describe('AssistantItem context menu (LOCK-007)', () => {
  it('retains edit, duplicate, clear, save-to-agent, sorting and delete', () => {
    const items = getMenuItems(baseArgs) as any[]
    const keys = items.map((item) => item?.key).filter(Boolean)

    expect(keys).toEqual(
      expect.arrayContaining(['edit', 'duplicate', 'clear', 'save-to-agent', 'sort-asc', 'sort-desc', 'delete'])
    )
  })

  it('does not contain icon-type, tag management or view-switching items', () => {
    const items = getMenuItems(baseArgs) as any[]
    const keys = items.map((item) => item?.key).filter(Boolean)

    expect(keys).not.toContain('icon-type')
    expect(keys).not.toContain('all-tags')
    expect(keys).not.toContain('switch-view')
  })

  it('does not expose tag submenu children anywhere in the tree', () => {
    const items = getMenuItems(baseArgs) as any[]
    const collect = (list: any[]): string[] =>
      list.flatMap((item) => [item?.key, ...(item?.children ? collect(item.children) : [])])
    const allKeys = collect(items).filter(Boolean)

    expect(allKeys).not.toContain('all-tag-*')
    expect(allKeys).not.toContain('new-tag')
    expect(allKeys).not.toContain('manage-tags')
  })
})
