import { ActionIconButton } from '@renderer/components/Buttons'
import { isGemini3Model, isGeminiModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useMCPServers } from '@renderer/hooks/useMCPServers'
import { useTimer } from '@renderer/hooks/useTimer'
import ToolPopover from '@renderer/pages/home/Inputbar/components/ToolPopover'
import { getProviderByModel } from '@renderer/services/AssistantService'
import type { McpMode, MCPPrompt, MCPResource, MCPServer } from '@renderer/types'
import { getEffectiveMcpMode } from '@renderer/types'
import { isToolUseModeFunction } from '@renderer/utils/assistant'
import { isGeminiWebSearchProvider, isSupportUrlContextProvider } from '@renderer/utils/provider'
import { Divider, Form, Input, Tooltip } from 'antd'
import { Check, CircleX, Hammer, Plus, Sparkles } from 'lucide-react'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import styled from 'styled-components'

interface Props {
  assistantId: string
  setInputValue: React.Dispatch<React.SetStateAction<string>>
  resizeTextArea: () => void
}

interface PromptArgument {
  name: string
  description?: string
  required?: boolean
}

interface MCPPromptWithArgs extends MCPPrompt {
  arguments?: PromptArgument[]
}

interface ResourceData {
  blob?: string
  mimeType?: string
  name?: string
  text?: string
  uri?: string
}

const extractPromptContent = (response: any): string | null => {
  if (typeof response === 'string') return response
  if (response && Array.isArray(response.messages)) {
    let formatted = ''
    for (const message of response.messages) {
      if (!message.content) continue
      const rolePrefix = message.role ? `**${message.role.charAt(0).toUpperCase() + message.role.slice(1)}:** ` : ''
      switch (message.content.type) {
        case 'text':
          formatted += `${rolePrefix}${message.content.text}\n\n`
          break
        case 'image':
          if (message.content.data && message.content.mimeType) {
            if (rolePrefix) formatted += `${rolePrefix}\n`
            formatted += `![Image](data:${message.content.mimeType};base64,${message.content.data})\n\n`
          }
          break
        case 'audio':
          formatted += `${rolePrefix}[Audio content available]\n\n`
          break
        case 'resource':
          formatted += `${rolePrefix}${message.content.text ?? '[Resource content available]'}\n\n`
          break
        default:
          if (message.content.text) formatted += `${rolePrefix}${message.content.text}\n\n`
      }
    }
    return formatted.trim()
  }
  if (response?.messages?.[0]?.content?.text) {
    const message = response.messages[0]
    const rolePrefix = message.role ? `**${message.role.charAt(0).toUpperCase() + message.role.slice(1)}:** ` : ''
    return `${rolePrefix}${message.content.text}`
  }
  return null
}

