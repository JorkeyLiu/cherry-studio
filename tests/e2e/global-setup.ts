import * as fs from 'fs'
import * as path from 'path'

import { createRunToken, initializeRunRegistry, RUN_TOKEN_ENV } from './utils/run-ownership'

/**
 * Global setup for Playwright e2e tests.
 * This runs once before all tests.
 */
async function globalSetup() {
  console.log('Running global setup...')

  const runToken = createRunToken()
  process.env[RUN_TOKEN_ENV] = runToken
  initializeRunRegistry(runToken)
  console.log(`[E2E] Run ownership initialized: ${runToken}`)

  // Create test results directories
  const resultsDir = path.join(process.cwd(), 'test-results')
  const screenshotsDir = path.join(resultsDir, 'screenshots')

  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true })
  }

  // Set environment variables for testing
  process.env.NODE_ENV = 'test'

  console.log('Global setup complete')
}

export default globalSetup
