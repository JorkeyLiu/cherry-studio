import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const RUN_TOKEN_ENV = 'CHERRY_E2E_RUN_TOKEN'
const REGISTRY_PREFIX = 'cherry-e2e-run-registry-'
const REGISTRY_SUFFIX = '.json'
const DISPOSABLE_PROFILE_PREFIX = 'cherry-e2e-'

export function createRunToken(): string {
  return randomUUID()
}

export function getRunRegistryPath(runToken: string, tmpDir = os.tmpdir()): string {
  return path.join(tmpDir, `${REGISTRY_PREFIX}${runToken}${REGISTRY_SUFFIX}`)
}

export function initializeRunRegistry(runToken: string, tmpDir = os.tmpdir()): string {
  const registryPath = getRunRegistryPath(runToken, tmpDir)
  fs.writeFileSync(registryPath, '', 'utf-8')
  return registryPath
}

/**
 * Register one exact disposable owned path (a `--user-data-dir` profile root
 * or any other disposable artifact directory directly under the OS temp dir)
 * for the current run token so global teardown can remove it as a safety net.
 * `cleanupRunRegistry` removes the registered path plus its `Dev` sibling.
 */
export function registerOwnedPath(ownedPath: string, runToken: string, tmpDir = os.tmpdir()): void {
  const registryPath = getRunRegistryPath(runToken, tmpDir)
  fs.appendFileSync(registryPath, `${JSON.stringify(ownedPath)}\n`, 'utf-8')
}

/** Register a disposable `--user-data-dir` profile root (see {@link registerOwnedPath}). */
export function registerOwnedProfile(userDataDir: string, runToken: string, tmpDir = os.tmpdir()): void {
  registerOwnedPath(userDataDir, runToken, tmpDir)
}

function readOwnedProfiles(registryPath: string): string[] {
  const content = fs.readFileSync(registryPath, 'utf-8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter((entry): entry is string => typeof entry === 'string')
}

function isDisposableProfile(userDataDir: string, tmpDir: string): boolean {
  return path.dirname(userDataDir) === tmpDir && path.basename(userDataDir).startsWith(DISPOSABLE_PROFILE_PREFIX)
}

export function cleanupRunRegistry(runToken: string, tmpDir = os.tmpdir()): string[] {
  const registryPath = getRunRegistryPath(runToken, tmpDir)
  const errors: string[] = []

  if (!fs.existsSync(registryPath)) {
    return errors
  }

  try {
    for (const userDataDir of readOwnedProfiles(registryPath)) {
      if (!isDisposableProfile(userDataDir, tmpDir)) {
        errors.push(`Skipping non-disposable path in registry: ${userDataDir}`)
        continue
      }

      for (const dirPath of [userDataDir, `${userDataDir}Dev`]) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: true })
        } catch (err: any) {
          errors.push(`Failed to remove owned path "${dirPath}": ${err.message}`)
        }
      }
    }
  } catch (err: any) {
    errors.push(`Failed to process registry "${registryPath}": ${err.message}`)
  } finally {
    try {
      fs.unlinkSync(registryPath)
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        errors.push(`Failed to remove registry "${registryPath}": ${err.message}`)
      }
    }
  }

  return errors
}

export function getRequiredRunToken(): string {
  const runToken = process.env[RUN_TOKEN_ENV]
  if (!runToken) {
    throw new Error(`Missing ${RUN_TOKEN_ENV}; Playwright global setup did not initialize run ownership`)
  }
  return runToken
}
