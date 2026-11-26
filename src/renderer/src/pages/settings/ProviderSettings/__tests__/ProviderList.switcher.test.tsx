/**
 * Provider settings connection switcher.
 *
 * The content area has no permanent connection rail and no pane tabs: all
 * connections live in the searchable switcher popover, the enabled state and
 * the connection menu are compact header controls, "Add Connection" is a fixed
 * footer inside the popover, and selecting a connection retargets the single
 * continuous content pane in place (no list page, no back control).
 *
 * Connection search covers the stored name and id; add/edit/api-settings/
 * delete, reordering and the `?id=` / `?filter=agent` deep links keep working.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const {
  addProviderSpy,
  addProviderPopupSpy,
  apiOptionsShowSpy,
  updateProvidersSpy,
  updateProviderSpy,
  removeProviderSpy,
  storeState
} = vi.hoisted(() => ({
  addProviderSpy: vi.fn(),
  addProviderPopupSpy: vi.fn(),
  apiOptionsShowSpy: vi.fn(),
  updateProvidersSpy: vi.fn(),
  updateProviderSpy: vi.fn(),
  removeProviderSpy: vi.fn(),
  // Minimal stateful provider store so add/remove flows re-resolve the active
  // connection the way the real store does.
  storeState: { providers: [] as any[] }
}))

// Real useDraggableReorder keeps the filtered-to-original index mapping under
// test; only the virtual list itself is replaced by a plain row list plus a
// drag-end trigger.
vi.mock('@renderer/components/DraggableList', async (importActual) => {
  const actual = await importActual<any>()
  return {
    ...actual,
    DraggableVirtualList: (props: any) =>
      React.createElement(
        'div',
        { 'data-testid': 'draggable-list' } as any,
        (props.list as any[]).map((item: any, idx: number) =>
          React.createElement(
            'div',
            { key: item.id ?? idx, 'data-testid': 'draggable-row' } as any,
            props.children(item, idx)
          )
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'drag-end',
            onClick: () =>
              props.onDragEnd?.({
                source: { index: 0, droppableId: 'droppable' },
                destination: { index: 1, droppableId: 'droppable' },
                draggableId: '0',
                type: 'DEFAULT',
                reason: 'DROP',
                mode: 'FLUSH',
                combine: null
              })
          } as any,
          'drag'
        )
      )
  }
})

vi.mock('@renderer/hooks/useProvider', () => ({
  useAllProviders: () => storeState.providers,
  useProviders: () => ({
    updateProviders: updateProvidersSpy,
    addProvider: (provider: any) => {
      addProviderSpy(provider)
      storeState.providers = [...storeState.providers, provider]
    },
    removeProvider: (provider: any) => {
      removeProviderSpy(provider)
      storeState.providers = storeState.providers.filter((item) => item.id !== provider.id)
    },
    updateProvider: updateProviderSpy
  })
}))

vi.mock('@renderer/services/ImageStorage', () => ({
  default: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@renderer/pages/settings/ProviderSettings/AddProviderPopup', () => ({
  default: { show: addProviderPopupSpy }
}))
vi.mock('@renderer/pages/settings/ProviderSettings/ApiOptionsSettings/ApiOptionsSettingsPopup', () => ({
  default: { show: apiOptionsShowSpy }
}))
vi.mock('@renderer/pages/settings/ProviderSettings/ProviderSetting', () => ({
  default: ({ providerId }: any) => React.createElement('div', { 'data-testid': 'provider-setting' } as any, providerId)
}))
vi.mock('@renderer/pages/settings/ProviderSettings/UrlSchemaInfoPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/components/ProviderAvatar', async (importActual) => {
  const actual = await importActual<any>()
  return {
    ...actual,
    ProviderAvatar: (props: any) =>
      React.createElement('span', { 'data-testid': `avatar-${props.provider?.id}` } as any)
  }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

const searchParamsState = { params: new URLSearchParams(), setParams: vi.fn() }

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useSearchParams: () => [searchParamsState.params, searchParamsState.setParams] }
})

const menuItem = (item: any, index: number) => {
  if (!item || item.type === 'divider') return null
  const key = item.key ?? String(index)
  return React.createElement(
    'button',
    { key, 'data-testid': `menu-${key}`, onClick: item.onClick } as any,
    typeof item.label === 'string' ? item.label : null
  )
}

vi.mock('antd', async (importActual) => {
  const actual = await importActual<any>()
  return {
    ...actual,
    Input: (props: any) => {
      const forwarded: Record<string, any> = { ...props }
      delete forwarded.prefix
      delete forwarded.suffix
      delete forwarded.allowClear
      return React.createElement('input', { 'data-testid': 'search-input', ...forwarded })
    },
    Button: (props: any) => {
      const forwarded: Record<string, any> = { ...props }
      delete forwarded.icon
      return React.createElement('button', forwarded, props.children)
    },
    Tag: ({ children, ...props }: any) => React.createElement('span', props, children),
    Dropdown: ({ children, menu }: any) =>
      React.createElement(
        'div',
        { 'data-testid': 'dropdown-mock' } as any,
        children,
        (menu?.items ?? []).map((item: any, index: number) => menuItem(item, index))
      )
  }
})

import ProviderList from '../ProviderList'

const openSwitcher = () => {
  const trigger = screen.getByTestId('provider-switcher')
  // jsdom does not focus a button on click, so mirror the real pointer sequence:
  // the trigger is focused first and then opened by the click.
  act(() => trigger.focus())
  fireEvent.click(trigger)
  return trigger
}

const switcherOption = (providerId: string) => screen.queryByTestId(`connection-option-${providerId}`)

describe('ProviderList connection switcher (no permanent rail, no pane tabs)', () => {
  beforeEach(() => {
    cleanup()
    storeState.providers = [
      { id: 'openai', name: 'Alpha Connectivity', type: 'openai', apiKey: '', apiHost: '', models: [], enabled: true },
      {
        id: 'anthropic',
        name: 'Beta Reliability',
        type: 'anthropic',
        apiKey: '',
        apiHost: '',
        models: [],
        enabled: false
      }
    ]
    searchParamsState.params = new URLSearchParams()
    searchParamsState.setParams.mockClear()
    addProviderSpy.mockClear()
    addProviderPopupSpy.mockReset()
    addProviderPopupSpy.mockResolvedValue({ name: '', type: 'openai' })
    apiOptionsShowSpy.mockClear()
    updateProvidersSpy.mockClear()
    updateProviderSpy.mockClear()
    removeProviderSpy.mockClear()
  })

  it('renders the full content area with the current connection instead of a connection rail', () => {
    render(React.createElement(ProviderList, null as any))

    expect(screen.getByTestId('provider-settings')).toBeInTheDocument()
    expect(screen.getByTestId('provider-content-pane')).toBeInTheDocument()
    expect(screen.getAllByTestId('provider-setting')).toHaveLength(1)
    expect(screen.getByTestId('provider-setting')).toHaveTextContent('openai')
    expect(screen.queryByTestId('provider-list-view')).toBeNull()
    expect(screen.queryByTestId('provider-detail-view')).toBeNull()
    expect(screen.queryByTestId('provider-detail-back')).toBeNull()
    // No pane tabs anywhere: the configuration sections and the model groups
    // are one continuous pane.
    expect(screen.queryByRole('tablist')).toBeNull()

    // The switcher trigger shows the resolved current connection by name only.
    expect(screen.getByTestId('provider-switcher')).toHaveTextContent('Alpha Connectivity')
    expect(screen.getByTestId('provider-status-toggle')).toHaveTextContent('common.enabled')
    // No connection rows are permanently visible; they live in the popover.
    expect(screen.queryAllByTestId('draggable-row')).toHaveLength(0)
  })

  it('lists every connection in the popover and marks exactly one selected connection', () => {
    render(React.createElement(ProviderList, null as any))
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()

    openSwitcher()

    expect(screen.getByTestId('provider-switcher-popover')).toBeInTheDocument()
    expect(screen.getByTestId('provider-switcher')).toHaveAttribute('aria-expanded', 'true')
    expect(switcherOption('openai')).not.toBeNull()
    expect(switcherOption('anthropic')).not.toBeNull()
    expect(switcherOption('openai')?.getAttribute('aria-selected')).toBe('true')
    expect(switcherOption('anthropic')?.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'provider-connection-option-list')
  })

  it('opens without stealing focus into the search field and keeps the trigger as the entry point', () => {
    render(React.createElement(ProviderList, null as any))

    const trigger = openSwitcher()

    // Opening from the trigger leaves focus on the trigger; nothing auto-focuses.
    expect(screen.getByTestId('provider-switcher-popover')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(screen.getByTestId('search-input')).not.toHaveFocus()

    // Escape while focus is still on the trigger closes only the dropdown.
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()
    expect(screen.getByTestId('provider-setting')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('enters the search field only through explicit keyboard navigation and keeps search semantics', () => {
    render(React.createElement(ProviderList, null as any))

    const trigger = openSwitcher()
    expect(screen.getByTestId('search-input')).not.toHaveFocus()

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByTestId('search-input')).toHaveFocus()

    // The filter itself is unchanged: typing narrows the connection list.
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'Beta' } })
    expect(switcherOption('anthropic')).not.toBeNull()
    expect(switcherOption('openai')).toBeNull()

    // Escape still closes only the dropdown and returns focus to the trigger.
    fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Escape' })
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()
    expect(screen.getByTestId('provider-setting')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('searches connections by name and by stored id', () => {
    render(React.createElement(ProviderList, null as any))
    openSwitcher()

    const search = screen.getByTestId('search-input')
    fireEvent.change(search, { target: { value: 'Beta' } })
    expect(switcherOption('anthropic')).not.toBeNull()
    expect(switcherOption('openai')).toBeNull()

    fireEvent.change(search, { target: { value: 'openai' } })
    expect(switcherOption('openai')).not.toBeNull()
    expect(switcherOption('anthropic')).toBeNull()

    fireEvent.change(search, { target: { value: 'nothing-matches' } })
    expect(screen.queryAllByTestId(/connection-option-/)).toHaveLength(0)
    expect(screen.getByTestId('provider-switcher-empty')).toHaveTextContent('settings.provider.switcher.empty')
  })

  it('retargets the content area in place on selection without opening a list page', () => {
    render(React.createElement(ProviderList, null as any))
    openSwitcher()

    fireEvent.click(switcherOption('anthropic') as HTMLElement)

    expect(screen.getByTestId('provider-setting')).toHaveTextContent('anthropic')
    // Selection closes the popover and keeps a single content area.
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()
    expect(screen.getAllByTestId('provider-setting')).toHaveLength(1)
    expect(screen.queryByTestId('provider-detail-back')).toBeNull()
    expect(screen.getByTestId('provider-switcher')).toHaveTextContent('Beta Reliability')
    expect(screen.getByTestId('provider-switcher')).toHaveFocus()
  })

  it('Escape closes only the switcher dropdown and leaves the settings content in place', () => {
    render(React.createElement(ProviderList, null as any))
    openSwitcher()

    fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Escape' })
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()
    expect(screen.getByTestId('provider-setting')).toBeInTheDocument()

    // Escape from any other dropdown element stays local as well.
    openSwitcher()
    fireEvent.keyDown(screen.getByTestId('provider-switcher-popover'), { key: 'Escape' })
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()
    expect(screen.getByTestId('provider-setting')).toBeInTheDocument()
  })

  it('closes the dropdown on a pointer outside the trigger and the popover, keeping the content', () => {
    render(React.createElement(ProviderList, null as any))
    openSwitcher()

    // The status pill belongs to the header but is not part of the dropdown
    // boundary: pressing it closes the dropdown without touching the dialog.
    fireEvent.mouseDown(screen.getByTestId('provider-status-toggle'))
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()
    expect(screen.getByTestId('provider-setting')).toBeInTheDocument()

    // Blank header space behaves the same way.
    openSwitcher()
    fireEvent.mouseDown(screen.getByTestId('provider-switcher-header'))
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()

    // Pointer down inside the popover itself keeps it open.
    openSwitcher()
    fireEvent.mouseDown(screen.getByTestId('provider-switcher-popover'))
    expect(screen.getByTestId('provider-switcher-popover')).toBeInTheDocument()
  })

  it('selects the connection from an ?id= deep link', () => {
    searchParamsState.params = new URLSearchParams('id=anthropic')
    render(React.createElement(ProviderList, null as any))

    expect(screen.getByTestId('provider-setting')).toHaveTextContent('anthropic')
    expect(searchParamsState.setParams).toHaveBeenCalled()
  })

  it('consumes the legacy ?filter=agent deep link without hiding connections', () => {
    searchParamsState.params = new URLSearchParams('filter=agent')
    render(React.createElement(ProviderList, null as any))
    openSwitcher()

    // The parameter is consumed so it is not re-applied, but there is no
    // visible agent filter in the switcher anymore.
    expect(searchParamsState.setParams).toHaveBeenCalled()
    expect(switcherOption('anthropic')).not.toBeNull()
    expect(switcherOption('openai')).not.toBeNull()
  })

  it('toggles the current connection enabled state from the header', () => {
    render(React.createElement(ProviderList, null as any))

    fireEvent.click(screen.getByTestId('provider-status-toggle'))

    expect(updateProviderSpy).toHaveBeenCalledWith({ id: 'openai', enabled: false })
    expect(screen.getByTestId('provider-status-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('provider-status-toggle')).toHaveTextContent('common.enabled')
  })

  it('keeps exactly edit, API settings and delete in the connection menu', () => {
    render(React.createElement(ProviderList, null as any))

    expect(screen.getByTestId('menu-edit')).toHaveTextContent('common.edit')
    expect(screen.getByTestId('menu-api-settings')).toHaveTextContent('settings.provider.api.options.label')
    expect(screen.getByTestId('menu-delete')).toHaveTextContent('common.delete')
    // Add lives in the switcher footer, not in the menu; notes and the old
    // filter toggles are gone from the visible menu.
    expect(screen.queryByTestId('menu-add')).toBeNull()
    expect(screen.queryByTestId('menu-notes')).toBeNull()
    expect(screen.queryByTestId('menu-filter-all')).toBeNull()
    expect(screen.queryByTestId('menu-filter-agent')).toBeNull()
  })

  it('opens the API settings popup for the current connection', () => {
    render(React.createElement(ProviderList, null as any))

    fireEvent.click(screen.getByTestId('menu-api-settings'))

    expect(apiOptionsShowSpy).toHaveBeenCalledWith({ providerId: 'openai' })
  })

  it('adds a connection from the switcher footer and selects it', async () => {
    addProviderPopupSpy.mockResolvedValue({ name: 'My Connection', type: 'openai' })
    render(React.createElement(ProviderList, null as any))
    openSwitcher()

    expect(screen.getByTestId('provider-switcher-add')).toHaveTextContent('settings.provider.switcher.add')
    fireEvent.click(screen.getByTestId('provider-switcher-add'))

    await vi.waitFor(() => expect(addProviderSpy).toHaveBeenCalledTimes(1))
    const added = addProviderSpy.mock.calls[0][0]
    expect(added.name).toBe('My Connection')
    expect(screen.queryByTestId('provider-switcher-popover')).toBeNull()
    expect(screen.getByTestId('provider-setting')).toHaveTextContent(added.id)
  })

  it('renames the current connection through the edit popup', async () => {
    addProviderPopupSpy.mockResolvedValue({ name: 'Renamed Connection', type: 'openai' })
    render(React.createElement(ProviderList, null as any))

    fireEvent.click(screen.getByTestId('menu-edit'))

    expect(addProviderPopupSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai' }))

    await vi.waitFor(() =>
      expect(updateProviderSpy).toHaveBeenCalledWith({
        id: 'openai',
        name: 'Renamed Connection',
        type: 'openai'
      })
    )
  })

  it('deletes the current connection and falls back to the first remaining one', async () => {
    const confirmSpy = vi.fn()
    Object.defineProperty(window, 'modal', { writable: true, value: { confirm: confirmSpy } })
    render(React.createElement(ProviderList, null as any))

    fireEvent.click(screen.getByTestId('menu-delete'))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const options = confirmSpy.mock.calls[0][0]
    expect(options.title).toBe('settings.provider.delete.title')
    expect(options.okText).toBe('common.delete')

    await options.onOk()
    await vi.waitFor(() => expect(screen.getByTestId('provider-setting')).toHaveTextContent('anthropic'))

    expect(removeProviderSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai' }))
    expect(screen.getByTestId('provider-setting')).toHaveTextContent('anthropic')
  })

  it('reorders connections through the switcher drag mapping', () => {
    render(React.createElement(ProviderList, null as any))
    openSwitcher()

    fireEvent.click(screen.getByTestId('drag-end'))

    expect(updateProvidersSpy).toHaveBeenCalledTimes(1)
    const reordered = updateProvidersSpy.mock.calls[0][0]
    expect(reordered.map((provider: any) => provider.id)).toEqual(['anthropic', 'openai'])
  })
})
