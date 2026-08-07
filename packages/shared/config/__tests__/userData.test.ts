import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { appIdentity } from '../identity'
import {
  applyDevSuffix,
  CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES,
  findExplicitUserDataDir,
  isCherryStudioDefaultUserData,
  resolveUserDataBase,
  type ResolveUserDataInput,
  type UserDataResolution
} from '../userData'

const APPDATA_ROOT = '/mock/Application Support'
const IDENTITY_DEFAULT = path.join(APPDATA_ROOT, appIdentity.userDataDirName)

function makeInput(overrides: Partial<ResolveUserDataInput> = {}): ResolveUserDataInput {
  return {
    identity: appIdentity,
    appDataRoot: APPDATA_ROOT,
    configuredAppDataPath: null,
    portableDataDir: null,
    explicitUserDataDir: null,
    isPackaged: true,
    isPortable: false,
    ...overrides
  }
}

describe('resolveUserDataBase — single Cherry Chat identity (LOCK-RETIRE-001)', () => {
  it('resolves the identity-default Cherry Chat profile when nothing is configured', () => {
    const result = resolveUserDataBase(makeInput())
    expect(result).toEqual<UserDataResolution>({ path: IDENTITY_DEFAULT, source: 'identity-default' })
  })

  it('resolves the identity-default profile in dev mode too (independent dev base)', () => {
    const base = resolveUserDataBase(makeInput({ isPackaged: false }))
    expect(base.path).toBe(IDENTITY_DEFAULT)
    // The historical dev suffix is applied on top of the base by src/main/config.ts.
    expect(applyDevSuffix(base.path, true)).toBe(IDENTITY_DEFAULT + 'Dev')
  })

  it('applies the configured appDataPath before the identity default', () => {
    const configured = '/custom/chat-data'
    const result = resolveUserDataBase(makeInput({ configuredAppDataPath: configured }))
    expect(result).toEqual<UserDataResolution>({ path: configured, source: 'configured-path' })
  })

  it('applies portable data dir before the identity default', () => {
    const portableDir = '/portable/data'
    const result = resolveUserDataBase(
      makeInput({ configuredAppDataPath: null, isPortable: true, portableDataDir: portableDir })
    )
    expect(result).toEqual<UserDataResolution>({ path: portableDir, source: 'portable' })
  })

  it('keeps configured appDataPath winning over portable (existing precedence)', () => {
    const result = resolveUserDataBase(
      makeInput({ configuredAppDataPath: '/custom/data', isPortable: true, portableDataDir: '/portable/data' })
    )
    expect(result.source).toBe('configured-path')
  })

  it('ignores portable/config precedence in dev mode (matches existing bootstrap gate)', () => {
    const result = resolveUserDataBase(
      makeInput({
        isPackaged: false,
        configuredAppDataPath: '/custom/data',
        isPortable: true,
        portableDataDir: '/portable/data'
      })
    )
    expect(result).toEqual<UserDataResolution>({ path: IDENTITY_DEFAULT, source: 'identity-default' })
  })
})

describe('findExplicitUserDataDir', () => {
  const CLI = '/disposable/cherry-chat-profile'

  it('returns the exact `--user-data-dir=<path>` value from the argv', () => {
    expect(findExplicitUserDataDir(['--user-data-dir=' + CLI, '--no-sandbox'])).toBe(CLI)
    expect(findExplicitUserDataDir(['electron', '.' + CLI, '--user-data-dir=' + CLI])).toBe(CLI)
  })

  it('returns null when no explicit override token is present', () => {
    expect(findExplicitUserDataDir([])).toBeNull()
    expect(findExplicitUserDataDir(['.', '--no-sandbox', '--disable-gpu'])).toBeNull()
    // Substring or non-exact token forms are NOT recognized.
    expect(findExplicitUserDataDir(['--user-data-dir-something=' + CLI])).toBeNull()
    expect(findExplicitUserDataDir(['--user-data-dir ' + CLI])).toBeNull()
  })

  it('ignores an empty `--user-data-dir=` value and keeps looking', () => {
    expect(findExplicitUserDataDir(['--user-data-dir=', '--user-data-dir=' + CLI])).toBe(CLI)
    expect(findExplicitUserDataDir(['--user-data-dir='])).toBeNull()
  })

  it('returns the first matching token when several are present', () => {
    expect(findExplicitUserDataDir(['--user-data-dir=/first/profile', '--user-data-dir=' + CLI])).toBe('/first/profile')
  })
})

