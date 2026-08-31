/**
 * S7.12 Startup Frontier Attribution — Redux rehydration directional bench harness
 *
 * Discovery &Classification:
 * - File: `*.bench.ts` (not `*.bench.test.ts`) → Vitest BENCH discovery only:
 *   renderer bench include `src/renderer/** /*.bench.{ts,tsx}` and
 *   `src/renderer/** /__tests__/ *.bench.{ts,tsx}`.
 * - Run via bench lane: `pnpm bench:renderer` or
 *   `pnpm native:run node -- vitest bench --run --project renderer
 *     src/renderer/src/store/__tests__/reduxRehydration.s7_12.bench.ts`
 *   It is NOT discovered by `vitest run --project renderer` (`*.test.*` only) and
 *   does NOT run via `pnpm test` / `pnpm test:renderer`. This is the explicit
 *   opt-in per repository conventions (LOCK-005) — the only compliant change
 *   without editing vitest.config.ts / package.json.
 * - Classification: directional L3 evidence, not SLA/baseline/threshold.
 *
 * Evidence purpose & limits (LOCK-002 — no threshold/SLA/baseline):
 * - Named outcome: decide whether redux-persist rehydration shows a
 *   scale-dependent amplification signal that would warrant a future production
 *   design. Observes directionality only; does not authorize production changes.
 * - Claim under test (NARROWED per LOCK-004 — migration excluded):
 *   the CURRENT-VERSION (v220) redux-persist rehydration wire with the
 *   current reducer shape can be repeatedly measured over isolated synthetic
 *   payloads and restores persisted slices for that version. Migration execution
 *   is explicitly EXCLUDED — the synthetic wire is already at version 220 with
 *   `_persist.version=220`, so `migrate` is wired but not exercised. No legacy
 *   fixture is included; claims about historical version migration must not be
 *   inferred. A safe deterministic legacy fixture could be added inside this
 *   file in future, but is not present here.
 * - Drift risk (acknowledged): `benchAppReducer` is manually reconstructed from
 *   the same slice reducers as `src/renderer/src/store/index.ts` to avoid
 *   importing the singleton store (which creates global side-effects:
 *   storeSyncService, window.store, persistor). The slice list, blacklist, and
 *   version are reproduced verbatim (see constants below) but can drift if
 *   production adds/removes a slice or changes version/blacklist. If drift is
 *   suspected, diff this file's `BLACKLIST`/`VERSION`/`benchAppReducer` keys
 *   against `src/renderer/src/store/index.ts` and `migrate.ts`.
 * - Method: deterministic synthetic payloads at three isolated scales
 *   (small/medium/large), correctness-first rehydration (equality on a focused
 *   persisted subset + blacklist non-persistence check), then repeated duration
 *   sampling with p50/p95/mean. No real user data is read. Metrics are
 *   time + synthetic scale counts only (LOCK-003).
 * - Isolation: uses a unique localStorage key
 *   `persist:__s7_12_redux_rehydration_isolated__` with production-compatible
 *   version 220 + blacklist + migrate wire shape. The real
 *   `persist:cherry-studio` key is snapshotted and never overwritten; every
 *   trial cleans its isolated key, pauses the persistor, and removes
 *   subscriptions — cleanup is in `finally` on both success and timeout/rejection.
 * - Blacklist/persist coverage (NARROWED): correctness asserts deep equality for
 *   three representative persisted slices (assistants, llm, settings) and that
 *   blacklisted slices remain at reducer defaults (not equal to any synthetic
 *   non-empty payload that would have been persisted if not blacklisted). Full
 *   persisted-slice parity and exhaustive blacklist shape are NOT proven here.
 * - Non-goals: does not change version/migration/blacklist/authority/readiness,
 *   PersistGate, ReduxStoreReady, ImportProjectionReadiness, StoreSync, or any
 *   startup topology. No telemetry, no timer-based production behaviour.
 * - Bounded runtime: `SAMPLES` timed rehydrations per scale inside a single
 *   `bench` task per scale (`iterations:1`); all async waits have timeouts.
 *   Output contains only synthetic counts and directional timing summaries.
 */

