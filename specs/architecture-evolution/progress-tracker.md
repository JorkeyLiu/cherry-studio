# Architecture Evolution Progress Tracker — Current-State Projection

> **Mutable current-state projection, not authority.** The canonical architecture evolution program is [`../../docs/architecture-evolution-program.md`](../../docs/architecture-evolution-program.md) — it owns intent, `ARCH-001..ARCH-012` locks, phase status, durable outcomes, and remaining risks. This tracker projects the current frontier, locked boundaries, and next batch only. It is replaced in place after each semantic batch; Git owns history.

---

## 1. Purpose and Authority Boundary

- This tracker is a mutable execution-state view for the Cherry Chat architecture evolution. It does not define product architecture, governance, or phase acceptance.
- Canonical authority remains `docs/architecture-evolution-program.md`. Any conflict defers to that document and its referenced ADRs/governance (`sqlite-migration.md`, `context-window.md`, `cherry-chat-application-identity.md`, `sync-mvp.md`).
- `ARCH-001..ARCH-012` remain locked in the canonical program. This tracker does not restate or reinterpret them — it reflects their current effect as frontier and blocked boundaries.

---

## 2. Current Frontier

- **Phase 4 Bounded Memory and Cache — exit Open.** Lifecycle foundation implemented as renderer-local, non-persistent, non-StoreSync groundwork: per-topic `chatData`/`segments`/`residentTopic` completeness (`chatData && segments` for same generation) with monotonic `applicabilityGeneration` and same-generation staged joint publication via one dispatch. `B-06` viewport bound (renderer-local, target max 200 groups, opposite-edge trim, anchor-preserving), `B-07` device-local persistent Keyv scroll cache (renderer-local index, max 256 topics / 90-day TTL LRU), `B-08` ContentSearch bound (renderer-local disposable session, at most one 500 live-`Range` chunk plus lightweight count metadata, cross-chunk rescan of current rendered DOM, target/DOM invalidation), `B-09` renderer context-closure active-topic retention (renderer-local, max one active topic) are implemented. Resident lifecycle and read-path observability are implemented as bounded scalar-only diagnostics — resident entry/completeness/generation via pure adapter plus read-path hit/miss reason, staged latency (success + failure), and discarded-attempt count (post-stage validation only) wired from `loadTopicMessagesThunk` and composed into Phase 4 snapshot/bound scalars (no IDs/content/paths/histories, no policy/persistence/IPC change). Thunk-driven lifecycle/read-path hardening now covers staged single/both-leg failures as staged failure rather than discard, malformed versus generation-mismatch distinction with rejected-payload non-publication, complete -> generation advance/incomplete -> reset -> retry scalar recomputation, and scalar/privacy invariants. Calibration of `B-01..B-05` remains directional, non-adoption.
- **Phase 5 Data-Access Contract — design complete, exit Open.** Read intents `R-02..R-06`, completeness semantics, deterministic `sort_order -> id` ordering, viewport vs context separation, and coordinated shared-contract review (both-side IPC/preload/Main) are direction-approved. No implementation beyond the contract is claimed by this phase.
- **Phase 6 DB-Health — `S6.1..S6.3` Authorized & Implemented; `S6.4`/`S6.5` Candidate — Not Authorized.** `S6.1` windowed reads (`R-02`/`R-03`), `S6.2` authority-aware actions, `S6.3` context closure and cache joins are implemented. `S6.4`/`S6.5` remain blocked. **M4 storage-duplication volume diagnostic default 10k and explicitly activated 50k synthetic profiles executed 2026-08-28 via `pnpm bench:m4-fts-dup` (exit 0, directional evidence only; S6.5 remains Candidate — Not Authorized; 1k/real corpora/physical DB size unresolved; no threshold/baseline/dedup authorized; harness inactive by default for future invocations; exact 50k metrics belong only in `performance-measurement.md` §6 and summary in `performance-workstreams.md` §2.4)**.
- **Phase 7 Startup / Phase 8 Future Sync — deferred, Open.** No activation; sync remains vendor-neutral compatibility only.
- **Next evidence-enabled batch (Requires decision — not Ready now):** M4 extended storage-duplication diagnostics — remaining 1k synthetic profile, real corpora, physical DB size, and post-measurement governance/ADR — each requires explicit Main/user activation; **default 10k and explicitly activated 50k synthetic profiles completed 2026-08-28 via `pnpm bench:m4-fts-dup` (exit 0, directional only; S6.5 remains Candidate — Not Authorized; exact 50k metrics belong only in `performance-measurement.md` §6 and summary in `performance-workstreams.md` §2.4)** — no schema/query/storage/IPC change authorized.

---

## 3. Decision Locks and Blocked Boundaries

