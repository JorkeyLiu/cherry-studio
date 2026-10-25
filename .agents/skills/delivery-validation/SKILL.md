---
name: delivery-validation
description: Reliable execution and reporting of long-running validation commands in this repository. Use when running full tests, lint/format/typecheck/openapi/build, E2E, packaging, or any other long-running validation command — and when classifying validation failures or deciding whether prior command results can still be reused for the current worktree state.
---

# Delivery Validation

This skill defines how to run the repository's long-running validation commands
reliably, prove trustworthy success, retry only when a cause actually changed,
and report results honestly. It is the execution companion to the validation
policy stated in the root `AGENTS.md`: the root guide states that the commands
are independent and that verification scope follows the impact of the change;
this skill covers *how* to run them, including native runtime mechanics,
budgets, logging, retry, evidence reuse, cleanup, and failure classification.

## When to use

- Running validation commands (`pnpm lint`, `pnpm test`, `pnpm typecheck`,
  `pnpm openapi:check`, `pnpm format`, `pnpm build`) for a change.
- Running any long-running validation command: full tests, lint, format,
  typecheck, E2E, fresh production builds, or packaging.
- Classifying a validation failure (new vs. known-baseline vs. environmental vs.
  unrelated).
- Deciding whether prior command results are still fresh for the current
  worktree state.

## Choose the commands to run

- The root `AGENTS.md` is canonical. It declares no single mandatory aggregate
  gate: `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm openapi:check`,
  `pnpm format`, and `pnpm build` are independent. Read the change and run the
  set it actually affects, at the scope its impact requires.
- `package.json` scripts define exactly what each command runs (for example,
  `pnpm test` runs all Vitest suites under Node; `pnpm lint` runs oxlint +
  eslint + typecheck + i18n check + format check).
- Focused suites are a way to get fast feedback for a narrow change; when the
  change reaches further, run the broader command as well.
- `pnpm verify:changed` is renderer-only local feedback, **never a completion
  gate and never CI proof**. It is strict renderer-only: any
  Main/preload/shared/package/config/scripts/unknown path must fail closed with
  instruction to run the affected standalone commands; no partial green result.
  It runs via `pnpm native:run node -- ...` and includes untracked renderer
  files; docs-only/no-renderer-change sets exit 0 as a no-op without claiming
  validation proof. CI's path-filter matrix and full jobs remain unchanged.

## Establish the environment first

- Establish the pinned toolchain (Node 24.11.1, pnpm 10.27.0) using the root
  `AGENTS.md` bootstrap rules before any pnpm command. Pins protect
  reproducibility and the support baseline, not a per-V8 compiled binding.

## Native runtime: shared prebuilt, no switching

better-sqlite3 13.0.3 uses a Node-API prebuilt: the same packaged file
loads under both Node 24.11.1 and Electron 41.2.1. There is no ABI switching,
rebuilding, restoration, or checkout lock — `node`-runtime commands (`pnpm test`,
`test:*`) and `electron`-runtime commands (`pnpm build`,
`pnpm test:e2e`, `pnpm ui:observe`) may run in parallel. Runtime machinery lives
in `scripts/native-runtime/`; canonical commands are wired through it in
`package.json`:

- Run the command's canonical public command directly (`pnpm test`,
  `pnpm test:e2e`, …). Public `pnpm native:run
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
  classifying a native-related failure; never as a required step before a
  command. Only a real runtime SQL probe proves success; `.forge-meta` markers
  and filenames are never trusted.
- `ELECTRON_RUN_AS_NODE=1` must never be exported in a shell or globally, nor
  used to launch Electron. Only controlled Electron probe children (and the
  existing controlled E2E relay children) may set it.
- Parallelism is allowed: no dev/test runtime exclusivity. Independently
  isolate real shared resources (DB files, profiles, output dirs) — parallel
  runs must never share them.

## Evidence identity and freshness

- Evidence is valid only for the exact worktree state the command ran against.
  The input surface is what a command actually consumes: source files, test
  files, config files read by the commands, the dependency/lockfile state,
  package scripts, generated contracts (for example the OpenAPI spec), i18n
  locale inputs, and API spec definitions — plus the Node/Electron runtime and
  the exact command invoked. Documentation, skill, and other markdown files are
  outside that surface: they are not inputs to oxlint/eslint, typecheck, i18n,
  openapi, format, or test, so editing them cannot change what those commands
  validate.
- A code-surface change invalidates prior results. After source, test, config,
  dependency, package-script, or generated-contract changes (including i18n
  locale inputs and API spec definitions), rerun the affected commands against
  the new state.
- Reuse valid results on an unchanged code surface: a command's trustworthy
  original exit code applies to that exact state, so it does not need to be
  repeated for the same state.
- Focused tests supplement the broader run; choose the scope the change's
  impact requires.
- Documentation/skill-only changes do not invalidate code-command results. Run
  the directly affected structural checks — for example `pnpm skills:check`,
  symlink/link or reference checks, CLAUDE synchronization, and marker scans —
  and reuse the still-valid results for the unchanged code surface, provided
  those results genuinely exist and were recorded completely (trustworthy
  original exit code, exact worktree code state). Never claim a command passed
  without such evidence.

## Command classes and default minimum budgets

| Class | Examples | Default minimum budget |
|---|---|---|
| Ordinary focused Vitest | `test:*` sub-suites (main, renderer, aicore, shared, scripts, e2e-utils) | 10 minutes |
| Lint | `pnpm lint` (oxlint + eslint + typecheck + i18n check + format check) | 10 minutes |
| Full test | `pnpm test` (all Vitest suites) | 20 minutes |
| E2E / fresh build + E2E / packaging | `pnpm test:e2e`, fresh `pnpm build` followed by E2E, electron-builder packaging | at least 30 minutes |

- These are initial budgets with headroom, not expected durations, and they
  never authorize killing a command that is still progressing.
- Ordinary focused Vitest suites are deliberately separated from E2E, fresh
  build + E2E, and packaging: the latter are heavier and require larger budgets.
- Increase a budget using trustworthy observed history — your own successful
  runs of the same command on this machine, or recorded run times from the
  repository — never an undefined "documented bound" or a guess.
- The full-test budget covers the whole command, so calibrate it from
  trustworthy observed history of the full run — never hardcode an unsupported
  new number.
- This budget table lives here, not in the root `AGENTS.md`; keep the root
  guide free of procedural tables.

## Running a command

- Run each command once per evidence state. Do not rerun a command solely
  to inspect its output.
- For output-heavy commands, redirect stdout/stderr to a session-owned log in
  the session-designated temp area outside the worktree, and capture the
  producer's numeric exit status in the same shell invocation.
- Avoid pipelines that mask the producer's status; if a pipeline is
  unavoidable, use `pipefail` and preserve the producer's status correctly.
- If the execution tool truncates output and saves it to a path, read/search
  that saved file instead of rerunning. Never rerun merely to re-see the tail.
- **Foreground for finite commands; background only for persistent services:** run every finite validation command whose result is needed
  before the next step in the foreground, with an adequate documented budget
  and its trustworthy original exit code. Reserve background execution for
  processes that must keep running to support later tasks (dev servers,
  watchers, services) — never merely because a command is long, produces much
  output, or might exceed an execution timeout. Duration and execution mode
  are independent; all existing runtime, minimum-budget, retry, progress,
  output-capture, cleanup, and exit semantics still apply. Genuinely independent
  work may run as parallel foreground invocations — do not block independent
  work needlessly.
- **Inadequate foreground budget is not a reason to background a command:** use
  the tool's supported continuation/polling for the same foreground
  invocation without restarting. Never invent a background-lifecycle
  workaround; if no continuation mechanism exists, report the concrete
  limitation and the run as unverified — never as success.

## Interpreting outcomes

- Exit 0 = pass. Nonzero = fail. Timeout, killed, or unknown status =
  unverified.
- Printed sub-suite PASS lines, or the absence of FAIL, are insufficient.
  Success requires the trustworthy original exit code of the command.
- Report timeouts, kills, and unknown statuses honestly as unverified — never
  as success.

## Retry matrix

A rerun is allowed only after an observed cause changed:

- The command failed before starting (for example, an invocation error) — rerun
  once after fixing the invocation.
- A tool/session interruption not caused by the command (session crash, tool
  failure) left no trustworthy result — rerun the command against the same
  evidence state.
- The environment was corrected — pinned toolchain restored, or the native
  runtime diagnosed via the readonly `native:check:*` probes after a real
  SQL probe failure — rerun once after the correction.
- A documented or observed transient external failure occurred (network,
  registry, service outage) — rerun once after it clears.
- The test suite's own retry policy applies — follow the suite's policy.
- The budget was proved miscalibrated by trustworthy progress/duration evidence
  (for example, retained logs show the command was still progressing productively
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

Classify each failing command:

- **new-failure** — the command fails on a state where it previously passed or is
  expected to pass; the caller decides next steps.
- **known-baseline** — the command fails the same way on the clean baseline state;
  not introduced by the current work.
- **environmental** — toolchain, native runtime, network, or machine state issue; rerun
  once after the environment is corrected per the retry matrix.
- **unrelated** — the failure is outside the scope of the current work and not
  caused by it.

In validation-only mode, do not fix failures unless the caller assigned
implementation rights; report the classification and let the caller decide.

## Reporting

- Report the exact command, the runtime state it ran under, and its trustworthy
  original exit status.
- Never present a timeout, kill, or unknown status as success, and never claim a
  command passed without a recorded result for the exact worktree state.
- When results for a documentation/skill-only change are reused rather than
  rerun, say so and name the structural checks that stand in for a rerun.
- Keep cleanup visible: state whether session-owned temp artifacts were cleaned
  or retained (with paths and reason).

## Repository anchors

- Root `AGENTS.md` — validation policy, pinned toolchain, native Node-API runtime
  contract, success standard.
- `package.json` — exact composition of each command.
- `tests/e2e/README.md` — E2E standards (fresh build, shared fixture, unique
  disposable profile, mocked external providers, deterministic assertions).
