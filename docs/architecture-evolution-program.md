# Architecture Evolution Program — Cherry Chat Long-Term Structural Correctness

> **Document status**: **Approved Strategy (program-level)**. Canonical program-level source for architecture intent, approved locks, target qualities, debt registry, phased evolution, and decision triggers. Not an ADR; does not override identity, release, platform, SQLite migration, or context-window governance.
> **Authority boundary**: Architecture correctness, elegance, unity, and long-term evolvability lead. Performance symptoms expose architecture debt; performance is validation evidence, not the sole design objective. Startup speed and bounded memory are enablement goals but do not override correctness (ARCH-002). Sync is future compatibility only, vendor-neutral, and must adapt to application architecture — never the reverse.
> **Relation to current architecture reference**: [`architecture.md`](./architecture.md) describes implemented reality only. This program describes target evolution intent.
> **Last updated**: 2026-08-30 — S7.1 implemented closure (600-900 line target). Prior detailed history in Git log; no chained provenance header is maintained.

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

Product benefit and user experience lead among compliant options. Evidence informs decisions, not deliverables: decision evidence, implementation regression evidence, and aggregate delivery validation are distinct and non-substitutable (see `performance-program.md` for the canonical evidence-task contract). Evidence cost scales with risk, irreversibility, uncertainty, and expected reuse; every evidence task binds to a named decision/outcome, claim, minimum sufficient method, and stopping condition. Reversible renderer-local defaults use conservative initial values + focused regression + user-visible observation + rollback without bespoke measurement; formal schema-v1 artifacts are reserved for formal quantitative claims or reusable measurement contracts. Phase closure is outcome/residual-risk based — accepted outcomes + boundary-matched regression + mandatory governance/delivery validation + explicitly accepted residual risk — not harness completeness; B-01..B-05 are implemented renderer-local retention policy defaults (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin), calibration optional/non-blocking, Phase 4 closed 2026-08-29 (outcome/residual-risk).

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
| Whether specific index/query optimizations measurably improve | Closed — S6.4 SQ-01 Rejected 2026-08-29; M2/M3 batch closed | Short (<3 codepoint) LIKE scan retained as observed debt; future optimization requires new candidate with materially different cost structure + fresh four-field contract; see §6.7.1; any schema/index ADR-gated |

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
| **4** | Bounded Memory and Cache | **Closed 2026-08-29 (outcome/residual-risk)** | Phase 2 |
| **5** | Data-Access Contract | **Closed 2026-08-29 (outcome/residual-risk)** | Phase 2 + Phase 4 inputs |
| **6** | DB-Health Implementation | **S6.1–S6.3 Authorized & Implemented; S6.4 SQ-01 Rejected 2026-08-29 — no ADR, no production implementation, current LIKE retained; S6.5 Candidate — Not Authorized; no ready-now DB-health evidence batch** | Phase 5 contract |
| **7** | Startup Architecture | **S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk) — five secondary routes lazy, Home/sidebar/navigation/App gates eager; S7.2+ Open (deferred); no ready-now batch** | Phase 2; Phase 3 for conversation-startup |
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

- **Status**: **Closed 2026-08-29 (outcome/residual-risk)** — renderer resident-topic completeness/applicability-generation registry + same-generation staged joint publication via one dispatch; B-01..B-05 renderer-local retention enforcement (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin) implemented alongside B-06 viewport bound (renderer-local, target max 200 groups), B-07 device-local Keyv scroll cache (renderer-local index, max 256 topics / 90-day TTL LRU), B-08 ContentSearch bound (renderer-local disposable, at most one 500 live-Range chunk), B-09 active-topic retention (max one); bounded scalar resident/read-path diagnostics; evidenced by focused regression (Vitest), direct diagnostic UI observation (diagnostic only, not regression proof; limited non-bottom overflow coverage), independent audit pass, and authoritative `pnpm build:check` pass (exit 0) on exact final worktree; no IPC/SQLite/schema/StoreSync/Main change.
- **Entry**: Phase 2 complete; explicit approval.
- **Content**: Cache invalidation rules, size bounds, retention/eviction design for renderer-side caches; bounded state for resident projections, viewport window, scroll snapshots, ContentSearch handles, context-closure cache (active-topic-only retention); conditional observability for pinned working-set payload (optional, not a phase gate unless bound to an explicitly activated decision/outcome or formal quantitative/reusable claim).
- **Exit**: Must demonstrate bounded evictable caches, explicit pinned exception, invalidation rules, and measurable miss paths. Implementation demonstrated via focused regression (Vitest), direct diagnostic UI observation (diagnostic only, not regression proof), independent audit pass, and authoritative `pnpm build:check` pass on exact final worktree; Phase 4 closed.
- **Dependencies**: Phase 2. Phase 5 windowed reads replace full-topic fetch where window suffices; incremental/delta deferred to Phase 6; active/pinned working-set bounding is Phase 6/governance.

#### 6.5.1 Design constraints

- Retention enforcement (B-01..B-05) and lifecycle foundation (resident registry + staged joint publication) are renderer-local, non-persistent, non-StoreSync (B-07 device-local Keyv scroll persistence excluded), with no IPC/SQLite/schema/StoreSync/Main change. B-06 viewport bound, B-07 scroll snapshot cap/TTL/LRU, B-08 ContentSearch bound, and B-09 active-topic closure retention remain implemented renderer-local per §6.5.5–§6.5.6; B-01..B-05 (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin) are now implemented renderer-local enforcement with the same boundary guarantees; mixed-workload diagnostics coexistence for B-06..B-09 and resident lifecycle plus read-path diagnostics (hit/miss reason, staged latency, discarded attempts via bounded scalars; no IDs/content/histories, no policy) are evidenced via focused regression and diagnostic observation (not regression proof); calibration optional/non-blocking.
- Evictable caches bounded (target design); active/pinned working set excluded from caps, with conditional observability for pinned working-set payload (optional, not a phase gate unless bound to an explicitly activated decision/outcome or formal quantitative/reusable claim).
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

