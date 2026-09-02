# PowerSync Disposable Spike — Historical Experiment Record

> **Historical notice — experiment record, not an active plan.** This document is the **historical record** of the one disposable PowerSync feasibility experiment executed 2026-08-16. It preserves **reproducible material facts** only: tested versions/date, isolation/no-production-change scope, measured managed/raw-table/direct-write behavior, constraint-specific No-Go, and harness disposal. Forward-looking plan prose from the original spike plan is removed. For current selection context, see canonical [`sync-architecture-selection.md`](./sync-architecture-selection.md) §5.1 and §7 (S8-SP1) — the historical No-Go is **constraint-specific evidence for re-evaluation**, not a permanent ban.
> **Original proposal lineage**: Scope inherited from historical [`sync-mvp.md`](./sync-mvp.md) SYNC-001…004 (zero production change, device-local authority, excluded domains, streaming not a sync event).

---

## 1. Experiment identity

- **Date executed**: 2026-08-16 (local spike harness).
- **Tested package versions (pinned in disposable harness)**: `@powersync/common@2.1.0` + `@powersync/node@0.21.0` (SDK `sdkVersion=0.5.2/c5c23134` kernel label separate); `better-sqlite3` via `link:../../node_modules/better-sqlite3` reusing root lane-managed **12.11.1** binding (ABI 137/145 via existing lane machinery, no second build).
- **Resolution**: `@powersync/node@0.21.0` → `@powersync/common@2.1.0` + `@powersync/shared-internals@1.1.1` + `comlink@4.4.2` + `undici@7.29.0`; `better-sqlite3` is a link (no download/build). Peer warning: `shared-internals@1.1.1` peer `@powersync/common@2.0.0` resolved as 2.1.0 (same minor family; `^2.1.0` by node) — install WARN only, no runtime failure.
- **Harness location (disposed)**: `scripts/sync-spike/` isolated workspace (`scripts/sync-spike/package.json` + `pnpm-workspace.yaml` + `pnpm-lock.yaml`). Not in production `package.json`/`pnpm-lock.yaml`.

## 2. Isolation and scope (no production change)

- **Branch/code**: Disposable experiment branch; all code under isolated `scripts/sync-spike/` / `spike-*` naming; never imported by production.
- **Data**: Disposable temporary `chat.db` with minimal schema covering risk shapes (relations, trigger/derived placeholder, stable checkpoint); no read/import of any real user `chat.db`, Dexie, or Cherry Studio data (SPIKE-001 lineage).
- **Dependencies**: Not written to production manifest/lockfile (SPIKE-002 lineage); installed only via spike workspace.
- **Network/credentials**: Automated tests had **no network, no real credentials, no real user data** (SPIKE-003 lineage); service-dependent validation was deferred to controlled manual, not an automated Go gate.
- **Runtime/profile**: Independent Electron profile / `userData` isolation; owned cleanup at exit (temporary root removed, handles closed; single short-lived process, no orphaned spike processes).
- **Disposal**: Harness and isolated dependencies **removed from the experiment branch** after Go/No-Go produced and evidence retained; production worktree after removal equals pre-spike state except for this document's evidence.

## 3. Measured findings (local deterministic evidence)

