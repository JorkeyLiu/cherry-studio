# Architecture Evolution Program — Cherry Chat Long-Term Structural Correctness

> **Document status**: **Approved Strategy (program-level)**. This document owns the architecture evolution program: strategic intent, approved locks, target qualities, debt registry, phased evolution, and decision triggers. It is not an ADR; it does not create new governance authority for identity, release, platform, SQLite migration, or context-window governance — those remain authoritative in their existing documents.
> **Authority boundary**: Architecture correctness, elegance, unity, and long-term evolvability lead. Performance symptoms expose architecture debt; performance remains validation evidence, not the sole design objective. Architecture refactoring seeks structurally better and naturally faster architecture; performance measurements record the natural result. No absolute performance metric/target is a routine phase gate and architecture does not require direct natural performance improvement to progress; reproducible material degradation under a controlled same-state comparison is architecture-correctness counterevidence and must be attributed/disposed before phase exit. Future startup speed and bounded memory are architecture enablement goals but do not override correctness (ARCH-002). Sync is future compatibility only, vendor-neutral, and must adapt to the application architecture — never the reverse.
> **Relation to current architecture reference**: [`architecture.md`](./architecture.md) describes implemented reality only. This program describes the target evolution path. The two must not be confused; `architecture.md` must not be edited to describe unimplemented target state.
> **Last updated**: 2026-08-22 — Phase 5 §5.14 coordinated shared-contract review record appended (R-02/R-03 window reads; review-only, adopts nothing, selects no values; approval decision outstanding); prior record unchanged: 2026-08-22 — Phase 4 §4.9a acceptance-evidence surface map appended (documentation-only validation planning; maps each §4.9 criterion to its demonstration surface and current evidence status; no criterion is fully demonstrable today; adopts nothing); prior record unchanged: Phase 4 C-01/C-02 calibration evidence appended as §4.13 (measurement-only, synthetic, directional, non-adoption; C-02 exit 0 on clean `52bbfbf124417a7c699c6c89c0ec718185517c96` dirty=false; retained C-01 exit 0 with artifact-recorded dirty=true — dirtiness limited to the approved documentation edits); **Phase 4/5 exits remain Open** — a passing calibration run does not close them; harnesses registered in `performance-measurement.md` §6; prior records unchanged: Phase 3 structurally Complete/Closed on structural/governance/functional evidence; 4df885d directional measurement appended alongside bfc1c617 provenance (both clean, dirty=false); PERF-TOPIC-SWITCH/ECHO reclassified as independent post-refactor reference/reassessment workstreams (remain Open, non-blocking); ARCH-009..ARCH-012 policy locks applied; Phase 5 §5.13 bounded study record appended (documentation-only, LOCK-P5-001..005)
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

Performance symptoms (topic switch latency, streaming cadence, echo delay) expose architecture debt. Performance remains validation evidence — when a performance fix requires changing ownership, lifecycle, or data contracts, it enters this program as architecture evolution, not as a performance patch. Architecture refactoring seeks structurally better and naturally faster architecture; performance measurements record the natural result of that refactoring — no absolute performance metric/target is a routine architecture phase gate and architecture does not require direct natural performance improvement to progress (ARCH-009). A reproducible material regression under a controlled same-state comparison, however, challenges architecture correctness and must be attributed and disposed before phase exit by fix, explicitly accepted reasoned trade-off, or keeping the phase Open (ARCH-010). Remaining performance problems are reassessed/re-baselined as separate post-refactor performance work; architecture closure does not close them (ARCH-011). Historical measurement provenance (pre-S3.1 and `bfc1c61713a689275324c85a4cafa23b35040abc`) remains reference evidence and is preserved, not erased or relabeled as thresholds/baselines (ARCH-012); `4df885d4d7fc055c2a2c5c742dfad79ff82ab991` (2026-08-21, dirty=false) is appended alongside as directional L3 evidence with no controlled same-state before/after improvement/regression claim (ARCH-012).

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
| **ARCH-009** | Architecture refactoring seeks structurally better and naturally faster architecture; performance measurements record the natural result — no absolute performance metric/target is a routine phase gate and architecture does not require direct natural performance improvement to progress. | **Locked** |
| **ARCH-010** | Reproducible material performance degradation under a controlled same-state comparison is architecture-correctness counterevidence and must be attributed and disposed before phase exit by fix, explicitly accepted reasoned trade-off, or keeping the phase Open. | **Locked** |
| **ARCH-011** | Remaining performance problems are reassessed/re-baselined as separate post-refactor performance work; architecture phase closure does not close PERF product problems. | **Locked** |
| **ARCH-012** | Measurement provenance is preserved: pre-S3.1 and `bfc1c61713a689275324c85a4cafa23b35040abc` remain historical/reference evidence and must not be erased or relabeled as thresholds/baselines; `4df885d4d7fc055c2a2c5c742dfad79ff82ab991` (2026-08-21, dirty=false) is appended alongside as directional L3 evidence with no controlled same-state before/after improvement/regression claim. | **Locked** |

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
- Cache-miss paths are explicit and measurable.
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
| Conversation lifecycle lazy activation — remaining mount cost | Observed structure | Chat ContentSearch parent-owned lazy mount (S3.5 2026-08-20): zero instance before invocation; EditMode light provider present while disabled with heavy subscriptions (topic messages, selection, clipboard, undo, group) instantiated only while `enabled`; optional panels/drawers existing conditional rendering (TopicSegmentDrawer, ChatNavigation history, Inputbar QuickPanels); Inputbar and viewport immediate by design (not deferrable); prior “all conversation components mount eagerly” claim resolved by S3.5 — remaining debt is immediate-component mount cost, not eager lazy-activation absence |
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
| `key={activeTopic.id}` triggers full subtree remount on topic switch | **Resolved (S3.1)** | Implemented by S3.1 (stable host, no key-driven remount); commit `0dabf3d9fb` |
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

**Status**: **Complete** (documentary/design phase). Approved 2026-08-19. This phase delivered the ownership model, topic transition contract, render graph design, and action/request ownership specification. No production implementation is authorized by this completion; Phase 3 carries implementation.
**Entry criteria**: Phase 1 complete; explicit approval for conversation lifecycle study.
**Dependencies**: Phase 1 complete.
**Exit criteria** (satisfied): Documented ownership model, topic transition model, render graph decisions, action ownership model, and lazy activation boundaries — all delivered below. Phase 2 completion does not claim code implementation; `architecture.md` remains the current reality reference only.

#### 2.1 Current-state evidence summary

The following characterizes the implemented reality as observed, not the target state:

| Aspect | Implemented reality | Label |
|---|---|---|
| Chat persistence | Main SQLite is authoritative; renderer never holds a SQLite connection; typed IPC is the only data path | Authority boundary (unchanged) |
| Topic data loading | `loadTopicMessagesThunk` → `dbService.fetchMessages` performs full-topic fetch; no windowed/incremental path exists | Current data path |
| Renderer projection | Messages host is stable (no `key`-driven remount); `useTopicTransition` owns layout-phase viewport reset, topic-scoped timer/flag cleanup, and transition-epoch stale-completion coordination; existing `useScrollPosition` owns outgoing scroll persistence; existing topic activation/bootstrap path owns topic loading and scroll restoration/bootstrap | Current implementation evidence (S3.1 implemented 2026-08-19) |
| Viewport state | Local viewport reducer already has `topicGeneration` / navigation / load guards; viewport state is keyed by topic | Current implementation evidence |
| Scroll position | Topic-keyed device-local state; no cross-topic leakage observed | Current implementation evidence |
| Background streams | Active generation/streaming persists across topic switches; not aborted by navigation | Current implementation evidence |
| Session projections | Messages/blocks for opened topics accumulate as renderer session projections in Redux | Current implementation evidence |
| ContentSearch (Chat) | Parent-owned **lazy mount** in Chat (S3.5 2026-08-20): **zero instance mounted before invocation** (Cmd/Ctrl+F or explicit invoke with `initialText`/`focus`); **remains active across topic switch while mounted** and refreshes via existing `updateSearchWord` path; when not mounted no handles, timers, or subscriptions retained | Current implementation evidence (post-S3.5) |
| ContentSearch (RichEditor legacy) | RichEditor legacy imperative hidden-mounted mode (`hidden` prop) **preserved unchanged**; always present in that editor's subtree regardless of visibility | Legacy current behavior (RichEditor only; not Chat) |
| Inputbar | Essential UI; always mounted and available | Current implementation evidence |
| EditMode | Light `EditModeProvider` present while disabled; heavy subscriptions (topic messages, selection, clipboard, undo, group) instantiated only while `enabled` (S3.5); strict/optional context semantics and edit actions preserved | Current implementation evidence (post-S3.5) |
| Data access | Full-topic fetch is the only data path; no pagination or windowed fetch exists | Current data path |

#### 2.2 Target state classification and ownership

| Domain | Target owner | Invariant |
|---|---|---|
| Authoritative chat data | Main SQLite (via typed IPC) | Single source of truth; never duplicated or overridden by renderer state |
| Renderer entity projection | Redux topic messages/blocks store | Derived from authority; disposable and rebuildable; never authoritative |
| Active-topic viewport / navigation / scroll | Renderer viewport reducer (topic-keyed) | Device-local UI state; reset on explicit topic activation; no cross-topic carryover |
| Live request / stream transient state | Request pipeline (topic/message-scoped) | Transient; not persisted as chat authority; survives topic switch when request is active |
| Derived render / context projection | Renderer memoized computations | Rebuilt from entity projection; disposable; not stored as separate authority |
| Device-local UI state | Redux config / local preferences | Clearly separated from shareable state (§3.8); never treated as authoritative chat data |
| Action / request context | Action controller (event-time resolution) | Resolves current Assistant and request state at event time; no event sourcing or command logs |

#### 2.3 Topic transition model

| Step | Owner | Invariant |
|---|---|---|
| **Activate request** | Renderer navigation handler | Explicit user intent or programmatic activation; carries target topic ID; no implicit transition |
| **Old-topic deactivate / save** | Viewport reducer | Save viewport scroll position and generation state under outgoing topic key; dispose transient viewport state; no authority mutation |
| **Generation advance / stale rejection** | Request pipeline | Active generation for old topic continues or is explicitly cancelled based on request-scoped lifecycle; topic switch does not automatically abort background generation |
| **Viewport reset** | Viewport reducer | Reset viewport to initial state for new topic (scroll top, generation marker, load state) under new topic key |
| **Projection activation / load** | Redux topic store | Activate or load entity projection for new topic; full-topic fetch remains current data path until Phase 5 |
| **Scroll restore / bootstrap** | Viewport reducer | Restore saved scroll position if topic was previously visited; otherwise bootstrap to initial state (bottom for new conversations, top for historical review) |
| **Ready** | Conversation host | Emit ready signal when projection is loaded and viewport is settled; UI becomes interactive |
| **Request-stream independence** | Request pipeline | Any active request/stream is scoped to its originating topic and message IDs; topic transition does not terminate or redirect in-flight streams |

#### 2.4 Stable render graph decisions

| Decision | Target | Rationale |
|---|---|---|
| **Stable host** | Conversation host component remains mounted across topic changes; does not remount on topic switch | Eliminates full-subtree teardown/rebuild cost; preserves in-flight DOM state for streams |
| **ID boundaries** | Topic ID is the primary boundary for entity projection scoping; message/block IDs are sub-boundaries within a topic | Clear ownership: topic-scoped stores own entity projections; message-scoped state is transient |
| **Derived group membership** | Message group assignment (user/assistant, answer selection) is derived from entity projection at render time | Not stored as separate authority; rebuildable from message metadata |
| **Local subscriptions** | Components subscribe to the narrowest possible slice of entity projection; subscriptions are topic-scoped | Reduces re-render blast radius; subscription cleanup on topic deactivation |
| **Stable history / live-tail layers** | History (completed messages) and live tail (streaming message) are render layers of one disposable projection | Not separate stores or authorities; same entity projection, different presentation treatment |
| **Local reactivation for edit / answer switch** | Edit mode and answer-switch activate locally within the stable host; no full remount | Edit capability is scoped to the message being edited; answer switch re-renders selection within existing projection |

#### 2.5 Action ownership model

```
UI intent (with message/topic IDs)
  → event-time state resolution (action controller)
    → request/action owner (resolves current Assistant, request state)
      → authoritative mutation or stream initiation (Main / request pipeline)
        → projection update (Redux entity projection)
```

- Presentation emits intent commands carrying message ID, topic ID, and action type.
- The action controller resolves current state at event time — no event sourcing, command logs, or replay infrastructure.
- The request/action owner determines whether the action is valid given current Assistant state, request lifecycle, and topic context.
- Authoritative mutations flow through typed IPC to Main SQLite; stream initiation flows through the request pipeline.
- Projection updates are derived from authority changes; they are never the source of truth.

#### 2.6 Lazy activation boundaries

| Component / capability | Activation trigger | Rationale |
|---|---|---|
| ContentSearch (Chat) | Invocation (user opens search) | Not needed until search is requested; **implemented as parent-owned lazy mount in Chat (S3.5 2026-08-20): zero instance before invocation; remains active across topic switch while mounted** |
| ContentSearch (RichEditor legacy) | Immediate hidden-mounted (preserved) | Legacy RichEditor imperative `hidden` mode preserved unchanged in that editor only; not Chat |
| Edit capability | Edit-mode activation (user enters edit on a message) | Light provider present while disabled; heavy subscriptions (topic messages, selection, clipboard, undo, group) instantiate only while `enabled` (S3.5); edit UI/behavior activates on demand |
| Optional drawers / panels | User opens the specific panel | Not essential for conversation flow; defers cost |
| Inputbar | Immediate (always available) | Essential for user interaction; cannot be deferred |
| Active viewport | Immediate (always available) | Essential for conversation display; cannot be deferred |

Existing conditional/lazy behavior in the codebase should be preserved; this model defines the target boundaries, not a rewrite mandate.

#### 2.7 Future phase requirements (no policy selection)

Phase 2 completion identifies the following as requirements for later phases. No policies, interfaces, or implementations are selected here.

**Phase 4 (Bounded Memory and Cache) requirements**:
- Renderer-side entity projection cache must have clear invalidation rules and size bounds.
- Viewport scroll-position cache must be bounded per topic.
- Context info computation cache must have explicit invalidation on authority change.
- Cache-miss paths must be explicit and measurable.

**Phase 5 (Data-Access Contract) requirements** (current downstream routing after Phase 5 design study 2026-08-20, exit Open):
- Full-topic fetch must be replaceable with **windowed/paginated fetch for visible messages** and **cache-join semantics for context info computation** — these remain **Phase 5 contract requirements** (R-02..R-06) as **windowed/semantic read and cache-join contract design** (documentation/design complete; implementation deferred).
- **Incremental/delta load mechanisms** are **excluded from the Phase 5 contract** by the completed Phase 5 design (former R-07 removed; generation is applicability-only) and are **explicitly deferred to Phase 6** as a future incremental/delta decision **without generation authority cursor**.

**Phase 7 (Startup Architecture) requirements**:
- Lazy activation of conversation components (ContentSearch, edit, optional panels) must reduce initial mount cost.
- Conversation host stability must not prevent independent boot-service optimization tracks.

#### 2.8 Sync compatibility review

Phase 2 decisions are reviewed against ARCH-005 sync-ready properties:

| ARCH-005 property | Phase 2 contribution | Status |
|---|---|---|
| Clear authority boundaries | Ownership model establishes single owner per domain (§2.2) | Established (documentary) |
| Stable IDs | Topic/message/block IDs are the boundary model; no ID changes proposed | Preserved |
| Typed explicit commands | Action model uses typed intent commands (§2.5); no new IPC channels proposed | Preserved |
| Atomic/idempotent mutations | No mutation changes; authority remains Main SQLite | Preserved (unchanged) |
| Deterministic ordering | No ordering changes | Preserved (unchanged) |
| Stable/final checkpoints | Transient vs. stable distinction identified; checkpoint enforcement is a cross-phase target constraint routing to appropriate existing governance | Identified (not enforced) |
| Disposable projections | Entity projections are disposable by design (§2.2, §2.4) | Established (documentary) |
| Bounded caches | Requirements identified (§2.7); bounds not yet defined | Deferred to Phase 4 |
| Device-local-state separation | Viewport/scroll identified as device-local; separation preserved | Established (documentary) |

**Sync prohibition**: No sync schema, metadata, tombstone, conflict engine, vendor adapter, transport, account/E2EE/attachment decision, or production sync path is authorized. Phase 2 does not create any sync infrastructure.

#### 2.9 Governance/decision gate clarification

**Renderer-local lifecycle is not a decision gate trigger.** The conversation lifecycle design in Phase 2 (topic transitions, viewport state, render graph stability) is Renderer-local component and state lifecycle. It does not cross authority, persistence, migration, IPC contract, context-window, native/multi-window, identity/compatibility, or release/platform boundaries. This design does not itself require a decision gate.

**Decision gate: work must stop if later implementation crosses these boundaries**:

| Boundary | Trigger example | Required action |
|---|---|---|
| Authority (chat data ownership) | Any change moving chat authority out of Main SQLite | ADR required before implementation |
| Persistence / migration | Schema changes, new columns, migration steps | SQLite migration governance decision |
| IPC / contract | New IPC channels, changed payload types, preload surface changes | Stop before implementation; perform coordinated shared-contract review across shared types/channel definitions, preload exposure, and Main handlers; obtain explicit architecture/program approval for the contract change; formal ADR required only when an existing authoritative governance owner/process requires it; coordinated both-side edits mandatory |
| Context window | Changes to anchor semantics, `contextCount` behavior | Context window governance review |
| Native / multi-window | Window lifecycle changes, native capability exposure | Governance decision required |
| Identity / compatibility | Changes to database names, persistence keys, import schema | Application Identity governance decision |
| Release / platform | Release scope, platform-specific behavior | Application Identity governance decision |
| Sync boundary | Any sync infrastructure, metadata, or transport | Sync governance owner documents (`sync-mvp.md` / `sync-powersync-spike.md`); Phase 8 is the future decision/activation phase, not an authority |

**Architectural "lifecycle" in decision gate context means** app/window/native lifecycle or another governed boundary, not ordinary Renderer component/topic lifecycle.

**Provenance note**: The Phase 2A/2B labels in `performance-workstreams.md` refer to pre-program historical renderer-boundary measurement and implementation slices (stage attribution instrumentation, shared context projection, window projection deduplication). Those slices are predecessors that produced evidence and partial renderer-side improvements; they do not constitute, satisfy, or authorize architecture Phase 2.
**Relationship to performance (reclassified 2026-08-21 per ARCH-011)**: PERF-TOPIC-SWITCH and PERF-ECHO were former architecture acceptance surfaces; they are now **independent post-refactor reference/reassessment workstreams** that remain **Open (non-blocking)**. Performance measurements record the natural result of structural refactoring (ARCH-009); architecture closure does not close them. No absolute threshold gates progress; a reproducible material regression under controlled same-state comparison would challenge correctness per ARCH-010.

### Phase 3: Stable Render/State/Action Graph

**Status**: **Structurally Complete / Closed (2026-08-21)** — closed on structural/governance/functional evidence (stable host/transition coordination, viewport/scroll lifecycle, ID boundaries/history-live-tail layering, action controller/event-time resolution, lazy activation); not gated by an absolute performance threshold (ARCH-009). Controlled-regression challenge rule applied (ARCH-010): no reproducible material degradation under a controlled same-state comparison was established; remaining timings are directional L3 observations only. Historical measurement provenance preserved (pre-S3.1 and `bfc1c61713a689275324c85a4cafa23b35040abc` as reference) with `4df885d4d7fc055c2a2c5c742dfad79ff82ab991` (2026-08-21, dirty=false) appended alongside as directional L3 evidence (ARCH-012); no controlled same-state before/after improvement/regression claim. PERF-TOPIC-SWITCH and PERF-ECHO are reclassified from architecture acceptance surfaces to **independent post-refactor reference/reassessment workstreams** and remain **Open (non-blocking)** per ARCH-011; architecture closure does not close them.
**Entry criteria**: Phase 2 ownership model complete; explicit approval required. The structural entry criterion (documented ownership model) is satisfied by Phase 2 completion (2026-08-19). Phase 3 implementation slices are **complete** — S3.1, S3.2, S3.3, S3.4, and S3.5 implemented (S3.1: 2026-08-19, commit `0dabf3d9fb`; S3.2: 2026-08-20, commit `992e51624a`; S3.3: 2026-08-20, commit `b215df77c1`; S3.4: 2026-08-20, commit `00e76dd05c`; S3.5: 2026-08-20, commit `917a3bb7f3` / `917a3bb7f31db771f8a083011fe3f1af97e6b8f8`); S3.4 prerequisite satisfied by S3.1; S3.5 remains independent. Phase 3 moved from implementation-complete to **structurally Closed 2026-08-21**; post-S3.5 measurements (2026-08-20 clean `bfc1c61713a689275324c85a4cafa23b35040abc` and 2026-08-21 clean `4df885d4d7fc055c2a2c5c742dfad79ff82ab991`, both dirty=false) are directional L3 reference/reassessment evidence, not phase gates (see measurement records below).
**Content**:
- Establish a stable, well-defined graph of render dependencies, state subscriptions, and action handlers.
- Reduce unnecessary component remounts and re-renders through structural clarity (not speculative memoization sweeps).
- Stabilize projected array identities and memo boundaries through ownership, not patches.

**Exit criteria**: Documented render/state/action graph with reduced remount blast radius; **structural/governance/functional validation** (stable host/transition, viewport/scroll, ID boundaries/history-live-tail, action controller, lazy activation); **controlled-regression disposition satisfied per ARCH-010** (no reproducible material degradation under controlled same-state comparison, or attributed/disposed). **Exit Closed 2026-08-21** on these criteria; no absolute performance threshold was required (ARCH-009); PERF-TOPIC-SWITCH/PERF-ECHO remain Open as independent post-refactor workstreams (ARCH-011).
**Dependencies**: Phase 2 complete.
**Implementation slices** (in dependency order; each independently testable and rollback-bounded):

| Slice | Description | Prerequisites | Acceptance evidence | Rollback boundary | Status / provenance |
|---|---|---|---|---|---|
| **S3.1** Stable host / transition coordinator | Establish stable conversation host that persists across topic changes; `useTopicTransition` owns layout-phase viewport reset, topic-scoped timer/flag cleanup, and transition-epoch stale-completion coordination; existing `useScrollPosition` owns outgoing scroll persistence; existing topic activation/bootstrap path owns topic loading and scroll restoration/bootstrap | None | Topic switch no longer remounts full subtree; no behavioral regression in topic navigation | Revert host component to current remount-on-key behavior; remove transition coordinator; all data unchanged | **Implemented** (commit `0dabf3d9fb`, 2026-08-19; `pnpm build:check` exit 0 9605 passed/75 skipped; fresh `pnpm build` exit 0; topic-switch E2E 6 passed/1 fixture-conditioned skip) |
| **S3.2** Viewport / scroll cleanup | Move viewport state and scroll position to explicit topic-scoped lifecycle managed by transition coordinator; remove implicit viewport carryover | S3.1 (prerequisite satisfied) | Scroll position correctly saved/restored per topic; no cross-topic scroll leakage; viewport reset on fresh topic activation | Restore viewport reducer to current implicit behavior; scroll state is device-local, no authority impact | **Implemented** (commit `992e51624a`, 2026-08-20; renderer-local; Node v24.11.1 / pnpm 10.27.0; `pnpm format`/`lint`/`test` pass; fresh `pnpm build` pass; topic-scroll-save-restore E2E 3/3; perf101 topic-switch 1/1; perf101 cache-hit 5 passed + 1 documented skip; Electron ABI 145 SQL probe) |
| **S3.3** Stable ID render boundaries / history-live-tail layering | Establish message/block render boundaries using stable IDs; implement history and live-tail as render layers of one disposable entity projection | S3.1 (prerequisite satisfied) | Arbitrary history/live runs preserve newest-first order; group liveness classified by existing PENDING/PROCESSING/SEARCHING predicate; no double-render or missing messages | Remove layer separation; revert to single-path rendering; entity projection unchanged | **Implemented** (commit `b215df77c1` / `b215df77c1ceb0198d102e01aa193a0d1334a99e`, 2026-08-20; renderer-local; Node v24.11.1 / pnpm 10.27.0; `pnpm format`/`lint`/`test` pass; fresh `pnpm build` pass; streaming-responsiveness E2E 1/1; topic-scroll-save-restore E2E 3/3; Electron ABI 145 SQL probe) |
| **S3.4** Action controller / event-time state resolution | Introduce action controller that resolves current Assistant and request state at event time; replace implicit state capture with event-time resolution | S3.1 (prerequisite satisfied) | Actions (regenerate, edit, answer-switch) resolve correct state; no stale-state bugs; no behavioral change in happy path | Remove action controller; restore implicit state capture; no IPC or authority changes | **Implemented** (commit `00e76dd05c` / `00e76dd05cc8cea0a0ac77a9eec91bba43c3018f`, 2026-08-20; renderer-local; Node v24.11.1 / pnpm 10.27.0; `pnpm format`/`lint`/`test` pass; fresh `pnpm build` pass; ordinary-chat/perf100 E2E 2/2; Electron ABI 145 SQL probe) |
| **S3.5** Lazy activation | Activate ContentSearch on invocation; activate edit capability on edit-mode activation; activate optional drawers on opening; preserve Inputbar and viewport immediate availability | None (independent) | ContentSearch not mounted until invoked; edit subscriptions activate on demand; optional panels deferred; Inputbar/viewport always available; no functional regression | Restore eager mounting of all components; no data or authority changes | **Implemented** (commit `917a3bb7f3` / `917a3bb7f31db771f8a083011fe3f1af97e6b8f8`, 2026-08-20; renderer-local; Node v24.11.1 / pnpm 10.27.0; `pnpm build:check` exit 0 339 files/6410 tests; fresh `pnpm build` exit 0; lazy-activation E2E 1/1; ordinary-chat E2E 1/1; ABI 145 probe) |