Renderer Redux projections are now bounded by implemented B-01..B-05 (max 8 inactive evictable topics, ≤32 MiB logical budget, 30-minute TTL, LRU/lexical tie-break, oversized fail-closed and evictable after unpin) alongside implemented B-06 viewport (target max 200 groups, opposite-edge trim, anchor-preserving, no entity eviction), B-07 scroll snapshots (max 256 topics, 90-day TTL LRU via renderer-local index), B-08 ContentSearch (at most one 500 live-Range chunk, disposable, no persistence/StoreSync/IPC/SQLite/schema effects), and B-09 context-closure cache (max one active topic; generation/fingerprint/deletion invalidation distinct from retention); data-access remains typed full-topic fetch with staged joint publication; anchor-to-end remains unbounded when `contextCount=null` per design; background stream queues have no global cap; undo 50 and streaming throttle 100/5 min are observed preserved bounds. B-01..B-05 now enforced renderer-local; Phase 4 closed 2026-08-29 (outcome/residual-risk).

#### 6.5.4 Target ownership tiering

```
Authority (Main SQLite) -> Typed full-topic fetch (until Phase 5) -> Renderer entity projection
  |- Pinned working set (active + in-flight) — excluded from caps, conditional observability only (optional, not a phase gate unless bound to an explicitly activated decision/outcome or formal quantitative/reusable claim)
  └- Evictable set (inactive non-pinned) — strictly bounded (B-01..B-11)
     -> Derived projections (viewport, context info, display groups) — disposable
```

#### 6.5.5 Concrete bounds table (capacity defaults — evictable only unless labeled)

B-01..B-05 retention enforcement, B-06 viewport bound, B-07 scroll snapshot cap/TTL/LRU, B-08 ContentSearch bound, and B-09 closure retention are implemented renderer-local mechanisms per §6.5.6; not empirically optimal, not baselines/SLA; calibration optional/non-blocking, measurement-only directional; B-10/B-11 are observed preserved bounds. B-01..B-05 values below are the enforced defaults — not thresholds/baselines.

| # | Bounded subject | Target bound | Applies to | Enforcement | Note |
|---|---|---|---|---|---|
| B-01 | Inactive resident projections | max 8 topics | Evictable | Admission + LRU | **Implemented** — renderer-local; calibration optional; not empirically optimal/baseline/SLA |
| B-02 | Aggregate logical retained payload | max 32 MiB (canonical frame `phase4-logical-payload-v1`) | Evictable | Evict until ≤32 MiB | **Implemented** — renderer-local; heap ratio recorded separately; not a baseline/SLA |
| B-03 | Idle TTL | 30 min idle | Each evictable topic | TTL sweep | **Implemented** — renderer-local; lastAccess = activation or unpin |
| B-04 | Eviction policy | LRU | Evictable | On B-01/B-02 pressure | **Implemented** — renderer-local; recency = last activation/unpin, tie-break topic ID (lexical) |
| B-05 | Single oversized topic | non-admissible after deactivation if >32 MiB alone | Any topic >32 MiB | Evict immediately when not pinned | **Implemented** — renderer-local; fail-closed and evictable after unpin |
| B-06 | Viewport rendered groups | target max 200 groups, 20-group steps, opposite-edge trim | Active viewport | Trim while preserving navigation/scroll anchors | **Implemented** — renderer-local viewport trim; no entity eviction by viewport trim |
| B-07 | Scroll snapshot cache | max 256 topics, 90-day TTL, immediate delete on hard delete | Device-local keyv | LRU+TTL via renderer-local index | **Implemented** — renderer-local LRU+TTL via index; soft-delete retains snapshot |
| B-08 | ContentSearch live handles | max 500 live `Range` handles, bounded descriptors | Per search session | Materialize only current 500-match chunk | **Implemented** — renderer-local disposable session; retains at most one 500 live-Range chunk + lightweight count metadata; cross-chunk navigation rescans current rendered DOM; target/DOM changes invalidate the session; no persistence/StoreSync/IPC/SQLite/schema/resident-topic lifecycle effects |
| B-09 | Context-closure cache (active-topic-only retention) | max one active topic (retention); generation/fingerprint/deletion invalidation distinct from retention | Renderer-local context-closure cache | Active-topic-only retention | **Implemented** — renderer-local context-closure cache; active-topic-only retention (max one active topic); generation/fingerprint/deletion invalidation distinct from retention; unlimited `contextCount` semantics unchanged |
| B-10 | Undo stack | 50 — observed | Renderer edit | Preserved | Not a new Phase 4 policy |
| B-11 | Streaming throttle / queue | 100 per 5 min — observed; no global queue cap | Request pipeline | Preserved | Future cap is Phase 6/governance |

Pinned working set (active + in-flight) is excluded from B-01/B-02 caps with conditional observability only as a separate working-set metric for Phase 6/governance (optional, not a phase gate unless bound to an explicitly activated decision/outcome or formal quantitative/reusable claim).

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

Conditional observability targets (not phase gate unless bound to explicitly activated decision/outcome or formal quantitative/reusable claim): resident topic count (evictable vs pinned), logical bytes per-topic and aggregate vs 32 MiB, heap-amplification ratio, working-set payload, hit/miss by reason, completeness markers/generation, eviction events (TTL/oversized/LRU/deletion), TTL sweep execution, viewport groups/anchor stability, scroll snapshot counts, ContentSearch handles/descriptors, context-closure cache hit/miss. All local, no network export. Phase 4 remains outcome/residual-risk based; B-01/B-02 calibration is optional/non-blocking and does not block closure unless bound to explicitly activated decision/outcome or formal quantitative/reusable claim; calibration would be measurement-only directional with no adoption. Implemented locally as bounded scalar-only: resident entry/completeness/generation via pure adapter plus read-path hit/miss reason, staged latency summaries (success+failure), and discarded publication attempts (post-stage validation only; staged fetch failure before validation is staged failure, not discarded) via renderer-local counters wired from `loadTopicMessagesThunk` and composed into Phase 4 snapshot/bound scalars; no IDs/content/paths/credentials/histories, no persistence/IPC/StoreSync; B-01..B-05 now implemented renderer-local enforcement with the same privacy/boundary guarantees.

