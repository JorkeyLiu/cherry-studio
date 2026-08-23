/**
 * S6.2a Windowed grouped — INTEGRATED UI regression for canonical viewport grouping.
 *
 * Purpose: Prove grouped data renders as complete canonical groups through real
 * topic activation / Redux / DOM, including complete multi-message group membership
 * and separate non-consecutive same-askId runs.
 *
 * Canonical viewport group = consecutive assistant messages sharing a non-empty
 * askId; all other messages are singleton groups.
 *
 * Evidence tier: INTEGRATED via standard electron fixture, disposable profile,
 * mock provider, approved ensureTopic/pasteMessagesToTopic seeding, real
 * HomePage topic activation, real Redux projection and real DOM assertion.
 * Does NOT claim diagnostic observation as regression proof.
 *
 * Uses existing chatdb window contract only (R-02/R-03/R-04) with 1..100 bounds,
 * no new IPC channel/field.
 */

import { expect, test } from '../../fixtures/electron.fixture'

const DISPLAY_LIMIT = 20

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

async function prepareDisplayCountAndAssistant(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, DISPLAY_LIMIT)
  const displayOk = await page.evaluate(
    (limit: number) => (window as any).store.getState().messages.displayCount,
    DISPLAY_LIMIT
  )
  expect(displayOk).toBe(DISPLAY_LIMIT)
  const liveAssistantId = await page.evaluate(
    () =>
      (window as any).store.getState().assistants?.assistants?.[0]?.id ??
      (window as any).store.getState().assistants?.defaultAssistant?.id ??
      null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

async function seedGroupedIntegratedTopic(
  page: any,
  liveAssistantId: string,
  topicId: string
): Promise<{
  ids: string[]
  askX: string
  groups: string[][]
}> {
  const name = `Grouped Integrated ${topicId}`
  // Chronological 8 messages, 6 canonical groups:
  // G0 [u1] singleton, G1 [a1,a2,a3] askX, G2 [u2], G3 [b1,b2] askY, G4 [u3], G5 [c1,c2] askX again (duplicate non-consecutive)
  const askX = `${topicId}-askX`
  const askY = `${topicId}-askY`
  const u1 = `${topicId}-msg-${pad(1, 5)}`
  const a1 = `${topicId}-msg-${pad(2, 5)}`
  const a2 = `${topicId}-msg-${pad(3, 5)}`
  const a3 = `${topicId}-msg-${pad(4, 5)}`
  const u2 = `${topicId}-msg-${pad(5, 5)}`
  const b1 = `${topicId}-msg-${pad(6, 5)}`
  const b2 = `${topicId}-msg-${pad(7, 5)}`
  const u3 = `${topicId}-msg-${pad(8, 5)}`
  // reuse askX for later group
  const c1 = `${topicId}-msg-${pad(9, 5)}`
  const c2 = `${topicId}-msg-${pad(10, 5)}`
  const orderedIds = [u1, a1, a2, a3, u2, b1, b2, u3, c1, c2]
  // For this spec we want 10 messages, 6 groups: but we described 8 earlier; adjust to 10 for more realistic
  // Actually we have 10 ids (u1 +3 + u2 +2 + u3 +2 =10). Groups =6, still within DISPLAY_LIMIT 20 so whole topic visible.

  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  const makeEntry = (id: string, role: string, askId: string | undefined, sortOrder: number) => {
    const blockId = `${id}-block`
    const msg: Record<string, unknown> = {
      id,
      topicId,
      role,
      assistantId: liveAssistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      sortOrder
    }
    if (askId) msg.askId = askId
    if (role === 'assistant') {
      ;(msg as any).model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      ;(msg as any).modelId = 'mock-model'
    }
    return {
      message: msg,
      blocks: [
        {
          id: blockId,
          messageId: id,
          type: 'main_text',
          content: `content-${id}`,
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    }
  }

  let idx = 0
  entries.push(makeEntry(u1, 'user', undefined, idx++))
  entries.push(makeEntry(a1, 'assistant', askX, idx++))
  entries.push(makeEntry(a2, 'assistant', askX, idx++))
  entries.push(makeEntry(a3, 'assistant', askX, idx++))
  entries.push(makeEntry(u2, 'user', undefined, idx++))
  entries.push(makeEntry(b1, 'assistant', askY, idx++))
  entries.push(makeEntry(b2, 'assistant', askY, idx++))
  entries.push(makeEntry(u3, 'user', undefined, idx++))
  entries.push(makeEntry(c1, 'assistant', askX, idx++))
  entries.push(makeEntry(c2, 'assistant', askX, idx++))

  const addOk = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
        const store = (window as any).store
        store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: {
              id: topicId,
              assistantId,
              name,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, name }
  )
  expect(addOk.ok, `addTopic failed: ${(addOk as any).err}`).toBe(true)

  const persist = await page.evaluate(
    async ({
      topicId,
      assistantId,
      name,
      entries
    }: {
      topicId: string
      assistantId: string
      name: string
      entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
    }) => {
      try {
        const api = (window as any).api as any
        const chatDb = api?.chatDb
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function') {
          return { ok: false, err: 'chatDb missing' }
        }
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, name, entries }
  )
  expect(persist.ok, `persist failed: ${(persist as any).err}`).toBe(true)

  const groups = [[u1], [a1, a2, a3], [u2], [b1, b2], [u3], [c1, c2]]
  return { ids: orderedIds, askX, groups }
}

async function activateTopicAndWait(page: any, topicId: string, expectedCount: number): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()

  await page.waitForFunction(
    ({ topicId, expected }: { topicId: string; expected: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length === expected && loading !== true
    },
    { topicId, expected: expectedCount },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected: number) => document.querySelectorAll('#messages .message[data-message-id]').length === expected,
    expectedCount,
    { timeout: 30000 }
  )
}

test.describe('windowed grouped integrated — canonical Redux/DOM projection', () => {
  test.setTimeout(180000)

  test('renders complete canonical groups with unique DOM ids for duplicate askId runs', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED E2E: grouped topic with multi-message groups and non-consecutive same-askId duplicate proves canonical displayGroups → projectMessageViewportGroups → Redux/DOM: complete per-run membership, separate groups for same askId, unique deterministic outer DOM ids, no merge/split. Standard fixture, disposable profile, mock provider, real topic activation.'
    })

    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `grp-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const seeded = await seedGroupedIntegratedTopic(page, liveAssistantId, topicId)
    const expectedTotal = seeded.ids.length
    const expectedGroupCount = seeded.groups.length

    await activateTopicAndWait(page, topicId, expectedTotal)

    const projection = await page.evaluate(
      ({ topicId, seededIds, seededGroups }: { topicId: string; seededIds: string[]; seededGroups: string[][] }) => {
        const s = (window as any).store.getState()
        const reduxIds: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        const entities: Record<string, any> = s.messages?.entities ?? {}
        // DOM message ids — only actual message containers (`.message[data-message-id]`), not answer-group avatar selectors (`[data-testid="answer-group-selector"][data-message-id]`)
        const domIds: string[] = Array.from(document.querySelectorAll('#messages .message[data-message-id]')).map(
          (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
        )
        // DOM group containers via data-stable-group-id (rendered by MessagesContent)
        const stableContainers = Array.from(
          document.querySelectorAll('#messages [data-stable-group-id]')
        ) as HTMLElement[]
        const domStableIds: string[] = stableContainers.map((el) => el.getAttribute('data-stable-group-id') || '')
        // Outer MessageGroup DOM ids
        const outerGroupEls = Array.from(document.querySelectorAll('#messages [id^="message-group-"]')) as HTMLElement[]
        const outerDomIds: string[] = outerGroupEls.map((el) => el.id)

        // Re-derive canonical groups from Redux store order (chronological sortOrder)
        const encode = (id: string) => `${id.length}:${id}`
        const deriveStable = (ids: string[]) => {
          if (ids.length === 0) return 'group:empty'
          return ids.map(encode).join('|')
        }
        const getSemanticKey = (msg: any) =>
          msg.role === 'assistant' && msg.askId ? `assistant:${msg.askId}` : `message:${msg.role}:${msg.id}`
        const canonicalGroups: Array<{ key: string; stable: string; ids: string[]; semantic: string }> = []
        let cur: any = null
        for (let i = 0; i < seededIds.length; i++) {
          const id = seededIds[i]
          const msg = entities[id]
          if (!msg) continue
          const semantic = getSemanticKey(msg)
          if (!cur || cur.semantic !== semantic) {
            const groupIds: string[] = []
            const key = `${semantic}:${id}`
            cur = { key, semantic, ids: groupIds, stable: '' }
            canonicalGroups.push(cur)
          }
          cur.ids.push(id)
        }
        // compute stable for each
        canonicalGroups.forEach((g) => (g.stable = deriveStable(g.ids)))
        const expectedStableSet = new Set(canonicalGroups.map((g) => g.stable))

        // per-group DOM membership: for each stable container, count inner message ids — only `.message[data-message-id]` inside group, excluding avatar selectors
        const domGroupsDetail = stableContainers.map((container) => {
          const stable = container.getAttribute('data-stable-group-id') || ''
          const inner = Array.from(container.querySelectorAll('.message[data-message-id]')).map(
            (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
          )
          // MessageGroup outer container is inside stable wrapper? Actually stable wrapper contains MessageGroup.
          // So inner should be within this wrapper.
          return { stable, innerCount: inner.length, innerIds: inner }
        })

        // Also collect MessageGroup outer ids inside stable wrappers for uniqueness
        const domGroupOuterDetail = outerGroupEls.map((el) => {
          const id = el.id
          const stable = el.getAttribute('data-stable-group-id') || ''
          return { id, stable }
        })

        return {
          reduxIds,
          domIds,
          domStableIds,
          outerDomIds,
          canonicalGroups,
          expectedStableSet: Array.from(expectedStableSet),
          domGroupsDetail,
          domGroupOuterDetail,
          seededGroups
        }
      },
      { topicId, seededIds: seeded.ids, seededGroups: seeded.groups }
    )

    // Redux contains all seeded ids in chronological order
    expect(projection.reduxIds).toEqual(seeded.ids)
    expect(new Set(projection.reduxIds).size).toBe(projection.reduxIds.length)

    // DOM message count matches
    expect(projection.domIds.length).toBe(expectedTotal)
    expect([...projection.domIds].sort()).toEqual([...seeded.ids].sort())
    expect(new Set(projection.domIds).size).toBe(expectedTotal)

    // Canonical groups: 6 groups, with correct membership
    expect(projection.canonicalGroups.length).toBe(expectedGroupCount)
    expect(projection.canonicalGroups.map((g: any) => g.ids)).toEqual(seeded.groups)
    // Two groups share same askX semantic but remain separate
    const askXGroups = projection.canonicalGroups.filter((g: any) => g.semantic === `assistant:${seeded.askX}`)
    expect(askXGroups).toHaveLength(2)
    expect(askXGroups[0].ids).toEqual(seeded.groups[1])
    expect(askXGroups[1].ids).toEqual(seeded.groups[5])
    expect(askXGroups[0].key).not.toBe(askXGroups[1].key)
    expect(askXGroups[0].stable).not.toBe(askXGroups[1].stable)

    // DOM stable containers: one per canonical group, newest-first handled at projection layer but stable set matches
    expect(projection.domStableIds.length).toBe(expectedGroupCount)
    expect(new Set(projection.domStableIds).size).toBe(expectedGroupCount)
    const expectedStables = new Set(projection.canonicalGroups.map((g: any) => g.stable))
    for (const sid of projection.domStableIds) {
      expect(expectedStables.has(sid), `unexpected stable id ${sid}`).toBe(true)
    }

    // Outer DOM ids: unique and deterministic per membership (duplicate askId fix)
    expect(projection.outerDomIds.length).toBe(expectedGroupCount)
    expect(new Set(projection.outerDomIds).size).toBe(expectedGroupCount)
    // Each outer id must be message-group-<stable with sanitized :/|>
    for (const oid of projection.outerDomIds) {
      expect(oid.startsWith('message-group-')).toBe(true)
      expect(oid).not.toContain(':')
      expect(oid).not.toContain('|')
      expect(oid.length).toBeGreaterThan('message-group-'.length)
    }
    // The two duplicate askX groups must have distinct outer ids
    const encode = (id: string) => `${id.length}:${id}`
    const deriveStable = (ids: string[]) => ids.map(encode).join('|')
    const sanitize = (stable: string) =>
      `message-group-${stable.replace(/[:|]/g, (ch: string) => (ch === ':' ? '-' : '_'))}`
    const expectedOuterForGroup = (ids: string[]) => sanitize(deriveStable(ids))
    const outerA = expectedOuterForGroup(seeded.groups[1])
    const outerB = expectedOuterForGroup(seeded.groups[5])
    expect(outerA).not.toBe(outerB)
    expect(projection.outerDomIds).toContain(outerA)
    expect(projection.outerDomIds).toContain(outerB)

    // Per-group DOM membership completeness: each DOM group contains exactly its canonical members oldest-first
    for (const g of projection.canonicalGroups) {
      const domGroup = projection.domGroupsDetail.find((d: any) => d.stable === g.stable)
      expect(domGroup, `dom group missing for stable ${g.stable}`).toBeTruthy()
      // inner ids should match canonical ids set (order oldest-first within group)
      expect(domGroup!.innerIds.sort()).toEqual([...g.ids].sort())
      expect(domGroup!.innerCount).toBe(g.ids.length)
      // If multi-message, ensure oldest-first order as in canonical (a1 before a2)
      if (g.ids.length > 1) {
        expect(domGroup!.innerIds).toEqual(g.ids)
      }
    }

    // No inner message id duplication
    const allInner = projection.domGroupsDetail.flatMap((d: any) => d.innerIds)
    expect(new Set(allInner).size).toBe(expectedTotal)
  })
})
