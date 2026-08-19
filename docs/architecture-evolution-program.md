# Architecture Evolution Program — Cherry Chat Long-Term Structural Correctness

> **Document status**: **Approved Strategy (program-level)**. This document owns the architecture evolution program: strategic intent, approved locks, target qualities, debt registry, phased evolution, and decision triggers. It is not an ADR; it does not create new governance authority for identity, release, platform, SQLite migration, or context-window governance — those remain authoritative in their existing documents.
> **Authority boundary**: Architecture correctness, elegance, unity, and long-term evolvability lead. Performance symptoms expose architecture debt; performance remains validation evidence, not the sole design objective. Future startup speed and bounded memory are architecture enablement goals. Sync is future compatibility only, vendor-neutral, and must adapt to the application architecture — never the reverse.
> **Relation to current architecture reference**: [`architecture.md`](./architecture.md) describes implemented reality only. This program describes the target evolution path. The two must not be confused; `architecture.md` must not be edited to describe unimplemented target state.
> **Last updated**: 2026-08-19
> **Owner**: Architecture evolution program (cross-cutting)

---

## 1. Status, Authority, and Responsibility

### 1.1 What this document is

This is the canonical architecture evolution program for Cherry Chat. It:

- Establishes strategic intent and approved locks (`ARCH-*` prefix).
- Defines target architecture qualities without premature implementation decisions.
- Maintains a debt registry grounded in existing evidence.
- Lays out phased evolution with dependency relationships.
- Provides decision trigger maps and cross-document ownership.

### 1.2 What this document is not

- **Not an ADR**: It does not lock identity, release, platform, SQLite migration, context-window, or compatibility governance. Those remain in their existing authoritative documents.
- **Not an implementation plan**: Phases describe evolution directions and dependencies, not authorized work items. No phase is authorized for implementation unless explicitly approved.
- **Not a performance document**: Performance evidence feeds into this program when it exposes structural debt; this program does not own performance validation.

### 1.3 Relationship to existing documents

| Document | Role | Relationship to this program |
|---|---|---|
| [`architecture.md`](./architecture.md) | Implemented architecture reference | Describes current reality only; this program describes target evolution |
| [`performance-program.md`](./performance-program.md) | Performance methodology entry | Performance evidence feeds into this program when structural debt is exposed |
| [`performance-measurement.md`](./performance-measurement.md) | Measurement contract | Unchanged; remains the measurement authority |
| [`performance-workstreams.md`](./performance-workstreams.md) | Current actionable performance state | Product problems reference this program for architecture acceptance |
| [`sync-mvp.md`](./sync-mvp.md) | Sync first-phase boundary | Sync must adapt to this program; never the reverse |
| [`sync-powersync-spike.md`](./sync-powersync-spike.md) | PowerSync No-Go record | Vendor-specific No-Go; not a target architecture constraint |
| [`sqlite-migration.md`](./sqlite-migration.md) | SQLite chat authority governance | Remains authoritative; schema changes require ADR |
| [`context-window.md`](./context-window.md) | Context window governance | Remains authoritative; anchor semantics unchanged |
| [`cherry-chat-application-identity.md`](./cherry-chat-application-identity.md) | Identity/compatibility/release/platform governance | Remains authoritative; not modified by this program |

---

## 2. Strategic Intent and Approved Locks

### 2.1 Strategic intent

Application architecture correctness, elegance, unity, and long-term evolvability lead. The application should be structured so that:

- Authority boundaries are clear and stable.
- Components have single, well-defined responsibilities.
- Changes propagate through explicit, typed contracts.
- New capabilities (including future sync) can be added by extending seams, not by restructuring foundations.

Performance symptoms (topic switch latency, streaming cadence, echo delay) expose architecture debt. Performance remains validation evidence — when a performance fix requires changing ownership, lifecycle, or data contracts, it enters this program as architecture evolution, not as a performance patch.

### 2.2 Approved locks

