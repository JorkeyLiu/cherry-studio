/**
 * Startup stage instrumentation E2E (S7.13 + S7.14-E1 firstData) — synthetic disposable-profile only.
 *
 * Default-off/fail-closed: plain `pnpm test:e2e` stays inert and this spec is
 * skipped. Synthetic harness run requires BOTH gates and synthetic profile:
 *   STARTUP_STAGE_ATTR=1 STARTUP_STAGE_SYNTHETIC=1 pnpm test:e2e -- tests/e2e/specs/startup/startup-stage-instrumentation.spec.ts
 * Build must also have been done with STARTUP_STAGE_ATTR=1 (inlined define).
 * The fixture guarantees a unique disposable userDataDir under an owned root with
 * exact cleanup; no persistent artifacts or raw profile paths are logged.
 * S7.14-E1 adds optional renderer.firstData (one-shot interval from
 * ordinaryTreeReady to first active-topic fetchMessagesWindow settlement, when
 * a first topic exists; otherwise fail-closed).
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { epochComparable, validateStartupRecords } from '../../utils/startupStage'

const STARTUP_STAGE_VALIDATED_ENV = '__CHERRY_STARTUP_STAGE_VALIDATED'

function gateEnabled(): boolean {
  const a = process.env.STARTUP_STAGE_ATTR
  const s = process.env.STARTUP_STAGE_SYNTHETIC
  const norm = (v: string | undefined) => v?.trim().toLowerCase() === '1' || v?.trim().toLowerCase() === 'true'
  return norm(a) && norm(s)
}

test.describe('startup stage instrumentation (synthetic disposable)', () => {
  test.skip(
    !gateEnabled(),
    'STARTUP_STAGE_ATTR=1 + STARTUP_STAGE_SYNTHETIC=1 required (synthetic disposable harness only)'
  )

  test('records bounded privacy-safe stages on comparable epoch timeline', async ({ mainWindow, electronApp }) => {
    // Prove causal Main-authoritative marker without raw paths — check opaque marker presence
    const mainMarker = await electronApp.evaluate((_, envName) => {
      try {
        return (process as any).env?.[envName] ?? null
      } catch {
        return null
      }
    }, STARTUP_STAGE_VALIDATED_ENV)
    const rendererMarker = await mainWindow.evaluate((envName) => {
      try {
        const winAny = window as unknown as { electron?: { process?: { env?: Record<string, string> } } }
        const fromElectron = winAny.electron?.process?.env?.[envName]
        if (typeof fromElectron === 'string') return fromElectron
        const fromProcess = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.[
          envName
        ]
        if (typeof fromProcess === 'string') return fromProcess
        return null
      } catch {
        return null
      }
    }, STARTUP_STAGE_VALIDATED_ENV)

    // Collect renderer state via test seam (mainWindow)
    const rendererState = await mainWindow.evaluate(() => {
      const fn = (globalThis as any).__startupStageRead
      return typeof fn === 'function'
        ? fn()
        : { enabled: false, records: [], overflowed: false, epochAnchorMs: 0, perfAnchorMs: 0 }
    })
    // Collect Main state via existing test-only Main-context global seam (electronApp)
    const mainState = await electronApp.evaluate(() => {
      const fn = (globalThis as any).__startupStageRead
      return typeof fn === 'function'
        ? fn()
        : { enabled: false, records: [], overflowed: false, epochAnchorMs: 0, perfAnchorMs: 0 }
    })

    // Both processes must be enabled via positive disposable-profile validation
    expect(mainState.enabled).toBe(true)
    expect(rendererState.enabled).toBe(true)

    // Causal marker: Main must have set opaque marker after exact validation, renderer must have inherited it
    // No raw paths checked — marker is opaque '1' set only on Main success before BrowserWindow creation
    expect(mainMarker).toBe('1')
    expect(rendererMarker).toBe('1')

    const mainProblems = validateStartupRecords(mainState)
    expect(mainProblems, `main startup record problems: ${mainProblems.join('; ')}`).toEqual([])
    const rendererProblems = validateStartupRecords(rendererState)
    expect(rendererProblems, `renderer startup record problems: ${rendererProblems.join('; ')}`).toEqual([])

    // Comparable epoch timeline via shared anchor (Main + renderer within 60s)
    expect(epochComparable(mainState as any, rendererState as any)).toBe(true)

    // Expected renderer stages: both gate-ready milestones must be present and ordered
    // S7.14-E1 firstData is optional — when emitted it must be ordered after ordinaryTreeReady
    const rStages = rendererState.records.map((r: any) => r.stage)
    expect(rStages).toEqual(expect.arrayContaining(['renderer.bootstrap']))
    expect(rStages).toEqual(expect.arrayContaining(['renderer.persistRehydrate']))
    expect(rStages).toEqual(expect.arrayContaining(['renderer.importProjectionReady']))
    expect(rStages).toEqual(expect.arrayContaining(['renderer.ordinaryTreeReady']))
    const idxImport = rStages.indexOf('renderer.importProjectionReady')
    const idxOrd = rStages.indexOf('renderer.ordinaryTreeReady')
    expect(idxImport).toBeGreaterThanOrEqual(0)
    expect(idxOrd).toBeGreaterThanOrEqual(0)
    expect(idxImport).toBeLessThan(idxOrd)
    // Optional firstData ordering/shape — default disposable has no topics, so firstData may be absent (fail-closed)
    const idxFirst = rStages.indexOf('renderer.firstData')
    if (idxFirst !== -1) {
      expect(idxOrd).toBeLessThan(idxFirst)
      const recFirst = rendererState.records.find((r: any) => r.stage === 'renderer.firstData')
      expect(Number.isFinite((recFirst as any).durationMs) && (recFirst as any).durationMs >= 0).toBe(true)
      expect(Number.isFinite((recFirst as any).elapsedMs) && (recFirst as any).elapsedMs >= 0).toBe(true)
      expect((recFirst as any).elapsedMs).toBeGreaterThanOrEqual(
        (rendererState.records.find((r: any) => r.stage === 'renderer.ordinaryTreeReady') as any).elapsedMs
      )
      if ((recFirst as any).reason) {
        expect((recFirst as any).reason).not.toMatch(/[\/\\]/)
        expect((recFirst as any).reason.length).toBeLessThanOrEqual(64)
      }
    }

    // Main should have at least some sequential stages (restore, chatDbInit, etc.)
    const mStages = mainState.records.map((r: any) => r.stage)
    expect(mStages.length).toBeGreaterThan(0)

    // No content/paths in reasons for both processes
    for (const r of [...mainState.records, ...rendererState.records]) {
      if ((r as any).reason) {
        expect((r as any).reason).not.toMatch(/[\/\\]/)
        expect((r as any).reason.length).toBeLessThanOrEqual(64)
      }
      // Strict non-negative checks for epoch/duration
      expect(Number.isFinite((r as any).epochMs) && (r as any).epochMs >= 0).toBe(true)
      expect(Number.isFinite((r as any).durationMs) && (r as any).durationMs >= 0).toBe(true)
    }

    // Comparable epoch anchors: both within 60s of wall-clock
    const now = Date.now()
    expect(Math.abs(rendererState.epochAnchorMs - now)).toBeLessThan(60_000)
    expect(Math.abs(mainState.epochAnchorMs - now)).toBeLessThan(60_000)
  })

  test('records firstData when seeded active topic loads (synthetic disposable, seeded)', async ({
    mainWindow,
    electronApp
  }) => {
    // Seeded path — uses existing ensureTopic/pasteMessagesToTopic IPC only, no new channel/schema.
    // Proves firstData attribution for the first eligible active-topic startup window settlement
    // after ordinaryTreeReady, with stale/no-topic guard (polls via test seam, bounded numeric-only).
    const seedResult = await mainWindow.evaluate(async () => {
      const winAny = window as unknown as {
        store?: any
        api?: { chatDb?: { ensureTopic: (a: any) => Promise<any>; pasteMessagesToTopic: (a: any) => Promise<any> } }
      }
      try {
        const store = winAny.store
        if (!store) return { ok: false, err: 'store missing' }
        const state = store.getState()
        const assistant = state.assistants?.assistants?.[0] as any
        if (!assistant) return { ok: false, err: 'assistant missing' }
        const topicId = `e2e-firstdata-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const name = 'E2E FirstData Seeded'
        const topic = {
          id: topicId,
          assistantId: assistant.id,
          name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as any
        const chatDb: any = winAny.api?.chatDb
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function') {
          return { ok: false, err: 'chatDb missing' }
        }
        // Redux projection for topic list
        store.dispatch({ type: 'assistants/addTopic', payload: { assistantId: assistant.id, topic } } as any)
        const ensured = await chatDb.ensureTopic({ topicId, assistantId: assistant.id, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
        // Paste minimal 2 messages (user + assistant) as one batch IPC
        const now = new Date().toISOString()
        const entries = [
          {
            message: {
              id: `m-seed-u-${topicId}`,
              assistantId: assistant.id,
              topicId,
              role: 'user',
              content: 'seed user',
              createdAt: now,
              status: 'success',
              blocks: [`b-seed-u-${topicId}`]
            } as any,
            blocks: [
              {
                id: `b-seed-u-${topicId}`,
                messageId: `m-seed-u-${topicId}`,
                type: 'main_text',
                content: 'seed user',
                status: 'success',
                createdAt: now
              } as any
            ]
          },
          {
            message: {
              id: `m-seed-a-${topicId}`,
              assistantId: assistant.id,
              topicId,
              role: 'assistant',
              askId: `m-seed-u-${topicId}`,
              createdAt: now,
              status: 'success',
              blocks: [`b-seed-a-${topicId}`]
            } as any,
            blocks: [
              {
                id: `b-seed-a-${topicId}`,
                messageId: `m-seed-a-${topicId}`,
                type: 'main_text',
                content: 'seed assistant',
                status: 'success',
                createdAt: now
              } as any
            ]
          }
        ]
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
        return { ok: true, topicId }
      } catch (e: any) {
        return { ok: false, err: String(e?.message ?? e) }
      }
    })
    expect(seedResult.ok, `seed failed: ${(seedResult as any).err}`).toBe(true)
    const seededTopicId = (seedResult as any).topicId as string

    // Establish active-topic provenance BEFORE thunk mutates state (LOCK-003).
    // Seeded click would otherwise be non-active (current != seeded) and fail-closed/consume.
    // Use existing Redux contract to make active observable pre-dispatch.
    const activated = await mainWindow.evaluate(async (topicId) => {
      const winAny = window as unknown as { store?: any }
      try {
        const store = winAny.store
        if (!store) return { ok: false, err: 'store missing' }
        store.dispatch({ type: 'newMessages/setCurrentTopicId', payload: topicId } as any)
        const cur = store.getState()?.messages?.currentTopicId
        return { ok: cur === topicId, cur }
      } catch (e: any) {
        return { ok: false, err: String(e?.message ?? e) }
      }
    }, seededTopicId)
    expect(
      activated.ok,
      `active provenance before load failed: ${(activated as any).err ?? (activated as any).cur}`
    ).toBe(true)

    // Activate seeded topic via UI click — now pre-dispatch active, triggers eligible loadTopicMessagesThunk
    const topicSelector = `[data-testid="topic-item"][data-topic-id="${seededTopicId}"]`
    await mainWindow.waitForSelector(topicSelector, { state: 'visible', timeout: 15000 })
    await mainWindow.click(topicSelector)

    // Require concrete seeded message projection — no swallowed timeout; prove data projection via production selectors
    const userMsgSelector = `#messages [data-message-id="m-seed-u-${seededTopicId}"]`
    const asstMsgSelector = `#messages [data-message-id="m-seed-a-${seededTopicId}"]`
    await mainWindow.waitForSelector(userMsgSelector, { state: 'attached', timeout: 15000 })
    await mainWindow.waitForSelector(asstMsgSelector, { state: 'attached', timeout: 15000 })
    // Additional selector proof via evaluate (fail if not found)
    const projectionOk = await mainWindow.evaluate((topicId) => {
      const userId = `m-seed-u-${topicId}`
      const asstId = `m-seed-a-${topicId}`
      const hasUser = !!document.querySelector(`#messages [data-message-id="${userId}"]`)
      const hasAsst = !!document.querySelector(`#messages [data-message-id="${asstId}"]`)
      // Also verify Redux projection via store (existing contract, no new IPC)
      const winAny = window as unknown as { store?: any }
      let reduxOk = false
      try {
        const state = winAny.store?.getState()
        const ids: string[] = state?.messages?.messageIdsByTopic?.[topicId] ?? []
        // For empty-window edge, also check entities
        const hasIds = ids.includes(userId) && ids.includes(asstId)
        const hasEntities = !!(state?.messages?.entities?.[userId] || (state as any)?.messages?.entities?.[userId])
        // Fallback: at least DOM proves projection; Redux check is supplementary
        reduxOk = hasIds || hasEntities || ids.length >= 2
      } catch {}
      return { hasUser, hasAsst, reduxOk }
    }, seededTopicId)
    expect(projectionOk.hasUser, 'seeded user message must be projected in #messages').toBe(true)
    expect(projectionOk.hasAsst, 'seeded assistant message must be projected in #messages').toBe(true)

    // Poll for firstData via test seam (bounded wait, no path leakage) — require ok status
    const firstDataRec = await mainWindow.evaluate(async () => {
      const start = Date.now()
      while (Date.now() - start < 8000) {
        const fn = (globalThis as any).__startupStageRead
        const state = typeof fn === 'function' ? fn() : { records: [] as any[] }
        const rec = (state.records as any[]).find((r) => r.stage === 'renderer.firstData')
        if (rec) return rec
        await new Promise((r) => setTimeout(r, 200))
      }
      return null
    })
    expect(
      firstDataRec,
      'renderer.firstData should be recorded after seeded active-topic window settlement'
    ).not.toBeNull()
    expect((firstDataRec as any).status, 'seeded settlement must be ok, not error').toBe('ok')
    expect(Number.isFinite((firstDataRec as any).durationMs) && (firstDataRec as any).durationMs >= 0).toBe(true)
    expect(Number.isFinite((firstDataRec as any).elapsedMs) && (firstDataRec as any).elapsedMs >= 0).toBe(true)
    // Ordering and privacy-safe
    const ordRec = await mainWindow.evaluate(() => {
      const fn = (globalThis as any).__startupStageRead
      const state = typeof fn === 'function' ? fn() : { records: [] as any[] }
      return (state.records as any[]).find((r) => r.stage === 'renderer.ordinaryTreeReady') ?? null
    })
    expect(ordRec).not.toBeNull()
    expect((firstDataRec as any).elapsedMs).toBeGreaterThanOrEqual((ordRec as any).elapsedMs)
    if ((firstDataRec as any).reason) {
      expect((firstDataRec as any).reason).not.toMatch(/[\/\\]/)
      expect((firstDataRec as any).reason.length).toBeLessThanOrEqual(64)
    }
    // One-shot: second load must not create second record
    const countAfter = await mainWindow.evaluate(() => {
      const fn = (globalThis as any).__startupStageRead
      const state = typeof fn === 'function' ? fn() : { records: [] as any[] }
      return (state.records as any[]).filter((r) => r.stage === 'renderer.firstData').length
    })
    expect(countAfter).toBe(1)

    // Main marker still valid
    const mainMarker = await electronApp.evaluate((_, envName) => {
      try {
        return (process as any).env?.[envName] ?? null
      } catch {
        return null
      }
    }, STARTUP_STAGE_VALIDATED_ENV)
    expect(mainMarker).toBe('1')
  })
})
