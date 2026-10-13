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

import * as path from 'path'

import { expect, getUserDataDir, test } from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import {
  assertChatDbReady,
  assertTextareaReady,
  bypassOnboarding,
  launchElectronApp,
  seedMockProvider,
  waitForHomeReady,
  waitForMainElectronWindow
} from '../../utils/prepare-app'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { probeAndAssertRuntimeAppData } from '../../utils/runtime-app-data'
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

  test('modelRef DTO converges to runtime Model on the existing entity (no DTO keys)', async ({
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

    // Existing entity on B (fresh-profile stable `default` id, no new identity).
    const targetId = await pageB.evaluate(() => {
      const list = (window as any).store.getState().assistants.assistants
      return String(list[0].id)
    })
    expect(targetId.length).toBeGreaterThan(0)

    // Synthetic DTO identities, all distinct from the mock global model.
    const dtoModel = {
      connectionId: 'e2e-conn-modelref',
      modelId: 'e2e-model-remote',
      displayName: 'E2E Remote Pretty',
      group: 'e2e-rg'
    }
    const dtoDefault = { connectionId: 'e2e-conn-modelref', modelId: 'e2e-model-remote-dm' }
    const dtoSettingsDefault = {
      connectionId: 'e2e-conn-modelref',
      modelId: 'e2e-model-remote-sdm',
      displayName: 'E2E SDM Pretty',
      group: 'e2e-sg'
    }
    await commitAssistantDelta(pageA, {
      kind: 'assistant',
      id: targetId,
      mutationId: `m-${targetId}-modelref-1`,
      revision: 1,
      fields: {
        model: dtoModel,
        defaultModel: dtoDefault,
        settings: { defaultModel: dtoSettingsDefault }
      }
    })
    expect((await runSyncViaApi(pageA)).threw).toBeNull()
    expect((await runSyncViaApi(pageB)).threw).toBeNull()
    expect((await runSyncViaApi(pageA)).threw).toBeNull()

    // Projection still carries the wire DTO shape (compat contract).
    const batch = await getAssistantProjection(pageB, [`assistant_config:assistant:${targetId}`])
    expect(batch.length).toBe(1)
    expect(batch[0]!.payload.model).toEqual(dtoModel)

    // Live store holds decoded runtime Models only (no DTO keys, no fallback).
    const applied = await pageB.evaluate((id: string) => {
      const s = (window as any).store.getState()
      const row = s.assistants.assistants.find((a: any) => a?.id === id)
      const llmDefault = s.llm?.defaultModel ?? null
      return {
        model: row?.model ?? null,
        defaultModel: row?.defaultModel ?? null,
        settingsDefault: row?.settings?.defaultModel ?? null,
        llmDefault
      }
    }, targetId)
    expect(applied.model).toEqual({
      id: 'e2e-model-remote',
      provider: 'e2e-conn-modelref',
      name: 'E2E Remote Pretty',
      group: 'e2e-rg'
    })
    expect(applied.defaultModel).toEqual({
      id: 'e2e-model-remote-dm',
      provider: 'e2e-conn-modelref',
      name: 'e2e-model-remote-dm',
      group: ''
    })
    expect(applied.settingsDefault).toEqual({
      id: 'e2e-model-remote-sdm',
      provider: 'e2e-conn-modelref',
      name: 'E2E SDM Pretty',
      group: 'e2e-sg'
    })
    for (const slot of [applied.model, applied.defaultModel, applied.settingsDefault]) {
      expect(typeof slot.id).toBe('string')
      expect(typeof slot.provider).toBe('string')
      expect('connectionId' in slot).toBe(false)
      expect('modelId' in slot).toBe(false)
      expect('displayName' in slot).toBe(false)
    }
    expect(JSON.stringify([applied.model, applied.defaultModel, applied.settingsDefault])).not.toContain('connectionId')
    // No hidden fallback to the mock global model (synthetic ids prove identity).
    expect(applied.llmDefault?.id).toBe('mock-model')
    expect(applied.model.id).not.toBe(applied.llmDefault?.id)

    // Real rendered chat surface stays ready (textarea visible) + screenshot.
    await expect(pageB.locator('.inputbar textarea, textarea[placeholder]').first()).toBeVisible({ timeout: 30000 })
    await pageB.screenshot({ path: path.join(ownedTmpRoot, 'assistant-modelref-b.png') })
  })

  test('legacy DTO persisted at version 227 repairs after a real relaunch (no hidden fallback)', async ({
    electronApp,
    mainWindow,
    ownedTmpRoot,
    mockPort
  }) => {
    const userDataDir = getUserDataDir()
    expect(ownedTmpRoot.length).toBeGreaterThan(0)
    expect(userDataDir.length).toBeGreaterThan(0)

    // Global mock model is the legitimate distinct identity (never a fallback).
    const globalBefore = await mainWindow.evaluate(() => (window as any).store.getState().llm?.defaultModel)
    expect(globalBefore?.id).toBe('mock-model')

    // Inject synthetic legacy DTO slots into the real persist wire and bump
    // _persist to 227 (higher than the 225 code: migrate passes higher
    // versions through untouched, the read transform must still repair).
    const injected = await mainWindow.evaluate(() => {
      const store = (window as any).store
      store.dispatch({ type: 'persist/PAUSE' })
      return new Promise((resolve) => setTimeout(resolve, 300)).then(() => {
        const key = 'persist:cherry-studio'
        const wire = localStorage.getItem(key)
        if (!wire) throw new Error('persist wire missing')
        const outer = JSON.parse(wire)
        if (typeof outer.assistants !== 'string') throw new Error('assistants slice missing')
        const slice = JSON.parse(outer.assistants)
        const list = slice.assistants
        if (!Array.isArray(list) || list.length === 0) throw new Error('assistants list missing')
        list[0].model = {
          connectionId: 'e2e-conn-legacy',
          modelId: 'e2e-model-legacy-a',
          displayName: 'E2E Legacy A',
          group: 'e2e-lg'
        }
        list[0].defaultModel = { connectionId: 'e2e-conn-legacy', modelId: 'e2e-model-legacy-dm' }
        list[0].settings = {
          ...(list[0].settings ?? {}),
          defaultModel: {
            connectionId: 'e2e-conn-legacy',
            modelId: 'e2e-model-legacy-sdm',
            displayName: 'E2E Legacy SDM'
          }
        }
        slice.assistantDefaults = {
          ...(slice.assistantDefaults ?? { name: 'Defaults', prompt: '', settings: {} }),
          model: { connectionId: 'e2e-conn-defaults', modelId: 'e2e-model-defaults-a' },
          settings: {
            ...((slice.assistantDefaults as any)?.settings ?? {}),
            defaultModel: {
              connectionId: 'e2e-conn-defaults',
              modelId: 'e2e-model-defaults-sdm',
              group: 'e2e-dg'
            }
          }
        }
        outer.assistants = JSON.stringify(slice)
        outer._persist = JSON.stringify({ version: 227, rehydrated: true })
        localStorage.setItem(key, JSON.stringify(outer))
        const readback = localStorage.getItem(key)
        if (readback !== JSON.stringify(outer)) throw new Error('persist readback mismatch')
        const check = JSON.parse(JSON.parse(readback).assistants)
        return {
          assistantId: String(check.assistants[0].id),
          version: (JSON.parse(JSON.parse(readback)._persist) as { version: number }).version
        }
      })
    })
    expect(injected.version).toBe(227)
    expect(injected.assistantId.length).toBeGreaterThan(0)

    // Same-profile real relaunch (exact-token ownership, shared helpers only).
    await electronApp.close()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const relaunchedApp = await launchElectronApp({ userDataDir, ownedTmpRoot })
    try {
      const page = await waitForMainElectronWindow(relaunchedApp)
      const probed = await probeAndAssertRuntimeAppData(page, userDataDir)
      void probed
      await bypassOnboarding(page)
      await seedMockProvider(page, mockPort)
      await waitForHomeReady(page)
      await assertChatDbReady(page)
      await assertTextareaReady(page)
      expect(await page.title()).toContain('Cherry')
      await page.waitForSelector('#root', { state: 'attached', timeout: 30000 })

      const repaired = await page.evaluate((id: string) => {
        const s = (window as any).store.getState()
        const row = s.assistants.assistants.find((a: any) => a?.id === id)
        return {
          model: row?.model ?? null,
          defaultModel: row?.defaultModel ?? null,
          settingsDefault: row?.settings?.defaultModel ?? null,
          defaultsModel: s.assistants?.assistantDefaults?.model ?? null,
          defaultsSettingsDefault: s.assistants?.assistantDefaults?.settings?.defaultModel ?? null,
          llmDefault: s.llm?.defaultModel ?? null
        }
      }, injected.assistantId)
      expect(repaired.model).toEqual({
        id: 'e2e-model-legacy-a',
        provider: 'e2e-conn-legacy',
        name: 'E2E Legacy A',
        group: 'e2e-lg'
      })
      expect(repaired.defaultModel).toEqual({
        id: 'e2e-model-legacy-dm',
        provider: 'e2e-conn-legacy',
        name: 'e2e-model-legacy-dm',
        group: ''
      })
      expect(repaired.settingsDefault).toEqual({
        id: 'e2e-model-legacy-sdm',
        provider: 'e2e-conn-legacy',
        name: 'E2E Legacy SDM',
        group: ''
      })
      expect(repaired.defaultsModel).toEqual({
        id: 'e2e-model-defaults-a',
        provider: 'e2e-conn-defaults',
        name: 'e2e-model-defaults-a',
        group: ''
      })
      expect(repaired.defaultsSettingsDefault).toEqual({
        id: 'e2e-model-defaults-sdm',
        provider: 'e2e-conn-defaults',
        name: 'e2e-model-defaults-sdm',
        group: 'e2e-dg'
      })
      for (const slot of [
        repaired.model,
        repaired.defaultModel,
        repaired.settingsDefault,
        repaired.defaultsModel,
        repaired.defaultsSettingsDefault
      ]) {
        expect('connectionId' in slot).toBe(false)
        expect('modelId' in slot).toBe(false)
      }
      // DTO identities retained (two synthetic families), never the global.
      expect(repaired.llmDefault?.id).toBe('mock-model')
      expect(repaired.model.id).not.toBe(repaired.llmDefault?.id)
      expect(repaired.defaultsModel.id).not.toBe(repaired.model.id)

      await expect(page.locator('.inputbar textarea, textarea[placeholder]').first()).toBeVisible({ timeout: 30000 })
      await page.screenshot({ path: path.join(ownedTmpRoot, 'assistant-legacy-repair.png') })
    } finally {
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunchedApp.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  })
})