**Note**: Each slice is independently testable and rollback-safe. Slices do not cross authority, persistence, IPC, or governance boundaries. No schema, IPC contract, context-window, or identity changes are included.

#### S3.1 Implementation Record (2026-08-19)

**Behavior**: Stable `Messages` host component persists across topic changes (removed `key={activeTopic.id}` remount pattern). `useTopicTransition` owns layout-phase viewport reset, topic-scoped timer/flag cleanup, and transition-epoch stale-completion coordination. Existing `useScrollPosition` owns outgoing scroll persistence. Existing topic activation/bootstrap path owns topic loading and scroll restoration/bootstrap. Layout-phase reset applied.

**Preserved boundaries**: Main SQLite authority unchanged; no IPC contract changes; no schema changes; no context-window governance changes; no identity/compatibility changes. Renderer-local lifecycle only — does not cross any governed boundary.

**Tests/validation**: `pnpm build:check` exit 0 (9605 passed/75 skipped). Fresh `pnpm build` exit 0. Topic-switch E2E exact paths 6 passed/1 fixture-conditioned explicit skip.

**Rollback**: Revert host component to remount-on-key behavior; remove `useTopicTransition` and transition coordinator; all data unchanged.

**Non-claims**: S3.1 does not close PERF-TOPIC-SWITCH, PERF-ECHO, or PERF-RENDER-FLOW as product problems. Existing recorded L3 performance values are pre-S3.1 directional reference observations unless explicitly remeasured. PERF-TOPIC-SWITCH latency improvement is not yet measured post-S3.1.
**Relationship to performance**: This phase supersedes PERF-RENDER-FLOW's tactical candidate queue (A/B/C candidates). The conversation ownership and lifecycle design in Phase 2 identifies the root structural causes that the tactical loop could not isolate; Phase 3 owns production conversation restructuring.

#### S3.2 Implementation Record (2026-08-20 — commit `992e51624a`)

**Behavior**: Renderer-local viewport/scroll cleanup. Explicit save-before-reset ordering: old-topic scroll snapshot is saved before topic/reset effects clear or reinitialize viewport state. Topic-scoped renderer-local scroll snapshot/restore per topic ID via `useScrollPosition`; fresh-topic activation resets viewport to bottom/initial state; no cross-topic DOM/scroll leakage (stale scroll does not carry to new topic; restored scroll is topic-keyed). Stable `Messages` host preserved across topic changes (no remount).

**Preserved boundaries**: Main SQLite authority unchanged; no IPC contract changes; no schema/migration changes; no context-window governance changes; no identity/compatibility changes; no release/platform changes; no sync infrastructure changes. Renderer-local only — does not cross any governed boundary (LOCK-DOC-003).

**Tests/validation**: Node v24.11.1 / pnpm 10.27.0. `pnpm format` / `pnpm lint` / `pnpm test` pass; fresh `pnpm build` pass. Focused/E2E: topic-scroll-save-restore Playwright 3/3; perf101 topic-switch 1/1; perf101 cache-hit 5 passed + 1 documented skip. Final Electron ABI 145 SQL probe (`Database(':memory:')` + `select 1`) pass. 0 audit findings.

**Rollback**: Restore viewport reducer / scroll hooks to pre-S3.2 implicit behavior; remove explicit save-before-reset ordering and topic-scoped snapshot/restore coordination; scroll state is device-local, no authority/data impact.

**Non-claims**: S3.2 does not close PERF-TOPIC-SWITCH, PERF-ECHO, or any performance workstream/threshold. No performance threshold is claimed or measured as closed by this slice. Existing recorded L3 performance values remain directional reference unless explicitly remeasured. PERF-TOPIC-SWITCH / PERF-ECHO closure requires dedicated measurement.

**Relationship to performance**: S3.2 is viewport/scroll correctness (cleanup) within the stable-host graph; it does not claim latency improvement. Performance remains validation evidence.

#### S3.3 Implementation Record (2026-08-20 — commit `b215df77c1ceb0198d102e01aa193a0d1334a99e`)

**Behavior**: Renderer-local render layers over one disposable Redux entity projection. Stable entity-derived message/group/selection boundaries with explicit history/live-tail render runs (arbitrary runs, newest-first order preserved). Stable collision-safe entity-derived keys; no outer composition-varying parent key. Group live iff any message satisfies existing PENDING/PROCESSING/SEARCHING predicate. Default/unselected groups split when liveness changes; contiguous selected edit segments remain atomic and mixed live/history selection is classified live. One stable `Messages` host and one scroll container; layer observability via `data-*` on existing elements only — no wrappers or extra scroll containers; no second store/authority.

**Preserved boundaries**: Main SQLite authority unchanged; no IPC/preload/schema/migration/context-window/request-pipeline changes; no S3.4 (action controller) changes; no identity/release/platform/native/multi-window/sync changes. Renderer-local only — does not cross any governed boundary. Single entity projection retained as sole source for render layers.

**Tests/validation**: Node v24.11.1 / pnpm 10.27.0. `pnpm format` exit 0; `pnpm lint` exit 0; `pnpm test` exit 0 — 333 files passed, 6359 tests passed, 3 skipped; fresh `pnpm build` exit 0. Focused/E2E: streaming-responsiveness Playwright 1/1; topic-scroll-save-restore Playwright 3/3. Final Electron ABI 145 SQL probe (`Database(':memory:')` + `select 1`) pass. Audit: initial audit found classification collapse (blockers); corrected; re-audit pass 0 blockers/acceptable-risk/style, 2 speculative informational observations only.

**Rollback**: Remove history/live-tail run separation and entity-derived key/layer observability; revert to pre-S3.3 single-path rendering; entity projection, host stability, and scroll state unchanged; no authority/data impact.

**Non-claims**: S3.3 does not close PERF-TOPIC-SWITCH, PERF-ECHO, PERF-RENDER-FLOW, or any performance workstream/threshold/workstream closure. No performance threshold is claimed or measured as closed by this slice. Existing recorded L3 performance values remain directional reference unless explicitly remeasured. Performance remains validation evidence and requires dedicated measurement.

**Relationship to performance**: S3.3 is render-layer correctness (stable boundaries and explicit history/live-tail runs) within the stable-host graph; it does not claim latency improvement. Performance improvement requires dedicated measurement under `performance-measurement.md`.

#### S3.4 Implementation Record (2026-08-20 — commit `00e76dd05cc8cea0a0ac77a9eec91bba43c3018f`)

**Behavior**: Renderer-local stateless seams `messageActionController` service + `useMessageActionController` hook resolve latest state at event time via synchronous store reads; no subscriptions or re-render coupling. Callers pass explicit `topicId`/`messageId`; resolution never falls back to active topic and rejects cross-topic/missing targets. Latest Redux entities and answer-group membership resolved at click; ambient Assistant refreshed from current store while intentional per-message `modelId`/`model` override preserved via snapshot merge. Existing thunks, DB-first persistence, typed IPC, queue/abort/error semantics unchanged. Editor remains open on missing/error and closes only on successful edit/resend; `resendWithEdit` re-resolves latest after edit persistence before dispatch. Folded navigation uses the same answer-selection controller at event time; Retry All rechecks each rendered explicit ID's latest status before dispatch.

**Preserved boundaries**: Main SQLite authority unchanged; no new authority/store/persistence/IPC/preload/request-pipeline changes; no schema/migration/context-window changes; no identity/release/platform/native/multi-window/sync changes; no S3.5 changes. Renderer-local only — does not cross any governed boundary. Existing thunk/DB-first/IPC/queue/abort semantics retained.

**Tests/validation**: Node v24.11.1 / pnpm 10.27.0. `pnpm format` exit 0; `pnpm lint` exit 0; `pnpm test` exit 0 — 457 files passed, 10072 tests passed, 75 skipped; fresh `pnpm build` exit 0. E2E from unchanged production surface: ordinary-chat/perf100 Playwright 2/2. Final Electron ABI 145 SQL probe (`Database(':memory:')` + `select 1`) pass. Audit: initial 0 blockers / 3 acceptable-risk / 0 style / 2 speculative then corrected; re-audit pass 0 blockers / acceptable-risk / style with 1 speculative advisory.

**Rollback**: Remove `messageActionController` service and `useMessageActionController` hook; restore prior direct action paths in `Message`/`MessageGroup`/`MessageMenubar`/`MessageGroupMenuBar`/`Messages`; no data or authority impact. No S3.5 or governance activation.

**Non-claims**: S3.4 does not close PERF-TOPIC-SWITCH, PERF-ECHO, PERF-RENDER-FLOW, or any performance workstream/threshold/workstream closure. No performance threshold is claimed or measured as closed by this slice. No measured performance improvement is claimed. Existing recorded L3 performance values remain directional reference unless explicitly remeasured.

**Relationship to performance**: S3.4 is action-correctness (event-time resolution and explicit-ID routing) within the stable-host graph; it does not claim latency improvement. Performance remains validation evidence and requires dedicated measurement under `performance-measurement.md`.

#### S3.5 Implementation Record (2026-08-20 — commit `917a3bb7f31db771f8a083011fe3f1af97e6b8f8`)

**Behavior**: Renderer-local lazy activation. ContentSearch is parent-owned lazy mount in `Chat`: zero instance mounted before invocation; mounts on Cmd/Ctrl+F shortcut or explicit invoke with `initialText`/`focus`; unmounts on Escape or disable; safe Highlight API usage (feature-detect, try/catch), debounce/rAF/timer cleanup on disable/unmount, remains active across topic switch and refreshes via existing `updateSearchWord` path. RichEditor legacy imperative hidden mode (`hidden` prop) preserved unchanged. `EditModeProvider` has light `enabled`-state gate while disabled; heavy subscriptions (topic messages, selection, clipboard, undo, group) instantiate only while `enabled`; strict/optional context semantics and edit actions preserved. Existing optional content remains deferred and preserved: `TopicSegmentDrawer` Popover content, `ChatNavigation` history Drawer content, Inputbar `QuickPanels` (existing conditional rendering; no new dynamic import/wrapper/scroll container). Inputbar, viewport, and stable host remain immediate.

**Preserved boundaries**: No store schema/new authority/IPC/preload/persistence/schema/migration/request-pipeline/context-window/identity/release/platform/native/multi-window/sync changes; no new wrapper/scroll container/dynamic import. Renderer-local only — does not cross any governed boundary. Main SQLite authority, typed IPC, DB-first persistence, queue/abort semantics unchanged.

**Tests/validation**: Node v24.11.1 / pnpm 10.27.0. Focused renderer 46/46 after audit corrections (ContentSearch suite 14/14 selector-corrected); web/node typecheck pass; `pnpm format` pass; authoritative `pnpm build:check` exit 0 — 339 files passed (1 skipped), 6410 tests passed (3 skipped), 0 failures/timeouts; lint/typecheck/i18n/openapi/full Vitest all pass; fresh `pnpm build` exit 0. E2E from unchanged production surface: lazy-activation Playwright 1/1 (zero mount before Cmd/Ctrl+F, visible/focused after, removed on Escape, Inputbar/`#messages` immediate); ordinary-chat Playwright 1/1 (edit/resend/regenerate/persistence paths). Residual validation observation: topic-scroll-save-restore final combined run 2/3 pass; one test timed out during test-data preparation waiting for third mock assistant response, then fixture teardown closed page — trace shows failure before S3.5/search/scroll assertions; no S3.5 causal evidence identified, root cause remains unknown; no crash/ABI/port/process residue. An earlier exact-code-predecessor run was 3/3 pass, but current exact code state is documented here without a 3/3 claim. Final Electron ABI 145 SQL probe (`Database(':memory:')` + `select 1`) pass. Working tree clean after implementation commit. Audit: initial 0 blockers / 3 acceptable-risk / 2 style / 1 speculative; accepted lifecycle/API/typing findings fixed, speculative topic-switch auto-dismiss rejected (existing active-search-across-topic behavior preserved); re-audit pass 0 blockers/acceptable-risk/style/speculative.

**Rollback**: Remove parent-owned lazy mount and `EditModeProvider` light gate; restore eager `ContentSearch` mount and always-present edit subscriptions; no data or authority impact; no governance activation. Optional drawers/panels revert to prior eager/conditional behavior unchanged.

**Non-claims**: S3.5 does not close PERF-TOPIC-SWITCH, PERF-ECHO, PERF-RENDER-FLOW, or any performance workstream/threshold/workstream closure, Phase 7, or sync. No performance threshold is claimed or measured as closed by this slice. No measured performance improvement is claimed. Existing recorded L3 performance values remain directional reference unless explicitly remeasured. Phase 3 was **structurally Complete/Closed 2026-08-21** on structural/governance/functional evidence (ARCH-009/ARCH-010); S3.5 slice alone did not close it and PERF workstreams remain Open as independent reference (ARCH-011).

**Relationship to performance**: S3.5 is lifecycle correctness (lazy activation and subscription gating) within the stable-host graph; it does not claim latency or memory improvement. Performance remains validation evidence and requires dedicated measurement under `performance-measurement.md`; performance measurements record the natural result of structural refactoring and no absolute threshold gates Phase 3 (ARCH-009); controlled-regression disposition governs closure (ARCH-010).

#### Reference Measurement Record — Clean `bfc1c61713a689275324c85a4cafa23b35040abc` (2026-08-20, dirty=false — historical/reference, preserved provenance per ARCH-012)

Measurement is directional L3 reference, not an acceptance gate. PERF-TOPIC-SWITCH and PERF-ECHO remain Open as independent post-refactor reference/reassessment workstreams (ARCH-011; non-blocking for Phase 3 which is structurally Closed 2026-08-21); L1 correctness gates passed, L3 timings are directional observations only; no threshold/baseline/improvement/regression claim.

**Execution**: Fresh `pnpm build` exit 0. Six canonical focused runs exit 0 on clean commit `bfc1c61713a689275324c85a4cafa23b35040abc` dirty=false, Electron ABI 145, no `PERF_PHASE_ATTR` overlay. All expected samples complete. No closure, no threshold pass/fail, no baseline adoption, no root-cause, no improvement/regression claim.

**Matrix (exactly six runs)**: Three PERF-101 cache-hit repeat-switch scales (N20/W10, N20/W20, N100/W10) + one PERF-103 standard echo run + two PERF-103 high-turn runs (20 and 100 prior turns). No unrelated specs are part of this matrix.

**Gates**: PERF-101 11/11 per scale (correctness/parity/privacy/completeness/schema/ABI); PERF-103 10/10 per run (correctness/parity/completeness/ABI). L1 correctness gates passed; L3 timings are directional observations only. Final artifacts are gitignored local evidence; persistence beyond that is not claimed.

**PERF-101 cache-hit repeat-switch (3 samples/scale, values p50/p95/mean ms)**:
- N20/W10 — cacheMiss.firstUsefulRender 191.4/196.3/191.0; cacheHit.repeatSwitchRender 126.7/138.7/128.6; cacheMiss.loadCommit 71.9/83.9/71.6; cacheHit.activationCommit 29.9/31.8/29.4
- N20/W20 — cacheMiss.firstUsefulRender 384.8/418.6/392.6; cacheHit.repeatSwitchRender 250.5/290.4/260.6; cacheMiss.loadCommit 125.7/140.0/112.1; cacheHit.activationCommit 33.6/35.9/33.2
- N100/W10 — cacheMiss.firstUsefulRender 189.8/253.7/203.6; cacheHit.repeatSwitchRender 153.1/154.6/144.4; cacheMiss.loadCommit 70.0/93.7/71.7; cacheHit.activationCommit 34.0/35.1/32.3

**PERF-103 echo (values p50/p95/mean ms)**:
- Standard (20 measured +2 warmup) — reduxCommit 35.1/40.6/35.2; firstRender 90.7/105.7/91.3; reduxToDom 55.2/66.4/56.1
- High-turn 20 (10 measured +2 warmup) — reduxCommit 60.2/66.7/61.3; firstRender 164.8/180.2/165.0; reduxToDom 105.2/113.5/103.7; assistantFirstVisible 485.9/782.2/513.4; streamCompletion 486.9/783.5/514.6
- High-turn 100 (10 measured +2 warmup) — reduxCommit 64.9/91.3/67.4; firstRender 167.2/239.9/180.4; reduxToDom 109.2/148.6/113.0; assistantFirstVisible 517.8/882.4/564.3; streamCompletion 521.6/885.9/567.4

**Non-claims**: Historical pre-S3.1 dirty-worktree ranges preserved as directional/non-baseline reference, not replaced. This record is L3 directional evidence only; not baseline adoption, not threshold, not root cause, not workstream closure, not Phase 7, not sync. Phase 3 is now **structurally Closed 2026-08-21** on structural/governance/functional evidence (ARCH-009/ARCH-010); this record remains directional reference alongside the new 4df885d record (ARCH-012) and does not claim improvement/regression (no controlled same-state before/after comparison).

**Authority**: Historical record preserved; scope note for this 2026-08-20 entry: at that time `performance-program.md` and `performance-measurement.md` were unchanged per prior scope.

#### Reference Measurement Record — Clean HEAD `4df885d4d7fc055c2a2c5c742dfad79ff82ab991` (2026-08-21, dirty=false — appended alongside `bfc1c61713a689275324c85a4cafa23b35040abc`, not a replacement)

Preserved provenance per ARCH-012: pre-S3.1 and `bfc1c61713a689275324c85a4cafa23b35040abc` (2026-08-20, clean) remain historical/reference evidence (above) and are not erased or relabeled as thresholds/baselines. This record is **directional L3 only** with `performance-measurement.md` schema v1 and Electron ABI 145.

**Execution**: `4df885d4d7fc055c2a2c5c742dfad79ff82ab991`, dirty=false, 2026-08-21. Fresh `pnpm build` exit 0. **Six canonical focused runs exit 0**: three PERF-101 scales (N20/W10, N20/W20, N100/W10) each 11/11 gates per scale with 3 samples per scale; three PERF-103 runs (standard + high-turn 20 + high-turn 100) each 10/10 gates — standard 20 measured (+2 warmup), high-turn 20/100 each 10 measured (+2 warmup). No `PERF_PHASE_ATTR` overlay; schema v1. Artifacts are gitignored local evidence; no baseline/threshold adoption. **No controlled same-state before/after comparison exists, so no improvement/regression claim**.

**PERF-101 recovery artifact (directional p50/p95/mean, cache-hit `repeatSwitchRender`; canonical six original runs all exit 0; values below from recovery runs because Playwright cleans `test-results` each invocation; artifact preservation required reruns)**:
- N20/W10 — 193.2/196.1/183.87 ms
- N20/W20 — 251.5/332.1/275.4 ms
- N100/W10 — 152.9/153.0/151.37 ms

**PERF-103 recovery artifact (directional p50/p95/mean, `firstRender`; same recovery note)**:
- Standard — 88.9/110.5/92.43 ms
- High-turn 20 — 193.7/258.5/211.46 ms
- High-turn 100 — 255.7/285.0/258.43 ms

**Non-claims**: Values are **directional L3 only** (recovery artifacts from the same clean 4df885d state); not thresholds, not baselines, not root-cause, not Phase 4/5 gate, not workstream closure, not Phase 7, not sync. Shape remains **W-grown, N-flat at fixed W** consistent with prior bfc1c617 directional observation; cross-commit numeric comparison is not a controlled same-state before/after and therefore not an improvement/regression claim.

**Traceability**: Phase 3 closure rationale applied ARCH-009 (no absolute threshold as gate) and ARCH-010 (controlled-regression challenge disposition) to this measurement set; Phase 4/5 remain **Open for independent reasons** (calibration/contract/implementation acceptance gates), not Phase 3 propagation; PERF-TOPIC-SWITCH/ECHO remain Open as independent post-refactor reference/reassessment workstreams (ARCH-011).

### Phase 4: Bounded Memory and Cache

**Status**: **Design study complete (2026-08-20) — documentation only; exit Open (pending gates in §4.12). No implementation authorized.**
**Entry criteria**: Phase 2 complete (conversation ownership/lifecycle design enables bounded state); explicit approval. Entry satisfied — Phase 2 complete 2026-08-19.
**Content**: Establish cache invalidation rules and size bounds for renderer-side caches; define bounded state for conversation components (resident topic projections, viewport window, scroll snapshots, ContentSearch handles, context-info memo); ensure cache-miss paths are explicit and measurable; define retention/eviction policy design (bounds, pinning, admission, invalidation triggers, retention periods, eviction strategies, rebuild requirements, cache-miss handling). This phase is **design/documentation only** — no implementation, code, schema, IPC, pagination, sync, or `architecture.md` current-reality edits are authorized.
**Exit criteria**: Documented cache/memory model with bounds, documented retention/eviction policy design (bounds, pinning, admission, invalidation, retention, eviction, rebuild, cache-miss requirements); validated by memory acceptance criteria (bounded evictable caches, explicit active/pinned exception, cache invalidation rules, cache-miss path measurability, observability). Exit not claimed — see §4.12.
**Dependencies**: Phase 2 complete. **Phase 5 owns R-02..R-06 windowed/semantic read and cache-join contract design; Phase 6 candidate slices own any implementation; incremental/delta is excluded from Phase 5 and deferred to Phase 6/future decision without generation authority cursor; active/pinned working-set bounding remains Phase 6 plus queue/stream governance; Phase 4 measures it and keeps total-memory non-claim.**
**Startup/memory relationship**: Conversation ownership/lifecycle design directly enables lazy activation and bounded state. However, app boot services, Redux rehydration, Dexie initialization, SQLite cold open, bundle loading, and background windows remain separate tracks — they are not blocked by or dependent on conversation lifecycle changes.

#### 4.1 Design constraints for this phase

| Design constraint | Statement | Effect in this document |
|---|---|---|
| Design/documentation only | Phase 4 is design and documentation only. No implementation, code, schema, IPC, pagination, sync, or `architecture.md` current-reality edits are authorized. | Phase 4 delivers an executable design without code change; `architecture.md` remains implemented reality only (§1.3, ARCH-008). |
| Bounded evictable caches, not total memory | Strictly bounded evictable caches are separated from the active/pinned working set. Renderer total memory is not claimed as bounded. | All capacity defaults in §4.5 bound only the evictable set; active topic and pinned topics are excluded but measured (§4.5, §4.6, §4.8). The design does not claim total renderer memory is bounded. |
| Preserve context-window and request-stream semantics | Current context-window anchor/count semantics and request-stream independence are preserved. Active topic and every topic with pending/in-flight request are pinned and cannot be evicted by ordinary cache pressure. | Pin set defined in §4.6; eviction never evicts a pinned topic; `contextCount` null means unlimited and stable anchor-to-end semantics remain governed by `context-window.md` (see §4.4, §4.11). |
| Phase 3 structurally Closed 2026-08-21 | Phase 3 is **structurally Complete/Closed 2026-08-21** on structural/governance/functional evidence (ARCH-009/ARCH-010); PERF-TOPIC-SWITCH and PERF-ECHO reclassified as **independent post-refactor reference/reassessment workstreams** and remain **Open (non-blocking, ARCH-011)** with no committed numeric threshold. | Phase 3 status Closed (see §6 Phase 3 header and §10.4); no threshold adopted by Phase 4; historical provenance preserved with 4df885d appended as directional L3 (ARCH-012). |
| Authoritative SQLite, disposable projection | Main SQLite remains authoritative; renderer entity state is disposable projection; whole-topic eviction is atomic and rebuilds through the existing typed full-topic fetch until Phase 5. | Ownership/tiering in §4.4; rebuild path in §4.6–§4.7; no incremental/windowed fetch introduced by Phase 4. |
| Evictable-state capacity defaults | Initial target policy for evictable state: inactive resident projections max 8 topics, max 32 MiB aggregate **logical retained payload (deterministic UTF-8 serialized payload bytes; derived caches excluded; heap-amplification ratio recorded separately)**, 30-minute idle TTL, LRU eviction (recency = last activation or unpin, tie-break topic ID); active/pinned topics excluded but measured. A single oversized inactive topic **>32 MiB (exactly B-02)** is non-admissible after deactivation. These are architecture capacity defaults requiring calibration before implementation, not performance acceptance thresholds. | Bounds table §4.5 and matrix §4.6 encode this policy verbatim; calibration requirement explicit in §4.5 and §4.9. |
| Viewport, scroll, search, and context-info bounds | Viewport target max 200 rendered groups, expand in existing 20-group steps, trim opposite edge while preserving navigation/scroll anchors; scroll snapshots max 256 topics and 90-day idle TTL with immediate deletion cleanup; ContentSearch max 500 live DOM Range handles with overflow via non-DOM match descriptors/chunking so result/navigation semantics are preserved; context-info retained result max one active topic and invalidates on topic entities/referenced blocks/assistant/context settings/topic id changes. Existing undo 50 and streaming throttle 100/5 min remain observed current bounds, not newly implemented policy. | Viewport/scroll/search/context-info bounds in §4.5–§4.6; undo/throttle labeled as observed current bounds. |

