# Synchronization Architecture Selection — Fallback Reference Analysis

> **Fallback reference — not current.** The current sync reference is [`./multi-device-sync.md`](./multi-device-sync.md). This document preserves candidate analysis for conditional reuse only: consult it solely when the current path hits a concrete reproducible blocker and a fallback shows clear technical advantage in that same scenario. It does not own current sync status.

> **Status**: **Fallback/reference analysis (limited validation, not production-ready).** **Goal-first policy: `application operation-log + thin HTTP relay` is the current path (see [`./multi-device-sync.md`](./multi-device-sync.md)); PowerSync, cr-sqlite, Turso, and Automerge are conditional fallback candidates only — no blind mandatory parallel comparison.** Candidate findings below are reusable evidence only when a concrete current-path blocker plus clear advantage in the same scenario activates a fallback. MVP route `application operation-log + thin HTTP relay` implemented at `cef4689726` and hardened at `6b40834971` (`fix(sync): harden operation ordering and tombstone convergence`; Main-owned better-sqlite3 preserved; manual endpoint-driven sync; deterministic LWW; additive sync metadata migrations `005_sync_metadata` + `006_sync_field_merge`; filtered payloads; reference relay `scripts/sync-relay/server.ts`). Hardening adds strict payload/framing validation, parent-before-child push ordering with deferred orphan handling, no-progress ack fail-closed, LWW-aligned tombstones with malformed/NULL fail-closed, truthful failure reporting, and ownership/no-op capture guards. Bounded SIGTERM relay restart spike (`scripts/sync-relay/__tests__/serverRestart.test.ts` passed via Node lane; file-backed startup/push/pull, bounded SIGTERM process stop/restart with the same DB, cursor/operation retention, exact owned-PID/root cleanup; server CLI has no SIGTERM handler and performs no clean db.close on SIGTERM) is test-only evidence — no hard-kill WAL durability, no complete persistence guarantees, no production deployment. No final fallback selection. Not production-ready full synchronization.
> **Implementation validation**: prior-state gated evidence for the MVP slice worktree (pinned Node v24.11.1 / pnpm 10.27.0): fresh `pnpm build` exit 0; `pnpm test:e2e tests/e2e/specs/sync/sync-two-profiles.spec.ts` exit 0 with 2 passed (strengthened exact message/topic/block payload assertions); one canonical `pnpm build:check` exit 0 (lint/typecheck/i18n/format/openapi pass; full test suite 7690 passed, 3 skipped, 0 failed) — limited MVP evidence, not full product or E2E/UI regression proof. Final validation for the current worktree with personal-direction changes is pending (fresh build, two-profile E2E, and `pnpm build:check` have not passed after these changes; no new final counts are claimed). Audited hardening passed independent audit; earlier-state `pnpm build:check` (11861 passed, 79 skipped, 0 failed) is retained as prior-state evidence only. Strengthened two-profile E2E validates only ensureTopic + appendMessage/message blocks, manual sync, offline backlog/retry, wrong-token failure, and exact-profile cleanup; not complete mutation coverage, E2EE, realtime, hard-kill/WAL-durability/production persistence validation, or full product/UI coverage. Bounded SIGTERM relay restart validated: `scripts/sync-relay/__tests__/serverRestart.test.ts` passed via Node lane (file-backed startup/push/pull, bounded SIGTERM process stop/restart with the same DB, cursor/operation retention, exact owned-PID/root cleanup) — validates only bounded SIGTERM process restart; server CLI has no SIGTERM handler and performs no clean db.close on SIGTERM, so no clean-shutdown, hard-kill WAL durability, complete persistence, production deployment, or final selection claim follows.
> **Role**: Fallback/reference candidate analysis for Cherry Chat synchronization. This document preserves product-target context, balanced selection method, candidate taxonomy, research findings, and decision rules as reusable evidence. It does not own current sync goal, approach, status, or next decision — those live in [`./multi-device-sync.md`](./multi-device-sync.md) — nor target connection/channel/pairing semantics, which live in the approved [`./sync-connection-channel.md`](./sync-connection-channel.md) (`SYNC-CC-*`). Historical documents are [`./archived/sync-mvp.md`](./archived/sync-mvp.md) (first-phase boundary proposal) and [`./archived/sync-powersync-spike.md`](./archived/sync-powersync-spike.md) (disposable PowerSync experiment) — both retained for audit, not active design inputs.
> **Decision locks (durable IDs)**: SYNC-S8-001 … SYNC-S8-006 (§11), implementing goal-first policy locks LOCK-RT-001 (realtime goal) / LOCK-RT-003 (primary/fallback) / LOCK-RT-004 (MVP limits), plus personal multi-device semantics locks LOCK-PERSONAL-001 / 004 / 005 / 006 / 007 / 008 / 009 / 010 (recorded in §11; temporary reference, not product authority). SYNC-S8 IDs remain the canonical scheme; LOCK-RT and LOCK-PERSONAL IDs are policy aliases recorded in §11.
> **Personal-semantics implementation state (temporary reference, 2026-09-03)**: working-tree code implements the LOCK-PERSONAL target direction (transactional outbox, field patches/clocks/bounded conflict log, SSE hint + reconciliation, personal-scope conflict/checkpoint/delete semantics per §7.1) but is **implemented-but-pending-validation**: focused tests/typecheck pass per execution report only; **independent audit and final gate are pending — no new final counts are cited here**. Prior audited MVP validation (§Status/§7) remains the only gated evidence. This document is a reference artifact, not authority over user value.
> **Related governance**: [Application Identity ADR](./cherry-chat-application-identity.md) (identity, compatibility, updater/release freeze, platform scope), [SQLite migration governance](./sqlite-migration.md) (SQLite chat authority, L2 ZIP import, migration process), [Context window governance](./context-window.md) (stable anchor, allowed transitions), [Architecture Evolution Program](./architecture-evolution-program.md) (terminal state S7; sync is not tracked there). This document does not change those governance boundaries.
> **Limitations (MVP slice; LOCK-RT-004)**: post-commit capture crash window; manual-only operation with no realtime/background sync; unsupported compound/segment/purge/ownership/reset paths; no E2EE/accounts/pairing; no attachments/binary/`file_path`/FTS/UI/context sync; incomplete chat mutation coverage with LWW only (see §10, program §6.9, and `src/main/services/sync/chatDbHook.ts`); reference relay is non-production with no SIGTERM handler and no clean db.close on SIGTERM (bounded SIGTERM process restart only; no hard-kill WAL durability, no complete persistence guarantees, no production deployment); bounded two-profile E2E plus bounded SIGTERM relay restart spike only (see Implementation validation) — no full product/UI coverage. These limits are truthful current evidence; no production readiness or final-selection claim follows.
> **Last updated**: 2026-09-03
> **Owner**: Personal fork (jorkeyliu)

