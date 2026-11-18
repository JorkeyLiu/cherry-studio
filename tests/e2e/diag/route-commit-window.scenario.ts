/**
 * DIAGNOSTIC scenario (not a regression asset): Goal-A route co-commit jitter.
 * Self-built deterministic fixture via the real chatDb capability
 * (store dispatch + window.api.chatDb ensureTopic/appendMessage/createBranch/
 * upsertSegment — the same Main path the import plane uses). No user files.
 *
 * Fixture: 44 user+assistant turns on the main route; child branch forked at
 * turn-30 anchor + 3 child-only turns; one cross-window parent segment
 * (head turn-2, members through turn-40); one child-only segment (true
 * residual on the parent route: head not in the full parent route).
 *
 * Flow: activate topic (real click) -> baseline sample -> real fork-UI
 * parent->child with per-frame sampling -> settle -> real fork-UI
 * child->parent with sampling -> scroll jumps with sampling.
 * Verdict lines (FLAG/PASS) go to route-commit-log.txt; a clear-cut jitter
 * (header excursion >=30px returning within 8px while scrollTop moves <10px)
 * throws. Artifacts record ids (synthetic) + geometry only, never bodies.
 */
import type { ObservationContext } from '../../../scripts/ui-observe/scenario'

const invoke = (fnSrc: string, argLiteral = 'undefined') => `(${fnSrc})(${argLiteral})`
const lit = (v: unknown) => JSON.stringify(v)

const FN_SEED_SRC = `function () {
  return (async () => {
    const stamp = '2026-01-01T00:00:00.000Z'
    const topicId = 'diag-route-commit'
    const st = window.store.getState()
    const assistantId = (st.assistants && st.assistants.assistants && st.assistants.assistants[0] && st.assistants.assistants[0].id) || null
    if (!assistantId) return { ok: false, err: 'no assistant' }
    window.store.dispatch({ type: 'assistants/addTopic', payload: { assistantId, topic: { id: topicId, assistantId, name: 'diag route commit', createdAt: stamp, updatedAt: stamp } } })
    const api = window.api.chatDb
    const ensured = await api.ensureTopic({ topicId, assistantId, name: 'diag route commit' })
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
    for (let i = 0; i < 44; i++) {
      const p = String(i).padStart(2, '0')
      let e = await put('u' + p, 'user', null, null)
      if (e) return { ok: false, err: e }
      e = await put('a' + p, 'assistant', 'u' + p, null)
      if (e) return { ok: false, err: e }
    }
    const fork = await api.createBranch({ topicId, anchorMessageId: topicId + '-a30', name: 'diag-child' })
    if (!fork || fork.ok !== true) return { ok: false, err: 'createBranch ' + JSON.stringify(fork) }
    const childId = fork.value.branch.id
    for (let i = 0; i < 3; i++) {
      const p = 'c' + i
      let e = await put('u' + p, 'user', null, childId)
      if (e) return { ok: false, err: e }
      e = await put('a' + p, 'assistant', 'u' + p, childId)
      if (e) return { ok: false, err: e }
    }
    const spanMembers = []
    for (let i = 2; i <= 40; i++) { const p = String(i).padStart(2, '0'); spanMembers.push(topicId + '-u' + p, topicId + '-a' + p) }
    const seg = await api.upsertSegment({ segmentId: topicId + '-seg-span', topicId, name: 'diag span', messageIds: spanMembers })
    if (!seg || seg.ok !== true) return { ok: false, err: 'upsertSegment span ' + JSON.stringify(seg) }
    const segChild = await api.upsertSegment({ segmentId: topicId + '-seg-child', topicId, branchId: childId, name: 'diag childonly', messageIds: [topicId + '-uc0', topicId + '-ac0', topicId + '-uc1'] })
    if (!segChild || segChild.ok !== true) return { ok: false, err: 'upsertSegment child ' + JSON.stringify(segChild) }
    return { ok: true, topicId, assistantId, childId, headSpan: topicId + '-u02' }
  })()
}`

const FN_SAMPLE_SRC = `function (count) {
  return new Promise((resolve) => {
    const out = []
    const scroller = document.getElementById('messages')
    const stamp = (t) => {
      const headers = Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]')).map((el) => {
        const r = el.getBoundingClientRect()
        const label = el.querySelector('[data-testid="topic-segment-label"]')
        const countEl = el.querySelector('[data-testid="topic-segment-count"]')
        return {
          seg: (el.getAttribute('data-segment-id') || '?').slice(-8),
          top: Math.round(r.top * 10) / 10, h: Math.round(r.height * 10) / 10,
          label: label ? label.textContent.slice(0, 24) : '',
          count: countEl ? countEl.textContent : ''
        }
      })
      const cont = Array.from(document.querySelectorAll('[data-testid="topic-segment-rail-continuation"]')).map((el) =>
        ((el.getAttribute('data-segment-id') || '?').slice(-8) + '@' + Math.round(el.getBoundingClientRect().top))
      )
      let phase = null
      if (scroller) phase = scroller.getAttribute('data-viewport-phase')
      if (!phase) { const p = document.querySelector('[data-viewport-phase]'); if (p) phase = p.getAttribute('data-viewport-phase') }
      out.push({ t: Math.round(t), scrollTop: scroller ? Math.round(scroller.scrollTop * 10) / 10 : -1, phase, headers, cont })
      if (out.length >= count) resolve(out)
      else requestAnimationFrame(stamp)
    }
    requestAnimationFrame(stamp)
  })
}`

