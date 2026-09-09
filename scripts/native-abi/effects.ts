import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { NATIVE_PACKAGE, PROBE_MARKER, PROBE_MARKER_ENV, PROBE_MODULE_ENV, PROBE_TEST_SEAM_ENV } from './constants'
import type { DirListing, Effects, ProbeResult, SpawnResult } from './types'

/**
 * Real I/O wiring for the native ABI tool. All side effects are confined here
 * so the command logic (`check.ts` / `rebuild.ts`) stays deterministic and is
 * unit-testable with faithful fakes in the scripts Vitest project.
 */

const require_ = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
export const PROBE_PATH = path.join(here, 'probe.cjs')

function probeNodeBindingInChild(): ProbeResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NATIVE_ABI_PROBE_MARKER: PROBE_MARKER
  }
  const result = spawnSync(process.execPath, [PROBE_PATH], { encoding: 'utf8', env })
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(`${PROBE_MARKER} `))
  if (!line) {
    return {
      ok: false,
      sqlOk: false,
      error: `Node probe produced no parseable output (exit ${result.status ?? 1})`
    }
  }
  try {
    const record = JSON.parse(line.slice(PROBE_MARKER.length).trim()) as {
      ok?: unknown
      sqlOk?: unknown
      error?: unknown
      closeError?: unknown
    }
    return {
      ok: record.ok === true,
      sqlOk: record.sqlOk === true,
      error: typeof record.error === 'string' ? record.error : undefined,
      closeError: typeof record.closeError === 'string' ? record.closeError : undefined
    }
  } catch (error) {
    return {
      ok: false,
      sqlOk: false,
      error: `Node probe output was invalid: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** Minimal better-sqlite3 surface the in-process Node probe relies on. */
interface ProbeDatabase {
  prepare(sql: string): { get(): { ok: number } | undefined }
  close(): void
}

function readFileUtf8(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function listDir(p: string): DirListing {
  try {
    return { ok: true, entries: fs.readdirSync(p) }
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') {
      // An absent directory is the same as an empty one (finding H): optional
      // stale dirs / the marker build dir must never fail solely for absence.
      return { ok: true, entries: [] }
    }
    // Every other enumeration failure is observable. Treating it as an empty
    // dir would let marker/stale-bin cleanup silently claim success, so the
    // error is returned and the caller fails the rebuild on it.
    return { ok: false, error: `listDir(${p}): ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** errno code from a Node fs error, if any. */
function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    return (err as NodeJS.ErrnoException).code
  }
  return undefined
}

