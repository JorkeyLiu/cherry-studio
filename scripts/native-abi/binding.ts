import path from 'node:path'

import { FORGE_META, NATIVE_BINDING_NAME } from './constants'
import type { DirListing, Effects, MarkerSnapshot } from './types'

/**
 * Pure binding-path resolution mirroring the `bindings` package's try-order
 * (`node_modules/.pnpm/bindings@1.5.0/node_modules/bindings/bindings.js`).
 * better-sqlite3 loads its native addon via `require('bindings')('better_sqlite3.node')`,
 * so the first existing candidate is the path that is actually loaded at
 * runtime. Reported by checks as "actual resolved binding path".
 *
 * The legacy `compiled/<version>/<platform>/<arch>` candidate uses the *target
 * runtime's* Node version (`bindings` reads `process.versions.node`), not the
 * better-sqlite3 package version (LOCK-ABI finding B). For the Node target that
 * is the host Node version; for the Electron target it is the embedded Node
 * version the Electron binary reports.
 */
export interface BindingResolutionOpts {
  packagePath: string
  name?: string
  /** Target runtime's Node version for the `compiled/<version>/...` candidate. */
  nodeRuntimeVersion: string
  platform: string
  arch: string
  abi: number
  exists: (p: string) => boolean
  resolve: (p: string) => string | undefined
}

export function bindingCandidatePaths(opts: Omit<BindingResolutionOpts, 'exists' | 'resolve'>): string[] {
  const { packagePath, name = NATIVE_BINDING_NAME, nodeRuntimeVersion, platform, arch, abi } = opts
  const join = (...parts: string[]) => path.join(packagePath, ...parts)
  return [
    // node-gyp's default build output, in the order `bindings` tries it
    join('build', name),
    join('build', 'Debug', name),
    join('build', 'Release', name),
    join('out', 'Debug', name),
    join('Debug', name),
    join('out', 'Release', name),
    join('Release', name),
    join('build', 'default', name),
    // `bindings` uses process.versions.node of the TARGET runtime here.
    join('compiled', nodeRuntimeVersion, platform, arch, name),
    join('addon-build', 'release', 'install-root', name),
    join('addon-build', 'debug', 'install-root', name),
    join('addon-build', 'default', 'install-root', name),
    join('lib', 'binding', `node-v${abi}-${platform}-${arch}`, name)
  ]
}

/** First existing candidate — the path `bindings` would load. */
export function resolveBindingPath(opts: BindingResolutionOpts): string | undefined {
  for (const candidate of bindingCandidatePaths(opts)) {
    if (opts.exists(candidate) && opts.resolve(candidate)) {
      return opts.resolve(candidate)
    }
  }
  return undefined
}

/**
 * All `.forge-meta` marker paths under `<packagePath>/build/<type>/.forge-meta`.
 * ENOENT on the build dir is empty (no markers); any other enumeration failure
 * is returned as an error so the caller can fail the rebuild (finding H).
 */
export function markerPaths(
  packagePath: string,
  listDir: (p: string) => DirListing
): { paths: string[]; errors: string[] } {
  const buildDir = path.join(packagePath, 'build')
  const listing = listDir(buildDir)
  if (!listing.ok) {
    return { paths: [], errors: [listing.error] }
  }
  const out: string[] = []
  for (const entry of listing.entries) {
    if (entry === '.node') {
      continue
    }
    out.push(path.join(buildDir, entry, FORGE_META))
  }
  return { paths: out, errors: [] }
}

/**
 * Capture the marker state before a rebuild (LOCK-ABI-6: "capture marker
 * state"). The captured snapshot is only reported; it never gates anything.
 * A build-dir enumeration failure is returned as an error so the rebuild can
 * fail fast: without enumeration we cannot assert marker safety (finding H).
 */
export function captureMarkers(
  effects: Effects,
  packagePath: string
): { snapshots: MarkerSnapshot[]; errors: string[] } {
  const { paths, errors } = markerPaths(packagePath, effects.listDir)
  const snapshots: MarkerSnapshot[] = []
  for (const p of paths) {
    snapshots.push({ path: p, content: effects.readFile(p) })
  }
  return { snapshots, errors }
}

/**
 * Remove every `.forge-meta` under the package (LOCK-ABI-6). Called after a
 * failed rebuild or failed post-check so no marker can claim success. Node
 * rebuilds never produce a marker, so a successful Node rebuild also removes
 * stale markers left by a previous Electron rebuild.
 *
 * Every removal is bounded by the resolved package path: parent path
 * components are validated within it (symlink / path-escape protected) and the
 * terminal `.forge-meta` is a regular file. A marker path under a regular
 * build artifact (e.g. `build/Makefile/.forge-meta` after a node-gyp build)
 * cannot exist and is a no-op, never an ENOTDIR failure.
 *
 * Returns the failure messages (finding C/H): invalidation failures are
 * observable — the caller fails the rebuild on them instead of silently
 * leaving a marker that could claim success. Absent markers and an absent
 * build dir are not errors; a build-dir enumeration failure is.
 */
export function removeMarkers(effects: Effects, packagePath: string): string[] {
  const errors: string[] = []
  const { paths, errors: enumerationErrors } = markerPaths(packagePath, effects.listDir)
  errors.push(...enumerationErrors)
  for (const p of paths) {
    const err = effects.removeFile(p, packagePath)
    if (err) {
      errors.push(err)
    }
  }
  return errors
}

/**
 * Remove `bin/<platform>-<arch>-<abi>` directories whose ABI differs from
 * `keepAbi`. These dirs are copies created by `@electron/rebuild`; a stale
 * copy for the other ABI is a misleading artifact after a switch.
 *
 * Every removal is bounded by the resolved package path: `removeDir` receives
 * `packagePath` as its boundary and validates the parent chain (including the
 * `bin` component itself) plus the terminal entry within it. A symlinked
 * `bin` resolving outside the package, or a symlinked stale entry pointing
 * outside, is rejected with an observable error — recursive deletion can never
 * reach an external tree through the package path.
 *
 * Returns the removal and enumeration failure messages (finding C/H). An
 * absent optional stale directory (ENOENT) is never an error; only a
 * present-but-unremovable directory or an unreadable `bin/` dir is.
 */
export function removeStaleBinDirs(
  effects: Effects,
  packagePath: string,
  keepAbi: number,
  platform: string,
  arch: string
): string[] {
  const errors: string[] = []
  const binDir = path.join(packagePath, 'bin')
  const listing = effects.listDir(binDir)
  if (!listing.ok) {
    return [`listDir(${binDir}): ${listing.error}`]
  }
  for (const entry of listing.entries) {
    const match = new RegExp(`^${platform}-${arch}-(\\d+)$`).exec(entry)
    if (!match) {
      continue
    }
    const entryAbi = Number(match[1])
    if (entryAbi !== keepAbi) {
      const err = effects.removeDir(path.join(binDir, entry), packagePath)
      if (err) {
        errors.push(err)
      }
    }
  }
  return errors
}
