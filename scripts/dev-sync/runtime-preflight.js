'use strict'
/**
 * Pure runtime preflight for `pnpm dev:sync`.
 *
 * Runs under the CALLER's host Node (whatever `node` resolves to on PATH)
 * BEFORE the canonical Electron lane, and before any persistent dev seeds,
 * cache/session reads or writes, dependency installs, port binds, or child
 * spawns. It never requires better-sqlite3 or Electron, and this file uses
 * only conservative CommonJS syntax so it still parses on unsupported
 * Node majors (e.g. Node 22) it is meant to reject.
 *
 * The public entrypoint reads ONLY the real `process.version` and
 * `process.versions.modules`: there is no environment-variable bypass.
 * Focused regression tests inject simulated runtimes without a production
 * hook — pure unit tests over the exported validators plus real child
 * processes running this entrypoint under a test-only `-r` preload fixture
 * (created and cleaned up by the test) that fakes `process.version` /
 * `process.versions.modules` before the entrypoint runs.
 *
 * Pin source: `.nvmrc` (fallback `.node-version`); a missing or invalid pin
 * fails closed instead of silently falling back. Expected ABI 137 matches
 * the existing native Node lane contract
 * (`scripts/native-abi/constants.ts` NODE_ABI for Node 24).
 *
 * Exit: 0 = supported (silent, the canonical lane runs next);
 * 1 = unsupported (diagnostic on stderr, fail-closed before the lane).
 */

var fs = require('node:fs')
var path = require('node:path')

/* Keep in sync with scripts/native-abi/constants.ts NODE_ABI (Node 24 lane). */
var REQUIRED_ABI = '137'

function parseSemver(raw) {
  if (typeof raw !== 'string') return null
  var cleaned = raw
    .trim()
    .replace(/^[vV=]/, '')
    .trim()
  var match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(cleaned)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: cleaned }
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

/**
 * Read the pinned Node version from `.nvmrc` (fallback `.node-version`).
 * Fail-closed: a missing or invalid pin returns ok:false instead of a
 * silent fallback, so the caller can never pseudo-pass on a guess.
 */
function readRequiredVersion(repoRoot) {
  var candidates = [path.join(repoRoot, '.nvmrc'), path.join(repoRoot, '.node-version')]
  for (var i = 0; i < candidates.length; i++) {
    var content = null
    try {
      content = fs.readFileSync(candidates[i], 'utf8')
    } catch (err) {
      continue
    }
    var parsed = parseSemver(content)
    if (parsed) return { ok: true, version: parsed.text }
  }
  return { ok: false }
}

/**
 * Fail-closed support decision over injected observations (no I/O).
 * Supported only when: same major as required, version >= required,
 * and module ABI equals the Node 24 lane ABI.
 */
function isSupportedVersion(observations) {
  var current = parseSemver(observations.version)
  var required = parseSemver(observations.requiredVersion)
  if (!current || !required) return false
  if (current.major !== required.major) return false
  if (compareSemver(current, required) < 0) return false
  if (String(observations.abi) !== String(observations.requiredAbi)) return false
  return true
}

function fixGuidanceLines(requiredVersion) {
  return [
    '[dev-sync] fix (session-local, no dotfile change, no cache deletion needed):',
    '[dev-sync]   which -a node',
    '[dev-sync]   export PATH="$HOME/.nvm/versions/node/v24.11.1/bin:$PATH"',
    '[dev-sync]   node -v  # must print v' + requiredVersion + ' (or newer 24.x >= ' + requiredVersion + ')',
    '[dev-sync]   pnpm -v  # must print 10.27.0',
    '[dev-sync] then retry: pnpm dev:sync'
  ]
}

function formatDiagnostic(currentVersion, currentAbi, requiredVersion) {
  var lines = [
    '[dev-sync] unsupported Node runtime: ' +
      currentVersion +
      ' (ABI ' +
      currentAbi +
      '). Required Node ' +
      requiredVersion +
      ' (ABI ' +
      REQUIRED_ABI +
      ', Node 24 lane).',
    '[dev-sync] refusing to start before the Electron lane, installs, ports, or children (fail-closed).'
  ].concat(fixGuidanceLines(requiredVersion))
  return lines.join('\n') + '\n'
}

function formatPinDiagnostic() {
  var lines = [
    '[dev-sync] unreadable Node pin (.nvmrc/.node-version missing or invalid; expected e.g. 24.11.1).',
    '[dev-sync] refusing to start before the Electron lane, installs, ports, or children (fail-closed).',
    '[dev-sync] restore the repository pin files, then verify the pinned toolchain before retrying:'
  ].concat(fixGuidanceLines('24.11.1'))
  return lines.join('\n') + '\n'
}

function main() {
  var repoRoot = path.resolve(__dirname, '..', '..')
  var pin = readRequiredVersion(repoRoot)
  if (!pin.ok) {
    process.stderr.write(formatPinDiagnostic())
    process.exitCode = 1
    return
  }
  // Unconditional: the real host runtime only — no environment bypass.
  var currentVersion = process.version
  var currentAbi = String((process.versions && process.versions.modules) || '')
  var ok = isSupportedVersion({
    version: currentVersion,
    abi: currentAbi,
    requiredVersion: pin.version,
    requiredAbi: REQUIRED_ABI
  })
  if (ok) {
    process.exitCode = 0
    return
  }
  process.stderr.write(formatDiagnostic(String(currentVersion), String(currentAbi), String(pin.version)))
  process.exitCode = 1
}

if (require.main === module) {
  main()
}

module.exports = {
  parseSemver,
  compareSemver,
  readRequiredVersion,
  isSupportedVersion,
  formatDiagnostic,
  formatPinDiagnostic,
  REQUIRED_ABI
}
