import type { SyncPullResponse, SyncPushRequest } from '@shared/sync'
import { SYNC_REQUEST_TIMEOUT_MS } from '@shared/sync'

export function validateEndpointUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return 'endpoint is required'
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'endpoint is required'
  if (trimmed.length > 2048) return 'endpoint too long'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'endpoint must be a valid URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'endpoint must be http or https'
  }
  return null
}

export class SyncClient {
  async push(
    endpoint: string,
    token: string | undefined,
    req: SyncPushRequest
  ): Promise<{ cursor: number; acceptedIds: string[] }> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    const url = endpoint.replace(/\/$/, '') + '/sync/push'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`push failed ${res.status}: ${text.slice(0, 500)}`)
      }
      const data = (await res.json()) as { cursor: number; acceptedIds: string[] }
      return data
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if ((e as Error).name === 'AbortError') throw new Error(`push timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
      throw new Error(msg)
    } finally {
      clearTimeout(timeout)
    }
  }

  async pull(endpoint: string, token: string | undefined, cursor: number, deviceId: string): Promise<SyncPullResponse> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    const url = new URL(endpoint.replace(/\/$/, '') + '/sync/pull')
    url.searchParams.set('cursor', String(cursor))
    url.searchParams.set('deviceId', deviceId)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`pull failed ${res.status}: ${text.slice(0, 500)}`)
      }
      const data = (await res.json()) as SyncPullResponse
      return data
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error(`pull timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
      throw e
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const syncClient = new SyncClient()
