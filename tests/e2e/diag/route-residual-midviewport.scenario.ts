/**
 * DIAGNOSTIC scenario (not a regression asset, not a durable E2E spec).
 *
 * Reproduction of "vertical displacement on route switch while reading in the
 * MIDDLE of the message list" for a route-truncated residual message group.
 * Reproduce only — production code is untouched.
 *
 * Fixture topology (simplified, ONE group crossing ONE branch point, no bulk
 * turns, no child-only group, no scroll-to-top paging):
 * - 8 parent/main-route turns (u00/a00 ... u07/a07), all main-owned.
 * - Branch fork created by the supported ChatDb capability on the MAIN-owned
 *   anchor a03 (same Main path as the production fork), + 1 child-owned turn
 *   (uC0/aC0) so the child route has a suffix of its own.
 * - ONE group created on the MAIN route whose catalog order is
 *   [u04 (head/组头), a04, u03, a03]:
 *     * route order on the parent: u03, a03, a04* ... anchor a03 sits between
 *       a03 and u04 => the branch point is in the MIDDLE of the group span;
 *     * head u04 is positioned AFTER the fork anchor, so it is
 *       parent-exclusive (absent from the child's effective route);
 *     * members u03/a03 are inherited by the child.
 *   => parent: headerInRoute=true (headed group, presentation start = u04,
 *      header row hosted right BELOW the fork divider);
 *   => child: headerInRoute=false with routeMemberCount=2 => a TRUE
 *      route-truncated residual group (head lives on the parent route,
 *      members reachable on the child), presentation start = u03, header row
 *      hosted ABOVE the divider.
 *   Both facts are asserted from Main's route qualification blocks
 *   (listSegments route.headerInRoute / route.routeMemberMessageIds) — never
 *   from a renderer window and never from an algorithmic simulation.
 *
 * Viewport contract for the observation (all real gestures):
 * - activate the topic with a real click, then scroll with real wheel input to
 *   a MID-list reading position inside the group: divider (a03) around 45% of
 *   the scrollport, scrollTop clearly non-zero (and above a fraction of the
 *   achievable range), first visible row is neither the group head u04 nor the
 *   list's first row u00. No scroll-to-top, no paging-to-anchor.
 * - switch parent -> child and child -> parent through the REAL branch UI
 *   (the fork divider pill + its route list), exactly the divider explicit
 *   continuation intent the product exposes.
 *
 * Per-rAF sampling (>=500ms per window) records, per frame:
 *   t, scrollTop/scrollHeight/clientHeight, #messages data-viewport-phase,
 *   selected route (store), displayed-route hint (mounted child-only /
 *   parent-tail rows), group headers (segment/head id, top, height, count),
 *   rail continuations, rail rules, fork divider top, per-row tops of every
 *   tracked message, window first/last, top-edge row, first fully-inside row.
 *
 * Analysis separates the two motions the user asked to keep apart:
 *   topDelta   = viewport-relative row top change (what the eye sees),
 *   scrollDelta = scrollTop change (legitimate window reposition / paging),
 *   absDelta   = (top + scrollTop) change = layout shift in CONTENT space,
 *                i.e. the part of the visible jump that scrollTop cannot
 *                explain. Large legitimate scroll is reported separately and
 *                never counted as a displacement.
 *
 * Artifacts contain anonymized id suffixes and geometry only — never message
 * bodies, never credentials.
 */
import type { ObservationContext } from '../../../scripts/ui-observe/scenario'

const invoke = (fnSrc: string, argLiteral = 'undefined') => `(${fnSrc})(${argLiteral})`
const lit = (v: unknown) => JSON.stringify(v)
const suffix = (id: string | null | undefined) => (id === null || id === undefined ? null : String(id).slice(-8))

