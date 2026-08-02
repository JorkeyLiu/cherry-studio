import path from 'node:path'

import { captureMarkers, removeMarkers, removeStaleBinDirs } from './binding'
import { runCheck, verifyPackageVersion } from './check'
import {
  ELECTRON_ABI,
  ELECTRON_ARCH,
  ELECTRON_PLATFORM,
  ELECTRON_VERSION,
  NATIVE_PACKAGE,
  NODE_ABI,
  NODE_MIN_VERSION,
  PNPM_VERSION
} from './constants'
import type { CheckReport, Effects, RebuildReport, Target } from './types'
import { isAtLeast } from './versions'

const REPAIR_ELECTRON = 'pnpm native:rebuild:electron'

/**
 * Rebuild preconditions (LOCK-ABI-7 / LOCK-ABI-5). No environment assumptions:
 * the current Node runtime must be a supported Node24 with ABI 137, the pnpm
 * version must be the locked 10.27.0, `process.execPath` must be verified, and
 * for the Electron target the platform/arch/version must match the locked
 * scope. The child PATH is exercised by spawning `pnpm --version`.
 */
function verifyPreconditions(effects: Effects, target: Target, info: ReturnType<Effects['runtimeInfo']>): string[] {
  const failures: string[] = []
  if (!isAtLeast(info.nodeVersion, NODE_MIN_VERSION)) {
    failures.push(`Unsupported Node runtime ${info.nodeVersion}; requires >= ${NODE_MIN_VERSION}.`)
  }
  if (info.modulesAbi !== NODE_ABI) {
    failures.push(
      `Node ABI ${info.modulesAbi} detected (expected ${NODE_ABI}); rebuilds must run under supported Node24.`
    )
  }
  if (!info.execPath || !effects.exists(info.execPath)) {
    failures.push(`process.execPath not verified: ${info.execPath ?? '(empty)'}.`)
  }
  const pnpm = effects.pnpmVersion()
  if (pnpm !== PNPM_VERSION) {
    failures.push(
      `pnpm ${pnpm ?? 'not found on child PATH'} detected (expected ${PNPM_VERSION}); add pnpm@${PNPM_VERSION} to PATH.`
    )
  }
  if (target === 'electron') {
    if (info.platform !== ELECTRON_PLATFORM || info.arch !== ELECTRON_ARCH) {
      failures.push(
        `Electron rebuild is currently supported on ${ELECTRON_PLATFORM} ${ELECTRON_ARCH} only; detected ${info.platform} ${info.arch}.`
      )
    }
    const installed = effects.electronVersion()
    if (installed !== ELECTRON_VERSION) {
      failures.push(`Installed Electron ${installed ?? 'unknown'} does not match expected ${ELECTRON_VERSION}.`)
    }
    if (!effects.electronBinPath()) {
      failures.push('Electron executable not found; run `pnpm install`.')
    }
  }
  return failures
}

function splitLogs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Rebuild the single better-sqlite3 binding for the target runtime.
 *
 * - Node target: node-gyp source build in the resolved package realpath,
 *   driven by the verified Node24 (ABI 137). Nothing unrelated is rebuilt.
 * - Electron target: direct `@electron/rebuild` API with force=true,
 *   buildFromSource=true, onlyModules=['better-sqlite3'], sequential mode,
 *   operating on the stable-resolved pnpm package realpath (LOCK-ABI-5).
 *
 * Marker safety (LOCK-ABI-6): the marker state is captured before the rebuild;
 * a failed rebuild or failed post-check removes any marker that could claim
 * success; the tool never writes a success marker by hand. A successful
 * Electron rebuild may leave the tool-written marker, which docs declare
 * non-authoritative.
 */
