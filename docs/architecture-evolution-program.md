# Architecture Evolution Program — Cherry Chat Long-Term Structural Correctness

> **Document status**: **Approved Strategy (program-level)**. Canonical program-level source for architecture intent, approved locks, target qualities, debt registry, phased evolution, and decision triggers. Not an ADR; does not override identity, release, platform, SQLite migration, or context-window governance.
> **Authority boundary**: Architecture correctness, elegance, unity, and long-term evolvability lead. Performance symptoms expose architecture debt; performance is validation evidence, not the sole design objective. Startup speed and bounded memory are enablement goals but do not override correctness (ARCH-002). Sync is future compatibility only, vendor-neutral, and must adapt to application architecture — never the reverse.
> **Relation to current architecture reference**: [`architecture.md`](./architecture.md) describes implemented reality only. This program describes target evolution intent.
> **Last updated**: 2026-08-28 — compressed revision (600-900 line target). Prior detailed history in Git log; no chained provenance header is maintained.

---

## 1. Status, Authority, and Responsibility

### 1.1 What this document is

Canonical architecture evolution program for Cherry Chat. It:

- Establishes strategic intent and approved locks (`ARCH-*`).
- Defines target architecture qualities without premature implementation decisions.
- Maintains a debt registry grounded in evidence.
- Lays out phased evolution with dependencies and entry/exit criteria.
- Provides decision trigger maps and cross-document ownership.

### 1.2 What this document is not

- **Not an ADR**: Identity, release, platform, SQLite migration, context-window, and compatibility governance remain in their authoritative documents.
- **Not an implementation plan**: Phases describe evolution directions and dependencies, not authorized work items unless explicitly approved.
- **Not a performance document**: Performance evidence feeds this program when it exposes structural debt; this program does not own measurement or thresholds.

### 1.3 Relationship to existing documents

| Document | Role | Relationship |
|---|---|---|
| [`architecture.md`](./architecture.md) | Implemented architecture reference | Current reality only; target evolution is here |
| [`performance-program.md`](./performance-program.md) | Performance methodology entry | Evidence feeds this program when structural debt is exposed |
| [`performance-measurement.md`](./performance-measurement.md) | Measurement contract | Owns methodology, lane, schema, and artifact contract |
| [`performance-workstreams.md`](./performance-workstreams.md) | Current actionable performance state | Product problems reference this program for architecture acceptance |
| [`sync-mvp.md`](./sync-mvp.md) | Sync first-phase boundary | Sync must adapt to this program; never the reverse |
| [`sync-powersync-spike.md`](./sync-powersync-spike.md) | PowerSync No-Go record | Vendor-specific No-Go; not a target constraint |
| [`sqlite-migration.md`](./sqlite-migration.md) | SQLite chat authority governance | Authoritative; schema changes require ADR |
| [`context-window.md`](./context-window.md) | Context window governance | Authoritative; anchor semantics unchanged |
| [`cherry-chat-application-identity.md`](./cherry-chat-application-identity.md) | Identity / compatibility / release / platform governance | Authoritative; not modified by this program |
| [`../specs/architecture-evolution/progress-tracker.md`](../specs/architecture-evolution/progress-tracker.md) | Current architecture-evolution execution state | Mutable current-state projection; non-authoritative; Git owns history |

### 1.4 Document writing policy

**Belongs in this file**:

- Strategic intent, approved `ARCH-*` locks, target qualities.
- Concise debt registry with classification and evidence pointer.
- Phase roadmap, per-phase intent, entry/exit criteria, status, and durable decisions.
- Open architecture questions, ADR/decision trigger map, and links to authoritative docs.
- Concise capacity defaults (B-*) and contract intents (R-*) as normative inputs.
- One-line outcome/decision/remaining-risk summary per completed phase or slice.

**Does not belong in this file**:

- Chained `Last updated` provenance, HEAD hashes, dirty flags, local artifact paths, or session/worktree history — Git owns change history.
- Repeated per-run numeric measurement values, full calibration matrices, or artifact JSON dumps — `performance-measurement.md` / `performance-workstreams.md` and `test-results/bench-results/` (gitignored) own evidence; this program references IDs only.
- Absolute performance thresholds, baselines, or capacity policies derived from measurement-only artifacts — directional evidence does not become a threshold (ARCH-009..012).
- Append-only experiment logs, repeated boilerplate findings across phases, or duplicated governance text.

Edits that would grow this file beyond ~900 lines must first compress or reference Git/related docs rather than append.

---

## 2. Strategic Intent and Approved Locks

### 2.1 Strategic intent

Architecture correctness, elegance, unity, and long-term evolvability lead. The application should be structured so that:

- Authority boundaries are clear and stable.
- Components have single, well-defined responsibilities.
- Changes propagate through explicit, typed contracts.
- New capabilities (including future sync) extend seams without restructuring foundations.

Performance symptoms (topic switch latency, streaming cadence, echo delay) expose architecture debt. When a performance fix requires changing ownership, lifecycle, or data contracts, it enters this program as architecture evolution. Refactoring seeks structurally better and naturally faster architecture; measurements record the natural result. No absolute performance metric is a routine phase gate; a reproducible material regression under controlled same-state comparison is counterevidence and must be dispositioned before phase exit.

Historical measurement provenance (pre-S3.1 and prior clean L3 records) remains reference evidence and is not relabeled as thresholds/baselines (ARCH-012). Subsequent detailed directional L3 records are retained in `performance-workstreams.md` / `performance-measurement.md` and Git history as directional evidence with no same-state improvement/regression claim; this file retains only durable architecture decision impact.

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
| **ARCH-009** | Architecture refactoring seeks structurally better and naturally faster architecture; performance measurements record the natural result — no absolute performance metric/target is a routine phase gate and architecture progression does not require direct natural performance improvement to progress. | **Locked** |
| **ARCH-010** | Reproducible material performance degradation under a controlled same-state comparison is architecture-correctness counterevidence and must be attributed/disposed before phase exit (fix, accepted trade-off, or keep phase Open). | **Locked** |
| **ARCH-011** | Remaining performance problems are reassessed/re-baselined as separate post-refactor performance work rather than being absorbed into architecture closure; architecture phase closure does not close PERF product problems. | **Locked** |
| **ARCH-012** | Measurement provenance is preserved as reference evidence and must not be erased or relabeled as thresholds/baselines. Detailed directional L3 records belong in performance workstream/evidence history, not in this file; this file retains only the durable non-relabeling policy and concise decision impact with no same-state improvement/regression claim and does not accept append-only experiment history. | **Locked** |

---

## 3. Target Architecture Qualities

Qualities, not implementation decisions. Specific libraries, transports, or schema designs are not locked.

### 3.1 Clear authority boundaries

One authoritative owner per data domain (chat: Main SQLite; config/projection: renderer Redux; file catalog: renderer Dexie). No dual-state authority. Authority never transfers implicitly.

### 3.2 Typed explicit contracts

IPC contracts are the only cross-process boundary. Both sides compile against the same shared contract. Commands are explicit and typed. Contract changes require coordinated both-side edits.

### 3.3 Atomic and idempotent mutations

Database writes are atomic and idempotent where possible. Retry/reconnection produce the same result as the original. Enables future checkpoint replay and idempotent merge.

### 3.4 Deterministic ordering

Message/block ordering uses a stable deterministic sort key (currently dense `sort_order`). Ordering operations are explicit; ordering is never derived from implicit insertion order or timestamps alone.

### 3.5 Stable and final checkpoints

Only stable/final block states are eligible as future sync candidates (SYNC-004). Checkpoints are well-defined boundaries (block completion, final answer selection, topic structure change). Transient streaming state is distinct from stable checkpoints.

### 3.6 Disposable projections

Renderer-side derived state (viewport, display groups, context info) is disposable and rebuildable from authority. Projection state must not be treated as authoritative.

### 3.7 Bounded caches

Caches have clear invalidation rules and size bounds. Cache-miss paths are explicit and measurable. Cache state is not authoritative.

### 3.8 Device-local-state separation

Per-device state (profile, local paths, preferences) is separated from shareable state. Enables future sync without leaking device-specific data.

---

## 4. Architecture Debt Registry

Classification: **Observed structure** (concrete property), **Candidate consequence** (inferred impact), **Open decision** (choice required).

### 4.1 Conversation lifecycle and ownership

| Item | Classification | Evidence |
|---|---|---|
| Topic switch traverses full Main load + IPC + full renderer recomputation | Observed structure | PERF-TOPIC-SWITCH cost model; `loadTopicMessagesThunk` full load |
| Conversation lazy activation — remaining mount cost (ContentSearch/EditMode now gated; viewport/Inputbar immediate by design) | Observed structure | S3.5 parent-owned lazy mount; `EditModeProvider` light gate |
| O(N) full-topic compute per reconciliation (group model, context info, viewport) | Observed structure | `computeContextInfo`, `createLatestMessageWindow`, `reconcileMessageWindow` |
| Potential benefit of lifecycle refactoring for startup/memory | Candidate consequence | Depends on lifecycle refactoring |

### 4.2 Data access patterns