| Lock | Statement | Status |
|---|---|---|
| **ARCH-001** | Architecture correctness, elegance, unity, and long-term evolvability lead. Performance is validation evidence, not the sole design objective. | **Locked** |
| **ARCH-002** | Future startup speed and bounded memory are explicit architecture enablement goals — they influence phase prioritization but do not override correctness. | **Locked** |
| **ARCH-003** | Sync is future compatibility only and vendor-neutral. Sync architecture/technology must adapt to the application architecture, never the reverse. | **Locked** |
| **ARCH-004** | PowerSync remains No-Go (see [`sync-powersync-spike.md`](./sync-powersync-spike.md)). Target architecture must not be optimized for or constrained by PowerSync. | **Locked** |
| **ARCH-005** | Sync-ready means preserving good structural properties only: clear authority, stable IDs, typed explicit commands, atomic/idempotent mutations, deterministic ordering, stable/final checkpoints, disposable projections, bounded caches, device-local-state separation. | **Locked** |
| **ARCH-006** | No sync schema, metadata, tombstone, conflict engine, vendor adapter, transport, account/E2EE/attachment decision, or production sync path is authorized by this program. | **Locked** |
| **ARCH-007** | Main SQLite authority and existing identity, SQLite migration, context-window, compatibility, and release/platform governance remain authoritative until separate decisions. | **Locked** |
| **ARCH-008** | Existing `architecture.md` must describe only implemented reality, not target architecture. | **Locked** |

---

## 3. Target Architecture Qualities

These are the structural qualities the evolution program aims to establish. They are qualities, not implementation decisions — specific technologies, state libraries, or schema designs are not locked here.

### 3.1 Clear authority boundaries

- One authoritative owner per data domain (chat: Main SQLite; config/projection: renderer Redux; file catalog: renderer Dexie).
- No dual-state authority. Projection state that duplicates authority is a bug class, not a feature.
- Authority never transfers implicitly through a new capability (e.g., sync must not create a second chat authority).

### 3.2 Typed explicit contracts

- IPC contracts are the only cross-process boundary. Both sides compile against the same shared contract.
- Commands are explicit and typed: the intent is visible in the channel name and payload, never implicit in state mutation.
- Changes to contracts require coordinated edits on both sides.

### 3.3 Atomic and idempotent mutations

- Database writes are atomic (transactional) and idempotent where possible.
- Retry, reconnection, and recovery paths produce the same result as the original operation.
- This property directly enables future sync compatibility (checkpoint replay, idempotent merge).

### 3.4 Deterministic ordering

- Message and block ordering uses a stable, deterministic sort key (currently dense `sort_order`).
- Ordering operations are explicit: append (O(1) fast path), insert-at (O(N) currently), reorder (explicit swap).
- Ordering is never derived from implicit insertion order or timestamps alone.

### 3.5 Stable and final checkpoints (target compatibility boundary; partially established)

- Current local streaming persistence may include intermediate states under existing behavior. The architecture must establish a clear distinction: only stable/final block states are eligible as future sync candidates (SYNC-004).
- Checkpoints are well-defined boundaries: completion of a message block, final answer selection, topic structure change.
- This property directly enables sync: only checkpoints need cross-device coordination. The boundary between transient intermediate state and stable checkpoint is a target quality to be explicitly enforced, not yet a fully implemented persistence invariant.

### 3.6 Disposable projections

- Renderer-side computed state (viewport projections, display groups, context info) is derived and disposable.
- Projections can be rebuilt from authority without data loss.
- Projection state must not be treated as authoritative — it may be stale, cached, or optimistic.

### 3.7 Bounded caches

- Caches (renderer memo, topic cache, context window) have clear invalidation rules and size bounds.
- Cachemiss paths are explicit and measurable.
- Cache state is not authoritative — it is a performance optimization over authority.

### 3.8 Device-local-state separation

- Per-device state (user profile, local file paths, local preferences) is clearly separated from shareable state.
- This separation enables future sync without leaking device-specific data.

---

## 4. Architecture Debt Registry

Debt items are classified as:
- **Observed structure**: A concrete structural property observed in the codebase.
- **Candidate consequence**: A potential impact inferred from the observed structure (not proven root cause).
- **Open decision**: A choice that must be made before the debt can be resolved.

### 4.1 Conversation lifecycle and ownership

