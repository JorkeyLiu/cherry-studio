# Architecture Evolution Progress Tracker — Current-State Projection

> **Mutable current-state projection, not authority.** The canonical architecture evolution program is [`../../docs/architecture-evolution-program.md`](../../docs/architecture-evolution-program.md) — it owns intent, `ARCH-001..ARCH-012` locks, phase status, durable outcomes, and remaining risks. This tracker projects the current frontier, locked boundaries, and next batch only. It is replaced in place after each semantic batch; Git owns history. Evidence-only work does not default to progress unless bound to an explicitly activated decision/outcome with all four evidence-task fields (named decision/outcome, claim, minimum sufficient method, stopping condition); explicit activation alone is insufficient (see `performance-program.md` §4B).

---

## 1. Purpose and Authority Boundary

- This tracker is a mutable execution-state view for the Cherry Chat architecture evolution. It does not define product architecture, governance, or phase acceptance.
- Canonical authority remains `docs/architecture-evolution-program.md`. Any conflict defers to that document and its referenced ADRs/governance (`sqlite-migration.md`, `context-window.md`, `cherry-chat-application-identity.md`, `sync-mvp.md`).
- `ARCH-001..ARCH-012` remain locked in the canonical program. This tracker does not restate or reinterpret them — it reflects their current effect as frontier and blocked boundaries.

---

## 2. Current Frontier

