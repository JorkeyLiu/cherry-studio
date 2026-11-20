/**
 * DIAGNOSTIC scenario (not a regression asset, not a durable E2E spec).
 *
 * Reproduces the reported "vertical displacement of the whole message column
 * when switching a route through a TRUE residual group" against a REAL user
 * topic imported through the REAL header import button (`topic-import-btn` →
 * Main `dialog.showOpenDialog` → `window.api.chatDb.importTopicData` → Main
 * authority rows), inside the observation harness' disposable profile.
 *
 * Source of the topic: `$ROUTE_DIAG_TOPIC_JSON` or the file the user named
 * (`/Users/jorkeyliu/Downloads/默认话题.json`). Nothing is seeded or fabricated
 * when the real file is unusable: the scenario reports and stops.
 *
 * Contract of the run (all real gestures, no synthetic fixture):
 * 1. Import the real JSON through the header import button (only the native
 *    file dialog is stubbed, exactly like the committed topic-data spec).
 * 2. Read the topology from Main authority: `exportTopicData` (catalog) +
 *    `listBranches` + `listSegments` route qualification per route
 *    (main + every branch node). A TRUE residual group means
 *    `headerInRoute === false` with `routeMemberMessageIds.length > 0` on a
 *    child route while the same group is headed (`headerInRoute === true`) on
 *    its parent route.
 * 3. Place the viewport with real wheel input at a clearly NON-top, NON-bottom
 *    mid reading position around the fork divider of the residual pair.
 * 4. Switch parent → child → parent through the REAL branch UI (fork divider
 *    pill + its route list) and sample every animation frame for >= 600ms per
 *    window.
 *
 * Judgment uses ONE stable anchor (same message id mounted before and after)
 * measured relative to the scrollport top, and separates:
 *   - anchor top change (what the eye sees),
 *   - scrollTop change (a legitimate window relocation / paging),
 *   - mounted window rows change,
 *   - group header structure change (32px header rows), continuations, rails.
 * A whole-column shift is only claimed when several rows present in both
 * windows move together by the same amount with their mutual spacing intact —
 * adjacent-row spacing alone is never the basis of the verdict.
 *
 * Artifacts carry synthetic labels (m01…, g1…, b1…, r-*) plus geometry only —
 * never message bodies, never claims, never real profile paths.
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
// Page-side: Main authority topology (catalog + per-route qualification)
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
            memberIds: w.messageIds || [],
            route: w.route ? {
              headerInRoute: w.route.headerInRoute,
              headerOwnedByRoute: w.route.headerOwnedByRoute,
              routeMemberMessageIds: w.route.routeMemberMessageIds || []
            } : null
          }
        })
      })
    }
    return {
      ok: true,
      topicNameLen: (payload.topic && typeof payload.topic.name === 'string') ? payload.topic.name.length : null,
      messages: (payload.messages || []).map(function (m) {
        return { id: m.id, role: m.role, branchId: m.branchId === undefined ? null : m.branchId, sortOrder: m.sortOrder === undefined ? null : m.sortOrder }
      }),
      segments: (payload.segments || []).map(function (s) {
        return { id: s.id, memberIds: s.messageIds || [], nameLen: (s.name || '').length }
      }),
      branches: branches.map(function (b) {
        return { id: b.id, parentBranchId: b.parentBranchId === undefined ? null : b.parentBranchId, anchorMessageId: b.anchorMessageId || null }
      }),
      routes: routes
    }
  })()
}`

// ---------------------------------------------------------------------------
// Page-side: per-animation-frame sampler
// spec = { durationMs, maxFrames, track: [{ id, label }], labelOf: {id: label},
//          dividerAnchorId, dividerParentId }
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
    const cTop = () => { try { return scroller.getBoundingClientRect().top } catch (e) { return 0 } }
    const rel = (r) => Math.round((r.top - cTop()) * 10) / 10
    const rowEl = (id) => {
      try { return document.querySelector('[id="message-' + id + '"][data-message-id="' + id + '"]') } catch (e) { return null }
    }
    const dividerSel = (() => {
      if (!spec.dividerAnchorId) return null
      const parent = spec.dividerParentId === null || spec.dividerParentId === undefined ? 'main' : spec.dividerParentId
      return '[data-divider-key="' + spec.dividerAnchorId + '::' + parent + '"]'
    })()
    const start = performance.now()
    const stamp = () => {
      const t = Math.round(performance.now() - start)
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]'))
      const base = cTop()
      let topEdgeRow = null
      let firstInsideRow = null
      let firstInsideTop = Number.POSITIVE_INFINITY
      for (const r of rows) {
        const rr = r.getBoundingClientRect()
        if (rr.bottom > base + 0.5 && rr.top < base + 0.5) topEdgeRow = lab(r.getAttribute('data-message-id'))
        if (rr.top >= base - 0.5 && rr.top < firstInsideTop) {
          firstInsideTop = rr.top
          firstInsideRow = lab(r.getAttribute('data-message-id'))
        }
      }
      const headers = Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]')).map((el) => {
        const r = el.getBoundingClientRect()
        const countEl = el.querySelector('[data-testid="topic-segment-count"]')
        return {
          seg: lab(el.getAttribute('data-segment-id')),
          head: lab(el.getAttribute('data-segment-header')),
          first: el.getAttribute('data-segment-first'),
          last: el.getAttribute('data-segment-last'),
          top: rel(r),
          h: Math.round(r.height * 10) / 10,
          count: countEl ? countEl.textContent : ''
        }
      })
      const conts = Array.from(document.querySelectorAll('[data-testid="topic-segment-rail-continuation"]')).map((el) => ({
        seg: lab(el.getAttribute('data-segment-id')),
        top: rel(el.getBoundingClientRect())
      }))
      const rails = Array.from(document.querySelectorAll('[data-testid="topic-segment-rule"]')).map((el) => ({
        seg: lab(el.getAttribute('data-segment-id')),
        top: rel(el.getBoundingClientRect()),
        h: Math.round(el.getBoundingClientRect().height * 10) / 10
      }))
      let divEl = null
      try {
        divEl = dividerSel ? document.querySelector(dividerSel) : document.querySelector('[data-divider-anchor]')
      } catch (e) { divEl = null }
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
      const tops = {}
      for (const entry of (spec.track || [])) {
        const el = rowEl(entry.id)
        tops[entry.label] = el ? rel(el.getBoundingClientRect()) : null
      }
      const labels = rows.map((r) => lab(r.getAttribute('data-message-id')))
      out.push({
        t,
        scrollTop: scroller ? Math.round(scroller.scrollTop * 10) / 10 : -1,
        scrollHeight: scroller ? scroller.scrollHeight : -1,
        clientHeight: scroller ? scroller.clientHeight : -1,
        maxScroll: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : -1,
        phase,
        selectedRoute: selected,
        headers,
        conts,
        rails,
        dividerTop: divEl ? rel(divEl.getBoundingClientRect()) : null,
        tops,
        winCount: rows.length,
        winLabels: labels,
        winFirst: labels[0] || null,
        winLast: labels[labels.length - 1] || null,
        topEdgeRow,
        firstInsideRow
      })
      const elapsed = performance.now() - start
      if ((elapsed >= spec.durationMs && out.length >= 2) || out.length >= spec.maxFrames) resolve(out)
      else requestAnimationFrame(stamp)
    }
    requestAnimationFrame(stamp)
  })
}`

// ---------------------------------------------------------------------------
// Page-side: single snapshot + scroller geometry
// ---------------------------------------------------------------------------
const FN_COUNTS_SRC = `function () {
  return {
    messages: document.querySelectorAll('#messages [data-message-id]').length,
    headers: document.querySelectorAll('[data-testid="topic-segment-group"]').length,
    dividers: document.querySelectorAll('[data-divider-anchor]').length,
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

function rowDeltas(frames: any[]): { text: string[]; moved: string[] } {
  const text: string[] = []
  const moved: string[] = []
  const labels = new Set<string>()
  for (const f of frames) for (const k of Object.keys(f.tops || {})) labels.add(k)
  for (const label of [...labels].sort()) {
    const tops: number[] = []
    for (const f of frames) {
      const v = f.tops ? f.tops[label] : null
      if (typeof v === 'number') tops.push(v)
    }
    if (tops.length < 2) {
      text.push(`  ${label} | mounted=${tops.length}`)
      continue
    }
    const ex = round(Math.max(...tops) - Math.min(...tops))
    text.push(`  ${label} | n=${tops.length} | ${tops[0]} -> ${tops[tops.length - 1]} | ex=${ex}`)
    if (ex >= 2) moved.push(`${label}(ex=${ex},top=${tops[0]}->${tops[tops.length - 1]})`)
  }
  return { text, moved }
}

function summarizeWindow(name: string, frames: any[]): { text: string; flags: string[] } {
  const flags: string[] = []
  const lines: string[] = []
  const scrolls = frames.map((f) => (typeof f.scrollTop === 'number' ? f.scrollTop : NaN))
  const scrollEx = round(Math.max(...scrolls) - Math.min(...scrolls))
  lines.push(`== ${name} (frames=${frames.length}, span=${frames[frames.length - 1].t - frames[0].t}ms)`)
  lines.push(
    `scrollTop first=${scrolls[0]} last=${scrolls[scrolls.length - 1]} delta=${round(scrolls[scrolls.length - 1] - scrolls[0])} excursion=${scrollEx} maxScroll=${frames[0].maxScroll} clientHeight=${frames[0].clientHeight}`
  )
  lines.push(`phase=${uniq(frames.map((f) => f.phase))} selectedRoute=${uniq(frames.map((f) => f.selectedRoute))}`)
  lines.push(
    `window rows=${uniq(frames.map((f) => f.winCount))} first=${uniq(frames.map((f) => f.winFirst))} last=${uniq(frames.map((f) => f.winLast))}`
  )
  lines.push(
    `topEdgeRow=${uniq(frames.map((f) => f.topEdgeRow))} firstInsideRow=${uniq(frames.map((f) => f.firstInsideRow))}`
  )
  lines.push(`dividerTop=${uniq(frames.map((f) => f.dividerTop))}`)
  lines.push(
    `headers=${uniq(frames.map((f) => (f.headers || []).map((h: any) => `${h.seg}/${h.head}@${h.top}h${h.h}c${h.count}`).join(';')))}`
  )
  lines.push(`continuations=${uniq(frames.map((f) => (f.conts || []).map((c: any) => `${c.seg}@${c.top}`).join(';')))}`)
  lines.push(`rails=${uniq(frames.map((f) => (f.rails || []).map((r: any) => `${r.seg}@${r.top}h${r.h}`).join(';')))}`)
  const deltas = rowDeltas(frames)
  lines.push('per-row viewport-relative top (label | frames | first -> last | excursion):')
  lines.push(...deltas.text)
  if (deltas.moved.length > 0) flags.push(`${name}: ROW-TOP-MOVED ${deltas.moved.join(' ')} scrollEx=${scrollEx}`)
  return { text: lines.join('\n'), flags }
}

/**
 * Compare two settled states (pre-switch vs post-switch) of ONE route switch:
 * the anchor's viewport-relative top, the scroll offset, the mounted window,
 * and the header structure — kept explicitly separate.
 */
