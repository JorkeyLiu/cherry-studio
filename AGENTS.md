# AI Assistant Guide

This is the canonical, always-on repository contract for AI coding assistants working in this codebase. It is the single maintained agent guide: `CLAUDE.md` is a symlink to this file and carries no independent text. Adherence to these rules is crucial for code quality and consistency. Detailed reference material lives in [docs/architecture.md](docs/architecture.md); governance decisions live in the ADRs linked from [Repository Identity & Background](#repository-identity--background).

## Repository Identity & Background

- **Cherry Chat is the sole target identity.** The base build *is* Cherry Chat — there is no build-flavor mechanism and no Cherry Studio target flavor. Identity inputs (product name, app/bundle ID, URL protocol, home directory) are centralized in a single immutable `appIdentity` constant (`packages/shared/config/identity.ts`); what those inputs may become is decided by governance, not by local code. See the [Application Identity ADR](docs/cherry-chat-application-identity.md).
- **Cherry Studio is a compatibility domain, not a target identity.** Its source-format identifiers (database names, persistence keys, ZIP/origin/schema/import declarations, protected default profile names) are compatibility contracts: they must remain stable so user data keeps importing, and data isolation comes from profiles, not from renaming these artifacts. The literal strings are implementation inventory — local code must not reinterpret, rename, or repurpose them.
- **Identity, release, platform, and migration meaning are governed by ADRs, not by local edits.** The updater/release freeze (no publish feeds, release workflows, tags, release notes, or updater endpoints), the macOS-arm64-first platform scope (Windows/Linux identity work is deferred; make no platform promises), and the SQLite chat/migration architecture with its Cherry Studio ZIP compatibility import are locked by the [Application Identity ADR](docs/cherry-chat-application-identity.md) and the [SQLite migration governance](docs/sqlite-migration.md).
- **The current repository path is a transitional carrier** for a future Cherry Chat repository; the path itself is not a decision about application identity or releases.

## Guiding Principles (MUST FOLLOW)

- **Keep it clear**: Write code that is easy to read, maintain, and explain.
- **Match the house style**: Reuse existing patterns, naming, and conventions.
- **Search smart**: Prefer `ast-grep` for semantic queries; fall back to `rg`/`grep` when needed.
- **Log centrally**: Route all logging through `loggerService` with the right context — no `console.log`.
- **Research via subagent**: Lean on subagent research for external docs, APIs, news, and references.
- **Always propose before executing**: Before making any changes, clearly explain your planned approach and wait for explicit user approval to ensure alignment and prevent unwanted modifications.
- **Lint, test, and format before completion**: Coding tasks are only complete after `pnpm lint`, `pnpm test`, and `pnpm format` succeed.
- **No autonomous Git operations**: Do not commit, amend, push, create PRs, or rewrite Git history unless the user explicitly authorizes that operation. User authorization is required even after implementation and validation complete; the conventional commit and signoff rules below apply only to explicitly authorized commits.
- **Write conventional commits**: Commit small, focused changes using Conventional Commit messages (e.g., `feat:`, `fix:`, `refactor:`, `docs:`).
- **Sign commits**: Use `git commit --signoff` as required by contributor guidelines.

## Skill Routing

Load the matching skill before starting the task. If a referenced skill is missing, read its `SKILL.md` under `.agents/skills/<name>/` and follow it manually.

- **Root AGENTS.md authoring** — use the `agents-md-authoring` skill when creating, restructuring, reviewing, or maintaining this repository-root AGENTS.md (or a CLAUDE.md compatibility entry for it). It governs only the root AGENTS.md; nested/subdirectory AGENTS.md files are out of scope and remain locally scoped overlays.
- **GitHub PR workflow and code review** — route through the `github-workflow` skill (PR creation/update with template compliance, review, CI check/log inspection). If that skill is missing, read the current PR-related skill under `.agents/skills/` and follow it. PR review must not run `pnpm lint`/`pnpm test`/`pnpm format` locally — check CI status with `gh pr checks`, `gh pr view`, and `gh run view <RUN_ID> --log-failed` instead, investigating failures from logs only.
- **Issue creation** — use the `gh-create-issue` skill.
- **Implementation-time UI verification** — use the `ui-verify-change` skill when a task involves user-visible behavior: verify a UI change, confirm a fix, test changed UI, or decide UI regression coverage. No PR is required; this is the PR-focused `github-workflow` companion for implementation-time evidence.
- **Creating a new skill** — use the `create-skill` skill.
- **Release preparation** — use the `prepare-release` skill.
- **Delivery validation** — use the `delivery-validation` skill when running completion gates, pre-commit checks, full tests, E2E/build/packaging, or other long-running validation commands.

## Environment, Commands, and Native ABI

### Environment bootstrap (run before any pnpm command)

The repository pins Node 24.11.1 (`.nvmrc` / `.node-version`) and pnpm 10.27.0 (`package.json`). Another Node installation can shadow the pinned one (e.g., a `~/.local/bin/node` shim ahead of the nvm install), and a wrong Node version can silently produce an incompatible better-sqlite3 binding. Establish the pinned toolchain before the first `pnpm` command:

1. **Verify versions first** — `node -v` must print `v24.11.1` and `pnpm -v` must print `10.27.0`.
2. **Activate the pinned Node** — `nvm use` / `fnm use`, or the session-local `PATH` override below.
3. **Diagnose shadowing** — if `node -v` is still wrong, run `which -a node` to list every Node on `PATH`; a higher-priority installation shadows the pinned one. Re-verify `node -v` after switching.
4. **Session-local fallback (no shell dotfile changes)** — if nvm/fnm is unavailable or shadowed, prepend the pinned nvm Node for the current session only:
   ```bash
   export PATH="$HOME/.nvm/versions/node/v24.11.1/bin:$PATH"
   node -v  # must print v24.11.1
   pnpm -v  # must print 10.27.0
   ```
   This does not modify `~/.zshrc` and applies only to the current shell session.

### Native ABI lanes (better-sqlite3)

The single native module, `better-sqlite3`, is compiled for **either** Node 24 (ABI 137) **or** Electron 41.2.1 (ABI 145) — never both at once. Which ABI is valid is a **package-command runtime lane contract**: it is decided by the lane of the command you run, never inferred from directories, tests, imports, or module graphs, and never switched by hand. The lane machinery lives in `scripts/native-abi/`; canonical commands are wired through it in `package.json`.

- **ABI is a runtime lane contract.** `node`-lane commands (`pnpm test`, `test:*`, `test:coverage`, `test:ui`, `test:watch`, `bench:*`, `ci:test-check`) run under Node 24 (ABI 137); `electron`-lane commands (`pnpm dev`, `pnpm dev:watch`, `pnpm start`, `pnpm debug`, `pnpm build`, `build:*`, `analyze:*`, `pnpm test:e2e`, `pnpm ui:observe`) run under Electron 41.2.1 (ABI 145). Neutral commands (`pnpm lint`, `pnpm format`, `pnpm typecheck`, `i18n:*`, `openapi:check`, `skills:check`, `ci:basic-check`) never enter a lane and never switch the binding.
- **Canonical lane commands self-ensure their lane.** Each lane command probes the binding read-only first and rebuilds only when that probe fails. No manual `native:check:*` / `native:rebuild:*` sequencing is ever needed to reach a lane state.
- **Local Node lanes restore the Electron ABI 145 default afterwards; CI skips restoration.** After a local `node`-lane run (for example `pnpm test`) the binding is restored to the Electron ABI, so the next dev/build/E2E command needs no manual switching. CI runs skip the restoration step.
- **Concurrency is serialized per checkout.** Lane commands take a checkout-scoped lock for the duration of the run. A command for the opposite lane started while another lane holds the lock fails fast with a conflict diagnostic — wait for that lane to finish or run its command. The lane is never silently switched under another owner's run.
- **`pnpm native:check:node` / `pnpm native:check:electron` are pure read-only diagnostics** — use them to inspect or prove the current binding state. **`pnpm native:rebuild:*` are explicit repair/debug tooling** — never routine workflow; a lane command repairs its own lane when its probe fails. Internal `*:run` helpers (`test:run`, `dev:run`, `build:run`, …) are not user/agent entrypoints; always use the canonical public command.
- **`ELECTRON_RUN_AS_NODE=1`** is valid only inside the controlled Electron probe; never export it in a shell or launch Electron with it.
- **Only a real runtime SQL probe proves success** — `Database(':memory:')` + `select 1 as ok` + close. `.forge-meta` markers are never trusted.
- **ABI onboarding** — `.node-version` / `.nvmrc` are the source of truth for the required Node version. Confirm Node 24 is on PATH before installing; installing under the wrong Node can produce an incompatible binding.

### Commands

- **Install**: `pnpm install` — all project dependencies (requires Node ≥24.11.1, pnpm 10.27.0)
- **Development**: `pnpm dev` — Electron app in development mode with hot reload
- **Debug**: `pnpm debug` — debugging via `chrome://inspect` on port 9222
- **Build Check**: `pnpm build:check` — **REQUIRED** before commits (`pnpm lint && pnpm openapi:check && pnpm test`); run `pnpm i18n:sync` first if there are i18n sort issues, `pnpm format` first if there are formatting issues
- **Full Build**: `pnpm build` — TypeScript typecheck + electron-vite build
- **Test**: `pnpm test` — all Vitest tests under the Node ABI lane (main + renderer + aiCore + shared + scripts + e2e-utils); the lane is self-ensured and the Electron ABI is restored locally afterwards
  - `pnpm test:main` — Main process tests only (Node environment)
  - `pnpm test:renderer` — Renderer process tests only (jsdom environment)
  - `pnpm test:aicore` — aiCore package tests only
  - `pnpm test:watch`, `pnpm test:coverage` — Vitest under the Node ABI lane
  - `pnpm test:e2e` — Playwright E2E under the Electron ABI lane
- **UI Observation**: `pnpm ui:observe` — isolated diagnostic Playwright Electron observation harness for rendered/interactive behavior; diagnostic-only, never E2E regression proof. Procedural use and evidence classification route through `ui-verify-change`.
- **Lint**: `pnpm lint` — oxlint + eslint fix + TypeScript typecheck + i18n check + format check
- **Format**: `pnpm format` — Biome format + lint (write mode)
- **Typecheck**: `pnpm typecheck` — concurrent TypeScript checks: node + web via `tsgo`, aiCore via its package typecheck command (`tsc --noEmit`)
- **i18n**: `pnpm i18n:sync` (sync template keys) / `pnpm i18n:translate` (auto-translate missing keys) / `pnpm i18n:check` (validate completeness)
- **Bundle Analysis**: `pnpm analyze:renderer` / `pnpm analyze:main` — visualize bundle sizes

### Validation gates

- Full `pnpm test` remains part of `pnpm build:check`; focused `test:*` suites supplement, but never replace, the full gate.
- Each required aggregate gate must produce a trustworthy original exit code for the exact worktree state. Truncated output, printed sub-suite PASS lines, or a timeout/killed/unknown status are not proof of success.
- Use the `delivery-validation` skill for execution, retry, evidence reuse, and cleanup details.

## Repository Mental Model

This section is the durable mental model of Cherry Chat: what the product is, which runtime role owns what, where authority lives, how intent and state move, how a change propagates, and how evidence becomes judgment. It deliberately describes relationships and semantics, not file locations; the detailed directory/service/slice/path reference lives in [docs/architecture.md](docs/architecture.md), and local code location is specialist work.

### Product Meaning

Cherry Chat is the sole target product of this repository, and its identity is a governance decision, not a string: the [Application Identity ADR](docs/cherry-chat-application-identity.md) defines identity, compatibility, the updater/release freeze, and platform scope, and the base build *is* Cherry Chat — there is no build flavor for another target. Cherry Studio is not a competing identity but a compatibility domain: its source-format identifiers, database names, and import structures are contracts that must remain stable so user data keeps importing, and data isolation comes from profiles, not from renaming compatibility artifacts. The current repository path is a transitional carrier for a future Cherry Chat repository; the path itself is not a product decision. Understanding the product starts with the ADRs, not with a list of constants.

### Runtime Responsibility

Cherry Chat is an Electron application with a deliberately split spine. Each role owns a distinct kind of authority, and exposure is not ownership:

- **Main process** — capability ownership and runtime authority: native capability, app and window lifecycle, and the persistent chat store. It is the long-lived, trusted owner of what must survive.
- **Renderer** — the interactive projection of the app and its configuration surface: it renders state, collects intent, and edits settings. It holds no privileged native access. Renderer access to `window.api` is capability *use*, not capability *ownership* — it does not transfer Main-process ownership of anything it touches.
- **Preload** — the security boundary between the two: it exposes a narrow, typed capability surface (`window.api` via `contextBridge`) and nothing else. Preload exposes a contract but does not own business decisions — it is the door, not the decision-maker. No Node capability reaches the renderer except through this door.
- **Shared** — the cross-process contract (`packages/shared/`, including the IPC channel constants); both sides compile against the same contract, so a contract change is never a one-side edit.
- **aiCore** — provider request *policy* and *execution*: model/provider resolution and runtime execution live here, independent of the UI that invoked them. Policy is decided here, not in the renderer.
- **Windows** — the app has several windows (main, mini, trace viewer, import); they share the same contracts but have independent lifecycles and purposes. Window lifecycle is not feature existence: opening a window is not starting a feature.

The stack is Electron main + React/TypeScript renderer, SQLite in the main process, IndexedDB in the renderer, and an AI-SDK-based aiCore; exact versions and technology detail are in [docs/architecture.md](docs/architecture.md).

### Authority and Projection

Authority is placed deliberately, and projection is not authority:

- **Ordinary chat is authoritative in the main process.** SQLite in the main process is the source of truth for chat; the renderer never holds a SQLite connection and reaches chat data only through typed IPC. The UI is a projection of that authority, not a second copy — it may render, cache, or present, but it is never the record.
- **Projection, configuration, and compatibility state are not interchangeable authority.** The renderer legitimately owns configuration and projection state (Redux) and live non-chat data (Dexie); message-block and topic structures exist for message-block UI and legacy/import compatibility, not as ordinary runtime chat authority. The line is current ownership vs. legacy/import compatibility: state that exists to display or to import does not decide. Treating a projection as authoritative is a class of bug, not a style choice.
- **Persisted state and imports carry migration semantics.** Both SQLite and Dexie schemas are versioned, and the L2 Cherry Studio ZIP import is a verification-and-atomic-promotion pipeline, not a blind copy. Changing an authority boundary means changing a contract, governed by the [SQLite migration governance](docs/sqlite-migration.md).

### Request and State Flow

Every user action follows one spine: **user intent → renderer state/config → typed preload capability → main service or aiCore provider resolution/execution → persisted result or stream → renderer projection/error.**

- Configuration is deliberate: the user's selected provider and model are resolved explicitly, and an unconfigured or failed provider is an explicit state, never a hidden fallback. There is no silent substitution.
- Failure is part of the contract: user-visible errors and recovery are designed into the flow, not bolted on, and they surface through the same channel as the happy path.
- Events flow both ways — renderer-to-main requests and main-to-renderer pushes — over the same shared contract.

### Change Propagation

Before changing anything, classify the change. Risk follows the boundary the change crosses, not the size of the diff: a one-line change to a shared IPC channel or a migration can be a higher-boundary change than a large renderer-only refactor, because it touches authority, contract, or persistence semantics. Classify first, then scope the evidence to match:

- **Presentation** — renderer-only appearance or behavior of existing state.
- **Local state** — renderer-owned configuration or projection state.
- **Cross-process contract** — the shared IPC channels, the preload surface, and the main handlers; these must change together as one contract, never one side at a time.
- **Persistence/migration** — schema or storage semantics in SQLite or Dexie; versioned and rollback-aware.
- **Provider/request semantics** — what aiCore resolves and executes, and how.
- **Native/lifecycle/multi-window** — capabilities, windows, and app lifecycle.
- **Product identity/governance** — identity, compatibility, release, or platform decisions; these are ADR-level and require user decisions, not code edits.

The higher the boundary, the broader the evidence and the higher the decision: a migration is not a UI tweak, and a contract change is not a local fix. Local fixes must not silently cross an authority boundary — a renderer workaround that writes chat data directly, or a rename of a compatibility identifier, is a governance violation even if it works locally.

### Evidence and Judgment

The split is explicit: specialists gather facts; the Main Agent makes judgment. Inspectors and focused agents produce observable local evidence — code, tests, runtime artifacts, runtime behavior — and the Main Agent interprets meaning, scope, and risk, and chooses the remedy. This section is a mental model, not a path map: code search and file location are specialist work, and AGENTS is not a substitute for them.

Evidence has distinct claims that are not interchangeable: static/type-level facts and isolated component tests establish local behavior; Playwright E2E against a fresh production build establishes contract-worthy integrated behavior (lifecycle, IPC, persistence, native, multi-window); screenshots, CDP sessions, and dev-mode observation are diagnostic only — never regression proof. When an implementation changes user-visible behavior, rendered and interactive behavior must be verified (route the evidence tier through `ui-verify-change`; see Testing and UI/E2E Evidence), and the weight of evidence must match the boundary the change crosses.

### Mental Model in One Paragraph

Cherry Chat is one product defined by governance, not by strings: an Electron app in which the main process is the trusted owner of native capability and persistent chat, the renderer is its projection and configuration surface, preload is the only door between them, the shared package is the contract both sides keep, and aiCore is where provider policy becomes execution. Data has one spine — authoritative SQLite chat in the main process, reached only through typed IPC — and every other state is either legitimate renderer ownership, projection, or compatibility, never an alternate chat authority. Every user action flows intent → state → typed capability → service or provider → persistence/stream → projection/error, with selection explicit and failure part of the contract. Every change has a boundary: classify it before acting, because higher boundaries demand broader evidence and higher decisions, and a local fix that crosses an authority boundary is a governance violation. Evidence is layered, and judgment belongs to whoever reads the whole map, not whoever finds the file.

## Conventions

- **TypeScript**: strict mode; `tsgo` for typechecking; separate `tsconfig.node.json` (main) and `tsconfig.web.json` (renderer); type definitions centralized in `src/renderer/src/types/` and `packages/shared/`.
- **Code style**: Biome formatting (2-space indent, single quotes, trailing commas); oxlint + ESLint linting with `simple-import-sort`; `eslint-plugin-react-hooks` enforced; no unused imports (`eslint-plugin-unused-imports`).
- **File naming**: React components `PascalCase.tsx`; services, hooks, utilities `camelCase.ts`; tests `*.test.ts` / `*.spec.ts` alongside source or in `__tests__/`.
- **i18n**: all user-visible strings must use `i18next` — never hardcode UI strings. Run `pnpm i18n:check` to validate; `pnpm i18n:sync` to add missing keys. Locale files in `src/renderer/src/i18n/`.
- **Packages with custom patches** — `patches/` contains maintained dependency patches for pinned package versions; inspect it before upgrading dependencies.

## Testing and UI/E2E Evidence

- **Vitest 3** with project-based configuration. Main process: Node environment, `tests/main.setup.ts`. Renderer: jsdom, `tests/renderer.setup.ts`, `@testing-library/react`. aiCore: `packages/aiCore/vitest.config.ts`. All tests run locally without CI. Coverage via v8 (`pnpm test:coverage`). **Features without tests are not complete.**
- **Playwright E2E (Electron)** covers what unit tests cannot: Electron lifecycle, preload, main-process IPC, filesystem/persistence, native, multi-window, and relaunch workflows. E2E evidence requires a fresh production build (`pnpm build`), the standard `tests/e2e` fixture, a unique disposable user profile, mocked external providers, and deterministic assertions. Cleanup is ownership-scoped — never kill broad process trees. Use explicit platform skips for OS-specific behavior. See `tests/e2e/README.md`.
- **Evidence hierarchy** — Vitest/Testing Library for isolated component behavior; Playwright E2E (fresh build + shared fixture) for contract-worthy integrated behavior. Screenshots, `pnpm ui:observe` observations, manual CDP sessions, agent-driven browsers, and dev-mode runs are **diagnostic only** — never sufficient regression evidence. Playwright specs/fixtures may emit `[E2E]`-prefixed console output for diagnostics; application code remains `loggerService`-only.
- **Implementation-time UI verification** — for user-visible changes, follow `ui-verify-change` (see Skill Routing). E2E is risk-based, not mandatory for every UI edit: require Playwright E2E for historically regressing behavior, integrated cross-component workflows, IPC/persistence/lifecycle/native/multi-window behavior, and user-visible contracts meant to stay stable; prefer Vitest/component tests for isolated stable presentation/logic. Map changed behavior to existing specs first; extend or add a focused spec when behavior is contract-worthy and uncovered.

## Logging and Security

- **Logging**: route everything through `loggerService` (`@logger`) — never `console.log`. Backend is Winston with daily rotation into `userData/logs/`. Renderer windows call `loggerService.initWindowSource('windowName')` first. Example:
  ```typescript
  import { loggerService } from "@logger";
  const logger = loggerService.withContext("moduleName");
  logger.info("message", CONTEXT);
  logger.error("message", error);
  ```
- **Tracing**: `packages/mcp-trace/` provides trace-core and trace-node/trace-web adapters; the active path has `NodeTraceService` export spans through `FunctionSpanExporter` into `SpanCacheService` (trace viewer window); OTLP HTTP export is optional and used when an endpoint is configured.
- **Security**: never expose Node.js APIs directly to the renderer — use `contextBridge` in preload; validate all IPC inputs in main-process handlers; URL sanitization via `strict-url-sanitise`; IP validation via `ipaddr.js` (API server); `express-validator` for API server request validation.

## Detailed References

- [docs/architecture.md](docs/architecture.md) — detailed architecture reference: main services, renderer directories, Redux slices, AI Core layering, database detail, IPC, multi-window, tracing, tech stack, source compatibility.
- [Application Identity ADR](docs/cherry-chat-application-identity.md) — canonical governance for Cherry Chat identity, compatibility boundary, updater/release freeze, and platform scope.
- [SQLite migration governance](docs/sqlite-migration.md) — canonical governance for SQLite chat authority and L2 Cherry Studio ZIP compatibility import.
- [tests/e2e/README.md](tests/e2e/README.md) — Playwright E2E standards and fixture usage.
- [docs/en/guides/logging.md](docs/en/guides/logging.md) and [docs/en/guides/i18n.md](docs/en/guides/i18n.md) — logging and i18n developer guides.
- [Performance program](docs/performance-program.md) — living cross-session source for performance baselines, workstreams, evidence levels, and session handoffs; read it to resume the performance optimization effort.
