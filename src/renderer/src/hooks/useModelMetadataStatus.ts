import { getModelMetadataStatusSnapshot, subscribeModelMetadataStatus } from '@renderer/services/modelMetadata'
import type { ModelMetadataStatus } from '@shared/modelMetadata'
import { useSyncExternalStore } from 'react'

/**
 * Reactive models.dev registry status for `useSyncExternalStore`.
 *
 * The subscribed snapshot reference is stable across renders: it only
 * changes on loading/ready/unavailable transitions notified by
 * init/refresh, so an open Edit Model popup re-renders exactly when the
 * async round completes — including the three all-empty states
 * (fetching / unable / no metadata).
 */
export function useModelMetadataStatus(): ModelMetadataStatus {
  return useSyncExternalStore(subscribeModelMetadataStatus, getModelMetadataStatusSnapshot)
}
