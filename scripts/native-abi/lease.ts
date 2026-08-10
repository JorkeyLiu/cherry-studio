/**
 * Inherited native ABI lane lease (Phase 1 of the Native ABI Runtime Lane
 * refactor).
 *
 * A lane's guarantee must survive process boundaries: when the runner spawns a
 * lane child command (and that child spawns further commands), every process
 * in the lane inherits the environment carrying the lane lease — the lock
 * owner metadata (PID, token, lane, checkout root, timestamp) of the
 * outermost acquisition. `validateLease` is the checkpoint a nested lane uses
 * to prove it is running under the same checkout/acquisition before acting;
 * an absent, malformed, version-mismatched, checkout-mismatched, or
 * token-mismatched lease is rejected explicitly (LOCK-001: never inferred
 * from directories, tests, imports, or module graphs).
 *
 * This module is pure (no I/O seam) — it only reads/writes the lease
 * environment contract, so it is deterministically unit-testable.
 */

import type { LockOwner } from './lock'
import { parseLockOwner } from './lock'

/** Env var carrying the serialized lane lease (single source, atomic JSON). */
export const LEASE_ENV_NAME = 'NATIVE_ABI_LEASE'

/** Lease schema version. */
export const LEASE_VERSION = 1

/** The lane lease: the lock owner of the outermost lane acquisition. */
export interface LaneLease {
  version: 1
  owner: LockOwner
}

/** Result of parsing a raw lease payload with failure discrimination. */
export type LeaseParseResult =
  | { ok: true; lease: LaneLease }
  | { ok: false; reason: 'malformed' | 'version'; detail?: string }

/** Serialize a lease for the environment. */
export function serializeLease(lease: LaneLease): string {
  return JSON.stringify(lease)
}

/**
 * Parse a raw lease payload. `'malformed'` = not valid JSON / not an object /
 * invalid owner metadata; `'version'` = valid JSON but an unsupported lease
 * schema version (fail-closed: an unknown future schema is never honored).
 */
export function parseLease(content: string): LeaseParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return { ok: false, reason: 'malformed', detail: 'lease is not valid JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed', detail: 'lease is not a JSON object' }
  }
  const r = raw as Record<string, unknown>
  if (r.version !== LEASE_VERSION) {
    return { ok: false, reason: 'version', detail: `lease version ${String(r.version)}; expected ${LEASE_VERSION}` }
  }
  const owner = parseLockOwner(r.owner)
  if (owner === undefined) {
    return { ok: false, reason: 'malformed', detail: 'lease owner metadata is invalid' }
  }
  return { ok: true, lease: { version: LEASE_VERSION, owner } }
}

/** Read the lease an inherited environment carries (undefined when absent/unparseable). */
export function leaseFromEnv(env: NodeJS.ProcessEnv): LaneLease | undefined {
  const raw = env[LEASE_ENV_NAME]
  if (raw === undefined) {
    return undefined
  }
  const result = parseLease(raw)
  return result.ok ? result.lease : undefined
}

/**
 * Return a copy of `env` with `lease` injected (replacing any inherited
 * lease). Every other variable is preserved, so nested lane commands keep the
 * full parent environment plus the lane lease contract. The input is never
 * mutated.
 */
export function withLease(env: NodeJS.ProcessEnv, lease: LaneLease): NodeJS.ProcessEnv {
  return { ...env, [LEASE_ENV_NAME]: serializeLease(lease) }
}

/** Convenience: build the env a lane child receives from a held lock owner. */
export function leaseEnv(env: NodeJS.ProcessEnv, owner: LockOwner): NodeJS.ProcessEnv {
  return withLease(env, { version: LEASE_VERSION, owner })
}

/** Expected lease facts a nested lane must prove before acting. */
export interface LeaseExpectation {
  /** Required checkout root; the inherited lease must match exactly. */
  checkoutRoot?: string
  /** Required acquisition token; the inherited lease must match exactly. */
  token?: string
}

export type LeaseValidation =
  | { ok: true; lease: LaneLease }
  | { ok: false; reason: 'absent' | 'malformed' | 'version' | 'checkout-mismatch' | 'token-mismatch'; detail?: string }

/**
 * Validate the lease an inherited environment carries against the expected
 * checkout/token. Rejection reasons are discriminated so the runner can report
 * precisely why a nested lane is not under its own acquisition:
 * `'absent'` (no lease env), `'malformed'` (unparseable/invalid owner),
 * `'version'` (unsupported schema), `'checkout-mismatch'` (different checkout
 * root), `'token-mismatch'` (different acquisition token).
 */
export function validateLease(env: NodeJS.ProcessEnv, expected: LeaseExpectation = {}): LeaseValidation {
  const raw = env[LEASE_ENV_NAME]
  if (raw === undefined) {
    return { ok: false, reason: 'absent', detail: `${LEASE_ENV_NAME} is not set in the inherited environment` }
  }
  const parsed = parseLease(raw)
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, detail: parsed.detail }
  }
  const { lease } = parsed
  if (expected.checkoutRoot !== undefined && lease.owner.checkoutRoot !== expected.checkoutRoot) {
    return {
      ok: false,
      reason: 'checkout-mismatch',
      detail: `lease checkout ${lease.owner.checkoutRoot}; expected ${expected.checkoutRoot}`
    }
  }
  if (expected.token !== undefined && lease.owner.token !== expected.token) {
    return {
      ok: false,
      reason: 'token-mismatch',
      detail: `lease token ${lease.owner.token} does not match the expected acquisition ${expected.token}`
    }
  }
  return { ok: true, lease }
}