// ---------------------------------------------------------------------------
// Fixture seed — real ChatDb capability through the typed preload surface in a
// real isolated profile (same Main path the production fork/group writes use).
// ---------------------------------------------------------------------------
const FN_SEED_SRC = `function () {
  return (async () => {
    const stamp = '2026-01-01T00:00:00.000Z'
    const topicId = 'diag-mid-resid'
    const segId = topicId + '-seg'
    const st = window.store.getState()
    const assistantId = (st.assistants && st.assistants.assistants && st.assistants.assistants[0] && st.assistants.assistants[0].id) || null
    if (!assistantId) return { ok: false, err: 'no assistant' }
    window.store.dispatch({ type: 'assistants/addTopic', payload: { assistantId, topic: { id: topicId, assistantId, name: 'diag mid residual', createdAt: stamp, updatedAt: stamp } } })
    const api = window.api.chatDb
    const ensured = await api.ensureTopic({ topicId, assistantId, name: 'diag mid residual' })
    if (!ensured || ensured.ok !== true) return { ok: false, err: 'ensureTopic ' + JSON.stringify(ensured) }
    const put = async (key, role, askKey, branchId) => {
      const id = topicId + '-' + key
      const message = { id, topicId, role, content: 'diag-' + key, status: 'success', createdAt: stamp, updatedAt: stamp }
      if (askKey) message.askId = topicId + '-' + askKey
      const blocks = [{ id: id + '-main', messageId: id, type: 'main_text', content: 'diag-' + key, status: 'success', createdAt: stamp }]
      const req = { topicId, message, blocks }
      if (branchId) req.branchId = branchId
      const res = await api.appendMessage(req)
      if (!res || res.ok !== true) return 'append ' + key + ': ' + JSON.stringify(res)
      return null
    }
    for (let i = 0; i < 8; i++) {
      const p = String(i).padStart(2, '0')
      let e = await put('u' + p, 'user', null, null)
      if (e) return { ok: false, err: e }
      e = await put('a' + p, 'assistant', 'u' + p, null)
      if (e) return { ok: false, err: e }
    }
    const anchorId = topicId + '-a03'
    const fork = await api.createBranch({ topicId, anchorMessageId: anchorId, name: 'diag-mid-child' })
    if (!fork || fork.ok !== true) return { ok: false, err: 'createBranch ' + JSON.stringify(fork) }
    const childId = fork.value.branch.id
    let ec = await put('uC0', 'user', null, childId)
    if (ec) return { ok: false, err: ec }
    ec = await put('aC0', 'assistant', 'uC0', childId)
    if (ec) return { ok: false, err: ec }
    // Head FIRST (persisted header_message_id = messageIds[0]) on purpose: the
    // head u04 sits AFTER the fork anchor, the remaining members u03/a03 sit
    // BEFORE it, so the child inherits only the pre-fork part of the group.
    const members = ['u04', 'a04', 'u03', 'a03'].map((k) => topicId + '-' + k)
    const seg = await api.upsertSegment({ segmentId: segId, topicId, name: 'diag mid group', messageIds: members, branchId: null })
    if (!seg || seg.ok !== true) return { ok: false, err: 'upsertSegment ' + JSON.stringify(seg) }
    const qParent = await api.listSegments({ topicId, branchId: null })
    const qChild = await api.listSegments({ topicId, branchId: childId })
    const pick = (res) => {
      const wires = res && res.value ? res.value : res
      const w = (wires || []).find((s) => s.id === segId)
      if (!w) return null
      return {
        headSuffix: w.headerMessageId ? String(w.headerMessageId).slice(-8) : null,
        headerInRoute: w.route ? w.route.headerInRoute : null,
        headerOwnedByRoute: w.route ? w.route.headerOwnedByRoute : null,
        ownerBranch: w.ownerBranchId === null || w.ownerBranchId === undefined ? 'main' : String(w.ownerBranchId).slice(-6),
        routeCount: w.route ? w.route.routeMemberMessageIds.length : null,
        routeSuffixes: w.route ? w.route.routeMemberMessageIds.map((m) => String(m).slice(-8)) : null,
        catalogSuffixes: (w.messageIds || []).map((m) => String(m).slice(-8))
      }
    }
    const rowTag = { u00: 1, a00: 1, u01: 1, a01: 1, u02: 1, a02: 1, u03: 1, a03: 1, u04: 1, a04: 1, u05: 1, a05: 1, u06: 1, a06: 1, u07: 1, a07: 1 }
    const ids = Object.keys(rowTag).map((k) => topicId + '-' + k)
    return {
      ok: true,
      topicId, childId, segId, anchorId,
      headId: topicId + '-u04',
      reachId: topicId + '-u03',
      firstListId: topicId + '-u00',
      trackIds: ids,
      qParent: pick(qParent),
      qChild: pick(qChild)
    }
  })()
}`

