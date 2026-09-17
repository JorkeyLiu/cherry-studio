import { adaptProvider } from '@renderer/aiCore/provider/providerConfig'
import { showErrorDetailPopup } from '@renderer/components/ErrorDetailModal'
import { LoadingIcon } from '@renderer/components/Icons'
import { HStack } from '@renderer/components/Layout'
import { ApiKeyListPopup } from '@renderer/components/Popups/ApiKeyListPopup'
import Selector from '@renderer/components/Selector'
import { HelpTooltip } from '@renderer/components/TooltipIcons'
import { isRerankModel } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useAllProviders, useProvider, useProviders } from '@renderer/hooks/useProvider'
import { useTimer } from '@renderer/hooks/useTimer'
import AnthropicSettings from '@renderer/pages/settings/ProviderSettings/AnthropicSettings'
import { ModelList } from '@renderer/pages/settings/ProviderSettings/ModelList'
import { checkApi } from '@renderer/services/ApiService'
import { isProviderSupportAuth } from '@renderer/services/ProviderService'
import type { ApiKeyConnectivity } from '@renderer/types/healthCheck'
import { HealthStatus } from '@renderer/types/healthCheck'
import { formatApiHost, formatApiKeys, getFancyProviderName, validateApiHost } from '@renderer/utils'
import { serializeHealthCheckError } from '@renderer/utils/error'
import {
  isAnthropicProvider,
  isGeminiProvider,
  isOpenAICompatibleProvider,
  isOpenAIProvider
} from '@renderer/utils/provider'
import { Button, Divider, Flex, Input, Select, Space, Switch, Tooltip } from 'antd'
import { debounce, isEmpty } from 'lodash'
import { Bolt, Check, Settings2, TriangleAlert } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingContainer, SettingHelpText, SettingHelpTextRow, SettingSubtitle, SettingTitle } from '..'
import ApiOptionsSettingsPopup from './ApiOptionsSettings/ApiOptionsSettingsPopup'
import CustomHeaderPopup from './CustomHeaderPopup'
import SelectProviderModelPopup from './SelectProviderModelPopup'

interface Props {
  providerId: string
}

type HostField = 'apiHost' | 'anthropicApiHost'

