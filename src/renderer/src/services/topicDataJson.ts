import { loggerService } from '@logger'
import i18n from '@renderer/i18n'
import { dbService } from '@renderer/services/db'
import { topicWireToTopic } from '@renderer/services/db/topicTrashLifecycle'
import type { Topic } from '@renderer/types'
import { saveExportFile } from '@renderer/utils/exportFile'
import { removeSpecialCharactersForFileName } from '@renderer/utils/file'
import type { TopicDataExportPayload } from '@shared/chatDb'

const logger = loggerService.withContext('TopicDataJson')

const TOPIC_DATA_FORMAT = 'cherry-chat-topic-data'

interface OpenedJsonFile {
  content?: unknown
}

/**
 * Export ONE ENTIRE topic (main + ALL branches) to a standalone JSON file.
 *
 * - Snapshot comes from the Main authority (`chatdb:export-topic-data`),
 *   never the loaded Redux projection.
 * - Native save dialog; cancellation is silent (no toast).
 * - Failures use localized toasts; the logger never carries file content.
 */
function isNativeSaveCancellation(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '')
  return /cancel/i.test(message)
}

/**
 * Informative follow-up after a successful save, driven ONLY by the exported
 * payload's `historySnapshot` posture (never loaded topic metadata/Redux):
 * - `materialized` — the referenced history is embedded, so the file is
 *   standalone; state that import yields an independent copy.
 * - `missing` — the referenced source was unavailable at export time; warn
 *   explicitly that only the surviving content was written and the history is
 *   absent (never present an incomplete file as complete).
 * An ordinary topic carries no `historySnapshot` and stays silent beyond the
 * standard success toast.
 */
function notifyHistorySnapshot(historySnapshot: TopicDataExportPayload['historySnapshot']): void {
  if (!historySnapshot) return
  if (historySnapshot.status === 'materialized') {
    window.toast.info(i18n.t('chat.topics.export.json.referenceExplanation'))
  } else if (historySnapshot.status === 'missing') {
    window.toast.warning(i18n.t('chat.topics.export.json.referenceMissing'))
  }
}

export const exportTopicDataToFile = async (topic: Pick<Topic, 'id' | 'name'>): Promise<boolean> => {
  try {
    const payload = await dbService.exportTopicData(topic.id)
    const json = JSON.stringify(payload, null, 2)
    const fileName = `${removeSpecialCharactersForFileName(topic.name || 'topic')}.json`
    // Shared export write path: the configured default directory writes
    // directly, otherwise the native `file:save` dialog decides (it resolves
    // the saved path, and REJECTS with `User canceled the save dialog` on
    // cancellation — never `false`). A falsy result stays silent for
    // robustness; the exported payload itself is untouched.
    const saved = await saveExportFile(fileName, json)
    if (saved) {
      window.toast.success(i18n.t('chat.topics.export.json.success'))
      notifyHistorySnapshot(payload.historySnapshot)
      return true
    }
    // Native dialog cancellation stays silent.
    return false
  } catch (error) {
    if (isNativeSaveCancellation(error)) {
      return false
    }
    logger.error('Failed to export topic data', error as Error)
    window.toast.error(i18n.t('chat.topics.export.json.error'))
    return false
  }
}

/**
 * Import a standalone topic JSON file as a NEW topic under the target
 * assistant (always duplicates; never dedups/merges/overwrites).
 *
 * - Native open dialog; cancellation is silent (returns null, no toast).
 * - Malformed files and Main validation failures use localized toasts;
 *   the logger never carries file content.
 * - Returns the projected Topic on success (Main created the row first, so
 *   the caller only projects the returned wire), null otherwise.
 */
export const importTopicDataFromFile = async (assistantId: string): Promise<Topic | null> => {
  let file: OpenedJsonFile | null | undefined
  try {
    file = (await window.api.file.open({
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })) as OpenedJsonFile | null | undefined
  } catch (error) {
    logger.error('Failed to open topic data file', error as Error)
    window.toast.error(i18n.t('chat.topics.import.error'))
    return null
  }
  if (!file || file.content === undefined || file.content === null) {
    // Native dialog cancellation stays silent.
    return null
  }

  let parsed: unknown
  try {
    const text = typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content as Uint8Array)
    parsed = JSON.parse(text)
  } catch {
    logger.error('Failed to parse topic data file')
    window.toast.error(i18n.t('chat.topics.import.invalid'))
    return null
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).format !== TOPIC_DATA_FORMAT
  ) {
    logger.error('Rejected topic data file with unexpected format marker')
    window.toast.error(i18n.t('chat.topics.import.invalid'))
    return null
  }

  try {
    const response = await dbService.importTopicData(parsed as TopicDataExportPayload, assistantId)
    window.toast.success(i18n.t('chat.topics.import.success'))
    return topicWireToTopic(response.topic)
  } catch (error) {
    logger.error('Failed to import topic data', error as Error)
    window.toast.error(i18n.t('chat.topics.import.error'))
    return null
  }
}
