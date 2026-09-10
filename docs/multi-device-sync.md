# Personal Multi-Device Sync — Current Reference

> **Status**: Current reference for personal multi-device sync. Limited validation; not production-ready.
> **Role**: This document owns sync goal, current approach, current status/limits, evidence, gaps, and next decision.
> **Fallback reference (conditional only)**: [Sync Architecture Selection](./sync-architecture-selection.md) — candidate analysis reusable only on a concrete current-path blocker with clear technical advantage.
> **Development principle**: This sync effort is initiated and evolved under `adaptive-development` principles: the intended outcome remains the anchor, current state and gap determine the next step, and design, implementation, evidence, and validation evolve together.
> **Target connection/channel governance**: [Sync Connection, Registration, and Hidden Multi-Channel Pairing ADR](./sync-connection-channel.md) (`SYNC-CC-*`, approved 2026-09-09; `SYNC-CC-017`–`SYNC-CC-019` baseline persistence/offline-bootstrap plus serialized publish-gate/in-flight-retention amendment 2026-09-10) owns target relay service connection/registration/channel/pairing plus relay baseline envelope storage/distribution infrastructure semantics. This document does not duplicate its decision tables.
> **Target data-convergence governance**: [Sync Data Convergence ADR](./sync-data-convergence.md) (`SYNC-DATA-*`, approved 2026-09-10; `SYNC-DATA-019`–`SYNC-DATA-024` baseline persistence/offline-bootstrap/watermark-boundary plus publish-gate/in-flight-protection amendment, target-only) owns target complete-synchronization semantics (client-generated logical baseline, relay-persisted per-channel current-effective baseline plus schema/digest/watermark metadata, offline bootstrap with N+1 replay, watermark three-segment boundary, single-effective-baseline replacement with serialized watermark-monotonic/coverage gating and in-flight bootstrap protection, manifest reconciliation/repair). This document does not duplicate its decision tables. The ADR is approved but not implemented: no relay-persisted baseline, offline bootstrap, watermark-bound replay handoff, serialized publish gating, in-flight bootstrap retention, reconciliation, retention, inventory, or convergence-status work follows from citing it.
> **Implementation-vs-target**: the SYNC-CC connection/registration/channel/pairing foundation is implemented with limited validation on the current exact worktree (see §7 Current validation). Relay-persisted baselines, offline bootstrap, and the watermark three-segment boundary (`SYNC-CC-017`–`SYNC-CC-019`, `SYNC-DATA-019`–`SYNC-DATA-024`) are approved target only and are not implemented — including the `SYNC-DATA-023` serialized watermark-monotonic/coverage publish gate with relay reject and the `SYNC-DATA-024`/`SYNC-CC-019` in-flight bootstrap N+1 protection. This is implementation regression evidence for covered shapes only; it is not production readiness.
> **Last updated**: 2026-09-10 — `SYNC-DATA-023`–`SYNC-DATA-024` / `SYNC-CC-019` serialized publish-gate/in-flight-protection recorded as target-only (no implementation authorized); SYNC-DATA convergence ADR approved as target-only; SYNC-CC foundation limited validation completed on current worktree; deterministic Main-only local logical baseline candidate capture implemented as an internal/non-wire bootstrap input (not convergence, not a relay payload); not production-ready (see §7 Current validation). Docker relay docs still describe deployment mechanics, not pairing semantics.

## 1. Goal

Syncthing-like local-first personal multi-device sync with no Cherry Chat account.

- Each device keeps a complete local copy and remains usable offline. Sync is an explicit opt-in coordination layer, not a cloud-primary model.
- Devices are paired through explicit device-code request/accept into hidden per-channel membership. Pairing and device authentication are distinct from an account system.
- At any time the user connects to one user-selected compatible sync service: a personal-hosted relay they deploy themselves or that is deployed online. The service is a pluggable infrastructure choice, not a Cherry Chat account system.
- Target behavior is automatic online convergence plus cursor-based recovery after short disconnection, with no silent loss.

## 2. Current approach

The selected path is application operation-log plus thin personal-hosted HTTP relay.

- Chat authority stays in Main-process SQLite (`Data/chat.db` via `ChatDbAggregateService`). The renderer never holds a SQLite connection; all chat access goes through typed IPC.
- Supported stable mutations enqueue sync intent as an operation log that preserves business intent (create, edit, delete) rather than raw row diffs. Only stable persisted checkpoints are sync candidates; transient streaming state is not a sync event.
- A thin HTTP relay carries operations between paired devices. The relay stores and forwards operations; it never owns chat authority. Relay-persisted per-channel current-effective baselines plus offline bootstrap (`SYNC-CC-017`–`SYNC-CC-019`, `SYNC-DATA-019`–`SYNC-DATA-024`) are approved target only and are not current relay behavior — including serialized publish gating with watermark-monotonic/coverage reject (`SYNC-DATA-023`/`SYNC-CC-019`) and in-flight bootstrap N+1 protection (`SYNC-DATA-024`/`SYNC-CC-019`).
- Replay applies operations idempotently with deterministic last-writer-wins resolution and tombstone propagation for deletions.
- Payloads carry only allowlisted shareable fields. Credentials, derived data, device-local paths, and UI state stay out of the sync channel.

