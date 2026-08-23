/**
 * Windowed reads — grouped-array regression for R-02/R-03/R-04 bounded fix.
 *
 * Verifies Main fetchMessagesWindow counts complete rendered/message groups,
 * not raw messages. A group is consecutive assistant messages sharing a
 * non-empty askId; all other messages are singleton groups.
 *
 * Evidence tier: CONTRACT via real preload/Main `window.api.chatDb.fetchMessagesWindow`
 * through production build, disposable profile, mock provider. Does not claim
 * renderer merge/scroll UI (that is covered by the companion integrated spec).
 *
 * Uses standard fixture only, approved ensureTopic/pasteMessagesToTopic seeding,
 * existing chatdb:fetch-messages-window contract (1..100 validation bounds),
 * no new channel/field/SQL/cursor/window-size/cap/eviction semantics.
 */

import { expect, test } from '../../fixtures/electron.fixture'

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

async function prepareAssistant(page: any): Promise<string> {
  const liveAssistantId = await page.evaluate(
    () =>
      (window as any).store.getState().assistants?.assistants?.[0]?.id ??
      (window as any).store.getState().assistants?.defaultAssistant?.id ??
      null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

async function seedGroupedTopic(
  page: any,
  liveAssistantId: string,
  topicId: string
): Promise<{
  u1: string
  a1: string
  a2: string
  a3: string
  u2: string
  b1: string
  b2: string
  u3: string
  askA: string
  askB: string
}> {
  const askA = `${topicId}-askA`
  const askB = `${topicId}-askB`
  const ids = {
    u1: `${topicId}-msg-${pad(1, 5)}`,
    a1: `${topicId}-msg-${pad(2, 5)}`,
    a2: `${topicId}-msg-${pad(3, 5)}`,
    a3: `${topicId}-msg-${pad(4, 5)}`,
    u2: `${topicId}-msg-${pad(5, 5)}`,
    b1: `${topicId}-msg-${pad(6, 5)}`,
    b2: `${topicId}-msg-${pad(7, 5)}`,
    u3: `${topicId}-msg-${pad(8, 5)}`
  }
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []

  const makeEntry = (id: string, role: string, askId?: string) => {
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
      sortOrder: entries.length
    }
    if (askId) msg.askId = askId
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

  entries.push(makeEntry(ids.u1, 'user'))
  entries.push(makeEntry(ids.a1, 'assistant', askA))
  entries.push(makeEntry(ids.a2, 'assistant', askA))
  entries.push(makeEntry(ids.a3, 'assistant', askA))
  entries.push(makeEntry(ids.u2, 'user'))
  entries.push(makeEntry(ids.b1, 'assistant', askB))
  entries.push(makeEntry(ids.b2, 'assistant', askB))
  entries.push(makeEntry(ids.u3, 'user'))

  const name = `Grouped Window Test ${topicId}`

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
  return { ...ids, askA, askB }
}

test.describe('windowed reads grouped — latest/around complete groups', () => {
  test.setTimeout(180000)

  test('latest counts groups (2 groups = 3 messages) and around includes anchor group without splitting', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CONTRACT E2E: grouped latest/around via real window.api.chatDb.fetchMessagesWindow. Seeds askId groups, probes latest group count and around group completeness. Does NOT prove renderer merge/scroll UI.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareAssistant(page)
    const topicId = `grp-window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedGroupedTopic(page, liveAssistantId, topicId)

    // latest limit 2 groups => G3(b1,b2) + G4(u3) = 3 messages, hasMoreBefore true
    const latest2: any = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
      },
      { topicId }
    )
    expect(latest2.ok).toBe(true)
    expect(latest2.value.window.kind).toBe('latest')
    expect(latest2.value.window.completeness).toBe('window')
    expect(latest2.value.window.requested.limit).toBe(2)
    expect(latest2.value.window.returnedCount).toBe(3)
    expect(latest2.value.messages.map((m: any) => m.id)).toEqual([ids.b1, ids.b2, ids.u3])
    expect(latest2.value.window.hasMoreBefore).toBe(true)
    expect(latest2.value.window.hasMoreAfter).toBe(false)

    // around b1 (group G3 size2) before 1 after 1 => G2(u2)+G3(b1,b2)+G4(u3) =4, never split G3
    const aroundB1: any = await page.evaluate(
      async ({ topicId, anchor }: { topicId: string; anchor: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: anchor, before: 1, after: 1 })
      },
      { topicId, anchor: ids.b1 }
    )
    expect(aroundB1.ok).toBe(true)
    expect(aroundB1.value.window.kind).toBe('around')
    expect(aroundB1.value.window.anchorMessageId).toBe(ids.b1)
    expect(aroundB1.value.messages.map((m: any) => m.id)).toEqual([ids.u2, ids.b1, ids.b2, ids.u3])
    expect(aroundB1.value.window.hasMoreBefore).toBe(true)
    expect(aroundB1.value.window.hasMoreAfter).toBe(false)

    // same group anchor b2 must return identical window (full group inclusion)
    const aroundB2: any = await page.evaluate(
      async ({ topicId, anchor }: { topicId: string; anchor: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: anchor, before: 1, after: 1 })
      },
      { topicId, anchor: ids.b2 }
    )
    expect(aroundB2.ok).toBe(true)
    expect(aroundB2.value.messages.map((m: any) => m.id)).toEqual(aroundB1.value.messages.map((m: any) => m.id))

    // around u2 before 1 after 1 => G1(3) + G2(1) + G3(2) =6, proves previous group not split (G1 size3)
    const aroundU2: any = await page.evaluate(
      async ({ topicId, anchor }: { topicId: string; anchor: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: anchor, before: 1, after: 1 })
      },
      { topicId, anchor: ids.u2 }
    )
    expect(aroundU2.ok).toBe(true)
    expect(aroundU2.value.messages.map((m: any) => m.id)).toEqual([ids.a1, ids.a2, ids.a3, ids.u2, ids.b1, ids.b2])
    expect(aroundU2.value.messages.length).toBe(6)

    // around a2 (inside G1 size3) before1 after1 => G0+G1+G2 =5
    const aroundA2: any = await page.evaluate(
      async ({ topicId, anchor }: { topicId: string; anchor: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: anchor, before: 1, after: 1 })
      },
      { topicId, anchor: ids.a2 }
    )
    expect(aroundA2.ok).toBe(true)
    expect(aroundA2.value.messages.map((m: any) => m.id)).toEqual([ids.u1, ids.a1, ids.a2, ids.a3, ids.u2])
    expect(aroundA2.value.window.hasMoreBefore).toBe(false)
    expect(aroundA2.value.window.hasMoreAfter).toBe(true)
  })
})
