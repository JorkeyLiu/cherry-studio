# Architecture Evolution Program — Cherry Chat Long-Term Structural Correctness

> **Document status**: **Approved Strategy (program-level)**. Canonical program-level source for architecture intent, approved locks, target qualities, debt registry, phased evolution, and decision triggers. Not an ADR; does not override identity, release, platform, SQLite migration, or context-window governance.
> **Authority boundary**: Architecture correctness, elegance, unity, and long-term evolvability lead. Performance symptoms expose architecture debt; performance is validation evidence, not the sole design objective. Startup speed and bounded memory are enablement goals but do not override correctness (ARCH-002). Sync is future compatibility only, vendor-neutral, and must adapt to application architecture — never the reverse.
> **Relation to current architecture reference**: [`architecture.md`](./architecture.md) describes implemented reality only. This program describes target evolution intent.
> **Last updated**: 2026-09-02 — S7.13 Startup Stage Instrumentation Implemented & Closed (attribution-only instrumentation, bounded privacy-safe closed records; no production optimization, baseline, SLA, or threshold; S7.14+ deferred, later production optimization not authorized; residual risk: no fresh enabled Electron runtime E2E executed); S7.12 Startup Critical-Path Attribution retained (attribution-only, no production optimization, timing-dominant unknown); M4/M5 synthetic batch accepted (M4 `chatdb-m4-fts-duplication-50k` 50k + M5 `chatdb-m5-file-dual-state` medium, derived; S6.5 Candidate — Not Authorized); S7.1–S7.13 retained. Git owns history; no chained provenance.

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
| **7** | Startup Architecture | **S7.1–S7.13 Implemented & Closed 2026-09-02 (outcome/residual-risk; S7.12 attribution-only, S7.13 attribution-only instrumentation, bounded privacy-safe, no production optimization/baseline/SLA/threshold); S7.14+ deferred — See §6.8.2–§6.8.14; S7.12 topology-only attribution closed with no production optimization; S7.13 instrumentation closed with no production optimization; Phase 7 remains partially Open (S7.14+ deferred, later production optimization not authorized); no ready-now batch without explicit activation** | Phase 2; Phase 3 for conversation-startup |
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

All intents use stable-ID anchoring; deterministic return order `sort_order`->`id` within single authority transaction; no tuple-cursor stability across mutations; no revision/snapshot/linearizability; per-response bounds declared. R-06 `contextCount` is initialization/re-anchor provenance only — for an already anchored topic, coverage is stable anchor through newest independent of current `contextCount`; Main reads rows only, never owns/repairs anchor. R-06 closure response now carries Main-authoritative totalTurnCount, selectedTurnCount, boundaryMessageId derived from same complete SQLite turn set and anchor used for closure slicing; Renderer remains bounded and uses metadata only for bounded diagnostics/projection, closure messages remain anchor-to-end model/token/UI source; no second IPC, full-topic admission, schema/migration, persistence, or anchor-transition change.

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

- **Status**: **S6.1–S6.3 Authorized & Implemented; S6.4 SQ-01 Rejected 2026-08-29 — no ADR, no production implementation, current LIKE retained; M4/M5 2026-09-01 synthetic directional batch accepted (M4 `chatdb-m4-fts-duplication-50k` 50k + M5 `chatdb-m5-file-dual-state` medium — one 1,000-reference dataset, 4 scenarios; synthetic directional L3, logical/derived only); S6.5 Candidate — Not Authorized; M2/M3 batch closed; no ready-now DB-health batch**. Per-slice explicit approval required; Phase 5 closed 2026-08-29, Phase 6 partially Open (S6.4 closed by rejection); no capacity-threshold adoption. See §7.1/§7.3.2 for 2026-09-01 four-field contracts and decision (harnesses valid within synthetic directional boundaries; S6.5 remains Candidate — Not Authorized; no production authorization).
- **Entry**: Phase 5 contract complete; calibration inputs per slice as needed; governance/ADR for any schema changes (M4/M5/M6).
- **Exit (per-slice)**: Slice-specific acceptance validated without violating contract invariants and without adopting a threshold unless owned by `performance-measurement.md`.
- **Dependencies**: Phase 5 contract; Phase 4 calibration where sizing touched; governance/ADR.
- **Activation**: Not activated by this program; per-slice approval separate.

| Slice | Description (contract targets) | Prerequisites | Acceptance | Rollback | Status |
|---|---|---|---|---|---|
| **S6.1** Windowed read contract | R-02 latest + R-03 around as typed `chatdb:fetch-messages-window` with `window` completeness, declared bounds, deterministic order, empty vs NOT_FOUND | Phase 5 contract; coordinated review | Viewport uses R-02/R-03 with coverage checks | Revert consumers to R-01; remove window IPC | **Authorized & Implemented 2026-08-22** |
| **S6.2** Authority-aware actions | Main-authoritative answer-group (R-05), stable-anchor branch/insert, R-04 search-hit around-window with not-found fallback | Same + S6.1 beneficial | Group via Main never window-inferred; branch/insert via stable anchor | Remove authority-aware IPC paths; restore prior projection-only paths | **Authorized & Implemented 2026-08-23** |
| **S6.3** Context closure & cache joins | R-06 anchor-to-end closure (renderer-owned anchor; Main reads rows only), cache-join for context-info, exactly-once repair, Main-authoritative totalTurnCount/selectedTurnCount/boundaryMessageId from same complete SQLite turn set and anchor as closure slicing (Renderer bounded, messages anchor-to-end, no second IPC/full-topic/schema/persistence/anchor change) | Phase 5 contract; context-window governance if semantics changed | Closure separate from viewport; unlimited measured not truncated; repair exactly once; metadata bounded diagnostics only | Remove closure read path; restore renderer-computed `computeContextInfo` | **Authorized & Implemented — contract/Main (2026-08-23), cache-join (2026-08-23), bounded repair (2026-08-24), authoritative metadata** |
| **S6.4** Short-query candidate SQ-01 (≤2-codepoint gram projection) — **Rejected 2026-08-29** | Derived auxiliary 1–2 codepoint gram projection — distinct contiguous substrings of normalized main_text keyed by (gram, block_id); terms <3 indexed gram lookup, ≥3 trigram FTS; per-term intersect; exact regex owns whole-word/CJK matching only; search ordering preserved `created_at -> message.id -> block_id` (evidence wording correction only; not an `architecture.md` contract change); independent from M1 and S6.5 | M2/M3 short-query diagnostic; ADR if schema/index | Rejected — see §6.7.1 for decision, rationale, and evidence basis | Remove auxiliary projection/index; restore LIKE path (disposed) | **Rejected 2026-08-29 — no ADR, no production implementation; current LIKE retained** |
| **S6.5** File dual-state & FTS dedup | File consistency (M5) if proven real; FTS dedup (M4) if beneficial | M4/M5 evidence; ADR | Consistency/dedup benefit demonstrated | Revert storage/dual-state changes | **Candidate — Not Authorized** — M4 `chatdb-m4-fts-duplication-50k` + M5 `chatdb-m5-file-dual-state` (medium, one 1,000-reference dataset, 4 scenarios) accepted 2026-09-01 as synthetic directional only (§7.3.2); no S6.5 authorization |

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

- **Status**: **S7.1–S7.13 Implemented & Closed 2026-09-02 (outcome/residual-risk; S7.12 attribution-only, S7.13 attribution-only instrumentation, bounded privacy-safe, no production optimization/baseline/SLA/threshold); S7.14+ deferred** — See §6.8.2–§6.8.14 for per-slice outcomes; S7.12 Startup Critical-Path Attribution closed with no production optimization, timing-dominant unknown (controlled non-adoption); S7.13 Startup Stage Instrumentation closed with no production optimization, baseline, SLA, threshold, or winner — attribution-only harness only. Phase 7 remains partially Open (S7.14+ deferred, later production optimization not authorized). Remaining Phase 7 tracks beyond S7.13 (background-window policy, S6.5, Phase 8) remain deferred.
- **Entry**: Phase 2 complete; explicit approval. Conversation-startup (S3.5) already closed; S7.1/S7.2/S7.3/S7.4 independent of Phase 4/5/6 and do not depend on M4/M5/M6.
- **Exit (S7.1)**: Implemented outcome satisfies renderer-only bundle/activation boundary — five secondary routes separately lazy-loaded with distinct production chunks and Home eager; bounded localized loading scoped to route outlet; tagged chunk-load recovery with retry/Home affordance, untagged render errors bubble to global boundary; no governance crossing; evidenced by production-build distinct chunks + focused Vitest + fresh-build shared-fixture Playwright (all five routes rendered, resource deltas verified) + diagnostic observation + independent audit + authoritative `pnpm build:check`; residual risks accepted.
- **Exit (S7.2)**: Implemented outcome satisfies renderer-local startup readiness presentation — `ImportProjectionGate` loading vs failed distinction with localized accessible `Spin` (pending, `aria-busy`/`aria-label`) and `Alert`+retry `Button` (failed, `role=alert`), `retryImportProjectionReadiness` reruns captured `applyPendingImportProjection` dispatch→flush→ack path with `failed→pending→ready/failed` transitions and `failed→pending` loading re-entry, subscription cleanup, and non-English placeholder replacement; preserves LOCK-PROJECTION/LOCK-001 gating (no stale navigation mount until `ready`) and LOCK-003 store-ready independence (retry never re-notifies `ReduxStoreReady`); B-08 staleness optimization adds synchronous `MutationObserver.takeRecords()` draining + snapshot-skip fast path while preserving max 500 live Ranges, unconditional cross-chunk rescan of current rendered DOM, and `childList/subtree/characterData/attributes` coverage; no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/context-window/S7.1 change; evidenced by focused Vitest (readiness/gate/retry ordering + B-08 staleness) + independent audit pass + authoritative `pnpm build:check` (exit 0, all six Vitest projects) on exact final worktree; residual risks accepted.
- **Exit (S7.3)**: Implemented outcome satisfies renderer-local Antd locale on-demand loading — `antdLocaleLoaders` per-locale dynamic imports via 12 explicit literal `import('antd/locale/...')` loaders with distinct emitted locale chunks, `AntdProvider` language-normalized on-demand resolution with `antdLocaleCache`, stale-request guard, default-locale fallback, and renderer-local `dayjs`/translation JSON unchanged; no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/context-window/Inputbar/Main-startup/telemetry change; evidenced by production build per-locale dynamic chunks with eager 12-locale payload removed, focused 54-locale Vitest, independent audit (2 blockers corrected → 0 findings), and authoritative `pnpm build:check` exit 0; residual risks accepted.
- **Exit (S7.4)**: Implemented outcome satisfies renderer-local i18n translation JSON + Day.js locale on-demand loading — translation and Day.js locale resources loaded via explicit literal per-locale dynamic imports with distinct emitted chunks (12 translation chunks + 11 non-English Day.js locale chunks), atomic initial/subsequent activation (pending/failure retains prior/fallback state, stale results/logs suppressed, required `i18next` callbacks complete), Inputbar/Home immediate behavior and S7.1/S7.2/S7.3 unchanged, no Markdown/KaTeX/XLSX/Main startup/telemetry/retention/deletion expansion; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/governance semantic change; evidenced by fresh production build 12 translation + 11 Day.js locale separate chunks with representative locale payload strings absent from renderer entry (directional bundle evidence only, not a formal measurement/threshold/SLA/baseline/byte-saving or timing claim), focused verification of atomic activation/stale-guard/callback wrapping and wrapper-path/static-ordering coverage, independent audit pass-with-findings (0 blockers, 1 acceptable-risk), and authoritative `pnpm build:check` exit 0; residual risks accepted.
- **Exit (S7.5)**: Implemented outcome satisfies renderer-local XLSX export on-demand — Table `exportTableToExcel` defers `@e965/xlsx` via renderer-local literal dynamic import in `xlsxLoader` with private success/pending cache, concurrent deduplication (same pending promise), retry after rejection (pending cleared on failure), and typed named/default normalization (`resolveXLSX`); preserves export/cancel/write/error semantics (parse-only does not load, empty/cancel returns false without write, dialog title `Select folder to save Excel file`, `dayjs` filename, `!cols` widths, file-write error propagation, dynamic-load failure propagated to existing Table error path); renderer-local only — no Markdown/KaTeX/Inputbar/Main startup reorder/Redux/Dexie/SQLite/background windows/telemetry/retention/deletion/S6.5/Phase 8 expansion and no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/governance change; evidenced by fresh production build emitting deferred `xlsx-DusDZK-x.js` with heavy XLSX markers absent from renderer entry (directional split evidence only, not a measurement/threshold/SLA/baseline/byte-saving/timing/causal performance claim), focused final suite 56 tests passed, independent implementation audits ended with no production blocker and accepted test-evidence findings corrected, and authoritative `pnpm build:check` exit 0, 1018s, 477 test files passed |2 skipped, 9345 tests passed |7 skipped, all lint/typecheck/i18n/format/OpenAPI projects pass on exact final worktree plus fresh `pnpm build` exit 0, 26s wall / vite 7.50s, `git diff --check` and Electron ABI 145 probe pass; E2E not run for isolated renderer-local loader/export behavior; residual risks accepted.
- **Exit (S7.6)**: Implemented outcome satisfies renderer-local Home-message KaTeX atomic on-demand loading — Home-message Markdown rendering defers KaTeX via renderer-local literal dynamic imports with complete atomic chain (KaTeX JS/CSS/contrib/parser assets as deferred chunks), parser-compatible fenced-math detection (including fenced code forms compatible with remark-math/rehype-katex), shared pending/cache/retry, bounded per-block failure policy (at most 2 attempts per block then reset on block/qualification transition), fallback to source Markdown via logger path, and preserved streaming/race/plugin semantics; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/context-window/governance change and no MarkdownEditor/RichEditor/Main startup reorder/Redux/Dexie/SQLite/background windows/telemetry/retention/deletion/S6.5/Phase 8 expansion; evidenced by fresh production build exit 0 with entry containing literal dynamic import links and deferred KaTeX JS/CSS/contrib/parser assets (directional bundle topology only, not a byte-saving/startup/SLA/baseline/threshold claim), focused verification 155 tests passed in final relevant command (loader/fallback/mhchem covered by prior 148-test passing evidence within total focused evolution), and authoritative `pnpm build:check` exit 0, 524 files passed |1 skipped, 9599 tests passed |75 skipped (arithmetically correct sum), all lint/typecheck/i18n/format/OpenAPI pass on exact final worktree plus `git diff --check` pass and Electron ABI 145 SQL probe pass; E2E not run for isolated renderer-local KaTeX loading with no IPC/persistence/lifecycle; no Main/preload/shared IPC/SQLite/Dexie/StoreSync/identity/sync/governance or MarkdownEditor/RichEditor/Main startup reorder/Redux/Dexie/SQLite/background windows/telemetry/retention/deletion/S6.5/Phase 8 change beyond Home-message KaTeX; XLSX via S7.5 only, KaTeX via S7.6 only, Mermaid demand-activation via S7.7 only (unconditional `useMermaid()` removed from eager `CodeStyleProvider`, `MermaidPreview` remains demand owner; Mermaid deferred until preview use); no threshold/baseline/SLA/formal measurement; residuals: S7.1 first-nav transient, S7.2 transient flash + heuristic `takeRecords()` limited, S7.3 cold first mount default-locale flash + no same-language retry, S7.4 cold initial configured-language fallback until resources resolve + same-language failure no inline retry (later language change/reload) + IIFE not fully isolated + i18next callback narrow + chunk directional only, S7.5 first export waits for chunk load + dynamic-load failure via Table error path with later retry + chunk topology not a performance quantification + no E2E needed + named/default normalization covered, S7.6 first math render waits for deferred assets + conservative detector may over-trigger but preserves parser-supported forms and does not reinterpret content + at most 2 attempts per block then reset on block/qualification transition + load failure via fallback/source Markdown and logger path + no E2E/live observation + topology not quantitative + MarkdownEditor/RichEditor not included, S7.7 first Mermaid preview waits for deferred chunk load + `CodeStyleProvider` no longer eagerly activates + topology/activation directional only + demand-owned via `MermaidPreview` only + no E2E needed; rollback one semantic revert(s), no migration; Phase 7 remains partially Open (S7.14+ deferred after S7.13 closure, later production optimization not authorized); no ready-now batch exists unless current user instruction explicitly activates another one** |; ARCH-010 disposition satisfied.
- **Exit (S7.7)**: Implemented outcome satisfies renderer-local Mermaid demand-activation — unconditional `useMermaid()` removed from eager `CodeStyleProvider` (no `useMermaid` import/call in `src/renderer/src/context/CodeStyleProvider.tsx`), `MermaidPreview` retains sole demand ownership via `useMermaid` hook; Mermaid remains deferred until preview use; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/release/migration/sync expansion and no Markdown/KaTeX/Inputbar/Main startup reorder/Redux/Dexie/SQLite/background windows/telemetry/retention/deletion/S6.5/Phase 8 expansion beyond S7.1–S7.6; evidenced by fresh production build exit 0 emitting separate Mermaid chunks including `mermaid.core-xh62IZ_A.js` with renderer entry containing dynamic import map but `CodeStyleProvider` body containing no Mermaid activation (directional bundle topology/activation only, not a byte-saving/startup/SLA/baseline/threshold claim), focused verification 17/17 (provider boundary suite + `MermaidPreview` hook ownership) with `git diff --check` pass, independent audit pass and re-audit pass, and authoritative `pnpm build:check` exit 0, 23m18s, files 45 pass|1 skip (main), 356 (renderer), 13 (aiCore), 18 (shared), 29 (scripts), 20 pass|1 skip (e2e-utils), tests 1855 pass|4 skip (main), 5070 (renderer), 380 (aiCore), 807 (shared), 712 (scripts), 524 pass|3 skip (e2e-utils), all lint/typecheck/i18n/format/OpenAPI projects pass on exact final worktree plus fresh `pnpm build` exit 0; E2E not run for isolated renderer activation boundary with no IPC/persistence/lifecycle; one semantic revert restores `useMermaid` import/call, no migration; residual risks accepted.
- **Exit (S7.8)**: Implemented outcome satisfies renderer-local code tooling demand activation — exactly two renderer-local slices: Shiki theme-metadata demand activation and shared CodeEditor/CodeMirror lazy activation. `CodeStyleProvider` has no mount `ensure`/`getShiki` effect; demand wrappers trigger metadata only on highlight path; custom persisted theme first highlight awaits metadata while default/auto uses fallback; `AsyncInitializer` supported reset clears failure for demand retry; `CodeEditor` public API/ref preserved behind internal `React.lazy`/`Suspense` with local error boundary; eager entry contains thin wrapper plus literal `import` only with `ReactCodeMirror`/`useCodeMirror`/`prepareCodeChanges` in separate async implementation chunk; fallback during `Suspense` is a localized loading shell with Ant Design `Spin`/loading text/`aria-busy` (`CodeEditorLoadingFallback`, `aria-busy`/`aria-label`, `data-testid="code-editor-loading"`), bounded local error fallback (`data-testid="code-editor-error"`), no false chunk retry action; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/release/migration/sync/background/telemetry expansion and no Markdown/ReactMarkdown or editor KaTeX change beyond code tooling; evidenced by fresh production build exit 0 with entry containing thin wrapper/literal dynamic import only and separate async chunk with `ReactCodeMirror`/`useCodeMirror`/`prepareCodeChanges`, and `CodeStyleProvider` body containing no mount Shiki ensure (directional bundle topology/activation only, not a byte-saving/startup/SLA/baseline/threshold/hashed-chunk claim; no private paths/raw logs), final code audits pass 0 findings, prior two aggregate attempts failed on lint/typecheck and were corrected, and authoritative `pnpm build:check` exit 0, 1011s, 575 files passed|2 skipped, 11539 tests passed|79 skipped across main core/native/heavy, renderer 358 files/5098 tests, aiCore 13/380, shared 18/807, scripts 29/712, e2e-utils 20 pass|1 skip/524 pass|3 skip, all lint/typecheck/i18n/format/openapi pass on exact final worktree plus fresh `pnpm build` exit 0 and `git diff --check` pass; E2E not run for isolated renderer activation boundary with no IPC/persistence/lifecycle; docs-only edit means final code-surface gate evidence remains valid; one semantic revert restores eager Shiki ensure and static CodeMirror import, no migration; residual risks accepted.
- **Dependencies**: Phase 2; Phase 3 stable host for conversation-startup (already satisfied). S7.1–S7.13 all attribution/topology, renderer-local, or attribution-only instrumentation with no Main/preload/shared IPC/SQLite/Dexie/StoreSync/identity/release/migration/sync/background/telemetry or Markdown/ReactMarkdown/editor KaTeX governance crossing — see §6.8.2–§6.8.14 for per-slice touch boundaries; S7.12 attribution-only, changes no production code/config; S7.13 instrumentation-only, bounded privacy-safe, no authority/contract/schema/migration/StoreSync/retention change. S7.14+ deferred.
- **Relationship**: See §8 — S7.1 bundle/activation, S7.2 readiness/hydration, S7.3 Antd locale on-demand, S7.4 translation JSON + Day.js locale, S7.5 XLSX export, S7.6 Home-message KaTeX, S7.7 Mermaid demand-activation, S7.8 code tooling, S7.9 auto-sync, S7.10 maintenance (0ms sweep + retention split), S7.11 critical bootstrap failure isolation, S7.12 attribution-only critical-path topology (see §6.8.2–§6.8.13), S7.13 startup stage instrumentation (see §6.8.14); conversation lazy activation (S3.5) distinct; S7.14+ deferred (background-window policy, S6.5, Phase 8).