| Item | Classification | Evidence |
|---|---|---|
| Full-topic `listByTopic` + `listByMessages` on every topic switch | Observed structure | `dbService.fetchMessages` whole-topic path |
| No windowed/paginated fetch for visible messages only | Observed structure | No `latest`/`around` before S6.1 |
| Full context info recomputation on memo identity change | Observed structure | `computeContextInfo` on `[topic messages, blocks, assistant, topic id]` |
| Whether windowed fetch + cache joins reduce load | Open decision | Deferred to Phase 5 windowed contract and S6 slices |

### 4.3 DB health

| Item | Classification | Evidence |
|---|---|---|
| Short (<3 codepoint) queries fall through to LIKE full-table scan | Observed structure | `SearchRepository` `collectCandidates` (M2) |
| Dense `sort_order` O(N) shift on middle/batch insert | Observed structure | `MessagesRepository` `insertAt`/`insertManyAt` (M1) |
| FTS content stored redundantly in `message_blocks_normalized` + `message_blocks_fts` | Observed structure | Migration 003/004 (M4) |
| File dual-state (Main SQLite + renderer Dexie) consistency | Candidate consequence | `FileReferencesRepository` + `attachmentAvailability` (M5) |
| Whether specific index/query optimizations measurably improve | Open decision | Requires M1/M2/M3 diagnostic (S6.4) |

### 4.4 Streaming and rendering

| Item | Classification | Evidence |
|---|---|---|
| 50 ms cadence throttle as primary streaming limiter | Candidate consequence | PERF-STREAMING |
| `key={activeTopic.id}` full remount | **Resolved (S3.1)** | Stable host removed key-driven remount |
| Per-message/per-block Redux subscriptions cause granular re-render | Observed structure | PERF-RENDER-FLOW candidate C |
| Markdown parse CPU contribution | Open decision | No direct parse-CPU measurement |

### 4.5 Identity and compatibility

| Item | Classification | Evidence |
|---|---|---|
| Source-format identifiers (Dexie name, persist key, ZIP schema) are compatibility contracts | Observed structure | Application Identity ADR; `architecture.md` Source Compatibility Boundary |
| Protected default profile names enforce startup guard | Observed structure | Application Identity ADR |

---

## 5. Natural Scope and Explicit Non-Goals

### 5.1 In scope

- Architecture correctness, elegance, unity, long-term evolvability.
- Structural debt identified via performance evidence, code analysis, or design review.
- Phases improving authority boundaries, contract clarity, or component lifecycle.
- Startup speed and bounded memory as enablement goals.
- Sync-readiness as structural property preservation.

### 5.2 Explicit non-goals

- No implementation authorization beyond explicitly approved slices.
- No technology/vendor/transport/schema selection.
- No performance thresholds — owned by `performance-measurement.md`.
- No sync schema/metadata/tombstone/conflict/transport/account/E2EE implementation.
- No governance changes for identity, SQLite migration, context-window, compatibility, release/platform.
- No root `AGENTS.md` changes.

---

## 6. Phased Architecture Evolution

Phases have dependencies but are not all sequential or approved for implementation. No phase is active unless explicitly approved.

### 6.1 Roadmap overview

| Phase | Title | Status | Entry dependency |
|---|---|---|---|
| **1** | Governance and Debt Map | **Complete** | None |
| **2** | Conversation Ownership and Lifecycle | **Complete** (design, 2026-08-19) | Phase 1 |
| **3** | Stable Render/State/Action Graph | **Structurally Complete / Closed 2026-08-21** | Phase 2 |
| **4** | Bounded Memory and Cache | **Design complete; exit Open** | Phase 2 |
| **5** | Data-Access Contract | **Design complete; exit Open** | Phase 2 + Phase 4 inputs |
| **6** | DB-Health Implementation | **S6.1-S6.3 Authorized & Implemented; S6.4-S6.5 Candidate — Not Authorized** | Phase 5 contract |
| **7** | Startup Architecture | **Open** (deferred) | Phase 2; Phase 3 for conversation-startup |
| **8** | Future Sync Decision | **Open** (deferred) | Phases 2-5 + governance decision |

PERF-TOPIC-SWITCH, PERF-ECHO, PERF-STREAMING, PERF-DB-HEALTH remain independent post-refactor workstreams per ARCH-011; architecture closure does not close them.

### 6.2 Phase 1: Governance and Debt Map

- **Entry**: None.
- **Content**: Establish program, debt registry, qualities, dependencies, decision triggers.
- **Exit**: Approved document with registry, qualities, phase map. **Status: Complete**.

### 6.3 Phase 2: Conversation Ownership and Lifecycle

- **Status**: **Complete** (documentation/design, 2026-08-19). No production code authorized by this completion; Phase 3 carries implementation.
- **Entry**: Phase 1 complete; explicit approval.
- **Exit (satisfied)**: Documented ownership model, topic transition contract, render graph decisions, action/request ownership, lazy activation boundaries (see below). `architecture.md` remains current reality.

#### 6.3.1 Current-state evidence (observed at Phase 2 time)

| Aspect | Reality | Label |
|---|---|---|
| Chat persistence | Main SQLite authoritative; renderer via typed IPC only | Authority boundary |
| Topic load | `loadTopicMessagesThunk` full-topic fetch; no windowed path | Current path |
| Renderer host | Stable host (no key-driven remount); `useTopicTransition` owns viewport/timer/epoch; `useScrollPosition` owns outgoing scroll; activation path owns load/restore | Post-S3.1 |
| Viewport/scroll | Topic-keyed reducer; scroll snapshot device-local | Current |
| Background streams | Generation/stream persists across topic switch | Current |
| ContentSearch (Chat) | Parent-owned lazy mount; zero instance before invoke; remains active across switch while mounted | Post-S3.5 |
| ContentSearch (RichEditor) | Legacy hidden-mounted `hidden` prop preserved | Legacy |
| EditMode | Light provider while disabled; heavy subscriptions only while `enabled` | Post-S3.5 |

#### 6.3.2 Target ownership and invariants

| Domain | Target owner | Invariant |
|---|---|---|
| Authoritative chat data | Main SQLite via typed IPC | Single source of truth |
| Renderer entity projection | Redux topic messages/blocks | Disposable, rebuildable |
| Active viewport / navigation / scroll | Renderer viewport reducer (topic-keyed) | Device-local; reset on activation |
| Live request / stream state | Request pipeline (topic/message-scoped) | Transient; survives topic switch |
| Derived render / context projection | Renderer memo | Rebuilt from entity projection |
| Device-local UI state | Redux config / local prefs | Separated from shareable (§3.8) |
| Action / request context | Action controller (event-time) | Resolves Assistant/request at event time; no event sourcing |

#### 6.3.3 Topic transition model

Activate request (renderer) -> old-topic deactivate/save (viewport reducer) -> generation advance/stale rejection (pipeline) -> viewport reset (reducer) -> projection activation/load (Redux) -> scroll restore/bootstrap (viewport) -> ready (host) -> request/stream stays scoped to originating topic.

#### 6.3.4 Stable render graph decisions

- Stable host persists across topic changes; topic ID is primary projection boundary; message/block IDs are sub-boundaries.
- Group membership derived at render time; not stored as authority.
- Components subscribe to narrowest topic-scoped slice.
- History and live-tail are render layers of one disposable projection.
- Edit/answer-switch activate locally within stable host.

#### 6.3.5 Action ownership

```
UI intent (message/topic IDs) -> event-time resolution (action controller)
  -> request/action owner -> authoritative mutation or stream initiation
    -> projection update (derived from authority)
```

No event sourcing or command logs; resolution at event time.

#### 6.3.6 Lazy activation boundaries

| Capability | Trigger | Note |
|---|---|---|
| ContentSearch (Chat) | Invocation | Parent-owned lazy mount (S3.5) |
| ContentSearch (RichEditor) | Immediate hidden-mounted | Legacy preserved |
| Edit capability | Edit-mode activation | Light gate while disabled |
| Optional drawers/panels | User opens panel | Deferred |
| Inputbar / viewport | Immediate | Essential |

#### 6.3.7 Future phase requirements surfaced by Phase 2

- **Phase 4**: Bounded projection cache, scroll bounds, context memo invalidation, measurable miss paths.
- **Phase 5**: Windowed/semantic reads (R-02..R-06) and cache-join contract; incremental/delta excluded from Phase 5 and deferred to Phase 6 without generation-authority cursor.
- **Phase 7**: Lazy activation reduces mount cost; stable host does not block boot-service optimization.

#### 6.3.8 Sync compatibility review (Phase 2)

Phase 2 contributes clear authority, stable IDs, typed commands, disposable projections, device-local separation (established documentary); atomic mutations, ordering, checkpoints preserved; bounded caches deferred to Phase 4. No sync infrastructure authorized.

### 6.4 Phase 3: Stable Render/State/Action Graph

