import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { queryChatDbViaElectron } from './query-chat-db-electron'

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-query-helper-test-'))
}

describe('queryChatDbViaElectron', () => {
  it('executes through the shared implementation and cleans its script', () => {
    const tmpDir = makeTempRoot()
    let scriptPath = ''
    let spawnEnv: NodeJS.ProcessEnv | undefined
    try {
      const result = queryChatDbViaElectron('/tmp/chat.db', 'SELECT 1', tmpDir, {
        electronPath: process.execPath,
        betterSqlitePath: '/tmp/better-sqlite3',
        spawnSyncImpl: (_command, args, options) => {
          scriptPath = String(args[0])
          spawnEnv = options?.env
          return {
            pid: 1,
            output: '',
            stdout: '{"ok":true,"rows":[{"value":1}]}\n',
            stderr: '',
            status: 0,
            signal: null
          } as ReturnType<typeof import('node:child_process').spawnSync>
        }
      })
      expect(result).toEqual({ ok: true, rows: [{ value: 1 }] })
      expect(spawnEnv).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir })
      expect(fs.existsSync(scriptPath)).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns the implementation envelope for an invalid SQL result', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = queryChatDbViaElectron('/tmp/chat.db', 'SELECT missing', tmpDir, {
        electronPath: process.execPath,
        betterSqlitePath: '/tmp/better-sqlite3',
        spawnSyncImpl: () =>
          ({
            pid: 1,
            output: '',
            stdout: '{"ok":false,"error":"no such table"}\n',
            stderr: '',
            status: 0,
            signal: null
          }) as ReturnType<typeof import('node:child_process').spawnSync>
      })
      expect(result).toEqual({ ok: false, error: 'no such table' })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('cleans the script and reports a spawn failure', () => {
    const tmpDir = makeTempRoot()
    try {
      const result = queryChatDbViaElectron('/tmp/chat.db', 'SELECT 1', tmpDir, {
        electronPath: process.execPath,
        betterSqlitePath: '/tmp/better-sqlite3',
        spawnSyncImpl: () =>
          ({
            pid: undefined,
            output: '',
            stdout: '',
            stderr: '',
            status: null,
            signal: null,
            error: new Error('spawn failed')
          }) as ReturnType<typeof import('node:child_process').spawnSync>
      })
      expect(result).toBeNull()
      expect(fs.readdirSync(tmpDir)).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it.each(['relative', 'symlink', 'file'])('rejects a %s tmpDir before spawn', (kind) => {
    const parent = makeTempRoot()
    const realDir = path.join(parent, 'real')
    fs.mkdirSync(realDir)
    const tmpDir =
      kind === 'relative'
        ? 'relative-tmp-dir'
        : kind === 'symlink'
          ? path.join(parent, 'link')
          : path.join(parent, 'file')
    if (kind === 'symlink') fs.symlinkSync(realDir, tmpDir, 'dir')
    if (kind === 'file') fs.writeFileSync(tmpDir, 'not a directory')
    try {
      expect(() =>
        queryChatDbViaElectron('/tmp/chat.db', 'SELECT 1', tmpDir, {
          electronPath: process.execPath,
          betterSqlitePath: '/tmp/better-sqlite3',
          spawnSyncImpl: () => {
            throw new Error('spawn should not be called')
          }
        })
      ).toThrow(/absolute|real non-symlink directory/i)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