#### 6.8.1 Reconnaissance (2026-08-29, docs-only)

Observed current-state facts at authorization time: `src/renderer/src/Router.tsx` eagerly statically imports `HomePage`, `FilesPage`, `NotesPage`, `KnowledgePage`, `SettingsPage`, `LaunchpadPage` and mounts them via `<Routes>` inside `<HashRouter>` with `<Sidebar />` and `<NavigationHandler />` always rendered; `src/renderer/src/App.tsx` provider/gate chain (`Provider` → `QueryClientProvider` → `StyleSheetManager` → `ThemeProvider` → `AntdProvider` → `NotificationProvider` → `CodeStyleProvider` → `PersistGate` → `SidebarWidthInitializer` → `CatalogHandoffBoundary` → `ImportProjectionGate` → `TopViewContainer` → `Router`) is eager and unchanged; `/` (`HomePage`) is the first-window critical route. Main startup reorder candidates were considered and not selected due to lifecycle races. Existing S3.5 ContentSearch (parent-owned lazy mount) and EditMode (light gate) lazy activation must not be duplicated by S7.1.

#### 6.8.2 S7.1 Implemented Outcome — Renderer-Only Lazy Secondary Routes (2026-08-30, outcome/residual-risk)

**Outcome**: Five secondary top-level routes (`FilesPage`/`NotesPage`/`KnowledgePage`/`SettingsPage`/`LaunchpadPage` at `/files`, `/notes`, `/knowledge`, `/settings/*`, `/launchpad`) lazy-loaded as separate production chunks; `HomePage`/`Sidebar`/`NavigationHandler`/full `App` provider/gate chain (`Provider`→`QueryClientProvider`→`StyleSheetManager`→`ThemeProvider`→`AntdProvider`→`NotificationProvider`→`CodeStyleProvider`→`PersistGate`→`SidebarWidthInitializer`→`CatalogHandoffBoundary`→`ImportProjectionGate`→`TopViewContainer`→`Router`) remain eager; route paths, navigation semantics, layout/sidebar continuity, and provider contexts preserved; localized bounded loading scoped to route outlet; tagged chunk-load failures present explicit recovery with retry/Home affordance; untagged render errors bubble to global boundary; renderer-only — no Main/preload/shared IPC, SQLite/Dexie, persistence, StoreSync, identity/sync/context-window change; `architecture.md` describes implemented reality only; one semantic revert to eager imports, no migration.

**Verification**: Production build distinct chunks (five secondary separate, Home eager) + focused Vitest (eager Home vs lazy secondary, bounded fallback, tagged recovery) + fresh-build shared-fixture Playwright (eager Home plus all five secondary routes rendered, verified via route-associated resource deltas) + diagnostic `ui:observe` on representative routes (not regression proof) + independent audit pass + authoritative `pnpm build:check` (exit 0) on exact implementation worktree; no threshold/baseline/SLA; ARCH-010 disposition satisfied.

**Residual risks (accepted)**: First navigation transient loading; retry best-effort if underlying resource remains unavailable; chunk count/topology may evolve; E2E uses route-associated resource deltas not names; diagnostics limited to representative routes and not regression proof; PERF workstreams independent/open.

#### 6.8.3 S7.2 Implemented Outcome — Renderer Readiness/Hydration Hardening + B-08 Staleness Optimization (2026-08-30, outcome/residual-risk)

**Outcome**: `ImportProjectionGate` now distinguishes `pending` (localized `Spin`, `aria-busy`/`aria-label`, `data-testid="startup-readiness-loading"`) from `failed` (localized `Alert` `role=alert` with retry `Button` `data-testid="startup-readiness-retry"`, `startup.readiness.*` i18n with non-English placeholders replaced) while still gating ordinary `TopViewContainer`/`Router` tree until `ready` (LOCK-PROJECTION/LOCK-001); `importProjectionReadiness` captures `apply` at boot, adds `retryImportProjectionReadiness` (`failed→pending` loading re-entry then reruns captured dispatch→flush→ack; pending/ready noop; no re-notification of `ReduxStoreReady`, LOCK-003 preserved), subscription cleanup, and pending/ready state exposure; ContentSearch B-08 optimization adds `observerRef` + `handleRelevantMutations`/`drainPendingMutations`/`isStaleForNavigation` with synchronous `takeRecords()` draining and snapshot-skip fast path for same-chunk/zero-result navigation, preserving B-08 max 500 live Ranges, unconditional cross-chunk rescan of current rendered DOM, and `childList/subtree/characterData/attributes` observer coverage; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/context-window/S7.1 change; one semantic revert restores prior `null` gate + no-retry readiness, B-08 drain removal restores prior snapshot-only check.

**Verification**: Focused Vitest (readiness primitive, boot wiring, gate pending/loading vs failed/retry ordering, retry `failed→pending→ready/failed` + flush→ack ordering, B-08 `drainPendingMutations`/`isStaleForNavigation` staleness) + independent audit pass (no governance crossing) + authoritative `pnpm build:check` (exit 0, all six Vitest projects) on exact final worktree; no threshold/baseline/SLA; ARCH-010 disposition satisfied.

**Residual risks (accepted)**: Transient loading flash on retry; retry best-effort if underlying storage/IPC remains unavailable; B-08 staleness heuristic uses `textLength`/`childCount` snapshot diff after synchronous drain — not a full DOM diff; `takeRecords()` covers only pending records already queued, not future async mutations; existing non-bottom overflow / E2E `ui:observe` diagnostic limitations and PERF workstreams independence remain.

#### 6.8.4 S7.3 Implemented Outcome — Antd Locale On-Demand Loading (2026-08-30, outcome/residual-risk)

**Outcome**: `AntdProvider` resolves Antd locale on demand via `antdLocaleLoaders` (12 locales: `zh-CN`/`zh-TW`/`en-US`/`de-DE`/`ru-RU`/`ja-JP`/`el-GR`/`es-ES`/`fr-FR`/`pt-PT`/`ro-RO`/`vi-VN` with normalized fallback to `zh-CN`, prototype-pollution guard, and `antdLocaleCache` with `clearAntdLocaleCache` export); per-locale `() => import('antd/locale/<name>')` via 12 explicit literal `import('antd/locale/...')` loaders with distinct emitted locale chunks, request-id stale guard, error logging, and default-locale fallback; renderer-local only — no `dayjs`/translation JSON, Inputbar, Main startup reorder, telemetry/retention/deletion, persistence, IPC, authority, identity, release, platform, or sync change; one semantic revert restores eager 12-locale `switch` import, no migration.

**Verification**: Production build emitted 12 per-locale dynamic chunks with eager 12-locale payload removed from entry; focused Vitest 54/54 (loader mapping/fallback + provider resolution/caching/stale-guard/error-fallback); independent audit (2 blockers corrected: dynamic-chunk analyzability + erased type import, re-audit 0 findings) + authoritative `pnpm build:check` exit 0 in 15m11s on exact final worktree (renderer 339 files/4908 tests, all Main/main-native/main-heavy/aiCore/shared/scripts/e2e-utils passing; lint/typecheck/i18n/format/OpenAPI pass; `git diff --check` pass; Electron ABI 145 SQL probe pass); first aggregate run failed quickly on `consistent-type-imports`, corrected with erased regular `Locale` type import, single authorized rerun passed; no threshold/baseline/SLA/formal measurement; ARCH-010 disposition satisfied.

**Residual risks (accepted)**: Cold first mount may briefly use Antd default locale until selected locale chunk resolves; failed locale request has no same-language in-place retry (recovery by language change/remount); directional chunk evidence is not a timing/SLA/formal threshold claim; PERF workstreams independent/open.

#### 6.8.5 S7.4 Implemented Outcome — Renderer i18n Translation JSON + Day.js Locale On-Demand Loading (2026-08-30, outcome/residual-risk)

**Selection rationale**: Startup payload deferral selected as next renderer-local bundle/activation split consistent with S7.1 lazy routes and S7.3 Antd locale deferral; translation JSON and Day.js locale identified as deferrable secondary i18n locale payload that can load on demand without blocking Home/Inputbar immediate rendering or requiring Main/preload/shared IPC, authority, or persistence change; explicit literal dynamic imports chosen for chunk analyzability.

