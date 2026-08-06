# AI Assistant Guide

This file provides guidance to AI coding assistants when working with code in this repository. Adherence to these guidelines is crucial for maintaining code quality and consistency.

## Guiding Principles (MUST FOLLOW)

- **Keep it clear**: Write code that is easy to read, maintain, and explain.
- **Match the house style**: Reuse existing patterns, naming, and conventions.
- **Search smart**: Prefer `ast-grep` for semantic queries; fall back to `rg`/`grep` when needed.
- **Log centrally**: Route all logging through `loggerService` with the right context—no `console.log`.
- **Research via subagent**: Lean on `subagent` for external docs, APIs, news, and references.
- **Always propose before executing**: Before making any changes, clearly explain your planned approach and wait for explicit user approval to ensure alignment and prevent unwanted modifications.
- **Lint, test, and format before completion**: Coding tasks are only complete after running `pnpm lint`, `pnpm test`, and `pnpm format` successfully.
- **Write conventional commits**: Commit small, focused changes using Conventional Commit messages (e.g., `feat:`, `fix:`, `refactor:`, `docs:`).
- **Sign commits**: Use `git commit --signoff` as required by contributor guidelines.

## Pull Request Workflow (CRITICAL)

When creating a Pull Request, you MUST use the `gh-create-pr` skill.
If the skill is unavailable, directly read `.agents/skills/gh-create-pr/SKILL.md` and follow it manually.

## Review Workflow

When reviewing a Pull Request, do NOT run `pnpm lint`, `pnpm test`, or `pnpm format` locally.
Instead, check CI status directly using GitHub CLI:

- **Check CI status**: `gh pr checks <PR_NUMBER>` - View all CI check results for the PR
- **Check PR details**: `gh pr view <PR_NUMBER>` - View PR status, reviews, and merge readiness
- **View failed logs**: `gh run view <RUN_ID> --log-failed` - Inspect logs for failed CI runs

Only investigate CI failures by reading the logs, not by re-running checks locally.

## Issue Workflow

When creating an Issue, you MUST use the `gh-create-issue` skill.
If the skill is unavailable, directly read `.agents/skills/gh-create-issue/SKILL.md` and follow it manually.

## Development Commands

- **Install**: `pnpm install` — Install all project dependencies (requires Node ≥24.11.1, pnpm 10.27.0)
- **Development**: `pnpm dev` — Runs Electron app in development mode with hot reload
- **Debug**: `pnpm debug` — Starts with debugging; attach via `chrome://inspect` on port 9222
- **Build Check**: `pnpm build:check` — **REQUIRED** before commits (`pnpm lint && pnpm test`)
  - If having i18n sort issues, run `pnpm i18n:sync` first
  - If having formatting issues, run `pnpm format` first
- **Full Build**: `pnpm build` — TypeScript typecheck + electron-vite build
- **Native ABI (better-sqlite3)**: the single native module is compiled for **either** Node24 (ABI 137) **or** Electron 41.2.1 (ABI 145) — never both at once. Switching is **explicit**; preflights never rebuild.
  - `pnpm native:check:node` — read-only check: binding must actually create `Database(':memory:')`, run `select 1 as ok`, and close under a supported Node24 (ABI 137). Requires Node ≥24.11.1 on PATH.
  - `pnpm native:check:electron` — read-only check: binding verified under the installed Electron binary (`ELECTRON_RUN_AS_NODE=1`) for Electron 41.2.1 / ABI 145 (darwin arm64).
  - `pnpm native:rebuild:node` — explicit node-gyp source build of better-sqlite3 for Node24, then runs `native:check:node` (fails on any failure).
  - `pnpm native:rebuild:electron` — explicit `@electron/rebuild` source build (force, buildFromSource, only better-sqlite3) for Electron, then runs `native:check:electron`.
  - ABI onboarding: `.node-version` / `.nvmrc` are the source of truth for the required Node version. Confirm Node24 is on PATH (`node -v`) before installing — installing under the wrong Node can produce an incompatible binding. Preflights never rebuild: switch explicitly between Node ABI 137 and Electron ABI 145 with `pnpm native:rebuild:node` / `pnpm native:rebuild:electron`.
  - Preflight integration: `pnpm start` / `pnpm dev` / `pnpm dev:watch` / `pnpm debug` / `pnpm test:e2e` run `native:check:electron` once before launch; `pnpm test` / `pnpm test:coverage` / `pnpm test:watch` / `pnpm test:ui` / `pnpm bench` / `pnpm ci:test-check` run `native:check:node` once. Focused `test:*` / `bench:*` sub-suite commands are intentionally unguarded (aggregate entry points check once; CI adds one `native:check:node` step per focused-suite test job in `.github/workflows/ci.yml`). `.forge-meta` markers are never trusted as proof (LOCK-ABI-2) — only real runtime SQL counts. Implementation: `scripts/native-abi/`.
