/**
 * Chat projection visibility — DOM-observable projection evidence.
 * - Test 1: real UI send renders directory row + bubbles (empty-profile setup).
 * - Test 2: hint-driven resident refresh preserves the open OLDER window at
 *   the same stable anchor + intra-row offset (old force-latest would drop it).
 * Classification: NATIVE user wheel over #messages (shared scroll-sync settle)
 * establishes the protected non-bottom older window; INJECTED Main hint
 * (`chatdb:chat-projection-invalidated` via live webContents) exercises the
 * subscription contract (same-window origin excluded by design). No History
 * search dependency — older window via ordinary wheel pagination only.
 * Setup uses production surfaces only (textarea send, typed ChatDb IPC, real
 * topic click, typed mutation). Disposable profile; synthetic safe data.
 */
import type { ElectronApplication, Page } from '@playwright/test'

import { clearRequestLog, expect, findProductRequest, test } from '../../fixtures/electron.fixture'
import { activateTopic, letterMessageId, pad, prepareAssistant, seedSourceTopic } from '../../utils/branch-route-setup'
import { pageWheelAndSettle } from '../../utils/viewport-scroll-sync'
import { waitForAppReady } from '../../utils/wait-helpers'

const DISPLAY_LIMIT = 20
const SYNTHETIC_TOTAL = 120
const OFFSET_TOL = 12

function modestContent(i: number): string {
  return `projvis-${pad(i, 5)} deterministic scrollable ${'filler words '.repeat(8)}`
}

/** Visible topic row IDs in the sidebar (actual DOM, not IPC). */
async function visibleTopicRowIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-topic-id]')] as HTMLElement[]
    return rows
      .filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .map((el) => el.getAttribute('data-topic-id') ?? '')
      .filter((id) => id.length > 0)
  })
}

/** Visible message bubble IDs inside the messages viewport (actual DOM). */
async function visibleBubbleIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const container = document.getElementById('messages')
    if (!container) return []
    const cRect = container.getBoundingClientRect()
    const nodes = [...container.querySelectorAll('[data-message-id]')] as HTMLElement[]
    return nodes
      .filter((el) => {
        const r = el.getBoundingClientRect()
        const visibleHeight = Math.min(r.bottom, cRect.bottom) - Math.max(r.top, cRect.top)
        return visibleHeight > 0 && r.width > 0
      })
      .map((el) => el.getAttribute('data-message-id') ?? '')
      .filter((id) => id.length > 0)
  })
}

/** Attached message row IDs inside #messages (actual DOM, regardless of viewport intersection). */
async function attachedMessageIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const container = document.getElementById('messages')
    if (!container) return []
    const nodes = [...container.querySelectorAll('[data-message-id]')] as HTMLElement[]
    return nodes.map((el) => el.getAttribute('data-message-id') ?? '').filter((id) => id.length > 0)
  })
}

async function getActiveContext(page: Page): Promise<{ assistantId: string; topicId: string }> {
  return page.evaluate(() => {
    const s = (window as unknown as { store?: { getState: () => unknown } }).store?.getState() as {
      assistants?: { assistants?: Array<{ id: string; topics?: Array<{ id: string }> }> }
      messages?: { currentTopicId?: string | null }
    }
    const assistant = s?.assistants?.assistants?.[0]
    const topic = assistant?.topics?.[0]
    return {
      assistantId: (assistant?.id as string) ?? '',
      topicId: (topic?.id as string) ?? ''
    }
  })
}

/**
 * Type text into the real textarea and submit via Enter key.
 * Production InputbarCore → sendMessage → _sendMessage thunk path.
 */
async function uiSendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ selector, text: value }: { selector: string; text: string }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement | null
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', text }
  )
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

