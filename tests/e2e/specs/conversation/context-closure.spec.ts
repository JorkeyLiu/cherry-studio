/**
 * S6.3 context closure — authorized bounded E2E
 *
 * Purpose: Provide fresh-build Electron evidence that Main typed context
 * closure is unbounded and separate from the bounded viewport, while
 * preserving renderer anchor/contextCount semantics and DOM viewport grouping.
 *
 * Evidence tier: INTEGRATED via standard fixture, disposable profile,
 * mock provider, approved ensureTopic/pasteMessagesToTopic seeding,
 * real HomePage topic activation, Redux/DOM viewport proof,
 * direct preload closure contract proof. Main authority via typed IPC
 * through preload only; anchor and contextCount remain renderer-owned
 * without Main repair; closure is distinct from viewport and stays bounded;
 * valid anchor closure is non-empty while missing anchor is NOT_FOUND;
 * user/assistant/system turn semantics preserved; no
 * capacity/eviction/sync/delta scope.
 */

import { expect, test } from '../../fixtures/electron.fixture'

const DISPLAY_LIMIT = 20
const SYNTHETIC_TOTAL = 50

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

async function seedClosureTopic(
  page: any,
  liveAssistantId: string,
  topicId: string
): Promise<{ anchorGroupKey: string; expectedFirst: string; expectedLast: string; askX: string }> {
  const name = `Closure Test ${topicId}`
  const askX = `${topicId}-askX`
  const anchorGroupKey = `${topicId}-msg-${pad(0, 5)}`
  const expectedFirst = anchorGroupKey
  const expectedLast = `${topicId}-msg-${pad(SYNTHETIC_TOTAL - 1, 5)}`

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

  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < SYNTHETIC_TOTAL; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    const blockId = `${topicId}-block-${pad(i, 5)}`
    let role: string
    let askId: string | undefined

    if (i === 10) {
      role = 'system'
    } else if (i === 2 || i === 3) {
      role = 'assistant'
      askId = askX
    } else if (i % 2 === 0) {
      // even -> user, except overridden indices above
      if (i === 2 || i === 10) {
        // already handled
        role = 'user'
      } else {
        role = 'user'
      }
    } else {
      role = 'assistant'
      // normal assistant askId points to previous user when previous is user
      const prevIsUser = (() => {
        if (i - 1 === 10) return false
        if (i - 1 === 2 || i - 1 === 3) return false
        return (i - 1) % 2 === 0
      })()
      if (prevIsUser) {
        askId = `${topicId}-msg-${pad(i - 1, 5)}`
      }
    }

    // correct even indices that were forced to assistant: ensure they are assistant
    if ((i === 2 || i === 3) && role !== 'assistant') role = 'assistant'

    const message: Record<string, unknown> = {
      id: msgId,
      topicId,
      role,
      assistantId: liveAssistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      sortOrder: i
    }
    if (askId) (message as any).askId = askId
    if (role === 'assistant') {
      ;(message as any).model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      ;(message as any).modelId = 'mock-model'
    }

    const block = {
      id: blockId,
      messageId: msgId,
      type: 'main_text',
      content: `closure-content-${pad(i, 5)}`,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    entries.push({ message, blocks: [block] })
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

  return { anchorGroupKey, expectedFirst, expectedLast, askX }
}

async function setAnchorAndContextCount(
  page: any,
  assistantId: string,
  topicId: string,
  anchorGroupKey: string,
  contextCount: number | null
): Promise<void> {
  await page.evaluate(
    ({
      assistantId,
      topicId,
      anchorGroupKey,
      contextCount
    }: {
      assistantId: string
      topicId: string
      anchorGroupKey: string
      contextCount: number | null
    }) => {
      const store = (window as any).store
      const current =
        store.getState().assistants.assistants.find((a: any) => a.id === assistantId)?.settings?.contextWindowAnchor ??
        {}
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId,
          settings: {
            contextCount,
            contextWindowAnchor: {
              ...current,
              [topicId]: { kind: 'active', groupKey: anchorGroupKey }
            }
          }
        }
      })
    },
    { assistantId, topicId, anchorGroupKey, contextCount }
  )

  const check = await page.evaluate(
    ({ assistantId, topicId }: { assistantId: string; topicId: string }) => {
      const s = (window as any).store.getState()
      const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
      return {
        contextCount: assistant?.settings?.contextCount,
        anchor: assistant?.settings?.contextWindowAnchor?.[topicId] ?? null
      }
    },
    { assistantId, topicId }
  )
  expect(check.contextCount).toBe(contextCount)
  expect(check.anchor).toBeTruthy()
  expect(check.anchor.kind).toBe('active')
  expect(check.anchor.groupKey).toBe(anchorGroupKey)
}

