import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

import WebSearchButton from './components/WebSearchButton'

const webSearchTool = defineTool({
  key: 'web_search',
  label: (t) => t('chat.input.web_search.label'),
  visibleInScopes: [TopicType.Chat],
  condition: () => true,
  render: function WebSearchToolRender(context) {
    const { assistant } = context
    return <WebSearchButton assistantId={assistant.id} />
  }
})

registerTool(webSearchTool)

export default webSearchTool