// ---------------------------------------------------------------------------
// Per-frame sampler (runs inside the renderer, one record per animation frame).
// spec = { topicId, durationMs, maxFrames, trackIds, dividerAnchorId, headId }
// ---------------------------------------------------------------------------
const FN_SAMPLE_SRC = `function (spec) {
  return new Promise((resolve) => {
    const out = []
    const scroller = document.getElementById('messages')
    const cTop = () => { try { return scroller.getBoundingClientRect().top } catch { return 0 } }
    const esc = (v) => (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(v) : v
    const sfx = (v) => (v === null || v === undefined) ? null : String(v).slice(-8)
    const rel = (r) => Math.round((r.top - cTop()) * 10) / 10
    const rowEl = (id) => { try { return document.querySelector('[id="message-' + esc(id) + '"][data-message-id="' + esc(id) + '"]') } catch { return null } }
    const rowTop = (id) => { const el = rowEl(id); if (!el) return null; return rel(el.getBoundingClientRect()) }
    const start = performance.now()
    const stamp = () => {
      const t = Math.round(performance.now() - start)
       // Geometry-ordered (the flow is normal-flow oldest-first, so geometry
       // order is the source of truth): the top-edge row straddles the scrollport top and the
      // first fully-inside row is the visually highest row starting inside it.
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]'))
      const base = cTop()
      let topEdgeRow = null
      let firstInsideRow = null
      let firstInsideTop = Number.POSITIVE_INFINITY
      for (const r of rows) {
        const rr = r.getBoundingClientRect()
        if (rr.bottom > base + 0.5 && rr.top < base + 0.5) topEdgeRow = sfx(r.getAttribute('data-message-id'))
        if (rr.top >= base - 0.5 && rr.top < firstInsideTop) {
          firstInsideTop = rr.top
          firstInsideRow = sfx(r.getAttribute('data-message-id'))
        }
      }
      const headers = Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]')).map((el) => {
        const r = el.getBoundingClientRect()
        const countEl = el.querySelector('[data-testid="topic-segment-count"]')
        return {
          seg: sfx(el.getAttribute('data-segment-id')),
          headAttr: sfx(el.getAttribute('data-segment-header')),
          top: rel(r), h: Math.round(r.height * 10) / 10,
          count: countEl ? countEl.textContent : '',
          first: el.getAttribute('data-segment-first'),
          last: el.getAttribute('data-segment-last')
        }
      })
      const conts = Array.from(document.querySelectorAll('[data-testid="topic-segment-rail-continuation"]')).map((el) => ({
        seg: sfx(el.getAttribute('data-segment-id')),
        top: rel(el.getBoundingClientRect())
      }))
      const rails = Array.from(document.querySelectorAll('[data-testid="topic-segment-rule"]')).map((el) => {
        const r = el.getBoundingClientRect()
        return { seg: sfx(el.getAttribute('data-segment-id')), top: rel(r), h: Math.round(r.height * 10) / 10 }
      })
      const divEl = document.querySelector('[data-divider-anchor="' + esc(spec.dividerAnchorId) + '"]') ||
        document.querySelector('[data-divider-anchor]')
      let phase = null
      let selected = null
      try { phase = scroller.getAttribute('data-viewport-phase') } catch {}
      try {
        const s = window.store.getState()
        const bids = (s.topicBranch && s.topicBranch.activeBranchIdByTopic) || {}
        const b = bids[spec.topicId]
        selected = spec.topicId.slice(-6) + '::' + (b === null || b === undefined ? 'main' : String(b).slice(-6))
      } catch {}
      const ids = rows.map((r) => r.getAttribute('data-message-id'))
      const joined = ids.join('|')
      const domRoute = joined.indexOf('-uC0') >= 0 ? 'child' : (joined.indexOf('-u04') >= 0 ? 'main' : 'shared')
      const tops = {}
      for (const id of (spec.trackIds || [])) {
        const key = String(id).slice(-3)
        tops[key] = rowTop(id)
      }
      out.push({
        t,
        scrollTop: scroller ? Math.round(scroller.scrollTop * 10) / 10 : -1,
        scrollHeight: scroller ? scroller.scrollHeight : -1,
        clientHeight: scroller ? scroller.clientHeight : -1,
        maxScroll: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : -1,
        phase, selected, domRoute,
        headers, conts, rails,
        dividerTop: divEl ? rel(divEl.getBoundingClientRect()) : null,
        tops,
        winCount: ids.length,
        winFirst: sfx(ids[0]),
        winLast: sfx(ids[ids.length - 1]),
        topEdgeRow, firstInsideRow
      })
      const elapsed = performance.now() - start
      if ((elapsed >= spec.durationMs && out.length >= 2) || out.length >= spec.maxFrames) resolve(out)
      else requestAnimationFrame(stamp)
    }
    requestAnimationFrame(stamp)
  })
}`

