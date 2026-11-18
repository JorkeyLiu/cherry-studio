/**
 * Isolated FoldedSection browse-motion / hover-highlight / settle-position
 * observation.
 *
 * Fixture: 5-turn disposable topic seeded through the real ChatDb IPC, fresh
 * profile (ui:observe ownership contract), fold of turns 3+4 written by the
 * REAL Main `setTurnFolds` command, page reload so the collapsed block boots
 * from Main-persisted state. No Downloads import, no live profile.
 *
 * The pointer is moved ONCE per gesture and then never moved again: expand and
 * collapse are two down/up pairs at the exact same viewport point, so every
 * drop of the hover highlight that is not caused by pointer motion is visible
 * per-rAF (region-active attribute, computed line background/color, label
 * color, :hover chain) rather than inferred.
 *
 * Read-only forensic probe: it observes the built app, changes no production
 * code, and only writes artifacts into this run's output directory.
 */
import type { ObservationContext } from '../../../scripts/ui-observe/scenario'

const SEED_TURNS = 5

// Plain-JS page sources (string-evaluated, never a TS closure): esbuild's
// keepNames `__name` helper must not leak into the browser via fn.toString().
const FN_SEED_SRC = `function (turns) {
  return (async () => {
    try {
      const store = window.store
      const assistantId = (store.getState().assistants && store.getState().assistants.assistants && store.getState().assistants.assistants[0] && store.getState().assistants.assistants[0].id) || null
      if (!assistantId) return { ok: false, err: 'no assistant' }
      store.dispatch({ type: 'newMessages/setDisplayCount', payload: 20 })
      const stamp = '2026-01-01T00:00:00.000Z'
      const topicId = 'foldhover-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      store.dispatch({ type: 'assistants/addTopic', payload: { assistantId, topic: { id: topicId, assistantId, name: 'foldhover ' + topicId, createdAt: stamp, updatedAt: stamp } } })
      const uid = (turn) => topicId + '-msg-' + String(turn).padStart(5, '0')
      const entries = []
      for (let turn = 1; turn <= turns; turn++) {
        const user = uid(turn)
        const assistant = user + '-a'
        entries.push({ message: { id: user, topicId, role: 'user', createdAt: stamp, updatedAt: stamp, status: 'success', blocks: [user + '-block'], sortOrder: (turn - 1) * 2 }, blocks: [{ id: user + '-block', messageId: user, type: 'main_text', content: 'foldhover-turn-' + turn + '-user', status: 'success', createdAt: stamp, updatedAt: stamp }] })
        entries.push({ message: { id: assistant, topicId, role: 'assistant', createdAt: stamp, updatedAt: stamp, status: 'success', blocks: [assistant + '-block'], sortOrder: (turn - 1) * 2 + 1, assistantId, askId: user, model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }, modelId: 'mock-model' }, blocks: [{ id: assistant + '-block', messageId: assistant, type: 'main_text', content: 'foldhover-turn-' + turn + '-assistant body ' + 'filler '.repeat(20), status: 'success', createdAt: stamp, updatedAt: stamp }] })
      }
      const api = window.api.chatDb
      const ensured = await api.ensureTopic({ topicId, assistantId, name: 'foldhover ' + topicId })
      if (!ensured || ensured.ok !== true) return { ok: false, err: 'ensureTopic ' + JSON.stringify(ensured) }
      const pasted = await api.pasteMessagesToTopic({ topicId, entries })
      if (!pasted || pasted.ok !== true) return { ok: false, err: 'paste ' + JSON.stringify(pasted) }
      return { ok: true, topicId, turn3: uid(3), turn4: uid(4) }
    } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
  })()
}`

const FN_FOLD_SRC = `function (arg) {
  return (async () => {
    try {
      const res = await window.api.chatDb.setTurnFolds({ topicId: arg.tid, selectedGroupIds: arg.ids, folded: true })
      return res
    } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
  })()
}`

/**
 * Instrumentation install: resolves the block's real nodes, tags each with a
 * unique identity token (so a remount inside the motion is directly visible),
 * attaches mouse-enter/leave/over/out/focus loggers with timestamps, and
 * returns the fixed gesture point for the requested mode.
 */