**Outcome**: i18n translation JSON and Day.js locale resources load on demand via explicit literal per-locale dynamic imports (translation loaders + `dayjs/locale/<name>` loaders via explicit literal paths, distinct emitted chunks — 12 translation chunks + 11 non-English Day.js locale chunks), with atomic initial and subsequent activation (pending/failure retains prior/fallback locale state, stale results and stale error logs suppressed via request-id guard, required `i18next` callbacks and Day.js `locale()` transitions complete); Inputbar/Home immediate behavior and S7.1/S7.2/S7.3 remain unchanged; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/governance semantic change and no Markdown/KaTeX/XLSX/Main startup/telemetry/retention/deletion expansion; one semantic revert restores eager locale imports, no migration.

**Verification**: Fresh production build emitted 12 translation and 11 Day.js locale separate chunks with representative locale payload strings absent from renderer entry (directional bundle evidence only, not a formal measurement, entry saving, latency, threshold, baseline, or SLA claim); focused verification of atomic activation (initial and subsequent pending vs failure retaining prior/fallback, stale-result and stale-log suppression, required callbacks complete) with wrapper-path and static-ordering coverage; independent audit pass-with-findings (0 blockers, 1 acceptable coverage risk); authoritative gates passed (fresh production build and `pnpm build:check`); ARCH-010 disposition satisfied.

**Residual risks (accepted)**: Cold initial configured-language load retains fallback locale until translation/Day.js resources resolve; same-language loader failure has no inline in-place retry and recovers via later language change or reload; exact startup IIFE lacks a fully isolated module-import behavioral test (wrapper path and static ordering are covered); public `i18next` callback compatibility remains narrow — current call sites use `Promise`/void; chunk evidence is directional only (no byte/latency/SLA/threshold/baseline claim); PERF workstreams independent/open.

#### 6.8.6 S7.5 Implemented Outcome — Renderer XLSX Export On-Demand Loading (2026-08-30, outcome/residual-risk)

**Selection rationale**: Startup payload deferral selected as next renderer-local bundle/activation split consistent with S7.1 lazy routes, S7.3 Antd locale, and S7.4 translation/Day.js locale deferral; XLSX export identified as deferrable secondary Table export payload that can load on demand without blocking Home/Inputbar immediate rendering or requiring Main/preload/shared IPC, authority, or persistence change; renderer-local literal dynamic import with private cache/deduplication chosen for chunk analyzability and retry.

**Scope**: Single authorized batch — XLSX export on-demand only. Renderer-local `xlsxLoader` with literal `import('@e965/xlsx')`, private success/pending cache, concurrent deduplication, retry after rejection, typed named/default normalization; `exportTableToExcel` preserves export/cancel/write/error semantics. Non-goals remain deferred/not authorized: Markdown/KaTeX, Inputbar, Main startup reorder, Redux/Dexie/SQLite, background windows, telemetry/retention/deletion, S6.5, Phase 8.

**Outcome**: `@e965/xlsx` no longer evaluated on loader import or on `exportExcel` import or on parse-only use; load occurs only when `exportTableToExcel` is invoked with valid table markdown. Private cache returns resolved module immediately on success; pending promise deduplicates concurrent calls; rejection clears pending to allow retry; `resolveXLSX` normalizes installed named/default runtime shape. Export/cancel/write/error paths unchanged (empty returns false without load, cancel returns false without write, folder selection and `dayjs` filename and `!cols` widths and write-error propagation retained, dynamic-load failure surfaces through existing Table error path and later retry is possible). Renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/governance change; one semantic revert restores static import, no migration.

**Verification**: Fresh production build emitted deferred `xlsx-DusDZK-x.js` with heavy XLSX markers absent from renderer entry (directional split evidence only, not a startup timing, byte-saving, SLA, baseline, threshold, or causal performance claim); focused final suite 56 tests passed; independent implementation audits ended with no production blocker and accepted test-evidence findings corrected; authoritative `pnpm build:check` exit 0, 1018s, 477 test files passed |2 skipped, 9345 tests passed |7 skipped, all lint/typecheck/i18n/format/OpenAPI projects pass on exact final worktree plus fresh `pnpm build` exit 0, 26s wall / vite 7.50s, `git diff --check` and Electron ABI 145 probe pass; E2E not run for isolated renderer-local loader/export behavior. ARCH-010 disposition satisfied.

**Residual risks (accepted)**: First export waits for chunk load; dynamic-load failure surfaces through existing Table error path and later retry is possible; chunk topology evidence does not quantify product performance; no live E2E/diagnostic observation was needed for isolated renderer-local loader/export behavior; current module normalization supports installed named/default runtime shape and is covered by tests; PERF workstreams independent/open.

#### 6.8.7 S7.6 Implemented Outcome — Renderer Home-Message KaTeX Atomic On-Demand Loading (2026-08-31, outcome/residual-risk)

**Selection rationale**: Startup payload deferral selected as next renderer-local bundle/activation split consistent with S7.1 lazy routes, S7.3 Antd locale, S7.4 translation/Day.js locale, and S7.5 XLSX deferral; Home-message KaTeX identified as deferrable secondary Markdown math payload that can load on demand without blocking Home/Inputbar immediate rendering or requiring Main/preload/shared IPC, authority, or persistence change; renderer-local literal dynamic imports with complete atomic chain and shared pending/cache/retry chosen for chunk analyzability and bounded failure.

**Scope**: Single authorized batch — Home-message KaTeX atomic on-demand only. Renderer-local literal dynamic imports with complete atomic chain (KaTeX JS/CSS/contrib/parser assets as deferred chunks), shared pending/cache/retry, parser-compatible fenced-math detection (including fenced code forms compatible with remark-math/rehype-katex), bounded per-block failure policy with fallback to source Markdown, and preserved streaming/race/plugin semantics. Non-goals remain deferred/not authorized: MarkdownEditor/RichEditor KaTeX, Inputbar, Main startup reorder, Redux/Dexie/SQLite, background windows, telemetry/retention/deletion, S6.5, Phase 8.

**Outcome**: KaTeX no longer evaluated on Markdown entry import or on Home-message parse-only use; load occurs only when Home-message contains parser-compatible math. Detection includes inline/display delimiters and parser-compatible fenced math without reinterpreting content; conservative detector may over-trigger but preserves parser-supported forms. Shared pending promise deduplicates concurrent loads, success cached, retry after failure via shared retry path; complete atomic chain resolves before rendering, failure per block remains bounded (at most 2 attempts per block then reset on block/qualification transition) and falls back to source Markdown via logger path. Streaming/race/plugin semantics preserved (no cross-boundary change). Renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/sync/context-window/governance change; one semantic revert restores eager KaTeX, no migration.

**Verification**: Fresh production build exit 0 with entry containing literal dynamic import links and deferred KaTeX JS/CSS/contrib/parser assets (directional bundle topology only, not a byte-saving/startup/SLA/baseline/threshold claim; no fixed chunk names/sizes); focused verification 155 tests passed in final relevant command (loader/fallback/mhchem covered by prior 148-test passing evidence within total focused evolution); authoritative `pnpm build:check` exit 0, 524 files passed |1 skipped, 9599 tests passed |75 skipped (arithmetically correct sum), all lint/typecheck/i18n/format/OpenAPI pass on exact final worktree plus `git diff --check` pass and Electron ABI 145 SQL probe pass; E2E not run for isolated renderer-local KaTeX loading with no IPC/persistence/lifecycle. ARCH-010 disposition satisfied.

**Residual risks (accepted)**: First math render waits for deferred assets; conservative detector may over-trigger but preserves parser-supported forms and does not reinterpret content; at most 2 attempts per block then reset on block/qualification transition; load failure uses fallback to source Markdown and logger path; no E2E/live observation; bundle topology not quantitative and does not quantify product performance; MarkdownEditor/RichEditor KaTeX not included and remains deferred; PERF workstreams independent/open.

#### 6.8.8 S7.7 Implemented Outcome — Renderer Mermaid Demand-Activation (2026-08-31, outcome/residual-risk)

**Selection rationale**: Startup activation deferral selected as next renderer-local activation split consistent with S7.1 lazy routes, S7.3 Antd locale, S7.4 translation/Day.js locale, S7.5 XLSX, and S7.6 KaTeX deferral; eager `CodeStyleProvider` unconditional `useMermaid()` identified as deferrable activation that can be demand-owned without blocking Home/Inputbar immediate rendering or requiring Main/preload/shared IPC, authority, or persistence change; `MermaidPreview` already owns demand activation via `useMermaid` hook.

**Scope**: Single authorized batch — Mermaid demand-activation only. Production diff removes `useMermaid` import/call from `src/renderer/src/context/CodeStyleProvider.tsx`; tests add focused provider boundary suite and direct `MermaidPreview` hook ownership assertion. Mermaid remains deferred until `MermaidPreview` use. Non-goals remain deferred/not authorized: Main startup reorder, Inputbar/MarkdownEditor/RichEditor KaTeX beyond Home-message scope, Redux/Dexie/SQLite, background windows, S6.5, telemetry/retention/deletion, Phase 8.

**Outcome**: `CodeStyleProvider` no longer imports/calls `useMermaid` eagerly; `MermaidPreview` retains sole demand ownership via `useMermaid` hook. Mermaid remains separate deferred chunks and is activated only on preview use. Renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/release/migration/sync expansion; one semantic revert restores `useMermaid` import/call, no migration.

**Verification**: Fresh production build exit 0 emitting separate Mermaid chunks including `mermaid.core-xh62IZ_A.js` with renderer entry containing dynamic import map but `CodeStyleProvider` body containing no Mermaid activation (directional bundle topology/activation only, not a byte-saving/startup/SLA/baseline/threshold claim; no private paths/raw logs); focused verification 17/17 (provider boundary suite + `MermaidPreview` hook ownership) with `git diff --check` pass; independent audit pass and re-audit pass; authoritative `pnpm build:check` exit 0, 23m18s, files 45 pass|1 skip (main), 356 (renderer), 13 (aiCore), 18 (shared), 29 (scripts), 20 pass|1 skip (e2e-utils), tests 1855 pass|4 skip (main), 5070 (renderer), 380 (aiCore), 807 (shared), 712 (scripts), 524 pass|3 skip (e2e-utils), all lint/typecheck/i18n/format/OpenAPI projects pass on exact final worktree plus fresh `pnpm build` exit 0; E2E not run for isolated renderer activation boundary with no IPC/persistence/lifecycle. ARCH-010 disposition satisfied.

**Residual risks (accepted)**: First Mermaid preview waits for deferred chunk load; `CodeStyleProvider` no longer eagerly activates Mermaid; bundle topology/activation evidence is directional only and does not quantify product performance or establish a threshold/baseline/SLA; Mermaid remains demand-owned only via `MermaidPreview` path; no Main/preload/shared IPC/SQLite/Dexie/StoreSync/governance or S6.5/Phase 8 expansion; PERF workstreams independent/open.

#### 6.8.9 S7.8 Implemented Outcome — Renderer Code Tooling Demand Activation (2026-08-31, outcome/residual-risk)

**Selection rationale**: Startup payload/activation deferral selected as next renderer-local split consistent with S7.1 lazy routes, S7.3 Antd locale, S7.4 translation/Day.js locale, S7.5 XLSX, S7.6 KaTeX, and S7.7 Mermaid deferral; Shiki theme-metadata and shared CodeEditor/CodeMirror identified as deferrable secondary code-tooling payload that can load on demand without blocking Home/Inputbar immediate rendering or requiring Main/preload/shared IPC, authority, or persistence change; demand wrappers + internal lazy/Suspense chosen for topology analyzability and API preservation.

**Scope**: Single authorized batch — code tooling demand activation only. Exactly two renderer-local slices: Shiki theme-metadata demand activation and shared CodeEditor/CodeMirror lazy activation. Shiki: `CodeStyleProvider` mount does not load metadata; demand wrappers trigger metadata only on highlight path; `AsyncInitializer` supported reset enables demand retry. CodeEditor: thin wrapper with literal dynamic import in eager entry; ReactCodeMirror/useCodeMirror/prepareCodeChanges in separate async implementation chunk; public API/ref preserved behind internal `React.lazy`/`Suspense` with local error boundary and localized loading shell with Ant Design `Spin`/loading text/`aria-busy` (`CodeEditorLoadingFallback`) and bounded local error fallback, no false chunk retry action. Non-goals remain deferred/not authorized: Markdown/ReactMarkdown, editor KaTeX, Main/preload/shared IPC/SQLite/Dexie/StoreSync/identity/release/migration/sync/background/telemetry/S6.5/Phase 8 and no next Phase 7 batch beyond S7.8.

**Outcome**: `CodeStyleProvider` has no mount `ensure`/`getShiki` effect; first highlight for custom persisted theme awaits metadata while default/auto uses fallback synchronously; `AsyncInitializer` supported reset clears failure for demand retry; demand wrappers trigger metadata only on highlight path; `CodeEditor` public API/ref preserved behind internal `React.lazy`/`Suspense` with local error boundary; eager entry contains thin wrapper plus literal dynamic import only with `ReactCodeMirror`/`useCodeMirror`/`prepareCodeChanges` in separate async chunk; fallback during `Suspense` is a localized loading shell with Ant Design `Spin`/loading text/`aria-busy` (`CodeEditorLoadingFallback`, `aria-busy`/`aria-label`, `data-testid="code-editor-loading"`), bounded local error fallback (`data-testid="code-editor-error"`), no false chunk retry action; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/release/migration/sync/background/telemetry expansion and no Markdown/ReactMarkdown or editor KaTeX change beyond code tooling; one semantic revert restores eager Shiki ensure and static CodeMirror import, no migration.

**Verification**: Fresh production build exit 0 with entry containing thin wrapper/literal dynamic import only and separate async chunk with `ReactCodeMirror`/`useCodeMirror`/`prepareCodeChanges`, and `CodeStyleProvider` body containing no mount Shiki ensure (directional bundle topology/activation only, not a byte-saving/startup/SLA/baseline/threshold/hashed-chunk claim; no private paths/raw logs); final code audits pass 0 findings; prior two aggregate attempts failed on lint/typecheck and were corrected; final authoritative `pnpm build:check` exit 0, 1011s, 575 files passed|2 skipped, 11539 tests passed|79 skipped across main core/native/heavy, renderer 358 files/5098 tests, aiCore 13/380, shared 18/807, scripts 29/712, e2e-utils 20 pass|1 skip/524 pass|3 skip, all lint/typecheck/i18n/format/openapi pass on exact final worktree plus fresh `pnpm build` exit 0 and `git diff --check` pass; E2E not run for isolated renderer activation boundary with no IPC/persistence/lifecycle; docs-only edit means final code-surface gate evidence remains valid. ARCH-010 disposition satisfied.

**Residual risks (accepted)**: First custom-theme highlight and first CodeEditor render wait for deferred chunks; default/auto themes use fallback until metadata not needed; `AsyncInitializer` reset is the supported demand retry path; CodeEditor `Suspense` fallback is a localized loading shell with Ant Design `Spin`/loading text/`aria-busy` (`CodeEditorLoadingFallback`, `aria-busy`/`aria-label`, `data-testid="code-editor-loading"`) with bounded local error fallback (`data-testid="code-editor-error"`), no false chunk retry action; bundle topology/activation evidence is directional only and does not quantify product performance or establish a threshold/baseline/SLA/hashed chunk; CodeEditor/CodeMirror is shared renderer-local only; Markdown/ReactMarkdown and editor KaTeX remain deferred; PERF workstreams independent/open.

