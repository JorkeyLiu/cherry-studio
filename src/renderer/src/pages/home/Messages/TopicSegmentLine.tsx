import { loggerService } from '@logger'
import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import { useAppSelector } from '@renderer/store'
import { isSegmentFoldableThroughRoute, selectRouteCapability } from '@renderer/store/routeAnswerGroup'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import { Input, Popconfirm } from 'antd'
import { Pencil, Trash2 } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import {
  INTERACTION_REGION_SEGMENT_HEADER,
  markInteractionLayoutDeferred,
  settleInteractionLayoutDeferred,
  useOptionalRouteViewportCommands
} from './routeViewportContext'

const logger = loggerService.withContext('TopicSegmentLine')

/**
 * Fixed horizontal slot a collapsed label occupies when several collapsed
 * labels land on the same seam (consecutive zero-height runs). Cascading by a
 * fixed slot (rather than each label's own width) guarantees neighbouring
 * labels never overlap for arbitrary label widths, and the collapsed pill is
 * capped to the slot so a long name can never reach the next label.
 */
const COLLAPSED_LABEL_SLOT_PX = 148

interface TopicSegmentLineProps {
  segment: TopicSegment
  isFirst: boolean
  isLast: boolean
  messageCount?: number
  /**
   * This turn run paints the group's single chrome header host (left rule, fold
   * target, label). A group split across several runs (divider, differing turn
   * id, viewport-partial membership) yields several runs that all carry the
   * owning group; the flow composition elects exactly one of them, and the
   * others paint only a rule-only continuation track (or nothing when the
   * group is collapsed). Defaults to true for standalone renders.
   */
  ownsLabel?: boolean
  /**
   * Cascade slot among coincident collapsed labels (0 = the seam position).
   * Consecutive fully collapsed runs all have zero flow height and therefore
   * share one seam; horizontal cascade keeps each label identifiable without
   * adding a single pixel of row height.
   */
  stackIndex?: number
}

/**
 * Topic segment chrome: the vertical rule that owns the group's extent plus the
 * group label pill.
 *
 * Two presentation states, one entity (no separate collapse entity, no extra
 * entry point):
 * - Expanded (default): the name is the rename target and the left rule is the
 *   collapse target (its transparent hit area is the rule itself plus a few
 *   gutter pixels — the header pill's clickable object is not widened).
 * - Folded (`segment.folded`): no rule; the pill keeps the existing label
 *   shape/layout with a neutral tint, no colored dot, the group name hidden
 *   (persisted, shown in the hover hint) and the authority count kept. The
 *   former name object becomes the expand target; the count never gains a
 *   click behavior. Hover-only rename/dissolve actions are not offered while
 *   folded.
 *
 * Height contract: the chrome host is absolutely positioned in both states, so
 * it contributes no row height, no padding, no min-height and no margin to the
 * message flow. A fully collapsed group leaves its turn run at zero height and
 * the label paints at that seam (the same overlap character as the expanded
 * header over its own group's first row) instead of opening a blank band
 * between neighbouring messages.
 *
 * Folding is presentation-only state: membership, identity, order and the
 * context-window origin are untouched — expanding restores participation.
 */
