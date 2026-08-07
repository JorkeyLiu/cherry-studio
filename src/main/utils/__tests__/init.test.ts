import os from 'node:os'
import path from 'node:path'

import { resolveAppIdentity as realResolveAppIdentity } from '@shared/config/identity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Regression coverage for the startup userData seam `initAppDataDir()`.
//
// The production function is imported fresh for every test (vi.resetModules +
// dynamic import) so the per-test identity/flavor, Electron app API, platform
// constants and filesystem are fully isolated — no real home/config/userData
// path is ever read or written, and environment/module state is restored
// between tests.
//
// The locked decisions under test (see docs/cherry-chat-application-identity.md):
//   IDENTITY-001: default Cherry Studio userData behavior remains unchanged.
//   IDENTITY-002: Cherry Chat gets independent packaged and dev profiles.
//   IDENTITY-006: Cherry Chat must fail closed rather than resolve to the
//                 Cherry Studio default profile.
// ---------------------------------------------------------------------------

// Per-test mutable state backing the mocked Electron app / platform / fs
// modules. Kept in vi.hoisted() so the vi.mock factories can read and update
// it, while the tests reset it in beforeEach.
const electronState = vi.hoisted(() => ({
  appDataRoot: '/mock/Application Support',
  defaultUserData: '/mock/Application Support/Cherry Studio',
  exePath: '/mock/install/Cherry Studio.app/Contents/MacOS/Cherry Studio',
  currentUserData: '/mock/Application Support/Cherry Studio',
  isPackaged: true,
  setPathCalls: [] as Array<[string, string]>,
  reset(): void {
    electronState.appDataRoot = '/mock/Application Support'
    electronState.defaultUserData = '/mock/Application Support/Cherry Studio'
    electronState.exePath = '/mock/install/Cherry Studio.app/Contents/MacOS/Cherry Studio'
    electronState.currentUserData = '/mock/Application Support/Cherry Studio'
    electronState.isPackaged = true
    electronState.setPathCalls = []
  }
}))

// Process argv backing the explicit `--user-data-dir` CLI override seam. In the
// real runtime Electron applies the override to app.getPath('userData') before
// JS runs, so tests simulating a CLI override ALSO set electronState.currentUserData
// to the CLI value (exactly what initAppDataDir() observes at bootstrap).
const argvState = vi.hoisted(() => ({
  originalArgv: process.argv,
  tokens: [] as string[],
  set(...tokens: string[]): void {
    argvState.tokens = [...tokens]
    process.argv = ['/mock/electron', ...tokens]
  },
  restore(): void {
    process.argv = argvState.originalArgv
  }
}))

const constantState = vi.hoisted(() => ({
  isDev: false,
  isPortable: false,
  reset(): void {
    constantState.isDev = false
    constantState.isPortable = false
  }
}))

const fsState = vi.hoisted(() => ({
  existing: new Set<string>(),
  configJson: '',
  accessAllowed: true,
  probed: [] as string[],
  written: [] as Array<[string, string]>,
  mkdirs: [] as string[],
  reset(): void {
    fsState.existing = new Set<string>()
    fsState.configJson = ''
    fsState.accessAllowed = true
    fsState.probed = []
    fsState.written = []
    fsState.mkdirs = []
  }
}))

// Synthetic roots used by every path the (mocked) filesystem may see. Any path
// outside these roots would mean a real user directory was touched.
const SYNTHETIC_ROOTS = ['/mock/', '/custom/', '/portable/', '/legacy/', '/disposable/']

// Flavor-specific config paths derived from the mocked homedir + identity.
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.cherrystudio', 'config', 'config.json')
const CHERRY_CHAT_CONFIG_PATH = path.join(os.homedir(), '.cherrychat', 'config', 'config.json')