#### 4.2 Terminology (Phase 4 scope)

| Term | Definition |
|---|---|
| **Authoritative state** | Chat messages/blocks/topics persisted in Main SQLite; single source of truth (see `sqlite-migration.md`). |
| **Renderer entity projection** | Redux `messages`/`blocks`/`segments` derived from authority via typed IPC; disposable and rebuildable; never authoritative. |
| **Resident projection** | An entity projection currently held in renderer Redux for a topic, together with its topic-local **component and composite completeness markers, generation, and logical-bytes accounting** (renderer-local only; no IPC/schema versioning). A resident projection is **not complete** until **resident-topic completeness** holds for the recorded generation. |
| **Chat-data completeness** | **Component completeness** for chat data: **complete ordered messages + all referenced blocks** for the topic/generation are resident and validated (ordering `sort_order`→`id`, references intact). For an **empty topic** (no messages/blocks), an **explicit empty chat-data marker** is required — zero entities without the marker is not complete. |
| **Segment completeness** | **Component completeness** for topic segments: **complete segment projection** for the topic/generation is resident and validated (stable segment order/id, references intact). For a topic with **no segments**, an **explicit empty segment marker** is required — zero segments without the marker is not complete. |
| **Resident-topic completeness** | **Composite completeness** = **chat-data completeness AND segment completeness for the same renderer applicability generation**, including explicit empty markers where applicable. Both components must be present, validated, and generation-matched; neither component alone satisfies resident completeness. |
| **Completeness marker / generation** | Renderer-local metadata per resident topic recording **component (`chat-data`, `segment`) and composite (`resident-topic`) completeness for a recorded renderer applicability generation/version**. For an empty side, completeness is an explicit empty marker. Current `cachedIds.length > 0` early-return and **current `dbService.fetchMessages` (messages/blocks only) plus separate/unawaited segment load are current behavior that do not satisfy the future contract**; the target contract requires **both component markers plus complete messages/blocks and segments for the same generation**. |
| **Staged same-generation publication** | **Target rebuild publication** for resident completeness: **pin first** for the issued generation; **stage chat data and segment data for that same generation** (coordinated separate reads or a future coordinated payload subject to Phase 5/6 contract review and §10.1 IPC gate — **no prescription that segments must be added to the existing `fetchMessages` IPC payload**); **await both**; **validate IDs/references/generation together**; **calculate canonical logical bytes** (§4.5 B-02); **publish messages/blocks/segments plus component and resident markers and accounting in one renderer state transition**. If **either load fails or generation mismatches**, **discard all staged data for that attempt, publish no new markers/accounting, and preserve or invalidate the prior entry according to its prior generation** (never mix generations or publish partial components; no mixed-generation cache joins). |
| **Active topic** | The topic currently displayed in the conversation host (Phase 2 §2.3). |
| **Pinned working set** | Active topic plus every topic that has a pending/in-flight request/stream. Pinned topics are excluded from ordinary cache pressure and cannot be evicted (§4.6). |
| **Evictable (inactive) set** | Resident projections for non-active, non-pinned topics. Only this set is bounded by the capacity defaults in §4.5. |
| **Logical retained payload (B-02 accounting)** | Deterministic **UTF-8 bytes of canonical JSON** serialization of the **exact renderer-local accounting frame** for that topic: `{ "accountingVersion": "phase4-logical-payload-v1", "topicId": <string>, "messages": [...], "blocks": [...], "segments": [...], "completeness": { "chatData": <boolean>, "segments": <boolean>, "residentTopic": <boolean> }, "applicabilityGeneration": <non-negative integer> }` — canonical output has **no whitespace and recursively lexicographic object keys** (actual serialized key order is lexical regardless of explanatory display order). **Arrays**: **messages** sorted `sortOrder` ascending then `id` (missing `sortOrder` → absent → sorts after present finite values then `id`); **blocks** sorted by parent message position in canonical messages, then `sortOrder` ascending if present then `id` — **current renderer `MessageBlock` shape (`src/renderer/src/types/newMessage.ts` `BaseMessageBlock`) has no numeric `sortOrder`/`order` field, therefore block `sortOrder` comparison is omitted and blocks sort by parent position then `id`** (do not defer to Phase 6); **segments** sorted by `sortOrder` ascending if present then `id`, otherwise by `id` — **current renderer `TopicSegment` shape (`src/renderer/src/types/topicSegment.ts`) has no `sortOrder` field, therefore segments sort by `id`**; missing optional `sortOrder` treated as absent and sorts after present finite values then `id`. Each entity is its **complete renderer projection object** canonicalized: **undefined object properties omitted, undefined array slots become `null`, `null` retained, finite numbers as ECMAScript JSON numbers, non-finite (`NaN`/`Infinity`) rejected as invalid, booleans/strings as JSON, no functions/symbols/bigints permitted**. Topic/index metadata **not separately included** beyond the exact frame; no vague “topic ID/index/completeness metadata”. Referenced shared entities are **fully duplicated per topic** for accounting. `applicabilityGeneration` is included **solely to make the admission payload generation-specific** and does not become authority/schema/cursor/revision. Recomputed after full load and incrementally adjusted or recomputed after mutations. Derived viewport/context/search caches **excluded** because separately bounded (§4.5). Logical bytes are a **stable admission proxy, not heap bytes**; calibration records the **logical retained payload calibration plus separately recorded heap-amplification ratio** (§4.8). Shared entities referenced by multiple resident topics are **conservatively charged in full to each referencing topic** for admission; heap-amplification measurement records actual deduplication separately (does not change authority). |
| **Estimated retained payload (legacy label)** | **Retired.** Former heuristic label for B-02 accounting; superseded by deterministic Logical retained payload and `logical retained payload calibration plus separately recorded heap-amplification ratio`. No remaining normative use of "estimated retained payload" remains in this document; any historical phrase is non-normative. |
| **Admission** | Decision to insert or retain a topic projection in the resident set. |
| **Eviction** | Removal of a **whole-topic** projection from renderer Redux. Always **atomic at topic granularity** — one renderer state transition removing topic index and exclusive messages/blocks/segments/completeness/accounting metadata after outgoing scroll save; entities shared by another resident topic remain; derived memo/window is disposed by generation invalidation (§4.6). **Miss is whole-topic; Phase 4 never performs per-entity partial eviction.** |
| **LRU** | Least-recently-used ordering among evictable topics; recency is **last successful activation or unpin**; tie-break deterministic by **topic ID** (lexicographic). Active/pinned topics never enter LRU. |
| **Idle TTL** | Time since **lastAccess** (set on activation and on unpin when topic becomes inactive+settled) after which an evictable topic becomes eligible for TTL eviction (§4.5: 30 min). |
| **Scroll retention index** | Renderer-local **Keyv metadata index** containing `topicId` + `lastAccess`; updated on scroll read/write; enforcement at startup after storage ready and on each write; rebuilds lazily from known scroll keys if missing/corrupt without affecting chat authority; if Keyv cannot enumerate, implementation must introduce a renderer-local index before enforcement (no schema/IPC authority change) (§4.6). |
| **ContentSearch descriptor chunk** | Lightweight non-DOM match descriptor (ordinal/offset) for search results; **at most one 500-match chunk retained**; DOM `Range` handles materialized only for current chunk/current match; retains total count and current ordinal scalars; search is over **current rendered DOM, not unloaded history** (§4.5–§4.6). |
| **Cache-miss path** | Miss on renderer entity projection → typed full-topic fetch → completeness validation → logical-bytes computation → projection rebuild (until Phase 5 windowed fetch). **Miss is whole-topic**; Phase 4 never performs per-entity partial eviction; completeness marker is required for a hit (§4.7). |
| **Bounded vs. unbounded claim** | Phase 4 bounds only the evictable caches (§4.5–§4.6). Renderer total memory is not claimed as bounded; active/pinned working set is measured but unbounded by this phase. |

#### 4.3 Current-state inventory (observed structure — current reality, not target)

| Aspect | Current observed structure | Evidence / location | Label |
|---|---|---|---|
| Entity projection retention | Renderer Redux `messages`/`blocks`/`segments` accumulate full projections for all visited topics; no eviction, no size cap, no TTL | `loadTopicMessagesThunk` early-return on any cached IDs; Redux topic stores grow without bound | Current — unbounded |
| Data-access path | `loadTopicMessagesThunk` → `dbService.fetchMessages` full-fetches on miss and early-returns on any cached IDs; no windowed/incremental/paginated load; no cache-miss join | `dbService.fetchMessages` `listByTopic` + `listByMessages`; §4.1 debt registry | Current data path |
| Viewport windowing | `createLatestMessageWindow` / `reconcileMessageWindow` expand without cap in 20-group steps; trims only on explicit reset; no max rendered groups; no opposite-edge trim | `createLatestMessageWindow`, `reconcileMessageWindow` | Current — unbounded |
| Scroll snapshots | `useScrollPosition` topic-keyed snapshots via keyv; never expire, never deleted when topic is deleted; no max topics, no TTL | `useScrollPosition` + keyv store | Current — unbounded |
| ContentSearch (Chat) | **Parent-owned lazy mount (S3.5)**: zero instance before invocation; **when mounted**, `Range[]` handle array grows with match count with no cap and no chunking; remains active across topic switch while mounted | `ContentSearch` (Chat) component; S3.5 lazy mount | Current (when mounted) — unbounded handles |
| ContentSearch (RichEditor legacy) | **Hidden-mounted history preserved** (`hidden` prop) in legacy RichEditor only; always present in that subtree | `RichEditor` component | Legacy current (RichEditor only) — hidden-mounted |
| Context info | `computeContextInfo` memo for one active topic; anchor-to-end result may be unbounded when `contextCount` is null (unlimited); recomputes on memo identity change | `computeContextInfo` on `[topic messages, topic blocks, assistant, topic id]` | Current — single-memo, potentially unbounded result |
| Background streams | Streams survive topic switches; per-topic queues have no global cap; active streams are request-scoped | Request pipeline; Phase 2 §2.1 | Current — no global queue bound |
| Undo / streaming throttle | Undo 50, streaming throttle 100/5 min observed as current operational bounds | Existing implementation | Current — observed bounds, not policy |
| `contextCount` null | `null` can mean unlimited; stable anchor-to-end semantics governed by `context-window.md` | `context-window.md` | Current semantics |

Target state for each row is defined in §4.4–§4.6; current vs. target is explicitly labeled here.

#### 4.4 Target ownership and tiering (unchanged authority)

| Domain | Target owner | Tier | Invariant |
|---|---|---|---|
| Authoritative chat data | Main SQLite (via typed IPC) | Authority | Single source of truth; never duplicated or overridden by renderer state (ARCH-007). |
| Renderer entity projection | Redux topic messages/blocks store | Disposable projection (evictable or pinned) | Derived from authority; disposable and rebuildable; never authoritative; whole-topic eviction is atomic. |
| Active-topic viewport / navigation / scroll | Renderer viewport reducer (topic-keyed) | Device-local UI state | Pinned while active; reset on explicit activation; no cross-topic leakage. |
| Live request / stream transient state | Request pipeline (topic/message-scoped) | Pinned working set | Survives topic switch; pins its originating topic until settled (resolved/failed/aborted) — see §4.6. |
| Derived render / context projection | Renderer memoized computations | Disposable projection | Rebuilt from entity projection; max one active topic retained for context-info (§4.5). |
| Scroll snapshots | Renderer keyv (device-local) | Bounded device-local cache | Max 256 topics, 90-day idle TTL, immediate deletion on topic delete (§4.5). |
| ContentSearch handles | Renderer DOM | Bounded view cache | Max 500 live `Range` handles; overflow via non-DOM descriptors (§4.5). |

Renderer entity state tiering:

```
Authority (Main SQLite)
  → Typed full-topic fetch (until Phase 5) → Renderer entity projection
       ├─ Pinned working set (active topic + topics with pending/in-flight requests) — excluded from eviction, measured (§4.8)
       └─ Evictable set (inactive, non-pinned resident projections) — strictly bounded (§4.5), LRU+TTL+size eviction (§4.6)
  → Derived projections (viewport window, context info, display groups) — disposable, rebuilt from entity projection
```

`context-window.md` remains authoritative for anchor/count semantics; `contextCount` null (unlimited) is preserved and anchor-to-end behavior is stable per that document. Request-stream independence is preserved: topic transition does not terminate or redirect in-flight streams.

#### 4.5 Concrete bounds table (target capacity defaults — evictable set only)

> **Scope and calibration notice**: Every row below bounds only the strictly evictable set defined in §4.2/§4.4 unless explicitly labeled otherwise. Active/pinned topics are excluded from these caps but are measured (§4.8). All numeric defaults are **architecture capacity defaults requiring calibration before implementation**; they are **not** performance acceptance thresholds and **not** validated baselines. Renderer total memory is not claimed as bounded.

| # | Bounded subject | Target bound | Applies to | Enforcement | Calibration / note |
|---|---|---|---|---|---|
| B-01 | Inactive resident topic projections | **max 8 topics** | Evictable set only | Admission gate + LRU eviction on insert/access | Capacity default; requires calibration against retained-payload distribution before implementation. Active/pinned topics excluded. |
| B-02 | Aggregate logical retained payload | **max 32 MiB** aggregate across evictable set (deterministic logical bytes via **canonical encoding** below) | Evictable set only | Eviction until aggregate ≤ 32 MiB after admission or size accounting | **Canonical logical-byte encoding (reproducible)**: **UTF-8 bytes of canonical JSON** serialization of the **exact renderer-local accounting frame** `{ "accountingVersion": "phase4-logical-payload-v1", "topicId": <string>, "messages": [...], "blocks": [...], "segments": [...], "completeness": { "chatData": <boolean>, "segments": <boolean>, "residentTopic": <boolean> }, "applicabilityGeneration": <non-negative integer> }` — canonical output has **no whitespace and recursively lexicographic object keys** (actual serialized key order is lexical regardless of explanatory display order). **Arrays**: **messages** sorted `sortOrder` ascending then `id` (missing `sortOrder` → absent → sorts after present finite values then `id`); **blocks** sorted by parent message position in canonical messages, then `sortOrder` ascending if present then `id` — **current renderer `MessageBlock` shape (`src/renderer/src/types/newMessage.ts` `BaseMessageBlock`) has no numeric `sortOrder`/`order` field, therefore block `sortOrder` comparison is omitted and blocks sort by parent position then `id` (do not defer to Phase 6)**; **segments** sorted by `sortOrder` ascending if present then `id`, otherwise by `id` — **current renderer `TopicSegment` shape (`src/renderer/src/types/topicSegment.ts`) has no `sortOrder` field, therefore segments sort by `id`**; missing optional `sortOrder` treated as absent and sorts after present finite values then `id`. Each entity is its **complete renderer projection object** canonicalized: **undefined object properties omitted, undefined array slots become `null`, `null` retained, finite numbers as ECMAScript JSON numbers, non-finite (`NaN`/`Infinity`) rejected as invalid, booleans/strings as JSON, no functions/symbols/bigints permitted**. Topic/index metadata **not separately included** beyond the exact frame; no vague “topic ID/index/completeness metadata”. Referenced shared entities are **fully duplicated per topic** for accounting. `applicabilityGeneration` is included **solely to make the admission payload generation-specific** and does not become authority/schema/cursor/revision. Recomputed after full load and incrementally adjusted or recomputed after mutations; derived viewport/context/search caches **excluded** because separately bounded; logical bytes are a **stable admission proxy, not heap bytes**; calibration records **logical retained payload calibration plus separately recorded heap-amplification ratio** (§4.8). **Shared entities** referenced by multiple resident topics are **conservatively charged in full to each referencing topic** for admission; heap-amplification measurement records actual deduplication separately (does not change authority). |
| B-03 | Idle TTL (evictable topics) | **30-minute idle TTL** | Each evictable topic | TTL sweep evicts topics idle >30 min since lastAccess | Wall-clock idle since lastAccess (set on activation and on unpin when inactive+settled); pinned topics never TTL-evicted. Sweep timing: at admission and unpin plus session-local periodic sweep no slower than 60 s (target design, not implementation; §4.6). |
| B-04 | Eviction policy (evictable set) | **LRU** across evictable topics | Evictable set | On B-01/B-02 pressure, evict least-recently-used evictable topic(s) first | Recency = **last successful activation or unpin**; tie-break deterministic by **topic ID** (lexicographic). Active/pinned topics never enter LRU. Eviction order: TTL first, then any single topic >32 MiB, then LRU until both 8-topic/32-MiB caps hold (§4.6). |
| B-05 | Single oversized topic | **non-admissible after deactivation** | Any topic whose **logical retained payload alone exceeds exactly B-02 (32 MiB)** | On deactivation, if topic is oversized and not pinned, it is evicted immediately and not retained in evictable set | Prevents one large topic from occupying the entire budget; pinned oversized topics remain pinned until unpinned then re-evaluated. Threshold is **exactly 32 MiB**, not B-02/B-01. |
| B-06 | Viewport rendered groups | **target max 200 rendered groups** | Active viewport only | Expand in existing **20-group steps** (history + live-tail runs); when cap would be exceeded, **trim opposite edge** while **preserving navigation/scroll anchors** per deterministic anchor/trim rule (§4.6) | Anchor: **navigation target group while a navigation transaction is active**, otherwise **first visible group + pixel offset**; expanding older trims newest overflow, expanding newer trims oldest overflow; if opposite-edge trim would remove anchor, **recenter up to 200 groups around anchor** with deterministic older-first then newer fill; **restore captured pixel offset after commit**; **latest-edge mode navigation to bottom recreates latest 200**. **No message entities are evicted by viewport trim** — trim affects only the rendered window. Existing 20-group step preserved. Historical behavior was unbounded. |
| B-07 | Scroll snapshot cache | **max 256 topics**, **90-day idle TTL**, **immediate deletion cleanup** | Device-local scroll keyv via **renderer-local Keyv metadata index** (`topicId`+`lastAccess`) | LRU eviction at 256; TTL sweep at 90 days idle; **immediate delete** when topic is hard-deleted/finally purged | Index updated on read/write; enforcement at **startup after storage ready and on each write**, **TTL first then LRU with topic ID tie-break**; **soft-delete/trash retains snapshot for restore; hard delete/final purge removes immediately**; missing/corrupt index rebuilds lazily from known scroll keys without affecting chat authority; if Keyv cannot enumerate, implementation must introduce a renderer-local index before enforcement (no schema/IPC authority change) (§4.6). |
| B-08 | ContentSearch live handles | **max 500 live DOM `Range` handles** and **bounded descriptors** | ContentSearch view state per search session | Retain **at most one 500-match chunk of lightweight descriptors**; materialize DOM `Range` handles **only for current chunk/current match**; retain total count and current ordinal scalars | Search is over **current rendered DOM, not unloaded history**. Navigation outside chunk **deterministically rescans current rendered DOM to build target chunk**; DOM/topic/content generation change **invalidates ranges/descriptors and reruns search**. **No unbounded descriptor list**; result count/next-prev semantics preserved, overflow may cost rescan. Search invocation still lazy (Phase 3 S3.5). |
| B-09 | Context-info retained result | **max one active topic** retained result; **invalidates** on topic entities / referenced blocks / assistant / context settings / topic id changes | Renderer memo | Single-topic memo; invalidation is eager on any of the listed inputs; anchor-to-end result remains unbounded until Phase 5 windowed fetch provides windowing | `contextCount` null (unlimited) semantics unchanged; context-info does not bound the anchor-to-end computed range, only the retained memo count. |
| B-10 | Undo stack | **50** — observed current bound | Renderer edit state | Existing bound preserved | **Not a newly implemented Phase 4 policy** — documented as observed current bound. |
| B-11 | Streaming request throttle / queue | **100 per 5 min** — observed current bound; no global queue cap currently | Request pipeline | Existing throttle preserved | **Not a newly implemented Phase 4 policy** — documented as observed current bound. Global queue cap and additional throttling are **Phase 6/governance** open decisions (§4.10). |

Pinned working-set note: active topic and every topic with pending/in-flight request are **not** counted toward B-01/B-02 caps, are **not** TTL-evicted (B-03), and are **not** in LRU (B-04). Their retained payload is **measured and reported** as a separate working-set metric (§4.8) to inform **Phase 6/governance** working-set bounding decisions (Phase 5 owns windowed/semantic contract design; Phase 6 candidate slices own implementation).

#### 4.6 Pin / admission / eviction / invalidation / rebuild matrix

