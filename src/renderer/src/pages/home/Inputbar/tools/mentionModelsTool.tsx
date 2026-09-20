import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import type React from 'react'

import MentionModelsButton from './components/MentionModelsButton'

const mentionModelsTool = defineTool({
  key: 'mention_models',
  label: (t) => t('assistants.presets.edit.model.select.title'),
  visibleInScopes: [TopicType.Chat],
  dependencies: {
    state: ['mentionedModels', 'files'] as const,
    actions: ['setMentionedModels', 'onTextChange'] as const
  },
  render: function MentionModelsToolRender(context) {
    const { state, actions } = context
    const { mentionedModels, files } = state
    const { setMentionedModels, onTextChange } = actions
    return (
      <MentionModelsButton
        mentionedModels={mentionedModels}
        setMentionedModels={setMentionedModels}
        files={files}
        setText={onTextChange as React.Dispatch<React.SetStateAction<string>>}
      />
    )
  }
})

registerTool(mentionModelsTool)

export default mentionModelsTool
