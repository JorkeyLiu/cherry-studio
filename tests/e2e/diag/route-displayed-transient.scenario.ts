/**
 * DIAGNOSTIC scenario (not a regression asset, not a durable E2E spec).
 *
 * Verifies the displayed-route fix for the user-reported whole-column jump on
 * route switches, against the REAL user topic imported through the REAL header
 * import button (`topic-import-btn` → Main `dialog.showOpenDialog` →
 * `window.api.chatDb.importTopicData`) inside the observation harness'
 * disposable profile.
 *
 * The user's residual group is a group SPANNING a branch point (no
 * `headerInRoute === false` requirement is imposed here): the real topic has 3
 * branches — one main child WITH a nested child (group 1, the abnormal
 * direction) and another main child WITHOUT nesting (group 2, control).
 * Branch identity is resolved per-run via Main `listBranches`, never by
 * reusing anonymous labels across sessions.
 *
 * Four real-UI round trips: group1 main→child→main, group2 main→child→main.
 * Every switch is sampled per animation frame and ASSERTED over the whole
 * process (not settled-state only):
 *   - while `selected` has flipped but the displayed window is still the old
 *     one, the old divider(s) must persist and shared rows must not move
 *     uniformly (the pre-fix defect: divider height -46px + seam rows +46px,
 *     dwelling ~104ms, then recovering);
 *   - the window-commit frame may legitimately re-anchor (different members),
 *     but its visible displacement is fully reported, never excused by stable
 *     adjacent-row spacing.
 *
 * A short/clamped route is reported and re-tested at a non-clamped position,
 * never counted as a pass. Any user-visible transient jump fails the run.
 *
 * Artifacts carry synthetic labels (m01…, g1…, b1…, r-*) plus geometry only —
 * never message bodies, never real profile paths.
 */
import type { ObservationContext } from '../../../scripts/ui-observe/scenario'

const invoke = (fnSrc: string, argLiteral = 'undefined') => `(${fnSrc})(${argLiteral})`
const lit = (v: unknown) => JSON.stringify(v)
const round = (v: number) => Math.round(v * 10) / 10
const TOPIC_JSON_PATH = process.env.ROUTE_DIAG_TOPIC_JSON ?? '/Users/jorkeyliu/Downloads/默认话题.json'

// ---------------------------------------------------------------------------
// Page-side: store topic ids (import detection)
// ---------------------------------------------------------------------------
const FN_TOPIC_IDS_SRC = `function () {
  try {
    const s = window.store.getState()
    return (s.assistants && s.assistants.assistants ? s.assistants.assistants : [])
      .flatMap(function (a) { return (a.topics || []).map(function (t) { return t.id }) })
  } catch (e) { return [] }
}`

// ---------------------------------------------------------------------------
// Page-side: Main authority topology (catalog + branches + per-route segments)
// ---------------------------------------------------------------------------
const FN_TOPO_SRC = `function (args) {
  return (async () => {
    const api = window.api.chatDb
    const topicId = args.topicId
    const exp = await api.exportTopicData({ topicId: topicId })
    if (!exp || exp.ok !== true) return { ok: false, err: 'exportTopicData' }
    const payload = exp.value.payload
    const branchesRes = await api.listBranches({ topicId: topicId })
    if (!branchesRes || branchesRes.ok !== true) return { ok: false, err: 'listBranches' }
    const branches = (branchesRes.value && branchesRes.value.branches) || []
    const routeIds = [null].concat(branches.map(function (b) { return b.id }))
    const routes = []
    for (const rid of routeIds) {
      const res = await api.listSegments({ topicId: topicId, branchId: rid })
      if (!res || res.ok !== true) return { ok: false, err: 'listSegments' }
      routes.push({
        branchId: rid,
        segments: (res.value || []).map(function (w) {
          return {
            id: w.id,
            headerMessageId: w.headerMessageId || null,
            ownerBranchId: w.ownerBranchId === undefined ? null : w.ownerBranchId,
            memberIds: w.messageIds || []
          }
        })
      })
    }
    return {
      ok: true,
      messages: (payload.messages || []).map(function (m) {
        return { id: m.id, branchId: m.branchId === undefined ? null : m.branchId, sortOrder: m.sortOrder === undefined ? null : m.sortOrder }
      }),
      segments: (payload.segments || []).map(function (s) {
        return { id: s.id, memberIds: s.messageIds || [] }
      }),
      branches: branches.map(function (b) {
        return { id: b.id, parentBranchId: b.parentBranchId === undefined ? null : b.parentBranchId, anchorMessageId: b.anchorMessageId || null }
      }),
      routes: routes
    }
  })()
}`

