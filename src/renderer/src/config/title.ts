/**
 * Main-window title resolution (LOCK-RETIRE-001).
 *
 * The main window title resolves from the application identity, so Cherry Chat
 * visibly and internally shows `Cherry Chat`.
 *
 * The static `src/renderer/index.html` `<title>` also carries the identity
 * (`Cherry Chat`); the renderer bootstrap seam (`src/renderer/src/init.ts`,
 * loaded before `entryPoint.tsx`) assigns the identity-derived title once at
 * startup, overriding the static value.
 */
import { appIdentity } from '@shared/config/identity'

/** Resolve the main-window title from the application identity product name. */
export function resolveMainWindowTitle(): string {
  return appIdentity.productName
}

/** Assign the identity-derived main-window title (renderer bootstrap seam). */
export function applyMainWindowTitle(): void {
  document.title = resolveMainWindowTitle()
}
