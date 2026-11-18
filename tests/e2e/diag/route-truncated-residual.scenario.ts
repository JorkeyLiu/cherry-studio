/**
 * DIAGNOSTIC scenario (not a regression asset): true route-truncated residual group.
 *
 * Topology guarantee (real business topology, no child-only group, no pure
 * window-clipping simulation):
 * - 20 main-route turns (u00/a00..u19/a19, all main-owned).
 * - Child branch forked at main-owned anchor a10 via supported ChatDb
 *   capability (same Main path as production fork).
 * - 2 child-owned suffix turns (uc0/ac0, uc1/ac1).
 * - ONE segment created on the MAIN route whose head is parent-exclusive
 *   (u15, main tail after the anchor, never in the child effective route)
 *   and whose remaining members are shared-prefix turns (u05/a05..u07/a07)
 *   inherited by the child. So on the parent the group is headed
 *   (headerInRoute=true); on the child it is a route-truncated residual
 *   group (headerInRoute=false, routeMemberCount=6 > 0, stable start =
 *   first reachable u05). This is NOT a child-only group (head is main,
 *   members are main-owned) and NOT window clipping (qualification comes
 *   from Main listSegments route blocks, independent of the mounted window).
 *
 * Flow: activate topic (real click) -> parent baseline sampling -> real
 * fork-UI parent->child with per-frame sampling -> settled child sampling ->
 * real fork-UI child->parent with sampling -> scroll sampling. Every frame
 * records: segment headers (id suffix/top/h/count), rail continuations,
 * rails, scrollTop, viewport phase, route key, anchor row tops (u05 stable
 * start, u15 parent-exclusive head), and header-minus-anchor relative offset.
 * Verdict FLAGs only on relative-offset excursion (>=30px returning within
 * 8px while scrollTop moves <10px) so a large-scrollTop window re-anchor is
 * never misjudged as jitter.
 * Artifacts record synthetic ids (suffixes) + geometry only, never bodies.
 */
import type { ObservationContext } from '../../../scripts/ui-observe/scenario'

const invoke = (fnSrc: string, argLiteral = 'undefined') => `(${fnSrc})(${argLiteral})`
const lit = (v: unknown) => JSON.stringify(v)

const FN_SEED_SRC = `function () {
  return (async () => {
    const stamp = '2026-01-01T00:00:00.000Z'
    const topicId = 'diag-trunc-resid'
    const segId = topicId + '-seg-span'
    const st = window.store.getState()
    const assistantId = (st.assistants && st.assistants.assistants && st.assistants.assistants[0] && st.assistants.assistants[0].id) || null
    if (!assistantId) return { ok: false, err: 'no assistant' }
    window.store.dispatch({ type: 'assistants/addTopic', payload: { assistantId, topic: { id: topicId, assistantId, name: 'diag trunc residual', createdAt: stamp, updatedAt: stamp } } })
    const api = window.api.chatDb
    const ensured = await api.ensureTopic({ topicId, assistantId, name: 'diag trunc residual' })
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
    for (let i = 0; i < 20; i++) {
      const p = String(i).padStart(2, '0')
      let e = await put('u' + p, 'user', null, null)
      if (e) return { ok: false, err: e }
      e = await put('a' + p, 'assistant', 'u' + p, null)
      if (e) return { ok: false, err: e }
    }
    const anchorId = topicId + '-a10'
    const fork = await api.createBranch({ topicId, anchorMessageId: anchorId, name: 'diag-child' })
    if (!fork || fork.ok !== true) return { ok: false, err: 'createBranch ' + JSON.stringify(fork) }
    const childId = fork.value.branch.id
    for (let i = 0; i < 2; i++) {
      const p = 'c' + i
      let e = await put('u' + p, 'user', null, childId)
      if (e) return { ok: false, err: e }
      e = await put('a' + p, 'assistant', 'u' + p, childId)
      if (e) return { ok: false, err: e }
    }
    // Head FIRST (= u15, parent-exclusive tail) so the persisted head lives
    // outside the child effective route; prefix members (u05..u07 turns) are
    // inherited by the child -> true truncated residual on the child route.
    const members = ['u15','a15','u05','a05','u06','a06','u07','a07'].map((k) => topicId + '-' + k)
    const seg = await api.upsertSegment({ segmentId: segId, topicId, name: 'diag span', messageIds: members })
    if (!seg || seg.ok !== true) return { ok: false, err: 'upsertSegment ' + JSON.stringify(seg) }
    const headId = topicId + '-u15'
    const firstReach = topicId + '-u05'
    const qParent = await api.listSegments({ topicId, branchId: null })
    const qChild = await api.listSegments({ topicId, branchId: childId })
    const pick = (wires) => {
      const w = (wires && wires.value ? wires.value : wires).find((s) => s.id === segId)
      if (!w) return null
      return {
        headerSuffix: w.headerMessageId ? String(w.headerMessageId).slice(-8) : null,
        headerInRoute: w.route ? w.route.headerInRoute : null,
        headerOwned: w.route ? w.route.headerOwnedByRoute : null,
        ownerBranch: w.ownerBranchId === null ? 'main' : String(w.ownerBranchId).slice(-6),
        routeCount: w.route ? w.route.routeMemberMessageIds.length : null,
        routeSuffixes: w.route ? w.route.routeMemberMessageIds.map((m) => String(m).slice(-8)) : null
      }
    }
    return { ok: true, topicId, childId, segId, anchorId, headId, firstReach, qParent: pick(qParent), qChild: pick(qChild) }
  })()
}`

