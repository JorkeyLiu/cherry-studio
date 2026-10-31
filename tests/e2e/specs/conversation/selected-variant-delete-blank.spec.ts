/**
 * Selected-answer deletion blank interval — integrated E2E (real UI, sampled frames).
 *
 * Proves the viewport render projection is reconciled with the current loaded
 * projection before the browser can paint the inconsistent stale-group state
 * where the deleted selected variant (now blockless) is still selected and
 * fold CSS hides the survivor → blank/zero-visible-answer frame.
 *
 * Seeds an assistant semantic group sharing askId where the selected short
 * variant is deleted and the surviving variant remains. Deletes the selected
 * one through the real menubar delete button (data-testid="message-delete-button"
 * with confirmDeleteMessage=false), samples the first post-action animation
 * frames/DOM continuity, and proves there is no blank interval before the
 * survivor appears. Paired delete retains resident projection (no reset/reload).
 *
 * Final state must show survivor and preserve thinking→main_text order.
 */
import type { Page } from '@playwright/test'
import { expect, test } from '../../fixtures/electron.fixture'

/**
 * Rendered-visibility probe (single source of truth for every visibility read
 * in this spec).
 *
 * The stable row identity (`id="message-<id>"` / `data-message-id`) lives on
 * the inner message element, while answer-fold hiding is applied by an
 * ANCESTOR wrapper that is `display: none` unless it is the selected member.
 * The inner element therefore still computes `display: flex` while the answer
 * is not rendered at all: inner computed display alone reports "not none" for
 * an answer the user cannot see, so it cannot decide visibility. Precondition,
 * per-frame sampler and final-state reads all go through this ancestor-aware
 * probe so the three reads cannot disagree.
 */
type RenderedProbe = {
  exists: boolean
  connected: boolean
  /** Diagnostic only — the element's own computed display, never a visibility verdict. */
  innerDisplay: string
  effectiveVisible: boolean
  /** Which rule decided invisibility (`self:` / `ancestor:`), `null` when visible. */
  hiddenBy: string | null
  rectArea: number
  checkVisibility: boolean | null
  text: string
}

type ProbeWindow = { __selDelProbe: (el: Element | null) => RenderedProbe }

async function installRenderedProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (el: Element | null): RenderedProbe => {
      if (!el) {
        return {
          exists: false,
          connected: false,
          innerDisplay: 'missing',
          effectiveVisible: false,
          hiddenBy: 'missing',
          rectArea: 0,
          checkVisibility: null,
          text: ''
        }
      }
      const innerDisplay = window.getComputedStyle(el).display
      let hiddenBy: string | null = null
      let node: Element | null = el
      while (node) {
        const cs = window.getComputedStyle(node)
        const scope = node === el ? 'self' : 'ancestor'
        if (cs.display === 'none') {
          hiddenBy = `${scope}:display:none`
          break
        }
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
          hiddenBy = `${scope}:visibility:${cs.visibility}`
          break
        }
        if (cs.contentVisibility === 'hidden') {
          hiddenBy = `${scope}:content-visibility:hidden`
          break
        }
        if (Number(cs.opacity) === 0) {
          hiddenBy = `${scope}:opacity:0`
          break
        }
        node = node.parentElement
      }
      const rect = el.getBoundingClientRect()
      const rectArea = Math.round(rect.width * rect.height)
      const checkVisibility = (
        el as Element & {
          checkVisibility?: (o?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean
        }
      ).checkVisibility
      // Native cross-check when the engine provides it; never the sole verdict.
      const nativeCheck =
        typeof checkVisibility === 'function'
          ? checkVisibility.call(el, { checkOpacity: true, checkVisibilityCSS: true })
          : null
      return {
        exists: true,
        connected: el.isConnected,
        innerDisplay,
        effectiveVisible: el.isConnected && hiddenBy === null && rectArea > 0 && nativeCheck !== false,
        hiddenBy,
        rectArea,
        checkVisibility: nativeCheck,
        text: (el.textContent ?? '').trim()
      }
    }
    ;(window as unknown as ProbeWindow).__selDelProbe = probe
  })
}

