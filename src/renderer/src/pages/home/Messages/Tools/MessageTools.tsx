import type { ToolMessageBlock } from '@renderer/types/newMessage'

import MessageTool from './MessageTool'

interface Props {
  block: ToolMessageBlock
}

export default function MessageTools({ block }: Props) {
  const toolResponse = block.metadata?.rawMcpToolResponse
  if (!toolResponse) return null

  // Removed MCP execution UI: legacy 'mcp' blocks render through the generic
  // tool path for historic readability only (no approval/execution).
  return <MessageTool block={block} />
}
