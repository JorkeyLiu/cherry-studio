/**
 * Shared SYNC-CC core conformance (ABI-neutral, pure HTTP/assertion).
 *
 * Observable transport contract shared by the in-memory TestRelay
 * (tests/e2e/utils/sync-relay.ts) and the production reference relay
 * (`scripts/sync-relay/server.ts` via `createRelayServer` with `:memory:` or
 * file-backed SQLite). Covers the SYNC-CC core observable cases and the
 * shared HTTP status/error vocabulary:
 * registration/reattach + unknown credential, request idempotent/replace/
 * cancel/reject, accept create/join/no-merge + cleanup of other outgoing,
 * unpair dissolve, pairing-required, auth fail-closed, device identity
 * binding, two-channel isolation, per-channel contiguous cursor, idempotent
 * replay/collision, SSE channel isolation and stream close.
 *
 * Repository/transaction internals (SQLite atomicity, concurrency races,
 * file restart durability, memory pause/barrier fault injection) are NOT
 * shared here; they stay in adapter-exclusive tests. Store-failure injection
 * is an accepted residual: the current protocol has no store abstraction
 * (production uses direct SQLite with transactional batches and
 * fail-closed store-unavailable 500 paths), so a test-only injection hook
 * would add a production-nonexistent API and pollute the model. Rollback
 * and store-unavailable coverage stays with SQLite atomicity and the
 * production relay unit surface. This module never
 * imports Vitest or better-sqlite3 so the Playwright runner stays
 * ABI-neutral and the production bundle never gains a test dependency.
 *
 * Must NOT be imported by production app code.
 */
import type {
  SyncEntityType,
  SyncOperationKind,
  SyncRelayOperation as SharedSyncRelayOperation
} from '../../../packages/shared/sync/types'

export interface RelayCredential {
  code: string
  secret: string
}

export interface ConformanceTarget {
  endpoint: string
  token: string
}

const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/
const SECRET_RE = /^[0-9a-fA-F]{64}$/

function baseOf(target: ConformanceTarget): string {
  return target.endpoint.replace(/\/$/, '')
}

function bearer(target: ConformanceTarget): Record<string, string> {
  return { Authorization: `Bearer ${target.token}` }
}

function credHeaders(target: ConformanceTarget, cred: RelayCredential): Record<string, string> {
  return {
    ...bearer(target),
    'x-sync-device-code': cred.code,
    'x-sync-device-secret': cred.secret
  }
}

function fail(message: string): never {
  throw new Error(`sync-relay-conformance: ${message}`)
}

function expectStatus(actual: number, expected: number, label: string, body?: unknown): void {
  if (actual !== expected) {
    fail(`${label}: expected HTTP ${expected}, got ${actual} body=${JSON.stringify(body ?? {}).slice(0, 300)}`)
  }
}

function expectErrorContains(body: unknown, fragment: string, label: string): void {
  const text = JSON.stringify(body ?? {})
  if (!text.includes(fragment)) {
    fail(`${label}: expected error containing ${JSON.stringify(fragment)}, got ${text.slice(0, 300)}`)
  }
}

/**
 * Minimal typed response shapes (unknown + runtime guards, no loose casts).
 * Every field the conformance asserts is read through these guards so a
 * renamed/missing/drifted relay field fails at runtime (fail()) and a
 * mistyped access fails at compile time (unknown, never any).
 *
 * ConformanceOperation mirrors the shared SyncRelayOperation contract
 * (packages/shared/sync/types.ts) via type-only reuse: field types come
 * from SyncEntityType/SyncOperationKind and the shape stays assignable to
 * SharedSyncRelayOperation. The import is `import type` so it is erased at
 * runtime — the Playwright runner stays ABI-neutral and no runtime shared
 * dependency is introduced.
 */
export interface ConformanceOperation {
  id: string
  seq: number
  entityType: SyncEntityType
  op: SyncOperationKind
  entityId: string
  timestamp: number
  deviceId: string
  payload?: Record<string, unknown>
}

type SharedRelayOperationShape = Pick<
  SharedSyncRelayOperation,
  'id' | 'seq' | 'entityType' | 'op' | 'entityId' | 'timestamp' | 'deviceId' | 'payload'
>

function assertSharedShapeCompatible(op: ConformanceOperation): SharedRelayOperationShape {
  return op
}

export interface ConformanceStateBody {
  paired: boolean
  channelId: string | null
  outgoing: { id: string } | null
  incoming: Array<{ id: string }>
}