/** True when `p` is `boundary` itself or nested under it (path-escape check). */
function isWithin(p: string, boundary: string): boolean {
  const rel = path.relative(boundary, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Result of validating the parent chain of a removal target.
 * `{ ok: false; absent: true }` means the chain breaks on a missing or
 * non-directory component, so the terminal cannot exist and removal is a no-op
 * (ENOENT/ENOTDIR tolerance).
 */
type ParentCheck = { ok: true } | { ok: false; absent: true } | { ok: false; absent: false; error: string }

/**
 * Validate every parent path component of `target` from `boundary` downward
 * (`boundary` is the resolved package realpath). Symlink components are
 * resolved and must stay within the boundary; the terminal marker path itself
 * is a leaf that may be a regular file and is deliberately NOT traversed as a
 * directory (the post-rebuild ENOTDIR regression: node-gyp leaves regular
 * files like `Makefile` / `config.gypi` in `build/`, and `markerPaths`
 * enumerates them as if they were marker subdirectories).
 *
 * Returns `{ ok: true }` when every parent component is a real in-boundary
 * directory; `{ ok: false, absent: true }` when a component is missing
 * (ENOENT) or a regular file (ENOTDIR) so the terminal cannot exist (a no-op
 * removal, matching `rmSync(force)` absence tolerance); and an observable
 * error for path escapes, unresolvable symlinks, or permission failures.
 *
 * `label` prefixes the error messages so the reporting operation names itself
 * (`removeFile` / `removeDir`) without duplicating the traversal logic.
 */
function checkParentWithin(target: string, boundary: string, label = 'removeFile'): ParentCheck {
  const rel = path.relative(boundary, target)
  if (rel === '') {
    return { ok: true }
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      absent: false,
      error: `${label}(${target}): path escapes the package boundary ${boundary}`
    }
  }
  let cur = boundary
  for (const part of rel.split(path.sep)) {
    if (!part) {
      continue
    }
    cur = path.join(cur, part)
    let st: fs.Stats
    try {
      st = fs.lstatSync(cur)
    } catch (err) {
      const code = errnoCode(err)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Missing or non-directory parent component: the terminal cannot exist.
        return { ok: false, absent: true }
      }
      return {
        ok: false,
        absent: false,
        error: `${label}(${cur}): ${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (st.isSymbolicLink()) {
      try {
        const resolved = fs.realpathSync(cur)
        if (!isWithin(resolved, boundary)) {
          return {
            ok: false,
            absent: false,
            error: `${label}(${cur}): symlink escapes the package boundary ${boundary}`
          }
        }
        cur = resolved
      } catch (err) {
        return {
          ok: false,
          absent: false,
          error: `${label}(${cur}): cannot resolve symlink: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    } else if (!st.isDirectory()) {
      // Regular file at a parent position: the marker path cannot exist.
      return { ok: false, absent: true }
    }
  }
  return { ok: true }
}

/**
 * Resolve a usable node-gyp.js entry. Preference order:
 *  1. node-gyp from the `@electron/rebuild` dependency tree (locked in the
 *     pnpm store, resolved via realpath — no hardcoded `.pnpm` path);
 *  2. the node-gyp bundled with the verified Node runtime's npm
 *     (`<prefix>/lib/node_modules/npm/node_modules/node-gyp`).
 * Returns undefined only when neither is present.
 */
function resolveNodeGypJs(execPath: string): string | undefined {
  const candidates: string[] = []
  try {
    // Resolve the @electron/rebuild main entry (its exports map does not
    // expose ./package.json), then resolve node-gyp from its dep tree.
    const electronRebuildEntry = require_.resolve('@electron/rebuild')
    const electronRebuildDir = path.dirname(electronRebuildEntry)
    candidates.push(require_.resolve('node-gyp/bin/node-gyp.js', { paths: [electronRebuildDir] }))
  } catch {
    // fall through to npm-bundled candidates below
  }
  const binDir = path.dirname(execPath)
  candidates.push(
    path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(binDir, 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  )
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate
    }
  }
  return undefined
}

/** Derive the Node install dir (for node-gyp `--nodedir`) from the verified execPath. */
function nodeDirFromExecPath(execPath: string): string | undefined {
  // nvm-style layout: <prefix>/bin/node -> <prefix>/include/node
  const prefix = path.dirname(path.dirname(execPath))
  const include = path.join(prefix, 'include', 'node')
  if (exists(path.join(include, 'node.h'))) {
    return prefix
  }
  return undefined
}

/**
 * Every npm/node-gyp variable that can redirect the build target away from
 * the verified Node24 runtime (LOCK-ABI-5/7). node-gyp reads the lowercase
 * `npm_config_*` forms; npm also honors the `NPM_CONFIG_*` uppercase form
 * (case-insensitive). The plain forms (`runtime`, `target`, `nodedir`, …)
 * are honored by several legacy gyp toolchains and electron-builder helpers
 * and are stripped as well. `arch`/`platform` are re-supplied below from the
 * verified runtime facts, so an inherited conflicting value can never win.
 * Proxy/compiler variables (HTTP(S)_PROXY, CC, CXX, LDFLAGS, …) are NOT
 * target-affecting and are deliberately preserved for the source build.
 */
