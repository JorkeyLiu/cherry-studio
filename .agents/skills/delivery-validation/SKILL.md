---
name: delivery-validation
description: Reliable execution and reporting of long-running validation gates in this repository. Use when running completion gates (pnpm format/lint/test), pre-commit validation (pnpm build:check), full tests, lint/format/typecheck, E2E/build/packaging, or any other long-running validation command — and when classifying validation failures or deciding whether prior gate evidence can be reused for the current worktree state.
---

# Delivery Validation

This skill defines how to run the repository's mandatory validation gates
reliably, prove trustworthy success, retry only when a cause actually changed,
and report results honestly. It is the execution companion to the gate policy
stated in the root `AGENTS.md`: the root guide says *which* gates are required
and *what counts as success*; this skill covers *how* to run them, including
budgets, logging, retry, evidence reuse, cleanup, and failure classification.

## When to use

- Running completion gates (`pnpm format`, `pnpm lint`, `pnpm test`) before
  declaring a coding task complete.
- Running the pre-commit gate `pnpm build:check` (`pnpm lint && pnpm
  openapi:check && pnpm test`).
- Running any long-running validation command: full tests, lint, format,
  typecheck, E2E, fresh production builds, or packaging.
- Classifying a validation failure (new vs. known-baseline vs. environmental vs.
  unrelated).
- Deciding whether prior validation evidence is still fresh for the current
  worktree state.

## Determine the required gates

- The root `AGENTS.md` is canonical. Read it to determine which gates are
  mandatory and how success is defined. Never silently waive a gate the
  repository declares.
- `package.json` scripts define exactly what each gate runs (for example,
  `pnpm build:check` is lint + openapi:check + full test; `pnpm test` is the
  ABI preflight followed by all Vitest suites).
- Focused suites supplement, but never replace, the aggregate gates.

## Establish the environment and runtime state first

- Establish the pinned toolchain (Node 24.11.1, pnpm 10.27.0) using the root
  `AGENTS.md` bootstrap rules before any pnpm command. A shadowing Node
  installation silently produces an incompatible native binding.
- Check the matching native ABI for the runtime the gate needs:
  `pnpm native:check:node` for Node test suites, `pnpm native:check:electron`
  for dev/E2E/build/packaging. Always run the check before any rebuild; rebuild
  only when the check's real runtime SQL probe fails or when deliberately
  switching runtime state after a known opposite-ABI build.
- Aggregate commands with preflight integration (`pnpm test`, `pnpm test:e2e`,
  `pnpm build:check`) check the ABI once themselves. Focused sub-suite commands
  are unguarded, so run the matching `native:check:*` first when switching from
  the other ABI state.

## Evidence identity and freshness

- Evidence is valid only for the exact worktree state the gate ran against. The
  gate input surface is what a gate's commands actually consume: source files,
  test files, config files read by the gate commands, the dependency/lockfile
  state, package scripts, generated contracts (for example the OpenAPI spec),
  i18n locale inputs, and API spec definitions — plus the runtime/ABI state and
  the exact command invoked. Documentation, skill, and other markdown files are
  outside that surface: they are not inputs to oxlint/eslint, typecheck, i18n,
  openapi, format, or test, so editing them cannot change what those gates
  validate.
- A code-surface change invalidates evidence. After source, test, config,
  dependency, package-script, or generated-contract changes (including i18n
  locale inputs and API spec definitions), rerun the affected gates against the
  new state — a full `pnpm build:check` before the commit.
- Reuse valid evidence on an unchanged code surface: a passing aggregate command
  proves its nested gates (a passing `pnpm build:check` proves lint +
  openapi:check + full test for that exact code surface), so do not immediately
  repeat the nested gates.
- Focused tests supplement, but never replace, aggregate gates.
- Documentation/skill-only changes do not invalidate code gate evidence. Run the
  directly affected structural checks — for example `pnpm skills:check`,
  symlink/link or reference checks, CLAUDE synchronization, and marker scans —
  and reuse the still-valid full-gate evidence, provided that evidence genuinely
  exists, was recorded completely (trustworthy original exit code, exact
  worktree code state), and covers the same code surface. Never claim a gate
  passed without such evidence, and never silently waive a gate the repository
  declares.
- If no valid full-gate evidence exists for the current code surface (for
  example, the first commit on a fresh code state), run the full gate;
  structural checks do not substitute for it.

## Command classes and default minimum budgets

| Class | Examples | Default minimum budget |
|---|---|---|
| Ordinary focused Vitest | `test:*` sub-suites (main, renderer, aicore, shared, scripts, e2e-utils) | 10 minutes |
| Lint | `pnpm lint` (oxlint + eslint + typecheck + i18n check + format check) | 10 minutes |
| Full test | `pnpm test` (all Vitest suites) | 20 minutes |
| Pre-commit aggregate | `pnpm build:check` | 30 minutes |
| E2E / fresh build + E2E / packaging | `pnpm test:e2e`, fresh `pnpm build` followed by E2E, electron-builder packaging | at least 30 minutes |

