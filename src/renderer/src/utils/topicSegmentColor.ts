/**
 * djb2 hash – deterministic, uniformly distributed, no crypto dependency.
 */
function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return hash >>> 0 // ensure non-negative
}

/**
 * Derive a stable, order-independent colour for a topic segment.
 *
 * Hue, saturation, and lightness are each derived from different bit ranges
 * of the same djb2 hash, giving ~196 k unique combinations while keeping
 * colours distinguishable against both light and dark backgrounds.
 *
 *  - H: 0–359   (full hue wheel)
 *  - S: 35–60%  (lower bound kept; upper bound extended for vividness)
 *  - L: 42–62%  (safe distance from both dark bg L≈9% and light bg L≈100%)
 *
 * @param id  The segment's unique identifier.
 * @returns   A CSS colour string in `hsl()` notation.
 */
export function getSegmentColor(id: string): string {
  const hash = djb2Hash(id)
  const hue = hash % 360
  const sat = 35 + ((hash >>> 8) % 26) // 35% ~ 60%
  const lit = 42 + ((hash >>> 16) % 21) // 42% ~ 62%
  return `hsl(${hue}, ${sat}%, ${lit}%)`
}
