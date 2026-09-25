import { TopicType } from '@renderer/types'

export type MessageMenubarScope = TopicType

export type MessageMenubarButtonId =
  | 'user-regenerate'
  | 'user-edit'
  | 'copy'
  | 'assistant-regenerate'
  | 'assistant-mention-model'
  | 'translate'
  | 'useful'
  | 'notes'
  // True topic branch creation: visible assistant-message toolbar button.
  // The ONLY true-branch creation method.
  | 'true-branch'
  // Assistant insert/edit moved from the More menu into the visible toolbar
  // between Branch and Delete (exact order: Branch → Insert → Edit → Delete).
  | 'assistant-insert'
  | 'assistant-edit'
  | 'delete'
  | 'trace'
  | 'more-menu'
  | 'context-anchor'
  // dev only
  | 'inspect-data'

export type MessageMenubarScopeConfig = {
  buttonIds: MessageMenubarButtonId[]
  dropdownRootAllowKeys?: string[]
}

export const DEFAULT_MESSAGE_MENUBAR_SCOPE: MessageMenubarScope = TopicType.Chat

// Translate and Save to Notes live in the More menu (overflow), not as
// visible buttons; their button renderers stay reusable for scopes that
// still list them. Exact assistant visible order around branch management:
// Branch → Insert Message → Edit → Delete.
export const DEFAULT_MESSAGE_MENUBAR_BUTTON_IDS: MessageMenubarButtonId[] = [
  'user-regenerate',
  'user-edit',
  'copy',
  'assistant-regenerate',
  'assistant-mention-model',
  'useful',
  'context-anchor',
  'true-branch',
  'assistant-insert',
  'assistant-edit',
  'delete',
  'trace',
  'inspect-data',
  'more-menu'
]

const messageMenubarRegistry = new Map<MessageMenubarScope, MessageMenubarScopeConfig>([
  [DEFAULT_MESSAGE_MENUBAR_SCOPE, { buttonIds: [...DEFAULT_MESSAGE_MENUBAR_BUTTON_IDS] }],
  [TopicType.Chat, { buttonIds: [...DEFAULT_MESSAGE_MENUBAR_BUTTON_IDS] }]
])

export const registerMessageMenubarConfig = (scope: MessageMenubarScope, config: MessageMenubarScopeConfig) => {
  const clonedConfig: MessageMenubarScopeConfig = {
    buttonIds: [...config.buttonIds],
    dropdownRootAllowKeys: config.dropdownRootAllowKeys ? [...config.dropdownRootAllowKeys] : undefined
  }
  messageMenubarRegistry.set(scope, clonedConfig)
}

export const getMessageMenubarConfig = (scope: MessageMenubarScope): MessageMenubarScopeConfig => {
  if (messageMenubarRegistry.has(scope)) {
    return messageMenubarRegistry.get(scope) as MessageMenubarScopeConfig
  }
  return messageMenubarRegistry.get(DEFAULT_MESSAGE_MENUBAR_SCOPE) as MessageMenubarScopeConfig
}
