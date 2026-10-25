import Scrollbar from '@renderer/components/Scrollbar'
import styled from 'styled-components'

export const ScrollContainer = styled.div`
  display: flex;
  flex-direction: column-reverse;
  padding: 10px 10px 20px;
  .multi-select-mode & {
    padding-bottom: 60px;
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
  display: flex;
  flex-direction: column-reverse;
  overflow-x: hidden;
  // Single scroll owner (#messages): the route viewport keeper owns all
  // compensation on this host (column-reverse bottom pin + region holds).
  // Browser scroll anchoring would fight it during editor resize/entry/cancel
  // (native corrections vs keeper corrections read as bottom wobble and a
  // release snap), so it stays disabled here only — never on editor, notes,
  // history, or other native scrollers.
  overflow-anchor: none;
  // Short content sizes to content height instead of stretching the full
  // wrapper height (flex:1 forced full fill, pushing the column-reverse
  // content to the visual bottom and leaving blank above Prompt).
  // flex:0 1 auto keeps shrink-to-wrapper + own overflow-y:auto scroll
  // for long content. Wrapper stays the flex:1/min-height:0 height boundary.
  flex: 0 1 auto;
  min-height: 0;
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
