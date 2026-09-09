# Sync Connection, Registration, and Hidden Multi-Channel Pairing — Approved ADR

> **Status**: Approved / Authoritative (target semantics).
> **Decision namespace**: `SYNC-CC-*` (durable; this ADR owns these IDs).
> **Role**: This ADR owns target relay service connection, device registration, channel, and pairing semantics only. It does not own current implementation status, evidence, gaps, or next step — those live in [Personal Multi-Device Sync](./multi-device-sync.md). It does not own candidate/fallback analysis — that lives in [Sync Architecture Selection](./sync-architecture-selection.md) (conditional fallback reference only).
> **Non-implementation**: No protocol/code implementation is authorized by this ADR. Implementation requires a separate explicitly activated decision and step.
> **Development principle**: This ADR is governed by `adaptive-development` principles: the intended outcome remains the anchor, current state and gap determine the next step, and design, implementation, evidence, and validation evolve together.
> **Last updated**: 2026-09-09

---

## 1. Context and problem

The relay inherently supports multiple internal sync channels, but the current implementation behaves as a single global channel with an invite/founder/trust model. That model cannot express the target product behavior: a user connects each of their own devices to one relay service, pairs devices explicitly by device code, and syncs within a private channel per device group — while other users' channels on the same relay stay invisible and isolated.

Prior invite/founder/trust single-channel behavior is superseded rationale: it cannot express the target product behavior described below. This ADR locks the target connection/registration/channel/pairing semantics as the design authority for that behavior.

## 2. Authority boundary

- **This ADR owns**: target service connection/registration semantics, channel/pairing semantics, device-code semantics, request lifecycle, channel creation/join/unpair/dissolve rules, per-channel sequencing requirements, and the Disconnect-vs-Unpair contract.
- **This ADR does not own**: current implementation status/evidence/gaps/next step ([multi-device-sync.md](./multi-device-sync.md)); fallback candidate analysis ([sync-architecture-selection.md](./sync-architecture-selection.md)); application identity, updater/release freeze, platform scope ([cherry-chat-application-identity.md](./cherry-chat-application-identity.md)); SQLite chat authority and migration process ([sqlite-migration.md](./sqlite-migration.md)); context-window semantics ([context-window.md](./context-window.md)); initial snapshot/existing-data convergence (separate pre-existing sync-data problem, explicitly out of scope — see §12).
- **This ADR does not authorize**: protocol implementation, endpoint shapes, schema migrations, IPC changes, or any code change. It creates no permissions/admin/merge/GC/snapshot/WAN/TLS-management decisions beyond what is written here.

## 3. Decision table (`SYNC-CC-*`)

