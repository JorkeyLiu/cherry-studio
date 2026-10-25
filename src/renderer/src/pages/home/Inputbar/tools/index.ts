// Tool registry loader
// Import all tool definitions to register them

import './attachmentTool'
import './mentionModelsTool'
import './newTopicTool'
import './thinkingTool'
import './urlContextTool'
import './knowledgeBaseTool'
import './generateImageTool'

// Export registry functions
export { getAllTools, getTool, getToolsForScope, registerTool } from '../types'
