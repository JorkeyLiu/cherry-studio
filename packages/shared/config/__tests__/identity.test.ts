import { describe, expect, it } from 'vitest'

import { APP_NAME, HOME_CHERRY_DIR } from '../constant'
import * as identityModule from '../identity'
import { type AppIdentity, appIdentity } from '../identity'

/**
 * Locked identity values from LOCK-RETIRE-001: Cherry Chat is the only target
 * application identity. LOCK-RETIRE-002: IDENTITY-001 is a retired erroneous
 * legacy decision — no `cherry-studio` target flavor exists anymore and the
 * default/unset build identity is always Cherry Chat.
 */
const LOCKED_IDENTITY: AppIdentity = {
  productName: 'Cherry Chat',
  appId: 'com.jorkeyliu.CherryChat',
  protocolScheme: 'cherrychat',
  protocolUrlScheme: 'cherrychat://',
  protocolDisplayName: 'Cherry Chat',
  homeDirName: '.cherrychat',
  userDataDirName: 'Cherry Chat',
  genericTempDirName: 'CherryChat',
  tempDirName: 'cherry-chat',
  updaterEnabled: false,
  analyticsChannel: 'cherry-chat',
  userAgentProduct: 'CherryChat',
  apiTitle: 'Cherry Chat API',
  linuxClassAndName: 'CherryChat',
  crashReporterProductName: 'CherryChat'
}

describe('single immutable application identity (LOCK-RETIRE-001/002)', () => {
  it('locks every identity field to the Cherry Chat values', () => {
    expect(appIdentity).toEqual(LOCKED_IDENTITY)
  })

  it('carries the locked product name and bundle/app id', () => {
    expect(appIdentity.productName).toBe('Cherry Chat')
    expect(appIdentity.appId).toBe('com.jorkeyliu.CherryChat')
  })

  it('carries the locked protocol scheme', () => {
    expect(appIdentity.protocolScheme).toBe('cherrychat')
    expect(appIdentity.protocolUrlScheme).toBe('cherrychat://')
  })

  it('derives independent home/temp/profile identity', () => {
    expect(appIdentity.homeDirName).toBe('.cherrychat')
    expect(appIdentity.tempDirName).toBe('cherry-chat')
    expect(appIdentity.userDataDirName).toBe('Cherry Chat')
    expect(appIdentity.genericTempDirName).toBe('CherryChat')
  })

  it('keeps the updater disabled (LOCK-UPDATER-004)', () => {
    expect(appIdentity.updaterEnabled).toBe(false)
  })
})

describe('identity-derived shared constants', () => {
  it('keeps HOME_CHERRY_DIR equal to the Cherry Chat home directory', () => {
    expect(HOME_CHERRY_DIR).toBe('.cherrychat')
    expect(HOME_CHERRY_DIR).toBe(appIdentity.homeDirName)
  })

  it('keeps APP_NAME equal to the Cherry Chat product name', () => {
    expect(APP_NAME).toBe('Cherry Chat')
    expect(APP_NAME).toBe(appIdentity.productName)
  })
})

describe('no cherry-studio target identity remains', () => {
  it('exposes no flavor selector / fallback API surface', () => {
    // The retired flavor machinery must not be importable (LOCK-RETIRE-002).
    expect(Object.keys(identityModule)).toContain('appIdentity')
    expect(Object.keys(identityModule)).not.toContain('resolveAppIdentity')
    expect(Object.keys(identityModule)).not.toContain('appFlavor')
    expect(Object.keys(identityModule)).not.toContain('APP_FLAVOR_ENV_VAR')
    expect(Object.keys(identityModule)).not.toContain('AppFlavor')
  })

  it('has no Cherry Studio identity values anywhere in the module', () => {
    expect(JSON.stringify(appIdentity)).not.toContain('Cherry Studio')
    expect(JSON.stringify(appIdentity)).not.toContain('cherrystudio')
    expect(JSON.stringify(appIdentity)).not.toContain('com.kangfenmao')
  })
})
