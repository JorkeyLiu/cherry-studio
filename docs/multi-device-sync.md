# Personal Multi-Device Sync — Current Reference

> **Status**: Current reference for personal multi-device sync. Limited validation; not production-ready.
> **Role**: This document owns sync goal, current approach, current status/limits, evidence, gaps, and next decision.
> **Fallback reference (conditional only)**: [Sync Architecture Selection](./sync-architecture-selection.md) — candidate analysis reusable only on a concrete current-path blocker with clear technical advantage.
> **Development principle**: This sync effort is initiated and evolved under `adaptive-development` principles: the intended outcome remains the anchor, current state and gap determine the next step, and design, implementation, evidence, and validation evolve together.
> **Last updated**: 2026-09-05 — bounded outbox/app-restart/replay evidence recorded; status remains limited validation, not production-ready.

## 1. Goal

Syncthing-like local-first personal multi-device sync with no Cherry Chat account.

- Each device keeps a complete local copy and remains usable offline. Sync is an explicit opt-in coordination layer, not a cloud-primary model.
- Devices are paired through device pairing and device trust. Pairing and device authentication are distinct from an account system.
- At any time the user connects to one user-selected compatible sync service: a personal-hosted relay they deploy themselves or that is deployed online. The service is a pluggable infrastructure choice, not a Cherry Chat account system.
- Target behavior is automatic online convergence plus cursor-based recovery after short disconnection, with no silent loss.

## 2. Current approach

The selected path is application operation-log plus thin personal-hosted HTTP relay.

- Chat authority stays in Main-process SQLite (`Data/chat.db` via `ChatDbAggregateService`). The renderer never holds a SQLite connection; all chat access goes through typed IPC.
- Supported stable mutations enqueue sync intent as an operation log that preserves business intent (create, edit, delete) rather than raw row diffs. Only stable persisted checkpoints are sync candidates; transient streaming state is not a sync event.
- A thin HTTP relay carries operations between paired devices. The relay stores and forwards operations; it never owns chat authority.
- Replay applies operations idempotently with deterministic last-writer-wins resolution and tombstone propagation for deletions.
- Payloads carry only allowlisted shareable fields. Credentials, derived data, device-local paths, and UI state stay out of the sync channel.

## 3. What current evidence establishes

- Main-owned SQLite remains the chat authority with the operation log captured alongside the enclosing mutation for supported stable paths. The log is sync intent only, not a second authority.
- The relay path moves operations between two profiles and converges them on covered topic, message, and message-block shapes, including offline backlog with retry and fail-closed behavior on authentication failure. Automatic online convergence and cursor-based recovery after short disconnection are validated for those covered shapes; assertions cover sync status, durable cursor advance, outbox drain, and truthful errors.
- Delete/recovery semantics are validated for covered topic/message/message-block paths: online hard delete propagation, offline hard delete with automatic recovery on reconnect, late-child suppression via the parent tombstone, soft-delete topic -> restoreTopic round trip with content preserved, and concurrent delete/edit convergence to a single agreed result without asserting a fixed winner.
- Ordinary edit semantics are validated for covered message shapes: online content edit automatic convergence; paused-transport independent-field edits preserving both fields; paused same-field edits converging to the existing timestamp-then-operationId LWW winner with observable conflict-count evidence; and bounded outbox/app-restart recovery for stable message content edits — clean-close same-message 3 edits, clean-close same-topic 3 messages x1 edit each, clean-close mixed backlog (message A x2 plus B/C x1), controlled SIGTERM single-edit same-profile relaunch, and direct SIGKILL single-edit same-profile relaunch. All are bounded synthetic/disposable macOS Electron E2E cases with the same test-side relay alive across the app relaunch unless stated otherwise.
- Field-clock conflict records may increase even for disjoint edits over an existing baseline clock, while fields still merge. This is current baseline-field-clock recording behavior, not a new product decision.
- The authoritative sync path is strictly authenticated push/pull plus cursor; SSE is notification-only and never decides convergence. Auth precedence (401 before any interruption handling), 503 pause behavior with counter/cursor preservation, resume, and independent push/pull direction barriers are validated under a controlled in-memory network-interruption harness only. Direction-level interruption is additionally proven on the real two-profile path: pull interruption after the relay accepted operations with pull held then auto-convergence, and push interruption with pending retained then automatic retry after release. Batch-internal partial push and page-internal partial pull are explicitly not claimed: relay push is atomic and no deterministic in-request barrier exists.
- Relay-side identical operation replay is accepted idempotently without cursor/opcount growth on the bounded test-side relay. This proves idempotent-accept handling only; it proves no real lost-response client timing.
- Bounded file-backed reference-relay restart is validated for covered shapes: operation/cursor retention and sequence continuity across a controlled owned-process SIGTERM restart with a disposable database, including a pending stable message edit queued during the outage converging after restart through two disposable profiles and Main SQLite IPC. Convergence is decided by strictly authenticated push/pull plus cursor; SSE remains hint-only.
- The above remains limited implementation-validation evidence for the covered shapes and the reference/test-side relay only. It establishes no larger/longer backlog or capacity behavior, no WAL/OS-crash/power-loss durability, no production relay lifecycle (deployment, upgrade, backup) readiness, and no compound/structured content, attachment, E2EE, or full product readiness.