// ---------------------------------------------------------------------------
// Node-side helpers
// ---------------------------------------------------------------------------
const FN_MSG_COUNT_SRC = `function () { return document.querySelectorAll('#messages [data-message-id]').length }`
const FN_HEADER_COUNT_SRC = `function () { return document.querySelectorAll('[data-testid="topic-segment-group"]').length }`

async function poll(page: any, expr: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await page.evaluate(expr)) return
    if (Date.now() - start > timeoutMs) throw new Error(`poll timeout: ${label}`)
    await page.waitForTimeout(150)
  }
}

const round = (v: number) => Math.round(v * 10) / 10

interface RowDelta {
  key: string
  mountedFrames: number
  topFirst: number | null
  topLast: number | null
  topDelta: number | null
  scrollDelta: number | null
  absDelta: number | null
  topExcursion: number | null
  absExcursion: number | null
}

/** Content-space coordinate stability per tracked row: top + scrollTop. */
function rowDeltas(frames: any[], keys: string[]): RowDelta[] {
  const out: RowDelta[] = []
  for (const fullKey of keys) {
    // Frames key their per-row map by the last 3 characters of the message id.
    const key = String(fullKey).slice(-3)
    const sample = (f: any): { top: number; scroll: number } | null => {
      const top = f.tops ? f.tops[key] : null
      if (typeof top !== 'number' || typeof f.scrollTop !== 'number') return null
      return { top, scroll: f.scrollTop }
    }
    const first = sample(frames[0])
    const last = sample(frames[frames.length - 1])
    const tops: number[] = []
    const abs: number[] = []
    for (const f of frames) {
      const s = sample(f)
      if (!s) continue
      tops.push(s.top)
      abs.push(s.top + s.scroll)
    }
    const scrollDelta =
      typeof frames[0].scrollTop === 'number' && typeof frames[frames.length - 1].scrollTop === 'number'
        ? round(frames[frames.length - 1].scrollTop - frames[0].scrollTop)
        : null
    if (tops.length < 2) {
      out.push({
        key,
        mountedFrames: tops.length,
        topFirst: first ? first.top : null,
        topLast: last ? last.top : null,
        topDelta: null,
        scrollDelta,
        absDelta: null,
        topExcursion: null,
        absExcursion: null
      })
      continue
    }
    out.push({
      key,
      mountedFrames: tops.length,
      topFirst: first ? first.top : null,
      topLast: last ? last.top : null,
      topDelta: first && last ? round(last.top - first.top) : null,
      scrollDelta,
      absDelta: first && last ? round(last.top + last.scroll - (first.top + first.scroll)) : null,
      topExcursion: round(Math.max(...tops) - Math.min(...tops)),
      absExcursion: round(Math.max(...abs) - Math.min(...abs))
    })
  }
  return out
}

function chromeSignature(frames: any[]): string {
  const headers = new Set<string>()
  const heads = new Set<string>()
  const conts = new Set<string>()
  const rails = new Set<string>()
  for (const f of frames) {
    headers.add(String((f.headers || []).length))
    for (const h of f.headers || []) heads.add(String(h.headAttr) + '@' + String(h.seg) + ':' + String(h.count))
    conts.add(String((f.conts || []).length))
    rails.add(String((f.rails || []).length) + ':' + String((f.rails || []).map((r: any) => r.seg).join(',')))
  }
  return [
    `headerRows=${[...headers].join('/')}`,
    `headerIdentities=${[...heads].join(' | ')}`,
    `continuations=${[...conts].join('/')}`,
    `rails=${[...rails].join('/')}`
  ].join(' ')
}

function setOf(frames: any[], pick: (f: any) => unknown): string {
  return [...new Set(frames.map((f) => String(pick(f))))].join('/')
}

/**
 * Same-frame spacing of every tracked row (and of the fork divider) against one
 * reference row. Frame-local subtraction cancels the route's content-origin
 * shift (the flow is normal-flow and the mounted window changes), so a
 * spacing change >= 2px is a real insertion/removal between those two rows.
 */