const FN_MSG_COUNT_SRC = `function () { return document.querySelectorAll('#messages [data-message-id]').length }`
const FN_SCROLL_TOP_SRC = `function () { const sc = document.getElementById('messages'); if (sc) sc.scrollTo({ top: 0, behavior: 'instant' }); return true }`
const FN_SCROLL_BOTTOM_SRC = `function () { const sc = document.getElementById('messages'); if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'instant' }); return true }`
const FN_RAILS_SRC = `function () {
  const rails = Array.from(document.querySelectorAll('[data-testid="folded-section-rail-line"]')).map((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, csWidth: cs.width, overflow: cs.overflow, clip: (el.getBoundingClientRect().width < 2 ? 'CLIPPED?' : 'ok') }
  })
  const groupHeaders = Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]')).length
  return { rails, groupHeaders, dpr: window.devicePixelRatio }
}`

function summarize(name: string, frames: any[]): string {
  const bySeg = new Map<string, number[]>()
  for (const f of frames)
    for (const h of f.headers) {
      if (!bySeg.has(h.seg)) bySeg.set(h.seg, [])
      bySeg.get(h.seg)!.push(h.top)
    }
  const lines: string[] = [`== ${name}: frames=${frames.length}`]
  const sts = frames.map((f) => f.scrollTop)
  const scrollEx = Math.max(...sts) - Math.min(...sts)
  lines.push(`scrollTop first=${sts[0]} last=${sts[sts.length - 1]} excursion=${Math.round(scrollEx * 10) / 10}`)
  lines.push(
    `phases=${JSON.stringify(Array.from(new Set(frames.map((f) => f.phase))))} contCounts=${JSON.stringify(Array.from(new Set(frames.map((f) => f.cont.length))))}`
  )
  for (const [seg, tops] of bySeg) {
    const mx = Math.max(...tops),
      mn = Math.min(...tops)
    const drift = tops[tops.length - 1] - tops[0]
    const jitter = mx - mn >= 30 && Math.abs(drift) <= 8 && scrollEx < 10
    lines.push(
      `seg ${seg}: n=${tops.length} min=${mn} max=${mx} excursion=${Math.round((mx - mn) * 10) / 10} drift=${Math.round(drift * 10) / 10} JITTER=${jitter}`
    )
  }
  return lines.join('\n')
}