const TopicSegmentLine: React.FC<TopicSegmentLineProps> = ({
  segment,
  isFirst,
  isLast,
  messageCount,
  ownsLabel = true,
  stackIndex = 0
}) => {
  const { t } = useTranslation()
  const { updateSegmentName, deleteSegment, setSegmentFolded } = useTopicSegments(segment.topicId)

  // Same-route in-place fold/expand geometry: the group header chrome IS the
  // visual anchor (the group body — never the header — is what enters or leaves
  // the flow at this seam), so the shared viewport owner holds that region
  // stationary and the content below absorbs the height delta. The hook is
  // optional so standalone renders (tests, chrome previews) keep working with
  // no viewport owner; the write path below then simply has no compensation
  // arbiter to talk to.
  const viewportCommands = useOptionalRouteViewportCommands()

  // Owner-only write: a group whose fold cannot be authorized through the
  // active route renders read-only (label stays visible, the fold/expand write
  // is not offered) while Main re-verifies the whole membership atomically.
  const routeCapability = useAppSelector((state) => selectRouteCapability(state, segment.topicId))
  const canFold = useMemo(
    () => isSegmentFoldableThroughRoute(routeCapability, segment.topicId, segment.messageIds ?? []),
    [routeCapability, segment.topicId, segment.messageIds]
  )
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(segment.name)
  const color = segment.color || getSegmentColor(segment.id)
  const isFolded = segment.folded === true
  // A folded group is a whole: its label always shows the authority membership
  // size, even when the authority first message lies outside the mounted
  // window (or is fully hidden by the fold).
  const badgeCount = isFolded ? segment.messageCount : messageCount
  // One header host per group: inside the elected header run the expanded label
  // sits on the group's own first message, while a collapsed group always
  // paints its single seam label (the header run is elected for that).
  const showsLabel = isFirst || isFolded

  const handleRename = useCallback(async () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== segment.name) {
      await updateSegmentName(segment.id, trimmed)
    } else {
      // Cancel path (empty/unchanged): restore the authoritative name so a
      // stray blur never leaves a blank draft in the pill.
      setEditName(segment.name)
    }
    setIsEditing(false)
  }, [editName, segment, updateSegmentName])

  const handleDissolve = useCallback(async () => {
    await deleteSegment(segment.id)
  }, [segment.id, deleteSegment])

  const handleStartEdit = useCallback(() => {
    setEditName(segment.name)
    setIsEditing(true)
  }, [segment.name])

  // Row navigation must never fire from label interactions: the label sits
  // inside the turn wrapper whose click capture selects the turn in edit
  // mode. Controls and the label pill stop propagation; row navigation is
  // a drawer/nav concern, never a turn-click side effect.
  const stopRowNavigation = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
  }, [])

  // Escape cancels the label rename back to the authoritative name.
  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setEditName(segment.name)
        setIsEditing(false)
      }
    },
    [segment.name]
  )

  // Fold/expand is a same-route in-place geometry change, so it goes through
  // the ONE shared viewport arbiter instead of any per-control scroll write:
  // - The click boundary already armed the shared interaction intent for this
  //   group's `segment-header` region (the chrome host carries both the region
  //   annotation and the owning run's structural scope). The keeper then holds
  //   the HEADER at its captured baseline, so the header and everything above
  //   it stay put while the height delta moves the content below.
  // - The persisted fold state is DB-first (`setSegmentFolded` awaits the
  //   authority round-trip and only then converges Redux), so the rows land
  //   AFTER the click. Declaring the gesture's layout effect deferred keeps it
  //   armed through that gap (an unchanged DOM mid-flight is not a no-effect
  //   click) without any optimistic UI write, timer or second scroll owner.
  // - Nothing here pins or pads the scroll position: at the newest edge the
  //   natural clamp wins and no artificial blank is introduced.
  const runFoldWrite = useCallback(
    async (folded: boolean) => {
      const controller = viewportCommands?.controller
      const deferred = markInteractionLayoutDeferred(
        controller,
        { kind: 'group', id: segment.id },
        INTERACTION_REGION_SEGMENT_HEADER
      )
      let applied = false
      try {
        await setSegmentFolded(segment.id, folded)
        applied = true
      } catch (error) {
        // Privacy-safe: the folded flag is stable identity, never content; a
        // non-Error rejection is logged as its own message text.
        logger.error(
          folded ? 'Failed to fold segment' : 'Failed to expand segment',
          error instanceof Error ? error : { reason: String(error) }
        )
      } finally {
        // `failed` drops the gesture fail-closed (no adopt, no snapshot); a
        // stale token never touches a newer gesture.
        settleInteractionLayoutDeferred(controller, deferred, applied ? 'applied' : 'failed')
      }
    },
    [segment.id, setSegmentFolded, viewportCommands]
  )

  const handleCollapse = useCallback(() => {
    void runFoldWrite(true)
  }, [runFoldWrite])

  const handleExpand = useCallback(() => {
    if (!isFolded) return
    void runFoldWrite(false)
  }, [isFolded, runFoldWrite])

  // Exactly one chrome header host per group: the flow composition elects a
  // single carrying run per segment, so a group split across several turn runs
  // (divider, differing turn id, viewport-partial membership) paints one rule,
  // one label and one fold target. The remaining carrying runs keep the
  // vertical line continuous through a rule-only continuation track — never a
  // second header host.
  if (!ownsLabel) {
    // A collapsed group paints no rule at all, so its remaining runs
    // contribute nothing: zero flow height, no duplicate seam label.
    if (isFolded) return null
    return (
      <ContinuationTrack>
        <Line
          $isFirst={isFirst}
          $isLast={isLast}
          $color={color}
          data-testid="topic-segment-rule-continuation"
          data-segment-continuation-id={segment.id}
        />
      </ContinuationTrack>
    )
  }

  // The chrome host IS the region for this gesture: it exists in both
  // presentation states at the seam the group body opens and closes around, so
  // re-resolution after the mutation finds the same structural anchor (the
  // label pill and the seam, never the clicked button node).
  return (
    <LineContainer
      data-testid="topic-segment-line"
      data-segment-id={segment.id}
      data-segment-folded={isFolded ? 'true' : 'false'}
      data-interaction-region={INTERACTION_REGION_SEGMENT_HEADER}>
      {/* 竖线（折叠态无左侧边线） */}
      {!isFolded && <Line $isFirst={isFirst} $isLast={isLast} $color={color} data-testid="topic-segment-rule" />}

      {/* 仅左侧边线可折叠：命中热区覆盖边线本身 + 相邻 4px 沟槽，绝不覆盖组头标签。
          继承/只读组不提供该写入入口（主线规则仍在，写入由 Main 再次校验）。 */}
      {!isFolded && canFold && (
        <LineHitTarget
          type="button"
          $isFirst={isFirst}
          $isLast={isLast}
          onClick={handleCollapse}
          title={t('topicSegment.fold')}
          aria-label={t('topicSegment.fold')}
          data-testid="topic-segment-fold"
        />
      )}

      {/* 组头标签：展开态在段首消息处；折叠态由唯一拥有该组的 run 渲染 */}
      {showsLabel && (
        <TabContainer
          $color={color}
          $folded={isFolded}
          $stackIndex={stackIndex}
          onClick={stopRowNavigation}
          data-testid="topic-segment-label"
          data-segment-folded={isFolded ? 'true' : 'false'}
          data-segment-cascade={stackIndex}>
          <TabContent>
            {!isFolded && <ColorDot $color={color} />}
            {isFolded ? (
              <TabNameFolded
                onClick={canFold ? handleExpand : undefined}
                aria-disabled={canFold ? undefined : true}
                $readOnly={!canFold}
                title={`${segment.name} · ${t('topicSegment.foldedHint')}`}
                data-testid="topic-segment-expand">
                {t('topicSegment.folded')}
              </TabNameFolded>
            ) : isEditing ? (
              <TabInput
                size="small"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onPressEnter={handleRename}
                onBlur={handleRename}
                onKeyDown={handleEditKeyDown}
                onClick={stopRowNavigation}
                autoFocus
              />
            ) : (
              <TabName onClick={handleStartEdit} title={segment.name}>
                {segment.name}
              </TabName>
            )}
            {badgeCount !== undefined && (
              <TabCount data-testid="topic-segment-count">
                {t('topicSegment.messages.count', { count: badgeCount })}
              </TabCount>
            )}
          </TabContent>
          {/* 折叠态不提供悬浮的重命名/解散动作 */}
          {!isFolded && (
            <TabActions data-testid="topic-segment-actions">
              <TabActionBtn
                type="button"
                onClick={handleStartEdit}
                title={t('topicSegment.rename')}
                aria-label={t('topicSegment.rename')}>
                <Pencil size={12} />
              </TabActionBtn>
              <Popconfirm
                title={t('topicSegment.dissolve.confirm')}
                onConfirm={handleDissolve}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}>
                <TabActionBtn
                  type="button"
                  title={t('topicSegment.dissolveAction')}
                  aria-label={t('topicSegment.dissolveAction')}
                  onClick={stopRowNavigation}>
                  <Trash2 size={12} />
                </TabActionBtn>
              </Popconfirm>
            </TabActions>
          )}
        </TabContainer>
      )}
    </LineContainer>
  )
}