- **Status**: **Structurally Complete / Closed 2026-08-21**. Closed on structural/governance/functional evidence (stable host/transition, viewport/scroll lifecycle, ID boundaries, history-live-tail layering, action controller, lazy activation). Not gated by an absolute performance threshold (ARCH-009). Controlled-regression disposition satisfied per ARCH-010 (no reproducible material degradation under controlled same-state comparison). PERF-TOPIC-SWITCH and PERF-ECHO reclassified as independent post-refactor workstreams (ARCH-011, Open, non-blocking). Measurement provenance preserved per ARCH-012.
- **Entry**: Phase 2 ownership model complete; explicit approval. S3.1-S3.5 implemented sequentially (S3.4 depends on S3.1; S3.5 independent).
- **Exit**: Render/state/action graph with reduced remount blast radius; structural/functional validation satisfied.
- **Dependencies**: Phase 2.

#### 6.4.1 Implementation slices (summary outcomes)

| Slice | Scope | Outcome | Remaining risk |
|---|---|---|---|
| **S3.1** Stable host / transition coordinator | Stable `Messages` host, `useTopicTransition` layout-phase reset, epoch stale-completion | Implemented; removes full-subtree remount | None beyond normal evolution |
| **S3.2** Viewport / scroll cleanup | Topic-scoped save-before-reset, per-topic snapshot/restore, no cross-topic leakage | Implemented; scroll correctly per-topic | None |
| **S3.3** Stable ID render boundaries / history-live-tail | History/live-tail as render layers of one projection; stable entity-derived keys | Implemented; deterministic ordering preserved | None |
| **S3.4** Action controller / event-time resolution | Stateless `messageActionController` + hook; resolves latest Redux/answer-group at event time; editor closes only on success | Implemented; no stale-state bugs | None |
| **S3.5** Lazy activation | ContentSearch parent-owned lazy mount; EditMode light gate; optional panels deferred | Implemented; no functional regression | None |

All slices renderer-local; no authority, IPC, schema, or governance boundary crossed. Each independently rollback-safe (revert host/transition/viewport/layers/controller/lazy behavior).

Measurements for Phase 3 were directional L3 reference (clean 50-message / high-turn profiles); L1 correctness gates passed; no controlled same-state improvement/regression claim. Prior detailed per-run values and commit references are in Git; not reproduced here. Transition to directional non-adoption policy is durable.

### 6.5 Phase 4: Bounded Memory and Cache

- **Status**: **Lifecycle foundation implemented (2026-08-27) — renderer resident-topic completeness/applicability-generation registry + same-generation staged joint publication via one dispatch; B-06 viewport bound (renderer-local, target max 200 groups), B-07 device-local persistent Keyv scroll cache (renderer-local index, max 256 topics / 90-day TTL LRU), B-08 ContentSearch bound implemented (renderer-local disposable search session: at most one 500 live-Range chunk, lightweight count metadata, cross-chunk rescans current rendered DOM, target/DOM invalidation; no persistence/StoreSync/IPC/SQLite/schema/resident-topic lifecycle effects), and B-09 renderer context-closure active-topic retention (renderer-local, max one active topic) implemented; renderer-local bounded scalar resident diagnostics (entry/completeness/generation counts via pure read-only adapter, composed into Phase 4 snapshot/bound scalars; no lifecycle/policy/persistence/IPC/StoreSync change) implemented; renderer-local bounded scalar resident read-path diagnostics (cache hit/miss reason, staged latency (success+failure), discarded publication attempts (post-stage validation only; staged fetch failure before validation is staged failure, not discarded) via renderer-local counters wired from `loadTopicMessagesThunk` lifecycle and post-stage validation discard paths, composed into Phase 4 snapshot/bound scalars; bounded scalar-only, no IDs/content/paths/credentials/histories, no lifecycle/policy/persistence/IPC/StoreSync change) implemented; coherent renderer-local mixed-workload observability is evidenced by renderer-local integration snapshot regression tests exercising B-06/B-07/B-08/B-09 bounds via public/local boundaries alongside resident complete -> generation advance/incomplete -> stale rejection -> deletion/clear transitions via snapshot/bound scalars (no data retention or policy expansion), by a persistent-like exercised-workload validation increment proving each cap/eviction/closure (B-06 opposite-edge trim with anchor preservation, B-07 TTL->LRU with rebuild/hard-delete invalidation, B-08 disposable 500 live-Range owner isolation, B-09 active-topic retention with generation/fingerprint/deletion invalidation) through coherent snapshot/bound scalar composition (scalar-only, privacy-safe), and by focused read-path regression tests covering cache hit and each miss/discard path with staged latency and snapshot/bound scalar composition; no B-01–B-05 retention/eviction/TTL/LRU/pin policy, capacity defaults, or heap thresholds adopted; exit remains Open** (design study complete 2026-08-20; foundation groundwork only; lifecycle foundation remains renderer-local, non-persistent, non-StoreSync).
- **Entry**: Phase 2 complete; explicit approval.
- **Content**: Cache invalidation rules, size bounds, retention/eviction design for renderer-side caches; bounded state for resident projections, viewport window, scroll snapshots, ContentSearch handles, context-closure cache (active-topic-only retention); measured pinned working set.
- **Exit**: Must demonstrate bounded evictable caches, explicit pinned exception, invalidation rules, and measurable miss paths. Not claimed.
- **Dependencies**: Phase 2. Phase 5 windowed reads replace full-topic fetch where window suffices; incremental/delta deferred to Phase 6; active/pinned working-set bounding is Phase 6/governance.

#### 6.5.1 Design constraints

- Lifecycle foundation is code (resident registry + staged joint publication) but remains groundwork only — no B-01–B-05 retention/eviction/TTL/LRU/pin policy or capacity/byte enforcement, no IPC/schema, no persistence/sync of registry; lifecycle foundation remains renderer-local, non-persistent, non-StoreSync (B-07 device-local Keyv scroll persistence excluded from this non-persistence claim). B-06 viewport bound, B-07 scroll snapshot cap/TTL/LRU, B-08 ContentSearch bound, and B-09 active-topic closure retention are implemented renderer-local mechanisms per §6.5.5–§6.5.6 (B-08 disposable with no persistence/StoreSync/IPC/SQLite/schema/resident-topic lifecycle effects; B-07 device-local persistent Keyv cache with TTL/LRU/cap and no IPC/StoreSync/SQLite/schema or governed chat-persistence effects; B-06/B-09 renderer-local enforcement/retention paths retaining existing IPC-backed reads without altering persistence/schema contracts or resident-topic lifecycle, beyond their local scope); lifecycle foundation does not extend those bounds; coherent renderer-local mixed-workload diagnostics coexistence (B-06/B-07/B-08/B-09 bounds plus resident complete -> incomplete/generation advance -> stale rejection -> deletion/clear via snapshot/bound scalars; no data retention) is evidenced via a persistent-like exercised-workload validation increment proving each B-06/B-07/B-08/B-09 cap/eviction/closure through public/local boundaries with scalar privacy-safe snapshot/bound scalar composition, alongside resident read-path diagnostics (cache hit/miss reason, staged latency (success+failure), discarded publication attempts (post-stage validation only; staged fetch failure before validation is staged failure, not discarded) via bounded scalar counters wired from `loadTopicMessagesThunk` and post-stage validation discard paths, composed into snapshot/bound scalars; no IDs/content/histories, no policy); B-01–B-05 retention acceptance and broader full exercised-workload retention policy validation remain Open (no B-01–B-05 policy adopted).
- Evictable caches bounded (target design); active/pinned working set excluded but measured.
- Context-window and request-stream semantics preserved; pinned topics never evicted.
- Phase 3 structurally Closed (ARCH-009/010); PERF workstreams Open (ARCH-011).
- Main SQLite authoritative; renderer projection disposable; whole-topic eviction atomic.

#### 6.5.2 Key terminology

- **Resident projection**: Redux `messages`/`blocks`/`segments` held per topic + completeness marker, generation, logical-bytes accounting (renderer-local, no IPC versioning). Incomplete without both component markers for same generation.
- **Component completeness**: `chat-data` (messages + blocks) and `segment` (segments) each require explicit empty marker for empty side.
- **Resident-topic completeness**: `chat-data` AND `segment` for same generation (explicit empty markers where applicable) — this is `whole-topic` semantic completeness.
- **Pinned working set**: Active topic + every topic with pending/in-flight request; excluded from eviction.
- **Evictable set**: Inactive, non-pinned residents — strictly bounded.
- **Logical retained payload (B-02)**: Deterministic UTF-8 bytes of canonical JSON for frame `{ accountingVersion: phase4-logical-payload-v1, topicId, messages, blocks, segments, completeness{chatData,segments,residentTopic}, applicabilityGeneration }` — no whitespace, lexicographic keys, arrays sorted by `sortOrder`->`id` (or `id` where no sort field), entities canonicalized, shared entities duplicated per topic. Derived caches excluded. Heap-amplification ratio recorded separately. Canonical accounting is **shared pure cross-runtime infrastructure** (`packages/shared/chatDb/logicalPayload.ts`, browser-and-Node compatible via `TextEncoder`/`utf8ByteLength` with Buffer parity proved; prior Node `Buffer.byteLength` contract preserved) — measurement-only, directional non-adoption; no working-set policy, IPC, or schema is added.
- **Eviction**: Whole-topic atomic; one transition removes index + exclusive entities/markers/accounting after scroll save; shared entities remain.

