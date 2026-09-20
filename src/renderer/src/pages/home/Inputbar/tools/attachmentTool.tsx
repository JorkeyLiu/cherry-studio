import AttachmentButton from '@renderer/pages/home/Inputbar/tools/components/AttachmentButton'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

const attachmentTool = defineTool({
  key: 'attachment',
  label: (t) => t('chat.input.upload.image_or_document'),
  visibleInScopes: [TopicType.Chat],
  dependencies: {
    state: ['files', 'couldAddImageFile', 'extensions'] as const,
    actions: ['setFiles'] as const
  },
  render: (context) => {
    const { state, actions } = context
    return (
      <AttachmentButton
        couldAddImageFile={state.couldAddImageFile}
        extensions={state.extensions}
        files={state.files}
        setFiles={actions.setFiles}
      />
    )
  }
})

registerTool(attachmentTool)

export default attachmentTool