| Item | Classification | Evidence |
|---|---|---|
| Topic switch traverses full Main load + IPC + full renderer recomputation | Observed structure | PERF-TOPIC-SWITCH cost model; `loadTopicMessagesThunk` → `dbService.fetchMessages` full load |
| No lazy activation of conversation components | Observed structure | All conversation components mount eagerly on topic switch |
| O(N) full-topic computation per reconciliation (group model, context info, viewport) | Observed structure | `computeContextInfo`, `createLatestMessageWindow`, `reconcileMessageWindow` |
| Potential benefit of conversation lifecycle refactoring for startup/memory | Candidate consequence | Lazy activation and bounded state depend on conversation refactoring (§7) |

### 4.2 Data access patterns

| Item | Classification | Evidence |
|---|---|---|
| Full-topic message/block fetch on every topic switch (no incremental/paginated load) | Observed structure | `listByTopic` + `listByMessages` in `dbService.fetchMessages` |
| No windowed/paginated fetch for visible messages only | Observed structure | All messages loaded regardless of `displayCount` |
| Full context info recomputation on every render cycle | Observed structure | `computeContextInfo` runs on `[topic messages, topic blocks, assistant, topic id]` memo identity |
| Whether windowed fetch + cache joins would reduce load | Open decision | Requires data-access phase study; not proven |

### 4.3 DB health

| Item | Classification | Evidence |
|---|---|---|
| Short (<3 codepoint) queries fall through to LIKE full-table scan | Observed structure | `SearchRepository.ts` `collectCandidates`/`likeCandidates` |
| Dense sort_order O(N) shift on middle/batch insert | Observed structure | `MessagesRepository.ts` `insertAt`/`insertManyAt` |
| FTS content stored redundantly in `message_blocks_normalized` + `message_blocks_fts` | Observed structure | migration 003/004 FTS architecture |
| File dual-state (Main SQLite + renderer Dexie) consistency | Candidate consequence | `FileReferencesRepository.ts` + `attachmentAvailability.ts` |
| Whether specific index/query optimizations would measurably improve | Open decision | Requires M1/M2/M3 diagnostic measurement (§6) |

### 4.4 Streaming and rendering

| Item | Classification | Evidence |
|---|---|---|
| 50ms cadence throttle is the primary streaming cadence limiter | Candidate consequence | PERF-STREAMING cadence evidence |
| `key={activeTopic.id}` triggers full subtree remount on topic switch | Observed structure | Static analysis; PERF-RENDER-FLOW candidate A |
| Per-message/per-block Redux subscriptions cause granular re-render | Observed structure | PERF-RENDER-FLOW candidate C |
| Markdown parse CPU contribution unknown | Open decision | No direct parse-CPU measurement exists |

### 4.5 Identity and compatibility

| Item | Classification | Evidence |
|---|---|---|
| Source-format identifiers (Dexie name, redux-persist key, ZIP schema) are compatibility contracts | Observed structure | Application Identity ADR; `architecture.md` §Source Compatibility Boundary |
| Protected default profile names enforce startup guard | Observed structure | Application Identity ADR |

---

## 5. Natural Scope and Explicit Non-Goals

### 5.1 In scope

- Architecture correctness, elegance, unity, and long-term evolvability.
- Structural debt identified through performance evidence, code analysis, or design review.
- Evolution phases that improve authority boundaries, contract clarity, or component lifecycle.
- Startup speed and bounded memory as architecture enablement goals.
- Sync-readiness as structural property preservation.

### 5.2 Explicit non-goals

- **No implementation authorization**: This program does not authorize any code changes, branches, or implementation work.
- **No technology selection**: No specific state management library, sync vendor, transport protocol, or schema design is locked.
- **No performance thresholds**: This program does not set or validate performance thresholds — that remains in the performance measurement contract.
- **No sync implementation**: No sync schema, metadata, tombstone, conflict engine, vendor adapter, transport, account/E2EE/attachment decision, or production sync path.
- **No governance changes**: Identity, SQLite migration, context-window, compatibility, release/platform governance remain in their existing authoritative documents.
- **No root AGENTS.md changes**: Agent guide changes are a separate authoring task.

---

## 6. Phased Architecture Evolution

