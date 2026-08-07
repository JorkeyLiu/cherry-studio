/**
 * Main-window title resolution (IDENTITY-002).
 *
 * The main window title resolves from the build-time identity so the default
 * build keeps the historical `Cherry Studio` title (IDENTITY-001) while the
 * Cherry Chat build visibly and internally shows `Cherry Chat` (IDENTITY-002).
 *
 * The static `src/renderer/index.html` `<title>` is shared by every flavor and
 * stays `Cherry Studio` (default HTML/build behavior unchanged); the renderer
 * bootstrap seam (`src/renderer/src/init.ts`, loaded before `entryPoint.tsx`)
 * assigns the identity-derived title once at startup, overriding the static
 * value.
 */
import { appIdentity } from '@shared/config/identity'

/** Resolve the main-window title from the build-time identity product name. */
export function resolveMainWindowTitle(): string {
  return appIdentity.productName
}

/** Assign the identity-derived main-window title (renderer bootstrap seam). */
export function applyMainWindowTitle(): void {
  document.title = resolveMainWindowTitle()
}
