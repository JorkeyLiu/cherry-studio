/**
 * Page viewport resume — Chat→Settings→Chat browser-tab-like in-place resume.
 *
 * FOCUSED E2E (real UI, real IPC, shared fixture, disposable profile, mock
 * provider, fresh build). Production fix is owned by another agent
 * (src/renderer); this spec is the user-approved regression contract only.
 *
 * Regression observable contract (from clean-ef7118cf57 diagnostic):
 * - Ordinary unchanged same-route return must show the pre-detour stable
 *   anchor identity + offset (or true-bottom semantics) on the FIRST eligible
 *   visible frame and on EVERY visible frame — middle returns previously
 *   flashed a wrong older message for ~2 sampled frames while top/bottom
 *   first frames happened to be correct.
 * - No fake pass by hiding: every return must produce a nonzero visible frame
 *   count with hidden < total; a fully-hidden sample fails.
 * - Valid in-place resume keeps the existing window/message row identity
 *   (no unconditional around/latest reload) and leaves the persisted snapshot
 *   unchanged; no stale overlay from another route.
 *
 * Coverage (single seeded topic, ordinary wheel-established positions):
 * - top leg (verifies TRUE top), middle leg (verifies TRUE middle, not an
 *   incidental position), true-bottom leg (column-reverse scrollTop 0).
 * - Repeated + rapid Settings↔Chat while the intermediate predecessor never
 *   settled/saved (newest stable snapshot still wins).
 * - Missing/invalid retained anchor fallback (victim authority delete +
 *   disposable loaded-projection clear while hidden; seed rows remain SQLite;
 *   emptied window must issue a full route-thunk request and land on a legal
 *   survivor viewport with no stale overlay).
 * Interrupted in-flight restore with a held load and old late-completion
 * preservation stays covered by CG2b in route-settings-session.spec.ts and is
 * intentionally not duplicated here.
 *
 * Seams only (no implementation-internal lifecycle/DOM attr names beyond the
 * established public test surface): #messages, #home-page,
 * [data-message-id], data-viewport-phase, window.keyv scroll keys, stable
 * sidebar nav testids, ordinary mouse wheel, store.subscribe selection of the
 * canonical loadingByTopic flag, established newMessages/messageBlocks
 * projection reducers, read-only Main fetchMessagesWindow authority proof.
 * Tolerances follow the repo
 * (12px anchor/offset, 100px bottom); no pixel-exact time/SLA asserts, no
 * sleep-as-completion (sampler starts BEFORE the return).
 */
import type { Page } from '@playwright/test'
import { expect, test } from '../../fixtures/electron.fixture'
import { SidebarPage } from '../../pages/sidebar.page'
import { waitForAppReady, waitForChatReady, waitForSettingsLoad } from '../../utils/wait-helpers'
import { activateTopic, prepareAssistant, seedSourceTopic, uuidLike } from '../../utils/branch-route-setup'

const TOTAL = 30
const OFFSET_TOL = 12
const BOTTOM_TOL = 100
const TOP_TOL = 120

interface Anchor {
  id: string
  offset: number
}

interface Snap {
  id: string
  scrollTop: number | null
  isAtBottom: boolean | null
}

interface ResumeFrame {
  t: number
  anchorId: string
  anchorOffset: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  phase: string
  homeVisible: boolean
  messagesVisible: boolean
  containerVis: string
}

// Canonical route-window request observation (subscribe-based, no dispatch
// monkeypatch). Redux applyMiddleware wires thunk's inner dispatch to the
// internal composed dispatch closure (middlewareAPI.dispatch forwards to the
// internal `dispatch` variable), NOT to the mutable `store.dispatch`
// property. Overwriting `window.store.dispatch` therefore observes only
// external plain-action calls and MISSES thunk-internal
// setTopicLoading/rebase dispatches, so a zero wrapped-dispatch count never
// proved "no read" and a nonzero count could false-fail even when the fetch
// ran. This probe uses store.subscribe (fires synchronously per committed
// dispatch, including thunk-inner ones) selecting the canonical
// newMessages.loadingByTopic[topicId] flag. Source contract:
// loadRouteMessagesThunk (messageThunk.ts) always dispatches
// newMessages/setTopicLoading {topicId, loading:true} BEFORE the window read
// and loading:false in finally. Meaning: no false->true edge = no public
// route-thunk request started for this topic during the window; >=1 edge =
// request invoked. Publication (rebase/merge/messageIds join,
// generation/branch identity) is a SEPARATE state fact recorded here only as
// diagnostic, never as the request gate; kind (around/latest) lives only in
// the fetchMessagesWindow IPC request and is not named here.
interface RouteLoadProbeSeed {
  startingLoading: boolean
  startingIdsJoin: string
  startingGen: number
  startingRoute: string | null
}

interface RouteLoadProbeSnapshot extends RouteLoadProbeSeed {
  loadingTransitions: number
  trueSightings: number
  idsCommits: number
  details: string[]
}

async function installRouteLoadProbe(page: Page, key: string, topicId: string): Promise<RouteLoadProbeSeed> {
  return await page.evaluate(
    ({ k, tid }: { k: string; tid: string }) => {
      const w = window as unknown as Record<string, unknown>
      if (w[k]) throw new Error('route load probe already installed')
      const store = (
        window as unknown as { store?: { getState: () => unknown; subscribe: (cb: () => void) => () => void } }
      ).store
      if (!store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') {
        throw new Error('store.subscribe unavailable')
      }
      const sel = (s: unknown): { loading: boolean; join: string; gen: number; route: string | null } => {
        const st = s as {
          messages?: { loadingByTopic?: Record<string, unknown>; messageIdsByTopic?: Record<string, unknown> }
          topicBranch?: {
            routeGenerationByTopic?: Record<string, unknown>
            activeBranchIdByTopic?: Record<string, unknown>
          }
        }
        const rawLoading = st?.messages?.loadingByTopic?.[tid]
        const ids = st?.messages?.messageIdsByTopic?.[tid]
        const genRaw = st?.topicBranch?.routeGenerationByTopic?.[tid]
        const routeRaw = st?.topicBranch?.activeBranchIdByTopic?.[tid]
        return {
          loading: rawLoading === true,
          join: Array.isArray(ids) ? (ids as string[]).join(',') : '',
          gen: typeof genRaw === 'number' ? genRaw : 0,
          route: typeof routeRaw === 'string' ? routeRaw : routeRaw === null ? null : null
        }
      }
      const init = sel(store.getState())
      const rec = {
        startingLoading: init.loading,
        startingIdsJoin: init.join,
        startingGen: init.gen,
        startingRoute: init.route,
        prevLoading: init.loading,
        prevJoin: init.join,
        loadingTransitions: 0,
        trueSightings: 0,
        idsCommits: 0,
        details: [] as string[],
        unsub: null as null | (() => void)
      }
      rec.unsub = store.subscribe(() => {
        try {
          const cur = sel(store.getState())
          if (cur.loading) rec.trueSightings += 1
          if (!rec.prevLoading && cur.loading) {
            rec.loadingTransitions += 1
            if (rec.details.length < 12) rec.details.push('loading:false->true')
          }
          rec.prevLoading = cur.loading
          if (cur.join !== rec.prevJoin) {
            rec.idsCommits += 1
            if (rec.details.length < 12)
              rec.details.push(
                `ids:${rec.prevJoin.split(',').filter(Boolean).length}->${cur.join.split(',').filter(Boolean).length}`
              )
            rec.prevJoin = cur.join
          }
        } catch {
          // never break the store on observation
        }
      })
      w[k] = rec
      return {
        startingLoading: rec.startingLoading,
        startingIdsJoin: rec.startingIdsJoin,
        startingGen: rec.startingGen,
        startingRoute: rec.startingRoute
      }
    },
    { k: key, tid: topicId }
  )
}

async function readRouteLoadProbe(page: Page, key: string): Promise<RouteLoadProbeSnapshot> {
  return await page.evaluate((k: string) => {
    const rec = (
      window as unknown as Record<
        string,
        | {
            startingLoading: boolean
            startingIdsJoin: string
            startingGen: number
            startingRoute: string | null
            loadingTransitions: number
            trueSightings: number
            idsCommits: number
            details: string[]
          }
        | undefined
      >
    )[k]
    if (!rec)
      return {
        startingLoading: false,
        startingIdsJoin: '',
        startingGen: 0,
        startingRoute: null,
        loadingTransitions: -1,
        trueSightings: -1,
        idsCommits: -1,
        details: []
      }
    return {
      startingLoading: rec.startingLoading,
      startingIdsJoin: rec.startingIdsJoin,
      startingGen: rec.startingGen,
      startingRoute: rec.startingRoute,
      loadingTransitions: rec.loadingTransitions,
      trueSightings: rec.trueSightings,
      idsCommits: rec.idsCommits,
      details: [...rec.details]
    }
  }, key)
}

async function removeRouteLoadProbe(
  page: Page,
  key: string
): Promise<{ snapshot: RouteLoadProbeSnapshot; cleaned: boolean }> {
  return await page.evaluate((k: string) => {
    const w = window as unknown as Record<string, unknown>
    const rec = w[k] as ({ unsub?: () => void } & Record<string, unknown>) | undefined
    let snap: RouteLoadProbeSnapshot = {
      startingLoading: false,
      startingIdsJoin: '',
      startingGen: 0,
      startingRoute: null,
      loadingTransitions: -1,
      trueSightings: -1,
      idsCommits: -1,
      details: []
    }
    try {
      const r = rec as unknown as RouteLoadProbeSnapshot | undefined
      if (r && typeof r.loadingTransitions === 'number') {
        snap = {
          startingLoading: r.startingLoading,
          startingIdsJoin: r.startingIdsJoin,
          startingGen: r.startingGen,
          startingRoute: r.startingRoute,
          loadingTransitions: r.loadingTransitions,
          trueSightings: r.trueSightings,
          idsCommits: r.idsCommits,
          details: [...r.details]
        }
      }
      try {
        rec?.unsub?.()
      } catch {
        // best-effort
      }
    } finally {
      delete w[k]
    }
    return { snapshot: snap, cleaned: !w[k] }
  }, key)
}

