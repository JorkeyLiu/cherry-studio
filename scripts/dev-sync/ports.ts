/**
 * Fail-fast TCP port checks for `pnpm dev:sync`.
 *
 * Fixed fixture ports (relay, CDP A/B) must be unoccupied: the supervisor
 * refuses to kill or steal another owner's listener and instead reports the
 * conflict with the explicit-override flag. The probe binds the port itself —
 * a successful bind proves free, then releases immediately. A small race
 * between probe and bind remains; the child startup failure is still
 * fail-closed (reported, never worked around by killing).
 */
import { createServer } from 'node:net'

export function isTcpPortFree(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    const done = (free: boolean): void => {
      try {
        server.close()
      } catch {
        // Already closed.
      }
      resolve(free)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    server.once('error', () => {
      clearTimeout(timer)
      done(false)
    })
    server.once('listening', () => {
      clearTimeout(timer)
      done(true)
    })
    server.listen(port, host)
  })
}

export async function assertTcpPortFree(host: string, port: number, owner: string): Promise<void> {
  const free = await isTcpPortFree(host, port)
  if (!free) {
    throw new Error(
      `[dev-sync] ${owner} port ${port} on ${host} is busy; refusing to steal it. ` +
        `Stop the occupying process or pass an explicit alternative flag (see: pnpm dev:sync -- --help).`
    )
  }
}
