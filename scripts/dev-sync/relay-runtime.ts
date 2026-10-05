/**
 * Isolated relay runtime for `pnpm dev:sync`.
 *
 * The repository root better-sqlite3 binding serves exactly one ABI lane at a
 * time (Node 137 vs Electron 145), so the dev relay cannot run from the root
 * install while `electron-vite dev` holds the Electron lane. Instead each run
 * mirrors ONLY the relay sources plus the shared sync contracts plus the
 * existing `deploy/sync-relay` install manifest/lock into
 * `local/dev-sync/relay-runtime` (same relative layout the Docker image
 * uses) and installs its independent dependency cache there
 * (`--prod --frozen-lockfile`, only when new or mismatched). The relay then
 * runs under plain pinned Node with its OWN binding: no root ABI switch, no
 * rebuild, no lock bypass.
 *
 * Each command re-mirrors newer sources; the per-session relay DB under
 * `sessions/<session-id>/relay-data` is never rewritten by the mirror step.
 * There is no shared access token: the relay authenticates per-device
 * code+secret pairs it generates itself at registration time.
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { DEV_SYNC_DEFAULT_RELAY_HOST, DEV_SYNC_RELAY_DB_FILE } from './constants'

export interface RelayCopyPair {
  from: string
  to: string
}

/**
 * Pure mirror plan: relay sources + shared sync contracts + the existing
 * deploy manifest/lock, laid out exactly like the repository (so the relay's
 * relative `../../packages/shared/...` imports keep working). Never includes
 * the root install, the Electron app, or any production profile.
 */
export function relayMirrorPlan(repoRoot: string, runtimeDir: string): RelayCopyPair[] {
  return [
    { from: join(repoRoot, 'scripts', 'sync-relay'), to: join(runtimeDir, 'scripts', 'sync-relay') },
    { from: join(repoRoot, 'packages', 'shared'), to: join(runtimeDir, 'packages', 'shared') },
    { from: join(repoRoot, 'deploy', 'sync-relay', 'package.json'), to: join(runtimeDir, 'package.json') },
    { from: join(repoRoot, 'deploy', 'sync-relay', 'pnpm-lock.yaml'), to: join(runtimeDir, 'pnpm-lock.yaml') }
  ]
}

/** Content hash used to detect a stale relay runtime dependency cache. */
export function hashFileContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * True when the relay runtime cache must be (re)installed: no binding, or the
 * mirrored manifest/lock no longer matches what was installed. Pure decision
 * over injected observations so it is unit-testable.
 */
export function needsRelayInstall(observations: {
  bindingExists: boolean
  installedManifestHash: string | null
  currentManifestHash: string
  installedLockHash: string | null
  currentLockHash: string
}): boolean {
  if (!observations.bindingExists) return true
  if (observations.installedManifestHash !== observations.currentManifestHash) return true
  if (observations.installedLockHash !== observations.currentLockHash) return true
  return false
}

function hashExistingFile(path: string): string | null {
  try {
    return hashFileContent(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Mirror newer sources into the relay runtime and report whether its
 * dependency cache needs a reinstall. Never touches the relay DB.
 */
export function mirrorRelaySources(repoRoot: string, runtimeDir: string): { reinstall: boolean } {
  const manifestFrom = join(repoRoot, 'deploy', 'sync-relay', 'package.json')
  const lockFrom = join(repoRoot, 'deploy', 'sync-relay', 'pnpm-lock.yaml')
  if (!existsSync(manifestFrom) || !existsSync(lockFrom)) {
    throw new Error('[dev-sync] missing deploy/sync-relay manifest/lock; refusing relay startup')
  }
  mkdirSync(runtimeDir, { recursive: true })
  cpSync(join(repoRoot, 'scripts', 'sync-relay'), join(runtimeDir, 'scripts', 'sync-relay'), { recursive: true })
  cpSync(join(repoRoot, 'packages', 'shared'), join(runtimeDir, 'packages', 'shared'), {
    recursive: true,
    // Runtime needs contracts only: skip unit tests to keep the mirror lean.
    filter: (src) => !src.includes('__tests__')
  })
  cpSync(manifestFrom, join(runtimeDir, 'package.json'))
  cpSync(lockFrom, join(runtimeDir, 'pnpm-lock.yaml'))

  const bindingExists = existsSync(join(runtimeDir, 'node_modules', 'better-sqlite3'))
  const reinstall = needsRelayInstall({
    bindingExists,
    installedManifestHash: hashExistingFile(join(runtimeDir, 'node_modules', '.dev-sync-manifest-sha256')),
    currentManifestHash: hashFileContent(readFileSync(join(runtimeDir, 'package.json'), 'utf8')),
    installedLockHash: hashExistingFile(join(runtimeDir, 'node_modules', '.dev-sync-lock-sha256')),
    currentLockHash: hashFileContent(readFileSync(join(runtimeDir, 'pnpm-lock.yaml'), 'utf8'))
  })
  return { reinstall }
}

/** Record the installed manifest/lock hashes after a successful install. */
export function stampRelayInstall(runtimeDir: string): void {
  mkdirSync(join(runtimeDir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(runtimeDir, 'node_modules', '.dev-sync-manifest-sha256'),
    `${hashFileContent(readFileSync(join(runtimeDir, 'package.json'), 'utf8'))}\n`
  )
  writeFileSync(
    join(runtimeDir, 'node_modules', '.dev-sync-lock-sha256'),
    `${hashFileContent(readFileSync(join(runtimeDir, 'pnpm-lock.yaml'), 'utf8'))}\n`
  )
}

export function relayDbPath(relayDataDir: string): string {
  return resolve(join(relayDataDir, DEV_SYNC_RELAY_DB_FILE))
}

/** Safe terminal line for the relay: endpoint only (no shared token exists). */
export function formatRelayEndpointLine(host: string, port: number): string {
  const safeHost = host === '0.0.0.0' ? DEV_SYNC_DEFAULT_RELAY_HOST : host
  return `[dev-sync] relay endpoint: http://${safeHost}:${port} (address + device-code pairing; no shared token)`
}

export function relayEndpointUrl(host: string, port: number): string {
  return `http://${host}:${port}`
}

/** Argv for the relay server entrypoint (address + code pairing only). */
export function buildRelayServerArgs(dbPath: string, host: string, port: number): string[] {
  return ['--host', host, '--port', String(port), '--db', dbPath]
}

/** Resolve the relay server entrypoint inside the mirrored runtime. */
export function relayServerEntry(runtimeDir: string): string {
  const entry = join(runtimeDir, 'scripts', 'sync-relay', 'server.ts')
  if (!existsSync(entry)) {
    throw new Error('[dev-sync] mirrored relay entrypoint missing; mirror step did not run')
  }
  return entry
}
