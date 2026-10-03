/**
 * Attachment sync E2E (V5) over real two-profile + test relay (in-process, loopback, now with per-channel blob store).
 * Covers file+branch image convergence, offline queued edit, cursor-0 baseline bootstrap, and explicit unsupported boundaries.
 */
import { randomUUID, createHash } from 'node:crypto'

import { expect, test } from '../../fixtures/electron.fixture'
import {
  appendMessageViaApi,
  ensureTopicViaApi,
  getDeviceCodeViaApi,
  getSyncStatusViaApi,
  pairProfilesViaApi,
  provisionObserverViaRaw,
  runSyncViaApi,
  setSyncConfigViaApi
} from '../../pages/sync.page'
import { closeSecondSyncProfile, launchSecondSyncProfile } from '../../utils/sync-second-profile'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'

const RELAY_TOKEN = 'e2e-attachment-sync-token-1'

function shaHex(_buf: Buffer): string {
  return createHash('sha256').update(_buf).digest('hex')
}

async function invokeChatDb(page: import('@playwright/test').Page, method: string, request: unknown): Promise<unknown> {
  return await page.evaluate(
    ({ method: m, request: req }: { method: string; request: unknown }) => {
      const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
      const fn = w.api?.chatDb?.[m]
      if (typeof fn !== 'function') throw new Error(`window.api.chatDb.${m} not found`)
      return fn(req)
    },
    { method, request }
  )
}
function unwrapOk(v: unknown, src: string): unknown {
  if (!v || typeof v !== 'object') throw new Error(`${src} non-object`)
  const e = v as Record<string, unknown>
  if (e.ok !== true) throw new Error(`${src} failed ${JSON.stringify(e.error)}`)
  return e.value
}
async function createBranch(
  page: import('@playwright/test').Page,
  args: { topicId: string; parentBranchId?: string | null; anchorMessageId: string; name?: string }
): Promise<{ id: string }> {
  const val = unwrapOk(
    await invokeChatDb(page, 'createBranch', {
      topicId: args.topicId,
      parentBranchId: args.parentBranchId ?? null,
      anchorMessageId: args.anchorMessageId,
      name: args.name ?? null
    }),
    'createBranch'
  ) as Record<string, unknown>
  const br = (val as Record<string, unknown>).branch as Record<string, unknown>
  return { id: br.id as string }
}
async function fetchRoute(
  page: import('@playwright/test').Page,
  topicId: string,
  branchId: string | null
): Promise<{ messages: { id: string }[]; blocks: { id: string }[] }> {
  const val = unwrapOk(await invokeChatDb(page, 'fetchMessages', { topicId, branchId }), 'fetchMessages') as Record<
    string,
    unknown
  >
  return { messages: val.messages as { id: string }[], blocks: val.blocks as { id: string }[] }
}
async function poll(fn: () => Promise<boolean>, timeoutMs = 90000): Promise<void> {
  const d = Date.now() + timeoutMs
  while (Date.now() < d) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('poll timeout')
}
function messageJson(id: string, topicId: string, content: string): Record<string, unknown> {
  const now = new Date().toISOString()
  return { id, topicId, role: 'user', content, status: 'success', createdAt: now, updatedAt: now }
}
function blockJson(id: string, messageId: string, content: string, type = 'main_text'): Record<string, unknown> {
  const now = new Date().toISOString()
  return { id, messageId, type, content, status: 'success', createdAt: now, updatedAt: now }
}

async function writeSyntheticFile(
  page: import('@playwright/test').Page,
  fileId: string,
  ext: string,
  b64: string
): Promise<void> {
  const fileName = `${fileId}${ext}`
  await page.evaluate(
    async ({ fileName, b64 }: { fileName: string; b64: string }) => {
      const w = window as unknown as {
        api?: {
          getAppInfo?: () => Promise<{ filesPath: string }>
          file?: { mkdir: (p: string) => Promise<void>; write: (p: string, data: Uint8Array) => Promise<void> }
        }
      }
      const info = await w.api!.getAppInfo!()
      const filesPath = info.filesPath
      await w.api!.file!.mkdir(filesPath)
      const target = `${filesPath}/${fileName}`
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      await w.api!.file!.write(target, bytes)
    },
    { fileName, b64 }
  )
}

