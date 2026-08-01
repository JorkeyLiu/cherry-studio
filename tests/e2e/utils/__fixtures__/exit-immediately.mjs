/**
 * Minimal child fixture that exits immediately with a non-zero code.
 * Used by owned-vite-server.test.ts to verify that child exit before
 * ready is detected promptly and rejects readiness.
 *
 * This fixture does NOT start Vite or import Electron.
 */
process.exit(1)
