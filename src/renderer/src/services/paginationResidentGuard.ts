/**
 * Pagination resident generation guard — narrow helper for B-06 stale discard.
 *
 * Older/newer pagination captures resident applicabilityGeneration at request
 * start and discards the response if the generation advanced before publication.
 * This helper centralizes that check so it can be exercised by focused tests
 * without broad component refactor.
 */

export function captureResidentGeneration(getState: () => unknown, topicId: string): number {
  try {
    const gen = (getState() as any)?.residentRegistry?.entries?.[topicId]?.applicabilityGeneration as number | undefined
    return gen ?? 0
  } catch {
    return 0
  }
}

export function shouldDiscardPaginationForResident(capturedGeneration: number, currentGeneration: number): boolean {
  return (currentGeneration ?? 0) !== (capturedGeneration ?? 0)
}