const FN_SETUP_SRC = `function (cfg) {
  const SEL = {
    shell: '[data-fold-shell="true"]',
    railbox: '[data-testid="folded-section-railbox"]',
    track: '[data-testid="folded-section-rail-track"]',
    line: '[data-testid="folded-section-rail-line"]',
    hit: '[data-testid="folded-section-expand-btn"], [data-testid="folded-section-gutter-rail"]',
    header: '[data-testid="folded-section-header"]',
    label: '[data-testid="folded-section-expand-label"]'
  }
  const shell = document.querySelector(SEL.shell)
  if (!shell) return { ok: false, err: 'no fold shell' }
  const nodes = {
    shell,
    railbox: shell.querySelector(SEL.railbox),
    track: shell.querySelector(SEL.track),
    line: shell.querySelector(SEL.line),
    hit: shell.querySelector(SEL.hit),
    header: shell.querySelector(SEL.header),
    label: shell.querySelector(SEL.label),
    body: shell.lastElementChild
  }
  const token = 'fd-' + Math.random().toString(36).slice(2, 10)
  for (const key of Object.keys(nodes)) { if (nodes[key]) nodes[key].__fdTok = token }
  const events = []
  const log = (node, type) => (e) => {
    events.push({ t: +(performance.now() - t0).toFixed(1), type, node, related: e && e.relatedTarget ? (e.relatedTarget.tagName || '') : null })
  }
  const t0 = performance.now()
  for (const key of ['shell', 'hit', 'label']) {
    const el = nodes[key]
    if (!el) continue
    for (const type of ['mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'focus', 'blur', 'pointerover', 'pointerout']) {
      el.addEventListener(type, log(key, type), true)
    }
  }
  // Carry identity onto the DOM set the browse toggle swaps: the message rows
  // and the wrapper's own children. A settle branch swap that remounts them
  // drops the token, so "same node" vs "recreated node" is directly observable.
  window.__fdRowTok = token
  for (const row of document.querySelectorAll('#messages [data-message-id]')) row.__fdTok = token
  if (nodes.body) for (const kid of nodes.body.children) kid.__fdTok = token
  window.__fd = { nodes, token, events, t0 }
  const hitRect = nodes.hit.getBoundingClientRect()
  const labelRect = nodes.label.getBoundingClientRect()
  const point = cfg.mode === 'text'
    ? { x: Math.round(labelRect.left + 3), y: Math.round(labelRect.top + labelRect.height / 2) }
    : { x: Math.round(hitRect.left + hitRect.width / 2), y: Math.round(hitRect.top + 8) }
  const cs = getComputedStyle(nodes.line)
  const ls = getComputedStyle(nodes.label)
  return {
    ok: true,
    token,
    point,
    hitRect: [+hitRect.top.toFixed(2), +hitRect.height.toFixed(2), +hitRect.left.toFixed(2), +hitRect.width.toFixed(2)],
    labelRect: [+labelRect.top.toFixed(2), +labelRect.height.toFixed(2), +labelRect.left.toFixed(2), +labelRect.width.toFixed(2)],
    shellRect: (() => { const r = shell.getBoundingClientRect(); return [+r.top.toFixed(2), +r.height.toFixed(2), +r.left.toFixed(2), +r.width.toFixed(2)] })(),
    lineStyle: { background: cs.backgroundColor, filter: cs.filter, transition: cs.transition, opacity: cs.opacity },
    labelStyle: { color: ls.color, background: ls.backgroundColor, filter: ls.filter, transition: ls.transition, opacity: ls.opacity },
    shellState: shell.getAttribute('data-testid'),
    regionActive: shell.getAttribute('data-fold-region-active'),
    bodyRole: (() => { const el = nodes.body; if (!el) return 'none'; const bcs = getComputedStyle(el); return el.getAttribute('data-browse-phase') || (bcs.animationName !== 'none' ? 'anim' : (bcs.opacity === '0.95' ? 'settled-expanded-wrapper' : 'settled-collapsed-plain')) })(),
    animationsSupported: typeof HTMLElement.prototype.getAnimations === 'function',
    reducedMotion: typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : 'no-matchMedia'
  }
}`