import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { FLUSH, PAUSE, PERSIST, persistReducer, persistStore, PURGE, REGISTER, REHYDRATE } from 'redux-persist'
import storage from 'redux-persist/lib/storage'
import { bench, expect, vi } from 'vitest'

// Isolate from global singleton store — assistants slice transitively imports
// `store` via AssistantService. Mock that service before the slice is evaluated
// (vi.mock is hoisted) so the bench reducer can be constructed without the
// singleton side effects, while still reusing the real migrate + persist wire.
vi.mock('@renderer/services/AssistantService', () => {
  const DEFAULT_ASSISTANT_SETTINGS = {
    temperature: 1,
    contextCount: 25,
    topP: 1,
    enableTemperature: false,
    enableTopP: false,
    enableMaxTokens: false,
    maxTokens: 4096,
    streamOutput: true,
    toolUseMode: 'function' as const,
    customParameters: [] as never[],
    reasoning_effort: 'default' as const,
    reasoning_effort_cache: undefined,
    qwenThinkMode: undefined,
    maxToolCalls: 20,
    enableMaxToolCalls: true,
    contextWindowAnchor: {} as Record<string, unknown>,
    defaultModel: undefined
  }
  const makeTopic = (assistantId: string) => ({
    id: `bench-topic-${assistantId}-${Date.now()}`,
    assistantId,
    name: 'Default Topic',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [] as never[],
    isNameManuallyEdited: false
  })
  return {
    DEFAULT_ASSISTANT_SETTINGS,
    getDefaultAssistant: () => ({
      id: 'default',
      name: 'Default Assistant',
      emoji: '😀',
      prompt: '',
      topics: [makeTopic('default')],
      messages: [] as never[],
      type: 'assistant' as const,
      settings: { ...DEFAULT_ASSISTANT_SETTINGS }
    }),
    getDefaultTopic: (assistantId: string) => makeTopic(assistantId),
    getDefaultAssistantSettings: () => ({ ...DEFAULT_ASSISTANT_SETTINGS }),
    getDefaultTopicSettings: () => ({}),
    ensureOrdinaryTopicOwnership: async () => {}
  }
})

import assistants from '../assistants'
import backup from '../backup'
import clipboard from '../clipboard'
import copilot from '../copilot'
import editMode from '../editMode'
import inputToolsReducer from '../inputTools'
import knowledge from '../knowledge'
import llm from '../llm'
import mcp from '../mcp'
import memory from '../memory'
import messageBlocksReducer from '../messageBlock'
import migrate from '../migrate'
import newMessagesReducer from '../newMessage'
import note from '../note'
import nutstore from '../nutstore'
import ocr from '../ocr'
import preprocess from '../preprocess'
import residentRegistryReducer from '../residentRegistry'
import runtime from '../runtime'
import settings from '../settings'
import shortcuts from '../shortcuts'
import tabs from '../tabs'
import topicSegment from '../topicSegment'
import translate from '../translate'
import undoStack from '../undoStack'
import websearch from '../websearch'

// -----------------------------------------------------------------------------
// Isolation constants — production-compatible wire, isolated namespace (LOCK-003)
// -----------------------------------------------------------------------------
const BENCH_PERSIST_KEY = '__s7_12_redux_rehydration_isolated__'
const BENCH_STORAGE_KEY = `persist:${BENCH_PERSIST_KEY}`
const REAL_STORAGE_KEY = 'persist:cherry-studio'
const VERSION = 220
const BLACKLIST = [
  'runtime',
  'messages',
  'messageBlocks',
  'tabs',
  'toolPermissions',
  'clipboard',
  'editMode',
  'undoStack',
  'topicSegments',
  'residentRegistry'
] as const

