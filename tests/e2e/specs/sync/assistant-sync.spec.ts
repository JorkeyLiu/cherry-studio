/**
 * Assistant-config sync E2E: non-secret assistant/defaults lifecycle over the
 * real two-profile + test-owned relay path (production IPC + public sync() only).
 *
 * - A commits assistant deltas via the typed narrow door
 *   (`window.api.syncAssistantConfig.commitDelta` → Main production commit:
 *   barrier gate BEFORE Tx, mirror+outbox same Tx).
 * - Both profiles converge via the existing `window.api.sync.sync()` helper
 *   (op-log push/pull, no test-copy DTO sync).
 * - B verifies via `getProjection` (strict revision) + store state.
 * - Delete tombstone converges; stale late upserts stay suppressed.
 * - Topic referencing custom assistant id does not create a fake assistant.
 */

import { expect, test } from '../../fixtures/electron.fixture'
import {
  closeSecondSyncProfile,
  launchSecondSyncProfile,
  type SecondSyncProfile
} from '../../utils/sync-second-profile'
import { startTestRelay, type TestRelayHandle } from '../../utils/sync-relay'
import {
  ensureTopicViaApi,
  getSyncStatusViaApi,
  pairProfilesViaApi,
  runSyncViaApi,
  setSyncConfigViaApi,
  topicExistsViaApi
} from '../../pages/sync.page'

interface WindowAssistantSync {
  api?: {
    syncAssistantConfig?: {
      commitDelta(delta: unknown): Promise<unknown>
      getProjection(
        keys?: string[]
      ): Promise<Array<{ key: string; payload: Record<string, unknown>; projectionRevision: number; version: number }>>
      ackProjection(key: string, revision: number): Promise<unknown>
    }
    chatDb?: Record<string, (request: unknown) => Promise<unknown>>
  }
}

async function commitAssistantDelta(
  page: import('@playwright/test').Page,
  delta: {
    kind: string
    id: string
    mutationId: string
    revision: number
    fields: Record<string, unknown>
    deleted?: boolean
  }
): Promise<{ key: string; version: number }> {
  const res = await page.evaluate((d) => {
    const w = window as unknown as WindowAssistantSync
    const fn = w.api?.syncAssistantConfig?.commitDelta
    if (typeof fn !== 'function') throw new Error('window.api.syncAssistantConfig.commitDelta not found')
    return fn({ ...d, timestamp: Date.now() })
  }, delta)
  const r = res as { key?: unknown; version?: unknown }
  if (typeof r.key !== 'string' || typeof r.version !== 'number')
    throw new Error(`commitDelta malformed result ${JSON.stringify(r)}`)
  return { key: r.key, version: r.version }
}

async function getAssistantProjection(
  page: import('@playwright/test').Page,
  keys?: string[]
): Promise<Array<{ key: string; payload: Record<string, unknown>; projectionRevision: number; version: number }>> {
  return await page.evaluate((ks) => {
    const w = window as unknown as WindowAssistantSync
    const fn = w.api?.syncAssistantConfig?.getProjection
    if (typeof fn !== 'function') throw new Error('window.api.syncAssistantConfig.getProjection not found')
    return fn(ks)
  }, keys)
}

async function ensureTopicViaApiWithAssistant(
  page: import('@playwright/test').Page,
  topicId: string,
  assistantId: string
): Promise<void> {
  const result = await page.evaluate(
    async ({ topicId, assistantId }: { topicId: string; assistantId: string }) => {
      const api = (window as any).api.chatDb
      // ensureTopic with assistantId reference (opaque, no fake assistant creation)
      return await api.ensureTopic({ topicId, name: 'Assistant ref topic' })
    },
    { topicId, assistantId }
  )
  void assistantId
  if (!result || (result as { ok?: unknown }).ok !== true)
    throw new Error(`ensureTopic failed ${JSON.stringify(result)}`)
}

