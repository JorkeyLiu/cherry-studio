import type { MCPToolResponse, NormalToolResponse } from '@renderer/types'
import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { Flex } from 'antd'
import { Wrench } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { memo } from 'react'
import styled from 'styled-components'

import { type ToolStatus, ToolStatusIndicator } from './shared/GenericTools'

export interface ToolHeaderProps {
  block?: ToolMessageBlock

  toolName?: string
  icon?: ReactNode
  params?: ReactNode
  stats?: ReactNode

  // Common config
  status?: ToolStatus
  hasError?: boolean
  showStatus?: boolean // default true

  // Style variant
  variant?: 'standalone' | 'collapse-label'
}

const getToolDescription = (toolResponse?: MCPToolResponse | NormalToolResponse): string | undefined => {
  if (!toolResponse) return undefined
  const args = toolResponse.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined

  // Common description fields
  return (args.description || args.file_path || args.pattern || args.query || args.command || args.url)?.toString()
}

// ============ Styled Components ============

const HeaderContainer = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  font-size: 13px;
  padding: 8px 12px;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: 0.75rem;
  min-width: 0;
`

// Label variant: no border/padding, for use inside Collapse header
const LabelContainer = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  max-width: 100%;
  font-size: 13px;
  line-height: 14px;
  min-width: 0;
  height: 38px;

  .tool-name {
    gap: 0 !important;
    line-height: 14px;
  }

  .tool-icon {
    width: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
`

const ToolName = styled(Flex)`
  font-weight: 500;
  color: var(--color-text);
  flex-shrink: 0;

  .tool-icon {
    color: var(--color-primary);
  }

  .name {
    white-space: nowrap;
  }
`

const Description = styled.span`
  color: var(--color-text-2);
  font-weight: 400;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
  max-width: 300px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  text-align: left;
`

const Stats = styled.span`
  color: var(--color-text-2);
  font-weight: 400;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
`

const StatusWrapper = styled.div`
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;
`

// ============ Main Component ============

const ToolHeader: FC<ToolHeaderProps> = ({
  block,
  toolName: propToolName,
  icon: propIcon,
  params,
  stats,
  status: propStatus,
  hasError: propHasError,
  showStatus = true,
  variant = 'standalone'
}) => {
  const toolResponse = block?.metadata?.rawMcpToolResponse
  const tool = toolResponse?.tool

  const toolName = propToolName || tool?.name || 'Tool'

  const status = propStatus || (toolResponse?.status as ToolStatus)
  const hasError = propHasError ?? toolResponse?.response?.isError === true

  const description = params ?? getToolDescription(toolResponse)

  const Container = variant === 'standalone' ? HeaderContainer : LabelContainer

  // Removed MCP execution UI: legacy 'mcp' blocks render through the generic path below.

  return (
    <Container>
      <ToolName className="tool-name" align="center" gap={6}>
        <span className="tool-icon">{propIcon || <Wrench size={14} />}</span>
        <span className="name">{toolName}</span>
      </ToolName>
      {description && <Description>{description}</Description>}
      {stats && <Stats>{stats}</Stats>}
      {showStatus && status && (
        <StatusWrapper>
          <ToolStatusIndicator status={status} hasError={hasError} />
        </StatusWrapper>
      )}
    </Container>
  )
}

export default memo(ToolHeader)