/**
 * Deterministic wait for the assistant response to complete: a new assistant
 * message appears, reaches terminal status, all blocks terminal, queue drained.
 */ async function waitForAssistantResponseComplete(
  page: Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<void> {
  await page.waitForFunction(
    ({ topicId: tid, prevCount }: { topicId: string; prevCount: number }) => {
      const s = (window as unknown as { store?: { getState: () => unknown } }).store?.getState() as {
        messages?: { messageIdsByTopic?: Record<string, string[]>; entities?: Record<string, { role?: string }> }
      }
      const msgIds = s?.messages?.messageIdsByTopic?.[tid] || []
      let count = 0
      for (const id of msgIds) {
        if (s?.messages?.entities?.[id]?.role === 'assistant') count++
      }
      return count > prevCount
    },
    { topicId, prevCount: previousAssistantCount },
    { timeout }
  )
  await page.waitForFunction(
    ({ topicId: tid }: { topicId: string }) => {
      const s = (window as unknown as { store?: { getState: () => unknown } }).store?.getState() as {
        messages?: {
          loadingByTopic?: Record<string, boolean>
          messageIdsByTopic?: Record<string, string[]>
          entities?: Record<string, { role?: string; status?: string; blocks?: string[] }>
        }
        messageBlocks?: { entities?: Record<string, { status?: string }> }
      }
      if (!s || s.messages?.loadingByTopic?.[tid]) return false
      const msgIds = s.messages?.messageIdsByTopic?.[tid] || []
      let latestAssistantId: string | null = null
      for (let i = msgIds.length - 1; i >= 0; i--) {
        if (s.messages?.entities?.[msgIds[i]]?.role === 'assistant') {
          latestAssistantId = msgIds[i]
          break
        }
      }
      if (!latestAssistantId) return false
      const assistantMsg = s.messages?.entities?.[latestAssistantId]
      if (assistantMsg?.status !== 'success' && assistantMsg?.status !== 'error') return false
      const blocks = assistantMsg?.blocks || []
      if (blocks.length === 0) return false
      for (const blockId of blocks) {
        const block = s.messageBlocks?.entities?.[blockId]
        if (!block || (block.status !== 'success' && block.status !== 'error')) return false
      }
      return true
    },
    { topicId },
    { timeout }
  )
}

// ---------------------------------------------------------------------------
// Test-2 owned helpers (native scroll scene only, no History search)
// ---------------------------------------------------------------------------

type Snapshot = {
  liveId: string
  liveOffset: number | null
  snapshotId: string
  snapshotOffset: number | null
  scrollTop: number
  isAtBottom: boolean
  phase: string
}

async function readSnapshot(page: Page, topicId: string): Promise<Snapshot> {
  return page.evaluate(
    ({ topicId: tid }: { topicId: string }) => {
      const container = document.getElementById('messages') as HTMLElement | null
      const cRect = container?.getBoundingClientRect()
      let liveId = ''
      let liveOffset: number | null = null
      if (container && cRect) {
        const nodes = [...container.querySelectorAll('[data-message-id]')] as HTMLElement[]
        for (const el of nodes) {
          const r = el.getBoundingClientRect()
          if (r.bottom > cRect.top && r.top < cRect.bottom && r.width > 0) {
            liveId = el.getAttribute('data-message-id') ?? ''
            liveOffset = r.top - cRect.top
            break
          }
        }
      }
      let snapshotId = ''
      let snapshotOffset: number | null = null
      let scrollTop = container ? container.scrollTop : 0
      let isAtBottom = true
      try {
        const keyv = (window as unknown as { keyv?: { get?: (k: string) => unknown } }).keyv
        const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
        for (const key of keys) {
          const saved = keyv?.get?.(key) as Record<string, unknown> | null | undefined
          if (saved && typeof saved === 'object' && 'scrollTop' in saved) {
            const mid = typeof saved.messageId === 'string' ? (saved.messageId as string) : ''
            const aid = typeof saved.anchorId === 'string' ? (saved.anchorId as string) : ''
            snapshotId = mid || aid
            const raw = saved.intraRowOffset
            snapshotOffset = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
            scrollTop = typeof saved.scrollTop === 'number' ? (saved.scrollTop as number) : scrollTop
            isAtBottom = !!(saved.isAtBottom as boolean)
            break
          }
        }
      } catch {
        snapshotId = ''
      }
      return {
        liveId,
        liveOffset,
        snapshotId,
        snapshotOffset,
        scrollTop,
        isAtBottom,
        phase: container?.getAttribute('data-viewport-phase') ?? ''
      }
    },
    { topicId }
  )
}

async function getLoadedIds(page: Page, topicId: string): Promise<string[]> {
  return page.evaluate((tid: string) => {
    const s = (window as unknown as { store: { getState: () => unknown } }).store.getState() as {
      messages?: { messageIdsByTopic?: Record<string, string[]> }
    }
    return [...(s.messages?.messageIdsByTopic?.[tid] ?? [])]
  }, topicId)
}

async function waitViewportVisible(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('messages')
      const phase = el?.getAttribute('data-viewport-phase')
      return phase === 'revealed' || phase === 'idle'
    },
    undefined,
    { timeout: 30000 }
  )
}