- `ARCH-001..ARCH-012` locked in the canonical program; not reinterpreted here.
- `B-01..B-05` (inactive resident cap, logical retained payload 32 MiB, idle TTL, LRU, single-oversized rule) are **calibration candidates only — not adopted**. No production retention/eviction/TTL/LRU policy is active. Adoption requires empirical calibration evidence plus an explicit decision; directional artifacts alone do not authorize.
- `S6.4` (index/query) and `S6.5` (file dual-state / FTS dedup) are **Candidate — Not Authorized**. Each requires per-slice evidence and governance/ADR before any schema/query/storage change.
- **No boundary crossing without applicable governance.** IPC/preload/shared-contract (`§10.1.3`), persistence/migration/schema (`sqlite-migration.md`), runtime authority, context-window anchor (`context-window.md`), identity/compatibility/release/platform (`cherry-chat-application-identity.md`), and sync infrastructure/transport/vendor/account/E2EE (`sync-mvp.md` / `sync-powersync-spike.md`) remain blocked without their respective review or ADR. Renderer-local lifecycle/observability work must not introduce IPC, schema, persistence, StoreSync, or governed state changes.
- Phase exits remain locked: Phase 4 Open, Phase 5 Open, Phase 6 partially Open (`S6.4`/`S6.5`), Phase 7/8 Open (deferred).

---

## 4. Batch Execution Strategy — Semantic-Risk Boundary

Execution is batched at the **semantic-risk boundary**, not at file or test granularity.

- **Cadence per batch:** one reconnaissance pass -> one implementation batch within one semantic-risk boundary -> focused feedback during implementation -> one independent audit -> one authoritative `pnpm build:check` for the final exact code worktree state -> one signed-off commit. Audit correction loops only when accepted findings exist; no extra audit/build/commit cycles otherwise.
- **Batch sizing:** multi-file batches are allowed and preferred when cohesive (shared semantic and shared risk boundary). Avoid one-test / one-file phases as the default. Do not split a cohesive renderer-local change across multiple batches to inflate step count.
- **Focused verification during implementation:** targeted path/reference/heading/link searches and focused tests for the changed behavior run during implementation. They are local feedback, not the authoritative gate.
- **One audit / one gate / one commit per completed batch:** the independent audit and `pnpm build:check` each run once for the final exact worktree state of that batch, and the batch closes with a single commit. No append-only per-run logs are retained in this tracker.

---

## 5. Candidate Queue

### Ready now

Ready-now means independently authorized under current locks, renderer-local, and without governance crossing. Batches should be cohesive and are not required to be one file each. Candidates:

- No additional cohesive ready-now batch is currently identified; the queue remains empty until the next reconnaissance pass.

No tiny one-file tasks are listed as the default. If no cohesive ready-now batch exists, the queue is empty until the next reconnaissance pass identifies one.

### Requires decision or evidence — Not ready now

- Calibration activation and any post-calibration adoption decision for `B-01..B-05` (directional `C-01`/heap/pinned calibrations are measurement-only and do not authorize policy).
- `B-01..B-05` production retention/eviction/TTL/LRU policy, including any byte/logical-payload enforcement.
- `S6.4` index/query production changes and `S6.5` file dual-state / FTS dedup changes — each needs slice evidence plus ADR/governance; **M4 storage-duplication volume diagnostic (`pnpm bench:m4-fts-dup` with `M4_FTS_DUP_BENCH=1`, bounded 10k default) — harness inactive by default for future invocations; default 10k and explicitly activated 50k synthetic profiles executed 2026-08-28 (exit 0, directional only; S6.5 remains Candidate — Not Authorized; exact 50k metrics belong only in `performance-measurement.md` §6 and summary in `performance-workstreams.md` §2.4)** — remaining scale, real-corpus, physical-size measurement, and production inference still require explicit Main/user activation and governance.
- Phase 7 startup and Phase 8 sync implementation — deferred; Phase 8 requires governance activation and remains vendor-neutral.

---

## 6. Update Contract — Current-State Replacement

- After each semantic batch, **replace** the current state in this file in place. Retain only: current frontier, active locks/blocked boundaries, next authorized batch, and remaining risks.
- **Do not append** history, chronicles, or per-batch logs. Git owns history.
- **Exclude from this tracker:** commit hashes, ahead/behind counts, worktree dirtiness, per-run test counts/logs, raw measurement values, full artifact dumps, and completed-step chronicles. Reference the canonical program and Git log instead.

---

## 7. Completion and Reporting Contract

Per completed batch, report:

- Outcome and semantic boundary (what changed and why it was one batch).
- Changed files and the shared risk boundary they belong to.
- Audit verdict (pass/fail with disposition; correction loop only if findings were accepted).
- Authoritative gate result: `pnpm build:check` for the final exact code worktree state (pass/fail, authoritative evidence).
- Commit subject for the single signed-off commit that closed the batch.

No push unless explicitly authorized. No source/test/config/package/lockfile changes are introduced by this tracker itself.

---

## 8. References

- Canonical program: [`../../docs/architecture-evolution-program.md`](../../docs/architecture-evolution-program.md)
- Implemented reality: [`../../docs/architecture.md`](../../docs/architecture.md)
- Context window: [`../../docs/context-window.md`](../../docs/context-window.md)
- Sync boundary: [`../../docs/sync-mvp.md`](../../docs/sync-mvp.md)
- Performance measurement contract: [`../../docs/performance-measurement.md`](../../docs/performance-measurement.md)
