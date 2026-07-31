/**
 * Precise disposable-profile process identification/termination and terminal
 * process-exit observation for the L2 Cherry Studio import E2E (LOCK-624/625).
 *
 * LOCK-625: a process is only ever targeted when its argv contains the EXACT
 * unique `--user-data-dir=<disposableProfile>` token — never a substring
 * match, never a different `--user-data-dir` value. The proven argv form is
 * the single token `--user-data-dir=<path>` (how the fixture launches the
 * app and how `app.relaunch()` re-runs the original command line). The
 * original target process (whose PID the test recorded before the import) is
 * always excluded.
 *
 * Failure propagation: every `ps` scan/probe failure, `kill` failure, and
 * post-termination absence probe failure is surfaced as a thrown error or an
 * entry in `TerminationResult.errors`. A failed probe is NEVER treated as a
 * clean result — cleanup must fail loudly, not silently pass.
 *
 * macOS-first: uses `ps -ww -axo pid=,args=` (unlimited-width args) and
 * `kill -s <signal>`. Non-darwin callers should skip before relying on these.
 */
import { spawnSync } from 'child_process'

import { sleep } from './wait-helpers'

const PS_TIMEOUT_MS = 15000

export interface ProcessEntry {
  pid: number
  args: string
}

/** Split an argv string (the `ps` args column) into whitespace-delimited tokens. */
function splitArgvTokens(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean)
}

/**
 * LOCK-625 exact token match: true when the process argv contains the exact
 * `--user-data-dir=<userDataDir>` token. A process whose argv merely contains
 * that string inside a longer token, or with a different `--user-data-dir`
 * value, is NEVER matched. Only the proven `=`-joined single-token form is
 * supported.
 */
export function hasExactUserDataDirToken(args: string, userDataDir: string): boolean {
  const expected = `--user-data-dir=${userDataDir}`
  return splitArgvTokens(args).some((token) => token === expected)
}

/**
 * List all processes with full argv (unlimited width via `-ww`).
 * Throws on `ps` failure — a failed scan is never reported as empty.
 */
export function listProcesses(): ProcessEntry[] {
  const res = spawnSync('ps', ['-ww', '-axo', 'pid=,args='], { encoding: 'utf-8', timeout: PS_TIMEOUT_MS })
  if (res.error) {
    throw new Error(`[E2E] ps scan failed: ${res.error.message}`)
  }
  if (res.status !== 0) {
    const stderr = String(res.stderr ?? '').trim()
    throw new Error(`[E2E] ps scan failed with status ${res.status}: ${stderr.slice(0, 500) || '(no stderr)'}`)
  }
  const out = String(res.stdout ?? '')
  const entries: ProcessEntry[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) entries.push({ pid: Number(m[1]), args: m[2] ?? '' })
  }
  return entries
}

/**
 * Find every process whose argv contains the exact unique disposable
 * `--user-data-dir=<userDataDir>` token (LOCK-625). Throws on `ps` failure.
 */
export function findProcessesByUserDataDir(userDataDir: string): ProcessEntry[] {
  return listProcesses().filter((p) => hasExactUserDataDirToken(p.args, userDataDir))
}

/**
 * True when a process with this PID currently exists. A `ps` probe failure is
 * thrown, never reported as "not exists" — an unknown probe result must not
 * be treated as evidence that the process is gone.
 */
export function processExists(pid: number): boolean {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf-8', timeout: PS_TIMEOUT_MS })
  if (res.error) {
    // Genuine spawn failure (e.g. ps binary missing) — never "not exists".
    throw new Error(`[E2E] ps probe for pid ${pid} failed: ${res.error.message}`)
  }
  if (res.signal) {
    // ps terminated by a signal — an unexpected probe failure, never "not exists".
    throw new Error(`[E2E] ps probe for pid ${pid} was terminated by ${res.signal}`)
  }
  if (res.status !== 0) {
    const stdout = String(res.stdout ?? '').trim()
    const stderr = String(res.stderr ?? '').trim()
    // LOCK-N1: on macOS (Node24 reproduced) `ps -p <gone-pid> -o pid=` exits
    // status 1 with EMPTY stdout AND EMPTY stderr — no "No matching processes"
    // diagnostic. That empty status-1 probe is the definitive not-found signal,
    // not a probe failure. The BSD diagnostic form is treated the same way.
    if (res.status === 1 && stdout === '' && stderr === '') return false
    if (/no\s*(such\s*process|matching)/i.test(stderr)) return false
    // Any other nonzero exit is an unexpected probe failure — must throw.
    throw new Error(
      `[E2E] ps probe for pid ${pid} failed with status ${res.status}: ${stderr.slice(0, 300) || '(no stderr)'}`
    )
  }
  return String(res.stdout ?? '').trim().length > 0
}

/**
 * Send a signal to one PID. Returns ok/error; never throws.
 * A target that exited between scan and signal ("No such process") is
 * treated as success — the process is already gone.
 */
export function killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): { ok: boolean; error?: string } {
  const res = spawnSync('kill', ['-s', signal, String(pid)], { encoding: 'utf-8', timeout: PS_TIMEOUT_MS })
  if (res.error) return { ok: false, error: res.error.message }
  if (res.status !== 0) {
    const stderr = String(res.stderr ?? '').trim()
    // ESRCH-style: already gone — nothing to terminate.
    if (/no such process/i.test(stderr)) return { ok: true }
    return { ok: false, error: stderr || `kill exited ${res.status}` }
  }
  return { ok: true }
}

/**
 * Hard terminal evidence: wait until a recorded PID no longer exists in the
 * process table. Returns true once the process is gone, false on timeout.
 * `ps` probe failures propagate.
 */