function diffSwitch(
  name: string,
  pre: any,
  post: any,
  anchor: string
): { text: string; flags: string[]; anchorDelta: number | null } {
  const flags: string[] = []
  const lines: string[] = []
  const preTop = pre && pre.tops ? pre.tops[anchor] : null
  const postTop = post && post.tops ? post.tops[anchor] : null
  const anchorDelta = typeof preTop === 'number' && typeof postTop === 'number' ? round(postTop - preTop) : null
  const scrollDelta = round(post.scrollTop - pre.scrollTop)
  const shared = Object.keys(pre.tops || {}).filter(
    (k) => typeof pre.tops[k] === 'number' && post.tops && typeof post.tops[k] === 'number'
  )
  const shifts = shared.map((k) => round(post.tops[k] - pre.tops[k])).sort((a, b) => a - b)
  const median = shifts.length === 0 ? null : shifts[Math.floor(shifts.length / 2)]
  const spread = shifts.length === 0 ? null : round(shifts[shifts.length - 1] - shifts[0])
  const preSet = new Set<string>(pre.winLabels || [])
  const postSet = new Set<string>(post.winLabels || [])
  const added = [...postSet].filter((l) => !preSet.has(l))
  const removed = [...preSet].filter((l) => !postSet.has(l))
  lines.push(`== ${name}`)
  lines.push(`anchor ${anchor}: top ${preTop} -> ${postTop} (delta=${anchorDelta})`)
  lines.push(`scrollTop ${pre.scrollTop} -> ${post.scrollTop} (delta=${scrollDelta})`)
  lines.push(
    `window rows ${pre.winCount} -> ${post.winCount} (added=${added.length} removed=${removed.length}) adds=${added.join(',')} removes=${removed.join(',')}`
  )
  lines.push(
    `headers pre=${(pre.headers || []).map((h: any) => `${h.seg}/${h.head}@${h.top}h${h.h}`).join(';')} post=${(post.headers || []).map((h: any) => `${h.seg}/${h.head}@${h.top}h${h.h}`).join(';')}`
  )
  lines.push(
    `continuations pre=${(pre.conts || []).map((c: any) => `${c.seg}@${c.top}`).join(';')} post=${(post.conts || []).map((c: any) => `${c.seg}@${c.top}`).join(';')}`
  )
  lines.push(`phase ${pre.phase} -> ${post.phase}; selectedRoute ${pre.selectedRoute} -> ${post.selectedRoute}`)
  lines.push(`dividerTop ${pre.dividerTop} -> ${post.dividerTop}`)
  lines.push(
    `shared rows=${shared.length} shift median=${median} min=${shifts.length ? shifts[0] : null} max=${shifts.length ? shifts[shifts.length - 1] : null} spread=${spread}`
  )
  lines.push(`shared row shifts: ${shared.map((k) => `${k}:${round(post.tops[k] - pre.tops[k])}`).join(' ')}`)
  if (anchorDelta === null) {
    flags.push(`${name}: ANCHOR-ABSENT (stable anchor not mounted on both sides)`)
  } else if (shared.length >= 3 && spread !== null && spread <= 2 && median !== null && Math.abs(median) >= 8) {
    flags.push(
      `${name}: WHOLE-COLUMN-SHIFT anchor=${anchorDelta}px rows=${shared.length} median=${median}px spread=${spread}px scrollDelta=${scrollDelta}px`
    )
  } else if (Math.abs(anchorDelta) >= 8) {
    flags.push(
      `${name}: ANCHOR-MOVED anchor=${anchorDelta}px rows=${shared.length} median=${median} spread=${spread} scrollDelta=${scrollDelta}px (not a uniform column shift)`
    )
  } else {
    lines.push(`anchor within ${Math.abs(anchorDelta)}px: no viewport-relative displacement for the stable anchor`)
  }
  return { text: lines.join('\n'), flags, anchorDelta }
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
export default async function observe({ page, electronApp, capture, writeText }: ObservationContext) {
  const log: string[] = []
  const flags: string[] = []

  // ---- 1. Import the REAL topic JSON through the real header import button ----
  await electronApp.evaluate(({ dialog }: typeof import('electron'), target: string) => {
    const d = dialog as any
    if (!d.__routeDiagOrigOpen) d.__routeDiagOrigOpen = d.showOpenDialog.bind(d)
    d.__routeDiagOpenCalls = 0
    d.__routeDiagOpenPath = target
    d.showOpenDialog = async () => {
      d.__routeDiagOpenCalls += 1
      return { canceled: false, filePaths: [d.__routeDiagOpenPath] }
    }
  }, TOPIC_JSON_PATH)

  const known: string[] = await page.evaluate(invoke(FN_TOPIC_IDS_SRC))
  log.push(`pre-import topics in store=${known.length}`)
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
  const openCalls = await electronApp.evaluate(({ dialog }: typeof import('electron')) => {
    const d = dialog as any
    return (d.__routeDiagOpenCalls ?? 0) as number
  })
  const topicId = importedTopicId
  log.push(
    `import OK: dialog calls=${openCalls} new topic label=...${String(topicId).slice(-6)} (sidebar click not required: import activates it)`
  )

  await poll(page, invoke(FN_COUNTS_SRC) + '.messages >= 1', 60000, 'imported topic messages mounted')
  await page.waitForTimeout(1200)
  const afterImport: any = await page.evaluate(invoke(FN_COUNTS_SRC))
  log.push(`imported topic DOM right after activation: ${JSON.stringify(afterImport)}`)
  await capture('a0-after-import')

  // ---- 2. Main authority topology ----
  const topo: any = await page.evaluate(invoke(FN_TOPO_SRC, lit({ topicId })))
  if (!topo || topo.ok !== true) throw new Error('topology read failed: ' + JSON.stringify(topo))

  // Anonymous labels: messages by catalog sort order, branches/segments by authority order.
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
      ? 'r-main'
      : 'r-' + (branchLabel.get(String(branchId)) ?? String(branchId).slice(-4))
  const labelOf: Record<string, string> = {}
  for (const [id, label] of msgLabel) labelOf[id] = label
  for (const [id, label] of branchLabel) labelOf[id] = label
  for (const [id, label] of segLabel) labelOf[id] = label
  const lab = (id: string | null) => (id === null || id === undefined ? null : (labelOf[String(id)] ?? '?'))
  const labList = (ids: string[] | null | undefined): string[] => (ids ?? []).map((id) => lab(id) ?? '?')

  const branchById = new Map<string, any>((topo.branches as any[]).map((b) => [String(b.id), b]))
  const routeQual = new Map<string, Map<string, any>>()
  for (const r of topo.routes as any[]) {
    const key = routeLabel(r.branchId)
    const m = new Map<string, any>()
    for (const s of r.segments as any[]) m.set(String(s.id), s)
    routeQual.set(key, m)
  }

  const topoLines: string[] = []
  topoLines.push(
    `topic name length=${topo.topicNameLen} messages=${topo.messages.length} segments=${topo.segments.length} branches=${topo.branches.length} fileRefs/other=not-exported`
  )
  topoLines.push('branch tree (authority):')
  for (const b of topo.branches as any[]) {
    topoLines.push(
      `  ${branchLabel.get(String(b.id))} parent=${b.parentBranchId === null ? 'main' : branchLabel.get(String(b.parentBranchId))} anchorMessage=${lab(b.anchorMessageId)}`
    )
  }
  topoLines.push('segments (catalog membership + header + per-route qualification):')
  type PairKind = 'strict-residual' | 'headed-truncated' | 'group-dissolve' | 'group-appear'
  interface Pair {
    segId: string
    seg: string
    kind: PairKind
    parentRoute: string
    childRoute: string
    parentMembers: string[]
    childMembers: string[]
    parentHeaderInRoute: boolean | null
    childHeaderInRoute: boolean | null
    anchorInGroup: boolean
  }
  const pairs: Pair[] = []
  for (const seg of topo.segments as any[]) {
    const segId = String(seg.id)
    const label = segLabel.get(segId) ?? '?'
    topoLines.push(
      `  ${label} members=${seg.memberIds.length} header=${lab(routeQual.get('r-main')?.get(segId)?.headerMessageId ?? null)} membership=${labList(seg.memberIds).join(',')} nameLen=${seg.nameLen}`
    )
    for (const r of topo.routes as any[]) {
      const wire = routeQual.get(routeLabel(r.branchId))?.get(segId)
      if (!wire) continue
      const routeMembers: string[] = wire.route?.routeMemberMessageIds ?? []
      const headerInRoute = wire.route ? wire.route.headerInRoute : null
      const residual = headerInRoute === false && routeMembers.length > 0
      topoLines.push(
        `    ${routeLabel(r.branchId)}: headerInRoute=${headerInRoute} headerOwnedByRoute=${wire.route ? wire.route.headerOwnedByRoute : null} routeMembers=${routeMembers.length} ${labList(routeMembers).join(',')}${residual ? '   <== RESIDUAL (head not on route, members reachable)' : ''}`
      )
      // Pairs are defined by a real child-branch hop: parent route -> child branch route.
      if (r.branchId === null) continue
      const childNode = branchById.get(String(r.branchId))
      if (!childNode || !childNode.anchorMessageId) continue
      const parentRouteId = childNode.parentBranchId === null ? null : String(childNode.parentBranchId)
      const parentWire = routeQual.get(routeLabel(parentRouteId))?.get(segId)
      const parentMembers: string[] = parentWire?.route?.routeMemberMessageIds ?? []
      const parentHeaderInRoute = parentWire?.route ? parentWire.route.headerInRoute : null
      const anchorInGroup = (seg.memberIds as string[]).includes(String(childNode.anchorMessageId))
      let kind: PairKind | null = null
      if (residual && parentHeaderInRoute === true) kind = 'strict-residual'
      else if (
        headerInRoute === true &&
        parentHeaderInRoute === true &&
        routeMembers.length > 0 &&
        parentMembers.length > routeMembers.length
      ) {
        kind = 'headed-truncated'
      } else if (parentHeaderInRoute === true && parentMembers.length > 0 && routeMembers.length === 0) {
        kind = 'group-dissolve'
      } else if (
        parentHeaderInRoute === false &&
        parentMembers.length === 0 &&
        headerInRoute === true &&
        routeMembers.length > 0
      ) {
        kind = 'group-appear'
      }
      if (kind !== null) {
        pairs.push({
          segId: label,
          seg: label,
          kind,
          parentRoute: routeLabel(parentRouteId),
          childRoute: routeLabel(r.branchId),
          parentMembers: labList(parentMembers),
          childMembers: labList(routeMembers),
          parentHeaderInRoute,
          childHeaderInRoute: headerInRoute,
          anchorInGroup
        })
      }
    }
  }
  log.push(...topoLines)
  await writeText('topology.txt', topoLines.join('\n'))

  const priority: PairKind[] = ['strict-residual', 'headed-truncated', 'group-appear', 'group-dissolve']
  const ranked = [...pairs].sort((a, b) => {
    const byKind = priority.indexOf(a.kind) - priority.indexOf(b.kind)
    if (byKind !== 0) return byKind
    if (a.anchorInGroup === b.anchorInGroup) return 0
    return a.anchorInGroup ? -1 : 1
  })
  const strictPairs = pairs.filter((p) => p.kind === 'strict-residual')
  await writeText(
    'topology.json',
    JSON.stringify(
      {
        topicLabel: `topic-${String(topicId).slice(-6)}`,
        messages: topo.messages.length,
        segments: topo.segments.length,
        branches: (topo.branches as any[]).map((b) => ({
          label: branchLabel.get(String(b.id)),
          parent: b.parentBranchId === null ? 'main' : branchLabel.get(String(b.parentBranchId)),
          anchor: lab(b.anchorMessageId)
        })),
        strictResidualPairs: strictPairs,
        allStructuralPairs: pairs,
        chosenPair: ranked[0] ?? null
      },
      null,
      2
    )
  )

  if (ranked.length === 0) {
    const detail = 'no segment changes route membership across any real parent/child branch pair (nothing to observe)'
    log.push('')
    log.push(`COVERAGE: ${detail}`)
    log.push(
      'VERDICT: the user-reported route-switch displacement cannot be covered by this topic; no substitute fixture is created.'
    )
    await capture('a1-no-coverage')
    await writeText('route-default-topic-real-log.txt', log.join('\n'))
    throw new Error(`COVERAGE-NOT-POSSIBLE: ${detail}`)
  }

  const forcedIndex = Number(process.env.ROUTE_DIAG_PAIR_INDEX ?? '0')
  const pairIndex = Number.isInteger(forcedIndex) && forcedIndex >= 0 && forcedIndex < ranked.length ? forcedIndex : 0
  const pair = ranked[pairIndex]
  log.push(`pair index ${pairIndex} of ${ranked.length} (kind=${pair.kind})`)
  const strictMode = pair.kind === 'strict-residual'
  const childBranchId = [...branchById.keys()].find((id) => routeLabel(id) === pair.childRoute) ?? null
  if (!childBranchId) throw new Error('could not resolve the observed child branch id')
  const childNode = branchById.get(childBranchId)
  const parentRouteBranchId = childNode.parentBranchId === null ? null : String(childNode.parentBranchId)
  const forkAnchorId = String(childNode.anchorMessageId)
  log.push('')
  log.push(
    strictMode
      ? `COVERAGE: STRICT residual group present — ${pair.seg} headed on ${pair.parentRoute} (${pair.parentMembers.join(',')}) with headerInRoute=false on ${pair.childRoute} (${pair.childMembers.join(',')}).`
      : `COVERAGE: the STRICT residual shape (headerInRoute=false with reachable members on the child route) does NOT exist in this topic. Observed the closest real structure instead: ${pair.kind} for ${pair.seg} on ${pair.parentRoute} (${pair.parentMembers.join(',')}) -> ${pair.childRoute} (${pair.childMembers.join(',')}) with anchorInGroup=${pair.anchorInGroup}. The numbers below describe that structure, NOT the strict residual shape.`
  )
  log.push(
    `observation pair: fork anchor=${lab(forkAnchorId)} of ${routeLabel(childBranchId)} (parent=${pair.parentRoute})`
  )

  // ---- 3. Walk to the parent route through the REAL branch UI ----
  const chain: string[] = []
  {
    let cur: string | null = parentRouteBranchId
    while (cur) {
      const node = branchById.get(cur)
      if (!node) break
      chain.unshift(cur)
      cur = node.parentBranchId === null ? null : String(node.parentBranchId)
    }
  }
  log.push(`navigation chain main -> ${chain.map((id) => routeLabel(id)).join(' -> ')}`)

  const wheel = async (dy: number) => {
    await page.locator('#messages').hover()
    await page.mouse.wheel(0, dy)
    await page.waitForTimeout(220)
  }
  const track = sortedMsgs.map((m) => ({ id: String(m.id), label: msgLabel.get(String(m.id)) as string }))
  const routeNames: Record<string, string> = {}
  for (const [id, label] of branchLabel) routeNames[id] = label
  const spec = (durationMs: number, maxFrames: number) => ({
    durationMs,
    maxFrames,
    track,
    labelOf,
    routeNames,
    topicKey: topicId,
    dividerAnchorId: forkAnchorId,
    dividerParentId: parentRouteBranchId
  })
  const snapshot = async (): Promise<any> => {
    const frames: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(0, 1))))
    return frames[frames.length - 1]
  }
  /** Bring one element into the mounted window with bounded real wheel steps. */
  const wheelUntilMounted = async (selector: string, timeoutMs = 60000): Promise<boolean> => {
    const start = Date.now()
    let dir = -1
    for (;;) {
      const count = await page.locator(selector).count()
      if (count > 0) return true
      if (Date.now() - start > timeoutMs) return false
      const s = await snapshot()
      // normal flow: distBottom large means parked near the oldest edge.
      if (typeof s.scrollTop === 'number' && s.maxScroll > 0 && s.maxScroll - s.scrollTop > 0.92 * s.maxScroll) dir = 1
      await wheel(dir * 300)
    }
  }

  for (const hopBranchId of chain) {
    const hopAnchor = String(branchById.get(hopBranchId).anchorMessageId)
    const parentOfHop =
      branchById.get(hopBranchId).parentBranchId === null ? null : String(branchById.get(hopBranchId).parentBranchId)
    const pillSel = `[data-testid="branch-fork-toggle-${hopAnchor}"], [data-testid="branch-fork-selected-${hopAnchor}"]`
    const ok = await wheelUntilMounted(pillSel)
    if (!ok) throw new Error(`fork pill for anchor ${lab(hopAnchor)} never mounted while walking to the parent route`)
    const pill = page.locator(pillSel).first()
    await pill.click({ timeout: 15000 })
    const list = page.locator(`[data-testid="branch-fork-list-${hopAnchor}"]`)
    await list.waitFor({ state: 'visible', timeout: 15000 })
    const rowSel = `[data-testid="branch-fork-row-${hopAnchor}-${hopBranchId}"]`
    await page.locator(rowSel).waitFor({ state: 'visible', timeout: 15000 })
    await page.locator(rowSel).click({ timeout: 15000 })
    await page.waitForTimeout(1400)
    const state = await snapshot()
    log.push(
      `hop -> ${routeLabel(hopBranchId)} (parent=${parentOfHop === null ? 'r-main' : routeLabel(parentOfHop)}): selectedRoute=${state.selectedRoute} phase=${state.phase} rows=${state.winCount} scrollTop=${state.scrollTop}`
    )
  }

  // ---- 4. Mid reading position around the fork divider (real wheel) ----
  const dividerSel = `[data-divider-key="${forkAnchorId}::${parentRouteBranchId ?? 'main'}"]`
  const dividerMounted = await wheelUntilMounted(dividerSel)
  if (!dividerMounted) throw new Error('fork divider of the residual pair never mounted on the parent route')
  let placed: any = null
  for (let attempt = 0; attempt < 12; attempt++) {
    const s = await snapshot()
    placed = s
    if (s.dividerTop === null) {
      await wheel(-400)
      continue
    }
    const target = s.clientHeight * 0.45
    const delta = s.dividerTop - target
    if (Math.abs(delta) > 8) {
      await wheel(Math.round(delta))
      continue
    }
    // The wheel steps above also move the absolute scroll offset; loop until the
    // divider sits mid-scrollport AND the offset is clearly non-oldest/non-bottom.
    const distBottom = Math.max(0, s.maxScroll - s.scrollTop)
    const ratio = distBottom / Math.max(1, s.maxScroll)
    if (ratio < 0.15 || ratio > 0.85) {
      await wheel(ratio < 0.15 ? -Math.round(s.maxScroll * 0.1) : Math.round(s.maxScroll * 0.1))
      continue
    }
    break
  }
  const p0 = placed
  const awayBottom = Math.max(0, p0.maxScroll - p0.scrollTop)
  const scrollRatio = round(awayBottom / Math.max(1, p0.maxScroll))
  log.push('')
  log.push(
    `parent reading position (${pair.parentRoute}): dividerTop=${p0.dividerTop} clientHeight=${p0.clientHeight} scrollTop=${p0.scrollTop} distBottom=${awayBottom} maxScroll=${p0.maxScroll} ratio=${scrollRatio} phase=${p0.phase} firstInsideRow=${p0.firstInsideRow} topEdgeRow=${p0.topEdgeRow}`
  )
  if (awayBottom <= 0 || scrollRatio < 0.15) {
    throw new Error(`parent reading position is not clearly non-bottom: scrollTop=${p0.scrollTop} ratio=${scrollRatio}`)
  }
  if (scrollRatio > 0.85) {
    throw new Error(`parent reading position is at the oldest boundary: scrollTop=${p0.scrollTop} ratio=${scrollRatio}`)
  }
  log.push(
    `viewport contract: divider at ${p0.dividerTop}px inside a ${p0.clientHeight}px scrollport, scroll offset at ${round(scrollRatio * 100)}% of the achievable range (non-oldest, non-bottom) OK`
  )

  const settledParentPre: any = await snapshot()
  const anchorLabel = settledParentPre.firstInsideRow as string
  if (!anchorLabel) throw new Error('no first-inside row at the parent reading position; cannot pick a stable anchor')
  log.push(`stable anchor candidate: ${anchorLabel} (first fully-inside row at the parent reading position)`)

  await capture('b-parent-mid-viewport')
  const baselineParent: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(600, 400))))
  await writeText('frames-01-baseline-parent.json', JSON.stringify(baselineParent))
  {
    const s = summarizeWindow(`BASELINE ${pair.parentRoute} (headed group, mid viewport)`, baselineParent)
    log.push(s.text)
    flags.push(...s.flags)
  }

  // ---- 5. parent -> child through the real branch UI ----
  const forkPillSel = `[data-testid="branch-fork-toggle-${forkAnchorId}"], [data-testid="branch-fork-selected-${forkAnchorId}"]`
  const preSwitchPill = page.locator(forkPillSel).first()
  await preSwitchPill.waitFor({ state: 'visible', timeout: 15000 })
  const preParent: any = await snapshot()
  log.push(
    `pre-switch (${pair.parentRoute}): scrollTop=${preParent.scrollTop} dividerTop=${preParent.dividerTop} headers=${JSON.stringify((preParent.headers || []).map((h: any) => `${h.seg}/${h.head}@${h.top}h${h.h}`))} cont=${JSON.stringify((preParent.conts || []).map((c: any) => `${c.seg}@${c.top}`))} selected=${preParent.selectedRoute}`
  )
  await preSwitchPill.click({ timeout: 15000 })
  await page.locator(`[data-testid="branch-fork-list-${forkAnchorId}"]`).waitFor({ state: 'visible', timeout: 15000 })
  const childRowSel = `[data-testid="branch-fork-row-${forkAnchorId}-${childBranchId}"]`
  await page.locator(childRowSel).waitFor({ state: 'visible', timeout: 15000 })
  const toChildPromise = page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(800, 500)))) as Promise<any[]>
  await page.locator(childRowSel).click({ timeout: 15000 })
  const toChild: any[] = await toChildPromise
  await writeText('frames-02-parent-to-child.json', JSON.stringify(toChild))
  {
    const s = summarizeWindow(`${pair.parentRoute}->${pair.childRoute} (headed -> residual)`, toChild)
    log.push(s.text)
    flags.push(...s.flags)
  }
  await page.waitForTimeout(1600)
  await capture('c-child-mid-viewport')
  const settledChild: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(600, 400))))
  await writeText('frames-03-settled-child.json', JSON.stringify(settledChild))
  {
    const s = summarizeWindow(`SETTLED ${pair.childRoute} (residual group)`, settledChild)
    log.push(s.text)
    flags.push(...s.flags)
  }
  const childLast = settledChild[settledChild.length - 1]
  const chooseAnchor = (pre: any, post: any): string => {
    if (post.tops && typeof post.tops[anchorLabel] === 'number') return anchorLabel
    const shared = Object.keys(pre.tops || {}).filter(
      (k) => typeof pre.tops[k] === 'number' && post.tops && typeof post.tops[k] === 'number'
    )
    return shared[0] ?? anchorLabel
  }
  const anchorToChild = chooseAnchor(preParent, childLast)
  const d1 = diffSwitch(`${pair.parentRoute} -> ${pair.childRoute}`, preParent, childLast, anchorToChild)
  log.push('')
  log.push(d1.text)
  flags.push(...d1.flags)

  // ---- 6. child -> parent through the real branch UI ----
  const backPill = page.locator(forkPillSel).first()
  await backPill.waitFor({ state: 'visible', timeout: 15000 })
  const preBack: any = await snapshot()
  log.push(
    `pre-switch (${pair.childRoute}): scrollTop=${preBack.scrollTop} dividerTop=${preBack.dividerTop} headers=${JSON.stringify((preBack.headers || []).map((h: any) => `${h.seg}/${h.head}@${h.top}h${h.h}`))} cont=${JSON.stringify((preBack.conts || []).map((c: any) => `${c.seg}@${c.top}`))} selected=${preBack.selectedRoute}`
  )
  await backPill.click({ timeout: 15000 })
  await page.locator(`[data-testid="branch-fork-list-${forkAnchorId}"]`).waitFor({ state: 'visible', timeout: 15000 })
  const parentRowSel = `[data-testid="branch-fork-row-${forkAnchorId}-${parentRouteBranchId ?? 'parent'}"]`
  const parentRowFallback = page.locator(`[data-testid="branch-fork-row-${forkAnchorId}-parent"]`)
  const parentRow = (await page.locator(parentRowSel).count()) > 0 ? page.locator(parentRowSel) : parentRowFallback
  await parentRow.first().waitFor({ state: 'visible', timeout: 15000 })
  const toParentPromise = page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(800, 500)))) as Promise<any[]>
  await parentRow.first().click({ timeout: 15000 })
  const toParent: any[] = await toParentPromise
  await writeText('frames-04-child-to-parent.json', JSON.stringify(toParent))
  {
    const s = summarizeWindow(`${pair.childRoute}->${pair.parentRoute} (residual -> headed)`, toParent)
    log.push(s.text)
    flags.push(...s.flags)
  }
  await page.waitForTimeout(1600)
  await capture('d-back-to-parent')
  const settledParentBack: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(600, 400))))
  await writeText('frames-05-settled-parent-back.json', JSON.stringify(settledParentBack))
  {
    const s = summarizeWindow(`SETTLED ${pair.parentRoute} (back)`, settledParentBack)
    log.push(s.text)
    flags.push(...s.flags)
  }
  const parentBackLast = settledParentBack[settledParentBack.length - 1]
  const anchorToParent = chooseAnchor(preBack, parentBackLast)
  const d2 = diffSwitch(`${pair.childRoute} -> ${pair.parentRoute}`, preBack, parentBackLast, anchorToParent)
  log.push('')
  log.push(d2.text)
  flags.push(...d2.flags)

  // ---- 7. Verdict ----
  const wholeShifts = flags.filter((f) => f.indexOf('WHOLE-COLUMN-SHIFT') >= 0)
  const otherMoves = flags.filter((f) => f.indexOf('ANCHOR-MOVED') >= 0 || f.indexOf('ROW-TOP-MOVED') >= 0)
  const absent = flags.filter((f) => f.indexOf('ANCHOR-ABSENT') >= 0)
  log.push('')
  log.push(
    `SUMMARY: whole-column shifts=${wholeShifts.length}; other anchor/row moves=${otherMoves.length}; anchor-absent switches=${absent.length}; measured anchor deltas=${d1.anchorDelta}px / ${d2.anchorDelta}px`
  )
  for (const f of [...wholeShifts, ...otherMoves, ...absent]) log.push('  - ' + f)
  log.push('')
  log.push(
    strictMode
      ? wholeShifts.length > 0
        ? 'VERDICT: REPRODUCED — the user-reported whole-column vertical displacement appears on a real strict residual-group route switch for the real imported topic.'
        : 'VERDICT: NOT REPRODUCED — a real strict residual group is present, and the stable anchor shows no whole-column viewport-relative displacement on that switch.'
      : `VERDICT: NOT JUDGED for the strict residual shape (absent in this topic). Measured on the closest real structure instead (${pair.kind}): ${wholeShifts.length > 0 ? 'a whole-column shift IS present' : 'no whole-column shift present'}; a verdict about the user-reported residual-group displacement is therefore not established by this run.`
  )
  await writeText('route-default-topic-real-log.txt', log.join('\n'))
}
