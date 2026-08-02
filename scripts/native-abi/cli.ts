/**
 * Native ABI tool CLI — entry point for the repo-owned commands:
 *
 *   pnpm native:check:node       tsx scripts/native-abi/cli.ts check node
 *   pnpm native:check:electron   tsx scripts/native-abi/cli.ts check electron
 *   pnpm native:rebuild:node     tsx scripts/native-abi/cli.ts rebuild node
 *   pnpm native:rebuild:electron tsx scripts/native-abi/cli.ts rebuild electron
 *
 * Exit codes: 0 = PASS, 1 = FAIL, 2 = usage error.
 */
import { runCheck } from './check'
import { createEffects } from './effects'
import { runRebuild } from './rebuild'
import { formatCheckReport, formatRebuildReport } from './report'
import type { Command, Target } from './types'

function usage(): string {
  return [
    'usage: tsx scripts/native-abi/cli.ts <check|rebuild> <node|electron>',
    '',
    '  check    node       verify the binding works under a supported Node24 (ABI 137)',
    '  check    electron   verify the binding works under Electron 41.2.1 (ABI 145)',
    '  rebuild  node       node-gyp source build of better-sqlite3 for Node24',
    '  rebuild  electron   @electron/rebuild source build of better-sqlite3 for Electron',
    '',
    'Checks are read-only and never modify node_modules. Rebuilds are explicit'
  ].join('\n')
}

function isCommand(v: string | undefined): v is Command {
  return v === 'check' || v === 'rebuild'
}

function isTarget(v: string | undefined): v is Target {
  return v === 'node' || v === 'electron'
}

async function main(): Promise<number> {
  const [command, target] = process.argv.slice(2)
  if (!isCommand(command) || !isTarget(target)) {
    process.stdout.write(usage() + '\n')
    return 2
  }

  const effects = createEffects()
  if (command === 'check') {
    const report = runCheck(effects, target)
    process.stdout.write(formatCheckReport(report))
    return report.ok ? 0 : 1
  }
  const report = await runRebuild(effects, target)
  process.stdout.write(formatRebuildReport(report))
  return report.ok ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`native-abi tool error: ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exitCode = 1
  })
