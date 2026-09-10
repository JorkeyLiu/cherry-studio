# Sync Data Convergence — Approved ADR

> **Status**: Approved / Authoritative (target semantics).
> **Decision namespace**: `SYNC-DATA-*` (durable; this ADR owns these IDs).
> **Role**: This ADR owns target personal multi-device data-convergence semantics only: what complete synchronization means, what state may move, how divergent histories converge, and when a device may truthfully claim convergence. It does not own current implementation status, evidence, gaps, or next step — those live in [Personal Multi-Device Sync](./multi-device-sync.md). It does not own connection/registration/channel/pairing semantics — those live in [Sync Connection, Registration, and Hidden Multi-Channel Pairing ADR](./sync-connection-channel.md) (`SYNC-CC-*`). It does not own candidate/fallback analysis — that lives in [Sync Architecture Selection](./sync-architecture-selection.md) (conditional fallback reference only).
> **Non-implementation**: No protocol/code implementation is authorized by this ADR. Implementation requires a separate explicitly activated decision and step.
> **Development principle**: This ADR is governed by `adaptive-development` principles: the intended outcome remains the anchor, current state and gap determine the next step, and design, implementation, evidence, and validation evolve together.
> **Last updated**: 2026-09-10

---

## 1. Context and problem

The implemented operation log converges covered topic, message, and message-block shapes between devices that share history, but the product question it does not answer is data convergence: what a newly paired device receives, what two devices with pre-existing independent data become, how a third device joins later, how long history survives retention, how divergence is detected and repaired, and when the UI may claim devices hold the same user data.

Without locked convergence semantics, each of those questions invites a local shortcut — raw database copy, one-directional overwrite, absence treated as deletion, cursor reset on missing history, or push/pull retry presented as reconciliation — that would silently lose user data or falsely claim synchronization. This ADR locks the target convergence semantics as the design authority for complete synchronization of the syncable personal-data domain.

## 2. Authority boundary

- **This ADR owns**: the definition of complete synchronization for the syncable personal-data domain; local-first authority placement for converged data; the hybrid baseline plus operation-log plus reconciliation shape; logical baseline properties and exclusions; first-pairing and late-join convergence rules; identity, field-merge, same-field ordering, and tombstone semantics; baseline-watermark binding and local/outbox preservation; aggregate completeness; the syncable-data inventory requirement; retention/compaction preconditions; manifest/digest reconciliation and repair; data-convergence status semantics; Disconnect/Unpair data consequences; version-incompatibility and failure semantics for convergence.
- **This ADR does not own**: current implementation status/evidence/gaps/next step ([multi-device-sync.md](./multi-device-sync.md)); connection/registration/channel/pairing semantics ([sync-connection-channel.md](./sync-connection-channel.md)); fallback candidate analysis ([sync-architecture-selection.md](./sync-architecture-selection.md)); application identity, updater/release freeze, platform scope ([cherry-chat-application-identity.md](./cherry-chat-application-identity.md)); SQLite chat authority and migration process ([sqlite-migration.md](./sqlite-migration.md)); context-window semantics ([context-window.md](./context-window.md)).
- **This ADR does not authorize**: protocol implementation, endpoint shapes, payload schemas, chunking, digest algorithms, baseline source election, retention durations, attachment transport, E2EE design, schema migrations, IPC changes, or any code change. It creates no permissions/admin/merge/GC schedule beyond what is written here.

## 3. Decision table (`SYNC-DATA-*`)

