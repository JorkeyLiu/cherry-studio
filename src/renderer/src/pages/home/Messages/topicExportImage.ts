import { loggerService } from '@logger'
import { readAppliedThemeMode } from '@renderer/context/antdThemeConfig'
import store from '@renderer/store'
import type { ThemeMode, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { captureScrollable } from '@renderer/utils'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { loadWholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import TopicExportImageCanvas, { type ExportImageScope } from './TopicExportImageCanvas'

const logger = loggerService.withContext('TopicExportImage')

/** Canvas width used when the live message column width cannot be measured. */
export const TOPIC_EXPORT_CANVAS_WIDTH_FALLBACK = 800

/** Attributes marking the transient export host so it is always identifiable. */
const EXPORT_HOST_ATTRIBUTE = 'data-topic-export-host'

const RENDER_READY_TIMEOUT_MS = 5000
const RESOURCE_TIMEOUT_MS = 3000
const FONT_READY_TIMEOUT_MS = 1500
const DOM_SETTLE_QUIET_MS = 120

export type TopicExportImageOutcome =
  /** Complete export content rendered and captured as a PNG data URL. */
  | { status: 'captured'; dataUrl: string; width: number; height: number }
  /** The addressed route exists but holds no messages, so there is nothing to export. */
  | { status: 'empty' }
  /** Another image export is already running. */
  | { status: 'busy' }
  /** The capture exceeded the maximum canvas dimension (rejected by the capture helper). */
  | { status: 'too-large' }
  | { status: 'failed'; error: unknown }

/** One addressed message produces the very same outcome shape as a topic route. */
export type MessageExportImageOutcome = TopicExportImageOutcome

let exportInFlight = false

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Selector for the capture target: the laid-out canvas inside the export host. */
const EXPORT_CONTENT_SELECTOR = '[data-topic-export-content]'

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const createExportHost = (width: number): HTMLElement => {
  const host = document.createElement('div')
  host.setAttribute(EXPORT_HOST_ATTRIBUTE, 'true')
  host.setAttribute('aria-hidden', 'true')
  // Kept out of the visible viewport and out of flow interactions: the host is
  // a fixed offscreen container, so the capture helper's own style mutations
  // (height/overflow/position on the inner target) can never reflow or flash
  // the app while a long topic is being rendered.
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    left: '-100000px',
    width: `${width}px`,
    zIndex: '-1',
    pointerEvents: 'none',
    background: 'transparent'
  })
  return host
}

/** Waits until React has committed the canvas subtree into the host. */
const waitForCommittedChildren = async (host: HTMLElement): Promise<boolean> => {
  const deadline = Date.now() + RENDER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (host.childElementCount > 0) return true
    await delay(16)
  }
  return host.childElementCount > 0
}

/**
 * Waits for the images inside the export canvas (attachments, generated images,
 * mermaid/math renders) to finish decoding so no placeholder is captured.
 */
const waitForImages = async (host: HTMLElement): Promise<void> => {
  const images = Array.from(host.querySelectorAll('img'))
  if (images.length === 0) return

  await Promise.all(
    images.map(async (image) => {
      image.loading = 'eager'
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            image.removeEventListener('load', finish)
            image.removeEventListener('error', finish)
            resolve()
          }
          image.addEventListener('load', finish)
          image.addEventListener('error', finish)
          void delay(RESOURCE_TIMEOUT_MS).then(finish)
        })
      }
      try {
        if (typeof image.decode === 'function') {
          await image.decode()
        }
      } catch {
        // Undecodable/blocked images must not block the export; the capture
        // continues with whatever the browser rendered for them.
      }
    })
  )
}

/**
 * Waits for the document font set so text is captured with the loaded faces
 * instead of a fallback font. Engines without a font set (and slow loads)
 * resolve immediately/bounded.
 */
const waitForFonts = async (): Promise<void> => {
  const fontSet = (document as Document & { fonts?: FontFaceSet }).fonts
  if (!fontSet || typeof fontSet.ready?.then !== 'function') return
  try {
    await fontSet.ready
  } catch {
    // A rejected font-ready promise must not fail the export.
  }
}

/**
 * Resolves once the canvas DOM has stopped mutating for a quiet window (async
 * block rendering such as syntax highlighting settles) or the timeout expires.
 */
