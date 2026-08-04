/**
 * LOCK-SNAP-2: retained pre-import snapshot file evidence.
 *
 * The retained pre-import snapshot must be a REGULAR non-symlink NON-EMPTY
 * file before any readonly verification runs against it. This helper enforces
 * exactly that with fixed, path-free failure messages; the caller then runs
 * the bounded batched readonly verify plan (e.g.
 * `verifyChatDbViaElectronWithRetry`) on the validated path.
 *
 * E2E-only (tests/e2e); never imported by production code.
 */
import * as fs from 'node:fs'

/** Throw with a fixed path-free message when the snapshot is not a valid file. */
export function assertRetainedSnapshotFile(snapshotPath: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(snapshotPath)
  } catch {
    throw new Error('retained pre-import snapshot missing')
  }
  if (stat.isSymbolicLink()) {
    throw new Error('retained pre-import snapshot must not be a symlink')
  }
  if (!stat.isFile()) {
    throw new Error('retained pre-import snapshot must be a regular file')
  }
  if (!(stat.size > 0)) {
    throw new Error('retained pre-import snapshot must be non-empty')
  }
}