#### 6.5.3 Current-state inventory (observed unbounded)

Renderer Redux projections accumulate without eviction; data-access is full-topic fetch with early-return on any cached IDs; viewport windowing now bounded per implemented B-06 and scroll snapshots now bounded per implemented B-07 (both renderer-local per §6.5.5–§6.5.6: viewport target max 200 groups opposite-edge trim with anchor preservation and no entity eviction; scroll max 256 topics 90-day TTL LRU via renderer-local index; exercised-workload/observability for both is evidenced via persistent-like mixed workload regression through public/local boundaries with scalar privacy-safe snapshot composition); ContentSearch `Range[]` handle array was unbounded when mounted at Phase 4 design time — now bounded per implemented B-08 (§6.5.5 B-08, §6.5.6: at most one 500 live-Range chunk, lightweight count metadata, cross-chunk rescans current rendered DOM, target/DOM invalidation; renderer-local disposable, no persistence/StoreSync/IPC/SQLite/schema/resident-topic lifecycle effects; exercised-workload/observability evidenced via disposable owner-isolated persistent-like workload); context-closure cache now bounded per implemented B-09 (active-topic-only retention, max one active topic; renderer-local context-closure cache with generation/fingerprint/deletion invalidation distinct from retention; exercised-workload/observability evidenced) while anchor-to-end remains unbounded when `contextCount=null` per design; background stream queues have no global cap; undo 50 and streaming throttle 100/5 min are observed bounds. B-01–B-05 remain unadopted; Phase 4 exit remains Open.

#### 6.5.4 Target ownership tiering

```
Authority (Main SQLite) -> Typed full-topic fetch (until Phase 5) -> Renderer entity projection
  |- Pinned working set (active + in-flight) — excluded from caps, measured
  └- Evictable set (inactive non-pinned) — strictly bounded (B-01..B-11)
     -> Derived projections (viewport, context info, display groups) — disposable
```

#### 6.5.5 Concrete bounds table (capacity defaults — evictable only unless labeled)

B-06 viewport bound, B-07 scroll snapshot cap/TTL/LRU, B-08 ContentSearch bound, and B-09 closure retention are implemented renderer-local mechanisms per §6.5.6; B-01–B-05 remain architecture capacity defaults requiring calibration before implementation — not thresholds or baselines and not adopted; B-10/B-11 are observed preserved bounds.

| # | Bounded subject | Target bound | Applies to | Enforcement | Note |
|---|---|---|---|---|---|
| B-01 | Inactive resident projections | max 8 topics | Evictable | Admission + LRU | Requires calibration |
| B-02 | Aggregate logical retained payload | max 32 MiB (canonical frame `phase4-logical-payload-v1`) | Evictable | Evict until ≤32 MiB | Heap ratio recorded separately |
| B-03 | Idle TTL | 30 min idle | Each evictable topic | TTL sweep | lastAccess = activation or unpin |
| B-04 | Eviction policy | LRU | Evictable | On B-01/B-02 pressure | Recency = last activation/unpin, tie-break topic ID |
| B-05 | Single oversized topic | non-admissible after deactivation if >32 MiB alone | Any topic >32 MiB | Evict immediately when not pinned | Prevents one topic occupying budget |
| B-06 | Viewport rendered groups | target max 200 groups, 20-group steps, opposite-edge trim | Active viewport | Trim while preserving navigation/scroll anchors | **Implemented** — renderer-local viewport trim; no entity eviction by viewport trim |
| B-07 | Scroll snapshot cache | max 256 topics, 90-day TTL, immediate delete on hard delete | Device-local keyv | LRU+TTL via renderer-local index | **Implemented** — renderer-local LRU+TTL via index; soft-delete retains snapshot |
| B-08 | ContentSearch live handles | max 500 live `Range` handles, bounded descriptors | Per search session | Materialize only current 500-match chunk | **Implemented** — renderer-local disposable session; retains at most one 500 live-Range chunk + lightweight count metadata; cross-chunk navigation rescans current rendered DOM; target/DOM changes invalidate the session; no persistence/StoreSync/IPC/SQLite/schema/resident-topic lifecycle effects |
| B-09 | Context-closure cache (active-topic-only retention) | max one active topic (retention); generation/fingerprint/deletion invalidation distinct from retention | Renderer-local context-closure cache | Active-topic-only retention | **Implemented** — renderer-local context-closure cache; active-topic-only retention (max one active topic); generation/fingerprint/deletion invalidation distinct from retention; unlimited `contextCount` semantics unchanged |
| B-10 | Undo stack | 50 — observed | Renderer edit | Preserved | Not a new Phase 4 policy |
| B-11 | Streaming throttle / queue | 100 per 5 min — observed; no global queue cap | Request pipeline | Preserved | Future cap is Phase 6/governance |

Pinned working set (active + in-flight) is excluded from B-01/B-02 caps but measured as a separate working-set metric for Phase 6/governance.

#### 6.5.6 Lifecycle / pin / admission / eviction / invalidation

- **Pin**: Active topic pinned; any topic with pending/in-flight request pinned; pin is additive; unpin requires inactive AND no pending request.
- **Deterministic order**: Pin first -> stage chat-data + segment-data for same generation -> await both + validate together -> compute canonical bytes -> publish in one transition -> admit while pinned -> on inactive+settled set lastAccess and unpin -> enforce eviction TTL -> oversized -> LRU.
- **Admission hit**: `resident-topic` completeness (both components for same generation) required; current `cachedIds.length>0` does not satisfy target.
- **Eviction**: Whole-topic atomic after scroll save; ordering TTL first, then oversized (>32 MiB), then LRU. TTL sweep at admission, unpin, and periodic ≤60 s (target design).
- **Scroll (B-07 implemented — renderer-local LRU+TTL)**: Index `topicId`+`lastAccess`; enforcement at startup + on each write; TTL first then LRU, topic-ID tie-break; missing index rebuilds from keys.
- **Viewport (B-06 implemented — renderer-local)**: Expanding older trims newest overflow and vice versa; if trim would remove anchor, recenter up to 200 around anchor; restore pixel offset; no entity eviction.
- **ContentSearch (B-08 implemented)**: Renderer-local disposable search session retaining at most one 500 live-Range chunk + lightweight count metadata; ranges materialized only for current chunk/match; cross-chunk navigation rescans current rendered DOM; target or DOM mutation invalidates the session; no persistence, StoreSync, IPC, SQLite/schema, or resident-topic lifecycle effects.
- **Retention/Invalidation (B-09 implemented — renderer-local context-closure cache, active-topic-only retention)**: Retention max one active topic; generation/fingerprint/deletion invalidation distinct from retention; no incremental patch in Phase 4.
- **Deletion cleanup**: Soft-delete/trash preserves projection + scroll for restore unless pressure evicts; hard delete/final purge/empty-trash/assistant reset atomically removes all markers/generation/accounting/index/exclusive entities/derived state/scroll in one transition; shared entities remain if referenced elsewhere; bulk path must identify IDs from authoritative result or typed capability (§10.1 gate if insufficient); no mixed-generation joins.

#### 6.5.7 Cache-miss contract

Hit requires `resident-topic` completeness for same generation including empty markers. Miss is whole-topic — any component absence or generation mismatch is a miss. Miss path until Phase 5: pin -> stage both components for same generation (coordinated reads or future payload subject to §10.1) -> await both -> validate together -> compute bytes -> publish in one transition. On failure/mismatch, discard staged data, publish nothing, preserve/invalidate prior entry per prior generation. Phase 5 windowed reads will replace where window suffices. Hit/miss, staged latency, bytes, eviction reason, discarded-attempt count must be observable; hit/miss by reason, staged latency (success+failure), and discarded-attempt count (post-stage validation only; staged fetch failure before validation is staged failure, not discarded) are implemented as renderer-local bounded scalar read-path diagnostics wired from `loadTopicMessagesThunk` lifecycle and post-stage validation discard paths, composed into Phase 4 snapshot/bound scalars (no IDs/content, no policy).

#### 6.5.8 Observability and privacy

Required metrics: resident topic count (evictable vs pinned), logical bytes per-topic and aggregate vs 32 MiB, heap-amplification ratio, working-set payload, hit/miss by reason, completeness markers/generation, eviction events (TTL/oversized/LRU/deletion), TTL sweep execution, viewport groups/anchor stability, scroll snapshot counts, ContentSearch handles/descriptors, context-closure cache hit/miss. All local, no network export. B-01/B-02 require empirical calibration of logical bytes + heap ratio before implementation. Implemented locally as bounded scalar-only: resident entry/completeness/generation via pure adapter plus read-path hit/miss reason, staged latency summaries (success+failure), and discarded publication attempts (post-stage validation only; staged fetch failure before validation is staged failure, not discarded) via renderer-local counters wired from `loadTopicMessagesThunk` and composed into Phase 4 snapshot/bound scalars; no IDs/content/paths/credentials/histories, no persistence/IPC/StoreSync, no B-01–B-05 policy.

#### 6.5.9 Acceptance disposition

