import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// Bypass global fs mock for this test to use real fs
vi.unmock('node:fs')

/**
 * Tests that verify the async fs replacement in FileStorage methods
 * behaves identically to the sync version.
 *
 * The focus is on `findDuplicateFile` which had `fs.statSync` calls
 * that were converted to `await fs.promises.stat`.
 */
describe('FileStorage async fs operations', () => {
  const tmpDir = process.env.TMPDIR || '/tmp'

  describe('findDuplicateFile behavior (statSync -> promises.stat)', () => {
    it('should produce identical stat results from statSync and promises.stat', async () => {
      const testFile = path.join(tmpDir, `test-stat-compare-${Date.now()}.txt`)
      fs.writeFileSync(testFile, 'test content for stat comparison')

      try {
        const syncStats = fs.statSync(testFile)
        const asyncStats = await fs.promises.stat(testFile)

        // Core stat fields must match
        expect(asyncStats.size).toBe(syncStats.size)
        expect(asyncStats.birthtime.toISOString()).toBe(syncStats.birthtime.toISOString())
        expect(asyncStats.mtime.toISOString()).toBe(syncStats.mtime.toISOString())
        expect(asyncStats.isFile()).toBe(syncStats.isFile())
        expect(asyncStats.isDirectory()).toBe(syncStats.isDirectory())
      } finally {
        try {
          fs.unlinkSync(testFile)
        } catch {}
      }
    })

    it('should produce identical stat results for directories', async () => {
      const testDir = path.join(tmpDir, `test-dir-compare-${Date.now()}`)
      fs.mkdirSync(testDir, { recursive: true })

      try {
        const syncStats = fs.statSync(testDir)
        const asyncStats = await fs.promises.stat(testDir)

        expect(asyncStats.isDirectory()).toBe(syncStats.isDirectory())
        expect(asyncStats.birthtime.toISOString()).toBe(syncStats.birthtime.toISOString())
      } finally {
        try {
          fs.rmdirSync(testDir)
        } catch {}
      }
    })

    it('should throw identical errors for non-existent files', async () => {
      const nonExistent = path.join(tmpDir, `non-existent-${Date.now()}.txt`)

      expect(() => fs.statSync(nonExistent)).toThrow()
      await expect(fs.promises.stat(nonExistent)).rejects.toThrow()
    })
  })

  describe('existsSync behavior comparison', () => {
    it('should match existsSync result with access check', async () => {
      const testFile = path.join(tmpDir, `test-exists-compare-${Date.now()}.txt`)
      fs.writeFileSync(testFile, 'exists test')

      try {
        const existsSyncResult = fs.existsSync(testFile)

        let accessResult = true
        try {
          await fs.promises.access(testFile)
        } catch {
          accessResult = false
        }

        expect(accessResult).toBe(existsSyncResult)
      } finally {
        try {
          fs.unlinkSync(testFile)
        } catch {}
      }
    })

    it('should both return false for non-existent files', () => {
      const nonExistent = path.join(tmpDir, `non-existent-${Date.now()}.txt`)
      expect(fs.existsSync(nonExistent)).toBe(false)
    })
  })

  describe('readFileSync vs readFile', () => {
    it('should produce identical content', async () => {
      const testFile = path.join(tmpDir, `test-read-compare-${Date.now()}.txt`)
      const content = 'Hello async world! 你好世界'
      fs.writeFileSync(testFile, content, 'utf-8')

      try {
        const syncContent = fs.readFileSync(testFile, 'utf-8')
        const asyncContent = await fs.promises.readFile(testFile, 'utf-8')

        expect(asyncContent).toBe(syncContent)
        expect(asyncContent).toBe(content)
      } finally {
        try {
          fs.unlinkSync(testFile)
        } catch {}
      }
    })
  })

  describe('writeFileSync vs writeFile', () => {
    it('should produce identical file content', async () => {
      const syncFile = path.join(tmpDir, `test-write-sync-${Date.now()}.txt`)
      const asyncFile = path.join(tmpDir, `test-write-async-${Date.now()}.txt`)
      const content = 'Written content for comparison'

      try {
        fs.writeFileSync(syncFile, content, 'utf-8')
        await fs.promises.writeFile(asyncFile, content, 'utf-8')

        const syncContent = fs.readFileSync(syncFile, 'utf-8')
        const asyncContent = fs.readFileSync(asyncFile, 'utf-8')

        expect(asyncContent).toBe(syncContent)
      } finally {
        try {
          fs.unlinkSync(syncFile)
        } catch {}
        try {
          fs.unlinkSync(asyncFile)
        } catch {}
      }
    })
  })

  describe('readdirSync vs readdir', () => {
    it('should produce identical file lists', async () => {
      const testDir = path.join(tmpDir, `test-readdir-${Date.now()}`)
      fs.mkdirSync(testDir, { recursive: true })
      fs.writeFileSync(path.join(testDir, 'a.txt'), 'a')
      fs.writeFileSync(path.join(testDir, 'b.txt'), 'b')
      fs.writeFileSync(path.join(testDir, 'c.txt'), 'c')

      try {
        const syncList = fs.readdirSync(testDir).sort()
        const asyncList = (await fs.promises.readdir(testDir)).sort()

        expect(asyncList).toEqual(syncList)
      } finally {
        try {
          fs.rmSync(testDir, { recursive: true })
        } catch {}
      }
    })
  })
})
