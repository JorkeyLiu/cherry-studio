import path from 'node:path'

import { resolveBindingPath } from './binding'
import {
  ELECTRON_ABI,
  ELECTRON_ARCH,
  ELECTRON_PLATFORM,
  ELECTRON_VERSION,
  NATIVE_BINDING_NAME,
  NATIVE_PACKAGE,
  NATIVE_PACKAGE_VERSION,
  NODE_ABI,
  NODE_MIN_VERSION,
  PROBE_MARKER
} from './constants'
import type { CheckReport, Effects, ElectronProbeOutput } from './types'
import { isAtLeast } from './versions'

const REPAIR_NODE = 'pnpm native:rebuild:node'
const REPAIR_ELECTRON = 'pnpm native:rebuild:electron'

/** Parse the probe JSON line emitted by `probe.cjs` from child stdout. */
export function parseProbeOutput(stdout: string): ElectronProbeOutput | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(PROBE_MARKER)) {
      continue
    }
    const json = trimmed.slice(PROBE_MARKER.length).trim()
    try {
      return JSON.parse(json) as ElectronProbeOutput
    } catch {
      return undefined
    }
  }
  return undefined
}

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
 * Enforce the locked better-sqlite3 version (finding A). Returns a failure
 * message when the resolved package version differs from the locked
 * `NATIVE_PACKAGE_VERSION`, or undefined on match. The failure deliberately
 * provides dependency remediation (`package.json` + `pnpm install`) and never
 * claims a native rebuild can repair a dependency-version mismatch.
 */
export function verifyPackageVersion(effects: Effects, packagePath: string): string | undefined {
  const actual = packageVersion(effects, packagePath)
  if (actual === NATIVE_PACKAGE_VERSION) {
    return undefined
  }
  return [
    `better-sqlite3 resolved version ${actual || 'unknown'} does not match the locked ${NATIVE_PACKAGE_VERSION} (package realpath: ${packagePath}).`,
    'This is a dependency-version mismatch; a native rebuild cannot repair it.',
    `Remediation: pin "better-sqlite3": "${NATIVE_PACKAGE_VERSION}" in package.json, re-run \`pnpm install\`, then retry this command.`
  ].join('\n')
}

function bindingPathFor(
  effects: Effects,
  packagePath: string,
  opts: { platform: string; arch: string; abi: number; nodeRuntimeVersion: string }
): string | undefined {
  return resolveBindingPath({
    packagePath,
    name: NATIVE_BINDING_NAME,
    nodeRuntimeVersion: opts.nodeRuntimeVersion,
    platform: opts.platform,
    arch: opts.arch,
    abi: opts.abi,
    exists: effects.exists,
    resolve: effects.resolveFilePath
  })
}

/** Check the better-sqlite3 binding against the Node runtime (in-process). */
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
    markerState: 'ignored',
    sqlVerified: false,
    failures: [],
    repairCommand: REPAIR_NODE
  }

  const runtimeLabel = `node ${info.nodeVersion} (ABI ${info.modulesAbi}, ${info.platform}/${info.arch})`
  if (!isAtLeast(info.nodeVersion, NODE_MIN_VERSION)) {
    report.failures.push(
      `Unsupported Node runtime: ${runtimeLabel}; repository requires >= ${NODE_MIN_VERSION} (see .node-version).`,
      `The better-sqlite3 binding is not compiled for this Node runtime.`,
      `Run the command with a supported Node24 binary on PATH, then: ${REPAIR_NODE}`
    )
    return report
  }
  if (info.modulesAbi !== NODE_ABI) {
    report.failures.push(
      `Node ABI ${info.modulesAbi} detected (expected ${NODE_ABI}) for runtime ${runtimeLabel}.`,
      `The better-sqlite3 binding is not built for this Node runtime.`,
      `Run with a supported Node24 (ABI ${NODE_ABI}) on PATH, then: ${REPAIR_NODE}`
    )
    return report
  }

  const resolved = resolvePackage(effects)
  if (!resolved.packagePath) {
    report.failures.push(resolved.failure ?? 'package resolution failed')
    return report
  }
  report.packagePath = resolved.packagePath
  report.bindingPath = bindingPathFor(effects, resolved.packagePath, {
    platform: info.platform,
    arch: info.arch,
    abi: NODE_ABI,
    nodeRuntimeVersion: info.nodeVersion
  })

  const versionFailure = verifyPackageVersion(effects, resolved.packagePath)
  if (versionFailure) {
    report.failures.push(versionFailure)
    report.repairCommand = undefined
    return report
  }

  // LOCK-ABI-2: only a real Database(':memory:') + select 1 + close proves success.
  const probe = effects.probeNodeBinding()
  report.probeCloseError = probe.closeError
  if (!probe.sqlOk) {
    report.failures.push(
      `better-sqlite3 runtime SQL probe failed: ${probe.error ?? 'unknown error'}`,
      `The binding does not load under ${runtimeLabel} (likely compiled for Electron ABI ${ELECTRON_ABI}).`,
      `Package realpath: ${resolved.packagePath}`,
      `Resolved binding path: ${report.bindingPath ?? '(none found)'}`,
      `Repair: ${REPAIR_NODE}`
    )
    // Finding H: a close error is surfaced alongside the primary probe error
    // (never replacing it); when the close error is itself the only failure it
    // is already the primary error message above.
    if (probe.closeError && probe.error !== `Database close failed: ${probe.closeError}`) {
      report.failures.push(`Node probe close error: ${probe.closeError}`)
    }
    return report
  }

  report.ok = true
  report.sqlVerified = true
  return report
}

