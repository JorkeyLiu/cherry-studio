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
- **Phase 5 Data-Access Contract — closed 2026-08-29 (outcome/residual-risk).** R-02..R-06 satisfied by existing S6.1-S6.3 implementation with boundary-matched static + Vitest + Playwright 10/10 (six-spec, preceding test state) plus final S6.2 focused 3/3 (three independent disposable profiles, final test state covering later semantic delta) and authoritative `pnpm build:check` exit 0 on exact final code/test state; closure accepted after final gate; preserves Main SQLite authority, stable-ID anchoring, deterministic `sort_order -> id`, semantic completeness isolation, viewport/context separation, generation applicability-only, coordinated IPC contract. Accepted residual risks: no tuple-cursor/revision/snapshot/linearizability; unbounded context closure when governed anchor requires it; pinned working set and per-topic FIFO have no global cap/progress guarantee; active-topic-only closure retention may refetch; coarse invalidation/fingerprint remain implementation risks; S6.4/S6.5 and PERF workstreams remain open/independent. Calibration optional/non-blocking, measurement-only directional; LOCK-P5-005 preserved.
- **Phase 6 DB-Health — `S6.1..S6.3` Authorized & Implemented; `S6.4 SQ-01` Candidate Defined — Evidence Authorized (decision evidence only; production Not Authorized); `S6.5` Candidate — Not Authorized.** See program §6.7.1 for SQ-01 shape, authorization boundary, and four-field contract; `S6.1` windowed reads, `S6.2` authority-aware actions, `S6.3` closure/cache-joins implemented; M4/M5 directional only (inactive by default), M6 harness not yet executed.
- **Phase 7 Startup / Phase 8 Future Sync — deferred, Open.** No activation; sync remains vendor-neutral compatibility only.

---

## 3. Decision Locks and Blocked Boundaries

- `ARCH-001..ARCH-012` locked in the canonical program; not reinterpreted here. Phase closure is outcome/residual-risk based — accepted outcomes + boundary-matched regression + governance/delivery validation + explicitly accepted residual risk; harness completeness never closes (ARCH-009..012 supplemented consistently).
- `B-01..B-05` (max 8 inactive evictable topics, 32 MiB logical budget, 30-minute TTL, deterministic LRU/lexical tie-break, oversized fail-closed and evictable after unpin) are **implemented renderer-local retention enforcement, not empirically optimal, not baselines/SLA, calibration optional/non-blocking, measurement-only directional**. No IPC/SQLite/schema/StoreSync/Main change; renderer-local, non-persistent, non-StoreSync.
- `S6.4` SQ-01 **Candidate Defined — Evidence Authorized (decision evidence only; production Candidate — Not Authorized)** and `S6.5` **Candidate — Not Authorized** — see program §6.7.1 for shape/boundary/contract; any schema/index ADR-gated; no production/IPC/StoreSync/threshold/baseline/SLA/`architecture.md` change.
- **No boundary crossing without applicable governance.** IPC/preload/shared-contract (§10.1.3), persistence/migration/schema (`sqlite-migration.md`), runtime authority, context-window anchor (`context-window.md`), identity/compatibility/release/platform (`cherry-chat-application-identity.md`), and sync infrastructure/transport/vendor/account/E2EE (`sync-mvp.md` / `sync-powersync-spike.md`) remain blocked without review/ADR. Renderer-local work must not introduce IPC, schema, persistence, StoreSync, or governed state changes.
- Phase exits: Phase 4 closed 2026-08-29 (outcome/residual-risk), Phase 5 closed 2026-08-29 (outcome/residual-risk), Phase 6 partially Open (`S6.4`/`S6.5`), Phase 7/8 Open (deferred).
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

- **S6.4 SQ-01 isolated synthetic comparison — Evidence Authorized (decision evidence only)** — isolated disposable production-shaped synthetic corpus (no real data): current LIKE scan vs SQ-01 gram projection; exact ordered parity + deterministic EXPLAIN SEARCH vs SCAN + directional read/write/storage/rollback per program §6.7.1 four-field contract (decision: advance to ADR / remain candidate / reject; claim: no threshold, includes codepoint≠UTF-16, normalization, matching, order, cursor/pagination, error propagation; method: 1-/2-codepoint cases — codepoint not UTF-16 — ASCII/CJK/astral-plane (emoji/supplementary)/mixed, substring + whole-word where regex owns matching only and order is fetch `sort_order`→`id`, mixed short+long, escaping/special, Markdown stripping, CRLF/CR normalization, lowercasing, empty/not-found, newest/oldest, multi-page cursor duplicate-free plus malformed-cursor and database/candidate-source failure parity non-silent; ≥3 trigram path unchanged). Creation limited to isolated harness/prototype artifacts; **not a production implementation batch** — production code/schema/index/migration/ADR remain unauthorized.

If no cohesive ready-now batch exists, the queue is empty until the next reconnaissance pass identifies one.

### Requires decision or evidence — Not ready now

- Calibration activation for `B-01..B-05` (now enforced renderer-local defaults, not empirically optimal; calibration optional/non-blocking, measurement-only directional, not thresholds/baselines/SLA; requires explicitly activated decision/outcome + four fields to count as valid/progress and did not block Phase 4 closure; Phase 4 closed outcome/residual-risk).
- `S6.4` production implementation — **Candidate — Not Authorized, not ready now** — blocked pending SQ-01 evidence outcome + ADR; see program §6.7.1; any schema/index ADR-gated.
- `S6.5` file dual-state / FTS dedup — **Candidate — Not Authorized**, each needs slice evidence plus ADR/governance; M4/M5 synthetic directional evidence does not authorize production inference. Real-corpus/physical-size remain unresolved; any S6.5 work still requires explicit Main/user activation, decision, privacy review where applicable, and ADR.
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
- Performance program (proportionality routing): [`../../docs/performance-program.md`](../../docs/performance-program.md)