#### 6.5.9 Acceptance disposition

Phase 4 closed 2026-08-29 — outcome/residual-risk based per product-first model. Controlled regression and protected boundaries remain mandatory (§10.1). Lifecycle foundation (renderer-local registry + staged joint publication) and B-01..B-09 implemented renderer-local mechanisms per §6.5.5–§6.5.6 are evidenced by focused regression (Vitest), direct diagnostic UI observation (diagnostic only, not regression proof; limited non-bottom overflow coverage), independent audit pass (no IPC/SQLite/schema/StoreSync/Main change), and authoritative `pnpm build:check` pass (exit 0) on exact final worktree. B-01..B-05 are implemented renderer-local retention enforcement (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin), not empirically optimal, not baselines/SLA; calibration optional/non-blocking, measurement-only directional. Accepted residual risks: contextCount=null closure may be large; pinned active/in-flight working set excluded; stream queue has no global cap; logical bytes not heap SLA; tuning may change with future evidence; renderer-local scalar observability only; PERF workstreams remain independent/open (ARCH-011). Exit satisfied accepted outcomes + boundary-matched regression + governance/delivery validation + explicitly accepted residual risk — not harness completeness.


### 6.6 Phase 5: Data-Access Contract

- **Status**: **Closed 2026-08-29 (outcome/residual-risk)** — R-02..R-06 satisfied by existing S6.1-S6.3 implementation with boundary-matched static + Vitest + Playwright 10/10 (six-spec, preceding test state) plus final S6.2 focused 3/3 (three independent disposable profiles, final test state covering later semantic delta) and authoritative `pnpm build:check` exit 0 on exact final code/test state; closure accepted after final gate; calibration/harness completeness not gating.
- **Entry**: Phase 1 complete; Phase 2 complete; Phase 4 design complete as input; explicit approval. M1/M2/M3/M7 diagnostics are independent and do not gate this design.
- **Content**: Stable-ID-anchored windowed read intents, deterministic `sort_order`->`id` ordering, completeness semantics, renderer-local generation applicability, separate viewport vs context projections, mutation/stream/cache rules.
- **Exit**: Validates scoped window/closure reads with defined counting units, typed completeness with validated derivation, deterministic ordering with stable-ID anchoring, separate projections with renderer-owned anchor, pinned streams with structural vs content-only invalidation, and deferred window eviction granularity. Satisfied by S6.1-S6.3 evidenced implementation.
- **Dependencies**: Phase 2; Phase 4 capacity defaults; Phase 3 stable host.

#### 6.6.1 Design constraints

- At the design-review stage: documentation only; implementation and `architecture.md` edits were excluded.
- Main SQLite remains sole chat authority.
- Intents anchored by stable IDs (topic/message), not tuple cursors; intra-response deterministic order `sort_order`->`id`.
- Completeness is semantic (`whole-topic`/`window`/`answer-group`/`context closure`); partial never masquerades as complete; empty requires explicit marker.
- Renderer generation/request tokens are applicability only, not authority versions.
- Viewport and context are separate disposable projections; context preserves stable anchor-to-end and exactly-once repair; unlimited context may enlarge pinned working set with conditional observability for working-set enlargement (optional, not a phase gate unless bound to an explicitly activated decision/outcome or formal quantitative/reusable claim; not truncated).
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
- Viewport `displayGroups`/`displayCount` not redefined by this contract; pinned topics excluded from B-01/B-02 with conditional observability for pinned working-set payload (optional, not a phase gate unless bound to an explicitly activated decision/outcome or formal quantitative/reusable claim).

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

Coordinated-review precondition for R-02..R-06 is executed and direction-approved. Phase 5 closed 2026-08-29 (outcome/residual-risk); calibration (§6.5.9, §7.3) remains optional/non-blocking, measurement-only directional. Decision lock LOCK-P5-005 (no concrete value selection) preserved.

#### 6.6.10 Acceptance disposition

Phase 5 closed 2026-08-29 — outcome/residual-risk based. R-02..R-06 validated via boundary-matched static + Vitest + Playwright 10/10 (six-spec, preceding test state) plus final S6.2 focused 3/3 (three independent disposable profiles, final test state covering later semantic delta) and authoritative `pnpm build:check` exit 0 on exact final code/test state; closure accepted after final gate; preserves Main SQLite authority, stable-ID anchoring, deterministic `sort_order`->`id`, semantic completeness isolation, viewport/context separation, generation applicability-only, coordinated IPC contract. Accepted residual risks: no tuple-cursor/revision/snapshot/linearizability; unbounded context closure when governed anchor requires it; active/in-flight/window-read pinned working set and per-topic FIFO have no global cap/progress guarantee; active-topic-only closure retention may refetch; coarse renderer invalidation/fingerprint remain implementation risks; S6.4/S6.5 and PERF workstreams remain open/independent. Calibration remains optional/non-blocking, measurement-only directional; LOCK-P5-005 preserved.

### 6.7 Phase 6: DB-Health Implementation

