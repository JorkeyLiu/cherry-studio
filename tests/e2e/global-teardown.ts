/**
 * Global teardown for Playwright e2e tests.
 * This runs once after all tests complete.
 *
 * LOCK-004: Global teardown must not kill/delete other concurrent run assets.
 * Fixture-owned cleanup is primary (userDataDir fixture teardown throws on errors).
 * This teardown only performs ownership-safe safety-net checks on per-run registries.
 *
 * Ownership model:
 *   - Global setup creates one unique invocation token and exact registry path.
 *   - Fixture workers append only their owned profiles to that registry.
 *   - This teardown processes only the registry for the current invocation token.
 *   - No broad process patterns or glob-delete of registries or profiles.
 */
import { cleanupRunRegistry, getRequiredRunToken } from './utils/run-ownership'

async function globalTeardown() {
  console.log('[E2E] Running global teardown...')

  const runToken = getRequiredRunToken()
  const errors = cleanupRunRegistry(runToken)

  if (errors.length > 0) {
    console.error(`[E2E] Global teardown completed with ${errors.length} error(s): ${errors.join('; ')}`)
    throw new Error(`Global teardown failed: ${errors.join('; ')}`)
  } else {
    console.log('[E2E] Global teardown complete: no issues')
  }
}

export default globalTeardown
