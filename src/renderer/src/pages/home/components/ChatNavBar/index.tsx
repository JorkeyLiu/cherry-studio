import WindowControls from '@renderer/components/WindowControls'
import type { Assistant, Topic } from '@renderer/types'
import type { FC } from 'react'
import styled from 'styled-components'

import ChatBranchFloat from '../ChatBranchFloat'
import ChatFloatingTools from '../ChatFloatingTools'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
}

/**
 * Single explicit overlay titlebar: the ONLY chat-side drag surface. A
 * transparent native band (absolute, full width, exactly --chat-band tall)
 * that owns its own blank-pixel hits (pointer-events auto + drag) and sits
 * as the last sibling above the chat canvas. No nested shared Navbar, no
 * second drag band. Window controls render directly (null on macOS, where
 * the native traffic lights own that corner). The branch pill (left) and
 * the search/re-open/edit/settings group (right) float inside the band on
 * the traffic-light row, each opting its own hug-content hole out of the
 * drag. The fade below is paint only.
 *
 * Layering: root sorts at z 6 — above the ChatCanvas content plane (z 0).
 * Inside the root the fade paints at z 1 and the two control floats at
 * z 10; the native window controls keep their own order.
 */
const HeaderNavbar: FC<Props> = ({ activeAssistant, activeTopic, setActiveTopic }) => {
  return (
    <TitlebarRoot data-testid="chat-titlebar">
      <Fade aria-hidden="true" />
      <ChatBranchFloat assistant={activeAssistant} activeTopic={activeTopic} setActiveTopic={setActiveTopic} />
      <ChatFloatingTools />
      <WindowControls />
    </TitlebarRoot>
  )
}

/**
 * The single chat titlebar drag root: transparent, full-width, exactly one
 * band tall (--chat-band, set on #chat-main with a reliable minimum so a
 * missing or zero macOS titlebar-area never collapses it). Blank pixels
 * hit this root and drag the window; only real interactive children opt
 * out with no-drag. Wraps no message or composer content.
 */
const TitlebarRoot = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--chat-band, var(--navbar-height));
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  background: transparent;
  pointer-events: auto;
  -webkit-app-region: drag;
  z-index: 6;
`

/**
 * Top fade: translucent from the first pixel — roughly 80% app background
 * at the titlebar top easing to transparent over a 16px tail past the
 * band, so scrolled messages fade instead of hard-clipping and the
 * traffic-light row stays legible without an opaque mask. The tail holds a
 * denser mid stop so top text never shears off abruptly; length is unchanged
 * so the message top safe area (band + tail + breathing room, same var)
 * still clears it. Height derives from --chat-band (set on #chat-main: mac
 * traffic-light strip vs navbar-height, fullscreen-aware).
 * Paint only: never receives events, never declares a drag face — blank
 * pixels fall through to the titlebar root behind it and drag.
 */
const Fade = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: calc(var(--chat-band, var(--navbar-height)) + 16px);
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--color-background) 80%, transparent) 0,
    color-mix(in srgb, var(--color-background) 48%, transparent) var(--chat-band, var(--navbar-height)),
    transparent calc(var(--chat-band, var(--navbar-height)) + 16px)
  );
  z-index: 1;
  pointer-events: none;
`

export default HeaderNavbar
