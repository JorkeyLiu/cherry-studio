import { ActionIconButton } from '@renderer/components/Buttons'
import { scrollElementIntoView } from '@renderer/utils'
import { Tooltip } from 'antd'
import { debounce } from 'lodash'
import { CaseSensitive, ChevronDown, ChevronUp, User, WholeWord, X } from 'lucide-react'
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import {
  createContentSearchSessionOwnerId,
  incrementRescanCount,
  recordContentSearchClear,
  recordContentSearchCommit,
  recordContentSearchInvalidation,
  releaseContentSearchSessionIfOwned,
  setContentSearchDomGeneration
} from './contentSearchDiagnostics'

interface Props {
  children?: React.ReactNode
  searchTarget: React.RefObject<React.ReactNode> | React.RefObject<HTMLElement> | HTMLElement
  /**
   * 过滤`node`，`node`只会是`Node.TEXT_NODE`类型的文本节点
   *
   * 返回`true`表示该`node`会被搜索
   */
  filter: NodeFilter
  includeUser?: boolean
  onIncludeUserChange?: (value: boolean) => void
  /**
   * 是否显示“包含用户问题”切换按钮（默认为 true）。
   * 在富文本编辑器场景通常不需要该按钮。
   */
  showUserToggle?: boolean
  /**
   * 搜索条定位方式
   */
  positionMode?: 'fixed' | 'absolute' | 'sticky'
  /**
   * S3.5: Parent-owned activation.
   * When ContentSearch is mounted it is always active; unmount is owned by the parent.
   * initialText is applied on mount (queue of imperative enable before mount).
   * onClose is called when the search requests to close (Escape/close button) so the
   * parent can unmount. The component also clears highlights on unmount.
   */
  initialText?: string
  onClose?: () => void
}

enum SearchCompletedState {
  NotSearched,
  Searched
}

export interface ContentSearchRef {
  disable(): void
  enable(initialText?: string): void
  // 搜索下一个并定位
  searchNext(): void
  // 搜索上一个并定位
  searchPrev(): void
  // 搜索并定位
  search(): void
  // 搜索但不定位，或者说是更新
  silentSearch(): void
  focus(): void
}

export const CONTENT_SEARCH_CHUNK_SIZE = 500

export const escapeRegExp = (string: string): string => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // $& means the whole matched string
}

export const createSearchRegex = (searchText: string, isCaseSensitive: boolean, isWholeWord: boolean): RegExp => {
  const escapedSearchText = escapeRegExp(searchText)
  const hasOnlyLatinLetters = /^[a-zA-Z\s]+$/.test(searchText)
  const regexFlags = hasOnlyLatinLetters && isCaseSensitive ? 'g' : 'gi'
  const regexPattern = isWholeWord ? `\\b${escapedSearchText}\\b` : escapedSearchText
  return new RegExp(regexPattern, regexFlags)
}

const safeClearHighlights = () => {
  try {
    ;(globalThis as any).CSS?.highlights?.clear?.()
  } catch {}
}

const safeSetHighlight = (name: string, highlight: any) => {
  try {
    ;(globalThis as any).CSS?.highlights?.set?.(name, highlight)
  } catch {}
}

const hasHighlightAPI = () =>
  typeof (globalThis as any).Highlight !== 'undefined' && !!(globalThis as any).CSS?.highlights

export interface ChunkScanResult {
  ranges: Range[]
  totalCount: number
}

/**
 * B-08 bounded search-session helper.
 * Scans the currently rendered DOM (target filtered by NodeFilter) and
 * materializes only the requested 500-match chunk. Total count is derived
 * without retaining unbounded descriptors — only the current chunk's Ranges
 * are kept alive. Rendered-DOM-only.
 */
export const scanTargetForChunk = (
  target: HTMLElement | null,
  filter: NodeFilter,
  searchText: string,
  isCaseSensitive: boolean,
  isWholeWord: boolean,
  chunkIndex: number,
  chunkSize: number = CONTENT_SEARCH_CHUNK_SIZE
): ChunkScanResult => {
  if (!target || !searchText || searchText.trim() === '') {
    return { ranges: [], totalCount: 0 }
  }
  const searchRegex = createSearchRegex(searchText, isCaseSensitive, isWholeWord)
  const treeWalker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, filter)
  const allTextNodes: { node: Node; startOffset: number }[] = []
  let fullText = ''

  while (treeWalker.nextNode()) {
    allTextNodes.push({
      node: treeWalker.currentNode,
      startOffset: fullText.length
    })
    fullText += (treeWalker.currentNode.nodeValue as string) ?? ''
  }

  const desiredStart = chunkIndex * chunkSize
  const desiredEnd = desiredStart + chunkSize
  const ranges: Range[] = []
  let globalMatchIndex = 0
  let match: RegExpExecArray | null

  while ((match = searchRegex.exec(fullText)) !== null) {
    if (match[0].length === 0) {
      searchRegex.lastIndex += 1
      continue
    }
    if (globalMatchIndex >= desiredStart && globalMatchIndex < desiredEnd) {
      const matchStart = match.index
      const matchEnd = matchStart + match[0].length
      let startNode: Node | null = null
      let endNode: Node | null = null
      let startOffset = 0
      let endOffset = 0
      for (const nodeInfo of allTextNodes) {
        const len = nodeInfo.node.nodeValue?.length ?? 0
        if (matchStart >= nodeInfo.startOffset && matchStart < nodeInfo.startOffset + len) {
          startNode = nodeInfo.node
          startOffset = matchStart - nodeInfo.startOffset
          break
        }
      }
      for (const nodeInfo of allTextNodes) {
        const len = nodeInfo.node.nodeValue?.length ?? 0
        if (matchEnd > nodeInfo.startOffset && matchEnd <= nodeInfo.startOffset + len) {
          endNode = nodeInfo.node
          endOffset = matchEnd - nodeInfo.startOffset
          break
        }
      }
      if (startNode && endNode) {
        const range = new Range()
        range.setStart(startNode, startOffset)
        range.setEnd(endNode, endOffset)
        ranges.push(range)
      }
    }
    globalMatchIndex += 1
  }

  return { ranges, totalCount: globalMatchIndex }
}