Phase 4 exit remains Open. Lifecycle foundation (non-persisted per-topic `chatData`/`segments`/`residentTopic = chatData && segments` + monotonic `applicabilityGeneration` registry; same-generation staged joint publication of latest-window chat-data plus segments via one dispatch; deletion advance/clear before purge; fail-closed staged discard) is implemented and remains renderer-local, non-persistent, non-StoreSync (B-07 device-local Keyv scroll persistence excluded from this non-persistence claim); B-06 viewport bound, B-07 scroll snapshot cap/TTL/LRU, B-08 ContentSearch bound, and B-09 active-topic closure retention are implemented renderer-local mechanisms per §6.5.5–§6.5.6 (B-08 disposable with no persistence/StoreSync/IPC/SQLite/schema/resident-topic lifecycle effects; B-07 device-local persistent Keyv cache with TTL/LRU/cap and no IPC/StoreSync/SQLite/schema or governed chat-persistence effects; B-06/B-09 renderer-local enforcement/retention paths retaining existing IPC-backed reads without altering persistence/schema contracts or resident-topic lifecycle, beyond their local scope); renderer-local bounded scalar resident diagnostics (entry/completeness/generation via pure adapter composed into Phase 4 snapshot; read-only, no lifecycle/policy/persistence/IPC/StoreSync change) is implemented as local observability only; renderer-local bounded scalar resident read-path diagnostics (cache hit/miss reason, staged latency (success+failure), discarded publication attempts (post-stage validation only; staged fetch failure before validation is staged failure, not discarded) via renderer-local counters wired from `loadTopicMessagesThunk` lifecycle and post-stage validation discard paths, composed into Phase 4 snapshot/bound scalars; bounded scalar-only, no IDs/content/paths/credentials/histories, no lifecycle/policy/persistence/IPC/StoreSync change) is implemented as local observability only, evidenced by focused regression tests covering cache hit and each miss/discard path with staged latency and snapshot/bound scalar composition; coherent renderer-local mixed-workload observability is evidenced by renderer-local integration snapshot regression tests exercising B-06/B-07/B-08/B-09 bounds via public/local boundaries alongside resident complete -> generation advance/incomplete -> stale rejection -> deletion/clear transitions via snapshot/bound scalars (no data retention or policy expansion) and by a persistent-like exercised-workload validation increment proving each B-06/B-07/B-08/B-09 cap/eviction/closure through public/local boundaries with coherent scalar privacy-safe snapshot/bound scalar composition; no B-01–B-05 retention/eviction/TTL/LRU/pin policy or capacity/byte enforcement, no canonical accounting usage in runtime, and no IPC/schema/persistence changes are adopted except B-07 device-local Keyv scroll persistence (no IPC/StoreSync/SQLite/schema or governed chat-persistence). Bounded evictable caches with B-01–B-05 retention (TTL->oversized->LRU ordering, whole-topic atomic eviction) and B-01–B-05 policy-driven cache-miss/eviction validation remain Open; B-06/B-07/B-08/B-09 exercised-workload validation increment is evidenced, Phase 4 exit remains Open. Directional synthetic calibrations (C-01 logical payload, pinned working-set, C-02 heap) demonstrate harness correctness and partition-sum accounting only; no B-01–B-05 capacity default is adopted and no heap threshold is adopted. Single oversized topic binding and enlargement ratios (e.g., ~14-18x unlimited vs bounded) are directional only. Phase 4 calibration is executable on demand via the explicit opt-in composite command `pnpm calibration:phase4` (alias `pnpm bench:phase4-calibration`, `scripts/calibration-phase4.ts` + `scripts/__tests__/calibration-phase4.test.ts`) which runs in order `pnpm bench:logical-payload` (Node) → `pnpm bench:pinned-working-set` (Node) → `pnpm build` (Electron, fresh production build) → `pnpm test:e2e -- tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts` (Electron, C-02 mixed; `C02_HEAP_CALIBRATION=mixed` injected only into that final child environment via cross-platform `spawnSync` env merge, not shell prefix) with C02 env isolated to the final step, fail-closed per step, and preserves independent schema-v1 artifacts (`logical-retained-payload-calibration`, `pinned-working-set-calibration`, `chatdb-c02-renderer-heap-e2e` under `test-results/`, gitignored, privacy-safe). Execution is measurement-only and does not close Phase 4/5, does not adopt B-01..B-05, does not create baselines/thresholds/capacity policy, and has no CI auto-invocation; prerequisite is the pinned toolchain Node 24.11.1/pnpm 10.27.0. See `performance-measurement.md` §6 composite row.

### 6.6 Phase 5: Data-Access Contract

- **Status**: **Design study complete (2026-08-20) — documentation only; exit Open**.
- **Entry**: Phase 1 complete; Phase 2 complete; Phase 4 design complete as input; explicit approval. M1/M2/M3/M7 diagnostics are independent and do not gate this design.
- **Content**: Stable-ID-anchored windowed read intents, deterministic `sort_order`->`id` ordering, completeness semantics, renderer-local generation applicability, separate viewport vs context projections, mutation/stream/cache rules.
- **Exit**: Must validate scoped window/closure reads with defined counting units, typed completeness with validated derivation, deterministic ordering with stable-ID anchoring, separate projections with renderer-owned anchor, pinned streams with structural vs content-only invalidation, and deferred window eviction granularity. Not claimed.
- **Dependencies**: Phase 2; Phase 4 capacity defaults; Phase 3 stable host.

#### 6.6.1 Design constraints

- Design/documentation only; no implementation or `architecture.md` edit.
- Main SQLite remains sole chat authority.
- Intents anchored by stable IDs (topic/message), not tuple cursors; intra-response deterministic order `sort_order`->`id`.
- Completeness is semantic (`whole-topic`/`window`/`answer-group`/`context closure`); partial never masquerades as complete; empty requires explicit marker.
- Renderer generation/request tokens are applicability only, not authority versions.
- Viewport and context are separate disposable projections; context preserves stable anchor-to-end and exactly-once repair; unlimited context may enlarge pinned working set and is measured not truncated.
- Authority-aware actions (Main resolves answer-group; branch/clone positioning via stable anchors; search-hit around-window) are contract-only and trigger coordinated IPC review.
- Streams pinned while in-flight; structural mutations invalidate generation; content-only block updates do not.
- Phase 4 bounds remain defaults, not thresholds; no global concurrency cap; no `listByTopicPage` sufficiency claim under concurrent mutation.

#### 6.6.2 Read intents (normative contract targets — R-02..R-06 are the authorized intents; R-01 is compat)

| # | Read intent | Anchor | Completeness produced | Counting unit | Intended consumers |
|---|---|---|---|---|---|
| R-01 | **Whole-topic load** (compat) | `topicId` | `whole-topic` = chat-data ∧ segment for same generation (explicit empty included, jointly validated) | messages + blocks/segments | Fallback consumers needing full topic |
| R-02 | **Latest window** | `topicId` | `window` (tail N, bounds declared) | complete rendered/message groups | Viewport bootstrap |
| R-03 | **Window around stable anchor** | `anchorMessageId` | `window` (anchor ±K, bounds declared) | complete rendered/message groups | History scroll, load-more |
| R-04 | **Window around message (search-hit)** | `hitMessageId` | `window` (hit ±K, bounds declared) | complete rendered/message groups | Search-hit navigation |
| R-05 | **Answer-group window** | `messageId`/`groupId` | `answer-group` (member set declared, authority-resolved) | messages in complete group | Answer selection, branch/clone positioning |
| R-06 | **Context closure** | `anchorMessageId` (persisted stable anchor) | `context closure` (anchor-to-end, bounds declared — stable anchor through newest) | complete context turns | Request context building |

All intents use stable-ID anchoring; deterministic return order `sort_order`->`id` within single authority transaction; no tuple-cursor stability across mutations; no revision/snapshot/linearizability; per-response bounds declared. R-06 `contextCount` is initialization/re-anchor provenance only — for an already anchored topic, coverage is stable anchor through newest independent of current `contextCount`; Main reads rows only, never owns/repairs anchor.

#### 6.6.3 Lifecycle and state machine (per topic, renderer-local)

Not resident -> Loading (pinned, request token + generation) -> Complete (typed: whole-topic/window/answer-group/context closure, pinned while active/in-flight) -> inactive+settled -> lastAccess/unpin -> TTL->oversized->LRU enforcement. Generation monotonic per-topic; advances on structural mutations and authoritative deletions. Content-only block updates do not advance generation. Structural mutations invalidate prior window/closure/group coverage. Authoritative deletion invalidates all completeness types and rejects stale generation before any join/action; soft-delete retains for restore.

Complete semantic constraints: `whole-topic` requires both components for same generation (staged publication); `whole-topic` containment does not imply `answer-group` or `context closure` — consumers must derive and validate the required semantic closure from a resident whole-topic for same generation; `window` never satisfies `whole-topic` and generic whole-topic label never implicitly satisfies `answer-group`/`context closure`.

#### 6.6.4 Semantic behavior matrix (target contracts)

