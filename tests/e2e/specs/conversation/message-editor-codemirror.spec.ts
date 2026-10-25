/**
 * CodeMirror message-editor integrated contract (user-approved upgrade).
 *
 * Boundary-matched Playwright coverage ONLY: long assistant Markdown draft
 * edit/save through the real CodeMirror surface. Uses the standard fixture
 * (unique disposable profile, mocked providers) and seeds via Main authority
 * (`ensureTopic` + `pasteMessagesToTopic`) + UI route setup only.
 *
 * Agreed production DOM contract under test (fixed post-upgrade contract):
 * - `.message-editor-area`, `.message-editor-save-btn`,
 *   `.message-editor-resend-btn` (user only),
 *   `[data-interaction-region='message-controls']` remain.
 * - `.editing-message` is the visible wrapper containing the real
 *   `.cm-content[contenteditable=true]` in source mode (not a textarea).
 * - Inline Cancel stays at its original action-bar position.
 * - ONE mode toggle: `message-editor-mode-btn` with
 *   `data-mode='source'|'preview'` and `aria-pressed` true exactly in
 *   preview; clicking toggles. The legacy dual `message-editor-source-btn`
 *   / `message-editor-preview-btn` are gone. Source/preview raw/history
 *   remains.
 * - OUTER top-edge grip `message-editor-resize-handle`
 *   (role=separator, aria-orientation=horizontal, tabindex 0, pointer
 *   capture, absolutely positioned on the OUTERMOST bordered editor frame
 *   top border — NOT an internal flex row; `message-editor-container`
 *   testid MAY exist, else `.message-editor`/`.message-editor-area`
 *   anchors the frame); drag upward grows, downward shrinks; ArrowUp/Down
 *   grow/shrink, Home/End min/max. `message-editor-resize-surface`
 *   defaults to the content-adaptive height through ONE sizing resolver
 *   (single one-line floor from actual rendered text geometry, growth with
 *   editing, 52vh maximum then inner scroll — automatic and manual are only
 *   ways to supply a desired height into the same bounds, so dragging an
 *   adaptive short draft starts at the displayed height with no jump);
 *   drag/keyboard commits are session-only (kept for this edit session,
 *   never overwritten by later text edits) and reset on close/reopen AND
 *   relaunch — no persisted height, no settings switch.
 * - Toolbar (strict order, markup grouping never forced positioning): mode,
 *   then the scrollable tools group carrying formatting + link
 *   (`message-editor-link-btn`, guaranteed) + find + divider
 *   (`message-editor-history-separator`, guaranteed) + undo/redo left near
 *   search, then expand alone far-right in its own end group (right contains
 *   ONLY the expand/collapse control); translate removed. Undo/redo expose
 *   native disabled states with a visibly dim icon treatment matching the
 *   global edit-mode disabled style (opacity and/or color,
 *   child-propagation aware) — never skipped as indeterminate. Mode wording
 *   in edit state is "show edit" (not "show source").
 * - Expanded modal `message-editor-expanded`: independent fixed-window meaning
 *   (root height min(72vh, calc(100vh - 120px)), never the inline adaptive
 *   height — even a one-line draft fills the original bounded height with
 *   internal CodeMirror scrolling, never sized to short natural content);
 *   inline placeholder keeps the current session adaptive/manual height and
 *   collapse returns it; modal measurements never alter the inline auto
 *   state; preview fills the modal too. Strict single-plane scroll in BOTH
 *   source and preview with the modal mode toggle guaranteed; outer
 *   root/body never scroll (scrollTop stays 0, Save/Cancel pinned) while
 *   exactly one content plane (`.cm-scroller` in source, preview scroller
 *   in preview) scrolls under a real wheel — never overflow:hidden-only.
 * - `data-testid` surface otherwise: `message-editor-expand-btn`,
 *   `message-editor-collapse-btn`, `message-editor-find-btn`,
 *   `message-editor-expanded` (modal root),
 *   `message-editor-resize-surface`, plus the native-history toolbar
 *   `message-editor-bold-btn`, `message-editor-undo-btn`,
 *   `message-editor-redo-btn` (ONE native CodeMirror history shared by
 *   keyboard and toolbar; EditorState/history/selection preserved across
 *   preview/source and expand/collapse presentation changes).
 * - Source/preview is toggle-only (split not guaranteed); expanded is ~80vh
 *   with the shared draft and save/cancel available.
 * - Inline assistant Escape stays a no-op; modal Escape closes the expansion
 *   while retaining the draft.
 *
 * Interaction rules: real Playwright click/key/insertText only — never engine
 * state through internal globals or native textarea setters. `.cm-content`
 * carries editable-text assertions (never `toHaveValue`); exact full-doc
 * assertions use Redux/SQLite (never `.cm-content` text, which may virtualize).
 * Keyboard selection uses a known short probe for controllability; the main
 * persisted sample stays the long synthetic draft and exact storage is
 * Redux/SQLite after replace (current long save contract). Find/replace match
 * counts stay component-test owned (no new E2E selectors guessed).
 *
 * Intended invocation (parent coordinates fresh build + focused run):
 *   pnpm build && pnpm test:e2e tests/e2e/specs/conversation/message-editor-codemirror.spec.ts
 */
import * as fs from 'fs'
import type { Locator, Page } from '@playwright/test'

import { expect, getChatDbPath, getUserDataDir, queryChatDbViaElectron, test } from '../../fixtures/electron.fixture'
import { activateTopic, prepareAssistant } from '../../utils/branch-route-setup'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import {
  appendEditorText,
  cmContent,
  cmScroller,
  editorWrapper,
  expectCodeMirrorMounted,
  findOuterChatGutterWheelPoint,
  modeToggle,
  outerEditorFrame,
  previewMarkdown,
  probeResizeHandleHit,
  replaceEditorContent,
  resizeHandle,
  resizeSurface
} from '../../utils/message-editor'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { waitForAppReady } from '../../utils/wait-helpers'

const DISPLAY_LIMIT = 10

function longAssistantMarkdown(tag: string): string {
  const lines: string[] = [
    `# Long draft ${tag}`,
    ``,
    `Lead paragraph for ${tag} with a [reference link](https://example.com/${tag}) and raw <span>syntax</span>.`,
    ``,
    `## Section headings`,
    ``,
    `### Subsection alpha`,
    ``,
    ...Array.from(
      { length: 24 },
      (_, i) => `Draft body paragraph ${i} for ${tag}: filler words carry the editor past a scrollable height.`
    ),
    ``,
    `## Data table`,
    ``,
    `| col-a-${tag} | col-b-${tag} | col-c |`,
    `| --- | --- | --- |`,
    `| a1 | b1 | c1 |`,
    `| a2 | b2 | c2 |`,
    `| a3 | b3 | c3 |`,
    ``,
    `## Math`,
    ``,
    `Inline math $E = mc^2$ for ${tag} and a display block:`,
    ``,
    `$$\\int_{0}^{1} x^2 \\, dx = \\frac{1}{3}$$`,
    ``,
    `## Code fence`,
    ``,
    '```ts',
    `// code-probe-${tag}`,
    `export function draftProbe(input: string): string {`,
    `  return \`[${tag}]-\${input}\`;`,
    `}`,
    '```',
    ``,
    `## Mermaid`,
    ``,
    '```mermaid',
    `graph TD;`,
    `  A[${tag}-start] --> B[${tag}-middle];`,
    `  B --> C[${tag}-end];`,
    '```',
    ``,
    `## Raw syntax must survive`,
    ``,
    `Unclosed <div> stays literal, trailing spaces matter: line with two spaces  `,
    `next line after hard break.`,
    ``,
    `Closing marker ${tag}-end.`
  ]
  return lines.join('\n')
}

function editedAssistantMarkdown(tag: string): string {
  return [
    `# Edited long draft ${tag}`,
    ``,
    `Edited lead for ${tag} keeps a [reference link](https://example.com/${tag}-edited) and raw <span>syntax</span>.`,
    ``,
    `## Edited table`,
    ``,
    `| col-a | col-b |`,
    `| --- | --- |`,
    `| edited-a1-${tag} | edited-b1 |`,
    `| edited-a2 | edited-b2-${tag} |`,
    ``,
    `Inline math $a^2 + b^2 = c^2$ (${tag}) and display:`,
    ``,
    `$$E_{edited} = ${tag}$$`,
    ``,
    '```ts',
    `// edited-code-probe-${tag}`,
    `export const edited = '${tag}' as const;`,
    '```',
    ``,
    '```mermaid',
    `graph LR;`,
    `  X[${tag}-edited] --> Y[done];`,
    '```',
    ``,
    `Raw <div> stays literal (${tag}).`,
    ``,
    `Edited closing ${tag}-end.`
  ].join('\n')
}

interface SeededDraft {
  topicId: string
  assistantId: string
  userMsgId: string
  assistantMsgId: string
  assistantBlockId: string
  originalContent: string
}

async function seedLongAssistantDraft(
  page: Page,
  tag: string,
  opts?: { fillerPairs?: number; assistantContent?: string }
): Promise<SeededDraft> {
  await prepareAssistant(page, DISPLAY_LIMIT)
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  const topicId = `cme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // Short-content override for the adaptive-height contract (default keeps
  // the exact long synthetic draft): the seeded content stays byte-exact.
  const originalContent = opts?.assistantContent ?? longAssistantMarkdown(tag)
  // Resize-stage older scroll margin: optional tall preceding synthetic pairs.
  // Default 0 keeps every other case at the exact 2-row override; only the
  // resize test passes fillerPairs (3 pairs = 6 filler rows + 2 target rows =
  // 8 total, inside DISPLAY_LIMIT 10). Filler ids live in a distinct
  // namespace so the long target keeps its known ids and exact raw content.
  const fillerPairs = opts?.fillerPairs ?? 0
  const userMsgId = `${topicId}-msg-00000`
  const assistantMsgId = `${topicId}-msg-00001`
  const userBlockId = `${topicId}-block-00000`
  const assistantBlockId = `${topicId}-block-00001`
  const stamp = '2026-01-01T00:00:00.000Z'
  function fillerAssistantContent(pair: number): string {
    const paras = Array.from(
      { length: 8 },
      (_, i) =>
        `resize filler assistant ${tag} pair ${pair} paragraph ${i}: tall in-flow filler words carry older scroll margin.`
    )
    return `resize filler assistant ${tag} pair ${pair}\n\n${paras.join('\n\n')}`
  }
  const addOk = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
        ;(window as any).store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: {
              id: topicId,
              assistantId,
              name,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
        return { ok: true as const }
      } catch (e) {
        return { ok: false as const, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId as string, name: `CodeMirror ${topicId}` }
  )
  expect(addOk.ok, `addTopic failed: ${addOk.ok === true ? '' : addOk.err}`).toBe(true)
  const persist = await page.evaluate(
    async ({
      topicId,
      assistantId,
      name,
      entries
    }: {
      topicId: string
      assistantId: string
      name: string
      entries: unknown
    }) => {
      try {
        const chatDb = (window as any).api?.chatDb
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function')
          return { ok: false as const, err: 'chatDb missing' }
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true)
          return { ok: false as const, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false as const, err: `paste ${JSON.stringify(pasted)}` }
        return { ok: true as const }
      } catch (e) {
        return { ok: false as const, err: e instanceof Error ? e.message : String(e) }
      }
    },
    {
      topicId,
      assistantId: liveAssistantId as string,
      name: `CodeMirror ${topicId}`,
      entries: [
        ...Array.from({ length: fillerPairs }, (_, pair) => {
          const fillerUserId = `${topicId}-msg-filler-u${pair}`
          const fillerAssistantId = `${topicId}-msg-filler-a${pair}`
          const fillerUserBlock = `${topicId}-block-filler-u${pair}`
          const fillerAssistantBlock = `${topicId}-block-filler-a${pair}`
          const base = pair * 2
          return [
            {
              message: {
                id: fillerUserId,
                topicId,
                role: 'user',
                assistantId: liveAssistantId,
                createdAt: stamp,
                updatedAt: stamp,
                status: 'success',
                blocks: [fillerUserBlock],
                sortOrder: base
              },
              blocks: [
                {
                  id: fillerUserBlock,
                  messageId: fillerUserId,
                  type: 'main_text',
                  content: `resize filler user ${tag} pair ${pair} ${'filler words '.repeat(20)}`,
                  status: 'success',
                  createdAt: stamp,
                  updatedAt: stamp
                }
              ]
            },
            {
              message: {
                id: fillerAssistantId,
                topicId,
                role: 'assistant',
                assistantId: liveAssistantId,
                askId: fillerUserId,
                model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
                modelId: 'mock-model',
                createdAt: stamp,
                updatedAt: stamp,
                status: 'success',
                blocks: [fillerAssistantBlock],
                sortOrder: base + 1
              },
              blocks: [
                {
                  id: fillerAssistantBlock,
                  messageId: fillerAssistantId,
                  type: 'main_text',
                  content: fillerAssistantContent(pair),
                  status: 'success',
                  createdAt: stamp,
                  updatedAt: stamp
                }
              ]
            }
          ]
        }).flat(),
        {
          message: {
            id: userMsgId,
            topicId,
            role: 'user',
            assistantId: liveAssistantId,
            createdAt: stamp,
            updatedAt: stamp,
            status: 'success',
            blocks: [userBlockId],
            sortOrder: fillerPairs * 2
          },
          blocks: [
            {
              id: userBlockId,
              messageId: userMsgId,
              type: 'main_text',
              content: `draft ask ${tag}`,
              status: 'success',
              createdAt: stamp,
              updatedAt: stamp
            }
          ]
        },
        {
          message: {
            id: assistantMsgId,
            topicId,
            role: 'assistant',
            assistantId: liveAssistantId,
            askId: userMsgId,
            model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
            modelId: 'mock-model',
            createdAt: stamp,
            updatedAt: stamp,
            status: 'success',
            blocks: [assistantBlockId],
            sortOrder: fillerPairs * 2 + 1
          },
          blocks: [
            {
              id: assistantBlockId,
              messageId: assistantMsgId,
              type: 'main_text',
              content: originalContent,
              status: 'success',
              createdAt: stamp,
              updatedAt: stamp
            }
          ]
        }
      ]
    }
  )
  expect(persist.ok, `Main authority seed failed: ${persist.ok === true ? '' : persist.err}`).toBe(true)
  await activateTopic(page, topicId, 2 + fillerPairs * 2)
  return {
    topicId,
    assistantId: liveAssistantId as string,
    userMsgId,
    assistantMsgId,
    assistantBlockId,
    originalContent
  }
}

async function openAssistantEditor(page: Page, messageId: string) {
  const msgContainer = page.locator(`[data-message-id="${messageId}"]`)
  await msgContainer.scrollIntoViewIfNeeded()
  await msgContainer.hover()
  const editBtn = msgContainer.locator('[data-testid="msg-assistant-edit-btn"]')
  await editBtn.waitFor({ state: 'visible', timeout: 15000 })
  await editBtn.click()
  const editorArea = msgContainer.locator('.message-editor-area')
  await expectCodeMirrorMounted(editorArea)
  return { msgContainer, editorArea }
}

async function viewportSize(page: Page): Promise<{ width: number; height: number }> {
  const viaApi = page.viewportSize()
  if (viaApi) return viaApi
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
}

// Stationary rendering tolerances shared with the assistant-edit-region
// oracle: subpixel/style budget only (~2px final, ~4px painted transition).
// A real centering jump must fail, never be absorbed. NOT weakened here.
const REGION_TOL = 2
const TRANSITION_TOL = 4

async function expectMode(scope: Page | Locator, want: 'source' | 'preview'): Promise<void> {
  const btn = modeToggle(scope)
  await expect(btn, 'single mode toggle must render').toBeVisible({ timeout: 10000 })
  await expect(btn, `mode must be ${want}`).toHaveAttribute('data-mode', want)
  await expect(btn, 'aria-pressed is true exactly in preview').toHaveAttribute(
    'aria-pressed',
    want === 'preview' ? 'true' : 'false'
  )
}

async function expectNoLegacyModeButtons(scope: Page | Locator): Promise<void> {
  await expect(scope.locator('[data-testid="message-editor-source-btn"]')).toHaveCount(0)
  await expect(scope.locator('[data-testid="message-editor-preview-btn"]')).toHaveCount(0)
}

async function surfaceHeight(editorArea: Locator): Promise<number> {
  const box = await resizeSurface(editorArea).boundingBox()
  if (!box) throw new Error('resize surface has no geometry')
  return box.height
}

/**
 * Bottom slack between the last rendered text line and the input surface
 * bottom — the user-visible empty area below the text. A short one-line
 * draft must keep only normal padding/one-line slack here (tight oracle:
 * a ~70px gap like the reported tall-input failure never passes).
 * Returns NaN when the surface or its lines are unreadable (callers fail
 * loudly on NaN, never treat it as zero).
 */
async function inputBottomGap(editorArea: Locator): Promise<number> {
  return editorArea
    .evaluate((area) => {
      const surface = area.querySelector('[data-testid="message-editor-resize-surface"]') as HTMLElement | null
      const lines = Array.from(area.querySelectorAll('.editing-message .cm-line')) as HTMLElement[]
      if (!surface || lines.length === 0) return Number.NaN
      const s = surface.getBoundingClientRect()
      const last = lines[lines.length - 1].getBoundingClientRect()
      return s.bottom - last.bottom
    })
    .catch(() => Number.NaN)
}

/** Live bottom controls-region offset (editor action bar when open). */
async function editorRegionOffset(page: Page, messageId: string): Promise<number | null> {
  return page
    .evaluate((id: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return null
      const c = container.getBoundingClientRect()
      const esc = typeof CSS !== 'undefined' && (CSS as unknown as { escape: (v: string) => string }).escape(id)
      const row = document.querySelector(`#messages [data-message-id="${esc}"]`) as HTMLElement | null
      if (!row) return null
      const region = row.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null
      if (!region) return null
      const r = region.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) return null
      return r.bottom - c.top
    }, messageId)
    .catch(() => null)
}

/**
 * Genuine-user placement precondition for the top-edge grip (shared by the
 * resize session test and the outside-release test).
 *
 * Settled runtime fact: parking the wheel in the #messages center ALWAYS
 * hits an inner cm-line -> .cm-scroller, so wheels there are consumed by the
 * inner plane. ONE outer margin point (row background IN #messages, OUTSIDE
 * the editor .cm-scroller) moves #messages and the handle to a true hit with
 * the inner plane unchanged. This helper therefore resolves a live
 * outer-margin point (see findOuterChatGutterWheelPoint) and wheels ONLY
 * there — never the viewport center — with precise top before/after
 * annotations. One or a bounded few real outer gestures as needed; no loop
 * masking a bad target.
 */
async function ensureEditorHandleUnoccluded(
  page: Page,
  editorArea: Locator,
  annotationPrefix: string
): Promise<{ cx: number; cy: number }> {
  const container = page.locator('#messages').first()
  const handle = resizeHandle(editorArea)
  const frame = outerEditorFrame(editorArea)
  for (let attempt = 0; attempt < 3; attempt++) {
    const containerBox = await container.boundingBox()
    if (!containerBox) throw new Error('#messages has no geometry')
    const handleBox = await handle.boundingBox()
    if (!handleBox) throw new Error('resize handle has no geometry')
    const frameBox = await frame.boundingBox().catch(() => null)
    const cx = handleBox.x + handleBox.width / 2
    const cy = handleBox.y + handleBox.height / 2
    const probe = await probeResizeHandleHit(page, cx, cy)
    const topEdge = frameBox ? frameBox.y : handleBox.y
    const topSafe = containerBox.y + 72
    const bottomSafe = containerBox.y + containerBox.height - 96
    const frameTopSafe = containerBox.y + 48
    const centered = cy >= topSafe && cy <= bottomSafe && topEdge >= frameTopSafe && topEdge <= bottomSafe && probe.hit
    if (centered) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      await page.waitForTimeout(200)
      const reBox = await handle.boundingBox()
      if (!reBox) throw new Error('resize handle lost geometry after settle')
      const rx = reBox.x + reBox.width / 2
      const ry = reBox.y + reBox.height / 2
      const reProbe = await probeResizeHandleHit(page, rx, ry)
      test.info().annotations.push({
        type: `${annotationPrefix}-placement`,
        description: `handle=(${Math.round(rx)},${Math.round(ry)}) hit=${reProbe.describe} frameTop=${frameBox ? Math.round(frameBox.y) : 'na'} band=[${Math.round(topSafe)}..${Math.round(bottomSafe)}] outerAttempts=${attempt}`
      })
      expect(reProbe.hit, `resize handle center must hit-test to the handle (got ${reProbe.describe})`).toBe(true)
      return { cx: rx, cy: ry }
    }
    // Genuine outer wheel only: resolve the live outer-margin point, move
    // there, and wheel in the correct visual direction.
    const outer = await findOuterChatGutterWheelPoint(page)
    test.info().annotations.push({
      type: `${annotationPrefix}-outer-point`,
      description: `outer=(${Math.round(outer.x)},${Math.round(outer.y)}) hit=${outer.describe} owner=${outer.owner}`
    })
    const topBefore: number = await page
      .evaluate(() => (document.getElementById('messages') as HTMLElement | null)?.scrollTop ?? -9999)
      .catch(() => -9999)
    await page.mouse.move(outer.x, outer.y)
    await page.waitForTimeout(120)
    if (cy < topSafe + 40 || topEdge < frameTopSafe) {
      await page.mouse.wheel(0, -160)
    } else {
      await page.mouse.wheel(0, 160)
    }
    await page.waitForTimeout(260)
    const topAfter: number = await page
      .evaluate(() => (document.getElementById('messages') as HTMLElement | null)?.scrollTop ?? -9999)
      .catch(() => -9999)
    const afterBox = await handle.boundingBox().catch(() => null)
    test.info().annotations.push({
      type: `${annotationPrefix}-outer-wheel`,
      description: `attempt=${attempt} outer=(${Math.round(outer.x)},${Math.round(outer.y)}) topBefore=${topBefore} topAfter=${topAfter} handleY=${afterBox ? Math.round(afterBox.y + afterBox.height / 2) : 'na'}`
    })
  }
  const lastBox = await handle.boundingBox().catch(() => null)
  throw new Error(
    `resize handle never reached an unoccluded central hit-test via genuine outer wheels (last=${lastBox ? `${Math.round(lastBox.x + lastBox.width / 2)},${Math.round(lastBox.y + lastBox.height / 2)}` : 'none'})`
  )
}