- **Phase 4 Bounded Memory and Cache — closed 2026-08-29 (outcome/residual-risk based).** Renderer-local B-01..B-05 enforced alongside lifecycle and B-06/B-07/B-08/B-09; bounded scalar diagnostics. Calibration optional/non-blocking, measurement-only directional — C-01 8 profiles 92 metrics 12/12 gates, stream-persist 3 profiles 43 metrics 8/8 gates, both synthetic isolated, directional L3, future inactive, no threshold/baseline/SLA/capacity; C-02 heap diagnostic accepted — benchmark chatdb-c02-renderer-heap-e2e, schema-v1, ABI 145, uniform 23/12, mixed 48/9, all 48/9, all required gates pass, synthetic isolated, privacy-safe, directional measurement-only, no threshold/baseline/SLA/capacity/policy/closure, future inactive. Controlled regression and protected boundaries remain mandatory (§10.1).
- **Phase 5 Data-Access Contract — closed 2026-08-29 (outcome/residual-risk).** R-02..R-06 satisfied by S6.1-S6.3; S6.3 closure now carries Main-authoritative totalTurnCount/selectedTurnCount/boundaryMessageId from same complete SQLite turn set and anchor as closure slicing (Renderer bounded, messages anchor-to-end, no second IPC/full-topic/schema/persistence/anchor change); S6.4 Rejected, S6.5 Candidate — Not Authorized. LOCK-P5-005 preserved.
- **Phase 6 DB-Health — `S6.1..S6.3` Authorized & Implemented; `S6.4 SQ-01 Rejected 2026-08-29; M2/M3 batch closed; M1, B-01..B-05 calibration, M8, M4/M5 synthetic directional batch accepted 2026-09-01 (M4 50k + M5 medium one 1,000-reference dataset, 4 scenarios, synthetic directional L3) + 2026-09-02 M4 physical proxy extension (S6.5-E1, four raw metrics via WAL checkpoint + stat, sanitized failure paths, synthetic isolated, directional; S6.5 still Candidate — Not Authorized), all synthetic isolated directional-only, future inactive; S6.5 Candidate — Not Authorized (no ADR, no production design).** See program §6.7.1/§7.1/§7.3.2/§7.3.3 for four-field contracts and decision; no threshold/baseline/phase-closure or sync-schema/runtime-consistency claim; real-corpus/physical-cost/incidence/threshold remain unresolved.
- **Phase 7 Startup — S7.1–S7.13 Implemented & Closed 2026-09-02 (outcome/residual-risk; S7.12 attribution-only, controlled non-adoption; S7.13 attribution-only instrumentation, bounded privacy-safe, no production optimization/baseline/SLA/threshold/winner; S7.14-E1 evidence integrated 2026-09-02 renderer-owned behavior plus shared diagnostic stage-union extension, no IPC/preload/shared application contract change, isolated, directional — S7.14 not implemented/closed, no winner/threshold; S7.14+ deferred, later production optimization not authorized). See canonical §6.8.13 for S7.12, §6.8.14 for S7.13, §6.8.15 for S7.14-E1 (independent `__STARTUP_STAGE_ATTR__` gate default-off fail-closed, Main-authoritative exact disposable validation + opaque `__CHERRY_STARTUP_STAGE_VALIDATED` marker, bounded closed records; S7.13 9 Main + 4 renderer, S7.14-E1 `renderer.firstData` 14 stages one-shot interval `ordinaryTreeReady`→first eligible active-topic `fetchMessagesWindow` settlement, stale/eligibility gating, handler/preload/Dexie gaps remain — no timing-dominant winner can be ranked from current evidence, no IPC/preload/shared application contract/authority/schema/migration/StoreSync/Dexie-open change (shared diagnostic stage-union extension only)). Verification: S7.13 focused Vitest + `git diff --check` + audit/re-audit 0 findings + `pnpm build:check` exit 0 plus fresh enabled Electron runtime E2E `STARTUP_STAGE_ATTR=1 pnpm build` exit 0 then `STARTUP_STAGE_ATTR=1 STARTUP_STAGE_SYNTHETIC=1 pnpm test:e2e -- startup-stage-instrumentation.spec.ts` exit 0, 1 passed + S7.14-E1 focused Vitest (renderer `startupFirstData` 9 suites + thunk `messageThunk.firstData` 14 suites, stale-race corrected, final sharded audit 0 findings, `git diff --check`); residual enabled-E2E risk closed 2026-09-02; S7.14 not closed; handler/preload/Dexie/first-data real-corpus gaps remain
- **Phase 8 Future Sync — deferred, Open.** No activation; sync remains vendor-neutral compatibility only.

### 2.1 2026-09-01 M4/M5 Accepted Evidence — Compact Summary (full record in program §7.3.2)

**Activation**: Explicitly activated 2026-09-01; artifacts alone were not progress.

**Accepted evidence (synthetic directional L3, schema v1)**: M4 50k + M5 medium — one 1,000-reference synthetic dataset evaluated against 4 fixed deterministic scenarios, derived classification; both synthetic isolated, logical/derived only, no physical/real-corpus/production claim.

**Boundaries**: Both synthetic isolated, privacy-safe, measurement-only directional L3; **S6.5 remains Candidate — Not Authorized**; no baseline/threshold/SLA/capacity/policy/regression/phase-closure/production authorization; no code/config change; real-corpus/physical-size frontier unresolved; no ready-now production batch. Full four-field contracts, provenance, and decision in canonical `docs/architecture-evolution-program.md` §7.3.2; durable harness/artifact inventory in `docs/performance-measurement.md` §6; current actionable status in `docs/performance-workstreams.md` §2.4.

### 2.2 2026-09-02 S7.14-E1 First-Data Attribution — Compact Summary (full record in program §6.8.15)

**Activation**: Explicitly authorized 2026-09-02 as renderer-owned attribution-only isolated slice (renderer-owned behavior plus shared diagnostic stage-union extension, no IPC/preload/shared application contract change); artifacts alone not progress (S7.1–S7.13 remain closed, not reopened).

**Changed artifact scope**: `packages/shared/diagnostics/startupStage.ts` (shared diagnostic stage-union extension), `packages/shared/diagnostics/__tests__/startupStage.test.ts`, `src/renderer/src/services/startupStageDiagnostics.ts`, `src/renderer/src/store/thunk/messageThunk.ts`, `src/renderer/src/services/__tests__/startupFirstData.test.ts`, `src/renderer/src/store/thunk/__tests__/messageThunk.firstData.test.ts` — renderer-owned behavior plus shared diagnostic stage-union extension (no IPC/preload/shared application contract change), bounded numeric-only, one-shot, privacy-safe, default-off fail-closed; no application contract/authority/StoreSync/schema/migration/Dexie change.

**Accepted evidence (directional, non-adoption)**: `RENDERER_STARTUP_STAGES` extended with `renderer.firstData` (14 stages total); `renderer.firstData` interval `ordinaryTreeReady` → first eligible active-topic `fetchMessagesWindow` settlement, bounded finite non-negative `durationMs`/`elapsedMs`/`epochMs`, one-shot, ordered after `ordinaryTreeReady`, stale/eligibility gating (active-topic existence + pre-dispatch equality, first ineligible/cache-hit/non-active consumes window, stale/deletion/generation/superseded discarded at settlement).

**Four-field contract**: Named decision/outcome — S7.14-E1 accepted only when `renderer.firstData` bounded closed records produced under default-off gating; does not close S7.14, no winner/threshold. Claim — one-shot interval with stale/eligibility gating exactly as scoped. Minimum sufficient method — code + focused Vitest `startupFirstData` 9 suites + `messageThunk.firstData` 14 suites (stale-race corrected, real dispatch mutation, no leakage) via Node ABI lane, `git diff --check`, independent audits (final sharded 0 findings), authoritative gate separate. Stopping condition — all focused tests pass + no unhandled rejection + fail-closed when disabled/no-ready/already-recorded/ineligible consumes + audits pass + authoritative gate exit 0.

**Verification**: Focused Vitest 9 + 14 suites pass (default-off inert, fail-closed without ready, success/error one-shot, reset, lifecycle, stale predicate discard, active success/error, invalid/missing/no-topic/cache-hit/non-active consume, before-ready fail-closed, stale/topic-moved/deletion/generation/superseded discard) — first-data stale race corrected and verified; `git diff --check` pass; independent audits passed (final sharded audit 0 findings); authoritative gate separate.

**Boundaries / non-conclusions**: Renderer-owned behavior plus shared diagnostic stage-union extension (no IPC/preload/shared application contract change), synthetic isolated, directional only; **S7.14 not implemented/closed, no winner selected, no production optimization/threshold/baseline/SLA/phase-closure or application contract/authority/compatibility/schema/migration/index/trigger/StoreSync/identity/sync/release/platform change**; real-corpus/physical-cost/incidence/threshold, Dexie open/upgrade timing, handler/preload ordering gaps remain unresolved — S7.14-E1 remains directional only.

### 2.3 2026-09-02 S6.5-E1 M4 Physical Proxy — Compact Summary (full record in program §7.3.3)

**Activation**: Explicitly authorized 2026-09-02 as synthetic isolated measurement-only extension to M4; artifacts alone not progress.

**Changed artifact scope**: `src/main/services/chatDb/__tests__/m4FtsDuplication.bench.ts`, `src/main/services/chatDb/__tests__/m4FtsDuplication.ts`, `src/main/services/chatDb/__tests__/m4FtsDuplication.test.ts`, `src/main/services/chatDb/__tests__/benchResult.ts`, `src/main/services/chatDb/__tests__/m4PhysicalProxy.test.ts` — synthetic isolated only, four raw metrics, no derived bytes, no production code/config.

**Accepted evidence (synthetic directional L3, schema v1)**: Single `PRAGMA wal_checkpoint(TRUNCATE)` outside timed bench probe with busy/status parsing (`parseCheckpointBusy`/`assertCheckpointComplete`, fail-closed when `busy!=0` or unverifiable) then four approved raw physical metrics `page_count`/`page_size`/`freelist_count`/`dbFileBytes` (PRAGMA + `stat` after checkpoint, numeric-only, finite integer, bounded, path-free, no derived `pageBytes`/`freelistBytes`).

**Four-field contract**: Named decision/outcome — S6.5-E1 accepted only when four raw metrics collected after `busy==0`; does not authorize S6.5. Claim — four raw proxies numeric-only, exactly four IDs, no derived, collected only after `busy==0` else fail-closed before stat/artifact. Minimum sufficient method — owned `mkdtemp` synthetic SQLite 50k + single checkpoint outside probe + parsing + four PRAGMA/stat validated via `buildM4PhysicalMetrics`, sanitized fixed-category failure messages (no native path interpolation), read-only bench probe, focused Vitest (parsing/busy, four-metric, privacy audit, real SQLite integration), `git diff --check`, audit, authoritative gate separate. Stopping condition — all focused tests pass + privacy audit path-free + busy/unverifiable aborts before artifact + audit 0 findings + authoritative gate exit 0.

**Verification**: Focused Vitest via Node ABI lane (number/array/object parsing, busy==0 only, four-metric exactness, no derived, path-free audit even when native error contains macOS/Windows/relative paths, real PRAGMA/stat integration via `m4PhysicalProxy` + `m4FtsDuplication` suites) — all pass; `git diff --check` pass; final audit passed with 0 findings after sanitized failure paths; authoritative gate separate.

**Boundaries / non-conclusions**: Synthetic isolated, privacy-safe, measurement-only directional L3; **S6.5 remains Candidate — Not Authorized**; no baseline/threshold/SLA/capacity/policy/regression/phase-closure/production authorization or schema/migration/index/trigger/IPC/authority change; real-corpus/physical-cost/benefit/incidence/threshold, write-amplification remain unresolved directional unknowns.

Full four-field contracts, provenance, and decisions in `docs/architecture-evolution-program.md` §6.8.15 / §7.3.3; artifact inventory in `docs/performance-measurement.md` §6; status in `docs/performance-workstreams.md`.

---

## 3. Decision Locks and Blocked Boundaries

- `ARCH-001..ARCH-012` locked in the canonical program; not reinterpreted here. Phase closure is outcome/residual-risk based — accepted outcomes + boundary-matched regression + governance/delivery validation + explicitly accepted residual risk; harness completeness never closes (ARCH-009..012).
- `B-01..B-05` are **implemented renderer-local retention enforcement, not empirically optimal, not baselines/SLA, calibration optional/non-blocking**. No IPC/SQLite/schema/StoreSync/Main change.
- `S6.4` SQ-01 **Rejected 2026-08-29** and `S6.5` **Candidate — Not Authorized** — see program §6.7.1 for future reopening boundary; any schema/index ADR-gated.
- **S7.1–S7.13 Implemented & Closed 2026-09-02 (outcome/residual-risk; S7.12 attribution-only, S7.13 attribution-only instrumentation) — canonical §6.8.13 (S7.12), §6.8.14 (S7.13), §6.8.15 (S7.14-E1)** — S7.12 docs-only static topology (no production code/config, no IPC/schema/StoreSync/persist-key change; `persist:cherry-studio` preserved); S7.13 instrumentation-only (independent `__STARTUP_STAGE_ATTR__` gate default-off fail-closed, Main-authoritative exact disposable validation + opaque `__CHERRY_STARTUP_STAGE_VALIDATED` marker, bounded privacy-safe closed records, both renderer milestones with first-data/Dexie milestone intentionally omitted; no authority/contract/schema/migration/StoreSync/Dexie-open/baseline/SLA/winner); S7.14-E1 evidence integrated 2026-09-02 (renderer-owned behavior plus shared diagnostic stage-union extension, no IPC/preload/shared application contract change, isolated, directional, §6.8.15 — `renderer.firstData` one-shot interval `ordinaryTreeReady`→first eligible active-topic settlement, bounded numeric-only, stale/eligibility gating, audit passed after stale-race correction; S7.14 not implemented/closed, no winner/threshold); verification: S7.13 focused Vitest + `git diff --check` + audit/re-audit 0 findings + `pnpm build:check` exit 0 plus follow-up fresh enabled Electron runtime E2E `STARTUP_STAGE_ATTR=1 pnpm build` exit 0 then `STARTUP_STAGE_ATTR=1 STARTUP_STAGE_SYNTHETIC=1 pnpm test:e2e -- startup-stage-instrumentation.spec.ts` exit 0, 1 passed + S7.14-E1 focused Vitest 9 + 14 suites (stale-race corrected, final sharded audit 0 findings, `git diff --check`); residual enabled-E2E risk closed 2026-09-02, S7.13 remains Implemented & Closed, S7.14-E1 is directional only; S7.14+ deferred, later production optimization not authorized.
- **No boundary crossing without applicable governance.** IPC/preload/shared-contract (§10.1.3), persistence/migration/schema (`sqlite-migration.md`), runtime authority, context-window anchor (`context-window.md`), identity/compatibility/release/platform (`cherry-chat-application-identity.md`), and sync infrastructure/transport/vendor/account/E2EE (`sync-mvp.md` / `sync-powersync-spike.md`) remain blocked without review/ADR. Renderer-local work must not introduce IPC, schema, persistence, StoreSync, or governed state changes.
- Phase exits: Phase 4 closed 2026-08-29, Phase 5 closed 2026-08-29, Phase 6 partially Open (S6.4 Rejected/closed, S6.5 Candidate — Not Authorized — S6.5-E1 M4 physical proxy integrated 2026-09-02 synthetic isolated, no authorization), Phase 7 S7.1–S7.13 Implemented & Closed 2026-09-02 (outcome/residual-risk; S7.12 attribution-only, controlled non-adoption; S7.13 attribution-only instrumentation, no production optimization/baseline/SLA/threshold/winner; S7.14-E1 evidence integrated 2026-09-02 renderer-owned plus shared diagnostic stage-union, no application contract, isolated, directional, S7.14 not closed) per §6.8.13–§6.8.15 — Phase 7 remains partially Open (S7.14+ deferred, later production optimization not authorized); Phase 8 Open (deferred); no ready-now batch unless explicitly activated; no winner selected, handler/preload/Dexie/first-data and physical-cost gaps remain.
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

- No ready-now batch — S7.12 closed per §6.8.13 (attribution-only, docs-only, `git diff --check`); S7.13 Implemented & Closed per §6.8.14 (attribution-only instrumentation, `git diff --check` + focused Vitest + audit/re-audit 0 findings + `pnpm build:check` exit 0 plus follow-up fresh enabled Electron runtime E2E `STARTUP_STAGE_ATTR=1 pnpm build` exit 0 then `STARTUP_STAGE_ATTR=1 STARTUP_STAGE_SYNTHETIC=1 pnpm test:e2e -- startup-stage-instrumentation.spec.ts` exit 0, 1 passed, harness callback arity fix only, audit passed; residual enabled-E2E risk closed 2026-09-02 via enabled probe validating the observable 9 Main + 4 renderer bounded timeline, S7.13 remains Implemented & Closed but intentionally omitted Dexie/first-data boundaries and unresolved handler/preload ordering gap mean no timing-dominant winner can be ranked; S7.14-E1 evidence integrated 2026-09-02 per §6.8.15 (renderer-owned behavior plus shared diagnostic stage-union extension, no IPC/preload/shared application contract change, isolated, directional, `renderer.firstData` one-shot interval with stale/eligibility gating, focused 9 + 14 suites pass after stale-race correction, final sharded audit 0 findings, `git diff --check`; S7.14 not implemented/closed, no winner/threshold); S6.5-E1 M4 physical proxy integrated 2026-09-02 per §7.3.3 (synthetic isolated, four raw metrics via WAL checkpoint + stat - no corpus writes after seed; one isolated WAL checkpoint/TRUNCATE normalization step outside timed probe; then read-only metric collection - sanitized paths, audit passed; S6.5 still Candidate — Not Authorized); no winner selected, handler/preload/Dexie/first-data and physical-cost gaps remain; S7.14+ remains deferred, later production optimization not authorized); next batch requires explicit activation.

If no cohesive ready-now batch exists, the queue is empty until the next reconnaissance pass identifies one. Future short-query reopening requires a new explicitly defined candidate with materially different cost structure and a fresh four-field evidence contract; SQ-01 may not be silently revived.

### Requires decision or evidence — Not ready now

- Calibration activation for `B-01..B-05` — enforced renderer-local defaults; calibration optional/non-blocking synthetic directional L3 per frontier and program §7.3 (requires four-field activation); no threshold/baseline/SLA/phase-closure/production authorization.
- `S6.5` file dual-state / FTS dedup — **Candidate — Not Authorized** — see frontier and §7.1/§7.3.2/§7.3.3 (M4 50k + M5 medium synthetic directional L3 + 2026-09-02 M4 physical proxy four raw metrics via WAL checkpoint + stat, sanitized failure paths, synthetic isolated, directional; full record in §7.3.3; S6.5 still Candidate — Not Authorized); real-corpus/physical-size/physical-cost/incidence/threshold remain unresolved; requires explicit activation + ADR/governance; no production/runtime-consistency/sync authorization; no winner selected.
- Phase 7 S7.14+ and Phase 8 — deferred — S7.12 attribution per §6.8.13, S7.13 instrumentation Implemented & Closed per §6.8.14 (attribution-only, independent `__STARTUP_STAGE_ATTR__` gate default-off fail-closed, bounded privacy-safe 9 Main + 4 renderer bounded timeline observable via enabled probe, no authority/contract/schema/migration/StoreSync/Dexie-open/baseline/SLA/winner — intentionally omitted Dexie/first-data boundaries and unresolved handler/preload ordering gap mean no timing-dominant winner can be ranked from current evidence; later production optimization not authorized; residual enabled-E2E risk closed 2026-09-02 via fresh enabled E2E validating the observable 9 Main + 4 renderer bounded timeline, S7.13 remains Implemented & Closed) + S7.14-E1 first-data attribution evidence integrated 2026-09-02 per §6.8.15 (renderer-owned behavior plus shared diagnostic stage-union extension, no IPC/preload/shared application contract change, isolated, directional, `renderer.firstData` one-shot interval with stale/eligibility gating, S7.14 not implemented/closed, no winner/threshold; handler/preload/Dexie/first-data real-corpus/physical cost gaps remain); Phase 8 vendor-neutral, governance-gated; no ready-now production batch merely because evidence exists.

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