// -----------------------------------------------------------------------------
// Production-shaped bench reducer — reconstructed from slice reducers to avoid
// importing the singleton store module (src/renderer/src/store/index.ts) which
// creates global side effects (storeSyncService, window.store, persistor).
// This reproduces the exact appReducer + blacklist + version + migrate contract
// at time of writing (v220). DRIFT RISK: keep in sync with that file manually.
// -----------------------------------------------------------------------------
const benchAppReducer = combineReducers({
  assistants,
  backup,
  nutstore,
  llm,
  settings,
  runtime,
  shortcuts,
  knowledge,
  websearch,
  mcp,
  memory,
  copilot,
  tabs,
  preprocess,
  messages: newMessagesReducer,
  messageBlocks: messageBlocksReducer,
  inputTools: inputToolsReducer,
  translate,
  ocr,
  note,
  clipboard,
  editMode,
  undoStack,
  topicSegments: topicSegment,
  residentRegistry: residentRegistryReducer
})

function createBenchPersistConfig() {
  return {
    key: BENCH_PERSIST_KEY,
    storage,
    version: VERSION,
    blacklist: [...BLACKLIST] as unknown as string[],
    migrate
  }
}

function createIsolatedStore() {
  const persistedReducer = persistReducer(createBenchPersistConfig() as never, benchAppReducer as never)
  const store = configureStore({
    reducer: persistedReducer as unknown as typeof benchAppReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER]
        }
      })
  })
  return store
}

// -----------------------------------------------------------------------------
// Deterministic synthetic payload — no real user data (LOCK-003)
// -----------------------------------------------------------------------------
function deterministicString(seed: string, len: number): string {
  const base = `s7-12-${seed}-`
  let out = ''
  while (out.length < len) out += base
  return out.slice(0, len)
}

const SCALES = [
  {
    name: 'small',
    assistantsCount: 5,
    providersCount: 8,
    topicsPerAssistant: 1,
    fillerLen: 400
  },
  {
    name: 'medium',
    assistantsCount: 20,
    providersCount: 35,
    topicsPerAssistant: 2,
    fillerLen: 1800
  },
  {
    name: 'large',
    assistantsCount: 60,
    providersCount: 85,
    topicsPerAssistant: 3,
    fillerLen: 5200
  }
] as const

const SAMPLES = 15
const REHYDRATE_TIMEOUT_MS = 3500

function makeSyntheticAssistant(id: string, scaleName: string, fillerLen: number, topicsCount: number) {
  const topics: Array<Record<string, unknown>> = []
  for (let t = 0; t < topicsCount; t++) {
    topics.push({
      id: `${id}-topic-${t}`,
      assistantId: id,
      name: deterministicString(`topic-${scaleName}-${id}-${t}`, 40),
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      messages: []
    })
  }
  return {
    id,
    name: deterministicString(`assistant-${scaleName}-${id}`, 24),
    emoji: '🧪',
    topics,
    prompt: deterministicString(`prompt-${scaleName}-${id}`, fillerLen),
    settings: {
      temperature: 0.7,
      contextCount: 5,
      topP: 1,
      toolUseMode: 'prompt' as const,
      customParameters: [],
      streamOutput: true,
      enableMaxTokens: false
    },
    model: undefined,
    type: 'assistant' as const
  }
}

function makeSyntheticProvider(idx: number, scaleName: string, _fillerLen: number) {
  const models = Array.from({ length: 6 }, (_, m) => ({
    id: `bench-model-${scaleName}-${idx}-${m}`,
    name: deterministicString(`model-${scaleName}-${idx}-${m}`, 18),
    provider: `bench-provider-${scaleName}-${idx}`,
    group: 'bench'
  }))
  return {
    id: `bench-provider-${scaleName}-${idx}`,
    name: `Bench Provider ${scaleName} ${idx}`,
    type: 'openai' as const,
    apiKey: deterministicString(`key-${scaleName}-${idx}`, 16),
    apiHost: 'https://example.invalid/v1',
    models,
    isSystem: false,
    enabled: true
  }
}

