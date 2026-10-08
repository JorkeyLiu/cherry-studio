/**
 * Native runtime check CLI — entry point for the repo-owned commands:
 *
 *   pnpm native:check:node       tsx scripts/native-runtime/cli.ts check node
 *   pnpm native:check:electron   tsx scripts/native-runtime/cli.ts check electron
 *
 * Both commands are LIGHT read-only runtime check diagnostics: they verify
 * the locked better-sqlite3 version and run a real `:memory:` SQL probe under
 * the target runtime. They never modify node_modules, never rebuild, never
 * lock, and never touch user databases. Exit codes: 0 = PASS, 1 = FAIL,
 * 2 = usage error.
 */
import { runCheck } from './check'
import { createEffects } from './effects'
import { formatCheckReport } from './report'
import type { Target } from './types'

function usage(): string {
  return [
    'usage: tsx scripts/native-runtime/cli.ts check <node|electron>',
    '',
    '  check    node       verify the shared binary works under Node24 (:memory: SQL probe)',
    '  check    electron   verify the shared binary works under Electron 41.2.1 (:memory: SQL probe)',
    '',
    'Checks are read-only and never modify node_modules. A failure is a',
    'dependency problem: pin the locked better-sqlite3 version and reinstall.'
  ].join('\n')
}

function isTarget(v: string | undefined): v is Target {
  return v === 'node' || v === 'electron'
}

async function main(): Promise<number> {
  const [command, target] = process.argv.slice(2)
  if (command !== 'check' || !isTarget(target)) {
    process.stdout.write(usage() + '\n')
    return 2
  }

  const effects = createEffects()
  const report = runCheck(effects, target)
  process.stdout.write(formatCheckReport(report))
  return report.ok ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`native-runtime tool error: ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exitCode = 1
  })