| Intent | Completeness required | Completeness produced | Order | Anchor stability | Generation | Cache-join reuse |
|---|---|---|---|---|---|---|
| R-01 | whole-topic (both components) | whole-topic / empty whole-topic | `sort_order`->`id` | topic ID | structural invalidates; generation applicability-only | Fallback; may satisfy typed consumers only after derived closure for same generation |
| R-02 | window latest N | window (tail N) | `sort_order`->`id` | topic ID | new gen -> re-anchor latest | viewport prefers covering latest-N window |
| R-03 | window around anchor | window (anchor ±K) | `sort_order`->`id` | anchor message ID stable | structural -> not trusted | viewport prefers covering window |
| R-04 | window around hit | window (hit ±K) | `sort_order`->`id` | hit message ID stable | deleted -> not-found | separate navigation tx |
| R-05 | answer-group | answer-group (member set) | `sort_order`->`id` | message/group ID stable | re-resolve after mutation | never satisfied by window or generic whole-topic label alone |
| R-06 | context closure | context closure (anchor-to-end) | `sort_order`->`id` | anchor ID stable (renderer-owned) | `contextCount` change alone does not resize/invalidate; structural -> re-close | separate from viewport; never satisfied by generic whole-topic label alone |

All windows carry declared bounds; viewport intents count in groups; context in turns; whole-topic/answer-group in messages; authority order `sort_order`->`id`. Incremental delta (former R-07) is excluded from Phase 5 and deferred to Phase 6 without generation-authority cursor.

#### 6.6.5 Context contract — viewport vs context separation

| Concern | Viewport | Context |
|---|---|---|
| Purpose | Display: groups, window, scroll, anchors | Request building: ordered range for model |
| Intents | R-02/R-03/R-04 | R-06 |
| Completeness | `window` bounded | `context closure` anchor-to-end |
| Counting unit | complete rendered/message groups | complete context turns |
| Capacity | Viewport groups capped 200 as view cap | Unlimited when `contextCount=null` at init/re-anchor; anchor-to-newest for already anchored topic; measured not truncated |
| Governance | Renderer-local view policy | Renderer `AssistantSettings`; governed by `context-window.md`; Main reads rows only; exactly-once repair after projection load |

#### 6.6.6 Mutation, stream, cache rules

- Topic streams independent and pinned while in-flight; navigation does not terminate stream.
- Structural mutations (insert/delete/reorder/branch/clone with positioning) advance generation and invalidate local completeness.
- Content-only block updates do not advance generation or invalidate window coverage.
- Resident `whole-topic` may satisfy `window` only when generation matches and bounds trivially cover requested range with validated semantic closure; `window` never satisfies `whole-topic`; generic whole-topic never implicitly satisfies `answer-group`/`context closure`.
- Phase 4 whole-topic eviction remains atomic; window/closure eviction granularity beyond no-partial-entity-within-unit is deferred to Phase 6.
- Authoritative deletion (hard/purge/emptyTrash/assistant reset) invalidates all completeness types before any join/action; soft-delete retains; bulk IDs from authoritative result or typed capability.
- Viewport `displayGroups`/`displayCount` not redefined by this contract; pinned topics excluded from B-01/B-02 but measured.

#### 6.6.7 Error, retry, concurrency

- Generation/request tokens applicability-only; not versions/revisions.
- Not-found/anchor-missing are explicit typed signals, not empty windows.
- Failed fetch commits no complete resident entry; retry is caller-driven idempotent; no auto-retry.
- Same-topic identical reads may single-flight (may, not must; renderer-local).
- Same-topic window reads with different bounds serialize (queue in renderer, FIFO delivery; `queueDepth`/`waitMs` observable).
- No global request cap selected.

#### 6.6.8 Observability (contract-level targets)

Window hit/miss by reason, completeness type + component composition, staged publication, ordering verification, tuple-cursor safety, generation/token counts, authoritative deletion invalidation, single-flight/serialize depth, context closure (anchor/closure bounds/repair/working-set enlargement), pinned/evictable counts, viewport groups, authority-aware action sourcing, working-set enlargement under unlimited context. All local, no export. Phase 5 contracts are calibration inputs, not thresholds.

#### 6.6.9 Coordinated shared-contract review and direction approval

Reviews executed per mandatory stop/review obligation across shared types/channel definitions, preload exposure, Main handlers, and renderer consumption:

- **R-02/R-03** — reviewed (2026-08-22) against current whole-topic-only path; findings: any windowed read requires both-side contract change; Main-local dormant keyset pagination exists but not a conformant primitive; envelope precedent on adjacent channels; wholesale-replace reducer cannot yet install partial windows. Direction approved via scoped approval record (windowed reads with coverage-check cache-joins; selects no payload/channel/SQL/cursor/N-K/eviction value).
- **R-04/R-05/R-06** — reviewed (2026-08-22) and direction approved via separate scoped record: R-04 around-message window, R-05 answer-group and stable-anchor positioning, R-06 context closure. All reviews are documentation-only; selects no concrete field/value.

Coordinated-review precondition for R-02..R-06 is executed and direction-approved. Calibration (§6.5.9, §7.3) and §6.6 acceptance remain Open. Decision lock LOCK-P5-005 (no concrete value selection) preserved.

### 6.7 Phase 6: DB-Health Implementation

- **Status**: **S6.1, S6.2, and S6.3 bounded slices Authorized & Implemented; S6.4/S6.5 Candidate — Not Authorized**. Per-slice explicit approval required; Phase 4/5/6 exits remain Open; no capacity-threshold adoption.
- **Entry**: Phase 5 contract complete; calibration inputs per slice as needed; governance/ADR for any schema changes (M4/M5/M6).
- **Exit (per-slice)**: Slice-specific acceptance validated without violating contract invariants and without adopting a threshold unless owned by `performance-measurement.md`.
- **Dependencies**: Phase 5 contract; Phase 4 calibration where sizing touched; governance/ADR.
- **Activation**: Not activated by this program; per-slice approval separate.

| Slice | Description (contract targets) | Prerequisites | Acceptance | Rollback | Status |
|---|---|---|---|---|---|
| **S6.1** Windowed read contract | R-02 latest + R-03 around as typed `chatdb:fetch-messages-window` with `window` completeness, declared bounds, deterministic order, empty vs NOT_FOUND | Phase 5 contract; coordinated review | Viewport uses R-02/R-03 with coverage checks | Revert consumers to R-01; remove window IPC | **Authorized & Implemented 2026-08-22** |
| **S6.2** Authority-aware actions | Main-authoritative answer-group (R-05), stable-anchor branch/insert, R-04 search-hit around-window with not-found fallback | Same + S6.1 beneficial | Group via Main never window-inferred; branch/insert via stable anchor | Remove authority-aware IPC paths; restore prior projection-only paths | **Authorized & Implemented 2026-08-23** |
| **S6.3** Context closure & cache joins | R-06 anchor-to-end closure (renderer-owned anchor; Main reads rows only), cache-join for context-info, exactly-once repair | Phase 5 contract; context-window governance if semantics changed | Closure separate from viewport; unlimited measured not truncated; repair exactly once | Remove closure read path; restore renderer-computed `computeContextInfo` | **Authorized & Implemented — contract/Main (2026-08-23), renderer cache-join (2026-08-23), bounded anchor/viewport repair (2026-08-24)** |
| **S6.4** Index / query opportunities | Targeted index/query improvements if M1/M2/M3 proven beneficial | M1/M2/M3 evidence; ADR if schema/index changes | Structural query-plan improvement demonstrated | Revert index/query changes | **Candidate — Not Authorized** |
| **S6.5** File dual-state & FTS dedup | File consistency (M5) if proven real; FTS dedup (M4) if beneficial | M4/M5 evidence; ADR | Consistency/dedup benefit demonstrated | Revert storage/dual-state changes | **Candidate — Not Authorized** |

Notes: S6.1/S6.2 concrete request bounds (`limit`/`before`/`after` each 1..100) are validation bounds, not product defaults or eviction policy. S6.3 has no 1..100 bound (closure is anchor-to-newest). All slices preserve authority boundaries, `listByTopicPage` sufficiency remains unvalidated under concurrent dense-order mutation (window reads use stable-ID anchoring in one transaction). Per-topic FIFO window-read serialization is additionally evidenced (renderer-local `PQueue` concurrency 1 across latest/around latest/older/newer/search-around; distinct topics concurrent; failure advances queue; `queueDepth`/`waitMs` logs; focused tests preserved — Git owns provenance, no hash reproduced here). Same-topic window serialization is evidenced; identical-read single-flight remains intentionally deferred (no global cap).

### 6.8 Phase 7: Startup Architecture

- **Entry**: Phase 2 complete; explicit approval. Conversation-startup depends on Phase 3.
- **Content**: Validate Phase 3 activation effects (ContentSearch/EditMode invocation gating, optional panels); optimize boot services, Redux rehydration, Dexie init, SQLite cold open, bundle loading; background window lifecycle.
- **Exit**: Startup improvements validated (conversation-startup integrated, boot ordering/bundle improved). Cold-open `<500 ms` threshold owned by `performance-measurement.md`, not this program.
- **Dependencies**: Phase 2; Phase 3 for conversation-startup; boot tracks independent.
- **Relationship**: See §8 — conversation tracks enable lazy activation but do not block independent boot optimizations.

