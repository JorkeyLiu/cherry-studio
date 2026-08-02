import type { CheckReport, RebuildReport } from './types'

/**
 * Human-readable report formatting for the native ABI commands. Every check
 * prints runtime name/version/ABI/platform/arch, the better-sqlite3 package
 * realpath, the actual resolved binding path, whether SQL was verified, the
 * marker state (always ignored by checks), and — on failure — the exact
 * corresponding repair command.
 */

function line(label: string, value: string): string {
  return `${label.padEnd(18)}${value}`
}

export function formatCheckReport(report: CheckReport): string {
  const out: string[] = []
  out.push('')
  out.push(line('command:', `native:check:${report.target}`))
  out.push(line('runtime:', `${report.runtimeName} ${report.runtimeVersion}`))
  if (report.target === 'electron' && report.nodeVersion) {
    out.push(line('node:', `embedded ${report.nodeVersion}`))
  }
  out.push(line('ABI:', String(report.abi)))
  out.push(line('platform/arch:', `${report.platform}/${report.arch}`))
  if (report.packagePath) {
    out.push(line('package:', report.packagePath))
  }
  if (report.bindingPath) {
    out.push(line('binding:', report.bindingPath))
  }
  out.push(
    line(
      'sql verified:',
      report.sqlVerified
        ? `PASS (Database(':memory:') / select 1 as ok / closed)`
        : 'FAIL (real runtime SQL did not pass)'
    )
  )
  if (report.probeExitCode !== undefined) {
    out.push(line('probe exit:', String(report.probeExitCode)))
  }
  if (report.probeCloseError) {
    out.push(line('probe close:', report.probeCloseError))
  }
  out.push(line('marker:', report.markerState))
  if (report.ok) {
    out.push(line('status:', 'PASS'))
  } else {
    out.push(line('status:', 'FAIL'))
    for (const failure of report.failures) {
      out.push(`  - ${failure}`)
    }
    if (report.repairCommand) {
      out.push(`repair: ${report.repairCommand}`)
    }
  }
  out.push('')
  return out.join('\n')
}

export function formatRebuildReport(report: RebuildReport): string {
  const out: string[] = []
  out.push('')
  out.push(line('command:', `native:rebuild:${report.target}`))
  out.push(line('runtime:', `node ${report.nodeVersion} (ABI ${report.abi})`))
  out.push(line('platform/arch:', `${report.platform}/${report.arch}`))
  if (report.packagePath) {
    out.push(line('package:', report.packagePath))
  }
  if (report.bindingPath) {
    out.push(line('binding:', report.bindingPath))
  }
  if (report.markerBefore.length > 0) {
    for (const snapshot of report.markerBefore) {
      out.push(line('marker before:', `${snapshot.path} = ${snapshot.content ?? '(unreadable)'}`))
    }
  } else {
    out.push(line('marker before:', '(none)'))
  }
  if (report.toolOutput.length > 0) {
    out.push('--- rebuild tool output ---')
    for (const l of report.toolOutput.slice(0, 200)) {
      out.push(`  ${l}`)
    }
    if (report.toolOutput.length > 200) {
      out.push(`  ... (${report.toolOutput.length - 200} more lines)`)
    }
  }
  if (report.ok) {
    out.push(line('status:', 'PASS'))
    if (report.postCheck) {
      out.push(`post-check: native:check:${report.target} PASS (ABI ${report.postCheck.abi}, sql verified)`)
    }
  } else {
    out.push(line('status:', 'FAIL'))
    for (const failure of report.failures) {
      out.push(`  - ${failure}`)
    }
    if (report.repairCommand) {
      out.push(`repair: ${report.repairCommand}`)
    }
  }
  out.push('')
  return out.join('\n')
}