function verdict(name: string, frames: any[]): string[] {
  const flags: string[] = []
  const sts = frames.map((f) => f.scrollTop)
  const scrollEx = Math.max(...sts) - Math.min(...sts)
  const bySeg = new Map<string, number[]>()
  for (const f of frames)
    for (const h of f.headers) {
      if (!bySeg.has(h.seg)) bySeg.set(h.seg, [])
      bySeg.get(h.seg)!.push(h.top)
    }
  for (const [seg, tops] of bySeg) {
    const mx = Math.max(...tops),
      mn = Math.min(...tops)
    const drift = tops[tops.length - 1] - tops[0]
    if (mx - mn >= 30 && Math.abs(drift) <= 8 && scrollEx < 10)
      flags.push(
        `${name}: JITTER seg ${seg} excursion=${Math.round((mx - mn) * 10) / 10} drift=${Math.round(drift * 10) / 10}`
      )
  }
  return flags
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
  const topicId: string = seed.topicId
  const childId: string = seed.childId
  log.push(`fixture: topic=${topicId} childBranch=${childId} spanHead=${seed.headSpan} (44 main turns + 3 child turns)`)

  const item = page.locator('[data-testid="topic-item"][data-topic-id="diag-route-commit"]')
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await poll(page, invoke(FN_MSG_COUNT_SRC) + ' >= 10', 30000, 'messages rendered')
  log.push(`parent DOM messages=${await page.evaluate(invoke(FN_MSG_COUNT_SRC))}`)
  await capture('a-parent-baseline')

  const base: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, '60'))
  await writeText('frames-baseline.json', JSON.stringify(base))
  log.push(summarize('BASELINE parent', base))

  // Page the window toward older messages (real wheel gestures) until the
  // fork anchor (turn-30) enters the DOM; the divider only renders there.
  const FN_ANCHOR_SRC = `function () { return Array.from(document.querySelectorAll('#messages [data-message-id]')).some((e) => e.getAttribute('data-message-id') === 'diag-route-commit-a30') }`
  let anchorFound = await page.evaluate(invoke(FN_ANCHOR_SRC))
  await page.locator('#messages').hover()
  for (let k = 0; k < 14 && !anchorFound; k++) {
    await page.mouse.wheel(0, -700)
    await page.waitForTimeout(1000)
    anchorFound = await page.evaluate(invoke(FN_ANCHOR_SRC))
  }
  log.push(`anchor a30 in DOM after paging=${anchorFound}`)
  if (!anchorFound) throw new Error('fork anchor never entered the window; cannot drive real route UI')
  await capture('a0-paged-to-anchor')
  const toggle = page.locator('[data-testid^="branch-fork-toggle-"]').first()
  await toggle.waitFor({ state: 'visible', timeout: 15000 })
  const anchor = String(await toggle.getAttribute('data-testid')).replace('branch-fork-toggle-', '')
  log.push(`fork anchor msg=${anchor.slice(-12)} (expect diag-route-commit-a30)`)
  await toggle.click()
  await page.locator(`[data-testid="branch-fork-list-${anchor}"]`).waitFor({ state: 'visible', timeout: 10000 })
  const childRow = page.locator(`[data-testid="branch-fork-row-${anchor}-${childId}"]`)
  await childRow.waitFor({ state: 'visible', timeout: 10000 })
  const toChildP = page.evaluate(invoke(FN_SAMPLE_SRC, '150'))
  await childRow.click({ timeout: 10000 })
  const toChild = (await toChildP) as any[]
  await writeText('frames-parent-to-child.json', JSON.stringify(toChild))
  log.push(summarize('PARENT->CHILD', toChild))
  flags.push(...verdict('PARENT->CHILD', toChild))
  await page.waitForTimeout(1200)
  log.push(`child DOM messages=${await page.evaluate(invoke(FN_MSG_COUNT_SRC))}`)
  await capture('b-child-route')
  const settledChild: any[] = await page.evaluate(invoke(FN_SAMPLE_SRC, '60'))
  log.push(summarize('SETTLED child', settledChild))

  // The child window parks at its own bottom; page back to the anchor first.
  let anchorFound2 = await page.evaluate(invoke(FN_ANCHOR_SRC))
  await page.locator('#messages').hover()
  for (let k = 0; k < 14 && !anchorFound2; k++) {
    await page.mouse.wheel(0, -700)
    await page.waitForTimeout(1000)
    anchorFound2 = await page.evaluate(invoke(FN_ANCHOR_SRC))
  }
  log.push(`anchor a30 in DOM on child route after paging=${anchorFound2}`)
  if (!anchorFound2) throw new Error('fork anchor never entered the child window')
  await capture('b1-child-paged-to-anchor')
  const toggle2 = page.locator('[data-testid^="branch-fork-toggle-"], [data-testid^="branch-fork-selected-"]').first()
  await toggle2.scrollIntoViewIfNeeded()
  await toggle2.click()
  const anchor2 = String(await toggle2.getAttribute('data-testid'))
    .replace('branch-fork-toggle-', '')
    .replace('branch-fork-selected-', '')
  await page.locator(`[data-testid="branch-fork-list-${anchor2}"]`).waitFor({ state: 'visible', timeout: 10000 })
  const backRow = page.locator(`[data-testid="branch-fork-row-${anchor2}-parent"]`)
  await backRow.waitFor({ state: 'visible', timeout: 10000 })
  const toParentP = page.evaluate(invoke(FN_SAMPLE_SRC, '150'))
  await backRow.click({ timeout: 10000 })
  const toParent = (await toParentP) as any[]
  await writeText('frames-child-to-parent.json', JSON.stringify(toParent))
  log.push(summarize('CHILD->PARENT', toParent))
  flags.push(...verdict('CHILD->PARENT', toParent))
  await page.waitForTimeout(1200)
  await capture('c-back-to-parent')
  log.push(`parent DOM messages=${await page.evaluate(invoke(FN_MSG_COUNT_SRC))}`)

  await page.evaluate(invoke(FN_SCROLL_TOP_SRC))
  await page.waitForTimeout(600)
  const scrollP = page.evaluate(invoke(FN_SAMPLE_SRC, '120'))
  await page.evaluate(invoke(FN_SCROLL_BOTTOM_SRC))
  const scrolled = (await scrollP) as any[]
  await writeText('frames-scroll.json', JSON.stringify(scrolled))
  log.push(summarize('SCROLL top->bottom', scrolled))
  await capture('d-scrolled-bottom')

  const rails: any = await page.evaluate(invoke(FN_RAILS_SRC))
  log.push(`rails: ${JSON.stringify(rails)}`)

  await writeText(
    'route-commit-log.txt',
    [...log, '', `VERDICT: ${flags.length === 0 ? 'PASS no clear-cut jitter' : 'FLAG ' + flags.join(' | ')}`].join(
      '\n\n'
    )
  )
  if (flags.length > 0) throw new Error(flags.join(' | '))
}
