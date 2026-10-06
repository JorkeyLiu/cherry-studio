/**
 * Shared constants for the persistent two-profile dev sync fixture (`pnpm dev:sync`).
 *
 * The fixture lives under `<repo>/local/dev-sync` (the `local/` prefix is
 * already gitignored, so no new ignore rule is needed). The layout contract:
 *
 * - DURABLE (retained across runs, never deleted by stop):
 *   `sessions/<active-session>/profile-a`, `profile-b`, and
 *   `relay-data/relay.db` (+ relay attachment blobs adjacent to the DB).
 *   The SAME adopted pair is reused every run: ordinary app persistence
 *   (chat, assets, providers, settings, device auth, channel, cursor, outbox,
 *   relay state) is preserved by the app itself, exactly like a normal close.
 *   The runner performs NO settings-seed restore, NO settings snapshot, NO
 *   store injection, and NO sync endpoint/configure/connect override.
 * - POINTER (one-time adoption, then fixed):
 *   `.dev-sync-active.json` records the adopted existing session basename
 *   (relative only, no absolute private paths). Once valid it is ALWAYS
 *   reused; a corrupted pointer or a missing target fails closed (never a
 *   silent reset or a fresh empty pair over existing data).
 * - REUSABLE: `relay-runtime` — the isolated relay dependency cache. Rebuilt
 *   only when the mirrored manifest/lock drifts; never deleted on stop.
 * - LEGACY (left untouched, never read, never migrated automatically):
 *   root-level `profile-a`, `profile-b`, `relay-data` (v1 persistent dirs),
 *   `settings-a.json` / `settings-b.json` (retired settings seeds), and every
 *   previous `sessions/<id>/` dir. They stay on disk as-is; the runner never
 *   reads their content, copies, renames, or deletes them.
 *
 * Only the supervisor lock is removed on clean exit. There is NO shared
 * access token anywhere: pairing is address + public device code only, and
 * device secrets/channels live in the reused app/relay state.
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

/**
 * Retired settings-seed filenames (v2 fresh-session era). The files stay on
 * disk untouched when present; the runner never reads their content and never
 * writes them. Kept as constants only so logs can name the ignored legacy
 * without touching it.
 */
export const DEV_SYNC_SETTINGS_SEED_A_FILE = 'settings-a.json'

export const DEV_SYNC_SETTINGS_SEED_B_FILE = 'settings-b.json'

export const DEV_SYNC_LOCK_FILE = '.dev-sync.lock'

export const DEV_SYNC_FIXTURE_FILE = '.dev-sync-fixture.json'

/**
 * Durable active-pair pointer (one-time adoption, then fixed). Value is the
 * adopted session BASENAME only (never an absolute path, never credentials).
 */
export const DEV_SYNC_ACTIVE_FILE = '.dev-sync-active.json'

export const DEV_SYNC_ACTIVE_KIND = 'dev-sync-active-v1'

export const DEV_SYNC_ACTIVE_VERSION = 1

/**
 * Stable session id created ONCE for a clean fixture with no sessions.
 * Subsequent runs reuse it (never fresh per run).
 */
export const DEV_SYNC_STABLE_SESSION_ID = 'sess-persistent-pair-v1'

/** Default loopback relay port. Fails fast when busy; override with --relay-port. */
export const DEV_SYNC_DEFAULT_RELAY_PORT = 3039

export const DEV_SYNC_DEFAULT_RELAY_HOST = '127.0.0.1'

/** Fixed CDP ports for Playwright attach (fail fast when busy). */
export const DEV_SYNC_DEFAULT_CDP_A = 9223

export const DEV_SYNC_DEFAULT_CDP_B = 9224

/** Production user-data dir names that the fixture must never touch. */
export const DEV_SYNC_FORBIDDEN_BASENAMES = ['CherryChat', 'CherryStudio', 'Cherry Chat', 'Cherry Studio'] as const

export const DEV_SYNC_HELP_TEXT = [
  'Cherry Chat persistent two-profile dev sync fixture.',
  '',
  'Usage:',
  '  pnpm dev:sync                       start relay + profiles A/B (persistent pair)',
  '  pnpm dev:sync -- --help             show this help and exit 0',
  '  pnpm dev:sync -- --relay-port 3040  use an explicit alternative relay port',
  '  pnpm dev:sync -- --cdp-a 9233 --cdp-b 9234',
  '                                      use explicit alternative CDP ports',
  '',
  'What one command starts:',
  '  - a local loopback sync relay (default http://127.0.0.1:3039) backed by',
  '    the REUSED durable relay DB under',
  '    local/dev-sync/sessions/<active-session>/relay-data, running from an',
  '    isolated relay runtime with its own dependency cache',
  '    (local/dev-sync/relay-runtime) so the repository root native binding',
  '    is never switched or rebuilt;',
  '  - ONE shared renderer dev server (canonical electron.vite.config.ts)',
  '    owned by the first profile child, serving TWO Electron apps;',
  '  - the SAME TWO durable Electron profiles A/B under',
  '    local/dev-sync/sessions/<active-session>/profile-a and profile-b,',
  '    each launched with an exact --user-data-dir override and verified at',
  '    runtime via window.api.getAppInfo().appDataPath BEFORE any claim.',
  '',
  'Natural app persistence (nothing cleared, nothing injected):',
  '  - Profiles A/B, chat, assets, providers, settings, device auth, channel,',
  '    cursor, outbox, and relay state are PRESERVED across runs by the app',
  '    itself, exactly like a normal close. The runner performs no store',
  '    injection, no settings-seed restore, and no settings snapshot.',
  '  - Sync endpoint/enabled stays exactly as the user left it in the app.',
  '    The runner never auto-enables sync, never configures the endpoint,',
  '    and never connects on the user behalf. Pair once in the app; the',
  '    pairing persists across restarts.',
  '  - Active pair: .dev-sync-active.json records the one-time adopted',
  '    existing session basename (relative only). A valid pointer is always',
  '    reused; a corrupted pointer or missing target fails closed.',
  '  - Legacy seeds (settings-a/b.json), legacy v1 root dirs, and previous',
  '    session dirs are left on disk untouched: never read, copied, renamed,',
  '    migrated, or deleted automatically.',
  '',
  'Profile setup is diagnostic readiness only:',
  '  - The runner verifies the persisted profile identity (runtime appDataPath',
  '    equals the adopted --user-data-dir) and that the window runtime is',
  '    available (typed window.api.getAppInfo + rendered body). It works on',
  '    any ordinary app route, forces no language, theme, model, onboarding,',
  '    navigation, or reload, and writes nothing to the store.',
  '  - First-run onboarding, when present, is shown as-is for the user to',
  '    complete; the runner never bypasses it.',
  '',
  'Safety:',
  '  - A second `pnpm dev:sync` against the same fixture fails fast instead',
  '    of stealing the running session; stop the owner (Ctrl-C) first.',
  '  - Fixed ports fail fast when busy (no killing, no stealing); pass an',
  '    explicit alternative flag from Usage above when needed.',
  '  - An abnormal child exit shuts all owned children down; durable profiles',
  '    and the relay-runtime cache are still preserved (the app persists on',
  '    its own normal close path).',
  '  - Durable profiles, the relay DB, legacy dirs, and previous sessions are',
  '    never deleted; remove them manually if disk use matters. There is no',
  '    reset flag and no profile-deletion feature.'
].join('\n')
