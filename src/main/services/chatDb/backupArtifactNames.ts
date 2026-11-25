/**
 * Reserved Data-root artifact names from the retired external-app import pipeline.
 *
 * Cherry Chat no longer creates these artifacts and never scans, migrates, or
 * deletes user files. The names stay pinned because same-app backup/restore
 * still excludes them: a stale artifact left by an older build must never
 * round-trip into a restored profile or overwrite live state.
 */

/** Former candidate root under the Data root. */
export const CANDIDATE_ROOT_DIRNAME = 'chat-import-candidates'

/** Former promotion journal and its crash-safe staging sibling. */
export const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'
export const PROMOTION_JOURNAL_STAGING_FILENAME = `${PROMOTION_JOURNAL_FILENAME}.staging`

/** Former chat.db rollback snapshot and staging file. */
export const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'
export const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'

/** Former Files rollback snapshot generations and promote staging dir. */
export const FILES_ROLLBACK_SNAPSHOT_DIRNAME = 'Files.pre-import-backup'
export const FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME = 'Files.pre-import-backup.staging'
export const FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME = 'Files.pre-import-backup.old'
export const FILES_PROMOTE_STAGING_DIRNAME = 'Files.promote-staging'

/** Former Dexie files-catalog snapshot and staging file. */
export const FILES_CATALOG_SNAPSHOT_FILENAME = 'files-catalog.snapshot.json'
export const FILES_CATALOG_SNAPSHOT_STAGING_FILENAME = 'files-catalog.snapshot.json.staging'

/**
 * Former one-shot migration_state key used by the retired import handoff.
 * It is still tolerated in restored local databases so existing user data
 * keeps validating; this module never reads or writes that row.
 */
export const LEGACY_NAVIGATION_PROJECTION_STATE_KEY = 'import_navigation_projection_v1'