// ─── Styled Components ───

const LineContainer = styled.div`
  // Same host geometry in both states: an absolutely positioned track that
  // contributes NOTHING to the message flow (no row height, no padding, no
  // min-height, no margin). Expanded paints the vertical rule inside it; folded
  // paints only the label at the seam, so a collapsed group never opens a blank
  // band between neighbouring messages and the height delta belongs entirely to
  // the message flow below the seam.
  position: absolute;
  left: -12px;
  top: 0;
  bottom: 0;
  width: 4px;
  // Local layer contract with conversation navigation: the Chat host that
  // stacks Messages vs nav is a positioned (relative, z-auto) flex row, so
  // sibling paint order follows this explicit z. The nav body paints at
  // z999; the segment group label sits above it (z1000) while staying below
  // antd portal overlays (popover ~1030) and ordinary message bodies
  // (z auto) sit below it. Geometric hit
  // containment (LineContainer pointer-events:none, only TabContainer auto,
  // tab isolated) keeps label hover from entering the nav body — no nav
  // expansion from label hover, nav still expands in its own trigger.
  z-index: 1000;
  pointer-events: none;
  // Isolate label paint so its hover never leaks into the nav hit path.
  // Out-of-flow paint must not be clipped: the label sits at the seam of a
  // zero-height run, so no overflow/contain clipping is allowed here.
  isolation: isolate;

  // Hover/focus feedback on the collapsibility of the left rule: the RULE
  // brightens only. No background band, no shadow, no glow — a hover must never
  // paint a color surface over the message column — and the color system itself
  // is untouched (brightness is the only filter; saturation is never shifted).
  // The label pill and its own rename/fold semantics stay untouched (no new
  // clickable object, no wider group-name target), and keyboard focus keeps the
  // existing focus-visible outline while getting the same rule brightening.
  &:has([data-testid='topic-segment-fold']:hover) [data-testid='topic-segment-rule'],
  &:has([data-testid='topic-segment-fold']:focus-visible) [data-testid='topic-segment-rule'] {
    filter: brightness(1.35);
  }
`

