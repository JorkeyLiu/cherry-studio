import path from 'node:path'

import {
  ELECTRON_ABI,
  ELECTRON_VERSION,
  electronTargetFor,
  NATIVE_PACKAGE,
  NATIVE_PACKAGE_VERSION,
  NODE_ABI,
  NODE_MIN_VERSION,
  PROBE_TIMEOUT_MS
} from './constants'
import { parseProbeOutput } from './effects'
import type { CheckReport, Effects, ElectronProbeOutput } from './types'
import { isAtLeast } from './versions'

/**
 * Read-only runtime diagnostics for the shared better-sqlite3 Node-API binary.
 *
 * Both checks verify the locked dependency version and then prove success the
 * only way that counts: a real `Database(':memory:')` + `select 1 as ok` +
 * close under the target runtime. Observed ABI numbers are reported as
 * informational diagnostics and never gate the result — the Node-API binary
 * is runtime-agnostic.
 *
 * Failure remediation is dependency-level (`package.json` pin + reinstall).
 * There is no rebuild, relink, restore, or lock concept: nothing here writes
 * to node_modules, user databases, or package files.
 */

interface PackageResolution {
  packagePath?: string
  failure?: string
}

function resolvePackage(effects: Effects): PackageResolution {
  const pkgJson = effects.resolvePackageJsonPath(NATIVE_PACKAGE)
  if (!pkgJson) {
    return { failure: `${NATIVE_PACKAGE} is not installed; run \`pnpm install\`.` }
  }
  return { packagePath: effects.realpath(path.dirname(pkgJson)) }
}

function packageVersion(effects: Effects, packagePath: string): string {
  try {
    const pkg = effects.readJson(path.join(packagePath, 'package.json')) as { version?: string }
    return pkg.version ?? ''
  } catch {
    return ''
  }
}

/**
 * Enforce the locked better-sqlite3 version. Returns a failure message when
 * the resolved package version differs from the locked
 * `NATIVE_PACKAGE_VERSION`, or undefined on match. The failure provides
 * dependency remediation and never suggests a native rebuild.
 */
export function verifyPackageVersion(effects: Effects, packagePath: string): string | undefined {
  const actual = packageVersion(effects, packagePath)
  if (actual === NATIVE_PACKAGE_VERSION) {
    return undefined
  }
  return [
    `better-sqlite3 resolved version ${actual || 'unknown'} does not match the locked ${NATIVE_PACKAGE_VERSION} (package realpath: ${packagePath}).`,
    'This is a dependency-version mismatch; reinstall the locked dependency.',
    `Remediation: pin "better-sqlite3": "${NATIVE_PACKAGE_VERSION}" in package.json, re-run \`pnpm install\`, then retry this command.`
  ].join('\n')
}

/** Check the shared binary against the running Node runtime (in-process). */
export function runNodeCheck(effects: Effects): CheckReport {
  const info = effects.runtimeInfo()
  const report: CheckReport = {
    target: 'node',
    ok: false,
    runtimeName: 'node',
    runtimeVersion: info.nodeVersion,
    abi: info.modulesAbi,
    platform: info.platform,
    arch: info.arch,
    sqlVerified: false,
    failures: []
  }

  const runtimeLabel = `node ${info.nodeVersion} (ABI ${info.modulesAbi} informational, ${info.platform}/${info.arch})`
  if (!isAtLeast(info.nodeVersion, NODE_MIN_VERSION)) {
    report.failures.push(
      `Unsupported Node runtime: ${runtimeLabel}; repository requires >= ${NODE_MIN_VERSION} (see .node-version).`,
      `Run the command with a supported Node24 binary on PATH, then re-run \`pnpm install\` if the dependency is missing.`
    )
    return report
  }
  if (info.modulesAbi !== NODE_ABI) {
    // Informational only: the Node-API binary loads under any modules ABI.
    // Recorded on the report for diagnostics; never a failure.
  }

  const resolved = resolvePackage(effects)
  if (!resolved.packagePath) {
    report.failures.push(resolved.failure ?? 'package resolution failed')
    return report
  }
  report.packagePath = resolved.packagePath
  try {
    report.packageVersion = packageVersion(effects, resolved.packagePath)
  } catch {
    report.packageVersion = ''
  }

  const versionFailure = verifyPackageVersion(effects, resolved.packagePath)
  if (versionFailure) {
    report.failures.push(versionFailure)
    return report
  }

  // Only a real Database(':memory:') + select 1 + close proves success.
  const probe = effects.probeNodeBinding()
  report.probeCloseError = probe.closeError
  if (!probe.sqlOk) {
    report.failures.push(
      `better-sqlite3 runtime SQL probe failed: ${probe.error ?? 'unknown error'}`,
      `The shared binary does not load under ${runtimeLabel}.`,
      `Package realpath: ${resolved.packagePath}`,
      `Remediation: re-run \`pnpm install\` to restore the locked ${NATIVE_PACKAGE_VERSION} prebuilds, then retry.`
    )
    if (probe.closeError && probe.error !== `Database close failed: ${probe.closeError}`) {
      report.failures.push(`Node probe close error: ${probe.closeError}`)
    }
    return report
  }

  report.ok = true
  report.sqlVerified = true
  return report
}

