import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanupRunRegistry, getRunRegistryPath, initializeRunRegistry, registerOwnedProfile } from './run-ownership'

const tempDirs: string[] = []

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-e2e-ownership-test-'))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('run ownership cleanup', () => {
  it('teardown for token A leaves token B registry and profile untouched', () => {
    const tmpDir = createTempDir()
    const tokenA = 'run-a'
    const tokenB = 'run-b'
    const profileA = path.join(tmpDir, 'cherry-e2e-run-a')
    const profileB = path.join(tmpDir, 'cherry-e2e-run-b')

    fs.mkdirSync(profileA, { recursive: true })
    fs.mkdirSync(`${profileA}Dev`, { recursive: true })
    fs.mkdirSync(profileB, { recursive: true })
    fs.mkdirSync(`${profileB}Dev`, { recursive: true })
    initializeRunRegistry(tokenA, tmpDir)
    initializeRunRegistry(tokenB, tmpDir)
    registerOwnedProfile(profileA, tokenA, tmpDir)
    registerOwnedProfile(profileB, tokenB, tmpDir)

    expect(cleanupRunRegistry(tokenA, tmpDir)).toEqual([])
    expect(fs.existsSync(profileA)).toBe(false)
    expect(fs.existsSync(`${profileA}Dev`)).toBe(false)
    expect(fs.existsSync(getRunRegistryPath(tokenA, tmpDir))).toBe(false)
    expect(fs.existsSync(profileB)).toBe(true)
    expect(fs.existsSync(`${profileB}Dev`)).toBe(true)
    expect(fs.existsSync(getRunRegistryPath(tokenB, tmpDir))).toBe(true)

    expect(cleanupRunRegistry(tokenB, tmpDir)).toEqual([])
    expect(fs.existsSync(profileB)).toBe(false)
    expect(fs.existsSync(`${profileB}Dev`)).toBe(false)
    expect(fs.existsSync(getRunRegistryPath(tokenB, tmpDir))).toBe(false)
  })
})
