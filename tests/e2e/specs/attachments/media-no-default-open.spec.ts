import * as fs from 'fs'
import * as path from 'path'
import { expect, findProductRequestAfter, getRequestSequence, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

/**
 * No default-app open for media attachments (real draft + sent UI guard).
 *
 * After the bounded UI change, pre-send (`AttachmentPreview`) and sent
 * (`MessageAttachments`) audio/video cards render only the in-app HTML5
 * player — the explicit `media-open-default` button no longer exists in
 * either flow. The narrow `openMediaAttachment` IPC and its reject-only
 * safety contract are unchanged and covered by
 * `media-open-restricted.spec.ts` (kept intact).
 *
 * This spec drives the REAL production upload/send path without launching
 * any system app:
 * - synthetic `.mp3`/`.mp4` fixtures are created under the fixture-owned
 *   `ownedTmpRoot` (fake payload bytes only — Main classifies by extension
 *   and never decodes audio/video, so no real codec data is needed)
 * - the Electron file dialog (`dialog.showOpenDialog`) is stubbed from the
 *   Main side via `electronApp.evaluate` to return exactly the owned
 *   fixtures for each cycle — the renderer keeps the full production path
 *   untouched (`AttachmentButton` -> `window.api.file.select` -> IPC ->
 *   Main `selectFile`), so no native dialog can ever open and no real user
 *   data is touched. A renderer-side override of `window.api.file.select`
 *   is deliberately NOT used: the contextBridge surface silently ignores
 *   the assignment and the real native dialog opens instead.
 * - the real paperclip toolbar button is clicked per cycle, so the
 *   pre-send draft cards are genuinely rendered by `AttachmentPreview`
 * - the real textarea + Enter path sends each message (production
 *   `FileManager.uploadFiles` -> `_sendMessage` thunk against the mock
 *   provider), so the sent cards are genuinely rendered by
 *   `MessageAttachments`
 * - `shell.openPath` is wrapped with a Main-side call counter (original
 *   preserved, stickiness verified) and asserted at zero calls for the whole
 *   spec — it is the single funnel for every default-app launch (both the
 *   `openMediaAttachment` allow branch and the generic `openPath` IPC), so
 *   zero calls means no system app could have opened. Renderer-side wrapping
 *   of `window.api.file` is deliberately NOT used for counting either: the
 *   contextBridge surface silently ignores the assignment.
 *
 * Product semantics honored (see `fileProcessor.ts`): MP3 + OGG audio encode
 * on the mock openai-compatible endpoint as `input_audio` (patched formats
 * `wav`/`mp3`/`ogg`/`flac`/`aac`, upstream adjudicates), so each audio cycle
 * asserts the full mock-server product request; MP4 + WebM video encode on
 * the generic openai-compatible endpoint as `video_url` (upstream
 * adjudicates), so each video cycle asserts a real product request carrying
 * the video part plus terminal success. All four cycles assert positive draft
 * AND sent players with native `controls`, while `media-open-default`
 * exists nowhere.
 */
test.describe('Media attachments offer no default-app open', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('draft and sent audio/video render in-app players with no default-open and no open IPC', async ({
    mainWindow,
    electronApp,
    ownedTmpRoot
  }) => {
    test.setTimeout(300_000)

    // Synthetic media fixtures owned by this test only. Fake payload bytes:
    // Main classifies by extension + regular file, never decodes.
    const dir = path.join(ownedTmpRoot, 'media-no-default-open')
    fs.mkdirSync(dir, { recursive: true })
    const mp3Path = path.join(dir, 'draft-song.mp3')
    const oggPath = path.join(dir, 'draft-note.ogg')
    const mp4Path = path.join(dir, 'draft-clip.mp4')
    const webmPath = path.join(dir, 'draft-clip.webm')
    fs.writeFileSync(mp3Path, 'ID3-fake-no-default-open-audio-probe')
    fs.writeFileSync(oggPath, 'OggS-fake-no-default-open-ogg-probe')
    fs.writeFileSync(mp4Path, 'ftyp-fake-no-default-open-video-probe')
    fs.writeFileSync(webmPath, 'EBML-fake-no-default-open-webm-probe')

    await test.step('install Main-side open tripwire without invoking the allow branch', async () => {
      // Renderer-side wrapping of window.api.file is deliberately NOT used:
      // the contextBridge surface silently ignores the assignment (verified:
      // a stickiness check returns zero installed wraps), which would make
      // any renderer-side zero-counter vacuous. The authoritative tripwire
      // lives in Main instead: every default-app launch in this app funnels
      // through shell.openPath (both the openMediaAttachment allow branch
      // and the generic openPath IPC).
      const installed = await electronApp.evaluate(({ shell }: typeof import('electron')) => {
        const s = shell as any
        if (!s.__e2eNoDefaultOpenOriginal) {
          s.__e2eNoDefaultOpenOriginal = s.openPath.bind(s)
        }
        s.__e2eNoDefaultOpenCalls = 0
        const wrapped = async (...args: any[]) => {
          s.__e2eNoDefaultOpenCalls += 1
          return s.__e2eNoDefaultOpenOriginal(...args)
        }
        try {
          s.openPath = wrapped
        } catch {
          // Stickiness is verified below instead of assumed.
        }
        return {
          stuck: (s.openPath as unknown) === wrapped,
          calls: (s.__e2eNoDefaultOpenCalls ?? -1) as number
        }
      })
      expect(installed.stuck).toBe(true)
      expect(installed.calls).toBe(0)
    })

    await test.step('home renders with no default-open button or promise', async () => {
      const state = await mainWindow.evaluate(() => ({
        defaultOpenCount: document.querySelectorAll('[data-testid="media-open-default"]').length,
        bodyText: document.body?.textContent ?? ''
      }))
      expect(state.defaultOpenCount).toBe(0)
      expect(state.bodyText).not.toContain('open_with_default_app')
      expect(state.bodyText).not.toContain('Open with default app')
      expect(state.bodyText).not.toContain('使用默认应用打开')
      expect(state.bodyText).not.toContain('使用預設應用程式開啟')
    })

    await test.step('install Electron dialog stub with a per-cycle file list', async () => {
      await electronApp.evaluate(
        (
          { dialog }: typeof import('electron'),
          {
            mp3FilePath,
            oggFilePath,
            mp4FilePath,
            webmFilePath
          }: { mp3FilePath: string; oggFilePath: string; mp4FilePath: string; webmFilePath: string }
        ) => {
          const d = dialog as any
          if (!d.__e2eMediaStubOriginal) {
            d.__e2eMediaStubOriginal = d.showOpenDialog.bind(d)
          }
          d.__e2eMediaKnownFiles = {
            'audio-mp3': mp3FilePath,
            'audio-ogg': oggFilePath,
            'video-mp4': mp4FilePath,
            'video-webm': webmFilePath
          }
          d.__e2eMediaDialogFiles = [mp3FilePath, oggFilePath, mp4FilePath, webmFilePath]
          d.__e2eMediaDialogCalls = 0
          // Test-only dialog replacement: each showOpenDialog call resolves
          // with the current per-cycle owned-fixture list. The full
          // production chain (AttachmentButton -> preload select -> IPC ->
          // Main selectFile -> setFiles) runs unmodified; no native dialog
          // can open and no real user data is touched.
          d.showOpenDialog = async () => {
            d.__e2eMediaDialogCalls += 1
            return { canceled: false, filePaths: [...(d.__e2eMediaDialogFiles ?? [])] }
          }
        },
        { mp3FilePath: mp3Path, oggFilePath: oggPath, mp4FilePath: mp4Path, webmFilePath: webmPath }
      )
    })

    const cycles = [
      {
        name: 'audio-mp3',
        kind: 'audio',
        fileName: 'draft-song.mp3',
        playerTestId: 'media-audio',
        srcPattern: /\.mp3$/,
        text: 'media no-default-open probe audio mp3',
        // MP3 encodes on the mock openai-compatible endpoint: the product
        // request must be observed.
        expectRequest: true,
        // Cumulative sent counts expected after this cycle.
        expectSentAudio: 1,
        expectSentVideo: 0
      },
      {
        name: 'audio-ogg',
        kind: 'audio',
        fileName: 'draft-note.ogg',
        playerTestId: 'media-audio',
        srcPattern: /\.ogg$/,
        text: 'media no-default-open probe audio ogg',
        // OGG encodes on the mock openai-compatible endpoint as input_audio
        // format ogg (patched SDK, upstream adjudicates): the product
        // request carrying the audio part must be observed.
        expectRequest: true,
        expectSentAudio: 2,
        expectSentVideo: 0
      },
      {
        name: 'video-mp4',
        kind: 'video',
        fileName: 'draft-clip.mp4',
        playerTestId: 'media-video',
        srcPattern: /\.mp4$/,
        text: 'media no-default-open probe video mp4',
        // MP4 video encodes on the mock openai-compatible endpoint as
        // video_url (upstream adjudicates): the product request carrying the
        // video part must be observed, ending in terminal success.
        expectRequest: true,
        expectSentAudio: 2,
        expectSentVideo: 1
      },
      {
        name: 'video-webm',
        kind: 'video',
        fileName: 'draft-clip.webm',
        playerTestId: 'media-video',
        srcPattern: /\.webm$/,
        text: 'media no-default-open probe video webm',
        // WebM video classifies as VIDEO via videoExts and encodes as
        // video_url video/webm: the product request carrying the part must
        // be observed, ending in terminal success.
        expectRequest: true,
        expectSentAudio: 2,
        expectSentVideo: 2
      }
    ]

    for (const [cycleIndex, cycle] of cycles.entries()) {
      await test.step(`select per-cycle dialog files (${cycle.name})`, async () => {
        await electronApp.evaluate(({ dialog }: typeof import('electron'), key: string) => {
          const d = dialog as any
          const known = d.__e2eMediaKnownFiles as Record<string, string>
          d.__e2eMediaDialogFiles = [known[key]]
        }, cycle.name)
      })

      await test.step(`click real attach button (${cycle.name})`, async () => {
        const attachButton = mainWindow.locator('button:has(svg.lucide-paperclip), button:has(svg[class*="paperclip"])')
        await attachButton.first().waitFor({ state: 'visible', timeout: 15000 })
        await attachButton.first().click()
        console.log(`[E2E] Clicked production attachment button for ${cycle.name}`)
      })

      await test.step(`pre-send draft renders in-app ${cycle.name} player, no default open`, async () => {
        const drafts = mainWindow.locator('[data-testid="draft-media-item"]')
        await expect(drafts).toHaveCount(1, { timeout: 15000 })

        const player = mainWindow.locator(`[data-testid="draft-media-item"] [data-testid="${cycle.playerTestId}"]`)
        await expect(player).toBeVisible({ timeout: 15000 })
        await expect(player).toHaveAttribute('controls', '')
        await expect(player).toHaveAttribute('preload', 'metadata')
        expect(await player.getAttribute('autoplay')).toBeNull()
        const src = await player.getAttribute('src')
        expect(src).not.toBeNull()
        expect(src!).toMatch(/^file:\/\//)
        expect(src!).toContain(cycle.fileName)

        await expect(mainWindow.locator('[data-testid="draft-media-item"]', { hasText: cycle.fileName })).toHaveCount(
          1,
          { timeout: 5000 }
        )

        expect(
          await mainWindow.evaluate(() => document.querySelectorAll('[data-testid="media-open-default"]').length)
        ).toBe(0)
        const bodyText = await mainWindow.evaluate(() => document.body?.textContent ?? '')
        expect(bodyText).not.toContain('open_with_default_app')
        expect(bodyText).not.toContain('Open with default app')
        expect(bodyText).not.toContain('使用默认应用打开')
        expect(bodyText).not.toContain('使用預設應用程式開啟')
        console.log(`[E2E] Draft stage (${cycle.name}): 1 draft card with ${cycle.playerTestId} controls`)
      })

      await test.step(`dialog stub served the ${cycle.name} attach`, async () => {
        const dialogCalls = await electronApp.evaluate(({ dialog }: typeof import('electron')) => {
          return ((dialog as any).__e2eMediaDialogCalls ?? 0) as number
        })
        // Cumulative: proves each click went through the real button ->
        // dialog -> Main selectFile chain (not a fabricated draft).
        expect(dialogCalls).toBeGreaterThanOrEqual(cycleIndex + 1)
      })

      const seq = getRequestSequence()
      const beforeTopic = await test.step(`capture active topic before ${cycle.name} send`, async () => {
        return mainWindow.evaluate(() => {
          const s = (window as any).store?.getState?.()
          const assistant = s?.assistants?.assistants?.[0]
          const topicId = assistant?.topics?.[0]?.id ?? ''
          const ids = (topicId ? (s?.messages?.messageIdsByTopic?.[topicId] ?? []) : []) as string[]
          let assistantCount = 0
          for (const id of ids) {
            if (s?.messages?.entities?.[id]?.role === 'assistant') assistantCount += 1
          }
          return { topicId, assistantCount }
        })
      })

      await test.step(`send ${cycle.name} via the real textarea + Enter path`, async () => {
        const textarea = mainWindow.locator('.inputbar textarea, textarea[placeholder]').first()
        await textarea.waitFor({ state: 'visible', timeout: 15000 })
        await textarea.click()
        await mainWindow.evaluate(
          ({ text }: { text: string }) => {
            const el = document.querySelector('.inputbar textarea, textarea[placeholder]') as HTMLTextAreaElement | null
            if (!el) throw new Error('[E2E] Chat textarea not found')
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
            if (!nativeSetter) throw new Error('[E2E] No native textarea setter')
            nativeSetter.call(el, text)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          },
          { text: cycle.text }
        )
        await expect(textarea).toHaveValue(cycle.text, { timeout: 5000 })
        await textarea.press('Enter')
        console.log(`[E2E] Sent ${cycle.name} message via production send path`)
      })

      const topicId = await test.step(`resolve topic after ${cycle.name} send`, async () => {
        // The draft must clear (production setFiles([]) after dispatch starts).
        await expect(mainWindow.locator('[data-testid="draft-media-item"]')).toHaveCount(0, { timeout: 30000 })

        let resolvedTopicId = beforeTopic.topicId
        if (!resolvedTopicId) {
          await mainWindow.waitForFunction(
            () => {
              const s = (window as any).store?.getState?.()
              return Boolean(s?.assistants?.assistants?.[0]?.topics?.[0]?.id)
            },
            undefined,
            { timeout: 15000 }
          )
          resolvedTopicId = await mainWindow.evaluate(
            () => (window as any).store.getState().assistants.assistants[0].topics[0].id as string
          )
        }
        expect(resolvedTopicId).not.toBe('')

        if (cycle.expectRequest) {
          // Poll the mock-server log: the AI SDK must have issued the
          // product request for this send (request-path evidence,
          // independent of the UI).
          const deadline = Date.now() + 60000
          let productReq: ReturnType<typeof findProductRequestAfter> = null
          while (!productReq && Date.now() < deadline) {
            productReq = findProductRequestAfter(seq)
            if (!productReq) await mainWindow.waitForTimeout(500)
          }
          expect(productReq).not.toBeNull()
          expect(productReq!.parsed).toEqual(expect.objectContaining({ model: 'mock-model', stream: true }))
          // Bind to the CURRENT turn: the body carries cumulative chat
          // history, so flattening every message would match history (OGG
          // round read the historical MP3 via audioParts[0]; WebM risks the
          // historical MP4 the same way). Only the LAST user message proves
          // this round's wire encoding.
          const body = productReq!.parsed as unknown as {
            messages: Array<{ role?: unknown; content: unknown }>
          }
          const userMsgs = (body.messages ?? []).filter((m) => m?.role === 'user')
          expect(userMsgs.length).toBeGreaterThanOrEqual(1)
          const currentContent = userMsgs[userMsgs.length - 1]!.content
          const currentTexts =
            typeof currentContent === 'string'
              ? [currentContent]
              : Array.isArray(currentContent)
                ? (currentContent as Array<Record<string, unknown>>)
                    .filter((p) => p?.type === 'text')
                    .map((p) => String((p as { text?: unknown }).text ?? ''))
                : []
          expect(currentTexts.join('\n')).toContain(cycle.text)
          const currentParts = Array.isArray(currentContent) ? (currentContent as Array<Record<string, unknown>>) : []
          if (cycle.kind === 'audio') {
            // Wire-level proof: the audio turn sent a real input_audio part
            // (not a local-only error path). MP3 uses format mp3, OGG uses
            // the patched format ogg. Scoped to the current turn only, and
            // exactly one part (uniqueness per round).
            const audioParts = currentParts.filter((p) => p?.type === 'input_audio')
            expect(audioParts.length).toBe(1)
            const expectedFormat = cycle.name === 'audio-ogg' ? 'ogg' : 'mp3'
            expect((audioParts[0]!.input_audio as { format: string }).format).toBe(expectedFormat)
            expect(String((audioParts[0]!.input_audio as { data: string }).data.length)).not.toBe('0')
          }
          if (cycle.kind === 'video') {
            // Wire-level proof: the video turn sent a real video_url part
            // with a video data URL (not a local-only error path). Scoped
            // to the current turn only, exactly one part per round.
            const videoParts = currentParts.filter((p) => p?.type === 'video_url')
            expect(videoParts.length).toBe(1)
            const expectedVideoPrefix =
              cycle.name === 'video-webm' ? /^data:video\/webm;base64,/ : /^data:video\/mp4;base64,/
            const videoUrl = String((videoParts[0]!.video_url as { url: string }).url)
            expect(videoUrl).toMatch(expectedVideoPrefix)
            expect(videoUrl.split(',')[1]?.length ?? 0).toBeGreaterThan(0)
          }
          console.log(`[E2E] Production chat request observed (seq=${productReq!.sequence})`)
        }
        return resolvedTopicId
      })

      await test.step(`sent message renders in-app ${cycle.name} player, no default open`, async () => {
        const sentAudio = mainWindow.locator('.message-attachments [data-testid="media-audio"]')
        const sentVideo = mainWindow.locator('.message-attachments [data-testid="media-video"]')
        await expect(sentAudio).toHaveCount(cycle.expectSentAudio, { timeout: 60000 })
        await expect(sentVideo).toHaveCount(cycle.expectSentVideo, { timeout: 60000 })

        const player = cycle.kind === 'audio' ? sentAudio.first() : sentVideo.first()
        await expect(player).toBeVisible({ timeout: 15000 })
        await expect(player).toHaveAttribute('controls', '')
        await expect(player).toHaveAttribute('preload', 'metadata')
        expect(await player.getAttribute('autoplay')).toBeNull()
        const sentSrc = await player.getAttribute('src')
        expect(sentSrc).not.toBeNull()
        expect(sentSrc!).toMatch(/^file:\/\//)
        expect(sentSrc!).toMatch(cycle.srcPattern)

        expect(
          await mainWindow.evaluate(() => document.querySelectorAll('[data-testid="media-open-default"]').length)
        ).toBe(0)
        const bodyText = await mainWindow.evaluate(() => document.body?.textContent ?? '')
        expect(bodyText).not.toContain('open_with_default_app')
        expect(bodyText).not.toContain('Open with default app')
        expect(bodyText).not.toContain('使用默认应用打开')
        expect(bodyText).not.toContain('使用預設應用程式開啟')
        console.log(`[E2E] Sent stage (${cycle.name}): attachment with ${cycle.playerTestId} controls, no default-open`)
      })

      await test.step(`wait for the ${cycle.name} turn to settle`, async () => {
        await mainWindow.waitForFunction(
          ({ activeTopicId, prevCount }: { activeTopicId: string; prevCount: number }) => {
            const s = (window as any).store?.getState?.()
            if (!s) return false
            if (s.messages?.loadingByTopic?.[activeTopicId]) return false
            const msgIds = (s.messages?.messageIdsByTopic?.[activeTopicId] ?? []) as string[]
            let count = 0
            let latestAssistantId: string | null = null
            for (const id of msgIds) {
              if (s.messages.entities?.[id]?.role === 'assistant') {
                count += 1
                latestAssistantId = id
              }
            }
            if (count <= prevCount || !latestAssistantId) return false
            const assistantMsg = s.messages.entities[latestAssistantId]
            if (assistantMsg.status !== 'success' && assistantMsg.status !== 'error') return false
            const blocks = assistantMsg.blocks ?? []
            if (blocks.length === 0) return false
            for (const blockId of blocks) {
              const block = s.messageBlocks?.entities?.[blockId]
              if (!block || (block.status !== 'success' && block.status !== 'error')) return false
            }
            return true
          },
          { activeTopicId: topicId, prevCount: beforeTopic.assistantCount },
          { timeout: 60000 }
        )
      })

      await test.step(`the ${cycle.name} turn ends in terminal success`, async () => {
        // All four audio/video turns ride the mock openai-compatible
        // endpoint to a successful upstream reply (support is adjudicated
        // upstream, and the mock accepts the legal input_audio/video_url).
        // Binding: the new assistant instance must advance the count by
        // exactly one AND echo this round's unique probe text (each
        // cycle.text is distinct), so a stale success from an earlier round
        // cannot satisfy a later round.
        const terminal = await mainWindow.evaluate(
          ({
            activeTopicId,
            expectedText,
            prevCount
          }: {
            activeTopicId: string
            expectedText: string
            prevCount: number
          }) => {
            const s = (window as any).store?.getState?.()
            const msgIds = (s?.messages?.messageIdsByTopic?.[activeTopicId] ?? []) as string[]
            let latestAssistantId: string | null = null
            let count = 0
            for (const id of msgIds) {
              if (s?.messages?.entities?.[id]?.role === 'assistant') {
                count += 1
                latestAssistantId = id
              }
            }
            const assistantMsg = latestAssistantId ? s.messages.entities[latestAssistantId] : null
            const contents = ((assistantMsg?.blocks ?? []) as string[])
              .map((bid) => String(s.messageBlocks?.entities?.[bid]?.content ?? ''))
              .join('\n')
            return {
              latestAssistantId,
              count,
              prevCount,
              expectedText,
              status: (assistantMsg?.status ?? null) as string | null,
              contents
            }
          },
          { activeTopicId: topicId, expectedText: cycle.text, prevCount: beforeTopic.assistantCount }
        )
        expect(terminal.count).toBe(beforeTopic.assistantCount + 1)
        expect(terminal.latestAssistantId).not.toBeNull()
        expect(terminal.status).toBe('success')
        expect(terminal.contents).toContain(cycle.text)
        // Per-round tripwire read with the existing Main-side counter only
        // (no new mechanism): localizes a violation to this round instead
        // of only the end-of-spec assert.
        const roundCalls = await electronApp.evaluate(({ shell }: typeof import('electron')) => {
          return ((shell as any).__e2eNoDefaultOpenCalls ?? -1) as number
        })
        expect(roundCalls).toBe(0)
      })
    }

    await test.step('no open IPC was reached during the spec', async () => {
      // Authoritative Main-side tripwire: shell.openPath is the single
      // funnel for every default-app launch — zero calls means no system
      // app could have been opened. Restore both stubs afterwards.
      const shellCalls = await electronApp.evaluate(({ dialog, shell }: typeof import('electron')) => {
        const s = shell as any
        const calls = (s.__e2eNoDefaultOpenCalls ?? -1) as number
        if (s.__e2eNoDefaultOpenOriginal) {
          s.openPath = s.__e2eNoDefaultOpenOriginal
          delete s.__e2eNoDefaultOpenOriginal
        }
        const d = dialog as any
        if (d.__e2eMediaStubOriginal) {
          d.showOpenDialog = d.__e2eMediaStubOriginal
          delete d.__e2eMediaStubOriginal
        }
        return calls
      })
      expect(shellCalls).toBe(0)
    })
  })
})
