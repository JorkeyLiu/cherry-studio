import { useAssistant } from '@renderer/hooks/useAssistant'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import type { KnowledgeBase } from '@renderer/types'
import { isPromptToolUse, isSupportedToolUse } from '@renderer/utils/assistant'
import { useCallback } from 'react'

import KnowledgeBaseButton from './components/KnowledgeBaseButton'

const knowledgeBaseTool = defineTool({
  key: 'knowledge_base',
  label: (t) => t('chat.input.knowledge_base'),
  visibleInScopes: [TopicType.Chat],
  condition: ({ assistant }) => isSupportedToolUse(assistant) || isPromptToolUse(assistant),
  dependencies: {
    state: ['selectedKnowledgeBases', 'files'] as const,
    actions: ['setSelectedKnowledgeBases'] as const
  },
  render: function KnowledgeBaseToolRender(context) {
    const { assistant, state, actions } = context
    const { updateAssistant } = useAssistant(assistant.id)
    const handleSelect = useCallback(
      (bases: KnowledgeBase[]) => {
        updateAssistant({ knowledge_bases: bases })
        actions.setSelectedKnowledgeBases?.(bases)
      },
      [updateAssistant, actions]
    )
    return (
      <KnowledgeBaseButton
        selectedBases={state.selectedKnowledgeBases}
        onSelect={handleSelect}
        disabled={Array.isArray(state.files) && state.files.length > 0}
      />
    )
  }
})

registerTool(knowledgeBaseTool)

export default knowledgeBaseTool