- **Status**: **S6.1–S6.3 Authorized & Implemented; S6.4 SQ-01 Rejected 2026-08-29 — no ADR, no production implementation, current LIKE retained; S6.5 Candidate — Not Authorized; M2/M3 evidence batch closed; no ready-now DB-health batch**. Per-slice explicit approval required; Phase 5 closed 2026-08-29, Phase 6 partially Open (S6.4 closed by rejection); no capacity-threshold adoption.
- **Entry**: Phase 5 contract complete; calibration inputs per slice as needed; governance/ADR for any schema changes (M4/M5/M6).
- **Exit (per-slice)**: Slice-specific acceptance validated without violating contract invariants and without adopting a threshold unless owned by `performance-measurement.md`.
- **Dependencies**: Phase 5 contract; Phase 4 calibration where sizing touched; governance/ADR.
- **Activation**: Not activated by this program; per-slice approval separate.

| Slice | Description (contract targets) | Prerequisites | Acceptance | Rollback | Status |
|---|---|---|---|---|---|
| **S6.1** Windowed read contract | R-02 latest + R-03 around as typed `chatdb:fetch-messages-window` with `window` completeness, declared bounds, deterministic order, empty vs NOT_FOUND | Phase 5 contract; coordinated review | Viewport uses R-02/R-03 with coverage checks | Revert consumers to R-01; remove window IPC | **Authorized & Implemented 2026-08-22** |
| **S6.2** Authority-aware actions | Main-authoritative answer-group (R-05), stable-anchor branch/insert, R-04 search-hit around-window with not-found fallback | Same + S6.1 beneficial | Group via Main never window-inferred; branch/insert via stable anchor | Remove authority-aware IPC paths; restore prior projection-only paths | **Authorized & Implemented 2026-08-23** |
| **S6.3** Context closure & cache joins | R-06 anchor-to-end closure (renderer-owned anchor; Main reads rows only), cache-join for context-info, exactly-once repair | Phase 5 contract; context-window governance if semantics changed | Closure separate from viewport; unlimited measured not truncated; repair exactly once | Remove closure read path; restore renderer-computed `computeContextInfo` | **Authorized & Implemented — contract/Main (2026-08-23), renderer cache-join (2026-08-23), bounded anchor/viewport repair (2026-08-24)** |
| **S6.4** Short-query candidate SQ-01 (≤2-codepoint gram projection) — **Rejected 2026-08-29** | Derived auxiliary 1–2 codepoint gram projection — distinct contiguous substrings of normalized main_text keyed by (gram, block_id); terms <3 indexed gram lookup, ≥3 trigram FTS; per-term intersect; exact regex owns whole-word/CJK matching only; search ordering preserved `created_at -> message.id -> block_id` (evidence wording correction only; not an `architecture.md` contract change); independent from M1 and S6.5 | M2/M3 short-query diagnostic; ADR if schema/index | Rejected — see §6.7.1 for decision, rationale, and evidence basis | Remove auxiliary projection/index; restore LIKE path (disposed) | **Rejected 2026-08-29 — no ADR, no production implementation; current LIKE retained** |
| **S6.5** File dual-state & FTS dedup | File consistency (M5) if proven real; FTS dedup (M4) if beneficial | M4/M5 evidence; ADR | Consistency/dedup benefit demonstrated | Revert storage/dual-state changes | **Candidate — Not Authorized** |

Notes: S6.1/S6.2 concrete request bounds (`limit`/`before`/`after` each 1..100) are validation bounds, not product defaults or eviction policy. S6.3 has no 1..100 bound (closure is anchor-to-newest). All slices preserve authority boundaries, `listByTopicPage` sufficiency remains unvalidated under concurrent dense-order mutation (window reads use stable-ID anchoring in one transaction). Per-topic FIFO window-read serialization is additionally evidenced (renderer-local `PQueue` concurrency 1 across latest/around latest/older/newer/search-around; distinct topics concurrent; failure advances queue; `queueDepth`/`waitMs` logs; focused tests preserved — Git owns provenance, no hash reproduced here). Same-topic window serialization is evidenced; identical-read single-flight remains intentionally deferred (no global cap). Renderer-only regression coverage (windowReadQueue: distinct-topic concurrency, per-topic FIFO, rejection progression; messageWindow: B-06 max-200 opposite-edge trimming with deterministic ranges, anchor retention, hasMore) is implemented via focused renderer suites and independently audited/passed with `pnpm build:check` passing on the exact code state; no new production behavior, thresholds, baselines, or phase closure.

#### 6.7.1 S6.4 Short-Query Candidate SQ-01 — Rejected 2026-08-29 (decision closed)

Prior review 2026-08-29 Need Specific Evidence (ARCH-001..012 unchanged; no production code/tests/schema/index/migration/IPC/StoreSync/S6.5/sync/startup/retention/threshold/baseline/SLA/`architecture.md` change; M1 dense-order O(N) shifts, M2 <3-codepoint LIKE scan with trigram FTS unable to serve <3 and no alternative evaluated, M3 current-plan diagnosis — all directional only; M1 and M2/M3 independent, evidence not pooled; any schema/index ADR-gated) authorized only an isolated disposable synthetic comparison. Candidate shape was finite and production-not-authorized: derived auxiliary 1–2 Unicode-codepoint gram projection keyed by (gram, block_id) for exact gram lookup (codepoints not UTF-16 units) of normalized main_text; terms ≥3 retain trigram FTS, terms <3 use indexed gram lookup with per-term AND; exact regex remains authority for whole-word/CJK matching only; independent from M1 and S6.5.

Decision outcome: SQ-01 **Rejected 2026-08-29**. No ADR and no production design/implementation follows. Current production behavior remains unchanged: <3 codepoint normalized LIKE fallback, ≥3 trigram FTS, exact regex matching authority, actual SearchRepository deterministic order `created_at -> message.id -> block_id`, cursor/pagination and failure semantics unchanged. M2/M3 evidence batch closed; no ready-now Phase 6/DB-health architecture batch remains.