---

## 1. Product target (SYNC-S8-001)

**Syncthing-like local-first synchronization experience; no Cherry Chat account.** Users pair their own devices and connect to **one selected compatible synchronization service** that they deploy themselves or that is deployed online — the service is a pluggable infrastructure choice, not a Cherry Chat account system.

- **No Cherry Chat account system** is introduced by sync. Device pairing and device trust establish which devices belong to the same sync scope. Pairing and device authentication are distinct from an account system and must be described separately from "account/no-account" framing.
- **One service, user-selected.** At any time the user connects to one compatible sync service (self-hosted/local or online). Multi-service federation is not a product target.
- **Local-first.** Each device retains a complete local copy and remains usable offline; sync is an explicit, opt-in coordination layer, not a cloud-primary model.
- **Scope wording**: "Syncthing-like" describes user experience (pairing, local-first, user-controlled service), not a technology commitment to Syncthing's protocol.

This product target is confirmed and locked. The historical `sync-mvp.md` Phase 0/1 framing that left "account vs anonymous device" or "S8 activation" as open is superseded.

**Personal multi-device scope (LOCK-PERSONAL-001)**: personal multi-device only, not team collaboration. Goal is local-first availability, automatic online convergence, offline recovery, and no silent loss. No broad collaboration or shared-workspace claim follows.

**Realtime goal (LOCK-RT-001, part of SYNC-S8-001)**: The user-directed goal is real-time user data sync — initially automatic convergence for online clients plus existing-cursor recovery after short disconnection. The MVP slice is manual-only and does not yet validate this goal; realtime/background behavior is primary-path validation work, not current evidence. The implemented-but-pending-validation direction uses SSE strictly as a notification wake-up plus reconciliation liveness fallback over the existing authenticated push/pull path — SSE is never data authority (see §7.1).

## 2. Current-state constraints vs changeable design choices

### 2.1 Constraints that remain until an approved S8 decision and migration (SYNC-S8-002)

These are implemented reality, not target design, and remain authoritative until S8 documents a selected architecture and an ADR-governed migration:

- **Electron Main owns chat SQLite** (`Data/chat.db` via `ChatDbAggregateService`). Renderer never holds a SQLite connection; all chat access is through typed IPC. This is the sole runtime chat authority.
- **Only stable/final persisted checkpoints are sync candidates (LOCK-PERSONAL-004).** Transient streaming token updates are not sync events; no streaming intermediates sync. The distinction is architectural (SYNC-004 lineage).
- **Excluded local/derived/sensitive domains are not silently synchronized.** Credentials and token stores, derived FTS data, Redux UI state, `contextWindowAnchor` (renderer assistant-settings per-topic anchor), Knowledge/Memory/Trace, binary attachment payloads, device-local `file_references.file_path`, import artifacts, and backup/restore state are excluded from any sync path. `file_path` leakage and credential leakage are prohibited.
- **Device-local-state separation** (profile, local paths, preferences) is preserved.
- **Existing governance boundaries** (Application Identity, SQLite migration, context window, platform/release) remain authoritative until separate decisions.

### 2.2 Design choices that S8 may change later (only via approved decision + migration)

Cross-device authority model, revision/versioning, tombstone/deletion propagation, outbox/checkpoint metadata, conflict resolution, transport/relay topology, service pairing/auth, at-rest vs TLS vs E2EE scope, attachment payload handling, and any schema or IPC contract change are **design choices**. None is implied by preserving the constraints above. Any change requires an S8 documented selection plus applicable ADR/migration and coordinated contract review.

## 3. Balanced four-dimension selection method (SYNC-S8-003)

Selection balances **four dimensions together**; no dimension dominates, and no candidate is demoted solely for being heavier or more complex:

| Dimension | What is evaluated |
|---|---|
| **A. Synchronization effect / UX** | Convergence correctness, offline and realtime behavior, conflict handling, pairing/E2EE flow clarity, failure and recovery semantics, user-perceived latency and determinism. |
| **B. Fit to current Cherry Chat data characteristics** | Preserved SQLite authority, stable checkpoint model, dense `sort_order` ordering, FTS/trigger coexistence, file reference model, topic/message/block/segment structure, hard-delete cascade and required tombstone gap. |
| **C. Development and long-term maintenance difficulty** | Correctness burden (protocol, merge, conflict, snapshot/GC), Electron packaging and native-extension lifecycle, upgrade and migration maintenance, debuggability and operability by the Cherry Chat team. |
| **D. Deployment and configuration difficulty** | Self-hosted vs hosted operability, pairing setup, service and auth material management, upgrade and backup of the sync service, cost and skill required for the user-selected service. |

