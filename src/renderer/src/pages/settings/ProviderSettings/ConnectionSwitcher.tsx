import type { DropResult } from '@hello-pangea/dnd'
import { DraggableVirtualList, type DraggableVirtualListRef } from '@renderer/components/DraggableList'
import { ProviderAvatar } from '@renderer/components/ProviderAvatar'
import type { Provider } from '@renderer/types'
import { getFancyProviderName } from '@renderer/utils'
import type { InputRef, MenuProps } from 'antd'
import { Button, Dropdown, Input } from 'antd'
import { ChevronDown, GripVertical, MoreHorizontal, PlusIcon, Search } from 'lucide-react'
import type { FC, Key, KeyboardEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const OPTION_LIST_ID = 'provider-connection-option-list'
const OPTION_ROW_HEIGHT = 38
const MAX_VISIBLE_OPTIONS = 5

interface ConnectionSwitcherProps {
  /** Visible connection list (search already applied). */
  providers: Provider[]
  /** Singular resolved active connection. */
  currentProvider?: Provider
  providerLogos: Record<string, string>
  searchText: string
  onSearchTextChange: (value: string) => void
  onSelect: (provider: Provider) => void
  onToggleEnabled: (provider: Provider, enabled: boolean) => void
  menuItems: MenuProps['items']
  /** Opens the existing add-connection flow from the dropdown's fixed footer. */
  onAddProvider: () => void
  onDragStart: () => void
  searchDisabled?: boolean
  onDragEnd: (result: DropResult) => void
  itemKey: (index: number) => Key
}

const optionIdOf = (provider: Provider) => `connection-option-${provider.id}`

/**
 * Connection header of the provider settings content area: the current
 * connection as a searchable switcher, its enabled state, and the compact
 * connection menu. There is no permanent connection rail — switching a
 * connection retargets the content area in place.
 *
 * Escape handling contract: the dropdown is the topmost layer, so Escape inside
 * the open dropdown closes only the dropdown (it never reaches the settings
 * dialog's Escape handler); with the dropdown closed the dialog behaves as
 * before. Outside-pointer dismissal uses the trigger + popover as its only
 * boundary: blank header space closes the dropdown and leaves the dialog alone.
 *
 * Focus contract: opening from the trigger keeps focus on the trigger (nothing
 * is auto-focused), so Escape stays with the trigger while the dropdown is open;
 * the search field is reached by an explicit click, by Tab in DOM order, or by
 * ArrowDown/ArrowUp on the trigger.
 */
const ConnectionSwitcher: FC<ConnectionSwitcherProps> = ({
  providers,
  currentProvider,
  providerLogos,
  searchText,
  onSearchTextChange,
  onSelect,
  onToggleEnabled,
  searchDisabled,
  menuItems,
  onAddProvider,
  onDragStart,
  onDragEnd,
  itemKey
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const optionsRef = useRef<DraggableVirtualListRef>(null)
  const searchInputRef = useRef<InputRef>(null)
  const focusSearchOnOpenRef = useRef(false)

  const currentId = currentProvider?.id

  const resetActiveIndex = useCallback(() => {
    const currentIndex = providers.findIndex((provider) => provider.id === currentId)
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0)
  }, [currentId, providers])

  const closePopover = useCallback((restoreFocus: boolean) => {
    focusSearchOnOpenRef.current = false
    setOpen(false)
    if (restoreFocus) {
      triggerRef.current?.focus()
    }
  }, [])

  const openPopover = useCallback(
    (focusSearch = false) => {
      focusSearchOnOpenRef.current = focusSearch
      resetActiveIndex()
      setOpen(true)
    },
    [resetActiveIndex]
  )

  // Focus is never moved into the search field automatically: opening from the
  // trigger keeps focus on the trigger, and the search field is reached by an
  // explicit click, by Tab in DOM order, or by keyboard navigation on the
  // trigger. The pending flag records only that explicit keyboard request.
  useEffect(() => {
    if (!open || !focusSearchOnOpenRef.current) return
    focusSearchOnOpenRef.current = false
    searchInputRef.current?.focus()
  }, [open])

  // Pointer outside the trigger or the dropdown itself closes the dropdown
  // without touching the parent dialog.
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return
      if (popoverRef.current?.contains(event.target as Node)) return
      closePopover(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [closePopover, open])

  const activeOptionId = useMemo(() => {
    const provider = providers[activeIndex]
    return provider ? optionIdOf(provider) : undefined
  }, [activeIndex, providers])

  const moveActive = useCallback(
    (delta: 1 | -1) => {
      if (providers.length === 0) return
      setActiveIndex((index) => {
        const next = index + delta
        if (next < 0) return providers.length - 1
        if (next >= providers.length) return 0
        optionsRef.current?.scrollToIndex(next, { align: 'auto' })
        return next
      })
    },
    [providers.length]
  )

  const chooseProvider = useCallback(
    (provider: Provider) => {
      onSelect(provider)
      closePopover(true)
    },
    [closePopover, onSelect]
  )

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        // The dropdown closes first; the settings dialog stays open.
        event.preventDefault()
        event.stopPropagation()
        closePopover(true)
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveActive(1)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(-1)
        return
      }
      if (event.key === 'Enter') {
        const provider = providers[activeIndex]
        if (!provider) return
        event.preventDefault()
        chooseProvider(provider)
      }
    },
    [activeIndex, chooseProvider, closePopover, moveActive, providers]
  )

  // Escape from any other element inside the dropdown also stays local.
  const handlePopoverKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      closePopover(true)
    },
    [closePopover]
  )

  // Focus stays on the invoking trigger, so the trigger itself owns Escape and
  // the explicit keyboard entry into the search field.
  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Escape') {
        if (!open) return
        // The dropdown is the topmost layer: Escape closes it without reaching
        // the surrounding settings dialog.
        event.preventDefault()
        event.stopPropagation()
        closePopover(true)
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      // Keyboard navigation is explicit: it moves into the search field.
      event.preventDefault()
      if (open) {
        searchInputRef.current?.focus()
        return
      }
      openPopover(true)
    },
    [closePopover, open, openPopover]
  )

  const optionListHeight = Math.min(Math.max(providers.length, 1), MAX_VISIBLE_OPTIONS) * OPTION_ROW_HEIGHT

  return (
    <SwitcherHeader data-testid="provider-switcher-header">
      <SwitcherBar>
        <TriggerButton
          ref={triggerRef}
          type="button"
          data-testid="provider-switcher"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={!currentProvider}
          onKeyDown={handleTriggerKeyDown}
          onClick={() => (open ? closePopover(true) : openPopover())}>
          {currentProvider && <ProviderAvatar size={32} provider={currentProvider} customLogos={providerLogos} />}
          <TriggerText>
            {currentProvider ? getFancyProviderName(currentProvider) : t('settings.provider.title')}
          </TriggerText>
          <ChevronDown size={14} aria-hidden />
        </TriggerButton>
        <SwitcherActions>
          {currentProvider && (
            <StatusToggle
              type="button"
              data-testid="provider-status-toggle"
              aria-pressed={currentProvider.enabled}
              aria-label={t('settings.provider.switcher.toggle')}
              onClick={() => onToggleEnabled(currentProvider, !currentProvider.enabled)}>
              <StatusDot $enabled={currentProvider.enabled} aria-hidden />
              <span aria-hidden>{currentProvider.enabled ? t('common.enabled') : t('common.disabled')}</span>
            </StatusToggle>
          )}
          <Dropdown
            menu={{ items: menuItems }}
            trigger={['click']}
            onOpenChange={(nextOpen) => {
              if (nextOpen) closePopover(false)
            }}>
            <Button
              type="text"
              data-testid="provider-connection-menu"
              aria-haspopup="menu"
              aria-label={t('settings.provider.menu.label')}
              icon={<MoreHorizontal size={16} />}
            />
          </Dropdown>
        </SwitcherActions>
      </SwitcherBar>
      {open && (
        <Popover ref={popoverRef} data-testid="provider-switcher-popover" onKeyDown={handlePopoverKeyDown}>
          <PopoverSearch>
            <SearchField
              ref={searchInputRef}
              value={searchText}
              onChange={(event) => onSearchTextChange(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('settings.provider.switcher.search')}
              prefix={<Search size={14} />}
              disabled={searchDisabled}
              spellCheck={false}
              role="combobox"
              aria-label={t('settings.provider.switcher.search')}
              aria-expanded
              aria-controls={OPTION_LIST_ID}
              aria-autocomplete="list"
              aria-activedescendant={activeOptionId}
            />
          </PopoverSearch>
          {providers.length === 0 ? (
            <EmptyHint data-testid="provider-switcher-empty">{t('settings.provider.switcher.empty')}</EmptyHint>
          ) : (
            <div
              id={OPTION_LIST_ID}
              role="listbox"
              aria-label={t('settings.provider.title')}
              data-testid="provider-switcher-list">
              <DraggableVirtualList
                ref={optionsRef}
                list={providers}
                itemKey={itemKey}
                estimateSize={() => OPTION_ROW_HEIGHT}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                overscan={3}
                itemContainerStyle={{ paddingBottom: 2 }}
                scrollerStyle={{ padding: 4, height: `${optionListHeight}px` }}
                style={{ width: '100%' }}>
                {(provider, index) => (
                  <ConnectionOption
                    id={optionIdOf(provider)}
                    role="option"
                    aria-selected={provider.id === currentId}
                    $current={provider.id === currentId}
                    $active={index === activeIndex}
                    data-testid={`connection-option-${provider.id}`}
                    onClick={() => chooseProvider(provider)}
                    onMouseEnter={() => setActiveIndex(index)}>
                    <ProviderAvatar size={32} provider={provider} customLogos={providerLogos} />
                    <OptionName>{getFancyProviderName(provider)}</OptionName>
                    <OptionTail>
                      <StatusDot $enabled={provider.enabled} aria-hidden />
                      <DragHint aria-hidden>
                        <GripVertical size={12} />
                      </DragHint>
                    </OptionTail>
                  </ConnectionOption>
                )}
              </DraggableVirtualList>
            </div>
          )}
          <AddFooter>
            <AddFooterButton
              htmlType="button"
              data-testid="provider-switcher-add"
              icon={<PlusIcon size={14} />}
              onClick={() => {
                closePopover(false)
                onAddProvider()
              }}>
              {t('settings.provider.switcher.add')}
            </AddFooterButton>
          </AddFooter>
        </Popover>
      )}
    </SwitcherHeader>
  )
}