| # | Decision | Status |
|---|---|---|
| **SYNC-CC-001** | Relay inherently supports multiple internal sync channels; current global single-channel behavior is a temporary implementation limitation, not a product constraint. Channels are hidden infrastructure: users never see channel IDs, lists, or management UX. | **Locked** |
| **SYNC-CC-002** | Each client belongs to at most one channel at a time; a channel supports 2+ devices. There is no channel merge: acceptance never merges two existing channels. | **Locked** |
| **SYNC-CC-003** | Relay service connection/registration and channel pairing are separate state machines with separate UI status. Service state is each client's observed relay attachment; pairing state is channel membership. Neither is derived from the other except where explicitly stated (Unpair requires connected relay, §8). | **Locked** |
| **SYNC-CC-004** | Service connection is explicit and user-initiated. First successful Connect registers the device and obtains a stable relay-scoped public device code plus a durable secret credential. Registered devices auto-reconnect after app/network recovery; relay unreachable/unavailable surfaces as Service disconnected. | **Locked** |
| **SYNC-CC-005** | Disconnect vs Unpair are distinct and never conflated. Disconnect stops service attachment/auto-reconnect but preserves registration and channel membership. Unpair requires a connected relay, atomically removes self membership, and preserves service connection and local chats. See §8. | **Locked** |
| **SYNC-CC-006** | Service connection is shown with an API Server-style red/green indicator. It reports each client's own observed relay state, not broadcast presence of other devices. Pairing state is shown separately. | **Locked** |
| **SYNC-CC-007** | Device code is a stable, relay-scoped, human-transcribable public identifier — not a secret and not an authorization credential. Pairing flow: requester enters the target's device code; the target explicitly accepts. No invite creation, no invite expiry, no founder/admin/revoke-other UX. | **Locked** |
| **SYNC-CC-008** | Pairing requests persist until accepted, rejected, requester-cancelled, or replaced by a new outgoing request; there is no automatic expiration. At most one outgoing request per device; retries and replacement are idempotent and fail-closed. | **Locked** |
| **SYNC-CC-009** | Channel formation/join rules: two unpaired devices accepted ⇒ relay atomically creates a channel and adds both. Unpaired requester to paired target ⇒ requester joins the target's channel. A paired requester cannot initiate another pairing; a paired target may accept additional devices. If the requester became paired before acceptance, acceptance fails. | **Locked** |
| **SYNC-CC-010** | User-visible pairing controls: unpaired ⇒ Request pairing; paired ⇒ Unpair. Pending states expose requester cancel and target accept/reject as necessary. No peer revoke and no permissions UI exist in the current model. | **Locked** |
| **SYNC-CC-011** | Unpair lifecycle: allowed only while the relay is connected; atomically removes self membership; never disconnects the service and never deletes local chats. If durable channel membership drops below two, the relay automatically dissolves the channel; the remaining member becomes unpaired on next relay observation. Offline/sleep/network loss/app or relay restart never changes membership. | **Locked** |
| **SYNC-CC-012** | Zombie channels/rows may remain and must never block users; garbage collection is deferred. | **Locked** |
| **SYNC-CC-013** | Reset without migration: current test-stage invite/founder/trusted state may be reset with no compatibility migration burden. Existing local chats remain local; old pairing state may be discarded for the new protocol. | **Locked** |
| **SYNC-CC-014** | Initial snapshot and existing-data convergence is a separate pre-existing sync-data problem and is not owned by this ADR. This ADR governs connection/channel/pairing only. | **Locked** |
| **SYNC-CC-015** | Infrastructure/authority boundary preserved: relay remains no-account/no-Web-admin store-and-forward infrastructure; Main SQLite remains chat authority. Docker bridge deployment and HTTP/HTTPS deployment choice remain external to channel logic. | **Locked** |
| **SYNC-CC-016** | Per-channel operation sequence and cursor are required. A global sparse filter over one shared sequence cannot preserve the current contiguous cursor contract; channel-scoped contiguous sequencing is an implementation requirement. This decides sequencing scope only, not snapshot semantics. | **Locked** |

## 4. Definitions

- **Relay service connection (attachment)**: whether this client is currently attached to the configured relay service and auto-reconnecting when registered. Observed locally per client.
- **Registration**: durable relationship between one device and one relay, established on first successful Connect: a stable relay-scoped public device code plus a durable secret credential held by the client.
- **Device code**: stable, relay-scoped, human-transcribable public identifier for a registered device. Routable by transcription, not a secret, not an authorization credential.
- **Secret credential**: durable per-device authorization material obtained at registration; never displayed, never transcribed, never used as an identifier.
- **Channel**: hidden relay-side grouping of 2+ devices whose operations replicate together. Users never see channels directly; they see paired/unpaired plus pending states.
- **Membership**: durable relay-side record binding a registered device to a channel.
- **Pair request**: durable directed intent from a requester device to a target device code, resolved by target accept/reject, requester cancel, or replacement.
- **Service disconnected**: the client's observed state when the relay is unreachable/unavailable, regardless of registration or membership durability.

## 5. Service connection and registration state machine

States (per client, observed locally):

- `Unregistered` → user clicks Connect → connecting → on success: `Connected + Registered` (device code + secret stored durably).
- `Connected` ⇄ `Service disconnected`: transport/app/network loss moves to `Service disconnected`; registered devices auto-reconnect without user action. Registration and membership persist across these transitions.
- User clicks Disconnect from `Connected` or `Service disconnected` → `Disconnected (registered, membership preserved)`: attachment and auto-reconnect stop; registration (device code + secret) and channel membership are preserved. A later Connect re-attaches with the same registration.
- Registration is never silently re-created: re-registration (new device code/credential) is at most an explicit recovery path defined at implementation time, not a background fallback.

