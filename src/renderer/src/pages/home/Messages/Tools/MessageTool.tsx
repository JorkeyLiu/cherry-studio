import type { NormalToolResponse } from '@renderer/types'
import type { ToolMessageBlock } from '@renderer/types/newMessage'

import { MessageKnowledgeSearchToolTitle } from './MessageKnowledgeSearch'

interface Props {
  block: ToolMessageBlock
}
const builtinToolsPrefix = 'builtin_'

const ChooseTool = (toolResponse: NormalToolResponse): React.ReactNode | null => {
  let toolName = toolResponse.tool.name
  if (toolName.startsWith(builtinToolsPrefix)) {
    toolName = toolName.slice(builtinToolsPrefix.length)
    switch (toolName) {
      case 'knowledge_search':
        return <MessageKnowledgeSearchToolTitle toolResponse={toolResponse} />
      default:
        return null
    }
  }
  return null
}

export default function MessageTool({ block }: Props) {
  // Legacy storage key `rawMcpToolResponse` is preserved for historic block
  // readability only; no MCP execution path reads it.
  const toolResponse = block.metadata?.rawMcpToolResponse as NormalToolResponse

  if (!toolResponse) return null

  const toolRenderer = ChooseTool(toolResponse)

  if (!toolRenderer) return null

  return toolRenderer
}
