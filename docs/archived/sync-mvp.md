# 同步 MVP 提案（Synchronization MVP Proposal）— Historical Record

> **Archived — historical record, not current.** This document is preserved unchanged below for audit. The current reference is [`../multi-device-sync.md`](../multi-device-sync.md). Do not use this file as an active design input.

> **Historical notice — superseded.** This document is a **historical record** of the Cherry Chat first-phase synchronization boundary proposal as of 2026-08-19. Its **Phase 0/1 proposal framing and open-question stance are superseded**. Current sync status is owned by [`../multi-device-sync.md`](../multi-device-sync.md); candidate analysis is preserved as fallback reference in [`../sync-architecture-selection.md`](../sync-architecture-selection.md). Do not use this file as an active design input.
> **What remains historically relevant**: the four durable boundary locks (SYNC-001…004), data-scope exclusion inventory, device-local vs cross-device authority distinction, and conflict-matrix inventory — preserved below in compressed form for audit.
> **What is no longer open**: "account vs no-account" is resolved — SYNC-S8-001 locks **no Cherry Chat account, device pairing, one user-selected service** (pairing/device trust distinct from an account system). Vendor selection and implementation authorization are not governed by this proposal.
> **Status at archival**: Proposal/Draft as of 2026-08-19; zero production code, dependency, schema, or vendor commitment. One disposable PowerSync spike executed under zero-production-change scope; harness disposed (see historical [`sync-powersync-spike.md`](./sync-powersync-spike.md)).
> **Related governance**: SQLite chat authority by [SQLite migration governance](../sqlite-migration.md); identity/platform/release by [Application Identity ADR](../cherry-chat-application-identity.md); context-window anchor by [Context window governance](../context-window.md); program-level S8 by [Architecture Evolution Program](../architecture-evolution-program.md) Phase 8.

---

## 1. Historical boundary locks (SYNC-001…004)

| # | Decision (as locked at proposal time) | Status at archival |
|---|---|---|
| **SYNC-001** | First phase = **documented MVP proposal + isolated disposable PowerSync spike only**; no production schema, write path, or dependency change. | Locked (historical); current S8 remains documentation/research only via canonical doc |
| **SYNC-002** | During spike, **device-local `chat.db` remained runtime authority**; cross-device authority and vendor selection were **not** finalized by the spike. | Locked (historical); still true until approved S8 migration |
| **SYNC-003** | Spike **did not synchronize**: credentials, derived FTS, Redux UI state, `contextWindowAnchor`, `file_references`/`file_path`, Knowledge, Memory, Trace, binary attachments, import artifacts, backup/restore state. | Locked (historical); exclusion still baseline per SYNC-S8-002 |
| **SYNC-004** | **Streaming token updates were not sync events**; only stable/final block checkpoints were candidates. | Locked (historical); checkpoint model preserved per SYNC-S8-002 |

## 2. Historical data scope (compressed)

- **Candidate (proposal only)**: stable/final `messages` / `message_blocks` / `topics` / `topic_segments` / ordering metadata. Not a commitment to synchronize.
- **Excluded (SYNC-003)**: as above; `file_path` is device-local and must never enter the sync channel.
- **Current-state readiness note (historical observation, not a decision)**: no revision/sync cursor/outbox/tombstone columns; `updated_at` nullable and not reliably maintained; hard delete `ON DELETE CASCADE` with no tombstone; FTS redundant storage. Future sync would require governed schema design.

## 3. Historical authority and topology note

Device-local authority (per-device `chat.db` via Main) vs cross-device authority (undecided at proposal time). The illustrative sync-engine-in-Main diagram was a **proposal placeholder**, not a process-placement decision. Snapshot: retained for conceptual history only.

## 4. Historical conflict matrix (inventory)

Known conflict classes inventoried: create (ID/duplicate), edit (same-message divergence), final streaming blocks, ordering, delete vs edit (tombstone), answer selection, segments, trash/restore. All cells were **open** at proposal time; resolution is now governed by S8 selection evidence, not by this matrix.

## 5. Historical phased plan and outcome

| Phase (proposal time) | Outcome |
|---|---|
| Phase 0 — Document boundaries | Delivered as this proposal (zero production change). |
| Phase 1 — Disposable PowerSync spike | Executed, **constraint-specific No-Go** under zero-production-change scope; harness disposed; evidence retained in historical spike record. |
| Phase 2 — Decision / Phase 3 — MVP implementation | **Not started** at archival; superseded by S8 Selection Validation (canonical doc). |

No privacy-policy change was made by this proposal; `PRIVACY.md` wording at proposal time remains as was.

## 6. Supersession

- **For all new sync work**: read [`../multi-device-sync.md`](../multi-device-sync.md) first. Candidate analysis in [`../sync-architecture-selection.md`](../sync-architecture-selection.md) is a conditional fallback reference only.
- **This file** remains only to preserve prior locks, exclusion inventory, and conflict taxonomy for audit. It does not authorize implementation, vendor commitment, schema change, or E2EE/account/attachment decisions.

*End of historical record — for superseded Phase 0/1 proposal; current reference is `../multi-device-sync.md`.*
