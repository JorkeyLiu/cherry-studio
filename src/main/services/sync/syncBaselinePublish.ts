/**
 * Publisher barrier envelope builder (SYNC-DATA-025/026/027/032, SYNC-CC-020/021).
 *
 * Transport-free: builds the single client-declared `PUT /sync/baseline`
 * envelope from a barrier-captured local candidate. No relay/network calls,
 * no fence/token/prepare handshake, no IPC/UI.
 *
 * Locked contract enforced here (never reimplemented — the shared strict
 * `baselineWire` validator/canonicalizer/digest decides):
 * - N comes from the barrier same-snapshot proof only: the candidate's
 *   `observedLocalCursor`/`observedLocalChannelKey` (read inside the same
 *   SQLite snapshot as the baseline content) must equal the barrier-held
 *   channel binding and the pre-PUT durable cursor. A locally observed cursor
 *   alone is not proof.
 * - Digest covers only the `payload` object (`jcs-sha256-v1`); the manifest
 *   is recomputed by the shared validator from the validated payload.
 * - The envelope is strictly closed lowerCamelCase keys with `wireVersion`
 *   only outer and the triple only inside `payload.manifest`.
 */

import { createHash } from 'node:crypto'

import {
  DIGEST_SCHEME,
  type SyncEnvelope,
  validateEnvelope,
  ValidationError,
  verifyEnvelopeDigest,
  WIRE_VERSION
} from '@shared/sync'

import type { LocalSyncBaselineCandidate } from './syncBaseline'
import { computeWirePayloadDigest, projectLocalBaselineToWirePayload } from './syncBaselineWireProjection'

export class SyncBaselinePublishError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncBaselinePublishError'
  }
}

function fail(message: string, cause?: unknown): never {
  throw new SyncBaselinePublishError(message, cause === undefined ? undefined : { cause })
}

export interface PublishBarrierSnapshotProof {
  watermarkN: number
  channelId: string
}

/**
 * Assert the barrier same-snapshot proof carried by a captured candidate.
 * The candidate must be `complete` + bound with zero pending outbox, and its
 * snapshot-observed channel/cursor must equal the barrier-held binding and
 * the durable cursor read before the barrier snapshot. Throws
 * `SyncBaselinePublishError` fail-closed otherwise (never PUT).
 */
export function assertBarrierSnapshotProof(
  candidate: LocalSyncBaselineCandidate,
  expectedChannelId: string,
  expectedCursor: number
): PublishBarrierSnapshotProof {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('publish blocked: candidate must be a plain object')
  }
  if (candidate.completeness?.state !== 'complete') {
    const reasons = Array.isArray(candidate.completeness?.reasons)
      ? candidate.completeness.reasons.join(',')
      : String(candidate.completeness?.state ?? 'missing')
    fail(`publish blocked: candidate not complete (${reasons.slice(0, 300)})`)
  }
  if (candidate.observationBinding !== 'bound') {
    fail('publish blocked: candidate observation unbound (channel/cursor binding missing)')
  }
  if (candidate.pendingOutboxCount !== 0) {
    fail(`publish blocked: snapshot outbox not drained (${String(candidate.pendingOutboxCount)})`)
  }
  const observedChannel = candidate.observedLocalChannelKey
  const observedCursor = candidate.observedLocalCursor
  if (observedChannel === null || observedChannel === undefined) {
    fail('publish blocked: snapshot channel binding missing')
  }
  if (typeof observedCursor !== 'number' || !Number.isSafeInteger(observedCursor) || observedCursor < 0) {
    fail('publish blocked: snapshot watermark N missing or malformed')
  }
  if (observedChannel !== expectedChannelId) {
    fail('publish blocked: snapshot channel binding changed before publish')
  }
  if (observedCursor !== expectedCursor) {
    fail(
      `publish blocked: durable cursor changed before snapshot (expected ${String(expectedCursor)} observed ${String(observedCursor)})`
    )
  }
  return { watermarkN: observedCursor, channelId: observedChannel }
}

/**
 * Build the locked single-PUT envelope from a barrier-proven candidate.
 * `channelId`/`watermarkN` must be the `assertBarrierSnapshotProof` proof for
 * this candidate (same SQLite snapshot). Projects the candidate to the locked
 * wire `payload` only, computes the payload-only `jcs-sha256-v1` digest,
 * assembles the strictly closed outer envelope in locked key order, and
 * self-validates via the shared strict `validateEnvelope` plus digest verify.
 * Throws `SyncBaselinePublishError` fail-closed on any mismatch.
 */
export function buildPublishEnvelope(
  candidate: LocalSyncBaselineCandidate,
  channelId: string,
  watermarkN: number
): { envelope: SyncEnvelope; digest: string } {
  if (typeof channelId !== 'string' || channelId.length === 0) {
    fail('publish blocked: channel binding missing')
  }
  if (!Number.isSafeInteger(watermarkN) || watermarkN < 0) {
    fail('publish blocked: watermark N malformed')
  }
  if (candidate.observedLocalChannelKey !== channelId || candidate.observedLocalCursor !== watermarkN) {
    fail('publish blocked: envelope must use the barrier snapshot proof (channel/N mismatch)')
  }
  let payload: ReturnType<typeof projectLocalBaselineToWirePayload>
  try {
    payload = projectLocalBaselineToWirePayload(candidate)
  } catch (e) {
    if (e instanceof Error && e.name === 'SyncBaselineWireProjectionError') {
      fail(`publish blocked: candidate not wire-projectable: ${e.message}`, e)
    }
    throw e instanceof Error ? e : new Error(String(e))
  }
  const digest = computeWirePayloadDigest(payload)
  // Locked outer key order: wireVersion/channelId/watermark/digestScheme/digest/payload.
  const envelope = {
    wireVersion: WIRE_VERSION,
    channelId,
    watermark: watermarkN,
    digestScheme: DIGEST_SCHEME,
    digest,
    payload
  } as SyncEnvelope
  try {
    validateEnvelope(envelope)
  } catch (e) {
    if (e instanceof ValidationError) fail(`publish blocked: built envelope invalid: ${e.message}`, e)
    throw e instanceof Error ? e : new Error(String(e))
  }
  let digestOk = false
  try {
    digestOk = verifyEnvelopeDigest(envelope, (bytes) => createHash('sha256').update(bytes).digest('hex'))
  } catch (e) {
    if (e instanceof ValidationError) fail(`publish blocked: digest verify failed validation: ${e.message}`, e)
    throw e instanceof Error ? e : new Error(String(e))
  }
  if (!digestOk) fail('publish blocked: built envelope digest mismatch (never PUT a mismatched digest)')
  return { envelope, digest }
}