const ProviderSetting: FC<Props> = ({ providerId }) => {
  const { provider, updateProvider, models } = useProvider(providerId)
  const allProviders = useAllProviders()
  const { updateProviders } = useProviders()
  const [apiHost, setApiHost] = useState(provider.apiHost)
  const [anthropicApiHost, setAnthropicHost] = useState<string | undefined>(provider.anthropicApiHost)
  const [activeHostField, setActiveHostField] = useState<HostField>('apiHost')
  const { t, i18n } = useTranslation()
  const { theme } = useTheme()
  const { setTimeoutTimer } = useTimer()

  const fancyProviderName = getFancyProviderName(provider)

  const [localApiKey, setLocalApiKey] = useState(provider.apiKey)
  const [apiKeyConnectivity, setApiKeyConnectivity] = useState<ApiKeyConnectivity>({
    status: HealthStatus.NOT_CHECKED,
    checking: false
  })

  // Store callbacks in ref to avoid recreating debounce function when dependencies change
  const callbacks = { updateProvider }
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const debouncedUpdateApiKey = useMemo(
    () =>
      debounce((value: string) => {
        const { updateProvider } = callbacksRef.current
        const formattedKey = formatApiKeys(value)
        updateProvider({ apiKey: formattedKey })
      }, 150),
    []
  )

  // Track whether update comes from external source to avoid loops
  const isExternalUpdateRef = useRef(false)

  // Sync provider.apiKey to localApiKey and reset connectivity status
  useEffect(() => {
    // Cancel any pending debounce calls to prevent old values from overwriting new ones
    debouncedUpdateApiKey.cancel()
    isExternalUpdateRef.current = true
    setLocalApiKey(provider.apiKey)
    setApiKeyConnectivity({ status: HealthStatus.NOT_CHECKED })
  }, [provider.apiKey, debouncedUpdateApiKey])

  // Sync localApiKey to provider.apiKey (debounced)
  // Only trigger on user input, not on external updates
  useEffect(() => {
    if (isExternalUpdateRef.current) {
      isExternalUpdateRef.current = false
      return
    }
    if (localApiKey !== provider.apiKey) {
      debouncedUpdateApiKey(localApiKey)
    }
  }, [localApiKey, provider.apiKey, debouncedUpdateApiKey])

  // Flush pending updates on unmount to prevent data loss
  useEffect(() => {
    return () => {
      debouncedUpdateApiKey.flush()
    }
  }, [debouncedUpdateApiKey])

  const isApiKeyConnectable = useMemo(() => {
    return apiKeyConnectivity.status === 'success'
  }, [apiKeyConnectivity])

  const moveProviderToTop = useCallback(
    (providerId: string) => {
      const reorderedProviders = [...allProviders]
      const index = reorderedProviders.findIndex((p) => p.id === providerId)

      if (index !== -1) {
        const updatedProvider = { ...reorderedProviders[index], enabled: true }
        reorderedProviders.splice(index, 1)
        reorderedProviders.unshift(updatedProvider)
        updateProviders(reorderedProviders)
      }
    },
    [allProviders, updateProviders]
  )

  const onUpdateApiHost = () => {
    if (!validateApiHost(apiHost)) {
      setApiHost(provider.apiHost)
      window.toast.error(t('settings.provider.api_host_no_valid'))
      return
    }
    if (apiHost.trim()) {
      updateProvider({ apiHost })
    } else {
      setApiHost(provider.apiHost)
    }
  }

  const onUpdateAnthropicHost = () => {
    const trimmedHost = anthropicApiHost?.trim()

    if (trimmedHost) {
      updateProvider({ anthropicApiHost: trimmedHost })
      setAnthropicHost(trimmedHost)
    } else {
      updateProvider({ anthropicApiHost: undefined })
      setAnthropicHost(undefined)
    }
  }

  const openApiKeyList = async () => {
    if (localApiKey !== provider.apiKey) {
      updateProvider({ apiKey: formatApiKeys(localApiKey) })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    await ApiKeyListPopup.show({
      providerId: provider.id,
      title: `${fancyProviderName} ${t('settings.provider.api.key.list.title')}`,
      providerType: 'llm'
    })
  }

  const onCheckApi = async () => {
    const formattedLocalKey = formatApiKeys(localApiKey)

    // 如果存在多个密钥，直接打开管理窗口
    if (formattedLocalKey.includes(',')) {
      await openApiKeyList()
      return
    }

    const modelsToCheck = models.filter((model) => !isRerankModel(model))

    if (isEmpty(modelsToCheck)) {
      window.toast.error({
        timeout: 5000,
        title: t('settings.provider.no_models_for_check')
      })
      return
    }

    const model = await SelectProviderModelPopup.show({ provider })

    if (!model) {
      window.toast.error(i18n.t('message.error.enter.model'))
      return
    }

    try {
      setApiKeyConnectivity((prev) => ({ ...prev, checking: true, status: HealthStatus.NOT_CHECKED }))
      await checkApi({ ...provider, apiHost, apiKey: formattedLocalKey }, model)

      window.toast.success({
        timeout: 2000,
        title: i18n.t('message.api.connection.success')
      })

      setApiKeyConnectivity((prev) => ({ ...prev, status: HealthStatus.SUCCESS }))

      setTimeoutTimer(
        'onCheckApi',
        () => {
          setApiKeyConnectivity((prev) => ({ ...prev, status: HealthStatus.NOT_CHECKED }))
        },
        3000
      )
    } catch (error: unknown) {
      window.toast.error({
        timeout: 8000,
        title: i18n.t('message.api.connection.failed')
      })

      const serializedError = serializeHealthCheckError(error)

      setApiKeyConnectivity((prev) => ({ ...prev, status: HealthStatus.FAILED, error: serializedError }))
    } finally {
      setApiKeyConnectivity((prev) => ({ ...prev, checking: false }))
    }
  }

  const hostPreview = () => {
    const formattedApiHost = adaptProvider({ provider: { ...provider, apiHost } }).apiHost

    if (isOpenAICompatibleProvider(provider)) {
      return formattedApiHost + '/chat/completions'
    }

    if (isAnthropicProvider(provider)) {
      return formattedApiHost + '/messages'
    }

    if (isGeminiProvider(provider)) {
      return formattedApiHost + '/models'
    }
    if (isOpenAIProvider(provider)) {
      return formattedApiHost + '/responses'
    }
    return formattedApiHost
  }

  // API key 连通性检查状态指示器，目前仅在失败时显示
  const renderStatusIndicator = () => {
    if (apiKeyConnectivity.checking || apiKeyConnectivity.status !== HealthStatus.FAILED) {
      return null
    }

    return (
      <>
        <Tooltip title={apiKeyConnectivity.error?.message || t('settings.models.check.failed')}>
          <TriangleAlert
            size={16}
            color="var(--color-status-warning)"
            style={{ cursor: 'pointer' }}
            onClick={() => showErrorDetailPopup({ error: apiKeyConnectivity.error })}
          />
        </Tooltip>
      </>
    )
  }

  useEffect(() => {
    setApiHost(provider.apiHost)
  }, [provider.apiHost, provider.id])

  useEffect(() => {
    setAnthropicHost(provider.anthropicApiHost)
  }, [provider.anthropicApiHost])

  // Custom-connection product: the Anthropic-compatible host is a
  // per-connection stored option. Any OpenAI-family connection may configure
  // it; no built-in brand id list is consulted.
  const canConfigureAnthropicHost = useMemo(() => {
    return provider.type === 'openai' || provider.type === 'openai-response'
  }, [provider.type])

  const anthropicHostPreview = useMemo(() => {
    const rawHost = anthropicApiHost ?? provider.anthropicApiHost
    // AI SDK uses the baseURL with /v1, then appends /messages
    const normalizedHost = formatApiHost(rawHost)

    return `${normalizedHost}/messages`
  }, [anthropicApiHost, provider.anthropicApiHost])

  const hostSelectorOptions = useMemo(() => {
    const options: { value: HostField; label: string }[] = [
      { value: 'apiHost', label: t('settings.provider.api_host') }
    ]

    if (canConfigureAnthropicHost) {
      options.push({ value: 'anthropicApiHost', label: t('settings.provider.anthropic_api_host') })
    }

    return options
  }, [canConfigureAnthropicHost, t])

  useEffect(() => {
    if (!canConfigureAnthropicHost && activeHostField === 'anthropicApiHost') {
      setActiveHostField('apiHost')
    }
  }, [canConfigureAnthropicHost, activeHostField])

  const hostSelectorTooltip =
    activeHostField === 'anthropicApiHost'
      ? t('settings.provider.anthropic_api_host_tooltip')
      : t('settings.provider.api_host_tooltip')

  const isAnthropicOAuth = () => provider.type === 'anthropic' && provider.authType === 'oauth'

  return (
    <SettingContainer theme={theme} style={{ background: 'var(--color-background)' }}>
      <SettingTitle>
        <Flex align="center" gap={8}>
          <ProviderName>{fancyProviderName}</ProviderName>
          <Tooltip title={t('settings.provider.api.options.label')}>
            <Button
              type="text"
              icon={<Bolt size={14} />}
              size="small"
              onClick={() => ApiOptionsSettingsPopup.show({ providerId: provider.id })}
            />
          </Tooltip>
        </Flex>
        <Switch
          value={provider.enabled}
          key={provider.id}
          onChange={(enabled) => {
            updateProvider({ apiHost, enabled })
            if (enabled) {
              moveProviderToTop(provider.id)
            }
          }}
        />
      </SettingTitle>
      <Divider style={{ width: '100%', margin: '10px 0' }} />
      {provider.type === 'anthropic' && (
        <>
          <SettingSubtitle style={{ marginTop: 5 }}>{t('settings.provider.anthropic.auth_method')}</SettingSubtitle>
          <Select
            style={{ width: '40%', marginTop: 5, marginBottom: 10 }}
            value={provider.authType || 'apiKey'}
            onChange={(value) => updateProvider({ authType: value })}
            options={[
              { value: 'apiKey', label: t('settings.provider.anthropic.apikey') },
              { value: 'oauth', label: t('settings.provider.anthropic.oauth') }
            ]}
          />
          {provider.authType === 'oauth' && <AnthropicSettings />}
        </>
      )}
      {!isAnthropicOAuth() && (
        <>
          <>
            <SettingSubtitle
              style={{
                marginTop: 5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
              {t('settings.provider.api_key.label')}
              <Tooltip title={t('settings.provider.api.key.list.open')} mouseEnterDelay={0.5}>
                <Button type="text" onClick={openApiKeyList} icon={<Settings2 size={16} />} />
              </Tooltip>
            </SettingSubtitle>
            <Space.Compact style={{ width: '100%', marginTop: 5 }}>
              <Input.Password
                value={localApiKey}
                placeholder={t('settings.provider.api_key.label')}
                onChange={(e) => setLocalApiKey(e.target.value)}
                spellCheck={false}
                autoFocus={provider.enabled && provider.apiKey === '' && !isProviderSupportAuth(provider)}
                suffix={renderStatusIndicator()}
              />
              <Button
                type={isApiKeyConnectable ? 'primary' : 'default'}
                ghost={isApiKeyConnectable}
                onClick={onCheckApi}
                disabled={!apiHost || apiKeyConnectivity.checking}>
                {apiKeyConnectivity.checking ? (
                  <LoadingIcon />
                ) : apiKeyConnectivity.status === 'success' ? (
                  <Check size={16} className="lucide-custom" />
                ) : (
                  t('settings.provider.check')
                )}
              </Button>
            </Space.Compact>
            <SettingHelpTextRow style={{ justifyContent: 'space-between' }}>
              <HStack>
                <></>
              </HStack>
              <SettingHelpText>{t('settings.provider.api_key.tip')}</SettingHelpText>
            </SettingHelpTextRow>
          </>
          <>
            <SettingSubtitle style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="flex items-center gap-1">
                <Tooltip title={hostSelectorTooltip} mouseEnterDelay={0.3}>
                  <div>
                    <Selector
                      size={14}
                      value={activeHostField}
                      onChange={(value) => setActiveHostField(value)}
                      options={hostSelectorOptions}
                      style={{ paddingLeft: 1, fontWeight: 'bold' }}
                      placement="bottomLeft"
                    />
                  </div>
                </Tooltip>
                <HelpTooltip title={t('settings.provider.api.url.tip')}></HelpTooltip>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Button
                  type="text"
                  onClick={() => CustomHeaderPopup.show({ provider })}
                  icon={<Settings2 size={16} />}
                />
              </div>
            </SettingSubtitle>
            {activeHostField === 'apiHost' && (
              <>
                <Space.Compact style={{ width: '100%', marginTop: 5 }}>
                  <Input
                    value={apiHost}
                    placeholder={t('settings.provider.api_host')}
                    onChange={(e) => setApiHost(e.target.value)}
                    onBlur={onUpdateApiHost}
                  />
                </Space.Compact>
                <SettingHelpTextRow style={{ justifyContent: 'space-between' }}>
                  <SettingHelpText
                    style={{
                      marginLeft: 6,
                      marginRight: '1em',
                      whiteSpace: 'break-spaces',
                      wordBreak: 'break-all'
                    }}>
                    {t('settings.provider.api_host_preview', { url: hostPreview() })}
                  </SettingHelpText>
                </SettingHelpTextRow>
              </>
            )}

            {activeHostField === 'anthropicApiHost' && canConfigureAnthropicHost && (
              <>
                <Space.Compact style={{ width: '100%', marginTop: 5 }}>
                  <Input
                    value={anthropicApiHost ?? ''}
                    placeholder={t('settings.provider.anthropic_api_host')}
                    onChange={(e) => setAnthropicHost(e.target.value)}
                    onBlur={onUpdateAnthropicHost}
                  />
                </Space.Compact>
                <SettingHelpTextRow style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                  <SettingHelpText style={{ marginLeft: 6, whiteSpace: 'break-spaces', wordBreak: 'break-all' }}>
                    {t('settings.provider.anthropic_api_host_preview', {
                      url: anthropicHostPreview || '—'
                    })}
                  </SettingHelpText>
                </SettingHelpTextRow>
              </>
            )}
          </>
        </>
      )}
      <SettingSubtitle style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        {t('settings.provider.require_api_key.label')}
        <Switch
          size="small"
          checked={provider.apiOptions?.requiresApiKey !== false}
          onChange={(checked) => updateProvider({ apiOptions: { ...provider.apiOptions, requiresApiKey: checked } })}
        />
      </SettingSubtitle>
      <SettingHelpTextRow style={{ justifyContent: 'space-between' }}>
        <SettingHelpText>{t('settings.provider.require_api_key.tip')}</SettingHelpText>
      </SettingHelpTextRow>
      <ModelList providerId={provider.id} />
    </SettingContainer>
  )
}

const ProviderName = styled.span`
  font-size: 14px;
  font-weight: 500;
  margin-right: -2px;
`

export default ProviderSetting