| # | Decision | Status |
|---|---|---|
| **SYNC-DATA-001** | The user-observable product is complete synchronization of the explicitly versioned syncable personal-data domain: after convergence, each paired device holds the same logical user data for the claimed domain. Operation transport alone is not the product; moving operations without reaching the same logical state does not satisfy this ADR. | **Locked** |
| **SYNC-DATA-002** | Each device remains local-first with Main SQLite authoritative locally for its own copy. The relay remains authenticated hidden-channel store-and-forward/coordination infrastructure and never becomes chat authority. Convergence is decided by each device applying authenticated channel state under these semantics; the relay never decides what user data is true. | **Locked** |
| **SYNC-DATA-003** | Convergence architecture is hybrid: logical baseline/bootstrap plus incremental operation log plus manifest/digest reconciliation with targeted repair. The existing operation log remains the normal continuous convergence mechanism and is not replaced by physical database copy. Baselines bootstrap or repair state; they never replace the continuous log as the steady-state mechanism. | **Locked** |
| **SYNC-DATA-004** | Baselines are logical, allowlisted, schema-versioned, device-independent state — never a raw `chat.db` file copy. They carry only the versioned syncable-data inventory (§10) permits, and always exclude credentials, device-local paths, caches/FTS artifacts, and transient/UI-derived state. A baseline that cannot be validated against its declared schema version is rejected fail-closed. | **Locked** |
| **SYNC-DATA-005** | First pairing of devices with pre-existing independent data converges by bidirectional union/merge: each side's pre-pair user state survives unless removed by an explicit rule in this ADR. Absence on one side is unknown/missing, never deletion. Only explicit versioned tombstone/delete evidence removes state; a device must never interpret "the peer did not send it" as "the user deleted it." | **Locked** |
| **SYNC-DATA-006** | Stable entity IDs identify the same logical entity across devices. Independent fields of the same entity merge. Same-field collisions resolve by deterministic version ordering that is compatible with the current timestamp-then-operationId LWW for the current protocol version. Deletion/tombstone evidence and late-descendant containment follow §6: tombstones are explicit versioned state, and a late descendant of a tombstoned parent is contained, never resurrected through. | **Locked** |
| **SYNC-DATA-007** | Third-device and new-device bootstrap uses a baseline bound to a per-channel operation watermark N, then replays operations N+1 onward on the joining device. Concurrent writes during bootstrap must not fall into a snapshot/log gap: any operation above N that the baseline does not already contain must still be delivered through replay or repair. Gap-prone handoff (baseline at N, stream resumed above N+1 without repair) is not convergence. | **Locked** |
| **SYNC-DATA-008** | Baseline application must preserve and merge local pre-pair data (§6) and pending outbox intent on the receiving device. State transfer is not equivalent to acknowledging local operations: applying a baseline never silently drops unsent local intent, and never marks unacknowledged local operations as converged. | **Locked** |
| **SYNC-DATA-009** | Parent/child aggregates require completeness/ordering or atomic group semantics at apply time. A device must not durably present a partial user-visible shell: either the aggregate applies completely and in an order that preserves its references, or it applies as an atomic group, or the incomplete aggregate stays pending/invisible until its references arrive through replay or repair. | **Locked** |
| **SYNC-DATA-010** | A versioned syncable-data inventory is required before any full-sync claim. It classifies required user data, optional separately governed configuration, and device-local exclusions. The currently validated topic/message/partial message-block scope is not complete-product sync. Structured content, ordering/segments/branches, attachments and attachment bytes must receive explicit contract coverage before full-sync claims extend to them. | **Locked** |
| **SYNC-DATA-011** | Operation retention/compaction is allowed only when a valid recoverable baseline plus tombstone/deletion evidence covers the compacted prefix: any device bootstrapping from the retained state must still reach the same logical outcome for live and deleted entities. History-unavailable is an explicit state that routes to bootstrap/repair; it is never resolved by silent cursor reset or by treating missing prefix operations as converged. | **Locked** |
| **SYNC-DATA-012** | Reconciliation compares meaningful state manifests/digests and repairs missing/divergent entities through targeted baseline or operation redelivery. Rerunning push/pull alone is not reconciliation: without comparing what each side holds and repairing what differs, retry proves transport liveness only, not convergence. | **Locked** |
| **SYNC-DATA-013** | Data-convergence state is separate from service connection and pairing state. `Synced` requires, for the claimed domain: baseline completeness (no pending bootstrap/aggregate gaps), operation catch-up (no unapplied channel operations above the device cursor), no unresolved apply failures, and successful consistency verification (manifest/digest comparison per §8). Unsupported, partial, blocked, and repair-required states are explicit and truthful; a device that cannot verify convergence must say so. | **Locked** |
| **SYNC-DATA-014** | Disconnect and Unpair preserve local data on every affected device. Unpair stops future channel convergence but does not roll back already synchronized data: each device keeps what it holds, including what arrived through sync. Neither transition deletes, reverts, or migrates user data. | **Locked** |
| **SYNC-DATA-015** | Protocol/schema version incompatibility and convergence failures are fail-closed: on unknown or incompatible baseline/operation/manifest versions, on unvalidatable baselines, or on unresolvable apply failures, the device pins its cursor, retains pending and local state, surfaces a truthful blocked/repair-required state, and never fabricates convergence or discards user data to proceed. | **Locked** |
| **SYNC-DATA-016** | Convergence evidence and logs carry counts/statuses/digests only — never content, credentials, device-local paths, or raw sizes. This ADR claims no production readiness: capacity, durability beyond the living reference's bounded cases, deployment/upgrade/backup operations, and WAN exposure remain unclaimed here and governed where they live. | **Locked** |
| **SYNC-DATA-017** | Only the invariants above are product decisions. Deferred implementation choices — endpoint shapes, payload schemas, chunking, digest algorithm, baseline source election, exact retention duration, attachment transport, and E2EE design — are not decided here and require their own explicitly activated decisions. An implementation choice must never silently narrow or contradict a locked invariant. | **Locked** |
| **SYNC-DATA-018** | This ADR authorizes target semantics only and does not itself authorize implementation. No baseline, bootstrap, reconciliation, retention, inventory, status, or migration work follows from citing it; each requires a separate explicitly activated bounded step. Citing this ADR as proof that convergence is implemented is false. | **Locked** |