const waitForDomSettled = async (host: HTMLElement): Promise<void> => {
  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(deadlineTimer)
      observer.disconnect()
      resolve()
    }

    const schedule = () => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, DOM_SETTLE_QUIET_MS)
    }

    const observer = new MutationObserver(schedule)
    observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true })
    // Declared after `finish`/`observer` so the hoisted `finish` closure never
    // reads an uninitialized binding; the timer can only fire asynchronously.
    const deadlineTimer = setTimeout(finish, RESOURCE_TIMEOUT_MS)
    schedule()
  })
}

const teardown = (root: Root | null, host: HTMLElement | null): void => {
  try {
    root?.unmount()
  } catch (error) {
    logger.warn('Failed to unmount topic export canvas', error as Error)
  }
  try {
    host?.remove()
  } catch (error) {
    logger.warn('Failed to remove topic export host', error as Error)
  }
}

/**
 * Reads the export thinking option exactly once per capture, before the first
 * await: the value is frozen for this export, so a settings change during the
 * asynchronous render cannot alter what the image shows.
 */
const readExportIncludeThinking = (): boolean => store.getState().settings.exportIncludeThinking === true

const resolveCanvasWidth = (width?: number): number =>
  Math.max(1, Math.round(width && width > 0 ? width : TOPIC_EXPORT_CANVAS_WIDTH_FALLBACK))

/**
 * Resolves the topic a message belongs to.
 *
 * Topics live under their assistant; the export only needs the topic's identity
 * (id/assistantId/name) for the message body, and never a live route read.
 */
const findTopicById = (topicId: string): Topic | undefined => {
  const { assistants } = store.getState()
  for (const assistant of assistants.assistants) {
    const topic = assistant.topics?.find((candidate) => candidate.id === topicId)
    if (topic) return topic
  }
  return undefined
}

interface ExportRenderRequest {
  topic: Topic
  messages: Message[]
  blocksById: SnapshotBlockMap
  width: number
  /** Frozen export thinking expansion (`true` = expanded, `false` = collapsed). */
  exportIncludeThinking: boolean
  scope: ExportImageScope
}

/**
 * Renders one export tree into a detached offscreen root and captures it.
 *
 * This is the single snapshot render/capture path shared by the topic export and
 * the single-message export: one waiting strategy (commit, fonts, images, DOM
 * quiet), one capture call, one teardown in `finally`, and one theme scope.
 */
const renderAndCapture = async ({
  topic,
  messages,
  blocksById,
  width,
  exportIncludeThinking,
  scope
}: ExportRenderRequest): Promise<TopicExportImageOutcome> => {
  // The effective theme the page is rendering, read once at export start. React
  // context does not cross into the detached export root, so the theme has to
  // be carried across explicitly; reading what the live ThemeProvider already
  // applied keeps the export on the same theme without a second resolver.
  const themeMode: ThemeMode = readAppliedThemeMode()

  let host: HTMLElement | null = null
  let root: Root | null = null

  try {
    host = createExportHost(width)
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      createElement(TopicExportImageCanvas, {
        topic,
        messages,
        blocksById,
        width,
        themeMode,
        exportIncludeThinking,
        scope
      })
    )

    const committed = await waitForCommittedChildren(host)
    if (!committed) {
      return { status: 'failed', error: new Error('Export canvas did not render') }
    }

    // Capture the laid-out canvas, never the host: the capture helper rewrites
    // the target's position/height/overflow, and on the host those writes would
    // pull the transient tree back into the document flow and reflow the app.
    const target = host.querySelector<HTMLElement>(EXPORT_CONTENT_SELECTOR)
    if (!target) {
      return { status: 'failed', error: new Error('Export canvas content missing') }
    }

    await withTimeout(
      Promise.all([waitForFonts(), waitForImages(target)]).then(() => undefined),
      RESOURCE_TIMEOUT_MS + FONT_READY_TIMEOUT_MS
    )
    await nextFrame()
    await nextFrame()
    await waitForDomSettled(target)

    const canvas = await captureScrollable({ current: target })
    if (!canvas) {
      return { status: 'failed', error: new Error('Export capture produced no canvas') }
    }

    return {
      status: 'captured',
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height
    }
  } finally {
    // Every transient resource — host node, React root, and any style the
    // capture helper applies — is released on success, on failure and on
    // timeout alike.
    teardown(root, host)
  }
}

