---
name: ui-verify-change
description: Implementation-time UI verification and regression-coverage routing for Cherry Chat. Use when asked to verify a UI change, confirm a fix, test changed UI behavior, or decide UI regression coverage while implementing or reviewing a change (no PR required). Separates proving the current change (observation can close the current rendered/interactive claim within observed scope) from admitting a durable Playwright E2E asset (lasting protection/reuse value of the workflow and its interrelated business constraints); routes isolated behavior to Vitest and reuses existing E2E assets before creating new ones.
---

# UI Verify Change

Implementation-time UI verification. Separates two independent decisions —
how to prove the current change vs. whether to create or extend a durable
regression asset — maps each to the right evidence, executes it, and reports
without inflated claims.

## When to use

Trigger on implementation/review requests such as:

- "verify this UI change"
- "confirm this fix"
- "test the changed UI"
- "decide UI regression coverage for this change"

No PR is required — this runs during implementation. PR-focused exploratory
validation stays in the `cherry-pr-test` skill; this skill does not check out
PRs, launch debug/CDP sessions, or duplicate that workflow (LOCK-SKILL-8).

## Two decisions (LOCK-SKILL-5)

Proving the current change and admitting a long-term asset are separate
decisions; neither automatically triggers the other.

- **Decision A — prove the current change.** UI observation (`pnpm ui:observe`)
  validates the current rendered/interactive outcome or investigates a problem,
  and can close the current UI correctness claim within its observed scope. It
  does not create durable regression protection. Vitest/component tests cover
  isolated stable behavior. An existing E2E spec may be run where relevant
  without creating a new asset.
- **Decision B — admit a durable asset.** A Playwright E2E spec is a reusable
  test asset: a frozen UI operation sequence plus expected results — an
  executable UI-result-level design document protecting a coherent business
  behavior model against silent future regression. Prefer reusing an existing
  asset before creating one; extend it when the workflow already exists.

## Durable E2E asset admission

Admit a new E2E asset only for lasting protection/reuse value of the workflow
and its interrelated business constraints/transitions — not for needing actual
Electron/UI as such, not for component count, not merely because one bug
occurred, and not for lower-level inability to prove the current visual.
Complexity supports value but sets no module-count threshold; a genuinely
valuable simple workflow may qualify. Assertions and scenarios bound coverage;
they never promise absolute no-regressions.

- **Typically worth an asset:** workflows where interrelated constraints must
  stay consistent — e.g. context-window settings count, anchors, fallback, and
  token-count interrelationships, or branch routing and position behavior.
- **Typically observation only:** local presentation with no interrelated
  business transitions — e.g. scrollbar hit region, layout, icon, color, hover.
  No new E2E spec for this local case; one `pnpm ui:observe` run can close the
  current claim within its observed scope.

## Evidence tiers (LOCK-SKILL-3, LOCK-SKILL-4)

- **Vitest/component tests** are valid component regression evidence for
  isolated stable presentation and logic (pure utils, reducers, selectors,
  single component). Pure-presentation, low-impact tweaks need no new tests
  mirroring implementation detail.
- **Playwright E2E** is the valid integrated-behavior asset tier: the
  repository Playwright suite on a fresh production build (`pnpm build`), the
  standard shared `tests/e2e` fixture, a unique disposable user profile, mocked
  external providers, and deterministic assertions — scoped
  (`pnpm test:e2e tests/e2e/specs/<spec>.spec.ts`) or full (`pnpm test:e2e`).
- **Observation** (`pnpm ui:observe`, screenshots, manual CDP sessions,
  agent-driven browsers, dev-mode runs) validates or investigates the current
  rendered/interactive outcome and can close the current claim within its
  observed scope. It creates no durable regression protection and is never
  claimed as regression proof (LOCK-SKILL-4). Generic browser tooling remains
  allowed for this current-outcome work — only its status as non-regression
  evidence is fixed.

Authoring and harness details for the E2E suite live in `tests/e2e/README.md`
(single source of truth); the observation harness contract lives below and in
`pnpm ui:observe --help`.