## 4. Definitions

- **Syncable personal-data domain**: the explicitly versioned set of user data covered by the §10 inventory for a claimed sync scope. Only this domain is subject to complete-synchronization claims.
- **Complete synchronization**: after convergence, each paired device holds the same logical user data for the claimed domain, within the locked merge/tombstone/aggregate rules — not merely the same operation count or cursor.
- **Logical baseline**: an allowlisted, schema-versioned, device-independent capture of syncable state at a per-channel watermark, usable for bootstrap and repair. Never a raw database file.
- **Operation watermark N**: the per-channel sequence position up to which a baseline claims to incorporate channel operations. Replay resumes at N+1 with gap repair per SYNC-DATA-007.
- **Tombstone/delete evidence**: explicit versioned deletion state for an entity. The only convergence input that removes state; absence of an entity in a baseline or stream is never deletion evidence.
- **Manifest/digest**: a comparable summary of meaningful held state (entity set and versions per the claimed domain), used to detect divergence and scope repair. Transport counters alone are not a manifest.
- **Targeted repair**: redelivery of the missing/divergent baseline partition or operation range identified by manifest comparison.
- **Data-convergence status**: the device's truthful claim about its converged state for a claimed domain (§8), independent of service connection and pairing membership.

## 5. Baseline and bootstrap (normative)

1. A baseline declares its schema version, its claimed inventory scope, and its per-channel watermark N. A receiver validates all three before applying; anything unvalidatable is rejected fail-closed per SYNC-DATA-015.
2. The baseline payload contains only allowlisted syncable fields (§10). Credentials, device-local paths, caches/FTS artifacts, and transient/UI-derived state are never baseline content, even when colocated with syncable rows in local storage.
3. Bootstrap applies in watermark order: apply the baseline at N, then replay N+1 onward. Concurrent writes above N are part of the converged result; the handoff must prove no gap between what the baseline incorporated and where replay resumed (SYNC-DATA-007).
4. Applying a baseline merges with — never overwrites — local pre-pair data and pending outbox intent (SYNC-DATA-008, §6). A device with unsent local operations keeps them pending through bootstrap and still requires their acknowledgement; the baseline does not acknowledge them.
5. Parent/child aggregates apply under §7 completeness/ordering or atomic group semantics. Partial aggregates never become durable user-visible shells.

## 6. Merge, ordering, and deletion (normative)