Phases have dependency relationships but must not pretend all are sequential or approved for implementation. Each phase has entry criteria, content, and exit criteria. No phase is active unless explicitly approved.

### Phase 1: Governance and Debt Map

**Entry criteria**: None (this phase is documentation/analysis).
**Content**:
- Establish the architecture evolution program (this document).
- Catalog structural debt with evidence classification.
- Define target qualities and decision triggers.
- Map dependencies between debt items and evolution phases.

**Exit criteria**: Approved program document with debt registry, qualities, and phase dependency map.
**Dependencies**: None.
**Status**: Complete (this document).

### Phase 2: Conversation Ownership and Lifecycle

**Entry criteria**: Phase 1 complete; explicit approval for conversation lifecycle study.
**Content**:
- Define conversation component ownership model: which components own which state, lifecycle, and subscriptions.
- Establish clear boundaries between Main-process authority, renderer projection, and preload capability surface.
- Identify lazy activation boundaries: which components can be deferred until needed.
- Map the conversation lifecycle from topic selection through first render, streaming, completion, and topic switch.

**Exit criteria**: Documented ownership model with lazy activation boundaries; no code changes until explicit approval.
**Dependencies**: Phase 1 complete.
**Provenance note**: The Phase 2A/2B labels in `performance-workstreams.md` refer to pre-program historical renderer-boundary measurement and implementation slices (stage attribution instrumentation, shared context projection, window projection deduplication). Those slices are predecessors that produced evidence and partial renderer-side improvements; they do not constitute, satisfy, or authorize architecture Phase 2. Architecture Phase 2 remains incomplete — its exit criteria (documented ownership model with lazy activation boundaries) have not been met.
**Relationship to performance**: PERF-TOPIC-SWITCH and PERF-ECHO are acceptance surfaces for this phase. When conversation ownership/lifecycle changes resolve the structural debt, those product problems may close. Performance evidence drives prioritization; architecture changes are validated by performance outcomes.

### Phase 3: Stable Render/State/Action Graph

**Entry criteria**: Phase 2 ownership model approved; explicit approval.
**Content**:
- Establish a stable, well-defined graph of render dependencies, state subscriptions, and action handlers.
- Reduce unnecessary component remounts and re-renders through structural clarity (not speculative memoization sweeps).
- Stabilize projected array identities and memo boundaries through ownership, not patches.

**Exit criteria**: Documented render/state/action graph with reduced remount blast radius; validated by PERF-TOPIC-SWITCH/PERF-ECHO acceptance criteria.
**Dependencies**: Phase 2 complete.
**Relationship to performance**: This phase supersedes PERF-RENDER-FLOW's tactical candidate queue (A/B/C candidates). The conversation lifecycle refactoring in Phase 2 addresses the root structural causes that the tactical loop could not isolate.

### Phase 4: Bounded Memory and Cache

**Entry criteria**: Phase 2 complete (conversation lifecycle refactoring enables bounded state); explicit approval.
**Content**:
- Establish cache invalidation rules and size bounds for renderer-side caches.
- Define bounded state for conversation components: maximum loaded messages, viewport window bounds, context cache limits.
- Ensure cache-miss paths are explicit and measurable.

**Exit criteria**: Documented cache/memory model with bounds; validated by memory acceptance criteria (bounded renderer state, cache invalidation rules, cache-miss path measurability).
**Dependencies**: Phase 2 complete.
**Startup/memory relationship**: Conversation refactor directly enables lazy activation and bounded state. However, app boot services, Redux rehydration, Dexie initialization, SQLite cold open, bundle loading, and background windows remain separate tracks — they are not blocked by or dependent on conversation lifecycle changes.

### Phase 5: Data-Access Contract

**Entry criteria**: Phase 1 complete; explicit approval; DB-health diagnostics (M1/M2/M3/M7) completed if needed.
**Content**:
- Define the data-access contract: which operations load full topics, which load windows, which are incremental.
- Establish pagination/windowed fetch semantics for visible messages.
- Define cache-join semantics for context info computation.