### 6.9 Phase 8: Future Sync Decision

- **Entry**: Phases 2-5 structural foundation + governance decision to pursue sync.
- **Content**: Vendor-neutral architecture decisions (cross-device authority, conflict, transport); remaining sync-readiness validation against ARCH-005.
- **Exit**: Sync architecture decisions documented; sync-readiness validated.
- **Dependencies**: Phases 2-5; governance approval required.
- **Interpretation**: ARCH-004 (PowerSync No-Go) is vendor-specific and not a target constraint; target must be vendor-neutral.

---

## 7. DB-Health Sequencing

PERF-DB-HEALTH reclassified per architecture dependency splits.

### 7.1 Independent diagnostics (on demand; no schema ADR)

| Diagnostic | Scope | Dependencies |
|---|---|---|
| **M1** | Middle/batch insert `sort_order` shift — scale curve | None |
| **M2** | Short (<3 codepoint) LIKE full-table scan — stage attribution | None |
| **M3** | Index/query opportunity — query-plan diagnosis | None |
| **M7** | Cold open/load path — DB volume impact attribution | None |
| **M4** | FTS/normalized storage-duplication volume diagnostic — read-only numeric-only aggregation (row counts, char/UTF-8 bytes, FTS smoke; logical duplication only, no observed physical DB size) | None — harness Implemented 2026-08-28, inactive by default (`M4_FTS_DUP_BENCH=1` + `M4_FTS_DUP_SCALE=1k|10k|50k` default 10k), `m4FtsDuplication.bench.ts` + `m4FtsDuplication.ts` + pure helper tests; isolated `mkdtemp` + `registerChatDbNormalize` + `runMigrations` schema-v1 + existing `generateCorpus`; **default 10k executed 2026-08-28 via `pnpm bench:m4-fts-dup` (exit 0, directional evidence only; S6.5 remains Candidate — Not Authorized; 1k/50k/real corpora/physical DB size unresolved; no threshold/baseline/dedup authorization; details in `performance-measurement.md` §6 and `performance-workstreams.md` §2.4)**; harness remains inactive by default for future invocations |
| **M8** | Backup/restore health — L3 archive metadata | None — harness Authorized & Implemented 2026-08-24, inactive by default (`M8_L3_ARCHIVE_BENCH=1`), executed on clean HEAD producing gitignored schema-v1 directional artifact; no baseline/closure/authorization |

All are read-only with respect to production/user state (M8 permitted owned temporary backup/restore writes inside isolated `mkdtemp` root only; M4 is read-only post-seed numeric aggregation). They do not require governance/ADR but require explicit Main/user activation before execution (`performance-program.md`). Harness implementation is not execution and does not authorize S6.5.

### 7.2 Architecture-phase-dependent (requires governance)

| Item | Scope | Dependencies |
|---|---|---|
| **Full-topic/windowed fetch/cache joins** | Data-access contract implementation | Phase 5 contract; implementation is Phase 6 candidate requiring coordinated IPC review |
| **M4** FTS dedup | Volume/write-amplification + schema | ADR |
| **M5** File dual-state consistency | Convergence diagnostic | ADR if touches schema/authority |
| **M6** Sync metadata gap | Schema impact analysis | ADR; analysis only |

### 7.3 Diagnostic calibration summary (directional, non-adoption)

- **C-01 logical payload**, **C-02 heap**, **pinned working-set** calibrations are synthetic, measurement-only, directional, non-adoption. They demonstrate canonical invariants (lexicographic keys, compact JSON, determinism), partition-sum exactness, orphan/non-finite rejection, and single-machine heap-amplification sampling (GC-sensitive, `performance.memory` precise mode). Per-profile values and enlargement ratios are traceable via gitignored artifacts under `test-results/bench-results/` with schema v1; they are not thresholds, baselines, or capacity policies. **C-01 canonical accounting is shared pure cross-runtime infrastructure** (`packages/shared/chatDb/logicalPayload.ts`, `TextEncoder`/`utf8ByteLength`, Buffer parity proved; `phase4-logical-payload-v1`, B-01/B-02/B-05 values, strict boundary semantics, and schema v1/benchmark IDs preserved) — no working-set policy, IPC, persistence, or capacity-threshold adoption. The full Phase 4 sequence is executable on demand via the explicit opt-in composite command `pnpm calibration:phase4` (alias `pnpm bench:phase4-calibration`, `scripts/calibration-phase4.ts`; §6.5.9) which runs in order `pnpm bench:logical-payload` (Node) → `pnpm bench:pinned-working-set` (Node) → `pnpm build` (Electron) → `pnpm test:e2e -- tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts` (Electron, C-02 mixed; `C02_HEAP_CALIBRATION=mixed` injected only into that final child environment via cross-platform `spawnSync` env merge, not shell prefix) with C02 env isolated to the final step, fail-closed per step, and preserves independent schema-v1 artifacts (`logical-retained-payload-calibration`, `pinned-working-set-calibration`, `chatdb-c02-renderer-heap-e2e` under `test-results/`, gitignored, privacy-safe); execution is measurement-only, does not close Phase 4/5, does not adopt B-01..B-05, has no CI auto-invocation, and requires pinned toolchain Node 24.11.1/pnpm 10.27.0. Git log retains run provenance; this program retains only the assessment that full distribution calibration and exercised-workload validation remain Open.
- **M2/M3/M7** clean-HEAD directional evidence demonstrates harness correctness and attribution (50k corpus for M2/M3, ~1k messages for M7) with parity and correctness gates; no index benefit or threshold adoption.
- **M4** default 10k directional evidence — executed 2026-08-28 via `pnpm bench:m4-fts-dup` (exit 0, directional only; S6.5 remains Candidate — Not Authorized; 1k/50k/real corpora/physical DB size unresolved; details in `performance-measurement.md` §6 and `performance-workstreams.md` §2.4).
- **M8** backup/restore harness validates archive safety, authoritative `chat.db` presence, excluded artifact absence, snapshot integrity, and staged restore parity (inside `preExitCleanup` callback) via isolated synthetic fixtures; no real relaunch/startup promotion proven; single-machine synthetic only.

### 7.4 Design contract — M8 Backup/restore (summary)

Contract `chatdb-m8-l3-archive-health` as `main-native` Node lane (ABI 137) with real `better-sqlite3`/`archiver`/`StreamZip`; owned per-sample `mkdtemp` root; three bounded scenarios S0/S1/S1-wide (numeric `scenarioCount=3`); bounded gate details; artifact to `test-results/bench-results` via schema v1; privacy-safe (no message text/paths/credentials). Future invocations remain inactive by default and require separate M8 activation + env gate. No new artifact schema, threshold, or sync implication.

---

## 8. Startup/Memory Relationship

Conversation lifecycle design directly enables:

- **Lazy activation**: Deferred mount of ContentSearch/EditMode/optional panels.
- **Bounded state**: Scoped, GC-able topic projections.

Independent tracks not blocked by conversation refactoring:

| Track | Description | Independence |
|---|---|---|
| App boot services | Service init order/parallelism | Independent |
| Redux rehydration | redux-persist hydration from IndexedDB | Independent |
| Dexie init | IndexedDB upgrade/connection | Independent |
| SQLite cold open | First DB open latency (`<500 ms` in `performance-measurement.md`) | Main-process, independent |
| Bundle loading | JS bundle size/load time | Build/tooling, independent |
| Background windows | Trace viewer, import window lifecycle | Independent, deferrable |

---

## 9. Sync Compatibility

### 9.1 Architecture-first, vendor-neutral

Application architecture leads. Sync adapts to it, never the reverse. Target is vendor-neutral; not optimized for PowerSync or any specific vendor.

### 9.2 Sync-ready properties (ARCH-005)

| Property | Status | Phase |
|---|---|---|
| Clear authority boundaries | Established (documentary; §6.3) | Phase 2 |
| Stable IDs | Partially established (IDs preserved; anchoring contract explicit; cross-device revision is Phase 8) | Existing + Phase 6.6 + Phase 8 |
| Typed explicit commands | Implemented (IPC, aggregate service); target intents defined, slices implemented per §6.7 | Existing + Phase 6.6-6.7 |
| Atomic/idempotent mutations | Partially implemented (transactions, INSERT OR REPLACE); authority-anchored positioning in contract | Phase 6.6 / Phase 6 candidate |
| Deterministic ordering | Implemented (dense `sort_order`); contract defines `sort_order`->`id` with non-claim for cursor stability | Existing + Phase 6.6 |
| Stable/final checkpoints | Identified (Phase 2 §6.3.2; cross-phase enforcement) | Cross-phase |
| Disposable projections | Established (documentary + Phase 6.6 extensions to window/context closure) | Phase 2 + Phase 6.6 |
| Bounded caches | B-06 viewport bound, B-07 scroll snapshot cap/TTL/LRU, B-08 ContentSearch, and B-09 closure retention implemented as renderer-local mechanisms per §6.5.5–§6.5.6 (B-08 disposable with no persistence/StoreSync/IPC/SQLite/schema/resident-topic lifecycle effects; B-07 device-local persistent Keyv cache with TTL/LRU/cap and no IPC/StoreSync/SQLite/schema or governed chat-persistence effects; B-06/B-09 renderer-local enforcement/retention paths retaining existing IPC-backed reads without altering persistence/schema contracts or resident-topic lifecycle, beyond local scope); B-01–B-05 design complete as calibration candidates only, pinned measured; coherent mixed-workload snapshot integration (B-06/B-07/B-08/B-09 bounds via public/local boundaries + resident complete/incomplete/generation/deletion/clear via snapshot/bound scalars; no data retention/policy expansion) and persistent-like exercised-workload validation increment (each cap/eviction/closure through coherent scalar privacy-safe snapshot composition) evidenced; B-01–B-05 retention acceptance remains Open; Phase 4 exit Open | Phase 4 / §6.5 design, exit Open |
| Device-local-state separation | Established (documentary; viewport vs context separated) | Phase 2 + Phase 6.6 |