| Concern | Rule | Triggers / inputs | Action | Exception / pinning |
|---|---|---|---|---|
| **Pinning — active topic** | Active topic is pinned | Topic activation (Phase 2 §2.3) | Topic excluded from all evictable caps and LRU/TTL; retained in renderer while active | Cannot be evicted by ordinary cache pressure. |
| **Pinning — in-flight requests** | Every topic with pending/in-flight request/stream is pinned | Request initiation, streaming progress, queue entry; unpin on settled (resolved/failed/aborted) | Topic excluded from evictable caps and LRU/TTL while any request for that topic is pending | Survives topic switches; unpinned only when no pending request remains for that topic. Background streams remain pinned until settled. |
| **Pinning interaction** | Pin is additive | Topic that is both active and has in-flight request is singly pinned; remains pinned if either condition holds | Unpin requires both: topic inactive **and** no pending request | Prevents eviction of live streams after navigation away. |
| **Deterministic lifecycle order** | **Pin first → stage chat-data + segment-data for same generation → await both + validate together → compute canonical logical bytes → publish in one transition → admit while pinned → on inactive+settled set lastAccess and unpin → enforce eviction** | Activation/admission/unpin transitions | On activation: **pin first** for issued generation; **stage chat data and segment data for that same generation** (coordinated separate reads or future coordinated payload subject to Phase 5/6 review and §10.1; **not prescribing `fetchMessages` payload addition**); **await both and validate IDs/references/generation together**; **calculate canonical logical bytes** (UTF-8 bytes of canonical JSON per §4.5 B-02) and set **component (`chat-data`, `segment`) and resident-topic markers** for that generation; **publish all in one renderer state transition and admit while pinned** (caps not enforced while pinned; if either load fails or generation mismatches, discard all staged data for that attempt and publish no new markers/accounting). On transition to **inactive+settled**, set **lastAccess** and **unpin**; then enforce eviction in strict order: **TTL first**, then **any single topic >32 MiB (B-05)**, then **LRU until both 8-topic (B-01) and 32-MiB (B-02) caps hold**. LRU recency = **last successful activation or unpin**, tie-break **topic ID** (lexicographic). Whole-topic eviction is **one renderer state transition removing topic index and exclusive messages/blocks/segments/completeness/accounting metadata after outgoing scroll save**; shared entities referenced by another resident topic **remain**; derived memo/window **disposed by generation invalidation**. **TTL sweep at admission and unpin, plus session-local periodic sweep no slower than 60 s**; target design, not implementation. | Active/pinned topics bypass cap enforcement until they become evictable; eviction never evicts pinned topics. |
| **Admission — cache hit** | Topic already resident (pinned or evictable) **with resident-topic completeness** | Target: **chat-data AND segment completeness for the same generation** plus generation-matched markers (explicit empty markers count as complete where applicable). Current `cachedIds.length > 0` and `fetchMessages`-only path are **current behavior that do not satisfy the future contract**. | **Hit** = **resident-topic completeness** (both components validated for recorded generation). On hit, update LRU recency if evictable; no fetch; **no mixed-generation cache joins**. **Miss is whole-topic**; any component absence or generation mismatch is whole-topic miss; no per-entity partial eviction in Phase 4. | Pinned hits do not affect LRU; evictable hits move to MRU (recency = activation time; tie-break topic ID). |
| **Admission — cache miss** | Topic not resident or **resident-topic completeness** absent/invalid (either component missing, reference/ID validation failure, or generation mismatch) | Access to non-resident/incomplete topic; generation changed by mutation; staged data failure | **Pin first** for issued generation; **stage chat data and segment data for that same generation** (coordinated separate reads or future coordinated payload subject to Phase 5/6 and §10.1; not prescribing `fetchMessages` payload addition); **await both, validate together, compute canonical logical bytes, and publish in one renderer transition while pinned**; then apply admission caps on becoming evictable. **If either load fails or generation mismatches, discard staged data for that attempt and publish no new markers/accounting** (preserve/invalidate prior entry per prior generation; no mixed-generation joins). | Entire topic staged as two components until Phase 5 windowed fetch replaces where window completeness suffices (resident-topic staging coherence retained). Renderer-local generation/completeness metadata only; no IPC/schema versioning. |
| **Admission — capacity gate** | Enforce B-01/B-02 on insertion | Insertion of a newly fetched topic that becomes evictable on deactivation; mutation grows logical bytes | After insertion/unpin, enforce in order: **TTL → oversized (>32 MiB) → LRU** until both count and size caps satisfied | If newly inserted topic is active or pinned, caps not enforced at insertion time; enforcement deferred until it becomes evictable. |
| **Eviction granularity** | **Whole-topic atomic** | Any eviction (LRU, size, TTL) | Entire topic projection removed in **one renderer state transition** removing topic index and **exclusive** messages/blocks/segments/completeness/accounting metadata **after outgoing scroll save**; no partial-topic retention; shared entities referenced by another topic **remain**; derived projections disposed by **generation invalidation** | No per-message partial eviction; viewport trim never evicts message entities. |
| **Eviction — ordering** | Deterministic eviction order | Evictable set exceeds TTL, B-05, or B-01/B-02 | Evict in strict order: **1) TTL-expired topics**, **2) any single topic >32 MiB (B-05)**, **3) LRU until both caps hold**; LRU ordering by last successful activation or unpin, tie-break topic ID | Active/pinned topics never evicted. |
| **Eviction — idle TTL** | Evictable topic idle >30 min since lastAccess | TTL sweep at **admission and unpin** plus **session-local periodic sweep no slower than 60 s** (target design, not implementation) | Evict topics exceeding 30-min idle TTL | Active/pinned topics never TTL-evicted. |
| **Eviction — scroll snapshots** | Scroll cache exceeds 256 or idle >90 days; topic deletion | Keyv metadata index (`topicId`+`lastAccess`) updated on read/write; enforcement at **startup after storage ready and on each write** → **TTL first then LRU with topic ID tie-break**; topic delete path | Evict oldest/expired snapshots; **soft-delete/trash retains snapshot for restore; hard delete/final purge removes immediately** | Scroll index is renderer-local device-local; missing/corrupt index **rebuilds lazily from known scroll keys** without affecting chat authority; if Keyv cannot enumerate, implementation must introduce a renderer-local index before enforcement (no schema/IPC authority change). |
| **Eviction — viewport trim** | Viewport would exceed 200 groups on next 20-group expansion | Next expansion step; anchor defined as **navigation target group while a navigation transaction is active, otherwise first visible group + pixel offset** | **Expanding older trims newest overflow, expanding newer trims oldest overflow**; if opposite-edge trim would remove anchor, **recenter up to 200 groups around anchor with deterministic older-first then newer fill**; **restore captured pixel offset after commit**; **latest-edge mode navigation to bottom recreates latest 200**. **No message entities are evicted by viewport trim.** | Anchor preservation is deterministic; pixel offset restored after commit. |
| **Eviction — ContentSearch overflow** | Match count would require >500 live `Range` handles | Next highlight/measurement step; search is over **current rendered DOM, not unloaded history** | Retain **at most one 500-match chunk of lightweight descriptors**; materialize DOM `Range` handles **only for current chunk/current match**; retain **total count and current ordinal scalars**; navigation outside chunk **deterministically rescans current rendered DOM to build target chunk**; DOM/topic/content generation change **invalidates ranges/descriptors and reruns search** | **No unbounded descriptor list**; result count/next-prev semantics preserved, overflow may cost rescan. |
| **Invalidation — context info** | Context-info memo is stale | Change to **topic entities**, **referenced blocks**, **assistant**, **context settings**, or **topic id** | Eager invalidation of the single retained result; recompute on next access | Memo holds at most one active-topic result (§4.5 B-09). |
| **Invalidation — entity projection** | Projection is stale vs authority | Authoritative mutation (message/block/topic write) observed via IPC/projection update; generation invalidated | Invalidated projection rebuilt on next activation via staged same-generation fetch (until Phase 5 windowed); derived memo/window disposed by generation invalidation | No incremental patch in Phase 4; rebuild is staged same-generation. Renderer-local generation only. |
| **Deletion cleanup — authoritative vs soft-delete** | Topic/messages deleted or assistant reset | **Soft-delete/trash**: topic/message marked trashed but restorable. **Hard delete / final purge / empty-trash / assistant reset**: authoritative deletion (Main SQLite confirms removal). | **Soft-delete/trash**: **preserves resident projection (both component markers, generation, accounting) and scroll snapshot for restore** unless ordinary pressure (TTL/LRU/B-05) evicts it; scroll snapshot retained per §4.5 B-07 soft-delete rule. **Hard delete/final purge/empty-trash/assistant reset**: **atomically invalidates/removes in one renderer transition all resident component and composite markers, generation/accounting, topic index, exclusive messages/blocks/segments, derived viewport/context/search state, and scroll snapshot** (scroll immediate delete per B-07). **Shared entities still referenced by another resident topic remain**. Bulk deletion must **identify affected resident topic IDs from the authoritative deletion result or an existing typed capability**; if current result is insufficient to identify IDs, **any contract change to expose those IDs routes through §10.1** (coordinated shared-contract review). **No implementation is authorized** — this is target contract only. Derived viewport/context/search disposed by generation invalidation; **no deleted projection may satisfy future admission or cache joins**. | Soft-delete restore remains possible until evicted; hard-delete is irreversible projection removal; **no mixed-generation cache joins**; bulk path requires §10.1 if result insufficient. |
| **Rebuild — entity projection miss** | Topic was evicted and is re-accessed | Cache miss on non-resident/incomplete topic | Rebuild through **staged same-generation fetch** (chat-data + segment-data for same generation; coordinated separate reads or future payload subject to Phase 5/6 and §10.1); **validate together, compute canonical logical bytes, publish in one transition**; no new IPC channel prescribed; re-admit while pinned | Until Phase 5 windowed fetch, every miss is a staged whole-topic load; cost is measurable per §4.8. Miss is whole-topic. |
| **Rebuild — derived projections** | Derived state was disposed with entity eviction | Viewport/context info requested for evicted topic | Recompute from rebuilt entity projection; viewport bootstraps per Phase 2 §2.3 | Derived state never persisted as authority. |

#### 4.7 Cache-miss contract

1. **Hit / miss detection (target contract)**: A **hit** requires **resident-topic completeness** = **chat-data completeness AND segment completeness for the same renderer applicability generation** (renderer-local projection generation/completeness metadata only; no IPC/schema versioning), including explicit empty markers where applicable. Current `cachedIds.length > 0` early-return is **current behavior that does not satisfy the future contract**. Current `dbService.fetchMessages` **only returns messages/blocks** and current segment load is **separate/unawaited** — the current path **does not satisfy target resident completeness**. **Miss is whole-topic** — any component absence, reference/ID validation failure, or generation mismatch is a whole-topic miss; Phase 4 never performs per-entity partial eviction; **no mixed-generation cache joins**.
2. **Miss path (until Phase 5)**: **Pin first** for the issued generation; **stage chat data and segment data for that same generation** — coordinated separate reads or a coordinated future payload **subject to Phase 5/6 contract review and §10.1 IPC gate; Phase 4 does not prescribe that segments must be added to the existing `fetchMessages` IPC payload**; **await both**; **validate IDs/references/generation together**; **calculate canonical logical bytes** (UTF-8 bytes of canonical JSON per §4.5 B-02); **publish messages/blocks/segments plus component (`chat-data`, `segment`) and resident-topic markers and accounting in one renderer state transition**. **If either load fails or generation mismatches, discard all staged data for that attempt, publish no new markers/accounting, and preserve or invalidate the prior entry according to its prior generation** (never mix generations or publish partial components). No new IPC schema is prescribed by Phase 4.
3. **Admission after fetch**: Newly fetched topic is resident while pinned (active or in-flight) only after staged same-generation publication. If topic is active or pinned, it remains outside evictable caps. Upon becoming **inactive+settled**, set **lastAccess** and **unpin**, then enforce eviction in strict order: **TTL first, then any single topic >32 MiB (B-05), then LRU until both 8-topic/32-MiB caps hold** (recency = last successful activation or unpin; tie-break topic ID).
4. **Failure handling**: IPC or DB failure or generation mismatch on staged publication **commits no new complete resident entry** for that generation and **publishes no new markers/accounting**; the failed attempt surfaces through the existing error path and the **prior entry is preserved or invalidated according to its prior generation** (no mixed-generation state). A **later explicit activation/retry repeats the idempotent staged same-generation fetch** for the same topic. **No automatic retry is claimed** — retry is caller-driven and idempotent; no mixed-generation cache joins.
5. **Phase 5 replacement**: **Phase 5 owns R-02..R-06 windowed/semantic read and cache-join contract design; Phase 6 candidate slices own any implementation; incremental/delta is excluded from Phase 5 and deferred to Phase 6/future decision without generation authority cursor** — windowed/semantic reads will replace the full-topic staged path where window completeness is sufficient, subject to coherence with resident-topic staging. Phase 4 anticipates that replacement without prescribing its interface (see §4.10).
6. **Measurability**: Every hit/miss (with component and resident completeness reason and generation), staged-load latency for chat-data and segment-data, **canonical logical-bytes** payload size, eviction reason, and discarded-staged-attempt count are observable per §4.8. Miss rate and fetch cost are not performance thresholds — they are calibration evidence; **traceability shows staged same-generation publication and no mixed-generation cache joins**.

#### 4.8 Observability, measurability, and privacy requirements

**Measurability (required before calibration/implementation)**:

| Metric | Scope | Requirement |
|---|---|---|
| Resident topic count | Evictable set vs. pinned working set (separate counters) | Report both; pinned count includes active topic + in-flight topics. |
| Logical retained payload (B-02) | Per-topic **canonical** UTF-8 logical bytes of **exact frame `phase4-logical-payload-v1`** (`accountingVersion`:`phase4-logical-payload-v1`, `topicId`, `messages`, `blocks`, `segments`, `completeness`{`chatData`,`segments`,`residentTopic`}, `applicabilityGeneration`) and aggregate across evictable set | Per-topic **canonical** logical bytes (no whitespace, recursively lexicographic keys, arrays sorted per B-02 exact frame with evidenced renderer field names, entities canonicalized per B-02, `applicabilityGeneration` generation-specific, shared entities duplicated) and aggregate vs. **32 MiB** budget; instrument canonical logical-bytes computation (recompute / incremental adjustment per exact frame, finite numbers only, non-finite rejected) and report aggregate; derived caches excluded; shared entities conservatively charged in full per topic for admission; heap deduplication recorded separately in heap-amplification ratio. |
| Heap-amplification ratio | Logical bytes vs. observed heap | Sample heap for resident topics and record **heap-amplification ratio** (heap bytes / canonical logical bytes) per workload; **logical retained payload calibration plus separately recorded heap-amplification ratio**; does not change B-02 definition. |
| Working-set payload | Pinned working set aggregate (logical bytes + heap ratio) | Measured and reported separately; not capped by Phase 4 but informs **Phase 6/governance** working-set bounding. |
| Cache hit/miss rate | Staged same-generation fetches (chat-data + segment-data) with component and resident completeness reason | Hit/miss counts by reason (no resident entry / `chat-data` absent / `segment` absent / resident incompleteness / generation mismatch / empty-component marker present / staged failure / authoritative deletion), staged latency (chat-data and segment-data), canonical logical bytes per miss/fetch, generation and staged-publication validation outcomes; **no mixed-generation cache joins**. |
| Cache completeness | Per resident topic: **component (`chat-data`, `segment`) and composite (`resident-topic`) markers** + generation | Component/composite markers present/absent per generation, generation recorded, empty-component markers valid for each component; current `cachedIds.length > 0` and `fetchMessages`-only path labeled current behavior not satisfying future resident completeness. |
| Eviction events | LRU, size, TTL, B-05 non-admissible, deletion cleanup (soft vs hard) | Count and reason per eviction; evicted topic canonical logical bytes; ordering verified (**TTL first, then >32 MiB, then LRU**); LRU recency = last activation or unpin, tie-break topic ID visible; **soft-delete/trash retained vs hard-delete/purge immediate removals** per deletion-cleanup row (§4.6). |
| TTL sweep execution | Session-local sweeps | Counts and triggers: at admission, at unpin, and periodic ≤60 s sweep; idle-time source = lastAccess; pinned topics never swept. |
| Viewport groups | Active viewport | Current group count, expansions, trims, anchor identity (navigation target vs. first visible + pixel offset), anchor stability across trim, recenter events, pixel-offset restoration verified; confirm **no message entities evicted by viewport trim**. |
| Scroll snapshot cache | Keyv metadata index (`topicId`+`lastAccess`) | Topic count, index health (present/missing/corrupt/rebuilt), TTL expirations, LRU evictions (topic ID tie-break), soft-delete retained vs. hard-delete immediate removals, enforcement counts at startup and on each write. |
| ContentSearch handles | Per search session | Live `Range` count vs. **bounded descriptor chunk** (max one 500-match chunk), overflow occurrences, chunk rescan counts (deterministic rescan on navigation outside chunk), invalidation counts on DOM/topic/content generation change, total count and ordinal scalars retained; confirm no unbounded descriptor list. |
| Context-info | Per active topic | Memo hit/miss, invalidation reason, computed range length (to observe unbounded anchor-to-end). |

**Privacy**: All metrics are local, in-process diagnostics. No payload content leaves the device; no network export. Any future OTLP/log export must follow existing `loggerService` and privacy review; Phase 4 does not create export paths.

**Calibration**: B-01/B-02/B-03 capacity defaults require empirical calibration of **logical retained payload (deterministic UTF-8 bytes of canonical JSON per B-02 canonical encoding) plus separately recorded heap-amplification ratio** and workload distribution before implementation authorization. Phase 4 does not perform that calibration. B-02 remains **32 MiB logical bytes (canonical encoding)**; heap-amplification ratio is recorded separately, not conflated with B-02.

#### 4.9 Memory acceptance plan (Phase 4 validation — not a threshold adoption)

Phase 4 acceptance is **memory-architecture acceptance**, not performance-threshold closure:

| Criterion | Validation | Threshold status |
|---|---|---|
| Bounded evictable caches (B-01–B-05) | Evictable set respects **8 topics (B-01)** and **32 MiB logical bytes (B-02 exact frame `phase4-logical-payload-v1`)** under exercised workload; **deterministic logical-bytes accounting via exact frame canonical encoding** (UTF-8 bytes of canonical JSON per B-02 exact frame `{accountingVersion:phase4-logical-payload-v1, topicId, messages, blocks, segments, completeness{chatData,segments,residentTopic}, applicabilityGeneration}`, no whitespace, recursively lexicographic keys, arrays sorted per B-02 with evidenced renderer field names, entities canonicalized, shared entities duplicated, `applicabilityGeneration` generation-specific, derived caches excluded; recomputed/incrementally adjusted) demonstrated; **single-topic threshold is exactly 32 MiB (B-05 = B-02)** and oversized-topic non-admissibility demonstrated; enforcement order **TTL → >32 MiB → LRU (recency = last activation or unpin, tie-break topic ID)** verified; no evictable topic exceeds caps after enforcement; **no mixed-generation cache joins; staged same-generation publication validated** | Validated against capacity defaults; defaults are **not** recast as performance thresholds; **logical retained payload calibration plus separately recorded heap-amplification ratio** for calibration |
| Cache completeness contract | Hit requires **resident-topic completeness = chat-data AND segment completeness for same generation** plus component and composite markers (explicit empty markers where applicable); current `cachedIds.length > 0` and `fetchMessages`-only + separate/unawaited segment load labeled current behavior not satisfying future contract; miss is **whole-topic** and never per-entity partial eviction; staged same-generation publication (await both, validate together, publish in one transition; discard on failure/mismatch; no mixed-generation joins) validated; generation is renderer-local only | Behavior demonstrated via **component/composite completeness reason** instrumentation (§4.8); no IPC/schema versioning claimed; **traceability shows staged same-generation publication and no mixed-generation cache joins** |
| Failure / retry contract | Failed or generation-mismatched **staged** fetch **commits no new complete resident entry and publishes no new markers/accounting** (prior entry preserved/invalidated per prior generation); **later explicit activation/retry repeats idempotent staged same-generation fetch**; no automatic retry claimed; **no mixed-generation cache joins** | Error-path observable; retry measurably repeats staged same-generation fetch; discarded staged-attempt count observable |
| Deterministic lifecycle & atomicity | Lifecycle order **pin first → stage chat-data + segment-data for same generation → await both + validate together → compute canonical logical bytes → publish in one transition → admit while pinned → on inactive+settled set lastAccess and unpin → TTL→oversized→LRU eviction** verified; **whole-topic (resident-topic) eviction is one renderer state transition removing topic index and exclusive entities plus component/composite markers/generation/accounting after outgoing scroll save**; shared entities referenced by another topic **remain**; derived memo/window **disposed by generation invalidation**; **TTL sweep at admission and unpin plus ≤60 s periodic sweep** observed (target design); **authoritative deletion atomically removes all component/composite markers/generation/accounting/topic index/exclusive entities/derived viewport/context/search/scroll snapshot in one transition (shared entities remain) — soft-delete retains for restore** | Target design validation; not implementation; caps not enforced while pinned; **deletion cleanup per §4.6** |
| Authoritative deletion invalidation | Hard delete/final purge/empty-trash/assistant reset **invalidates every completeness type** (whole-topic/window/answer-group/context closure and chat-data/segment/resident-topic) and **rejects/disposes stale generation before any further join/action**; **no deleted projection satisfies R-01..R-06**; soft-delete retains projection/scroll for restore unless pressure evicts; bulk IDs from authoritative result/typed capability or §10.1 gate if insufficient | Deletion cleanup validated per §4.6; no mixed-generation joins; **Phase 6 candidate acceptance must demonstrate invalidation before any join/action** |
| Viewport trim anchor | Deterministic anchor **(navigation target while transaction active, otherwise first visible group + pixel offset)** preserved; **expanding older trims newest, expanding newer trims oldest**; if opposite-edge trim would remove anchor, **recenter up to 200 around anchor older-first then newer fill**; **pixel offset restored after commit**; **latest-edge mode navigation to bottom recreates latest 200**; **no message entities evicted by viewport trim** | Anchor stability and pixel-offset restoration measurable (§4.8); 200-group cap is target capacity default |
| Scroll retention index | **Renderer-local Keyv metadata index** (`topicId`+`lastAccess`) updated on read/write; enforcement at **startup after storage ready and on each write**, **TTL first then LRU with topic ID tie-break**; **soft-delete/trash retains snapshot for restore; hard delete/final purge removes immediately**; missing/corrupt index **rebuilds lazily from known scroll keys** without affecting chat authority; if Keyv cannot enumerate, renderer-local index introduced before enforcement (no schema/IPC authority change) | Startup/write enforcement measurable; index health and rebuild observable (§4.8) |
| ContentSearch bounded overflow | Search is over **current rendered DOM, not unloaded history**; at most **one 500-match chunk of descriptors** retained and **Range handles materialized only for current chunk/current match**; **total count and ordinal scalars** retained; navigation outside chunk **deterministically rescans current rendered DOM to build target chunk**; **DOM/topic/content generation change invalidates ranges/descriptors and reruns search**; **no unbounded descriptor list**; result count/next-prev preserved, overflow may cost rescan | Descriptor boundedness and rescan cost measurable (§4.8) |
| Pinned exception explicit | Active/pinned topics are never evicted by pressure; working-set logical-bytes + heap ratio measured separately | Behavior verified, working-set measured; working-set bounds remain open for **Phase 6/governance** (see §4.10) |
| Cache invalidation rules (general) | Viewport trim, scroll TTL/deletion, ContentSearch chunk invalidation, context-info invalidation, generation invalidation all behave per §4.5–§4.6 | Validated as specified |
| Cache-miss path measurability & calibration | Hit/miss (with completeness reason), fetch latency, logical bytes, heap-amplification ratio, and eviction reasons are observable per §4.8; miss latency and heap ratio are evidence, not committed PERF thresholds; calibration records heap ratio before implementation | Observability demonstrated; no threshold adoption; Phase 4 exit remains Open |
| Non-claim | Renderer total memory not claimed as bounded; heap measurement remains directional until working-set governance and Phase 5 windowing; capacity defaults are calibration inputs, not performance thresholds | Explicit non-claim preserved |

**What Phase 4 does not do**: It does not close PERF-TOPIC-SWITCH or PERF-ECHO (reclassified as independent post-refactor workstreams, remain Open per ARCH-011), does not adopt a committed numeric threshold, and does not claim heap or latency improvement. Phase 3 is structurally Complete/Closed 2026-08-21 on structural/governance/functional evidence (ARCH-009/ARCH-010); its L3 measurements (bfc1c617 and 4df885d) remain directional reference unless remeasured and no controlled same-state improvement/regression claim is made (ARCH-012). Performance acceptance thresholds remain owned by `performance-measurement.md` and require separate decision.

#### 4.9a Acceptance-evidence surface map (2026-08-22 — documentation-only validation planning)

This map records, for each §4.9 criterion, its current evidence status and the future demonstration surface expected to satisfy it. It shows why the Phase 4 exit gate cannot close before implementation exists: **no criterion is fully demonstrable today**; the best current cases are partial, measurement-only coverage via the approved calibration harnesses (C-01 logical payload bench `pnpm bench:logical-payload` and C-02 opt-in renderer heap E2E `C02_HEAP_CALIBRATION=1`, both registered in `performance-measurement.md`). The map itself adopts nothing — it is validation planning only, preserves all §4.13-style non-claims, and authorizes no implementation.

| Criterion | Current evidence status | Demonstration surface |
|---|---|---|
| Bounded evictable caches (B-01–B-05) | **Partial**: calibration components only today (C-01 binding/B-05 classification gates; C-02 canonical logical bytes + heap-amplification ratio); enforcement behavior does not exist yet | Future: unit tests for TTL → oversized → LRU eviction order and cap hold; Playwright E2E for staged same-generation publication under exercised load |
| Cache completeness contract | **Deferred**: current behavior documented as not satisfying the future contract; requires implementation | Future: renderer component/unit tests for integrity markers; E2E for staged publication and no mixed-generation joins |
| Failure / retry contract | **Deferred**; no execution surface exists today | Future: unit tests for staged-fetch failure/generation-mismatch discard and idempotent retry; error-path observability counters |
| Deterministic lifecycle & atomicity | Target-design validation only (§4.9 states "not implementation") | Future: unit tests for lifecycle ordering (pin → stage → validate → publish → admit → unpin → evict); E2E for single-transition whole-topic eviction and atomic deletion cleanup |
| Authoritative deletion invalidation | **Deferred**; §4.9 itself routes demonstration to Phase 6 candidate acceptance | Future: E2E deletion-cleanup invalidation before any join/operation |
| Viewport trim anchor | **Deferred**; requires implementation | Future: component/E2E anchor stability + pixel-offset restoration using §4.8 metrics |
| Scroll retention index | **Deferred** | Future: unit tests for TTL/LRU index logic and rebuild-from-keys; startup/write enforcement observable per §4.8 |
| ContentSearch bounded overflow | **Deferred** | Future: component/E2E for bounded descriptor block, rescan-on-out-of-block navigation, generation invalidation |
| Pinned exception explicit | **Partial**: working-set measurement aspect conceptually aligned with C-02 heap/logical sampling but current C-02 covers one synthetic profile only; behavioral never-evicted-under-pressure verification needs implementation | Future: separate working-set aggregation measurement (per §4.8) plus behavioral E2E |
| Cache invalidation rules (general) | Composite of viewport trim / scroll retention index / ContentSearch overflow / context-info invalidation per §4.5–§4.6, plus generation invalidation; availability follows those constituent surfaces | Future surfaces follow constituents |
| Cache-miss path measurability & calibration | **Partially available**: C-01/C-02 provide observability primitives (logical bytes, heap-amplification ratio, gate-reason classifications); full §4.8 metric set requires implementation instrumentation | Future: remaining §4.8 metrics implemented and exercised alongside the constituent criteria above |
| Non-claim | Documentation-level statements already present in §4.5 note, §4.12, §4.13; no runtime demonstration required | None required |

#### 4.10 Dependencies and open decisions deferred to later phases/governance

| Dependency / open decision | Phase / governance | Relation to Phase 4 |
|---|---|---|
| Windowed/semantic read and cache-join contract design (R-02..R-06; replaces full-topic fetch where window/closure suffices) | **Phase 5 owns R-02..R-06 windowed/semantic read and cache-join contract design; Phase 6 candidate slices own any implementation**; incremental/delta is **excluded from Phase 5 and deferred to Phase 6/future decision without generation authority cursor** | Phase 4 rebuild path is intentionally staged same-generation full-topic until Phase 5 contract validated; Phase 4 does not prescribe pagination interfaces or payload addition. |
| Active/pinned working-set bounds | **Phase 6 plus queue/stream governance** | Phase 4 excludes the working set from caps and **measures it**; keeps total-memory non-claim. Bounding it requires windowed/semantic reads and possibly global queue/stream caps that cross IPC/persistence boundaries and need explicit Phase 6/governance decision. |
| Global request/stream queue cap | **Phase 6 / governance** (no global cap currently) | Current throttle 100/5 min is observed; any new global cap is deferred and requires IPC/persistence review if implemented; **active/pinned bounding remains Phase 6/governance**. |
| Logical retained payload calibration plus separately recorded heap-amplification ratio | **Phase 4 calibration track** (pre-implementation) | Must complete before implementation of B-02 enforcement; validates **canonical encoding (UTF-8 bytes of canonical JSON per B-02)** and records **heap-amplification ratio separately**. First synthetic run record appended as **§4.13** (2026-08-22, directional/non-adoption; C-02 clean-state, C-01 dirty-worktree with dirtiness limited to the approved documentation edits) — the gate itself remains Open pending retained-payload-distribution calibration and §4.9 acceptance validation. |
| Viewport windowing larger than 200 groups (user-visible history) | **Phase 5** (virtualized window joins) | Phase 4 viewport is a view-window cap, not a data-window; full conversation history remains in entity projection until evicted or windowed by Phase 5. |
| Index/query, FTS deduplication, file dual-state, sync metadata | **Phase 6 / Phase 8 / ADRs** (M1–M8, `sqlite-migration.md`) | Unchanged; Phase 4 does not modify schema, indexes, or sync concerns. |

