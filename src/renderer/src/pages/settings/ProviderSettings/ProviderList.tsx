import type { DropResult } from '@hello-pangea/dnd'
import { loggerService } from '@logger'
import { useDraggableReorder } from '@renderer/components/DraggableList'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import { useAllProviders, useProviders } from '@renderer/hooks/useProvider'
import ImageStorage from '@renderer/services/ImageStorage'
import type { Provider, ProviderType } from '@renderer/types'
import { matchKeywordsInProvider, uuid } from '@renderer/utils'
import type { MenuProps } from 'antd'
import { Bolt } from 'lucide-react'
import type { FC, Key } from 'react'
import { startTransition, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import styled from 'styled-components'

import AddProviderPopup from './AddProviderPopup'
import ApiOptionsSettingsPopup from './ApiOptionsSettings/ApiOptionsSettingsPopup'
import ConnectionSwitcher from './ConnectionSwitcher'
import ProviderSetting from './ProviderSetting'
import UrlSchemaInfoPopup from './UrlSchemaInfoPopup'

const logger = loggerService.withContext('ProviderList')

/**
 * Provider settings inside the bounded settings dialog: one continuous content
 * pane with a connection switcher at the top. There is no permanent connection
 * rail — the switcher popover holds connection search, ordering and add/menu
 * operations, and selecting a connection retargets the content area in place
 * (no list page, no back control, no pane tabs).
 */
const ProviderList: FC = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const providers = useAllProviders()
  const { updateProviders, addProvider, removeProvider, updateProvider } = useProviders()
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(() => providers[0]?.id)
  const { t } = useTranslation()
  const [searchText, setSearchText] = useState<string>('')
  const [dragging, setDragging] = useState(false)
  const [providerLogos, setProviderLogos] = useState<Record<string, string>>({})

  // Singular resolved active connection: the store is the source of truth, so a
  // removed or renamed connection never leaves a stale selection behind.
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? providers[0]

  const selectProvider = useCallback((provider: Provider) => {
    startTransition(() => {
      setSelectedProviderId(provider.id)
    })
  }, [])

  useEffect(() => {
    const loadAllLogos = async () => {
      const logos: Record<string, string> = {}
      for (const provider of providers) {
        if (provider.id) {
          try {
            const logoData = await ImageStorage.get(`provider-${provider.id}`)
            if (logoData) {
              logos[provider.id] = logoData
            }
          } catch (error) {
            logger.error(`Failed to load logo for provider ${provider.id}`, error as Error)
          }
        }
      }
      setProviderLogos(logos)
    }

    void loadAllLogos()
  }, [providers])

  useEffect(() => {
    let shouldUpdate = false

    // Legacy `?filter=agent` deep links are still accepted and consumed so the
    // parameter is not re-applied on later renders, but the switcher no longer
    // exposes an agent filter control (the underlying agent capability stays).
    if (searchParams.get('filter')) {
      searchParams.delete('filter')
      shouldUpdate = true
    }

    if (searchParams.get('id')) {
      const providerId = searchParams.get('id')
      const provider = providers.find((p) => p.id === providerId)
      // A provider id in the URL selects that connection in the switcher and
      // retargets the content area (deep links from provider-key imports keep
      // working); there is no separate list page to open.
      selectProvider(provider ?? providers[0])
      searchParams.delete('id')
      shouldUpdate = true
    }

    if (shouldUpdate) {
      setSearchParams(searchParams)
    }
  }, [providers, searchParams, setSearchParams, selectProvider])

  // Handle provider add key from URL schema
  useEffect(() => {
    const handleProviderAddKey = async (data: {
      id: string
      apiKey: string
      baseUrl: string
      type?: ProviderType
      name?: string
    }) => {
      const { id } = data

      const { updatedProvider, isNew, displayName } = await UrlSchemaInfoPopup.show(data)
      window.navigate(`/settings/provider?id=${id}`)

      if (!updatedProvider) {
        return
      }

      if (isNew) {
        addProvider(updatedProvider)
      } else {
        updateProvider(updatedProvider)
      }

      selectProvider(updatedProvider)
      window.toast.success(t('settings.models.provider_key_added', { provider: displayName }))
    }

    // 检查 URL 参数
    const addProviderData = searchParams.get('addProviderData')
    if (!addProviderData) {
      return
    }

    try {
      const { id, apiKey: newApiKey, baseUrl, type, name } = JSON.parse(addProviderData)
      if (!id || !newApiKey || !baseUrl) {
        window.toast.error(t('settings.models.provider_key_add_failed_by_invalid_data'))
        window.navigate('/settings/provider')
        return
      }

      void handleProviderAddKey({ id, apiKey: newApiKey, baseUrl, type, name })
    } catch (error) {
      window.toast.error(t('settings.models.provider_key_add_failed_by_invalid_data'))
      window.navigate('/settings/provider')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const onAddProvider = async () => {
    const { name: providerName, type, logo } = await AddProviderPopup.show()

    if (!providerName.trim()) {
      return
    }

    const provider = {
      id: uuid(),
      name: providerName.trim(),
      type,
      apiKey: '',
      apiHost: '',
      models: [],
      enabled: true,
      isSystem: false
    } as Provider

    let updatedLogos = { ...providerLogos }
    if (logo) {
      try {
        await ImageStorage.set(`provider-${provider.id}`, logo)
        updatedLogos = {
          ...updatedLogos,
          [provider.id]: logo
        }
        setProviderLogos(updatedLogos)
      } catch (error) {
        logger.error('Failed to save logo', error as Error)
        window.toast.error(t('message.error.save_provider_logo'))
      }
    }

    addProvider(provider)
    // A newly added connection needs key/host setup first, so it is selected
    // immediately: the unified pane starts with the configuration sections.
    selectProvider(provider)
  }

  const onRenameProvider = async (provider: Provider) => {
    const { name, type, logoFile, logo } = await AddProviderPopup.show(provider)

    if (!name) {
      return
    }

    updateProvider({ id: provider.id, name, type })

    if (provider.id) {
      if (logo) {
        try {
          await ImageStorage.set(`provider-${provider.id}`, logo)
          setProviderLogos((prev) => ({
            ...prev,
            [provider.id]: logo
          }))
        } catch (error) {
          logger.error('Failed to save logo', error as Error)
          window.toast.error(t('message.error.update_provider_logo'))
        }
      } else if (logo === undefined && logoFile === undefined) {
        try {
          await ImageStorage.set(`provider-${provider.id}`, '')
          setProviderLogos((prev) => {
            const newLogos = { ...prev }
            delete newLogos[provider.id]
            return newLogos
          })
        } catch (error) {
          logger.error('Failed to reset logo', error as Error)
        }
      }
    }
  }

  const onDeleteProvider = (provider: Provider) => {
    window.modal.confirm({
      title: t('settings.provider.delete.title'),
      content: t('settings.provider.delete.content'),
      okButtonProps: { danger: true },
      okText: t('common.delete'),
      centered: true,
      onOk: async () => {
        // 删除provider前先清理其logo
        if (provider.id) {
          try {
            await ImageStorage.remove(`provider-${provider.id}`)
            setProviderLogos((prev) => {
              const newLogos = { ...prev }
              delete newLogos[provider.id]
              return newLogos
            })
          } catch (error) {
            logger.error('Failed to delete logo', error as Error)
          }
        }

        // Custom-connection bootstrap: no system providers are guaranteed to
        // exist, so fall back to the first remaining entry instead of
        // assuming a system provider is present.
        const remaining = providers.filter((p) => p.id !== provider.id)
        setSelectedProviderId(remaining[0]?.id)
        removeProvider(provider)
      }
    })
  }

  const moveProviderToTop = useCallback(
    (providerId: string) => {
      const reorderedProviders = [...providers]
      const index = reorderedProviders.findIndex((p) => p.id === providerId)

      if (index !== -1) {
        const updatedProvider = { ...reorderedProviders[index], enabled: true }
        reorderedProviders.splice(index, 1)
        reorderedProviders.unshift(updatedProvider)
        updateProviders(reorderedProviders)
      }
    },
    [providers, updateProviders]
  )

  const onToggleEnabled = useCallback(
    (provider: Provider, enabled: boolean) => {
      updateProvider({ id: provider.id, enabled })
      if (enabled) {
        moveProviderToTop(provider.id)
      }
    },
    [moveProviderToTop, updateProvider]
  )

  const getConnectionMenu = (): MenuProps['items'] => {
    if (!selectedProvider) {
      return []
    }

    return [
      {
        label: t('common.edit'),
        key: 'edit',
        icon: <EditIcon size={14} />,
        onClick: () => onRenameProvider(selectedProvider)
      },
      {
        label: t('settings.provider.api.options.label'),
        key: 'api-settings',
        icon: <Bolt size={14} />,
        onClick: () => ApiOptionsSettingsPopup.show({ providerId: selectedProvider.id })
      },
      { type: 'divider' },
      {
        label: t('common.delete'),
        key: 'delete',
        icon: <DeleteIcon size={14} className="lucide-custom" />,
        danger: true,
        onClick: () => onDeleteProvider(selectedProvider)
      }
    ]
  }

  const filteredProviders = providers.filter((provider) => {
    const keywords = searchText.toLowerCase().split(/\s+/).filter(Boolean)
    // Connection search covers the stored connection name and id.
    return matchKeywordsInProvider(keywords, provider)
  })

  const { onDragEnd: handleReorder, itemKey } = useDraggableReorder({
    originalList: providers,
    filteredList: filteredProviders,
    onUpdate: updateProviders,
    itemKey: 'id' as keyof Provider
  })

  const handleDragStart = useCallback(() => {
    setDragging(true)
  }, [])

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      setDragging(false)
      handleReorder(result)
    },
    [handleReorder]
  )

  return (
    <Container data-testid="provider-settings">
      <ConnectionSwitcher
        providers={filteredProviders}
        currentProvider={selectedProvider}
        providerLogos={providerLogos}
        searchText={searchText}
        onSearchTextChange={setSearchText}
        onSelect={selectProvider}
        onToggleEnabled={onToggleEnabled}
        menuItems={getConnectionMenu()}
        onAddProvider={onAddProvider}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        itemKey={itemKey as (index: number) => Key}
        searchDisabled={dragging}
      />
      <ContentPane data-testid="provider-content-pane">
        {selectedProvider ? (
          <ProviderSetting key={selectedProvider.id} providerId={selectedProvider.id} />
        ) : (
          <EmptyProviderHint>
            <span>{t('settings.no_provider_selected')}</span>
          </EmptyProviderHint>
        )}
      </ContentPane>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
`

const ContentPane = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
`
const EmptyProviderHint = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-3);
  font-size: 14px;
`

export default ProviderList
