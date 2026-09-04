# Personal Multi-Device Sync — Current Reference

> **Status**: Current reference for personal multi-device sync. Limited validation; not production-ready.
> **Role**: This document owns sync goal, current approach, current status/limits, evidence, gaps, and next decision.
> **Fallback reference (conditional only)**: [Sync Architecture Selection](./sync-architecture-selection.md) — candidate analysis reusable only on a concrete current-path blocker with clear technical advantage.

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

- Main-owned SQLite remains the chat authority with the operation log captured alongside the enclosing mutation for supported stable paths.
- The relay path moves operations between two profiles and converges them on covered topic, message, and message-block shapes, including offline backlog with retry and fail-closed behavior on authentication failure.
- Push ordering places parents before children with deferred handling of temporarily orphaned children; acknowledgements fail closed when no progress is confirmed; malformed payloads fail closed rather than converging silently.
- The above is limited validation of the covered shapes and the reference relay only. It does not establish production readiness.

## 4. Current gap to target

- Automatic online convergence and cursor-based recovery after short disconnection are the target but are not yet the validated behavior; current validated behavior is endpoint-driven.
- Coverage beyond the validated topic, message, and message-block shapes, including compound operations, ordering under replay, and structured content handling, remains unproven.
- Relay production lifecycle (durability, deployment, upgrade, backup) remains unproven for the reference relay.

## 5. Next decision and step

Validate automatic online convergence with cursor-based recovery on the primary operation-log plus relay path for the covered shapes, then extend coverage only from that proven base.

- Entry: an explicitly activated decision with claim, minimum sufficient method, and stopping condition.
- Exit: documented convergence and recovery behavior with accepted trade-offs and residual risks, or a reproducible blocker that triggers the fallback condition below.
- No production rollout follows from this step alone; production authorization remains a separate governed decision.

## 6. Temporary working judgments

These judgments guide the next step only. They are not product authority and change when evidence requires it.

- Transactional outbox for supported stable mutations: intent is enqueued inside the same aggregate transaction so a failed mutation leaves no orphaned intent.
- Notification is never data authority: any push hint only wakes the device; the authenticated pull and reconciliation path decides what converges.
- Field-level handling for covered shapes: creates merge by identity; updates carry only intentional changed fields; independent fields merge; same-field conflicts resolve deterministically with a bounded observable conflict record while dedicated restore experience stays deferred.
- Deletion of covered shapes wins over late descendants; ordering-only changes are not propagated as sync operations; capture failures are reported truthfully and never as silent convergence.

## 7. Evidence pointers

- Implementation: `src/main/services/sync/` (operation-log capture, apply, client), `packages/shared/sync/` (payload shape and filtering), `scripts/sync-relay/server.ts` (reference relay, non-production), additive sync metadata migrations `005_sync_metadata` + `006_sync_field_merge`.
- Integrated behavior: `tests/e2e/specs/sync/sync-two-profiles.spec.ts` (two-profile sync scope).
- Unit behavior: operation-log, apply, and relay suites alongside the paths above.
- Git owns run history; this document carries no per-run history.

## 8. Fallback activation condition

PowerSync, cr-sqlite with relay, Turso Database Sync, and Automerge-family approaches are conditional fallbacks only.

A fallback is considered only when both hold in the same concrete scenario: a reproducible blocker on the primary path against the goal in Section 1, and evidence of a clear advantage of that fallback in that same scenario. Activation requires a new explicit decision. No parallel comparison runs before that decision.
