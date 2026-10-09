/**
 * Bounded broken-pipe (EPIPE) guard for synchronous dev-console sinks.
 *
 * Context: `pnpm dev sync` Ctrl-C can close the dev stdout/stderr pipe while
 * the Electron main process is still logging. Node surfaces that as a
 * synchronous `write EPIPE` throw from `console.*` (and as an async `error`
 * event on the std streams). Without a guard it becomes an uncaught exception
 * (error dialog / crash) even though the durable Winston file transports are
 * unaffected.
 *
 * Bound: ONLY errors with `code === 'EPIPE'` are swallowed, and only on the
 * process std output sinks. The broken sink is then skipped for the rest of
 * the process (stdout and stderr tracked independently) while file logging
 * continues. Every other error is rethrown, preserving Node behavior.
 * No logger recursion: this module never logs.
 */

export type StdPipeName = 'stdout' | 'stderr'

const brokenPipes = new Set<StdPipeName>()
let guardsInstalled = false

/** True only for the expected broken-pipe shape (`code === 'EPIPE'`). */
export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return (error as { code?: unknown }).code === 'EPIPE'
}

/** Whether the named sink already broke and is now skipped. */
export function isStdPipeBroken(stream: StdPipeName): boolean {
  return brokenPipes.has(stream)
}

function markStdPipeBroken(stream: StdPipeName): void {
  brokenPipes.add(stream)
}

interface ErrorEmitter {
  on(event: 'error', listener: (error: unknown) => void): unknown
}

function attachEpipeGuard(stream: ErrorEmitter, name: StdPipeName): void {
  // Persistent listener: queued writes can emit further EPIPE events after
  // the first break, so the guard must stay attached for the process
  // lifetime. Unrelated later errors still reach this listener and are
  // rethrown to preserve Node behavior.
  try {
    stream.on('error', (error: unknown) => {
      if (isBrokenPipeError(error)) {
        // Async broken pipe: stop writing this sink, keep everything else.
        markStdPipeBroken(name)
        return
      }
      // Unrelated stream error: preserve Node behavior (surfaces as uncaught,
      // exactly as if no listener were installed).
      throw error
    })
  } catch {
    // Streams without `.on` stay on the synchronous path below.
  }
}

/**
 * Install the persistent async `error` guards on stdout+stderr exactly once
 * per process. Idempotent: repeated calls (multiple LoggerService instances,
 * HMR) never add duplicate listeners. Custom emitters may be injected for
 * tests.
 */
export function ensureStdPipeGuards(
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr
): void {
  if (guardsInstalled) return
  guardsInstalled = true
  attachEpipeGuard(stdout as unknown as ErrorEmitter, 'stdout')
  attachEpipeGuard(stderr as unknown as ErrorEmitter, 'stderr')
}

/**
 * Run a synchronous sink write, swallowing only the expected broken-pipe
 * EPIPE (and stopping that sink). Unrelated errors propagate to the caller,
 * consistent with bare `console.*` behavior. File logging must stay OUTSIDE
 * this guard so it always runs.
 */
export function guardStdPipeWrite(stream: StdPipeName, write: () => void): void {
  if (brokenPipes.has(stream)) return
  try {
    write()
  } catch (error) {
    if (isBrokenPipeError(error)) {
      markStdPipeBroken(stream)
      return
    }
    throw error
  }
}

/** Test-only reset of the broken-sink flags and the install guard. */
export function resetStdPipeGuardForTests(): void {
  brokenPipes.clear()
  guardsInstalled = false
}