/** Production request quiescence: topic loading flag drained (read-only). */
async function waitTopicIdle(page: Page, topicId: string): Promise<void> {
  await page.waitForFunction(
    ({ tid }: { tid: string }) => {
      const s = (window as unknown as { store?: { getState: () => unknown } }).store?.getState() as {
        messages?: { loadingByTopic?: Record<string, boolean> }
      }
      return s?.messages?.loadingByTopic?.[tid] !== true
    },
    { tid: topicId },
    { timeout: 15000 }
  )
}

/**
 * Read-only real-geometry stability: the visible-box anchor id/offset,
 * scroll geometry, and controller phase stay unchanged across N consecutive
 * actual requestAnimationFrame ticks. No wheel, no scrollTop write, no store
 * mutation — pure reads, so a pass cannot forge the geometry it measures.
 */
async function waitRealBoxStable(page: Page, opts?: { frames?: number; offsetTol?: number }): Promise<void> {
  const frames = opts?.frames ?? 5
  const offsetTol = opts?.offsetTol ?? 2
  await page.waitForFunction(
    ({ need, tol }: { need: number; tol: number }) => {
      return new Promise<boolean>((resolve) => {
        const container = document.getElementById('messages') as HTMLElement | null
        if (!container) {
          resolve(false)
          return
        }
        const read = (): {
          id: string
          off: number
          st: number
          sh: number
          ch: number
          phase: string
        } => {
          const c = container.getBoundingClientRect()
          const nodes = [...container.querySelectorAll('[data-message-id]')] as HTMLElement[]
          let id = ''
          let off = 0
          for (const el of nodes) {
            const r = el.getBoundingClientRect()
            if (r.bottom > c.top && r.top < c.bottom && r.width > 0) {
              id = el.getAttribute('data-message-id') ?? ''
              off = r.top - c.top
              break
            }
          }
          return {
            id,
            off,
            st: container.scrollTop,
            sh: container.scrollHeight,
            ch: container.clientHeight,
            phase: container.getAttribute('data-viewport-phase') ?? ''
          }
        }
        const phaseOk = (phase: string): boolean => phase === 'revealed' || phase === 'idle'
        let prev = read()
        if (!prev.id || !phaseOk(prev.phase)) {
          resolve(false)
          return
        }
        let run = 0
        let ticks = 0
        const step = (): void => {
          requestAnimationFrame(() => {
            ticks += 1
            const cur = read()
            const stable =
              cur.id !== '' &&
              cur.id === prev.id &&
              Math.abs(cur.off - prev.off) <= tol &&
              Math.abs(cur.st - prev.st) <= tol &&
              cur.sh === prev.sh &&
              cur.ch === prev.ch &&
              phaseOk(cur.phase)
            run = stable ? run + 1 : 0
            prev = cur
            if (run >= need) {
              resolve(true)
              return
            }
            if (ticks >= 90) {
              resolve(false)
              return
            }
            step()
          })
        }
        step()
      })
    },
    { need: frames, tol: offsetTol },
    { timeout: 30000 }
  )
}

