---
name: ui-verify-change
description: Implementation-time UI verification and regression-coverage routing for Cherry Studio. Use when asked to verify a UI change, confirm a fix, test changed UI behavior, or decide UI regression coverage while implementing or reviewing a change (no PR required). Routes evidence to Playwright E2E for contract-worthy cross-component/IPC/persistence/lifecycle/native/multi-window behavior, to Vitest/component tests for isolated stable UI, and to the local `pnpm ui:observe` harness for diagnostic rendered/interactive observation — which is diagnostic evidence only, never regression proof.
---

# UI Verify Change

Implementation-time UI verification. Decides the right evidence tier for a
changed UI behavior, maps it to existing coverage, executes it, and reports
evidence without inflated regression claims.

## When to use

Trigger on implementation/review requests such as:

- "verify this UI change"
- "confirm this fix"
- "test the changed UI"
- "decide UI regression coverage for this change"

No PR is required — this runs during implementation. PR-focused exploratory
validation stays in the `cherry-pr-test` skill; this skill does not check out
PRs, launch debug/CDP sessions, or duplicate that workflow (LOCK-SKILL-8).

## Decision matrix (LOCK-SKILL-5)

E2E is risk-based, not mandatory for every UI edit.

| Changed behavior | Evidence tier |
|---|---|
| Historically regressing behavior; user-visible contract meant to stay stable | Playwright E2E |
| Integrated cross-component workflows (multiple pages/components cooperate) | Playwright E2E |
| IPC round-trips, persistence (Dexie/SQLite), app lifecycle, relaunch survival, native, multi-window | Playwright E2E |
| Isolated stable presentation/logic (pure utils, reducers, selectors, single component) | Vitest/component test |
| Rendering cannot be statically established from component tests | Component test + one diagnostic observation (`pnpm ui:observe`) |

## Evidence hierarchy (LOCK-SKILL-3, LOCK-SKILL-4)

Regression evidence comes ONLY from the repository Playwright suite:

- fresh production build (`pnpm build`) produced immediately before the run
- the standard shared `tests/e2e` fixture — never hand-rolled onboarding,
  profile, or mock setup
- a unique disposable user profile
- mocked external providers and deterministic assertions
- scoped runs: `pnpm test:e2e tests/e2e/specs/<spec>.spec.ts`
  or the full suite: `pnpm test:e2e`

Diagnostic observation goes through the repository's own harness —
`pnpm ui:observe` (see the dedicated section below) — which reuses the E2E
ownership, launch, mock-server, readiness, and cleanup helpers. Generic Kilo
browser MCP, agent-browser, ad-hoc CDP sessions, screenshots, and dev-mode
runs are **diagnostic only** (LOCK-SKILL-4): they may help investigate a
change but cannot establish regression completion. They are not forbidden —
they are simply not regression evidence.

Authoring and harness details for the E2E suite live in `tests/e2e/README.md`
(single source of truth); the observation harness contract lives below and in
`pnpm ui:observe --help`.

## Observation harness (`pnpm ui:observe`)

Implementation-time diagnostic observation runs through the repository's own
harness, never generic browser tooling (LOCK-OBS-001). `pnpm ui:observe` launches
the built Cherry Chat app via the repository's Playwright Electron runtime
with a unique disposable profile, runs exactly one plain async scenario,
captures screenshots/text artifacts, and cleans up exactly what it owns.

- **When to use**: the last row of the decision matrix, or when investigating
  rendered/interactive behavior that component tests cannot statically
  establish. Use it instead of Kilo browser MCP, agent-browser, or ad-hoc CDP
  sessions. It does NOT replace E2E regression specs.
- **Prerequisite**: a fresh production build — `pnpm build` immediately before
  the run (the harness launches `electron .` against the built output, exactly
  like E2E).
- **Command shape** (Electron-lane; self-ensures ABI 145 — no manual
  `native:check:electron` prefix needed):
  - `pnpm ui:observe --help` — usage, exit 0, no app launch
  - `pnpm ui:observe --list` — built-in scenarios, exit 0, no app launch
  - `pnpm ui:observe app-ready` — built-in baseline scenario
  - `pnpm ui:observe ./scenarios/my-observation.ts` — a scenario file
  - `pnpm ui:observe ./scenarios/my-observation.ts -- --output-dir /tmp/obs`
    (flags may also be written without `--`: `... --output-dir /tmp/obs`)
  - `pnpm ui:observe <scenario> -- --timeout-ms 60000` — scenario body timeout
  - Exit codes: 0 = pass (or requested `--help`/`--list`), 1 = scenario/setup/
    cleanup failure, 2 = usage error.