// eslint-disable-next-line @eslint-react/no-forward-ref
export const ContentSearch = React.forwardRef<ContentSearchRef, Props>(
  (
    {
      searchTarget,
      filter,
      includeUser = false,
      onIncludeUserChange,
      showUserToggle = true,
      positionMode = 'fixed',
      initialText,
      onClose
    },
    ref
  ) => {
    const target: HTMLElement | null = (() => {
      if (searchTarget instanceof HTMLElement) {
        return searchTarget
      } else {
        return (searchTarget.current as HTMLElement) ?? null
      }
    })()
    const containerRef = React.useRef<HTMLDivElement>(null)
    const searchInputRef = React.useRef<HTMLInputElement>(null)
    const isParentOwned = Boolean(onClose)
    const [enableContentSearch, setEnableContentSearch] = useState(() => isParentOwned)
    const [searchCompleted, setSearchCompleted] = useState(SearchCompletedState.NotSearched)
    const [isCaseSensitive, setIsCaseSensitive] = useState(false)
    const [isWholeWord, setIsWholeWord] = useState(false)
    // B-08 bounded search session: at most one 500-match chunk materialized in liveRangesRef.
    // liveRangesRef is the single authoritative ownership for live Range handles; React state does not duplicate the array.
    const liveRangesRef = useRef<Range[]>([])
    const [liveVersion, setLiveVersion] = useState(0)
    const [chunkIndex, setChunkIndex] = useState(0)
    const [totalCount, setTotalCount] = useState(0)
    const [globalIndex, setGlobalIndex] = useState(-1)
    const prevSearchText = useRef('')
    const { t } = useTranslation()
    const domGenerationRef = useRef(0)
    const domDirtyRef = useRef(false)
    const lastDomSnapshotRef = useRef<{ textLength: number; childCount: number } | null>(null)
    // B-08 owner protocol: numeric owner created once per instance; commit claims only active/newer owner; no mount-time claim
    // Lazy initialization avoids allocating an ID on every render (preserves sessionCounter monotonic budget)
    const ownerIdRef = useRef<number>(null as unknown as number)
    if ((ownerIdRef.current as unknown) === null) {
      ownerIdRef.current = createContentSearchSessionOwnerId()
    }

    // Refs mirroring latest values for MutationObserver without re-creating observer on index changes
    const chunkIndexRef = useRef(chunkIndex)
    const globalIndexRef = useRef(globalIndex)
    const totalCountRef = useRef(totalCount)
    const isCaseSensitiveRef = useRef(isCaseSensitive)
    const isWholeWordRef = useRef(isWholeWord)
    const filterRef = useRef(filter)
    const searchCompletedRef = useRef(searchCompleted)

    useEffect(() => {
      chunkIndexRef.current = chunkIndex
    }, [chunkIndex])
    useEffect(() => {
      globalIndexRef.current = globalIndex
    }, [globalIndex])
    useEffect(() => {
      totalCountRef.current = totalCount
    }, [totalCount])
    useEffect(() => {
      isCaseSensitiveRef.current = isCaseSensitive
    }, [isCaseSensitive])
    useEffect(() => {
      isWholeWordRef.current = isWholeWord
    }, [isWholeWord])
    useEffect(() => {
      filterRef.current = filter
    }, [filter])
    useEffect(() => {
      searchCompletedRef.current = searchCompleted
    }, [searchCompleted])

    // Lightweight DOM snapshot to avoid heavy rescan on every same-chunk navigation when DOM unchanged
    // Fallback dimensions are derived only from searchable target content excluding ContentSearch host subtree
    // when the host lies within the target, preserving filter/search semantics and avoiding host-only UI invalidation.
    const captureDomSnapshot = useCallback(() => {
      if (!target) return null
      try {
        const host = containerRef.current
        const hostInside = !!host && target.contains(host)
        const filterFn: any = filterRef.current
        let textLength = 0
        const seenParents = new Set<Element>()
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
          acceptNode(node: Node) {
            if (hostInside && host.contains(node)) {
              return NodeFilter.FILTER_REJECT
            }
            if (typeof filterFn === 'function') {
              return (filterFn as (n: Node) => number)(node)
            }
            return filterFn.acceptNode(node)
          }
        } as any)
        while (walker.nextNode()) {
          const n = walker.currentNode as Text
          textLength += n.nodeValue?.length ?? 0
          const parent = n.parentElement
          if (parent) seenParents.add(parent)
        }
        const childCount = seenParents.size
        return { textLength, childCount }
      } catch {
        return null
      }
    }, [target])

    const commitLiveChunk = useCallback(
      (ranges: Range[], nextChunkIndex: number, nextTotal: number, nextGlobal: number) => {
        // Single ownership: liveRangesRef is the only live Range cache. Assignment replaces previous chunk atomically;
        // callers must have already dropped the previous reference before scanning (see search/searchNext).
        liveRangesRef.current = ranges
        setChunkIndex(nextChunkIndex)
        setTotalCount(nextTotal)
        setGlobalIndex(nextGlobal)
        setLiveVersion((v) => v + 1)
        // snapshot rendered DOM generation after successful commit
        lastDomSnapshotRef.current = captureDomSnapshot()
        domDirtyRef.current = false
        // B-08 diagnostics: owner-aware commit only after successful installation, preserves release-before-allocation
        recordContentSearchCommit(
          ownerIdRef.current,
          ranges.length,
          nextChunkIndex,
          nextTotal,
          domGenerationRef.current
        )
      },
      [captureDomSnapshot]
    )

    const clearLiveChunk = useCallback(() => {
      // Synchronous release: drop live Range handles before any new materialization
      liveRangesRef.current = []
      setChunkIndex(0)
      setTotalCount(0)
      setGlobalIndex(-1)
      setLiveVersion((v) => v + 1)
      lastDomSnapshotRef.current = captureDomSnapshot()
      domDirtyRef.current = false
      // B-08 diagnostics: active-owner-only clear, never claims ownership
      recordContentSearchClear(ownerIdRef.current, domGenerationRef.current)
    }, [captureDomSnapshot])

    const resetSearch = useCallback(() => {
      safeClearHighlights()
      clearLiveChunk()
      setSearchCompleted(SearchCompletedState.NotSearched)
    }, [clearLiveChunk])

    const locateByIndex = useCallback(
      (shouldScroll = true) => {
        safeClearHighlights()
        const ranges = liveRangesRef.current
        if (ranges.length > 0) {
          if (!hasHighlightAPI()) return
          const allMatchesHighlight = new (globalThis as any).Highlight(...ranges)
          safeSetHighlight('search-matches', allMatchesHighlight)
          if (globalIndex !== -1) {
            const localIndex = globalIndex - chunkIndex * CONTENT_SEARCH_CHUNK_SIZE
            const currentMatchRange = ranges[localIndex]
            if (currentMatchRange) {
              const currentMatchHighlight = new (globalThis as any).Highlight(currentMatchRange)
              safeSetHighlight('current-match', currentMatchHighlight)
              const parentElement = currentMatchRange.startContainer.parentElement
              if (shouldScroll && parentElement) {
                scrollElementIntoView(parentElement, target)
              }
            }
          }
        }
      },
      [chunkIndex, globalIndex, target]
    )

    const search = useCallback(
      (jump = false) => {
        const searchText = searchInputRef.current?.value.trim() ?? null
        setSearchCompleted(SearchCompletedState.Searched)
        if (target && searchText !== null && searchText !== '') {
          // B-08 ownership: release previous chunk's live Ranges BEFORE creating new 500 Range array
          liveRangesRef.current = []
          safeClearHighlights()
          const result = scanTargetForChunk(target, filter, searchText, isCaseSensitive, isWholeWord, 0)
          commitLiveChunk(result.ranges, 0, result.totalCount, jump && result.totalCount > 0 ? 0 : -1)
          domGenerationRef.current += 1
          // B-08 diagnostics: sync generation through committed/active owner only after successful commit
          setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
        } else if (searchText === '' || searchText === null) {
          safeClearHighlights()
          clearLiveChunk()
        }
      },
      [target, filter, isCaseSensitive, isWholeWord, commitLiveChunk, clearLiveChunk]
    )

    const rafIdsRef = useRef<number[]>([])
    const pendingSearchRafIdsRef = useRef<number[]>([])

    const trackRaf = useCallback((id: number) => {
      rafIdsRef.current.push(id)
    }, [])

    // Helper that schedules focus RAF and auto-removes id after execution, without being canceled by debounce lifecycle
    const scheduleFocusRaf = useCallback(
      (cb: () => void) => {
        const id = requestAnimationFrame(() => {
          rafIdsRef.current = rafIdsRef.current.filter((x) => x !== id)
          cb()
        })
        trackRaf(id)
        return id
      },
      [trackRaf]
    )

    const scheduleSearchRaf = useCallback(
      (cb: () => void) => {
        const id = requestAnimationFrame(() => {
          pendingSearchRafIdsRef.current = pendingSearchRafIdsRef.current.filter((x) => x !== id)
          rafIdsRef.current = rafIdsRef.current.filter((x) => x !== id)
          cb()
        })
        pendingSearchRafIdsRef.current.push(id)
        trackRaf(id)
        return id
      },
      [trackRaf]
    )

    // Rendered-DOM generation invalidation: MutationObserver scoped to search target, precise lifecycle, cleanup on target change/unmount
    // Invalidation marks the session dirty and increments generation; actual rescan is deferred until next navigation
    // (same-chunk or cross-chunk) or explicit search, satisfying "must rescan before same-chunk navigation can continue"
    // without polling or background timers. Streaming DOM changes are covered via observer batching.
    useEffect(() => {
      if (!target) return
      const observer = new MutationObserver((mutations) => {
        const searchText = searchInputRef.current?.value.trim() ?? ''
        if (!searchText) return
        if (searchCompletedRef.current === SearchCompletedState.NotSearched) {
          return
        }
        // Ignore mutations whose target is inside the ContentSearch host UI,
        // even when the observed searchTarget (Chat mainRef) contains that host.
        const host = containerRef.current
        let hasRelevant = false
        for (const record of mutations) {
          const t = record.target
          if (host && (t === host || host.contains(t))) {
            continue
          }
          if (record.type === 'childList' && host) {
            const nodes: Node[] = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
            let isHostStructure = false
            for (const n of nodes) {
              if (n === host) {
                isHostStructure = true
                break
              }
            }
            if (isHostStructure) continue
          }
          hasRelevant = true
          break
        }
        if (!hasRelevant) return
        domDirtyRef.current = true
        domGenerationRef.current += 1
        // B-08 diagnostics: owner-aware invalidation on relevant DOM mutation
        recordContentSearchInvalidation(ownerIdRef.current, domGenerationRef.current)
        // Invalidate current highlights to avoid stale current-match pointing at detached ranges
        safeClearHighlights()
      })
      observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true })
      return () => observer.disconnect()
    }, [target])

    // Target identity invalidation: active session is a completed nonempty query
    // regardless of match count. On target loss (null) synchronously clear stale result metadata;
    // on non-null replacement rescan retained query even if prior count was zero.
    // Also invalidates any pending search RAF that would otherwise commit a superseded target.
    const prevTargetRef = useRef<HTMLElement | null>(null)
    useEffect(() => {
      const prev = prevTargetRef.current
      if (prev !== target) {
        const searchText = searchInputRef.current?.value.trim() ?? ''
        const hadActive = searchCompletedRef.current === SearchCompletedState.Searched && searchText !== ''
        const hadPendingSearch = pendingSearchRafIdsRef.current.length > 0
        // Cancel pending search RAFs that would scan/commit superseded target; focus-only RAFs remain.
        if (hadPendingSearch) {
          const cancelled = new Set(pendingSearchRafIdsRef.current)
          pendingSearchRafIdsRef.current.forEach((id) => cancelAnimationFrame(id))
          pendingSearchRafIdsRef.current = []
          rafIdsRef.current = rafIdsRef.current.filter((id) => !cancelled.has(id))
        }
        const shouldInvalidate = prev !== null || hadActive || hadPendingSearch
        if (shouldInvalidate) {
          safeClearHighlights()
          // Synchronous release before any new allocation — bounds live Range handles
          liveRangesRef.current = []
          lastDomSnapshotRef.current = null
          domDirtyRef.current = true
          domGenerationRef.current += 1
          // B-08 diagnostics: owner-aware invalidation on target identity change
          recordContentSearchInvalidation(ownerIdRef.current, domGenerationRef.current)
          setLiveVersion((v) => v + 1)
          if (hadActive && target && searchText) {
            const currentChunk = chunkIndexRef.current
            const nextGlobal = globalIndexRef.current
            const result = scanTargetForChunk(
              target,
              filterRef.current,
              searchText,
              isCaseSensitiveRef.current,
              isWholeWordRef.current,
              currentChunk
            )
            const effectiveTotal = result.totalCount
            if (effectiveTotal === 0) {
              commitLiveChunk([], 0, 0, -1)
            } else {
              let clampedGlobal = nextGlobal
              if (clampedGlobal >= effectiveTotal) clampedGlobal = effectiveTotal - 1
              const clampedChunk =
                clampedGlobal === -1 ? currentChunk : Math.floor(clampedGlobal / CONTENT_SEARCH_CHUNK_SIZE)
              if (clampedChunk !== currentChunk && clampedGlobal !== -1) {
                liveRangesRef.current = []
                safeClearHighlights()
                const second = scanTargetForChunk(
                  target,
                  filterRef.current,
                  searchText,
                  isCaseSensitiveRef.current,
                  isWholeWordRef.current,
                  clampedChunk
                )
                commitLiveChunk(second.ranges, clampedChunk, second.totalCount, clampedGlobal)
              } else {
                commitLiveChunk(result.ranges, currentChunk, effectiveTotal, clampedGlobal)
              }
            }
            incrementRescanCount(ownerIdRef.current)
          } else if (hadPendingSearch && target && searchText) {
            // Pending enable/initial RAF was superseded: rescan retained query on latest target.
            // Synchronous scan ensures latest target ownership; mark session as Searched.
            liveRangesRef.current = []
            safeClearHighlights()
            const result = scanTargetForChunk(
              target,
              filterRef.current,
              searchText,
              isCaseSensitiveRef.current,
              isWholeWordRef.current,
              0
            )
            commitLiveChunk(result.ranges, 0, result.totalCount, result.totalCount > 0 ? 0 : -1)
            setSearchCompleted(SearchCompletedState.Searched)
            incrementRescanCount(ownerIdRef.current)
          } else {
            // No active query to rescan or target lost — ensure bounded state cleared while retaining query text
            setChunkIndex(0)
            setTotalCount(0)
            setGlobalIndex(-1)
            // B-08 diagnostics: active-owner-only clear for target loss without active query
            recordContentSearchClear(ownerIdRef.current, domGenerationRef.current)
          }
        }
        prevTargetRef.current = target
      }
    }, [target, commitLiveChunk])

    const implementation = useMemo(
      () => ({
        disable: () => {
          safeClearHighlights()
          clearLiveChunk()
          setSearchCompleted(SearchCompletedState.NotSearched)
          if (isParentOwned) {
            onClose?.()
          } else {
            setEnableContentSearch(false)
          }
        },
        enable: (nextText?: string) => {
          if (!isParentOwned) {
            setEnableContentSearch(true)
          }
          if (searchInputRef.current) {
            const inputEl = searchInputRef.current
            if (nextText && nextText.trim().length > 0) {
              inputEl.value = nextText
              scheduleSearchRaf(() => {
                inputEl.focus()
                inputEl.select()
                search(false)
              })
            } else {
              scheduleFocusRaf(() => {
                inputEl.focus()
                inputEl.select()
              })
            }
          }
        },
        searchNext: () => {
          const searchText = searchInputRef.current?.value.trim() ?? ''
          if (!searchText) return
          const currentTotal = totalCountRef.current
          const currentGlobal = globalIndexRef.current
          const currentChunk = chunkIndexRef.current
          if (currentTotal === 0) {
            if (!target) return
            const snapshot = captureDomSnapshot()
            const last = lastDomSnapshotRef.current
            const isDomStale =
              domDirtyRef.current ||
              !last ||
              snapshot?.textLength !== last.textLength ||
              snapshot?.childCount !== last.childCount
            if (!isDomStale) return
            liveRangesRef.current = []
            safeClearHighlights()
            const result = scanTargetForChunk(target, filter, searchText, isCaseSensitive, isWholeWord, 0)
            commitLiveChunk(result.ranges, 0, result.totalCount, result.totalCount > 0 ? 0 : -1)
            domGenerationRef.current += 1
            setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
            incrementRescanCount(ownerIdRef.current)
            return
          }
          const nextGlobal = currentGlobal === -1 ? 0 : currentGlobal < currentTotal - 1 ? currentGlobal + 1 : 0
          const targetChunk = Math.floor(nextGlobal / CONTENT_SEARCH_CHUNK_SIZE)
          if (targetChunk !== currentChunk) {
            if (!target) return
            // Release old chunk before scanning target chunk
            liveRangesRef.current = []
            safeClearHighlights()
            const result = scanTargetForChunk(target, filter, searchText, isCaseSensitive, isWholeWord, targetChunk)
            const effectiveTotal = result.totalCount
            if (effectiveTotal === 0) {
              commitLiveChunk([], 0, 0, -1)
              domGenerationRef.current += 1
              setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
              incrementRescanCount(ownerIdRef.current)
              return
            }
            const clampedNext = Math.min(nextGlobal, effectiveTotal - 1)
            const clampedChunk = Math.floor(clampedNext / CONTENT_SEARCH_CHUNK_SIZE)
            if (clampedChunk !== targetChunk) {
              liveRangesRef.current = []
              const second = scanTargetForChunk(target, filter, searchText, isCaseSensitive, isWholeWord, clampedChunk)
              commitLiveChunk(second.ranges, clampedChunk, second.totalCount, clampedNext)
            } else {
              commitLiveChunk(result.ranges, targetChunk, effectiveTotal, nextGlobal)
            }
            domGenerationRef.current += 1
            setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
            incrementRescanCount(ownerIdRef.current)
          } else {
            if (!target) {
              setGlobalIndex(nextGlobal)
              return
            }
            // Same-chunk: rescan only when rendered DOM generation is stale to preserve bounded cost.
            // Fast path (no DOM change) just advances index without materializing new Ranges.
            const snapshot = captureDomSnapshot()
            const last = lastDomSnapshotRef.current
            const isDomStale =
              domDirtyRef.current ||
              !last ||
              snapshot?.textLength !== last.textLength ||
              snapshot?.childCount !== last.childCount
            if (!isDomStale) {
              setGlobalIndex(nextGlobal)
              return
            }
            // Stale DOM: retain only primitive metadata, synchronously release old ownership/highlights before allocation
            const prevTotal = currentTotal
            const prevLen = liveRangesRef.current.length
            void prevLen
            liveRangesRef.current = []
            safeClearHighlights()
            if (typeof globalThis !== 'undefined') {
              ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE = liveRangesRef.current.length
              ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_TOTAL = prevTotal
            }
            const sameResult = scanTargetForChunk(
              target,
              filter,
              searchText,
              isCaseSensitive,
              isWholeWord,
              currentChunk
            )
            const effectiveTotal = sameResult.totalCount
            if (effectiveTotal === 0) {
              commitLiveChunk([], 0, 0, -1)
              domGenerationRef.current += 1
              setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
              incrementRescanCount(ownerIdRef.current)
              return
            }
            if (effectiveTotal !== prevTotal) {
              const clampedNext = Math.min(nextGlobal, effectiveTotal - 1)
              const clampedChunk = Math.floor(clampedNext / CONTENT_SEARCH_CHUNK_SIZE)
              if (clampedChunk !== currentChunk) {
                liveRangesRef.current = []
                safeClearHighlights()
                const second = scanTargetForChunk(
                  target,
                  filter,
                  searchText,
                  isCaseSensitive,
                  isWholeWord,
                  clampedChunk
                )
                commitLiveChunk(second.ranges, clampedChunk, second.totalCount, clampedNext)
                domGenerationRef.current += 1
                setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
                incrementRescanCount(ownerIdRef.current)
                return
              }
              commitLiveChunk(sameResult.ranges, currentChunk, effectiveTotal, clampedNext)
              domGenerationRef.current += 1
              setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
              incrementRescanCount(ownerIdRef.current)
              return
            }
            commitLiveChunk(sameResult.ranges, currentChunk, effectiveTotal, nextGlobal)
            domGenerationRef.current += 1
            setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
            incrementRescanCount(ownerIdRef.current)
          }
        },
        searchPrev: () => {
          const searchText = searchInputRef.current?.value.trim() ?? ''
          if (!searchText) return
          const currentTotal = totalCountRef.current
          const currentGlobal = globalIndexRef.current
          const currentChunk = chunkIndexRef.current
          if (currentTotal === 0) {
            if (!target) return
            const snapshot = captureDomSnapshot()
            const last = lastDomSnapshotRef.current
            const isDomStale =
              domDirtyRef.current ||
              !last ||
              snapshot?.textLength !== last.textLength ||
              snapshot?.childCount !== last.childCount
            if (!isDomStale) return
            liveRangesRef.current = []
            safeClearHighlights()
            const result = scanTargetForChunk(target, filter, searchText, isCaseSensitive, isWholeWord, 0)
            commitLiveChunk(result.ranges, 0, result.totalCount, result.totalCount > 0 ? result.totalCount - 1 : -1)
            domGenerationRef.current += 1
            setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
            incrementRescanCount(ownerIdRef.current)
            return
          }
          const prevGlobal =
            currentGlobal === -1 ? currentTotal - 1 : currentGlobal > 0 ? currentGlobal - 1 : currentTotal - 1
          const targetChunk = Math.floor(prevGlobal / CONTENT_SEARCH_CHUNK_SIZE)
          if (targetChunk !== currentChunk) {
            if (!target) return
            liveRangesRef.current = []
            safeClearHighlights()
            const result = scanTargetForChunk(target, filter, searchText, isCaseSensitive, isWholeWord, targetChunk)
            const effectiveTotal = result.totalCount
            if (effectiveTotal === 0) {
              commitLiveChunk([], 0, 0, -1)
              domGenerationRef.current += 1
              setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
              incrementRescanCount(ownerIdRef.current)
              return
            }
            const clampedPrev = Math.min(prevGlobal, effectiveTotal - 1)
            const clampedChunk = Math.floor(clampedPrev / CONTENT_SEARCH_CHUNK_SIZE)
            if (clampedChunk !== targetChunk) {
              liveRangesRef.current = []
              const second = scanTargetForChunk(target, filter, searchText, isCaseSensitive, isWholeWord, clampedChunk)
              commitLiveChunk(second.ranges, clampedChunk, second.totalCount, clampedPrev)
            } else {
              commitLiveChunk(result.ranges, targetChunk, effectiveTotal, prevGlobal)
            }
            domGenerationRef.current += 1
            setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
            incrementRescanCount(ownerIdRef.current)
          } else {
            if (!target) {
              setGlobalIndex(prevGlobal)
              return
            }
            const snapshot = captureDomSnapshot()
            const last = lastDomSnapshotRef.current
            const isDomStale =
              domDirtyRef.current ||
              !last ||
              snapshot?.textLength !== last.textLength ||
              snapshot?.childCount !== last.childCount
            if (!isDomStale) {
              setGlobalIndex(prevGlobal)
              return
            }
            // Same-chunk prev: retain only primitives, release synchronously before allocation
            const prevTotalP = currentTotal
            const prevLenP = liveRangesRef.current.length
            void prevLenP
            liveRangesRef.current = []
            safeClearHighlights()
            if (typeof globalThis !== 'undefined') {
              ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE = liveRangesRef.current.length
              ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_TOTAL = prevTotalP
            }
            const sameResult = scanTargetForChunk(
              target,
              filter,
              searchText,
              isCaseSensitive,
              isWholeWord,
              currentChunk
            )
            const effectiveTotal = sameResult.totalCount
            if (effectiveTotal === 0) {
              commitLiveChunk([], 0, 0, -1)
              domGenerationRef.current += 1
              setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
              incrementRescanCount(ownerIdRef.current)
              return
            }
            if (effectiveTotal !== prevTotalP) {
              const clampedPrev = Math.min(prevGlobal, effectiveTotal - 1)
              const clampedChunk = Math.floor(clampedPrev / CONTENT_SEARCH_CHUNK_SIZE)
              if (clampedChunk !== currentChunk) {
                liveRangesRef.current = []
                safeClearHighlights()
                const second = scanTargetForChunk(
                  target,
                  filter,
                  searchText,
                  isCaseSensitive,
                  isWholeWord,
                  clampedChunk
                )
                commitLiveChunk(second.ranges, clampedChunk, second.totalCount, clampedPrev)
                domGenerationRef.current += 1
                setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
                incrementRescanCount(ownerIdRef.current)
                return
              }
              commitLiveChunk(sameResult.ranges, currentChunk, effectiveTotal, clampedPrev)
              domGenerationRef.current += 1
              setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
              incrementRescanCount(ownerIdRef.current)
              return
            }
            commitLiveChunk(sameResult.ranges, currentChunk, effectiveTotal, prevGlobal)
            domGenerationRef.current += 1
            setContentSearchDomGeneration(ownerIdRef.current, domGenerationRef.current)
            incrementRescanCount(ownerIdRef.current)
          }
        },
        resetSearchState: () => {
          setSearchCompleted(SearchCompletedState.NotSearched)
        },
        search: () => {
          search(true)
          locateByIndex(true)
        },
        silentSearch: () => {
          search(false)
          locateByIndex(false)
        },
        focus: () => {
          searchInputRef.current?.focus()
        }
      }),
      [
        isParentOwned,
        onClose,
        target,
        filter,
        isCaseSensitive,
        isWholeWord,
        search,
        locateByIndex,
        commitLiveChunk,
        clearLiveChunk,
        scheduleFocusRaf,
        scheduleSearchRaf,
        captureDomSnapshot
      ]
    )

    const _searchHandlerDebounce = useMemo(() => debounce(implementation.search, 300), [implementation.search])

    // Debounce lifecycle: cancel only when debounce instance changes (search semantics change), not on focus RAFs
    useEffect(() => {
      return () => {
        _searchHandlerDebounce.cancel()
      }
    }, [_searchHandlerDebounce])

    const searchHandler = useCallback(() => {
      _searchHandlerDebounce()
    }, [_searchHandlerDebounce])

    const userInputHandler = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value.trim()
        if (value.length === 0) {
          resetSearch()
        } else {
          searchHandler()
        }
        prevSearchText.current = value
      },
      [searchHandler, resetSearch]
    )

    const keyDownHandler = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          const value = (event.target as HTMLInputElement).value.trim()
          if (value.length === 0) {
            resetSearch()
            return
          }
          if (event.shiftKey) {
            implementation.searchPrev()
          } else {
            implementation.searchNext()
          }
        } else if (event.key === 'Escape') {
          event.stopPropagation()
          implementation.disable()
        }
      },
      [implementation, resetSearch]
    )

    const searchInputFocus = useCallback(() => {
      scheduleFocusRaf(() => searchInputRef.current?.focus())
    }, [scheduleFocusRaf])

    const userOutlinedButtonOnClick = useCallback(() => {
      onIncludeUserChange?.(!includeUser)
      searchInputFocus()
    }, [includeUser, onIncludeUserChange, searchInputFocus])

    useImperativeHandle(ref, () => implementation, [implementation])

    useEffect(() => {
      if (initialText && initialText.trim().length > 0 && searchInputRef.current) {
        if (!isParentOwned) setEnableContentSearch(true)
        const inputEl = searchInputRef.current
        inputEl.value = initialText
        scheduleSearchRaf(() => {
          if (!searchInputRef.current) return
          inputEl.focus()
          inputEl.select()
          search(false)
        })
      } else if (isParentOwned) {
        scheduleFocusRaf(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        })
      }
      // Only on mount — initialText is the mount-time queue.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Unmount-only cleanup for highlights and RAFs — separated from dependency-driven debounce cleanup to preserve focus after navigation
    // B-08 owner protocol: capture stable owner ID and release only if currently owning diagnostic snapshot
    const ownerIdAtUnmountRef = useRef(ownerIdRef.current)
    useEffect(() => {
      return () => {
        safeClearHighlights()
        rafIdsRef.current.forEach((id) => cancelAnimationFrame(id))
        rafIdsRef.current = []
        pendingSearchRafIdsRef.current.forEach((id) => cancelAnimationFrame(id))
        pendingSearchRafIdsRef.current = []
        // B-08 diagnostics: release only if this instance owns the active snapshot
        releaseContentSearchSessionIfOwned(ownerIdAtUnmountRef.current)
      }
    }, [])

    useEffect(() => {
      locateByIndex()
    }, [globalIndex, chunkIndex, liveVersion, locateByIndex])

    useEffect(() => {
      if (enableContentSearch && searchInputRef.current?.value.trim()) {
        search(true)
      }
    }, [isCaseSensitive, isWholeWord, enableContentSearch, search])

    const prevButtonOnClick = () => {
      implementation.searchPrev()
      searchInputFocus()
    }

    const nextButtonOnClick = () => {
      implementation.searchNext()
      searchInputFocus()
    }

    const closeButtonOnClick = () => {
      implementation.disable()
    }

    const caseSensitiveButtonOnClick = () => {
      setIsCaseSensitive(!isCaseSensitive)
      searchInputFocus()
    }

    const wholeWordButtonOnClick = () => {
      setIsWholeWord(!isWholeWord)
      searchInputFocus()
    }

    return (
      <Container
        ref={containerRef}
        data-testid="content-search-host"
        data-live-ranges={liveRangesRef.current.length}
        data-dom-generation={domGenerationRef.current}
        style={isParentOwned ? undefined : enableContentSearch ? {} : { display: 'none' }}
        $overlayPosition={positionMode === 'absolute' ? 'absolute' : 'static'}>
        <div style={{ width: '100%' }}>
          <SearchBarContainer $position={positionMode} data-testid="content-search">
            <InputWrapper>
              <Input
                ref={searchInputRef}
                onInput={userInputHandler}
                onKeyDown={keyDownHandler}
                placeholder={t('chat.assistant.search.placeholder')}
                style={{ lineHeight: '20px' }}
              />
              <ToolBar>
                {showUserToggle && (
                  <Tooltip title={t('button.includes_user_questions')} mouseEnterDelay={0.8} placement="bottom">
                    <ActionIconButton onClick={userOutlinedButtonOnClick}>
                      <User size={18} style={{ color: includeUser ? 'var(--color-link)' : 'var(--color-icon)' }} />
                    </ActionIconButton>
                  </Tooltip>
                )}
                <Tooltip title={t('button.case_sensitive')} mouseEnterDelay={0.8} placement="bottom">
                  <ActionIconButton onClick={caseSensitiveButtonOnClick}>
                    <CaseSensitive
                      size={18}
                      style={{ color: isCaseSensitive ? 'var(--color-link)' : 'var(--color-icon)' }}
                    />
                  </ActionIconButton>
                </Tooltip>
                <Tooltip title={t('button.whole_word')} mouseEnterDelay={0.8} placement="bottom">
                  <ActionIconButton onClick={wholeWordButtonOnClick}>
                    <WholeWord size={18} style={{ color: isWholeWord ? 'var(--color-link)' : 'var(--color-icon)' }} />
                  </ActionIconButton>
                </Tooltip>
              </ToolBar>
            </InputWrapper>
            <Separator></Separator>
            <SearchResults>
              {searchCompleted !== SearchCompletedState.NotSearched && totalCount > 0 ? (
                <>
                  <SearchResultCount>{globalIndex + 1}</SearchResultCount>
                  <SearchResultSeparator>/</SearchResultSeparator>
                  <SearchResultTotalCount>{totalCount}</SearchResultTotalCount>
                </>
              ) : (
                <SearchResultsPlaceholder>0/0</SearchResultsPlaceholder>
              )}
            </SearchResults>
            <ToolBar>
              <ActionIconButton onClick={prevButtonOnClick} disabled={totalCount === 0}>
                <ChevronUp size={18} />
              </ActionIconButton>
              <ActionIconButton onClick={nextButtonOnClick} disabled={totalCount === 0}>
                <ChevronDown size={18} />
              </ActionIconButton>
              <ActionIconButton onClick={closeButtonOnClick}>
                <X size={18} />
              </ActionIconButton>
            </ToolBar>
          </SearchBarContainer>
        </div>
        <Placeholder />
      </Container>
    )
  }
)