/**
 * Rule-only continuation host for a split group's non-header runs. It copies
 * the header host's out-of-flow geometry exactly (same column, same z, no
 * width/height/padding/margin contribution) so a group spanning several turn
 * runs keeps one continuous vertical line without a second header host, a
 * duplicate label, or a duplicate fold target. It carries its own data
 * attribute (never `topic-segment-line` / `data-segment-id`) so a group's
 * header resolves uniquely per segment.
 */
const ContinuationTrack = styled.div`
  position: absolute;
  left: -12px;
  top: 0;
  bottom: 0;
  width: 4px;
  z-index: 1000;
  pointer-events: none;
  isolation: isolate;
`

const Line = styled.div<{
  $isFirst: boolean
  $isLast: boolean
  $color: string
}>`
  position: absolute;
  left: 0;
  width: 4px;
  background-color: ${(props) => props.$color};
  top: ${(props) => (props.$isFirst ? '28px' : '0')};
  bottom: ${(props) => (props.$isLast ? '12px' : '0')};
  // Hover feedback is driven by the hit target (see LineContainer) via filter,
  // so the rule never gains a hit area or a rule of its own click semantics.
  transition: filter 0.15s ease;
`

/**
 * Transparent collapse target laid exactly over the left rule (4px) plus 4px of
 * adjacent gutter. It stays inside the chrome host's own column so it never
 * reaches the conversation-nav body, and it never covers the label pill (it
 * starts below the label's top offset).
 */
