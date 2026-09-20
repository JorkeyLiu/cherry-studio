/**
 * Regression for tray defaults (main): ConfigManager must fall back to false
 * when the store has no persisted tray/trayOnClose key, and must preserve
 * explicit user preferences. Mirrors renderer initialState defaults.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigKeys, ConfigManager } from '../ConfigManager'

describe('ConfigManager tray absent-key defaults', () => {
  let manager: ConfigManager
  let storeMap: Map<string, unknown>

  beforeEach(() => {
    storeMap = new Map<string, unknown>()
    manager = new ConfigManager()
    const store = (manager as unknown as { store: { get: unknown; set: unknown; has: unknown } }).store
    store.get = vi.fn((key: string, defaultValue?: unknown) => (storeMap.has(key) ? storeMap.get(key) : defaultValue))
    store.set = vi.fn((key: string, value: unknown) => {
      storeMap.set(key, value)
    })
    store.has = vi.fn((key: string) => storeMap.has(key))
  })

  it('defaults tray to false when absent', () => {
    expect(manager.getTray()).toBe(false)
    const store = (manager as unknown as { store: { get: ReturnType<typeof vi.fn> } }).store
    expect(store.get).toHaveBeenCalledWith(ConfigKeys.Tray, false)
  })

  it('defaults trayOnClose to false when absent', () => {
    expect(manager.getTrayOnClose()).toBe(false)
    const store = (manager as unknown as { store: { get: ReturnType<typeof vi.fn> } }).store
    expect(store.get).toHaveBeenCalledWith(ConfigKeys.TrayOnClose, false)
  })

  it('preserves explicit tray true preference', () => {
    manager.setTray(true)
    expect(manager.getTray()).toBe(true)
  })

  it('preserves explicit tray false preference after true', () => {
    manager.setTray(true)
    manager.setTray(false)
    expect(manager.getTray()).toBe(false)
  })

  it('preserves explicit trayOnClose true preference', () => {
    manager.setTrayOnClose(true)
    expect(manager.getTrayOnClose()).toBe(true)
  })

  it('preserves explicit trayOnClose false preference after true', () => {
    manager.setTrayOnClose(true)
    manager.setTrayOnClose(false)
    expect(manager.getTrayOnClose()).toBe(false)
  })

  it('does not coerce absent tray to true via boolean coercion', () => {
    // Ensure !!undefined with false default still yields false (not true)
    expect(manager.getTray()).toBe(false)
    expect(manager.getTrayOnClose()).toBe(false)
  })
})