## 4. Current gap to target

- Coverage beyond the validated topic, message, and message-block shapes remains unproven, including compound/complex operations, ordering under replay, and structured content, attachments, and incomplete snapshots, which stay excluded from sync payloads.
- Scale beyond covered history/outbox sizes remains unproven, including larger/longer backlog and capacity/write-amplification behavior. No capacity threshold or SLA is claimed.
- Lifecycle durability beyond the bounded restart and bounded single-edit app-restart cases remains unproven: multi-edit SIGTERM/SIGKILL backlog combinations are unproven; WAL/OS-crash/power-loss durability is explicitly unproven (direct SIGKILL relaunch proves bounded same-profile pending-edit recovery only, not storage durability under crash or power loss); relay production lifecycle (deployment, upgrade, backup) remains unproven; interruption evidence beyond direction-level push/pull barriers plus the bounded restart is unproven — batch-internal partial push and page-internal partial pull stay unclaimed.
- Push ordering beyond the covered delete/recovery and ordinary-edit paths (parents before children, deferred orphan handling, fail-closed acknowledgements and malformed payloads) and any fixed winner for concurrent delete/edit beyond the current LWW remain ungoverned.
- Conflict recovery UX, compound/structured content, attachments, and E2EE remain deferred: same-field resolution stays at the existing timestamp-then-operationId LWW with bounded conflict-count record only; there is no row-level conflict visibility and no dedicated recovery experience; structured content, attachments, and incomplete snapshots stay excluded from sync payloads; E2EE stays unproven; full product readiness stays unclaimed.

## 5. Next decision and step

The next decision is explicitly open and not authorized by this document: based on product priority, choose a bounded capacity/write-amplification probe versus entering compound/structured content validation, extending from the proven automatic-convergence plus delete/recovery, bounded outbox/app-restart, direction-level interruption, and idempotent-replay base only.

- Entry: an explicitly activated decision with claim, minimum sufficient method, and stopping condition.
- Exit: documented convergence and recovery behavior with accepted trade-offs and residual risks, or a reproducible blocker that triggers the fallback condition below.
- No production rollout follows from this step alone; production authorization remains a separate governed decision. No implementation authorization follows from this document update.

## 6. Temporary working judgments

These judgments guide the next step only. They are not product authority and change when evidence requires it.

