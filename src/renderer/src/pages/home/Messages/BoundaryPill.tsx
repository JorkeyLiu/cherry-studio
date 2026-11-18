import { Button } from 'antd'
import styled from 'styled-components'

/**
 * Shared presentation for the weak in-flow boundaries of the message flow:
 * the topic-internal fork divider and the cross-topic history-reference
 * divider.
 *
 * A weak boundary is a compact, neutral, centered pill. Same-owner rows (an
 * untaken fork) paint no through-rule. Cross-owner rows (a taken fork, a
 * history reference — actual owner compares (topicId, branchId)) paint one
 * themed dashed rule on EACH side of the centered pill; the dash uses the
 * theme border token so the strong context-window rule stays distinct and
 * untouched. The shared row keeps the previous divider box model
 * (`8px 16px` padding, `4px 0` margin, and the family's own `36px`
 * min-height), so the existing flow-row identity, the `data-divider-*` /
 * `data-reference-*` anchors and the pixel measurements taken of those rows
 * stay stable.
 *
 * Both families render the SAME `BoundaryPill` surface. The interactive
 * family only wraps it in a transparent button shell, so an interactive and a
 * non-interactive boundary are visually identical: hover and keyboard focus
 * change the wash and add a focus ring, never the box.
 */

/**
 * The one visual surface of a weak boundary (static or interactive).
 *
 * Width is bounded, never fixed: `max-width: 100%` is the row's content width
 * and `min-width: 0` lets the surface shrink inside the row instead of pushing
 * past it, so a long source/branch name can never overflow the message column.
 * The label is the only part that gives way (`overflow`/`ellipsis`); an icon
 * keeps its own box.
 */
export const BoundaryPill = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  min-height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--color-background-mute);
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;

  /* An icon is never the part that shrinks or disappears. */
  > svg {
    flex: none;
  }

  /* The label is the only shrinkable, ellipsizing part of the pill. */
  > [data-boundary-label] {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`

/**
 * The two themed dashed through-rules of a cross-owner boundary.
 *
 * One rule paints on EACH side of the centered pill. Same-owner rows render
 * no rule. The dash is the theme border token, so it never competes with the
 * strong context-window rule.
 */
export const BoundaryRule = styled.div`
  flex: 1 1 24px;
  height: 0;
  border-top: 1px dashed var(--color-border);
`

/**
 * The pill's only shrinkable part; the shared surface ellipsizes it.
 * Exported so every weak-boundary family clamps long names the same way.
 */
export const BoundaryLabel = styled.span`
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`

/**
 * Flow row of a weak boundary: centered. Cross-owner rows include two
 * `BoundaryRule` siblings around the pill; same-owner rows render the pill
 * alone with no rule. The family adds its own `min-height` so each divider
 * keeps its previously declared box exactly.
 */
export const BoundaryRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 4px 0;
`

/**
 * Interactive shell. The pill is the only visible part, so the button itself
 * stays transparent; hover/focus/active are stated explicitly on the pill and
 * beat antd's text-button plate by specificity (the same `&&:not(...)` shape
 * the shared composer icon button uses). The shell adds no box of its own, so
 * an interactive boundary and a static one occupy identical geometry.
 */
export const BoundaryPillButton = styled(Button)`
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  /* Shrink inside the row instead of pushing past it: the pill is the boundary. */
  min-width: 0;
  max-width: 100%;
  height: auto;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  box-shadow: none;
  color: inherit;
  cursor: pointer;

  > ${BoundaryPill} {
    min-width: 0;
    max-width: 100%;
  }
  &&:not(:disabled):not(.ant-btn-disabled),
  &&:not(:disabled):not(.ant-btn-disabled):hover,
  &&:not(:disabled):not(.ant-btn-disabled):active {
    background: transparent;
    color: inherit;
  }

  &&:not(:disabled):not(.ant-btn-disabled):hover > ${BoundaryPill},
  &&:not(:disabled):not(.ant-btn-disabled):active > ${BoundaryPill} {
    background: var(--color-hover);
    color: var(--color-text-1);
  }

  /* Keyboard hit is unmistakable without a permanent block. */
  &&:not(:disabled):not(.ant-btn-disabled):focus-visible {
    outline: none;
  }

  &&:not(:disabled):not(.ant-btn-disabled):focus-visible > ${BoundaryPill} {
    background: var(--color-hover);
    color: var(--color-text-1);
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
`
