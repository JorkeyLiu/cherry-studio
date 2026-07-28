/**
 * Shared search text normalization — deterministic functions for FTS5
 * normalized projection and exact regex matching.
 *
 * Extracted from SearchResults.tsx to be usable by both Main and renderer.
 * LOCK-5122: preserves current markdown stripping + CRLF normalization
 * ordering used by SearchResults matching.
 *
 * Design:
 * - Pure functions, no side effects.
 * - No imports from @renderer or Electron/Node-specific modules.
 * - The order is: stripMarkdownFormatting first, then normalizeText
 *   (CRLF → LF). This matches the existing SearchResults.tsx behavior.
 */

/**
 * Strip markdown formatting characters from text.
 * Preserves the original regex patterns from SearchResults.tsx.
 *
 * Order of operations matches original:
 * 1. Code blocks (```...```)
 * 2. Image links ![alt](url)
 * 3. Links [text](url)
 * 4. Bold **text**
 * 5. Italic *text*
 * 6. Inline code `text`
 * 7. Headers # text
 * 8. HTML tags <...>
 */
export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/```(?:[^\n]*\n)?([\s\S]*?)```/g, '$1')
    .replace(/!\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/<[^>]*>/g, '')
}

/**
 * Normalize line endings: CRLF and CR → LF.
 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Full normalization pipeline: strip markdown formatting, then normalize
 * line endings, then lowercase. This produces the text used for FTS5
 * normalized projection and exact regex matching.
 *
 * LOCK-5122: ordering must be stripMarkdownFormatting first, then normalizeText.
 * Lowercasing is added for FTS5 trigram case-insensitive search support.
 */
export function normalizeSearchText(content: string): string {
  return normalizeText(stripMarkdownFormatting(content)).toLowerCase()
}
