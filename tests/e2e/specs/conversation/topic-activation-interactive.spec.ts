/**
 * Topic activation interactive while anchor pending — bounded regression.
 *
 * Production contract (messageThunk + anchorService):
 *   topic activation is interactively complete once the bounded latest window
 *   + segment catalog are atomically published; anchor establishment
 *   (`chatdb:resolve-context-closure` intend `establish`, `detail: 'anchor'`)
 *   is scheduled fire-and-forget after publication and never blocks loading.
 *
 * Evidence tier: INTEGRATED via standard fixture, disposable profile, mock
 * provider, approved ensureTopic/pasteMessagesToTopic seeding, real HomePage
 * topic activation, Redux/DOM/input proof while the anchor resolver is
 * deterministically held, then release + convergence proof.
 *
 * Determinism: a test-scoped E2E-only renderer gate
 * (`window.__e2eAnchorGate`, see anchorService `awaitE2EAnchorGateIfArmed`)
 * holds anchor establishment on a spec-controlled waiter list. No wall-clock
 * thresholds, no sleeps-to-race: every transition uses state-based
 * `waitForFunction` / auto-retrying `expect` (gate entered, Redux/DOM/loading,
 * anchor absent, then anchor converged). Production never creates the gate
 * key, so the check is inert outside this spec.
 *
 * Coverage (small topics only; far-jump/around is covered elsewhere):
 *   - cold miss: unloaded small topic (6 msgs) activates to a bounded latest
 *     window + exclusive DOM + editable input while anchor is still pending,
 *     then the anchor converges to the default position.
 *   - resident hit: the same topic re-activates from residency with the
 *     anchor cleared, stays interactive while pending, then converges again.
 *   - final anchor + typed context closure are correct in both phases.
 */

import { expect, test } from '../../fixtures/electron.fixture'

const DISPLAY_LIMIT = 20
const SMALL_TOTAL = 6

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

async function seedContextCount(page: any, assistantId: string, contextCount: number | null): Promise<void> {
  await page.evaluate(
    ({ assistantId, contextCount }: { assistantId: string; contextCount: number | null }) => {
      const store = (window as any).store
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId, settings: { contextCount } }
      })
    },
    { assistantId, contextCount }
  )
  const seeded = await page.evaluate((id: string) => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants.find((a: any) => a.id === id)
    return assistant?.settings?.contextCount ?? null
  }, assistantId)
  expect(seeded).toBe(contextCount)
}

async function seedSmallTopic(page: any, liveAssistantId: string, topicId: string): Promise<string[]> {
  const name = `Activation Interactive ${topicId}`
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

  const ids: string[] = []
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < SMALL_TOTAL; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    ids.push(msgId)
    const blockId = `${topicId}-block-${pad(i, 5)}`
    const isUser = i % 2 === 0
    const message: Record<string, unknown> = {
      id: msgId,
      topicId,
      role: isUser ? 'user' : 'assistant',
      assistantId: liveAssistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      sortOrder: i
    }
    if (!isUser) {
      ;(message as any).askId = `${topicId}-msg-${pad(i - 1, 5)}`
      ;(message as any).model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      ;(message as any).modelId = 'mock-model'
    }
    entries.push({
      message,
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: `activation-content-${pad(i, 5)}`,
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  }

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
  return ids
}

async function getPersistedAnchor(page: any, assistantId: string, topicId: string): Promise<string | null> {
  return page.evaluate(
    ({ assistantId, topicId }: { assistantId: string; topicId: string }) => {
      const s = (window as any).store.getState()
      const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
      const anchor = assistant?.settings?.contextWindowAnchor?.[topicId]
      return anchor?.kind === 'active' ? (anchor.groupKey as string) : null
    },
    { assistantId, topicId }
  )
}

async function clearPersistedAnchor(page: any, assistantId: string, topicId: string): Promise<void> {
  await page.evaluate(
    ({ assistantId, topicId }: { assistantId: string; topicId: string }) => {
      const store = (window as any).store
      const s = store.getState()
      const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
      const current = { ...(assistant?.settings?.contextWindowAnchor ?? {}) }
      delete current[topicId]
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId, settings: { contextWindowAnchor: current } }
      })
    },
    { assistantId, topicId }
  )
  expect(await getPersistedAnchor(page, assistantId, topicId)).toBeNull()
}