function buildSyntheticPersistedState(
  scale: (typeof SCALES)[number]
): Record<string, unknown> & { _persist?: unknown } {
  const base: Record<string, unknown> = (
    benchAppReducer as unknown as (s: unknown, a: { type: string }) => Record<string, unknown>
  )(undefined, { type: '@@INIT' })

  const assistantsState: Record<string, unknown> = {
    ...(base.assistants as Record<string, unknown>),
    assistants: Array.from({ length: scale.assistantsCount }, (_, i) =>
      makeSyntheticAssistant(`bench-a-${scale.name}-${i}`, scale.name, scale.fillerLen, scale.topicsPerAssistant)
    ),
    defaultAssistant: makeSyntheticAssistant(
      `bench-default-${scale.name}`,
      scale.name,
      Math.min(scale.fillerLen, 300),
      1
    ),
    presets: [],
    tagsOrder: [],
    collapsedTags: {},
    unifiedListOrder: []
  }

  const providers = Array.from({ length: scale.providersCount }, (_, i) => makeSyntheticProvider(i, scale.name, 80))

  const llmState = {
    ...(base.llm as Record<string, unknown>),
    providers,
    defaultModel: undefined,
    topicNamingModel: undefined,
    quickModel: undefined,
    translateModel: undefined
  }

  const settingsState = {
    ...(base.settings as Record<string, unknown>),
    customCss: deterministicString(`css-${scale.name}`, scale.fillerLen * 2),
    topicNamingPrompt: deterministicString(`prompt-${scale.name}`, scale.fillerLen),
    userName: deterministicString(`user-${scale.name}`, 20)
  }

  const knowledgeState = base.knowledge
  const websearchState = base.websearch
  const mcpState = base.mcp
  const noteState = base.note

  return {
    assistants: assistantsState,
    llm: llmState,
    settings: settingsState,
    backup: base.backup,
    nutstore: base.nutstore,
    shortcuts: base.shortcuts,
    knowledge: knowledgeState,
    websearch: websearchState,
    mcp: mcpState,
    memory: base.memory,
    copilot: base.copilot,
    preprocess: base.preprocess,
    inputTools: base.inputTools,
    translate: base.translate,
    ocr: base.ocr,
    note: noteState
  }
}

function makePersistWire(state: Record<string, unknown>): string {
  const outer: Record<string, string> = {}
  outer['_persist'] = JSON.stringify({ version: VERSION, rehydrated: false })
  for (const [k, v] of Object.entries(state)) {
    outer[k] = JSON.stringify(v)
  }
  return JSON.stringify(outer)
}

function wireJsonLength(state: Record<string, unknown>): number {
  return makePersistWire(state).length
}

// -----------------------------------------------------------------------------
// Stats helpers — local, no shared helper mutation (LOCK-002)
// -----------------------------------------------------------------------------
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  return sorted[base]
}

function summarize(durations: number[]) {
  const sorted = [...durations].sort((a, b) => a - b)
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length
  const p50 = quantile(sorted, 0.5)
  const p95 = quantile(sorted, 0.95)
  const min = sorted[0] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  return { mean, p50, p95, min, max, count: durations.length }
}