#### 4.11 Sync and governance review

Phase 4 reviewed against ARCH-005 sync-ready properties and governance boundaries:

| ARCH-005 property | Phase 4 contribution | Status |
|---|---|---|
| Clear authority boundaries | Reaffirms Main SQLite authority; renderer projections tiered as disposable (§4.4) | Preserved |
| Stable IDs | No ID changes; topic/message/block IDs remain the boundary model | Preserved |
| Typed explicit commands | No new IPC channels; rebuild uses existing typed full-topic fetch | Preserved |
| Atomic/idempotent mutations | No mutation changes; eviction is renderer-local and never mutates authority | Preserved |
| Deterministic ordering | No ordering changes; `sort_order` unchanged | Preserved |
| Stable/final checkpoints | No checkpoint changes; eviction never affects persistence | Preserved |
| Disposable projections | Entity and derived projections explicitly disposable; whole-topic atomic eviction and full-topic rebuild | Established (documentary) |
| Bounded caches | **Evictable caches strictly bounded (§4.5–§4.6); active/pinned working set measured but not yet bounded** | Design complete; implementation pending; total memory not claimed bounded |
| Device-local-state separation | Scroll snapshots and viewport identified as device-local; bounds are local-only | Preserved and bounded |

**Governance prohibitions preserved**: No sync schema, metadata, tombstone, conflict engine, vendor adapter, transport, account/E2EE/attachment decision, or production sync path is introduced (ARCH-006). No context-window semantics are changed — `contextCount` null (unlimited), stable anchor-to-end behavior, and `context-window.md` authority remain unchanged. No schema, migration, IPC, preload, identity/compatibility, release/platform, or native/multi-window changes are introduced (§10.1).

#### 4.12 Rollback, non-claims, and exit wording

**Rollback**: Phase 4 is documentation only. **Current documentation rollback is reverting this document to its pre-Phase 4 state.** No code, schema, IPC, storage, or `architecture.md` change to revert. **Future implementation rollback** (if Phase 4 were implemented) will be rollback-bounded by **removing component/composite completeness markers, generation/accounting/admission bookkeeping, eviction/TTL/LRU/B-05 enforcement, viewport 200-group trim/anchor logic, scroll retention index/TTL/LRU/deletion hooks, ContentSearch descriptor chunk/rescan logic, context-info invalidation hooks, and authoritative-deletion projection cleanup; restoring pre-Phase 4 unbounded projection/window/search/scroll behavior** while **preserving authoritative Main SQLite data and existing `context-window.md` / request-stream semantics**; no authority/data migration is involved.

**Non-claims**:
- This design study does not implement retention/eviction, does not modify `architecture.md`, does not change IPC/pagination/sync, does not close Phase 4 exit, and does not alter, reopen, or retroactively own the already-closed Phase 3 exit (Closed 2026-08-21).
- PERF-TOPIC-SWITCH and PERF-ECHO remain Open with no committed numeric threshold; six L3 measurements remain directional only.
- Capacity defaults (§4.5) are not performance acceptance thresholds, not validated baselines, and not root-cause claims.
- Renderer total memory boundedness is not claimed; only evictable caches are bounded.
- Undo 50 and streaming throttle 100/5 min are observed current bounds, not newly implemented policy.

**Exit wording (pending)**:

> Phase 4 design study is **complete** (2026-08-20) — **design complete, not exit**. The cache/memory model (§4.1–§4.11) is internally coherent and executable pending calibration and implementation. **Phase 4 exit remains Open** pending: (1) **logical retained payload calibration plus separately recorded heap-amplification ratio** and B-01/B-02 capacity-default calibration before implementation authorization; (2) downstream **Phase 6/governance decisions needed for active/pinned total working-set bounds** (active/pinned bounding remains **Phase 6 plus queue/stream governance**, not Phase 5; Phase 5 owns **R-02..R-06 windowed/semantic read and cache-join contract design**, Phase 6 candidate slices own any implementation; **incremental/delta is excluded from Phase 5 and deferred to Phase 6/future decision without generation authority cursor**); (3) memory acceptance criteria validation per §4.9 demonstrating bounded evictable caches, explicit pinned exception with measured working set, cache invalidation rules (including authoritative-deletion cleanup and staged same-generation publication with no mixed-generation cache joins and canonical logical-byte accounting), and cache-miss path measurability. **Phase 6 implementation is not a prerequisite for Phase 4 design completion; exit acceptance is distinct from design completion.**

#### 4.13 Calibration evidence record — C-01/C-02 (2026-08-22, measurement-only, directional, non-adoption; C-02 clean-state, C-01 documented-dirty)

> **Scope of this record**: This is the first retained execution record of the already-approved Phase 4 C-01/C-02 calibration harnesses. The retained C-02 record is clean-state (`dirty=false`). The retained C-01 record was produced on a worktree whose dirtiness (`dirty=true`) is limited to the two approved documentation edits themselves (this document and `performance-measurement.md`); it is therefore **not** clean-state evidence. This record documents provenance and directional outputs only. It is **synthetic, measurement-only evidence** and is explicitly **not**: a threshold, a baseline, a capacity policy, a cache bound, an eviction-policy selection, a B-01/B-02 capacity-default adoption, Phase 4 exit, Phase 5 exit, or Phase 6 authorization (ARCH-009..ARCH-012; LOCK-P5-001..005 unaffected).

**Provenance**: Both runs are on HEAD `52bbfbf124417a7c699c6c89c0ec718185517c96`. **C-02** ran on a clean worktree (`dirty=false`, verified clean before, during, and after the run). **C-01**'s retained artifact records `dirty=true`: the only uncommitted changes at its run time were the two approved documentation edits (this document and `performance-measurement.md`), which touch no measured code path — the C-01 artifact is accordingly recorded as dirty-worktree evidence, not clean-state evidence. Host toolchain pinned: Node v24.11.1 / pnpm 10.27.0. Artifacts are gitignored local evidence under `test-results/bench-results/` per `performance-measurement.md` §4; values below are quoted for traceability, not adopted.

| Run | Command | Lane | Exit | Artifact | Environment (artifact-recorded) |
|---|---|---|---|---|---|
| C-01 logical payload calibration | `pnpm bench:logical-payload` | Node (ABI 137), self-ensured | 0 | `logical-retained-payload-calibration-20260822-084106.335.json` | node v24.11.1, pnpm 10.27.0, abiLane node/137, commit `52bbfbf12…`, dirty=true (dirtiness limited to the two approved documentation edits) |
| Fresh production build (C-02 prerequisite) | `pnpm build` | Electron (ABI 145) | 0 | — | electron lane, self-ensured |
| C-02 renderer heap calibration E2E | `C02_HEAP_CALIBRATION=1 pnpm test:e2e -- tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts` | Electron (ABI 145), fresh build, fixture adds `--enable-precise-memory-info --js-flags=--expose-gc` | 0 (1 passed) | `chatdb-c02-renderer-heap-e2e-20260822-083152.967.json` | pnpm 10.27.0, abiLane electron/145, commit `52bbfbf12…`, dirty=false; recorded `node v24.14.1` is the Electron-bundled runtime inside the measured app (spec-design override of the runner Node; ABI 145 hard-gated) |

**Directional outputs (not adopted)**:

- **C-01** (`logical-retained-payload-calibration`, synthetic profiles): count-first profile 9 topics / aggregate 145,575 bytes → binding `count-first`; byte-first profile 4 topics / aggregate 37,229,968 bytes (35.51 MiB) → binding `byte-first`; oversized single-topic profile 41,734,523 bytes (39.80 MiB) → `oversized=true` (B-05 classification against the 32 MiB candidate); combined 14 topics / 79,110,066 bytes. All correctness gates passed (canonical encoding invariants — lexicographic keys, compact JSON, byte length, determinism; orphan rejection; non-finite/unsupported value rejection).
- **C-02** (`chatdb-c02-renderer-heap-e2e`, synthetic profile 2 topics × 100 msgs × 2048 B block content, production build, real renderer process via `performance.memory`, precise mode): canonical logical bytes = 505,990 (`phase4-logical-payload-v1`); heap delta = 67,266,046 bytes (precise, informative); deltaRatio ≈ 132.94; absoluteRatio ≈ 319.08; all L1 gates passed including final-topic-owned `#messages` production DOM proof and authoritative `calibration.complete=1`. Heap-amplification ratio is recorded **separately** from B-02 logical bytes, never conflated.
- **Prior dirty artifact excluded**: `chatdb-c02-renderer-heap-e2e-20260821-211912.099.json` was produced on a dirty worktree tied to the parent commit and is **not** clean-state evidence; it remains unadopted diagnostic history.

**Why Phase 4/5 exits remain Open despite this record**: The §4.9/§4.10 calibration gate requires calibration of the B-01/B-02 capacity defaults **against the retained-payload distribution** plus implementation acceptance validation per §4.9 (bounded evictable caches under exercised workload, staged same-generation publication, eviction-order verification) and downstream Phase 6/governance working-set decisions. One synthetic single-machine run demonstrates harness correctness and provides directional ratios only; it does not satisfy those gates. No capacity default is calibrated into policy by this record.

### Phase 5: Data-Access Contract

**Status**: **Design study complete (2026-08-20) — documentation only; exit Open (pending gates in §5.12–§5.13). No implementation authorized.** Bounded study record in §5.13 (2026-08-21, LOCK-P5-001..005).
**Entry criteria**: Phase 1 complete; Phase 2 ownership/lifecycle complete (2026-08-19); Phase 4 bounded-memory design complete (2026-08-20) as beneficial input; explicit approval. Entry satisfied — Phase 2 and Phase 4 designs are complete documentation. DB-health diagnostics (M1/M2/M3/M7) are independent on-demand diagnostics and do not gate this design phase. M4/M5/M6 remain governance-gated and are not activated by this program.
**Content**: Define the data-access contract: stable-ID-anchored windowed read intents, deterministic `sort_order`→`id` return ordering, completeness semantics (whole-topic / window / message-answer-group / context closure), renderer-local generation applicability, separate viewport vs context projections, and mutation/stream/cache rules. This phase is **design/documentation only** — no implementation, code, schema, IPC, pagination implementation, sync metadata, or `architecture.md` current-reality edits are authorized.
**Exit criteria**: Documented data-access contract (§5.1–§5.13) with read intents, response guarantees, completeness types, lifecycle/state machine, semantic matrix, context contract, mutation/stream/cache rules, error/retry/concurrency, observability/L1/L3 plan, decision triggers/non-goals, sync review, and bounded study record (§5.13); validated by topic-switch and context acceptance criteria design (not measured). Exit not claimed — see §5.12–§5.13.
**Dependencies**: Phase 2 complete; Phase 4 complete (capacity defaults and evictable/pinned tiering are authoritative inputs). Benefits from Phase 3 stable-host work for viewport projection stability. No new dependency on Phase 6; Phase 6 is downstream.
**DB-health sequencing**: M1/M2/M3/M7 are independent read-only diagnostics that can run on demand and do not gate this design. Full-topic/windowed fetch/cache-join target semantics are defined here at contract level; implementation is Phase 6 candidate. M4/M5/M6 require governance/ADR and are not activated by this program.

#### 5.1 Design constraints for this phase

| Design constraint | Statement | Effect in this document |
|---|---|---|
| Design/documentation only | Phase 5 is design and documentation only. No implementation, code, schema, IPC implementation, pagination code, sync metadata, or `architecture.md` current-reality edits are authorized. | Phase 5 delivers a contract-level design without code change; `architecture.md` remains implemented reality only (§1.3, ARCH-008). All read intents and response guarantees are **target contracts**, not implemented interfaces. |
| Main SQLite remains sole chat authority | Authoritative chat data remains in Main SQLite; renderer state remains disposable projection (ARCH-007). | All reads are authority-served via typed IPC; projections rebuild from authority; no second authority is introduced (§5.4, §5.8). |
| Stable-ID anchoring; deterministic order; no tuple-cursor safety claim | Query intent is anchored by **stable IDs** (topic/message) — not by tuple cursors. Deterministic return order is **`sort_order` then `id`**. Do not claim long-lived `(sort_order, id)` tuple-cursor safety, authority revision/snapshot, cross-request snapshot, or linearizability. | Read intents use stable-ID anchors (§5.4). Ordering guarantee is intra-response deterministic sort (§5.4). Dense `sort_order` is explicitly acknowledged as rewritten by middle insert/delete/reorder, so old tuple cursors are not stable across mutations. No revision, snapshot, or linearizability invariant is defined. |
| Completeness is semantic, not implicit | Completeness has **semantic types**: `whole-topic`, `window`, `message/answer-group`, and `context closure`. A partial projection never masquerades as complete; empty topics require explicit completeness. | Completeness matrix in §5.3/§5.6; every response carries typed completeness; Phase 4 whole-topic completeness is one of four types, not the only type. |
| Renderer-local tokens are applicability only | Renderer-local **generation** and **request tokens** establish **applicability** of a projection/response to current UI state — not authority versions, not revision numbers, not sync metadata. | Tokens defined in §5.3/§5.5; they gate stale-response discard and generation invalidation only; no authority version claim. |
| Viewport and context are separate projections | Viewport and context read models are **separate disposable projections** over the same authority. Context preserves stable **anchor-to-end** (**for an already anchored topic, anchor through newest independent of current `contextCount`; `contextCount` is initialization/re-anchor provenance only**, §5.4/§5.7), **`contextCount=null` (unlimited at initialization/re-anchor)**, and **exactly-once repair** semantics; unlimited context may enlarge pinned working set and must be **measured, not truncated**. | Separation in §5.7; context repair and unlimited-context measurement defined there; viewport cap (200 groups, Phase 4 B-06) does not truncate context. |
| Authority-aware target actions are contract-only | Target actions: Main resolves **complete answer group** for selection; branch/clone/edit positioning uses **stable authority-side anchors**; search-hit navigation uses **around-message window**. These are **target contracts only** and **trigger coordinated IPC review** before any implementation. | Defined in §5.8; no IPC payload/schema specifics beyond contract-level target intents; implementation requires coordinated shared-contract review (see §5.11). |
| Streams pinned; mutation granularity | Topic streams remain **independent and pinned while in flight**. **Structural mutations** (insert/delete/reorder affecting ordering) invalidate/progress local projection generation; **content-only block updates** do not invalidate ordering coverage. | Rules in §5.8; ties to Phase 4 pin matrix and Phase 2 stream independence. |
| Phase 4 defaults unchanged | Phase 4 capacity numbers (B-01 8 topics, B-02 32 MiB logical, 30-min TTL, 200-group viewport, 256-scroll, 500 Range, etc.) remain **architecture capacity defaults requiring calibration**, not thresholds/baselines. | Referenced as authoritative inputs in §5.8/§5.10; not recast as thresholds. |
| No concurrency cap selected | Same-topic **identical reads may single-flight**; same-topic **window reads serialize**; **no global request cap** is selected by this contract. | Concurrency in §5.9; no global cap, no per-process queue cap claimed. |
| Exit remains Open | Phase 5 design study may be marked **complete**, but **Phase 5 exit remains Open**; Phase 3 is **structurally Closed 2026-08-21** (ARCH-009/ARCH-010), Phase 4 exit remains **Open** for independent calibration/implementation gates; PERF-TOPIC-SWITCH and PERF-ECHO reclassified as independent post-refactor workstreams and remain **Open (non-blocking, ARCH-011)**; Phase 6 remains **unauthorized**. | Exit gates in §5.12; no threshold/performance closure claimed; 4df885d appended alongside bfc1c617 as directional L3 (ARCH-012). |
| No unsupported claims | Do not claim `listByTopicPage` is sufficient under concurrent dense-order mutation; do not claim revision/tombstone/sync metadata, snapshot, or baseline. | Non-claims in §5.12; existing page path (if any) is not validated as safe under concurrent reorder. |

#### 5.2 Current-state inventory (observed structure — current reality, not target)

| Aspect | Current observed structure | Evidence / location | Label |
|---|---|---|---|
| Topic load path | `loadTopicMessagesThunk` → `dbService.fetchMessages` → typed IPC → `ChatDbAggregateService.fetchMessages` **one Main transaction** invoking `MessagesRepository.listByTopic` / `BlocksRepository.listByMessages` → renderer **whole-topic** projection | `loadTopicMessagesThunk`, `dbService.fetchMessages`, `ChatDbAggregateService.fetchMessages` with `MessagesRepository.listByTopic` / `BlocksRepository.listByMessages` | Current data path — whole-topic only |
| Projection handling | Render store holds the fetched whole-topic projection as the single source for viewport, context, and display groups; no windowed/incremental/replacement path exists | Redux topic `messages`/`blocks`/`segments`; `createLatestMessageWindow`, `computeContextInfo`, display grouping | Current — full projection assumed |
| Consumer assumption | Viewport windowing, context-info computation, and message-group rendering **assume a complete whole-topic projection is resident**; cache-miss join for context is not defined because miss is whole-topic until Phase 4 completeness marker | `computeContextInfo` on `[topic messages, topic blocks, assistant, topic id]`; `reconcileMessageWindow` history/live layers | Current — full-projection consumers |
| Ordering artifact | Dense `sort_order` is **rewritten** by middle insert (`insertAt`/`insertManyAt` shift), delete, and explicit reorder; ordering is `sort_order` then `id` within a single transaction response but **not stable across mutations** for old tuple cursors | `MessagesRepository.ts` `insertAt`/`insertManyAt`/`replaceOrder`; debt registry §4.3 | Current — deterministic intra-response order, unstable cross-mutation cursor |
| Revision / snapshot | **No authority revision, snapshot, or linearizability** exists for chat reads; each typed IPC fetch is an independent transaction; no cross-request snapshot is provided | SQLite transaction per fetch; no revision column or snapshot token in current IPC | Current — no revision/snapshot |
| Windowed fetch | **No windowed/paginated fetch** for visible messages only; no `around-anchor` or `around-message` window; no stable-ID-anchored paging contract | Absence in `dbService.fetchMessages`; §4.3 debt registry | Current — not windowed |
| Context join | Context anchor-to-end is computed **in renderer** from the whole-topic projection; no authority-side context closure window exists | `computeContextInfo`; `context-window.md` anchor semantics | Current — renderer-computed |
| Empty topics | Empty topics are representable (zero messages/blocks) but **completeness is inferred from cached IDs** (`cachedIds.length > 0` early-return) — not from an explicit empty-topic completeness marker | `loadTopicMessagesThunk` early-return | Current — implicit, not contract-satisfying (§4.2/§4.7 future contract) |
| Error / concurrency | Failures surface per-fetch; no single-flight or serialize contract is enforced at data-access layer; request tokens are renderer-local applicability only | Current thunk/IPC flow; Phase 4 §4.7 notes no automatic retry | Current — per-fetch, no coalescing guarantee |

Target state for each row is defined in §5.3–§5.10; current vs. target is explicitly labeled here.

#### 5.3 Terminology and completeness (Phase 5 scope)

**Base terms** (Phase 4 lineage preserved):

| Term | Definition |
|---|---|
| **Authoritative state** | Chat messages/blocks/topics persisted in **Main SQLite**; single source of truth via typed IPC (ARCH-007). |
| **Renderer entity projection** | Redux `messages`/`blocks`/`segments` derived from authority; **disposable and rebuildable**; never authoritative. |
| **Resident projection** | An entity projection currently held in renderer for a topic, with renderer-local **completeness marker, generation, and logical-bytes accounting** (no IPC/schema versioning). |
| **Generation (renderer-local)** | Monotonic renderer-local **applicability marker** per resident topic; advanced on structural mutations or invalidation; used to discard stale responses — **not an authority revision**. |
| **Request token (renderer-local)** | Per-fetch token scoped to one typed IPC read; establishes **applicability** of that response to the generation that issued it; **not an authority version**. |
| **Stable-ID anchor** | A **topic ID** or **message ID** that anchors query intent; anchors are stable across ordering mutations, unlike `(sort_order, id)` tuple cursors. |
| **Deterministic return order** | Within a single authority response, messages are ordered by **`sort_order` then `id`** (lexicographic `id` tie-break). This is the only ordering guarantee; no cross-request stability is claimed for old tuple cursors. |

**Component completeness composition (Phase 4 lineage; resident admission requires both components for same generation):**

| Component | Definition |
|---|---|
| **Chat-data completeness** | **Component completeness** for chat data: **complete ordered messages + all referenced blocks** for the topic/generation (ordering `sort_order`→`id`, references validated). For an empty topic, an **explicit empty chat-data marker** is required — zero entities without the marker is not complete. This is a **staging/component marker**; it **does not satisfy** any consumer expecting R-01 `whole-topic` completeness. The current `dbService.fetchMessages` (messages/blocks only) supplies **only this component** and does not satisfy R-01 `whole-topic` on its own. |
| **Segment completeness** | **Component completeness** for topic segments: **complete segment projection** for the topic/generation (stable segment order/id, references validated). For a topic with no segments, an **explicit empty segment marker** is required. This is a **staging/component marker**; it **does not satisfy** any consumer expecting R-01 `whole-topic` completeness. Current separate/unawaited segment load supplies **only this component** and does not satisfy R-01 `whole-topic` on its own. **Segment completeness is not required for R-02..R-06 unless a specified consumer explicitly joins segment state**; this does not let a `window`/`answer-group`/`context closure` projection satisfy R-01. |
| **Resident-topic completeness** | **Composite completeness = chat-data completeness AND segment completeness for the same renderer applicability generation**, including explicit empty markers where applicable. This composite **is R-01 `whole-topic` completeness** — the two names denote the same semantic `whole-topic` (chat-data ∧ segment for same generation, jointly validated and published atomically in one renderer state transition). Neither component alone satisfies `whole-topic`/resident admission. Target staged same-generation publication (pin; stage chat-data + segment-data for same generation; await both; validate IDs/references/generation together; compute canonical logical bytes per Phase 4 B-02 exact frame `phase4-logical-payload-v1`; publish in one transition; discard on failure/mismatch — §4.2/§4.7) establishes both components atomically; **no mixed-generation cache joins; no new R intent for bare component reads**. Current `dbService.fetchMessages` (messages/blocks only) plus separate/unawaited segment load **does not satisfy target resident/`whole-topic` completeness**. Coordinated separate reads or a future coordinated payload are permitted **subject to Phase 5/6 contract review and §10.1 IPC gate — no prescription that segments must be added to the existing `fetchMessages` IPC payload**. **Renderer generation remains applicability/stale-rejection only, never authority version/cursor.** |

**Completeness types** — semantic, not implicit; a partial projection never masquerades as complete. Component completeness above is the **admission composition**; the types below are the **semantic completeness consumers declare**. `whole-topic` as a semantic type is **resident-topic completeness** (chat-data + segment for same generation) — not chat-data alone:

| Completeness type | Meaning | Resident marker | When it is complete |
|---|---|---|---|
| **`whole-topic`** | The **entire topic** (all messages/blocks/segments for the topic) for the recorded generation is resident; the projection can serve any consumer without further fetch. This is **resident-topic completeness** (chat-data + segment for same generation) — not chat-data alone. | `whole-topic` marker + full entity sets (messages/blocks **and** segments) for generation; **empty-topic marker** (zero entities on both sides + explicit empty completeness for each component) counts as `whole-topic` complete | Fetch returned all entities (both components validated for same generation; canonical logical bytes computed; single-transition publication) or topic is explicitly empty on both sides; Phase 4 resident-topic marker is this type |
| **`window`** | A **contiguous ordered window** over the topic's deterministic order is resident. Coverage is **bounded** (e.g., latest N, around-anchor, around-message). Window completeness means **the window's declared range is fully present** — not that the topic is fully present. | `window` marker with `{ anchorId, direction, count, bounds }` and ordered entities covering exactly that window for generation | Window read returned its declared range; bounds are explicit (e.g., head/tail of topic or anchor neighborhood) |
| **`message / answer-group`** | The **complete answer group** (all messages sharing a selection group) for a given message ID is resident, resolved **authoritatively** (Main). This is not a rendered run — it is the authority-resolved group. | `answer-group` marker with `{ groupId/anchorMessageId, memberIds[] }` for generation | Group resolution returned all members from authority; used for selection/branch targets |
| **`context closure`** | The **anchor-to-end context range** required for request building is resident, per `context-window.md` stable anchor-to-end semantics — **for an already anchored topic, coverage is the persisted stable anchor through newest, independent of current `contextCount`** (see §5.4 R-06). Closure completeness means the **closed range from stable anchor through newest message** is present — not a truncated prefix. | `context-closure` marker with `{ anchorId, endId, closureBounds }` for generation (`contextCount` appears only as **initialization/re-anchor provenance**, not as a per-read bound or ordinary cache key) | Closure read returned the full anchor-to-end range (or full topic when `contextCount=null` at initialization/re-anchor); measured, not truncated |

**Completeness invariants**:

