/**
 * Pure build-config helper for the immutable build-time application flavor.
 *
 * `electron.vite.config.ts` resolves the flavor once from
 * `process.env.VITE_APP_FLAVOR` and injects it as a statically replaceable
 * `__APP_FLAVOR__` constant (Vite `define`) into every build target — main,
 * preload, and renderer. `./identity` reads that constant with a `typeof`
 * guard, so plain Node/tsx consumers and node-only tests — which never run
 * through a Vite build — safely resolve the default Cherry Studio identity
 * (IDENTITY-001).
 *
 * This module is deliberately pure (no Vite/Electron imports) so it loads
 * from plain Node inside `electron.vite.config.ts` and is trivially
 * unit-testable.
 */
import { APP_FLAVOR_ENV_VAR, type AppFlavor, resolveAppIdentity } from './identity'

/**
 * Identifier injected via Vite `define`. Must match the identifier read in
 * `./identity` — the replacement is textual, so any drift silently defeats
 * the bake. Tested by `flavorDefine` and the compiled-output assertions.
 */
export const APP_FLAVOR_DEFINE_KEY = '__APP_FLAVOR__'

/**
 * Normalize/validate a raw flavor token from the build environment.
 * Missing, empty, whitespace, or unknown tokens resolve to the safe default
 * `cherry-studio` (IDENTITY-001); only the explicit `cherry-chat` token
 * selects the Chat flavor (matching `resolveAppIdentity` case/space rules).
 */
export function resolveBuildFlavor(rawValue: string | null | undefined): AppFlavor {
  return resolveAppIdentity(rawValue ?? undefined).flavor
}

/**
 * Read the flavor from a process-env-like record. The electron-vite config
 * passes `process.env`; tests pass a fixed record for determinism.
 */
export function readBuildFlavorFromEnv(env: Record<string, string | undefined> = process.env): AppFlavor {
  return resolveBuildFlavor(env[APP_FLAVOR_ENV_VAR])
}

/**
 * The `define` entries to merge into every electron-vite target. The value is
 * the JSON string of the flavor (e.g. `"cherry-chat"`), so Vite/esbuild
 * replace every `__APP_FLAVOR__` identifier with a literal string. Without an
 * explicit flavor argument the current process environment is consulted.
 */
export function flavorDefine(flavor: AppFlavor = readBuildFlavorFromEnv()): Record<string, string> {
  return { [APP_FLAVOR_DEFINE_KEY]: JSON.stringify(flavor) }
}
