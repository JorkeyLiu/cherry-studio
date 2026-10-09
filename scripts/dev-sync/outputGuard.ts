/**
 * Bounded broken-pipe (EPIPE) guard for the dev-sync supervisor's own
 * stdout forwarding (`logLine` / `logPrefixed` in `supervisor.ts`).
 *
 * The supervisor forwards every owned child (relay, electron-vite dev,
 * profile-B app) to its own stdout. When the terminal pipe closes under it
 * (Ctrl-C / downstream close during shutdown), `process.stdout.write` throws
 * a synchronous `write EPIPE` (and the stream emits an async `error`). That
 * must not become an uncaught exception on top of the normal shutdown path.
 *
 * Bound: ONLY `code === 'EPIPE'` is swallowed, stdout only, after which the
 * sink is skipped for the rest of the process. Every other error propagates,
 * preserving Node behavior. Shutdown sequencing, signals, and cleanup are
 * untouched. This module never logs.
 */

let stdoutBroken = false
let guardInstalled = false

/** True only for the expected broken-pipe shape (`code === 'EPIPE'`). */
export function isSupervisorBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return (error as { code?: unknown }).code === 'EPIPE'
}

/** Whether the supervisor stdout sink already broke and is now skipped. */
export function isSupervisorStdoutBroken(): boolean {
  return stdoutBroken
}

/** Install the persistent async stdout `error` guard exactly once. Idempotent. */
export function ensureSupervisorStdoutGuard(stdout: NodeJS.WriteStream = process.stdout): void {
  if (guardInstalled) return
  guardInstalled = true
  // Persistent listener: queued writes can emit further EPIPE events after
  // the first break, so the guard stays attached; unrelated later errors
  // still reach this listener and are rethrown.
  try {
    stdout.on('error', (error: unknown) => {
      if (isSupervisorBrokenPipeError(error)) {
        stdoutBroken = true
        return
      }
      throw error
    })
  } catch {
    // Streams without `.on` stay on the synchronous path below.
  }
}

/**
 * Best-effort stdout write: swallows only the expected EPIPE (stopping the
 * sink) and rethrows unrelated errors, consistent with bare
 * `process.stdout.write` behavior.
 */
export function writeSupervisorStdout(text: string): void {
  if (stdoutBroken) return
  try {
    process.stdout.write(text)
  } catch (error) {
    if (isSupervisorBrokenPipeError(error)) {
      stdoutBroken = true
      return
    }
    throw error
  }
}

/** Test-only reset of the broken flag and the install guard. */
export function resetSupervisorOutputGuardForTests(): void {
  stdoutBroken = false
  guardInstalled = false
}
