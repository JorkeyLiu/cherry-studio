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
native runtime mechanics, budgets, logging, retry, evidence reuse, cleanup, and
failure classification.

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
  `pnpm build:check` is lint + openapi:check + full test; `pnpm test` runs all
  Vitest suites under Node).
- Focused suites supplement, but never replace, the aggregate gates.
- **Non-duplication (LOCK-VG-001):** `pnpm build:check` already runs lint +
  openapi:check + full test for the exact worktree state. Do **not** run
  `pnpm format`, `pnpm lint`, and `pnpm test` separately before
  `pnpm build:check` — run `build:check` **once** per exact worktree state.
  A passing `pnpm build:check` is sufficient aggregate evidence and proves its
  nested gates, so do not immediately repeat those nested gates.
- **Fast-feedback boundary (LOCK-VG-002/003):** `pnpm verify:changed` is
  renderer-only local feedback, **never a completion gate, never a substitute
  for `pnpm build:check`, and never CI proof**. It is strict renderer-only:
  any Main/preload/shared/package/config/scripts/unknown path must fail closed
  with instruction to run `pnpm build:check`; no partial green result. It runs
  via `pnpm native:run node -- ...` and includes
  untracked renderer files; docs-only/no-renderer-change sets exit 0 as a
  no-op without claiming validation proof. CI's path-filter matrix and full
  jobs remain unchanged.

## Establish the environment first

- Establish the pinned toolchain (Node 24.11.1, pnpm 10.27.0) using the root
  `AGENTS.md` bootstrap rules before any pnpm command. Pins protect
  reproducibility and the support baseline, not a per-V8 compiled binding.

## Native runtime: shared prebuilt, no switching

better-sqlite3 13.0.3 uses a Node-API prebuilt: the same packaged file
loads under both Node 24.11.1 and Electron 41.2.1. There is no ABI switching,
rebuilding, restoration, or checkout lock — `node`-runtime gates (`pnpm test`,
`test:*`, `pnpm build:check`) and `electron`-runtime gates (`pnpm build`,
`pnpm test:e2e`, `pnpm ui:observe`) may run in parallel. Runtime machinery lives
in `scripts/native-runtime/`; canonical commands are wired through it in
`package.json`:

- Run the gate's canonical public command directly (`pnpm test`,
  `pnpm test:e2e`, `pnpm build:check`, …). Public `pnpm native:run
  <node|electron> -- <cmd...>` is a lightweight launcher — readonly SQL runtime
  probe plus sanitized spawn, NOT a lane manager. Probes never recompile,
  switch, or share locked mutable state; package platform/NAPI compatibility is
  still required. No `native:check:*` / rebuild sequencing is ever needed;
  `native:rebuild:*` is removed — never try to rebuild or wait on locks.
- Internal `*:run` helpers (`test:run`, `dev:run`, `build:run`, …) are
  implementation helpers, still not normal user entrypoints. Always invoke the
  canonical public command.
- `pnpm native:check:node` / `pnpm native:check:electron` are pure read-only
  diagnostics (`Database(':memory:')` + `select 1 as ok` + close under the
  target runtime). Use them to inspect the current runtime state when
  classifying a native-related failure; never as a required step before a gate.
  Only a real runtime SQL probe proves success; `.forge-meta` markers and
  filenames are never trusted.
- `ELECTRON_RUN_AS_NODE=1` must never be exported in a shell or globally, nor
  used to launch Electron. Only controlled Electron probe children (and the
  existing controlled E2E relay children) may set it.
- Parallelism is allowed: no dev/test runtime exclusivity. Independently
  isolate real shared resources (DB files, profiles, output dirs) — parallel
  runs must never share them.

## Evidence identity and freshness

- Evidence is valid only for the exact worktree state the gate ran against. The
  gate input surface is what a gate's commands actually consume: source files,
  test files, config files read by the gate commands, the dependency/lockfile
  state, package scripts, generated contracts (for example the OpenAPI spec),
  i18n locale inputs, and API spec definitions — plus the Node/Electron runtime
  and the exact command invoked. Documentation, skill, and other markdown files are
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
- The full-test budget covers the whole command, so calibrate it from
  trustworthy observed history of the full run — never hardcode an unsupported
  new number.
- This budget table lives here, not in the root `AGENTS.md`; keep the root
  guide free of procedural tables.

## Running a gate

- Run each aggregate gate once per evidence state. Do not rerun a gate solely
  to inspect its output.
- **Do not duplicate gates:** a passing `pnpm build:check` already proves lint,
  openapi:check, and full test for that exact worktree state. Do not run
  `pnpm format`, `pnpm lint`, or `pnpm test` separately before `pnpm build:check`
  for the same state — that wastes time without changing evidence.
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
- The environment was corrected — pinned toolchain restored, or the native
  runtime diagnosed via the readonly `native:check:*` probes after a real
  SQL probe failure — rerun once after the correction.
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
- **environmental** — toolchain, native runtime, network, or machine state issue; rerun
  once after the environment is corrected per the retry matrix.
- **unrelated** — the failure is outside the scope of the current work and not
  caused by it.

In validation-only mode, do not fix failures unless the caller assigned
implementation rights; report the classification and let the caller decide.

## Reporting

Report, per gate: runtime state (the Node/Electron runtime the gate ran under), command count, the exact command
with status and duration, the subchecks run, the failure classification (if
any), evidence freshness (the code surface and worktree state the result
applies to; when full-gate evidence is reused for a documentation/skill-only
change, say so and list the structural checks that stand in for a rerun), a
Cleanup field showing either "cleaned" or "retained (paths + reason)", and the
verdict (pass / fail / unverified).

## Repository anchors

- Root `AGENTS.md` — mandatory gates, pinned toolchain, native Node-API runtime
  contract, success standard.
- `package.json` — exact composition of each gate.
- `tests/e2e/README.md` — E2E standards (fresh build, shared fixture, unique
  disposable profile, mocked external providers, deterministic assertions).