Rationale (architecture cost allocation, not threshold): indexed SEARCH and exact tested parity were demonstrated, but the candidate imposes global character-proportional auxiliary rows, substantial directional storage growth scaling with normalized content, and trigger maintenance on hot insert/update/delete paths to optimize only the <3-codepoint search fallback. This is an unfavorable architecture cost allocation. Do not reinterpret as “no query improvement” or threshold failure.

Evidence basis without raw values: one disposable non-production synthetic comparison was executed as decision evidence only (isolated harness/prototype, no real user data) and independently audited pass-with-findings with zero blockers and one acceptable rollback-lifecycle limitation. Accepted: exact tested semantic parity across tested cases (including Unicode codepoint≠UTF-16 boundaries, ASCII/CJK/astral-plane/emoji/supplementary, substring + whole-word where regex owns matching only, mixed short+long, escaping/special, Markdown stripping, CRLF/CR normalization, lowercasing, empty/not-found, newest/oldest, multi-page cursor duplicate-free, malformed-cursor non-silent error parity, and database/candidate-source non-silent failure propagation parity) and deterministic EXPLAIN improvement from SCAN to SEARCH for short candidate collection (≥3 trigram path unchanged). Directional evidence showed auxiliary row/projection count scales with normalized content, storage materially adverse, and write amplification via triggers on hot paths; read improvement directional only. Design tradeoff rejected. Synthetic evidence does not become baseline/threshold/SLA. Ordering correction: evidence preserved actual current search order `created_at -> message.id -> block_id` — this wording correction is evidence-only; no `architecture.md`/governance change; future candidate evidence must verify parity against actual current deterministic SearchRepository order (`created_at -> message.id -> block_id`).

Accepted residuals: <3-codepoint LIKE scan cost remains; no production storage/write cost incurred; no threshold/baseline/SLA adopted.

Cleanup: disposable evidence package (harness, DB, artifacts, raw values, logs, node_modules, prototype) fully removed; Git history and this concise durable decision own outcome. No production code/test/schema/index/migration/ADR/`architecture.md`/package/config/IPC/StoreSync/sync/startup/M1/S6.5/retention change.

Future reopening boundary: SQ-01 may not be silently revived. Future short-query optimization requires a new explicitly defined candidate with materially different cost structure and a fresh four-field evidence contract (named decision/outcome, claim, minimum sufficient method, stopping condition) before any evidence work counts as progress.

### 6.8 Phase 7: Startup Architecture

- **Status**: **S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk)** — renderer-only lazy five secondary routes; Home/sidebar/navigation/App gates eager. **Phase 7 remains partially Open — S7.2+ Open (deferred); no next ready-now batch authorized.** No other Phase 7 slice authorized; Main startup reorder, Antd locale splitting, Inputbar changes, telemetry/retention/deletion deferral remain not authorized.
- **Entry**: Phase 2 complete; explicit approval. Conversation-startup (S3.5) already closed; S7.1 independent of Phase 4/5/6 and does not depend on M4/M5/M6.
- **Exit (S7.1)**: Implemented outcome satisfies renderer-only bundle/activation boundary — five secondary routes separately lazy-loaded with distinct production chunks and Home eager; bounded localized loading scoped to route outlet; tagged chunk-load recovery with retry/Home affordance, untagged render errors bubble to global boundary; no governance crossing; evidenced by production-build distinct chunks + focused Vitest + fresh-build shared-fixture Playwright (all five routes rendered, resource deltas verified) + diagnostic observation + independent audit + authoritative `pnpm build:check`; residual risks accepted.
- **Dependencies**: Phase 2; Phase 3 stable host for conversation-startup (already satisfied). S7.1 touches only renderer bundle/activation; no Main/preload/shared/IPC/SQLite/Dexie/StoreSync/identity/sync/context-window dependency.
- **Relationship**: See §8 — S7.1 is the bundle/activation track; conversation lazy activation (S3.5) remains distinct and not duplicated; independent boot-service tracks remain deferred under S7.2+.

#### 6.8.1 Reconnaissance (2026-08-29, docs-only)

Observed current-state facts at authorization time: `src/renderer/src/Router.tsx` eagerly statically imports `HomePage`, `FilesPage`, `NotesPage`, `KnowledgePage`, `SettingsPage`, `LaunchpadPage` and mounts them via `<Routes>` inside `<HashRouter>` with `<Sidebar />` and `<NavigationHandler />` always rendered; `src/renderer/src/App.tsx` provider/gate chain (`Provider` → `QueryClientProvider` → `StyleSheetManager` → `ThemeProvider` → `AntdProvider` → `NotificationProvider` → `CodeStyleProvider` → `PersistGate` → `SidebarWidthInitializer` → `CatalogHandoffBoundary` → `ImportProjectionGate` → `TopViewContainer` → `Router`) is eager and unchanged; `/` (`HomePage`) is the first-window critical route. Main startup reorder candidates were considered and not selected due to lifecycle races. Existing S3.5 ContentSearch (parent-owned lazy mount) and EditMode (light gate) lazy activation must not be duplicated by S7.1.

#### 6.8.2 S7.1 Implemented Outcome — Renderer-Only Lazy Secondary Routes (2026-08-30, outcome/residual-risk)

**Outcome**: Five secondary top-level routes (`FilesPage`/`NotesPage`/`KnowledgePage`/`SettingsPage`/`LaunchpadPage` at `/files`, `/notes`, `/knowledge`, `/settings/*`, `/launchpad`) lazy-loaded as separate production chunks; `HomePage`/`Sidebar`/`NavigationHandler`/full `App` provider/gate chain (`Provider`→`QueryClientProvider`→`StyleSheetManager`→`ThemeProvider`→`AntdProvider`→`NotificationProvider`→`CodeStyleProvider`→`PersistGate`→`SidebarWidthInitializer`→`CatalogHandoffBoundary`→`ImportProjectionGate`→`TopViewContainer`→`Router`) remain eager; route paths, navigation semantics, layout/sidebar continuity, and provider contexts preserved; localized bounded loading scoped to route outlet; tagged chunk-load failures present explicit recovery with retry/Home affordance; untagged render errors bubble to global boundary; renderer-only — no Main/preload/shared IPC, SQLite/Dexie, persistence, StoreSync, identity/sync/context-window change; `architecture.md` describes implemented reality only; one semantic revert to eager imports, no migration.

