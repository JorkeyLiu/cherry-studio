import { describe, expect, it } from 'vitest'

import { resolveAppBundleId } from '../notarize'

/**
 * Focused test for the notarize bundle-ID selection (Phase B / P-B,
 * IDENTITY-002). `resolveAppBundleId` is a pure helper exported from
 * scripts/notarize.js so the active-bundle-ID selection can be tested without
 * invoking Apple notarization.
 */

interface FakeNotarizeContext {
  packager?: { appInfo?: { id?: string } }
}

describe('resolveAppBundleId (scripts/notarize.js)', () => {
  it('reads the bundle id from the active packager appInfo', () => {
    const context: FakeNotarizeContext = { packager: { appInfo: { id: 'com.jorkeyliu.CherryChat' } } }
    expect(resolveAppBundleId(context)).toBe('com.jorkeyliu.CherryChat')
  })

  it('preserves the default Cherry Studio bundle id when appInfo is resolved under the base config', () => {
    // appInfo.id is resolved by electron-builder from the effective config, so
    // the base build naturally yields the locked Cherry Studio value.
    const context: FakeNotarizeContext = { packager: { appInfo: { id: 'com.kangfenmao.CherryStudio' } } }
    expect(resolveAppBundleId(context)).toBe('com.kangfenmao.CherryStudio')
  })

  it('does not invent a bundle id when appInfo is unavailable', () => {
    expect(resolveAppBundleId({})).toBeUndefined()
    expect(resolveAppBundleId(null)).toBeUndefined()
    expect(resolveAppBundleId(undefined)).toBeUndefined()
  })
})