export async function runRebuild(effects: Effects, target: Target): Promise<RebuildReport> {
  const info = effects.runtimeInfo()
  const report: RebuildReport = {
    target,
    ok: false,
    nodeVersion: info.nodeVersion,
    abi: info.modulesAbi,
    platform: info.platform,
    arch: info.arch,
    packagePath: undefined,
    bindingPath: undefined,
    markerBefore: [],
    toolOutput: [],
    failures: [],
    repairCommand: target === 'node' ? 'pnpm native:rebuild:node' : REPAIR_ELECTRON
  }

  report.failures.push(...verifyPreconditions(effects, target, info))
  if (report.failures.length > 0) {
    return report
  }

  const pkgJson = effects.resolvePackageJsonPath(NATIVE_PACKAGE)
  if (!pkgJson) {
    report.failures.push(`${NATIVE_PACKAGE} is not installed; run \`pnpm install\`.`)
    return report
  }
  const packagePath = effects.realpath(path.dirname(pkgJson))
  report.packagePath = packagePath

  // Version enforcement (finding A): a rebuild cannot repair a dependency-version
  // mismatch, so fail fast with dependency remediation instead of building.
  const versionFailure = verifyPackageVersion(effects, packagePath)
  if (versionFailure) {
    report.failures.push(versionFailure)
    report.repairCommand = undefined
    return report
  }

  // LOCK-ABI-6: capture marker state before the rebuild. A build-dir
  // enumeration failure means marker safety cannot be asserted, so the rebuild
  // fails fast before any build action (finding H).
  const markerCapture = captureMarkers(effects, packagePath)
  report.markerBefore = markerCapture.snapshots
  if (markerCapture.errors.length > 0) {
    report.failures.push('marker enumeration failed:', ...markerCapture.errors)
    return report
  }

  let run: { ok: boolean; logs: string[]; error?: string }
  if (target === 'node') {
    const nodeGypJs = effects.nodeGypJsPath()
    if (!nodeGypJs) {
      report.failures.push(
        'node-gyp is not resolvable (neither from @electron/rebuild nor from the verified Node npm).',
        'Run `pnpm install` and retry.'
      )
      return report
    }
    // LOCK-ABI-5/7: the Node rebuild must use the verified Node's own headers.
    // `nodeDir` is undefined when `<prefix>/include/node/node.h` cannot be
    // proven — fail the precondition with a precise error before any child
    // spawn, never fall back to downloaded headers or an inherited
    // npm_config_nodedir (which could drift the target).
    const nodeDir = effects.nodeDir(info.execPath)
    if (!nodeDir) {
      report.failures.push(
        `Local Node24 headers not found for verified runtime ${info.execPath}: ` +
          'expected <prefix>/include/node/node.h under its install prefix.',
        'The Node rebuild requires the verified Node headers on disk (offline-safe, exact ABI match).',
        'Fix: (re)install the Node24 headers for the verified runtime (e.g. reinstall the Node24 ' +
          'binary so include/node/node.h exists), then retry.',
        'No fallback to downloaded headers or inherited npm_config_nodedir is allowed.'
      )
      return report
    }
    const spawned = effects.runNodeGyp({
      packagePath,
      nodeGypJs,
      execPath: info.execPath,
      nodeDir,
      arch: info.arch,
      platform: info.platform
    })
    const logs = [...splitLogs(spawned.stdout), ...splitLogs(spawned.stderr)]
    run =
      spawned.code === 0 ? { ok: true, logs } : { ok: false, logs, error: `node-gyp exited with code ${spawned.code}` }
  } else {
    run = await effects.rebuildElectron({
      buildPath: effects.projectRoot(),
      electronVersion: ELECTRON_VERSION,
      platform: ELECTRON_PLATFORM,
      arch: ELECTRON_ARCH,
      onlyModules: [NATIVE_PACKAGE],
      force: true,
      buildFromSource: true,
      projectRootPath: effects.projectRoot(),
      mode: 'sequential'
    })
  }
  report.toolOutput = run.logs

  if (!run.ok) {
    // LOCK-ABI-6: a failed rebuild must not leave a marker claiming success.
    // Invalidation failures are observable (finding C): the rebuild already
    // fails, and the removal errors are preserved in the report.
    const removalErrors = removeMarkers(effects, packagePath)
    report.failures.push('rebuild failed', run.error ?? 'unknown error')
    if (removalErrors.length > 0) {
      report.failures.push('marker invalidation failed:', ...removalErrors)
    }
    return report
  }

  // Rebuilds automatically execute the corresponding check and fail on it.
  const postCheck: CheckReport = runCheck(effects, target)
  if (!postCheck.ok) {
    // LOCK-ABI-6: a failed post-check must invalidate the marker as well.
    const removalErrors = removeMarkers(effects, packagePath)
    report.failures.push('rebuild completed but the post-rebuild check failed:', ...postCheck.failures)
    if (removalErrors.length > 0) {
      report.failures.push('marker invalidation failed:', ...removalErrors)
    }
    report.postCheck = postCheck
    return report
  }
  report.postCheck = postCheck
  report.bindingPath = postCheck.bindingPath

  // Node-gyp writes no marker; drop stale @electron/rebuild markers and stale
  // ABI bin copies so nothing claims a state that does not hold. Cleanup errors
  // are observable and fail the rebuild (finding C); an absent optional stale
  // directory is never an error.
  const removalErrors: string[] = []
  if (target === 'node') {
    removalErrors.push(...removeMarkers(effects, packagePath))
  }
  removalErrors.push(
    ...removeStaleBinDirs(
      effects,
      packagePath,
      target === 'electron' ? ELECTRON_ABI : NODE_ABI,
      info.platform,
      info.arch
    )
  )
  if (removalErrors.length > 0) {
    report.failures.push('post-rebuild cleanup failed:', ...removalErrors)
    return report
  }

  report.ok = true
  report.failures = []
  return report
}
