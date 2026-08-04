/**
 * Unit tests for the retained-snapshot file evidence helper (LOCK-SNAP-2).
 *
 * Covers symlink / zero-byte / missing / non-file rejection and the happy
 * path, all with fixed path-free messages.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { assertRetainedSnapshotFile } from './snapshot-file'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-snapshot-file-'))
}

describe('assertRetainedSnapshotFile (LOCK-SNAP-2)', () => {
  it('passes for a regular non-empty file', () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, 'snapshot.db')
      fs.writeFileSync(file, 'valid snapshot bytes')
      expect(() => assertRetainedSnapshotFile(file)).not.toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a missing snapshot', () => {
    const dir = makeTempDir()
    try {
      expect(() => assertRetainedSnapshotFile(path.join(dir, 'nope.db'))).toThrow(
        'retained pre-import snapshot missing'
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a symlink even when it resolves to a valid file', () => {
    const dir = makeTempDir()
    try {
      const target = path.join(dir, 'real.db')
      fs.writeFileSync(target, 'valid snapshot bytes')
      const link = path.join(dir, 'snapshot-link.db')
      fs.symlinkSync(target, link)
      expect(() => assertRetainedSnapshotFile(link)).toThrow('retained pre-import snapshot must not be a symlink')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a zero-byte file', () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, 'empty.db')
      fs.writeFileSync(file, '')
      expect(() => assertRetainedSnapshotFile(file)).toThrow('retained pre-import snapshot must be non-empty')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a directory (not a regular file)', () => {
    const dir = makeTempDir()
    try {
      expect(() => assertRetainedSnapshotFile(dir)).toThrow('retained pre-import snapshot must be a regular file')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never embeds the path in the failure messages', () => {
    const dir = makeTempDir()
    try {
      const secret = path.join(dir, 'secret-snapshot.db')
      try {
        assertRetainedSnapshotFile(secret)
        expect.unreachable('expected a throw')
      } catch (error) {
        expect(String(error)).not.toContain(secret)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
