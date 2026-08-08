import { afterEach, describe, expect, it } from 'vitest'

/**
 * Focused tests for scripts/apply-build-version.js — the beforePack hook that
 * applies the wrapper-provided numeric macOS build version
 * (CHERRY_CHAT_BUILD_VERSION) to electron-builder's AppInfo so it lands in
 * CFBundleVersion (VERSION-003). electron-builder does not macro-expand the
 * `buildVersion` config value, so the env bridge is applied here instead.
 * The hook is gated to macOS (LOCK-PLATFORM-005): when the platform is known
 * and is not macOS, AppInfo is left untouched.
 */

const ENV_NAME = 'CHERRY_CHAT_BUILD_VERSION'
const MAC_EPOCH_BUILD_VERSION = '20260807081637000'

interface HookContext {
  packager: { platform?: { name: string }; appInfo: { buildVersion: string } }
}

async function loadHook(): Promise<(context: HookContext) => void> {
  const mod = (await import('../apply-build-version.js')) as unknown as { default: (context: HookContext) => void }
  return mod.default
}

function makeContext(platformName = 'mac'): HookContext {
  return { packager: { platform: { name: platformName }, appInfo: { buildVersion: '0.1.0' } } }
}

describe('apply-build-version hook (VERSION-003)', () => {
  afterEach(() => {
    delete process.env[ENV_NAME]
  })

  it('applies the numeric build version when the wrapper env is present (macOS)', async () => {
    process.env[ENV_NAME] = MAC_EPOCH_BUILD_VERSION
    const applyBuildVersion = await loadHook()
    const context = makeContext('mac')
    applyBuildVersion(context)
    expect(context.packager.appInfo.buildVersion).toBe(MAC_EPOCH_BUILD_VERSION)
  })

  it('leaves AppInfo untouched when the env is absent (degraded default = product version)', async () => {
    delete process.env[ENV_NAME]
    const applyBuildVersion = await loadHook()
    const context = makeContext('mac')
    applyBuildVersion(context)
    expect(context.packager.appInfo.buildVersion).toBe('0.1.0')
  })

  it('is a no-op when the context lacks an appInfo', async () => {
    process.env[ENV_NAME] = MAC_EPOCH_BUILD_VERSION
    const applyBuildVersion = await loadHook()
    expect(() => applyBuildVersion({} as HookContext)).not.toThrow()
  })

  it('skips non-macOS platforms even when the wrapper env is present (LOCK-PLATFORM-005)', async () => {
    process.env[ENV_NAME] = MAC_EPOCH_BUILD_VERSION
    const applyBuildVersion = await loadHook()
    for (const platformName of ['windows', 'linux']) {
      const context = makeContext(platformName)
      applyBuildVersion(context)
      expect(context.packager.appInfo.buildVersion, `${platformName} keeps the product version`).toBe('0.1.0')
    }
  })

  it('preserves the macOS path when the context carries no platform info', async () => {
    process.env[ENV_NAME] = MAC_EPOCH_BUILD_VERSION
    const applyBuildVersion = await loadHook()
    const context = makeContext()
    delete context.packager.platform
    applyBuildVersion(context)
    expect(context.packager.appInfo.buildVersion).toBe(MAC_EPOCH_BUILD_VERSION)
  })
})