test.describe('Page viewport resume — Settings roundtrip keeps every visible frame on the stable anchor', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('top, middle, true-bottom + rapid returns show zero bad visible frames with stable identity', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'PAGE VIEWPORT RESUME: ordinary same-route Chat->Settings->Chat returns at verified top/middle/true-bottom show the pre-detour anchor (or bottom semantics) on the first and every visible rAF frame with nonzero visible count, unchanged snapshot/identity, and no stale overlay; rapid double roundtrip without intermediate settle still restores the newest stable snapshot.'
    })
    const page: Page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const sidebarPage = new SidebarPage(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `page-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `PageResume ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => uuidLike(i),
      contentPrefix: 'page-resume-'
    })
    const firstId = ids[0]
    const lastId = ids[ids.length - 1]
    await activateTopic(page, topicId, TOTAL)
    await waitViewportVisible(page)

    const homeHandle = await page.locator('#home-page').elementHandle()
    expect(homeHandle).not.toBeNull()

    // --- Shared local helpers (spec-scoped, ordinary input only) ---
    const readAnchor = (): Promise<Anchor | null> =>
      page.evaluate(() => {
        const container = document.querySelector('#messages') as HTMLElement | null
        if (!container) return null
        const c = container.getBoundingClientRect()
        const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
        const cands: { id: string; top: number; bottom: number }[] = []
        for (const row of rows) {
          const r = row.getBoundingClientRect()
          const id = row.getAttribute('data-message-id')
          if (id) cands.push({ id, top: r.top, bottom: r.bottom })
        }
        if (cands.length === 0) return null
        const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
        const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
        return { id: picked.id, offset: picked.top - c.top }
      })

    const settledOrThrow = async (): Promise<Anchor> => {
      let prev: Anchor | null = null
      let stable = 0
      const start = Date.now()
      let cur: Anchor | null = null
      while (Date.now() - start < 10000) {
        cur = await readAnchor()
        if (cur && prev && cur.id === prev.id && Math.abs(cur.offset - prev.offset) <= 2) {
          stable += 1
          if (stable >= 2) return cur
        } else stable = 0
        prev = cur
        await page.waitForTimeout(140)
      }
      throw new Error(`viewport failed to settle within 10s (last=${cur ? `${cur.id}@${cur.offset}` : 'null'})`)
    }

    const focusMessages = async (): Promise<void> => {
      const box = await page.locator('#messages').first().boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    }

    const wheel = async (dy: number): Promise<void> => {
      await focusMessages()
      await page.mouse.wheel(0, dy)
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      await page.waitForTimeout(220)
    }

    const readScrollState = (): Promise<{
      scrollTop: number
      scrollHeight: number
      clientHeight: number
      phase: string
    }> =>
      page.evaluate(() => {
        const c = document.querySelector('#messages') as HTMLElement | null
        return {
          scrollTop: c ? c.scrollTop : NaN,
          scrollHeight: c ? c.scrollHeight : NaN,
          clientHeight: c ? c.clientHeight : NaN,
          phase: c?.getAttribute('data-viewport-phase') ?? ''
        }
      })

    const readSnap = async (): Promise<Snap> =>
      page.evaluate((tid: string) => {
        const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
        for (const key of keys) {
          try {
            const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
            if (!raw || typeof raw !== 'object') continue
            const mid =
              typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                ? (raw.messageId as string)
                : typeof raw.anchorId === 'string'
                  ? (raw.anchorId as string)
                  : ''
            if (!mid) continue
            const st = typeof raw.scrollTop === 'number' ? (raw.scrollTop as number) : null
            const bottom = typeof raw.isAtBottom === 'boolean' ? (raw.isAtBottom as boolean) : null
            return { id: mid, scrollTop: st, isAtBottom: bottom }
          } catch {
            continue
          }
        }
        return { id: '', scrollTop: null, isAtBottom: null }
      }, topicId)

    // Bounded failure context for snapshot/live mismatches (synthetic fixture
    // IDs only, no message content). Called on waitSnapMatchesLive timeout
    // BEFORE rethrow so a 30s wait never ends without last state. Reports via
    // [E2E] console + annotation with: persisted snapshot objects (both keys),
    // allowed membership, production-style live anchor ([id^=message-]
    // visibility-filtered crossing-first) and test-style anchor+offset
    // ([data-message-id] crossing-first), controller phase, selected/displayed
    // identity, and bounded row id/rect geometry.
    const reportSnapTimeout = async (label: string, allowed: string[]): Promise<string> => {
      const ctx = await page
        .evaluate(
          ({ tid, ok }: { tid: string; ok: string[] }) => {
            const out: Record<string, unknown> = { tid }
            try {
              const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
              const snaps: Record<string, string> = {}
              let sid = ''
              for (const key of keys) {
                try {
                  const raw = (window as unknown as Record<string, unknown>).keyv as
                    | { get?: (k: string) => unknown }
                    | undefined
                  const val = (raw?.get?.(key) ?? null) as Record<string, unknown> | null
                  const s = val && typeof val === 'object' ? JSON.stringify(val).slice(0, 400) : String(val)
                  snaps[key] = s
                  if (val && typeof val === 'object' && !sid) {
                    const mid =
                      typeof val.messageId === 'string' && (val.messageId as string).length > 0
                        ? (val.messageId as string)
                        : typeof val.anchorId === 'string'
                          ? (val.anchorId as string)
                          : ''
                    if (mid && (ok as string[]).includes(mid)) sid = mid
                  }
                } catch (e) {
                  snaps[key] = `err:${e instanceof Error ? e.message : String(e)}`.slice(0, 120)
                }
              }
              out.snaps = snaps
              out.snapId = sid || '(none-in-allowed)'
              // Test-style anchor: [data-message-id] crossing-first.
              const container = document.querySelector('#messages') as HTMLElement | null
              const c = container?.getBoundingClientRect() ?? null
              const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
              const cands: { id: string; top: number; bottom: number }[] = []
              for (const row of rows) {
                const r = row.getBoundingClientRect()
                const id = row.getAttribute('data-message-id')
                if (id && c)
                  cands.push({ id, top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 })
              }
              let testAnchor = '(none)'
              if (c && cands.length > 0) {
                const ct = Math.round(c.top * 10) / 10
                const crossing = cands.find((x) => x.top <= ct && x.bottom > ct) ?? null
                const picked = crossing ?? cands.filter((x) => x.top >= ct).sort((a, b) => a.top - b.top)[0] ?? cands[0]
                testAnchor = `${picked.id}@${Math.round((picked.top - ct) * 10) / 10}`
              }
              out.testAnchor = testAnchor
              out.testInAllowed = testAnchor.split('@')[0] ? (ok as string[]).includes(testAnchor.split('@')[0]) : false
              // Production-style anchor: [id^="message-"] visibility-filtered crossing-first.
              let prodAnchor = '(none)'
              try {
                if (container && c) {
                  const els = Array.from(
                    container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')
                  ) as HTMLElement[]
                  const pcands: { id: string; top: number; bottom: number }[] = []
                  for (const el of els) {
                    try {
                      const cs = getComputedStyle(el)
                      if (cs.display === 'none') continue
                      const r = el.getBoundingClientRect()
                      if (r.height === 0) continue
                      const visH = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)
                      if (!(visH > 0)) continue
                      const id = el.id.replace(/^message-/, '')
                      if (id) pcands.push({ id, top: r.top, bottom: r.bottom })
                    } catch {
                      continue
                    }
                  }
                  if (pcands.length > 0) {
                    let cross: { id: string; top: number; bottom: number } | null = null
                    for (const cd of pcands) {
                      if (cd.top <= c.top && cd.bottom > c.top && (!cross || cd.top < cross.top)) cross = cd
                    }
                    const picked =
                      cross ?? pcands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? pcands[0]
                    prodAnchor = `${picked.id}@${Math.round((picked.top - c.top) * 10) / 10}`
                  }
                }
              } catch {
                prodAnchor = '(err)'
              }
              out.prodAnchor = prodAnchor
              out.phase = container?.getAttribute('data-viewport-phase') ?? '(no-container)'
              const st = (window as unknown as { store?: { getState?: () => unknown } }).store?.getState?.() as
                | Record<string, any>
                | undefined
              out.currentTopic = (st?.messages?.currentTopicId as string | null | undefined) ?? '(unknown)'
              const loaded: string[] = Array.isArray(st?.messages?.messageIdsByTopic?.[tid])
                ? (st.messages.messageIdsByTopic[tid] as string[])
                : []
              out.loadedLen = loaded.length
              out.loadedHead = loaded.slice(0, 3)
              out.loadedTail = loaded.slice(-3)
              const domIds = rows.map((r) => r.getAttribute('data-message-id') as string)
              out.domLen = domIds.length
              out.domHead = domIds.slice(0, 3)
              out.domTail = domIds.slice(-3)
              // Bounded row geometry: up to 4 head + 4 around live + 1 tail.
              const focusId = testAnchor.split('@')[0]
              let idx = domIds.indexOf(focusId)
              if (idx < 0) idx = 0
              const picks = new Set<number>()
              for (let i = 0; i < Math.min(4, domIds.length); i++) picks.add(i)
              for (let d = -2; d <= 2; d++) {
                const j = idx + d
                if (j >= 0 && j < domIds.length) picks.add(j)
              }
              if (domIds.length > 0) picks.add(domIds.length - 1)
              const geom: string[] = []
              const sorted = Array.from(picks).sort((a, b) => a - b)
              for (const j of sorted) {
                const row = rows[j]
                if (!row) continue
                const r = row.getBoundingClientRect()
                geom.push(`${domIds[j]} t=${Math.round(r.top)} b=${Math.round(r.bottom)}`)
              }
              out.geom = geom
              out.allowedLen = (ok as string[]).length
            } catch (e) {
              out.error = e instanceof Error ? e.message : String(e)
            }
            return out
          },
          { tid: topicId, ok: allowed }
        )
        .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))
      const summary =
        `snapTimeout label=${label} snapId=${String((ctx as Record<string, unknown>).snapId)} allowedLen=${String((ctx as Record<string, unknown>).allowedLen)} ` +
        `testAnchor=${String((ctx as Record<string, unknown>).testAnchor)} testInAllowed=${String((ctx as Record<string, unknown>).testInAllowed)} ` +
        `prodAnchor=${String((ctx as Record<string, unknown>).prodAnchor)} phase=${String((ctx as Record<string, unknown>).phase)} ` +
        `current=${String((ctx as Record<string, unknown>).currentTopic)} loadedLen=${String((ctx as Record<string, unknown>).loadedLen)} ` +
        `domLen=${String((ctx as Record<string, unknown>).domLen)} snaps=${JSON.stringify((ctx as Record<string, unknown>).snaps).slice(0, 600)} ` +
        `geom=[${((ctx as Record<string, unknown>).geom as string[] | undefined)?.join(' | ').slice(0, 800) ?? ''}]`
      try {
        // eslint-disable-next-line no-console
        console.log(`[E2E] ${summary}`)
      } catch {}
      test.info().annotations.push({ type: `snap-timeout-${label}`, description: summary.slice(0, 1900) })
      return summary
    }

    const waitSnapMatchesLive = async (allowed: string[]): Promise<void> => {
      try {
        await page.waitForFunction(
          ({ tid, ok }: any) => {
            const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
            let sid = ''
            for (const key of keys) {
              try {
                const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
                if (!raw || typeof raw !== 'object') continue
                const mid =
                  typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                    ? (raw.messageId as string)
                    : typeof raw.anchorId === 'string'
                      ? (raw.anchorId as string)
                      : ''
                if (mid && ok.includes(mid)) {
                  sid = mid
                  break
                }
              } catch {
                continue
              }
            }
            if (!sid) return false
            const container = document.querySelector('#messages') as HTMLElement | null
            if (!container) return false
            const c = container.getBoundingClientRect()
            const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
            const cands: { id: string; top: number; bottom: number }[] = []
            for (const row of rows) {
              const r = row.getBoundingClientRect()
              const id = row.getAttribute('data-message-id')
              if (id) cands.push({ id, top: r.top, bottom: r.bottom })
            }
            if (cands.length === 0) return false
            const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
            const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
            return picked.id === sid
          },
          { tid: topicId, ok: allowed },
          { timeout: 30000 }
        )
      } catch (err) {
        await reportSnapTimeout('prep', allowed)
        throw err
      }
    }

    const isTrueBottom = async (): Promise<boolean> => {
      const st = await readScrollState()
      if (Math.abs(st.scrollTop) > BOTTOM_TOL) return false
      return await page.evaluate((id: string) => {
        const container = document.querySelector('#messages') as HTMLElement | null
        const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const el = document.querySelector(`#messages [data-message-id="${esc}"]`) as HTMLElement | null
        if (!container || !el) return false
        const c = container.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return r.bottom > c.top && r.top < c.bottom
      }, lastId)
    }

    const isTrueTop = async (): Promise<boolean> => {
      const st = await readScrollState()
      const topExtreme = -(st.scrollHeight - st.clientHeight)
      if (Math.abs(st.scrollTop - topExtreme) > TOP_TOL) return false
      return await page.evaluate((id: string) => {
        const container = document.querySelector('#messages') as HTMLElement | null
        const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const el = document.querySelector(`#messages [data-message-id="${esc}"]`) as HTMLElement | null
        if (!container || !el) return false
        const c = container.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return r.bottom > c.top && r.top < c.bottom
      }, firstId)
    }

    const isTrueMiddle = async (anchorId: string): Promise<boolean> => {
      const idx = ids.indexOf(anchorId)
      if (idx < Math.floor(TOTAL / 3) || idx > Math.floor((TOTAL * 2) / 3)) return false
      const st = await readScrollState()
      const topExtreme = -(st.scrollHeight - st.clientHeight)
      if (Math.abs(st.scrollTop) < 200) return false
      if (Math.abs(st.scrollTop - topExtreme) < 200) return false
      if (await isTrueTop()) return false
      if (await isTrueBottom()) return false
      return true
    }

    // Ordinary wheel to a verified extreme/middle. Both wheel signs are tried
    // so no column-reverse sign assumption is baked in; direct scrollTop writes
    // are never used to establish the saved position.
    const wheelToBottom = async (): Promise<Anchor> => {
      for (let i = 0; i < 30; i++) {
        if (await isTrueBottom()) break
        await wheel(560)
      }
      if (!(await isTrueBottom())) {
        for (let i = 0; i < 30; i++) {
          if (await isTrueBottom()) break
          await wheel(-560)
        }
      }
      expect(await isTrueBottom(), 'bottom leg must reach TRUE bottom (scrollTop~0 + last row visible)').toBe(true)
      const s = await settledOrThrow()
      await waitViewportVisible(page)
      await waitSnapMatchesLive(ids)
      return s
    }

    const wheelToTop = async (): Promise<Anchor> => {
      for (let i = 0; i < 30; i++) {
        if (await isTrueTop()) break
        await wheel(-560)
      }
      if (!(await isTrueTop())) {
        for (let i = 0; i < 30; i++) {
          if (await isTrueTop()) break
          await wheel(560)
        }
      }
      expect(await isTrueTop(), 'top leg must reach TRUE top (top extreme + first row visible)').toBe(true)
      const s = await settledOrThrow()
      await waitViewportVisible(page)
      await waitSnapMatchesLive(ids)
      return s
    }

    const wheelToMiddle = async (): Promise<Anchor> => {
      // Sweep toward the center from whichever extreme we are at, then settle
      // on a middle-third anchor that is provably neither top nor bottom.
      for (let round = 0; round < 30; round++) {
        const cur = await readAnchor()
        if (cur && (await isTrueMiddle(cur.id))) {
          const s = await settledOrThrow()
          if (await isTrueMiddle(s.id)) {
            await waitViewportVisible(page)
            await waitSnapMatchesLive(ids)
            const confirmed = await settledOrThrow()
            if (await isTrueMiddle(confirmed.id)) return confirmed
          }
        }
        await wheel(round % 2 === 0 ? 560 : -560)
      }
      // Fallback sweep with the opposite bias before failing loudly.
      for (let round = 0; round < 30; round++) {
        const cur = await readAnchor()
        if (cur && (await isTrueMiddle(cur.id))) {
          const s = await settledOrThrow()
          await waitViewportVisible(page)
          await waitSnapMatchesLive(ids)
          return s
        }
        await wheel(round % 2 === 0 ? -420 : 420)
      }
      const last = await readAnchor()
      throw new Error(`middle leg could not reach a verified middle anchor (last=${last?.id ?? 'null'})`)
    }

    const captureRowIdentity = async (): Promise<void> => {
      await page.evaluate(() => {
        const c = document.querySelector('#messages')
        const m = new Map<string, HTMLElement>()
        if (c) {
          for (const el of Array.from(c.querySelectorAll('[data-message-id]'))) {
            const id = el.getAttribute('data-message-id')
            if (id) m.set(id, el as HTMLElement)
          }
        }
        ;(window as any).__resume_beforeRows = m
      })
    }

    const expectRowIdentityKept = async (sample: string[]): Promise<void> => {
      const kept: boolean = await page.evaluate((want: string[]) => {
        const before = (window as any).__resume_beforeRows as Map<string, HTMLElement> | undefined
        if (!before) return false
        const c = document.querySelector('#messages')
        if (!c) return false
        for (const id of want) {
          const orig = before.get(id)
          const cur = c.querySelector(`[data-message-id="${id}"]`)
          if (!orig || !cur || orig !== cur || !cur.isConnected) return false
        }
        return true
      }, sample)
      expect(kept, `in-place resume must keep window/row identity for [${sample.join(',')}]`).toBe(true)
    }

    // Sampler starts BEFORE the return (while still on Settings) and records
    // every rAF frame with visibility + provenance geometry, so the first
    // eligible visible frame after the return is captured — never reconstructed.
    const PROBE_KEY = '__page_resume_probe'
    const startResumeProbe = async (): Promise<void> => {
      await page.evaluate((k: string) => {
        const frames: ResumeFrame[] = []
        let running = true
        let raf = 0
        const t0 = performance.now()
        const readFrame = (): ResumeFrame => {
          const container = document.querySelector('#messages') as HTMLElement | null
          const home = document.querySelector('#home-page') as HTMLElement | null
          let homeVisible = false
          try {
            if (home) {
              if (typeof (home as any).checkVisibility === 'function') {
                homeVisible = (home as any).checkVisibility() as boolean
              } else {
                const r = home.getBoundingClientRect()
                const cs = getComputedStyle(home)
                homeVisible = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
              }
            }
          } catch {
            homeVisible = false
          }
          let messagesVisible = false
          let containerVis = ''
          let anchorId = ''
          let anchorOffset = 0
          let scrollTop = NaN
          let scrollHeight = NaN
          let clientHeight = NaN
          let phase = ''
          try {
            if (container) {
              const cs = getComputedStyle(container)
              containerVis = cs.visibility
              const r = container.getBoundingClientRect()
              messagesVisible = cs.display !== 'none' && r.width > 0 && r.height > 0
              scrollTop = container.scrollTop
              scrollHeight = container.scrollHeight
              clientHeight = container.clientHeight
              phase = container.getAttribute('data-viewport-phase') ?? ''
              const c = container.getBoundingClientRect()
              const rows = Array.from(container.querySelectorAll('[data-message-id]')) as HTMLElement[]
              const cands: { id: string; top: number; bottom: number }[] = []
              for (const row of rows) {
                const br = row.getBoundingClientRect()
                const id = row.getAttribute('data-message-id')
                if (id) cands.push({ id, top: br.top, bottom: br.bottom })
              }
              if (cands.length > 0) {
                const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
                const picked =
                  crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
                anchorId = picked.id
                anchorOffset = picked.top - c.top
              }
            }
          } catch {
            // keep defaults; frame still records the failure shape
          }
          return {
            t: Math.round((performance.now() - t0) * 10) / 10,
            anchorId,
            anchorOffset: Math.round(anchorOffset * 10) / 10,
            scrollTop: Math.round(scrollTop * 10) / 10,
            scrollHeight,
            clientHeight,
            phase,
            homeVisible,
            messagesVisible,
            containerVis
          }
        }
        const tick = () => {
          if (!running) return
          frames.push(readFrame())
          raf = requestAnimationFrame(tick)
        }
        tick()
        ;(window as any)[k] = {
          frames,
          stop: () => {
            running = false
            try {
              cancelAnimationFrame(raf)
            } catch {}
          }
        }
      }, PROBE_KEY)
    }

    const stopResumeProbe = async (): Promise<{ frames: ResumeFrame[] }> =>
      page.evaluate((k: string) => {
        const p = (window as any)[k] as { frames: ResumeFrame[]; stop: () => void } | undefined
        try {
          p?.stop?.()
        } catch {}
        const frames = p ? [...p.frames] : []
        delete (window as any)[k]
        return { frames }
      }, PROBE_KEY)

    // Non-terminating peek: copies sampled frames while the sampler keeps
    // running. Used only for timeout diagnostics before the ordered stop.
    const peekResumeProbe = async (): Promise<ResumeFrame[]> =>
      page.evaluate((k: string) => {
        const p = (window as any)[k] as { frames: ResumeFrame[] } | undefined
        return p ? [...p.frames] : []
      }, PROBE_KEY)

    const describeResumeFrame = (f: ResumeFrame): string =>
      `t=${f.t} anchor=${f.anchorId}@${f.anchorOffset} st=${f.scrollTop} phase=${f.phase} home=${f.homeVisible ? 1 : 0} msgs=${f.messagesVisible ? 1 : 0} vis=${f.containerVis}`

    // Route-window request observation uses the top-level subscribe-based
    // RouteLoadProbe (no store.dispatch monkeypatch; see header contract).
    // Row/window identity assertions remain the primary contract.
    const RESUME_PROBE_KEY = '__page_resume_load_probe'

    const assertResumeContract = async (
      label: string,
      expected: Anchor,
      expectedBottom: boolean,
      snapBefore: Snap,
      tightFirstFramePx: number | null = null
    ): Promise<void> => {
      // Corrected lifetime: the sampler started BEFORE the return keeps running
      // while the return reaches eventual viewport visible + stable termination.
      // Only THEN is it stopped and every visible frame asserted. Stopping
      // first would sample zero positioned frames and misread as hide-to-pass.
      try {
        await waitViewportVisible(page)
        await settledOrThrow()
      } catch (err) {
        const peeked = await peekResumeProbe().catch(() => [] as ResumeFrame[])
        const tail = peeked.slice(-8).map(describeResumeFrame).join(' | ')
        test.info().annotations.push({
          type: `resume-${label}-stabilize-timeout`,
          description: `stabilize timeout frames=${peeked.length} tail=[${tail}] err=${err instanceof Error ? err.message : String(err)}`
        })
        throw err
      }
      const { frames } = await stopResumeProbe()
      const visible = frames.filter((f) => f.homeVisible && f.messagesVisible && f.containerVis !== 'hidden')
      const hidden = frames.length - visible.length
      // Continuation contract: every home-visible frame is examined — never
      // filtered away. A valid retained return keeps showing its viewport, so
      // once Home paints, messages must already be there: no home-visible
      // frames with messages hidden/empty/positioning. The pre-paint
      // validated continuation commits before first paint; anything else is
      // an artificial blank transition (the old restore hid through rAF
      // settles here). Invalid-anchor/divider legs keep their own restore
      // assertions elsewhere and never pass through this contract.
      const homeVisibleFrames = frames.filter((f) => f.homeVisible)
      const blankWhileHome = homeVisibleFrames.filter(
        (f) => !f.messagesVisible || f.containerVis === 'hidden' || f.phase === 'positioning' || !f.anchorId
      )
      // Bounded frame diagnostics BEFORE any visible assert so logs always
      // contain the underlying phase/visibility/anchor shape on failure.
      const headDiag = frames.slice(0, 5).map(describeResumeFrame).join(' | ')
      const tailDiag = frames.slice(-8).map(describeResumeFrame).join(' | ')
      const blankDiag = blankWhileHome.slice(0, 8).map(describeResumeFrame).join(' | ')
      test.info().annotations.push({
        type: `resume-${label}`,
        description: `frames=${frames.length} visible=${visible.length} hidden=${hidden} homeVisible=${homeVisibleFrames.length} blankWhileHome=${blankWhileHome.length} expected=${expected.id}@${expected.offset} bottom=${expectedBottom} firstVisible=${visible.length > 0 ? `${visible[0].anchorId}@${visible[0].anchorOffset} st=${visible[0].scrollTop} phase=${visible[0].phase}` : 'none'}`
      })
      test.info().annotations.push({
        type: `resume-${label}-frames`,
        description: `head=[${headDiag}] tail=[${tailDiag}] blankWhileHome=[${blankDiag}]`
      })
      // No fake hiding: the return must actually paint visible frames.
      expect(frames.length, `${label}: sampler must capture frames across the return`).toBeGreaterThan(0)
      expect(visible.length, `${label}: must produce nonzero visible frames (no hide-to-pass)`).toBeGreaterThan(0)
      expect(hidden, `${label}: must not hide every sample`).toBeLessThan(frames.length)
      // No blank transition: the first home-visible frame already carries the
      // retained viewport — Home must never paint with messages hidden/empty.
      expect(
        blankWhileHome.length,
        `${label}: no home-visible blank/hidden frames on a valid retained return (blank=[${blankDiag}])`
      ).toBe(0)
      // First home-visible frame already matches the stable anchor (not just
      // the first post-settle visible frame): content AND position are
      // continuous across the detour.
      if (homeVisibleFrames.length > 0) {
        const firstHome = homeVisibleFrames[0]
        if (expectedBottom) {
          expect(
            Math.abs(firstHome.scrollTop),
            `${label}: first home-visible frame must already be true bottom`
          ).toBeLessThanOrEqual(BOTTOM_TOL)
        } else {
          expect(firstHome.anchorId, `${label}: first home-visible frame anchor identity`).toBe(expected.id)
          expect(
            Math.abs(firstHome.anchorOffset - expected.offset),
            `${label}: first home-visible frame anchor offset`
          ).toBeLessThanOrEqual(OFFSET_TOL)
          // Mismatch-leg deterministic proof: the 9px perturbation sits inside
          // the 12px measurement budget but outside the 1px production epsilon,
          // so the 12px check alone would pass WITHOUT any correction. The
          // tight 1px first-frame check below fails unless the pre-paint lane
          // performed its single synchronous correction before first paint.
          // Other legs keep the 12px budget (tightFirstFramePx null).
          if (tightFirstFramePx !== null) {
            expect(
              Math.abs(firstHome.anchorOffset - expected.offset),
              `${label}: first home-visible frame must already be production-exact (<=${tightFirstFramePx}px proves the minimal pre-paint correction ran)`
            ).toBeLessThanOrEqual(tightFirstFramePx)
          }
        }
      }
      // First eligible visible frame already matches — the pre-fix middle bug
      // showed a wrong older message here for ~2 frames before correcting.
      let firstBad = -1
      for (let i = 0; i < visible.length; i++) {
        const f = visible[i]
        if (expectedBottom) {
          if (Math.abs(f.scrollTop) > BOTTOM_TOL) {
            firstBad = i
            break
          }
        } else if (f.anchorId !== expected.id || Math.abs(f.anchorOffset - expected.offset) > OFFSET_TOL) {
          firstBad = i
          break
        }
      }
      if (firstBad !== -1) {
        const fb = visible[firstBad]
        const prev = firstBad > 0 ? visible[firstBad - 1] : null
        test.info().annotations.push({
          type: `resume-${label}-first-bad`,
          description: `firstBad=${firstBad} fb=${fb.anchorId}@${fb.anchorOffset} st=${fb.scrollTop} phase=${fb.phase} prev=${prev ? `${prev.anchorId}@${prev.anchorOffset}` : 'none'} expected=${expected.id}@${expected.offset}`
        })
      }
      expect(firstBad, `${label}: first and every visible frame must match the stable anchor`).toBe(-1)
      // Final state still matches; snapshot untouched by the detour. The
      // sampler is already stopped here, so a completion timeout reports the
      // live anchor/phase/scroll shape (frames above already carry the return).
      let fin: Anchor
      try {
        await waitViewportVisible(page)
        fin = await settledOrThrow()
      } catch (err) {
        const liveAnchor = await readAnchor().catch(() => null)
        const liveScroll = await readScrollState().catch(() => null)
        const liveSnap = await readSnap().catch(() => null)
        test.info().annotations.push({
          type: `resume-${label}-final-timeout`,
          description: `final stabilize timeout live=${liveAnchor ? `${liveAnchor.id}@${liveAnchor.offset}` : 'null'} scroll=${liveScroll ? `st=${liveScroll.scrollTop} phase=${liveScroll.phase}` : 'null'} snap=${liveSnap ? liveSnap.id : 'null'} err=${err instanceof Error ? err.message : String(err)}`
        })
        throw err
      }
      if (expectedBottom) {
        expect(await isTrueBottom(), `${label}: final state must still be true bottom`).toBe(true)
      } else {
        expect(fin.id, `${label}: final anchor identity unchanged`).toBe(expected.id)
        expect(Math.abs(fin.offset - expected.offset), `${label}: final anchor offset`).toBeLessThanOrEqual(OFFSET_TOL)
      }
      const snapAfter = await readSnap()
      expect(snapAfter.id, `${label}: snapshot identity unchanged`).toBe(snapBefore.id)
      // No stale overlay: every rendered row belongs to this topic.
      const rendered: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
          (r) => r.getAttribute('data-message-id') as string
        )
      )
      expect(rendered.length, `${label}: must render rows after return`).toBeGreaterThan(0)
      for (const rid of rendered) expect(ids, `${label}: no stale overlay ${rid}`).toContain(rid)
      expect(await homeHandle!.evaluate((node: Node) => node.isConnected)).toBe(true)
    }

    const roundtripWithProbe = async (
      label: string,
      expected: Anchor,
      expectedBottom: boolean,
      snapBefore: Snap,
      identitySample: string[]
    ): Promise<void> => {
      await captureRowIdentity()
      await sidebarPage.goToSettings()
      await waitForSettingsLoad(page)
      await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
      // Sampler + subscribe load probe start BEFORE the return while Chat is
      // hidden, so setup wheel/seed dispatches are excluded by construction.
      // The probe counts ONLY canonical loadingByTopic false->true edges for
      // this topic (subscribe fires synchronously per dispatch, including
      // thunk-inner ones, even when the read resolves immediately). For an
      // unchanged same-route resume, zero request edges proves in-place with
      // no route-thunk request effect; kind (around/latest) is IPC-only and
      // not named here. assertResumeContract waits for visible+stable WHILE
      // the sampler continues and stops only afterwards (corrected lifetime).
      await startResumeProbe()
      const seed = await installRouteLoadProbe(page, RESUME_PROBE_KEY, topicId)
      expect(seed.startingLoading, `${label}: seed loading must be false before return`).toBe(false)
      try {
        await sidebarPage.goToHome()
        await waitForChatReady(page)
        await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
        await assertResumeContract(label, expected, expectedBottom, snapBefore)
        const wc = await readRouteLoadProbe(page, RESUME_PROBE_KEY)
        test.info().annotations.push({
          type: `resume-${label}-request`,
          description: `route-thunk request loadingTransitions=${wc.loadingTransitions} trueSightings=${wc.trueSightings} idsCommits(diag)=${wc.idsCommits} startLoading=${seed.startingLoading} startGen=${seed.startingGen} startRoute=${seed.startingRoute ?? 'main'} details=[${wc.details.join('; ')}] (0 transitions = in-place, no route-thunk request)`
        })
        if (wc.loadingTransitions !== 0) {
          const peeked = await peekResumeProbe().catch(() => [] as ResumeFrame[])
          const head = peeked.slice(0, 5).map(describeResumeFrame).join(' | ')
          const tail = peeked.slice(-8).map(describeResumeFrame).join(' | ')
          try {
            // eslint-disable-next-line no-console
            console.log(
              `[E2E] resume-${label} request-nonzero transitions=${wc.loadingTransitions} trueSightings=${wc.trueSightings} idsCommits=${wc.idsCommits} startLoading=${seed.startingLoading} startGen=${seed.startingGen} details=[${wc.details.join('; ')}] frames=${peeked.length} head=[${head}] tail=[${tail}] expected=${expected.id}@${expected.offset}`
            )
          } catch {}
          test.info().annotations.push({
            type: `resume-${label}-request-frames`,
            description: `request-nonzero startLoading=${seed.startingLoading} transitions=${wc.loadingTransitions} frames=${peeked.length} head=[${head}] tail=[${tail}]`
          })
        }
        expect(
          wc.loadingTransitions,
          `${label}: unchanged same-route resume must start no route-thunk request (loading false->true = 0)`
        ).toBe(0)
      } finally {
        // Completion path always restores both seams even on stabilize timeout.
        await stopResumeProbe().catch(() => ({ frames: [] }))
        const removed = await removeRouteLoadProbe(page, RESUME_PROBE_KEY)
        expect(removed.cleaned, `${label}: route load probe must unsubscribe exactly`).toBe(true)
      }
      await expectRowIdentityKept(identitySample)
    }

    // --- MIDDLE leg (the historically regressing position) ---
    const middle = await wheelToMiddle()
    const middleSnap = await readSnap()
    expect(middleSnap.id, 'middle snapshot must confirm the wheel-established anchor').toBe(middle.id)
    await roundtripWithProbe('middle', middle, false, middleSnap, [middle.id])

    // --- PRE-PAINT minimal-alignment leg (deterministic 9px retained mismatch) ---
    // Same middle viewport, but while Home is hidden the persisted target
    // offset is nudged by +9px via the established window.keyv scroll-key seam
    // (test-controlled geometry, no test-only app API): inside the 12px E2E
    // measurement budget but outside the 1px production alignment epsilon, so
    // the pre-paint retained activation must perform its single synchronous
    // correction before first paint. A direct hidden scrollTop write is
    // ineffective while display:none (clamped, delta 0 — observed), so the
    // mismatch is expressed through the target snapshot the pre-paint lane
    // measures against; retained DOM stays at the original offset. Target
    // identity still covers (anchor stays in the retained window/loaded
    // projection/DOM); the sampler starts BEFORE the return while Chat is
    // hidden, and the existing no-blank + tight 1px first-frame contract below
    // proves the return needed no visible correction.
    {
      const mismatchBase = await settledOrThrow()
      const mismatchSnap = await readSnap()
      expect(mismatchSnap.id, 'mismatch snapshot must confirm the settled anchor').toBe(mismatchBase.id)
      await captureRowIdentity()
      await sidebarPage.goToSettings()
      await waitForSettingsLoad(page)
      await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
      const perturbed = await page.evaluate(
        ({ tid, wantId }: { tid: string; wantId: string }) => {
          try {
            const w = window as unknown as {
              keyv?: { get?: (k: string) => unknown; set?: (k: string, v: unknown) => unknown }
            }
            const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
            const seen: { key: string; id: string; before: number }[] = []
            for (const key of keys) {
              const raw = w.keyv?.get?.(key) as Record<string, unknown> | null | undefined
              if (!raw || typeof raw !== 'object') continue
              const mid =
                typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                  ? (raw.messageId as string)
                  : typeof raw.anchorId === 'string'
                    ? (raw.anchorId as string)
                    : ''
              const off = raw.intraRowOffset
              if (typeof off !== 'number' || !Number.isFinite(off)) continue
              if (mid) seen.push({ key, id: mid, before: off })
              if (mid && mid === wantId) {
                const before: number = off
                const after = before + 9
                try {
                  raw.intraRowOffset = after
                  const r = w.keyv?.set?.(key, raw)
                  if (r && typeof (r as Promise<unknown>).then === 'function') {
                    // keyv.set may be async; value is already mutated in place.
                  }
                } catch {
                  return { applied: false, before, after: before, id: mid, key, seen }
                }
                return { applied: true, before, after, id: mid, key, seen }
              }
            }
            // No snapshot matches the live baseline identity: do not mutate an
            // unrelated legacy key. Report the observed keys for diagnosis.
            return { applied: false, before: NaN, after: NaN, id: '', key: '', seen }
          } catch {
            return { applied: false, before: NaN, after: NaN, id: '', key: '', seen: [] }
          }
        },
        { tid: topicId, wantId: mismatchBase.id }
      )
      test.info().annotations.push({
        type: 'resume-mismatch-perturb',
        description: `nudge snapshot intraRowOffset base=${mismatchBase.id}@${mismatchBase.offset} before=${(perturbed as { before?: unknown }).before} after=${(perturbed as { after?: unknown }).after} applied=${(perturbed as { applied?: unknown }).applied} key=${(perturbed as { key?: unknown }).key} snapId=${(perturbed as { id?: unknown }).id}`
      })
      expect(perturbed.applied, 'mismatch: test-controlled snapshot nudge must apply while hidden').toBe(true)
      expect(
        (perturbed as { id?: unknown }).id,
        'mismatch: nudged snapshot must pertain to the live baseline stable message ID'
      ).toBe(mismatchBase.id)
      expect(
        Math.abs(((perturbed as { before?: number }).before as number) - mismatchBase.offset),
        'mismatch: stored snapshot baseline must tie to the live geometry (perturbed.before ~= mismatchBase.offset)'
      ).toBeLessThanOrEqual(1)
      expect(
        Math.abs((perturbed.after as number) - (perturbed.before as number) - 9),
        'mismatch: retained perturbation must be a deterministic ~9px coverable shift'
      ).toBeLessThanOrEqual(1.5)
      // The perturbed snapshot is the new legal target: retained DOM sits 9px
      // off it until the pre-paint correction lands it production-exact.
      const mismatchExpected: Anchor = { id: mismatchBase.id, offset: perturbed.after as number }
      expect(
        Math.abs(mismatchExpected.offset - mismatchBase.offset - 9),
        'mismatch: nudged target must sit ~9px off the live baseline before navigating'
      ).toBeLessThanOrEqual(1.5)
      expect(
        Math.abs(mismatchExpected.offset - mismatchBase.offset),
        'mismatch: nudged target must differ from the baseline by more than the 1px production epsilon'
      ).toBeGreaterThan(1)
      await startResumeProbe()
      const mismatchSeed = await installRouteLoadProbe(page, RESUME_PROBE_KEY, topicId)
      expect(mismatchSeed.startingLoading, 'mismatch: seed loading must be false before return').toBe(false)
      try {
        await sidebarPage.goToHome()
        await waitForChatReady(page)
        await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
        await assertResumeContract('mismatch', mismatchExpected, false, mismatchSnap, 1)
        const mismatchWc = await readRouteLoadProbe(page, RESUME_PROBE_KEY)
        test.info().annotations.push({
          type: 'resume-mismatch-request',
          description: `route-thunk request loadingTransitions=${mismatchWc.loadingTransitions} trueSightings=${mismatchWc.trueSightings} idsCommits(diag)=${mismatchWc.idsCommits} startLoading=${mismatchSeed.startingLoading} details=[${mismatchWc.details.join('; ')}] (0 transitions = in-place, pre-paint corrected)`
        })
        expect(
          mismatchWc.loadingTransitions,
          'mismatch: perturbed same-route resume must start no route-thunk request'
        ).toBe(0)
      } finally {
        await stopResumeProbe().catch(() => ({ frames: [] }))
        const mismatchRemoved = await removeRouteLoadProbe(page, RESUME_PROBE_KEY)
        expect(mismatchRemoved.cleaned, 'mismatch: route load probe must unsubscribe exactly').toBe(true)
      }
      await expectRowIdentityKept([mismatchExpected.id])
    }

    // --- TOP leg (verifies TRUE top, never an incidental position) ---
    const top = await wheelToTop()
    const topSnap = await readSnap()
    expect(topSnap.id, 'top snapshot must confirm the wheel-established anchor').toBe(top.id)
    await roundtripWithProbe('top', top, false, topSnap, [top.id, firstId])

    // --- TRUE-BOTTOM leg (column-reverse scrollTop 0) ---
    await wheelToBottom()
    const bottomSnap = await readSnap()
    await waitViewportVisible(page)
    // Bottom may persist as isAtBottom or as the last-row anchor; either is a
    // valid stable contract as long as every visible frame keeps bottom semantics.
    const bottomAnchor: Anchor = { id: lastId, offset: 0 }
    const liveBottom = await settledOrThrow()
    const bottomIsAnchor = bottomSnap.id === liveBottom.id && bottomSnap.id.length > 0
    const expectedBottomAnchor: Anchor = bottomIsAnchor
      ? { id: bottomSnap.id, offset: liveBottom.offset }
      : bottomAnchor
    await roundtripWithProbe('bottom', expectedBottomAnchor, true, bottomSnap, [lastId])

    // --- Repeated + rapid Settings↔Chat with an unsettled predecessor ---
    // The intermediate return is deliberately NOT settled/saved; the final
    // return must still restore the newest stable snapshot. Expectations are
    // frozen BEFORE the first detour — never derived from the actual result.
    const rapidSnapBefore = await readSnap()
    const rapidAnchor = await settledOrThrow()
    const rapidExpectedBottom = rapidSnapBefore.isAtBottom === true || (await isTrueBottom())
    const rapidExpected: Anchor = { id: rapidAnchor.id, offset: rapidAnchor.offset }
    await captureRowIdentity()
    await sidebarPage.goToSettings()
    await waitForSettingsLoad(page)
    await sidebarPage.goToHome()
    await waitForChatReady(page)
    await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
    // No settledOrThrow / snapshot wait here by construction (unstable predecessor).
    await sidebarPage.goToSettings()
    await waitForSettingsLoad(page)
    await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
    await startResumeProbe()
    const rapidSeed = await installRouteLoadProbe(page, RESUME_PROBE_KEY, topicId)
    expect(rapidSeed.startingLoading, 'rapid: seed loading must be false before return').toBe(false)
    try {
      await sidebarPage.goToHome()
      await waitForChatReady(page)
      await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
      await assertResumeContract('rapid', rapidExpected, rapidExpectedBottom, rapidSnapBefore)
      const rapidWc = await readRouteLoadProbe(page, RESUME_PROBE_KEY)
      test.info().annotations.push({
        type: 'resume-rapid-request',
        description: `route-thunk request loadingTransitions=${rapidWc.loadingTransitions} trueSightings=${rapidWc.trueSightings} idsCommits(diag)=${rapidWc.idsCommits} startLoading=${rapidSeed.startingLoading} details=[${rapidWc.details.join('; ')}] (0 transitions = in-place)`
      })
      if (rapidWc.loadingTransitions !== 0) {
        const peeked = await peekResumeProbe().catch(() => [] as ResumeFrame[])
        try {
          // eslint-disable-next-line no-console
          console.log(
            `[E2E] resume-rapid request-nonzero transitions=${rapidWc.loadingTransitions} trueSightings=${rapidWc.trueSightings} startLoading=${rapidSeed.startingLoading} details=[${rapidWc.details.join('; ')}] frames=${peeked.length} head=[${peeked.slice(0, 5).map(describeResumeFrame).join(' | ')}] tail=[${peeked.slice(-8).map(describeResumeFrame).join(' | ')}]`
          )
        } catch {}
      }
      expect(rapidWc.loadingTransitions, 'rapid: unchanged same-route resume must start no route-thunk request').toBe(0)
    } finally {
      await stopResumeProbe().catch(() => ({ frames: [] }))
      const rapidRemoved = await removeRouteLoadProbe(page, RESUME_PROBE_KEY)
      expect(rapidRemoved.cleaned, 'rapid: route load probe must unsubscribe exactly').toBe(true)
    }
    test.info().annotations.push({
      type: 'interrupted-restore',
      description:
        'held-load interruption and old late-completion preservation are covered by CG2b in route-settings-session.spec.ts; this rapid leg covers only unsettled-predecessor Settings roundtrips without a held load.'
    })
  })

  test('missing/invalid retained anchor falls back to a valid viewport with no stale overlay', async ({
    mainWindow
  }) => {
    test.setTimeout(180000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'PAGE VIEWPORT FALLBACK: Main deleteMessage plus validated renderer removeMessages/removeManyBlocks removes the settled live anchor from authority and loaded/DOM while the retained snapshot stays stale on the victim; the disposable loaded projection is then cleared while Chat is hidden (seed rows remain SQLite) so no valid in-place window survives; the return must take the fresh-window fallback branch (>0 canonical route-thunk request loading false->true) and land on the explicit-bottom default with a legal surviving anchor/snapshot (every visible frame |scrollTop| within BOTTOM_TOL, no inherited scroll) with the victim absent and no stale overlay.'
    })
    const page: Page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const sidebarPage = new SidebarPage(page)
    const assistantId = await prepareAssistant(page, 30)
    const topicId = `page-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `PageFallback ${topicId}`,
      total: 30,
      messageIdForIndex: (i: number) => uuidLike(5000 + i),
      contentPrefix: 'page-fallback-'
    })
    await activateTopic(page, topicId, 30)
    await waitViewportVisible(page)
    // Establish an ordinary wheel-saved middle position first (never a direct
    // scrollTop write), so the fallback starts from a genuine saved snapshot.
    // Corrected prep: ordinary input -> settle -> snapshot==victim BEFORE any
    // delete. A live read alone never proves a saved snapshot.
    const fbReadAnchor = (): Promise<{ id: string; offset: number } | null> =>
      page.evaluate(() => {
        const container = document.querySelector('#messages') as HTMLElement | null
        if (!container) return null
        const c = container.getBoundingClientRect()
        const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
        const cands: { id: string; top: number; bottom: number }[] = []
        for (const row of rows) {
          const r = row.getBoundingClientRect()
          const id = row.getAttribute('data-message-id')
          if (id) cands.push({ id, top: r.top, bottom: r.bottom })
        }
        if (cands.length === 0) return null
        const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
        const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
        return { id: picked.id, offset: picked.top - c.top }
      })
    const fbSettledOrThrow = async (): Promise<{ id: string; offset: number }> => {
      let prev: { id: string; offset: number } | null = null
      let stable = 0
      const start = Date.now()
      let cur: { id: string; offset: number } | null = null
      while (Date.now() - start < 10000) {
        cur = await fbReadAnchor()
        if (cur && prev && cur.id === prev.id && Math.abs(cur.offset - prev.offset) <= 2) {
          stable += 1
          if (stable >= 2) return cur
        } else stable = 0
        prev = cur
        await page.waitForTimeout(140)
      }
      throw new Error(
        `fallback viewport failed to settle within 10s (last=${cur ? `${cur.id}@${cur.offset}` : 'null'})`
      )
    }
    const fbReadSnap = async (): Promise<string> =>
      page.evaluate((tid: string) => {
        const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
        for (const key of keys) {
          try {
            const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
            if (!raw || typeof raw !== 'object') continue
            const mid =
              typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                ? (raw.messageId as string)
                : typeof raw.anchorId === 'string'
                  ? (raw.anchorId as string)
                  : ''
            if (mid) return mid
          } catch {
            continue
          }
        }
        return ''
      }, topicId)
    const fbReportSnapTimeout = async (allowed: string[]): Promise<void> => {
      const ctx = await page
        .evaluate(
          ({ tid, ok }: { tid: string; ok: string[] }) => {
            const out: Record<string, unknown> = {}
            try {
              const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
              const snaps: Record<string, string> = {}
              let sid = ''
              for (const key of keys) {
                try {
                  const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
                  snaps[key] =
                    raw && typeof raw === 'object' ? JSON.stringify(raw).slice(0, 400) : String(raw ?? '(missing)')
                  if (raw && typeof raw === 'object' && !sid) {
                    const mid =
                      typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                        ? (raw.messageId as string)
                        : typeof raw.anchorId === 'string'
                          ? (raw.anchorId as string)
                          : ''
                    if (mid && (ok as string[]).includes(mid)) sid = mid
                  }
                } catch (e) {
                  snaps[key] = `err:${e instanceof Error ? e.message : String(e)}`.slice(0, 120)
                }
              }
              out.snaps = snaps
              out.snapId = sid || '(none-in-allowed)'
              const container = document.querySelector('#messages') as HTMLElement | null
              const c = container?.getBoundingClientRect() ?? null
              const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
              let testAnchor = '(none)'
              if (c && rows.length > 0) {
                const cands = rows
                  .map((row) => {
                    const r = row.getBoundingClientRect()
                    return { id: row.getAttribute('data-message-id') as string, top: r.top, bottom: r.bottom }
                  })
                  .filter((x) => x.id)
                const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
                const picked =
                  crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
                testAnchor = `${picked.id}@${Math.round((picked.top - c.top) * 10) / 10}`
              }
              out.testAnchor = testAnchor
              let prodAnchor = '(none)'
              try {
                if (container && c) {
                  const els = Array.from(
                    container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')
                  ) as HTMLElement[]
                  const pc: { id: string; top: number; bottom: number }[] = []
                  for (const el of els) {
                    const cs = getComputedStyle(el)
                    if (cs.display === 'none') continue
                    const r = el.getBoundingClientRect()
                    if (r.height === 0) continue
                    if (!(Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0)) continue
                    const id = el.id.replace(/^message-/, '')
                    if (id) pc.push({ id, top: r.top, bottom: r.bottom })
                  }
                  if (pc.length > 0) {
                    let cross: { id: string; top: number; bottom: number } | null = null
                    for (const cd of pc) {
                      if (cd.top <= c.top && cd.bottom > c.top && (!cross || cd.top < cross.top)) cross = cd
                    }
                    const picked = cross ?? pc.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? pc[0]
                    prodAnchor = `${picked.id}@${Math.round((picked.top - c.top) * 10) / 10}`
                  }
                }
              } catch {
                prodAnchor = '(err)'
              }
              out.prodAnchor = prodAnchor
              out.phase = container?.getAttribute('data-viewport-phase') ?? '(no-container)'
              const st = (window as any).store?.getState?.() as Record<string, any> | undefined
              out.currentTopic = st?.messages?.currentTopicId ?? '(unknown)'
              const loaded: string[] = Array.isArray(st?.messages?.messageIdsByTopic?.[tid])
                ? (st.messages.messageIdsByTopic[tid] as string[])
                : []
              out.loadedLen = loaded.length
              out.loadedHead = loaded.slice(0, 3)
              out.loadedTail = loaded.slice(-3)
              const domIds = rows.map((r) => r.getAttribute('data-message-id') as string)
              out.domLen = domIds.length
              out.domHead = domIds.slice(0, 3)
              out.domTail = domIds.slice(-3)
              out.allowedLen = (ok as string[]).length
            } catch (e) {
              out.error = e instanceof Error ? e.message : String(e)
            }
            return out
          },
          { tid: topicId, ok: allowed }
        )
        .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))
      const summary =
        `fbPrep snapTimeout snapId=${String((ctx as Record<string, unknown>).snapId)} allowedLen=${String((ctx as Record<string, unknown>).allowedLen)} ` +
        `testAnchor=${String((ctx as Record<string, unknown>).testAnchor)} prodAnchor=${String((ctx as Record<string, unknown>).prodAnchor)} ` +
        `phase=${String((ctx as Record<string, unknown>).phase)} current=${String((ctx as Record<string, unknown>).currentTopic)} ` +
        `loadedLen=${String((ctx as Record<string, unknown>).loadedLen)} domLen=${String((ctx as Record<string, unknown>).domLen)} ` +
        `snaps=${JSON.stringify((ctx as Record<string, unknown>).snaps).slice(0, 600)}`
      try {
        // eslint-disable-next-line no-console
        console.log(`[E2E] ${summary}`)
      } catch {}
      test.info().annotations.push({ type: 'fallback-prep-snap-timeout', description: summary.slice(0, 1900) })
    }
    const fbWaitSnapMatchesLive = async (allowed: string[]): Promise<void> => {
      try {
        await page.waitForFunction(
          ({ tid, ok }: any) => {
            const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
            let sid = ''
            for (const key of keys) {
              try {
                const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
                if (!raw || typeof raw !== 'object') continue
                const mid =
                  typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                    ? (raw.messageId as string)
                    : typeof raw.anchorId === 'string'
                      ? (raw.anchorId as string)
                      : ''
                if (mid && ok.includes(mid)) {
                  sid = mid
                  break
                }
              } catch {
                continue
              }
            }
            if (!sid) return false
            const container = document.querySelector('#messages') as HTMLElement | null
            if (!container) return false
            const c = container.getBoundingClientRect()
            const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
            const cands: { id: string; top: number; bottom: number }[] = []
            for (const row of rows) {
              const r = row.getBoundingClientRect()
              const id = row.getAttribute('data-message-id')
              if (id) cands.push({ id, top: r.top, bottom: r.bottom })
            }
            if (cands.length === 0) return false
            const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
            const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
            return picked.id === sid
          },
          { tid: topicId, ok: allowed },
          { timeout: 30000 }
        )
      } catch (err) {
        await fbReportSnapTimeout(allowed)
        throw err
      }
    }
    // Bounded fallback prep: ordinary wheel-established TRUE middle (never a
    // fixed same-direction sweep from the bottom-clamped start). Causal root
    // of the prior fbWaitSnapMatchesLive timeout: 6x wheel(420) from the
    // fresh-activation bottom (column-reverse scrollTop~0) produced no actual
    // scroll event toward the already-bottom edge, so controller.userTakeover
    // (Messages.tsx: requires declareUserIntent via wheel capture + stable/
    // clean phase) never committed a snapshot and both keyv keys stayed
    // missing while live anchor sat at idx16/20 @-18.3. This prep wheels BOTH
    // directions with verified scrollTop delta + live-id move + settle +
    // snapshot-own-match BEFORE any delete; no manual snapshot save/set/force.
    const fbReadScroll = (): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> =>
      page.evaluate(() => {
        const c = document.querySelector('#messages') as HTMLElement | null
        return {
          scrollTop: c ? c.scrollTop : NaN,
          scrollHeight: c ? c.scrollHeight : NaN,
          clientHeight: c ? c.clientHeight : NaN
        }
      })
    const fbIsBottom = async (): Promise<boolean> => {
      const st = await fbReadScroll()
      if (Math.abs(st.scrollTop) > 100) return false
      return true
    }
    const fbIsTop = async (): Promise<boolean> => {
      const st = await fbReadScroll()
      const extreme = -(st.scrollHeight - st.clientHeight)
      if (Math.abs(st.scrollTop - extreme) > 120) return false
      return true
    }
    const fbIsMiddle = async (anchorId: string): Promise<boolean> => {
      const idx = ids.indexOf(anchorId)
      if (idx < Math.floor(ids.length / 3) || idx > Math.floor((ids.length * 2) / 3)) return false
      const st = await fbReadScroll()
      const extreme = -(st.scrollHeight - st.clientHeight)
      if (Math.abs(st.scrollTop) < 200) return false
      if (Math.abs(st.scrollTop - extreme) < 200) return false
      if (await fbIsTop()) return false
      if (await fbIsBottom()) return false
      return true
    }
    const fbFocus = async (): Promise<void> => {
      const box = await page.locator('#messages').first().boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    }
    const fbWheel = async (dy: number): Promise<{ beforeSt: number; afterSt: number }> => {
      const before = (await fbReadScroll()).scrollTop
      await fbFocus()
      await page.mouse.wheel(0, dy)
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      await page.waitForTimeout(220)
      const after = (await fbReadScroll()).scrollTop
      return { beforeSt: before, afterSt: after }
    }
    const fbWheelToMiddle = async (): Promise<{ id: string; offset: number }> => {
      const startSt = (await fbReadScroll()).scrollTop
      const startAnchor = await fbReadAnchor()
      // Seeded-index middle-third + not-at-bottom/top + settled + snapshot
      // match. Both wheel signs are tried so no column-reverse sign
      // assumption is baked in; exact bounded trial limits (30+30), no
      // random retries, no time-SLA asserts.
      for (let round = 0; round < 30; round++) {
        const cur = await fbReadAnchor()
        if (cur && (await fbIsMiddle(cur.id))) {
          const s = await fbSettledOrThrow()
          if (await fbIsMiddle(s.id)) {
            await waitViewportVisible(page)
            await fbWaitSnapMatchesLive(ids)
            const confirmed = await fbSettledOrThrow()
            if (await fbIsMiddle(confirmed.id)) {
              // Meaningful-delta proof: scrollTop moved and live id moved
              // from the bottom-clamped start; never label idx16/20 bottom
              // as middle (ids.length is 30 so middle-third is 10..20).
              const movedSt = Math.abs((await fbReadScroll()).scrollTop - startSt) > 50
              const movedId = startAnchor ? confirmed.id !== startAnchor.id : true
              expect(movedSt || movedId, 'fallback prep must show real scroll movement to middle').toBe(true)
              return confirmed
            }
          }
        }
        await fbWheel(round % 2 === 0 ? 560 : -560)
      }
      for (let round = 0; round < 30; round++) {
        const cur = await fbReadAnchor()
        if (cur && (await fbIsMiddle(cur.id))) {
          const s = await fbSettledOrThrow()
          if (!(await fbIsMiddle(s.id))) {
            await fbWheel(round % 2 === 0 ? -420 : 420)
            continue
          }
          await waitViewportVisible(page)
          await fbWaitSnapMatchesLive(ids)
          const reconf = await fbSettledOrThrow()
          if (await fbIsMiddle(reconf.id)) return reconf
          return s
        }
        await fbWheel(round % 2 === 0 ? -420 : 420)
      }
      const last = await fbReadAnchor()
      const geom = await fbReadScroll()
      // Fixture-too-short is a blocker, never a weakened pass: if the
      // scroller is clamped (scrollHeight<=clientHeight+margin) no actual
      // scroll is possible and the prep must fail loudly.
      if (Number.isFinite(geom.scrollHeight) && Number.isFinite(geom.clientHeight)) {
        expect(
          geom.scrollHeight - geom.clientHeight,
          `fallback fixture too short for real middle scroll (sh=${geom.scrollHeight} ch=${geom.clientHeight}); increase message height/count, do not weaken`
        ).toBeGreaterThan(200)
      }
      throw new Error(`fallback prep could not reach verified middle (last=${last?.id ?? 'null'})`)
    }
    await waitViewportVisible(page)
    const settledVictim = await fbWheelToMiddle()
    await waitViewportVisible(page)
    const confirmedVictim = await fbSettledOrThrow()
    const victim: { id: string; offset: number } = confirmedVictim
    expect(victim, 'fallback prep must leave a measurable settled anchor').not.toBeNull()
    const victimIdx = ids.indexOf(victim!.id)
    expect(victimIdx, 'fallback victim must be a real seeded message').toBeGreaterThanOrEqual(0)
    expect(victimIdx, 'fallback victim must be a true middle message, not an edge').toBeGreaterThan(2)
    expect(victimIdx, 'fallback victim must be a true middle message, not an edge').toBeLessThan(ids.length - 3)
    expect(settledVictim.id, 'fallback prep anchor must be stable across snapshot confirmation').toBe(victim.id)
    const prepSnap = await fbReadSnap()
    expect(prepSnap, 'settled snapshot must equal the wheel-established victim BEFORE delete').toBe(victim!.id)
    // Presentation-valid invalidation (test-only, disposable profile): Main
    // authority delete PLUS renderer loaded/rendered removal via validated
    // existing reducers. A Main-only delete leaves the Redux/DOM retained
    // window resident (no message-level Main event), so the guard predicate
    // (retained+loaded+DOM) would still admit the stale message and in-place
    // resume it despite the authority delete — demanding a new freshness
    // authority outside Main scope (presentation validity, not always reload).
    // The store.dispatch seam below uses only exact seeded disposable entities
    // and existing newMessages/messageBlocks reducers (cf. s62/s63), never an
    // invented state shape, and never mutates the snapshot directly.
    const deleted: boolean = await page.evaluate(
      async ({ tid, mid }: { tid: string; mid: string }) => {
        try {
          const api = (window as any).api?.chatDb
          if (!api || typeof api.deleteMessage !== 'function') return false
          const res = await api.deleteMessage({ topicId: tid, messageId: mid })
          return !!(res && (res as { ok?: boolean }).ok === true)
        } catch {
          return false
        }
      },
      { tid: topicId, mid: victim!.id }
    )
    expect(deleted, 'deleteMessage Main capability must delete the victim anchor (invalid-anchor proof setup)').toBe(
      true
    )
    const victimBlockFallback = `${topicId}-block-${String(victimIdx).padStart(5, '0')}`
    const presentationRemoved: {
      loadedIncludes: boolean
      entityExists: boolean
      blockExists: boolean | null
      bid: string
    } = await page.evaluate(
      ({ tid, mid, fallbackBid }: { tid: string; mid: string; fallbackBid: string }) => {
        const store = (window as any).store
        const msg = store.getState().messages?.entities?.[mid] as { blocks?: string[] } | undefined
        const bid = msg && Array.isArray(msg.blocks) && msg.blocks.length > 0 ? (msg.blocks[0] as string) : fallbackBid
        store.dispatch({ type: 'newMessages/removeMessages', payload: { topicId: tid, messageIds: [mid] } })
        if (bid) store.dispatch({ type: 'messageBlocks/removeManyBlocks', payload: [bid] })
        const s = store.getState() as any
        return {
          loadedIncludes: ((s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).includes(mid),
          entityExists: !!s.messages?.entities?.[mid],
          blockExists: bid ? !!s.messageBlocks?.entities?.[bid] : null,
          bid
        }
      },
      { tid: topicId, mid: victim!.id, fallbackBid: victimBlockFallback }
    )
    expect(presentationRemoved.loadedIncludes, 'victim must be absent from loaded projection after seam').toBe(false)
    expect(presentationRemoved.entityExists, 'victim entity must be absent after seam').toBe(false)
    const remaining = ids.filter((id) => id !== victim!.id)
    // Guard-input proof BEFORE the return: victim absent in loaded/DOM with a
    // non-empty full window read. Snapshot is observed truthfully here — if the
    // public removal legitimately transferred it, the new legal value is kept;
    // it is never forced back nor mutated while a controller cache overrides.
    const guardProof: { loadedLen: number; domLen: number; domHasVictim: boolean; loadedHasVictim: boolean } =
      await page.evaluate(
        ({ tid, mid }: { tid: string; mid: string }) => {
          const s = (window as any).store.getState() as any
          const loadedIds = ((s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).filter(
            (id) => typeof id === 'string'
          )
          const domIds = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
            (r) => r.getAttribute('data-message-id') as string
          )
          return {
            loadedLen: loadedIds.length,
            domLen: domIds.length,
            domHasVictim: domIds.includes(mid),
            loadedHasVictim: loadedIds.includes(mid)
          }
        },
        { tid: topicId, mid: victim!.id }
      )
    expect(guardProof.loadedHasVictim, 'victim absent from loaded before return').toBe(false)
    expect(guardProof.domHasVictim, 'victim absent from DOM before return').toBe(false)
    expect(guardProof.loadedLen, 'full window read must stay non-empty after seam').toBeGreaterThan(0)
    expect(guardProof.domLen, 'DOM must still render surviving rows after seam').toBeGreaterThan(0)
    // Read-back BEFORE the return WITHOUT forcing: record whether the retained
    // snapshot stayed stale (victim) or legitimately moved to a survivor.
    const staleSnap: string = await fbReadSnap()
    const staleIsVictim = staleSnap === victim!.id
    test.info().annotations.push({
      type: 'fallback-setup',
      description: `victim=${victim!.id} idx=${victimIdx} prepSnap=${prepSnap} staleSnap=${staleSnap || '(empty)'} staleIsVictim=${staleIsVictim ? 1 : 0} remaining=${remaining.length} loadedLen=${guardProof.loadedLen} domLen=${guardProof.domLen} bid=${presentationRemoved.bid}`
    })
    // Stale-retained proof: the snapshot still references the now-missing
    // victim while loaded/DOM provably exclude it. removeMessages never touches
    // keyv, so a transfer here would be legitimate product semantics — report
    // it loudly instead of forcing the snapshot back or masking with a pass.
    expect(
      staleIsVictim,
      `retained snapshot must still reference the deleted victim (got '${staleSnap || '(empty)'}'); if the public removal legitimately transferred it, report transfer semantics — do not force or mask`
    ).toBe(true)
    const FB_PROBE = '__page_fallback_probe'
    const FB_LOAD_KEY = '__page_fallback_load_probe'
    await sidebarPage.goToSettings()
    await waitForSettingsLoad(page)
    await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
    // Deliberate presentation-window invalidation while Chat is hidden: clear
    // ONLY the disposable loaded projection for this topic via the established
    // newMessages/removeMessages reducer (all surviving ids) plus display
    // block ids via messageBlocks/removeManyBlocks. Seed rows remain in
    // SQLite (Main authority untouched except the victim); no snapshot save/
    // set, no controller mutation. After this, no valid in-place window
    // survives, so the return predicate (empty retained/projection) requires
    // a full route read. If the legitimate reconcile already moved the
    // snapshot, the lawful value is kept (never forced back).
    const cleared: { loadedLen: number; removed: number; bids: number } = await page.evaluate(
      ({ tid, mids }: { tid: string; mids: string[] }) => {
        const store = (window as any).store
        const s0 = store.getState() as any
        const before: string[] = ((s0.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).filter(
          (id) => typeof id === 'string'
        )
        const targets = before.length > 0 ? before : mids
        const bids: string[] = []
        for (const mid of targets) {
          const msg = store.getState().messages?.entities?.[mid] as { blocks?: string[] } | undefined
          if (msg && Array.isArray(msg.blocks)) for (const b of msg.blocks as string[]) if (b) bids.push(b)
        }
        if (targets.length > 0) {
          store.dispatch({ type: 'newMessages/removeMessages', payload: { topicId: tid, messageIds: targets } })
        }
        if (bids.length > 0) store.dispatch({ type: 'messageBlocks/removeManyBlocks', payload: [...new Set(bids)] })
        const s1 = store.getState() as any
        return {
          loadedLen: (((s1.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).length as number) ?? -1,
          removed: targets.length,
          bids: [...new Set(bids)].length
        }
      },
      { tid: topicId, mids: remaining }
    )
    expect(cleared.loadedLen, 'projection clear must empty the disposable loaded window').toBe(0)
    // Hidden-DOM prerequisite REMOVED (corrected premise): while Chat is hidden
    // Activity effects are disconnected, so retained #messages DOM is lawful
    // resource state and does NOT have to reconcile to empty — the prior
    // loaded0+DOM-absent joint wait therefore timed out after 10s despite a
    // valid emptied store (loadedLen 0 passed). Pure
    // shouldRestoreRetainedWindowInPlace requires loadedContainsAnchor, so the
    // bounded store proof above already suffices to refuse in-place reuse
    // independent of stale retained DOM. Sampler + subscribe probe arming below
    // starts while hidden; first-visible gating happens on reveal.
    // Seed rows remain SQLite: Main authority still holds every survivor
    // (victim absent). Read-only standard capability, no renderer state input.
    const authority: { ok: boolean; idsLen: number; hasVictim: boolean; missing: string[] } = await page.evaluate(
      async ({ tid, mid, want }: { tid: string; mid: string; want: string[] }) => {
        try {
          const res = (await (window as any).api.chatDb.fetchMessagesWindow({
            kind: 'latest',
            topicId: tid,
            limit: 100
          })) as {
            ok?: boolean
            value?: { messages?: { id: string }[] }
          }
          const list = Array.isArray(res?.value?.messages) ? (res.value!.messages as { id: string }[]) : []
          const set = new Set(list.map((m) => m.id))
          return {
            ok: res?.ok === true,
            idsLen: list.length,
            hasVictim: set.has(mid),
            missing: (want as string[]).filter((id) => !set.has(id))
          }
        } catch {
          return { ok: false, idsLen: -1, hasVictim: true, missing: want }
        }
      },
      { tid: topicId, mid: victim!.id, want: remaining }
    )
    test.info().annotations.push({
      type: 'fallback-projection-clear',
      description: `clearedLoaded=${cleared.loadedLen} removed=${cleared.removed} bids=${cleared.bids} authorityOk=${authority.ok ? 1 : 0} authorityIds=${authority.idsLen} authorityHasVictim=${authority.hasVictim ? 1 : 0} authorityMissing=${authority.missing.length}`
    })
    expect(authority.ok, 'Main authority must stay readable after projection clear').toBe(true)
    expect(authority.hasVictim, 'Main authority must not contain the deleted victim').toBe(false)
    expect(
      authority.missing.length,
      `Main authority must retain all survivors (missing=${authority.missing.slice(0, 3).join(',')})`
    ).toBe(0)
    // Snapshot after the clear is observed truthfully: stale-victim retained
    // (invalid) or a lawful survivor/default after legitimate reconcile. A
    // cleared/empty snapshot still forces a deterministic default latest read;
    // either way the return must issue a full route request. Never forced back.
    const postClearSnap: string = await fbReadSnap()
    const postClearLawful = postClearSnap === '' || postClearSnap === victim!.id || remaining.includes(postClearSnap)
    test.info().annotations.push({
      type: 'fallback-postclear-snap',
      description: `postClearSnap=${postClearSnap || '(empty)'} lawful=${postClearLawful ? 1 : 0} staleVictim=${postClearSnap === victim!.id ? 1 : 0}`
    })
    expect(
      postClearLawful,
      `post-clear snapshot must be stale-victim, empty, or a survivor (got '${postClearSnap || '(empty)'}')`
    ).toBe(true)
    // Sampler + subscribe load probe start BEFORE the return while Chat is
    // hidden (same corrected lifetime as test 1: stabilize WHILE sampling,
    // stop only afterwards). Probe installed AFTER the seam setup, so setup
    // dispatches are excluded; it counts ONLY canonical loadingByTopic
    // false->true edges for this topic (synchronous subscribe, thunk-inner
    // safe). Probe records the full anchor/phase/visibility shape so every
    // visible frame can be proven legal (never the victim).
    interface FbFrame {
      t: number
      anchorId: string
      anchorOffset: number
      scrollTop: number
      phase: string
      homeVisible: boolean
      messagesVisible: boolean
      containerVis: string
    }
    const fbDescribe = (f: FbFrame): string =>
      `t=${f.t} anchor=${f.anchorId}@${f.anchorOffset} st=${f.scrollTop} phase=${f.phase} home=${f.homeVisible ? 1 : 0} msgs=${f.messagesVisible ? 1 : 0} vis=${f.containerVis}`
    const fbPeek = async (): Promise<FbFrame[]> =>
      page.evaluate((k: string) => {
        const p = (window as any)[k] as { frames: FbFrame[] } | undefined
        return p ? [...p.frames] : []
      }, FB_PROBE)
    const fbStop = async (): Promise<FbFrame[]> =>
      page.evaluate((k: string) => {
        const p = (window as any)[k] as { frames: FbFrame[]; stop: () => void } | undefined
        try {
          p?.stop?.()
        } catch {}
        const frames = p ? [...p.frames] : []
        delete (window as any)[k]
        return frames
      }, FB_PROBE)
    await page.evaluate((k: string) => {
      const frames: {
        t: number
        anchorId: string
        anchorOffset: number
        scrollTop: number
        phase: string
        homeVisible: boolean
        messagesVisible: boolean
        containerVis: string
      }[] = []
      let running = true
      let raf = 0
      const t0 = performance.now()
      const tick = () => {
        if (!running) return
        try {
          const container = document.querySelector('#messages') as HTMLElement | null
          const home = document.querySelector('#home-page') as HTMLElement | null
          let homeVisible = false
          if (home) {
            if (typeof (home as unknown as { checkVisibility?: () => boolean }).checkVisibility === 'function') {
              homeVisible = (home as unknown as { checkVisibility: () => boolean }).checkVisibility()
            } else {
              const r = home.getBoundingClientRect()
              const cs = getComputedStyle(home)
              homeVisible = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
            }
          }
          let messagesVisible = false
          let containerVis = ''
          let anchorId = ''
          let anchorOffset = 0
          let scrollTop = NaN
          let phase = ''
          if (container) {
            const cs = getComputedStyle(container)
            containerVis = cs.visibility
            const r = container.getBoundingClientRect()
            messagesVisible = cs.display !== 'none' && r.width > 0 && r.height > 0
            scrollTop = container.scrollTop
            phase = container.getAttribute('data-viewport-phase') ?? ''
            const c = container.getBoundingClientRect()
            const rows = Array.from(container.querySelectorAll('[data-message-id]')) as HTMLElement[]
            const cands: { id: string; top: number; bottom: number }[] = []
            for (const row of rows) {
              const br = row.getBoundingClientRect()
              const id = row.getAttribute('data-message-id')
              if (id) cands.push({ id, top: br.top, bottom: br.bottom })
            }
            if (cands.length > 0) {
              const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
              const picked =
                crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
              anchorId = picked.id
              anchorOffset = Math.round((picked.top - c.top) * 10) / 10
            }
          }
          frames.push({
            t: Math.round((performance.now() - t0) * 10) / 10,
            anchorId,
            anchorOffset,
            scrollTop: Math.round(scrollTop * 10) / 10,
            phase,
            homeVisible,
            messagesVisible,
            containerVis
          })
        } catch {
          // record nothing; frame skipped
        }
        raf = requestAnimationFrame(tick)
      }
      tick()
      ;(window as any)[k] = {
        frames,
        stop: () => {
          running = false
          try {
            cancelAnimationFrame(raf)
          } catch {}
        }
      }
    }, FB_PROBE)
    let fbSeed = await installRouteLoadProbe(page, FB_LOAD_KEY, topicId)
    expect(fbSeed.startingLoading, 'fallback: seed loading must be false before return').toBe(false)
    if (fbSeed.startingIdsJoin !== '') {
      // Legitimate hidden reconcile refilled the disposable window after the
      // seam clear: restore the test lazy-load missing-window state with the
      // SAME public newMessages/removeMessages reducer (no snapshot save/set,
      // no controller mutation), then re-seed so setup dispatches stay
      // excluded from the request count. Single bounded re-clear, never a loop.
      const refilled: number = fbSeed.startingIdsJoin.split(',').filter(Boolean).length
      await page.evaluate(
        ({ tid, mids }: { tid: string; mids: string[] }) => {
          const store = (window as any).store
          const s0 = store.getState() as any
          const before: string[] = ((s0.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).filter(
            (id) => typeof id === 'string'
          )
          const targets = before.length > 0 ? before : mids
          if (targets.length > 0) {
            store.dispatch({ type: 'newMessages/removeMessages', payload: { topicId: tid, messageIds: targets } })
          }
        },
        { tid: topicId, mids: remaining }
      )
      const reloaded: number = await page.evaluate((tid: string) => {
        const s = (window as any).store.getState() as any
        return ((s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]).filter((id) => typeof id === 'string').length
      }, topicId)
      expect(reloaded, 'reconcile refill must be re-cleared to the missing-window state before return').toBe(0)
      await removeRouteLoadProbe(page, FB_LOAD_KEY)
      fbSeed = await installRouteLoadProbe(page, FB_LOAD_KEY, topicId)
      expect(fbSeed.startingIdsJoin, 'missing-window state must hold at return after refill re-clear').toBe('')
      test.info().annotations.push({
        type: 'fallback-reclear',
        description: `hidden reconcile refilled ${refilled} ids after seam clear; re-cleared via public reducer to missing-window before return`
      })
    }
    try {
      await sidebarPage.goToHome()
      await waitForChatReady(page)
      await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
      // Corrected lifetime: reach eventual visible + stable termination WHILE
      // the sampler continues; only then stop and assert first+EVERY visible
      // frame. Stopping first would sample zero positioned frames.
      try {
        await waitViewportVisible(page)
        await fbSettledOrThrow()
      } catch (err) {
        const peeked = await fbPeek().catch(() => [] as FbFrame[])
        const tail = peeked.slice(-8).map(fbDescribe).join(' | ')
        test.info().annotations.push({
          type: 'fallback-stabilize-timeout',
          description: `stabilize timeout frames=${peeked.length} tail=[${tail}] err=${err instanceof Error ? err.message : String(err)}`
        })
        throw err
      }
      const fbFrames: FbFrame[] = await fbStop()
      const fbVisible = fbFrames.filter((f) => f.homeVisible && f.messagesVisible && f.containerVis !== 'hidden')
      // Bounded diagnostics BEFORE any visible assert so logs contain phase.
      test.info().annotations.push({
        type: 'fallback-frames',
        description: `frames=${fbFrames.length} visible=${fbVisible.length} hidden=${fbFrames.length - fbVisible.length} firstVisible=${fbVisible.length > 0 ? fbDescribe(fbVisible[0]) : 'none'}`
      })
      test.info().annotations.push({
        type: 'fallback-frames-detail',
        description: `head=[${fbFrames.slice(0, 5).map(fbDescribe).join(' | ')}] tail=[${fbFrames.slice(-8).map(fbDescribe).join(' | ')}]`
      })
      expect(fbFrames.length, 'fallback sampler must capture frames across the return').toBeGreaterThan(0)
      expect(fbVisible.length, 'fallback must paint nonzero visible frames').toBeGreaterThan(0)
      expect(fbFrames.length - fbVisible.length, 'fallback must not hide every sample').toBeLessThan(fbFrames.length)
      // Every visible frame must already be the explicit bottom default with
      // a legal survivor — never the deleted victim, never an empty anchor,
      // never an inherited scrolled position. The invalid-snapshot path takes
      // the deterministic route-local default `bottom` (messageWindow
      // chooseTopFirstPositionPlan: typed NOT_FOUND on the latest window
      // places scrollTop 0 prepaint; guarded stable replaces the stale
      // snapshot), so |scrollTop| within BOTTOM_TOL (100, same as the core
      // bottom leg) on every visible frame proves no inherited scroll
      // survived. Early wrong frames are kept (no trimming); any
      // victim/non-bottom frame fails.
      let fbFirstBad = -1
      for (let i = 0; i < fbVisible.length; i++) {
        const f = fbVisible[i]
        if (!f.anchorId || f.anchorId === victim!.id || !remaining.includes(f.anchorId)) {
          fbFirstBad = i
          break
        }
        if (!Number.isFinite(f.scrollTop) || Math.abs(f.scrollTop) > BOTTOM_TOL) {
          fbFirstBad = i
          break
        }
      }
      if (fbFirstBad !== -1) {
        test.info().annotations.push({
          type: 'fallback-first-bad',
          description: `firstBad=${fbFirstBad} fb=${fbDescribe(fbVisible[fbFirstBad])} victim=${victim!.id} expectBottom st<=${BOTTOM_TOL}`
        })
      }
      expect(
        fbFirstBad,
        'fallback first and every visible frame must be explicit bottom with a legal survivor (never the victim, |scrollTop| within BOTTOM_TOL)'
      ).toBe(-1)
      const fbWc = await readRouteLoadProbe(page, FB_LOAD_KEY)
      test.info().annotations.push({
        type: 'fallback-request',
        description: `route-thunk request loadingTransitions=${fbWc.loadingTransitions} trueSightings=${fbWc.trueSightings} idsCommits(diag)=${fbWc.idsCommits} startLoading=${fbSeed.startingLoading} startGen=${fbSeed.startingGen} details=[${fbWc.details.join('; ')}] (>0 transitions = fresh-window fallback branch)`
      })
      if (fbWc.loadingTransitions <= 0) {
        try {
          // eslint-disable-next-line no-console
          console.log(
            `[E2E] fallback request-zero transitions=${fbWc.loadingTransitions} trueSightings=${fbWc.trueSightings} idsCommits=${fbWc.idsCommits} startLoading=${fbSeed.startingLoading} startGen=${fbSeed.startingGen} details=[${fbWc.details.join('; ')}] frames=${fbFrames.length} head=[${fbFrames.slice(0, 5).map(fbDescribe).join(' | ')}] tail=[${fbFrames.slice(-8).map(fbDescribe).join(' | ')}] victim=${victim!.id}`
          )
        } catch {}
      }
      // Fallback branch proof: an emptied retained/projection window must take
      // a fresh route-thunk request — never a silent in-place reuse. Asserts
      // the canonical loading false->true request edge (not any-thunk, not
      // publication kind); publication kind (around/latest) is IPC-only and
      // reported via row identity + request presence. No >0 publish assert
      // from an unobservable action: the gate is the request edge.
      expect(
        fbWc.loadingTransitions,
        'emptied-window fallback must start a fresh route request (loading false->true>0)'
      ).toBeGreaterThan(0)
      const after: { id: string; offset: number } | null = await page.evaluate(() => {
        const container = document.querySelector('#messages') as HTMLElement | null
        if (!container) return null
        const c = container.getBoundingClientRect()
        const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
        const cands: { id: string; top: number; bottom: number }[] = []
        for (const row of rows) {
          const r = row.getBoundingClientRect()
          const id = row.getAttribute('data-message-id')
          if (id) cands.push({ id, top: r.top, bottom: r.bottom })
        }
        if (cands.length === 0) return null
        const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
        const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
        return { id: picked.id, offset: picked.top - c.top }
      })
      expect(after, 'missing-anchor fallback must still land on a measurable anchor').not.toBeNull()
      expect(after!.id, 'fallback must not restore the deleted victim anchor').not.toBe(victim!.id)
      expect(remaining, 'fallback anchor must be a legal surviving message').toContain(after!.id)
      const rendered: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
          (r) => r.getAttribute('data-message-id') as string
        )
      )
      expect(rendered.length, 'fallback must render rows').toBeGreaterThan(0)
      for (const rid of rendered) expect(remaining, `fallback no stale overlay ${rid}`).toContain(rid)
      expect(rendered, 'deleted victim must be absent after fallback reload').not.toContain(victim!.id)
      const legalSnap: string = await page.evaluate((tid: string) => {
        const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
        for (const key of keys) {
          try {
            const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
            if (!raw || typeof raw !== 'object') continue
            const mid =
              typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                ? (raw.messageId as string)
                : typeof raw.anchorId === 'string'
                  ? (raw.anchorId as string)
                  : ''
            if (mid) return mid
          } catch {
            continue
          }
        }
        return ''
      }, topicId)
      expect(legalSnap, 'fallback must leave a legal persisted snapshot').not.toBe('')
      expect(legalSnap, 'fallback snapshot must not reference the deleted victim').not.toBe(victim!.id)
      expect(remaining, 'fallback snapshot must reference a surviving message').toContain(legalSnap)
      // Explicit-bottom default proof: the invalid snapshot path takes the
      // deterministic route-local default `bottom` (messageWindow
      // chooseTopFirstPositionPlan: typed NOT_FOUND on the latest window
      // places scrollTop 0 prepaint; guarded stable replaces the stale
      // snapshot). The persisted snapshot must therefore carry bottom
      // semantics, the live state must be true bottom, and the live anchor
      // must match the persisted snapshot (no inherited scroll, no stale id).
      const legalSnapFull: { isAtBottom: boolean | null; scrollTop: number | null } = await page.evaluate(
        (tid: string) => {
          const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
          for (const key of keys) {
            try {
              const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
              if (!raw || typeof raw !== 'object') continue
              const mid =
                typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
                  ? (raw.messageId as string)
                  : typeof raw.anchorId === 'string'
                    ? (raw.anchorId as string)
                    : ''
              if (!mid) continue
              return {
                isAtBottom: typeof raw.isAtBottom === 'boolean' ? (raw.isAtBottom as boolean) : null,
                scrollTop: typeof raw.scrollTop === 'number' ? (raw.scrollTop as number) : null
              }
            } catch {
              continue
            }
          }
          return { isAtBottom: null, scrollTop: null }
        },
        topicId
      )
      expect(
        legalSnapFull.isAtBottom,
        'fallback persisted snapshot must carry bottom semantics (isAtBottom true)'
      ).toBe(true)
      const fbLiveScroll = await fbReadScroll()
      expect(
        Math.abs(fbLiveScroll.scrollTop),
        'fallback live state must be true bottom (|scrollTop| within BOTTOM_TOL)'
      ).toBeLessThanOrEqual(BOTTOM_TOL)
      expect(
        after!.id,
        'fallback live anchor must match the persisted snapshot (guarded stable replaced the stale snapshot)'
      ).toBe(legalSnap)
    } finally {
      await page
        .evaluate((k: string) => {
          try {
            const p = (window as any)[k] as { stop?: () => void } | undefined
            try {
              p?.stop?.()
            } catch {}
          } finally {
            delete (window as any)[k]
          }
        }, FB_PROBE)
        .catch(() => undefined)
      const removed = await removeRouteLoadProbe(page, FB_LOAD_KEY)
      expect(removed.cleaned, 'fallback: route load probe must unsubscribe exactly').toBe(true)
    }
  })
})

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
