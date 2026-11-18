/** Isolated FoldedSection browse-motion observation: 5-turn fixture, true Main setTurnFolds, reload. */
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
      const topicId = 'foldmotion-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      store.dispatch({ type: 'assistants/addTopic', payload: { assistantId, topic: { id: topicId, assistantId, name: 'foldmotion ' + topicId, createdAt: stamp, updatedAt: stamp } } })
      const uid = (turn) => topicId + '-msg-' + String(turn).padStart(5, '0')
      const entries = []
      for (let turn = 1; turn <= turns; turn++) {
        const user = uid(turn)
        const assistant = user + '-a'
        entries.push({ message: { id: user, topicId, role: 'user', createdAt: stamp, updatedAt: stamp, status: 'success', blocks: [user + '-block'], sortOrder: (turn - 1) * 2 }, blocks: [{ id: user + '-block', messageId: user, type: 'main_text', content: 'foldmotion-turn-' + turn + '-user', status: 'success', createdAt: stamp, updatedAt: stamp }] })
        entries.push({ message: { id: assistant, topicId, role: 'assistant', createdAt: stamp, updatedAt: stamp, status: 'success', blocks: [assistant + '-block'], sortOrder: (turn - 1) * 2 + 1, assistantId, askId: user, model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }, modelId: 'mock-model' }, blocks: [{ id: assistant + '-block', messageId: assistant, type: 'main_text', content: 'foldmotion-turn-' + turn + '-assistant body ' + 'filler '.repeat(20), status: 'success', createdAt: stamp, updatedAt: stamp }] })
      }
      const api = window.api.chatDb
      const ensured = await api.ensureTopic({ topicId, assistantId, name: 'foldmotion ' + topicId })
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

const FN_INITIAL_SRC = `function () {
  const shell = document.querySelector('[data-testid="folded-section-collapsed"]')
  const phased = document.querySelector('[data-browse-phase]')
  const box = phased || (shell ? shell.lastElementChild : null)
  let anims = -1
  try { anims = (box && typeof box.getAnimations === 'function') ? box.getAnimations().length : -1 } catch (e) { anims = -2 }
  const cs = box ? getComputedStyle(box) : null
  const msgIds = Array.from(document.querySelectorAll('#messages [data-message-id]')).map((e) => e.getAttribute('data-message-id'))
  const ref = document.querySelector('#messages [data-message-id]')
  const shellRect = shell ? shell.getBoundingClientRect() : null
  return {
    shellFound: !!shell, phasedFound: !!phased, phase: phased ? phased.getAttribute('data-browse-phase') : null,
    animCount: anims, computedHeight: cs ? cs.height : null, computedOpacity: cs ? cs.opacity : null,
    boxRect: box ? { h: +box.getBoundingClientRect().height.toFixed(2), x: +box.getBoundingClientRect().left.toFixed(2) } : null,
    shellH: shellRect ? +shellRect.height.toFixed(2) : null, mounted: msgIds.length,
    hasTurn3: msgIds.some((id) => !!id && id.indexOf('-msg-00003') >= 0),
    hasTurn4: msgIds.some((id) => !!id && id.indexOf('-msg-00004') >= 0),
    refX: ref ? +ref.getBoundingClientRect().left.toFixed(2) : null,
    reduced: (typeof window.matchMedia === 'function') ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : 'no-matchMedia'
  }
}`

