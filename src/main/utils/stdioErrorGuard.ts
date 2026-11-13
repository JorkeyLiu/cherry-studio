/**
 * Dev-only stdout/stderr broken-pipe guard.
 *
 * A dev main process keeps a pipe to its Electron runner (electron-vite). When
 * that runner dies (for example another worktree's runner exiting) the pipe
 * closes under a still-running main process, and the next console write (the
 * dev logger's console transport, for instance) reports `EPIPE` on
 * `process.stdout`/`process.stderr`. A stream `error` without a listener is
 * re-thrown as an uncaught exception by Node, which is the crash this guard
 * prevents.
 *
 * Scope is deliberately narrow:
 * - only `error.code === 'EPIPE'` is treated as "the pipe is gone": it marks
 *   the guard and returns;
 * - every other stream error is re-thrown unchanged, so real failures keep
 *   their normal propagation and the existing production crash handling;
 * - production never installs this guard (see `main/index.ts`).
 *
 * This only concerns the main process's own stdio. Renderer `console` output is
 * a separate process writing through DevTools/CDP; it is not routed through
 * these streams and is not affected either way.
 */

export interface ErrorEventSource {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

export interface StdioBrokenPipeGuard {
  /** True once an EPIPE has been observed (the stdio pipe is gone). */
  readonly isBroken: () => boolean
}

const isBrokenPipeError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EPIPE'

/**
 * Install the one-time stream `error` listener used by the dev main entry.
 * Idempotent per call: callers install it once at startup; repeated calls on
 * the same stream would add another listener, so the entry point calls it once.
 */
export function installStdioBrokenPipeGuard(streams: readonly ErrorEventSource[]): StdioBrokenPipeGuard {
  let broken = false
  const onError = (error: NodeJS.ErrnoException): void => {
    if (isBrokenPipeError(error)) {
      broken = true
      return
    }
    // Real stream failures keep propagating as uncaught exceptions.
    throw error
  }
  for (const stream of streams) {
    stream.on('error', onError)
  }
  return { isBroken: () => broken }
}