## 6. Channel pairing state machine

States (per client, membership as observed via relay):

- `Unpaired` → user initiates Request pairing (enters target device code) → `Outgoing pending` (at most one per device).
- Target observes `Incoming pending` → accepts or rejects.
- Resolution:
  - Both unpaired at acceptance ⇒ relay atomically creates a channel and adds both.
  - Requester unpaired, target paired at acceptance ⇒ requester joins the target's channel.
  - Requester already paired at acceptance time ⇒ acceptance fails; no merge, no partial join.
  - Paired requester cannot initiate a new request (client refuses before any relay call).
- `Paired` → user clicks Unpair (only while relay connected) → relay atomically removes self membership → `Unpaired`. Service stays connected; local chats untouched.
- Membership durability: offline/sleep/network loss/app restart/relay restart never create, move, or delete membership. Only Unpair (self-removal) and automatic dissolve after membership drops below two change it.

## 7. Combined UI status and action table

Service status and pairing status are always shown separately. Allowed actions:

| Service | Pairing | Primary action(s) | Notes |
|---|---|---|---|
| Unregistered / Disconnected | Unpaired, no pending | **Connect**; **Request pairing** disabled until connected | Pairing requires service attachment |
| Connected | Unpaired, no pending | **Request pairing**; **Disconnect** | Normal start state |
| Connected | Outgoing pending | **Cancel request**; **Disconnect** | Request persists until resolved |
| Connected | Incoming pending | **Accept** / **Reject**; **Disconnect** | Target decision |
| Connected | Paired | **Unpair**; **Disconnect** | Unpair keeps service connected |
| Service disconnected | Any pairing state | **Connect** (re-attach); **Disconnect** (stop auto-reconnect) | No Request/Accept/Reject/Unpair while disconnected |
| Disconnected (registered) | Any pairing state | **Connect** | Registration + membership preserved |

Control labels are fixed: service control is Connect/Disconnect; pairing controls are Request pairing/Unpair plus pending Cancel/Accept/Reject. No founder/admin/revoke-other/permissions controls exist.

## 8. Disconnect vs Unpair (normative)

- **Disconnect**: stops service attachment and auto-reconnect. Preserves registration (device code + secret) and channel membership. Does not delete local chats. Available in every service state. Reconnect restores sync without re-pairing.
- **Unpair**: requires a connected relay (`Connected`). Atomically removes self membership on the relay. Preserves service connection (client stays attached and addressed by its device code) and preserves all local chats. If durable membership drops below two, the relay automatically dissolves the channel; the remaining member becomes unpaired on its next relay observation (it is not pushed a presence event as authority).
- Implementations must not merge these: Disconnect must never remove membership; Unpair must never disconnect the service or wipe local data.

## 9. Protocol responsibilities (behavioral, not endpoint implementation)

The relay is responsible for, at minimum:

1. Durable device registration: issue a stable relay-scoped public device code plus a durable secret credential on first Connect; authenticate later attachment by the secret, never by the device code alone.
2. Durable pair-request lifecycle: one outgoing request per device; persistence until accepted/rejected/cancelled/replaced; idempotent retry/replacement; fail-closed on conflict (paired requester initiation refused; late acceptance after requester paired fails).
3. Atomic channel operations: create-channel-and-add-both, join-existing-channel, and remove-self-membership execute atomically; no partial membership and no merge path.
4. Automatic dissolve: when durable membership drops below two, dissolve the channel; the remaining member resolves to unpaired on next observation.
5. Per-channel operation sequencing and cursors (§10) scoped to channel members only; devices outside the channel never observe the channel's operations.
6. Truthful failure semantics: unauthenticated/unregistered/unpaired access fails closed with an explicit reason; unreachable relay surfaces as Service disconnected with pending work retained client-side (pending-work retention itself is existing sync-data behavior, not decided here).