/**
 * Negative control for the probe, on a temporary DOM pair mounted for one read
 * and removed again (no product state touched, nothing left behind): an answer
 * under a `display: none` ancestor must probe as not rendered while its own
 * display stays non-`none`, and an otherwise identical visible answer must
 * probe as rendered. Without this, "answer is visible" could be a constant and
 * the blank-frame assertions vacuous.
 */
async function assertProbeDetectsAncestorHiding(page: Page): Promise<void> {
  const control = await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__selDelProbe
    const root = document.createElement('div')
    root.setAttribute('data-seldel-probe-control', '1')
    root.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:100px;z-index:-1;pointer-events:none'
    const hiddenParent = document.createElement('div')
    hiddenParent.style.display = 'none'
    const hiddenChild = document.createElement('div')
    hiddenChild.textContent = 'probe-hidden-answer'
    hiddenParent.appendChild(hiddenChild)
    const visibleParent = document.createElement('div')
    const visibleChild = document.createElement('div')
    visibleChild.textContent = 'probe-visible-answer'
    visibleParent.appendChild(visibleChild)
    root.appendChild(hiddenParent)
    root.appendChild(visibleParent)
    document.body.appendChild(root)
    try {
      return {
        hidden: probe(hiddenChild),
        visible: probe(visibleChild),
        detached: probe(document.createElement('div'))
      }
    } finally {
      root.remove()
    }
  })
  expect(control.hidden.effectiveVisible, 'answer under a hidden ancestor must not probe as rendered').toBe(false)
  expect(control.hidden.hiddenBy, 'hidden control must name the rule that hides it').toBe('ancestor:display:none')
  // The exact failure mode this probe exists for: inner display alone would
  // have called this answer visible.
  expect(control.hidden.innerDisplay, 'hidden control keeps its own display — inner display is not a verdict').not.toBe(
    'none'
  )
  expect(control.visible.effectiveVisible, 'visible control must probe as rendered').toBe(true)
  expect(control.visible.hiddenBy, 'visible control must name no hiding rule').toBeNull()
  expect(control.visible.rectArea).toBeGreaterThan(0)
  expect(control.detached.effectiveVisible, 'detached node must not probe as rendered').toBe(false)
  const controlLeftBehind = await page.evaluate(() => document.querySelector('[data-seldel-probe-control]') !== null)
  expect(controlLeftBehind, 'probe control must be removed again').toBe(false)
}

async function prepareLargeWindowAndAssistant(page: Page): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as unknown as { store: { dispatch: (a: unknown) => void } }).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, 50)
  const displayOk = await page.evaluate(
    () =>
      (window as unknown as { store: { getState: () => { messages: { displayCount: number } } } }).store.getState()
        .messages.displayCount
  )
  expect(displayOk).toBe(50)
  const liveAssistantId = await page.evaluate(
    () =>
      (
        window as unknown as {
          store: {
            getState: () => { assistants: { assistants: Array<{ id: string }> } }
          }
        }
      ).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

async function activateTopicAndWaitForBootstrap(page: Page, topicId: string, atLeast: number): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ topicId, atLeast }: { topicId: string; atLeast: number }) => {
      const s = (
        window as unknown as {
          store: {
            getState: () => {
              messages: { messageIdsByTopic: Record<string, string[]>; loadingByTopic: Record<string, boolean> }
            }
          }
        }
      ).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length >= atLeast && loading !== true
    },
    { topicId, atLeast },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (atLeast: number) => document.querySelectorAll('#messages [data-message-id]').length >= atLeast,
    atLeast,
    { timeout: 30000 }
  )
}

type SampleFrame = {
  /** Absolute `performance.now()` of the sample. */
  tAbs: number
  reduxHasA1: boolean
  reduxHasA2: boolean
  reduxGroupIds: string[]
  domA1Exists: boolean
  domA2Exists: boolean
  /** Diagnostics — inner computed display only, NOT a visibility verdict (see RenderedProbe). */
  domA1InnerDisplay: string
  domA2InnerDisplay: string
  a1EffectiveVisible: boolean
  a2EffectiveVisible: boolean
  a2HiddenBy: string | null
  a2RectArea: number
  /** Full rendered text of the survivor element (uncapped, for content assertions). */
  a2RenderedText: string
  groupVisibleIds: string[]
  groupVisibleText: string[]
}