function gapMatrix(frames: any[], keys: string[], refKey: string): { text: string; flags: string[] } {
  const flags: string[] = []
  const rows: string[] = []
  const subjects: { name: string; pick: (f: any) => number | null }[] = [
    { name: 'divider', pick: (f) => (typeof f.dividerTop === 'number' ? f.dividerTop : null) },
    ...keys.map((full) => {
      const key = String(full).slice(-3)
      return { name: key, pick: (f: any) => (f.tops && typeof f.tops[key] === 'number' ? f.tops[key] : null) }
    })
  ]
  for (const subject of subjects) {
    if (subject.name === refKey) continue
    const gaps: number[] = []
    let prev: number | null = null
    let maxStep = 0
    for (const f of frames) {
      const value = subject.pick(f)
      const ref = f.tops && typeof f.tops[refKey] === 'number' ? f.tops[refKey] : null
      if (typeof value !== 'number' || typeof ref !== 'number') {
        prev = null
        continue
      }
      const gap = round(value - ref)
      if (prev !== null) maxStep = Math.max(maxStep, Math.abs(gap - prev))
      prev = gap
      gaps.push(gap)
    }
    if (gaps.length < 2) continue
    const first = gaps[0]
    const last = gaps[gaps.length - 1]
    const ex = round(Math.max(...gaps) - Math.min(...gaps))
    rows.push(`${subject.name}: gap=${first} -> ${last} excursion=${ex} maxPerFrameStep=${round(maxStep)}`)
    if (ex >= 2) flags.push(`${subject.name}(gap ${first} -> ${last}, ex=${ex}px, step=${round(maxStep)}px)`)
  }
  return {
    text: [
      `spacing vs ${refKey} (same-frame row top minus reference row top; cancels content-origin shift):`,
      ...rows.map((r) => '  ' + r)
    ].join('\n'),
    flags
  }
}

function summarizeWindow(name: string, frames: any[], keys: string[]): { text: string; flags: string[] } {
  const flags: string[] = []
  const scrolls = frames.map((f) => (typeof f.scrollTop === 'number' ? f.scrollTop : NaN))
  const scrollFirst = scrolls[0]
  const scrollLast = scrolls[scrolls.length - 1]
  const scrollEx = round(Math.max(...scrolls) - Math.min(...scrolls))
  const lines: string[] = []
  lines.push(`== ${name} (frames=${frames.length}, span=${frames[frames.length - 1].t - frames[0].t}ms)`)
  lines.push(
    `scrollTop first=${scrollFirst} last=${scrollLast} delta=${round(scrollLast - scrollFirst)} excursion=${scrollEx} maxScroll=${frames[0].maxScroll} clientHeight=${frames[0].clientHeight}`
  )
  lines.push(
    `phase=${setOf(frames, (f) => f.phase)} selected=${setOf(frames, (f) => f.selected)} domRoute=${setOf(frames, (f) => f.domRoute)}`
  )
  lines.push(
    `window=${setOf(frames, (f) => f.winCount)} first=${setOf(frames, (f) => f.winFirst)} last=${setOf(frames, (f) => f.winLast)}`
  )
  lines.push(
    `firstVisibleRow=${setOf(frames, (f) => f.firstInsideRow)} topEdgeRow=${setOf(frames, (f) => f.topEdgeRow)}`
  )
  lines.push(`dividerTop=${setOf(frames, (f) => f.dividerTop)}`)
  lines.push(`headerTop=${setOf(frames, (f) => (f.headers || []).map((h: any) => h.top).join(','))}`)
  lines.push(`continuationTop=${setOf(frames, (f) => (f.conts || []).map((c: any) => c.top).join(','))}`)
  lines.push(`chrome: ${chromeSignature(frames)}`)
  lines.push(
    'row matrix (key | mountedFrames | topFirst -> topLast | topDelta | absDelta(content) | topExcursion | absExcursion):'
  )
  const deltas = rowDeltas(frames, keys)
  const layoutRows: string[] = []
  const movedRows: string[] = []
  const absentRows: string[] = []
  for (const d of deltas) {
    lines.push(
      `  ${d.key} | n=${d.mountedFrames} | ${d.topFirst} -> ${d.topLast} | topDelta=${d.topDelta} | absDelta=${d.absDelta} | topEx=${d.topExcursion} | absEx=${d.absExcursion}`
    )
    if (d.mountedFrames === 0) absentRows.push(d.key)
    if (d.absExcursion !== null && d.absExcursion >= 2) {
      layoutRows.push(`${d.key}(contentShift=${d.absExcursion}px,topEx=${d.topExcursion},topDelta=${d.topDelta})`)
    }
    if (d.topExcursion !== null && d.topExcursion >= 2) movedRows.push(`${d.key}(topEx=${d.topExcursion})`)
  }
  if (absentRows.length > 0) lines.push(`  rows absent in this window: ${absentRows.join(',')}`)
  if (layoutRows.length > 0) flags.push(`${name}: ROW-SPACING-FLAGGED ${layoutRows.join(' ')}`)
  if (movedRows.length > 0) flags.push(`${name}: VISIBLE-TOP-MOVED ${movedRows.join(' ')} scrollEx=${scrollEx}`)
  // Route switches replace the mounted window AND the content
  // origin (normal flow), so raw content coordinates are not comparable
  // across routes. Spacing between rows in the SAME frame cancels that origin
  // shift: a spacing change of >= 2px is a layout insertion/removal between
  // those two rows (e.g. the 32px group header row relocating across the fork
  // divider), which is exactly the displacement scrollTop cannot explain.
  const gaps = gapMatrix(frames, keys, 'a02')
  lines.push(gaps.text)
  if (gaps.flags.length > 0) flags.push(`${name}: SPACING-SHIFT ${gaps.flags.join(' ')}`)
  return { text: lines.join('\n'), flags }
}