1. **Identity**: stable entity IDs identify the same logical entity on every device. Re-issuing identity at apply time (duplicating an entity because it arrived from another device) violates SYNC-DATA-006.
2. **Field merge**: updates carry intentional changed fields; independent fields of the same entity merge across devices. Merge behavior for the currently validated shapes stays compatible with the existing timestamp-then-operationId LWW for the current protocol version; a future versioned ordering decision may supersede the tie-break only through its own governed decision, never by silent drift.
3. **Deletion wins by evidence, not by absence**: only explicit versioned tombstone/delete evidence removes state. A baseline or stream that omits an entity states nothing about that entity. First-pairing union (SYNC-DATA-005) therefore keeps both sides' entities unless a tombstone says otherwise.
4. **Late descendants stay contained**: a child arriving after its parent's tombstone is suppressed and must not resurrect the parent. This extends the existing parent-tombstone containment to baseline/bootstrap delivery: a baseline that carries a tombstoned parent plus a descendant the tombstone already covers applies the tombstone outcome, not the descendant.
5. **Outbox preservation**: local pending intent participates in merge as unsent local state, not as already-converged state. Conflict ordering applies when that intent replays against converged state; bootstrap never pre-resolves it by dropping it.

## 7. Aggregate completeness (normative)

Aggregates with parent/child references (topics with messages, messages with blocks/segments/branches where the inventory covers them) converge as coherent units:

1. Either the full reference closure arrives (completeness with reference-preserving order), or the group applies atomically, or the incomplete aggregate remains pending/invisible until replay or repair completes it.
2. Ordering-only changes are not convergence inputs: reordering without content change carries no merge meaning under this ADR.
3. Malformed or unvalidatable aggregate members fail closed per SYNC-DATA-015 without blocking unrelated aggregates beyond what cursor semantics require — and the blockage itself is surfaced as blocked/repair-required, never as convergence.

## 8. Reconciliation and convergence status (normative)

1. Reconciliation starts from manifest/digest comparison over the claimed domain, scopes the divergence (missing entities, divergent versions, incomplete aggregates, uncovered prefix), and repairs through targeted redelivery. Push/pull retry without comparison and scoped repair is liveness, not reconciliation (SYNC-DATA-012).
2. History-unavailable (compacted prefix without a covering baseline, or a cursor pointing at unavailable operations) routes to bootstrap/repair under §5. Silent cursor reset — advancing past unavailable history and claiming convergence — is prohibited (SYNC-DATA-011).
3. Convergence status is per claimed domain and independent of `SYNC-CC-*` service/pairing status. At minimum it distinguishes: `Synced`, `Converging` (catch-up/repair in progress), `Partial` (claimed domain subset only), `Unsupported` (domain outside the versioned inventory), `Blocked` (version incompatibility or unresolvable failure), and `Repair required` (divergence or history-unavailable awaiting bootstrap/repair).
4. `Synced` holds only when baseline completeness, operation catch-up, zero unresolved apply failures, and successful consistency verification all hold for the claimed domain. Verification means a manifest/digest comparison confirming the same logical state, not equal cursor values alone.
5. Status transitions never delete or roll back user data to reach a cleaner state. Repair adds or corrects through governed inputs (baseline, replay, tombstones); it never removes local state except through explicit tombstone/delete evidence.

## 9. Retention and compaction (normative)

1. The compacted prefix must be covered by a valid recoverable baseline plus the tombstone/deletion evidence needed to preserve deletion outcomes for entities removed within the prefix. "Covered" is proven by recoverability: a device bootstrapping from retained state reaches the same logical outcome for live and deleted entities as replay from the uncompacted log would have produced.
2. Until that proof exists for a prefix, the prefix is retained. Retention duration, storage location, and reaping mechanics are deferred implementation choices (SYNC-DATA-017), but the coverage precondition is not deferrable.
3. A device encountering history it cannot recover routes to bootstrap/repair and reports blocked/repair-required. It never advances past the gap silently.

## 10. Syncable-data inventory requirement (normative)

1. A versioned inventory must exist before any full-sync claim, classifying at minimum: (a) required user data that complete synchronization covers; (b) optional configuration governed separately with its own scope and default behavior; (c) device-local exclusions that never enter the channel (credentials, device-local paths, caches/FTS, transient/UI-derived state).
2. The currently validated topic/message/partial message-block scope is a subset of that inventory, not complete-product sync. Claims for the current scope stay bounded to the living reference's evidence; broader claims wait for explicit contract coverage.
3. Structured content, ordering/segments/branches, attachments and attachment bytes each require explicit contract coverage (shape, reference integrity with §7 aggregates, transport, and verification) before full-sync claims extend to them. Exclusion from a claim is explicit inventory scope, not silent omission.

## 11. Disconnect, Unpair, and version consequences