/**
 * Register the isolated module mocks and import the production seam fresh.
 *
 * `vi.doMock` is intentionally used (not hoisted `vi.mock`) so every dynamic
 * import of `../init` observes the exact per-test flavor/state registered here,
 * regardless of the global mocks applied by tests/main.setup.ts.
 */
async function loadInit(flavor: 'cherry-studio' | 'cherry-chat') {
  const identity = realResolveAppIdentity(flavor)

  vi.doMock('@shared/config/identity', () => ({
    appFlavor: identity.flavor,
    appIdentity: identity,
    resolveAppIdentity: (f: string | null | undefined) => realResolveAppIdentity(f),
    APP_FLAVOR_ENV_VAR: 'VITE_APP_FLAVOR'
  }))

  vi.doMock('@main/constant', () => ({
    isWin: false,
    isLinux: false,
    isMac: true,
    get isDev(): boolean {
      return constantState.isDev
    },
    get isPortable(): boolean {
      return constantState.isPortable
    }
  }))

  vi.doMock('electron', () => {
    const mock = {
      app: {
        getPath: (key: string): string => {
          switch (key) {
            case 'userData':
              return electronState.currentUserData
            case 'appData':
              return electronState.appDataRoot
            case 'exe':
              return electronState.exePath
            default:
              return '/mock/unknown'
          }
        },
        setPath: (name: string, value: string): void => {
          electronState.setPathCalls.push([name, value])
          if (name === 'userData') {
            electronState.currentUserData = value
          }
        },
        get isPackaged(): boolean {
          return electronState.isPackaged
        }
      }
    }
    return { __esModule: true, ...mock, default: mock }
  })

  vi.doMock('node:fs', () => {
    const mock = {
      existsSync: (p: string): boolean => {
        fsState.probed.push(p)
        return fsState.existing.has(p)
      },
      readFileSync: (): string => fsState.configJson,
      writeFileSync: (p: string, data: string): void => {
        fsState.written.push([p, data])
      },
      mkdirSync: (p: string): void => {
        fsState.mkdirs.push(p)
      },
      accessSync: (): void => {
        if (!fsState.accessAllowed) {
          throw new Error('EACCES: permission denied')
        }
      },
      constants: { W_OK: 0o2 }
    }
    return { ...mock, default: mock }
  })

  return import('../init')
}

