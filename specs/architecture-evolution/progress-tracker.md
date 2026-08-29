# Architecture Evolution Progress Tracker — Current-State Projection

> **Mutable current-state projection, not authority.** The canonical architecture evolution program is [`../../docs/architecture-evolution-program.md`](../../docs/architecture-evolution-program.md) — it owns intent, `ARCH-001..ARCH-012` locks, phase status, durable outcomes, and remaining risks. This tracker projects the current frontier, locked boundaries, and next batch only. It is replaced in place after each semantic batch; Git owns history. Evidence-only work does not default to progress unless bound to an explicitly activated decision/outcome with all four evidence-task fields (named decision/outcome, claim, minimum sufficient method, stopping condition); explicit activation alone is insufficient (see `performance-program.md` §4B).

---

## 1. Purpose and Authority Boundary

- This tracker is a mutable execution-state view for the Cherry Chat architecture evolution. It does not define product architecture, governance, or phase acceptance.
- Canonical authority remains `docs/architecture-evolution-program.md`. Any conflict defers to that document and its referenced ADRs/governance (`sqlite-migration.md`, `context-window.md`, `cherry-chat-application-identity.md`, `sync-mvp.md`).
- `ARCH-001..ARCH-012` remain locked in the canonical program. This tracker does not restate or reinterpret them — it reflects their current effect as frontier and blocked boundaries.

---

## 2. Current Frontier