- **Disconnect** (per `SYNC-CC-*` service attachment) changes reachability only. It preserves local data, pending outbox intent, cursors, and convergence status inputs; on reconnect, catch-up and reconciliation resume from pinned positions.
- **Unpair** (per `SYNC-CC-*` channel membership) stops future channel convergence for the unpaired device. It preserves all local data on every affected device, including data that arrived through sync, and performs no rollback, revert, or deletion of already synchronized state (SYNC-DATA-014).
- **Version incompatibility** (unknown baseline/operation/manifest/inventory version, or a peer outside the compatible protocol version) fails closed per SYNC-DATA-015: pin, retain, surface truthfully, and route to upgrade or repair. Downgrade-by-discard and compatibility-by-ignoring-unknown-fields are not permitted by this ADR; any such rule would require its own governed decision.

## 12. Non-goals and boundaries (not owned by this ADR)

- Connection/registration/channel/pairing behavior is owned by [sync-connection-channel.md](./sync-connection-channel.md). This ADR assumes paired hidden-channel membership with per-channel sequencing exists; it defines what converges over it.
- Current implementation, evidence, gaps, and next step are owned by [multi-device-sync.md](./multi-device-sync.md).
- Endpoint paths, verbs, payload schemas, chunking, digest algorithm, baseline source election (which device or relay store serves a baseline), exact retention duration, attachment byte transport, and E2EE are deferred implementation choices (SYNC-DATA-017), not product invariants.
- WAN exposure, TLS/certificate management, Docker image operations, backup/rotation operations, capacity/SLA, and production readiness are unchanged by this ADR.

## 13. Rejected alternatives (stable decisions)

- **Physical database copy as sync — rejected** (SYNC-DATA-003, SYNC-DATA-004). Copying `chat.db` across devices would transport device-local paths, credentials-adjacent material, caches/FTS artifacts, and schema-instance coupling, and would overwrite rather than merge. Baselines are logical and allowlisted; the continuous mechanism remains the operation log.
- **Absence as deletion — rejected** (SYNC-DATA-005). Treating a missing entity as a delete would turn every partial baseline, filtered scope, or in-flight aggregate into data loss. Only explicit versioned tombstones delete.
- **Snapshot/log gap handoff — rejected** (SYNC-DATA-007). Resuming the stream above the baseline watermark without proving coverage loses concurrent writes. The handoff must prove N+1-onward delivery or repair.
- **Baseline application as overwrite or implicit acknowledgement — rejected** (SYNC-DATA-008). Overwrite loses pre-pair data; implicit acknowledgement fabricates durability for unsent intent.
- **Partial aggregate shells — rejected** (SYNC-DATA-009). A durably visible parent without its children (or child without its parent) presents state the user never created.
- **Silent cursor reset on missing history — rejected** (SYNC-DATA-011). Advancing past unavailable operations manufactures convergence while abandoning data and deletion outcomes.
- **Push/pull retry as reconciliation — rejected** (SYNC-DATA-012). Retry without comparison cannot detect divergence it never looks at.
- **Connection/pairing status as convergence proof — rejected** (SYNC-DATA-013). A paired and connected device with unapplied operations, pending bootstrap gaps, or unverified state is not `Synced`.

## 14. Security and privacy

- Baselines, operations, manifests, and repair traffic carry only allowlisted syncable fields (§10). Credentials, device-local paths, and transient/UI-derived state are excluded at capture, not redacted at display.
- Secrets (registration credentials, tokens, keys) are never baseline, manifest, log, or evidence content. Evidence and logs carry counts/statuses/digests only, never content, credentials, paths, or raw sizes.
- Main SQLite remains the local chat authority (SYNC-DATA-002); the relay remains store-and-forward/coordination and never owns chat truth. Relay compromise or loss affects availability and coordination, never the definition of converged truth — recovery comes from device-held state under these semantics.
- Transport security, E2EE, and attachment-byte protection are deferred implementation choices and are not decided here.

## 15. Conformance requirements

An implementation conforms to this ADR only when its observed behavior satisfies, at minimum:

1. Paired devices with pre-existing independent data reach the bidirectional union outcome: both sides' entities survive absent explicit tombstones; absence alone deletes nothing.
2. A joining device bootstraps from a watermark-bound baseline plus N+1-onward replay with no gap loss under concurrent writes, while its local pre-pair data and pending outbox intent survive bootstrap unacknowledged.
3. Same-entity independent fields merge; same-field collisions resolve deterministically compatibly with the current timestamp-then-operationId LWW for the current protocol version; tombstoned parents contain late descendants without resurrection.
4. Aggregates never rest as durable partial user-visible shells; incomplete aggregates stay pending/invisible until completed by replay or repair.
5. Retention/compaction keeps recoverability for live and deleted entities; history-unavailable routes to bootstrap/repair with a truthful blocked/repair-required state and never a silent cursor advance.
6. Reconciliation demonstrates manifest/digest comparison with scoped targeted repair; push/pull retry alone does not satisfy this item.
7. `Synced` is claimed per domain only with baseline completeness, operation catch-up, no unresolved apply failures, and successful consistency verification; all other states are reported truthfully.
8. Disconnect and Unpair preserve local data; Unpair stops future convergence without rolling back already synchronized state.
9. Version incompatibility and unresolvable failures behave fail-closed: pinned cursor, retained state, truthful status, no fabricated convergence.

Conformance is a property of observed behavior against the statements above. This ADR does not prescribe test shape, evidence form, or implementation sequence.

## 16. Deferred items and consequences

- Endpoint shapes, payload schemas, chunking, digest algorithm, baseline source election, exact retention duration, attachment transport, and E2EE: deferred (SYNC-DATA-017). Consequence: no baseline, bootstrap, reconciliation, or retention work starts until its own explicitly activated step defines these within the locked invariants.
- Syncable-data inventory content (exact entity/field lists and versions): required by SYNC-DATA-010 but its content lives in its own governed artifact/step. Consequence: until the inventory and the per-domain contracts it demands exist, full-sync claims stay unmade and scope claims stay bounded to validated shapes.
- Conflict-recovery UX and row-level conflict visibility: deferred. Consequence: deterministic ordering resolves same-field collisions without a dedicated user recovery experience until a later decision designs one.
- Channel garbage collection, multi-group/merge, and credential recovery remain deferred under `SYNC-CC-*`; snapshot/backfill history they touch additionally requires this ADR's retention/repair preconditions.

## 17. ADR change policy

- **Status**: Approved and fixed. This ADR is the authoritative owner of target data-convergence semantics (`SYNC-DATA-*`). It stays unchanged while the design is unchanged.
- **Living state lives elsewhere**: current implementation, evidence, gaps, and next step belong exclusively to [multi-device-sync.md](./multi-device-sync.md), which references this ADR as target governance and must not duplicate its decision tables.
- **Design change requires a new decision**: this ADR changes only by explicit user-approved amendment, or is marked superseded by a named successor ADR that states what it replaces. The superseded ADR is retained for audit and no longer authoritative.
- **Evidence never silently modifies decisions**: validation runs, implementation findings, and new evidence are recorded in the living reference; they do not alter this ADR's decisions without an amendment or superseding ADR.
- [sync-architecture-selection.md](./sync-architecture-selection.md) stays a conditional fallback reference; it is unaffected by this ADR except for a routing pointer.
- **No implementation authorization flows from this ADR.** No baseline, bootstrap, reconciliation, retention, inventory, status, migration, IPC, or code change is authorized by citing it. Citing this ADR as proof that the target convergence model is implemented is false.

---

## References

- [Personal Multi-Device Sync](./multi-device-sync.md) — current reference (implementation/evidence/gaps/next step).
- [Sync Connection, Registration, and Hidden Multi-Channel Pairing ADR](./sync-connection-channel.md) — approved target for service connection/registration/channel/pairing semantics (`SYNC-CC-*`); pairing/channel scope assumed by this ADR.
- [Sync Architecture Selection](./sync-architecture-selection.md) — conditional fallback reference.
- [SQLite migration governance](./sqlite-migration.md) — SQLite chat authority, migration process.
- [Context window governance](./context-window.md) — context anchor semantics.
- [Application Identity ADR](./cherry-chat-application-identity.md) — identity, compatibility, updater/release freeze, platform scope.
- [Architecture Evolution Program](./architecture-evolution-program.md) — program intent (sync not tracked there).
