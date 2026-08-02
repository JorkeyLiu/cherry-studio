# E2E Testing Guide (Playwright + Electron)

This README is the **single source of truth** for the repository's Playwright/Electron
end-to-end (E2E) operations and authoring. It is maintained in sync with the committed
harness in `tests/e2e/` and `playwright.config.ts`. If the harness changes, update this
document in the same change.

**CI status (factual):** E2E is **not** part of standard CI today. `.github/workflows/ci.yml`
contains no `test:e2e` / Playwright step, and `ci:test-check` covers only the Vitest projects
(main, renderer, aiCore, shared, scripts). E2E currently runs **locally/manually**. Do not
report CI E2E results.

---

## 1. When to write E2E vs. unit/component tests

E2E is expensive: it boots the real Electron app, exercises real IPC, real persistence and
real rendering. Use it deliberately.

| Concern | Prefer |
|---|---|
| Isolated logic, reducers, selectors, pure utils, component behavior | Vitest unit/component tests (`src/main/**`, `src/renderer/**`, `packages/**`, `scripts/**` — see `vitest.config.ts`) |
| Full app boot, real IPC round-trips, main-process behavior | E2E |
| Filesystem / database persistence (Dexie, SQLite via ChatDb), relaunch survival | E2E |
| Native integrations, multiple windows, app lifecycle | E2E |
| Long user journeys spanning real UI | E2E |

Write an E2E spec only when the behavior cannot be proven at a lower level. Features
without tests are not complete — but the cheapest sufficient test level wins.

## 2. Repository layout (committed harness)

The harness follows a stable top-level pattern; the exact file set under `pages/`,
`specs/` and `utils/` grows as the suite evolves, so this document does **not** keep an
exhaustive file-by-file tree:

```text
tests/e2e/
├── README.md                   # this document
├── global-setup.ts             # artifact dirs only (ownership cleanup is fixture-owned)
├── fixtures/
│   ├── electron.fixture.ts     # shared test/expect + app lifecycle + owned temp root (use this!)
│   └── mock-openai-server.ts   # deterministic OpenAI-compatible mock endpoint
├── pages/                      # Page Object Model — BasePage + one file per page, re-exported via index.ts
├── specs/                      # test files (testDir root); feature subdirectories allowed
└── utils/                      # helpers — wait-helpers.ts, run-ownership.ts + its Vitest coverage
```

The canonical, always-current listing of what is actually committed is generated, not
hand-maintained:

```bash
git ls-tree -r HEAD --name-only tests/e2e
```

Layout claims must be derived from that command — i.e. from `HEAD`, the committed state —
never from working-tree files, which may include uncommitted or throwaway artifacts.

## 3. Prerequisites and running

### Prerequisites

1. `pnpm install` — install dependencies (Node ≥24.11.1, pnpm 10.27.0).
2. **`pnpm build` — mandatory fresh build.** E2E launches the built Electron app
   (`electron .` against `electron-vite` output). A stale or absent build makes tests
   validate old code — never run E2E against a build you did not just produce.
   `pnpm build` = `npm run generate:openapi && npm run typecheck && electron-vite build`.

### Native ABI prerequisites (better-sqlite3)

The repository has a **single native module** (`better-sqlite3`) that is compiled for
**either** Node24 (ABI 137) **or** Electron 41.2.1 (ABI 145) — never both at once.
The E2E suite launches the real Electron app, so it requires the **Electron ABI 145**
binding. Verification is runtime SQL only (`.forge-meta` markers and file names are
never trusted as proof):

```bash
pnpm native:check:electron   # read-only: real Database(':memory:') + select 1 + close under Electron
pnpm native:check:node       # read-only: same probe under Node24 (must be on PATH)
```

Command ordering / switching (explicit; preflights never rebuild):

```bash
# Host Node unit tests need the Node binding:
pnpm native:rebuild:node      # node-gyp source build + automatic native:check:node

# E2E / `pnpm dev` need the Electron binding:
pnpm native:rebuild:electron  # @electron/rebuild source build + automatic native:check:electron
pnpm test:e2e                 # preflights native:check:electron once, then runs Playwright
```

- `pnpm test:e2e` preflights `native:check:electron` once before Playwright launches.
- If the binding is currently the Node137 build, E2E fails fast with the exact repair
  command (`pnpm native:rebuild:electron`) instead of silently rebuilding.
- After E2E, restore the host ABI for Node workflows with `pnpm native:rebuild:node`
  (see `docs/sqlite-migration.md` for the full contract and recovery evidence).

### Running (canonical commands via package scripts)