### 9.3 Must preserve / should enable / must defer / prohibited

| Category | Items |
|---|---|
| **Must preserve** | Clear authority, typed commands, atomic mutations, deterministic ordering, stable/final checkpoint boundary |
| **Should enable** | Disposable projections, bounded caches, device-local separation |
| **Must defer** | Sync schema, metadata, tombstone, conflict engine, vendor adapter, transport, account/E2EE/attachment, production sync path |
| **Prohibited** | Optimizing for PowerSync; adding sync implementation to this program; creating second chat authority |

### 9.4 Stable checkpoint boundary

Only stable/final block checkpoints are future sync candidates (SYNC-004). Streaming persistence may include intermediate states; architecture must enforce the distinction.

### 9.5 JSON `extra` field

`extra` on messages/blocks is a general extension point, not a sync metadata store. Any sync metadata design requires Phase 8 governance.

### 9.6 PowerSync No-Go interpretation

PowerSync No-Go (see [`sync-powersync-spike.md`](./sync-powersync-spike.md)) documented managed-table-as-view conflict with current FTS/trigger schema under zero-production-change constraints. It must not become a target architecture constraint; future decisions are vendor-neutral against §3 qualities.

---

## 10. ADR/Decision Trigger Map

### 10.1 Decision gate: when work must stop

1. **Runtime authority**: Moving chat authority out of Main SQLite -> ADR required.
2. **Persistence/migration/schema**: Altering persistence semantics, schema, or migration steps (governed by `sqlite-migration.md`) -> SQLite migration governance decision.
3. **Shared IPC/preload/cross-process contract**: Changing channels, payload types, or preload surface -> stop; coordinated shared-contract review across shared types/channel definitions, preload exposure, Main handlers; architecture/program approval; formal ADR only when existing governance requires it; coordinated both-side edits mandatory.
4. **Context-window semantics**: Changing anchor or `contextCount` behavior (governed by `context-window.md`) -> context window governance review.
5. **Native/app/window/multi-window lifecycle**: Window/native capability/app lifecycle changes -> governance decision.
6. **Identity/compatibility**: Database names, persistence keys, import schema, compatibility identifiers (governed by `cherry-chat-application-identity.md`) -> Application Identity governance decision.
7. **Release/platform**: Release scope or platform behavior -> Application Identity governance decision.
8. **Sync boundary**: Any sync infrastructure, metadata, transport, vendor, account, and E2EE decisions -> sync governance owner docs (`sync-mvp.md` / `sync-powersync-spike.md`); Phase 8 is activation phase, not authority.

A formal ADR is required where the authoritative owner document/mandated process requires it. The mandatory rule is the decision gate itself.

Renderer component/topic lifecycle is not a decision gate trigger (program-level concern unless it crosses a governed boundary).

### 10.2 Decision phases and triggers

| Decision | Trigger | Governance |
|---|---|---|
| Runtime authority | Any phase | ADR required |
| Persistence/migration/schema | Any phase | SQLite migration governance |
| Shared IPC/preload contract semantics | Any phase | Coordinated review + program approval; formal ADR only when governance requires |
| Context window anchor semantics | Any phase | Context window governance review |
| Native/app/window/multi-window lifecycle | Any phase | Governance decision |
| Identity/compatibility | Any phase | Application Identity governance |
| Release/platform | Any phase | Application Identity governance |
| Sync vendor/transport/account/E2EE | Phase 8 | Sync governance owner docs; Phase 8 is activation phase |
| Conversation ownership model | Phase 2 | **Resolved** (this program §6.3) |

### 10.3 Acceptance model

Each phase requires:

- Documented ownership/quality/contract model.
- Structural/governance/functional validation (performance is directional L3 reference per ARCH-009; PERF-TOPIC-SWITCH/PERF-ECHO are independent Open workstreams per ARCH-011).
- Controlled-regression disposition per ARCH-010 (attributed/disposed or phase stays Open).
- No governance violation.
- Explicit approval for next phase activation.

### 10.4 Open architecture questions and decisions

| Decision | Phase | Status |
|---|---|---|
| Conversation ownership specifics | Phase 2 | **Resolved** (2026-08-19; §6.3) |
| Lazy activation boundaries | Phase 2 | **Resolved** (§6.3.6) |
| Render/state/action graph structure | Phase 3 | **Structurally Complete / Closed 2026-08-21** (S3.1-S3.5) |
| Cache invalidation rules and bounds | Phase 4 | **Design complete; exit Open** — B-06/B-07/B-08/B-09 implemented as renderer-local mechanisms per §6.5.5–§6.5.6; B-01–B-05 calibration candidates only (no thresholds adopted); B-10/B-11 observed preserved; C-01/C-02/pinned directional only; coherent mixed-workload snapshot integration (B-06/B-07/B-08/B-09 via public/local boundaries + resident complete/incomplete/generation/deletion/clear via snapshot/bound scalars; no data retention/policy expansion) and persistent-like exercised-workload validation increment (each cap/eviction/closure through coherent scalar privacy-safe snapshot composition) evidenced; B-01–B-05 retention acceptance remains Open; Phase 4 exit Open |
| Retention/eviction policy design | Phase 4 | **Design complete; exit Open** — pending gates in §6.5.9 |
| Data-access contract (R-02..R-06, completeness, ordering, context) | Phase 5 | **Design complete; exit Open** — intents direction-approved (R-02/R-03 and R-04..R-06); implementation slices S6.1-S6.3 done; §6.6 validation Open (calibration outcomes §6.5.9, §7.3); S6.4/S6.5 Candidate |
| Specific index/query optimizations | Phase 6 | **Candidate S6.4 — Not Authorized**; depends on M1/M2/M3; ADR if schema/index change |
| File dual-state resolution | Phase 6 | **Candidate S6.5 — Not Authorized**; depends on M5; ADR if schema/authority |
| FTS storage dedup | Phase 6 | **Candidate S6.5 — Not Authorized**; depends on M4 (default 10k executed 2026-08-28 via `pnpm bench:m4-fts-dup`, directional only, no threshold/baseline/benefit; 1k/50k/real corpora/physical DB size unresolved; details in `performance-measurement.md` §6 and `performance-workstreams.md` §2.4); ADR if schema |
| Data-access implementation (windowed fetch, authority-aware actions, context closure) | Phase 6 | **S6.1-S6.3 Authorized & Implemented**; S6.4/S6.5 Candidate — Not Authorized |
| Startup improvements | Phase 7 | Open (deferred) |
| Sync architecture decisions | Phase 8 | Open (deferred) |

### 10.5 Cross-document ownership

| Concern | Owner document | Program role |
|---|---|---|
| Identity/compatibility/release/platform | `cherry-chat-application-identity.md` | Not modified |
| SQLite chat authority/migration | `sqlite-migration.md` | Not modified; schema requires ADR |
| Context window anchor semantics | `context-window.md` | Not modified |
| Performance methodology/measurement | `performance-program.md` / `performance-measurement.md` | Not modified; feeds this program |
| Sync boundaries/vendor | `sync-mvp.md` / `sync-powersync-spike.md` | Sync adapts to this program |
| Architecture evolution phases/qualities | **This document** | Owns evolution path |
| Implemented architecture | `architecture.md` | Current reality only |

---

## 11. Related Documents

Cross-document ownership in §10.5. For navigation:

- [`architecture.md`](./architecture.md) — Implemented architecture reference (current reality only).
- [`performance-program.md`](./performance-program.md) — Performance methodology entry.
- [`performance-measurement.md`](./performance-measurement.md) — Measurement contract.
- [`performance-workstreams.md`](./performance-workstreams.md) — Current actionable performance state.
- [`sync-mvp.md`](./sync-mvp.md) — Sync first-phase boundary.
- [`sync-powersync-spike.md`](./sync-powersync-spike.md) — PowerSync No-Go record.
- [`sqlite-migration.md`](./sqlite-migration.md) — SQLite governance.
- [`context-window.md`](./context-window.md) — Context window governance.
- [`cherry-chat-application-identity.md`](./cherry-chat-application-identity.md) — Identity/compatibility governance.