async function armAnchorGate(page: any): Promise<void> {
  await page.evaluate(() => {
    const g = ((window as any).__e2eAnchorGate = (window as any).__e2eAnchorGate || {})
    g.blocked = true
    if (typeof g.entered !== 'number') g.entered = 0
    if (!g.enteredByTopic || typeof g.enteredByTopic !== 'object') g.enteredByTopic = {}
    g.waiters = []
  })
}

async function getGateEnteredForTopic(page: any, topicId: string): Promise<number> {
  return page.evaluate(
    (tid: string) => ((window as any).__e2eAnchorGate?.enteredByTopic?.[tid] ?? 0) as number,
    topicId
  )
}

async function waitForGateEntered(page: any, topicId: string, prev: number): Promise<void> {
  await page.waitForFunction(
    ({ tid, prevCount }: { tid: string; prevCount: number }) =>
      ((window as any).__e2eAnchorGate?.enteredByTopic?.[tid] ?? 0) > prevCount,
    { tid: topicId, prevCount: prev },
    { timeout: 30000 }
  )
}

async function releaseAnchorGate(page: any): Promise<void> {
  await page.evaluate(() => {
    const g = (window as any).__e2eAnchorGate
    if (!g) return
    g.blocked = false
    const waiters = Array.isArray(g.waiters) ? g.waiters.splice(0) : []
    for (const r of waiters) {
      try {
        ;(r as () => void)()
      } catch {
        // best-effort release; waiter already settled
      }
    }
  })
}

async function clickTopic(page: any, topicId: string): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
}

async function waitForBoundedInteractive(page: any, topicId: string, expectedIds: string[]): Promise<void> {
  await page.waitForFunction(
    ({ tid, expected }: { tid: string; expected: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      if (s.messages?.currentTopicId !== tid) return false
      if (s.messages?.loadingByTopic?.[tid]) return false
      const ids = s.messages?.messageIdsByTopic?.[tid]
      return Array.isArray(ids) && ids.length === expected
    },
    { tid: topicId, expected: expectedIds.length },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected: number) => document.querySelectorAll('#messages [data-message-id]').length === expected,
    expectedIds.length,
    { timeout: 30000 }
  )
  const reduxIds = await page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    return [...(s.messages?.messageIdsByTopic?.[tid] ?? [])] as string[]
  }, topicId)
  expect(reduxIds).toEqual(expectedIds)
  const domIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
      (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
    )
  )
  expect([...domIds].sort()).toEqual([...expectedIds].sort())
}

async function expectInputEditableWhileBlocked(page: any): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await expect(textarea).toBeVisible({ timeout: 15000 })
  await expect(textarea).toBeEnabled({ timeout: 15000 })
  await textarea.fill('activation-interactive-draft')
  await expect(textarea).toHaveValue('activation-interactive-draft', { timeout: 5000 })
  await textarea.fill('')
  await expect(textarea).toHaveValue('', { timeout: 5000 })
}

async function waitForAnchorConverged(
  page: any,
  assistantId: string,
  topicId: string,
  expectedGroupKey: string
): Promise<void> {
  await page.waitForFunction(
    ({ aid, tid, expected }: { aid: string; tid: string; expected: string }) => {
      const s = (window as any).store?.getState()
      const assistant = s?.assistants?.assistants?.find((a: any) => a.id === aid)
      return assistant?.settings?.contextWindowAnchor?.[tid]?.groupKey === expected
    },
    { aid: assistantId, tid: topicId, expected: expectedGroupKey },
    { timeout: 30000 }
  )
  expect(await getPersistedAnchor(page, assistantId, topicId)).toBe(expectedGroupKey)
}

async function expectAnchorHighlight(page: any, expectedGroupKey: string): Promise<void> {
  await expect(async () => {
    const highlighted = await page.evaluate(() => {
      const ids: string[] = []
      const buttons = document.querySelectorAll('[data-testid="context-anchor-btn"][data-context-anchor-active="true"]')
      for (const button of buttons) {
        const container = button.closest('[data-message-id]')
        const id = container?.getAttribute('data-message-id') || ''
        if (id) ids.push(id)
      }
      return ids
    })
    if (highlighted.length !== 1 || highlighted[0] !== expectedGroupKey) {
      throw new Error(`expected exactly one highlight ${expectedGroupKey}, got ${JSON.stringify(highlighted)}`)
    }
  }).toPass({ timeout: 15000 })
}