- **Phase 4 Bounded Memory and Cache — closed 2026-08-29 (outcome/residual-risk based).** Renderer-local retention enforcement B-01..B-05 (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin) enforced alongside lifecycle foundation (per-topic `chatData`/`segments`/`residentTopic` completeness with monotonic `applicabilityGeneration` and same-generation staged joint publication via one dispatch) and B-06 viewport bound (renderer-local, target max 200 groups), B-07 device-local Keyv scroll cache (renderer-local index, max 256 topics / 90-day TTL LRU), B-08 ContentSearch bound (renderer-local disposable, at most one 500 live-Range chunk), B-09 active-topic retention (max one); bounded scalar diagnostics (no policy/persistence/IPC/SQLite/schema/StoreSync/Main change). Evidenced by focused regression (Vitest), direct diagnostic UI observation (diagnostic only, not regression proof; limited non-bottom overflow coverage), independent audit pass, and authoritative `pnpm build:check` pass (exit 0) on exact final worktree; calibration optional/non-blocking, not thresholds/baselines/SLA, harness inactive by default and requires explicitly activated decision/outcome + four fields to count as valid/progress. Controlled regression and protected boundaries remain mandatory (§10.1). Accepted residual risks: contextCount=null closure may be large; pinned active/in-flight working set excluded; stream queue no global cap; logical bytes not heap SLA; tuning may change; renderer-local scalar observability only; PERF workstreams remain independent/open.
- **Phase 5 Data-Access Contract — closed 2026-08-29 (outcome/residual-risk).** R-02..R-06 satisfied by existing S6.1-S6.3 implementation with boundary-matched static + Vitest + Playwright 10/10 (six-spec, preceding test state) plus final S6.2 focused 3/3 (three independent disposable profiles, final test state covering later semantic delta) and authoritative `pnpm build:check` exit 0 on exact final code/test state; closure accepted after final gate; preserves Main SQLite authority, stable-ID anchoring, deterministic `sort_order -> id`, semantic completeness isolation, viewport/context separation, generation applicability-only, coordinated IPC contract. Accepted residual risks: no tuple-cursor/revision/snapshot/linearizability; unbounded context closure when governed anchor requires it; pinned working set and per-topic FIFO have no global cap/progress guarantee; active-topic-only closure retention may refetch; coarse invalidation/fingerprint remain implementation risks; S6.4 Rejected 2026-08-29 (no ADR, current LIKE retained), S6.5 Candidate — Not Authorized, and PERF workstreams remain independent/Open. Calibration optional/non-blocking, measurement-only directional; LOCK-P5-005 preserved.
- **Phase 6 DB-Health — `S6.1..S6.3` Authorized & Implemented; `S6.4 SQ-01 Rejected 2026-08-29 — no ADR, no production implementation, current LIKE retained (search order `created_at -> message.id -> block_id` — parity target; future candidate evidence must verify parity; no `architecture.md` change); M2/M3 evidence batch closed; `S6.5` Candidate — Not Authorized.** See program §6.7.1 for decision, rationale, evidence basis, ordering correction (evidence wording only), and future reopening boundary (new candidate with materially different cost structure + fresh four-field contract; SQ-01 not silently revived); `S6.1` windowed reads, `S6.2` authority-aware actions, `S6.3` closure/cache-joins implemented; M4/M5 directional only (inactive by default), M6 harness not yet executed. Future short-query reopening requires new explicitly defined candidate and fresh four-field evidence contract before any evidence work counts as progress.
- **Phase 7 Startup — S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk) — five secondary top-level routes lazy as distinct production chunks, Home/sidebar/navigation/App gates eager; localized bounded loading; tagged chunk-load recovery with retry/Home, untagged bubble global; renderer-only, no governance crossing; evidenced by production distinct chunks + focused Vitest + fresh-build shared-fixture Playwright (all five rendered, resource deltas) + diagnostic observation + independent audit + authoritative `pnpm build:check`.** Phase 7 remains partially Open — S7.2+ Open (deferred); no ready-now batch. Rollback one semantic revert to eager imports, no migration. Accepted residual risks: first navigation transient loading; retry best-effort if underlying resource remains unavailable; chunk count/topology may evolve; E2E uses route-associated resource deltas not names; diagnostics limited to representative routes and not regression proof; PERF workstreams independent/open.
- **Phase 8 Future Sync — deferred, Open.** No activation; sync remains vendor-neutral compatibility only.

---

## 3. Decision Locks and Blocked Boundaries

- `ARCH-001..ARCH-012` locked in the canonical program; not reinterpreted here. Phase closure is outcome/residual-risk based — accepted outcomes + boundary-matched regression + governance/delivery validation + explicitly accepted residual risk; harness completeness never closes (ARCH-009..012 supplemented consistently).
- `B-01..B-05` (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin) are **implemented renderer-local retention enforcement, not empirically optimal, not baselines/SLA, calibration optional/non-blocking, measurement-only directional**. No IPC/SQLite/schema/StoreSync/Main change; renderer-local, non-persistent, non-StoreSync.
- `S6.4` SQ-01 **Rejected 2026-08-29 — no ADR, no production design/implementation; current <3-codepoint LIKE fallback retained, ≥3 trigram FTS, exact regex authority, search order `created_at -> message.id -> block_id` unchanged; M2/M3 batch closed** and `S6.5` **Candidate — Not Authorized** — see program §6.7.1 for decision/rationale/evidence basis and future reopening boundary (new candidate with materially different cost structure + fresh four-field contract; SQ-01 not silently revived); any schema/index ADR-gated; no production/IPC/StoreSync/threshold/baseline/SLA/`architecture.md` change; synthetic evidence not a baseline/threshold/SLA.
- **S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk) — canonical §6.8.2:** five secondary routes lazy as distinct production chunks, Home/sidebar/navigation/App gates eager; localized bounded loading; tagged chunk-load recovery with retry/Home, untagged bubble global; renderer-only, no Main/preload/shared IPC/SQLite/Dexie/StoreSync/identity/sync/context-window governance crossing; production distinct chunks + focused Vitest + fresh-build shared-fixture Playwright (route-associated deltas, all five rendered) + diagnostic observation + independent audit + authoritative `pnpm build:check`; no threshold/baseline/SLA; ARCH-010 disposed; Phase 7 remains partially Open (S7.2+ deferred); no ready-now batch; rollback one semantic revert, no migration.
- **No boundary crossing without applicable governance.** IPC/preload/shared-contract (§10.1.3), persistence/migration/schema (`sqlite-migration.md`), runtime authority, context-window anchor (`context-window.md`), identity/compatibility/release/platform (`cherry-chat-application-identity.md`), and sync infrastructure/transport/vendor/account/E2EE (`sync-mvp.md` / `sync-powersync-spike.md`) remain blocked without review/ADR. Renderer-local work must not introduce IPC, schema, persistence, StoreSync, or governed state changes.
- Phase exits: Phase 4 closed 2026-08-29 (outcome/residual-risk), Phase 5 closed 2026-08-29 (outcome/residual-risk), Phase 6 partially Open (`S6.4` Rejected/closed 2026-08-29, `S6.5` Candidate — Not Authorized), Phase 7 S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk), S7.2+ deferred / Phase 7 remains partially Open, Phase 8 Open (deferred); no ready-now batch authorized.
- **Evidence-task contract**: every evidence task binds to an explicitly activated decision/outcome, claim, minimum sufficient method, and stopping condition (all four required; explicit activation alone is insufficient); evidence-only work without all four does not count as progress and cannot close a phase/workflow.

---

## 4. Batch Execution Strategy — Semantic-Risk Boundary

Execution is batched at the **semantic-risk boundary**, not at file or test granularity.

- **Cadence per batch:** one reconnaissance pass -> one implementation batch within one semantic-risk boundary -> focused feedback during implementation -> one independent audit -> one authoritative `pnpm build:check` for the final exact code worktree state -> one signed-off commit. Audit correction loops only when accepted findings exist; no extra cycles otherwise.
- **Batch sizing:** multi-file batches are allowed and preferred when cohesive (shared semantic and shared risk boundary). Avoid one-test / one-file phases as the default.
- **Focused verification during implementation:** targeted path/reference/heading/link searches and focused tests for the changed behavior run during implementation. They are local feedback, not the authoritative gate.
- **One audit / one gate / one commit per completed batch:** the independent audit and `pnpm build:check` each run once for the final exact worktree state, followed by a single commit. No append-only per-run logs are retained.

---

## 5. Candidate Queue

### Ready now

Ready-now means independently authorized under current locks, renderer-local, and without governance crossing. Batches should be cohesive and are not required to be one file each.

- **None — no ready-now batch authorized.** S7.1 Implemented & Closed 2026-08-30 (outcome/residual-risk); S7.2+ remain Open/deferred per canonical §6.8; Phase 7 remains partially Open. Any future batch requires separate explicit authorization; SQ-01 may not be silently revived.

If no cohesive ready-now batch exists, the queue is empty until the next reconnaissance pass identifies one. Future short-query reopening requires a new explicitly defined candidate with materially different cost structure and a fresh four-field evidence contract (named decision/outcome, claim, minimum sufficient method, stopping condition); SQ-01 may not be silently revived.

### Requires decision or evidence — Not ready now

- Calibration activation for `B-01..B-05` (now enforced renderer-local defaults, not empirically optimal; calibration optional/non-blocking, measurement-only directional, not thresholds/baselines/SLA; requires explicitly activated decision/outcome + four fields to count as valid/progress and did not block Phase 4 closure; Phase 4 closed outcome/residual-risk).
- `S6.5` file dual-state / FTS dedup — **Candidate — Not Authorized**, each needs slice evidence plus ADR/governance; M4/M5 synthetic directional evidence does not authorize production inference. Real-corpus/physical-size remain unresolved; any S6.5 work still requires explicit Main/user activation, decision, privacy review where applicable, and ADR.
- Phase 7 S7.2+ and Phase 8 sync implementation — deferred (S7.1 is the only authorized Phase 7 slice; no Main reorder, Antd locale split, Inputbar, telemetry, or retention/deletion authorized); Phase 8 requires governance activation and remains vendor-neutral.

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
- Performance program (proportionality routing): [`../../docs/performance-program.md`](../../docs/performance-program.md)