- **Test**: `pnpm test` — preflights Node ABI, then runs all Vitest tests (main + renderer + aiCore + shared + scripts)
  - `pnpm test:main` — Main process tests only (Node environment)
  - `pnpm test:renderer` — Renderer process tests only (jsdom environment)
  - `pnpm test:aicore` — aiCore package tests only
  - `pnpm test:watch` — Watch mode
  - `pnpm test:coverage` — With v8 coverage report
  - `pnpm test:e2e` — Preflights Electron ABI, then Playwright end-to-end tests
  - Focused suites (`test:main` etc.) run without preflight so aggregate runs do not repeat it; run `pnpm native:check:node` first when switching from the Electron binding.
- **Lint**: `pnpm lint` — oxlint + eslint fix + TypeScript typecheck + i18n check + format check
- **Format**: `pnpm format` — Biome format + lint (write mode)
- **Typecheck**: `pnpm typecheck` — Concurrent node + web TypeScript checks using `tsgo`
- **i18n**:
  - `pnpm i18n:sync` — Sync i18n template keys
  - `pnpm i18n:translate` — Auto-translate missing keys
  - `pnpm i18n:check` — Validate i18n completeness
- **Bundle Analysis**: `pnpm analyze:renderer` / `pnpm analyze:main` — Visualize bundle sizes
## Project Architecture

### Electron Structure

```
src/
  main/          # Node.js backend (Electron main process)
  renderer/      # React UI (Electron renderer process)
  preload/       # Secure IPC bridge (contextBridge)
packages/
  aiCore/        # @cherrystudio/ai-core — AI SDK middleware & provider abstraction
  shared/        # Cross-process types, constants, IPC channel definitions
  mcp-trace/     # OpenTelemetry tracing for MCP operations
  ai-sdk-provider/  # Custom AI SDK provider implementations
  extension-table-plus/  # TipTap table extension
```

### Key Path Aliases

| Alias | Resolves To |
|---|---|
| `@main` | `src/main/` |
| `@renderer` | `src/renderer/src/` |
| `@shared` | `packages/shared/` |
| `@types` | `src/renderer/src/types/` |
| `@logger` | `src/main/services/LoggerService` (main) / `src/renderer/src/services/LoggerService` (renderer) |
| `@mcp-trace/trace-core` | `packages/mcp-trace/trace-core/` |
| `@cherrystudio/ai-core` | `packages/aiCore/src/` |

### Main Process (`src/main/`)

Node.js backend services. Key services:

| Service | Responsibility |
|---|---|
| `WindowService` | Electron window lifecycle management |
| `MCPService` | Model Context Protocol server management |
| `KnowledgeService` | RAG / knowledge base (via `@cherrystudio/embedjs`) |
| `AnthropicService` | Anthropic API integration |
| `LoggerService` | Winston-based structured logging (daily rotate) |
| `StoreSyncService` | Syncs Redux state to/from main process |
| `BackupManager` | Data backup/restore (WebDAV, S3, Nutstore) |
| `ChatDbService` | SQLite chat database (`Data/chat.db`) connection lifecycle, schema migrations, integrity checks, and maintenance coordination — see `src/main/services/chatDb/` |
| `ChatDbAggregateService` | Command-oriented typed access to the chat database (topics, messages, blocks, topic_segments, file references); the `ChatDb_*` IPC channels map 1:1 onto its capabilities |
| `ChatDbImport` | L2 Cherry Studio ZIP compatibility import pipeline (ZIP intake, candidate build, verification, atomic promotion) — see `src/main/services/chatDbImport/` |
| `ApiServerService` | Express HTTP API server (Swagger docs at `/api-docs`) |
| `AppUpdater` | electron-updater auto-update |
| `ShortcutService` | Global keyboard shortcuts |
| `ThemeService` | System theme detection/application |
| `SelectionService` | Text selection toolbar feature |
| `CopilotService` | GitHub Copilot OAuth integration |
| `PythonService` | Pyodide WASM Python runtime |
| `OvmsManager` | OpenVINO model server management |
| `NodeTraceService` | OpenTelemetry trace export |