const FN_SAMPLE_SRC = `function (spec) {
  return new Promise((resolve) => {
    const out = []
    const scroller = document.getElementById('messages')
    const rowTop = (id) => {
      try {
        const escId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id
        const el = document.querySelector('[id="message-' + escId + '"][data-message-id="' + escId + '"]')
        if (!el || !scroller) return null
        return Math.round((el.getBoundingClientRect().top - scroller.getBoundingClientRect().top) * 10) / 10
      } catch { return null }
    }
    const stamp = (t) => {
      const headers = Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]')).map((el) => {
        const r = el.getBoundingClientRect()
        const countEl = el.querySelector('[data-testid="topic-segment-count"]')
        return { seg: (el.getAttribute('data-segment-id') || '?').slice(-8), top: Math.round(r.top * 10) / 10, h: Math.round(r.height * 10) / 10, count: countEl ? countEl.textContent : '' }
      })
      const cont = Array.from(document.querySelectorAll('[data-testid="topic-segment-rail-continuation"]')).map((el) =>
        ((el.getAttribute('data-segment-id') || '?').slice(-8) + '@' + Math.round(el.getBoundingClientRect().top))
      )
      const rails = document.querySelectorAll('[data-testid="folded-section-rail-line"]').length
      let phase = scroller ? scroller.getAttribute('data-viewport-phase') : null
      if (!phase) { const p = document.querySelector('[data-viewport-phase]'); if (p) phase = p.getAttribute('data-viewport-phase') }
      let routeKey = null
      try {
        const s = window.store.getState()
        const bids = (s.topicBranch && s.topicBranch.activeBranchIdByTopic) || {}
        const b = bids[spec.topicId] === undefined ? null : bids[spec.topicId]
        routeKey = spec.topicId.slice(-6) + '::' + (b === null || b === undefined ? 'main' : String(b).slice(-6))
      } catch { routeKey = null }
      const ids = Array.from(document.querySelectorAll('#messages [data-message-id]')).map((e) => e.getAttribute('data-message-id'))
      out.push({
        t: Math.round(t),
        scrollTop: scroller ? Math.round(scroller.scrollTop * 10) / 10 : -1,
        phase, routeKey, headers, cont, rails,
        winCount: ids.length,
        winFirst: ids.length ? String(ids[0]).slice(-8) : null,
        winLast: ids.length ? String(ids[ids.length - 1]).slice(-8) : null,
        anchorTop: rowTop(spec.anchorId),
        headTop: rowTop(spec.headId),
        reachTop: rowTop(spec.firstReach)
      })
      if (out.length >= spec.count) resolve(out)
      else requestAnimationFrame(stamp)
    }
    requestAnimationFrame(stamp)
  })
}`

const FN_MSG_COUNT_SRC = `function () { return document.querySelectorAll('#messages [data-message-id]').length }`
const FN_IN_DOM_SRC = `function (id) { try { const e = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id; return !!document.querySelector('[id="message-' + e + '"][data-message-id="' + e + '"]') } catch { return false } }`

function relJitterVerdict(name: string, frames: any[]): string[] {
  // Relative-offset jitter: header top minus stable-start (u05) row top.
  // Both measured against the #messages container, so container motion cancels.
  const rel: number[] = []
  for (const f of frames) {
    const h = (f.headers as any[]).length ? (f.headers as any[])[0].top : null
    if (typeof h === 'number' && typeof f.reachTop === 'number') rel.push(h - f.reachTop)
  }
  const sts = frames.map((f) => f.scrollTop)
  const scrollEx = Math.max(...sts) - Math.min(...sts)
  if (rel.length < 2) return [`${name}: INSUFFICIENT relative samples (headers=${rel.length})`]
  const mx = Math.max(...rel)
  const mn = Math.min(...rel)
  const drift = rel[rel.length - 1] - rel[0]
  const isJitter = mx - mn >= 30 && Math.abs(drift) <= 8 && scrollEx < 10
  if (isJitter)
    return [
      `${name}: JITTER rel excursion=${Math.round((mx - mn) * 10) / 10} drift=${Math.round(drift * 10) / 10} scrollEx=${Math.round(scrollEx * 10) / 10}`
    ]
  return []
}

