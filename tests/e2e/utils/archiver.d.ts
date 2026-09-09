/**
 * E2E-scope ambient types for the untyped `archiver` dependency.
 *
 * The package ships no TypeScript declarations and `@types/archiver` is not
 * a repo dependency (production `BackupManager.ts` compiles under
 * `noImplicitAny: false`, so it never needs one). The E2E gate enforces
 * `noImplicitAny`, so this minimal declaration covers exactly the surface
 * used by `derived-large-container-zip.ts`. Scoped to the E2E program only
 * via `tsconfig.e2e.json`; production programs are unaffected.
 */
declare module 'archiver' {
  import type { Writable } from 'node:stream'

  export interface ArchiverOptions {
    zlib?: { level?: number }
    zip64?: boolean
  }

  export interface ArchiverEntryData {
    name: string
  }

  export interface Archiver {
    pipe(destination: Writable): Writable
    abort(): void
    on(event: 'error', listener: (err: Error) => void): this
    // node-stream-zip `stream()` yields `NodeJS.ReadableStream` (implemented
    // by node `Readable`, e.g. the compressible byte stream below).
    append(source: string | Buffer | NodeJS.ReadableStream | null, data: ArchiverEntryData): void
    finalize(): Promise<void>
  }

  export default function archiver(format: string, options?: ArchiverOptions): Archiver
}