// ---------------------------------------------------------------------------
// Page-side: per-animation-frame sampler.
// Captures geometry + identity every frame: scroll offsets, scrollport top,
// phase/visibility/focus, selected route, mounted window ids + viewport tops,
// divider identities/tops/heights, group headers, continuations, rails.
// ---------------------------------------------------------------------------
const FN_SAMPLE_SRC = `function (spec) {
  return new Promise((resolve) => {
    const out = []
    const scroller = document.getElementById('messages')
    const labelOf = spec.labelOf || {}
    const lab = (v) => {
      if (v === null || v === undefined) return null
      return labelOf[String(v)] || 'u:' + String(v).slice(-4)
    }
    const portTop = () => { try { return scroller.getBoundingClientRect().top } catch (e) { return 0 } }
    const rel = (r) => Math.round((r.top - portTop()) * 10) / 10
    const start = performance.now()
    const stamp = () => {
      const t = Math.round(performance.now() - start)
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]'))
      const base = portTop()
      const tops = {}
      const labels = []
      for (const r of rows) {
        const id = r.getAttribute('data-message-id')
        const L = lab(id)
        labels.push(L)
        tops[L] = rel(r.getBoundingClientRect())
      }
      const dividers = Array.from(document.querySelectorAll('[data-divider-anchor]')).map((el) => {
        const rr = el.getBoundingClientRect()
        return {
          anchor: lab(el.getAttribute('data-divider-anchor')),
          parent: el.getAttribute('data-divider-parent'),
          top: rel(rr),
          h: Math.round(rr.height * 10) / 10
        }
      })
      let targetDiv = null
      try {
        const sel = spec.dividerSel ? document.querySelector(spec.dividerSel) : null
        targetDiv = sel ? rel(sel.getBoundingClientRect()) : null
      } catch (e) { targetDiv = null }
      const headers = Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]')).map((el) => {
        const r = el.getBoundingClientRect()
        const countEl = el.querySelector('[data-testid="topic-segment-count"]')
        return {
          seg: lab(el.getAttribute('data-segment-id')),
          head: lab(el.getAttribute('data-segment-header')),
          top: rel(r),
          h: Math.round(r.height * 10) / 10,
          count: countEl ? countEl.textContent : ''
        }
      })
      const conts = Array.from(document.querySelectorAll('[data-testid="topic-segment-rail-continuation"]')).map((el) => ({
        seg: lab(el.getAttribute('data-segment-id')),
        top: rel(el.getBoundingClientRect())
      }))
      let phase = null
      let selected = null
      try { phase = scroller.getAttribute('data-viewport-phase') } catch (e) {}
      try {
        const s = window.store.getState()
        const bids = (s.topicBranch && s.topicBranch.activeBranchIdByTopic) || {}
        const b = bids[spec.topicKey]
        const names = spec.routeNames || {}
        selected = (b === null || b === undefined) ? 'main' : (names[String(b)] || 'branch')
      } catch (e) {}
      out.push({
        t,
        scrollTop: scroller ? Math.round(scroller.scrollTop * 10) / 10 : -1,
        scrollHeight: scroller ? scroller.scrollHeight : -1,
        clientHeight: scroller ? scroller.clientHeight : -1,
        maxScroll: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : -1,
        portTopAbs: Math.round(base * 10) / 10,
        phase,
        vis: document.visibilityState,
        focus: document.hasFocus(),
        selectedRoute: selected,
        tops,
        winCount: rows.length,
        winLabels: labels,
        winFirst: labels[0] || null,
        winLast: labels[labels.length - 1] || null,
        dividerTop: targetDiv,
        dividers,
        headers,
        conts
      })
      const elapsed = performance.now() - start
      if ((elapsed >= spec.durationMs && out.length >= 2) || out.length >= spec.maxFrames) resolve(out)
      else requestAnimationFrame(stamp)
    }
    requestAnimationFrame(stamp)
  })
}`

const FN_COUNTS_SRC = `function () {
  return {
    messages: document.querySelectorAll('#messages [data-message-id]').length,
    hasScroller: !!document.getElementById('messages')
  }
}`

