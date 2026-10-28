import store from '@renderer/store'

/**
 * Single write path for every user-visible file export (Markdown, topic JSON,
 * notes, message/topic images).
 *
 * Two behaviors, chosen only by the configured default directory:
 *
 * - `settings.exportPath` is set → write straight into that directory, the
 *   same direct-write behavior Markdown export already had.
 * - `settings.exportPath` is `null` → the native save dialog decides the
 *   location, per export (unchanged behavior).
 *
 * There is no implicit working directory fallback: a write failure propagates
 * to the caller, which keeps its own existing success/error toasts.
 */

/**
 * Joins a directory and a file name without Node's `path` (the renderer has no
 * Node capability). Separators are normalized to `/`, which the Main-process
 * file IPC accepts on every platform.
 */
export const joinExportPath = (directory: string, fileName: string): string =>
  `${directory.replace(/[\\/]+$/, '')}/${fileName.replace(/^[\\/]+/, '')}`

/**
 * Saves a text export. Returns `true` when a file was written and `false` when
 * the user canceled the native save dialog (callers stay silent on cancel).
 * A real write failure is rethrown for the caller's own error handling.
 */
export const saveExportFile = async (fileName: string, content: string): Promise<boolean> => {
  const exportPath = store.getState().settings.exportPath

  if (!exportPath) {
    const result = await window.api.file.save(fileName, content)
    return Boolean(result)
  }

  await window.api.file.write(joinExportPath(exportPath, fileName), content)
  return true
}

/**
 * Saves an image export. The configured default directory is handed to the Main
 * process as its third argument only when one is set; without it the native save
 * dialog decides. The Main-process result is returned unmodified — a
 * cancellation is never reported as success.
 */
export const saveExportImage = async (name: string, imageData: string): Promise<boolean> => {
  const exportPath = store.getState().settings.exportPath

  return window.api.file.saveImage(name, imageData, exportPath ?? undefined)
}