describe('initAppDataDir — startup userData wiring (IDENTITY-001/002/006)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    electronState.reset()
    constantState.reset()
    fsState.reset()
    argvState.set()
    delete process.env.PORTABLE_EXECUTABLE_DIR
  })

  afterEach(() => {
    // Guard: no real home/config/userData path may be read or written — every
    // path observed by the (mocked) filesystem must live under a synthetic
    // test root.
    const observed = [...fsState.probed, ...fsState.written.map(([p]) => p), ...fsState.mkdirs]
    for (const p of observed) {
      expect(SYNTHETIC_ROOTS.some((root) => p.startsWith(root))).toBe(true)
    }
    argvState.restore()
    delete process.env.PORTABLE_EXECUTABLE_DIR
  })

  it('default packaged, no config, not portable: leaves Electron default userData untouched (IDENTITY-001)', async () => {
    const { initAppDataDir } = await loadInit('cherry-studio')

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(electronState.defaultUserData)
    // The packaged config gate probed the flavor-specific config and found none.
    expect(fsState.probed).toEqual([DEFAULT_CONFIG_PATH])
    expect(fsState.written).toEqual([])
    // Home resolution went through the mocked homedir, never a real profile.
    expect(os.homedir).toHaveBeenCalled()
  })

  it('default packaged with a configured appDataPath: the configured path wins', async () => {
    const { initAppDataDir } = await loadInit('cherry-studio')
    const configured = '/custom/studio-data'
    fsState.configJson = JSON.stringify({
      appDataPath: [{ executablePath: electronState.exePath, dataPath: configured }]
    })
    fsState.existing = new Set([DEFAULT_CONFIG_PATH, configured])

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([['userData', configured]])
    expect(electronState.currentUserData).toBe(configured)
    expect(fsState.probed).toContain(DEFAULT_CONFIG_PATH)
    expect(fsState.probed).toContain(configured)
    // No legacy-migration write for the modern array format.
    expect(fsState.written).toEqual([])
  })

  it('default packaged portable: resolves to <portableDir>/data', async () => {
    const { initAppDataDir } = await loadInit('cherry-studio')
    constantState.isPortable = true
    process.env.PORTABLE_EXECUTABLE_DIR = '/portable/install'

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([['userData', '/portable/install/data']])
    expect(electronState.currentUserData).toBe('/portable/install/data')
  })

  it('packaged portable keeps existing precedence: configured path wins over portable', async () => {
    const { initAppDataDir } = await loadInit('cherry-studio')
    constantState.isPortable = true
    process.env.PORTABLE_EXECUTABLE_DIR = '/portable/install'
    const configured = '/custom/data'
    fsState.configJson = JSON.stringify({
      appDataPath: [{ executablePath: electronState.exePath, dataPath: configured }]
    })
    fsState.existing = new Set([DEFAULT_CONFIG_PATH, configured])

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([['userData', configured]])
    expect(electronState.currentUserData).toBe(configured)
  })

  it('dev default: leaves the base for config.ts suffix handling (config/portable ignored in dev)', async () => {
    const { initAppDataDir } = await loadInit('cherry-studio')
    electronState.isPackaged = false
    constantState.isPortable = true
    process.env.PORTABLE_EXECUTABLE_DIR = '/portable/install'
    fsState.configJson = '{"appDataPath": "/ignored-in-dev"}'
    fsState.existing = new Set([DEFAULT_CONFIG_PATH, '/ignored-in-dev'])

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(electronState.defaultUserData)
    // The packaged-only gate means the config file was never even probed.
    expect(fsState.probed).toEqual([])
  })

  it('Cherry Chat packaged: sets <appData>/Cherry Chat (IDENTITY-002)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([['userData', path.join(electronState.appDataRoot, 'Cherry Chat')]])
    expect(electronState.currentUserData).toBe(path.join(electronState.appDataRoot, 'Cherry Chat'))
    // The flavor-specific home/config dir (.cherrychat) was probed by the gate.
    expect(fsState.probed).toEqual([CHERRY_CHAT_CONFIG_PATH])
  })

  it('Cherry Chat dev: establishes <appData>/Cherry Chat before config.ts suffix handling', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    electronState.isPackaged = false

    initAppDataDir()

    // Base established pre-suffix; src/main/config.ts applies the Dev suffix
    // on top (covered by the shared applyDevSuffix tests).
    expect(electronState.setPathCalls).toEqual([['userData', path.join(electronState.appDataRoot, 'Cherry Chat')]])
    expect(electronState.currentUserData).toBe(path.join(electronState.appDataRoot, 'Cherry Chat'))
    expect(fsState.probed).toEqual([])
  })

  it('Cherry Chat configured appDataPath is flavor-specific (.cherrychat config)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    const configured = '/custom/chat-data'
    fsState.configJson = JSON.stringify({
      appDataPath: [{ executablePath: electronState.exePath, dataPath: configured }]
    })
    fsState.existing = new Set([CHERRY_CHAT_CONFIG_PATH, configured])

    initAppDataDir()

    expect(fsState.probed).toContain(CHERRY_CHAT_CONFIG_PATH)
    expect(electronState.setPathCalls).toEqual([['userData', configured]])
    expect(electronState.currentUserData).toBe(configured)
  })

  it('Cherry Chat resolving to the Cherry Studio default userData throws before startup proceeds (IDENTITY-006)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    const cherryStudioDefault = path.join(electronState.appDataRoot, 'Cherry Studio')
    fsState.configJson = JSON.stringify({
      appDataPath: [{ executablePath: electronState.exePath, dataPath: cherryStudioDefault }]
    })
    fsState.existing = new Set([CHERRY_CHAT_CONFIG_PATH, cherryStudioDefault])

    let caught: unknown
    try {
      initAppDataDir()
    } catch (error) {
      caught = error
    }

    // Fail-closed: the bad resolution is never accepted silently.
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/IDENTITY-006/)
    expect((caught as Error).message).toContain('Cherry Studio')
    expect(electronState.setPathCalls).toEqual([['userData', cherryStudioDefault]])
  })

  it('Cherry Chat resolving to the actual Electron-derived CherryStudio profile throws (IDENTITY-006)', async () => {
    // The real Cherry Studio profile on this machine is `<appDataRoot>/CherryStudio`
    // (Electron derives it from the packaged package.json `name`); both the
    // ADR form (`Cherry Studio`) and this actual form must fail closed.
    const { initAppDataDir } = await loadInit('cherry-chat')
    const actualCherryStudioDefault = path.join(electronState.appDataRoot, 'CherryStudio')
    fsState.configJson = JSON.stringify({
      appDataPath: [{ executablePath: electronState.exePath, dataPath: actualCherryStudioDefault }]
    })
    fsState.existing = new Set([CHERRY_CHAT_CONFIG_PATH, actualCherryStudioDefault])

    let caught: unknown
    try {
      initAppDataDir()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/IDENTITY-006/)
    expect((caught as Error).message).toContain('CherryStudio')
    expect(electronState.setPathCalls).toEqual([['userData', actualCherryStudioDefault]])
  })

  it('legacy string appDataPath still wins and migrates through the (mocked) config write', async () => {
    const { initAppDataDir } = await loadInit('cherry-studio')
    const legacy = '/legacy/studio-data'
    fsState.configJson = JSON.stringify({ appDataPath: legacy })
    fsState.existing = new Set([DEFAULT_CONFIG_PATH, legacy])

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([['userData', legacy]])
    // The migration write only touches the mocked flavor config path.
    expect(fsState.written).toHaveLength(1)
    expect(fsState.written[0][0]).toBe(DEFAULT_CONFIG_PATH)
    const migrated = JSON.parse(fsState.written[0][1]) as {
      appDataPath: Array<{ executablePath: string; dataPath: string }>
    }
    expect(migrated.appDataPath[0]).toEqual({ executablePath: electronState.exePath, dataPath: legacy })
  })

  // -------------------------------------------------------------------------
  // Explicit `--user-data-dir` CLI override (Phase C precedence contract):
  // Electron applies the override to app.getPath('userData') before JS runs;
  // initAppDataDir() must PRESERVE it for both flavors instead of overwriting
  // it with the flavor identity default. The IDENTITY-006 guard still runs on
  // the final value and fails closed for the Cherry Studio default.
  // -------------------------------------------------------------------------

  it('preserves an explicit --user-data-dir for the default flavor packaged (no overwrite)', async () => {
    const { initAppDataDir } = await loadInit('cherry-studio')
    const cliPath = '/disposable/cli-profile'
    // Electron already applied the override before JS ran.
    electronState.currentUserData = cliPath
    argvState.set(`--user-data-dir=${cliPath}`, '--no-sandbox')

    initAppDataDir()

    // The explicit override is preserved verbatim — no setPath at all.
    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(cliPath)
  })

  it('preserves an explicit --user-data-dir for Cherry Chat packaged instead of the identity default', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    const cliPath = '/disposable/cli-profile'
    electronState.currentUserData = cliPath
    argvState.set(`--user-data-dir=${cliPath}`, '--no-sandbox')

    initAppDataDir()

    // The override survives — previously the cherry-chat identity default
    // (<appData>/Cherry Chat) overwrote it.
    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(cliPath)
    expect(electronState.currentUserData).not.toBe(path.join(electronState.appDataRoot, 'Cherry Chat'))
  })

  it('preserves an explicit --user-data-dir for Cherry Chat dev (base for the suffix gate)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    electronState.isPackaged = false
    const cliPath = '/disposable/cli-profile'
    electronState.currentUserData = cliPath
    argvState.set(`--user-data-dir=${cliPath}`, '--no-sandbox')

    initAppDataDir()

    // Base preserved pre-suffix; src/main/config.ts now skips the Dev suffix
    // when an explicit override is present (covered by the config test).
    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(cliPath)
    expect(fsState.probed).toEqual([])
  })

  it('explicit --user-data-dir beats the packaged configured appDataPath (CLI > configured)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    const cliPath = '/disposable/cli-profile'
    const configured = '/custom/chat-data'
    // A flavor config exists, but the explicit CLI override must win.
    fsState.configJson = JSON.stringify({
      appDataPath: [{ executablePath: electronState.exePath, dataPath: configured }]
    })
    fsState.existing = new Set([CHERRY_CHAT_CONFIG_PATH, configured])
    electronState.currentUserData = cliPath
    argvState.set(`--user-data-dir=${cliPath}`, '--no-sandbox')

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(cliPath)
  })

  it('explicit --user-data-dir beats portable mode (CLI > portable)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    const cliPath = '/disposable/cli-profile'
    constantState.isPortable = true
    process.env.PORTABLE_EXECUTABLE_DIR = '/portable/install'
    electronState.currentUserData = cliPath
    argvState.set(`--user-data-dir=${cliPath}`, '--no-sandbox')

    initAppDataDir()

    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(cliPath)
  })

  it('Cherry Chat CLI override pointing at the Cherry Studio default userData still fails closed (IDENTITY-006)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    const cherryStudioDefault = path.join(electronState.appDataRoot, 'Cherry Studio')
    // Electron applied the CLI override — which points at the forbidden profile.
    electronState.currentUserData = cherryStudioDefault
    argvState.set(`--user-data-dir=${cherryStudioDefault}`, '--no-sandbox')

    let caught: unknown
    try {
      initAppDataDir()
    } catch (error) {
      caught = error
    }

    // Fail-closed: the CLI override is highest precedence for resolution but
    // never overrides the IDENTITY-006 refusal guard.
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/IDENTITY-006/)
    expect((caught as Error).message).toContain('Cherry Studio')
    // The override was preserved before the guard fired (no identity-default
    // overwrite), and the refusal guard rejected it.
    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(cherryStudioDefault)
  })

  it('Cherry Chat CLI override pointing at the actual Electron-derived CherryStudio profile still fails closed (IDENTITY-006)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    const actualCherryStudioDefault = path.join(electronState.appDataRoot, 'CherryStudio')
    // Electron applied the CLI override — which points at the forbidden profile.
    electronState.currentUserData = actualCherryStudioDefault
    argvState.set(`--user-data-dir=${actualCherryStudioDefault}`, '--no-sandbox')

    let caught: unknown
    try {
      initAppDataDir()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/IDENTITY-006/)
    expect((caught as Error).message).toContain('CherryStudio')
    // The override was preserved before the guard fired, and the refusal guard
    // rejected the actual Electron-derived profile too.
    expect(electronState.setPathCalls).toEqual([])
    expect(electronState.currentUserData).toBe(actualCherryStudioDefault)
  })

  it('a non-user-data CLI arg is ignored (no false-positive override)', async () => {
    const { initAppDataDir } = await loadInit('cherry-chat')
    argvState.set('--user-data-dir-adjacent=/disposable/other', '--flag')

    initAppDataDir()

    // No override detected: the identity default applies as usual.
    expect(electronState.setPathCalls).toEqual([['userData', path.join(electronState.appDataRoot, 'Cherry Chat')]])
    expect(electronState.currentUserData).toBe(path.join(electronState.appDataRoot, 'Cherry Chat'))
  })
})