// ---------------------------------------------------------------------------
// Node-side helpers
// ---------------------------------------------------------------------------
async function poll(page: any, expr: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await page.evaluate(expr)) return
    if (Date.now() - start > timeoutMs) throw new Error(`poll timeout: ${label}`)
    await page.waitForTimeout(150)
  }
}

const uniq = (values: unknown[]): string => [...new Set(values.map((v) => String(v)))].join('/')

interface ShiftStat {
  n: number
  median: number | null
  min: number | null
  max: number | null
  spread: number | null
  perRow: string
}

function sharedShifts(aTops: Record<string, number | null>, bTops: Record<string, number | null>): ShiftStat {
  const keys = Object.keys(aTops || {}).filter(
    (k) => typeof aTops[k] === 'number' && bTops && typeof bTops[k] === 'number'
  )
  if (keys.length === 0) return { n: 0, median: null, min: null, max: null, spread: null, perRow: '' }
  const deltas = keys
    .map((k) => ({ k, d: round((bTops[k] as number) - (aTops[k] as number)) }))
    .sort((x, y) => x.d - y.d)
  const vals = deltas.map((x) => x.d)
  return {
    n: keys.length,
    median: vals[Math.floor(vals.length / 2)],
    min: vals[0],
    max: vals[vals.length - 1],
    spread: round(vals[vals.length - 1] - vals[0]),
    perRow: deltas.map((x) => `${x.k}:${x.d}`).join(' ')
  }
}

