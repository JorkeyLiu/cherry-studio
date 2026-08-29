export class RouteChunkLoadError extends Error {
  readonly isRouteChunkLoadError = true
  override name = 'RouteChunkLoadError'

  constructor(message?: string, options?: { cause?: unknown }) {
    super(message, options as unknown as ErrorOptions)
    this.name = 'RouteChunkLoadError'
  }
}

export function isRouteChunkLoadError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<string, unknown>).isRouteChunkLoadError === true &&
    (error as Record<string, unknown>).name === 'RouteChunkLoadError'
  )
}