### Renderer Process (`src/renderer/src/`)

React 19 + Redux Toolkit SPA. Key structure:

```
aiCore/          # Legacy middleware pipeline (deprecated, migrating to packages/aiCore)
api/             # IPC call wrappers (typed electron API calls)
components/      # Shared UI components (Ant Design 5 + styled-components + TailwindCSS v4)
databases/       # Dexie (IndexedDB) — files catalog, settings, knowledge notes, translation history/languages, quick phrases
hooks/           # React hooks (useAssistant, useChatContext, useModel, etc.)
pages/           # Route pages (home, settings, knowledge, paintings, notes, etc.)
services/        # Frontend services (ApiService, ModelService, MemoryService, etc.)
store/           # Redux Toolkit slices
types/           # TypeScript type definitions
workers/         # Web Workers
windows/         # Multi-window entry points (mini, selection toolbar, trace)
```

### Redux Store (`src/renderer/src/store/`)

Slices (redux-persist enabled):

| Slice | State |
|---|---|
| `assistants` | AI assistant configurations |
| `settings` | App-wide settings |
| `llm` | LLM provider/model configs |
| `mcp` | MCP server configs |
| `messageBlock` | Message block rendering state |
| `knowledge` | Knowledge base entries |
| `paintings` | Image generation state |
| `memory` | Memory system config |
| `websearch` | Web search settings |
| `shortcuts` | Keyboard shortcuts |
| `tabs` | Tab management |

### Database Layer

- **SQLite is authoritative for ordinary chat**: `Data/chat.db` lives in the Main process, written through `ChatDbAggregateService` (Drizzle ORM + better-sqlite3). The renderer never holds a SQLite connection — it accesses chat data via typed IPC (`api.*` wrappers) through `SqliteMessageDataSource` (`src/renderer/src/services/db/SqliteMessageDataSource.ts`).
- **IndexedDB** (Dexie): `src/renderer/src/databases/index.ts`
  - Live tables: `files` (catalog), `settings`, `knowledge_notes`, `translate_history`, `translate_languages`, `quick_phrases`
  - Exceptions: `topics` / `message_blocks` remain for agent sessions and for the legacy renderer-side conversation import path — that path is not ordinary SQLite chat authority; `topic_segments` remains for isolated L2 import compatibility and is not ordinary runtime authority
  - Schema versioned with upgrade functions (`upgradeToV5`, `upgradeToV7`, `upgradeToV8`)

### IPC Communication

- Channel constants defined in `packages/shared/IpcChannel.ts`
- Renderer → Main: `ipcRenderer.invoke(IpcChannel.XXX, ...args)` via `api.*` wrappers in `src/preload/index.ts`
- Main → Renderer: `webContents.send(channel, data)`
- Tracing: `tracedInvoke()` in preload attaches OpenTelemetry span context to IPC calls
- Typed API surface exposed via `contextBridge` as `window.api`

### AI Core (`packages/aiCore/`)

The `@cherrystudio/ai-core` package abstracts AI SDK providers:

```
src/core/
  providers/    # Provider registry (HubProvider, factory, registry)
  middleware/   # LanguageModelV2Middleware pipeline (manager, wrapper)
  plugins/      # Built-in plugins
  runtime/      # Runtime execution
  options/      # Request option preparation
```

- Built on Vercel AI SDK v5 (`ai` package) with `LanguageModelV2Middleware`
- `HubProvider` aggregates multiple provider backends
- Supports: OpenAI, Anthropic, Google, Azure, Mistral, Bedrock, Vertex, Ollama, Perplexity, xAI, HuggingFace, Cerebras, OpenRouter, Copilot, and more
- Custom fork of openai package: `@cherrystudio/openai`

### Multi-Window Architecture

The renderer builds multiple HTML entry points:
- `index.html` — Main application window
- `miniWindow.html` — Compact floating window (`src/renderer/src/windows/mini/`)
- `selectionToolbar.html` — Text selection action toolbar
- `selectionAction.html` — Selection action popup
- `traceWindow.html` — MCP trace viewer

### Logging

```typescript
import { loggerService } from "@logger";
const logger = loggerService.withContext("moduleName");
// Renderer only: loggerService.initWindowSource('windowName') first
logger.info("message", CONTEXT);
logger.warn("message");
logger.error("message", error);
```

- Backend: Winston with daily log rotation
- Log files in `userData/logs/`
- Never use `console.log` — always use `loggerService`

