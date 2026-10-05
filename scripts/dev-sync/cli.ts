/**
 * `pnpm dev:sync` entrypoint (started once under the canonical Electron lane
 * via `pnpm native:run electron -- tsx scripts/dev-sync/cli.ts [...]`).
 *
 * `--help` prints the fixture contract and exits without touching the lane,
 * ports, or profiles. Anything else runs the supervisor, whose exit code is
 * propagated verbatim.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseDevSyncArgs } from './args'
import { DEV_SYNC_HELP_TEXT } from './constants'
import { runDevSyncSupervisor } from './supervisor'

async function main(): Promise<void> {
  // Extra argv after `tsx scripts/dev-sync/cli.ts` (pnpm forwards `-- ...`
  // through, so a bare `--` separator is stripped here, not in the parser).
  const argv = process.argv.slice(2).filter((entry) => entry !== '--')
  let parsed
  try {
    parsed = parseDevSyncArgs(argv)
  } catch (error) {
    process.stderr.write(`[dev-sync] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }
  if (parsed.help) {
    process.stdout.write(`${DEV_SYNC_HELP_TEXT}\n`)
    process.exitCode = 0
    return
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const { exitCode } = await runDevSyncSupervisor(repoRoot, parsed)
  process.exitCode = exitCode
}

main().catch((error) => {
  process.stderr.write(`[dev-sync] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
