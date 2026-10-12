import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Scoped CodeMirror message-editor helpers (E2E only).
 *
 * Agreed production DOM contract (CodeMirror upgrade):
 * - `.message-editor-area` (inline root), `.message-editor-save-btn`,
 *   `.message-editor-resend-btn` (user only),
 *   `[data-interaction-region='message-controls']` remain.
 * - `.editing-message` is the visible wrapper containing the real
 *   `.cm-content[contenteditable=true]` in source mode (not a textarea).
 *
 * Rules honored here:
 * - Real CodeMirror interactions only via Playwright click/key/insertText.
 * - Never writes engine state through internal globals or native
 *   HTMLTextArea setters.
 * - `.cm-content` is used for editable text; no `toHaveValue` assertions.
 * - No assumptions that virtualization renders the full doc: exact full-doc
 *   assertions belong to Redux/SQLite, never to `.cm-content` text.
 * - No hard-coded platform promises: selection uses `ControlOrMeta+A`.
 */

export function editorWrapper(editorArea: Locator): Locator {
  return editorArea.locator('.editing-message')
}

export function cmContent(editorArea: Locator): Locator {
  return editorArea.locator('.editing-message .cm-content[contenteditable="true"]')
}

/**
 * Single mode toggle (fixed contract): exactly ONE
 * `[data-testid="message-editor-mode-btn"]` with
 * `data-mode="source"|"preview"` and `aria-pressed` true exactly in
 * preview; clicking toggles. The legacy dual
 * `message-editor-source-btn` / `message-editor-preview-btn` are gone.
 */
export function modeToggle(scope: Page | Locator): Locator {
  return scope.locator('[data-testid="message-editor-mode-btn"]')
}

/** Inline top-edge resize handle (role=separator, horizontal, pointer capture). */
export function resizeHandle(editorArea: Locator): Locator {
  return editorArea.locator('[data-testid="message-editor-resize-handle"]')
}

/** Height surface whose inline height is user-resizable and persisted. */
export function resizeSurface(editorArea: Locator): Locator {
  return editorArea.locator('[data-testid="message-editor-resize-surface"]')
}

/**
 * Outermost bordered editor frame for the OUTER-grip contract.
 *
 * Production moves the grip to the OUTER editor container top border
 * (absolutely positioned, no inner layout row) and MAY add
 * `[data-testid="message-editor-container"]`. Coordinate from the stable
 * current surface when that testid is absent: `.message-editor` (outer
 * container) falling back to the area root. The comma locator returns all
 * matches in DOM order; `.first()` is the outermost when the container
 * wraps `.message-editor`, and the same element when production tags the
 * existing container in place.
 */
export function outerEditorFrame(editorArea: Locator): Locator {
  return editorArea.locator('[data-testid="message-editor-container"], .message-editor').first()
}

/** Real CodeMirror scroll plane (strict source-scroll target, never a wrapper). */
export function cmScroller(scope: Page | Locator): Locator {
  return scope.locator('.editing-message .cm-scroller').first()
}

/** Rendered preview text (wheel target; its scrollable ancestor is the preview plane). */
export function previewMarkdown(scope: Page | Locator): Locator {
  return scope.locator('p.markdown, div.markdown').first()
}

/** Proves the real CodeMirror mount: visible wrapper + editable cm-content. */
export async function expectCodeMirrorMounted(editorArea: Locator): Promise<void> {
  await expect(editorArea, 'editor area must render').toBeVisible({ timeout: 10000 })
  await expect(editorWrapper(editorArea), 'editing wrapper must render').toBeVisible({ timeout: 10000 })
  await expect(cmContent(editorArea), 'CodeMirror editable content must mount').toBeVisible({ timeout: 10000 })
}

/**
 * Replaces the editor draft through real user input: focuses the CodeMirror
 * surface, selects all with the platform modifier, then inserts the new text
 * so the production onChange path runs.
 */
export async function replaceEditorContent(page: Page, editorArea: Locator, text: string): Promise<void> {
  const cm = cmContent(editorArea)
  await expect(cm, 'CodeMirror editable content must mount before replace').toBeVisible({ timeout: 10000 })
  await cm.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(text)
}

/** Appends text through the real CodeMirror onChange path (proves live input). */
export async function appendEditorText(page: Page, editorArea: Locator, text: string): Promise<void> {
  const cm = cmContent(editorArea)
  await expect(cm, 'CodeMirror editable content must mount before append').toBeVisible({ timeout: 10000 })
  await cm.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(text)
}

/** Best-effort visible editor text (virtualization-unsafe: substring use only). */
export async function readVisibleEditorText(editorArea: Locator): Promise<string> {
  const cm = cmContent(editorArea)
  try {
    const text = await cm.innerText({ timeout: 5000 })
    return text ?? ''
  } catch {
    return ''
  }
}

/**
 * Hit-test probe for the resize-handle center: elementFromPoint must resolve
 * to the handle. Returns the hit flag plus a diagnostic describe string for
 * failure messages; never throws (unreadable DOM reports hit=false).
 */
