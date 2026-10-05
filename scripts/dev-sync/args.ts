/**
 * Pure CLI argument parsing for `pnpm dev:sync`.
 *
 * Only the fixed-port overrides plus `--help` are supported: the fixture is
 * intentionally one command with persistent state, not a configurable matrix.
 * Unknown options fail closed with the help text pointer (never silently
 * ignored).
 */
import { DEV_SYNC_DEFAULT_CDP_A, DEV_SYNC_DEFAULT_CDP_B, DEV_SYNC_DEFAULT_RELAY_PORT } from './constants'

export interface DevSyncArgs {
  relayPort: number
  cdpA: number
  cdpB: number
  help: boolean
}

export const DEV_SYNC_DEFAULT_ARGS: DevSyncArgs = {
  relayPort: DEV_SYNC_DEFAULT_RELAY_PORT,
  cdpA: DEV_SYNC_DEFAULT_CDP_A,
  cdpB: DEV_SYNC_DEFAULT_CDP_B,
  help: false
}

function parsePortFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    throw new Error(`missing value for ${flag} (expected 1-65535)`)
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`invalid ${flag} '${raw.slice(0, 32)}' (expected 1-65535)`)
  }
  const port = Number(raw)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid ${flag} '${raw.slice(0, 32)}' (expected 1-65535)`)
  }
  return port
}

export function parseDevSyncArgs(argv: readonly string[]): DevSyncArgs {
  let relayPort = DEV_SYNC_DEFAULT_RELAY_PORT
  let cdpA = DEV_SYNC_DEFAULT_CDP_A
  let cdpB = DEV_SYNC_DEFAULT_CDP_B
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--relay-port' || arg === '--cdp-a' || arg === '--cdp-b') {
      const raw = argv[i + 1]
      if (arg === '--relay-port') relayPort = parsePortFlag(arg, raw)
      else if (arg === '--cdp-a') cdpA = parsePortFlag(arg, raw)
      else cdpB = parsePortFlag(arg, raw)
      i++
      continue
    }
    throw new Error(`unknown option '${String(arg).slice(0, 64)}' (see: pnpm dev:sync -- --help)`)
  }
  if (cdpA === cdpB) {
    throw new Error(`--cdp-a and --cdp-b must differ (got ${cdpA})`)
  }
  return { relayPort, cdpA, cdpB, help }
}