Endpoint paths, verbs, payload schemas, and exact error codes are implementation decisions under a later activated step; this ADR constrains only the behaviors above.

## 10. Internal data model requirements

Any implementation must durably represent, at minimum:

- **Devices**: stable device identity per registration: public device code (relay-scoped, stable, transcribable) bound to a secret credential (durable, never exposed as identifier).
- **Channels**: internal channel records; hidden from users.
- **Membership**: durable device→channel bindings; at most one channel per device.
- **Pair requests**: directed requester→target records with lifecycle `pending → accepted | rejected | cancelled | replaced`; at most one outgoing `pending` per requester; no expiry timestamp semantics.
- **Channel operations**: sync payload log partitioned by channel.
- **Per-channel sequence/cursor**: each channel has its own contiguous operation sequence and cursor. Rationale (SYNC-CC-016): the current sync contract relies on a contiguous cursor; multiplexing independent channels onto one global sequence with sparse per-device filtering breaks contiguity for each observer. Therefore channel-scoped contiguous sequencing is required. This is an implementation requirement on sequencing scope; it does not decide snapshot, retention, or GC policy.

## 11. Lifecycle and error semantics

- Registration, membership, requests, channels, and per-channel sequences survive app restart and relay restart on the same relay DB/credential inputs.
- Offline/sleep/network loss/app or relay restart never changes registration, membership, or request outcome — except that a pending request may still be cancelled/replaced by its requester or accepted/rejected by its target when connectivity returns.
- Relay unreachable ⇒ client shows Service disconnected; local chats remain fully usable; pending sync work behavior follows the existing sync-data contract (unchanged by this ADR).
- Fail-closed matrix: unknown/expired credential ⇒ re-attach refused, surfaced truthfully (no silent re-registration); unpaired device ⇒ sync data path refused with explicit reason; paired-requester initiation ⇒ refused client-side; late acceptance after requester paired ⇒ fails with no membership change; Unpair while disconnected ⇒ refused (must Connect first).

## 12. Non-goals and boundaries (not owned by this ADR)

- Initial snapshot and existing-data convergence (what historical operations a newly paired device receives) is a separate pre-existing sync-data problem. This ADR assumes a working per-channel operation stream exists; it does not define backfill, snapshot, retention, or conflict-resolution behavior.
- No founder/admin/permission/revoke-other model is created. No channel merge path exists. No per-user multi-group management UX beyond one channel per client is created.
- WAN exposure, TLS/certificate management, Docker image operations, backup/rotation, capacity/SLA, E2EE, attachments, and compound-operation coverage are unchanged by this ADR and remain under their existing governance.

## 13. Rejected alternatives (stable decisions)

- **Global single channel as an inherent relay constraint — rejected** (SYNC-CC-001). The relay inherently supports multiple internal sync channels; treating one global channel as a product constraint would leak other users' devices into every user's sync scope. Channels are hidden infrastructure, never user-visible.
- **Invite/founder/admin/revoke-other model — rejected** (SYNC-CC-007, SYNC-CC-010). Pairing is a direct device-code request plus explicit target accept, with no invite creation or expiry, no founder privilege, no admin role, and no revoking other devices. Rationale: the pairing set is the user's own devices, so there is no other party to administer.
- **Presence-based membership and dissolve — rejected** (SYNC-CC-011). Offline, sleep, network loss, and app or relay restart never create, move, or delete membership. Dissolve follows only from durable membership dropping below two, observed on next relay contact — never from transient unreachability.
- **Channel merge — not selected** (SYNC-CC-002, SYNC-CC-009). Acceptance never merges two existing channels: a paired requester cannot initiate, and late acceptance after the requester became paired fails with no membership change. Multi-group or merge behavior is deferred, not designed here.
- **Relay Web administration plane — rejected** (SYNC-CC-015). The relay remains no-account store-and-forward infrastructure with no user accounts, passwords, or web management plane; the client pairing UI is the only control plane.

## 14. Security and privacy

