/**
 * Chat top-chrome layout contracts (source-level guards for the overlay
 * titlebar rework):
 * (1) Chat fills the parent flex height with no leftover viewport calc —
 *     no `calc(100vh - var(--navbar-height))` deduction anywhere in Chat.
 * (2) A single ChatCanvas isolation plane owns the content layer; Main keeps
 *     no flattening transform; the overlay sorts above it as a sibling.
 * (3) The fade is translucent from the first pixel — no opaque platform.
 * (4) Right-float tools render at branch height locally; the generic
 *     NavbarIcon contract (other pages) is untouched.
 * (5) Composer overlay contract: message/composer planes share one measured
 *     tail inset; internal z ladder and inputbar bottom gap stay pinned.
 * (6) The positioning slots declare no pointer/app-region of their own (the
 *     drag root behind them stays effective); the visible plate is a
 *     hug-content 26px no-drag chip one level inside — never a
 *     full-band-height box with a background.
 * (7) Sidebar bottom search moved to the right tool group, the duplicate
 *     new-topic entry is gone, the utility row renders only while an update
 *     is actionable, no sidebar re-open entry lives in the right group, and
 *     the global search shortcut is retained.
 * (8) Sidebar footer keeps the nav group (knowledge/files/theme/settings)
 *     left in a leading group with the avatar rightmost in an auto-margined
 *     wrap (28px targets, 16px glyphs, 10px side insets, 4px gaps); the
 *     default avatar is a neutral User outline (custom avatars untouched).
 * (9) Full parent height chain: HomePage Container/ContentContainer and the
 *     Chat row all carry flex:1 + min-height/min-width:0 with stretch, so
 *     the Chat root stays inside the parent height and #messages remains
 *     the only scroller.
 * (10) Titlebar drag lives on one single explicit root filling the chat
 *     band with a reliable minimum; branch/tools declarations use the valid
 *     no-drag opt-out and the message/composer planes declare no region.
 * (11) Sidebar visibility is the single runtime truth (collapse fully
 *     hides, no narrow rail): one Home-level toggle slides with the panel
 *     (no second show/hide button, no fixed-coordinate lock), and the
 *     hidden branch float clears the traffic-light + toggle safe area.
 * (12) The recycle-bin count badge is neutral grey (no green), scoped to
 *     the trash panel only.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

const chatSrc = () => fs.readFileSync('src/renderer/src/pages/home/Chat.tsx', 'utf8')
const overlaySrc = () => fs.readFileSync('src/renderer/src/pages/home/components/ChatNavBar/index.tsx', 'utf8')
const floatsSrc = () => fs.readFileSync('src/renderer/src/pages/home/components/TitlebarFloat.tsx', 'utf8')
const branchFloatSrc = () => fs.readFileSync('src/renderer/src/pages/home/components/ChatBranchFloat.tsx', 'utf8')
const floatingToolsSrc = () => fs.readFileSync('src/renderer/src/pages/home/components/ChatFloatingTools.tsx', 'utf8')
const sidebarSrc = () => fs.readFileSync('src/renderer/src/pages/home/components/WorkspaceSidebar/index.tsx', 'utf8')
const footerSrc = () =>
  fs.readFileSync('src/renderer/src/pages/home/components/WorkspaceSidebar/WorkspaceSidebarFooter.tsx', 'utf8')
const homePageSrc = () => fs.readFileSync('src/renderer/src/pages/home/HomePage.tsx', 'utf8')
const sidebarToggleSrc = () => fs.readFileSync('src/renderer/src/pages/home/components/SidebarToggle.tsx', 'utf8')
const messagesSharedSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/shared.tsx', 'utf8')
const navbarIconSrc = () => fs.readFileSync('src/renderer/src/components/NavbarIcon.tsx', 'utf8')
const inputbarCoreSrc = () =>
  fs.readFileSync('src/renderer/src/pages/home/Inputbar/components/InputbarCore.tsx', 'utf8')
const backToBottomSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/BackToBottomButton.tsx', 'utf8')
const messageOutlineSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/MessageOutline.tsx', 'utf8')
const topicSegmentLineSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/TopicSegmentLine.tsx', 'utf8')
const trashSrc = () => fs.readFileSync('src/renderer/src/pages/home/Tabs/components/TopicTrashPanel.tsx', 'utf8')
const responsiveCssSrc = () => fs.readFileSync('src/renderer/src/assets/styles/responsive.css', 'utf8')

/** Strip `//` line comments so prose may name a token without asserting it. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')

/** Extract a styled block starting at a marker line, up to its closing backtick. */
const styledBlock = (src: string, marker: string): string => {
  const lines = src.split('\n')
  const start = lines.findIndex((line) => line.includes(marker))
  if (start < 0) return ''
  const end = lines.findIndex((line, index) => index > start && line.trim() === '`')
  return lines.slice(start, end > start ? end : undefined).join('\n')
}