const MCPToolsButton: FC<Props> = ({ setInputValue, resizeTextArea, assistantId }) => {
  const { activedMcpServers } = useMCPServers()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const { assistant, updateAssistant } = useAssistant(assistantId)
  const model = assistant.model
  const { setTimeoutTimer } = useTimer()
  const [open, setOpen] = useState(false)

  const currentMode = useMemo(() => getEffectiveMcpMode(assistant), [assistant])
  const mcpServers = useMemo(() => assistant.mcpServers || [], [assistant.mcpServers])
  const assistantMcpServers = useMemo(
    () => activedMcpServers.filter((server) => mcpServers.some((s) => s.id === server.id)),
    [activedMcpServers, mcpServers]
  )

  const handleModeChange = useCallback(
    (mode: McpMode) => {
      if (mode === 'manual') {
        setTimeoutTimer(
          'updateMcpMode',
          () => {
            updateAssistant({ ...assistant, mcpMode: mode })
          },
          200
        )
        return
      }
      setTimeoutTimer(
        'updateMcpMode',
        () => {
          updateAssistant({ ...assistant, mcpMode: mode })
          setOpen(false)
        },
        200
      )
    },
    [assistant, setTimeoutTimer, updateAssistant]
  )

  const handleMcpServerSelect = useCallback(
    (server: MCPServer) => {
      const update: any = { ...assistant }
      if (assistantMcpServers.some((s) => s.id === server.id)) {
        update.mcpServers = mcpServers.filter((s) => s.id !== server.id)
      } else {
        update.mcpServers = [...mcpServers, server]
      }
      if (update.mcpServers.length > 0 && isGeminiModel(model) && isToolUseModeFunction(assistant)) {
        const provider = getProviderByModel(model)
        if (provider && isSupportUrlContextProvider(provider) && assistant.enableUrlContext) {
          window.toast.warning(t('chat.mcp.warning.url_context'))
          update.enableUrlContext = false
        }
        if (provider && isGeminiWebSearchProvider(provider) && assistant.enableWebSearch && !isGemini3Model(model)) {
          window.toast.warning(t('chat.mcp.warning.gemini_web_search'))
          update.enableWebSearch = false
        }
      }
      update.mcpMode = 'manual'
      updateAssistant(update)
    },
    [assistant, assistantMcpServers, mcpServers, model, t, updateAssistant]
  )

  const insertPromptIntoTextArea = useCallback(
    (promptText: string) => {
      setInputValue((prev) => {
        const textArea = document.querySelector('.inputbar textarea') as HTMLTextAreaElement
        if (!textArea) return prev + promptText
        const cursorPosition = textArea.selectionStart
        const newText = prev.slice(0, cursorPosition) + promptText + prev.slice(cursorPosition)
        requestAnimationFrame(() => {
          textArea.focus()
          textArea.setSelectionRange(cursorPosition, cursorPosition + promptText.length)
          resizeTextArea()
        })
        return newText
      })
    },
    [setInputValue, resizeTextArea]
  )

  const handlePromptSelect = useCallback(
    (prompt: MCPPromptWithArgs) => {
      const server = activedMcpServers.find((s) => s.id === prompt.serverId)
      if (!server) return
      const handlePromptResponse = async (response: any) => {
        const promptContent = extractPromptContent(response)
        if (promptContent) insertPromptIntoTextArea(promptContent)
        else throw new Error('Invalid prompt response format')
      }
      const handlePromptWithArgs = async () => {
        try {
          form.resetFields()
          const result = await new Promise<Record<string, string>>((resolve, reject) => {
            window.modal.confirm({
              title: `${t('settings.mcp.prompts.arguments')}: ${prompt.name}`,
              content: (
                <Form form={form} layout="vertical">
                  {prompt.arguments?.map((arg, index) => (
                    <Form.Item
                      key={index}
                      name={arg.name}
                      label={`${arg.name}${arg.required ? ' *' : ''}`}
                      tooltip={arg.description}
                      rules={
                        arg.required ? [{ required: true, message: t('settings.mcp.prompts.requiredField') }] : []
                      }>
                      <Input placeholder={arg.description || arg.name} />
                    </Form.Item>
                  ))}
                </Form>
              ),
              onOk: async () => {
                try {
                  const values = await form.validateFields()
                  resolve(values)
                } catch (error) {
                  reject(error)
                }
              },
              onCancel: () => reject(new Error('cancelled')),
              okText: t('common.confirm'),
              cancelText: t('common.cancel')
            })
          })
          const response = await window.api.mcp.getPrompt({ server, name: prompt.name, args: result })
          await handlePromptResponse(response)
        } catch (error: any) {
          if (error.message !== 'cancelled') {
            window.modal.error({
              title: t('common.error'),
              content: error.message || t('settings.mcp.prompts.genericError')
            })
          }
        }
      }
      const handlePromptWithoutArgs = async () => {
        try {
          const response = await window.api.mcp.getPrompt({ server, name: prompt.name })
          await handlePromptResponse(response)
        } catch (error: any) {
          window.modal.error({
            title: t('common.error'),
            content: error.message || t('settings.mcp.prompts.genericError')
          })
        }
      }
      requestAnimationFrame(() => {
        const hasArguments = prompt.arguments && prompt.arguments.length > 0
        if (hasArguments) void handlePromptWithArgs()
        else void handlePromptWithoutArgs()
      })
    },
    [activedMcpServers, form, t, insertPromptIntoTextArea]
  )

  const [prompts, setPrompts] = useState<(MCPPrompt & { serverId: string })[]>([])
  useEffect(() => {
    let mounted = true
    const fetch = async () => {
      const all: MCPPrompt[] = []
      for (const server of activedMcpServers) {
        const list = await window.api.mcp.listPrompts(server)
        all.push(...list)
      }
      if (mounted) setPrompts(all)
    }
    void fetch()
    return () => {
      mounted = false
    }
  }, [activedMcpServers])

  const handleResourceSelect = useCallback(
    (resource: MCPResource) => {
      const server = activedMcpServers.find((s) => s.id === resource.serverId)
      if (!server) return
      const processResourceContent = (resourceData: ResourceData) => {
        if (resourceData.blob) {
          if (resourceData.mimeType?.startsWith('image/')) {
            insertPromptIntoTextArea(
              `![${resourceData.name || 'Image'}](data:${resourceData.mimeType};base64,${resourceData.blob})`
            )
          } else {
            insertPromptIntoTextArea(
              `[${resourceData.name || resource.name} - ${resourceData.mimeType || t('settings.mcp.resources.blobInvisible')}]`
            )
          }
        } else if (resourceData.text) {
          insertPromptIntoTextArea(resourceData.text)
        } else {
          insertPromptIntoTextArea(`[${resourceData.name || resource.name} - ${resourceData.uri || resource.uri}]`)
        }
      }
      requestAnimationFrame(async () => {
        try {
          const response = await window.api.mcp.getResource({ server, uri: resource.uri })
          if (response?.contents && Array.isArray(response.contents)) {
            response.contents.forEach((content: ResourceData) => processResourceContent(content))
          } else {
            processResourceContent(response as ResourceData)
          }
        } catch (error: any) {
          window.modal.error({
            title: t('common.error'),
            content: error.message || t('settings.mcp.resources.genericError')
          })
        }
      })
    },
    [activedMcpServers, t, insertPromptIntoTextArea]
  )

  const [resources, setResources] = useState<MCPResource[]>([])
  useEffect(() => {
    let mounted = true
    const fetch = async () => {
      const all: MCPResource[] = []
      for (const server of activedMcpServers) {
        const list = await window.api.mcp.listResources(server)
        all.push(...list)
      }
      if (mounted) setResources(all)
    }
    void fetch()
    return () => {
      mounted = false
    }
  }, [activedMcpServers])

  const isActive = currentMode !== 'disabled'
  const getButtonIcon = () => {
    switch (currentMode) {
      case 'auto':
        return <Sparkles size={18} />
      default:
        return <Hammer size={18} />
    }
  }

  const content = (
    <div>
      <PopoverTitle>{t('settings.mcp.title')}</PopoverTitle>

      <SectionTitle>
        {t('assistants.settings.mcp.mode.disabled.label')} / {t('assistants.settings.mcp.mode.auto.label')} /{' '}
        {t('assistants.settings.mcp.mode.manual.label')}
      </SectionTitle>
      <List>
        <ListItem
          $selected={currentMode === 'disabled'}
          onClick={() => handleModeChange('disabled')}
          data-testid="mcp-mode-disabled"
          data-selected={currentMode === 'disabled'}>
          <Left>
            <CircleX size={16} />
            <div>
              <Label>{t('assistants.settings.mcp.mode.disabled.label')}</Label>
              <Desc>{t('assistants.settings.mcp.mode.disabled.description')}</Desc>
            </div>
          </Left>
          {currentMode === 'disabled' && <Check size={14} />}
        </ListItem>
        <ListItem
          $selected={currentMode === 'auto'}
          onClick={() => handleModeChange('auto')}
          data-testid="mcp-mode-auto"
          data-selected={currentMode === 'auto'}>
          <Left>
            <Sparkles size={16} />
            <div>
              <Label>{t('assistants.settings.mcp.mode.auto.label')}</Label>
              <Desc>{t('assistants.settings.mcp.mode.auto.description')}</Desc>
            </div>
          </Left>
          {currentMode === 'auto' && <Check size={14} />}
        </ListItem>
        <ListItem
          $selected={currentMode === 'manual'}
          onClick={() => handleModeChange('manual')}
          data-testid="mcp-mode-manual"
          data-selected={currentMode === 'manual'}>
          <Left>
            <Hammer size={16} />
            <div>
              <Label>{t('assistants.settings.mcp.mode.manual.label')}</Label>
              <Desc>{t('assistants.settings.mcp.mode.manual.description')}</Desc>
            </div>
          </Left>
          {currentMode === 'manual' && <Check size={14} />}
        </ListItem>
      </List>

      {currentMode === 'manual' && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <SectionTitle>{t('settings.mcp.tabs.prompts')} / Servers</SectionTitle>
          <List>
            {activedMcpServers.map((server) => {
              const selected = assistantMcpServers.some((s) => s.id === server.id)
              return (
                <ListItem
                  key={server.id}
                  $selected={selected}
                  onClick={() => handleMcpServerSelect(server)}
                  data-testid={`mcp-server-${server.id}`}
                  data-selected={selected}>
                  <Left>
                    <Hammer size={16} />
                    <div>
                      <Label>{server.name}</Label>
                      <Desc>{server.description || server.baseUrl}</Desc>
                    </div>
                  </Left>
                  {selected && <Check size={14} />}
                </ListItem>
              )
            })}
            <ListItem onClick={() => navigate('/settings/mcp')} data-testid="mcp-add-server">
              <Left>
                <Plus size={16} />
                <Label>{t('settings.mcp.addServer.label')}...</Label>
              </Left>
            </ListItem>
          </List>
        </>
      )}

      {prompts.length > 0 && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <SectionTitle>MCP {t('settings.mcp.tabs.prompts')}</SectionTitle>
          <List>
            {prompts.map((prompt) => (
              <ListItem
                key={`${prompt.serverId}:${prompt.name}`}
                onClick={() => handlePromptSelect(prompt as MCPPromptWithArgs)}
                data-testid={`mcp-prompt-${prompt.name}`}>
                <Left>
                  <Hammer size={14} />
                  <div>
                    <Label>{prompt.name}</Label>
                    {prompt.description && <Desc>{prompt.description}</Desc>}
                  </div>
                </Left>
              </ListItem>
            ))}
          </List>
        </>
      )}

      {resources.length > 0 && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <SectionTitle>MCP {t('settings.mcp.tabs.resources')}</SectionTitle>
          <List>
            {resources.map((resource) => (
              <ListItem
                key={`${resource.serverId}:${resource.uri}`}
                onClick={() => handleResourceSelect(resource)}
                data-testid={`mcp-resource-${resource.name}`}>
                <Left>
                  <Hammer size={14} />
                  <div>
                    <Label>{resource.name}</Label>
                    {resource.description && <Desc>{resource.description}</Desc>}
                  </div>
                </Left>
              </ListItem>
            ))}
          </List>
        </>
      )}
    </div>
  )

  return (
    <ToolPopover open={open} onOpenChange={setOpen} content={content} width={320}>
      <Tooltip
        placement="top"
        title={t('settings.mcp.title')}
        mouseLeaveDelay={0}
        arrow
        open={open ? false : undefined}>
        <ActionIconButton active={isActive} aria-label={t('settings.mcp.title')}>
          {getButtonIcon()}
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

const SectionTitle = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  margin: 6px 0 4px;
`

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
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

export default React.memo(MCPToolsButton)