**Verification**: Production build distinct chunks (five secondary separate, Home eager) + focused Vitest (eager Home vs lazy secondary, bounded fallback, tagged recovery) + fresh-build shared-fixture Playwright (eager Home plus all five secondary routes rendered, verified via route-associated resource deltas) + diagnostic `ui:observe` on representative routes (not regression proof) + independent audit pass + authoritative `pnpm build:check` (exit 0) on exact implementation worktree; no threshold/baseline/SLA; ARCH-010 disposition satisfied.

**Residual risks (accepted)**: First navigation transient loading; retry best-effort if underlying resource remains unavailable; chunk count/topology may evolve; E2E uses route-associated resource deltas not names; diagnostics limited to representative routes and not regression proof; PERF workstreams independent/open.

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
| **M4** | FTS/normalized storage-duplication volume diagnostic — read-only numeric-only aggregation (row counts, char/UTF-8 bytes, FTS smoke; logical duplication only, no observed physical DB size) | None — harness implemented, inactive by default (`M4_FTS_DUP_BENCH=1` + `M4_FTS_DUP_SCALE=1k|10k|50k` default 10k), `m4FtsDuplication.bench.ts` + `m4FtsDuplication.ts` + pure helper tests; isolated `mkdtemp` + `registerChatDbNormalize` + `runMigrations` schema-v1 + existing `generateCorpus`; 1k/10k/50k synthetic profiles are measurement-only directional L3 via `pnpm bench:m4-fts-dup` (no threshold/baseline/dedup authorization; S6.5 remains Candidate — Not Authorized; real corpora/physical DB size unresolved; provenance in Git, exact metrics in `performance-measurement.md` §6 summary); requires explicitly activated decision/outcome + four fields to count as valid/progress; future runs inactive by default |
| **M5** | File dual-state consistency — bounded synthetic parity/divergence diagnostic | None — harness Implemented and executed as measurement-only directional L3 (`M5_FILE_DUAL_BENCH=1`, `pnpm bench:m5-file-dual-state`, small/medium bounded profiles, inactive by default); no user data/real profile/ZIP/Dexie/Files/path/content/credential/raw DB size; no production authority/schema/IPC/persistence change, no runtime-consistency proof, no S6.5 authorization or phase closure |
| **M8** | Backup/restore health — L3 archive metadata | None — harness Authorized & Implemented, inactive by default (`M8_L3_ARCHIVE_BENCH=1`), measurement-only directional L3 with gitignored schema-v1 artifact; no threshold/baseline/closure/authorization; future runs inactive by default; requires explicitly activated decision/outcome + four fields to count as valid/progress; detailed per-run values and provenance in Git history, not reproduced here |

All are read-only with respect to production/user state (M8 permitted owned temporary backup/restore writes inside isolated `mkdtemp` root only; M4 is read-only post-seed numeric aggregation; M5 uses only owned synthetic SQLite rows plus explicit synthetic catalog/physical booleans). They do not require governance/ADR but require explicitly activated decision/outcome with all four evidence-task fields before execution can count as valid/progress (`performance-program.md` §4B); explicit activation alone is insufficient. Harness implementation or synthetic execution is not production authorization and does not authorize S6.5.

**Current DB-health frontier:** S6.4 SQ-01 Rejected 2026-08-29 — no ADR, no production implementation, current LIKE retained; M2/M3 evidence batch closed. M4 bounded synthetic profiles (1k, 10k, and 50k) and the bounded M5 small/medium synthetic matrix are implemented/executed only as measurement-only directional L3 evidence. M5 does not access user data or real profile/ZIP/Dexie/Files state and emits no paths, content, credentials, or observed raw DB size. Real-corpus/physical-size evidence and any production file dual-state resolution remain unresolved; M5 future runs are inactive by default. No production authority/schema/IPC/persistence behavior changed; no threshold/baseline/capacity/eviction/policy, runtime-consistency proof, S6.5 authorization, or Phase 4/5/6 closure follows. Any real-corpus/physical-size diagnostic or production S6.5 work remains ADR/governance-gated; no DB-health evidence batch ready and no ready-now Phase 6/DB-health architecture batch remains.

### 7.2 Architecture-phase-dependent (requires governance)

**B-01..B-05 / M6 status:** B-01..B-05 are implemented renderer-local retention enforcement (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin), not empirically optimal/baselines/SLA; calibration harness optional/non-blocking, inactive by default, measurement-only directional. M6 remains analysis-only with no schema/migration/sync design. M6's fixed fingerprint is 4 `schema-absent` categories (`revision-version`, `ordering-cursor`, `deletion-tombstone`, `outbox-checkpoint`) and 5 `open-design` categories (`device-local-leakage`, `idempotence-atomicity`, `checkpoint-boundary`, `conflict-matrix`, `extra-field-governance`); its scoped inventory is 5 required structural tables (`topics`, `messages`, `message_blocks`, `topic_segments`, `topic_segment_messages`) plus 1 explicitly excluded `file_references` table, with 11 excluded sync domains tracked separately. No execution provenance is recorded here until an actual run exists.