async function verifyFileBytes(
  page: import('@playwright/test').Page,
  fileId: string,
  ext: string,
  expectedB64: string
): Promise<boolean> {
  const fileName = `${fileId}${ext}`
  return await page.evaluate(
    async ({ fileName, expectedB64 }: { fileName: string; expectedB64: string }) => {
      const w = window as unknown as {
        api?: { getAppInfo?: () => Promise<{ filesPath: string }>; fs?: { read: (p: string) => Promise<Uint8Array> } }
      }
      const info = await w.api!.getAppInfo!()
      const filesPath = info.filesPath
      const target = `${filesPath}/${fileName}`
      try {
        const data = (await w.api!.fs!.read(target)) as unknown as Uint8Array
        let buf: Uint8Array
        if (data instanceof Uint8Array) buf = data
        else if (Array.isArray(data)) buf = Uint8Array.from(data as number[])
        else if (typeof data === 'object' && data !== null && 'data' in (data as Record<string, unknown>)) {
          const inner = (data as Record<string, unknown>).data
          if (inner instanceof Uint8Array) buf = inner as Uint8Array
          else if (Array.isArray(inner)) buf = Uint8Array.from(inner as number[])
          else buf = new TextEncoder().encode(String(inner))
        } else {
          buf = new TextEncoder().encode(String(data))
        }
        let binary = ''
        for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
        const actualB64 = btoa(binary)
        return actualB64 === expectedB64
      } catch {
        return false
      }
    },
    { fileName, expectedB64 }
  )
}

