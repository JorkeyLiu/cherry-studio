export type SequencedEntry = {
  sequence: number
}

export function createMonotonicRequestLog<T extends object>() {
  let entries: Array<T & SequencedEntry> = []
  let sequence = 0

  return {
    append(entry: T): void {
      entries.push({ ...entry, sequence: sequence++ })
    },

    clear(): void {
      entries = []
    },

    getEntries(): Array<T & SequencedEntry> {
      return [...entries]
    },

    getSequence(): number {
      return sequence
    }
  }
}