| Item | Scope | Dependencies |
|---|---|---|
| **Full-topic/windowed fetch/cache joins** | Data-access contract implementation | Phase 5 contract; S6.1–S6.3 implemented; S6.4 SQ-01 Rejected 2026-08-29 (no ADR, current LIKE retained); S6.5 Candidate — Not Authorized |
| **M4** FTS dedup | Volume/write-amplification + schema | ADR |
| **M5 production resolution** | File dual-state consistency/authority resolution | M5 synthetic directional evidence; ADR/governance if production schema/authority is touched |
| **M6** Sync metadata gap | Schema impact analysis | ADR; **harness Implemented, inactive by default, not yet executed; analysis-only, no schema/migration/sync design** |

### 7.3 Diagnostic calibration summary (directional, non-adoption)

- **C-01 logical payload**, **C-02 heap**, **pinned working-set** calibrations are synthetic, measurement-only, directional, non-adoption. They demonstrate canonical invariants (lexicographic keys, compact JSON, determinism), partition-sum exactness, orphan/non-finite rejection, and single-machine heap-amplification sampling (GC-sensitive, `performance.memory` precise mode). Per-profile values and enlargement ratios are traceable via gitignored artifacts under `test-results/bench-results/` with schema v1; they are not thresholds, baselines, or capacity policies. **C-01 canonical accounting is shared pure cross-runtime infrastructure** (`packages/shared/chatDb/logicalPayload.ts`, `TextEncoder`/`utf8ByteLength`, Buffer parity proved; `phase4-logical-payload-v1`, B-01/B-02/B-05 values, strict boundary semantics, and schema v1/benchmark IDs preserved) — no working-set policy, IPC, persistence, or capacity-threshold adoption. The full Phase 4 sequence is executable on demand via the explicit opt-in composite command `pnpm calibration:phase4` (alias `pnpm bench:phase4-calibration`, `scripts/calibration-phase4.ts`; §6.5.9) which runs in order `pnpm bench:logical-payload` (Node) → `pnpm bench:pinned-working-set` (Node) → `pnpm build` (Electron) → `pnpm test:e2e -- tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts` (Electron, C-02 mixed; `C02_HEAP_CALIBRATION=mixed` injected only into that final child environment via cross-platform `spawnSync` env merge, not shell prefix) with C02 env isolated to the final step, fail-closed per step, and preserves independent schema-v1 artifacts (`logical-retained-payload-calibration`, `pinned-working-set-calibration`, `chatdb-c02-renderer-heap-e2e` under `test-results/`, gitignored, privacy-safe); execution is measurement-only, does not close Phase 5 (Phase 4 already closed via outcome/residual-risk), does not adopt B-01..B-05, has no CI auto-invocation, and requires pinned toolchain Node 24.11.1/pnpm 10.27.0. Git log retains run provenance; this program retains only the assessment that full distribution calibration and exercised-workload validation remain Open.
- **M2/M3/M7** clean-HEAD directional evidence demonstrates harness correctness and attribution (50k corpus for M2/M3, ~1k messages for M7) with parity and correctness gates; no index benefit or threshold adoption.
- **M4** 1k, 10k, and 50k synthetic directional evidence — via `pnpm bench:m4-fts-dup` (directional only, measurement-only; S6.5 remains Candidate — Not Authorized; real corpora and physical DB size remain unresolved; provenance in Git, exact metrics in `performance-measurement.md` §6 summary and `performance-workstreams.md` §2.4). Further M4 real-corpus/physical-size work requires explicitly activated decision/outcome + four fields and governance/ADR; no DB-health production batch is Ready now.
- **M8** backup/restore harness validates archive safety, authoritative `chat.db` presence, excluded artifact absence, snapshot integrity, and staged restore parity (inside `preExitCleanup` callback) via isolated synthetic fixtures; no real relaunch/startup promotion proven; single-machine synthetic only.
- **B-01..B-05** calibration harness is implemented, inactive by default, optional/non-blocking; B-01..B-05 are now enforced renderer-local retention and the harness remains measurement-only directional — not thresholds/baselines/capacity eviction adoption beyond implemented defaults. Phase 4 closed 2026-08-29 (outcome/residual-risk).
- **M6** synthetic sync metadata gap harness is **harness Implemented, inactive by default, not yet executed**; it is analysis-only and does not define schema, migration, sync design, or authorization. Exact execution provenance is intentionally absent until an actual run is recorded.

### 7.4 Design contract — M8 Backup/restore (summary)

Contract `chatdb-m8-l3-archive-health` as `main-native` Node lane (ABI 137) with real `better-sqlite3`/`archiver`/`StreamZip`; owned per-sample `mkdtemp` root; three bounded scenarios S0/S1/S1-wide (numeric `scenarioCount=3`); bounded gate details; artifact to `test-results/bench-results` via schema v1; privacy-safe (no message text/paths/credentials). Future invocations remain inactive by default and require separate M8 activation + env gate. No new artifact schema, threshold, or sync implication.

---

## 8. Startup/Memory Relationship

Conversation lifecycle design directly enables:

- **Lazy activation (S3.5)**: Deferred mount of ContentSearch/EditMode/optional panels — closed, not duplicated by S7.1.
- **Bounded state**: Scoped, GC-able topic projections (Phase 4).
- **Bundle/activation boundary (S7.1)**: Secondary top-level routes deferred to separate chunks while `/` chat remains eager — renderer-only, no Main/IPC/schema boundary.

Independent/deferred tracks not blocked by S7.1 (S7.2+ deferred):