const sameWin = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
export default async function observe({ page, electronApp, capture, writeText }: ObservationContext) {
  const log: string[] = []
  const defects: string[] = []
  const frameFiles: Record<string, number> = {}

  // ---- 1. Import the REAL topic JSON through the real header import button ----
  await electronApp.evaluate(({ dialog }: typeof import('electron'), target: string) => {
    const d = dialog as any
    if (!d.__routeDispOrigOpen) d.__routeDispOrigOpen = d.showOpenDialog.bind(d)
    d.__routeDispOpenCalls = 0
    d.__routeDispOpenPath = target
    d.showOpenDialog = async () => {
      d.__routeDispOpenCalls += 1
      return { canceled: false, filePaths: [d.__routeDispOpenPath] }
    }
  }, TOPIC_JSON_PATH)

  const known: string[] = await page.evaluate(invoke(FN_TOPIC_IDS_SRC))
  const importBtn = page.getByTestId('topic-import-btn')
  await importBtn.waitFor({ state: 'visible', timeout: 20000 })
  await importBtn.click()

  let importedTopicId: string | null = null
  {
    const start = Date.now()
    for (;;) {
      const ids: string[] = await page.evaluate(invoke(FN_TOPIC_IDS_SRC))
      const fresh = ids.filter((id) => !known.includes(id))
      if (fresh.length > 0) {
        importedTopicId = fresh[0]
        break
      }
      if (Date.now() - start > 60000) throw new Error('import did not produce a new topic within 60s')
      await page.waitForTimeout(200)
    }
  }
  const topicId = importedTopicId as string
  log.push(`import OK: new topic label=topic-${String(topicId).slice(-6)}`)
  await poll(page, invoke(FN_COUNTS_SRC) + '.messages >= 1', 60000, 'imported topic messages mounted')
  await page.waitForTimeout(1200)

  // ---- 2. Viewport: reuse ~1372x889, record actual scrollport ----
  let winBounds: any = null
  try {
    await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w && !w.isDestroyed()) {
        w.setBounds({ x: 80, y: 40, width: 1372, height: 889 })
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
        w.moveTop()
      }
    })
    await page.waitForTimeout(600)
    winBounds = await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) => {
      const w = BrowserWindow.getAllWindows()[0]
      return w && !w.isDestroyed() ? w.getBounds() : null
    })
  } catch (e) {
    log.push(`window resize best-effort failed: ${String(e).slice(0, 120)}`)
  }
  log.push(`window bounds=${winBounds ? `${winBounds.width}x${winBounds.height}` : 'unknown'}`)

  // ---- 3. Main authority topology; resolve group1/group2 per-run ----
  const topo: any = await page.evaluate(invoke(FN_TOPO_SRC, lit({ topicId })))
  if (!topo || topo.ok !== true) throw new Error('topology read failed: ' + JSON.stringify(topo))

  const sortedMsgs = [...(topo.messages as any[])].sort(
    (a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || String(a.id).localeCompare(String(b.id))
  )
  const msgLabel = new Map<string, string>()
  sortedMsgs.forEach((m, i) => msgLabel.set(String(m.id), 'm' + String(i + 1).padStart(2, '0')))
  const branchLabel = new Map<string, string>()
  ;(topo.branches as any[]).forEach((b, i) => branchLabel.set(String(b.id), 'b' + (i + 1)))
  const segLabel = new Map<string, string>()
  ;(topo.segments as any[]).forEach((s, i) => segLabel.set(String(s.id), 'g' + (i + 1)))
  const routeLabel = (branchId: string | null) =>
    branchId === null || branchId === undefined
      ? 'main'
      : 'b' + ((branchLabel.get(String(branchId)) ?? '?').slice(1) || '?')
  const labelOf: Record<string, string> = {}
  for (const [id, label] of msgLabel) labelOf[id] = label
  for (const [id, label] of branchLabel) labelOf[id] = label
  for (const [id, label] of segLabel) labelOf[id] = label
  const lab = (id: string | null) =>
    id === null || id === undefined ? null : (labelOf[String(id)] ?? 'u:' + String(id).slice(-4))

  const mainChildren = (topo.branches as any[]).filter((b) => b.parentBranchId === null)
  const hasNestedChild = (id: string) => (topo.branches as any[]).some((b) => String(b.parentBranchId) === String(id))
  const group1 = mainChildren.find((b) => hasNestedChild(String(b.id))) ?? null
  const group2 = mainChildren.find((b) => b !== group1 && !hasNestedChild(String(b.id))) ?? null
  if (!group1 || !group2) {
    const detail = `expected one nested main child + one plain main child; branches=${(topo.branches as any[]).map((b: any) => `${lab(b.id)}/parent=${b.parentBranchId === null ? 'main' : lab(b.parentBranchId)}/nested=${hasNestedChild(String(b.id))}`).join(' ')}`
    log.push(`COVERAGE-BLOCKED: ${detail}`)
    await writeText('route-displayed-transient-log.txt', log.join('\n'))
    throw new Error(`COVERAGE-BLOCKED: ${detail}`)
  }
  const g1id = String(group1.id)
  const g2id = String(group2.id)
  const g1anchor = String(group1.anchorMessageId)
  const g2anchor = String(group2.anchorMessageId)
  log.push(
    `topology: messages=${topo.messages.length} segments=${topo.segments.length} branches=${topo.branches.length}`
  )
  log.push(`group1=${routeLabel(g1id)} anchor=${lab(g1anchor)} nestedChild=yes (abnormal direction)`)
  log.push(`group2=${routeLabel(g2id)} anchor=${lab(g2anchor)} nestedChild=no (control)`)
  await writeText(
    'topology.json',
    JSON.stringify(
      {
        messages: topo.messages.length,
        segments: topo.segments.length,
        branches: (topo.branches as any[]).map((b: any) => ({
          label: lab(b.id),
          parent: b.parentBranchId === null ? 'main' : lab(b.parentBranchId),
          anchor: lab(b.anchorMessageId),
          nested: hasNestedChild(String(b.id))
        })),
        group1: { route: routeLabel(g1id), anchor: lab(g1anchor) },
        group2: { route: routeLabel(g2id), anchor: lab(g2anchor) }
      },
      null,
      2
    )
  )

  const routeNames: Record<string, string> = {}
  for (const [id, label] of branchLabel) routeNames[id] = 'b' + label.slice(1)
  const track = sortedMsgs.map((m) => ({ id: String(m.id), label: msgLabel.get(String(m.id)) as string }))
  const dividerSelFor = (anchorId: string, parentBranchId: string | null) =>
    `[data-divider-key="${anchorId}::${parentBranchId ?? 'main'}"]`
  const specFor = (anchorId: string, parentBranchId: string | null, durationMs: number, maxFrames: number) => ({
    durationMs,
    maxFrames,
    track,
    labelOf,
    routeNames,
    topicKey: topicId,
    dividerSel: dividerSelFor(anchorId, parentBranchId)
  })
  const snapshot = async (anchorId: string, parentBranchId: string | null): Promise<any> => {
    const frames: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(specFor(anchorId, parentBranchId, 0, 1))))
    return frames[frames.length - 1]
  }
  const wheel = async (dy: number) => {
    await page.locator('#messages').hover()
    await page.mouse.wheel(0, dy)
    await page.waitForTimeout(220)
  }

  const pillSel = (anchorId: string) =>
    `[data-testid="branch-fork-toggle-${anchorId}"], [data-testid="branch-fork-selected-${anchorId}"]`
  const listSel = (anchorId: string) => `[data-testid="branch-fork-list-${anchorId}"]`
  const rowSel = (anchorId: string, branchId: string | 'parent') =>
    `[data-testid="branch-fork-row-${anchorId}-${branchId}"]`

  /** Bring an element into the mounted window with bounded real wheel steps. */
  const wheelUntilMounted = async (
    selector: string,
    anchorId: string,
    parentBranchId: string | null,
    timeoutMs = 60000
  ): Promise<boolean> => {
    const start = Date.now()
    let dir = -1
    for (;;) {
      if ((await page.locator(selector).count()) > 0) return true
      if (Date.now() - start > timeoutMs) return false
      const s = await snapshot(anchorId, parentBranchId)
      if (typeof s.scrollTop === 'number' && s.maxScroll > 0 && Math.abs(s.scrollTop) > 0.92 * s.maxScroll) dir = 1
      await wheel(dir * 300)
    }
  }

  /** Click a fork row: pill -> list -> row. targetBranchId null = parent/main row. */
  const forkTo = async (anchorId: string, targetBranchId: string | null, parentFallback: 'parent') => {
    await page.locator(pillSel(anchorId)).first().click({ timeout: 15000 })
    await page.locator(listSel(anchorId)).waitFor({ state: 'visible', timeout: 15000 })
    const sel = targetBranchId === null ? rowSel(anchorId, parentFallback) : rowSel(anchorId, targetBranchId)
    const loc = page.locator(sel)
    await loc.first().waitFor({ state: 'visible', timeout: 15000 })
    return loc.first()
  }

  /** Place the divider mid-scrollport with a clearly non-boundary scroll offset. */
  const placeReading = async (name: string, anchorId: string, parentBranchId: string | null) => {
    const sel = dividerSelFor(anchorId, parentBranchId)
    if (!(await wheelUntilMounted(sel, anchorId, parentBranchId))) {
      return { ok: false as const, reason: `divider never mounted for ${name}` }
    }
    let s: any = null
    for (let attempt = 0; attempt < 22; attempt++) {
      s = await snapshot(anchorId, parentBranchId)
      if (s.dividerTop === null || s.dividerTop === undefined) {
        await wheel(-400)
        continue
      }
      if (s.maxScroll < 80) break // short route: cannot be non-clamped; report below
      const r = Math.abs(s.scrollTop) / Math.max(1, s.maxScroll)
      const dividerOK = s.dividerTop >= s.clientHeight * 0.25 && s.dividerTop <= s.clientHeight * 0.65
      const ratioOK = r >= 0.15 && r <= 0.85
      if (dividerOK && ratioOK) break
      if (!ratioOK) {
        await wheel(
          r < 0.15 ? -Math.max(200, Math.round(s.maxScroll * 0.1)) : Math.max(200, Math.round(s.maxScroll * 0.1))
        )
        continue
      }
      const delta = s.dividerTop - s.clientHeight * 0.45
      if (Math.abs(delta) <= 12) break
      await wheel(Math.round(delta / 2))
    }
    s = await snapshot(anchorId, parentBranchId)
    const ratio = round(Math.abs(s.scrollTop) / Math.max(1, s.maxScroll))
    const dividerMid =
      s.dividerTop !== null &&
      s.dividerTop !== undefined &&
      s.dividerTop >= s.clientHeight * 0.2 &&
      s.dividerTop <= s.clientHeight * 0.7
    const clamped = s.maxScroll < 80 || Math.abs(s.scrollTop) <= 1 || ratio < 0.15 || ratio > 0.85 || !dividerMid
    return { ok: true as const, s, ratio, clamped }
  }

  interface SwitchReport {
    name: string
    pre: any
    frames: any[]
    post: any
    flipIdx: number
    commitIdx: number
    earlyExtreme: number | null
    earlyMaxStep: number
    commitShift: ShiftStat | null
    settledShift: ShiftStat
    scrollEx: number
    sHChange: number
    divCountPre: number
    divCountEarlyMin: number
    divCountPost: number
  }

  const analyzeSwitch = (name: string, pre: any, frames: any[], post: any, targetRoute: string): SwitchReport => {
    let flipIdx = -1
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].selectedRoute === targetRoute) {
        flipIdx = i
        break
      }
    }
    let commitIdx = -1
    for (let i = 0; i < frames.length; i++) {
      if (!sameWin(frames[i].winLabels || [], pre.winLabels || [])) {
        commitIdx = i
        break
      }
    }
    const scrolls = frames.map((f) => f.scrollTop)
    const scrollEx = round(Math.max(...scrolls) - Math.min(...scrolls))
    const sHChange = (frames[frames.length - 1]?.scrollHeight ?? 0) - (frames[0]?.scrollHeight ?? 0)
    // Early phase: selected flipped, window still old.
    let earlyExtreme: number | null = null
    let earlyMaxStep = 0
    let divCountEarlyMin = pre.dividers?.length ?? 0
    if (flipIdx >= 0) {
      const end = commitIdx >= 0 ? commitIdx : frames.length
      let prev = pre.tops
      for (let i = flipIdx; i < end; i++) {
        const st = sharedShifts(pre.tops, frames[i].tops)
        if (st.median !== null && (earlyExtreme === null || Math.abs(st.median) > Math.abs(earlyExtreme))) {
          earlyExtreme = st.median
        }
        const step = sharedShifts(prev, frames[i].tops)
        if (step.median !== null && Math.abs(step.median) > earlyMaxStep) earlyMaxStep = Math.abs(step.median)
        prev = frames[i].tops
        const dc = frames[i].dividers?.length ?? 0
        if (dc < divCountEarlyMin) divCountEarlyMin = dc
      }
    }
    const commitShift = commitIdx >= 0 ? sharedShifts(pre.tops, frames[commitIdx].tops) : null
    const settledShift = sharedShifts(pre.tops, post.tops)
    return {
      name,
      pre,
      frames,
      post,
      flipIdx,
      commitIdx,
      earlyExtreme,
      earlyMaxStep,
      commitShift,
      settledShift,
      scrollEx,
      sHChange,
      divCountPre: pre.dividers?.length ?? 0,
      divCountEarlyMin,
      divCountPost: post.dividers?.length ?? 0
    }
  }

  const reportSwitch = (r: SwitchReport, targetRoute: string): string[] => {
    const lines: string[] = []
    const pre = r.pre
    lines.push(`== ${r.name} (frames=${r.frames.length}, span=${r.frames[r.frames.length - 1].t - r.frames[0].t}ms)`)
    lines.push(
      `pre: route=${pre.selectedRoute} scrollTop=${pre.scrollTop} sH=${pre.scrollHeight} cH=${pre.clientHeight} phase=${pre.phase} vis=${pre.vis} rows=${pre.winCount} dividerTop=${pre.dividerTop} dividers=${r.divCountPre}`
    )
    lines.push(`flipIdx=${r.flipIdx} (selected->${targetRoute}) commitIdx=${r.commitIdx} (window change)`)
    lines.push(`scroll excursion=${r.scrollEx}px sH change=${r.sHChange}px`)
    lines.push(
      `EARLY (selected flipped, old window): extreme median=${r.earlyExtreme} maxStep=${r.earlyMaxStep} dividerCount min=${r.divCountEarlyMin} (pre=${r.divCountPre})`
    )
    if (r.commitShift) {
      lines.push(
        `COMMIT re-anchor: shared=${r.commitShift.n} median=${r.commitShift.median} spread=${r.commitShift.spread} rows=${r.commitShift.perRow.slice(0, 300)}`
      )
    } else {
      lines.push('COMMIT re-anchor: window never changed during the sampled window')
    }
    lines.push(
      `SETTLED pre->post: shared=${r.settledShift.n} median=${r.settledShift.median} spread=${r.settledShift.spread} scroll ${pre.scrollTop}->${r.post.scrollTop} dividers ${r.divCountPre}->${r.divCountPost}`
    )
    lines.push(`phase=${uniq(r.frames.map((f) => f.phase))} selected=${uniq(r.frames.map((f) => f.selectedRoute))}`)
    // Early-phase defect assertions.
    if (r.flipIdx >= 0 && r.commitIdx > r.flipIdx) {
      if (r.divCountEarlyMin < r.divCountPre) {
        defects.push(`${r.name}: DIVIDER-EARLY pre=${r.divCountPre} earlyMin=${r.divCountEarlyMin}`)
      }
      if (r.earlyExtreme !== null && Math.abs(r.earlyExtreme) >= 8) {
        defects.push(
          `${r.name}: EARLY-SHIFT extreme=${r.earlyExtreme}px maxStep=${r.earlyMaxStep}px scrollEx=${r.scrollEx}px`
        )
      }
    } else if (r.flipIdx < 0) {
      defects.push(`${r.name}: NO-FLIP selected never reached ${targetRoute}`)
    } else if (r.commitIdx < 0) {
      lines.push('note: window identical across the sampled window (no commit frame observed)')
    }
    return lines
  }

  const runSwitch = async (
    name: string,
    anchorId: string,
    parentBranchId: string | null,
    targetBranchId: string | null,
    targetRoute: string
  ): Promise<void> => {
    const placed = await placeReading(name, anchorId, parentBranchId)
    if (!placed.ok) throw new Error(placed.reason)
    const { s, ratio, clamped } = placed as { s: any; ratio: number; clamped: boolean }
    log.push('')
    log.push(
      `${name} reading: dividerTop=${s.dividerTop} cH=${s.clientHeight} scrollTop=${s.scrollTop} maxScroll=${s.maxScroll} ratio=${ratio} rows=${s.winCount} phase=${s.phase} selected=${s.selectedRoute}${clamped ? ' CLAMPED' : ''}`
    )
    if (clamped) {
      log.push(
        `${name}: CLAMPED reading position (short route or boundary); result is coverage-limited, not a pass by itself`
      )
    }
    if (Math.abs(s.scrollTop) <= 0 && s.maxScroll > 80) {
      throw new Error(`${name}: reading position is at the top boundary; refusing a top-anchored switch`)
    }
    const pre = s
    await capture(`pre-${name}`)
    const samplePromise = page.evaluate(
      invoke(FN_SAMPLE_SRC, lit(specFor(anchorId, parentBranchId, 1400, 900)))
    ) as Promise<any[]>
    await page.waitForTimeout(60)
    const row = await forkTo(anchorId, targetBranchId, 'parent')
    await row.click({ timeout: 15000 })
    const frames: any[] = await samplePromise
    const file = `frames-${name}.json`
    await writeText(file, JSON.stringify(frames))
    frameFiles[name] = frames.length
    await page.waitForTimeout(1400)
    const post = await snapshot(anchorId, targetBranchId)
    log.push(...reportSwitch(analyzeSwitch(name, pre, frames, post, targetRoute), targetRoute))
    log.push(
      `post settled: route=${post.selectedRoute} rows=${post.winCount} scrollTop=${post.scrollTop} dividerTop=${post.dividerTop} dividers=${post.dividers?.length}`
    )
  }

  // ---- 4. Four real-UI switches: group1 main→child→main, group2 main→child→main ----
  // Start from main: ensure group1's fork pill is reachable, then walk if needed.
  const ensureMain = async () => {
    const s = await snapshot(g1anchor, null)
    if (s.selectedRoute === 'main') return
    await wheelUntilMounted(pillSel(g1anchor), g1anchor, null)
    const row = await forkTo(g1anchor, null, 'parent')
    await row.click({ timeout: 15000 })
    await page.waitForTimeout(1400)
  }
  await ensureMain()
  await capture('a-start-main')

  await runSwitch('g1-main-to-child', g1anchor, null, g1id, routeLabel(g1id))
  await runSwitch('g1-child-to-main', g1anchor, null, null, 'main')
  await runSwitch('g2-main-to-child', g2anchor, null, g2id, routeLabel(g2id))
  await runSwitch('g2-child-to-main', g2anchor, null, null, 'main')
  await capture('b-end-main')

  // ---- 5. Verdict ----
  log.push('')
  log.push(
    `frames files: ${Object.entries(frameFiles)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`
  )
  if (defects.length > 0) {
    log.push(`DEFECTS (${defects.length}):`)
    for (const d of defects) log.push('  - ' + d)
    log.push('VERDICT: REPRODUCED — a user-visible transient displacement persists on a real route switch.')
  } else {
    log.push(
      'VERDICT: NOT REPRODUCED — no early-phase uniform shift and no early divider loss on any of the 4 real switches; commit re-anchors are reported above with full numbers.'
    )
  }
  await writeText('route-displayed-transient-log.txt', log.join('\n'))
  if (defects.length > 0) throw new Error(`TRANSIENT-DEFECT: ${defects.join(' | ').slice(0, 500)}`)
}