function summarize(name: string, frames: any[]): string {
  const sts = frames.map((f: any) => f.scrollTop)
  const scrollEx = Math.max(...sts) - Math.min(...sts)
  const rel: number[] = []
  for (const f of frames) {
    const h = (f.headers as any[]).length ? (f.headers as any[])[0].top : null
    if (typeof h === 'number' && typeof f.reachTop === 'number') rel.push(h - f.reachTop)
  }
  const relEx = rel.length > 1 ? Math.max(...rel) - Math.min(...rel) : -1
  return [
    `== ${name}: frames=${frames.length}`,
    `scrollTop first=${sts[0]} last=${sts[sts.length - 1]} excursion=${Math.round(scrollEx * 10) / 10}`,
    `phases=${JSON.stringify(Array.from(new Set(frames.map((f: any) => f.routeKey + '/' + f.phase))))} rails=${JSON.stringify(Array.from(new Set(frames.map((f: any) => f.rails))))} contN=${JSON.stringify(Array.from(new Set(frames.map((f: any) => f.cont.length))))}`,
    `winCount first=${frames[0].winCount} last=${frames[frames.length - 1].winCount} winRange=${frames[0].winFirst}..${frames[0].winLast} -> ${frames[frames.length - 1].winFirst}..${frames[frames.length - 1].winLast}`,
    `anchorTop first=${frames[0].anchorTop} last=${frames[frames.length - 1].anchorTop} headTop(first/last)=${frames[0].headTop}/${frames[frames.length - 1].headTop} reachTop(first/last)=${frames[0].reachTop}/${frames[frames.length - 1].reachTop}`,
    `header-minus-reach relEx=${relEx} n=${rel.length}`
  ].join('\n')
}

async function poll(page: any, expr: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await page.evaluate(expr)) return
    if (Date.now() - start > timeoutMs) throw new Error(`poll timeout: ${label}`)
    await page.waitForTimeout(400)
  }
}