- The device code is public within the relay scope by design (transcribed by the user) and carries no authorization power. Authorization derives only from the durable secret credential plus channel membership.
- Secrets are never displayed, logged, or transcribed; evidence and logs carry counts/statuses only, never codes, credentials, paths, content, or raw sizes.
- The relay remains no-account/no-Web-admin infrastructure: no user accounts, no passwords, no web management plane are introduced by channel semantics.
- Main SQLite remains the chat authority; the relay remains store-and-forward and never owns chat truth.

## 15. Reset and no-migration decision (SYNC-CC-013)

Superseded invite/founder/trusted pairing state carries no compatibility burden: it may be reset. Existing local chats remain local and are never deleted or moved by the reset; only obsolete pairing state is discarded for the registration/channel protocol. Deployment documentation describes implementation; this ADR makes no claim about what any relay deployment runs — it defines the target only.

## 16. Conformance requirements

An implementation conforms to this ADR only when its observed behavior satisfies, at minimum:

1. Explicit Connect registers once (stable code + durable secret); reconnects are automatic; relay-down shows Service disconnected.
2. Disconnect preserves registration/membership; re-Connect resumes without re-pairing.
3. Device-code request → target accept pairs two unpaired devices into a hidden channel; unpaired→paired request joins the target channel; paired requester cannot initiate; late acceptance after requester paired fails with no merge.
4. Pending request lifecycle (accept/reject/cancel/replace, no expiry, single outgoing, idempotent retry) behaves per §6/§9.
5. Unpair requires connected relay, removes only self, keeps service connected and local chats intact; sub-two membership dissolves the channel with the survivor resolving to unpaired.
6. Per-channel contiguous sequence/cursor holds independently per channel; one channel's traffic is never observable from another channel.
7. Zombie rows never block Connect/pairing/sync user flows.

Conformance is a property of observed behavior against the statements above. This ADR does not prescribe test shape, evidence form, or implementation sequence.

## 17. Deferred items and consequences

- Channel garbage collection (reaping dissolved/empty/zombie rows): deferred. Consequence: orphan rows may accumulate; they must never block users. A later decision may define reaping without changing user-visible semantics.
- Multi-group per client, merge, delegation/admin, and recovery UX (device loss, credential rotation): deferred. Consequence: one channel per client, no merge, no admin — loss/recovery stays manual until a later decision.
- Snapshot/backfill, retention/GC of operations, and WAN/TLS operations: owned elsewhere or deferred as stated in §12. Consequence: pairing a fresh device does not by itself solve what history it receives.

## 18. ADR change policy

- **Status**: Approved and fixed. This ADR is the authoritative owner of target connection/registration/channel/pairing semantics (`SYNC-CC-*`). It stays unchanged while the design is unchanged.
- **Living state lives elsewhere**: current implementation, evidence, gaps, and next step belong exclusively to [multi-device-sync.md](./multi-device-sync.md), which references this ADR as target governance and must not duplicate its decision tables.
- **Design change requires a new decision**: this ADR changes only by explicit user-approved amendment, or is marked superseded by a named successor ADR that states what it replaces. The superseded ADR is retained for audit and no longer authoritative.
- **Evidence never silently modifies decisions**: validation runs, implementation findings, and new evidence are recorded in the living reference; they do not alter this ADR's decisions without an amendment or superseding ADR.
- [sync-architecture-selection.md](./sync-architecture-selection.md) stays a conditional fallback reference; it is unaffected by this ADR except for a routing pointer.
- **No implementation authorization flows from this ADR.** No protocol, endpoint, schema, migration, IPC, or code change is authorized by citing it. Citing this ADR as proof that the target model is implemented is false.

---

## References

- [Personal Multi-Device Sync](./multi-device-sync.md) — current reference (implementation/evidence/gaps/next step).
- [Sync Architecture Selection](./sync-architecture-selection.md) — conditional fallback reference.
- [SQLite migration governance](./sqlite-migration.md) — SQLite chat authority, migration process.
- [Context window governance](./context-window.md) — context anchor semantics.
- [Application Identity ADR](./cherry-chat-application-identity.md) — identity, compatibility, updater/release freeze, platform scope.
- [Architecture Evolution Program](./architecture-evolution-program.md) — program intent (sync not tracked there).