const FN_SAMPLER_SRC = `function () {
  return new Promise((resolve) => {
    const frames = []
    const t0 = performance.now()
    const step = () => {
      const now = performance.now()
      const phased = document.querySelector('[data-browse-phase]')
      const shell = document.querySelector('[data-fold-shell="true"]')
      const box = phased || (shell ? shell.lastElementChild : null)
      let animCount = -1
      let playStates = []
      try {
        if (box && typeof box.getAnimations === 'function') {
          const a = box.getAnimations()
          animCount = a.length
          playStates = a.map((x) => x.playState)
        }
      } catch (e) { animCount = -2 }
      let csH = null, csO = null, h = null, x = null
      try {
        if (box) {
          const cs = getComputedStyle(box)
          csH = cs.height; csO = cs.opacity
          const r = box.getBoundingClientRect()
          h = +r.height.toFixed(2); x = +r.left.toFixed(2)
        }
      } catch (e) {}
      const msgIds = Array.from(document.querySelectorAll('#messages [data-message-id]')).map((e) => e.getAttribute('data-message-id'))
      const ref = document.querySelector('#messages [data-message-id]')
      frames.push({
        t: +(now - t0).toFixed(1),
        shellTestId: shell ? shell.getAttribute('data-testid') : null,
        phase: phased ? phased.getAttribute('data-browse-phase') : null,
        animCount, playStates, csH, csO, h, x,
        mounted: msgIds.length,
        refX: ref ? +ref.getBoundingClientRect().left.toFixed(2) : null
      })
      if (now - t0 < 1600) requestAnimationFrame(step)
      else resolve(frames)
    }
    requestAnimationFrame(step)
  })
}`

const FN_SETTLED_EXPANDED_SRC = `function () {
  const shell = document.querySelector('[data-testid="folded-section-expanded"]')
  const phased = document.querySelector('[data-browse-phase]')
  const box = phased || (shell ? shell.lastElementChild : null)
  let anims = -1
  try { anims = (box && typeof box.getAnimations === 'function') ? box.getAnimations().length : -1 } catch (e) { anims = -2 }
  const msgIds = Array.from(document.querySelectorAll('#messages [data-message-id]')).map((e) => e.getAttribute('data-message-id'))
  return {
    phasedFound: !!phased, phase: phased ? phased.getAttribute('data-browse-phase') : null, animCount: anims,
    mounted: msgIds.length, hasTurn3: msgIds.some((id) => !!id && id.indexOf('-msg-00003') >= 0),
    shellH: shell ? +shell.getBoundingClientRect().height.toFixed(2) : null,
    opacity: box ? getComputedStyle(box).opacity : null
  }
}`

const FN_SETTLED_COLLAPSED_SRC = `function () {
  const shell = document.querySelector('[data-testid="folded-section-collapsed"]')
  const phased = document.querySelector('[data-browse-phase]')
  return {
    phasedFound: !!phased, phase: phased ? phased.getAttribute('data-browse-phase') : null,
    mounted: document.querySelectorAll('#messages [data-message-id]').length
  }
}`

const FN_RM_SRC = `function () {
  return {
    hasMatchMedia: typeof window.matchMedia === 'function',
    matches: (typeof window.matchMedia === 'function') ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : null,
    hasGetAnimations: typeof HTMLElement.prototype.getAnimations === 'function'
  }
}`

const FN_RM_PROBE_SRC = `function () {
  return {
    expanded: !!document.querySelector('[data-testid="folded-section-expanded"]'),
    phased: !!document.querySelector('[data-browse-phase]'),
    phase: (document.querySelector('[data-browse-phase]') || {}).getAttribute ? document.querySelector('[data-browse-phase]').getAttribute('data-browse-phase') : null
  }
}`

