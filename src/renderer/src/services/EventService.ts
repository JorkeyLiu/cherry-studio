import Emittery from 'emittery'

export const EventEmitter = new Emittery()

export const EVENT_NAMES = {
  PLUGINS_UPDATED: 'PLUGINS_UPDATED',
  SEND_MESSAGE: 'SEND_MESSAGE',
  MESSAGE_COMPLETE: 'MESSAGE_COMPLETE',
  AI_AUTO_RENAME: 'AI_AUTO_RENAME',
  ADD_ASSISTANT: 'ADD_ASSISTANT',
  EDIT_MESSAGE: 'EDIT_MESSAGE',
  REGENERATE_MESSAGE: 'REGENERATE_MESSAGE',
  CHAT_COMPLETION_PAUSED: 'CHAT_COMPLETION_PAUSED',
  SHOW_ASSISTANTS: 'SHOW_ASSISTANTS',
  SHOW_TOPIC_SIDEBAR: 'SHOW_TOPIC_SIDEBAR',
  SWITCH_TOPIC_SIDEBAR: 'SWITCH_TOPIC_SIDEBAR',
  NEW_BRANCH: 'NEW_BRANCH',
  // True topic branches: distinct creation event for the toolbar button (the
  // ONLY true-branch creation method). NEW_BRANCH keeps its legacy Copy Topic
  // (clone-prefix) semantics for the assistant overflow menu.
  NEW_TRUE_BRANCH: 'NEW_TRUE_BRANCH',
  // Cross-topic history reference: read-only source action that creates a new
  // logical topic whose history is a live reference to the clicked source
  // route endpoint (readonly foreign prefix + writable owned suffix). Distinct
  // from the clone-prefix NEW_BRANCH copy contract.
  NEW_REFERENCE_TOPIC: 'NEW_REFERENCE_TOPIC',
  COPY_TOPIC_IMAGE: 'COPY_TOPIC_IMAGE',
  EXPORT_TOPIC_IMAGE: 'EXPORT_TOPIC_IMAGE',
  LOCATE_MESSAGE: 'LOCATE_MESSAGE',
  NAVIGATE_TO_MESSAGE: 'NAVIGATE_TO_MESSAGE',
  SCROLL_TO_BOTTOM: 'SCROLL_TO_BOTTOM',
  LOCATE_NOTE_LINE: 'LOCATE_NOTE_LINE',
  ADD_NEW_TOPIC: 'ADD_NEW_TOPIC',
  RESEND_MESSAGE: 'RESEND_MESSAGE',
  SHOW_MODEL_SELECTOR: 'SHOW_MODEL_SELECTOR',
  EDIT_CODE_BLOCK: 'EDIT_CODE_BLOCK',
  CHANGE_TOPIC: 'CHANGE_TOPIC'
}
