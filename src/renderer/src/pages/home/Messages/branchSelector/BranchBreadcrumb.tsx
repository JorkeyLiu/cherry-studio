import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import styled from 'styled-components'

import { chooseCrumbEntries, type CrumbEntry } from './branchTreeModel'

/**
 * Branch route breadcrumb.
 *
 * The path is the logical topic followed by the branch chain of the viewed
 * route. Every segment — the current route included — is its own navigation
 * target: clicking one switches to that route (the current one only closes the
 * selector). The breadcrumb never opens the branch tree; that is the job of the
 * separate branch button that sits next to it.
 *
 * Two boxes, two jobs:
 *
 * - the slot is the flex item between the branch entry and the tool group, so
 *   the path gets every pixel the row does not need elsewhere (no arbitrary cap
 *   of its own);
 * - the plate inside it hugs the path — dark, rounded, thin bordered — and the
 *   current segment keeps its translucent green chip. Measuring the slot (never
 *   the plate) is what keeps the omission decision and the plate's own width
 *   from feeding back into each other.
 *
 * When the full path does not fit, whole middle segments are hidden
 * oldest-first (the most recent ancestors survive) and a single `…` marks the
 * hidden run: the first and the current segment always stay, separators exist
 * only between two visible segments, and a segment that is too wide on its own
 * ellipsizes in place.
 *
 * Widths come from an offscreen measure layer (real text, real font, the same
 * per-segment cap as the rendered chip), so the omission decision matches what
 * is rendered; the decision itself is the pure `chooseCrumbEntries`.
 */

export type BranchCrumbSegment = {
  /** Branch id of the segment, null for the topic (main route) segment. */
  branchId: string | null
  label: string
}

interface BranchBreadcrumbProps {
  /** Full path, root first; the last entry is the current route. */
  segments: BranchCrumbSegment[]
  /** Full path, used as the crumb's title and accessible name. */
  fullLabel: string
  /** Test id of a segment button. */
  segmentTestId: (branchId: string | null) => string
  onSelect: (branchId: string | null) => void
}

/** Room the plate itself consumes: 6px inset on both sides plus its 1px border. */
const CRUMB_CHROME_WIDTH = 14
/** Per-segment cap, mirrored by the measure layer so measurement matches rendering. */
const SEGMENT_MAX_WIDTH = 140
const CURRENT_MAX_WIDTH = 180