- Every authority response carries an **explicit typed completeness** (`whole-topic` | `window` | `answer-group` | `context closure`) — **absence of completeness is not completeness**.
- `whole-topic` and `window` are disjoint: a `window` never satisfies a `whole-topic` consumer; consumers must declare which completeness they require.
- **Component composition**: `whole-topic` (resident-topic) completeness requires **both chat-data AND segment completeness for the same generation** (including empty markers); chat-data alone is not `whole-topic`. **Segment completeness is not required for `window`/`answer-group`/`context closure` consumers unless the consumer actually joins segment state.**
- **Staged same-generation publication**: target resident admission **stages chat-data and segment-data for the same generation, awaits both, validates IDs/references/generation together, computes canonical logical bytes, and publishes in one renderer transition**; if either load fails or generation mismatches, **all staged data is discarded and no new markers/accounting are published**; prior entry preserved/invalidated per prior generation only; **no mixed-generation cache joins**.
- **Whole-topic containment vs. semantic derivation**: `whole-topic` (resident-topic) completeness means **all rows for both components** for the topic/generation are resident. Containment alone **does not** imply `answer-group` or `context closure` completeness. A consumer requiring `answer-group` or `context closure` may reuse a resident `whole-topic` **only after** the required complete semantic closure (authority-resolved group member set for `answer-group`; anchor-to-end validated closure for `context closure`) is **derived and validated** from that resident `whole-topic` for the same generation. A generic `whole-topic` label never implicitly satisfies a typed semantic consumer.
- **Empty topics require explicit `whole-topic` empty completeness (both components).** Residence with zero entities without an explicit empty marker for each component is **not** complete.
- **Authoritative deletion**: authoritative deletion (hard delete/final purge/empty-trash/assistant reset) **invalidates every completeness type** for affected topics and **rejects/disposes stale generation before any further join/action**; no deleted projection may satisfy R-01..R-06; **soft-delete/trash preserves completeness for restore** unless ordinary pressure evicts (see §4.6 deletion cleanup; Phase 6 candidate acceptance notes authoritative-deletion invalidation).
- **No revision/snapshot claim**: completeness is per-generation applicability, not an authority revision or snapshot; cross-request snapshot and linearizability are **not** provided.

#### 5.4 Read intents and response guarantees

**Intent taxonomy (contract-level targets — not implemented IPC shapes):**

| # | Read intent (target) | Anchor | Coverage target | Completeness produced | Counting unit (one per intent) | Intended consumers |
|---|---|---|---|---|---|
| R-01 | **Whole-topic load** — semantic `whole-topic` read intent (legacy compat) | `topicId` | Entire topic — **chat-data component** (complete ordered messages + all referenced blocks) **and segment component** (complete topic segments) for same renderer applicability generation (explicit empty components included, jointly validated and published atomically); existing `dbService.fetchMessages` supplies only the chat-data component; current separate segment load does not satisfy R-01 because unawaited/uncoordinated | `whole-topic` (or explicit empty `whole-topic`) — **R-01 produces only semantic `whole-topic` (or explicit empty `whole-topic`), never bare `chat-data`**; bare component reads are implementation staging details, not new R intents; `chat-data completeness` and `segment completeness` are component/staging markers and may not satisfy any consumer expecting `whole-topic` | **messages** plus referenced blocks/segments — authority order `sort_order` → `id` (messages), canonical B-02 exact frame ordering for blocks/segments | Consumers requiring full topic (`chat-data` ∧ `segment` for same generation); retained as fallback/compat until windowed consumers proven; segment completeness not required for R-02..R-06 unless consumer explicitly joins segment state and does not let that projection satisfy R-01 |
| R-02 | **Latest window** | `topicId` | Latest N in deterministic order | `window` (latest N, bounded) | **complete rendered/message groups** | Viewport bootstrap / bottom-anchored display |
| R-03 | **Window around stable anchor** | `anchorMessageId` (stable) | Neighborhood of anchor (e.g., ±K around anchor in `sort_order`→`id` order) | `window` (around anchor) | **complete rendered/message groups** | Viewport expansion, history scrolling, load-more |
| R-04 | **Window around message** (search-hit) | `hitMessageId` (stable) | Around the hit message (search navigation) | `window` (around message) | **complete rendered/message groups** | Search-hit navigation (see §5.8 authority-aware action) |
| R-05 | **Answer-group window** | `messageId` / `groupId` | All members of the answer group containing the message, authority-resolved | `answer-group` | **messages in complete answer-group** — group members returned in `sort_order` → `id` order | Answer selection, branch/clone positioning |
| R-06 | **Context closure** | `anchorMessageId` (persisted stable renderer-owned anchor) | **Anchor-to-end** closed range per `context-window.md` — **stable anchor through newest, independent of current `contextCount`** | `context closure` | **complete context turns** — anchor-to-end turns; authority rows returned in `sort_order` → `id` order | Request context building (separate from viewport; context turns, not viewport groups) |

All intents are **stable-ID-anchored**; no intent uses a long-lived `(sort_order, id)` tuple cursor as an anchor. Every intent defines exactly one counting unit as shown: viewport bounds (R-02/R-03/R-04) count in **complete rendered/message groups**, context (R-06) counts in **complete context turns**, and answer-group (R-05) and whole-topic (R-01) count in **messages**; in all cases the authority return order remains **`sort_order` then `id`**. Incremental delta (former R-07) used renderer generation as an authority delta cursor and is **removed from the Phase 5 contract**; any future incremental/delta mechanism is **deferred to Phase 6** without renderer-generation-based authority deltas (generation remains applicability-only, §5.5).

**R-06 / context closure — anchor ownership and `contextCount` scope (normative)**: the context anchor (`contextWindowAnchor` and derived stable group-key anchor) remains **renderer-owned assistant settings** per `context-window.md`. For an **already anchored topic**, R-06 coverage is the **persisted renderer-owned stable anchor through newest, independent of current `contextCount`**. `contextCount` is consulted **only during renderer-side initialization or explicit re-anchor** per `context-window.md`; **changing `contextCount` alone does not resize, invalidate, or re-anchor an existing context closure**. `contextCount` may appear **only as initialization/re-anchor provenance**, never as a per-read bound, ordinary R-06 request input, or ordinary closure cache key. The renderer determines `anchorMessageId` (stable anchor) and performs exactly-once repair after projection load if the anchor is missing. Main **reads authoritative chat rows** to serve the closure for the supplied anchor but **never owns or repairs the anchor** — no new Main context-anchor repair API is introduced.

**Per-intent response guarantees (and explicit non-guarantees):**

| Concern | Guarantee | Non-guarantee (explicit) |
|---|---|---|
| **Anchoring** | Intent is anchored by **stable IDs** (`topicId`, `anchorMessageId`, `hitMessageId`). Anchor IDs are stable across dense-order rewrites. | Tuple cursors `(sort_order, id)` are **not** stable anchors across middle insert/delete/reorder; do not carry a cursor across mutations and expect it to remain valid. |
| **Ordering** | Each response is deterministically ordered by **`sort_order` then `id`** within that single authority transaction. | No guarantee that a previous `sort_order` value remains valid after a later structural mutation; no cross-request snapshot ordering. |
| **Completeness** | Each response carries **typed completeness** (§5.3). `window` responses declare their **bounds**; `answer-group` responses declare **member set**; `context closure` declares **anchor-to-end bounds**. Empty topics carry **explicit empty completeness**. | A `window` never masquerades as `whole-topic`; a `window` missing its declared bounds is **incomplete**. A generic `whole-topic` label never implicitly satisfies `answer-group`/`context closure` — the required semantic closure must be derived and validated for the same generation (§5.3). |
| **Counting unit** | Each intent defines exactly one counting unit (§5.4): R-02/R-03/R-04 in **complete rendered/message groups**, R-06 in **complete context turns**, R-01/R-05 in **messages**; authority return order is `sort_order` → `id` for all. | Counting units are not interchangeable; viewport group counts do not satisfy context turn counts and vice versa. |
| **Authority / revision** | Responses are the result of **one Main transaction** (authority read). | **No authority revision**, **no cross-request snapshot**, **no linearizability** across multiple reads. Two successive reads may reflect different authority states without a revision to correlate them. |
| **Renderer applicability** | Every response is tagged with the **renderer-local request token / generation** that issued it; applicability is checked on return (stale generation → discard). Generation is **applicability-only** and **cannot be used as a `fromGeneration` cursor to request authority deltas** (§5.4). | Tokens are **not authority versions** and do not establish a total order across topics; cross-topic generation comparison is meaningless; generation-based delta requests are not supported. |
| **Empty / absent** | Absent topic or deleted anchor yields an **explicit not-found / anchor-missing** signal, not an empty window. Empty topic yields **empty-topic completeness**, not a miss. | Not-found is not an empty window; callers must handle anchor-missing as a distinct case (e.g., fallback to latest window). |
| **Bounds for R-02/R-03/R-04** | `Latest N` bounds are `[tail-N, tail]`; `around anchor/message` bounds are anchor ± count within deterministic order, clamped to topic head/tail. Bounds are **declared** in the response so callers can reason about coverage without assuming whole-topic. Counting unit for these bounds is **complete rendered/message groups**; authority rows within remain ordered `sort_order` → `id`. | Bounds are **per-response**, not a durable cursor for future paging; carrying forward an old `(sort_order, id)` to page further after a structural mutation is **not safe** — re-anchor by stable ID. |
| **`listByTopicPage` note** | Existing paginated helper (if present) is a **current implementation detail**; its behavior under concurrent dense-order mutation is **not validated as a contract** here. | **No claim** that `listByTopicPage` is sufficient under concurrent dense-order mutation is made by this contract. |

**Cache-join semantics (read-path):**

- **Viewport path**: viewport read prefers an already-resident `window` whose declared bounds **fully cover** the requested range for the current generation and whose **complete rendered/message group** count matches the requested bounds; otherwise it issues the appropriate window intent (R-02/R-03/R-04). Viewport never joins across generations. A resident `whole-topic` may satisfy a viewport consumer **only after** the requested window's group closure is derived and validated from that whole-topic for the same generation; the label alone is insufficient (§5.3).
- **Context path**: context reads require `context closure` completeness (complete context turns, anchor-to-end) for the **current stable anchor / generation** — coverage is **anchor through newest for that generation, independent of current `contextCount`**; if resident closure does not cover the declared anchor-to-end bounds, the closure intent (R-06) is issued. **Changing `contextCount` alone does not invalidate a resident closure; `contextCount` is not an ordinary closure cache key** — it is provenance for initialization/re-anchor only (see §5.4 R-06 clarification and §5.7). Context does not reuse viewport `window` coverage unless that window's bounds provably equal the closure bounds — they are **separate projections** (§5.7). A resident `whole-topic` may satisfy a context consumer **only after** the anchor-to-end turn closure is derived and validated for the same generation; the label alone is insufficient.
- **Answer-group path**: group reads require `answer-group` completeness for the target message's group (R-05); viewport `window` coverage alone is never sufficient for group completeness. A resident `whole-topic` may satisfy an answer-group consumer **only after** the authority-resolved group closure is derived and validated for the same generation.

#### 5.5 Lifecycle and state machine

**Resident-topic lifecycle (per topic, renderer-local):**

```
          ┌──────────────┐
          │ Not resident │◄─────────────────────────────────┐
          └──────┬───────┘                                  │
                 │ activation / demand                      │ eviction / TTL /
                 │ (pin first)                              │ invalidated generation
                 ▼                                          │ (atomic whole-topic removal
        ┌───────────────┐   stale token / generation mismatch│  after scroll save; §4.6)
        │   Loading     │───────────────────────────────────┤
        │ (pinned;      │   failure: no complete resident    │
        │  request token │   entry committed; retry is       │
        │  + generation)│   caller-driven idempotent re-issue│
        └──────┬────────┘                                   │
               │ authority response                          │
               │ + typed completeness                        │
               │ + generation recorded                       │
               ▼                                             │
    ┌────────────────────┐  structural mutation               │
    │  Complete (typed)  │  invalidates/progresses generation│
    │  ┌──────────────┐  │───────────────────────────────────┤
    │  │ whole-topic  │  │  content-only block update         │
    │  │ window       │  │  does NOT invalidate ordering      │
    │  │ answer-group │  │  coverage (generation unchanged)   │
    │  │ context      │  │                                   │
    │  │ closure      │  │  same-topic window reads serialize│
    │  └──────────────┘  │  identical reads may single-flight│
    │  pinned while       │                                   │
    │  active/in-flight   │                                   │
    └────────────────────┘                                   │
               │ inactive+settled → lastAccess, unpin,       │
               │ TTL→oversized→LRU enforcement (§4.6)        │
               └─────────────────────────────────────────────┘
```

**Generation / token rules:**

- **Generation** is renderer-local, per-topic, monotonic; advanced on **structural mutations** (insert/delete/reorder affecting ordering), on **authoritative deletion** (hard delete/final purge/empty-trash/assistant reset), and on explicit invalidation. A response whose request token generation does not match the topic's current generation on return is **stale and discarded** (applicability failure, not an authority error) **before any join/action**.
- **Request token** is per-fetch; it carries the generation at issue time plus intent identity. It gates **stale-response discard** and **single-flight identity** only.
- **Content-only block updates** (e.g., block text/status change without reordering) **do not advance generation** and **do not invalidate `window` ordering coverage**; they invalidate only derived content caches for affected members, not window bounds.
- **Structural mutations** advance generation and **invalidate/progress** local `window`/`whole-topic`/`answer-group`/`closure`/`chat-data`/`segment`/`resident-topic` completeness for that topic; retained windows from the old generation are not trusted as complete for the new generation.
- **Authoritative deletion** (hard delete/final purge/empty-trash/assistant reset) **atomically invalidates every completeness type** (`whole-topic`/`window`/`answer-group`/`context closure` and `chat-data`/`segment`/`resident-topic` components) for affected topics, **rejects/disposes any stale generation before any further join/action**, and **removes all resident markers/generation/accounting/topic index/exclusive entities/derived viewport/context/search state and scroll snapshot** in one renderer transition (shared entities referenced by another resident topic remain); **soft-delete/trash preserves completeness for restore** unless ordinary pressure evicts; **no deleted projection may satisfy R-01..R-06**. Bulk deletion identifies affected IDs from the authoritative result or an existing typed capability; if insufficient, contract change routes through §10.1. No implementation is authorized.
- **Completeness is generation-scoped**: a `window` complete for generation G is **not** complete for generation G+1 after a structural mutation or authoritative deletion; **no mixed-generation cache joins**.

#### 5.6 Semantic behavior matrix

Rows = read intents; columns = contract properties. “—” = not applicable. Values are **target contracts**, not implementation claims. Counting unit and completeness derivation per §5.3–§5.4 apply to all rows.

| Intent | Completeness required by consumers | Completeness produced | Order guarantee | Anchor stability | Generation interaction | Cache-join reuse | Authority-aware? |
|---|---|---|---|---|---|---|---|
| R-01 Whole-topic | consumer assumes `whole-topic` (**chat-data ∧ segment for same generation**, explicit empty components included, jointly validated/published atomically) | `whole-topic` / explicit empty `whole-topic` — **semantic `whole-topic` (resident-topic) only, never bare `chat-data`; bare component reads are staging details, not new R intents** | `sort_order`→`id` (single tx) with canonical B-02 exact frame ordering for blocks/segments | topic ID stable | structural mutation invalidates; content-only does not; **renderer generation is applicability/stale-rejection only, never authority version/cursor** | fallback; no join; may satisfy typed consumers **only after** required semantic closure is derived/validated for same generation (§5.3); staged chat-data + segment for same generation (await both, validate together, publish atomically); existing `fetchMessages` alone does not satisfy `whole-topic` | No |
| R-02 Latest window | viewport needs `window` covering latest N | `window` (tail N, bounds declared) | `sort_order`→`id` (single tx) | topic ID stable | new generation → re-anchor latest | viewport prefers resident latest-N window; counting unit = **complete rendered/message groups** | No |
| R-03 Around anchor | viewport needs `window` around anchor | `window` (anchor ±K, bounds declared) | `sort_order`→`id` (single tx) | **anchor message ID stable** | structural mutation → old `window` not trusted; re-anchor by ID | viewport prefers resident covering window; counting unit = **complete rendered/message groups** | No |
| R-04 Around message (search) | navigation needs `window` around hit | `window` (hit ±K, bounds declared) | `sort_order`→`id` (single tx) | **hit message ID stable** | hit deleted → not-found; re-anchor or fallback to latest | separate navigation transaction; counting unit = **complete rendered/message groups** | Yes — search-hit dispatch uses stable ID (see §5.8) |
| R-05 Answer-group | selection needs `answer-group` | `answer-group` (member set declared) | `sort_order`→`id` within group (single tx) | message/group ID stable | structural mutation may change membership → re-resolve from authority | **never satisfied by `window` or generic `whole-topic` label alone**; requires authority-resolved or derived-and-validated closure (§5.3) | **Yes — Main resolves complete group** |
| R-06 Context closure | request needs `context closure` | `context closure` (anchor-to-end, bounds declared — **stable anchor through newest, independent of current `contextCount`**; `contextCount` is **initialization/re-anchor provenance only**, §5.4/§5.7) | `sort_order`→`id` (single tx) | **anchor ID stable (renderer-owned stable anchor through newest, independent of current `contextCount`; §5.4/§5.7)** | structural mutation → closure bounds may shift; re-close; **changing `contextCount` alone does not resize/invalidate/re-anchor**; generation is applicability-only, never an authority delta cursor | **separate from viewport**; no viewport-window reuse unless bounds provably equal; **never satisfied by generic `whole-topic` label alone** — requires derived/validated anchor-to-end closure; counting unit = **complete context turns**; `contextCount` is **not a per-read bound or ordinary cache key**; Main reads rows but does not own/repair anchor | Yes — anchor is `context-window.md` stable anchor (renderer-owned; Main reads rows only) |

Incremental delta (former R-07) used `fromGeneration` as an authority delta cursor; renderer generation is applicability-only and cannot request authority deltas, so it is **removed from the Phase 5 contract and matrices** and **deferred to Phase 6** as a future incremental mechanism without generation-based delta semantics (see §5.4). Phase 5 defines no delta and no `fromGeneration` cursor.

**Matrix invariants (enforced by contract):**

- Every `window` response **declares bounds**; a caller can prove coverage without assuming whole-topic.
- A `window` for generation G **never** satisfies a consumer that requires `whole-topic` or `answer-group`; a generic `whole-topic` label **never** satisfies `answer-group` or `context closure` without the required complete semantic closure being derived and validated for the same generation (§5.3).
- `answer-group` completeness **must be authority-resolved or derived-and-validated from a resident `whole-topic` for the same generation**; renderer-side group inference from a `window` alone is not `answer-group` complete.
- `context closure` completeness is **anchor-to-end validated** (**stable anchor through newest, independent of current `contextCount`**; `contextCount` is **initialization/re-anchor provenance only**, §5.4/§5.7); residence of `whole-topic` rows alone is not `context closure` — the closure must be derived/validated (stable anchor + context turns counted to end) for the same generation; Main reads rows but anchor ownership/repair stays renderer-side (§5.4, §5.7).
- Counting units are invariant: viewport intents (R-02/R-03/R-04) count in **complete rendered/message groups**, context (R-06) counts in **complete context turns**, whole-topic/answer-group count in **messages**; authority return order is always `sort_order` → `id`.
- After a structural mutation, **no retained `window`** from the prior generation is considered covering for any intent — callers must **re-anchor by stable ID** (not by old `sort_order`).

#### 5.7 Context contract — viewport vs. context separation

| Concern | Viewport projection | Context projection |
|---|---|---|
| **Purpose** | User-visible display: display groups, virtualized window, scroll position, navigation anchors | Request building: ordered message/block range fed to the model, governed by `context-window.md` |
| **Read intents** | R-02 / R-03 / R-04 (`latest` / `around anchor` / `around message` windows) | R-06 (`context closure` anchor-to-end) |
| **Completeness type** | `window` (bounded, declared) | `context closure` (closed anchor-to-end, declared) |
| **Counting unit** | **complete rendered/message groups**; authority rows ordered `sort_order` → `id` | **complete context turns**; authority rows ordered `sort_order` → `id` |
| **Capacity interaction** | Viewport groups capped at **200 rendered groups** (Phase 4 B-06) as a **view cap**; trim preserves navigation/scroll anchors; no entity eviction | Context may be **unlimited** when `contextCount=null` **at initialization/re-anchor**; for an already anchored topic closure remains **anchor-to-newest** (unlimited if so anchored), independent of later `contextCount` changes; unlimited context may **enlarge the pinned working set** and must be **measured, not truncated**; viewport cap does not truncate context |
| **Governance** | Renderer-local view policy; Phase 4 viewport rules | **Renderer-owned assistant settings**; authoritatively governed by `context-window.md` (stable group-key anchor, `contextCount` as **initialization/re-anchor provenance only**, exactly-once repair after projection load; for an already anchored topic closure is **anchor-to-newest independent of current `contextCount`**; Main reads rows only) |

**Context invariants (preserved verbatim from `context-window.md` governance):**

- **Stable anchor-to-end**: context is the closed range from the **stable anchor** (renderer-owned `contextWindowAnchor` → stable group-key anchor if set; otherwise oldest message) **through newest** per `context-window.md`. Anchor stability means the anchor is a **stable ID** (renderer-owned assistant settings), not a tuple cursor.
- **`contextCount` initialization / explicit re-anchor meaning (normative)**: per `context-window.md`, `contextCount` is consulted **only during renderer-side initialization or explicit re-anchor**. For an **already anchored topic**, the `context closure` is the **stable anchor through newest, independent of current `contextCount`**; **changing `contextCount` alone does not resize, invalidate, or re-anchor the existing closure**. `contextCount` may appear **only as initialization/re-anchor provenance**, never as a per-read bound, ordinary R-06 request input, or ordinary closure cache key. This contract counts closure in **complete context turns** and returns rows in `sort_order` → `id` order.
- **`contextCount=null` (unlimited)**: at **initialization/re-anchor** means **no count limit** — the closure is the full anchor-to-end range, which may be the entire topic. For an already anchored topic the closure remains **anchor-to-newest** independent of a later `contextCount` change. The system **measures** working-set growth under unlimited context; it does not silently truncate to fit Phase 4 evictable caps.
- **Exactly-once compatibility repair after projection load**: if the stable anchor is absent (deleted/missing), the implementation performs **exactly one renderer-side compatibility repair after projection load** to reselect a stable anchor per `context-window.md`; Main **may read authoritative chat rows** to serve the closure but **must not own or repair the anchor** — no new Main context-anchor repair API is introduced; repair is not retried automatically beyond that single correction, and the resulting closure completeness reflects the repaired anchor.
- **No duplication of context-window governance**: this contract does not add, invent, or reinterpret `contextWindowAnchor` / stable group-key anchor / `contextCount` semantics; `context-window.md` remains authoritative.

**Viewport/context interaction**:

- Viewport and context projections are **independent and disposable**; each has its own completeness type and invalidation triggers.
- A viewport `window` never implicitly satisfies a `context closure` — even if the window happens to cover the same IDs, it is not `context closure` complete unless its declared bounds **provably equal** the closure's anchor-to-end bounds for the same generation.
- Unlimited context enlarging the pinned working set is **observable** via the working-set payload metric (§5.10); it is not bounded by Phase 4 B-01/B-02 evictable caps, consistent with pinned-exception measurement.

#### 5.8 Mutation, stream, and cache rules