| Track | Description | Independence | Status |
|---|---|---|---|
| App boot services | Service init order/parallelism | Independent | S7.2+ deferred (not selected, lifecycle races) |
| Redux rehydration | redux-persist hydration from IndexedDB | Independent | Deferred |
| Dexie init | IndexedDB upgrade/connection | Independent | Deferred |
| SQLite cold open | First DB open latency (`<500 ms` in `performance-measurement.md`) | Main-process, independent | Deferred |
| Bundle loading (S7.1) | Secondary route chunks (Files/Notes/Knowledge/Settings/Launchpad) — five secondary lazy, Home eager, localized fallback, tagged retry/Home recovery; renderer-only, distinct production chunks | Build/tooling, renderer-only | **S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk); S7.2+ deferred; no ready-now batch** |
| Background windows | Trace viewer, import window lifecycle | Independent, deferrable | Deferred |

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
| Bounded caches | B-01..B-09 implemented renderer-local per §6.5.5–§6.5.6 (B-01..B-05: max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin; B-08 disposable; B-07 device-local Keyv; B-06/B-09 renderer-local, no IPC/SQLite/schema/StoreSync/Main change); evidenced via focused regression (Vitest), direct diagnostic UI observation (diagnostic only, not regression proof; limited non-bottom overflow coverage), and independent audit pass (scalar-only, privacy-safe; no data retention) plus authoritative `pnpm build:check` pass; calibration optional/non-blocking, not thresholds/baselines/SLA, conditional observability for pinned working-set payload (optional, not a phase gate unless bound to an explicitly activated decision/outcome or formal quantitative/reusable claim); Phase 4 closed 2026-08-29 (outcome/residual-risk) | Phase 4 / §6.5 enforcement, closed |
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

- Documented ownership/quality/contract model and accepted outcome.
- Boundary-matched implementation regression evidence (structural/governance/functional; performance is directional L3 reference per ARCH-009; PERF-TOPIC-SWITCH/PERF-ECHO are independent Open workstreams per ARCH-011).
- Controlled-regression disposition per ARCH-010 (reproducible material degradation under controlled same-state comparison attributed/disposed or phase stays Open).
- No governance/protected-boundary violation and mandatory `pnpm build:check` delivery validation for the exact worktree state.
- Explicitly accepted residual risk and explicit approval for next phase activation.
- Harness completeness alone never closes a phase; phases close on the five items above.

### 10.4 Open architecture questions and decisions

| Decision | Phase | Status |
|---|---|---|
| Conversation ownership specifics | Phase 2 | **Resolved** (2026-08-19; §6.3) |
| Lazy activation boundaries | Phase 2 | **Resolved** (§6.3.6) |
| Render/state/action graph structure | Phase 3 | **Structurally Complete / Closed 2026-08-21** (S3.1-S3.5) |
| Cache invalidation rules and bounds | Phase 4 | **Closed 2026-08-29 (outcome/residual-risk)** — B-01..B-09 enforced renderer-local per §6.5.5–§6.5.6 (B-01..B-05: max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin), not thresholds/baselines/SLA, calibration optional/non-blocking, measurement-only directional; evidenced by focused regression (Vitest), direct diagnostic UI observation (diagnostic only, not regression proof), independent audit pass (scalar-only, privacy-safe), and authoritative `pnpm build:check` pass; residual risks accepted (contextCount=null large, pinned working set excluded, no global stream cap, logical bytes not heap SLA, tuning may change, PERF independent/open) |
| Retention/eviction policy design | Phase 4 | **Closed 2026-08-29** — B-01..B-05 renderer-local enforcement implemented and enforced; outcome/residual-risk closure per §6.5.9 |
| Data-access contract (R-02..R-06, completeness, ordering, context) | Phase 5 | **Closed 2026-08-29 (outcome/residual-risk)** — R-02..R-06 satisfied by S6.1–S6.3; calibration optional/non-blocking; S6.4 SQ-01 Rejected 2026-08-29 (no ADR, current LIKE retained); S6.5 Candidate — Not Authorized |
| Specific index/query optimizations | Phase 6 | **S6.4 SQ-01 Rejected 2026-08-29 — no ADR, no production implementation; current LIKE retained; M2/M3 batch closed** — prior 2026-08-29 Need Specific Evidence rationale preserved concisely in §6.7.1; accepted exact tested parity and deterministic SEARCH improvement, but directional storage scales with normalized content and trigger maintenance adds hot-write cost — unfavorable cost allocation (not threshold failure); synthetic evidence not a baseline/threshold/SLA; see §6.7.1 for decision, rationale, ordering correction (`created_at -> message.id -> block_id` evidence-only) and future reopening boundary (new candidate with materially different cost structure + fresh four-field contract; SQ-01 not silently revived); any schema/index remains ADR-gated |
| File dual-state resolution | Phase 6 | **Candidate S6.5 — Not Authorized**; depends on M5; ADR if schema/authority |
| FTS storage dedup | Phase 6 | **Candidate S6.5 — Not Authorized**; bounded synthetic M4 profiles (1k/10k/50k) are complete as directional evidence, but no threshold/baseline/benefit or production authorization follows; real-corpus/physical-size evidence remains unresolved; exact metrics in `performance-measurement.md` §6 and status summary in `performance-workstreams.md` §2.4; any further diagnostic or production work requires an explicit decision, privacy review where applicable, and governance/ADR |
| Data-access implementation (windowed fetch, authority-aware actions, context closure) | Phase 6 | **S6.1–S6.3 Authorized & Implemented**; **S6.4 SQ-01 Rejected 2026-08-29 (no ADR, current LIKE retained; M2/M3 batch closed; no ready-now DB-health batch)**; S6.5 Candidate — Not Authorized |
| Startup improvements (S7.1) | Phase 7 | **S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk) — five secondary routes lazy as distinct production chunks, Home/sidebar/navigation/App gates eager; localized bounded loading; tagged chunk-load recovery with retry/Home, untagged bubble global; renderer-only, no governance crossing; verification: production distinct chunks + focused Vitest + fresh-build shared-fixture Playwright (route-associated resource deltas, all five rendered) + diagnostic observation + independent audit + authoritative `pnpm build:check`; no threshold/baseline/SLA; rollback one semantic revert, no migration; Phase 7 remains partially Open (S7.2+ deferred); no ready-now batch** |
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