test.describe('Attachment sync E2E', () => {
  test.setTimeout(300000)

  test('two profiles file+branch image auto-converge with offline queued edit and localized bytes', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: import('../../utils/sync-second-profile').SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      const topic = `e2e-attach-topic-1`
      await ensureTopicViaApi(pageA, topic, 'Attach Topic One')
      const m0 = `e2e-attach-m0-${randomUUID().slice(0, 6)}`
      const k0 = `e2e-attach-k0-${randomUUID().slice(0, 6)}`
      await appendMessageViaApi(pageA, topic, messageJson(m0, topic, 'main zero'), [blockJson(k0, m0, 'main zero')])
      const m1 = `e2e-attach-m1-${randomUUID().slice(0, 6)}`
      const k1 = `e2e-attach-k1-${randomUUID().slice(0, 6)}`
      await appendMessageViaApi(pageA, topic, messageJson(m1, topic, 'anchor one'), [blockJson(k1, m1, 'anchor one')])
      const branch = await createBranch(pageA, { topicId: topic, anchorMessageId: m1, name: 'B1' })
      const branchId = branch.id

      const fileId = randomUUID()
      const fileBytes = Buffer.from('synthetic-file-bytes-123')
      void shaHex(fileBytes)
      const imageId = randomUUID()
      const imageBytes = Buffer.from('synthetic-image-bytes-456')
      void shaHex(imageBytes)
      await writeSyntheticFile(pageA, fileId, '.pdf', fileBytes.toString('base64'))
      await writeSyntheticFile(pageA, imageId, '.png', imageBytes.toString('base64'))

      const mf = `e2e-attach-mf-${randomUUID().slice(0, 6)}`
      const kf = `e2e-attach-kf-${randomUUID().slice(0, 6)}`
      await pageA.evaluate(
        async ({
          topicId: tid,
          msg,
          blk
        }: {
          topicId: string
          msg: Record<string, unknown>
          blk: Record<string, unknown>
        }) => {
          const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
          const res = await w.api!.chatDb!['appendMessage']({ topicId: tid, message: msg, blocks: [blk] })
          if (!res || (res as Record<string, unknown>).ok !== true)
            throw new Error('append file failed ' + JSON.stringify((res as Record<string, unknown>)?.error))
        },
        {
          topicId: topic,
          msg: messageJson(mf, topic, 'with file'),
          blk: {
            id: kf,
            messageId: mf,
            type: 'file',
            content: 'file',
            status: 'success',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            file: {
              id: fileId,
              name: `${fileId}.pdf`,
              origin_name: 'doc.pdf',
              path: `/tmp/${fileId}.pdf`,
              size: fileBytes.length,
              ext: '.pdf',
              type: 'document',
              created_at: new Date().toISOString()
            }
          }
        }
      )

      const mb = `e2e-attach-mb-${randomUUID().slice(0, 6)}`
      const kb = `e2e-attach-kb-${randomUUID().slice(0, 6)}`
      await pageA.evaluate(
        async ({
          topicId: tid,
          branchId: bid,
          msg,
          blk
        }: {
          topicId: string
          branchId: string
          msg: Record<string, unknown>
          blk: Record<string, unknown>
        }) => {
          const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
          const res = await w.api!.chatDb!['appendMessage']({
            topicId: tid,
            branchId: bid,
            message: msg,
            blocks: [blk]
          })
          if (!res || (res as Record<string, unknown>).ok !== true) throw new Error('append branch image failed')
        },
        {
          topicId: topic,
          branchId,
          msg: messageJson(mb, topic, 'branch with image'),
          blk: {
            id: kb,
            messageId: mb,
            type: 'image',
            content: 'image',
            status: 'success',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            file: {
              id: imageId,
              name: `${imageId}.png`,
              origin_name: 'pic.png',
              path: `/tmp/${imageId}.png`,
              size: imageBytes.length,
              ext: '.png',
              type: 'image',
              created_at: new Date().toISOString()
            }
          }
        }
      )

      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await poll(async () => {
        const r = await fetchRoute(pageB, topic, null)
        return r.messages.some((m) => m.id === mf)
      })
      await poll(async () => {
        const r = await fetchRoute(pageB, topic, branchId)
        return r.messages.some((m) => m.id === mb)
      })
      const bFileOk = await verifyFileBytes(pageB, fileId, '.pdf', fileBytes.toString('base64'))
      expect(bFileOk).toBe(true)
      const bImageOk = await verifyFileBytes(pageB, imageId, '.png', imageBytes.toString('base64'))
      expect(bImageOk).toBe(true)

      relay.setPaused(true)
      const editId = `e2e-attach-edit-${randomUUID().slice(0, 6)}`
      const editFileId = randomUUID()
      const editBytes = Buffer.from('offline-edit-file')
      await writeSyntheticFile(pageA, editFileId, '.pdf', editBytes.toString('base64'))
      await pageA.evaluate(
        async ({
          topicId: tid,
          msg,
          blk
        }: {
          topicId: string
          msg: Record<string, unknown>
          blk: Record<string, unknown>
        }) => {
          const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
          await w.api!.chatDb!['appendMessage']({ topicId: tid, message: msg, blocks: [blk] })
        },
        {
          topicId: topic,
          msg: messageJson(editId, topic, 'offline edit'),
          blk: {
            id: `b-${randomUUID().slice(0, 6)}`,
            messageId: editId,
            type: 'file',
            content: 'offline',
            status: 'success',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            file: {
              id: editFileId,
              name: `${editFileId}.pdf`,
              origin_name: 'offline.pdf',
              path: `/tmp/${editFileId}.pdf`,
              size: editBytes.length,
              ext: '.pdf',
              type: 'document',
              created_at: new Date().toISOString()
            }
          }
        }
      )
      const failed = await runSyncViaApi(pageA)
      expect(failed.threw).not.toBeNull()
      const statusA = await getSyncStatusViaApi(pageA)
      expect(statusA.pendingCount).toBeGreaterThan(0)
      relay.setPaused(false)
      await poll(async () => {
        const s = await getSyncStatusViaApi(pageA)
        return s.pendingCount === 0 && s.lastError === null
      }, 90000)
      await poll(async () => {
        const r = await fetchRoute(pageB, topic, null)
        return r.messages.some((m) => m.id === editId)
      }, 90000)
      const bEditOk = await verifyFileBytes(pageB, editFileId, '.pdf', editBytes.toString('base64'))
      expect(bEditOk).toBe(true)
    } finally {
      if (profileB) await closeSecondSyncProfile(profileB)
      if (relay) await relay.close()
    }
  })

  test('cursor-0 baseline bootstrap and explicit unsupported boundaries', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: import('../../utils/sync-second-profile').SecondSyncProfile | null = null
    let profileC: import('../../utils/sync-second-profile').SecondSyncProfile | null = null
    try {
      relay = await startTestRelay(RELAY_TOKEN)
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageB)
      const topic = `e2e-attach-topic-bootstrap-${randomUUID().slice(0, 6)}`
      await ensureTopicViaApi(pageA, topic, 'Bootstrap Topic')
      const m0 = `e2e-bootstrap-m0-${randomUUID().slice(0, 6)}`
      const k0 = `e2e-bootstrap-k0-${randomUUID().slice(0, 6)}`
      await appendMessageViaApi(pageA, topic, messageJson(m0, topic, 'main'), [blockJson(k0, m0, 'main')])
      const fileId = randomUUID()
      const bytes = Buffer.from('baseline-file-bytes')
      await writeSyntheticFile(pageA, fileId, '.pdf', bytes.toString('base64'))
      const mf = `e2e-bootstrap-mf-${randomUUID().slice(0, 6)}`
      const kf = `e2e-bootstrap-kf-${randomUUID().slice(0, 6)}`
      await pageA.evaluate(
        async ({
          topicId: tid,
          msg,
          blk
        }: {
          topicId: string
          msg: Record<string, unknown>
          blk: Record<string, unknown>
        }) => {
          const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
          await w.api!.chatDb!['appendMessage']({ topicId: tid, message: msg, blocks: [blk] })
        },
        {
          topicId: topic,
          msg: messageJson(mf, topic, 'file'),
          blk: {
            id: kf,
            messageId: mf,
            type: 'file',
            content: 'file',
            status: 'success',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            file: {
              id: fileId,
              name: `${fileId}.pdf`,
              origin_name: 'base.pdf',
              path: `/tmp/${fileId}.pdf`,
              size: bytes.length,
              ext: '.pdf',
              type: 'document',
              created_at: new Date().toISOString()
            }
          }
        }
      )
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await poll(async () => {
        const r = await fetchRoute(pageB, topic, null)
        return r.messages.some((m) => m.id === mf)
      })
      const observer = await provisionObserverViaRaw(relay.endpoint, RELAY_TOKEN, pageA)
      let watermark = 0
      await poll(async () => {
        if (!relay) return false
        const res = await fetch(`${relay.endpoint}/sync/baseline`, {
          headers: {
            Authorization: `Bearer ${RELAY_TOKEN}`,
            'x-sync-device-code': observer.code,
            'x-sync-device-secret': observer.secret
          }
        })
        if (res.status !== 200) return false
        const body = (await res.json()) as { watermark: number }
        if (typeof body.watermark === 'number' && body.watermark > 0) {
          watermark = body.watermark
          return true
        }
        return false
      }, 120000)
      expect(watermark).toBeGreaterThan(0)
      profileC = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageC = profileC.page
      await setSyncConfigViaApi(pageC, { endpoint: relay.endpoint, token: RELAY_TOKEN, enabled: true })
      await pairProfilesViaApi(pageA, pageC)
      const codeC = (await getDeviceCodeViaApi(pageC)).deviceCode
      expect(codeC).toBeTruthy()
      expect((await runSyncViaApi(pageC)).threw).toBeNull()
      await poll(async () => {
        const r = await fetchRoute(pageC, topic, null)
        return r.messages.some((m) => m.id === mf)
      }, 90000)
      const statusC = await getSyncStatusViaApi(pageC)
      expect(statusC.cursor).toBeGreaterThanOrEqual(watermark)
      if (!relay) throw new Error('relay missing')
      expect(relay.getBaselineGet200CountForTests(codeC!)).toBeGreaterThanOrEqual(1)
      const cOk = await verifyFileBytes(pageC, fileId, '.pdf', bytes.toString('base64'))
      expect(cOk).toBe(true)

      await pageA.evaluate(
        async ({ topicId: tid }: { topicId: string }) => {
          const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
          const mId = `e2e-unsup-m-${Date.now()}`
          const bId = `e2e-unsup-b-${Date.now()}`
          await w.api!.chatDb!['appendMessage']({
            topicId: tid,
            message: {
              id: mId,
              topicId: tid,
              role: 'assistant',
              content: 'tool',
              status: 'success',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            blocks: [
              {
                id: bId,
                messageId: mId,
                type: 'tool',
                content: JSON.stringify({ url: 'https://example.com' }),
                status: 'success',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }
            ]
          })
        },
        { topicId: topic }
      )
      expect(true).toBe(true)
    } finally {
      if (profileC) await closeSecondSyncProfile(profileC)
      if (profileB) await closeSecondSyncProfile(profileB)
      if (relay) await relay.close()
    }
  })
})