| Concern | Rule | Detail |
|---|---|---|
| **Topic streams independence** | Each topic's stream/request queue is **independent**; a stream remains **pinned** for its originating topic until it settles (resolved/failed/aborted), consistent with Phase 4 pin matrix (§4.6) | Navigation away does not terminate or redirect an in-flight stream; the stream's topic remains pinned and excluded from eviction while in flight (Phase 2 stream independence + Phase 4 pin). |
| **Structural mutations** | Any mutation that affects ordering — **middle insert, delete, reorder, branch/clone with positioning** — **advances the topic's generation** and **invalidates/progresses** prior `whole-topic`/`window`/`answer-group`/`closure` completeness for that generation | Prior `window` bounds from the old generation are not trusted; callers must re-anchor by stable ID after the mutation. Window coverage from the old generation is discarded, not updated in place, until a fresh read for the new generation establishes new completeness. |
| **Content-only block updates** | Mutations that change **block content/status only** without affecting `sort_order` or topic membership **do not advance generation** and **do not invalidate `window` ordering coverage** | `window` bounds remain valid; only per-member derived content caches (e.g., rendered markdown, block display) are invalidated for affected members. Content-only updates never trigger generation invalidation or stale-response discard for ordering. |
| **Whole-topic vs. window cache & eviction granularity** | Resident `whole-topic` (resident-topic = chat-data ∧ segment for same generation; `whole-topic` and resident-topic are same semantic composite, explicit empty components included, jointly validated/published atomically) can satisfy `window` consumers only when its generation matches and its bounds trivially cover the requested range **and** the required semantic closure (if any) is derived/validated for the same generation (§5.3); a `window` can **never** satisfy a `whole-topic` consumer; `whole-topic` alone never implicitly satisfies `answer-group`/`context closure`; **R-01 is semantic `whole-topic` (chat-data ∧ segment for same generation); `chat-data completeness` and `segment completeness` are component/staging markers and may not satisfy any consumer expecting `whole-topic`; bare component reads are staging details, not new R intents (see §5.3); segment completeness not required for R-02..R-06 unless consumer explicitly joins segment state** | Phase 4 eviction remains **whole-topic atomic** for existing whole-topic (resident-topic) residents. **Window/closure resident eviction granularity is not locked in Phase 5 and is deferred coherently to Phase 6**; Phase 5 retains the invariant of **no partial-entity eviction within an admitted semantic unit** (a complete rendered/message group for viewport windows, a complete context turn for context closure, and a complete answer-group member set are not split by eviction). Phase 6 will define coherent granularity below working-set measurement without violating that invariant. |
| **Authoritative deletion invalidation** | **Hard delete / final purge / empty-trash / assistant reset** atomically **invalidates every completeness type** (`whole-topic`/`window`/`answer-group`/`context closure` and component `chat-data`/`segment`/`resident-topic`) and **rejects/disposes stale generation before any further join/action**; **no deleted projection may satisfy R-01..R-06**; soft-delete/trash preserves completeness for restore | Deletion cleanup follows Phase 4 matrix (§4.6): hard-delete removes all resident markers/generation/accounting/topic index/exclusive entities/derived viewport/context/search and scroll snapshot in one transition; shared entities referenced by another resident topic remain. Bulk deletion identifies affected IDs via authoritative result or existing typed capability; if insufficient, contract change routes through §10.1. **No implementation authorized**; Phase 6 candidate acceptance must demonstrate invalidation before any join/action for affected topics. |
| **Phase 4 lineage** | Phase 4 B-01/B-02/TTL/LRU, viewport 200-group cap, scroll 256/TTL, 500 Range, context-info single-memo remain authoritative capacity defaults | Viewport trim (§4.6 B-06) never evicts message entities; window residents do not implicitly grow the viewport window; pinned topics remain excluded from B-01/B-02 caps but are **measured** (§5.10). |
| **Authority-aware target actions** (contract-only; coordinated IPC review required) | — | Target contracts: **(a)** Main resolves **complete answer group** for selection; **(b)** branch/clone/edit positioning uses **stable authority-side anchors** (not client-computed `sort_order`); **(c)** search-hit navigation uses **around-message window** (R-04). All three are **target contracts only** — no IPC payload/schema specifics beyond contract-level intents are defined here; implementation triggers **coordinated shared-contract review** (see §5.11). |

**Authority-aware actions — contract detail:**

- **Answer-group resolution**: a selection request carrying a `messageId` is resolved **authoritatively by Main** into the complete member set for that group; the response carries `answer-group` completeness. Renderer never infers group membership from a `window` alone as `answer-group` complete.
- **Branch / clone / edit positioning**: new-message placement for branch/clone/edit uses a **stable authority-side anchor** (e.g., parent or sibling message ID) rather than a client-supplied `sort_order`; authority determines the resulting `sort_order` deterministically. The originating topic's generation advances (structural mutation).
- **Search-hit navigation**: a hit carrying a `hitMessageId` navigates via **R-04 around-message window**; if the hit is deleted/not-found, the response is explicit not-found and the caller falls back (e.g., latest window).

#### 5.9 Error, retry, and concurrency

| Concern | Contract |
|---|---|
| **Renderer-local generation / request tokens** | Tokens are **applicability only** — they tag a response as belonging to the generation that issued it and allow discard of stale responses. They are **not** authority versions, revisions, snapshots, or sync metadata. Cross-topic generation comparison is meaningless. |
| **Not-found / anchor-missing** | An absent topic or deleted anchor yields an **explicit typed not-found / anchor-missing** (not an empty window). Callers handle this as a distinct case (e.g., fallback to latest window or anchor repair for context). |
| **Failed fetch** | A failed typed fetch **commits no complete resident entry** for that generation/request token — identical to Phase 4 §4.7: failure surfaces on the existing error path and leaves no completeness marker; a **later explicit activation/retry repeats the idempotent fetch** for the same topic/anchor. **No automatic retry** is claimed. |
| **Retry semantics** | Retries are **caller-driven and idempotent** for reads; mutations are atomic/idempotent where applicable (see architecture qualities §3.3). Renderer does not auto-retry on behalf of a stale generation. |
| **Same-topic identical reads** | Multiple concurrent identical reads for the **same topic and same intent/bounds** may be **single-flighted** (coalesced) into one authority fetch; coalescing is renderer-local and does not change the authority result. Single-flight is a **may**, not a must. |
| **Same-topic window reads** | Concurrent **window reads** for the **same topic** but **different bounds/anchors** **serialize** (queue in renderer); they do not race to install competing windows as complete. Serial ordering is renderer-local and deterministic. |
| **No global cap** | **No global request cap** across topics is selected by this contract. Per-topic serialization and optional single-flight are the only concurrency shape; a global cap remains an **open Phase 6/governance decision** (see §5.11). |
| **Structural vs. content-only errors** | Structural mutation failures leave generation unchanged and do not invalidate prior `window` coverage; content-only update failures invalidate only the affected member's derived content. |

**Ordering of serialized same-topic windows**: windows are issued in **caller order** for that topic; a later window that overlaps a prior window's bounds does not implicitly extend the prior window's completeness — each window's completeness is **independently declared** per response.

#### 5.10 Observability, measurability, and privacy requirements (contract-level)

**Measurability (required before any Phase 6 calibration/implementation):**

| Metric | Scope | Requirement |
|---|---|---|
| Window hit / miss | Per topic, per intent (R-02..R-06) | Count of resident-window hits (bounds cover requested range for current generation) vs. misses with reason (no resident / generation mismatch / bounds insufficient / anchor-missing / component incomplete / authoritative deletion); miss latency; declared bounds vs. requested bounds; **no mixed-generation cache joins**. |
| Completeness type & component composition | Per resident entry (whole-topic / window / answer-group / context closure) plus **chat-data / segment / resident-topic components** | Marker present/absent, type, **R-01 `whole-topic` = resident-topic (chat-data ∧ segment for same generation, explicit empty components included, jointly validated/published atomically; `chat-data` and `segment` are component/staging markers that alone do not satisfy `whole-topic`; bare component reads are staging details, not new R intents)**, declared bounds/member set/closure bounds, generation; empty markers for each component valid; no `window` masquerading as `whole-topic`; staged same-generation publication validated; segment completeness not required for R-02..R-06 unless consumer explicitly joins segment state. |
| Staged same-generation publication | Per topic admission | Pin → stage chat-data + segment-data for same generation → await both → validate IDs/references/generation together → canonical logical bytes → publish in one transition; **discarded staged-attempt count on failure/mismatch; no mixed-generation publishes**; generation applicability validated. |
| Ordering guarantee | Per authority response | Verify `sort_order`→`id` ordering in every response; record any out-of-order observation as contract violation. |
| Tuple-cursor safety | Cross-mutation | Record that old `(sort_order, id)` is never carried as an anchor; verify all paging re-anchors by stable ID after structural mutations. |
| Generation / token | Per topic / per fetch | Current generation, advance count (**structural mutations + authoritative deletions**), stale-discard count (including stale generation rejected before any join/action after deletion), request-token applicability pass/fail; no authority-version claim. |
| Authoritative deletion invalidation | Per affected topic (hard delete/final purge/empty-trash/assistant reset) | Invalidation count per completeness type (all types: `whole-topic`/`window`/`answer-group`/`context closure` and components); stale-generation rejection before any join/action; deleted projection never satisfies R-01..R-06 (verified); soft-delete retain count vs hard-delete removal count; bulk affected-ID identification via authoritative result/typed capability (§10.1 gate if insufficient). |
| Single-flight / serialize | Per topic | Coalesced identical-read count; serialized window-queue depth and wait time; no global cap metric. |
| Context closure | Per topic (context path) | Anchor ID, closure bounds (**anchor-to-newest**, independent of current `contextCount`), closure size (logical bytes), repair count (exactly-once per missing anchor), working-set enlargement when unlimited; **`contextCount` recorded only as initialization/re-anchor provenance, not as ordinary closure cache key or per-read bound**. |
| Pinned working set | Pinned set aggregate (active + in-flight) | Logical retained payload for pinned topics and for window/closure residents while pinned; **measured, not capped** by B-01/B-02; heap-amplification ratio per workload (§4.8 calibration). |
| Evictable set | Evictable residents (§4.5–§4.6) | Resident count vs. B-01 (8), logical aggregate vs. B-02 (32 MiB), TTL expirations, oversized (>32 MiB) non-admissible, LRU evictions with deterministic ordering. |
| Viewport | Active viewport | Group count vs. 200-group view cap; expansions/trims; anchor stability; viewport `window` never satisfies `answer-group` or `context closure`. |
| Authority-aware actions | Selection / branch / clone / edit / search | Resolution source (Main vs. renderer) — must be Main for `answer-group`; anchor stability for branch/clone/edit; R-04 hit-window bounds declared. |
| Working-set enlargement | Unlimited context | When `contextCount=null`, report pinned working-set logical bytes and heap ratio; confirms no silent truncation. |

**Privacy**: All metrics are local, in-process diagnostics. No payload content leaves the device; no network export. Any future OTLP/log export must follow existing `loggerService` and privacy review; Phase 5 does not create export paths.

**Calibration**: Phase 5 contracts are calibration inputs; they are not performance thresholds or baselines. Phase 4 B-01/B-02 calibration (§4.8 heap-amplification) informs Phase 6 window/closure sizing; unlimited-context working-set measurement informs any future pinned-set bounding decision (Phase 6/governance). Phase 5 does not perform that calibration.

#### 5.11 Decision triggers, non-goals, and sync review

**Decision triggers — when work must stop and obtain review/ADR before any implementation:**

| Boundary | Trigger example | Required action |
|---|---|---|
| Shared IPC / preload / cross-process contract | Any new read intent, change to payload shape, change to completeness typing, or new authority-aware target action (group resolve, anchor-based positioning, hit-window) | **Stop before implementation**; perform **coordinated shared-contract review** across shared types/channel definitions, preload exposure, and Main handlers; obtain explicit architecture/program approval; formal ADR only when existing governance requires it; coordinated both-side edits mandatory (see §10.1) |
| Persistence / migration / schema | Any change that alters persistence semantics, adds revision/snapshot/tombstone columns, or changes `sort_order` semantics | SQLite migration governance decision (ADR) required |
| Context-window semantics | Any change to `contextWindowAnchor` semantics, `contextCount` behavior, or repair semantics | Context-window governance review (`context-window.md`) |
| Identity / compatibility | Any change to database names, persistence keys, ZIP/origin schema, protected profile names | Application Identity governance decision |
| Release / platform | Any change affecting release scope or platform-specific behavior | Application Identity governance decision |
| Sync boundary | Any sync metadata, tombstone, revision, conflict engine, vendor adapter, transport, account/E2EE/attachment | Sync governance owner documents (`sync-mvp.md` / `sync-powersync-spike.md`); Phase 8 only |

**Non-goals (explicitly not selected by Phase 5):**

- No schema changes, no revision/tombstone/sync metadata, no cross-request snapshot/linearizability, no vendor/transport decision.
- No specific IPC payload field names, SQL window clauses, or storage-index designs beyond **contract-level target intents** — those are Phase 6 implementation concerns.
- No global request cap; **no partial-entity eviction within an admitted semantic unit** beyond the invariant (§5.8); no incremental/delta selection in Phase 5 — any future delta mechanism is **deferred to Phase 6** without renderer-generation-based authority deltas (generation remains applicability-only).
- No claim that existing `listByTopicPage` is sufficient under concurrent dense-order mutation.
- No numerical performance threshold, no baseline adoption, no heap/latency improvement claim.
- Window/closure resident eviction granularity is **not locked** in Phase 5 and is deferred coherently to Phase 6 (§5.8).

**Sync compatibility review (ARCH-005 — Phase 5 contribution):**

| ARCH-005 property | Phase 5 contribution | Status |
|---|---|---|
| Clear authority boundaries | Reaffirms Main SQLite sole authority; all intents are authority-served; projections remain disposable | Preserved |
| Stable IDs | Anchoring is exclusively **stable IDs**; dense `sort_order` is explicitly **not** a stable anchor | Strengthened (documentary) |
| Typed explicit commands | Read intents are typed at contract level; target authority-aware actions are typed intents; coordinated contract review is mandatory | Established (documentary; implementation pending) |
| Atomic/idempotent mutations | Read intents are idempotent; branch/clone/edit positioning is authority-atomically ordered via stable anchors (target) | Established (documentary) |
| Deterministic ordering | `sort_order`→`id` is the sole intra-response ordering guarantee; no cross-mutation cursor safety claimed | Preserved |
| Stable/final checkpoints | Window/closure reads are not checkpoints; only stable/final block states remain SYNC-004 candidates; stream independence preserved | Preserved |
| Disposable projections | Window/closure/group projections are explicitly disposable; rebuild by stable-ID re-anchor | Established (documentary) |
| Bounded caches | Viewport cap preserved; **window/closure sizing for bounded working set is measured, not bounded, until Phase 6**; Phase 4 evictable caps unchanged | Deferred to Phase 6 / governance for working-set bounding |
| Device-local-state separation | Scroll/viewport remain device-local; context closure is shareable-state-derived but closure measurement is local | Preserved |

**Governance prohibitions preserved**: No sync schema, metadata, tombstone, conflict engine, vendor adapter, transport, account/E2EE/attachment decision, or production sync path is introduced (ARCH-006). No context-window semantics are changed (`context-window.md` authority unchanged). No schema, migration, identity/compatibility, release/platform, or native/multi-window changes are introduced.

#### 5.12 Rollback, non-claims, and exit wording

**Rollback**: Phase 5 is documentation only. Rollback is reverting this document to its pre-Phase 5 state. No code, schema, IPC, storage, or `architecture.md` change to revert. Future implementation of this contract will be rollback-bounded by reverting consumers to whole-topic loads (`R-01`) and removing window/closure/group intents; no authority/data migration is involved.

**Non-claims**:

- This design study does not implement windowed reads, authority-aware actions, delta/incremental mechanisms, or `architecture.md` changes, and does not close Phase 5 exit, Phase 4 exit, PERF-TOPIC-SWITCH, or PERF-ECHO, and does not alter, reopen, or retroactively own the already-closed Phase 3 exit (Closed 2026-08-21). Any future delta mechanism is deferred to Phase 6 without renderer-generation-based authority deltas.
- PERF-TOPIC-SWITCH and PERF-ECHO remain **Open** with no committed numeric threshold; six L3 post-S3.5 measurements remain directional only.
- Capacity defaults (§4.5) and this contract's `window`/`closure` sizing expectations are **architecture defaults / contract calibration inputs**, not performance thresholds, not validated baselines, and not root-cause claims.
- **No claim** that existing `listByTopicPage` is sufficient under concurrent dense-order mutation; **no claim** of long-lived tuple-cursor safety, authority revision/snapshot, cross-request snapshot, or linearizability; **no claim** that renderer generation can request authority deltas (generation is applicability-only, §5.5).
- Renderer total memory boundedness beyond evictable caches is not claimed; **pinned working set (active/in-flight) and unlimited-context closures are measured, not bounded**, until Phase 6/governance.
- Window/closure resident eviction granularity is **not locked** in Phase 5 — deferred coherently to Phase 6 with no partial-entity eviction within an admitted semantic unit (§5.8).
- No schema/IPC specifics beyond contract-level target intents are defined; `_target intents_ (R-01..R-06)` are not implemented IPC channels.
- No sync schema, revision, tombstone, tombstone/merge semantics, or transport is introduced.

**Exit wording (pending)**:

> Phase 5 design study is **complete** (2026-08-20). The data-access contract (§5.1–§5.11) is internally coherent and executable pending coordinated IPC review, calibration, and implementation authorization. **Phase 5 exit remains Open** pending: (1) coordinated shared-contract review of target read intents (R-02..R-06) and authority-aware actions before any implementation; (2) calibration of window/closure/pinned-working-set sizing under Phase 4 heap-amplification and unlimited-context measurement before implementation authorization; (3) data-access acceptance criteria validation per §5.10 demonstrating scoped window/closure reads with defined counting units (complete rendered/message groups for viewport, complete context turns for context, messages for whole-topic/answer-group, authority order `sort_order` → `id`), typed completeness with no masquerading and validated semantic derivation for `answer-group`/`context closure` (whole-topic label alone never suffices), deterministic `sort_order`→`id` ordering with stable-ID anchoring (no tuple-cursor carry, no generation-based deltas), separate viewport/context projections with renderer-owned anchor and Main-reads-rows-only closure, and correctly pinned streams with structural vs. content-only invalidation and deferred window eviction granularity (no partial-entity eviction within an admitted semantic unit).

**Traceability to locked decisions and Phase 5 audit remedies**:

| Locked decision / audit remedy | Where addressed |
|---|---|
| ARCH-001..008 unchanged | §1.2/§1.3 and §5.1 (row 1 cites ARCH-008); §5.11 sync review |
| Documentation/design only; no implementation | §5.1; §5.12 rollback |
| Main SQLite sole authority; disposable projection | §5.1; §5.3; §5.8 |
| Stable IDs anchor; `sort_order`→`id` order; no tuple-cursor/revision/snapshot/linearizability claim | §5.1; §5.4 guarantees table; §5.12 non-claims |
| Completeness semantic types; no masquerading; empty explicit; **whole-topic containment vs. semantic derivation** (whole-topic contains all rows but `answer-group`/`context closure` require derived/validated closure, never generic label) | §5.3 types + invariants; §5.4; §5.6 matrix invariants; §5.8 |
| **One counting unit per intent**: viewport = complete rendered/message groups, context = complete context turns, whole-topic/answer-group = messages; authority order always `sort_order` → `id` | §5.4 intent table (Counting unit column) + guarantee note; §5.6; §5.7 |
| Renderer-local tokens applicability only; same-topic single-flight/serialize; no global cap; **generation cannot request authority deltas — R-07 removed/deferred** | §5.3 generation definition; §5.4 (R-07 removed); §5.5; §5.6; §5.9; §5.11 non-goals; §5.12 |
| Viewport/context separate; anchor-to-end, `null` at init/re-anchor, exactly-once repair; unlimited measured not truncated; **for already anchored topic R-06 is stable anchor through newest independent of current `contextCount`; `contextCount` is initialization/re-anchor provenance only, never per-read bound/ordinary R-06 input/ordinary cache key; context anchor renderer-owned (assistant settings, stable group-key anchor), Main reads rows only, exactly-once repair after projection load, no Main repair API; changing `contextCount` alone does not resize/invalidate/re-anchor** | §5.4 R-06 clarification; §5.7 invariants + governance row; §5.4 cache-join; §5.6 R-06 row; §5.10 |
| Authority-aware actions as target contracts triggering IPC review | §5.8; §5.11 triggers |
| Streams pinned independent; structural invalidate / content-only not | §5.8 |
| Phase 4 defaults remain defaults not thresholds | §5.1; §5.8 |
| **Window/closure eviction granularity not locked in Phase 5; deferred coherently to Phase 6; invariant retains no partial-entity eviction within admitted semantic unit** | §5.8 whole-topic vs window row; §5.11 non-goals; §5.12 non-claims |
| **Rollback restores pre-slice implementation only; never endorses renderer authority over authoritative mutations** (S6.2 corrected) | §5.12 rollback; §6 S6.2 |
| Design study complete but exit Open; Phase 3 Closed, Phase 4/5/Phase 6/ARCH-011 PERF Open; Phase 6 unauthorized | §5.12; §6 Phase 6 status |

#### 5.13 Phase 5 Study Record — Bounded Documentation Study (2026-08-21)

**Record status**: **Documentation-only study complete; no implementation authorized** (LOCK-P5-001). **Main SQLite authority, stable-ID anchors, `sort_order`→`id` intra-response ordering, renderer-local generation applicability-only, no `fromGeneration` delta cursor** (LOCK-P5-002). **Phase 5 exit and all three gates remain Open** (LOCK-P5-003). **`architecture.md` and governance owners unchanged** (LOCK-P5-004). **No deferred payload/channel/SQL/window-size/cap/eviction granularity choice selected** (LOCK-P5-005).

**Current surfaces (observed — not target)**:
- Topic load: `loadTopicMessagesThunk` → `dbService.fetchMessages` → typed IPC → `ChatDbAggregateService.fetchMessages` **one Main transaction** invoking `MessagesRepository.listByTopic` / `BlocksRepository.listByMessages` → renderer **whole-topic** projection (single source for viewport/context/groups).
- Consumers assume whole-topic resident (`computeContextInfo`, `reconcileMessageWindow`, display grouping); no windowed/incremental/replacement path.
- Dense `sort_order` rewritten by middle insert/delete/reorder; deterministic order is `sort_order`→`id` only within one authority transaction; no revision/snapshot/linearizability.
- No windowed fetch (`around anchor/message`, latest window), no authority-side context closure window; context anchor-to-end computed in renderer from whole-topic.
- Empty-topic completeness is implicit (`cachedIds.length > 0` early-return), not explicit empty-topic marker; current `dbService.fetchMessages` (messages/blocks only) plus separate/unawaited segment load does not satisfy target R-01 `whole-topic` (chat-data ∧ segment) resident completeness.
- Failures per-fetch; no single-flight/serialize contract enforced at data-access layer.

**R-02..R-06 matrix (target contract, not implementation)**:

| Intent | Coverage target | Completeness produced | Counting unit | Anchor stability | Generation interaction |
|---|---|---|---|---|---|
| R-02 Latest window | Latest N in deterministic order | `window` (tail N, bounds declared) | complete rendered/message groups | topic ID stable | new generation → re-anchor latest |
| R-03 Window around stable anchor | Neighborhood of anchor (±K) | `window` (around anchor, bounds declared) | complete rendered/message groups | anchor message ID stable | structural mutation → old window not trusted |
| R-04 Window around message (search-hit) | Around hit message | `window` (around hit, bounds declared) | complete rendered/message groups | hit message ID stable | hit deleted → not-found |
| R-05 Answer-group window | All members of answer group, authority-resolved | `answer-group` (member set declared) | messages in complete group | message/group ID stable | membership may change → re-resolve from authority |
| R-06 Context closure | Anchor-to-end closed range (stable anchor through newest, independent of current `contextCount`; `contextCount` is initialization/re-anchor provenance only) | `context closure` (anchor-to-end, bounds declared) | complete context turns | anchor ID stable (renderer-owned) | structural mutation → re-close; `contextCount` change alone does not resize/invalidate |

Ordering for all: `sort_order`→`id` within single authority transaction; no tuple-cursor stability across mutations; no revision/snapshot/linearizability; stale generation discarded before any join/action; no `fromGeneration` delta cursor (former R-07 removed; deferred to Phase 6 without generation authority cursor, §5.1/§5.4/§5.5).

**Coordinated review surfaces (implementation requires stop + review before any code)**:
- Shared IPC/preload/cross-process contract: any new read intent (R-02..R-06), payload-shape/completeness-typing change, or authority-aware target action (group resolve, anchor-based positioning, hit-window) → coordinated shared-contract review across shared types/channel definitions, preload exposure, and Main handlers; architecture/program approval; formal ADR only when governance requires; both-side edits mandatory (§5.11 / §10.1).
- Persistence/migration/schema: any revision/snapshot/tombstone/column or `sort_order` semantics change → SQLite migration governance (ADR).
- Context-window semantics: any anchor/`contextCount`/repair change → `context-window.md` review.
- Identity/compatibility, release/platform, native/multi-window, sync boundary per §10.1 — no change introduced here.

**Test implications (contract-level, no implementation test claimed)**:
- **L1 (correctness gates, design)**: typed completeness present on every response (no masquerading; `window` bounds declared; empty explicit); `sort_order`→`id` ordering verified per response; stable-ID re-anchor after structural mutations (no tuple-cursor carry); generation applicability stale-discard before any join/action; authoritative-deletion invalidation of all completeness types before any join/action; answer-group authority-resolved; context closure separate from viewport window.
- **L3 (directional observation only)**: window/closure hit/miss, miss latency, canonical logical bytes, generation advance/stale-discard, single-flight/serialize depth, scroll/viewport/context metrics, pinned vs evictable working-set logical bytes + heap-amplification ratio (§5.10). No threshold/baseline/improvement claim; L3 is calibration input for Phase 6.
- Current test surfaces remain **whole-topic** (`fetchMessages` path); windowed/closure/group paths are **contract-only** and have no implementation test coverage in this record. Future Phase 6 implementation must add focused contract tests per intent and generation-scoped cache-join tests.

**Open gates (exit remains Open, §5.12)**:
1. **Coordinated shared-contract review** of target read intents (R-02..R-06) and authority-aware actions — not satisfied.
2. **Calibration** of window/closure/pinned-working-set sizing under Phase 4 B-01/B-02 canonical logical-bytes + heap-amplification and unlimited-context measurement — not performed.
3. **Data-access acceptance criteria validation** per §5.10 (scoped window/closure reads with defined counting units, typed completeness with validated semantic derivation, deterministic `sort_order`→`id` with stable-ID anchoring and no generation-based deltas, separate viewport/context projections with renderer-owned anchor, pinned streams with structural vs content-only invalidation, deferred window eviction granularity with no partial-entity eviction within admitted semantic unit) — not demonstrated.
- Phase 3 remains **Structurally Closed 2026-08-21**; Phase 4 exit remains **Open** for independent calibration/implementation; PERF-TOPIC-SWITCH/PERF-ECHO remain **Open as independent post-refactor workstreams (non-blocking, ARCH-011)**; Phase 6 remains **unauthorized candidate**.

