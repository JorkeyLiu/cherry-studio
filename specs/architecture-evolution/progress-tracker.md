# Architecture Evolution Progress Tracker — Current-State Projection

> **Mutable current-state projection, not authority.** The canonical architecture evolution program is [`../../docs/architecture-evolution-program.md`](../../docs/architecture-evolution-program.md) — it owns intent, `ARCH-001..ARCH-012` locks, phase status, durable outcomes, and remaining risks. This tracker projects the current frontier, locked boundaries, and next batch only. It is replaced in place after each semantic batch; Git owns history. Evidence-only work does not default to progress unless bound to an explicitly activated decision/outcome with all four evidence-task fields (named decision/outcome, claim, minimum sufficient method, stopping condition); explicit activation alone is insufficient (see `performance-program.md` §4B).

---

## 1. Purpose and Authority Boundary

- This tracker is a mutable execution-state view for the Cherry Chat architecture evolution. It does not define product architecture, governance, or phase acceptance.
- Canonical authority remains `docs/architecture-evolution-program.md`. Any conflict defers to that document and its referenced ADRs/governance (`sqlite-migration.md`, `context-window.md`, `cherry-chat-application-identity.md`, `sync-mvp.md`).
- `ARCH-001..ARCH-012` remain locked in the canonical program. This tracker does not restate or reinterpret them — it reflects their current effect as frontier and blocked boundaries.

---

## 2. Current Frontier