/** Check the better-sqlite3 binding against the installed Electron runtime. */
export function runElectronCheck(effects: Effects): CheckReport {
  const info = effects.runtimeInfo()
  const report: CheckReport = {
    target: 'electron',
    ok: false,
    runtimeName: 'electron',
    // Expected locked facts; overwritten by probe-detected facts when available.
    runtimeVersion: ELECTRON_VERSION,
    abi: ELECTRON_ABI,
    platform: ELECTRON_PLATFORM,
    arch: ELECTRON_ARCH,
    markerState: 'ignored',
    sqlVerified: false,
    failures: [],
    repairCommand: REPAIR_ELECTRON
  }

  const hostLabel = `host node ${info.nodeVersion} (ABI ${info.modulesAbi}, ${info.platform}/${info.arch})`
  if (info.platform !== ELECTRON_PLATFORM || info.arch !== ELECTRON_ARCH) {
    report.failures.push(
      `Electron native checks are currently supported on ${ELECTRON_PLATFORM} ${ELECTRON_ARCH} only; detected ${info.platform} ${info.arch}.`,
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
  // Best-effort candidate before the probe (embedded Node version unknown yet).
  report.bindingPath = bindingPathFor(effects, resolved.packagePath, {
    platform: ELECTRON_PLATFORM,
    arch: ELECTRON_ARCH,
    abi: ELECTRON_ABI,
    nodeRuntimeVersion: info.nodeVersion
  })

  const installed = effects.electronVersion()
  if (installed !== ELECTRON_VERSION) {
    report.failures.push(
      `Installed Electron ${installed ?? 'unknown'} does not match expected ${ELECTRON_VERSION}.`,
      `Align the electron devDependency with the locked version before checking.`,
      `Package realpath: ${resolved.packagePath}`,
      `Resolved binding path: ${report.bindingPath ?? '(none found)'}`
    )
    return report
  }
  const bin = effects.electronBinPath()
  if (!bin) {
    report.failures.push(
      `Electron executable not found; run \`pnpm install\`.`,
      `Package realpath: ${resolved.packagePath}`,
      `Resolved binding path: ${report.bindingPath ?? '(none found)'}`
    )
    return report
  }

  const versionFailure = verifyPackageVersion(effects, resolved.packagePath)
  if (versionFailure) {
    report.failures.push(versionFailure)
    report.repairCommand = undefined
    return report
  }

  const spawned = effects.spawnElectronProbe(bin, effects.probePath())
  // Preserve child stdout/stderr, the exit code, and any close error explicitly
  // in the structured report (finding H) — never only buried in free text.
  const childLines = [spawned.stdout.trim(), spawned.stderr.trim()].filter(Boolean)
  report.probeExitCode = spawned.code

  const probe = parseProbeOutput(spawned.stdout) ?? parseProbeOutput(spawned.stderr)
  // Surface the probe's runtime facts and the resolved binding path even when
  // it failed (finding E) — the embedded Node version is the correct value for
  // the `compiled/<version>/...` candidate under Electron.
  if (probe) {
    report.runtimeVersion = probe.version
    report.abi = probe.abi
    report.platform = probe.platform
    report.arch = probe.arch
    report.nodeVersion = probe.nodeVersion
    report.probeCloseError = probe.closeError
  }
  report.bindingPath = bindingPathFor(effects, resolved.packagePath, {
    platform: probe?.platform ?? ELECTRON_PLATFORM,
    arch: probe?.arch ?? ELECTRON_ARCH,
    abi: probe?.abi ?? ELECTRON_ABI,
    nodeRuntimeVersion: probe?.nodeVersion ?? info.nodeVersion
  })

  const electronLabel = probe
    ? `Electron ${probe.version} (embedded node ${probe.nodeVersion}, ABI ${probe.abi}, ${probe.platform}/${probe.arch})`
    : `Electron ${ELECTRON_VERSION} (expected ABI ${ELECTRON_ABI}, ${ELECTRON_PLATFORM}/${ELECTRON_ARCH})`
  if (spawned.code !== 0 || !probe || !probe.ok || !probe.sqlOk) {
    const probeDetail = probe
      ? (probe.error ?? `probe exited with code ${spawned.code}`)
      : 'probe produced no parseable output'
    report.failures.push(
      `Electron runtime SQL probe failed: ${probeDetail}`,
      `Probe exit code: ${spawned.code}`,
      `Detected: ${electronLabel}`,
      `The binding does not load under Electron ${ELECTRON_VERSION} (likely compiled for Node ABI ${NODE_ABI}).`,
      `Package realpath: ${resolved.packagePath}`,
      `Resolved binding path: ${report.bindingPath ?? '(none found)'}`,
      `Repair: ${REPAIR_ELECTRON}`
    )
    // Finding H: a probe close error is always surfaced as its own line.
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
      `Resolved binding path: ${report.bindingPath ?? '(none found)'}`,
      `Repair: ${REPAIR_ELECTRON}`
    )
    return report
  }
  if (probe.abi !== ELECTRON_ABI) {
    report.failures.push(
      `Electron runtime ABI ${probe.abi}; expected ${ELECTRON_ABI}.`,
      `Resolved binding path: ${report.bindingPath ?? '(none found)'}`,
      `Repair: ${REPAIR_ELECTRON}`
    )
    return report
  }

  report.ok = true
  report.sqlVerified = true
  return report
}

/** Dispatch entry used by the CLI and the post-rebuild self-check. */
export function runCheck(effects: Effects, target: 'node' | 'electron'): CheckReport {
  return target === 'node' ? runNodeCheck(effects) : runElectronCheck(effects)
}