**Exit criteria**: Documented data-access contract with pagination semantics; validated by topic-switch acceptance criteria.
**Dependencies**: Phase 1 complete; independent of Phases 2-4 but benefits from their structural improvements.
**DB-health sequencing**: M1/M2/M3/M7 are independent diagnostics that can run on demand. Full-topic/windowed fetch/cache joins are part of this phase. M4/M5/M6 require governance/ADR decisions and are not activated by this program.

### Phase 6: DB-Health Implementation

**Entry criteria**: Phase 5 data-access contract approved; governance/ADR for any schema changes (M4/M5/M6).
**Content**:
- Implement data-access contract changes (pagination, windowed fetch, cache joins).
- Address identified index/query opportunities from M1/M2/M3 diagnostics.
- Resolve file dual-state consistency (M5) if proven to be a real issue.
- FTS storage deduplication (M4) if measurably beneficial.

**Exit criteria**: Data-access improvements validated by performance acceptance criteria; schema changes approved via ADR.
**Dependencies**: Phase 5 complete; governance/ADR for schema changes.
**Activation**: Not activated by this program. Requires separate explicit approval.

### Phase 7: Startup Architecture

**Entry criteria**: Phase 2 complete (conversation lifecycle enables lazy activation); explicit approval.
**Content**:
- Implement lazy activation of conversation components.
- Optimize app boot services, Redux rehydration, Dexie initialization, SQLite cold open, bundle loading.
- Address background window lifecycle.

**Exit criteria**: Startup improvements validated by startup acceptance criteria (lazy activation functional, boot service ordering optimized, bundle loading improved). The existing cold-open `<500ms` threshold is owned by the performance measurement contract (`performance-measurement.md` §7), not created by this program.
**Dependencies**: Phase 2 complete for conversation-related startup; app boot services are independent tracks.
**Startup/memory relationship**: This phase addresses startup through both conversation lifecycle (Phase 2 dependency) and independent boot optimization tracks. The boot tracks (Redux rehydration, Dexie, SQLite cold open, bundle loading, background windows) can proceed independently of conversation refactoring.

### Phase 8: Future Sync Decision

**Entry criteria**: Phases 2-5 provide sufficient structural foundation; explicit governance decision to pursue sync.
**Content**:
- Make vendor-neutral sync architecture decisions (cross-device authority, conflict resolution, transport).
- Implement sync-readiness structural properties (ARCH-005) without optimizing for any specific vendor.
- Production sync implementation only after governance approval.

**Exit criteria**: Sync architecture decisions documented; sync-readiness validated against ARCH-005 qualities.
**Dependencies**: Phases 2-5 provide structural foundation; governance approval required.
**PowerSync interpretation**: ARCH-004 (PowerSync No-Go) is vendor/constraint-specific and must not become a target architecture constraint. The target architecture must be vendor-neutral.

---

## 7. DB-Health Sequencing

The DB-health work (PERF-DB-HEALTH in `performance-workstreams.md`) is reclassified according to architecture program dependency splits:

### Independent diagnostics (on demand, require Main/user activation; no schema ADR needed)

| Diagnostic | Scope | Dependencies |
|---|---|---|
| **M1** | Middle/batch insert O(N) sort_order shift — controlled scale curve | None |
| **M2** | Short (<3 codepoint) LIKE full-table scan — S1/S2 corpus attribution | None |
| **M3** | Index/query opportunity — query-plan structural diagnosis | None |
| **M7** | Cold open/load path — DB volume impact attribution | None |
| **M8** | Backup/restore health — L3 archive metadata | None |

These are read-only diagnostic measurements. They do not require governance/ADR approval to run (no schema change involved). However, PERF-DB-HEALTH remains `Planned` — each diagnostic requires explicit Main/user activation before execution (`performance-program.md` §6/§8). They do not activate implementation.

### Architecture-phase-dependent (requires governance)

| Item | Scope | Dependencies |
|---|---|---|
| **Full-topic/windowed fetch/cache joins** | Data-access contract implementation | Phase 5 approved; may require schema awareness |
| **M4** FTS storage deduplication | Volume and write-amplification measurement + potential schema change | ADR for any schema change |
| **M5** File dual-state consistency | Consistency convergence diagnostic | ADR if resolution touches schema or authority boundaries |
| **M6** Sync metadata gap | Schema impact analysis | ADR; analysis only, no schema建 |

