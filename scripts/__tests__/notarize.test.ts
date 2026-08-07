import { describe, expect, it } from 'vitest'

import { resolveAppBundleId } from '../notarize'

/**
 * Focused test for the notarize bundle-ID resolution. `resolveAppBundleId` is
 * a pure helper exported from scripts/notarize.js so the active-bundle-ID
 * resolution can be tested without invoking Apple notarization.
 *
 * The bundle id is resolved dynamically from the electron-builder
 * packager/appInfo (`context.packager.appInfo.id`), so the single Cherry Chat
 * base config yields `com.jorkeyliu.CherryChat` (LOCK-RETIRE-001).
 */

interface FakeNotarizeContext {
  packager?: { appInfo?: { id?: string } }
}

describe('resolveAppBundleId (scripts/notarize.js)', () => {
  it('reads the bundle id from the active packager appInfo', () => {
    const context: FakeNotarizeContext = { packager: { appInfo: { id: 'com.jorkeyliu.CherryChat' } } }
    expect(resolveAppBundleId(context)).toBe('com.jorkeyliu.CherryChat')
  })

  it('does not invent a bundle id when appInfo is unavailable', () => {
    expect(resolveAppBundleId({})).toBeUndefined()
    expect(resolveAppBundleId(null)).toBeUndefined()
    expect(resolveAppBundleId(undefined)).toBeUndefined()
  })
})