ContentSearch.displayName = 'ContentSearch'

const Container = styled.div<{ $overlayPosition: 'static' | 'absolute' }>`
  display: flex;
  flex-direction: row;
  position: ${({ $overlayPosition }) => $overlayPosition};
  top: ${({ $overlayPosition }) => ($overlayPosition === 'absolute' ? '0' : 'auto')};
  left: ${({ $overlayPosition }) => ($overlayPosition === 'absolute' ? '0' : 'auto')};
  right: ${({ $overlayPosition }) => ($overlayPosition === 'absolute' ? '0' : 'auto')};
  z-index: 999;
`

const SearchBarContainer = styled.div<{ $position: 'fixed' | 'absolute' | 'sticky' }>`
  border: 1px solid var(--color-primary);
  border-radius: 10px;
  transition: all 0.2s ease;
  position: ${({ $position }) => $position};
  top: 15px;
  left: 20px;
  right: 20px;
  margin-bottom: 5px;
  padding: 5px 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--color-background);
  flex: 1 1 auto; /* Take up input's previous space */
`

const Placeholder = styled.div`
  width: 5px;
`

const InputWrapper = styled.div`
  display: flex;
  align-items: center;
  flex: 1 1 auto; /* Take up input's previous space */
`

const Input = styled.input`
  border: none;
  color: var(--color-text);
  background-color: transparent;
  outline: none;
  width: 100%;
  padding: 0 5px; /* Adjust padding, wrapper will handle spacing */
  flex: 1; /* Allow input to grow */
  font-size: 14px;
  font-family: Ubuntu;
`

const ToolBar = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: tpx;
`

const Separator = styled.div`
  width: 1px;
  height: 1.5em;
  background-color: var(--color-border);
  margin-left: 2px;
  margin-right: 2px;
  flex: 0 0 auto;
`

const SearchResults = styled.div`
  display: flex;
  justify-content: center;
  width: 80px;
  margin: 0 2px;
  flex: 0 0 auto;
  color: var(--color-text-1);
  font-size: 14px;
  font-family: Ubuntu;
`

const SearchResultsPlaceholder = styled.span`
  color: var(--color-text-1);
  opacity: 0.5;
`

const SearchResultCount = styled.span`
  color: var(--color-text);
`

const SearchResultSeparator = styled.span`
  color: var(--color-text);
  margin: 0 4px;
`

const SearchResultTotalCount = styled.span`
  color: var(--color-text);
`
