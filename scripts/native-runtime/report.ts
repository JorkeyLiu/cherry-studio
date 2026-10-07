import type { CheckReport } from './types'

/**
 * Concise deterministic formatting for `native:check:*` reports. Full
 * diagnostics stay on the structured report; the CLI prints a bounded summary
 * plus actionable failure lines.
 */

/** Deterministic line label width. */
function line(label: string, value: string): string {
  return `${label.padEnd(18)}${value}`
}

/** Clip a diagnostic to a bounded width so reports never dump huge payloads. */
function clip(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

/** Format a `CheckReport` into concise, deterministic human-readable output. */
export function formatCheckReport(report: CheckReport): string {
  const out: string[] = [
    line('command:', `native:check:${report.target}`),
    line('runtime:', `${report.runtimeName} ${report.runtimeVersion}`),
    line(
      'abi:',
      `${report.abi} (informational; Node-API binary is runtime-agnostic)` +
        (report.nodeVersion ? ` embedded node ${report.nodeVersion}` : '')
    ),
    line('platform:', `${report.platform}/${report.arch}`),
    line(
      'package:',
      `${report.packagePath ?? '(unresolved)'}${report.packageVersion ? ` @ ${report.packageVersion}` : ''}`
    ),
    line('sql:', report.sqlVerified ? 'verified (:memory: select 1 + close)' : 'NOT verified'),
    line('result:', report.ok ? 'PASS' : 'FAIL')
  ]
  if (!report.ok) {
    for (const failure of report.failures) {
      out.push(line('failure:', clip(failure, 400)))
    }
  }
  return `${out.join('\n')}\n`
}