### 2.1 Supported personal relay paths (this phase)

Two shapes share one relay protocol; both support plain HTTP and native
HTTPS transports and preserve the loopback `pnpm sync:relay` path, tests,
and strict TLS semantics. The relay never generates, manages, installs, or
rotates certificates: HTTPS is served only with operator-supplied
certificate/key files, using ordinary verification with no bypass or
auto-trust. Do not use systemd/cloud variants, reverse proxies, or fallback
technologies. There is no independent web admin UI: the existing Cherry Chat
client pairing UI remains the pairing-acceptance control plane.

- Command (loopback): `pnpm sync:relay -- --port <port> --db <path> --token <token>` (token fallback: `SYNC_RELAY_TOKEN` env; explicit `--token` wins). Help: `pnpm sync:relay -- --help`. The command runs `scripts/sync-relay/server.ts` with the repository's pinned Node/pnpm conventions.
- Command (LAN): `pnpm sync:relay -- --host <LAN-IP> --port <port> --db <path> --token <token> [--cert <cert.pem> --key <key.pem>]`. This is the supported direct host-run LAN shape alongside the Docker Compose deployment in Section 2.2 (Linux x64/arm64 home servers). Without `--cert`/`--key` the relay serves plain HTTP (unencrypted — the client shows a visible non-blocking warning for non-loopback `http://` endpoints); with a user-supplied `--cert`/`--key` pair it serves native HTTPS (Node stdlib `node:https`, no new dependency) and binds the user-selected non-loopback LAN address. There is no reverse-proxy, service-manager, or cloud variant.
- Prerequisites: macOS-arm64-first scope, pinned Node v24.11.1 and pnpm 10.27.0, repository checkout with dependencies installed.
- Loopback mode: binds `127.0.0.1` by default (`--host localhost` also allowed) and serves plain HTTP without cert/key. Existing loopback behavior, CLI defaults, and tests are preserved.
- LAN mode: a non-loopback `--host` must be an explicit numeric LAN IP and serves plain HTTP unless both `--cert` and `--key` are given (native HTTPS). Plain HTTP is unencrypted: use it only on networks you trust, or terminate HTTPS outside the relay. Cert/key files are read before the DB is opened; missing, empty, or mismatched material aborts startup without creating the DB; a partial pair (one without the other) is rejected. The readiness line advertises the actual scheme and bound host/port (`http://<LAN-IP>:<port>` or `https://<LAN-IP>:<port>`).
- Container bridge bind: `--host 0.0.0.0 --allow-unspecified-bind` is deployment-scoped for the Docker bridge image only (container-internal bind; Docker controls host exposure via `ports:`). It is never a user-facing advertised endpoint and must not be used for direct host runs.
- Certificate provisioning contract (user-owned, no automation): to serve HTTPS, generate or provision a PEM certificate and private key covering the LAN host/IP yourself (example: `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=<LAN-IP>" -addext "subjectAltName=IP:<LAN-IP>"`), then configure trust explicitly via `NODE_EXTRA_CA_CERTS`/OS trust as applicable to the runtime. Verification is never disabled in app code or tests. The relay and Docker image never perform this step for you.
- Two-profile setup/pairing flow over LAN: start one relay in LAN mode, set the same `http://<LAN-IP>:<port>` (or `https://<LAN-IP>:<port>` when you provided TLS) endpoint plus token on both app instances (for HTTPS, ensure both runtimes trust the certificate), Connect both (each registers its own device code), then complete the explicit device-code request -> accept flow and sync covered topic/message/message-block data. Registration and channel membership persist in Main config/SQLite and on the relay across app restarts.
- Client endpoint policy: both valid `http://` and `https://` endpoints are accepted for loopback and non-loopback hosts. A non-loopback `http://` endpoint shows a visible non-blocking warning in Sync Settings (unencrypted transport); saving and syncing remain possible.
- Persistent DB/token handling: `--db` selects the relay SQLite file and `--token` the Bearer token. Restart with the same `--db`/`--token` (plus `--cert`/`--key` for HTTPS) retains relay registration/channel membership/operations/per-channel cursors. A normal stop (`SIGTERM`/`SIGINT`) shuts down exactly once — stops accepting requests, closes active SSE streams, closes the HTTPS/HTTP server and SQLite connection cleanly — and never deletes the DB. User-owned relay data (DB/cert/key files) is never deleted by normal stop/close.
- Restart/recovery behavior: after a relay restart on the same DB/token (and cert/key for HTTPS), retained operations stay contiguous from per-channel cursor 0, per-channel sequences continue, paired channel membership needs no re-pairing, queued edits push and converge, and per-channel cursors advance. A short interruption surfaces a truthful sync error with pending work retained and cursors pinned until recovery.
- Explicit boundary: this path provides a runnable LAN relay contract and validation only. It claims no certificate issuance/installation automation, no certificate rotation, no backups, no capacity/SLA, no WAN/public-internet exposure, no WAL/OS-crash/power-loss durability, and no full production operations (deployment, upgrade, backup).

