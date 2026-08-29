# Cherry Chat Architecture Reference — Implemented Reality

> **Scope**: This document describes **implemented architecture only** — what exists in the codebase today. It does not describe target architecture, planned evolution, or unimplemented design decisions. For the architecture evolution program (target qualities, phased evolution, debt registry), see [`architecture-evolution-program.md`](./architecture-evolution-program.md).

This is the detailed architecture reference for the Cherry Chat codebase. The top-level [AGENTS.md](../AGENTS.md) guide is the always-on repository contract and keeps the awareness-level rules; this document carries the full detailed tables (services, directories, Redux slices, AI Core layering, database, IPC, multi-window, tracing, tech stack, source compatibility).

Governance is owned by the canonical decision documents, not restated as canonical here: the [Application Identity ADR](./cherry-chat-application-identity.md) (Cherry Chat identity, compatibility boundary, updater/release freeze, platform scope), the [SQLite migration governance](./sqlite-migration.md) (SQLite chat authority, L2 Cherry Studio ZIP compatibility import), and the [Context window governance](./context-window.md) (stable topic context anchor, allowed anchor transitions, compatibility repair, persistence boundary). Multi-client synchronization is bounded by the [Sync MVP proposal](./sync-mvp.md) (first-phase scope, device-local vs cross-device authority, conflict matrix, open decisions) and the disposable [PowerSync spike plan](./sync-powersync-spike.md) (isolation contract, Go/No-Go gates, harness disposal). This reference links those documents instead of duplicating their decision tables.

## Contents