/** Check the shared binary against the installed Electron runtime. */
export function runElectronCheck(effects: Effects): CheckReport {
  const info = effects.runtimeInfo()
  const target = electronTargetFor(info.platform, info.arch)
  const report: CheckReport = {
    target: 'electron',
    ok: false,
    runtimeName: 'electron',
    // Expected locked facts; overwritten by probe-detected facts when available.
    runtimeVersion: ELECTRON_VERSION,
    abi: ELECTRON_ABI,
    platform: target?.platform ?? 'darwin',
    arch: target?.arch ?? 'arm64',
    sqlVerified: false,
    failures: []
  }

  const hostLabel = `host node ${info.nodeVersion} (ABI ${info.modulesAbi} informational, ${info.platform}/${info.arch})`
  if (!target) {
    report.failures.push(
      `Electron native checks are currently supported on darwin arm64 or win32 x64; detected ${info.platform} ${info.arch}.`,
      `Host runtime: ${hostLabel}`
    )
    return report
  }

  const resolved = resolvePackage(effects)
  if (!resolved.packagePath) {
    report.failures.push(resolved.failure ?? 'package resolution failed')
    return report
  }
  report.packagePath = resolved.packagePath
  try {
    report.packageVersion = packageVersion(effects, resolved.packagePath)
  } catch {
    report.packageVersion = ''
  }

  const installed = effects.electronVersion()
  if (installed !== ELECTRON_VERSION) {
    report.failures.push(
      `Installed Electron ${installed ?? 'unknown'} does not match expected ${ELECTRON_VERSION}.`,
      `Align the electron devDependency with the locked version before checking.`,
      `Package realpath: ${resolved.packagePath}`
    )
    return report
  }
  const bin = effects.electronBinPath()
  if (!bin) {
    report.failures.push(
      `Electron executable not found; run \`pnpm install\`.`,
      `Package realpath: ${resolved.packagePath}`
    )
    return report
  }

  const versionFailure = verifyPackageVersion(effects, resolved.packagePath)
  if (versionFailure) {
    report.failures.push(versionFailure)
    return report
  }

  const spawned = effects.spawnElectronProbe(bin, effects.probePath())
  // Preserve child stdout/stderr, the exit code, and any close error explicitly
  // in the structured report — never only buried in free text.
  const childLines = [spawned.stdout.trim(), spawned.stderr.trim()].filter(Boolean)
  report.probeExitCode = spawned.code

  if (spawned.timedOut) {
    report.failures.push(
      `Electron runtime SQL probe timed out after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s (bounded diagnostic timeout; child terminated, no retry).`,
      `Probe exit code: ${spawned.code}`,
      `The shared binary did not answer under Electron ${ELECTRON_VERSION} within the diagnostic bound.`,
      `Package realpath: ${resolved.packagePath}`,
      `Remediation: re-run \`pnpm install\` to restore the locked ${NATIVE_PACKAGE_VERSION} prebuilds, then retry.`
    )
    return report
  }

  const probe: ElectronProbeOutput | undefined = parseProbeOutput(spawned.stdout) ?? parseProbeOutput(spawned.stderr)
  // Surface the probe's runtime facts even when it failed — the embedded
  // runtime values are the correct diagnostics for this host.
  if (probe) {
    report.runtimeVersion = probe.version
    report.abi = probe.abi
    report.platform = probe.platform
    report.arch = probe.arch
    report.nodeVersion = probe.nodeVersion
    report.probeCloseError = probe.closeError
  }

  const electronLabel = probe
    ? `Electron ${probe.version} (embedded node ${probe.nodeVersion}, ABI ${probe.abi} informational, ${probe.platform}/${probe.arch})`
    : `Electron ${ELECTRON_VERSION} (expected ABI ${ELECTRON_ABI} informational, darwin/arm64)`
  if (spawned.code !== 0 || !probe || !probe.ok || !probe.sqlOk) {
    const probeDetail = probe
      ? (probe.error ?? `probe exited with code ${spawned.code}`)
      : 'probe produced no parseable output'
    report.failures.push(
      `Electron runtime SQL probe failed: ${probeDetail}`,
      `Probe exit code: ${spawned.code}`,
      `Detected: ${electronLabel}`,
      `The shared binary does not load under Electron ${ELECTRON_VERSION}.`,
      `Package realpath: ${resolved.packagePath}`,
      `Remediation: re-run \`pnpm install\` to restore the locked ${NATIVE_PACKAGE_VERSION} prebuilds, then retry.`
    )
    if (probe?.closeError) {
      report.failures.push(`Electron probe close error: ${probe.closeError}`)
    }
    if (childLines.length > 0) {
      report.failures.push('child output:', ...childLines)
    }
    return report
  }

  if (probe.version !== ELECTRON_VERSION) {
    report.failures.push(
      `Electron runtime reports ${probe.version}; expected ${ELECTRON_VERSION}.`,
      `Remediation: align the electron devDependency with the locked version, re-run \`pnpm install\`, then retry.`
    )
    return report
  }
  // The observed Electron ABI is informational only (Node-API binary): a
  // mismatch is recorded on the report for diagnostics but never fails it.

  report.ok = true
  report.sqlVerified = true
  return report
}

/** Dispatch entry used by the CLI. */
export function runCheck(effects: Effects, target: 'node' | 'electron'): CheckReport {
  return target === 'node' ? runNodeCheck(effects) : runElectronCheck(effects)
}
