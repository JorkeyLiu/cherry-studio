import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runInstallScript } from '../process'

// Load the plain-CJS installer scripts natively so the `require.main === module`
// guard is exercised and no download is triggered at import time.
const nodeRequire = createRequire(import.meta.url)
const installUvScript = nodeRequire('../../../../resources/scripts/install-uv.js') as {
  resolveBinDir: () => string
}
const installBunScript = nodeRequire('../../../../resources/scripts/install-bun.js') as {
  resolveBinDir: () => string
}

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

vi.mock('..', () => ({
  getResourcePath: () => '/app/resources',
  toAsarUnpackedPath: (filePath: string) => filePath
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn()
}))

const mockSpawn = vi.mocked(spawn)

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

describe('runInstallScript installer bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes the identity-derived bin dir to scripts via CHERRY_BIN_DIR', async () => {
    const child = createMockChildProcess()
    mockSpawn.mockReturnValue(child as never)

    const promise = runInstallScript('install-uv.js')

    child.emit('close', 0)
    await promise

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [, args, options] = mockSpawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(args).toEqual([path.join('/app/resources', 'scripts', 'install-uv.js')])
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(options.env.CHERRY_BIN_DIR).toBe(path.join(os.homedir(), HOME_CHERRY_DIR, 'bin'))
    expect(options.env.CHERRY_BIN_DIR).toBe(path.join(os.homedir(), '.cherrychat', 'bin'))
    expect(options.env.CHERRY_BIN_DIR).not.toContain('cherrystudio')
  })

  it('lets callers override CHERRY_BIN_DIR via extraEnv', async () => {
    const child = createMockChildProcess()
    mockSpawn.mockReturnValue(child as never)

    const promise = runInstallScript('install-bun.js', { CHERRY_BIN_DIR: '/custom/bin' })

    child.emit('close', 0)
    await promise

    const [, , options] = mockSpawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(options.env.CHERRY_BIN_DIR).toBe('/custom/bin')
  })

  it('preserves exit/error propagation', async () => {
    const child = createMockChildProcess()
    mockSpawn.mockReturnValue(child as never)

    const promise = runInstallScript('install-bun.js')

    child.emit('close', 3)

    await expect(promise).rejects.toThrow('Process exited with code 3')
  })
})

describe('installer scripts resolve the runtime bin dir', () => {
  const originalEnv = process.env.CHERRY_BIN_DIR

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CHERRY_BIN_DIR
    } else {
      process.env.CHERRY_BIN_DIR = originalEnv
    }
  })

  it('uv script uses the CHERRY_BIN_DIR bridge when provided', () => {
    process.env.CHERRY_BIN_DIR = '/home/testuser/.cherrychat/bin'
    expect(installUvScript.resolveBinDir()).toBe('/home/testuser/.cherrychat/bin')
  })

  it('bun script uses the CHERRY_BIN_DIR bridge when provided', () => {
    process.env.CHERRY_BIN_DIR = '/home/testuser/.cherrychat/bin'
    expect(installBunScript.resolveBinDir()).toBe('/home/testuser/.cherrychat/bin')
  })

  it('uv script falls back to the current-target home dir on direct invocation', () => {
    delete process.env.CHERRY_BIN_DIR
    const fallback = installUvScript.resolveBinDir()
    // The script resolves via the real `os.homedir()`, so assert structure
    // instead of a machine-specific absolute path.
    expect(path.isAbsolute(fallback)).toBe(true)
    expect(fallback.endsWith(path.join('.cherrychat', 'bin'))).toBe(true)
    expect(fallback).not.toContain('cherrystudio')
  })

  it('bun script falls back to the current-target home dir on direct invocation', () => {
    delete process.env.CHERRY_BIN_DIR
    const fallback = installBunScript.resolveBinDir()
    expect(path.isAbsolute(fallback)).toBe(true)
    expect(fallback.endsWith(path.join('.cherrychat', 'bin'))).toBe(true)
    expect(fallback).not.toContain('cherrystudio')
  })

  it('ignores a blank CHERRY_BIN_DIR bridge value', () => {
    process.env.CHERRY_BIN_DIR = '   '
    const fallback = installUvScript.resolveBinDir()
    expect(fallback.endsWith(path.join('.cherrychat', 'bin'))).toBe(true)
    expect(fallback).not.toContain('cherrystudio')
  })
})