- These are initial budgets with headroom, not expected durations, and they
  never authorize killing a command that is still progressing.
- Ordinary focused Vitest suites are deliberately separated from E2E, fresh
  build + E2E, and packaging: the latter are heavier and require larger budgets.
- Increase a budget using trustworthy observed history — your own successful
  runs of the same gate on this machine, or recorded run times from the
  repository — never an undefined "documented bound" or a guess.
- This budget table lives here, not in the root `AGENTS.md`; keep the root
  guide free of procedural tables.

## Running a gate

- Run each aggregate gate once per evidence state. Do not rerun a gate solely
  to inspect its output.
- For output-heavy commands, redirect stdout/stderr to a session-owned log in
  the session-designated temp area outside the worktree, and capture the
  producer's numeric exit status in the same shell invocation.
- Avoid pipelines that mask the producer's status; if a pipeline is
  unavoidable, use `pipefail` and preserve the producer's status correctly.
- If the execution tool truncates output and saves it to a path, read/search
  that saved file instead of rerunning. Never rerun merely to re-see the tail.

## Interpreting outcomes

- Exit 0 = pass. Nonzero = fail. Timeout, killed, or unknown status =
  unverified.
- Printed sub-suite PASS lines, or the absence of FAIL, are insufficient.
  Success requires the trustworthy original exit code of the aggregate command.
- Report timeouts, kills, and unknown statuses honestly as unverified — never
  as success.

## Retry matrix

A rerun is allowed only after an observed cause changed:

- The command failed before starting (for example, an invocation error) — rerun
  once after fixing the invocation.
- A tool/session interruption not caused by the gate (session crash, tool
  failure) left no trustworthy result — rerun the gate against the same
  evidence state.
- The environment/ABI was corrected (pinned toolchain restored, matching ABI
  rebuilt) — rerun once after the correction.
- A documented or observed transient external failure occurred (network,
  registry, service outage) — rerun once after it clears.
- The test suite's own retry policy applies — follow the suite's policy.
- The budget was proved miscalibrated by trustworthy progress/duration evidence
  (for example, retained logs show the gate was still progressing productively
  past the bound) — one rerun with a corrected budget.

A rerun is forbidden:

- To obtain nicer output or to inspect the tail.
- To compensate for an arbitrary short timeout without evidence.
- To explain an unexplained failure by retrying it into a pass.
- Never loop: one rerun per changed cause, then report.

## Budget overrun handling

- If a correctly budgeted run exceeds its bound, report the run as unverified,
  not failed.
- Inspect the retained progress/process evidence (session-owned logs, process
  records) before deciding anything.
- A single corrected-budget rerun is allowed only when that evidence establishes
  the budget was the changed cause. Never loop.

## Cleanup

- Default: after validation completes, delete every temp log/status file or
  directory this session created, and record the cleanup result in the report.
- Retention exception: only on `fail` or `unverified` outcomes may session-owned
  logs be kept for diagnosis; the report must then state the exact paths and the
  reason. Logs are never written inside the repository worktree.
- Cleanup verification: after deletion, confirm the paths no longer exist so
  silent residue is caught.
- Ownership boundary: remove only resources this session created; never touch
  other sessions' leftovers in shared temp areas, and never broad-kill process
  trees.
- Cleanup is part of the validation deliverable, not optional.

## Failure classification

Classify each failing gate:

- **new-failure** — the gate fails on a state where it previously passed or is
  expected to pass; the caller decides next steps.
- **known-baseline** — the gate fails the same way on the clean baseline state;
  not introduced by the current work.
- **environmental** — toolchain, ABI, network, or machine state issue; rerun
  once after the environment is corrected per the retry matrix.
- **unrelated** — the failure is outside the scope of the current work and not
  caused by it.

In validation-only mode, do not fix failures unless the caller assigned
implementation rights; report the classification and let the caller decide.

## Reporting

Report, per gate: runtime/preflight state, command count, the exact command with
status and duration, the subchecks run, the failure classification (if any),
evidence freshness (the code surface and worktree state the result applies to;
when full-gate evidence is reused for a documentation/skill-only change, say so
and list the structural checks that stand in for a rerun), a Cleanup field
showing either "cleaned" or "retained (paths + reason)", and the verdict (pass /
fail / unverified).

## Repository anchors

- Root `AGENTS.md` — mandatory gates, pinned toolchain, native ABI rules,
  success standard.
- `package.json` — exact composition of each gate.
- `tests/e2e/README.md` — E2E standards (fresh build, shared fixture, unique
  disposable profile, mocked external providers, deterministic assertions).
