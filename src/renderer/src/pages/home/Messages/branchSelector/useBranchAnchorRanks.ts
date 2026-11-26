import { loggerService } from '@logger'
import type { TopicBranchWire } from '@renderer/services/db/types'
import { loadWholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { BranchAnchorRanks } from './branchTreeOrdering'

const logger = loggerService.withContext('useBranchAnchorRanks')
const EMPTY_RANKS: BranchAnchorRanks = new Map()

type RankState = {
  topicId: string
  catalogKey: string
  ranks: BranchAnchorRanks
}

/**
 * Loads parent-route message positions for the top selector only while its
 * panel is open. Successful results are cached by topic and catalog anchor
 * shape for this hook lifetime, so closing and reopening the same panel does
 * not repeat IPC. A changed anchor shape starts a fresh generation.
 */
export function useBranchAnchorRanks(
  topicId: string,
  branches: readonly TopicBranchWire[],
  enabled: boolean
): BranchAnchorRanks {
  const catalogKey = useMemo(() => {
    const anchorsByParent = new Map<string | null, Set<string>>()
    branches.forEach((branch) => {
      const parentBranchId = branch.parentBranchId ?? null
      const anchors = anchorsByParent.get(parentBranchId) ?? new Set<string>()
      anchors.add(branch.anchorMessageId)
      anchorsByParent.set(parentBranchId, anchors)
    })
    const parents = [...anchorsByParent.keys()].sort((a, b) => {
      if (a === b) return 0
      if (a === null) return -1
      if (b === null) return 1
      return a.localeCompare(b)
    })
    return JSON.stringify(
      parents.map((parentBranchId) => [parentBranchId, [...(anchorsByParent.get(parentBranchId) ?? [])].sort()])
    )
  }, [branches])
  const branchesRef = useRef(branches)
  branchesRef.current = branches
  const cacheRef = useRef(new Map<string, Map<string, BranchAnchorRanks>>())
  const generationRef = useRef(0)
  const [state, setState] = useState<RankState>({ topicId: '', catalogKey: '', ranks: EMPTY_RANKS })

  useEffect(() => {
    const generation = ++generationRef.current
    if (!enabled) return
    let active = true

    const cached = cacheRef.current.get(topicId)?.get(catalogKey)
    if (cached !== undefined) {
      setState({ topicId, catalogKey, ranks: cached })
      return () => {
        active = false
      }
    }

    const anchorsByParent = new Map<string | null, Set<string>>()
    branchesRef.current.forEach((branch) => {
      const parentBranchId = branch.parentBranchId ?? null
      const anchors = anchorsByParent.get(parentBranchId) ?? new Set<string>()
      anchors.add(branch.anchorMessageId)
      anchorsByParent.set(parentBranchId, anchors)
    })

    const load = async (): Promise<void> => {
      const results = await Promise.allSettled(
        [...anchorsByParent.keys()].map(async (parentBranchId) => {
          const snapshot = await loadWholeTopicSnapshot(topicId, parentBranchId)
          const messageRanks = new Map<string, number>()
          snapshot.messages.forEach((message, rank) => messageRanks.set(message.id, rank))
          return { parentBranchId, messageRanks }
        })
      )
      if (!active || generationRef.current !== generation) return

      const ranks = new Map<string | null, ReadonlyMap<string, number>>()
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          ranks.set(result.value.parentBranchId, result.value.messageRanks)
        } else {
          logger.warn('[useBranchAnchorRanks] Failed to load parent-route message positions')
        }
      })

      if (ranks.size > 0) {
        const topicCache = cacheRef.current.get(topicId) ?? new Map<string, BranchAnchorRanks>()
        topicCache.set(catalogKey, ranks)
        cacheRef.current.set(topicId, topicCache)
      }
      setState({ topicId, catalogKey, ranks })
    }
    void load()

    return () => {
      active = false
    }
  }, [catalogKey, enabled, topicId])

  return state.topicId === topicId && state.catalogKey === catalogKey ? state.ranks : EMPTY_RANKS
}
