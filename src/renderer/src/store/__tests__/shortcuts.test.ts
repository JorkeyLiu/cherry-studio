/**
 * LOCK-006: retired shortcut keys (Quick Assistant mini window) are hidden from
 * display/interaction while their persisted rows are retained.
 *
 * LOCK-003/LOCK-006: clear_topic (clear-messages) and toggle_new_context
 * (new-context) are retired end-to-end. Their historical migrate.ts rows are
 * retained, but the keys are retired (hidden) via RETIRED_SHORTCUT_KEYS.
 */
import { describe, expect, it } from 'vitest'

import { initialState, isRetiredShortcutKey, RETIRED_SHORTCUT_KEYS } from '../shortcuts'

describe('isRetiredShortcutKey (LOCK-006)', () => {
  it('marks the retired mini_window key as retired', () => {
    expect(RETIRED_SHORTCUT_KEYS.has('mini_window')).toBe(true)
    expect(isRetiredShortcutKey('mini_window')).toBe(true)
  })

  it('marks the retired clear_topic and toggle_new_context keys as retired', () => {
    expect(RETIRED_SHORTCUT_KEYS.has('clear_topic')).toBe(true)
    expect(isRetiredShortcutKey('clear_topic')).toBe(true)
    expect(RETIRED_SHORTCUT_KEYS.has('toggle_new_context')).toBe(true)
    expect(isRetiredShortcutKey('toggle_new_context')).toBe(true)
  })

  it('does not register the retired keys as active defaults', () => {
    const activeKeys = initialState.shortcuts.map((s) => s.key)
    expect(activeKeys).not.toContain('clear_topic')
    expect(activeKeys).not.toContain('toggle_new_context')
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