describe('resolveUserDataBase — explicit --user-data-dir CLI override (highest precedence)', () => {
  const CLI = '/disposable/cli-profile'

  it('preserves the CLI override packaged', () => {
    const result = resolveUserDataBase(makeInput({ explicitUserDataDir: CLI }))
    expect(result).toEqual<UserDataResolution>({ path: CLI, source: 'cli-override' })
    // The identity-default `Cherry Chat` profile is NOT used.
    expect(result.path).not.toBe(IDENTITY_DEFAULT)
  })

  it('preserves the CLI override in dev mode (no Dev suffix on the override)', () => {
    const base = resolveUserDataBase(makeInput({ isPackaged: false, explicitUserDataDir: CLI }))
    expect(base).toEqual<UserDataResolution>({ path: CLI, source: 'cli-override' })
    // The historical Dev suffix is applied by src/main/config.ts ONLY to the
    // identity base; an explicit CLI override skips the suffix gate entirely.
    expect(base.path).toBe(CLI)
  })

  it('beats the configured appDataPath (CLI > configured)', () => {
    const result = resolveUserDataBase(
      makeInput({ configuredAppDataPath: '/custom/chat-data', explicitUserDataDir: CLI })
    )
    expect(result).toEqual<UserDataResolution>({ path: CLI, source: 'cli-override' })
  })

  it('beats the portable data dir (CLI > portable)', () => {
    const result = resolveUserDataBase(
      makeInput({ isPortable: true, portableDataDir: '/portable/data', explicitUserDataDir: CLI })
    )
    expect(result).toEqual<UserDataResolution>({ path: CLI, source: 'cli-override' })
  })

  it('keeps a CLI override pointing at the Cherry Studio default resolvable for the guard to reject', () => {
    // Resolution itself preserves the override; the LOCK-PROFILE-006 guard in
    // src/main/utils/init.ts runs AFTER resolution and fails closed.
    const cherryStudioDefault = path.join(APPDATA_ROOT, 'Cherry Studio')
    const result = resolveUserDataBase(makeInput({ explicitUserDataDir: cherryStudioDefault }))
    expect(result).toEqual<UserDataResolution>({ path: cherryStudioDefault, source: 'cli-override' })
    expect(isCherryStudioDefaultUserData(APPDATA_ROOT, result.path)).toBe(true)
  })

  it('keeps a CLI override pointing at the actual Electron-derived CherryStudio profile resolvable for the guard to reject', () => {
    // The real Cherry Studio profile is `<appDataRoot>/CherryStudio`; the guard
    // must fail closed on this form too (LOCK-PROFILE-006).
    const actualCherryStudioDefault = path.join(APPDATA_ROOT, 'CherryStudio')
    const result = resolveUserDataBase(makeInput({ explicitUserDataDir: actualCherryStudioDefault }))
    expect(result).toEqual<UserDataResolution>({ path: actualCherryStudioDefault, source: 'cli-override' })
    expect(isCherryStudioDefaultUserData(APPDATA_ROOT, result.path)).toBe(true)
  })
})

describe('applyDevSuffix', () => {
  it('appends the historical Dev suffix only in dev mode', () => {
    expect(applyDevSuffix('/data/Cherry Chat', true)).toBe('/data/Cherry ChatDev')
    expect(applyDevSuffix('/data/Cherry Chat', false)).toBe('/data/Cherry Chat')
  })
})

describe('isCherryStudioDefaultUserData (LOCK-PROFILE-006)', () => {
  const cherryStudioDefault = path.join(APPDATA_ROOT, 'Cherry Studio')
  // The ACTUAL Electron-derived default profile (package.json `name` is
  // `CherryStudio` — verified empirically on the packaged binary).
  const actualCherryStudioDefault = path.join(APPDATA_ROOT, 'CherryStudio')

  it('locks BOTH canonical protected profile names in the centralized compatibility list', () => {
    expect(CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES).toEqual(['Cherry Studio', 'CherryStudio'])
  })

  it('flags the ADR-form Cherry Studio default profile', () => {
    expect(isCherryStudioDefaultUserData(APPDATA_ROOT, cherryStudioDefault)).toBe(true)
  })

  it('flags the actual Electron-derived CherryStudio profile (LOCK-PROFILE-006)', () => {
    expect(isCherryStudioDefaultUserData(APPDATA_ROOT, actualCherryStudioDefault)).toBe(true)
  })

  it('does not flag the Cherry Chat profile or custom paths', () => {
    expect(isCherryStudioDefaultUserData(APPDATA_ROOT, IDENTITY_DEFAULT)).toBe(false)
    expect(isCherryStudioDefaultUserData(APPDATA_ROOT, '/custom/data')).toBe(false)
  })

  it('treats path aliases canonically for BOTH protected forms (resolves the comparison)', () => {
    const aliasForm = path.join(APPDATA_ROOT, '.', 'Cherry Studio')
    expect(isCherryStudioDefaultUserData(APPDATA_ROOT, aliasForm)).toBe(true)
    const aliasNoSpaceForm = path.join(APPDATA_ROOT, '.', 'CherryStudio')
    expect(isCherryStudioDefaultUserData(APPDATA_ROOT, aliasNoSpaceForm)).toBe(true)
  })
})