Evaluation is qualitative balanced judgment, not numeric scoring. A candidate that is heavier in C or D can still be selected if it is materially better in A and B and the team accepts the maintenance/deployment cost. Conversely, complexity is not irrelevant — it is one of four co-equal inputs.

The four dimensions apply to primary-path validation and, only when a fallback is activated under §8, to the activated fallback comparison in the same scenario.

## 4. Candidate taxonomy: primary path + conditional fallbacks (SYNC-S8-004; LOCK-RT-003)

### 4.1 Primary realtime validation path

| Candidate | Stack | Selection relevance |
|---|---|---|
| **C3 — Cherry Chat application operation-log + thin HTTP relay (primary)** | Current SQLite preserved; application-level operation log preserving compound business intent + thin HTTP relay | **Primary realtime validation path for LOCK-RT-001.** Preserves current DB and business-intent granularity; places protocol correctness, snapshots/GC, conflict handling, and relay maintenance entirely on Cherry Chat (see §5.3). All goal-conditioned validation (§6–§9) runs on this path first. |

### 4.2 Conditional fallbacks (activated only by §8 evidence)

| Candidate | Condition to activate |
|---|---|
| **C1 — PowerSync complete stack** | Activated only by a reproducible unmet-goal/technical blocker on the primary path in a concrete scenario plus evidence of a clear PowerSync advantage in that same scenario (§8). Research findings retained in §5.1 as reusable evidence, not as an active comparison mandate. |
| **C2 — cr-sqlite + relay** | Activated only by a reproducible unmet-goal/technical blocker on the primary path in a concrete scenario plus evidence of a clear cr-sqlite advantage in that same scenario (§8). Research findings retained in §5.2 as reusable evidence, not as an active comparison mandate. |
| **C4 — Turso Database + Turso Database Sync** | Activated only by a reproducible unmet-goal/technical blocker on the primary path in a concrete scenario plus evidence of a clear Turso advantage in that same scenario (§8). Research findings retained in §5.4 as reusable evidence, not as an active comparison mandate. Engine/FTS migration and deployment maturity are costs, not automatic eliminators; conflict granularity, compound transaction behavior, and production self-hosted deployment readiness remain unknown to test until activation. |
| **CF — Automerge Repo (CRDT/document-model family)** | Activated only by a reproducible unmet-goal/technical blocker on the primary path plus evidence that the CRDT/document-model family has a clear advantage in that same scenario, or if the primary path plus activated fallbacks above yield no balanced acceptable outcome (§8). Findings retained in §5.6 as reusable evidence, not as an active comparison mandate. |

No blind mandatory parallel comparison is performed. No fallback runs before §8 activation and no decision waits on all candidates.

### 4.3 Deferred (not banned, with specific fit rationale)

| Candidate | Deferral rationale (specific, not "merely heavy") |
|---|---|
| **ElectricSQL / RxDB / CouchDB-family** | **Mismatched read-path or storage-authority models**: log/read-path shapes or storage layering that conflict with Main SQLite authority and windowed/closure read contracts (see §5.5). |

Deferred candidates are not permanently banned. A future explicit decision can promote a deferred candidate as a conditional fallback under §8 with a new four-field contract if its documented fit changes or if the primary path is blocked.

## 5. Documented research findings with primary sources

> Findings are documented constraints and capabilities, not production-readiness claims. The primary path requires goal-conditioned validation (§7) before any realtime claim; fallback findings are reusable evidence only when that fallback is activated under §8.

### 5.1 PowerSync