export default async function observe({ page, capture, writeText }: ObservationContext) {
  const log: string[] = []
  const flags: string[] = []
  const seed: any = await page.evaluate(invoke(FN_SEED_SRC))
  if (!seed || seed.ok !== true) throw new Error('seed failed: ' + JSON.stringify(seed))
  const { topicId, childId, segId, anchorId, headId, firstReach } = seed
  log.push(
    `fixture: topic=...${String(topicId).slice(-6)} child=...${String(childId).slice(-6)} seg=...${String(segId).slice(-8)} anchor=...${String(anchorId).slice(-8)} head=...${String(headId).slice(-8)} reach=...${String(firstReach).slice(-8)}`
  )
  log.push(`Main qualification parent: ${JSON.stringify(seed.qParent)}`)
  log.push(`Main qualification child: ${JSON.stringify(seed.qChild)}`)
  const qp = seed.qParent
  const qc = seed.qChild
  if (!qp || qp.headerInRoute !== true) throw new Error('fixture NOT headed on parent: ' + JSON.stringify(qp))
  if (!qc || qc.headerInRoute !== false || !(qc.routeCount > 0))
    throw new Error(
      'fixture NOT truncated-residual on child (need headerInRoute=false + routeCount>0): ' + JSON.stringify(qc)
    )
  if (qc.ownerBranch !== 'main' && qc.ownerBranch !== null) log.push('note: ownerBranch reported as ' + qc.ownerBranch)
  log.push(
    'fixture PROOF: same segment headed on parent + residual (head-missing, members-present) on child => true route-truncated residual group (not child-only, not window clipping)'
  )

  const spec = { topicId, anchorId, headId, firstReach, count: 60 }
  const specMove = { topicId, anchorId, headId, firstReach, count: 150 }

  const item = page.locator('[data-testid="topic-item"][data-topic-id="diag-trunc-resid"]')
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await poll(page, invoke(FN_MSG_COUNT_SRC) + ' >= 10', 30000, 'messages rendered')
  log.push(`parent DOM messages=${await page.evaluate(invoke(FN_MSG_COUNT_SRC))}`)
  await capture('a-parent-baseline')

  const base: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec)))
  await writeText('frames-baseline-parent.json', JSON.stringify(base))
  log.push(summarize('BASELINE parent (headed group)', base))

  const FN_ANCHOR = invoke(FN_IN_DOM_SRC, lit(anchorId))
  let anchorFound = await page.evaluate(FN_ANCHOR)
  await page.locator('#messages').hover()
  for (let k = 0; k < 14 && !anchorFound; k++) {
    await page.mouse.wheel(0, -700)
    await page.waitForTimeout(1000)
    anchorFound = await page.evaluate(FN_ANCHOR)
  }
  log.push(`anchor ...${String(anchorId).slice(-8)} in DOM after paging=${anchorFound}`)
  if (!anchorFound) throw new Error('fork anchor never entered the window; cannot drive real route UI')
  await capture('a0-paged-to-anchor')
  const toggle = page.locator('[data-testid^="branch-fork-toggle-"]').first()
  await toggle.waitFor({ state: 'visible', timeout: 15000 })
  const anchorAttr = String(await toggle.getAttribute('data-testid')).replace('branch-fork-toggle-', '')
  log.push(`fork toggle anchor suffix=...${anchorAttr.slice(-12)}`)
  await toggle.click()
  await page.locator(`[data-testid="branch-fork-list-${anchorAttr}"]`).waitFor({ state: 'visible', timeout: 10000 })
  const childRow = page.locator(`[data-testid="branch-fork-row-${anchorAttr}-${childId}"]`)
  await childRow.waitFor({ state: 'visible', timeout: 10000 })
  const toChildP = page.evaluate(invoke(FN_SAMPLE_SRC, lit(specMove)))
  await childRow.click({ timeout: 10000 })
  const toChild = (await toChildP) as any[]
  await writeText('frames-parent-to-child.json', JSON.stringify(toChild))
  log.push(summarize('PARENT->CHILD (headed -> residual)', toChild))
  flags.push(...relJitterVerdict('PARENT->CHILD', toChild))
  await page.waitForTimeout(1200)
  log.push(`child DOM messages=${await page.evaluate(invoke(FN_MSG_COUNT_SRC))}`)
  await capture('b-child-route')
  const settledChild: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, lit(spec)))
  await writeText('frames-settled-child.json', JSON.stringify(settledChild))
  log.push(summarize('SETTLED child (residual group)', settledChild))

  let anchorFound2 = await page.evaluate(FN_ANCHOR)
  await page.locator('#messages').hover()
  for (let k = 0; k < 14 && !anchorFound2; k++) {
    await page.mouse.wheel(0, -700)
    await page.waitForTimeout(1000)
    anchorFound2 = await page.evaluate(FN_ANCHOR)
  }
  log.push(`anchor in DOM on child route after paging=${anchorFound2}`)
  if (!anchorFound2) throw new Error('fork anchor never entered the child window')
  await capture('b1-child-paged-to-anchor')
  const toggle2 = page.locator('[data-testid^="branch-fork-toggle-"], [data-testid^="branch-fork-selected-"]').first()
  await toggle2.scrollIntoViewIfNeeded()
  await toggle2.click()
  const anchorAttr2 = String(await toggle2.getAttribute('data-testid'))
    .replace('branch-fork-toggle-', '')
    .replace('branch-fork-selected-', '')
  await page.locator(`[data-testid="branch-fork-list-${anchorAttr2}"]`).waitFor({ state: 'visible', timeout: 10000 })
  const backRow = page.locator(`[data-testid="branch-fork-row-${anchorAttr2}-parent"]`)
  await backRow.waitFor({ state: 'visible', timeout: 10000 })
  const toParentP = page.evaluate(invoke(FN_SAMPLE_SRC, lit(specMove)))
  await backRow.click({ timeout: 10000 })
  const toParent = (await toParentP) as any[]
  await writeText('frames-child-to-parent.json', JSON.stringify(toParent))
  log.push(summarize('CHILD->PARENT (residual -> headed)', toParent))
  flags.push(...relJitterVerdict('CHILD->PARENT', toParent))
  await page.waitForTimeout(1200)
  await capture('c-back-to-parent')
  log.push(`parent DOM messages=${await page.evaluate(invoke(FN_MSG_COUNT_SRC))}`)

  await writeText(
    'trunc-residual-log.txt',
    [
      ...log,
      '',
      `VERDICT: ${flags.length === 0 ? 'PASS no relative-offset jitter' : 'FLAG ' + flags.join(' | ')}`
    ].join('\n\n')
  )
}