/**
 * Maps a thrown capture error onto the export outcome.
 *
 * The capture helper rejects without a reason for the explicit maximum-dimension
 * rejection and has already surfaced that to the user.
 */
const failureFor = (error: unknown, message: string): TopicExportImageOutcome => {
  if (error === undefined) return { status: 'too-large' }
  logger.error(message, error as Error)
  return { status: 'failed', error }
}

/**
 * Captures one complete topic route as a PNG data URL.
 *
 * The content source is Main's one-shot `whole-topic` snapshot for the
 * explicitly addressed route, the rendering is caller-local (a detached
 * offscreen React root), and the live message projection, viewport window,
 * scroll position and pagination are never read for content nor mutated.
 * `branchId` is a caller-supplied value, not a live selector read: the route is
 * frozen when the export starts, so a later route switch cannot change what an
 * in-flight export renders. `null`/`undefined` is the main route.
 *
 * The thinking-expansion option is read once at export start and stays frozen
 * for this capture. Every transient resource is released in `finally`, on
 * success, on failure and on timeout alike.
 */
export const captureTopicExportImage = async (options: {
  topic: Topic
  /** Route to export: a branch id, or `null`/`undefined` for the main route. */
  branchId?: string | null
  /** Live message column width in CSS pixels, so typography matches the chat. */
  width?: number
}): Promise<TopicExportImageOutcome> => {
  if (exportInFlight) return { status: 'busy' }
  exportInFlight = true

  const { topic } = options

  try {
    const exportIncludeThinking = readExportIncludeThinking()
    const width = resolveCanvasWidth(options.width)

    // Caller-local whole-topic read: complete ordered messages + blocks for the
    // addressed topic route, independent of the loaded Redux projection.
    // The route is the value captured at export start (`null` = main route).
    const snapshot = await loadWholeTopicSnapshot(topic.id, options.branchId ?? null)
    if (snapshot.messages.length === 0) {
      return { status: 'empty' }
    }

    return await renderAndCapture({
      topic,
      messages: snapshot.messages,
      blocksById: snapshot.blocksById,
      width,
      exportIncludeThinking,
      scope: 'route'
    })
  } catch (error) {
    return failureFor(error, 'Failed to capture topic export image')
  } finally {
    exportInFlight = false
  }
}

/**
 * Captures one addressed message as a PNG data URL.
 *
 * The message is resolved from its own topic route in Main's one-shot
 * `whole-topic` snapshot — by stable id, so inherited/shared-prefix messages are
 * found in the route that owns them — and exactly that message is rendered, with
 * its complete block set taken from the same snapshot. The export never falls
 * back to the live viewport's loaded rows, never substitutes the currently
 * opened topic, and fails closed when the message is not part of its route.
 *
 * The outcome shape is identical to {@link captureTopicExportImage}, including
 * the shared in-flight guard and the frozen thinking-expansion option.
 */
export const captureMessageExportImage = async (options: {
  message: Message
  /** Live message column width in CSS pixels, so typography matches the chat. */
  width?: number
}): Promise<MessageExportImageOutcome> => {
  if (exportInFlight) return { status: 'busy' }
  exportInFlight = true

  const { message } = options

  try {
    const exportIncludeThinking = readExportIncludeThinking()
    const width = resolveCanvasWidth(options.width)

    const topic = findTopicById(message.topicId)
    if (!topic) {
      return { status: 'failed', error: new Error(`Topic ${message.topicId} of message ${message.id} is not loaded`) }
    }

    // The message carries its own owner route (inherited messages keep their
    // owner's branch id and are immutable through descendant routes), so the
    // owner route is exactly the route holding this stable message id.
    const snapshot = await loadWholeTopicSnapshot(message.topicId, message.branchId ?? null)
    const target = snapshot.messages.find((candidate) => candidate.id === message.id)
    if (!target) {
      return {
        status: 'failed',
        error: new Error(`Message ${message.id} is not part of topic ${message.topicId}'s route`)
      }
    }

    return await renderAndCapture({
      topic,
      messages: [target],
      blocksById: snapshot.blocksById,
      width,
      exportIncludeThinking,
      scope: 'single'
    })
  } catch (error) {
    return failureFor(error, 'Failed to capture message export image')
  } finally {
    exportInFlight = false
  }
}

/** Test-only reset of the module-level in-flight guard. */
export const resetTopicExportImageStateForTests = (): void => {
  exportInFlight = false
}
