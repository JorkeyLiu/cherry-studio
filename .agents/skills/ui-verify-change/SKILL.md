---
name: ui-verify-change
description: Implementation-time UI verification and regression-coverage routing for Cherry Studio. Use when asked to verify a UI change, confirm a fix, test changed UI behavior, or decide UI regression coverage while implementing or reviewing a change (no PR required). Routes evidence to Playwright E2E for contract-worthy cross-component/IPC/persistence/lifecycle/native/multi-window behavior, to Vitest/component tests for isolated stable UI, and classifies generic browser/CDP/screenshot/dev-mode observation as diagnostic only — never regression proof.
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
| Rendering cannot be statically established from component tests | Component test + one diagnostic observation |

## Evidence hierarchy (LOCK-SKILL-3, LOCK-SKILL-4)

Regression evidence comes ONLY from the repository Playwright suite:

- fresh production build (`pnpm build`) produced immediately before the run
- the standard shared `tests/e2e` fixture — never hand-rolled onboarding,
  profile, or mock setup
- a unique disposable user profile
- mocked external providers and deterministic assertions
- scoped runs: `pnpm test:e2e tests/e2e/specs/<spec>.spec.ts`
  or the full suite: `pnpm test:e2e`

Generic Kilo Playwright, agent-browser, CDP sessions, screenshots, and dev-mode
runs are **diagnostic only** (LOCK-SKILL-4). They may help investigate a change
but cannot establish regression completion. They are not forbidden — they are
simply not regression evidence.

Authoring and harness details live in `tests/e2e/README.md` (single source of
truth); this skill references it rather than duplicating it.

## Workflow

### Phase 1: Scope the change

List the changed behavior from the diff — files touched and user-visible
effects — and identify the components, services, and IPC involved.

### Phase 2: Decide the evidence tier

Apply the decision matrix. Default to Vitest/component tests for isolated
stable UI; choose E2E only when the behavior matches an E2E row.

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
- Diagnostics: dev-mode run or browser tooling only to investigate, recorded
  explicitly as diagnostic.

### Phase 5: Report (LOCK-SKILL-7)

The final report MUST separate:

1. Automated Playwright evidence — spec, command, PASS/FAIL
2. Component/unit evidence
3. Diagnostics — observations and screenshots, not regression proof
4. Missing coverage — behavior no test covers

Never claim regression completion from diagnostics alone.

## Constraints

- Ownership-scoped cleanup; never kill broad process trees (see
  `tests/e2e/README.md`).
- Generic browser tooling is allowed for diagnostics — never claim it is
  forbidden, only that it is not regression evidence (LOCK-SKILL-4).
- No PR checkout/review workflow — that is `cherry-pr-test`'s scope
  (LOCK-SKILL-8).
- Features without tests are not complete (AGENTS.md), but the cheapest
  sufficient test level wins (see `tests/e2e/README.md` §1).
