'use strict'

/**
 * Test-owned binding fingerprint helper (scripts project only).
 *
 * Usage: `<node|electron-as-node> fingerprint.cjs` with REPO_ROOT set to the
 * repository checkout. Resolves the better-sqlite3 prebuilt binary exactly
 * the way the production default loader does, hashes the file bytes, runs a
 * real `:memory:` SQL statement, closes, and emits one JSON line:
 *
 *   NATIVE_RUNTIME_FINGERPRINT {"path": realpath, "hash": sha256,
 *     "version": pkgVersion, "sqlOk": bool, "error"?: string,
 *     "runtime": ..., "abi": ...}
 *
 * Never touches a user database or any package file (`:memory:` + reads).
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MARKER = 'NATIVE_RUNTIME_FINGERPRINT'

function fail(error) {
  console.log(
    MARKER +
      ' ' +
      JSON.stringify({
        ok: false,
        error: String((error && error.message) || error),
        runtime: process.versions.electron ? 'electron' : 'node',
        abi: Number(process.versions.modules)
      })
  )
  process.exitCode = 1
}

try {
  const repoRoot = process.env.REPO_ROOT
  if (!repoRoot) throw new Error('REPO_ROOT is required')
  const pkgPath = path.join(repoRoot, 'node_modules', 'better-sqlite3', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const root = path.dirname(pkgPath)
  const { getPrebuildPath } = require(path.join(root, 'lib', 'binding.js'))
  const candidate = getPrebuildPath()
  if (!candidate) throw new Error('no prebuilt binary selected by the default loader')
  const real = fs.realpathSync(candidate)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex')
  const Database = require(path.join(root, 'lib', 'index.js'))
  const db = new Database(':memory:')
  let sqlOk = false
  try {
    const row = db.prepare('select 1 as ok').get()
    sqlOk = !!(row && row.ok === 1)
  } finally {
    db.close()
  }
  console.log(
    MARKER +
      ' ' +
      JSON.stringify({
        ok: sqlOk,
        path: real,
        hash,
        version: pkg.version,
        sqlOk,
        runtime: process.versions.electron ? 'electron' : 'node',
        abi: Number(process.versions.modules)
      })
  )
  if (!sqlOk) process.exitCode = 1
} catch (error) {
  fail(error)
}