export default async function observe({ page, capture, writeText }: ObservationContext) {
  const log: string[] = []
  const seed: any = await page.evaluate(`(${FN_SEED_SRC})(${SEED_TURNS})`)
  if (!seed || seed.ok !== true) throw new Error('seed failed: ' + JSON.stringify(seed))
  const topicId: string = seed.topicId
  const turn3: string = seed.turn3
  const turn4: string = seed.turn4
  log.push(`seed ok topic=${topicId} turn3=${turn3} turn4=${turn4}`)

  const pollTrue = async (callSrc: string, timeoutMs: number, label: string) => {
    const start = Date.now()
    for (;;) {
      const v: any = await page.evaluate(callSrc)
      if (v === true) return
      if (Date.now() - start > timeoutMs) throw new Error('wait timeout: ' + label + ' src=' + callSrc.slice(0, 120))
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
  await capture('foldmotion-seeded')

  const foldRes: any = await page.evaluate(`(${FN_FOLD_SRC})(${JSON.stringify({ tid: topicId, ids: [turn3, turn4] })})`)
  log.push(`setTurnFolds response: ${JSON.stringify(foldRes)}`)
  const foldOk = (foldRes && (foldRes.folded === true || (foldRes.value && foldRes.value.folded === true))) === true
  if (!foldOk) throw new Error('true Main setTurnFolds failed: ' + JSON.stringify(foldRes))
  await page.reload()
  await page.waitForTimeout(2500)
  await pollTrue(`(function () { return !!(window.store && window.api) })()`, 30000, 'reload ready')
  await page.waitForTimeout(2500)
  await activate(SEED_TURNS * 2, (SEED_TURNS - 2) * 2)
  await capture('foldmotion-collapsed-initial')

  const collapsed = page.locator('[data-testid="folded-section-collapsed"]')
  await collapsed.first().waitFor({ state: 'visible', timeout: 30000 })
  const initial: any = await page.evaluate(`(${FN_INITIAL_SRC})()`)
  log.push(`collapsed-initial: ${JSON.stringify(initial)}`)

  await collapsed.first().scrollIntoViewIfNeeded()
  const expandSampler = page.evaluate(`(${FN_SAMPLER_SRC})()`)
  await page
    .locator('[data-testid="folded-section-collapsed"] [data-testid="folded-section-expand-btn"]')
    .first()
    .click()
  const expandFrames: any[] = (await expandSampler) as any[]
  log.push(
    `expand-frames n=${expandFrames.length} first=${JSON.stringify(expandFrames[0])} mid=${JSON.stringify(expandFrames[Math.floor(expandFrames.length / 2)])} last=${JSON.stringify(expandFrames[expandFrames.length - 1])}`
  )
  await writeText('foldmotion-expand-frames.json', JSON.stringify(expandFrames, null, 1))
  await page.locator('[data-testid="folded-section-expanded"]').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(800)
  await capture('foldmotion-expanded-settled')
  const expandedSettled: any = await page.evaluate(`(${FN_SETTLED_EXPANDED_SRC})()`)
  log.push(`expanded-settled: ${JSON.stringify(expandedSettled)}`)

  const expandedLabel = page.locator(
    '[data-testid="folded-section-expanded"] [data-testid="folded-section-expand-label"]'
  )
  await expandedLabel.first().scrollIntoViewIfNeeded()
  const collapseSampler = page.evaluate(`(${FN_SAMPLER_SRC})()`)
  await expandedLabel.first().click()
  const collapseFrames: any[] = (await collapseSampler) as any[]
  log.push(
    `collapse-frames n=${collapseFrames.length} first=${JSON.stringify(collapseFrames[0])} mid=${JSON.stringify(collapseFrames[Math.floor(collapseFrames.length / 2)])} last=${JSON.stringify(collapseFrames[collapseFrames.length - 1])}`
  )
  await writeText('foldmotion-collapse-frames.json', JSON.stringify(collapseFrames, null, 1))
  await page.locator('[data-testid="folded-section-collapsed"]').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(800)
  await capture('foldmotion-collapsed-settled')
  const collapsedSettled: any = await page.evaluate(`(${FN_SETTLED_COLLAPSED_SRC})()`)
  log.push(`collapsed-settled: ${JSON.stringify(collapsedSettled)}`)

  const rm: any = await page.evaluate(`(${FN_RM_SRC})()`)
  log.push(`reduced-motion runtime: ${JSON.stringify(rm)}`)
  let emulateResult = 'not-attempted'
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const rm2: any = await page.evaluate(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`)
    emulateResult = `emulated matches=${rm2}`
    await page
      .locator('[data-testid="folded-section-collapsed"] [data-testid="folded-section-expand-label"]')
      .first()
      .click()
    await page.waitForTimeout(900)
    const rmState: any = await page.evaluate(`(${FN_RM_PROBE_SRC})()`)
    log.push(`reduced-motion expand probe: ${JSON.stringify(rmState)}`)
    await capture('foldmotion-reduced-probe')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  } catch (e) {
    emulateResult = `emulate-failed: ${e instanceof Error ? e.message : String(e)}`
  }
  log.push(`reduced-motion emulate: ${emulateResult}`)
  await writeText('foldmotion-log.txt', log.join('\n') + '\n')
}