export interface ConformanceRelayResponse {
  status: number
  body: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredRecord(body: unknown, label: string): Record<string, unknown> {
  if (!isRecord(body)) fail(`${label}: body is not an object`)
  return body
}

function requiredStringField(body: unknown, key: string, label: string): string {
  const record = requiredRecord(body, label)
  const value = record[key]
  if (typeof value !== 'string') fail(`${label}: missing string field ${key}`)
  return value
}

function requiredNumberField(body: unknown, key: string, label: string): number {
  const record = requiredRecord(body, label)
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label}: missing numeric field ${key}`)
  return value
}

function requiredRequestId(body: unknown, label: string): string {
  return requiredStringField(body, 'requestId', label)
}

function requiredChannelId(body: unknown, label: string): string {
  return requiredStringField(body, 'channelId', label)
}

function requiredCursor(body: unknown, label: string): number {
  return requiredNumberField(body, 'cursor', label)
}

function requiredAcceptedIds(body: unknown, label: string): string[] {
  const record = requiredRecord(body, label)
  const value = record['acceptedIds']
  if (!Array.isArray(value)) fail(`${label}: missing acceptedIds array`)
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') fail(`${label}: acceptedIds entry is not a string`)
    out.push(entry)
  }
  return out
}

function requiredOperations(body: unknown, label: string): ConformanceOperation[] {
  const record = requiredRecord(body, label)
  const value = record['operations']
  if (!Array.isArray(value)) fail(`${label}: missing operations array`)
  const out: ConformanceOperation[] = []
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index]
    const opLabel = `${label}: operation ${index}`
    if (!isRecord(entry)) fail(`${opLabel} is not an object`)
    const id = entry['id']
    const seq = entry['seq']
    const entityType = entry['entityType']
    const kind = entry['op']
    const entityId = entry['entityId']
    const timestamp = entry['timestamp']
    const deviceId = entry['deviceId']
    const payload = entry['payload']
    if (typeof id !== 'string' || id.length === 0) fail(`${opLabel} missing non-empty string id`)
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) fail(`${opLabel} missing safe-integer seq`)
    if (entityType !== 'topic' && entityType !== 'message' && entityType !== 'message_block') {
      fail(`${opLabel} invalid entityType ${String(entityType)}`)
    }
    if (kind !== 'upsert' && kind !== 'delete') fail(`${opLabel} invalid op ${String(kind)}`)
    if (typeof entityId !== 'string' || entityId.length === 0) fail(`${opLabel} missing non-empty string entityId`)
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      fail(`${opLabel} missing finite numeric timestamp`)
    }
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      fail(`${opLabel} missing non-empty string deviceId`)
    }
    let guardedPayload: Record<string, unknown> | undefined
    if (kind === 'delete') {
      if (payload !== undefined && payload !== null) {
        if (!isRecord(payload)) fail(`${opLabel} delete payload is not a record`)
        if (Object.keys(payload).length > 0) fail(`${opLabel} delete must not carry a payload`)
        guardedPayload = payload
      }
    } else {
      if (!isRecord(payload)) fail(`${opLabel} upsert missing record payload`)
      guardedPayload = payload
      if (entityType === 'topic') {
        const payloadId = guardedPayload['id']
        const payloadName = guardedPayload['name']
        if (typeof payloadId !== 'string') fail(`${opLabel} topic payload missing string id`)
        if (typeof payloadName !== 'string') fail(`${opLabel} topic payload missing string name`)
      }
    }
    const guarded: ConformanceOperation = {
      id,
      seq,
      entityType,
      op: kind,
      entityId,
      timestamp,
      deviceId,
      ...(guardedPayload !== undefined ? { payload: guardedPayload } : {})
    }
    void assertSharedShapeCompatible(guarded)
    out.push(guarded)
  }
  return out
}

function stableConformanceJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value) ?? ''
  if (typeof value !== 'object') return JSON.stringify(value) ?? ''
  if (Array.isArray(value)) return `[${value.map((entry) => stableConformanceJson(entry)).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value) ?? ''
  const record: Record<string, unknown> = value
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableConformanceJson(record[key])}`).join(',')}}`
}

/**
 * Full-semantics operation equality: every SyncRelayOperation contract
 * field plus deep payload equality. Isolation/replay assertions use this
 * so a relay that echoes only id/seq (or mutates payload/timestamp) fails.
 */
function expectConformanceOperationEquals(
  actual: ConformanceOperation,
  expected: ConformanceOperation,
  label: string
): void {
  if (actual.id !== expected.id) fail(`${label}: id mismatch ${actual.id} !== ${expected.id}`)
  if (actual.seq !== expected.seq) fail(`${label}: seq mismatch ${String(actual.seq)} !== ${String(expected.seq)}`)
  if (actual.entityType !== expected.entityType) {
    fail(`${label}: entityType mismatch ${actual.entityType} !== ${expected.entityType}`)
  }
  if (actual.op !== expected.op) fail(`${label}: op mismatch ${actual.op} !== ${expected.op}`)
  if (actual.entityId !== expected.entityId) {
    fail(`${label}: entityId mismatch ${actual.entityId} !== ${expected.entityId}`)
  }
  if (actual.timestamp !== expected.timestamp) {
    fail(`${label}: timestamp mismatch ${String(actual.timestamp)} !== ${String(expected.timestamp)}`)
  }
  if (actual.deviceId !== expected.deviceId) {
    fail(`${label}: deviceId mismatch ${actual.deviceId} !== ${expected.deviceId}`)
  }
  if (stableConformanceJson(actual.payload ?? null) !== stableConformanceJson(expected.payload ?? null)) {
    fail(`${label}: payload mismatch ${stableConformanceJson(actual.payload ?? null).slice(0, 200)}`)
  }
}

function requiredState(body: unknown, label: string): ConformanceStateBody {
  const record = requiredRecord(body, label)
  const paired = record['paired']
  if (typeof paired !== 'boolean') fail(`${label}: missing boolean paired`)
  const channelRaw = record['channelId']
  let channelId: string | null
  if (channelRaw === null) channelId = null
  else if (typeof channelRaw === 'string') channelId = channelRaw
  else fail(`${label}: channelId is not string|null`)
  const outgoingRaw = record['outgoing']
  let outgoing: { id: string } | null = null
  if (outgoingRaw !== null) {
    if (!isRecord(outgoingRaw)) fail(`${label}: outgoing is not an object|null`)
    const oid = outgoingRaw['id']
    if (typeof oid !== 'string') fail(`${label}: outgoing missing string id`)
    outgoing = { id: oid }
  }
  const incomingRaw = record['incoming']
  if (!Array.isArray(incomingRaw)) fail(`${label}: missing incoming array`)
  const incoming: Array<{ id: string }> = []
  for (let index = 0; index < incomingRaw.length; index++) {
    const entry: unknown = incomingRaw[index]
    if (!isRecord(entry)) fail(`${label}: incoming ${index} is not an object`)
    const rid = entry['id']
    if (typeof rid !== 'string') fail(`${label}: incoming ${index} missing string id`)
    incoming.push({ id: rid })
  }
  return { paired, channelId, outgoing, incoming }
}

