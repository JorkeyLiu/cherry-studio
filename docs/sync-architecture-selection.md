# Synchronization Architecture Selection — S8 Selection Validation (Canonical)

> **Status**: **S8 Selection Validation — Active; MVP slice implementation + audited hardening + strengthened two-profile E2E + bounded SIGTERM relay restart spike complete (limited validation, not production-ready; broader S8 remains open)**. Selection validation remains canonical authority. MVP route `application operation-log + thin HTTP relay` implemented at `cef4689726` and hardened at `6b40834971` (`fix(sync): harden operation ordering and tombstone convergence`; Main-owned better-sqlite3 preserved; manual endpoint-driven sync; deterministic LWW; additive sync metadata migration `005_sync_metadata`; filtered payloads; reference relay `scripts/sync-relay/server.ts`). Hardening adds strict payload/framing validation, parent-before-child push ordering with deferred orphan handling, no-progress ack fail-closed, LWW-aligned tombstones with malformed/NULL fail-closed, truthful failure reporting, and ownership/no-op capture guards. Bounded SIGTERM relay restart spike (`scripts/sync-relay/__tests__/serverRestart.test.ts` passed via Node lane; file-backed startup/push/pull, bounded SIGTERM process stop/restart with the same DB, cursor/operation retention, exact owned-PID/root cleanup; server CLI has no SIGTERM handler and performs no clean db.close on SIGTERM) is test-only evidence — no hard-kill WAL durability, no complete persistence guarantees, no production deployment. No final vendor/architecture selection beyond this MVP; broader S8 remains open. Not production-ready full synchronization.
> **Implementation validation**: final current-worktree validation passed for the exact worktree code surface (pinned Node v24.11.1 / pnpm 10.27.0): fresh `pnpm build` exit 0; `pnpm test:e2e tests/e2e/specs/sync/sync-two-profiles.spec.ts` exit 0 with 2 passed (strengthened exact message/topic/block payload assertions); one canonical `pnpm build:check` exit 0 (lint/typecheck/i18n/format/openapi pass; full test suite 7690 passed, 3 skipped, 0 failed) — limited MVP evidence, not full product or E2E/UI regression proof. Audited hardening passed independent audit; earlier-state `pnpm build:check` (11861 passed, 79 skipped, 0 failed) is retained as prior-state evidence only. Strengthened two-profile E2E validates only ensureTopic + appendMessage/message blocks, manual sync, offline backlog/retry, wrong-token failure, and exact-profile cleanup; not complete mutation coverage, E2EE, realtime, hard-kill/WAL-durability/production persistence validation, or full product/UI coverage. Bounded SIGTERM relay restart validated: `scripts/sync-relay/__tests__/serverRestart.test.ts` passed via Node lane (file-backed startup/push/pull, bounded SIGTERM process stop/restart with the same DB, cursor/operation retention, exact owned-PID/root cleanup) — validates only bounded SIGTERM process restart; server CLI has no SIGTERM handler and performs no clean db.close on SIGTERM, so no clean-shutdown, hard-kill WAL durability, complete persistence, production deployment, or final selection claim follows.
> **Authority**: Canonical current product and selection authority for Cherry Chat synchronization (S8). This document governs product target, current-state constraints, balanced selection method, candidate taxonomy, research findings, comparison criteria, spike plan, decision rules, write-amplification gate, open decisions, and lifecycle. Historical documents are [`sync-mvp.md`](./sync-mvp.md) (first-phase boundary proposal) and [`sync-powersync-spike.md`](./sync-powersync-spike.md) (disposable PowerSync experiment) — both now historical records, not active design inputs.
> **Decision locks (durable IDs)**: SYNC-S8-001 … SYNC-S8-006 (§11).
> **Related governance**: [Application Identity ADR](./cherry-chat-application-identity.md) (identity, compatibility, updater/release freeze, platform scope), [SQLite migration governance](./sqlite-migration.md) (SQLite chat authority, L2 ZIP import, migration process), [Context window governance](./context-window.md) (stable anchor, allowed transitions), [Architecture Evolution Program](./architecture-evolution-program.md) Phase 8 (program-level S8 definition and ARCH-003..006 interpretation). This document does not change those governance boundaries.
> **Limitations (MVP slice)**: post-commit capture crash window; manual-only operation with no realtime/background sync; unsupported compound/segment/purge/ownership/reset paths; no E2EE/accounts/pairing; no attachments/binary/`file_path`/FTS/UI/context sync; incomplete chat mutation coverage with LWW only (see §10, program §6.9, and `src/main/services/sync/chatDbHook.ts`); reference relay is non-production with no SIGTERM handler and no clean db.close on SIGTERM (bounded SIGTERM process restart only; no hard-kill WAL durability, no complete persistence guarantees, no production deployment); bounded two-profile E2E plus bounded SIGTERM relay restart spike only (see Implementation validation) — no full product/UI coverage.
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