#### 6.8.10 S7.9 Implemented Outcome — Renderer Auto-Sync Tooling Demand Activation (2026-08-31, outcome/residual-risk)

**Selection rationale**: Startup activation deferral selected as next renderer-local split consistent with S7.1 lazy routes, S7.3 Antd locale, S7.4 translation/Day.js locale, S7.5 XLSX, S7.6 KaTeX, S7.7 Mermaid, S7.8 code tooling deferral; `src/renderer/src/init.ts` static `BackupService`/`NutstoreService` imports identified as deferrable auto-sync activation that can be demand-owned without blocking Home/sidebar/navigation immediate rendering or requiring Main/preload/shared IPC, authority, or persistence change; observed init top-level has no timer/IPC/window subscription side effects, suitable for demand path. Redux rehydration and Dexie init are independently deferred and remain not in this batch.

**Scope**: Single authorized batch — auto-sync tooling demand activation only. Renderer-local only: remove unconditional static module activation from `src/renderer/src/init.ts`; at existing 8-second auto-sync check, only when corresponding demand exists dynamically load and start service via literal `import('./services/BackupService')` and `import('./services/NutstoreService')` with bounded `loggerService` failure logging and no unhandled rejection. Must preserve 8s trigger point, webdav/s3/local/nutstore switch conditions, sync interval, lastSyncTime, retry/backoff, IPC channel/payload, Redux dispatch, error and settings-page call semantics. Must preserve `BackupService`/`NutstoreService` all export/default import API and internal implementation; no Main/preload/shared, SQLite/Dexie schema/migration, StoreSync, Redux rehydration, ImportProjection, catalog recovery, window lifecycle change. Must use statically analyzable literal dynamic imports; module load failure must be bounded via `loggerService` without unhandled rejection; no new user-visible retry/error UI. No new settings-page lazy loading or internal service logic change.

**Locked scope**: Only module activation/chunk topology changes; S7.1–S7.8 remain Implemented & Closed and are not reopened. S7.9 must not change sync behavior, service API, persistence/IPC/window boundaries, or batch goal; any required change beyond locked scope must stop and return to hub.

**Evidence contract — four fields (S7.9)**:
- **Named decision/outcome**: S7.9 auto-sync tooling demand activation is Implemented & Closed only when authorized outcome (bootstrap no longer statically imports the two services; 8s and switch semantics preserved; corresponding service only loaded once when demanded and called; failures bounded via `loggerService` with no unhandled rejection) is satisfied and residual risks explicitly accepted.
- **Claim**: Renderer bootstrap eager/static activation removed for `BackupService`/`NutstoreService`; existing 8s auto-sync check only dynamically imports and starts the corresponding service when its demand switch is enabled; topology/activation directional only — no byte-saving, startup SLA, performance magnitude, or causal claim.
- **Minimum sufficient method**: Code change in `src/renderer/src/init.ts` using literal dynamic imports with bounded `loggerService` catch; focused renderer Vitest via canonical Node ABI lane covering all-off, backup any-switch enabled (webdav/s3/local), nutstore enabled, both families together, and module load/start rejection bounded logging without unhandled rejection, with fake timers/module mocks/DOM isolation; file-scoped lint/typecheck/format or `pnpm verify:changed` where applicable; later independent audit, `pnpm build` topology check (entry contains dynamic import map and no static activation through proxy chunks, SettingsPage retains static imports), and authoritative `pnpm build:check` for the exact final worktree close the batch.
- **Stopping condition**: Focused tests pass (all demand scenarios + bounded failure + no unhandled rejection + no mock leakage), file-scoped lint/typecheck/format pass, init.ts contains no static import for the two services and preserves 8s/switch semantics, production build shows awaited dynamic boundaries through proxy chunks with SettingsPage static imports preserved, independent audits pass 0 findings, and authoritative `pnpm build:check` passes on the exact final worktree.

**Status**: **Implemented & Closed 2026-08-31 (outcome/residual-risk)**. Code change (init.ts demand imports) and focused tests (14/14, Node ABI lane, fake timers/mocks/DOM isolation, no unhandled rejection) applied; fresh production build and authoritative `pnpm build:check` verified on exact final worktree; independent code and docs audits passed; docs record closure. Phase 7 remains partially Open — S7.14+ deferred after S7.13 closure (later production optimization not authorized).

**Outcome**: `src/renderer/src/init.ts` no longer statically imports `BackupService`/`NutstoreService`; literal dynamic imports are used inside the existing 8-second `setTimeout` demand check through proxy chunks, preserving webdav/s3/local/nutstore switch conditions, sync interval/lastSyncTime/retry/backoff/IPC/Redux/settings semantics; SettingsPage retains static implementation imports as expected; load/start failures are bounded via `loggerService.withContext('AutoSync').warn` with `void` chain and `.catch`, no new retry/error UI, no unhandled rejection; bounded production topology: renderer entry `out/renderer/assets/index-DU1QcOXC.js` uses awaited dynamic boundaries through BackupService/NutstoreService proxy chunks; house style, i18n (no new user text), `loggerService`, and doc authority boundaries preserved; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/persistence/StoreSync/identity/release/migration/sync/background/telemetry or Markdown/ReactMarkdown/editor KaTeX governance beyond auto-sync and no Main startup reorder/Redux/Dexie/SQLite/background windows/S6.5/Phase 8 expansion beyond S7.9; one semantic revert restores static imports, no migration.

**Verification**: Fresh `pnpm build` exit 0 (23s wall) — renderer entry `out/renderer/assets/index-DU1QcOXC.js` uses awaited dynamic boundaries through BackupService/NutstoreService proxy chunks; SettingsPage retains static implementation imports as expected (directional bundle topology/activation only, not a byte-saving, startup SLA, performance magnitude, baseline, or causal claim; no private paths/raw logs); focused renderer suite `src/renderer/src/init.autoSync.test.ts` 14/14 passed via canonical Node ABI lane (`pnpm native:run node -- vitest run --project renderer src/renderer/src/init.autoSync.test.ts`) covering source-level topology (no static import, literal dynamic imports, 8s), all-off, backup any-switch (webdav, s3, local), nutstore, both families, backup/nutstore load/start rejection bounded logging, 8s trigger preservation, and DOM/mock isolation without unhandled rejection; independent code audit and docs audit re-check both pass 0 findings; authoritative `pnpm build:check` exit 0 (812s) on exact final worktree — 576 test files passed | 2 skipped, 11,553 tests passed | 79 skipped, renderer 359 files / 5,112 tests including focused 14/14, all lint/typecheck/i18n/format/OpenAPI projects pass, post-node-lane Electron ABI 145 restore + SQL probe passed; worktree code/test state unchanged after gate; docs-only edit — gate evidence remains fresh per delivery-validation; `git diff --check` pass; E2E not run for isolated renderer-local activation boundary with no IPC/persistence/lifecycle. ARCH-010 disposition satisfied.

**Residual risks (accepted)**: First demanded auto-sync awaits chunk load; load failure is bounded to `loggerService` with no inline retry (recovery via later settings toggle or reload); 8s semantics unchanged; production build topology is directional only and does not quantify byte savings, startup time, SLA, baseline, or causal improvement; SettingsPage static imports intentionally retained; renderer entry contains dynamic map via proxy chunks — not a global renderer graph without static service imports; no IPC/persistence/lifecycle change; PERF workstreams independent/open.

#### 6.8.11 S7.10 Implemented Outcome — Renderer-Local Maintenance Activation (0ms Bounded Post-Bootstrap) (2026-08-31, outcome/residual-risk)

**Authorization**: S7.10 authorized as next renderer-local startup-maintenance split; no Main/preload/shared IPC, StoreSync, Redux rehydration, SQLite/Dexie, window lifecycle, policy, or governance crossing. Prior S7.1–S7.9 remain Implemented & Closed and are not reopened.

**Selection rationale**: Startup payload/activation deferral selected as next renderer-local split consistent with S7.1–S7.9; scroll snapshot startup global TTL/LRU sweep and residentRetention 60s timer + queueIdle/windowReadIdle background enforcement identified as deferrable maintenance that can move to 0ms bounded post-bootstrap task without blocking Keyv creation/init or retention correctness; plain setTimeout(0) chosen as bounded post-bootstrap seam per house-style, not requestIdleCallback, no arbitrary 5–10s threshold (LOCK-001).

**Scope — Must do**:
- Scroll: KeyvStorage creation + window.keyv.init() stay in synchronous bootstrap; startup global TTL/LRU sweep scheduled to 0ms via plain setTimeout(0) with unref; new cancellable/idempotent schedule API; first-read/first-write/clear/hard-delete correctness remains immediate (LOCK-002).
- Scroll: fix read/save lifecycle check-before-refresh — expired index entry must be deleted/considered missing before refreshing lastAccess; >90d snapshot must not be resurrected; preserve max256/LRU, invalidated fence, deterministic tie-break, malformed rebuild (LOCK-003).
- Retention: deletion reclamation handler, store subscriber, seed/byte-cache invalidation, pinned/unpin tracking stay eager; only 60s timer + queueIdle/windowReadIdle background enforcement registration moves to 0ms bounded task; no pre-task deletion leak or byteCache fail-open (LOCK-004).
- init.ts uses scheduled APIs while preserving Keyv/IPC initialization order.
- Focused tests: 91d item first read not returning/resurrected before sweep, save handling old index, global sweep 0ms before/after, retention deletion before background clears metadata, pre-task mutation after first enforce not using stale byte cache, duplicate start/cancel/stop-before-fire, queue/timer 0ms boundary, failure/logging without leak.

**Scope — Must preserve**: existing public exports/API unless new backward-compatible API; existing tests; house style/logging.
**Scope — Must not**: change IPC services, WebTrace, StoreSync, topicDeletion files unless test import without behavior change; change policy constants; introduce generic scheduler subsystem; production build/build:check; commit/push in this sub-session.

**Locked scope**: LOCK-001 (0ms setTimeout house-style, not idle, no threshold claim), LOCK-002 (Keyv create/init in bootstrap, sweep deferred), LOCK-003 (check-before-refresh), LOCK-004 (retention eager vs deferred split), LOCK-005 (start/stop/idempotency covering pending timer/callbacks/subscriber/handler), LOCK-006 (no IPC/StoreSync/redux/persistence/lifecycle/policy), LOCK-007 (all new async failures via loggerService, no unhandled rejection), LOCK-008 (no byte/startup SLA/performance magnitude claim, build only proves topology), LOCK-009 (docs Implemented & Closed after final build/audit/build:check).

**Evidence contract — four fields (S7.10)**:
- **Named decision/outcome**: S7.10 renderer-local maintenance activation is Implemented & Closed only when sync bootstrap only does Keyv creation/init + retention correctness setup and two background units activate in 0ms task with 91d not resurrected, deletion/byte-cache immediate correctness, and stop/idempotency complete.
- **Claim**: Synchronous bootstrap only does Keyv creation/init + retention correctness setup; two background units (scroll global sweep, retention timer/queue callbacks) activate in 0ms bounded task; 91d expired snapshot not resurrected on first read/save before sweep; deletion/byte-cache immediate; no SLA/performance claim — topology only.
- **Minimum sufficient method**: Code changes in scrollSnapshotCache (check-before-refresh + 0ms schedule API with cancel/idempotency/logger) and residentRetention (eager/deferred split with 0ms timer/queue registration + pending cover + logger) and init.ts (use scheduled APIs preserving Keyv/IPC order); focused renderer Vitest via canonical Node ABI lane covering 91d read/save, old index handling, 0ms before/after sweep, retention deletion before background, pre-task mutation stale-cache guard, duplicate start/cancel/stop-before-fire, queue/timer 0ms boundary, failure/logging without leak and no mock leakage; file-scoped lint/oxlint/Biome; git diff --check; later independent audit, pnpm build topology check (entry vs post-bootstrap activation), and authoritative pnpm build:check close batch.
- **Stopping condition**: Focused tests pass true/isolated (all scenarios above + no unhandled rejection), file-scoped lint/typecheck/format pass, init.ts shows Keyv bootstrap + 0ms activation only, production build shows topology directional only, docs mark In Progress, and later independent audits + authoritative pnpm build:check pass on exact final worktree.

**Status**: **Implemented & Closed 2026-08-31 (outcome/residual-risk)** — code changes (check-before-refresh + 0ms schedule/cancel + eager/deferred split + init.ts) and focused tests applied; fresh production build exit 0 with entry containing literal dynamic import links and deferred `residentRetention-BjzUo1ip.js` proving timer boundary (artifact hash only canonical writable, directional topology only); independent code and docs audits passed (code 0 findings, docs 1 label finding corrected single-point), final exact-worktree recheck completed after the artifact-cleanup edits; authoritative `pnpm build:check` exit 0 on exact final worktree closes batch. Phase 7 remains partially Open — S7.14+ deferred after S7.13 closure (later production optimization not authorized).

**Outcome**: Synchronous bootstrap only does KeyvStorage creation + `window.keyv.init()` and retention deletion/handler/subscriber/seed/byte-cache correctness (eager/sync); scroll global TTL/LRU sweep and retention 60s timer + queueIdle/windowReadIdle background enforcement registration activate in 0ms bounded post-bootstrap task via plain `setTimeout(0)` with `unref` — not all maintenance delayed (LOCK-002). Scroll read/save use check-before-refresh: >90d expired index entry deleted/considered missing before refreshing `lastAccess`, first read of expired snapshot returns `null` without resurrection; physical `Keyv.remove` returning `false` or throwing keeps expired index, suppresses resurrection and schedules later sweep retry; successful physical `Keyv.remove` removes index. init.ts preserves Keyv/IPC initialization order and uses scheduled APIs; renderer-local only — no Main/preload/shared IPC/SQLite/Dexie/StoreSync/identity/release/migration/sync/background/telemetry or Markdown/ReactMarkdown/editor KaTeX governance beyond maintenance activation and no policy constant change; one semantic revert restores immediate sweep/registration, no migration.