const NODE_GYP_TARGET_VARS = [
  'runtime',
  'target',
  'target_arch',
  'arch',
  'target_platform',
  'platform',
  'dist_url',
  'disturl',
  'nodedir',
  'node_dir',
  'devdir',
  'electron_version',
  'electron_mirror',
  'electron_custom_dir',
  'build_from_source',
  'build_from_source_forced'
] as const

/**
 * Build the child environment for the Node source build: the inherited env
 * minus every target-affecting npm/node-gyp variable (lowercase npm_config,
 * uppercase NPM_CONFIG, and plain forms), then the controlled verified
 * arch/platform facts re-injected. This makes an inherited
 * `npm_config_runtime=electron` / `npm_config_target=…` / `npm_config_nodedir=…`
 * / `NPM_CONFIG_DIST_URL=…` / `build_from_source` (and every common variant)
 * unable to influence the Node24 ABI137 build. Exported so the faithful env
 * contract is unit-testable without a subprocess.
 */
export function sanitizeNodeGypEnv(env: NodeJS.ProcessEnv, arch: string, platform: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const name of NODE_GYP_TARGET_VARS) {
    delete out[name]
    delete out[`npm_config_${name}`]
    delete out[`NPM_CONFIG_${name.toUpperCase()}`]
    // node-gyp / npm accept hyphens in place of underscores for some legacy keys.
    delete out[`npm_config_${name.replace(/_/g, '-')}`]
    delete out[`NPM_CONFIG_${name.replace(/_/g, '-').toUpperCase()}`]
  }
  // Re-inject the verified target facts (LOCK-ABI-5/7). node-gyp prefers the
  // explicit CLI args, these env values are the controlled fallback.
  out.npm_config_arch = arch
  out.npm_config_target_arch = arch
  out.npm_config_platform = platform
  out.npm_config_build_from_source = 'true'
  return out
}