## 2. Current-state constraints vs changeable design choices

### 2.1 Constraints that remain until an approved S8 decision and migration (SYNC-S8-002)

These are implemented reality, not target design, and remain authoritative until S8 documents a selected architecture and an ADR-governed migration:

- **Electron Main owns chat SQLite** (`Data/chat.db` via `ChatDbAggregateService`). Renderer never holds a SQLite connection; all chat access is through typed IPC. This is the sole runtime chat authority.
- **Only stable/final persisted checkpoints are sync candidates.** Transient streaming token updates are not sync events. The distinction is architectural (SYNC-004 lineage).
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

## 4. Candidate taxonomy and shortlist (SYNC-S8-004)

### 4.1 Formal finalists for equal-scenario validation (first spike set)

| Candidate | Stack | Selection relevance |
|---|---|---|
| **C1 — PowerSync complete stack** | Source DB + PowerSync Service + developer upload/auth connector + PowerSync-managed client SQLite | Mature realtime/offline/checkpoint machinery; managed client storage; requires new realistic spike to assess no-account pairing, E2EE, and actual Electron + FTS fit (see §5.1). |
| **C2 — cr-sqlite + relay** | SQLite CRDT extension (`cr-sqlite`) with change capture/merge + application relay | SQLite-native CRDT capture/merge; requires native extension packaging, relay design, derived FTS treatment, schema adaptation, and maturity/performance verification (see §5.2). |
| **C3 — Cherry Chat application operation-log + relay** | Current SQLite preserved; application-level operation log preserving compound business intent + relay | Preserves current DB and business-intent granularity; places protocol correctness, snapshots/GC, conflict handling, and relay maintenance entirely on Cherry Chat (see §5.3). |
| **C4 — Turso Database + Turso Database Sync** | Turso Database + Turso Database Sync (logical-statement sync with last-push-wins at documented statement level) + Turso Cloud or local sync server (local server documented for development/testing); libSQL and embedded replicas are separate comparison context, not Database Sync | SQLite-compatible Turso Database engine with logical-statement sync; requires engine/FTS migration (Turso FTS is Tantivy-powered via `USING fts` / `fts_match` — distinct from SQLite FTS5), deployment-mode validation, and exact conflict granularity validation for Cherry Chat scenarios (see §5.4). |

All four enter S8 spikes on equal scenarios (§6) with equal evidence standard. No winner is preselected.

### 4.2 Conditional fallback (CRDT/document-model family)

| Candidate | Condition to activate |
|---|---|
| **CF — Automerge Repo** | Activated only if S8 evidence shows the CRDT/document-model family materially outperforms the four formal finalists on the four dimensions, or if no formal finalist reaches a balanced acceptable outcome. Automerge Repo represents the CRDT/document-model family for that contingency; it is not part of the first spike set. |

### 4.3 Deferred from the first spike set (not banned, with specific fit rationale)

| Candidate | Deferral rationale (specific, not "merely heavy") |
|---|---|
| **ElectricSQL / RxDB / CouchDB-family** | **Mismatched read-path or storage-authority models**: log/read-path shapes or storage layering that conflict with Main SQLite authority and windowed/closure read contracts (see §5.5). |

Deferred candidates are not permanently banned. A future explicit decision can promote a deferred candidate with a new four-field contract if its documented fit changes or if formal finalists fail.

## 5. Documented research findings with primary sources

> Findings are documented constraints and capabilities, not production-readiness claims. Each candidate requires a bounded spike (§7) before any selection.

### 5.1 PowerSync