export async function probeResizeHandleHit(
  page: Page,
  cx: number,
  cy: number
): Promise<{ hit: boolean; describe: string }> {
  return page
    .evaluate(
      ({ x, y }: { x: number; y: number }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        if (!el) return { hit: false, describe: 'null' }
        const handle = el.closest('[data-testid="message-editor-resize-handle"]')
        const tid = el.getAttribute('data-testid') ?? ''
        const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : String(el.tagName)
        const describe = `${el.tagName.toLowerCase()}#${el.id || '-'}.${cls} testid=${tid || '-'} text=${(el.textContent || '').slice(0, 40)}`
        return { hit: handle !== null, describe }
      },
      { x: cx, y: cy }
    )
    .catch(() => ({ hit: false, describe: 'unreadable' }))
}

/**
 * Finds a genuine outer-viewport wheel point: visible margin inside #messages
 * but outside any inner scroll plane. Read-only DOM hit-test only — derives
 * candidates from the live #messages rect and the outer editor-frame bounds
 * (left/right gutters), never a fixed coordinate. Ownership asserted before
 * any wheel: elementFromPoint must resolve to a #messages descendant whose
 * nearest user scroll ancestor is #messages itself (not
 * .cm-scroller/.cm-content/.cm-editor/textarea/preview/modal). Throws
 * (reports, never forces) when no accessible outer margin exists.
 */
export async function findOuterChatGutterWheelPoint(
  page: Page
): Promise<{ x: number; y: number; describe: string; owner: string }> {
  const found = await page
    .evaluate(() => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return { ok: false as const, reason: 'no-#messages' }
      const c = container.getBoundingClientRect()
      const frame =
        (document.querySelector(
          '[data-message-id] .message-editor-area [data-testid="message-editor-container"], [data-message-id] .message-editor-area .message-editor'
        ) as HTMLElement | null) ??
        (document.querySelector('[data-message-id] .message-editor-area') as HTMLElement | null)
      const f = frame ? frame.getBoundingClientRect() : null
      const isUserScrollable = (e: HTMLElement): boolean => {
        if (e.clientHeight <= 0 || e.clientWidth <= 0) return false
        if (e.scrollHeight <= e.clientHeight + 40) return false
        const cs = getComputedStyle(e)
        if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') return false
        return true
      }
      const nearestScrollAncestor = (el: HTMLElement | null): string => {
        let node: HTMLElement | null = el
        while (node && node !== document.documentElement) {
          if (node !== el && isUserScrollable(node)) return node.id ? `#${node.id}` : node.tagName.toLowerCase()
          node = node.parentElement
        }
        return 'none'
      }
      const describeEl = (el: HTMLElement | null): string => {
        if (!el) return 'null'
        const tid = el.getAttribute('data-testid') ?? '-'
        const cls = typeof el.className === 'string' ? el.className.slice(0, 50) : String(el.tagName)
        return `${el.tagName.toLowerCase()}#${el.id || '-'}.${cls} testid=${tid}`
      }
      // Gutter candidates: near left/right margins inside #messages,
      // sampled at container top/mid/bottom and around the editor frame
      // top/bottom edges (outside the bordered frame, inside the column).
      const xs = [c.left + 14, c.left + 24, c.right - 14, c.right - 24]
      const ys = [
        c.top + 100,
        c.top + 165,
        c.top + c.height / 2,
        c.top + c.height - 140,
        ...(f ? [f.top - 24, f.top + 8, f.bottom + 24] : [])
      ]
      for (const y of ys) {
        for (const x of xs) {
          if (!(x >= c.left && x <= c.right && y >= c.top && y <= c.bottom)) continue
          if (f && x >= f.left && x <= f.right && y >= f.top && y <= f.bottom) continue
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          if (!el) continue
          if (el.closest('#messages') === null) continue
          if (el.closest('.cm-scroller, .cm-content, .cm-editor, textarea, p.markdown, div.markdown') !== null) continue
          if (el.closest('[data-testid="message-editor-expanded"]') !== null) continue
          const owner = nearestScrollAncestor(el)
          if (owner !== '#messages') continue
          return { ok: true as const, x, y, describe: describeEl(el), owner }
        }
      }
      return { ok: false as const, reason: 'no-accessible-outer-margin' }
    })
    .catch(() => ({ ok: false as const, reason: 'unreadable' }))
  if (!found || (found as { ok: boolean }).ok !== true) {
    const reason =
      found && 'reason' in (found as Record<string, unknown>)
        ? String((found as { reason: unknown }).reason)
        : 'unknown'
    throw new Error(`no accessible outer #messages margin for genuine wheel (reason=${reason}); not forcing`)
  }
  const pt = found as { x: number; y: number; describe: string; owner: string }
  return { x: pt.x, y: pt.y, describe: pt.describe, owner: pt.owner }
}
