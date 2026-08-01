import * as fs from 'node:fs'
import * as path from 'node:path'

export const CANDIDATE_TEMP_PREFIX = 'cherry-import-'
export const CANDIDATE_DIR_PREFIX = 'candidate-'

export interface CandidateInventory {
  tmpCandidates: string[]
  chatImportCandidatesChildren: string[]
  chatImportCandidatesSidecars: string[]
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function listCandidateTempWorkspaces(ownedTmpRoot: string): string[] {
  try {
    return fs
      .readdirSync(ownedTmpRoot)
      .filter((entry) => entry.startsWith(CANDIDATE_TEMP_PREFIX))
      .map((entry) => path.join(ownedTmpRoot, entry))
      .filter((candidatePath) => {
        try {
          const stat = fs.lstatSync(candidatePath)
          return stat.isDirectory() && !stat.isSymbolicLink()
        } catch (error) {
          if (isEnoent(error)) return false
          throw error
        }
      })
  } catch (error) {
    if (isEnoent(error)) return []
    throw error
  }
}

export function snapshotCandidateInventory(dataDir: string, ownedTmpRoot: string): CandidateInventory {
  const candidatesDir = path.join(dataDir, 'chat-import-candidates')
  const children: string[] = []
  const sidecars: string[] = []
  try {
    for (const entry of fs.readdirSync(candidatesDir)) {
      children.push(entry)
      if (entry.endsWith('.wal') || entry.endsWith('.shm')) sidecars.push(entry)
    }
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  return {
    tmpCandidates: listCandidateTempWorkspaces(ownedTmpRoot),
    chatImportCandidatesChildren: children,
    chatImportCandidatesSidecars: sidecars
  }
}

/** Returns null for an absent shell; otherwise returns a concrete violation. */
export function validatePromotedCandidateShell(entryPath: string): string | null {
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(entryPath)
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
  if (rootStat.isSymbolicLink()) return 'symlink (not a real directory)'
  if (!rootStat.isDirectory()) return 'not a directory'

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(entryPath, { withFileTypes: true })
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
  for (const entry of entries) {
    const childPath = path.join(entryPath, entry.name)
    let childStat: fs.Stats
    try {
      childStat = fs.lstatSync(childPath)
    } catch (error) {
      if (isEnoent(error)) continue
      throw error
    }
    if (childStat.isSymbolicLink()) return `contains symlink "${entry.name}"`
    if (childStat.isFile()) return `contains file "${entry.name}"`
    if (childStat.isDirectory()) return `contains nested directory "${entry.name}"`
    return `contains non-standard entry "${entry.name}" (mode=${childStat.mode.toString(8)})`
  }
  return null
}

export function assertTmpdirDeferredRecovery(before: CandidateInventory, ownedTmpRoot: string): string[] {
  const after = listCandidateTempWorkspaces(ownedTmpRoot)
  const newCandidates = after.filter((candidate) => !before.tmpCandidates.includes(candidate))
  for (const candidate of newCandidates) {
    const stat = fs.lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Candidate is not a real directory: ${candidate}`)
    for (const entry of fs.readdirSync(candidate)) {
      if (entry.endsWith('.wal') || entry.endsWith('.shm')) {
        throw new Error(`Candidate workspace "${candidate}" has sidecar: ${entry}`)
      }
    }
  }
  return newCandidates
}

export function assertOnlyEmptyPromotedCandidateShells(
  before: CandidateInventory,
  dataDir: string,
  ownedTmpRoot: string
): string[] {
  const newTmpCandidates = assertTmpdirDeferredRecovery(before, ownedTmpRoot)
  const candidatesDir = path.join(dataDir, 'chat-import-candidates')
  let entries: string[]
  try {
    entries = fs.readdirSync(candidatesDir)
  } catch (error) {
    if (isEnoent(error)) return newTmpCandidates
    throw error
  }
  for (const entry of entries) {
    if (entry.endsWith('.wal') || entry.endsWith('.shm')) throw new Error(`Candidate sidecar remains: ${entry}`)
  }
  for (const entry of entries.filter((name) => !before.chatImportCandidatesChildren.includes(name))) {
    if (!entry.startsWith(CANDIDATE_DIR_PREFIX)) throw new Error(`Unowned candidate entry: ${entry}`)
    const violation = validatePromotedCandidateShell(path.join(candidatesDir, entry))
    if (violation !== null) throw new Error(`Promoted candidate shell "${entry}" has violation: ${violation}`)
  }
  return newTmpCandidates
}