**Verification**: Fresh `pnpm build` exit 0 — renderer entry `out/renderer/assets/index-DXjM4Z9p.js` uses awaited dynamic boundaries, deferred `residentRetention-BjzUo1ip.js` proves timer boundary via separate chunk (directional bundle topology/activation only, not a byte-saving, startup SLA, performance magnitude, baseline, threshold, or causal claim; artifact hash only canonical writable; no private paths/raw logs); focused renderer suites `scrollSnapshotCache` + `residentRetention` via canonical Node ABI lane covering 91d first-read null without resurrection before sweep, save handling expired index without resurrection, global 0ms sweep before/after, retention deletion before background clears metadata, pre-task mutation stale-cache guard, duplicate start/cancel/stop-before-fire, queue/timer 0ms boundary, failure/logging without leak and no mock leakage (31/31 supplementary focused evidence within total evolution); file-scoped lint/oxlint/Biome and `git diff --check` pass; independent code audit pass 0 findings and docs audit pass after single-point label correction; authoritative `pnpm build:check` exit 0 on exact final worktree — 579 files passed | 2 skipped, 11,584 tests passed | 79 skipped, renderer 362 files / 5,143 tests, all lint/typecheck/i18n/format/OpenAPI projects pass, Electron ABI 145 SQL probe pass; worktree code/test state unchanged after gate; docs-only edit — gate evidence remains fresh per delivery-validation; E2E not run for isolated renderer-local maintenance activation with no IPC/persistence/lifecycle. ARCH-010 disposition satisfied.

**Residual risks (accepted)**: Startup sweep deferred 0ms may briefly leave expired snapshots until post-bootstrap task fires — mitigated by per-key check-before-refresh (first read returns null) and pending sweep retry on physical-delete failure; first retention enforce before background relies on eager subscriber/handler only with pending byte-cache cover; 0ms scheduling adds one extra task per launch (bounded); scroll LRU failure may temporarily leave over-budget until next sweep — accepted residual; no performance magnitude/SLA/baseline/causal claim; bundle topology/activation evidence is directional only and does not quantify product performance; PERF workstreams independent/open.

#### 6.8.12 S7.11 Implemented Outcome — Critical Bootstrap Synchronous Failure Isolation (2026-08-31, outcome/residual-risk)

**Authorization**: S7.11 authorized as next renderer-local bootstrap hardening; no Main/preload/shared IPC, StoreSync, Redux rehydration, SQLite/Dexie, window lifecycle, policy, or governance crossing. Prior S7.1–S7.10 remain Implemented & Closed.

**Selection rationale**: Startup failure isolation selected consistent with S7.1–S7.10; src/renderer/src/init.ts three critical initializers (StoreSyncService.subscribe(), subscribeTopicDeletionEvents(), webTraceService.init()) require local synchronous isolation without changing static activation, order, or service contracts.

**Scope**: Must do — wrap exactly three call-sites in src/renderer/src/init.ts with independent synchronous try/catch preserving static imports and synchronous order StoreSync→TopicDeletion→WebTrace, one Bootstrap logger (loggerService.withContext('Bootstrap')) with bounded distinct warnings including error, later initializers continue; no dynamic import/timer/microtask/Promise/async/buffering/replay/readiness/delay. Must preserve — static imports, synchronous order, existing tests, house style, S7.10 maintenance, initKeyv/initAutoSync. Must not — change service internals, Main/preload/shared IPC/persistence/lifecycle, StoreSync/Redux/Dexie/SQLite, window lifecycle, buffering/replay/readiness/event-loss window, delay/dynamic import, scheduler, policy, or add WebTrace idempotency guard.

**Locked scope**: LOCK-002 (exactly three call-sites), LOCK-003 (static imports, synchronous order, no event-loss window/readiness/delay, no StoreSync service-internal/authority/contract/IPC/persistence), LOCK-004 (no performance/startup/bundle/byte/SLA claim; build proves topology only), LOCK-005 (S7.14+ deferred, later production optimization not authorized).

**Evidence contract — four fields (S7.11)**:
- **Named decision/outcome**: S7.11 Implemented & Closed only when local isolation for exactly three services satisfied with static imports, synchronous order, independent try/catch, one Bootstrap logger, bounded warnings, continuation, no forbidden changes, residual risks accepted.
- **Claim**: Local synchronous isolation for exactly StoreSyncService.subscribe(), subscribeTopicDeletionEvents(), webTraceService.init() — static imports/order preserved, each independently bounded with one Bootstrap context and distinct warning including error, later initializers continue; changes only the bootstrap call site; no StoreSync service-internal/authority/contract/Main/preload/shared IPC/persistence/lifecycle/delay/dynamic import/buffering/replay/readiness change; build proves topology only.
- **Minimum sufficient method**: Code change in src/renderer/src/init.ts with independent try/catch + one Bootstrap logger; focused Vitest src/renderer/src/init.s7_11.test.ts via canonical Node ABI lane (static imports, no dynamic import, synchronous order, one logger with distinct warnings, no timers/microtasks/async, continuation success/throw cases); file-scoped checks; later independent re-audit + pnpm build topology + authoritative pnpm build:check.
- **Stopping condition**: Focused 13/13 pass without mock leakage/unhandled rejection, file-scoped checks pass, init.ts preserves static imports and synchronous order with independent try/catch and one Bootstrap logger, no forbidden changes, re-audit 0 findings, pnpm build exit 0 and authoritative pnpm build:check exit 0 on exact final worktree.

**Status**: **Implemented & Closed 2026-08-31 (outcome/residual-risk)** — code changes and focused tests applied; fresh pnpm build exit 0 proving topology and re-audit 0 findings; authoritative pnpm build:check exit 0 closes batch. Phase 7 remains partially Open — S7.14+ deferred after S7.13 (later production optimization not authorized).

**Outcome**: src/renderer/src/init.ts preserves static imports and synchronous StoreSync→TopicDeletion→WebTrace order (initStoreSync → initTopicDeletionSubscription → initWebTrace) with each wrapper in independent synchronous try/catch using single bootstrapLogger = loggerService.withContext('Bootstrap') and bootstrapLogger.warn including error; failures bounded to one distinct warning per site, later initializers continue; no timers/microtasks/Promises/async/dynamic imports/buffering/replay/readiness/delay/event-loss window; changes only the bootstrap call site; no StoreSync service-internal/authority/contract/Main/preload/shared IPC/SQLite/Dexie/persistence/lifecycle change; S7.10 maintenance, initKeyv/initAutoSync, house style preserved; renderer-local only; one semantic revert removes wrappers, no migration.

**Verification**: Fresh pnpm build exit 0 proving static synchronous topology (directional only, not startup/bundle/byte/SLA/threshold/baseline/causal; no private paths/raw logs); focused suite src/renderer/src/init.s7_11.test.ts 13/13 via canonical Node ABI lane (static imports, no dynamic import, synchronous order, one Bootstrap logger with distinct warnings, no timers/microtasks/async, continuation success/throw cases); file-scoped checks and git diff --check pass; independent re-audit 0 findings; authoritative pnpm build:check exit 0 — 363 files/5156 tests renderer, all projects pass, lint/typecheck/i18n/format/OpenAPI pass, ABI 145/SQL probe restored; docs-only edit — evidence fresh; E2E not run for isolated renderer-local isolation with no IPC/persistence/lifecycle. ARCH-010 satisfied.

**Residual risks (accepted)**: Per-site bounded warning only — no retry/recovery/replay; service-internal failure requires service fix; first failure does not restore service; no buffering/replay/readiness/event-loss mitigation; no performance/SLA/bundle/byte claim; topology evidence directional only; PERF workstreams independent/open.

#### 6.8.13 S7.12 Implemented Outcome — Startup Critical-Path Attribution (2026-09-01, attribution-only, controlled non-adoption)

**Authorization**: S7.12 explicitly authorized as attribution-only startup slice 2026-09-01; no production optimization, baseline, SLA, threshold, or regression proof authorized. Phase goal was to determine S7.12 next single startup optimization; outcome is controlled non-adoption because topology classification succeeded but timing-dominant root cause cannot be proven.

**Selection rationale**: Startup payload/activation deferral completed through S7.1–S7.11 renderer-local splits; remaining unknown was which sequential blocker dominates wall-clock. S7.12 selected to classify static critical-path topology before any further optimization, using three read-only traces and two sufficiency checks as explicitly authorized.

**Scope — Must do (bounded)**: Classify renderer blocking gates and Main-before-window chain via static code topology only; no IPC/preload contract, schema, migration, StoreSync behavior, or `persist:cherry-studio` compatibility-key change; preserve Main SQLite ordinary-chat authority and StoreSync/Dexie/import projection semantics.

**Scope — Must not**: Edit production/test/config/package content; claim runtime timing, baseline, SLA, threshold, or regression proof; broaden into Phase 8 Sync or Windows PowerMonitor scope (macOS-arm64-first).

**Locked scope**: attribution-only (no production optimization/threshold/baseline/regression); Main SQLite ordinary-chat authority and StoreSync/Dexie/import projection preserved; no IPC/preload contract, schema, migration, StoreSync behavior, or `persist:cherry-studio` compatibility-key change; static topology only — not runtime timing proof, dev/runtime observation diagnostic only.

**Evidence contract — four fields (S7.12)**:
- **Named decision/outcome**: S7.12 is Implemented & Closed only when static startup critical-path topology is classified with blocking/non-blocking/unknown labels and controlled non-adoption is accepted because timing dominance remains unknown.
- **Claim**: Static topology establishes sequential blockers and Main-before-window ordering; timing-dominant production root cause is unknown because existing evidence is insufficient.
- **Minimum sufficient method**: Three read-only static traces (renderer App/PersistGate/ImportProjectionGate/Dexie module evaluation; Main restore/recovery/SQLite init before BrowserWindow; window/IPC/preload readiness) + two sufficiency checks (Redux bench comparability, SQLite Node-lane vs production, Dexie/projection absence, E2E timeline capability) — no runtime instrumentation, no numeric timing.
  - **Stopping condition**: topology summary with blocking/non-blocking/unknown + evidence-limits summary + explicit controlled non-adoption accepted; no production code/config change; docs-only update passes `git diff --check` and link validation.

**Status**: **Implemented & Closed 2026-09-01 (attribution-only, controlled non-adoption)** — docs-only; no production optimization authorized. Phase 7 remains partially Open; S7.14+ deferred (S7.13 closed, later production optimization not authorized).

**Outcome (classification)**:
- **Blocking (renderer)**: `PersistGate` for `persist:cherry-studio` (localStorage rehydration, key `persist:cherry-studio`) then `ImportProjectionGate` are sequential blockers before first usable ordinary tree; eager Dexie module evaluation is blocking (value-shape gating ordinary tree) but ordinary Dexie open/upgrade timing remains unknown.
- **Blocking (Main)**: restore/recovery/SQLite init chain precedes `BrowserWindow` creation.
- **Unresolved runtime gap**: handler/preload/window readiness ordering has an unresolved runtime ordering gap — static topology cannot prove sequence.
- **Non-blocking (ordinary macOS startup)**: trace viewer/import/search windows are lazy (not instantiated on ordinary startup).
- **Out-of-scope**: Windows-only PowerMonitor hidden window outside macOS-arm64-first scope.
- **Preserved**: `persist:cherry-studio` factual correction (localStorage `redux-persist/lib/storage`); Main SQLite ordinary-chat authority; StoreSync/Dexie/import projection semantics; no IPC/preload/schema/migration/StoreSync change.

**Verification / evidence limits**: S7.12 uses static topology only — not runtime timing proof; dev/runtime observation is diagnostic only. Existing evidence is insufficient to identify timing-dominant production root cause: Redux bench has no comparable artifact, SQLite synthetic Node-lane results use another profile/clock, Dexie and projection timing are absent, and existing E2E facilities cannot provide a common startup timeline without production hooks. No baseline, SLA, threshold, or regression proof established; no numeric timings invented or cited; no production config/code/test change.

**Controlled non-adoption**: No startup optimization selected — topology classification succeeded but timing dominance cannot be proven with current evidence. Authorized decision is to close S7.12 as attribution-only and require S7.13 instrumentation before any later production optimization.

**Residual risks (accepted)**: Startup timing bottleneck remains unknown until S7.13 instrumentation; static topology may diverge from production wall-clock; Main-before-window ordering proven only topologically, not timed; handler/preload/window gap remains open; Dexie open/upgrade and projection timing remain unmeasured; Windows PowerMonitor not evaluated; no threshold/baseline/SLA; Phase 7 partially Open.

#### 6.8.14 S7.13 Implemented Outcome — Startup Stage Instrumentation (2026-09-02, attribution-only, outcome/residual-risk)

**Authorization**: S7.13 explicitly activated in this session; attribution-only instrumentation slice; no production optimization, baseline, SLA, threshold, winner, or authority/contract/schema/migration change authorized; later production optimization remains deferred/not authorized.

**Selection rationale**: Startup payload/activation deferral completed through S7.1–S7.12; remaining unknown was timing-dominant wall-clock among sequential blockers classified in S7.12 (PersistGate `persist:cherry-studio` then ImportProjectionGate vs Main restore/recovery/SQLite chain, Dexie module blocking/timing unknown, handler/preload gap unresolved). S7.13 selected as independent default-off harness to produce a bounded comparable timeline before any winner/baseline selection.

