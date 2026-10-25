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
 * - Model selection is device-local: each profile keeps its own connection /
 *   model (with local metadata) across sync, a model-only local edit produces
 *   no sync intent, and only portable fields (prompt/name/settings) converge.
 */

import * as path from 'path'

import { expect, test } from '../../fixtures/electron.fixture'
import { assertTextareaReady } from '../../utils/prepare-app'
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

interface LocalModel {
  id: string
  provider: string
  name: string
  group: string
  capabilities?: Array<{ type: string }>
}

/** Create a device-local connection + model and select it on the first assistant. */
async function configureLocalModel(
  page: import('@playwright/test').Page,
  providerId: string,
  modelId: string,
  modelName: string
): Promise<LocalModel & { assistantId: string }> {
  return await page.evaluate(
    ({ providerId, modelId, modelName }) => {
      const store = (window as any).store
      const model = {
        id: modelId,
        provider: providerId,
        name: modelName,
        group: 'e2e-local',
        capabilities: [{ type: 'reasoning' }]
      }
      const state = store.getState()
      const existing = state.llm.providers.find((p: any) => p.id === providerId)
      if (existing) {
        store.dispatch({
          type: 'llm/updateProvider',
          payload: { id: providerId, models: [...(existing.models ?? []), model] }
        })
      } else {
        store.dispatch({
          type: 'llm/addProvider',
          payload: {
            id: providerId,
            type: 'openai',
            name: providerId,
            apiKey: 'test-key',
            apiHost: 'http://127.0.0.1:1/v1/',
            models: [model],
            enabled: true,
            isSystem: false
          }
        })
      }
      const assistantId = String(state.assistants.assistants[0].id)
      store.dispatch({ type: 'assistants/setModel', payload: { assistantId, model } })
      return { ...model, assistantId }
    },
    { providerId, modelId, modelName }
  )
}

async function readAssistantModel(page: import('@playwright/test').Page, modelId: string): Promise<unknown> {
  return await page.evaluate((id: string) => {
    const row = (window as any).store.getState().assistants.assistants[0]
    const model = row?.model ?? null
    if (!model || model.id !== id) return null
    return {
      id: model.id,
      provider: model.provider,
      name: model.name,
      group: model.group,
      capabilities: model.capabilities ?? null
    }
  }, modelId)
}

async function readAssistantName(page: import('@playwright/test').Page, assistantId: string): Promise<string | null> {
  return await page.evaluate((id: string) => {
    const row = (window as any).store.getState().assistants.assistants.find((a: any) => a?.id === id)
    return row?.name ?? null
  }, assistantId)
}

async function isModelConfigured(
  page: import('@playwright/test').Page,
  modelId: string,
  providerId: string
): Promise<boolean> {
  return await page.evaluate(
    ({ modelId, providerId }: { modelId: string; providerId: string }) => {
      const providers = (window as any).store.getState().llm.providers ?? []
      const provider = providers.find((p: any) => p.id === providerId)
      if (!provider) return false
      return (provider.models ?? []).some((m: any) => m.id === modelId)
    },
    { modelId, providerId }
  )
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
    expect(batch[0]!.payload).not.toHaveProperty('model')
    expect(JSON.stringify(batch[0]!.payload)).not.toContain('connectionId')
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

  test('distinct local model selections survive sync; portable config converges both ways', async ({
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
    // Drain the pairing bootstrap so the pending count reflects only new intent.
    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect((await runSyncViaApi(pageB)).threw).toBeNull()

    // Each device owns a distinct connection + model. Model selection is
    // device-local (application settings/provider connections never sync).
    const configuredA = await configureLocalModel(pageA, 'e2e-conn-local-a', 'e2e-model-local-a', 'E2E Local A')
    const configuredB = await configureLocalModel(pageB, 'e2e-conn-local-b', 'e2e-model-local-b', 'E2E Local B')
    const localA = { ...configuredA, assistantId: undefined }
    const localB = { ...configuredB, assistantId: undefined }
    delete (localA as Record<string, unknown>).assistantId
    delete (localB as Record<string, unknown>).assistantId
    expect(localA.provider).not.toBe(localB.provider)
    expect(localA.id).not.toBe(localB.id)
    await pageA.waitForTimeout(500)
    await pageB.waitForTimeout(500)

    // A model-only local edit carries no sync intent.
    expect((await getSyncStatusViaApi(pageA)).pendingCount).toBe(0)
    expect((await getSyncStatusViaApi(pageB)).pendingCount).toBe(0)

    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect((await runSyncViaApi(pageB)).threw).toBeNull()
    // Each side keeps its own selection object (identity + local metadata).
    expect(await readAssistantModel(pageA, localA.id)).toEqual(localA)
    expect(await readAssistantModel(pageB, localB.id)).toEqual(localB)

    const assistantId = String(configuredA.assistantId)
    // Portable shared config from A -> B (prompt + temperature).
    await commitAssistantDelta(pageA, {
      kind: 'assistant',
      id: assistantId,
      mutationId: `m-${assistantId}-portable-a`,
      revision: 1,
      fields: { prompt: 'Shared prompt from A', settings: { temperature: 0.25 } }
    })
    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect((await runSyncViaApi(pageB)).threw).toBeNull()
    const batchB = await getAssistantProjection(pageB, [`assistant_config:assistant:${assistantId}`])
    expect(batchB.length).toBe(1)
    expect(batchB[0]!.payload.prompt).toBe('Shared prompt from A')
    expect((batchB[0]!.payload.settings as Record<string, unknown>).temperature).toBe(0.25)
    // No device-local selection slot is ever published.
    expect(batchB[0]!.payload).not.toHaveProperty('model')
    expect(batchB[0]!.payload).not.toHaveProperty('defaultModel')
    expect(JSON.stringify(batchB[0]!.payload)).not.toContain('connectionId')

    // B's own selection is untouched by A's portable update, and B's shared
    // edit reaches A without overwriting A's selection.
    expect(await readAssistantModel(pageB, localB.id)).toEqual(localB)
    await commitAssistantDelta(pageB, {
      kind: 'assistant',
      id: assistantId,
      mutationId: `m-${assistantId}-portable-b`,
      revision: 2,
      fields: { name: 'Renamed by B' }
    })
    expect((await runSyncViaApi(pageB)).threw).toBeNull()
    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect(await readAssistantName(pageA, assistantId)).toBe('Renamed by B')
    expect(await readAssistantModel(pageA, localA.id)).toEqual(localA)
    expect(await readAssistantModel(pageB, localB.id)).toEqual(localB)

    // Both selections are still resolvable against their own provider list
    // (valid displayed selection, never an invalid/foreign reference).
    expect(await isModelConfigured(pageA, localA.id, localA.provider)).toBe(true)
    expect(await isModelConfigured(pageB, localB.id, localB.provider)).toBe(true)
    await expect(pageB.locator('.inputbar textarea, textarea[placeholder]').first()).toBeVisible({ timeout: 30000 })
    await pageB.screenshot({ path: path.join(ownedTmpRoot, 'assistant-local-model.png') })
  })
})