async function readJson(res: Response): Promise<unknown> {
  return await res.json().catch(() => ({}))
}

export function conformanceTopicOp(
  id: string,
  entityId: string,
  deviceId: string,
  timestamp: number
): Record<string, unknown> {
  return {
    id,
    entityType: 'topic',
    op: 'upsert',
    entityId,
    timestamp,
    deviceId,
    payload: { id: entityId, name: `t-${entityId}` }
  }
}

export async function conformanceRegister(target: ConformanceTarget, deviceId?: string): Promise<RelayCredential> {
  const res = await fetch(`${baseOf(target)}/sync/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(target) },
    body: JSON.stringify(deviceId !== undefined ? { deviceId } : {})
  })
  const body = await readJson(res)
  expectStatus(res.status, 200, 'register', body)
  const deviceCode = requiredStringField(body, 'deviceCode', 'register')
  if (!CODE_RE.test(deviceCode)) {
    fail(`register: malformed deviceCode ${JSON.stringify(body).slice(0, 200)}`)
  }
  const deviceSecret = requiredStringField(body, 'deviceSecret', 'register')
  if (!SECRET_RE.test(deviceSecret)) {
    fail('register: malformed deviceSecret')
  }
  return { code: deviceCode, secret: deviceSecret }
}

export async function conformanceState(
  target: ConformanceTarget,
  cred: RelayCredential
): Promise<ConformanceRelayResponse> {
  const res = await fetch(`${baseOf(target)}/sync/state`, { headers: credHeaders(target, cred) })
  return { status: res.status, body: await readJson(res) }
}

export async function conformanceRequest(
  target: ConformanceTarget,
  cred: RelayCredential,
  targetCode: string
): Promise<ConformanceRelayResponse> {
  const res = await fetch(`${baseOf(target)}/sync/pair/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credHeaders(target, cred) },
    body: JSON.stringify({ targetCode })
  })
  return { status: res.status, body: await readJson(res) }
}

export async function conformanceAccept(
  target: ConformanceTarget,
  cred: RelayCredential,
  requestId: string
): Promise<ConformanceRelayResponse> {
  const res = await fetch(`${baseOf(target)}/sync/pair/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credHeaders(target, cred) },
    body: JSON.stringify({ requestId })
  })
  return { status: res.status, body: await readJson(res) }
}

export async function conformancePush(
  target: ConformanceTarget,
  cred: RelayCredential,
  deviceId: string,
  operations: Record<string, unknown>[]
): Promise<ConformanceRelayResponse> {
  const res = await fetch(`${baseOf(target)}/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credHeaders(target, cred) },
    body: JSON.stringify({ deviceId, operations })
  })
  return { status: res.status, body: await readJson(res) }
}

export async function conformancePull(
  target: ConformanceTarget,
  cred: RelayCredential,
  deviceId: string,
  cursor: number | string
): Promise<ConformanceRelayResponse> {
  const res = await fetch(
    `${baseOf(target)}/sync/pull?cursor=${encodeURIComponent(String(cursor))}&deviceId=${encodeURIComponent(deviceId)}`,
    { headers: credHeaders(target, cred) }
  )
  return { status: res.status, body: await readJson(res) }
}

/** Registration issues code+secret; reattach verifies without rotation. */
export async function conformanceRegistrationReattach(target: ConformanceTarget): Promise<void> {
  const reg = await conformanceRegister(target, `cc-reg-${Date.now() % 100000}`)
  const again = await fetch(`${baseOf(target)}/sync/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(target) },
    body: JSON.stringify({ deviceCode: reg.code, deviceSecret: reg.secret })
  })
  const againBody = await readJson(again)
  expectStatus(again.status, 200, 'reattach', againBody)
  if (requiredStringField(againBody, 'deviceCode', 'reattach') !== reg.code) {
    fail('reattach: deviceCode changed')
  }
  const reattachRecord = requiredRecord(againBody, 'reattach')
  if (reattachRecord['deviceSecret'] !== undefined) fail('reattach: secret rotated on reattach')
}

/** Unknown/wrong credentials fail closed and are never silently re-registered. */
export async function conformanceUnknownCredential(target: ConformanceTarget): Promise<void> {
  const reg = await conformanceRegister(target)
  const unknown = await fetch(`${baseOf(target)}/sync/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(target) },
    body: JSON.stringify({ deviceCode: 'ZZZZ9999', deviceSecret: '0'.repeat(64) })
  })
  const unknownBody = await readJson(unknown)
  expectStatus(unknown.status, 403, 'unknown-credential reattach', unknownBody)
  expectErrorContains(unknownBody, 'unknown-credential', 'unknown-credential reattach')
  const wrong = await fetch(`${baseOf(target)}/sync/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(target) },
    body: JSON.stringify({ deviceCode: reg.code, deviceSecret: '0'.repeat(64) })
  })
  const wrongBody = await readJson(wrong)
  expectStatus(wrong.status, 403, 'wrong-secret reattach', wrongBody)
  expectErrorContains(wrongBody, 'invalid-credential', 'wrong-secret reattach')
  // The public code alone authorizes nothing on the data plane.
  const forged = await fetch(`${baseOf(target)}/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...bearer(target),
      'x-sync-device-code': reg.code
    },
    body: JSON.stringify({ deviceId: 'x', operations: [] })
  })
  const forgedBody = await readJson(forged)
  expectStatus(forged.status, 403, 'code-without-secret push', forgedBody)
}