export function createEffects(): Effects {
  return {
    runtimeInfo: () => ({
      runtime: 'node',
      nodeVersion: process.versions.node,
      modulesAbi: Number(process.versions.modules),
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath
    }),
    readJson: (p) => JSON.parse(fs.readFileSync(p, 'utf8')) as unknown,
    readFile: (p) => readFileUtf8(p),
    realpath: (p) => fs.realpathSync(p),
    exists,
    listDir,
    removeFile: (p, boundary) => {
      // Parent components must be real directories inside the resolved package
      // boundary; the terminal marker path is a leaf that may be a regular
      // file (never traversed as a directory). ENOENT and ENOTDIR-from-a-file
      // parent both mean "nothing to remove". Directories are removeDir's job.
      if (boundary) {
        const check = checkParentWithin(path.dirname(p), boundary)
        if (!check.ok) {
          if (check.absent) {
            return undefined
          }
          return check.error
        }
      }
      let st: fs.Stats
      try {
        st = fs.lstatSync(p)
      } catch (err) {
        const code = errnoCode(err)
        // ENOENT: nothing to remove. ENOTDIR at the leaf: a parent component
        // is a regular file, so the marker cannot exist. Both are the absent
        // marker case (rmSync(force) semantics), never an error.
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return undefined
        }
        return `removeFile(${p}): ${err instanceof Error ? err.message : String(err)}`
      }
      if (st.isDirectory()) {
        return `removeFile(${p}): refusing to remove a directory (use removeDir)`
      }
      if (st.isSymbolicLink() && boundary) {
        // A terminal symlink must not point outside the package boundary.
        // A dangling link has no target to escape through, so the link itself
        // may be unlinked.
        try {
          const resolved = fs.realpathSync(p)
          if (!isWithin(resolved, boundary)) {
            return `removeFile(${p}): symlink escapes the package boundary ${boundary}`
          }
        } catch {
          // dangling symlink — no escape possible
        }
      }
      try {
        fs.unlinkSync(p)
        return undefined
      } catch (err) {
        // Observable invalidation failure (finding C): the caller fails the
        // rebuild on it instead of silently leaving a misleading marker.
        return `removeFile(${p}): ${err instanceof Error ? err.message : String(err)}`
      }
    },
    removeDir: (p, boundary) => {
      // Same boundary contract as removeFile: every parent path component must
      // be a real in-boundary directory. This is what stops a symlinked `bin`
      // resolving outside the package: the `bin` component resolves out of the
      // boundary and the recursive deletion is rejected before it can reach
      // the external tree. ENOENT and ENOTDIR-from-a-file parents both mean
      // "nothing to remove".
      if (boundary) {
        const check = checkParentWithin(path.dirname(p), boundary, 'removeDir')
        if (!check.ok) {
          if (check.absent) {
            return undefined
          }
          return check.error
        }
        // The terminal directory itself must not be a symlink escaping the
        // package. `fs.rmSync(recursive)` unlinks a top-level symlink without
        // following it, so the external target is never deleted — but a
        // symlinked stale bin entry pointing outside must still be rejected
        // (observable) rather than silently unlinked. A dangling link has no
        // target to escape through, so it is removable.
        let st: fs.Stats
        try {
          st = fs.lstatSync(p)
        } catch (err) {
          const code = errnoCode(err)
          // ENOENT: nothing to remove. ENOTDIR: a parent component is a
          // regular file, so the target cannot exist. Both are the absent
          // case (rmSync(force) semantics).
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return undefined
          }
          return `removeDir(${p}): ${err instanceof Error ? err.message : String(err)}`
        }
        if (st.isSymbolicLink()) {
          try {
            const resolved = fs.realpathSync(p)
            if (!isWithin(resolved, boundary)) {
              return `removeDir(${p}): symlink escapes the package boundary ${boundary}`
            }
          } catch {
            // dangling symlink — no escape possible
          }
        }
      }
      try {
        // fs.rmSync(recursive) never follows symlinks: nested links inside the
        // tree are unlinked, never traversed, so recursive deletion cannot
        // escape through them. The only external reach is the boundary-validated
        // parent chain above. A TOCTOU window between the validation and this
        // removal (the directory swapped for an out-of-boundary symlink) is
        // accepted as a residual limitation of the synchronous Node fs APIs.
        fs.rmSync(p, { recursive: true, force: true })
        return undefined
      } catch (err) {
        // Observable invalidation failure (finding C): the caller fails the
        // rebuild on it instead of silently leaving a misleading artifact.
        return `removeDir(${p}): ${err instanceof Error ? err.message : String(err)}`
      }
    },
    resolvePackageJsonPath: (pkg) => {
      try {
        return require_.resolve(`${pkg}/package.json`)
      } catch {
        return undefined
      }
    },
    resolveFilePath: (spec) => {
      try {
        return require_.resolve(spec)
      } catch {
        return undefined
      }
    },
    probeNodeBinding: () => {
      // Windows keeps loaded .node files locked. Probe in a short-lived child
      // there so the parent can switch from Node ABI 137 to Electron ABI 145
      // during lane finalization without an EPERM unlink failure.
      if (process.platform === 'win32') {
        return probeNodeBindingInChild()
      }
      // Finding D/H: the Database is always closed (finally) and both the primary
      // probe error and any close error are preserved; a failed close is a
      // resource leak and therefore a failed probe.
      let db: ProbeDatabase | null = null
      let primaryError: string | undefined
      let closeError: string | undefined
      let sqlOk = false
      try {
        // Dynamic require from the tool's location walks up to the repo
        // node_modules and loads the same binding the app loads at runtime.
        const Database = require_(NATIVE_PACKAGE) as new (file: string) => ProbeDatabase
        db = new Database(':memory:')
        const row = db.prepare('select 1 as ok').get()
        sqlOk = !!(row && row.ok === 1)
        if (!sqlOk) {
          primaryError = 'SQL probe returned an unexpected row'
        }
      } catch (err) {
        primaryError = err instanceof Error ? err.message : String(err)
      } finally {
        if (db) {
          try {
            db.close()
          } catch (err) {
            closeError = err instanceof Error ? err.message : String(err)
          }
        }
      }
      if (primaryError || closeError) {
        return {
          ok: false,
          sqlOk: false,
          error: primaryError ?? `Database close failed: ${closeError}`,
          closeError: closeError || undefined
        }
      }
      return { ok: true, sqlOk: true }
    },
    electronBinPath: () => {
      try {
        // require('electron') returns the executable path when required from a
        // plain Node process (macOS: dist/Electron.app/Contents/MacOS/Electron).
        return require_('electron') as string
      } catch {
        return undefined
      }
    },
    electronVersion: () => {
      try {
        const pkg = require_('electron/package.json') as { version?: string }
        return pkg.version
      } catch {
        return undefined
      }
    },
    spawnElectronProbe: (bin, probePath): SpawnResult => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        [PROBE_MARKER_ENV]: PROBE_MARKER
      }
      // LOCK-ABI-2 hardening: the production probe proof can never be
      // redirected by an inherited environment. Delete the test stub module
      // override AND the explicit test-seam gate before spawning — the probe
      // hardcodes the real resolved package contract in production mode and
      // the direct subprocess test seam stays reachable only through an
      // explicit test helper invocation.
      delete env[PROBE_MODULE_ENV]
      delete env[PROBE_TEST_SEAM_ENV]
      const res = spawnSync(bin, [probePath], {
        encoding: 'utf8',
        env
      })
      return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
    },
    pnpmVersion: () => {
      // Windows package-manager shims are .cmd files, which Node cannot spawn
      // directly without a shell. Use cmd.exe only for this version probe so
      // the lane validates the same pnpm command users invoke from a terminal.
      const command = process.platform === 'win32' ? 'cmd.exe' : 'pnpm'
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm --version'] : ['--version']
      const res = spawnSync(command, args, { encoding: 'utf8' })
      if (res.status !== 0) {
        return undefined
      }
      return (res.stdout ?? '').trim()
    },
    nodeGypJsPath: () => resolveNodeGypJs(process.execPath),
    nodeDir: (execPath) => nodeDirFromExecPath(execPath),
    runNodeGyp: ({ packagePath, nodeGypJs, execPath, nodeDir, arch, platform }) => {
      // LOCK-ABI-5/7: controlled target args — explicit `--nodedir` (the
      // verified Node's own headers, offline-safe exact ABI match),
      // `--arch`/`--platform` from the verified runtime facts, and
      // `--build-from-source`. The child env is sanitized so no inherited
      // npm/node-gyp target override can drift the build.
      const args = [
        nodeGypJs,
        'rebuild',
        '--build-from-source',
        `--arch=${arch}`,
        `--nodedir=${nodeDir}`,
        `--platform=${platform}`
      ]
      const res = spawnSync(execPath, args, {
        cwd: packagePath,
        encoding: 'utf8',
        env: sanitizeNodeGypEnv(process.env, arch, platform)
      })
      return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
    },
    rebuildElectron: async (opts) => {
      const logs: string[] = []
      try {
        const mod = (await import('@electron/rebuild')) as {
          rebuild: (
            o: typeof opts & { projectRootPath: string }
          ) => Promise<void> & { lifecycle?: { on: (e: string, cb: (name?: string) => void) => void } }
        }
        const ret = mod.rebuild(opts)
        ret.lifecycle?.on('module-found', (name) => logs.push(`module-found: ${name}`))
        ret.lifecycle?.on('module-done', (name) => logs.push(`module-done: ${name}`))
        ret.lifecycle?.on('module-skip', (name) => logs.push(`module-skip: ${name}`))
        await ret
        return { ok: true, logs }
      } catch (err) {
        return { ok: false, logs, error: err instanceof Error ? err.message : String(err) }
      }
    },
    projectRoot: () => path.resolve(here, '..', '..'),
    probePath: () => PROBE_PATH
  }
}