const LineHitTarget = styled.button<{ $isFirst: boolean; $isLast: boolean }>`
  position: absolute;
  left: 0;
  width: 8px;
  top: ${(props) => (props.$isFirst ? '28px' : '0')};
  bottom: ${(props) => (props.$isLast ? '12px' : '0')};
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  z-index: 1;

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  // Visible affordance of the collapsible gutter: the RULE brightens (the
  // LineContainer filter rule below, driven from this hit target). The 8px
  // target paints NOTHING on hover — no background band, no shadow, no glow —
  // so hover only sharpens the existing rule and never introduces a color
  // surface over the message column. Keyboard focus keeps its own outline
  // above; the target itself stays transparent in every state.
`

const TabContainer = styled.div<{ $color: string; $folded: boolean; $stackIndex: number }>`
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px 0 6px;
  // Folded: neutral, readable tint — no colored/purple group marker.
  background: ${(props) =>
    props.$folded
      ? 'var(--color-background-soft)'
      : `color-mix(in srgb, ${props.$color} 10%, var(--color-background))`};
  border: 1px solid
    ${(props) => (props.$folded ? 'var(--color-border)' : `color-mix(in srgb, ${props.$color} 22%, transparent)`)};
  border-radius: 4px 8px 8px 4px;
  pointer-events: auto;
  white-space: nowrap;
  max-width: ${(props) => (props.$folded ? `${COLLAPSED_LABEL_SLOT_PX - 4}px` : '280px')};
  // Coincident collapsed labels (consecutive zero-height runs share one seam)
  // cascade horizontally by a fixed slot: identifiable without any vertical
  // footprint, and the slot-capped width above keeps them from overlapping.
  transform: ${(props) => (props.$stackIndex > 0 ? `translateX(${props.$stackIndex * COLLAPSED_LABEL_SLOT_PX}px)` : 'none')};
  // Contained hit region: only this pill is interactive; the surrounding
  // LineContainer stays pointer-events:none so hover never leaks into the
  // conversation-nav body beside it.
  isolation: isolate;
`

const TabContent = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
`

const ColorDot = styled.span<{ $color: string }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${(props) => props.$color};
  flex-shrink: 0;
`

const TabName = styled.span`
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-1);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }
`

/**
 * Folded label word: the object that was the group name is the expand target.
 * Neutral readable text (no group color), same type metrics as the name so the
 * pill keeps its existing shape.
 */
const TabNameFolded = styled.span<{ $readOnly?: boolean }>`
  font-size: 12px;
  font-weight: 500;
  // Folded is a low-attention presentation state (the group is out of context):
  // the word is dimmed to the secondary/subtle text tone, same size/weight as
  // the name object it replaces. Pill size, count and the existing clickable
  // object are unchanged; hover only raises attention back one step.
  color: var(--color-text-3);
  cursor: ${(p) => (p.$readOnly ? 'default' : 'pointer')};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    color: ${(p) => (p.$readOnly ? 'var(--color-text-3)' : 'var(--color-text-2)')};
    text-decoration: ${(p) => (p.$readOnly ? 'none' : 'underline')};
  }
`

const TabInput = styled(Input)`
  &.ant-input-sm {
    height: 18px;
    font-size: 12px;
    padding: 0 4px;
    width: 120px;
  }
`

const TabCount = styled.span`
  font-size: 11px;
  color: var(--color-text-3);
  flex-shrink: 0;
`

const TabActions = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;

  ${TabContainer}:hover & {
    opacity: 1;
  }
`

const TabActionBtn = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  color: var(--color-text-3);
  transition: color 0.15s;

  &:hover {
    color: var(--color-text-1);
  }
`

export default memo(TopicSegmentLine)