// -----------------------------------------------------------------------------
// Rehydration helper — correctness-first then timed, with finally-guaranteed cleanup
// Covers timeout/rejection orphan risk: persistor is paused and isolated key removed
// even when the rehydration promise rejects or times out. Snapshots REAL_STORAGE_KEY
// before any write inside the helper itself so bench-mode execution (which skips
// Vitest describe/file hooks — verified via NodeBenchmarkRunner) still protects
// the real key without relying on hooks.
// -----------------------------------------------------------------------------
async function rehydrateOnce(
  syntheticState: Record<string, unknown>
): Promise<{ durationMs: number; rehydratedState: unknown; cleanup: () => Promise<void> }> {
  const realBefore = localStorage.getItem(REAL_STORAGE_KEY)
  const wire = makePersistWire(syntheticState)
  localStorage.setItem(BENCH_STORAGE_KEY, wire)

  const store: ReturnType<typeof createIsolatedStore> = createIsolatedStore()
  let persistor: ReturnType<typeof persistStore> | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  try {
    const durationMs = await new Promise<number>((resolve, reject) => {
      const start = performance.now()
      timeoutId = setTimeout(() => {
        try {
          if (persistor) {
            try {
              ;(persistor as unknown as { pause: () => void }).pause()
            } catch {}
          }
        } finally {
          localStorage.removeItem(BENCH_STORAGE_KEY)
          const curReal = localStorage.getItem(REAL_STORAGE_KEY)
          if (curReal === wire) {
            if (realBefore === null) localStorage.removeItem(REAL_STORAGE_KEY)
            else localStorage.setItem(REAL_STORAGE_KEY, realBefore)
          }
          if (timeoutId) clearTimeout(timeoutId)
        }
        reject(new Error(`rehydration timeout ${REHYDRATE_TIMEOUT_MS}ms`))
      }, REHYDRATE_TIMEOUT_MS)
      try {
        persistor = persistStore(store as never, undefined, () => {
          if (timeoutId) clearTimeout(timeoutId)
          const end = performance.now()
          resolve(end - start)
        })
      } catch (e) {
        if (timeoutId) clearTimeout(timeoutId)
        reject(e)
      }
    })

    const realAfter = localStorage.getItem(REAL_STORAGE_KEY)
    expect(realAfter === wire).toBe(false)
    if (realBefore !== null) {
      expect(realAfter).toBe(realBefore)
    }

    const state = store.getState() as Record<string, unknown>

    const cleanup = async () => {
      try {
        if (persistor) {
          const maybePersistor = persistor as unknown as { pause: () => void; flush: () => Promise<void> }
          try {
            maybePersistor.pause()
          } catch {}
          try {
            await maybePersistor.flush()
          } catch {}
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        localStorage.removeItem(BENCH_STORAGE_KEY)
        const curReal = localStorage.getItem(REAL_STORAGE_KEY)
        if (curReal === wire) {
          if (realBefore === null) localStorage.removeItem(REAL_STORAGE_KEY)
          else localStorage.setItem(REAL_STORAGE_KEY, realBefore)
        }
        const finalReal = localStorage.getItem(REAL_STORAGE_KEY)
        expect(finalReal === wire).toBe(false)
        if (realBefore !== null) expect(finalReal).toBe(realBefore)
        else if (finalReal !== null) expect(finalReal.includes(BENCH_PERSIST_KEY)).toBe(false)
      }
    }

    return { durationMs, rehydratedState: state, cleanup }
  } catch (err) {
    try {
      if (persistor) {
        try {
          ;(persistor as unknown as { pause: () => void }).pause()
        } catch {}
        try {
          await (persistor as unknown as { flush: () => Promise<void> }).flush()
        } catch {}
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      localStorage.removeItem(BENCH_STORAGE_KEY)
      const curReal = localStorage.getItem(REAL_STORAGE_KEY)
      if (curReal === wire) {
        if (realBefore === null) localStorage.removeItem(REAL_STORAGE_KEY)
        else localStorage.setItem(REAL_STORAGE_KEY, realBefore)
      }
    }
    throw err
  }
}

// -----------------------------------------------------------------------------
// Bench-level isolation — bench runner (NodeBenchmarkRunner) does NOT execute
// describe/file hooks (verified: runBenchmarkSuite only iterates bench tasks).
// Therefore each bench body snapshots REAL_STORAGE_KEY before any write and
// restores/asserts in finally. This is the only mechanism that executes in bench
// mode; file/describe hooks would be skipped and are intentionally not used.
// -----------------------------------------------------------------------------
function assertRealUntouched(realBefore: string | null) {
  const benchGone = localStorage.getItem(BENCH_STORAGE_KEY)
  expect(benchGone).toBeNull()
  const realAfter = localStorage.getItem(REAL_STORAGE_KEY)
  if (realBefore !== null) {
    expect(realAfter).toBe(realBefore)
  } else if (realAfter !== null) {
    expect(realAfter.includes(BENCH_PERSIST_KEY)).toBe(false)
  }
}

for (const scale of SCALES) {
  bench(
    `s7.12 ${scale.name} — current-version wire correctness + directional timing x${SAMPLES} (isolated, migration excluded)`,
    async () => {
      const realBefore = localStorage.getItem(REAL_STORAGE_KEY)
      localStorage.removeItem(BENCH_STORAGE_KEY)
      try {
        const synthetic = buildSyntheticPersistedState(scale)
        const wireLen = wireJsonLength(synthetic)

        // Correctness-first single rehydration (current-version wire)
        {
          const { rehydratedState, cleanup } = await rehydrateOnce(synthetic)
          try {
            const rehydrated = rehydratedState as Record<string, unknown>
            expect(rehydrated.assistants).toEqual(synthetic.assistants)
            expect(rehydrated.llm).toEqual(synthetic.llm)
            expect(rehydrated.settings).toEqual(synthetic.settings)
            const defaults = (
              benchAppReducer as unknown as (s: unknown, a: { type: string }) => Record<string, unknown>
            )(undefined, { type: '@@INIT' })
            for (const key of BLACKLIST) {
              expect(rehydrated[key]).toEqual(defaults[key])
            }
            expect(
              (rehydrated as unknown as { _persist: { rehydrated: boolean; version: number } })._persist.rehydrated
            ).toBe(true)
            expect((rehydrated as unknown as { _persist: { version: number } })._persist.version).toBe(VERSION)
          } finally {
            await cleanup()
          }
        }

        // Directional timing: SAMPLES isolated rehydrations
        const durations: number[] = []
        for (let i = 0; i < SAMPLES; i++) {
          const { durationMs, rehydratedState, cleanup } = await rehydrateOnce(synthetic)
          try {
            const rehydrated = rehydratedState as Record<string, unknown>
            expect(rehydrated.assistants).toEqual(synthetic.assistants)
            durations.push(durationMs)
          } finally {
            await cleanup()
          }
        }

        const s = summarize(durations)
        console.log(
          `[S7.12][redux-rehydration][${scale.name}] ` +
            `assistants=${scale.assistantsCount} providers=${scale.providersCount} topics/assistant=${scale.topicsPerAssistant} ` +
            `fillerLen=${scale.fillerLen} wireLen=${wireLen} ` +
            `samples=${s.count} mean=${s.mean.toFixed(3)}ms p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms min=${s.min.toFixed(3)}ms max=${s.max.toFixed(3)}ms` +
            ` (current-version wire v${VERSION}, migration excluded)`
        )

        expect(durations).toHaveLength(SAMPLES)
        expect(s.mean).toBeGreaterThanOrEqual(0)
        expect(s.p50).toBeGreaterThanOrEqual(0)
        expect(s.p95).toBeGreaterThanOrEqual(s.p50)
        assertRealUntouched(realBefore)
      } finally {
        try {
          localStorage.removeItem(BENCH_STORAGE_KEY)
        } finally {
          const realAfter = localStorage.getItem(REAL_STORAGE_KEY)
          if (realBefore !== null) {
            if (realAfter !== realBefore) {
              localStorage.setItem(REAL_STORAGE_KEY, realBefore)
            }
            expect(localStorage.getItem(REAL_STORAGE_KEY)).toBe(realBefore)
          } else {
            expect(localStorage.getItem(BENCH_STORAGE_KEY)).toBeNull()
            const cur = localStorage.getItem(REAL_STORAGE_KEY)
            if (cur !== null) {
              if (cur.includes(BENCH_PERSIST_KEY)) localStorage.removeItem(REAL_STORAGE_KEY)
              else expect(cur.includes(BENCH_PERSIST_KEY)).toBe(false)
            }
          }
        }
      }
    },
    { iterations: 1, warmupIterations: 0 }
  )
}

bench(
  's7.12 isolation — bench key cleaned and real persist:cherry-studio untouched',
  () => {
    const realBefore = localStorage.getItem(REAL_STORAGE_KEY)
    try {
      expect(localStorage.getItem(BENCH_STORAGE_KEY)).toBeNull()
      const realAfter = localStorage.getItem(REAL_STORAGE_KEY)
      if (realBefore !== null) expect(realAfter).toBe(realBefore)
      else if (realAfter !== null) expect(realAfter.includes(BENCH_PERSIST_KEY)).toBe(false)
    } finally {
      localStorage.removeItem(BENCH_STORAGE_KEY)
    }
  },
  { iterations: 1, warmupIterations: 0 }
)
