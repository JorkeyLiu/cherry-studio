/**
 * Regression for tray defaults (renderer): fresh installs must not enable
 * tray or trayOnClose by default. Covers initialState and reducer passthrough
 * to ensure persisted user preferences are not coerced.
 */
import { describe, expect, it } from 'vitest'

import settingsReducer, { initialState, setTray, setTrayOnClose } from '../settings'

describe('settings tray defaults', () => {
  it('defaults tray to false', () => {
    expect(initialState.tray).toBe(false)
  })

  it('defaults trayOnClose to false', () => {
    expect(initialState.trayOnClose).toBe(false)
  })

  it('preserves explicit tray true preference', () => {
    const next = settingsReducer(initialState, setTray(true))
    expect(next.tray).toBe(true)
  })

  it('preserves explicit tray false preference', () => {
    const withTray = settingsReducer(initialState, setTray(true))
    const next = settingsReducer(withTray, setTray(false))
    expect(next.tray).toBe(false)
  })

  it('preserves explicit trayOnClose true preference', () => {
    const next = settingsReducer(initialState, setTrayOnClose(true))
    expect(next.trayOnClose).toBe(true)
  })

  it('preserves explicit trayOnClose false preference', () => {
    const withClose = settingsReducer(initialState, setTrayOnClose(true))
    const next = settingsReducer(withClose, setTrayOnClose(false))
    expect(next.trayOnClose).toBe(false)
  })
})