- **Phase 4 Bounded Memory and Cache — closed 2026-08-29 (outcome/residual-risk based).** Renderer-local retention enforcement B-01..B-05 enforced alongside lifecycle foundation and B-06/B-07/B-08/B-09; bounded scalar diagnostics. Calibration optional/non-blocking. Controlled regression and protected boundaries remain mandatory (§10.1).
- **Phase 5 Data-Access Contract — closed 2026-08-29 (outcome/residual-risk).** R-02..R-06 satisfied by S6.1-S6.3 implementation; S6.4 Rejected, S6.5 Candidate — Not Authorized. LOCK-P5-005 preserved.
- **Phase 6 DB-Health — `S6.1..S6.3` Authorized & Implemented; `S6.4 SQ-01 Rejected 2026-08-29; M2/M3 batch closed; M5 small-profile and M6 small-profile directional L3 evidence completed 2026-08-31 (M5 100-reference/4-scenario 5/5 gates `chatdb-m5-file-dual-state-20260831-232513.325.json` and M6 7/7 gates `chatdb-m6-sync-metadata-gap-small-20260831-232423.448.json`, both Node 24.11.1/pnpm 10.27.0/ABI 137, commit 9a929453695bec9c5b68b23dc4035589998319e9 clean, synthetic isolated, schema-v1 numeric-only, privacy-safe, directional-only, analysis-only); `S6.5` Candidate — Not Authorized.** See program §6.7.1/§7.1–§7.2 for decision and future reopening boundary; no threshold/baseline/phase-closure or sync-schema/runtime-consistency claim.
- **Phase 7 Startup — S7.1–S7.11 Implemented & Closed 2026-08-31 (outcome/residual-risk); S7.12+ deferred — production implementation not activated (LOCK-002). See canonical §6.8.12 for outcome, verification (validation/audits passed), and residual risks. Phase 7 remains partially Open. S7.12 reconnaissance/harness is attribution-only, directional only (no baseline/SLA/threshold/regression proof); Redux rehydration corrected to localStorage (`redux-persist/lib/storage`, key `persist:cherry-studio`, `persist:cherry-studio` preserved per LOCK-COMPAT-003); Dexie timing omitted per resulting harness artifact (LOCK-001/LOCK-004).**
- **Phase 8 Future Sync — deferred, Open.** No activation; sync remains vendor-neutral compatibility only.

---

## 3. Decision Locks and Blocked Boundaries

- `ARCH-001..ARCH-012` locked in the canonical program; not reinterpreted here. Phase closure is outcome/residual-risk based — accepted outcomes + boundary-matched regression + governance/delivery validation + explicitly accepted residual risk; harness completeness never closes (ARCH-009..012).
- `B-01..B-05` are **implemented renderer-local retention enforcement, not empirically optimal, not baselines/SLA, calibration optional/non-blocking**. No IPC/SQLite/schema/StoreSync/Main change.
- `S6.4` SQ-01 **Rejected 2026-08-29** and `S6.5` **Candidate — Not Authorized** — see program §6.7.1 for future reopening boundary; any schema/index ADR-gated.
- **S7.1–S7.11 Implemented & Closed 2026-08-31 (outcome/residual-risk) — canonical §6.8.2–§6.8.12** (renderer-local; validation/audits passed per canonical §6.8.12, no governance crossing). S7.11 changes only the bootstrap call site for StoreSyncService.subscribe(), subscribeTopicDeletionEvents(), webTraceService.init() (static imports, synchronous StoreSync→TopicDeletion→WebTrace, independent try/catch, one Bootstrap logger, bounded distinct warnings; no StoreSync service-internal/authority/contract/Main/preload/shared IPC/persistence/lifecycle/delay/dynamic import/buffering/replay/readiness change; topology only). Historical S7.1–S7.10 details in canonical §6.8.2–§6.8.11; S7.12+ deferred — production implementation not activated; reconnaissance/harness is attribution-only, directional only, no baseline/SLA/threshold; `persist:cherry-studio` preserved.
- **No boundary crossing without applicable governance.** IPC/preload/shared-contract (§10.1.3), persistence/migration/schema (`sqlite-migration.md`), runtime authority, context-window anchor (`context-window.md`), identity/compatibility/release/platform (`cherry-chat-application-identity.md`), and sync infrastructure/transport/vendor/account/E2EE (`sync-mvp.md` / `sync-powersync-spike.md`) remain blocked without review/ADR. Renderer-local work must not introduce IPC, schema, persistence, StoreSync, or governed state changes.
- Phase exits: Phase 4 closed 2026-08-29, Phase 5 closed 2026-08-29, Phase 6 partially Open (S6.4 Rejected/closed, S6.5 Candidate — Not Authorized), Phase 7 S7.1–S7.11 Implemented & Closed 2026-08-31 (outcome/residual-risk); S7.12+ deferred / Phase 7 remains partially Open, Phase 8 Open (deferred); no ready-now batch unless explicitly activated.
- **Evidence-task contract**: every evidence task binds to an explicitly activated decision/outcome, claim, minimum sufficient method, and stopping condition (all four required); evidence-only work without all four does not count as progress and cannot close a phase/workflow.

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

- No ready-now batch. S7.11 Implemented & Closed per canonical §6.8.12 (validation/audits passed); next batch requires explicit activation.

If no cohesive ready-now batch exists, the queue is empty until the next reconnaissance pass identifies one. Future short-query reopening requires a new explicitly defined candidate with materially different cost structure and a fresh four-field evidence contract; SQ-01 may not be silently revived.

### Requires decision or evidence — Not ready now

- Calibration activation for `B-01..B-05` (now enforced renderer-local defaults, not empirically optimal; calibration optional/non-blocking, measurement-only directional, not thresholds/baselines/SLA; requires explicitly activated decision/outcome + four fields to count as valid/progress and did not block Phase 4 closure; Phase 4 closed outcome/residual-risk).
- `S6.5` file dual-state / FTS dedup — **Candidate — Not Authorized**, each needs slice evidence plus ADR/governance; M4/M5 synthetic directional L3 evidence completed 2026-08-31 (M5 small-profile 100-reference/4-scenario 5/5 gates `chatdb-m5-file-dual-state-20260831-232513.325.json`, Node 24.11.1/pnpm 10.27.0/ABI 137, commit 9a929453695bec9c5b68b23dc4035589998319e9 clean, synthetic isolated, schema-v1 numeric-only, privacy-safe, directional-only, analysis-only) does not authorize production inference. Real-corpus/physical-size remains unresolved; any S6.5 work still requires explicit Main/user activation, decision, privacy review where applicable, and ADR; no S6.5 authorization, no threshold/baseline/phase-closure, no runtime-consistency (M5) claim.
- Phase 7 S7.12+ and Phase 8 sync implementation — deferred (S7.1–S7.11 Implemented & Closed; S7.12+ not authorized for production — no Main/preload/shared IPC/SQLite/Dexie/StoreSync/identity/release/migration/sync/background/telemetry expansion beyond S7.11 scope and no Markdown/ReactMarkdown or editor KaTeX Inputbar/Main startup reorder/Redux/Dexie/SQLite/background windows/S6.5/Phase 8 expansion beyond S7.11; S7.12 reconnaissance/harness if present is attribution-only, directional only, not baselines/SLA/threshold/regression proof; Redux rehydration factual source is localStorage `persist:cherry-studio`; Dexie timing omitted per harness artifact); Phase 8 requires governance activation and remains vendor-neutral.

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