**Preserved boundaries and non-claims**:
- ARCH-001..008 unchanged (§1.2/§1.3 and §5.1 row 1 cites ARCH-008; §5.11 sync review); no governance change; sync prohibitions preserved (ARCH-006).
- `architecture.md` unchanged (implemented reality only, ARCH-008); identity/SQLite-migration/context-window compatibility/release/platform owners unchanged (§10.5).
- R-01 `whole-topic` remains **chat-data ∧ segment for same generation** (explicit empty markers, jointly validated, published atomically); chat-data/segment alone are component/staging markers, not new R intents; `window` never satisfies `whole-topic`; generic `whole-topic` label never implicitly satisfies `answer-group`/`context closure` without derived/validated closure (§5.3/§5.6).
- No payload field, channel name, SQL window clause, N/K/window-cap, global cap, or eviction granularity selected; Phase 6 owns selection (LOCK-P5-005).
- No revision/tombstone/sync metadata, no snapshot/linearizability, no tuple-cursor safety claim, no `listByTopicPage` sufficiency under concurrent mutation claim (§5.1/§5.12).
- No schema/IPC/code change; no sync schema/metadata/transport/vendor decision; no performance threshold/baseline.

#### 5.14 Coordinated shared-contract review record — R-02/R-03 window reads (2026-08-22)

**Review status**: **Review-only; documentation-only.** This review is performed per the program's mandatory stop/review obligation for any new read intent: the coordinated shared-contract review must span all three required surfaces jointly — shared types/channel definitions, preload exposure, and Main handlers — plus, for gap assessment, the renderer consumption layer that would receive the result. This record executes that review against current reality for the R-02 latest-window and R-03 around-anchor window intents and documents it as evidence. It **adopts nothing and selects nothing**: no payload field, channel name, SQL clause, N/K/window-cap value, or eviction granularity is chosen, and no implementation is authorized. The coordinated-review precondition of the data-access exit gate is hereby executed and documented; **explicit architecture/program approval remains outstanding, and all Phase 4/5 exits remain Open**.

**Table A — Current-reality inventory** (observed structure only, not target):

| Layer | Current state | Reference |
|---|---|---|
| Shared channel/type | `chatdb:fetch-messages`; request carries `{ topicId }` only; response is `{ messages, blocks }` JSON arrays | `packages/shared/chatDb/types.ts:87-89`, `258-262`, `635` |
| Shared validation | Allowed-keys admits exactly `topicId`; any added request key is rejected at the boundary; result profile caps strings and the blocks aggregate | `packages/shared/chatDb/contracts.ts:139-145`, `146-183` |
| Preload | Forwards the request unchanged on `window.api.chatDb.fetchMessages` | `src/preload/index.ts:625-626` |
| Main handler | Per-call aggregate service, single root transaction per invocation | `src/main/services/chatDb/ipc.ts:262-265`; `ChatDbAggregateService.ts:100-133` |
| Repository SQL | Both queries return the full topic's rows (messages filtered by `topic_id`; blocks selected via `message_id IN (topic's message IDs)`), `ORDER BY sort_order ASC id ASC`, no LIMIT; composite indexes `(topicId, sortOrder)` / `(messageId, sortOrder)` back them | `repository/MessagesRepository.ts:159-167`; `repository/BlocksRepository.ts:89-105`; `schema/index.ts:52,75` |
| Renderer thunk | Cache early-return infers completeness from non-empty cached IDs; publishes blocks then wholesale-replaces the topic ID list; segments loaded separately and unawaited | `store/thunk/messageThunk.ts:1525-1590` |
| Projection stores | `messagesReceived` replaces the ordered ID list (replace-not-merge); blocks upsert-many | `store/newMessage.ts:133-139`; `store/messageBlock.ts:82-91` |
| Windowing on the read path | Absent end-to-end — no window parameter in the request type, validator, preload surface, or SQL | Rows above |
| Dormant pagination machinery below contract | Repository-level keyset pagination over `(sort_order, id)` with typed cursors; unit-test callers only; no aggregate/IPC exposure | `repository/MessagesRepository.ts:169-208`; `domain/cursor.ts:24-83` |

**Table B — Requirement status checklist** (status against current reality; evidence basis cites Table A rows):

| Requirement | Status against current reality | Evidence basis |
|---|---|---|
| Ordering authority `sort_order`→`id` | Satisfied at SQL level for both queries | A5 |
| Stable-ID anchoring | Structurally available (IDs are primary keys); tuple-cursor machinery exists but design excludes it as anchor | A9 + intent norms |
| Typed `window` completeness | Absent; response carries no marker or bounds | A1 |
| Declared bounds in response | Absent | A1 |
| Counting unit of complete rendered/message groups | Not representable today (whole-topic only; group reconstruction happens renderer-side) | A7 |
| No window masquerading as whole-topic | Trivially satisfied while only whole-topic intent exists; consumer inference mechanism absent | A6/A7 |
| Segment component not required unless joined | Current separate/unawaited segment load is compatible; coupling flagged | A6/A7 |
| Generation applicability tagging | Absent on the wire; renderer-local transition epochs exist and are semantics-compatible (applicability-only) | A6 |
| Explicit not-found / empty-topic distinction | Gap: an absent topic currently returns empty arrays | A4 |
| Coverage-check cache join (bounds fully cover requested range) | Gap: early-return uses a non-empty-IDs heuristic | A6 |
| Re-anchor by stable ID after structural mutation / bounds-not-cursors | No mechanism; behaviorally safe today because only whole-topic intent exists | A6/A9 |
| Concurrent same-topic window reads serialize | N/A until windowed reads exist | intent norms |

**Findings**:

1. **F1 — Any windowed read is necessarily a coordinated both-side contract change.** A request extension is rejected by the frozen allowed-keys validator; types/channels/preload/handlers are single-file chokepoints that also serve mutation and streaming contracts (`types.ts` command map; the IPC channel enum block; the single preload literal bridge; the generic handler wrapper in `ipc.ts`). Shared contract tests pin fetch-messages behavior and would be edited together with the contract.
2. **F2 — Main-local dormant keyset pagination seam exists unused.** It has test-only callers. The design explicitly makes no sufficiency claim for it under concurrent dense-order mutation and excludes tuple cursors as anchors; it is infrastructure precedent, not a conformant contract primitive.
3. **F3 — Envelope precedent exists on adjacent channels.** Trash listing accepts limit/cursor; search accepts pageSize/cursor and returns nextCursor/hasMore. Recorded as fact, not a selection.
4. **F4 — Consumer-side collision.** The wholesale-replace reducer and the non-empty-IDs completeness heuristic cannot install or reason about partial windows; remedy is deferred to implementation, not selected here.
5. **F5 — Secondary direct call sites bypass the thunk assuming whole-topic semantics** (`services/SpanManagerService.ts:143`; `pages/history/components/SearchResults.tsx:390`) plus `TopicManager.getTopicMessages` and HistoryPage dispatch sites. This is a migration-surface inventory for any future slice, not defects today.
6. **F6 — `getRawTopic` duplicates the read shape non-transactionally.** Its scope divergence is undocumented; listed for a future implementation-scope decision.

**Carried-forward unknowns**:

- Whether mini/trace-viewer windows dispatch the load thunk at runtime was not traced.
- The intended consumer of the dormant pagination seam is unstated by any comment.

### Phase 6: DB-Health Implementation (Candidate — Not Authorized)

**Status**: **Candidate slices — not authorized for implementation.** Requires explicit approval and, where noted, governance/ADR before any code, schema, or IPC work. This section defines **candidate implementation slices only**; no slice is active.
**Entry criteria**: Phase 5 data-access contract design complete (2026-08-20, documentation only, exit Open); calibration of Phase 4 B-01/B-02 and Phase 5 window/closure/pinned working set per §4.8/§5.10 inputs as needed for slice-specific acceptance; governance/ADR for any schema changes (M4/M5/M6) before those slices.
**Exit criteria (per-slice)**: Slice-specific acceptance evidence (see slice table) validated without violating Phase 5 contract invariants (typed completeness, stable-ID anchoring, `sort_order`→`id` ordering, no masquerading, no revision claim) and without adopting a performance threshold unless owned by `performance-measurement.md`.
**Dependencies**: Phase 5 contract (target intents R-02..R-06) — implementation must follow the contract; Phase 4 calibration where slice touches working-set sizing; governance/ADR for any schema/migration touching slices S6.3–S6.5.
**Activation**: Not activated by this program. Requires separate explicit approval per slice.

**Candidate slices** (each independently scoped and rollback-bounded; no slice crosses governance without the noted review):

| Slice | Description (contract targets implemented) | Prerequisites | Acceptance evidence | Rollback boundary | Status / provenance |
|---|---|---|---|---|---|
| **S6.1** Windowed read contract | Implement R-02 latest-window and R-03 around-anchor window as typed IPC window reads; Main returns `window` completeness with declared bounds in deterministic `sort_order`→`id` order; renderer installs `window` as disposable projection; viewport joins use resident-window coverage check | Phase 5 contract approved; coordinated shared-contract review for window intents before any IPC change; calibration input from §5.10 window sizing | Viewport bootstrap uses R-02 without falling back to whole-topic; history scroll uses R-03 anchored by stable message ID; bounds declared and verified; no `window` masquerading as `whole-topic`; no tuple-cursor carry across mutations demonstrated | Revert consumers to R-01 whole-topic load; remove window IPC channels; all data unchanged (authority untouched) | **Candidate — not authorized** |
| **S6.2** Authority-aware actions | Implement Main-authority `answer-group` resolution for selection (R-05) and stable-anchor positioning for branch/clone/edit; implement R-04 around-message window for search-hit navigation; all as typed target contracts from §5.8 | Phase 5 contract approved; coordinated shared-contract review for each authority-aware intent before any IPC change; S6.1 beneficial but not required | Answer selection resolves complete group via Main (`answer-group` complete, never window-inferred); branch/clone/edit positioning uses stable authority-side anchor (no client `sort_order`); search-hit navigates via R-04 around-message window with explicit not-found fallback | Revert to pre-slice implementation by removing authority-aware IPC paths and restoring prior view/context paths; rollback **never endorses renderer authority over authoritative mutations** — all authoritative mutations remain Main-owned; no schema/authority change to revert | **Candidate — not authorized** |
| **S6.3** Context closure & cache joins | Implement R-06 context closure anchor-to-end window with `context-window.md` semantics (`null` unlimited, stable anchor, exactly-once repair); establish cache-join semantics for context-info computation from closure; measure unlimited-context pinned working-set enlargement | Phase 5 contract approved; context-window governance review if any anchor/repair semantics need change; S6.1 as reference for window mechanics; calibration of closure sizing / heap ratio | Context reads use closure `window` separate from viewport `window`; `contextCount=null` returns full anchor-to-end measured (not truncated); repair is exactly once per missing anchor; viewport cap does not truncate closure | Remove closure read path; restore renderer-computed `computeContextInfo` from whole-topic; no authority change | **Candidate — not authorized** |
| **S6.4** Index / query opportunities | Address identified index/query opportunities from M1/M2/M3 diagnostics if proven beneficial, consistent with windowed reads | Phase 5 contract; M1/M2/M3 diagnostic evidence; ADR if any schema/index change touches persistence semantics | Query-plan structural improvement demonstrated on targeted path; no schema change without ADR; windowed-read invariants preserved | Revert index/query changes; no IPC contract change | **Candidate — not authorized; depends on M1/M2/M3 evidence** |
| **S6.5** File dual-state & FTS dedup | Resolve file dual-state consistency (M5) if proven real; FTS storage dedup (M4) if measurably beneficial | Phase 5 contract; M4/M5 diagnostic evidence; ADR for any schema/storage change | Consistency or deduplication benefit demonstrated; schema changes only via ADR; no target-architecture constraint from vendor | Revert storage/dual-state changes; no IPC change beyond what S6.1–S6.3 already reviewed | **Candidate — not authorized; requires governance/ADR** |

**Notes**: All slices are **candidate only**; none is authorized by this program. Each slice requires its own explicit approval and, where it crosses a governed boundary (IPC, schema, context-window, identity), the decision trigger in §5.11 / §10.1 applies. Slices do not close Phase 5/Phase 4 exits or PERF workstreams and do not alter, reopen, or retroactively own the already-closed Phase 3 exit (Closed 2026-08-21); performance validation, if any, requires separate L1 correctness gates and directional L3 observation — no threshold is adopted here. `listByTopicPage` behavior under concurrent dense-order mutation remains **unvalidated**; S6.1 window reads do not claim to reuse that path as sufficient. **Candidate acceptance traceability** (where sizing or resident state is involved, notably S6.1–S6.3): implementation must demonstrate **staged same-generation publication** (pin; stage chat-data + segment-data for same generation; await both; validate together; compute canonical logical bytes per Phase 4 B-02 canonical encoding; publish in one transition; discard on failure/mismatch), **no mixed-generation cache joins**, **authoritative-deletion invalidation before any further join/action** (hard delete/final purge/empty-trash/assistant reset invalidates every completeness type including components; soft-delete retains for restore; bulk IDs via authoritative result/typed capability or §10.1 gate), and **canonical logical-byte accounting** (shared entities conservatively charged in full for admission; heap-amplification recorded separately) — without claiming implementation.

### Phase 7: Startup Architecture

**Entry criteria**: Phase 2 complete (conversation ownership/lifecycle design enables lazy activation); explicit approval. Conversation-startup validation depends on relevant Phase 3 activation slice/completion; independent boot tracks can proceed after explicit approval.
**Content**:
- Validate and integrate the startup effects of Phase 3 conversation activation (ContentSearch on invocation, edit capability on mode activation, optional panels/drawers on opening).
- Optimize app boot services, Redux rehydration, Dexie initialization, SQLite cold open, bundle loading.
- Address background window lifecycle.

**Exit criteria**: Startup improvements validated by startup acceptance criteria (conversation-startup integration verified, boot service ordering optimized, bundle loading improved). The existing cold-open `<500ms` threshold is owned by the performance measurement contract (`performance-measurement.md` §7), not created by this program.
**Dependencies**: Phase 2 complete for conversation-related startup validation; Phase 3 conversation activation slice/completion for conversation-startup integration; app boot services are independent tracks.
**Startup/memory relationship**: This phase addresses startup through both conversation-startup validation (Phase 3 dependency) and independent boot optimization tracks. The boot tracks (Redux rehydration, Dexie, SQLite cold open, bundle loading, background windows) can proceed independently of conversation refactoring.

### Phase 8: Future Sync Decision

**Entry criteria**: Phases 2-5 provide sufficient structural foundation; explicit governance decision to pursue sync.
**Content**:
- Make vendor-neutral sync architecture decisions (cross-device authority, conflict resolution, transport).
- Assess and document remaining vendor-neutral sync-readiness decisions and validation requirements against ARCH-005; any production implementation requires separate explicit governance approval.
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
| **Full-topic/windowed fetch/cache joins** | Data-access contract implementation | Phase 5 design complete (documentation only, exit Open); implementation is Phase 6 candidate (S6.1–S6.3) requiring coordinated IPC review; may require schema awareness |
| **M4** FTS storage deduplication | Volume and write-amplification measurement + potential schema change | ADR for any schema change |
| **M5** File dual-state consistency | Consistency convergence diagnostic | ADR if resolution touches schema or authority boundaries |
| **M6** Sync metadata gap | Schema impact analysis | ADR; analysis only, no schema changes |

---

## 8. Startup/Memory Relationship

Conversation ownership and lifecycle design (Phase 2) directly enables:
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
| Clear authority boundaries | Established (documentary; Phase 2 §2.2) | Phase 2 |
| Stable IDs | Partially established (application-level text/UUID IDs preserved through refactor; Phase 5 contract anchors all read intents by stable IDs and explicitly disclaims tuple-cursor stability; cross-device identity/revision is Phase 8 open decision) | Existing + Phase 5 contract + Phase 8 |
| Typed explicit commands | Implemented (IPC channels, ChatDbAggregateService); Phase 5 target read intents (R-02..R-06) and authority-aware actions defined at contract level, implementation pending coordinated IPC review | Existing + Phase 5 contract |
| Atomic/idempotent mutations | Partially implemented (transactions, INSERT OR REPLACE); Phase 5 authority-anchored positioning and read-idempotent window/closure intents are target contracts | Phase 5 contract / Phase 6 candidate |
| Deterministic ordering | Implemented (dense sort_order); Phase 5 contract defines deterministic `sort_order`→`id` intra-response order with explicit non-claim for cross-mutation cursor stability | Existing + Phase 5 contract |
| Stable/final checkpoints | Identified (Phase 2 §2.8; enforcement is a cross-phase target constraint routing to appropriate existing governance) | Cross-phase constraint |
| Disposable projections | Established (documentary; Phase 2 §2.2, §2.4); Phase 5 extends to `window` / `answer-group` / `context closure` as separate disposable projections | Phase 2 + Phase 5 contract |
| Bounded caches | Design study complete — evictable caches strictly bounded as capacity defaults (§4.5), active/pinned working set measured but not yet bounded; viewport (200-group) and context (closure) are separate projections with unlimited-context measured-not-truncated; implementation pending, total memory not claimed bounded | Phase 4 design complete, exit Open; Phase 5 contract preserved |
| Device-local-state separation | Established (documentary; Phase 2 §2.2, §2.6); Phase 5 viewport vs. context separation preserved | Phase 2 + Phase 5 contract |

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

### 10.1 Decision gate: when work must stop

Architecture evolution must stop and obtain the appropriate governance or architecture decision before crossing any of the following governed boundaries. This list is mandatory and exhaustive for the boundaries governed by existing authoritative documents:

1. **Runtime authority**: Any change moving chat authority out of Main SQLite → stop; ADR required before implementation.
2. **Persistence/migration/schema**: Any change altering persistence semantics, schema structure, or migration steps (governed by `sqlite-migration.md`) → stop; SQLite migration governance decision required.
3. **Shared IPC/preload/cross-process contract semantics**: Any change to IPC channels, payload types, or preload surface (`contextBridge`) → stop before implementation; perform coordinated shared-contract review across shared types/channel definitions, preload exposure, and Main handlers; obtain explicit architecture/program approval for the contract change; formal ADR required only when an existing authoritative governance owner/process requires it; coordinated both-side edits mandatory.
4. **Context-window semantics**: Any change to anchor semantics or `contextCount` behavior (governed by `context-window.md`) → stop; context window governance review required.
5. **Native/app/window/multi-window lifecycle**: Any change to window lifecycle, native capability exposure, or app lifecycle → stop; governance decision required.
6. **Identity/compatibility**: Any change to database names, persistence keys, import schema, or compatibility identifiers (governed by `cherry-chat-application-identity.md`) → stop; Application Identity governance decision required.
7. **Release/platform**: Any change affecting release scope or platform-specific behavior (governed by `cherry-chat-application-identity.md`) → stop; Application Identity governance decision required.
8. **Sync boundary**: Any sync infrastructure, metadata, or transport → stop; sync governance owner documents (`sync-mvp.md` / `sync-powersync-spike.md`) are the authority; Phase 8 is the future decision/activation phase, not an authority.

A formal ADR is required where the authoritative owner document or process mandates it (e.g., schema/migration changes, identity/release/platform decisions, context-window governance changes). The mandatory rule is the decision gate itself — not every governed-boundary crossing automatically produces a new ADR artifact; the artifact form follows whatever the authoritative owner requires.

**Ordinary Renderer component/topic lifecycle is not a decision gate trigger.** The conversation lifecycle design in Phase 2 (topic transitions, viewport state, render graph stability) is Renderer-local component and state lifecycle. It does not cross any of the governed boundaries above. Component mount/unmount, topic-scoped state, and presentation-layer refactoring remain program-level concerns that do not require a decision gate unless they cross a governed boundary.

### 10.2 Decision phases and triggers

| Decision | Trigger | Governance |
|---|---|---|
| Runtime authority (chat data ownership) | Any phase | ADR required before implementation |
| Persistence/migration/schema changes | Any phase | SQLite migration governance decision |
| Shared IPC/preload/cross-process contract semantics | Any phase | Stop before implementation; coordinated shared-contract review; architecture/program approval; formal ADR only when existing governance requires it; coordinated both-side edits mandatory |
| Context window anchor semantics | Any phase | Context window governance review |
| Native/app/window/multi-window lifecycle | Any phase | Governance decision required |
| Identity/compatibility changes | Any phase | Application Identity governance decision |
| Release/platform changes | Any phase | Application Identity governance decision |
| Sync vendor/transport/account/E2EE | Phase 8 | Sync governance owner documents (`sync-mvp.md` / `sync-powersync-spike.md`); Phase 8 is the future decision/activation phase |
| Conversation ownership model | Phase 2 | **Resolved** (this program; see §2.2–§2.6) |

### 10.3 Acceptance model

Each phase has acceptance criteria defined in §6. Acceptance requires:
- Documented ownership/quality/contract model.
- Structural/governance/functional validation; performance validation where applicable is **directional L3 reference** (no absolute threshold gates phase per ARCH-009; PERF-TOPIC-SWITCH/PERF-ECHO are reclassified as independent post-refactor reference/reassessment workstreams and remain Open per ARCH-011, non-blocking).
- **Controlled-regression disposition**: reproducible material degradation under controlled same-state comparison must be attributed/disposed per ARCH-010 before exit (by fix, accepted trade-off, or keeping phase Open).
- No governance boundary violations.
- Explicit approval for next phase activation.

### 10.4 Open decisions

| Decision | Phase | Status |
|---|---|---|
| Conversation ownership model specifics | Phase 2 | **Resolved** (2026-08-19; see §2.2–§2.6) |
| Lazy activation boundaries | Phase 2 | **Resolved** (2026-08-19; see §2.6) |
| Render/state/action graph structure | Phase 3 | **Structurally Complete / Closed 2026-08-21** (S3.1, S3.2, S3.3, S3.4, S3.5 implemented; S3.4 prerequisite satisfied by S3.1; measurements on clean `bfc1c61713a689275324c85a4cafa23b35040abc` 2026-08-20 and clean `4df885d4d7fc055c2a2c5c742dfad79ff82ab991` 2026-08-21 both dirty=false — each six canonical focused runs exit 0, L1 pass (PERF-101 11/11 per scale / PERF-103 10/10 per run for bfc1c617 matrix; PERF-101 11/11 ×3 scales ×3 samples and PERF-103 10/10 ×3 runs with standard 20 + high-turn 10+10 samples for 4df885d), L3 directional only, no `PERF_PHASE_ATTR` overlay, no controlled same-state improvement/regression claim; PERF-TOPIC-SWITCH/PERF-ECHO reclassified as independent post-refactor reference/reassessment workstreams per ARCH-011 and remain Open (non-blocking)) |
| Cache invalidation rules and bounds | Phase 4 | **Design study complete (2026-08-20); exit Open** — bounds documented as capacity defaults pending calibration and implementation; see §4.5–§4.6; synthetic C-01/C-02 calibration evidence recorded §4.13 (2026-08-22, directional, non-adoption — does not close the calibration gate) |
| Retention/eviction policy design | Phase 4 | **Design study complete (2026-08-20); exit Open** — design/documentation only; pending gates in §4.12 |
| Data-access contract (read intents, completeness, ordering, context, mutation/stream) | Phase 5 | **Design study complete (2026-08-20); exit Open** — windowed/closure/answer-group intents (R-02..R-06), typed completeness, stable-ID anchoring, `sort_order`→`id` ordering, separate viewport/context projections, and lifecycle/concurrency defined in §5.1–§5.11 with bounded study record in §5.13 (documentation-only, no implementation, LOCK-P5-001..005); implementation requires coordinated IPC review; see §5.12–§5.13 |
| Specific index/query optimizations | Phase 6 | **Candidate slice S6.4 — not authorized**; depends on M1/M2/M3 diagnostics; requires ADR if schema/index change |
| File dual-state resolution | Phase 6 | **Candidate slice S6.5 — not authorized**; depends on M5 diagnostic; requires ADR if schema/authority boundary |
| FTS storage deduplication | Phase 6 | **Candidate slice S6.5 — not authorized**; depends on M4 measurement; requires ADR if schema change |
| Data-access implementation (windowed fetch, authority-aware actions, context closure) | Phase 6 | **Candidate slices S6.1–S6.3 — not authorized**; requires Phase 5 contract coordinated IPC review and calibration; see §6 Phase 6 |
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
- [`performance-workstreams.md`](./performance-workstreams.md) — Current actionable performance state (PERF-TOPIC-SWITCH/ECHO reclassified as independent post-refactor reference/reassessment workstreams, non-blocking; Phase 3 structurally Closed 2026-08-21).
- [`sync-mvp.md`](./sync-mvp.md) — Sync first-phase boundary (sync must adapt to this program).
- [`sync-powersync-spike.md`](./sync-powersync-spike.md) — PowerSync No-Go record (vendor-specific, not a constraint).
- [`sqlite-migration.md`](./sqlite-migration.md) — SQLite governance (authoritative, not modified).
- [`context-window.md`](./context-window.md) — Context window governance (authoritative, not modified).
- [`cherry-chat-application-identity.md`](./cherry-chat-application-identity.md) — Identity/compatibility governance (authoritative, not modified).
