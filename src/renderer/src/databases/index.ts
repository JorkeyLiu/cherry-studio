/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 *
 * Re-export barrel for the canonical Dexie schema module. The singleton and
 * schema declarations live in `./dbSchema` (side-effect-minimal, lazy upgrade
 * callbacks); this barrel keeps every existing consumer source-compatible:
 *
 *   import db from '@renderer/databases'
 *   import { db } from '@renderer/databases'
 *
 * The isolated chatImport renderer dynamic-imports `./dbSchema` directly so it
 * never evaluates the main renderer bundle.
 */
export { db, default } from './dbSchema'