### Tracing (OpenTelemetry)

- `packages/mcp-trace/` provides trace-core and trace-node/trace-web adapters
- `NodeTraceService` exports spans via OTLP HTTP
- `SpanCacheService` caches span entities for the trace viewer window
- IPC calls can carry span context via `tracedInvoke()`

## Tech Stack

| Layer | Technologies |
|---|---|
| Runtime | Electron 41, Node ≥24.11.1 |
| Frontend | React 19, TypeScript ~5.8 |
| UI | Ant Design 5.27, styled-components 6, TailwindCSS v4 |
| State | Redux Toolkit, redux-persist, Dexie (IndexedDB) |
| Rich Text | TipTap 3.2 (with Yjs collaboration) |
| AI SDK | Vercel AI SDK v5 (`ai`), `@cherrystudio/ai-core` |
| Build | electron-vite 5 with rolldown-vite 7 (experimental) |
| Test | Vitest 3 (unit), Playwright (e2e) |
| Lint/Format | ESLint 9, oxlint, Biome 2 |
| DB (main) | Drizzle ORM + better-sqlite3 (SQLite) — see `src/main/services/chatDb/` |
| DB (renderer) | Dexie (IndexedDB) — files catalog, settings, knowledge notes, translation history/languages, quick phrases |
| Logging | Winston + winston-daily-rotate-file |
| Tracing | OpenTelemetry |
| i18n | i18next + react-i18next |

## Conventions

### TypeScript

- Strict mode enabled; use `tsgo` (native TypeScript compiler preview) for typechecking
- Separate configs: `tsconfig.node.json` (main), `tsconfig.web.json` (renderer)
- Type definitions centralized in `src/renderer/src/types/` and `packages/shared/`

### Code Style

- Biome handles formatting (2-space indent, single quotes, trailing commas)
- oxlint + ESLint for linting; `simple-import-sort` enforces import order
- React hooks: `eslint-plugin-react-hooks` enforced
- No unused imports: `eslint-plugin-unused-imports`

### File Naming

- React components: `PascalCase.tsx`
- Services, hooks, utilities: `camelCase.ts`
- Test files: `*.test.ts` or `*.spec.ts` alongside source or in `__tests__/` subdirectory

### i18n

- All user-visible strings must use `i18next` — never hardcode UI strings
- Run `pnpm i18n:check` to validate; `pnpm i18n:sync` to add missing keys
- Locale files in `src/renderer/src/i18n/`

### Packages with Custom Patches

Several dependencies have patches in `patches/` — be careful when upgrading:
- `antd`, `@ai-sdk/google`, `@ai-sdk/openai`, `@anthropic-ai/vertex-sdk`
- `@google/genai`, `@langchain/core`, `@langchain/openai`
- `ollama-ai-provider-v2`, `electron-updater`, `epub`, `tesseract.js`
- `@anthropic-ai/claude-agent-sdk`

## Testing Guidelines

- Tests use Vitest 3 with project-based configuration
- Main process tests: Node environment, `tests/main.setup.ts`
- Renderer tests: jsdom environment, `tests/renderer.setup.ts`, `@testing-library/react`
- aiCore tests: separate `packages/aiCore/vitest.config.ts`
- All tests run without CI dependency (fully local)
- Coverage via v8 provider (`pnpm test:coverage`)
- **Features without tests are not considered complete**

### E2E Testing (Playwright/Electron)

- Use Vitest/Testing Library for isolated component behavior; Electron, preload, main-process IPC, filesystem/persistence, native, multi-window, and relaunch workflows require Playwright Electron E2E
- E2E evidence comes from a fresh production build (`pnpm build`), the standard `tests/e2e` fixture, a unique disposable user profile, mocked external providers, and deterministic assertions
- Screenshots, manual CDP sessions, agent-driven browsers, and dev-mode runs are diagnostic only — never sufficient regression evidence
- Playwright E2E specs/fixtures may emit `[E2E]`-prefixed console output for diagnostics; application code remains `loggerService`-only, and diagnostic output is not regression evidence
- Cleanup is ownership-scoped; never kill broad process trees
- Use explicit platform skips for OS-specific behavior
- See `tests/e2e/README.md` for details

## Important Notes

### Security

- Never expose Node.js APIs directly to renderer; use `contextBridge` in preload
- Validate all IPC inputs in main process handlers
- URL sanitization via `strict-url-sanitise`
- IP validation via `ipaddr.js` (API server)
- `express-validator` for API server request validation