/** Read-only row height + container geometry (numbers only, never content/IDs). */
async function readRowGeometry(
  page: Page,
  messageId: string
): Promise<{ height: number; offset: number | null; scrollHeight: number; clientHeight: number }> {
  return page.evaluate((mid: string) => {
    const container = document.getElementById('messages') as HTMLElement | null
    const cRect = container?.getBoundingClientRect()
    let height = NaN
    let offset: number | null = null
    if (container && cRect) {
      const el = container.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
      if (el) {
        const r = el.getBoundingClientRect()
        height = r.height
        offset = r.top - cRect.top
      }
    }
    return {
      height,
      offset,
      scrollHeight: container ? container.scrollHeight : NaN,
      clientHeight: container ? container.clientHeight : NaN
    }
  }, messageId)
}

/** Current route topic id (read-only, proves the route did not change). */
async function readCurrentTopicId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = (window as unknown as { store?: { getState: () => unknown } }).store?.getState() as {
      messages?: { currentTopicId?: string | null }
    }
    return (s?.messages?.currentTopicId as string) ?? ''
  })
}

/** INJECTED Main notification contract probe (hint only, never data). */
async function sendNotificationContractHint(
  electronApp: ElectronApplication,
  hint: { assistantIds: string[]; topicIds: string[]; branchIds: string[]; reason: string }
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }: { BrowserWindow: unknown }, payload: unknown) => {
    const wins = (
      BrowserWindow as {
        getAllWindows: () => Array<{
          isDestroyed: () => boolean
          webContents: { isDestroyed: () => boolean; send: (c: string, p: unknown) => void }
        }>
      }
    ).getAllWindows()
    for (const win of wins) {
      try {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue
        win.webContents.send('chatdb:chat-projection-invalidated', payload)
      } catch {
        // best-effort probe; never break the test actor
      }
    }
  }, hint)
}