- **Scenario contract** (TypeScript, loaded with the repo `tsx` runtime — no
  eval): default-export a function `(context) => Promise<void>` or an object
  `{ name?, description?, run(context) }`. `context` provides:
  - `context.page` — the ready main `Cherry Chat` window (Playwright Electron
    `Page`)
  - `context.electronApp` — the launched `ElectronApplication`
  - `context.session` — metadata: `userDataDir`, `runtimeAppDataPath`,
    `chatDbPath`, `ownedTmpRoot`, `mockPort`, `outputDir`
  - `context.capture(name)` — screenshot PNG into the output dir (returns the
    absolute path)
  - `context.writeText(name, content)` — UTF-8 text artifact (returns path)
  Example:
  ```typescript
  // scenarios/my-observation.ts
  import type { ObservationContext } from '../../scripts/ui-observe/scenario'
  export default async function observe({ page, capture, session }: ObservationContext) {
    await capture('home')
    await page.getByRole('button', { name: 'New Topic' }).click()
    await capture('after-new-topic')
  }
  ```
  Built-in scenarios live in `scripts/ui-observe/builtin-scenarios/`.
- **Guarantees** (same safe setup obligations as E2E): unique owned temp root
  + unique disposable profile (reuses the `tests/e2e` ownership contract);
  runtime appDataPath asserted to exactly match the disposable profile before
  any interaction (LOCK-OBS-003 — a config redirect to live data throws); mock
  OpenAI provider (`mock-openai` / `mock-model`) seeded; onboarding bypass
  applied; home / ChatDb IPC / textarea readiness verified fail-fast. Real
  user data is never touched; no fixed CDP port; no broad process kills.
- **Output**: stdout reports the scenario, output dir, and PASS/FAIL. Artifacts
  land in `test-results/ui-observe/<scenario>-<timestamp>/` (or
  `--output-dir`), plus a `manifest.json` describing the run (metadata,
  artifacts, error/cleanup status). An explicit `--output-dir` is used exactly
  as given — it is NOT auto-suffixed, so running the harness again with the
  same explicit directory overwrites the earlier artifacts (LOCK-OBS-006). The
  default directory includes a timestamp + random suffix and therefore never
  collides across runs.
- **Cleanup**: the harness exact-cleans its own profile and removes its owned
  temp root in a `finally`, even when the scenario throws (verified). Leftover
  `cherry-e2e-owned-*` roots in `$TMPDIR` are the documented accepted residual
  of the E2E ownership contract — remove by exact path only.
- **Evidence classification**: `ui:observe` output is DIAGNOSTIC evidence. It
  never establishes regression completion — only the repository Playwright E2E
  suite does (LOCK-OBS-002). Report observations as diagnostics, never as pass
  evidence.

## Workflow

### Phase 1: Scope the change

List the changed behavior from the diff — files touched and user-visible
effects — and identify the components, services, and IPC involved.

### Phase 2: Decide the evidence tier

Apply the decision matrix. Default to Vitest/component tests for isolated
stable UI; choose E2E only when the behavior matches an E2E row; choose one
`pnpm ui:observe` diagnostic observation when rendering cannot be statically
established from component tests.

### Phase 3: Map to existing coverage (LOCK-SKILL-6)

Before writing anything:

- Search for component/unit coverage (`src/renderer/src/**/__tests__`, `*.test.*`)
  covering the changed behavior.
- Search `tests/e2e/specs/` for Playwright specs covering it.
- Read `tests/e2e/README.md` before touching the E2E harness.
- If the behavior is contract-worthy and uncovered, extend an existing spec or
  add a focused spec under `tests/e2e/specs/`. Always use the shared fixture;
  never hand-roll onboarding/profile/mock setup.

### Phase 4: Execute

- Component tier: `pnpm test:renderer` or a scoped `pnpm vitest run <file>`.
- E2E tier: `pnpm build`, then
  `pnpm test:e2e tests/e2e/specs/<spec>.spec.ts` (Electron-lane command; it
  self-ensures the ABI 145 binding — no manual `native:check:electron` prefix
  is needed), or `pnpm test:e2e` for the full suite.
- Diagnostics: `pnpm build`, then `pnpm ui:observe app-ready` (baseline) or a
  scenario file (see the observation harness section above). Record the run
  explicitly as diagnostic.

### Phase 5: Report (LOCK-SKILL-7)

The final report MUST separate:

1. Automated Playwright evidence — spec, command, PASS/FAIL
2. Component/unit evidence
3. Diagnostics — `pnpm ui:observe` observations and screenshots, not
   regression proof
4. Missing coverage — behavior no test covers

Never claim regression completion from diagnostics alone.

## Constraints

- Ownership-scoped cleanup; never kill broad process trees (see
  `tests/e2e/README.md`).
- Diagnostic observation goes through `pnpm ui:observe`; generic browser
  tooling remains allowed for diagnostics — never claim it is forbidden, only
  that it is not regression evidence (LOCK-SKILL-4).
- No PR checkout/review workflow — that is `cherry-pr-test`'s scope
  (LOCK-SKILL-8).
- Features without tests are not complete (AGENTS.md), but the cheapest
  sufficient test level wins (see `tests/e2e/README.md` §1).
