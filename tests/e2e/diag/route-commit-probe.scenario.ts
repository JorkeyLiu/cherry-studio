/** Probe DOM after seeding: what fork/divider UI exists and where. */
import type { ObservationContext } from '../../../scripts/ui-observe/scenario'

const FN_SEED_SRC = `function () {
  return (async () => {
    const stamp = '2026-01-01T00:00:00.000Z'
    const topicId = 'diag-route-commit'
    const st = window.store.getState()
    const assistantId = (st.assistants && st.assistants.assistants && st.assistants.assistants[0] && st.assistants.assistants[0].id) || null
    if (!assistantId) return { ok: false, err: 'no assistant' }
    window.store.dispatch({ type: 'assistants/addTopic', payload: { assistantId, topic: { id: topicId, assistantId, name: 'diag route commit', createdAt: stamp, updatedAt: stamp } } })
    const api = window.api.chatDb
    await api.ensureTopic({ topicId, assistantId, name: 'diag route commit' })
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
    await api.upsertSegment({ segmentId: topicId + '-seg-span', topicId, name: 'diag span', messageIds: spanMembers })
    await api.upsertSegment({ segmentId: topicId + '-seg-child', topicId, branchId: childId, name: 'diag childonly', messageIds: [topicId + '-uc0', topicId + '-ac0', topicId + '-uc1'] })
    return { ok: true, topicId, childId }
  })()
}`

const FN_DUMP_SRC = `function () {
  const msgs = Array.from(document.querySelectorAll('#messages [data-message-id]')).map((e) => e.getAttribute('data-message-id'))
  const forks = Array.from(document.querySelectorAll('[data-testid^="branch-fork"]')).map((e) => e.getAttribute('data-testid'))
  const dividers = Array.from(document.querySelectorAll('[data-divider-key]')).map((e) => e.getAttribute('data-divider-key'))
  const groups = Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]')).map((e) => e.getAttribute('data-segment-id'))
  const conts = Array.from(document.querySelectorAll('[data-testid="topic-segment-rail-continuation"]')).map((e) => e.getAttribute('data-segment-id'))
  const sc = document.getElementById('messages')
  return { n: msgs.length, first: msgs[0], last: msgs[msgs.length - 1], anchorInDom: msgs.includes('diag-route-commit-a30'), forks, dividers, groups, conts, scrollTop: sc ? sc.scrollTop : -1, scrollH: sc ? sc.scrollHeight : -1, clientH: sc ? sc.clientHeight : -1 }
}`

export default async function observe({ page, capture, writeText }: ObservationContext) {
  const seed: any = await page.evaluate(`(${FN_SEED_SRC})()`)
  if (!seed || seed.ok !== true) throw new Error('seed failed: ' + JSON.stringify(seed))
  const item = page.locator('[data-testid="topic-item"][data-topic-id="diag-route-commit"]')
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await page.waitForTimeout(3000)
  const d0: any = await page.evaluate(`(${FN_DUMP_SRC})()`)
  const log: string[] = ['bottom-anchored: ' + JSON.stringify(d0)]
  await page.evaluate(
    `(function () { const sc = document.getElementById('messages'); if (sc) sc.scrollTo({ top: 0, behavior: 'instant' }); return true })()`
  )
  await page.waitForTimeout(3000)
  const d1: any = await page.evaluate(`(${FN_DUMP_SRC})()`)
  log.push('after scroll-top: ' + JSON.stringify(d1))
  await writeText('probe-dom.txt', log.join('\n'))
  await capture('probe-dom')
}