/** One rAF sample per frame for cfg.durationMs; identity, styles, geometry, scroll, DOM set. */
const FN_SAMPLER_SRC = `function (cfg) {
  return new Promise((resolve) => {
    const fd = window.__fd || {}
    const refs = fd.nodes || {}
    const token = fd.token
    const SEL = {
      shell: '[data-fold-shell="true"]',
      railbox: '[data-testid="folded-section-railbox"]',
      track: '[data-testid="folded-section-rail-track"]',
      line: '[data-testid="folded-section-rail-line"]',
      hit: '[data-testid="folded-section-expand-btn"], [data-testid="folded-section-gutter-rail"]',
      header: '[data-testid="folded-section-header"]',
      label: '[data-testid="folded-section-expand-label"]'
    }
    const q = (sel) => { try { return document.querySelector(sel) } catch (e) { return null } }
    const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [+r.top.toFixed(2), +r.height.toFixed(2), +r.left.toFixed(2), +r.width.toFixed(2)] }
    const px = cfg.x, py = cfg.y
    const t0 = performance.now()
    const frames = []
    const bodyRole = (el) => {
      if (!el) return 'none'
      const cs = getComputedStyle(el)
      const ph = el.getAttribute('data-browse-phase')
      if (ph) return 'motion-armed:' + ph
      if (el.style.getPropertyValue('--browse-height-from') !== '') return 'motion-measure'
      if (cs.animationName && cs.animationName !== 'none') return 'anim-no-phase'
      if (cs.opacity === '0.95') return 'settled-expanded-wrapper'
      return 'settled-collapsed-plain'
    }
    const step = () => {
      const now = performance.now()
      const cur = {}
      for (const key of Object.keys(SEL)) cur[key] = q(SEL[key])
      const shell = cur.shell
      const body = shell ? shell.lastElementChild : null
      const ident = {}
      const tok = {}
      for (const key of Object.keys(SEL)) {
        ident[key] = cur[key] !== null && cur[key] === refs[key]
        tok[key] = cur[key] ? (cur[key].__fdTok === token) : null
      }
      ident.body = body !== null && body === refs.body
      tok.body = body ? (body.__fdTok === token) : null
      const lcs = cur.line ? getComputedStyle(cur.line) : null
      const lbs = cur.label ? getComputedStyle(cur.label) : null
      const bcs = body ? getComputedStyle(body) : null
      let anims = []
      try { if (body && typeof body.getAnimations === 'function') anims = body.getAnimations().map((a) => ({ name: (a.animationName || (a.effect && a.effect.getTiming && a.effect.getTiming().easing) || '?'), playState: a.playState, ct: a.currentTime === null ? null : +Number(a.currentTime).toFixed(1) })) } catch (e) { anims = [{ name: 'ERR', playState: String(e && e.message), ct: null }] }
      const scroller = document.querySelector('#messages')
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]'))
      const rowInfo = []
      for (const r of rows) {
        const id = r.getAttribute('data-message-id') || ''
        const m = /msg-(\\d{5})/.exec(id)
        const rr = r.getBoundingClientRect()
        rowInfo.push({ turn: m ? Number(m[1]) : -1, top: +rr.top.toFixed(2), bottom: +rr.bottom.toFixed(2), h: +rr.height.toFixed(2) })
      }
      const tops = rowInfo.map((r) => r.top)
      const under = document.elementFromPoint(px, py)
      const hitRect = cur.hit ? cur.hit.getBoundingClientRect() : null
      const shellRect = shell ? shell.getBoundingClientRect() : null
      const inside = (r) => !!r && px >= r.left && px <= r.right && py >= r.top && py <= r.bottom
      frames.push({
        t: +(now - t0).toFixed(1),
        phase: body ? body.getAttribute('data-browse-phase') : null,
        shellState: shell ? shell.getAttribute('data-testid') : null,
        regionActive: shell ? shell.getAttribute('data-fold-region-active') : null,
        labelText: cur.label ? (cur.label.textContent || '').trim() : null,
        colors: {
          lineBg: lcs ? lcs.backgroundColor : null,
          lineFilter: lcs ? lcs.filter : null,
          lineOpacity: lcs ? lcs.opacity : null,
          labelColor: lbs ? lbs.color : null,
          labelBg: lbs ? lbs.backgroundColor : null,
          labelOpacity: lbs ? lbs.opacity : null,
          hitBg: cur.hit ? getComputedStyle(cur.hit).backgroundColor : null
        },
        hover: {
          label: cur.label ? cur.label.matches(':hover') : null,
          hit: cur.hit ? cur.hit.matches(':hover') : null,
          shell: shell ? shell.matches(':hover') : null
        },
        focus: document.activeElement ? (document.activeElement.closest('[data-testid]') || { getAttribute: () => document.activeElement.tagName }).getAttribute('data-testid') : null,
        anims,
        body: {
          role: bodyRole(body),
          opacity: bcs ? bcs.opacity : null,
          animName: bcs ? bcs.animationName : null,
          vars: body ? [body.style.getPropertyValue('--browse-height-from'), body.style.getPropertyValue('--browse-height-to'), body.style.getPropertyValue('--browse-space-duration'), body.style.getPropertyValue('--browse-fade-duration'), body.style.getPropertyValue('--browse-fade-delay')] : null,
          kids: body ? body.children.length : null
        },
        ident,
        tok,
        rects: {
          shell: rectOf(cur.shell),
          railbox: rectOf(cur.railbox),
          track: rectOf(cur.track),
          header: rectOf(cur.header),
          label: rectOf(cur.label),
          hit: rectOf(cur.hit),
          body: rectOf(body)
        },
        scroll: scroller ? { top: +scroller.scrollTop.toFixed(2), height: +scroller.scrollHeight.toFixed(1), client: +scroller.clientHeight.toFixed(1) } : null,
        mounted: rows.length,
        mountedTurns: rowInfo.map((r) => r.turn),
        rowTok: rows.filter((r) => r.__fdTok === token).length,
        bodyKidsTok: body ? Array.from(body.children).filter((k) => k.__fdTok === token).length : null,
        rowTopMin: tops.length ? +Math.min.apply(null, tops).toFixed(2) : null,
        rowBottomMax: rowInfo.length ? +Math.max.apply(null, rowInfo.map((r) => r.bottom)).toFixed(2) : null,
        rows: rowInfo.slice(0, 12),
        pointer: { insideHit: inside(hitRect), insideShell: inside(shellRect), target: under ? { tag: under.tagName, tid: (under.closest('[data-testid]') || { getAttribute: () => null }).getAttribute('data-testid'), inShell: !!under.closest('[data-fold-shell="true"]') } : null }
      })
      if (now - t0 < cfg.durationMs) requestAnimationFrame(step)
      else { fd.lastFrames = frames; resolve(frames) }
    }
    requestAnimationFrame(step)
  })
}`

