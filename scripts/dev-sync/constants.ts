/**
 * Shared constants for the fresh-session two-profile dev sync fixture (`pnpm dev:sync`).
 *
 * The fixture lives under `<repo>/local/dev-sync` (the `local/` prefix is
 * already gitignored, so no new ignore rule is needed). The layout contract:
 *
 * - DURABLE (retained across runs, never deleted by stop):
 *   `settings-a.json` / `settings-b.json` — owner-only (0600) allowlisted
 *   settings seeds (ordinary appearance/general config, user-defined LLM
 *   providers + model slots, assistant defaults + config-only assistants).
 *   Provider API keys may be inside: the files are owner-only and values are
 *   never logged. Chat content, topics, anchors, and device auth are NEVER
 *   seeded (see `settings-seed.ts` for the retention/exclusion contract).
 * - FRESH (unique per run under `sessions/<session-id>/`):
 *   `profile-a`, `profile-b`, and `relay-data/relay.db` (+ relay attachment
 *   blobs derived adjacent to the DB). Every invocation creates a new session
 *   dir; previous session dirs are left untouched for inspection, never
 *   replayed and never deleted.
 * - REUSABLE: `relay-runtime` — the isolated relay dependency cache. Rebuilt
 *   only when the mirrored manifest/lock drifts; never deleted on stop.
 * - LEGACY (v1, left untouched): root-level `profile-a`, `profile-b`, and
 *   `relay-data` from the old persistent fixture are preserved as-is and are
 *   never read, copied, or deleted by the runner.
 *
 * Only the supervisor lock is removed on clean exit. There is NO shared
 * access token anywhere: pairing is address + public device code only, and
 * device secrets/channels are generated fresh inside each new session relay.
 */

export const DEV_SYNC_DIR_NAME = 'dev-sync'

export const DEV_SYNC_FIXTURE_VERSION = 2

export const DEV_SYNC_FIXTURE_KIND = 'dev-sync-fresh-sessions-v1'

/** Previous persistent-profiles marker, accepted once and migrated in place. */
export const DEV_SYNC_LEGACY_FIXTURE_KIND = 'dev-sync-persistent-profiles-v1'

export const DEV_SYNC_LEGACY_FIXTURE_VERSION = 1

/** Legacy v1 persistent dirs at the fixture root: preserved, never touched. */
export const DEV_SYNC_LEGACY_PROFILE_A = 'profile-a'

export const DEV_SYNC_LEGACY_PROFILE_B = 'profile-b'

export const DEV_SYNC_LEGACY_RELAY_DATA_DIR = 'relay-data'

export const DEV_SYNC_SESSIONS_DIR = 'sessions'

export const DEV_SYNC_PROFILE_A = 'profile-a'

export const DEV_SYNC_PROFILE_B = 'profile-b'

export const DEV_SYNC_RELAY_DATA_DIR = 'relay-data'

export const DEV_SYNC_RELAY_RUNTIME_DIR = 'relay-runtime'

export const DEV_SYNC_RELAY_DB_FILE = 'relay.db'

export const DEV_SYNC_SETTINGS_SEED_A_FILE = 'settings-a.json'

export const DEV_SYNC_SETTINGS_SEED_B_FILE = 'settings-b.json'

export const DEV_SYNC_LOCK_FILE = '.dev-sync.lock'

export const DEV_SYNC_FIXTURE_FILE = '.dev-sync-fixture.json'

/** Default loopback relay port. Fails fast when busy; override with --relay-port. */
export const DEV_SYNC_DEFAULT_RELAY_PORT = 3039

export const DEV_SYNC_DEFAULT_RELAY_HOST = '127.0.0.1'

/** Fixed CDP ports for Playwright attach/setup (fail fast when busy). */
export const DEV_SYNC_DEFAULT_CDP_A = 9223

export const DEV_SYNC_DEFAULT_CDP_B = 9224

/** Production user-data dir names that the fixture must never touch. */
export const DEV_SYNC_FORBIDDEN_BASENAMES = ['CherryChat', 'CherryStudio', 'Cherry Chat', 'Cherry Studio'] as const

export const DEV_SYNC_HELP_TEXT = [
  'Cherry Chat fresh-session two-profile dev sync fixture.',
  '',
  'Usage:',
  '  pnpm dev:sync                       start relay + profiles A/B (fresh session)',
  '  pnpm dev:sync -- --help             show this help and exit 0',
  '  pnpm dev:sync -- --relay-port 3040  use an explicit alternative relay port',
  '  pnpm dev:sync -- --cdp-a 9233 --cdp-b 9234',
  '                                      use explicit alternative CDP ports',
  '',
  'What one command starts:',
  '  - a local loopback sync relay (default http://127.0.0.1:3039) backed by',
  '    a FRESH per-session relay DB under',
  '    local/dev-sync/sessions/<session-id>/relay-data, running from an',
  '    isolated relay runtime with its own dependency cache',
  '    (local/dev-sync/relay-runtime) so the repository root native binding',
  '    is never switched or rebuilt;',
  '  - ONE shared renderer dev server (canonical electron.vite.config.ts)',
  '    owned by the first profile child, serving TWO Electron apps;',
  '  - TWO FRESH isolated Electron profiles A/B under',
  '    local/dev-sync/sessions/<session-id>/profile-a and profile-b, each',
  '    launched with an exact --user-data-dir override and verified at',
  '    runtime via window.api.getAppInfo().appDataPath BEFORE any mutation.',
  '',
  'Settings retained, content fresh:',
  '  - Ordinary settings are RETAINED across runs via owner-only seed files',
  '    (local/dev-sync/settings-a.json / settings-b.json, mode 0600):',
  '    renderer settings slice, user-defined LLM providers + default/quick/',
  '    translate models, and assistant defaults + config-only assistants.',
  '    Changed config is snapshotted on graceful stop (Ctrl-C/SIGTERM) BEFORE',
  '    the apps close, so edits survive repeated commands.',
  '  - Chat content is ALWAYS fresh: topics, messages, context-window',
  '    anchors, sync device auth/channel/cursor state, and the relay DB are',
  '    never carried into a new session. Provider API keys inside the seeds',
  '    stay local and are never logged.',
  '',
  'Manual pairing EVERY RUN (never automatic):',
  '  - Both profiles auto-configure the loopback endpoint (enabled) and',
  '    connect (each registers its own public device code, shown in the',
  '    terminal and in Sync Settings). Pairing itself stays manual: in one',
  '    profile enter the other profile device code and send the request,',
  '    then accept it in the other profile (Settings -> Data -> Sync).',
  '    A fresh relay DB means profiles start unpaired every run.',
  '  - Per window: open Settings -> Data, choose the Sync menu to see the',
  '    device code, pairing status, and request/accept controls (zh-CN UI).',
  '',
  'Safety:',
  '  - A second `pnpm dev:sync` against the same fixture fails fast instead',
  '    of stealing the running session; stop the owner (Ctrl-C) first.',
  '  - Fixed ports fail fast when busy (no killing, no stealing); pass an',
  '    explicit alternative flag from Usage above when needed.',
  '  - An abnormal child exit shuts all owned children down; settings seeds',
  '    and the relay-runtime cache are still preserved (the in-flight session',
  '    snapshot for that run may be lost).',
  '  - Previous session dirs and legacy v1 fixture dirs are never deleted;',
  '    remove them manually if disk use matters.'
].join('\n')