export default async function observe({ page, capture, writeText }: ObservationContext) {
  const log: string[] = []
  const flags: string[] = []

  const seed: any = await page.evaluate(invoke(FN_SEED_SRC))
  if (!seed || seed.ok !== true) throw new Error('fixture seed failed: ' + JSON.stringify(seed))
  const { topicId, childId, segId, anchorId, headId, reachId, firstListId, trackIds } = seed
  log.push(
    `fixture: topic=...${String(topicId).slice(-6)} child=...${suffix(childId)} seg=...${suffix(segId)} anchor=...${suffix(anchorId)} head=...${suffix(headId)} reach=...${suffix(reachId)} firstRow=...${suffix(firstListId)}`
  )
  log.push(`Main qualification parent route: ${JSON.stringify(seed.qParent)}`)
  log.push(`Main qualification child route:  ${JSON.stringify(seed.qChild)}`)

  const qp = seed.qParent
  const qc = seed.qChild
  if (!qp || qp.headerInRoute !== true)
    throw new Error('fixture is not a headed group on the parent route: ' + JSON.stringify(qp))
  if (!qp || qp.routeCount !== 4) throw new Error('parent route member count is not 4: ' + JSON.stringify(qp))
  if (!qc || qc.headerInRoute !== false || !(qc.routeCount > 0)) {
    throw new Error(
      'fixture is not a route-truncated residual on the child route (need headerInRoute=false + routeCount>0): ' +
        JSON.stringify(qc)
    )
  }
  if (qc.routeCount !== 2) throw new Error('child residual member count is not 2: ' + JSON.stringify(qc))
  log.push(
    'fixture PROOF: same group headed on the parent (4 route members, head in route) and a route-truncated residual on the child (head missing, 2 route members reachable) — one group crossing one branch point, no child-only group'
  )

  const spec = (durationMs: number) => ({
    topicId,
    durationMs,
    maxFrames: 400,
    trackIds,
    dividerAnchorId: anchorId,
    headId
  })

  // ---- activate the topic with a real click ----
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  const itemCount = await page.locator(`[data-testid="topic-item"]`).count()
  log.push(`sidebar topic items visible=${itemCount}`)
  await item.waitFor({ state: 'visible', timeout: 20000 })
  await item.click()
  await page.waitForTimeout(1500)
  await capture('a0-after-topic-click')
  const FN_VIEW_INFO_SRC = `function () {
    let activeTopic = null
    try { const s = window.store.getState(); activeTopic = (s.runtime && s.runtime.chat && s.runtime.chat.activeTopic && s.runtime.chat.activeTopic.id) || null } catch {}
    return {
      activeTopic,
      messages: document.querySelectorAll('#messages [data-message-id]').length,
      headers: document.querySelectorAll('[data-testid="topic-segment-group"]').length,
      hasScroller: !!document.getElementById('messages'),
      topicItems: document.querySelectorAll('[data-testid="topic-item"]').length
    }
  }`
  log.push(`after topic click: ${JSON.stringify(await page.evaluate(invoke(FN_VIEW_INFO_SRC)))}`)
  await poll(page, invoke(FN_MSG_COUNT_SRC) + ' >= 1', 40000, 'parent messages mounted')
  await poll(page, invoke(FN_HEADER_COUNT_SRC) + ' >= 1', 30000, 'parent group header mounted')
  await page.waitForTimeout(600)
  log.push(
    `parent DOM messages=${await page.evaluate(invoke(FN_MSG_COUNT_SRC))} headers=${await page.evaluate(invoke(FN_HEADER_COUNT_SRC))}`
  )

  // ---- place the viewport at a MID-list reading position (real wheel input) ----
  await page.locator('#messages').hover()
  let placed: any = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const snap: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit({ ...spec(0), durationMs: 0, maxFrames: 1 })))
    const f = snap[0]
    placed = f
    if (f.dividerTop === null) {
      // Divider row not mounted yet: walk the window up in bounded wheel steps
      // (never to the top; the loop stops the moment the row appears).
      await page.mouse.wheel(0, -400)
      await page.waitForTimeout(400)
      continue
    }
    const target = f.clientHeight * 0.45
    const delta = f.dividerTop - target
    if (Math.abs(delta) > 8) {
      await page.mouse.wheel(0, Math.round(delta))
      await page.waitForTimeout(350)
      continue
    }
    break
  }
  if (!placed) throw new Error('could not measure the parent viewport for placement')
  const finalSnap: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit({ ...spec(0), durationMs: 0, maxFrames: 1 })))
  const p0 = finalSnap[0]
  const distBottom = Math.max(0, p0.maxScroll - p0.scrollTop)
  log.push(
    `parent reading position: scrollTop=${p0.scrollTop} (normal flow: maxScroll = physical bottom, distBottom = scrolled away from it) distBottom=${distBottom} maxScroll=${p0.maxScroll} ratio=${round(distBottom / Math.max(1, p0.maxScroll))} dividerTop=${p0.dividerTop} clientHeight=${p0.clientHeight} topEdgeRow=...${p0.topEdgeRow} firstVisibleRow=...${p0.firstInsideRow} head row=...${suffix(headId)}`
  )
  const firstVisible = p0.firstInsideRow === suffix(headId) ? 'HEAD' : p0.firstInsideRow
  if (distBottom <= 0 || distBottom < 0.15 * p0.maxScroll) {
    throw new Error(
      `parent reading position is not clearly away from bottom: scrollTop=${p0.scrollTop} maxScroll=${p0.maxScroll}`
    )
  }
  if (p0.firstInsideRow === suffix(headId))
    throw new Error('first visible row is the group head; not a mid-group reading position')
  if (p0.firstInsideRow === suffix(firstListId))
    throw new Error('first visible row is the list first row; not a mid-group reading position')
  log.push(
    `placement conditions: distBottom=${distBottom} > 0.15*maxScroll OK, first visible row (${firstVisible}) is neither the group head nor the list first row OK, divider top=${p0.dividerTop} inside the scrollport OK`
  )

  await capture('a-parent-mid-viewport')
  const baselineParent: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(600))))
  await writeText('frames-00-baseline-parent.json', JSON.stringify(baselineParent))
  {
    const s = summarizeWindow('BASELINE parent (headed group, mid viewport)', baselineParent, trackIds)
    log.push(s.text)
    flags.push(...s.flags)
  }

  // ---- parent -> child through the REAL branch UI ----
  const forkPill = page.locator(`[data-testid="branch-fork-toggle-${anchorId}"]`)
  await forkPill.scrollIntoViewIfNeeded()
  await forkPill.waitFor({ state: 'visible', timeout: 15000 })
  const beforeSwitchSnap: any[] = await page.evaluate(
    invoke(FN_SAMPLE_SRC, lit({ ...spec(0), durationMs: 0, maxFrames: 1 }))
  )
  log.push(
    `pre-switch (parent): scrollTop=${beforeSwitchSnap[0].scrollTop} dividerTop=${beforeSwitchSnap[0].dividerTop} headerTop=${JSON.stringify((beforeSwitchSnap[0].headers || []).map((h: any) => h.top))} selected=${beforeSwitchSnap[0].selected} domRoute=${beforeSwitchSnap[0].domRoute}`
  )
  await forkPill.click()
  await page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).waitFor({ state: 'visible', timeout: 10000 })
  const childRow = page.locator(`[data-testid="branch-fork-row-${anchorId}-${childId}"]`)
  await childRow.waitFor({ state: 'visible', timeout: 10000 })
  const toChildPromise = page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(800)))) as Promise<any[]>
  await childRow.click({ timeout: 10000 })
  const toChild: any[] = await toChildPromise
  await writeText('frames-01-parent-to-child.json', JSON.stringify(toChild))
  {
    const s = summarizeWindow('PARENT->CHILD (headed -> route-truncated residual)', toChild, trackIds)
    log.push(s.text)
    flags.push(...s.flags)
  }
  await page.waitForTimeout(1500)
  await capture('b-child-mid-viewport')
  log.push(
    `child DOM messages=${await page.evaluate(invoke(FN_MSG_COUNT_SRC))} headers=${await page.evaluate(invoke(FN_HEADER_COUNT_SRC))}`
  )
  const settledChild: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(600))))
  await writeText('frames-02-settled-child.json', JSON.stringify(settledChild))
  {
    const s = summarizeWindow('SETTLED child (residual group)', settledChild, trackIds)
    log.push(s.text)
    flags.push(...s.flags)
  }

  // ---- child -> parent through the REAL branch UI ----
  const backPill = page
    .locator(`[data-testid="branch-fork-selected-${anchorId}"], [data-testid="branch-fork-toggle-${anchorId}"]`)
    .first()
  await backPill.scrollIntoViewIfNeeded()
  await backPill.waitFor({ state: 'visible', timeout: 15000 })
  const beforeBackSnap: any[] = await page.evaluate(
    invoke(FN_SAMPLE_SRC, lit({ ...spec(0), durationMs: 0, maxFrames: 1 }))
  )
  log.push(
    `pre-switch (child): scrollTop=${beforeBackSnap[0].scrollTop} dividerTop=${beforeBackSnap[0].dividerTop} headerTop=${JSON.stringify((beforeBackSnap[0].headers || []).map((h: any) => h.top))} contTop=${JSON.stringify((beforeBackSnap[0].conts || []).map((c: any) => c.top))} selected=${beforeBackSnap[0].selected} domRoute=${beforeBackSnap[0].domRoute}`
  )
  await backPill.click()
  await page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).waitFor({ state: 'visible', timeout: 10000 })
  const parentRow = page.locator(`[data-testid="branch-fork-row-${anchorId}-parent"]`)
  await parentRow.waitFor({ state: 'visible', timeout: 10000 })
  const toParentPromise = page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(800)))) as Promise<any[]>
  await parentRow.click({ timeout: 10000 })
  const toParent: any[] = await toParentPromise
  await writeText('frames-03-child-to-parent.json', JSON.stringify(toParent))
  {
    const s = summarizeWindow('CHILD->PARENT (residual -> headed)', toParent, trackIds)
    log.push(s.text)
    flags.push(...s.flags)
  }
  await page.waitForTimeout(1500)
  await capture('c-back-to-parent')
  const settledParent: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec(600))))
  await writeText('frames-04-settled-parent.json', JSON.stringify(settledParent))
  {
    const s = summarizeWindow('SETTLED parent (back)', settledParent, trackIds)
    log.push(s.text)
    flags.push(...s.flags)
  }

  const spacingFlags = flags.filter((f) => f.indexOf('SPACING-SHIFT') >= 0)

  const movedFlags = flags.filter((f) => f.indexOf('VISIBLE-TOP-MOVED') >= 0)
  log.push('')
  log.push(
    `SUMMARY: same-frame spacing-shift windows=${spacingFlags.length}; visible-top-moved windows=${movedFlags.length}`
  )
  if (spacingFlags.length > 0) {
    log.push('SPACING-SHIFT (rows changed their spacing while the scroll offset explains nothing):')
    for (const f of spacingFlags) log.push('  - ' + f)
  }
  if (movedFlags.length > 0) {
    log.push('VISIBLE-TOP-MOVED (viewport-relative row tops moved; compare with the scroll excursion above):')
    for (const f of movedFlags) log.push('  - ' + f)
  }
  await writeText(
    'route-residual-midviewport-log.txt',
    [
      ...log,
      '',
      `VERDICT: ${spacingFlags.length === 0 ? 'no same-frame spacing displacement detected' : 'same-frame spacing displacement detected — see SPACING-SHIFT rows above'}`
    ].join('\n')
  )
}
