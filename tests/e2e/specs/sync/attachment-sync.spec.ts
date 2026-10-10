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
import {
  closeSecondSyncProfile,
  launchSecondSyncProfile,
  relaunchSecondSyncProfile
} from '../../utils/sync-second-profile'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'

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

// ---------------------------------------------------------------------------
// Valid-media fixtures + receiver rendering probes (V5 attachment-display
// coverage). Deterministic, owned, no network, no new runtime dependencies.
// Fixture sources:
// - PNG: deterministic 1x1 PNG reused from tests/e2e/utils/disposable-seed-zip.ts
// - TXT: inline UTF-8 text with a spaceless probe token (modal assertion safe)
// - PDF: locally generated minimal header-valid PDF (%PDF magic + %%EOF)
// - WAV: legally constructed minimal PCM (8kHz mono 16-bit sine, finite duration)
// - VIDEO (FILE-video): locally generated at runtime with the app's own
//   Chromium MediaRecorder (canvas captureStream, mp4 preferred when
//   supported else webm) — real encoder bytes, never a suffix-only fake.
// PORTABLE sync types file/image/video all carry a `file` object through the
// capture pipeline (see syncAttachmentChain.test.ts). FILE-video means block
// type 'file' with file.type 'video' (renders via MessageAttachments ->
// MediaAttachmentPreview [data-testid="media-video"]). Independent file-backed
// VIDEO (block type 'video' with a `file` DTO admitted through the same
// existing portable-media capture, rendering via MessageVideo from the local
// receiver file DTO/filePath without metadata.video) IS covered by the
// 'independent file-backed VIDEO' test below. Only the legacy metadata-only
// VIDEO path (url/filePath+metadata.video.path, without file refs) stays
// uncovered: admission requires overflow.file refs (assetIds) and metadata is
// outside the wire inventory, so that path needs a product change first — no
// false coverage is claimed for it (see the report).
// ---------------------------------------------------------------------------

/** Deterministic 1x1 PNG reused from tests/e2e/utils/disposable-seed-zip.ts. */
const DETERMINISTIC_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Legally constructed minimal PCM WAV (8kHz mono 16-bit sine): decodable, finite duration. */
function buildWavPcm16Mono8k(durationSec = 0.5, freqHz = 440, sampleRate = 8000): Buffer {
  const frames = Math.floor(sampleRate * durationSec)
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) {
    const s = Math.round(12000 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate))
    data.writeInt16LE(s, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** Real minimal header-valid PDF (single page, %PDF magic + %%EOF). */
function minimalPdfBytes(marker: string): Buffer {
  const text = `BT /F1 12 Tf 20 180 Td (${marker}) Tj ET`
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>endobj',
      `4 0 obj<</Length ${text.length}>>stream`,
      text,
      'endstream',
      'endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF',
      ''
    ].join('\n'),
    'utf8'
  )
}

async function fetchRouteFull(
  page: import('@playwright/test').Page,
  topicId: string,
  branchId: string | null
): Promise<{ messages: Record<string, unknown>[]; blocks: Record<string, unknown>[] }> {
  const val = unwrapOk(await invokeChatDb(page, 'fetchMessages', { topicId, branchId }), 'fetchMessages') as Record<
    string,
    unknown
  >
  return {
    messages: val.messages as Record<string, unknown>[],
    blocks: val.blocks as Record<string, unknown>[]
  }
}

async function getFilesPathViaApi(page: import('@playwright/test').Page): Promise<string> {
  return await page.evaluate(async () => {
    const w = window as unknown as { api?: { getAppInfo?: () => Promise<{ filesPath: string }> } }
    const info = await w.api!.getAppInfo!()
    return info.filesPath as string
  })
}

async function getReduxMessageIds(page: import('@playwright/test').Page, topicId: string): Promise<string[]> {
  return await page.evaluate((tid: string) => {
    const s = (
      window as unknown as {
        store?: { getState: () => { messages?: { messageIdsByTopic?: Record<string, string[]> } } }
      }
    ).store?.getState()
    return [...(s?.messages?.messageIdsByTopic?.[tid] ?? [])]
  }, topicId)
}

function fileDto(fileId: string, ext: string, originName: string, type: string, size: number): Record<string, unknown> {
  return {
    id: fileId,
    name: `${fileId}${ext}`,
    origin_name: originName,
    path: `/tmp/${fileId}${ext}`,
    size,
    ext,
    type,
    created_at: new Date().toISOString()
  }
}