describe('chat top-chrome layout contracts', () => {
  it('(1) Chat fills the parent flex height with no viewport calc deduction', () => {
    const src = codeOnly(chatSrc())
    expect(src).not.toMatch(/calc\(100vh - var\(--navbar-height\)\)/)
    expect(src).not.toMatch(/mainHeight/)
    expect(src).toMatch(/flex:\s*1/)
    expect(src).toMatch(/min-height:\s*0/)
  })

  it('(2) single ChatCanvas isolation plane siblings the overlay; Main keeps no flattening transform', () => {
    const src = codeOnly(chatSrc())
    expect(src).toMatch(/ChatCanvas/)
    expect(src).toMatch(/isolation:\s*isolate/)
    expect(src).toMatch(/z-index:\s*0/)
    expect(src).toMatch(/position:\s*relative/)
    expect(src).not.toMatch(/translateZ\(0\)/)
    // The overlay sorts above the canvas plane as its sibling.
    expect(codeOnly(overlaySrc())).toMatch(/z-index:\s*6/)
  })

  it('(3) fade is translucent from the first pixel with no opaque platform', () => {
    const src = codeOnly(overlaySrc())
    expect(src).toMatch(/pointer-events:\s*none/)
    // Roughly 80% app background at the titlebar top with a denser mid stop
    // at the band edge, easing to transparent over the unchanged tail.
    expect(src).toMatch(/color-mix\(in srgb, var\(--color-background\) 80%, transparent\) 0,/)
    expect(src).toMatch(/color-mix\(in srgb, var\(--color-background\) 48%, transparent\) var\(--chat-band/)
    expect(src).toMatch(/transparent calc\(var\(--chat-band/)
    // No full-opacity band stop anywhere in the gradient.
    expect(src).not.toMatch(/var\(--color-background\) 0,/)
    expect(src).not.toMatch(/var\(--color-background\) var\(--chat-band/)
  })

  it('(4) right-float tools render at branch height locally; generic NavbarIcon untouched', () => {
    const floats = codeOnly(floatsSrc())
    expect(floats).toMatch(/height:\s*26px/)
    expect(floats).toMatch(/border-radius:\s*8px/)
    expect(floats).toMatch(/width:\s*16px/)
    expect(floats).toMatch(/TitlebarChipRight/)
    // The shared control keeps its own contract for other pages.
    const icon = codeOnly(navbarIconSrc())
    expect(icon).toMatch(/height:\s*30px/)
    expect(icon).not.toMatch(/height:\s*26px/)
  })

  it('(5) composer overlay contract: planes share one measured tail inset', () => {
    // #messages creates no stacking context of its own.
    expect(codeOnly(messagesSharedSrc())).not.toMatch(/^\s*z-index:/m)
    // Group label vs conversation navigation order is unchanged.
    expect(codeOnly(topicSegmentLineSrc())).toMatch(/z-index:\s*1000/)
    expect(codeOnly(messageOutlineSrc())).toMatch(/z-index:\s*1001/)
    // Two planes in the canvas: the message column fills it, the composer
    // floats over its bottom from a single measured height.
    const chat = codeOnly(chatSrc())
    expect(chat).toMatch(/MessagePlane/)
    expect(chat).toMatch(/ComposerPlane/)
    expect(chat).toMatch(/useComposerOverlayHeight/)
    expect(chat).toMatch(/COMPOSER_TAIL_INSET_VAR/)
    expect(chat).toMatch(/COMPOSER_OVERLAY_HEIGHT_VAR/)
    // Tail padding and scroll-padding-bottom derive from the same tail inset;
    // the band alone is the fallback everywhere. BackToBottomButton sits in
    // the fixed bottom-right corner clear of the centered narrowed composer.
    expect(messagesSharedSrc()).toMatch(/--composer-tail-inset/)
    expect(messagesSharedSrc()).toMatch(/scroll-padding-bottom/)
    expect(messagesSharedSrc()).toMatch(/COMPOSER_FLOATING_CONTROL_BAND_PX/)
    expect(codeOnly(backToBottomSrc())).toMatch(/COMPOSER_OVERLAY_BOTTOM_GAP_PX/)
    // The single window-bottom gap is one owned 12px (plane at bottom:0, only
    // the container padding owns it, measured exactly once into the tail);
    // sides keep the nav-rail constant. Gap is spacing, never the band.
    expect(codeOnly(inputbarCoreSrc())).toMatch(/12px \${?INPUTBAR_OUTER_SIDE_PAD_PX/)
    // One plate, one radius: same token as the assistant-switcher panel,
    // hairline border for edge separation — no box-shadow on the composer.
    expect(styledBlock(inputbarCoreSrc(), 'const InputBarContainer')).toMatch(
      /border-radius:\s*var\(--list-item-border-radius\)/
    )
    expect(codeOnly(inputbarCoreSrc())).not.toMatch(/box-shadow:/)
    // Unified frosted-glass composer island (both capsule and expanded share
    // the backdrop-filter and directional glass rim; no box-shadow or
    // legacy opacity token), while the right hug-content chip stays solid.
    expect(codeOnly(inputbarCoreSrc())).toMatch(/backdrop-filter:/)
    expect(inputbarCoreSrc()).not.toMatch(/color-background-opacity/)
    expect(codeOnly(floatsSrc())).toMatch(/background:\s*var\(--color-background\)/)
    expect(floatsSrc()).not.toMatch(/72%, transparent/)
  })

  it('(6) slots declare no pointer/app-region of their own; the 26px plate lives one level inside', () => {
    const floats = floatsSrc()
    const slot = styledBlock(floats, 'const slotBase')
    // Neither a hit-test override nor a region opt-out: blank slot pixels
    // belong to the titlebar drag root behind them.
    expect(slot).not.toMatch(/pointer-events:/)
    expect(slot).not.toMatch(/app-region:/)
    expect(slot).toMatch(/background:\s*transparent/)
    expect(slot).not.toMatch(/height:\s*26px/)
    expect(slot).not.toMatch(/border-radius:\s*8px/)
    const chip = styledBlock(floats, 'const chipBase')
    expect(chip).toMatch(/height:\s*26px/)
    expect(chip).toMatch(/pointer-events:\s*auto/)
    expect(chip).toMatch(/-webkit-app-region:\s*no-drag/)
    expect(chip).toMatch(/border-radius:\s*8px/)
    // The right slot itself carries no plate: no background or border of its own.
    const rightSlot = styledBlock(floats, 'export const TitlebarFloatRight')
    expect(rightSlot).not.toMatch(/background:/)
    expect(rightSlot).not.toMatch(/border/)
    expect(rightSlot).not.toMatch(/pointer-events:/)
    expect(rightSlot).not.toMatch(/app-region:/)
    // The left slot stays plateless too, with no child pointer recovery.
    const leftSlot = styledBlock(floats, 'export const TitlebarFloatLeft')
    expect(leftSlot).not.toMatch(/background:/)
    expect(leftSlot).not.toMatch(/pointer-events:/)
    expect(leftSlot).not.toMatch(/app-region:/)
    // The visible right plate keeps the tight local tool variant.
    const rightChip = styledBlock(floats, 'export const TitlebarChipRight')
    expect(rightChip).toMatch(/navbar-tools-right/)
    expect(rightChip).toMatch(/width:\s*16px/)
  })

  it('(7) sidebar search moved to the right group; utility row renders only for an actionable update', () => {
    const tools = codeOnly(floatingToolsSrc())
    expect(tools).toMatch(/chat-search-button/)
    expect(tools).toMatch(/SearchPopup/)
    expect(tools).toMatch(/TitlebarChipRight/)
    // No sidebar re-open entry in the right tool group: the single
    // Home-level toggle owns expand/collapse.
    expect(tools).not.toMatch(/sidebar-open-button/)
    expect(tools).not.toMatch(/show_sidebar/)
    expect(tools).not.toMatch(/toggleVisible/)
    const sidebar = codeOnly(sidebarSrc())
    expect(sidebar).not.toMatch(/workspace-search-button/)
    expect(sidebar).not.toMatch(/workspace-new-topic-button/)
    // Gated on the same visibility UpdateAppButton uses, so the update entry
    // is kept but never leaves an empty bordered row behind.
    expect(sidebar).toMatch(/showUpdateEntry/)
    expect(sidebar).toMatch(/update\.downloaded/)
    expect(sidebar).toMatch(/workspace-utility-row/)
    // The global shortcut survives the move.
    expect(codeOnly(homePageSrc())).toMatch(/search_message/)
  })

  it('(8) sidebar footer keeps the nav group left with the avatar rightmost', () => {
    const footer = codeOnly(footerSrc())
    // DOM order: nav group first, avatar wrap last; the avatar itself lives
    // inside the wrap, after every app entry.
    const leadingAt = footer.indexOf('<LeadingGroup>')
    expect(leadingAt).toBeGreaterThan(-1)
    const avatarWrapAt = footer.indexOf('<AvatarWrap>')
    expect(avatarWrapAt).toBeGreaterThan(leadingAt)
    const leadingCloseAt = footer.indexOf('</LeadingGroup>')
    expect(leadingCloseAt).toBeGreaterThan(leadingAt)
    expect(leadingCloseAt).toBeLessThan(avatarWrapAt)
    expect(footer.indexOf('<AppMenus')).toBeGreaterThan(leadingAt)
    expect(footer.indexOf('<AppMenus')).toBeLessThan(leadingCloseAt)
    const avatarAt = Math.min(
      ...['<AvatarImg', '<EmojiAvatar', '<DefaultAvatarFallback'].map((marker) => {
        const at = footer.indexOf(marker)
        return at < 0 ? Number.POSITIVE_INFINITY : at
      })
    )
    expect(avatarAt).toBeGreaterThan(avatarWrapAt)
    expect(styledBlock(footerSrc(), 'const Container')).toMatch(/justify-content:\s*flex-start/)
    expect(styledBlock(footerSrc(), 'const Menus')).toMatch(/justify-content:\s*flex-start/)
    // The avatar wrap carries the auto margin that pins it to the panel's
    // right padding edge; the old avatar-leftmost group is gone.
    expect(footer).not.toMatch(/<TrailingGroup>/)
    expect(styledBlock(footerSrc(), 'const AvatarWrap')).toMatch(/margin-left:\s*auto/)
    // One light row: 28px targets (avatar matches the icon buttons), 16px
    // glyphs, even 10px side insets, 4px group gaps — user/theme/settings
    // interaction intact.
    const icon = styledBlock(footerSrc(), 'const Icon')
    expect(icon).toMatch(/width:\s*28px/)
    expect(icon).toMatch(/height:\s*28px/)
    const avatarImg = styledBlock(footerSrc(), 'const AvatarImg')
    expect(avatarImg).toMatch(/width:\s*28px/)
    expect(avatarImg).toMatch(/height:\s*28px/)
    expect(footer).toMatch(/size=\{28\}/)
    expect(footer).toMatch(/size=\{16\}/)
    expect(styledBlock(footerSrc(), 'const Container')).toMatch(/padding:\s*6px 10px/)
    expect(styledBlock(footerSrc(), 'const Menus')).toMatch(/gap:\s*4px/)
    expect(styledBlock(footerSrc(), 'const LeadingGroup')).toMatch(/gap:\s*4px/)
    // Tooltips, avatar popup and the settings entry survive the reorder.
    expect(footer).toMatch(/UserPopup/)
    expect(footer).toMatch(/toggleTheme/)
    expect(footer).toMatch(/sidebar-nav-settings/)
    // Default avatar is neutral (this footer only): a User outline on a
    // subtle neutral surface. Custom user avatars keep the image path;
    // the bundled green default image is no longer the fallback.
    expect(footer).toMatch(/sidebar-default-avatar/)
    expect(footer).toMatch(/avatar !== UserAvatar/)
    expect(footer).not.toMatch(/avatar \|\| UserAvatar/)
    const fallback = styledBlock(footerSrc(), 'const DefaultAvatarFallback')
    expect(fallback).toMatch(/width:\s*28px/)
    expect(fallback).toMatch(/height:\s*28px/)
    expect(fallback).toMatch(/background-color:\s*var\(--color-background-soft\)/)
    expect(fallback).not.toMatch(/--color-primary/)
    expect(fallback).not.toMatch(/--color-green/)
  })

  it('(9) full parent height chain constrains the Chat root; #messages stays the only scroller', () => {
    // HomePage column: flex column filling the router flex-1 slot.
    const homeContainer = styledBlock(homePageSrc(), 'const Container =')
    expect(homeContainer).toMatch(/flex:\s*1/)
    expect(homeContainer).toMatch(/flex-direction:\s*column/)
    expect(homeContainer).toMatch(/min-height:\s*0/)
    expect(homeContainer).toMatch(/min-width:\s*0/)
    // HomePage row: flex row bounding the sidebar + Chat columns.
    const contentContainer = styledBlock(homePageSrc(), 'const ContentContainer')
    expect(contentContainer).toMatch(/flex:\s*1/)
    expect(contentContainer).toMatch(/flex-direction:\s*row/)
    expect(contentContainer).toMatch(/min-height:\s*0/)
    expect(contentContainer).toMatch(/min-width:\s*0/)
    expect(contentContainer).toMatch(/overflow:\s*hidden/)
    // Chat row: explicit stretch replaces the ambiguous shared HStack
    // (align-items: flex-start lets children size to content and pushes the
    // composer out of the window).
    const chat = codeOnly(chatSrc())
    expect(chat).not.toMatch(/HStack/)
    const chatRow = styledBlock(chatSrc(), 'const ChatRow')
    expect(chatRow).toMatch(/flex:\s*1/)
    expect(chatRow).toMatch(/align-items:\s*stretch/)
    expect(chatRow).toMatch(/min-height:\s*0/)
    expect(chatRow).toMatch(/min-width:\s*0/)
    expect(chatRow).toMatch(/overflow:\s*hidden/)
    // The motion wrapper stretches instead of sizing to content.
    expect(chat).toMatch(/minHeight:\s*0/)
    expect(chat).toMatch(/alignSelf:\s*'stretch'/)
    // Chat root stays inside the parent height — still no viewport calc.
    expect(chat).not.toMatch(/calc\(100vh - var\(--navbar-height\)\)/)
    expect(chat).not.toMatch(/mainHeight/)
    // #messages keeps owning the only scroll: Main/ChatCanvas constrain,
    // the message host owns overflow.
    expect(codeOnly(messagesSharedSrc())).toMatch(/overflow/)
  })

  it('(10) titlebar drag lives on one single explicit root; content rows use valid no-drag or nothing', () => {
    const overlay = codeOnly(overlaySrc())
    // No second drag band, no nested shared navbar: the only drag surface
    // is the root itself, with window controls reused directly (WindowControls
    // renders null on macOS, where the native traffic lights own that corner).
    expect(overlay).not.toMatch(/<DragBand/)
    expect(overlay).not.toMatch(/const DragBand/)
    expect(overlay).not.toMatch(/<Navbar/)
    expect(overlay).not.toMatch(/home-navbar/)
    expect(overlay).toMatch(/<WindowControls/)
    // The single root: absolute full-width band, exactly the chat band tall
    // (the shared --chat-band var, never a second height), owns its
    // blank-pixel hits and drags, sorts above the canvas.
    const root = styledBlock(overlaySrc(), 'const TitlebarRoot')
    expect(root).toMatch(/position:\s*absolute/)
    expect(root).toMatch(/top:\s*0/)
    expect(root).toMatch(/left:\s*0/)
    expect(root).toMatch(/right:\s*0/)
    expect(root).toMatch(/height:\s*var\(--chat-band/)
    expect(root).toMatch(/background:\s*transparent/)
    expect(root).toMatch(/pointer-events:\s*auto/)
    expect(root).toMatch(/-webkit-app-region:\s*drag/)
    expect(root).toMatch(/z-index:\s*6/)
    // The root wraps no message or composer content.
    expect(overlay.indexOf('<ChatBranchFloat')).toBeGreaterThan(-1)
    expect(overlay.indexOf('<ChatFloatingTools')).toBeGreaterThan(-1)
    expect(overlay).not.toMatch(/<Messages/)
    expect(overlay).not.toMatch(/<Inputbar/)
    // The fade above it is paint only: click-through, never a drag face.
    const fade = styledBlock(overlaySrc(), 'const Fade')
    expect(fade).toMatch(/pointer-events:\s*none/)
    expect(fade).not.toMatch(/app-region:/)
    // Assistant/model/tool rows never declare a drag surface of their own;
    // the positioning slots declare no region while the hug-content
    // chip/pill/buttons opt out with the valid value.
    for (const src of [branchFloatSrc(), floatingToolsSrc()]) {
      expect(codeOnly(src)).not.toMatch(/app-region:\s*drag/)
    }
    expect(codeOnly(navbarIconSrc())).toMatch(/-webkit-app-region:\s*no-drag/)
    expect(codeOnly(navbarIconSrc())).not.toMatch(/-webkit-app-region:\s*none/)
    // The chatband source keeps a reliable 30px floor on macOS (a missing or
    // zero titlebar-area never collapses the band); the titlebar renders
    // after the canvas as its last sibling; both content planes declare no
    // region at all (they were never inside the drag header).
    const chat = codeOnly(chatSrc())
    expect(chat).toMatch(/max\(30px, env\(titlebar-area-height, 30px\)\)/)
    expect(chat.indexOf('<ChatCanvas')).toBeLessThan(chat.indexOf('<ChatNavbar'))
    expect(chat).not.toMatch(/-webkit-app-region:/)
  })

  it('(11) single Home-level toggle slides with the panel; rendered after Chat so its no-drag wins the native region vector', () => {
    const home = codeOnly(homePageSrc())
    const toggleFile = sidebarToggleSrc()
    const toggle = codeOnly(toggleFile)
    // Exactly one toggle control in the whole top chrome, owned by its own
    // module: Home renders a single <SidebarToggle/> (after Chat, never
    // inside the panel or the right tool group); the panel and the right
    // group own none; the testid lives only on the real button.
    expect(home.match(/<SidebarToggle/g)?.length ?? 0).toBe(1)
    expect(home).toMatch(/import SidebarToggle/)
    expect(home).not.toMatch(/const SidebarToggleSlot/)
    expect(home.match(/sidebar-collapse-button/g)?.length ?? 0).toBe(0)
    expect(codeOnly(sidebarSrc()).match(/sidebar-collapse-button/g)?.length ?? 0).toBe(0)
    expect(codeOnly(floatingToolsSrc()).match(/sidebar-collapse-button/g)?.length ?? 0).toBe(0)
    expect(toggle.match(/sidebar-collapse-button/g)?.length ?? 0).toBe(1)
    // DOM order is the design contract — not z-index. Electron applies the
    // collected native region vector in order (union drag, subtract
    // no-drag), so the button's no-drag entry must sort after the chat
    // drag entry it floats over in the hidden state. Renderer collection
    // order is version-dependent and is not asserted here. Never
    // introduce another drag rect over this button later in the tree:
    // that is a native-boundary violation, and no z-index can repair it.
    const contentCloseAt = home.indexOf('</ContentContainer>')
    expect(contentCloseAt).toBeGreaterThan(-1)
    const chatBoundaryCloseAt = home.lastIndexOf('</ErrorBoundary>', contentCloseAt)
    expect(chatBoundaryCloseAt).toBeGreaterThan(-1)
    expect(home.indexOf('<SidebarToggle')).toBeGreaterThan(chatBoundaryCloseAt)
    // The slot is an absolute Home-level sibling of the panel (never inside
    // its overflow-hidden motion wrapper so the slide is never clipped):
    // position absolute, left eases on the panel's own 0.3s timing,
    // expanded edge derives from the live sidebar width var, hidden edge
    // from the traffic-light safe var — var presence, never a locked pixel.
    const slot = styledBlock(toggleFile, 'const SidebarToggleSlot')
    expect(slot).toMatch(/position:\s*absolute/)
    expect(slot).toMatch(/transition:\s*left 0\.3s/)
    expect(slot).toMatch(/--workspace-sidebar-width/)
    expect(slot).toMatch(/sidebar-toggle-hidden-left/)
    expect(toggle).toMatch(/<SidebarToggleSlot/)
    // Click-through slot with no drag face: the button alone opts out.
    // No blanket child recovery through the Tooltip layer — only the actual
    // button target exits the parent none (pointer-events:auto + no-drag),
    // so the background keeps falling through to the chat drag root.
    expect(slot).toMatch(/pointer-events:\s*none/)
    expect(slot).not.toMatch(/pointer-events:\s*auto/)
    expect(slot).not.toMatch(/app-region:\s*drag/)
    const button = styledBlock(toggleFile, 'const SidebarToggleButton')
    expect(button).toMatch(/pointer-events:\s*auto/)
    expect(button).toMatch(/-webkit-app-region:\s*no-drag/)
    expect(button).not.toMatch(/-webkit-app-region:\s*none/)
    // No narrow rail anywhere in production: collapse fully hides.
    for (const src of [home, codeOnly(sidebarSrc())]) {
      expect(src).not.toMatch(/WorkspaceRail/)
      expect(src).not.toMatch(/RailContainer/)
      expect(src).not.toMatch(/RailButton/)
      expect(src).not.toMatch(/64px/)
    }
    // Visibility is the single runtime truth: no collapsed branch in the
    // panel or Home production code (the deprecated persisted field lives
    // only in settings/useStore for persist compatibility).
    expect(home).not.toMatch(/collapsed/i)
    expect(codeOnly(sidebarSrc())).not.toMatch(/collapsed/i)
    // Both legacy shortcuts map onto the single visibility toggle; no
    // legacy show/set entry point is wired in Home.
    expect(home).toMatch(/toggle_show_assistants/)
    expect(home).toMatch(/toggle_show_topics/)
    expect(home.match(/toggleVisible\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(home).not.toMatch(/SHOW_ASSISTANTS/)
    expect(home).not.toMatch(/setVisible/)
    // Hidden branch float clears the traffic-light + toggle safe area via
    // the shared safe var (presence only, no pixel lock), declares no drag
    // surface of its own, and keeps the plateless left slot.
    const branch = codeOnly(branchFloatSrc())
    expect(branch).toMatch(/TitlebarFloatLeft/)
    expect(branch).toMatch(/sidebar-toggle-hidden-left/)
    expect(branch).not.toMatch(/app-region:\s*drag/)
    // The responsive stylesheet owns the safe var (value intentionally
    // unasserted — platform geometry, not a layout contract).
    expect(responsiveCssSrc()).toMatch(/--sidebar-toggle-hidden-left/)
  })
  it('(12) recycle-bin count badge is neutral grey, scoped to the trash panel', () => {
    // CountBadge is a plain JSX const (no styled backtick block), so slice
    // exactly its definition instead of styledBlock (which would run past
    // it into unrelated danger-button hovers elsewhere in the file).
    const trashLines = trashSrc().split('\n')
    const badgeStart = trashLines.findIndex((line) => line.includes('const CountBadge'))
    expect(badgeStart).toBeGreaterThan(-1)
    const badgeEnd = trashLines.findIndex((line, i) => i > badgeStart && line.trim() === ')')
    const badge = trashLines.slice(badgeStart, badgeEnd > badgeStart ? badgeEnd + 1 : undefined).join('\n')
    expect(badge).toMatch(/bg-\[var\(--color-background-mute\)\]/)
    expect(badge).toMatch(/text-\[var\(--color-text-2\)\]/)
    expect(badge).not.toMatch(/primary/)
    expect(badge).not.toMatch(/text-white/)
  })
})
