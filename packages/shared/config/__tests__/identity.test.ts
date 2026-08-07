import { describe, expect, it } from 'vitest'

import { APP_NAME, CHERRYIN_CONFIG, HOME_CHERRY_DIR } from '../constant'
import { APP_FLAVOR_ENV_VAR, appFlavor, type AppIdentity, appIdentity, resolveAppIdentity } from '../identity'

/**
 * Locked identity values from docs/cherry-chat-application-identity.md.
 * IDENTITY-001: the default Cherry Studio build/identity must remain unchanged.
 * IDENTITY-002: Cherry Chat resolves to product `Cherry Chat`, bundle/app ID
 * `com.jorkeyliu.CherryChat`, protocol `cherrychat://`, independent profile.
 */
const LOCKED_DEFAULT_IDENTITY: AppIdentity = {
  flavor: 'cherry-studio',
  productName: 'Cherry Studio',
  appId: 'com.kangfenmao.CherryStudio',
  protocolScheme: 'cherrystudio',
  protocolUrlScheme: 'cherrystudio://',
  protocolDisplayName: 'Cherry Studio',
  homeDirName: '.cherrystudio',
  userDataDirName: 'Cherry Studio',
  genericTempDirName: 'CherryStudio',
  tempDirName: 'cherry-studio',
  updaterEnabled: true,
  analyticsChannel: 'cherry-studio',
  userAgentProduct: 'CherryStudio',
  apiTitle: 'Cherry Studio API',
  linuxClassAndName: 'CherryStudio',
  crashReporterProductName: 'CherryStudio'
}

const LOCKED_CHERRY_CHAT_IDENTITY: AppIdentity = {
  flavor: 'cherry-chat',
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

describe('resolveAppIdentity', () => {
  it('resolves the default Cherry Studio flavor to the locked default identity', () => {
    expect(resolveAppIdentity(undefined)).toEqual(LOCKED_DEFAULT_IDENTITY)
  })

  it('resolves explicit cherry-studio to the locked default identity', () => {
    expect(resolveAppIdentity('cherry-studio')).toEqual(LOCKED_DEFAULT_IDENTITY)
  })

  it('resolves the cherry-chat flavor to the locked Cherry Chat identity', () => {
    expect(resolveAppIdentity('cherry-chat')).toEqual(LOCKED_CHERRY_CHAT_IDENTITY)
  })

  it('treats unknown/malformed flavor tokens as the default identity (IDENTITY-001)', () => {
    expect(resolveAppIdentity(null)).toEqual(LOCKED_DEFAULT_IDENTITY)
    expect(resolveAppIdentity('')).toEqual(LOCKED_DEFAULT_IDENTITY)
    expect(resolveAppIdentity('   ')).toEqual(LOCKED_DEFAULT_IDENTITY)
    expect(resolveAppIdentity('unknown-flavor')).toEqual(LOCKED_DEFAULT_IDENTITY)
  })

  it('is case- and whitespace-insensitive for the explicit flavor token', () => {
    expect(resolveAppIdentity('Cherry-Chat')).toEqual(LOCKED_CHERRY_CHAT_IDENTITY)
    expect(resolveAppIdentity('  cherry-chat  ')).toEqual(LOCKED_CHERRY_CHAT_IDENTITY)
  })
})

describe('build-time module identity', () => {
  it('defaults to the Cherry Studio flavor when VITE_APP_FLAVOR is unset (test environment)', () => {
    expect(appFlavor).toBe('cherry-studio')
    expect(appIdentity).toEqual(LOCKED_DEFAULT_IDENTITY)
  })

  it('documents the flavor environment variable name', () => {
    expect(APP_FLAVOR_ENV_VAR).toBe('VITE_APP_FLAVOR')
  })
})

describe('identity-derived shared constants (default flavor)', () => {
  it('keeps HOME_CHERRY_DIR equal to the current Cherry Studio home directory', () => {
    expect(HOME_CHERRY_DIR).toBe('.cherrystudio')
    expect(HOME_CHERRY_DIR).toBe(appIdentity.homeDirName)
  })

  it('keeps APP_NAME equal to the current Cherry Studio product name', () => {
    expect(APP_NAME).toBe('Cherry Studio')
    expect(APP_NAME).toBe(appIdentity.productName)
  })

  it('keeps the CherryIN OAuth redirect URI on the default protocol scheme', () => {
    expect(CHERRYIN_CONFIG.REDIRECT_URI).toBe('cherrystudio://oauth/callback')
    expect(CHERRYIN_CONFIG.REDIRECT_URI.startsWith(appIdentity.protocolUrlScheme)).toBe(true)
  })

  it('keeps the historical generic temp dir name for the default flavor', () => {
    expect(appIdentity.genericTempDirName).toBe('CherryStudio')
    expect(resolveAppIdentity('cherry-chat').genericTempDirName).toBe('CherryChat')
  })
})

describe('flavor isolation invariants', () => {
  it('derives distinct home/temp/profile identity for Cherry Chat (IDENTITY-002/006)', () => {
    const defaultIdentity = resolveAppIdentity('cherry-studio')
    const chatIdentity = resolveAppIdentity('cherry-chat')

    expect(chatIdentity.homeDirName).not.toBe(defaultIdentity.homeDirName)
    expect(chatIdentity.tempDirName).not.toBe(defaultIdentity.tempDirName)
    expect(chatIdentity.userDataDirName).not.toBe(defaultIdentity.userDataDirName)
    expect(chatIdentity.genericTempDirName).not.toBe(defaultIdentity.genericTempDirName)
    expect(chatIdentity.appId).not.toBe(defaultIdentity.appId)
    expect(chatIdentity.protocolScheme).not.toBe(defaultIdentity.protocolScheme)
    expect(chatIdentity.protocolUrlScheme).not.toBe(defaultIdentity.protocolUrlScheme)
  })

  it('matches the default userData dir to the Electron packaged profile name', () => {
    expect(resolveAppIdentity('cherry-studio').userDataDirName).toBe('Cherry Studio')
    expect(resolveAppIdentity('cherry-chat').userDataDirName).toBe('Cherry Chat')
  })

  it('derives a flavor-specific internal API title', () => {
    expect(resolveAppIdentity('cherry-studio').apiTitle).toBe('Cherry Studio API')
    expect(resolveAppIdentity('cherry-chat').apiTitle).toBe('Cherry Chat API')
  })

  it('disables the updater for Cherry Chat (IDENTITY-004) while the default build keeps it enabled', () => {
    expect(resolveAppIdentity('cherry-studio').updaterEnabled).toBe(true)
    expect(resolveAppIdentity('cherry-chat').updaterEnabled).toBe(false)
  })
})
