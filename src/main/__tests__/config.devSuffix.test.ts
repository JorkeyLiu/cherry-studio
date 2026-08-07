import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Focused coverage for the dev-profile suffix gate in src/main/config.ts.
//
// The historical `Dev` suffix is applied on top of the identity base resolved
// by ./bootstrap (src/main/utils/init.ts). An explicit `--user-data-dir=<path>`
// CLI override is the user's direct instruction and must be preserved
// VERBATIM — the dev suffix is skipped when an override is present (Phase C
// precedence contract: CLI > identity-default > dev suffix).
// ---------------------------------------------------------------------------

const configState = vi.hoisted(() => ({
  isDev: false,
  currentUserData: '/mock/Application Support/Cherry Chat',
  setPathCalls: [] as Array<[string, string]>,
  reset(): void {
    configState.isDev = false
    configState.currentUserData = '/mock/Application Support/Cherry Chat'
    configState.setPathCalls = []
  }
}))

const argvState = vi.hoisted(() => ({
  originalArgv: process.argv,
  set(...tokens: string[]): void {
    process.argv = ['/mock/electron', ...tokens]
  },
  restore(): void {
    process.argv = argvState.originalArgv
  }
}))

async function loadConfig() {
  vi.doMock('@main/constant', () => ({
    isWin: false,
    isLinux: false,
    isMac: true,
    get isDev(): boolean {
      return configState.isDev
    }
  }))

  vi.doMock('electron', () => {
    const mock = {
      app: {
        getPath: (key: string): string => {
          if (key === 'userData') return configState.currentUserData
          return '/mock/unknown'
        },
        setPath: (name: string, value: string): void => {
          configState.setPathCalls.push([name, value])
          if (name === 'userData') {
            configState.currentUserData = value
          }
        }
      }
    }
    return { __esModule: true, ...mock, default: mock }
  })

  // getDataPath() touches the (globally mocked) fs; keep it real so the
  // module-load contract (DATA_PATH export) is exercised like production.
  return import('../config')
}

describe('config.ts — dev-suffix gate vs explicit --user-data-dir (Phase C precedence)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    configState.reset()
    argvState.set()
  })

  afterEach(() => {
    argvState.restore()
  })

  it('dev mode without a CLI override: applies the historical Dev suffix (unchanged behavior)', async () => {
    configState.isDev = true
    await loadConfig()

    expect(configState.setPathCalls).toEqual([['userData', '/mock/Application Support/Cherry ChatDev']])
    expect(configState.currentUserData).toBe('/mock/Application Support/Cherry ChatDev')
  })

  it('dev mode WITH an explicit --user-data-dir: the override is preserved verbatim (no Dev suffix)', async () => {
    configState.isDev = true
    // Electron applied the override before JS ran.
    configState.currentUserData = '/disposable/cli-profile'
    argvState.set('--user-data-dir=/disposable/cli-profile', '--no-sandbox')
    await loadConfig()

    expect(configState.setPathCalls).toEqual([])
    expect(configState.currentUserData).toBe('/disposable/cli-profile')
  })

  it('packaged mode: no dev suffix regardless of argv (existing gate)', async () => {
    configState.isDev = false
    await loadConfig()

    expect(configState.setPathCalls).toEqual([])
    expect(configState.currentUserData).toBe('/mock/Application Support/Cherry Chat')
  })
})