test.describe('Selected variant delete — no blank interval (real UI, sampled frames)', () => {
  test.setTimeout(180000)

  test('deleting selected short variant keeps survivor visible without zero-answer paint gap', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'SELECTED-DELETE BLANK INTEGRATED: seed user u1 + assistants a1(selected, foldSelected true, short thinking+main) + a2(survivor, foldSelected false, long thinking+main, same askId=u1) + user u2; large window 50; activate; real delete-button click on selected a1 (confirmDeleteMessage=false); continuous rAF sampler correlated with Redux loaded projection — every visibility read via one ancestor-aware rendered probe (inner display alone cannot see ancestor fold hiding), probe negative/positive controls asserted; prove no post-delete frame without a rendered answer and that a2 itself renders once a1 leaves the projection; final DOM/Redux show survivor with thinking→main_text order.'
    })
    const page: Page = mainWindow
    const liveAssistantId = await prepareLargeWindowAndAssistant(page)
    const topicId = `sel-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const u1 = `${topicId}-u1`
    const a1 = `${topicId}-a1`
    const a2 = `${topicId}-a2`
    const u2 = `${topicId}-u2`
    const segId = `${topicId}-seg1`
    const name = `SelDel ${topicId}`

    type Msg = {
      id: string
      topicId: string
      role: 'user' | 'assistant'
      assistantId: string
      createdAt: string
      updatedAt: string
      status: string
      blocks: string[]
      askId?: string
      foldSelected?: boolean
      model?: unknown
      modelId?: string
    }
    type Block = {
      id: string
      messageId: string
      type: string
      content: string
      status: string
      createdAt: string
      updatedAt: string
    }
    const mkMsg = (id: string, role: Msg['role'], extra: Partial<Msg> = {}): Msg =>
      ({
        id,
        topicId,
        role,
        assistantId: liveAssistantId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [],
        ...extra
      }) as Msg

    const mkBlock = (ownerId: string, type: string, content: string): Block =>
      ({
        id: `${topicId}-block-${ownerId.slice(topicId.length + 1)}-${type}`,
        messageId: ownerId,
        type,
        content,
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }) as Block

    const bThinkA1 = mkBlock(a1, 'thinking', 'thinking-short-a1')
    const bMainA1 = mkBlock(a1, 'main_text', 'main-short-a1')
    const bThinkA2 = mkBlock(a2, 'thinking', 'thinking-long-a2-survivor')
    const bMainA2 = mkBlock(a2, 'main_text', 'main-long-a2-survivor-continuous')
    const bU1 = mkBlock(u1, 'main_text', 'user-u1-question')
    const bU2 = mkBlock(u2, 'main_text', 'user-u2-follow')

    const entries: Array<{ message: Msg; blocks: Block[] }> = [
      { message: { ...mkMsg(u1, 'user'), blocks: [bU1.id] }, blocks: [bU1] },
      {
        message: {
          ...mkMsg(a1, 'assistant', {
            askId: u1,
            foldSelected: true,
            model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock' } as unknown as Msg['model'],
            modelId: 'mock-model'
          }),
          blocks: [bThinkA1.id, bMainA1.id]
        },
        blocks: [bThinkA1, bMainA1]
      },
      {
        message: {
          ...mkMsg(a2, 'assistant', {
            askId: u1,
            foldSelected: false,
            model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock' } as unknown as Msg['model'],
            modelId: 'mock-model'
          }),
          blocks: [bThinkA2.id, bMainA2.id]
        },
        blocks: [bThinkA2, bMainA2]
      },
      { message: { ...mkMsg(u2, 'user'), blocks: [bU2.id] }, blocks: [bU2] }
    ]

    await page.evaluate(
      ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
        const store = (window as unknown as { store: { dispatch: (a: unknown) => void } }).store
        store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: {
              id: topicId,
              assistantId,
              name,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: new Date().toISOString()
            }
          }
        })
      },
      { topicId, assistantId: liveAssistantId, name }
    )
    const persist = await page.evaluate(
      async ({
        topicId,
        assistantId,
        name,
        entries,
        segId,
        u1,
        a1,
        a2,
        u2
      }: {
        topicId: string
        assistantId: string
        name: string
        entries: Array<{ message: unknown; blocks: unknown[] }>
        segId: string
        u1: string
        a1: string
        a2: string
        u2: string
      }) => {
        try {
          const api = (
            window as unknown as {
              api: {
                chatDb: {
                  ensureTopic: (p: unknown) => Promise<{ ok: boolean }>
                  pasteMessagesToTopic: (p: unknown) => Promise<{ ok: boolean }>
                  upsertSegment: (p: unknown) => Promise<{ ok: boolean }>
                }
              }
            }
          ).api.chatDb
          const ensured = await api.ensureTopic({ topicId, assistantId, name })
          if (!ensured?.ok) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
          const pasted = await api.pasteMessagesToTopic({ topicId, entries })
          if (!pasted?.ok) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
          const seg = await api.upsertSegment({
            segmentId: segId,
            topicId,
            name: 'seg-sel',
            messageIds: [u1, a1, a2, u2]
          })
          if (!seg?.ok) return { ok: false, err: `segment ${JSON.stringify(seg)}` }
          return { ok: true }
        } catch (e) {
          return { ok: false, err: e instanceof Error ? e.message : String(e) }
        }
      },
      { topicId, assistantId: liveAssistantId, name, entries, segId, u1, a1, a2, u2 }
    )
    expect(persist.ok, `persist failed: ${(persist as unknown as { err: string }).err}`).toBe(true)

    await activateTopicAndWaitForBootstrap(page, topicId, 4)

    await page.evaluate(() => {
      const store = (window as unknown as { store: { dispatch: (a: unknown) => void } }).store
      store.dispatch({ type: 'settings/setConfirmDeleteMessage', payload: false })
    })

    // Ancestor-aware probe first, then its negative control, so the whole
    // precondition/sampler/final-state chain runs on a verified probe.
    await installRenderedProbe(page)
    await assertProbeDetectsAncestorHiding(page)

    const initialVisible = await page.evaluate(
      ({ a1, a2 }: { a1: string; a2: string }) => {
        const probe = (window as unknown as ProbeWindow).__selDelProbe
        return {
          a1: probe(document.getElementById(`message-${a1}`)),
          a2: probe(document.getElementById(`message-${a2}`))
        }
      },
      { a1, a2 }
    )
    expect(initialVisible.a1.exists, 'selected variant element must exist before delete').toBe(true)
    expect(initialVisible.a2.exists, 'survivor element must exist before delete').toBe(true)
    expect(
      initialVisible.a1.effectiveVisible,
      `selected variant must be rendered before delete (hiddenBy=${String(initialVisible.a1.hiddenBy)})`
    ).toBe(true)
    // The survivor is DOM-present but not rendered: the fold wrapper ancestor
    // hides it. This is the real-DOM negative control of the probe.
    expect(
      initialVisible.a2.effectiveVisible,
      `hidden survivor must not count as rendered (inner display=${initialVisible.a2.innerDisplay}, hiddenBy=${String(
        initialVisible.a2.hiddenBy
      )})`
    ).toBe(false)
    expect(initialVisible.a2.hiddenBy, 'survivor invisibility must be explained by a resolved rule').toBeTruthy()

    // Install continuous rAF sampler BEFORE click and await readiness
    await page.evaluate(
      ({ a1, a2, u1 }: { a1: string; a2: string; u1: string }) => {
        const w = window as unknown as {
          __selDelFrames: SampleFrame[]
          __selDelSampling: boolean
          __selDelSamplerReady: boolean
        }
        // Ancestor-aware probe installed above — never inner display alone.
        const probe = (window as unknown as ProbeWindow).__selDelProbe
        w.__selDelFrames = []
        w.__selDelSampling = true
        w.__selDelSamplerReady = false
        const sample = () => {
          if (!w.__selDelSampling) return
          const store = (
            window as unknown as {
              store: {
                getState: () => {
                  messages: {
                    messageIdsByTopic: Record<string, string[]>
                    entities: Record<string, { id: string; askId?: string }>
                  }
                  messageBlocks: { entities: Record<string, { type?: string }> }
                }
              }
            }
          ).store
          const state = store.getState()
          // Derive semantic group by askId === u1 (the shared askId)
          const topicId = (Object.keys(state.messages.messageIdsByTopic).find(
            (tid) =>
              state.messages.messageIdsByTopic[tid]?.includes(a1) || state.messages.messageIdsByTopic[tid]?.includes(a2)
          ) ?? '') as string
          const ids: string[] = state.messages.messageIdsByTopic[topicId] ?? []
          const reduxHasA1 = ids.includes(a1)
          const reduxHasA2 = ids.includes(a2)
          // Group ids: assistant messages with askId === u1
          const groupIds = Object.values(state.messages.entities)
            .filter((m): m is { id: string; askId?: string } => !!m && (m as { askId?: string }).askId === u1)
            .map((m) => m.id)
          const a1Probe = probe(document.getElementById(`message-${a1}`))
          const a2Probe = probe(document.getElementById(`message-${a2}`))
          const groupVisibleIds: string[] = []
          const groupVisibleText: string[] = []
          for (const gid of groupIds) {
            const p = probe(document.getElementById(`message-${gid}`))
            if (p.effectiveVisible) {
              groupVisibleIds.push(gid)
              groupVisibleText.push(p.text.replace(/\s+/g, ' '))
            }
          }
          // Fallback when groupIds empty due to timing: use the known survivor
          if (groupIds.length === 0 && a2Probe.effectiveVisible) {
            groupVisibleIds.push(a2)
            groupVisibleText.push(a2Probe.text.replace(/\s+/g, ' '))
          }
          w.__selDelFrames.push({
            tAbs: performance.now(),
            reduxHasA1,
            reduxHasA2,
            reduxGroupIds: [...groupIds],
            domA1Exists: a1Probe.exists,
            domA2Exists: a2Probe.exists,
            domA1InnerDisplay: a1Probe.innerDisplay,
            domA2InnerDisplay: a2Probe.innerDisplay,
            a1EffectiveVisible: a1Probe.effectiveVisible,
            a2EffectiveVisible: a2Probe.effectiveVisible,
            a2HiddenBy: a2Probe.hiddenBy,
            a2RectArea: a2Probe.rectArea,
            a2RenderedText: a2Probe.text,
            groupVisibleIds: [...groupVisibleIds],
            groupVisibleText: [...groupVisibleText]
          })
          if (!w.__selDelSamplerReady) w.__selDelSamplerReady = true
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      },
      { a1, a2, u1 }
    )
    await page.waitForFunction(
      () => (window as unknown as { __selDelSamplerReady?: boolean }).__selDelSamplerReady === true,
      undefined,
      { timeout: 10000 }
    )

    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const container = page.locator(`[id="message-${esc(a1)}"][data-message-id="${esc(a1)}"]`).first()
    await expect(container, `selected assistant ${a1} must be visible`).toBeVisible({ timeout: 15000 })
    await page.evaluate((id: string) => {
      const e =
        typeof CSS !== 'undefined' && (CSS as unknown as { escape: (s: string) => string }).escape
          ? (CSS as unknown as { escape: (s: string) => string }).escape(id)
          : id
      const el = document.querySelector(`[id="message-${e}"][data-message-id="${e}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, a1)
    try {
      await container.hover({ timeout: 8000 })
    } catch {}
    const deleteBtn = container.locator('[data-testid="message-delete-button"]')
    await expect(deleteBtn, 'delete button must be attached').toBeAttached({ timeout: 10000 })
    // Absolute page timestamp of the delete gesture: frames before it are the
    // intact selected-answer state, frames after it must never be answerless.
    const clickAt = await page.evaluate(() => performance.now())
    await deleteBtn.click({ timeout: 10000 })

    // State-driven stop: wait until Redux no longer contains a1 and several subsequent frames observed
    await page.waitForFunction(
      ({ a1 }: { a1: string }) => {
        const s = (
          window as unknown as {
            store: { getState: () => { messages: { messageIdsByTopic: Record<string, string[]> } } }
          }
        ).store.getState()
        const ids: string[] = Object.values(s.messages.messageIdsByTopic).flat() as string[]
        const hasA1 = ids.includes(a1)
        if (hasA1) return false
        const frames = (window as unknown as { __selDelFrames: SampleFrame[] }).__selDelFrames
        if (!frames || frames.length < 10) return false
        // Ensure at least 5 frames after first !reduxHasA1
        const firstIdx = frames.findIndex((f) => !f.reduxHasA1)
        if (firstIdx === -1) return false
        return frames.length - firstIdx >= 6
      },
      { a1 },
      { timeout: 30000 }
    )
    // Give a few more rAF ticks for DOM to settle
    await page.waitForTimeout(300)
    const frames: SampleFrame[] = await page.evaluate(() => {
      const w = window as unknown as { __selDelFrames: SampleFrame[]; __selDelSampling: boolean }
      w.__selDelSampling = false
      return w.__selDelFrames
    })
    expect(frames.length, 'sampler must have captured frames').toBeGreaterThan(10)
    const firstDeletedIdx = frames.findIndex((f) => !f.reduxHasA1)
    expect(firstDeletedIdx, 'must observe delete commit (reduxHasA1 false) in sampled frames').toBeGreaterThanOrEqual(0)

    // Sampler-level controls on the REAL product DOM. Without both, "no blank
    // frame" could pass without the probe ever discriminating (a vacuous
    // check): the survivor's element existed while it was not rendered, and
    // the selected variant really was rendered before the delete.
    expect(
      frames.some((f) => f.reduxHasA1 && f.domA2Exists && !f.a2EffectiveVisible),
      'sampler must observe the survivor DOM-present but NOT rendered before delete (negative control)'
    ).toBe(true)
    expect(
      frames.some((f) => f.reduxHasA1 && f.a1EffectiveVisible),
      'sampler must observe the selected variant actually rendered before delete (positive control)'
    ).toBe(true)

    // Correlated check: from first frame where a1 is gone from Redux, survivor
    // a2 must be truly rendered in that same frame
    const firstDeletedFrame = frames[firstDeletedIdx]
    expect(firstDeletedFrame.reduxHasA2, 'survivor must still be in Redux at delete commit').toBe(true)
    expect(firstDeletedFrame.domA2Exists, 'survivor DOM must exist at first deleted frame').toBe(true)
    expect(
      firstDeletedFrame.a2EffectiveVisible,
      `survivor must be truly rendered at first deleted frame (inner display=${
        firstDeletedFrame.domA2InnerDisplay
      }, hiddenBy=${String(firstDeletedFrame.a2HiddenBy)}, rectArea=${firstDeletedFrame.a2RectArea})`
    ).toBe(true)
    expect(
      firstDeletedFrame.groupVisibleIds,
      'semantic group must have a rendered answer at first deleted frame'
    ).toContain(a2)
    expect(firstDeletedFrame.groupVisibleIds.length, 'group must not be empty at first deleted frame').toBeGreaterThan(
      0
    )
    // ...and it must be the survivor's own seeded answer body, not merely any text
    expect(
      firstDeletedFrame.a2RenderedText,
      'survivor rendered text must contain its own seeded answer body at first deleted frame'
    ).toContain('main-long-a2-survivor-continuous')

    // After the gesture no sampled frame may paint without a rendered answer,
    // and once a1 has left the loaded projection the rendered answer must be a2.
    const seededAnswerBodies = ['main-short-a1', 'main-long-a2-survivor-continuous']
    const hasRenderedAnswerBody = (f: SampleFrame) =>
      f.groupVisibleText.some((t) => seededAnswerBodies.some((body) => t.includes(body)))
    const postClick = frames.filter((f) => f.tAbs >= clickAt)
    expect(postClick.length, 'sampler must have captured frames after the delete gesture').toBeGreaterThan(5)
    const violating = postClick.filter((f) => {
      if (!hasRenderedAnswerBody(f)) return true
      if (f.groupVisibleIds.length === 0) return true
      return !f.reduxHasA1 && (!f.a2EffectiveVisible || !f.groupVisibleIds.includes(a2))
    })
    expect(
      violating,
      `no post-delete frame may paint without a rendered answer (a2 once a1 is gone); violating: ${JSON.stringify(
        violating.slice(0, 2).map((f) => ({
          t: f.tAbs,
          reduxHasA1: f.reduxHasA1,
          a2EffectiveVisible: f.a2EffectiveVisible,
          a2HiddenBy: f.a2HiddenBy,
          a2InnerDisplay: f.domA2InnerDisplay,
          groupVisibleIds: f.groupVisibleIds
        }))
      )}`
    ).toEqual([])

    // Also ensure no zero-visible-group frame after commit (up to end)
    const postCommitZero = frames.slice(firstDeletedIdx).filter((f) => f.groupVisibleIds.length === 0)
    expect(
      postCommitZero,
      `post-commit group must never be empty; zero frames: ${JSON.stringify(postCommitZero.slice(0, 2))}`
    ).toEqual([])

    // Final DOM/Redux: survivor visible, deleted gone, thinking→main_text order
    const finalDom = await page.evaluate(
      ({ a1, a2 }: { a1: string; a2: string }) => {
        const probe = (window as unknown as ProbeWindow).__selDelProbe
        const a1Probe = probe(document.getElementById(`message-${a1}`))
        const a2Probe = probe(document.getElementById(`message-${a2}`))
        const state = (
          window as unknown as {
            store: {
              getState: () => {
                messages: {
                  entities: Record<string, { blocks?: string[] }>
                  messageIdsByTopic: Record<string, string[]>
                }
                messageBlocks: { entities: Record<string, { type?: string }> }
              }
            }
          }
        ).store.getState()
        const bIds: string[] = (state.messages.entities[a2] as { blocks?: string[] } | undefined)?.blocks ?? []
        const types = bIds.map((bid) => state.messageBlocks.entities[bid]?.type ?? 'unknown')
        return {
          a1Exists: a1Probe.exists,
          a2Exists: a2Probe.exists,
          a2EffectiveVisible: a2Probe.effectiveVisible,
          a2InnerDisplay: a2Probe.innerDisplay,
          a2HiddenBy: a2Probe.hiddenBy,
          a2Text: a2Probe.text,
          bIds,
          types
        }
      },
      { a1, a2 }
    )
    expect(finalDom.a1Exists).toBe(false)
    expect(finalDom.a2Exists).toBe(true)
    expect(
      finalDom.a2EffectiveVisible,
      `survivor must be truly rendered in the final state (inner display=${finalDom.a2InnerDisplay}, hiddenBy=${String(
        finalDom.a2HiddenBy
      )})`
    ).toBe(true)
    expect(finalDom.a2Text, 'survivor must render its own seeded answer body').toContain(
      'main-long-a2-survivor-continuous'
    )
    expect(finalDom.bIds).toHaveLength(2)
    expect(finalDom.types).toEqual(['thinking', 'main_text'])

    const reduxAfter = await page.evaluate(
      ({ a1, a2 }: { a1: string; a2: string }) => {
        const s = (
          window as unknown as {
            store: {
              getState: () => {
                messages: { messageIdsByTopic: Record<string, string[]> }
                residentRegistry: { entries: Record<string, { residentTopic?: boolean }> }
              }
            }
          }
        ).store.getState()
        const ids: string[] = Object.values(s.messages.messageIdsByTopic).flat() as string[]
        const hasA1 = ids.includes(a1)
        const hasA2 = ids.includes(a2)
        const topicId =
          Object.keys(s.messages.messageIdsByTopic).find((tid) => s.messages.messageIdsByTopic[tid]?.includes(a2)) ?? ''
        const resident = !!s.residentRegistry?.entries?.[topicId]?.residentTopic
        const count = topicId ? (s.messages.messageIdsByTopic[topicId]?.length ?? 0) : 0
        return { hasA1, hasA2, resident, count, topicId }
      },
      { a1, a2 }
    )
    expect(reduxAfter.hasA1).toBe(false)
    expect(reduxAfter.hasA2).toBe(true)
    expect(reduxAfter.resident).toBe(true)
    expect(reduxAfter.count).toBe(3)

    // Authoritative Main probe while still open (no double-close): survivor persists
    const mainProbe = await page.evaluate(
      async ({ topicId, a2 }: { topicId: string; a2: string }) => {
        const api = (
          window as unknown as {
            api: {
              chatDb: {
                getRawTopic: (p: {
                  topicId: string
                }) => Promise<{ ok: boolean; value?: { messages: Array<{ id: string }> } }>
              }
            }
          }
        ).api.chatDb
        const res = await api.getRawTopic({ topicId })
        if (!res.ok || !res.value) return { ok: false as const, err: JSON.stringify(res) }
        const ids = res.value.messages.map((m) => m.id)
        return { ok: true as const, ids, hasA2: ids.includes(a2) }
      },
      { topicId, a2 }
    )
    expect(mainProbe.ok).toBe(true)
    if (mainProbe.ok) {
      expect(mainProbe.hasA2).toBe(true)
    }
  })
})
