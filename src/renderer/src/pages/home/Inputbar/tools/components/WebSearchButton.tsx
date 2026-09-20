import { BaiduOutlined, GoogleOutlined } from '@ant-design/icons'
import { ActionIconButton } from '@renderer/components/Buttons'
import {
  BingLogo,
  BochaLogo,
  ExaLogo,
  QueritLogo,
  SearXNGLogo,
  TavilyLogo,
  ZhipuLogo
} from '@renderer/components/Icons'
import { isGemini3Model, isGeminiModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useWebSearchProviders } from '@renderer/hooks/useWebSearchProviders'
import ToolPopover from '@renderer/pages/home/Inputbar/components/ToolPopover'
import { getProviderByModel } from '@renderer/services/AssistantService'
import WebSearchService from '@renderer/services/WebSearchService'
import { getEffectiveMcpMode, type WebSearchProvider, type WebSearchProviderId } from '@renderer/types'
import { hasObjectKey } from '@renderer/utils'
import { isToolUseModeFunction } from '@renderer/utils/assistant'
import { isGeminiWebSearchProvider } from '@renderer/utils/provider'
import { Tooltip } from 'antd'
import { Check, Globe } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export const WebSearchProviderIcon = ({
  pid,
  size = 18,
  color
}: {
  pid?: WebSearchProviderId
  size?: number
  color?: string
}) => {
  switch (pid) {
    case 'bocha':
      return <BochaLogo className="icon" width={size} height={size} color={color} />
    case 'exa':
      return <ExaLogo className="icon" width={size - 2} height={size} color={color} />
    case 'tavily':
      return <TavilyLogo className="icon" width={size} height={size} color={color} />
    case 'zhipu':
      return <ZhipuLogo className="icon" width={size} height={size} color={color} />
    case 'searxng':
      return <SearXNGLogo className="icon" width={size} height={size} color={color} />
    case 'querit':
      return <QueritLogo className="icon" width={size} height={size} color={color} />
    case 'local-baidu':
      return <BaiduOutlined size={size} style={{ color, fontSize: size }} />
    case 'local-bing':
      return <BingLogo className="icon" width={size} height={size} color={color} />
    case 'local-google':
      return <GoogleOutlined size={size} style={{ color, fontSize: size }} />
    default:
      return <Globe className="icon" size={size} style={{ color, fontSize: size }} />
  }
}

interface Props {
  assistantId: string
}

const WebSearchButton: FC<Props> = ({ assistantId }) => {
  const { t } = useTranslation()
  const { assistant, updateAssistant } = useAssistant(assistantId)
  const { providers } = useWebSearchProviders()
  const [open, setOpen] = useState(false)

  const enableWebSearch = assistant?.webSearchProviderId || assistant.enableWebSearch
  const selectedProviderId = assistant.webSearchProviderId

  const updateWebSearchProvider = useCallback(
    async (providerId?: WebSearchProvider['id']) => {
      updateAssistant({
        ...assistant,
        webSearchProviderId: providerId,
        enableWebSearch: false
      } as any)
      setOpen(false)
    },
    [assistant, updateAssistant]
  )

  const handleProviderSelect = useCallback(
    async (providerId?: WebSearchProvider['id']) => {
      if (providerId === assistant.webSearchProviderId) {
        void updateWebSearchProvider(undefined)
      } else {
        void updateWebSearchProvider(providerId)
      }
    },
    [assistant.webSearchProviderId, updateWebSearchProvider]
  )

  const updateToModelBuiltinWebSearch = useCallback(async () => {
    const update = {
      ...assistant,
      webSearchProviderId: undefined,
      enableWebSearch: !assistant.enableWebSearch
    } as any
    const model = assistant.model
    if (!model) {
      setOpen(false)
      return
    }
    const provider = getProviderByModel(model)
    if (
      provider &&
      isGeminiWebSearchProvider(provider) &&
      isGeminiModel(model) &&
      !isGemini3Model(model) &&
      isToolUseModeFunction(assistant) &&
      update.enableWebSearch &&
      getEffectiveMcpMode(assistant) !== 'disabled'
    ) {
      update.enableWebSearch = false
      window.toast.warning(t('chat.mcp.warning.gemini_web_search'))
    }
    updateAssistant(update)
    setOpen(false)
  }, [assistant, updateAssistant, t])

  const providerItems = useMemo(() => {
    const items: Array<{
      id?: string
      label: string
      description: string
      icon: React.ReactNode
      isSelected: boolean
      disabled: boolean
      onClick: () => void
    }> = []

    // builtin first
    items.push({
      label: t('chat.input.web_search.builtin.label'),
      description: t('chat.input.web_search.builtin.enabled_content'),
      icon: <Globe size={16} />,
      isSelected: !!assistant.enableWebSearch,
      disabled: false,
      onClick: () => updateToModelBuiltinWebSearch()
    })

    providers
      .map((p) => ({
        p,
        disabled: !WebSearchService.isWebSearchEnabled(p.id),
        description: WebSearchService.isWebSearchEnabled(p.id)
          ? hasObjectKey(p, 'apiKey')
            ? t('settings.tool.websearch.apikey')
            : t('settings.tool.websearch.free')
          : t('chat.input.web_search.enable_content')
      }))
      .filter((x) => !x.disabled)
      .forEach(({ p, description }) => {
        items.push({
          id: p.id,
          label: p.name,
          description,
          icon: <WebSearchProviderIcon size={13} pid={p.id} />,
          isSelected: p.id === assistant?.webSearchProviderId,
          disabled: false,
          onClick: () => handleProviderSelect(p.id)
        })
      })

    return items
  }, [assistant, providers, t, handleProviderSelect, updateToModelBuiltinWebSearch])

  const ariaLabel = enableWebSearch ? t('common.close') : t('chat.input.web_search.label')

  const content = (
    <div>
      <PopoverTitle>{t('chat.input.web_search.label')}</PopoverTitle>
      <List>
        {providerItems.map((item) => (
          <ListItem
            key={item.id ?? 'builtin'}
            $selected={item.isSelected}
            onClick={item.onClick}
            data-testid={`websearch-option-${item.id ?? 'builtin'}`}
            data-selected={item.isSelected}>
            <Left>
              {item.icon}
              <div>
                <Label>{item.label}</Label>
                <Desc>{item.description}</Desc>
              </div>
            </Left>
            {item.isSelected && <Check size={14} />}
          </ListItem>
        ))}
      </List>
    </div>
  )

  return (
    <ToolPopover open={open} onOpenChange={setOpen} content={content}>
      <Tooltip placement="top" title={ariaLabel} mouseLeaveDelay={0} arrow open={open ? false : undefined}>
        <ActionIconButton active={!!enableWebSearch} aria-label={ariaLabel} aria-pressed={!!enableWebSearch}>
          <WebSearchProviderIcon pid={selectedProviderId} />
        </ActionIconButton>
      </Tooltip>
    </ToolPopover>
  )
}

const PopoverTitle = styled.div`
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
`

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;
`

const ListItem = styled.div<{ $selected?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  background: ${(p) => (p.$selected ? 'var(--color-background-soft)' : 'transparent')};
  &:hover {
    background: var(--color-background-soft);
  }
`

const Left = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const Label = styled.div`
  font-size: 13px;
`

const Desc = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
`

export default memo(WebSearchButton)
