/**
 * Regression for tray defaults (renderer): fresh installs must not enable
 * tray or trayOnClose by default. Covers initialState product defaults.
 */
import { describe, expect, it } from 'vitest'

import { initialState } from '../settings'

describe('settings tray defaults', () => {
  it('defaults tray and trayOnClose to false', () => {
    expect(initialState.tray).toBe(false)
    expect(initialState.trayOnClose).toBe(false)
  })
})
