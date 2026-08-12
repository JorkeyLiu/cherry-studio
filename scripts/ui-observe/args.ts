/**
 * Pure CLI argument parsing for the `pnpm ui:observe` entrypoint
 * (`scripts/ui-observe/cli.ts`). No I/O — deterministically testable in the
 * `scripts` Vitest project.
 *
 * Supported syntax (after the package script forwards args through the
 * native-abi lane wrapper):
 *
 *   pnpm ui:observe --help
 *   pnpm ui:observe --list
 *   pnpm ui:observe <scenario> [--output-dir <dir>] [--timeout-ms <ms>]
 *
 * `<scenario>` is a built-in scenario name (`app-ready`) or a path to a
 * TypeScript scenario file. Standalone `--` separator tokens (forwarded when
 * the caller writes `pnpm ui:observe -- --help` or passes flags after the
 * scenario) are ignored anywhere in the argument list.
 */

export type UiObserveCommand =
  | { kind: 'help' }
  | { kind: 'list' }
  | {
      kind: 'run'
      /** Built-in scenario name or scenario file path. */
      scenario: string
      /** Explicit artifact output directory (optional). */
      outputDir?: string
      /** Scenario body timeout in milliseconds (optional). */
      timeoutMs?: number
    }

export type ParseUiObserveResult = { ok: true; command: UiObserveCommand } | { ok: false; error: string }

/** Parse a positive integer option value. */
function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

/**
 * Validate an `--output-dir` value for BOTH syntax forms (`--output-dir <dir>`
 * and `--output-dir=<dir>`): empty values and flag-like values that start with
 * `-` are rejected, so a missing or swallowed-next-flag value is a usage error
 * either way.
 */
function parseOutputDirValue(value: string): string | null {
  if (value.length === 0 || value.startsWith('-')) return null
  return value
}

export function parseUiObserveArgs(argv: readonly string[]): ParseUiObserveResult {
  // Standalone `--` tokens are no-op separators (the native-abi lane wrapper
  // and pnpm forwarding may place them before or between arguments).
  const args = argv.filter((arg) => arg !== '--')

  const positional: string[] = []
  let outputDir: string | undefined
  let timeoutMs: number | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--help' || arg === '-h') {
      if (args.length !== 1) {
        return { ok: false, error: `'${arg}' cannot be combined with other arguments` }
      }
      return { ok: true, command: { kind: 'help' } }
    }

    if (arg === '--list') {
      if (args.length !== 1) {
        return { ok: false, error: `'${arg}' cannot be combined with other arguments` }
      }
      return { ok: true, command: { kind: 'list' } }
    }

    if (arg === '--output-dir') {
      const value = args[i + 1]
      if (value === undefined || parseOutputDirValue(value) === null) {
        return { ok: false, error: "'--output-dir' requires a directory path" }
      }
      outputDir = value
      i++
      continue
    }

    if (arg.startsWith('--output-dir=')) {
      const value = arg.slice('--output-dir='.length)
      if (parseOutputDirValue(value) === null) {
        return { ok: false, error: "'--output-dir' requires a directory path" }
      }
      outputDir = value
      continue
    }

    if (arg === '--timeout-ms') {
      const value = args[i + 1]
      if (value === undefined || value.length === 0 || value.startsWith('-')) {
        return { ok: false, error: "'--timeout-ms' requires a positive integer" }
      }
      const parsed = parsePositiveInt(value)
      if (parsed === null) {
        return { ok: false, error: `invalid --timeout-ms value '${value}' - expected a positive integer` }
      }
      timeoutMs = parsed
      i++
      continue
    }

    if (arg.startsWith('--timeout-ms=')) {
      const value = arg.slice('--timeout-ms='.length)
      const parsed = parsePositiveInt(value)
      if (parsed === null) {
        return { ok: false, error: `invalid --timeout-ms value '${value}' - expected a positive integer` }
      }
      timeoutMs = parsed
      continue
    }

    if (arg.startsWith('-')) {
      return { ok: false, error: `unknown option '${arg}'` }
    }

    positional.push(arg)
  }

  if (positional.length === 0) {
    return { ok: false, error: 'missing scenario (built-in name or scenario file path)' }
  }
  if (positional.length > 1) {
    return { ok: false, error: `expected exactly one scenario, got ${positional.length}` }
  }

  return {
    ok: true,
    command: {
      kind: 'run',
      scenario: positional[0],
      ...(outputDir !== undefined ? { outputDir } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {})
    }
  }
}