const FN_PROBE_SRC = `function () {
  const shell = document.querySelector('[data-fold-shell="true"]')
  const body = shell ? shell.lastElementChild : null
  const line = document.querySelector('[data-testid="folded-section-rail-line"]')
  const label = document.querySelector('[data-testid="folded-section-expand-label"]')
  const hit = document.querySelector('[data-testid="folded-section-expand-btn"], [data-testid="folded-section-gutter-rail"]')
  const scroller = document.querySelector('#messages')
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [+b.top.toFixed(2), +b.height.toFixed(2), +b.left.toFixed(2)] }
  const cs = (el, props) => { if (!el) return null; const s = getComputedStyle(el); const o = {}; for (const p of props) o[p] = s[p]; return o }
  return {
    shellState: shell ? shell.getAttribute('data-testid') : null,
    regionActive: shell ? shell.getAttribute('data-fold-region-active') : null,
    phase: body ? body.getAttribute('data-browse-phase') : null,
    bodyRole: body ? (body.getAttribute('data-browse-phase') || (getComputedStyle(body).opacity === '0.95' ? 'settled-expanded-wrapper' : 'settled-collapsed-plain')) : 'none',
    bodyOpacity: body ? getComputedStyle(body).opacity : null,
    line: cs(line, ['backgroundColor', 'filter', 'opacity']),
    label: cs(label, ['color', 'backgroundColor', 'opacity']),
    hover: { hit: hit ? hit.matches(':hover') : null, label: label ? label.matches(':hover') : null },
    labelText: label ? (label.textContent || '').trim() : null,
    rects: { shell: r(shell), hit: r(hit), label: r(label), body: r(body) },
    scroll: scroller ? { top: +scroller.scrollTop.toFixed(2), height: +scroller.scrollHeight.toFixed(1), client: +scroller.clientHeight.toFixed(1) } : null,
    mounted: document.querySelectorAll('#messages [data-message-id]').length,
    focus: document.activeElement ? document.activeElement.tagName : null
  }
}`

