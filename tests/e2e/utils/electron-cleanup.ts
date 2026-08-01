import type { ProcessEntry, TerminationResult } from './process-cleanup'
import { cleanupExactProfile } from './run-ownership'

export interface ElectronCleanupDependencies {
  close: () => Promise<void>
  findExactProcesses?: (userDataDir: string) => ProcessEntry[]
  terminateExactProcesses?: (userDataDir: string) => Promise<TerminationResult>
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Close an Electron app, then always exact-token terminate its disposable
 * profile processes and verify final absence. Throws an AggregateError when
 * close or any exact-cleanup step fails — cleanup never silently passes.
 */
export async function closeElectronWithExactCleanup(
  userDataDir: string,
  dependencies: ElectronCleanupDependencies
): Promise<void> {
  const errors: Error[] = []

  try {
    await dependencies.close()
  } catch (error) {
    errors.push(asError(error))
  }

  try {
    await cleanupExactProfile(userDataDir, {
      terminate: dependencies.terminateExactProcesses,
      find: dependencies.findExactProcesses
    })
  } catch (error) {
    if (error instanceof AggregateError) {
      errors.push(...error.errors.map((entry) => asError(entry)))
    } else {
      errors.push(asError(error))
    }
  }

  if (errors.length > 0) throw new AggregateError(errors, `Electron cleanup failed for ${userDataDir}`)
}