export async function waitForProcessExit(pid: number, timeoutMs: number, pollMs = 500): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!processExists(pid)) return true
    await sleep(pollMs)
  }
  return !processExists(pid)
}

export interface TerminationResult {
  /** PIDs terminated (any signal). */
  killedPids: number[]
  /** PIDs still alive after SIGTERM + SIGKILL attempts. */
  remainingPids: number[]
  errors: string[]
}

export interface TerminateOptions {
  /** Grace period for SIGTERM before escalating to SIGKILL (default 10s). */
  termGraceMs?: number
  /**
   * Bounded settle window: after no exact-token process is alive, keep
   * scanning this long to catch late spawns before declaring done
   * (default 3s).
   */
  settleMs?: number
  /** Final verification window (default 5s). */
  verifyMs?: number
}

/**
 * Terminate every process holding the exact disposable profile token, EXCEPT
 * the recorded original target PID (LOCK-625). SIGTERM first, escalate to
 * SIGKILL for stragglers, then verify nothing remains.
 *
 * Late spawns: a bounded settle window is ALWAYS spent re-scanning (LOCK-F1)
 * — including when the initial scan is empty — and any new exact-token match
 * appearing during that window or the final verification window is SIGTERM'd
 * (settle) or SIGKILL'd (verification) and tracked like any other target.
 * Final absence is always verified before the function returns.
 *
 * Failures: `ps`/probe failures throw (the caller must treat cleanup as
 * failed); `kill` failures are accumulated in `result.errors`. The function
 * never reports a clean result when probes failed.
 */
export async function terminateProcessesByUserDataDir(
  userDataDir: string,
  excludePid: number | null,
  options: TerminateOptions = {}
): Promise<TerminationResult> {
  const termGraceMs = options.termGraceMs ?? 10_000
  const settleMs = options.settleMs ?? 3_000
  const verifyMs = options.verifyMs ?? 5_000
  const result: TerminationResult = { killedPids: [], remainingPids: [], errors: [] }
  const seen = new Set<number>()

  // Exact-token scan (LOCK-625). A ps failure propagates — never "clean".
  const scan = (): ProcessEntry[] => findProcessesByUserDataDir(userDataDir).filter((p) => p.pid !== excludePid)

  const signal = async (signalName: 'SIGTERM' | 'SIGKILL', targets: ProcessEntry[]): Promise<void> => {
    for (const target of targets) {
      const res = killProcess(target.pid, signalName)
      if (res.ok) {
        if (signalName === 'SIGKILL') result.killedPids.push(target.pid)
      } else {
        result.errors.push(`${signalName} ${target.pid}: ${res.error ?? 'unknown'}`)
      }
    }
  }

  let current = scan()
  if (current.length === 0) {
    console.log('[E2E] No exact-token process found; entering bounded settle window for late spawns (LOCK-F1)')
  } else {
    console.log(
      `[E2E] Terminating ${current.length} process(es) by exact token: ${current.map((p) => p.pid).join(', ')}`
    )
  }

  await signal('SIGTERM', current)
  current.forEach((p) => seen.add(p.pid))

  // Grace window + bounded settle: SIGTERM'd targets get up to termGraceMs to
  // shut down; every new exact-token match (late spawn) is SIGTERM'd and
  // re-tracked. We stop only after a full settle window passes with no
  // exact-token process alive.
  //
  // LOCK-F1: this window ALWAYS runs — even when the initial scan was empty.
  // A late exact-token process spawning after an empty first scan is still
  // SIGTERM'd and tracked; the function never returns "clean" from a single
  // empty scan.
  const deadline = Date.now() + termGraceMs + settleMs
  let lastAliveAt = Date.now()
  for (;;) {
    await sleep(300)
    current = scan() // ps failure propagates

    const late = current.filter((p) => !seen.has(p.pid))
    if (late.length > 0) {
      await signal('SIGTERM', late)
      late.forEach((p) => seen.add(p.pid))
      lastAliveAt = Date.now()
    }

    let aliveCount = 0
    for (const entry of current) {
      if (processExists(entry.pid)) aliveCount += 1 // probe failure propagates
    }
    if (aliveCount > 0) {
      lastAliveAt = Date.now()
      if (Date.now() >= deadline) break
    } else if (Date.now() - lastAliveAt >= settleMs) {
      break
    } else if (Date.now() >= deadline) {
      break
    }
  }

  // Escalate remaining exact-token matches to SIGKILL.
  current = scan()
  const stragglers: ProcessEntry[] = []
  for (const entry of current) {
    if (processExists(entry.pid)) stragglers.push(entry)
  }
  if (stragglers.length > 0) {
    await signal('SIGKILL', stragglers)
  }

  // Final bounded verification window: any exact-token match still alive after
  // escalation — including a process that spawned only after the settle window
  // broke — is SIGKILL'd (LOCK-F1: late exact-token processes are terminated,
  // not merely observed) and its final absence is verified. Nothing matching
  // the exact token may remain when the window closes.
  const verifyStart = Date.now()
  let final: ProcessEntry[] = []
  for (;;) {
    current = scan()
    const lateVerify = current.filter((p) => !seen.has(p.pid))
    if (lateVerify.length > 0) {
      await signal('SIGKILL', lateVerify)
      lateVerify.forEach((p) => seen.add(p.pid))
    }
    final = current.filter((p) => processExists(p.pid))
    if (final.length === 0) break
    if (Date.now() - verifyStart >= verifyMs) break
    await sleep(300)
  }

  result.remainingPids = final.map((p) => p.pid)
  result.killedPids = [...new Set([...seen, ...result.killedPids].filter((pid) => !result.remainingPids.includes(pid)))]
  return result
}