const FN_EVENTS_SRC = `function () {
  const fd = window.__fd || {}
  return { token: fd.token || null, events: (fd.events || []).slice(), t0: fd.t0 || null }
}`

/** Only the fields a rebase needs: identity continuity is not expected across navigations. */
export default async function observe({ page, capture, writeText }: ObservationContext) {
  const log: string[] = []

  const seed: any = await page.evaluate(`(${FN_SEED_SRC})(${SEED_TURNS})`)
  if (!seed || seed.ok !== true) throw new Error('seed failed: ' + JSON.stringify(seed))
  const topicId: string = seed.topicId
  const turn3: string = seed.turn3
  const turn4: string = seed.turn4
  log.push(`seed ok topic=${topicId} turns=${SEED_TURNS} foldGroupIds=${turn3},${turn4}`)

  const pollTrue = async (callSrc: string, timeoutMs: number, label: string) => {
    const start = Date.now()
    for (;;) {
      const v: any = await page.evaluate(callSrc)
      if (v === true) return
      if (Date.now() - start > timeoutMs) throw new Error('wait timeout: ' + label)
      await page.waitForTimeout(250)
    }
  }
  const waitTopicStore = async (tid: string, min: number) => {
    await pollTrue(
      `(function () { const s = window.store.getState(); const ids = s.messages && s.messages.messageIdsByTopic && s.messages.messageIdsByTopic[${JSON.stringify(tid)}]; return Array.isArray(ids) && ids.length >= ${min} && s.messages.loadingByTopic[${JSON.stringify(tid)}] !== true })()`,
      30000,
      'topic bootstrap'
    )
  }
  const waitMounted = async (min: number) => {
    await pollTrue(
      `(function () { return document.querySelectorAll('#messages [data-message-id]').length >= ${min} })()`,
      30000,
      'mounted rows'
    )
  }
  const activate = async (expectStoreMin: number, expectMountedMin: number) => {
    const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await item.waitFor({ state: 'visible', timeout: 30000 })
    await item.scrollIntoViewIfNeeded()
    await item.click()
    await waitTopicStore(topicId, expectStoreMin)
    await waitMounted(expectMountedMin)
  }

  await activate(SEED_TURNS * 2, SEED_TURNS * 2)
  await capture('foldhover-seeded')

  const foldRes: any = await page.evaluate(`(${FN_FOLD_SRC})(${JSON.stringify({ tid: topicId, ids: [turn3, turn4] })})`)
  log.push(`Main setTurnFolds response: ${JSON.stringify(foldRes)}`)
  const foldOk = foldRes && (foldRes.folded === true || (foldRes.value && foldRes.value.folded === true)) === true
  if (!foldOk) throw new Error('true Main setTurnFolds failed: ' + JSON.stringify(foldRes))

  await page.reload()
  await page.waitForTimeout(2500)
  await pollTrue(`(function () { return !!(window.store && window.api) })()`, 30000, 'reload ready')
  await page.waitForTimeout(2000)
  await activate(SEED_TURNS * 2, (SEED_TURNS - 2) * 2)
  const collapsed = page.locator('[data-testid="folded-section-collapsed"]').first()
  await collapsed.waitFor({ state: 'visible', timeout: 30000 })
  await page.evaluate(
    `(function () { const el = document.querySelector('[data-fold-shell="true"]'); if (el) el.scrollIntoView({ block: 'center' }) })()`
  )
  await page.waitForTimeout(600)
  await capture('foldhover-collapsed-initial')
  const initialProbe: any = await page.evaluate(`(${FN_PROBE_SRC})()`)
  log.push(`collapsed-initial probe: ${JSON.stringify(initialProbe)}`)

  /**
   * One gesture = exactly one pointer position, expand then collapse at the
   * SAME viewport point with no further pointer motion. `page.mouse.down/up`
   * (never `click(x,y)`/`move`) is what keeps a synthetic re-hover from
   * masking a lost highlight.
   */
  const runGesture = async (mode: 'rail' | 'text') => {
    const setup: any = await page.evaluate(`(${FN_SETUP_SRC})(${JSON.stringify({ mode })})`)
    if (!setup || setup.ok !== true) throw new Error('setup failed (' + mode + '): ' + JSON.stringify(setup))
    const { x, y } = setup.point
    log.push(`gesture[${mode}] setup: ${JSON.stringify({ ...setup, token: undefined })}`)

    await page.mouse.move(x, y)
    await page.waitForTimeout(200)
    const beforeExpand: any = await page.evaluate(`(${FN_PROBE_SRC})()`)
    log.push(`gesture[${mode}] hover-before-expand: ${JSON.stringify(beforeExpand)}`)

    const expandSampler = page.evaluate(`(${FN_SAMPLER_SRC})(${JSON.stringify({ x, y, durationMs: 1400 })})`)
    await page.mouse.down()
    await page.mouse.up()
    const expandFrames: any[] = (await expandSampler) as any[]
    await writeText(`foldhover-${mode}-expand-frames.json`, JSON.stringify(expandFrames, null, 1))
    const afterExpand: any = await page.evaluate(`(${FN_PROBE_SRC})()`)
    const evAfterExpand: any = await page.evaluate(`(${FN_EVENTS_SRC})()`)
    await capture(`foldhover-${mode}-expanded-settled`)
    log.push(`gesture[${mode}] expanded-settled probe: ${JSON.stringify(afterExpand)}`)
    log.push(`gesture[${mode}] events after expand-settle: ${JSON.stringify(evAfterExpand.events)}`)

    await page.waitForTimeout(500)
    const collapseSampler = page.evaluate(`(${FN_SAMPLER_SRC})(${JSON.stringify({ x, y, durationMs: 1400 })})`)
    await page.mouse.down()
    await page.mouse.up()
    const collapseFrames: any[] = (await collapseSampler) as any[]
    await writeText(`foldhover-${mode}-collapse-frames.json`, JSON.stringify(collapseFrames, null, 1))
    const afterCollapse: any = await page.evaluate(`(${FN_PROBE_SRC})()`)
    const evAfterCollapse: any = await page.evaluate(`(${FN_EVENTS_SRC})()`)
    await capture(`foldhover-${mode}-collapsed-settled`)
    log.push(`gesture[${mode}] collapsed-settled probe: ${JSON.stringify(afterCollapse)}`)
    log.push(`gesture[${mode}] events after collapse-settle: ${JSON.stringify(evAfterCollapse.events)}`)
    // A collapse that did NOT toggle from the fixed point is itself a finding:
    // log it, then still observe the collapse motion from a fresh pointer
    // position (pointer moved, so highlight persistence is not claimed there).
    let movedCollapse: any = null
    if (afterCollapse.shellState !== 'folded-section-collapsed') {
      log.push(
        `gesture[${mode}] FIXED-POINT COLLAPSE DID NOT TOGGLE (state=${afterCollapse.shellState}); pointer target was ${JSON.stringify(collapseFrames[collapseFrames.length - 1].pointer)}`
      )
      // The expanded header has travelled off the top of the scrollport, so the
      // label's own position is off-screen: bring the header back into view
      // first, then take a fresh point on the label.
      await page.evaluate(
        `(function () { const el = document.querySelector('[data-testid="folded-section-header"]'); if (el) el.scrollIntoView({ block: 'center' }) })()`
      )
      await page.waitForTimeout(400)
      const setup2: any = await page.evaluate(`(${FN_SETUP_SRC})(${JSON.stringify({ mode })})`)
      const p2 = setup2.point
      await page.mouse.move(p2.x, p2.y)
      await page.waitForTimeout(200)
      const movedSampler = page.evaluate(
        `(${FN_SAMPLER_SRC})(${JSON.stringify({ x: p2.x, y: p2.y, durationMs: 1400 })})`
      )
      await page.mouse.down()
      await page.mouse.up()
      movedCollapse = (await movedSampler) as any[]
      await writeText(`foldhover-${mode}-collapse-moved-frames.json`, JSON.stringify(movedCollapse, null, 1))
      log.push(
        `gesture[${mode}] moved-pointer collapse frames=${movedCollapse.length} last=${JSON.stringify(movedCollapse[movedCollapse.length - 1].shellState)} point=${JSON.stringify(p2)}`
      )
      await capture(`foldhover-${mode}-collapsed-moved`)
    }

    // Highlight persistence across the settle boundary: 700ms of samples with
    // the pointer untouched (no gesture at all) so a delayed drop is visible.
    const holdSampler = page.evaluate(`(${FN_SAMPLER_SRC})(${JSON.stringify({ x, y, durationMs: 700 })})`)
    const holdFrames: any[] = (await holdSampler) as any[]
    await writeText(`foldhover-${mode}-hold-frames.json`, JSON.stringify(holdFrames, null, 1))
    return {
      mode,
      point: { x, y },
      setup,
      beforeExpand,
      afterExpand,
      afterCollapse,
      holdFrames,
      expandFrames,
      collapseFrames,
      movedCollapse
    }
  }

  const railGesture = await runGesture('rail')
  const textGesture = await runGesture('text')

  const summarize = (gesture: any) => {
    const brief = (frames: any[]) => {
      const out: any = {
        n: frames.length,
        phases: [] as any[],
        region: [] as any[],
        mounted: [] as any[],
        anoms: [] as any[],
        domSet: [] as any[]
      }
      let prev: any = null
      for (const f of frames) {
        if (!prev || prev.phase !== f.phase)
          out.phases.push({
            t: f.t,
            phase: f.phase,
            shellState: f.shellState,
            bodyRole: f.body.role,
            anims: f.anims.length,
            mounted: f.mounted
          })
        if (!prev || prev.regionActive !== f.regionActive)
          out.region.push({
            t: f.t,
            regionActive: f.regionActive,
            hoverHit: f.hover.hit,
            hoverLabel: f.hover.label,
            lineBg: f.colors.lineBg,
            labelColor: f.colors.labelColor,
            pointerInsideHit: f.pointer.insideHit,
            target: f.pointer.target
          })
        if (!prev || prev.mounted !== f.mounted)
          out.mounted.push({ t: f.t, mounted: f.mounted, turns: f.mountedTurns.join(','), phase: f.phase })
        if (!prev || JSON.stringify(prev.ident) !== JSON.stringify(f.ident))
          out.anoms.push({ t: f.t, ident: f.ident, tok: f.tok, bodyRole: f.body.role })
        if (!prev || prev.rowTok !== f.rowTok || prev.bodyKidsTok !== f.bodyKidsTok)
          out.domSet.push({
            t: f.t,
            rowTok: f.rowTok,
            bodyKidsTok: f.bodyKidsTok,
            mounted: f.mounted,
            bodyIdent: f.ident.body,
            phase: f.phase,
            bodyRole: f.body.role
          })
        prev = f
      }
      out.first = frames[0]
      out.last = frames[frames.length - 1]
      return out
    }
    return {
      mode: gesture.mode,
      point: gesture.point,
      expand: brief(gesture.expandFrames),
      collapse: brief(gesture.collapseFrames),
      hold: brief(gesture.holdFrames),
      movedCollapse: gesture.movedCollapse ? brief(gesture.movedCollapse) : null
    }
  }

  await writeText(
    'foldhover-summary.json',
    JSON.stringify({ rail: summarize(railGesture), text: summarize(textGesture) }, null, 1)
  )
  await writeText('foldhover-log.txt', log.join('\n') + '\n')
}
