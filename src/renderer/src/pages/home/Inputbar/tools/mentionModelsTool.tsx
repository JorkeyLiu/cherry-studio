import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

import MentionModelsButton from './components/MentionModelsButton'

/**
 * Inputbar @ single-model selector. Keeps the lightweight @ icon position
 * and provider-grouped Popover list; a click selects exactly one current
 * model on the assistant. No mention state, no multi-select.
 */
const mentionModelsTool = defineTool({
  key: 'mention_models',
  label: (t) => t('assistants.presets.edit.model.select.title'),
  visibleInScopes: [TopicType.Chat],
  render: function MentionModelsToolRender(context) {
    return <MentionModelsButton assistant={context.assistant} />
  }
})

registerTool(mentionModelsTool)

export default mentionModelsTool