export const BranchBreadcrumb = ({ segments, fullLabel, segmentTestId, onSelect }: BranchBreadcrumbProps) => {
  const slotRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [entries, setEntries] = useState<CrumbEntry[]>([])
  const [fontTick, setFontTick] = useState(0)

  // Re-measure once webfonts settle: CJK metrics change segment widths.
  useEffect(() => {
    const ready = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready
    if (!ready || typeof ready.then !== 'function') return
    let cancelled = false
    void ready.then(() => {
      if (!cancelled) setFontTick((tick) => tick + 1)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const layout = useCallback((): void => {
    const slot = slotRef.current
    const measure = measureRef.current
    if (!slot || !measure) return
    const widths: number[] = []
    let separatorWidth = 6
    let gapWidth = 12
    for (const child of Array.from(measure.children) as HTMLElement[]) {
      const width = child.getBoundingClientRect().width
      const kind = child.dataset.kind
      if (kind === 'segment') widths[Number(child.dataset.index)] = width
      else if (kind === 'separator') separatorWidth = width
      else if (kind === 'gap') gapWidth = width
    }
    const next = chooseCrumbEntries({
      segmentCount: segments.length,
      segmentWidths: widths,
      separatorWidth,
      gapWidth,
      availableWidth: slot.getBoundingClientRect().width - CRUMB_CHROME_WIDTH
    })
    setEntries((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
  }, [segments.length])

  useLayoutEffect(() => {
    layout()
  }, [layout, fullLabel, fontTick])

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => layout())
    observer.observe(slot)
    return () => observer.disconnect()
  }, [layout])

  const currentIndex = segments.length - 1
  const rendered = entries.length > 0 ? entries : segments.map((_, index) => ({ kind: 'segment' as const, index }))

  return (
    <Slot ref={slotRef} data-testid="branch-crumb-slot">
      <Plate>
        <nav data-testid="branch-selector-breadcrumb" title={fullLabel} aria-label={fullLabel}>
          <List>
            {rendered.map((entry, position) => {
              const separator = position > 0 ? <Separator aria-hidden="true">/</Separator> : null
              if (entry.kind === 'gap') {
                return (
                  <Fragment key={`gap-${position}`}>
                    {separator}
                    <Gap aria-hidden="true">…</Gap>
                  </Fragment>
                )
              }
              const segment = segments[entry.index]
              if (!segment) return null
              const isCurrent = entry.index === currentIndex
              return (
                <Fragment key={`segment-${entry.index}`}>
                  {separator}
                  <Segment
                    type="button"
                    data-testid={segmentTestId(segment.branchId)}
                    data-current={isCurrent ? 'true' : undefined}
                    aria-current={isCurrent ? 'true' : undefined}
                    title={segment.label}
                    onClick={(event) => {
                      event.stopPropagation()
                      onSelect(segment.branchId)
                    }}>
                    {segment.label}
                  </Segment>
                </Fragment>
              )
            })}
          </List>
        </nav>
        {/* Offscreen measure layer: real text metrics, never part of the flow. */}
        <Measure ref={measureRef} aria-hidden="true">
          {segments.map((segment, index) => (
            <span
              key={`measure-${segment.branchId ?? 'main'}-${index}`}
              data-kind="segment"
              data-index={index}
              data-current={index === currentIndex ? 'true' : undefined}>
              {segment.label}
            </span>
          ))}
          <span data-kind="separator">/</span>
          <span data-kind="gap">…</span>
        </Measure>
      </Plate>
    </Slot>
  )
}

/**
 * The flex item: it takes whatever the row has left between the branch entry
 * and the tool group, so the path is never squeezed to an arbitrary width. It
 * has no visual identity of its own.
 */
const Slot = styled.div`
  display: flex;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
`

/**
 * The accepted navigation base: the whole path in one dark, rounded, thinly
 * bordered plate that hugs its content (so a short path is a short plate) and
 * never exceeds the slot.
 */
const Plate = styled.div`
  display: flex;
  align-items: center;
  box-sizing: border-box;
  width: max-content;
  max-width: 100%;
  height: 26px;
  min-width: 0;
  padding: 0 6px;
  border: 1px solid var(--color-border-soft);
  border-left: 0;
  border-radius: 0 8px 8px 0;
  background: var(--color-background-soft);
  overflow: hidden;
`

const List = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
`

const Segment = styled.button`
  flex: none;
  max-width: ${SEGMENT_MAX_WIDTH}px;
  min-width: 0;
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--color-text-2);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;

  &:hover {
    background: var(--color-hover);
    color: var(--color-text-1);
  }

  &[data-current='true'] {
    flex: 0 1 auto;
    max-width: ${CURRENT_MAX_WIDTH}px;
    color: var(--color-text-1);
    font-weight: 600;
  }
`

/**
 * The separator owns its own side spacing instead of a flex gap, so the
 * omission math stays "one measured separator width" per visible boundary:
 * the measured span below carries the same padding, and the crumb keeps a
 * comfortable distance to the chip on either side.
 */
const Separator = styled.span`
  flex: none;
  padding: 0 4px;
  color: var(--color-text-3);
  font-size: 11px;
  line-height: 1;
  user-select: none;
`

const Gap = styled.span`
  flex: none;
  padding: 2px 2px;
  color: var(--color-text-3);
  font-size: 12px;
  line-height: 1.5;
  user-select: none;
`

/**
 * The measure layer mirrors the rendered chip box model (border-box, same
 * padding, same per-segment cap), so a clamped chip measures as the width it
 * really paints instead of its full label width.
 */
const Measure = styled.div`
  position: fixed;
  left: -10000px;
  top: 0;
  visibility: hidden;
  pointer-events: none;
  overflow: visible;
  white-space: nowrap;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;

  & > span {
    display: inline-block;
    box-sizing: border-box;
    padding: 2px 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: ${SEGMENT_MAX_WIDTH}px;
  }

  & > span[data-current='true'] {
    max-width: ${CURRENT_MAX_WIDTH}px;
    font-weight: 600;
  }

  & > span[data-kind='separator'] {
    padding: 0 4px;
    font-size: 11px;
  }

  & > span[data-kind='gap'] {
    padding: 2px 2px;
  }
`