test.describe('CodeMirror message editor — long assistant draft contract', () => {
  test.setTimeout(300000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('long assistant Markdown draft edit/save persists exact content', async ({ mainWindow, electronApp }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR LONG-DRAFT SAVE (INTEGRATED): seed a long synthetic assistant Markdown draft via Main authority, open the real CodeMirror editor, prove mount + bounded inline/expanded geometry + preview toggle + expansion-close draft retention, drive at least one real onChange input, then save and prove the exact edited Markdown through Redux and readonly SQLite after app close.'
    })
    const page: Page = mainWindow
    const tag = `cme-${Date.now().toString(36)}`
    const seeded = await test.step('seed long assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag))

    const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () => {
      const opened = await openAssistantEditor(page, seeded.assistantMsgId)
      // Wrapper contains the real editable surface in source mode.
      const wrapperCount = await editorWrapper(opened.editorArea).count()
      expect(wrapperCount).toBeGreaterThan(0)
      const cmCount = await cmContent(opened.editorArea).count()
      expect(cmCount).toBeGreaterThan(0)
      return opened
    })

    await test.step('inline editor is bounded with a usable scroll surface', async () => {
      const viewport = await viewportSize(page)
      const editorBox = await editorArea.boundingBox()
      expect(editorBox, 'inline editor must have geometry').not.toBeNull()
      const resizeSurface = editorArea.locator('[data-testid="message-editor-resize-surface"]')
      await expect(resizeSurface, 'resize surface must render').toBeVisible({ timeout: 10000 })
      const actionBar = editorArea.locator('[data-interaction-region="message-controls"]')
      await expect(actionBar, 'editor action bar keeps the shared controls region').toBeVisible()
      const actionBox = await actionBar.boundingBox()
      // Relative bounds only: the editor holds more than its action bar and
      // stays inside the window (no absolute pixel performance thresholds).
      expect(editorBox!.height).toBeGreaterThan(actionBox?.height ?? 0)
      expect(editorBox!.height).toBeLessThanOrEqual(viewport.height)
      expect(editorBox!.width).toBeLessThanOrEqual(viewport.width)
      const scrollable = await editorArea.evaluate((area) => {
        const cm = area.querySelector('.editing-message .cm-content') as HTMLElement | null
        if (!cm) return { ok: false, scrollHeight: 0, clientHeight: 0 }
        const scroller = (cm.closest('.cm-scroller') as HTMLElement | null) ?? cm
        return { ok: true, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
      })
      expect(scrollable.ok, 'CodeMirror scroll surface must exist').toBe(true)
      expect(scrollable.clientHeight).toBeGreaterThan(0)
      expect(scrollable.scrollHeight).toBeGreaterThanOrEqual(scrollable.clientHeight)
      test.info().annotations.push({
        type: 'cme-inline-geometry',
        description: `editor=${Math.round(editorBox!.width)}x${Math.round(editorBox!.height)} viewport=${viewport.width}x${viewport.height} scroll=${scrollable.scrollHeight}/${scrollable.clientHeight}`
      })
    })

    await test.step('single mode toggle shows rendered Markdown and preserves the draft', async () => {
      await expectNoLegacyModeButtons(editorArea)
      await expect(modeToggle(editorArea), 'exactly one mode toggle renders').toHaveCount(1)
      await expectMode(editorArea, 'source')
      await modeToggle(editorArea).click()
      await expectMode(editorArea, 'preview')
      // Rendered preview displays the seeded heading/table (substring only —
      // exact full-doc text stays a Redux/SQLite assertion).
      await expect(editorArea).toContainText(`Long draft ${tag}`, { timeout: 10000 })
      await expect(editorArea).toContainText(`col-a-${tag}`, { timeout: 10000 })
      await modeToggle(editorArea).click()
      await expectMode(editorArea, 'source')
      const cm = cmContent(editorArea)
      await expect(cm, 'back in source mode the editable surface remounts').toBeVisible({ timeout: 10000 })
      // Virtualization renders the visible window only: source remount focuses
      // the tail, so the head is off-viewport until a real document-start key.
      await cm.click()
      await page.keyboard.press('ControlOrMeta+Home')
      await expect(cm).toContainText(`Long draft ${tag}`, { timeout: 10000 })
    })

    await test.step('expansion is window-bounded, keeps the shared draft, Escape closes it', async () => {
      const expandBtn = editorArea.locator('[data-testid="message-editor-expand-btn"]')
      await expect(expandBtn, 'expand control must render').toBeVisible({ timeout: 10000 })
      await expandBtn.click()
      const modal = page.locator('[data-testid="message-editor-expanded"]')
      await expect(modal, 'expanded modal root must render').toBeVisible({ timeout: 10000 })
      const viewport = await viewportSize(page)
      const modalBox = await modal.boundingBox()
      expect(modalBox, 'expanded modal must have geometry').not.toBeNull()
      // Relative window bounds only: ~80vh tall without escaping the window.
      expect(modalBox!.width).toBeLessThanOrEqual(viewport.width)
      expect(modalBox!.height).toBeLessThanOrEqual(viewport.height * 0.95)
      expect(modalBox!.height).toBeGreaterThanOrEqual(viewport.height * 0.6)
      await expect(modal).toContainText(`Long draft ${tag}`, { timeout: 10000 })
      await expect(modal.locator('.message-editor-save-btn'), 'save stays available while expanded').toBeVisible()
      // Formatting controls are component-test owned: record what the expanded
      // surface offers without gating on an invented selector.
      const offeredTestIds: string[] = await modal
        .evaluate((root) =>
          Array.from(root.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid') ?? '')
        )
        .catch(() => [])
      test.info().annotations.push({
        type: 'cme-expanded-geometry',
        description: `modal=${Math.round(modalBox!.width)}x${Math.round(modalBox!.height)} viewport=${viewport.width}x${viewport.height} offered=${offeredTestIds.filter(Boolean).slice(0, 12).join(',')}`
      })
      await page.keyboard.press('Escape')
      await expect(modal, 'modal Escape closes the expansion').not.toBeVisible({ timeout: 10000 })
      const cm = cmContent(editorArea)
      await expect(cm, 'inline editor retains the draft after expansion close').toBeVisible({ timeout: 10000 })
      // Same virtualization window: bring the head into view with a public
      // document-start gesture before asserting (tail stays Redux/SQLite exact).
      await cm.click()
      await page.keyboard.press('ControlOrMeta+Home')
      await expect(cm).toContainText(`Long draft ${tag}`, { timeout: 10000 })
    })

    const editedText = editedAssistantMarkdown(tag)
    await test.step('real onChange input then full replacement stages the edited Markdown', async () => {
      // At least one genuine user input through CodeMirror onChange — not only
      // the seeded text — before the full replacement.
      const probe = `\n\nonchange-probe-${tag}\n`
      await appendEditorText(page, editorArea, probe)
      await expect(cmContent(editorArea)).toContainText(`onchange-probe-${tag}`, { timeout: 10000 })
      await replaceEditorContent(page, editorArea, editedText)
      // Substring probes only: the full-doc exact assertion is Redux/SQLite.
      // Full replacement leaves focus at the tail (only tail paragraphs
      // render); navigate to document start with a public key gesture first.
      await cmContent(editorArea).click()
      await page.keyboard.press('ControlOrMeta+Home')
      await expect(cmContent(editorArea)).toContainText(`Edited long draft ${tag}`, { timeout: 10000 })
      await expect(cmContent(editorArea)).toContainText(`edited-code-probe-${tag}`, { timeout: 10000 })
    })

    await test.step('save persists the exact edited Markdown through Main', async () => {
      const saveBtn = editorArea.locator('.message-editor-save-btn')
      await expect(saveBtn, 'save button must render').toBeVisible()
      await saveBtn.click()
      await expect(editorArea, 'editor closes only after persistence succeeds').not.toBeVisible({ timeout: 15000 })
      const stored = await page.evaluate(
        ({ msgId }: { msgId: string }) => {
          const s = (window as any).store.getState()
          const msg = s.messages?.entities?.[msgId]
          const blockId: string = msg?.blocks?.[0] ?? ''
          return blockId ? ((s.messageBlocks?.entities?.[blockId]?.content as string) ?? null) : null
        },
        { msgId: seeded.assistantMsgId }
      )
      expect(stored, 'Redux block must carry the exact edited Markdown').toBe(editedText)
    })

    await test.step('SQLite holds the exact edited Markdown after app close', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath, 'runtime chat.db path must be known').not.toBeNull()
      await electronApp.close()
      await new Promise((resolve) => setTimeout(resolve, 3000))
      expect(fs.existsSync(chatDbPath!)).toBe(true)
      const esc = (value: string): string => value.replace(/'/g, "''")
      const result = queryChatDbViaElectron(
        chatDbPath!,
        `SELECT id, message_id, type, content, status FROM message_blocks WHERE id = '${esc(seeded.assistantBlockId)}'`
      )
      expect(result.ok, `SQLite query must succeed`).toBe(true)
      if (result.ok !== true) {
        throw new Error(`SQLite query failed: ${result.code}`)
      }
      const rows: readonly Record<string, unknown>[] = result.rows
      expect(rows.length).toBe(1)
      const row = rows[0]
      expect(row['message_id']).toBe(seeded.assistantMsgId)
      expect(row['content'], 'stored content must equal the exact edited Markdown').toBe(editedText)
      expect(row['status']).toBe('success')
      // Special syntax survived the round trip without silent rewrites.
      expect(row['content']).toContain('```ts')
      expect(row['content']).toContain('```mermaid')
      expect(row['content']).toContain('$a^2 + b^2 = c^2$')
      expect(row['content']).toContain('edited-b2-')
    })
  })

  test('native bold and shared undo history survive preview and expansion', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR NATIVE HISTORY (INTEGRATED): toolbar bold on keyboard-selected known short probe through the real cm-content, draft + history preserved across preview->source and expand->collapse, then native ControlOrMeta+Z shares ONE history with toolbar redo/undo (no stale alternate stack). Exact full-doc storage stays Redux after replace with the long synthetic sample (SQLite exact is owned by the long-draft test).'
    })
    const page: Page = mainWindow
    const tag = `cmh-${Date.now().toString(36)}`
    const seeded = await test.step('seed long assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag))

    const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () =>
      openAssistantEditor(page, seeded.assistantMsgId))

    // Controllable short probe for keyboard selection: single token so
    // ControlOrMeta+A selects exactly the known text. Virtualization-unsafe:
    // only substring probes on cm-content; exact full-doc stays Redux.
    const shortProbe = `nativeprobe-${tag}`
    const boldedProbe = `**${shortProbe}**`
    await test.step('stage known short probe through real onChange', async () => {
      await replaceEditorContent(page, editorArea, shortProbe)
      await expect(cmContent(editorArea)).toContainText(shortProbe, { timeout: 10000 })
    })

    await test.step('actual toolbar bold wraps the keyboard-selected known text', async () => {
      const cm = cmContent(editorArea)
      await cm.click()
      await page.keyboard.press('ControlOrMeta+A')
      const boldBtn = editorArea.locator('[data-testid="message-editor-bold-btn"]')
      await expect(boldBtn, 'bold control must render').toBeVisible({ timeout: 10000 })
      await boldBtn.click()
      await expect(cmContent(editorArea)).toContainText(boldedProbe, { timeout: 10000 })
      const undoBtn = editorArea.locator('[data-testid="message-editor-undo-btn"]')
      await expect(undoBtn, 'undo must offer the toolbar bold').toBeEnabled({ timeout: 10000 })
    })

    await test.step('single mode toggle preserves the formatted draft and history', async () => {
      await expectNoLegacyModeButtons(editorArea)
      await expectMode(editorArea, 'source')
      await modeToggle(editorArea).click()
      await expectMode(editorArea, 'preview')
      // Rendered preview shows the token (markers render as bold — substring only).
      await expect(editorArea).toContainText(shortProbe, { timeout: 10000 })
      await modeToggle(editorArea).click()
      await expectMode(editorArea, 'source')
      const cm = cmContent(editorArea)
      await expect(cm, 'back in source the editable surface remounts').toBeVisible({ timeout: 10000 })
      await expect(cm).toContainText(boldedProbe, { timeout: 10000 })
      const undoBtn = editorArea.locator('[data-testid="message-editor-undo-btn"]')
      await expect(undoBtn, 'history must survive preview->source').toBeEnabled({ timeout: 10000 })
    })

    await test.step('expand->collapse preserves the formatted draft and history', async () => {
      const expandBtn = editorArea.locator('[data-testid="message-editor-expand-btn"]')
      await expect(expandBtn, 'expand control must render').toBeVisible({ timeout: 10000 })
      await expandBtn.click()
      const modal = page.locator('[data-testid="message-editor-expanded"]')
      await expect(modal, 'expanded modal root must render').toBeVisible({ timeout: 10000 })
      await expect(modal).toContainText(shortProbe, { timeout: 10000 })
      await expect(modal.locator('.message-editor-save-btn'), 'save stays available while expanded').toBeVisible()
      const collapseBtn = modal.locator('[data-testid="message-editor-collapse-btn"]')
      await expect(collapseBtn, 'collapse control must render').toBeVisible({ timeout: 10000 })
      await collapseBtn.click()
      await expect(modal, 'collapse closes the expansion').not.toBeVisible({ timeout: 10000 })
      const cm = cmContent(editorArea)
      await expect(cm, 'inline editor retains the formatted draft after collapse').toBeVisible({ timeout: 10000 })
      await expect(cm).toContainText(boldedProbe, { timeout: 10000 })
      const undoBtn = editorArea.locator('[data-testid="message-editor-undo-btn"]')
      await expect(undoBtn, 'history must survive expand->collapse').toBeEnabled({ timeout: 10000 })
    })

    await test.step('native undo shares ONE history with toolbar redo/undo', async () => {
      // No re-selection click here: the formatted change survived two
      // presentation transitions, so the preserved EditorState/history must
      // answer the native undo directly (collapse restores focus/selection).
      await page.keyboard.press('ControlOrMeta+Z')
      const cm = cmContent(editorArea)
      await expect(cm).toContainText(shortProbe, { timeout: 10000 })
      await expect(cm).not.toContainText(boldedProbe, { timeout: 10000 })
      const redoBtn = editorArea.locator('[data-testid="message-editor-redo-btn"]')
      await expect(redoBtn, 'redo must share the native history (no stale alternate stack)').toBeEnabled({
        timeout: 10000
      })
      await redoBtn.click()
      await expect(cmContent(editorArea)).toContainText(boldedProbe, { timeout: 10000 })
      const undoBtn = editorArea.locator('[data-testid="message-editor-undo-btn"]')
      await undoBtn.click()
      await expect(cmContent(editorArea)).toContainText(shortProbe, { timeout: 10000 })
      await expect(cmContent(editorArea)).not.toContainText(boldedProbe, { timeout: 10000 })
    })

    await test.step('long exact draft still saves exactly after native-history flow', async () => {
      const editedText = editedAssistantMarkdown(tag)
      await replaceEditorContent(page, editorArea, editedText)
      await cmContent(editorArea).click()
      await page.keyboard.press('ControlOrMeta+Home')
      await expect(cmContent(editorArea)).toContainText(`Edited long draft ${tag}`, { timeout: 10000 })
      const saveBtn = editorArea.locator('.message-editor-save-btn')
      await expect(saveBtn, 'save button must render').toBeVisible()
      await saveBtn.click()
      await expect(editorArea, 'editor closes only after persistence succeeds').not.toBeVisible({ timeout: 15000 })
      const stored = await page.evaluate(
        ({ msgId }: { msgId: string }) => {
          const s = (
            window as unknown as { store: { getState: () => Record<string, Record<string, unknown>> } }
          ).store.getState() as unknown as {
            messages?: { entities?: Record<string, { blocks?: string[] }> }
            messageBlocks?: { entities?: Record<string, { content?: string }> }
          }
          const msg = s.messages?.entities?.[msgId]
          const blockId: string = msg?.blocks?.[0] ?? ''
          return blockId ? ((s.messageBlocks?.entities?.[blockId]?.content as string) ?? null) : null
        },
        { msgId: seeded.assistantMsgId }
      )
      expect(stored, 'Redux block must carry the exact edited Markdown').toBe(editedText)
    })
  })

  test('cancel draft does not write stored content', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR CANCEL (INTEGRATED): stage a draft through the real CodeMirror onChange path, cancel from the original action-bar position, and prove the stored block keeps its exact seeded content.'
    })
    const page: Page = mainWindow
    const tag = `cmc-${Date.now().toString(36)}`
    const seeded = await test.step('seed long assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag))

    await test.step('stage a draft then cancel from the action bar', async () => {
      const { editorArea } = await openAssistantEditor(page, seeded.assistantMsgId)
      await replaceEditorContent(page, editorArea, `cancel-probe-${tag}\n\n${seeded.originalContent}`)
      // Long replacement focuses the tail; the head probe is virtualized out
      // until a real document-start key brings it into the rendered window.
      await cmContent(editorArea).click()
      await page.keyboard.press('ControlOrMeta+Home')
      await expect(cmContent(editorArea)).toContainText(`cancel-probe-${tag}`, { timeout: 10000 })
      // Inline Cancel keeps its original action-bar position: the non-save /
      // non-resend button inside the shared controls region (locale-free).
      const actionBar = editorArea.locator('[data-interaction-region="message-controls"]')
      await expect(actionBar, 'editor action bar must render').toBeVisible()
      const cancelBtn = actionBar.locator('button:not(.message-editor-save-btn):not(.message-editor-resend-btn)')
      await expect(cancelBtn, 'cancel control must render in the action bar').toBeVisible({ timeout: 10000 })
      await cancelBtn.click()
      await expect(editorArea, 'editor must close after Cancel').not.toBeVisible({ timeout: 10000 })
    })

    await test.step('stored block keeps the exact seeded content', async () => {
      const stored = await page.evaluate(
        ({ msgId }: { msgId: string }) => {
          const s = (window as any).store.getState()
          const msg = s.messages?.entities?.[msgId]
          const blockId: string = msg?.blocks?.[0] ?? ''
          return blockId ? ((s.messageBlocks?.entities?.[blockId]?.content as string) ?? null) : null
        },
        { msgId: seeded.assistantMsgId }
      )
      expect(stored, 'cancel must not write the staged draft').toBe(seeded.originalContent)
      expect(stored).not.toContain(`cancel-probe-${tag}`)
    })
  })

  test('resize handle drag is session-only and resets on reopen and relaunch', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR RESIZE SESSION (INTEGRATED): real pointer drags from the top-edge handle grow/shrink the resize surface while the bottom message-controls region stays stationary (REGION 2px / TRANSITION 4px oracle, never weakened), keyboard ArrowUp/Down/Home/End adjust height, the committed height is session-only (kept for this edit session, never overwritten by text edits), and Cancel + edit reopen plus a same-profile application relaunch via relaunchSameProfile both reset to the content-adaptive height — no persisted height. No storage writes as evidence — gestures create the value; storage is inspected only to prove nothing was persisted.'
    })
    const page: Page = mainWindow
    const userDataDir = getUserDataDir()
    const tag = `cmr-${Date.now().toString(36)}`
    // Resize stage only: 3 tall preceding pairs (6 filler rows + 2 target =
    // 8 total inside DISPLAY_LIMIT 10) give the #messages column-reverse
    // viewport real older scroll margin, so the genuine-wheel placement below
    // can pull the top-edge grip out from under sticky chrome. All other
    // cases keep the 2-row override.
    const seeded = await test.step('seed long assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag, { fillerPairs: 3 }))

    const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () =>
      openAssistantEditor(page, seeded.assistantMsgId))

    await test.step('prove actual older scroll margin for genuine wheel placement', async () => {
      const dims = await page
        .evaluate(() => {
          const el = document.getElementById('messages') as HTMLElement | null
          if (!el) return null
          return { sh: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop }
        })
        .catch(() => null)
      expect(dims, '#messages must expose scroll geometry').not.toBeNull()
      const max = dims!.sh - dims!.ch
      test.info().annotations.push({
        type: 'cme-resize-scroll-margin',
        description: `messages sh/ch=${dims!.sh}/${dims!.ch} max=${max} top=${dims!.top}`
      })
      expect(max, 'resize stage must carry actual older scroll margin (positive max)').toBeGreaterThan(0)
    })

    // Outer-viewport wheel point + handle hit-test are shared E2E helpers
    // (findOuterChatGutterWheelPoint/probeResizeHandleHit in
    // tests/e2e/utils/message-editor.ts) with the same ownership semantics;
    // per-gesture placement below keeps its own baselines/annotations.

    /**
     * Genuine-user placement precondition for the top-edge grip: shared
     * helper (see ensureEditorHandleUnoccluded) with this test's annotation
     * prefix. Per-gesture placement below keeps its own baselines.
     */
    async function ensureResizeHandleUnoccluded(): Promise<{ cx: number; cy: number }> {
      return ensureEditorHandleUnoccluded(page, editorArea, 'cme-resize')
    }

    async function dragHandle(dy: number): Promise<{ worst: number; pre: number | null; post: number | null }> {
      // Per-gesture placement: the viewport keeper may reposition the frame
      // under the nav between gestures, so every drag re-establishes the
      // genuine-wheel central hit-test before touching the pointer.
      await ensureResizeHandleUnoccluded()
      // Settle, then recapture the geometry baseline AFTER the intentional
      // reposition — never compare against the pre-reposition baseline.
      await page.waitForTimeout(200)
      const handle = resizeHandle(editorArea)
      const box = await handle.boundingBox()
      if (!box) throw new Error('resize handle has no geometry')
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      const pre = await editorRegionOffset(page, seeded.assistantMsgId)
      const samples: number[] = []
      const gate = await probeResizeHandleHit(page, cx, cy)
      expect(gate.hit, `pointer gesture must start on the handle (got ${gate.describe})`).toBe(true)
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      try {
        const steps = 12
        for (let i = 1; i <= steps; i++) {
          await page.mouse.move(cx, cy + (dy * i) / steps, { steps: 2 })
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          )
          const cur = await editorRegionOffset(page, seeded.assistantMsgId)
          if (pre !== null && cur !== null) samples.push(Math.abs(cur - pre))
        }
      } finally {
        await page.mouse.up()
      }
      await page.waitForTimeout(300)
      const post = await editorRegionOffset(page, seeded.assistantMsgId)
      return { worst: samples.length > 0 ? Math.max(...samples) : Number.NaN, pre, post }
    }

    function expectRegionStationary(label: string, pre: number | null, post: number | null, worst: number): void {
      expect(pre, `${label}: controls region must be measurable before drag`).not.toBeNull()
      expect(post, `${label}: controls region must be measurable after drag`).not.toBeNull()
      const drift = pre !== null && post !== null ? Math.abs(post - pre) : Number.NaN
      test.info().annotations.push({
        type: 'cme-resize-geometry',
        description: `${label} pre=${pre !== null ? Math.round(pre) : 'null'} post=${post !== null ? Math.round(post) : 'null'} drift=${Number.isFinite(drift) ? drift.toFixed(1) : 'NaN'} worst=${Number.isFinite(worst) ? worst.toFixed(1) : 'NaN'}`
      })
      expect(drift, `${label}: bottom message-controls region stays stationary`).toBeLessThanOrEqual(REGION_TOL)
      expect(worst, `${label}: painted top-drag transition frames never jump`).toBeLessThanOrEqual(TRANSITION_TOL)
    }

    const h0 = await test.step('prove handle contract and read adaptive open height', async () => {
      const handle = resizeHandle(editorArea)
      await expect(handle, 'resize handle must render').toBeVisible({ timeout: 10000 })
      await expect(handle, 'handle role is separator').toHaveAttribute('role', 'separator')
      await expect(handle, 'handle orientation is horizontal').toHaveAttribute('aria-orientation', 'horizontal')
      await expect(handle, 'handle must be keyboard-focusable (tabIndex 0)').toHaveAttribute('tabindex', '0')
      const h = await surfaceHeight(editorArea)
      expect(h, 'adaptive open surface height is usable').toBeGreaterThan(0)
      const winH: number = await page.evaluate(() => window.innerHeight)
      test.info().annotations.push({
        type: 'cme-resize-default',
        description: `adaptive-open=${Math.round(h)} winH=${Math.round(winH)} max52vh=${Math.round(winH * 0.52)}`
      })
      return h
    })

    await test.step('grip sits on the OUTERMOST bordered frame top (no inner row)', async () => {
      // Strict OUTER-grip contract: absolutely positioned on the outermost
      // bordered editor frame top border, not an internal flex row between
      // the toolbar and the content. CONFLICT (report, do not weaken): current
      // production renders the handle as an internal 10px flex row below the
      // toolbar, so position/top-alignment below FAIL until production moves it.
      const handle = resizeHandle(editorArea)
      const frame = outerEditorFrame(editorArea)
      await expect(
        frame,
        'outermost editor frame (.message-editor or message-editor-container) must render'
      ).toBeVisible({
        timeout: 10000
      })
      const position: string | null = await handle
        .evaluate((el) => getComputedStyle(el as HTMLElement).position)
        .catch(() => null)
      expect(position, 'grip must be absolutely positioned on the outer border (no inner layout row)').toBe('absolute')
      const handleBox = await handle.boundingBox()
      const frameBox = await frame.boundingBox()
      expect(handleBox, 'grip must have geometry').not.toBeNull()
      expect(frameBox, 'outer frame must have geometry').not.toBeNull()
      const topDelta = Math.abs(handleBox!.y - frameBox!.y)
      expect(
        topDelta,
        `grip top edge aligns to the OUTERMOST bordered frame top within a few px (handleY=${handleBox!.y.toFixed(1)} frameY=${frameBox!.y.toFixed(1)})`
      ).toBeLessThanOrEqual(6)
      const leftDelta = Math.abs(handleBox!.x - frameBox!.x)
      const rightDelta = Math.abs(handleBox!.x + handleBox!.width - (frameBox!.x + frameBox!.width))
      expect(leftDelta, 'grip spans the full outer width (left)').toBeLessThanOrEqual(8)
      expect(rightDelta, 'grip spans the full outer width (right)').toBeLessThanOrEqual(8)
      // Not an internal row: the grip sits above the toolbar, and the content
      // surface is not pushed down by a reserved handle row.
      const toolbarBox = await editorArea.locator('[data-testid="message-editor-mode-btn"]').boundingBox()
      expect(toolbarBox, 'toolbar mode toggle must have geometry').not.toBeNull()
      expect(handleBox!.y, 'outer grip sits above the toolbar (internal-row handle would sit below it)').toBeLessThan(
        toolbarBox!.y
      )
      const surfaceBox = await resizeSurface(editorArea).boundingBox()
      expect(surfaceBox, 'resize surface must have geometry').not.toBeNull()
      test.info().annotations.push({
        type: 'cme-grip-outer',
        description: `topDelta=${topDelta.toFixed(1)} leftDelta=${leftDelta.toFixed(1)} rightDelta=${rightDelta.toFixed(1)} handleH=${handleBox!.height.toFixed(1)} position=${position}`
      })
    })

    await test.step('real pointer drags grow and shrink the surface', async () => {
      const winH: number = await page.evaluate(() => window.innerHeight)
      const maxAllowed = winH * 0.52
      // Production single-bounds mirror (messageEditorHeight.ts, read-only
      // here): max is the floored 52vh cap, min is the single one-line floor
      // (40). Pointer height delta is 1:1 (-dy) with the committed value
      // Math.round'ed; the displayed surface resolves at use.
      const prodMax = Math.max(40, Math.floor(winH * 0.52))
      const prodMin = Math.min(40, prodMax)
      const clampDisplay = (v: number): number => Math.min(prodMax, Math.max(prodMin, v))
      // Gesture-target rounding budget only (1:1 drag + Math.round commit +
      // boundingBox subpixel). Distinctness (30) and REGION/TRANSITION budgets
      // are untouched — never lowered.
      const CLAMP_TOL = 8
      if (h0 >= maxAllowed - 24) {
        // Default already at the window clamp: shrink first, then regrow to a
        // distinct height (window clamping must not reset the preference).
        // Premise fix (test-only, not production): the previous -90 regrow
        // landed ~310, only ~2px from the ~312 clamped default, contradicting
        // the >= 30 distinctness asserted below. The corrected regrow targets
        // h0 - 47 (~265 from ~312): ~45px above the shrunk/min floor (so
        // regrow > shrunk + 30 holds) and 47px below h0 (so distinct holds),
        // with ~47px of upward room left for the keyboard ArrowUp (+8) probe.
        const r1 = await dragHandle(150)
        const hShrunk = await surfaceHeight(editorArea)
        expect(hShrunk, 'downward drag shrinks the surface').toBeLessThan(h0 - 40)
        expectRegionStationary('shrink-first', r1.pre, r1.post, r1.worst)
        const targetRegrow = clampDisplay(Math.max(h0 - 47, hShrunk + 45))
        const regrowDy = -(targetRegrow - hShrunk)
        test.info().annotations.push({
          type: 'cme-resize-gesture-math',
          description: `max-branch h0=${Math.round(h0)} shrunk=${Math.round(hShrunk)} target=${Math.round(targetRegrow)} dy=${Math.round(regrowDy)} min=${prodMin} max=${prodMax}`
        })
        const r2 = await dragHandle(regrowDy)
        const hRegrown = await surfaceHeight(editorArea)
        expect(hRegrown, 'upward drag regrows the surface').toBeGreaterThan(hShrunk + 30)
        expectRegionStationary('regrow', r2.pre, r2.post, r2.worst)
        expect(
          Math.abs(hRegrown - targetRegrow),
          `regrown height matches the clamped gesture target (target=${targetRegrow.toFixed(1)} actual=${hRegrown.toFixed(1)})`
        ).toBeLessThanOrEqual(CLAMP_TOL)
        expect(
          Math.abs(hRegrown - h0),
          'regrown height is distinct from the adaptive open height'
        ).toBeGreaterThanOrEqual(30)
      } else {
        const r1 = await dragHandle(-150)
        const hGrown = await surfaceHeight(editorArea)
        expect(hGrown, 'upward drag grows the surface').toBeGreaterThan(h0 + 40)
        expectRegionStationary('grow', r1.pre, r1.post, r1.worst)
        // Final stays in [min, max] with upward room for the keyboard ArrowUp
        // (+8) probe, >= 30 below the grown display (shrink proof) and >= 30
        // from h0 (distinctness). Prefer h0 + 60 above (== the historical
        // -150/+90 net when unclamped); when the grown display clamps near max
        // the above slot collapses, so fall back below to h0 - 47 (distinct 47,
        // large upward room). The dy is derived from the OBSERVED grown display
        // — never an assumed full-snap anchor.
        const ROOM = 16
        let targetFinal = h0 + 60
        const aboveOk = targetFinal <= prodMax - ROOM && targetFinal <= hGrown - 30 && targetFinal >= prodMin
        if (!aboveOk) targetFinal = h0 - 47
        targetFinal = clampDisplay(targetFinal)
        const shrinkDy = hGrown - targetFinal
        test.info().annotations.push({
          type: 'cme-resize-gesture-math',
          description: `grow-branch h0=${Math.round(h0)} grown=${Math.round(hGrown)} target=${Math.round(targetFinal)} dy=${Math.round(shrinkDy)} aboveOk=${aboveOk} min=${prodMin} max=${prodMax}`
        })
        const r2 = await dragHandle(shrinkDy)
        const hShrunk = await surfaceHeight(editorArea)
        expect(hShrunk, 'downward drag shrinks the surface').toBeLessThan(hGrown - 30)
        expectRegionStationary('shrink', r2.pre, r2.post, r2.worst)
        expect(
          Math.abs(hShrunk - targetFinal),
          `final height matches the clamped gesture target (target=${targetFinal.toFixed(1)} actual=${hShrunk.toFixed(1)})`
        ).toBeLessThanOrEqual(CLAMP_TOL)
        expect(Math.abs(hShrunk - h0), 'final dragged height is distinct from adaptive open').toBeGreaterThanOrEqual(30)
      }
    })

    await test.step('keyboard arrows/Home/End adjust height', async () => {
      const handle = resizeHandle(editorArea)
      await handle.evaluate((el) => (el as HTMLElement).focus())
      const focused = await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.getAttribute('data-testid')
      )
      expect(focused, 'resize handle must be keyboard-focusable').toBe('message-editor-resize-handle')
      const hKb = await surfaceHeight(editorArea)
      await page.keyboard.press('ArrowUp')
      await page.waitForTimeout(300)
      const hUp = await surfaceHeight(editorArea)
      expect(hUp, 'ArrowUp grows the editor').toBeGreaterThan(hKb)
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(300)
      const hDown = await surfaceHeight(editorArea)
      expect(hDown, 'ArrowDown shrinks the editor').toBeLessThan(hUp)
      await page.keyboard.press('Home')
      await page.waitForTimeout(300)
      const hHome = await surfaceHeight(editorArea)
      expect(hHome, 'Home goes toward minimum').toBeLessThanOrEqual(hDown)
      await page.keyboard.press('End')
      await page.waitForTimeout(300)
      const hEnd = await surfaceHeight(editorArea)
      expect(hEnd, 'End goes toward maximum').toBeGreaterThanOrEqual(hHome)
      test.info().annotations.push({
        type: 'cme-resize-keyboard',
        description: `kb=${Math.round(hKb)} up=${Math.round(hUp)} down=${Math.round(hDown)} home=${Math.round(hHome)} end=${Math.round(hEnd)}`
      })
    })

    await test.step('no height persistence is written (session-only by design)', async () => {
      // The editor height is session-only: gestures above must not leave a
      // persisted height behind. Scan renderer-local storage for any
      // message-editor height key and require its absence.
      const matchingKeys: string[] = await page
        .evaluate(() => {
          try {
            const out: string[] = []
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)
              if (k && /message-editor|message\.editor/i.test(k)) out.push(k)
            }
            return out
          } catch {
            return []
          }
        })
        .catch(() => [])
      test.info().annotations.push({
        type: 'cme-resize-storage',
        description: `renderer-local message-editor keys after gestures: ${matchingKeys.join(',') || 'none (session-only)'}`
      })
      expect(matchingKeys, 'no message-editor height may be persisted').toEqual([])
    })

    await test.step('Cancel keeps content; reopen resets to the adaptive height', async () => {
      // Stage a manual height distinct from the adaptive open height: Home
      // goes to the single one-line floor while the long draft adapts near
      // the 52vh maximum, so reset is observable (not an accidental equality).
      const handle = resizeHandle(editorArea)
      await handle.evaluate((el) => (el as HTMLElement).focus())
      await page.keyboard.press('Home')
      await page.waitForTimeout(300)
      const hManual = await surfaceHeight(editorArea)
      expect(
        Math.abs(hManual - h0),
        `one-line floor (${Math.round(hManual)}) must be distinct from the adaptive open height (${Math.round(h0)})`
      ).toBeGreaterThanOrEqual(30)
      const actionBar = editorArea.locator('[data-interaction-region="message-controls"]')
      await expect(actionBar, 'editor action bar must render').toBeVisible()
      const cancelBtn = actionBar.locator('button:not(.message-editor-save-btn):not(.message-editor-resend-btn)')
      await expect(cancelBtn, 'cancel control must render in the action bar').toBeVisible({ timeout: 10000 })
      await cancelBtn.click()
      await expect(editorArea, 'editor must close after Cancel').not.toBeVisible({ timeout: 10000 })
      const stored = await page.evaluate(
        ({ msgId }: { msgId: string }) => {
          const s = (window as unknown as { store: { getState: () => any } }).store.getState()
          const msg = s.messages?.entities?.[msgId]
          const blockId: string = msg?.blocks?.[0] ?? ''
          return blockId ? ((s.messageBlocks?.entities?.[blockId]?.content as string) ?? null) : null
        },
        { msgId: seeded.assistantMsgId }
      )
      expect(stored, 'resize-only flow must not rewrite stored content').toBe(seeded.originalContent)
      const reopened = await openAssistantEditor(page, seeded.assistantMsgId)
      const hReopened = await surfaceHeight(reopened.editorArea)
      test.info().annotations.push({
        type: 'cme-resize-reopen',
        description: `adaptive-open=${Math.round(h0)} manual=${Math.round(hManual)} reopened=${Math.round(hReopened)}`
      })
      // Same content reopens adaptive: the closed session leaves nothing
      // behind, so the reopened height returns to the adaptive open height —
      // never the staged manual height.
      expect(Math.abs(hReopened - h0), 'reopened editor resets to the adaptive height').toBeLessThanOrEqual(8)
      expect(
        Math.abs(hReopened - hManual),
        'reopened editor must not restore the closed session manual height'
      ).toBeGreaterThanOrEqual(30)
      // Close the reopened editor so the relaunch starts from a clean state.
      const reopenBar = reopened.editorArea.locator('[data-interaction-region="message-controls"]')
      await reopenBar.locator('button:not(.message-editor-save-btn):not(.message-editor-resend-btn)').click()
      await expect(reopened.editorArea, 'reopened editor must close after Cancel').not.toBeVisible({ timeout: 10000 })
    })

    await test.step('same-profile relaunch resets to the adaptive height', async () => {
      await electronApp.close()
      const relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
      try {
        const page2 = relaunched.page
        await waitForAppReady(page2)
        await activateTopic(page2, seeded.topicId, 2)
        const opened2 = await openAssistantEditor(page2, seeded.assistantMsgId)
        const hRelaunched = await surfaceHeight(opened2.editorArea)
        test.info().annotations.push({
          type: 'cme-resize-relaunch',
          description: `adaptive-open=${Math.round(h0)} relaunched=${Math.round(hRelaunched)}`
        })
        // No height survives a relaunch: the fresh session measures the same
        // unchanged content back to the adaptive open height.
        expect(Math.abs(hRelaunched - h0), 'relaunched app resets to the adaptive height').toBeLessThanOrEqual(16)
      } finally {
        await closeElectronWithExactCleanup(userDataDir, {
          close: () => relaunched.app.close(),
          findExactProcesses: findProcessesByUserDataDir,
          terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
        })
      }
    })
  })

  test('short top-of-viewport message opens adaptive and grows/shrinks with edits', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR ADAPTIVE HEIGHT (INTEGRATED): a short assistant draft at the top of the viewport opens small (1–2 lines plus padding, fully visible — never hidden by the edit-open layout change), grows with real typing up to the 52vh maximum, shrinks back when content is deleted, and keeps the caret usable (appended input saves exactly through Main).'
    })
    const page: Page = mainWindow
    const tag = `cma-${Date.now().toString(36)}`
    const shortContent = `short answer ${tag}`
    const seeded = await test.step('seed short assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag, { assistantContent: shortContent }))
    const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () =>
      openAssistantEditor(page, seeded.assistantMsgId))

    const hShort = await test.step('short draft opens small and fully visible', async () => {
      const h = await surfaceHeight(editorArea)
      const gap = await inputBottomGap(editorArea)
      const winH: number = await page.evaluate(() => window.innerHeight)
      test.info().annotations.push({
        type: 'cme-adaptive-short',
        description: `short surface=${Math.round(h)} gap=${Number.isFinite(gap) ? gap.toFixed(1) : 'NaN'} winH=${Math.round(winH)} max52vh=${Math.round(winH * 0.52)}`
      })
      // Single one-line floor (messageEditorHeight.ts): one rendered text
      // line plus normal padding/slack — never a large empty input area.
      expect(h, 'short draft opens at the one-line floor').toBeLessThanOrEqual(64)
      expect(h, 'short draft surface covers its rendered line').toBeGreaterThanOrEqual(24)
      // The reported-tall-input oracle: the input-region bottom sits within
      // normal padding/one-line slack of the rendered text. A ~70px gap like
      // the reported failure never passes; NaN (unreadable DOM) never passes.
      expect(Number.isNaN(gap), 'input-region gap must be measurable').toBe(false)
      expect(gap, 'one-line input keeps only normal slack below the text').toBeLessThanOrEqual(32)
      // Open visibility: the whole editor surface stays inside the #messages
      // viewport — short content near the top is never hidden by edit-open.
      const containerBox = await page.locator('#messages').first().boundingBox()
      const surfaceBox = await resizeSurface(editorArea).boundingBox()
      expect(containerBox, '#messages must have geometry').not.toBeNull()
      expect(surfaceBox, 'resize surface must have geometry').not.toBeNull()
      expect(surfaceBox!.y, 'surface top stays inside the viewport').toBeGreaterThanOrEqual(containerBox!.y - 4)
      expect(surfaceBox!.y + surfaceBox!.height, 'surface bottom stays inside the viewport').toBeLessThanOrEqual(
        containerBox!.y + containerBox!.height + 4
      )
      return h
    })

    await test.step('real typing grows the surface up to the 52vh maximum', async () => {
      const growth = Array.from({ length: 40 }, (_, i) => `grown body line ${i} ${tag}`).join('\n')
      await appendEditorText(page, editorArea, `\n${growth}`)
      await page.waitForFunction(
        (min: number) => {
          const el = document.querySelector('[data-testid="message-editor-resize-surface"]') as HTMLElement | null
          return (el?.getBoundingClientRect().height ?? 0) > min
        },
        hShort + 100,
        { timeout: 10000 }
      )
      const hGrown = await surfaceHeight(editorArea)
      const winH: number = await page.evaluate(() => window.innerHeight)
      test.info().annotations.push({
        type: 'cme-adaptive-grown',
        description: `short=${Math.round(hShort)} grown=${Math.round(hGrown)} max52vh=${Math.round(winH * 0.52)}`
      })
      expect(hGrown, 'continuous input growth enlarges the surface').toBeGreaterThan(hShort + 100)
      expect(hGrown, 'grown surface never exceeds the 52vh maximum').toBeLessThanOrEqual(winH * 0.52 + 2)
    })

    await test.step('deleting back to a short draft shrinks the surface', async () => {
      const hGrown = await surfaceHeight(editorArea)
      await replaceEditorContent(page, editorArea, 'tiny')
      await page.waitForFunction(
        (max: number) => {
          const el = document.querySelector('[data-testid="message-editor-resize-surface"]') as HTMLElement | null
          return (el?.getBoundingClientRect().height ?? Number.MAX_SAFE_INTEGER) < max
        },
        hGrown - 100,
        { timeout: 10000 }
      )
      const hShrunk = await surfaceHeight(editorArea)
      const shrunkGap = await inputBottomGap(editorArea)
      test.info().annotations.push({
        type: 'cme-adaptive-shrunk',
        description: `grown=${Math.round(hGrown)} shrunk=${Math.round(hShrunk)} gap=${Number.isFinite(shrunkGap) ? shrunkGap.toFixed(1) : 'NaN'}`
      })
      expect(hShrunk, 'deleting content shrinks the surface').toBeLessThan(hGrown - 100)
      expect(hShrunk, 'shrunk surface returns to the one-line floor').toBeLessThanOrEqual(64)
      expect(Number.isNaN(shrunkGap), 'shrunk input-region gap must be measurable').toBe(false)
      expect(shrunkGap, 'shrunk one-line input keeps only normal slack below the text').toBeLessThanOrEqual(32)
    })

    await test.step('caret stays usable after growth: appended input saves exactly', async () => {
      await replaceEditorContent(page, editorArea, shortContent)
      await appendEditorText(page, editorArea, '-tail')
      const saveBtn = editorArea.locator('.message-editor-save-btn')
      await expect(saveBtn, 'save button must render').toBeVisible()
      await saveBtn.click()
      await expect(editorArea, 'editor closes only after persistence succeeds').not.toBeVisible({ timeout: 15000 })
      const stored = await page.evaluate(
        ({ msgId }: { msgId: string }) => {
          const s = (window as unknown as { store: { getState: () => any } }).store.getState()
          const msg = s.messages?.entities?.[msgId]
          const blockId: string = msg?.blocks?.[0] ?? ''
          return blockId ? ((s.messageBlocks?.entities?.[blockId]?.content as string) ?? null) : null
        },
        { msgId: seeded.assistantMsgId }
      )
      expect(stored, 'appended caret input must save exactly').toBe(`${shortContent}-tail`)
    })

    await test.step('adaptive short below the old manual floor: pointerdown and first moves do not jump', async () => {
      // Single-resolver regression: the reopened one-line draft sits far
      // below any historical manual floor, so pointerdown plus the first
      // small movements must render continuously from the displayed height —
      // never jump tall — and the release commits the displayed final
      // effective height. A no-motion click stays adaptive.
      const reopened = await openAssistantEditor(page, seeded.assistantMsgId)
      const area = reopened.editorArea
      const hAdapt = await surfaceHeight(area)
      expect(hAdapt, 'reopened one-line draft returns to the one-line floor').toBeLessThanOrEqual(64)
      const handle = resizeHandle(area)
      const box = await handle.boundingBox()
      expect(box, 'resize handle must have geometry').not.toBeNull()
      const cx = box!.x + box!.width / 2
      const cy = box!.y + box!.height / 2
      const gate = await probeResizeHandleHit(page, cx, cy)
      expect(gate.hit, `pointer gesture must start on the handle (got ${gate.describe})`).toBe(true)
      await page.mouse.move(cx, cy)
      // No-motion click: down + up at the same point commits nothing.
      await page.mouse.down()
      await page.waitForTimeout(250)
      const hAtDown = await surfaceHeight(area)
      expect(
        Math.abs(hAtDown - hAdapt),
        'pointerdown alone never jumps (one resolver, same displayed height)'
      ).toBeLessThanOrEqual(4)
      await page.mouse.up()
      await page.waitForTimeout(250)
      const hClick = await surfaceHeight(area)
      expect(Math.abs(hClick - hAdapt), 'no-motion click stays adaptive (nothing committed)').toBeLessThanOrEqual(4)
      // First small movement: continuous from the displayed height.
      await page.mouse.down()
      try {
        await page.waitForTimeout(150)
        await page.mouse.move(cx, cy - 10, { steps: 3 })
        await page.waitForTimeout(250)
        const hFirst = await surfaceHeight(area)
        test.info().annotations.push({
          type: 'cme-adaptive-nojump',
          description: `adapt=${Math.round(hAdapt)} atDown=${Math.round(hAtDown)} click=${Math.round(hClick)} first=${Math.round(hFirst)}`
        })
        expect(hFirst - hAdapt, 'first small upward move grows continuously').toBeGreaterThan(2)
        expect(hFirst - hAdapt, 'first small move never jumps to a manual floor').toBeLessThanOrEqual(20)
        await page.mouse.up()
        await page.waitForTimeout(300)
        const hFinal = await surfaceHeight(area)
        test.info().annotations.push({
          type: 'cme-adaptive-njump-final',
          description: `final=${Math.round(hFinal)}`
        })
        expect(
          Math.abs(hFinal - hFirst),
          'release commits the displayed final effective height (no snapback)'
        ).toBeLessThanOrEqual(6)
        expect(hFinal, 'committed height stays near the one-line floor (no manual-floor jump)').toBeLessThan(120)
      } finally {
        await page.mouse.up().catch(() => {})
      }
      // Manual is session-only: Cancel + reopen resets to the adaptive height.
      const actionBar = area.locator('[data-interaction-region="message-controls"]')
      const cancelBtn = actionBar.locator('button:not(.message-editor-save-btn):not(.message-editor-resend-btn)')
      await expect(cancelBtn, 'cancel control must render in the action bar').toBeVisible({ timeout: 10000 })
      await cancelBtn.click()
      await expect(area, 'editor must close after Cancel').not.toBeVisible({ timeout: 10000 })
      const again = await openAssistantEditor(page, seeded.assistantMsgId)
      const hAgain = await surfaceHeight(again.editorArea)
      test.info().annotations.push({
        type: 'cme-adaptive-reopen',
        description: `adapt=${Math.round(hAdapt)} reopened=${Math.round(hAgain)}`
      })
      expect(Math.abs(hAgain - hAdapt), 'reopened editor resets to the adaptive height').toBeLessThanOrEqual(8)
      const againBar = again.editorArea.locator('[data-interaction-region="message-controls"]')
      await againBar.locator('button:not(.message-editor-save-btn):not(.message-editor-resend-btn)').click()
      await expect(again.editorArea, 'reopened editor must close after Cancel').not.toBeVisible({ timeout: 10000 })
    })
  })

  test('pointer release outside the editor commits the final height with no snapback', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR OUTSIDE-RELEASE (INTEGRATED): a real drag from the top-edge handle whose pointerup lands well below/outside the editor surface commits the last displayed height — the surface never snaps back to the pre-drag height.'
    })
    const page: Page = mainWindow
    const tag = `cmo-${Date.now().toString(36)}`
    const seeded = await test.step('seed long assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag, { fillerPairs: 3 }))
    const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () =>
      openAssistantEditor(page, seeded.assistantMsgId))

    const h0 = await surfaceHeight(editorArea)
    await test.step('genuine-wheel placement onto the unoccluded handle', async () => {
      await ensureEditorHandleUnoccluded(page, editorArea, 'cme-outside')
    })
    // Settle, then recapture every geometry baseline AFTER the intentional
    // reposition — never gesture from a pre-reposition point.
    await page.waitForTimeout(200)
    const handle = resizeHandle(editorArea)
    const box = await handle.boundingBox()
    if (!box) throw new Error('resize handle has no geometry')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const gate = await probeResizeHandleHit(page, cx, cy)
    expect(gate.hit, `pointer gesture must start on the handle (got ${gate.describe})`).toBe(true)

    // Drag toward the side with real room (the long draft opens adaptive near
    // the 52vh maximum, so upward from there would clamp): the leg stays
    // honestly unclamped with a 16px margin, then the pointer moves to a
    // point clearly OUTSIDE the editor surface and releases there. The up
    // event lands outside the editor, and the committed height must equal the
    // last displayed height — never the pre-drag height.
    const winH: number = await page.evaluate(() => window.innerHeight)
    const prodMax = Math.max(40, Math.floor(winH * 0.52))
    const prodMin = Math.min(40, prodMax)
    const roomDown = h0 - prodMin
    const roomUp = prodMax - h0
    const dir = roomDown >= roomUp ? 1 : -1
    const amp = Math.min(120, (dir === 1 ? roomDown : roomUp) - 16)
    expect(amp, 'the chosen drag direction must keep 16px clamp margins').toBeGreaterThanOrEqual(56)
    test.info().annotations.push({
      type: 'cme-outside-leg',
      description: `start=${Math.round(h0)} winH=${Math.round(winH)} min=${prodMin} max=${prodMax} dir=${dir === 1 ? 'down' : 'up'} amp=${Math.round(amp)}`
    })
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    try {
      const steps = 10
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(cx, cy + (dir * amp * i) / steps, { steps: 2 })
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        )
      }
      const hLeg = await surfaceHeight(editorArea)
      expect(Math.abs(hLeg - h0), 'drag leg moves the surface unclamped').toBeGreaterThan(40)
      // Release point clearly OUTSIDE the post-leg surface but inside the
      // window: continue the leg direction when that side fits (the proof
      // never silently clamps), else take whichever side fits and note it.
      const legBox = await resizeSurface(editorArea).boundingBox()
      if (!legBox) throw new Error('resize surface lost geometry mid-gesture')
      const viewport = await viewportSize(page)
      const belowY = legBox.y + legBox.height + 80
      const aboveY = legBox.y - 80
      const belowOk = belowY <= viewport.height - 10
      const aboveOk = aboveY >= 10
      let releaseY = 0
      let continuesDir = true
      if (dir === 1) {
        if (belowOk) releaseY = belowY
        else if (aboveOk) {
          releaseY = aboveY
          continuesDir = false
        } else throw new Error('no in-window outside release point (surface fills the window)')
      } else {
        if (aboveOk) releaseY = aboveY
        else if (belowOk) {
          releaseY = belowY
          continuesDir = false
        } else throw new Error('no in-window outside release point (surface fills the window)')
      }
      expect(
        releaseY < legBox.y || releaseY > legBox.y + legBox.height,
        'release point must land outside the surface bounds'
      ).toBe(true)
      await page.mouse.move(cx, releaseY, { steps: 6 })
      await page.waitForTimeout(300)
      const hOutside = await surfaceHeight(editorArea)
      test.info().annotations.push({
        type: 'cme-outside-release',
        description: `start=${Math.round(h0)} leg=${Math.round(hLeg)} outside=${Math.round(hOutside)} releaseY=${Math.round(releaseY)} continuesDir=${continuesDir}`
      })
      await page.mouse.up()
      await page.waitForTimeout(300)
      const hFinal = await surfaceHeight(editorArea)
      test.info().annotations.push({
        type: 'cme-outside-release-final',
        description: `final=${Math.round(hFinal)}`
      })
      expect(
        Math.abs(hFinal - hOutside),
        'outside/below-editor release commits the final displayed height (no snapback)'
      ).toBeLessThanOrEqual(4)
      // The release move continues the leg direction, so the committed
      // height stays away from the pre-drag height (fallback side skips this:
      // the commit proof above is the contract).
      if (continuesDir) {
        if (dir === 1) {
          expect(hFinal, 'committed height differs from the pre-drag height').toBeLessThan(h0 - 20)
        } else {
          expect(hFinal, 'committed height differs from the pre-drag height').toBeGreaterThan(h0 + 20)
        }
      }
    } finally {
      // Release the button if an assertion above threw mid-gesture.
      await page.mouse.up().catch(() => {})
    }
  })

  test('same-press resize reversal keeps the bottom pinned while the top tracks both legs', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR RESIZE REVERSAL (SAME-PRESS TWO LEGS, BOTH ENTRY DIRECTIONS): two native presses — press A DOWN-first (+delta then UP past the origin to -delta) and press B UP-first (-delta then DOWN past the origin to +delta), mouse up ONLY after BOTH legs per press. Outer editor-frame TOP and BOTTOM plus message-controls sampled EVERY rAF step with #messages top/sh/ch and physical boundaries. Fixed captured BOTTOM stays REG2 final / TRANS4 every-frame, TOP moves the correct sign with delta proportional to the display height, pointer buttons stay 1 with a single pointerId per press, no hidden early mouseup/cancel/reset, no release jump. Initial height is the public-keyboard computed-range midpoint (~(min+max)/2, staged ±8) with leg amplitude delta=min(32,floor(range/2)-18) capped by min(actualH-min,max-actualH)-16 (>=16, 16px clamp margins) so both legs are honestly unclamped; clamp distances are quantified, never a false unclamped promise. Read-only DOM probes only.'
    })
    const page: Page = mainWindow
    const tag = `cmv-${Date.now().toString(36)}`
    const seeded = await test.step('seed long assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag, { fillerPairs: 3 }))
    const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () =>
      openAssistantEditor(page, seeded.assistantMsgId))

    await test.step('prove actual older scroll margin for genuine wheel placement', async () => {
      const dims = await page
        .evaluate(() => {
          const el = document.getElementById('messages') as HTMLElement | null
          if (!el) return null
          return { sh: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop }
        })
        .catch(() => null)
      expect(dims, '#messages must expose scroll geometry').not.toBeNull()
      expect(dims!.sh - dims!.ch, 'resize reversal needs actual older scroll margin').toBeGreaterThan(0)
      test.info().annotations.push({
        type: 'cme-reversal-scroll-margin',
        description: `messages sh/ch=${dims!.sh}/${dims!.ch} top=${dims!.top}`
      })
    })

    // Outer-viewport wheel point + handle hit-test reuse the shared E2E
    // helpers (findOuterChatGutterWheelPoint/probeResizeHandleHit) with the
    // same ownership semantics; reversal keeps its own midrange staging,
    // per-press frames, and pointer-trace oracle below.

    async function ensureReversalHandleUnoccluded(): Promise<{ cx: number; cy: number }> {
      const container = page.locator('#messages').first()
      const handle = resizeHandle(editorArea)
      const frame = outerEditorFrame(editorArea)
      for (let attempt = 0; attempt < 3; attempt++) {
        const containerBox = await container.boundingBox()
        if (!containerBox) throw new Error('#messages has no geometry')
        const handleBox = await handle.boundingBox()
        if (!handleBox) throw new Error('resize handle has no geometry')
        const frameBox = await frame.boundingBox().catch(() => null)
        const cx = handleBox.x + handleBox.width / 2
        const cy = handleBox.y + handleBox.height / 2
        const probe = await probeResizeHandleHit(page, cx, cy)
        const topEdge = frameBox ? frameBox.y : handleBox.y
        const topSafe = containerBox.y + 72
        const bottomSafe = containerBox.y + containerBox.height - 96
        const frameTopSafe = containerBox.y + 48
        if (cy >= topSafe && cy <= bottomSafe && topEdge >= frameTopSafe && topEdge <= bottomSafe && probe.hit) {
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          )
          await page.waitForTimeout(200)
          const reBox = await handle.boundingBox()
          if (!reBox) throw new Error('resize handle lost geometry after settle')
          const rx = reBox.x + reBox.width / 2
          const ry = reBox.y + reBox.height / 2
          const reProbe = await probeResizeHandleHit(page, rx, ry)
          expect(reProbe.hit, `resize handle center must hit-test to the handle (got ${reProbe.describe})`).toBe(true)
          return { cx: rx, cy: ry }
        }
        const outer = await findOuterChatGutterWheelPoint(page)
        const topBefore: number = await page
          .evaluate(() => (document.getElementById('messages') as HTMLElement | null)?.scrollTop ?? -9999)
          .catch(() => -9999)
        await page.mouse.move(outer.x, outer.y)
        await page.waitForTimeout(120)
        if (cy < topSafe + 40 || topEdge < frameTopSafe) {
          await page.mouse.wheel(0, -160)
        } else {
          await page.mouse.wheel(0, 160)
        }
        await page.waitForTimeout(260)
        const topAfter: number = await page
          .evaluate(() => (document.getElementById('messages') as HTMLElement | null)?.scrollTop ?? -9999)
          .catch(() => -9999)
        test.info().annotations.push({
          type: 'cme-reversal-outer-wheel',
          description: `attempt=${attempt} topBefore=${topBefore} topAfter=${topAfter}`
        })
      }
      throw new Error('resize handle never reached an unoccluded central hit-test via genuine outer wheels')
    }

    interface ReversalFrame {
      frameTop: number | null
      frameBottom: number | null
      controls: number | null
      msgTop: number
      msgSh: number
      msgCh: number
    }

    async function readReversalFrame(): Promise<ReversalFrame> {
      return page
        .evaluate((id: string) => {
          const container = document.getElementById('messages') as HTMLElement | null
          if (!container)
            return { frameTop: null, frameBottom: null, controls: null, msgTop: NaN, msgSh: NaN, msgCh: NaN }
          const c = container.getBoundingClientRect()
          const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          const row = document.querySelector(`#messages [data-message-id="${esc}"]`) as HTMLElement | null
          const frame =
            (row?.querySelector('[data-testid="message-editor-container"], .message-editor') as HTMLElement | null) ??
            null
          const controls = row?.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null
          const fr = frame ? frame.getBoundingClientRect() : null
          const cr = controls ? controls.getBoundingClientRect() : null
          return {
            frameTop: fr ? fr.top - c.top : null,
            frameBottom: fr ? fr.bottom - c.top : null,
            controls: cr && cr.width > 0 && cr.height > 0 ? cr.bottom - c.top : null,
            msgTop: container.scrollTop,
            msgSh: container.scrollHeight,
            msgCh: container.clientHeight
          }
        }, seeded.assistantMsgId)
        .catch(() => ({ frameTop: null, frameBottom: null, controls: null, msgTop: NaN, msgSh: NaN, msgCh: NaN }))
    }

    const midSetup = await test.step('public-keyboard midrange start so both legs are honestly unclamped', async () => {
      const handle = resizeHandle(editorArea)
      await handle.evaluate((el) => (el as HTMLElement).focus())
      const winH: number = await page.evaluate(() => window.innerHeight)
      const prodMax = Math.max(40, Math.floor(winH * 0.52))
      const prodMin = Math.min(40, prodMax)
      const range = prodMax - prodMin
      expect(
        range,
        'actual computed range must allow a deterministic 16px gesture with 16px clamp margins (no arbitrary screen-height promise)'
      ).toBeGreaterThanOrEqual(64)
      await page.keyboard.press('Home')
      await page.waitForTimeout(300)
      const hMin = await surfaceHeight(editorArea)
      await page.keyboard.press('End')
      await page.waitForTimeout(300)
      const hMax = await surfaceHeight(editorArea)
      const midTarget = (prodMin + prodMax) / 2
      // Drive from max toward the mid target with public ArrowDown steps only (8px per step).
      const needDown = Math.max(0, Math.round((hMax - midTarget) / 8))
      for (let i = 0; i < needDown; i++) {
        await page.keyboard.press('ArrowDown')
        await page.waitForTimeout(60)
      }
      await page.waitForTimeout(300)
      const hMid = await surfaceHeight(editorArea)
      const stagingDelta = Math.min(32, Math.floor(range / 2) - 18)
      expect(
        stagingDelta,
        'computed staging amplitude stays positive for a deterministic gesture'
      ).toBeGreaterThanOrEqual(16)
      const actualDelta = Math.min(hMid - prodMin, prodMax - hMid) - 16
      expect(
        actualDelta,
        'actual mid view keeps 16px clamp margins on both sides for the staged amplitude'
      ).toBeGreaterThanOrEqual(16)
      const delta = Math.min(stagingDelta, Math.floor(actualDelta))
      expect(delta, 'leg amplitude stays positive (>=16) with 16px min/max margins').toBeGreaterThanOrEqual(16)
      test.info().annotations.push({
        type: 'cme-reversal-midrange',
        description: `winH=${Math.round(winH)} prodMin=${prodMin} prodMax=${prodMax} range=${range} hMin=${Math.round(hMin)} hMax=${Math.round(hMax)} midTarget=${Math.round(midTarget)} hMid=${Math.round(hMid)} stepsDown=${needDown} delta=${delta}`
      })
      expect(
        Math.abs(hMid - midTarget),
        'midrange start sits at the computed (min+max)/2 via public keyboard (Arrow steps of 8)'
      ).toBeLessThanOrEqual(8)
      return { prodMin, prodMax, hMid, delta, midTarget }
    })

    async function installReversalTrace(): Promise<void> {
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>
        ;(w as Record<string, unknown>).__reversalTrace = []
        const trace = (w as Record<string, unknown>).__reversalTrace as Array<Record<string, unknown>>
        const onDown = (e: PointerEvent): void => {
          trace.push({ kind: 'down', buttons: e.buttons, pointerId: e.pointerId, y: e.clientY })
        }
        const onMove = (e: PointerEvent): void => {
          if (e.buttons !== 0) trace.push({ kind: 'move', buttons: e.buttons, pointerId: e.pointerId, y: e.clientY })
        }
        const onUp = (e: PointerEvent): void => {
          trace.push({ kind: 'up', buttons: e.buttons, pointerId: e.pointerId, y: e.clientY })
        }
        const onCancel = (): void => {
          trace.push({ kind: 'cancel' })
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('pointermove', onMove, true)
        document.addEventListener('pointerup', onUp, true)
        document.addEventListener('pointercancel', onCancel, true)
        ;(w as Record<string, unknown>).__reversalCleanup = () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('pointermove', onMove, true)
          document.removeEventListener('pointerup', onUp, true)
          document.removeEventListener('pointercancel', onCancel, true)
        }
      })
    }

    async function readReversalTrace(): Promise<Array<Record<string, unknown>>> {
      return page
        .evaluate(() => {
          const w = window as unknown as Record<string, unknown>
          return Array.isArray(w.__reversalTrace) ? (w.__reversalTrace.slice() as Array<Record<string, unknown>>) : []
        })
        .catch(() => [])
    }

    async function cleanupReversalTrace(): Promise<void> {
      await page
        .evaluate(() => {
          try {
            ;(window as unknown as Record<string, () => void>).__reversalCleanup?.()
          } catch {}
        })
        .catch(() => {})
    }

    async function nextReversalFrame(): Promise<void> {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
    }

    async function returnReversalToMidrange(reason: string): Promise<number> {
      await page.waitForTimeout(300)
      const hCur = await surfaceHeight(editorArea)
      const need = Math.round((hCur - midSetup.midTarget) / 8)
      await resizeHandle(editorArea).evaluate((el) => (el as HTMLElement).focus())
      if (need > 0) {
        for (let i = 0; i < need; i++) {
          await page.keyboard.press('ArrowDown')
          await page.waitForTimeout(60)
        }
      } else {
        for (let i = 0; i < -need; i++) {
          await page.keyboard.press('ArrowUp')
          await page.waitForTimeout(60)
        }
      }
      await page.waitForTimeout(300)
      const hBack = await surfaceHeight(editorArea)
      test.info().annotations.push({
        type: 'cme-reversal-rebaseline',
        description: `${reason} hCur=${Math.round(hCur)} hBack=${Math.round(hBack)} midTarget=${Math.round(midSetup.midTarget)} steps=${need}`
      })
      expect(hBack, `${reason}: public keyboard returns to the computed midrange (+8)`).toBeLessThanOrEqual(
        midSetup.midTarget + 8
      )
      expect(hBack, `${reason}: public keyboard returns to the computed midrange (-8)`).toBeGreaterThanOrEqual(
        midSetup.midTarget - 8
      )
      return hBack
    }

    async function runReversalPress(first: 'down' | 'up', pressLabel: string): Promise<void> {
      await installReversalTrace()
      const start = await ensureReversalHandleUnoccluded()
      const pre = await readReversalFrame()
      expect(pre.frameTop, `${pressLabel}: outer editor-frame TOP must be measurable before the press`).not.toBeNull()
      expect(
        pre.frameBottom,
        `${pressLabel}: outer editor-frame BOTTOM must be measurable before the press`
      ).not.toBeNull()
      expect(pre.controls, `${pressLabel}: message-controls region must be measurable before the press`).not.toBeNull()
      const hPre = await surfaceHeight(editorArea)
      const legDelta = Math.min(
        midSetup.delta,
        Math.floor(Math.min(hPre - midSetup.prodMin, midSetup.prodMax - hPre) - 16)
      )
      expect(
        legDelta,
        `${pressLabel}: actual view keeps 16px clamp margins for the staged ${midSetup.delta}px amplitude`
      ).toBeGreaterThanOrEqual(16)
      const gate = await probeResizeHandleHit(page, start.cx, start.cy)
      expect(gate.hit, `${pressLabel}: press must start on the handle (got ${gate.describe})`).toBe(true)
      const dirSign = first === 'down' ? 1 : -1
      const targetLeg1 = hPre - dirSign * legDelta
      const targetLeg2 = hPre + dirSign * legDelta
      const bottomDrifts: number[] = [0]
      const controlsDrifts: number[] = [0]
      const frames: ReversalFrame[] = []
      await page.mouse.move(start.cx, start.cy)
      await page.mouse.down()
      try {
        // Entry first frame immediately after down, before any move: entry shake is gated here, not post-hoc.
        await nextReversalFrame()
        const entry = await readReversalFrame()
        frames.push(entry)
        if (pre.frameBottom !== null && entry.frameBottom !== null)
          bottomDrifts.push(Math.abs(entry.frameBottom - pre.frameBottom))
        if (pre.controls !== null && entry.controls !== null)
          controlsDrifts.push(Math.abs(entry.controls - pre.controls))
        // Leg 1: first direction (down-first shrinks, up-first grows). 8 sub-steps, every step sampled.
        for (let i = 1; i <= 8; i++) {
          await page.mouse.move(start.cx, start.cy + (dirSign * legDelta * i) / 8, { steps: 2 })
          await nextReversalFrame()
          const cur = await readReversalFrame()
          frames.push(cur)
          if (pre.frameBottom !== null && cur.frameBottom !== null)
            bottomDrifts.push(Math.abs(cur.frameBottom - pre.frameBottom))
          if (pre.controls !== null && cur.controls !== null) controlsDrifts.push(Math.abs(cur.controls - pre.controls))
        }
        const hLeg1 = await surfaceHeight(editorArea)
        const leg1Frame = frames[frames.length - 1]
        // Leg 2: reverse past the origin (2x amplitude the other way, ending past the start).
        for (let i = 1; i <= 12; i++) {
          const y = start.cy + dirSign * legDelta - (dirSign * 2 * legDelta * i) / 12
          await page.mouse.move(start.cx, y, { steps: 2 })
          await nextReversalFrame()
          const cur = await readReversalFrame()
          frames.push(cur)
          if (pre.frameBottom !== null && cur.frameBottom !== null)
            bottomDrifts.push(Math.abs(cur.frameBottom - pre.frameBottom))
          if (pre.controls !== null && cur.controls !== null) controlsDrifts.push(Math.abs(cur.controls - pre.controls))
        }
        const hLeg2 = await surfaceHeight(editorArea)
        const topLeg1 = leg1Frame.frameTop !== null && pre.frameTop !== null ? leg1Frame.frameTop - pre.frameTop : NaN
        const post = frames[frames.length - 1]
        const topLeg2 = post.frameTop !== null && pre.frameTop !== null ? post.frameTop - pre.frameTop : NaN
        test.info().annotations.push({
          type: 'cme-reversal-legs',
          description: `${pressLabel} first=${first} delta=${legDelta} hPre=${Math.round(hPre)} hLeg1=${Math.round(hLeg1)} hLeg2=${Math.round(hLeg2)} topLeg1=${Number.isFinite(topLeg1) ? topLeg1.toFixed(1) : 'NaN'} topLeg2=${Number.isFinite(topLeg2) ? topLeg2.toFixed(1) : 'NaN'} n=${frames.length}`
        })
        if (first === 'down') {
          expect(hLeg1, `${pressLabel}: leg1 down shrinks the display height`).toBeLessThan(hPre - 16)
          expect(topLeg1, `${pressLabel}: leg1 TOP moves down while the bottom stays pinned`).toBeGreaterThan(0)
        } else {
          expect(hLeg1, `${pressLabel}: leg1 up grows the display height`).toBeGreaterThan(hPre + 16)
          expect(topLeg1, `${pressLabel}: leg1 TOP moves up while the bottom stays pinned`).toBeLessThan(0)
        }
        expect(
          Math.abs(hLeg1 - targetLeg1),
          `${pressLabel}: leg1 height tracks the gesture target (target=${targetLeg1.toFixed(1)} actual=${hLeg1.toFixed(1)})`
        ).toBeLessThanOrEqual(12)
        expect(
          Math.abs(topLeg1 + (hLeg1 - hPre)),
          `${pressLabel}: leg1 TOP delta is proportional to the display-height delta (top=${topLeg1.toFixed(1)} dh=${(hLeg1 - hPre).toFixed(1)})`
        ).toBeLessThanOrEqual(12)
        if (first === 'down') {
          expect(
            hLeg2,
            `${pressLabel}: leg2 up returns past the origin (ends taller than the press start)`
          ).toBeGreaterThan(hPre + 16)
          expect(topLeg2, `${pressLabel}: leg2 TOP reverses past the origin (ends above the press start)`).toBeLessThan(
            0
          )
        } else {
          expect(
            hLeg2,
            `${pressLabel}: leg2 down returns past the origin (ends shorter than the press start)`
          ).toBeLessThan(hPre - 16)
          expect(
            topLeg2,
            `${pressLabel}: leg2 TOP reverses past the origin (ends below the press start)`
          ).toBeGreaterThan(0)
        }
        expect(
          Math.abs(hLeg2 - targetLeg2),
          `${pressLabel}: leg2 height tracks the gesture target (target=${targetLeg2.toFixed(1)} actual=${hLeg2.toFixed(1)})`
        ).toBeLessThanOrEqual(12)
        expect(
          Math.abs(topLeg2 + (hLeg2 - hPre)),
          `${pressLabel}: leg2 TOP delta is proportional to the display-height delta (top=${topLeg2.toFixed(1)} dh=${(hLeg2 - hPre).toFixed(1)})`
        ).toBeLessThanOrEqual(12)
        const bottomWorst = Math.max(...bottomDrifts)
        const controlsWorst = Math.max(...controlsDrifts)
        const bottomFinal =
          pre.frameBottom !== null && post.frameBottom !== null ? Math.abs(post.frameBottom - pre.frameBottom) : NaN
        const controlsFinal =
          pre.controls !== null && post.controls !== null ? Math.abs(post.controls - pre.controls) : NaN
        test.info().annotations.push({
          type: 'cme-reversal-pinned',
          description: `${pressLabel} bottomFinal=${Number.isFinite(bottomFinal) ? bottomFinal.toFixed(1) : 'NaN'} bottomWorst=${bottomWorst.toFixed(1)} controlsFinal=${Number.isFinite(controlsFinal) ? controlsFinal.toFixed(1) : 'NaN'} controlsWorst=${controlsWorst.toFixed(1)} minMargin=${Math.round(hPre - midSetup.prodMin)} maxMargin=${Math.round(midSetup.prodMax - hPre)}`
        })
        expect(
          bottomFinal,
          `${pressLabel}: SAME-press reversal captured outer BOTTOM ends where the press found it`
        ).toBeLessThanOrEqual(REGION_TOL)
        expect(
          controlsFinal,
          `${pressLabel}: SAME-press reversal message-controls ends where the press found it`
        ).toBeLessThanOrEqual(REGION_TOL)
        expect(
          bottomWorst,
          `${pressLabel}: SAME-press reversal every captured BOTTOM frame stays pinned`
        ).toBeLessThanOrEqual(TRANSITION_TOL)
        expect(
          controlsWorst,
          `${pressLabel}: SAME-press reversal every controls frame stays pinned`
        ).toBeLessThanOrEqual(TRANSITION_TOL)
        // Physical-clamp truth (not a false unclamped promise): both leg targets stay strictly inside [min,max]
        // with margin, and every sampled #messages viewport stays inside the live scroll range.
        for (const [idx, f] of frames.entries()) {
          const topExtreme = -(f.msgSh - f.msgCh)
          expect(
            f.msgTop,
            `${pressLabel} reversal frame ${idx}: viewport stays inside the live scroll range (top=${f.msgTop} extreme=${topExtreme})`
          ).toBeGreaterThanOrEqual(topExtreme - 12)
          expect(f.msgTop, `${pressLabel} reversal frame ${idx}: viewport stays at/above bottom`).toBeLessThanOrEqual(
            12
          )
        }
        expect(
          hLeg1,
          `${pressLabel}: leg1 target is honestly unclamped (above min with margin)`
        ).toBeGreaterThanOrEqual(midSetup.prodMin + 16)
        expect(hLeg1, `${pressLabel}: leg1 target is honestly unclamped (below max with margin)`).toBeLessThanOrEqual(
          midSetup.prodMax - 16
        )
        expect(
          hLeg2,
          `${pressLabel}: leg2 target is honestly unclamped (above min with margin)`
        ).toBeGreaterThanOrEqual(midSetup.prodMin + 16)
        expect(hLeg2, `${pressLabel}: leg2 target is honestly unclamped (below max with margin)`).toBeLessThanOrEqual(
          midSetup.prodMax - 16
        )
      } finally {
        await page.mouse.up()
      }
      // Pointer-trace oracle: ONE down, moves all buttons=1 with a single pointerId, no early up/cancel, up only after both legs.
      const trace = await readReversalTrace()
      await cleanupReversalTrace()
      const downs = trace.filter((e) => e.kind === 'down')
      const ups = trace.filter((e) => e.kind === 'up')
      const moves = trace.filter((e) => e.kind === 'move')
      const cancels = trace.filter((e) => e.kind === 'cancel')
      test.info().annotations.push({
        type: 'cme-reversal-pointer',
        description: `${pressLabel} downs=${downs.length} moves=${moves.length} ups=${ups.length} cancels=${cancels.length} ids=${[...new Set(moves.map((m) => String(m.pointerId)))].join(',')}`
      })
      expect(downs.length, `${pressLabel}: SAME press uses exactly ONE native pointerdown`).toBe(1)
      expect(ups.length, `${pressLabel}: pointerup fires ONLY after both legs (exactly once)`).toBe(1)
      expect(cancels.length, `${pressLabel}: no hidden pointercancel/gesture reset during the press`).toBe(0)
      expect(
        moves.length,
        `${pressLabel}: reversing legs produce sampled pointermoves under the single press`
      ).toBeGreaterThan(4)
      const downId = downs.length === 1 ? String(downs[0].pointerId) : ''
      for (const m of moves) {
        expect(m.buttons, `${pressLabel}: same-press pointermove keeps buttons=1 (no hidden release)`).toBe(1)
        expect(String(m.pointerId), `${pressLabel}: same-press pointermove keeps the single captured pointerId`).toBe(
          downId
        )
      }
      // No release jump: dedicated post-up frames (owned layout callback already applied during the press, not post-hoc).
      const postUp: number[] = []
      const postControls: number[] = []
      for (let i = 0; i < 4; i++) {
        await nextReversalFrame()
        const cur = await readReversalFrame()
        if (pre.frameBottom !== null && cur.frameBottom !== null)
          postUp.push(Math.abs(cur.frameBottom - pre.frameBottom))
        if (pre.controls !== null && cur.controls !== null) postControls.push(Math.abs(cur.controls - pre.controls))
      }
      expect(
        Math.max(...postUp),
        `${pressLabel}: no release jump on the captured BOTTOM after mouseup`
      ).toBeLessThanOrEqual(REGION_TOL)
      expect(
        Math.max(...postControls),
        `${pressLabel}: no release jump on message-controls after mouseup`
      ).toBeLessThanOrEqual(REGION_TOL)
    }

    await test.step('two native presses, opposite entry directions, bottom pinned and top tracking', async () => {
      await runReversalPress('down', 'press-A down-first')
      await returnReversalToMidrange('between-press rebaseline')
      await runReversalPress('up', 'press-B up-first')
      // Close without persisting the probe heights: Cancel from the action bar, verify close (never a void click claim).
      const actionBar = editorArea.locator('[data-interaction-region="message-controls"]')
      const cancelBtn = actionBar.locator('button:not(.message-editor-save-btn):not(.message-editor-resend-btn)')
      await expect(cancelBtn, 'cancel control must render in the action bar').toBeVisible({ timeout: 10000 })
      await cancelBtn.click()
      await expect(editorArea, 'editor must close after Cancel').not.toBeVisible({ timeout: 10000 })
    })
  })

  test('edit entry/cancel boundary with every-frame region and modal no-motion footprint', async ({
    mainWindow,
    electronApp
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR ENTRY/CANCEL + MODAL NO-MOTION (BOUNDARY): natural 2-row long reply at a verified true bottom; in-page rAF recorder started BEFORE the real Edit click captures the FIRST and EVERY visible frame (hidden excluded, first-visible never skipped); structural action-bar region before/after keeps the mapping with REG2 final / TRANS4 every-frame and physical-clamp truth quantified; native focus causes no outer scroll; Cancel uses the actual action-bar scoped button with editor-close verification (never a void-click claim); modal expansion then proves zero Web-Animation zoom/fade with first-frame geometry stable and root transform none, inline placeholder height EXACT, outer chat footprint uncollapsed, single-plane source/preview with footer pinned and preventScroll background hold. Read-only DOM probes only.'
    })
    const page: Page = mainWindow
    const tag = `cme-${Date.now().toString(36)}`
    // Natural 2-row long reply (no filler): the true-bottom boundary path. The mid-topic windowed path stays owned by
    // assistant-edit-region (16-row projection, DISPLAY 10); this case reuses its recorder/oracle shape, not weak settled checks.
    const seeded = await test.step('seed natural 2-row long reply and activate route', async () =>
      seedLongAssistantDraft(page, tag))
    const msgId = seeded.assistantMsgId

    async function readScrollDims(): Promise<{ top: number; sh: number; ch: number }> {
      return page
        .evaluate(() => {
          const el = document.getElementById('messages') as HTMLElement | null
          if (!el) throw new Error('#messages not found')
          return { top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight }
        })
        .catch(() => ({ top: NaN, sh: NaN, ch: NaN }))
    }

    await test.step('genuine wheel to a verified true bottom with the Edit button really hittable', async () => {
      const box = await page.locator('#messages').first().boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      for (let i = 0; i < 30; i++) {
        const st = (await readScrollDims()).top
        if (Math.abs(st) <= 60) break
        await page.mouse.wheel(0, 560)
        await page.waitForTimeout(200)
      }
      const probe = await readScrollDims()
      expect(
        Math.abs(probe.top),
        `must reach a verified true bottom (top=${Math.round(probe.top)})`
      ).toBeLessThanOrEqual(60)
      const row = page.locator(`[data-message-id="${msgId}"]`).first()
      await row.hover().catch(() => {})
      const visible = await page
        .evaluate((id: string) => {
          const container = document.getElementById('messages') as HTMLElement | null
          if (!container) return false
          const c = container.getBoundingClientRect()
          const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          const btn = document.querySelector(
            `#message-${esc} [data-testid="msg-assistant-edit-btn"]`
          ) as HTMLElement | null
          if (!btn) return false
          const r = btn.getBoundingClientRect()
          return r.top >= c.top && r.bottom <= c.bottom && r.width > 0 && r.height > 0
        }, msgId)
        .catch(() => false)
      expect(visible, 'Edit button must sit fully inside #messages with no test-induced scroll').toBe(true)
    })

    async function captureEntryPre(): Promise<{
      btn: { x: number; y: number }
      region: number | null
      scroll: { top: number; sh: number; ch: number }
      container: { top: number; bottom: number; height: number }
    }> {
      return page.evaluate((id: string) => {
        const container = document.getElementById('messages') as HTMLElement | null
        if (!container) throw new Error('#messages not found')
        const c = container.getBoundingClientRect()
        const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const btn = document.querySelector(
          `#message-${esc} [data-testid="msg-assistant-edit-btn"]`
        ) as HTMLElement | null
        if (!btn) throw new Error('assistant edit button not found')
        const br = btn.getBoundingClientRect()
        const row = document.querySelector(`#messages [data-message-id="${esc}"]`) as HTMLElement | null
        const region = row?.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null
        const rr = region ? region.getBoundingClientRect() : null
        return {
          btn: { x: br.x + br.width / 2, y: br.y + br.height / 2 },
          region: rr && rr.width > 0 && rr.height > 0 ? rr.bottom - c.top : null,
          scroll: { top: container.scrollTop, sh: container.scrollHeight, ch: container.clientHeight },
          container: { top: c.top, bottom: c.bottom, height: c.height }
        }
      }, msgId)
    }

    async function startEntryRecorder(): Promise<void> {
      await page.evaluate((id: string) => {
        const w = window as unknown as Record<string, unknown>
        ;(w as Record<string, unknown>).__entryFrames = []
        ;(w as Record<string, unknown>).__entryRun = true
        const sample = (): void => {
          try {
            if (!(w as Record<string, unknown>).__entryRun) return
            const container = document.getElementById('messages') as HTMLElement | null
            const c = container ? container.getBoundingClientRect() : null
            const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
            const row = document.querySelector(`#messages [data-message-id="${esc}"]`) as HTMLElement | null
            const region = row?.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null
            const rr = region ? region.getBoundingClientRect() : null
            const mr = row ? row.getBoundingClientRect() : null
            ;((w as Record<string, unknown>).__entryFrames as Array<Record<string, unknown>>).push({
              t: performance.now(),
              regionBottom: rr && c ? rr.bottom - c.top : NaN,
              regionVisible: !!(rr && rr.width > 0 && rr.height > 0),
              rowTop: mr && c ? mr.top - c.top : NaN,
              scrollTop: container ? container.scrollTop : NaN,
              sh: container ? container.scrollHeight : NaN,
              ch: container ? container.clientHeight : NaN,
              editorOpen: !!document.querySelector('.message-editor-area'),
              hidden: document.hidden
            })
          } catch {}
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }, msgId)
    }

    async function stopAndReadEntryRecorder(): Promise<Array<Record<string, unknown>>> {
      const frames = await page
        .evaluate(() => {
          const w = window as unknown as Record<string, unknown>
          ;(w as Record<string, unknown>).__entryRun = false
          return Array.isArray(w.__entryFrames) ? (w.__entryFrames.slice() as Array<Record<string, unknown>>) : []
        })
        .catch(() => [])
      return frames
    }

    async function waitForEntryQuiescence(): Promise<void> {
      let last = (await readScrollDims()).top
      const start = Date.now()
      while (Date.now() - start < 8000) {
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        )
        await page.waitForTimeout(350)
        const cur = (await readScrollDims()).top
        if (Math.abs(cur - last) <= 8) return
        last = cur
      }
      throw new Error(`entry viewport never reached quiescence (last=${last})`)
    }

    const pre = await test.step('capture pre-edit boundary geometry', async () => captureEntryPre())
    expect(pre.region, 'precondition: footer interaction region must be measurable').not.toBeNull()
    const preHit = await page
      .evaluate(
        ({ x, y, id }: { x: number; y: number; id: string }) => {
          const hit = document.elementFromPoint(x, y) as HTMLElement | null
          if (!hit) return false
          const row = hit.closest?.('[data-message-id]') as HTMLElement | null
          return row?.getAttribute('data-message-id') === id
        },
        { x: pre.btn.x, y: pre.btn.y, id: msgId }
      )
      .catch(() => false)
    expect(preHit, 'precondition: recorded Edit point hits the target assistant row (no forced/top-navbar click)').toBe(
      true
    )

    await test.step('real Edit entry keeps every visible frame inside the boundary oracle', async () => {
      await startEntryRecorder()
      await page.mouse.click(pre.btn.x, pre.btn.y)
      const editorArea = page.locator(`[data-message-id="${msgId}"] .message-editor-area`)
      await expect(editorArea, 'editor must open after the real Edit click').toBeVisible({ timeout: 15000 })
      await waitForEntryQuiescence()
      const frames = await stopAndReadEntryRecorder()
      expect(frames.length, 'entry recorder must capture painted frames from BEFORE the click').toBeGreaterThan(4)
      const visible = frames.filter((f) => f.hidden !== true && (f.regionVisible as boolean) === true)
      expect(visible.length, 'entry must keep visible region frames (first-visible never skipped)').toBeGreaterThan(0)
      const drifts = visible.map((f) =>
        pre.region !== null && Number.isFinite(f.regionBottom as number)
          ? Math.abs((f.regionBottom as number) - (pre.region as number))
          : NaN
      )
      const finite = drifts.filter((v) => Number.isFinite(v))
      expect(finite.length, 'every visible entry frame must carry a measurable region').toBe(visible.length)
      const worst = Math.max(...finite)
      const first = finite[0]
      test.info().annotations.push({
        type: 'cme-entry-frames',
        description: `n=${frames.length} visible=${visible.length} first=${first.toFixed(1)} worst=${worst.toFixed(1)} preRegion=${Math.round(pre.region as number)} preScroll=${Math.round(pre.scroll.top)}`
      })
      expect(
        first,
        'FIRST visible entry frame stays inside the transition budget (no entry shake)'
      ).toBeLessThanOrEqual(TRANSITION_TOL)
      expect(worst, 'EVERY visible entry frame stays inside the transition budget').toBeLessThanOrEqual(TRANSITION_TOL)
      // Legit physical clamps are quantified, never a blanket excuse: every frame stays inside the live range and the
      // true-bottom viewport stays honestly clamped at the bottom pin.
      for (const [idx, f] of visible.entries()) {
        const top = f.scrollTop as number
        const sh = f.sh as number
        const ch = f.ch as number
        const topExtreme = -(sh - ch)
        expect(top, `entry frame ${idx}: viewport stays inside the live scroll range`).toBeGreaterThanOrEqual(
          topExtreme - 12
        )
        expect(top, `entry frame ${idx}: viewport stays at/above bottom`).toBeLessThanOrEqual(12)
      }
      const postScroll = await readScrollDims()
      expect(postScroll.top, 'true-bottom entry stays inside the live scroll range').toBeGreaterThanOrEqual(
        -(postScroll.sh - postScroll.ch) - 12
      )
      expect(Math.abs(postScroll.top), 'true-bottom entry remains bottom-clamped (no centering)').toBeLessThanOrEqual(
        100
      )
      // Structural mapping holds: the editor action bar carries the same message-controls annotation.
      const postRegion = await page
        .evaluate((id: string) => {
          const container = document.getElementById('messages') as HTMLElement | null
          if (!container) return null
          const c = container.getBoundingClientRect()
          const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          const row = document.querySelector(`#messages [data-message-id="${esc}"]`) as HTMLElement | null
          const region = row?.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null
          if (!region) return null
          const r = region.getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) return null
          return r.bottom - c.top
        }, msgId)
        .catch(() => null)
      expect(postRegion, 'editor action-bar interaction region must be measurable (structural mapping)').not.toBeNull()
      expect(
        Math.abs((postRegion as number) - (pre.region as number)),
        'entry: controls interaction region stays at its previous viewport offset'
      ).toBeLessThanOrEqual(REGION_TOL)
      const hit = await page
        .evaluate(
          ({ x, y, id }: { x: number; y: number; id: string }) => {
            const h = document.elementFromPoint(x, y) as HTMLElement | null
            const row = h?.closest?.('[data-message-id]') as HTMLElement | null
            return row?.getAttribute('data-message-id') === id
          },
          { x: pre.btn.x, y: pre.btn.y, id: msgId }
        )
        .catch(() => false)
      expect(hit, 'stationary pointer still hits the same message after entry').toBe(true)
      // Native focus causes no outer scroll: the focused surface is the real CodeMirror plane and #messages holds.
      const focusDesc: string = await page
        .evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el) return 'null'
          return `${el.tagName.toLowerCase()}|${String(el.className ?? '').slice(0, 80)}`
        })
        .catch(() => 'unknown')
      const cmVisible = await page
        .locator(
          `[data-message-id="${msgId}"] .message-editor-area .editing-message .cm-content[contenteditable="true"]`
        )
        .isVisible()
        .catch(() => false)
      test.info().annotations.push({
        type: 'cme-entry-focus',
        description: `focus=${focusDesc} cmVisible=${cmVisible} preScroll=${Math.round(pre.scroll.top)} postScroll=${Math.round(postScroll.top)}`
      })
      expect(cmVisible, 'real CodeMirror surface stays mounted after entry').toBe(true)
      expect(
        Math.abs(postScroll.top - pre.scroll.top),
        'native mount focus causes no outer view scroll'
      ).toBeLessThanOrEqual(12)
    })

    await test.step('real action-bar Cancel returns every frame with verified close', async () => {
      const editorArea = page.locator(`[data-message-id="${msgId}"] .message-editor-area`)
      const actionBar = editorArea.locator('[data-interaction-region="message-controls"]')
      await expect(actionBar, 'editor action bar must render').toBeVisible()
      // Cancel is the action-bar scoped non-save/non-resend button — never a toolbar source toggle.
      const cancelBtn = actionBar.locator('button:not(.message-editor-save-btn):not(.message-editor-resend-btn)')
      await expect(cancelBtn, 'cancel control must render in the action bar').toBeVisible({ timeout: 10000 })
      const cancelBox = await cancelBtn.boundingBox()
      expect(cancelBox, 'cancel must have geometry (proper hit premise, never a void click)').not.toBeNull()
      const toolbarBox = await editorArea
        .locator('[data-testid="message-editor-mode-btn"]')
        .boundingBox()
        .catch(() => null)
      if (toolbarBox && cancelBox) {
        expect(
          Math.abs(cancelBox.y - toolbarBox.y) > 4,
          'cancel lives in the action bar, not on the toolbar source row'
        ).toBe(true)
      }
      const hitCancel = await page
        .evaluate(
          ({ x, y }: { x: number; y: number }) => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null
            if (!el) return 'null'
            const btn = el.closest?.('button') as HTMLElement | null
            return `${el.tagName.toLowerCase()}|btn=${btn ? 'yes' : 'no'}`
          },
          { x: cancelBox!.x + cancelBox!.width / 2, y: cancelBox!.y + cancelBox!.height / 2 }
        )
        .catch(() => 'unknown')
      expect(hitCancel.includes('btn=yes'), `cancel center must hit-test to a button (got ${hitCancel})`).toBe(true)
      await startEntryRecorder()
      await cancelBtn.click()
      await expect(
        editorArea,
        'editor must close after the real Cancel click (void clicks never count)'
      ).not.toBeVisible({
        timeout: 10000
      })
      await waitForEntryQuiescence()
      const frames = await stopAndReadEntryRecorder()
      const visible = frames.filter((f) => f.hidden !== true && (f.regionVisible as boolean) === true)
      expect(visible.length, 'cancel must keep visible region frames').toBeGreaterThan(0)
      const drifts = visible.map((f) =>
        pre.region !== null && Number.isFinite(f.regionBottom as number)
          ? Math.abs((f.regionBottom as number) - (pre.region as number))
          : NaN
      )
      const finite = drifts.filter((v) => Number.isFinite(v))
      const worst = finite.length > 0 ? Math.max(...finite) : NaN
      test.info().annotations.push({
        type: 'cme-cancel-frames',
        description: `n=${frames.length} visible=${visible.length} worst=${Number.isFinite(worst) ? worst.toFixed(1) : 'NaN'} hit=${hitCancel}`
      })
      expect(
        worst,
        'EVERY visible cancel frame stays inside the transition budget (no cancel shake)'
      ).toBeLessThanOrEqual(TRANSITION_TOL)
      const row = page.locator(`[data-message-id="${msgId}"]`).first()
      await row.hover().catch(() => {})
      const postRegion = await page
        .evaluate((id: string) => {
          const container = document.getElementById('messages') as HTMLElement | null
          if (!container) return null
          const c = container.getBoundingClientRect()
          const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          const r = document.querySelector(`#messages [data-message-id="${esc}"]`) as HTMLElement | null
          const region = r?.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null
          if (!region) return null
          const rr = region.getBoundingClientRect()
          if (!(rr.width > 0 && rr.height > 0)) return null
          return rr.bottom - c.top
        }, msgId)
        .catch(() => null)
      expect(postRegion, 'post-cancel footer region must be measurable').not.toBeNull()
      expect(
        Math.abs((postRegion as number) - (pre.region as number)),
        'cancel returns the controls region to its pre-edit offset (closed→closed exact)'
      ).toBeLessThanOrEqual(REGION_TOL)
      const postScroll = await readScrollDims()
      expect(Math.abs(postScroll.top), 'cancel remains bottom-clamped (no recenter)').toBeLessThanOrEqual(100)
    })

    await test.step('modal expansion has no-motion footprint with exact placeholder and single plane', async () => {
      const row = page.locator(`[data-message-id="${msgId}"]`).first()
      await row.hover().catch(() => {})
      const editBtn = row.locator('[data-testid="msg-assistant-edit-btn"]')
      await editBtn.waitFor({ state: 'visible', timeout: 15000 })
      await editBtn.click()
      const inlineArea = page.locator(`[data-message-id="${msgId}"] .message-editor-area`)
      await expect(inlineArea, 'inline editor must reopen for the modal probe').toBeVisible({ timeout: 15000 })
      const expandBtn = inlineArea.locator('[data-testid="message-editor-expand-btn"]')
      await expect(expandBtn, 'expand control must render').toBeVisible({ timeout: 10000 })
      // Expand staging BEFORE any footprint baseline: deterministic
      // owned-window size. The toolbar keeps the far-right Expand pinned at
      // every width (outer toolbar overflow hidden, the tools group scrolls
      // internally — narrow-960 reachability is owned by the dedicated
      // narrow test below), so this 1280x800 staging is solely the wide
      // modal animation/footprint contract the toolbar case already uses,
      // restored at step end; the single readiness poll below still gates
      // the real click on a fresh hit-test (no forced click, no tolerance
      // change).
      const expandInitialSize = await electronApp
        .evaluate(({ BrowserWindow }) => {
          const win = (
            BrowserWindow as unknown as { getAllWindows: () => Array<{ getSize: () => number[] }> }
          ).getAllWindows()[0]
          return win.getSize() as [number, number]
        })
        .catch(() => null)
      await electronApp
        .evaluate(({ BrowserWindow }) => {
          const win = (
            BrowserWindow as unknown as { getAllWindows: () => Array<{ setSize: (w: number, h: number) => void }> }
          ).getAllWindows()[0]
          win.setSize(1280, 800)
        })
        .catch(() => {})
      await page.waitForTimeout(500)
      async function expandCenterProbe(): Promise<{
        hit: boolean
        describe: string
        cx: number
        cy: number
        toolbarTop: number
        hostTop: number
      }> {
        const containerBox = await page.locator('#messages').first().boundingBox()
        const b = await expandBtn.boundingBox()
        const toolbarBox = await inlineArea.locator('[data-testid="message-editor-mode-btn"]').boundingBox()
        const hostBox = await inlineArea.boundingBox()
        if (!containerBox || !b || !hostBox) {
          return {
            hit: false,
            describe: `tag=${tag} no-geometry container=${containerBox ? `${Math.round(containerBox.y)}` : 'null'} expand=${b ? `${Math.round(b.x)},${Math.round(b.y)}` : 'null'} host=${hostBox ? `${Math.round(hostBox.y)}` : 'null'} window=${await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`).catch(() => 'na')}`,
            cx: -1,
            cy: -1,
            toolbarTop: -1,
            hostTop: hostBox ? hostBox.y : NaN
          }
        }
        const cx = b.x + b.width / 2
        const cy = b.y + b.height / 2
        const toolbarTop = toolbarBox ? toolbarBox.y : b.y
        const probe = await page
          .evaluate(
            ({ x, y }: { x: number; y: number }) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null
              if (!el) return { hit: false, describe: 'null' }
              const btn = el.closest('[data-testid="message-editor-expand-btn"]')
              const frame = document.getElementById('messages')?.getBoundingClientRect() ?? null
              return {
                hit: btn !== null,
                describe:
                  `${el.tagName.toLowerCase()}` +
                  `#${(el as HTMLElement).id || '-'}` +
                  ` cls=${((el as HTMLElement).className || '').toString().slice(0, 40)}` +
                  ` closest=${el.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '-'}` +
                  ` pt=${Math.round(x)},${Math.round(y)}` +
                  ` msgs=${frame ? `${Math.round(frame.top)},${Math.round(frame.bottom)} ${Math.round(frame.width)}x${Math.round(frame.height)}` : 'n/a'}` +
                  ` vp=${window.innerWidth}x${window.innerHeight}`
              }
            },
            { x: cx, y: cy }
          )
          .catch(() => ({ hit: false, describe: 'unreadable' }))
        return {
          hit: probe.hit,
          describe: `tag=${tag} ${probe.describe} box=${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} toolbarTop=${Math.round(toolbarTop)} hostTop=${Math.round(hostBox.y)}`,
          cx,
          cy,
          toolbarTop,
          hostTop: hostBox.y
        }
      }
      // Fresh placement proof AFTER the intentional resize settles: the real
      // clip is the button inside the #messages visible rect AND the window
      // viewport (both axes, from the live probe describe), never a band.
      const stagedProbe = await expandCenterProbe()
      const stagedContainerBox = await page.locator('#messages').first().boundingBox()
      test.info().annotations.push({
        type: 'cme-expand-placement',
        description: `tag=${tag} ${stagedProbe.describe} container=${stagedContainerBox ? `${Math.round(stagedContainerBox.x)},${Math.round(stagedContainerBox.y)} ${Math.round(stagedContainerBox.width)}x${Math.round(stagedContainerBox.height)}` : 'null'}`
      })
      // Baselines recaptured AFTER the intentional resize settles —
      // never the pre-resize values — then the no-motion recorder runs.
      const inlineBox = await inlineArea.boundingBox()
      expect(inlineBox, 'inline editor must have geometry before expand').not.toBeNull()
      const inlineH = inlineBox!.height
      // Regional identity: the expanded placeholder exactly replaces the
      // InlineResizeContainer/resizeSurface (toolbar/find/footer stay mounted),
      // so the meaningful pre-inline baseline is the resize-surface height —
      // never the whole editor-area height (toolbar/padding/footer included).
      const inlineSurfaceBox = await resizeSurface(inlineArea).boundingBox()
      expect(inlineSurfaceBox, 'resize surface must have geometry before expand').not.toBeNull()
      const inlineSurfaceH = inlineSurfaceBox!.height
      const msgsBefore = await readScrollDims()
      const msgsBoxBefore = await page.locator('#messages').first().boundingBox()
      // Far-right Expand: locate the ACTUAL visible button, hit-test first; horizontal overflow fails loudly, never forced.
      // Real clickable readiness (no programmatic scroll, no forced click):
      // re-read the CURRENT bbox and hit-test its center on every poll until
      // they agree. Geometry unreadable must fail loudly here, never swallowed.
      await expect
        .poll(
          async () => {
            const b = await expandBtn.boundingBox().catch(() => null)
            if (!b) return 'no-bbox'
            const cx = b.x + b.width / 2
            const cy = b.y + b.height / 2
            const hit = await page
              .evaluate(
                ({ x, y }: { x: number; y: number }) => {
                  const el = document.elementFromPoint(x, y) as HTMLElement | null
                  if (!el) return { hit: false, describe: 'null' }
                  const btn = el.closest('[data-testid="message-editor-expand-btn"]')
                  const frame = document.getElementById('messages')?.getBoundingClientRect() ?? null
                  return {
                    hit: btn !== null,
                    describe:
                      `${el.tagName.toLowerCase()}` +
                      `#${(el as HTMLElement).id || '-'}` +
                      ` cls=${((el as HTMLElement).className || '').toString().slice(0, 40)}` +
                      ` closest=${el.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '-'}` +
                      ` pt=${Math.round(x)},${Math.round(y)}` +
                      ` msgs=${frame ? `${Math.round(frame.top)},${Math.round(frame.bottom)} ${Math.round(frame.width)}x${Math.round(frame.height)}` : 'n/a'}` +
                      ` vp=${window.innerWidth}x${window.innerHeight}`
                  }
                },
                { x: cx, y: cy }
              )
              .catch(() => ({ hit: false, describe: 'unreadable' }))
            if (hit.hit === true) return 'hit'
            return `miss:tag=${tag} ${hit.describe} box=${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`
          },
          { timeout: 10000 }
        )
        .toBe('hit')
      // elementFromPoint verification uses the bbox read AT action time (fresh
      // coordinates for the real click below), never a framed older bbox.
      const expandBox = await expandBtn.boundingBox()
      expect(expandBox, 'expand must have geometry (real visible row, not virtualized content)').not.toBeNull()
      const hostTopNow = await inlineArea.boundingBox().then(
        (hb) => hb?.y ?? NaN,
        () => NaN
      )
      const expandHit = await page
        .evaluate(
          ({ x, y }: { x: number; y: number }) => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null
            if (!el) return { hit: false, describe: 'null' }
            const btn = el.closest('[data-testid="message-editor-expand-btn"]')
            const frame = document.getElementById('messages')?.getBoundingClientRect() ?? null
            return {
              hit: btn !== null,
              describe:
                `${el.tagName.toLowerCase()}` +
                `#${(el as HTMLElement).id || '-'}` +
                ` closest=${el.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '-'}` +
                ` text=${(el.textContent || '').slice(0, 30)}` +
                ` msgs=${frame ? `${Math.round(frame.top)},${Math.round(frame.bottom)}` : 'n/a'}` +
                ` vp=${window.innerWidth}x${window.innerHeight}`
            }
          },
          { x: expandBox!.x + expandBox!.width / 2, y: expandBox!.y + expandBox!.height / 2 }
        )
        .catch(() => ({ hit: false, describe: 'unreadable' }))
      expect(
        expandHit.hit,
        `[${tag}] expand center must hit-test to the real button after genuine staging (got ${expandHit.describe} box=${Math.round(expandBox!.x)},${Math.round(expandBox!.y)} ${Math.round(expandBox!.width)}x${Math.round(expandBox!.height)} hostTop=${Math.round(hostTopNow)})`
      ).toBe(true)
      await expandBtn.click()
      const modal = page.locator('[data-testid="message-editor-expanded"]')
      await expect(modal, 'expanded modal root must render').toBeVisible({ timeout: 10000 })
      // First-frame geometry stability + zero Web-Animation zoom/fade + root transform none (runtime truth, not props-only).
      const firstBoxes: Array<{ x: number; y: number; w: number; h: number }> = []
      for (let i = 0; i < 6; i++) {
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        )
        const b = await modal.boundingBox().catch(() => null)
        if (b) firstBoxes.push({ x: b.x, y: b.y, w: b.width, h: b.height })
      }
      expect(firstBoxes.length, 'modal must keep geometry across the first painted frames').toBeGreaterThanOrEqual(3)
      const dx = Math.max(...firstBoxes.map((b) => b.x)) - Math.min(...firstBoxes.map((b) => b.x))
      const dy = Math.max(...firstBoxes.map((b) => b.y)) - Math.min(...firstBoxes.map((b) => b.y))
      const dw = Math.max(...firstBoxes.map((b) => b.w)) - Math.min(...firstBoxes.map((b) => b.w))
      const dh = Math.max(...firstBoxes.map((b) => b.h)) - Math.min(...firstBoxes.map((b) => b.h))
      const animCount: number = await modal
        .evaluate((root) => (root as HTMLElement).getAnimations().length)
        .catch(() => -1)
      const rootTransform: string | null = await modal
        .evaluate((root) => getComputedStyle(root as HTMLElement).transform)
        .catch(() => null)
      const rootOpacity: string | null = await modal
        .evaluate((root) => getComputedStyle(root as HTMLElement).opacity)
        .catch(() => null)
      test.info().annotations.push({
        type: 'cme-modal-no-motion',
        description: `first dx/dy/dw/dh=${dx.toFixed(1)}/${dy.toFixed(1)}/${dw.toFixed(1)}/${dh.toFixed(1)} anims=${animCount} transform=${rootTransform} opacity=${rootOpacity}`
      })
      expect(animCount, 'modal opening runs zero Web Animations (no zoom/fade odd motion)').toBe(0)
      expect(rootTransform, 'modal root carries no transform on open').toBe('none')
      expect(dx, 'modal first-frame x is stable (no odd open animation)').toBeLessThanOrEqual(REGION_TOL)
      expect(dy, 'modal first-frame y is stable (no odd open animation)').toBeLessThanOrEqual(REGION_TOL)
      expect(dw, 'modal first-frame width is stable').toBeLessThanOrEqual(TRANSITION_TOL)
      expect(dh, 'modal first-frame height is stable').toBeLessThanOrEqual(TRANSITION_TOL)
      // Placeholder preserves the footprint: EXACT resize-surface height, find control present.
      const placeholder = page.locator('[data-testid="message-editor-expanded-placeholder"]')
      await expect(placeholder, 'expanded placeholder must preserve the inline footprint').toBeVisible({
        timeout: 10000
      })
      const phBox = await placeholder.boundingBox()
      expect(phBox, 'placeholder must have geometry').not.toBeNull()
      expect(
        Math.abs(phBox!.height - inlineSurfaceH),
        `placeholder height stays EXACT resize-surface height (surface=${inlineSurfaceH.toFixed(1)} ph=${phBox!.height.toFixed(1)})`
      ).toBeLessThanOrEqual(REGION_TOL)
      // Whole outer bordered area footprint holds separately: the background
      // inline editor frame keeps its height/top/bottom while expanded.
      const inlineDuringBox = await inlineArea.boundingBox()
      expect(inlineDuringBox, 'inline editor keeps geometry during expand').not.toBeNull()
      expect(
        Math.abs(inlineDuringBox!.height - inlineH),
        `outer editor-area footprint height holds during expand (before=${inlineH.toFixed(1)} during=${inlineDuringBox!.height.toFixed(1)})`
      ).toBeLessThanOrEqual(REGION_TOL)
      expect(
        Math.abs(inlineDuringBox!.y - inlineBox!.y),
        `outer editor-area footprint top holds during expand (before=${inlineBox!.y.toFixed(1)} during=${inlineDuringBox!.y.toFixed(1)})`
      ).toBeLessThanOrEqual(REGION_TOL)
      expect(
        Math.abs(inlineDuringBox!.y + inlineDuringBox!.height - (inlineBox!.y + inlineBox!.height)),
        'outer editor-area footprint bottom holds during expand'
      ).toBeLessThanOrEqual(REGION_TOL)
      await expect(
        modal.locator('[data-testid="message-editor-find-btn"]'),
        'find stays present while expanded'
      ).toBeVisible({
        timeout: 10000
      })
      // Outer chat background never collapses during expand: #messages footprint holds, background scroll holds via preventScroll.
      const msgsDuring = await readScrollDims()
      const msgsBoxDuring = await page.locator('#messages').first().boundingBox()
      expect(
        Math.abs(msgsDuring.sh - msgsBefore.sh),
        'outer chat content height never collapses during expand'
      ).toBeLessThanOrEqual(12)
      if (msgsBoxBefore && msgsBoxDuring) {
        expect(
          Math.abs(msgsBoxDuring.width - msgsBoxBefore.width),
          'outer chat width holds during expand'
        ).toBeLessThanOrEqual(12)
        expect(
          Math.abs(msgsBoxDuring.height - msgsBoxBefore.height),
          'outer chat height holds during expand'
        ).toBeLessThanOrEqual(12)
      }
      expect(
        Math.abs(msgsDuring.top - msgsBefore.top),
        'source-engine mount focus holds the background (preventScroll, no jump)'
      ).toBeLessThanOrEqual(12)
      // Single-plane source with pinned footer (actual plane geometry, never full-doc virtualized text).
      const planeCount = await modal
        .evaluate((root) => {
          const isUserPlane = (e: HTMLElement): boolean => {
            if (e === root) return false
            if (e.classList && e.classList.contains('cm-layer')) return false
            if (e.clientHeight <= 0 || e.clientWidth <= 0) return false
            if (e.scrollHeight <= e.clientHeight + 40) return false
            const cs = getComputedStyle(e)
            if (cs.display === 'none' || cs.visibility === 'hidden') return false
            if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') return false
            const r = e.getBoundingClientRect()
            if (!(r.width > 0 && r.height > 0)) return false
            return true
          }
          return Array.from(root.querySelectorAll('*')).filter((e) => isUserPlane(e as HTMLElement)).length
        })
        .catch(() => -1)
      expect(planeCount, 'expanded source keeps exactly one content plane').toBe(1)
      const saveBtn = modal.locator('.message-editor-save-btn')
      await expect(saveBtn, 'save stays available while expanded').toBeVisible()
      const saveBox = await saveBtn.boundingBox()
      expect(saveBox, 'save must have geometry while expanded').not.toBeNull()
      await expect(modeToggle(modal), 'modal carries exactly one mode toggle').toHaveCount(1)
      await modeToggle(modal).click()
      await expect(modeToggle(modal), 'modal preview mode engages').toHaveAttribute('data-mode', 'preview')
      await expect(modal).toContainText(`Long draft ${tag}`, { timeout: 10000 })
      const planePrev = await modal
        .evaluate((root) => {
          const isUserPlane = (e: HTMLElement): boolean => {
            if (e === root) return false
            if (e.classList && e.classList.contains('cm-layer')) return false
            if (e.clientHeight <= 0 || e.clientWidth <= 0) return false
            if (e.scrollHeight <= e.clientHeight + 40) return false
            const cs = getComputedStyle(e)
            if (cs.display === 'none' || cs.visibility === 'hidden') return false
            if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') return false
            return true
          }
          return Array.from(root.querySelectorAll('*')).filter((e) => isUserPlane(e as HTMLElement)).length
        })
        .catch(() => -1)
      expect(planePrev, 'expanded preview keeps exactly one content plane').toBe(1)
      const savePreviewBox = await saveBtn.boundingBox()
      expect(
        Math.abs(savePreviewBox!.y - saveBox!.y),
        'footer Save stays pinned across source/preview (one-plane footer)'
      ).toBeLessThanOrEqual(4)
      await modeToggle(modal).click()
      await expect(modeToggle(modal), 'modal returns to source').toHaveAttribute('data-mode', 'source')
      const collapseBtn = modal.locator('[data-testid="message-editor-collapse-btn"]')
      await expect(collapseBtn, 'collapse control must render').toBeVisible({ timeout: 10000 })
      await collapseBtn.click()
      await expect(modal, 'collapse closes the expansion').not.toBeVisible({ timeout: 10000 })
      const msgsAfter = await readScrollDims()
      expect(Math.abs(msgsAfter.sh - msgsBefore.sh), 'outer chat footprint restores after close').toBeLessThanOrEqual(
        12
      )
      const inlineAfter = page.locator(`[data-message-id="${msgId}"] .message-editor-area`)
      await expect(inlineAfter, 'inline editor retains the draft after collapse').toBeVisible({ timeout: 10000 })
      test.info().annotations.push({
        type: 'cme-modal-probe-scope',
        description:
          'probes are read-only DOM geometry/animation/hit-test reads; no controller writes, private view state, or provider shortcuts'
      })
      if (expandInitialSize) {
        const [w, h] = expandInitialSize
        await electronApp
          .evaluate(
            ({ BrowserWindow }, init: { w: number; h: number }) => {
              try {
                const win = (
                  BrowserWindow as unknown as {
                    getAllWindows: () => Array<{ setSize: (w: number, h: number) => void }>
                  }
                ).getAllWindows()[0]
                win.setSize(init.w, init.h)
              } catch {
                // Best-effort restore — never mask the test result.
              }
            },
            { w, h }
          )
          .catch(() => {})
      }
    })
  })

  test('toolbar layout/disabled states and expanded modal single-plane scroll', async ({ mainWindow, electronApp }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR TOOLBAR + MODAL SCROLL (INTEGRATED): toolbar carries no translate entry, find sits after the formatting group, the history divider sits left of undo/redo, expand is alone far-right without overlap; native undo/redo expose disabled states with distinct disabled styling; the expanded modal pins header/toolbar/Save/Cancel (outer planes never scroll) while exactly one content plane (CM scroller in source, preview scroller in preview) scrolls under a real wheel. Real UI gestures only.'
    })
    const page: Page = mainWindow
    const tag = `cmm-${Date.now().toString(36)}`
    const seeded = await test.step('seed long assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag))

    const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () =>
      openAssistantEditor(page, seeded.assistantMsgId))

    // Deterministic owned-window size for modal geometry; restored afterwards
    // so the shared fixture is untouched for later specs.
    const initialSize = await electronApp
      .evaluate(({ BrowserWindow }) => {
        const win = (
          BrowserWindow as unknown as { getAllWindows: () => Array<{ getSize: () => number[] }> }
        ).getAllWindows()[0]
        return win.getSize() as [number, number]
      })
      .catch(() => null)
    try {
      await electronApp
        .evaluate(({ BrowserWindow }) => {
          const win = (
            BrowserWindow as unknown as { getAllWindows: () => Array<{ setSize: (w: number, h: number) => void }> }
          ).getAllWindows()[0]
          win.setSize(1280, 800)
        })
        .catch(() => {})
      await page.waitForTimeout(500)

      await test.step('toolbar has no translate entry and keeps strict order', async () => {
        await expectNoLegacyModeButtons(editorArea)
        await expect(editorArea.locator('[data-testid*="translate"]')).toHaveCount(0)
        // Strict toolbar surface: link + separator are guaranteed production
        // testids (CONFLICT, do not weaken: current production renders the link
        // button without a testid, so the link assertion FAILS until production
        // adds message-editor-link-btn).
        for (const tid of [
          'message-editor-mode-btn',
          'message-editor-bold-btn',
          'message-editor-link-btn',
          'message-editor-find-btn',
          'message-editor-history-separator',
          'message-editor-undo-btn',
          'message-editor-redo-btn',
          'message-editor-expand-btn'
        ]) {
          await expect(editorArea.locator(`[data-testid="${tid}"]`), `${tid} must render`).toBeVisible({
            timeout: 10000
          })
        }
        await expect(editorArea.locator('[data-testid="message-editor-history-separator"]')).toHaveCount(1)
        const order: string[] = await editorArea.evaluate((area) =>
          Array.from(area.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid') ?? '')
        )
        const idx = (tid: string): number => order.indexOf(tid)
        for (const tid of [
          'message-editor-mode-btn',
          'message-editor-bold-btn',
          'message-editor-link-btn',
          'message-editor-find-btn',
          'message-editor-history-separator',
          'message-editor-undo-btn',
          'message-editor-redo-btn',
          'message-editor-expand-btn'
        ]) {
          expect(idx(tid), `${tid} must occur exactly once in toolbar order`).toBeGreaterThanOrEqual(0)
        }
        expect(idx('message-editor-link-btn'), 'link sits after bold').toBeGreaterThan(idx('message-editor-bold-btn'))
        expect(idx('message-editor-find-btn'), 'find sits after link (before divider)').toBeGreaterThan(
          idx('message-editor-link-btn')
        )
        expect(idx('message-editor-history-separator'), 'history divider sits after find').toBeGreaterThan(
          idx('message-editor-find-btn')
        )
        expect(idx('message-editor-history-separator'), 'history divider sits left of undo').toBeLessThan(
          idx('message-editor-undo-btn')
        )
        expect(idx('message-editor-undo-btn')).toBeLessThan(idx('message-editor-redo-btn'))
        const expandIdx = idx('message-editor-expand-btn')
        for (const tid of [
          'message-editor-mode-btn',
          'message-editor-bold-btn',
          'message-editor-link-btn',
          'message-editor-find-btn',
          'message-editor-history-separator',
          'message-editor-undo-btn',
          'message-editor-redo-btn'
        ]) {
          expect(expandIdx, 'expand is the last toolbar control').toBeGreaterThan(idx(tid))
        }
        const expandBox = await editorArea.locator('[data-testid="message-editor-expand-btn"]').boundingBox()
        const redoBox = await editorArea.locator('[data-testid="message-editor-redo-btn"]').boundingBox()
        expect(expandBox, 'expand must have geometry').not.toBeNull()
        expect(redoBox, 'redo must have geometry').not.toBeNull()
        expect(expandBox!.x, 'expand sits far-right of redo').toBeGreaterThan(redoBox!.x)
        expect(expandBox!.x, 'expand does not overlap redo').toBeGreaterThanOrEqual(redoBox!.x + redoBox!.width - 2)
        // Markup grouping (never forced positioning): undo/redo + divider live
        // inside the left scrollable tools group near search; the right end
        // group owns ONLY expand.
        const grouping = await editorArea.evaluate((area) => {
          const q = (tid: string) => area.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null
          const tools = area.querySelector('[data-testid="message-editor-tools-scroll"]') as HTMLElement | null
          const has = (el: HTMLElement | null) => !!el
          const inside = (tid: string) => !!tools && !!q(tid) && tools.contains(q(tid))
          const expand = q('message-editor-expand-btn')
          // The toolbar button's direct parent is the end group itself: antd
          // Tooltip clones the enabled button with no wrapper DOM (and the
          // component-test mock renders a fragment), so one level up is the
          // group — two levels up is the shared toolbar root that owns every
          // control and must never be mistaken for the end group.
          const endGroup = expand?.parentElement ?? null
          return {
            hasTools: has(tools),
            undoInTools: inside('message-editor-undo-btn'),
            redoInTools: inside('message-editor-redo-btn'),
            dividerInTools: inside('message-editor-history-separator'),
            searchInTools: inside('message-editor-find-btn'),
            expandInTools: inside('message-editor-expand-btn'),
            endOwnsUndo: !!endGroup?.querySelector('[data-testid="message-editor-undo-btn"]'),
            endOwnsRedo: !!endGroup?.querySelector('[data-testid="message-editor-redo-btn"]')
          }
        })
        expect(grouping.hasTools, 'tools scroll group must exist').toBe(true)
        expect(grouping.searchInTools, 'search stays in the left tools group').toBe(true)
        expect(grouping.undoInTools, 'undo sits left in the tools group near search').toBe(true)
        expect(grouping.redoInTools, 'redo sits left in the tools group near search').toBe(true)
        expect(grouping.dividerInTools, 'history divider sits in the left tools group').toBe(true)
        expect(grouping.expandInTools, 'expand never joins the tools group').toBe(false)
        expect(grouping.endOwnsUndo, 'right end group owns no undo').toBe(false)
        expect(grouping.endOwnsRedo, 'right end group owns no redo').toBe(false)
        const ariaLabels: string[] = await editorArea.evaluate((area) =>
          Array.from(area.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? '')
        )
        test.info().annotations.push({
          type: 'cme-toolbar-ids',
          description: `order=${order.filter(Boolean).join(',')} aria=${ariaLabels.join('|').slice(0, 400)}`
        })
      })

      await test.step('mode toggle uses show-edit wording in edit state', async () => {
        // Strict wording contract: the edit-state toggle reads "show edit"
        // (not "show source"). CONFLICT (do not weaken): current production
        // still uses t('message.edit.show_source')/"Show source", so the
        // preview-state assertion FAILS until production renames it.
        await expectMode(editorArea, 'source')
        const sourceLabel =
          (await modeToggle(editorArea)
            .getAttribute('aria-label')
            .catch(() => null)) ?? ''
        expect(sourceLabel, 'source-state toggle must offer preview').toMatch(/preview/i)
        await modeToggle(editorArea).click()
        await expectMode(editorArea, 'preview')
        const editLabel =
          (await modeToggle(editorArea)
            .getAttribute('aria-label')
            .catch(() => null)) ?? ''
        expect(editLabel, 'edit-state toggle must read as show-edit wording').toMatch(/edit/i)
        expect(editLabel, 'edit-state toggle must no longer read as show-source').not.toMatch(/source/i)
        await modeToggle(editorArea).click()
        await expectMode(editorArea, 'source')
      })

      await test.step('native undo/redo expose disabled states with visibly dim treatment', async () => {
        // Strict: fresh editor starts with an empty native stack (both native
        // disabled), then real input enables undo while redo stays disabled.
        // The disabled icon must be visibly dim versus enabled, matching the
        // global edit-mode disabled style — effective opacity and/or color,
        // child-propagation aware. No silent skip: equal/unreadable styles FAIL
        // so production picks opacity or color explicitly.
        const undoBtn = editorArea.locator('[data-testid="message-editor-undo-btn"]')
        const redoBtn = editorArea.locator('[data-testid="message-editor-redo-btn"]')
        await expect(undoBtn, 'undo starts disabled with an empty native stack').toBeDisabled({ timeout: 10000 })
        await expect(redoBtn, 'redo starts disabled with an empty native stack').toBeDisabled({ timeout: 10000 })
        const readEffective = (
          btn: Locator
        ): Promise<{
          color: string
          opacity: string
          iconColor: string
          iconOpacity: string
          effectiveOpacity: string
        } | null> =>
          btn
            .evaluate((el) => {
              const host = el as HTMLElement
              const cs = getComputedStyle(host)
              const icon = (host.querySelector('svg, .lucide') as HTMLElement | null) ?? host
              const ics = getComputedStyle(icon)
              let eff = 1
              let node: HTMLElement | null = host
              while (node) {
                const o = parseFloat(getComputedStyle(node).opacity || '1')
                if (Number.isFinite(o)) eff *= o
                node = node.parentElement
                if (node && !host.contains(node)) break
                if (!node || node === document.documentElement) break
              }
              return {
                color: cs.color,
                opacity: cs.opacity,
                iconColor: ics.color,
                iconOpacity: ics.opacity,
                effectiveOpacity: String(eff)
              }
            })
            .catch(() => null)
        const disabledStyle = await readEffective(undoBtn)
        expect(disabledStyle, 'disabled undo computed style must be readable (no silent skip)').not.toBeNull()
        await appendEditorText(page, editorArea, `\ntoolbar-probe-${tag}\n`)
        await expect(undoBtn, 'undo enables after real input').toBeEnabled({ timeout: 10000 })
        await expect(redoBtn, 'redo stays disabled after a single input (nothing to redo)').toBeDisabled({
          timeout: 10000
        })
        const enabledStyle = await readEffective(undoBtn)
        expect(enabledStyle, 'enabled undo computed style must be readable').not.toBeNull()
        const stillDisabledStyle = await readEffective(redoBtn)
        expect(stillDisabledStyle, 'still-disabled redo style must be readable').not.toBeNull()
        test.info().annotations.push({
          type: 'cme-toolbar-disabled-style',
          description: `disabled=${JSON.stringify(disabledStyle)} enabled=${JSON.stringify(enabledStyle)} redoDisabled=${JSON.stringify(stillDisabledStyle)}`
        })
        const dimDelta =
          disabledStyle!.color !== enabledStyle!.color ||
          disabledStyle!.opacity !== enabledStyle!.opacity ||
          disabledStyle!.iconColor !== enabledStyle!.iconColor ||
          disabledStyle!.iconOpacity !== enabledStyle!.iconOpacity ||
          disabledStyle!.effectiveOpacity !== enabledStyle!.effectiveOpacity
        expect(dimDelta, 'disabled undo icon is visibly dim versus enabled (opacity and/or color, child-aware)').toBe(
          true
        )
        const redoMatchesDisabled =
          stillDisabledStyle!.color === disabledStyle!.color &&
          stillDisabledStyle!.opacity === disabledStyle!.opacity &&
          stillDisabledStyle!.iconColor === disabledStyle!.iconColor
        expect(redoMatchesDisabled, 'still-disabled redo shares the same dim treatment as disabled undo').toBe(true)
      })

      await test.step('expanded modal pins chrome and scrolls exactly one content plane in source AND preview', async () => {
        await editorArea.locator('[data-testid="message-editor-expand-btn"]').click()
        const modal = page.locator('[data-testid="message-editor-expanded"]')
        await expect(modal, 'expanded modal root must render').toBeVisible({ timeout: 10000 })
        let modalBox = await modal.boundingBox()
        expect(modalBox, 'expanded modal must have geometry').not.toBeNull()
        const viewport = await viewportSize(page)
        expect(modalBox!.width, 'modal stays inside the owned window width').toBeLessThanOrEqual(viewport.width)
        expect(modalBox!.height, 'modal stays inside the owned window height').toBeLessThanOrEqual(
          viewport.height * 0.95
        )

        // Modal mode toggle is guaranteed (strict): exactly one, toggle-only.
        await expect(modeToggle(modal), 'expanded modal carries exactly one mode toggle').toHaveCount(1)
        await expect(modeToggle(modal), 'modal starts in source').toHaveAttribute('data-mode', 'source')

        async function outerScrollTops(): Promise<{ root: number; body: number; doc: number }> {
          return modal
            .evaluate((root) => {
              const r = root as HTMLElement
              const body = r.parentElement as HTMLElement | null
              const doc = document.scrollingElement as HTMLElement | null
              return {
                root: r.scrollTop ?? 0,
                body: body ? (body.scrollTop ?? 0) : 0,
                doc: doc ? (doc.scrollTop ?? 0) : 0
              }
            })
            .catch(() => ({ root: -1, body: -1, doc: -1 }))
        }

        async function outerOverflow(): Promise<{ rootSh: number; rootCh: number; bodySh: number; bodyCh: number }> {
          return modal
            .evaluate((root) => {
              const r = root as HTMLElement
              const body = r.parentElement as HTMLElement | null
              return {
                rootSh: r.scrollHeight ?? 0,
                rootCh: r.clientHeight ?? 0,
                bodySh: body ? (body.scrollHeight ?? 0) : 0,
                bodyCh: body ? (body.clientHeight ?? 0) : 0
              }
            })
            .catch(() => ({ rootSh: -1, rootCh: -1, bodySh: -1, bodyCh: -1 }))
        }

        async function singlePlaneCount(): Promise<{ n: number; detail: string }> {
          return modal
            .evaluate((root) => {
              // User scrollplanes only: visible positive-size elements whose
              // computed overflow-y is scroll/auto and whose content overflows.
              // CM internal decoration layers (.cm-layer: sh>0, ch==0, hidden or
              // overflow-visible) and hidden DOM never count, even though their
              // raw scrollHeight exceeds clientHeight.
              const isUserPlane = (e: HTMLElement): boolean => {
                if (e === root) return false
                if (e.classList && e.classList.contains('cm-layer')) return false
                if (e.clientHeight <= 0 || e.clientWidth <= 0) return false
                if (e.scrollHeight <= e.clientHeight + 40) return false
                const cs = getComputedStyle(e)
                if (cs.display === 'none' || cs.visibility === 'hidden') return false
                if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') return false
                const r = e.getBoundingClientRect()
                if (!(r.width > 0 && r.height > 0)) return false
                return true
              }
              const list = Array.from(root.querySelectorAll('*'))
                .map((e) => e as HTMLElement)
                .filter(isUserPlane)
                .map(
                  (e) =>
                    `${(e.className && String(e.className).slice(0, 40)) || e.tagName.toLowerCase()}:${e.scrollHeight}/${e.clientHeight}`
                )
              return { n: list.length, detail: list.slice(0, 4).join('|') }
            })
            .catch(() => ({ n: -1, detail: 'unreadable' }))
        }

        // ---- SOURCE plane: strict .cm-scroller target (CONFLICT: current
        // production expanded source does not scroll while preview does — the
        // assertions below FAIL until production restores the single-plane
        // source scroll; do not weaken to overflow:hidden-only).
        // Deterministic start: modal transition + CodeMirror async
        // render-restore settle FIRST (RAF/geometry quiescence), then a public
        // ControlOrMeta+Home moves the existing source to its readable start.
        // The wheel baseline is captured right before the wheel — never an
        // early pre-settle value — so async remount restoration is not
        // attributed to the wheel. Downward wheel must still increase.
        async function readScrollerState(): Promise<{ sh: number; ch: number; top: number; max: number }> {
          return sourceScroller
            .evaluate((el) => {
              const h = el as HTMLElement
              return { sh: h.scrollHeight, ch: h.clientHeight, top: h.scrollTop, max: h.scrollHeight - h.clientHeight }
            })
            .catch(() => ({ sh: -1, ch: -1, top: -1, max: -1 }))
        }
        async function waitForModalQuiescence(timeoutMs = 8000): Promise<string> {
          // Consecutive quiet samples across animation frames: modal box
          // stable, scroller geometry stable, no running Web Animations (covers
          // the modal transition), scroller top quiet. Polling intervals only;
          // never a single fixed delay as readiness proof.
          let quiet = 0
          let lastBox: { x: number; y: number; w: number; h: number } | null = null
          let lastDims: { sh: number; ch: number; top: number } | null = null
          let lastAnims = -1
          let samples = 0
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            await page.evaluate(
              () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
            )
            const box = await modal.boundingBox().catch(() => null)
            const dims = await readScrollerState().catch(() => ({ sh: -1, ch: -1, top: -1, max: -1 }))
            const anims: number = await modal
              .evaluate((root) => (root as HTMLElement).getAnimations().length)
              .catch(() => -1)
            samples++
            if (box && dims.sh > 0 && anims >= 0) {
              const cur = { x: box.x, y: box.y, w: box.width, h: box.height }
              if (
                lastBox &&
                lastDims &&
                Math.abs(cur.x - lastBox.x) <= 1 &&
                Math.abs(cur.y - lastBox.y) <= 1 &&
                Math.abs(cur.w - lastBox.w) <= 1 &&
                Math.abs(cur.h - lastBox.h) <= 1 &&
                dims.sh === lastDims.sh &&
                dims.ch === lastDims.ch &&
                Math.abs(dims.top - lastDims.top) <= 2 &&
                anims === 0 &&
                lastAnims === 0
              ) {
                quiet++
                if (quiet >= 3) return `modal-quiet samples=${samples} anims=${anims}`
              } else {
                quiet = 0
              }
              lastBox = cur
              lastDims = { sh: dims.sh, ch: dims.ch, top: dims.top }
              lastAnims = anims
            }
            await page.waitForTimeout(80)
          }
          throw new Error('modal transition/scroller geometry never reached quiescence')
        }
        async function waitForScrollerTopQuiet(timeoutMs = 5000): Promise<string> {
          let quiet = 0
          let last: { sh: number; ch: number; top: number } | null = null
          let samples = 0
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            await page.evaluate(
              () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
            )
            const dims = await readScrollerState()
            samples++
            if (dims.sh > 0) {
              if (last && dims.sh === last.sh && dims.ch === last.ch && Math.abs(dims.top - last.top) <= 2) {
                quiet++
                if (quiet >= 3) return `scroller-quiet samples=${samples} top=${Math.round(dims.top)}`
              } else {
                quiet = 0
              }
              last = { sh: dims.sh, ch: dims.ch, top: dims.top }
            }
            await page.waitForTimeout(80)
          }
          throw new Error('source scroller top/geometry never stabilized')
        }
        const sourceScroller = cmScroller(modal)
        await expect(sourceScroller, 'expanded source .cm-scroller must mount').toBeVisible({ timeout: 10000 })
        const modalReady = await waitForModalQuiescence()
        // Public deterministic start on the EXISTING source: focus then
        // document-start key (read-only gesture, history untouched — native
        // history depth stays owned by the separate native-history test).
        await cmContent(modal).click()
        await page.keyboard.press('ControlOrMeta+Home')
        await expect(cmContent(modal), 'document-start key shows the head').toContainText(`Long draft ${tag}`, {
          timeout: 10000
        })
        const scrollerReady = await waitForScrollerTopQuiet()
        test.info().annotations.push({ type: 'cme-modal-readiness', description: `${modalReady}; ${scrollerReady}` })
        // Refresh the modal box AFTER quiescence: the pre-animation capture
        // (~1400 pre-wait) is stale once the transition settles, and must not
        // scope any future Save/Cancel in-bounds assertion.
        modalBox = await modal.boundingBox()
        expect(modalBox, 'expanded modal keeps geometry after quiescence').not.toBeNull()
        const srcDims = await readScrollerState()
        expect(srcDims.ch, 'source scroller must have a client height').toBeGreaterThan(0)
        expect(
          srcDims.sh,
          `LONG source must overflow its scroller (sh>ch): sh=${srcDims.sh} ch=${srcDims.ch}`
        ).toBeGreaterThan(srcDims.ch)
        const srcTop0: number = srcDims.top
        const srcMax: number = srcDims.max
        const outer0 = await outerScrollTops()
        expect(outer0.root, 'modal root starts unscrollable at top').toBe(0)
        const saveBtn = modal.locator('.message-editor-save-btn')
        const cancelBtn = modal.locator('[aria-label="Cancel"], [aria-label="取消"]').first()
        await expect(saveBtn, 'save stays available while expanded').toBeVisible()
        const saveBefore = await saveBtn.boundingBox()
        const cancelBefore = await cancelBtn.boundingBox().catch(() => null)
        expect(saveBefore, 'save must have geometry before scroll').not.toBeNull()
        const scrollerBox = await sourceScroller.boundingBox()
        expect(scrollerBox, 'source scroller must have geometry').not.toBeNull()
        const srcCx = scrollerBox!.x + scrollerBox!.width / 2
        const srcCy = scrollerBox!.y + scrollerBox!.height / 2
        const srcHit: { hit: boolean; describe: string } = await page
          .evaluate(
            ({ x, y }: { x: number; y: number }) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null
              if (!el) return { hit: false, describe: 'null' }
              const inScroller = el.closest('.cm-scroller') !== null
              const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : String(el.tagName)
              return {
                hit: inScroller,
                describe: `${el.tagName.toLowerCase()}.${cls} text=${(el.textContent || '').slice(0, 40)}`
              }
            },
            { x: srcCx, y: srcCy }
          )
          .catch(() => ({ hit: false, describe: 'unreadable' }))
        expect(srcHit.hit, `wheel must hit-test to the actual source plane (got ${srcHit.describe})`).toBe(true)
        await page.mouse.move(srcCx, srcCy)
        await page.mouse.wheel(0, 600)
        await expect
          .poll(async () => sourceScroller.evaluate((el) => (el as HTMLElement).scrollTop).catch(() => -1), {
            timeout: 5000
          })
          .toBeGreaterThan(srcTop0)
        const srcTop1: number = await sourceScroller.evaluate((el) => (el as HTMLElement).scrollTop).catch(() => -1)
        expect(srcTop1, 'real wheel over LONG source moves its own .cm-scroller scrollTop').toBeGreaterThan(srcTop0)
        expect(srcTop1, `forward wheel stays bounded to current max=${srcMax}`).toBeLessThanOrEqual(srcMax + 2)
        // Reverse + forward again on the same settled baseline proves both
        // directions on the actual plane (downward still increases).
        await page.mouse.wheel(0, -600)
        await expect
          .poll(async () => sourceScroller.evaluate((el) => (el as HTMLElement).scrollTop).catch(() => -1), {
            timeout: 5000
          })
          .toBeLessThan(srcTop1)
        const srcTop2: number = await sourceScroller.evaluate((el) => (el as HTMLElement).scrollTop).catch(() => -1)
        expect(srcTop2, 'reverse wheel moves the same source plane back').toBeLessThan(srcTop1)
        await page.mouse.wheel(0, 600)
        await expect
          .poll(async () => sourceScroller.evaluate((el) => (el as HTMLElement).scrollTop).catch(() => -1), {
            timeout: 5000
          })
          .toBeGreaterThan(srcTop2)
        const srcTop3: number = await sourceScroller.evaluate((el) => (el as HTMLElement).scrollTop).catch(() => -1)
        expect(srcTop3, 'forward wheel again moves the same source plane forward').toBeGreaterThan(srcTop2)
        expect(srcTop3, `second forward wheel stays bounded to current max=${srcMax}`).toBeLessThanOrEqual(srcMax + 2)
        const outer1 = await outerScrollTops()
        expect(outer1.root, 'modal root stays pinned at scrollTop 0 while source scrolls').toBe(0)
        expect(outer1.body, 'modal body stays pinned at scrollTop 0 while source scrolls').toBe(0)
        expect(outer1.doc, 'document stays pinned at scrollTop 0 while source scrolls').toBe(0)
        const saveAfter = await saveBtn.boundingBox()
        expect(saveAfter, 'save must keep geometry after source scroll').not.toBeNull()
        expect(Math.abs(saveAfter!.y - saveBefore!.y), 'Save stays pinned while source scrolls').toBeLessThanOrEqual(4)
        // Current-geometry in-bounds: re-resolve the modal box RIGHT BEFORE
        // the assertion (never the stale pre-animation capture) and record
        // both boxes so a failure shows numbers, not only false.
        const modalNow = await modal.boundingBox()
        expect(modalNow, 'modal keeps current geometry before Save in-bounds check').not.toBeNull()
        expect(
          saveAfter!.y >= modalNow!.y && saveAfter!.y + saveAfter!.height <= modalNow!.y + modalNow!.height + 1,
          `Save remains in current modal bounds (no clipping): save y=${saveAfter!.y.toFixed(1)} h=${saveAfter!.height.toFixed(1)} modal y=${modalNow!.y.toFixed(1)} h=${modalNow!.height.toFixed(1)}`
        ).toBe(true)
        if (cancelBefore) {
          const cancelAfter = await cancelBtn.boundingBox().catch(() => null)
          expect(cancelAfter, 'cancel must keep geometry after source scroll').not.toBeNull()
          expect(Math.abs(cancelAfter!.y - cancelBefore.y), 'Cancel stays pinned with Save').toBeLessThanOrEqual(4)
        }
        const planesSrc = await singlePlaneCount()
        expect(planesSrc.n, `exactly one content plane scrolls in source: ${planesSrc.detail}`).toBe(1)

        // Caret/navigation probes on the LONG source: Home shows the head,
        // End shows the tail (real keys, virtualization-aware substring only).
        await cmContent(modal).click()
        await page.keyboard.press('ControlOrMeta+Home')
        await expect(cmContent(modal)).toContainText(`Long draft ${tag}`, { timeout: 10000 })
        await page.keyboard.press('ControlOrMeta+End')
        await expect(cmContent(modal)).toContainText(`${tag}-end`, { timeout: 10000 })

        // ---- PREVIEW plane: real wheel on a known scroll target; mode swap
        // preserves the raw draft and the native history depth.
        const undoBtnModal = modal.locator('[data-testid="message-editor-undo-btn"]')
        const undoEnabledBefore = await undoBtnModal.isEnabled().catch(() => false)
        await modeToggle(modal).click()
        await expect(modeToggle(modal), 'modal preview mode engages').toHaveAttribute('data-mode', 'preview')
        await expect(modal).toContainText(`Long draft ${tag}`, { timeout: 10000 })
        await expect(modal).toContainText(`col-a-${tag}`, { timeout: 10000 })
        const previewTarget = previewMarkdown(modal)
        await expect(previewTarget, 'rendered preview markdown must mount').toBeVisible({ timeout: 10000 })
        // Read-only DOM ancestor fact: the actual preview scroll plane and its
        // box (production MessageEditor renders <PreviewScroll><Markdown>,
        // Markdown renders div.markdown — the content div itself is thousands
        // of px tall, so its own center falls outside the window and
        // elementFromPoint returns null; the wheel point MUST come from the
        // plane rect, never the full Markdown box).
        async function readPreviewPlane(): Promise<{
          sh: number
          ch: number
          top: number
          found: boolean
          x: number
          y: number
          width: number
          height: number
        }> {
          return modal
            .evaluate((root) => {
              const md = (root.querySelector('p.markdown, div.markdown') as HTMLElement | null) ?? null
              if (!md) return { sh: -1, ch: -1, top: -1, found: false, x: -1, y: -1, width: -1, height: -1 }
              // Same user-plane rule as singlePlaneCount: visible positive-size,
              // overflow-y scroll/auto, content overflow; .cm-layer/hidden excluded.
              const isUserPlane = (e: HTMLElement): boolean => {
                if (e === root) return false
                if (e.classList && e.classList.contains('cm-layer')) return false
                if (e.clientHeight <= 0 || e.clientWidth <= 0) return false
                if (e.scrollHeight <= e.clientHeight + 40) return false
                const cs = getComputedStyle(e)
                if (cs.display === 'none' || cs.visibility === 'hidden') return false
                if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') return false
                const r = e.getBoundingClientRect()
                if (!(r.width > 0 && r.height > 0)) return false
                return true
              }
              const overflows = (e: HTMLElement): boolean => e.scrollHeight > e.clientHeight + 40
              let plane: HTMLElement | null = md.parentElement
              while (plane && plane !== root && (!overflows(plane) || !isUserPlane(plane))) {
                plane = plane.parentElement
              }
              if (!plane || plane === root) {
                // Fall back to the largest inner USER scrollable (never the root).
                let best: HTMLElement | null = null
                for (const e of Array.from(root.querySelectorAll('*'))) {
                  const h = e as HTMLElement
                  if (h === root) continue
                  if (isUserPlane(h) && (!best || h.scrollHeight > best.scrollHeight)) best = h
                }
                plane = best
              }
              if (!plane) return { sh: -1, ch: -1, top: -1, found: false, x: -1, y: -1, width: -1, height: -1 }
              const r = plane.getBoundingClientRect()
              return {
                sh: plane.scrollHeight,
                ch: plane.clientHeight,
                top: plane.scrollTop,
                found: true,
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height
              }
            })
            .catch(() => ({ sh: -1, ch: -1, top: -1, found: false, x: -1, y: -1, width: -1, height: -1 }))
        }
        const prevDims = await readPreviewPlane()
        expect(prevDims.found, 'preview scroll plane must exist').toBe(true)
        expect(prevDims.ch, 'preview plane must have a client height').toBeGreaterThan(0)
        expect(
          prevDims.sh,
          `LONG preview must overflow its plane: sh=${prevDims.sh} ch=${prevDims.ch}`
        ).toBeGreaterThan(prevDims.ch)
        // Same public approach as source: stabilize the preview plane, capture
        // the actual baseline right before the wheel, hit-test the real plane.
        async function readPreviewPlaneTop(): Promise<number> {
          return (await readPreviewPlane()).top
        }
        // Preview-plane quiescence: consecutive quiet top samples across RAF.
        {
          let quiet = 0
          let lastTop: number | null = null
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            await page.evaluate(
              () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
            )
            const curTop = await readPreviewPlaneTop()
            if (curTop >= 0) {
              if (lastTop !== null && Math.abs(curTop - lastTop) <= 2) {
                quiet++
                if (quiet >= 3) break
              } else {
                quiet = 0
              }
              lastTop = curTop
            }
            await page.waitForTimeout(80)
          }
          test.info().annotations.push({
            type: 'cme-preview-readiness',
            description: `preview-plane quiet top=${lastTop !== null ? Math.round(lastTop) : 'na'}`
          })
        }
        // Wheel point from the ACTUAL plane rect — never the full Markdown
        // content box (thousands of px tall; its center sits outside the owned
        // window so elementFromPoint returns null). Strict: elementFromPoint
        // must be non-null AND inside the re-resolved plane; no permissive
        // modal-only fallback.
        const prevCx = prevDims.x + prevDims.width / 2
        const prevCy = prevDims.y + prevDims.height / 2
        const prevHit: { hit: boolean; describe: string } = await page
          .evaluate(
            ({ x, y }: { x: number; y: number }) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null
              if (!el) return { hit: false, describe: 'null' }
              const modalRoot = document.querySelector('[data-testid="message-editor-expanded"]') as HTMLElement | null
              if (!modalRoot) return { hit: false, describe: 'no-modal-root' }
              const md = modalRoot.querySelector('p.markdown, div.markdown') as HTMLElement | null
              let plane: HTMLElement | null = md?.parentElement ?? null
              const overflows = (e: HTMLElement): boolean => e.scrollHeight > e.clientHeight + 40
              const isUserPlane = (e: HTMLElement): boolean => {
                if (e === modalRoot) return false
                if (e.classList && e.classList.contains('cm-layer')) return false
                if (e.clientHeight <= 0 || e.clientWidth <= 0) return false
                if (e.scrollHeight <= e.clientHeight + 40) return false
                const cs = getComputedStyle(e)
                if (cs.display === 'none' || cs.visibility === 'hidden') return false
                if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') return false
                const r = e.getBoundingClientRect()
                if (!(r.width > 0 && r.height > 0)) return false
                return true
              }
              while (plane && plane !== modalRoot && (!overflows(plane) || !isUserPlane(plane))) {
                plane = plane.parentElement
              }
              if (!plane || plane === modalRoot) {
                let best: HTMLElement | null = null
                for (const e of Array.from(modalRoot.querySelectorAll('*'))) {
                  const h = e as HTMLElement
                  if (h === modalRoot) continue
                  if (isUserPlane(h) && (!best || h.scrollHeight > best.scrollHeight)) best = h
                }
                plane = best
              }
              const onChrome = el.closest('button') !== null
              const inPlane = !!plane && plane.contains(el)
              const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : String(el.tagName)
              return {
                hit: inPlane && !onChrome,
                describe: `${el.tagName.toLowerCase()}.${cls} text=${(el.textContent || '').slice(0, 40)}`
              }
            },
            { x: prevCx, y: prevCy }
          )
          .catch(() => ({ hit: false, describe: 'unreadable' }))
        expect(prevHit.hit, `wheel must hit-test to the actual preview plane (got ${prevHit.describe})`).toBe(true)
        const prevTop0 = await readPreviewPlaneTop()
        const prevMax = prevDims.sh - prevDims.ch
        await page.mouse.move(prevCx, prevCy)
        await page.mouse.wheel(0, 600)
        await expect.poll(async () => readPreviewPlaneTop(), { timeout: 5000 }).toBeGreaterThan(prevTop0)
        const prevTopAfter: number = await readPreviewPlaneTop()
        expect(prevTopAfter, 'real wheel over preview moves the single preview plane').toBeGreaterThan(prevTop0)
        expect(prevTopAfter, `preview wheel stays bounded to current max=${prevMax}`).toBeLessThanOrEqual(prevMax + 2)
        const outerPrev = await outerScrollTops()
        expect(outerPrev.root, 'modal root stays pinned while preview scrolls').toBe(0)
        const savePreview = await saveBtn.boundingBox()
        expect(Math.abs(savePreview!.y - saveAfter!.y), 'Save stays pinned while preview scrolls').toBeLessThanOrEqual(
          4
        )
        const modalPreviewNow = await modal.boundingBox()
        expect(modalPreviewNow, 'modal keeps current geometry in preview').not.toBeNull()
        expect(
          savePreview!.y >= modalPreviewNow!.y &&
            savePreview!.y + savePreview!.height <= modalPreviewNow!.y + modalPreviewNow!.height + 1,
          `Save remains in current preview modal bounds: save y=${savePreview!.y.toFixed(1)} h=${savePreview!.height.toFixed(1)} modal y=${modalPreviewNow!.y.toFixed(1)} h=${modalPreviewNow!.height.toFixed(1)}`
        ).toBe(true)
        const planesPrev = await singlePlaneCount()
        expect(planesPrev.n, `exactly one content plane scrolls in preview: ${planesPrev.detail}`).toBe(1)
        const outerOv = await outerOverflow()
        test.info().annotations.push({
          type: 'cme-modal-planes',
          description: `src sh/ch=${srcDims.sh}/${srcDims.ch} max=${srcMax} top0->1->2->3=${srcTop0}->${srcTop1}->${srcTop2}->${srcTop3} prev sh/ch=${prevDims.sh}/${prevDims.ch} max=${prevMax} prevTop0->after=${prevTop0}->${prevTopAfter} rootSh/Ch=${outerOv.rootSh}/${outerOv.rootCh} planesSrc=${planesSrc.detail} planesPrev=${planesPrev.detail}`
        })

        // Mode swap back preserves the raw draft and history depth.
        await modeToggle(modal).click()
        await expect(modeToggle(modal), 'modal returns to source').toHaveAttribute('data-mode', 'source')
        await expect(cmScroller(modal), 'source scroller remounts after preview').toBeVisible({ timeout: 10000 })
        await cmContent(modal).click()
        await page.keyboard.press('ControlOrMeta+Home')
        await expect(cmContent(modal)).toContainText(`Long draft ${tag}`, { timeout: 10000 })
        const undoEnabledAfter = await modal
          .locator('[data-testid="message-editor-undo-btn"]')
          .isEnabled()
          .catch(() => false)
        expect(undoEnabledAfter, 'mode swap preserves native history enablement').toBe(undoEnabledBefore)

        // Small owned-window flex re-check (same disposable profile/window):
        // shrink, reopen is unnecessary — the live modal must stay bounded.
        await electronApp
          .evaluate(({ BrowserWindow }) => {
            const win = (
              BrowserWindow as unknown as { getAllWindows: () => Array<{ setSize: (w: number, h: number) => void }> }
            ).getAllWindows()[0]
            win.setSize(1000, 620)
          })
          .catch(() => {})
        await page.waitForTimeout(500)
        const smallViewport = await viewportSize(page)
        const smallBox = await modal.boundingBox()
        expect(smallBox, 'modal keeps geometry at the small owned size').not.toBeNull()
        expect(smallBox!.width, 'modal stays inside the small owned width').toBeLessThanOrEqual(smallViewport.width)
        expect(smallBox!.height, 'modal stays inside the small owned height').toBeLessThanOrEqual(
          smallViewport.height * 0.95
        )
        const smallPlanes = await singlePlaneCount()
        expect(smallPlanes.n, `still exactly one content plane at the small size: ${smallPlanes.detail}`).toBe(1)
        await electronApp
          .evaluate(({ BrowserWindow }) => {
            const win = (
              BrowserWindow as unknown as { getAllWindows: () => Array<{ setSize: (w: number, h: number) => void }> }
            ).getAllWindows()[0]
            win.setSize(1280, 800)
          })
          .catch(() => {})
        await page.waitForTimeout(400)

        const collapseBtn = modal.locator('[data-testid="message-editor-collapse-btn"]')
        await expect(collapseBtn, 'collapse control must render').toBeVisible({ timeout: 10000 })
        await collapseBtn.click()
        await expect(modal, 'collapse closes the expansion').not.toBeVisible({ timeout: 10000 })
        const cm = cmContent(editorArea)
        await expect(cm, 'inline editor retains the draft after collapse').toBeVisible({ timeout: 10000 })
      })
    } finally {
      if (initialSize) {
        const [w, h] = initialSize
        await electronApp
          .evaluate(
            ({ BrowserWindow }, init: { w: number; h: number }) => {
              try {
                const win = (
                  BrowserWindow as unknown as {
                    getAllWindows: () => Array<{ setSize: (w: number, h: number) => void }>
                  }
                ).getAllWindows()[0]
                win.setSize(init.w, init.h)
              } catch {
                // Best-effort restore — never mask the test result.
              }
            },
            { w, h }
          )
          .catch(() => {})
      }
    }
  })

  test('narrow 960 toolbar keeps expand reachable with tools scrolling internally', async ({
    mainWindow,
    electronApp
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR TOOLBAR NARROW 960 (INTEGRATED): at a real 960px owned window the inline toolbar keeps the far-right Expand fully inside the #messages visible rect and the window viewport (fresh bbox plus elementFromPoint hit on the target chat row, never forced), a real click expands with the shared draft and modal chrome, tools-group horizontal scroll never moves Expand, and both toolbar ends answer real keyboard focus plus Enter. Real UI gestures only — no force click, no scroll-DOM writes.'
    })
    const page: Page = mainWindow
    const tag = `cmn-${Date.now().toString(36)}`
    const initialSize = await electronApp
      .evaluate(({ BrowserWindow }) => {
        const win = (
          BrowserWindow as unknown as { getAllWindows: () => Array<{ getSize: () => number[] }> }
        ).getAllWindows()[0]
        return win.getSize() as [number, number]
      })
      .catch(() => null)
    try {
      // Real narrow scene via the standard Electron size (the app default is
      // already ~960 wide; this pins the exact narrow geometry for the run).
      await electronApp
        .evaluate(({ BrowserWindow }) => {
          const win = (
            BrowserWindow as unknown as { getAllWindows: () => Array<{ setSize: (w: number, h: number) => void }> }
          ).getAllWindows()[0]
          win.setSize(960, 800)
        })
        .catch(() => {})
      await page.waitForTimeout(600)
      const seeded = await test.step('seed long assistant draft and activate route', async () =>
        seedLongAssistantDraft(page, tag))

      const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () =>
        openAssistantEditor(page, seeded.assistantMsgId))

      const expandBtn = editorArea.locator('[data-testid="message-editor-expand-btn"]')
      await expect(expandBtn, 'expand control must render').toBeVisible({ timeout: 10000 })

      // Action preparation only (never a per-frame baseline): when the
      // toolbar sits vertically outside the chat viewport, reveal it with
      // genuine outer-gutter wheels through the shared readiness helper.
      await test.step('reveal the toolbar with genuine outer wheels only if needed', async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const msgsBox = await page.locator('#messages').first().boundingBox()
          const btnBox = await expandBtn.boundingBox().catch(() => null)
          if (msgsBox && btnBox && btnBox.y >= msgsBox.y && btnBox.y + btnBox.height <= msgsBox.y + msgsBox.height) {
            return
          }
          const outer = await findOuterChatGutterWheelPoint(page)
          await page.mouse.move(outer.x, outer.y)
          await page.mouse.wheel(0, btnBox && msgsBox && btnBox.y < msgsBox.y ? -240 : 240)
          await page.waitForTimeout(300)
        }
      })

      const narrowBaseline = await test.step('fresh bbox proves expand fully inside chat and viewport', async () => {
        const msgsBox = await page.locator('#messages').first().boundingBox()
        expect(msgsBox, '#messages must have geometry at 960').not.toBeNull()
        const btnBox = await expandBtn.boundingBox()
        expect(btnBox, 'expand must have geometry at 960').not.toBeNull()
        const vp = await viewportSize(page)
        expect(vp.width, 'narrow scene stays near 960 wide (never silently widened)').toBeLessThanOrEqual(1024)
        // Complete bounds inside the chat visible clip AND the window viewport.
        expect(btnBox!.x, 'expand left stays inside chat').toBeGreaterThanOrEqual(msgsBox!.x - 2)
        expect(
          btnBox!.x + btnBox!.width,
          'expand right stays inside chat (never under the sidebar)'
        ).toBeLessThanOrEqual(msgsBox!.x + msgsBox!.width + 2)
        expect(btnBox!.y, 'expand top stays inside chat').toBeGreaterThanOrEqual(msgsBox!.y - 2)
        expect(btnBox!.y + btnBox!.height, 'expand bottom stays inside chat').toBeLessThanOrEqual(
          msgsBox!.y + msgsBox!.height + 2
        )
        expect(btnBox!.x).toBeGreaterThanOrEqual(-2)
        expect(btnBox!.y).toBeGreaterThanOrEqual(-2)
        expect(btnBox!.x + btnBox!.width).toBeLessThanOrEqual(vp.width + 2)
        expect(btnBox!.y + btnBox!.height).toBeLessThanOrEqual(vp.height + 2)
        const hit = await page
          .evaluate(
            ({ x, y }: { x: number; y: number }) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null
              if (!el) return { hit: false, describe: 'null' }
              const btn = el.closest('[data-testid="message-editor-expand-btn"]')
              const row = el.closest('[data-message-id]')
              return {
                hit: btn !== null,
                describe: `${el.tagName.toLowerCase()} row=${row?.getAttribute('data-message-id') ?? '-'}`
              }
            },
            { x: btnBox!.x + btnBox!.width / 2, y: btnBox!.y + btnBox!.height / 2 }
          )
          .catch(() => ({ hit: false, describe: 'unreadable' }))
        expect(hit.hit, `expand center hit-tests to the real button at 960 (got ${hit.describe})`).toBe(true)
        // Chat-column boundary: the hit row is the target assistant message, never the sidebar.
        expect(hit.describe, 'expand hit stays in the target chat row').toContain(seeded.assistantMsgId)
        test.info().annotations.push({
          type: 'cme-narrow-960',
          description: `tag=${tag} expand=${Math.round(btnBox!.x)},${Math.round(btnBox!.y)} ${Math.round(btnBox!.width)}x${Math.round(btnBox!.height)} msgs=${Math.round(msgsBox!.x)},${Math.round(msgsBox!.y)} ${Math.round(msgsBox!.width)}x${Math.round(msgsBox!.height)} vp=${vp.width}x${vp.height}`
        })
        return { btnBox: btnBox! }
      })

      await test.step('real click expands with the shared draft at 960', async () => {
        await expandBtn.click()
        const modal = page.locator('[data-testid="message-editor-expanded"]')
        await expect(modal, 'expanded modal root must render at 960').toBeVisible({ timeout: 10000 })
        // Virtualization renders the visible window only: the remount focuses
        // the tail, so the head needs a public document-start gesture first
        // (same pattern as the wide modal contract; exact full-doc text stays
        // Redux/SQLite owned).
        await cmContent(modal).click()
        await page.keyboard.press('ControlOrMeta+Home')
        await expect(cmContent(modal)).toContainText(`Long draft ${tag}`, { timeout: 10000 })
        await expect(modeToggle(modal), 'modal carries exactly one mode toggle').toHaveCount(1)
        await expect(modal.locator('.message-editor-save-btn'), 'save stays available while expanded').toBeVisible()
        await modal.locator('[data-testid="message-editor-collapse-btn"]').click()
        await expect(modal, 'collapse closes the expansion').not.toBeVisible({ timeout: 10000 })
        await expect(cmContent(editorArea), 'inline editor retains the draft after collapse').toBeVisible({
          timeout: 10000
        })
      })

      await test.step('tools-group scroll never carries expand away', async () => {
        const tools = editorArea.locator('[data-testid="message-editor-tools-scroll"]')
        await expect(tools, 'tools scroll group must render').toBeVisible({ timeout: 10000 })
        const dims = await tools
          .evaluate((el) => {
            const host = el as HTMLElement
            return { sw: host.scrollWidth, cw: host.clientWidth, left: host.scrollLeft }
          })
          .catch(() => null)
        expect(dims, 'tools group geometry must be readable').not.toBeNull()
        test.info().annotations.push({
          type: 'cme-narrow-tools',
          description: `sw=${dims!.sw} cw=${dims!.cw} left=${dims!.left}`
        })
        if (dims!.sw > dims!.cw + 2) {
          // Real horizontal wheel over the tools plane (no scroll-DOM writes):
          // the tools group may scroll internally while Expand must not move.
          const box = await tools.boundingBox()
          expect(box, 'tools group must have geometry').not.toBeNull()
          await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
          await page.mouse.wheel(240, 0)
          await page.waitForTimeout(300)
        }
        // Fresh re-probe: expand still fully inside chat and hit-testable.
        const msgsBox = await page.locator('#messages').first().boundingBox()
        const btnBox = await expandBtn.boundingBox()
        expect(btnBox, 'expand keeps geometry after tools scroll').not.toBeNull()
        expect(btnBox!.x + btnBox!.width).toBeLessThanOrEqual(msgsBox!.x + msgsBox!.width + 2)
        expect(Math.abs(btnBox!.x - narrowBaseline.btnBox.x), 'tools scroll never moves expand').toBeLessThanOrEqual(2)
        const hit = await page
          .evaluate(
            ({ x, y }: { x: number; y: number }) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null
              return el?.closest('[data-testid="message-editor-expand-btn"]') !== null
            },
            { x: btnBox!.x + btnBox!.width / 2, y: btnBox!.y + btnBox!.height / 2 }
          )
          .catch(() => false)
        expect(hit, 'expand still hit-tests after tools scroll').toBe(true)
      })

      await test.step('undo/redo stay left near search with expand alone far-right at 960', async () => {
        const undoBtn = editorArea.locator('[data-testid="message-editor-undo-btn"]')
        const redoBtn = editorArea.locator('[data-testid="message-editor-redo-btn"]')
        const searchBtn = editorArea.locator('[data-testid="message-editor-find-btn"]')
        for (const [btn, name] of [
          [undoBtn, 'undo'],
          [redoBtn, 'redo'],
          [searchBtn, 'search']
        ] as const) {
          await expect(btn, `${name} must render at 960`).toBeVisible({ timeout: 10000 })
        }
        const grouping = await editorArea.evaluate((area) => {
          const q = (tid: string) => area.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null
          const tools = area.querySelector('[data-testid="message-editor-tools-scroll"]') as HTMLElement | null
          const inside = (tid: string) => !!tools && !!q(tid) && tools.contains(q(tid))
          const expand = q('message-editor-expand-btn')
          // The toolbar button's direct parent is the end group itself: antd
          // Tooltip clones the enabled button with no wrapper DOM (and the
          // component-test mock renders a fragment), so one level up is the
          // group — two levels up is the shared toolbar root that owns every
          // control and must never be mistaken for the end group.
          const endGroup = expand?.parentElement ?? null
          return {
            undoInTools: inside('message-editor-undo-btn'),
            redoInTools: inside('message-editor-redo-btn'),
            expandInTools: inside('message-editor-expand-btn'),
            endOwnsUndo: !!endGroup?.querySelector('[data-testid="message-editor-undo-btn"]'),
            endOwnsRedo: !!endGroup?.querySelector('[data-testid="message-editor-redo-btn"]')
          }
        })
        expect(grouping.undoInTools, 'undo stays left in tools at 960').toBe(true)
        expect(grouping.redoInTools, 'redo stays left in tools at 960').toBe(true)
        expect(grouping.expandInTools, 'expand never joins tools at 960').toBe(false)
        expect(grouping.endOwnsUndo, 'right group owns no undo at 960').toBe(false)
        expect(grouping.endOwnsRedo, 'right group owns no redo at 960').toBe(false)
        const undoBox = await undoBtn.boundingBox()
        const redoBox = await redoBtn.boundingBox()
        const searchBox = await searchBtn.boundingBox()
        const expandBox = await expandBtn.boundingBox()
        expect(undoBox && redoBox && searchBox && expandBox, 'toolbar buttons must have geometry at 960').not.toBeNull()
        expect(undoBox!.x, 'undo sits right of search (near, left group)').toBeGreaterThan(searchBox!.x)
        expect(redoBox!.x, 'redo sits right of undo (near, left group)').toBeGreaterThan(undoBox!.x)
        expect(expandBox!.x, 'expand sits far-right of redo at 960').toBeGreaterThan(redoBox!.x)
        test.info().annotations.push({
          type: 'cme-narrow-960-grouping',
          description: `search.x=${Math.round(searchBox!.x)} undo.x=${Math.round(undoBox!.x)} redo.x=${Math.round(redoBox!.x)} expand.x=${Math.round(expandBox!.x)}`
        })
      })

      await test.step('both toolbar ends answer real keyboard focus and Enter', async () => {
        await expectMode(editorArea, 'source')
        await modeToggle(editorArea).focus()
        await page.keyboard.press('Enter')
        await expectMode(editorArea, 'preview')
        await modeToggle(editorArea).focus()
        await page.keyboard.press('Enter')
        await expectMode(editorArea, 'source')
        await expandBtn.focus()
        await page.keyboard.press('Enter')
        const modal = page.locator('[data-testid="message-editor-expanded"]')
        await expect(modal, 'keyboard Enter on expand opens the modal').toBeVisible({ timeout: 10000 })
        await page.keyboard.press('Escape')
        await expect(modal, 'Escape closes the keyboard-opened expansion').not.toBeVisible({ timeout: 10000 })
      })
    } finally {
      if (initialSize) {
        const [w, h] = initialSize
        await electronApp
          .evaluate(
            ({ BrowserWindow }, init: { w: number; h: number }) => {
              try {
                const win = (
                  BrowserWindow as unknown as {
                    getAllWindows: () => Array<{ setSize: (w: number, h: number) => void }>
                  }
                ).getAllWindows()[0]
                win.setSize(init.w, init.h)
              } catch {
                // Best-effort restore — never mask the test result.
              }
            },
            { w, h }
          )
          .catch(() => {})
      }
    }
  })

  test('expanded short message fills the fixed window and collapse preserves inline height/text/history', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CODEMIRROR EXPANDED SHORT FILL (INTEGRATED): a one-line assistant draft opens compact inline, expands into the independent fixed modal window (never the inline adaptive height — modal fills the original bounded height with internal CodeMirror scrolling even for short text, preview fills too), and collapse returns the approved inline session height with text/history intact. Toolbar keeps undo/redo left near search with expand alone far-right in the modal too. Real UI gestures only.'
    })
    const page: Page = mainWindow
    const tag = `cmf-${Date.now().toString(36)}`
    const shortContent = `short fill ${tag}`
    const seeded = await test.step('seed short assistant draft and activate route', async () =>
      seedLongAssistantDraft(page, tag, { assistantContent: shortContent }))
    const { editorArea } = await test.step('open assistant editor and prove CodeMirror mount', async () =>
      openAssistantEditor(page, seeded.assistantMsgId))

    const hInline = await test.step('short draft opens compact inline', async () => {
      const h = await surfaceHeight(editorArea)
      const gap = await inputBottomGap(editorArea)
      test.info().annotations.push({
        type: 'cme-shortfill-inline',
        description: `inline=${Math.round(h)} gap=${Number.isFinite(gap) ? gap.toFixed(1) : 'NaN'}`
      })
      expect(h, 'one-line draft opens compact at the one-line floor').toBeLessThanOrEqual(64)
      expect(Number.isNaN(gap), 'inline gap must be measurable').toBe(false)
      expect(gap, 'compact input keeps only normal slack').toBeLessThanOrEqual(32)
      return h
    })

    // Stage a session edit so history preservation is observable after the
    // expand/collapse round trip (real input enables native undo).
    await test.step('stage real input to arm native history', async () => {
      await appendEditorText(page, editorArea, '-tail')
      await expect(cmContent(editorArea)).toContainText(`${shortContent}-tail`, { timeout: 10000 })
      await expect(
        editorArea.locator('[data-testid="message-editor-undo-btn"]'),
        'undo arms after real input'
      ).toBeEnabled({ timeout: 10000 })
    })
    const hSession = await surfaceHeight(editorArea)

    await test.step('expand fills the fixed window (never the compact adaptive height)', async () => {
      await editorArea.locator('[data-testid="message-editor-expand-btn"]').click()
      const modal = page.locator('[data-testid="message-editor-expanded"]')
      await expect(modal, 'expanded modal root must render').toBeVisible({ timeout: 10000 })
      const viewport = await viewportSize(page)
      const modalBox = await modal.boundingBox()
      expect(modalBox, 'expanded modal must have geometry').not.toBeNull()
      // Independent meaning: the fixed window holds ~72vh even for one-line
      // text — never sized down to the compact inline height.
      expect(modalBox!.height, 'short-text modal still fills the fixed window height').toBeGreaterThanOrEqual(
        viewport.height * 0.6
      )
      expect(modalBox!.height).toBeLessThanOrEqual(viewport.height * 0.95)
      expect(
        modalBox!.height,
        `modal height (${Math.round(modalBox!.height)}) dwarfs the compact inline height (${Math.round(hSession)})`
      ).toBeGreaterThan(hSession + 150)
      // Modal body fills with internal scrolling (source): the editing wrapper
      // spans the body height, the scroller has a real client height.
      const bodyFill = await modal
        .evaluate((root) => {
          const r = root as HTMLElement
          const editing = r.querySelector('.editing-message') as HTMLElement | null
          const scroller = r.querySelector('.editing-message .cm-scroller') as HTMLElement | null
          if (!editing || !scroller) return null
          const rb = r.getBoundingClientRect()
          const eb = editing.getBoundingClientRect()
          return {
            rootH: rb.height,
            editingH: eb.height,
            scrollerCh: scroller.clientHeight,
            scrollerSh: scroller.scrollHeight,
            scrollerTop: scroller.scrollTop
          }
        })
        .catch(() => null)
      expect(bodyFill, 'modal body geometry must be readable').not.toBeNull()
      expect(bodyFill!.editingH, 'editing wrapper fills the modal body for short text').toBeGreaterThan(
        bodyFill!.rootH * 0.4
      )
      expect(bodyFill!.scrollerCh, 'modal scroller has a real client height for short text').toBeGreaterThan(0)
      expect(bodyFill!.scrollerSh, 'modal scroller scroll plane exists').toBeGreaterThanOrEqual(bodyFill!.scrollerCh)
      // Preview fills the modal too.
      await modeToggle(modal).click()
      await expect(modeToggle(modal), 'modal preview mode engages').toHaveAttribute('data-mode', 'preview')
      await expect(modal).toContainText(shortContent, { timeout: 10000 })
      const previewFill = await modal
        .evaluate((root) => {
          const r = root as HTMLElement
          const md = r.querySelector('p.markdown, div.markdown') as HTMLElement | null
          const plane = md?.parentElement ?? null
          if (!plane) return null
          const rb = r.getBoundingClientRect()
          const pb = (plane as HTMLElement).getBoundingClientRect()
          return { rootH: rb.height, planeH: pb.height, planeCh: (plane as HTMLElement).clientHeight }
        })
        .catch(() => null)
      expect(previewFill, 'preview plane geometry must be readable').not.toBeNull()
      expect(previewFill!.planeH, 'preview fills the modal body for short text').toBeGreaterThan(
        previewFill!.rootH * 0.4
      )
      await modeToggle(modal).click()
      await expect(modeToggle(modal), 'modal returns to source').toHaveAttribute('data-mode', 'source')
      // Modal toolbar keeps the same grouping: undo/redo left, collapse alone.
      const modalGrouping = await modal.evaluate((root) => {
        const r = root as HTMLElement
        const q = (tid: string) => r.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null
        const tools = r.querySelector('[data-testid="message-editor-tools-scroll"]') as HTMLElement | null
        const inside = (tid: string) => !!tools && !!q(tid) && tools.contains(q(tid))
        const collapse = q('message-editor-collapse-btn')
        // Same one-level rule as the inline toolbar: the direct parent is
        // the modal end group (no Tooltip wrapper DOM around enabled buttons).
        const endGroup = collapse?.parentElement ?? null
        const undoBox = q('message-editor-undo-btn')?.getBoundingClientRect() ?? null
        const collapseBox = collapse?.getBoundingClientRect() ?? null
        return {
          undoInTools: inside('message-editor-undo-btn'),
          collapseInTools: inside('message-editor-collapse-btn'),
          endOwnsUndo: !!endGroup?.querySelector('[data-testid="message-editor-undo-btn"]'),
          undoX: undoBox?.x ?? -1,
          collapseX: collapseBox?.x ?? -1
        }
      })
      expect(modalGrouping.undoInTools, 'modal undo stays left in tools').toBe(true)
      expect(modalGrouping.collapseInTools, 'collapse never joins tools').toBe(false)
      expect(modalGrouping.endOwnsUndo, 'modal right group owns no undo').toBe(false)
      expect(modalGrouping.collapseX, 'modal collapse sits far-right of undo').toBeGreaterThan(modalGrouping.undoX)
      test.info().annotations.push({
        type: 'cme-shortfill-modal',
        description: `modal=${Math.round(modalBox!.width)}x${Math.round(modalBox!.height)} inline=${Math.round(hSession)} editingH=${Math.round(bodyFill!.editingH)} scrollerCh=${Math.round(bodyFill!.scrollerCh)}`
      })
    })

    await test.step('collapse preserves the inline session height, text and history', async () => {
      const modal = page.locator('[data-testid="message-editor-expanded"]')
      await modal.locator('[data-testid="message-editor-collapse-btn"]').click()
      await expect(modal, 'collapse closes the expansion').not.toBeVisible({ timeout: 10000 })
      const cm = cmContent(editorArea)
      await expect(cm, 'inline editor remounts after collapse').toBeVisible({ timeout: 10000 })
      await expect(cm).toContainText(`${shortContent}-tail`, { timeout: 10000 })
      const hAfter = await surfaceHeight(editorArea)
      test.info().annotations.push({
        type: 'cme-shortfill-collapse',
        description: `session=${Math.round(hSession)} after=${Math.round(hAfter)} inline-open=${Math.round(hInline)}`
      })
      expect(Math.abs(hAfter - hSession), 'collapsed inline returns the approved session height').toBeLessThanOrEqual(6)
      await expect(
        editorArea.locator('[data-testid="message-editor-undo-btn"]'),
        'history survives expand->collapse'
      ).toBeEnabled({ timeout: 10000 })
      expect(hAfter, 'session height owns the collapsed surface').toBeGreaterThanOrEqual(hInline)
    })
  })
})