---

## 8. Startup/Memory Relationship

Conversation lifecycle refactoring (Phase 2) directly enables:
- **Lazy activation**: Components that currently mount eagerly can be deferred until needed.
- **Bounded state**: Conversation state can be scoped and garbage-collected when topics switch.

However, the following are **separate tracks** that are independent of conversation refactoring:

| Track | Description | Independence |
|---|---|---|
| **App boot services** | Service initialization order and parallelism | Independent; can optimize without conversation refactoring |
| **Redux rehydration** | redux-persist hydration from IndexedDB | Independent; affects initial render latency |
| **Dexie initialization** | IndexedDB schema upgrade and connection | Independent; affects renderer startup |
| **SQLite cold open** | First database open latency (existing `<500ms` threshold in `performance-measurement.md` §7) | Independent; Main-process concern |
| **Bundle loading** | JavaScript bundle size and load time | Independent; build/tooling concern |
| **Background windows** | Trace viewer, import window lifecycle | Independent; can be deferred or preloaded separately |

These tracks may benefit from conversation refactoring but are not blocked by it. They can proceed independently when approved.

---

## 9. Sync Compatibility

### 9.1 Architecture-first, vendor-neutral statement

Application architecture leads. Sync is compatibility — it must adapt to the application architecture, never the reverse. The target architecture is vendor-neutral: it must not be optimized for or constrained by PowerSync (ARCH-004) or any other specific sync vendor.

### 9.2 Sync-ready properties (ARCH-005)

The architecture evolution program aims to establish these structural properties that enable future sync:

| Property | Status | Phase |
|---|---|---|
| Clear authority boundaries | In progress (debt registry) | Phase 2 |
| Stable IDs | Partially established (application-level text/UUID IDs preserved through refactor; cross-device identity/revision is Phase 8 open decision) | Existing + Phase 8 |
| Typed explicit commands | Implemented (IPC channels, ChatDbAggregateService) | Existing |
| Atomic/idempotent mutations | Partially implemented (transactions, INSERT OR REPLACE) | Phase 5/6 |
| Deterministic ordering | Implemented (dense sort_order) | Existing |
| Stable/final checkpoints | Partially established (current local persistence may include intermediate states; target boundary between transient and stable is not yet a fully implemented invariant) | Phase 2/5 |
| Disposable projections | Partially identified (debt registry) | Phase 3 |
| Bounded caches | Not yet bounded | Phase 4 |
| Device-local-state separation | Partially identified (debt registry) | Phase 2 |

### 9.3 Must preserve / should enable / must defer / prohibited

| Category | Items |
|---|---|
| **Must preserve** | Clear authority, typed commands, atomic mutations, deterministic ordering, stable/final checkpoint eligibility boundary |
| **Should enable** | Disposable projections, bounded caches, device-local-state separation |
| **Must defer** | Sync schema, metadata columns, tombstone, conflict engine, vendor adapter, transport, account/E2EE/attachment, production sync path |
| **Prohibited** | Optimizing target architecture for PowerSync; adding sync implementation to this program; creating second chat authority |

### 9.4 Stable checkpoint boundary

Only stable/final block checkpoints are future sync candidates (SYNC-004). Current local streaming persistence may include intermediate states — the architecture must explicitly enforce the distinction between transient intermediate state and stable checkpoint. Only stable checkpoints need cross-device coordination; components must clearly separate transient state from stable checkpoints as a target quality.

### 9.5 JSON `extra` field

The JSON `extra` field on messages/blocks is **not** a chosen sync metadata store. It is a general-purpose extension point. Claiming it as a sync metadata store would be a premature lock. Any sync metadata design must go through the sync decision phase (Phase 8) with proper governance.

### 9.6 PowerSync No-Go interpretation

The PowerSync No-Go (see [`sync-powersync-spike.md`](./sync-powersync-spike.md)) is vendor-specific and constraint-specific:
- It documented that PowerSync's managed-table-as-view architecture conflicted with the current FTS/trigger schema under zero-production-change constraints.
- It must not become a target architecture constraint: the target architecture must not be designed around PowerSync's limitations.
- Future sync decisions must be vendor-neutral and evaluated against the target architecture qualities (§3).