```bash
# Full E2E suite
pnpm test:e2e                     # == pnpm native:check:electron && pnpm playwright test

# A single spec file (direct path — one read-only Electron preflight first)
pnpm native:check:electron && pnpm playwright test tests/e2e/specs/app-launch.spec.ts

# Tests matching a name/title
pnpm native:check:electron && pnpm playwright test -g "should launch"

# A directory (e.g. conversation specs)
pnpm native:check:electron && pnpm playwright test tests/e2e/specs/conversation

# HTML report from the last run (read-only, no app launch — no preflight needed)
pnpm playwright show-report
```

Debugging-oriented invocations (diagnostic only — see §12):

```bash
pnpm native:check:electron && pnpm playwright test --debug      # open inspector, pause at start
pnpm native:check:electron && pnpm playwright test --trace on   # force trace collection for every test
pnpm native:check:electron && pnpm playwright test --ui         # Playwright UI mode
```

The enforced preflight lives in the **`pnpm test:e2e` package wrapper**: it runs
**one** `pnpm native:check:electron` (read-only) before Playwright launches.
Direct `pnpm playwright test` invocations are **not** auto-preflighted — the direct
examples above work because they **explicitly prepend** `pnpm native:check:electron &&`
themselves (same single read-only check, one per direct invocation). Preflight never
rebuilds; a Node137 binding fails fast with `pnpm native:rebuild:electron`.

Notes on running:

- The suite runs **serially**: `workers: 1`, `fullyParallel: false` (Electron apps must not
  run concurrently). Do not override with `--workers`.
- **Headed/headless does not apply to Electron.** The fixture launches the real app and its
  window appears on screen. The old guidance to use `--headed` is wrong for Electron and was
  removed.
- Each test launches its own disposable app instance (see §4/§5). Long-running suites are
  expected; raise `test.setTimeout(...)` inside a test only when its flow legitimately
  exceeds the 60s default.

## 4. The shared fixture — always use it

Import `test` and `expect` from the shared fixture. Never hand-roll an Electron launch in a
spec, and never point an app at a real/live profile.

```typescript
import { expect, test } from '../../fixtures/electron.fixture'
```

The fixture extends `@playwright/test` with:

| Fixture | Provides |
|---|---|
| `ownedTmpRoot` | The unique atomic canonical temp root for this test (mkdtemp under the canonical OS temp dir); all test-owned temp artifacts live here and TMPDIR/TMP/TEMP point at it |
| `userDataDir` | A unique disposable profile dir beneath the owned root (`cherry-e2e-*`); exact-cleaned and root-removed after the test, throwing on cleanup failure |
| `mockPort` | An ephemeral in-process mock OpenAI-compatible HTTP server (see §6) |
| `electronApp` | `_electron.launch({ args: ['.', '--user-data-dir=<userDataDir>', '--no-sandbox', '--disable-gpu'], ... })`; closed after the test with a WAL-flush wait; request log cleared |
| `mainWindow` | The main `Cherry Studio` window, ready for interaction |

`mainWindow` is fully prepared before your test body runs:

1. **Runtime appData assertion** — probes `window.api.getAppInfo()` and asserts the actual
   runtime `appDataPath` resolves to the expected disposable `<userDataDir>Dev` path. If a
   `config.json` redirect ever pointed the app at live user data, the fixture throws a
   `LOCK-002 VIOLATION` before any mutation.
2. **Onboarding bypass** — clicks Skip and marks onboarding complete.
3. **Mock provider seed** — dispatches `llm/addProvider` (`mock-openai`) and sets
   `mock-model` as default/quick/translate model, then verifies the store state.
4. **Home readiness, ChatDb IPC readiness, textarea readiness** — verified before the test
   starts; failures are fail-fast.

Exported helpers (import them from the fixture):

```typescript
import {
  getChatDbPath,            // runtime chat.db path (derived from runtime appDataPath)
  getRuntimeAppDataPath,    // appDataPath captured from the running app
  getUserDataDir,           // the disposable profile dir passed via --user-data-dir
  queryChatDbViaElectron,   // read-only SQLite query via the Electron binary (ABI-safe)
  getRequestLog,            // all mock server requests
  clearRequestLog,          // clear log (sequence counter stays monotonic)
  findProductRequest,       // first POST chat/completions request
  findProductRequestAfter,  // first POST chat/completions request with sequence >= N
  getRequestSequence        // current mock request sequence counter
} from '../../fixtures/electron.fixture'
```

## 5. Disposable profiles and run ownership

Non-negotiable rules:

- **Every test uses a unique disposable profile** created by the fixture under the OS temp
  dir (`cherry-e2e-*`). Real user data must never be opened, seeded, or asserted.