async function activateTopicAndWaitForBootstrap(page: any, topicId: string): Promise<void> {
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
    { topicId, expected: DISPLAY_LIMIT },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected: number) => document.querySelectorAll('#messages [data-message-id]').length === expected,
    DISPLAY_LIMIT,
    { timeout: 30000 }
  )
}

test.describe('S6.3 R-06 context closure — Main typed closure unbounded distinct from viewport', () => {
  test.setTimeout(180000)

  test('closure unbounded from early anchor vs bounded viewport, NOT_FOUND, contextCount stable, viewport unchanged', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: standard fixture, disposable profile, mock provider, seed 50 authoritative rows with system + multi-assistant turn, early user anchor, displayCount 20 bounded viewport, direct preload fetchContextClosure unbounded closure, NOT_FOUND for missing anchor, contextCount change preserves anchor/closure, viewport DOM/groups unchanged.'
    })

    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `closure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const seeded = await seedClosureTopic(page, liveAssistantId, topicId)
    const anchorGroupKey = seeded.anchorGroupKey

    // Initial renderer-owned anchor + contextCount via existing settings path
    await setAnchorAndContextCount(page, liveAssistantId, topicId, anchorGroupKey, 3)

    await activateTopicAndWaitForBootstrap(page, topicId)

    // R-06 regression oracle: persisted early anchor must survive viewport bootstrap
    // even though it lies outside the truncated Redux projection (latest 20 of 50).
    // This assertion must fail if bootstrap recomputes the anchor from the viewport tail.
    const anchorAfterBootstrap = await page.evaluate(
      ({ assistantId, topicId }: { assistantId: string; topicId: string }) => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
        return assistant?.settings?.contextWindowAnchor?.[topicId] ?? null
      },
      { assistantId: liveAssistantId, topicId }
    )
    expect(anchorAfterBootstrap, 'early anchor must survive viewport bootstrap without recompute').toBeTruthy()
    expect(anchorAfterBootstrap.kind).toBe('active')
    expect(anchorAfterBootstrap.groupKey).toBe(anchorGroupKey)

    // Capture bounded viewport baseline
    const viewportBefore = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      const stableContainers = Array.from(
        document.querySelectorAll('#messages [data-stable-group-id]')
      ) as HTMLElement[]
      const stableIds: string[] = stableContainers.map((el) => el.getAttribute('data-stable-group-id') || '')
      const groupOuter = Array.from(document.querySelectorAll('#messages [id^="message-group-"]')).map(
        (el) => (el as HTMLElement).id
      )
      return { ids, domCount, domIds, stableIds, groupOuter }
    }, topicId)

    expect(viewportBefore.ids.length).toBe(DISPLAY_LIMIT)
    expect(viewportBefore.domCount).toBe(DISPLAY_LIMIT)
    expect(viewportBefore.domIds.length).toBe(DISPLAY_LIMIT)

    // Viewport must be bounded tail: last DISPLAY_LIMIT messages (30..49) still 20 despite early group compression
    const expectedTailIds: string[] = []
    for (let i = SYNTHETIC_TOTAL - DISPLAY_LIMIT; i < SYNTHETIC_TOTAL; i++) {
      expectedTailIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }
    expect(viewportBefore.ids).toEqual(expectedTailIds)
    expect([...viewportBefore.domIds].sort()).toEqual([...expectedTailIds].sort())

    // Direct preload closure via Main authority (unbounded)
    const closureRes: any = await page.evaluate(
      async ({ topicId, anchorGroupKey }: { topicId: string; anchorGroupKey: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchContextClosure({ topicId, anchorGroupKey })
      },
      { topicId, anchorGroupKey }
    )

    expect(closureRes.ok, `fetchContextClosure failed ${JSON.stringify(closureRes)}`).toBe(true)
    const val: any = closureRes.value
    expect(val).toBeTruthy()
    expect(val.closure).toBeTruthy()
    expect(val.closure.completeness).toBe('context-closure')
    expect(val.closure.topicId).toBe(topicId)
    expect(val.closure.anchorGroupKey).toBe(anchorGroupKey)
    expect(val.closure.returnedCount).toBe(val.messages.length)
    expect(val.closure.returnedCount).toBeGreaterThan(DISPLAY_LIMIT)
    expect(val.closure.returnedCount).toBe(SYNTHETIC_TOTAL)
    expect(val.closure.firstMessageId).toBe(seeded.expectedFirst)
    expect(val.closure.lastMessageId).toBe(seeded.expectedLast)
    expect(val.messages[0].id).toBe(val.closure.firstMessageId)
    expect(val.messages[val.messages.length - 1].id).toBe(val.closure.lastMessageId)

    // No hasMore / window metadata, no 1..100 truncation field, no hasMore-like keys
    expect(val.window).toBeUndefined()
    expect(val.closure.hasMoreBefore).toBeUndefined()
    expect(val.closure.hasMoreAfter).toBeUndefined()
    expect((val.closure as any).hasMore).toBeUndefined()
    expect((val.closure as any).requested).toBeUndefined()
    expect((val.closure as any).limit).toBeUndefined()
    expect((val.closure as any).before).toBeUndefined()
    expect((val.closure as any).after).toBeUndefined()
    // Validate closure object keys are exactly the allowed set (LOCK-001 authoritative metadata)
    const closureKeys = Object.keys(val.closure).sort()
    expect(closureKeys).toEqual(
      [
        'anchorGroupKey',
        'boundaryMessageId',
        'completeness',
        'firstMessageId',
        'lastMessageId',
        'returnedCount',
        'selectedTurnCount',
        'topicId',
        'totalTurnCount'
      ].sort()
    )
    const valueKeys = Object.keys(val).sort()
    expect(valueKeys).toEqual(['blocks', 'closure', 'messages'].sort())

    // LOCK-001 whole-topic authoritative metadata: anchor at 0 covers all turns
    expect(typeof val.closure.totalTurnCount).toBe('number')
    expect(typeof val.closure.selectedTurnCount).toBe('number')
    expect(Number.isInteger(val.closure.totalTurnCount)).toBe(true)
    expect(Number.isInteger(val.closure.selectedTurnCount)).toBe(true)
    expect(val.closure.totalTurnCount).toBeGreaterThan(0)
    expect(val.closure.selectedTurnCount).toBe(val.closure.totalTurnCount)
    expect(val.closure.boundaryMessageId).toBeNull()
    // Validate partial semantics via mid-anchor (selected < total, boundary == firstMessageId)
    const partialAnchor = `${topicId}-msg-${pad(30, 5)}`
    const partialRes: any = await page.evaluate(
      async ({ topicId, anchorGroupKey }: { topicId: string; anchorGroupKey: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchContextClosure({ topicId, anchorGroupKey })
      },
      { topicId, anchorGroupKey: partialAnchor }
    )
    expect(partialRes.ok, `partial fetchContextClosure failed ${JSON.stringify(partialRes)}`).toBe(true)
    const pval: any = partialRes.value
    expect(pval.closure.completeness).toBe('context-closure')
    expect(pval.closure.topicId).toBe(topicId)
    expect(pval.closure.anchorGroupKey).toBe(partialAnchor)
    expect(pval.closure.totalTurnCount).toBe(val.closure.totalTurnCount)
    expect(pval.closure.selectedTurnCount).toBeLessThan(pval.closure.totalTurnCount)
    expect(pval.closure.selectedTurnCount).toBeGreaterThan(0)
    expect(pval.closure.boundaryMessageId).toBe(pval.closure.firstMessageId)
    expect(typeof pval.closure.boundaryMessageId).toBe('string')
    expect(pval.closure.boundaryMessageId.length).toBeGreaterThan(0)
    // Partial closure keys also exact
    expect(Object.keys(pval.closure).sort()).toEqual(
      [
        'anchorGroupKey',
        'boundaryMessageId',
        'completeness',
        'firstMessageId',
        'lastMessageId',
        'returnedCount',
        'selectedTurnCount',
        'topicId',
        'totalTurnCount'
      ].sort()
    )
    expect(Object.keys(pval).sort()).toEqual(['blocks', 'closure', 'messages'].sort())
    expect(pval.closure.returnedCount).toBe(pval.messages.length)
    expect(pval.closure.returnedCount).toBeGreaterThan(0)
    expect(pval.closure.returnedCount).toBeLessThan(val.closure.returnedCount)
    expect(pval.closure.firstMessageId).toBe(partialAnchor)
    expect(pval.messages[0].id).toBe(pval.closure.firstMessageId)

    // Ordered unique IDs
    const ids: string[] = val.messages.map((m: any) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort())
    const toNum = (id: string) => Number(id.split('-').pop())
    for (let i = 1; i < ids.length; i++) {
      expect(toNum(ids[i])).toBeGreaterThan(toNum(ids[i - 1]))
    }

    // Complete blocks: each message has blocks, each block.messageId in set
    const messageIdSet = new Set(ids)
    const blockIdSet = new Set<string>()
    for (const m of val.messages as any[]) {
      expect(Array.isArray(m.blocks)).toBe(true)
      expect(m.blocks.length).toBeGreaterThan(0)
      for (const bid of m.blocks as string[]) {
        expect(typeof bid).toBe('string')
        blockIdSet.add(bid)
      }
    }
    expect(val.blocks.length).toBe(ids.length)
    for (const b of val.blocks as any[]) {
      expect(typeof b.id).toBe('string')
      expect(typeof b.messageId).toBe('string')
      expect(messageIdSet.has(b.messageId)).toBe(true)
      expect(blockIdSet.has(b.id)).toBe(true)
      expect(b.messageId).toBeTruthy()
    }
    // No duplicate block IDs
    expect(new Set((val.blocks as any[]).map((b: any) => b.id)).size).toBe(val.blocks.length)

    // Includes early multi-assistant turn (2,3 same askX) and system row (index 10)
    expect(ids).toContain(`${topicId}-msg-${pad(2, 5)}`)
    expect(ids).toContain(`${topicId}-msg-${pad(3, 5)}`)
    const multiAskRows = (val.messages as any[]).filter((m: any) => m.askId === seeded.askX)
    expect(multiAskRows.length).toBe(2)
    expect(multiAskRows.map((m: any) => m.id).sort()).toEqual(
      [`${topicId}-msg-${pad(2, 5)}`, `${topicId}-msg-${pad(3, 5)}`].sort()
    )
    const systemRows = (val.messages as any[]).filter((m: any) => m.role === 'system')
    expect(systemRows.length).toBe(1)
    expect(systemRows[0].id).toBe(`${topicId}-msg-${pad(10, 5)}`)
    expect(ids).toContain(`${topicId}-msg-${pad(10, 5)}`)

    // Viewport remains bounded and unchanged after closure call
    const viewportAfterClosure = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      const stable = Array.from(document.querySelectorAll('#messages [data-stable-group-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-stable-group-id') || ''
      )
      const outer = Array.from(document.querySelectorAll('#messages [id^="message-group-"]')).map(
        (el) => (el as HTMLElement).id
      )
      return { ids, domCount, domIds, stable, outer }
    }, topicId)
    expect(viewportAfterClosure.ids).toEqual(viewportBefore.ids)
    expect(viewportAfterClosure.domCount).toBe(viewportBefore.domCount)
    expect([...viewportAfterClosure.domIds].sort()).toEqual([...viewportBefore.domIds].sort())
    expect(viewportAfterClosure.stable.length).toBe(viewportBefore.stableIds.length)
    expect(viewportAfterClosure.outer.length).toBe(viewportBefore.groupOuter.length)

    // Missing anchor must return NOT_FOUND, never empty success
    const missingRes: any = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchContextClosure({ topicId, anchorGroupKey: 'missing-anchor-xyz-not-exist' })
      },
      { topicId }
    )
    expect(missingRes.ok).toBe(false)
    expect(missingRes.error).toBeTruthy()
    expect(typeof missingRes.error.code).toBe('string')
    expect(missingRes.error.code).toMatch(/NOT_FOUND/)
    expect(missingRes.value).toBeUndefined()
    // Ensure not an empty success
    expect(missingRes.ok).not.toBe(true)

    // Unknown role must not independently resolve — but our valid anchor still works (sanity)
    // Not hand-rolling unknown rows; just ensure closure still valid after missing check
    const stillValid: any = await page.evaluate(
      async ({ topicId, anchorGroupKey }: { topicId: string; anchorGroupKey: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchContextClosure({ topicId, anchorGroupKey })
      },
      { topicId, anchorGroupKey }
    )
    expect(stillValid.ok).toBe(true)
    expect(stillValid.value.closure.returnedCount).toBe(SYNTHETIC_TOTAL)

    // Change contextCount via renderer path, assert anchor unchanged and closure unchanged
    const anchorBeforeChange = await page.evaluate(
      ({ assistantId, topicId }: { assistantId: string; topicId: string }) => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
        return assistant?.settings?.contextWindowAnchor?.[topicId]?.groupKey ?? null
      },
      { assistantId: liveAssistantId, topicId }
    )
    expect(anchorBeforeChange).toBe(anchorGroupKey)

    await page.evaluate(
      ({ assistantId, newCount }: { assistantId: string; newCount: number }) => {
        const store = (window as any).store
        store.dispatch({
          type: 'assistants/updateAssistantSettings',
          payload: { assistantId, settings: { contextCount: newCount } }
        })
      },
      { assistantId: liveAssistantId, newCount: 1 }
    )

    const anchorAfterCount1 = await page.evaluate(
      ({ assistantId, topicId }: { assistantId: string; topicId: string }) => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
        return {
          anchor: assistant?.settings?.contextWindowAnchor?.[topicId]?.groupKey ?? null,
          contextCount: assistant?.settings?.contextCount
        }
      },
      { assistantId: liveAssistantId, topicId }
    )
    expect(anchorAfterCount1.anchor).toBe(anchorGroupKey)
    expect(anchorAfterCount1.contextCount).toBe(1)

    const closureAfterCount1: any = await page.evaluate(
      async ({ topicId, anchorGroupKey }: { topicId: string; anchorGroupKey: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchContextClosure({ topicId, anchorGroupKey })
      },
      { topicId, anchorGroupKey }
    )
    expect(closureAfterCount1.ok).toBe(true)
    expect(closureAfterCount1.value.closure.returnedCount).toBe(SYNTHETIC_TOTAL)
    expect(closureAfterCount1.value.closure.firstMessageId).toBe(seeded.expectedFirst)
    expect(closureAfterCount1.value.closure.lastMessageId).toBe(seeded.expectedLast)
    expect(closureAfterCount1.value.messages.map((m: any) => m.id)).toEqual(ids)

    // Change again to another count and verify stability again
    await page.evaluate(
      ({ assistantId, newCount }: { assistantId: string; newCount: number }) => {
        const store = (window as any).store
        store.dispatch({
          type: 'assistants/updateAssistantSettings',
          payload: { assistantId, settings: { contextCount: newCount } }
        })
      },
      { assistantId: liveAssistantId, newCount: 10 }
    )

    const anchorAfterCount10 = await page.evaluate(
      ({ assistantId, topicId }: { assistantId: string; topicId: string }) => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
        return {
          anchor: assistant?.settings?.contextWindowAnchor?.[topicId]?.groupKey ?? null,
          contextCount: assistant?.settings?.contextCount
        }
      },
      { assistantId: liveAssistantId, topicId }
    )
    expect(anchorAfterCount10.anchor).toBe(anchorGroupKey)
    expect(anchorAfterCount10.contextCount).toBe(10)

    const closureAfterCount10: any = await page.evaluate(
      async ({ topicId, anchorGroupKey }: { topicId: string; anchorGroupKey: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchContextClosure({ topicId, anchorGroupKey })
      },
      { topicId, anchorGroupKey }
    )
    expect(closureAfterCount10.ok).toBe(true)
    expect(closureAfterCount10.value.closure.returnedCount).toBe(SYNTHETIC_TOTAL)
    expect(closureAfterCount10.value.closure.completeness).toBe('context-closure')
    expect(closureAfterCount10.value.messages.map((m: any) => m.id)).toEqual(ids)

    // Final viewport unchanged after contextCount changes and closure calls
    const viewportFinal = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      const stable = Array.from(document.querySelectorAll('#messages [data-stable-group-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-stable-group-id') || ''
      )
      const outer = Array.from(document.querySelectorAll('#messages [id^="message-group-"]')).map(
        (el) => (el as HTMLElement).id
      )
      return { ids, domCount, domIds, stable, outer }
    }, topicId)

    expect(viewportFinal.ids).toEqual(viewportBefore.ids)
    expect(viewportFinal.domCount).toBe(viewportBefore.domCount)
    expect([...viewportFinal.domIds].sort()).toEqual([...viewportBefore.domIds].sort())
    expect(viewportFinal.stable.length).toBe(viewportBefore.stableIds.length)
    expect(viewportFinal.outer.length).toBe(viewportBefore.groupOuter.length)
    expect(viewportFinal.ids.length).toBe(DISPLAY_LIMIT)
  })
})