/** Bearer auth fails closed before device-credential checks. */
export async function conformanceAuthFailClosed(target: ConformanceTarget): Promise<void> {
  const reg = await conformanceRegister(target)
  const noAuth = await fetch(`${baseOf(target)}/sync/pull?cursor=0&deviceId=x`, {
    headers: { 'x-sync-device-code': reg.code, 'x-sync-device-secret': reg.secret }
  })
  await readJson(noAuth)
  expectStatus(noAuth.status, 401, 'pull without Bearer')
  const badAuth = await fetch(`${baseOf(target)}/sync/pull?cursor=0&deviceId=x`, {
    headers: {
      Authorization: 'Bearer wrong-token',
      'x-sync-device-code': reg.code,
      'x-sync-device-secret': reg.secret
    }
  })
  await readJson(badAuth)
  expectStatus(badAuth.status, 401, 'pull with wrong Bearer')
  // Unknown device credential fails closed with the shared vocabulary.
  const ghost = await conformancePush(target, { code: 'ZZZZ9999', secret: '0'.repeat(64) }, 'ghost-dev', [])
  expectStatus(ghost.status, 403, 'ghost push', ghost.body)
  expectErrorContains(ghost.body, 'unknown-credential', 'ghost push')
}

/** Request lifecycle: idempotent retry, replace on new target, cancel, reject. */
export async function conformanceRequestLifecycle(target: ConformanceTarget): Promise<void> {
  const a = await conformanceRegister(target)
  const b = await conformanceRegister(target)
  const c = await conformanceRegister(target)
  const first = await conformanceRequest(target, b, a.code)
  expectStatus(first.status, 200, 'request B->A', first.body)
  const firstId = requiredRequestId(first.body, 'request B->A')
  const retry = await conformanceRequest(target, b, a.code)
  expectStatus(retry.status, 200, 'idempotent retry B->A', retry.body)
  if (requiredRequestId(retry.body, 'idempotent retry B->A') !== firstId) fail('request retry: not idempotent')
  const replaced = await conformanceRequest(target, b, c.code)
  expectStatus(replaced.status, 200, 'replace B->C', replaced.body)
  const replacedId = requiredRequestId(replaced.body, 'replace B->C')
  if (replacedId === firstId) fail('request replace: id unchanged')
  const late = await conformanceAccept(target, a, firstId)
  expectStatus(late.status, 410, 'accept replaced request', late.body)
  // Cancel the live B->C request.
  const cancelRes = await fetch(`${baseOf(target)}/sync/pair/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credHeaders(target, b) },
    body: JSON.stringify({ requestId: replacedId })
  })
  const cancelBody = await readJson(cancelRes)
  expectStatus(cancelRes.status, 200, 'cancel B->C', cancelBody)
  const stateB = await conformanceState(target, b)
  expectStatus(stateB.status, 200, 'state B after cancel', stateB.body)
  if (requiredState(stateB.body, 'state B after cancel').outgoing !== null) fail('cancel: outgoing not cleared')
  // Fresh request then target reject resolves without pairing.
  const req2 = await conformanceRequest(target, b, a.code)
  expectStatus(req2.status, 200, 'request B->A again', req2.body)
  const req2Id = requiredRequestId(req2.body, 'request B->A again')
  const rejectRes = await fetch(`${baseOf(target)}/sync/pair/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credHeaders(target, a) },
    body: JSON.stringify({ requestId: req2Id })
  })
  const rejectBody = await readJson(rejectRes)
  expectStatus(rejectRes.status, 200, 'reject B->A', rejectBody)
  const stateA = await conformanceState(target, a)
  expectStatus(stateA.status, 200, 'state A after reject', stateA.body)
  const stateAAfter = requiredState(stateA.body, 'state A after reject')
  if (stateAAfter.paired !== false) fail('reject: A paired unexpectedly')
  if (stateAAfter.incoming.length !== 0) {
    fail('reject: incoming not cleared')
  }
  // Unknown target, self-pairing, malformed codes fail closed.
  const unknownTarget = await conformanceRequest(target, a, 'ZZZZ9999')
  expectStatus(unknownTarget.status, 404, 'unknown target', unknownTarget.body)
  const selfPair = await conformanceRequest(target, a, a.code)
  expectStatus(selfPair.status, 400, 'self pairing', selfPair.body)
}

/**
 * Accept rules: unpaired+unpaired create, unpaired joins paired target,
 * paired requester refused, late accept after requester paired settles with
 * no merge, and the accept atomically cleans other pending outgoing of both
 * devices (never revivable after a later unpair).
 */