**Scope — Must do (bounded)**:
- Independent startup-stage namespace/gate `__STARTUP_STAGE_ATTR__` distinct from `PERF_PHASE_ATTR`/`PERF_STREAM_ATTR`, default-off and fail-closed (malformed throws at config, ordinary builds inline `false`).
- Main-authoritative exact disposable-profile validation with opaque inherited marker: build define + runtime `STARTUP_STAGE_ATTR` + synthetic `STARTUP_STAGE_SYNTHETIC` all required, then Main exact descendant of `cherry-e2e-owned-*` owned root via lexical + `lstat`/`realpath` ancestor checks (no substring heuristic), sets opaque `__CHERRY_STARTUP_STAGE_VALIDATED=1`; renderer requires that marker plus lexical owned-root proof.
- Bounded privacy-safe closed records: closed stage names only (`main.restore`/`cleanupExtractions`/`promotionGate`/`catalogRecovery`/`chatDbInit`/`orphanRecovery`/`createWindow`/`windowReady`/`registerIpc`, `renderer.bootstrap`/`persistRehydrate`/`importProjectionReady`/`ordinaryTreeReady`), at most one per stage/session, finite non-negative monotonic `durationMs`/`epochMs`/`elapsedMs`, bounded scalar `status`/`reason` (≤64 chars, no `/` `\` paths/content/credentials/raw DB size), 32-record cap with drop-oldest, comparable `epochAnchorMs`/`perfAnchorMs`.
- Instrument existing boundaries without changing startup order/authority/IPC/preload/persistence/schema/migration/StoreSync/Dexie open behavior: Main `withStartupStage`/`markStartupStageSync` wrappers around restore/cleanup/promotion/catalog/chatDbInit/orphan/createWindow/windowReady/registerIpc (synchronous createWindow→registerIpc plus asynchronous windowReady readiness milestone); renderer `persistRehydrate` (store rehydrate callback), `bootstrap` (init.ts sync completion), `importProjectionReady` (gate `ready`), `ordinaryTreeReady` (gate effect on `ready`); renderer via dynamic imports, Main via static adapter with guarded local WindowService load, idempotent per stage, fail-closed.
- Renderer gate-ready and ordinary-tree-ready milestones; first data/Dexie milestone intentionally omitted — no safe boundary exists without scope expansion.

**Scope — Must preserve**: startup order, Main SQLite ordinary-chat authority, StoreSync/Dexie/import projection semantics, all IPC/preload/persistence/schema/migration/StoreSync boundaries; S7.1–S7.12 Implemented & Closed not reopened.

**Scope — Must not**: change IPC/preload/shared contract, persistence/schema/migration, StoreSync, Dexie open forcing, `persist:cherry-studio` key, baseline/SLA/threshold/winner, or production optimization; no governance crossing.

**Locked scope**: independent startup-stage namespace/gate default-off fail-closed; closed bounded privacy-safe deduplicated finite non-negative records; explicit build/runtime/Main-authoritative synthetic disposable validation with opaque marker and no persisted flag; preserve startup semantics and all authority boundaries with no Dexie-open forcing; both renderer readiness milestones with no production winner/baseline/SLA/threshold.

**Evidence contract — four fields (S7.13)**:
- **Named decision/outcome**: S7.13 is Implemented & Closed only when independent default-off fail-closed synthetic-disposable harness produces bounded privacy-safe closed records on a comparable Main+renderer timeline without changing startup semantics and is verified by focused tests + audit + authoritative build:check, with no winner/baseline/SLA selected.
- **Claim**: Startup stage instrumentation is independent, default-off/fail-closed, Main-authoritative disposable-profile validated, bounded privacy-safe, and non-invasive to startup order/authority/contract/persistence/schema/migration/StoreSync/Dexie; renderer milestones cover `importProjectionReady` → `ordinaryTreeReady` with first-data milestone intentionally omitted.
- **Minimum sufficient method**: `electron.vite.config.ts` + `vitest.config.ts` independent define; `packages/shared/diagnostics/startupStage.ts` closed primitives; `src/main/services/startupStageDiagnostics.ts` Main-authoritative exact validation + `withStartupStage`/`markStartupStageSync`; `src/renderer/src/services/startupStageDiagnostics.ts` marker-dependent enablement + `markStartupStage`/`markStartupMilestone`; boundary instrumentation in `src/main/index.ts`/`WindowService.ts`/`src/renderer/src/store/index.ts`/`init.ts`/`importProjectionReadiness.ts`/`ImportProjectionGate.tsx`; focused Vitest via canonical Node ABI lane (gate malformed fail-closed, closed/dedup/bounded/privacy checks, Main exact disposable validation, renderer marker inheritance, idempotent milestones) + file-scoped lint/typecheck/format + `git diff --check` + independent audit/re-audit + authoritative `pnpm build:check`.
- **Stopping condition**: Focused tests pass true/isolated, file-scoped checks pass, changed boundaries preserve order/authority/no new IPC/preload/persistence/schema/migration/StoreSync/Dexie-open, audit 0 findings, `pnpm build:check` exit 0 on exact final worktree, docs mark Implemented & Closed with later optimization explicitly deferred and residual risk stated.

**Status**: **Implemented & Closed 2026-09-02 (attribution-only instrumentation, outcome/residual-risk)** — attribution-only harness; no production optimization, baseline, SLA, threshold, or winner selected. Phase 7 remains partially Open (S7.14+ deferred, later production optimization not authorized).

**Outcome (instrumentation, semantic boundary)**:
- **Independent gate/namespace**: `__STARTUP_STAGE_ATTR__` distinct from `PERF_PHASE_ATTR`; ordinary builds inline `false` (inert), instrumentation build requires `STARTUP_STAGE_ATTR=1` at build and runtime (malformed throws at config load or bounded warn).
- **Main-authoritative exact validation + opaque marker**: Main validates `STARTUP_STAGE_SYNTHETIC=1` AND exact descendant of owned root `cherry-e2e-owned-*` via lexical `path.relative` + `lstat`/`realpath` directory/symlink checks (substring not accepted); on success sets opaque `__CHERRY_STARTUP_STAGE_VALIDATED=1` before `BrowserWindow` creation; `process.env` marker never accepted as input (cleared before validation); Vitest isolated unit path (`VITEST=true`) allows token+marker only.
- **Renderer marker-dependent enablement**: renderer requires build + runtime gate + `STARTUP_STAGE_SYNTHETIC=1` + inherited `__CHERRY_STARTUP_STAGE_VALIDATED=1` + lexical owned-root (`TMPDIR` segment `cherry-e2e-owned-*`); without Main's marker, renderer stays inert (fail-closed); E2E validates causal marker `1` in both processes.
- **Bounded privacy-safe closed records**: `STARTUP_STAGE_VALUES` closed union (9 Main + 4 renderer), one per stage/session, finite non-negative `durationMs`/`epochMs`/`elapsedMs` via `performance.now()` + `epochAnchorMs`, bounded scalar `status` (`ok`/`error`/`skipped`)/`reason` (≤64, no `/` `\`), 32-record cap overflow-flagged, `epochAnchorMs`/`perfAnchorMs` comparable within 60s wall-clock; never content/paths/IDs/credentials/raw DB size/stacks.
- **Non-invasive boundary instrumentation**: Main 9 stages wrapped without reordering/branching (synchronous `main.restore`→`cleanupExtractions`→`promotionGate`→`catalogRecovery`→`chatDbInit`→`orphanRecovery`→`createWindow`→`registerIpc` plus asynchronous `windowReady` readiness milestone via stored `performance.now()` anchor in `WindowService`); renderer 4 milestones (`bootstrap`→`persistRehydrate`→`importProjectionReady`→`ordinaryTreeReady`) via dynamic import + idempotent guards; no IPC/preload/shared-contract, persistence/schema/migration, StoreSync, Dexie open, or authority change; no persisted flag.
- **Renderer milestones**: `importProjectionReady` (ImportProjectionGate `ready`) and `ordinaryTreeReady` (ordinary tree `ready` effect) both recorded and ordering-checked; first data/Dexie milestone intentionally omitted as no safe boundary exists without scope expansion — documented as accepted unknown.
- **Preserved**: `persist:cherry-studio` per LOCK-COMPAT-003; Main SQLite ordinary-chat authority; StoreSync/Dexie/import projection semantics; all IPC/preload/persistence/schema/migration/StoreSync/retention boundaries; no Dexie-open forcing.
- **Changed-file surface (semantic-risk boundary)**: build: `electron.vite.config.ts`, `vitest.config.ts`, `packages/shared/env.d.ts`, `src/main/env.d.ts`, `src/renderer/src/env.d.ts`; shared: `packages/shared/diagnostics/startupStage.ts`; Main: `src/main/services/startupStageDiagnostics.ts`, `src/main/index.ts`, `src/main/services/WindowService.ts`; renderer: `src/renderer/src/services/startupStageDiagnostics.ts`, `src/renderer/src/store/index.ts`, `src/renderer/src/init.ts`, `src/renderer/src/services/importProjectionReadiness.ts`, `src/renderer/src/components/ImportProjectionGate.tsx`; tests/harness: `packages/shared/diagnostics/__tests__/startupStage.test.ts`, `src/main/services/__tests__/startupStageDiagnostics.test.ts`, `src/renderer/src/services/__tests__/startupStageDiagnostics.test.ts`, `src/renderer/src/components/__tests__/ImportProjectionGate.startupStage.test.tsx`, `tests/e2e/utils/startupStage.ts`, `tests/e2e/utils/startupStage.test.ts`, `tests/e2e/specs/startup/startup-stage-instrumentation.spec.ts` (default-off, synthetic disposable only).
- **No winner/baseline/SLA/threshold/production optimization** — attribution-only harness to select one later optimization after evidence; instrumentation itself is not the optimization.

**Verification / evidence limits**:
- Independent audit and re-audit passed with no findings (0 findings each).
- Focused Vitest via canonical Node ABI lane covering gate fail-closed, closed/dedup/bounded/privacy, Main exact disposable validation (lexical → `lstat`/`realpath` ancestor, symlink/dir checks, fallback `cherry-e2e-*` Vitest-only), renderer marker inheritance (marker required, lexical owned-root, `TMPDIR` proof), idempotent milestones and ordering, epoch comparable; `git diff --check` pass, file-scoped lint/typecheck/format pass.
- Authoritative `pnpm build:check` passed exit 0 on exact code state under Node 24.11.1 / pnpm 10.27.0; fresh `pnpm build` exit 0 proving independent `__STARTUP_STAGE_ATTR__` define (inert `false` default, `true` only with `STARTUP_STAGE_ATTR=1`); no startup order/authority/IPC/preload/persistence/schema/migration/StoreSync/Dexie-open change.
- **Residual validation risk (accepted)**: no fresh enabled Electron runtime E2E was executed (`STARTUP_STAGE_ATTR=1 STARTUP_STAGE_SYNTHETIC=1` with `STARTUP_STAGE_ATTR=1` instrumentation build); synthetic disposable harness therefore not exercised on a fresh enabled Electron runtime in this batch — remains unproven on live timeline until a future explicitly activated enabled E2E run; this does not claim failure, only unexercised enabled path. Harness is fail-closed and inert on ordinary `pnpm test:e2e`; enabled run remains synthetic disposable only.
- No baseline, SLA, threshold, winner, or production optimization established; later production optimization remains deferred/not authorized.

**Residual risks (accepted)**: Enabled path requires both build and runtime gates plus exact disposable validation; ordinary builds/profile stay inert (zero overhead beyond `performance.now()` anchors and dynamic-import guards). Renderer enablement best-effort lexical owned-root proof without `userDataDir` — Main exact validation is authoritative. Overflow never triggered (13 stages < 32 cap). First-data/Dexie milestone remains intentionally unknown until a safe boundary is defined. Timing-dominant bottleneck remains unknown until a future enabled synthetic disposable run analyzes the bounded timeline; S7.13 itself selects no winner. No threshold/baseline/SLA; Phase 7 partially Open.

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
| **M1** | Middle/batch insert `sort_order` shift — scale curve | None — harness Implemented and executed as measurement-only directional L3 on 2026-08-31 (9 combinations N=100/500/1000 × M=1/10/50, 45 finite numeric metrics, 3/3 correctness gates, schema-v1 artifact `chatdb-sort-order-shift-20260831-235421.921.json`, 2026-08-31T15:54:21.031Z, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 59b9eefecacb5fe93754b3604d0ce802b22d34d6 clean, `pnpm bench:sort-order-shift`, synthetic isolated, directional-only, analysis-only; future invocations remain inactive by default, requires explicitly activated decision/outcome + four fields to count as valid/progress; independent DB-health diagnostic, no threshold/baseline/SLA/phase-closure/S6.4/S6.5/Phase 8/schema/index/migration/IPC/lifecycle authorization) |
| **M2** | Short (<3 codepoint) LIKE full-table scan — stage attribution | None |
| **M3** | Index/query opportunity — query-plan diagnosis | None |
| **M7** | Cold open/load path — DB volume impact attribution | None |
| **M4** | FTS/normalized storage-duplication volume diagnostic — read-only numeric-only aggregation (row counts, char/UTF-8 bytes, FTS smoke; logical duplication only, no observed physical DB size) | None — harness implemented, inactive by default (`M4_FTS_DUP_BENCH=1` + `M4_FTS_DUP_SCALE=1k|10k|50k` default 10k), `m4FtsDuplication.bench.ts` + `m4FtsDuplication.ts` + pure helper tests; isolated `mkdtemp` + `registerChatDbNormalize` + `runMigrations` schema-v1 + existing `generateCorpus`; 1k/10k/50k synthetic profiles are measurement-only directional L3 via `pnpm bench:m4-fts-dup` (no threshold/baseline/dedup authorization; S6.5 remains Candidate — Not Authorized; real corpora/physical DB size unresolved; exact metrics in `performance-measurement.md` §6); requires explicitly activated decision/outcome + four fields to count as valid/progress; 2026-09-01 accepted: `chatdb-m4-fts-duplication-50k` 50k synthetic directional L3 (full record in §7.3.2); future runs inactive by default |
| **M5** | File dual-state consistency — bounded synthetic parity/divergence diagnostic | None — harness Implemented and executed as measurement-only directional L3 (`M5_FILE_DUAL_BENCH=1`, `pnpm bench:m5-file-dual-state`, small/medium bounded profiles, inactive by default; small-profile evidence completed 2026-08-31 — 100 references, 4 scenarios, synthetic directional L3); no user data/real profile/ZIP/Dexie/Files/path/content/credential/raw DB size; no production authority/schema/IPC/persistence change, no runtime-consistency proof, no S6.5 authorization or phase closure; 2026-09-01 accepted: `chatdb-m5-file-dual-state` medium — one 1,000-reference synthetic dataset evaluated against 4 fixed deterministic scenarios, synthetic directional L3 (full record in §7.3.2); future runs inactive by default |
| **M8** | Backup/restore health — L3 archive metadata | None — harness Authorized & Implemented and executed as measurement-only directional L3 on 2026-08-31/2026-09-01 (3 scenarios ×5 measured samples, 21/21 scenario gates (7 gate kinds ×3), 15 finite numeric metrics, schema-v1 artifact `chatdb-m8-l3-archive-health-20260901-000004.064.json`, 2026-08-31T16:00:03.394Z, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 59b9eefecacb5fe93754b3604d0ce802b22d34d6 clean, `pnpm bench:m8-l3-archive`, synthetic isolated, privacy-safe, directional-only, analysis-only; synthetic archive/restore health only, does not prove real relaunch/recovery or user-data consistency; future invocations remain inactive by default, requires explicitly activated decision/outcome + four fields to count as valid/progress; no threshold/baseline/closure/authorization; detailed per-run values and provenance in Git history, not reproduced here) |

All are read-only with respect to production/user state (M8 permitted owned temporary backup/restore writes inside isolated `mkdtemp` root only; M4 is read-only post-seed numeric aggregation; M5 uses only owned synthetic SQLite rows plus explicit synthetic catalog/physical booleans). They do not require governance/ADR but require explicitly activated decision/outcome with all four evidence-task fields before execution can count as valid/progress (`performance-program.md` §4B); explicit activation alone is insufficient. Harness implementation or synthetic execution is not production authorization and does not authorize S6.5.

**Current DB-health frontier:** S6.4 SQ-01 Rejected 2026-08-29 — no ADR, no production implementation, current LIKE retained; M2/M3 evidence batch closed. M1 sort-order shift (9 combinations), M4 bounded synthetic profiles (1k/10k/50k — 50k 2026-09-01 `chatdb-m4-fts-duplication-50k`), M5 bounded synthetic matrix (small 100 refs + medium — one 1,000-reference dataset, 4 scenarios `chatdb-m5-file-dual-state`), M8 L3 archive health, and B-01..B-05 calibration are implemented/executed only as measurement-only directional L3 evidence (synthetic isolated, privacy-safe, directional-only; details in §7.3/§7.3.2 and `performance-measurement.md` §6; Git owns provenance; B-01..B-05 calibration optional/non-blocking; M1 independent diagnostic; M8 synthetic archive/restore only). No production authority/schema/IPC/persistence change; no threshold/baseline/capacity/eviction/policy, runtime-consistency proof, S6.5 authorization, or Phase 4/5/6 closure follows. Any real-corpus/physical-size diagnostic or production S6.5 work remains ADR/governance-gated; no DB-health production batch ready.

### 7.2 Architecture-phase-dependent (requires governance)

**B-01..B-05 / M6 status:** B-01..B-05 are implemented renderer-local retention enforcement (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin), not empirically optimal/baselines/SLA; calibration harness Implemented and executed as measurement-only directional L3 on 2026-08-31 (small profile, 25 finite numeric metrics, 7/7 correctness gates, schema-v1 artifact `b0105-calibration-20260831-235508.418.json`, 2026-08-31T15:55:06.202Z, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 59b9eefecacb5fe93754b3604d0ce802b22d34d6 clean, `pnpm bench:b0105-calibration`, synthetic isolated, privacy-safe, directional-only, analysis-only; synthetic logical-boundary/TTL/LRU/fit-step/oversized classifications; does not change implemented defaults, not adopted optima; future invocations remain inactive by default, requires explicitly activated decision/outcome + four fields to count as valid/progress; optional/non-blocking, measurement-only directional). M6 remains analysis-only with no schema/migration/sync design; small-profile directional evidence completed 2026-08-31 (7/7 gates passed, schema-v1 artifact `chatdb-m6-sync-metadata-gap-small-20260831-232423.448.json`, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 9a929453695bec9c5b68b23dc4035589998319e9 clean, synthetic isolated, numeric-only, privacy-safe, directional-only; 4 schema-absent + 5 open-design categories, 5 required +1 excluded tables, 11 excluded domains) — harness remains inactive by default for future runs. M6's fixed fingerprint is 4 `schema-absent` categories (`revision-version`, `ordering-cursor`, `deletion-tombstone`, `outbox-checkpoint`) and 5 `open-design` categories (`device-local-leakage`, `idempotence-atomicity`, `checkpoint-boundary`, `conflict-matrix`, `extra-field-governance`); its scoped inventory is 5 required structural tables (`topics`, `messages`, `message_blocks`, `topic_segments`, `topic_segment_messages`) plus 1 explicitly excluded `file_references` table, with 11 excluded sync domains tracked separately. Provenance: 2026-08-31T15:24:22.783Z, commit 9a929453695bec9c5b68b23dc4035589998319e9 clean; no threshold/baseline/authorization/phase-closure or sync-schema claim.

| Item | Scope | Dependencies |
|---|---|---|
| **Full-topic/windowed fetch/cache joins** | Data-access contract implementation | Phase 5 contract; S6.1–S6.3 implemented; S6.4 SQ-01 Rejected 2026-08-29 (no ADR, current LIKE retained); S6.5 Candidate — Not Authorized |
| **M4** FTS dedup | Volume/write-amplification + schema | ADR |
| **M5 production resolution** | File dual-state consistency/authority resolution | M5 synthetic directional evidence; ADR/governance if production schema/authority is touched |
| **M6** Sync metadata gap | Schema impact analysis | ADR; **harness Implemented and executed as measurement-only directional L3 on 2026-08-31 (small profile, 4 schema-absent + 5 open-design categories, 5 required +1 excluded tables, 11 excluded domains, 7/7 gates passed, schema-v1 artifact `chatdb-m6-sync-metadata-gap-small-20260831-232423.448.json`, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 9a929453695bec9c5b68b23dc4035589998319e9 clean, synthetic isolated, numeric-only, privacy-safe, directional-only, analysis-only); future invocations inactive by default; no schema/migration/sync design, no authorization/phase-closure** |

### 7.3 Diagnostic calibration summary (directional, non-adoption)

- **C-01 logical payload**, **C-02 heap (chatdb-c02-renderer-heap-e2e)**, **pinned working-set** calibrations are synthetic, isolated, privacy-safe, measurement-only directional L3, non-adoption, analysis-only (LOCK-001: synthetic, no production/threshold/baseline/SLA/capacity/phase-closure/S6.4/S6.5/Phase 8/schema/migration/IPC/authority change; LOCK-003: logical bytes not heap/capacity; LOCK-004: path-safe, gitignored). They demonstrate canonical invariants (lexicographic keys, compact JSON, determinism), partition-sum exactness, orphan/non-finite rejection, and single-machine heap-amplification sampling (GC-sensitive, `performance.memory` precise mode). **Accepted final states: C-01 8 profiles 92 metrics 12/12 gates, independent canonical/UTF-8 checks, fail-closed emitter, logical accounting only, schema-v1, Node ABI 137; C-02 fresh build + clean-commit Electron E2E benchmark chatdb-c02-renderer-heap-e2e, schema-v1, ABI 145, uniform 23 metrics/12 gates, mixed 48/9, all 48/9, all required gates pass, synthetic isolated, privacy-safe, directional measurement-only, no threshold/baseline/SLA/capacity/policy/closure, future inactive by default and requires activation.** Per-profile values remain in gitignored artifacts under `test-results/bench-results/` with schema v1; they are not thresholds, baselines, or capacity policies. **C-01 canonical accounting is shared pure cross-runtime infrastructure** (`packages/shared/chatDb/logicalPayload.ts`, `TextEncoder`/`utf8ByteLength`, Buffer parity proved; `phase4-logical-payload-v1`, B-01/B-02/B-05 values, strict boundary semantics, and schema v1/benchmark IDs preserved) — no working-set policy, IPC, persistence, or capacity-threshold adoption. The full Phase 4 sequence is executable via opt-in `pnpm calibration:phase4` (Node → Node → Electron → Electron lanes, fail-closed per step, independent schema-v1 artifacts, measurement-only, does not close Phase 5, no CI auto-invocation). Git owns run history.
- **Stream persistence differential (PERF-STREAM-ATTR-001)** — synthetic, measurement-only, directional L3, **差分估计仅、非直接 trigger 内部剖析、非根因** (LOCK-001: 合成、analysis-only、measurement-only、方向性 L3; LOCK-002: 差分估计、测量完成转换与 preflight 为 harness 证据所主张; LOCK-004: 路径安全、gitignored). Deterministic temp DB trigger-on vs base-only differential (growth/nochange/completion 三 profile, 200-block 语料). **Final clean state on 2026-08-31T18:37:36.572Z — 3 profiles, 43 metrics, 8/8 gates, schema-v1 artifact `chatdb-stream-persist-node-20260901-023737.217.json`, 200-block 语料, rowid 269 (DELETE+INSERT trigger 每更新触发已证), 投影 201 行, 首次完成转换双 lane 成功, 完整 preflight 于计时前, 差分估计仅, `pnpm bench:stream-persist`, Node 24.11.1/pnpm 10.27.0/ABI 137, commit adefeae4a03091af2301c6dd80c5b15664758048 clean (dirty=false), 合成 isolated, gitignored, 路径安全, 方向性 L3; future invocations remain inactive by default, requires explicitly activated decision/outcome + four fields; 不关闭 phase, 不授权 S6.4/S6.5/Phase 8/schema/index/migration/IPC/authority 变更; 无阈值/基线/SLA/容量/堆主张；8 gates 含 preflight 与 rowid/投影/完成转换校验，失败无 artifact**; no absolute user paths; no production runtime behavior, direct trigger profiling, heap/capacity/SLA/threshold/baseline or S6.5/Phase 8 authorization claimed.
- **M2/M3/M7** clean-HEAD directional evidence demonstrates harness correctness and attribution (50k corpus for M2/M3, ~1k messages for M7) with parity and correctness gates; no index benefit or threshold adoption.
- **M1** sort-order shift controlled scale curve — harness Implemented and executed as measurement-only directional L3 on 2026-08-31 (9 combinations N=100/500/1000 × M=1/10/50, 45 finite numeric metrics, 3/3 correctness gates, schema-v1 artifact `chatdb-sort-order-shift-20260831-235421.921.json`, 2026-08-31T15:54:21.031Z, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 59b9eefecacb5fe93754b3604d0ce802b22d34d6 clean, `pnpm bench:sort-order-shift`, synthetic isolated, directional-only, analysis-only; future invocations remain inactive by default, requires explicitly activated decision/outcome + four fields to count as valid/progress); independent DB-health diagnostic, no threshold/baseline/SLA/phase-closure/S6.4/S6.5/Phase 8/schema/index/migration/IPC/lifecycle authorization; does not authorize production implementation.
- **M4** 1k, 10k, and 50k synthetic directional evidence — via `pnpm bench:m4-fts-dup` (directional only, measurement-only; S6.5 remains Candidate — Not Authorized; real corpora and physical DB size remain unresolved; exact metrics in `performance-measurement.md` §6 and full record in §7.3.2). 2026-09-01 accepted: `chatdb-m4-fts-duplication-50k` 50k synthetic directional L3 (logical duplication only). Further M4 real-corpus/physical-size work requires explicitly activated decision/outcome + four fields and governance/ADR; no DB-health production batch is Ready now.
- **M5** bounded synthetic file dual-state — medium profile — one 1,000-reference synthetic dataset evaluated against 4 fixed deterministic scenarios (`chatdb-m5-file-dual-state`), synthetic directional L3 (derived classification); synthetic isolated, privacy-safe, directional-only, S6.5 remains Candidate — Not Authorized (full record in §7.3.2).
- **M8** backup/restore harness validates archive safety, authoritative `chat.db` presence, excluded artifact absence, snapshot integrity, and staged restore parity (inside `preExitCleanup` callback) via isolated synthetic fixtures; Harness Authorized & Implemented and executed as measurement-only directional L3 on 2026-08-31/2026-09-01 (3 scenarios ×5 measured samples, 21/21 scenario gates (7 gate kinds ×3), 15 finite numeric metrics, schema-v1 artifact `chatdb-m8-l3-archive-health-20260901-000004.064.json`, 2026-08-31T16:00:03.394Z, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 59b9eefecacb5fe93754b3604d0ce802b22d34d6 clean, `pnpm bench:m8-l3-archive`, synthetic isolated, privacy-safe, directional-only, analysis-only; future invocations remain inactive by default, requires explicitly activated decision/outcome + four fields to count as valid/progress); synthetic archive/restore health only, does not prove real relaunch/recovery or user-data consistency; no threshold/baseline/closure/authorization; no real relaunch/startup promotion proven; single-machine synthetic only.
- **B-01..B-05** calibration harness is Implemented and executed as measurement-only directional L3 on 2026-08-31 (small profile, 25 finite numeric metrics, 7/7 correctness gates, schema-v1 artifact `b0105-calibration-20260831-235508.418.json`, 2026-08-31T15:55:06.202Z, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 59b9eefecacb5fe93754b3604d0ce802b22d34d6 clean, `pnpm bench:b0105-calibration`, synthetic isolated, privacy-safe, directional-only, analysis-only; synthetic logical-boundary/TTL/LRU/fit-step/oversized classifications; future invocations remain inactive by default, requires explicitly activated decision/outcome + four fields to count as valid/progress), inactive by default for future runs, optional/non-blocking; B-01..B-05 are now enforced renderer-local retention and the harness remains measurement-only directional — not thresholds/baselines/capacity eviction adoption beyond implemented defaults, does not change implemented defaults, not adopted optima; Phase 4 closed 2026-08-29 (outcome/residual-risk); does not authorize production implementation, thresholds, baselines, SLA/capacity policy, phase closure, S6.4/S6.5, Phase 8, schema/index/migration/IPC/lifecycle changes, or policy adoption.
- **M6** synthetic sync metadata gap harness is **harness Implemented and executed as measurement-only directional L3 on 2026-08-31 (small profile, 4 schema-absent + 5 open-design categories, 5 required +1 excluded tables, 11 excluded domains, 7/7 gates passed, schema-v1 artifact `chatdb-m6-sync-metadata-gap-small-20260831-232423.448.json`, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 9a929453695bec9c5b68b23dc4035589998319e9 clean, synthetic isolated, numeric-only, privacy-safe, directional-only, analysis-only)**; future invocations remain inactive by default; it does not define schema, migration, sync design, or authorization and does not authorize S6.5/Phase 8/sync-schema or phase closure.

### 7.3.2 2026-09-01 M4/M5 Activated Evidence Batch — Four-Field Contracts, Provenance, and Decision

**Activation**: Explicitly activated 2026-09-01 by user-authorized autonomous implementation. Both tasks required external four-field activation record; artifacts alone were not progress until this record.

**Evidence contract — four fields (M4 2026-09-01)**:
- **Named decision/outcome**: M4 logical duplication magnitude is accepted as synthetic directional decision evidence only when the 50k synthetic corpus aggregation artifact is accepted; outcome does not authorize S6.5, nor dedup/index/storage change, nor ADR.
- **Claim**: At 50k `message_blocks` (type `main_text`), logical duplication of normalized + FTS content is 2,567,500 + 2,567,500 = 5,135,000 UTF-8 bytes (logical duplication only; not a physical DB size/cost, not a real-corpus prevalence, not a benefit threshold, not a search-parity claim).
- **Minimum sufficient method**: Owned `mkdtemp` + `registerChatDbNormalize` + `runMigrations` schema-v1 + deterministic 50k corpus generation; read-only numeric aggregation (canonical/normalized/FTS row counts, normalized/FTS chars, normalized/FTS UTF-8 bytes, logical duplication) + FTS5 `FTS_SMOKE_TOKEN` MATCH smoke; correctness gates `parity.rowCounts`, `fts.smoke`, `corpus.completeness`, `metrics.finite`; via `pnpm bench:m4-fts-dup` with `M4_FTS_DUP_BENCH=1` + `M4_FTS_DUP_SCALE=50k`.
- **Stopping condition**: Artifact schema v1 emitted only on all tinybench tasks and all 4/4 gates passed with finite non-negative metrics; otherwise fail-closed (no artifact).

**Evidence contract — four fields (M5 2026-09-01)**:
- **Named decision/outcome**: M5 file dual-state derived classification is accepted as synthetic directional decision evidence only when the medium one 1,000-reference synthetic dataset evaluated against 4 fixed deterministic scenarios — artifact is accepted; does not establish production inconsistency or authorize S6.5.
- **Claim**: Four fixed deterministic synthetic states are classified with derived parity/divergence counts and degraded-marker semantics, rejecting inconsistent derived records; not independent Dexie/filesystem observation, not production inconsistency, not a real profile/ZIP/filesystem drift claim.
- **Minimum sufficient method**: Owned `mkdtemp` schema-v1 SQLite with synthetic `file_references` (one 1,000-reference synthetic dataset evaluated against 4 fixed deterministic scenarios) + explicit synthetic catalog/physical-presence booleans for four fixed deterministic scenarios (aligned, catalog drift, physical missing, degraded marker); derived counts `scenario.count/reference.count/scenario.aligned.count/scenario.divergent.count/scenario.degraded.count/catalog.parity.count/physical.parity.count/degraded.marker.count` via `pnpm bench:m5-file-dual-state` with `M5_FILE_DUAL_BENCH=1` medium profile; gates `scenario.completeness`, `parity.divergence`, `degraded.marker`, `metrics.finite`, `output.privacy` (closed numeric-only).
- **Stopping condition**: Artifact schema v1 emitted only on all tasks and all 5/5 gates passed with closed numeric-only privacy; otherwise fail-closed.

**Provenance — accepted artifacts (schema v1, synthetic directional L3; details in `performance-measurement.md` §6 and `performance-workstreams.md` §2.4; Git owns full provenance)**:
- M4: `chatdb-m4-fts-duplication-50k` — 50k blocks, logical duplication only
- M5: `chatdb-m5-file-dual-state` — medium profile, one 1,000-reference synthetic dataset evaluated against 4 fixed deterministic scenarios, derived classification

**Decision — supported**: Harnesses are valid within their synthetic directional boundaries as privacy-safe, isolated, measurement-only directional L3 decision evidence for logical duplication magnitude (M4) and fixed deterministic synthetic state classification (M5).

**Decision — not supported**: Evidence does not measure physical DB cost, real-corpus incidence, benefit thresholds, search parity, or production behavior (M4); does not observe production inconsistency via independent Dexie/filesystem, nor real profile/ZIP drift, nor production authority/schema (M5). No baseline, threshold, SLA, capacity, policy, regression proof, phase closure, or production authorization follows. S6.5 remains Candidate — Not Authorized; any future schema/index/storage/authority production change remains separately ADR/governance-gated. No code/config change.

**Unchanged frontier**: Main SQLite authority, Renderer bounded residency (B-01..B-09), IPC/schema/migration/anchor semantics preserved; real-corpus/physical-size frontier remains unresolved; no ready-now production batch.

### 7.4 Design contract — M8 Backup/restore (summary)

Contract `chatdb-m8-l3-archive-health` as `main-native` Node lane (ABI 137) with real `better-sqlite3`/`archiver`/`StreamZip`; owned per-sample `mkdtemp` root; three bounded scenarios S0/S1/S1-wide (numeric `scenarioCount=3`); bounded gate details; artifact to `test-results/bench-results` via schema v1; privacy-safe (no message text/paths/credentials). Future invocations remain inactive by default and require separate M8 activation + env gate. No new artifact schema, threshold, or sync implication.

---

## 8. Startup/Memory Relationship

Conversation lifecycle design directly enables:

- **Lazy activation (S3.5)**: Deferred mount of ContentSearch/EditMode/optional panels — closed, not duplicated by S7.1.
- **Bounded state**: Scoped, GC-able topic projections (Phase 4).
- **Bundle/activation boundary (S7.1)**: Secondary top-level routes deferred to separate chunks while `/` chat remains eager — renderer-only, no Main/IPC/schema boundary.

Independent/deferred tracks not blocked by S7.1–S7.13 — S7.1–S7.13 Implemented & Closed 2026-09-02 (outcome/residual-risk; S7.12 attribution-only, S7.13 attribution-only instrumentation), S7.14+ deferred (later production optimization not authorized):

| Track | Description | Independence | Status |
|---|---|---|---|
| App boot services | Service init order/parallelism (remaining beyond S7.11) | Independent | S7.14+ deferred (not selected without explicit activation; S7.13 instrumentation closed, later production optimization not authorized) |
| Redux rehydration | redux-persist hydration from localStorage (`redux-persist/lib/storage`, key `persist:cherry-studio`) via `PersistGate` — sequential blocker before ordinary tree | Independent | **S7.12 classified — sequential blocker (attribution-only; timing unknown)** |
| Dexie init | IndexedDB module evaluation blocking; open/upgrade timing unknown | Independent | **S7.12 classified — module blocking, timing unknown** |
| SQLite cold open | First DB open latency — Main restore/recovery/SQLite chain before BrowserWindow | Main-process, independent | **S7.12 classified — Main chain blocking (attribution-only; timing unknown)** |
| Bundle loading (S7.1) | Secondary route chunks (Files/Notes/Knowledge/Settings/Launchpad) — five secondary lazy, Home eager, localized fallback, tagged retry/Home recovery; renderer-only, distinct production chunks | Build/tooling, renderer-only | **S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk)** |
| Startup readiness (S7.2) | Hydration gate loading/error/retry UX + B-08 `takeRecords()` draining; max 500 live Ranges, unconditional cross-chunk DOM rescan, `childList/subtree/characterData/attributes`, LOCK-PROJECTION/LOCK-003 preserved | Renderer-only, no IPC/SQLite/Dexie/StoreSync | **S7.2 Implemented & Closed 2026-08-30 (outcome/residual-risk)** |
| Antd locale on-demand (S7.3) | Antd locale per-locale dynamic chunks (12 locales, cache, stale-guard, fallback); renderer-local, no dayjs/translation JSON, no Main/IPC/persistence | Renderer-only, no IPC/SQLite/Dexie/StoreSync | **S7.3 Implemented & Closed 2026-08-30 (outcome/residual-risk)** |
| Translation + Day.js locale on-demand (S7.4) | Translation JSON + Day.js locale per-locale dynamic chunks (12 translation + 11 Day.js locale chunks, atomic activation, explicit literal imports, stale-guard, fallback); renderer-local, no Inputbar/Home regression, no Main/IPC/persistence | Renderer-only, no IPC/SQLite/Dexie/StoreSync/governance | **S7.4 Implemented & Closed 2026-08-30 (outcome/residual-risk)** |
| XLSX export on-demand (S7.5) | XLSX export via literal dynamic import (`xlsxLoader` private success/pending cache, concurrent deduplication, retry after rejection, typed named/default normalization), export/cancel/write/error preserved; renderer-local, no Main/IPC/persistence | Renderer-only, no IPC/SQLite/Dexie/StoreSync/governance | **S7.5 Implemented & Closed 2026-08-30 (outcome/residual-risk)** |
| Home-message KaTeX atomic on-demand (S7.6) | Home-message KaTeX via literal dynamic imports (complete atomic chain, parser-compatible fenced-math detection, shared pending/cache/retry, bounded per-block failure with fallback/source Markdown, streaming/race/plugin preserved); renderer-local, no Main/IPC/persistence | Renderer-only, no IPC/SQLite/Dexie/StoreSync/governance | **S7.6 Implemented & Closed 2026-08-31 (outcome/residual-risk)** |
| Mermaid demand-activation (S7.7) | Unconditional `useMermaid()` removed from eager `CodeStyleProvider`, `MermaidPreview` remains demand owner; Mermaid remains deferred until preview use; renderer-local, no Main/IPC/persistence | Renderer-only, no IPC/SQLite/Dexie/StoreSync/governance | **S7.7 Implemented & Closed 2026-08-31 (outcome/residual-risk)** |
| Code tooling demand activation (S7.8) | Shiki theme-metadata demand activation and shared CodeEditor/CodeMirror lazy activation — provider mount without metadata load, custom-theme await vs default/auto fallback, supported retry, thin wrapper + literal dynamic import with ReactCodeMirror/useCodeMirror/prepareCodeChanges in separate async chunk, API/ref preserved via lazy/Suspense with localized loading shell (Ant Design `Spin`/loading text/`aria-busy`) and bounded local error fallback, no false chunk retry action; directional topology/activation only | Renderer-only, no IPC/SQLite/Dexie/StoreSync/governance | **S7.8 Implemented & Closed 2026-08-31 (outcome/residual-risk)** |
| Auto-sync tooling demand activation (S7.9) | Bootstrap removes BackupService/NutstoreService static activation, literal dynamic imports at existing 8s demand check through proxy chunks, SettingsPage retains static imports, 8s/switch/interval/lastSyncTime/retry/IPC/Redux/settings preserved; renderer-local, no Main/IPC/persistence — directional topology/activation only | Renderer-only, no IPC/SQLite/Dexie/StoreSync/governance | **S7.9 Implemented & Closed 2026-08-31 (outcome/residual-risk) — entry `index-DU1QcOXC.js` uses awaited dynamic boundaries through proxy chunks, SettingsPage retains static imports, 14/14 + `pnpm build`/`pnpm build:check` verified** |
| Maintenance activation (S7.10) | Scroll 0ms bounded post-bootstrap global TTL/LRU sweep + retention 60s timer + queueIdle/windowReadIdle background registration split with check-before-refresh fix; Keyv creation/init and lifecycle/deletion/byte-cache stay eager/sync via plain `setTimeout(0)` — directional topology/activation only | Renderer-only, no IPC/SQLite/Dexie/StoreSync/governance | **S7.10 Implemented & Closed 2026-08-31 (outcome/residual-risk) — entry `index-DXjM4Z9p.js` with `residentRetention-BjzUo1ip.js` proves timer boundary, focused 31/31 + `pnpm build`/`pnpm build:check` verified** |
| Critical bootstrap failure isolation (S7.11) | Static synchronous StoreSync→TopicDeletion→WebTrace with independent try/catch, one Bootstrap logger, bounded distinct warnings; changes only the bootstrap call site; no StoreSync service-internal/authority/contract/Main/preload/shared IPC/persistence/lifecycle/delay/dynamic import/buffering/replay/readiness change; topology only | Renderer-only, no IPC/SQLite/Dexie/StoreSync/governance | **S7.11 Implemented & Closed 2026-08-31 (outcome/residual-risk) — focused 13/13 + re-audit 0 findings + pnpm build/build:check exit 0, renderer 363/5156, ABI 145/SQL probe** |
| Startup critical-path attribution (S7.12) | Static topology: `PersistGate` (`persist:cherry-studio`) then `ImportProjectionGate` sequential blockers; Dexie module blocking/timing unknown; Main restore/SQLite before window; handler/preload gap unresolved; trace/import/search lazy on macOS; PowerMonitor out-of-scope | Attribution-only, no IPC/schema/StoreSync/governance | **S7.12 Implemented & Closed 2026-09-01 (attribution-only, controlled non-adoption) — no production optimization, timing-dominant unknown; see §6.8.13** |
| Startup stage instrumentation (S7.13) | Independent `__STARTUP_STAGE_ATTR__` gate (default-off fail-closed), Main-authoritative exact disposable validation + opaque `__CHERRY_STARTUP_STAGE_VALIDATED` marker, bounded privacy-safe closed records (one per stage/session, no content/paths/credentials/raw DB size), 9 Main + 4 renderer boundaries without changing startup order/authority/IPC/preload/persistence/schema/migration/StoreSync/Dexie-open; renderer `importProjectionReady` → `ordinaryTreeReady` both verified, first-data milestone intentionally omitted; no authority/contract/schema/migration/baseline/SLA/winner | Attribution-only instrumentation | **S7.13 Implemented & Closed 2026-09-02 (attribution-only instrumentation, bounded privacy-safe, no production optimization/baseline/SLA/threshold/winner; later production optimization not authorized; residual risk: no fresh enabled Electron runtime E2E executed); see §6.8.14** |
| Background windows | Trace viewer, import window lifecycle | Independent, deferrable | **S7.12 classified — lazy on ordinary macOS startup (non-blocking)** |

> **S7.12 note (2026-09-01, factual correction + attribution scope)**: `Redux rehydration` corrected to `localStorage` (`redux-persist/lib/storage`, key `persist:cherry-studio`) per `src/renderer/src/store/index.ts:23,312-314` and corroborated by `docs/sqlite-migration.md:114` and `cherry-chat-application-identity.md` (LOCK-COMPAT-003); `persist:cherry-studio` preserved. **S7.12 Implemented & Closed 2026-09-01 — attribution-only, no production optimization, timing-dominant unknown (controlled non-adoption; see §6.8.13)** — static topology only, not runtime timing proof; dev/runtime observation diagnostic only; no baseline/SLA/threshold/regression proof; Dexie ordinary open/upgrade timing unknown; Main restore/SQLite before window, handler/preload gap unresolved; trace/import/search lazy on macOS; PowerMonitor Windows-only out-of-scope; evidence limits per §6.8.13. **S7.13 Implemented & Closed 2026-09-02 — attribution-only instrumentation (see §6.8.14)** — independent `__STARTUP_STAGE_ATTR__` gate (default-off fail-closed), Main-authoritative exact disposable validation + opaque marker, bounded privacy-safe closed records, both renderer milestones verified with first-data milestone intentionally omitted; no authority/contract/schema/migration/baseline/SLA/winner; bounded privacy-safe; no fresh enabled Electron runtime E2E executed (residual risk); S7.14+ deferred, later production optimization not authorized.

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
| File dual-state resolution | Phase 6 | **Candidate S6.5 — Not Authorized**; depends on M5 `chatdb-m5-file-dual-state` medium — one 1,000-reference synthetic dataset, 4 scenarios (synthetic directional L3, derived classification; full record in §7.3.2); S6.5 remains Candidate — Not Authorized, no baseline/threshold/SLA/regression/phase-closure/production authorization; ADR if schema/authority |
| FTS storage dedup | Phase 6 | **Candidate S6.5 — Not Authorized**; bounded synthetic M4 profiles (1k/10k/50k — 50k 2026-09-01 `chatdb-m4-fts-duplication-50k`, synthetic directional L3, logical duplication only) are complete as directional evidence, but no threshold/baseline/benefit or production authorization follows; S6.5 remains Candidate — Not Authorized; real-corpus/physical-size evidence remains unresolved (details in §7.3.2 and `performance-measurement.md` §6); any further diagnostic or production work requires an explicit decision, privacy review where applicable, and governance/ADR |
| Data-access implementation (windowed fetch, authority-aware actions, context closure) | Phase 6 | **S6.1–S6.3 Authorized & Implemented**; **S6.4 SQ-01 Rejected 2026-08-29 (no ADR, current LIKE retained; M2/M3 batch closed; no ready-now DB-health batch)**; S6.5 Candidate — Not Authorized |
| Startup improvements (S7.1–S7.13) | Phase 7 | **S7.1–S7.13 Implemented & Closed 2026-09-02 (outcome/residual-risk; S7.12 attribution-only, S7.13 attribution-only instrumentation, bounded privacy-safe, no production optimization/baseline/SLA/threshold/winner) — See §6.8.2–§6.8.14; S7.12 static topology (§6.8.13): PersistGate (`persist:cherry-studio`) then ImportProjectionGate sequential blockers, Dexie module blocking/timing unknown, Main restore/SQLite before window, handler/preload gap unresolved, trace/import/search lazy, PowerMonitor out-of-scope; S7.13 instrumentation ( §6.8.14): independent `__STARTUP_STAGE_ATTR__` gate default-off fail-closed, Main-authoritative exact disposable validation + opaque marker, bounded privacy-safe closed records (one per stage/session, no content/paths/credentials/raw DB size), 9 Main + 4 renderer boundaries without changing startup order/authority/IPC/preload/persistence/schema/migration/StoreSync/Dexie-open, renderer `importProjectionReady` → `ordinaryTreeReady` verified with first-data milestone intentionally omitted; no IPC/preload/schema/migration/StoreSync/persist-key change; no production optimization/baseline/SLA/threshold/winner/regression; verification: independent audit + re-audit 0 findings, focused Vitest, `git diff --check`, `pnpm build:check` exit 0 on exact worktree under Node 24.11.1/pnpm 10.27.0; residual risk: no fresh enabled Electron runtime E2E executed; Phase 7 remains partially Open — S7.14+ deferred, later production optimization not authorized; no ready-now batch without explicit activation** |
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