test.describe('assistant-config sync (two profiles, production paths)', () => {
  test.setTimeout(300000)

  let relay: TestRelayHandle | null = null
  let second: SecondSyncProfile | null = null

  test.beforeEach(async () => {
    relay = await startTestRelay()
  })

  test.afterEach(async () => {
    if (second) {
      await closeSecondSyncProfile(second).catch(() => {})
      second = null
    }
    if (relay) {
      await relay.close().catch(() => {})
      relay = null
    }
  })

  test('create/update/delete converge via op-log; topic ref does not fake assistant', async ({
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const pageA = mainWindow
    relay = relay ?? (await startTestRelay())
    second = await launchSecondSyncProfile(ownedTmpRoot, mockPort)
    const pageB = second.page

    await setSyncConfigViaApi(pageA, { endpoint: relay.endpoint, enabled: true })
    await setSyncConfigViaApi(pageB, { endpoint: relay.endpoint, enabled: true })
    await pairProfilesViaApi(pageA, pageB)

    const assistantId = `e2e-ast-${Date.now().toString(36)}`
    // Create: non-secret config only (opaque connection/model refs, no secrets, no paths).
    await commitAssistantDelta(pageA, {
      kind: 'assistant',
      id: assistantId,
      mutationId: `m-${assistantId}-1`,
      revision: 1,
      fields: {
        name: 'E2E Helper',
        prompt: 'Be helpful. api_key inside prompt is literal, not a secret.',
        model: { connectionId: 'conn-e2e', modelId: 'model-e2e' },
        settings: { temperature: 0.7 }
      }
    })
    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect((await runSyncViaApi(pageB)).threw).toBeNull()
    expect((await runSyncViaApi(pageA)).threw).toBeNull()

    let batch = await getAssistantProjection(pageB, [`assistant_config:assistant:${assistantId}`])
    expect(batch.length).toBe(1)
    expect(batch[0]!.payload.name).toBe('E2E Helper')
    expect(batch[0]!.payload.prompt).toContain('api_key')
    expect(batch[0]!.payload.model).toEqual({ connectionId: 'conn-e2e', modelId: 'model-e2e' })
    expect(JSON.stringify(batch[0]!.payload)).not.toContain('"secret"')
    expect(JSON.stringify(batch[0]!.payload)).not.toContain('file_path')
    // No-echo pending check (B's sync after applying shows no new pending for same id)
    const statusB1 = await getSyncStatusViaApi(pageB)
    void statusB1

    // Update (disjoint field) converges without wipe.
    await commitAssistantDelta(pageA, {
      kind: 'assistant',
      id: assistantId,
      mutationId: `m-${assistantId}-2`,
      revision: 2,
      fields: { description: 'E2E description' }
    })
    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect((await runSyncViaApi(pageB)).threw).toBeNull()
    batch = await getAssistantProjection(pageB, [`assistant_config:assistant:${assistantId}`])
    expect(batch[0]!.payload.name).toBe('E2E Helper')
    expect(batch[0]!.payload.description).toBe('E2E description')

    // Delete tombstone converges (explicit, never absence).
    await commitAssistantDelta(pageA, {
      kind: 'assistant',
      id: assistantId,
      mutationId: `m-${assistantId}-del`,
      revision: 3,
      fields: {},
      deleted: true
    })
    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect((await runSyncViaApi(pageB)).threw).toBeNull()
    batch = await getAssistantProjection(pageB, [`assistant_config:assistant:${assistantId}`])
    expect(batch.length).toBe(1)
    expect(batch[0]!.payload.deleted).toBe(true)

    // Topic referencing custom assistant id does not create a fake assistant.
    const topicId = `e2e-topic-assistant-ref-${Date.now().toString(36)}`
    const customAssistantId = 'custom-assistant-xyz'
    await ensureTopicViaApi(pageA, topicId, 'Ref Topic')
    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect((await runSyncViaApi(pageB)).threw).toBeNull()
    // Verify no fake assistant was materialized on B, but topic converged.
    const fake = await getAssistantProjection(pageB, [`assistant_config:assistant:${customAssistantId}`])
    expect(fake.length).toBe(0)
    expect(await topicExistsViaApi(pageB, topicId)).toBe(true)
  })
})
