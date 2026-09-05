import type {
  SyncPairingRequest,
  SyncPairingStatus,
  SyncPullResponse,
  SyncPushRequest,
  SyncTrustedDevice
} from '@shared/sync'
import {
  isValidSyncDeviceAuth,
  isValidSyncDeviceId,
  normalizePairingCode,
  SYNC_DEVICE_AUTH_HEADER,
  SYNC_DEVICE_ID_HEADER,
  SYNC_REQUEST_TIMEOUT_MS,
  validatePairingCode,
  validateSyncDeviceName,
  validateSyncEndpointUrl,
  validateSyncOperationStrict
} from '@shared/sync'

export function validateEndpointUrl(raw: string): string | null {
  return validateSyncEndpointUrl(raw)
}

/**
 * Strict canonical request/response cursor guard (LOCK-RT-002): only
 * canonical non-negative safe integers are accepted. Local to SyncClient so
 * no import cycle with SyncService arises; the rule mirrors
 * `parseStrictCursor` number branch exactly (typeof number +
 * Number.isSafeInteger + >= 0, never reinterpreted).
 */
function assertSafeCursor(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where} malformed: cursor must be non-negative safe integer`)
  }
  return value
}

export class SyncClient {
  /**
   * Device-identity headers (F-001): every device-authenticated call proves
   * the header identity with the per-device credential. The credential is
   * never logged; validation failures throw before transport.
   */
  private deviceHeaders(deviceId: string, deviceAuth?: string): Record<string, string> {
    if (!isValidSyncDeviceId(deviceId)) throw new Error('device id invalid')
    const headers: Record<string, string> = { [SYNC_DEVICE_ID_HEADER]: deviceId }
    if (deviceAuth !== undefined) {
      if (!isValidSyncDeviceAuth(deviceAuth)) throw new Error('device auth invalid')
      headers[SYNC_DEVICE_AUTH_HEADER] = deviceAuth
    }
    return headers
  }

  private parseIssuedDeviceAuth(data: unknown): string | undefined {
    const auth = (data as { deviceAuth?: unknown })?.deviceAuth
    if (auth === undefined) return undefined
    if (!isValidSyncDeviceAuth(auth)) throw new Error('device auth response malformed')
    return auth
  }

  /**
   * AUD-002: relay error bodies may carry the freshly issued credential
   * (founder bootstrap rejection still issues once so the caller is never
   * enrolled-without-credential). The human-readable message must never
   * contain the secret — strip `deviceAuth` before embedding the body in the
   * error text. The credential itself travels only on the error object.
   */
  private redactedRelayErrorText(text: string): string {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && 'deviceAuth' in parsed) {
        const rest = { ...parsed }
        delete rest.deviceAuth
        return JSON.stringify(rest).slice(0, 500)
      }
    } catch {}
    return text.slice(0, 500)
  }

  async push(
    endpoint: string,
    token: string | undefined,
    req: SyncPushRequest,
    externalSignal?: AbortSignal,
    deviceAuth?: string
  ): Promise<{ cursor: number; acceptedIds: string[]; deviceAuth?: string }> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    const url = endpoint.replace(/\/$/, '') + '/sync/push'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS)
    const onExternalAbort = (): void => {
      try {
        controller.abort()
      } catch {}
    }
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.deviceHeaders(req.deviceId, deviceAuth)
      }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // Founder-bootstrap lockout guard: a rejection that still issues the
        // device credential carries it on the error for durable persistence
        // before the caller fails. Never logged; the secret never enters the
        // message text.
        const issued = this.extractDeviceAuthFromBody(text)
        const err = new Error(`push failed ${res.status}: ${this.redactedRelayErrorText(text)}`)
        if (issued) (err as { deviceAuth?: string }).deviceAuth = issued
        throw err
      }
      const data = (await res.json()) as { cursor: number; acceptedIds: string[] }
      // F-003: parse the issued credential BEFORE any schema validation so a
      // malformed 2xx never drops an issued secret. Later failures rethrow
      // with the credential on the error carrier only (never in the text).
      const issuedEarly = this.parseIssuedDeviceAuth(data)
      const throwPushWithCredential = (message: string): never => {
        const err = new Error(message)
        if (issuedEarly !== undefined) (err as { deviceAuth?: string }).deviceAuth = issuedEarly
        throw err
      }
      if (!data || typeof data !== 'object' || !Array.isArray((data as any).acceptedIds)) {
        throwPushWithCredential('push response malformed: acceptedIds must be array')
      }
      if (
        typeof (data as any).cursor !== 'number' ||
        !Number.isSafeInteger((data as any).cursor) ||
        (data as any).cursor < 0
      ) {
        throwPushWithCredential('push response malformed: cursor must be non-negative safe integer')
      }
      for (const id of (data as any).acceptedIds) {
        if (typeof id !== 'string' || id.length === 0) {
          throwPushWithCredential('push response malformed: acceptedIds must be non-empty strings')
        }
      }
      return issuedEarly
        ? { ...(data as { cursor: number; acceptedIds: string[] }), deviceAuth: issuedEarly }
        : (data as { cursor: number; acceptedIds: string[] })
    } catch (e) {
      if ((e as Error).name === 'AbortError' && externalSignal?.aborted) throw e
      if ((e as Error).name === 'AbortError') throw new Error(`push timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
      // AUD-002: the unified catch must not drop a validated issued
      // credential carried on the transport error — re-attach it to the
      // wrapped error so a bootstrap rejection/retry never locks out.
      const issuedOnError = (e as { deviceAuth?: unknown })?.deviceAuth
      if (isValidSyncDeviceAuth(issuedOnError)) {
        const wrapped = new Error(e instanceof Error ? e.message : String(e))
        ;(wrapped as { deviceAuth?: string }).deviceAuth = issuedOnError
        throw wrapped
      }
      if (e instanceof Error) throw e
      throw new Error(String(e))
    } finally {
      clearTimeout(timeout)
      if (externalSignal) {
        try {
          externalSignal.removeEventListener('abort', onExternalAbort)
        } catch {}
      }
    }
  }

  async pull(
    endpoint: string,
    token: string | undefined,
    cursor: number,
    deviceId: string,
    externalSignal?: AbortSignal,
    deviceAuth?: string
  ): Promise<SyncPullResponse> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    // Strict request cursor (LOCK-RT-002): never stringify a malformed or
    // unsafe cursor into the relay request; fail closed before any transport.
    assertSafeCursor(cursor, 'pull request')
    if (!isValidSyncDeviceId(deviceId)) throw new Error('device id invalid')
    if (deviceAuth !== undefined && !isValidSyncDeviceAuth(deviceAuth)) throw new Error('device auth invalid')
    const url = new URL(endpoint.replace(/\/$/, '') + '/sync/pull')
    url.searchParams.set('cursor', String(cursor))
    url.searchParams.set('deviceId', deviceId)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS)
    const onExternalAbort = (): void => {
      try {
        controller.abort()
      } catch {}
    }
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      const headers: Record<string, string> = { ...this.deviceHeaders(deviceId, deviceAuth) }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const issued = this.extractDeviceAuthFromBody(text)
        const err = new Error(`pull failed ${res.status}: ${this.redactedRelayErrorText(text)}`)
        if (issued) (err as { deviceAuth?: string }).deviceAuth = issued
        throw err
      }
      const data = (await res.json()) as SyncPullResponse & { operations: Array<Record<string, unknown>> }
      // F-002 bootstrap-lockout guard: extract the relay-issued credential
      // BEFORE any business validation so a legal-JSON but semantically
      // illegal page never drops the founder credential. Validation failures
      // below rethrow with the credential attached (secret only on the error
      // object, never in the message). A malformed credential itself throws
      // here with no carrier.
      const issuedEarly = this.parseIssuedDeviceAuth(data)
      const throwWithCredential = (message: string): never => {
        const err = new Error(message)
        if (issuedEarly !== undefined) (err as { deviceAuth?: string }).deviceAuth = issuedEarly
        throw err
      }
      if (!data || typeof data !== 'object' || !Array.isArray(data.operations)) {
        throwWithCredential('pull response malformed: operations must be array')
      }
      if (typeof data.cursor !== 'number' || !Number.isSafeInteger(data.cursor) || data.cursor < 0) {
        throwWithCredential('pull response malformed: cursor must be non-negative safe integer')
      }
      // Strict pull framing: every operation requires a positive integer seq;
      // cursor/operation consistency is validated before any application.
      // Contiguous framing: each op seq must equal request cursor + position
      // (cursor+1, cursor+2, ...). A gap rejects before any application or
      // cursor advance so a missing operation can never be skipped as success.
      // A malformed frame surfaces as a durable sync failure upstream, never
      // silently applied or skipped. Throw here so SyncService records
      // lastError truthfully and does not advance the cursor or report success.
      let prevSeq = cursor
      for (let i = 0; i < data.operations.length; i++) {
        const op = data.operations[i]
        const rec = op as Record<string, unknown>
        const seq: unknown = rec['seq']
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) {
          throwWithCredential(`pull response malformed: invalid seq for ${String(rec['id'] ?? '')}`)
        }
        const seqNum = seq as number
        const expectedSeq = prevSeq + 1
        if (seqNum !== expectedSeq) {
          throwWithCredential(
            `pull response non-contiguous: expected seq ${String(expectedSeq)} at position ${String(i)} but got ${String(seqNum)} (request cursor ${String(cursor)})`
          )
        }
        prevSeq = seqNum
        const err = validateSyncOperationStrict(op)
        if (err) {
          throwWithCredential(`pull response malformed operation ${String(rec['id'] ?? '')}: ${err}`)
        }
      }
      if (data.operations.length > 0) {
        const lastSeq = (data.operations[data.operations.length - 1] as Record<string, unknown>)['seq'] as number
        if (data.cursor !== lastSeq) {
          throwWithCredential(
            `pull response malformed: cursor ${String(data.cursor)} must equal last seq ${String(lastSeq)}`
          )
        }
      } else if (data.cursor !== cursor) {
        throwWithCredential(
          `pull response malformed: empty-page cursor ${String(data.cursor)} must equal request cursor ${String(cursor)}`
        )
      }
      return issuedEarly ? { ...data, deviceAuth: issuedEarly } : data
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (externalSignal?.aborted) throw e
        throw new Error(`pull timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
      }
      throw e
    } finally {
      clearTimeout(timeout)
      if (externalSignal) {
        try {
          externalSignal.removeEventListener('abort', onExternalAbort)
        } catch {}
      }
    }
  }

  private extractDeviceAuthFromBody(text: string): string | undefined {
    try {
      const parsed = JSON.parse(text) as { deviceAuth?: unknown }
      if (isValidSyncDeviceAuth(parsed?.deviceAuth)) return parsed.deviceAuth
    } catch {}
    return undefined
  }

  private async requestJson(
    endpoint: string,
    token: string | undefined,
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string>; deviceId?: string; deviceAuth?: string },
    externalSignal?: AbortSignal
  ): Promise<any> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    const base = endpoint.replace(/\/$/, '')
    const url = new URL(base + path)
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS)
    const onExternalAbort = (): void => {
      try {
        controller.abort()
      } catch {}
    }
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`
      if (init.deviceId !== undefined) Object.assign(headers, this.deviceHeaders(init.deviceId, init.deviceAuth))
      else if (init.deviceAuth !== undefined) throw new Error('device auth requires device id')
      if (init.body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await fetch(url.toString(), {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // Preserve a validated issued credential on pairing errors too so a
        // bootstrap-adjacent rejection never strands the device. The secret
        // never enters the message text.
        const issued = this.extractDeviceAuthFromBody(text)
        const err = new Error(`pairing request failed ${res.status}: ${this.redactedRelayErrorText(text)}`)
        if (issued) (err as { deviceAuth?: string }).deviceAuth = issued
        throw err
      }
      return await res.json()
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (externalSignal?.aborted) throw e
        throw new Error(`pairing timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
      }
      throw e
    } finally {
      clearTimeout(timeout)
      if (externalSignal) {
        try {
          externalSignal.removeEventListener('abort', onExternalAbort)
        } catch {}
      }
    }
  }

  private assertPairingTransport(endpoint: string, deviceId: string, deviceName?: string): void {
    const endpointErr = validateEndpointUrl(endpoint)
    if (endpointErr) throw new Error(endpointErr)
    if (!isValidSyncDeviceId(deviceId)) throw new Error('device id invalid')
    const nameErr = validateSyncDeviceName(deviceName ?? undefined)
    if (nameErr) throw new Error(nameErr)
  }

  async createInvite(
    endpoint: string,
    token: string | undefined,
    deviceId: string,
    deviceAuth?: string
  ): Promise<{ code: string; expiresAt: string; deviceAuth?: string }> {
    this.assertPairingTransport(endpoint, deviceId)
    if (deviceAuth !== undefined && !isValidSyncDeviceAuth(deviceAuth)) throw new Error('device auth invalid')
    const data = await this.requestJson(endpoint, token, '/sync/pair/invite', {
      method: 'POST',
      body: { deviceId },
      deviceId,
      deviceAuth
    })
    // F-003: credential first — any later schema failure carries it.
    const issuedEarly = this.parseIssuedDeviceAuth(data)
    const throwInviteWithCredential = (message: string): never => {
      const err = new Error(message)
      if (issuedEarly !== undefined) (err as { deviceAuth?: string }).deviceAuth = issuedEarly
      throw err
    }
    if (!data || typeof data.code !== 'string' || typeof data.expiresAt !== 'string') {
      throwInviteWithCredential('pairing invite response malformed')
    }
    const codeErr = validatePairingCode(data.code)
    if (codeErr) throwInviteWithCredential(`pairing invite response malformed: ${codeErr}`)
    return issuedEarly
      ? { code: data.code as string, expiresAt: data.expiresAt as string, deviceAuth: issuedEarly }
      : { code: data.code as string, expiresAt: data.expiresAt as string }
  }

  async requestPairing(
    endpoint: string,
    token: string | undefined,
    args: { deviceId: string; deviceName?: string; code: string }
  ): Promise<{ requestId: string; status: string; deviceAuth: string }> {
    this.assertPairingTransport(endpoint, args.deviceId, args.deviceName)
    const codeErr = validatePairingCode(args.code)
    if (codeErr) throw new Error(codeErr)
    const data = await this.requestJson(endpoint, token, '/sync/pair/request', {
      method: 'POST',
      body: { deviceId: args.deviceId, deviceName: args.deviceName, code: normalizePairingCode(args.code) }
    })
    // F-003: credential first — schema failures still carry an issued secret.
    const issuedEarly = this.parseIssuedDeviceAuth(data)
    const throwRequestWithCredential = (message: string): never => {
      const err = new Error(message)
      if (issuedEarly !== undefined) (err as { deviceAuth?: string }).deviceAuth = issuedEarly
      throw err
    }
    if (!data || typeof data.requestId !== 'string') {
      throwRequestWithCredential('pairing request response malformed')
    }
    if (!issuedEarly) throw new Error('pairing request response malformed: missing device auth')
    return { requestId: data.requestId as string, status: String(data.status ?? 'pending'), deviceAuth: issuedEarly }
  }

  async listPending(
    endpoint: string,
    token: string | undefined,
    deviceId: string,
    deviceAuth?: string
  ): Promise<{ requests: SyncPairingRequest[] }> {
    this.assertPairingTransport(endpoint, deviceId)
    if (deviceAuth !== undefined && !isValidSyncDeviceAuth(deviceAuth)) throw new Error('device auth invalid')
    const data = await this.requestJson(endpoint, token, '/sync/pair/pending', {
      method: 'GET',
      query: { deviceId },
      deviceId,
      deviceAuth
    })
    if (!data || !Array.isArray(data.requests)) throw new Error('pending response malformed')
    return { requests: data.requests as SyncPairingRequest[] }
  }

  async acceptPairing(
    endpoint: string,
    token: string | undefined,
    args: { approverDeviceId: string; requestId: string },
    deviceAuth?: string
  ): Promise<{ trusted: SyncTrustedDevice }> {
    if (!isValidSyncDeviceId(args.approverDeviceId)) throw new Error('device id invalid')
    if (typeof args.requestId !== 'string' || args.requestId.length === 0) throw new Error('request id invalid')
    if (deviceAuth !== undefined && !isValidSyncDeviceAuth(deviceAuth)) throw new Error('device auth invalid')
    const data = await this.requestJson(endpoint, token, '/sync/pair/accept', {
      method: 'POST',
      body: args,
      deviceId: args.approverDeviceId,
      deviceAuth
    })
    if (!data || typeof data.trusted !== 'object') throw new Error('accept response malformed')
    return { trusted: data.trusted as SyncTrustedDevice }
  }

  async rejectPairing(
    endpoint: string,
    token: string | undefined,
    args: { approverDeviceId: string; requestId: string },
    deviceAuth?: string
  ): Promise<void> {
    if (!isValidSyncDeviceId(args.approverDeviceId)) throw new Error('device id invalid')
    if (typeof args.requestId !== 'string' || args.requestId.length === 0) throw new Error('request id invalid')
    if (deviceAuth !== undefined && !isValidSyncDeviceAuth(deviceAuth)) throw new Error('device auth invalid')
    await this.requestJson(endpoint, token, '/sync/pair/reject', {
      method: 'POST',
      body: args,
      deviceId: args.approverDeviceId,
      deviceAuth
    })
  }

  async listTrusted(
    endpoint: string,
    token: string | undefined,
    deviceId: string,
    deviceAuth?: string
  ): Promise<{ devices: SyncTrustedDevice[] }> {
    this.assertPairingTransport(endpoint, deviceId)
    if (deviceAuth !== undefined && !isValidSyncDeviceAuth(deviceAuth)) throw new Error('device auth invalid')
    const data = await this.requestJson(endpoint, token, '/sync/pair/trusted', {
      method: 'GET',
      query: { deviceId },
      deviceId,
      deviceAuth
    })
    if (!data || !Array.isArray(data.devices)) throw new Error('trusted response malformed')
    return { devices: data.devices as SyncTrustedDevice[] }
  }

  async getPairingStatus(endpoint: string, token: string | undefined, deviceId: string): Promise<SyncPairingStatus> {
    this.assertPairingTransport(endpoint, deviceId)
    const data = await this.requestJson(endpoint, token, '/sync/pair/status', {
      method: 'GET',
      query: { deviceId }
    })
    if (!data || typeof data.trusted !== 'boolean' || typeof data.pending !== 'boolean') {
      throw new Error('pairing status response malformed')
    }
    return { trusted: data.trusted as boolean, pending: data.pending as boolean }
  }

  async revokeDevice(
    endpoint: string,
    token: string | undefined,
    args: { approverDeviceId: string; targetDeviceId: string },
    deviceAuth?: string
  ): Promise<void> {
    if (!isValidSyncDeviceId(args.approverDeviceId)) throw new Error('device id invalid')
    if (!isValidSyncDeviceId(args.targetDeviceId)) throw new Error('device id invalid')
    if (deviceAuth !== undefined && !isValidSyncDeviceAuth(deviceAuth)) throw new Error('device auth invalid')
    await this.requestJson(endpoint, token, '/sync/pair/revoke', {
      method: 'POST',
      body: args,
      deviceId: args.approverDeviceId,
      deviceAuth
    })
  }
}

export const syncClient = new SyncClient()