async function appendFileBlockViaApi(
  page: import('@playwright/test').Page,
  args: {
    topicId: string
    branchId?: string | null
    messageId: string
    blockId: string
    blockType: string
    content: string
    file: Record<string, unknown>
  }
): Promise<void> {
  await page.evaluate(
    async (a: {
      topicId: string
      branchId: string | null
      messageId: string
      blockId: string
      blockType: string
      content: string
      file: Record<string, unknown>
    }) => {
      const w = window as unknown as { api?: { chatDb?: Record<string, (r: unknown) => Promise<unknown>> } }
      const now = new Date().toISOString()
      const res = await w.api!.chatDb!['appendMessage']({
        topicId: a.topicId,
        ...(a.branchId ? { branchId: a.branchId } : {}),
        message: {
          id: a.messageId,
          topicId: a.topicId,
          role: 'user',
          content: a.content,
          status: 'success',
          createdAt: now,
          updatedAt: now
        },
        blocks: [
          {
            id: a.blockId,
            messageId: a.messageId,
            type: a.blockType,
            content: a.content,
            status: 'success',
            createdAt: now,
            updatedAt: now,
            file: a.file
          }
        ]
      })
      if (!res || (res as Record<string, unknown>).ok !== true) throw new Error(`append ${a.blockType} failed`)
    },
    {
      topicId: args.topicId,
      branchId: args.branchId ?? null,
      messageId: args.messageId,
      blockId: args.blockId,
      blockType: args.blockType,
      content: args.content,
      file: args.file
    }
  )
}

/** Receiver FileMetadata must be readable, local (no sender /tmp leak), and field-exact. */
function expectLocalFileDto(
  blockFile: unknown,
  expected: { id: string; originName: string; ext: string; type: string; size: number },
  filesPath: string
): void {
  expect(blockFile, `block file DTO must exist for ${expected.id}`).not.toBeNull()
  const f = blockFile as Record<string, unknown>
  expect(f.id).toBe(expected.id)
  expect(f.name).toBe(`${expected.id}${expected.ext}`)
  expect(f.origin_name).toBe(expected.originName)
  expect(f.ext).toBe(expected.ext)
  expect(f.type).toBe(expected.type)
  expect(f.size).toBe(expected.size)
  expect(typeof f.path).toBe('string')
  const p = f.path as string
  expect(p.startsWith('/tmp/'), 'receiver path must not leak the sender /tmp path').toBe(false)
  expect(p.startsWith(filesPath), `receiver path must be local (${filesPath})`).toBe(true)
  expect(p).toContain(expected.id)
}

async function openTopicInUi(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await expect(item, 'synced topic must appear in the receiver sidebar').toHaveCount(1, { timeout: 30000 })
  await item.click()
  await page.waitForFunction(
    (expected: string) => {
      const s = (
        window as unknown as { store?: { getState: () => { messages?: { currentTopicId?: string } } } }
      ).store?.getState()
      return s?.messages?.currentTopicId === expected
    },
    topicId,
    { timeout: 15000 }
  )
}

/**
 * Owner-aware topic seeding for the receiver-sidebar UI tests only.
 * Production owner semantics: Main rows with a null assistantId exist by ID
 * (fetchMessages) yet are correctly filtered out of the per-assistant
 * directory (listLiveAssistantTopics), so the sidebar never shows them.
 * Reuses the shared-fixture active assistant context (actual selected topic
 * owner, never array[0]) on both ends; the sender ensures with that owning
 * id so the synced row carries the same owner the receiver directory reads.
 * No Redux injection and no production directory-semantics change.
 */
async function getActiveOwnerAssistantId(page: import('@playwright/test').Page): Promise<string> {
  return await page.evaluate(() => {
    const s = (window as unknown as { store?: { getState: () => unknown } }).store?.getState() as unknown as {
      messages?: { currentTopicId?: string }
      assistants?: { assistants?: Array<{ id?: string; topics?: Array<{ id?: string }> }> }
    }
    const topicId = typeof s?.messages?.currentTopicId === 'string' ? s.messages.currentTopicId : ''
    const assistants = s?.assistants?.assistants ?? []
    if (topicId) {
      const owner = assistants.find((a) => Array.isArray(a?.topics) && a.topics.some((t) => t?.id === topicId))
      if (typeof owner?.id === 'string' && owner.id.length > 0) return owner.id
    }
    const first = assistants?.[0]?.id
    return typeof first === 'string' ? first : ''
  })
}

async function ensureOwnedTopicViaApi(
  senderPage: import('@playwright/test').Page,
  receiverPage: import('@playwright/test').Page,
  topicId: string,
  name: string
): Promise<string> {
  const ownerA = await getActiveOwnerAssistantId(senderPage)
  expect(ownerA, 'sender active assistant owner must be explicit before ensure').not.toBe('')
  const ownerB = await getActiveOwnerAssistantId(receiverPage)
  expect(ownerB, 'receiver active assistant owner must be explicit before sync').not.toBe('')
  // Both disposable profiles boot the same stable initial assistant
  // (createInitialAssistant id 'default'); the synced topic row must carry
  // that same owner so both per-assistant directories keep the row.
  expect(ownerB, 'sender/receiver must share the same owning assistant for sidebar reachability').toBe(ownerA)
  await ensureTopicViaApi(senderPage, topicId, name, ownerA)
  return ownerA
}