- **One atomic owned temp root per test.** The fixture creates exactly one unique
  canonical temp root via `mkdtemp` under the canonical OS temp dir
  (`$TMPDIR/cherry-e2e-owned-*`). The main profile, seed profiles, query scripts, Vite
  temp files and production `os.tmpdir()` workspaces all live beneath that root
  (TMPDIR/TMP/TEMP point at it). Uniqueness comes from `mkdtemp`; there is no registry,
  run token, or global state.
- **Exact-token process cleanup.** Never `pkill`, `killall`, kill-by-PID guesswork, or
  `rm`/glob patterns over `cherry-e2e-*`. A spawned, relaunched, or external child process
  is terminated **only by its exact unique `--user-data-dir=<profile>` token** and its
  absence is verified (bounded stable-empty window). The fixture-owned app is closed
  normally with `electronApp.close()` plus exact-token cleanup.
- **Fail-closed root teardown.** The fixture exact-cleans every known profile (main app
  profile plus any registered seed profiles), then — only if all clean and the exact root
  still validates (real non-symlink directory, expected prefix) — recursively removes the
  root and verifies absence. On any cleanup failure, remaining PID, or validation failure
  the root is preserved and the error propagates. There is **no global teardown** and no
  cross-run/global deletion.
- **Accepted residual.** A hard runner SIGKILL, machine loss, or cleanup-code failure may
  leave the uniquely prefixed disposable root behind for manual cleanup; there is no
  global cross-process recovery.

If a manual investigation of leftover temp dirs is ever needed: look in `$TMPDIR` for
`cherry-e2e-owned-*` entries and remove them by exact path only.

## 6. Mock provider — no live APIs

All E2E traffic goes through the **in-process mock OpenAI-compatible server**
(`fixtures/mock-openai-server.ts`), bound to `127.0.0.1` on an ephemeral port and seeded
into the app as the `mock-openai` provider with model `mock-model`.

- **Never** configure a real/paid/live API key or endpoint in a test.
- The mock validates request shape (`messages` array with at least one user message) and
  returns **deterministic** responses — streaming (SSE) and non-streaming — of the form
  `[Mock <model>] You said: "<last user message>"`.
- Every request is logged with a **monotonic sequence counter**. Capture
  `getRequestSequence()` before an operation, then assert on
  `findProductRequestAfter(seq)` to prove a specific product-originated request was sent —
  this is request-path evidence, independent of the UI.

## 7. Deterministic assertions (evidence classes)

Evidence expectations scale with **workflow risk**:

- **Low-risk smoke checks** — simple launch/navigation specs may rely on direct UI
  assertions (window ready, expected page rendered, navigation occurred). They need not
  assert persistence.
- **Durable-workflow checks** — persistence, IPC round-trip, filesystem, and relaunch
  specs must assert the **authoritative final state** (e.g. post-exit SQLite queries via
  `queryChatDbViaElectron` — §11; mock request logs — §6; filesystem state), not just UI
  or Redux appearance. Redux dispatches alone are NOT persistence evidence.

For claims that must be durable, prefer several independent, deterministic evidence classes
over visual impressions:

1. **Real UI gestures** — the action is performed through the rendered UI (clicks, typing,
   real drag). No Redux response fabrication.
2. **Mock request log** — the AI SDK actually made the HTTP request with the expected
   `model`/`messages` (see §6).
3. **Redux state snapshots** — read `window.store.getState()` for the *expected* message
   blocks, IDs, topic ordering, etc. Redux reads are an independent oracle, but **Redux
   dispatches alone are NOT persistence evidence**.
4. **SQLite (post-exit) queries** — the durable proof. Query `chat.db` read-only through
   `queryChatDbViaElectron()` at the runtime path (see §11).

Assert exact IDs before/after destructive operations (capture IDs, then assert exact
presence → exact absence). Use Playwright's auto-retrying assertions (`expect(...).toBeVisible()`,
`toHaveText`, `toHaveCount`) instead of raw booleans where possible; use
`page.waitForFunction(...)` for Redux-state transitions.

## 8. Selectors, waits, and Page Objects

### Page Object Model

- **Prefer** `pages/` classes extending `BasePage` for **reusable page-level workflows**
  (navigation, settings, sidebar). Register new page objects in `pages/index.ts` and
  import them from there.
- Feature-specific interactions may use **local locators directly in a spec** when they are
  scoped to that workflow, as long as they follow the selector conventions below. Do not
  force a one-off interaction into a POM class just to satisfy a rule.
- Construct page objects with the `mainWindow` fixture in `beforeEach`.

### Selector priority (most stable first)