### 2.2 Docker Compose relay deployment (Linux x64/arm64 home servers)

Docker Compose is the supported containerized relay deployment shape for
this phase, alongside the direct host-run shapes in Section 2.1.
Target: Linux x64/arm64 home servers only. Docker Desktop/macOS/Windows
support is not claimed. The relay generates no certificates: by default the
deployment serves plain HTTP; HTTPS is only served when the operator mounts
their own certificate/key files (passthrough, never generated or managed).
Contract files: `docker-compose.yml` (root), root `.dockerignore` (keeps
secrets and unrelated artifacts out of the build context),
`deploy/sync-relay/Dockerfile` (multi-arch-capable Node 24.11.1 image with
pnpm 10.27.0, carrying only the relay server, the shared sync contract, and
a reproducible better-sqlite3 + tsx install from
`deploy/sync-relay/pnpm-lock.yaml` via `--frozen-lockfile` — never the
Electron app, never OpenSSL),
`deploy/sync-relay/docker-entrypoint.sh` (restrictive umask 077, then init,
then exec), and `deploy/sync-relay/relay-init.mjs` (testable without
Docker).

- Compose contract: standard bridge networking with `ports:`
  (`${RELAY_PORT:-3030}:3030`; the container listens on 3030), restart
  policy `unless-stopped`, and one user-owned persistent bind mount
  (`./relay-data:/data`) holding the SQLite DB/WAL sidecars, the mode-0600
  token file, and (only when `RELAY_PUBLIC_URL` is set) the public
  `relay-config.cherry` artifact. There is no `network_mode: host`, no
  `RELAY_LAN_IP`, and no wildcard advertised endpoint: the relay binds the
  container-internal `0.0.0.0` (deployment-scoped
  `--allow-unspecified-bind`) and Docker controls host exposure.
- First-start init (once; reused byte-identical on restart): sets a
  restrictive umask (077) so DB WAL/SHM sidecars default to owner-only,
  creates a cryptographically strong token (0600, atomic temp + rename),
  ensures the DB placeholder, and — only when `RELAY_PUBLIC_URL` is set —
  writes a small versioned public config carrying only operator-supplied
  endpoint metadata (public URL, relay name, versions; never any token,
  certificate, or key). Existing token/config artifacts are strictly
  validated before reuse (corrupt token, unknown/secret config keys, bad
  types, invalid issuedAt, or public-URL mismatch fail closed without a
  rewrite). Reused on restart; no automatic rotation, backup, WAN exposure,
  reverse proxy, service manager, or cloud variant in this phase. A legacy
  `RELAY_LAN_IP` variable fails fast with an explicit error. There is no
  independent web admin UI and this path claims no production readiness.
- Transport choices (both explicitly supported): direct LAN HTTP
  (`http://<server>:<port>` — unencrypted; the client shows a visible
  non-blocking warning and the operator accepts responsibility for the
  untrusted network) or externally provided HTTPS (terminate TLS outside
  the relay, or mount your own cert/key via `RELAY_TLS_CERT_FILE` /
  `RELAY_TLS_KEY_FILE` for native relay HTTPS with ordinary verification).
  Docker itself never generates or manages certificates.
- First-start logs show only safe values: container port and bind note,
  token-file path (with retrieval instructions), DB path, config path or
  the no-public-URL note, public URL or none, and TLS passthrough paths or
  the plain-HTTP note, plus first-start/reuse status. The full token is
  never printed and no certificate/private-key artifacts are generated.
- Exact user flow: server `docker compose up -d` -> retrieve the token
   from the protected file (`docker compose exec sync-relay cat
   /data/relay-token`) -> on each Cherry Chat client, enter the server
   endpoint (`http://<server>:<port>` or your externally provided
   `https://...`) plus the token, and Connect: each client registers its own
   device code, then pair devices with an explicit device-code request ->
   accept through the client pairing UI.
   When `RELAY_PUBLIC_URL` is set, `relay-data/relay-config.cherry` records
  the operator-supplied public URL for reference; otherwise users enter the
  endpoint manually.
- Public config schema (`deploy/sync-relay/relay-config.schema.json`,
  version 2): relay name, operator-supplied public URL (`http://` or
  `https://`), and schema/init version metadata; JSON content in
  `relay-config.cherry` (mode 0644, atomic writes). No token, no
  certificate, no key, no fingerprint.
