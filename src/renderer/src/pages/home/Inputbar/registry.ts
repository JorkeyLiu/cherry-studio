import { TopicType } from '@renderer/types'

import type { InputbarScope, InputbarScopeConfig } from './types'

const DEFAULT_INPUTBAR_SCOPE: InputbarScope = TopicType.Chat

const inputbarRegistry = new Map<InputbarScope, InputbarScopeConfig>([
  [
    TopicType.Chat,
    {
      minRows: 1,
      maxRows: 8,
      showTokenCount: true,
      showTools: true,
      toolsCollapsible: true,
      enableQuickPanel: true,
      enableDragDrop: true
    }
  ]
])

export const registerInputbarConfig = (scope: InputbarScope, config: InputbarScopeConfig): void => {
  inputbarRegistry.set(scope, config)
}

export const getInputbarConfig = (scope: InputbarScope): InputbarScopeConfig => {
  return inputbarRegistry.get(scope) || inputbarRegistry.get(DEFAULT_INPUTBAR_SCOPE)!
}
