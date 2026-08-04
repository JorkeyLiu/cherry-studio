/**
 * Path/stack redaction for the E2E privacy surface (LOCK-REAL2/LOCK-PRIV-2).
 *
 * LOCK-PRIV-2: when an error can carry a secret source path (e.g. the opt-in
 * real-backup ZIP path), BOTH the error message AND the error stack must be
 * redacted before the error can surface in a log/report/failure. The
 * unredacted stack is never preserved.
 *
 * These helpers are E2E-only (tests/e2e); they are never imported by
 * production code.
 */

/** Redact every occurrence of a secret path from an error message or string. */
export function redactPathText(error: unknown, secretPath: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split(secretPath).join('<redacted>')
}

/**
 * Wrap an error so neither its message NOR its stack can surface the secret
 * source path (LOCK-PRIV-2). The unredacted stack is deliberately NOT
 * preserved — the wrapped error carries only a redacted copy of the stack.
 * Non-Error values are stringified and redacted.
 */
export function redactSourcePath(error: unknown, secretPath: string): Error {
  if (error instanceof Error) {
    const redactedMessage = redactPathText(error.message, secretPath)
    const redactedStack = error.stack ? redactPathText(error.stack, secretPath) : undefined
    const wrapped = new Error(redactedMessage)
    if (redactedStack !== undefined) wrapped.stack = redactedStack
    return wrapped
  }
  return new Error(redactPathText(error, secretPath))
}