---

## 10. ADR/Decision Trigger Map

### 10.1 When ADR is required

Architecture evolution must stop and trigger an ADR when:

1. A change would move runtime authority (e.g., chat authority leaving Main SQLite).
2. A change would alter persistence or migration semantics.
3. A change would affect lifecycle, multi-window, or native capabilities.
4. A change would modify compatibility semantics (Cherry Studio import, FTS/search correctness, identity identifiers).
5. A change would affect platform or release scope.
6. A performance optimization requires the above changes — ADR first, implementation second.

### 10.2 Decision phases and triggers

| Decision | Trigger | Governance |
|---|---|---|
| Schema changes (FTS, indexes, new columns) | Phase 6 or M4/M5/M6 | SQLite migration governance ADR |
| Sync vendor/transport/account/E2EE | Phase 8 | Separate sync governance |
| Identity/release/platform changes | Any phase | Application Identity ADR |
| Context window anchor semantics | Phase 2 or 3 | Context window governance |
| Conversation ownership model | Phase 2 | This program (architecture evolution) |

### 10.3 Acceptance model

Each phase has acceptance criteria defined in §6. Acceptance requires:
- Documented ownership/quality/contract model.
- Performance validation where applicable (PERF-TOPIC-SWITCH/PERF-ECHO as acceptance surfaces).
- No governance boundary violations.
- Explicit approval for next phase activation.

### 10.4 Open decisions

| Decision | Phase | Status |
|---|---|---|
| Conversation ownership model specifics | Phase 2 | Open (study required) |
| Lazy activation boundaries | Phase 2 | Open (depends on ownership model) |
| Render/state/action graph structure | Phase 3 | Open (depends on Phase 2) |
| Cache invalidation rules and bounds | Phase 4 | Open |
| Windowed fetch semantics | Phase 5 | Open |
| Specific index/query optimizations | Phase 6 | Depends on M1/M2/M3 diagnostics |
| File dual-state resolution | Phase 6 | Depends on M5 diagnostic |
| Sync architecture decisions | Phase 8 | Open (deferred) |

### 10.5 Cross-document ownership

| Concern | Owner document | Program role |
|---|---|---|
| Identity/compatibility/release/platform | `cherry-chat-application-identity.md` | Not modified by this program |
| SQLite chat authority/migration | `sqlite-migration.md` | Not modified; schema changes require ADR |
| Context window anchor semantics | `context-window.md` | Not modified; anchor semantics unchanged |
| Performance methodology/measurement | `performance-program.md` / `performance-measurement.md` | Not modified; performance feeds into this program |
| Sync boundaries/vendor | `sync-mvp.md` / `sync-powersync-spike.md` | Sync must adapt to this program |
| Architecture evolution phases/qualities | **This document** | Owns evolution path; does not own implementation |
| Implemented architecture reference | `architecture.md` | Describes reality only; not modified to show target state |

---

## 11. Related Documents

Cross-document ownership and roles are defined in §10.5 above. For navigation:

- [`architecture.md`](./architecture.md) — Implemented architecture reference (current reality only).
- [`performance-program.md`](./performance-program.md) — Performance methodology entry (feeds into this program).
- [`performance-measurement.md`](./performance-measurement.md) — Measurement contract (unchanged).
- [`performance-workstreams.md`](./performance-workstreams.md) — Current actionable performance state (acceptance surfaces).
- [`sync-mvp.md`](./sync-mvp.md) — Sync first-phase boundary (sync must adapt to this program).
- [`sync-powersync-spike.md`](./sync-powersync-spike.md) — PowerSync No-Go record (vendor-specific, not a constraint).
- [`sqlite-migration.md`](./sqlite-migration.md) — SQLite governance (authoritative, not modified).
- [`context-window.md`](./context-window.md) — Context window governance (authoritative, not modified).
- [`cherry-chat-application-identity.md`](./cherry-chat-application-identity.md) — Identity/compatibility governance (authoritative, not modified).