export async function conformanceAcceptCreateJoinNoMerge(target: ConformanceTarget): Promise<void> {
  const a = await conformanceRegister(target)
  const b = await conformanceRegister(target)
  const reqAB = await conformanceRequest(target, b, a.code)
  expectStatus(reqAB.status, 200, 'request B->A', reqAB.body)
  const reqABId = requiredRequestId(reqAB.body, 'request B->A')
  const accepted = await conformanceAccept(target, a, reqABId)
  expectStatus(accepted.status, 200, 'accept B->A', accepted.body)
  const channelAB = requiredChannelId(accepted.body, 'accept B->A')
  const stateA = await conformanceState(target, a)
  const stateB = await conformanceState(target, b)
  expectStatus(stateA.status, 200, 'state A paired', stateA.body)
  expectStatus(stateB.status, 200, 'state B paired', stateB.body)
  const stateAParsed = requiredState(stateA.body, 'state A paired')
  const stateBParsed = requiredState(stateB.body, 'state B paired')
  if (stateAParsed.channelId !== stateBParsed.channelId) fail('accept: channel mismatch')
  // Third unpaired device joins the same hidden channel via the paired target.
  const c = await conformanceRegister(target)
  const reqCA = await conformanceRequest(target, c, a.code)
  expectStatus(reqCA.status, 200, 'request C->A', reqCA.body)
  const acceptedCA = await conformanceAccept(target, a, requiredRequestId(reqCA.body, 'request C->A'))
  expectStatus(acceptedCA.status, 200, 'accept C->A join', acceptedCA.body)
  if (requiredChannelId(acceptedCA.body, 'accept C->A join') !== channelAB) fail('join: channel mismatch')
  // Paired requester cannot initiate another pairing.
  const d = await conformanceRegister(target)
  const bad = await conformanceRequest(target, a, d.code)
  expectStatus(bad.status, 409, 'paired requester initiate', bad.body)
  expectErrorContains(bad.body, 'pairing-already-paired', 'paired requester initiate')
  // Late-accept no-merge with stale-intent cleanup on both sides.
  const e = await conformanceRegister(target)
  const f = await conformanceRegister(target)
  const g = await conformanceRegister(target)
  const reqFE = await conformanceRequest(target, f, e.code)
  expectStatus(reqFE.status, 200, 'stale request F->E', reqFE.body)
  const reqFEId = requiredRequestId(reqFE.body, 'stale request F->E')
  const reqGF = await conformanceRequest(target, g, f.code)
  expectStatus(reqGF.status, 200, 'fresh request G->F', reqGF.body)
  const acceptedGF = await conformanceAccept(target, f, requiredRequestId(reqGF.body, 'fresh request G->F'))
  expectStatus(acceptedGF.status, 200, 'accept G->F', acceptedGF.body)
  // F's other pending (F->E) must be terminal now, never revivable.
  const stateF = await conformanceState(target, f)
  expectStatus(stateF.status, 200, 'state F after accept', stateF.body)
  if (requiredState(stateF.body, 'state F after accept').outgoing !== null) {
    fail('accept: stale outgoing of acceptor revivable')
  }
  const lateStale = await conformanceAccept(target, e, reqFEId)
  if (lateStale.status !== 409 && lateStale.status !== 410) {
    fail(`late accept: expected 409/410, got ${lateStale.status}`)
  }
  const stateE = await conformanceState(target, e)
  expectStatus(stateE.status, 200, 'state E unpaired', stateE.body)
  if (requiredState(stateE.body, 'state E unpaired').paired !== false) fail('late accept: E merged unexpectedly')
  // Unpair dissolves; the stale intent stays terminal (410, never accepted).
  const unpairRes = await fetch(`${baseOf(target)}/sync/pair/unpair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credHeaders(target, f) },
    body: JSON.stringify({})
  })
  const unpairBody = await readJson(unpairRes)
  expectStatus(unpairRes.status, 200, 'unpair F', unpairBody)
  const stateFAfter = await conformanceState(target, f)
  expectStatus(stateFAfter.status, 200, 'state F after unpair', stateFAfter.body)
  if (requiredState(stateFAfter.body, 'state F after unpair').outgoing !== null) {
    fail('unpair: stale outgoing revived')
  }
  const lateAfter = await conformanceAccept(target, e, reqFEId)
  expectStatus(lateAfter.status, 410, 'late accept after unpair stays terminal', lateAfter.body)
}

/** Unpair removes only self; sub-two membership dissolves; survivor unpaired. */
export async function conformanceUnpairDissolve(target: ConformanceTarget): Promise<void> {
  const a = await conformanceRegister(target)
  const b = await conformanceRegister(target)
  const req = await conformanceRequest(target, b, a.code)
  expectStatus(req.status, 200, 'request for unpair', req.body)
  const accepted = await conformanceAccept(target, a, requiredRequestId(req.body, 'request for unpair'))
  expectStatus(accepted.status, 200, 'accept for unpair', accepted.body)
  const unpair = await fetch(`${baseOf(target)}/sync/pair/unpair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credHeaders(target, a) },
    body: JSON.stringify({})
  })
  const unpairBody = await readJson(unpair)
  expectStatus(unpair.status, 200, 'unpair', unpairBody)
  const stateB = await conformanceState(target, b)
  expectStatus(stateB.status, 200, 'survivor state', stateB.body)
  const survivor = requiredState(stateB.body, 'survivor state')
  if (survivor.paired !== false || survivor.channelId !== null) {
    fail('unpair: survivor still paired')
  }
  // Registration survives: B can pair again immediately.
  const c = await conformanceRegister(target)
  const req2 = await conformanceRequest(target, b, c.code)
  expectStatus(req2.status, 200, 're-request after unpair', req2.body)
  // Unpair while unpaired is refused.
  const again = await fetch(`${baseOf(target)}/sync/pair/unpair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credHeaders(target, a) },
    body: JSON.stringify({})
  })
  const againBody = await readJson(again)
  expectStatus(again.status, 409, 'unpair while unpaired', againBody)
  expectErrorContains(againBody, 'not-paired', 'unpair while unpaired')
}

/** Unpaired devices are refused the data plane with pairing-required. */
export async function conformancePairingRequired(target: ConformanceTarget): Promise<void> {
  const a = await conformanceRegister(target, `cc-unpaired-${Date.now() % 100000}`)
  const push = await conformancePush(target, a, `cc-unpaired-${Date.now() % 100000}`, [])
  void push
  // Push with the registered identity but no channel must be pairing-required
  // (empty batch avoids identity-shape interference).
  const solo = await conformanceRegister(target, 'cc-solo-id')
  const denied = await conformancePush(target, solo, 'cc-solo-id', [])
  expectStatus(denied.status, 403, 'unpaired push', denied.body)
  expectErrorContains(denied.body, 'pairing-required', 'unpaired push')
  const pull = await conformancePull(target, solo, 'cc-solo-id', 0)
  expectStatus(pull.status, 403, 'unpaired pull', pull.body)
  expectErrorContains(pull.body, 'pairing-required', 'unpaired pull')
  const sub = await fetch(`${baseOf(target)}/sync/subscribe?cursor=0`, {
    headers: credHeaders(target, solo)
  })
  const subBody = await readJson(sub).catch(() => ({}))
  void subBody
  expectStatus(sub.status, 403, 'unpaired subscribe', {})
  try {
    await sub.text().catch(() => '')
  } catch {}
}

/** Push identity binds to the registration client device id (403, no leak). */
export async function conformanceDeviceIdentityBinding(target: ConformanceTarget): Promise<void> {
  const a = await conformanceRegister(target, 'cc-bind-a')
  const b = await conformanceRegister(target, 'cc-bind-b')
  const req = await conformanceRequest(target, b, a.code)
  expectStatus(req.status, 200, 'bind request', req.body)
  const accepted = await conformanceAccept(target, a, requiredRequestId(req.body, 'bind request'))
  expectStatus(accepted.status, 200, 'bind accept', accepted.body)
  // Body/op agree with each other but not with the registration: 403.
  const forged = await conformancePush(target, a, 'forged-id', [
    conformanceTopicOp('cc-bind-op-1', 'cc-bind-t-1', 'forged-id', 1000)
  ])
  expectStatus(forged.status, 403, 'forged push', forged.body)
  expectErrorContains(forged.body, 'device identity mismatch', 'forged push')
  const leaked = JSON.stringify(forged.body)
  if (leaked.includes(a.code) || leaked.includes(a.secret)) fail('forged push: credential leaked')
  // Operation disagreeing with the body is still 400 before binding.
  const mismatch = await conformancePush(target, a, 'cc-bind-a', [
    conformanceTopicOp('cc-bind-op-2', 'cc-bind-t-2', 'someone-else', 1001)
  ])
  expectStatus(mismatch.status, 400, 'device mismatch push', mismatch.body)
  // The real registered client id still pushes cleanly.
  const ok = await conformancePush(target, a, 'cc-bind-a', [
    conformanceTopicOp('cc-bind-op-3', 'cc-bind-t-3', 'cc-bind-a', 1002)
  ])
  expectStatus(ok.status, 200, 'bound push', ok.body)
}

/** Two independent channels isolate traffic with independent cursors. */
export async function conformanceTwoChannelIsolation(target: ConformanceTarget): Promise<void> {
  const a = await conformanceRegister(target, 'cc-iso-a')
  const b = await conformanceRegister(target, 'cc-iso-b')
  const c = await conformanceRegister(target, 'cc-iso-c')
  const d = await conformanceRegister(target, 'cc-iso-d')
  const reqAB = await conformanceRequest(target, b, a.code)
  expectStatus(reqAB.status, 200, 'request AB', reqAB.body)
  const accAB = await conformanceAccept(target, a, requiredRequestId(reqAB.body, 'request AB'))
  expectStatus(accAB.status, 200, 'accept AB', accAB.body)
  const reqCD = await conformanceRequest(target, d, c.code)
  expectStatus(reqCD.status, 200, 'request CD', reqCD.body)
  const accCD = await conformanceAccept(target, c, requiredRequestId(reqCD.body, 'request CD'))
  expectStatus(accCD.status, 200, 'accept CD', accCD.body)
  const pushAB = await conformancePush(target, a, 'cc-iso-a', [
    conformanceTopicOp('cc-iso-op-ab-1', 'cc-iso-t-ab-1', 'cc-iso-a', 1000),
    conformanceTopicOp('cc-iso-op-ab-2', 'cc-iso-t-ab-2', 'cc-iso-a', 1001)
  ])
  expectStatus(pushAB.status, 200, 'push AB', pushAB.body)
  if (requiredCursor(pushAB.body, 'push AB') !== 2) {
    fail(`push AB: expected cursor 2, got ${String(requiredCursor(pushAB.body, 'push AB'))}`)
  }
  const pushCD = await conformancePush(target, c, 'cc-iso-c', [
    conformanceTopicOp('cc-iso-op-cd-1', 'cc-iso-t-cd-1', 'cc-iso-c', 1000)
  ])
  expectStatus(pushCD.status, 200, 'push CD', pushCD.body)
  if (requiredCursor(pushCD.body, 'push CD') !== 1) {
    fail(`push CD: expected cursor 1, got ${String(requiredCursor(pushCD.body, 'push CD'))}`)
  }
  const pullB = await conformancePull(target, b, 'cc-iso-b', 0)
  expectStatus(pullB.status, 200, 'pull B', pullB.body)
  const opsB = requiredOperations(pullB.body, 'pull B')
  if (opsB.length !== 2) fail(`pull B: expected 2 isolated operations, got ${String(opsB.length)}`)
  const expectedAB1: ConformanceOperation = {
    id: 'cc-iso-op-ab-1',
    seq: 1,
    entityType: 'topic',
    op: 'upsert',
    entityId: 'cc-iso-t-ab-1',
    timestamp: 1000,
    deviceId: 'cc-iso-a',
    payload: { id: 'cc-iso-t-ab-1', name: 't-cc-iso-t-ab-1' }
  }
  const expectedAB2: ConformanceOperation = {
    id: 'cc-iso-op-ab-2',
    seq: 2,
    entityType: 'topic',
    op: 'upsert',
    entityId: 'cc-iso-t-ab-2',
    timestamp: 1001,
    deviceId: 'cc-iso-a',
    payload: { id: 'cc-iso-t-ab-2', name: 't-cc-iso-t-ab-2' }
  }
  expectConformanceOperationEquals(opsB[0], expectedAB1, 'pull B op 1')
  expectConformanceOperationEquals(opsB[1], expectedAB2, 'pull B op 2')
  const pullD = await conformancePull(target, d, 'cc-iso-d', 0)
  expectStatus(pullD.status, 200, 'pull D', pullD.body)
  const opsD = requiredOperations(pullD.body, 'pull D')
  if (opsD.length !== 1) fail(`pull D: expected 1 isolated operation, got ${String(opsD.length)}`)
  const expectedCD1: ConformanceOperation = {
    id: 'cc-iso-op-cd-1',
    seq: 1,
    entityType: 'topic',
    op: 'upsert',
    entityId: 'cc-iso-t-cd-1',
    timestamp: 1000,
    deviceId: 'cc-iso-c',
    payload: { id: 'cc-iso-t-cd-1', name: 't-cc-iso-t-cd-1' }
  }
  expectConformanceOperationEquals(opsD[0], expectedCD1, 'pull D op 1')
  if (requiredCursor(pullD.body, 'pull D') !== 1) fail('pull D: cursor mismatch')
}

/** Per-channel contiguous cursor with idempotent replay and 409 collision. */
export async function conformanceReplayCollision(target: ConformanceTarget): Promise<void> {
  const a = await conformanceRegister(target, 'cc-replay-a')
  const b = await conformanceRegister(target, 'cc-replay-b')
  const req = await conformanceRequest(target, b, a.code)
  expectStatus(req.status, 200, 'replay request', req.body)
  const acc = await conformanceAccept(target, a, requiredRequestId(req.body, 'replay request'))
  expectStatus(acc.status, 200, 'replay accept', acc.body)
  const op = conformanceTopicOp('cc-replay-op-1', 'cc-replay-t-1', 'cc-replay-a', 1000)
  const first = await conformancePush(target, a, 'cc-replay-a', [op])
  expectStatus(first.status, 200, 'first push', first.body)
  if (requiredCursor(first.body, 'first push') !== 1) fail('first push: cursor not 1')
  const replay = await conformancePush(target, a, 'cc-replay-a', [op])
  expectStatus(replay.status, 200, 'replay push', replay.body)
  if (JSON.stringify(requiredAcceptedIds(replay.body, 'replay push')) !== JSON.stringify(['cc-replay-op-1'])) {
    fail('replay: acceptedIds mismatch')
  }
  if (requiredCursor(replay.body, 'replay push') !== 1) fail('replay: cursor grew on identical replay')
  const clash = await conformancePush(target, a, 'cc-replay-a', [
    {
      ...conformanceTopicOp('cc-replay-op-1', 'cc-replay-t-1', 'cc-replay-a', 9999),
      payload: { id: 'cc-replay-t-1', name: 'Mutated' }
    }
  ])
  expectStatus(clash.status, 409, 'collision push', clash.body)
  const after = await conformancePull(target, b, 'cc-replay-b', 0)
  expectStatus(after.status, 200, 'pull after collision', after.body)
  if (requiredCursor(after.body, 'pull after collision') !== 1) fail('collision: cursor mutated')
  const afterOps = requiredOperations(after.body, 'pull after collision')
  if (afterOps.length !== 1) fail(`collision: expected 1 stored operation, got ${String(afterOps.length)}`)
  const expectedReplay: ConformanceOperation = {
    id: 'cc-replay-op-1',
    seq: 1,
    entityType: 'topic',
    op: 'upsert',
    entityId: 'cc-replay-t-1',
    timestamp: 1000,
    deviceId: 'cc-replay-a',
    payload: { id: 'cc-replay-t-1', name: 't-cc-replay-t-1' }
  }
  expectConformanceOperationEquals(afterOps[0], expectedReplay, 'pull after collision op 1')
}

async function readSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: { buffer: string },
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const raced = await Promise.race([
      reader.read().then((r) => ({ kind: 'data' as const, r })),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), remaining))
    ])
    if (raced.kind === 'timeout') return null
    if (raced.r.done) return null
    const value = raced.r.value
    if (value) state.buffer += decoder.decode(value, { stream: true })
    for (;;) {
      const idx = state.buffer.indexOf('\n\n')
      if (idx === -1) break
      const out = state.buffer.slice(0, idx)
      state.buffer = state.buffer.slice(idx + 2)
      if (!out.includes('data:') && out.trimStart().startsWith(':')) continue
      if (out.trim() === '') continue
      return out
    }
  }
  return null
}

async function drainConnected(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: { buffer: string },
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (state.buffer.includes(': connected')) return true
    const remaining = deadline - Date.now()
    const raced = await Promise.race([
      reader.read().then((r) => ({ kind: 'data' as const, r })),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), remaining))
    ])
    if (raced.kind === 'timeout') return state.buffer.includes(': connected')
    if (raced.r.done) return false
    if (raced.r.value) state.buffer += decoder.decode(raced.r.value, { stream: true })
  }
  return state.buffer.includes(': connected')
}

/**
 * SSE hints isolate per channel (cursor only, never operations) and a device
 * that leaves a channel never keeps that channel's stream: unpair closes the
 * departed stream while the surviving channel keeps notifying.
 */
export async function conformanceSseIsolationClose(target: ConformanceTarget): Promise<void> {
  const a = await conformanceRegister(target, 'cc-sse-a')
  const b = await conformanceRegister(target, 'cc-sse-b')
  const c = await conformanceRegister(target, 'cc-sse-c')
  const d = await conformanceRegister(target, 'cc-sse-d')
  const reqAB = await conformanceRequest(target, b, a.code)
  expectStatus(reqAB.status, 200, 'sse request AB', reqAB.body)
  const accAB = await conformanceAccept(target, a, requiredRequestId(reqAB.body, 'sse request AB'))
  expectStatus(accAB.status, 200, 'sse accept AB', accAB.body)
  const reqCD = await conformanceRequest(target, d, c.code)
  expectStatus(reqCD.status, 200, 'sse request CD', reqCD.body)
  const accCD = await conformanceAccept(target, c, requiredRequestId(reqCD.body, 'sse request CD'))
  expectStatus(accCD.status, 200, 'sse accept CD', accCD.body)

  const openSubscribe = async (
    cred: RelayCredential
  ): Promise<{
    reader: ReadableStreamDefaultReader<Uint8Array>
    controller: AbortController
    state: { buffer: string }
  }> => {
    const controller = new AbortController()
    const res = await fetch(`${baseOf(target)}/sync/subscribe?cursor=0`, {
      headers: { Accept: 'text/event-stream', ...credHeaders(target, cred) },
      signal: controller.signal
    })
    if (res.status !== 200) {
      await res.text().catch(() => '')
      fail(`subscribe: expected 200, got ${res.status}`)
    }
    if (!res.body) fail('subscribe: missing body stream')
    const reader = res.body.getReader()
    return { reader, controller, state: { buffer: '' } }
  }

  const subB = await openSubscribe(b)
  const subProbe = await openSubscribe(d)
  const controllers = [subB.controller, subProbe.controller]
  try {
    const decoder = new TextDecoder()
    if (!(await drainConnected(subB.reader, decoder, subB.state, 5000))) fail('sse B: no connected frame')
    if (!(await drainConnected(subProbe.reader, decoder, subProbe.state, 5000))) fail('sse D: no connected frame')
    const pushed = await conformancePush(target, a, 'cc-sse-a', [
      conformanceTopicOp('cc-sse-op-1', 'cc-sse-t-1', 'cc-sse-a', 1000)
    ])
    expectStatus(pushed.status, 200, 'sse push AB', pushed.body)
    const hintB = await readSseFrame(subB.reader, decoder, subB.state, 5000)
    if (hintB === null || !hintB.includes('event: sync') || !hintB.includes('"cursor"')) {
      fail('sse B: missing sync hint')
    }
    if (hintB.includes('cc-sse-op-1')) fail('sse B: hint leaked operation')
    const hintProbe = await readSseFrame(subProbe.reader, decoder, subProbe.state, 1000)
    if (hintProbe !== null) fail(`sse isolation: other channel observed hint ${hintProbe.slice(0, 120)}`)
    try {
      subProbe.controller.abort()
    } catch {}
    try {
      await subProbe.reader.cancel().catch(() => {})
    } catch {}
    // A unpairs: channel AB dissolves, so B's departed stream must close.
    const unpair = await fetch(`${baseOf(target)}/sync/pair/unpair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credHeaders(target, a) },
      body: JSON.stringify({})
    })
    const unpairBody = await readJson(unpair)
    expectStatus(unpair.status, 200, 'sse unpair', unpairBody)
    const closed = await Promise.race([
      (async (): Promise<boolean> => {
        for (;;) {
          const { done, value } = await subB.reader.read()
          if (done) return true
          if (value) subB.state.buffer += decoder.decode(value, { stream: true })
        }
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000))
    ])
    if (!closed) fail('sse B: departed stream did not close after unpair')
    // Surviving channel still notifies on its own stream.
    const subD = await openSubscribe(d)
    controllers.push(subD.controller)
    if (!(await drainConnected(subD.reader, decoder, subD.state, 5000))) fail('sse D2: no connected frame')
    const pushedCD = await conformancePush(target, c, 'cc-sse-c', [
      conformanceTopicOp('cc-sse-op-2', 'cc-sse-t-2', 'cc-sse-c', 1001)
    ])
    expectStatus(pushedCD.status, 200, 'sse push CD', pushedCD.body)
    const hintD2 = await readSseFrame(subD.reader, decoder, subD.state, 5000)
    if (hintD2 === null || !hintD2.includes('event: sync')) fail('sse D2: missing sync hint')
    const resub = await fetch(`${baseOf(target)}/sync/subscribe?cursor=0`, {
      headers: credHeaders(target, a)
    })
    expectStatus(resub.status, 403, 'departed resubscribe', {})
    await resub.text().catch(() => '')
    try {
      subD.controller.abort()
    } catch {}
    try {
      await subD.reader.cancel().catch(() => {})
    } catch {}
  } finally {
    for (const ctl of controllers) {
      try {
        ctl.abort()
      } catch {}
    }
    try {
      await subB.reader.cancel().catch(() => {})
    } catch {}
    try {
      await subProbe.reader.cancel().catch(() => {})
    } catch {}
  }
}

/**
 * Run the full shared core sequence against one relay instance. Each case
 * registers fresh devices so cases stay independent on a shared relay.
 */
export async function runRelayConformanceCore(target: ConformanceTarget): Promise<void> {
  if (!target || typeof target.endpoint !== 'string' || target.endpoint.length === 0) {
    fail('runRelayConformanceCore requires endpoint')
  }
  if (!target.token || typeof target.token !== 'string') fail('runRelayConformanceCore requires token')
  await conformanceRegistrationReattach(target)
  await conformanceUnknownCredential(target)
  await conformanceAuthFailClosed(target)
  await conformanceRequestLifecycle(target)
  await conformanceAcceptCreateJoinNoMerge(target)
  await conformanceUnpairDissolve(target)
  await conformancePairingRequired(target)
  await conformanceDeviceIdentityBinding(target)
  await conformanceTwoChannelIsolation(target)
  await conformanceReplayCollision(target)
  await conformanceSseIsolationClose(target)
}
