import Scrollbar from '@renderer/components/Scrollbar'
import styled from 'styled-components'

import { COMPOSER_FLOATING_CONTROL_BAND_PX } from './composerFloatingBand'

/**
 * Scroll content host.
 *
 * Normal document flow (`flex-direction: column`): the first child paints at
 * the visual top, so the flow's own DOM order is its visual order — oldest
 * message first, newest last. Content order is owned by the flow builder, never
 * by a reversed flex direction.
 *
 * The bottom padding is the flow's tail clearance, not a cosmetic inset: the
 * floating composer overlay paints over the last rows of this content (the
 * composer lives in its own overlay plane now, no longer in flow), and the
 * control band paints over the tail too. Reserving the measured composer
 * height plus exactly that band keeps the tail — including the out-of-flow
 * folded group label — inside the real scrollport instead of underneath the
 * overlay. Both numbers come from the shared geometry modules
 * (`composerOverlayGeometry` / `composerFloatingBand`), never from a second
 * hand-tuned number.
 */
export const ScrollContainer = styled.div`
  display: flex;
  flex-direction: column;
  // Top safe area: the overlay titlebar paints no flow height, so the flow
  // clears the band plus the fade tail from inside, both derived from the
  // --chat-band published on #chat-main (fullscreen-aware). Sides/tail
  // unchanged (FoldedSection pins side 10px; tail is the floating composer
  // overlay height plus the existing control band, published as
  // --composer-tail-inset on the chat canvas; the fallback is the band alone
  // so the trigger strip is always reserved, never double-counted).
  padding: calc(var(--chat-band, var(--navbar-height)) + 24px) 10px var(--composer-tail-inset, ${COMPOSER_FLOATING_CONTROL_BAND_PX}px);
  .multi-select-mode & {
    padding-bottom: max(60px, var(--composer-tail-inset, ${COMPOSER_FLOATING_CONTROL_BAND_PX}px));
  }
`

interface ContainerProps {
  $right?: boolean
}

export const MessagesWrapper = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

export const MessagesContainer = styled(Scrollbar)<ContainerProps>`
   // Reading-column container for container queries: the user-bubble width
   // cap keys off this scrollport's own inline size (the ACTUAL available
   // body width after sidebars), never a window breakpoint. House convention
   // follows the navbar column (containerType inline-size + cqw/%).
   container-type: inline-size;
   display: flex;
  flex-direction: column;
  overflow-x: hidden;
  // Single scroll owner (#messages): the route viewport keeper owns all
  // compensation on this host (bottom pin + region holds). Browser scroll
  // anchoring would fight it during editor resize/entry/cancel (native
  // corrections vs keeper corrections read as bottom wobble and a release
  // snap), so it stays disabled here only — never on editor, notes, history,
  // or other native scrollers.
  overflow-anchor: none;
  // The host takes the available wrapper height (flex:1 forces the full fill)
  // and owns the overflow. In normal flow that is exactly what keeps the scroll
  // geometry honest: the scrollport height is the visible height. Short content
  // starts at the top of the port with the flow's ordinary margins (the content
  // wrapper carries no auto block-start margin), so a new conversation's first
  // content is not dropped to the bottom of an empty port, and the leftover
  // space belongs to the scrollport (below the flow) rather than being scrolled.
  flex: 1 1 auto;
  min-height: 0;
  // Anchor/scroll-to-top targets clear the overlay band instead of sliding
  // under it; always navbar-height (>= band on every platform).
  scroll-padding-top: var(--navbar-height);
  // Bottom anchor targets clear the floating composer overlay: same single
  // source as the tail padding above (measured composer + band).
  scroll-padding-bottom: var(--composer-tail-inset, ${COMPOSER_FLOATING_CONTROL_BAND_PX}px);
  // Local layer contract: this scroll host stays position:relative WITHOUT
  // its own z-index so it never traps descendants in a stacking context.
  // Sibling overlays (BackToBottom z6, EditModeActionBar z10) still paint
  // above via their explicit z; the segment label carries its own explicit
  // z above conversation navigation (nav 999) while ordinary message
  // bodies (z auto) stay below it. Adding any z-index here would recap the
  // label and drop it back under the nav.
  position: relative;
  // Atomic route transition: while the target window is positioning, the
  // container stays hidden but measurable (visibility keeps layout so the
  // first scroll can be applied pre-paint; never display:none).
  &[data-viewport-phase='positioning'] {
    visibility: hidden;
  }
`