- **What it buys**: Mature checkpoint/realtime/offline machinery with sync rules and managed client SQLite, including offline queue and checkpoint replay.
- **What it costs**: Architecture is source database + PowerSync Service + developer-owned upload connector and authentication service; client storage is PowerSync-managed (managed tables are JSON-backed views over `ps_data_*`; raw tables via `withRawTables`/`rawTableToJson` are the path for custom indexes/triggers/FTS).
- **Discovered constraint (reproducible, 2026-08-16, `@powersync/common@2.1.0` / `@powersync/node@0.21.0`, `better-sqlite3@12.11.1`, disposable harness — see historical [`sync-powersync-spike.md`](./archived/sync-powersync-spike.md) §5)**: Managed tables reject custom FTS5/trigger/index creation, reject bare duplicate `INSERT` on logical id, and do not support `ON CONFLICT DO UPDATE` on the view; raw tables restore CRUD capture but external SQLite connections cannot inject syncable writes without the PowerSync-registered `powersync_in_sync_operation()` / `powersync_strip_subtype()` functions. Production FTS/trigger coexistence requires raw-table migration and write-path change — a material production change, not a spike workaround.
- **Open for conditional fallback validation (only when activated under §8)**: No-account pairing and device-trust flow with PowerSync's auth/upload pieces, E2EE layering over PowerSync's TLS/at-rest, actual Electron packaging of `libpowersync`, and FTS coexistence under raw tables must be validated in a realistic service-connected spike if PowerSync is activated. Prior No-Go was constraint-specific under zero-production-change scope (see historical [`sync-powersync-spike.md`](./archived/sync-powersync-spike.md) §5 and [Architecture Evolution Program](./architecture-evolution-program.md) §9.6) — it is evidence for re-evaluation, not a permanent ban.
- **Primary sources**: [PowerSync docs — Architecture overview](https://docs.powersync.com/architecture/architecture-overview) · [PowerSync Service](https://docs.powersync.com/architecture/powersync-service) · [Sync rules](https://docs.powersync.com/sync/rules/overview) · [Client SDK / offline-first](https://docs.powersync.com/client-sdks/overview) · [Raw tables — bypass JSON view limitations](https://docs.powersync.com/client-sdks/advanced/raw-tables) · [@powersync/node on npm registry](https://registry.npmjs.org/%40powersync%2Fnode) · [PowerSync GitHub — powersync-js](https://github.com/powersync-ja/powersync-js)

### 5.2 cr-sqlite

- **What it buys**: SQLite extension that captures row-level changes as CRDT state and merges via Causal-Length-Vector clocks; local-first merge without a heavyweight service for capture semantics.
- **What it costs**: Native SQLite extension must be packaged for Electron (ABI lane `better-sqlite3` interaction, `libcr-sqlite` loading), relay still required for cross-device dissemination, derived FTS content needs separate treatment (external-content or post-merge rebuild), schema must expose CRDT-friendly keys, and maturity/performance on large histories needs verification.
- **Primary sources**: [cr-sqlite GitHub](https://github.com/vlcn-io/cr-sqlite) · [vlcn.io — cr-sqlite docs](https://vlcn.io/docs/cr-sqlite/intro) · [cr-sqlite — Installation / Electron notes](https://vlcn.io/docs/cr-sqlite/installation)

### 5.3 Application operation-log + relay (custom)

- **What it buys**: Current SQLite and Drizzle layer preserved; operation log preserves compound business intent (create/edit/delete/reorder/branch vs raw row diffs); maximal fit to existing data characteristics.
- **What it costs**: All protocol correctness, snapshot/GC, history retention, conflict handling, idempotence/atomicity of replay, and relay operation are owned by Cherry Chat. No external sync vendor absorbs those concerns.
- **Primary sources**: Internal architecture (current `ChatDbAggregateService`, `MessagesRepository`, `sort_order` dense ordering, topic/segment model) — no external sync vendor docs apply; correctness and performance are proved only by S8 spike evidence.

### 5.4 Turso Database + Turso Database Sync — conditional fallback C4

- **What it buys**: **Turso Database + Turso Database Sync** provides **logical-statement synchronization with last-push-wins** handling; pull performs atomic rollback to last synced state, applies remote changes, then replays unpushed local changes on top (see conflict resolution). Embedded replicas are a **distinct read-oriented replica pattern**, not Database Sync — mentioned only as separate comparison context.
- **What it costs**: Engine is **Turso Database** (SQLite-compatible; Tantivy-powered FTS via `USING fts` / `fts_match` — distinct from SQLite FTS5) — adopting it replaces the SQLite engine surface area; this is a cost, not an automatic eliminator. **libSQL** (SQLite fork) and **embedded replicas** (read replica pattern) are **separate comparison context**, not Database Sync. Officially documented deployment modes are **Turso Cloud** and **local sync server for development/testing** (the local sync server is documented for development/testing); production self-hosted/other deployment readiness is an **S8-SP4 validation unknown**. Deployment maturity is a co-equal dimension (D), not an automatic eliminator.
- **Open for conditional fallback validation (only when activated under §8)**: Exact **conflict granularity** (row vs logical-statement vs whole-database) and **compound transaction implications** for Cherry Chat's dense `sort_order`, FTS/trigger coexistence, `file_references.file_path` isolation, tombstone, and hard-delete cascade are **unknown to test** and require validation only if Turso is activated. Current official evidence establishes logical-statement synchronization with last-push-wins at the documented statement level — it does **not** justify claiming the last push overwrites the whole database. Whether production self-hosted deployment is viable beyond Turso Cloud and development/testing local sync server is likewise **unknown to test**.
- **Primary sources**: [Turso Database — introduction](https://docs.turso.tech/introduction) · [Turso Database — Full-Text Search (Tantivy)](https://docs.turso.tech/sql-reference/functions/fts) · [Turso — Sync usage (Database Sync)](https://docs.turso.tech/sync/usage) · [Conflict resolution — last push wins at statement level](https://docs.turso.tech/sync/conflict-resolution) · [Local sync server — development/testing](https://docs.turso.tech/sync/local-sync-server) · [Embedded replicas — read replica pattern (separate comparison context)](https://docs.turso.tech/features/embedded-replicas/introduction) · [libSQL — separate comparison context (SQLite fork, not C4)](https://docs.turso.tech/libsql)

### 5.5 Electric / RxDB / Couch family (deferred)

- **ElectricSQL**: Postgres logical-replication read-path (publication/shapes); storage authority is Postgres, not Cherry Chat's Main SQLite.
- **RxDB / CouchDB-family**: Storage-authority and replication protocol assume their own document store as primary; adapting Cherry Chat's SQLite authority and windowed/closure contracts would require replacing the authority boundary.
- **Primary sources**: [ElectricSQL docs](https://electric.ax/docs/intro) · [Electric GitHub](https://github.com/electric-sql/electric) · [RxDB docs](https://rxdb.info/) · [CouchDB replication docs](https://docs.couchdb.org/en/stable/replication/index.html)

### 5.6 Automerge Repo (conditional fallback — CF)

- **What it buys**: CRDT document model with Repo sync layer; document-centric merge without central DB. Reusable evidence only when activated under §8.
- **Primary sources**: [Automerge docs](https://automerge.org/docs/) · [Automerge Repo GitHub](https://github.com/automerge/automerge)

## 6. Goal-conditioned primary-path validation scenarios

SCE-01..08 are retained as **goal-conditioned primary-path validation inventory** for LOCK-RT-001, not as a mandatory equal matrix across all candidates. They are validated on the primary path (`application operation-log + thin HTTP relay`) first, evaluated through all four dimensions (§3). A conditional fallback reuses only the scenarios relevant to its activation evidence, and only after activation under §8.

| Scenario | What is exercised | Dimensions most stressed |
|---|---|---|
| **SCE-01 — Single-user multi-device online** | Two paired devices converge on stable checkpoints with TLS; service hosted vs self-hosted both exercised | A, B, D |
| **SCE-02 — Offline edit then merge** | Both devices edit same topic/message/block offline, then reconnect; conflict matrix (§4 in historical `sync-mvp.md`) exercised | A, B, C |
| **SCE-03 — Batch and middle insert** | Batch import / middle `sort_order` inserts under sync replay | A, B, C (§9 gate) |
| **SCE-04 — Large history and FTS** | Topics with large message/block history and FTS derived state | B, C |
| **SCE-05 — Delete and trash recovery** | Hard delete / tombstone / trash restore propagation | A, B |
| **SCE-06 — Attachment and file reference** | File reference lifecycle; `file_path` isolation (attachment payload scope remains open — see §10) | A, B |
| **SCE-07 — Pairing and device trust** | Pairing flow, device addition/removal, no Cherry Chat account, device-auth material handling | A, D |
| **SCE-08 — Deployment topology** | Same scenarios on hosted vs self-hosted service deployment | D, C |

**Per-scenario evidence includes**: convergence correctness, idempotence/replay safety, causal ordering, failure/recovery, and where applicable bounded numeric proxies (never thresholds or SLAs). TLS for transport is required baseline; at-rest encryption and E2EE are distinguished (see §10) and not assumed.

## 7. Goal-first validation plan (primary path + conditional fallback spikes)

Primary-path validation runs first on `application operation-log + thin HTTP relay` under the goal-conditioned scenarios (§6) and the write-amplification replay gate (§9). Fallback spikes (S8-SP1/SP2/SP4/CF) are **conditional only** — each requires §8 activation evidence before execution. Each validation is **documentation/research only** except for the already-implemented MVP slice: disposable harness, synthetic DB, no production dependency or schema, evidence retained as docs. No fallback is selected without activation.

> **MVP implementation note (2026-09-03)**: Primary path `application operation-log + relay` has an **MVP implementation slice** at `cef4689726` with **audited hardening** at `6b40834971` (see Status and §6.9) plus **strengthened bounded two-profile E2E validated for the prior-state worktree** (`tests/e2e/specs/sync/sync-two-profiles.spec.ts`, 2 passed after a fresh build with strengthened exact message/topic/block payload assertions; scope bounded to ensureTopic + appendMessage/message blocks, manual sync, offline backlog/retry, wrong-token failure, exact-profile cleanup; final validation for the current worktree with personal-direction changes is pending) plus **bounded SIGTERM relay restart spike** (`scripts/sync-relay/__tests__/serverRestart.test.ts` passed via Node lane; file-backed startup/push/pull, bounded SIGTERM process stop/restart with the same DB, cursor/operation retention, exact owned-PID/root cleanup; server CLI has no SIGTERM handler and performs no clean db.close on SIGTERM; no hard-kill WAL durability, no complete persistence guarantees, no production deployment). This is a limited manual HTTP relay slice — not full primary-path realtime validation and not a fallback selection. Fallback candidates remain conditional only under §8.

| Spike | Candidate | Bounded scope | Isolated harness | Activation gate | Exit: documented evidence |
|---|---|---|---|---|---|
| **S8-SP3 (primary)** | Application operation-log + thin HTTP relay (primary) | Op-log schema (outbox/checkpoint/tombstone) + relay + replay/apply semantics + snapshot/GC sketch + realtime goal validation (automatic online convergence, short-disconnection cursor recovery) | Same isolation as below | Explicit activation via current sync reference; this document remains fallback analysis | Log capture fidelity (compound intent), replay atomicity/idempotence, snapshot/GC, relay maintenance, realtime goal behavior — under goal-conditioned SCE-01..08 |
| **S8-SP1 (conditional)** | PowerSync complete stack | Service-connected realistic spike only when activated: source DB + PowerSync Service (disposable instance) + developer upload/auth connector + Electron client with raw tables + pairing flow + TLS baseline + E2EE framing as overlay (TLS/at-rest/E2EE distinguished) | Disposable branch, disposable DB/profile, dependencies isolated from production `package.json`/lockfile, no real user data, no production import, `better-sqlite3` via lane-managed binding | §8 activation (reproducible primary blocker + clear advantage in same scenario) | Activated-scenario evidence only (managed vs raw table behavior with FTS, Electron packaging, pairing/device-trust flow, idempotence/replay, deployment hosted vs self-host) |
| **S8-SP2 (conditional)** | cr-sqlite + relay | Native extension packaging for Electron + minimal relay + FTS derived treatment + schema adaptation surface, only when activated | Same isolation as SP1 | §8 activation (reproducible primary blocker + clear advantage in same scenario) | Activated-scenario evidence only (extension load on both ABI lanes, relay dissemination, FTS coexistence, merge correctness) |
| **S8-SP4 (conditional)** | Turso Database + Turso Database Sync | Turso Database + Turso Database Sync via Turso Cloud and local sync server (development/testing); production self-hosted/other deployment readiness is validation unknown until activation; libSQL and embedded replicas are separate comparison context, only when activated | Same isolation as SP1 | §8 activation (reproducible primary blocker + clear advantage in same scenario) | Activated-scenario evidence only (engine/FTS migration surface Tantivy `USING fts` / `fts_match`, deployment-mode comparison, logical-statement last-push-wins granularity and compound transaction behavior, idempotence/replay, pairing/device-trust) |

**CF Automerge Repo** is a conditional fallback validated only under its §8 activation, reusing only the relevant SCE scenarios.

### 7.1 Personal multi-device direction — implemented-but-pending-validation (temporary reference)

Target personal semantics (LOCK-PERSONAL-001/004/005/006/007/008/009/010) for the primary operation-log + relay route; code exists in the working tree but has **not passed independent audit or final gate**:

- **Transactional outbox (LOCK-PERSONAL-006)**: supported stable mutations enqueue sync intent inside the same aggregate transaction; a throw rolls back the enclosing mutation. SQLite remains the chat authority; Main-owned access is preserved.
- **Primary realtime design**: existing authenticated push/pull remains the only data path. SSE `/sync/subscribe` carries only a non-authoritative cursor hint; debounced local auto-sync, coalesced remote wake-up, bounded reconnect/retry, and low-frequency reconciliation act as notification wake-up plus liveness fallback, never data authority.
- **Field patches / clocks / conflict log (LOCK-PERSONAL-005/010)**: union-by-ID creates; upsert updates carry only intentional changed allowlisted fields plus identity/immutable relations (never `sortOrder`); independent fields merge via per-field clocks; same-field conflicts resolve by deterministic LWW with a bounded durable conflict record (fixed cap). Conflicts surface as count/records; dedicated restore UI is deferred.
- **Personal-scope conflict/checkpoint/delete semantics (LOCK-PERSONAL-004/005/007/008/009)**: stable checkpoints only, no streaming intermediates; hard delete wins over late descendants (own- and topic-tombstone suppression); reorder is unsupported (local update patches never send `sortOrder`); capture failures are durable and truthful (never silent convergence); excluded domains (credentials, `file_path`, FTS, context, attachments/binary, UI state) remain excluded.
- **Other technology remains conditional fallback only** on concrete current-path blocker evidence plus clear advantage in the same scenario (§8); no fallback vendor is selected here.

**Remaining proof obligations (not yet evidenced)**: compound operations, dense-`sort_order` ordering under replay, structured content (segments/answers), relay production lifecycle (hard-kill/WAL durability, deployment, backup/upgrade), performance/write-amplification on the actual replay path, conflict restore UX, and any collaboration-scope or E2EE claim. No full daily-readiness claim follows before audit/gate.

**Common validation constraints** (primary and any activated fallback):

- Disposable branch, disposable DB/profile, no production code/schema/IPC/migration, no real user data.
- Synthetic or fixture data only; no raw DB size, path, content, or credential in evidence.
- Each spike states tested versions and date, isolation scope, and disposal disposition (harness removed, evidence retained as docs).
- Four-field evidence contract required per spike (named decision/outcome, claim, minimum sufficient method, stopping condition) before execution counts as progress.
- No threshold, baseline, SLA, or capacity policy is adopted from spike evidence.

## 8. Decision rules

- **Balanced qualitative judgment** across four dimensions (§3) with equal standing. No arbitrary numeric scores or weights.
- **No demotion for weight alone and no dismissal of complexity.** A heavier candidate can win if it is materially better in sync effect and data-characteristics fit and the team explicitly accepts the dev/maintenance and deployment cost.
- **Primary first.** Primary-path validation (§7, S8-SP3) runs first under goal-conditioned scenarios (§6). No fallback is evaluated in parallel without activation.
- **Fallback activation (LOCK-RT-003).** A fallback (C1/C2/C4/CF, including promotion of a deferred candidate) is activated only by **both**: (a) a reproducible unmet-goal/technical blocker on the primary path in a concrete scenario, and (b) evidence of a clear advantage of that fallback in the same scenario, judged on the four dimensions (§3). Activation requires a new explicit decision with four-field contract. No blind mandatory parallel comparison.
- **Constraint-specific No-Go ≠ permanent ban.** The historical PowerSync No-Go was a zero-production-change constraint result. It is reusable evidence for conditional re-evaluation, not a preselection against PowerSync. Similarly, deferred candidates (Electric/RxDB/Couch) are not scored down for weight; they are deferred for specific fit gaps (§4.3) and can be activated only under the fallback rule above.
- **Validation, not adoption.** A validation Go means "primary path validated" or "activated fallback worth adopting among evaluated options," not production readiness. Any adoption documents accepted trade-offs and residual risks; production authorization is a separate governed step.

## 9. DB write-amplification gate (SYNC-S8-006 lineage)

No DB-health optimization is proven ready-now. The following are **S8 design gates**, not pre-selection thresholds:

- **Dense `sort_order` O(N) shift** on middle/batch insert (M1 lineage) and **long/batch transaction write amplification** must be measured **after the primary path's actual replay/apply model is defined** — amplification is model-dependent (row-state apply vs CRDT merge vs op-log replay), so the gate runs on the primary replay path first.
- **Primary-path replay gate.** Primary validation (S8-SP3) includes a bounded write-amplification probe on its own replay path using synthetic isolated DBs, with `WAL checkpoint` normalization and read-only metric collection (no production data, no physical DB size claim beyond synthetic proxies).
- **Fallback replay gate only after activation.** An activated fallback runs the same probe on its own replay path only within its activated scenario scope.
- Results are directional decision evidence. They gate S8 design acceptance, not earlier phases, and do not become thresholds/SLAs.

## 10. Open decisions (remain open until S8 evidence supports them)

These are not resolved by this document and must not be silently assumed by any spike or implementation:

- **E2EE details**: Whether E2EE is introduced, at what granularity (per-device, per-topic, per-message), key agreement and storage, and how it layers over TLS and at-rest encryption. TLS for transport and at-rest service encryption are distinct from E2EE and must not be conflated.
- **Personal conflict policy target (LOCK-PERSONAL-005/007/008/009/010; implemented-but-pending-validation, see §7.1)**: union-by-ID creates; allowlisted intentional field patches; independent fields merge via per-field clocks; same-field deterministic LWW with bounded observable/recoverable conflict record; hard delete wins over late descendants; reorder unsupported; durable capture errors; conflicts exposed as count/records while dedicated restore UI is deferred. Per-operation branch/answer-selection/segment/trash merge beyond this remains open.
- **Attachment payload scope**: Whether binary attachment payloads are synchronized, Inline vs reference, size bounds, and storage for attachments. Binary payloads and `file_path` remain excluded with no collaboration-scope claim.
- **Recovery and rotation**: Device loss/recovery, key rotation, unpairing, and re-pairing semantics.
- **Exact service implementation**: Relay/service topology, hosting options, upgrade and backup of the sync service, and auth material lifecycle. Relay production lifecycle (hard-kill/WAL durability, deployment, backup/upgrade) is a remaining proof obligation.
- **Remaining product/technical proof obligations**: compound operations, dense-`sort_order` ordering under replay, structured content (segments/answers), relay production lifecycle, performance/write-amplification on the actual replay path, conflict restore UX, and any broad collaboration or E2EE claim. None is evidenced by the pending-validation code state.
- **Final selection**: No fallback is selected by this document; the primary path is validated first and a fallback is adopted only after §8 activation. SSE remains a notification wake-up plus reconciliation liveness fallback, never data authority; other technology remains conditional fallback only on concrete current-path blocker evidence plus clear advantage.

Non-goals confirmed: team collaboration/shared workspaces, broad collaboration or E2EE claims, full daily readiness before audit/gate, vendor commitment, privacy-policy change, production schema/migration, and production sync path remain non-goals until S8 selection is documented and governed.

## 11. Decision table (durable IDs)

| # | Decision | Status |
|---|---|---|
| **SYNC-S8-001** | **Product target + realtime goal (LOCK-RT-001)**: **Syncthing-like local-first sync; no Cherry Chat account; device pairing; users connect to one selected compatible sync service (online or self-hosted/local)**. Device pairing/trust is distinct from an account system and described separately. **Realtime goal: real-time user data sync — initially automatic convergence for online clients plus existing-cursor recovery after short disconnection.** | **Locked** |
| **SYNC-S8-002** | **Current-state baseline preserved until approved S8 decision and migration**: Electron Main SQLite is chat runtime authority; only stable/final persisted checkpoints are sync candidates; transient streaming and all currently excluded local/derived/sensitive domains (credentials, derived FTS, Redux UI state, `contextWindowAnchor`, Knowledge/Memory/Trace, binary attachments, device-local `file_path`, import and backup artifacts) are not silently synchronized. Architecture may change only via S8 documented selection and governed migration. | **Locked** |
| **SYNC-S8-003** | **Balanced four-dimension selection**: sync effect/UX, fit to current data characteristics, dev/maintenance difficulty, deployment/configuration difficulty are **co-equal**; no candidate is demoted merely for being heavier, and complexity is not dismissed. Applies to primary-path validation and, when activated, to the activated fallback comparison in the same scenario. | **Locked** |
| **SYNC-S8-004** | **Goal-first primary/fallback taxonomy (LOCK-RT-003)**: **Application operation-log + thin HTTP relay is the primary realtime validation path.** **PowerSync complete stack, cr-sqlite + relay, Turso Database + Turso Database Sync, and Automerge Repo are conditional fallbacks only — no blind mandatory parallel comparison.** A fallback (including promotion of a deferred candidate) requires a reproducible unmet-goal/technical blocker on the primary path in a concrete scenario plus evidence of a clear advantage in the same scenario, with a new explicit decision and four-field contract. **Electric/RxDB/Couch** remain deferred for mismatched read-path/storage-authority models. Turso Database engine/FTS migration and deployment maturity are costs, not automatic eliminators; Turso conflict granularity, compound transaction behavior, and production self-hosted deployment readiness are unknown to test until activation. | **Locked** |
| **SYNC-S8-005** | **Historical selection-validation context; fallback/reference only; no implementation authorization, except for the explicitly user-authorized limited MVP exception at `cef4689726` plus audited hardening at `6b40834971` (application operation-log + thin HTTP relay, manual-only, limited validation, not production-ready; LOCK-RT-004 limits retained).** Current status is owned by [`./multi-device-sync.md`](./multi-device-sync.md); this row is retained for audit, not as active phase ownership. | **Locked (historical)** |
| **SYNC-S8-006** | **DB write-amplification replay gate**: Dense `sort_order` O(N) shift and long/batch transaction write amplification are **measured after the primary path's actual replay/apply model is defined** as an S8 design gate; an activated fallback runs the same probe only within its activated scope. No proven ready-now DB-health optimization; results are directional decision evidence, not thresholds. | **Locked** |
| **LOCK-PERSONAL-001** | **Personal multi-device, not team collaboration.** Goal: local-first availability, automatic online convergence, offline recovery, no silent loss. | **Locked (temporary reference)** |
| **LOCK-PERSONAL-004** | **Stable checkpoints only, no streaming intermediates.** | **Locked (temporary reference)** |
| **LOCK-PERSONAL-005** | **Union-by-ID creates; allowlisted intentional field patches; independent fields merge; same-field deterministic LWW with bounded observable/recoverable conflict record.** | **Locked (temporary reference)** |
| **LOCK-PERSONAL-006** | **Transactional outbox for supported stable mutations.** | **Locked (temporary reference)** |
| **LOCK-PERSONAL-007/008/009/010** | **Hard delete wins late descendants; reorder unsupported; durable capture errors; conflicts exposed as count/records while restore UI deferred.** | **Locked (temporary reference)** |

Historical locks SYNC-001…004 and SPIKE-001…010 remain as historical evidence in [`./archived/sync-mvp.md`](./archived/sync-mvp.md) and [`./archived/sync-powersync-spike.md`](./archived/sync-powersync-spike.md); they are not re-locked here except as superseded lineage.

## 12. Governance and validation requirements

- **This document is documentation/research only, except for the explicitly user-authorized MVP slice** at `cef4689726` plus audited hardening at `6b40834971` (limited validation, not production-ready full sync). Any further production change requires a separate governed decision (ADR for schema/migration, coordinated review for IPC/preload/shared contracts, per evidence-task contract for measurement). The MVP slice does not change application identity, release, platform, or SQLite migration governance.
- **Spike validation**: Primary validation (S8-SP3) and any activated fallback spike each require evidence-task four-field contract (named decision/outcome, claim, minimum sufficient method, stopping condition). Harness completeness alone never closes validation; privacy safeguards (no content/credential/path/raw DB size) are mandatory. MVP slice validation is limited prior-state evidence (audited hardening + prior-state `pnpm build` exit 0 + prior-state strengthened two-profile E2E 2 passed with exact message/topic/block payload assertions + prior-state one canonical `pnpm build:check` exit 0 for the then-exact worktree code surface per Status plus bounded SIGTERM relay restart spike per Status; final validation for the current worktree is pending — no new final counts; no full product/UI regression proof; relay restart is bounded SIGTERM process restart only with no SIGTERM handler/db.close, no hard-kill WAL durability, no production deployment) — see Status.
- **No E2EE/account/attachment/vendor claim** without primary-path (or activated-fallback) evidence. TLS, at-rest encryption, and E2EE are distinguished.
- **No readiness, production-ready, or fallback-selection claim** beyond the implemented manual MVP route without goal-conditioned primary-path evidence; a fallback is adopted only after §8 activation. PowerSync/Turso/cr-sqlite/Automerge remain conditional fallbacks unless current docs already say otherwise.
- **Personal-semantics pending state**: the §7.1 working-tree direction is implemented-but-pending-validation (focused tests/typecheck per execution report only); independent audit and final gate are pending and no new final counts are cited. No full daily-readiness, broad collaboration, or E2EE claim follows.
- **Architecture Evolution Program Phase 8** historical context only (terminal state S7; sync is not tracked there); current sync status lives in [`./multi-device-sync.md`](./multi-device-sync.md).

## 13. Document lifecycle

- **Fallback role**: This document (`docs/sync-architecture-selection.md`) is a fallback/reference analysis. Current sync status lives in [`./multi-device-sync.md`](./multi-device-sync.md). Consult this file only when the fallback activation condition in the current reference is met.
- **Historical — retained, not deleted**:
  - [`docs/archived/sync-mvp.md`](./archived/sync-mvp.md) — Historical notice/record. Its Phase 0/1 proposal, open-question framing, and vendor-open stance are superseded. Retained for audit of prior locks (SYNC-001…004), data-scope exclusions, authority/projection concepts, and conflict-matrix inventory.
  - [`docs/archived/sync-powersync-spike.md`](./archived/sync-powersync-spike.md) — Historical experiment record. Retained for reproducible material facts (versions, isolation scope, managed/raw-table findings, disposed harness, constraint-specific No-Go). It is reusable evidence for conditional re-evaluation if PowerSync is activated under §8, not a permanent ban.
- **No implementation authorization** flows from either historical document. Any citation of them as authoritative design input for new work is stale.
- History is preserved in Git; this file replaces only current authority, not historical evidence.

---

## 14. References

- [Architecture Evolution Program](./architecture-evolution-program.md) — Phases, ARCH-003..006, debt, triggers.
- [Sync Connection & Channel ADR](./sync-connection-channel.md) — Approved target connection/registration/channel/pairing semantics (`SYNC-CC-*`).
- [SQLite migration governance](./sqlite-migration.md) — SQLite chat authority and migration process.
- [Context window governance](./context-window.md) — Stable topic context anchor.
- [Application Identity ADR](./cherry-chat-application-identity.md) — Identity, compatibility, platform, release.
- Historical: [Sync MVP (historical)](./archived/sync-mvp.md) · [PowerSync spike (historical)](./archived/sync-powersync-spike.md)
- External primary sources cited in §5 (PowerSync, cr-sqlite, Turso Database / Turso Database Sync, libSQL as separate comparison context, Electric, RxDB, CouchDB, Automerge/Automerge Repo).

*End of fallback reference analysis.*
