import { isDedicatedImageGenerationModel, isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import ThinkingButton from '@renderer/pages/home/Inputbar/tools/components/ThinkingButton'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

const thinkingTool = defineTool({
  key: 'thinking',
  label: (t) => t('chat.input.thinking.label'),
  visibleInScopes: [TopicType.Chat],
  condition: ({ model }) => {
    // Unit B: reasoning controls are user-intent driven on ordinary chat.
    // Availability follows the endpoint/adapter's encodable options (all
    // ordinary-chat adapters encode the generic shapes); model reasoning
    // metadata never hides the control. `default` still means no override and
    // fixed-reasoning protocol facts stay in the button/resolver.
    if (!model) return false
    return !isEmbeddingModel(model) && !isRerankModel(model) && !isDedicatedImageGenerationModel(model)
  },
  render: ({ assistant, model, quickPanel }) => (
    <ThinkingButton quickPanel={quickPanel} model={model!} assistantId={assistant.id} />
  )
})

registerTool(thinkingTool)

export default thinkingTool