async function expectClosureCorrect(
  page: any,
  topicId: string,
  anchorGroupKey: string,
  expectedIds: string[]
): Promise<void> {
  const res: any = await page.evaluate(
    async ({ tid, anchor }: { tid: string; anchor: string }) => {
      const api: any = (window as any).api.chatDb
      return await api.fetchContextClosure({ topicId: tid, anchorGroupKey: anchor })
    },
    { tid: topicId, anchor: anchorGroupKey }
  )
  expect(res.ok, `fetchContextClosure failed ${JSON.stringify(res)}`).toBe(true)
  const val: any = res.value
  expect(val.closure.completeness).toBe('context-closure')
  expect(val.closure.topicId).toBe(topicId)
  expect(val.closure.anchorGroupKey).toBe(anchorGroupKey)
  expect(val.closure.returnedCount).toBe(expectedIds.length)
  expect(val.closure.returnedCount).toBe(val.messages.length)
  expect(val.closure.firstMessageId).toBe(expectedIds[0])
  expect(val.closure.lastMessageId).toBe(expectedIds[expectedIds.length - 1])
  expect(val.messages.map((m: any) => m.id)).toEqual(expectedIds)
  expect(val.blocks.length).toBe(expectedIds.length)
  expect(val.window).toBeUndefined()
}

test.describe('Topic activation interactive while anchor pending', () => {
  test.setTimeout(180000)

  test('cold + resident small-topic activation stays interactive while anchor pending, then converges', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: standard fixture, disposable profile, mock provider, Main-seeded 6-message topics, real topic clicks; deterministic E2E-only anchor gate holds establish while bounded window/DOM/input prove interactive, then release proves anchor + closure convergence for cold miss and resident hit.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    await seedContextCount(page, liveAssistantId, 3)
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topicA = `act-cold-${suffix}`
    const topicB = `act-other-${suffix}`
    const idsA = await seedSmallTopic(page, liveAssistantId, topicA)
    const idsB = await seedSmallTopic(page, liveAssistantId, topicB)
    const expectedAnchorA = idsA[0]
    expect(await getPersistedAnchor(page, liveAssistantId, topicA)).toBeNull()

    try {
      // — Cold miss: hold the anchor resolver, activate an unloaded topic —
      await test.step('cold: bounded window/DOM/input interactive while anchor pending', async () => {
        const prev = await getGateEnteredForTopic(page, topicA)
        await armAnchorGate(page)
        await clickTopic(page, topicA)
        await waitForGateEntered(page, topicA, prev)
        await waitForBoundedInteractive(page, topicA, idsA)
        await expectInputEditableWhileBlocked(page)
        expect(await getPersistedAnchor(page, liveAssistantId, topicA)).toBeNull()
      })

      await test.step('cold: release converges anchor + closure', async () => {
        await releaseAnchorGate(page)
        await waitForAnchorConverged(page, liveAssistantId, topicA, expectedAnchorA)
        await expectAnchorHighlight(page, expectedAnchorA)
        await expectClosureCorrect(page, topicA, expectedAnchorA, idsA)
      })

      // — Make both topics resident, then re-test the same topic as a hit —
      await test.step('resident setup: second topic resident, clear anchor on first', async () => {
        await clickTopic(page, topicB)
        await waitForBoundedInteractive(page, topicB, idsB)
        const residentA = await page.evaluate((tid: string) => {
          const s = (window as any).store.getState()
          return s.residentRegistry?.entries?.[tid] ?? null
        }, topicA)
        expect(residentA?.residentTopic).toBe(true)
        expect(residentA?.chatData).toBe(true)
        expect(residentA?.segments).toBe(true)
        await clearPersistedAnchor(page, liveAssistantId, topicA)
      })

      await test.step('resident: window/DOM/input interactive while anchor pending', async () => {
        const prev = await getGateEnteredForTopic(page, topicA)
        await armAnchorGate(page)
        await clickTopic(page, topicA)
        await waitForGateEntered(page, topicA, prev)
        await waitForBoundedInteractive(page, topicA, idsA)
        await expectInputEditableWhileBlocked(page)
        expect(await getPersistedAnchor(page, liveAssistantId, topicA)).toBeNull()
      })

      await test.step('resident: release converges anchor + closure again', async () => {
        await releaseAnchorGate(page)
        await waitForAnchorConverged(page, liveAssistantId, topicA, expectedAnchorA)
        await expectAnchorHighlight(page, expectedAnchorA)
        await expectClosureCorrect(page, topicA, expectedAnchorA, idsA)
      })
    } finally {
      await releaseAnchorGate(page)
    }
  })
})