const AddFooter = styled.div`
  padding: 6px 8px;
  border-top: 0.5px solid var(--color-border);
`

const AddFooterButton = styled(Button)`
  width: 100%;
`

const SwitcherHeader = styled.div`
  position: relative;
  z-index: 3;
  flex: 0 0 auto;
  width: 100%;
  min-width: 0;
  padding: 12px 18px 10px;
  box-sizing: border-box;
`

const SwitcherBar = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
`

const TriggerButton = styled.button`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
  margin-left: -6px;
  padding: 4px 8px 4px 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-1);
  text-align: left;
  cursor: pointer;
  transition: background 0.2s ease-in-out;

  &:hover:not(:disabled) {
    background: var(--color-background-soft);
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  &:disabled {
    cursor: default;
  }
`

const TriggerText = styled.span`
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: bold;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const SwitcherActions = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  flex: none;
`

const StatusToggle = styled.button`
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 0.5px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.2s ease-in-out,
    border-color 0.2s ease-in-out;

  &:hover {
    background: var(--color-background-soft);
    border-color: var(--color-border);
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
`

const StatusDot = styled.span<{ $enabled?: boolean }>`
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: ${(props) => (props.$enabled ? 'var(--color-primary)' : 'var(--color-text-3)')};
  opacity: ${(props) => (props.$enabled ? 1 : 0.6)};
`

const Popover = styled.div`
  position: absolute;
  top: 100%;
  left: 18px;
  z-index: 40;
  width: min(360px, calc(100% - 36px));
  overflow: hidden;
  border: 0.5px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-background);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
`

const PopoverSearch = styled.div`
  padding: 8px;
  border-bottom: 0.5px solid var(--color-border);
`

/**
 * Scoped neutral search field. The stock antd focus ring draws the primary
 * (green) glow, which reads far too loud inside the compact switcher header, so
 * the field keeps the neutral background/border tokens and shows focus as a
 * slightly stronger neutral border only. Scoped to this switcher search: no
 * global antd token or Input style is overridden.
 */
const SearchField = styled(Input)`
  &&& {
    background: var(--color-background-soft);
    border-color: var(--color-border-soft);
    box-shadow: none;
  }

  &&&:hover {
    border-color: var(--color-border);
    box-shadow: none;
  }

  &&&.ant-input-affix-wrapper-focused,
  &&&:focus-within {
    background: var(--color-background-soft);
    border-color: var(--color-text-3);
    box-shadow: none;
    outline: none;
  }
`

const EmptyHint = styled.div`
  padding: 18px 12px;
  color: var(--color-text-3);
  font-size: 12px;
  text-align: center;
`

const ConnectionOption = styled.div<{ $current?: boolean; $active?: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 36px;
  padding: 2px 8px;
  box-sizing: border-box;
  border-radius: 7px;
  color: ${(props) => (props.$current ? 'var(--color-text-1)' : 'var(--color-text-2)')};
  cursor: pointer;
  user-select: none;

  background: ${(props) => (props.$current || props.$active ? 'var(--color-background-soft)' : 'transparent')};

  &:hover {
    background: var(--color-background-soft);
  }
`

const OptionName = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const OptionTail = styled.span`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 7px;
  flex: none;
  color: var(--color-text-3);
`

const DragHint = styled.span`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  flex: none;
  color: var(--color-text-3);
  opacity: 0;
  transition: opacity 0.2s ease-in-out;

  ${ConnectionOption}:hover & {
    opacity: 1;
  }
`

export default ConnectionSwitcher
