import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Per-build application identity (VERSION-003 / VERSION-005).
 *
 * Cherry Chat keeps the manually maintained product version (0.1.0, sourced
 * from root package.json, VERSION-002) as the stable `app.getVersion()`
 * value (VERSION-004). Every build additionally gets a unique, traceable
 * Build ID derived from ONE captured UTC timestamp (millisecond precision, so
 * back-to-back builds in the same wall-clock second stay distinct), a short
 * Git SHA and an optional dirty marker — and a numeric macOS build version
 * (CFBundleVersion) derived from the same timestamp.
 *
 * One build invocation computes the identity ONCE and shares it through the
 * environment (`CHERRY_CHAT_BUILD_ID` / `CHERRY_CHAT_BUILD_VERSION`) to every
 * consumer of that build: the electron-vite compile (electron.vite.config.ts
 * `define`) and the electron-builder packaging (artifactName macro + the
 * beforePack buildVersion hook). No tracked config file is mutated as a build
 * side effect.
 *
 * This module is pure and testable: `buildIdentity()` is deterministic for
 * injected inputs. When Git metadata is unavailable it degrades explicitly to
 * the `nogit` marker instead of claiming a valid SHA.
 */

export const BUILD_ID_ENV = 'CHERRY_CHAT_BUILD_ID'
export const BUILD_VERSION_ENV = 'CHERRY_CHAT_BUILD_VERSION'

/** Explicit marker used when Git metadata is unavailable — never a fabricated SHA. */
export const UNAVAILABLE_SHA_MARKER = 'nogit'

export interface BuildIdentityInput {
  /** Captured UTC timestamp (Date, epoch millis, or ISO string). */
  timestamp: Date | number | string
  /** Short (or full) Git SHA; `null` when Git metadata is unavailable. */
  sha?: string | null
  /** Whether the working tree is dirty. Ignored when `sha` is unavailable. */
  dirty?: boolean
}

export interface BuildIdentity {
  /** UTC timestamp formatted as `YYYYMMDDHHMMSSmmm` (17 digits). */
  utcTimestamp: string
  /** Short Git SHA, or {@link UNAVAILABLE_SHA_MARKER} when unavailable. */
  shortSha: string
  /** True when Git metadata was unavailable and no SHA is claimed. */
  shaUnavailable: boolean
  /** True when the `-dirty` marker is present. */
  dirty: boolean
  /** Filename-safe, per-build unique identifier. */
  buildId: string
  /** Numeric macOS build version (CFBundleVersion-compatible digit string). */
  macBuildVersion: string
}

/**
 * Format a timestamp as UTC `YYYYMMDDHHMMSSmmm`. Always uses UTC fields so the
 * Build ID never depends on the machine-local timezone. The millisecond
 * component keeps Build IDs distinct across builds started within the same
 * wall-clock second (VERSION-003 uniqueness).
 */
export function formatUtcTimestamp(timestamp: Date | number | string): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`build-identity: invalid timestamp input: ${String(timestamp)}`)
  }
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `${pad(date.getUTCMilliseconds(), 3)}`
  )
}

function normalizeShortSha(sha: string | null | undefined): { shortSha: string; unavailable: boolean } {
  const trimmed = (sha ?? '').trim()
  if (trimmed === '') {
    return { shortSha: UNAVAILABLE_SHA_MARKER, unavailable: true }
  }
  return { shortSha: trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed, unavailable: false }
}

/**
 * Pure identity computation. Deterministic for injected inputs: identical
 * inputs always produce an identical Build Identity.
 */
export function buildIdentity(input: BuildIdentityInput): BuildIdentity {
  const utcTimestamp = formatUtcTimestamp(input.timestamp)
  const { shortSha, unavailable } = normalizeShortSha(input.sha)
  const dirty = unavailable ? false : Boolean(input.dirty)
  const buildId = `${utcTimestamp}-${shortSha}${dirty ? '-dirty' : ''}`
  return {
    utcTimestamp,
    shortSha,
    shaUnavailable: unavailable,
    dirty,
    buildId,
    macBuildVersion: utcTimestamp
  }
}

export interface GitMetadata {
  sha: string | null
  dirty: boolean
}

/**
 * Read the short Git SHA and working-tree dirty status. Returns `{ sha: null,
 * dirty: false }` when Git metadata is unavailable (not a repo, no commits,
 * git missing) — the caller then degrades explicitly.
 */
export function collectGitMetadata(): GitMetadata {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (sha === '') {
      return { sha: null, dirty: false }
    }
    let dirty = false
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      dirty = status.trim() !== ''
    } catch {
      dirty = false
    }
    return { sha, dirty }
  } catch {
    return { sha: null, dirty: false }
  }
}

/** Compute the identity for the current build invocation. */
export function currentBuildIdentity(): BuildIdentity {
  const { sha, dirty } = collectGitMetadata()
  return buildIdentity({ timestamp: new Date(), sha, dirty })
}

/**
 * Environment bridge sharing one build identity with every consumer in the
 * build invocation (electron-vite compile + electron-builder packaging).
 */
export function buildEnv(identity: BuildIdentity): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [BUILD_ID_ENV]: identity.buildId,
    [BUILD_VERSION_ENV]: identity.macBuildVersion
  }
}

export interface SpawnResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Spawn the packaging command with the build identity environment applied.
 * Uses a shell so multi-command chains (`npm run build && electron-builder …`)
 * keep the same identity. `inheritStdio` keeps live build output in real
 * builds; tests pass `false` to capture the child output.
 */
export function spawnBuildCommand(command: string, identity: BuildIdentity, inheritStdio = true): SpawnResult {
  const result = spawnSync(command, {
    shell: true,
    env: buildEnv(identity),
    stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })
  return {
    status: result.status ?? (result.error != null ? 1 : 0),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

/** CLI: `--print` (debug) or `--spawn "<build command>"` (wrap a build). */
export function main(argv: string[]): number {
  const [flag, value] = argv

  if (flag === '--print') {
    process.stdout.write(`${JSON.stringify(currentBuildIdentity(), null, 2)}\n`)
    return 0
  }

  if (flag === '--spawn' && value != null && value !== '') {
    const identity = currentBuildIdentity()
    console.log(
      `[build-identity] buildId=${identity.buildId} macBuildVersion=${identity.macBuildVersion} ` +
        `shaUnavailable=${identity.shaUnavailable} dirty=${identity.dirty}`
    )
    return spawnBuildCommand(value, identity).status
  }

  process.stderr.write('Usage: build-identity.ts --print | --spawn "<build command>"\n')
  return 2
}

// CLI entry when executed directly (`tsx scripts/build-identity.ts …`); inert
// when imported (electron.vite.config.ts, vitest).
const entry = process.argv[1]
if (entry != null && fileURLToPath(import.meta.url) === resolve(entry)) {
  process.exitCode = main(process.argv.slice(2))
}
