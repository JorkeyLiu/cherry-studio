import { createContext, type PropsWithChildren, use } from 'react'

/**
 * Export-only thinking-expansion override.
 *
 * The default (`null`) is the live chat behavior: the user's automatic-collapse
 * setting and the streaming state decide whether a thinking block is expanded,
 * exactly as before. Inside an image export the value is frozen when the export
 * starts — `true` = expanded, `false` = collapsed — and wins over both the
 * streaming state and the user's automatic-collapse setting, so the exported
 * image follows the export option instead of the live toggle.
 *
 * The override is caller-local presentational state of the detached export
 * tree: it is never written back to settings, never dispatched into the store,
 * and the live chat keeps reading its own setting.
 */
const ExportThinkingExpansionContext = createContext<boolean | null>(null)

export const useExportThinkingExpansion = (): boolean | null => use(ExportThinkingExpansionContext)

export const ExportThinkingExpansionProvider = ({ value, children }: PropsWithChildren<{ value: boolean | null }>) => (
  <ExportThinkingExpansionContext value={value}>{children}</ExportThinkingExpansionContext>
)