- **What it buys**: Mature checkpoint/realtime/offline machinery with sync rules and managed client SQLite, including offline queue and checkpoint replay.
- **What it costs**: Architecture is source database + PowerSync Service + developer-owned upload connector and authentication service; client storage is PowerSync-managed (managed tables are JSON-backed views over `ps_data_*`; raw tables via `withRawTables`/`rawTableToJson` are the path for custom indexes/triggers/FTS).
- **Discovered constraint (reproducible, 2026-08-16, `@powersync/common@2.1.0` / `@powersync/node@0.21.0`, `better-sqlite3@12.11.1`, disposable harness — see historical [`sync-powersync-spike.md`](./sync-powersync-spike.md) §5)**: Managed tables reject custom FTS5/trigger/index creation, reject bare duplicate `INSERT` on logical id, and do not support `ON CONFLICT DO UPDATE` on the view; raw tables restore CRUD capture but external SQLite connections cannot inject syncable writes without the PowerSync-registered `powersync_in_sync_operation()` / `powersync_strip_subtype()` functions. Production FTS/trigger coexistence requires raw-table migration and write-path change — a material production change, not a spike workaround.
- **Open for new spike**: No-account pairing and device-trust flow with PowerSync's auth/upload pieces, E2EE layering over PowerSync's TLS/at-rest, actual Electron packaging of `libpowersync`, and FTS coexistence under raw tables must be validated in a realistic service-connected spike. Prior No-Go was constraint-specific under zero-production-change scope (see historical [`sync-powersync-spike.md`](./sync-powersync-spike.md) §5 and [Architecture Evolution Program](./architecture-evolution-program.md) §9.6) — it is evidence for re-evaluation, not a permanent ban.
- **Primary sources**: [PowerSync docs — Architecture overview](https://docs.powersync.com/architecture/architecture-overview) · [PowerSync Service](https://docs.powersync.com/architecture/powersync-service) · [Sync rules](https://docs.powersync.com/sync/rules/overview) · [Client SDK / offline-first](https://docs.powersync.com/client-sdks/overview) · [Raw tables — bypass JSON view limitations](https://docs.powersync.com/client-sdks/advanced/raw-tables) · [@powersync/node on npm registry](https://registry.npmjs.org/%40powersync%2Fnode) · [PowerSync GitHub — powersync-js](https://github.com/powersync-ja/powersync-js)

### 5.2 cr-sqlite

- **What it buys**: SQLite extension that captures row-level changes as CRDT state and merges via Causal-Length-Vector clocks; local-first merge without a heavyweight service for capture semantics.
- **What it costs**: Native SQLite extension must be packaged for Electron (ABI lane `better-sqlite3` interaction, `libcr-sqlite` loading), relay still required for cross-device dissemination, derived FTS content needs separate treatment (external-content or post-merge rebuild), schema must expose CRDT-friendly keys, and maturity/performance on large histories needs verification.
- **Primary sources**: [cr-sqlite GitHub](https://github.com/vlcn-io/cr-sqlite) · [vlcn.io — cr-sqlite docs](https://vlcn.io/docs/cr-sqlite/intro) · [cr-sqlite — Installation / Electron notes](https://vlcn.io/docs/cr-sqlite/installation)

### 5.3 Application operation-log + relay (custom)

- **What it buys**: Current SQLite and Drizzle layer preserved; operation log preserves compound business intent (create/edit/delete/reorder/branch vs raw row diffs); maximal fit to existing data characteristics.
- **What it costs**: All protocol correctness, snapshot/GC, history retention, conflict handling, idempotence/atomicity of replay, and relay operation are owned by Cherry Chat. No external sync vendor absorbs those concerns.
- **Primary sources**: Internal architecture (current `ChatDbAggregateService`, `MessagesRepository`, `sort_order` dense ordering, topic/segment model) — no external sync vendor docs apply; correctness and performance are proved only by S8 spike evidence.

### 5.4 Turso Database + Turso Database Sync — formal finalist C4

- **What it buys**: **Turso Database + Turso Database Sync** provides **logical-statement synchronization with last-push-wins** handling; pull performs atomic rollback to last synced state, applies remote changes, then replays unpushed local changes on top (see conflict resolution). Embedded replicas are a **distinct read-oriented replica pattern**, not Database Sync — mentioned only as separate comparison context.
- **What it costs**: Engine is **Turso Database** (SQLite-compatible; Tantivy-powered FTS via `USING fts` / `fts_match` — distinct from SQLite FTS5) — adopting it replaces the SQLite engine surface area; this is a cost, not an automatic eliminator. **libSQL** (SQLite fork) and **embedded replicas** (read replica pattern) are **separate comparison context**, not Database Sync. Officially documented deployment modes are **Turso Cloud** and **local sync server for development/testing** (the local sync server is documented for development/testing); production self-hosted/other deployment readiness is an **S8-SP4 validation unknown**. Deployment maturity is a co-equal dimension (D), not an automatic eliminator.
- **Open for S8-SP4**: Exact **conflict granularity** (row vs logical-statement vs whole-database) and **compound transaction implications** for Cherry Chat's dense `sort_order`, FTS/trigger coexistence, `file_references.file_path` isolation, tombstone, and hard-delete cascade are **unknown to test** and require S8-SP4 validation. Current official evidence establishes logical-statement synchronization with last-push-wins at the documented statement level — it does **not** justify claiming the last push overwrites the whole database. Whether production self-hosted deployment is viable beyond Turso Cloud and development/testing local sync server is likewise **unknown to test**.
- **Primary sources**: [Turso Database — introduction](https://docs.turso.tech/introduction) · [Turso Database — Full-Text Search (Tantivy)](https://docs.turso.tech/sql-reference/functions/fts) · [Turso — Sync usage (Database Sync)](https://docs.turso.tech/sync/usage) · [Conflict resolution — last push wins at statement level](https://docs.turso.tech/sync/conflict-resolution) · [Local sync server — development/testing](https://docs.turso.tech/sync/local-sync-server) · [Embedded replicas — read replica pattern (separate comparison context)](https://docs.turso.tech/features/embedded-replicas/introduction) · [libSQL — separate comparison context (SQLite fork, not C4)](https://docs.turso.tech/libsql)

### 5.5 Electric / RxDB / Couch family (deferred)

- **ElectricSQL**: Postgres logical-replication read-path (publication/shapes); storage authority is Postgres, not Cherry Chat's Main SQLite.
- **RxDB / CouchDB-family**: Storage-authority and replication protocol assume their own document store as primary; adapting Cherry Chat's SQLite authority and windowed/closure contracts would require replacing the authority boundary.
- **Primary sources**: [ElectricSQL docs](https://electric.ax/docs/intro) · [Electric GitHub](https://github.com/electric-sql/electric) · [RxDB docs](https://rxdb.info/) · [CouchDB replication docs](https://docs.couchdb.org/en/stable/replication/index.html)

### 5.6 Automerge Repo (conditional fallback — CF)

- **What it buys**: CRDT document model with Repo sync layer; document-centric merge without central DB. Activated only if no formal finalist yields a balanced acceptable outcome or if CRDT/document-model evidence materially outperforms formal finalists.
- **Primary sources**: [Automerge docs](https://automerge.org/docs/) · [Automerge Repo GitHub](https://github.com/automerge/automerge)

## 6. Equal-scenario comparison criteria

All finalists are compared on **the same fixed scenarios** so results are commensurable. Scenarios are evaluated through all four dimensions (§3), with privacy-safe, isolated evidence where measurement applies.

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

## 7. Bounded four-spike plan (S8-SP1 … S8-SP4)

Four bounded spikes, one per formal finalist, executed under equal scenarios (§6) and the write-amplification gate (§9). Each spike is **documentation/research only**: disposable harness, synthetic DB, no production dependency or schema, evidence retained as docs. No winner is selected until all four report.

> **MVP implementation note (2026-09-03)**: Spike S8-SP3 path `application operation-log + relay` has an **MVP implementation slice** at `cef4689726` with **audited hardening** at `6b40834971` (see Status and §6.9) plus **strengthened bounded two-profile E2E validated for the exact current worktree** (`tests/e2e/specs/sync/sync-two-profiles.spec.ts`, 2 passed after a fresh build with strengthened exact message/topic/block payload assertions; scope bounded to ensureTopic + appendMessage/message blocks, manual sync, offline backlog/retry, wrong-token failure, exact-profile cleanup) plus **bounded SIGTERM relay restart spike** (`scripts/sync-relay/__tests__/serverRestart.test.ts` passed via Node lane; file-backed startup/push/pull, bounded SIGTERM process stop/restart with the same DB, cursor/operation retention, exact owned-PID/root cleanup; server CLI has no SIGTERM handler and performs no clean db.close on SIGTERM; no hard-kill WAL durability, no complete persistence guarantees, no production deployment). This is a limited manual HTTP relay slice — not the full spike matrix and not a final vendor selection. Broad S8 selection remains open alongside the MVP slice; other finalists remain as remaining formal/selective future alternatives.

| Spike | Candidate | Bounded scope | Isolated harness | Entry gate | Exit: documented evidence |
|---|---|---|---|---|---|
| **S8-SP1** | PowerSync complete stack | Service-connected realistic spike: source DB + PowerSync Service (disposable instance) + developer upload/auth connector + Electron client with raw tables + pairing flow + TLS baseline + E2EE framing as overlay (TLS/at-rest/E2EE distinguished) | Disposable branch, disposable DB/profile, dependencies isolated from production `package.json`/lockfile, no real user data, no production import, `better-sqlite3` via lane-managed binding | S8 active (this doc) | Managed vs raw table behavior with FTS, Electron packaging, pairing/device-trust flow, idempotence/replay, deployment (hosted vs self-host) — all under SCE-01..08 |
| **S8-SP2** | cr-sqlite + relay | Native extension packaging for Electron + minimal relay + FTS derived treatment + schema adaptation surface | Same isolation as SP1 | S8 active | Extension load on both ABI lanes, relay dissemination, FTS coexistence, merge correctness — all under SCE-01..08 |
| **S8-SP3** | Application operation-log + relay | Op-log schema (outbox/checkpoint/tombstone) as disposable design + relay + replay/apply semantics + snapshot/GC sketch | Same isolation as SP1 | S8 active | Log capture fidelity (compound intent), replay atomicity/idempotence, snapshot/GC, relay maintenance — all under SCE-01..08 |
| **S8-SP4** | Turso Database + Turso Database Sync | Turso Database + Turso Database Sync via Turso Cloud and local sync server (development/testing); production self-hosted/other deployment readiness is S8-SP4 validation unknown; libSQL and embedded replicas are separate comparison context | Same isolation as SP1 | S8 active | Engine/FTS migration surface (Tantivy `USING fts` / `fts_match`), deployment-mode comparison (Turso Cloud vs local sync server for development/testing; production self-hosted unknown to validate), logical-statement last-push-wins granularity and compound transaction behavior, idempotence/replay, pairing/device-trust — all under SCE-01..08 |

**Common spike constraints** (all four):

- Disposable branch, disposable DB/profile, no production code/schema/IPC/migration, no real user data.
- Synthetic or fixture data only; no raw DB size, path, content, or credential in evidence.
- Each spike states tested versions and date, isolation scope, and disposal disposition (harness removed, evidence retained as docs).
- Four-field evidence contract required per spike (named decision/outcome, claim, minimum sufficient method, stopping condition) before execution counts as progress.
- No threshold, baseline, SLA, or capacity policy is adopted from spike evidence.

## 8. Decision rules

- **Balanced qualitative judgment** across four dimensions (§3) with equal standing. No arbitrary numeric scores or weights.
- **No demotion for weight alone and no dismissal of complexity.** A heavier candidate can win if it is materially better in sync effect and data-characteristics fit and the team explicitly accepts the dev/maintenance and deployment cost.
- **Equal-scenario comparability.** A candidate is judged only on the fixed SCE-01..08 matrix; partial scenario coverage does not support selection.
- **Constraint-specific No-Go ≠ permanent ban.** The historical PowerSync No-Go was a zero-production-change constraint result. It is evidence for S8-SP1 re-evaluation, not a preselection against PowerSync. Similarly, deferred candidates (Electric/RxDB/Couch) are not scored down for weight; they are deferred for specific fit gaps (§4.3) and can be promoted under the fallback rule.
- **Fallback activation.** Automerge Repo (CF) is activated only if no formal finalist yields a balanced acceptable outcome or if CRDT/document-model family evidence materially outperforms formal finalists on the four dimensions. Promotion of a deferred candidate requires a new explicit decision with four-field contract.
- **Selection, not adoption.** Spike Go means "worth selecting among finalists," not production readiness. The final S8 selection documents the winner, accepted trade-offs, and residual risks; production authorization is a separate governed step.

## 9. DB write-amplification gate (SYNC-S8-006 lineage)

No DB-health optimization is proven ready-now. The following are **S8 design gates**, not pre-selection thresholds:

- **Dense `sort_order` O(N) shift** on middle/batch insert (M1 lineage) and **long/batch transaction write amplification** must be measured **after each candidate's actual replay/apply model is defined** — each candidate replays operations differently (row-state apply vs CRDT merge vs op-log replay), so amplification is model-dependent.
- Each spike (S8-SP1..SP4) includes a bounded write-amplification probe on its own replay path using synthetic isolated DBs, with `WAL checkpoint` normalization and read-only metric collection (no production data, no physical DB size claim beyond synthetic proxies).
- Results are directional decision evidence. They gate S8 design acceptance, not earlier phases, and do not become thresholds/SLAs.

## 10. Open decisions (remain open until S8 evidence supports them)

These are not resolved by this document and must not be silently assumed by any spike or implementation:

- **E2EE details**: Whether E2EE is introduced, at what granularity (per-device, per-topic, per-message), key agreement and storage, and how it layers over TLS and at-rest encryption. TLS for transport and at-rest service encryption are distinct from E2EE and must not be conflated.
- **Conflict policy per operation**: Per-operation merge rules for create/edit/delete/reorder/branch/answer-selection/segment/trash — last-write-wins, server-canonical, CRDT merge, or block-level final-consistency.
- **Attachment payload scope**: Whether binary attachment payloads are synchronized, Inline vs reference, size bounds, and storage for attachments.
- **Recovery and rotation**: Device loss/recovery, key rotation, unpairing, and re-pairing semantics.
- **Exact service implementation**: Relay/service topology, hosting options, upgrade and backup of the sync service, and auth material lifecycle.
- **Final vendor selection**: No candidate is selected by this document; selection follows equal-scenario evidence (§6–§8).

Non-goals confirmed: Vendor commitment, privacy-policy change, production schema/migration, and production sync path remain non-goals until S8 selection is documented and governed.

## 11. Decision table (durable IDs)

| # | Decision | Status |
|---|---|---|
| **SYNC-S8-001** | Product target is **Syncthing-like local-first sync; no Cherry Chat account; device pairing; users connect to one selected compatible sync service (online or self-hosted/local)**. Device pairing/trust is distinct from an account system and described separately. | **Locked** |
| **SYNC-S8-002** | **Current-state baseline preserved until approved S8 decision and migration**: Electron Main SQLite is chat runtime authority; only stable/final persisted checkpoints are sync candidates; transient streaming and all currently excluded local/derived/sensitive domains (credentials, derived FTS, Redux UI state, `contextWindowAnchor`, Knowledge/Memory/Trace, binary attachments, device-local `file_path`, import and backup artifacts) are not silently synchronized. Architecture may change only via S8 documented selection and governed migration. | **Locked** |
| **SYNC-S8-003** | **Balanced four-dimension selection**: sync effect/UX, fit to current data characteristics, dev/maintenance difficulty, deployment/configuration difficulty are **co-equal**; no candidate is demoted merely for being heavier, and complexity is not dismissed. | **Locked** |
| **SYNC-S8-004** | **Candidate taxonomy and first spike set**: Formal finalists are **PowerSync complete stack, cr-sqlite + relay, application operation-log + relay, Turso Database + Turso Database Sync** validated on equal scenarios; **Automerge Repo** is a conditional fallback (CF) for the CRDT/document-model family; **Electric/RxDB/Couch** are deferred for mismatched read-path/storage-authority models. Turso Database engine/FTS migration and deployment maturity are costs, not automatic eliminators; Turso conflict granularity, compound transaction behavior, and production self-hosted deployment readiness are unknown to test and require S8-SP4. | **Locked** |
| **SYNC-S8-005** | **S8 Selection Validation is active; documentation/research only; no implementation authorization, except for the explicitly user-authorized limited MVP exception at `cef4689726` plus audited hardening at `6b40834971` (application operation-log + thin HTTP relay, limited validation, not production-ready); all broader S8 implementation remains unauthorized/open.** Entry is met by user activation of S8; exit requires selected architecture documented, four-dimension trade-offs and residual risks accepted, and readiness validated. | **Locked** |
| **SYNC-S8-006** | **DB write-amplification gate**: Dense `sort_order` O(N) shift and long/batch transaction write amplification are **measured after each candidate's actual replay/apply model is defined**, as S8 design gates. No proven ready-now DB-health optimization; results are directional decision evidence, not thresholds. | **Locked** |

Historical locks SYNC-001…004 and SPIKE-001…010 remain as historical evidence in [`sync-mvp.md`](./sync-mvp.md) and [`sync-powersync-spike.md`](./sync-powersync-spike.md); they are not re-locked here except as superseded lineage.

## 12. Governance and validation requirements

- **This document is documentation/research only, except for the explicitly user-authorized MVP slice** at `cef4689726` plus audited hardening at `6b40834971` (limited validation, not production-ready full sync). Any further production change requires a separate governed decision (ADR for schema/migration, coordinated review for IPC/preload/shared contracts, per evidence-task contract for measurement). The MVP slice does not change application identity, release, platform, or SQLite migration governance.
- **Spike validation**: Each S8-SP requires evidence-task four-field contract (named decision/outcome, claim, minimum sufficient method, stopping condition). Harness completeness alone never closes validation; privacy safeguards (no content/credential/path/raw DB size) are mandatory. MVP slice validation is limited (audited hardening + final current-worktree `pnpm build` exit 0 + strengthened two-profile E2E 2 passed with exact message/topic/block payload assertions + one canonical `pnpm build:check` exit 0 for the exact worktree code surface per Status plus bounded SIGTERM relay restart spike per Status; no full product/UI regression proof; relay restart is bounded SIGTERM process restart only with no SIGTERM handler/db.close, no hard-kill WAL durability, no production deployment) — see Status.
- **No E2EE/account/attachment/vendor claim** without S8 evidence. TLS, at-rest encryption, and E2EE are distinguished.
- **No readiness or final vendor claim** beyond the implemented MVP route without equal-scenario evidence across all four formal finalists. PowerSync/Turso/cr-sqlite remain as remaining formal/selective future alternatives unless current docs already say otherwise.
- **Architecture Evolution Program Phase 8** owns program-level S8 definition and ARCH-003..006 interpretation; this document owns sync product/selection detail.

## 13. Document lifecycle

- **Canonical**: This document (`docs/sync-architecture-selection.md`) is the sole current product/selection authority for sync. All new sync work reads this document before any historical file.
- **Historical — retained, not deleted**:
  - [`docs/sync-mvp.md`](./sync-mvp.md) — Historical notice/record. Its Phase 0/1 proposal, open-question framing, and vendor-open stance are superseded by this document. Retained for audit of prior locks (SYNC-001…004), data-scope exclusions, authority/projection concepts, and conflict-matrix inventory.
  - [`docs/sync-powersync-spike.md`](./sync-powersync-spike.md) — Historical experiment record. Retained for reproducible material facts (versions, isolation scope, managed/raw-table findings, disposed harness, constraint-specific No-Go). It is evidence for re-evaluation (S8-SP1), not a permanent ban.
- **No implementation authorization** flows from either historical document. Any citation of them as authoritative design input for new work is stale.
- History is preserved in Git; this file replaces only current authority, not historical evidence.

---

## 14. References

- [Architecture Evolution Program](./architecture-evolution-program.md) — Phases, ARCH-003..006, debt, triggers.
- [SQLite migration governance](./sqlite-migration.md) — SQLite chat authority and migration process.
- [Context window governance](./context-window.md) — Stable topic context anchor.
- [Application Identity ADR](./cherry-chat-application-identity.md) — Identity, compatibility, platform, release.
- Historical: [Sync MVP (historical)](./sync-mvp.md) · [PowerSync spike (historical)](./sync-powersync-spike.md)
- External primary sources cited in §5 (PowerSync, cr-sqlite, Turso Database / Turso Database Sync, libSQL as separate comparison context, Electric, RxDB, CouchDB, Automerge/Automerge Repo).

*End of canonical S8 selection document.*
