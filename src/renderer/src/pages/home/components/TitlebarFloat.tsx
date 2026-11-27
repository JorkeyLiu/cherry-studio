import { isLinux, isWin } from '@renderer/config/constant'
import styled, { css } from 'styled-components'

// Right clearance before the native window controls (mirrors
// NavbarMainContainer: Win 140, Linux 120, otherwise 12).
const rightClearance = isWin ? '140px' : isLinux ? '120px' : '12px'

// Positioning slot shared by both overlay-titlebar floats. It stretches the
// full overlay band (top:0;bottom:0) with content vertically centered — the
// same traffic-light row the sidebar collapse tool centers on — but carries
// NO plate of its own: transparent, borderless. The visible 26px plate
// lives one level inside (TitlebarChipRight, or the branch pill's own plate
// on the left). The slot declares neither pointer-events nor app-region:
// blank pixels belong to the titlebar drag root behind it and keep dragging
// the window. Only the hug-content chip/pill/button inside opts out with
// no-drag.
//
// Layering inside the overlay stacking context: the fade strip paints at
// z 1 (above the message flow, below the floats); both slots paint at
// z 10 so controls stay legible over the fade tail. Portaled antd layers
// (popover/drawer/modal attach to body) always paint above this context.
const slotBase = css`
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  z-index: 10;
  background: transparent;
  border: none;
`

// Hug-content plate for the titlebar control group: exactly 26px tall like
// the branch pill segments, flat hairline border, solid app background (it
// floats over the message flow; any translucency bleeds messages through),
// 8px corners, no card shadow. Interactive plate: re-enables pointer events
// and opts out of the titlebar drag so clicks reach the tools.
const chipBase = css`
  display: flex;
  align-items: center;
  height: 26px;
  gap: 2px;
  padding: 0 4px;
  background: var(--color-background);
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  box-shadow: none;
  pointer-events: auto;
  -webkit-app-region: no-drag;
`

// Transparent slot: the branch pill carries its own plate (pinned by the
// branch visual-contract tests), so this slot adds no second plate.
export const TitlebarFloatLeft = styled.div`
  ${slotBase}
  left: 12px;
`

// Positioning slot for the search/re-open/edit/settings group: transparent
// with no plate of its own, clear of the native window controls by the shared
// right clearance. The visible plate is TitlebarChipRight below.
export const TitlebarFloatRight = styled.div`
  ${slotBase}
  right: ${rightClearance};
`

// The visible right-group plate. The inner tools row ships its own loose
// gap; the chip rhythm wins here (class + attribute beats the row's single
// class, no !important).
export const TitlebarChipRight = styled.div`
  ${chipBase}
  & > [data-testid='navbar-tools-right'] {
    gap: 2px;
  }
  // Local compact variant: the generic NavbarIcon stays 30px for other
  // pages — only tools floating in this chip render at 24px with 16px
  // glyphs and matching 6px corners, for one 26px control row.
  & div:not([data-testid='navbar-tools-right']) {
    height: 24px;
    padding: 0 6px;
    border-radius: 6px;
    box-shadow: none;
  }
  & svg {
    width: 16px;
    height: 16px;
  }
`
