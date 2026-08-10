/**
 * LOCK-006: retired shortcut keys (Quick Assistant mini window) are hidden from
 * display/interaction while their persisted rows are retained.
 */
import { describe, expect, it } from 'vitest'

import { isRetiredShortcutKey, RETIRED_SHORTCUT_KEYS } from '../shortcuts'

describe('isRetiredShortcutKey (LOCK-006)', () => {
  it('marks the retired mini_window key as retired', () => {
    expect(RETIRED_SHORTCUT_KEYS.has('mini_window')).toBe(true)
    expect(isRetiredShortcutKey('mini_window')).toBe(true)
  })

  it('does not retire active shortcut keys', () => {
    const activeKeys = [
      'show_settings',
      'show_app',
      'new_topic',
      'rename_topic',
      'toggle_show_assistants',
      'toggle_show_topics',
      'toggle_edit_mode',
      'copy_last_message',
      'edit_last_user_message',
      'search_message_in_chat',
      'search_message',
      'clear_topic',
      'toggle_new_context',
      'select_model',
      'exit_fullscreen',
      'zoom_in',
      'zoom_out',
      'zoom_reset'
    ]

    for (const key of activeKeys) {
      expect(isRetiredShortcutKey(key)).toBe(false)
    }
  })

  it('does not retire unknown/future keys', () => {
    expect(isRetiredShortcutKey('future_shortcut_key')).toBe(false)
  })
})
