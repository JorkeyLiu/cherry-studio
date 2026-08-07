import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveAppIdentity } from '../identity'
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
const DEFAULT_ELECTRON_USERDATA = path.join(APPDATA_ROOT, 'Cherry Studio')

function makeInput(overrides: Partial<ResolveUserDataInput> = {}): ResolveUserDataInput {
  return {
    identity: resolveAppIdentity('cherry-studio'),
    appDataRoot: APPDATA_ROOT,
    electronDefaultUserData: DEFAULT_ELECTRON_USERDATA,
    configuredAppDataPath: null,
    portableDataDir: null,
    explicitUserDataDir: null,
    isPackaged: true,
    isPortable: false,
    ...overrides
  }
}

describe('resolveUserDataBase', () => {
  it('keeps Electron default userData for the default flavor when nothing is configured', () => {
    const result = resolveUserDataBase(makeInput())
    expect(result).toEqual<UserDataResolution>({ path: DEFAULT_ELECTRON_USERDATA, source: 'electron-default' })
  })

  it('keeps Electron default for the default flavor in dev mode', () => {
    const result = resolveUserDataBase(makeInput({ isPackaged: false }))
    expect(result.source).toBe('electron-default')
    expect(result.path).toBe(DEFAULT_ELECTRON_USERDATA)
  })

  it('resolves Cherry Chat packaged to its own identity-default profile', () => {
    const result = resolveUserDataBase(makeInput({ identity: resolveAppIdentity('cherry-chat') }))
    expect(result).toEqual<UserDataResolution>({
      path: path.join(APPDATA_ROOT, 'Cherry Chat'),
      source: 'identity-default'
    })
  })

  it('resolves Cherry Chat dev to its own identity-default profile (independent dev base)', () => {
    const base = resolveUserDataBase(makeInput({ identity: resolveAppIdentity('cherry-chat'), isPackaged: false }))
    expect(base.path).toBe(path.join(APPDATA_ROOT, 'Cherry Chat'))
    // The historical dev suffix is applied on top of the base by src/main/config.ts.
    expect(applyDevSuffix(base.path, true)).toBe(path.join(APPDATA_ROOT, 'Cherry Chat') + 'Dev')
  })

  it('applies the flavor-specific configured appDataPath before the identity default (Cherry Chat)', () => {
    const configured = '/custom/cherry-chat-data'
    const result = resolveUserDataBase(
      makeInput({ identity: resolveAppIdentity('cherry-chat'), configuredAppDataPath: configured })
    )
    expect(result).toEqual<UserDataResolution>({ path: configured, source: 'configured-path' })
  })

  it('applies portable data dir before the identity default (Cherry Chat portable)', () => {
    const portableDir = '/portable/data'
    const result = resolveUserDataBase(
      makeInput({
        identity: resolveAppIdentity('cherry-chat'),
        configuredAppDataPath: null,
        isPortable: true,
        portableDataDir: portableDir
      })
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
    expect(result).toEqual<UserDataResolution>({ path: DEFAULT_ELECTRON_USERDATA, source: 'electron-default' })
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

  it('preserves the CLI override for the default flavor packaged', () => {
    const result = resolveUserDataBase(makeInput({ explicitUserDataDir: CLI }))
    expect(result).toEqual<UserDataResolution>({ path: CLI, source: 'cli-override' })
  })

  it('preserves the CLI override for the default flavor in dev mode', () => {
    const result = resolveUserDataBase(makeInput({ isPackaged: false, explicitUserDataDir: CLI }))
    expect(result).toEqual<UserDataResolution>({ path: CLI, source: 'cli-override' })
  })

  it('preserves the CLI override for Cherry Chat packaged instead of the identity default', () => {
    const result = resolveUserDataBase(
      makeInput({ identity: resolveAppIdentity('cherry-chat'), explicitUserDataDir: CLI })
    )
    expect(result).toEqual<UserDataResolution>({ path: CLI, source: 'cli-override' })
    // The identity-default `Cherry Chat` profile is NOT used.
    expect(result.path).not.toBe(path.join(APPDATA_ROOT, 'Cherry Chat'))
  })

  it('preserves the CLI override for Cherry Chat dev (no Dev suffix on the override)', () => {
    const base = resolveUserDataBase(
      makeInput({ identity: resolveAppIdentity('cherry-chat'), isPackaged: false, explicitUserDataDir: CLI })
    )
    expect(base).toEqual<UserDataResolution>({ path: CLI, source: 'cli-override' })
    // The historical Dev suffix is applied by src/main/config.ts ONLY to the
    // identity base; an explicit CLI override skips the suffix gate entirely
    // (covered by the config.ts dev-suffix gate test).
    expect(base.path).toBe(CLI)
  })

  it('beats the flavor-specific configured appDataPath (CLI > configured)', () => {
    const result = resolveUserDataBase(
      makeInput({
        identity: resolveAppIdentity('cherry-chat'),
        configuredAppDataPath: '/custom/chat-data',
        explicitUserDataDir: CLI
      })
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
    // Resolution itself preserves the override; the IDENTITY-006 guard in
    // src/main/utils/init.ts runs AFTER resolution and fails closed.
    const cherryStudioDefault = path.join(APPDATA_ROOT, 'Cherry Studio')
    const result = resolveUserDataBase(
      makeInput({ identity: resolveAppIdentity('cherry-chat'), explicitUserDataDir: cherryStudioDefault })
    )
    expect(result).toEqual<UserDataResolution>({ path: cherryStudioDefault, source: 'cli-override' })
    expect(isCherryStudioDefaultUserData(resolveAppIdentity('cherry-chat'), APPDATA_ROOT, result.path)).toBe(true)
  })

  it('keeps a CLI override pointing at the actual Electron-derived CherryStudio profile resolvable for the guard to reject', () => {
    // The real Cherry Studio profile on this machine is `<appDataRoot>/CherryStudio`
    // (Electron derives it from the packaged package.json `name`); the guard
    // must fail closed on this form too (IDENTITY-006).
    const actualCherryStudioDefault = path.join(APPDATA_ROOT, 'CherryStudio')
    const result = resolveUserDataBase(
      makeInput({ identity: resolveAppIdentity('cherry-chat'), explicitUserDataDir: actualCherryStudioDefault })
    )
    expect(result).toEqual<UserDataResolution>({ path: actualCherryStudioDefault, source: 'cli-override' })
    expect(isCherryStudioDefaultUserData(resolveAppIdentity('cherry-chat'), APPDATA_ROOT, result.path)).toBe(true)
  })
})

describe('applyDevSuffix', () => {
  it('appends the historical Dev suffix only in dev mode', () => {
    expect(applyDevSuffix('/data/Cherry Chat', true)).toBe('/data/Cherry ChatDev')
    expect(applyDevSuffix('/data/Cherry Studio', true)).toBe('/data/Cherry StudioDev')
    expect(applyDevSuffix('/data/Cherry Chat', false)).toBe('/data/Cherry Chat')
  })
})

describe('isCherryStudioDefaultUserData', () => {
  const cherryStudioDefault = path.join(APPDATA_ROOT, 'Cherry Studio')
  // The ACTUAL Electron-derived default profile (package.json `name` is
  // `CherryStudio` — verified empirically on the packaged binary).
  const actualCherryStudioDefault = path.join(APPDATA_ROOT, 'CherryStudio')

  it('locks BOTH canonical protected profile names in the centralized compatibility list', () => {
    expect(CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES).toEqual(['Cherry Studio', 'CherryStudio'])
    expect(CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES).toContain(resolveAppIdentity('cherry-studio').userDataDirName)
  })

  it('flags the ADR-form Cherry Studio default profile for the cherry-chat flavor', () => {
    expect(isCherryStudioDefaultUserData(resolveAppIdentity('cherry-chat'), APPDATA_ROOT, cherryStudioDefault)).toBe(
      true
    )
  })

  it('flags the actual Electron-derived CherryStudio profile for the cherry-chat flavor (IDENTITY-006)', () => {
    expect(
      isCherryStudioDefaultUserData(resolveAppIdentity('cherry-chat'), APPDATA_ROOT, actualCherryStudioDefault)
    ).toBe(true)
  })

  it('does not flag Cherry Chat profiles or custom paths', () => {
    expect(
      isCherryStudioDefaultUserData(
        resolveAppIdentity('cherry-chat'),
        APPDATA_ROOT,
        path.join(APPDATA_ROOT, 'Cherry Chat')
      )
    ).toBe(false)
    expect(isCherryStudioDefaultUserData(resolveAppIdentity('cherry-chat'), APPDATA_ROOT, '/custom/data')).toBe(false)
  })

  it('never flags anything for the default flavor (IDENTITY-001)', () => {
    expect(isCherryStudioDefaultUserData(resolveAppIdentity('cherry-studio'), APPDATA_ROOT, cherryStudioDefault)).toBe(
      false
    )
    expect(
      isCherryStudioDefaultUserData(resolveAppIdentity('cherry-studio'), APPDATA_ROOT, actualCherryStudioDefault)
    ).toBe(false)
    expect(isCherryStudioDefaultUserData(resolveAppIdentity('cherry-studio'), APPDATA_ROOT, '/custom/data')).toBe(false)
  })

  it('treats path aliases canonically for BOTH protected forms (resolves the comparison)', () => {
    // /mock/Application Support vs /mock/Application%20Support should not match;
    // aliased path forms that resolve identically should match on POSIX systems.
    const aliasForm = path.join(APPDATA_ROOT, '.', 'Cherry Studio')
    expect(isCherryStudioDefaultUserData(resolveAppIdentity('cherry-chat'), APPDATA_ROOT, aliasForm)).toBe(true)
    const aliasNoSpaceForm = path.join(APPDATA_ROOT, '.', 'CherryStudio')
    expect(isCherryStudioDefaultUserData(resolveAppIdentity('cherry-chat'), APPDATA_ROOT, aliasNoSpaceForm)).toBe(true)
  })
})