- Entrypoint preserves relay semantics: it runs init, then `exec`s the
  unchanged `scripts/sync-relay/server.ts` CLI with the container-internal
  bridge bind (`--host 0.0.0.0 --allow-unspecified-bind --port/--db`, token
  via the `SYNC_RELAY_TOKEN` env fallback so the secret never appears in
  `ps`, plus `--cert/--key` only when the operator supplied the TLS
  passthrough pair), keeping the CLI startup order (token/TLS validation
  before DB/listen) and direct SIGTERM/SIGINT delivery for graceful
  shutdown.
- No client config-import UI exists in this phase. The intended client step
  is: enter the endpoint, enter the token, connect, and pair via the
  existing pairing UI. Client import work is a separate decision.
- Explicit non-goals: no Web admin UI, no cloud-specific deployment, no
  reverse-proxy setup, no certificate automation, no backup, no rotation,
  and no WAN claims.
- Manual Docker Hub publish with pull-only server deployment (mechanics
  only, execution unvalidated): `.github/workflows/docker-relay-publish.yml`
  is `workflow_dispatch`-only with an optional `ref` input defaulting to
  `jorkey/integration` (manual-run meaning at start: the HEAD of that
  branch; `fetch-depth: 0`). The `relay-checks` job checks out that ref
  once, resolves the full 40-hex commit SHA, and passes it to `publish`
  via a job output; `publish` checks out that exact fixed SHA (never the
  mutable ref again), validates the 40-hex shape, verifies checked-out
  HEAD matches the pinned SHA, and derives the tag by explicitly taking
  the first 12 hex characters with length/character validation. The
  pre-publish gate is intentionally minimal — the relay init contract
  suite (`scripts/sync-relay/__tests__/dockerRelayInit.test.ts`) plus
  `node --check`/`sh -n` static checks, none requiring a Docker daemon —
  and is not the full `pnpm build:check` aggregate gate. On success it
  builds once with Docker Buildx for `linux/amd64,linux/arm64` and pushes
  the same manifest under two tags to
  `docker.io/jorkeyliu/cherry-chat-sync-relay`: one commit-derived
  `sha-<12-hex-commit>` tag plus the mutable `dev` tag (Docker Hub login
  via `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets). After login and
  before push it runs `docker buildx imagetools inspect` on the
  `sha-<12-hex>` reference only: tag exists fails closed, definitive
  not-found continues, and any inconclusive registry answer fails closed
  rather than risking an overwrite; the `dev` tag is explicitly mutable, is
  never immutability-checked, and moves on every publish. It never
  publishes `latest` and never deploys. Dev servers track `dev` pull-only
  by setting the full reference and skipping the local build:
  `SYNC_RELAY_IMAGE=docker.io/jorkeyliu/cherry-chat-sync-relay:dev
  docker compose pull`, then the same `SYNC_RELAY_IMAGE=... docker compose
  up -d --no-build` after every publish. `dev` is mutable and unsuitable as
  a strict production version; use the `sha-<12-hex>` tag to track/roll back
  to an exact commit with the same pull + `up -d --no-build` shape. When
  `SYNC_RELAY_IMAGE` is unset the Compose default keeps the local
  `docker compose up -d --build` path. The workflow refuses an
  already-existing sha tag but concurrent racing publishes of the same sha
  tag are still resolved by the registry, so the workflow alone does not
  claim absolute registry-level immutability. This changes no
  relay protocol or behavior and no application release/update flow; the
  updater/release freeze and identity boundaries are untouched.
- Validation boundary: the init contract is proven by focused tests without
  a Docker daemon (see Section 7). Docker image build/execution was NOT
  validated: the current host is macOS arm64 with no Docker binary/daemon,
  so Linux x64/arm64 image execution remains unproven, and the manual
  publish workflow itself has no successful run evidence yet. This path claims no
  production readiness.

## 3. What current evidence establishes

- Main-owned SQLite remains the chat authority with the operation log captured alongside the enclosing mutation for supported stable paths. The log is sync intent only, not a second authority.
- The relay path moves operations between two profiles and converges them on covered topic, message, and message-block shapes, including offline backlog with retry and fail-closed behavior on authentication failure. Automatic online convergence and cursor-based recovery after short disconnection are validated for those covered shapes; assertions cover sync status, durable cursor advance, outbox drain, and truthful errors.
- Delete/recovery semantics are validated for covered topic/message/message-block paths: online hard delete propagation, offline hard delete with automatic recovery on reconnect, late-child suppression via the parent tombstone, soft-delete topic -> restoreTopic round trip with content preserved, and concurrent delete/edit convergence to a single agreed result without asserting a fixed winner.
- Ordinary edit semantics are validated for covered message shapes: online content edit automatic convergence; paused-transport independent-field edits preserving both fields; paused same-field edits converging to the existing timestamp-then-operationId LWW winner with observable conflict-count evidence; and bounded outbox/app-restart recovery for stable message content edits — clean-close same-message 3 edits, clean-close same-topic 3 messages x1 edit each, clean-close mixed backlog (message A x2 plus B/C x1), controlled SIGTERM single-edit same-profile relaunch, and direct SIGKILL single-edit same-profile relaunch. All are bounded synthetic/disposable macOS Electron E2E cases with the same test-side relay alive across the app relaunch unless stated otherwise.
- Field-clock conflict records may increase even for disjoint edits over an existing baseline clock, while fields still merge. This is current baseline-field-clock recording behavior, not a new product decision.
- The authoritative sync path is strictly authenticated push/pull plus cursor; SSE is notification-only and never decides convergence. Auth precedence (401 before any interruption handling), 503 pause behavior with counter/cursor preservation, resume, and independent push/pull direction barriers are validated under a controlled in-memory network-interruption harness only. Direction-level interruption is additionally proven on the real two-profile path: pull interruption after the relay accepted operations with pull held then auto-convergence, and push interruption with pending retained then automatic retry after release. Batch-internal partial push and page-internal partial pull are explicitly not claimed: relay push is atomic and no deterministic in-request barrier exists.
- Relay-side identical operation replay is accepted idempotently without cursor/opcount growth on the bounded test-side relay. This proves idempotent-accept handling only; it proves no real lost-response client timing.
- Bounded file-backed reference-relay restart is validated for covered shapes: operation/cursor retention and sequence continuity across a controlled owned-process SIGTERM restart with a disposable database, including a pending stable message edit queued during the outage converging after restart through two disposable profiles and Main SQLite IPC. Convergence is decided by strictly authenticated push/pull plus cursor; SSE remains hint-only.
- Deterministic Main-only local logical baseline candidate capture exists as an internal/non-wire bootstrap input (`local_sync_baseline_candidate`, `local-sync-baseline-v1`, inventory `topic-message-stable-block-v1`): one SQLite-consistent read-only transaction over Main chat authority emitting allowlisted current state for topics, stable messages, and stable supported message blocks, plus representable tombstones and entity/field version metadata, with deterministic order, parent closure, truthful symbolic completeness (`complete` within this provisional subset only / `partial` / `unbound`), a provisional local watermark observation (never a SYNC-DATA-007 no-gap watermark), pending-outbox count only, and a SHA-256 manifest digest over canonical content. `complete` additionally requires every clocked payload field to carry a field clock and no extra clocks for absent fields (`unversioned-field` otherwise). Excluded transient/unsupported rows are never partial shells. A bounded Main-only local validated merge engine (`src/main/services/sync/syncBaselineApply.ts`, `applyLocalSyncBaselineCandidate`) exists for fully versioned complete candidates: one synchronous SQLite transaction unioning chat rows plus entity/field clocks and tombstone keys only (absence never deletes; only explicit tombstones delete; outbox/applied/cursor/channel/conflicts preserved; canonical full-payload shape with required/optional topic overflow semantics and exact field-clock match; differing fields without a local field clock fail closed even with an entity clock while equal values repair metadata; tombstones targeting live unversioned rows including cascade descendants fail closed; deletes use the authoritative FK cascade plus empty-segment cleanup without sync capture; idempotent). It is not wired to relay/bootstrap, cannot resolve unversioned same-ID conflicts, and does not establish convergence or a no-gap watermark. This proves local capture plus local merge only; it claims no bootstrap wiring, no relay payload, no reconciliation/repair, and no convergence.
- Device connection and pairing implement the [connection/channel ADR](./sync-connection-channel.md) target model (explicit Connect registers the device with a stable public device code + durable secret and automatic re-attach; pairing is a device-code request plus explicit target accept into a hidden per-channel group; push/pull/SSE require paired membership with per-channel contiguous sequencing). Pre-channel invite/founder/global-trust state is reset without migration as applied history (local chats and outbox intent preserved); founder/trust is not a current concept. The shared SYNC-CC conformance core (`tests/e2e/utils/sync-relay-conformance.ts`) runs the same observable cases against both the in-memory TestRelay and the production `createRelayServer` SQLite path. Reference relay remains a test/reference implementation, not production-ready.
- The above is limited implementation regression evidence on the current exact worktree for the covered shapes and the reference/test-side relay only. It establishes no larger/longer backlog or capacity behavior, no WAL/OS-crash/power-loss durability, no production relay lifecycle (deployment, upgrade, backup) readiness, and no compound/structured content, attachment, E2EE, or full product readiness.

## 4. Current gap to target

- Data convergence per the approved [Sync Data Convergence ADR](./sync-data-convergence.md) (`SYNC-DATA-*`, including `SYNC-DATA-019`–`SYNC-DATA-024`) is not implemented beyond local capture plus an unwired local merge: the deterministic local baseline candidate (see §3) is a future bootstrap input only, and the bounded local merge engine is not wired to relay/bootstrap, cannot resolve unversioned same-ID conflicts, and does not establish convergence or a no-gap watermark — no relay-persisted per-channel current-effective baseline plus schema/digest/watermark metadata, no offline bootstrap from the relay while prior devices are offline with N+1 replay, no watermark three-segment boundary (publish snapshot-boundary proof / relay atomic publish with N+1-onward retention / receiver single-transaction merge with cursor=N or whole rollback), no single-effective-baseline atomic replacement, no serialized per-channel publish gating with watermark-monotonic/coverage relay reject (`SYNC-DATA-023`/`SYNC-CC-019`), no in-flight bootstrap N+1 replay/repair protection (`SYNC-DATA-024`/`SYNC-CC-019`), no manifest/digest reconciliation with targeted repair, no versioned syncable-data inventory beyond the provisional subset, and no per-domain convergence status. Device-held Main SQLite state remains content truth and rebuild source; the relay baseline as offline-bootstrap availability copy is target only. The current topic/message/message-block operation-log scope is not complete-product sync; structured content, ordering/segments/branches, and attachments/attachment bytes have no convergence contract.
- Coverage beyond the validated topic, message, and message-block shapes remains unproven, including compound/complex operations, ordering under replay, and structured content, attachments, and incomplete snapshots, which stay excluded from sync payloads.
- Scale beyond covered history/outbox sizes remains unproven, including larger/longer backlog and capacity/write-amplification behavior. No capacity threshold or SLA is claimed.
- Lifecycle durability beyond the bounded restart and bounded single-edit app-restart cases remains unproven: multi-edit SIGTERM/SIGKILL backlog combinations are unproven; WAL/OS-crash/power-loss durability is explicitly unproven (direct SIGKILL relaunch proves bounded same-profile pending-edit recovery only, not storage durability under crash or power loss); relay production lifecycle (deployment, upgrade, backup) remains unproven; interruption evidence beyond direction-level push/pull barriers plus the bounded restart is unproven — batch-internal partial push and page-internal partial pull stay unclaimed.
- Push ordering beyond the covered delete/recovery and ordinary-edit paths (parents before children, deferred orphan handling, fail-closed acknowledgements and malformed payloads) and any fixed winner for concurrent delete/edit beyond the current LWW remain ungoverned.
- Conflict recovery UX, compound/structured content, attachments, and E2EE remain deferred: same-field resolution stays at the existing timestamp-then-operationId LWW with bounded conflict-count record only; there is no row-level conflict visibility and no dedicated recovery experience; structured content, attachments, and incomplete snapshots stay excluded from sync payloads; E2EE stays unproven; full product readiness stays unclaimed.

## 5. Next decision and step

The service connection + registration + channel namespace/pairing foundation governed by the [Sync Connection, Registration, and Hidden Multi-Channel Pairing ADR](./sync-connection-channel.md) (`SYNC-CC-*`) is implemented on the current exact worktree with limited validation completed (see §7): shared conformance dual-executed (in-memory + production `createRelayServer` SQLite), 5 sync Playwright specs 31/31 including file-backed production restart E2E, and `pnpm build:check` exit 0. Initial snapshot/existing-data convergence stays a separate pre-existing sync-data problem and is not part of that foundation step.

- Entry: an explicitly activated decision with claim, minimum sufficient method, and stopping condition.
- Exit: documented foundation behavior per the ADR conformance requirements with accepted trade-offs and residual risks. Exit is met as limited implementation regression evidence only; it authorizes no production readiness claim.
- No production rollout follows from this step alone; production authorization remains a separate governed decision. No implementation authorization follows from this document update. The `SYNC-DATA-019`–`SYNC-DATA-024` / `SYNC-CC-017`–`SYNC-CC-019` baseline persistence/offline-bootstrap/watermark-boundary plus publish-gate/in-flight-protection target likewise authorizes no implementation.
- Next natural implementation boundary (separately activated, not authorized here): a bounded bootstrap/convergence increment under the approved `SYNC-DATA-*` target building on the local baseline candidate (e.g. client-generated baseline with relay-persisted current-effective baseline plus schema/digest/watermark metadata, offline bootstrap while prior devices are offline with N+1 replay, watermark three-segment boundary with local/outbox preservation, serialized publish gating with watermark-monotonic/coverage relay reject per `SYNC-DATA-023`/`SYNC-CC-019`, in-flight bootstrap N+1 protection per `SYNC-DATA-024`/`SYNC-CC-019`, or manifest/digest comparison with targeted repair for the currently validated shapes). Online-device temporary supply is not the main path; no presence tracking and no baseline source election are introduced. HTTP paths/verbs, lease/ack endpoints, timeouts, chunking, capacity thresholds, retained history version counts, retained physical old-baseline counts, prior-version physical reclamation/GC mechanics stay deferred implementation choices. The current UI refinement work remains independent of that increment and is not its entry condition.

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

- Implementation: `src/main/services/sync/` (operation-log capture, apply, client, connection/registration/channel pairing; `syncBaseline.ts` deterministic Main-only local baseline candidate capture plus `syncBaselineApply.ts` bounded Main-only local validated merge plus `syncTombstoneCodec.ts` shared strict tombstone/channel-key codecs), `packages/shared/sync/` (payload shape, filtering, device-code/pairing validation, and endpoint validation accepting valid `http://`/`https://` endpoints for loopback and non-loopback hosts plus the non-loopback-HTTP warning predicate consumed by Sync Settings), `scripts/sync-relay/server.ts` (reference relay, non-production; user entrypoint via `pnpm sync:relay` with `--port/--db/--token/--host/--cert/--key/--allow-unspecified-bind/--help`, loopback and LAN plain HTTP by default, native HTTPS with user-supplied cert/key, container-internal `0.0.0.0` bridge bind only with the deployment flag, exactly-once SIGTERM/SIGINT graceful shutdown), additive sync metadata migrations `005_sync_metadata` + `006_sync_field_merge` + `008_sync_channel_reset` (`008` drops the superseded `007` trust-mirror table; the `007` migration key is retained as applied-history only; pre-channel cursor state is cleared; chats/outbox/field clocks preserved).
- Pairing behavior (SYNC-CC foundation, current worktree): `tests/e2e/specs/sync/sync-pairing.spec.ts` (real two-profile Connect/register -> device-code request -> accept -> paired sync convergence; registration/membership across app restart; Disconnect -> Connect without reconfiguration; Unpair preserving service and local chats; third-device join; paired-requester refusal and late-accept no-merge; two independent channels with isolation and independent cursors); `tests/e2e/utils/sync-relay-pairing.test.ts` (registration fail-closed, request lifecycle, atomic channel rules, dissolve, unpaired data-plane refusal, cross-channel isolation); `src/main/services/sync/__tests__/syncChannelProtocol.test.ts` (live reference-relay protocol: registration/auth, lifecycle, atomicity, dissolve, per-channel sequencing); `src/main/services/sync/__tests__/syncPairingTrust.test.ts` (explicit Connect/Disconnect, pairing-state mapping, client-side paired-request refusal, channel reconcile); `packages/shared/sync/__tests__/pairing.test.ts` (device-code/credential validation).
- Integrated behavior: `tests/e2e/specs/sync/sync-two-profiles.spec.ts` (two-profile sync scope, including delete/recovery and ordinary-edit/concurrent-edit convergence; bounded outbox/app-restart backlog — clean-close same-message 3 edits, clean-close same-topic 3 messages x1 edit each, clean-close mixed backlog, controlled SIGTERM single-edit same-profile relaunch, direct SIGKILL single-edit same-profile relaunch; direction-level interruption and idempotent replay — pull interruption after push holds reader then auto-converges, push interruption holds relay then auto-retries after release, identical operation replay is idempotent at the relay); `tests/e2e/specs/sync/sync-relay-restart.spec.ts` (bounded file-backed relay SIGTERM restart: operation/cursor retention and post-restart pending-edit convergence).
- Unit behavior: operation-log, apply, and relay suites alongside the paths above, plus `src/main/services/sync/__tests__/syncBaseline.test.ts` (43 passing focused tests, including strict malformed clock metadata validation and `unversioned-field` completeness for missing/extra per-field clocks; deterministic local baseline candidate: repeat/insertion-order canonical equivalence, digest sensitivity, allowlist non-leakage, transient/unsupported exclusion with bounded reasons, parent closure, tombstone coexistence and fail-closed parsing, field-clock allowlisting, watermark bound/unbound and fail-closed metadata, pending-outbox count without payload exposure, full read-only state preservation) plus `src/main/services/sync/__tests__/syncBaselineApply.test.ts` (26 passing focused tests, two in-memory Main DBs: independent union, independent-field merge, same-field winner and operationId tie-break, weak-incoming loss, unversioned-collision rollback, absence preservation, winning/losing tombstones with parent containment and stale-descendant suppression and live+tombstone version resolution, reparent rollback, malformed/partial/unbound/tampered/version/duplicate rejection without mutation, outbox/applied/cursor/channel/conflict preservation with no outbox creation, idempotence, mid-transaction rollback via reparent, plus F1 canonical required/unexpected/type-shape and optional-overflow exact-clock rules with full inserted-field verification, F2 unversioned live/cascade tombstone rejection, F3 missing-field-clock strict repair semantics, and F4 authoritative topic/message/block delete coverage for file_refs/segments/memberships with delete idempotence), plus `tests/e2e/utils/sync-relay-pause.test.ts` (in-memory pause/resume and direction-barrier determinism), `tests/e2e/utils/sync-relay-process.ts` (explicit file-backed relay lifecycle test harness with ownership/cleanup boundaries; disposable database, controlled owned process), and `scripts/sync-relay/__tests__/relayUserEntrypoint.test.ts` (user-entrypoint CLI contract: `sync:relay` mapping, arg/env precedence, loopback/host/port validation, `--help`, graceful SIGTERM retaining the DB with restart continuity).
- User-entrypoint persistence: `tests/e2e/specs/sync/sync-user-entrypoint.spec.ts` (two real profiles through the user entrypoint file with explicit `--db/--token`: independent config, registration/channel membership, covered sync, relay stop with truthful failure and pinned per-channel cursors, same DB/token restart with retained registration/channel membership/operations/per-channel cursors and post-restart convergence) via `tests/e2e/utils/sync-relay-user-entrypoint.ts` (same entrypoint file and CLI args as `pnpm sync:relay`; Electron-as-Node launcher only for the ABI 145 lane; disposable owned root only).
- LAN path: `scripts/sync-relay/__tests__/relayLanHttps.test.ts` (non-loopback plain HTTP as an explicit supported transport with health coverage, user-supplied cert/key HTTPS, fail-before-DB on missing/empty/mismatched/partial material, container-internal unspecified bind gated on the deployment flag, native HTTPS health/readiness with disposable cert/key and explicit CA trust, loopback HTTP regression) and `tests/e2e/specs/sync/sync-lan-https.spec.ts` (two real profiles over dynamically discovered non-loopback HTTPS with explicit CA trust: registration/channel membership, covered sync, relay stop with truthful failure and pinned per-channel cursors, same DB/cert/key/token restart with retained registration/channel membership/operations/per-channel cursors and post-restart convergence; explicit skip when no suitable interface is available).
- Docker Compose deployment contract: `scripts/sync-relay/__tests__/dockerRelayInit.test.ts` (focused suite, no Docker daemon: first init creates token/DB with safe modes and secret-free logs and no certificate artifacts; `RELAY_PUBLIC_URL` writes a metadata-only public config; second init reuses byte-identical artifacts; corrupt token/config fails closed; legacy `RELAY_LAN_IP` fails fast; public config matches `deploy/sync-relay/relay-config.schema.json` v2; Dockerfile/Compose/entrypoint structural checks for bridge networking, ports, and the container-internal bind) over `deploy/sync-relay/relay-init.mjs` (first-start init/reuse/fail-closed logic for token/DB/optional public config/optional TLS passthrough), `deploy/sync-relay/docker-entrypoint.sh` (Linux check, init, `exec` of the unchanged relay CLI with `--host 0.0.0.0 --allow-unspecified-bind --port/--db` and token via `SYNC_RELAY_TOKEN`, plus `--cert/--key` only for the operator-supplied passthrough pair), `deploy/sync-relay/Dockerfile` (multi-arch Node 24.11.1 + pnpm 10.27.0, narrow relay payload, no OpenSSL), and root `docker-compose.yml` (standard bridge networking with `ports:`, no `RELAY_LAN_IP`/host network, one `./relay-data:/data` mount). Docker image build/execution not validated on the macOS host (no Docker binary/daemon).
- Current validation (current exact worktree, limited implementation regression only, not production readiness): `pnpm build:check` exit 0 covering lint, `openapi:check`, and full Vitest command including `typecheck:e2e` / `typecheck:e2e-utils`, `test:e2e-utils`, and i18n gates; focused `syncBaseline` capture 43/43 and `syncBaselineApply` 26/26 suites passed; 5 sync Playwright specs 31/31 (`sync-pairing`, `sync-two-profiles`, `sync-relay-restart`, `sync-user-entrypoint`, `sync-lan-https`); shared SYNC-CC conformance dual-executed against the in-memory TestRelay and the production `createRelayServer` SQLite path; file-backed production restart E2E passed. CI adds the focused production file-backed relay restart E2E (`sync-relay-restart-e2e` job: `pnpm test:e2e tests/e2e/specs/sync/sync-relay-restart.spec.ts`). Still not production-ready: snapshot/backfill, capacity, WAL/power-loss, E2EE, attachments, and other §4 gaps unchanged. All evidence remains bounded synthetic/disposable macOS Electron E2E/test-side relay scope and must not be extrapolated to production readiness. Reference/test-side relay remains not production-ready.
- Git owns run history; this document carries no per-run history.

## 8. Fallback activation condition

PowerSync, cr-sqlite with relay, Turso Database Sync, and Automerge-family approaches are conditional fallbacks only.

A fallback is considered only when both hold in the same concrete scenario: a reproducible blocker on the primary path against the goal in Section 1, and evidence of a clear advantage of that fallback in that same scenario. Activation requires a new explicit decision. No parallel comparison runs before that decision.