async function waitMessageContainer(
  page: import('@playwright/test').Page,
  messageId: string,
  timeout = 30000
): Promise<void> {
  await page.locator(`[data-message-id="${messageId}"]`).first().waitFor({ state: 'visible', timeout })
}

async function expectImageDecoded(
  page: import('@playwright/test').Page,
  messageId: string,
  fileId: string
): Promise<void> {
  const selector = `[data-message-id="${messageId}"] .message-content-container img`
  const img = page.locator(selector).first()
  await expect(img, 'synced image must render an img in the message container').toBeVisible({ timeout: 20000 })
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel) as HTMLImageElement | null
      return el !== null && el.complete && el.naturalWidth > 0
    },
    selector,
    { timeout: 20000 }
  )
  const src = await img.getAttribute('src')
  expect(src, 'image img must carry a local file:// source').not.toBeNull()
  expect(src!).toContain('file://')
  expect(src!).toContain(fileId)
}

async function expectAudioLoaded(
  page: import('@playwright/test').Page,
  messageId: string,
  fileId: string
): Promise<void> {
  const selector = `[data-message-id="${messageId}"] [data-testid="media-audio"]`
  const audio = page.locator(selector).first()
  await expect(audio, 'synced audio must render the in-app player').toBeVisible({ timeout: 20000 })
  await expect(audio).toHaveAttribute('controls', '')
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel) as HTMLAudioElement | null
      if (!el) return false
      if (el.error !== null) return false
      if (el.readyState < 1) return false
      return Number.isFinite(el.duration) && el.duration > 0
    },
    selector,
    { timeout: 20000 }
  )
  const src = await audio.getAttribute('src')
  expect(src, 'audio player must carry a local file:// source').not.toBeNull()
  expect(src!).toContain('file://')
  expect(src!).toContain(fileId)
}

async function expectVideoLoaded(
  page: import('@playwright/test').Page,
  messageId: string,
  fileId: string
): Promise<void> {
  const selector = `[data-message-id="${messageId}"] [data-testid="media-video"]`
  const video = page.locator(selector).first()
  await expect(video, 'synced FILE-video must render the in-app player').toBeVisible({ timeout: 20000 })
  await expect(video).toHaveAttribute('controls', '')
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel) as HTMLVideoElement | null
      if (!el) return false
      if (el.error !== null) return false
      if (el.readyState < 1) return false
      if (!(el.videoWidth > 0)) return false
      return Number.isFinite(el.duration) && el.duration > 0
    },
    selector,
    { timeout: 20000 }
  )
  const src = await video.getAttribute('src')
  expect(src, 'video player must carry a local file:// source').not.toBeNull()
  expect(src!).toContain('file://')
  expect(src!).toContain(fileId)
}

async function expectIndependentVideoLoaded(page: import('@playwright/test').Page, messageId: string): Promise<void> {
  const container = `[data-message-id="${messageId}"]`
  // Independent VIDEO renders via MessageVideo (ReactPlayer), never the
  // FILE-video media card — this distinguishes the two video paths.
  await expect(page.locator(`${container} [data-testid="media-video"]`)).toHaveCount(0)
  const video = page.locator(`${container} video`).first()
  await expect(video, 'synced independent VIDEO must render a video element').toBeVisible({ timeout: 20000 })
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel) as HTMLVideoElement | null
      if (!el) return false
      if (el.error !== null) return false
      if (el.readyState < 1) return false
      if (!(el.videoWidth > 0)) return false
      return Number.isFinite(el.duration) && el.duration > 0
    },
    `${container} video`,
    { timeout: 20000 }
  )
  const html = await page.locator(container).first().innerHTML()
  expect(html, 'independent VIDEO must never render file://undefined').not.toContain('undefined')
}

interface RecorderMedia {
  mimeType: string
  byteLength: number
  b64: string
}

/**
 * Generate real decodable video bytes with the app's own Chromium
 * (canvas captureStream + MediaRecorder, mp4 preferred when supported else
 * webm). No new dependencies, no provider network, never a suffix-only fake.
 */
