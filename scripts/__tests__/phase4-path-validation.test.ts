/**
 * Tests for Phase 4.0-C1 staging path validation.
 *
 * Tests symlink detection, path traversal, and temp dir containment.
 * Uses real filesystem operations (mkdtempSync, symlinkSync).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { validateStagingPath } from '../../src/main/phase4-path-validation'

describe('validateStagingPath', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('accepts a real directory under os.tmpdir()', () => {
    const realDir = path.join(tmpDir, 'staging')
    fs.mkdirSync(realDir)
    expect(validateStagingPath(realDir)).toBe(true)
  })

  it('accepts a real directory under /tmp', () => {
    const tmpPath = '/tmp/phase4-test-' + Date.now()
    fs.mkdirSync(tmpPath)
    try {
      expect(validateStagingPath(tmpPath)).toBe(true)
    } finally {
      fs.rmSync(tmpPath, { recursive: true, force: true })
    }
  })

  it('rejects a symlink pointing to a temp directory', () => {
    const realDir = path.join(tmpDir, 'real-staging')
    fs.mkdirSync(realDir)
    const symlinkPath = path.join(tmpDir, 'symlink-staging')
    fs.symlinkSync(realDir, symlinkPath)
    expect(validateStagingPath(symlinkPath)).toBe(false)
  })

  it('rejects a symlink that escapes to a non-temp directory', () => {
    const symlinkPath = path.join(tmpDir, 'escape-symlink')
    fs.symlinkSync('/etc', symlinkPath)
    expect(validateStagingPath(symlinkPath)).toBe(false)
  })

  it('rejects a non-existent path', () => {
    expect(validateStagingPath('/tmp/nonexistent-phase4-path-xyz')).toBe(false)
  })

  it('rejects a path outside system temp directories', () => {
    expect(validateStagingPath('/etc')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(validateStagingPath('')).toBe(false)
  })

  it('calls logFn on symlink rejection', () => {
    const realDir = path.join(tmpDir, 'real')
    fs.mkdirSync(realDir)
    const symlinkPath = path.join(tmpDir, 'symlink')
    fs.symlinkSync(realDir, symlinkPath)
    const logs: string[] = []
    validateStagingPath(symlinkPath, (msg) => logs.push(msg))
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('symlink')
  })
})
