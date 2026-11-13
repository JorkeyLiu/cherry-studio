import type { ApiClient, Model } from '@types'

import type { FileMetadata } from './file'

export type KnowledgeItemType = 'file' | 'url' | 'note' | 'sitemap' | 'directory' | 'memory' | 'video'

export type KnowledgeItem = {
  id: string
  baseId?: string
  uniqueId?: string
  uniqueIds?: string[]
  type: KnowledgeItemType
  content: string | FileMetadata | FileMetadata[]
  remark?: string
  created_at: number
  updated_at: number
  processingStatus?: ProcessingStatus
  processingProgress?: number
  processingError?: string
  retryCount?: number
}

export type KnowledgeFileItem = KnowledgeItem & {
  type: 'file'
  content: FileMetadata
}

export const isKnowledgeFileItem = (item: KnowledgeItem): item is KnowledgeFileItem => {
  return item.type === 'file'
}

export type KnowledgeVideoItem = KnowledgeItem & {
  type: 'video'
  content: FileMetadata[]
}

export const isKnowledgeVideoItem = (item: KnowledgeItem): item is KnowledgeVideoItem => {
  return item.type === 'video'
}

export type KnowledgeNoteItem = KnowledgeItem & {
  type: 'note'
  content: string
  sourceUrl?: string
}

export const isKnowledgeNoteItem = (item: KnowledgeItem): item is KnowledgeNoteItem => {
  return item.type === 'note'
}

export type KnowledgeDirectoryItem = KnowledgeItem & {
  type: 'directory'
  content: string
}

export const isKnowledgeDirectoryItem = (item: KnowledgeItem): item is KnowledgeDirectoryItem => {
  return item.type === 'directory'
}

export type KnowledgeUrlItem = KnowledgeItem & {
  type: 'url'
  content: string
}

export const isKnowledgeUrlItem = (item: KnowledgeItem): item is KnowledgeUrlItem => {
  return item.type === 'url'
}

export type KnowledgeSitemapItem = KnowledgeItem & {
  type: 'sitemap'
  content: string
}

export const isKnowledgeSitemapItem = (item: KnowledgeItem): item is KnowledgeSitemapItem => {
  return item.type === 'sitemap'
}

export type KnowledgeGeneralItem = KnowledgeItem & {
  content: string
}
export interface KnowledgeBase {
  id: string
  name: string
  // Optional: migration 222 clears the embedding model ref to undefined when
  // its owning provider is retired (never repointed). Consumers must treat a
  // missing model as explicitly unconfigured and fail before any provider/API
  // access — never silently substitute another model.
  model?: Model
  dimensions?: number
  description?: string
  items: KnowledgeItem[]
  created_at: number
  updated_at: number
  version: number
  documentCount?: number
  chunkSize?: number
  chunkOverlap?: number
  threshold?: number
  rerankModel?: Model
}

export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed'

export type KnowledgeBaseParams = {
  id: string
  dimensions?: number
  chunkSize?: number
  chunkOverlap?: number
  embedApiClient: ApiClient
  rerankApiClient?: ApiClient
  documentCount?: number
}

export type KnowledgeReference = {
  id: number
  content: string
  sourceUrl: string
  type: KnowledgeItemType
  file?: FileMetadata
  metadata?: Record<string, any>
}

export interface KnowledgeSearchResult {
  pageContent: string
  score: number
  metadata: Record<string, any>
}