async function generateDecodableVideoBytes(
  page: import('@playwright/test').Page
): Promise<{ ext: '.mp4' | '.webm'; mime: string; bytes: Buffer }> {
  const gen = (await page.evaluate(async (): Promise<RecorderMedia> => {
    const w = window as unknown as {
      MediaRecorder?: {
        isTypeSupported: (t: string) => boolean
        new (
          s: MediaStream,
          o?: { mimeType?: string }
        ): {
          ondataavailable: ((e: { data?: Blob }) => void) | null
          onstop: (() => void) | null
          readonly state: string
          start: (t?: number) => void
          stop: () => void
        }
      }
    }
    if (!w.MediaRecorder) throw new Error('MediaRecorder unavailable')
    const MR = w.MediaRecorder
    const pickMp4 = MR.isTypeSupported('video/mp4;codecs="avc1.42E01E"') || MR.isTypeSupported('video/mp4')
    const mimeType = pickMp4 ? 'video/mp4' : 'video/webm;codecs=vp8'
    if (!MR.isTypeSupported(mimeType)) throw new Error(`unsupported mime ${mimeType}`)
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    const stream = canvas.captureStream(30)
    const rec = new MR(stream, { mimeType })
    const chunks: Blob[] = []
    rec.ondataavailable = (e: { data?: Blob }) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve()
    })
    let frame = 0
    const t0 = Date.now()
    const draw = () => {
      ctx.fillStyle = `rgb(${frame % 256},${(frame * 5) % 256},150)`
      ctx.fillRect(0, 0, 32, 32)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect((frame * 2) % 24, 8, 8, 8)
      frame += 1
      if (Date.now() - t0 < 1100) requestAnimationFrame(draw)
    }
    draw()
    rec.start(100)
    await new Promise((r) => setTimeout(r, 1300))
    if (rec.state !== 'inactive') rec.stop()
    await stopped
    const blob = new Blob(chunks, { type: mimeType })
    const u8 = new Uint8Array(await blob.arrayBuffer())
    if (u8.length === 0) throw new Error('recorder produced no bytes')
    let binary = ''
    const CHUNK = 8192
    for (let i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode(...u8.subarray(i, i + CHUNK))
    }
    return { mimeType, byteLength: u8.length, b64: btoa(binary) }
  })) as RecorderMedia
  const ext = gen.mimeType.startsWith('video/mp4') ? '.mp4' : '.webm'
  return { ext: ext as '.mp4' | '.webm', mime: gen.mimeType, bytes: Buffer.from(gen.b64, 'base64') }
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
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

  test('mixed cursor0 preexisting pending ordinary turn + stored image capture converges with no shell ops', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    // Production E2E (unexecuted in this change; unit proof in
    // syncMediaAdoptionV5.test.ts): B starts cursor0 with independent
    // unversioned history — a pending ordinary turn plus a stored image
    // whose bytes still need capture — while A holds the published baseline.
    // Expect: baseline publishes, no portable block full-state without
    // assetIds ever queues, relay batch accepts, ordinary + media converge
    // both ways with localized bytes.
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: import('../../utils/sync-second-profile').SecondSyncProfile | null = null
    try {
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      const topic = `e2e-attach-mixed-cursor0-${randomUUID().slice(0, 6)}`
      await ensureTopicViaApi(pageA, topic, 'Mixed Cursor0 Topic')
      const mHold = `e2e-mixed-hold-${randomUUID().slice(0, 6)}`
      const kHold = `e2e-mixed-khold-${randomUUID().slice(0, 6)}`
      await appendMessageViaApi(pageA, topic, messageJson(mHold, topic, 'holder ordinary'), [
        blockJson(kHold, mHold, 'holder ordinary')
      ])
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await poll(async () => {
        const r = await fetchRoute(pageB, topic, null)
        return r.messages.some((m) => m.id === mHold)
      })

      // B: independent cursor0-adjacent history — pending ordinary turn plus
      // a stored image created through the real append pipeline (capture
      // pending until the next drain). Never a direct valid-payload insert.
      const mOrd = `e2e-mixed-ord-${randomUUID().slice(0, 6)}`
      const kOrd = `e2e-mixed-kord-${randomUUID().slice(0, 6)}`
      await appendMessageViaApi(pageB, topic, messageJson(mOrd, topic, 'mixed ordinary'), [
        blockJson(kOrd, mOrd, 'mixed ordinary')
      ])
      const imgId = randomUUID()
      const imgBytes = Buffer.from('mixed-cursor0-stored-image')
      await writeSyntheticFile(pageB, imgId, '.png', imgBytes.toString('base64'))
      const mImg = `e2e-mixed-img-${randomUUID().slice(0, 6)}`
      const kImg = `e2e-mixed-kimg-${randomUUID().slice(0, 6)}`
      await pageB.evaluate(
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
          if (!res || (res as Record<string, unknown>).ok !== true) throw new Error('append mixed image failed')
        },
        {
          topicId: topic,
          msg: messageJson(mImg, topic, 'mixed image'),
          blk: {
            id: kImg,
            messageId: mImg,
            type: 'image',
            content: 'mixed image',
            status: 'success',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            file: {
              id: imgId,
              name: `${imgId}.png`,
              origin_name: 'mixed.png',
              path: `/tmp/${imgId}.png`,
              size: imgBytes.length,
              ext: '.png',
              type: 'image',
              created_at: new Date().toISOString()
            }
          }
        }
      )

      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await poll(async () => {
        const r = await fetchRoute(pageA, topic, null)
        return r.messages.some((m) => m.id === mOrd) && r.messages.some((m) => m.id === mImg)
      }, 120000)
      const aImgOk = await verifyFileBytes(pageA, imgId, '.png', imgBytes.toString('base64'))
      expect(aImgOk).toBe(true)
      const bHold = await fetchRoute(pageB, topic, null)
      expect(bHold.messages.some((m) => m.id === mHold)).toBe(true)
      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusB.lastError).toBeNull()
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
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
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
      const observer = await provisionObserverViaRaw(relay.endpoint, pageA)
      let watermark = 0
      await poll(async () => {
        if (!relay) return false
        const res = await fetch(`${relay.endpoint}/sync/baseline`, {
          headers: { 'x-sync-device-code': observer.code, 'x-sync-device-secret': observer.secret }
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
      await setSyncConfigViaApi(pageC, { endpoint: relay.endpoint, enabled: true })
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

  test('baseline real media renders on receiver with local file DTOs and decode probes', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: import('../../utils/sync-second-profile').SecondSyncProfile | null = null
    try {
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      const pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      const topic = `e2e-attach-media-${randomUUID().slice(0, 6)}`
      await ensureOwnedTopicViaApi(pageA, pageB, topic, 'Media Topic')
      const mText = `e2e-media-text-${randomUUID().slice(0, 6)}`
      await appendMessageViaApi(pageA, topic, messageJson(mText, topic, 'baseline text'), [
        blockJson(`b-${randomUUID().slice(0, 6)}`, mText, 'baseline text')
      ])

      const pngId = randomUUID()
      const pngBytes = Buffer.from(DETERMINISTIC_PNG_B64, 'base64')
      const txtToken = `e2e-txt-${randomUUID().slice(0, 8)}`
      const txtText = `${txtToken}\nsecond line with unicode \u00e4\u00f6\u00fc\n`
      const txtBytes = Buffer.from(txtText, 'utf8')
      const txtId = randomUUID()
      const pdfMarker = `e2e-pdf-${randomUUID().slice(0, 8)}`
      const pdfBytes = minimalPdfBytes(pdfMarker)
      const pdfId = randomUUID()
      const wavBytes = buildWavPcm16Mono8k()
      const wavId = randomUUID()
      await writeSyntheticFile(pageA, pngId, '.png', pngBytes.toString('base64'))
      await writeSyntheticFile(pageA, txtId, '.txt', txtBytes.toString('base64'))
      await writeSyntheticFile(pageA, pdfId, '.pdf', pdfBytes.toString('base64'))
      await writeSyntheticFile(pageA, wavId, '.wav', wavBytes.toString('base64'))

      const mPng = `e2e-media-png-${randomUUID().slice(0, 6)}`
      const mTxt = `e2e-media-txt-${randomUUID().slice(0, 6)}`
      const mPdf = `e2e-media-pdf-${randomUUID().slice(0, 6)}`
      const mWav = `e2e-media-wav-${randomUUID().slice(0, 6)}`
      await appendFileBlockViaApi(pageA, {
        topicId: topic,
        messageId: mPng,
        blockId: `b-${randomUUID().slice(0, 6)}`,
        blockType: 'image',
        content: 'photo',
        file: fileDto(pngId, '.png', 'photo.png', 'image', pngBytes.length)
      })
      await appendFileBlockViaApi(pageA, {
        topicId: topic,
        messageId: mTxt,
        blockId: `b-${randomUUID().slice(0, 6)}`,
        blockType: 'file',
        content: 'notes',
        file: fileDto(txtId, '.txt', 'notes.txt', 'text', txtBytes.length)
      })
      await appendFileBlockViaApi(pageA, {
        topicId: topic,
        messageId: mPdf,
        blockId: `b-${randomUUID().slice(0, 6)}`,
        blockType: 'file',
        content: 'report',
        file: fileDto(pdfId, '.pdf', 'report.pdf', 'document', pdfBytes.length)
      })
      await appendFileBlockViaApi(pageA, {
        topicId: topic,
        messageId: mWav,
        blockId: `b-${randomUUID().slice(0, 6)}`,
        blockType: 'file',
        content: 'tone',
        file: fileDto(wavId, '.wav', 'tone.wav', 'audio', wavBytes.length)
      })

      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      const wantIds = [mText, mPng, mTxt, mPdf, mWav]
      await poll(async () => {
        const r = await fetchRouteFull(pageB, topic, null)
        const ids = new Set(r.messages.map((m) => String(m.id)))
        return wantIds.every((id) => ids.has(id))
      })

      // Receiver FileMetadata must be readable, local, and field-exact.
      const routeB = await fetchRouteFull(pageB, topic, null)
      const blockFor = (messageId: string): Record<string, unknown> => {
        const found = routeB.blocks.find((b) => String(b.messageId) === messageId)
        if (!found) throw new Error(`receiver block missing for ${messageId}`)
        return found
      }
      const filesPathB = await getFilesPathViaApi(pageB)
      expect((blockFor(mText).file ?? null) as unknown).toBeNull()
      expectLocalFileDto(
        blockFor(mPng).file,
        { id: pngId, originName: 'photo.png', ext: '.png', type: 'image', size: pngBytes.length },
        filesPathB
      )
      expectLocalFileDto(
        blockFor(mTxt).file,
        { id: txtId, originName: 'notes.txt', ext: '.txt', type: 'text', size: txtBytes.length },
        filesPathB
      )
      expectLocalFileDto(
        blockFor(mPdf).file,
        { id: pdfId, originName: 'report.pdf', ext: '.pdf', type: 'document', size: pdfBytes.length },
        filesPathB
      )
      expectLocalFileDto(
        blockFor(mWav).file,
        { id: wavId, originName: 'tone.wav', ext: '.wav', type: 'audio', size: wavBytes.length },
        filesPathB
      )
      expect(await verifyFileBytes(pageB, pngId, '.png', pngBytes.toString('base64'))).toBe(true)
      expect(await verifyFileBytes(pageB, txtId, '.txt', txtBytes.toString('base64'))).toBe(true)
      expect(await verifyFileBytes(pageB, pdfId, '.pdf', pdfBytes.toString('base64'))).toBe(true)
      expect(await verifyFileBytes(pageB, wavId, '.wav', wavBytes.toString('base64'))).toBe(true)

      // PDF external open must be stubbed/observed, never a real system app.
      const stubInstalled = await profileB.app.evaluate(({ shell }: typeof import('electron')) => {
        const s = shell as unknown as Record<string, unknown>
        s.__e2eAttachOpenCalls = []
        s.openPath = async (p: string) => {
          ;(s.__e2eAttachOpenCalls as string[]).push(p)
          return ''
        }
        return typeof s.openPath === 'function'
      })
      expect(stubInstalled).toBe(true)

      await openTopicInUi(pageB, topic)
      for (const mid of wantIds) {
        await waitMessageContainer(pageB, mid)
      }
      // Text message without a file renders no attachment UI (ImageBlock
      // without file is empty; no media card either).
      await expect(pageB.locator(`[data-message-id="${mText}"] .message-content-container img`)).toHaveCount(0)
      await expect(pageB.locator(`[data-message-id="${mText}"] [data-testid="media-attachment"]`)).toHaveCount(0)

      await expectImageDecoded(pageB, mPng, pngId)
      await expectAudioLoaded(pageB, mWav, wavId)
      await expect(
        pageB.locator(`[data-message-id="${mTxt}"]`).getByText('notes.txt', { exact: false }).first()
      ).toBeVisible({ timeout: 15000 })
      await expect(
        pageB.locator(`[data-message-id="${mPdf}"]`).getByText('report.pdf', { exact: false }).first()
      ).toBeVisible({ timeout: 15000 })

      // TXT click must open the real text preview with the actual content.
      await pageB.locator(`[data-message-id="${mTxt}"]`).getByText('notes.txt', { exact: false }).first().click()
      const txtModal = pageB.locator('.ant-modal')
      await expect(txtModal, 'TXT preview modal must open').toBeVisible({ timeout: 15000 })
      // Preview body loads async after the modal shell opens (observed
      // 'notes.txtLoading...' on a fresh run): poll the rendered text for
      // the real synced token instead of a single read. Strict assertion
      // unchanged — the token must appear, no relaxation.
      let modalText: string | null = null
      const txtDeadline = Date.now() + 15000
      for (;;) {
        modalText = await txtModal.first().textContent()
        if (modalText !== null && modalText.includes(txtToken)) break
        if (Date.now() >= txtDeadline) break
        await new Promise((r) => setTimeout(r, 250))
      }
      expect(modalText ?? '', 'TXT preview must read the real synced text').toContain(txtToken)
      await pageB.locator('.ant-modal-close').first().click()
      await expect(txtModal, 'TXT preview modal must close').toBeHidden({ timeout: 15000 })

      // PDF click must reach the stubbed external open with the local path.
      await pageB.locator(`[data-message-id="${mPdf}"]`).getByText('report.pdf', { exact: false }).first().click()
      const openCalls = await profileB.app.evaluate(({ shell }: typeof import('electron')) => {
        return [...((shell as unknown as Record<string, unknown>).__e2eAttachOpenCalls as string[])]
      })
      expect(openCalls.length).toBe(1)
      expect(openCalls[0]).toContain(pdfId)
      expect(openCalls[0].startsWith(filesPathB)).toBe(true)

      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusB.lastError).toBeNull()
    } finally {
      if (profileB) await closeSecondSyncProfile(profileB)
      if (relay) await relay.close()
    }
  })

  test('incremental file-video renders while receiver stays open and survives relaunch', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: import('../../utils/sync-second-profile').SecondSyncProfile | null = null
    try {
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      let pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      // First baseline: ordinary text + one real PNG image.
      // Owner-explicit: a null-assistant Main row exists by ID yet is
      // correctly filtered from the per-assistant directory, so the
      // receiver sidebar would never show it.
      const topic = `e2e-attach-incr-${randomUUID().slice(0, 6)}`
      await ensureOwnedTopicViaApi(pageA, pageB, topic, 'Incremental Media Topic')
      const mBase = `e2e-incr-base-${randomUUID().slice(0, 6)}`
      await appendMessageViaApi(pageA, topic, messageJson(mBase, topic, 'baseline'), [
        blockJson(`b-${randomUUID().slice(0, 6)}`, mBase, 'baseline')
      ])
      const pngId = randomUUID()
      const pngBytes = Buffer.from(DETERMINISTIC_PNG_B64, 'base64')
      await writeSyntheticFile(pageA, pngId, '.png', pngBytes.toString('base64'))
      const mPng = `e2e-incr-png-${randomUUID().slice(0, 6)}`
      await appendFileBlockViaApi(pageA, {
        topicId: topic,
        messageId: mPng,
        blockId: `b-${randomUUID().slice(0, 6)}`,
        blockType: 'image',
        content: 'baseline photo',
        file: fileDto(pngId, '.png', 'base-photo.png', 'image', pngBytes.length)
      })
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await poll(async () => {
        const r = await fetchRouteFull(pageB, topic, null)
        const ids = new Set(r.messages.map((m) => String(m.id)))
        return ids.has(mBase) && ids.has(mPng)
      })
      await openTopicInUi(pageB, topic)
      await waitMessageContainer(pageB, mPng)
      await expectImageDecoded(pageB, mPng, pngId)

      // Normal increment while the receiver topic stays open: a second PNG
      // plus a FILE-video (block type 'file', file.type 'video' — not the
      // independent MessageVideo path) with real recorder-generated bytes.
      const video = await generateDecodableVideoBytes(pageA)
      const vidId = randomUUID()
      const vidOrigin = `clip${video.ext}`
      await writeSyntheticFile(pageA, vidId, video.ext, video.bytes.toString('base64'))
      const mVid = `e2e-incr-vid-${randomUUID().slice(0, 6)}`
      const png2Id = randomUUID()
      await writeSyntheticFile(pageA, png2Id, '.png', pngBytes.toString('base64'))
      const mPng2 = `e2e-incr-png2-${randomUUID().slice(0, 6)}`
      await appendFileBlockViaApi(pageA, {
        topicId: topic,
        messageId: mVid,
        blockId: `b-${randomUUID().slice(0, 6)}`,
        blockType: 'file',
        content: 'clip',
        file: fileDto(vidId, video.ext, vidOrigin, 'video', video.bytes.length)
      })
      await appendFileBlockViaApi(pageA, {
        topicId: topic,
        messageId: mPng2,
        blockId: `b-${randomUUID().slice(0, 6)}`,
        blockType: 'image',
        content: 'second photo',
        file: fileDto(png2Id, '.png', 'second-photo.png', 'image', pngBytes.length)
      })
      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()

      // Arrival while open: Redux first (data), then the live DOM without reopening.
      await poll(async () => {
        const ids = await getReduxMessageIds(pageB, topic)
        return ids.includes(mVid) && ids.includes(mPng2)
      }, 90000)
      await waitMessageContainer(pageB, mVid, 60000)
      await waitMessageContainer(pageB, mPng2, 60000)
      const routeIncr = await fetchRouteFull(pageB, topic, null)
      const vidBlock = routeIncr.blocks.find((b) => String(b.messageId) === mVid)
      expect(String(vidBlock?.type), 'video increment must be the FILE type, not independent VIDEO').toBe('file')
      const filesPathB = await getFilesPathViaApi(pageB)
      expectLocalFileDto(
        (vidBlock as Record<string, unknown>).file,
        { id: vidId, originName: vidOrigin, ext: video.ext, type: 'video', size: video.bytes.length },
        filesPathB
      )
      expect(await verifyFileBytes(pageB, vidId, video.ext, video.bytes.toString('base64'))).toBe(true)
      await expectVideoLoaded(pageB, mVid, vidId)
      await expectImageDecoded(pageB, mPng2, png2Id)

      // Standard fixture relaunch: media must still display afterwards.
      profileB = await relaunchSecondSyncProfile(profileB, ownedTmpRoot, mockPort, {
        expectedEndpoint: relay.endpoint,
        expectedEnabled: true
      })
      pageB = profileB.page
      await openTopicInUi(pageB, topic)
      await waitMessageContainer(pageB, mPng)
      await waitMessageContainer(pageB, mVid)
      await waitMessageContainer(pageB, mPng2)
      await expectImageDecoded(pageB, mPng, pngId)
      await expectVideoLoaded(pageB, mVid, vidId)
      await expectImageDecoded(pageB, mPng2, png2Id)

      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusB.lastError).toBeNull()
    } finally {
      if (profileB) await closeSecondSyncProfile(profileB)
      if (relay) await relay.close()
    }
  })

  test('independent file-backed VIDEO renders on receiver and survives relaunch', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    // Independent VIDEO (block type 'video') with a `file` DTO is admitted
    // through the EXISTING portable-media capture (overflow.file refs, same
    // contract as syncAttachmentChain.test.ts blockVidWire) — no new capture
    // entry, no protocol change. The receiver hydrates block.file + filePath
    // (mediaReadAssembly) and MessageVideo renders the local file DTO without
    // metadata.video. This is explicitly NOT the FILE-video path (block type
    // 'file' via MessageAttachments, asserted in the tests above).
    const pageA = mainWindow
    let relay: TestRelayHandle | null = null
    let profileB: import('../../utils/sync-second-profile').SecondSyncProfile | null = null
    try {
      relay = await startTestRelay()
      profileB = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
      let pageB = profileB.page
      await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
      await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
      await pairProfilesViaApi(pageA, pageB)

      const topic = `e2e-attach-indep-video-${randomUUID().slice(0, 6)}`
      await ensureOwnedTopicViaApi(pageA, pageB, topic, 'Independent Video Topic')
      const mBase = `e2e-indep-base-${randomUUID().slice(0, 6)}`
      await appendMessageViaApi(pageA, topic, messageJson(mBase, topic, 'baseline'), [
        blockJson(`b-${randomUUID().slice(0, 6)}`, mBase, 'baseline')
      ])

      const video = await generateDecodableVideoBytes(pageA)
      const vidId = randomUUID()
      const vidOrigin = `movie${video.ext}`
      await writeSyntheticFile(pageA, vidId, video.ext, video.bytes.toString('base64'))
      const mVid = `e2e-indep-vid-${randomUUID().slice(0, 6)}`
      await appendFileBlockViaApi(pageA, {
        topicId: topic,
        messageId: mVid,
        blockId: `b-${randomUUID().slice(0, 6)}`,
        blockType: 'video',
        content: 'synced movie',
        file: fileDto(vidId, video.ext, vidOrigin, 'video', video.bytes.length)
      })

      expect((await runSyncViaApi(pageA)).threw).toBeNull()
      expect((await runSyncViaApi(pageB)).threw).toBeNull()
      await poll(async () => {
        const r = await fetchRouteFull(pageB, topic, null)
        const ids = new Set(r.messages.map((m) => String(m.id)))
        return ids.has(mBase) && ids.has(mVid)
      })

      const routeB = await fetchRouteFull(pageB, topic, null)
      const vidBlock = routeB.blocks.find((b) => String(b.messageId) === mVid)
      expect(String(vidBlock?.type), 'independent video must keep block type video, not file').toBe('video')
      const filesPathB = await getFilesPathViaApi(pageB)
      expectLocalFileDto(
        (vidBlock as Record<string, unknown>).file,
        { id: vidId, originName: vidOrigin, ext: video.ext, type: 'video', size: video.bytes.length },
        filesPathB
      )
      expect(typeof (vidBlock as Record<string, unknown>).filePath).toBe('string')
      expect(String((vidBlock as Record<string, unknown>).filePath)).toContain(vidId)
      expect(await verifyFileBytes(pageB, vidId, video.ext, video.bytes.toString('base64'))).toBe(true)

      await openTopicInUi(pageB, topic)
      await waitMessageContainer(pageB, mVid)
      await expectIndependentVideoLoaded(pageB, mVid)

      // Standard fixture relaunch: the independent VIDEO must still display.
      profileB = await relaunchSecondSyncProfile(profileB, ownedTmpRoot, mockPort, {
        expectedEndpoint: relay.endpoint,
        expectedEnabled: true
      })
      pageB = profileB.page
      await openTopicInUi(pageB, topic)
      await waitMessageContainer(pageB, mVid)
      await expectIndependentVideoLoaded(pageB, mVid)

      const statusB = await getSyncStatusViaApi(pageB)
      expect(statusB.lastError).toBeNull()
    } finally {
      if (profileB) await closeSecondSyncProfile(profileB)
      if (relay) await relay.close()
    }
  })
})
