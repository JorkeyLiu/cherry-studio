/**
 * Exclusive phase-unify probe: collapsed↔expanded with a single visual phase.
 * Anonymous only: geometry, opacity, animation counts, cursor, testids.
 * No text content, no DB paths, no screenshots.
 */
import type { ObservationContext } from '../../../scripts/ui-observe/scenario'

const SEED_TURNS = 5

const FN_SEED_SRC = `function (turns) {
  return (async () => {
    try {
      const store = window.store
      const assistantId = (store.getState().assistants && store.getState().assistants.assistants && store.getState().assistants.assistants[0] && store.getState().assistants.assistants[0].id) || null
      if (!assistantId) return { ok: false, err: 'no assistant' }
      store.dispatch({ type: 'newMessages/setDisplayCount', payload: 20 })
      const stamp = '2026-01-01T00:00:00.000Z'
      const topicId = 'foldphase-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      store.dispatch({ type: 'assistants/addTopic', payload: { assistantId, topic: { id: topicId, assistantId, name: 'foldphase ' + topicId, createdAt: stamp, updatedAt: stamp } } })
      const uid = (turn) => topicId + '-msg-' + String(turn).padStart(5, '0')
      const entries = []
      for (let turn = 1; turn <= turns; turn++) {
        const user = uid(turn)
        const assistant = user + '-a'
        entries.push({ message: { id: user, topicId, role: 'user', createdAt: stamp, updatedAt: stamp, status: 'success', blocks: [user + '-block'], sortOrder: (turn - 1) * 2 }, blocks: [{ id: user + '-block', messageId: user, type: 'main_text', content: 'foldphase-turn-' + turn + '-user', status: 'success', createdAt: stamp, updatedAt: stamp }] })
        entries.push({ message: { id: assistant, topicId, role: 'assistant', createdAt: stamp, updatedAt: stamp, status: 'success', blocks: [assistant + '-block'], sortOrder: (turn - 1) * 2 + 1, assistantId, askId: user, model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }, modelId: 'mock-model' }, blocks: [{ id: assistant + '-block', messageId: assistant, type: 'main_text', content: 'foldphase-turn-' + turn + '-assistant body ' + 'filler '.repeat(20), status: 'success', createdAt: stamp, updatedAt: stamp }] })
      }
      const api = window.api.chatDb
      const ensured = await api.ensureTopic({ topicId, assistantId, name: 'foldphase ' + topicId })
      if (!ensured || ensured.ok !== true) return { ok: false, err: 'ensureTopic' }
      const pasted = await api.pasteMessagesToTopic({ topicId, entries })
      if (!pasted || pasted.ok !== true) return { ok: false, err: 'paste' }
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

const FN_SETUP_SRC = `function (cfg) {
  const shell = document.querySelector('[data-fold-shell="true"]')
  if (!shell) return { ok: false, err: 'no fold shell' }
  const q = (sel) => { try { return shell.querySelector(sel) } catch (e) { return null } }
  const content = document.querySelector('[data-testid="folded-section-content"]')
  const body = document.querySelector('[data-testid="folded-section-body"]')
  const nodes = {
    shell,
    content,
    body,
    track: q('[data-testid="folded-section-rail-track"]'),
    line: q('[data-testid="folded-section-rail-line"]'),
    hit: shell.querySelector('[data-testid="folded-section-expand-btn"], [data-testid="folded-section-gutter-rail"]'),
    header: q('[data-testid="folded-section-header"]'),
    label: q('[data-testid="folded-section-expand-label"]')
  }
  const token = 'fp-' + Math.random().toString(36).slice(2, 10)
  for (const k of Object.keys(nodes)) { if (nodes[k]) nodes[k].__fpTok = token }
  window.__fp = { nodes, token }
  const labelRect = nodes.label.getBoundingClientRect()
  const hitRect = nodes.hit.getBoundingClientRect()
  const point = cfg.mode === 'text'
    ? { x: Math.round(labelRect.left + 3), y: Math.round(labelRect.top + labelRect.height / 2) }
    : { x: Math.round(hitRect.left + hitRect.width / 2), y: Math.round(hitRect.top + 8) }
  return { ok: true, token, point, labelRect: [labelRect.top, labelRect.height, labelRect.left, labelRect.width], hitRect: [hitRect.top, hitRect.height, hitRect.left, hitRect.width] }
}`

const FN_SAMPLER_SRC = `function (cfg) {
  return new Promise((resolve) => {
    const fp = window.__fp || {}
    const refs = fp.nodes || {}
    const token = fp.token
    const qShell = () => document.querySelector('[data-fold-shell="true"]')
    const q = (sel) => { try { return document.querySelector(sel) } catch (e) { return null } }
    const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [+r.top.toFixed(2), +r.height.toFixed(2), +r.left.toFixed(2), +r.width.toFixed(2)] }
    const px = cfg.x, py = cfg.y
    const t0 = performance.now()
    const frames = []
    const step = () => {
      const now = performance.now()
      const shell = qShell()
      const content = q('[data-testid="folded-section-content"]')
      const body = q('[data-testid="folded-section-body"]')
      const line = q('[data-testid="folded-section-rail-line"]')
      const label = q('[data-testid="folded-section-expand-label"]')
      const hit = document.querySelector('[data-testid="folded-section-expand-btn"], [data-testid="folded-section-gutter-rail"]')
      const track = q('[data-testid="folded-section-rail-track"]')
      const header = q('[data-testid="folded-section-header"]')
      const cur = { shell, content, body, line, label, hit, track, header }
      const ident = {}
      for (const k of Object.keys(cur)) ident[k] = cur[k] ? cur[k] === refs[k] : null
      const ccs = content ? getComputedStyle(content) : null
      const bcs = body ? getComputedStyle(body) : null
      let contentAnims = []
      let bodyAnims = []
      try { if (content && typeof content.getAnimations === 'function') contentAnims = content.getAnimations().map((a) => ({ s: a.playState, ct: a.currentTime === null ? null : +Number(a.currentTime).toFixed(1) })) } catch (e) { contentAnims = [{ s: 'ERR' }] }
      try { if (body && typeof body.getAnimations === 'function') bodyAnims = body.getAnimations().map((a) => ({ s: a.playState, ct: a.currentTime === null ? null : +Number(a.currentTime).toFixed(1) })) } catch (e) { bodyAnims = [{ s: 'ERR' }] }
      const under = document.elementFromPoint(px, py)
      let cursor = null, targetKind = null, targetTid = null, inShell = null
      if (under) {
        try { cursor = getComputedStyle(under).cursor } catch (e) { cursor = 'ERR' }
        targetKind = under.tagName || null
        try { const c = under.closest('[data-testid]'); targetTid = c ? c.getAttribute('data-testid') : null } catch (e) { targetTid = 'ERR' }
        try { inShell = !!under.closest('[data-fold-shell="true"]') } catch (e) { inShell = null }
      }
      let aeTid = null
      try {
        const ae = document.activeElement
        if (ae) { const c = ae.closest ? ae.closest('[data-testid]') : null; aeTid = c ? c.getAttribute('data-testid') : (ae.tagName || null) }
      } catch (e) { aeTid = 'ERR' }
      const scroller = document.querySelector('#messages')
      frames.push({
        t: +(now - t0).toFixed(1),
        shellState: shell ? shell.getAttribute('data-testid') : null,
        regionActive: shell ? shell.getAttribute('data-fold-region-active') : null,
        contentPhase: content ? content.getAttribute('data-browse-phase') : null,
        contentMotion: content ? content.getAttribute('data-browse-motion') : null,
        contentExpanded: content ? content.getAttribute('data-browse-expanded') : null,
        bodyView: body ? body.getAttribute('data-browse-view') : null,
        bodyPhase: body ? body.getAttribute('data-browse-phase') : null,
        content: { opacity: ccs ? ccs.opacity : null, animName: ccs ? ccs.animationName : null, nAnims: contentAnims.length, anims: contentAnims.slice(0, 3), kids: content ? content.children.length : null, h: rectOf(content) ? rectOf(content)[1] : null },
        innerBody: { opacity: bcs ? bcs.opacity : null, animName: bcs ? bcs.animationName : null, nAnims: bodyAnims.length, anims: bodyAnims.slice(0, 3), kids: body ? body.children.length : null, pointerEvents: bcs ? bcs.pointerEvents : null, h: rectOf(body) ? rectOf(body)[1] : null },
        hover: { label: label ? label.matches(':hover') : null, hit: hit ? hit.matches(':hover') : null, shell: shell ? shell.matches(':hover') : null },
        focusTid: aeTid,
        pointer: { cursor, targetKind, targetTid, inShell },
        colors: { lineBg: line ? getComputedStyle(line).backgroundColor : null, labelColor: label ? getComputedStyle(label).color : null },
        ident,
        rects: { shell: rectOf(shell), track: rectOf(track), header: rectOf(header), label: rectOf(label), hit: rectOf(hit), content: rectOf(content), body: rectOf(body) },
        scroll: scroller ? +scroller.scrollTop.toFixed(2) : null,
        mounted: document.querySelectorAll('#messages [data-message-id]').length
      })
      if (now - t0 < cfg.durationMs) requestAnimationFrame(step)
      else resolve(frames)
    }
    requestAnimationFrame(step)
  })
}`

const FN_PROBE_SRC = `function () {
  const shell = document.querySelector('[data-fold-shell="true"]')
  const content = document.querySelector('[data-testid="folded-section-content"]')
  const body = document.querySelector('[data-testid="folded-section-body"]')
  const ae = document.activeElement
  let aeTid = null
  try { const c = ae && ae.closest ? ae.closest('[data-testid]') : null; aeTid = c ? c.getAttribute('data-testid') : (ae ? ae.tagName : null) } catch (e) {}
  return {
    shellState: shell ? shell.getAttribute('data-testid') : null,
    regionActive: shell ? shell.getAttribute('data-fold-region-active') : null,
    contentPhase: content ? content.getAttribute('data-browse-phase') : null,
    bodyView: body ? body.getAttribute('data-browse-view') : null,
    contentOpacity: content ? getComputedStyle(content).opacity : null,
    bodyOpacity: body ? getComputedStyle(body).opacity : null,
    focusTid: aeTid,
    mounted: document.querySelectorAll('#messages [data-message-id]').length
  }
}`

export default async function observe({ page, writeText }: ObservationContext) {
  const log: string[] = []
  const seed: any = await page.evaluate(`(${FN_SEED_SRC})(${SEED_TURNS})`)
  if (!seed || seed.ok !== true) throw new Error('seed failed')
  const topicId: string = seed.topicId
  const pollTrue = async (callSrc: string, timeoutMs: number, label: string) => {
    const start = Date.now()
    for (;;) {
      const v: any = await page.evaluate(callSrc)
      if (v === true) return
      if (Date.now() - start > timeoutMs) throw new Error('wait timeout: ' + label)
      await page.waitForTimeout(250)
    }
  }
  const activate = async (expectStoreMin: number, expectMountedMin: number) => {
    const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await item.waitFor({ state: 'visible', timeout: 30000 })
    await item.scrollIntoViewIfNeeded()
    await item.click()
    await pollTrue(
      `(function () { const s = window.store.getState(); const ids = s.messages && s.messages.messageIdsByTopic && s.messages.messageIdsByTopic[${JSON.stringify(topicId)}]; return Array.isArray(ids) && ids.length >= ${expectStoreMin} })()`,
      30000,
      'topic bootstrap'
    )
    await pollTrue(
      `(function () { return document.querySelectorAll('#messages [data-message-id]').length >= ${expectMountedMin} })()`,
      30000,
      'mounted rows'
    )
  }
  await activate(SEED_TURNS * 2, SEED_TURNS * 2)
  const foldRes: any = await page.evaluate(
    `(${FN_FOLD_SRC})(${JSON.stringify({ tid: topicId, ids: [seed.turn3, seed.turn4] })})`
  )
  log.push(
    `fold response ok=${foldRes && (foldRes.folded === true || (foldRes.value && foldRes.value.folded === true))}`
  )
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

  const runGesture = async (mode: 'rail' | 'text', durationMs: number) => {
    const setup: any = await page.evaluate(`(${FN_SETUP_SRC})(${JSON.stringify({ mode })})`)
    if (!setup || setup.ok !== true) throw new Error('setup failed ' + mode)
    const { x, y } = setup.point
    await page.mouse.move(x, y)
    await page.waitForTimeout(200)
    const sampler = page.evaluate(`(${FN_SAMPLER_SRC})(${JSON.stringify({ x, y, durationMs })})`)
    await page.mouse.down()
    await page.mouse.up()
    const frames: any[] = (await sampler) as any[]
    await writeText(`foldphase-${mode}-frames.json`, JSON.stringify(frames, null, 1))
    const probe: any = await page.evaluate(`(${FN_PROBE_SRC})()`)
    log.push(
      `gesture[${mode}] n=${frames.length} firstPhase=${frames[0].contentPhase} lastPhase=${frames[frames.length - 1].contentPhase} lastShell=${frames[frames.length - 1].shellState} probe=${JSON.stringify(probe)}`
    )
    return { mode, point: { x, y }, frames, probe }
  }

  // Fixed-point rail round-trip: expand then collapse at the SAME viewport
  // point with no pointer motion between gestures. Rail spans whole shell so
  // the point stays inside the hit target; label is contrast only.
  const railExpand = await runGesture('rail', 1400)
  await page.waitForTimeout(800)
  {
    const { x, y } = railExpand.point
    await page.mouse.move(x, y)
    await page.waitForTimeout(200)
    const sampler = page.evaluate(`(${FN_SAMPLER_SRC})(${JSON.stringify({ x, y, durationMs: 1400 })})`)
    await page.mouse.down()
    await page.mouse.up()
    const frames: any[] = (await sampler) as any[]
    await writeText('foldphase-rail-collapse-frames.json', JSON.stringify(frames, null, 1))
    const probe: any = await page.evaluate(`(${FN_PROBE_SRC})()`)
    log.push(
      `collapse[rail-fixed] n=${frames.length} firstPhase=${frames[0].contentPhase} lastPhase=${frames[frames.length - 1].contentPhase} lastShell=${frames[frames.length - 1].shellState} probe=${JSON.stringify(probe)}`
    )
  }
  await page.waitForTimeout(500)
  await runGesture('text', 1400)
  await writeText('foldphase-log.txt', log.join('\n') + '\n')
}