- Transactional outbox for supported stable mutations: intent is enqueued inside the same aggregate transaction so a failed mutation leaves no orphaned intent.
- Authoritative path is strictly authenticated push/pull plus cursor; notification is never data authority: any push hint only wakes the device, and the authenticated pull and reconciliation path decides what converges.
- Field-level handling for covered shapes: creates merge by identity; updates carry only intentional changed fields; independent fields merge; same-field conflicts resolve by the existing timestamp-then-operationId LWW with a bounded observable conflict record while dedicated restore/conflict recovery experience stays deferred. Conflict records may increase even for disjoint edits over an existing baseline clock while fields still merge; this is current recording behavior, not a new winner or UI semantic.
- Deletion of covered shapes wins over late descendants: a late child arriving after the parent tombstone is suppressed and must not resurrect the parent; ordering-only changes are not propagated as sync operations; capture failures are reported truthfully and never as silent convergence.
- Restore means soft-delete topic -> restoreTopic round trip with content preserved; hard delete is irreversible and is not a restore feature.
- Payloads carry only allowlisted shareable fields; structured content, attachments, and incomplete snapshots stay excluded, as do credentials, derived data, device-local paths, and UI state.
- Relay interruption evidence is the controlled in-memory pause/resume harness plus the bounded file-backed SIGTERM restart plus bounded direction-level push/pull interruption on the real two-profile path only: disposable database, controlled owned process with ownership/cleanup boundaries, strictly authenticated push/pull plus cursor; the restart and interruption harnesses are explicit test infrastructure, not production lifecycle. No batch-internal partial-push/page-internal partial-pull, WAL/OS-crash/power-loss, capacity/SLA, or production deployment claim; concurrent delete/edit converges to one stable result with no fixed winner asserted beyond the current LWW. Relay-side identical replay accepted idempotently without cursor/opcount growth proves idempotent-accept handling only, not real lost-response client timing.
- Pending-edit recovery is bounded outbox/app-restart recovery for stable message content edits only: clean-close same-message 3 edits, same-topic 3 messages x1, mixed A x2 + B/C x1, controlled SIGTERM single-edit relaunch, and direct SIGKILL single-edit relaunch; multi-edit SIGTERM/SIGKILL backlog combinations stay unproven. Direct SIGKILL proves bounded same-profile recovery only and establishes no WAL/OS-crash/power-loss durability.

## 7. Evidence pointers

- Implementation: `src/main/services/sync/` (operation-log capture, apply, client), `packages/shared/sync/` (payload shape and filtering), `scripts/sync-relay/server.ts` (reference relay, non-production), additive sync metadata migrations `005_sync_metadata` + `006_sync_field_merge`.
- Integrated behavior: `tests/e2e/specs/sync/sync-two-profiles.spec.ts` (two-profile sync scope, including delete/recovery and ordinary-edit/concurrent-edit convergence; bounded outbox/app-restart backlog — `clean-close backlog of 3 stable edits survives relaunch then converges` [`9170ee3`], `clean-close multi-entity backlog of 3 messages each one edit survives relaunch then converges` plus `clean-close mixed backlog of A twice plus B/C once survives relaunch then converges` [`4648cff`], `pending edit survives controlled SIGTERM same-profile relaunch then converges` [`a78b128`], `pending edit survives direct SIGKILL same-profile relaunch then converges` [`5ae9a5f`]; direction-level interruption and idempotent replay — `pull interruption after push holds reader then auto-converges`, `push interruption holds relay then auto-retries after release`, `identical operation replay is idempotent at the relay` [`1022f889`]); `tests/e2e/specs/sync/sync-relay-restart.spec.ts` (bounded file-backed relay SIGTERM restart: operation/cursor retention and post-restart pending-edit convergence).
- Unit behavior: operation-log, apply, and relay suites alongside the paths above, plus `tests/e2e/utils/sync-relay-pause.test.ts` (in-memory pause/resume and direction-barrier determinism) and `tests/e2e/utils/sync-relay-process.ts` (explicit file-backed relay lifecycle test harness with ownership/cleanup boundaries; disposable database, controlled owned process).
- Current validation (implementation regression evidence, not production readiness): `pnpm test:e2e tests/e2e/specs/sync/sync-two-profiles.spec.ts --timeout=300000` — 17/17 passed after the bounded backlog matrix, 20/20 passed after the interruption/replay matrix; `pnpm build:check` — exit 0 on the exact replay worktree (lint/openapi/full Vitest passed, approximately 12052 passed / 90 skipped / 0 failed, Node ABI lane with Electron ABI 145 restored and SQL probe passed) and exit 0 with the same aggregate result on the prior backlog-matrix worktree; focused controlled-SIGTERM/direct-SIGKILL/clean-close recovery tests passed during their phases. All evidence is bounded synthetic/disposable macOS Electron E2E/test-side relay scope and must not be extrapolated to production readiness, capacity/SLA, power-loss/OS-crash/WAL durability, E2EE, attachments, or complex operations.
- Git owns run history; this document carries no per-run history.

## 8. Fallback activation condition

PowerSync, cr-sqlite with relay, Turso Database Sync, and Automerge-family approaches are conditional fallbacks only.

A fallback is considered only when both hold in the same concrete scenario: a reproducible blocker on the primary path against the goal in Section 1, and evidence of a clear advantage of that fallback in that same scenario. Activation requires a new explicit decision. No parallel comparison runs before that decision.