- [Top-Level Layout](#top-level-layout)
- [Key Path Aliases](#key-path-aliases)
- [Main Process (`src/main/`)](#main-process-srcmain)
- [Renderer Process (`src/renderer/src/`)](#renderer-process-srcrenderersrc)
- [Redux Store (`src/renderer/src/store/`)](#redux-store-srcrenderersrcstore)
- [Database Layer](#database-layer)
- [IPC Communication](#ipc-communication)
- [AI Core (`packages/aiCore/`)](#ai-core-packagesaicore)
- [Multi-Window Architecture](#multi-window-architecture)
- [Logging](#logging)
- [Tracing (OpenTelemetry)](#tracing-opentelemetry)
- [Tech Stack](#tech-stack)
- [Source Compatibility Boundary](#source-compatibility-boundary)

## Top-Level Layout

```
src/
  main/          # Node.js backend (Electron main process)
  renderer/      # React UI (Electron renderer process)
  preload/       # Secure IPC bridge (contextBridge)
packages/
  aiCore/        # @cherrystudio/ai-core — AI SDK v6 provider abstraction (provider extension registry + runtime executor)
  shared/        # Cross-process types, constants, IPC channel definitions
  mcp-trace/     # OpenTelemetry tracing for MCP operations
  extension-table-plus/  # TipTap table extension
```

## Key Path Aliases

| Alias | Resolves To |
|---|---|
| `@main` | `src/main/` |
| `@renderer` | `src/renderer/src/` |
| `@shared` | `packages/shared/` |
| `@types` | `src/renderer/src/types/` |
| `@logger` | `src/main/services/LoggerService` (main) / `src/renderer/src/services/LoggerService` (renderer) |
| `@mcp-trace/trace-core` | `packages/mcp-trace/trace-core/` |
| `@cherrystudio/ai-core` | `packages/aiCore/src/` |

## Main Process (`src/main/`)

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
| `AppUpdater` | electron-updater auto-update (frozen; see the Application Identity ADR) |
| `ShortcutService` | Global keyboard shortcuts |
| `ThemeService` | System theme detection/application |
| `CopilotService` | GitHub Copilot OAuth integration |
| `PythonService` | Pyodide WASM Python runtime |
| `NodeTraceService` | OpenTelemetry trace export |

## Renderer Process (`src/renderer/src/`)

React 19 + Redux Toolkit SPA. Key structure:

```
aiCore/          # Legacy AI pipeline (deprecated, migrating to packages/aiCore)
components/      # Shared UI components (Ant Design 5 + styled-components + TailwindCSS v4)
databases/       # Dexie (IndexedDB) — files catalog, settings, knowledge notes, translation history/languages, quick phrases
hooks/           # React hooks (useAssistant, useChatContext, useModel, etc.)
pages/           # Route pages (home eager; files/notes/knowledge/settings/launchpad lazy-loaded as separate chunks — see route loading below)
services/        # Frontend services (ApiService, ModelService, MemoryService, etc.) consuming the preload window.api typed surface
store/           # Redux Toolkit slices
types/           # TypeScript type definitions
workers/         # Web Workers
windows/         # Multi-window entry points (mini, chat import)
```

Route loading (implemented 2026-08-30, renderer-only): `HomePage` eager; `FilesPage`/`NotesPage`/`KnowledgePage`/`SettingsPage`/`LaunchpadPage` lazy-loaded as separate production chunks via `React.lazy`/`Suspense` with bounded localized fallback; tagged chunk-load failures show explicit retry/Home recovery, untagged render errors bubble to the global boundary — no Main/preload/shared IPC/SQLite/Dexie/StoreSync/identity/sync governance crossing.

## Redux Store (`src/renderer/src/store/`)

Slices (redux-persist enabled; `residentRegistry` is non-persisted and excluded from StoreSync — see below):

| Slice | State |
|---|---|
| `assistants` | AI assistant configurations (including the default `contextCount` and the per-topic context-window anchor — see [Context window governance](./context-window.md)) |
| `settings` | App-wide settings |
| `llm` | LLM provider/model configs |
| `mcp` | MCP server configs |
| `messageBlock` | Message block rendering state |
| `knowledge` | Knowledge base entries |
| `memory` | Memory system config |
| `websearch` | Web search settings |
| `shortcuts` | Keyboard shortcuts |
| `tabs` | Tab management |
| `residentRegistry` | Renderer-local non-persisted per-topic completeness (`chatData`, `segments`, `residentTopic = chatData && segments`) and monotonic `applicabilityGeneration`; staged joint publication of latest-window chat-data plus segments via one dispatch (`resident/jointPublishComplete`) — lifecycle foundation with B-01..B-05 retention enforcement implemented renderer-local per `architecture-evolution-program.md` §6.5; Phase 4 closed 2026-08-29 |

## Database Layer

### SQLite (authoritative for ordinary chat)

- `Data/chat.db` lives in the main process, written through `ChatDbAggregateService` (Drizzle ORM + better-sqlite3).
- The renderer never holds a SQLite connection — it accesses chat data via typed IPC (`api.*` wrappers) through `SqliteMessageDataSource` (`src/renderer/src/services/db/SqliteMessageDataSource.ts`).
- See `src/main/services/chatDb/` (connection lifecycle, migrations, repositories, import) and `src/main/services/chatDbImport/` (L2 ZIP compatibility import). Governance: [SQLite migration governance](./sqlite-migration.md).

### IndexedDB (Dexie)

`src/renderer/src/databases/index.ts`:

- **Live tables**: `files` (catalog), `settings`, `knowledge_notes`, `translate_history`, `translate_languages`, `quick_phrases`
- **Exceptions (compatibility, not ordinary runtime chat authority)**:
  - `topics` / `message_blocks` — message-block UI and the legacy renderer-side conversation import path (not an active agents subsystem)
  - `topic_segments` — isolated L2 import compatibility
- Schema is versioned with upgrade functions (`upgradeToV5`, `upgradeToV7`, `upgradeToV8`).

## IPC Communication

- Channel constants defined in `packages/shared/IpcChannel.ts` — the shared contract.
- Renderer → Main: `ipcRenderer.invoke(IpcChannel.XXX, ...args)` via `api.*` wrappers in `src/preload/index.ts`.
- Main → Renderer: `webContents.send(channel, data)`.
- Tracing: `tracedInvoke()` in preload attaches OpenTelemetry span context to IPC calls.
- Typed API surface exposed via `contextBridge` as `window.api`.
- Data-access contract R-02..R-06 (Phase 5) implemented via S6.1-S6.3: windowed reads R-02/R-03 (`chatdb:fetch-messages-window`), authority-aware answer-group/branch/insert/search-hit (R-05/R-04), context closure R-06 with typed completeness, stable-ID anchoring, deterministic `sort_order`->`id`, viewport/context separation, generation applicability-only; Main SQLite remains authoritative; coordinated IPC contract preserved; Phase 5 closed 2026-08-29 (outcome/residual-risk).

## AI Core (`packages/aiCore/`)

The `@cherrystudio/ai-core` package abstracts AI SDK providers and runtime execution. Built on Vercel AI SDK v6 (`ai`):

```
src/core/
  providers/    # Provider extension registry — ProviderExtension / ExtensionRegistry (core/),
                # built-in extensions (core/initialization.ts), types (types/)
  runtime/      # RuntimeExecutor + createExecutor factory, plugin engine
  plugins/      # Built-in plugins
  options/      # Request option preparation
  models/       # Model types
  errors/       # Error types
```

- Built-in extensions registered via `extensionRegistry.registerAll(coreExtensions)` in `core/providers/core/initialization.ts`: Anthropic, Azure, DeepSeek, Google, OpenAI/OpenAI-compatible, OpenRouter, xAI; further backends are contributed through `extensionRegistry.register()`.
- `createExecutor` / `createOpenAICompatibleExecutor` (`core/runtime/`) build a `RuntimeExecutor` with optional plugin composition.
- Custom fork of the openai package: `@cherrystudio/openai` (aliased as `openai`).

## Multi-Window Architecture

The renderer builds multiple HTML entry points (inputs declared in `electron.vite.config.ts`):

- `index.html` — Main application window
- `traceWindow.html` — MCP trace viewer (`src/renderer/src/trace/`)
- `chatImport.html` — L2 ZIP import window (`src/renderer/src/windows/chatImport/`, hidden sandboxed window over the extracted ZIP's IndexedDB)

## Logging

```typescript
import { loggerService } from "@logger";
const logger = loggerService.withContext("moduleName");
// Renderer only: loggerService.initWindowSource('windowName') first
logger.info("message", CONTEXT);
logger.warn("message");
logger.error("message", error);
```

- Backend: Winston with daily log rotation into `userData/logs/`.
- Never use `console.log` — always use `loggerService`.
- See [docs/en/guides/logging.md](en/guides/logging.md) for the developer guide.

## Tracing (OpenTelemetry)

- `packages/mcp-trace/` provides trace-core and trace-node/trace-web adapters.
- The active path: `NodeTraceService` exports spans through `FunctionSpanExporter` into `SpanCacheService` (trace viewer window) via `CacheBatchSpanProcessor`.
- OTLP HTTP export (trace-node/trace-web) is optional and used only when an endpoint is configured.
- IPC calls can carry span context via `tracedInvoke()`.

## Tech Stack

| Layer | Technologies |
|---|---|
| Runtime | Electron 41, Node ≥24.11.1 |
| Frontend | React 19, TypeScript (~5.8) |
| UI | Ant Design 5.27, styled-components 6, TailwindCSS v4 |
| State | Redux Toolkit, redux-persist, Dexie (IndexedDB) |
| Rich Text | TipTap 3.2 (with Yjs collaboration) |
| AI SDK | Vercel AI SDK v6 (`ai`), `@cherrystudio/ai-core` |
| Build | electron-vite 5 with rolldown-vite 7 (experimental) |
| Test | Vitest 3 (unit), Playwright (E2E) |
| Lint/Format | ESLint 9, oxlint, Biome 2 |
| DB (main) | Drizzle ORM + better-sqlite3 (SQLite) — see `src/main/services/chatDb/` |
| DB (renderer) | Dexie (IndexedDB) |
| Logging | Winston + winston-daily-rotate-file |
| Tracing | OpenTelemetry |
| i18n | i18next + react-i18next |

## Source Compatibility Boundary

The following source-format identifiers are **compatibility contracts**, not target application identity. They must never be renamed or repurposed; data isolation comes from profiles, not from renaming these. Governance: [Application Identity ADR](./cherry-chat-application-identity.md).

- Dexie database name `CherryStudio` (`src/renderer/src/databases/index.ts`).
- redux-persist key `persist:cherry-studio` (`src/renderer/src/store/index.ts`).
- ZIP/origin/schema/import declarations and the L2 import pipeline's source-format identifiers (`src/main/services/chatDbImport/`, `tests/e2e/utils/`).
- Protected default profile names `Cherry Studio` / `CherryStudio` — the startup guard rejects these as Cherry Studio default profiles (per the Application Identity ADR).
- `cherrystudio://` deep-link format — legacy source-format reference, not a registered target scheme. The current compatibility wording is governed by the [Application Identity ADR](./cherry-chat-application-identity.md) (URL protocol table); it is not asserted as a live source path here.
