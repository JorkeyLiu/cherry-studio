'use strict'

/**
 * Repo-owned Electron native ABI probe (LOCK-ABI-2).
 *
 * Runs under the installed Electron executable with ELECTRON_RUN_AS_NODE=1.
 * The probe is deliberately plain CommonJS: Electron's bundled Node does not
 * know about tsx, so this file must remain dependency-free and loadable as-is.
 *
 * It proves success the only way that counts: it actually creates
 * Database(':memory:'), runs `select 1 as ok`, checks the row, and closes.
 * Filenames, configs and .forge-meta markers never prove success (LOCK-ABI-2).
 *
 * Honesty contract (LOCK-ABI finding D):
 *  - the Database is always closed in `finally` (no leak on error);
 *  - when the SQL row is not exactly `{ ok: 1 }`, the probe emits `ok:false`
 *    with `sqlOk:false` and exits nonzero — never `ok:true`/exit 0;
 *  - both the primary error and any close error are preserved in the output.
 *
 * Production mode (LOCK-ABI-2 hardening): the module contract is hardcoded
 * to the real resolved `better-sqlite3` package — never read from the
 * environment. The only exception is the explicit test seam: when
 * NATIVE_ABI_PROBE_TEST_SEAM is exactly "1", NATIVE_ABI_PROBE_MODULE may
 * point the probe at a stub so the Vitest scripts project can cover this
 * emission contract via real subprocess spawns without depending on the
 * current native ABI. The production spawnElectronProbe deletes BOTH
 * variables from the child environment, so an inherited malicious env can
 * never redirect the real runtime SQL proof; the seam is reachable only by
 * an explicit test helper invocation that the production CLI cannot inherit.
 *
 * Output contract: exactly one line prefixed by the marker (passed via
 * NATIVE_ABI_PROBE_MARKER) followed by JSON on stdout; the parent process
 * (check:electron) parses that line and preserves child stdout/stderr and the
 * exit code.
 */

const marker = process.env.NATIVE_ABI_PROBE_MARKER || 'NATIVE_ABI_PROBE_V1'
const testSeam = process.env.NATIVE_ABI_PROBE_TEST_SEAM === '1'
// Production mode hardcodes the resolved package contract; the stub module is
// honored only under the explicit test-seam gate (LOCK-ABI-2).
const moduleSpec =
  testSeam && process.env.NATIVE_ABI_PROBE_MODULE ? process.env.NATIVE_ABI_PROBE_MODULE : 'better-sqlite3'

function emit(record) {
  console.log(marker + ' ' + JSON.stringify(record))
}

const facts = {
  runtime: process.versions.electron ? 'electron' : 'node',
  version: process.versions.electron || process.versions.node,
  nodeVersion: process.versions.node,
  abi: Number(process.versions.modules),
  platform: process.platform,
  arch: process.arch
}

let db = null
let primaryError = null
let closeError = null
let sqlOk = false

try {
  // require() resolves from this file: scripts/native-abi -> scripts -> repo
  // root node_modules -> pnpm realpath. Mirrors what the app does at runtime.
  const Database = require(moduleSpec)
  db = new Database(':memory:')
  const row = db.prepare('select 1 as ok').get()
  sqlOk = !!(row && row.ok === 1)
  if (!sqlOk) {
    primaryError = 'SQL probe returned an unexpected row'
  }
} catch (err) {
  primaryError = String((err && err.message) || err)
} finally {
  if (db) {
    try {
      db.close()
    } catch (err) {
      closeError = String((err && err.message) || err)
    }
  }
}

const ok = sqlOk && !primaryError && !closeError
emit({
  ok,
  ...facts,
  sqlOk,
  error: primaryError || undefined,
  closeError: closeError || undefined
})
if (!ok) {
  process.exitCode = 1
}