| Area | Finding |
|---|---|
| **Managed tables** | PowerSync managed tables are **JSON-backed views** (`sqlite_master.type='view'`, data in `ps_data__messages`). **Cannot** create FTS5 virtual table, custom triggers, or custom indexes on them; bare duplicate `INSERT` on logical id is rejected (`UNIQUE constraint failed: ps_data__messages.id`); `ON CONFLICT(id) DO UPDATE` is unsupported (`cannot UPSERT a view`); idempotent write via `INSERT OR REPLACE` only. |
| **Raw tables** | Via `Schema.withRawTables` + `Schema.rawTableToJson`, real raw table (`id TEXT PRIMARY KEY` + index + FTS5 external-content + triggers + CRUD triggers) **does** enter `ps_crud` as `{"op":"PUT","type":"messages_raw","id":"raw-1"}` and is visible in `getCrudBatch` — local write capture works. |
| **Direct-write boundary** | Opening an independent `better-sqlite3` connection to same DB file: raw table `messages_raw` → **REJECTED** (`no such function: powersync_in_sync_operation` — `WHEN NOT powersync_in_sync_operation()` guard from PowerSync-registered function); managed view `messages` → **REJECTED** (`no such function: powersync_strip_subtype`); internal store `ps_data__messages` → accepted but `crud delta=0` (bypasses upload queue — destructive divergence path). External connections cannot inject syncable writes; only PowerSync-managed connection can. |
| **Checkpoint/exclusion/idempotence** | Stable checkpoints correctly captured in CRUD batch; synthetic streaming intermediate produced zero sync events; excluded domains (credentials/ui_state/attachment_refs) had `upload delta=0`; `INSERT OR REPLACE` upsert converged to single row; concurrent `writeTransaction` (8) converged without conflict. |
| **Electron smoke** | SDK loads and executes SQL under Electron 41.2.1 / Node 24.14.1 (`integrity_check=ok`) — **smoke only**, not a sync/service proof. |

## 4. Gate summary (local deterministic)

| Gate | Verdict |
|---|---|
| G-1 lifecycle (`integrity_check`, close, persistence) | **proven** |
| G-2 checkpoint / streaming exclusion (local capture) | **partial-proven locally**; service-delivery half deferred per isolation contract (not a failure) |
| G-3 relation + trigger/FTS adaptation | **No-Go — sole deterministic trigger** (see §5) |
| G-4 single-writer transaction | **proven** |
| G-5 excluded-domain zero sync | **proven** |
| G-6 checkpoint idempotence (local upsert) | **proven locally**; service replay half deferred (not a failure) |
| G-7 owned cleanup | **proven** |
| G-8 no-network/no-credential/no-real-data | **proven (static by absence, never `connect()`)** |

## 5. Constraint-specific No-Go and interpretation

- **No-Go rationale (deterministic per §5)**: Production message-content FTS/trigger shapes **cannot be borne as managed tables as-is**; carrying them requires **raw-table migration + write-path + trigger management** — a **production schema/write-path/migration change** (N-2 / SYNC-001). That is **outside zero-production-change spike scope** and has no non-blocking workaround inside the spike. Therefore **No-Go under that constraint**.
- **Not a target-architecture ban**: Per [Architecture Evolution Program](./architecture-evolution-program.md) ARCH-003/ARCH-004 interpretation, target architecture remains vendor-neutral and is not constrained by PowerSync. This No-Go is **vendor/constraint-specific**, not a product decision. It is **evidence for the new S8-SP1 realistic re-evaluation** (service-connected, raw-table-aware, pairing/E2EE/Packaging scope — see canonical [`sync-architecture-selection.md`](./sync-architecture-selection.md) §7), **not a permanent ban**.
- **Re-evaluation rationale**: A realistic S8 spike can assess raw-table FTS coexistence (migration surface), Electron `libpowersync` packaging, no-account pairing/device-trust with PowerSync auth/upload pieces, and TLS/at-rest/E2EE layering — all of which were out of scope for the zero-production-change spike.

## 6. Remaining unknowns (service/packaging half, deferred at experiment time)

Service delivery, service-side idempotence, exact production migration cost for raw-table FTS/trigger porting, Electron packaging of `libpowersync`, and behavior on versions beyond `0.21.0/2.1.0`.

## 7. Historical decision locks (archival)

SPIKE-001…010 (no real-data import; no production manifest change; automated tests offline/credential-free with service validation deferred; minimal risk-shape schema; local loop first; Go/No-Go on local deterministic evidence only; owned temp profile with owned cleanup; no production write path; harness disposed; no vendor commitment) remain as archival constraints for reproducibility. They do not authorize new work.

*End of historical record — harness disposed; evidence retained for audit and for S8-SP1 re-evaluation.*