test.describe('chat projection visibility (DOM, not IPC)', () => {
  test('directory + bubbles render in the actual DOM (real UI send)', async ({ mainWindow, mockPort }) => {
    test.setTimeout(180000)
    const page = mainWindow
    void mockPort
    await waitForAppReady(page)

    // Arrange: fresh disposable profile starts empty — construct the protected
    // scenario with one real user turn before asserting anything.
    clearRequestLog()
    const ctx = await getActiveContext(page)
    expect(ctx.assistantId, 'mock-seeded assistant must exist').not.toBe('')
    expect(ctx.topicId, 'an open topic must exist').not.toBe('')
    const probeText = 'Projection visibility probe: hello from bounded correction'

    // Act: actual textarea → production send path → mocked streaming response.
    await uiSendMessage(page, probeText)
    await waitForAssistantResponseComplete(page, ctx.topicId, 0)

    // Product request proof: the mock saw a real streaming chat request.
    const productReq = findProductRequest()
    expect(productReq, 'mock must receive the product request').not.toBeNull()
    expect(productReq!.method).toBe('POST')
    expect(productReq!.url).toBe('/v1/chat/completions')
    expect(productReq!.parsed).toEqual(expect.objectContaining({ model: 'mock-model', stream: true }))
    const messages = (productReq!.parsed as { messages?: Array<{ role: string; content: string }> })?.messages
    expect(Array.isArray(messages)).toBe(true)
    expect(messages!.some((m) => m.role === 'user' && m.content?.includes(probeText))).toBe(true)

    // Assert: actual DOM projection — directory rows plus UI bubble IDs (never
    // API payload IDs alone) with the rendered probe text.
    const topicIds = await visibleTopicRowIds(page)
    expect(topicIds.length, 'sidebar must render at least one visible topic row').toBeGreaterThan(0)
    expect(topicIds, 'the open topic must be projected in the directory').toContain(ctx.topicId)
    const bubbles = await visibleBubbleIds(page)
    expect(bubbles.length, 'open route must render user + assistant bubbles').toBeGreaterThanOrEqual(2)
    const messagesText = page.locator('#messages')
    await expect(messagesText.getByText('Projection visibility probe', { exact: false }).first()).toBeVisible({
      timeout: 15000
    })
    await expect(messagesText.getByText('You said:', { exact: false }).first()).toBeVisible({ timeout: 15000 })
  })

  test('route-viewport preservation is per-detector stability, not window length', async ({
    mainWindow,
    electronApp
  }) => {
    test.setTimeout(180000)
    const page = mainWindow
    await waitForAppReady(page)

    // Arrange: substantial history via typed persistence, then ordinary NATIVE
    // wheel pagination into an older window — no search, no injection, no scrollTop set.
    const liveAssistantId = await prepareAssistant(page, DISPLAY_LIMIT)
    const topicId = `projvis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const allIds = await seedSourceTopic(page, {
      assistantId: liveAssistantId,
      topicId,
      name: `ProjVis ${topicId}`,
      total: SYNTHETIC_TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'projvis-',
      contentForIndex: (i: number) => modestContent(i)
    })
    await activateTopic(page, topicId, DISPLAY_LIMIT)
    await waitViewportVisible(page)
    const tailStart = SYNTHETIC_TOTAL - DISPLAY_LIMIT
    const latestTail = allIds.slice(tailStart)
    const preIds = await getLoadedIds(page, topicId)
    expect(preIds).toEqual(latestTail)

    // NATIVE wheel sweep toward the older edge (bounded 30; shared helper
    // proves delivery/boundary; settle — not pacing — is the evidence).
    const keys = [`scroll:topic-${topicId}::main`, `scroll:topic-${topicId}`]
    let loaded: string[] = preIds
    for (let round = 0; round < 30; round++) {
      loaded = await getLoadedIds(page, topicId)
      const firstIdx = allIds.indexOf(loaded[0] ?? '')
      const snap = await readSnapshot(page, topicId)
      const olderWindow = loaded.length > DISPLAY_LIMIT && firstIdx >= 0 && firstIdx < tailStart
      const liveIdx = allIds.indexOf(snap.liveId)
      const liveOutsideTail = liveIdx >= 0 && liveIdx < tailStart
      const phaseOk = snap.phase === 'revealed' || snap.phase === 'idle'
      const realNonBottom = Number.isFinite(snap.scrollTop) && Math.abs(snap.scrollTop) > 50
      if (olderWindow && liveOutsideTail && phaseOk && realNonBottom && !snap.isAtBottom && snap.snapshotId) break
      await pageWheelAndSettle(page, keys, -640).catch(() => null)
      // Bounded older-page allowance: InfiniteScroll may still be fetching.
      await page
        .waitForFunction(
          ({ tid, prev }: { tid: string; prev: number }) => {
            const s = (window as unknown as { store: { getState: () => unknown } }).store.getState() as {
              messages?: { messageIdsByTopic?: Record<string, string[]> }
            }
            return (s.messages?.messageIdsByTopic?.[tid] ?? []).length > prev
          },
          { tid: topicId, prev: loaded.length },
          { timeout: 4000 }
        )
        .catch(() => null)
    }
    loaded = await getLoadedIds(page, topicId)
    const firstIdx = allIds.indexOf(loaded[0] ?? '')
    expect(loaded.length, 'native wheel pagination must load an older page').toBeGreaterThan(DISPLAY_LIMIT)
    expect(firstIdx, 'loaded range must start older than the latest tail').toBeLessThan(tailStart)

    // Pre-act: INDEPENDENT detectors, no cross-detector agreement.
    // Baseline one-row snapshot-vs-visible-first discrepancy (e.g. persisted
    // 100 vs visible 099 from row-overflow, phase revealed, negative
    // column-reverse scrollTop) is an existing natural boundary, consciously
    // out of scope unless the INTRODUCED hint causes a change. Each detector
    // is frozen here and compared before-vs-after against ITSELF only.
    // pageWheelAndSettle above runs with NO allowedIds gate (geometry + phase
    // only); the snapshot gate is intentionally not used anywhere pre-act.
    await waitViewportVisible(page)
    await waitTopicIdle(page, topicId)
    await waitRealBoxStable(page, { frames: 5, offsetTol: 2 })
    const before = await readSnapshot(page, topicId)
    const beforeLoaded = await getLoadedIds(page, topicId)
    const beforeRouteId = await readCurrentTopicId(page)
    expect(beforeRouteId, 'route must stay on the seeded topic before the hint').toBe(topicId)
    // Detector A — REAL visible box (first intersecting bubble + intra-row offset).
    expect(before.liveId, 'viewport must expose a live DOM anchor').not.toBe('')
    expect(before.liveOffset, 'visible box must carry a finite intra-row offset').not.toBeNull()
    // Detector B — APP persisted snapshot (route key, own tuple; may differ by one row).
    expect(before.snapshotId, 'a persisted route snapshot anchor must exist').not.toBe('')
    expect(before.snapshotOffset, 'persisted snapshot must carry a finite intra-row offset').not.toBeNull()
    expect(before.isAtBottom, 'persisted snapshot must be non-bottom (protected older window)').toBe(false)
    // Real-geometry non-bottom under column-reverse: bottom is scrollTop ≈ 0.
    expect(Math.abs(before.scrollTop) > 50, `real viewport must be non-bottom (scrollTop=${before.scrollTop})`).toBe(
      true
    )
    expect(before.phase, 'viewport phase must be stable before the hint').toMatch(/^(revealed|idle)$/)
    // Older-than-latest window proven from loaded IDs (not from detector agreement).
    expect(beforeLoaded, 'visible anchor must be loaded before the hint').toContain(before.liveId)
    expect(beforeLoaded, 'persisted anchor must be loaded before the hint').toContain(before.snapshotId)
    const visibleIdx = allIds.indexOf(before.liveId)
    expect(visibleIdx, 'visible anchor must be a seeded stable ID').toBeGreaterThanOrEqual(0)
    expect(
      latestTail,
      'visible anchor must sit outside the latest tail (old latest reload would lose it)'
    ).not.toContain(before.liveId)
    const snapshotIdx = allIds.indexOf(before.snapshotId)
    expect(snapshotIdx, 'persisted anchor must be a seeded stable ID').toBeGreaterThanOrEqual(0)
    // Freeze BOTH tuples independently; no equality required here.
    const requestedVisibleId = before.liveId
    const requestedVisibleOffset = before.liveOffset as number
    const requestedSnapshotId = before.snapshotId
    const requestedSnapshotOffset = before.snapshotOffset as number
    // Anchor geometry freeze: row heights for both anchors before the
    // mutation, plus index positions inside the synthetic fixture order.
    // The edited row lies outside the closed anchor span, so both anchor
    // heights must stay identical across the rerender while the edited row
    // alone may change height.
    const visibleIdxBefore = allIds.indexOf(requestedVisibleId)
    const snapshotIdxBefore = allIds.indexOf(requestedSnapshotId)
    const anchorLo = Math.min(visibleIdxBefore, snapshotIdxBefore)
    const anchorHi = Math.max(visibleIdxBefore, snapshotIdxBefore)
    const geoVisibleBefore = await readRowGeometry(page, requestedVisibleId)
    const geoSnapshotBefore = await readRowGeometry(page, requestedSnapshotId)

    // Choose a REAL attached row in the returned around window that lies
    // OUTSIDE the closed index span between the two frozen anchors — never
    // either anchor and never strictly between them. A between-anchors edit
    // grows the gap between the anchors, so both sides cannot stay pixel-held
    // at once (overconstraint). An outside-span edit leaves the anchor
    // interval geometry directly comparable.
    const visible = await visibleBubbleIds(page)
    expect(visible.length, 'older window must render visible bubbles').toBeGreaterThan(0)
    const attached = await attachedMessageIds(page)
    expect(attached.length, 'older window must render attached rows').toBeGreaterThan(0)
    const outsideAttached = attached.filter((id) => {
      if (id === requestedVisibleId || id === requestedSnapshotId) return false
      const idx = allIds.indexOf(id)
      if (idx < 0) return false
      if (!beforeLoaded.includes(id)) return false
      if (latestTail.includes(id)) return false
      return idx < anchorLo || idx > anchorHi
    })
    // Prefer an intersecting visible row near the visible anchor (±8) when one
    // exists outside the span, but do not assume it always exists — fall back
    // to any attached outside-span row near (±8) and then any attached
    // outside-span row. The predicate below enforces actual min/max exclusion.
    const visibleOutside = outsideAttached.filter((id) => visible.includes(id))
    const nearVisibleOutside = visibleOutside.filter((id) => Math.abs(allIds.indexOf(id) - visibleIdx) <= 8)
    const nearAttachedOutside = outsideAttached.filter((id) => Math.abs(allIds.indexOf(id) - visibleIdx) <= 8)
    const mutateMsgId = nearVisibleOutside[0] ?? nearAttachedOutside[0] ?? visibleOutside[0] ?? outsideAttached[0]
    expect(mutateMsgId, 'a real attached message outside the anchor span must exist').toBeTruthy()
    const mutateIdx = allIds.indexOf(mutateMsgId as string)
    expect(mutateIdx, 'mutated message must be a seeded stable ID').toBeGreaterThanOrEqual(0)
    expect(
      mutateIdx < anchorLo || mutateIdx > anchorHi,
      'mutated row must lie outside the closed anchor span (never between)'
    ).toBe(true)
    expect(mutateMsgId, 'mutated row must not be either frozen anchor').not.toBe(requestedVisibleId)
    expect(mutateMsgId, 'mutated row must not be either frozen anchor').not.toBe(requestedSnapshotId)
    expect(beforeLoaded, 'mutated row must be in the returned around window').toContain(mutateMsgId)
    expect(latestTail, 'mutated row must sit outside the latest tail (same older group)').not.toContain(
      mutateMsgId as string
    )
    const mutateBlockId = await page.evaluate((mid: string) => {
      const s = (window as unknown as { store: { getState: () => unknown } }).store.getState() as {
        messages?: { entities?: Record<string, { blocks?: string[] }> }
      }
      return s.messages?.entities?.[mid]?.blocks?.[0] ?? ''
    }, mutateMsgId as string)
    expect(mutateBlockId, 'mutated message must own a block').not.toBe('')

    // Act: typed IPC mutation (Main commit) + INJECTED remote-hint probe for
    // the subscription path (same-window origin excluded by design).
    const mutatedContent = `${(mutateMsgId as string).split('-').pop()}-MUTATED deterministic ${'updated filler words '.repeat(6)}`
    const absentBefore = await page.evaluate(
      () => document.getElementById('messages')?.textContent?.includes('MUTATED') ?? false
    )
    expect(absentBefore, 'MUTATED must be absent before the hint (reload publishes it)').toBe(false)
    const mutated = await page.evaluate(
      async ({
        topicId: tid,
        messageId,
        blockId,
        content
      }: {
        topicId: string
        messageId: string
        blockId: string
        content: string
      }) => {
        try {
          const api = (window as unknown as { api?: unknown }).api as {
            chatDb?: { updateMessageAndBlocks?: (r: unknown) => Promise<unknown> }
          }
          const result = (await api?.chatDb?.updateMessageAndBlocks?.({
            topicId: tid,
            messageUpdates: { id: messageId },
            blocksToUpdate: [{ id: blockId, messageId, type: 'main_text', content, status: 'success' }]
          })) as { ok?: boolean; error?: unknown } | undefined
          if (!result || result.ok !== true) return { ok: false, err: JSON.stringify(result) }
          return { ok: true }
        } catch (e) {
          return { ok: false, err: e instanceof Error ? e.message : String(e) }
        }
      },
      { topicId, messageId: mutateMsgId as string, blockId: mutateBlockId as string, content: mutatedContent }
    )
    expect(mutated.ok, `typed mutation failed: ${(mutated as { err?: string }).err}`).toBe(true)
    await sendNotificationContractHint(electronApp, {
      assistantIds: [liveAssistantId],
      topicIds: [topicId],
      branchIds: [],
      reason: 'sync-incremental'
    })

    // The hint-driven reload must surface the committed mutation (proves the
    // hint was consumed — a no-op compare of the initial snapshot alone would
    // also pass if the hint were ignored).
    await page.waitForFunction(
      ({ content }: { content: string }) =>
        document.getElementById('messages')?.textContent?.includes(content) ?? false,
      { content: 'MUTATED' },
      { timeout: 30000 }
    )
    const mutatedLocator = page.locator(`#messages [data-message-id="${mutateMsgId}"]`)
    await expect(mutatedLocator, 'mutated in-window message must render after the hint').toBeAttached({
      timeout: 15000
    })
    // Rendered content proof without moving the protected window (no scroll):
    // the committed MUTATED text is present in the attached row with the
    // valid typed block (main_text/success). Intersecting visibility is proven
    // after the anchor asserts via scroll-into-view so the protected offsets
    // are measured first.
    await expect(mutatedLocator, 'mutated row must render the committed content').toContainText('MUTATED', {
      timeout: 15000
    })

    // Assert: EACH detector preserves its OWN pre-hint tuple (old force-latest
    // would replace this older window with the tail and lose the visible ID or
    // drift pixels). No cross-detector equality, no whole-window length
    // equality — only per-detector before-vs-after plus bounded reload.
    // Read-only RAF stability first (no scroll, no mutation, no rescue).
    await waitRealBoxStable(page, { frames: 5, offsetTol: 2 })
    const after = await readSnapshot(page, topicId)
    const afterLoaded = await getLoadedIds(page, topicId)
    const afterRouteId = await readCurrentTopicId(page)
    // Anchor self-stability: the mutation lies outside the anchor interval, so
    // each anchor's own row height must be unchanged across the rerender. The
    // edited row alone may change height; the anchor-interval geometry stays
    // comparable under the canonical restore.
    const geoVisibleAfter = await readRowGeometry(page, requestedVisibleId)
    const geoSnapshotAfter = await readRowGeometry(page, requestedSnapshotId)
    expect(geoVisibleAfter.height, 'visible anchor own height must be unchanged').toBe(geoVisibleBefore.height)
    expect(geoSnapshotAfter.height, 'persisted anchor own height must be unchanged').toBe(geoSnapshotBefore.height)
    expect(afterRouteId, 'route must stay on the seeded topic after the hint').toBe(topicId)
    // Detector A before-vs-after: same visible ID at the same intra-row offset.
    expect(after.liveId, 'visible box must preserve its own pre-hint identity').toBe(requestedVisibleId)
    expect(
      afterLoaded,
      'reloaded window must still contain the visible anchor (latest reload must not lose it)'
    ).toContain(requestedVisibleId)
    expect(after.liveOffset, 'visible box must carry a finite offset after the hint').not.toBeNull()
    if (after.liveOffset !== null) {
      expect(
        Math.abs(after.liveOffset - requestedVisibleOffset),
        `visible intra-row offset drifted: before=${requestedVisibleOffset} after=${after.liveOffset}`
      ).toBeLessThanOrEqual(OFFSET_TOL)
    }
    // Detector B before-vs-after: persisted snapshot preserves its OWN pre-hint tuple.
    expect(after.snapshotId, 'persisted snapshot must preserve its own pre-hint identity').toBe(requestedSnapshotId)
    expect(after.snapshotOffset, 'persisted snapshot must carry a finite offset after the hint').not.toBeNull()
    if (after.snapshotOffset !== null) {
      expect(
        Math.abs(after.snapshotOffset - requestedSnapshotOffset),
        `persisted offset drifted: before=${requestedSnapshotOffset} after=${after.snapshotOffset}`
      ).toBeLessThanOrEqual(OFFSET_TOL)
    }
    expect(afterLoaded.length, 'hint reload must stay bounded (never whole-history)').toBeLessThanOrEqual(60)
    const afterTarget = page.locator(`#messages [data-message-id="${requestedVisibleId}"]`)
    await expect(
      afterTarget,
      'requested visible anchor must still render inside #messages after the hint'
    ).toBeAttached({
      timeout: 15000
    })
    await expect(afterTarget, 'requested visible anchor must stay visible after the hint').toBeVisible({
      timeout: 15000
    })
    // Mutation visibility with valid status/type, last so the protected
    // window is never moved before its offsets are measured: bring the
    // attached outside-span row into view and prove its committed content is
    // intersecting-visible (typed main_text/success block from the Act step).
    await mutatedLocator.scrollIntoViewIfNeeded({ timeout: 15000 })
    await expect(mutatedLocator.getByText('MUTATED', { exact: false }).first()).toBeVisible({ timeout: 15000 })
  })
})
