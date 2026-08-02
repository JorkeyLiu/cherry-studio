import semver from 'semver'

/**
 * Pure version helpers. Everything here is deterministic so the scripts
 * Vitest project can cover it without any filesystem access.
 */

/**
 * Whether `version` is at least `min`. Returns false for unparseable values
 * (fail-closed; a garbage runtime version must never pass).
 */
export function isAtLeast(version: string, min: string): boolean {
  const clean = semver.valid(version) ? version : semver.coerce(version)?.version
  if (!clean) {
    return false
  }
  return semver.gte(clean, min)
}