## Observation harness (`pnpm ui:observe`)

Implementation-time observation runs through the repository's own
harness for harness-backed claims (LOCK-OBS-001). `pnpm ui:observe` launches
the built Cherry Chat app via the repository's Playwright Electron runtime
with a unique disposable profile, runs exactly one plain async scenario,
captures screenshots/text artifacts, and cleans up exactly what it owns.

- **When to use**: to prove the current rendered/interactive outcome (Decision A)
  or to investigate behavior component tests cannot statically establish. Use it
  instead of Kilo browser MCP, agent-browser, or ad-hoc CDP sessions for
  harness-backed observation. It does NOT create a durable regression asset.
- **Prerequisite**: a fresh production build — `pnpm build` immediately before
  the run (the harness launches `electron .` against the built output, exactly
  like E2E).
- **Command shape** (Electron runtime — no rebuild, no lock wait, no manual
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
- **Evidence classification**: `ui:observe` output validates the current
  rendered/interactive outcome within its observed scope (LOCK-OBS-002) — it can
  close the current UI correctness claim at that scope. It creates no durable
  regression protection; only a Playwright E2E asset does. Report the run as
  current-outcome evidence with its scope, never as regression proof.

## Workflow

### Phase 1: Scope the change

List the changed behavior from the diff — files touched and user-visible
effects — and identify the components, services, and IPC involved.

### Phase 2: Decide the evidence (two decisions)

Separate the calls. For Decision A, default to Vitest/component tests for
isolated stable UI and to one `pnpm ui:observe` run where the current
rendered/interactive outcome must be seen; an existing E2E spec may be run
where relevant without creating a new asset. For Decision B, admit a new E2E
asset only per the admission section above.

### Phase 3: Map to existing coverage (LOCK-SKILL-6)

Before writing anything:

- Search for component/unit coverage (`src/renderer/src/**/__tests__`, `*.test.*`)
  covering the changed behavior.
- Search `tests/e2e/specs/` for Playwright specs covering it; prefer reusing or
  extending an existing asset over creating one.
- Read `tests/e2e/README.md` before touching the E2E harness.
- Create a new spec under `tests/e2e/specs/` only when the workflow earns a
  durable asset per the admission section and is uncovered. Always use the
  shared fixture; never hand-roll onboarding/profile/mock setup.

### Phase 4: Execute

- Component tier: `pnpm test:renderer` or a scoped `pnpm vitest run <file>`.
- Existing E2E asset: `pnpm build`, then
  `pnpm test:e2e tests/e2e/specs/<spec>.spec.ts` (Electron runtime — the shared
  Node-API prebuilt loads as-is, no manual `native:check:electron` prefix
  is needed), or `pnpm test:e2e` for the full suite.
- Observation: `pnpm build`, then `pnpm ui:observe app-ready` (baseline) or a
  scenario file (see the observation harness section above). Record the run
  with its observed scope as current-outcome evidence.

### Phase 5: Report (LOCK-SKILL-7)

The final report MUST separate:

1. Current-change proof — Playwright specs run, component/unit results, and
   `pnpm ui:observe` observations with scope, each with command and PASS/FAIL
2. Durable-asset decision — reused, extended, newly created, or explicitly
   declined (with the value reason), and the workflow's coverage bounds
3. Missing coverage — behavior no test or observation covers

Claim the current outcome only within its observed scope; never promise
absolute no-regressions from any single run or asset.

## Constraints

- Ownership-scoped cleanup; never kill broad process trees (see
  `tests/e2e/README.md`).
- Observation goes through `pnpm ui:observe`; generic browser
  tooling remains allowed for current-outcome work — never claim it is forbidden, only
  that it is not durable regression protection (LOCK-SKILL-4).
- No PR checkout/review workflow — that is `cherry-pr-test`'s scope
  (LOCK-SKILL-8).
- Product features without tests are not complete (AGENTS.md); pure-presentation,
  low-impact tweaks need no new tests mirroring implementation detail (see
  `tests/e2e/README.md` §1).