1. **Semantic/stable attributes the app already renders** — e.g. `data-topic-id`, `data-testid`
   (the app renders `data-testid="topic-item"`, `trash-restore-btn`, etc.). Prefer these
   over class fragments.
2. **Accessible roles / labels** — `getByRole('button', { name: ... })`, `getByText(...)`.
3. **Class fragments** that survive style changes — `[class*="Inputbar"]` (for
   styled-components/CSS Modules).
4. **Combined fallbacks** — `['#chat', '.inputbar-container', '[class*="Inputbar"]'].join(', ')`.

**Avoid:** exact generated class names, deep chains, and positional index selectors
(`nth()`) unless there is no alternative.

### Wait strategy

- Prefer **state-based waits** and auto-retrying `expect` — never hard-coded sleep to
  satisfy a race.
- Use the shared helpers in `utils/wait-helpers.ts`:
  `waitForAppReady`, `waitForNavigation`, `waitForChatReady`, `waitForSettingsLoad`,
  `waitForModal`, `waitForModalClose`, `waitForLoadingComplete`, `waitForNotification`.
- `waitForTimeout` is acceptable only where the app has a known non-observable delay (the
  fixture itself uses it sparingly for Redux settle/flush). Do not sprinkle sleeps.

### Minimal example

```typescript
// tests/e2e/specs/<feature>/<feature>.spec.ts
import { expect, test } from '../../fixtures/electron.fixture'
import { SomePage } from '../../pages/some.page'
import { waitForAppReady } from '../../utils/wait-helpers'

test.describe('Feature Name', () => {
  let somePage: SomePage

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
    somePage = new SomePage(mainWindow)
  })

  test('should do the thing', async ({ mainWindow }) => {
    await somePage.doSomething()
    await expect(somePage.result).toHaveText('expected')
  })
})
```

## 9. Platform-specific behavior

- Tests that depend on OS-specific behavior **must** gate with an explicit skip at the top
  of the `describe`/`test` — never silently pass on unsupported platforms:

```typescript
test.describe('macOS-only flow', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS')
  test('...', async ({ mainWindow }) => { /* ... */ })
})
```

- The fixture already handles macOS path resolution (`/var` → `/private/var` symlink) when
  asserting the runtime appData path; keep that in mind when writing path assertions.

## 10. App lifecycle: close, relaunch, multiple windows

- **Close:** `await electronApp.close()`. The fixture waits ~3s afterwards for SQLite WAL
  flush — keep that settle window before post-exit verification (§11).
- **Relaunch:** if a test needs to relaunch the app, relaunch with the **same owned
  disposable profile** (`getUserDataDir()`) and close the new instance before the test ends.
- **Multiple windows:** obtain additional windows from the app via
  `electronApp.waitForEvent('window', { predicate: ... })`. All windows are owned by the
  fixture's `electronApp`; close the app (not individual windows) for teardown.
- The fixture-owned `electronApp` is always terminated normally — `electronApp.close()`
  plus fixture teardown. The exact `--user-data-dir=` token rule (§5) applies only to
  **spawned, relaunched, or external child processes** the test must stop itself — never
  by broad process matching.

## 11. Post-exit persistence verification

The committed specs (e.g. `conversation/topic-trash-lifecycle.spec.ts`) establish the
canonical pattern for proving durability:

```typescript
import * as fs from 'fs'

// 1. Close the app and let SQLite flush its WAL
await electronApp.close()
await new Promise((resolve) => setTimeout(resolve, 3000))

// 2. chat.db must exist at the RUNTIME path (not a predicted one)
const chatDbPath = getChatDbPath()          // <runtime appDataPath>/Data/chat.db
expect(chatDbPath).not.toBeNull()
expect(fs.existsSync(chatDbPath!)).toBe(true)

// 3. Query read-only via the Electron binary (ABI-safe native module).
//    queryChatDbViaElectron takes a SQL string; escape substituted values as the
//    committed specs do (no unescaped string concatenation, no positional indexing).
const topicId = 'captured-topic-id'        // exact ID captured from the UI/Redux
const esc = (value: string) => value.replace(/'/g, "''")
const result = queryChatDbViaElectron(
  chatDbPath!,
  `SELECT id, deleted_at FROM topics WHERE id = '${esc(topicId)}'`
)
expect(result?.ok).toBe(true)
```

Use the runtime path from `getChatDbPath()`/`getRuntimeAppDataPath()` — never a path
predicted from `getUserDataDir()` — because Electron may resolve `/var` differently.

## 12. Debugging vs. evidence

Diagnostics are for **finding bugs, never for proving behavior**:

- `mainWindow.screenshot(...)` / `page.screenshot(...)` — diagnostic images only.
- `console.log`/`console.error` with an `[E2E]` prefix — diagnostic output (the fixture and
  committed specs use it for fail-fast context).
- `--debug`, Playwright UI mode, manual CDP sessions, dev-mode (`pnpm dev`) runs —
  diagnostic only; never sufficient regression evidence.
- Playwright's failure artifacts — trace/screenshot/video (retained on failure by config)
  under `test-results/` — **diagnose why a deterministic test failed** (e.g. the DOM
  state at the moment of failure). They are investigation aids for failed tests and are
  **never standalone regression evidence**: they cannot independently establish that a
  behavior passed. A pass is proven only by deterministic assertions (§7) on the fresh
  build.

Regression evidence is what CI-grade suites are judged on:

- **Fresh production build** (`pnpm build`) immediately before the run.
- **The standard fixture** (`electron.fixture`) with a unique disposable profile.
- **Mocked providers** — no live API access.
- **Deterministic assertions** (§7), including post-exit persistence (§11).

## 13. Cleanup and failure artifacts

**Cleanup**

- The fixture exact-cleans every known profile and removes its exact owned temp root after
  each test, **verifying removal** and throwing an aggregate error on any failure (never
  swallowed). Global setup only creates artifact dirs; there is no global teardown.
- No broad `pkill`/`killall`/glob deletion anywhere in the flow.

**Failure artifacts** (from `playwright.config.ts`)

| Path | Contents |
|---|---|
| `test-results/` | `outputDir` — traces, videos, screenshots (retain-on-failure), plus `screenshots/` created by global setup |
| `playwright-report/` | HTML report — view with `pnpm playwright show-report` |

After a failed run, read the trace (`show-report` → trace viewer) to diagnose why the test
failed before re-running. Failure artifacts support the failed-test investigation (see
§12); they never independently establish pass evidence.

## 14. Playwright configuration reference

From `playwright.config.ts` (root):

| Setting | Value | Meaning |
|---|---|---|
| `testDir` | `./tests/e2e/specs` | Test discovery root |
| `timeout` | 60 000 ms | Per-test timeout |
| `expect.timeout` | 10 000 ms | Auto-retry assertion timeout |
| `fullyParallel` / `workers` | `false` / `1` | Serial Electron execution |
| `forbidOnly` | `!!process.env.CI` | Fails on stray `test.only` under CI env |
| `retries` | `process.env.CI ? 2 : 0` | Retries only when a CI env var is set |
| `reporter` | html (`playwright-report`) + list | Local report |
| `globalSetup` | `./tests/e2e/global-setup.ts` | Artifact dirs only (ownership cleanup is fixture-owned) |
| `outputDir` | `./test-results` | Artifact output |
| `use.trace/screenshot/video` | `retain-on-failure` / `only-on-failure` | Failure artifacts (diagnostic only — see §12) |
| `use.actionTimeout` / `navigationTimeout` | 15 000 / 30 000 ms | Action/navigation timeouts |

## 15. Authoring checklist

When adding or modifying an E2E spec:

- [ ] Reused the shared fixture (`import { test, expect } from '../../fixtures/electron.fixture'`) — no custom `_electron.launch`, no live profile.
- [ ] Ran `pnpm build` before `pnpm test:e2e` (fresh output).
- [ ] Reusable page-level workflows go through a `pages/` POM (registered in `pages/index.ts`); feature-specific spec locators follow the selector conventions (§8).
- [ ] Provider traffic is the mock endpoint only; no real API keys.
- [ ] Evidence depth matches workflow risk: simple launch/navigation smoke may rely on direct UI assertions; persistence/IPC/filesystem/relaunch flows assert authoritative final state (§7).
- [ ] Deterministic assertions from ≥2 evidence classes for durable claims; Redux-only dispatches are not treated as persistence proof.
- [ ] Persistence claims verified post-exit via `queryChatDbViaElectron` at the runtime path.
- [ ] Exact-ID before/after asserts for destructive operations.
- [ ] State-based waits, no sleep-to-race; platform-specific behavior explicitly skipped.
- [ ] Test runs serially; cleanup is fixture-owned and verified.
- [ ] No `pkill`/`killall`/glob deletion; spawned/relaunched/external child processes terminated only by exact profile token (fixture-owned app uses `electronApp.close()`).

## 16. Related documentation

- [Playwright test runner docs](https://playwright.dev/docs/test-intro)
- [Playwright Electron support](https://playwright.dev/docs/api/class-electron)
- [Page Object Model](https://playwright.dev/docs/pom)
- Repository conventions: `AGENTS.md` (top-level), `vitest.config.ts`, `playwright.config.ts`
